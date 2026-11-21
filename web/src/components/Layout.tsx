import React from 'react';
import {
  Clapperboard,
  Compass,
  HardDrive,
  Settings,
  Plus,
  LogOut,
  ArrowDown,
  Play,
} from 'lucide-react';
import type { StorageStats } from '../types';
import { formatBytes, formatSpeed } from '../lib/api';

export type NavTab = 'library' | 'hub' | 'activity' | 'settings';

interface LayoutProps {
  activeTab: NavTab;
  onNavigate: (tab: NavTab) => void;
  onOpenAdd: () => void;
  onLogout: () => void;
  storage: StorageStats | null;
  transfer: { dlSpeed: number; upSpeed: number };
  activeDownloadsCount?: number;
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({
  activeTab,
  onNavigate,
  onOpenAdd,
  onLogout,
  storage,
  transfer,
  activeDownloadsCount = 0,
  children,
}) => {
  const pct = storage?.usagePercent ?? 0;
  const ringColor =
    pct >= 90 ? 'text-rose-400' : pct >= 75 ? 'text-amber-400' : 'text-zinc-200';
  const strokeDash = `${Math.min(100, pct)}, 100`;

  const navItems: Array<{ id: NavTab; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number }> = [
    { id: 'library', label: '影院', icon: Clapperboard },
    { id: 'hub', label: '找片', icon: Compass },
    {
      id: 'activity',
      label: '传输与空间',
      icon: HardDrive,
      badge: activeDownloadsCount > 0 ? activeDownloadsCount : undefined,
    },
    { id: 'settings', label: '设置', icon: Settings },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      {/* Floating Velvet Glass Header */}
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#09090b]/80 backdrop-blur-2xl">
        <div className="max-w-[1380px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          {/* Brand */}
          <button
            onClick={() => onNavigate('library')}
            className="flex items-center gap-2.5 group shrink-0"
          >
            <div className="w-8 h-8 rounded-xl bg-white text-zinc-950 flex items-center justify-center shadow-[0_4px_16px_rgba(255,255,255,0.18)] group-hover:scale-105 transition">
              <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
            </div>
            <span className="hidden sm:inline text-[15px] font-semibold tracking-tight text-white">
              CloudVideo
            </span>
          </button>

          {/* Centered Floating Pill Nav */}
          <nav className="flex items-center gap-0.5 p-1 rounded-full bg-white/[0.04] border border-white/[0.07]">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onNavigate(item.id)}
                  className={`relative flex items-center gap-1.5 px-3 sm:px-4 py-1.5 rounded-full text-xs sm:text-[13px] font-medium transition ${
                    active
                      ? 'bg-white text-zinc-950 shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-100'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{item.label}</span>
                  {item.badge !== undefined && (
                    <span
                      className={`px-1.5 py-0.5 rounded-full text-[10px] leading-none tabular-nums font-semibold ${
                        active ? 'bg-zinc-900/15 text-zinc-950' : 'bg-amber-400/20 text-amber-300'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Right: Quiet Live Status + Quick Add */}
          <div className="flex items-center gap-2 shrink-0">
            {transfer.dlSpeed > 0 && (
              <button
                onClick={() => onNavigate('activity')}
                title="查看下载速率与传输队列"
                className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-400/25 text-xs text-emerald-300 tabular-nums hover:bg-emerald-500/15 transition"
              >
                <ArrowDown className="w-3 h-3 animate-bounce" />
                {formatSpeed(transfer.dlSpeed)}
              </button>
            )}

            {storage && (
              <button
                onClick={() => onNavigate('activity')}
                title={`已用 ${formatBytes(storage.usedBytes)} / 上限 ${formatBytes(storage.limitBytes)}`}
                className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.07] text-xs text-zinc-300 transition"
              >
                <svg className="w-4 h-4 -rotate-90" viewBox="0 0 36 36">
                  <path
                    className="text-white/10"
                    strokeWidth="4"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                  <path
                    className={ringColor}
                    strokeWidth="4"
                    strokeDasharray={strokeDash}
                    strokeLinecap="round"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                </svg>
                <span className="tabular-nums">
                  {formatBytes(storage.usedBytes)}
                  <span className="text-zinc-500"> / {formatBytes(storage.limitBytes)}</span>
                </span>
              </button>
            )}

            <button
              onClick={onOpenAdd}
              className="btn-ivory px-3.5 py-1.5 text-xs"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              <span className="hidden sm:inline">添加片源</span>
            </button>

            <button
              onClick={onLogout}
              title="退出登录"
              className="p-2 rounded-full text-zinc-500 hover:text-zinc-100 hover:bg-white/[0.06] transition"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1380px] w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {children}
      </main>
    </div>
  );
};
