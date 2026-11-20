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
    <div className="space-y-5">
      <div className="hud-panel p-5 sm:p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-white/[0.07]">
          <div>
            <div className="text-[10px] font-mono tracking-[0.22em] text-cyan-400">
              TELEMETRY // LINK BENCHMARK
            </div>
            <h1 className="text-base sm:text-lg font-semibold text-white mt-0.5">
              节点带宽与 1080P / 4K 流畅度诊断
            </h1>
            <p className="text-xs text-zinc-400 mt-1">
              纯内存不可压缩随机流直出，实测「服务器 ↔ 当前节点」单线程（网页原生直出）与 4 线程（本地播放器缓冲）吞吐。
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={nodeNote}
              onChange={(e) => setNodeNote(e.target.value)}
              placeholder="节点备注 (如 香港CN2 / 直连)"
              disabled={running}
              className="bg-[#05070a] border border-white/10 px-3 py-2 text-xs font-mono text-white placeholder-zinc-600 w-48 focus:outline-none focus:border-cyan-400/60"
            />
            <select
              value={singleMb}
              onChange={(e) => setSingleMb(Number(e.target.value))}
              disabled={running}
              className="bg-[#05070a] border border-white/10 px-3 py-2 text-xs font-mono text-zinc-200"
            >
              <option value={15}>15 MB 轻测</option>
              <option value={25}>25 MB 标准</option>
              <option value={50}>50 MB 压测</option>
            </select>
            <button
              onClick={() => void runTest()}
              disabled={running}
              className="flex items-center gap-1.5 px-5 py-2 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40 text-xs font-mono font-bold tracking-wider text-zinc-950 transition"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {running ? 'TESTING...' : 'START TEST'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 border border-rose-500/40 bg-rose-950/40 px-4 py-2 text-xs font-mono text-rose-300">
            ERR // {error}
          </div>
        )}

        {/* Metrics Readout */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-5">
          <div className="border border-white/[0.08] bg-[#06090e] p-4">
            <div className="text-[10px] font-mono tracking-[0.18em] text-zinc-500 flex items-center gap-1.5">
              <Wifi className="w-3.5 h-3.5 text-amber-400" />
              LATENCY // RTT
            </div>
            <div className="text-2xl font-mono font-bold text-white mt-2">
              {pingMs > 0 ? `${pingMs} ms` : stage === 'ping' ? 'PINGING...' : '--'}
            </div>
          </div>

          <div className="border border-white/[0.08] bg-[#06090e] p-4">
            <div className="text-[10px] font-mono tracking-[0.18em] text-zinc-500 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-cyan-400" />
              1-THREAD // WEB DIRECT
            </div>
            <div className="text-2xl font-mono font-bold text-cyan-300 mt-2">
              {singleMbps > 0 ? `${singleMbps} Mbps` : stage === 'single' ? 'SAMPLING...' : '--'}
            </div>
            <div className="text-[11px] font-mono text-zinc-500 mt-0.5">
              {singleMbps > 0 ? `≈ ${(singleMbps / 8).toFixed(2)} MB/s` : '网页原生直出核心指标'}
            </div>
          </div>

          <div className="border border-white/[0.08] bg-[#06090e] p-4">
            <div className="text-[10px] font-mono tracking-[0.18em] text-zinc-500 flex items-center gap-1.5">
              <Gauge className="w-3.5 h-3.5 text-emerald-400" />
              4-THREAD // PLAYER BURST
            </div>
            <div className="text-2xl font-mono font-bold text-emerald-300 mt-2">
              {multiMbps > 0 ? `${multiMbps} Mbps` : stage === 'multi' ? 'SAMPLING...' : '--'}
            </div>
            <div className="text-[11px] font-mono text-zinc-500 mt-0.5">
              {multiMbps > 0 ? `≈ ${(multiMbps / 8).toFixed(2)} MB/s` : 'PotPlayer / MPV / Infuse 上限'}
            </div>
          </div>
        </div>

        {/* Oscilloscope Waveform */}
        {samples.length > 1 && (
          <div className="mt-5 border border-white/[0.08] bg-[#05080c] sci-grid-bg p-4">
            <div className="flex items-center justify-between text-[10px] font-mono tracking-wider text-zinc-400 mb-2">
              <span>SIGNAL TRACE // 1-THREAD STABILITY</span>
              <span className="text-cyan-300">PEAK {maxSampleMbps.toFixed(1)} Mbps</span>
            </div>
            <svg viewBox="0 0 600 145" className="w-full h-36 overflow-visible">
              <defs>
                <linearGradient id="cyanTrace" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.01" />
                </linearGradient>
              </defs>
              <line x1="0" y1="35" x2="600" y2="35" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <line x1="0" y1="85" x2="600" y2="85" stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
              <polygon fill="url(#cyanTrace)" points={`0,140 ${chartPoints} 600,140`} />
              <polyline
                fill="none"
                stroke="#22d3ee"
                strokeWidth="2"
                strokeLinejoin="round"
                points={chartPoints}
              />
            </svg>
          </div>
        )}

        {/* Verdict Matrix */}
        {verdict && (
          <div className="mt-5 border border-cyan-400/35 bg-cyan-950/20 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="text-xs sm:text-sm font-mono font-bold text-cyan-200">
                {verdict.rating}
              </div>
              <div className="text-xs text-zinc-300">{verdict.summary}</div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {[
                { label: '1080P WEB (4–10M)', ok: verdict.tiers.p1080Web },
                { label: '1080P REMUX (30M)', ok: verdict.tiers.p1080Remux },
                { label: '4K WEB-DL (25M)', ok: verdict.tiers.p4kWeb },
                { label: '4K REMUX (75M+)', ok: verdict.tiers.p4kRemux },
              ].map((t) => (
                <div
                  key={t.label}
                  className={`flex items-center gap-2 px-3 py-2 border text-[11px] font-mono ${
                    t.ok
                      ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                      : 'bg-[#06090e] border-white/[0.07] text-zinc-500'
                  }`}
                >
                  {t.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                  )}
                  <span>{t.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* History Log */}
      <div className="hud-panel p-5">
        <div className="text-[10px] font-mono tracking-[0.2em] text-zinc-500 mb-3">
          LOG // HISTORICAL NODE BENCHMARKS
        </div>
        {history.length === 0 ? (
          <div className="text-xs font-mono text-zinc-600 py-6 text-center">
            NO RECORDS YET
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="text-[10px] text-zinc-500 border-b border-white/[0.08]">
                <tr>
                  <th className="py-2 pr-3">TIMESTAMP</th>
                  <th className="py-2 pr-3">NODE</th>
                  <th className="py-2 pr-3">RTT</th>
                  <th className="py-2 pr-3">1-THREAD</th>
                  <th className="py-2 pr-3">4-THREAD</th>
                  <th className="py-2 pr-3">CLASS</th>
                  <th className="py-2 text-right">DEL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] text-zinc-200">
                {history.map((r) => (
                  <tr key={r.id} className="hover:bg-white/[0.02]">
                    <td className="py-2.5 pr-3 text-zinc-500 whitespace-nowrap">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2.5 pr-3">{r.note || '--'}</td>
                    <td className="py-2.5 pr-3">{r.pingMs} ms</td>
                    <td className="py-2.5 pr-3 text-cyan-300">
                      {r.singleThreadMbps} Mbps ({(r.singleThreadMbps / 8).toFixed(1)} MB/s)
                    </td>
                    <td className="py-2.5 pr-3 text-emerald-300">
                      {r.multiThreadMbps} Mbps ({(r.multiThreadMbps / 8).toFixed(1)} MB/s)
                    </td>
                    <td className="py-2.5 pr-3 text-zinc-300">{r.rating}</td>
                    <td className="py-2.5 text-right">
                      <button
                        onClick={() => void handleDeleteRecord(r.id)}
                        className="p-1 text-zinc-600 hover:text-rose-400"
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
