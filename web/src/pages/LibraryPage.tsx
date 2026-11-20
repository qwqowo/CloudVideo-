import React, { useEffect, useMemo, useState } from 'react';
import {
  Play,
  Pause,
  Trash2,
  Zap,
  Pin,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Film,
  FileText,
  RefreshCw,
  Plus,
  Search,
  LayoutGrid,
  List,
  SlidersHorizontal,
  X,
  HardDrive,
  ArrowDown,
  Repeat,
  Star,
  CheckSquare,
  Sparkles,
} from 'lucide-react';
import type { TmdbMeta, TorrentFileItem, TorrentsResponse, TorrentSummary } from '../types';
import {
  apiFetch,
  formatBytes,
  formatCountdown,
  formatSpeed,
  parseMediaTitle,
  translateTorrentState,
} from '../lib/api';

interface LibraryPageProps {
  data: TorrentsResponse | null;
  loading: boolean;
  onRefresh: () => void;
  onOpenAdd: () => void;
  onPlay: (torrentHash: string, fileIndex: number, torrentName: string) => void;
}

type FilterMode = 'all' | 'playable' | 'downloading' | 'scheduled';
type ViewMode = 'grid' | 'list';

const MediaThumb: React.FC<{
  hash: string;
  fileIndex?: number;
  existsOnDisk?: boolean;
  resolution?: string;
  progress: number;
  tmdbBackdrop?: string;
  compact?: boolean;
  hoverCycling?: boolean;
}> = ({
  hash,
  fileIndex,
  existsOnDisk,
  resolution,
  progress,
  tmdbBackdrop,
  compact = false,
  hoverCycling = false,
}) => {
  const [slot, setSlot] = useState<0 | 1 | 2>(0);
  const [hovering, setHovering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // When hovering a card with a playable video on disk, cycle preview frames 0 -> 1 -> 2
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

  // Show TMDB backdrop at rest when available; when hovering a ready file, show real video preview frames!
  const activeSrc =
    hovering && hoverCycling && frameSrc
      ? frameSrc
      : tmdbBackdrop || frameSrc;

  useEffect(() => {
    setFailed(false);
  }, [activeSrc]);

  const code = hash.slice(0, 6).toUpperCase();
  const pct = Math.round(progress * 100);

  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className="relative w-full h-full bg-[#06090e] sci-grid-bg overflow-hidden select-none"
    >
      <div
        className={`absolute inset-0 flex flex-col items-center justify-center transition-opacity duration-300 ${
          loaded && !failed ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <div className="absolute inset-3 border border-white/[0.04] pointer-events-none" />
        {!compact ? (
          <>
            <div className="w-16 h-[1px] bg-cyan-400/20 mb-2.5" />
            <div className="text-[10px] font-mono tracking-[0.26em] text-zinc-500">
              UNIT // {code}
            </div>
            <div className="text-lg font-mono font-bold tracking-[0.16em] text-zinc-300/80 mt-1">
              {resolution || (pct >= 100 ? 'READY' : `${pct}%`)}
            </div>
            <div className="w-16 h-[1px] bg-cyan-400/20 mt-2.5" />
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
          className={`w-full h-full object-cover transition-all duration-500 group-hover:scale-[1.03] ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}

      {/* Multi-frame hover indicator dots */}
      {hoverCycling && hovering && existsOnDisk && (
        <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-2 py-0.5 bg-black/75 border border-white/15">
          {[0, 1, 2].map((idx) => (
            <span
              key={idx}
              className={`w-1.5 h-1.5 transition ${
                slot === idx ? 'bg-cyan-400' : 'bg-zinc-600'
              }`}
            />
          ))}
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#06090e] via-transparent to-black/45" />
    </div>
  );
};

export const LibraryPage: React.FC<LibraryPageProps> = ({
  data,
  loading,
  onRefresh,
  onOpenAdd,
  onPlay,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [query, setQuery] = useState('');
  const [batchMode, setBatchMode] = useState(false);
  const [selectedHashes, setSelectedHashes] = useState<Set<string>>(new Set());
  const [inspectorHash, setInspectorHash] = useState<string | null>(null);
  const [filesMap, setFilesMap] = useState<Record<string, TorrentFileItem[]>>({});
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [tmdbSearchOpen, setTmdbSearchOpen] = useState(false);
  const [tmdbQuery, setTmdbQuery] = useState('');
  const [tmdbResults, setTmdbResults] = useState<TmdbMeta[]>([]);
  const [tmdbSearching, setTmdbSearching] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3200);
  };

  const fetchFiles = async (hash: string) => {
    setLoadingFiles(true);
    try {
      const res = await apiFetch<{ hash: string; files: TorrentFileItem[] }>(
        `/api/torrents/${encodeURIComponent(hash)}/files`
      );
      setFilesMap((prev) => ({ ...prev, [hash]: res.files }));
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载文件列表失败');
    } finally {
      setLoadingFiles(false);
    }
  };

  useEffect(() => {
    if (!inspectorHash) {
      setTmdbSearchOpen(false);
      return;
    }
    void fetchFiles(inspectorHash);
    const id = setInterval(() => void fetchFiles(inspectorHash), 4000);
    return () => clearInterval(id);
  }, [inspectorHash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInspectorHash(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filteredTorrents = useMemo(() => {
    const list = data?.torrents ?? [];
    const q = query.trim().toLowerCase();
    return list.filter((t) => {
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
  }, [data?.torrents, filter, query]);

  const inspectorTorrent = useMemo(
    () => (data?.torrents ?? []).find((t) => t.hash === inspectorHash) ?? null,
    [data?.torrents, inspectorHash]
  );

  const inspectorFiles = inspectorHash ? filesMap[inspectorHash] || [] : [];

  const toggleSelectHash = (hash: string) => {
    setSelectedHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  const handleBatchAction = async (action: 'pause' | 'resume' | 'delete') => {
    const hashes = Array.from(selectedHashes);
    if (hashes.length === 0) return;
    if (action === 'delete' && !confirm(`确定彻底卸载选中的 ${hashes.length} 个种子及本地文件？`)) {
      return;
    }
    try {
      const res = await apiFetch<{ count: number; freedBytes: number }>('/api/torrents/batch', {
        method: 'POST',
        body: JSON.stringify({ action, hashes }),
      });
      showToast(
        action === 'delete'
          ? `批量卸载 ${res.count} 项，释放 ${formatBytes(res.freedBytes)}`
          : `已对 ${res.count} 项执行${action === 'pause' ? '暂停' : '恢复'}`
      );
      setSelectedHashes(new Set());
      setBatchMode(false);
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '批量操作失败');
    }
  };

  const handleQuickPlay = (t: TorrentSummary) => {
    if (batchMode) {
      toggleSelectHash(t.hash);
      return;
    }
    if (t.playableCount === 1 && t.primaryVideo?.existsOnDisk) {
      onPlay(t.hash, t.primaryVideo.index, t.tmdb?.title || t.name);
      return;
    }
    if (t.playableCount > 1) {
      setInspectorHash(t.hash);
      return;
    }
    if (t.primaryVideo?.existsOnDisk) {
      onPlay(t.hash, t.primaryVideo.index, t.tmdb?.title || t.name);
      return;
    }
    setInspectorHash(t.hash);
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
      showToast(priority === 1 ? '已勾选全部视频文件' : '已取消全部视频下载');
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
      showToast(!t.bingeMode ? '已启用追剧托管（自动预载下集）' : '已关闭追剧托管');
      if (inspectorHash === t.hash) await fetchFiles(t.hash);
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
      showToast(err instanceof Error ? err.message : 'TMDB 搜索失败');
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
      showToast(candidate ? `已绑定 TMDB：${candidate.title}` : '已清除 TMDB 绑定');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '更新 TMDB 失败');
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
      showToast(nextPinned ? '已锁定，自动清理将跳过' : '已解除锁定');
      await fetchFiles(hash);
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleUnloadFile = async (hash: string, file: TorrentFileItem) => {
    if (!confirm(`确定立即卸载此文件释放空间？\n${file.name}`)) return;
    try {
      const res = await apiFetch<{ freedBytes: number; deletedTorrent: boolean }>(
        `/api/media/${encodeURIComponent(hash)}/${file.index}`,
        { method: 'DELETE' }
      );
      showToast(
        res.deletedTorrent
          ? `已卸载文件并移除种子，释放 ${formatBytes(res.freedBytes)}`
          : `已卸载单集，释放 ${formatBytes(res.freedBytes)}`
      );
      if (res.deletedTorrent) {
        setInspectorHash(null);
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
      showToast('已撤销定时卸载');
      await fetchFiles(hash);
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '撤销失败');
    }
  };

  const handleDeleteTorrent = async (t: TorrentSummary) => {
    if (!confirm(`确定彻底卸载整个种子并删除本地文件？\n${t.name}`)) return;
    try {
      const res = await apiFetch<{ freedBytes: number }>(
        `/api/torrents/${encodeURIComponent(t.hash)}`,
        { method: 'DELETE' }
      );
      showToast(`已彻底卸载，释放 ${formatBytes(res.freedBytes)}`);
      if (inspectorHash === t.hash) setInspectorHash(null);
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败');
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
      showToast(t.sequential ? '已关闭顺序边下边播' : '已开启顺序边下边播');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换失败');
    }
  };

  const storage = data?.storage;
  const storagePct = storage?.usagePercent ?? 0;

  return (
    <div className="space-y-5">
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 hud-panel px-4 py-2.5 text-xs font-mono text-cyan-200 shadow-2xl">
          SYS // {toast}
        </div>
      )}

      {data && !data.qbitConnected && (
        <div className="border border-amber-500/40 bg-amber-950/30 p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs">
            <div className="font-mono font-semibold text-amber-200 tracking-wide">
              ENGINE OFFLINE // qBittorrent 尚未就绪
            </div>
            <p className="text-amber-200/75 mt-1">
              若刚启动容器，请稍等 5–10 秒后刷新；测速与存储设置不受影响。
              {data.qbitError ? `（${data.qbitError}）` : ''}
            </p>
          </div>
        </div>
      )}

      {/* Telemetry Command Bar */}
      <div className="hud-panel">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-white/[0.07]">
          <div className="px-4 py-3 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-mono tracking-[0.18em] text-zinc-500">
                ARCHIVE // TASKS
              </div>
              <div className="text-xl font-mono font-bold text-white mt-0.5">
                {String(data?.torrents.length ?? 0).padStart(2, '0')}
                <span className="text-xs font-normal text-zinc-500 ml-2">
                  可播 {(data?.torrents ?? []).filter((t) => t.playableCount > 0).length}
                </span>
              </div>
            </div>
            <Film className="w-4 h-4 text-cyan-400/70" />
          </div>

          <div className="px-4 py-3">
            <div className="flex items-center justify-between text-[10px] font-mono tracking-[0.18em] text-zinc-500">
              <span>STORAGE // WATERMARK</span>
              <span className={storagePct >= 85 ? 'text-rose-400' : 'text-cyan-400'}>
                {storagePct.toFixed(1)}%
              </span>
            </div>
            <div className="text-sm font-mono font-semibold text-white mt-1 flex items-baseline justify-between gap-2">
              <span>
                {storage
                  ? `${formatBytes(storage.usedBytes)} / ${formatBytes(storage.limitBytes)}`
                  : '--'}
              </span>
              {storage && storage.diskFreeBytes > 0 && (
                <span className="text-[10px] text-zinc-500">
                  余 {formatBytes(storage.diskFreeBytes)}
                </span>
              )}
            </div>
            <div className="mt-1.5 h-[2px] w-full bg-zinc-800">
              <div
                className={`h-full transition-all ${
                  storagePct >= 90
                    ? 'bg-rose-500'
                    : storagePct >= 75
                    ? 'bg-amber-400'
                    : 'bg-cyan-400'
                }`}
                style={{ width: `${Math.min(100, storagePct)}%` }}
              />
            </div>
          </div>

          <div className="px-4 py-3 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-mono tracking-[0.18em] text-zinc-500">
                LINK // THROUGHPUT
              </div>
              <div className="text-sm font-mono font-semibold text-cyan-300 mt-1">
                ↓ {data ? formatSpeed(data.transfer.dlSpeed) : '0 B/s'}
              </div>
              <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
                ↑ {data ? formatSpeed(data.transfer.upSpeed) : '0 B/s'}
              </div>
            </div>
            <ArrowDown className="w-4 h-4 text-cyan-400/70" />
          </div>

          <div className="px-4 py-3 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-mono tracking-[0.18em] text-zinc-500">
                AUTO-PURGE // QUEUE
              </div>
              <div className="text-xl font-mono font-bold text-white mt-0.5">
                {String(storage?.pendingDeleteCount ?? 0).padStart(2, '0')}
                <span className="text-xs font-normal text-zinc-500 ml-2">待卸载</span>
              </div>
            </div>
            <Clock className="w-4 h-4 text-amber-400/70" />
          </div>
        </div>

        {/* Filter, Search & Batch Sub-Bar */}
        <div className="border-t border-white/[0.07] px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#070a0f]/80">
          <div className="flex items-center gap-1 flex-wrap">
            {(
              [
                { id: 'all', label: '全部档案' },
                { id: 'playable', label: '可直接播放' },
                { id: 'downloading', label: '传输中' },
                { id: 'scheduled', label: '待自动卸载' },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`px-2.5 py-1 text-xs font-mono transition border ${
                  filter === f.id
                    ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-300'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03]'
                }`}
              >
                {f.label}
              </button>
            ))}

            <button
              onClick={() => {
                setBatchMode((b) => !b);
                setSelectedHashes(new Set());
              }}
              className={`ml-1 inline-flex items-center gap-1 px-2.5 py-1 text-xs font-mono border transition ${
                batchMode
                  ? 'border-amber-400/60 bg-amber-400/15 text-amber-200'
                  : 'border-white/10 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <CheckSquare className="w-3 h-3" />
              {batchMode ? '退出批量' : '批量管理'}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative flex-1 sm:w-56">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="检索片名 / TMDB / 4K..."
                className="w-full bg-[#05070a] border border-white/10 pl-8 pr-3 py-1 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-400/60"
              />
            </div>

            <div className="flex items-center border border-white/10 bg-[#05070a]">
              <button
                onClick={() => setViewMode('grid')}
                title="影院海报网格"
                className={`p-1.5 transition ${
                  viewMode === 'grid'
                    ? 'bg-cyan-400/15 text-cyan-300'
                    : 'text-zinc-500 hover:text-zinc-200'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                title="精简数据列表"
                className={`p-1.5 transition ${
                  viewMode === 'list'
                    ? 'bg-cyan-400/15 text-cyan-300'
                    : 'text-zinc-500 hover:text-zinc-200'
                }`}
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>

            <button
              onClick={onRefresh}
              title="刷新状态"
              className="p-1.5 border border-white/10 bg-[#05070a] text-zinc-400 hover:text-cyan-300 hover:border-cyan-400/40 transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Batch Action Strip */}
        {batchMode && (
          <div className="border-t border-amber-400/30 bg-amber-950/25 px-4 py-2 flex items-center justify-between gap-3 flex-wrap text-xs font-mono">
            <div className="flex items-center gap-3 text-amber-200">
              <span>已选中 {selectedHashes.size} 项</span>
              <button
                onClick={() => setSelectedHashes(new Set(filteredTorrents.map((t) => t.hash)))}
                className="underline hover:text-white"
              >
                全选当前
              </button>
              <button
                onClick={() => setSelectedHashes(new Set())}
                className="underline hover:text-white"
              >
                清空
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                disabled={selectedHashes.size === 0}
                onClick={() => void handleBatchAction('resume')}
                className="px-2.5 py-1 border border-cyan-400/40 text-cyan-200 disabled:opacity-35 hover:bg-cyan-400/15"
              >
                批量继续
              </button>
              <button
                disabled={selectedHashes.size === 0}
                onClick={() => void handleBatchAction('pause')}
                className="px-2.5 py-1 border border-white/15 text-zinc-200 disabled:opacity-35 hover:bg-white/10"
              >
                批量暂停
              </button>
              <button
                disabled={selectedHashes.size === 0}
                onClick={() => void handleBatchAction('delete')}
                className="px-2.5 py-1 border border-rose-500/50 bg-rose-950/60 text-rose-200 disabled:opacity-35 hover:bg-rose-600 hover:text-white"
              >
                批量彻底卸载
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Empty State */}
      {!data || filteredTorrents.length === 0 ? (
        <div className="hud-panel p-14 text-center">
          <div className="w-12 h-12 mx-auto border border-cyan-400/30 bg-cyan-400/5 flex items-center justify-center text-cyan-400 mb-4">
            <HardDrive className="w-5 h-5" />
          </div>
          <div className="text-xs font-mono tracking-[0.22em] text-zinc-500">ARCHIVE // EMPTY</div>
          <h3 className="text-base font-semibold text-white mt-1.5">
            {data && data.torrents.length > 0 ? '没有匹配的筛选结果' : '媒体库暂无影片'}
          </h3>
          <p className="text-xs text-zinc-400 mt-2 max-w-md mx-auto leading-relaxed">
            载入磁力链接或 .torrent 种子即可边下边播，默认原生直出；大合集开启「小盘追剧托管」自动滚动预载与卸载。
          </p>
          {(!data || data.torrents.length === 0) && (
            <button
              onClick={onOpenAdd}
              className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-xs font-mono font-bold tracking-wider text-zinc-950 transition"
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              载入第一个种子
            </button>
          )}
        </div>
      ) : viewMode === 'grid' ? (
        /* ============ CINEMA POSTER GRID ============ */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filteredTorrents.map((t) => {
            const parsed = parseMediaTitle(t.name);
            const displayTitle = t.tmdb?.title || parsed.title;
            const displayYear = t.tmdb?.year || parsed.year;
            const st = translateTorrentState(t.state);
            const pct = Math.min(100, Math.round(t.progress * 1000) / 10);
            const isPaused =
              t.state.toLowerCase().includes('paused') || t.state.toLowerCase().includes('stopped');
            const isSelected = selectedHashes.has(t.hash);

            return (
              <div
                key={t.hash}
                className={`hud-card group flex flex-col overflow-hidden ${
                  isSelected ? 'ring-1 ring-amber-400 border-amber-400/70' : ''
                }`}
              >
                {/* 16:9 Visual Stage */}
                <div
                  onClick={() => handleQuickPlay(t)}
                  className="relative aspect-video w-full cursor-pointer overflow-hidden border-b border-white/[0.07]"
                >
                  <MediaThumb
                    hash={t.hash}
                    fileIndex={t.primaryVideo?.index}
                    existsOnDisk={t.primaryVideo?.existsOnDisk}
                    resolution={parsed.resolution}
                    progress={t.progress}
                    tmdbBackdrop={t.tmdb?.backdropUrl || t.tmdb?.posterUrl}
                    hoverCycling
                  />

                  {/* Top-Left Status HUD */}
                  <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 flex-wrap">
                    {batchMode && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelectHash(t.hash)}
                        className="accent-amber-400 w-4 h-4"
                      />
                    )}
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono tracking-wider border backdrop-blur-md ${st.badge}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                      {pct < 100 && t.dlSpeed > 0 ? `${pct.toFixed(1)}%` : st.code}
                    </span>
                    {t.bingeMode && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono tracking-wider bg-cyan-950/90 border border-cyan-400/50 text-cyan-200 backdrop-blur-md">
                        <Repeat className="w-2.5 h-2.5" />
                        BINGE
                      </span>
                    )}
                    {t.sequential && !t.bingeMode && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono tracking-wider bg-amber-950/80 border border-amber-500/40 text-amber-300 backdrop-blur-md">
                        <Zap className="w-2.5 h-2.5" />
                        SEQ
                      </span>
                    )}
                  </div>

                  {/* Top-Right Spec, TMDB Rating & Episode HUD */}
                  <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">
                    {t.tmdb && t.tmdb.rating > 0 && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono font-bold bg-black/80 border border-amber-400/40 text-amber-300 backdrop-blur-md">
                        <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />
                        {t.tmdb.rating.toFixed(1)}
                      </span>
                    )}
                    {parsed.resolution && (
                      <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold tracking-wider bg-black/75 border border-cyan-400/40 text-cyan-300 backdrop-blur-md">
                        {parsed.resolution}
                      </span>
                    )}
                    {t.videoCount > 1 && (
                      <span className="px-1.5 py-0.5 text-[10px] font-mono bg-black/75 border border-white/15 text-zinc-200 backdrop-blur-md">
                        {t.videoCount} EP
                      </span>
                    )}
                  </div>

                  {/* Center Hover Play Reticle */}
                  {!batchMode && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/35 transition-colors">
                      <div className="opacity-0 group-hover:opacity-100 scale-95 group-hover:scale-100 transition-all duration-200 px-4 py-2 border border-cyan-400/80 bg-[#05080d]/90 backdrop-blur-md flex items-center gap-2 text-xs font-mono font-semibold tracking-[0.16em] text-cyan-300">
                        <Play className="w-3.5 h-3.5 fill-current" />
                        {t.playableCount > 1 ? 'SELECT EPISODE' : 'DIRECT PLAY'}
                      </div>
                    </div>
                  )}

                  {t.nextDeleteAt && (
                    <div className="absolute bottom-2.5 left-2.5 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono bg-rose-950/90 border border-rose-500/40 text-rose-300 backdrop-blur-md">
                      <Clock className="w-2.5 h-2.5" />
                      {formatCountdown(t.nextDeleteAt)}
                    </div>
                  )}

                  {t.dlSpeed > 0 && (
                    <div className="absolute bottom-2.5 right-2.5 px-2 py-0.5 text-[10px] font-mono bg-black/80 border border-cyan-400/30 text-cyan-300 backdrop-blur-md">
                      ↓ {formatSpeed(t.dlSpeed)}
                    </div>
                  )}

                  <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/10">
                    <div
                      className={`h-full transition-all ${
                        pct >= 100 ? 'bg-emerald-400' : 'bg-cyan-400'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>

                {/* Lower Metadata Console */}
                <div className="p-4 flex-1 flex flex-col justify-between gap-3">
                  <div>
                    <h3
                      className="text-sm font-semibold text-zinc-100 leading-snug line-clamp-2 group-hover:text-cyan-200 transition cursor-pointer"
                      title={t.name}
                      onClick={() => handleQuickPlay(t)}
                    >
                      {displayTitle}
                      {displayYear && (
                        <span className="ml-1.5 text-xs font-mono font-normal text-zinc-500">
                          ({displayYear})
                        </span>
                      )}
                    </h3>

                    <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-mono text-zinc-400">
                        {formatBytes(t.size)}
                        {t.totalSize > t.size ? ` / ${formatBytes(t.totalSize)}` : ''}
                      </span>
                      <span className="text-zinc-700">·</span>
                      <span className="text-[10px] font-mono text-zinc-400">
                        {pct.toFixed(0)}%
                      </span>
                      {parsed.tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 text-[9px] font-mono tracking-wider border border-white/10 bg-white/[0.03] text-zinc-400"
                        >
                          {tag}
                        </span>
                      ))}
                      {t.watchedCount > 0 && (
                        <span className="px-1.5 py-0.5 text-[9px] font-mono border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                          已看 {t.watchedCount}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="pt-3 border-t border-white/[0.06] flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleQuickPlay(t)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-400/15 hover:bg-cyan-400 text-cyan-300 hover:text-zinc-950 border border-cyan-400/40 text-xs font-mono font-semibold transition"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        播放
                      </button>
                      <button
                        onClick={() => setInspectorHash(t.hash)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white/[0.03] hover:bg-white/[0.08] border border-white/10 text-xs font-mono text-zinc-300 transition"
                      >
                        <SlidersHorizontal className="w-3 h-3" />
                        选集{t.videoCount > 0 ? ` (${t.videoCount})` : ''}
                      </button>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => void handlePauseResume(t)}
                        title={isPaused ? '继续下载' : '暂停下载'}
                        className="p-1.5 border border-transparent hover:border-white/10 text-zinc-500 hover:text-zinc-100 transition"
                      >
                        {isPaused ? (
                          <Play className="w-3.5 h-3.5" />
                        ) : (
                          <Pause className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        onClick={() => void handleToggleSequential(t)}
                        title="切换顺序边下边播"
                        className={`p-1.5 border transition ${
                          t.sequential
                            ? 'border-amber-500/30 text-amber-400 bg-amber-500/10'
                            : 'border-transparent text-zinc-500 hover:text-zinc-200'
                        }`}
                      >
                        <Zap className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => void handleDeleteTorrent(t)}
                        title="卸载整个种子并删除文件"
                        className="p-1.5 border border-transparent hover:border-rose-500/40 hover:bg-rose-950/60 text-zinc-500 hover:text-rose-300 transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ============ COMPACT LIST VIEW ============ */
        <div className="hud-panel divide-y divide-white/[0.06]">
          {filteredTorrents.map((t) => {
            const parsed = parseMediaTitle(t.name);
            const displayTitle = t.tmdb?.title || parsed.title;
            const st = translateTorrentState(t.state);
            const pct = Math.min(100, Math.round(t.progress * 1000) / 10);
            const isPaused =
              t.state.toLowerCase().includes('paused') || t.state.toLowerCase().includes('stopped');
            const isSelected = selectedHashes.has(t.hash);

            return (
              <div
                key={t.hash}
                className={`p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:bg-white/[0.02] transition ${
                  isSelected ? 'bg-amber-950/20' : ''
                }`}
              >
                <div className="flex items-center gap-3.5 min-w-0 flex-1">
                  {batchMode && (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelectHash(t.hash)}
                      className="accent-amber-400 w-4 h-4 shrink-0"
                    />
                  )}
                  <div
                    onClick={() => handleQuickPlay(t)}
                    className="w-24 aspect-video shrink-0 border border-white/10 cursor-pointer overflow-hidden"
                  >
                    <MediaThumb
                      hash={t.hash}
                      fileIndex={t.primaryVideo?.index}
                      existsOnDisk={t.primaryVideo?.existsOnDisk}
                      resolution={parsed.resolution}
                      progress={t.progress}
                      tmdbBackdrop={t.tmdb?.backdropUrl || t.tmdb?.posterUrl}
                      compact
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => handleQuickPlay(t)}
                        className="text-sm font-medium text-zinc-100 hover:text-cyan-300 truncate text-left"
                        title={t.name}
                      >
                        {displayTitle}
                      </button>
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono border ${st.badge}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                        {st.code}
                      </span>
                      {t.bingeMode && (
                        <span className="px-1.5 py-0.5 text-[10px] font-mono border border-cyan-400/40 text-cyan-300">
                          BINGE
                        </span>
                      )}
                      {parsed.resolution && (
                        <span className="px-1.5 py-0.5 text-[10px] font-mono border border-cyan-400/30 text-cyan-300">
                          {parsed.resolution}
                        </span>
                      )}
                      {t.nextDeleteAt && (
                        <span className="px-1.5 py-0.5 text-[10px] font-mono border border-rose-500/40 bg-rose-950/60 text-rose-300">
                          {formatCountdown(t.nextDeleteAt)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-4 text-[11px] font-mono text-zinc-400 flex-wrap">
                      <span className="text-zinc-200">{pct.toFixed(1)}%</span>
                      <span>{formatBytes(t.size)}</span>
                      {t.dlSpeed > 0 && (
                        <span className="text-cyan-300">↓ {formatSpeed(t.dlSpeed)}</span>
                      )}
                      <span>
                        S:{t.numSeeds} / P:{t.numLeechs}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleQuickPlay(t)}
                    className="flex items-center gap-1 px-3 py-1.5 bg-cyan-400/15 hover:bg-cyan-400 text-cyan-300 hover:text-zinc-950 border border-cyan-400/40 text-xs font-mono font-semibold transition"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    播放
                  </button>
                  <button
                    onClick={() => setInspectorHash(t.hash)}
                    className="px-2.5 py-1.5 border border-white/10 hover:border-white/25 text-xs font-mono text-zinc-300 transition"
                  >
                    选集 ({t.videoCount})
                  </button>
                  <button
                    onClick={() => void handlePauseResume(t)}
                    className="p-1.5 border border-white/10 text-zinc-400 hover:text-white transition"
                  >
                    {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => void handleDeleteTorrent(t)}
                    className="p-1.5 border border-white/10 hover:border-rose-500/50 text-zinc-400 hover:text-rose-300 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ============ RIGHT SLIDE-OVER TACTICAL INSPECTOR DRAWER ============ */}
      {inspectorHash && inspectorTorrent && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/75 backdrop-blur-sm">
          <div className="flex-1" onClick={() => setInspectorHash(null)} />
          <div className="w-full max-w-2xl h-full bg-[#080c12] border-l border-white/10 flex flex-col shadow-2xl">
            {/* Drawer Header */}
            <div className="px-5 py-4 border-b border-white/[0.08] flex items-start justify-between gap-4 bg-[#06090e]">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[10px] font-mono tracking-[0.22em] text-cyan-400">
                  <span>FILE INSPECTOR // {inspectorTorrent.hash.slice(0, 8).toUpperCase()}</span>
                  {inspectorTorrent.tmdb && inspectorTorrent.tmdb.rating > 0 && (
                    <span className="text-amber-300">★ {inspectorTorrent.tmdb.rating.toFixed(1)}</span>
                  )}
                </div>
                <h2 className="text-sm font-semibold text-white mt-1 break-all">
                  {inspectorTorrent.tmdb?.title || parseMediaTitle(inspectorTorrent.name).title}
                </h2>
                {inspectorTorrent.tmdb?.overview && (
                  <p className="text-[11px] text-zinc-400 mt-1 line-clamp-2">
                    {inspectorTorrent.tmdb.overview}
                  </p>
                )}
                <div className="text-[10px] font-mono text-zinc-600 mt-1 break-all">
                  {inspectorTorrent.name}
                </div>
              </div>
              <button
                onClick={() => setInspectorHash(null)}
                className="p-1.5 border border-white/10 text-zinc-400 hover:text-white hover:border-cyan-400/50 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Control Strip (Batch + Binge + TMDB) */}
            <div className="px-5 py-2.5 border-b border-white/[0.06] bg-[#0a0f17] flex items-center justify-between gap-2 flex-wrap text-xs font-mono">
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => void handleBatchVideoPriority(inspectorHash, 1)}
                  className="px-2.5 py-1 border border-white/10 hover:border-cyan-400/50 text-zinc-300 hover:text-cyan-300 transition"
                >
                  全选视频
                </button>
                <button
                  onClick={() => void handleBatchVideoPriority(inspectorHash, 0)}
                  className="px-2.5 py-1 border border-white/10 hover:border-amber-400/50 text-zinc-400 hover:text-amber-300 transition"
                >
                  取消全部
                </button>
                <button
                  onClick={() => void handleToggleBinge(inspectorTorrent)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 border transition ${
                    inspectorTorrent.bingeMode
                      ? 'border-cyan-400 bg-cyan-400/15 text-cyan-200'
                      : 'border-white/10 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Repeat className="w-3 h-3" />
                  追剧托管：{inspectorTorrent.bingeMode ? '开' : '关'}
                </button>
                <button
                  onClick={() => {
                    setTmdbSearchOpen((v) => !v);
                    setTmdbQuery(
                      inspectorTorrent.tmdb?.title || parseMediaTitle(inspectorTorrent.name).title
                    );
                    setTmdbResults([]);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 border border-white/10 hover:border-amber-400/50 text-zinc-300 hover:text-amber-200 transition"
                >
                  <Sparkles className="w-3 h-3" />
                  匹配 TMDB
                </button>
              </div>
              {loadingFiles && <span className="text-[10px] text-cyan-400">SYNCING...</span>}
            </div>

            {/* Inline TMDB Manual Matcher */}
            {tmdbSearchOpen && (
              <div className="px-5 py-3 border-b border-cyan-400/25 bg-[#060a10] space-y-2.5">
                <form onSubmit={handleSearchTmdb} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={tmdbQuery}
                    onChange={(e) => setTmdbQuery(e.target.value)}
                    placeholder="输入中/英文片名搜索 TMDB..."
                    className="flex-1 bg-[#05070a] border border-white/10 px-3 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-cyan-400/60"
                  />
                  <button
                    type="submit"
                    disabled={tmdbSearching}
                    className="px-3 py-1.5 bg-cyan-400 text-xs font-mono font-bold text-zinc-950"
                  >
                    {tmdbSearching ? '搜索中...' : '搜索'}
                  </button>
                  {inspectorTorrent.tmdb && (
                    <button
                      type="button"
                      onClick={() => void handleBindTmdb(inspectorHash, null)}
                      className="px-2.5 py-1.5 border border-rose-500/40 text-xs font-mono text-rose-300"
                    >
                      清除
                    </button>
                  )}
                </form>

                {tmdbResults.length > 0 && (
                  <div className="max-h-48 overflow-y-auto divide-y divide-white/[0.06] border border-white/10">
                    {tmdbResults.map((c) => (
                      <button
                        key={`${c.mediaType}-${c.tmdbId}`}
                        onClick={() => void handleBindTmdb(inspectorHash, c)}
                        className="w-full text-left p-2 flex items-center gap-3 hover:bg-cyan-400/10 transition"
                      >
                        {c.posterUrl && (
                          <img src={c.posterUrl} alt="" className="w-8 h-12 object-cover shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-white truncate">
                            {c.title}{' '}
                            <span className="text-zinc-500 font-mono">
                              ({c.year || '--'}) · {c.mediaType.toUpperCase()}
                            </span>
                          </div>
                          <div className="text-[11px] text-zinc-400 truncate">{c.overview}</div>
                        </div>
                        <span className="text-xs font-mono text-amber-300 shrink-0">
                          ★ {c.rating}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* File List */}
            <div className="flex-1 overflow-y-auto divide-y divide-white/[0.06]">
              {inspectorFiles.length === 0 ? (
                <div className="p-12 text-center text-xs font-mono text-zinc-500">
                  正在等待种子元数据解析...
                </div>
              ) : (
                inspectorFiles.map((f) => {
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
                      className="px-5 py-3 flex items-center justify-between gap-3 hover:bg-white/[0.02] transition"
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => void handleTogglePriority(inspectorHash, f)}
                          title={selected ? '取消下载此文件' : '勾选下载此文件'}
                          className="accent-cyan-400 cursor-pointer shrink-0"
                        />

                        {f.isVideo ? (
                          <div
                            onClick={() => {
                              if (f.existsOnDisk) {
                                setInspectorHash(null);
                                onPlay(
                                  inspectorHash,
                                  f.index,
                                  inspectorTorrent.tmdb?.title || inspectorTorrent.name
                                );
                              }
                            }}
                            className={`w-20 aspect-video shrink-0 border border-white/10 overflow-hidden ${
                              f.existsOnDisk ? 'cursor-pointer' : 'opacity-40'
                            }`}
                          >
                            <MediaThumb
                              hash={inspectorHash}
                              fileIndex={f.index}
                              existsOnDisk={f.existsOnDisk}
                              progress={f.progress}
                              compact
                            />
                          </div>
                        ) : (
                          <div className="w-8 h-8 shrink-0 border border-white/[0.06] bg-white/[0.02] flex items-center justify-center">
                            <FileText className="w-3.5 h-3.5 text-zinc-600" />
                          </div>
                        )}

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span
                              className={`text-xs truncate ${
                                selected ? 'text-zinc-100' : 'text-zinc-600 line-through'
                              }`}
                              title={f.name}
                            >
                              {shortName}
                            </span>
                            {isWatched && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono bg-emerald-950 border border-emerald-500/40 text-emerald-300">
                                <CheckCircle2 className="w-2.5 h-2.5" />
                                已看
                              </span>
                            )}
                            {isPinned && (
                              <span className="px-1.5 py-0.5 text-[10px] font-mono bg-cyan-950 border border-cyan-500/40 text-cyan-300">
                                PIN
                              </span>
                            )}
                            {scheduled && !isPinned && !f.media?.removedFile && (
                              <button
                                onClick={() => void handleCancelDelete(inspectorHash, f)}
                                className="px-1.5 py-0.5 text-[10px] font-mono bg-rose-950 border border-rose-500/40 text-rose-300 hover:bg-rose-900"
                              >
                                {formatCountdown(scheduled)} · 撤销
                              </button>
                            )}
                          </div>

                          <div className="mt-1 flex items-center gap-3 text-[10px] font-mono text-zinc-500">
                            <span>{formatBytes(f.size)}</span>
                            <span className={dlPct >= 100 ? 'text-emerald-400' : 'text-cyan-400'}>
                              DL {dlPct.toFixed(1)}%
                            </span>
                            {watchPct > 0 && (
                              <span className="text-amber-300">PLAY {watchPct}%</span>
                            )}
                            {f.media?.removedFile && <span>已卸载</span>}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {f.isVideo && (
                          <button
                            disabled={!f.existsOnDisk}
                            onClick={() => {
                              setInspectorHash(null);
                              onPlay(
                                inspectorHash,
                                f.index,
                                inspectorTorrent.tmdb?.title || inspectorTorrent.name
                              );
                            }}
                            className="flex items-center gap-1 px-2.5 py-1.5 bg-cyan-400 hover:bg-cyan-300 disabled:bg-zinc-900 disabled:text-zinc-600 text-[11px] font-mono font-bold text-zinc-950 transition"
                          >
                            <Play className="w-3 h-3 fill-current" />
                            播放
                          </button>
                        )}
                        {f.isVideo && (
                          <button
                            onClick={() => void handleTogglePin(inspectorHash, f)}
                            title={isPinned ? '解除防删锁定' : '锁定防止自动卸载'}
                            className={`p-1.5 border transition ${
                              isPinned
                                ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-300'
                                : 'border-white/10 text-zinc-500 hover:text-zinc-200'
                            }`}
                          >
                            <Pin className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {f.existsOnDisk && (
                          <button
                            onClick={() => void handleUnloadFile(inspectorHash, f)}
                            title="立即卸载此单集释放硬盘"
                            className="p-1.5 border border-white/10 hover:border-rose-500/50 hover:bg-rose-950/60 text-zinc-500 hover:text-rose-300 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Drawer Footer */}
            <div className="px-5 py-3 border-t border-white/[0.08] bg-[#06090e] flex items-center justify-between">
              <span className="text-[11px] font-mono text-zinc-500">
                已选体积：{formatBytes(inspectorTorrent.size)}
              </span>
              <button
                onClick={() => void handleDeleteTorrent(inspectorTorrent)}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-rose-500/40 bg-rose-950/40 hover:bg-rose-600 text-xs font-mono text-rose-200 hover:text-white transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
                卸载整包并释放磁盘
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
