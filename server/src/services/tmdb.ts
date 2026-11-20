import type { AppDatabase, TmdbCacheRecord } from '../db.js';

export interface TmdbSearchCandidate {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  originalTitle: string;
  year: string;
  overview: string;
  rating: number;
  posterUrl: string;
  backdropUrl: string;
}

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG_POSTER = 'https://image.tmdb.org/t/p/w500';
const TMDB_IMG_BACKDROP = 'https://image.tmdb.org/t/p/w780';

export function cleanQueryFromTorrentName(rawName: string): {
  query: string;
  year?: string;
  likelyTv: boolean;
} {
  const base = rawName.replace(/\.[a-z0-9]{2,4}$/i, '');
  const likelyTv =
    /\b(s\d{1,2}e\d{1,2}|s\d{1,2}|season\s*\d+|complete|ep?\d{2,3})\b/i.test(base) ||
    /第\s*[0-9一二三四五六七八九十]+\s*[季集话]/i.test(base);

  const yearMatch = base.match(/(?:^|[.\s(_[-])((?:19|20)\d{2})(?:$|[.\s)_\]-])/);
  const year = yearMatch?.[1];

  let cleaned = base
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cutMatch = cleaned.match(
    /\b(s\d{1,2}(?:e\d{1,2})?|season\s*\d+|2160p|1080p|720p|4k|uhd|web-?dl|webrip|blu-?ray|bdrip|remux|hdtv|x264|x265|hevc|h\.?264|h\.?265|10bit|hdr|dv|aac|dts|ddp)\b/i
  );
  if (cutMatch && cutMatch.index && cutMatch.index > 2) {
    cleaned = cleaned.slice(0, cutMatch.index).trim();
  }
  if (year) {
    cleaned = cleaned.replace(new RegExp(`\\(?${year}\\)?`, 'g'), '').trim();
  }
  cleaned = cleaned.replace(/[-(\[]+$/, '').trim();

  return {
    query: cleaned.length >= 2 ? cleaned : base,
    year,
    likelyTv,
  };
}

export class TmdbService {
  private inflight = new Set<string>();

  constructor(private db: AppDatabase) {}

  private async tmdbGet(apiKey: string, endpoint: string, params: Record<string, string>): Promise<any> {
    const trimmed = apiKey.trim();
    const url = new URL(`${TMDB_API_BASE}${endpoint}`);
    const headers: Record<string, string> = { Accept: 'application/json' };

    // Auto-detect v4 Bearer Read Access Token (JWT starts with eyJ or length > 50) vs v3 API Key
    if (trimmed.length > 45 || trimmed.includes('.')) {
      headers.Authorization = `Bearer ${trimmed}`;
    } else {
      url.searchParams.set('api_key', trimmed);
    }

    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      throw new Error(`TMDB API error (${res.status})`);
    }
    return res.json();
  }

  private mapCandidate(item: any, fallbackType?: 'movie' | 'tv'): TmdbSearchCandidate | null {
    const mediaType = (item.media_type || fallbackType) as 'movie' | 'tv';
    if (mediaType !== 'movie' && mediaType !== 'tv') return null;
    const title = item.title || item.name || '';
    if (!title) return null;
    const dateStr = item.release_date || item.first_air_date || '';
    return {
      tmdbId: Number(item.id),
      mediaType,
      title,
      originalTitle: item.original_title || item.original_name || title,
      year: dateStr.slice(0, 4),
      overview: String(item.overview || ''),
      rating: Number((Number(item.vote_average || 0)).toFixed(1)),
      posterUrl: item.poster_path ? `${TMDB_IMG_POSTER}${item.poster_path}` : '',
      backdropUrl: item.backdrop_path ? `${TMDB_IMG_BACKDROP}${item.backdrop_path}` : '',
    };
  }

  async searchCandidates(query: string, year?: string): Promise<TmdbSearchCandidate[]> {
    const apiKey = this.db.getSettings().tmdbApiKey.trim();
    if (!apiKey || !query.trim()) return [];

    const data = await this.tmdbGet(apiKey, '/search/multi', {
      query: query.trim(),
      language: 'zh-CN',
      include_adult: 'false',
      ...(year ? { year } : {}),
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    const mapped: TmdbSearchCandidate[] = [];
    for (const r of results) {
      const c = this.mapCandidate(r);
      if (c) mapped.push(c);
      if (mapped.length >= 10) break;
    }
    return mapped;
  }

  scheduleAutoMatch(torrentHash: string, rawName: string, videoCount: number): void {
    const apiKey = this.db.getSettings().tmdbApiKey.trim();
    if (!apiKey) return;

    const hash = torrentHash.toLowerCase();
    const cached = this.db.getTmdbCache(hash);
    if (cached) {
      // Negative cache lasts 24h; positive cache is kept
      if (cached.tmdbId !== null || Date.now() - cached.fetchedAt < 24 * 3600 * 1000) {
        return;
      }
    }
    if (this.inflight.has(hash)) return;

    this.inflight.add(hash);
    void this.matchAndCache(hash, rawName, videoCount > 1)
      .catch(() => {})
      .finally(() => this.inflight.delete(hash));
  }

  async matchAndCache(
    torrentHash: string,
    rawName: string,
    multiEpisode: boolean
  ): Promise<TmdbCacheRecord | null> {
    const apiKey = this.db.getSettings().tmdbApiKey.trim();
    if (!apiKey) return null;

    const hash = torrentHash.toLowerCase();
    const { query, year, likelyTv } = cleanQueryFromTorrentName(rawName);
    const preferTv = likelyTv || multiEpisode;

    let best: TmdbSearchCandidate | null = null;
    try {
      const endpoint = preferTv ? '/search/tv' : '/search/movie';
      const params: Record<string, string> = {
        query,
        language: 'zh-CN',
        include_adult: 'false',
      };
      if (year) {
        params[preferTv ? 'first_air_date_year' : 'year'] = year;
      }
      const primary = await this.tmdbGet(apiKey, endpoint, params);
      const first = Array.isArray(primary?.results) ? primary.results[0] : null;
      if (first) {
        best = this.mapCandidate(first, preferTv ? 'tv' : 'movie');
      }

      if (!best) {
        const multi = await this.searchCandidates(query);
        best = multi[0] ?? null;
      }
    } catch {
      return null;
    }

    const record: TmdbCacheRecord = best
      ? {
          torrentHash: hash,
          tmdbId: best.tmdbId,
          mediaType: best.mediaType,
          title: best.title,
          originalTitle: best.originalTitle,
          year: best.year,
          overview: best.overview,
          rating: best.rating,
          posterUrl: best.posterUrl,
          backdropUrl: best.backdropUrl,
          fetchedAt: Date.now(),
        }
      : {
          torrentHash: hash,
          tmdbId: null,
          mediaType: '',
          title: '',
          originalTitle: '',
          year: '',
          overview: '',
          rating: 0,
          posterUrl: '',
          backdropUrl: '',
          fetchedAt: Date.now(),
        };

    this.db.upsertTmdbCache(record);
    return record;
  }

  bindManualMatch(torrentHash: string, candidate: TmdbSearchCandidate): TmdbCacheRecord {
    const record: TmdbCacheRecord = {
      torrentHash: torrentHash.toLowerCase(),
      tmdbId: candidate.tmdbId,
      mediaType: candidate.mediaType,
      title: candidate.title,
      originalTitle: candidate.originalTitle,
      year: candidate.year,
      overview: candidate.overview,
      rating: candidate.rating,
      posterUrl: candidate.posterUrl,
      backdropUrl: candidate.backdropUrl,
      fetchedAt: Date.now(),
    };
    this.db.upsertTmdbCache(record);
    return record;
  }
}
