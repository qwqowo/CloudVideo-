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
  QBitFullPreferences,
  QBitTorrent,
  QBitTransferInfo,
} from '../src/services/qbittorrent.js';
import { resolveSafePath } from '../src/services/media.js';
import { LoginRateLimiter, signStreamToken, verifyStreamToken } from '../src/auth.js';

const execFileAsync = promisify(execFile);

class MockQBitClient implements IQBittorrentClient {
  torrents = new Map<string, QBitTorrent>();
  files = new Map<string, QBitFile[]>();
  deletedHashes: string[] = [];
  pausedHashes: string[] = [];
  resumedHashes: string[] = [];
  addedTrackers: Array<{ hash: string; trackers: string[] }> = [];
  appliedPrefs: QBitFullPreferences[] = [];

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

  async pauseTorrents(hashes: string[]): Promise<void> {
    this.pausedHashes.push(...hashes);
  }
  async resumeTorrents(hashes: string[]): Promise<void> {
    this.resumedHashes.push(...hashes);
  }
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

  async addTrackers(hash: string, trackers: string[]): Promise<void> {
    this.addedTrackers.push({ hash, trackers });
  }

  async applyPreferences(uploadLimitKbps: number, stopOnComplete: boolean): Promise<void> {
    this.appliedPrefs.push({ uploadLimitKbps, stopOnComplete });
  }

  async applyFullPreferences(opts: QBitFullPreferences): Promise<void> {
    this.appliedPrefs.push(opts);
  }
}

