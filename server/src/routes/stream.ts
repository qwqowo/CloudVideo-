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
import { getMimeType, probeMedia, resolveSafePath } from '../services/media.js';

export const activeFfmpegProcesses = new Set<ChildProcess>();

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

    // Touch / record file metadata in DB
    const mediaItem = db.upsertMediaItem({
      torrentHash: hash,
      fileIndex: idx,
      relativePath: target.relativePath,
      sizeBytes: target.size,
      durationSec: probe.durationSec,
    });

    const subtitles = probe.subtitles.map((s) => ({
      id: s.id,
      source: s.source,
      codec: s.codec,
      language: s.language,
      title: s.title,
      url: `/api/stream/${encodedHash}/${idx}/subtitle/${encodeURIComponent(s.id)}?token=${encodeURIComponent(streamToken)}`,
    }));

    return {
      fileName: target.fileName,
      relativePath: target.relativePath,
      sizeBytes: target.size,
      probe: {
        ...probe,
        subtitles,
      },
      mediaItem,
      streamToken,
      urls: {
        direct: directUrl,
        remux: remuxUrl,
        potplayer: `potplayer://${directUrl}`,
        iina: `iina://weblink?url=${encodeURIComponent(directUrl)}`,
        mpv: `mpv://${directUrl}`,
      },
    };
  });

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
      // Suffix range bytes=-500
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

    // Drain stderr so ffmpeg never blocks on pipe buffer
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

    const target = await resolveFile(hash, idx);
    if (!target) {
      return reply.code(404).send({ error: 'NotFound' });
    }

    const probe = await probeMedia(target.absPath);
    const track = probe.subtitles.find((s) => s.id === subId);
    if (!track) {
      return reply.code(404).send({ error: 'SubtitleNotFound' });
    }

    reply.header('Content-Type', 'text/vtt; charset=utf-8');
    reply.header('Cache-Control', 'no-store');

    if (track.source === 'external' && track.externalPath) {
      if (path.extname(track.externalPath).toLowerCase() === '.vtt') {
        return reply.send(fs.createReadStream(track.externalPath));
      }
      const ffmpeg = spawn(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-i', track.externalPath, '-f', 'webvtt', 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      activeFfmpegProcesses.add(ffmpeg);
      const stop = () => {
        activeFfmpegProcesses.delete(ffmpeg);
        if (!ffmpeg.killed) ffmpeg.kill('SIGKILL');
      };
      req.raw.on('close', stop);
      ffmpeg.on('exit', () => activeFfmpegProcesses.delete(ffmpeg));
      ffmpeg.stderr?.resume();
      return reply.send(ffmpeg.stdout);
    }

    if (track.source === 'embedded' && track.streamIndex !== undefined) {
      const ffmpeg = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          target.absPath,
          '-map',
          `0:${track.streamIndex}`,
          '-f',
          'webvtt',
          'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      activeFfmpegProcesses.add(ffmpeg);
      const stop = () => {
        activeFfmpegProcesses.delete(ffmpeg);
        if (!ffmpeg.killed) ffmpeg.kill('SIGKILL');
      };
      req.raw.on('close', stop);
      ffmpeg.on('exit', () => activeFfmpegProcesses.delete(ffmpeg));
      ffmpeg.stderr?.resume();
      return reply.send(ffmpeg.stdout);
    }

    return reply.code(404).send({ error: 'SubtitleNotFound' });
  });
}
