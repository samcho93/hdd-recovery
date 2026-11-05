import { dosTimeToMs, throwIfAborted, yieldToLoop } from './bytes';
import type { BlockDevice } from './device';
import {
  BaseVolume,
  FLAG_HIDDEN,
  FLAG_SYSTEM,
  ORPHAN_ID,
  ROOT_ID,
  type ChunkSink,
  type FsEntry,
  type ReadResult,
  type ScanOptions,
} from './volume';

export interface FatBoot {
  type: 'FAT12' | 'FAT16' | 'FAT32';
  bytesPerSector: number;
  sectorsPerCluster: number;
  clusterSize: number;
  reservedSectors: number;
  numFats: number;
  rootEntries: number;
  totalSectors: number;
  fatSectors: number;
  rootCluster: number;
  fsInfoSector: number;
  backupBootSector: number;
  media: number;
  firstDataSector: number;
  clusterCount: number;
  label: string;
}

/** FAT 계열 BPB를 해석한다. 유효하지 않으면 null. */
export function parseFatBoot(b: Buffer): FatBoot | null {
  if (b.length < 512 || b.readUInt16LE(510) !== 0xaa55) return null;
  if (b[0] !== 0xeb && b[0] !== 0xe9) return null;
  const bytesPerSector = b.readUInt16LE(11);
  if (![512, 1024, 2048, 4096].includes(bytesPerSector)) return null;
  const sectorsPerCluster = b[13];
  if (sectorsPerCluster === 0 || (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0) return null;
  const reservedSectors = b.readUInt16LE(14);
  const numFats = b[16];
  const rootEntries = b.readUInt16LE(17);
  const media = b[21];
  if (reservedSectors === 0 || numFats === 0 || numFats > 4 || media < 0xf0) return null;
  const total16 = b.readUInt16LE(19);
  const fat16 = b.readUInt16LE(22);
  const totalSectors = total16 || b.readUInt32LE(32);
  const fatSectors = fat16 || b.readUInt32LE(36);
  if (totalSectors === 0 || fatSectors === 0) return null;
  const rootDirSectors = Math.ceil((rootEntries * 32) / bytesPerSector);
  const firstDataSector = reservedSectors + numFats * fatSectors + rootDirSectors;
  if (firstDataSector >= totalSectors) return null;
  const clusterCount = Math.floor((totalSectors - firstDataSector) / sectorsPerCluster);
  const type = clusterCount < 4085 ? 'FAT12' : clusterCount < 65525 ? 'FAT16' : 'FAT32';
  if (type === 'FAT32' && (fat16 !== 0 || rootEntries !== 0)) return null;
  if (type !== 'FAT32' && rootEntries === 0) return null;
  const labelOff = type === 'FAT32' ? 71 : 43;
  return {
    type,
    bytesPerSector,
    sectorsPerCluster,
    clusterSize: bytesPerSector * sectorsPerCluster,
    reservedSectors,
    numFats,
    rootEntries,
    totalSectors,
    fatSectors,
    rootCluster: type === 'FAT32' ? b.readUInt32LE(44) : 0,
    fsInfoSector: type === 'FAT32' ? b.readUInt16LE(48) : 0,
    backupBootSector: type === 'FAT32' ? b.readUInt16LE(50) : 0,
    media,
    firstDataSector,
    clusterCount,
    label: b.toString('latin1', labelOff, labelOff + 11).trim(),
  };
}

function decodeShortName(raw: Buffer, off: number, ntCase: number, deleted: boolean): string {
  const nameBytes = Buffer.from(raw.subarray(off, off + 8));
  const extBytes = raw.subarray(off + 8, off + 11);
  if (nameBytes[0] === 0x05) nameBytes[0] = 0xe5;
  if (deleted) nameBytes[0] = 0x5f; // 삭제 시 첫 글자는 사라진다: '_'로 대체
  const dec = new TextDecoder('euc-kr');
  let name = dec.decode(nameBytes).trimEnd();
  let ext = dec.decode(extBytes).trimEnd();
  if (ntCase & 0x08) name = name.toLowerCase();
  if (ntCase & 0x10) ext = ext.toLowerCase();
  return ext ? `${name}.${ext}` : name;
}

export function lfnChecksum(raw: Buffer, off: number): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) + (sum >> 1) + raw[off + i]) & 0xff;
  return sum;
}

function plausibleShortEntry(b: Buffer, p: number): boolean {
  const attr = b[p + 11];
  if (attr & 0xc0) return false;
  for (let i = 1; i < 11; i++) {
    const c = b[p + i];
    if (c < 0x20 || c === 0x22 || c === 0x2a || c === 0x2f || c === 0x3a || c === 0x3c || c === 0x3e || c === 0x3f || c === 0x7c) {
      return false;
    }
  }
  return true;
}