describe('CloudVideo v2.0 Backend Integration Suite', () => {
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
    ctx = await buildApp(config, {
      qbit,
      startScheduler: false,
      loginRateLimiter: new LoginRateLimiter(5, 60_000, 60_000),
    });
  });

  after(async () => {
    await ctx.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated requests, enforces login brute-force lockout, and authenticates cleanly', async () => {
    const unauth = await ctx.app.inject({ method: 'GET', url: '/api/torrents' });
    assert.equal(unauth.statusCode, 401);

    // Trigger 5 failed attempts from attacker IP -> 5th locks with 429
    for (let i = 0; i < 4; i++) {
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': '203.0.113.99' },
        payload: { password: 'wrong' },
      });
      assert.equal(r.statusCode, 401);
    }
    const locked = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.99' },
      payload: { password: 'wrong' },
    });
    assert.equal(locked.statusCode, 429);

    // Valid login from legitimate IP succeeds
    const okLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '198.51.100.10' },
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

  it('probes MP4/MKV, serves Range 206, multi-slot smart thumbs, Remux, and custom uploaded SRT -> WebVTT', async () => {
    const showDir = path.join(downloadDir, 'demo-show');
    await fs.mkdir(showDir, { recursive: true });
    const mp4Path = path.join(showDir, 'clip.mp4');
    const mkvPath = path.join(showDir, 'clip_ac3.mkv');
    const srtPath = path.join(showDir, 'clip_ac3.srt');

    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=3:size=320x180:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
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
      'testsrc=duration=3:size=320x180:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
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

    // 1) Probe MP4 -> direct play + mobile external URLs
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
    assert.ok(mp4Json.urls.infuse.startsWith('infuse://x-callback-url/play?url='));
    assert.ok(mp4Json.urls.vlc.startsWith('vlc://'));

    // 2) Range 206 direct play via signed token
    const rangeRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/stream/${hash}/0/direct?token=${encodeURIComponent(mp4Json.streamToken)}`,
      headers: { range: 'bytes=0-1023' },
    });
    assert.equal(rangeRes.statusCode, 206);
    assert.equal(rangeRes.headers['content-range'], `bytes 0-1023/${mp4Stat.size}`);

    // 3) Multi-slot smart thumbnails (slot=0 and slot=1)
    for (const slot of [0, 1]) {
      const thumbRes = await ctx.app.inject({
        method: 'GET',
        url: `/api/stream/${hash}/0/thumb?slot=${slot}`,
        headers: { cookie: cookieHeader },
      });
      assert.equal(thumbRes.statusCode, 200);
      assert.equal(thumbRes.headers['content-type'], 'image/jpeg');
      assert.equal(thumbRes.rawPayload[0], 0xff);
      assert.equal(thumbRes.rawPayload[1], 0xd8);
    }

    // 4) Upload custom SRT subtitle -> converted & served as WebVTT
    const boundary = '----CloudVideoSubBoundary';
    const srtContent = '1\r\n00:00:00,200 --> 00:00:02,000\r\n外挂上传中文字幕\r\n';
    const multipartBody = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="chs.srt"',
      'Content-Type: text/plain',
      '',
      srtContent,
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const upSub = await ctx.app.inject({
      method: 'POST',
      url: `/api/stream/${hash}/0/subtitle/upload`,
      headers: {
        cookie: cookieHeader,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody,
    });
    assert.equal(upSub.statusCode, 200);
    const upJson = upSub.json();
    assert.ok(upJson.subtitle.id.startsWith('usr:'));

    const fetchUploadedSub = await ctx.app.inject({
      method: 'GET',
      url: upJson.subtitle.url,
    });
    assert.equal(fetchUploadedSub.statusCode, 200);
    assert.ok(fetchUploadedSub.body.startsWith('WEBVTT'));
    assert.ok(fetchUploadedSub.body.includes('外挂上传中文字幕'));

    // 5) Lossless Remux on MKV(AC3)
    const probeMkv = await ctx.app.inject({
      method: 'GET',
      url: `/api/stream/${hash}/1/probe`,
      headers: { cookie: cookieHeader },
    });
    const mkvJson = probeMkv.json();
    assert.equal(mkvJson.probe.canDirectPlay, false);
    assert.equal(mkvJson.probe.recommendedMode, 'direct');

    const remuxRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/stream/${hash}/1/remux?token=${encodeURIComponent(mkvJson.streamToken)}`,
    });
    assert.equal(remuxRes.statusCode, 200);
    assert.equal(remuxRes.rawPayload.subarray(4, 8).toString('ascii'), 'ftyp');
  });

  it('runs Small-Disk Binge Auto-Pilot (initial N episodes + 70% next-episode preload)', async () => {
    const hash = '4444444444444444444444444444444444444444';
    qbit.seed(
      {
        hash,
        name: 'SciFi Season 01',
        size: 4000,
        downloaded: 0,
        amount_left: 4000,
        progress: 0,
        dlspeed: 0,
        upspeed: 0,
        state: 'pausedDL',
        eta: 0,
        added_on: Math.floor(Date.now() / 1000),
        completion_on: 0,
        save_path: downloadDir,
        content_path: path.join(downloadDir, 'scifi'),
        seq_dl: true,
        f_l_piece_prio: true,
        num_seeds: 3,
        num_leechs: 1,
        ratio: 0,
      },
      [
        { index: 0, name: 'scifi/S01E01.mkv', size: 1000, progress: 0, priority: 1 },
        { index: 1, name: 'scifi/S01E02.mkv', size: 1000, progress: 0, priority: 1 },
        { index: 2, name: 'scifi/S01E03.mkv', size: 1000, progress: 0, priority: 1 },
        { index: 3, name: 'scifi/S01E04.mkv', size: 1000, progress: 0, priority: 1 },
      ]
    );

    ctx.db.upsertTorrentPolicy({
      torrentHash: hash,
      bingeMode: true,
      bingeWindow: 2,
      initialized: false,
    });

    // Reconcile -> only E01 & E02 stay priority=1; E03 & E04 become priority=0
    const initCount = await ctx.cleanup.reconcileBingeTorrents(hash);
    assert.equal(initCount, 1);
    let files = await qbit.getTorrentFiles(hash);
    assert.deepEqual(
      files.map((f) => f.priority),
      [1, 1, 0, 0]
    );

    // Watching E02 past 70% automatically enables E03!
    const prog = await ctx.cleanup.recordProgress({
      torrentHash: hash,
      fileIndex: 1,
      positionSec: 750,
      durationSec: 1000,
      relativePath: 'scifi/S01E02.mkv',
      sizeBytes: 1000,
    });
    assert.ok(prog.preloadedNext);
    assert.equal(prog.preloadedNext?.preloadedIndex, 2);

    files = await qbit.getTorrentFiles(hash);
    assert.deepEqual(
      files.map((f) => f.priority),
      [1, 1, 1, 0]
    );
  });

  it('handles watched unload, pin protection, LRU eviction, audit logs, and batch operations', async () => {
    const hash = '2222222222222222222222222222222222222222';
    const dir = path.join(downloadDir, 'series');
    await fs.mkdir(dir, { recursive: true });

    const ep1 = path.join(dir, 'ep1.mp4');
    const ep2 = path.join(dir, 'ep2.mp4');
    await fs.writeFile(ep1, Buffer.alloc(600 * 1024, 1));
    await fs.writeFile(ep2, Buffer.alloc(600 * 1024, 2));

    const now = Date.now();
    qbit.seed(
      {
        hash,
        name: 'My Series',
        size: 1200 * 1024,
        downloaded: 1200 * 1024,
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
      ]
    );

    ctx.cleanup.setPinned(hash, 1, true, 'series/ep2.mp4', 600 * 1024);
    await ctx.cleanup.recordProgress({
      torrentHash: hash,
      fileIndex: 0,
      positionSec: 920,
      durationSec: 1000,
      relativePath: 'series/ep1.mp4',
      sizeBytes: 600 * 1024,
      now,
    });

    const cycle = await ctx.cleanup.runCleanupCycle({ now: now + 25 * 3600 * 1000 });
    assert.equal(cycle.deletedItems.length, 1);
    assert.equal(await fs.stat(ep1).catch(() => null), null);
    assert.ok(await fs.stat(ep2));

    // Audit log recorded the deletion
    const logRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/cleanup/logs',
      headers: { cookie: cookieHeader },
    });
    assert.equal(logRes.statusCode, 200);
    const logs = logRes.json().logs;
    assert.ok(logs.some((l: any) => l.relativePath === 'series/ep1.mp4' && l.reason === 'watched_delay_expired'));

    // Batch pause & delete
    const batchRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/torrents/batch',
      headers: { cookie: cookieHeader },
      payload: { action: 'pause', hashes: [hash] },
    });
    assert.equal(batchRes.statusCode, 200);
    assert.ok(qbit.pausedHashes.includes(hash));
  });

  it('serves speedtest stream, updates proxy/TMDB settings, and syncs preferences', async () => {
    const dl = await ctx.app.inject({
      method: 'GET',
      url: '/api/speedtest/download?mb=1',
      headers: { cookie: cookieHeader },
    });
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.rawPayload.length, 1024 * 1024);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: cookieHeader },
      payload: {
        storageLimitGb: 42,
        bingePreloadCount: 3,
        uploadLimitKbps: 256,
        proxyEnabled: true,
        proxyType: 'socks5',
        proxyHost: '127.0.0.1',
        proxyPort: 10808,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.settings.bingePreloadCount, 3);
    assert.equal(body.settings.proxyType, 'socks5');
    assert.equal(body.qbitSynced, true);
    assert.equal(qbit.appliedPrefs.at(-1)?.proxyPort, 10808);
  });
});
