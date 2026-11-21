import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppDatabase } from '../db.js';
import { convertSubtitleBufferToVtt } from './media.js';
import { cleanQueryFromTorrentName } from './tmdb.js';

const execFileAsync = promisify(execFile);

export type SubtitleProvider = 'shooter' | 'assrt' | 'subdl' | 'opensubtitles';

export interface OnlineSubtitleResult {
  id: string;
  provider: SubtitleProvider;
  providerLabel: string;
  providerId: string;
  title: string;
  language: string;
  format: string;
  downloads?: number;
  score?: number;
  downloadUrl?: string;
  fileHint?: string;
}

export interface OnlineSubtitleSearchResponse {
  query: string;
  results: OnlineSubtitleResult[];
  providersUsed: string[];
  configuredProviders: {
    shooter: boolean;
    assrt: boolean;
    subdl: boolean;
    opensubtitles: boolean;
  };
  errors: string[];
}

const SUB_EXTS = new Set(['.ass', '.ssa', '.srt', '.vtt']);

export function parseSeasonEpisode(rawName: string): { season?: number; episode?: number } {
  const sxe = rawName.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  if (sxe) {
    return { season: parseInt(sxe[1], 10), episode: parseInt(sxe[2], 10) };
  }
  const epOnly =
    rawName.match(/(?:\bEP?|\s-\s|第)\s*(\d{1,3})(?:\b|[集话\s.\[\]_])/i) ||
    rawName.match(/\[(\d{2,3})(?:v\d)?\]/);
  if (epOnly) {
    return { episode: parseInt(epOnly[1], 10) };
  }
  return {};
}

/**
 * Shooter SPlayer 4-chunk 4KB MD5 file hash algorithm.
 * Works directly on partially downloaded or complete local media files.
 */
export async function computeShooterFileHash(filePath: string): Promise<string | null> {
  const fh = await fs.open(filePath, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const stat = await fh.stat();
    const size = stat.size;
    if (size < 8192) return null;

    const offsets = [
      4096,
      Math.floor(size / 3),
      Math.floor((size * 2) / 3),
      Math.max(0, size - 8192),
    ];
    const chunkLen = 4096;
    const hashes: string[] = [];

    for (const offset of offsets) {
      const buf = Buffer.alloc(chunkLen);
      const { bytesRead } = await fh.read(buf, 0, chunkLen, offset);
      hashes.push(crypto.createHash('md5').update(buf.subarray(0, bytesRead)).digest('hex'));
    }
    return hashes.join(';');
  } finally {
    await fh.close();
  }
}

export interface ArchiveEntry {
  name: string;
  data: Buffer;
}

/**
 * Pure Node.js ZIP reader (supports compression method 0 = Stored and 8 = Deflate).
 * Zero external binary dependencies — works identically on Windows & Linux Docker.
 */
export function extractZipEntries(zipBuf: Buffer): ArchiveEntry[] {
  // Locate End of Central Directory (EOCD) signature 0x06054b50 from end
  const minOffset = Math.max(0, zipBuf.length - 65557);
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= minOffset; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return [];

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  let pos = cdOffset;
  const results: ArchiveEntry[] = [];

  for (let i = 0; i < totalEntries && pos + 46 <= zipBuf.length; i++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(pos + 10);
    const compSize = zipBuf.readUInt32LE(pos + 20);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localOffset = zipBuf.readUInt32LE(pos + 42);

    const nameBuf = zipBuf.subarray(pos + 46, pos + 46 + nameLen);
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBuf);
    } catch {
      try {
        name = new TextDecoder('gb18030').decode(nameBuf);
      } catch {
        name = nameBuf.toString('utf8');
      }
    }

    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || name.includes('__MACOSX/')) continue;
    const ext = path.extname(name).toLowerCase();
    if (!SUB_EXTS.has(ext)) continue;
    if (localOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(localOffset) !== 0x04034b50) {
      continue;
    }

    const localNameLen = zipBuf.readUInt16LE(localOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compData = zipBuf.subarray(dataStart, dataStart + compSize);

    try {
      let data: Buffer;
      if (method === 0) {
        data = Buffer.from(compData);
      } else if (method === 8) {
        data = zlib.inflateRawSync(compData);
      } else {
        continue;
      }
      if (data.length > 0) {
        results.push({ name: path.basename(name), data });
      }
    } catch {
      // skip corrupted entry
    }
  }

  return results;
}

