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
  if (mins < 60) return `${mins} 分钟后卸载`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours} 小时 ${remMins} 分后卸载` : `${hours} 小时后卸载`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days} 天 ${remHours} 小时后卸载` : `${days} 天后卸载`;
}

export function translateTorrentState(state: string): { label: string; color: string } {
  const s = state.toLowerCase();
  if (s.includes('downloading') || s === 'forceddl') {
    return { label: '下载中', color: 'text-sky-400 bg-sky-500/15 border-sky-500/30' };
  }
  if (s === 'metadl') {
    return { label: '解析元数据', color: 'text-amber-300 bg-amber-500/15 border-amber-500/30' };
  }
  if (s === 'stalleddl') {
    return { label: '等待连接', color: 'text-amber-400 bg-amber-500/15 border-amber-500/30' };
  }
  if (s.includes('up') || s === 'uploading') {
    return { label: '已完成/做种', color: 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30' };
  }
  if (s.includes('paused') || s.includes('stopped')) {
    return { label: '已暂停', color: 'text-slate-300 bg-slate-500/20 border-slate-500/30' };
  }
  if (s.includes('checking')) {
    return { label: '校验中', color: 'text-indigo-300 bg-indigo-500/15 border-indigo-500/30' };
  }
  if (s.includes('error') || s.includes('missing')) {
    return { label: '异常', color: 'text-rose-400 bg-rose-500/15 border-rose-500/30' };
  }
  return { label: state, color: 'text-slate-300 bg-slate-500/20 border-slate-500/30' };
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
  // Web playback relies primarily on single-thread speed; external players benefit from multi-thread
  const effectiveWeb = singleMbps;
  const effectivePlayer = Math.max(singleMbps, multiMbps * 0.85);

  const p1080Web = effectiveWeb >= 10 || effectivePlayer >= 12;
  const p1080Remux = effectiveWeb >= 32 || effectivePlayer >= 40;
  const p4kWeb = effectiveWeb >= 28 || effectivePlayer >= 35;
  const p4kRemux = effectiveWeb >= 75 || effectivePlayer >= 90;

  if (p4kRemux) {
    return {
      rating: '极佳 · 畅享 4K 原盘/Remux',
      summary: '当前节点单线程与并发均非常充裕，网页与本地播放器通吃 4K 高码率原盘。',
      tier: 'excellent',
      tiers: { p1080Web, p1080Remux, p4kWeb, p4kRemux },
    };
  }
  if (p4kWeb) {
    return {
      rating: '优秀 · 流畅 4K 流媒体 & 1080p 高码率',
      summary: '可稳定播放 1080p Remux 与 4K Web-DL/压制版；超高码率 4K 原盘建议用本地播放器缓冲。',
      tier: 'good',
      tiers: { p1080Web, p1080Remux, p4kWeb, p4kRemux },
    };
  }
  if (p1080Web) {
    return {
      rating: '良好 · 流畅 1080p 流媒体',
      summary: '常规 1080p（4–10 Mbps）可流畅观看；高码率片源建议使用本地播放器或切换更优节点。',
      tier: 'ok',
      tiers: { p1080Web, p1080Remux, p4kWeb, p4kRemux },
    };
  }
  return {
    rating: '偏慢 · 1080p 可能卡顿',
    summary: '单线程速度偏低，建议检查服务器是否开启 BBR、避开晚高峰或切换中转节点后再试。',
    tier: 'poor',
    tiers: { p1080Web, p1080Remux, p4kWeb, p4kRemux },
  };
}
