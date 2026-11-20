import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDatabase } from '../db.js';
import type { IQBittorrentClient } from '../services/qbittorrent.js';
import type { CleanupService } from '../services/cleanup.js';

const updateSettingsSchema = z.object({
  storageLimitGb: z.number().min(1).max(10000).optional(),
  autoDeleteDelayHours: z.number().min(0).max(720).optional(),
  watchedThreshold: z.number().min(0.5).max(0.99).optional(),
  uploadLimitKbps: z.number().min(0).max(1_000_000).optional(),
  autoCleanupEnabled: z.boolean().optional(),
  stopSeedingOnComplete: z.boolean().optional(),
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
    requireAuth: (req: any, reply: any) => Promise<any>;
  }
): Promise<void> {
  const { db, qbit, cleanup, requireAuth } = deps;

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
      await qbit.applyPreferences(updated.uploadLimitKbps, updated.stopSeedingOnComplete);
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
}
