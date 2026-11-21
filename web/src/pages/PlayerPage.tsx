import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  Copy,
  Check,
  Trash2,
  Pin,
  CheckCircle2,
  Subtitles,
  Volume2,
  AlertCircle,
  Film,
  Upload,
  SkipForward,
  Keyboard,
  Activity,
  Maximize2,
  Minimize2,
  SlidersHorizontal,
  RotateCcw,
  X,
  Search,
  Download,
  Loader2,
  Sparkles,
} from 'lucide-react';
import type {
  DownloadLiveStatus,
  OnlineSubtitleResult,
  OnlineSubtitleSearchResponse,
  ProbeResponse,
  SubtitleTrack,
  TorrentFileItem,
} from '../types';
import {
  apiFetch,
  formatBytes,
  formatCountdown,
  formatDuration,
  formatSpeed,
  parseMediaTitle,
} from '../lib/api';

interface PlayerPageProps {
  torrentHash: string;
  fileIndex: number;
  torrentName: string;
  onBack: () => void;
  onSelectEpisode: (fileIndex: number) => void;
  onDataChanged: () => void;
}

interface ParsedVttCue {
  start: number;
  end: number;
  lines: string[];
  alignTop: boolean;
}

interface SubStylePrefs {
  fontSizePx: number;      // 14 - 52
  bottomPct: number;       // 4 - 42 (%)
  color: string;           // hex color
  fontWeight: 400 | 500 | 600 | 700;
  strokeStrength: 0 | 1 | 2 | 3;
  bgOpacity: number;       // 0 - 85 (%)
  secondaryScale: number;  // 60 - 100 (%)
  zhOnly: boolean;
  swapBilingual: boolean;
}

const SUB_STYLE_STORAGE_KEY = 'cloudvideo_sub_style_v2';

const DEFAULT_SUB_STYLE: SubStylePrefs = {
  fontSizePx: 22,
  bottomPct: 10,
  color: '#FFFFFF',
  fontWeight: 600,
  strokeStrength: 2,
  bgOpacity: 0,
  secondaryScale: 80,
  zhOnly: false,
  swapBilingual: false,
};

const SUB_COLOR_SWATCHES = [
  { label: '纯净白', hex: '#FFFFFF' },
  { label: '经典黄', hex: '#FDE68A' },
  { label: '柔灰白', hex: '#E4E4E7' },
  { label: '冰河蓝', hex: '#BAE6FD' },
  { label: '薄荷青', hex: '#A7F3D0' },
];

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function loadSubStylePrefs(): SubStylePrefs {
  try {
    const raw = localStorage.getItem(SUB_STYLE_STORAGE_KEY);
    if (!raw) return DEFAULT_SUB_STYLE;
    const p = JSON.parse(raw) as Partial<SubStylePrefs>;
    const fw = p.fontWeight === 400 || p.fontWeight === 500 || p.fontWeight === 600 || p.fontWeight === 700
      ? p.fontWeight
      : 600;
    const st = p.strokeStrength === 0 || p.strokeStrength === 1 || p.strokeStrength === 2 || p.strokeStrength === 3
      ? p.strokeStrength
      : 2;
    return {
      fontSizePx: clampNum(p.fontSizePx, 14, 52, DEFAULT_SUB_STYLE.fontSizePx),
      bottomPct: clampNum(p.bottomPct, 4, 42, DEFAULT_SUB_STYLE.bottomPct),
      color: typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : '#FFFFFF',
      fontWeight: fw,
      strokeStrength: st,
      bgOpacity: clampNum(p.bgOpacity, 0, 85, DEFAULT_SUB_STYLE.bgOpacity),
      secondaryScale: clampNum(p.secondaryScale, 60, 100, DEFAULT_SUB_STYLE.secondaryScale),
      zhOnly: Boolean(p.zhOnly),
      swapBilingual: Boolean(p.swapBilingual),
    };
  } catch {
    return DEFAULT_SUB_STYLE;
  }
}

function buildSubtitleTextShadow(strength: 0 | 1 | 2 | 3): string {
  if (strength === 0) return '0 1px 4px rgba(0, 0, 0, 0.75)';
  if (strength === 1) {
    return '0 2px 5px rgba(0,0,0,0.9), 1px 1px 0 rgba(0,0,0,0.85), -1px -1px 0 rgba(0,0,0,0.85), 1px -1px 0 rgba(0,0,0,0.85), -1px 1px 0 rgba(0,0,0,0.85)';
  }
  if (strength === 2) {
    return '0 2px 7px rgba(0,0,0,0.95), 0 0 12px rgba(0,0,0,0.85), 1.5px 1.5px 0 rgba(0,0,0,0.95), -1.5px -1.5px 0 rgba(0,0,0,0.95), 1.5px -1.5px 0 rgba(0,0,0,0.95), -1.5px 1.5px 0 rgba(0,0,0,0.95), 0 1.5px 0 rgba(0,0,0,0.95), 0 -1.5px 0 rgba(0,0,0,0.95)';
  }
  return '0 3px 10px rgba(0,0,0,1), 0 0 16px rgba(0,0,0,0.95), 2px 2px 0 rgba(0,0,0,1), -2px -2px 0 rgba(0,0,0,1), 2px -2px 0 rgba(0,0,0,1), -2px 2px 0 rgba(0,0,0,1), 0 2px 0 rgba(0,0,0,1), 0 -2px 0 rgba(0,0,0,1), 2px 0 0 rgba(0,0,0,1), -2px 0 0 rgba(0,0,0,1)';
}

function parseVttTimeSec(ts: string): number {
  const parts = ts.trim().replace(',', '.').split(':');
  const sec = Number(parts.pop() || '0');
  const min = Number(parts.pop() || '0');
  const hr = parts.length > 0 ? Number(parts.pop() || '0') : 0;
  return Number.isFinite(sec + min + hr) ? hr * 3600 + min * 60 + sec : 0;
}

function parseWebVttCues(vtt: string): ParsedVttCue[] {
  const normalized = vtt.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const cues: ParsedVttCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const m = lines[timeIdx]
      .trim()
      .match(
        /^(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})(.*)$/
      );
    if (!m) continue;
    const start = parseVttTimeSec(m[1]);
    const end = parseVttTimeSec(m[2]);
    if (end <= start) continue;

    const settings = m[3] || '';
    const alignTop = /\bline:\s*(?:[0-9]|1[0-9]|20)%/i.test(settings);
    const textLines = lines
      .slice(timeIdx + 1)
      .map((l) =>
        l
          .replace(/\{[^}]*\}/g, '')
          .replace(/<\/?[^>]+>/g, '')
          .trim()
      )
      .filter(Boolean);

    if (textLines.length === 0) continue;
    cues.push({ start, end, lines: textLines, alignTop });
  }
  return cues;
}

function isJapaneseOrLatinLine(line: string): boolean {
  // Japanese Kana present -> Japanese line
  if (/[\u3040-\u30ff]/.test(line)) return true;
  // Pure Latin/punctuation without CJK -> English/Romanized line
  if (/[a-zA-Z]{2,}/.test(line) && !/[\u4e00-\u9fff]/.test(line)) return true;
  return false;
}

function isChinesePrimaryLine(line: string): boolean {
  return /[\u4e00-\u9fff]/.test(line) && !/[\u3040-\u30ff]/.test(line);
}

