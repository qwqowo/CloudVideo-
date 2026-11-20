import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search,
  Rss,
  Server,
  Download,
  Zap,
  Check,
  AlertTriangle,
  ExternalLink,
  Plus,
  Trash2,
  RefreshCw,
  Play,
  Eye,
  History,
  X,
  Edit3,
  Power,
  ArrowRight,
  KeyRound,
} from 'lucide-react';
import { apiFetch, formatBytes } from '../lib/api';
import type {
  HubConfigResponse,
  HubSearchResponse,
  HubSearchResult,
  ProwlarrTestResult,
  RssPreviewItem,
  RssSeenItemRecord,
  RssSubscriptionRecord,
} from '../types';

type SubTab = 'search' | 'rss' | 'indexers';
type CategoryFilter = 'all' | 'movies' | 'tv' | 'anime';
type SortMode = 'seeders' | 'date' | 'size_asc' | 'size_desc';

interface HubPageProps {
  onDownloaded?: (warning?: string) => void;
  onGoLibrary?: () => void;
}

interface RssFormState {
  id?: number;
  name: string;
  feedUrl: string;
  includeRegex: string;
  excludeRegex: string;
  minSizeMb: number;
  maxSizeMb: number;
  intervalMin: number;
  sequential: boolean;
  bingeMode: boolean;
  enabled: boolean;
}

const DEFAULT_RSS_FORM: RssFormState = {
  name: '',
  feedUrl: '',
  includeRegex: '',
  excludeRegex: '',
  minSizeMb: 0,
  maxSizeMb: 8000,
  intervalMin: 30,
  sequential: true,
  bingeMode: false,
  enabled: true,
};

function formatTimeAgo(ts: number | null): string {
  if (!ts) return '—';
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}m 前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h 前`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d 前`;
  return new Date(ts).toLocaleDateString();
}