export function pickBestSubtitleEntry(
  entries: ArchiveEntry[],
  episodeNum?: number
): ArchiveEntry | null {
  if (entries.length === 0) return null;
  let best = entries[0];
  let bestScore = -1;

  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    let score = 0;

    if (episodeNum !== undefined) {
      const epInfo = parseSeasonEpisode(entry.name);
      if (epInfo.episode === episodeNum) score += 120;
    }
    if (/(chs|sc|gb|zh-cn|zh_cn|zh-hans|简体|简中|简英|简日)/i.test(lower)) score += 50;
    if (/(双语|中英|中日|bilingual|chs&eng|chs_jpn|zh&en)/i.test(lower)) score += 25;
    if (/(cht|tc|big5|zh-tw|zh-hant|繁体|繁中)/i.test(lower)) score += 30;
    if (lower.endsWith('.ass') || lower.endsWith('.ssa')) score += 8;
    else if (lower.endsWith('.srt')) score += 6;
    if (entry.data.length > 500) score += 2;

    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  return best;
}

async function extractWith7z(archiveBuf: Buffer, ext: string): Promise<ArchiveEntry[]> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudvideo-sub-'));
  const archivePath = path.join(tmpDir, `payload${ext}`);
  const outDir = path.join(tmpDir, 'out');
  try {
    await fs.writeFile(archivePath, archiveBuf);
    await fs.mkdir(outDir, { recursive: true });
    await execFileAsync('7z', ['x', '-y', `-o${outDir}`, archivePath], { timeout: 15000 });

    const entries: ArchiveEntry[] = [];
    const walk = async (dir: string) => {
      const list = await fs.readdir(dir, { withFileTypes: true });
      for (const item of list) {
        if (item.name === '__MACOSX') continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          await walk(full);
        } else if (item.isFile() && SUB_EXTS.has(path.extname(item.name).toLowerCase())) {
          const data = await fs.readFile(full);
          if (data.length > 0) entries.push({ name: item.name, data });
        }
      }
    };
    await walk(outDir);
    return entries;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractSubtitlePayload(
  buffer: Buffer,
  hintFilename: string,
  episodeNum?: number
): Promise<{ filename: string; buffer: Buffer }> {
  const lower = hintFilename.toLowerCase();
  const isZipMagic = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const isRarMagic = buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'Rar!';
  const is7zMagic = buffer.length >= 6 && buffer[0] === 0x37 && buffer[1] === 0x7a && buffer[2] === 0xbc;
  const isGzipMagic = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

  if (isGzipMagic && !isZipMagic) {
    const gunzipped = zlib.gunzipSync(buffer);
    const cleanName = hintFilename.replace(/\.gz$/i, '') || 'subtitle.srt';
    return {
      filename: SUB_EXTS.has(path.extname(cleanName).toLowerCase()) ? cleanName : `${cleanName}.srt`,
      buffer: gunzipped,
    };
  }

  if (isZipMagic || lower.endsWith('.zip')) {
    let entries = extractZipEntries(buffer);
    if (entries.length === 0) {
      entries = await extractWith7z(buffer, '.zip').catch(() => []);
    }
    const picked = pickBestSubtitleEntry(entries, episodeNum);
    if (!picked) throw new Error('ZIP 压缩包中未找到可用的 .srt / .ass / .vtt 字幕文件');
    return { filename: picked.name, buffer: picked.data };
  }

  if (isRarMagic || is7zMagic || lower.endsWith('.rar') || lower.endsWith('.7z')) {
    const ext = is7zMagic || lower.endsWith('.7z') ? '.7z' : '.rar';
    const entries = await extractWith7z(buffer, ext).catch(() => {
      throw new Error(`解压 ${ext.toUpperCase()} 字幕包失败（请确认运行环境已安装 7z）`);
    });
    const picked = pickBestSubtitleEntry(entries, episodeNum);
    if (!picked) throw new Error(`${ext.toUpperCase()} 压缩包中未找到可用的字幕文件`);
    return { filename: picked.name, buffer: picked.data };
  }

  const ext = path.extname(hintFilename).toLowerCase();
  const finalName = SUB_EXTS.has(ext) ? hintFilename : `${hintFilename || 'subtitle'}.srt`;
  return { filename: finalName, buffer };
}

