import React, { useEffect, useState } from 'react';
import {
  Save,
  ShieldCheck,
  HardDrive,
  Globe,
  Bell,
  Zap,
  Send,
} from 'lucide-react';
import type { AppSettings, StorageStats } from '../types';
import { apiFetch } from '../lib/api';

interface SettingsPageProps {
  onUpdated: () => void;
}

type SettingsTab = 'storage' | 'network' | 'integrations';

const ToggleRow: React.FC<{
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}> = ({ title, description, checked, onChange }) => (
  <button
    type="button"
    onClick={() => onChange(!checked)}
    className="w-full text-left flex items-center justify-between gap-4 py-3"
  >
    <div>
      <div className="text-sm font-medium text-white">{title}</div>
      <div className="text-xs text-zinc-400 mt-0.5">{description}</div>
    </div>
    <span
      className={`w-11 h-6 rounded-full transition flex items-center px-0.5 shrink-0 ${
        checked ? 'bg-white justify-end' : 'bg-zinc-700 justify-start'
      }`}
    >
      <span className={`w-5 h-5 rounded-full ${checked ? 'bg-zinc-950' : 'bg-zinc-400'}`} />
    </span>
  </button>
);

export const SettingsPage: React.FC<SettingsPageProps> = ({ onUpdated }) => {
  const [subTab, setSubTab] = useState<SettingsTab>('storage');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [qbitInfo, setQbitInfo] = useState<{ connected: boolean; version?: string }>({
    connected: false,
  });
  const [saving, setSaving] = useState(false);
  const [syncingTrackers, setSyncingTrackers] = useState(false);
  const [testingNotify, setTestingNotify] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void (async () => {
      const res = await apiFetch<{
        settings: AppSettings;
        storage: StorageStats;
        qbit: { connected: boolean; version?: string };
      }>('/api/settings');
      setSettings(res.settings);
      setQbitInfo(res.qbit);
    })();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setMessage('');
    try {
      const res = await apiFetch<{
        settings: AppSettings;
        qbitSynced: boolean;
      }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      setSettings(res.settings);
      setMessage(
        res.qbitSynced
          ? '设置已保存并同步到下载引擎。'
          : '设置已保存（下载引擎当前离线，恢复后自动同步）。'
      );
      onUpdated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleSyncTrackers = async () => {
    setSyncingTrackers(true);
    setMessage('');
    try {
      const res = await apiFetch<{ count: number; updatedTorrents: number }>(
        '/api/trackers/sync',
        { method: 'POST' }
      );
      setMessage(`已注入 ${res.count} 条高速公共 Tracker（同步至 ${res.updatedTorrents} 个任务）。`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '同步失败');
    } finally {
      setSyncingTrackers(false);
    }
  };

  const handleTestNotification = async () => {
    setTestingNotify(true);
    setMessage('');
    try {
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
          `测试推送已发出（Telegram：${res.telegramSent ? '成功' : '未填'} · Webhook：${
            res.webhookSent ? '成功' : '未填'
          }）。`
        );
      } else {
        setMessage(
          res.errors.length > 0
            ? `推送失败：${res.errors.join('；')}`
            : '请先填写 Telegram 或 Webhook 配置。'
        );
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '测试推送失败');
    } finally {
      setTestingNotify(false);
    }
  };

  if (!settings) {
    return <div className="text-xs text-zinc-500 p-12 text-center">正在加载设置...</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">影院设置</h1>
          <p className="text-xs text-zinc-400 mt-1">
            管理自动清理规则、下载网络加速、TMDB 海报刮削与离线通知
          </p>
        </div>

        <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.07] text-xs self-start">
          <span
            className={`w-2 h-2 rounded-full ${
              qbitInfo.connected ? 'bg-emerald-400' : 'bg-amber-400'
            }`}
          />
          <span className="text-zinc-300">
            {qbitInfo.connected ? `qBittorrent ${qbitInfo.version}` : '引擎连接中'}
          </span>
        </span>
      </div>

      {/* Segmented Pill Nav */}
      <div className="inline-flex p-1 rounded-full bg-white/[0.04] border border-white/[0.07] overflow-x-auto max-w-full">
        {[
          { id: 'storage' as const, label: '空间与清理', icon: HardDrive },
          { id: 'network' as const, label: '网络与 BT', icon: Globe },
          { id: 'integrations' as const, label: '海报与推送', icon: Bell },
        ].map((t) => {
          const Icon = t.icon;
          const active = subTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition ${
                active ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      <form onSubmit={handleSave} className="space-y-5">
        {subTab === 'storage' && (
          <div className="cinema-surface rounded-3xl p-6 space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">存储上限 (GB)</label>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={settings.storageLimitGb}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      storageLimitGb: Math.max(1, Number(e.target.value)),
                    })
                  }
                  className="cinema-input w-full px-3.5 py-2.5 text-sm tabular-nums"
                />
                <p className="text-[11px] text-zinc-500 mt-1">120G 盘建议设为 90–95 GB</p>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">看完判定阈值 (%)</label>
                <input
                  type="number"
                  min={50}
                  max={99}
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
                  className="cinema-input w-full px-3.5 py-2.5 text-sm tabular-nums"
                />
                <p className="text-[11px] text-zinc-500 mt-1">默认播到 90% 记为已看</p>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">追剧默认预载集数</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={settings.bingePreloadCount}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      bingePreloadCount: Math.min(10, Math.max(1, Number(e.target.value))),
                    })
                  }
                  className="cinema-input w-full px-3.5 py-2.5 text-sm tabular-nums"
                />
                <p className="text-[11px] text-zinc-500 mt-1">播到 70% 自动预载下集</p>
              </div>
            </div>

            <div className="pt-4 border-t border-white/[0.06] space-y-2.5">
              <label className="block text-xs text-zinc-400">
                看完后延迟自动卸载（0 小时 = 看完立即删除）
              </label>
              <div className="flex items-center gap-2 flex-wrap">
                {[
                  { label: '立即卸载', val: 0 },
                  { label: '2 小时', val: 2 },
                  { label: '12 小时', val: 12 },
                  { label: '24 小时 (推荐)', val: 24 },
                  { label: '72 小时', val: 72 },
                ].map((preset) => (
                  <button
                    key={preset.val}
                    type="button"
                    onClick={() => setSettings({ ...settings, autoDeleteDelayHours: preset.val })}
                    className={`px-3.5 py-1.5 rounded-full text-xs transition ${
                      settings.autoDeleteDelayHours === preset.val
                        ? 'bg-white text-zinc-950 font-medium'
                        : 'bg-white/[0.05] text-zinc-300 hover:bg-white/[0.1]'
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
                  className="cinema-input w-24 px-3 py-1.5 text-xs tabular-nums"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-white/[0.06]">
              <ToggleRow
                title="自动清理与超水位保护"
                description="看完到期后自动卸载未锁定影片；超出存储上限时按最久未看自动释放空间"
                checked={settings.autoCleanupEnabled}
                onChange={(v) => setSettings({ ...settings, autoCleanupEnabled: v })}
              />
            </div>
          </div>
        )}

        {subTab === 'network' && (
          <div className="space-y-5">
            <div className="cinema-surface rounded-3xl p-6 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">
                    BT 上传限速 (KB/s，0 为不限速)
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
                    className="cinema-input w-full px-3.5 py-2.5 text-sm tabular-nums"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">防止上传占满观影带宽与流量包</p>
                </div>

                <div className="flex flex-col items-start gap-2">
                  <div className="text-xs text-zinc-400">磁力加速</div>
                  <button
                    type="button"
                    disabled={syncingTrackers}
                    onClick={() => void handleSyncTrackers()}
                    className="btn-ghost px-4 py-2.5 text-xs text-amber-200 hover:border-amber-400/40"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    {syncingTrackers ? '同步中...' : '一键注入高速公共 Tracker'}
                  </button>
                </div>
              </div>

              <div className="pt-3 border-t border-white/[0.06]">
                <ToggleRow
                  title="下载完成后自动停种"
                  description="公开 BT 推荐开启以节省流量；使用私有 PT 站请关闭"
                  checked={settings.stopSeedingOnComplete}
                  onChange={(v) => setSettings({ ...settings, stopSeedingOnComplete: v })}
                />
              </div>
            </div>

            <div className="cinema-surface rounded-3xl p-6 space-y-4">
              <ToggleRow
                title="BT 出口代理（HTTP / SOCKS5）"
                description="将下载与 Tracker 流量转发至指定代理服务器"
                checked={settings.proxyEnabled}
                onChange={(v) =>
                  setSettings({
                    ...settings,
                    proxyEnabled: v,
                    proxyType: v && settings.proxyType === 'none' ? 'socks5' : settings.proxyType,
                  })
                }
              />

              {settings.proxyEnabled && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-white/[0.06]">
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">协议</label>
                    <select
                      value={settings.proxyType}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          proxyType: e.target.value as AppSettings['proxyType'],
                        })
                      }
                      className="cinema-input w-full px-3 py-2 text-xs"
                    >
                      <option value="socks5">SOCKS5</option>
                      <option value="http">HTTP</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">代理主机</label>
                    <input
                      type="text"
                      value={settings.proxyHost}
                      onChange={(e) => setSettings({ ...settings, proxyHost: e.target.value })}
                      placeholder="127.0.0.1"
                      className="cinema-input w-full px-3 py-2 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">端口</label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={settings.proxyPort}
                      onChange={(e) =>
                        setSettings({ ...settings, proxyPort: Number(e.target.value) || 1080 })
                      }
                      className="cinema-input w-full px-3 py-2 text-xs tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">用户名（可选）</label>
                    <input
                      type="text"
                      value={settings.proxyUsername}
                      onChange={(e) => setSettings({ ...settings, proxyUsername: e.target.value })}
                      className="cinema-input w-full px-3 py-2 text-xs"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-zinc-400 mb-1">密码（可选）</label>
                    <input
                      type="password"
                      value={settings.proxyPassword}
                      onChange={(e) => setSettings({ ...settings, proxyPassword: e.target.value })}
                      className="cinema-input w-full px-3 py-2 text-xs"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {subTab === 'integrations' && (
          <div className="space-y-5">
            <div className="cinema-surface rounded-3xl p-6 space-y-3">
              <div className="text-sm font-semibold text-white">TMDB 影院海报与中文简介刮削</div>
              <p className="text-xs text-zinc-400">
                填入免费申请的 TMDB v3 API Key 或 v4 Read Token，影院将自动匹配高清剧照背景、中文片名、评分与简介。
              </p>
              <input
                type="password"
                value={settings.tmdbApiKey}
                onChange={(e) => setSettings({ ...settings, tmdbApiKey: e.target.value })}
                placeholder="输入 TMDB API Key 或 Read Access Token"
                className="cinema-input w-full px-3.5 py-2.5 text-xs font-mono"
              />
            </div>

            <div className="cinema-surface rounded-3xl p-6 space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-sm font-semibold text-white">离线下载与追更推送</div>
                  <div className="text-xs text-zinc-400 mt-0.5">
                    影片下完或 RSS 订阅命中新集时发送消息通知
                  </div>
                </div>
                <button
                  type="button"
                  disabled={testingNotify}
                  onClick={() => void handleTestNotification()}
                  className="btn-ghost px-3.5 py-1.5 text-xs"
                >
                  <Send className="w-3.5 h-3.5" />
                  {testingNotify ? '发送中...' : '发送测试消息'}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Telegram Bot Token</label>
                  <input
                    type="password"
                    value={settings.telegramBotToken}
                    onChange={(e) => setSettings({ ...settings, telegramBotToken: e.target.value })}
                    placeholder="123456:ABC-DEF..."
                    className="cinema-input w-full px-3.5 py-2.5 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Telegram Chat ID</label>
                  <input
                    type="text"
                    value={settings.telegramChatId}
                    onChange={(e) => setSettings({ ...settings, telegramChatId: e.target.value })}
                    placeholder="例如 987654321"
                    className="cinema-input w-full px-3.5 py-2.5 text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">
                  自定义 Webhook URL（兼容 Bark / 飞书 / 企业微信）
                </label>
                <input
                  type="text"
                  value={settings.webhookUrl}
                  onChange={(e) => setSettings({ ...settings, webhookUrl: e.target.value })}
                  placeholder="https://example.com/webhook"
                  className="cinema-input w-full px-3.5 py-2.5 text-xs font-mono"
                />
              </div>
            </div>
          </div>
        )}

        {message && (
          <div className="rounded-2xl border border-white/15 bg-white/[0.05] px-4 py-3 text-xs text-zinc-100 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            {message}
          </div>
        )}

        <div className="flex justify-end">
          <button type="submit" disabled={saving} className="btn-ivory px-6 py-2.5 text-sm">
            <Save className="w-4 h-4" />
            {saving ? '保存中...' : '保存设置'}
          </button>
        </div>
      </form>
    </div>
  );
};