export const HubPage: React.FC<HubPageProps> = ({ onDownloaded, onGoLibrary }) => {
  const [subTab, setSubTab] = useState<SubTab>('search');
  const [config, setConfig] = useState<HubConfigResponse | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Search state
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [sort, setSort] = useState<SortMode>('seeders');
  const [qualityFilter, setQualityFilter] = useState<'ALL' | '4K' | '1080P'>('ALL');
  const [searching, setSearching] = useState(false);
  const [searchData, setSearchData] = useState<HubSearchResponse | null>(null);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [pushedIds, setPushedIds] = useState<Record<string, boolean>>({});

  // Indexers config state
  const [prowlarrUrl, setProwlarrUrl] = useState('http://prowlarr:9696');
  const [prowlarrApiKey, setProwlarrApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [savingProwlarr, setSavingProwlarr] = useState(false);
  const [testingProwlarr, setTestingProwlarr] = useState(false);
  const [prowlarrTest, setProwlarrTest] = useState<ProwlarrTestResult | null>(null);

  const [newIdxName, setNewIdxName] = useState('');
  const [newIdxUrl, setNewIdxUrl] = useState('');
  const [newIdxKey, setNewIdxKey] = useState('');
  const [addingIdx, setAddingIdx] = useState(false);

  // RSS state
  const [subs, setSubs] = useState<RssSubscriptionRecord[]>([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [runningSubId, setRunningSubId] = useState<number | null>(null);

  // RSS Editor Modal + Live Preview
  const [editorOpen, setEditorOpen] = useState(false);
  const [rssForm, setRssForm] = useState<RssFormState>(DEFAULT_RSS_FORM);
  const [savingSub, setSavingSub] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{
    title?: string;
    total: number;
    matchedCount: number;
    items: RssPreviewItem[];
  } | null>(null);
  const [standalonePreviewOpen, setStandalonePreviewOpen] = useState(false);

  // RSS History Modal
  const [historyModal, setHistoryModal] = useState<{
    subName: string;
    items: RssSeenItemRecord[];
  } | null>(null);

  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    setTimeout(() => {
      setToast((cur) => (cur?.text === text ? null : cur));
    }, 5000);
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await apiFetch<HubConfigResponse>('/api/hub/config');
      setConfig(res);
      setProwlarrUrl(res.prowlarrUrl || 'http://prowlarr:9696');
      setProwlarrApiKey(res.prowlarrApiKey || '');
    } catch {
      // ignore
    }
  }, []);

  const loadSubs = useCallback(async () => {
    setLoadingSubs(true);
    try {
      const res = await apiFetch<{ subscriptions: RssSubscriptionRecord[] }>('/api/rss/subscriptions');
      setSubs(res.subscriptions);
    } catch {
      // ignore
    } finally {
      setLoadingSubs(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    void loadSubs();
  }, [loadConfig, loadSubs]);

  const hasAnyIndexer = useMemo(() => {
    if (!config) return false;
    return config.prowlarrConfigured || config.torznabIndexers.some((i) => i.enabled);
  }, [config]);

  const filteredResults = useMemo(() => {
    if (!searchData) return [];
    if (qualityFilter === 'ALL') return searchData.results;
    return searchData.results.filter((r) => r.resolution === qualityFilter);
  }, [searchData, qualityFilter]);

  const prowlarrExternalUrl = useMemo(() => {
    if (typeof window === 'undefined') return 'http://127.0.0.1:9696';
    return `${window.location.protocol}//${window.location.hostname}:9696`;
  }, []);

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const params = new URLSearchParams({
        q: query.trim(),
        category,
        sort,
      });
      const res = await apiFetch<HubSearchResponse>(`/api/hub/search?${params.toString()}`);
      setSearchData(res);
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '搜索失败');
    } finally {
      setSearching(false);
    }
  };

  const handlePushItem = async (
    item: { id: string; title: string; magnetUrl: string; downloadUrl: string },
    bingeMode: boolean
  ) => {
    setPushingId(item.id);
    try {
      const res = await apiFetch<{ ok: boolean; warning?: string }>('/api/hub/download', {
        method: 'POST',
        body: JSON.stringify({
          magnetUrl: item.magnetUrl,
          downloadUrl: item.downloadUrl,
          title: item.title,
          sequential: true,
          bingeMode,
        }),
      });
      setPushedIds((prev) => ({ ...prev, [item.id]: true }));
      notify(
        'ok',
        bingeMode
          ? `已以「追剧托管」模式推送：${item.title.slice(0, 48)}`
          : `已推送「边下边播」：${item.title.slice(0, 48)}`
      );
      onDownloaded?.(res.warning);
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '推送下载失败');
    } finally {
      setPushingId(null);
    }
  };

  const handleSaveProwlarr = async () => {
    setSavingProwlarr(true);
    try {
      await apiFetch('/api/hub/prowlarr', {
        method: 'PUT',
        body: JSON.stringify({ prowlarrUrl: prowlarrUrl.trim(), prowlarrApiKey: prowlarrApiKey.trim() }),
      });
      await loadConfig();
      notify('ok', 'Prowlarr 配置已保存');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingProwlarr(false);
    }
  };

  const handleTestProwlarr = async () => {
    setTestingProwlarr(true);
    setProwlarrTest(null);
    try {
      const res = await apiFetch<ProwlarrTestResult>('/api/hub/prowlarr/test', {
        method: 'POST',
        body: JSON.stringify({ prowlarrUrl: prowlarrUrl.trim(), prowlarrApiKey: prowlarrApiKey.trim() }),
      });
      setProwlarrTest(res);
      if (res.ok) {
        notify('ok', `连接成功，发现 ${res.indexerCount} 个启用索引站`);
      } else {
        notify('err', res.error || '连接测试失败');
      }
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '测试请求异常');
    } finally {
      setTestingProwlarr(false);
    }
  };

  const handleAddTorznab = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIdxName.trim() || !newIdxUrl.trim()) return;
    setAddingIdx(true);
    try {
      await apiFetch('/api/hub/indexers', {
        method: 'POST',
        body: JSON.stringify({
          name: newIdxName.trim(),
          url: newIdxUrl.trim(),
          apiKey: newIdxKey.trim(),
          enabled: true,
        }),
      });
      setNewIdxName('');
      setNewIdxUrl('');
      setNewIdxKey('');
      await loadConfig();
      notify('ok', '已添加自定义 Torznab 索引源');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '添加索引源失败');
    } finally {
      setAddingIdx(false);
    }
  };

  const handleToggleTorznab = async (id: number, enabled: boolean) => {
    try {
      await apiFetch(`/api/hub/indexers/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      await loadConfig();
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '更新失败');
    }
  };

  const handleDeleteTorznab = async (id: number) => {
    try {
      await apiFetch(`/api/hub/indexers/${id}`, { method: 'DELETE' });
      await loadConfig();
      notify('ok', '已删除 Torznab 索引源');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '删除失败');
    }
  };

  const openCreateRss = () => {
    setRssForm(DEFAULT_RSS_FORM);
    setPreviewData(null);
    setEditorOpen(true);
  };

  const openEditRss = (sub: RssSubscriptionRecord) => {
    setRssForm({
      id: sub.id,
      name: sub.name,
      feedUrl: sub.feedUrl,
      includeRegex: sub.includeRegex,
      excludeRegex: sub.excludeRegex,
      minSizeMb: sub.minSizeMb,
      maxSizeMb: sub.maxSizeMb,
      intervalMin: sub.intervalMin,
      sequential: sub.sequential,
      bingeMode: sub.bingeMode,
      enabled: sub.enabled,
    });
    setPreviewData(null);
    setEditorOpen(true);
  };

  const handlePreviewRss = async (
    spec: {
      feedUrl: string;
      includeRegex: string;
      excludeRegex: string;
      minSizeMb: number;
      maxSizeMb: number;
      subscriptionId?: number;
      title?: string;
    },
    standalone: boolean
  ) => {
    if (!spec.feedUrl.trim()) {
      notify('err', '请先填写 RSS 订阅地址');
      return;
    }
    setPreviewLoading(true);
    if (standalone) setStandalonePreviewOpen(true);
    try {
      const res = await apiFetch<{ total: number; matchedCount: number; items: RssPreviewItem[] }>(
        '/api/rss/preview',
        {
          method: 'POST',
          body: JSON.stringify({
            feedUrl: spec.feedUrl.trim(),
            includeRegex: spec.includeRegex,
            excludeRegex: spec.excludeRegex,
            minSizeMb: Number(spec.minSizeMb) || 0,
            maxSizeMb: Number(spec.maxSizeMb) || 0,
            subscriptionId: spec.subscriptionId,
          }),
        }
      );
      setPreviewData({ ...res, title: spec.title });
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '预览 RSS 失败');
      if (standalone) setStandalonePreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSaveRss = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rssForm.name.trim() || !rssForm.feedUrl.trim()) return;
    setSavingSub(true);
    try {
      const payload = {
        name: rssForm.name.trim(),
        feedUrl: rssForm.feedUrl.trim(),
        includeRegex: rssForm.includeRegex.trim(),
        excludeRegex: rssForm.excludeRegex.trim(),
        minSizeMb: Math.max(0, Number(rssForm.minSizeMb) || 0),
        maxSizeMb: Math.max(0, Number(rssForm.maxSizeMb) || 0),
        intervalMin: Math.min(1440, Math.max(5, Number(rssForm.intervalMin) || 30)),
        sequential: rssForm.sequential,
        bingeMode: rssForm.bingeMode,
        enabled: rssForm.enabled,
      };
      if (rssForm.id) {
        await apiFetch(`/api/rss/subscriptions/${rssForm.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        notify('ok', '已更新 RSS 订阅规则');
      } else {
        await apiFetch('/api/rss/subscriptions', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        notify('ok', '已创建 RSS 自动订阅规则');
      }
      setEditorOpen(false);
      await loadSubs();
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '保存订阅失败');
    } finally {
      setSavingSub(false);
    }
  };

  const handleToggleSub = async (sub: RssSubscriptionRecord) => {
    try {
      await apiFetch(`/api/rss/subscriptions/${sub.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !sub.enabled }),
      });
      await loadSubs();
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '切换失败');
    }
  };

  const handleRunSub = async (sub: RssSubscriptionRecord) => {
    setRunningSubId(sub.id);
    try {
      const res = await apiFetch<{
        ok: boolean;
        summary: {
          fetchedCount: number;
          matchedCount: number;
          pushedCount: number;
          errors: string[];
        };
      }>(`/api/rss/subscriptions/${sub.id}/run`, { method: 'POST' });
      await loadSubs();
      if (res.summary.errors.length > 0) {
        notify('err', `拉取完成但存在异常：${res.summary.errors[0]}`);
      } else {
        notify(
          'ok',
          `「${sub.name}」抓取 ${res.summary.fetchedCount} 条，新推送 ${res.summary.pushedCount} 个种子`
        );
      }
      if (res.summary.pushedCount > 0) {
        onDownloaded?.();
      }
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '立即抓取失败');
    } finally {
      setRunningSubId(null);
    }
  };

  const handleDeleteSub = async (sub: RssSubscriptionRecord) => {
    if (!window.confirm(`确定删除 RSS 订阅「${sub.name}」及其去重记录吗？`)) return;
    try {
      await apiFetch(`/api/rss/subscriptions/${sub.id}`, { method: 'DELETE' });
      await loadSubs();
      notify('ok', '已删除订阅规则');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '删除失败');
    }
  };

  const handleOpenHistory = async (sub: RssSubscriptionRecord) => {
    try {
      const res = await apiFetch<{ items: RssSeenItemRecord[] }>(
        `/api/rss/subscriptions/${sub.id}/history`
      );
      setHistoryModal({ subName: sub.name, items: res.items });
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '获取历史记录失败');
    }
  };

  return (
    <div className="space-y-5">
      {/* Top Banner + Sub-Tabs */}
      <div className="hud-panel p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-mono tracking-[0.22em] text-cyan-400">
            <span>TORRENT HUB // AGGREGATION &amp; RSS AUTOMATION</span>
          </div>
          <h1 className="text-lg sm:text-xl font-semibold text-white mt-1">
            在线种子探索与自动追更订阅
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            对接 Prowlarr / Jackett / Torznab 全网搜种一键边下边播，或挂载 RSS 规则自动追番追剧。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 bg-[#06090d] p-1 border border-white/[0.08]">
          {[
            { id: 'search' as const, label: '聚合搜种', code: 'SEARCH', icon: Search },
            {
              id: 'rss' as const,
              label: `RSS 订阅 (${subs.filter((s) => s.enabled).length})`,
              code: 'FEED',
              icon: Rss,
            },
            { id: 'indexers' as const, label: '索引源接入', code: 'INDEXERS', icon: Server },
          ].map((t) => {
            const Icon = t.icon;
            const active = subTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setSubTab(t.id)}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs transition ${
                  active
                    ? 'bg-cyan-400/15 text-cyan-300 border border-cyan-400/40'
                    : 'text-zinc-400 hover:text-zinc-100 border border-transparent'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{t.label}</span>
                <span className="hidden sm:inline text-[9px] font-mono text-zinc-500">{t.code}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Inline Toast */}
      {toast && (
        <div
          className={`px-4 py-2.5 border text-xs font-mono flex items-center justify-between ${
            toast.kind === 'ok'
              ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
              : 'border-rose-500/40 bg-rose-950/30 text-rose-200'
          }`}
        >
          <span>
            {toast.kind === 'ok' ? 'OK // ' : 'ERR // '}
            {toast.text}
          </span>
          <div className="flex items-center gap-3">
            {toast.kind === 'ok' && onGoLibrary && (
              <button
                onClick={onGoLibrary}
                className="text-cyan-300 hover:underline flex items-center gap-1"
              >
                前往媒体库 <ArrowRight className="w-3 h-3" />
              </button>
            )}
            <button onClick={() => setToast(null)} className="opacity-70 hover:opacity-100">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* ==================== TAB 1: SEARCH ==================== */}
      {subTab === 'search' && (
        <div className="space-y-4">
          {config && !hasAnyIndexer && (
            <div className="hud-panel p-5 border-amber-500/30 bg-amber-950/10">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-amber-300 text-xs font-mono">
                    <AlertTriangle className="w-4 h-4" />
                    <span>INDEXER NOT LINKED // 30 秒完成种子 Hub 接入</span>
                  </div>
                  <p className="text-xs text-zinc-300 leading-relaxed">
                    1. 打开同机已部署的 Prowlarr 面板添加公开/动漫/PT 索引站 → 2. 复制{' '}
                    <code className="text-cyan-300">Settings → General → API Key</code> → 3. 填入「索引源接入」即可聚合全网搜种。
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={prowlarrExternalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-2 border border-white/15 bg-[#0a0f16] hover:border-cyan-400/50 text-xs text-zinc-200 flex items-center gap-1.5 transition"
                  >
                    打开 Prowlarr (:9696) <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <button
                    onClick={() => setSubTab('indexers')}
                    className="px-3 py-2 bg-cyan-400 hover:bg-cyan-300 text-zinc-950 text-xs font-mono font-bold transition"
                  >
                    配置 API Key
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Search Controls */}
          <form onSubmit={handleSearch} className="hud-panel p-4 space-y-3">
            <div className="flex flex-col sm:flex-row gap-2.5">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="输入电影、剧集或番剧关键词（如 Dune 2024 / 葬送的芙莉莲 / Severance S02）..."
                  className="w-full pl-9 pr-3 py-2.5 bg-[#06090d] border border-white/10 focus:border-cyan-400/60 outline-none text-sm text-white placeholder:text-zinc-600"
                />
              </div>
              <button
                type="submit"
                disabled={searching || !query.trim()}
                className="px-5 py-2.5 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40 text-zinc-950 text-xs font-mono font-bold tracking-wider flex items-center justify-center gap-2 transition"
              >
                <Search className={`w-3.5 h-3.5 ${searching ? 'animate-pulse' : ''}`} />
                {searching ? 'SCANNING...' : '聚合搜种'}
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-white/[0.06]">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-mono text-zinc-500 mr-1">CAT //</span>
                {(
                  [
                    ['all', '全部'],
                    ['movies', '电影'],
                    ['tv', '剧集'],
                    ['anime', '动漫'],
                  ] as const
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setCategory(val)}
                    className={`px-2.5 py-1 text-xs border transition ${
                      category === val
                        ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-300'
                        : 'border-white/[0.07] text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}

                <span className="text-[10px] font-mono text-zinc-500 ml-3 mr-1">RES //</span>
                {(['ALL', '4K', '1080P'] as const).map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setQualityFilter(q)}
                    className={`px-2 py-1 text-[11px] font-mono border transition ${
                      qualityFilter === q
                        ? 'border-amber-400/50 bg-amber-400/10 text-amber-300'
                        : 'border-white/[0.07] text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {q}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span className="text-[10px] font-mono text-zinc-500">SORT //</span>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortMode)}
                  className="bg-[#06090d] border border-white/10 px-2.5 py-1 text-xs text-zinc-200 outline-none focus:border-cyan-400/50"
                >
                  <option value="seeders">做种数优先</option>
                  <option value="date">最新发布</option>
                  <option value="size_asc">体积从小到大</option>
                  <option value="size_desc">体积从大到小</option>
                </select>
              </div>
            </div>
          </form>

          {/* Search Errors / Warnings */}
          {searchData && searchData.errors.length > 0 && (
            <div className="border border-amber-500/30 bg-amber-950/20 px-4 py-2.5 text-xs text-amber-200 space-y-1">
              {searchData.errors.map((err, i) => (
                <div key={i} className="font-mono">
                  WARN // {err}
                </div>
              ))}
            </div>
          )}

          {/* Results Telemetry List */}
          {searchData && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 px-1">
                <span>
                  RESULTS: <strong className="text-cyan-300">{filteredResults.length}</strong> /{' '}
                  {searchData.results.length}（已查 {searchData.sourcesQueried} 个源）
                </span>
                <span>
                  DISK CAP:{' '}
                  <strong className="text-zinc-200">
                    {formatBytes(searchData.storageLimitBytes)}
                  </strong>
                </span>
              </div>

              {filteredResults.length === 0 ? (
                <div className="hud-panel p-10 text-center text-xs font-mono text-zinc-500">
                  NO MATCHING TORRENTS FOUND // 请尝试更换英文原名或切换分类
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredResults.map((item: HubSearchResult) => {
                    const isPushing = pushingId === item.id;
                    const isPushed = Boolean(pushedIds[item.id]);
                    const hasDownload = Boolean(item.magnetUrl || item.downloadUrl);
                    return (
                      <div
                        key={item.id}
                        className="hud-card p-3.5 sm:p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3"
                      >
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex items-start gap-2">
                            <div className="text-sm text-zinc-100 font-medium break-all leading-snug">
                              {item.title}
                            </div>
                            {item.infoUrl && (
                              <a
                                href={item.infoUrl}
                                target="_blank"
                                rel="noreferrer"
                                title="打开原站详情页"
                                className="text-zinc-500 hover:text-cyan-300 shrink-0 mt-0.5"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                            <span className="px-1.5 py-0.5 border border-white/10 bg-white/[0.03] text-zinc-300">
                              {item.indexer}
                            </span>
                            {item.resolution && (
                              <span
                                className={`px-1.5 py-0.5 border ${
                                  item.resolution === '4K'
                                    ? 'border-amber-400/50 bg-amber-400/10 text-amber-300'
                                    : 'border-cyan-400/40 bg-cyan-400/10 text-cyan-300'
                                }`}
                              >
                                {item.resolution}
                              </span>
                            )}
                            {item.tags.map((tag) => (
                              <span
                                key={tag}
                                className="px-1.5 py-0.5 border border-white/[0.08] text-zinc-400"
                              >
                                {tag}
                              </span>
                            ))}
                            <span className="text-zinc-500 ml-1">
                              {formatTimeAgo(item.publishTimestamp || null)}
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-wrap sm:flex-nowrap items-center justify-between lg:justify-end gap-3 shrink-0">
                          {/* Size & Seeders Telemetry */}
                          <div className="flex items-center gap-3 text-xs font-mono">
                            <div className="text-right">
                              <div
                                className={
                                  item.exceedsLimit ? 'text-rose-400 font-semibold' : 'text-zinc-200'
                                }
                              >
                                {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '未知体积'}
                              </div>
                              {item.exceedsLimit && (
                                <div className="text-[10px] text-rose-400">
                                  超盘限 · 建议追剧托管
                                </div>
                              )}
                            </div>

                            <div className="px-2 py-1 bg-[#06090d] border border-white/[0.07] text-center min-w-[68px]">
                              <span className="text-emerald-400">▲ {item.seeders}</span>
                              <span className="text-zinc-600 mx-1">/</span>
                              <span className="text-zinc-400">▼ {item.leechers}</span>
                            </div>
                          </div>

                          {/* Push Buttons */}
                          <div className="flex items-center gap-1.5">
                            {isPushed ? (
                              <button
                                onClick={onGoLibrary}
                                className="px-3 py-1.5 border border-emerald-400/40 bg-emerald-500/15 text-emerald-300 text-xs font-mono flex items-center gap-1.5"
                              >
                                <Check className="w-3.5 h-3.5" />
                                已推送 · 查看
                              </button>
                            ) : (
                              <>
                                <button
                                  disabled={!hasDownload || isPushing}
                                  onClick={() => void handlePushItem(item, false)}
                                  className="px-3 py-1.5 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40 text-zinc-950 text-xs font-mono font-bold flex items-center gap-1.5 transition"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  {isPushing ? '推送中...' : '边下边播'}
                                </button>
                                <button
                                  disabled={!hasDownload || isPushing}
                                  onClick={() => void handlePushItem(item, true)}
                                  title="适合整季大合集：仅自动下载前 N 集，看到 70% 自动预载下一集"
                                  className="px-2.5 py-1.5 border border-amber-400/40 bg-amber-400/10 hover:bg-amber-400/20 disabled:opacity-40 text-amber-300 text-xs font-mono flex items-center gap-1 transition"
                                >
                                  <Zap className="w-3.5 h-3.5" />
                                  追剧托管
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ==================== TAB 2: RSS AUTO-SUBSCRIPTIONS ==================== */}
      {subTab === 'rss' && (
        <div className="space-y-4">
          <div className="hud-panel p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-zinc-400">
              支持蜜柑计划 (Mikanani)、Nyaa RSS、Prowlarr/Jackett 搜索 RSS 及任意 PT 站 RSS/Atom 订阅源，自动去重、正则筛选、大小上限保护与推送通知。
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => void loadSubs()}
                className="px-2.5 py-1.5 border border-white/10 hover:border-cyan-400/40 text-xs text-zinc-300 flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingSubs ? 'animate-spin' : ''}`} />
                刷新
              </button>
              <button
                onClick={openCreateRss}
                className="px-3.5 py-1.5 bg-cyan-400 hover:bg-cyan-300 text-zinc-950 text-xs font-mono font-bold flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                新建 RSS 订阅
              </button>
            </div>
          </div>

          {subs.length === 0 ? (
            <div className="hud-panel p-10 text-center space-y-3">
              <Rss className="w-8 h-8 text-cyan-400/60 mx-auto" />
              <div className="text-sm text-zinc-200">暂无 RSS 自动订阅规则</div>
              <p className="text-xs text-zinc-500 max-w-md mx-auto">
                贴入任意番剧或剧集的 RSS 链接，配置包含/排除关键词（如 <code className="text-cyan-300">1080p|简繁</code>）和单集体积上限，系统将按计划后台自动拉取下载。
              </p>
              <button
                onClick={openCreateRss}
                className="px-4 py-2 bg-cyan-400 hover:bg-cyan-300 text-zinc-950 text-xs font-mono font-bold"
              >
                + 添加第一条订阅
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {subs.map((sub) => (
                <div key={sub.id} className="hud-card p-4 flex flex-col justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2 h-2 shrink-0 ${
                              sub.enabled ? 'bg-emerald-400' : 'bg-zinc-600'
                            }`}
                          />
                          <h3 className="text-sm font-semibold text-white truncate">{sub.name}</h3>
                        </div>
                        <div className="text-[11px] font-mono text-zinc-500 truncate mt-0.5">
                          {sub.feedUrl}
                        </div>
                      </div>
                      <button
                        onClick={() => void handleToggleSub(sub)}
                        title={sub.enabled ? '点击暂停自动轮询' : '点击启用自动轮询'}
                        className={`px-2 py-1 text-[10px] font-mono border flex items-center gap-1 shrink-0 ${
                          sub.enabled
                            ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                            : 'border-white/10 text-zinc-500'
                        }`}
                      >
                        <Power className="w-3 h-3" />
                        {sub.enabled ? 'ACTIVE' : 'PAUSED'}
                      </button>
                    </div>

                    {/* Rule chips */}
                    <div className="flex flex-wrap gap-1.5 text-[11px] font-mono">
                      <span className="px-1.5 py-0.5 border border-white/10 text-zinc-300">
                        每 {sub.intervalMin}m
                      </span>
                      {sub.sequential && (
                        <span className="px-1.5 py-0.5 border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
                          边下边播
                        </span>
                      )}
                      {sub.bingeMode && (
                        <span className="px-1.5 py-0.5 border border-amber-400/30 bg-amber-400/10 text-amber-300">
                          追剧托管
                        </span>
                      )}
                      {sub.includeRegex && (
                        <span className="px-1.5 py-0.5 border border-emerald-500/30 text-emerald-300">
                          + /{sub.includeRegex}/
                        </span>
                      )}
                      {sub.excludeRegex && (
                        <span className="px-1.5 py-0.5 border border-rose-500/30 text-rose-300">
                          - /{sub.excludeRegex}/
                        </span>
                      )}
                      {(sub.minSizeMb > 0 || sub.maxSizeMb > 0) && (
                        <span className="px-1.5 py-0.5 border border-white/10 text-zinc-400">
                          体积 {sub.minSizeMb || 0}~{sub.maxSizeMb || '∞'} MB
                        </span>
                      )}
                    </div>

                    {sub.lastError && (
                      <div className="text-[11px] font-mono text-rose-300 bg-rose-950/30 border border-rose-500/30 px-2.5 py-1.5">
                        ERR // {sub.lastError}
                      </div>
                    )}
                  </div>

                  {/* Footer telemetry + buttons */}
                  <div className="pt-2.5 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
                    <div className="text-zinc-500 flex items-center gap-3">
                      <span>上次检测: {formatTimeAgo(sub.lastCheckedAt)}</span>
                      <span>
                        已推送: <strong className="text-cyan-300">{sub.matchedCount}</strong>
                      </span>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        disabled={runningSubId === sub.id}
                        onClick={() => void handleRunSub(sub)}
                        className="px-2 py-1 border border-cyan-400/40 bg-cyan-400/10 hover:bg-cyan-400/20 text-cyan-300 flex items-center gap-1 disabled:opacity-50"
                      >
                        <Play className="w-3 h-3" />
                        {runningSubId === sub.id ? '抓取中' : '立即抓取'}
                      </button>
                      <button
                        onClick={() =>
                          void handlePreviewRss(
                            {
                              feedUrl: sub.feedUrl,
                              includeRegex: sub.includeRegex,
                              excludeRegex: sub.excludeRegex,
                              minSizeMb: sub.minSizeMb,
                              maxSizeMb: sub.maxSizeMb,
                              subscriptionId: sub.id,
                              title: sub.name,
                            },
                            true
                          )
                        }
                        title="试跑预览匹配效果"
                        className="p-1.5 border border-white/10 hover:border-cyan-400/40 text-zinc-300"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => void handleOpenHistory(sub)}
                        title="查看推送与过滤历史"
                        className="p-1.5 border border-white/10 hover:border-cyan-400/40 text-zinc-300"
                      >
                        <History className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => openEditRss(sub)}
                        title="编辑规则"
                        className="p-1.5 border border-white/10 hover:border-cyan-400/40 text-zinc-300"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => void handleDeleteSub(sub)}
                        title="删除规则"
                        className="p-1.5 border border-white/10 hover:border-rose-400/50 text-zinc-400 hover:text-rose-300"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ==================== TAB 3: INDEXERS CONFIG ==================== */}
      {subTab === 'indexers' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Prowlarr Master Hub */}
          <div className="hud-panel p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-mono tracking-[0.2em] text-cyan-400">
                  PRIMARY ENGINE // PROWLARR
                </div>
                <h2 className="text-base font-semibold text-white mt-0.5">
                  Prowlarr 种子聚合中心
                </h2>
                <p className="text-xs text-zinc-400 mt-1">
                  已随 Docker Compose 同机部署。只需在 Prowlarr 添加公开/动漫/PT 站并把 API Key 粘贴到此处，即可全网一键搜种。
                </p>
              </div>
              <a
                href={prowlarrExternalUrl}
                target="_blank"
                rel="noreferrer"
                className="px-2.5 py-1.5 border border-cyan-400/40 bg-cyan-400/10 hover:bg-cyan-400/20 text-xs font-mono text-cyan-300 flex items-center gap-1 shrink-0"
              >
                打开 :9696 <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                  PROWLARR URL（Docker 同网段默认 http://prowlarr:9696）
                </label>
                <input
                  type="text"
                  value={prowlarrUrl}
                  onChange={(e) => setProwlarrUrl(e.target.value)}
                  placeholder="http://prowlarr:9696"
                  className="w-full px-3 py-2 bg-[#06090d] border border-white/10 focus:border-cyan-400/60 outline-none text-xs font-mono text-white"
                />
              </div>

              <div>
                <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                  API KEY（Prowlarr → Settings → General → Security）
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <KeyRound className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={prowlarrApiKey}
                      onChange={(e) => setProwlarrApiKey(e.target.value)}
                      placeholder="粘贴 32 位 API Key"
                      className="w-full pl-8 pr-3 py-2 bg-[#06090d] border border-white/10 focus:border-cyan-400/60 outline-none text-xs font-mono text-white"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="px-3 py-2 border border-white/10 text-xs font-mono text-zinc-400 hover:text-zinc-200"
                  >
                    {showKey ? '隐藏' : '显示'}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={savingProwlarr}
                  onClick={() => void handleSaveProwlarr()}
                  className="px-4 py-2 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 text-zinc-950 text-xs font-mono font-bold"
                >
                  {savingProwlarr ? '保存中...' : '保存配置'}
                </button>
                <button
                  type="button"
                  disabled={testingProwlarr}
                  onClick={() => void handleTestProwlarr()}
                  className="px-4 py-2 border border-white/15 hover:border-cyan-400/50 text-xs font-mono text-zinc-200 disabled:opacity-50"
                >
                  {testingProwlarr ? '检测中...' : '测试连接'}
                </button>
              </div>

              {prowlarrTest && (
                <div
                  className={`p-3 border text-xs font-mono space-y-2 ${
                    prowlarrTest.ok
                      ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-200'
                      : 'border-rose-500/40 bg-rose-950/20 text-rose-200'
                  }`}
                >
                  <div>
                    {prowlarrTest.ok
                      ? `CONNECTED // 已发现 ${prowlarrTest.indexerCount} 个启用索引站`
                      : `FAILED // ${prowlarrTest.error}`}
                  </div>
                  {prowlarrTest.ok && prowlarrTest.enabledIndexers.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {prowlarrTest.enabledIndexers.map((idx) => (
                        <span
                          key={idx.id}
                          className="px-1.5 py-0.5 bg-emerald-400/10 border border-emerald-400/30 text-[10px]"
                        >
                          {idx.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Custom Torznab / Jackett Indexers */}
          <div className="hud-panel p-5 space-y-4">
            <div>
              <div className="text-[10px] font-mono tracking-[0.2em] text-amber-400">
                CUSTOM SOURCES // TORZNAB / JACKETT
              </div>
              <h2 className="text-base font-semibold text-white mt-0.5">
                自定义 Torznab 索引源
              </h2>
              <p className="text-xs text-zinc-400 mt-1">
                若你已有 Jackett 或独立 Torznab API 接口，也可直接挂载到此处参与聚合搜种。
              </p>
            </div>

            <form onSubmit={handleAddTorznab} className="space-y-2.5 bg-[#06090d] p-3.5 border border-white/[0.07]">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <input
                  type="text"
                  value={newIdxName}
                  onChange={(e) => setNewIdxName(e.target.value)}
                  placeholder="索引源名称（如 Jackett All）"
                  className="px-3 py-2 bg-[#0a0f16] border border-white/10 focus:border-cyan-400/60 outline-none text-xs text-white"
                />
                <input
                  type="text"
                  value={newIdxKey}
                  onChange={(e) => setNewIdxKey(e.target.value)}
                  placeholder="API Key（可选）"
                  className="px-3 py-2 bg-[#0a0f16] border border-white/10 focus:border-cyan-400/60 outline-none text-xs font-mono text-white"
                />
              </div>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={newIdxUrl}
                  onChange={(e) => setNewIdxUrl(e.target.value)}
                  placeholder="https://jackett.example.com/api/v2.0/indexers/all/results/torznab/"
                  className="flex-1 px-3 py-2 bg-[#0a0f16] border border-white/10 focus:border-cyan-400/60 outline-none text-xs font-mono text-white"
                />
                <button
                  type="submit"
                  disabled={addingIdx || !newIdxName.trim() || !newIdxUrl.trim()}
                  className="px-3.5 py-2 bg-amber-400 hover:bg-amber-300 disabled:opacity-40 text-zinc-950 text-xs font-mono font-bold shrink-0"
                >
                  + 添加
                </button>
              </div>
            </form>

            <div className="space-y-2">
              {(!config || config.torznabIndexers.length === 0) && (
                <div className="text-xs font-mono text-zinc-500 py-4 text-center border border-dashed border-white/10">
                  暂无自定义 Torznab 源
                </div>
              )}
              {config?.torznabIndexers.map((idx) => (
                <div
                  key={idx.id}
                  className="p-3 bg-[#06090d] border border-white/[0.08] flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-white">{idx.name}</div>
                    <div className="text-[11px] font-mono text-zinc-500 truncate">{idx.url}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => void handleToggleTorznab(idx.id, !idx.enabled)}
                      className={`px-2 py-1 text-[10px] font-mono border ${
                        idx.enabled
                          ? 'border-emerald-400/40 text-emerald-300 bg-emerald-400/10'
                          : 'border-white/10 text-zinc-500'
                      }`}
                    >
                      {idx.enabled ? 'ON' : 'OFF'}
                    </button>
                    <button
                      onClick={() => void handleDeleteTorznab(idx.id)}
                      className="p-1.5 border border-white/10 hover:border-rose-400/50 text-zinc-400 hover:text-rose-300"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ==================== MODAL: RSS CREATE / EDIT + LIVE DRY-RUN ==================== */}
      {editorOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="hud-panel w-full max-w-2xl max-h-[90vh] overflow-y-auto p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
              <div>
                <div className="text-[10px] font-mono tracking-[0.2em] text-cyan-400">
                  RSS RULE EDITOR
                </div>
                <h3 className="text-base font-semibold text-white">
                  {rssForm.id ? '编辑 RSS 自动订阅' : '新建 RSS 自动订阅'}
                </h3>
              </div>
              <button
                onClick={() => setEditorOpen(false)}
                className="p-1 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveRss} className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">订阅名称</label>
                  <input
                    required
                    type="text"
                    value={rssForm.name}
                    onChange={(e) => setRssForm({ ...rssForm, name: e.target.value })}
                    placeholder="例如：蜜柑计划 - 2026 新番"
                    className="w-full px-3 py-2 bg-[#06090d] border border-white/10 focus:border-cyan-400/60 outline-none text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    轮询间隔（分钟，5–1440）
                  </label>
                  <input
                    type="number"
                    min={5}
                    max={1440}
                    value={rssForm.intervalMin}
                    onChange={(e) =>
                      setRssForm({ ...rssForm, intervalMin: Number(e.target.value) || 30 })
                    }
                    className="w-full px-3 py-2 bg-[#06090d] border border-white/10 focus:border-cyan-400/60 outline-none text-xs font-mono text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                  RSS / Atom 订阅链接
                </label>
                <input
                  required
                  type="url"
                  value={rssForm.feedUrl}
                  onChange={(e) => setRssForm({ ...rssForm, feedUrl: e.target.value })}
                  placeholder="https://mikanani.me/RSS/Bangumi?bangumiId=..."
                  className="w-full px-3 py-2 bg-[#06090d] border border-white/10 focus:border-cyan-400/60 outline-none text-xs font-mono text-white"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    包含关键词正则（留空匹配全部）
                  </label>
                  <input
                    type="text"
                    value={rssForm.includeRegex}
                    onChange={(e) => setRssForm({ ...rssForm, includeRegex: e.target.value })}
                    placeholder="例如：(1080p|2160p).*(简繁|CHS)"
                    className="w-full px-3 py-2 bg-[#06090d] border border-white/10 focus:border-cyan-400/60 outline-none text-xs font-mono text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    排除关键词正则（可选）
                  </label>
                  <input
                    type="text"
                    value={rssForm.excludeRegex}
                    onChange={(e) => setRssForm({ ...rssForm, excludeRegex: e.target.value })}
                    placeholder="例如：720p|合集|BIG5"
                    className="w-full px-3 py-2 bg-[#06090d] border border-white/10 focus:border-cyan-400/60 outline-none text-xs font-mono text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    最小体积限制 (MB，0 不限)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={rssForm.minSizeMb}
                    onChange={(e) =>
                      setRssForm({ ...rssForm, minSizeMb: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="w-full px-3 py-2 bg-[#06090d] border border-white/10 outline-none text-xs font-mono text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    最大体积保护 (MB，0 不限)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={rssForm.maxSizeMb}
                    onChange={(e) =>
                      setRssForm({ ...rssForm, maxSizeMb: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="w-full px-3 py-2 bg-[#06090d] border border-white/10 outline-none text-xs font-mono text-white"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-4 pt-1 text-xs text-zinc-300">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rssForm.sequential}
                    onChange={(e) => setRssForm({ ...rssForm, sequential: e.target.checked })}
                    className="accent-cyan-400"
                  />
                  默认开启「边下边播」（顺序下载）
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rssForm.bingeMode}
                    onChange={(e) => setRssForm({ ...rssForm, bingeMode: e.target.checked })}
                    className="accent-amber-400"
                  />
                  启用「追剧托管」（适合整季合集订阅）
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rssForm.enabled}
                    onChange={(e) => setRssForm({ ...rssForm, enabled: e.target.checked })}
                    className="accent-emerald-400"
                  />
                  立即启用定时轮询
                </label>
              </div>

              {/* Inline Live Dry-Run Preview */}
              <div className="border-t border-white/[0.08] pt-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    disabled={previewLoading || !rssForm.feedUrl.trim()}
                    onClick={() =>
                      void handlePreviewRss(
                        {
                          feedUrl: rssForm.feedUrl,
                          includeRegex: rssForm.includeRegex,
                          excludeRegex: rssForm.excludeRegex,
                          minSizeMb: rssForm.minSizeMb,
                          maxSizeMb: rssForm.maxSizeMb,
                          subscriptionId: rssForm.id,
                        },
                        false
                      )
                    }
                    className="px-3 py-1.5 border border-cyan-400/40 bg-cyan-400/10 hover:bg-cyan-400/20 disabled:opacity-40 text-xs font-mono text-cyan-300 flex items-center gap-1.5"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    {previewLoading ? '抓取预览中...' : '试跑规则预览（不触发下载）'}
                  </button>

                  {previewData && (
                    <span className="text-[11px] font-mono text-zinc-400">
                      命中 <strong className="text-emerald-400">{previewData.matchedCount}</strong> /{' '}
                      {previewData.total} 条
                    </span>
                  )}
                </div>

                {previewData && (
                  <div className="max-h-52 overflow-y-auto border border-white/[0.07] bg-[#06090d] divide-y divide-white/[0.05]">
                    {previewData.items.slice(0, 25).map((item) => (
                      <div key={item.guid} className="px-3 py-2 text-xs flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-zinc-200 truncate">{item.title}</div>
                          <div className="text-[10px] font-mono text-zinc-500">
                            {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '未知体积'} ·{' '}
                            {item.reason}
                            {item.alreadySeen ? ' · 已记录' : ''}
                          </div>
                        </div>
                        <span
                          className={`px-1.5 py-0.5 text-[10px] font-mono shrink-0 border ${
                            item.matched
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                              : 'border-white/10 text-zinc-500'
                          }`}
                        >
                          {item.matched ? 'MATCH' : 'SKIP'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-white/[0.08]">
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="px-4 py-2 border border-white/10 text-xs text-zinc-300 hover:text-white"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={savingSub}
                  className="px-5 py-2 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 text-zinc-950 text-xs font-mono font-bold"
                >
                  {savingSub ? '保存中...' : '保存规则'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== MODAL: STANDALONE PREVIEW ==================== */}
      {standalonePreviewOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="hud-panel w-full max-w-3xl max-h-[85vh] flex flex-col p-5 space-y-3">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
              <div>
                <div className="text-[10px] font-mono tracking-[0.2em] text-cyan-400">
                  RSS DRY-RUN PREVIEW
                </div>
                <h3 className="text-base font-semibold text-white">
                  {previewData?.title || '订阅规则试跑预览'}
                </h3>
              </div>
              <button
                onClick={() => setStandalonePreviewOpen(false)}
                className="p-1 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {previewLoading ? (
              <div className="py-12 text-center text-xs font-mono text-cyan-300">
                FETCHING RSS FEED...
              </div>
            ) : previewData ? (
              <>
                <div className="text-xs font-mono text-zinc-400">
                  共拉取 {previewData.total} 条，命中规则{' '}
                  <strong className="text-emerald-400">{previewData.matchedCount}</strong> 条（可点击右侧手动推送单条）
                </div>
                <div className="flex-1 overflow-y-auto border border-white/[0.07] bg-[#06090d] divide-y divide-white/[0.05]">
                  {previewData.items.map((item) => (
                    <div
                      key={item.guid}
                      className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="text-zinc-200 break-all">{item.title}</div>
                        <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
                          {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '未知体积'} ·{' '}
                          {item.reason}
                          {item.alreadySeen ? ' · 已抓取过' : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`px-1.5 py-0.5 text-[10px] font-mono border ${
                            item.matched
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                              : 'border-white/10 text-zinc-500'
                          }`}
                        >
                          {item.matched ? 'MATCH' : 'SKIP'}
                        </span>
                        {(item.magnetUrl || item.downloadUrl) && (
                          <button
                            disabled={pushingId === item.guid}
                            onClick={() =>
                              void handlePushItem(
                                {
                                  id: item.guid,
                                  title: item.title,
                                  magnetUrl: item.magnetUrl,
                                  downloadUrl: item.downloadUrl,
                                },
                                false
                              )
                            }
                            className="px-2 py-1 border border-cyan-400/40 text-[11px] font-mono text-cyan-300 hover:bg-cyan-400/15"
                          >
                            {pushedIds[item.guid] ? '已推送' : '手动下载'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* ==================== MODAL: RSS HISTORY ==================== */}
      {historyModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="hud-panel w-full max-w-3xl max-h-[85vh] flex flex-col p-5 space-y-3">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
              <div>
                <div className="text-[10px] font-mono tracking-[0.2em] text-cyan-400">
                  RSS AUDIT LOG
                </div>
                <h3 className="text-base font-semibold text-white">
                  {historyModal.subName} · 历史记录
                </h3>
              </div>
              <button
                onClick={() => setHistoryModal(null)}
                className="p-1 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {historyModal.items.length === 0 ? (
              <div className="py-10 text-center text-xs font-mono text-zinc-500">
                尚无抓取历史记录
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto border border-white/[0.07] bg-[#06090d] divide-y divide-white/[0.05]">
                {historyModal.items.map((item) => (
                  <div
                    key={item.itemGuid}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="text-zinc-200 break-all">{item.title}</div>
                      <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
                        {formatTimeAgo(item.seenAt)} ·{' '}
                        {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '未知体积'} ·{' '}
                        {item.reason}
                      </div>
                    </div>
                    <span
                      className={`px-1.5 py-0.5 text-[10px] font-mono shrink-0 border ${
                        item.pushed
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                          : 'border-white/10 text-zinc-500'
                      }`}
                    >
                      {item.pushed ? 'PUSHED' : 'SKIPPED'}
                    </span>
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
