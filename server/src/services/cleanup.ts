import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { AppDatabase, MediaItemRecord } from '../db.js';
import type { IQBittorrentClient } from './qbittorrent.js';
import type { NotifierService } from './notifier.js';
import { isVideoFile, resolveSafePath } from './media.js';
import { classifyMediaCategory } from './tmdb.js';

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

const ACTIVE_PLAYBACK_PROTECT_MS = 2 * 60 * 1000;
const BINGE_PRELOAD_THRESHOLD = 0.7;

export function sortVideoFilesNaturally<T extends { name: string; index: number }>(files: T[]): T[] {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

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
          // ignore concurrent deletion
        }
      }
    }
  } catch {
    // ignore missing dir
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
  private seenIncomplete = new Set<string>();

  constructor(
    private config: AppConfig,
    private db: AppDatabase,
    private qbit: IQBittorrentClient,
    private notifier?: NotifierService
  ) {}

  startScheduler(intervalMs = 30_000): void {
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

  /**
   * Reconciles any torrent configured with Small-Disk Binge Mode:
   * Once metadata resolves, keeps only the first N video episodes active (priority=1)
   * and sets remaining episodes to priority=0 before resuming download.
   */
  async reconcileBingeTorrents(targetHash?: string): Promise<number> {
    let initializedCount = 0;
    const policies = targetHash
      ? [this.db.getTorrentPolicy(targetHash)].filter((p): p is NonNullable<typeof p> => Boolean(p))
      : this.db.listTorrentPolicies();

    for (const policy of policies) {
      if (!policy.bingeMode || policy.initialized) continue;
      let files: Awaited<ReturnType<IQBittorrentClient['getTorrentFiles']>> = [];
      try {
        files = await this.qbit.getTorrentFiles(policy.torrentHash);
      } catch {
        continue;
      }
      if (files.length === 0) continue;

      const videos = sortVideoFilesNaturally(files.filter((f) => isVideoFile(f.name)));
      if (videos.length === 0) {
        this.db.upsertTorrentPolicy({ torrentHash: policy.torrentHash, initialized: true });
        continue;
      }

      const windowSize = Math.max(1, policy.bingeWindow);
      const enableIndices = videos.slice(0, windowSize).map((v) => v.index);
      const disableIndices = videos.slice(windowSize).map((v) => v.index);

      if (disableIndices.length > 0) {
        await this.qbit.setFilePriority(policy.torrentHash, disableIndices, 0);
      }
      if (enableIndices.length > 0) {
        await this.qbit.setFilePriority(policy.torrentHash, enableIndices, 1);
      }

      await this.qbit.resumeTorrents([policy.torrentHash]).catch(() => {});
      this.db.upsertTorrentPolicy({ torrentHash: policy.torrentHash, initialized: true });
      initializedCount++;
    }

    return initializedCount;
  }

  /**
   * When watching an episode in a binge-mode torrent and passing 70% progress,
   * automatically enable downloading of the next disabled episode.
   */
  async maybePreloadNextEpisode(
    torrentHash: string,
    currentFileIndex: number,
    progress: number
  ): Promise<{ preloadedIndex: number; preloadedName: string } | null> {
    if (progress < BINGE_PRELOAD_THRESHOLD) return null;
    const policy = this.db.getTorrentPolicy(torrentHash);
    if (!policy?.bingeMode) return null;

    let files: Awaited<ReturnType<IQBittorrentClient['getTorrentFiles']>> = [];
    try {
      files = await this.qbit.getTorrentFiles(torrentHash);
    } catch {
      return null;
    }

    const videos = sortVideoFilesNaturally(files.filter((f) => isVideoFile(f.name)));
    const curPos = videos.findIndex((v) => v.index === currentFileIndex);
    if (curPos === -1 || curPos >= videos.length - 1) return null;

    for (let i = curPos + 1; i < videos.length; i++) {
      const candidate = videos[i];
      const rec = this.db.getMediaItem(torrentHash, candidate.index);
      if (rec?.watchedAt || rec?.removedFile) continue;
      if (candidate.priority === 0) {
        await this.qbit.setFilePriority(torrentHash, [candidate.index], 1);
        await this.qbit.resumeTorrents([torrentHash]).catch(() => {});
        return { preloadedIndex: candidate.index, preloadedName: candidate.name };
      }
      // Next episode is already downloading or ready
      return null;
    }
    return null;
  }

  async recordProgress(params: {
    torrentHash: string;
    fileIndex: number;
    positionSec: number;
    durationSec: number;
    relativePath?: string;
    sizeBytes?: number;
    now?: number;
  }): Promise<{
    item: MediaItemRecord;
    unloadedImmediately: boolean;
    preloadedNext: { preloadedIndex: number; preloadedName: string } | null;
  }> {
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
      if (settings.autoCleanupEnabled && !existing?.pinned) {
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

    // Record permanent watch history (survives auto-unload!)
    if (params.positionSec >= 5 || progress >= 0.02 || watchedAt !== null) {
      const tmdbRec = this.db.getTmdbCache(item.torrentHash);
      const shortFile = (item.relativePath || '').split('/').pop() || item.relativePath || '未知影片';
      this.db.upsertWatchHistory({
        torrentHash: item.torrentHash,
        fileIndex: item.fileIndex,
        title: tmdbRec?.title || shortFile,
        fileName: shortFile,
        mediaCategory: classifyMediaCategory({
          tmdb: tmdbRec,
          rawName: item.relativePath || shortFile,
          videoCount: 1,
        }),
        posterUrl: tmdbRec?.posterUrl || '',
        backdropUrl: tmdbRec?.backdropUrl || '',
        year: tmdbRec?.year || '',
        rating: tmdbRec?.rating || 0,
        durationSec: duration,
        positionSec: params.positionSec,
        progress,
        completed: watchedAt !== null,
        now,
      });
    }

    const preloadedNext = await this.maybePreloadNextEpisode(
      item.torrentHash,
      item.fileIndex,
      progress
    ).catch(() => null);

    if (
      settings.autoCleanupEnabled &&
      !item.pinned &&
      item.deleteAfterAt !== null &&
      item.deleteAfterAt <= now
    ) {
      await this.unloadFile(item.torrentHash, item.fileIndex, 'watched_immediate');
      const updated = this.db.getMediaItem(item.torrentHash, item.fileIndex) ?? item;
      return { item: updated, unloadedImmediately: true, preloadedNext };
    }

    return { item, unloadedImmediately: false, preloadedNext };
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
      deleteAfterAt:
        options.immediate || settings.autoCleanupEnabled ? now + delayMs : existing?.deleteAfterAt ?? null,
      pinned: options.immediate ? false : existing?.pinned ?? false,
      lastPlayedAt: now,
      now,
    });

    const tmdbRec = this.db.getTmdbCache(item.torrentHash);
    const shortFile = (item.relativePath || '').split('/').pop() || item.relativePath || '未知影片';
    this.db.upsertWatchHistory({
      torrentHash: item.torrentHash,
      fileIndex: item.fileIndex,
      title: tmdbRec?.title || shortFile,
      fileName: shortFile,
      mediaCategory: classifyMediaCategory({
        tmdb: tmdbRec,
        rawName: item.relativePath || shortFile,
        videoCount: 1,
      }),
      posterUrl: tmdbRec?.posterUrl || '',
      backdropUrl: tmdbRec?.backdropUrl || '',
      year: tmdbRec?.year || '',
      rating: tmdbRec?.rating || 0,
      durationSec: item.durationSec,
      positionSec: item.durationSec || item.positionSec,
      progress: 1,
      completed: true,
      now,
    });

    await this.maybePreloadNextEpisode(torrentHash, fileIndex, 1).catch(() => {});

    if (options.immediate || (settings.autoCleanupEnabled && !item.pinned && delayMs === 0)) {
      await this.unloadFile(
        item.torrentHash,
        item.fileIndex,
        options.immediate ? 'manual_unload' : 'watched_immediate'
      );
      return {
        item: this.db.getMediaItem(item.torrentHash, item.fileIndex),
        unloadedImmediately: true,
      };
    }

    return { item, unloadedImmediately: false };
  }

  setPinned(
    torrentHash: string,
    fileIndex: number,
    pinned: boolean,
    relativePath?: string,
    sizeBytes?: number
  ): MediaItemRecord {
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

  private async removeFileArtifacts(hash: string, fileIndex: number): Promise<void> {
    // Clean multi-slot thumbnails
    try {
      const thumbDir = path.join(this.config.dataDir, 'thumbs');
      const names = await fs.readdir(thumbDir);
      await Promise.all(
        names
          .filter((n) => n.startsWith(`${hash}_${fileIndex}`))
          .map((n) => fs.unlink(path.join(thumbDir, n)).catch(() => {}))
      );
    } catch {
      // ignore
    }

    // Clean uploaded custom subtitles for this file
    const subs = this.db.deleteCustomSubtitlesForFile(hash, fileIndex);
    for (const s of subs) {
      await fs.unlink(s.filePath).catch(() => {});
    }
  }

  async unloadFile(
    torrentHash: string,
    fileIndex: number,
    reason = 'manual_unload'
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
      await this.qbit.setFilePriority(hash, [fileIndex], 0);
    } catch {
      // torrent might already be absent
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

    this.db.addCleanupLog({
      torrentHash: hash,
      relativePath: relativePath || `#${fileIndex}`,
      reason,
      freedBytes,
    });

    await this.removeFileArtifacts(hash, fileIndex);

    // Check if all video files in this torrent are now watched/removed or disabled
    let deletedTorrent = false;
    if (files.length > 0) {
      const policy = this.db.getTorrentPolicy(hash);
      const videoFiles = files.filter((f) => isVideoFile(f.name));
      const checkList = videoFiles.length > 0 ? videoFiles : files;
      let anyRemaining = false;

      for (const f of checkList) {
        if (f.index === fileIndex) continue;
        const dbRec = this.db.getMediaItem(hash, f.index);
        if (dbRec?.removedFile) continue;
        // In binge mode, keep torrent alive if there are still unwatched episodes left (even with priority=0)
        if (policy?.bingeMode && !dbRec?.watchedAt) {
          anyRemaining = true;
          break;
        }
        if (f.priority === 0) continue;
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

  async unloadTorrent(torrentHash: string, reason = 'manual_torrent_unload'): Promise<{ freedBytes: number }> {
    const hash = torrentHash.toLowerCase();
    let freedBytes = 0;
    let label = hash;
    try {
      const torrents = await this.qbit.listTorrents();
      const found = torrents.find((t) => t.hash === hash);
      if (found?.name) label = found.name;
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

    const customSubs = this.db.listCustomSubtitles(hash);
    for (const s of customSubs) {
      await fs.unlink(s.filePath).catch(() => {});
    }

    await this.qbit.deleteTorrents([hash], true);
    this.db.deleteTorrentRecords(hash);
    this.db.addCleanupLog({
      torrentHash: hash,
      relativePath: label,
      reason,
      freedBytes,
    });

    try {
      const thumbDir = path.join(this.config.dataDir, 'thumbs');
      const names = await fs.readdir(thumbDir);
      await Promise.all(
        names
          .filter((n) => n.startsWith(`${hash}_`))
          .map((n) => fs.unlink(path.join(thumbDir, n)).catch(() => {}))
      );
    } catch {
      // ignore
    }

    return { freedBytes };
  }

  private async checkDownloadNotifications(
    activeTorrents: Awaited<ReturnType<IQBittorrentClient['listTorrents']>>
  ): Promise<void> {
    if (!this.notifier) return;
    for (const t of activeTorrents) {
      const hash = t.hash.toLowerCase();
      if (t.progress < 1) {
        this.seenIncomplete.add(hash);
        continue;
      }
      if (!this.seenIncomplete.has(hash)) continue;
      const policy = this.db.getTorrentPolicy(hash);
      if (policy?.completedNotified) {
        this.seenIncomplete.delete(hash);
        continue;
      }
      this.seenIncomplete.delete(hash);
      this.db.upsertTorrentPolicy({ torrentHash: hash, completedNotified: true });
      const gb = (t.size / (1024 * 1024 * 1024)).toFixed(2);
      const linkLine = this.config.publicBaseUrl ? `\n直达影院：${this.config.publicBaseUrl}` : '';
      await this.notifier
        .send({
          event: 'download_complete',
          title: '下载完成 · 可立即播放',
          message: `片源：${t.name}\n体积：${gb} GB${linkLine}`,
          torrentName: t.name,
          sizeBytes: t.size,
        })
        .catch(() => {});
    }
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

      let activeTorrents: Awaited<ReturnType<IQBittorrentClient['listTorrents']>> = [];
      let qbitReachable = true;
      try {
        activeTorrents = await this.qbit.listTorrents();
      } catch {
        qbitReachable = false;
      }

      if (qbitReachable) {
        await this.reconcileBingeTorrents().catch(() => {});
        await this.checkDownloadNotifications(activeTorrents).catch(() => {});

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
            const reason = dueByForce ? 'manual_watched_cleanup' : 'watched_delay_expired';
            const res = await this.unloadFile(item.torrentHash, item.fileIndex, reason);
            freedBytes += res.freedBytes;
            deletedItems.push({
              torrentHash: item.torrentHash,
              fileIndex: item.fileIndex,
              relativePath: item.relativePath,
              reason,
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
          priorityBucket: number;
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
          const res = await this.unloadFile(c.torrentHash, c.fileIndex, 'storage_limit_lru');
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
