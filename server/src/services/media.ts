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
    recommendedMode: direct ? 'direct' : 'remux',
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
