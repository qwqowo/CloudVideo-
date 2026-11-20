import crypto from 'node:crypto';
import type { AppDatabase, RssSubscriptionRecord } from '../db.js';
import type { NotifierService } from './notifier.js';
import {
  decodeXmlEntities,
  extractTagValue,
  parseHumanSizeToBytes,
  parseXmlAttributes,
  type HubService,
} from './hub.js';

export interface ParsedFeedItem {
  guid: string;
  title: string;
  downloadUrl: string;
  magnetUrl: string;
  sizeBytes: number;
  publishDate: string;
  publishTimestamp: number;
}

export interface RssRuleSpec {
  includeRegex: string;
  excludeRegex: string;
  minSizeMb: number;
  maxSizeMb: number;
}

export interface RssPreviewItem extends ParsedFeedItem {
  matched: boolean;
  reason: string;
  alreadySeen: boolean;
}

export interface RssRunSummary {
  subscriptionId: number;
  fetchedCount: number;
  matchedCount: number;
  pushedCount: number;
  skippedCount: number;
  errors: string[];
}

export function parseFeedXml(xml: string): ParsedFeedItem[] {
  const items: ParsedFeedItem[] = [];

  // 1) RSS 2.0 <item> blocks
  const rssRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = rssRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTagValue(block, 'title');
    if (!title) continue;

    const rawGuid = extractTagValue(block, 'guid');
    const link = extractTagValue(block, 'link');
    const pubDate = extractTagValue(block, 'pubDate') || extractTagValue(block, 'dc:date');

    let enclosureUrl = '';
    let enclosureLen = 0;
    const encRe = /<enclosure\b([^>]*)\/?>/gi;
    let encM: RegExpExecArray | null;
    while ((encM = encRe.exec(block)) !== null) {
      const attrs = parseXmlAttributes(encM[1]);
      if (attrs.url && (!enclosureUrl || attrs.type?.includes('bittorrent') || attrs.url.includes('.torrent'))) {
        enclosureUrl = attrs.url;
        enclosureLen = Number(attrs.length || 0) || 0;
      }
    }

    let torznabMagnet = '';
    let torznabSize = 0;
    const attrRe = /<(?:torznab|newznab):attr\b([^>]*)\/?>/gi;
    let attrM: RegExpExecArray | null;
    while ((attrM = attrRe.exec(block)) !== null) {
      const attrs = parseXmlAttributes(attrM[1]);
      if (attrs.name?.toLowerCase() === 'magneturl') torznabMagnet = attrs.value || '';
      if (attrs.name?.toLowerCase() === 'size') torznabSize = Number(attrs.value || 0) || 0;
    }

    const magnetTag = extractTagValue(block, 'magnetURI') || extractTagValue(block, 'magnet');
    const contentLength = extractTagValue(block, 'contentLength');
    const nyaaSize = extractTagValue(block, 'nyaa:size');
    const plainSize = extractTagValue(block, 'size');

    let magnetUrl = torznabMagnet || magnetTag;
    if (!magnetUrl && link.startsWith('magnet:')) magnetUrl = link;
    if (!magnetUrl && enclosureUrl.startsWith('magnet:')) magnetUrl = enclosureUrl;

    let downloadUrl = '';
    if (enclosureUrl && !enclosureUrl.startsWith('magnet:')) {
      downloadUrl = enclosureUrl;
    } else if (link && !link.startsWith('magnet:')) {
      downloadUrl = link;
    }

    const sizeBytes =
      torznabSize ||
      parseHumanSizeToBytes(contentLength) ||
      enclosureLen ||
      parseHumanSizeToBytes(nyaaSize) ||
      parseHumanSizeToBytes(plainSize);

    const guid =
      rawGuid ||
      crypto
        .createHash('sha1')
        .update(`${title}|${magnetUrl || downloadUrl}`)
        .digest('hex');

    const ts = pubDate ? Date.parse(pubDate) : 0;
    items.push({
      guid,
      title,
      downloadUrl,
      magnetUrl,
      sizeBytes,
      publishDate: pubDate,
      publishTimestamp: Number.isFinite(ts) ? ts : 0,
    });
  }

  if (items.length > 0) return items;

  // 2) Atom <entry> blocks
  const atomRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  while ((m = atomRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTagValue(block, 'title');
    if (!title) continue;

    const rawId = extractTagValue(block, 'id');
    const pubDate = extractTagValue(block, 'published') || extractTagValue(block, 'updated');

    let downloadUrl = '';
    let magnetUrl = '';
    let enclosureLen = 0;

    const linkRe = /<link\b([^>]*)\/?>/gi;
    let lM: RegExpExecArray | null;
    while ((lM = linkRe.exec(block)) !== null) {
      const attrs = parseXmlAttributes(lM[1]);
      const href = attrs.href || '';
      if (!href) continue;
      if (href.startsWith('magnet:')) {
        magnetUrl = href;
      } else if (attrs.rel === 'enclosure' || attrs.type?.includes('bittorrent') || href.endsWith('.torrent')) {
        downloadUrl = href;
        enclosureLen = Number(attrs.length || 0) || enclosureLen;
      } else if (!downloadUrl) {
        downloadUrl = href;
      }
    }

    const sizeBytes =
      enclosureLen ||
      parseHumanSizeToBytes(extractTagValue(block, 'contentLength')) ||
      parseHumanSizeToBytes(extractTagValue(block, 'size'));

    const guid =
      rawId ||
      crypto
        .createHash('sha1')
        .update(`${title}|${magnetUrl || downloadUrl}`)
        .digest('hex');

    const ts = pubDate ? Date.parse(pubDate) : 0;
    items.push({
      guid: decodeXmlEntities(guid),
      title,
      downloadUrl,
      magnetUrl,
      sizeBytes,
      publishDate: pubDate,
      publishTimestamp: Number.isFinite(ts) ? ts : 0,
    });
  }

  return items;
}

