/** 메인 프로세스와 화면이 함께 쓰는 타입 */
import type { FsEntry } from '../engine/volume';
import type { FoundVolume } from '../engine/scanner';
import type { JournalInfo, RepairAction } from '../engine/repair';
import type { TableInfo } from '../engine/partition';
import type { RecoverReport } from '../engine/recover';
import type { DiskInfo, FileSystemName } from '../main/windows-disk';

export type { FsEntry, FoundVolume, JournalInfo, RepairAction, TableInfo, RecoverReport, DiskInfo, FileSystemName };

export type Target = { kind: 'disk'; number: number } | { kind: 'image'; path: string };

export interface AppInfo {
  version: string;
  elevated: boolean;
  platform: string;
}

export interface JobProgress {
  jobId: string;
  done: number;
  total: number;
  message: string;
  bytesPerSec?: number;
}

export interface JobState {
  id: string;
  kind: string;
  title: string;
  startedAt: number;
}

export interface JobDone {
  jobId: string;
  kind: string;
  title: string;
  ok: boolean;
  cancelled: boolean;
  error?: string;
  result?: unknown;
}

export interface ScanJobResult {
  table: TableInfo;
  volumes: FoundVolume[];
  mode: 'quick' | 'deep';
  badSectors: number;
  deviceSize: number;
}

export interface OpenVolumeResult {
  sessionId: string;
  fsType: string;
  total: number;
  files: number;
  dirs: number;
  deleted: number;
  totalBytes: number;
  warnings: string[];
}

export interface ListParams {
  sessionId: string;
  dirId: number;
  showDeletedOnly?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ListedEntry extends FsEntry {
  /** 검색 결과에서 표시할 전체 경로 */
  path?: string;
  childCount?: number;
}

export interface ListResult {
  entries: ListedEntry[];
  total: number;
  path: string;
  parentId: number | null;
}

export interface DiagnoseResult {
  diagnosisId: string;
  healthy: boolean;
  table: TableInfo;
  volumes: FoundVolume[];
  findings: string[];
  actions: RepairAction[];
  badSectors: number;
}

export type ManageOp =
  | { op: 'format'; disk: number; partition: number; fs: FileSystemName; label?: string; quick: boolean; allocationUnit?: number }
  | { op: 'delete'; disk: number; partition: number }
  | { op: 'create'; disk: number; size?: number; fs: FileSystemName; label?: string; quick: boolean }
  | { op: 'resize'; disk: number; partition: number; size: number }
  | { op: 'split'; disk: number; partition: number; firstSize: number; fs: FileSystemName; label?: string }
  | { op: 'merge'; disk: number; left: number; right: number; preserve: boolean }
  | { op: 'initialize'; disk: number; style: 'GPT' | 'MBR' }
  | { op: 'wipe-table'; disk: number; style: 'GPT' | 'MBR' }
  | { op: 'letter'; disk: number; partition: number; letter: string }
  | { op: 'label'; disk: number; partition: number; label: string }
  | { op: 'check'; disk: number; partition: number; fix: boolean }
  | { op: 'online'; disk: number; online: boolean };

export const DESTRUCTIVE_OPS: ManageOp['op'][] = ['format', 'delete', 'resize', 'split', 'merge', 'wipe-table', 'create', 'initialize'];

/** 사용자가 직접 입력해야 하는 확인 문구 */
export function confirmPhrase(disk: number): string {
  return `DISK ${disk}`;
}

export interface Api {
  appInfo(): Promise<AppInfo>;
  relaunchAsAdmin(): Promise<void>;
  listDisks(): Promise<DiskInfo[]>;
  pickImage(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  pickSaveImage(defaultName: string): Promise<string | null>;
  openPath(path: string): Promise<void>;

  startScan(target: Target, deep: boolean): Promise<string>;
  startOpenVolume(target: Target, volume: FoundVolume, deep: boolean): Promise<string>;
  startCarve(target: Target, types: string[]): Promise<string>;
  carveTypes(): Promise<{ label: string; group: string }[]>;
  listEntries(params: ListParams): Promise<ListResult>;
  closeSession(sessionId: string): Promise<void>;
  startRecover(sessionId: string, ids: number[], destDir: string): Promise<string>;

  startDiagnose(target: Target, deep: boolean): Promise<string>;
  startRepair(target: Target, diagnosisId: string, actionId: string, confirm: string): Promise<string>;
  listJournals(): Promise<JournalInfo[]>;
  startUndo(target: Target, journalId: string, confirm: string): Promise<string>;

  startManage(op: ManageOp, confirm: string): Promise<string>;
  partitionRange(disk: number, partition: number): Promise<{ min: number; max: number }>;
  startFat32Format(disk: number, partition: number, label: string, confirm: string): Promise<string>;

  startImaging(target: Target, dest: string): Promise<string>;
  cancelJob(jobId: string): Promise<void>;

  onProgress(fn: (p: JobProgress) => void): () => void;
  onDone(fn: (d: JobDone) => void): () => void;
}
