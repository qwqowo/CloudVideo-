export interface StorageStats {
  usedBytes: number;
  limitBytes: number;
  usagePercent: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
  pendingDeleteCount: number;
}

export interface PrimaryVideoInfo {
  index: number;
  name: string;
  size: number;
  progress: number;
  existsOnDisk: boolean;
}

export type MediaCategory = 'movie' | 'tv' | 'anime';

export interface TmdbMeta {
  tmdbId: number;
  mediaType: 'movie' | 'tv' | string;
  title: string;
  originalTitle: string;
  englishTitle?: string;
  year: string;
  overview: string;
  rating: number;
  posterUrl: string;
  backdropUrl: string;
  isAnime?: boolean;
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character: string;
  profileUrl: string;
}

export interface TmdbMediaCredits {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  genres: string[];
  runtimeMin: number;
  tagline: string;
  directors: string[];
  cast: TmdbCastMember[];
}

export interface WatchHistoryRecord {
  id: number;
  torrentHash: string;
  fileIndex: number;
  title: string;
  fileName: string;
  mediaCategory: MediaCategory | string;
  posterUrl: string;
  backdropUrl: string;
  year: string;
  rating: number;
  durationSec: number;
  positionSec: number;
  progress: number;
  completed: boolean;
  watchedAt: number;
  updatedAt: number;
  stillInLibrary: boolean;
}

export interface TorrentSummary {
  hash: string;
  name: string;
  size: number;
  totalSize: number;
  downloaded: number;
  progress: number;
  dlSpeed: number;
  upSpeed: number;
  state: string;
  eta: number;
  addedOn: number;
  sequential: boolean;
  firstLastPiecePrio: boolean;
  numSeeds: number;
  numLeechs: number;
  nextDeleteAt: number | null;
  watchedCount: number;
  pinnedCount: number;
  videoCount: number;
  playableCount: number;
  primaryVideo: PrimaryVideoInfo | null;
  watchProgress: number;
  bingeMode: boolean;
  bingeWindow: number;
  mediaCategory?: MediaCategory;
  tmdb: TmdbMeta | null;
}

export interface TorrentsResponse {
  qbitConnected: boolean;
  qbitVersion?: string;
  qbitError?: string;
  transfer: {
    dlSpeed: number;
    upSpeed: number;
  };
  storage: StorageStats;
  torrents: TorrentSummary[];
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
}

export interface TorrentFileItem {
  index: number;
  name: string;
  size: number;
  diskSize: number;
  progress: number;
  priority: number;
  isVideo: boolean;
  existsOnDisk: boolean;
  media: MediaItemRecord | null;
}

export interface AudioTrack {
  index: number;
  streamIndex: number;
  codec: string;
  language: string;
  title: string;
  channels: number;
}

export interface SubtitleTrack {
  id: string;
  source: 'embedded' | 'external' | 'uploaded';
  codec: string;
  language: string;
  title: string;
  url: string;
}

export type SubtitleProvider = 'shooter' | 'assrt' | 'subdl' | 'opensubtitles';

export interface OnlineSubtitleResult {
  id: string;
  provider: SubtitleProvider;
  providerLabel: string;
  providerId: string;
  title: string;
  language: string;
  format: string;
  downloads?: number;
  score?: number;
  downloadUrl?: string;
  fileHint?: string;
}

export interface OnlineSubtitleSearchResponse {
  query: string;
  results: OnlineSubtitleResult[];
  providersUsed: string[];
  configuredProviders: {
    shooter: boolean;
    assrt: boolean;
    subdl: boolean;
    opensubtitles: boolean;
  };
  errors: string[];
}

export interface DownloadLiveStatus {
  dlSpeed: number;
  state: string;
  fileProgress: number;
  sequential: boolean;
}

export interface ProbeResponse {
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  probe: {
    durationSec: number;
    bitrateBps: number;
    width: number;
    height: number;
    videoCodec: string;
    audioCodec: string;
    container: string;
    canDirectPlay: boolean;
    recommendedMode: 'direct' | 'remux';
    requiredMbps: number;
    audioTracks: AudioTrack[];
    subtitles: SubtitleTrack[];
  };
  downloadStatus?: DownloadLiveStatus;
  mediaItem: MediaItemRecord;
  streamToken: string;
  urls: {
    direct: string;
    remux: string;
    potplayer: string;
    iina: string;
    mpv: string;
    infuse: string;
    vlc: string;
    nplayer: string;
  };
}

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
  assrtToken: string;
  subdlApiKey: string;
  openSubtitlesApiKey: string;
  openSubtitlesUsername: string;
  openSubtitlesPassword: string;
}

export interface CleanupLogRecord {
  id: number;
  createdAt: number;
  torrentHash: string;
  relativePath: string;
  reason: string;
  freedBytes: number;
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

export interface TorznabIndexerRecord {
  id: number;
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
  createdAt: number;
}

export interface HubConfigResponse {
  prowlarrUrl: string;
  prowlarrApiKey: string;
  prowlarrConfigured: boolean;
  torznabIndexers: TorznabIndexerRecord[];
  storageLimitGb: number;
}

export interface ProwlarrTestResult {
  ok: boolean;
  indexerCount: number;
  enabledIndexers: Array<{ id: number; name: string; protocol: string; enable: boolean }>;
  error?: string;
}

export interface HubSearchResult {
  id: string;
  title: string;
  indexer: string;
  sourceType: 'prowlarr' | 'torznab';
  sizeBytes: number;
  seeders: number;
  leechers: number;
  publishDate: string;
  publishTimestamp: number;
  downloadUrl: string;
  magnetUrl: string;
  infoUrl: string;
  infoHash: string;
  categories: number[];
  resolution: string;
  tags: string[];
  exceedsLimit: boolean;
  unavailableReason?: string;
}

export interface HubBilingualInfo {
  triggered: boolean;
  expandedQuery: string;
  matchedTitle: string;
  candidates: TmdbMeta[];
}

export interface HubSearchResponse {
  query: string;
  category: 'all' | 'movies' | 'tv' | 'anime';
  results: HubSearchResult[];
  sourcesQueried: number;
  indexerBreakdown?: Array<{ name: string; count: number }>;
  bilingual?: HubBilingualInfo;
  errors: string[];
  storageLimitBytes: number;
}

export interface RssSubscriptionRecord {
  id: number;
  name: string;
  feedUrl: string;
  includeRegex: string;
  excludeRegex: string;
  minSizeMb: number;
  maxSizeMb: number;
  intervalMin: number;
  sequential: boolean;
  bingeMode: boolean;
  enabled: boolean;
  lastCheckedAt: number | null;
  lastError: string;
  matchedCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RssPreviewItem {
  guid: string;
  title: string;
  downloadUrl: string;
  magnetUrl: string;
  sizeBytes: number;
  publishDate: string;
  publishTimestamp: number;
  matched: boolean;
  reason: string;
  alreadySeen: boolean;
}

export interface RssSeenItemRecord {
  subscriptionId: number;
  itemGuid: string;
  title: string;
  downloadUrl: string;
  sizeBytes: number;
  matched: boolean;
  pushed: boolean;
  reason: string;
  seenAt: number;
}
