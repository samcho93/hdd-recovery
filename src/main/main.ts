import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, shell, session } from 'electron';
import { CancelledError } from '../engine/bytes';
import { CarveVolume, SIGNATURES } from '../engine/carver';
import { FileDevice, SliceDevice, type BlockDevice } from '../engine/device';
import { createDiskImage } from '../engine/imaging';
import { formatFat32 } from '../engine/mkfat32';
import { NtfsVolume } from '../engine/ntfs';
import { recoverEntries } from '../engine/recover';
import { applyWrites, diagnose, listJournals, undoJournal } from '../engine/repair';
import type { SectorWrite } from '../engine/partition';
import { findVolumes, openFoundVolume, type FoundVolume } from '../engine/scanner';
import { ROOT_ID, type RecoveryVolume } from '../engine/volume';
import {
  confirmPhrase,
  type DiagnoseResult,
  type DiskInfo,
  type JobDone,
  type JobProgress,
  type ListParams,
  type ListResult,
  type ManageOp,
  type OpenVolumeResult,
  type ScanJobResult,
  type Target,
} from '../shared/types';
import * as win from './windows-disk';

let mainWindow: BrowserWindow | null = null;

// ── 대상 관리 ────────────────────────────────────────────────────

/** 화면이 임의의 경로를 지정하지 못하도록, 사용자가 대화상자에서 고른 파일만 허용한다. */
const allowedImages = new Set<string>();
const allowedSavePaths = new Set<string>();

const seenDisks = new Map<number, string>();
function diskIdentity(d: DiskInfo): string {
  return `${d.name}|${d.serial}|${d.size}`;
}

async function getDisk(number: number): Promise<DiskInfo> {
  win.assertPosInt(number, 'disk');
  const d = (await win.listDisks()).find((x) => x.number === number);
  if (!d) throw new Error(`디스크 ${number}을(를) 찾을 수 없습니다. 연결이 끊겼을 수 있습니다.`);
  return d;
}

async function openTarget(t: Target, writable = false): Promise<BlockDevice> {
  if (t.kind === 'disk') {
    const d = await getDisk(t.number);
    return FileDevice.openPhysical(d.number, d.size, d.sectorSize, writable);
  }
  const p = resolve(t.path);
  if (!allowedImages.has(p)) throw new Error('선택하지 않은 이미지 파일입니다.');
  return FileDevice.openImage(p, writable);
}

function targetKey(t: Target): string {
  return t.kind === 'disk' ? `disk:${t.number}` : `image:${resolve(t.path)}`;
}

/** 디스크에 쓰기 전 최종 검사: 보호 디스크 차단, 확인 문구 검증 */
async function guardDiskWrite(number: number, confirm: string): Promise<DiskInfo> {
  const d = await getDisk(number);
  if (d.protected) {
    throw new Error('Windows가 실행 중이거나 페이지 파일이 있는 디스크는 변경할 수 없습니다.');
  }
  // 화면에 보이던 디스크와 지금 그 번호의 디스크가 같은지 확인한다(USB 재연결로 번호가 바뀌는 경우).
  const seen = seenDisks.get(number);
  if (!seen || seen !== diskIdentity(d)) {
    throw new Error('디스크 구성이 바뀌었습니다. 목록을 새로 고친 뒤 다시 확인하세요.');
  }
  if (confirm !== confirmPhrase(number)) throw new Error('확인 문구가 일치하지 않습니다.');
  if (busyTargets.has(`disk:${number}`)) throw new Error('이 디스크에서 다른 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.');
  // 구조가 바뀌면 열어 둔 파일 목록은 더 이상 믿을 수 없고, 열린 핸들은 오프라인 전환을 방해한다.
  await closeSessionsFor(`disk:${number}`);
  return d;
}

/** 진단 결과가 쥔 읽기 핸들을 닫는다. 복원 실행은 계획 계산에 이 핸들이 필요해 따로 처리한다. */
async function closeDiagnosesFor(key: string): Promise<void> {
  for (const [id, diag] of diagnoses) {
    if (diag.target === key) {
      diagnoses.delete(id);
      await diag.dev.close().catch(() => {});
    }
  }
}

