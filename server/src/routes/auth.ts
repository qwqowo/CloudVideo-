import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import {
  LoginRateLimiter,
  SESSION_COOKIE_NAME,
  extractSessionToken,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
} from '../auth.js';

const loginSchema = z.object({
  password: z.string().min(1),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  rateLimiter = new LoginRateLimiter()
): Promise<void> {
  app.get('/api/auth/me', async (req) => {
    const token = extractSessionToken(req);
    const authenticated = verifySessionToken(token, config.jwtSecret);
    return { authenticated };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const xff = req.headers['x-forwarded-for'];
    const clientIp =
      (Array.isArray(xff) ? xff[0] : xff?.split(',')[0]?.trim()) || req.ip || 'unknown';

    const limitStatus = rateLimiter.check(clientIp);
    if (!limitStatus.allowed) {
      reply.header('Retry-After', String(limitStatus.retryAfterSec));
      return reply.code(429).send({
        error: 'TooManyRequests',
        retryAfterSec: limitStatus.retryAfterSec,
        message: `尝试次数过多，请 ${Math.ceil(limitStatus.retryAfterSec / 60)} 分钟后再试`,
      });
    }

    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: '请输入密码' });
    }

    if (!verifyPassword(parsed.data.password, config.appPassword)) {
      const fail = rateLimiter.recordFailure(clientIp);
      if (fail.locked) {
        reply.header('Retry-After', String(fail.retryAfterSec));
        return reply.code(429).send({
          error: 'TooManyRequests',
          retryAfterSec: fail.retryAfterSec,
          message: `连续输错过多，已锁定 ${Math.ceil(fail.retryAfterSec / 60)} 分钟`,
        });
      }
      return reply.code(401).send({
        error: 'Unauthorized',
        remainingAttempts: fail.remainingAttempts,
        message: `密码错误（剩余 ${fail.remainingAttempts} 次机会）`,
      });
    }

    rateLimiter.recordSuccess(clientIp);
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
