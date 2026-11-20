import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDatabase } from '../db.js';

// Pre-allocate 1 MiB of incompressible random bytes so proxies/browsers cannot inflate speed via compression
const CHUNK_SIZE = 1024 * 1024;
const RANDOM_CHUNK = crypto.randomBytes(CHUNK_SIZE);

const saveHistorySchema = z.object({
  pingMs: z.number().min(0),
  singleThreadMbps: z.number().min(0),
  multiThreadMbps: z.number().min(0),
  rating: z.string().min(1).max(100),
  note: z.string().max(120).optional().default(''),
});

export async function registerSpeedTestRoutes(
  app: FastifyInstance,
  deps: {
    db: AppDatabase;
    requireAuth: (req: any, reply: any) => Promise<any>;
  }
): Promise<void> {
  const { db, requireAuth } = deps;

  app.get('/api/speedtest/ping', { preHandler: requireAuth }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { ok: true, serverTime: Date.now() };
  });

  app.get('/api/speedtest/download', { preHandler: requireAuth }, async (req, reply) => {
    const query = req.query as { mb?: string };
    const mb = Math.min(100, Math.max(1, Math.round(Number(query.mb || 20) || 20)));
    const totalBytes = mb * CHUNK_SIZE;

    let remaining = totalBytes;
    const stream = new Readable({
      read() {
        if (remaining <= 0) {
          this.push(null);
          return;
        }
        const toSend = Math.min(remaining, CHUNK_SIZE);
        remaining -= toSend;
        this.push(toSend === CHUNK_SIZE ? RANDOM_CHUNK : RANDOM_CHUNK.subarray(0, toSend));
      },
    });

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', totalBytes);
    reply.header('Cache-Control', 'no-store, no-transform');
    reply.header('X-Accel-Buffering', 'no');

    return reply.send(stream);
  });

  app.get('/api/speedtest/history', { preHandler: requireAuth }, async () => {
    return { history: db.listSpeedTests(30) };
  });

  app.post('/api/speedtest/history', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = saveHistorySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '测速记录参数无效' });
    }
    const record = db.addSpeedTest(parsed.data);
    return { ok: true, record };
  });

  app.delete('/api/speedtest/history/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) {
      return reply.code(400).send({ error: 'Bad Request' });
    }
    db.deleteSpeedTest(numId);
    return { ok: true };
  });
}