async function closeSessionsFor(key: string): Promise<void> {
  for (const [id, s] of sessions) {
    if (targetKey(s.target) === key) {
      sessions.delete(id);
      await s.dev.close().catch(() => {});
    }
  }
}

function journalDir(): string {
  return join(app.getPath('userData'), 'journals');
}

// ── 작업(Job) 관리 ───────────────────────────────────────────────

interface JobContext {
  signal: AbortSignal;
  progress(done: number, total: number, message?: string): void;
}

const jobs = new Map<string, AbortController>();
/** 같은 디스크에 동시 작업이 걸리지 않게 잠근다. */
const busyTargets = new Map<string, string>();

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function startJob<T>(
  kind: string,
  title: string,
  key: string | null,
  fn: (ctx: JobContext) => Promise<T>,
): string {
  if (key && busyTargets.has(key)) throw new Error('이 디스크에서 다른 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.');
  const jobId = randomUUID();
  const controller = new AbortController();
  jobs.set(jobId, controller);
  if (key) busyTargets.set(key, jobId);

  let last = 0;
  let lastDone = 0;
  let lastTime = Date.now();
  let speed = 0;
  const ctx: JobContext = {
    signal: controller.signal,
    progress(done, total, message = '') {
      const now = Date.now();
      if (now - last < 120 && done < total) return;
      if (now - lastTime >= 1000) {
        speed = ((done - lastDone) * 1000) / (now - lastTime);
        lastDone = done;
        lastTime = now;
      }
      last = now;
      const p: JobProgress = { jobId, done, total, message, bytesPerSec: speed };
      send('job:progress', p);
    },
  };

  // 응답을 먼저 돌려준 뒤 시작해 화면이 작업 ID를 먼저 받게 한다.
  setImmediate(async () => {
    const finish = (d: Omit<JobDone, 'jobId' | 'kind' | 'title'>): void => {
      jobs.delete(jobId);
      if (key) busyTargets.delete(key);
      send('job:done', { jobId, kind, title, ...d } satisfies JobDone);
    };
    try {
      const result = await fn(ctx);
      finish({ ok: true, cancelled: false, result });
    } catch (e) {
      if (e instanceof CancelledError) finish({ ok: false, cancelled: true });
      else finish({ ok: false, cancelled: false, error: friendlyError(e as Error) });
    }
  });
  return jobId;
}

function friendlyError(e: Error): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EPERM' || code === 'EACCES') return '디스크 접근이 거부되었습니다. 관리자 권한으로 실행했는지 확인하세요.';
  if (code === 'EBUSY') return '다른 프로그램이 디스크를 사용 중입니다.';
  if (code === 'EEXIST') return '같은 이름의 파일이 이미 있습니다.';
  if (code === 'ENOSPC') return '저장 공간이 부족합니다.';
  return e.message;
}

// ── 복구 세션 ────────────────────────────────────────────────────

interface VolumeSession {
  dev: BlockDevice;
  vol: RecoveryVolume;
  target: Target;
}
const sessions = new Map<string, VolumeSession>();

function summarize(sessionId: string, vol: RecoveryVolume): OpenVolumeResult {
  let files = 0;
  let dirs = 0;
  let deleted = 0;
  let totalBytes = 0;
  for (const e of vol.entries.values()) {
    if (e.id === ROOT_ID) continue;
    if (e.isDir) dirs++;
    else {
      files++;
      totalBytes += e.size;
    }
    if (e.deleted) deleted++;
  }
  return { sessionId, fsType: vol.fsType, total: files + dirs, files, dirs, deleted, totalBytes, warnings: vol.warnings };
}

