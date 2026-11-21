import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  HardDrive,
  Gauge,
  RefreshCw,
  Trash2,
  Play,
  Pause,
  Zap,
  Repeat,
  ArrowDown,
  ArrowUp,
  History,
  SlidersHorizontal,
  Check,
  Sparkles,
} from 'lucide-react';
import type { CleanupLogRecord, TorrentsResponse, TorrentSummary } from '../types';
import {
  apiFetch,
  formatBytes,
  formatCountdown,
  formatSpeed,
  parseMediaTitle,
  translateTorrentState,
} from '../lib/api';
import { SpeedTestPage } from './SpeedTestPage';

interface ActivityPageProps {
  data: TorrentsResponse | null;
  onRefresh: () => void;
  onOpenDetail: (hash: string) => void;
  onPlay: (hash: string, fileIndex: number, title: string) => void;
}

type ActivityTab = 'storage' | 'speed';

const REASON_LABELS: Record<string, string> = {
  watched_delay_expired: '看完到期自动卸载',
  watched_immediate: '看完立即卸载',
  storage_limit_lru: '超水位自动淘汰',
  manual_watched_cleanup: '一键清理已看',
  manual_unload: '手动单集卸载',
  manual_torrent_unload: '手动整包卸载',
  batch_manual_unload: '批量卸载',
};

