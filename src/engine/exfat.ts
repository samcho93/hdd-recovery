import { throwIfAborted, u64, yieldToLoop } from './bytes';
import type { BlockDevice } from './device';
import {
  BaseVolume,
  FLAG_HIDDEN,
  FLAG_SYSTEM,
  ROOT_ID,
  type ChunkSink,
  type FsEntry,
  type ReadResult,
  type ScanOptions,
} from './volume';

export interface ExfatBoot {
  partitionOffset: number;
  volumeLength: number;
  fatOffset: number;
  fatLength: number;
  clusterHeapOffset: number;
  clusterCount: number;
  rootCluster: number;
  serial: number;
  bytesPerSector: number;
  sectorsPerCluster: number;
  clusterSize: number;
  numFats: number;
}

export function parseExfatBoot(b: Buffer): ExfatBoot | null {
  if (b.length < 512 || b.toString('latin1', 3, 11) !== 'EXFAT   ' || b.readUInt16LE(510) !== 0xaa55) return null;
  const sectorShift = b[108];
  const clusterShift = b[109];
  if (sectorShift < 9 || sectorShift > 12 || clusterShift > 25 - sectorShift) return null;
  const bytesPerSector = 1 << sectorShift;
  const sectorsPerCluster = 1 << clusterShift;
  const clusterCount = b.readUInt32LE(92);
  const volumeLength = u64(b, 72);
  if (volumeLength === 0 || clusterCount === 0) return null;
  return {
    partitionOffset: u64(b, 64),
    volumeLength,
    fatOffset: b.readUInt32LE(80),
    fatLength: b.readUInt32LE(84),
    clusterHeapOffset: b.readUInt32LE(88),
    clusterCount,
    rootCluster: b.readUInt32LE(96),
    serial: b.readUInt32LE(100),
    bytesPerSector,
    sectorsPerCluster,
    clusterSize: bytesPerSector * sectorsPerCluster,
    numFats: b[110],
  };
}

/** 부트 영역 체크섬. region은 11개 섹터(0~10번)여야 한다. */
export function exfatBootChecksum(region: Buffer, sectorSize: number): number {
  let sum = 0;
  const len = sectorSize * 11;
  for (let i = 0; i < len; i++) {
    if (i === 106 || i === 107 || i === 112) continue;
    sum = (((sum & 1) << 31) | (sum >>> 1)) >>> 0;
    sum = (sum + region[i]) >>> 0;
  }
  return sum;
}

function exfatTime(v: number): number | null {
  const day = (v >> 16) & 0x1f;
  const month = (v >> 21) & 0x0f;
  const year = ((v >>> 25) & 0x7f) + 1980;
  if (!day || !month || month > 12) return null;
  return new Date(year, month - 1, day, (v >> 11) & 0x1f, (v >> 5) & 0x3f, (v & 0x1f) * 2).getTime();
}

interface ExDirItem {
  name: string;
  isDir: boolean;
  deleted: boolean;
  attrs: number;
  firstCluster: number;
  dataLength: number;
  validLength: number;
  noFatChain: boolean;
  mtime: number | null;
  ctime: number | null;
}

