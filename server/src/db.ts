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
    this.defaults = { ...defaults };
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

    return {
      storageLimitGb: Math.max(0.0001, num('storageLimitGb', this.defaults.storageLimitGb)),
      autoDeleteDelayHours: Math.max(0, num('autoDeleteDelayHours', this.defaults.autoDeleteDelayHours)),
      watchedThreshold: Math.min(0.99, Math.max(0.5, num('watchedThreshold', this.defaults.watchedThreshold))),
      uploadLimitKbps: Math.max(0, num('uploadLimitKbps', this.defaults.uploadLimitKbps)),
      autoCleanupEnabled: bool('autoCleanupEnabled', this.defaults.autoCleanupEnabled),
      stopSeedingOnComplete: bool('stopSeedingOnComplete', this.defaults.stopSeedingOnComplete),
    };
  }

  updateSettings(partial: Partial<AppSettings>): AppSettings {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const entries: Array<[string, string]> = [];
    if (partial.storageLimitGb !== undefined) entries.push(['storageLimitGb', String(partial.storageLimitGb)]);
    if (partial.autoDeleteDelayHours !== undefined)
      entries.push(['autoDeleteDelayHours', String(partial.autoDeleteDelayHours)]);
    if (partial.watchedThreshold !== undefined)
      entries.push(['watchedThreshold', String(partial.watchedThreshold)]);
    if (partial.uploadLimitKbps !== undefined)
      entries.push(['uploadLimitKbps', String(partial.uploadLimitKbps)]);
    if (partial.autoCleanupEnabled !== undefined)
      entries.push(['autoCleanupEnabled', String(partial.autoCleanupEnabled)]);
    if (partial.stopSeedingOnComplete !== undefined)
      entries.push(['stopSeedingOnComplete', String(partial.stopSeedingOnComplete)]);

    for (const [k, v] of entries) {
      stmt.run(k, v);
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
    this.db
      .prepare('DELETE FROM media_items WHERE torrent_hash = ?')
      .run(torrentHash.toLowerCase());
  }

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
