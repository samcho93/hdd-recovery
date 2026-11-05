import { mkdir, open, statfs, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CancelledError, throwIfAborted, yieldToLoop, type ProgressFn } from './bytes';
import type { FsEntry, RecoveryVolume } from './volume';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 디스크에서 읽은 파일명을 Windows에 안전한 이름으로 바꾼다. 경로 탈출도 여기서 막는다. */
export function sanitizeName(name: string): string {
  let out = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (out === '' || out === '.' || out === '..') out = '_이름없음';
  if (RESERVED.test(out)) out = `_${out}`;
  if (out.length > 200) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 16 ? out.slice(dot) : '';
    out = out.slice(0, 200 - ext.length) + ext;
  }
  return out;
}

function longPath(p: string): string {
  if (process.platform !== 'win32' || p.startsWith('\\\\?\\') || p.length < 240) return p;
  return p.startsWith('\\\\') ? `\\\\?\\UNC\\${p.slice(2)}` : `\\\\?\\${p}`;
}

export interface RecoverFailure {
  path: string;
  error: string;
}

export interface RecoverReport {
  destination: string;
  filesRecovered: number;
  filesFailed: number;
  bytes: number;
  warnings: { path: string; messages: string[] }[];
  failures: RecoverFailure[];
  cancelled: boolean;
  reportPath?: string;
}

export interface RecoverOptions {
  signal?: AbortSignal;
  onProgress?: ProgressFn;
}

/** 선택 항목(폴더 포함)을 대상 폴더로 복사한다. 복구 대상과 저장 위치가 같은 디스크인지는 호출 측에서 막는다. */
export async function recoverEntries(
  vol: RecoveryVolume,
  ids: number[],
  destDir: string,
  opts: RecoverOptions = {},
): Promise<RecoverReport> {
  const root = resolve(destDir);
  await mkdir(longPath(root), { recursive: true });

  // 작업 목록 전개
  const files: { entry: FsEntry; path: string }[] = [];
  const dirs: { entry: FsEntry; path: string }[] = [];
  const usedNames = new Map<string, Set<string>>();
  const uniqueIn = (dir: string, name: string): string => {
    let set = usedNames.get(dir);
    if (!set) {
      set = new Set();
      usedNames.set(dir, set);
    }
    let cand = name;
    let n = 1;
    while (set.has(cand.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      cand = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
      n++;
    }
    set.add(cand.toLowerCase());
    return cand;
  };

  const seen = new Set<number>();
  const walk = (entry: FsEntry, parentPath: string): void => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    const p = join(parentPath, uniqueIn(parentPath, sanitizeName(entry.name)));
    if (entry.isDir) {
      dirs.push({ entry, path: p });
      for (const c of vol.childrenOf(entry.id)) walk(c, p);
    } else {
      files.push({ entry, path: p });
    }
  };
  for (const id of ids) {
    const e = vol.entries.get(id);
    if (!e) continue;
    if (e.id === 0) {
      for (const c of vol.childrenOf(0)) walk(c, root);
    } else {
      walk(e, root);
    }
  }

  const totalBytes = files.reduce((s, f) => s + f.entry.size, 0);
  try {
    const fsStat = await statfs(root);
    const free = Number(fsStat.bavail) * Number(fsStat.bsize);
    if (free < totalBytes) {
      throw new Error(`저장 공간이 부족합니다. 필요 ${totalBytes} 바이트, 여유 ${free} 바이트`);
    }
  } catch (e) {
    if ((e as Error).message.startsWith('저장 공간')) throw e;
  }

  const report: RecoverReport = {
    destination: root,
    filesRecovered: 0,
    filesFailed: 0,
    bytes: 0,
    warnings: [],
    failures: [],
    cancelled: false,
  };

  let doneBytes = 0;
  try {
    for (const d of dirs) {
      await mkdir(longPath(d.path), { recursive: true });
    }
    for (const f of files) {
      throwIfAborted(opts.signal);
      const display = f.path.slice(root.length + 1);
      opts.onProgress?.({ done: doneBytes, total: totalBytes, message: display });
      let handle = null;
      try {
        handle = await open(longPath(f.path), 'wx');
        const h = handle;
        let lastReport = Date.now();
        const res = await vol.readEntry(
          f.entry,
          async (chunk) => {
            await h.write(chunk, 0, chunk.length);
            doneBytes += chunk.length;
            if (Date.now() - lastReport > 200) {
              lastReport = Date.now();
              opts.onProgress?.({ done: doneBytes, total: totalBytes, message: display });
            }
          },
          opts.signal,
        );
        await h.close();
        handle = null;
        if (f.entry.mtime) {
          const t = new Date(f.entry.mtime);
          await utimes(longPath(f.path), t, t).catch(() => {});
        }
        report.filesRecovered++;
        report.bytes += res.bytes;
        if (res.warnings.length) report.warnings.push({ path: display, messages: res.warnings });
      } catch (e) {
        if (handle) await handle.close().catch(() => {});
        if (e instanceof CancelledError) throw e;
        report.filesFailed++;
        report.failures.push({ path: display, error: (e as Error).message });
      }
      await yieldToLoop();
    }
  } catch (e) {
    if (!(e instanceof CancelledError)) throw e;
    report.cancelled = true;
  }

  // 폴더 시간은 파일 복사가 끝난 뒤에 맞춘다.
  for (const d of dirs) {
    if (d.entry.mtime) {
      const t = new Date(d.entry.mtime);
      await utimes(longPath(d.path), t, t).catch(() => {});
    }
  }

  const reportPath = join(root, `복구보고서-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {});
  report.reportPath = reportPath;
  return report;
}