/** 디렉터리 항목 집합(0x85/0xC0/0xC1)을 해석한다. 삭제된 집합(0x05/0x40/0x41)도 포함한다. */
export function parseExfatDirectory(buf: Buffer): ExDirItem[] {
  const out: ExDirItem[] = [];
  for (let p = 0; p + 32 <= buf.length; ) {
    const t = buf[p];
    if (t === 0x00) break; // 이후 미사용
    if (t !== 0x85 && t !== 0x05) {
      p += 32;
      continue;
    }
    const deleted = t === 0x05;
    const count = buf[p + 1];
    if (count < 2 || count > 18 || p + 32 * (count + 1) > buf.length) {
      p += 32;
      continue;
    }
    const s = p + 32;
    const streamType = buf[s];
    if (streamType !== (deleted ? 0x40 : 0xc0)) {
      p += 32;
      continue;
    }
    const nameLen = buf[s + 3];
    let name = '';
    let okNames = true;
    for (let i = 2; i <= count; i++) {
      const q = p + 32 * i;
      const nt = buf[q];
      if (nt === (deleted ? 0x41 : 0xc1)) name += buf.toString('utf16le', q + 2, q + 32);
      else if (i === 2) okNames = false;
    }
    if (!okNames || nameLen === 0) {
      p += 32;
      continue;
    }
    name = name.slice(0, nameLen);
    const attrs = buf.readUInt16LE(p + 4);
    out.push({
      name,
      isDir: (attrs & 0x10) !== 0,
      deleted,
      attrs,
      firstCluster: buf.readUInt32LE(s + 20),
      dataLength: u64(buf, s + 24),
      validLength: u64(buf, s + 8),
      noFatChain: (buf[s + 1] & 0x02) !== 0,
      mtime: exfatTime(buf.readUInt32LE(p + 12)),
      ctime: exfatTime(buf.readUInt32LE(p + 8)),
    });
    p += 32 * (count + 1);
  }
  return out;
}

export class ExfatVolume extends BaseVolume {
  readonly fsType = 'exFAT';
  private fat: Buffer | null = null;
  private nextId = 2;
  private visited = new Set<number>();
  public scannedDirectories = 0;

  constructor(
    private dev: BlockDevice,
    public readonly boot: ExfatBoot,
  ) {
    super();
  }

  static async open(dev: BlockDevice): Promise<ExfatVolume | null> {
    const boot = parseExfatBoot(await dev.read(0, Math.max(512, dev.sectorSize)));
    return boot ? new ExfatVolume(dev, boot) : null;
  }

  private clusterOffset(c: number): number {
    return (this.boot.clusterHeapOffset + (c - 2) * this.boot.sectorsPerCluster) * this.boot.bytesPerSector;
  }

  private valid(c: number): boolean {
    return c >= 2 && c < this.boot.clusterCount + 2;
  }

  private async loadFat(): Promise<Buffer> {
    if (this.fat) return this.fat;
    const b = this.boot;
    this.fat = await this.dev.read(b.fatOffset * b.bytesPerSector, b.fatLength * b.bytesPerSector);
    return this.fat;
  }

  private async clustersFor(
    first: number,
    length: number,
    noFatChain: boolean,
    warnings: string[],
  ): Promise<number[]> {
    const cs = this.boot.clusterSize;
    const need = Math.ceil(length / cs);
    const out: number[] = [];
    if (!this.valid(first)) return out;
    if (noFatChain) {
      for (let i = 0; i < need && this.valid(first + i); i++) out.push(first + i);
      return out;
    }
    const fat = await this.loadFat();
    const seen = new Set<number>();
    let c = first;
    while (out.length < need) {
      if (!this.valid(c) || seen.has(c)) break;
      seen.add(c);
      out.push(c);
      const off = c * 4;
      const next = off + 4 <= fat.length ? fat.readUInt32LE(off) : 0;
      if (next >= 0xfffffff8 || next === 0) break;
      c = next;
    }
    if (out.length < need) {
      warnings.push(`FAT 체인이 끊겨 ${need - out.length}개 클러스터를 연속 영역으로 보충했습니다.`);
      let last = out[out.length - 1];
      while (out.length < need && this.valid(last + 1)) out.push(++last);
    }
    return out;
  }

  private async readClusters(clusters: number[], length: number): Promise<Buffer> {
    const cs = this.boot.clusterSize;
    const parts: Buffer[] = [];
    for (const c of clusters) parts.push(await this.dev.read(this.clusterOffset(c), cs));
    return Buffer.concat(parts).subarray(0, length);
  }

