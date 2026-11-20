export interface StorageStats {
  usedBytes: number;
  limitBytes: number;
  usagePercent: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
  pendingDeleteCount: number;
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
  source: 'embedded' | 'external';
  codec: string;
  language: string;
  title: string;
  url: string;
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
  mediaItem: MediaItemRecord;
  streamToken: string;
  urls: {
    direct: string;
    remux: string;
    potplayer: string;
    iina: string;
    mpv: string;
  };
}

export interface AppSettings {
  storageLimitGb: number;
  autoDeleteDelayHours: number;
  watchedThreshold: number;
  uploadLimitKbps: number;
  autoCleanupEnabled: boolean;
  stopSeedingOnComplete: boolean;
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
