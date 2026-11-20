import React from 'react';
import {
  Film,
  HardDrive,
  Gauge,
  Settings,
  Plus,
  LogOut,
  ArrowDown,
  ArrowUp,
} from 'lucide-react';
import type { StorageStats } from '../types';
import { formatBytes, formatSpeed } from '../lib/api';

export type NavTab = 'library' | 'speedtest' | 'settings';

interface LayoutProps {
  activeTab: NavTab;
  onNavigate: (tab: NavTab) => void;
  onOpenAdd: () => void;
  onLogout: () => void;
  storage: StorageStats | null;
  transfer: { dlSpeed: number; upSpeed: number };
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({
  activeTab,
  onNavigate,
  onOpenAdd,
  onLogout,
  storage,
  transfer,
  children,
}) => {
  const pct = storage?.usagePercent ?? 0;
  const barColor =
    pct >= 90 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-400' : 'bg-indigo-500';

  return (
    <div className="min-h-screen flex flex-col bg-[#070b14] text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-6">
            <button
              onClick={() => onNavigate('library')}
              className="flex items-center gap-2.5 text-left group"
            >
              <div className="w-9 h-9 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-400 group-hover:bg-indigo-500/30 transition">
                <Film className="w-5 h-5" />
              </div>
              <div className="hidden sm:block">
                <div className="text-sm font-bold tracking-tight text-white leading-none">
                  CloudVideo
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5">小盘云端影院</div>
              </div>
            </button>

            <nav className="flex items-center gap-1">
              <button
                onClick={() => onNavigate('library')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  activeTab === 'library'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <Film className="w-4 h-4" />
                <span>媒体库</span>
              </button>
              <button
                onClick={() => onNavigate('speedtest')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  activeTab === 'speedtest'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <Gauge className="w-4 h-4" />
                <span>节点测速</span>
              </button>
              <button
                onClick={() => onNavigate('settings')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  activeTab === 'settings'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <Settings className="w-4 h-4" />
                <span className="hidden sm:inline">清理与设置</span>
              </button>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {/* Live Transfer Speed */}
            <div className="hidden lg:flex items-center gap-3 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs">
              <span className="flex items-center gap-1 text-sky-400">
                <ArrowDown className="w-3.5 h-3.5" />
                {formatSpeed(transfer.dlSpeed)}
              </span>
              <span className="text-slate-700">|</span>
              <span className="flex items-center gap-1 text-emerald-400">
                <ArrowUp className="w-3.5 h-3.5" />
                {formatSpeed(transfer.upSpeed)}
              </span>
            </div>

            {/* Disk Watermark Gauge */}
            {storage && (
              <button
                onClick={() => onNavigate('settings')}
                title="点击管理存储上限与自动清理"
                className="hidden md:flex flex-col gap-1 min-w-[165px] px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 transition text-left"
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="flex items-center gap-1 text-slate-400">
                    <HardDrive className="w-3 h-3" />
                    存储水位
                  </span>
                  <span className="font-mono text-slate-200">
                    {formatBytes(storage.usedBytes)} / {formatBytes(storage.limitBytes)}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${barColor}`}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
              </button>
            )}

            <button
              onClick={onOpenAdd}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm font-medium text-white shadow-lg shadow-indigo-600/20 transition"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">添加种子</span>
            </button>

            <button
              onClick={onLogout}
              title="退出登录"
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">{children}</main>
    </div>
  );
};
