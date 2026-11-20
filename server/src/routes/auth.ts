import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import {
  SESSION_COOKIE_NAME,
  extractSessionToken,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
} from '../auth.js';

const loginSchema = z.object({
  password: z.string().min(1),
});

export async function registerAuthRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  app.get('/api/auth/me', async (req) => {
    const token = extractSessionToken(req);
    const authenticated = verifySessionToken(token, config.jwtSecret);
    return { authenticated };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '请输入密码' });
    }

    if (!verifyPassword(parsed.data.password, config.appPassword)) {
      return reply.code(401).send({ error: 'Unauthorized', message: '密码错误' });
    }

    const token = signSessionToken(config.jwtSecret);
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 3600,
    });

    return { ok: true, token };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
}