export function validateRegexPattern(pattern: string): string | null {
  if (!pattern.trim()) return null;
  try {
    new RegExp(pattern, 'i');
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : '正则表达式语法错误';
  }
}

export function evaluateRssRule(
  item: ParsedFeedItem,
  rule: RssRuleSpec
): { matched: boolean; reason: string } {
  if (!item.magnetUrl && !item.downloadUrl) {
    return { matched: false, reason: '缺少下载链接' };
  }

  if (rule.includeRegex.trim()) {
    try {
      const inc = new RegExp(rule.includeRegex.trim(), 'i');
      if (!inc.test(item.title)) {
        return { matched: false, reason: '未命中包含正则' };
      }
    } catch {
      return { matched: false, reason: '包含正则无效' };
    }
  }

  if (rule.excludeRegex.trim()) {
    try {
      const exc = new RegExp(rule.excludeRegex.trim(), 'i');
      if (exc.test(item.title)) {
        return { matched: false, reason: '命中排除正则' };
      }
    } catch {
      return { matched: false, reason: '排除正则无效' };
    }
  }

  if (rule.minSizeMb > 0 && item.sizeBytes > 0) {
    const minBytes = rule.minSizeMb * 1024 * 1024;
    if (item.sizeBytes < minBytes) {
      return { matched: false, reason: `小于最小体积 (${rule.minSizeMb} MB)` };
    }
  }

  if (rule.maxSizeMb > 0 && item.sizeBytes > 0) {
    const maxBytes = rule.maxSizeMb * 1024 * 1024;
    if (item.sizeBytes > maxBytes) {
      return { matched: false, reason: `超出最大体积 (${rule.maxSizeMb} MB)` };
    }
  }

  return { matched: true, reason: '命中订阅规则' };
}

