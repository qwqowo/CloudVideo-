import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from './config.js';

export interface AppSettings {
  storageLimitGb: number;
  autoDeleteDelayHours: number;
  watchedThreshold: number;
  uploadLimitKbps: number;
  autoCleanupEnabled: boolean;
  stopSeedingOnComplete: boolean;
  bingePreloadCount: number;
  tmdbApiKey: string;
  proxyEnabled: boolean;
  proxyType: 'none' | 'http' | 'socks5';
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
  telegramBotToken: string;
  telegramChatId: string;
  webhookUrl: string;
  prowlarrUrl: string;
  prowlarrApiKey: string;
  assrtToken: string;
  subdlApiKey: string;
  openSubtitlesApiKey: string;
  openSubtitlesUsername: string;
  openSubtitlesPassword: string;
}

export interface TorznabIndexerRecord {
  id: number;
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
  createdAt: number;
}

export interface RssSubscriptionRecord {
  id: number;
  name: string;
  feedUrl: string;
  includeRegex: string;
  excludeRegex: string;
  minSizeMb: number;
  maxSizeMb: number;
  intervalMin: number;
  sequential: boolean;
  bingeMode: boolean;
  enabled: boolean;
  lastCheckedAt: number | null;
  lastError: string;
  matchedCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RssSeenItemRecord {
  subscriptionId: number;
  itemGuid: string;
  title: string;
  downloadUrl: string;
  sizeBytes: number;
  matched: boolean;
  pushed: boolean;
  reason: string;
  seenAt: number;
}

export interface MediaItemRecord {
  torrentHash: string;
  fileIndex: number;
  relativePath: string;
  sizeBytes: number;
  durationSec: number;
  positionSec: number;
  progress: number;
  watchedAt: number | null;
  deleteAfterAt: number | null;
  lastPlayedAt: number | null;
  pinned: boolean;
  removedFile: boolean;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TorrentPolicyRecord {
  torrentHash: string;
  bingeMode: boolean;
  bingeWindow: number;
  initialized: boolean;
  completedNotified: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CleanupLogRecord {
  id: number;
  createdAt: number;
  torrentHash: string;
  relativePath: string;
  reason: string;
  freedBytes: number;
}

export interface TmdbCacheRecord {
  torrentHash: string;
  tmdbId: number | null;
  mediaType: string;
  title: string;
  originalTitle: string;
  year: string;
  overview: string;
  rating: number;
  posterUrl: string;
  backdropUrl: string;
  isAnime?: boolean;
  fetchedAt: number;
}

export interface WatchHistoryRecord {
  id: number;
  torrentHash: string;
  fileIndex: number;
  title: string;
  fileName: string;
  mediaCategory: string;
  posterUrl: string;
  backdropUrl: string;
  year: string;
  rating: number;
  durationSec: number;
  positionSec: number;
  progress: number;
  completed: boolean;
  watchedAt: number;
  updatedAt: number;
}

export interface CustomSubtitleRecord {
  id: number;
  torrentHash: string;
  fileIndex: number;
  title: string;
  filePath: string;
  createdAt: number;
}

export interface SpeedTestRecord {
  id: number;
  createdAt: number;
  pingMs: number;
  singleThreadMbps: number;
  multiThreadMbps: number;
  rating: string;
  note: string;
}

export class AppDatabase {
  private db: DatabaseSync;
  private defaults: AppSettings;

  constructor(
    dbPath: string,
    defaults: AppConfig['defaults'],
    hubDefaults: { prowlarrUrl?: string; prowlarrApiKey?: string } = {}
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.defaults = {
      ...defaults,
      bingePreloadCount: 2,
      tmdbApiKey: process.env.TMDB_API_KEY || '',
      proxyEnabled: false,
      proxyType: 'none',
      proxyHost: '',
      proxyPort: 1080,
      proxyUsername: '',
      proxyPassword: '',
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
      telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
      webhookUrl: process.env.WEBHOOK_URL || '',
      prowlarrUrl: (hubDefaults.prowlarrUrl ?? process.env.PROWLARR_URL ?? 'http://prowlarr:9696').replace(/\/+$/, ''),
      prowlarrApiKey: hubDefaults.prowlarrApiKey ?? process.env.PROWLARR_API_KEY ?? '',
      assrtToken: process.env.ASSRT_TOKEN || '',
      subdlApiKey: process.env.SUBDL_API_KEY || '',
      openSubtitlesApiKey: process.env.OPENSUBTITLES_API_KEY || '',
      openSubtitlesUsername: process.env.OPENSUBTITLES_USERNAME || '',
      openSubtitlesPassword: process.env.OPENSUBTITLES_PASSWORD || '',
    };
    this.init();
  }

  private init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS media_items (
        torrent_hash TEXT NOT NULL,
        file_index INTEGER NOT NULL,
        relative_path TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        duration_sec REAL NOT NULL DEFAULT 0,
        position_sec REAL NOT NULL DEFAULT 0,
        progress REAL NOT NULL DEFAULT 0,
        watched_at INTEGER,
        delete_after_at INTEGER,
        last_played_at INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        removed_file INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (torrent_hash, file_index)
      );

      CREATE TABLE IF NOT EXISTS torrent_policies (
        torrent_hash TEXT PRIMARY KEY,
        binge_mode INTEGER NOT NULL DEFAULT 0,
        binge_window INTEGER NOT NULL DEFAULT 2,
        initialized INTEGER NOT NULL DEFAULT 0,
        completed_notified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cleanup_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        torrent_hash TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        reason TEXT NOT NULL,
        freed_bytes INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tmdb_cache (
        torrent_hash TEXT PRIMARY KEY,
        tmdb_id INTEGER,
        media_type TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        original_title TEXT NOT NULL DEFAULT '',
        year TEXT NOT NULL DEFAULT '',
        overview TEXT NOT NULL DEFAULT '',
        rating REAL NOT NULL DEFAULT 0,
        poster_url TEXT NOT NULL DEFAULT '',
        backdrop_url TEXT NOT NULL DEFAULT '',
        fetched_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS custom_subtitles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        torrent_hash TEXT NOT NULL,
        file_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS speed_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        ping_ms REAL NOT NULL,
        single_thread_mbps REAL NOT NULL,
        multi_thread_mbps REAL NOT NULL,
        rating TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS torznab_indexers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        api_key TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rss_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        feed_url TEXT NOT NULL,
        include_regex TEXT NOT NULL DEFAULT '',
        exclude_regex TEXT NOT NULL DEFAULT '',
        min_size_mb INTEGER NOT NULL DEFAULT 0,
        max_size_mb INTEGER NOT NULL DEFAULT 0,
        interval_min INTEGER NOT NULL DEFAULT 30,
        sequential INTEGER NOT NULL DEFAULT 1,
        binge_mode INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_checked_at INTEGER,
        last_error TEXT NOT NULL DEFAULT '',
        matched_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rss_seen_items (
        subscription_id INTEGER NOT NULL,
        item_guid TEXT NOT NULL,
        title TEXT NOT NULL,
        download_url TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        matched INTEGER NOT NULL DEFAULT 0,
        pushed INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (subscription_id, item_guid),
        FOREIGN KEY (subscription_id) REFERENCES rss_subscriptions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tmdb_credits_cache (
        media_type TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (media_type, tmdb_id)
      );

      CREATE TABLE IF NOT EXISTS watch_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        torrent_hash TEXT NOT NULL,
        file_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL DEFAULT '',
        media_category TEXT NOT NULL DEFAULT 'movie',
        poster_url TEXT NOT NULL DEFAULT '',
        backdrop_url TEXT NOT NULL DEFAULT '',
        year TEXT NOT NULL DEFAULT '',
        rating REAL NOT NULL DEFAULT 0,
        duration_sec REAL NOT NULL DEFAULT 0,
        position_sec REAL NOT NULL DEFAULT 0,
        progress REAL NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        watched_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (torrent_hash, file_index)
      );
    `);

    // Safe forward migration for existing databases
    try {
      this.db.exec('ALTER TABLE tmdb_cache ADD COLUMN is_anime INTEGER NOT NULL DEFAULT 0');
    } catch {
      // column already exists
    }
  }

  close(): void {
    this.db.close();
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const num = (key: string, fallback: number): number => {
      const v = map.get(key);
      if (v === undefined) return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const bool = (key: string, fallback: boolean): boolean => {
      const v = map.get(key);
      if (v === undefined) return fallback;
      return v === 'true' || v === '1';
    };
    const str = (key: string, fallback: string): string => {
      const v = map.get(key);
      return v === undefined ? fallback : v;
    };

    const rawProxyType = str('proxyType', this.defaults.proxyType);
    const proxyType: AppSettings['proxyType'] =
      rawProxyType === 'http' || rawProxyType === 'socks5' ? rawProxyType : 'none';

    return {
      storageLimitGb: Math.max(0.0001, num('storageLimitGb', this.defaults.storageLimitGb)),
      autoDeleteDelayHours: Math.max(0, num('autoDeleteDelayHours', this.defaults.autoDeleteDelayHours)),
      watchedThreshold: Math.min(0.99, Math.max(0.5, num('watchedThreshold', this.defaults.watchedThreshold))),
      uploadLimitKbps: Math.max(0, num('uploadLimitKbps', this.defaults.uploadLimitKbps)),
      autoCleanupEnabled: bool('autoCleanupEnabled', this.defaults.autoCleanupEnabled),
      stopSeedingOnComplete: bool('stopSeedingOnComplete', this.defaults.stopSeedingOnComplete),
      bingePreloadCount: Math.min(10, Math.max(1, Math.round(num('bingePreloadCount', this.defaults.bingePreloadCount)))),
      tmdbApiKey: str('tmdbApiKey', this.defaults.tmdbApiKey),
      proxyEnabled: bool('proxyEnabled', this.defaults.proxyEnabled),
      proxyType,
      proxyHost: str('proxyHost', this.defaults.proxyHost),
      proxyPort: Math.min(65535, Math.max(1, Math.round(num('proxyPort', this.defaults.proxyPort)))),
      proxyUsername: str('proxyUsername', this.defaults.proxyUsername),
      proxyPassword: str('proxyPassword', this.defaults.proxyPassword),
      telegramBotToken: str('telegramBotToken', this.defaults.telegramBotToken),
      telegramChatId: str('telegramChatId', this.defaults.telegramChatId),
      webhookUrl: str('webhookUrl', this.defaults.webhookUrl),
      prowlarrUrl: str('prowlarrUrl', this.defaults.prowlarrUrl),
      prowlarrApiKey: str('prowlarrApiKey', this.defaults.prowlarrApiKey),
      assrtToken: str('assrtToken', this.defaults.assrtToken),
      subdlApiKey: str('subdlApiKey', this.defaults.subdlApiKey),
      openSubtitlesApiKey: str('openSubtitlesApiKey', this.defaults.openSubtitlesApiKey),
      openSubtitlesUsername: str('openSubtitlesUsername', this.defaults.openSubtitlesUsername),
      openSubtitlesPassword: str('openSubtitlesPassword', this.defaults.openSubtitlesPassword),
    };
  }

  updateSettings(partial: Partial<AppSettings>): AppSettings {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const keys: Array<keyof AppSettings> = [
      'storageLimitGb',
      'autoDeleteDelayHours',
      'watchedThreshold',
      'uploadLimitKbps',
      'autoCleanupEnabled',
      'stopSeedingOnComplete',
      'bingePreloadCount',
      'tmdbApiKey',
      'proxyEnabled',
      'proxyType',
      'proxyHost',
      'proxyPort',
      'proxyUsername',
      'proxyPassword',
      'telegramBotToken',
      'telegramChatId',
      'webhookUrl',
      'prowlarrUrl',
      'prowlarrApiKey',
      'assrtToken',
      'subdlApiKey',
      'openSubtitlesApiKey',
      'openSubtitlesUsername',
      'openSubtitlesPassword',
    ];
    for (const k of keys) {
      if (partial[k] !== undefined) {
        stmt.run(k, String(partial[k]));
      }
    }
    return this.getSettings();
  }

  private mapMediaRow(row: Record<string, unknown>): MediaItemRecord {
    return {
      torrentHash: String(row.torrent_hash),
      fileIndex: Number(row.file_index),
      relativePath: String(row.relative_path || ''),
      sizeBytes: Number(row.size_bytes || 0),
      durationSec: Number(row.duration_sec || 0),
      positionSec: Number(row.position_sec || 0),
      progress: Number(row.progress || 0),
      watchedAt: row.watched_at === null ? null : Number(row.watched_at),
      deleteAfterAt: row.delete_after_at === null ? null : Number(row.delete_after_at),
      lastPlayedAt: row.last_played_at === null ? null : Number(row.last_played_at),
      pinned: Boolean(row.pinned),
      removedFile: Boolean(row.removed_file),
      deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  getMediaItem(torrentHash: string, fileIndex: number): MediaItemRecord | null {
    const row = this.db
      .prepare('SELECT * FROM media_items WHERE torrent_hash = ? AND file_index = ?')
      .get(torrentHash.toLowerCase(), fileIndex) as Record<string, unknown> | undefined;
    return row ? this.mapMediaRow(row) : null;
  }

  listMediaItems(torrentHash?: string): MediaItemRecord[] {
    const rows = torrentHash
      ? (this.db
          .prepare('SELECT * FROM media_items WHERE torrent_hash = ? ORDER BY file_index ASC')
          .all(torrentHash.toLowerCase()) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM media_items ORDER BY updated_at DESC')
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapMediaRow(r));
  }

  upsertMediaItem(input: {
    torrentHash: string;
    fileIndex: number;
    relativePath?: string;
    sizeBytes?: number;
    durationSec?: number;
    positionSec?: number;
    progress?: number;
    watchedAt?: number | null;
    deleteAfterAt?: number | null;
    lastPlayedAt?: number | null;
    pinned?: boolean;
    removedFile?: boolean;
    deletedAt?: number | null;
    now?: number;
  }): MediaItemRecord {
    const hash = input.torrentHash.toLowerCase();
    const now = input.now ?? Date.now();
    const existing = this.getMediaItem(hash, input.fileIndex);

    const next: MediaItemRecord = {
      torrentHash: hash,
      fileIndex: input.fileIndex,
      relativePath: input.relativePath ?? existing?.relativePath ?? '',
      sizeBytes: input.sizeBytes ?? existing?.sizeBytes ?? 0,
      durationSec: input.durationSec ?? existing?.durationSec ?? 0,
      positionSec: input.positionSec ?? existing?.positionSec ?? 0,
      progress: input.progress ?? existing?.progress ?? 0,
      watchedAt: input.watchedAt !== undefined ? input.watchedAt : (existing?.watchedAt ?? null),
      deleteAfterAt:
        input.deleteAfterAt !== undefined ? input.deleteAfterAt : (existing?.deleteAfterAt ?? null),
      lastPlayedAt:
        input.lastPlayedAt !== undefined ? input.lastPlayedAt : (existing?.lastPlayedAt ?? null),
      pinned: input.pinned ?? existing?.pinned ?? false,
      removedFile: input.removedFile ?? existing?.removedFile ?? false,
      deletedAt: input.deletedAt !== undefined ? input.deletedAt : (existing?.deletedAt ?? null),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO media_items (
          torrent_hash, file_index, relative_path, size_bytes, duration_sec, position_sec,
          progress, watched_at, delete_after_at, last_played_at, pinned, removed_file,
          deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(torrent_hash, file_index) DO UPDATE SET
          relative_path = excluded.relative_path,
          size_bytes = excluded.size_bytes,
          duration_sec = excluded.duration_sec,
          position_sec = excluded.position_sec,
          progress = excluded.progress,
          watched_at = excluded.watched_at,
          delete_after_at = excluded.delete_after_at,
          last_played_at = excluded.last_played_at,
          pinned = excluded.pinned,
          removed_file = excluded.removed_file,
          deleted_at = excluded.deleted_at,
          updated_at = excluded.updated_at`
      )
      .run(
        next.torrentHash,
        next.fileIndex,
        next.relativePath,
        next.sizeBytes,
        next.durationSec,
        next.positionSec,
        next.progress,
        next.watchedAt,
        next.deleteAfterAt,
        next.lastPlayedAt,
        next.pinned ? 1 : 0,
        next.removedFile ? 1 : 0,
        next.deletedAt,
        next.createdAt,
        next.updatedAt
      );

    return next;
  }

  deleteTorrentRecords(torrentHash: string): void {
    const h = torrentHash.toLowerCase();
    this.db.prepare('DELETE FROM media_items WHERE torrent_hash = ?').run(h);
    this.db.prepare('DELETE FROM torrent_policies WHERE torrent_hash = ?').run(h);
    this.db.prepare('DELETE FROM tmdb_cache WHERE torrent_hash = ?').run(h);
    this.db.prepare('DELETE FROM custom_subtitles WHERE torrent_hash = ?').run(h);
  }

  // ---- Torrent Policies (Binge Mode & Completion Notifications) ----
  getTorrentPolicy(torrentHash: string): TorrentPolicyRecord | null {
    const row = this.db
      .prepare('SELECT * FROM torrent_policies WHERE torrent_hash = ?')
      .get(torrentHash.toLowerCase()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      torrentHash: String(row.torrent_hash),
      bingeMode: Boolean(row.binge_mode),
      bingeWindow: Number(row.binge_window || 2),
      initialized: Boolean(row.initialized),
      completedNotified: Boolean(row.completed_notified),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  listTorrentPolicies(): TorrentPolicyRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM torrent_policies ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      torrentHash: String(row.torrent_hash),
      bingeMode: Boolean(row.binge_mode),
      bingeWindow: Number(row.binge_window || 2),
      initialized: Boolean(row.initialized),
      completedNotified: Boolean(row.completed_notified),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  upsertTorrentPolicy(input: {
    torrentHash: string;
    bingeMode?: boolean;
    bingeWindow?: number;
    initialized?: boolean;
    completedNotified?: boolean;
  }): TorrentPolicyRecord {
    const hash = input.torrentHash.toLowerCase();
    const now = Date.now();
    const existing = this.getTorrentPolicy(hash);
    const next: TorrentPolicyRecord = {
      torrentHash: hash,
      bingeMode: input.bingeMode ?? existing?.bingeMode ?? false,
      bingeWindow: input.bingeWindow ?? existing?.bingeWindow ?? 2,
      initialized: input.initialized ?? existing?.initialized ?? false,
      completedNotified: input.completedNotified ?? existing?.completedNotified ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO torrent_policies (
          torrent_hash, binge_mode, binge_window, initialized, completed_notified, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(torrent_hash) DO UPDATE SET
          binge_mode = excluded.binge_mode,
          binge_window = excluded.binge_window,
          initialized = excluded.initialized,
          completed_notified = excluded.completed_notified,
          updated_at = excluded.updated_at`
      )
      .run(
        next.torrentHash,
        next.bingeMode ? 1 : 0,
        next.bingeWindow,
        next.initialized ? 1 : 0,
        next.completedNotified ? 1 : 0,
        next.createdAt,
        next.updatedAt
      );
    return next;
  }

  // ---- Cleanup Audit Logs ----
  addCleanupLog(entry: {
    torrentHash: string;
    relativePath: string;
    reason: string;
    freedBytes: number;
    createdAt?: number;
  }): CleanupLogRecord {
    const createdAt = entry.createdAt ?? Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO cleanup_logs (created_at, torrent_hash, relative_path, reason, freed_bytes)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(createdAt, entry.torrentHash.toLowerCase(), entry.relativePath, entry.reason, entry.freedBytes);
    return {
      id: Number(res.lastInsertRowid),
      createdAt,
      torrentHash: entry.torrentHash.toLowerCase(),
      relativePath: entry.relativePath,
      reason: entry.reason,
      freedBytes: entry.freedBytes,
    };
  }

  listCleanupLogs(limit = 50): CleanupLogRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM cleanup_logs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      createdAt: Number(r.created_at),
      torrentHash: String(r.torrent_hash),
      relativePath: String(r.relative_path),
      reason: String(r.reason),
      freedBytes: Number(r.freed_bytes || 0),
    }));
  }

  // ---- TMDB Cache ----
  getTmdbCache(torrentHash: string): TmdbCacheRecord | null {
    const r = this.db
      .prepare('SELECT * FROM tmdb_cache WHERE torrent_hash = ?')
      .get(torrentHash.toLowerCase()) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      torrentHash: String(r.torrent_hash),
      tmdbId: r.tmdb_id === null ? null : Number(r.tmdb_id),
      mediaType: String(r.media_type || ''),
      title: String(r.title || ''),
      originalTitle: String(r.original_title || ''),
      year: String(r.year || ''),
      overview: String(r.overview || ''),
      rating: Number(r.rating || 0),
      posterUrl: String(r.poster_url || ''),
      backdropUrl: String(r.backdrop_url || ''),
      isAnime: Boolean(r.is_anime),
      fetchedAt: Number(r.fetched_at),
    };
  }

  listTmdbCache(): Map<string, TmdbCacheRecord> {
    const rows = this.db.prepare('SELECT * FROM tmdb_cache').all() as Array<Record<string, unknown>>;
    const map = new Map<string, TmdbCacheRecord>();
    for (const r of rows) {
      const rec: TmdbCacheRecord = {
        torrentHash: String(r.torrent_hash),
        tmdbId: r.tmdb_id === null ? null : Number(r.tmdb_id),
        mediaType: String(r.media_type || ''),
        title: String(r.title || ''),
        originalTitle: String(r.original_title || ''),
        year: String(r.year || ''),
        overview: String(r.overview || ''),
        rating: Number(r.rating || 0),
        posterUrl: String(r.poster_url || ''),
        backdropUrl: String(r.backdrop_url || ''),
        isAnime: Boolean(r.is_anime),
        fetchedAt: Number(r.fetched_at),
      };
      map.set(rec.torrentHash, rec);
    }
    return map;
  }

  upsertTmdbCache(rec: TmdbCacheRecord): void {
    this.db
      .prepare(
        `INSERT INTO tmdb_cache (
          torrent_hash, tmdb_id, media_type, title, original_title, year, overview,
          rating, poster_url, backdrop_url, is_anime, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(torrent_hash) DO UPDATE SET
          tmdb_id = excluded.tmdb_id,
          media_type = excluded.media_type,
          title = excluded.title,
          original_title = excluded.original_title,
          year = excluded.year,
          overview = excluded.overview,
          rating = excluded.rating,
          poster_url = excluded.poster_url,
          backdrop_url = excluded.backdrop_url,
          is_anime = excluded.is_anime,
          fetched_at = excluded.fetched_at`
      )
      .run(
        rec.torrentHash.toLowerCase(),
        rec.tmdbId,
        rec.mediaType,
        rec.title,
        rec.originalTitle,
        rec.year,
        rec.overview,
        rec.rating,
        rec.posterUrl,
        rec.backdropUrl,
        rec.isAnime ? 1 : 0,
        rec.fetchedAt
      );
  }

  getTmdbCreditsCache(mediaType: string, tmdbId: number): { payloadJson: string; fetchedAt: number } | null {
    const r = this.db
      .prepare('SELECT payload_json, fetched_at FROM tmdb_credits_cache WHERE media_type = ? AND tmdb_id = ?')
      .get(mediaType, tmdbId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      payloadJson: String(r.payload_json),
      fetchedAt: Number(r.fetched_at),
    };
  }

  upsertTmdbCreditsCache(mediaType: string, tmdbId: number, payloadJson: string, fetchedAt = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO tmdb_credits_cache (media_type, tmdb_id, payload_json, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(media_type, tmdb_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           fetched_at = excluded.fetched_at`
      )
      .run(mediaType, tmdbId, payloadJson, fetchedAt);
  }

  // ---- Permanent Watch History ----
  upsertWatchHistory(entry: {
    torrentHash: string;
    fileIndex: number;
    title: string;
    fileName: string;
    mediaCategory?: string;
    posterUrl?: string;
    backdropUrl?: string;
    year?: string;
    rating?: number;
    durationSec: number;
    positionSec: number;
    progress: number;
    completed: boolean;
    now?: number;
  }): void {
    const now = entry.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO watch_history (
          torrent_hash, file_index, title, file_name, media_category,
          poster_url, backdrop_url, year, rating,
          duration_sec, position_sec, progress, completed, watched_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(torrent_hash, file_index) DO UPDATE SET
          title = excluded.title,
          file_name = excluded.file_name,
          media_category = excluded.media_category,
          poster_url = CASE WHEN excluded.poster_url != '' THEN excluded.poster_url ELSE watch_history.poster_url END,
          backdrop_url = CASE WHEN excluded.backdrop_url != '' THEN excluded.backdrop_url ELSE watch_history.backdrop_url END,
          year = CASE WHEN excluded.year != '' THEN excluded.year ELSE watch_history.year END,
          rating = CASE WHEN excluded.rating > 0 THEN excluded.rating ELSE watch_history.rating END,
          duration_sec = excluded.duration_sec,
          position_sec = excluded.position_sec,
          progress = MAX(watch_history.progress, excluded.progress),
          completed = MAX(watch_history.completed, excluded.completed),
          watched_at = excluded.watched_at,
          updated_at = excluded.updated_at`
      )
      .run(
        entry.torrentHash.toLowerCase(),
        entry.fileIndex,
        entry.title,
        entry.fileName,
        entry.mediaCategory || 'movie',
        entry.posterUrl || '',
        entry.backdropUrl || '',
        entry.year || '',
        entry.rating || 0,
        entry.durationSec,
        entry.positionSec,
        entry.progress,
        entry.completed ? 1 : 0,
        now,
        now
      );
  }

  listWatchHistory(limit = 60): WatchHistoryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM watch_history ORDER BY watched_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      torrentHash: String(r.torrent_hash),
      fileIndex: Number(r.file_index),
      title: String(r.title),
      fileName: String(r.file_name || ''),
      mediaCategory: String(r.media_category || 'movie'),
      posterUrl: String(r.poster_url || ''),
      backdropUrl: String(r.backdrop_url || ''),
      year: String(r.year || ''),
      rating: Number(r.rating || 0),
      durationSec: Number(r.duration_sec || 0),
      positionSec: Number(r.position_sec || 0),
      progress: Number(r.progress || 0),
      completed: Boolean(r.completed),
      watchedAt: Number(r.watched_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  deleteWatchHistory(id: number): void {
    this.db.prepare('DELETE FROM watch_history WHERE id = ?').run(id);
  }

  deleteTmdbCache(torrentHash: string): void {
    this.db.prepare('DELETE FROM tmdb_cache WHERE torrent_hash = ?').run(torrentHash.toLowerCase());
  }

  // ---- Custom Uploaded Subtitles ----
  addCustomSubtitle(entry: {
    torrentHash: string;
    fileIndex: number;
    title: string;
    filePath: string;
  }): CustomSubtitleRecord {
    const createdAt = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO custom_subtitles (torrent_hash, file_index, title, file_path, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(entry.torrentHash.toLowerCase(), entry.fileIndex, entry.title, entry.filePath, createdAt);
    return {
      id: Number(res.lastInsertRowid),
      torrentHash: entry.torrentHash.toLowerCase(),
      fileIndex: entry.fileIndex,
      title: entry.title,
      filePath: entry.filePath,
      createdAt,
    };
  }

  listCustomSubtitles(torrentHash: string, fileIndex?: number): CustomSubtitleRecord[] {
    const rows =
      fileIndex !== undefined
        ? (this.db
            .prepare(
              'SELECT * FROM custom_subtitles WHERE torrent_hash = ? AND file_index = ? ORDER BY id DESC'
            )
            .all(torrentHash.toLowerCase(), fileIndex) as Array<Record<string, unknown>>)
        : (this.db
            .prepare('SELECT * FROM custom_subtitles WHERE torrent_hash = ? ORDER BY id DESC')
            .all(torrentHash.toLowerCase()) as Array<Record<string, unknown>>);
    return rows.map((r) => ({
      id: Number(r.id),
      torrentHash: String(r.torrent_hash),
      fileIndex: Number(r.file_index),
      title: String(r.title),
      filePath: String(r.file_path),
      createdAt: Number(r.created_at),
    }));
  }

  getCustomSubtitle(id: number): CustomSubtitleRecord | null {
    const r = this.db.prepare('SELECT * FROM custom_subtitles WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: Number(r.id),
      torrentHash: String(r.torrent_hash),
      fileIndex: Number(r.file_index),
      title: String(r.title),
      filePath: String(r.file_path),
      createdAt: Number(r.created_at),
    };
  }

  deleteCustomSubtitlesForFile(torrentHash: string, fileIndex: number): CustomSubtitleRecord[] {
    const existing = this.listCustomSubtitles(torrentHash, fileIndex);
    this.db
      .prepare('DELETE FROM custom_subtitles WHERE torrent_hash = ? AND file_index = ?')
      .run(torrentHash.toLowerCase(), fileIndex);
    return existing;
  }

  // ---- Speed Tests ----
  addSpeedTest(entry: Omit<SpeedTestRecord, 'id' | 'createdAt'> & { createdAt?: number }): SpeedTestRecord {
    const createdAt = entry.createdAt ?? Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO speed_tests (created_at, ping_ms, single_thread_mbps, multi_thread_mbps, rating, note)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        createdAt,
        entry.pingMs,
        entry.singleThreadMbps,
        entry.multiThreadMbps,
        entry.rating,
        entry.note
      );
    return {
      id: Number(res.lastInsertRowid),
      createdAt,
      pingMs: entry.pingMs,
      singleThreadMbps: entry.singleThreadMbps,
      multiThreadMbps: entry.multiThreadMbps,
      rating: entry.rating,
      note: entry.note,
    };
  }

  listSpeedTests(limit = 30): SpeedTestRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM speed_tests ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      createdAt: Number(r.created_at),
      pingMs: Number(r.ping_ms),
      singleThreadMbps: Number(r.single_thread_mbps),
      multiThreadMbps: Number(r.multi_thread_mbps),
      rating: String(r.rating),
      note: String(r.note || ''),
    }));
  }

  deleteSpeedTest(id: number): void {
    this.db.prepare('DELETE FROM speed_tests WHERE id = ?').run(id);
  }

  // ---- Torznab Indexers ----
  private mapTorznabRow(r: Record<string, unknown>): TorznabIndexerRecord {
    return {
      id: Number(r.id),
      name: String(r.name),
      url: String(r.url),
      apiKey: String(r.api_key || ''),
      enabled: Boolean(r.enabled),
      createdAt: Number(r.created_at),
    };
  }

  listTorznabIndexers(): TorznabIndexerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM torznab_indexers ORDER BY id ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTorznabRow(r));
  }

  getTorznabIndexer(id: number): TorznabIndexerRecord | null {
    const r = this.db.prepare('SELECT * FROM torznab_indexers WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapTorznabRow(r) : null;
  }

  createTorznabIndexer(input: {
    name: string;
    url: string;
    apiKey?: string;
    enabled?: boolean;
  }): TorznabIndexerRecord {
    const createdAt = Date.now();
    const enabled = input.enabled !== false;
    const res = this.db
      .prepare(
        `INSERT INTO torznab_indexers (name, url, api_key, enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.name.trim(), input.url.trim(), (input.apiKey || '').trim(), enabled ? 1 : 0, createdAt);
    return {
      id: Number(res.lastInsertRowid),
      name: input.name.trim(),
      url: input.url.trim(),
      apiKey: (input.apiKey || '').trim(),
      enabled,
      createdAt,
    };
  }

  updateTorznabIndexer(
    id: number,
    patch: Partial<{ name: string; url: string; apiKey: string; enabled: boolean }>
  ): TorznabIndexerRecord | null {
    const existing = this.getTorznabIndexer(id);
    if (!existing) return null;
    const next: TorznabIndexerRecord = {
      ...existing,
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      url: patch.url !== undefined ? patch.url.trim() : existing.url,
      apiKey: patch.apiKey !== undefined ? patch.apiKey.trim() : existing.apiKey,
      enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
    };
    this.db
      .prepare('UPDATE torznab_indexers SET name = ?, url = ?, api_key = ?, enabled = ? WHERE id = ?')
      .run(next.name, next.url, next.apiKey, next.enabled ? 1 : 0, id);
    return next;
  }

  deleteTorznabIndexer(id: number): void {
    this.db.prepare('DELETE FROM torznab_indexers WHERE id = ?').run(id);
  }

  // ---- RSS Auto-Subscriptions ----
  private mapRssSubRow(r: Record<string, unknown>): RssSubscriptionRecord {
    return {
      id: Number(r.id),
      name: String(r.name),
      feedUrl: String(r.feed_url),
      includeRegex: String(r.include_regex || ''),
      excludeRegex: String(r.exclude_regex || ''),
      minSizeMb: Number(r.min_size_mb || 0),
      maxSizeMb: Number(r.max_size_mb || 0),
      intervalMin: Number(r.interval_min || 30),
      sequential: Boolean(r.sequential),
      bingeMode: Boolean(r.binge_mode),
      enabled: Boolean(r.enabled),
      lastCheckedAt: r.last_checked_at === null ? null : Number(r.last_checked_at),
      lastError: String(r.last_error || ''),
      matchedCount: Number(r.matched_count || 0),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  listRssSubscriptions(): RssSubscriptionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM rss_subscriptions ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRssSubRow(r));
  }

  getRssSubscription(id: number): RssSubscriptionRecord | null {
    const r = this.db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapRssSubRow(r) : null;
  }

  createRssSubscription(input: {
    name: string;
    feedUrl: string;
    includeRegex?: string;
    excludeRegex?: string;
    minSizeMb?: number;
    maxSizeMb?: number;
    intervalMin?: number;
    sequential?: boolean;
    bingeMode?: boolean;
    enabled?: boolean;
  }): RssSubscriptionRecord {
    const now = Date.now();
    const intervalMin = Math.min(1440, Math.max(5, Math.round(input.intervalMin ?? 30)));
    const minSizeMb = Math.max(0, Math.round(input.minSizeMb ?? 0));
    const maxSizeMb = Math.max(0, Math.round(input.maxSizeMb ?? 0));
    const sequential = input.sequential !== false;
    const bingeMode = Boolean(input.bingeMode);
    const enabled = input.enabled !== false;

    const res = this.db
      .prepare(
        `INSERT INTO rss_subscriptions (
          name, feed_url, include_regex, exclude_regex, min_size_mb, max_size_mb,
          interval_min, sequential, binge_mode, enabled, last_checked_at, last_error,
          matched_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', 0, ?, ?)`
      )
      .run(
        input.name.trim(),
        input.feedUrl.trim(),
        (input.includeRegex || '').trim(),
        (input.excludeRegex || '').trim(),
        minSizeMb,
        maxSizeMb,
        intervalMin,
        sequential ? 1 : 0,
        bingeMode ? 1 : 0,
        enabled ? 1 : 0,
        now,
        now
      );

    return this.getRssSubscription(Number(res.lastInsertRowid))!;
  }

  updateRssSubscription(
    id: number,
    patch: Partial<{
      name: string;
      feedUrl: string;
      includeRegex: string;
      excludeRegex: string;
      minSizeMb: number;
      maxSizeMb: number;
      intervalMin: number;
      sequential: boolean;
      bingeMode: boolean;
      enabled: boolean;
    }>
  ): RssSubscriptionRecord | null {
    const existing = this.getRssSubscription(id);
    if (!existing) return null;
    const now = Date.now();
    const next = {
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      feedUrl: patch.feedUrl !== undefined ? patch.feedUrl.trim() : existing.feedUrl,
      includeRegex: patch.includeRegex !== undefined ? patch.includeRegex.trim() : existing.includeRegex,
      excludeRegex: patch.excludeRegex !== undefined ? patch.excludeRegex.trim() : existing.excludeRegex,
      minSizeMb: patch.minSizeMb !== undefined ? Math.max(0, Math.round(patch.minSizeMb)) : existing.minSizeMb,
      maxSizeMb: patch.maxSizeMb !== undefined ? Math.max(0, Math.round(patch.maxSizeMb)) : existing.maxSizeMb,
      intervalMin:
        patch.intervalMin !== undefined
          ? Math.min(1440, Math.max(5, Math.round(patch.intervalMin)))
          : existing.intervalMin,
      sequential: patch.sequential !== undefined ? patch.sequential : existing.sequential,
      bingeMode: patch.bingeMode !== undefined ? patch.bingeMode : existing.bingeMode,
      enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
    };
    this.db
      .prepare(
        `UPDATE rss_subscriptions SET
          name = ?, feed_url = ?, include_regex = ?, exclude_regex = ?,
          min_size_mb = ?, max_size_mb = ?, interval_min = ?,
          sequential = ?, binge_mode = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        next.name,
        next.feedUrl,
        next.includeRegex,
        next.excludeRegex,
        next.minSizeMb,
        next.maxSizeMb,
        next.intervalMin,
        next.sequential ? 1 : 0,
        next.bingeMode ? 1 : 0,
        next.enabled ? 1 : 0,
        now,
        id
      );
    return this.getRssSubscription(id);
  }

  recordRssCheckResult(id: number, checkedAt: number, errorMsg: string, addedMatches: number): void {
    this.db
      .prepare(
        `UPDATE rss_subscriptions
         SET last_checked_at = ?, last_error = ?, matched_count = matched_count + ?, updated_at = ?
         WHERE id = ?`
      )
      .run(checkedAt, errorMsg, addedMatches, checkedAt, id);
  }

  deleteRssSubscription(id: number): void {
    this.db.prepare('DELETE FROM rss_seen_items WHERE subscription_id = ?').run(id);
    this.db.prepare('DELETE FROM rss_subscriptions WHERE id = ?').run(id);
  }

  hasRssSeenItem(subscriptionId: number, itemGuid: string): boolean {
    const r = this.db
      .prepare('SELECT 1 FROM rss_seen_items WHERE subscription_id = ? AND item_guid = ?')
      .get(subscriptionId, itemGuid);
    return Boolean(r);
  }

  addRssSeenItem(entry: {
    subscriptionId: number;
    itemGuid: string;
    title: string;
    downloadUrl: string;
    sizeBytes: number;
    matched: boolean;
    pushed: boolean;
    reason: string;
    seenAt?: number;
  }): void {
    const seenAt = entry.seenAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO rss_seen_items (
          subscription_id, item_guid, title, download_url, size_bytes, matched, pushed, reason, seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subscription_id, item_guid) DO NOTHING`
      )
      .run(
        entry.subscriptionId,
        entry.itemGuid,
        entry.title,
        entry.downloadUrl,
        entry.sizeBytes,
        entry.matched ? 1 : 0,
        entry.pushed ? 1 : 0,
        entry.reason,
        seenAt
      );
  }

  listRssSeenItems(subscriptionId: number, limit = 60): RssSeenItemRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM rss_seen_items WHERE subscription_id = ? ORDER BY seen_at DESC LIMIT ?'
      )
      .all(subscriptionId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      subscriptionId: Number(r.subscription_id),
      itemGuid: String(r.item_guid),
      title: String(r.title),
      downloadUrl: String(r.download_url || ''),
      sizeBytes: Number(r.size_bytes || 0),
      matched: Boolean(r.matched),
      pushed: Boolean(r.pushed),
      reason: String(r.reason || ''),
      seenAt: Number(r.seen_at),
    }));
  }
}
