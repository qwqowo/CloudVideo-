import type { AppDatabase } from '../db.js';
import type { IQBittorrentClient } from './qbittorrent.js';

const FALLBACK_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://public.popcorn-tracker.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'https://tracker.tamersunion.org:443/announce',
];

const TRACKER_SOURCES = [
  'https://cf.trackerslist.com/best.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
];

export async function fetchPublicTrackers(): Promise<{ trackers: string[]; source: string }> {
  for (const url of TRACKER_SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      const list = Array.from(
        new Set(
          text
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => /^(udp|http|https|wss):\/\//i.test(l))
        )
      ).slice(0, 60);
      if (list.length >= 5) {
        return { trackers: list, source: url };
      }
    } catch {
      // try next source
    }
  }
  return { trackers: FALLBACK_TRACKERS, source: 'builtin-fallback' };
}

export async function syncTrackersToQbit(
  db: AppDatabase,
  qbit: IQBittorrentClient
): Promise<{ count: number; source: string; updatedTorrents: number }> {
  const { trackers, source } = await fetchPublicTrackers();
  const settings = db.getSettings();

  await qbit.applyFullPreferences({
    uploadLimitKbps: settings.uploadLimitKbps,
    stopOnComplete: settings.stopSeedingOnComplete,
    proxyEnabled: settings.proxyEnabled,
    proxyType: settings.proxyType,
    proxyHost: settings.proxyHost,
    proxyPort: settings.proxyPort,
    proxyUsername: settings.proxyUsername,
    proxyPassword: settings.proxyPassword,
    defaultTrackers: trackers,
  });

  let updatedTorrents = 0;
  try {
    const torrents = await qbit.listTorrents();
    for (const t of torrents) {
      if (t.progress < 1) {
        await qbit.addTrackers(t.hash, trackers).catch(() => {});
        updatedTorrents++;
      }
    }
  } catch {
    // ignore
  }

  return { count: trackers.length, source, updatedTorrents };
}

export class NotifierService {
  constructor(private db: AppDatabase) {}

  async send(payload: {
    title: string;
    message: string;
    event: 'download_complete' | 'rss_matched' | 'test';
    torrentName?: string;
    sizeBytes?: number;
  }): Promise<{ telegramSent: boolean; webhookSent: boolean; errors: string[] }> {
    const settings = this.db.getSettings();
    const errors: string[] = [];
    let telegramSent = false;
    let webhookSent = false;

    if (settings.telegramBotToken.trim() && settings.telegramChatId.trim()) {
      try {
        const text = `🎬 *${payload.title}*\n${payload.message}`;
        const res = await fetch(
          `https://api.telegram.org/bot${encodeURIComponent(settings.telegramBotToken.trim())}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: settings.telegramChatId.trim(),
              text,
              parse_mode: 'Markdown',
            }),
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!res.ok) {
          errors.push(`Telegram HTTP ${res.status}`);
        } else {
          telegramSent = true;
        }
      } catch (err) {
        errors.push(`Telegram: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (settings.webhookUrl.trim()) {
      try {
        const res = await fetch(settings.webhookUrl.trim(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: 'CloudVideo',
            timestamp: new Date().toISOString(),
            ...payload,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          errors.push(`Webhook HTTP ${res.status}`);
        } else {
          webhookSent = true;
        }
      } catch (err) {
        errors.push(`Webhook: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { telegramSent, webhookSent, errors };
  }
}
