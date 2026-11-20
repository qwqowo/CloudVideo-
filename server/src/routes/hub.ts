import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDatabase } from '../db.js';
import type { HubCategory, HubService, HubSort } from '../services/hub.js';
import { validateRegexPattern, type RssService } from '../services/rss.js';

const prowlarrConfigSchema = z.object({
  prowlarrUrl: z.string().url().or(z.literal('')),
  prowlarrApiKey: z.string().max(256),
});

const prowlarrTestSchema = z.object({
  prowlarrUrl: z.string().optional(),
  prowlarrApiKey: z.string().optional(),
});

const torznabCreateSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url(),
  apiKey: z.string().max(256).optional().default(''),
  enabled: z.boolean().optional().default(true),
});

const torznabUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  url: z.string().url().optional(),
  apiKey: z.string().max(256).optional(),
  enabled: z.boolean().optional(),
});

const hubDownloadSchema = z.object({
  magnetUrl: z.string().optional().default(''),
  downloadUrl: z.string().optional().default(''),
  title: z.string().max(300).optional().default(''),
  sequential: z.boolean().optional().default(true),
  bingeMode: z.boolean().optional().default(false),
  bingeWindow: z.number().int().min(1).max(10).optional(),
});

const rssCreateSchema = z.object({
  name: z.string().min(1).max(100),
  feedUrl: z.string().url(),
  includeRegex: z.string().max(300).optional().default(''),
  excludeRegex: z.string().max(300).optional().default(''),
  minSizeMb: z.number().int().min(0).max(500000).optional().default(0),
  maxSizeMb: z.number().int().min(0).max(500000).optional().default(0),
  intervalMin: z.number().int().min(5).max(1440).optional().default(30),
  sequential: z.boolean().optional().default(true),
  bingeMode: z.boolean().optional().default(false),
  enabled: z.boolean().optional().default(true),
});

const rssUpdateSchema = rssCreateSchema.partial();

const rssPreviewSchema = z.object({
  feedUrl: z.string().url(),
  includeRegex: z.string().max(300).optional().default(''),
  excludeRegex: z.string().max(300).optional().default(''),
  minSizeMb: z.number().int().min(0).max(500000).optional().default(0),
  maxSizeMb: z.number().int().min(0).max(500000).optional().default(0),
  subscriptionId: z.number().int().positive().optional(),
});

