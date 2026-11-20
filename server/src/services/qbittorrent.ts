export interface QBitTorrent {
  hash: string;
  name: string;
  size: number;
  total_size?: number;
  downloaded: number;
  amount_left: number;
  progress: number;
  dlspeed: number;
  upspeed: number;
  state: string;
  eta: number;
  added_on: number;
  completion_on: number;
  save_path: string;
  content_path: string;
  seq_dl: boolean;
  f_l_piece_prio: boolean;
  num_seeds: number;
  num_leechs: number;
  ratio: number;
  category?: string;
}

export interface QBitFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number; // 0=do not download, 1=normal, 6=high, 7=max
  is_seed?: boolean;
  availability?: number;
}

export interface QBitTransferInfo {
  dl_info_speed: number;
  up_info_speed: number;
  dl_info_data: number;
  up_info_data: number;
  connection_status: string;
}

export interface AddTorrentOptions {
  sequential?: boolean;
  firstLastPiecePrio?: boolean;
  paused?: boolean;
  savePath?: string;
}

export interface QBitFullPreferences {
  uploadLimitKbps: number;
  stopOnComplete: boolean;
  proxyEnabled?: boolean;
  proxyType?: 'none' | 'http' | 'socks5';
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  defaultTrackers?: string[];
}

export interface IQBittorrentClient {
  checkHealth(): Promise<{ connected: boolean; version?: string; error?: string }>;
  listTorrents(): Promise<QBitTorrent[]>;
  getTorrentFiles(hash: string): Promise<QBitFile[]>;
  getTransferInfo(): Promise<QBitTransferInfo>;
  addMagnet(magnet: string, opts?: AddTorrentOptions): Promise<void>;
  addTorrentFile(buffer: Buffer, filename: string, opts?: AddTorrentOptions): Promise<void>;
  setFilePriority(hash: string, fileIndices: number[], priority: 0 | 1 | 6 | 7): Promise<void>;
  pauseTorrents(hashes: string[]): Promise<void>;
  resumeTorrents(hashes: string[]): Promise<void>;
  toggleSequential(hash: string): Promise<void>;
  toggleFirstLastPiecePrio(hash: string): Promise<void>;
  deleteTorrents(hashes: string[], deleteFiles: boolean): Promise<void>;
  addTrackers(hash: string, trackers: string[]): Promise<void>;
  applyPreferences(uploadLimitKbps: number, stopOnComplete: boolean): Promise<void>;
  applyFullPreferences(opts: QBitFullPreferences): Promise<void>;
}

