import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, setUnauthorizedHandler } from './lib/api';
import type { TorrentsResponse } from './types';
import { LoginPage } from './pages/LoginPage';
import { Layout, type NavTab } from './components/Layout';
import { LibraryPage } from './pages/LibraryPage';
import { HubPage } from './pages/HubPage';
import { ActivityPage } from './pages/ActivityPage';
import { PlayerPage } from './pages/PlayerPage';
import { SettingsPage } from './pages/SettingsPage';
import { AddTorrentModal } from './components/AddTorrentModal';

interface ActivePlayer {
  hash: string;
  fileIndex: number;
  torrentName: string;
}

export const App: React.FC = () => {
  const [authState, setAuthState] = useState<'checking' | 'guest' | 'authed'>('checking');
  const [tab, setTab] = useState<NavTab>('library');
  const [player, setPlayer] = useState<ActivePlayer | null>(null);
  const [pendingDetailHash, setPendingDetailHash] = useState<string | null>(null);
  const [pendingHubQuery, setPendingHubQuery] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [data, setData] = useState<TorrentsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState('');

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthState('guest');
      setPlayer(null);
    });
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      const res = await apiFetch<{ authenticated: boolean }>('/api/auth/me');
      setAuthState(res.authenticated ? 'authed' : 'guest');
    } catch {
      setAuthState('guest');
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  const fetchTorrents = useCallback(async () => {
    if (authState !== 'authed') return;
    setLoading(true);
    try {
      const res = await apiFetch<TorrentsResponse>('/api/torrents');
      setData(res);
    } catch {
      // handled by apiFetch
    } finally {
      setLoading(false);
    }
  }, [authState]);

  useEffect(() => {
    if (authState !== 'authed') return;
    void fetchTorrents();
    const id = setInterval(() => void fetchTorrents(), 5000);
    return () => clearInterval(id);
  }, [authState, fetchTorrents]);

  const activeDownloadsCount = useMemo(
    () => (data?.torrents ?? []).filter((t) => t.progress < 0.999).length,
    [data?.torrents]
  );

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAuthState('guest');
    setPlayer(null);
  };

  if (authState === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center text-xs text-zinc-400">
        正在进入影院...
      </div>
    );
  }

  if (authState === 'guest') {
    return <LoginPage onSuccess={() => setAuthState('authed')} />;
  }

  return (
    <Layout
      activeTab={tab}
      onNavigate={(next) => {
        setPlayer(null);
        setTab(next);
      }}
      onOpenAdd={() => setAddOpen(true)}
      onLogout={() => void handleLogout()}
      storage={data?.storage ?? null}
      transfer={data?.transfer ?? { dlSpeed: 0, upSpeed: 0 }}
      activeDownloadsCount={activeDownloadsCount}
    >
      {banner && (
        <div className="mb-5 rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 flex items-center justify-between gap-3">
          <span>{banner}</span>
          <button
            onClick={() => setBanner('')}
            className="text-amber-300 hover:text-white shrink-0"
          >
            知道了
          </button>
        </div>
      )}

      {player ? (
        <PlayerPage
          torrentHash={player.hash}
          fileIndex={player.fileIndex}
          torrentName={player.torrentName}
          onBack={() => {
            setPlayer(null);
            void fetchTorrents();
          }}
          onSelectEpisode={(nextIdx) =>
            setPlayer((cur) => (cur ? { ...cur, fileIndex: nextIdx } : null))
          }
          onDataChanged={() => void fetchTorrents()}
        />
      ) : tab === 'library' ? (
        <LibraryPage
          data={data}
          loading={loading}
          onRefresh={() => void fetchTorrents()}
          onOpenAdd={() => setAddOpen(true)}
          onGoDiscover={(prefillQuery) => {
            if (prefillQuery) setPendingHubQuery(prefillQuery);
            setTab('hub');
          }}
          onPlay={(hash, fileIndex, torrentName) => setPlayer({ hash, fileIndex, torrentName })}
          initialDetailHash={pendingDetailHash}
          onClearInitialDetail={() => setPendingDetailHash(null)}
        />
      ) : tab === 'hub' ? (
        <HubPage
          initialSearchQuery={pendingHubQuery}
          onConsumedInitialQuery={() => setPendingHubQuery(null)}
          onDownloaded={(warning) => {
            if (warning) setBanner(warning);
            void fetchTorrents();
          }}
          onGoLibrary={() => {
            setTab('library');
            void fetchTorrents();
          }}
        />
      ) : tab === 'activity' ? (
        <ActivityPage
          data={data}
          onRefresh={() => void fetchTorrents()}
          onOpenDetail={(hash) => {
            setPendingDetailHash(hash);
            setTab('library');
          }}
          onPlay={(hash, fileIndex, torrentName) => setPlayer({ hash, fileIndex, torrentName })}
        />
      ) : (
        <SettingsPage onUpdated={() => void fetchTorrents()} />
      )}

      <AddTorrentModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onGoDiscover={() => setTab('hub')}
        onAdded={(warning) => {
          if (warning) setBanner(warning);
          setPlayer(null);
          setTab('library');
          void fetchTorrents();
        }}
      />
    </Layout>
  );
};

export default App;
