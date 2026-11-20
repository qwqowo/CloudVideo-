import path from 'node:path';
import crypto from 'node:crypto';

export interface AppConfig {
  port: number;
  host: string;
  appPassword: string;
  jwtSecret: string;
  qbitUrl: string;
  qbitUsername: string;
  qbitPassword: string;
  prowlarrUrl: string;
  prowlarrApiKey: string;
  downloadDir: string;
  dataDir: string;
  webDistDir: string;
  publicBaseUrl: string;
  defaults: {
    storageLimitGb: number;
    autoDeleteDelayHours: number;
    watchedThreshold: number;
    uploadLimitKbps: number;
    autoCleanupEnabled: boolean;
    stopSeedingOnComplete: boolean;
  };
}

function parseNumber(val: string | undefined, fallback: number): number {
  if (val === undefined || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cwd = process.cwd();
  const dataDir = path.resolve(env.DATA_DIR || path.join(cwd, '..', 'data', 'app'));
  const downloadDir = path.resolve(env.DOWNLOAD_DIR || path.join(cwd, '..', 'data', 'downloads'));
  const webDistDir = path.resolve(env.WEB_DIST_DIR || path.join(cwd, '..', 'web', 'dist'));

  const appPassword = env.APP_PASSWORD || 'admin123';
  const jwtSecret =
    env.JWT_SECRET ||
    crypto.createHash('sha256').update(`cloudvideo:${appPassword}`).digest('hex');

  return {
    port: parseNumber(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    appPassword,
    jwtSecret,
    qbitUrl: (env.QBIT_URL || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    qbitUsername: env.QBIT_USERNAME || '',
    qbitPassword: env.QBIT_PASSWORD || '',
    prowlarrUrl: (env.PROWLARR_URL || 'http://prowlarr:9696').replace(/\/+$/, ''),
    prowlarrApiKey: env.PROWLARR_API_KEY || '',
    downloadDir,
    dataDir,
    webDistDir,
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    defaults: {
      storageLimitGb: Math.max(1, parseNumber(env.STORAGE_LIMIT_GB, 45)),
      autoDeleteDelayHours: Math.max(0, parseNumber(env.AUTO_DELETE_DELAY_HOURS, 24)),
      watchedThreshold: Math.min(0.99, Math.max(0.5, parseNumber(env.WATCHED_THRESHOLD, 0.9))),
      uploadLimitKbps: Math.max(0, parseNumber(env.UPLOAD_LIMIT_KBPS, 512)),
      autoCleanupEnabled: env.AUTO_CLEANUP_ENABLED !== 'false',
      stopSeedingOnComplete: env.STOP_SEEDING_ON_COMPLETE !== 'false',
    },
  };
}
