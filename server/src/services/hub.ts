import crypto from 'node:crypto';
import type { AppDatabase } from '../db.js';
import type { IQBittorrentClient } from './qbittorrent.js';
import type { CleanupService } from './cleanup.js';

export type HubCategory = 'all' | 'movies' | 'tv' | 'anime';
export type HubSort = 'seeders' | 'date' | 'size_asc' | 'size_desc';

export interface HubSearchResult {
  id: string;
  title: string;
  indexer: string;
  sourceType: 'prowlarr' | 'torznab';
  sizeBytes: number;
  seeders: number;
  leechers: number;
  publishDate: string;
  publishTimestamp: number;
  downloadUrl: string;
  magnetUrl: string;
  infoUrl: string;
  infoHash: string;
  categories: number[];
  resolution: string;
  tags: string[];
  exceedsLimit: boolean;
  unavailableReason?: string;
}

export interface ProwlarrTestResult {
  ok: boolean;
  indexerCount: number;
  enabledIndexers: Array<{ id: number; name: string; protocol: string; enable: boolean }>;
  error?: string;
}

export interface HubSearchResponse {
  query: string;
  category: HubCategory;
  results: HubSearchResult[];
  sourcesQueried: number;
  indexerBreakdown: Array<{ name: string; count: number }>;
  errors: string[];
  storageLimitBytes: number;
}

const CATEGORY_MAP: Record<HubCategory, number[]> = {
  all: [],
  movies: [2000],
  tv: [5000],
  anime: [5070],
};

export function decodeXmlEntities(raw: string): string {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return unwrapped
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

export function extractTagValue(block: string, tagName: string): string {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1]) : '';
}

export function parseXmlAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    attrs[m[1].toLowerCase()] = decodeXmlEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

