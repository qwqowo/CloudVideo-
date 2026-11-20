import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildApp, type AppContext } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type {
  AddTorrentOptions,
  IQBittorrentClient,
  QBitFile,
  QBitTorrent,
  QBitTransferInfo,
} from '../src/services/qbittorrent.js';
import { resolveSafePath } from '../src/services/media.js';
import { signStreamToken, verifyStreamToken } from '../src/auth.js';

const execFileAsync = promisify(execFile);

class MockQBitClient implements IQBittorrentClient {
  torrents = new Map<string, QBitTorrent>();
  files = new Map<string, QBitFile[]>();
  deletedHashes: string[] = [];
  appliedPrefs: Array<{ uploadLimitKbps: number; stopOnComplete: boolean }> = [];

  seed(torrent: QBitTorrent, fileList: QBitFile[]) {
    const hash = torrent.hash.toLowerCase();
    this.torrents.set(hash, { ...torrent, hash });
    this.files.set(hash, fileList.map((f) => ({ ...f })));
  }

  async checkHealth() {
    return { connected: true, version: 'v5.0.0-mock' };
  }

  async listTorrents(): Promise<QBitTorrent[]> {
    return Array.from(this.torrents.values());
  }

  async getTorrentFiles(hash: string): Promise<QBitFile[]> {
    const list = this.files.get(hash.toLowerCase());
    if (!list) throw new Error('Torrent not found');
    return list.map((f) => ({ ...f }));
  }

  async getTransferInfo(): Promise<QBitTransferInfo> {
    return {
      dl_info_speed: 2_500_000,
      up_info_speed: 120_000,
      dl_info_data: 100_000_000,
      up_info_data: 5_000_000,
      connection_status: 'connected',
    };
  }

  async addMagnet(_magnet: string, _opts?: AddTorrentOptions): Promise<void> {}
  async addTorrentFile(_buffer: Buffer, _filename: string, _opts?: AddTorrentOptions): Promise<void> {}

  async setFilePriority(hash: string, fileIndices: number[], priority: 0 | 1 | 6 | 7): Promise<void> {
    const list = this.files.get(hash.toLowerCase());
    if (!list) return;
    for (const f of list) {
      if (fileIndices.includes(f.index)) f.priority = priority;
    }
  }

  async pauseTorrents(_hashes: string[]): Promise<void> {}
  async resumeTorrents(_hashes: string[]): Promise<void> {}
  async toggleSequential(_hash: string): Promise<void> {}
  async toggleFirstLastPiecePrio(_hash: string): Promise<void> {}

  async deleteTorrents(hashes: string[], _deleteFiles: boolean): Promise<void> {
    for (const h of hashes) {
      const lower = h.toLowerCase();
      this.deletedHashes.push(lower);
      this.torrents.delete(lower);
      this.files.delete(lower);
    }
  }

  async applyPreferences(uploadLimitKbps: number, stopOnComplete: boolean): Promise<void> {
    this.appliedPrefs.push({ uploadLimitKbps, stopOnComplete });
  }
}

