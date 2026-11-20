import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
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
  addedMagnets: Array<{ magnet: string; opts?: AddTorrentOptions }> = [];
  addedFiles: Array<{ filename: string; size: number; opts?: AddTorrentOptions }> = [];
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

  async addMagnet(magnet: string, opts?: AddTorrentOptions): Promise<void> {
    this.addedMagnets.push({ magnet, opts });
  }
  async addTorrentFile(buffer: Buffer, filename: string, opts?: AddTorrentOptions): Promise<void> {
    this.addedFiles.push({ filename, size: buffer.length, opts });
  }

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
      prowlarrUrl: '',
      prowlarrApiKey: '',
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

  it('aggregates Prowlarr + Torznab search, handles 302 magnet redirects & .torrent downloads, and runs RSS auto-subscriptions', async () => {
    const hashA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const hashB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const hashRss = 'cccccccccccccccccccccccccccccccccccccccc';

    const mockServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (url.pathname === '/api/v1/indexer') {
        if (req.headers['x-api-key'] !== 'secret-prowlarr-key') {
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            { id: 1, name: 'Nyaa', protocol: 'torrent', enable: true },
            { id: 2, name: '1337x', protocol: 'torrent', enable: true },
            { id: 3, name: 'DisabledSite', protocol: 'torrent', enable: false },
          ])
        );
        return;
      }

      if (url.pathname === '/api/v1/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              guid: 'prowlarr-1',
              title: 'Dune.Part.Two.2024.2160p.WEB-DL.HDR.HEVC.CHS',
              indexer: '1337x',
              size: 60 * 1024 * 1024 * 1024, // 60 GB -> exceeds 42 GB limit!
              seeders: 120,
              leechers: 15,
              publishDate: '2026-11-19T12:00:00Z',
              downloadUrl: `http://127.0.0.1:${(mockServer.address() as any).port}/download/redirect-magnet`,
              infoHash: hashA,
              categories: [{ id: 2000 }],
            },
            {
              guid: 'prowlarr-2',
              title: 'Dune.Part.Two.2024.1080p.WEB-DL.H264',
              indexer: 'Nyaa',
              size: 5 * 1024 * 1024 * 1024,
              seeders: 45,
              leechers: 5,
              publishDate: '2026-11-20T12:00:00Z',
              downloadUrl: `http://127.0.0.1:${(mockServer.address() as any).port}/download/file.torrent`,
              infoHash: hashB,
              categories: [{ id: 2000 }],
            },
          ])
        );
        return;
      }

      if (url.pathname === '/torznab') {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
            <channel>
              <item>
                <title>Dune.Part.Two.2024.1080p.WEB-DL.H264</title>
                <guid>tz-dup-higher-seeds</guid>
                <pubDate>Thu, 20 Nov 2026 12:00:00 GMT</pubDate>
                <enclosure url="http://127.0.0.1:${(mockServer.address() as any).port}/download/file.torrent" length="5368709120" type="application/x-bittorrent" />
                <torznab:attr name="seeders" value="88" />
                <torznab:attr name="peers" value="100" />
                <torznab:attr name="infohash" value="${hashB}" />
              </item>
            </channel>
          </rss>`);
        return;
      }

      if (url.pathname === '/download/redirect-magnet') {
        res.writeHead(302, {
          Location: `magnet:?xt=urn:btih:${hashA}&dn=Dune`,
        });
        res.end();
        return;
      }

      if (url.pathname === '/download/file.torrent') {
        res.writeHead(200, {
          'Content-Type': 'application/x-bittorrent',
          'Content-Disposition': 'attachment; filename="dune1080p.torrent"',
        });
        res.end(Buffer.from('d8:announce20:http://tracker.local4:infod4:name4:testee'));
        return;
      }

      if (url.pathname === '/rss/anime.xml') {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <title>Mock Anime RSS</title>
              <item>
                <title>[SubGroup] Frieren - 01 [1080p][CHS].mkv</title>
                <guid>rss-ep-01</guid>
                <pubDate>Fri, 20 Nov 2026 10:00:00 GMT</pubDate>
                <enclosure url="magnet:?xt=urn:btih:${hashRss}&amp;dn=Frieren01" length="1200000000" type="application/x-bittorrent" />
              </item>
              <item>
                <title>[SubGroup] Frieren - 01 [720p][CHS].mkv</title>
                <guid>rss-ep-01-720</guid>
                <enclosure url="magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd" length="600000000" type="application/x-bittorrent" />
              </item>
              <item>
                <title>[SubGroup] Frieren - Complete Batch [1080p][CHS]</title>
                <guid>rss-batch-huge</guid>
                <enclosure url="magnet:?xt=urn:btih:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" length="18000000000" type="application/x-bittorrent" />
              </item>
            </channel>
          </rss>`);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = (mockServer.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1) Configure & test Prowlarr
      const saveP = await ctx.app.inject({
        method: 'PUT',
        url: '/api/hub/prowlarr',
        headers: { cookie: cookieHeader },
        payload: { prowlarrUrl: baseUrl, prowlarrApiKey: 'secret-prowlarr-key' },
      });
      assert.equal(saveP.statusCode, 200);

      const testP = await ctx.app.inject({
        method: 'POST',
        url: '/api/hub/prowlarr/test',
        headers: { cookie: cookieHeader },
        payload: {},
      });
      assert.equal(testP.statusCode, 200);
      assert.equal(testP.json().ok, true);
      assert.equal(testP.json().indexerCount, 2);

      // 2) Add custom Torznab indexer
      const addTz = await ctx.app.inject({
        method: 'POST',
        url: '/api/hub/indexers',
        headers: { cookie: cookieHeader },
        payload: { name: 'MockJackett', url: `${baseUrl}/torznab`, apiKey: 'tz-key' },
      });
      assert.equal(addTz.statusCode, 200);

      // 3) Aggregated search deduplicates hashB keeping higher seeders (88 > 45) & marks 60GB item exceedsLimit
      const searchRes = await ctx.app.inject({
        method: 'GET',
        url: '/api/hub/search?q=Dune&category=movies&sort=seeders',
        headers: { cookie: cookieHeader },
      });
      assert.equal(searchRes.statusCode, 200);
      const searchBody = searchRes.json();
      assert.equal(searchBody.sourcesQueried, 2);
      assert.equal(searchBody.results.length, 2);
      assert.equal(searchBody.results[0].seeders, 120);
      assert.equal(searchBody.results[0].resolution, '4K');
      assert.equal(searchBody.results[0].exceedsLimit, true);
      assert.ok(searchBody.results[0].tags.includes('中字'));
      assert.equal(searchBody.results[1].seeders, 88);
      assert.equal(searchBody.results[1].indexer, 'MockJackett');

      // 4) Push 302-to-magnet URL with bingeMode -> catches magnet redirect & registers binge policy
      const dlMagnet = await ctx.app.inject({
        method: 'POST',
        url: '/api/hub/download',
        headers: { cookie: cookieHeader },
        payload: {
          downloadUrl: `${baseUrl}/download/redirect-magnet`,
          title: 'Dune 4K',
          sequential: true,
          bingeMode: true,
        },
      });
      assert.equal(dlMagnet.statusCode, 200);
      assert.equal(dlMagnet.json().method, 'magnet');
      assert.ok(qbit.addedMagnets.some((m) => m.magnet.includes(hashA)));
      assert.equal(ctx.db.getTorrentPolicy(hashA)?.bingeMode, true);

      // 5) Push binary .torrent download URL
      const dlFile = await ctx.app.inject({
        method: 'POST',
        url: '/api/hub/download',
        headers: { cookie: cookieHeader },
        payload: {
          downloadUrl: `${baseUrl}/download/file.torrent`,
          title: 'Dune 1080p',
          sequential: true,
          bingeMode: false,
        },
      });
      assert.equal(dlFile.statusCode, 200);
      assert.equal(dlFile.json().method, 'torrent_file');
      assert.ok(qbit.addedFiles.some((f) => f.filename.includes('Dune 1080p')));

      // 6) RSS invalid regex rejected with 400
      const badRegex = await ctx.app.inject({
        method: 'POST',
        url: '/api/rss/subscriptions',
        headers: { cookie: cookieHeader },
        payload: {
          name: 'Bad',
          feedUrl: `${baseUrl}/rss/anime.xml`,
          includeRegex: '([unclosed',
        },
      });
      assert.equal(badRegex.statusCode, 400);

      // 7) RSS Dry-run preview matches only 1080p single episode (excludes 720p & >5000MB batch)
      const prevRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/rss/preview',
        headers: { cookie: cookieHeader },
        payload: {
          feedUrl: `${baseUrl}/rss/anime.xml`,
          includeRegex: '1080p',
          excludeRegex: '720p',
          maxSizeMb: 5000,
        },
      });
      assert.equal(prevRes.statusCode, 200);
      const prevJson = prevRes.json();
      assert.equal(prevJson.total, 3);
      assert.equal(prevJson.matchedCount, 1);

      // 8) Create RSS subscription, run once -> pushes 1 item; run again -> deduplicated (0 new pushes)
      const subRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/rss/subscriptions',
        headers: { cookie: cookieHeader },
        payload: {
          name: 'Frieren 1080p',
          feedUrl: `${baseUrl}/rss/anime.xml`,
          includeRegex: '1080p',
          excludeRegex: '720p',
          maxSizeMb: 5000,
          intervalMin: 15,
          sequential: true,
        },
      });
      assert.equal(subRes.statusCode, 200);
      const subId = subRes.json().subscription.id;

      const run1 = await ctx.app.inject({
        method: 'POST',
        url: `/api/rss/subscriptions/${subId}/run`,
        headers: { cookie: cookieHeader },
      });
      assert.equal(run1.statusCode, 200);
      assert.equal(run1.json().summary.pushedCount, 1);
      assert.ok(qbit.addedMagnets.some((m) => m.magnet.includes(hashRss)));

      const run2 = await ctx.app.inject({
        method: 'POST',
        url: `/api/rss/subscriptions/${subId}/run`,
        headers: { cookie: cookieHeader },
      });
      assert.equal(run2.statusCode, 200);
      assert.equal(run2.json().summary.pushedCount, 0);

      const histRes = await ctx.app.inject({
        method: 'GET',
        url: `/api/rss/subscriptions/${subId}/history`,
        headers: { cookie: cookieHeader },
      });
      assert.equal(histRes.statusCode, 200);
      assert.equal(histRes.json().items.length, 3);
      assert.equal(histRes.json().items.filter((i: any) => i.pushed).length, 1);
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });
});
