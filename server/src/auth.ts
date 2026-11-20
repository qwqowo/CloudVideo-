import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE_NAME = 'cv_session';

function b64urlEncode(data: string | Buffer): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function hmacSign(payloadB64: string, secret: string): string {
  return b64urlEncode(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

export function verifyPassword(input: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function signSessionToken(secret: string, ttlSec = 7 * 24 * 3600): string {
  const payload = {
    type: 'session',
    exp: Math.floor(Date.now() / 1000) + ttlSec,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = hmacSign(body, secret);
  return `${body}.${sig}`;
}

export function verifySessionToken(token: string | undefined, secret: string): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [body, sig] = parts;
  const expectedSig = hmacSign(body, secret);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }
  try {
    const parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as {
      type?: string;
      exp?: number;
    };
    return parsed.type === 'session' && typeof parsed.exp === 'number' && parsed.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export function signStreamToken(
  secret: string,
  torrentHash: string,
  fileIndex: number,
  ttlSec = 12 * 3600
): string {
  const payload = {
    type: 'stream',
    h: torrentHash.toLowerCase(),
    i: fileIndex,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = hmacSign(body, secret);
  return `${body}.${sig}`;
}

export function verifyStreamToken(
  token: string | undefined,
  secret: string,
  torrentHash: string,
  fileIndex: number
): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [body, sig] = parts;
  const expectedSig = hmacSign(body, secret);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }
  try {
    const parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as {
      type?: string;
      h?: string;
      i?: number;
      exp?: number;
    };
    return (
      parsed.type === 'stream' &&
      parsed.h === torrentHash.toLowerCase() &&
      parsed.i === fileIndex &&
      typeof parsed.exp === 'number' &&
      parsed.exp > Date.now() / 1000
    );
  } catch {
    return false;
  }
}

export function extractSessionToken(req: FastifyRequest): string | undefined {
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return undefined;
}

export function createAuthHook(secret: string) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
    const token = extractSessionToken(req);
    if (!verifySessionToken(token, secret)) {
      return reply.code(401).send({ error: 'Unauthorized', message: '请先登录' });
    }
  };
}

interface RateLimitEntry {
  failures: number[];
  lockedUntil: number;
}

export class LoginRateLimiter {
  private entries = new Map<string, RateLimitEntry>();

  constructor(
    private maxAttempts = 5,
    private windowMs = 10 * 60 * 1000,
    private lockoutMs = 15 * 60 * 1000
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true, retryAfterSec: 0 };

    if (entry.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)),
      };
    }

    entry.failures = entry.failures.filter((t) => now - t < this.windowMs);
    if (entry.failures.length === 0) {
      this.entries.delete(key);
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  recordFailure(key: string, now = Date.now()): { locked: boolean; remainingAttempts: number; retryAfterSec: number } {
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((t) => now - t < this.windowMs);
    entry.failures.push(now);

    if (entry.failures.length >= this.maxAttempts) {
      entry.lockedUntil = now + this.lockoutMs;
      entry.failures = [];
      this.entries.set(key, entry);
      return {
        locked: true,
        remainingAttempts: 0,
        retryAfterSec: Math.ceil(this.lockoutMs / 1000),
      };
    }

    this.entries.set(key, entry);
    return {
      locked: false,
      remainingAttempts: this.maxAttempts - entry.failures.length,
      retryAfterSec: 0,
    };
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }
}
