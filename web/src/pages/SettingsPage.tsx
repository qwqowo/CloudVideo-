import React, { useEffect, useState } from 'react';
import {
  Save,
  Trash2,
  RefreshCw,
  ShieldCheck,
  HardDrive,
  Globe,
  Bell,
  History,
  Zap,
  Send,
} from 'lucide-react';
import type { AppSettings, CleanupLogRecord, StorageStats } from '../types';
import { apiFetch, formatBytes } from '../lib/api';

interface SettingsPageProps {
  onUpdated: () => void;
}

type SettingsTab = 'storage' | 'network' | 'integrations';

const REASON_LABELS: Record<string, { label: string; color: string }> = {
  watched_delay_expired: { label: '看完到期卸载', color: 'text-emerald-300 border-emerald-500/40 bg-emerald-950/40' },
  watched_immediate: { label: '看完立即卸载', color: 'text-emerald-300 border-emerald-500/40 bg-emerald-950/40' },
  storage_limit_lru: { label: '超水位 LRU 淘汰', color: 'text-amber-300 border-amber-500/40 bg-amber-950/40' },
  manual_watched_cleanup: { label: '一键清理已看', color: 'text-cyan-300 border-cyan-500/40 bg-cyan-950/40' },
  manual_unload: { label: '手动单集卸载', color: 'text-zinc-300 border-white/15 bg-white/[0.03]' },
  manual_torrent_unload: { label: '手动整包卸载', color: 'text-zinc-300 border-white/15 bg-white/[0.03]' },
  batch_manual_unload: { label: '批量卸载', color: 'text-rose-300 border-rose-500/40 bg-rose-950/40' },
};