export class RssService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private db: AppDatabase,
    private hub: HubService,
    private notifier: NotifierService
  ) {}

  startScheduler(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runDueSubscriptions();
    }, intervalMs);
    this.timer.unref();
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async fetchFeed(feedUrl: string): Promise<ParsedFeedItem[]> {
    const parsed = new URL(feedUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('仅支持 http:// 或 https:// 订阅源');
    }

    const res = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'CloudVideo-RSS/2.1',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`拉取 RSS 失败 (HTTP ${res.status})`);
    }
    const xml = await res.text();
    return parseFeedXml(xml);
  }

  async previewFeed(input: {
    feedUrl: string;
    includeRegex?: string;
    excludeRegex?: string;
    minSizeMb?: number;
    maxSizeMb?: number;
    subscriptionId?: number;
  }): Promise<{ total: number; matchedCount: number; items: RssPreviewItem[] }> {
    const items = await this.fetchFeed(input.feedUrl);
    const rule: RssRuleSpec = {
      includeRegex: input.includeRegex || '',
      excludeRegex: input.excludeRegex || '',
      minSizeMb: input.minSizeMb || 0,
      maxSizeMb: input.maxSizeMb || 0,
    };

    const evaluated: RssPreviewItem[] = items.slice(0, 80).map((item) => {
      const verdict = evaluateRssRule(item, rule);
      const alreadySeen = input.subscriptionId
        ? this.db.hasRssSeenItem(input.subscriptionId, item.guid)
        : false;
      return {
        ...item,
        matched: verdict.matched,
        reason: verdict.reason,
        alreadySeen,
      };
    });

    return {
      total: evaluated.length,
      matchedCount: evaluated.filter((i) => i.matched).length,
      items: evaluated,
    };
  }

  async runSubscription(
    subOrId: number | RssSubscriptionRecord,
    opts: { maxPushPerTick?: number } = {}
  ): Promise<RssRunSummary> {
    const sub = typeof subOrId === 'number' ? this.db.getRssSubscription(subOrId) : subOrId;
    if (!sub) {
      throw new Error('订阅规则不存在');
    }

    const now = Date.now();
    const maxPush = opts.maxPushPerTick ?? 5;
    const summary: RssRunSummary = {
      subscriptionId: sub.id,
      fetchedCount: 0,
      matchedCount: 0,
      pushedCount: 0,
      skippedCount: 0,
      errors: [],
    };

    try {
      const items = await this.fetchFeed(sub.feedUrl);
      summary.fetchedCount = items.length;

      const rule: RssRuleSpec = {
        includeRegex: sub.includeRegex,
        excludeRegex: sub.excludeRegex,
        minSizeMb: sub.minSizeMb,
        maxSizeMb: sub.maxSizeMb,
      };

      const pushedTitles: string[] = [];

      for (const item of items.slice(0, 60)) {
        if (this.db.hasRssSeenItem(sub.id, item.guid)) {
          summary.skippedCount++;
          continue;
        }

        const verdict = evaluateRssRule(item, rule);
        if (!verdict.matched) {
          this.db.addRssSeenItem({
            subscriptionId: sub.id,
            itemGuid: item.guid,
            title: item.title,
            downloadUrl: item.magnetUrl || item.downloadUrl,
            sizeBytes: item.sizeBytes,
            matched: false,
            pushed: false,
            reason: verdict.reason,
            seenAt: now,
          });
          summary.skippedCount++;
          continue;
        }

        summary.matchedCount++;
        if (summary.pushedCount >= maxPush) {
          // Leave remaining matched items unseen so next cycle can pick them up without disk flood
          continue;
        }

        try {
          await this.hub.pushDownloadToQbit({
            magnetUrl: item.magnetUrl,
            downloadUrl: item.downloadUrl,
            title: item.title,
            sequential: sub.sequential,
            bingeMode: sub.bingeMode,
          });
          summary.pushedCount++;
          pushedTitles.push(item.title);
          this.db.addRssSeenItem({
            subscriptionId: sub.id,
            itemGuid: item.guid,
            title: item.title,
            downloadUrl: item.magnetUrl || item.downloadUrl,
            sizeBytes: item.sizeBytes,
            matched: true,
            pushed: true,
            reason: '自动推送下载',
            seenAt: now,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          summary.errors.push(`${item.title}: ${msg}`);
        }
      }

      this.db.recordRssCheckResult(
        sub.id,
        now,
        summary.errors.join('; '),
        summary.pushedCount
      );

      if (pushedTitles.length > 0) {
        void this.notifier.send({
          event: 'rss_matched',
          title: `RSS 订阅自动推送 (${sub.name})`,
          message: pushedTitles.map((t) => `• ${t}`).join('\n'),
          torrentName: pushedTitles[0],
        });
      }

      return summary;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.db.recordRssCheckResult(sub.id, now, errMsg, 0);
      summary.errors.push(errMsg);
      return summary;
    }
  }

  async runDueSubscriptions(now = Date.now()): Promise<RssRunSummary[]> {
    if (this.running) return [];
    this.running = true;
    const results: RssRunSummary[] = [];
    try {
      const subs = this.db.listRssSubscriptions().filter((s) => s.enabled);
      for (const sub of subs) {
        const due =
          sub.lastCheckedAt === null || now - sub.lastCheckedAt >= sub.intervalMin * 60_000;
        if (due) {
          const res = await this.runSubscription(sub);
          results.push(res);
        }
      }
    } finally {
      this.running = false;
    }
    return results;
  }
}
