import { filetimeToMs, throwIfAborted, u64, writeU64, yieldToLoop } from './bytes';
import type { BlockDevice } from './device';
import {
  BaseVolume,
  FLAG_COMPRESSED,
  FLAG_ENCRYPTED,
  FLAG_HIDDEN,
  FLAG_SPARSE,
  FLAG_SYSTEM,
  ORPHAN_ID,
  ROOT_ID,
  type ChunkSink,
  type FsEntry,
  type ReadResult,
  type ScanOptions,
} from './volume';

export interface NtfsBoot {
  bytesPerSector: number;
  sectorsPerCluster: number;
  clusterSize: number;
  totalSectors: number;
  mftLcn: number;
  mftMirrLcn: number;
  mftRecordSize: number;
  indexRecordSize: number;
  serial: bigint;
}

function decodeRecordSize(raw: number, clusterSize: number): number {
  const v = raw > 127 ? raw - 256 : raw;
  return v < 0 ? 2 ** -v : v * clusterSize;
}

/** NTFS 부트 섹터를 해석한다. 값이 비정상이면 null. */
export function parseNtfsBoot(b: Buffer): NtfsBoot | null {
  if (b.length < 512 || b.toString('latin1', 3, 11) !== 'NTFS    ') return null;
  if (b.readUInt16LE(510) !== 0xaa55) return null;
  const bytesPerSector = b.readUInt16LE(11);
  if (![512, 1024, 2048, 4096].includes(bytesPerSector)) return null;
  const rawSpc = b[13];
  const sectorsPerCluster = rawSpc > 0x80 ? 2 ** (256 - rawSpc) : rawSpc;
  if (sectorsPerCluster === 0 || (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0) return null;
  const clusterSize = bytesPerSector * sectorsPerCluster;
  const totalSectors = u64(b, 40);
  const mftLcn = u64(b, 48);
  const mftMirrLcn = u64(b, 56);
  const mftRecordSize = decodeRecordSize(b[64], clusterSize);
  const indexRecordSize = decodeRecordSize(b[68], clusterSize);
  if (totalSectors === 0 || mftLcn === 0) return null;
  if (mftRecordSize < 256 || mftRecordSize > 65536) return null;
  if (mftLcn * sectorsPerCluster > totalSectors) return null;
  return {
    bytesPerSector,
    sectorsPerCluster,
    clusterSize,
    totalSectors,
    mftLcn,
    mftMirrLcn,
    mftRecordSize,
    indexRecordSize,
    serial: b.readBigUInt64LE(72),
  };
}

function encodeRecordSize(size: number, clusterSize: number): number {
  if (size >= clusterSize) return size / clusterSize;
  return (256 - Math.log2(size)) & 0xff;
}

/** MFT에서 알아낸 값으로 NTFS 부트 섹터를 다시 만든다(부트 코드는 없으므로 데이터 디스크용). */
export function synthesizeNtfsBoot(o: {
  bytesPerSector: number;
  clusterSize: number;
  totalSectors: number;
  mftLcn: number;
  mftMirrLcn: number;
  mftRecordSize: number;
  hiddenSectors: number;
  serial?: bigint;
}): Buffer {
  const b = Buffer.alloc(o.bytesPerSector);
  b[0] = 0xeb;
  b[1] = 0x52;
  b[2] = 0x90;
  b.write('NTFS    ', 3, 'latin1');
  b.writeUInt16LE(o.bytesPerSector, 11);
  const spc = o.clusterSize / o.bytesPerSector;
  b[13] = spc <= 128 ? spc : (256 - Math.log2(spc)) & 0xff;
  b[21] = 0xf8;
  b.writeUInt16LE(63, 24);
  b.writeUInt16LE(255, 26);
  b.writeUInt32LE(Math.min(o.hiddenSectors, 0xffffffff), 28);
  b.writeUInt32LE(0x00800080, 36);
  writeU64(b, 40, o.totalSectors);
  writeU64(b, 48, o.mftLcn);
  writeU64(b, 56, o.mftMirrLcn);
  b.writeUInt32LE(encodeRecordSize(o.mftRecordSize, o.clusterSize), 64);
  b.writeUInt32LE(encodeRecordSize(4096, o.clusterSize), 68);
  b.writeBigUInt64LE(BigInt.asUintN(64, o.serial ?? BigInt(Date.now()) * 0x1234567n), 72);
  b.writeUInt16LE(0xaa55, 510);
  return b;
}

/** USA(업데이트 시퀀스) 복원. 일치하지 않는 섹터가 있으면 false를 돌려주지만 가능한 범위는 복원한다. */
export function applyFixups(rec: Buffer): boolean {
  const usaOff = rec.readUInt16LE(4);
  const usaCount = rec.readUInt16LE(6);
  if (usaCount === 0 || usaOff + usaCount * 2 > rec.length) return false;
  const usn = rec.readUInt16LE(usaOff);
  let ok = true;
  for (let i = 1; i < usaCount; i++) {
    const end = i * 512 - 2;
    if (end + 2 > rec.length) break;
    if (rec.readUInt16LE(end) !== usn) ok = false;
    rec.writeUInt16LE(rec.readUInt16LE(usaOff + i * 2), end);
  }
  return ok;
}

export interface Run {
  /** null이면 희소(sparse) 구간 */
  lcn: number | null;
  length: number;
}

export function decodeRuns(buf: Buffer, start: number, limit: number): Run[] {
  const runs: Run[] = [];
  let p = start;
  let lcn = 0;
  while (p < limit && buf[p] !== 0) {
    const hdr = buf[p++];
    const lenBytes = hdr & 0x0f;
    const offBytes = hdr >> 4;
    if (lenBytes === 0 || lenBytes > 8 || offBytes > 8 || p + lenBytes + offBytes > limit) break;
    let length = 0;
    for (let i = lenBytes - 1; i >= 0; i--) length = length * 256 + buf[p + i];
    p += lenBytes;
    if (offBytes === 0) {
      runs.push({ lcn: null, length });
    } else {
      let delta = 0;
      for (let i = offBytes - 1; i >= 0; i--) delta = delta * 256 + buf[p + i];
      if (buf[p + offBytes - 1] & 0x80) delta -= 2 ** (8 * offBytes);
      p += offBytes;
      lcn += delta;
      runs.push({ lcn, length });
    }
  }
  return runs;
}

export interface NtfsAttr {
  type: number;
  name: string;
  nonResident: boolean;
  flags: number;
  id: number;
  /** resident */
  value?: Buffer;
  /** non-resident */
  startVcn?: number;
  lastVcn?: number;
  compressionUnit?: number;
  allocSize?: number;
  realSize?: number;
  initSize?: number;
  runs?: Run[];
}

const ATTR_STANDARD = 0x10;
const ATTR_LIST = 0x20;
const ATTR_FILE_NAME = 0x30;
const ATTR_DATA = 0x80;

/** MFT 레코드의 속성을 순회한다. fixup이 끝난 버퍼를 넘겨야 한다. */
export function parseAttributes(rec: Buffer): NtfsAttr[] {
  const attrs: NtfsAttr[] = [];
  let p = rec.readUInt16LE(20);
  const limit = Math.min(rec.readUInt32LE(24) || rec.length, rec.length);
  let guard = 0;
  while (p + 16 <= limit && guard++ < 512) {
    const type = rec.readUInt32LE(p);
    if (type === 0xffffffff) break;
    const len = rec.readUInt32LE(p + 4);
    if (len < 16 || len % 8 !== 0 || p + len > rec.length) break;
    const nonRes = rec[p + 8] !== 0;
    const nameLen = rec[p + 9];
    const nameOff = rec.readUInt16LE(p + 10);
    const name = nameLen ? rec.toString('utf16le', p + nameOff, p + nameOff + nameLen * 2) : '';
    const a: NtfsAttr = { type, name, nonResident: nonRes, flags: rec.readUInt16LE(p + 12), id: rec.readUInt16LE(p + 14) };
    if (!nonRes) {
      const vLen = rec.readUInt32LE(p + 16);
      const vOff = rec.readUInt16LE(p + 20);
      if (p + vOff + vLen <= rec.length) a.value = rec.subarray(p + vOff, p + vOff + vLen);
    } else if (len >= 64) {
      a.startVcn = u64(rec, p + 16);
      a.lastVcn = u64(rec, p + 24);
      const runOff = rec.readUInt16LE(p + 32);
      a.compressionUnit = rec.readUInt16LE(p + 34);
      a.allocSize = u64(rec, p + 40);
      a.realSize = u64(rec, p + 48);
      a.initSize = u64(rec, p + 56);
      a.runs = decodeRuns(rec, p + runOff, p + len);
    }
    attrs.push(a);
    p += len;
  }
  return attrs;
}

export interface FileNameAttr {
  parentRecord: number;
  parentSeq: number;
  name: string;
  namespace: number;
  ctime: number | null;
  mtime: number | null;
  realSize: number;
  flags: number;
}

export function parseFileName(v: Buffer): FileNameAttr | null {
  if (v.length < 66) return null;
  const nameLen = v[64];
  if (66 + nameLen * 2 > v.length) return null;
  return {
    parentRecord: v.readUIntLE(0, 6),
    parentSeq: v.readUInt16LE(6),
    ctime: filetimeToMs(v, 8),
    mtime: filetimeToMs(v, 16),
    realSize: u64(v, 48),
    flags: v.readUInt32LE(56),
    namespace: v[65],
    name: v.toString('utf16le', 66, 66 + nameLen * 2),
  };
}

/** LZNT1 압축 해제 */
export function lznt1Decompress(src: Buffer, outSize: number): Buffer {
  const out = Buffer.alloc(outSize);
  let sp = 0;
  let dp = 0;
  while (sp + 2 <= src.length && dp < outSize) {
    const hdr = src.readUInt16LE(sp);
    if (hdr === 0) break;
    sp += 2;
    const chunkSize = (hdr & 0x0fff) + 1;
    const chunkEnd = Math.min(sp + chunkSize, src.length);
    if (!(hdr & 0x8000)) {
      const n = Math.min(chunkEnd - sp, outSize - dp);
      src.copy(out, dp, sp, sp + n);
      dp += n;
      sp = chunkEnd;
      continue;
    }
    const chunkStart = dp;
    while (sp < chunkEnd && dp < outSize) {
      const tags = src[sp++];
      for (let bit = 0; bit < 8 && sp < chunkEnd && dp < outSize; bit++) {
        if (!(tags & (1 << bit))) {
          out[dp++] = src[sp++];
          continue;
        }
        if (sp + 2 > chunkEnd) {
          sp = chunkEnd;
          break;
        }
        const token = src.readUInt16LE(sp);
        sp += 2;
        const pos = dp - chunkStart;
        let dispBits = 4;
        while (1 << dispBits < pos) dispBits++;
        const lenMask = (1 << (16 - dispBits)) - 1;
        const length = (token & lenMask) + 3;
        const disp = (token >> (16 - dispBits)) + 1;
        let from = dp - disp;
        if (from < chunkStart) {
          sp = chunkEnd;
          break;
        }
        for (let i = 0; i < length && dp < outSize; i++) out[dp++] = out[from++];
      }
    }
    sp = chunkEnd;
  }
  return out;
}

export interface MftDiscovery {
  mftOffset: number;
  volumeOffset: number;
  clusterSize: number;
  recordSize: number;
  mftLcn: number;
  mirrLcn: number;
  totalSectors: number;
}

/** 파일시스템 쪽 정보 없이 $MFT 레코드(0번) 하나만으로 볼륨 구조를 역산한다. */
export async function discoverFromMftRecord(
  dev: BlockDevice,
  recordOffset: number,
): Promise<MftDiscovery | null> {
  const probe = await dev.read(recordOffset, 4096);
  if (probe.toString('latin1', 0, 4) !== 'FILE') return null;
  const recordSize = probe.readUInt32LE(28);
  if (recordSize < 256 || recordSize > 65536 || recordSize % 256 !== 0) return null;
  if (probe.readUInt32LE(44) !== 0) return null;
  const rec0 = Buffer.from(probe.subarray(0, recordSize));
  applyFixups(rec0);
  let attrs: NtfsAttr[];
  try {
    attrs = parseAttributes(rec0);
  } catch {
    return null;
  }
  const fnAttr = attrs.find((a) => a.type === ATTR_FILE_NAME && a.value);
  const fn = fnAttr?.value ? parseFileName(fnAttr.value) : null;
  if (!fn || fn.name !== '$MFT') return null;
  const data = attrs.find((a) => a.type === ATTR_DATA && a.nonResident && a.startVcn === 0 && !a.name);
  if (!data?.runs?.length || !data.allocSize) return null;
  const clusters = data.runs.reduce((s, r) => s + r.length, 0);
  // 속성 목록으로 나뉜 $MFT는 lastVcn으로 계산한다.
  const totalClusters = data.lastVcn !== undefined ? data.lastVcn + 1 : clusters;
  const clusterSize = data.allocSize / totalClusters;
  const validCluster = Number.isInteger(clusterSize) && clusterSize >= 512 && (clusterSize & (clusterSize - 1)) === 0;
  if (!validCluster) return null;
  const mftLcn = data.runs[0].lcn;
  if (mftLcn === null) return null;

  const readRec = async (n: number): Promise<NtfsAttr[]> => {
    const r = await dev.read(recordOffset + n * recordSize, recordSize);
    if (r.toString('latin1', 0, 4) !== 'FILE') return [];
    applyFixups(r);
    try {
      return parseAttributes(r);
    } catch {
      return [];
    }
  };

  // 16번 레코드까지 FILE 서명이 있으면 진짜 MFT, 아니면 4개 레코드뿐인 $MFTMirr이다.
  const rec16 = await dev.read(recordOffset + 16 * recordSize, 4);
  const isMirror = rec16.toString('latin1') !== 'FILE';
  const mirrAttrs = await readRec(1);
  const mirrData = mirrAttrs.find((a) => a.type === ATTR_DATA && a.nonResident);
  const mirrLcn = mirrData?.runs?.[0]?.lcn ?? 0;
  const anchorLcn = isMirror ? mirrLcn : mftLcn;
  const volumeOffset = recordOffset - anchorLcn * clusterSize;
  if (volumeOffset < 0) return null;
  const mftOffset = volumeOffset + mftLcn * clusterSize;

  // 볼륨 크기: $BadClus의 $Bad 스트림 크기가 곧 볼륨 크기다. 없으면 $Bitmap으로 추정한다.
  const realMftRecord = async (n: number): Promise<NtfsAttr[]> => {
    const r = await dev.read(mftOffset + n * recordSize, recordSize);
    if (r.toString('latin1', 0, 4) !== 'FILE') return [];
    applyFixups(r);
    try {
      return parseAttributes(r);
    } catch {
      return [];
    }
  };
  let volumeBytes = 0;
  const bad = (await realMftRecord(8)).find((a) => a.type === ATTR_DATA && a.name === '$Bad');
  if (bad?.realSize) volumeBytes = bad.realSize;
  if (!volumeBytes) {
    const bitmap = (await realMftRecord(6)).find((a) => a.type === ATTR_DATA);
    const bits = bitmap?.realSize ?? bitmap?.value?.length ?? 0;
    volumeBytes = bits * 8 * clusterSize;
  }
  if (!volumeBytes) return null;
  // 클러스터로 떨어지지 않는 꼬리 섹터가 있을 수 있다. 백업 부트 섹터가 남아 있으면 그 위치가 정답이다.
  let totalSectors = Math.floor(volumeBytes / dev.sectorSize);
  const sectorsPerCluster = clusterSize / dev.sectorSize;
  for (let i = sectorsPerCluster - 1; i >= 0; i--) {
    const tail = await dev.read(volumeOffset + (totalSectors + i) * dev.sectorSize, dev.sectorSize);
    if (parseNtfsBoot(tail)) {
      totalSectors += i;
      break;
    }
  }
  return { mftOffset, volumeOffset, clusterSize, recordSize, mftLcn, mirrLcn, totalSectors };
}

interface RecordInfo {
  rec: number;
  seq: number;
  inUse: boolean;
  isDir: boolean;
  offset: number;
  name: FileNameAttr | null;
  size: number;
  mtime: number | null;
  ctime: number | null;
  flags: number;
  ext: { offset: number; baseSeq: number }[];
}

/** 레코드 번호 → 볼륨 오프셋 변환용 범위 */
interface MftExtent {
  firstRecord: number;
  records: number;
  offset: number;
}

const BATCH_BYTES = 4 * 1024 * 1024;

export class NtfsVolume extends BaseVolume {
  readonly fsType = 'NTFS';
  private clusterSize: number;
  private recordSize: number;
  private mftOffset: number;
  private mirrOffset: number | null;
  private bitmap: Buffer | null = null;
  public recordsScanned = 0;
  public recordsDamaged = 0;
  /** MFT 레코드를 찾지 못해 시그니처 스캔으로 전환했는지 */
  public usedSignatureScan = false;

  constructor(
    private dev: BlockDevice,
    params: { clusterSize: number; recordSize: number; mftOffset: number; mirrOffset?: number | null },
  ) {
    super();
    this.clusterSize = params.clusterSize;
    this.recordSize = params.recordSize;
    this.mftOffset = params.mftOffset;
    this.mirrOffset = params.mirrOffset ?? null;
  }

  /** 볼륨 장치의 부트 섹터로 연다. 부트 섹터가 망가졌으면 fromMft를 쓴다. */
  static async open(dev: BlockDevice): Promise<NtfsVolume | null> {
    const boot = parseNtfsBoot(await dev.read(0, Math.max(512, dev.sectorSize)));
    if (!boot) return null;
    return new NtfsVolume(dev, {
      clusterSize: boot.clusterSize,
      recordSize: boot.mftRecordSize,
      mftOffset: boot.mftLcn * boot.clusterSize,
      mirrOffset: boot.mftMirrLcn * boot.clusterSize,
    });
  }

  private async loadRecord(offset: number): Promise<Buffer | null> {
    const r = await this.dev.read(offset, this.recordSize);
    if (r.toString('latin1', 0, 4) !== 'FILE') return null;
    applyFixups(r);
    return r;
  }

  /** $MFT 자체의 런 리스트로 레코드 위치 범위를 구한다. */
  private async loadMftExtents(): Promise<MftExtent[] | null> {
    let rec0 = await this.loadRecord(this.mftOffset);
    if (!rec0 && this.mirrOffset !== null) {
      this.warnings.push('$MFT 0번 레코드를 읽지 못해 $MFTMirr을 사용합니다.');
      rec0 = await this.loadRecord(this.mirrOffset);
    }
    if (!rec0) return null;
    let attrs: NtfsAttr[];
    try {
      attrs = parseAttributes(rec0);
    } catch {
      return null;
    }
    const pieces = attrs.filter((a) => a.type === ATTR_DATA && a.nonResident && !a.name);
    if (!pieces.length) return null;

    const toExtents = (list: NtfsAttr[]): MftExtent[] => {
      const out: MftExtent[] = [];
      let recNo = 0;
      const sorted = [...list].sort((a, b) => (a.startVcn ?? 0) - (b.startVcn ?? 0));
      for (const piece of sorted) {
        for (const run of piece.runs ?? []) {
          const count = Math.floor((run.length * this.clusterSize) / this.recordSize);
          if (run.lcn !== null && count > 0) {
            out.push({ firstRecord: recNo, records: count, offset: run.lcn * this.clusterSize });
          }
          recNo += count;
        }
      }
      return out;
    };

    let extents = toExtents(pieces);

    // $MFT가 심하게 조각나면 런이 확장 레코드에 있다.
    const list = attrs.find((a) => a.type === ATTR_LIST);
    if (list) {
      let raw: Buffer | undefined = list.value;
      if (!raw && list.runs) {
        const chunks: Buffer[] = [];
        for (const run of list.runs) {
          if (run.lcn !== null) chunks.push(await this.dev.read(run.lcn * this.clusterSize, run.length * this.clusterSize));
        }
        raw = Buffer.concat(chunks).subarray(0, list.realSize ?? 0);
      }
      if (raw) {
        const wanted = new Set<number>();
        for (let p = 0; p + 26 <= raw.length; ) {
          const type = raw.readUInt32LE(p);
          const len = raw.readUInt16LE(p + 4);
          if (len < 26) break;
          if (type === ATTR_DATA && raw[p + 6] === 0) {
            const baseRec = raw.readUIntLE(p + 16, 6);
            if (baseRec !== 0) wanted.add(baseRec);
          }
          p += len;
        }
        for (const recNo of [...wanted].sort((a, b) => a - b)) {
          const ext = extents.find((x) => recNo >= x.firstRecord && recNo < x.firstRecord + x.records);
          if (!ext) continue;
          const r = await this.loadRecord(ext.offset + (recNo - ext.firstRecord) * this.recordSize);
          if (!r) continue;
          pieces.push(...parseAttributes(r).filter((a) => a.type === ATTR_DATA && a.nonResident && !a.name));
          extents = toExtents(pieces);
        }
      }
    }
    return extents;
  }

  override async scan(opts: ScanOptions = {}): Promise<void> {
    this.resetEntries();
    const infos = new Map<number, RecordInfo>();
    const pendingExt: { base: number; baseSeq: number; offset: number; attrs: NtfsAttr[] }[] = [];

    const handle = (rec: Buffer, offset: number): void => {
      this.recordsScanned++;
      if (!applyFixups(rec)) this.recordsDamaged++;
      this.absorbRecord(rec, offset, infos, pendingExt);
    };

    const extents = opts.deep ? null : await this.loadMftExtents();
    if (extents && extents.length) {
      const total = extents.reduce((s, e) => s + e.records, 0);
      let done = 0;
      for (const ext of extents) {
        for (let i = 0; i < ext.records; ) {
          throwIfAborted(opts.signal);
          const count = Math.min(ext.records - i, Math.floor(BATCH_BYTES / this.recordSize));
          const base = ext.offset + i * this.recordSize;
          const buf = await this.dev.read(base, count * this.recordSize);
          for (let k = 0; k < count; k++) {
            const start = k * this.recordSize;
            if (buf.readUInt32LE(start) !== 0x454c4946) continue; // 'FILE'
            handle(Buffer.from(buf.subarray(start, start + this.recordSize)), base + start);
          }
          i += count;
          done += count;
          opts.onProgress?.({ done, total, message: `MFT 레코드 ${done.toLocaleString()} / ${total.toLocaleString()}` });
          await yieldToLoop();
        }
      }
    } else {
      // 정밀 모드 또는 MFT 위치를 믿을 수 없는 경우: 볼륨 전체에서 FILE 레코드를 찾는다.
      this.usedSignatureScan = true;
      if (!opts.deep) this.warnings.push('$MFT를 해석할 수 없어 볼륨 전체에서 레코드를 찾습니다.');
      const stride = Math.max(this.dev.sectorSize, Math.min(this.recordSize, 1024));
      for (let pos = 0; pos < this.dev.size; pos += BATCH_BYTES) {
        throwIfAborted(opts.signal);
        const len = Math.min(BATCH_BYTES, this.dev.size - pos);
        // 배치 경계에 걸친 레코드까지 읽는다.
        const buf = await this.dev.read(pos, len + this.recordSize);
        for (let p = 0; p < len; p += stride) {
          if (buf.readUInt32LE(p) !== 0x454c4946) continue;
          const usaOff = buf.readUInt16LE(p + 4);
          const attrOff = buf.readUInt16LE(p + 20);
          if (usaOff >= 256 || attrOff >= this.recordSize || attrOff < 40) continue;
          handle(Buffer.from(buf.subarray(p, p + this.recordSize)), pos + p);
        }
        opts.onProgress?.({ done: pos + len, total: this.dev.size, message: '볼륨 전체에서 MFT 레코드 탐색 중' });
        await yieldToLoop();
      }
    }

    this.finalize(infos, pendingExt);
    if (this.recordsDamaged) this.warnings.push(`손상된 MFT 레코드 ${this.recordsDamaged.toLocaleString()}개를 발견했습니다.`);
  }

  private absorbRecord(
    rec: Buffer,
    offset: number,
    infos: Map<number, RecordInfo>,
    pendingExt: { base: number; baseSeq: number; offset: number; attrs: NtfsAttr[] }[],
  ): void {
    let attrs: NtfsAttr[];
    try {
      attrs = parseAttributes(rec);
    } catch {
      return;
    }
    const recNo = rec.readUInt32LE(44);
    const seq = rec.readUInt16LE(16);
    const hdrFlags = rec.readUInt16LE(22);
    const base = rec.readUIntLE(32, 6);
    const baseSeq = rec.readUInt16LE(38);
    if (base !== 0) {
      // 메모리를 아끼려고 필요한 속성만 복사해 둔다.
      const keep = attrs.filter((a) => a.type === ATTR_FILE_NAME || a.type === ATTR_DATA);
      for (const a of keep) if (a.value) a.value = Buffer.from(a.value);
      pendingExt.push({ base, baseSeq, offset, attrs: keep });
      return;
    }
    // 시그니처 스캔에서 같은 번호가 두 번 나오면(미러 등) 먼저 찾은 것을 유지한다.
    if (infos.has(recNo)) return;
    const info: RecordInfo = {
      rec: recNo,
      seq,
      inUse: (hdrFlags & 1) !== 0,
      isDir: (hdrFlags & 2) !== 0,
      offset,
      name: null,
      size: 0,
      mtime: null,
      ctime: null,
      flags: 0,
      ext: [],
    };
    this.applyAttrs(info, attrs);
    infos.set(recNo, info);
  }

  private applyAttrs(info: RecordInfo, attrs: NtfsAttr[]): void {
    for (const a of attrs) {
      if (a.type === ATTR_STANDARD && a.value && a.value.length >= 36) {
        info.ctime = filetimeToMs(a.value, 0);
        info.mtime = filetimeToMs(a.value, 8);
        const dos = a.value.readUInt32LE(32);
        if (dos & 2) info.flags |= FLAG_HIDDEN;
        if (dos & 4) info.flags |= FLAG_SYSTEM;
        if (dos & 0x800) info.flags |= FLAG_COMPRESSED;
        if (dos & 0x4000) info.flags |= FLAG_ENCRYPTED;
        if (dos & 0x200) info.flags |= FLAG_SPARSE;
      } else if (a.type === ATTR_FILE_NAME && a.value) {
        const fn = parseFileName(a.value);
        // Win32 이름을 8.3 DOS 이름보다 우선한다.
        if (fn && (!info.name || info.name.namespace === 2)) info.name = fn;
      } else if (a.type === ATTR_DATA && !a.name) {
        if (a.nonResident) {
          if (a.startVcn === 0) {
            info.size = a.realSize ?? 0;
            if (a.flags & 0x0001) info.flags |= FLAG_COMPRESSED;
            if (a.flags & 0x4000) info.flags |= FLAG_ENCRYPTED;
            if (a.flags & 0x8000) info.flags |= FLAG_SPARSE;
          }
        } else {
          info.size = a.value?.length ?? 0;
        }
      }
    }
  }

  private finalize(
    infos: Map<number, RecordInfo>,
    pendingExt: { base: number; baseSeq: number; offset: number; attrs: NtfsAttr[] }[],
  ): void {
    const seqMatches = (expected: number, actual: RecordInfo): boolean =>
      expected === 0 || expected === actual.seq || (!actual.inUse && expected + 1 === actual.seq);

    for (const e of pendingExt) {
      const info = infos.get(e.base);
      if (!info || !seqMatches(e.baseSeq, info)) continue;
      info.ext.push({ offset: e.offset, baseSeq: e.baseSeq });
      this.applyAttrs(info, e.attrs);
    }

    const FIRST_USER_RECORD = 24;
    const isHiddenSystem = (r: number): boolean => r < FIRST_USER_RECORD && r !== 5;
    const rootRec = 5;
    const idOf = (r: number): number => (r === rootRec ? ROOT_ID : r + 2);

    // $Extend 아래 메타데이터($RmMetadata\$Txf 등)는 레코드 번호가 커도 숨긴다.
    const underSystem = (start: number): boolean => {
      let cur = start;
      for (let i = 0; i < 64; i++) {
        const info = infos.get(cur);
        if (!info?.name || cur === rootRec) return false;
        const parent = info.name.parentRecord;
        if (parent === rootRec) return false;
        if (isHiddenSystem(parent)) return true;
        cur = parent;
      }
      return false;
    };

    const rawParent = new Map<number, number>();
    for (const info of infos.values()) {
      if (!info.name || info.rec === rootRec) continue;
      if (isHiddenSystem(info.rec) || underSystem(info.rec)) continue;
      const { parentRecord, parentSeq } = info.name;
      if (parentRecord === rootRec) {
        rawParent.set(info.rec, rootRec);
        continue;
      }
      const p = infos.get(parentRecord);
      const parentValid = p && p.isDir && parentRecord !== info.rec && seqMatches(parentSeq, p);
      rawParent.set(info.rec, parentValid ? parentRecord : -1);
    }

    // 끊어지거나 순환하는 부모 체인은 고아 폴더로 보낸다.
    const resolved = new Map<number, boolean>();
    const reachesRoot = (start: number): boolean => {
      const chain: number[] = [];
      let cur = start;
      let result = false;
      for (;;) {
        if (cur === rootRec) {
          result = true;
          break;
        }
        const known = resolved.get(cur);
        if (known !== undefined) {
          result = known;
          break;
        }
        if (chain.includes(cur) || chain.length > 4096) break;
        chain.push(cur);
        const next = rawParent.get(cur);
        if (next === undefined || next === -1) break;
        cur = next;
      }
      for (const c of chain) resolved.set(c, result);
      return result;
    };

    let orphans = 0;
    for (const [recNo, parent] of rawParent) {
      const info = infos.get(recNo)!;
      let parentId: number;
      if (parent !== -1 && reachesRoot(recNo)) {
        parentId = idOf(parent);
      } else if (parent !== -1 && rawParent.has(parent) && rawParent.get(parent) !== undefined && !this.isCyclic(recNo, rawParent)) {
        // 부모 폴더는 있지만 그 위가 끊긴 경우: 폴더 구조를 유지한다.
        parentId = idOf(parent);
      } else {
        parentId = ORPHAN_ID;
        orphans++;
        this.ensureOrphanDir();
      }
      const entry: FsEntry = {
        id: idOf(recNo),
        parentId,
        name: info.name!.name,
        isDir: info.isDir,
        size: info.isDir ? 0 : info.size || info.name!.realSize,
        deleted: !info.inUse,
        mtime: info.mtime ?? info.name!.mtime,
        ctime: info.ctime ?? info.name!.ctime,
        flags: info.flags,
        ref: [info.offset, ...info.ext.map((x) => x.offset)],
      };
      this.addEntry(entry);
    }
    if (orphans) this.warnings.push(`경로를 잃은 항목 ${orphans.toLocaleString()}개를 별도 폴더로 분류했습니다.`);
  }

  private isCyclic(start: number, parents: Map<number, number>): boolean {
    const seen = new Set<number>([start]);
    let cur = parents.get(start);
    while (cur !== undefined && cur !== -1) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = parents.get(cur);
    }
    return false;
  }

  private async loadBitmap(): Promise<Buffer | null> {
    if (this.bitmap) return this.bitmap;
    const extents = await this.loadMftExtents();
    const ext = extents?.find((x) => 6 >= x.firstRecord && 6 < x.firstRecord + x.records);
    if (!ext) return null;
    const rec = await this.loadRecord(ext.offset + (6 - ext.firstRecord) * this.recordSize);
    if (!rec) return null;
    const data = parseAttributes(rec).find((a) => a.type === ATTR_DATA && !a.name);
    if (!data) return null;
    if (data.value) return (this.bitmap = Buffer.from(data.value));
    const parts: Buffer[] = [];
    for (const r of data.runs ?? []) {
      if (r.lcn !== null) parts.push(await this.dev.read(r.lcn * this.clusterSize, r.length * this.clusterSize));
    }
    return (this.bitmap = Buffer.concat(parts));
  }

  /** 삭제된 파일의 클러스터 중 이미 다른 파일에 재할당된 개수를 센다. */
  private async countReallocated(runs: Run[]): Promise<number> {
    const bm = await this.loadBitmap().catch(() => null);
    if (!bm) return 0;
    let n = 0;
    for (const r of runs) {
      if (r.lcn === null) continue;
      for (let i = 0; i < r.length; i++) {
        const c = r.lcn + i;
        const byte = Math.floor(c / 8);
        if (byte < bm.length && bm[byte] & (1 << (c % 8))) n++;
      }
    }
    return n;
  }

  override async readEntry(entry: FsEntry, sink: ChunkSink, signal?: AbortSignal): Promise<ReadResult> {
    const warnings: string[] = [];
    const dataAttrs: NtfsAttr[] = [];
    for (const off of entry.ref) {
      const rec = await this.loadRecord(off);
      if (!rec) {
        warnings.push('MFT 레코드를 다시 읽지 못했습니다.');
        continue;
      }
      dataAttrs.push(...parseAttributes(rec).filter((a) => a.type === ATTR_DATA && !a.name));
    }
    if (!dataAttrs.length) {
      if (entry.size > 0) warnings.push('$DATA 속성을 찾을 수 없습니다.');
      return { bytes: 0, warnings };
    }
    const resident = dataAttrs.find((a) => !a.nonResident);
    if (resident) {
      const v = resident.value ?? Buffer.alloc(0);
      await sink(Buffer.from(v));
      return { bytes: v.length, warnings };
    }
    dataAttrs.sort((a, b) => (a.startVcn ?? 0) - (b.startVcn ?? 0));
    const first = dataAttrs[0];
    if (first.startVcn !== 0) warnings.push('파일 앞부분의 런 정보가 없습니다.');
    const realSize = first.realSize ?? entry.size;
    const initSize = Math.min(first.initSize ?? realSize, realSize);
    const runs = dataAttrs.flatMap((a) => a.runs ?? []);

    if (first.flags & 0x4000) warnings.push('EFS 암호화 파일입니다. 암호화된 원본 그대로 저장됩니다.');
    if (entry.deleted) {
      const re = await this.countReallocated(runs);
      if (re > 0) warnings.push(`클러스터 ${re.toLocaleString()}개가 재사용되어 내용이 일부 덮어써졌을 수 있습니다.`);
    }

    if (first.flags & 0x0001 && first.compressionUnit) {
      const bytes = await this.readCompressed(runs, realSize, 1 << first.compressionUnit, sink, signal, warnings);
      return { bytes, warnings };
    }

    let written = 0;
    const volClusters = Math.floor(this.dev.size / this.clusterSize);
    for (const run of runs) {
      let remainingClusters = run.length;
      let lcn = run.lcn;
      while (remainingClusters > 0 && written < realSize) {
        throwIfAborted(signal);
        const n = Math.min(remainingClusters, Math.max(1, Math.floor(BATCH_BYTES / this.clusterSize)));
        const take = Math.min(n * this.clusterSize, realSize - written);
        let chunk: Buffer;
        if (lcn === null) {
          chunk = Buffer.alloc(take);
        } else if (lcn + n > volClusters) {
          warnings.push('런이 볼륨 범위를 벗어나 해당 구간을 0으로 채웠습니다.');
          chunk = Buffer.alloc(take);
        } else {
          chunk = await this.dev.read(lcn * this.clusterSize, take);
        }
        // 초기화 크기(ValidDataLength) 이후는 항상 0이다.
        if (written + take > initSize) chunk.fill(0, Math.max(0, initSize - written));
        await sink(chunk);
        written += take;
        remainingClusters -= n;
        if (lcn !== null) lcn += n;
      }
    }
    if (written < realSize) {
      warnings.push(`런 정보가 부족해 ${realSize - written} 바이트를 0으로 채웠습니다.`);
      while (written < realSize) {
        const n = Math.min(realSize - written, BATCH_BYTES);
        await sink(Buffer.alloc(n));
        written += n;
      }
    }
    return { bytes: written, warnings };
  }

  private async readCompressed(
    runs: Run[],
    realSize: number,
    unitClusters: number,
    sink: ChunkSink,
    signal: AbortSignal | undefined,
    warnings: string[],
  ): Promise<number> {
    // 클러스터 단위로 펼친 뒤 압축 단위(보통 16클러스터)씩 처리한다.
    const unitBytes = unitClusters * this.clusterSize;
    let written = 0;
    let runIdx = 0;
    let runPos = 0;
    const nextUnit = (): { lcn: number; count: number }[] | null => {
      const pieces: { lcn: number; count: number }[] = [];
      let need = unitClusters;
      let seen = false;
      while (need > 0 && runIdx < runs.length) {
        seen = true;
        const r = runs[runIdx];
        const avail = r.length - runPos;
        const take = Math.min(avail, need);
        if (r.lcn !== null) {
          const lcn = r.lcn + runPos;
          const last = pieces[pieces.length - 1];
          if (last && last.lcn + last.count === lcn) last.count += take;
          else pieces.push({ lcn, count: take });
        }
        need -= take;
        runPos += take;
        if (runPos === r.length) {
          runIdx++;
          runPos = 0;
        }
      }
      return seen ? pieces : null;
    };

    while (written < realSize) {
      throwIfAborted(signal);
      const pieces = nextUnit();
      if (!pieces) {
        warnings.push('압축 런이 파일 크기보다 짧습니다.');
        break;
      }
      const allocated = pieces.reduce((s, p) => s + p.count, 0);
      const take = Math.min(unitBytes, realSize - written);
      let out: Buffer;
      if (allocated === 0) {
        out = Buffer.alloc(take);
      } else {
        const parts: Buffer[] = [];
        for (const p of pieces) parts.push(await this.dev.read(p.lcn * this.clusterSize, p.count * this.clusterSize));
        const raw = Buffer.concat(parts);
        if (allocated >= unitClusters) {
          out = raw.subarray(0, take);
        } else {
          out = lznt1Decompress(raw, unitBytes).subarray(0, take);
        }
      }
      await sink(Buffer.from(out));
      written += take;
      await yieldToLoop();
    }
    return written;
  }
}