export const SettingsPage: React.FC<SettingsPageProps> = ({ onUpdated }) => {
  const [subTab, setSubTab] = useState<SettingsTab>('storage');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [logs, setLogs] = useState<CleanupLogRecord[]>([]);
  const [qbitInfo, setQbitInfo] = useState<{ connected: boolean; version?: string }>({
    connected: false,
  });
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [syncingTrackers, setSyncingTrackers] = useState(false);
  const [testingNotify, setTestingNotify] = useState(false);
  const [message, setMessage] = useState('');

  const load = async () => {
    const [res, logRes] = await Promise.all([
      apiFetch<{
        settings: AppSettings;
        storage: StorageStats;
        qbit: { connected: boolean; version?: string };
      }>('/api/settings'),
      apiFetch<{ logs: CleanupLogRecord[] }>('/api/cleanup/logs').catch(() => ({ logs: [] })),
    ]);
    setSettings(res.settings);
    setStorage(res.storage);
    setQbitInfo(res.qbit);
    setLogs(logRes.logs);
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
          ? '配置已保存并同步至 qBittorrent（含限速、停种与代理规则）。'
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
      await load();
      onUpdated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '清理失败');
    } finally {
      setCleaning(false);
    }
  };

  const handleSyncTrackers = async () => {
    setSyncingTrackers(true);
    setMessage('');
    try {
      const res = await apiFetch<{ count: number; updatedTorrents: number; source: string }>(
        '/api/trackers/sync',
        { method: 'POST' }
      );
      setMessage(
        `已拉取并注入 ${res.count} 条公共高速 Tracker（同步至 ${res.updatedTorrents} 个活跃下载任务）。`
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '同步 Tracker 失败');
    } finally {
      setSyncingTrackers(false);
    }
  };

  const handleTestNotification = async () => {
    setTestingNotify(true);
    setMessage('');
    try {
      // Save current notification settings first so test uses latest fields
      if (settings) {
        await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
      }
      const res = await apiFetch<{
        ok: boolean;
        telegramSent: boolean;
        webhookSent: boolean;
        errors: string[];
      }>('/api/notifications/test', { method: 'POST' });
      if (res.ok) {
        setMessage(
          `测试通知已发送（Telegram: ${res.telegramSent ? '成功' : '未配置'} / Webhook: ${
            res.webhookSent ? '成功' : '未配置'
          }）。`
        );
      } else {
        setMessage(
          res.errors.length > 0
            ? `发送失败：${res.errors.join('；')}`
            : '请先填写 Telegram Bot Token + Chat ID 或 Webhook URL。'
        );
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '测试通知失败');
    } finally {
      setTestingNotify(false);
    }
  };

  if (!settings) {
    return (
      <div className="text-xs font-mono text-zinc-500 p-12 text-center">LOADING SYS CONFIG...</div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div className="hud-panel p-5 sm:p-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap pb-4 border-b border-white/[0.07]">
          <div>
            <div className="text-[10px] font-mono tracking-[0.22em] text-cyan-400">
              SYSTEM // CONTROL MATRIX
            </div>
            <h1 className="text-base sm:text-lg font-semibold text-white mt-0.5">
              存储策略 · 网络加速 · 刮削与通知
            </h1>
          </div>
          <div className="text-[11px] font-mono px-2.5 py-1 border border-white/10 bg-[#05070a] text-zinc-300">
            ENGINE:{' '}
            <span className={qbitInfo.connected ? 'text-emerald-400' : 'text-amber-400'}>
              {qbitInfo.connected ? `ONLINE (${qbitInfo.version})` : 'OFFLINE'}
            </span>
          </div>
        </div>

        {/* Sub-Tabs */}
        <div className="flex items-center gap-1 border-b border-white/[0.07] mt-3 mb-5 overflow-x-auto">
          {[
            { id: 'storage' as const, label: '小盘存储与审计日志', icon: HardDrive },
            { id: 'network' as const, label: 'BT 代理与高速 Tracker', icon: Globe },
            { id: 'integrations' as const, label: 'TMDB 海报刮削与离线通知', icon: Bell },
          ].map((t) => {
            const Icon = t.icon;
            const active = subTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setSubTab(t.id)}
                className={`relative flex items-center gap-2 px-3.5 py-2.5 text-xs font-mono whitespace-nowrap transition ${
                  active ? 'text-cyan-300 bg-cyan-400/[0.07]' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
                {active && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-cyan-400" />}
              </button>
            );
          })}
        </div>

        <form onSubmit={handleSave} className="space-y-5">
          {subTab === 'storage' && (
            <>
              {storage && (
                <div className="border border-white/[0.08] bg-[#06090e] p-4 space-y-2">
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

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5">
                    存储水位上限 (GB)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    step={1}
                    value={settings.storageLimitGb}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        storageLimitGb: Math.max(1, Number(e.target.value)),
                      })
                    }
                    className="w-full bg-[#05070a] border border-white/10 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-cyan-400/60"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">50–60 GB 盘建议 40–45 GB。</p>
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5">
                    已看完判定阈值 (%)
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
                        watchedThreshold: Math.min(
                          0.99,
                          Math.max(0.5, Number(e.target.value) / 100)
                        ),
                      })
                    }
                    className="w-full bg-[#05070a] border border-white/10 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-cyan-400/60"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">默认 90% 触发自动卸载。</p>
                </div>

                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5">
                    追剧托管默认预载集数
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    value={settings.bingePreloadCount}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        bingePreloadCount: Math.min(10, Math.max(1, Number(e.target.value))),
                      })
                    }
                    className="w-full bg-[#05070a] border border-white/10 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-cyan-400/60"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">播到 70% 自动预载下集。</p>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5">
                  看完后自动卸载缓冲时间（小时 · 0 = 看完立刻删除）
                </label>
                <div className="flex items-center gap-2 flex-wrap mb-2">
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
                    className="w-24 bg-[#05070a] border border-white/10 px-2.5 py-1.5 text-xs font-mono text-white"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={settings.autoCleanupEnabled}
                  onChange={(e) =>
                    setSettings({ ...settings, autoCleanupEnabled: e.target.checked })
                  }
                  className="accent-cyan-400"
                />
                <span className="text-xs text-zinc-200">
                  启用自动定时卸载与超水位 LRU 保护（防止系统盘被撑爆）
                </span>
              </label>
            </>
          )}

          {subTab === 'network' && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5">
                    BT 上传限速 (KB/s · 0 = 不限速)
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
                    className="w-full bg-[#05070a] border border-white/10 px-3 py-2 text-sm font-mono text-white"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">
                    避免 BT 上传抢占看片带宽与月流量包。
                  </p>
                </div>

                <div className="flex flex-col justify-center gap-3">
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

                  <div>
                    <button
                      type="button"
                      disabled={syncingTrackers}
                      onClick={() => void handleSyncTrackers()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-amber-500/40 bg-amber-950/30 hover:bg-amber-500/20 text-xs font-mono text-amber-200 transition"
                    >
                      <Zap className="w-3.5 h-3.5" />
                      {syncingTrackers ? '同步中...' : '一键注入公共高速 Tracker（加速解析磁力）'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="border border-white/[0.08] bg-[#06090e] p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-white">
                      BT 出口代理（HTTP / SOCKS5）
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      将 qBittorrent 下载与 Tracker 流量转发至指定代理，规避欧美机房版权投诉或加速拉种。
                    </div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer text-xs font-mono text-cyan-300">
                    <input
                      type="checkbox"
                      checked={settings.proxyEnabled}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          proxyEnabled: e.target.checked,
                          proxyType:
                            e.target.checked && settings.proxyType === 'none'
                              ? 'socks5'
                              : settings.proxyType,
                        })
                      }
                      className="accent-cyan-400"
                    />
                    启用代理
                  </label>
                </div>

                {settings.proxyEnabled && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-white/[0.06]">
                    <div>
                      <label className="block text-[10px] font-mono text-zinc-400 mb-1">协议</label>
                      <select
                        value={settings.proxyType}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            proxyType: e.target.value as AppSettings['proxyType'],
                          })
                        }
                        className="w-full bg-[#05070a] border border-white/10 px-2.5 py-2 text-xs font-mono text-white"
                      >
                        <option value="socks5">SOCKS5</option>
                        <option value="http">HTTP</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-mono text-zinc-400 mb-1">
                        代理地址 (IP / 域名)
                      </label>
                      <input
                        type="text"
                        value={settings.proxyHost}
                        onChange={(e) => setSettings({ ...settings, proxyHost: e.target.value })}
                        placeholder="127.0.0.1 或 proxy-host"
                        className="w-full bg-[#05070a] border border-white/10 px-2.5 py-2 text-xs font-mono text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-mono text-zinc-400 mb-1">端口</label>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={settings.proxyPort}
                        onChange={(e) =>
                          setSettings({ ...settings, proxyPort: Number(e.target.value) || 1080 })
                        }
                        className="w-full bg-[#05070a] border border-white/10 px-2.5 py-2 text-xs font-mono text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-mono text-zinc-400 mb-1">
                        用户名（可选）
                      </label>
                      <input
                        type="text"
                        value={settings.proxyUsername}
                        onChange={(e) =>
                          setSettings({ ...settings, proxyUsername: e.target.value })
                        }
                        className="w-full bg-[#05070a] border border-white/10 px-2.5 py-2 text-xs font-mono text-white"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-[10px] font-mono text-zinc-400 mb-1">
                        密码（可选）
                      </label>
                      <input
                        type="password"
                        value={settings.proxyPassword}
                        onChange={(e) =>
                          setSettings({ ...settings, proxyPassword: e.target.value })
                        }
                        className="w-full bg-[#05070a] border border-white/10 px-2.5 py-2 text-xs font-mono text-white"
                      />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {subTab === 'integrations' && (
            <>
              <div className="border border-white/[0.08] bg-[#06090e] p-4 space-y-3">
                <div className="text-xs font-semibold text-white">
                  TMDB 影院海报与中文元数据刮削（可选）
                </div>
                <p className="text-[11px] text-zinc-500">
                  填入免费申请的 TMDB v3 API Key 或 v4 Read Access Token，媒体库将自动拉取高清剧照背景、中文片名、评分与简介；不填则默认使用本地智能避黑屏抽帧。
                </p>
                <input
                  type="password"
                  value={settings.tmdbApiKey}
                  onChange={(e) => setSettings({ ...settings, tmdbApiKey: e.target.value })}
                  placeholder="输入 TMDB API Key (32位) 或 Read Access Token (eyJ...)"
                  className="w-full bg-[#05070a] border border-white/10 px-3 py-2 text-xs font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-cyan-400/60"
                />
              </div>

              <div className="border border-white/[0.08] bg-[#06090e] p-4 space-y-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <div className="text-xs font-semibold text-white">
                      下载完成离线推送通知（Telegram Bot / Webhook）
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      挂机下载冷门大文件完成后自动推送消息，手机点开即可观看。
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={testingNotify}
                    onClick={() => void handleTestNotification()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-cyan-400/40 bg-cyan-950/30 hover:bg-cyan-400/20 text-xs font-mono text-cyan-200 transition"
                  >
                    <Send className="w-3 h-3" />
                    {testingNotify ? '发送中...' : '发送测试通知'}
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-mono text-zinc-400 mb-1">
                      TELEGRAM BOT TOKEN
                    </label>
                    <input
                      type="password"
                      value={settings.telegramBotToken}
                      onChange={(e) =>
                        setSettings({ ...settings, telegramBotToken: e.target.value })
                      }
                      placeholder="123456:ABC-DEF..."
                      className="w-full bg-[#05070a] border border-white/10 px-3 py-2 text-xs font-mono text-white placeholder-zinc-600"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono text-zinc-400 mb-1">
                      TELEGRAM CHAT ID
                    </label>
                    <input
                      type="text"
                      value={settings.telegramChatId}
                      onChange={(e) =>
                        setSettings({ ...settings, telegramChatId: e.target.value })
                      }
                      placeholder="例如 987654321"
                      className="w-full bg-[#05070a] border border-white/10 px-3 py-2 text-xs font-mono text-white placeholder-zinc-600"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-mono text-zinc-400 mb-1">
                    自定义 WEBHOOK URL（POST JSON，兼容 Bark / 飞书 / 企微 / 自建服务）
                  </label>
                  <input
                    type="text"
                    value={settings.webhookUrl}
                    onChange={(e) => setSettings({ ...settings, webhookUrl: e.target.value })}
                    placeholder="https://example.com/webhook"
                    className="w-full bg-[#05070a] border border-white/10 px-3 py-2 text-xs font-mono text-white placeholder-zinc-600"
                  />
                </div>
              </div>
            </>
          )}

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

      {/* Cleanup Audit Log Timeline */}
      {subTab === 'storage' && (
        <div className="hud-panel p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-xs font-mono tracking-[0.16em] text-zinc-400">
              <History className="w-3.5 h-3.5 text-cyan-400" />
              PURGE AUDIT LOG // 自动与手动卸载记录
            </div>
            <span className="text-[10px] font-mono text-zinc-500">最近 {logs.length} 条</span>
          </div>

          {logs.length === 0 ? (
            <div className="text-xs font-mono text-zinc-600 py-6 text-center">
              暂无清理记录，后续每次自动卸载或超水位 LRU 淘汰都会记录在此。
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="text-[10px] text-zinc-500 border-b border-white/[0.08]">
                  <tr>
                    <th className="py-2 pr-3">时间</th>
                    <th className="py-2 pr-3">触发原因</th>
                    <th className="py-2 pr-3">目标文件 / 种子</th>
                    <th className="py-2 text-right">释放空间</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05] text-zinc-200">
                  {logs.map((log) => {
                    const meta = REASON_LABELS[log.reason] || {
                      label: log.reason,
                      color: 'text-zinc-300 border-white/15 bg-white/[0.03]',
                    };
                    return (
                      <tr key={log.id} className="hover:bg-white/[0.02]">
                        <td className="py-2 pr-3 text-zinc-500 whitespace-nowrap">
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <span className={`px-1.5 py-0.5 text-[10px] border ${meta.color}`}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="py-2 pr-3 max-w-md truncate" title={log.relativePath}>
                          {log.relativePath}
                        </td>
                        <td className="py-2 text-right text-emerald-300 whitespace-nowrap">
                          +{formatBytes(log.freedBytes)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
