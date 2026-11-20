import React, { useEffect, useState } from 'react';
import { Save, Trash2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { AppSettings, StorageStats } from '../types';
import { apiFetch, formatBytes } from '../lib/api';

interface SettingsPageProps {
  onUpdated: () => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ onUpdated }) => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [qbitInfo, setQbitInfo] = useState<{ connected: boolean; version?: string }>({
    connected: false,
  });
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [message, setMessage] = useState('');

  const load = async () => {
    const res = await apiFetch<{
      settings: AppSettings;
      storage: StorageStats;
      qbit: { connected: boolean; version?: string };
    }>('/api/settings');
    setSettings(res.settings);
    setStorage(res.storage);
    setQbitInfo(res.qbit);
  };

  useEffect(() => {
    void load();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setMessage('');
    try {
      const res = await apiFetch<{
        settings: AppSettings;
        storage: StorageStats;
        qbitSynced: boolean;
      }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      setSettings(res.settings);
      setStorage(res.storage);
      setMessage(
        res.qbitSynced
          ? '配置已保存并同步至 qBittorrent 引擎。'
          : '配置已保存（qBittorrent 当前离线，恢复连接后自动同步）。'
      );
      onUpdated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleManualCleanup = async (forceWatchedNow: boolean) => {
    if (
      forceWatchedNow &&
      !confirm('确定立刻卸载所有已标记看完（且未锁定）的视频文件释放空间？')
    ) {
      return;
    }
    setCleaning(true);
    setMessage('');
    try {
      const res = await apiFetch<{
        deletedItems: Array<{ relativePath: string }>;
        freedBytes: number;
        storageAfter: StorageStats;
      }>('/api/cleanup/run', {
        method: 'POST',
        body: JSON.stringify({ forceWatchedNow }),
      });
      setStorage(res.storageAfter);
      setMessage(
        res.deletedItems.length > 0
          ? `清理完成：卸载 ${res.deletedItems.length} 个文件，释放 ${formatBytes(res.freedBytes)}。`
          : '当前无到期或超水位的待卸载文件。'
      );
      onUpdated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '清理失败');
    } finally {
      setCleaning(false);
    }
  };

  if (!settings) {
    return <div className="text-xs font-mono text-zinc-500 p-12 text-center">LOADING SYS CONFIG...</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="hud-panel p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3 flex-wrap pb-5 border-b border-white/[0.07]">
          <div>
            <div className="text-[10px] font-mono tracking-[0.22em] text-cyan-400">
              SYSTEM // STORAGE LIFECYCLE
            </div>
            <h1 className="text-base sm:text-lg font-semibold text-white mt-0.5">
              小盘自动卸载与水位策略
            </h1>
            <p className="text-xs text-zinc-400 mt-1">
              播放完成自动定时卸载 + 磁盘上限 LRU 保护，避免 50–60 GB 服务器爆盘。
            </p>
          </div>
          <div className="text-[11px] font-mono px-2.5 py-1 border border-white/10 bg-[#05070a] text-zinc-300">
            ENGINE:{' '}
            <span className={qbitInfo.connected ? 'text-emerald-400' : 'text-amber-400'}>
              {qbitInfo.connected ? `ONLINE (${qbitInfo.version})` : 'OFFLINE'}
            </span>
          </div>
        </div>

        {storage && (
          <div className="my-5 border border-white/[0.08] bg-[#06090e] p-4 space-y-2">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-zinc-500">DOWNLOAD VOLUME USAGE</span>
              <span className="text-white">
                {formatBytes(storage.usedBytes)} / {formatBytes(storage.limitBytes)} (
                {storage.usagePercent}%)
              </span>
            </div>
            <div className="h-[3px] w-full bg-zinc-800">
              <div
                className={`h-full ${
                  storage.usagePercent >= 90
                    ? 'bg-rose-500'
                    : storage.usagePercent >= 75
                    ? 'bg-amber-400'
                    : 'bg-cyan-400'
                }`}
                style={{ width: `${Math.min(100, storage.usagePercent)}%` }}
              />
            </div>
            {storage.diskFreeBytes > 0 && (
              <div className="text-[11px] font-mono text-zinc-500">
                宿主机分区真实剩余：{formatBytes(storage.diskFreeBytes)} / 总计{' '}
                {formatBytes(storage.diskTotalBytes)}
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5">
                STORAGE LIMIT (GB)
              </label>
              <input
                type="number"
                min={1}
                max={10000}
                step={1}
                value={settings.storageLimitGb}
                onChange={(e) =>
                  setSettings({ ...settings, storageLimitGb: Math.max(1, Number(e.target.value)) })
                }
                className="w-full bg-[#05070a] border border-white/10 px-3.5 py-2 text-sm font-mono text-white focus:outline-none focus:border-cyan-400/60"
              />
              <p className="text-[11px] text-zinc-500 mt-1">
                50–60 GB 硬盘建议设为 40–45 GB，超限自动 LRU 淘汰至 85%。
              </p>
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5">
                WATCHED THRESHOLD (%)
              </label>
              <input
                type="number"
                min={50}
                max={99}
                step={1}
                value={Math.round(settings.watchedThreshold * 100)}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    watchedThreshold: Math.min(0.99, Math.max(0.5, Number(e.target.value) / 100)),
                  })
                }
                className="w-full bg-[#05070a] border border-white/10 px-3.5 py-2 text-sm font-mono text-white focus:outline-none focus:border-cyan-400/60"
              />
              <p className="text-[11px] text-zinc-500 mt-1">
                默认 90%，达到即触发自动卸载倒计时。
              </p>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5">
              AUTO-PURGE DELAY (HOURS · 0 = IMMEDIATE)
            </label>
            <div className="flex items-center gap-2 flex-wrap mb-2.5">
              {[
                { label: '0h 立即卸载', val: 0 },
                { label: '2h', val: 2 },
                { label: '12h', val: 12 },
                { label: '24h (推荐)', val: 24 },
                { label: '72h', val: 72 },
              ].map((preset) => (
                <button
                  key={preset.val}
                  type="button"
                  onClick={() => setSettings({ ...settings, autoDeleteDelayHours: preset.val })}
                  className={`px-3 py-1.5 text-xs font-mono border transition ${
                    settings.autoDeleteDelayHours === preset.val
                      ? 'bg-cyan-400/15 border-cyan-400/60 text-cyan-200'
                      : 'bg-[#05070a] border-white/10 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={0}
              max={720}
              step={0.5}
              value={settings.autoDeleteDelayHours}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  autoDeleteDelayHours: Math.max(0, Number(e.target.value)),
                })
              }
              className="w-40 bg-[#05070a] border border-white/10 px-3.5 py-2 text-sm font-mono text-white focus:outline-none focus:border-cyan-400/60"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-white/[0.07]">
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5">
                BT UPLOAD LIMIT (KB/s · 0 = UNLIMITED)
              </label>
              <input
                type="number"
                min={0}
                max={1000000}
                step={64}
                value={settings.uploadLimitKbps}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    uploadLimitKbps: Math.max(0, Number(e.target.value)),
                  })
                }
                className="w-full bg-[#05070a] border border-white/10 px-3.5 py-2 text-sm font-mono text-white focus:outline-none focus:border-cyan-400/60"
              />
              <p className="text-[11px] text-zinc-500 mt-1">
                避免 BT 上传抢占看片带宽与服务器月流量。
              </p>
            </div>

            <div className="space-y-3 pt-1">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.autoCleanupEnabled}
                  onChange={(e) =>
                    setSettings({ ...settings, autoCleanupEnabled: e.target.checked })
                  }
                  className="accent-cyan-400"
                />
                <span className="text-xs text-zinc-200">
                  启用自动卸载与磁盘水位 LRU 保护
                </span>
              </label>

              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.stopSeedingOnComplete}
                  onChange={(e) =>
                    setSettings({ ...settings, stopSeedingOnComplete: e.target.checked })
                  }
                  className="accent-cyan-400"
                />
                <span className="text-xs text-zinc-200">
                  下载完成后自动停种（公开 BT 推荐，PT 请关闭）
                </span>
              </label>
            </div>
          </div>

          {message && (
            <div className="border border-cyan-400/35 bg-cyan-950/30 px-4 py-2.5 text-xs font-mono text-cyan-200 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              {message}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap pt-3 border-t border-white/[0.07]">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={cleaning}
                onClick={() => void handleManualCleanup(false)}
                className="flex items-center gap-1.5 px-3.5 py-2 border border-white/10 hover:border-cyan-400/40 bg-white/[0.03] text-xs font-mono text-zinc-200 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${cleaning ? 'animate-spin' : ''}`} />
                立即巡检水位
              </button>
              <button
                type="button"
                disabled={cleaning}
                onClick={() => void handleManualCleanup(true)}
                className="flex items-center gap-1.5 px-3.5 py-2 border border-rose-500/40 bg-rose-950/40 hover:bg-rose-600 text-xs font-mono text-rose-200 hover:text-white transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
                卸载全部已看
              </button>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 px-5 py-2 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40 text-xs font-mono font-bold tracking-wider text-zinc-950 transition"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? 'SAVING...' : 'SAVE CONFIG'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