export function parseHumanSizeToBytes(raw: string | number | undefined | null): number {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
  if (!raw) return 0;
  const trimmed = String(raw).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const m = trimmed.match(/([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  if (!Number.isFinite(val) || val <= 0) return 0;
  const unit = m[2].toLowerCase();
  const mult: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
  };
  return Math.round(val * (mult[unit] || 1));
}

export function parseReleaseMetadata(title: string): { resolution: string; tags: string[] } {
  let resolution = '';
  if (/\b(2160p|4k|uhd)\b/i.test(title)) resolution = '4K';
  else if (/\b1080p\b/i.test(title)) resolution = '1080P';
  else if (/\b720p\b/i.test(title)) resolution = '720P';

  const tags: string[] = [];
  if (/\b(hdr10\+?|hdr|dv|dovi|dolby\.?vision)\b/i.test(title)) tags.push('HDR');
  if (/\bremux\b/i.test(title)) tags.push('REMUX');
  else if (/\b(blu-?ray|bdrip|bdremux)\b/i.test(title)) tags.push('BLURAY');
  else if (/\bweb-?dl\b/i.test(title)) tags.push('WEB-DL');
  else if (/\bwebrip\b/i.test(title)) tags.push('WEBRIP');

  if (/\b(x265|h\.?265|hevc)\b/i.test(title)) tags.push('HEVC');
  else if (/\b(x264|h\.?264|avc)\b/i.test(title)) tags.push('H264');
  else if (/\bav1\b/i.test(title)) tags.push('AV1');

  if (/(简繁|简中|繁中|中字|中英|双语|\bchs\b|\bcht\b|\bzh\b)/i.test(title)) {
    tags.push('中字');
  }

  return { resolution, tags: tags.slice(0, 4) };
}

export function extractHexHashFromMagnet(magnet: string): string | null {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
  return m ? m[1].toLowerCase() : null;
}

export function buildMagnetFromInfoHash(infoHash: string, title: string): string {
  const clean = infoHash.trim();
  if (/^[a-fA-F0-9]{40}$/.test(clean) || /^[a-zA-Z2-7]{32}$/.test(clean)) {
    return `magnet:?xt=urn:btih:${clean.toLowerCase()}&dn=${encodeURIComponent(title)}`;
  }
  return '';
}

function resolveOptionalHttpUrl(raw: string | undefined | null, baseUrl?: string): string {
  const val = (raw || '').trim();
  if (!val || /^magnet:/i.test(val)) return '';
  if (/^https?:\/\//i.test(val)) return val;
  if (baseUrl) {
    try {
      return new URL(val, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
    } catch {
      return '';
    }
  }
  return '';
}

export function parseTorznabXml(
  xml: string,
  fallbackIndexer: string,
  storageLimitBytes: number
): HubSearchResult[] {
  const results: HubSearchResult[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTagValue(block, 'title');
    if (!title) continue;

    const guid = extractTagValue(block, 'guid');
    const link = extractTagValue(block, 'link');
    const comments = extractTagValue(block, 'comments');
    const pubDate = extractTagValue(block, 'pubDate');
    const sizeTag = extractTagValue(block, 'size');

    let enclosureUrl = '';
    let enclosureLen = 0;
    const encRe = /<enclosure\b([^>]*)\/?>/gi;
    let encM: RegExpExecArray | null;
    while ((encM = encRe.exec(block)) !== null) {
      const attrs = parseXmlAttributes(encM[1]);
      if (attrs.url && (!enclosureUrl || attrs.type?.includes('bittorrent'))) {
        enclosureUrl = attrs.url;
        enclosureLen = Number(attrs.length || 0) || 0;
      }
    }

    const attrMap = new Map<string, string[]>();
    const attrRe = /<(?:torznab|newznab):attr\b([^>]*)\/?>/gi;
    let attrM: RegExpExecArray | null;
    while ((attrM = attrRe.exec(block)) !== null) {
      const attrs = parseXmlAttributes(attrM[1]);
      if (attrs.name && attrs.value !== undefined) {
        const key = attrs.name.toLowerCase();
        const arr = attrMap.get(key) || [];
        arr.push(attrs.value);
        attrMap.set(key, arr);
      }
    }

    const firstAttr = (k: string) => attrMap.get(k)?.[0] || '';
    const seeders = Math.max(0, parseInt(firstAttr('seeders') || '0', 10) || 0);
    const peersRaw = parseInt(firstAttr('peers') || '0', 10) || 0;
    const leechersAttr = parseInt(firstAttr('leechers') || '-1', 10);
    const leechers = leechersAttr >= 0 ? leechersAttr : Math.max(0, peersRaw - seeders);

    const sizeBytes =
      parseHumanSizeToBytes(firstAttr('size')) ||
      parseHumanSizeToBytes(sizeTag) ||
      enclosureLen;

    let magnetUrl = firstAttr('magneturl');
    if (!magnetUrl && /^magnet:/i.test(link)) magnetUrl = link;
    if (!magnetUrl && /^magnet:/i.test(enclosureUrl)) magnetUrl = enclosureUrl;
    if (!magnetUrl && /^magnet:/i.test(guid)) magnetUrl = guid;

    let downloadUrl = '';
    if (enclosureUrl && !/^magnet:/i.test(enclosureUrl)) {
      downloadUrl = enclosureUrl;
    } else if (link && !/^magnet:/i.test(link)) {
      downloadUrl = link;
    }

    const infoHash =
      firstAttr('infohash').toLowerCase() ||
      (magnetUrl ? extractHexHashFromMagnet(magnetUrl) || '' : '');

    if (!magnetUrl && !downloadUrl && infoHash) {
      magnetUrl = buildMagnetFromInfoHash(infoHash, title);
    }

    const categories = (attrMap.get('category') || [])
      .map((v) => parseInt(v, 10))
      .filter((n) => Number.isFinite(n));

    const indexerFromTag = extractTagValue(block, 'prowlarrindexer') || extractTagValue(block, 'jackettindexer');
    const indexer = indexerFromTag || fallbackIndexer;

    const ts = pubDate ? Date.parse(pubDate) : 0;
    const publishTimestamp = Number.isFinite(ts) ? ts : 0;
    const meta = parseReleaseMetadata(title);
    const id = crypto
      .createHash('sha1')
      .update(`${indexer}:${guid || infoHash || title}:${sizeBytes}`)
      .digest('hex')
      .slice(0, 16);

    const unavailableReason =
      !magnetUrl && !downloadUrl ? '该索引站未返回磁力链接或种子直链' : undefined;

    results.push({
      id,
      title,
      indexer,
      sourceType: 'torznab',
      sizeBytes,
      seeders,
      leechers,
      publishDate: pubDate,
      publishTimestamp,
      downloadUrl,
      magnetUrl,
      infoUrl: comments || (guid.startsWith('http') ? guid : ''),
      infoHash,
      categories,
      resolution: meta.resolution,
      tags: meta.tags,
      exceedsLimit: storageLimitBytes > 0 && sizeBytes > storageLimitBytes,
      unavailableReason,
    });
  }

  return results;
}

export class HubService {
  constructor(
    private db: AppDatabase,
    private qbit: IQBittorrentClient,
    private cleanup: CleanupService
  ) {}

  async testProwlarrConnection(url?: string, apiKey?: string): Promise<ProwlarrTestResult> {
    const settings = this.db.getSettings();
    const targetUrl = (url ?? settings.prowlarrUrl).trim().replace(/\/+$/, '');
    const key = (apiKey ?? settings.prowlarrApiKey).trim();

    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      return { ok: false, indexerCount: 0, enabledIndexers: [], error: '请输入合法的 Prowlarr 地址 (http:// 或 https://)' };
    }
    if (!key) {
      return { ok: false, indexerCount: 0, enabledIndexers: [], error: '请填写 Prowlarr API Key' };
    }

    try {
      const res = await fetch(`${targetUrl}/api/v1/indexer`, {
        headers: { 'X-Api-Key': key, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        return {
          ok: false,
          indexerCount: 0,
          enabledIndexers: [],
          error: `Prowlarr 返回 HTTP ${res.status}（请检查 API Key 是否正确）`,
        };
      }
      const list = (await res.json()) as Array<{
        id: number;
        name: string;
        protocol?: string;
        enable?: boolean;
      }>;
      const enabledIndexers = list
        .filter((i) => i.enable !== false)
        .map((i) => ({
          id: i.id,
          name: i.name,
          protocol: i.protocol || 'torrent',
          enable: true,
        }));
      return {
        ok: true,
        indexerCount: enabledIndexers.length,
        enabledIndexers,
      };
    } catch (err) {
      return {
        ok: false,
        indexerCount: 0,
        enabledIndexers: [],
        error: err instanceof Error ? err.message : '无法连接 Prowlarr 服务',
      };
    }
  }

  private async searchProwlarr(
    baseUrl: string,
    apiKey: string,
    query: string,
    category: HubCategory,
    storageLimitBytes: number
  ): Promise<HubSearchResult[]> {
    const params = new URLSearchParams({ query, type: 'search' });
    for (const cat of CATEGORY_MAP[category]) {
      params.append('categories', String(cat));
    }

    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/search?${params.toString()}`, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new Error(`Prowlarr HTTP ${res.status}`);
    }

    const raw = (await res.json()) as Array<{
      guid?: string;
      title?: string;
      indexer?: string;
      protocol?: string;
      size?: number;
      seeders?: number;
      leechers?: number;
      publishDate?: string;
      downloadUrl?: string;
      magnetUrl?: string;
      infoUrl?: string;
      infoHash?: string;
      categories?: Array<{ id?: number } | number>;
    }>;

    const results: HubSearchResult[] = [];
    for (const item of raw) {
      if (item.protocol?.toLowerCase() === 'usenet') continue;
      const title = (item.title || '').trim();
      if (!title) continue;

      const sizeBytes = Number(item.size || 0) || 0;
      let magnetUrl = /^magnet:/i.test(item.magnetUrl || '')
        ? (item.magnetUrl || '').trim()
        : /^magnet:/i.test(item.downloadUrl || '')
          ? (item.downloadUrl || '').trim()
          : /^magnet:/i.test(item.guid || '')
            ? (item.guid || '').trim()
            : '';
      const downloadUrl = resolveOptionalHttpUrl(item.downloadUrl, baseUrl);
      const infoHash =
        (item.infoHash || '').trim().toLowerCase() ||
        (magnetUrl ? extractHexHashFromMagnet(magnetUrl) || '' : '');

      // Some indexers expose only raw infoHash without a magnet/download URL — synthesize a valid magnet URI!
      if (!magnetUrl && !downloadUrl && infoHash) {
        magnetUrl = buildMagnetFromInfoHash(infoHash, title);
      }

      const categories = (item.categories || [])
        .map((c) => (typeof c === 'number' ? c : Number(c?.id)))
        .filter((n) => Number.isFinite(n));

      const ts = item.publishDate ? Date.parse(item.publishDate) : 0;
      const publishTimestamp = Number.isFinite(ts) ? ts : 0;
      const meta = parseReleaseMetadata(title);
      const indexer = item.indexer || 'Prowlarr';
      const id = crypto
        .createHash('sha1')
        .update(`prowlarr:${indexer}:${item.guid || infoHash || title}:${sizeBytes}`)
        .digest('hex')
        .slice(0, 16);

      const unavailableReason =
        !magnetUrl && !downloadUrl ? '该索引站未返回磁力链接或种子直链' : undefined;

      results.push({
        id,
        title,
        indexer,
        sourceType: 'prowlarr',
        sizeBytes,
        seeders: Math.max(0, Number(item.seeders || 0) || 0),
        leechers: Math.max(0, Number(item.leechers || 0) || 0),
        publishDate: item.publishDate || '',
        publishTimestamp,
        downloadUrl,
        magnetUrl,
        infoUrl: item.infoUrl || '',
        infoHash,
        categories,
        resolution: meta.resolution,
        tags: meta.tags,
        exceedsLimit: storageLimitBytes > 0 && sizeBytes > storageLimitBytes,
        unavailableReason,
      });
    }

    return results;
  }

  private async searchTorznabIndexer(
    indexer: { name: string; url: string; apiKey: string },
    query: string,
    category: HubCategory,
    storageLimitBytes: number
  ): Promise<HubSearchResult[]> {
    const u = new URL(indexer.url);
    u.searchParams.set('t', 'search');
    u.searchParams.set('q', query);
    if (indexer.apiKey) u.searchParams.set('apikey', indexer.apiKey);
    const cats = CATEGORY_MAP[category];
    if (cats.length > 0) u.searchParams.set('cat', cats.join(','));

    const res = await fetch(u.toString(), {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(18000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const xml = await res.text();
    return parseTorznabXml(xml, indexer.name, storageLimitBytes);
  }

  async search(opts: {
    query: string;
    category?: HubCategory;
    sort?: HubSort;
  }): Promise<HubSearchResponse> {
    const query = opts.query.trim();
    const category: HubCategory = opts.category || 'all';
    const sort: HubSort = opts.sort || 'seeders';
    const settings = this.db.getSettings();
    const storageLimitBytes = Math.round(settings.storageLimitGb * 1024 * 1024 * 1024);

    const tasks: Array<{ label: string; promise: Promise<HubSearchResult[]> }> = [];
    const hasProwlarr = Boolean(settings.prowlarrUrl.trim() && settings.prowlarrApiKey.trim());
    let prowlarrIndexersPromise: Promise<ProwlarrTestResult> | null = null;

    if (hasProwlarr) {
      prowlarrIndexersPromise = this.testProwlarrConnection(
        settings.prowlarrUrl.trim(),
        settings.prowlarrApiKey.trim()
      );
      tasks.push({
        label: 'Prowlarr',
        promise: this.searchProwlarr(
          settings.prowlarrUrl.trim(),
          settings.prowlarrApiKey.trim(),
          query,
          category,
          storageLimitBytes
        ),
      });
    }

    const torznabList = this.db.listTorznabIndexers().filter((i) => i.enabled);
    for (const idx of torznabList) {
      tasks.push({
        label: idx.name,
        promise: this.searchTorznabIndexer(idx, query, category, storageLimitBytes),
      });
    }

    if (tasks.length === 0) {
      return {
        query,
        category,
        results: [],
        sourcesQueried: 0,
        indexerBreakdown: [],
        errors: ['尚未配置任何搜索索引源，请先在「索引源接入」中配置 Prowlarr 或 Torznab 源'],
        storageLimitBytes,
      };
    }

    const [settled, prowlarrMeta] = await Promise.all([
      Promise.allSettled(tasks.map((t) => t.promise)),
      prowlarrIndexersPromise ? prowlarrIndexersPromise.catch(() => null) : Promise.resolve(null),
    ]);
    const errors: string[] = [];
    const dedup = new Map<string, HubSearchResult>();

    settled.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        errors.push(`${tasks[i].label}: ${msg}`);
        return;
      }
      for (const item of outcome.value) {
        const dedupKey = item.infoHash
          ? `hash:${item.infoHash}`
          : `title:${item.title.toLowerCase()}:${item.sizeBytes}`;
        const existing = dedup.get(dedupKey);
        // Prefer downloadable result first, then higher seeders
        const itemDownloadable = Boolean(item.magnetUrl || item.downloadUrl);
        const existingDownloadable = existing ? Boolean(existing.magnetUrl || existing.downloadUrl) : false;
        if (
          !existing ||
          (itemDownloadable && !existingDownloadable) ||
          (itemDownloadable === existingDownloadable && item.seeders > existing.seeders)
        ) {
          dedup.set(dedupKey, item);
        }
      }
    });

    const results = Array.from(dedup.values());
    results.sort((a, b) => {
      if (sort === 'date') return b.publishTimestamp - a.publishTimestamp || b.seeders - a.seeders;
      if (sort === 'size_asc') return a.sizeBytes - b.sizeBytes || b.seeders - a.seeders;
      if (sort === 'size_desc') return b.sizeBytes - a.sizeBytes || b.seeders - a.seeders;
      return b.seeders - a.seeders || b.publishTimestamp - a.publishTimestamp;
    });

    // Build real per-indexer hit count breakdown
    const breakdownMap = new Map<string, number>();
    if (prowlarrMeta?.ok) {
      for (const idx of prowlarrMeta.enabledIndexers) {
        if (idx.protocol.toLowerCase() !== 'usenet') {
          breakdownMap.set(idx.name, 0);
        }
      }
    }
    for (const idx of torznabList) {
      if (!breakdownMap.has(idx.name)) breakdownMap.set(idx.name, 0);
    }
    for (const r of results) {
      breakdownMap.set(r.indexer, (breakdownMap.get(r.indexer) || 0) + 1);
    }

    const indexerBreakdown = Array.from(breakdownMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const realSourceCount =
      (prowlarrMeta?.ok
        ? prowlarrMeta.enabledIndexers.filter((i) => i.protocol.toLowerCase() !== 'usenet').length
        : hasProwlarr
          ? 1
          : 0) + torznabList.length;

    return {
      query,
      category,
      results: results.slice(0, 120),
      sourcesQueried: Math.max(realSourceCount, indexerBreakdown.length),
      indexerBreakdown,
      errors,
      storageLimitBytes,
    };
  }

  private async fetchTorrentPayload(
    downloadUrl: string
  ): Promise<{ kind: 'magnet'; magnet: string } | { kind: 'file'; buffer: Buffer; filename: string }> {
    const settings = this.db.getSettings();
    let prowlarrOrigin = '';
    try {
      if (settings.prowlarrUrl) prowlarrOrigin = new URL(settings.prowlarrUrl).origin;
    } catch {
      // ignore invalid saved url
    }

    let currentUrl = downloadUrl.trim();
    for (let hop = 0; hop < 6; hop++) {
      if (/^magnet:/i.test(currentUrl)) {
        return { kind: 'magnet', magnet: currentUrl };
      }

      const parsed = new URL(currentUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`不支持的下载协议: ${parsed.protocol}`);
      }

      const headers: Record<string, string> = {
        'User-Agent': 'CloudVideo/2.1',
      };
      if (prowlarrOrigin && parsed.origin === prowlarrOrigin && settings.prowlarrApiKey.trim()) {
        headers['X-Api-Key'] = settings.prowlarrApiKey.trim();
      }

      const res = await fetch(currentUrl, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`重定向缺少 Location 头 (HTTP ${res.status})`);
        if (/^magnet:/i.test(loc.trim())) {
          return { kind: 'magnet', magnet: loc.trim() };
        }
        currentUrl = new URL(loc, currentUrl).toString();
        continue;
      }

      if (!res.ok) {
        throw new Error(`下载种子文件失败 (HTTP ${res.status})`);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) {
        throw new Error('下载到的种子文件为空');
      }

      const headText = buf.subarray(0, 128).toString('utf8').trim();
      if (/^magnet:/i.test(headText)) {
        return { kind: 'magnet', magnet: buf.toString('utf8').trim() };
      }

      const disp = res.headers.get('content-disposition') || '';
      const fnMatch = disp.match(/filename\*?=(?:UTF-8''|"?)([^";\r\n"]+)/i);
      let filename = fnMatch ? decodeURIComponent(fnMatch[1].replace(/"/g, '')) : 'hub-download.torrent';
      if (!filename.toLowerCase().endsWith('.torrent')) filename += '.torrent';
      return { kind: 'file', buffer: buf, filename };
    }

    throw new Error('下载种子时重定向次数过多');
  }

  async pushDownloadToQbit(input: {
    magnetUrl?: string;
    downloadUrl?: string;
    title?: string;
    sequential?: boolean;
    bingeMode?: boolean;
    bingeWindow?: number;
  }): Promise<{ ok: true; method: 'magnet' | 'torrent_file'; warning?: string }> {
    const magnetCandidate = (input.magnetUrl || '').trim();
    const urlCandidate = (input.downloadUrl || '').trim();

    if (!magnetCandidate && !urlCandidate) {
      throw new Error('缺少可用的磁力链接或种子下载地址');
    }

    const storageBefore = await this.cleanup.getStorageStats();
    let warning: string | undefined;
    if (storageBefore.usedBytes >= storageBefore.limitBytes) {
      const res = await this.cleanup.runCleanupCycle();
      if (res.storageAfter.usedBytes >= res.storageAfter.limitBytes) {
        warning = '当前存储已接近或达到设定上限，建议先清理空间或开启「追剧托管」。';
      }
    }

    const settings = this.db.getSettings();
    const sequential = input.sequential !== false;
    const bingeMode = Boolean(input.bingeMode);
    const bingeWindow = input.bingeWindow ?? settings.bingePreloadCount;

    const beforeHashes = bingeMode
      ? new Set((await this.qbit.listTorrents().catch(() => [])).map((t) => t.hash))
      : null;

    let method: 'magnet' | 'torrent_file';
    let directHash: string | null = null;

    if (magnetCandidate && /^magnet:/i.test(magnetCandidate)) {
      await this.qbit.addMagnet(magnetCandidate, {
        sequential,
        firstLastPiecePrio: true,
        paused: false,
      });
      method = 'magnet';
      directHash = extractHexHashFromMagnet(magnetCandidate);
    } else if (/^magnet:/i.test(urlCandidate)) {
      await this.qbit.addMagnet(urlCandidate, {
        sequential,
        firstLastPiecePrio: true,
        paused: false,
      });
      method = 'magnet';
      directHash = extractHexHashFromMagnet(urlCandidate);
    } else {
      const payload = await this.fetchTorrentPayload(urlCandidate);
      if (payload.kind === 'magnet') {
        await this.qbit.addMagnet(payload.magnet, {
          sequential,
          firstLastPiecePrio: true,
          paused: false,
        });
        method = 'magnet';
        directHash = extractHexHashFromMagnet(payload.magnet);
      } else {
        const safeName = (input.title || payload.filename)
          .replace(/[\\/:*?"<>|]+/g, '_')
          .slice(0, 80);
        await this.qbit.addTorrentFile(
          payload.buffer,
          safeName.endsWith('.torrent') ? safeName : `${safeName}.torrent`,
          {
            sequential,
            firstLastPiecePrio: true,
            paused: bingeMode,
          }
        );
        method = 'torrent_file';
      }
    }

    if (bingeMode) {
      if (directHash) {
        this.db.upsertTorrentPolicy({
          torrentHash: directHash,
          bingeMode: true,
          bingeWindow,
          initialized: false,
        });
        await this.cleanup.reconcileBingeTorrents(directHash).catch(() => {});
      } else if (beforeHashes) {
        await new Promise((r) => setTimeout(r, 300));
        const after = await this.qbit.listTorrents().catch(() => []);
        for (const t of after) {
          if (!beforeHashes.has(t.hash)) {
            this.db.upsertTorrentPolicy({
              torrentHash: t.hash,
              bingeMode: true,
              bingeWindow,
              initialized: false,
            });
            await this.cleanup.reconcileBingeTorrents(t.hash).catch(() => {});
          }
        }
      }
    }

    return { ok: true, method, warning };
  }
}
