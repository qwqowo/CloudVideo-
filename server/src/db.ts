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
  fetchedAt: number;
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

  constructor(dbPath: string, defaults: AppConfig['defaults']) {
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
    `);
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
          rating, poster_url, backdrop_url, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        rec.fetchedAt
      );
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
}