function listEntries(p: ListParams): ListResult {
  const s = sessions.get(p.sessionId);
  if (!s) throw new Error('복구 세션이 닫혔습니다. 볼륨을 다시 여세요.');
  const limit = Math.min(p.limit ?? 500, 5000);
  const offset = p.offset ?? 0;
  const q = p.search?.trim().toLowerCase();
  let list;
  if (q) {
    list = [];
    for (const e of s.vol.entries.values()) {
      if (e.id === ROOT_ID) continue;
      if (!e.name.toLowerCase().includes(q)) continue;
      if (p.showDeletedOnly && !e.deleted) continue;
      list.push(e);
      if (list.length >= 20000) break;
    }
  } else {
    list = s.vol.childrenOf(p.dirId);
    if (p.showDeletedOnly) {
      // 폴더는 안에 삭제 항목이 있을 수 있으니 유지한다.
      list = list.filter((e) => e.deleted || e.isDir);
    }
  }
  list.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'ko'));
  const page = list.slice(offset, offset + limit).map((e) => ({
    ...e,
    path: q ? s.vol.pathOf(e.id) : undefined,
    childCount: e.isDir ? s.vol.childrenOf(e.id).length : undefined,
  }));
  const dir = s.vol.entries.get(p.dirId);
  return {
    entries: page,
    total: list.length,
    path: q ? `"${p.search}" 검색 결과` : s.vol.pathOf(p.dirId),
    parentId: p.dirId === ROOT_ID || !dir ? null : dir.parentId,
  };
}

// ── 진단 캐시 ────────────────────────────────────────────────────

const diagnoses = new Map<
  string,
  { target: string; titleOf: Map<string, string>; plans: Map<string, () => Promise<SectorWrite[]>>; dev: BlockDevice }
>();

// ── IPC ──────────────────────────────────────────────────────────

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (event, ...args) => {
    // 앱 자체 페이지가 보낸 요청만 받는다.
    if (!event.senderFrame?.url.startsWith('file://')) throw new Error('허용되지 않은 호출입니다.');
    return fn(...(args as A));
  });
}