export interface FatDirEntry {
  name: string;
  isDir: boolean;
  deleted: boolean;
  firstCluster: number;
  size: number;
  mtime: number | null;
  ctime: number | null;
  attr: number;
}

/** 디렉터리 버퍼에서 항목을 뽑아낸다. 삭제된 항목도 포함한다. */
export function parseFatDirectory(buf: Buffer): FatDirEntry[] {
  const out: FatDirEntry[] = [];
  let lfnParts: string[] = [];
  let lfnSum = -1;
  for (let p = 0; p + 32 <= buf.length; p += 32) {
    const first = buf[p];
    if (first === 0x00) break;
    const attr = buf[p + 11];
    if ((attr & 0x3f) === 0x0f) {
      const part =
        buf.toString('utf16le', p + 1, p + 11) + buf.toString('utf16le', p + 14, p + 26) + buf.toString('utf16le', p + 28, p + 32);
      const sum = buf[p + 13];
      if (first !== 0xe5 && first & 0x40) lfnParts = [];
      if (lfnSum !== -1 && sum !== lfnSum && lfnParts.length) lfnParts = [];
      lfnSum = sum;
      lfnParts.unshift(part);
      continue;
    }
    const deleted = first === 0xe5;
    const lfn = lfnParts;
    const sum = lfnSum;
    lfnParts = [];
    lfnSum = -1;
    if (attr & 0x08) continue; // 볼륨 레이블
    if (!plausibleShortEntry(buf, p)) continue;
    if (first === 0x2e) continue; // . 과 ..
    const short = decodeShortName(buf, p, buf[p + 12], deleted);
    let name = short;
    if (lfn.length && (deleted || sum === lfnChecksum(buf, p))) {
      const joined = lfn.join('');
      const end = joined.indexOf('\0');
      name = end >= 0 ? joined.slice(0, end) : joined;
      name = name.replace(/￿+$/, '');
    }
    if (!name) continue;
    out.push({
      name,
      isDir: (attr & 0x10) !== 0,
      deleted,
      firstCluster: buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 20) * 0x10000,
      size: buf.readUInt32LE(p + 28),
      mtime: dosTimeToMs(buf.readUInt16LE(p + 24), buf.readUInt16LE(p + 22)),
      ctime: dosTimeToMs(buf.readUInt16LE(p + 16), buf.readUInt16LE(p + 14)),
      attr,
    });
  }
  return out;
}

export class FatVolume extends BaseVolume {
  readonly fsType: string;
  private fat: Buffer | null = null;
  private nextId = 2;
  private visitedDirClusters = new Set<number>();
  public scannedDirectories = 0;

  constructor(
    private dev: BlockDevice,
    public readonly boot: FatBoot,
  ) {
    super();
    this.fsType = boot.type;
  }

  static async open(dev: BlockDevice): Promise<FatVolume | null> {
    const boot = parseFatBoot(await dev.read(0, Math.max(512, dev.sectorSize)));
    return boot ? new FatVolume(dev, boot) : null;
  }

  private clusterOffset(c: number): number {
    return (this.boot.firstDataSector + (c - 2) * this.boot.sectorsPerCluster) * this.boot.bytesPerSector;
  }

  private validCluster(c: number): boolean {
    return c >= 2 && c < this.boot.clusterCount + 2;
  }

  /** 두 FAT 사본 중 쓸 만한 쪽을 메모리에 올린다. */
  private async loadFat(): Promise<Buffer> {
    if (this.fat) return this.fat;
    const b = this.boot;
    const len = b.fatSectors * b.bytesPerSector;
    let chosen: Buffer | null = null;
    for (let i = 0; i < b.numFats; i++) {
      const copy = await this.dev.read((b.reservedSectors + i * b.fatSectors) * b.bytesPerSector, len);
      if (copy[0] === b.media && copy[1] === 0xff) {
        if (i > 0 && !chosen) this.warnings.push(`FAT 1번 사본이 손상되어 ${i + 1}번 사본을 사용합니다.`);
        chosen = copy;
        break;
      }
      chosen = chosen ?? null;
    }
    if (!chosen) {
      this.warnings.push('유효한 FAT 사본이 없습니다. 파일을 연속 클러스터로 가정합니다.');
      chosen = Buffer.alloc(len);
    }
    this.fat = chosen;
    return chosen;
  }

  private fatEntry(fat: Buffer, c: number): number {
    switch (this.boot.type) {
      case 'FAT32':
        return c * 4 + 4 <= fat.length ? fat.readUInt32LE(c * 4) & 0x0fffffff : 0;
      case 'FAT16':
        return c * 2 + 2 <= fat.length ? fat.readUInt16LE(c * 2) : 0;
      default: {
        const off = c + (c >> 1);
        if (off + 2 > fat.length) return 0;
        const v = fat.readUInt16LE(off);
        return c & 1 ? v >> 4 : v & 0x0fff;
      }
    }
  }

