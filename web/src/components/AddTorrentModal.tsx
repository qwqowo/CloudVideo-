import React, { useState } from 'react';
import { X, Link2, Upload, Zap, PauseCircle, Repeat, Compass } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface AddTorrentModalProps {
  open: boolean;
  onClose: () => void;
  onAdded: (warning?: string) => void;
  onGoDiscover?: () => void;
}

export const AddTorrentModal: React.FC<AddTorrentModalProps> = ({
  open,
  onClose,
  onAdded,
  onGoDiscover,
}) => {
  const [mode, setMode] = useState<'magnet' | 'file'>('magnet');
  const [magnet, setMagnet] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sequential, setSequential] = useState(true);
  const [bingeMode, setBingeMode] = useState(false);
  const [bingeWindow, setBingeWindow] = useState(2);
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
            paused: bingeMode ? false : paused,
            bingeMode,
            bingeWindow,
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
        form.append('paused', String(bingeMode ? false : paused));
        form.append('bingeMode', String(bingeMode));
        form.append('bingeWindow', String(bingeWindow));
        const res = await apiFetch<{ ok: boolean; warning?: string }>('/api/torrents/upload', {
          method: 'POST',
          body: form,
        });
        setFile(null);
        onAdded(res.warning);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败，请检查链接');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg cinema-glass rounded-3xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/[0.07]">
          <div>
            <h2 className="text-base font-semibold text-white">添加云端片源</h2>
            <p className="text-xs text-zinc-400 mt-0.5">支持磁力链接或本地 .torrent 文件</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full text-zinc-400 hover:text-white hover:bg-white/[0.08] transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Segmented Switch */}
          <div className="grid grid-cols-2 p-1 rounded-full bg-white/[0.04] border border-white/[0.07]">
            <button
              type="button"
              onClick={() => setMode('magnet')}
              className={`flex items-center justify-center gap-2 py-2 rounded-full text-xs font-medium transition ${
                mode === 'magnet'
                  ? 'bg-white text-zinc-950 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              <Link2 className="w-3.5 h-3.5" />
              磁力链接
            </button>
            <button
              type="button"
              onClick={() => setMode('file')}
              className={`flex items-center justify-center gap-2 py-2 rounded-full text-xs font-medium transition ${
                mode === 'file'
                  ? 'bg-white text-zinc-950 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              上传 .torrent
            </button>
          </div>

          {mode === 'magnet' ? (
            <textarea
              rows={3}
              value={magnet}
              onChange={(e) => setMagnet(e.target.value)}
              placeholder="粘贴 magnet:?xt=urn:btih:... 或下载链接"
              className="cinema-input w-full px-4 py-3 text-xs font-mono resize-none"
            />
          ) : (
            <label className="flex flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed border-white/15 hover:border-white/35 bg-white/[0.02] p-8 cursor-pointer transition">
              <div className="w-10 h-10 rounded-full bg-white/[0.07] flex items-center justify-center text-zinc-200">
                <Upload className="w-4 h-4" />
              </div>
              <span className="text-xs text-zinc-300">
                {file ? file.name : '点击选择或拖入 .torrent 文件'}
              </span>
              <input
                type="file"
                accept=".torrent"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
          )}

          {/* Smart Options */}
          <div className="space-y-2.5">
            <button
              type="button"
              onClick={() => setSequential((v) => !v)}
              className={`w-full text-left p-3.5 rounded-2xl border transition flex items-start justify-between gap-3 ${
                sequential
                  ? 'bg-white/[0.06] border-white/20'
                  : 'bg-white/[0.02] border-white/[0.06] opacity-75'
              }`}
            >
              <div className="flex items-start gap-3">
                <Zap className={`w-4 h-4 mt-0.5 shrink-0 ${sequential ? 'text-amber-400' : 'text-zinc-500'}`} />
                <div>
                  <div className="text-xs font-medium text-white">边下边播（顺序下载）</div>
                  <p className="text-[11px] text-zinc-400 mt-0.5">
                    优先拉取片头片尾索引，缓冲几秒即可直接开播
                  </p>
                </div>
              </div>
              <span
                className={`mt-0.5 w-9 h-5 rounded-full transition flex items-center px-0.5 shrink-0 ${
                  sequential ? 'bg-white justify-end' : 'bg-zinc-700 justify-start'
                }`}
              >
                <span className={`w-4 h-4 rounded-full ${sequential ? 'bg-zinc-950' : 'bg-zinc-400'}`} />
              </span>
            </button>

            <div
              className={`p-3.5 rounded-2xl border transition ${
                bingeMode
                  ? 'bg-amber-500/10 border-amber-400/30'
                  : 'bg-white/[0.02] border-white/[0.06]'
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  const next = !bingeMode;
                  setBingeMode(next);
                  if (next) setPaused(false);
                }}
                className="w-full text-left flex items-start justify-between gap-3"
              >
                <div className="flex items-start gap-3">
                  <Repeat className={`w-4 h-4 mt-0.5 shrink-0 ${bingeMode ? 'text-amber-400' : 'text-zinc-500'}`} />
                  <div>
                    <div className="text-xs font-medium text-white">整季追剧托管</div>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      只下前几集，看到 70% 自动预载下集，省硬盘追完大合集
                    </p>
                  </div>
                </div>
                <span
                  className={`mt-0.5 w-9 h-5 rounded-full transition flex items-center px-0.5 shrink-0 ${
                    bingeMode ? 'bg-amber-400 justify-end' : 'bg-zinc-700 justify-start'
                  }`}
                >
                  <span className={`w-4 h-4 rounded-full ${bingeMode ? 'bg-zinc-950' : 'bg-zinc-400'}`} />
                </span>
              </button>

              {bingeMode && (
                <div className="mt-3 pt-3 border-t border-white/[0.08] flex items-center justify-between text-xs">
                  <span className="text-zinc-300">初始预载集数</span>
                  <div className="flex items-center gap-1.5">
                    {[1, 2, 3].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setBingeWindow(n)}
                        className={`px-3 py-1 rounded-full text-xs transition ${
                          bingeWindow === n
                            ? 'bg-amber-400 text-zinc-950 font-medium'
                            : 'bg-white/[0.07] text-zinc-300 hover:bg-white/[0.12]'
                        }`}
                      >
                        前 {n} 集
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {!bingeMode && (
              <button
                type="button"
                onClick={() => setPaused((v) => !v)}
                className={`w-full text-left p-3.5 rounded-2xl border transition flex items-start justify-between gap-3 ${
                  paused
                    ? 'bg-white/[0.06] border-white/20'
                    : 'bg-white/[0.02] border-white/[0.06] opacity-75'
                }`}
              >
                <div className="flex items-start gap-3">
                  <PauseCircle className="w-4 h-4 mt-0.5 shrink-0 text-zinc-400" />
                  <div>
                    <div className="text-xs font-medium text-white">先暂停载入（稍后手动选集）</div>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      添加后进入影片详情自行勾选想看的单集
                    </p>
                  </div>
                </div>
                <span
                  className={`mt-0.5 w-9 h-5 rounded-full transition flex items-center px-0.5 shrink-0 ${
                    paused ? 'bg-white justify-end' : 'bg-zinc-700 justify-start'
                  }`}
                >
                  <span className={`w-4 h-4 rounded-full ${paused ? 'bg-zinc-950' : 'bg-zinc-400'}`} />
                </span>
              </button>
            )}
          </div>

          {error && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-1">
            {onGoDiscover ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onGoDiscover();
                }}
                className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white transition"
              >
                <Compass className="w-3.5 h-3.5" />
                没有链接？去在线搜片
              </button>
            ) : (
              <span />
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="btn-ghost px-4 py-2 text-xs"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="btn-ivory px-5 py-2 text-xs"
              >
                {submitting ? '正在添加...' : '开始下载'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
