let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

export async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error('未登录或登录已过期');
  }

  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const data = (await res.json()) as { message?: string; error?: string };
      if (data.message) msg = data.message;
      else if (data.error) msg = data.error;
    } catch {
      // ignore json parse error
    }
    throw new Error(msg);
  }

  return (await res.json()) as T;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx >= 2 ? 2 : 0)} ${units[idx]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatCountdown(targetMs: number | null): string {
  if (!targetMs) return '';
  const diff = targetMs - Date.now();
  if (diff <= 0) return '即将卸载';
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `${mins}m 后卸载`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m 后卸载` : `${hours}h 后卸载`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h 后卸载` : `${days}d 后卸载`;
}

export interface ParsedMediaTitle {
  title: string;
  year?: string;
  resolution?: string;
  tags: string[];
}

export function parseMediaTitle(rawName: string): ParsedMediaTitle {
  const base = rawName.replace(/\.[a-z0-9]{2,4}$/i, '');
  const tags: string[] = [];

  let resolution: string | undefined;
  if (/\b(2160p|4k|uhd)\b/i.test(base)) resolution = '4K';
  else if (/\b1080p\b/i.test(base)) resolution = '1080P';
  else if (/\b720p\b/i.test(base)) resolution = '720P';

  if (/\b(hdr10\+?|hdr|dv|dovi|dolby\.?vision)\b/i.test(base)) tags.push('HDR');
  if (/\bremux\b/i.test(base)) tags.push('REMUX');
  else if (/\b(blu-?ray|bdrip|bdremux)\b/i.test(base)) tags.push('BLURAY');
  else if (/\bweb-?dl\b/i.test(base)) tags.push('WEB-DL');
  else if (/\bwebrip\b/i.test(base)) tags.push('WEBRIP');

  if (/\b(x265|h\.?265|hevc)\b/i.test(base)) tags.push('HEVC');
  else if (/\b(x264|h\.?264|avc)\b/i.test(base)) tags.push('H264');
  else if (/\bav1\b/i.test(base)) tags.push('AV1');

  if (/\b(atmos|truehd|dts-?hd|dts|ddp5\.?1|eac3)\b/i.test(base)) tags.push('SURROUND');

  const yearMatch = base.match(/(?:^|[.\s(_[-])((?:19|20)\d{2})(?:$|[.\s)_\]-])/);
  const year = yearMatch?.[1];

  // Clean display title: strip common release suffixes after resolution/source markers
  let cleaned = base.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const cutMatch = cleaned.match(
    /\b(2160p|1080p|720p|4k|uhd|web-?dl|webrip|blu-?ray|bdrip|remux|hdtv|x264|x265|hevc|h\.?264|h\.?265)\b/i
  );
  if (cutMatch && cutMatch.index && cutMatch.index > 3) {
    cleaned = cleaned.slice(0, cutMatch.index).trim();
  }
  cleaned = cleaned.replace(/[-(\[]+$/, '').trim();

  return {
    title: cleaned.length >= 2 ? cleaned : base,
    year,
    resolution,
    tags: tags.slice(0, 3),
  };
}

export function translateTorrentState(state: string): {
  label: string;
  code: string;
  dot: string;
  badge: string;
} {
  const s = state.toLowerCase();
  if (s.includes('downloading') || s === 'forceddl') {
    return {
      label: '下载中',
      code: '下载中',
      dot: 'bg-amber-400 animate-pulse',
      badge: 'text-amber-200 bg-amber-500/15 border-amber-400/30',
    };
  }
  if (s === 'metadl') {
    return {
      label: '解析中',
      code: '解析中',
      dot: 'bg-amber-300 animate-pulse',
      badge: 'text-amber-200 bg-amber-500/15 border-amber-400/30',
    };
  }
  if (s === 'stalleddl') {
    return {
      label: '等待连接',
      code: '等待连接',
      dot: 'bg-zinc-400',
      badge: 'text-zinc-300 bg-white/[0.07] border-white/10',
    };
  }
  if (s.includes('up') || s === 'uploading') {
    return {
      label: '已就绪',
      code: '可播放',
      dot: 'bg-emerald-400',
      badge: 'text-emerald-200 bg-emerald-500/15 border-emerald-400/30',
    };
  }
  if (s.includes('paused') || s.includes('stopped')) {
    return {
      label: '已暂停',
      code: '已暂停',
      dot: 'bg-zinc-500',
      badge: 'text-zinc-300 bg-white/[0.06] border-white/10',
    };
  }
  if (s.includes('checking')) {
    return {
      label: '校验中',
      code: '校验中',
      dot: 'bg-zinc-200 animate-pulse',
      badge: 'text-zinc-200 bg-white/10 border-white/15',
    };
  }
  if (s.includes('error') || s.includes('missing')) {
    return {
      label: '异常',
      code: '异常',
      dot: 'bg-rose-400',
      badge: 'text-rose-200 bg-rose-500/15 border-rose-400/30',
    };
  }
  return {
    label: state,
    code: state,
    dot: 'bg-zinc-400',
    badge: 'text-zinc-300 bg-white/[0.06] border-white/10',
  };
}

export interface BandwidthVerdict {
  rating: string;
  summary: string;
  tier: 'poor' | 'ok' | 'good' | 'excellent';
  tiers: {
    p1080Web: boolean;
    p1080Remux: boolean;
    p4kWeb: boolean;
    p4kRemux: boolean;
  };
}

export function evaluateBandwidth(singleMbps: number, multiMbps: number): BandwidthVerdict {
  const effectiveWeb = singleMbps;
  const effectivePlayer = Math.max(singleMbps, multiMbps * 0.85);

  const p1080Web = effectiveWeb >= 10 || effectivePlayer >= 12;
  const p1080Remux = effectiveWeb >= 32 || effectivePlayer >= 40;
  const p4kWeb = effectiveWeb >= 28 || effectivePlayer >= 35;
  const p4kRemux = effectiveWeb >= 75 || effectivePlayer >= 90;

  if (p4kRemux) {
    return {
      rating: '极佳 · 畅享 4K 原盘与高码率 Remux',
      summary: '单线程与并发吞吐均非常充裕，网页直出与本地播放器均可丝滑播放高码率 4K 原盘。',
      tier: 'excellent',
      tiers: { p1080Web, p1080Remux, p4kWeb, p4kRemux },
    };
  }
  if (p4kWeb) {
    return {
      rating: '优秀 · 流畅 4K 流媒体与 1080P 高码率',
      summary: '可稳定播放 1080P Remux 与 4K Web-DL；超高码率 4K 原盘建议使用本地播放器缓冲。',
      tier: 'good',
      tiers: { p1080Web, p1080Remux, p4kWeb, p4kRemux },
    };
  }
  if (p1080Web) {
    return {
      rating: '良好 · 流畅 1080P 标准片源',
      summary: '常规 1080P（4–10 Mbps）流畅播放；高码率片源建议使用本地播放器或切换更优节点。',
      tier: 'ok',
      tiers: { p1080Web, p1080Remux, p4kWeb, p4kRemux },
    };
  }
  return {
    rating: '偏慢 · 1080P 可能出现缓冲',
    summary: '单线程速率偏低，建议确认服务器已开启 BBR 或切换晚高峰更稳定的节点。',
    tier: 'poor',
    tiers: { p1080Web, p1080Remux, p4kWeb, p4kRemux },
  };
}
