import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.mov',
  '.m4v',
  '.avi',
  '.ts',
  '.m2ts',
  '.flv',
  '.wmv',
]);

export const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa']);

export interface AudioTrack {
  index: number; // stream index among audio tracks (0, 1, ...)
  streamIndex: number;
  codec: string;
  language: string;
  title: string;
  channels: number;
}

export interface SubtitleTrack {
  id: string; // "emb:0" or "ext:0"
  source: 'embedded' | 'external';
  streamIndex?: number;
  externalPath?: string;
  codec: string;
  language: string;
  title: string;
}

export interface MediaProbeResult {
  durationSec: number;
  bitrateBps: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  container: string;
  canDirectPlay: boolean;
  recommendedMode: 'direct' | 'remux';
  requiredMbps: number;
  audioTracks: AudioTrack[];
  subtitles: SubtitleTrack[];
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  result: MediaProbeResult;
}

const probeCache = new Map<string, CacheEntry>();

export function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.mkv':
      return 'video/x-matroska';
    case '.ts':
    case '.m2ts':
      return 'video/mp2t';
    case '.avi':
      return 'video/x-msvideo';
    default:
      return 'application/octet-stream';
  }
}

export function resolveSafePath(downloadDir: string, relativePath: string): string {
  const root = path.resolve(downloadDir);
  const cleaned = relativePath.replace(/^[/\\]+/, '');
  const resolved = path.resolve(root, cleaned);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Invalid file path: path traversal detected');
  }
  return resolved;
}

export function canBrowserDirectPlay(ext: string, videoCodec: string, audioCodec: string): boolean {
  const e = ext.toLowerCase();
  const vc = videoCodec.toLowerCase();
  const ac = audioCodec.toLowerCase();

  const containerOk = e === '.mp4' || e === '.m4v' || e === '.webm' || e === '.mov';
  if (!containerOk) return false;

  const videoOk = vc === 'h264' || vc === 'vp8' || vc === 'vp9' || vc === 'av1' || vc === '';
  const audioOk =
    ac === '' ||
    ac === 'aac' ||
    ac === 'mp3' ||
    ac === 'opus' ||
    ac === 'vorbis' ||
    ac === 'flac';

  return videoOk && audioOk;
}

async function discoverExternalSubtitles(videoPath: string): Promise<SubtitleTrack[]> {
  const dir = path.dirname(videoPath);
  const baseName = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const subs: SubtitleTrack[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let idx = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUBTITLE_EXTENSIONS.has(ext)) continue;
      const lower = entry.name.toLowerCase();
      if (!lower.startsWith(baseName) && entries.filter((e) => isVideoFile(e.name)).length > 1) {
        continue;
      }
      subs.push({
        id: `ext:${idx++}`,
        source: 'external',
        externalPath: path.join(dir, entry.name),
        codec: ext.slice(1),
        language: 'ext',
        title: entry.name,
      });
    }
  } catch {
    // ignore directory read errors
  }

  return subs;
}

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

export async function probeMedia(filePath: string): Promise<MediaProbeResult> {
  const stat = await fs.stat(filePath);
  const cached = probeCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.result;
  }

  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: 8 * 1024 * 1024, timeout: 15000 }
  );

  const data = JSON.parse(stdout) as {
    format?: { duration?: string; bit_rate?: string; format_name?: string };
    streams?: Array<{
      index: number;
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      channels?: number;
      tags?: Record<string, string>;
    }>;
  };

  const streams = data.streams || [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subStreams = streams.filter(
    (s) => s.codec_type === 'subtitle' && TEXT_SUB_CODECS.has((s.codec_name || '').toLowerCase())
  );

  const durationSec = Number(data.format?.duration || 0) || 0;
  let bitrateBps = Number(data.format?.bit_rate || 0) || 0;
  if (!bitrateBps && durationSec > 0 && stat.size > 0) {
    bitrateBps = Math.round((stat.size * 8) / durationSec);
  }

  const videoCodec = videoStream?.codec_name || '';
  const primaryAudioCodec = audioStreams[0]?.codec_name || '';
  const ext = path.extname(filePath).toLowerCase();
  const direct = canBrowserDirectPlay(ext, videoCodec, primaryAudioCodec);

  const audioTracks: AudioTrack[] = audioStreams.map((s, idx) => ({
    index: idx,
    streamIndex: s.index,
    codec: s.codec_name || 'unknown',
    language: s.tags?.language || 'und',
    title: s.tags?.title || `音轨 ${idx + 1} (${s.tags?.language || s.codec_name || 'Audio'})`,
    channels: s.channels || 2,
  }));

  const embeddedSubs: SubtitleTrack[] = subStreams.map((s, idx) => ({
    id: `emb:${idx}`,
    source: 'embedded',
    streamIndex: s.index,
    codec: s.codec_name || 'subrip',
    language: s.tags?.language || 'und',
    title: s.tags?.title || `内封字幕 ${idx + 1} (${s.tags?.language || s.codec_name})`,
  }));

  const externalSubs = await discoverExternalSubtitles(filePath);

  const result: MediaProbeResult = {
    durationSec,
    bitrateBps,
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    videoCodec,
    audioCodec: primaryAudioCodec,
    container: ext.replace(/^\./, '') || data.format?.format_name || 'unknown',
    canDirectPlay: direct,
    recommendedMode: 'direct',
    requiredMbps: Number(((bitrateBps / 1_000_000) * 1.25).toFixed(2)),
    audioTracks,
    subtitles: [...externalSubs, ...embeddedSubs],
  };

  if (probeCache.size > 200) {
    const firstKey = probeCache.keys().next().value;
    if (firstKey) probeCache.delete(firstKey);
  }
  probeCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, result });

  return result;
}

