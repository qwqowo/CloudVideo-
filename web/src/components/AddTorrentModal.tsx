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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-white">添加下载任务</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-slate-950 border border-slate-800">
            <button
              type="button"
              onClick={() => setMode('magnet')}
              className={`flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition ${
                mode === 'magnet'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Link2 className="w-4 h-4" />
              磁力链接
            </button>
            <button
              type="button"
              onClick={() => setMode('file')}
              className={`flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition ${
                mode === 'file'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Upload className="w-4 h-4" />
              上传 .torrent
            </button>
          </div>

          {mode === 'magnet' ? (
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Magnet 磁力链接或 HTTP 种子链接
              </label>
              <textarea
                rows={3}
                value={magnet}
                onChange={(e) => setMagnet(e.target.value)}
                placeholder="magnet:?xt=urn:btih:..."
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
              />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                选择 .torrent 文件
              </label>
              <label className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-700 hover:border-indigo-500/70 bg-slate-950/60 p-6 cursor-pointer transition">
                <Upload className="w-6 h-6 text-slate-400" />
                <span className="text-sm text-slate-300">
                  {file ? file.name : '点击选择或拖拽 .torrent 文件到此处'}
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

          <div className="space-y-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80 p-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={sequential}
                onChange={(e) => setSequential(e.target.checked)}
                className="mt-1 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500"
              />
              <div>
                <div className="flex items-center gap-1.5 text-sm font-medium text-slate-200">
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  顺序下载 + 首尾优先（边下边播）
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  优先拉取视频头尾索引并按时间顺序下载，缓冲几秒即可开始播放。
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer pt-2 border-t border-slate-800/70">
              <input
                type="checkbox"
                checked={paused}
                onChange={(e) => setPaused(e.target.checked)}
                className="mt-1 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500"
              />
              <div>
                <div className="flex items-center gap-1.5 text-sm font-medium text-slate-200">
                  <PauseCircle className="w-3.5 h-3.5 text-sky-400" />
                  添加后先暂停（适合大合集手动选集）
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  小盘建议：整季剧集可先暂停添加，展开后只勾选要看的 1–2 集再开始下载。
                </p>
              </div>
            </label>
          </div>

          {error && (
            <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-xs text-rose-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-sm text-slate-300 hover:bg-slate-800 transition"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-semibold text-white transition"
            >
              {submitting ? '正在提交...' : '开始下载'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
