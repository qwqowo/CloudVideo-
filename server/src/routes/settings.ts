import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDatabase } from '../db.js';
import type { IQBittorrentClient } from '../services/qbittorrent.js';
import type { CleanupService } from '../services/cleanup.js';
import { syncTrackersToQbit, type NotifierService } from '../services/notifier.js';

const updateSettingsSchema = z.object({
  storageLimitGb: z.number().min(1).max(10000).optional(),
  autoDeleteDelayHours: z.number().min(0).max(720).optional(),
  watchedThreshold: z.number().min(0.5).max(0.99).optional(),
  uploadLimitKbps: z.number().min(0).max(1_000_000).optional(),
  autoCleanupEnabled: z.boolean().optional(),
  stopSeedingOnComplete: z.boolean().optional(),
  bingePreloadCount: z.number().int().min(1).max(10).optional(),
  tmdbApiKey: z.string().max(500).optional(),
  proxyEnabled: z.boolean().optional(),
  proxyType: z.enum(['none', 'http', 'socks5']).optional(),
  proxyHost: z.string().max(255).optional(),
  proxyPort: z.number().int().min(1).max(65535).optional(),
  proxyUsername: z.string().max(128).optional(),
  proxyPassword: z.string().max(128).optional(),
  telegramBotToken: z.string().max(200).optional(),
  telegramChatId: z.string().max(100).optional(),
  webhookUrl: z.string().max(500).optional(),
});

const runCleanupSchema = z.object({
  forceWatchedNow: z.boolean().optional().default(false),
});

export async function registerSettingsRoutes(
  app: FastifyInstance,
  deps: {
    db: AppDatabase;
    qbit: IQBittorrentClient;
    cleanup: CleanupService;
    notifier: NotifierService;
    requireAuth: (req: any, reply: any) => Promise<any>;
  }
): Promise<void> {
  const { db, qbit, cleanup, notifier, requireAuth } = deps;

  app.get('/api/settings', { preHandler: requireAuth }, async () => {
    const [storage, qbitHealth] = await Promise.all([
      cleanup.getStorageStats(),
      qbit.checkHealth(),
    ]);
    return {
      settings: db.getSettings(),
      storage,
      qbit: qbitHealth,
    };
  });

  app.put('/api/settings', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '设置参数无效' });
    }
    const updated = db.updateSettings(parsed.data);

    let qbitSynced = false;
    try {
      await qbit.applyFullPreferences({
        uploadLimitKbps: updated.uploadLimitKbps,
        stopOnComplete: updated.stopSeedingOnComplete,
        proxyEnabled: updated.proxyEnabled,
        proxyType: updated.proxyType,
        proxyHost: updated.proxyHost,
        proxyPort: updated.proxyPort,
        proxyUsername: updated.proxyUsername,
        proxyPassword: updated.proxyPassword,
      });
      qbitSynced = true;
    } catch {
      // qBittorrent may be temporarily offline
    }

    const storage = await cleanup.getStorageStats();
    return { ok: true, settings: updated, storage, qbitSynced };
  });

  app.post('/api/cleanup/run', { preHandler: requireAuth }, async (req) => {
    const parsed = runCleanupSchema.safeParse(req.body ?? {});
    const forceWatchedNow = parsed.success ? parsed.data.forceWatchedNow : false;
    const result = await cleanup.runCleanupCycle({ forceWatchedNow });
    return { ok: true, ...result };
  });

  app.get('/api/cleanup/logs', { preHandler: requireAuth }, async () => {
    return { logs: db.listCleanupLogs(60) };
  });

  app.post('/api/trackers/sync', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const res = await syncTrackersToQbit(db, qbit);
      return { ok: true, ...res };
    } catch (err) {
      return reply.code(502).send({
        error: 'TrackerSyncError',
        message: err instanceof Error ? err.message : '注入公共 Tracker 失败',
      });
    }
  });

  app.post('/api/notifications/test', { preHandler: requireAuth }, async () => {
    const res = await notifier.send({
      event: 'test',
      title: 'CloudVideo 通知链路测试',
      message: 'Telegram / Webhook 通知已连通，后续离线下载完成后将自动推送提醒。',
    });
    return { ok: res.telegramSent || res.webhookSent, ...res };
  });
}