  private isEnd(v: number): boolean {
    const t = this.boot.type;
    return t === 'FAT32' ? v >= 0x0ffffff8 : t === 'FAT16' ? v >= 0xfff8 : v >= 0xff8;
  }

  private chain(fat: Buffer, first: number, maxClusters: number): { clusters: number[]; broken: boolean } {
    const clusters: number[] = [];
    const seen = new Set<number>();
    let c = first;
    while (clusters.length < maxClusters) {
      if (!this.validCluster(c) || seen.has(c)) return { clusters, broken: true };
      seen.add(c);
      clusters.push(c);
      const next = this.fatEntry(fat, c);
      if (this.isEnd(next)) return { clusters, broken: false };
      if (next === 0) return { clusters, broken: true };
      c = next;
    }
    return { clusters, broken: false };
  }

  private async readDirectoryData(first: number, deleted: boolean): Promise<Buffer> {
    const cs = this.boot.clusterSize;
    if (deleted) {
      // 삭제된 폴더는 FAT 체인이 없다. 첫 클러스터가 디렉터리인지 확인하고 연속 영역을 읽는다.
      if (!this.validCluster(first)) return Buffer.alloc(0);
      const parts: Buffer[] = [];
      for (let i = 0; i < 256; i++) {
        const c = first + i;
        if (!this.validCluster(c)) break;
        const data = await this.dev.read(this.clusterOffset(c), cs);
        if (i === 0 && data[0] !== 0x2e && data[0] !== 0xe5) return data[0] === 0 ? data : Buffer.alloc(cs, 0xff);
        parts.push(data);
        let ended = false;
        for (let p = 0; p + 32 <= data.length; p += 32) {
          if (data[p] === 0) {
            ended = true;
            break;
          }
        }
        if (ended) break;
      }
      return Buffer.concat(parts);
    }
    const fat = await this.loadFat();
    const { clusters } = this.chain(fat, first, 65536);
    const parts: Buffer[] = [];
    for (const c of clusters) parts.push(await this.dev.read(this.clusterOffset(c), cs));
    return Buffer.concat(parts);
  }

  override async scan(opts: ScanOptions = {}): Promise<void> {
    this.resetEntries();
    this.nextId = 2;
    this.visitedDirClusters.clear();
    this.scannedDirectories = 0;
    const b = this.boot;
    await this.loadFat();

    const queue: { parentId: number; cluster: number; deleted: boolean; rootFixed?: boolean }[] = [
      b.type === 'FAT32'
        ? { parentId: ROOT_ID, cluster: b.rootCluster, deleted: false }
        : { parentId: ROOT_ID, cluster: 0, deleted: false, rootFixed: true },
    ];

    let wipedDeletedDirs = 0;
    const drain = async (): Promise<void> => {
      while (queue.length) {
        throwIfAborted(opts.signal);
        const item = queue.pop()!;
        let data: Buffer;
        if (item.rootFixed) {
          const off = (b.reservedSectors + b.numFats * b.fatSectors) * b.bytesPerSector;
          data = await this.dev.read(off, b.rootEntries * 32);
        } else {
          if (this.visitedDirClusters.has(item.cluster)) continue;
          this.visitedDirClusters.add(item.cluster);
          data = await this.readDirectoryData(item.cluster, item.deleted);
        }
        this.scannedDirectories++;
        if (item.deleted && !data.some((x) => x !== 0)) wipedDeletedDirs++;
        for (const de of parseFatDirectory(data)) {
          const id = this.nextId++;
          this.addEntry(this.toEntry(id, item.parentId, de));
          if (de.isDir && this.validCluster(de.firstCluster)) {
            queue.push({ parentId: id, cluster: de.firstCluster, deleted: de.deleted });
          }
        }
        opts.onProgress?.({
          done: this.scannedDirectories,
          total: this.scannedDirectories + queue.length,
          message: `폴더 ${this.scannedDirectories.toLocaleString()}개 탐색`,
        });
        await yieldToLoop();
      }
    };
    await drain();
    if (opts.deep) await this.scanOrphanDirectories(opts, queue, drain);
    if (wipedDeletedDirs) {
      this.warnings.push(
        `삭제된 폴더 ${wipedDeletedDirs}개의 목록이 0으로 지워져 있습니다(Windows의 FAT 삭제 동작). 그 안의 파일은 서명 스캔으로 찾으세요.`,
      );
    }
  }

