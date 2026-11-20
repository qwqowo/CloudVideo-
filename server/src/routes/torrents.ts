import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db.js';
import type { IQBittorrentClient } from '../services/qbittorrent.js';
import type { CleanupService } from '../services/cleanup.js';
import { isVideoFile, resolveSafePath } from '../services/media.js';

const addMagnetSchema = z.object({
  magnet: z.string().min(8),
  sequential: z.boolean().optional().default(true),
  firstLastPiecePrio: z.boolean().optional().default(true),
  paused: z.boolean().optional().default(false),
});

const prioritySchema = z.object({
  fileIndices: z.array(z.number().int().min(0)).min(1),
  priority: z.union([z.literal(0), z.literal(1), z.literal(6), z.literal(7)]),
});

const progressSchema = z.object({
  torrentHash: z.string().min(8),
  fileIndex: z.number().int().min(0),
  positionSec: z.number().min(0),
  durationSec: z.number().min(0),
  relativePath: z.string().optional(),
  sizeBytes: z.number().min(0).optional(),
});

const markWatchedSchema = z.object({
  immediate: z.boolean().optional().default(false),
  relativePath: z.string().optional(),
  sizeBytes: z.number().min(0).optional(),
});

const pinSchema = z.object({
  pinned: z.boolean(),
  relativePath: z.string().optional(),
  sizeBytes: z.number().min(0).optional(),
});

