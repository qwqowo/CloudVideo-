import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db.js';
import type { IQBittorrentClient } from '../services/qbittorrent.js';
import type { CleanupService } from '../services/cleanup.js';
import type { TmdbService } from '../services/tmdb.js';
import { isVideoFile, resolveSafePath } from '../services/media.js';

const addMagnetSchema = z.object({
  magnet: z.string().min(8),
  sequential: z.boolean().optional().default(true),
  firstLastPiecePrio: z.boolean().optional().default(true),
  paused: z.boolean().optional().default(false),
  bingeMode: z.boolean().optional().default(false),
  bingeWindow: z.number().int().min(1).max(10).optional(),
});

const prioritySchema = z.object({
  fileIndices: z.array(z.number().int().min(0)).min(1),
  priority: z.union([z.literal(0), z.literal(1), z.literal(6), z.literal(7)]),
});

const batchSchema = z.object({
  action: z.enum(['pause', 'resume', 'delete']),
  hashes: z.array(z.string().min(8)).min(1),
});

const bingeToggleSchema = z.object({
  bingeMode: z.boolean(),
  bingeWindow: z.number().int().min(1).max(10).optional(),
});

const tmdbBindSchema = z.object({
  clear: z.boolean().optional(),
  candidate: z
    .object({
      tmdbId: z.number().int(),
      mediaType: z.enum(['movie', 'tv']),
      title: z.string(),
      originalTitle: z.string().default(''),
      year: z.string().default(''),
      overview: z.string().default(''),
      rating: z.number().default(0),
      posterUrl: z.string().default(''),
      backdropUrl: z.string().default(''),
    })
    .optional(),
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

function extractHexHashFromMagnet(magnet: string): string | null {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
  return m ? m[1].toLowerCase() : null;
}

export async function registerTorrentRoutes(
  app: FastifyInstance,
  deps: {
    config: AppConfig;
    db: AppDatabase;
    qbit: IQBittorrentClient;
    cleanup: CleanupService;
    tmdb: TmdbService;
    requireAuth: (req: any, reply: any) => Promise<any>;
  }
): Promise<void> {
  const { config, db, qbit, cleanup, tmdb, requireAuth } = deps;

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

    await cleanup.reconcileBingeTorrents().catch(() => {});

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

    const policies = new Map(db.listTorrentPolicies().map((p) => [p.torrentHash, p]));
    const tmdbMap = db.listTmdbCache();

    const enriched = await Promise.all(
      torrents.map(async (t) => {
        const items = byHash.get(t.hash) || [];
        const activeScheduled = items
          .filter((i) => !i.removedFile && !i.pinned && i.deleteAfterAt !== null)
          .map((i) => i.deleteAfterAt as number);
        const nextDeleteAt = activeScheduled.length > 0 ? Math.min(...activeScheduled) : null;
        const watchedCount = items.filter((i) => i.watchedAt !== null).length;
        const pinnedCount = items.filter((i) => i.pinned).length;
        const policy = policies.get(t.hash);

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

        // Kick off background TMDB scrape if API key is configured
        tmdb.scheduleAutoMatch(t.hash, t.name, videoCount);
        const tmdbRec = tmdbMap.get(t.hash);
        const tmdbPublic =
          tmdbRec && tmdbRec.tmdbId !== null
            ? {
                tmdbId: tmdbRec.tmdbId,
                mediaType: tmdbRec.mediaType,
                title: tmdbRec.title,
                originalTitle: tmdbRec.originalTitle,
                year: tmdbRec.year,
                overview: tmdbRec.overview,
                rating: tmdbRec.rating,
                posterUrl: tmdbRec.posterUrl,
                backdropUrl: tmdbRec.backdropUrl,
              }
            : null;

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
          bingeMode: policy?.bingeMode ?? false,
          bingeWindow: policy?.bingeWindow ?? 2,
          tmdb: tmdbPublic,
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
      await cleanup.reconcileBingeTorrents(hash).catch(() => {});
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
        warning = '当前存储已接近或达到设定上限，建议先手动清理或使用「追剧托管」仅下前 2 集。';
      }
    }

    const settings = db.getSettings();
    const bingeWindow = parsed.data.bingeWindow ?? settings.bingePreloadCount;
    const beforeHashes = parsed.data.bingeMode
      ? new Set((await qbit.listTorrents().catch(() => [])).map((t) => t.hash))
      : null;

    try {
      await qbit.addMagnet(parsed.data.magnet, {
        sequential: parsed.data.sequential,
        firstLastPiecePrio: parsed.data.firstLastPiecePrio,
        // Start paused in bingeMode only if metadata is already known; for magnets keep active briefly or register hash
        paused: parsed.data.paused,
      });

      if (parsed.data.bingeMode) {
        const directHash = extractHexHashFromMagnet(parsed.data.magnet);
        if (directHash) {
          db.upsertTorrentPolicy({
            torrentHash: directHash,
            bingeMode: true,
            bingeWindow,
            initialized: false,
          });
          await cleanup.reconcileBingeTorrents(directHash).catch(() => {});
        } else if (beforeHashes) {
          const after = await qbit.listTorrents().catch(() => []);
          for (const t of after) {
            if (!beforeHashes.has(t.hash)) {
              db.upsertTorrentPolicy({
                torrentHash: t.hash,
                bingeMode: true,
                bingeWindow,
                initialized: false,
              });
              await cleanup.reconcileBingeTorrents(t.hash).catch(() => {});
            }
          }
        }
      }

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
    let bingeMode = false;
    let bingeWindow = db.getSettings().bingePreloadCount;

    for await (const part of parts) {
      if (part.type === 'file') {
        filename = part.filename || filename;
        fileBuffer = await part.toBuffer();
      } else {
        const val = String(part.value);
        if (part.fieldname === 'sequential') sequential = val !== 'false';
        if (part.fieldname === 'firstLastPiecePrio') firstLastPiecePrio = val !== 'false';
        if (part.fieldname === 'paused') paused = val === 'true';
        if (part.fieldname === 'bingeMode') bingeMode = val === 'true';
        if (part.fieldname === 'bingeWindow') {
          const n = Number(val);
          if (Number.isInteger(n) && n >= 1 && n <= 10) bingeWindow = n;
        }
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
        warning = '当前存储已接近或达到设定上限，建议先手动清理或使用「追剧托管」仅下前 2 集。';
      }
    }

    const beforeHashes = bingeMode
      ? new Set((await qbit.listTorrents().catch(() => [])).map((t) => t.hash))
      : null;

    try {
      await qbit.addTorrentFile(fileBuffer, filename, {
        sequential,
        firstLastPiecePrio,
        paused: paused || bingeMode, // Pause briefly for .torrent so binge selector trims episodes before download starts
      });

      if (bingeMode && beforeHashes) {
        await new Promise((r) => setTimeout(r, 350));
        const after = await qbit.listTorrents().catch(() => []);
        for (const t of after) {
          if (!beforeHashes.has(t.hash)) {
            db.upsertTorrentPolicy({
              torrentHash: t.hash,
              bingeMode: true,
              bingeWindow,
              initialized: false,
            });
            await cleanup.reconcileBingeTorrents(t.hash).catch(() => {});
          }
        }
      }

      return { ok: true, warning };
    } catch (err) {
      return reply.code(502).send({
        error: 'QBittorrentError',
        message: err instanceof Error ? err.message : '上传种子文件失败',
      });
    }
  });

  app.post('/api/torrents/batch', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '批量操作参数无效' });
    }
    const hashes = parsed.data.hashes.map((h) => h.toLowerCase());
    let freedBytes = 0;

    if (parsed.data.action === 'pause') {
      await qbit.pauseTorrents(hashes);
    } else if (parsed.data.action === 'resume') {
      await qbit.resumeTorrents(hashes);
    } else {
      for (const h of hashes) {
        const r = await cleanup.unloadTorrent(h, 'batch_manual_unload');
        freedBytes += r.freedBytes;
      }
    }

    return { ok: true, count: hashes.length, freedBytes };
  });

  app.post('/api/torrents/:hash/binge', { preHandler: requireAuth }, async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const parsed = bingeToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '参数无效' });
    }
    const policy = db.upsertTorrentPolicy({
      torrentHash: hash,
      bingeMode: parsed.data.bingeMode,
      bingeWindow: parsed.data.bingeWindow ?? db.getSettings().bingePreloadCount,
      initialized: !parsed.data.bingeMode,
    });
    if (parsed.data.bingeMode) {
      await cleanup.reconcileBingeTorrents(hash).catch(() => {});
    }
    return { ok: true, policy };
  });

  app.get('/api/tmdb/search', { preHandler: requireAuth }, async (req, reply) => {
    const query = (req.query as { q?: string; year?: string }) || {};
    if (!query.q || !query.q.trim()) {
      return reply.code(400).send({ error: 'Bad Request', message: '请输入搜索关键词' });
    }
    if (!db.getSettings().tmdbApiKey.trim()) {
      return reply.code(400).send({
        error: 'TmdbNotConfigured',
        message: '请先在「存储策略 -> TMDB 刮削」中填入 TMDB API Key 或 Read Token',
      });
    }
    try {
      const results = await tmdb.searchCandidates(query.q, query.year);
      return { results };
    } catch (err) {
      return reply.code(502).send({
        error: 'TmdbError',
        message: err instanceof Error ? err.message : 'TMDB 查询失败',
      });
    }
  });

  app.post('/api/torrents/:hash/tmdb', { preHandler: requireAuth }, async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const parsed = tmdbBindSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '参数无效' });
    }
    if (parsed.data.clear) {
      db.deleteTmdbCache(hash);
      return { ok: true, tmdb: null };
    }
    if (!parsed.data.candidate) {
      return reply.code(400).send({ error: 'Bad Request', message: '缺少匹配候选' });
    }
    const rec = tmdb.bindManualMatch(hash, parsed.data.candidate);
    return { ok: true, tmdb: rec };
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
    const res = await cleanup.unloadTorrent(hash, 'manual_torrent_unload');
    return { ok: true, ...res };
  });

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
      return reply.code(400).send({ error: 'Bad Request', message: '无效的文件索引' });
    }
    const res = await cleanup.unloadFile(hash, idx, 'manual_unload');
    return { ok: true, ...res };
  });
}
