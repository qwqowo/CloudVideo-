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
} from 'lucide-react';
import type { DownloadLiveStatus, ProbeResponse, SubtitleTrack, TorrentFileItem } from '../types';
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

type SubSize = 'sm' | 'md' | 'lg' | 'xl';
type SubTheme = 'stroke' | 'frosted' | 'amber';
type SubPos = 'low' | 'mid' | 'high';

interface SubStylePrefs {
  size: SubSize;
  theme: SubTheme;
  pos: SubPos;
  zhOnly: boolean;
}

const SUB_STYLE_STORAGE_KEY = 'cloudvideo_sub_style_v1';

const DEFAULT_SUB_STYLE: SubStylePrefs = {
  size: 'md',
  theme: 'stroke',
  pos: 'mid',
  zhOnly: false,
};

function loadSubStylePrefs(): SubStylePrefs {
  try {
    const raw = localStorage.getItem(SUB_STYLE_STORAGE_KEY);
    if (!raw) return DEFAULT_SUB_STYLE;
    const p = JSON.parse(raw) as Partial<SubStylePrefs>;
    return {
      size: p.size === 'sm' || p.size === 'md' || p.size === 'lg' || p.size === 'xl' ? p.size : 'md',
      theme: p.theme === 'stroke' || p.theme === 'frosted' || p.theme === 'amber' ? p.theme : 'stroke',
      pos: p.pos === 'low' || p.pos === 'mid' || p.pos === 'high' ? p.pos : 'mid',
      zhOnly: Boolean(p.zhOnly),
    };
  } catch {
    return DEFAULT_SUB_STYLE;
  }
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
  }, [mode, playbackRate, nextEpisode, onSelectEpisode]);

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

              {/* Cinema-Grade Custom Subtitle Overlay (Top & Bottom Lanes, Bilingual Typography) */}
              {activeSubtitleCues.length > 0 && (() => {
                const topCues = activeSubtitleCues.filter((c) => c.alignTop);
                const bottomCues = activeSubtitleCues.filter((c) => !c.alignTop);
                const primarySizeClass = stageFullscreen
                  ? {
                      sm: 'text-xl sm:text-2xl',
                      md: 'text-2xl sm:text-3xl',
                      lg: 'text-3xl sm:text-4xl',
                      xl: 'text-4xl sm:text-5xl',
                    }[subStyle.size]
                  : {
                      sm: 'text-sm sm:text-base',
                      md: 'text-base sm:text-xl',
                      lg: 'text-lg sm:text-2xl',
                      xl: 'text-xl sm:text-3xl',
                    }[subStyle.size];

                const secondarySizeClass = stageFullscreen
                  ? {
                      sm: 'text-base sm:text-lg',
                      md: 'text-lg sm:text-2xl',
                      lg: 'text-xl sm:text-3xl',
                      xl: 'text-2xl sm:text-4xl',
                    }[subStyle.size]
                  : {
                      sm: 'text-xs sm:text-sm',
                      md: 'text-xs sm:text-base',
                      lg: 'text-sm sm:text-lg',
                      xl: 'text-base sm:text-xl',
                    }[subStyle.size];

                const bottomOffsetClass =
                  subStyle.pos === 'low'
                    ? 'bottom-12 sm:bottom-14'
                    : subStyle.pos === 'high'
                      ? 'bottom-20 sm:bottom-24'
                      : 'bottom-14 sm:bottom-16';

                const primaryColor =
                  subStyle.theme === 'amber' ? 'text-amber-200' : 'text-white';
                const secondaryColor =
                  subStyle.theme === 'amber' ? 'text-amber-100/80' : 'text-zinc-100/85';

                const renderCueGroup = (cues: ParsedVttCue[]) => {
                  const allLines = cues.flatMap((c) => c.lines);
                  const hasZh = allLines.some(isChinesePrimaryLine);
                  const hasForeign = allLines.some(isJapaneseOrLatinLine);
                  const isBilingual = hasZh && hasForeign;
                  const visibleLines =
                    isBilingual && subStyle.zhOnly
                      ? allLines.filter((l) => !isJapaneseOrLatinLine(l))
                      : allLines;

                  return (
                    <div
                      className={`inline-flex flex-col items-center gap-0.5 max-w-[92%] text-center leading-snug tracking-wide ${
                        subStyle.theme === 'frosted'
                          ? 'px-4 py-1.5 rounded-2xl bg-black/55 backdrop-blur-md shadow-lg'
                          : 'cinema-sub-stroke'
                      }`}
                    >
                      {visibleLines.map((line, i) => {
                        const isSecondary = isBilingual && isJapaneseOrLatinLine(line);
                        return (
                          <div
                            key={`${i}-${line}`}
                            className={
                              isSecondary
                                ? `${secondarySizeClass} ${secondaryColor} font-normal`
                                : `${primarySizeClass} ${primaryColor} font-semibold`
                            }
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
                        className={`pointer-events-none absolute ${bottomOffsetClass} inset-x-4 z-20 flex justify-center transition-all`}
                      >
                        {renderCueGroup(bottomCues)}
                      </div>
                    )}
                  </>
                );
              })()}

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

              {/* Cinema Subtitle Appearance Studio */}
              {selectedSubId && showSubStylePanel && (
                <div className="rounded-2xl bg-white/[0.03] border border-white/[0.08] p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-400">风格</span>
                    {(
                      [
                        ['stroke', '影院描边'],
                        ['frosted', '柔雾半透'],
                        ['amber', '经典暖黄'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => updateSubStyle({ theme: id })}
                        className={`px-3 py-1 rounded-full transition ${
                          subStyle.theme === id
                            ? 'bg-white text-zinc-950 font-medium'
                            : 'bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <span className="text-zinc-400 mr-0.5">字号</span>
                    {(
                      [
                        ['sm', '小'],
                        ['md', '标准'],
                        ['lg', '大'],
                        ['xl', '特大'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => updateSubStyle({ size: id })}
                        className={`px-2.5 py-1 rounded-full transition ${
                          subStyle.size === id
                            ? 'bg-white text-zinc-950 font-medium'
                            : 'bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <span className="text-zinc-400 mr-0.5">高度</span>
                    {(
                      [
                        ['low', '偏低'],
                        ['mid', '标准'],
                        ['high', '偏高'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => updateSubStyle({ pos: id })}
                        className={`px-2.5 py-1 rounded-full transition ${
                          subStyle.pos === id
                            ? 'bg-white text-zinc-950 font-medium'
                            : 'bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => updateSubStyle({ zhOnly: !subStyle.zhOnly })}
                    className={`px-3 py-1 rounded-full border transition ${
                      subStyle.zhOnly
                        ? 'bg-amber-400/20 border-amber-400/40 text-amber-200'
                        : 'bg-white/[0.05] border-white/[0.08] text-zinc-300 hover:text-white'
                    }`}
                  >
                    双语时仅看中文：{subStyle.zhOnly ? '开' : '关'}
                  </button>
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
    </div>
  );
};