export const ActivityPage: React.FC<ActivityPageProps> = ({
  data,
  onRefresh,
  onOpenDetail,
  onPlay,
}) => {
  const [tab, setTab] = useState<ActivityTab>('storage');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [logs, setLogs] = useState<CleanupLogRecord[]>([]);
  const [cleaning, setCleaning] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), 3500);
  };

  const loadLogs = useCallback(async () => {
    try {
      const res = await apiFetch<{ logs: CleanupLogRecord[] }>('/api/cleanup/logs');
      setLogs(res.logs);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const torrents = data?.torrents ?? [];
  const storage = data?.storage;

  const breakdown = useMemo(() => {
    const limit = storage?.limitBytes || 1;
    let downloadingBytes = 0;
    let scheduledBytes = 0;
    let readyBytes = 0;
    for (const t of torrents) {
      const used = Math.max(0, t.downloaded || t.size);
      if (t.progress < 0.999) downloadingBytes += used;
      else if (t.nextDeleteAt) scheduledBytes += used;
      else readyBytes += used;
    }
    const scale = Math.min(1, (storage?.usedBytes || 0) / Math.max(1, downloadingBytes + scheduledBytes + readyBytes));
    return {
      readyPct: Math.min(100, ((readyBytes * scale) / limit) * 100),
      downloadingPct: Math.min(100, ((downloadingBytes * scale) / limit) * 100),
      scheduledPct: Math.min(100, ((scheduledBytes * scale) / limit) * 100),
    };
  }, [torrents, storage]);

  const toggleSelect = (hash: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  const handleCleanup = async (forceWatchedNow: boolean) => {
    if (forceWatchedNow && !confirm('确定立即卸载所有已标记看完（且未锁定）的视频？')) return;
    setCleaning(true);
    try {
      const res = await apiFetch<{ deletedItems: Array<{ relativePath: string }>; freedBytes: number }>(
        '/api/cleanup/run',
        {
          method: 'POST',
          body: JSON.stringify({ forceWatchedNow }),
        }
      );
      showToast(
        res.deletedItems.length > 0
          ? `已清理 ${res.deletedItems.length} 个文件，释放 ${formatBytes(res.freedBytes)}`
          : '空间良好，暂无需要清理的文件'
      );
      await loadLogs();
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '清理失败');
    } finally {
      setCleaning(false);
    }
  };

  const handleBatch = async (action: 'pause' | 'resume' | 'delete') => {
    const hashes = Array.from(selected);
    if (hashes.length === 0) return;
    if (action === 'delete' && !confirm(`确定彻底卸载选中的 ${hashes.length} 个影片并删除本地文件？`)) {
      return;
    }
    try {
      const res = await apiFetch<{ count: number; freedBytes: number }>('/api/torrents/batch', {
        method: 'POST',
        body: JSON.stringify({ action, hashes }),
      });
      showToast(
        action === 'delete'
          ? `已批量卸载 ${res.count} 项，释放 ${formatBytes(res.freedBytes)}`
          : `已${action === 'pause' ? '暂停' : '恢复'} ${res.count} 项`
      );
      setSelected(new Set());
      await loadLogs();
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '批量操作失败');
    }
  };

  const handlePauseResume = async (t: TorrentSummary) => {
    const isPaused =
      t.state.toLowerCase().includes('paused') || t.state.toLowerCase().includes('stopped');
    await apiFetch(`/api/torrents/${encodeURIComponent(t.hash)}/${isPaused ? 'resume' : 'pause'}`, {
      method: 'POST',
    }).catch(() => {});
    onRefresh();
  };

  const handleToggleSeq = async (t: TorrentSummary) => {
    await apiFetch(`/api/torrents/${encodeURIComponent(t.hash)}/sequential`, { method: 'POST' }).catch(
      () => {}
    );
    showToast(t.sequential ? '已关闭边下边播' : '已开启边下边播');
    onRefresh();
  };

  const handleToggleBinge = async (t: TorrentSummary) => {
    await apiFetch(`/api/torrents/${encodeURIComponent(t.hash)}/binge`, {
      method: 'POST',
      body: JSON.stringify({ bingeMode: !t.bingeMode }),
    }).catch(() => {});
    showToast(!t.bingeMode ? '已开启追剧托管' : '已关闭追剧托管');
    onRefresh();
  };

  const handleDeleteOne = async (t: TorrentSummary) => {
    if (!confirm(`确定卸载《${t.tmdb?.title || parseMediaTitle(t.name).title}》释放磁盘？`)) return;
    const res = await apiFetch<{ freedBytes: number }>(
      `/api/torrents/${encodeURIComponent(t.hash)}`,
      { method: 'DELETE' }
    );
    showToast(`已卸载，释放 ${formatBytes(res.freedBytes)}`);
    await loadLogs();
    onRefresh();
  };

  return (
    <div className="space-y-6">
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 cinema-glass px-5 py-2.5 rounded-full text-xs text-white shadow-2xl">
          {toast}
        </div>
      )}

      {/* Header + Segmented Switch */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">传输与空间</h1>
          <p className="text-xs text-zinc-400 mt-1">
            管理实时下载、磁盘空间配额、批量清理以及服务器观影带宽测速
          </p>
        </div>

        <div className="inline-flex p-1 rounded-full bg-white/[0.04] border border-white/[0.07] self-start">
          <button
            onClick={() => setTab('storage')}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium transition ${
              tab === 'storage' ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            下载与空间
          </button>
          <button
            onClick={() => setTab('speed')}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium transition ${
              tab === 'speed' ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Gauge className="w-3.5 h-3.5" />
            节点测速
          </button>
        </div>
      </div>

      {tab === 'speed' ? (
        <SpeedTestPage />
      ) : (
        <div className="space-y-6">
          {/* Visual Storage & Speed Overview Card */}
          <div className="cinema-surface rounded-3xl p-6 space-y-5">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
              <div>
                <div className="text-xs text-zinc-400">影院存储配额</div>
                <div className="flex items-baseline gap-2.5 mt-1 tabular-nums">
                  <span className="text-3xl font-semibold text-white">
                    {storage ? formatBytes(storage.usedBytes) : '--'}
                  </span>
                  <span className="text-sm text-zinc-400">
                    / 上限 {storage ? formatBytes(storage.limitBytes) : '--'}
                  </span>
                  {storage && (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        storage.usagePercent >= 85
                          ? 'bg-rose-500/15 text-rose-300'
                          : 'bg-white/[0.07] text-zinc-300'
                      }`}
                    >
                      {storage.usagePercent.toFixed(1)}%
                    </span>
                  )}
                </div>
                {storage && storage.diskFreeBytes > 0 && (
                  <div className="text-xs text-zinc-500 mt-1 tabular-nums">
                    服务器磁盘真实剩余 {formatBytes(storage.diskFreeBytes)} · 总容量{' '}
                    {formatBytes(storage.diskTotalBytes)}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-3 px-3.5 py-2 rounded-full bg-white/[0.04] border border-white/[0.07] text-xs tabular-nums">
                  <span className="flex items-center gap-1 text-emerald-300">
                    <ArrowDown className="w-3.5 h-3.5" />
                    {data ? formatSpeed(data.transfer.dlSpeed) : '0 B/s'}
                  </span>
                  <span className="text-zinc-700">|</span>
                  <span className="flex items-center gap-1 text-zinc-400">
                    <ArrowUp className="w-3.5 h-3.5" />
                    {data ? formatSpeed(data.transfer.upSpeed) : '0 B/s'}
                  </span>
                </div>

                <button
                  disabled={cleaning}
                  onClick={() => void handleCleanup(false)}
                  className="btn-ghost px-4 py-2 text-xs"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${cleaning ? 'animate-spin' : ''}`} />
                  巡检水位
                </button>
                <button
                  disabled={cleaning}
                  onClick={() => void handleCleanup(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500 hover:text-white text-rose-200 transition"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  清理全部已看
                </button>
              </div>
            </div>

            {/* Segmented Capacity Bar */}
            <div className="space-y-2">
              <div className="h-3 w-full rounded-full bg-white/[0.06] overflow-hidden flex">
                <div
                  className="h-full bg-zinc-100 transition-all duration-500"
                  style={{ width: `${breakdown.readyPct}%` }}
                />
                <div
                  className="h-full bg-amber-400 transition-all duration-500"
                  style={{ width: `${breakdown.downloadingPct}%` }}
                />
                <div
                  className="h-full bg-rose-400 transition-all duration-500"
                  style={{ width: `${breakdown.scheduledPct}%` }}
                />
              </div>

              <div className="flex items-center gap-4 text-[11px] text-zinc-400 flex-wrap">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-zinc-100" />
                  已就绪可播
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-400" />
                  正在下载
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-rose-400" />
                  倒计时自动清理 ({storage?.pendingDeleteCount ?? 0})
                </span>
              </div>
            </div>
          </div>

          {/* Transfer & Task Management List */}
          <div className="cinema-surface rounded-3xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/[0.07] flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-semibold text-white">
                  全部任务与磁盘占用 ({torrents.length})
                </h2>
                {torrents.length > 0 && (
                  <button
                    onClick={() =>
                      setSelected(
                        selected.size === torrents.length
                          ? new Set()
                          : new Set(torrents.map((t) => t.hash))
                      )
                    }
                    className="text-xs text-zinc-400 hover:text-white transition"
                  >
                    {selected.size === torrents.length ? '取消全选' : '全选'}
                  </button>
                )}
              </div>
              <button
                onClick={onRefresh}
                className="text-xs text-zinc-400 hover:text-white flex items-center gap-1"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                刷新
              </button>
            </div>

            {torrents.length === 0 ? (
              <div className="p-12 text-center text-xs text-zinc-500">当前没有任何下载任务</div>
            ) : (
              <div className="divide-y divide-white/[0.05]">
                {torrents.map((t) => {
                  const parsed = parseMediaTitle(t.name);
                  const title = t.tmdb?.title || parsed.title;
                  const pct = Math.min(100, Math.round(t.progress * 1000) / 10);
                  const st = translateTorrentState(t.state);
                  const isPaused =
                    t.state.toLowerCase().includes('paused') ||
                    t.state.toLowerCase().includes('stopped');
                  const isChecked = selected.has(t.hash);

                  return (
                    <div
                      key={t.hash}
                      className={`px-5 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 transition ${
                        isChecked ? 'bg-white/[0.04]' : 'hover:bg-white/[0.02]'
                      }`}
                    >
                      <div className="flex items-start gap-3.5 min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => toggleSelect(t.hash)}
                          className={`mt-1 w-4 h-4 rounded-md border flex items-center justify-center shrink-0 transition ${
                            isChecked
                              ? 'bg-white border-white text-zinc-950'
                              : 'border-white/20 hover:border-white/50'
                          }`}
                        >
                          {isChecked && <Check className="w-3 h-3 stroke-[3]" />}
                        </button>

                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              onClick={() => onOpenDetail(t.hash)}
                              className="text-sm font-medium text-white hover:underline truncate text-left"
                              title={t.name}
                            >
                              {title}
                            </button>
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border ${st.badge}`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                              {st.label}
                            </span>
                            {t.nextDeleteAt && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-rose-500/15 text-rose-300">
                                {formatCountdown(t.nextDeleteAt)}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-3 text-xs text-zinc-400 tabular-nums flex-wrap">
                            <span>
                              {formatBytes(t.size)}
                              {t.totalSize > t.size ? ` / ${formatBytes(t.totalSize)}` : ''}
                            </span>
                            <span>{pct.toFixed(1)}%</span>
                            {t.dlSpeed > 0 && (
                              <span className="text-emerald-300">↓ {formatSpeed(t.dlSpeed)}</span>
                            )}
                            {t.upSpeed > 0 && (
                              <span className="text-zinc-500">↑ {formatSpeed(t.upSpeed)}</span>
                            )}
                            <span className="text-zinc-500">
                              连接 {t.numSeeds} 做种 / {t.numLeechs} 下载
                            </span>
                          </div>

                          {/* Clean Progress Bar */}
                          <div className="h-1.5 w-full max-w-md rounded-full bg-white/[0.06] overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                pct >= 100 ? 'bg-emerald-400' : 'bg-white'
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Controls */}
                      <div className="flex items-center gap-1.5 shrink-0 pl-7 lg:pl-0 flex-wrap">
                        {t.primaryVideo?.existsOnDisk && (
                          <button
                            onClick={() =>
                              onPlay(t.hash, t.primaryVideo!.index, title)
                            }
                            className="btn-ivory px-3 py-1.5 text-xs"
                          >
                            <Play className="w-3 h-3 fill-current" />
                            播放
                          </button>
                        )}
                        <button
                          onClick={() => onOpenDetail(t.hash)}
                          title="查看选集与文件详情"
                          className="btn-ghost px-3 py-1.5 text-xs"
                        >
                          <SlidersHorizontal className="w-3 h-3" />
                          选集
                        </button>
                        <button
                          onClick={() => void handlePauseResume(t)}
                          title={isPaused ? '恢复下载' : '暂停下载'}
                          className="p-2 rounded-full border border-white/[0.08] text-zinc-300 hover:bg-white/[0.08] transition"
                        >
                          {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          onClick={() => void handleToggleSeq(t)}
                          title="边下边播（顺序下载）"
                          className={`p-2 rounded-full border transition ${
                            t.sequential
                              ? 'border-amber-400/35 bg-amber-400/15 text-amber-300'
                              : 'border-white/[0.08] text-zinc-500 hover:text-zinc-200'
                          }`}
                        >
                          <Zap className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => void handleToggleBinge(t)}
                          title="追剧托管模式"
                          className={`p-2 rounded-full border transition ${
                            t.bingeMode
                              ? 'border-amber-400/35 bg-amber-400/15 text-amber-300'
                              : 'border-white/[0.08] text-zinc-500 hover:text-zinc-200'
                          }`}
                        >
                          <Repeat className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => void handleDeleteOne(t)}
                          title="卸载并删除文件"
                          className="p-2 rounded-full border border-white/[0.08] text-zinc-400 hover:text-rose-300 hover:border-rose-400/40 hover:bg-rose-500/10 transition"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Floating Batch Action Dock when >= 1 selected */}
          {selected.size > 0 && (
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 cinema-glass rounded-full px-4 py-2 flex items-center gap-3 shadow-2xl">
              <span className="text-xs text-zinc-200 pl-2">已选 {selected.size} 项</span>
              <button
                onClick={() => void handleBatch('resume')}
                className="btn-ghost px-3 py-1.5 text-xs"
              >
                批量继续
              </button>
              <button
                onClick={() => void handleBatch('pause')}
                className="btn-ghost px-3 py-1.5 text-xs"
              >
                批量暂停
              </button>
              <button
                onClick={() => void handleBatch('delete')}
                className="px-3.5 py-1.5 rounded-full bg-rose-500 hover:bg-rose-400 text-white text-xs font-medium transition"
              >
                批量卸载
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="text-xs text-zinc-400 hover:text-white pr-1"
              >
                取消
              </button>
            </div>
          )}

          {/* Cleanup History Timeline */}
          <div className="cinema-surface rounded-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <History className="w-4 h-4 text-zinc-400" />
                最近空间清理记录
              </div>
              <span className="text-xs text-zinc-500">共 {logs.length} 条</span>
            </div>

            {logs.length === 0 ? (
              <div className="text-xs text-zinc-500 py-6 text-center">
                暂无清理记录，后续每次看完自动卸载或超水位淘汰都会清晰记录在此。
              </div>
            ) : (
              <div className="divide-y divide-white/[0.05]">
                {logs.slice(0, 20).map((log) => (
                  <div
                    key={log.id}
                    className="py-2.5 flex items-center justify-between gap-4 text-xs"
                  >
                    <div className="min-w-0 flex items-center gap-2.5">
                      <span className="px-2 py-0.5 rounded-full bg-white/[0.06] text-zinc-300 text-[11px] shrink-0">
                        {REASON_LABELS[log.reason] || log.reason}
                      </span>
                      <span className="text-zinc-200 truncate" title={log.relativePath}>
                        {log.relativePath}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 tabular-nums">
                      <span className="text-emerald-400 font-medium">
                        +{formatBytes(log.freedBytes)}
                      </span>
                      <span className="text-zinc-500 hidden sm:inline">
                        {new Date(log.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
