import React from 'react';
import {
  HardDrive,
  Gauge,
  Settings,
  Plus,
  LogOut,
  ArrowDown,
  ArrowUp,
  Layers,
  Radar,
} from 'lucide-react';
import type { StorageStats } from '../types';
import { formatBytes, formatSpeed } from '../lib/api';

export type NavTab = 'library' | 'hub' | 'speedtest' | 'settings';

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
    pct >= 90 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-400' : 'bg-cyan-400';

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 border-b border-white/[0.08] bg-[#06090d]/90 backdrop-blur-md">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          {/* Left: Brand + Precision Nav */}
          <div className="flex items-center gap-6">
            <button
              onClick={() => onNavigate('library')}
              className="flex items-center gap-2.5 text-left group"
            >
              <div className="w-7 h-7 border border-cyan-400/50 bg-cyan-400/10 flex items-center justify-center group-hover:border-cyan-300 transition">
                <span className="w-2 h-2 bg-cyan-400" />
              </div>
              <div className="hidden sm:flex flex-col">
                <span className="text-xs font-mono font-bold tracking-[0.2em] text-white leading-none">
                  CLOUDVIDEO
                </span>
                <span className="text-[9px] font-mono tracking-[0.18em] text-zinc-500 mt-1 leading-none">
                  DECK // 01
                </span>
              </div>
            </button>

            <div className="h-5 w-[1px] bg-white/10 hidden sm:block" />

            <nav className="flex items-center gap-1">
              {[
                { id: 'library' as const, label: '媒体库', code: 'ARCHIVE', icon: Layers },
                { id: 'hub' as const, label: '探索订阅', code: 'HUB', icon: Radar },
                { id: 'speedtest' as const, label: '节点测速', code: 'LINK', icon: Gauge },
                { id: 'settings' as const, label: '存储策略', code: 'SYS', icon: Settings },
              ].map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    className={`relative flex items-center gap-2 px-3 py-1.5 text-xs transition ${
                      active
                        ? 'text-cyan-300 bg-cyan-400/[0.08]'
                        : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.03]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="font-medium">{item.label}</span>
                    <span className="hidden xl:inline text-[9px] font-mono text-zinc-500 tracking-wider">
                      {item.code}
                    </span>
                    {active && (
                      <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-cyan-400" />
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Right: Live Telemetry + Actions */}
          <div className="flex items-center gap-3">
            {/* Live Transfer Readout */}
            <div className="hidden lg:flex items-center gap-3 px-2.5 py-1 border border-white/[0.07] bg-[#0a0f16] text-[11px] font-mono">
              <span className="flex items-center gap-1 text-cyan-300">
                <ArrowDown className="w-3 h-3" />
                {formatSpeed(transfer.dlSpeed)}
              </span>
              <span className="text-zinc-700">/</span>
              <span className="flex items-center gap-1 text-amber-300">
                <ArrowUp className="w-3 h-3" />
                {formatSpeed(transfer.upSpeed)}
              </span>
            </div>

            {/* Disk Watermark Telemetry */}
            {storage && (
              <button
                onClick={() => onNavigate('settings')}
                title="点击调整存储水位上限与自动卸载规则"
                className="hidden md:flex flex-col gap-1 min-w-[170px] px-2.5 py-1 border border-white/[0.07] bg-[#0a0f16] hover:border-cyan-400/40 transition text-left"
              >
                <div className="flex items-center justify-between text-[10px] font-mono">
                  <span className="flex items-center gap-1 text-zinc-500 tracking-wider">
                    <HardDrive className="w-3 h-3" />
                    DISK
                  </span>
                  <span className="text-zinc-200">
                    {formatBytes(storage.usedBytes)}{' '}
                    <span className="text-zinc-500">/ {formatBytes(storage.limitBytes)}</span>
                  </span>
                </div>
                <div className="h-[3px] w-full bg-zinc-800 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${barColor}`}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
              </button>
            )}

            <button
              onClick={onOpenAdd}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-400 hover:bg-cyan-300 text-xs font-mono font-bold tracking-wider text-zinc-950 transition"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
              <span className="hidden sm:inline">载入种子</span>
            </button>

            <button
              onClick={onLogout}
              title="退出登录"
              className="p-1.5 border border-transparent hover:border-white/10 text-zinc-500 hover:text-zinc-200 transition"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6">{children}</main>
    </div>
  );
};