export async function registerTorrentRoutes(
  app: FastifyInstance,
  deps: {
    config: AppConfig;
    db: AppDatabase;
    qbit: IQBittorrentClient;
    cleanup: CleanupService;
    requireAuth: (req: any, reply: any) => Promise<any>;
  }
): Promise<void> {
  const { config, db, qbit, cleanup, requireAuth } = deps;

  app.get('/api/torrents', { preHandler: requireAuth }, async () => {
    const storage = await cleanup.getStorageStats();
    const qbitHealth = await qbit.checkHealth();

    if (!qbitHealth.connected) {
      return {
        qbitConnected: false,
        qbitError: qbitHealth.error,
        transfer: { dlSpeed: 0, upSpeed: 0 },
        storage,
        torrents: [],
      };
    }

    const [torrents, transfer] = await Promise.all([
      qbit.listTorrents(),
      qbit.getTransferInfo().catch(() => ({
        dl_info_speed: 0,
        up_info_speed: 0,
        dl_info_data: 0,
        up_info_data: 0,
        connection_status: 'unknown',
      })),
    ]);

    const allMedia = db.listMediaItems();
    const byHash = new Map<string, typeof allMedia>();
    for (const item of allMedia) {
      const list = byHash.get(item.torrentHash) || [];
      list.push(item);
      byHash.set(item.torrentHash, list);
    }

    const enriched = await Promise.all(
      torrents.map(async (t) => {
        const items = byHash.get(t.hash) || [];
        const activeScheduled = items
          .filter((i) => !i.removedFile && !i.pinned && i.deleteAfterAt !== null)
          .map((i) => i.deleteAfterAt as number);
        const nextDeleteAt = activeScheduled.length > 0 ? Math.min(...activeScheduled) : null;
        const watchedCount = items.filter((i) => i.watchedAt !== null).length;
        const pinnedCount = items.filter((i) => i.pinned).length;

        let videoCount = 0;
        let playableCount = 0;
        let primaryVideo: {
          index: number;
          name: string;
          size: number;
          progress: number;
          existsOnDisk: boolean;
        } | null = null;

        try {
          const files = await qbit.getTorrentFiles(t.hash);
          const videoFiles = files.filter((f) => isVideoFile(f.name));
          videoCount = videoFiles.length;

          const checked = await Promise.all(
            videoFiles.map(async (f) => {
              let existsOnDisk = false;
              if (f.priority > 0) {
                try {
                  const abs = resolveSafePath(config.downloadDir, f.name);
                  const st = await fs.stat(abs);
                  existsOnDisk = st.isFile() && st.size > 0;
                } catch {
                  existsOnDisk = false;
                }
              }
              return { f, existsOnDisk };
            })
          );

          const playable = checked.filter((c) => c.existsOnDisk);
          playableCount = playable.length;
          // Prefer largest playable video (so movie main feature wins over sample.mp4), else first video
          const best =
            playable.sort((a, b) => b.f.size - a.f.size)[0] ||
            checked.sort((a, b) => b.f.size - a.f.size)[0];

          if (best) {
            primaryVideo = {
              index: best.f.index,
              name: best.f.name,
              size: best.f.size,
              progress: best.f.progress,
              existsOnDisk: best.existsOnDisk,
            };
          }
        } catch {
          // metadata may still be resolving
        }

        const avgWatchProgress =
          items.length > 0
            ? Number((items.reduce((acc, i) => acc + i.progress, 0) / items.length).toFixed(3))
            : 0;

        return {
          hash: t.hash,
          name: t.name,
          size: t.size,
          totalSize: t.total_size ?? t.size,
          downloaded: t.downloaded,
          progress: t.progress,
          dlSpeed: t.dlspeed,
          upSpeed: t.upspeed,
          state: t.state,
          eta: t.eta,
          addedOn: t.added_on * 1000,
          sequential: t.seq_dl,
          firstLastPiecePrio: t.f_l_piece_prio,
          numSeeds: t.num_seeds,
          numLeechs: t.num_leechs,
          nextDeleteAt,
          watchedCount,
          pinnedCount,
          videoCount,
          playableCount,
          primaryVideo,
          watchProgress: avgWatchProgress,
        };
      })
    );

    return {
      qbitConnected: true,
      qbitVersion: qbitHealth.version,
      transfer: {
        dlSpeed: transfer.dl_info_speed,
        upSpeed: transfer.up_info_speed,
      },
      storage,
      torrents: enriched,
    };
  });

  app.get('/api/torrents/:hash/files', { preHandler: requireAuth }, async (req, reply) => {
    const { hash } = req.params as { hash: string };
    try {
      const files = await qbit.getTorrentFiles(hash);
      const mediaList = db.listMediaItems(hash);
      const mediaMap = new Map(mediaList.map((m) => [m.fileIndex, m]));

      const enriched = await Promise.all(
        files.map(async (f) => {
          const rec = mediaMap.get(f.index) ?? null;
          let existsOnDisk = false;
          let diskSize = 0;
          try {
            const abs = resolveSafePath(config.downloadDir, f.name);
            const st = await fs.stat(abs);
            if (st.isFile()) {
              existsOnDisk = true;
              diskSize = st.size;
            }
          } catch {
            // not yet created or already removed
          }

          return {
            index: f.index,
            name: f.name,
            size: f.size,
            diskSize,
            progress: f.progress,
            priority: f.priority,
            isVideo: isVideoFile(f.name),
            existsOnDisk,
            media: rec,
          };
        })
      );

      return { hash: hash.toLowerCase(), files: enriched };
    } catch (err) {
      return reply.code(502).send({
        error: 'QBittorrentError',
        message: err instanceof Error ? err.message : '获取文件列表失败',
      });
    }
  });

  app.post('/api/torrents/magnet', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = addMagnetSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '请输入有效的磁力链接或下载链接' });
    }

    const storageBefore = await cleanup.getStorageStats();
    let warning: string | undefined;
    if (storageBefore.usedBytes >= storageBefore.limitBytes) {
      const res = await cleanup.runCleanupCycle();
      if (res.storageAfter.usedBytes >= res.storageAfter.limitBytes) {
        warning = '当前存储已接近或达到设定上限，建议先手动清理或勾选少量单集下载。';
      }
    }

    try {
      await qbit.addMagnet(parsed.data.magnet, {
        sequential: parsed.data.sequential,
        firstLastPiecePrio: parsed.data.firstLastPiecePrio,
        paused: parsed.data.paused,
      });
      return { ok: true, warning };
    } catch (err) {
      return reply.code(502).send({
        error: 'QBittorrentError',
        message: err instanceof Error ? err.message : '添加磁力链接失败',
      });
    }
  });

  app.post('/api/torrents/upload', { preHandler: requireAuth }, async (req, reply) => {
    const parts = req.parts();
    let fileBuffer: Buffer | null = null;
    let filename = 'upload.torrent';
    let sequential = true;
    let firstLastPiecePrio = true;
    let paused = false;

    for await (const part of parts) {
      if (part.type === 'file') {
        filename = part.filename || filename;
        fileBuffer = await part.toBuffer();
      } else {
        const val = String(part.value);
        if (part.fieldname === 'sequential') sequential = val !== 'false';
        if (part.fieldname === 'firstLastPiecePrio') firstLastPiecePrio = val !== 'false';
        if (part.fieldname === 'paused') paused = val === 'true';
      }
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      return reply.code(400).send({ error: 'Bad Request', message: '请上传 .torrent 种子文件' });
    }

    const storageBefore = await cleanup.getStorageStats();
    let warning: string | undefined;
    if (storageBefore.usedBytes >= storageBefore.limitBytes) {
      const res = await cleanup.runCleanupCycle();
      if (res.storageAfter.usedBytes >= res.storageAfter.limitBytes) {
        warning = '当前存储已接近或达到设定上限，建议先手动清理或勾选少量单集下载。';
      }
    }

    try {
      await qbit.addTorrentFile(fileBuffer, filename, {
        sequential,
        firstLastPiecePrio,
        paused,
      });
      return { ok: true, warning };
    } catch (err) {
      return reply.code(502).send({
        error: 'QBittorrentError',
        message: err instanceof Error ? err.message : '上传种子文件失败',
      });
    }
  });

  app.post('/api/torrents/:hash/files/priority', { preHandler: requireAuth }, async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const parsed = prioritySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '参数错误' });
    }

    try {
      await qbit.setFilePriority(hash, parsed.data.fileIndices, parsed.data.priority);
      if (parsed.data.priority > 0) {
        for (const idx of parsed.data.fileIndices) {
          const existing = db.getMediaItem(hash, idx);
          if (existing?.removedFile) {
            db.upsertMediaItem({
              torrentHash: hash,
              fileIndex: idx,
              removedFile: false,
              deletedAt: null,
            });
          }
        }
      }
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({
        error: 'QBittorrentError',
        message: err instanceof Error ? err.message : '设置文件优先级失败',
      });
    }
  });

  app.post('/api/torrents/:hash/pause', { preHandler: requireAuth }, async (req) => {
    const { hash } = req.params as { hash: string };
    await qbit.pauseTorrents([hash.toLowerCase()]);
    return { ok: true };
  });

  app.post('/api/torrents/:hash/resume', { preHandler: requireAuth }, async (req) => {
    const { hash } = req.params as { hash: string };
    await qbit.resumeTorrents([hash.toLowerCase()]);
    return { ok: true };
  });

  app.post('/api/torrents/:hash/sequential', { preHandler: requireAuth }, async (req) => {
    const { hash } = req.params as { hash: string };
    await qbit.toggleSequential(hash.toLowerCase());
    return { ok: true };
  });

  app.delete('/api/torrents/:hash', { preHandler: requireAuth }, async (req) => {
    const { hash } = req.params as { hash: string };
    const res = await cleanup.unloadTorrent(hash);
    return { ok: true, ...res };
  });

  // Playback progress & auto-uninstall controls
  app.post('/api/media/progress', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = progressSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '进度参数无效' });
    }
    const res = await cleanup.recordProgress(parsed.data);
    return { ok: true, ...res };
  });

  app.post('/api/media/:hash/:fileIndex/watched', { preHandler: requireAuth }, async (req, reply) => {
    const { hash, fileIndex } = req.params as { hash: string; fileIndex: string };
    const idx = Number(fileIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return reply.code(400).send({ error: 'Bad Request', message: '无效的文件索引' });
    }
    const parsed = markWatchedSchema.safeParse(req.body ?? {});
    const opts = parsed.success ? parsed.data : { immediate: false };
    const res = await cleanup.markWatched(hash, idx, opts);
    return { ok: true, ...res };
  });

  app.post('/api/media/:hash/:fileIndex/pin', { preHandler: requireAuth }, async (req, reply) => {
    const { hash, fileIndex } = req.params as { hash: string; fileIndex: string };
    const idx = Number(fileIndex);
    const parsed = pinSchema.safeParse(req.body);
    if (!Number.isInteger(idx) || idx < 0 || !parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '参数无效' });
    }
    const item = cleanup.setPinned(
      hash,
      idx,
      parsed.data.pinned,
      parsed.data.relativePath,
      parsed.data.sizeBytes
    );
    return { ok: true, item };
  });

  app.post('/api/media/:hash/:fileIndex/cancel-delete', { preHandler: requireAuth }, async (req, reply) => {
    const { hash, fileIndex } = req.params as { hash: string; fileIndex: string };
    const idx = Number(fileIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return reply.code(400).send({ error: 'Bad Request', message: '参数无效' });
    }
    const item = cleanup.cancelScheduledDelete(hash, idx);
    return { ok: true, item };
  });

  app.delete('/api/media/:hash/:fileIndex', { preHandler: requireAuth }, async (req, reply) => {
    const { hash, fileIndex } = req.params as { hash: string; fileIndex: string };
    const idx = Number(fileIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return reply.code(400).send({ error: 'Bad Request', message: '参数无效' });
    }
    const res = await cleanup.unloadFile(hash, idx);
    return { ok: true, ...res };
  });
}
