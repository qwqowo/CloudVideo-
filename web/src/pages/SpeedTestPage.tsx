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
      <div className="cinema-surface rounded-3xl p-6 space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-white">观影链路测速与清晰度诊断</h2>
            <p className="text-xs text-zinc-400 mt-1">
              纯内存不可压缩随机流实测，验证当前网络节点能否流畅播放 1080P / 4K 原盘。
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={nodeNote}
              onChange={(e) => setNodeNote(e.target.value)}
              placeholder="备注节点（如 香港CN2）"
              disabled={running}
              className="cinema-input px-3.5 py-2 text-xs w-44"
            />
            <select
              value={singleMb}
              onChange={(e) => setSingleMb(Number(e.target.value))}
              disabled={running}
              className="cinema-input px-3 py-2 text-xs"
            >
              <option value={15}>15 MB 轻测</option>
              <option value={25}>25 MB 标准</option>
              <option value={50}>50 MB 压测</option>
            </select>
            <button
              onClick={() => void runTest()}
              disabled={running}
              className="btn-ivory px-5 py-2 text-xs"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {running ? '测速中...' : '开始测速'}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200">
            {error}
          </div>
        )}

        {/* Metrics Readout */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-5">
            <div className="text-xs text-zinc-400 flex items-center gap-1.5">
              <Wifi className="w-3.5 h-3.5 text-amber-400" />
              往返延迟
            </div>
            <div className="text-3xl font-semibold text-white mt-2 tabular-nums">
              {pingMs > 0 ? `${pingMs} ms` : stage === 'ping' ? '测延迟...' : '--'}
            </div>
            <div className="text-[11px] text-zinc-500 mt-1">影响起播与拖动响应</div>
          </div>

          <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-5">
            <div className="text-xs text-zinc-400 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-white" />
              单线程吞吐（网页直出）
            </div>
            <div className="text-3xl font-semibold text-white mt-2 tabular-nums">
              {singleMbps > 0 ? `${singleMbps} Mbps` : stage === 'single' ? '采样中...' : '--'}
            </div>
            <div className="text-[11px] text-zinc-500 mt-1 tabular-nums">
              {singleMbps > 0 ? `约 ${(singleMbps / 8).toFixed(2)} MB/s` : '浏览器播放的核心参考'}
            </div>
          </div>

          <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-5">
            <div className="text-xs text-zinc-400 flex items-center gap-1.5">
              <Gauge className="w-3.5 h-3.5 text-emerald-400" />
              4 线程并发（本地播放器）
            </div>
            <div className="text-3xl font-semibold text-emerald-300 mt-2 tabular-nums">
              {multiMbps > 0 ? `${multiMbps} Mbps` : stage === 'multi' ? '采样中...' : '--'}
            </div>
            <div className="text-[11px] text-zinc-500 mt-1 tabular-nums">
              {multiMbps > 0 ? `约 ${(multiMbps / 8).toFixed(2)} MB/s` : 'Infuse / PotPlayer 缓冲上限'}
            </div>
          </div>
        </div>

        {/* Smooth Speed Curve */}
        {samples.length > 1 && (
          <div className="rounded-2xl bg-[#0c0c10] border border-white/[0.06] p-5">
            <div className="flex items-center justify-between text-xs text-zinc-400 mb-3">
              <span>单线程速率波动曲线</span>
              <span className="text-white tabular-nums">峰值 {maxSampleMbps.toFixed(1)} Mbps</span>
            </div>
            <svg viewBox="0 0 600 145" className="w-full h-36 overflow-visible">
              <defs>
                <linearGradient id="velvetCurve" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="#ffffff" stopOpacity="0.01" />
                </linearGradient>
              </defs>
              <line x1="0" y1="45" x2="600" y2="45" stroke="rgba(255,255,255,0.05)" strokeDasharray="4 4" />
              <line x1="0" y1="95" x2="600" y2="95" stroke="rgba(255,255,255,0.05)" strokeDasharray="4 4" />
              <polygon fill="url(#velvetCurve)" points={`0,140 ${chartPoints} 600,140`} />
              <polyline
                fill="none"
                stroke="#ffffff"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={chartPoints}
              />
            </svg>
          </div>
        )}

        {/* Verdict */}
        {verdict && (
          <div className="rounded-2xl bg-white/[0.04] border border-white/[0.1] p-5 space-y-3.5">
            <div>
              <div className="text-sm font-semibold text-white">{verdict.rating}</div>
              <div className="text-xs text-zinc-400 mt-0.5">{verdict.summary}</div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {[
                { label: '1080P 流媒体', ok: verdict.tiers.p1080Web },
                { label: '1080P 原盘 Remux', ok: verdict.tiers.p1080Remux },
                { label: '4K 流媒体', ok: verdict.tiers.p4kWeb },
                { label: '4K 原盘 Remux', ok: verdict.tiers.p4kRemux },
              ].map((t) => (
                <div
                  key={t.label}
                  className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl border text-xs ${
                    t.ok
                      ? 'bg-emerald-500/10 border-emerald-400/30 text-emerald-200'
                      : 'bg-white/[0.02] border-white/[0.06] text-zinc-500'
                  }`}
                >
                  {t.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-zinc-600 shrink-0" />
                  )}
                  <span>{t.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Benchmark History */}
      <div className="cinema-surface rounded-3xl p-6 space-y-4">
        <div className="text-sm font-semibold text-white">历史节点测速记录</div>
        {history.length === 0 ? (
          <div className="text-xs text-zinc-500 py-6 text-center">暂无历史测速记录</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500 border-b border-white/[0.07]">
                <tr>
                  <th className="py-2.5 pr-3 font-normal">时间</th>
                  <th className="py-2.5 pr-3 font-normal">节点备注</th>
                  <th className="py-2.5 pr-3 font-normal">延迟</th>
                  <th className="py-2.5 pr-3 font-normal">单线程</th>
                  <th className="py-2.5 pr-3 font-normal">4 线程</th>
                  <th className="py-2.5 pr-3 font-normal">评估</th>
                  <th className="py-2.5 text-right font-normal">删除</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] text-zinc-200 tabular-nums">
                {history.map((r) => (
                  <tr key={r.id} className="hover:bg-white/[0.02]">
                    <td className="py-3 pr-3 text-zinc-400 whitespace-nowrap">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="py-3 pr-3 font-medium">{r.note || '--'}</td>
                    <td className="py-3 pr-3">{r.pingMs} ms</td>
                    <td className="py-3 pr-3 text-white">
                      {r.singleThreadMbps} Mbps ({(r.singleThreadMbps / 8).toFixed(1)} MB/s)
                    </td>
                    <td className="py-3 pr-3 text-emerald-300">
                      {r.multiThreadMbps} Mbps ({(r.multiThreadMbps / 8).toFixed(1)} MB/s)
                    </td>
                    <td className="py-3 pr-3 text-zinc-300">{r.rating}</td>
                    <td className="py-3 text-right">
                      <button
                        onClick={() => void handleDeleteRecord(r.id)}
                        className="p-1.5 rounded-full text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition"
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
