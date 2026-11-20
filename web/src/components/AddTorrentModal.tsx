import React, { useState } from 'react';
import { X, Link2, Upload, Zap, PauseCircle } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface AddTorrentModalProps {
  open: boolean;
  onClose: () => void;
  onAdded: (warning?: string) => void;
}

export const AddTorrentModal: React.FC<AddTorrentModalProps> = ({ open, onClose, onAdded }) => {
  const [mode, setMode] = useState<'magnet' | 'file'>('magnet');
  const [magnet, setMagnet] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sequential, setSequential] = useState(true);
  const [paused, setPaused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      if (mode === 'magnet') {
        if (!magnet.trim()) {
          setError('请粘贴磁力链接（magnet:?xt=...）');
          setSubmitting(false);
          return;
        }
        const res = await apiFetch<{ ok: boolean; warning?: string }>('/api/torrents/magnet', {
          method: 'POST',
          body: JSON.stringify({
            magnet: magnet.trim(),
            sequential,
            firstLastPiecePrio: sequential,
            paused,
          }),
        });
        setMagnet('');
        onAdded(res.warning);
        onClose();
      } else {
        if (!file) {
          setError('请选择一个 .torrent 种子文件');
          setSubmitting(false);
          return;
        }
        const form = new FormData();
        form.append('file', file);
        form.append('sequential', String(sequential));
        form.append('firstLastPiecePrio', String(sequential));
        form.append('paused', String(paused));
        const res = await apiFetch<{ ok: boolean; warning?: string }>('/api/torrents/upload', {
          method: 'POST',
          body: form,
        });
        setFile(null);
        onAdded(res.warning);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4">
      <div className="w-full max-w-lg hud-panel shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
          <div>
            <div className="text-[10px] font-mono tracking-[0.2em] text-cyan-400">
              INGEST // TORRENT
            </div>
            <h2 className="text-sm font-semibold text-white mt-0.5">载入云端下载任务</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white border border-transparent hover:border-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="grid grid-cols-2 border border-white/10 bg-[#05070a]">
            <button
              type="button"
              onClick={() => setMode('magnet')}
              className={`flex items-center justify-center gap-2 py-2.5 text-xs font-mono tracking-wider transition ${
                mode === 'magnet'
                  ? 'bg-cyan-400/15 text-cyan-300 border-b-2 border-cyan-400'
                  : 'text-zinc-500 hover:text-zinc-200'
              }`}
            >
              <Link2 className="w-3.5 h-3.5" />
              MAGNET 磁力
            </button>
            <button
              type="button"
              onClick={() => setMode('file')}
              className={`flex items-center justify-center gap-2 py-2.5 text-xs font-mono tracking-wider transition ${
                mode === 'file'
                  ? 'bg-cyan-400/15 text-cyan-300 border-b-2 border-cyan-400'
                  : 'text-zinc-500 hover:text-zinc-200'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              .TORRENT 文件
            </button>
          </div>

          {mode === 'magnet' ? (
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5">
                MAGNET URI / HTTP LINK
              </label>
              <textarea
                rows={3}
                value={magnet}
                onChange={(e) => setMagnet(e.target.value)}
                placeholder="magnet:?xt=urn:btih:..."
                className="w-full bg-[#05070a] border border-white/10 px-3.5 py-2.5 text-xs font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-cyan-400/70"
              />
            </div>
          ) : (
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-wider text-zinc-400 mb-1.5">
                TORRENT PAYLOAD
              </label>
              <label className="flex flex-col items-center justify-center gap-2 border border-dashed border-white/15 hover:border-cyan-400/60 bg-[#05070a] p-7 cursor-pointer transition">
                <Upload className="w-5 h-5 text-cyan-400" />
                <span className="text-xs font-mono text-zinc-300">
                  {file ? file.name : '点击选择或拖拽 .torrent 文件'}
                </span>
                <input
                  type="file"
                  accept=".torrent"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>
            </div>
          )}

          <div className="space-y-3 border border-white/[0.08] bg-[#06090e] p-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={sequential}
                onChange={(e) => setSequential(e.target.checked)}
                className="mt-0.5 accent-cyan-400"
              />
              <div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-100">
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  顺序下载 + 首尾分片优先（边下边播）
                </div>
                <p className="text-[11px] text-zinc-500 mt-0.5">
                  优先拉取头尾索引与前段画面，缓冲数秒即可直接原生直出播放。
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer pt-3 border-t border-white/[0.06]">
              <input
                type="checkbox"
                checked={paused}
                onChange={(e) => setPaused(e.target.checked)}
                className="mt-0.5 accent-cyan-400"
              />
              <div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-100">
                  <PauseCircle className="w-3.5 h-3.5 text-cyan-400" />
                  先暂停载入（适合多集大合集按需勾选）
                </div>
                <p className="text-[11px] text-zinc-500 mt-0.5">
                  小盘建议：整季剧集先暂停解析元数据，在侧边选集抽屉中仅勾选当前想看的单集。
                </p>
              </div>
            </label>
          </div>

          {error && (
            <div className="border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs font-mono text-rose-300">
              ERR // {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-white/10 text-xs font-mono text-zinc-400 hover:text-white hover:border-white/25 transition"
            >
              CANCEL
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40 text-xs font-mono font-bold tracking-wider text-zinc-950 transition"
            >
              {submitting ? 'DISPATCHING...' : 'START INGEST'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