export class OnlineSubtitleService {
  private openSubJwt: { token: string; fetchedAt: number } | null = null;

  constructor(private db: AppDatabase, private dataDir: string) {}

  private get shooterUrl(): string {
    return process.env.SHOOTER_API_URL || 'https://www.shooter.cn/api/subapi.php';
  }
  private get assrtBase(): string {
    return (process.env.ASSRT_API_BASE || 'https://api.assrt.net/v1').replace(/\/+$/, '');
  }
  private get subdlBase(): string {
    return (process.env.SUBDL_API_BASE || 'https://api.subdl.com/api/v1').replace(/\/+$/, '');
  }
  private get subdlDlOrigin(): string {
    return (process.env.SUBDL_DL_ORIGIN || 'https://dl.subdl.com').replace(/\/+$/, '');
  }
  private get openSubBase(): string {
    return (process.env.OPENSUBTITLES_API_BASE || 'https://api.opensubtitles.com/api/v1').replace(/\/+$/, '');
  }

  private async searchShooter(filePath: string, fileName: string, lang: 'zh' | 'all'): Promise<OnlineSubtitleResult[]> {
    const hash = await computeShooterFileHash(filePath);
    if (!hash) return [];

    const body = new URLSearchParams({
      filehash: hash,
      pathinfo: fileName,
      format: 'json',
      lang: lang === 'zh' ? 'chn' : 'chn',
    });

    const res = await fetch(this.shooterUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'SPlayer Build 1543',
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length <= 2 || buf[0] === 0xff) return [];

    const parsed = JSON.parse(buf.toString('utf8')) as Array<{
      Desc?: string;
      Files?: Array<{ Ext?: string; Link?: string }>;
    }>;
    if (!Array.isArray(parsed)) return [];

    const results: OnlineSubtitleResult[] = [];
    let idx = 0;
    for (const group of parsed) {
      for (const f of group.Files || []) {
        if (!f.Link) continue;
        const ext = (f.Ext || 'srt').toLowerCase();
        if (!['srt', 'ass', 'ssa', 'vtt'].includes(ext)) continue;
        results.push({
          id: `shooter:${idx++}`,
          provider: 'shooter',
          providerLabel: '射手哈希直配',
          providerId: String(idx),
          title: group.Desc?.trim() || `${fileName} (${ext.toUpperCase()} 精准匹配)`,
          language: '中文',
          format: ext.toUpperCase(),
          downloadUrl: f.Link,
          fileHint: `shooter_${idx}.${ext}`,
        });
      }
    }
    return results.slice(0, 8);
  }

  private async searchAssrt(token: string, query: string): Promise<OnlineSubtitleResult[]> {
    if (query.trim().length < 2) return [];
    const u = new URL(`${this.assrtBase}/sub/search`);
    u.searchParams.set('token', token);
    u.searchParams.set('q', query.trim());
    u.searchParams.set('cnt', '15');

    const res = await fetch(u.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      status?: number;
      errormsg?: string;
      sub?: {
        subs?: Array<{
          id: number;
          native_name?: string;
          videoname?: string;
          title?: string;
          subtype?: string;
          lang?: { desc?: string };
          lan?: string;
          vote_score?: number;
          download_count?: number;
        }>;
      };
    };
    if (data.status && data.status !== 0) {
      throw new Error(data.errormsg || `Assrt status ${data.status}`);
    }

    const subs = data.sub?.subs || [];
    return subs.map((s) => ({
      id: `assrt:${s.id}`,
      provider: 'assrt' as const,
      providerLabel: '伪射手 Assrt',
      providerId: String(s.id),
      title: s.native_name || s.videoname || s.title || `字幕 #${s.id}`,
      language: s.lang?.desc || s.lan || '中文',
      format: (s.subtype || 'SRT/ASS').toUpperCase(),
      downloads: s.download_count,
      score: s.vote_score,
    }));
  }

