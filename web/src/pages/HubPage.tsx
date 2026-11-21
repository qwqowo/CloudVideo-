import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search,
  Rss,
  Server,
  Download,
  Repeat,
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
  ArrowRight,
  KeyRound,
} from 'lucide-react';
import { apiFetch, formatBytes, parseMediaTitle } from '../lib/api';
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
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days} 天前`;
  return new Date(ts).toLocaleDateString();
}

export const HubPage: React.FC<HubPageProps> = ({ onDownloaded, onGoLibrary }) => {
  const [subTab, setSubTab] = useState<SubTab>('search');
  const [config, setConfig] = useState<HubConfigResponse | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [sort, setSort] = useState<SortMode>('seeders');
  const [qualityFilter, setQualityFilter] = useState<'ALL' | '4K' | '1080P'>('ALL');
  const [searching, setSearching] = useState(false);
  const [searchData, setSearchData] = useState<HubSearchResponse | null>(null);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [pushedIds, setPushedIds] = useState<Record<string, boolean>>({});

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

  const [subs, setSubs] = useState<RssSubscriptionRecord[]>([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [runningSubId, setRunningSubId] = useState<number | null>(null);

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
      const res = await apiFetch<{ subscriptions: RssSubscriptionRecord[] }>(
        '/api/rss/subscriptions'
      );
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
      const params = new URLSearchParams({ q: query.trim(), category, sort });
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
          ? `已按「追剧托管」加入影院：${parseMediaTitle(item.title).title}`
          : `已加入影院边下边播：${parseMediaTitle(item.title).title}`
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
        body: JSON.stringify({
          prowlarrUrl: prowlarrUrl.trim(),
          prowlarrApiKey: prowlarrApiKey.trim(),
        }),
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
        body: JSON.stringify({
          prowlarrUrl: prowlarrUrl.trim(),
          prowlarrApiKey: prowlarrApiKey.trim(),
        }),
      });
      setProwlarrTest(res);
      if (res.ok) notify('ok', `连接成功，已接入 ${res.indexerCount} 个站点`);
      else notify('err', res.error || '连接失败');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '测试失败');
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
      notify('ok', '已添加自定义索引源');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '添加失败');
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
      notify('ok', '已移除索引源');
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
      notify('err', '请先填写 RSS 订阅链接');
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
      notify('err', err instanceof Error ? err.message : '预览失败');
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
        notify('ok', '订阅规则已更新');
      } else {
        await apiFetch('/api/rss/subscriptions', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        notify('ok', '已添加自动追更订阅');
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
    await apiFetch(`/api/rss/subscriptions/${sub.id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: !sub.enabled }),
    }).catch(() => {});
    await loadSubs();
  };

  const handleRunSub = async (sub: RssSubscriptionRecord) => {
    setRunningSubId(sub.id);
    try {
      const res = await apiFetch<{
        ok: boolean;
        summary: { fetchedCount: number; pushedCount: number; errors: string[] };
      }>(`/api/rss/subscriptions/${sub.id}/run`, { method: 'POST' });
      await loadSubs();
      if (res.summary.errors.length > 0) {
        notify('err', `拉取完成但有异常：${res.summary.errors[0]}`);
      } else {
        notify(
          'ok',
          `「${sub.name}」检测 ${res.summary.fetchedCount} 条，新推送 ${res.summary.pushedCount} 部`
        );
      }
      if (res.summary.pushedCount > 0) onDownloaded?.();
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '抓取失败');
    } finally {
      setRunningSubId(null);
    }
  };

  const handleDeleteSub = async (sub: RssSubscriptionRecord) => {
    if (!confirm(`确定删除自动追更「${sub.name}」吗？`)) return;
    await apiFetch(`/api/rss/subscriptions/${sub.id}`, { method: 'DELETE' }).catch(() => {});
    await loadSubs();
    notify('ok', '已删除订阅');
  };

  const handleOpenHistory = async (sub: RssSubscriptionRecord) => {
    try {
      const res = await apiFetch<{ items: RssSeenItemRecord[] }>(
        `/api/rss/subscriptions/${sub.id}/history`
      );
      setHistoryModal({ subName: sub.name, items: res.items });
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '获取历史失败');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header + Segmented Pill Switch */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">找片与追更</h1>
          <p className="text-xs text-zinc-400 mt-1">
            聚合搜索在线片源一键开播，或挂载 RSS 规则自动追番追剧
          </p>
        </div>

        <div className="inline-flex p-1 rounded-full bg-white/[0.04] border border-white/[0.07] self-start">
          {[
            { id: 'search' as const, label: '搜片源', icon: Search },
            {
              id: 'rss' as const,
              label: `自动追更 (${subs.filter((s) => s.enabled).length})`,
              icon: Rss,
            },
            { id: 'indexers' as const, label: '片源接入', icon: Server },
          ].map((t) => {
            const Icon = t.icon;
            const active = subTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setSubTab(t.id)}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium transition ${
                  active ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Floating Toast */}
      {toast && (
        <div
          className={`rounded-2xl border px-4 py-3 text-xs flex items-center justify-between gap-3 ${
            toast.kind === 'ok'
              ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
              : 'border-rose-400/30 bg-rose-500/10 text-rose-200'
          }`}
        >
          <span>{toast.text}</span>
          <div className="flex items-center gap-3 shrink-0">
            {toast.kind === 'ok' && onGoLibrary && (
              <button
                onClick={onGoLibrary}
                className="text-white hover:underline inline-flex items-center gap-1 font-medium"
              >
                前往影院 <ArrowRight className="w-3 h-3" />
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
        <div className="space-y-5">
          {config && !hasAnyIndexer && (
            <div className="cinema-surface rounded-3xl p-5 border-amber-400/25 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-white">先接入片源索引，即可全网搜片</div>
                  <p className="text-xs text-zinc-400 mt-1">
                    打开已部署的 Prowlarr 面板添加索引站，复制 API Key 粘贴到「片源接入」即可开始使用。
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={prowlarrExternalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost px-4 py-2 text-xs"
                >
                  打开 Prowlarr <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <button
                  onClick={() => setSubTab('indexers')}
                  className="btn-ivory px-4 py-2 text-xs"
                >
                  去配置
                </button>
              </div>
            </div>
          )}

          {/* Spotlight Search Card */}
          <form onSubmit={handleSearch} className="cinema-surface rounded-3xl p-4 sm:p-5 space-y-4">
            <div className="flex flex-col sm:flex-row gap-2.5">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-zinc-400 absolute left-4 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索电影、剧集或番剧名称（国际源建议输入英文原名）..."
                  className="cinema-input w-full pl-11 pr-4 py-3 text-sm rounded-2xl"
                />
              </div>
              <button
                type="submit"
                disabled={searching || !query.trim()}
                className="btn-ivory px-6 py-3 text-sm rounded-2xl shrink-0"
              >
                <Search className={`w-4 h-4 ${searching ? 'animate-pulse' : ''}`} />
                {searching ? '搜索中...' : '搜索'}
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
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
                    className={`px-3 py-1 rounded-full text-xs transition ${
                      category === val
                        ? 'bg-white text-zinc-950 font-medium'
                        : 'bg-white/[0.05] text-zinc-400 hover:text-zinc-100'
                    }`}
                  >
                    {label}
                  </button>
                ))}

                <span className="text-zinc-700 mx-1">·</span>

                {(['ALL', '4K', '1080P'] as const).map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setQualityFilter(q)}
                    className={`px-3 py-1 rounded-full text-xs transition ${
                      qualityFilter === q
                        ? 'bg-amber-400/20 text-amber-200 border border-amber-400/35'
                        : 'bg-white/[0.04] text-zinc-400 hover:text-zinc-100 border border-transparent'
                    }`}
                  >
                    {q === 'ALL' ? '全部画质' : q}
                  </button>
                ))}
              </div>

              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortMode)}
                className="cinema-input px-3 py-1.5 text-xs rounded-full"
              >
                <option value="seeders">做种数优先</option>
                <option value="date">最新发布</option>
                <option value="size_asc">体积从小到大</option>
                <option value="size_desc">体积从大到小</option>
              </select>
            </div>
          </form>

          {searchData && searchData.errors.length > 0 && (
            <div className="rounded-2xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 space-y-1">
              {searchData.errors.map((err, i) => (
                <div key={i}>{err}</div>
              ))}
            </div>
          )}

          {/* Search Results */}
          {searchData && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400 px-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    找到 <strong className="text-white">{filteredResults.length}</strong> 条结果 ·
                    已查 {searchData.sourcesQueried} 个站点
                  </span>
                  {searchData.indexerBreakdown && searchData.indexerBreakdown.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      {searchData.indexerBreakdown.map((b) => (
                        <span
                          key={b.name}
                          className={`px-2 py-0.5 rounded-full text-[11px] ${
                            b.count > 0
                              ? 'bg-white/10 text-zinc-200'
                              : 'bg-white/[0.03] text-zinc-500'
                          }`}
                        >
                          {b.name} {b.count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="tabular-nums">
                  配额上限 {formatBytes(searchData.storageLimitBytes)}
                </span>
              </div>

              {filteredResults.length === 0 ? (
                <div className="cinema-surface rounded-3xl p-12 text-center text-sm text-zinc-400">
                  没有找到匹配结果，可以尝试换用英文原名或切换分类
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredResults.map((item: HubSearchResult) => {
                    const isPushing = pushingId === item.id;
                    const isPushed = Boolean(pushedIds[item.id]);
                    const hasDownload = Boolean(item.magnetUrl || item.downloadUrl);
                    const parsed = parseMediaTitle(item.title);

                    return (
                      <div
                        key={item.id}
                        className="cinema-card rounded-2xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3.5"
                      >
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex items-start gap-2">
                            <div className="text-sm font-medium text-white leading-snug break-all">
                              {parsed.title}
                              {parsed.year && (
                                <span className="text-zinc-400 font-normal ml-1.5">
                                  ({parsed.year})
                                </span>
                              )}
                            </div>
                            {item.infoUrl && (
                              <a
                                href={item.infoUrl}
                                target="_blank"
                                rel="noreferrer"
                                title="打开原站详情"
                                className="text-zinc-500 hover:text-white shrink-0 mt-0.5"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            )}
                          </div>

                          {parsed.title !== item.title && (
                            <div className="text-[11px] text-zinc-500 break-all line-clamp-1">
                              {item.title}
                            </div>
                          )}

                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className="px-2 py-0.5 rounded-full bg-white/[0.06] text-zinc-300">
                              {item.indexer}
                            </span>
                            {item.resolution && (
                              <span
                                className={`px-2 py-0.5 rounded-full ${
                                  item.resolution === '4K'
                                    ? 'bg-amber-400/15 text-amber-300'
                                    : 'bg-white/10 text-zinc-100'
                                }`}
                              >
                                {item.resolution}
                              </span>
                            )}
                            {item.tags.map((tag) => (
                              <span
                                key={tag}
                                className="px-2 py-0.5 rounded-full bg-white/[0.04] text-zinc-400"
                              >
                                {tag}
                              </span>
                            ))}
                            <span className="text-zinc-500 ml-1">
                              {formatTimeAgo(item.publishTimestamp || null)}
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-wrap sm:flex-nowrap items-center justify-between lg:justify-end gap-4 shrink-0">
                          <div className="flex items-center gap-3.5 text-xs tabular-nums">
                            <div className="text-right">
                              <div
                                className={
                                  item.exceedsLimit ? 'text-rose-400 font-medium' : 'text-zinc-200'
                                }
                              >
                                {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '未知体积'}
                              </div>
                              {item.exceedsLimit && (
                                <div className="text-[10px] text-rose-400">
                                  超配额 · 建议追剧模式
                                </div>
                              )}
                            </div>

                            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] text-xs">
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${
                                  item.seeders >= 10
                                    ? 'bg-emerald-400'
                                    : item.seeders > 0
                                      ? 'bg-amber-400'
                                      : 'bg-zinc-600'
                                }`}
                              />
                              <span className="text-zinc-200">{item.seeders}</span>
                              <span className="text-zinc-500">做种</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            {isPushed ? (
                              <button
                                onClick={onGoLibrary}
                                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 text-xs font-medium"
                              >
                                <Check className="w-3.5 h-3.5" />
                                已加入 · 查看
                              </button>
                            ) : !hasDownload ? (
                              <div className="flex items-center gap-1.5">
                                <span
                                  title={item.unavailableReason || '索引站未提供下载链接'}
                                  className="px-3 py-1.5 rounded-full bg-white/[0.04] text-zinc-500 text-xs"
                                >
                                  无种子直链
                                </span>
                                {item.infoUrl && (
                                  <a
                                    href={item.infoUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="btn-ghost px-3 py-1.5 text-xs"
                                  >
                                    原站页 <ExternalLink className="w-3 h-3" />
                                  </a>
                                )}
                              </div>
                            ) : (
                              <>
                                <button
                                  disabled={isPushing}
                                  title={
                                    item.seeders === 0
                                      ? '做种数为 0（部分站点不回报做种数，仍可尝试下载）'
                                      : '加入影院并开启顺序边下边播'
                                  }
                                  onClick={() => void handlePushItem(item, false)}
                                  className="btn-ivory px-4 py-1.5 text-xs"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  {isPushing ? '推送中...' : '边下边播'}
                                </button>
                                <button
                                  disabled={isPushing}
                                  onClick={() => void handlePushItem(item, true)}
                                  title="适合整季合集：仅先下前几集，看到 70% 自动预载下集"
                                  className="btn-ghost px-3 py-1.5 text-xs text-amber-200 hover:border-amber-400/40"
                                >
                                  <Repeat className="w-3.5 h-3.5 text-amber-400" />
                                  追剧模式
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

      {/* ==================== TAB 2: RSS AUTO-WATCHLIST ==================== */}
      {subTab === 'rss' && (
        <div className="space-y-4">
          <div className="cinema-surface rounded-3xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-zinc-400">
              挂载蜜柑计划、Nyaa RSS、Prowlarr/Jackett RSS 或 PT 站订阅链接，自动按正则和体积筛选并下载新剧集。
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => void loadSubs()} className="btn-ghost px-3.5 py-2 text-xs">
                <RefreshCw className={`w-3.5 h-3.5 ${loadingSubs ? 'animate-spin' : ''}`} />
                刷新
              </button>
              <button onClick={openCreateRss} className="btn-ivory px-4 py-2 text-xs">
                <Plus className="w-3.5 h-3.5" />
                新建追更订阅
              </button>
            </div>
          </div>

          {subs.length === 0 ? (
            <div className="cinema-surface rounded-3xl p-12 text-center space-y-3">
              <div className="w-12 h-12 mx-auto rounded-2xl bg-white/[0.06] flex items-center justify-center text-zinc-300">
                <Rss className="w-5 h-5" />
              </div>
              <div className="text-sm font-medium text-white">还没有自动追更订阅</div>
              <p className="text-xs text-zinc-400 max-w-md mx-auto">
                添加一条 RSS 订阅并设置筛选关键词（如 1080p|简繁）与单集体积上限，新集发布后会自动静默下好等你来看。
              </p>
              <button onClick={openCreateRss} className="btn-ivory px-5 py-2 text-xs mt-2">
                添加第一条订阅
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {subs.map((sub) => (
                <div
                  key={sub.id}
                  className="cinema-card rounded-2xl p-5 flex flex-col justify-between gap-4"
                >
                  <div className="space-y-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-white truncate">{sub.name}</h3>
                        <div className="text-[11px] text-zinc-500 truncate mt-0.5">
                          {sub.feedUrl}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleToggleSub(sub)}
                        title={sub.enabled ? '暂停自动轮询' : '启用自动轮询'}
                        className={`w-10 h-5 rounded-full transition flex items-center px-0.5 shrink-0 ${
                          sub.enabled
                            ? 'bg-emerald-400 justify-end'
                            : 'bg-zinc-700 justify-start'
                        }`}
                      >
                        <span
                          className={`w-4 h-4 rounded-full ${
                            sub.enabled ? 'bg-zinc-950' : 'bg-zinc-400'
                          }`}
                        />
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <span className="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-300">
                        每 {sub.intervalMin} 分钟检测
                      </span>
                      {sub.sequential && (
                        <span className="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-200">
                          边下边播
                        </span>
                      )}
                      {sub.bingeMode && (
                        <span className="px-2.5 py-0.5 rounded-full bg-amber-400/15 text-amber-300">
                          追剧托管
                        </span>
                      )}
                      {sub.includeRegex && (
                        <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">
                          包含：{sub.includeRegex}
                        </span>
                      )}
                      {sub.excludeRegex && (
                        <span className="px-2.5 py-0.5 rounded-full bg-rose-500/15 text-rose-300">
                          排除：{sub.excludeRegex}
                        </span>
                      )}
                      {(sub.minSizeMb > 0 || sub.maxSizeMb > 0) && (
                        <span className="px-2.5 py-0.5 rounded-full bg-white/[0.04] text-zinc-400 tabular-nums">
                          {sub.minSizeMb || 0} ~ {sub.maxSizeMb || '∞'} MB
                        </span>
                      )}
                    </div>

                    {sub.lastError && (
                      <div className="rounded-xl bg-rose-500/10 border border-rose-500/25 px-3 py-2 text-[11px] text-rose-200">
                        上次抓取异常：{sub.lastError}
                      </div>
                    )}
                  </div>

                  <div className="pt-3 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="text-zinc-500 flex items-center gap-3 tabular-nums">
                      <span>上次：{formatTimeAgo(sub.lastCheckedAt)}</span>
                      <span>
                        已推送 <strong className="text-zinc-200">{sub.matchedCount}</strong>
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        disabled={runningSubId === sub.id}
                        onClick={() => void handleRunSub(sub)}
                        className="btn-ivory px-3 py-1.5 text-xs"
                      >
                        <Play className="w-3 h-3 fill-current" />
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
                        title="试跑预览"
                        className="p-2 rounded-full border border-white/[0.08] text-zinc-300 hover:bg-white/[0.08]"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => void handleOpenHistory(sub)}
                        title="抓取历史"
                        className="p-2 rounded-full border border-white/[0.08] text-zinc-300 hover:bg-white/[0.08]"
                      >
                        <History className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => openEditRss(sub)}
                        title="编辑"
                        className="p-2 rounded-full border border-white/[0.08] text-zinc-300 hover:bg-white/[0.08]"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => void handleDeleteSub(sub)}
                        title="删除"
                        className="p-2 rounded-full border border-white/[0.08] text-zinc-400 hover:text-rose-300 hover:bg-rose-500/10"
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
          {/* Prowlarr */}
          <div className="cinema-surface rounded-3xl p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white">Prowlarr 聚合索引</h2>
                <p className="text-xs text-zinc-400 mt-1">
                  Docker 内网地址保持 <code className="text-zinc-200">http://prowlarr:9696</code>，粘贴 API Key 即可联动。
                </p>
              </div>
              <a
                href={prowlarrExternalUrl}
                target="_blank"
                rel="noreferrer"
                className="btn-ghost px-3 py-1.5 text-xs shrink-0"
              >
                打开面板 <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="space-y-3.5">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Prowlarr 内网地址</label>
                <input
                  type="text"
                  value={prowlarrUrl}
                  onChange={(e) => setProwlarrUrl(e.target.value)}
                  placeholder="http://prowlarr:9696"
                  className="cinema-input w-full px-3.5 py-2.5 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">
                  API Key（Settings → General → Security）
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <KeyRound className="w-3.5 h-3.5 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={prowlarrApiKey}
                      onChange={(e) => setProwlarrApiKey(e.target.value)}
                      placeholder="粘贴 32 位 API Key"
                      className="cinema-input w-full pl-9 pr-3.5 py-2.5 text-xs font-mono"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="btn-ghost px-3.5 py-2 text-xs"
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
                  className="btn-ivory px-5 py-2 text-xs"
                >
                  {savingProwlarr ? '保存中...' : '保存配置'}
                </button>
                <button
                  type="button"
                  disabled={testingProwlarr}
                  onClick={() => void handleTestProwlarr()}
                  className="btn-ghost px-4 py-2 text-xs"
                >
                  {testingProwlarr ? '检测中...' : '测试连接'}
                </button>
              </div>

              {prowlarrTest && (
                <div
                  className={`p-3.5 rounded-2xl border text-xs space-y-2 ${
                    prowlarrTest.ok
                      ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                      : 'border-rose-400/30 bg-rose-500/10 text-rose-200'
                  }`}
                >
                  <div>
                    {prowlarrTest.ok
                      ? `连接成功，已接入 ${prowlarrTest.indexerCount} 个启用站点`
                      : prowlarrTest.error}
                  </div>
                  {prowlarrTest.ok && prowlarrTest.enabledIndexers.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {prowlarrTest.enabledIndexers.map((idx) => (
                        <span
                          key={idx.id}
                          className="px-2 py-0.5 rounded-full bg-emerald-400/15 text-[11px]"
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

          {/* Custom Torznab */}
          <div className="cinema-surface rounded-3xl p-6 space-y-5">
            <div>
              <h2 className="text-base font-semibold text-white">自定义 Torznab 源（Jackett）</h2>
              <p className="text-xs text-zinc-400 mt-1">
                可额外挂载 Jackett 或其他标准 Torznab 接口，与 Prowlarr 并发聚合搜索。
              </p>
            </div>

            <form
              onSubmit={handleAddTorznab}
              className="space-y-2.5 p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06]"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <input
                  type="text"
                  value={newIdxName}
                  onChange={(e) => setNewIdxName(e.target.value)}
                  placeholder="名称（如 Jackett）"
                  className="cinema-input px-3 py-2 text-xs"
                />
                <input
                  type="text"
                  value={newIdxKey}
                  onChange={(e) => setNewIdxKey(e.target.value)}
                  placeholder="API Key（可选）"
                  className="cinema-input px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={newIdxUrl}
                  onChange={(e) => setNewIdxUrl(e.target.value)}
                  placeholder="Torznab API 地址"
                  className="cinema-input flex-1 px-3 py-2 text-xs font-mono"
                />
                <button
                  type="submit"
                  disabled={addingIdx || !newIdxName.trim() || !newIdxUrl.trim()}
                  className="btn-ivory px-4 py-2 text-xs shrink-0"
                >
                  添加
                </button>
              </div>
            </form>

            <div className="space-y-2">
              {(!config || config.torznabIndexers.length === 0) && (
                <div className="text-xs text-zinc-500 py-5 text-center rounded-2xl border border-dashed border-white/10">
                  暂无自定义 Torznab 源
                </div>
              )}
              {config?.torznabIndexers.map((idx) => (
                <div
                  key={idx.id}
                  className="p-3.5 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-white">{idx.name}</div>
                    <div className="text-[11px] text-zinc-500 truncate">{idx.url}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => void handleToggleTorznab(idx.id, !idx.enabled)}
                      className={`px-2.5 py-1 rounded-full text-[11px] ${
                        idx.enabled
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-white/[0.06] text-zinc-500'
                      }`}
                    >
                      {idx.enabled ? '已启用' : '已停用'}
                    </button>
                    <button
                      onClick={() => void handleDeleteTorznab(idx.id)}
                      className="p-1.5 rounded-full text-zinc-400 hover:text-rose-300 hover:bg-rose-500/10"
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

      {/* ==================== MODAL: RSS EDITOR ==================== */}
      {editorOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto"
          onClick={() => setEditorOpen(false)}
        >
          <div
            className="cinema-glass rounded-3xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/[0.07] pb-4">
              <h3 className="text-base font-semibold text-white">
                {rssForm.id ? '编辑自动追更规则' : '新建自动追更规则'}
              </h3>
              <button
                onClick={() => setEditorOpen(false)}
                className="p-2 rounded-full text-zinc-400 hover:text-white hover:bg-white/[0.08]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveRss} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">订阅名称</label>
                  <input
                    required
                    type="text"
                    value={rssForm.name}
                    onChange={(e) => setRssForm({ ...rssForm, name: e.target.value })}
                    placeholder="例如：蜜柑计划 - 2026 新番"
                    className="cinema-input w-full px-3.5 py-2.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">
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
                    className="cinema-input w-full px-3.5 py-2.5 text-xs tabular-nums"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">RSS / Atom 链接</label>
                <input
                  required
                  type="url"
                  value={rssForm.feedUrl}
                  onChange={(e) => setRssForm({ ...rssForm, feedUrl: e.target.value })}
                  placeholder="https://..."
                  className="cinema-input w-full px-3.5 py-2.5 text-xs font-mono"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">包含关键词（正则）</label>
                  <input
                    type="text"
                    value={rssForm.includeRegex}
                    onChange={(e) => setRssForm({ ...rssForm, includeRegex: e.target.value })}
                    placeholder="例如：(1080p|2160p).*(简繁|CHS)"
                    className="cinema-input w-full px-3.5 py-2.5 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">排除关键词（正则）</label>
                  <input
                    type="text"
                    value={rssForm.excludeRegex}
                    onChange={(e) => setRssForm({ ...rssForm, excludeRegex: e.target.value })}
                    placeholder="例如：720p|合集"
                    className="cinema-input w-full px-3.5 py-2.5 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">最小体积 (MB，0 不限)</label>
                  <input
                    type="number"
                    min={0}
                    value={rssForm.minSizeMb}
                    onChange={(e) =>
                      setRssForm({ ...rssForm, minSizeMb: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="cinema-input w-full px-3.5 py-2.5 text-xs tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">最大体积保护 (MB，0 不限)</label>
                  <input
                    type="number"
                    min={0}
                    value={rssForm.maxSizeMb}
                    onChange={(e) =>
                      setRssForm({ ...rssForm, maxSizeMb: Math.max(0, Number(e.target.value) || 0) })
                    }
                    className="cinema-input w-full px-3.5 py-2.5 text-xs tabular-nums"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-4 text-xs text-zinc-300">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rssForm.sequential}
                    onChange={(e) => setRssForm({ ...rssForm, sequential: e.target.checked })}
                    className="accent-white"
                  />
                  默认边下边播
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rssForm.bingeMode}
                    onChange={(e) => setRssForm({ ...rssForm, bingeMode: e.target.checked })}
                    className="accent-amber-400"
                  />
                  启用追剧托管
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rssForm.enabled}
                    onChange={(e) => setRssForm({ ...rssForm, enabled: e.target.checked })}
                    className="accent-emerald-400"
                  />
                  立即启用轮询
                </label>
              </div>

              {/* Inline Dry-Run Preview */}
              <div className="border-t border-white/[0.07] pt-4 space-y-3">
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
                    className="btn-ghost px-3.5 py-1.5 text-xs"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    {previewLoading ? '正在预览...' : '试跑规则预览（不下载）'}
                  </button>
                  {previewData && (
                    <span className="text-xs text-zinc-400 tabular-nums">
                      命中 <strong className="text-emerald-400">{previewData.matchedCount}</strong> /{' '}
                      {previewData.total}
                    </span>
                  )}
                </div>

                {previewData && (
                  <div className="max-h-52 overflow-y-auto rounded-2xl border border-white/[0.07] bg-[#0c0c10] divide-y divide-white/[0.05]">
                    {previewData.items.slice(0, 25).map((item) => (
                      <div
                        key={item.guid}
                        className="px-3.5 py-2.5 text-xs flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="text-zinc-200 truncate">{item.title}</div>
                          <div className="text-[11px] text-zinc-500">
                            {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '未知体积'} ·{' '}
                            {item.reason}
                          </div>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] shrink-0 ${
                            item.matched
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-white/[0.05] text-zinc-500'
                          }`}
                        >
                          {item.matched ? '命中' : '跳过'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-white/[0.07]">
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="btn-ghost px-4 py-2 text-xs"
                >
                  取消
                </button>
                <button type="submit" disabled={savingSub} className="btn-ivory px-5 py-2 text-xs">
                  {savingSub ? '保存中...' : '保存规则'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== MODAL: STANDALONE PREVIEW ==================== */}
      {standalonePreviewOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setStandalonePreviewOpen(false)}
        >
          <div
            className="cinema-glass rounded-3xl w-full max-w-3xl max-h-[85vh] flex flex-col p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/[0.07] pb-3">
              <h3 className="text-base font-semibold text-white">
                {previewData?.title || '订阅规则试跑预览'}
              </h3>
              <button
                onClick={() => setStandalonePreviewOpen(false)}
                className="p-2 rounded-full text-zinc-400 hover:text-white hover:bg-white/[0.08]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {previewLoading ? (
              <div className="py-12 text-center text-xs text-zinc-400">正在拉取 RSS 列表...</div>
            ) : previewData ? (
              <>
                <div className="text-xs text-zinc-400">
                  共拉取 {previewData.total} 条，命中{' '}
                  <strong className="text-emerald-400">{previewData.matchedCount}</strong> 条
                </div>
                <div className="flex-1 overflow-y-auto rounded-2xl border border-white/[0.07] bg-[#0c0c10] divide-y divide-white/[0.05]">
                  {previewData.items.map((item) => (
                    <div
                      key={item.guid}
                      className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="text-zinc-200 break-all">{item.title}</div>
                        <div className="text-[11px] text-zinc-500 mt-0.5">
                          {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '未知体积'} ·{' '}
                          {item.reason}
                          {item.alreadySeen ? ' · 已记录' : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] ${
                            item.matched
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-white/[0.05] text-zinc-500'
                          }`}
                        >
                          {item.matched ? '命中' : '跳过'}
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
                            className="btn-ghost px-3 py-1 text-[11px]"
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
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setHistoryModal(null)}
        >
          <div
            className="cinema-glass rounded-3xl w-full max-w-3xl max-h-[85vh] flex flex-col p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/[0.07] pb-3">
              <h3 className="text-base font-semibold text-white">
                {historyModal.subName} · 抓取记录
              </h3>
              <button
                onClick={() => setHistoryModal(null)}
                className="p-2 rounded-full text-zinc-400 hover:text-white hover:bg-white/[0.08]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {historyModal.items.length === 0 ? (
              <div className="py-10 text-center text-xs text-zinc-500">尚无历史记录</div>
            ) : (
              <div className="flex-1 overflow-y-auto rounded-2xl border border-white/[0.07] bg-[#0c0c10] divide-y divide-white/[0.05]">
                {historyModal.items.map((item) => (
                  <div
                    key={item.itemGuid}
                    className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="text-zinc-200 break-all">{item.title}</div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">
                        {formatTimeAgo(item.seenAt)} ·{' '}
                        {item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '未知体积'} ·{' '}
                        {item.reason}
                      </div>
                    </div>
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-[10px] shrink-0 ${
                        item.pushed
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-white/[0.05] text-zinc-500'
                      }`}
                    >
                      {item.pushed ? '已下载' : '已过滤'}
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
