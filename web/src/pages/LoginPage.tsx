import React, { useState } from 'react';
import { Lock, ArrowRight, Terminal } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface LoginPageProps {
  onSuccess: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onSuccess }) => {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError('');
    try {
      await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : '认证失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
      {/* Subtle architectural reticle lines */}
      <div className="pointer-events-none fixed inset-0 flex items-center justify-center opacity-20">
        <div className="w-[540px] h-[540px] rounded-full border border-cyan-500/20" />
        <div className="absolute w-[760px] h-[1px] bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />
        <div className="absolute h-[760px] w-[1px] bg-gradient-to-b from-transparent via-cyan-500/20 to-transparent" />
      </div>

      <div className="w-full max-w-md hud-panel p-8 shadow-2xl relative z-10">
        <div className="flex items-center justify-between text-[10px] font-mono tracking-[0.22em] text-zinc-500 pb-5 border-b border-white/[0.06]">
          <span className="flex items-center gap-1.5 text-cyan-400">
            <span className="w-1.5 h-1.5 bg-cyan-400 animate-pulse" />
            AUTH // GATEWAY
          </span>
          <span>NODE-01</span>
        </div>

        <div className="my-7">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 border border-cyan-400/40 bg-cyan-400/10 flex items-center justify-center text-cyan-300">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-[0.14em] text-white uppercase">
                CLOUDVIDEO
              </h1>
              <p className="text-xs font-mono text-zinc-400 mt-0.5 tracking-wide">
                ORBITAL TORRENT MEDIA CONSOLE
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-mono uppercase tracking-[0.16em] text-zinc-400 mb-2">
              ACCESS KEY / 访问密码
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入访问密钥..."
                autoFocus
                className="w-full bg-[#05070a] border border-white/10 pl-10 pr-4 py-3 text-sm font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-cyan-400/70 transition"
              />
            </div>
          </div>

          {error && (
            <div className="border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs font-mono text-rose-300">
              ERR // {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="w-full flex items-center justify-center gap-2 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40 px-4 py-3 text-xs font-mono font-bold uppercase tracking-[0.18em] text-zinc-950 transition"
          >
            {loading ? 'VERIFYING...' : 'INITIALIZE SESSION'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-white/[0.06] flex items-center justify-between text-[10px] font-mono text-zinc-600">
          <span>DIRECT STREAM · AUTO PURGE</span>
          <span>TLS / COOKIE AUTH</span>
        </div>
      </div>
    </div>
  );
};
