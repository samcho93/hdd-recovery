import type { ProgressFn } from './bytes';

export const ROOT_ID = 0;
/** 부모를 찾을 수 없는 항목을 모아 두는 가상 폴더 */
export const ORPHAN_ID = 1;

export const FLAG_COMPRESSED = 1;
export const FLAG_ENCRYPTED = 2;
export const FLAG_SPARSE = 4;
export const FLAG_HIDDEN = 8;
export const FLAG_SYSTEM = 16;

export interface FsEntry {
  id: number;
  parentId: number;
  name: string;
  isDir: boolean;
  size: number;
  deleted: boolean;
  mtime: number | null;
  ctime: number | null;
  flags: number;
  /** 파일시스템별 위치 정보(NTFS: MFT 레코드 오프셋들, FAT/exFAT: 첫 클러스터 등) */
  ref: number[];
}

export interface ScanOptions {
  /** 손상된 메타데이터를 넘어 볼륨 전체를 뒤지는 정밀 스캔 */
  deep?: boolean;
  signal?: AbortSignal;
  onProgress?: ProgressFn;
}

export interface ReadResult {
  bytes: number;
  warnings: string[];
}

export type ChunkSink = (chunk: Buffer) => Promise<void>;

export interface RecoveryVolume {
  readonly fsType: string;
  readonly entries: Map<number, FsEntry>;
  readonly warnings: string[];
  scan(opts?: ScanOptions): Promise<void>;
  readEntry(entry: FsEntry, sink: ChunkSink, signal?: AbortSignal): Promise<ReadResult>;
  childrenOf(id: number): FsEntry[];
  pathOf(id: number): string;
}

export abstract class BaseVolume implements RecoveryVolume {
  abstract readonly fsType: string;
  readonly entries = new Map<number, FsEntry>();
  readonly warnings: string[] = [];
  private children = new Map<number, number[]>();

  constructor() {
    this.resetEntries();
  }

  protected resetEntries(): void {
    this.entries.clear();
    this.children.clear();
    this.entries.set(ROOT_ID, makeDir(ROOT_ID, ROOT_ID, ''));
  }

  protected addEntry(e: FsEntry): void {
    this.entries.set(e.id, e);
    const list = this.children.get(e.parentId);
    if (list) list.push(e.id);
    else this.children.set(e.parentId, [e.id]);
  }

  protected ensureOrphanDir(): void {
    if (!this.entries.has(ORPHAN_ID)) {
      this.addEntry(makeDir(ORPHAN_ID, ROOT_ID, '$경로를 잃은 파일'));
    }
  }

  abstract scan(opts?: ScanOptions): Promise<void>;
  abstract readEntry(entry: FsEntry, sink: ChunkSink, signal?: AbortSignal): Promise<ReadResult>;

  childrenOf(id: number): FsEntry[] {
    const ids = this.children.get(id) ?? [];
    const out: FsEntry[] = [];
    for (const c of ids) {
      const e = this.entries.get(c);
      if (e) out.push(e);
    }
    return out;
  }

  pathOf(id: number): string {
    const parts: string[] = [];
    let cur = this.entries.get(id);
    let guard = 0;
    while (cur && cur.id !== ROOT_ID && guard++ < 4096) {
      parts.unshift(cur.name);
      cur = this.entries.get(cur.parentId);
    }
    return parts.join('\\');
  }
}

export function makeDir(id: number, parentId: number, name: string): FsEntry {
  return { id, parentId, name, isDir: true, size: 0, deleted: false, mtime: null, ctime: null, flags: 0, ref: [] };
}