function shiftVttTimestamps(vtt: string, offsetSec: number): string {
  if (!offsetSec) return vtt;
  const parseTs = (ts: string) => {
    const parts = ts.split(':');
    const secPart = parts.pop() || '0';
    const minPart = parts.pop() || '0';
    const hrPart = parts.pop() || '0';
    return Number(hrPart) * 3600 + Number(minPart) * 60 + Number(secPart);
  };
  const fmtTs = (sec: number) => {
    const clamped = Math.max(0, sec);
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    const s = clamped % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
  };
  return vtt.replace(
    /(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/g,
    (_m, a, b) => `${fmtTs(parseTs(a) + offsetSec)} --> ${fmtTs(parseTs(b) + offsetSec)}`
  );
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export const PlayerPage: React.FC<PlayerPageProps> = ({
  torrentHash,
  fileIndex,
  torrentName,
  onBack,
  onSelectEpisode,
  onDataChanged,
}) => {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const subInputRef = useRef<HTMLInputElement | null>(null);
  const [probeData, setProbeData] = useState<ProbeResponse | null>(null);
  const [liveDownload, setLiveDownload] = useState<DownloadLiveStatus | null>(null);
  const [episodes, setEpisodes] = useState<TorrentFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [directPlaybackError, setDirectPlaybackError] = useState(false);
  // Default ALWAYS to native direct stream ('direct')
  const [mode, setMode] = useState<'direct' | 'remux'>('direct');
  const [audioTrack, setAudioTrack] = useState(0);
  const [selectedSubId, setSelectedSubId] = useState<string>('');
  const [subOffsetSec, setSubOffsetSec] = useState(0);
  const [subBlobUrl, setSubBlobUrl] = useState<string>('');
  const [parsedCues, setParsedCues] = useState<ParsedVttCue[]>([]);
  const [subStyle, setSubStyle] = useState<SubStylePrefs>(loadSubStylePrefs);
  const [showSubStylePanel, setShowSubStylePanel] = useState(false);
  const [stageFullscreen, setStageFullscreen] = useState(false);
  const [nativeVideoFullscreen, setNativeVideoFullscreen] = useState(false);
  const [uploadingSub, setUploadingSub] = useState(false);
  // Online subtitle search & 1-click mount state
  const [showOnlineSubModal, setShowOnlineSubModal] = useState(false);
  const [onlineSubQuery, setOnlineSubQuery] = useState('');
  const [onlineSubLang, setOnlineSubLang] = useState<'zh' | 'all'>('zh');
  const [onlineSubLoading, setOnlineSubLoading] = useState(false);
  const [onlineSubData, setOnlineSubData] = useState<OnlineSubtitleSearchResponse | null>(null);
  const [onlineSubError, setOnlineSubError] = useState('');
  const [downloadingSubId, setDownloadingSubId] = useState<string>('');
  const [playbackRate, setPlaybackRate] = useState(1);
  const [remuxOffset, setRemuxOffset] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const [showNextPrompt, setShowNextPrompt] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Touch gesture HUD state (double-tap ±10s, long-press 2x, horizontal swipe seek)
  const [gestureHud, setGestureHud] = useState<string>('');
  const [longPress2x, setLongPress2x] = useState(false);
  const lastReportRef = useRef<number>(0);
  const initialResumeDoneRef = useRef<boolean>(false);
  const gestureHudTimerRef = useRef<number | null>(null);
  const touchStateRef = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    baseVideoTime: number;
    swiping: boolean;
    swipeDeltaSec: number;
    longPressTriggered: boolean;
    prevRate: number;
    longPressTimer: number | null;
    lastTapTime: number;
    lastTapZone: 'left' | 'center' | 'right' | null;
  }>({
    startX: 0,
    startY: 0,
    startTime: 0,
    baseVideoTime: 0,
    swiping: false,
    swipeDeltaSec: 0,
    longPressTriggered: false,
    prevRate: 1,
    longPressTimer: null,
    lastTapTime: 0,
    lastTapZone: null,
  });

  const flashGestureHud = useCallback((label: string) => {
    setGestureHud(label);
    if (gestureHudTimerRef.current) window.clearTimeout(gestureHudTimerRef.current);
    gestureHudTimerRef.current = window.setTimeout(() => setGestureHud(''), 900);
  }, []);

  const seekBySeconds = useCallback(
    (deltaSec: number) => {
      const v = videoRef.current;
      if (!v) return;
      if (mode === 'direct') {
        const dur = Number.isFinite(v.duration) ? v.duration : Infinity;
        v.currentTime = Math.min(dur, Math.max(0, v.currentTime + deltaSec));
      } else {
        const nextSec = Math.max(0, Math.floor(remuxOffset + v.currentTime + deltaSec));
        setRemuxOffset(nextSec);
        setCurrentTime(nextSec);
      }
    },
    [mode, remuxOffset]
  );

  const handleVideoTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    // Leave bottom 58px untouched so native <video controls> remain 100% responsive
    if (touch.clientY > rect.bottom - 58) return;

    const st = touchStateRef.current;
    st.startX = touch.clientX;
    st.startY = touch.clientY;
    st.startTime = Date.now();
    st.baseVideoTime =
      mode === 'remux'
        ? remuxOffset + (videoRef.current?.currentTime || 0)
        : videoRef.current?.currentTime || 0;
    st.swiping = false;
    st.swipeDeltaSec = 0;
    st.longPressTriggered = false;

    if (st.longPressTimer) window.clearTimeout(st.longPressTimer);
    st.longPressTimer = window.setTimeout(() => {
      const v = videoRef.current;
      if (!v || st.swiping) return;
      st.longPressTriggered = true;
      st.prevRate = v.playbackRate;
      v.playbackRate = 2;
      setLongPress2x(true);
    }, 360);
  };

  const handleVideoTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    const st = touchStateRef.current;
    if (!st.startTime) return;
    const touch = e.touches[0];
    const dx = touch.clientX - st.startX;
    const dy = touch.clientY - st.startY;

    if (!st.swiping && Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      st.swiping = true;
      if (st.longPressTimer) {
        window.clearTimeout(st.longPressTimer);
        st.longPressTimer = null;
      }
    }

    if (st.swiping) {
      // ~1 second per 3.5px of horizontal drag
      const delta = Math.round(dx / 3.5);
      st.swipeDeltaSec = delta;
      const target = Math.max(0, st.baseVideoTime + delta);
      setGestureHud(
        `${delta >= 0 ? `+${delta}` : delta} 秒 · ${formatDuration(target)}`
      );
    }
  };

  const handleVideoTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    const st = touchStateRef.current;
    if (st.longPressTimer) {
      window.clearTimeout(st.longPressTimer);
      st.longPressTimer = null;
    }

    if (st.longPressTriggered) {
      if (videoRef.current) videoRef.current.playbackRate = st.prevRate || playbackRate;
      setLongPress2x(false);
      st.longPressTriggered = false;
      st.startTime = 0;
      return;
    }

    if (st.swiping) {
      const delta = st.swipeDeltaSec;
      st.swiping = false;
      st.startTime = 0;
      setGestureHud('');
      if (Math.abs(delta) >= 2) {
        seekBySeconds(delta);
        flashGestureHud(delta > 0 ? `快进 ${delta} 秒` : `快退 ${Math.abs(delta)} 秒`);
      }
      return;
    }

    if (!st.startTime) return;
    const elapsed = Date.now() - st.startTime;
    st.startTime = 0;
    if (elapsed > 260) return;

    const changed = e.changedTouches[0];
    if (!changed) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (changed.clientY > rect.bottom - 58) return;

    const relX = (changed.clientX - rect.left) / Math.max(1, rect.width);
    const zone: 'left' | 'center' | 'right' =
      relX < 0.35 ? 'left' : relX > 0.65 ? 'right' : 'center';

    const now = Date.now();
    if (now - st.lastTapTime < 300 && st.lastTapZone === zone) {
      st.lastTapTime = 0;
      st.lastTapZone = null;
      if (zone === 'left') {
        seekBySeconds(-10);
        flashGestureHud('« 快退 10 秒');
      } else if (zone === 'right') {
        seekBySeconds(10);
        flashGestureHud('快进 10 秒 »');
      } else {
        const v = videoRef.current;
        if (v) {
          if (v.paused) {
            void v.play();
            flashGestureHud('继续播放');
          } else {
            v.pause();
            flashGestureHud('已暂停');
          }
        }
      }
    } else {
      st.lastTapTime = now;
      st.lastTapZone = zone;
    }
  };

  const loadMedia = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');
    setDirectPlaybackError(false);
    setShowNextPrompt(false);
    initialResumeDoneRef.current = false;
    setMode('direct');
    setRemuxOffset(0);
    setCurrentTime(0);
    setSubOffsetSec(0);
    setOnlineSubData(null);
    setOnlineSubQuery('');
    setOnlineSubError('');

    try {
      const [probe, fileList] = await Promise.all([
        apiFetch<ProbeResponse>(
          `/api/stream/${encodeURIComponent(torrentHash)}/${fileIndex}/probe`
        ),
        apiFetch<{ files: TorrentFileItem[] }>(
          `/api/torrents/${encodeURIComponent(torrentHash)}/files`
        ).catch(() => ({ files: [] })),
      ]);

      setProbeData(probe);
      setLiveDownload(probe.downloadStatus ?? null);
      const sortedEps = [...fileList.files]
        .filter((f) => f.isVideo)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      setEpisodes(sortedEps);
      setAudioTrack(0);
      setSelectedSubId(probe.probe.subtitles[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载影片信息失败');
    } finally {
      setLoading(false);
    }
  }, [torrentHash, fileIndex]);

  useEffect(() => {
    void loadMedia();
  }, [loadMedia]);

  useEffect(() => {
    if (!liveDownload || liveDownload.fileProgress >= 0.999) return;
    const id = setInterval(async () => {
      try {
        const st = await apiFetch<DownloadLiveStatus>(
          `/api/stream/${encodeURIComponent(torrentHash)}/${fileIndex}/status`
        );
        setLiveDownload(st);
      } catch {
        // ignore
      }
    }, 4000);
    return () => clearInterval(id);
  }, [liveDownload, torrentHash, fileIndex]);

  const activeSub = useMemo(
    () => probeData?.probe.subtitles.find((s) => s.id === selectedSubId) || null,
    [probeData, selectedSubId]
  );

  const updateSubStyle = useCallback((patch: Partial<SubStylePrefs>) => {
    setSubStyle((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SUB_STYLE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage quota
      }
      return next;
    });
  }, []);

  // Track stage fullscreen vs native <video> fullscreen so subtitles never duplicate
  useEffect(() => {
    const syncFs = () => {
      const fsEl = document.fullscreenElement;
      setStageFullscreen(Boolean(fsEl && fsEl === stageRef.current));
      setNativeVideoFullscreen(Boolean(fsEl && fsEl === videoRef.current));
    };
    document.addEventListener('fullscreenchange', syncFs);
    return () => document.removeEventListener('fullscreenchange', syncFs);
  }, []);

  // Keep native <track> hidden while Custom Cinema Overlay is active; show in native <video> fullscreen
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !v.textTracks) return;
    for (let i = 0; i < v.textTracks.length; i++) {
      v.textTracks[i].mode = nativeVideoFullscreen ? 'showing' : 'hidden';
    }
  }, [nativeVideoFullscreen, subBlobUrl, mode, audioTrack, remuxOffset]);

  // Higher-precision subtitle clock (100ms) while video plays for crisp anime dialogue timing
  useEffect(() => {
    if (parsedCues.length === 0) return;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || v.paused) return;
      const t = mode === 'remux' ? remuxOffset + v.currentTime : v.currentTime;
      setCurrentTime(t);
    }, 100);
    return () => window.clearInterval(id);
  }, [parsedCues.length, mode, remuxOffset]);

  // Fetch & parse active subtitle into clean cues (+ keep shifted blob URL for native fullscreen fallback)
  useEffect(() => {
    let revokedUrl = '';
    let cancelled = false;

    if (!activeSub) {
      setSubBlobUrl('');
      setParsedCues([]);
      return;
    }

    (async () => {
      try {
        const res = await fetch(activeSub.url, { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const rawVtt = await res.text();
        if (cancelled) return;

        setParsedCues(parseWebVttCues(rawVtt));

        if (subOffsetSec === 0) {
          setSubBlobUrl(activeSub.url);
        } else {
          const shifted = shiftVttTimestamps(rawVtt, subOffsetSec);
          const blob = new Blob([shifted], { type: 'text/vtt' });
          revokedUrl = URL.createObjectURL(blob);
          setSubBlobUrl(revokedUrl);
        }
      } catch {
        if (!cancelled) {
          setSubBlobUrl(activeSub.url);
          setParsedCues([]);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (revokedUrl) URL.revokeObjectURL(revokedUrl);
    };
  }, [activeSub, subOffsetSec]);

  const toggleStageFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (stageRef.current?.requestFullscreen) {
      void stageRef.current.requestFullscreen();
    } else {
      void videoRef.current?.requestFullscreen?.();
    }
  }, []);

  const activeSubtitleCues = useMemo(() => {
    if (!activeSub || parsedCues.length === 0 || nativeVideoFullscreen) return [];
    // Offset: +0.5s means subtitles show 0.5s later -> lookup at currentTime - offset
    const t = currentTime - subOffsetSec;
    const matched = parsedCues.filter((c) => t >= c.start && t <= c.end);
    if (matched.length <= 1) return matched;

    // Runtime final deduplication safety net across overlapping cues
    const seen = new Set<string>();
    const unique: ParsedVttCue[] = [];
    for (const c of matched) {
      const k = `${c.alignTop ? 'T' : 'B'}:${c.lines.join('\n').replace(/\s+/g, '').toLowerCase()}`;
      if (!seen.has(k)) {
        seen.add(k);
        unique.push(c);
      }
    }
    return unique;
  }, [activeSub, parsedCues, currentTime, subOffsetSec, nativeVideoFullscreen]);

  const nextEpisode = useMemo(() => {
    const curPos = episodes.findIndex((e) => e.index === fileIndex);
    if (curPos === -1 || curPos >= episodes.length - 1) return null;
    return episodes[curPos + 1];
  }, [episodes, fileIndex]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showOnlineSubModal) {
        setShowOnlineSubModal(false);
        return;
      }
      if (showOnlineSubModal) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      const v = videoRef.current;
      if (!v) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (mode === 'direct') v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10);
        else setRemuxOffset((o) => Math.floor(o + v.currentTime + 10));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (mode === 'direct') v.currentTime = Math.max(0, v.currentTime - 10);
        else setRemuxOffset((o) => Math.max(0, Math.floor(o + v.currentTime - 10)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        v.volume = Math.min(1, Number((v.volume + 0.1).toFixed(2)));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        v.volume = Math.max(0, Number((v.volume - 0.1).toFixed(2)));
      } else if (e.key.toLowerCase() === 'm') {
        v.muted = !v.muted;
      } else if (e.key.toLowerCase() === 'f') {
        toggleStageFullscreen();
      } else if (e.key === ']') {
        const idx = SPEEDS.indexOf(playbackRate);
        const next = SPEEDS[Math.min(SPEEDS.length - 1, (idx === -1 ? 1 : idx) + 1)];
        v.playbackRate = next;
        setPlaybackRate(next);
      } else if (e.key === '[') {
        const idx = SPEEDS.indexOf(playbackRate);
        const next = SPEEDS[Math.max(0, (idx === -1 ? 1 : idx) - 1)];
        v.playbackRate = next;
        setPlaybackRate(next);
      } else if (e.key.toLowerCase() === 'n' && nextEpisode?.existsOnDisk) {
        onSelectEpisode(nextEpisode.index);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, playbackRate, nextEpisode, onSelectEpisode, showOnlineSubModal, toggleStageFullscreen]);

  const reportProgress = useCallback(
    async (posSec: number, force = false) => {
      if (!probeData) return;
      const now = Date.now();
      if (!force && now - lastReportRef.current < 10_000) return;
      lastReportRef.current = now;

      const duration = probeData.probe.durationSec || videoRef.current?.duration || 0;
      if (!Number.isFinite(duration) || duration <= 0) return;

      try {
        const res = await apiFetch<{
          item: ProbeResponse['mediaItem'];
          unloadedImmediately: boolean;
          preloadedNext?: { preloadedIndex: number; preloadedName: string } | null;
        }>('/api/media/progress', {
          method: 'POST',
          body: JSON.stringify({
            torrentHash,
            fileIndex,
            positionSec: posSec,
            durationSec: duration,
            relativePath: probeData.relativePath,
            sizeBytes: probeData.sizeBytes,
          }),
        });
        setProbeData((prev) => (prev ? { ...prev, mediaItem: res.item } : prev));
        if (res.preloadedNext) {
          const epName = res.preloadedNext.preloadedName.split('/').pop();
          setNotice(`追剧托管已自动预载下一集：${epName}`);
          onDataChanged();
        } else if (res.unloadedImmediately) {
          setNotice('已达看完阈值，已自动卸载释放硬盘空间。');
          onDataChanged();
        } else if (res.item.deleteAfterAt) {
          setNotice(`已标记看完，${formatCountdown(res.item.deleteAfterAt)}（可点击锁定保留）`);
        }
      } catch {
        // ignore
      }
    },
    [probeData, torrentHash, fileIndex, onDataChanged]
  );

  const handleVideoLoaded = () => {
    const v = videoRef.current;
    if (!v || !probeData) return;
    v.playbackRate = playbackRate;
    if (initialResumeDoneRef.current) return;
    initialResumeDoneRef.current = true;
    const resumeSec = probeData.mediaItem?.positionSec || 0;
    const dur = probeData.probe.durationSec || v.duration || 0;
    if (mode === 'direct' && resumeSec > 5 && (dur === 0 || resumeSec < dur * 0.95)) {
      v.currentTime = resumeSec;
    }
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    const actualTime = mode === 'remux' ? remuxOffset + v.currentTime : v.currentTime;
    setCurrentTime(actualTime);
    void reportProgress(actualTime, false);

    const dur = probeData?.probe.durationSec || v.duration || 0;
    if (nextEpisode?.existsOnDisk && dur > 30 && dur - actualTime <= 20) {
      setShowNextPrompt(true);
    }
  };

  const handleSubtitleUpload = async (file: File) => {
    setUploadingSub(true);
    setNotice('');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch<{ ok: boolean; subtitle: SubtitleTrack }>(
        `/api/stream/${encodeURIComponent(torrentHash)}/${fileIndex}/subtitle/upload`,
        { method: 'POST', body: form }
      );
      setProbeData((prev) =>
        prev
          ? {
              ...prev,
              probe: {
                ...prev.probe,
                subtitles: [res.subtitle, ...prev.probe.subtitles],
              },
            }
          : prev
      );
      setSelectedSubId(res.subtitle.id);
      setSubOffsetSec(0);
      setNotice(`已加载字幕：${file.name}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '字幕上传失败');
    } finally {
      setUploadingSub(false);
    }
  };

  const searchOnlineSubtitles = useCallback(
    async (overrideQuery?: string, overrideLang?: 'zh' | 'all') => {
      setOnlineSubLoading(true);
      setOnlineSubError('');
      try {
        const params = new URLSearchParams();
        const qVal = overrideQuery !== undefined ? overrideQuery.trim() : onlineSubQuery.trim();
        const langVal = overrideLang ?? onlineSubLang;
        if (qVal) params.set('q', qVal);
        params.set('lang', langVal);

        const res = await apiFetch<OnlineSubtitleSearchResponse>(
          `/api/stream/${encodeURIComponent(torrentHash)}/${fileIndex}/subtitles/search?${params.toString()}`
        );
        setOnlineSubData(res);
        if (!qVal && res.query) {
          setOnlineSubQuery(res.query);
        }
      } catch (err) {
        setOnlineSubError(err instanceof Error ? err.message : '在线搜索字幕失败');
      } finally {
        setOnlineSubLoading(false);
      }
    },
    [torrentHash, fileIndex, onlineSubQuery, onlineSubLang]
  );

  const openOnlineSubModal = () => {
    setShowOnlineSubModal(true);
    setOnlineSubError('');
    if (!onlineSubData) {
      void searchOnlineSubtitles('', onlineSubLang);
    }
  };

  const handleDownloadOnlineSub = async (item: OnlineSubtitleResult) => {
    setDownloadingSubId(item.id);
    setOnlineSubError('');
    try {
      const res = await apiFetch<{ ok: boolean; subtitle: SubtitleTrack }>(
        `/api/stream/${encodeURIComponent(torrentHash)}/${fileIndex}/subtitles/download`,
        {
          method: 'POST',
          body: JSON.stringify({
            provider: item.provider,
            providerId: item.providerId,
            title: item.title,
            downloadUrl: item.downloadUrl,
            fileHint: item.fileHint,
          }),
        }
      );
      setProbeData((prev) =>
        prev
          ? {
              ...prev,
              probe: {
                ...prev.probe,
                subtitles: [res.subtitle, ...prev.probe.subtitles],
              },
            }
          : prev
      );
      setSelectedSubId(res.subtitle.id);
      setSubOffsetSec(0);
      setShowOnlineSubModal(false);
      setNotice(`已在线挂载字幕（${item.providerLabel}）：${item.title}`);
    } catch (err) {
      setOnlineSubError(err instanceof Error ? err.message : '在线下载挂载字幕失败');
    } finally {
      setDownloadingSubId('');
    }
  };

  const switchToRemux = (startAt = currentTime) => {
    setDirectPlaybackError(false);
    setRemuxOffset(Math.max(0, Math.floor(startAt)));
    setMode('remux');
  };

  const switchToDirect = () => {
    setDirectPlaybackError(false);
    setMode('direct');
  };

  const handleCopyDirectUrl = async () => {
    if (!probeData) return;
    await navigator.clipboard.writeText(probeData.urls.direct);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleMarkWatched = async (immediate: boolean, thenPlayNext = false) => {
    if (!probeData) return;
    if (immediate && !thenPlayNext && !confirm('确定立即标记已看并卸载该视频释放空间？')) return;
    try {
      const res = await apiFetch<{
        item: ProbeResponse['mediaItem'] | null;
        unloadedImmediately: boolean;
      }>(`/api/media/${encodeURIComponent(torrentHash)}/${fileIndex}/watched`, {
        method: 'POST',
        body: JSON.stringify({
          immediate,
          relativePath: probeData.relativePath,
          sizeBytes: probeData.sizeBytes,
        }),
      });
      onDataChanged();
      if (thenPlayNext && nextEpisode?.existsOnDisk) {
        onSelectEpisode(nextEpisode.index);
        return;
      }
      if (res.unloadedImmediately) {
        onBack();
      } else if (res.item) {
        setProbeData((prev) => (prev ? { ...prev, mediaItem: res.item! } : prev));
        setNotice(`已标记看完，${formatCountdown(res.item.deleteAfterAt)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleTogglePin = async () => {
    if (!probeData) return;
    const nextPinned = !probeData.mediaItem.pinned;
    const res = await apiFetch<{ item: ProbeResponse['mediaItem'] }>(
      `/api/media/${encodeURIComponent(torrentHash)}/${fileIndex}/pin`,
      {
        method: 'POST',
        body: JSON.stringify({
          pinned: nextPinned,
          relativePath: probeData.relativePath,
          sizeBytes: probeData.sizeBytes,
        }),
      }
    );
    setProbeData((prev) => (prev ? { ...prev, mediaItem: res.item } : prev));
    setNotice(nextPinned ? '已锁定，自动清理将跳过本片' : '已取消锁定');
    onDataChanged();
  };

  const streamSrc = probeData
    ? mode === 'direct'
      ? probeData.urls.direct
      : `${probeData.urls.remux}&start=${remuxOffset}&audio=${audioTrack}`
    : '';

  const totalDuration = probeData?.probe.durationSec || 0;
  const parsed = probeData ? parseMediaTitle(probeData.fileName) : null;
  const dlMbps = liveDownload ? Number(((liveDownload.dlSpeed * 8) / 1_000_000).toFixed(1)) : 0;
  const isBufferingLive = liveDownload && liveDownload.fileProgress < 0.999;
  const dlFastEnough = probeData ? dlMbps >= probeData.probe.requiredMbps : true;

  return (
    <div className="space-y-5">
      {/* Quiet Top Bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button onClick={onBack} className="btn-ghost px-4 py-2 text-xs">
          <ArrowLeft className="w-3.5 h-3.5" />
          返回影院
        </button>

        <div className="flex items-center gap-2 text-xs flex-wrap">
          {isBufferingLive && (
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border tabular-nums ${
                dlFastEnough
                  ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-amber-400/30 bg-amber-500/10 text-amber-200'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              边下边播 {(liveDownload.fileProgress * 100).toFixed(1)}% ·{' '}
              {formatSpeed(liveDownload.dlSpeed)}
              {!dlFastEnough && probeData ? `（建议 ≥ ${probeData.probe.requiredMbps} Mbps）` : ''}
            </span>
          )}
          <span className="px-3 py-1.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-zinc-200">
            {mode === 'direct' ? '原生直出' : '无损 Remux'}
          </span>
          {probeData && (
            <button
              onClick={openOnlineSubModal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border border-sky-400/30 bg-sky-500/15 hover:bg-sky-500/25 text-sky-100 transition"
            >
              <Search className="w-3.5 h-3.5" />
              在线搜字幕
            </button>
          )}
          {selectedSubId && (
            <button
              onClick={() => setShowSubStylePanel((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition ${
                showSubStylePanel
                  ? 'bg-white text-zinc-950 border-white font-medium'
                  : 'bg-white/[0.07] text-zinc-100 border-white/[0.09] hover:bg-white/[0.13]'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              字幕调整
            </button>
          )}
          <button
            onClick={toggleStageFullscreen}
            title="支持高级字幕与手势的影院全屏 (快捷键 F)"
            className="btn-ghost px-3 py-1.5 text-xs"
          >
            {stageFullscreen ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
            {stageFullscreen ? '退出全屏' : '影院全屏'}
          </button>
          <button
            onClick={() => setShowShortcuts((s) => !s)}
            className="btn-ghost px-3 py-1.5 text-xs"
          >
            <Keyboard className="w-3.5 h-3.5" />
            快捷键
          </button>
        </div>
      </div>

      {showShortcuts && (
        <div className="cinema-surface rounded-2xl px-4 py-3 text-xs text-zinc-300 flex items-center gap-4 flex-wrap">
          <span>
            <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white mr-1">Space</kbd> 播放/暂停
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white mr-1">← / →</kbd> 快进/退 10 秒
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white mr-1">↑ / ↓</kbd> 音量
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white mr-1">[ / ]</kbd> 倍速
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white mr-1">F</kbd> 全屏
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white mr-1">M</kbd> 静音
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white mr-1">N</kbd> 下一集
          </span>
          <span className="text-zinc-500 hidden sm:inline">|</span>
          <span className="text-zinc-400">
            触屏手势：双击左右 ±10 秒 · 双击中间播/停 · 长按 2 倍速 · 左右滑动调进度
          </span>
        </div>
      )}

      {loading ? (
        <div className="cinema-surface rounded-3xl p-20 text-center">
          <div className="text-sm text-white animate-pulse">正在准备影片流...</div>
          <div className="text-xs text-zinc-500 mt-1.5">解析编码、音轨与字幕中</div>
        </div>
      ) : error ? (
        <div className="rounded-3xl border border-rose-500/30 bg-rose-500/10 p-6 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-medium text-rose-200">无法启动播放</div>
            <p className="text-xs text-rose-200/80 mt-1">{error}</p>
            <button onClick={() => void loadMedia()} className="btn-ivory mt-3 px-4 py-1.5 text-xs">
              重试
            </button>
          </div>
        </div>
      ) : probeData ? (
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
          {/* Cinema Stage */}
          <div className={episodes.length > 1 ? 'xl:col-span-3 space-y-4' : 'xl:col-span-4 space-y-4'}>
            <div
              ref={stageRef}
              className={`overflow-hidden bg-black relative ${
                stageFullscreen
                  ? 'w-screen h-screen flex flex-col justify-center'
                  : 'rounded-3xl border border-white/[0.08] shadow-[0_28px_70px_-20px_rgba(0,0,0,0.95)]'
              }`}
              onTouchStart={handleVideoTouchStart}
              onTouchMove={handleVideoTouchMove}
              onTouchEnd={handleVideoTouchEnd}
            >
              {/* Long-Press 2x Speed Pill */}
              {longPress2x && (
                <div className="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 z-30 px-4 py-1.5 rounded-full bg-black/75 border border-white/20 backdrop-blur-md text-xs font-medium text-white flex items-center gap-1.5 shadow-xl">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                  2.0x 倍速快进中 »
                </div>
              )}

              {/* Double-Tap / Swipe Seek OSD Pill */}
              {gestureHud && !longPress2x && (
                <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 px-5 py-2.5 rounded-full bg-black/75 border border-white/15 backdrop-blur-md text-sm font-medium text-white tabular-nums shadow-2xl">
                  {gestureHud}
                </div>
              )}

              <video
                key={`${mode}-${audioTrack}-${remuxOffset}`}
                ref={videoRef}
                src={streamSrc}
                controls
                autoPlay
                playsInline
                crossOrigin="anonymous"
                onLoadedMetadata={handleVideoLoaded}
                onTimeUpdate={handleTimeUpdate}
                onPause={() => void reportProgress(currentTime, true)}
                onEnded={() => {
                  void reportProgress(totalDuration || currentTime, true);
                  if (nextEpisode?.existsOnDisk) setShowNextPrompt(true);
                }}
                onError={() => {
                  if (mode === 'direct') setDirectPlaybackError(true);
                }}
                className={
                  stageFullscreen
                    ? 'w-full h-full object-contain bg-black'
                    : 'w-full aspect-video bg-black'
                }
              >
                {activeSub && subBlobUrl && (
                  <track
                    key={`${activeSub.id}-${subOffsetSec}`}
                    kind="subtitles"
                    src={subBlobUrl}
                    label={activeSub.title}
                    default={nativeVideoFullscreen}
                  />
                )}
              </video>

              {/* Cinema-Grade Custom Subtitle Overlay (Fine-Grained User-Adjustable Style) */}
              {activeSubtitleCues.length > 0 && (() => {
                const topCues = activeSubtitleCues.filter((c) => c.alignTop);
                const bottomCues = activeSubtitleCues.filter((c) => !c.alignTop);
                const effectiveFontPx = Math.round(
                  subStyle.fontSizePx * (stageFullscreen ? 1.35 : 1)
                );
                const secondaryFontPx = Math.max(
                  11,
                  Math.round(effectiveFontPx * (subStyle.secondaryScale / 100))
                );
                const textShadow = buildSubtitleTextShadow(subStyle.strokeStrength);
                const hasBg = subStyle.bgOpacity > 0;

                const renderCueGroup = (cues: ParsedVttCue[]) => {
                  const allLines = cues.flatMap((c) => c.lines);
                  const hasZh = allLines.some(isChinesePrimaryLine);
                  const hasForeign = allLines.some(isJapaneseOrLatinLine);
                  const isBilingual = hasZh && hasForeign;
                  let visibleLines =
                    isBilingual && subStyle.zhOnly
                      ? allLines.filter((l) => !isJapaneseOrLatinLine(l))
                      : [...allLines];

                  if (isBilingual && !subStyle.zhOnly && subStyle.swapBilingual && visibleLines.length >= 2) {
                    const zhLines = visibleLines.filter((l) => !isJapaneseOrLatinLine(l));
                    const foreignLines = visibleLines.filter(isJapaneseOrLatinLine);
                    // Swap whichever language was originally first
                    visibleLines = isJapaneseOrLatinLine(visibleLines[0])
                      ? [...zhLines, ...foreignLines]
                      : [...foreignLines, ...zhLines];
                  }

                  return (
                    <div
                      className={`inline-flex flex-col items-center gap-0.5 max-w-[92%] text-center leading-snug tracking-wide ${
                        hasBg ? 'px-4 py-1.5 rounded-2xl backdrop-blur-md shadow-lg' : ''
                      }`}
                      style={{
                        backgroundColor: hasBg
                          ? `rgba(9, 9, 11, ${(subStyle.bgOpacity / 100).toFixed(2)})`
                          : 'transparent',
                        textShadow,
                      }}
                    >
                      {visibleLines.map((line, i) => {
                        const isSecondary = isBilingual && isJapaneseOrLatinLine(line);
                        return (
                          <div
                            key={`${i}-${line}`}
                            style={{
                              fontSize: `${isSecondary ? secondaryFontPx : effectiveFontPx}px`,
                              fontWeight: isSecondary
                                ? Math.max(400, subStyle.fontWeight - 100)
                                : subStyle.fontWeight,
                              color: subStyle.color,
                              opacity: isSecondary ? 0.86 : 1,
                            }}
                          >
                            {line}
                          </div>
                        );
                      })}
                    </div>
                  );
                };

                return (
                  <>
                    {topCues.length > 0 && (
                      <div className="pointer-events-none absolute top-4 inset-x-4 z-20 flex justify-center">
                        {renderCueGroup(topCues)}
                      </div>
                    )}
                    {bottomCues.length > 0 && (
                      <div
                        className="pointer-events-none absolute inset-x-4 z-20 flex justify-center transition-[bottom] duration-150"
                        style={{ bottom: `${subStyle.bottomPct}%` }}
                      >
                        {renderCueGroup(bottomCues)}
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Fullscreen Floating Quick Controls (Subtitle Adjust & Exit Fullscreen) */}
              {stageFullscreen && (
                <div className="absolute top-4 right-4 z-30 flex items-center gap-2 opacity-25 hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  {selectedSubId && (
                    <button
                      type="button"
                      onClick={() => setShowSubStylePanel((v) => !v)}
                      className="px-3 py-1.5 rounded-full bg-black/70 border border-white/15 backdrop-blur-md text-xs text-white flex items-center gap-1.5"
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5" />
                      字幕调整
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={toggleStageFullscreen}
                    className="px-3 py-1.5 rounded-full bg-black/70 border border-white/15 backdrop-blur-md text-xs text-white flex items-center gap-1.5"
                  >
                    <Minimize2 className="w-3.5 h-3.5" />
                    退出全屏
                  </button>
                </div>
              )}

              {/* Floating Subtitle Studio Inside Fullscreen */}
              {stageFullscreen && selectedSubId && showSubStylePanel && (
                <div
                  className="absolute top-14 right-4 z-30 w-80 max-w-[92vw] cinema-glass rounded-2xl p-4 space-y-3 text-xs shadow-2xl"
                  onTouchStart={(e) => e.stopPropagation()}
                  onTouchMove={(e) => e.stopPropagation()}
                  onTouchEnd={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-white">字幕实时调整</span>
                    <button
                      type="button"
                      onClick={() => setShowSubStylePanel(false)}
                      className="p-1 rounded-full text-zinc-400 hover:text-white"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-zinc-400 shrink-0">字号 {subStyle.fontSizePx}px</span>
                      <input
                        type="range"
                        min={14}
                        max={52}
                        value={subStyle.fontSizePx}
                        onChange={(e) => updateSubStyle({ fontSizePx: Number(e.target.value) })}
                        className="w-40 accent-white"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-zinc-400 shrink-0">位置 {subStyle.bottomPct}%</span>
                      <input
                        type="range"
                        min={4}
                        max={42}
                        value={subStyle.bottomPct}
                        onChange={(e) => updateSubStyle({ bottomPct: Number(e.target.value) })}
                        className="w-40 accent-white"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-zinc-400 shrink-0">底框 {subStyle.bgOpacity}%</span>
                      <input
                        type="range"
                        min={0}
                        max={85}
                        step={5}
                        value={subStyle.bgOpacity}
                        onChange={(e) => updateSubStyle({ bgOpacity: Number(e.target.value) })}
                        className="w-40 accent-white"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-zinc-400 shrink-0">描边</span>
                      <div className="flex gap-1">
                        {([0, 1, 2, 3] as const).map((lv) => (
                          <button
                            key={lv}
                            type="button"
                            onClick={() => updateSubStyle({ strokeStrength: lv })}
                            className={`px-2 py-0.5 rounded-full ${
                              subStyle.strokeStrength === lv
                                ? 'bg-white text-zinc-950 font-medium'
                                : 'bg-white/[0.08] text-zinc-300'
                            }`}
                          >
                            {['无', '细', '中', '重'][lv]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-zinc-400">颜色</span>
                      <div className="flex items-center gap-1.5">
                        {SUB_COLOR_SWATCHES.map((sw) => (
                          <button
                            key={sw.hex}
                            type="button"
                            title={sw.label}
                            onClick={() => updateSubStyle({ color: sw.hex })}
                            className={`w-5 h-5 rounded-full border ${
                              subStyle.color.toLowerCase() === sw.hex.toLowerCase()
                                ? 'border-white scale-110 ring-2 ring-white/40'
                                : 'border-white/20'
                            }`}
                            style={{ backgroundColor: sw.hex }}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => updateSubStyle({ zhOnly: !subStyle.zhOnly })}
                        className={`px-2.5 py-1 rounded-full border ${
                          subStyle.zhOnly
                            ? 'bg-amber-400/20 border-amber-400/40 text-amber-200'
                            : 'bg-white/[0.06] border-white/10 text-zinc-300'
                        }`}
                      >
                        仅看中文：{subStyle.zhOnly ? '开' : '关'}
                      </button>
                      <button
                        type="button"
                        onClick={() => updateSubStyle({ swapBilingual: !subStyle.swapBilingual })}
                        className={`px-2.5 py-1 rounded-full border ${
                          subStyle.swapBilingual
                            ? 'bg-white/15 border-white/30 text-white'
                            : 'bg-white/[0.06] border-white/10 text-zinc-300'
                        }`}
                      >
                        上下互换
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Floating Next-Episode Card */}
              {showNextPrompt && nextEpisode?.existsOnDisk && (
                <div className="absolute bottom-14 right-4 z-20 cinema-glass rounded-2xl p-4 max-w-xs space-y-3 shadow-2xl">
                  <div className="text-[11px] text-zinc-400">下一集已就绪</div>
                  <div className="text-xs font-medium text-white truncate">
                    {nextEpisode.name.split('/').pop()}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onSelectEpisode(nextEpisode.index)}
                      className="btn-ivory flex-1 py-1.5 text-xs"
                    >
                      <SkipForward className="w-3.5 h-3.5" />
                      立即连播
                    </button>
                    <button
                      onClick={() => void handleMarkWatched(true, true)}
                      className="px-3 py-1.5 rounded-full bg-rose-500/20 hover:bg-rose-500 text-rose-200 hover:text-white text-xs transition"
                      title="卸载本集并播放下一集"
                    >
                      卸本集连播
                    </button>
                  </div>
                </div>
              )}

              {mode === 'remux' && totalDuration > 0 && (
                <div className="bg-[#111115] border-t border-white/[0.08] px-5 py-3 flex items-center gap-3">
                  <span className="text-xs text-zinc-400 shrink-0">进度跳转</span>
                  <span className="text-xs text-zinc-200 tabular-nums shrink-0">
                    {formatDuration(currentTime)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={Math.floor(totalDuration)}
                    value={Math.min(Math.floor(totalDuration), Math.floor(currentTime))}
                    onChange={(e) => {
                      const sec = Number(e.target.value);
                      setRemuxOffset(Math.floor(sec));
                      setCurrentTime(Math.floor(sec));
                    }}
                    className="flex-1 accent-white cursor-pointer"
                  />
                  <span className="text-xs text-zinc-500 tabular-nums shrink-0">
                    {formatDuration(totalDuration)}
                  </span>
                </div>
              )}
            </div>

            {directPlaybackError && mode === 'direct' && (
              <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="text-xs text-amber-200">
                  浏览器不支持直接解码此封装或音轨（{probeData.probe.container.toUpperCase()} /{' '}
                  {probeData.probe.audioCodec.toUpperCase()}），可一键切换无损 Remux 或使用本地播放器打开。
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => switchToRemux(currentTime)}
                    className="btn-ivory px-4 py-1.5 text-xs"
                  >
                    切换无损 Remux
                  </button>
                  <a href={probeData.urls.potplayer} className="btn-ghost px-3.5 py-1.5 text-xs">
                    PotPlayer
                  </a>
                </div>
              </div>
            )}

            {notice && (
              <div className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200 flex items-center justify-between gap-2">
                <span>{notice}</span>
                {probeData.mediaItem.deleteAfterAt && !probeData.mediaItem.pinned && (
                  <button
                    onClick={() => void handleTogglePin()}
                    className="px-3 py-1 rounded-full bg-emerald-400/20 hover:bg-emerald-400/30 text-emerald-100 shrink-0"
                  >
                    锁定保留
                  </button>
                )}
              </div>
            )}

            {/* Controls Card */}
            <div className="cinema-surface rounded-3xl p-6 space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="min-w-0">
                  <h1 className="text-lg sm:text-xl font-semibold text-white break-all">
                    {torrentName || parsed?.title || probeData.fileName}
                  </h1>
                  <div className="text-xs text-zinc-500 mt-1 break-all">{probeData.fileName}</div>
                  <div className="flex items-center gap-2 flex-wrap mt-3 text-xs tabular-nums">
                    <span className="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-200">
                      {probeData.probe.width} × {probeData.probe.height}
                    </span>
                    <span className="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-300 uppercase">
                      {probeData.probe.videoCodec || 'VIDEO'} · {probeData.probe.audioCodec || 'AUDIO'}
                    </span>
                    <span className="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-400">
                      {formatBytes(probeData.sizeBytes)}
                    </span>
                    <span className="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-300">
                      建议带宽 ≥ {probeData.probe.requiredMbps} Mbps
                    </span>
                    {!probeData.probe.canDirectPlay && mode === 'direct' && !directPlaybackError && (
                      <button
                        onClick={() => switchToRemux(currentTime)}
                        className="px-2.5 py-0.5 rounded-full bg-amber-400/15 text-amber-200 hover:bg-amber-400/25 transition"
                      >
                        若无声点此切 Remux
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 flex-wrap">
                  <button
                    onClick={() => void handleTogglePin()}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs border transition ${
                      probeData.mediaItem.pinned
                        ? 'bg-amber-400/15 border-amber-400/35 text-amber-200'
                        : 'bg-white/[0.06] border-white/[0.08] text-zinc-200 hover:bg-white/[0.12]'
                    }`}
                  >
                    <Pin className="w-3.5 h-3.5" />
                    {probeData.mediaItem.pinned ? '已锁定' : '锁定'}
                  </button>
                  <button
                    onClick={() => void handleMarkWatched(false)}
                    className="btn-ghost px-3.5 py-1.5 text-xs"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    标为已看
                  </button>
                  <button
                    onClick={() => void handleMarkWatched(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500 text-rose-200 hover:text-white transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    看完卸载
                  </button>
                </div>
              </div>

              {/* Playback Controls Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pt-5 border-t border-white/[0.07]">
                <div>
                  <div className="text-xs text-zinc-400 mb-2">播放模式</div>
                  <div className="grid grid-cols-2 p-1 rounded-full bg-white/[0.04] border border-white/[0.07]">
                    <button
                      type="button"
                      onClick={switchToDirect}
                      className={`py-1.5 rounded-full text-xs font-medium transition ${
                        mode === 'direct' ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      原生直出
                    </button>
                    <button
                      type="button"
                      onClick={() => switchToRemux(currentTime)}
                      className={`py-1.5 rounded-full text-xs font-medium transition ${
                        mode === 'remux' ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      无损 Remux
                    </button>
                  </div>
                </div>

                <div>
                  <div className="text-xs text-zinc-400 mb-2">倍速</div>
                  <div className="grid grid-cols-5 p-1 rounded-full bg-white/[0.04] border border-white/[0.07]">
                    {SPEEDS.map((sp) => (
                      <button
                        key={sp}
                        type="button"
                        onClick={() => {
                          setPlaybackRate(sp);
                          if (videoRef.current) videoRef.current.playbackRate = sp;
                        }}
                        className={`py-1.5 rounded-full text-[11px] tabular-nums transition ${
                          playbackRate === sp
                            ? 'bg-white text-zinc-950 font-medium'
                            : 'text-zinc-400 hover:text-white'
                        }`}
                      >
                        {sp}x
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-xs text-zinc-400 flex items-center gap-1 mb-2">
                    <Volume2 className="w-3.5 h-3.5" />
                    音轨
                  </label>
                  <select
                    value={audioTrack}
                    onChange={(e) => {
                      setAudioTrack(Number(e.target.value));
                      if (mode !== 'remux') switchToRemux(currentTime);
                    }}
                    className="cinema-input w-full px-3 py-2 text-xs"
                  >
                    {probeData.probe.audioTracks.length === 0 ? (
                      <option value={0}>默认音轨</option>
                    ) : (
                      probeData.probe.audioTracks.map((a) => (
                        <option key={a.index} value={a.index}>
                          {a.title} ({a.codec}, {a.channels}ch)
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs text-zinc-400 mb-2">
                    <span className="flex items-center gap-1">
                      <Subtitles className="w-3.5 h-3.5" />
                      字幕
                    </span>
                    <div className="flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={openOnlineSubModal}
                        className="text-sky-300 hover:text-sky-200 inline-flex items-center gap-1 transition"
                      >
                        <Search className="w-3 h-3" />
                        在线找
                      </button>
                      {selectedSubId && (
                        <button
                          type="button"
                          onClick={() => setShowSubStylePanel((v) => !v)}
                          className={`inline-flex items-center gap-1 transition ${
                            showSubStylePanel ? 'text-white' : 'text-zinc-400 hover:text-white'
                          }`}
                        >
                          <SlidersHorizontal className="w-3 h-3" />
                          样式
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={uploadingSub}
                        onClick={() => subInputRef.current?.click()}
                        className="text-zinc-200 hover:text-white inline-flex items-center gap-1"
                      >
                        <Upload className="w-3 h-3" />
                        {uploadingSub ? '转换中' : '上传'}
                      </button>
                    </div>
                    <input
                      ref={subInputRef}
                      type="file"
                      accept=".srt,.ass,.ssa,.vtt"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleSubtitleUpload(f);
                        e.target.value = '';
                      }}
                    />
                  </div>
                  <select
                    value={selectedSubId}
                    onChange={(e) => {
                      setSelectedSubId(e.target.value);
                      setSubOffsetSec(0);
                    }}
                    className="cinema-input w-full px-3 py-2 text-xs"
                  >
                    <option value="">关闭字幕</option>
                    {probeData.probe.subtitles.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                  {probeData.probe.subtitles.length === 0 && (
                    <button
                      type="button"
                      onClick={openOnlineSubModal}
                      className="mt-2 w-full py-1.5 px-3 rounded-xl bg-sky-500/10 hover:bg-sky-500/20 border border-sky-400/25 text-[11px] text-sky-200 flex items-center justify-center gap-1.5 transition"
                    >
                      <Sparkles className="w-3 h-3" />
                      本片暂无内置字幕，点此在线搜中文字幕
                    </button>
                  )}
                  {selectedSubId && (
                    <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-400 tabular-nums">
                      <span>偏移 {subOffsetSec >= 0 ? `+${subOffsetSec}s` : `${subOffsetSec}s`}</span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setSubOffsetSec((o) => Number((o - 0.5).toFixed(1)))}
                          className="px-2 py-0.5 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-zinc-200"
                        >
                          -0.5s
                        </button>
                        <button
                          type="button"
                          onClick={() => setSubOffsetSec(0)}
                          className="px-2 py-0.5 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-zinc-200"
                        >
                          重置
                        </button>
                        <button
                          type="button"
                          onClick={() => setSubOffsetSec((o) => Number((o + 0.5).toFixed(1)))}
                          className="px-2 py-0.5 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-zinc-200"
                        >
                          +0.5s
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Pro Cinema Subtitle Appearance Studio (Fine-Grained Sliders + Live Preview) */}
              {selectedSubId && showSubStylePanel && (
                <div className="rounded-2xl bg-white/[0.03] border border-white/[0.08] p-5 space-y-4 text-xs">
                  {/* Top Bar: Presets + Reset */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-white/[0.06]">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-zinc-400 mr-1">快捷预设</span>
                      <button
                        type="button"
                        onClick={() =>
                          updateSubStyle({
                            color: '#FFFFFF',
                            strokeStrength: 2,
                            bgOpacity: 0,
                            fontWeight: 600,
                          })
                        }
                        className="px-3 py-1 rounded-full bg-white/[0.07] hover:bg-white/[0.14] text-zinc-200 transition"
                      >
                        影院描边
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateSubStyle({
                            color: '#FFFFFF',
                            strokeStrength: 0,
                            bgOpacity: 55,
                            fontWeight: 500,
                          })
                        }
                        className="px-3 py-1 rounded-full bg-white/[0.07] hover:bg-white/[0.14] text-zinc-200 transition"
                      >
                        柔雾胶囊
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateSubStyle({
                            color: '#FDE68A',
                            strokeStrength: 2,
                            bgOpacity: 0,
                            fontWeight: 600,
                          })
                        }
                        className="px-3 py-1 rounded-full bg-amber-400/15 hover:bg-amber-400/25 text-amber-200 transition"
                      >
                        经典暖黄
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        updateSubStyle(DEFAULT_SUB_STYLE);
                        setSubOffsetSec(0);
                      }}
                      className="inline-flex items-center gap-1 text-zinc-400 hover:text-white transition"
                    >
                      <RotateCcw className="w-3 h-3" />
                      恢复默认
                    </button>
                  </div>

                  {/* Live Sample Preview Strip */}
                  <div className="rounded-xl bg-gradient-to-r from-zinc-900 via-zinc-800/70 to-zinc-900 border border-white/[0.06] py-3.5 px-4 flex justify-center overflow-hidden">
                    <div
                      className={`inline-flex flex-col items-center gap-0.5 text-center leading-snug ${
                        subStyle.bgOpacity > 0 ? 'px-4 py-1.5 rounded-2xl backdrop-blur-md' : ''
                      }`}
                      style={{
                        backgroundColor:
                          subStyle.bgOpacity > 0
                            ? `rgba(9, 9, 11, ${(subStyle.bgOpacity / 100).toFixed(2)})`
                            : 'transparent',
                        textShadow: buildSubtitleTextShadow(subStyle.strokeStrength),
                      }}
                    >
                      {(() => {
                        const zhEl = (
                          <div
                            key="zh"
                            style={{
                              fontSize: `${Math.min(34, subStyle.fontSizePx)}px`,
                              fontWeight: subStyle.fontWeight,
                              color: subStyle.color,
                            }}
                          >
                            影院级字幕实时预览效果
                          </div>
                        );
                        const jpEl = !subStyle.zhOnly ? (
                          <div
                            key="jp"
                            style={{
                              fontSize: `${Math.max(
                                11,
                                Math.round(
                                  Math.min(34, subStyle.fontSizePx) * (subStyle.secondaryScale / 100)
                                )
                              )}px`,
                              fontWeight: Math.max(400, subStyle.fontWeight - 100),
                              color: subStyle.color,
                              opacity: 0.86,
                            }}
                          >
                            Cinema Subtitle Live Preview
                          </div>
                        ) : null;
                        return subStyle.swapBilingual ? [zhEl, jpEl] : [jpEl, zhEl];
                      })()}
                    </div>
                  </div>

                  {/* Fine-Grained Sliders Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-zinc-400 tabular-nums">
                        <span>字号大小</span>
                        <span className="text-white">{subStyle.fontSizePx} px</span>
                      </div>
                      <input
                        type="range"
                        min={14}
                        max={52}
                        value={subStyle.fontSizePx}
                        onChange={(e) => updateSubStyle({ fontSizePx: Number(e.target.value) })}
                        className="w-full accent-white cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between text-zinc-400 tabular-nums">
                        <span>距底高度</span>
                        <span className="text-white">{subStyle.bottomPct}%</span>
                      </div>
                      <input
                        type="range"
                        min={4}
                        max={42}
                        value={subStyle.bottomPct}
                        onChange={(e) => updateSubStyle({ bottomPct: Number(e.target.value) })}
                        className="w-full accent-white cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between text-zinc-400 tabular-nums">
                        <span>背景黑底透明度</span>
                        <span className="text-white">
                          {subStyle.bgOpacity === 0 ? '无底框' : `${subStyle.bgOpacity}%`}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={85}
                        step={5}
                        value={subStyle.bgOpacity}
                        onChange={(e) => updateSubStyle({ bgOpacity: Number(e.target.value) })}
                        className="w-full accent-white cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between text-zinc-400 tabular-nums">
                        <span>双语副行缩放</span>
                        <span className="text-white">{subStyle.secondaryScale}%</span>
                      </div>
                      <input
                        type="range"
                        min={60}
                        max={100}
                        step={5}
                        value={subStyle.secondaryScale}
                        onChange={(e) => updateSubStyle({ secondaryScale: Number(e.target.value) })}
                        className="w-full accent-white cursor-pointer"
                      />
                    </div>
                  </div>

                  {/* Color, Weight, Stroke & Bilingual Toggles */}
                  <div className="flex flex-wrap items-center justify-between gap-4 pt-3 border-t border-white/[0.06]">
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-400">颜色</span>
                      {SUB_COLOR_SWATCHES.map((sw) => (
                        <button
                          key={sw.hex}
                          type="button"
                          title={sw.label}
                          onClick={() => updateSubStyle({ color: sw.hex })}
                          className={`w-5 h-5 rounded-full border transition ${
                            subStyle.color.toLowerCase() === sw.hex.toLowerCase()
                              ? 'border-white scale-110 ring-2 ring-white/40'
                              : 'border-white/20 hover:scale-105'
                          }`}
                          style={{ backgroundColor: sw.hex }}
                        />
                      ))}
                      <label
                        title="自定义颜色"
                        className="w-5 h-5 rounded-full border border-white/25 overflow-hidden cursor-pointer flex items-center justify-center bg-gradient-to-tr from-rose-400 via-amber-300 to-sky-400"
                      >
                        <input
                          type="color"
                          value={subStyle.color}
                          onChange={(e) => updateSubStyle({ color: e.target.value })}
                          className="opacity-0 w-full h-full cursor-pointer"
                        />
                      </label>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="text-zinc-400 mr-0.5">描边</span>
                      {([0, 1, 2, 3] as const).map((lv) => (
                        <button
                          key={lv}
                          type="button"
                          onClick={() => updateSubStyle({ strokeStrength: lv })}
                          className={`px-2.5 py-1 rounded-full transition ${
                            subStyle.strokeStrength === lv
                              ? 'bg-white text-zinc-950 font-medium'
                              : 'bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12]'
                          }`}
                        >
                          {['无', '细', '标准', '重'][lv]}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="text-zinc-400 mr-0.5">字重</span>
                      {([400, 500, 600, 700] as const).map((w) => (
                        <button
                          key={w}
                          type="button"
                          onClick={() => updateSubStyle({ fontWeight: w })}
                          className={`px-2.5 py-1 rounded-full transition ${
                            subStyle.fontWeight === w
                              ? 'bg-white text-zinc-950 font-medium'
                              : 'bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12]'
                          }`}
                        >
                          {{ 400: '细', 500: '常规', 600: '加粗', 700: '特粗' }[w]}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => updateSubStyle({ zhOnly: !subStyle.zhOnly })}
                        className={`px-3 py-1 rounded-full border transition ${
                          subStyle.zhOnly
                            ? 'bg-amber-400/20 border-amber-400/40 text-amber-200'
                            : 'bg-white/[0.05] border-white/[0.08] text-zinc-300 hover:text-white'
                        }`}
                      >
                        双语仅看中文：{subStyle.zhOnly ? '开' : '关'}
                      </button>
                      <button
                        type="button"
                        onClick={() => updateSubStyle({ swapBilingual: !subStyle.swapBilingual })}
                        className={`px-3 py-1 rounded-full border transition ${
                          subStyle.swapBilingual
                            ? 'bg-white/15 border-white/30 text-white'
                            : 'bg-white/[0.05] border-white/[0.08] text-zinc-300 hover:text-white'
                        }`}
                      >
                        双语上下互换：{subStyle.swapBilingual ? '开' : '关'}
                      </button>
                    </div>
                  </div>

                  {/* Fine Timing Sync Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-white/[0.06]">
                    <span className="text-zinc-400 tabular-nums">
                      时间轴精细同步：
                      <strong className="text-white ml-1">
                        {subOffsetSec >= 0 ? `+${subOffsetSec.toFixed(1)}s` : `${subOffsetSec.toFixed(1)}s`}
                      </strong>
                    </span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {[-1, -0.5, -0.1, 0, 0.1, 0.5, 1].map((delta) => (
                        <button
                          key={delta}
                          type="button"
                          onClick={() =>
                            delta === 0
                              ? setSubOffsetSec(0)
                              : setSubOffsetSec((o) => Number((o + delta).toFixed(1)))
                          }
                          className={`px-2.5 py-1 rounded-full tabular-nums transition ${
                            delta === 0
                              ? 'bg-white/[0.1] text-white hover:bg-white/[0.18]'
                              : 'bg-white/[0.05] text-zinc-300 hover:bg-white/[0.12]'
                          }`}
                        >
                          {delta === 0 ? '归零' : delta > 0 ? `+${delta}s` : `${delta}s`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* External Players */}
              <div className="pt-5 border-t border-white/[0.07] space-y-2.5">
                <div className="text-xs text-zinc-400">
                  调用本地播放器（支持 HDR / 杜比视界 / 特效字幕与多线程缓冲）
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {[
                    { label: 'PotPlayer', href: probeData.urls.potplayer },
                    { label: 'IINA', href: probeData.urls.iina },
                    { label: 'MPV', href: probeData.urls.mpv },
                    { label: 'Infuse', href: probeData.urls.infuse },
                    { label: 'VLC', href: probeData.urls.vlc },
                    { label: 'nPlayer', href: probeData.urls.nplayer },
                  ].map((p) => (
                    <a key={p.label} href={p.href} className="btn-ghost px-3.5 py-1.5 text-xs">
                      <ExternalLink className="w-3 h-3" />
                      {p.label}
                    </a>
                  ))}
                  <button
                    onClick={() => void handleCopyDirectUrl()}
                    className="btn-ghost px-3.5 py-1.5 text-xs"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        已复制直链 (12h)
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        复制直链 (VidHub)
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Episode Sidebar (shown only for multi-episode packs) */}
          {episodes.length > 1 && (
            <div className="cinema-surface rounded-3xl p-4 h-fit max-h-[720px] flex flex-col">
              <div className="flex items-center justify-between pb-3 border-b border-white/[0.07] px-1">
                <span className="flex items-center gap-2 text-sm font-medium text-white">
                  <Film className="w-4 h-4 text-zinc-400" />
                  剧集列表
                </span>
                <span className="text-xs text-zinc-500">{episodes.length} 集</span>
              </div>

              <div className="mt-3 space-y-1.5 overflow-y-auto pr-1">
                {episodes.map((ep, i) => {
                  const active = ep.index === fileIndex;
                  const shortName = ep.name.split('/').pop() || ep.name;
                  return (
                    <button
                      key={ep.index}
                      disabled={!ep.existsOnDisk}
                      onClick={() => onSelectEpisode(ep.index)}
                      className={`w-full text-left p-3 rounded-2xl border text-xs transition ${
                        active
                          ? 'bg-white text-zinc-950 border-white font-medium'
                          : ep.existsOnDisk
                            ? 'bg-white/[0.03] border-white/[0.06] text-zinc-200 hover:bg-white/[0.08]'
                            : 'bg-white/[0.01] border-transparent text-zinc-600 cursor-not-allowed'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[11px] tabular-nums shrink-0 ${
                            active ? 'text-zinc-600' : 'text-zinc-500'
                          }`}
                        >
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <span className="truncate" title={shortName}>
                          {shortName}
                        </span>
                      </div>
                      <div
                        className={`flex items-center justify-between text-[11px] mt-1 pl-6 tabular-nums ${
                          active ? 'text-zinc-700' : 'text-zinc-500'
                        }`}
                      >
                        <span>{formatBytes(ep.size)}</span>
                        <span>
                          {ep.media?.watchedAt
                            ? '已看'
                            : ep.existsOnDisk
                              ? `${Math.round(ep.progress * 100)}%`
                              : ep.priority > 0
                                ? '下载中'
                                : '未下载'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* Online Subtitle Search & 1-Click Mount Modal */}
      {showOnlineSubModal && probeData && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setShowOnlineSubModal(false)}
        >
          <div
            className="cinema-glass rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl border border-white/15"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-white/[0.08] flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <Subtitles className="w-4 h-4 text-sky-300" />
                  在线寻找中文字幕
                </h2>
                <p className="text-xs text-zinc-400 truncate mt-0.5" title={probeData.fileName}>
                  当前影片：{probeData.fileName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowOnlineSubModal(false)}
                className="p-1.5 rounded-full bg-white/[0.06] hover:bg-white/[0.14] text-zinc-300 hover:text-white transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search Controls */}
            <div className="px-6 py-4 border-b border-white/[0.06] space-y-3 bg-white/[0.02]">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void searchOnlineSubtitles(onlineSubQuery, onlineSubLang);
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="text"
                  value={onlineSubQuery}
                  onChange={(e) => setOnlineSubQuery(e.target.value)}
                  placeholder="输入中/英文片名或集数关键词（如 Taxi Driver、出租车司机）"
                  className="cinema-input flex-1 px-4 py-2 text-xs"
                />
                <button
                  type="submit"
                  disabled={onlineSubLoading}
                  className="btn-ivory px-4 py-2 text-xs shrink-0"
                >
                  {onlineSubLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Search className="w-3.5 h-3.5" />
                  )}
                  搜索
                </button>
              </form>

              <div className="flex items-center justify-between gap-3 flex-wrap text-[11px]">
                <div className="inline-flex p-0.5 rounded-full bg-white/[0.05] border border-white/[0.07]">
                  {(
                    [
                      { id: 'zh', label: '中文字幕优先' },
                      { id: 'all', label: '全部语言' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setOnlineSubLang(opt.id);
                        void searchOnlineSubtitles(onlineSubQuery, opt.id);
                      }}
                      className={`px-3 py-1 rounded-full transition ${
                        onlineSubLang === opt.id
                          ? 'bg-white text-zinc-950 font-medium'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {onlineSubData && (
                  <span className="text-zinc-400">
                    已查源：{onlineSubData.providersUsed.join(' · ') || '无'}
                  </span>
                )}
              </div>

              {onlineSubData &&
                !onlineSubData.configuredProviders.assrt &&
                !onlineSubData.configuredProviders.subdl &&
                !onlineSubData.configuredProviders.opensubtitles && (
                  <div className="rounded-2xl bg-amber-500/10 border border-amber-400/25 px-3.5 py-2.5 text-[11px] text-amber-200/95 leading-relaxed">
                    当前仅启用内置的「射手哈希直配」（免 Key）。若想按片名搜到海量简繁双语字幕，可前往
                    <strong className="text-amber-100 mx-1">设置 → 海报、字幕与推送</strong>
                    免费填入 <strong className="text-amber-100">伪射手 Assrt Token</strong> 或{' '}
                    <strong className="text-amber-100">SubDL API Key</strong>。
                  </div>
                )}

              {onlineSubError && (
                <div className="rounded-2xl bg-rose-500/10 border border-rose-500/30 px-3.5 py-2 text-xs text-rose-200 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{onlineSubError}</span>
                </div>
              )}

              {onlineSubData && onlineSubData.errors.length > 0 && (
                <div className="text-[11px] text-zinc-500">
                  部分源提示：{onlineSubData.errors.join('；')}
                </div>
              )}
            </div>

            {/* Results List */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2.5">
              {onlineSubLoading ? (
                <div className="py-16 text-center space-y-2">
                  <Loader2 className="w-6 h-6 text-zinc-400 animate-spin mx-auto" />
                  <div className="text-xs text-zinc-300">正在并发检索多源字幕库...</div>
                </div>
              ) : !onlineSubData || onlineSubData.results.length === 0 ? (
                <div className="py-14 text-center space-y-2">
                  <Subtitles className="w-7 h-7 text-zinc-600 mx-auto" />
                  <div className="text-sm text-zinc-300">暂未匹配到在线字幕</div>
                  <p className="text-xs text-zinc-500 max-w-md mx-auto">
                    可尝试更换英文原名（如 Taxi Driver）重新搜索，或在设置中补充伪射手 Assrt / SubDL API Key 以扩展词库。
                  </p>
                </div>
              ) : (
                onlineSubData.results.map((item) => {
                  const isBusy = downloadingSubId === item.id;
                  const badgeStyle =
                    item.provider === 'shooter'
                      ? 'bg-emerald-500/15 text-emerald-200 border-emerald-400/30'
                      : item.provider === 'assrt'
                        ? 'bg-amber-500/15 text-amber-200 border-amber-400/30'
                        : item.provider === 'subdl'
                          ? 'bg-sky-500/15 text-sky-200 border-sky-400/30'
                          : 'bg-purple-500/15 text-purple-200 border-purple-400/30';

                  return (
                    <div
                      key={item.id}
                      className="rounded-2xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.07] p-3.5 flex items-center justify-between gap-4 transition"
                    >
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="text-xs font-medium text-white break-all leading-snug">
                          {item.title}
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                          <span className={`px-2 py-0.5 rounded-full border ${badgeStyle}`}>
                            {item.providerLabel}
                          </span>
                          <span className="px-2 py-0.5 rounded-full bg-white/[0.06] text-zinc-300">
                            {item.language}
                          </span>
                          <span className="px-2 py-0.5 rounded-full bg-white/[0.06] text-zinc-400 font-mono">
                            {item.format}
                          </span>
                          {typeof item.downloads === 'number' && item.downloads > 0 && (
                            <span className="text-zinc-500 tabular-nums">
                              {item.downloads} 次下载
                            </span>
                          )}
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={Boolean(downloadingSubId)}
                        onClick={() => void handleDownloadOnlineSub(item)}
                        className="btn-ivory px-3.5 py-2 text-xs shrink-0 disabled:opacity-50"
                      >
                        {isBusy ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            挂载中
                          </>
                        ) : (
                          <>
                            <Download className="w-3.5 h-3.5" />
                            一键挂载
                          </>
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
