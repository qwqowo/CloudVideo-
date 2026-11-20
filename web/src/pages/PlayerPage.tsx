import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  Copy,
  Check,
  Trash2,
  Pin,
  CheckCircle2,
  Sliders,
  Subtitles,
  Volume2,
  AlertCircle,
  Film,
} from 'lucide-react';
import type { ProbeResponse, TorrentFileItem } from '../types';
import { apiFetch, formatBytes, formatCountdown, formatDuration } from '../lib/api';

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
    initialResumeDoneRef.current = false;
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
      setMode(probe.probe.recommendedMode);
      setAudioTrack(0);
      setSelectedSubId(probe.probe.subtitles[0]?.id || '');

      const resumeSec = probe.mediaItem?.positionSec || 0;
      const dur = probe.probe.durationSec || 0;
      if (resumeSec > 5 && (dur === 0 || resumeSec < dur * 0.95)) {
        if (probe.probe.recommendedMode === 'remux') {
          setRemuxOffset(Math.floor(resumeSec));
          setCurrentTime(Math.floor(resumeSec));
        }
      }
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
          setNotice('已达到看完阈值，按你设置的“0 小时延迟”已自动卸载并释放硬盘空间！');
          onDataChanged();
        } else if (res.item.deleteAfterAt) {
          setNotice(`已标记看完，${formatCountdown(res.item.deleteAfterAt)}（可随时锁定保留）`);
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

  const handleSeekRemux = (targetSec: number) => {
    setRemuxOffset(Math.floor(targetSec));
    setCurrentTime(Math.floor(targetSec));
  };

  const handleCopyDirectUrl = async () => {
    if (!probeData) return;
    await navigator.clipboard.writeText(probeData.urls.direct);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleMarkWatched = async (immediate: boolean) => {
    if (!probeData) return;
    if (immediate && !confirm('确定立即标记已看并卸载该视频文件释放空间？')) return;
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

  return (
    <div className="space-y-5">
      {/* Top Bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-sm text-slate-200 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          返回媒体库
        </button>
        <div className="text-xs text-slate-400 truncate max-w-xl" title={torrentName}>
          所属种子：{torrentName}
        </div>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-16 text-center text-sm text-slate-400">
          正在通过 FFprobe 探测视频编码、码率与字幕轨...
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold text-rose-200">无法启动播放</div>
            <p className="text-xs text-rose-200/80 mt-1">{error}</p>
            <button
              onClick={() => void loadMedia()}
              className="mt-3 px-3.5 py-1.5 rounded-lg bg-rose-600/80 hover:bg-rose-500 text-xs font-medium text-white"
            >
              重新探测
            </button>
          </div>
        </div>
      ) : probeData ? (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
          {/* Main Player Column */}
          <div className="lg:col-span-3 space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-black overflow-hidden shadow-2xl">
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

              {/* Remux Seek Bar (needed because fragmented pipe streams don't expose native total duration seek) */}
              {mode === 'remux' && totalDuration > 0 && (
                <div className="bg-slate-950/95 border-t border-slate-800 px-4 py-2.5 flex items-center gap-3">
                  <span className="text-[11px] font-mono text-indigo-300 shrink-0">
                    无损换封装定位
                  </span>
                  <span className="text-xs font-mono text-slate-300 shrink-0">
                    {formatDuration(currentTime)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={Math.floor(totalDuration)}
                    value={Math.min(Math.floor(totalDuration), Math.floor(currentTime))}
                    onChange={(e) => handleSeekRemux(Number(e.target.value))}
                    className="flex-1 accent-indigo-500 cursor-pointer"
                  />
                  <span className="text-xs font-mono text-slate-400 shrink-0">
                    {formatDuration(totalDuration)}
                  </span>
                </div>
              )}
            </div>

            {notice && (
              <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-2.5 text-xs text-emerald-200 flex items-center justify-between gap-2">
                <span>{notice}</span>
                {probeData.mediaItem.deleteAfterAt && !probeData.mediaItem.pinned && (
                  <button
                    onClick={() => void handleTogglePin()}
                    className="px-2.5 py-1 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-100 shrink-0"
                  >
                    锁定保留
                  </button>
                )}
              </div>
            )}

            {/* Title + Codec + Bandwidth Metadata */}
            <div className="rounded-2xl border border-slate-800/90 bg-slate-900/75 p-4 sm:p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="min-w-0">
                  <h1 className="text-base sm:text-lg font-bold text-white break-all">
                    {probeData.fileName}
                  </h1>
                  <div className="flex items-center gap-2 flex-wrap mt-2 text-xs">
                    <span className="px-2 py-0.5 rounded-md bg-slate-800 text-slate-200 font-mono">
                      {probeData.probe.width}x{probeData.probe.height}
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-slate-800 text-slate-200 uppercase font-mono">
                      {probeData.probe.videoCodec || 'video'} / {probeData.probe.audioCodec || 'audio'}
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-slate-800 text-slate-300">
                      {formatBytes(probeData.sizeBytes)}
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                      流畅建议带宽 ≥ {probeData.probe.requiredMbps} Mbps
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => void handleTogglePin()}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition ${
                      probeData.mediaItem.pinned
                        ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-200'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'
                    }`}
                  >
                    <Pin className="w-3.5 h-3.5" />
                    {probeData.mediaItem.pinned ? '已锁定' : '锁定防删'}
                  </button>
                  <button
                    onClick={() => void handleMarkWatched(false)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    标为已看
                  </button>
                  <button
                    onClick={() => void handleMarkWatched(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-600/80 hover:bg-rose-500 text-xs font-medium text-white transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    看完立即卸载
                  </button>
                </div>
              </div>

              {/* Stream Controls: Mode, Audio, Subtitle */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-slate-800/80">
                <div>
                  <label className="text-[11px] text-slate-400 flex items-center gap-1 mb-1">
                    <Sliders className="w-3 h-3" />
                    网页播放模式
                  </label>
                  <select
                    value={mode}
                    onChange={(e) => {
                      const next = e.target.value as 'direct' | 'remux';
                      setMode(next);
                      if (next === 'remux') setRemuxOffset(Math.floor(currentTime));
                    }}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200"
                  >
                    <option value="direct">
                      原生直出（零 CPU{probeData.probe.canDirectPlay ? ' · 推荐' : ''}）
                    </option>
                    <option value="remux">
                      无损 Remux 换封装（MKV/DTS 兼容{!probeData.probe.canDirectPlay ? ' · 推荐' : ''}）
                    </option>
                  </select>
                </div>

                <div>
                  <label className="text-[11px] text-slate-400 flex items-center gap-1 mb-1">
                    <Volume2 className="w-3 h-3" />
                    音轨选择（Remux 生效）
                  </label>
                  <select
                    value={audioTrack}
                    onChange={(e) => {
                      setAudioTrack(Number(e.target.value));
                      if (mode !== 'remux') {
                        setMode('remux');
                        setRemuxOffset(Math.floor(currentTime));
                      }
                    }}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200"
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
                  <label className="text-[11px] text-slate-400 flex items-center gap-1 mb-1">
                    <Subtitles className="w-3 h-3" />
                    字幕选择
                  </label>
                  <select
                    value={selectedSubId}
                    onChange={(e) => setSelectedSubId(e.target.value)}
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200"
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

              {/* External Local Players */}
              <div className="pt-3 border-t border-slate-800/80">
                <div className="text-xs text-slate-400 mb-2">
                  一键拉起本地播放器（支持 H.265 / HDR / 杜比音轨 / 特效字幕 & 多线程缓冲，服务器零转码压力）：
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={probeData.urls.potplayer}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-xs font-medium text-amber-200 transition"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    PotPlayer
                  </a>
                  <a
                    href={probeData.urls.iina}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-xs font-medium text-sky-200 transition"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    IINA (macOS)
                  </a>
                  <a
                    href={probeData.urls.mpv}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/30 text-xs font-medium text-purple-200 transition"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    MPV
                  </a>
                  <button
                    onClick={() => void handleCopyDirectUrl()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 transition"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        已复制直链（12h 有效）
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        复制直链（Infuse / VidHub / VLC）
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Right Sidebar: Episode Switcher */}
          <div className="rounded-2xl border border-slate-800/90 bg-slate-900/75 p-4 h-fit max-h-[680px] flex flex-col">
            <div className="flex items-center gap-2 text-sm font-semibold text-white pb-3 border-b border-slate-800">
              <Film className="w-4 h-4 text-indigo-400" />
              同种子剧集 ({episodes.length})
            </div>
            <div className="mt-2 space-y-1.5 overflow-y-auto pr-1">
              {episodes.map((ep) => {
                const active = ep.index === fileIndex;
                const shortName = ep.name.split('/').pop() || ep.name;
                return (
                  <button
                    key={ep.index}
                    disabled={!ep.existsOnDisk}
                    onClick={() => onSelectEpisode(ep.index)}
                    className={`w-full text-left p-2.5 rounded-xl border text-xs transition ${
                      active
                        ? 'bg-indigo-600/20 border-indigo-500/50 text-white'
                        : ep.existsOnDisk
                        ? 'bg-slate-950/60 border-slate-800/80 text-slate-300 hover:border-slate-700'
                        : 'bg-slate-950/30 border-slate-800/40 text-slate-500 cursor-not-allowed'
                    }`}
                  >
                    <div className="font-medium truncate" title={shortName}>
                      {shortName}
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                      <span>{formatBytes(ep.size)}</span>
                      <span>
                        {ep.media?.watchedAt
                          ? '已看'
                          : ep.existsOnDisk
                          ? `${Math.round(ep.progress * 100)}%`
                          : '未下载'}
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
