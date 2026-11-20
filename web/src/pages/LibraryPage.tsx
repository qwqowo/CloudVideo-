import React, { useEffect, useState } from 'react';
import {
  Play,
  Pause,
  Trash2,
  ChevronDown,
  ChevronRight,
  Zap,
  Pin,
  CheckCircle2,
  Clock,
  HardDrive,
  AlertTriangle,
  Film,
  FileText,
  RefreshCw,
  Plus,
} from 'lucide-react';
import type { TorrentFileItem, TorrentsResponse, TorrentSummary } from '../types';
import {
  apiFetch,
  formatBytes,
  formatCountdown,
  formatSpeed,
  translateTorrentState,
} from '../lib/api';

interface LibraryPageProps {
  data: TorrentsResponse | null;
  loading: boolean;
  onRefresh: () => void;
  onOpenAdd: () => void;
  onPlay: (torrentHash: string, fileIndex: number, torrentName: string) => void;
}

export const LibraryPage: React.FC<LibraryPageProps> = ({
  data,
  loading,
  onRefresh,
  onOpenAdd,
  onPlay,
}) => {
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [filesMap, setFilesMap] = useState<Record<string, TorrentFileItem[]>>({});
  const [loadingFiles, setLoadingFiles] = useState<string | null>(null);
  const [toast, setToast] = useState<string>('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3200);
  };

  const fetchFiles = async (hash: string) => {
    setLoadingFiles(hash);
    try {
      const res = await apiFetch<{ hash: string; files: TorrentFileItem[] }>(
        `/api/torrents/${encodeURIComponent(hash)}/files`
      );
      setFilesMap((prev) => ({ ...prev, [hash]: res.files }));
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载文件列表失败');
    } finally {
      setLoadingFiles((cur) => (cur === hash ? null : cur));
    }
  };

  useEffect(() => {
    if (!expandedHash) return;
    void fetchFiles(expandedHash);
    const id = setInterval(() => void fetchFiles(expandedHash), 4000);
    return () => clearInterval(id);
  }, [expandedHash]);

  const toggleExpand = (hash: string) => {
    setExpandedHash((prev) => (prev === hash ? null : hash));
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
      showToast(nextPinned ? '已锁定，自动清理将跳过此文件' : '已解除锁定');
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
          ? `已卸载文件并移除整个种子，释放 ${formatBytes(res.freedBytes)}`
          : `已卸载单集文件，释放 ${formatBytes(res.freedBytes)}`
      );
      if (res.deletedTorrent && expandedHash === hash) {
        setExpandedHash(null);
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
      showToast('已取消定时自动卸载');
      await fetchFiles(hash);
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '取消失败');
    }
  };

  const handleDeleteTorrent = async (t: TorrentSummary) => {
    if (!confirm(`确定彻底删除种子及本地全部文件？\n${t.name}`)) return;
    try {
      const res = await apiFetch<{ freedBytes: number }>(
        `/api/torrents/${encodeURIComponent(t.hash)}`,
        { method: 'DELETE' }
      );
      showToast(`已移除任务，释放 ${formatBytes(res.freedBytes)}`);
      if (expandedHash === t.hash) setExpandedHash(null);
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
      showToast(t.sequential ? '已关闭顺序下载' : '已开启顺序下载（边下边播）');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换失败');
    }
  };

  const handleQuickPlayTorrent = async (t: TorrentSummary) => {
    let files = filesMap[t.hash];
    if (!files) {
      const res = await apiFetch<{ hash: string; files: TorrentFileItem[] }>(
        `/api/torrents/${encodeURIComponent(t.hash)}/files`
      );
      files = res.files;
      setFilesMap((prev) => ({ ...prev, [t.hash]: files! }));
    }
    const videoFiles = files.filter((f) => f.isVideo && f.priority > 0 && f.existsOnDisk);
    if (videoFiles.length === 1) {
      onPlay(t.hash, videoFiles[0].index, t.name);
    } else {
      setExpandedHash(t.hash);
    }
  };

  const storage = data?.storage;

  return (
    <div className="space-y-6">
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-xl bg-slate-800 border border-slate-700 px-4 py-2.5 text-sm text-white shadow-xl">
          {toast}
        </div>
      )}

      {data && !data.qbitConnected && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-semibold text-amber-200">
              尚未连接到 qBittorrent 下载引擎
            </div>
            <p className="text-amber-200/80 text-xs mt-1">
              如果刚启动 Docker Compose，请等待 5–10 秒后刷新；你依然可以正常使用「节点测速」与「清理与设置」。
              {data.qbitError ? `（详情：${data.qbitError}）` : ''}
            </p>
          </div>
        </div>
      )}

      {/* Top Overview Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-4">
          <div className="text-xs text-slate-400 flex items-center gap-1.5">
            <Film className="w-3.5 h-3.5 text-indigo-400" />
            活跃种子任务
          </div>
          <div className="text-2xl font-bold text-white mt-1.5">
            {data?.torrents.length ?? 0}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-4">
          <div className="text-xs text-slate-400 flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5 text-sky-400" />
            已用 / 水位上限
          </div>
          <div className="text-lg sm:text-xl font-bold text-white mt-1.5 font-mono">
            {storage ? `${formatBytes(storage.usedBytes)} / ${formatBytes(storage.limitBytes)}` : '--'}
          </div>
          {storage && storage.diskFreeBytes > 0 && (
            <div className="text-[11px] text-slate-400 mt-0.5">
              宿主机剩余可用：{formatBytes(storage.diskFreeBytes)}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-4">
          <div className="text-xs text-slate-400 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-emerald-400" />
            实时下载 / 上传
          </div>
          <div className="text-lg sm:text-xl font-bold text-white mt-1.5 font-mono">
            {data ? formatSpeed(data.transfer.dlSpeed) : '0 B/s'}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 font-mono">
            上传：{data ? formatSpeed(data.transfer.upSpeed) : '0 B/s'}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-4">
          <div className="text-xs text-slate-400 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-amber-400" />
            待自动卸载队列
          </div>
          <div className="text-2xl font-bold text-white mt-1.5">
            {storage?.pendingDeleteCount ?? 0}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">看完后自动释放小盘空间</div>
        </div>
      </div>

      {/* Section Toolbar */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">种子与影片列表</h2>
        <button
          onClick={onRefresh}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs text-slate-300 transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {/* Torrent List */}
      {!data || data.torrents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-12 text-center">
          <Film className="w-10 h-10 text-slate-600 mx-auto mb-3" />
          <h3 className="text-base font-medium text-slate-200">还没有视频任务</h3>
          <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
            粘贴磁力链接或上传 .torrent 文件即可开始顺序边下边播，大合集支持先暂停后按集勾选，看完自动卸载省硬盘。
          </p>
          <button
            onClick={onOpenAdd}
            className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm font-medium text-white transition"
          >
            <Plus className="w-4 h-4" />
            添加第一个种子
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {data.torrents.map((t) => {
            const expanded = expandedHash === t.hash;
            const st = translateTorrentState(t.state);
            const pct = Math.round(t.progress * 1000) / 10;
            const isPaused =
              t.state.toLowerCase().includes('paused') || t.state.toLowerCase().includes('stopped');
            const files = filesMap[t.hash] || [];

            return (
              <div
                key={t.hash}
                className="rounded-2xl border border-slate-800/90 bg-slate-900/75 overflow-hidden transition hover:border-slate-700/90"
              >
                <div className="p-4 sm:p-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => toggleExpand(t.hash)}
                          className="p-1 -ml-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800"
                        >
                          {expanded ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          onClick={() => toggleExpand(t.hash)}
                          className="text-sm sm:text-base font-semibold text-white hover:text-indigo-300 truncate text-left"
                          title={t.name}
                        >
                          {t.name}
                        </button>
                        <span
                          className={`text-[11px] px-2 py-0.5 rounded-full border ${st.color}`}
                        >
                          {st.label}
                        </span>
                        {t.sequential && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                            <Zap className="w-3 h-3" />
                            边下边播
                          </span>
                        )}
                        {t.nextDeleteAt && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatCountdown(t.nextDeleteAt)}
                          </span>
                        )}
                      </div>

                      <div className="mt-2.5 flex items-center gap-4 text-xs text-slate-400 flex-wrap">
                        <span className="font-mono text-slate-200">{pct.toFixed(1)}%</span>
                        <span>
                          已选 {formatBytes(t.size)}
                          {t.totalSize > t.size ? ` / 总计 ${formatBytes(t.totalSize)}` : ''}
                        </span>
                        {t.dlSpeed > 0 && (
                          <span className="text-sky-400 font-mono">
                            ↓ {formatSpeed(t.dlSpeed)}
                          </span>
                        )}
                        {t.upSpeed > 0 && (
                          <span className="text-emerald-400 font-mono">
                            ↑ {formatSpeed(t.upSpeed)}
                          </span>
                        )}
                        <span>
                          做种 {t.numSeeds} · 连接 {t.numLeechs}
                        </span>
                      </div>

                      <div className="mt-2.5 h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            pct >= 100 ? 'bg-emerald-500' : 'bg-indigo-500'
                          }`}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => void handleQuickPlayTorrent(t)}
                        className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        播放 / 选集
                      </button>
                      <button
                        onClick={() => void handlePauseResume(t)}
                        title={isPaused ? '继续下载' : '暂停下载'}
                        className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                      >
                        {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => void handleToggleSequential(t)}
                        title="切换顺序下载（边下边播）"
                        className={`p-2 rounded-xl border transition ${
                          t.sequential
                            ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                            : 'bg-slate-800 border-transparent text-slate-400 hover:text-white'
                        }`}
                      >
                        <Zap className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => void handleDeleteTorrent(t)}
                        title="卸载整个种子并删除文件"
                        className="p-2 rounded-xl bg-slate-800 hover:bg-rose-600/80 text-slate-400 hover:text-white transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded File List (Episodes & Selective Download) */}
                {expanded && (
                  <div className="border-t border-slate-800/80 bg-slate-950/60 px-4 sm:px-5 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-slate-400">
                        文件与选集管理（取消勾选可停止下载节省小盘空间）
                      </span>
                      {loadingFiles === t.hash && (
                        <span className="text-xs text-slate-500">刷新中...</span>
                      )}
                    </div>

                    {files.length === 0 ? (
                      <div className="py-4 text-center text-xs text-slate-500">
                        正在等待种子元数据解析...
                      </div>
                    ) : (
                      <div className="divide-y divide-slate-800/60">
                        {files.map((f) => {
                          const watchPct = Math.round((f.media?.progress ?? 0) * 100);
                          const dlPct = Math.round(f.progress * 1000) / 10;
                          const isWatched = Boolean(f.media?.watchedAt);
                          const isPinned = Boolean(f.media?.pinned);
                          const scheduled = f.media?.deleteAfterAt ?? null;
                          const selected = f.priority > 0;

                          return (
                            <div
                              key={f.index}
                              className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                            >
                              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => void handleTogglePriority(t.hash, f)}
                                  title={selected ? '点击取消下载此文件' : '点击勾选下载此文件'}
                                  className="mt-1 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500 cursor-pointer"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {f.isVideo ? (
                                      <Film className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                                    ) : (
                                      <FileText className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                                    )}
                                    <span
                                      className={`text-xs sm:text-sm truncate ${
                                        selected ? 'text-slate-200' : 'text-slate-500 line-through'
                                      }`}
                                      title={f.name}
                                    >
                                      {f.name}
                                    </span>
                                    {isWatched && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-0.5">
                                        <CheckCircle2 className="w-2.5 h-2.5" />
                                        已看
                                      </span>
                                    )}
                                    {isPinned && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                                        已锁定
                                      </span>
                                    )}
                                    {scheduled && !isPinned && !f.media?.removedFile && (
                                      <button
                                        onClick={() => void handleCancelDelete(t.hash, f)}
                                        title="点击取消自动卸载"
                                        className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 hover:bg-rose-500/25"
                                      >
                                        {formatCountdown(scheduled)} · 点此撤销
                                      </button>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-400">
                                    <span>大小 {formatBytes(f.size)}</span>
                                    <span>下载 {dlPct.toFixed(1)}%</span>
                                    {watchPct > 0 && (
                                      <span className="text-indigo-300">播放进度 {watchPct}%</span>
                                    )}
                                    {f.media?.removedFile && (
                                      <span className="text-slate-500">已卸载释放空间</span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0 pl-6 sm:pl-0">
                                {f.isVideo && (
                                  <button
                                    disabled={!f.existsOnDisk}
                                    onClick={() => onPlay(t.hash, f.index, t.name)}
                                    title={
                                      f.existsOnDisk
                                        ? '在线播放或调用本地播放器'
                                        : '请等待文件开始写入磁盘后再播放'
                                    }
                                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-600/90 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-xs font-medium text-white transition"
                                  >
                                    <Play className="w-3 h-3 fill-current" />
                                    播放
                                  </button>
                                )}
                                {f.isVideo && (
                                  <button
                                    onClick={() => void handleTogglePin(t.hash, f)}
                                    title={isPinned ? '解除防删锁定' : '锁定防止自动卸载'}
                                    className={`p-1.5 rounded-lg border transition ${
                                      isPinned
                                        ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                                        : 'bg-slate-800/80 border-transparent text-slate-400 hover:text-white'
                                    }`}
                                  >
                                    <Pin className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {f.existsOnDisk && (
                                  <button
                                    onClick={() => void handleUnloadFile(t.hash, f)}
                                    title="立即卸载此单集释放硬盘"
                                    className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-rose-600/80 text-slate-400 hover:text-white transition"
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
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