describe('CloudVideo Backend Integration Suite', () => {
  let tmpDir: string;
  let downloadDir: string;
  let dataDir: string;
  let qbit: MockQBitClient;
  let ctx: AppContext;
  let config: AppConfig;
  let cookieHeader: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudvideo-test-'));
    downloadDir = path.join(tmpDir, 'downloads');
    dataDir = path.join(tmpDir, 'data');
    await fs.mkdir(downloadDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    config = {
      port: 0,
      host: '127.0.0.1',
      appPassword: 'super-secret-password',
      jwtSecret: 'unit-test-jwt-secret-key-1234567890',
      qbitUrl: 'http://127.0.0.1:8080',
      qbitUsername: '',
      qbitPassword: '',
      downloadDir,
      dataDir,
      webDistDir: path.join(tmpDir, 'nonexistent-web-dist'),
      publicBaseUrl: 'http://video.test:3000',
      defaults: {
        storageLimitGb: 45,
        autoDeleteDelayHours: 24,
        watchedThreshold: 0.9,
        uploadLimitKbps: 512,
        autoCleanupEnabled: true,
        stopSeedingOnComplete: true,
      },
    };

    qbit = new MockQBitClient();
    ctx = await buildApp(config, { qbit, startScheduler: false });
  });

  after(async () => {
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated requests and authenticates via password login', async () => {
    const unauth = await ctx.app.inject({ method: 'GET', url: '/api/torrents' });
    assert.equal(unauth.statusCode, 401);

    const badLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong' },
    });
    assert.equal(badLogin.statusCode, 401);

    const okLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: config.appPassword },
    });
    assert.equal(okLogin.statusCode, 200);
    const setCookie = okLogin.headers['set-cookie'];
    assert.ok(setCookie);
    cookieHeader = Array.isArray(setCookie) ? setCookie[0].split(';')[0] : setCookie.split(';')[0];

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookieHeader },
    });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json(), { authenticated: true });
  });

  it('validates signed stream tokens and blocks path traversal', () => {
    const token = signStreamToken(config.jwtSecret, 'abc12345', 2, 600);
    assert.equal(verifyStreamToken(token, config.jwtSecret, 'ABC12345', 2), true);
    assert.equal(verifyStreamToken(token, config.jwtSecret, 'abc12345', 3), false);
    assert.equal(verifyStreamToken(`${token}tampered`, config.jwtSecret, 'abc12345', 2), false);

    assert.throws(() => resolveSafePath(downloadDir, '../../etc/passwd'));
    assert.equal(
      resolveSafePath(downloadDir, 'show/ep01.mkv'),
      path.join(downloadDir, 'show', 'ep01.mkv')
    );
  });

  it('probes MP4/MKV with ffprobe, serves Range 206 direct play, lossless FFmpeg remux, and WebVTT subtitles', async () => {
    const showDir = path.join(downloadDir, 'demo-show');
    await fs.mkdir(showDir, { recursive: true });
    const mp4Path = path.join(showDir, 'clip.mp4');
    const mkvPath = path.join(showDir, 'clip_ac3.mkv');
    const srtPath = path.join(showDir, 'clip_ac3.srt');

    // Generate 2-second test clips via local ffmpeg
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x180:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      mp4Path,
    ]);

    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x180:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'ac3',
      mkvPath,
    ]);

    await fs.writeFile(
      srtPath,
      '1\n00:00:00,100 --> 00:00:01,500\n你好 CloudVideo 测试字幕\n',
      'utf8'
    );

    const mp4Stat = await fs.stat(mp4Path);
    const mkvStat = await fs.stat(mkvPath);
    const hash = '1111111111111111111111111111111111111111';

    qbit.seed(
      {
        hash,
        name: 'Demo Show',
        size: mp4Stat.size + mkvStat.size,
        downloaded: mp4Stat.size + mkvStat.size,
        amount_left: 0,
        progress: 1,
        dlspeed: 0,
        upspeed: 0,
        state: 'pausedUP',
        eta: 0,
        added_on: Math.floor(Date.now() / 1000),
        completion_on: Math.floor(Date.now() / 1000),
        save_path: downloadDir,
        content_path: showDir,
        seq_dl: true,
        f_l_piece_prio: true,
        num_seeds: 5,
        num_leechs: 1,
        ratio: 0,
      },
      [
        { index: 0, name: 'demo-show/clip.mp4', size: mp4Stat.size, progress: 1, priority: 1 },
        { index: 1, name: 'demo-show/clip_ac3.mkv', size: mkvStat.size, progress: 1, priority: 1 },
      ]
    );

    // 1) Probe MP4 -> canDirectPlay = true
    const probeMp4 = await ctx.app.inject({
      method: 'GET',
      url: `/api/stream/${hash}/0/probe`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(probeMp4.statusCode, 200);
    const mp4Json = probeMp4.json();
    assert.equal(mp4Json.probe.canDirectPlay, true);
    assert.equal(mp4Json.probe.recommendedMode, 'direct');
    assert.ok(mp4Json.urls.potplayer.startsWith('potplayer://http://video.test:3000/api/stream/'));
    assert.ok(mp4Json.urls.iina.startsWith('iina://weblink?url='));

    // 2) Direct HTTP Range 206 using signed stream token (no session cookie!)
    const rangeRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/stream/${hash}/0/direct?token=${encodeURIComponent(mp4Json.streamToken)}`,
      headers: { range: 'bytes=0-1023' },
    });
    assert.equal(rangeRes.statusCode, 206);
    assert.equal(rangeRes.headers['content-range'], `bytes 0-1023/${mp4Stat.size}`);
    assert.equal(rangeRes.rawPayload.length, 1024);

    // 3) Probe MKV(AC3) -> canDirectPlay = false, recommendedMode = 'remux', detects external SRT
    const probeMkv = await ctx.app.inject({
      method: 'GET',
      url: `/api/stream/${hash}/1/probe`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(probeMkv.statusCode, 200);
    const mkvJson = probeMkv.json();
    assert.equal(mkvJson.probe.canDirectPlay, false);
    assert.equal(mkvJson.probe.recommendedMode, 'remux');
    assert.ok(mkvJson.probe.subtitles.length >= 1);

    // 4) Lossless Remux stream produces valid MP4 ftyp header
    const remuxRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/stream/${hash}/1/remux?token=${encodeURIComponent(mkvJson.streamToken)}`,
    });
    assert.equal(remuxRes.statusCode, 200);
    assert.equal(remuxRes.headers['content-type'], 'video/mp4');
    assert.ok(remuxRes.rawPayload.length > 1000);
    assert.equal(remuxRes.rawPayload.subarray(4, 8).toString('ascii'), 'ftyp');

    // 5) External SRT converted to WebVTT
    const subUrl = mkvJson.probe.subtitles[0].url;
    const subRes = await ctx.app.inject({ method: 'GET', url: subUrl });
    assert.equal(subRes.statusCode, 200);
    assert.ok(subRes.body.startsWith('WEBVTT'));
    assert.ok(subRes.body.includes('CloudVideo'));
  });

  it('handles watched delayed unload, pin protection, immediate unload, and LRU storage limit eviction', async () => {
    const hash = '2222222222222222222222222222222222222222';
    const dir = path.join(downloadDir, 'series');
    await fs.mkdir(dir, { recursive: true });

    const ep1 = path.join(dir, 'ep1.mp4');
    const ep2 = path.join(dir, 'ep2.mp4');
    const ep3 = path.join(dir, 'ep3.mp4');
    await fs.writeFile(ep1, Buffer.alloc(600 * 1024, 1));
    await fs.writeFile(ep2, Buffer.alloc(600 * 1024, 2));
    await fs.writeFile(ep3, Buffer.alloc(600 * 1024, 3));

    const now = Date.now();
    qbit.seed(
      {
        hash,
        name: 'My Series',
        size: 1800 * 1024,
        downloaded: 1800 * 1024,
        amount_left: 0,
        progress: 1,
        dlspeed: 0,
        upspeed: 0,
        state: 'pausedUP',
        eta: 0,
        added_on: Math.floor((now - 10 * 3600 * 1000) / 1000),
        completion_on: Math.floor(now / 1000),
        save_path: downloadDir,
        content_path: dir,
        seq_dl: true,
        f_l_piece_prio: true,
        num_seeds: 1,
        num_leechs: 0,
        ratio: 0,
      },
      [
        { index: 0, name: 'series/ep1.mp4', size: 600 * 1024, progress: 1, priority: 1 },
        { index: 1, name: 'series/ep2.mp4', size: 600 * 1024, progress: 1, priority: 1 },
        { index: 2, name: 'series/ep3.mp4', size: 600 * 1024, progress: 1, priority: 1 },
      ]
    );

    // Pin ep2 so it is never auto-deleted
    ctx.cleanup.setPinned(hash, 1, true, 'series/ep2.mp4', 600 * 1024);

    // Report 92% progress on ep1 -> watched & scheduled 24h later
    const prog1 = await ctx.cleanup.recordProgress({
      torrentHash: hash,
      fileIndex: 0,
      positionSec: 920,
      durationSec: 1000,
      relativePath: 'series/ep1.mp4',
      sizeBytes: 600 * 1024,
      now,
    });
    assert.equal(prog1.unloadedImmediately, false);
    assert.ok(prog1.item.watchedAt !== null);
    assert.ok(prog1.item.deleteAfterAt !== null);
    assert.equal(prog1.item.deleteAfterAt, now + 24 * 3600 * 1000);

    // Run cleanup 25 hours later -> ep1 unloaded, ep2 & ep3 still intact, torrent still kept
    const cycle1 = await ctx.cleanup.runCleanupCycle({ now: now + 25 * 3600 * 1000 });
    assert.equal(cycle1.deletedItems.length, 1);
    assert.equal(cycle1.deletedItems[0].fileIndex, 0);
    assert.equal(await fs.stat(ep1).catch(() => null), null);
    assert.ok(await fs.stat(ep2));
    assert.ok(await fs.stat(ep3));
    assert.equal(qbit.torrents.has(hash), true);

    // Switch autoDeleteDelayHours to 0 -> watching ep3 >= 90% unloads immediately
    ctx.db.updateSettings({ autoDeleteDelayHours: 0 });
    const prog3 = await ctx.cleanup.recordProgress({
      torrentHash: hash,
      fileIndex: 2,
      positionSec: 950,
      durationSec: 1000,
      relativePath: 'series/ep3.mp4',
      sizeBytes: 600 * 1024,
      now: now + 26 * 3600 * 1000,
    });
    assert.equal(prog3.unloadedImmediately, true);
    assert.equal(await fs.stat(ep3).catch(() => null), null);

    // ep2 is pinned so it survived and torrent stays; unpin and unload ep2 -> whole torrent removed!
    ctx.cleanup.setPinned(hash, 1, false);
    const unloadEp2 = await ctx.cleanup.unloadFile(hash, 1);
    assert.equal(unloadEp2.deletedTorrent, true);
    assert.equal(qbit.torrents.has(hash), false);

    // Test LRU storage watermark eviction: create two 1 MB files and set limit to 0.001 GB (~1.07 MB)
    const lruHash = '3333333333333333333333333333333333333333';
    const lruDir = path.join(downloadDir, 'lru-test');
    await fs.mkdir(lruDir, { recursive: true });
    const oldFile = path.join(lruDir, 'old.mp4');
    const newFile = path.join(lruDir, 'new.mp4');
    await fs.writeFile(oldFile, Buffer.alloc(1024 * 1024, 7));
    await fs.writeFile(newFile, Buffer.alloc(1024 * 1024, 8));

    qbit.seed(
      {
        hash: lruHash,
        name: 'LRU Test',
        size: 2 * 1024 * 1024,
        downloaded: 2 * 1024 * 1024,
        amount_left: 0,
        progress: 1,
        dlspeed: 0,
        upspeed: 0,
        state: 'pausedUP',
        eta: 0,
        added_on: Math.floor((now - 50000) / 1000),
        completion_on: Math.floor(now / 1000),
        save_path: downloadDir,
        content_path: lruDir,
        seq_dl: true,
        f_l_piece_prio: true,
        num_seeds: 1,
        num_leechs: 0,
        ratio: 0,
      },
      [
        { index: 0, name: 'lru-test/old.mp4', size: 1024 * 1024, progress: 1, priority: 1 },
        { index: 1, name: 'lru-test/new.mp4', size: 1024 * 1024, progress: 1, priority: 1 },
      ]
    );

    ctx.db.upsertMediaItem({
      torrentHash: lruHash,
      fileIndex: 0,
      relativePath: 'lru-test/old.mp4',
      lastPlayedAt: now - 3600 * 1000,
    });
    ctx.db.upsertMediaItem({
      torrentHash: lruHash,
      fileIndex: 1,
      relativePath: 'lru-test/new.mp4',
      lastPlayedAt: now, // actively played -> protected from LRU
    });

    // Lower storage limit via DB directly below current ~2MB usage
    ctx.db.updateSettings({ storageLimitGb: 0.0012 });
    const lruRes = await ctx.cleanup.runCleanupCycle({ now });
    assert.ok(lruRes.deletedItems.some((d) => d.relativePath === 'lru-test/old.mp4'));
    assert.equal(await fs.stat(oldFile).catch(() => null), null);
    assert.ok(await fs.stat(newFile));
  });

  it('serves exact incompressible byte stream for speedtest and persists speedtest history', async () => {
    const ping = await ctx.app.inject({
      method: 'GET',
      url: '/api/speedtest/ping',
      headers: { cookie: cookieHeader },
    });
    assert.equal(ping.statusCode, 200);
    assert.equal(ping.json().ok, true);

    const dl = await ctx.app.inject({
      method: 'GET',
      url: '/api/speedtest/download?mb=2',
      headers: { cookie: cookieHeader },
    });
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.rawPayload.length, 2 * 1024 * 1024);
    assert.ok(String(dl.headers['cache-control']).includes('no-transform'));

    const save = await ctx.app.inject({
      method: 'POST',
      url: '/api/speedtest/history',
      headers: { cookie: cookieHeader },
      payload: {
        pingMs: 38.5,
        singleThreadMbps: 42.3,
        multiThreadMbps: 95.1,
        rating: '优秀 · 流畅 4K 流媒体 & 1080p 高码率',
        note: 'HK-CN2',
      },
    });
    assert.equal(save.statusCode, 200);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/speedtest/history',
      headers: { cookie: cookieHeader },
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().history.length, 1);
    assert.equal(list.json().history[0].note, 'HK-CN2');
  });

  it('updates settings and syncs upload/seeding preferences to qBittorrent', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: cookieHeader },
      payload: {
        storageLimitGb: 42,
        autoDeleteDelayHours: 12,
        uploadLimitKbps: 256,
        stopSeedingOnComplete: true,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.settings.storageLimitGb, 42);
    assert.equal(body.settings.autoDeleteDelayHours, 12);
    assert.equal(body.qbitSynced, true);
    assert.deepEqual(qbit.appliedPrefs.at(-1), {
      uploadLimitKbps: 256,
      stopOnComplete: true,
    });
  });
});
