import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config.js';
import { AppDatabase } from './db.js';
import { createAuthHook } from './auth.js';
import { QBittorrentClient, type IQBittorrentClient } from './services/qbittorrent.js';
import { CleanupService } from './services/cleanup.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerTorrentRoutes } from './routes/torrents.js';
import { killAllFfmpeg, registerStreamRoutes } from './routes/stream.js';
import { registerSpeedTestRoutes } from './routes/speedtest.js';
import { registerSettingsRoutes } from './routes/settings.js';

export interface AppContext {
  app: FastifyInstance;
  db: AppDatabase;
  qbit: IQBittorrentClient;
  cleanup: CleanupService;
  close: () => Promise<void>;
}

export async function buildApp(
  config: AppConfig,
  overrides: { qbit?: IQBittorrentClient; startScheduler?: boolean } = {}
): Promise<AppContext> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.downloadDir, { recursive: true });

  const dbPath = path.join(config.dataDir, 'cloudvideo.sqlite');
  const db = new AppDatabase(dbPath, config.defaults);
  const qbit =
    overrides.qbit ?? new QBittorrentClient(config.qbitUrl, config.qbitUsername, config.qbitPassword);
  const cleanup = new CleanupService(config, db, qbit);
  const requireAuth = createAuthHook(config.jwtSecret);

  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 1,
    },
  });

  app.get('/api/health', async () => ({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
  }));

  await registerAuthRoutes(app, config);
  await registerTorrentRoutes(app, { config, db, qbit, cleanup, requireAuth });
  await registerStreamRoutes(app, { config, db, qbit, requireAuth });
  await registerSpeedTestRoutes(app, { db, requireAuth });
  await registerSettingsRoutes(app, { db, qbit, cleanup, requireAuth });

  // Serve built frontend SPA when available
  if (fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'NotFound', message: '接口不存在' });
      }
      return reply.sendFile('index.html');
    });
  }

  if (overrides.startScheduler !== false) {
    cleanup.startScheduler(60_000);
  }

  const close = async () => {
    cleanup.stopScheduler();
    killAllFfmpeg();
    await app.close();
    db.close();
  };

  return { app, db, qbit, cleanup, close };
}
