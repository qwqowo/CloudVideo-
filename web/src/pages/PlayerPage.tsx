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
  const [uploadingSub, setUploadingSub] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [remuxOffset, setRemuxOffset] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const [showNextPrompt, setShowNextPrompt] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const lastReportRef = useRef<number>(0);
  const initialResumeDoneRef = useRef<boolean>(false);

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

  useEffect(() => {
    let revokedUrl = '';
    let cancelled = false;

    if (!activeSub) {
      setSubBlobUrl('');
      return;
    }
    if (subOffsetSec === 0) {
      setSubBlobUrl(activeSub.url);
      return;
    }

    (async () => {
      try {
        const res = await fetch(activeSub.url, { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const rawVtt = await res.text();
        const shifted = shiftVttTimestamps(rawVtt, subOffsetSec);
        const blob = new Blob([shifted], { type: 'text/vtt' });
        revokedUrl = URL.createObjectURL(blob);
        if (!cancelled) setSubBlobUrl(revokedUrl);
      } catch {
        if (!cancelled) setSubBlobUrl(activeSub.url);
      }
    })();

    return () => {
      cancelled = true;
      if (revokedUrl) URL.revokeObjectURL(revokedUrl);
    };
  }, [activeSub, subOffsetSec]);

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
        if (document.fullscreenElement) void document.exitFullscreen();
        else void v.requestFullscreen?.();
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
            <div className="rounded-3xl overflow-hidden bg-black border border-white/[0.08] shadow-[0_28px_70px_-20px_rgba(0,0,0,0.95)] relative">
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
                className="w-full aspect-video bg-black"
              >
                {activeSub && subBlobUrl && (
                  <track
                    key={`${activeSub.id}-${subOffsetSec}`}
                    kind="subtitles"
                    src={subBlobUrl}
                    label={activeSub.title}
                    default
                  />
                )}
              </video>

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
                    <button
                      type="button"
                      disabled={uploadingSub}
                      onClick={() => subInputRef.current?.click()}
                      className="text-zinc-200 hover:text-white inline-flex items-center gap-1"
                    >
                      <Upload className="w-3 h-3" />
                      {uploadingSub ? '转换中' : '上传字幕'}
                    </button>
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
