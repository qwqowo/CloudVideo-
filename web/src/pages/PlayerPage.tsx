import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  Radio,
} from 'lucide-react';
import type { ProbeResponse, TorrentFileItem } from '../types';
import {
  apiFetch,
  formatBytes,
  formatCountdown,
  formatDuration,
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

export const PlayerPage: React.FC<PlayerPageProps> = ({
  torrentHash,
  fileIndex,
  torrentName,
  onBack,
  onSelectEpisode,
  onDataChanged,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [probeData, setProbeData] = useState<ProbeResponse | null>(null);
  const [episodes, setEpisodes] = useState<TorrentFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [directPlaybackError, setDirectPlaybackError] = useState(false);
  // Default ALWAYS to native direct stream ('direct') as requested
  const [mode, setMode] = useState<'direct' | 'remux'>('direct');
  const [audioTrack, setAudioTrack] = useState(0);
  const [selectedSubId, setSelectedSubId] = useState<string>('');
  const [remuxOffset, setRemuxOffset] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const lastReportRef = useRef<number>(0);
  const initialResumeDoneRef = useRef<boolean>(false);

  const loadMedia = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');
    setDirectPlaybackError(false);
    initialResumeDoneRef.current = false;
    setMode('direct');
    setRemuxOffset(0);
    setCurrentTime(0);

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
      setEpisodes(fileList.files.filter((f) => f.isVideo));
      setAudioTrack(0);
      setSelectedSubId(probe.probe.subtitles[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载视频信息失败');
    } finally {
      setLoading(false);
    }
  }, [torrentHash, fileIndex]);

  useEffect(() => {
    void loadMedia();
  }, [loadMedia]);

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
        if (res.unloadedImmediately) {
          setNotice('已达看完阈值，按 0h 策略已立即卸载并释放硬盘空间。');
          onDataChanged();
        } else if (res.item.deleteAfterAt) {
          setNotice(`已标记看完，${formatCountdown(res.item.deleteAfterAt)}（可点击锁定保留）`);
        }
      } catch {
        // ignore transient reporting errors
      }
    },
    [probeData, torrentHash, fileIndex, onDataChanged]
  );

  const handleVideoLoaded = () => {
    const v = videoRef.current;
    if (!v || !probeData || initialResumeDoneRef.current) return;
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

  const handleMarkWatched = async (immediate: boolean) => {
    if (!probeData) return;
    if (immediate && !confirm('确定立即标记已看并卸载该视频释放空间？')) return;
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
    setNotice(nextPinned ? '已锁定，自动卸载将跳过本视频' : '已取消锁定');
    onDataChanged();
  };

  const streamSrc = probeData
    ? mode === 'direct'
      ? probeData.urls.direct
      : `${probeData.urls.remux}&start=${remuxOffset}&audio=${audioTrack}`
    : '';

  const activeSub = probeData?.probe.subtitles.find((s) => s.id === selectedSubId) || null;
  const totalDuration = probeData?.probe.durationSec || 0;
  const parsed = probeData ? parseMediaTitle(probeData.fileName) : null;

  return (
    <div className="space-y-4">
      {/* Top Navigation & Telemetry Strip */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-3 py-1.5 border border-white/10 bg-[#0a0f16] hover:border-cyan-400/50 text-xs font-mono text-zinc-200 transition"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          RETURN // 媒体库
        </button>

        <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-500">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 border border-cyan-400/30 bg-cyan-950/40 text-cyan-300">
            <Radio className="w-3 h-3" />
            {mode === 'direct' ? 'DIRECT STREAM' : 'LOSSLESS REMUX'}
          </span>
          <span className="truncate max-w-md hidden sm:inline" title={torrentName}>
            {torrentName}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="hud-panel p-20 text-center">
          <div className="text-xs font-mono tracking-[0.22em] text-cyan-400 animate-pulse">
            PROBING MEDIA STREAM...
          </div>
          <div className="text-xs text-zinc-500 mt-2">
            正在解析编码、码率与字幕轨
          </div>
        </div>
      ) : error ? (
        <div className="border border-rose-500/40 bg-rose-950/30 p-6 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-mono font-semibold text-rose-200">
              STREAM INIT FAILED
            </div>
            <p className="text-xs text-rose-200/80 mt-1">{error}</p>
            <button
              onClick={() => void loadMedia()}
              className="mt-3 px-4 py-1.5 bg-rose-500/20 border border-rose-400/50 hover:bg-rose-500/30 text-xs font-mono text-rose-100"
            >
              RETRY PROBE
            </button>
          </div>
        </div>
      ) : probeData ? (
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-5">
          {/* Main Cinema Stage */}
          <div className="xl:col-span-3 space-y-4">
            <div className="hud-panel p-0 overflow-hidden bg-black">
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
                onEnded={() => void reportProgress(totalDuration || currentTime, true)}
                onError={() => {
                  if (mode === 'direct') setDirectPlaybackError(true);
                }}
                className="w-full aspect-video bg-black"
              >
                {activeSub && (
                  <track
                    key={activeSub.id}
                    kind="subtitles"
                    src={activeSub.url}
                    label={activeSub.title}
                    default
                  />
                )}
              </video>

              {/* Remux Scrubber Bar */}
              {mode === 'remux' && totalDuration > 0 && (
                <div className="bg-[#06090e] border-t border-white/10 px-4 py-2.5 flex items-center gap-3">
                  <span className="text-[10px] font-mono tracking-wider text-cyan-400 shrink-0">
                    REMUX SEEK
                  </span>
                  <span className="text-xs font-mono text-zinc-200 shrink-0">
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
                    className="flex-1 accent-cyan-400 cursor-pointer"
                  />
                  <span className="text-xs font-mono text-zinc-500 shrink-0">
                    {formatDuration(totalDuration)}
                  </span>
                </div>
              )}
            </div>

            {/* Direct-play compatibility recovery banner (only shown if decode error occurs) */}
            {directPlaybackError && mode === 'direct' && (
              <div className="border border-amber-500/40 bg-amber-950/35 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="text-xs text-amber-200">
                  <span className="font-mono font-bold mr-2">CODEC ALERT //</span>
                  当前浏览器无法原生直出此封装或音轨（{probeData.probe.container.toUpperCase()} /{' '}
                  {probeData.probe.audioCodec.toUpperCase()}），可一键切至无损换封装或拉起本地播放器。
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => switchToRemux(currentTime)}
                    className="px-3 py-1.5 bg-amber-400 hover:bg-amber-300 text-xs font-mono font-bold text-zinc-950 transition"
                  >
                    切换无损 Remux
                  </button>
                  <a
                    href={probeData.urls.potplayer}
                    className="px-3 py-1.5 border border-amber-400/50 text-xs font-mono text-amber-200 hover:bg-amber-400/15 transition"
                  >
                    PotPlayer
                  </a>
                </div>
              </div>
            )}

            {notice && (
              <div className="border border-emerald-500/40 bg-emerald-950/30 px-4 py-2.5 text-xs font-mono text-emerald-200 flex items-center justify-between gap-2">
                <span>SYS // {notice}</span>
                {probeData.mediaItem.deleteAfterAt && !probeData.mediaItem.pinned && (
                  <button
                    onClick={() => void handleTogglePin()}
                    className="px-2.5 py-1 border border-emerald-400/50 hover:bg-emerald-500/20 text-emerald-100 shrink-0"
                  >
                    锁定保留
                  </button>
                )}
              </div>
            )}

            {/* Playback Console Panel */}
            <div className="hud-panel p-5 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="min-w-0">
                  <h1 className="text-base sm:text-lg font-semibold text-white break-all">
                    {parsed?.title || probeData.fileName}
                  </h1>
                  <div className="text-[11px] font-mono text-zinc-500 mt-0.5 break-all">
                    {probeData.fileName}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap mt-3 text-[11px] font-mono">
                    <span className="px-2 py-0.5 border border-white/10 bg-white/[0.03] text-zinc-200">
                      {probeData.probe.width}x{probeData.probe.height}
                    </span>
                    <span className="px-2 py-0.5 border border-white/10 bg-white/[0.03] text-zinc-300 uppercase">
                      {probeData.probe.videoCodec || 'VIDEO'} · {probeData.probe.audioCodec || 'AUDIO'}
                    </span>
                    <span className="px-2 py-0.5 border border-white/10 bg-white/[0.03] text-zinc-400">
                      {formatBytes(probeData.sizeBytes)}
                    </span>
                    <span className="px-2 py-0.5 border border-cyan-400/35 bg-cyan-400/10 text-cyan-300">
                      建议带宽 ≥ {probeData.probe.requiredMbps} Mbps
                    </span>
                    {!probeData.probe.canDirectPlay && mode === 'direct' && !directPlaybackError && (
                      <button
                        onClick={() => switchToRemux(currentTime)}
                        className="px-2 py-0.5 border border-amber-500/35 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition"
                      >
                        原生直出中 · 若无声点此切 Remux
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 flex-wrap">
                  <button
                    onClick={() => void handleTogglePin()}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border transition ${
                      probeData.mediaItem.pinned
                        ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-200'
                        : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:text-white'
                    }`}
                  >
                    <Pin className="w-3.5 h-3.5" />
                    {probeData.mediaItem.pinned ? '已锁定' : '锁定'}
                  </button>
                  <button
                    onClick={() => void handleMarkWatched(false)}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-white/10 bg-white/[0.03] hover:border-emerald-400/40 text-xs font-mono text-zinc-200 transition"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    标为已看
                  </button>
                  <button
                    onClick={() => void handleMarkWatched(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-rose-500/50 bg-rose-950/50 hover:bg-rose-600 text-xs font-mono text-rose-200 hover:text-white transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    立即卸载
                  </button>
                </div>
              </div>

              {/* Stream Controls */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-4 border-t border-white/[0.07]">
                <div>
                  <div className="text-[10px] font-mono tracking-[0.16em] text-zinc-500 mb-1.5">
                    STREAM MODE / 输出模式
                  </div>
                  <div className="grid grid-cols-2 border border-white/10 bg-[#05070a]">
                    <button
                      type="button"
                      onClick={switchToDirect}
                      className={`py-1.5 text-[11px] font-mono transition ${
                        mode === 'direct'
                          ? 'bg-cyan-400/15 text-cyan-300 border-b-2 border-cyan-400'
                          : 'text-zinc-500 hover:text-zinc-200'
                      }`}
                    >
                      原生直出 (默认)
                    </button>
                    <button
                      type="button"
                      onClick={() => switchToRemux(currentTime)}
                      className={`py-1.5 text-[11px] font-mono transition ${
                        mode === 'remux'
                          ? 'bg-cyan-400/15 text-cyan-300 border-b-2 border-cyan-400'
                          : 'text-zinc-500 hover:text-zinc-200'
                      }`}
                    >
                      无损 Remux
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-mono tracking-[0.16em] text-zinc-500 flex items-center gap-1 mb-1.5">
                    <Volume2 className="w-3 h-3" />
                    AUDIO TRACK / 音轨
                  </label>
                  <select
                    value={audioTrack}
                    onChange={(e) => {
                      setAudioTrack(Number(e.target.value));
                      if (mode !== 'remux') switchToRemux(currentTime);
                    }}
                    className="w-full bg-[#05070a] border border-white/10 px-2.5 py-1.5 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-400/60"
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
                  <label className="text-[10px] font-mono tracking-[0.16em] text-zinc-500 flex items-center gap-1 mb-1.5">
                    <Subtitles className="w-3 h-3" />
                    SUBTITLES / 字幕
                  </label>
                  <select
                    value={selectedSubId}
                    onChange={(e) => setSelectedSubId(e.target.value)}
                    className="w-full bg-[#05070a] border border-white/10 px-2.5 py-1.5 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-400/60"
                  >
                    <option value="">关闭字幕</option>
                    {probeData.probe.subtitles.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* External Local Players Dock */}
              <div className="pt-4 border-t border-white/[0.07]">
                <div className="text-[10px] font-mono tracking-[0.16em] text-zinc-500 mb-2">
                  EXTERNAL DECK // 一键拉起本地硬解播放器（支持 HDR / 杜比 / 特效字幕 & 多线程缓冲）
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={probeData.urls.potplayer}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-amber-500/35 bg-amber-500/10 hover:bg-amber-500/20 text-xs font-mono text-amber-200 transition"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    PotPlayer
                  </a>
                  <a
                    href={probeData.urls.iina}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-cyan-500/35 bg-cyan-500/10 hover:bg-cyan-500/20 text-xs font-mono text-cyan-200 transition"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    IINA
                  </a>
                  <a
                    href={probeData.urls.mpv}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-emerald-500/35 bg-emerald-500/10 hover:bg-emerald-500/20 text-xs font-mono text-emerald-200 transition"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    MPV
                  </a>
                  <button
                    onClick={() => void handleCopyDirectUrl()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-white/15 bg-white/[0.03] hover:border-cyan-400/50 text-xs font-mono text-zinc-200 transition"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        已复制直链 (12h)
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        复制直链 (Infuse / VidHub / VLC)
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Right Episode Rail */}
          <div className="hud-panel p-4 h-fit max-h-[720px] flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-white/[0.07]">
              <span className="flex items-center gap-2 text-xs font-mono font-semibold tracking-wider text-white">
                <Film className="w-3.5 h-3.5 text-cyan-400" />
                PLAYLIST
              </span>
              <span className="text-[10px] font-mono text-zinc-500">
                {episodes.length} ITEMS
              </span>
            </div>

            <div className="mt-2.5 space-y-1.5 overflow-y-auto pr-1">
              {episodes.map((ep, i) => {
                const active = ep.index === fileIndex;
                const shortName = ep.name.split('/').pop() || ep.name;
                return (
                  <button
                    key={ep.index}
                    disabled={!ep.existsOnDisk}
                    onClick={() => onSelectEpisode(ep.index)}
                    className={`w-full text-left p-2.5 border text-xs transition ${
                      active
                        ? 'bg-cyan-400/15 border-cyan-400/60 text-white'
                        : ep.existsOnDisk
                        ? 'bg-[#06090e] border-white/[0.07] text-zinc-300 hover:border-white/25'
                        : 'bg-[#05070a] border-white/[0.04] text-zinc-600 cursor-not-allowed'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="font-medium truncate" title={shortName}>
                        {shortName}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 mt-1 pl-5">
                      <span>{formatBytes(ep.size)}</span>
                      <span className={ep.media?.watchedAt ? 'text-emerald-400' : ''}>
                        {ep.media?.watchedAt
                          ? 'WATCHED'
                          : ep.existsOnDisk
                          ? `${Math.round(ep.progress * 100)}%`
                          : 'OFFLINE'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