export async function extractVideoThumbnail(
  videoPath: string,
  outputJpgPath: string,
  slot: 0 | 1 | 2 = 0
): Promise<boolean> {
  await fs.mkdir(path.dirname(outputJpgPath), { recursive: true });

  let durationSec = 0;
  try {
    const p = await probeMedia(videoPath);
    durationSec = p.durationSec;
  } catch {
    durationSec = 0;
  }

  const slotRatios: Record<0 | 1 | 2, number> = { 0: 0.15, 1: 0.48, 2: 0.78 };
  const targetSeek =
    durationSec > 10
      ? Math.max(2, Math.min(durationSec - 1, Math.round(durationSec * slotRatios[slot])))
      : slot === 0
      ? Math.min(1, Math.floor(durationSec * 0.2))
      : Math.min(Math.max(0, durationSec - 0.5), Math.round(durationSec * slotRatios[slot]));

  const tryExtract = async (seekSec: number, smartFilter: boolean): Promise<boolean> => {
    try {
      const args = ['-y', '-hide_banner', '-loglevel', 'error'];
      if (seekSec > 0) {
        args.push('-ss', String(seekSec));
      }
      const vf = smartFilter
        ? 'thumbnail=n=24,scale=640:-2:force_original_aspect_ratio=decrease'
        : 'scale=640:-2:force_original_aspect_ratio=decrease';
      args.push('-i', videoPath, '-frames:v', '1', '-vf', vf, '-q:v', '4', outputJpgPath);
      await execFileAsync('ffmpeg', args, { timeout: 14000 });
      const st = await fs.stat(outputJpgPath).catch(() => null);
      return Boolean(st && st.size > 512);
    } catch {
      return false;
    }
  };

  if (durationSec >= 12 && (await tryExtract(targetSeek, true))) return true;
  if (await tryExtract(targetSeek, false)) return true;
  if (targetSeek > 0 && (await tryExtract(0, false))) return true;
  return false;
}

interface VttCue {
  startMs: number;
  endMs: number;
  settings: string;
  lines: string[];
  normKey: string;
}

function parseVttTimestampMs(ts: string): number {
  const clean = ts.trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length < 2 || parts.length > 3) return -1;
  const sec = parseFloat(parts.pop() || '0');
  const min = parseInt(parts.pop() || '0', 10);
  const hr = parts.length > 0 ? parseInt(parts.pop() || '0', 10) : 0;
  if (!Number.isFinite(sec) || !Number.isFinite(min) || !Number.isFinite(hr)) return -1;
  return Math.max(0, Math.round((hr * 3600 + min * 60 + sec) * 1000));
}