  /** 루트에서 닿지 않는 폴더를 데이터 영역 전체에서 찾는다('.'/'..' 항목으로 식별). */
  private async scanOrphanDirectories(
    opts: ScanOptions,
    queue: { parentId: number; cluster: number; deleted: boolean }[],
    drain: () => Promise<void>,
  ): Promise<void> {
    const b = this.boot;
    const cs = b.clusterSize;
    const batchClusters = Math.max(1, Math.floor((4 * 1024 * 1024) / cs));
    const found: number[] = [];
    for (let c = 2; c < b.clusterCount + 2; c += batchClusters) {
      throwIfAborted(opts.signal);
      const n = Math.min(batchClusters, b.clusterCount + 2 - c);
      const buf = await this.dev.read(this.clusterOffset(c), n * cs);
      for (let i = 0; i < n; i++) {
        const p = i * cs;
        if (buf.toString('latin1', p, p + 11) !== '.          ') continue;
        if (!(buf[p + 11] & 0x10)) continue;
        if (buf.toString('latin1', p + 32, p + 43) !== '..         ') continue;
        const self = buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 20) * 0x10000;
        if (self === c + i && !this.visitedDirClusters.has(self)) found.push(self);
      }
      opts.onProgress?.({ done: c - 2 + n, total: b.clusterCount, message: '데이터 영역에서 잃어버린 폴더 탐색' });
      await yieldToLoop();
    }
    if (!found.length) return;
    this.ensureOrphanDir();
    for (const c of found) {
      if (this.visitedDirClusters.has(c)) continue;
      const id = this.nextId++;
      this.addEntry({
        id,
        parentId: ORPHAN_ID,
        name: `폴더_${c}`,
        isDir: true,
        size: 0,
        deleted: false,
        mtime: null,
        ctime: null,
        flags: 0,
        ref: [c],
      });
      queue.push({ parentId: id, cluster: c, deleted: false });
      await drain();
    }
    this.warnings.push(`루트에서 연결되지 않은 폴더 ${found.length}개를 찾았습니다.`);
  }

  private toEntry(id: number, parentId: number, de: FatDirEntry): FsEntry {
    let flags = 0;
    if (de.attr & 2) flags |= FLAG_HIDDEN;
    if (de.attr & 4) flags |= FLAG_SYSTEM;
    return {
      id,
      parentId,
      name: de.name,
      isDir: de.isDir,
      size: de.isDir ? 0 : de.size,
      deleted: de.deleted,
      mtime: de.mtime,
      ctime: de.ctime,
      flags,
      ref: [de.firstCluster],
    };
  }

  override async readEntry(entry: FsEntry, sink: ChunkSink, signal?: AbortSignal): Promise<ReadResult> {
    const warnings: string[] = [];
    const size = entry.size;
    if (size === 0) return { bytes: 0, warnings };
    const cs = this.boot.clusterSize;
    const first = entry.ref[0];
    const needed = Math.ceil(size / cs);
    const fat = await this.loadFat();
    let clusters: number[];
    if (!this.validCluster(first)) {
      warnings.push('시작 클러스터가 유효하지 않아 내용을 복구할 수 없습니다.');
      return { bytes: 0, warnings };
    }
    if (entry.deleted) {
      // 삭제 시 FAT 체인이 지워진다: 연속 할당으로 가정한다.
      clusters = [];
      let reused = 0;
      for (let i = 0; i < needed && this.validCluster(first + i); i++) {
        clusters.push(first + i);
        if (this.fatEntry(fat, first + i) !== 0) reused++;
      }
      if (reused) warnings.push(`클러스터 ${reused}개가 재사용되어 내용이 덮어써졌을 수 있습니다.`);
      if (needed > 1) warnings.push('삭제 파일은 연속 저장을 가정해 복구했습니다. 조각난 파일이면 내용이 깨질 수 있습니다.');
    } else {
      const res = this.chain(fat, first, needed);
      clusters = res.clusters;
      if (clusters.length < needed) {
        warnings.push(`FAT 체인이 끊겨 ${needed - clusters.length}개 클러스터를 연속 영역으로 보충했습니다.`);
        const last = clusters[clusters.length - 1] ?? first - 1;
        for (let i = 1; clusters.length < needed && this.validCluster(last + i); i++) clusters.push(last + i);
      }
    }
    let written = 0;
    let idx = 0;
    while (idx < clusters.length && written < size) {
      throwIfAborted(signal);
      let n = 1;
      while (idx + n < clusters.length && clusters[idx + n] === clusters[idx] + n && n * cs < 4 * 1024 * 1024) n++;
      const take = Math.min(n * cs, size - written);
      const chunk = await this.dev.read(this.clusterOffset(clusters[idx]), take);
      await sink(chunk);
      written += take;
      idx += n;
    }
    if (written < size) {
      warnings.push(`볼륨 범위를 벗어나 ${size - written} 바이트를 복구하지 못했습니다.`);
    }
    return { bytes: written, warnings };
  }
}
