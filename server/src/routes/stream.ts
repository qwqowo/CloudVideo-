import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db.js';
import type { IQBittorrentClient } from '../services/qbittorrent.js';
import {
  extractSessionToken,
  signStreamToken,
  verifySessionToken,
  verifyStreamToken,
} from '../auth.js';
import {
  convertSubtitleBufferToVtt,
  extractSubtitleToCleanVtt,
  extractVideoThumbnail,
  getMimeType,
  probeMedia,
  resolveSafePath,
  sanitizeAndDeduplicateWebVtt,
} from '../services/media.js';

export const activeFfmpegProcesses = new Set<ChildProcess>();
const inflightThumbs = new Map<string, Promise<boolean>>();
const subtitleVttCache = new Map<string, string>();
function cacheVtt(key: string, vtt: string): void {
  if (subtitleVttCache.size >= 48) {
    const oldest = subtitleVttCache.keys().next().value;
    if (oldest) subtitleVttCache.delete(oldest);
  }
  subtitleVttCache.set(key, vtt);
}

export function killAllFfmpeg(): void {
  for (const proc of activeFfmpegProcesses) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
  activeFfmpegProcesses.clear();
}

function buildPublicBaseUrl(req: FastifyRequest, config: AppConfig): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(protoHeader)
    ? protoHeader[0]
    : protoHeader?.split(',')[0]?.trim() || req.protocol || 'http';
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${config.port}`;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  return `${proto}://${host}`;
}