  private async searchSubdl(
    apiKey: string,
    opts: { query: string; tmdbId?: number | null; mediaType?: string; season?: number; episode?: number; lang: 'zh' | 'all' }
  ): Promise<OnlineSubtitleResult[]> {
    const u = new URL(`${this.subdlBase}/subtitles`);
    u.searchParams.set('api_key', apiKey);
    u.searchParams.set('subs_per_page', '15');
    if (opts.lang === 'zh') {
      u.searchParams.set('languages', 'ZH,ZH_BG');
    }

    if (opts.tmdbId) {
      u.searchParams.set('tmdb_id', String(opts.tmdbId));
      if (opts.mediaType === 'tv' || opts.mediaType === 'movie') {
        u.searchParams.set('type', opts.mediaType);
      }
      if (opts.season) u.searchParams.set('season_number', String(opts.season));
      if (opts.episode) u.searchParams.set('episode_number', String(opts.episode));
    } else {
      u.searchParams.set('film_name', opts.query);
    }

    const res = await fetch(u.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      status?: boolean;
      error?: string;
      subtitles?: Array<{
        sd_id?: number;
        sub_id?: number | string;
        name?: string;
        release_name?: string;
        lang?: string;
        language?: string;
        url?: string;
      }>;
    };
    if (data.status === false) {
      throw new Error(data.error || 'SubDL 返回失败');
    }

    return (data.subtitles || [])
      .filter((s) => Boolean(s.url))
      .map((s, idx) => {
        const rawUrl = s.url || '';
        const downloadUrl = /^https?:\/\//i.test(rawUrl)
          ? rawUrl
          : `${this.subdlDlOrigin}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
        return {
          id: `subdl:${s.sub_id || s.sd_id || idx}`,
          provider: 'subdl' as const,
          providerLabel: 'SubDL',
          providerId: String(s.sub_id || s.sd_id || idx),
          title: s.release_name || s.name || 'SubDL 字幕',
          language: s.language || s.lang || '中文',
          format: rawUrl.toLowerCase().endsWith('.zip') ? 'ZIP' : 'SRT',
          downloadUrl,
          fileHint: s.name || 'subdl.zip',
        };
      });
  }

  private async searchOpenSubtitles(
    apiKey: string,
    opts: { query: string; tmdbId?: number | null; season?: number; episode?: number; lang: 'zh' | 'all' }
  ): Promise<OnlineSubtitleResult[]> {
    const u = new URL(`${this.openSubBase}/subtitles`);
    if (opts.tmdbId) {
      u.searchParams.set('tmdb_id', String(opts.tmdbId));
      if (opts.season) u.searchParams.set('season_number', String(opts.season));
      if (opts.episode) u.searchParams.set('episode_number', String(opts.episode));
    } else {
      u.searchParams.set('query', opts.query);
    }
    if (opts.lang === 'zh') {
      u.searchParams.set('languages', 'zh-cn,zh-tw,zh-ze');
    }

    const res = await fetch(u.toString(), {
      headers: {
        'Api-Key': apiKey,
        'User-Agent': 'CloudVideo v3.3',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as {
      data?: Array<{
        id: string;
        attributes?: {
          language?: string;
          release?: string;
          download_count?: number;
          files?: Array<{ file_id: number; file_name?: string }>;
        };
      }>;
    };

    const results: OnlineSubtitleResult[] = [];
    for (const item of data.data || []) {
      const file = item.attributes?.files?.[0];
      if (!file?.file_id) continue;
      const fn = file.file_name || item.attributes?.release || `OpenSubtitles #${file.file_id}`;
      const ext = path.extname(fn).replace(/^\./, '').toUpperCase() || 'SRT';
      results.push({
        id: `opensubtitles:${file.file_id}`,
        provider: 'opensubtitles',
        providerLabel: 'OpenSubtitles',
        providerId: String(file.file_id),
        title: item.attributes?.release || fn,
        language: item.attributes?.language || 'zh-cn',
        format: ext,
        downloads: item.attributes?.download_count,
        fileHint: fn,
      });
    }
    return results.slice(0, 15);
  }

  async search(opts: {
    filePath?: string;
    fileName: string;
    query?: string;
    tmdbId?: number | null;
    mediaType?: string;
    lang?: 'zh' | 'all';
  }): Promise<OnlineSubtitleSearchResponse> {
    const settings = this.db.getSettings();
    const cleaned = cleanQueryFromTorrentName(opts.fileName);
    const searchQuery = (opts.query || '').trim() || cleaned.query || opts.fileName;
    const epInfo = parseSeasonEpisode(opts.fileName);
    const lang = opts.lang || 'zh';

    const configuredProviders = {
      shooter: true,
      assrt: Boolean(settings.assrtToken.trim()),
      subdl: Boolean(settings.subdlApiKey.trim()),
      opensubtitles: Boolean(settings.openSubtitlesApiKey.trim()),
    };

    const tasks: Array<{ label: string; promise: Promise<OnlineSubtitleResult[]> }> = [];

    if (opts.filePath) {
      tasks.push({
        label: '射手哈希',
        promise: this.searchShooter(opts.filePath, opts.fileName, lang),
      });
    }
    if (configuredProviders.assrt) {
      tasks.push({
        label: '伪射手',
        promise: this.searchAssrt(settings.assrtToken.trim(), searchQuery),
      });
    }
    if (configuredProviders.subdl) {
      tasks.push({
        label: 'SubDL',
        promise: this.searchSubdl(settings.subdlApiKey.trim(), {
          query: searchQuery,
          tmdbId: opts.tmdbId,
          mediaType: opts.mediaType,
          season: epInfo.season,
          episode: epInfo.episode,
          lang,
        }),
      });
    }
    if (configuredProviders.opensubtitles) {
      tasks.push({
        label: 'OpenSubtitles',
        promise: this.searchOpenSubtitles(settings.openSubtitlesApiKey.trim(), {
          query: searchQuery,
          tmdbId: opts.tmdbId,
          season: epInfo.season,
          episode: epInfo.episode,
          lang,
        }),
      });
    }

    const settled = await Promise.allSettled(tasks.map((t) => t.promise));
    const results: OnlineSubtitleResult[] = [];
    const errors: string[] = [];

    settled.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        errors.push(`${tasks[i].label}: ${msg}`);
      } else {
        results.push(...outcome.value);
      }
    });

    return {
      query: searchQuery,
      results,
      providersUsed: tasks.map((t) => t.label),
      configuredProviders,
      errors,
    };
  }

  private async getOpenSubtitlesAuthToken(apiKey: string, username: string, password: string): Promise<string> {
    if (!username || !password) return '';
    if (this.openSubJwt && Date.now() - this.openSubJwt.fetchedAt < 12 * 3600 * 1000) {
      return this.openSubJwt.token;
    }
    const res = await fetch(`${this.openSubBase}/login`, {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'CloudVideo v3.3',
      },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return '';
    const data = (await res.json()) as { token?: string };
    if (data.token) {
      this.openSubJwt = { token: data.token, fetchedAt: Date.now() };
      return data.token;
    }
    return '';
  }

  async downloadAndInstall(input: {
    torrentHash: string;
    fileIndex: number;
    videoFileName: string;
    provider: SubtitleProvider;
    providerId: string;
    title: string;
    downloadUrl?: string;
    fileHint?: string;
  }): Promise<{ id: number; title: string; filePath: string }> {
    const settings = this.db.getSettings();
    let targetUrl = (input.downloadUrl || '').trim();
    let filenameHint = input.fileHint || input.title || 'subtitle.srt';

    if (input.provider === 'assrt') {
      const token = settings.assrtToken.trim();
      if (!token) throw new Error('尚未配置伪射手 Assrt API Token');
      const u = new URL(`${this.assrtBase}/sub/detail`);
      u.searchParams.set('token', token);
      u.searchParams.set('id', input.providerId);
      const res = await fetch(u.toString(), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`伪射手获取下载链接失败 (HTTP ${res.status})`);
      const data = (await res.json()) as {
        status?: number;
        errormsg?: string;
        sub?: {
          subs?: Array<{
            url?: string;
            filename?: string;
            filelist?: Array<{ url?: string; f?: string }>;
          }>;
        };
      };
      if (data.status && data.status !== 0) {
        throw new Error(data.errormsg || '伪射手返回错误');
      }
      const detail = data.sub?.subs?.[0];
      if (!detail) throw new Error('未找到该字幕详情');
      // Prefer individual subtitle file from filelist if Assrt provides direct links!
      const directFile = detail.filelist?.find(
        (f) => f.url && f.f && SUB_EXTS.has(path.extname(f.f).toLowerCase())
      );
      if (directFile?.url) {
        targetUrl = directFile.url;
        filenameHint = directFile.f || filenameHint;
      } else if (detail.url) {
        targetUrl = detail.url;
        filenameHint = detail.filename || filenameHint;
      } else {
        throw new Error('伪射手未返回可用下载地址');
      }
    } else if (input.provider === 'opensubtitles') {
      const apiKey = settings.openSubtitlesApiKey.trim();
      if (!apiKey) throw new Error('尚未配置 OpenSubtitles API Key');
      const jwt = await this.getOpenSubtitlesAuthToken(
        apiKey,
        settings.openSubtitlesUsername.trim(),
        settings.openSubtitlesPassword.trim()
      );
      const headers: Record<string, string> = {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'CloudVideo v3.3',
      };
      if (jwt) headers.Authorization = `Bearer ${jwt}`;

      const res = await fetch(`${this.openSubBase}/download`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ file_id: Number(input.providerId) }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`OpenSubtitles 获取下载链接失败 (HTTP ${res.status}): ${errText.slice(0, 120)}`);
      }
      const data = (await res.json()) as { link?: string; file_name?: string };
      if (!data.link) throw new Error('OpenSubtitles 未返回下载链接');
      targetUrl = data.link;
      if (data.file_name) filenameHint = data.file_name;
    }

    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      throw new Error('缺少合法的字幕下载地址');
    }

    const dlRes = await fetch(targetUrl, {
      headers: { 'User-Agent': 'CloudVideo/3.3' },
      signal: AbortSignal.timeout(20000),
    });
    if (!dlRes.ok) {
      throw new Error(`下载字幕文件失败 (HTTP ${dlRes.status})`);
    }

    const disp = dlRes.headers.get('content-disposition') || '';
    const fnMatch = disp.match(/filename\*?=(?:UTF-8''|"?)([^";\r\n"]+)/i);
    if (fnMatch?.[1]) {
      try {
        filenameHint = decodeURIComponent(fnMatch[1].replace(/"/g, ''));
      } catch {
        filenameHint = fnMatch[1].replace(/"/g, '');
      }
    }

    const rawBuf = Buffer.from(await dlRes.arrayBuffer());
    if (rawBuf.length === 0) throw new Error('下载到的字幕文件为空');

    const epInfo = parseSeasonEpisode(input.videoFileName);
    const extracted = await extractSubtitlePayload(rawBuf, filenameHint, epInfo.episode);

    const cleanHash = input.torrentHash.toLowerCase().replace(/[^a-f0-9]/g, '');
    const outPath = path.join(
      this.dataDir,
      'subtitles',
      `${cleanHash}_${input.fileIndex}_${Date.now()}.vtt`
    );

    await convertSubtitleBufferToVtt(extracted.buffer, extracted.filename, outPath);

    const displayLabel = `${input.title.slice(0, 60)}`;
    const rec = this.db.addCustomSubtitle({
      torrentHash: input.torrentHash,
      fileIndex: input.fileIndex,
      title: displayLabel,
      filePath: outPath,
    });

    return { id: rec.id, title: rec.title, filePath: rec.filePath };
  }
}