export async function registerHubRoutes(
  app: FastifyInstance,
  deps: {
    db: AppDatabase;
    hub: HubService;
    rss: RssService;
    requireAuth: (req: any, reply: any) => Promise<any>;
  }
): Promise<void> {
  const { db, hub, rss, requireAuth } = deps;

  // ---- Indexer & Prowlarr Configuration ----
  app.get('/api/hub/config', { preHandler: requireAuth }, async () => {
    const settings = db.getSettings();
    return {
      prowlarrUrl: settings.prowlarrUrl,
      prowlarrApiKey: settings.prowlarrApiKey,
      prowlarrConfigured: Boolean(settings.prowlarrUrl.trim() && settings.prowlarrApiKey.trim()),
      torznabIndexers: db.listTorznabIndexers(),
      storageLimitGb: settings.storageLimitGb,
    };
  });

  app.put('/api/hub/prowlarr', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = prowlarrConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Prowlarr 地址或 API Key 格式无效' });
    }
    const next = db.updateSettings({
      prowlarrUrl: parsed.data.prowlarrUrl.trim().replace(/\/+$/, ''),
      prowlarrApiKey: parsed.data.prowlarrApiKey.trim(),
    });
    return {
      ok: true,
      prowlarrUrl: next.prowlarrUrl,
      prowlarrApiKey: next.prowlarrApiKey,
      prowlarrConfigured: Boolean(next.prowlarrUrl && next.prowlarrApiKey),
    };
  });

  app.post('/api/hub/prowlarr/test', { preHandler: requireAuth }, async (req) => {
    const parsed = prowlarrTestSchema.safeParse(req.body ?? {});
    const data = parsed.success ? parsed.data : {};
    return hub.testProwlarrConnection(data.prowlarrUrl, data.prowlarrApiKey);
  });

  app.post('/api/hub/indexers', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = torznabCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '请填写有效的 Torznab 名称与 URL' });
    }
    const indexer = db.createTorznabIndexer(parsed.data);
    return { ok: true, indexer };
  });

  app.put('/api/hub/indexers/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = torznabUpdateSchema.safeParse(req.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '参数无效' });
    }
    const updated = db.updateTorznabIndexer(id, parsed.data);
    if (!updated) {
      return reply.code(404).send({ error: 'Not Found', message: '索引源不存在' });
    }
    return { ok: true, indexer: updated };
  });

  app.delete('/api/hub/indexers/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'Bad Request', message: '无效 ID' });
    }
    db.deleteTorznabIndexer(id);
    return { ok: true };
  });

  // ---- Aggregated Torrent Search & One-Click Push ----
  app.get('/api/hub/search', { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as { q?: string; category?: string; sort?: string };
    const query = (q.q || '').trim();
    if (!query) {
      return reply.code(400).send({ error: 'Bad Request', message: '请输入要搜索的片名或关键词' });
    }
    const allowedCats: HubCategory[] = ['all', 'movies', 'tv', 'anime'];
    const allowedSorts: HubSort[] = ['seeders', 'date', 'size_asc', 'size_desc'];
    const category = allowedCats.includes(q.category as HubCategory)
      ? (q.category as HubCategory)
      : 'all';
    const sort = allowedSorts.includes(q.sort as HubSort) ? (q.sort as HubSort) : 'seeders';

    return hub.search({ query, category, sort });
  });

  app.post('/api/hub/download', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = hubDownloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '下载参数无效' });
    }
    try {
      return await hub.pushDownloadToQbit(parsed.data);
    } catch (err) {
      return reply.code(502).send({
        error: 'HubDownloadError',
        message: err instanceof Error ? err.message : '推送下载失败',
      });
    }
  });

  // ---- Built-in RSS / Atom Auto-Subscriptions ----
  app.get('/api/rss/subscriptions', { preHandler: requireAuth }, async () => {
    return { subscriptions: db.listRssSubscriptions() };
  });

  app.post('/api/rss/subscriptions', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = rssCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '订阅规则参数无效，请检查 RSS 地址' });
    }
    const incErr = validateRegexPattern(parsed.data.includeRegex);
    if (incErr) {
      return reply.code(400).send({ error: 'InvalidRegex', message: `包含正则语法错误: ${incErr}` });
    }
    const excErr = validateRegexPattern(parsed.data.excludeRegex);
    if (excErr) {
      return reply.code(400).send({ error: 'InvalidRegex', message: `排除正则语法错误: ${excErr}` });
    }
    const sub = db.createRssSubscription(parsed.data);
    return { ok: true, subscription: sub };
  });

  app.put('/api/rss/subscriptions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = rssUpdateSchema.safeParse(req.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '订阅规则参数无效' });
    }
    if (parsed.data.includeRegex !== undefined) {
      const incErr = validateRegexPattern(parsed.data.includeRegex);
      if (incErr) {
        return reply.code(400).send({ error: 'InvalidRegex', message: `包含正则语法错误: ${incErr}` });
      }
    }
    if (parsed.data.excludeRegex !== undefined) {
      const excErr = validateRegexPattern(parsed.data.excludeRegex);
      if (excErr) {
        return reply.code(400).send({ error: 'InvalidRegex', message: `排除正则语法错误: ${excErr}` });
      }
    }
    const updated = db.updateRssSubscription(id, parsed.data);
    if (!updated) {
      return reply.code(404).send({ error: 'Not Found', message: '订阅规则不存在' });
    }
    return { ok: true, subscription: updated };
  });

  app.delete('/api/rss/subscriptions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'Bad Request', message: '无效 ID' });
    }
    db.deleteRssSubscription(id);
    return { ok: true };
  });

  app.post('/api/rss/preview', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = rssPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '请输入有效的 RSS Feed 地址' });
    }
    const incErr = validateRegexPattern(parsed.data.includeRegex);
    if (incErr) {
      return reply.code(400).send({ error: 'InvalidRegex', message: `包含正则语法错误: ${incErr}` });
    }
    const excErr = validateRegexPattern(parsed.data.excludeRegex);
    if (excErr) {
      return reply.code(400).send({ error: 'InvalidRegex', message: `排除正则语法错误: ${excErr}` });
    }
    try {
      return await rss.previewFeed(parsed.data);
    } catch (err) {
      return reply.code(502).send({
        error: 'RssFetchError',
        message: err instanceof Error ? err.message : '拉取 RSS 订阅源失败',
      });
    }
  });

  app.post('/api/rss/subscriptions/:id/run', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'Bad Request', message: '无效 ID' });
    }
    const sub = db.getRssSubscription(id);
    if (!sub) {
      return reply.code(404).send({ error: 'Not Found', message: '订阅规则不存在' });
    }
    const summary = await rss.runSubscription(sub);
    return { ok: true, summary, subscription: db.getRssSubscription(id) };
  });

  app.get('/api/rss/subscriptions/:id/history', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'Bad Request', message: '无效 ID' });
    }
    return { items: db.listRssSeenItems(id, 80) };
  });
}