  override async scan(opts: ScanOptions = {}): Promise<void> {
    this.resetEntries();
    this.nextId = 2;
    this.visited.clear();
    this.scannedDirectories = 0;
    const warnings: string[] = [];
    const fat = await this.loadFat();

    // 루트 디렉터리는 FAT 체인으로만 연결된다.
    const rootClusters: number[] = [];
    const seen = new Set<number>();
    let c = this.boot.rootCluster;
    while (this.valid(c) && !seen.has(c)) {
      seen.add(c);
      rootClusters.push(c);
      const next = c * 4 + 4 <= fat.length ? fat.readUInt32LE(c * 4) : 0;
      if (next >= 0xfffffff8 || next === 0) break;
      c = next;
    }
    const queue: { parentId: number; data?: Buffer; first?: number; len?: number; noFat?: boolean; deleted?: boolean }[] = [
      { parentId: ROOT_ID, data: await this.readClusters(rootClusters, rootClusters.length * this.boot.clusterSize) },
    ];
    let wipedDeletedDirs = 0;

    while (queue.length) {
      throwIfAborted(opts.signal);
      const item = queue.pop()!;
      let data = item.data;
      if (!data) {
        const clusters = await this.clustersFor(item.first!, item.len!, item.noFat!, warnings);
        data = await this.readClusters(clusters, item.len!);
      }
      this.scannedDirectories++;
      if (item.deleted && !data.some((x) => x !== 0)) wipedDeletedDirs++;
      for (const de of parseExfatDirectory(data)) {
        const id = this.nextId++;
        let flags = 0;
        if (de.attrs & 2) flags |= FLAG_HIDDEN;
        if (de.attrs & 4) flags |= FLAG_SYSTEM;
        const entry: FsEntry = {
          id,
          parentId: item.parentId,
          name: de.name,
          isDir: de.isDir,
          size: de.isDir ? 0 : de.dataLength,
          deleted: de.deleted,
          mtime: de.mtime,
          ctime: de.ctime,
          flags,
          ref: [de.firstCluster, de.noFatChain ? 1 : 0, de.validLength],
        };
        this.addEntry(entry);
        if (de.isDir && this.valid(de.firstCluster) && de.dataLength > 0 && !this.visited.has(de.firstCluster)) {
          this.visited.add(de.firstCluster);
          queue.push({ parentId: id, first: de.firstCluster, len: de.dataLength, noFat: de.noFatChain, deleted: de.deleted });
        }
      }
      opts.onProgress?.({
        done: this.scannedDirectories,
        total: this.scannedDirectories + queue.length,
        message: `폴더 ${this.scannedDirectories.toLocaleString()}개 탐색`,
      });
      await yieldToLoop();
    }
    this.warnings.push(...new Set(warnings));
    if (wipedDeletedDirs) {
      this.warnings.push(
        `삭제된 폴더 ${wipedDeletedDirs}개의 목록이 0으로 지워져 있습니다(Windows의 exFAT 삭제 동작). 그 안의 파일은 서명 스캔으로 찾으세요.`,
      );
    }
  }

  override async readEntry(entry: FsEntry, sink: ChunkSink, signal?: AbortSignal): Promise<ReadResult> {
    const warnings: string[] = [];
    const size = entry.size;
    if (size === 0) return { bytes: 0, warnings };
    const [first, noFat, validLen] = entry.ref;
    if (!this.valid(first)) {
      warnings.push('시작 클러스터가 유효하지 않습니다.');
      return { bytes: 0, warnings };
    }
    const cs = this.boot.clusterSize;
    const clusters = await this.clustersFor(first, size, noFat === 1, warnings);
    if (entry.deleted) warnings.push('삭제된 파일입니다. 공간이 재사용되었다면 내용이 다를 수 있습니다.');
    let written = 0;
    let idx = 0;
    while (idx < clusters.length && written < size) {
      throwIfAborted(signal);
      let n = 1;
      while (idx + n < clusters.length && clusters[idx + n] === clusters[idx] + n && n * cs < 4 * 1024 * 1024) n++;
      const take = Math.min(n * cs, size - written);
      const chunk = await this.dev.read(this.clusterOffset(clusters[idx]), take);
      if (written + take > validLen) chunk.fill(0, Math.max(0, validLen - written));
      await sink(chunk);
      written += take;
      idx += n;
    }
    return { bytes: written, warnings };
  }
}