export class QBittorrentClient implements IQBittorrentClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private sidCookie: string | null = null;

  constructor(baseUrl: string, username = '', password = '') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
  }

  private async loginIfNeeded(): Promise<void> {
    if (!this.username || !this.password) return;
    const body = new URLSearchParams({
      username: this.username,
      password: this.password,
    });
    const res = await fetch(`${this.baseUrl}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/SID=[^;]+/);
      if (m) this.sidCookie = m[0];
    }
  }

  private async request(
    endpoint: string,
    init: RequestInit = {},
    retryAuth = true
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.sidCookie) {
      headers.set('Cookie', this.sidCookie);
    }

    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 403 && retryAuth && this.username && this.password) {
      await this.loginIfNeeded();
      return this.request(endpoint, init, false);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`qBittorrent API ${endpoint} failed (${res.status}): ${text}`);
    }
    return res;
  }

  async checkHealth(): Promise<{ connected: boolean; version?: string; error?: string }> {
    try {
      const res = await this.request('/api/v2/app/version');
      const version = (await res.text()).trim();
      return { connected: true, version };
    } catch (err) {
      return {
        connected: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listTorrents(): Promise<QBitTorrent[]> {
    const res = await this.request('/api/v2/torrents/info?sort=added_on&reverse=true');
    const items = (await res.json()) as QBitTorrent[];
    return items.map((t) => ({ ...t, hash: t.hash.toLowerCase() }));
  }

  async getTorrentFiles(hash: string): Promise<QBitFile[]> {
    const res = await this.request(`/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`);
    const files = (await res.json()) as QBitFile[];
    return files.map((f, idx) => ({
      ...f,
      index: typeof f.index === 'number' ? f.index : idx,
    }));
  }

  async getTransferInfo(): Promise<QBitTransferInfo> {
    const res = await this.request('/api/v2/transfer/info');
    return (await res.json()) as QBitTransferInfo;
  }

  async addMagnet(magnet: string, opts: AddTorrentOptions = {}): Promise<void> {
    const form = new FormData();
    form.append('urls', magnet.trim());
    if (opts.savePath) form.append('savepath', opts.savePath);
    form.append('sequentialDownload', String(opts.sequential ?? true));
    form.append('firstLastPiecePrio', String(opts.firstLastPiecePrio ?? true));
    if (opts.paused) {
      form.append('paused', 'true');
      form.append('stopped', 'true');
    }
    await this.request('/api/v2/torrents/add', { method: 'POST', body: form });
  }

  async addTorrentFile(
    buffer: Buffer,
    filename: string,
    opts: AddTorrentOptions = {}
  ): Promise<void> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], { type: 'application/x-bittorrent' });
    form.append('torrents', blob, filename.endsWith('.torrent') ? filename : `${filename}.torrent`);
    if (opts.savePath) form.append('savepath', opts.savePath);
    form.append('sequentialDownload', String(opts.sequential ?? true));
    form.append('firstLastPiecePrio', String(opts.firstLastPiecePrio ?? true));
    if (opts.paused) {
      form.append('paused', 'true');
      form.append('stopped', 'true');
    }
    await this.request('/api/v2/torrents/add', { method: 'POST', body: form });
  }

  async setFilePriority(
    hash: string,
    fileIndices: number[],
    priority: 0 | 1 | 6 | 7
  ): Promise<void> {
    if (fileIndices.length === 0) return;
    const body = new URLSearchParams({
      hash: hash.toLowerCase(),
      id: fileIndices.join('|'),
      priority: String(priority),
    });
    await this.request('/api/v2/torrents/filePrio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  async pauseTorrents(hashes: string[]): Promise<void> {
    if (hashes.length === 0) return;
    const body = new URLSearchParams({ hashes: hashes.join('|') });
    // qBittorrent v5 uses /stop, v4 uses /pause
    try {
      await this.request('/api/v2/torrents/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch {
      await this.request('/api/v2/torrents/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    }
  }

  async resumeTorrents(hashes: string[]): Promise<void> {
    if (hashes.length === 0) return;
    const body = new URLSearchParams({ hashes: hashes.join('|') });
    try {
      await this.request('/api/v2/torrents/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch {
      await this.request('/api/v2/torrents/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    }
  }

  async toggleSequential(hash: string): Promise<void> {
    const body = new URLSearchParams({ hashes: hash.toLowerCase() });
    await this.request('/api/v2/torrents/toggleSequentialDownload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  async toggleFirstLastPiecePrio(hash: string): Promise<void> {
    const body = new URLSearchParams({ hashes: hash.toLowerCase() });
    await this.request('/api/v2/torrents/toggleFirstLastPiecePrio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  async deleteTorrents(hashes: string[], deleteFiles: boolean): Promise<void> {
    if (hashes.length === 0) return;
    const body = new URLSearchParams({
      hashes: hashes.join('|'),
      deleteFiles: String(deleteFiles),
    });
    await this.request('/api/v2/torrents/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  async addTrackers(hash: string, trackers: string[]): Promise<void> {
    if (trackers.length === 0) return;
    const body = new URLSearchParams({
      hash: hash.toLowerCase(),
      urls: trackers.join('\n'),
    });
    await this.request('/api/v2/torrents/addTrackers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  async applyPreferences(uploadLimitKbps: number, stopOnComplete: boolean): Promise<void> {
    await this.applyFullPreferences({ uploadLimitKbps, stopOnComplete });
  }

  async applyFullPreferences(opts: QBitFullPreferences): Promise<void> {
    const prefs: Record<string, unknown> = {
      up_limit: Math.max(0, Math.round(opts.uploadLimitKbps * 1024)),
      max_ratio_enabled: opts.stopOnComplete,
      max_ratio: opts.stopOnComplete ? 0 : -1,
      max_ratio_act: 0, // 0 = pause/stop torrent
      preallocate_all: false,
    };

    if (opts.proxyEnabled !== undefined) {
      if (!opts.proxyEnabled || !opts.proxyHost || opts.proxyType === 'none') {
        prefs.proxy_type = 'None';
      } else {
        prefs.proxy_type = opts.proxyType === 'socks5' ? 'SOCKS5' : 'HTTP';
        prefs.proxy_ip = opts.proxyHost;
        prefs.proxy_port = opts.proxyPort ?? 1080;
        const hasAuth = Boolean(opts.proxyUsername);
        prefs.proxy_auth_enabled = hasAuth;
        prefs.proxy_username = opts.proxyUsername || '';
        prefs.proxy_password = opts.proxyPassword || '';
        prefs.proxy_bittorrent = true;
        prefs.proxy_misc = true;
        prefs.proxy_hostname_lookup = true;
      }
    }

    if (opts.defaultTrackers && opts.defaultTrackers.length > 0) {
      prefs.add_trackers_enabled = true;
      prefs.add_trackers = opts.defaultTrackers.join('\n');
    }

    const body = new URLSearchParams({ json: JSON.stringify(prefs) });
    await this.request('/api/v2/app/setPreferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }
}
