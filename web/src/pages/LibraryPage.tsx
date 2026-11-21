import React, { useEffect, useMemo, useState } from 'react';
import {
  Play,
  Pause,
  Trash2,
  Pin,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Film,
  FileText,
  Plus,
  Search,
  LayoutGrid,
  List,
  X,
  Repeat,
  Star,
  Sparkles,
  Compass,
  Info,
  ChevronDown,
  ChevronUp,
  Download,
  Zap,
  History,
  Users,
  Clapperboard,
  Tv,
  Sparkles as AnimeIcon,
} from 'lucide-react';
import type {
  MediaCategory,
  TmdbMediaCredits,
  TmdbMeta,
  TorrentFileItem,
  TorrentsResponse,
  TorrentSummary,
  WatchHistoryRecord,
} from '../types';
import {
  apiFetch,
  formatBytes,
  formatCountdown,
  formatDuration,
  formatSpeed,
  parseMediaTitle,
  translateTorrentState,
} from '../lib/api';

interface LibraryPageProps {
  data: TorrentsResponse | null;
  loading: boolean;
  onRefresh: () => void;
  onOpenAdd: () => void;
  onGoDiscover: (prefillQuery?: string) => void;
  onPlay: (torrentHash: string, fileIndex: number, torrentName: string) => void;
  initialDetailHash?: string | null;
  onClearInitialDetail?: () => void;
}

type CategoryTab = 'all' | MediaCategory | 'history';
type FilterMode = 'all' | 'playable' | 'downloading' | 'scheduled';
type ViewMode = 'grid' | 'list';

