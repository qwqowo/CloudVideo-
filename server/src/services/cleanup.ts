import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { AppDatabase, MediaItemRecord } from '../db.js';
import type { IQBittorrentClient } from './qbittorrent.js';
import { isVideoFile, resolveSafePath } from './media.js';

export interface StorageStats {
  usedBytes: number;
  limitBytes: number;
  usagePercent: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
  pendingDeleteCount: number;
}

export interface CleanupRunResult {
  deletedItems: Array<{ torrentHash: string; fileIndex: number; relativePath: string; reason: string }>;
  deletedTorrents: string[];
  freedBytes: number;
  storageAfter: StorageStats;
}

const ACTIVE_PLAYBACK_PROTECT_MS = 2 * 60 * 1000; // Do not LRU-evict items actively played in last 2 min

async function sumDirectorySize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await sumDirectorySize(full);
      } else if (entry.isFile()) {
        try {
          const st = await fs.stat(full);
          total += st.size;
        } catch {
          // file may have been removed concurrently
        }
      }
    }
  } catch {
    // directory may not exist yet
  }
  return total;
}

async function removeEmptyParentDirs(filePath: string, rootDir: string): Promise<void> {
  const root = path.resolve(rootDir);
  let cur = path.dirname(path.resolve(filePath));
  while (cur.startsWith(root + path.sep) && cur !== root) {
    try {
      const entries = await fs.readdir(cur);
      if (entries.length === 0) {
        await fs.rmdir(cur);
        cur = path.dirname(cur);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

export class CleanupService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private config: AppConfig,
    private db: AppDatabase,
    private qbit: IQBittorrentClient
  ) {}

  startScheduler(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runCleanupCycle().catch((err) => {
        console.error('[Cleanup] Scheduled cycle error:', err);
      });
    }, intervalMs);
    this.timer.unref();
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async getStorageStats(): Promise<StorageStats> {
    await fs.mkdir(this.config.downloadDir, { recursive: true });
    const usedBytes = await sumDirectorySize(this.config.downloadDir);
    const settings = this.db.getSettings();
    const limitBytes = Math.round(settings.storageLimitGb * 1024 * 1024 * 1024);

    let diskFreeBytes = 0;
    let diskTotalBytes = 0;
    try {
      const st = await fs.statfs(this.config.downloadDir);
      diskFreeBytes = Number(st.bavail) * Number(st.bsize);
      diskTotalBytes = Number(st.blocks) * Number(st.bsize);
    } catch {
      // ignore if unsupported
    }

    const pendingDeleteCount = this.db
      .listMediaItems()
      .filter((m) => !m.removedFile && !m.pinned && m.deleteAfterAt !== null).length;

    return {
      usedBytes,
      limitBytes,
      usagePercent: limitBytes > 0 ? Math.min(100, Number(((usedBytes / limitBytes) * 100).toFixed(1))) : 0,
      diskFreeBytes,
      diskTotalBytes,
      pendingDeleteCount,
    };
  }

  async recordProgress(params: {
    torrentHash: string;
    fileIndex: number;
    positionSec: number;
    durationSec: number;
    relativePath?: string;
    sizeBytes?: number;
    now?: number;
  }): Promise<{ item: MediaItemRecord; unloadedImmediately: boolean }> {
    const now = params.now ?? Date.now();
    const settings = this.db.getSettings();
    const existing = this.db.getMediaItem(params.torrentHash, params.fileIndex);

    const duration = params.durationSec > 0 ? params.durationSec : (existing?.durationSec ?? 0);
    const progress =
      duration > 0 ? Math.min(1, Math.max(0, params.positionSec / duration)) : (existing?.progress ?? 0);

    let watchedAt = existing?.watchedAt ?? null;
    let deleteAfterAt = existing?.deleteAfterAt ?? null;

    if (progress >= settings.watchedThreshold && watchedAt === null) {
      watchedAt = now;
      if (settings.autoCleanupEnabled && !(existing?.pinned)) {
        deleteAfterAt = now + Math.round(settings.autoDeleteDelayHours * 3600 * 1000);
      }
    }

    const item = this.db.upsertMediaItem({
      torrentHash: params.torrentHash,
      fileIndex: params.fileIndex,
      relativePath: params.relativePath ?? existing?.relativePath,
      sizeBytes: params.sizeBytes ?? existing?.sizeBytes,
      durationSec: duration,
      positionSec: params.positionSec,
      progress,
      watchedAt,
      deleteAfterAt,
      lastPlayedAt: now,
      now,
    });

    if (
      settings.autoCleanupEnabled &&
      !item.pinned &&
      item.deleteAfterAt !== null &&
      item.deleteAfterAt <= now
    ) {
      await this.unloadFile(item.torrentHash, item.fileIndex);
      const updated = this.db.getMediaItem(item.torrentHash, item.fileIndex) ?? item;
      return { item: updated, unloadedImmediately: true };
    }

    return { item, unloadedImmediately: false };
  }

  async markWatched(
    torrentHash: string,
    fileIndex: number,
    options: { immediate?: boolean; relativePath?: string; sizeBytes?: number; now?: number } = {}
  ): Promise<{ item: MediaItemRecord | null; unloadedImmediately: boolean }> {
    const now = options.now ?? Date.now();
    const settings = this.db.getSettings();
    const existing = this.db.getMediaItem(torrentHash, fileIndex);
    const delayMs = options.immediate ? 0 : Math.round(settings.autoDeleteDelayHours * 3600 * 1000);

    const item = this.db.upsertMediaItem({
      torrentHash,
      fileIndex,
      relativePath: options.relativePath ?? existing?.relativePath,
      sizeBytes: options.sizeBytes ?? existing?.sizeBytes,
      progress: 1,
      watchedAt: existing?.watchedAt ?? now,
      deleteAfterAt: options.immediate || settings.autoCleanupEnabled ? now + delayMs : existing?.deleteAfterAt ?? null,
      pinned: options.immediate ? false : existing?.pinned ?? false,
      lastPlayedAt: now,
      now,
    });

    if (options.immediate || (settings.autoCleanupEnabled && !item.pinned && delayMs === 0)) {
      await this.unloadFile(item.torrentHash, item.fileIndex);
      return {
        item: this.db.getMediaItem(item.torrentHash, item.fileIndex),
        unloadedImmediately: true,
      };
    }

    return { item, unloadedImmediately: false };
  }

  setPinned(torrentHash: string, fileIndex: number, pinned: boolean, relativePath?: string, sizeBytes?: number): MediaItemRecord {
    return this.db.upsertMediaItem({
      torrentHash,
      fileIndex,
      relativePath,
      sizeBytes,
      pinned,
      deleteAfterAt: pinned ? null : undefined,
    });
  }

  cancelScheduledDelete(torrentHash: string, fileIndex: number): MediaItemRecord | null {
    const existing = this.db.getMediaItem(torrentHash, fileIndex);
    if (!existing) return null;
    return this.db.upsertMediaItem({
      torrentHash,
      fileIndex,
      deleteAfterAt: null,
    });
  }

  async unloadFile(
    torrentHash: string,
    fileIndex: number
  ): Promise<{ freedBytes: number; deletedTorrent: boolean }> {
    const hash = torrentHash.toLowerCase();
    let freedBytes = 0;
    let relativePath = this.db.getMediaItem(hash, fileIndex)?.relativePath || '';

    let files: Awaited<ReturnType<IQBittorrentClient['getTorrentFiles']>> = [];
    try {
      files = await this.qbit.getTorrentFiles(hash);
      const target = files.find((f) => f.index === fileIndex);
      if (target) {
        relativePath = target.name;
      }
      // Stop qBittorrent from downloading this episode/file again
      await this.qbit.setFilePriority(hash, [fileIndex], 0);
    } catch {
      // torrent might already be absent from qBittorrent
    }

    if (relativePath) {
      try {
        const abs = resolveSafePath(this.config.downloadDir, relativePath);
        const st = await fs.stat(abs).catch(() => null);
        if (st?.isFile()) {
          freedBytes = st.size;
          await fs.unlink(abs);
          await removeEmptyParentDirs(abs, this.config.downloadDir);
        }
      } catch {
        // ignore if already removed
      }
    }

    this.db.upsertMediaItem({
      torrentHash: hash,
      fileIndex,
      relativePath,
      removedFile: true,
      deleteAfterAt: null,
      deletedAt: Date.now(),
    });

    // Check if all selected video files in this torrent are now gone -> remove whole torrent
    let deletedTorrent = false;
    if (files.length > 0) {
      const videoFiles = files.filter((f) => isVideoFile(f.name));
      const checkList = videoFiles.length > 0 ? videoFiles : files;
      let anyRemaining = false;

      for (const f of checkList) {
        if (f.index === fileIndex) continue;
        if (f.priority === 0) continue;
        const dbRec = this.db.getMediaItem(hash, f.index);
        if (dbRec?.removedFile) continue;
        anyRemaining = true;
        break;
      }

      if (!anyRemaining) {
        try {
          await this.qbit.deleteTorrents([hash], true);
          this.db.deleteTorrentRecords(hash);
          deletedTorrent = true;
        } catch {
          // ignore
        }
      }
    }

    return { freedBytes, deletedTorrent };
  }

  async unloadTorrent(torrentHash: string): Promise<{ freedBytes: number }> {
    const hash = torrentHash.toLowerCase();
    let freedBytes = 0;
    try {
      const files = await this.qbit.getTorrentFiles(hash);
      for (const f of files) {
        try {
          const abs = resolveSafePath(this.config.downloadDir, f.name);
          const st = await fs.stat(abs).catch(() => null);
          if (st?.isFile()) freedBytes += st.size;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    await this.qbit.deleteTorrents([hash], true);
    this.db.deleteTorrentRecords(hash);
    return { freedBytes };
  }

  async runCleanupCycle(options: { forceWatchedNow?: boolean; now?: number } = {}): Promise<CleanupRunResult> {
    if (this.running) {
      return {
        deletedItems: [],
        deletedTorrents: [],
        freedBytes: 0,
        storageAfter: await this.getStorageStats(),
      };
    }

    this.running = true;
    const now = options.now ?? Date.now();
    const deletedItems: CleanupRunResult['deletedItems'] = [];
    const deletedTorrents: string[] = [];
    let freedBytes = 0;

    try {
      const settings = this.db.getSettings();

      // Sync active torrents from qBittorrent so we can sweep orphans and also find unrecorded files for LRU
      let activeTorrents: Awaited<ReturnType<IQBittorrentClient['listTorrents']>> = [];
      let qbitReachable = true;
      try {
        activeTorrents = await this.qbit.listTorrents();
      } catch {
        qbitReachable = false;
      }

      if (qbitReachable) {
        const activeHashSet = new Set(activeTorrents.map((t) => t.hash.toLowerCase()));
        const dbItems = this.db.listMediaItems();
        const orphanHashes = new Set<string>();
        for (const item of dbItems) {
          if (!activeHashSet.has(item.torrentHash)) {
            orphanHashes.add(item.torrentHash);
          }
        }
        for (const h of orphanHashes) {
          this.db.deleteTorrentRecords(h);
        }
      }

      // Phase 1: Delete items whose scheduled delete_after_at has expired (or forced watched cleanup)
      if (settings.autoCleanupEnabled || options.forceWatchedNow) {
        const items = this.db.listMediaItems();
        for (const item of items) {
          if (item.removedFile || item.pinned) continue;
          const dueBySchedule = item.deleteAfterAt !== null && item.deleteAfterAt <= now;
          const dueByForce = Boolean(options.forceWatchedNow && item.watchedAt !== null);
          if (dueBySchedule || dueByForce) {
            const res = await this.unloadFile(item.torrentHash, item.fileIndex);
            freedBytes += res.freedBytes;
            deletedItems.push({
              torrentHash: item.torrentHash,
              fileIndex: item.fileIndex,
              relativePath: item.relativePath,
              reason: dueByForce ? 'manual_watched_cleanup' : 'watched_delay_expired',
            });
            if (res.deletedTorrent) deletedTorrents.push(item.torrentHash);
          }
        }
      }

      // Phase 2: Storage watermark LRU eviction when usedBytes > limitBytes
      let stats = await this.getStorageStats();
      const targetBytes = Math.round(stats.limitBytes * 0.85);

      if (settings.autoCleanupEnabled && stats.usedBytes > stats.limitBytes && qbitReachable) {
        type Candidate = {
          torrentHash: string;
          fileIndex: number;
          relativePath: string;
          priorityBucket: number; // 0 = scheduled, 1 = watched, 2 = LRU unwatched
          sortTime: number;
        };

        const candidates: Candidate[] = [];
        for (const t of activeTorrents) {
          let files: Awaited<ReturnType<IQBittorrentClient['getTorrentFiles']>> = [];
          try {
            files = await this.qbit.getTorrentFiles(t.hash);
          } catch {
            continue;
          }
          for (const f of files) {
            if (f.priority === 0) continue;
            const dbRec = this.db.getMediaItem(t.hash, f.index);
            if (dbRec?.pinned || dbRec?.removedFile) continue;
            if (dbRec?.lastPlayedAt && now - dbRec.lastPlayedAt < ACTIVE_PLAYBACK_PROTECT_MS) {
              continue;
            }

            // Ensure file actually exists on disk
            try {
              const abs = resolveSafePath(this.config.downloadDir, f.name);
              const st = await fs.stat(abs).catch(() => null);
              if (!st?.isFile() || st.size === 0) continue;
            } catch {
              continue;
            }

            let priorityBucket = 2;
            let sortTime = dbRec?.lastPlayedAt ?? dbRec?.createdAt ?? t.added_on * 1000;
            if (dbRec?.deleteAfterAt !== null && dbRec?.deleteAfterAt !== undefined) {
              priorityBucket = 0;
              sortTime = dbRec.deleteAfterAt;
            } else if (dbRec?.watchedAt !== null && dbRec?.watchedAt !== undefined) {
              priorityBucket = 1;
              sortTime = dbRec.watchedAt;
            }

            candidates.push({
              torrentHash: t.hash,
              fileIndex: f.index,
              relativePath: f.name,
              priorityBucket,
              sortTime,
            });
          }
        }

        candidates.sort((a, b) =>
          a.priorityBucket !== b.priorityBucket
            ? a.priorityBucket - b.priorityBucket
            : a.sortTime - b.sortTime
        );

        for (const c of candidates) {
          if (stats.usedBytes <= targetBytes) break;
          const res = await this.unloadFile(c.torrentHash, c.fileIndex);
          freedBytes += res.freedBytes;
          deletedItems.push({
            torrentHash: c.torrentHash,
            fileIndex: c.fileIndex,
            relativePath: c.relativePath,
            reason: 'storage_limit_lru',
          });
          if (res.deletedTorrent) deletedTorrents.push(c.torrentHash);
          stats = await this.getStorageStats();
        }
      }

      return {
        deletedItems,
        deletedTorrents,
        freedBytes,
        storageAfter: await this.getStorageStats(),
      };
    } finally {
      this.running = false;
    }
  }
}
