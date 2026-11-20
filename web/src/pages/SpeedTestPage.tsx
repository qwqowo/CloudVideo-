import React, { useEffect, useState } from 'react';
import { Gauge, Play, Trash2, CheckCircle2, XCircle, Activity, Wifi } from 'lucide-react';
import type { SpeedTestRecord } from '../types';
import { apiFetch, evaluateBandwidth } from '../lib/api';

interface SpeedSample {
  sec: number;
  mbps: number;
}

export const SpeedTestPage: React.FC = () => {
  const [nodeNote, setNodeNote] = useState('');
  const [singleMb, setSingleMb] = useState(25);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<'idle' | 'ping' | 'single' | 'multi' | 'done'>('idle');
  const [pingMs, setPingMs] = useState<number>(0);
  const [singleMbps, setSingleMbps] = useState<number>(0);
  const [multiMbps, setMultiMbps] = useState<number>(0);
  const [samples, setSamples] = useState<SpeedSample[]>([]);
  const [history, setHistory] = useState<SpeedTestRecord[]>([]);
  const [error, setError] = useState('');

  const loadHistory = async () => {
    try {
      const res = await apiFetch<{ history: SpeedTestRecord[] }>('/api/speedtest/history');
      setHistory(res.history);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void loadHistory();
  }, []);

  const measurePing = async (): Promise<number> => {
    const rtts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await fetch(`/api/speedtest/ping?t=${Date.now()}-${i}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      rtts.push(performance.now() - t0);
    }
    rtts.sort((a, b) => a - b);
    return Number(rtts[Math.floor(rtts.length / 2)].toFixed(1));
  };

  const measureSingleThread = async (mb: number): Promise<number> => {
    const t0 = performance.now();
    let lastTick = t0;
    let totalBytes = 0;
    let windowBytes = 0;
    const collected: SpeedSample[] = [];

    const res = await fetch(`/api/speedtest/download?mb=${mb}&r=${Date.now()}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok || !res.body) throw new Error('测速接口请求失败');

    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        windowBytes += value.byteLength;
      }
      const now = performance.now();
      if (now - lastTick >= 200) {
        const dtSec = (now - lastTick) / 1000;
        const instMbps = (windowBytes * 8) / (dtSec * 1_000_000);
        collected.push({
          sec: Number(((now - t0) / 1000).toFixed(2)),
          mbps: Number(instMbps.toFixed(2)),
        });
        setSamples([...collected]);
        const avgSoFar = (totalBytes * 8) / (((now - t0) / 1000) * 1_000_000);
        setSingleMbps(Number(avgSoFar.toFixed(2)));
        lastTick = now;
        windowBytes = 0;
      }
    }

    const totalSec = Math.max(0.05, (performance.now() - t0) / 1000);
    const finalMbps = Number(((totalBytes * 8) / (totalSec * 1_000_000)).toFixed(2));
    setSingleMbps(finalMbps);
    return finalMbps;
  };

  const measureMultiThread = async (mbPerThread: number, threads = 4): Promise<number> => {
    const t0 = performance.now();
    let totalBytes = 0;

    await Promise.all(
      Array.from({ length: threads }, async (_, idx) => {
        const res = await fetch(
          `/api/speedtest/download?mb=${mbPerThread}&c=${idx}&r=${Date.now()}`,
          { credentials: 'include', cache: 'no-store' }
        );
        if (!res.ok || !res.body) throw new Error('多线程测速失败');
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.byteLength;
            const elapsed = Math.max(0.1, (performance.now() - t0) / 1000);
            setMultiMbps(Number(((totalBytes * 8) / (elapsed * 1_000_000)).toFixed(2)));
          }
        }
      })
    );

    const totalSec = Math.max(0.05, (performance.now() - t0) / 1000);
    const finalMbps = Number(((totalBytes * 8) / (totalSec * 1_000_000)).toFixed(2));
    setMultiMbps(finalMbps);
    return finalMbps;
  };

  const runTest = async () => {
    setRunning(true);
    setError('');
    setSamples([]);
    setPingMs(0);
    setSingleMbps(0);
    setMultiMbps(0);

    try {
      setStage('ping');
      const p = await measurePing();
      setPingMs(p);

      setStage('single');
      const s = await measureSingleThread(singleMb);

      setStage('multi');
      const m = await measureMultiThread(Math.max(8, Math.round(singleMb / 2)), 4);

      setStage('done');
      const verdict = evaluateBandwidth(s, m);

      await apiFetch('/api/speedtest/history', {
        method: 'POST',
        body: JSON.stringify({
          pingMs: p,
          singleThreadMbps: s,
          multiThreadMbps: m,
          rating: verdict.rating,
          note: nodeNote.trim() || '当前节点',
        }),
      });
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : '测速中断');
      setStage('idle');
    } finally {
      setRunning(false);
    }
  };

  const handleDeleteRecord = async (id: number) => {
    await apiFetch(`/api/speedtest/history/${id}`, { method: 'DELETE' });
    await loadHistory();
  };

  const verdict = stage === 'done' ? evaluateBandwidth(singleMbps, multiMbps) : null;
  const maxSampleMbps = Math.max(20, ...samples.map((s) => s.mbps));

  const chartPoints = samples
    .map((s, idx) => {
      const x = samples.length > 1 ? (idx / (samples.length - 1)) * 600 : 0;
      const y = 140 - Math.min(132, (s.mbps / maxSampleMbps) * 128);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/75 p-5 sm:p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-white flex items-center gap-2">
              <Gauge className="w-5 h-5 text-indigo-400" />
              节点带宽与 1080p / 4K 流畅度测速
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              纯内存随机不可压缩数据流直出，真实测试「服务器 ↔ 你当前节点」的单线程（浏览器看片）与 4 线程（本地播放器缓冲）吞吐。
            </p>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            <input
              type="text"
              value={nodeNote}
              onChange={(e) => setNodeNote(e.target.value)}
              placeholder="备注节点名（如 香港CN2 / 直连）"
              disabled={running}
              className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs sm:text-sm text-white placeholder-slate-500 w-52 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
            />
            <select
              value={singleMb}
              onChange={(e) => setSingleMb(Number(e.target.value))}
              disabled={running}
              className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs sm:text-sm text-slate-200"
            >
              <option value={15}>轻量测试 (15 MB)</option>
              <option value={25}>标准测试 (25 MB)</option>
              <option value={50}>晚高峰压测 (50 MB)</option>
            </select>
            <button
              onClick={() => void runTest()}
              disabled={running}
              className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-semibold text-white transition"
            >
              <Play className="w-4 h-4 fill-current" />
              {running ? '测速中...' : '开始测速'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-xs text-rose-300">
            {error}
          </div>
        )}

        {/* Live Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
          <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-4">
            <div className="text-xs text-slate-400 flex items-center gap-1.5">
              <Wifi className="w-3.5 h-3.5 text-amber-400" />
              往返延迟 (Ping)
            </div>
            <div className="text-2xl font-bold font-mono text-white mt-1.5">
              {pingMs > 0 ? `${pingMs} ms` : stage === 'ping' ? '测试中...' : '--'}
            </div>
          </div>

          <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-4">
            <div className="text-xs text-slate-400 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-sky-400" />
              单线程下行（网页看片核心指标）
            </div>
            <div className="text-2xl font-bold font-mono text-sky-300 mt-1.5">
              {singleMbps > 0 ? `${singleMbps} Mbps` : stage === 'single' ? '测试中...' : '--'}
            </div>
            <div className="text-[11px] text-slate-400 font-mono mt-0.5">
              {singleMbps > 0 ? `≈ ${(singleMbps / 8).toFixed(2)} MB/s` : '决定浏览器直连流畅度'}
            </div>
          </div>

          <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-4">
            <div className="text-xs text-slate-400 flex items-center gap-1.5">
              <Gauge className="w-3.5 h-3.5 text-emerald-400" />
              4 线程并发（本地播放器缓冲上限）
            </div>
            <div className="text-2xl font-bold font-mono text-emerald-300 mt-1.5">
              {multiMbps > 0 ? `${multiMbps} Mbps` : stage === 'multi' ? '测试中...' : '--'}
            </div>
            <div className="text-[11px] text-slate-400 font-mono mt-0.5">
              {multiMbps > 0 ? `≈ ${(multiMbps / 8).toFixed(2)} MB/s` : 'PotPlayer / MPV / Infuse 参考'}
            </div>
          </div>
        </div>

        {/* Realtime Single-Thread Stability Chart */}
        {samples.length > 1 && (
          <div className="mt-5 rounded-xl bg-slate-950/80 border border-slate-800 p-4">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
              <span>单线程瞬时速率波动曲线（判断晚高峰是否丢包抖动）</span>
              <span className="font-mono">峰值参考：{maxSampleMbps.toFixed(1)} Mbps</span>
            </div>
            <svg viewBox="0 0 600 145" className="w-full h-36 overflow-visible">
              <defs>
                <linearGradient id="speedGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity="0.45" />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <line x1="0" y1="35" x2="600" y2="35" stroke="#1e293b" strokeDasharray="4 4" />
              <line x1="0" y1="85" x2="600" y2="85" stroke="#1e293b" strokeDasharray="4 4" />
              <polygon
                fill="url(#speedGrad)"
                points={`0,140 ${chartPoints} 600,140`}
              />
              <polyline
                fill="none"
                stroke="#818cf8"
                strokeWidth="2.5"
                strokeLinejoin="round"
                points={chartPoints}
              />
            </svg>
          </div>
        )}

        {/* Verdict */}
        {verdict && (
          <div className="mt-5 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="text-sm font-bold text-white">{verdict.rating}</div>
              <div className="text-xs text-indigo-200">{verdict.summary}</div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {[
                { label: '1080p 流媒体 (4–10M)', ok: verdict.tiers.p1080Web },
                { label: '1080p 高码率 Remux (30M)', ok: verdict.tiers.p1080Remux },
                { label: '4K 流媒体 Web-DL (25M)', ok: verdict.tiers.p4kWeb },
                { label: '4K 原盘 Remux (75M+)', ok: verdict.tiers.p4kRemux },
              ].map((t) => (
                <div
                  key={t.label}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${
                    t.ok
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                      : 'bg-slate-900/80 border-slate-800 text-slate-400'
                  }`}
                >
                  {t.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-slate-500 shrink-0" />
                  )}
                  <span>{t.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* History Table */}
      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/75 p-5">
        <h2 className="text-sm font-semibold text-white mb-3">历史节点测速对比</h2>
        {history.length === 0 ? (
          <div className="text-xs text-slate-500 py-6 text-center">
            暂无测速记录，切换不同节点后多次测速即可直观对比晚高峰速度。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-2 pr-3">时间</th>
                  <th className="py-2 pr-3">节点备注</th>
                  <th className="py-2 pr-3">延迟</th>
                  <th className="py-2 pr-3">单线程</th>
                  <th className="py-2 pr-3">4 线程</th>
                  <th className="py-2 pr-3">结论</th>
                  <th className="py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {history.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2.5 pr-3 text-slate-400 whitespace-nowrap">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2.5 pr-3 font-medium">{r.note || '--'}</td>
                    <td className="py-2.5 pr-3 font-mono">{r.pingMs} ms</td>
                    <td className="py-2.5 pr-3 font-mono text-sky-300">
                      {r.singleThreadMbps} Mbps ({(r.singleThreadMbps / 8).toFixed(1)} MB/s)
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-emerald-300">
                      {r.multiThreadMbps} Mbps ({(r.multiThreadMbps / 8).toFixed(1)} MB/s)
                    </td>
                    <td className="py-2.5 pr-3">{r.rating}</td>
                    <td className="py-2.5 text-right">
                      <button
                        onClick={() => void handleDeleteRecord(r.id)}
                        className="p-1 rounded text-slate-500 hover:text-rose-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