function registerIpc(): void {
  handle('app:info', async () => ({
    version: app.getVersion(),
    elevated: process.platform === 'win32' ? await win.isElevated().catch(() => false) : false,
    platform: process.platform,
  }));

  handle('app:relaunchAsAdmin', async () => {
    const args = app.isPackaged ? [] : [app.getAppPath()];
    const list = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -Verb RunAs ${list ? `-ArgumentList ${list}` : ''}`,
      ],
      { windowsHide: true, detached: true, stdio: 'ignore' },
    );
    child.unref();
    child.on('exit', (code) => {
      if (code === 0) app.quit();
    });
  });

  handle('disks:list', async () => {
    const list = await win.listDisks();
    seenDisks.clear();
    for (const d of list) seenDisks.set(d.number, diskIdentity(d));
    return list;
  });

  handle('dialog:pickImage', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: '디스크 이미지 열기',
      filters: [
        { name: '디스크 이미지', extensions: ['img', 'dd', 'raw', 'bin', 'vhd', 'iso'] },
        { name: '모든 파일', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = resolve(r.filePaths[0]);
    allowedImages.add(p);
    return p;
  });

  handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: '복구한 파일을 저장할 폴더',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = resolve(r.filePaths[0]);
    allowedSavePaths.add(p);
    return p;
  });

  handle('dialog:pickSaveImage', async (defaultName: string) => {
    const r = await dialog.showSaveDialog(mainWindow!, {
      title: '이미지 파일 저장',
      defaultPath: String(defaultName),
      filters: [{ name: '디스크 이미지', extensions: ['img'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const p = resolve(r.filePath);
    allowedSavePaths.add(p);
    return p;
  });

  handle('shell:openPath', async (p: string) => {
    if (!allowedSavePaths.has(resolve(p))) throw new Error('열 수 없는 경로입니다.');
    await shell.openPath(resolve(p));
  });

  // ── 스캔 ──
  handle('scan:start', (target: Target, deep: boolean) =>
    startJob('scan', deep ? '정밀 볼륨 스캔' : '빠른 볼륨 스캔', targetKey(target), async (ctx) => {
      const dev = await openTarget(target);
      try {
        const res = await findVolumes(dev, {
          deep,
          signal: ctx.signal,
          onProgress: (p) => ctx.progress(p.done, p.total, p.message),
        });
        const out: ScanJobResult = {
          table: res.table,
          volumes: res.volumes,
          mode: res.mode,
          badSectors: dev.badSectorCount(),
          deviceSize: dev.size,
        };
        return out;
      } finally {
        await dev.close();
      }
    }),
  );

  handle('volume:open', (target: Target, volume: FoundVolume, deep: boolean) =>
    startJob('open', `${volume.fsType} 볼륨 탐색`, targetKey(target), async (ctx) => {
      const dev = await openTarget(target);
      try {
        const vol = await openFoundVolume(dev, volume);
        await vol.scan({ deep, signal: ctx.signal, onProgress: (p) => ctx.progress(p.done, p.total, p.message) });
        if (vol instanceof NtfsVolume && vol.entries.size <= 1 && !deep) {
          // $MFT 위치가 틀렸다면 서명 스캔으로 자동 전환한다.
          vol.warnings.push('MFT에서 항목을 찾지 못해 볼륨 전체를 탐색했습니다.');
          await vol.scan({ deep: true, signal: ctx.signal, onProgress: (p) => ctx.progress(p.done, p.total, p.message) });
        }
        const sessionId = randomUUID();
        sessions.set(sessionId, { dev, vol, target });
        return summarize(sessionId, vol);
      } catch (e) {
        await dev.close();
        throw e;
      }
    }),
  );

  handle('carve:types', () => SIGNATURES.map((s) => ({ label: s.label, group: s.group })));

  handle('carve:start', (target: Target, types: string[]) =>
    startJob('open', '서명 스캔', targetKey(target), async (ctx) => {
      const dev = await openTarget(target);
      try {
        const vol = new CarveVolume(dev, types);
        await vol.scan({ signal: ctx.signal, onProgress: (p) => ctx.progress(p.done, p.total, p.message) });
        const sessionId = randomUUID();
        sessions.set(sessionId, { dev, vol, target });
        return summarize(sessionId, vol);
      } catch (e) {
        await dev.close();
        throw e;
      }
    }),
  );

  handle('volume:list', (p: ListParams) => listEntries(p));

  handle('volume:close', async (id: string) => {
    const s = sessions.get(id);
    if (s) {
      sessions.delete(id);
      await s.dev.close().catch(() => {});
    }
  });

  handle('recover:start', async (sessionId: string, ids: number[], destDir: string) => {
    const s = sessions.get(sessionId);
    if (!s) throw new Error('복구 세션이 닫혔습니다.');
    const dest = resolve(destDir);
    if (!allowedSavePaths.has(dest)) throw new Error('저장 폴더를 다시 선택하세요.');
    if (!Array.isArray(ids) || ids.some((i) => !Number.isSafeInteger(i))) throw new Error('잘못된 선택입니다.');
    if (s.target.kind === 'disk') {
      const destDisk = await win.diskNumberOfPath(realpathSync(dest));
      if (destDisk === s.target.number) {
        throw new Error('복구 중인 디스크에 저장하면 복구할 데이터를 덮어쓸 수 있습니다. 다른 디스크를 선택하세요.');
      }
    }
    return startJob('recover', '파일 복구', targetKey(s.target), (ctx) =>
      recoverEntries(s.vol, ids, dest, { signal: ctx.signal, onProgress: (p) => ctx.progress(p.done, p.total, p.message) }),
    );
  });

  // ── 복원 ──
  handle('repair:diagnose', (target: Target, deep: boolean) =>
    startJob('diagnose', deep ? '정밀 진단' : '빠른 진단', targetKey(target), async (ctx) => {
      const dev = await openTarget(target);
      const d = await diagnose(dev, {
        deep,
        signal: ctx.signal,
        onProgress: (p) => ctx.progress(p.done, p.total, p.message),
      });
      const diagnosisId = randomUUID();
      for (const old of diagnoses.values()) await old.dev.close().catch(() => {});
      diagnoses.clear();
      diagnoses.set(diagnosisId, {
        target: targetKey(target),
        titleOf: new Map(d.actions.map((a) => [a.id, a.title])),
        plans: d.plans,
        dev,
      });
      const out: DiagnoseResult = {
        diagnosisId,
        healthy: d.healthy,
        table: d.table,
        volumes: d.volumes,
        findings: d.findings,
        actions: d.actions,
        badSectors: dev.badSectorCount(),
      };
      return out;
    }),
  );

  handle('repair:apply', async (target: Target, diagnosisId: string, actionId: string, confirm: string) => {
    const diag = diagnoses.get(diagnosisId);
    if (!diag || diag.target !== targetKey(target)) throw new Error('진단 결과가 만료되었습니다. 다시 진단하세요.');
    const plan = diag.plans.get(actionId);
    if (!plan) throw new Error('알 수 없는 복원 항목입니다.');
    const title = diag.titleOf.get(actionId) ?? '복원';
    if (target.kind === 'disk') await guardDiskWrite(target.number, confirm);
    else if (confirm !== 'IMAGE') throw new Error('확인 문구가 일치하지 않습니다.');

    return startJob('repair', title, targetKey(target), async (ctx) => {
      // 쓸 내용은 오프라인 전환 전에 계산해 둔다.
      const writes = await plan();
      await diag.dev.close().catch(() => {});
      diagnoses.delete(diagnosisId);
      const run = async (): Promise<unknown> => {
        const dev = await openTarget(target, true);
        try {
          return await applyWrites(dev, writes, {
            title,
            target: targetKey(target),
            journalDir: journalDir(),
            signal: ctx.signal,
            onProgress: (p) => ctx.progress(p.done, p.total, p.message),
          });
        } finally {
          await dev.close();
        }
      };
      return target.kind === 'disk' ? win.withRawWriteAccess(target.number, run) : run();
    });
  });

  handle('repair:journals', () => listJournals(journalDir()));

  handle('repair:undo', async (target: Target, journalId: string, confirm: string) => {
    const journal = (await listJournals(journalDir())).find((j) => j.id === journalId);
    if (!journal) throw new Error('저널을 찾을 수 없습니다.');
    if (journal.target !== targetKey(target)) throw new Error('이 저널은 다른 디스크에서 만들어졌습니다.');
    if (target.kind === 'disk') await guardDiskWrite(target.number, confirm);
    else if (confirm !== 'IMAGE') throw new Error('확인 문구가 일치하지 않습니다.');
    await closeDiagnosesFor(targetKey(target));
    return startJob('undo', `되돌리기: ${journal.title}`, targetKey(target), async () => {
      const run = async (): Promise<void> => {
        const dev = await openTarget(target, true);
        try {
          await undoJournal(dev, journalDir(), journalId);
        } finally {
          await dev.close();
        }
      };
      if (target.kind === 'disk') await win.withRawWriteAccess(target.number, run);
      else await run();
    });
  });

  // ── 디스크 관리 ──
  handle('manage:range', (disk: number, partition: number) =>
    win.supportedSize(win.assertPosInt(disk, 'disk'), win.assertPosInt(partition, 'partition')),
  );

  handle('manage:op', async (op: ManageOp, confirm: string) => {
    const disk = win.assertPosInt(op.disk, 'disk');
    // 드라이브 문자/레이블/검사/온라인 전환은 데이터를 지우지 않으므로 확인 문구가 없어도 된다.
    const safe = op.op === 'letter' || op.op === 'label' || op.op === 'check' || op.op === 'online';
    if (safe) {
      const d = await getDisk(disk);
      if (d.protected && (op.op === 'online' || (op.op === 'check' && op.fix))) {
        throw new Error('Windows가 실행 중인 디스크에는 사용할 수 없습니다.');
      }
    } else {
      await guardDiskWrite(disk, confirm);
      await closeDiagnosesFor(`disk:${disk}`);
    }
    return startJob('manage', manageTitle(op), `disk:${disk}`, async (ctx) => {
      ctx.progress(0, 0, manageTitle(op));
      switch (op.op) {
        case 'format':
          await win.formatPartition(disk, op.partition, { fs: op.fs, label: op.label, quick: op.quick, allocationUnit: op.allocationUnit });
          break;
        case 'delete':
          await win.deletePartition(disk, op.partition);
          break;
        case 'create':
          await win.createPartition(disk, { size: op.size, fs: op.fs, label: op.label, quick: op.quick });
          break;
        case 'resize':
          await win.resizePartition(disk, op.partition, op.size);
          break;
        case 'split':
          await win.splitPartition(disk, op.partition, { firstSize: op.firstSize, fs: op.fs, label: op.label });
          break;
        case 'merge':
          return win.mergePartitions(disk, op.left, op.right, op.preserve, (m) => ctx.progress(0, 0, m));
        case 'initialize':
          await win.initializeDisk(disk, op.style);
          break;
        case 'wipe-table': {
          const d = await getDisk(disk);
          if (d.style !== 'RAW') await win.clearDisk(disk);
          await win.initializeDisk(disk, op.style);
          break;
        }
        case 'letter':
          await win.setDriveLetter(disk, op.partition, op.letter || null);
          break;
        case 'label':
          await win.setVolumeLabel(disk, op.partition, op.label);
          break;
        case 'check':
          return { status: await win.checkVolume(disk, op.partition, op.fix) };
        case 'online':
          await win.setDiskOnline(disk, op.online);
          break;
      }
      return { ok: true };
    });
  });

  // Windows 포맷 도구는 32GB를 넘는 FAT32를 만들지 못하므로 자체 포맷터를 쓴다.
  handle('manage:fat32', async (disk: number, partition: number, label: string, confirm: string) => {
    const d = await guardDiskWrite(win.assertPosInt(disk, 'disk'), confirm);
    await closeDiagnosesFor(`disk:${disk}`);
    const part = d.partitions.find((p) => p.number === partition);
    if (!part) throw new Error('파티션을 찾을 수 없습니다.');
    return startJob('manage', `FAT32 포맷 (파티션 ${partition})`, `disk:${disk}`, async (ctx) => {
      await win.withRawWriteAccess(disk, async () => {
        const dev = await FileDevice.openPhysical(disk, d.size, d.sectorSize, true);
        try {
          const slice = new SliceDevice(dev, part.offset, part.size);
          await formatFat32(
            slice,
            { label, signal: ctx.signal, onProgress: (p) => ctx.progress(p.done, p.total, p.message) },
            part.offset / d.sectorSize,
          );
        } finally {
          await dev.close();
        }
      });
      if (d.style === 'MBR') await win.setMbrType(disk, partition, 0x0c).catch(() => {});
      return { ok: true };
    });
  });

  // ── 이미징 ──
  handle('imaging:start', async (target: Target, dest: string) => {
    const p = resolve(dest);
    if (!allowedSavePaths.has(p)) throw new Error('저장 위치를 다시 선택하세요.');
    if (target.kind === 'disk') {
      const destDisk = await win.diskNumberOfPath(p);
      if (destDisk === target.number) throw new Error('원본 디스크에는 이미지를 저장할 수 없습니다.');
    }
    return startJob('imaging', '디스크 이미지 생성', targetKey(target), async (ctx) => {
      const dev = await openTarget(target);
      try {
        return await createDiskImage(dev, p, {
          signal: ctx.signal,
          onProgress: (x) => ctx.progress(x.done, x.total, x.message),
        });
      } finally {
        await dev.close();
      }
    });
  });

  handle('job:cancel', (jobId: string) => {
    jobs.get(jobId)?.abort();
  });
}

function manageTitle(op: ManageOp): string {
  switch (op.op) {
    case 'format':
      return `${op.quick ? '빠른 포맷' : '전체 포맷'} (파티션 ${op.partition}, ${op.fs})`;
    case 'delete':
      return `파티션 ${op.partition} 삭제`;
    case 'create':
      return '새 파티션 만들기';
    case 'resize':
      return `파티션 ${op.partition} 크기 변경`;
    case 'split':
      return `파티션 ${op.partition} 분할`;
    case 'merge':
      return `파티션 ${op.left}, ${op.right} 통합`;
    case 'initialize':
      return `디스크 초기화 (${op.style})`;
    case 'wipe-table':
      return `파티션 테이블 새로 만들기 (${op.style})`;
    case 'letter':
      return '드라이브 문자 변경';
    case 'label':
      return '볼륨 이름 변경';
    case 'check':
      return op.fix ? '파일시스템 검사 및 수정' : '파일시스템 검사';
    case 'online':
      return op.online ? '디스크 온라인 전환' : '디스크 오프라인 전환';
  }
}

// ── 창 ───────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'HDD Recovery',
    backgroundColor: '#14171c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  void mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  for (const c of jobs.values()) c.abort();
  app.quit();
});
