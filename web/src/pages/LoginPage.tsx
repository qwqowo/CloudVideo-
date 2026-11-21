import React, { useState } from 'react';
import { Lock, ArrowRight, Play } from 'lucide-react';
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
      setError(err instanceof Error ? err.message : '密码错误，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
      {/* Subtle Ambient Cinema Backlight */}
      <div className="pointer-events-none fixed inset-0 flex items-center justify-center">
        <div className="w-[520px] h-[520px] rounded-full bg-white/[0.03] blur-3xl" />
      </div>

      <div className="w-full max-w-sm cinema-glass rounded-3xl p-8 relative z-10">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-white text-zinc-950 flex items-center justify-center shadow-[0_8px_30px_rgba(255,255,255,0.2)] mb-4">
            <Play className="w-5 h-5 fill-current ml-0.5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-white">CloudVideo</h1>
          <p className="text-xs text-zinc-400 mt-1">欢迎回到你的私人云端影院</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <Lock className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入访问密码"
              autoFocus
              className="cinema-input w-full pl-10 pr-4 py-3 text-sm"
            />
          </div>

          {error && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="btn-ivory w-full py-3 text-sm"
          >
            {loading ? '正在验证...' : '进入影院'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <div className="mt-7 pt-4 border-t border-white/[0.06] text-center text-[11px] text-zinc-500">
          原生直出 · 边下边播 · 看完自动释放空间
        </div>
      </div>
    </div>
  );
};