const CinemaThumb: React.FC<{
  hash: string;
  fileIndex?: number;
  existsOnDisk?: boolean;
  title?: string;
  progress: number;
  tmdbBackdrop?: string;
  compact?: boolean;
  hoverCycling?: boolean;
}> = ({
  hash,
  fileIndex,
  existsOnDisk,
  title,
  progress,
  tmdbBackdrop,
  compact = false,
  hoverCycling = false,
}) => {
  const [slot, setSlot] = useState<0 | 1 | 2>(0);
  const [hovering, setHovering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!hoverCycling || !hovering || !existsOnDisk || fileIndex === undefined) {
      setSlot(0);
      return;
    }
    const id = setInterval(() => {
      setSlot((prev) => ((prev + 1) % 3) as 0 | 1 | 2);
    }, 1100);
    return () => clearInterval(id);
  }, [hoverCycling, hovering, existsOnDisk, fileIndex]);

  const frameSrc =
    existsOnDisk && fileIndex !== undefined
      ? `/api/stream/${encodeURIComponent(hash)}/${fileIndex}/thumb?slot=${slot}`
      : '';

  const activeSrc =
    hovering && hoverCycling && frameSrc ? frameSrc : tmdbBackdrop || frameSrc;

  useEffect(() => {
    setFailed(false);
  }, [activeSrc]);

  const pct = Math.round(progress * 100);

  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className="relative w-full h-full bg-gradient-to-br from-zinc-900 via-[#131318] to-zinc-950 overflow-hidden select-none"
    >
      {/* Calm editorial fallback when no still exists yet */}
      <div
        className={`absolute inset-0 flex flex-col items-center justify-center p-4 text-center transition-opacity duration-300 ${
          loaded && !failed ? 'opacity-0' : 'opacity-100'
        }`}
      >
        {!compact ? (
          <>
            <Film className="w-6 h-6 text-zinc-600 mb-2" />
            <div className="text-xs text-zinc-400 line-clamp-1 max-w-[80%] font-medium">
              {title || '正在准备画面'}
            </div>
            {pct < 100 && (
              <div className="text-[11px] text-zinc-500 mt-1 tabular-nums">{pct}%</div>
            )}
          </>
        ) : (
          <Film className="w-4 h-4 text-zinc-600" />
        )}
      </div>

      {activeSrc && !failed && (
        <img
          src={activeSrc}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`w-full h-full object-cover transition-all duration-500 group-hover:scale-[1.04] ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}

      {/* Subtle multi-frame preview indicator */}
      {hoverCycling && hovering && existsOnDisk && (
        <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-2 py-1 rounded-full bg-black/60 backdrop-blur-md">
          {[0, 1, 2].map((idx) => (
            <span
              key={idx}
              className={`h-1 rounded-full transition-all ${
                slot === idx ? 'w-3 bg-white' : 'w-1 bg-white/40'
              }`}
            />
          ))}
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/20" />
    </div>
  );
};

export const LibraryPage: React.FC<LibraryPageProps> = ({
  data,
  onRefresh,
  onOpenAdd,
  onGoDiscover,
  onPlay,
  initialDetailHash,
  onClearInitialDetail,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [categoryTab, setCategoryTab] = useState<CategoryTab>('all');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [query, setQuery] = useState('');
  const [detailHash, setDetailHash] = useState<string | null>(null);
  const [filesMap, setFilesMap] = useState<Record<string, TorrentFileItem[]>>({});
  const [creditsMap, setCreditsMap] = useState<Record<string, TmdbMediaCredits | null>>({});
  const [watchHistory, setWatchHistory] = useState<WatchHistoryRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [showOtherFiles, setShowOtherFiles] = useState(false);
  const [tmdbSearchOpen, setTmdbSearchOpen] = useState(false);
  const [tmdbQuery, setTmdbQuery] = useState('');
  const [tmdbResults, setTmdbResults] = useState<TmdbMeta[]>([]);
  const [tmdbSearching, setTmdbSearching] = useState(false);
  const [toast, setToast] = useState('');

  const loadWatchHistory = async () => {
    setLoadingHistory(true);
    try {
      const res = await apiFetch<{ history: WatchHistoryRecord[] }>('/api/media/history');
      setWatchHistory(res.history);
    } catch {
      // ignore
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    if (categoryTab === 'history') {
      void loadWatchHistory();
    }
  }, [categoryTab]);

  useEffect(() => {
    if (initialDetailHash) {
      setDetailHash(initialDetailHash);
      onClearInitialDetail?.();
    }
  }, [initialDetailHash, onClearInitialDetail]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), 3200);
  };

  const fetchFiles = async (hash: string) => {
    setLoadingFiles(true);
    try {
      const res = await apiFetch<{ hash: string; files: TorrentFileItem[] }>(
        `/api/torrents/${encodeURIComponent(hash)}/files`
      );
      setFilesMap((prev) => ({ ...prev, [hash]: res.files }));
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载剧集列表失败');
    } finally {
      setLoadingFiles(false);
    }
  };

  useEffect(() => {
    if (!detailHash) {
      setTmdbSearchOpen(false);
      setShowOtherFiles(false);
      return;
    }
    void fetchFiles(detailHash);
    void apiFetch<{ credits: TmdbMediaCredits | null }>(
      `/api/torrents/${encodeURIComponent(detailHash)}/credits`
    )
      .then((res) => setCreditsMap((prev) => ({ ...prev, [detailHash]: res.credits })))
      .catch(() => {});
    const id = setInterval(() => void fetchFiles(detailHash), 4000);
    return () => clearInterval(id);
  }, [detailHash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetailHash(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const allTorrents = data?.torrents ?? [];

  // Continue watching rail: playable items with active watch progress
  const continueWatching = useMemo(
    () =>
      allTorrents.filter(
        (t) => t.playableCount > 0 && t.watchProgress > 0.01 && t.watchProgress < 0.95
      ),
    [allTorrents]
  );

  // Featured hero spotlight: prefer most recent unfinished watched item, else newest playable with artwork
  const heroItem = useMemo(() => {
    if (continueWatching.length > 0) return continueWatching[0];
    const withBackdrop = allTorrents.find(
      (t) => t.playableCount > 0 && (t.tmdb?.backdropUrl || t.primaryVideo?.existsOnDisk)
    );
    return withBackdrop || allTorrents.find((t) => t.playableCount > 0) || allTorrents[0] || null;
  }, [allTorrents, continueWatching]);

  const categoryCounts = useMemo(() => {
    const counts = { movie: 0, tv: 0, anime: 0 };
    for (const t of allTorrents) {
      const cat = t.mediaCategory || (t.videoCount > 1 ? 'tv' : 'movie');
      if (cat === 'anime') counts.anime++;
      else if (cat === 'tv') counts.tv++;
      else counts.movie++;
    }
    return counts;
  }, [allTorrents]);

  const filteredTorrents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allTorrents.filter((t) => {
      if (categoryTab !== 'all' && categoryTab !== 'history') {
        const cat = t.mediaCategory || (t.videoCount > 1 ? 'tv' : 'movie');
        if (cat !== categoryTab) return false;
      }
      if (
        q &&
        !t.name.toLowerCase().includes(q) &&
        !(t.tmdb?.title || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      if (filter === 'playable') return t.playableCount > 0;
      if (filter === 'downloading') return t.progress < 0.999;
      if (filter === 'scheduled') return t.nextDeleteAt !== null;
      return true;
    });
  }, [allTorrents, categoryTab, filter, query]);

  const detailCredits = detailHash ? creditsMap[detailHash] ?? null : null;

  const handleDeleteHistoryItem = async (id: number) => {
    await apiFetch(`/api/media/history/${id}`, { method: 'DELETE' }).catch(() => {});
    setWatchHistory((prev) => prev.filter((item) => item.id !== id));
    showToast('已从观看历史移除');
  };

  const detailTorrent = useMemo(
    () => allTorrents.find((t) => t.hash === detailHash) ?? null,
    [allTorrents, detailHash]
  );

  const detailFiles = detailHash ? filesMap[detailHash] || [] : [];
  const videoFiles = useMemo(
    () =>
      [...detailFiles]
        .filter((f) => f.isVideo)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    [detailFiles]
  );
  const otherFiles = useMemo(() => detailFiles.filter((f) => !f.isVideo), [detailFiles]);

  const handleDirectOrDetail = (t: TorrentSummary, preferPlay = false) => {
    if (preferPlay && t.primaryVideo?.existsOnDisk) {
      onPlay(t.hash, t.primaryVideo.index, t.tmdb?.title || parseMediaTitle(t.name).title);
      return;
    }
    if (t.playableCount === 1 && t.videoCount <= 1 && t.primaryVideo?.existsOnDisk && preferPlay) {
      onPlay(t.hash, t.primaryVideo.index, t.tmdb?.title || parseMediaTitle(t.name).title);
      return;
    }
    setDetailHash(t.hash);
  };

  const handleTogglePriority = async (hash: string, file: TorrentFileItem) => {
    const nextPrio = file.priority === 0 ? 1 : 0;
    try {
      await apiFetch(`/api/torrents/${encodeURIComponent(hash)}/files/priority`, {
        method: 'POST',
        body: JSON.stringify({ fileIndices: [file.index], priority: nextPrio }),
      });
      await fetchFiles(hash);
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '更新下载选择失败');
    }
  };

  const handleBatchVideoPriority = async (hash: string, priority: 0 | 1) => {
    const videos = (filesMap[hash] || []).filter((f) => f.isVideo).map((f) => f.index);
    if (videos.length === 0) return;
    try {
      await apiFetch(`/api/torrents/${encodeURIComponent(hash)}/files/priority`, {
        method: 'POST',
        body: JSON.stringify({ fileIndices: videos, priority }),
      });
      await fetchFiles(hash);
      onRefresh();
      showToast(priority === 1 ? '已勾选全部视频' : '已取消全部下载');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '批量更新失败');
    }
  };

  const handleToggleBinge = async (t: TorrentSummary) => {
    try {
      await apiFetch(`/api/torrents/${encodeURIComponent(t.hash)}/binge`, {
        method: 'POST',
        body: JSON.stringify({ bingeMode: !t.bingeMode }),
      });
      showToast(!t.bingeMode ? '已开启追剧托管（自动预载下集）' : '已关闭追剧托管');
      if (detailHash === t.hash) await fetchFiles(t.hash);
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换失败');
    }
  };

  const handlePauseResume = async (t: TorrentSummary) => {
    const isPaused =
      t.state.toLowerCase().includes('paused') || t.state.toLowerCase().includes('stopped');
    try {
      await apiFetch(
        `/api/torrents/${encodeURIComponent(t.hash)}/${isPaused ? 'resume' : 'pause'}`,
        { method: 'POST' }
      );
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleToggleSequential = async (t: TorrentSummary) => {
    try {
      await apiFetch(`/api/torrents/${encodeURIComponent(t.hash)}/sequential`, {
        method: 'POST',
      });
      showToast(t.sequential ? '已关闭边下边播' : '已开启边下边播');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换失败');
    }
  };

  const handleSearchTmdb = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tmdbQuery.trim()) return;
    setTmdbSearching(true);
    try {
      const res = await apiFetch<{ results: TmdbMeta[] }>(
        `/api/tmdb/search?q=${encodeURIComponent(tmdbQuery.trim())}`
      );
      setTmdbResults(res.results);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '海报搜索失败');
    } finally {
      setTmdbSearching(false);
    }
  };

  const handleBindTmdb = async (hash: string, candidate: TmdbMeta | null) => {
    try {
      await apiFetch(`/api/torrents/${encodeURIComponent(hash)}/tmdb`, {
        method: 'POST',
        body: JSON.stringify(candidate ? { candidate } : { clear: true }),
      });
      setTmdbSearchOpen(false);
      showToast(candidate ? `已匹配海报：${candidate.title}` : '已恢复本地抽帧封面');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '更新海报失败');
    }
  };

  const handleTogglePin = async (hash: string, file: TorrentFileItem) => {
    const nextPinned = !(file.media?.pinned ?? false);
    try {
      await apiFetch(`/api/media/${encodeURIComponent(hash)}/${file.index}/pin`, {
        method: 'POST',
        body: JSON.stringify({
          pinned: nextPinned,
          relativePath: file.name,
          sizeBytes: file.size,
        }),
      });
      showToast(nextPinned ? '已锁定，自动清理将跳过' : '已取消锁定');
      await fetchFiles(hash);
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleUnloadFile = async (hash: string, file: TorrentFileItem) => {
    if (!confirm(`确定卸载该集并释放硬盘空间？\n${file.name.split('/').pop()}`)) return;
    try {
      const res = await apiFetch<{ freedBytes: number; deletedTorrent: boolean }>(
        `/api/media/${encodeURIComponent(hash)}/${file.index}`,
        { method: 'DELETE' }
      );
      showToast(`已释放 ${formatBytes(res.freedBytes)}`);
      if (res.deletedTorrent) {
        setDetailHash(null);
      } else {
        await fetchFiles(hash);
      }
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '卸载失败');
    }
  };

  const handleCancelDelete = async (hash: string, file: TorrentFileItem) => {
    try {
      await apiFetch(`/api/media/${encodeURIComponent(hash)}/${file.index}/cancel-delete`, {
        method: 'POST',
      });
      showToast('已取消定时清理');
      await fetchFiles(hash);
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleDeleteTorrent = async (t: TorrentSummary) => {
    if (!confirm(`确定卸载《${t.tmdb?.title || parseMediaTitle(t.name).title}》并删除本地文件？`)) {
      return;
    }
    try {
      const res = await apiFetch<{ freedBytes: number }>(
        `/api/torrents/${encodeURIComponent(t.hash)}`,
        { method: 'DELETE' }
      );
      showToast(`已卸载，释放 ${formatBytes(res.freedBytes)}`);
      if (detailHash === t.hash) setDetailHash(null);
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '卸载失败');
    }
  };

  const heroParsed = heroItem ? parseMediaTitle(heroItem.name) : null;
  const heroBg =
    heroItem?.tmdb?.backdropUrl ||
    (heroItem?.primaryVideo?.existsOnDisk
      ? `/api/stream/${encodeURIComponent(heroItem.hash)}/${heroItem.primaryVideo.index}/thumb?slot=1`
      : '');

  return (
    <div className="space-y-8">
      {/* Floating Minimal Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 cinema-glass px-5 py-2.5 rounded-full text-xs text-white shadow-2xl">
          {toast}
        </div>
      )}

      {/* Offline Banner */}
      {data && !data.qbitConnected && (
        <div className="rounded-2xl border border-amber-400/25 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs">
            <div className="font-medium text-amber-200">下载引擎正在启动中</div>
            <p className="text-amber-200/75 mt-0.5">
              容器刚启动时请稍等 5–10 秒，页面将自动重连。{data.qbitError ? `（${data.qbitError}）` : ''}
            </p>
          </div>
        </div>
      )}

      {/* ==================== EMPTY WELCOME STATE (or Watch History toggle) ==================== */}
      {allTorrents.length === 0 && categoryTab !== 'history' ? (
        <div className="cinema-surface rounded-3xl p-12 sm:p-16 text-center max-w-2xl mx-auto mt-6">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-white/[0.07] border border-white/10 flex items-center justify-center text-white mb-5">
            <Film className="w-6 h-6" />
          </div>
          <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-white">
            今晚想看点什么？
          </h2>
          <p className="text-sm text-zinc-400 mt-2.5 max-w-md mx-auto leading-relaxed">
            直接在线搜索片源一键边下边播，或粘贴磁力链接。支持自动追更、原生直出，看完自动释放硬盘空间。
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <button onClick={() => onGoDiscover()} className="btn-ivory px-6 py-2.5 text-sm">
              <Compass className="w-4 h-4" />
              去发现片源
            </button>
            <button onClick={onOpenAdd} className="btn-ghost px-5 py-2.5 text-sm">
              <Plus className="w-4 h-4" />
              粘贴磁力 / 上传种子
            </button>
            <button
              onClick={() => setCategoryTab('history')}
              className="btn-ghost px-5 py-2.5 text-sm"
            >
              <History className="w-4 h-4" />
              观看历史
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* ==================== CINEMATIC HERO SPOTLIGHT ==================== */}
          {heroItem && !query.trim() && filter === 'all' && categoryTab === 'all' && (
            <section className="relative rounded-3xl overflow-hidden border border-white/[0.08] bg-[#111115] min-h-[290px] sm:min-h-[360px] flex items-end shadow-[0_28px_70px_-24px_rgba(0,0,0,0.95)]">
              {heroBg && (
                <img
                  src={heroBg}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover opacity-55 scale-[1.01]"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-r from-[#09090b] via-[#09090b]/75 to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-t from-[#09090b] via-transparent to-black/20" />

              <div className="relative z-10 p-6 sm:p-10 max-w-2xl space-y-4">
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <span className="px-2.5 py-0.5 rounded-full bg-white/15 backdrop-blur-md text-white font-medium">
                    {heroItem.watchProgress > 0.01 && heroItem.watchProgress < 0.95
                      ? `继续观看 · ${Math.round(heroItem.watchProgress * 100)}%`
                      : heroItem.playableCount > 0
                        ? '片库精选'
                        : '正在下载'}
                  </span>
                  {heroItem.tmdb && heroItem.tmdb.rating > 0 && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-400/15 border border-amber-400/30 text-amber-300 tabular-nums">
                      <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                      {heroItem.tmdb.rating.toFixed(1)}
                    </span>
                  )}
                  {heroParsed?.resolution && (
                    <span className="px-2.5 py-0.5 rounded-full bg-white/10 text-zinc-200">
                      {heroParsed.resolution}
                    </span>
                  )}
                  {(heroItem.tmdb?.year || heroParsed?.year) && (
                    <span className="text-zinc-400">
                      {heroItem.tmdb?.year || heroParsed?.year}
                    </span>
                  )}
                  <span className="text-zinc-400 tabular-nums">
                    {formatBytes(heroItem.size)}
                    {heroItem.videoCount > 1 ? ` · 共 ${heroItem.videoCount} 集` : ''}
                  </span>
                </div>

                <h1 className="text-2xl sm:text-4xl font-semibold tracking-tight text-white leading-tight">
                  {heroItem.tmdb?.title || heroParsed?.title || heroItem.name}
                </h1>

                {heroItem.tmdb?.overview && (
                  <p className="text-xs sm:text-sm text-zinc-300/90 line-clamp-2 leading-relaxed max-w-xl">
                    {heroItem.tmdb.overview}
                  </p>
                )}

                <div className="flex items-center gap-3 pt-1 flex-wrap">
                  {heroItem.primaryVideo?.existsOnDisk ? (
                    <button
                      onClick={() => handleDirectOrDetail(heroItem, true)}
                      className="btn-ivory px-6 py-2.5 text-sm shadow-[0_8px_28px_rgba(255,255,255,0.2)]"
                    >
                      <Play className="w-4 h-4 fill-current" />
                      {heroItem.watchProgress > 0.01 ? '继续播放' : '立即播放'}
                    </button>
                  ) : null}

                  <button
                    onClick={() => setDetailHash(heroItem.hash)}
                    className="btn-ghost px-5 py-2.5 text-sm backdrop-blur-md"
                  >
                    <Info className="w-4 h-4" />
                    {heroItem.videoCount > 1 ? '选集与详情' : '影片详情'}
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* ==================== CONTINUE WATCHING RAIL ==================== */}
          {continueWatching.length > 1 && !query.trim() && filter === 'all' && categoryTab === 'all' && (
            <section className="space-y-3.5">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-white tracking-tight">继续观看</h2>
                <span className="text-xs text-zinc-500">{continueWatching.length} 部进行中</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {continueWatching.slice(0, 4).map((t) => {
                  const parsed = parseMediaTitle(t.name);
                  const title = t.tmdb?.title || parsed.title;
                  const wp = Math.round(t.watchProgress * 100);
                  return (
                    <button
                      key={t.hash}
                      onClick={() => handleDirectOrDetail(t, true)}
                      className="cinema-card group rounded-2xl overflow-hidden text-left"
                    >
                      <div className="relative aspect-video w-full overflow-hidden">
                        <CinemaThumb
                          hash={t.hash}
                          fileIndex={t.primaryVideo?.index}
                          existsOnDisk={t.primaryVideo?.existsOnDisk}
                          title={title}
                          progress={t.progress}
                          tmdbBackdrop={t.tmdb?.backdropUrl || t.tmdb?.posterUrl}
                        />
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition bg-black/30">
                          <div className="w-11 h-11 rounded-full bg-white text-zinc-950 flex items-center justify-center shadow-xl">
                            <Play className="w-4 h-4 fill-current ml-0.5" />
                          </div>
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/15">
                          <div className="h-full bg-white" style={{ width: `${wp}%` }} />
                        </div>
                      </div>
                      <div className="px-3.5 py-3 flex items-center justify-between gap-2">
                        <div className="text-xs font-medium text-zinc-100 truncate">{title}</div>
                        <span className="text-[11px] text-zinc-400 tabular-nums shrink-0">
                          {wp}%
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* ==================== CATEGORY COLLECTIONS & POSTER WALL ==================== */}
          <section className="space-y-4">
            {/* Primary Collection Tabs (Movies / TV / Anime / History) */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0">
                {(
                  [
                    { id: 'all' as const, label: `全部片库`, count: allTorrents.length, icon: Film },
                    { id: 'movie' as const, label: `电影`, count: categoryCounts.movie, icon: Clapperboard },
                    { id: 'tv' as const, label: `剧集`, count: categoryCounts.tv, icon: Tv },
                    { id: 'anime' as const, label: `动漫`, count: categoryCounts.anime, icon: AnimeIcon },
                    { id: 'history' as const, label: `观看历史`, count: null, icon: History },
                  ]
                ).map((c) => {
                  const Icon = c.icon;
                  const active = categoryTab === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setCategoryTab(c.id)}
                      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-medium whitespace-nowrap transition ${
                        active
                          ? 'bg-white text-zinc-950 shadow-sm'
                          : 'bg-white/[0.04] text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.08]'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{c.label}</span>
                      {c.count !== null && c.count > 0 && (
                        <span
                          className={`text-[10px] tabular-nums ${
                            active ? 'text-zinc-600' : 'text-zinc-500'
                          }`}
                        >
                          {c.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {categoryTab !== 'history' && (
                <div className="flex items-center gap-2">
                  <div className="relative flex-1 sm:w-52">
                    <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜索片库..."
                      className="w-full rounded-full bg-white/[0.04] border border-white/[0.08] pl-9 pr-3.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-white/25"
                    />
                  </div>

                  <div className="flex items-center p-0.5 rounded-full bg-white/[0.04] border border-white/[0.07]">
                    <button
                      onClick={() => setViewMode('grid')}
                      title="海报视图"
                      className={`p-1.5 rounded-full transition ${
                        viewMode === 'grid' ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      <LayoutGrid className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setViewMode('list')}
                      title="列表视图"
                      className={`p-1.5 rounded-full transition ${
                        viewMode === 'list' ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      <List className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Quiet Status Sub-Filters */}
            {categoryTab !== 'history' && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {(
                  [
                    { id: 'all', label: '全部状态' },
                    { id: 'playable', label: '可直接播' },
                    { id: 'downloading', label: '下载中' },
                    { id: 'scheduled', label: '待自动清理' },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    className={`px-3 py-1 rounded-full text-[11px] transition ${
                      filter === f.id
                        ? 'bg-white/15 text-white font-medium'
                        : 'text-zinc-500 hover:text-zinc-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            )}

            {categoryTab === 'history' ? (
              /* ==================== PERMANENT WATCH HISTORY WALL ==================== */
              loadingHistory ? (
                <div className="cinema-surface rounded-3xl p-12 text-center text-xs text-zinc-400">
                  正在加载观看历史...
                </div>
              ) : watchHistory.length === 0 ? (
                <div className="cinema-surface rounded-3xl p-12 text-center space-y-2">
                  <History className="w-7 h-7 text-zinc-600 mx-auto" />
                  <div className="text-sm text-zinc-300">暂无观看历史</div>
                  <p className="text-xs text-zinc-500">
                    播放影片后会自动记录在这里，即便文件看完后被自动卸载也会保留你的观影足迹。
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {watchHistory.map((h) => {
                    const wp = Math.min(100, Math.round(h.progress * 100));
                    const art = h.backdropUrl || h.posterUrl;
                    return (
                      <div
                        key={h.id}
                        className="cinema-card rounded-2xl overflow-hidden flex flex-col"
                      >
                        <div className="relative aspect-video w-full bg-gradient-to-br from-zinc-900 to-zinc-950 overflow-hidden">
                          {art ? (
                            <img src={art} alt="" className="w-full h-full object-cover opacity-80" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Film className="w-7 h-7 text-zinc-700" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent" />

                          <div className="absolute top-3 left-3 flex items-center gap-1.5">
                            <span
                              className={`px-2.5 py-0.5 rounded-full text-[10px] backdrop-blur-md ${
                                h.completed
                                  ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/30'
                                  : 'bg-black/60 text-zinc-200'
                              }`}
                            >
                              {h.completed ? '已看完' : `看到 ${wp}%`}
                            </span>
                            {!h.stillInLibrary && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-black/60 text-zinc-400 backdrop-blur-md">
                                已自动释放空间
                              </span>
                            )}
                          </div>

                          <button
                            onClick={() => void handleDeleteHistoryItem(h.id)}
                            title="删除该条记录"
                            className="absolute top-2.5 right-2.5 p-1.5 rounded-full bg-black/50 hover:bg-rose-500/80 text-zinc-300 hover:text-white transition"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>

                          <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/10">
                            <div
                              className={h.completed ? 'h-full bg-emerald-400' : 'h-full bg-white'}
                              style={{ width: `${wp}%` }}
                            />
                          </div>
                        </div>

                        <div className="p-4 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-white truncate" title={h.title}>
                              {h.title}
                            </div>
                            <div className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-1.5 tabular-nums">
                              {h.year && <span>{h.year}</span>}
                              {h.durationSec > 0 && (
                                <>
                                  {h.year && <span>·</span>}
                                  <span>
                                    {formatDuration(h.positionSec)} / {formatDuration(h.durationSec)}
                                  </span>
                                </>
                              )}
                              <span>·</span>
                              <span>{new Date(h.watchedAt).toLocaleDateString()}</span>
                            </div>
                          </div>

                          {h.stillInLibrary ? (
                            <button
                              onClick={() => onPlay(h.torrentHash, h.fileIndex, h.title)}
                              className="btn-ivory px-3.5 py-1.5 text-xs shrink-0"
                            >
                              <Play className="w-3 h-3 fill-current" />
                              重看
                            </button>
                          ) : (
                            <button
                              onClick={() => onGoDiscover(h.title)}
                              className="btn-ghost px-3 py-1.5 text-xs shrink-0"
                            >
                              <Compass className="w-3 h-3" />
                              再搜
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            ) : filteredTorrents.length === 0 ? (
              <div className="cinema-surface rounded-3xl p-12 text-center text-sm text-zinc-400">
                当前筛选下没有匹配的影片
              </div>
            ) : viewMode === 'grid' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {filteredTorrents.map((t) => {
                  const parsed = parseMediaTitle(t.name);
                  const displayTitle = t.tmdb?.title || parsed.title;
                  const displayYear = t.tmdb?.year || parsed.year;
                  const pct = Math.min(100, Math.round(t.progress * 1000) / 10);
                  const st = translateTorrentState(t.state);

                  return (
                    <div
                      key={t.hash}
                      onClick={() => setDetailHash(t.hash)}
                      className="cinema-card group rounded-2xl overflow-hidden cursor-pointer flex flex-col"
                    >
                      {/* Clean 16:9 Cinema Stage */}
                      <div className="relative aspect-video w-full overflow-hidden">
                        <CinemaThumb
                          hash={t.hash}
                          fileIndex={t.primaryVideo?.index}
                          existsOnDisk={t.primaryVideo?.existsOnDisk}
                          title={displayTitle}
                          progress={t.progress}
                          tmdbBackdrop={t.tmdb?.backdropUrl || t.tmdb?.posterUrl}
                          hoverCycling
                        />

                        {/* Quiet Top-Left Status (only when active/not yet complete) */}
                        <div className="absolute top-3 left-3 flex items-center gap-1.5">
                          {pct < 100 && (
                            <span
                              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] border backdrop-blur-md ${st.badge}`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                              {t.dlSpeed > 0 ? `${pct.toFixed(0)}% · ${formatSpeed(t.dlSpeed)}` : st.label}
                            </span>
                          )}
                          {t.bingeMode && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-amber-500/20 border border-amber-400/30 text-amber-200 backdrop-blur-md">
                              <Repeat className="w-3 h-3" />
                              追剧
                            </span>
                          )}
                        </div>

                        {/* Top-Right Spec & Rating */}
                        <div className="absolute top-3 right-3 flex items-center gap-1.5">
                          {t.tmdb && t.tmdb.rating > 0 && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-black/60 backdrop-blur-md text-amber-300 tabular-nums">
                              <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />
                              {t.tmdb.rating.toFixed(1)}
                            </span>
                          )}
                          {parsed.resolution && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-black/60 backdrop-blur-md text-zinc-100">
                              {parsed.resolution}
                            </span>
                          )}
                        </div>

                        {/* Center Floating Play Orb on Hover */}
                        {t.primaryVideo?.existsOnDisk && (
                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition duration-200 bg-black/25">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDirectOrDetail(t, true);
                              }}
                              className="w-12 h-12 rounded-full bg-white text-zinc-950 flex items-center justify-center shadow-[0_8px_30px_rgba(0,0,0,0.6)] hover:scale-105 transition"
                              title="立即播放"
                            >
                              <Play className="w-5 h-5 fill-current ml-0.5" />
                            </button>
                          </div>
                        )}

                        {t.nextDeleteAt && (
                          <div className="absolute bottom-2.5 left-3 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] bg-rose-500/25 border border-rose-400/35 text-rose-200 backdrop-blur-md">
                            <Clock className="w-2.5 h-2.5" />
                            {formatCountdown(t.nextDeleteAt)}
                          </div>
                        )}

                        {/* Hairline Progress Bar */}
                        {(pct < 100 || t.watchProgress > 0.01) && (
                          <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/10">
                            <div
                              className={`h-full transition-all ${
                                pct < 100 ? 'bg-amber-400' : 'bg-white'
                              }`}
                              style={{
                                width: `${pct < 100 ? pct : Math.round(t.watchProgress * 100)}%`,
                              }}
                            />
                          </div>
                        )}
                      </div>

                      {/* Quiet Editorial Card Footer */}
                      <div className="px-4 py-3.5 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <h3
                            className="text-sm font-medium text-zinc-100 truncate group-hover:text-white transition"
                            title={t.name}
                          >
                            {displayTitle}
                          </h3>
                          <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-400 tabular-nums">
                            {displayYear && <span>{displayYear}</span>}
                            {displayYear && <span className="text-zinc-600">·</span>}
                            <span>{formatBytes(t.size)}</span>
                            {t.videoCount > 1 && (
                              <>
                                <span className="text-zinc-600">·</span>
                                <span>{t.videoCount} 集</span>
                              </>
                            )}
                            {t.watchedCount > 0 && (
                              <>
                                <span className="text-zinc-600">·</span>
                                <span className="text-emerald-400">已看 {t.watchedCount}</span>
                              </>
                            )}
                          </div>
                        </div>

                        <span className="text-[11px] text-zinc-500 group-hover:text-zinc-200 shrink-0 transition">
                          详情 →
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Clean List View */
              <div className="cinema-surface rounded-2xl divide-y divide-white/[0.06] overflow-hidden">
                {filteredTorrents.map((t) => {
                  const parsed = parseMediaTitle(t.name);
                  const displayTitle = t.tmdb?.title || parsed.title;
                  const pct = Math.min(100, Math.round(t.progress * 1000) / 10);
                  return (
                    <div
                      key={t.hash}
                      onClick={() => setDetailHash(t.hash)}
                      className="p-3.5 flex items-center justify-between gap-4 hover:bg-white/[0.03] cursor-pointer transition"
                    >
                      <div className="flex items-center gap-3.5 min-w-0 flex-1">
                        <div className="w-24 aspect-video rounded-xl overflow-hidden shrink-0 border border-white/[0.08]">
                          <CinemaThumb
                            hash={t.hash}
                            fileIndex={t.primaryVideo?.index}
                            existsOnDisk={t.primaryVideo?.existsOnDisk}
                            title={displayTitle}
                            progress={t.progress}
                            tmdbBackdrop={t.tmdb?.backdropUrl || t.tmdb?.posterUrl}
                            compact
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-white truncate">{displayTitle}</div>
                          <div className="text-xs text-zinc-400 mt-0.5 flex items-center gap-2 flex-wrap tabular-nums">
                            <span>{formatBytes(t.size)}</span>
                            {parsed.resolution && <span>· {parsed.resolution}</span>}
                            {t.videoCount > 1 && <span>· {t.videoCount} 集</span>}
                            {pct < 100 && <span className="text-amber-300">· 下载 {pct.toFixed(0)}%</span>}
                            {t.nextDeleteAt && (
                              <span className="text-rose-300">· {formatCountdown(t.nextDeleteAt)}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {t.primaryVideo?.existsOnDisk && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDirectOrDetail(t, true);
                            }}
                            className="btn-ivory px-3.5 py-1.5 text-xs"
                          >
                            <Play className="w-3 h-3 fill-current" />
                            播放
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {/* ==================== IMMERSIVE MEDIA DETAIL MODAL ==================== */}
      {detailHash && detailTorrent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-3 sm:p-6"
          onClick={() => setDetailHash(null)}
        >
          <div
            className="w-full max-w-3xl max-h-[90vh] cinema-glass rounded-3xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Blurred Cinema Backdrop Hero Header */}
            <div className="relative p-6 sm:p-7 border-b border-white/[0.08] overflow-hidden shrink-0">
              {(detailTorrent.tmdb?.backdropUrl || detailTorrent.primaryVideo?.existsOnDisk) && (
                <img
                  src={
                    detailTorrent.tmdb?.backdropUrl ||
                    `/api/stream/${encodeURIComponent(detailTorrent.hash)}/${detailTorrent.primaryVideo!.index}/thumb?slot=0`
                  }
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover opacity-30 blur-sm scale-105"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-[#121216] via-[#121216]/75 to-[#121216]/40" />

              <div className="relative z-10 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap text-xs text-zinc-300">
                      {detailTorrent.tmdb && detailTorrent.tmdb.rating > 0 && (
                        <span className="inline-flex items-center gap-1 text-amber-300 font-medium">
                          <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                          {detailTorrent.tmdb.rating.toFixed(1)}
                        </span>
                      )}
                      {(detailTorrent.tmdb?.year || parseMediaTitle(detailTorrent.name).year) && (
                        <span>
                          {detailTorrent.tmdb?.year || parseMediaTitle(detailTorrent.name).year}
                        </span>
                      )}
                      {parseMediaTitle(detailTorrent.name).resolution && (
                        <span className="px-2 py-0.5 rounded-full bg-white/10 text-[11px]">
                          {parseMediaTitle(detailTorrent.name).resolution}
                        </span>
                      )}
                      <span className="tabular-nums text-zinc-400">
                        已占 {formatBytes(detailTorrent.size)}
                        {detailTorrent.totalSize > detailTorrent.size
                          ? ` / 整包 ${formatBytes(detailTorrent.totalSize)}`
                          : ''}
                      </span>
                    </div>
                    <h2 className="text-xl sm:text-2xl font-semibold text-white mt-1.5 leading-snug">
                      {detailTorrent.tmdb?.title || parseMediaTitle(detailTorrent.name).title}
                    </h2>
                    {detailTorrent.tmdb?.overview && (
                      <p className="text-xs text-zinc-300/90 mt-1.5 line-clamp-2 leading-relaxed">
                        {detailTorrent.tmdb.overview}
                      </p>
                    )}
                    {detailCredits && (detailCredits.genres.length > 0 || detailCredits.directors.length > 0 || detailCredits.runtimeMin > 0) && (
                      <div className="flex items-center gap-2 flex-wrap mt-2 text-[11px] text-zinc-300">
                        {detailCredits.genres.map((g) => (
                          <span key={g} className="px-2 py-0.5 rounded-full bg-white/[0.08]">
                            {g}
                          </span>
                        ))}
                        {detailCredits.runtimeMin > 0 && (
                          <span className="text-zinc-400">{detailCredits.runtimeMin} 分钟</span>
                        )}
                        {detailCredits.directors.length > 0 && (
                          <span className="text-zinc-400">
                            导演：{detailCredits.directors.join(' / ')}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="text-[11px] text-zinc-500 mt-1.5 truncate" title={detailTorrent.name}>
                      {detailTorrent.name}
                    </div>
                  </div>
                  <button
                    onClick={() => setDetailHash(null)}
                    className="p-2 rounded-full bg-black/40 hover:bg-white/15 text-zinc-300 hover:text-white transition shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Primary & Management Pills */}
                <div className="flex items-center gap-2 flex-wrap pt-1">
                  {detailTorrent.primaryVideo?.existsOnDisk && (
                    <button
                      onClick={() => {
                        const target = detailTorrent.primaryVideo!;
                        setDetailHash(null);
                        onPlay(
                          detailTorrent.hash,
                          target.index,
                          detailTorrent.tmdb?.title || parseMediaTitle(detailTorrent.name).title
                        );
                      }}
                      className="btn-ivory px-5 py-2 text-xs"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      立即播放
                    </button>
                  )}

                  <button
                    onClick={() => void handleToggleBinge(detailTorrent)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs border transition ${
                      detailTorrent.bingeMode
                        ? 'bg-amber-400/20 border-amber-400/40 text-amber-200'
                        : 'bg-white/[0.06] border-white/[0.08] text-zinc-300 hover:bg-white/[0.12]'
                    }`}
                  >
                    <Repeat className="w-3.5 h-3.5" />
                    追剧托管：{detailTorrent.bingeMode ? '开' : '关'}
                  </button>

                  <button
                    onClick={() => void handleToggleSequential(detailTorrent)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs border transition ${
                      detailTorrent.sequential
                        ? 'bg-white/12 border-white/20 text-white'
                        : 'bg-white/[0.05] border-white/[0.08] text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Zap className="w-3.5 h-3.5" />
                    边下边播
                  </button>

                  <button
                    onClick={() => void handlePauseResume(detailTorrent)}
                    className="btn-ghost px-3.5 py-2 text-xs"
                  >
                    {detailTorrent.state.toLowerCase().includes('paused') ||
                    detailTorrent.state.toLowerCase().includes('stopped') ? (
                      <>
                        <Play className="w-3.5 h-3.5" />
                        继续下载
                      </>
                    ) : (
                      <>
                        <Pause className="w-3.5 h-3.5" />
                        暂停
                      </>
                    )}
                  </button>

                  <button
                    onClick={() => {
                      setTmdbSearchOpen((v) => !v);
                      setTmdbQuery(
                        detailTorrent.tmdb?.title || parseMediaTitle(detailTorrent.name).title
                      );
                      setTmdbResults([]);
                    }}
                    className="btn-ghost px-3.5 py-2 text-xs"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                    匹配海报
                  </button>

                  <button
                    onClick={() => void handleDeleteTorrent(detailTorrent)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500 hover:text-white text-rose-300 transition ml-auto"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    卸载释放空间
                  </button>
                </div>
              </div>
            </div>

            {/* Inline TMDB Poster Matcher */}
            {tmdbSearchOpen && (
              <div className="px-6 py-4 border-b border-white/[0.07] bg-white/[0.02] space-y-3 shrink-0">
                <form onSubmit={handleSearchTmdb} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={tmdbQuery}
                    onChange={(e) => setTmdbQuery(e.target.value)}
                    placeholder="输入中/英文片名搜索 TMDB 海报与简介..."
                    className="cinema-input flex-1 px-3.5 py-2 text-xs"
                  />
                  <button
                    type="submit"
                    disabled={tmdbSearching}
                    className="btn-ivory px-4 py-2 text-xs"
                  >
                    {tmdbSearching ? '搜索中...' : '搜索'}
                  </button>
                  {detailTorrent.tmdb && (
                    <button
                      type="button"
                      onClick={() => void handleBindTmdb(detailHash, null)}
                      className="btn-ghost px-3 py-2 text-xs text-rose-300"
                    >
                      恢复默认
                    </button>
                  )}
                </form>

                {tmdbResults.length > 0 && (
                  <div className="max-h-48 overflow-y-auto divide-y divide-white/[0.06] rounded-xl border border-white/[0.08] bg-[#0c0c0f]">
                    {tmdbResults.map((c) => (
                      <button
                        key={`${c.mediaType}-${c.tmdbId}`}
                        onClick={() => void handleBindTmdb(detailHash, c)}
                        className="w-full text-left p-2.5 flex items-center gap-3 hover:bg-white/[0.06] transition"
                      >
                        {c.posterUrl && (
                          <img
                            src={c.posterUrl}
                            alt=""
                            className="w-8 h-12 rounded object-cover shrink-0"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-white truncate">
                            {c.title}{' '}
                            <span className="text-zinc-500">({c.year || '--'})</span>
                          </div>
                          <div className="text-[11px] text-zinc-400 truncate">{c.overview}</div>
                        </div>
                        <span className="text-xs text-amber-300 shrink-0 tabular-nums">
                          ★ {c.rating}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Video Episodes + Cast Section */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* Cast & Crew Horizontal Strip (when TMDB credits exist) */}
              {detailCredits && detailCredits.cast.length > 0 && (
                <div className="space-y-2.5 pb-4 border-b border-white/[0.06]">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                    <Users className="w-3.5 h-3.5 text-zinc-400" />
                    演职员表
                  </div>
                  <div className="flex items-start gap-3 overflow-x-auto pb-1">
                    {detailCredits.cast.map((actor) => (
                      <div key={actor.id} className="w-16 shrink-0 text-center space-y-1">
                        <div className="w-14 h-14 mx-auto rounded-full overflow-hidden bg-white/[0.06] border border-white/10 flex items-center justify-center">
                          {actor.profileUrl ? (
                            <img
                              src={actor.profileUrl}
                              alt={actor.name}
                              loading="lazy"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <span className="text-xs text-zinc-500">
                              {actor.name.slice(0, 1)}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-zinc-200 truncate" title={actor.name}>
                          {actor.name}
                        </div>
                        {actor.character && (
                          <div
                            className="text-[10px] text-zinc-500 truncate"
                            title={actor.character}
                          >
                            {actor.character}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-zinc-300">
                  剧集与视频文件 ({videoFiles.length})
                  {loadingFiles && <span className="text-zinc-500 ml-2">同步中...</span>}
                </div>
                {videoFiles.length > 1 && (
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      onClick={() => void handleBatchVideoPriority(detailHash, 1)}
                      className="text-zinc-300 hover:text-white transition"
                    >
                      全选下载
                    </button>
                    <span className="text-zinc-700">·</span>
                    <button
                      onClick={() => void handleBatchVideoPriority(detailHash, 0)}
                      className="text-zinc-400 hover:text-zinc-200 transition"
                    >
                      全部跳过
                    </button>
                  </div>
                )}
              </div>

              {detailFiles.length === 0 ? (
                <div className="py-12 text-center text-xs text-zinc-500">
                  正在等待种子元数据解析...
                </div>
              ) : (
                <div className="space-y-2.5">
                  {videoFiles.map((f, idx) => {
                    const shortName = f.name.split('/').pop() || f.name;
                    const dlPct = Math.round(f.progress * 1000) / 10;
                    const watchPct = Math.round((f.media?.progress ?? 0) * 100);
                    const isWatched = Boolean(f.media?.watchedAt);
                    const isPinned = Boolean(f.media?.pinned);
                    const scheduled = f.media?.deleteAfterAt ?? null;
                    const selected = f.priority > 0;

                    return (
                      <div
                        key={f.index}
                        className={`p-3 rounded-2xl border flex items-center justify-between gap-3 transition ${
                          selected
                            ? 'bg-white/[0.03] border-white/[0.08] hover:border-white/[0.15]'
                            : 'bg-white/[0.01] border-white/[0.04] opacity-65'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div
                            onClick={() => {
                              if (f.existsOnDisk) {
                                setDetailHash(null);
                                onPlay(
                                  detailHash,
                                  f.index,
                                  detailTorrent.tmdb?.title || parseMediaTitle(detailTorrent.name).title
                                );
                              }
                            }}
                            className={`relative w-24 aspect-video rounded-xl overflow-hidden shrink-0 border border-white/[0.08] ${
                              f.existsOnDisk ? 'cursor-pointer group' : 'opacity-50'
                            }`}
                          >
                            <CinemaThumb
                              hash={detailHash}
                              fileIndex={f.index}
                              existsOnDisk={f.existsOnDisk}
                              progress={f.progress}
                              compact
                            />
                            {f.existsOnDisk && (
                              <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition">
                                <Play className="w-4 h-4 fill-white text-white" />
                              </div>
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[11px] text-zinc-500 tabular-nums">
                                #{String(idx + 1).padStart(2, '0')}
                              </span>
                              <span
                                className={`text-xs font-medium truncate ${
                                  selected ? 'text-zinc-100' : 'text-zinc-500 line-through'
                                }`}
                                title={f.name}
                              >
                                {shortName}
                              </span>
                              {isWatched && (
                                <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/15 text-emerald-300">
                                  <CheckCircle2 className="w-2.5 h-2.5" />
                                  已看
                                </span>
                              )}
                              {isPinned && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] bg-amber-400/15 text-amber-300">
                                  已锁定
                                </span>
                              )}
                              {scheduled && !isPinned && !f.media?.removedFile && (
                                <button
                                  onClick={() => void handleCancelDelete(detailHash, f)}
                                  className="px-2 py-0.5 rounded-full text-[10px] bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                                >
                                  {formatCountdown(scheduled)} · 撤销
                                </button>
                              )}
                            </div>

                            <div className="mt-1 flex items-center gap-2.5 text-[11px] text-zinc-400 tabular-nums">
                              <span>{formatBytes(f.size)}</span>
                              {selected ? (
                                <span className={dlPct >= 100 ? 'text-emerald-400' : 'text-amber-300'}>
                                  {dlPct >= 100 ? '已就绪' : `下载 ${dlPct.toFixed(1)}%`}
                                </span>
                              ) : (
                                <span className="text-zinc-500">未下载</span>
                              )}
                              {watchPct > 0 && <span>看到 {watchPct}%</span>}
                              {f.media?.removedFile && <span className="text-zinc-500">已卸载</span>}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {f.existsOnDisk ? (
                            <button
                              onClick={() => {
                                setDetailHash(null);
                                onPlay(
                                  detailHash,
                                  f.index,
                                  detailTorrent.tmdb?.title || parseMediaTitle(detailTorrent.name).title
                                );
                              }}
                              className="btn-ivory px-3 py-1.5 text-xs"
                            >
                              <Play className="w-3 h-3 fill-current" />
                              播放
                            </button>
                          ) : (
                            <button
                              onClick={() => void handleTogglePriority(detailHash, f)}
                              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs border transition ${
                                selected
                                  ? 'bg-amber-400/15 border-amber-400/30 text-amber-200'
                                  : 'bg-white/[0.06] border-white/10 text-zinc-200 hover:bg-white/[0.12]'
                              }`}
                            >
                              <Download className="w-3 h-3" />
                              {selected ? '跳过' : '下载'}
                            </button>
                          )}

                          <button
                            onClick={() => void handleTogglePin(detailHash, f)}
                            title={isPinned ? '解除锁定' : '锁定防止自动卸载'}
                            className={`p-2 rounded-full border transition ${
                              isPinned
                                ? 'bg-amber-400/15 border-amber-400/35 text-amber-300'
                                : 'border-white/[0.08] text-zinc-400 hover:text-white hover:bg-white/[0.06]'
                            }`}
                          >
                            <Pin className="w-3.5 h-3.5" />
                          </button>

                          {f.existsOnDisk && (
                            <button
                              onClick={() => void handleUnloadFile(detailHash, f)}
                              title="卸载本集释放空间"
                              className="p-2 rounded-full border border-white/[0.08] text-zinc-400 hover:text-rose-300 hover:border-rose-400/40 hover:bg-rose-500/10 transition"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Collapsible Non-Video Files */}
              {otherFiles.length > 0 && (
                <div className="pt-2 border-t border-white/[0.06]">
                  <button
                    onClick={() => setShowOtherFiles((v) => !v)}
                    className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    其他附属文件 ({otherFiles.length})
                    {showOtherFiles ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>

                  {showOtherFiles && (
                    <div className="mt-2.5 space-y-1.5">
                      {otherFiles.map((f) => (
                        <div
                          key={f.index}
                          className="px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.05] flex items-center justify-between gap-3 text-xs"
                        >
                          <label className="flex items-center gap-2.5 min-w-0 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={f.priority > 0}
                              onChange={() => void handleTogglePriority(detailHash, f)}
                              className="accent-white rounded"
                            />
                            <span className="text-zinc-400 truncate">{f.name.split('/').pop()}</span>
                          </label>
                          <span className="text-[11px] text-zinc-500 tabular-nums shrink-0">
                            {formatBytes(f.size)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
