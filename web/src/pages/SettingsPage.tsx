import React, { useEffect, useState } from 'react';
import { HardDrive, Save, Trash2, RefreshCw, ShieldCheck } from 'lucide-react';
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
          ? '设置已保存，并已同步限速与停种规则到 qBittorrent。'
          : '设置已保存（qBittorrent 当前离线，上线后将自动同步）。'
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
          : '当前没有到期或超水位的待清理文件。'
      );
      onUpdated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '清理失败');
    } finally {
      setCleaning(false);
    }
  };

  if (!settings) {
    return <div className="text-sm text-slate-400 p-8 text-center">加载配置中...</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/75 p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
          <div>
            <h1 className="text-lg font-bold text-white flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-indigo-400" />
              小盘自动卸载与存储策略
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              专为 50–60 GB VPS 设计：看完自动卸载 + 磁盘硬水位 LRU 保护，防止爆盘宕机。
            </p>
          </div>
          <div className="text-xs px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-300">
            qBittorrent：{qbitInfo.connected ? `已连接 (${qbitInfo.version})` : '未连接'}
          </div>
        </div>

        {storage && (
          <div className="mb-6 rounded-xl bg-slate-950/80 border border-slate-800 p-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">当前视频目录占用</span>
              <span className="font-mono text-white">
                {formatBytes(storage.usedBytes)} / {formatBytes(storage.limitBytes)} (
                {storage.usagePercent}%)
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  storage.usagePercent >= 90
                    ? 'bg-rose-500'
                    : storage.usagePercent >= 75
                    ? 'bg-amber-400'
                    : 'bg-indigo-500'
                }`}
                style={{ width: `${Math.min(100, storage.usagePercent)}%` }}
              />
            </div>
            {storage.diskFreeBytes > 0 && (
              <div className="text-[11px] text-slate-400">
                宿主机分区剩余可用空间：{formatBytes(storage.diskFreeBytes)} / 总计{' '}
                {formatBytes(storage.diskTotalBytes)}
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                视频存储水位上限 (GB)
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
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2.5 text-sm text-white"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                50–60 GB 硬盘建议设为 40–45 GB，超出将按 LRU 自动淘汰至 85% 安全水位。
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                “已看完”判定进度阈值 (%)
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
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2.5 text-sm text-white"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                默认 90%（片尾字幕出现即视为看完，触发自动卸载倒计时）。
              </p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              看完后自动卸载缓冲时间（小时，0 = 看完立刻删除）
            </label>
            <div className="flex items-center gap-2 flex-wrap mb-2">
              {[
                { label: '0h (立即卸载)', val: 0 },
                { label: '2 小时', val: 2 },
                { label: '12 小时', val: 12 },
                { label: '24 小时 (推荐)', val: 24 },
                { label: '72 小时', val: 72 },
              ].map((preset) => (
                <button
                  key={preset.val}
                  type="button"
                  onClick={() => setSettings({ ...settings, autoDeleteDelayHours: preset.val })}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition ${
                    settings.autoDeleteDelayHours === preset.val
                      ? 'bg-indigo-600/25 border-indigo-500 text-indigo-200'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
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
              className="w-40 rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2 text-sm text-white"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-800/80">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                BT 上传限速 (KB/s，0 = 不限速)
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
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2.5 text-sm text-white"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                防止 BT 上传抢占看片带宽或消耗 VPS 月流量包。
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
                  className="rounded border-slate-600 bg-slate-800 text-indigo-500"
                />
                <span className="text-xs sm:text-sm text-slate-200">
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
                  className="rounded border-slate-600 bg-slate-800 text-indigo-500"
                />
                <span className="text-xs sm:text-sm text-slate-200">
                  下载完成后自动停种（公开 BT 推荐，PT 请关闭）
                </span>
              </label>
            </div>
          </div>

          {message && (
            <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/30 px-4 py-2.5 text-xs text-indigo-200 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              {message}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={cleaning}
                onClick={() => void handleManualCleanup(false)}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${cleaning ? 'animate-spin' : ''}`} />
                立即检查到期与水位
              </button>
              <button
                type="button"
                disabled={cleaning}
                onClick={() => void handleManualCleanup(true)}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/30 text-xs font-medium text-rose-200 transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
                立即卸载所有已看视频
              </button>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-semibold text-white transition"
            >
              <Save className="w-4 h-4" />
              {saving ? '保存中...' : '保存设置'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
