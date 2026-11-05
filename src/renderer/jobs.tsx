import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatBytes } from '../engine/bytes';
import type { Api, JobDone, JobProgress } from '../shared/types';

declare global {
  interface Window {
    api: Api;
  }
}
export const api = (): Api => window.api;

interface RunningJob {
  id: string;
  title: string;
  progress?: JobProgress;
}

interface Toast {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
}

interface JobsContextValue {
  /** 작업을 시작하고 끝날 때까지 기다린다. 실패는 토스트로 알리고 결과를 null로 돌려준다. */
  run<T>(title: string, start: () => Promise<string>): Promise<T | null>;
  toast(kind: Toast['kind'], text: string): void;
  active: RunningJob[];
}

const Ctx = createContext<JobsContextValue | null>(null);

export function useJobs(): JobsContextValue {
  const c = useContext(Ctx);
  if (!c) throw new Error('JobsProvider가 없습니다.');
  return c;
}

export function JobsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [running, setRunning] = useState<RunningJob[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const waiters = useRef(new Map<string, (d: JobDone) => void>());
  const early = useRef(new Map<string, JobDone>());
  const nextToast = useRef(1);

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = nextToast.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    if (kind !== 'error') setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  useEffect(() => {
    const offP = api().onProgress((p) => {
      setRunning((list) => list.map((j) => (j.id === p.jobId ? { ...j, progress: p } : j)));
    });
    const offD = api().onDone((d) => {
      setRunning((list) => list.filter((j) => j.id !== d.jobId));
      const w = waiters.current.get(d.jobId);
      if (w) {
        waiters.current.delete(d.jobId);
        w(d);
      } else {
        early.current.set(d.jobId, d);
      }
    });
    return () => {
      offP();
      offD();
    };
  }, []);

  const run = useCallback(
    async function run<T>(title: string, start: () => Promise<string>): Promise<T | null> {
      let id: string;
      try {
        id = await start();
      } catch (e) {
        toast('error', stripIpc((e as Error).message));
        return null;
      }
      const buffered = early.current.get(id);
      const done = await new Promise<JobDone>((resolve) => {
        if (buffered) {
          early.current.delete(id);
          resolve(buffered);
          return;
        }
        setRunning((list) => [...list, { id, title }]);
        waiters.current.set(id, resolve);
      });
      if (done.cancelled) {
        toast('info', `${title}: 취소했습니다.`);
        return null;
      }
      if (!done.ok) {
        toast('error', `${title} 실패: ${done.error}`);
        return null;
      }
      return (done.result ?? {}) as T;
    },
    [toast],
  );

  const value = useMemo(() => ({ run, toast, active: running }), [run, toast, running]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <div style={{ flex: 1 }}>{t.text}</div>
            <button className="close" aria-label="닫기" onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function stripIpc(m: string): string {
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function JobBar(): JSX.Element | null {
  const { active } = useJobs();
  if (!active.length) return null;
  return (
    <div className="jobbar">
      {active.map((j) => {
        const p = j.progress;
        const pct = p && p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : null;
        const eta =
          p?.bytesPerSec && p.total > p.done && p.total > 1024 * 1024
            ? Math.round((p.total - p.done) / p.bytesPerSec)
            : null;
        return (
          <div className="job" key={j.id}>
            <strong>{j.title}</strong>
            <div className={`progress ${pct === null ? 'indeterminate' : ''}`}>
              <div style={{ width: `${pct ?? 0}%` }} />
            </div>
            <span className="muted small">
              {pct !== null ? `${pct.toFixed(1)}%` : '진행 중'}
              {p?.bytesPerSec && p.total > 1024 * 1024 ? ` · ${formatBytes(p.bytesPerSec)}/s` : ''}
              {eta !== null ? ` · ${formatEta(eta)} 남음` : ''}
            </span>
            <button className="btn small" onClick={() => void api().cancelJob(j.id)}>
              취소
            </button>
            {p?.message ? <div className="msg">{p.message}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function formatEta(sec: number): string {
  if (sec < 60) return `${sec}초`;
  if (sec < 3600) return `${Math.round(sec / 60)}분`;
  return `${Math.floor(sec / 3600)}시간 ${Math.round((sec % 3600) / 60)}분`;
}