export async function registerStreamRoutes(
  app: FastifyInstance,
  deps: {
    config: AppConfig;
    db: AppDatabase;
    qbit: IQBittorrentClient;
    requireAuth: (req: any, reply: any) => Promise<any>;
  }
): Promise<void> {
  const { config, db, qbit, requireAuth } = deps;

  async function authorizeStream(
    req: FastifyRequest,
    reply: FastifyReply,
    hash: string,
    fileIndex: number
  ): Promise<boolean> {
    const session = extractSessionToken(req);
    if (verifySessionToken(session, config.jwtSecret)) {
      return true;
    }
    const query = req.query as { token?: string };
    if (verifyStreamToken(query.token, config.jwtSecret, hash, fileIndex)) {
      return true;
    }
    reply.code(401).send({ error: 'Unauthorized', message: '播放凭证无效或已过期' });
    return false;
  }

  async function resolveFile(
    hash: string,
    fileIndex: number
  ): Promise<{ absPath: string; relativePath: string; size: number; fileName: string } | null> {
    let relativePath = '';
    try {
      const files = await qbit.getTorrentFiles(hash);
      const found = files.find((f) => f.index === fileIndex);
      if (found) relativePath = found.name;
    } catch {
      // fallback to DB if qBittorrent is unavailable
    }

    if (!relativePath) {
      const rec = db.getMediaItem(hash, fileIndex);
      if (rec?.relativePath) relativePath = rec.relativePath;
    }

    if (!relativePath) return null;

    const absPath = resolveSafePath(config.downloadDir, relativePath);
    const st = await fsp.stat(absPath).catch(() => null);
    if (!st || !st.isFile()) return null;

    return {
      absPath,
      relativePath,
      size: st.size,
      fileName: path.basename(absPath),
    };
  }

  async function getDownloadStatus(hash: string, fileIndex: number) {
    try {
      const [torrents, files] = await Promise.all([
        qbit.listTorrents(),
        qbit.getTorrentFiles(hash),
      ]);
      const t = torrents.find((item) => item.hash === hash.toLowerCase());
      const f = files.find((item) => item.index === fileIndex);
      return {
        dlSpeed: t?.dlspeed ?? 0,
        state: t?.state ?? 'unknown',
        fileProgress: f?.progress ?? 1,
        sequential: t?.seq_dl ?? false,
      };
    } catch {
      return { dlSpeed: 0, state: 'unknown', fileProgress: 1, sequential: false };
    }
  }

  app.get('/api/stream/:hash/:fileIndex/status', { preHandler: requireAuth }, async (req, reply) => {
    const { hash, fileIndex } = req.params as { hash: string; fileIndex: string };
    const idx = Number(fileIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return reply.code(400).send({ error: 'Bad Request' });
    }
    return getDownloadStatus(hash, idx);
  });

  app.get('/api/stream/:hash/:fileIndex/probe', { preHandler: requireAuth }, async (req, reply) => {
    const { hash, fileIndex } = req.params as { hash: string; fileIndex: string };
    const idx = Number(fileIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return reply.code(400).send({ error: 'Bad Request', message: '无效的文件索引' });
    }

    const target = await resolveFile(hash, idx);
    if (!target) {
      return reply.code(404).send({
        error: 'NotFound',
        message: '文件尚未在磁盘生成，请等待片刻缓冲后再试',
      });
    }

    let probe;
    try {
      probe = await probeMedia(target.absPath);
    } catch (err) {
      return reply.code(422).send({
        error: 'ProbeError',
        message: `媒体头尚未完整或无法解析（边下边播请等待前 2–5% 缓冲）：${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }

    const streamToken = signStreamToken(config.jwtSecret, hash, idx, 12 * 3600);
    const baseUrl = buildPublicBaseUrl(req, config);
    const encodedHash = encodeURIComponent(hash.toLowerCase());
    const directUrl = `${baseUrl}/api/stream/${encodedHash}/${idx}/direct?token=${encodeURIComponent(streamToken)}`;
    const remuxUrl = `${baseUrl}/api/stream/${encodedHash}/${idx}/remux?token=${encodeURIComponent(streamToken)}`;

    const mediaItem = db.upsertMediaItem({
      torrentHash: hash,
      fileIndex: idx,
      relativePath: target.relativePath,
      sizeBytes: target.size,
      durationSec: probe.durationSec,
    });

    const uploadedSubs = db.listCustomSubtitles(hash, idx).map((s) => ({
      id: `usr:${s.id}`,
      source: 'uploaded' as const,
      codec: 'webvtt',
      language: 'zh',
      title: `[上传] ${s.title}`,
      url: `/api/stream/${encodedHash}/${idx}/subtitle/${encodeURIComponent(`usr:${s.id}`)}?token=${encodeURIComponent(streamToken)}`,
    }));

    const nativeSubs = probe.subtitles.map((s) => ({
      id: s.id,
      source: s.source,
      codec: s.codec,
      language: s.language,
      title: s.title,
      url: `/api/stream/${encodedHash}/${idx}/subtitle/${encodeURIComponent(s.id)}?token=${encodeURIComponent(streamToken)}`,
    }));

    const downloadStatus = await getDownloadStatus(hash, idx);

    return {
      fileName: target.fileName,
      relativePath: target.relativePath,
      sizeBytes: target.size,
      probe: {
        ...probe,
        subtitles: [...uploadedSubs, ...nativeSubs],
      },
      downloadStatus,
      mediaItem,
      streamToken,
      urls: {
        direct: directUrl,
        remux: remuxUrl,
        potplayer: `potplayer://${directUrl}`,
        iina: `iina://weblink?url=${encodeURIComponent(directUrl)}`,
        mpv: `mpv://${directUrl}`,
        infuse: `infuse://x-callback-url/play?url=${encodeURIComponent(directUrl)}`,
        vlc: `vlc://${directUrl}`,
        nplayer: `nplayer-${directUrl}`,
      },
    };
  });

  app.post(
    '/api/stream/:hash/:fileIndex/subtitle/upload',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { hash, fileIndex } = req.params as { hash: string; fileIndex: string };
      const idx = Number(fileIndex);
      if (!Number.isInteger(idx) || idx < 0) {
        return reply.code(400).send({ error: 'Bad Request', message: '无效的文件索引' });
      }

      const part = await req.file();
      if (!part) {
        return reply.code(400).send({ error: 'Bad Request', message: '请选择字幕文件（.srt / .ass / .vtt）' });
      }

      const ext = path.extname(part.filename || '').toLowerCase();
      if (!['.srt', '.ass', '.ssa', '.vtt'].includes(ext)) {
        return reply
          .code(400)
          .send({ error: 'UnsupportedFormat', message: '仅支持 .srt / .ass / .ssa / .vtt 字幕格式' });
      }

      const buffer = await part.toBuffer();
      const cleanHash = hash.toLowerCase().replace(/[^a-f0-9]/g, '');
      const outPath = path.join(
        config.dataDir,
        'subtitles',
        `${cleanHash}_${idx}_${Date.now()}.vtt`
      );

      try {
        await convertSubtitleBufferToVtt(buffer, part.filename || 'upload.srt', outPath);
      } catch (err) {
        return reply.code(422).send({
          error: 'SubtitleConvertError',
          message: `字幕解析转换失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const rec = db.addCustomSubtitle({
        torrentHash: hash,
        fileIndex: idx,
        title: part.filename || '外挂字幕.vtt',
        filePath: outPath,
      });

      const streamToken = signStreamToken(config.jwtSecret, hash, idx, 12 * 3600);
      const subId = `usr:${rec.id}`;
      return {
        ok: true,
        subtitle: {
          id: subId,
          source: 'uploaded',
          codec: 'webvtt',
          language: 'zh',
          title: `[上传] ${rec.title}`,
          url: `/api/stream/${encodeURIComponent(hash.toLowerCase())}/${idx}/subtitle/${encodeURIComponent(subId)}?token=${encodeURIComponent(streamToken)}`,
        },
      };
    }
  );

  app.get('/api/stream/:hash/:fileIndex/direct', async (req, reply) => {
    const { hash, fileIndex } = req.params as { hash: string; fileIndex: string };
    const idx = Number(fileIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return reply.code(400).send({ error: 'Bad Request' });
    }
    if (!(await authorizeStream(req, reply, hash, idx))) return;

    const target = await resolveFile(hash, idx);
    if (!target) {
      return reply.code(404).send({ error: 'NotFound', message: '视频文件不存在' });
    }

    const totalSize = target.size;
    const mime = getMimeType(target.absPath);
    const encodedName = encodeURIComponent(target.fileName);
    const rangeHeader = req.headers.range;

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', mime);
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodedName}`);
    reply.header('Cache-Control', 'no-store');

    if (!rangeHeader) {
      reply.code(200);
      reply.header('Content-Length', totalSize);
      return reply.send(fs.createReadStream(target.absPath));
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      reply.code(416);
      reply.header('Content-Range', `bytes */${totalSize}`);
      return reply.send();
    }

    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : totalSize - 1;

    if (!match[1] && match[2]) {
      const suffix = Number(match[2]);
      start = Math.max(0, totalSize - suffix);
      end = totalSize - 1;
    }

    if (start >= totalSize || start > end || start < 0) {
      reply.code(416);
      reply.header('Content-Range', `bytes */${totalSize}`);
      return reply.send();
    }

    end = Math.min(end, totalSize - 1);
    const chunkSize = end - start + 1;

    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    reply.header('Content-Length', chunkSize);

    return reply.send(fs.createReadStream(target.absPath, { start, end }));
  });

  app.get('/api/stream/:hash/:fileIndex/remux', async (req, reply) => {
    const { hash, fileIndex } = req.params as { hash: string; fileIndex: string };
    const idx = Number(fileIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return reply.code(400).send({ error: 'Bad Request' });
    }
    if (!(await authorizeStream(req, reply, hash, idx))) return;

    const target = await resolveFile(hash, idx);
    if (!target) {
      return reply.code(404).send({ error: 'NotFound', message: '视频文件不存在' });
    }

    const query = req.query as { start?: string; audio?: string };
    const startSec = Math.max(0, Number(query.start || 0) || 0);
    const audioIdx = Math.max(0, Math.floor(Number(query.audio || 0) || 0));

    const args: string[] = ['-hide_banner', '-loglevel', 'error'];
    if (startSec > 0) {
      args.push('-ss', startSec.toFixed(3));
    }
    args.push(
      '-i',
      target.absPath,
      '-map',
      '0:v:0',
      '-map',
      `0:a:${audioIdx}?`,
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ac',
      '2',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1'
    );

    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeFfmpegProcesses.add(ffmpeg);

    const cleanupProc = () => {
      activeFfmpegProcesses.delete(ffmpeg);
      if (!ffmpeg.killed) {
        try {
          ffmpeg.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    };

    req.raw.on('close', cleanupProc);
    reply.raw.on('close', cleanupProc);
    ffmpeg.on('exit', () => activeFfmpegProcesses.delete(ffmpeg));
    ffmpeg.on('error', () => activeFfmpegProcesses.delete(ffmpeg));
    ffmpeg.stderr?.resume();

    reply.header('Content-Type', 'video/mp4');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Accel-Buffering', 'no');
    return reply.send(ffmpeg.stdout);
  });

  app.get('/api/stream/:hash/:fileIndex/subtitle/:subId', async (req, reply) => {
    const { hash, fileIndex, subId } = req.params as {
      hash: string;
      fileIndex: string;
      subId: string;
    };
    const idx = Number(fileIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return reply.code(400).send({ error: 'Bad Request' });
    }
    if (!(await authorizeStream(req, reply, hash, idx))) return;

    reply.header('Content-Type', 'text/vtt; charset=utf-8');
    reply.header('Cache-Control', 'no-store');

    // User-uploaded custom WebVTT subtitle
    if (subId.startsWith('usr:')) {
      const idNum = Number(subId.slice(4));
      if (!Number.isInteger(idNum) || idNum <= 0) {
        return reply.code(404).send({ error: 'SubtitleNotFound' });
      }
      const sub = db.getCustomSubtitle(idNum);
      if (!sub || sub.torrentHash !== hash.toLowerCase() || sub.fileIndex !== idx) {
        return reply.code(404).send({ error: 'SubtitleNotFound' });
      }
      const exists = await fsp.stat(sub.filePath).catch(() => null);
      if (!exists) return reply.code(404).send({ error: 'SubtitleNotFound' });
      const raw = await fsp.readFile(sub.filePath, 'utf8');
      return reply.send(sanitizeAndDeduplicateWebVtt(raw));
    }

    const target = await resolveFile(hash, idx);
    if (!target) {
      return reply.code(404).send({ error: 'NotFound' });
    }

    const probe = await probeMedia(target.absPath);
    const track = probe.subtitles.find((s) => s.id === subId);
    if (!track) {
      return reply.code(404).send({ error: 'SubtitleNotFound' });
    }

    if (track.source === 'external' && track.externalPath) {
      const st = await fsp.stat(track.externalPath).catch(() => null);
      const cacheKey = `ext:${track.externalPath}:${st?.mtimeMs || 0}:${st?.size || 0}`;
      const cached = subtitleVttCache.get(cacheKey);
      if (cached) return reply.send(cached);
      try {
        const cleanVtt = await extractSubtitleToCleanVtt(track.externalPath);
        cacheVtt(cacheKey, cleanVtt);
        return reply.send(cleanVtt);
      } catch (err) {
        return reply.code(500).send({
          error: 'SubtitleConvertError',
          message: err instanceof Error ? err.message : '外挂字幕解析失败',
        });
      }
    }

    if (track.source === 'embedded' && track.streamIndex !== undefined) {
      const st = await fsp.stat(target.absPath).catch(() => null);
      const cacheKey = `emb:${target.absPath}:${track.streamIndex}:${st?.mtimeMs || 0}:${st?.size || 0}`;
      const cached = subtitleVttCache.get(cacheKey);
      if (cached) return reply.send(cached);
      try {
        const cleanVtt = await extractSubtitleToCleanVtt(target.absPath, track.streamIndex);
        cacheVtt(cacheKey, cleanVtt);
        return reply.send(cleanVtt);
      } catch (err) {
        return reply.code(500).send({
          error: 'SubtitleExtractError',
          message: err instanceof Error ? err.message : '内封字幕提取失败',
        });
      }
    }

    return reply.code(404).send({ error: 'SubtitleNotFound' });
  });

  app.get('/api/stream/:hash/:fileIndex/thumb', async (req, reply) => {
    const { hash, fileIndex } = req.params as { hash: string; fileIndex: string };
    const idx = Number(fileIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return reply.code(400).send({ error: 'Bad Request' });
    }
    if (!(await authorizeStream(req, reply, hash, idx))) return;

    const cleanHash = hash.toLowerCase().replace(/[^a-f0-9]/g, '');
    if (!cleanHash) return reply.code(400).send({ error: 'Bad Request' });

    const query = req.query as { slot?: string };
    const rawSlot = Number(query.slot ?? 0);
    const slot: 0 | 1 | 2 = rawSlot === 1 ? 1 : rawSlot === 2 ? 2 : 0;

    const thumbPath = path.join(config.dataDir, 'thumbs', `${cleanHash}_${idx}_s${slot}.jpg`);
    const cached = await fsp.stat(thumbPath).catch(() => null);
    if (cached && cached.size > 512) {
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(fs.createReadStream(thumbPath));
    }

    const target = await resolveFile(hash, idx);
    if (!target || target.size < 8 * 1024) {
      return reply.code(404).send({ error: 'NotReady' });
    }

    const key = `${cleanHash}_${idx}_s${slot}`;
    let job = inflightThumbs.get(key);
    if (!job) {
      job = extractVideoThumbnail(target.absPath, thumbPath, slot).finally(() => {
        inflightThumbs.delete(key);
      });
      inflightThumbs.set(key, job);
    }

    const ok = await job;
    if (!ok) {
      return reply.code(404).send({ error: 'ThumbUnavailable' });
    }

    reply.header('Content-Type', 'image/jpeg');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(thumbPath));
  });
}