function formatVttTimestampMs(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const rem = clamped % 1000;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(rem)}`;
}

function isAssVectorDrawingLine(line: string): boolean {
  return /^m\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?(?:\s+[lbspc]\s+(?:-?\d+(?:\.\d+)?\s*)+)+$/i.test(
    line.trim()
  );
}

function cleanCueText(rawText: string): { lines: string[]; alignTop: boolean } {
  // Detect ASS top alignment tags before stripping override blocks
  const alignTop = /\{[^}]*\\an[789][^}]*\}/i.test(rawText);

  let text = rawText
    // Remove ASS vector drawing blocks {\p1}...{\p0}
    .replace(/\{[^}]*\\p[1-9][^}]*\}[\s\S]*?(?:\{[^}]*\\p0[^}]*\}|$)/gi, '')
    // Strip ALL remaining ASS override blocks including empty {}
    .replace(/\{[^}]*\}/g, '')
    // Replace ASS escape sequences
    .replace(/\\N|\\n/g, '\n')
    .replace(/\\h/g, ' ')
    // Strip HTML/VTT style wrapper tags that interfere with clean typography
    .replace(/<\/?(?:font|c|b|i|u|ruby|rt|span)[^>]*>/gi, '')
    // Decode common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");

  const rawLines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0 && !isAssVectorDrawingLine(l));

  // Deduplicate identical lines inside the same cue
  const dedupLines: string[] = [];
  const seen = new Set<string>();
  for (const line of rawLines) {
    const key = line.replace(/\s+/g, '').toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      dedupLines.push(line);
    }
  }

  return { lines: dedupLines, alignTop };
}

/**
 * Cleans ASS/SRT-to-WebVTT conversion artifacts:
 * - Strips empty `{}` and stray ASS override tags / vector drawings
 * - Collapses layered anime shadow/glow/border duplicate cues at overlapping timestamps
 * - Merges contiguous frame-by-frame animation spam cues with identical text
 * - Preserves top-aligned signs/notes (`{\an7|8|9}`) cleanly at `line:6%`
 */
export function sanitizeAndDeduplicateWebVtt(rawVtt: string): string {
  const normalized = rawVtt.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const parsedCues: VttCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;

    const timeLine = lines[timeIdx].trim();
    const timeMatch = timeLine.match(
      /^(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})(.*)$/
    );
    if (!timeMatch) continue;

    const startMs = parseVttTimestampMs(timeMatch[1]);
    const endMs = parseVttTimestampMs(timeMatch[2]);
    if (startMs < 0 || endMs <= startMs) continue;

    const rawSettings = (timeMatch[3] || '').trim();
    const payload = lines.slice(timeIdx + 1).join('\n');
    const { lines: cleanLines, alignTop } = cleanCueText(payload);
    if (cleanLines.length === 0) continue;

    // Strip messy FFmpeg absolute pixel positions but preserve clean top alignment
    let settings = '';
    if (alignTop || /\bline:\s*(?:[0-9]|1[0-9]|20)%/i.test(rawSettings)) {
      settings = 'line:6%';
    }

    const normKey = cleanLines.join('\n').replace(/\s+/g, '').toLowerCase();
    parsedCues.push({ startMs, endMs, settings, lines: cleanLines, normKey });
  }

  // Sort chronologically
  parsedCues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  // Deduplicate overlapping & contiguous identical cues (fixes 3x layered ASS effects & animation spam)
  const merged: VttCue[] = [];
  for (const cue of parsedCues) {
    let matchedExisting = false;
    for (let i = merged.length - 1; i >= 0; i--) {
      const prev = merged[i];
      if (cue.startMs > prev.endMs + 400) {
        // Because cues are sorted by startMs, only stop if far enough back
        if (cue.startMs - prev.startMs > 30_000) break;
        continue;
      }
      if (prev.normKey === cue.normKey && cue.startMs <= prev.endMs + 350) {
        prev.endMs = Math.max(prev.endMs, cue.endMs);
        if (!prev.settings && cue.settings) prev.settings = cue.settings;
        matchedExisting = true;
        break;
      }
    }
    if (!matchedExisting) {
      merged.push({ ...cue });
    }
  }

  const out: string[] = ['WEBVTT', ''];
  for (const cue of merged) {
    const header = `${formatVttTimestampMs(cue.startMs)} --> ${formatVttTimestampMs(cue.endMs)}${
      cue.settings ? ` ${cue.settings}` : ''
    }`;
    out.push(header);
    out.push(...cue.lines);
    out.push('');
  }
  return out.join('\n');
}

export async function extractSubtitleToCleanVtt(
  inputPath: string,
  streamIndex?: number
): Promise<string> {
  const ext = path.extname(inputPath).toLowerCase();
  if (streamIndex === undefined && ext === '.vtt') {
    const raw = await fs.readFile(inputPath, 'utf8');
    return sanitizeAndDeduplicateWebVtt(raw);
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-i', inputPath];
  if (streamIndex !== undefined) {
    args.push('-map', `0:${streamIndex}`);
  }
  args.push('-f', 'webvtt', 'pipe:1');

  const { stdout } = await execFileAsync('ffmpeg', args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 25000,
  });
  return sanitizeAndDeduplicateWebVtt(stdout);
}

export function decodeSubtitleBufferToUtf8(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      // GB18030 is a superset of GBK & GB2312 (common for Chinese subtitles on Assrt/Shooter)
      return new TextDecoder('gb18030').decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  }
}

export async function convertSubtitleBufferToVtt(
  buffer: Buffer,
  originalName: string,
  outputVttPath: string
): Promise<void> {
  await fs.mkdir(path.dirname(outputVttPath), { recursive: true });
  const ext = path.extname(originalName).toLowerCase();
  const decodedText = decodeSubtitleBufferToUtf8(buffer);

  if (ext === '.vtt') {
    const clean = sanitizeAndDeduplicateWebVtt(decodedText);
    await fs.writeFile(outputVttPath, clean, 'utf8');
    return;
  }

  const tmpIn = `${outputVttPath}.src${ext || '.srt'}`;
  await fs.writeFile(tmpIn, decodedText, 'utf8');
  try {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', tmpIn, '-f', 'webvtt', 'pipe:1'],
      { maxBuffer: 16 * 1024 * 1024, timeout: 15000 }
    );
    const clean = sanitizeAndDeduplicateWebVtt(stdout);
    await fs.writeFile(outputVttPath, clean, 'utf8');
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
  }
}
