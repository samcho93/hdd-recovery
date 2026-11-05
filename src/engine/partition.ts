import { crc32, u64, writeU64 } from './bytes';
import type { BlockDevice } from './device';

export type TableStyle = 'mbr' | 'gpt' | 'none';

export interface PartitionEntry {
  index: number;
  offset: number;
  size: number;
  /** MBR 타입 코드(예: 0x07) 또는 GPT 타입 GUID */
  type: string;
  typeName: string;
  name?: string;
  guid?: string;
  /** GPT 원본 속성값 등 재작성 시 유지할 값 */
  attributes?: Buffer;
}

export interface TableInfo {
  style: TableStyle;
  partitions: PartitionEntry[];
  issues: string[];
  gpt?: {
    primaryOk: boolean;
    backupOk: boolean;
    diskGuid: string;
    entryCount: number;
    entrySize: number;
    firstUsable: number;
    lastUsable: number;
  };
}

export const GPT_BASIC_DATA = 'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7';
export const GPT_ESP = 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B';
export const GPT_MSR = 'E3C9E316-0B5C-4DB8-817D-F92DF00215AE';
export const GPT_WIN_RECOVERY = 'DE94BBA4-06D1-4D40-A16A-BFD50179D6AC';
const GPT_NAMES: Record<string, string> = {
  [GPT_BASIC_DATA]: '기본 데이터',
  [GPT_ESP]: 'EFI 시스템',
  [GPT_MSR]: 'Microsoft 예약',
  [GPT_WIN_RECOVERY]: 'Windows 복구',
  '0FC63DAF-8483-4772-8E79-3D69D8477DE4': 'Linux 파일시스템',
  '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F': 'Linux 스왑',
  '48465300-0000-11AA-AA11-00306543ECAC': 'Apple HFS+',
};

const MBR_NAMES: Record<number, string> = {
  0x01: 'FAT12',
  0x04: 'FAT16 (<32MB)',
  0x05: '확장',
  0x06: 'FAT16',
  0x07: 'NTFS/exFAT',
  0x0b: 'FAT32',
  0x0c: 'FAT32 (LBA)',
  0x0e: 'FAT16 (LBA)',
  0x0f: '확장 (LBA)',
  0x27: 'Windows 복구',
  0x82: 'Linux 스왑',
  0x83: 'Linux',
  0xee: 'GPT 보호',
  0xef: 'EFI 시스템',
};

export function guidToString(b: Buffer, off: number): string {
  const h = (s: number, e: number) => b.toString('hex', off + s, off + e);
  const d1 = b.readUInt32LE(off).toString(16).padStart(8, '0');
  const d2 = b.readUInt16LE(off + 4).toString(16).padStart(4, '0');
  const d3 = b.readUInt16LE(off + 6).toString(16).padStart(4, '0');
  return `${d1}-${d2}-${d3}-${h(8, 10)}-${h(10, 16)}`.toUpperCase();
}

export function stringToGuid(s: string, b: Buffer, off: number): void {
  const hex = s.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`잘못된 GUID: ${s}`);
  b.writeUInt32LE(parseInt(hex.slice(0, 8), 16), off);
  b.writeUInt16LE(parseInt(hex.slice(8, 12), 16), off + 4);
  b.writeUInt16LE(parseInt(hex.slice(12, 16), 16), off + 6);
  Buffer.from(hex.slice(16), 'hex').copy(b, off + 8);
}

export function randomGuid(): string {
  const r = crypto.randomUUID().toUpperCase().split('-');
  return r.join('-');
}

interface GptHeader {
  ok: boolean;
  currentLba: number;
  backupLba: number;
  firstUsable: number;
  lastUsable: number;
  diskGuid: string;
  entriesLba: number;
  entryCount: number;
  entrySize: number;
  entriesCrc: number;
}

function parseGptHeader(buf: Buffer): GptHeader | null {
  if (buf.toString('latin1', 0, 8) !== 'EFI PART') return null;
  const headerSize = buf.readUInt32LE(12);
  if (headerSize < 92 || headerSize > buf.length) return null;
  const copy = Buffer.from(buf.subarray(0, headerSize));
  const stored = copy.readUInt32LE(16);
  copy.writeUInt32LE(0, 16);
  return {
    ok: crc32(copy) === stored,
    currentLba: u64(buf, 24),
    backupLba: u64(buf, 32),
    firstUsable: u64(buf, 40),
    lastUsable: u64(buf, 48),
    diskGuid: guidToString(buf, 56),
    entriesLba: u64(buf, 72),
    entryCount: buf.readUInt32LE(80),
    entrySize: buf.readUInt32LE(84),
    entriesCrc: buf.readUInt32LE(88),
  };
}

function parseGptEntries(buf: Buffer, h: GptHeader, sectorSize: number): PartitionEntry[] {
  const out: PartitionEntry[] = [];
  for (let i = 0; i < h.entryCount; i++) {
    const e = i * h.entrySize;
    if (e + 128 > buf.length) break;
    if (buf.subarray(e, e + 16).every((x) => x === 0)) continue;
    const type = guidToString(buf, e);
    const first = u64(buf, e + 32);
    const last = u64(buf, e + 40);
    if (last < first) continue;
    const name = buf.toString('utf16le', e + 56, e + 128).replace(/\0.*$/s, '');
    out.push({
      index: i + 1,
      offset: first * sectorSize,
      size: (last - first + 1) * sectorSize,
      type,
      typeName: GPT_NAMES[type] ?? '알 수 없음',
      name,
      guid: guidToString(buf, e + 16),
      attributes: Buffer.from(buf.subarray(e + 48, e + 56)),
    });
  }
  return out;
}

async function readGptAt(
  dev: BlockDevice,
  lba: number,
): Promise<{ header: GptHeader; entries: Buffer; entriesOk: boolean } | null> {
  const ss = dev.sectorSize;
  const raw = await dev.read(lba * ss, ss);
  const h = parseGptHeader(raw);
  if (!h || !h.ok) return null;
  if (h.entrySize < 128 || h.entrySize > 4096 || h.entryCount === 0 || h.entryCount > 16384) return null;
  const total = h.entryCount * h.entrySize;
  const alignedLen = Math.ceil(total / ss) * ss;
  const entries = (await dev.read(h.entriesLba * ss, alignedLen)).subarray(0, total);
  return { header: h, entries, entriesOk: crc32(entries) === h.entriesCrc };
}

async function readEbrChain(dev: BlockDevice, extStart: number, startIndex: number): Promise<PartitionEntry[]> {
  const ss = dev.sectorSize;
  const out: PartitionEntry[] = [];
  let next = 0;
  const seen = new Set<number>();
  let index = startIndex;
  while (!seen.has(next) && seen.size < 128) {
    seen.add(next);
    const ebr = await dev.read((extStart + next) * ss, ss);
    if (ebr.readUInt16LE(510) !== 0xaa55) break;
    const type = ebr[446 + 4];
    const lba = ebr.readUInt32LE(446 + 8);
    const count = ebr.readUInt32LE(446 + 12);
    if (type !== 0 && count > 0) {
      out.push({
        index: index++,
        offset: (extStart + next + lba) * ss,
        size: count * ss,
        type: `0x${type.toString(16).padStart(2, '0')}`,
        typeName: MBR_NAMES[type] ?? '알 수 없음',
      });
    }
    const linkType = ebr[462 + 4];
    if (linkType !== 0x05 && linkType !== 0x0f) break;
    next = ebr.readUInt32LE(462 + 8);
    if (next === 0) break;
  }
  return out;
}

/**
 * 디스크의 파티션 테이블을 읽는다. 손상된 부분은 issues에 기록하고, 읽을 수 있는 정보를 최대한 돌려준다.
 */
export async function readPartitionTable(dev: BlockDevice): Promise<TableInfo> {
  const ss = dev.sectorSize;
  const mbr = await dev.read(0, ss);
  const issues: string[] = [];
  const hasSig = mbr.readUInt16LE(510) === 0xaa55;
  const lastLba = Math.floor(dev.size / ss) - 1;

  const primary = await readGptAt(dev, 1);
  let backup: Awaited<ReturnType<typeof readGptAt>> = null;
  const protective = hasSig && [0, 1, 2, 3].some((i) => mbr[446 + i * 16 + 4] === 0xee);

  if (primary || protective || (await dev.read(ss, 8)).toString('latin1') === 'EFI PART') {
    backup = await readGptAt(dev, primary ? primary.header.backupLba : lastLba);
  } else {
    // MBR도 보호 항목도 없는 경우: 뒤쪽 백업 GPT만 살아 있을 수 있다.
    backup = await readGptAt(dev, lastLba);
    if (backup && hasSig && !protective) {
      const hasRealMbrPart = [0, 1, 2, 3].some((i) => mbr[446 + i * 16 + 4] !== 0);
      if (hasRealMbrPart) backup = null; // MBR로 다시 초기화된 디스크의 잔재
    }
  }

  const primaryOk = !!primary && primary.entriesOk;
  const backupOk = !!backup && backup.entriesOk;
  if (primaryOk || backupOk) {
    const src = primaryOk ? primary! : backup!;
    if (!primaryOk) issues.push('기본 GPT 헤더 또는 파티션 배열이 손상되었습니다. 백업 GPT를 사용합니다.');
    if (!backupOk) issues.push('백업 GPT가 손상되었거나 없습니다.');
    if (!hasSig || !protective) issues.push('보호 MBR이 없습니다.');
    return {
      style: 'gpt',
      partitions: parseGptEntries(src.entries, src.header, ss),
      issues,
      gpt: {
        primaryOk,
        backupOk,
        diskGuid: src.header.diskGuid,
        entryCount: src.header.entryCount,
        entrySize: src.header.entrySize,
        firstUsable: src.header.firstUsable,
        lastUsable: src.header.lastUsable,
      },
    };
  }
  if (protective) {
    issues.push('보호 MBR은 있지만 기본/백업 GPT가 모두 손상되었습니다.');
    return { style: 'none', partitions: [], issues };
  }
  if (!hasSig) {
    issues.push('MBR 서명(55 AA)이 없습니다. 파티션 테이블이 없거나 손상되었습니다.');
    return { style: 'none', partitions: [], issues };
  }

  // 슈퍼플로피: 0번 섹터가 곧 파일시스템 부트 섹터
  const oem = mbr.toString('latin1', 3, 11);
  if (oem === 'NTFS    ' || oem === 'EXFAT   ' || mbr.toString('latin1', 82, 87) === 'FAT32') {
    return { style: 'none', partitions: [], issues };
  }

  const partitions: PartitionEntry[] = [];
  let logicalIndex = 5;
  for (let i = 0; i < 4; i++) {
    const e = 446 + i * 16;
    const type = mbr[e + 4];
    const lba = mbr.readUInt32LE(e + 8);
    const count = mbr.readUInt32LE(e + 12);
    if (type === 0 || count === 0) continue;
    if (lba === 0 || (lba + count) * ss > dev.size + ss) {
      issues.push(`MBR 항목 ${i + 1}의 범위가 디스크를 벗어납니다.`);
    }
    if (type === 0x05 || type === 0x0f) {
      const logical = await readEbrChain(dev, lba, logicalIndex);
      logicalIndex += logical.length;
      partitions.push(...logical);
      continue;
    }
    partitions.push({
      index: i + 1,
      offset: lba * ss,
      size: count * ss,
      type: `0x${type.toString(16).padStart(2, '0')}`,
      typeName: MBR_NAMES[type] ?? '알 수 없음',
    });
  }
  return { style: 'mbr', partitions, issues };
}

export interface NewPartition {
  offset: number;
  size: number;
  /** MBR 타입 코드 */
  mbrType: number;
  /** GPT 타입 GUID */
  gptType: string;
  name?: string;
  guid?: string;
  attributes?: Buffer;
}

export function buildMbr(parts: NewPartition[], sectorSize: number, existing?: Buffer): Buffer {
  if (parts.length > 4) throw new Error('MBR은 주 파티션을 4개까지만 지원합니다.');
  const buf = Buffer.alloc(sectorSize);
  if (existing) existing.copy(buf, 0, 0, 440); // 부트 코드는 유지
  buf.writeUInt32LE(existing ? existing.readUInt32LE(440) : (Math.random() * 0xffffffff) >>> 0, 440);
  parts.forEach((p, i) => {
    const e = 446 + i * 16;
    const lba = p.offset / sectorSize;
    const count = p.size / sectorSize;
    if (lba + count > 0xffffffff) throw new Error('이 파티션은 MBR 주소 범위(2TiB)를 넘습니다. GPT를 사용하세요.');
    buf.writeUIntLE(0xfeffff, e + 1, 3);
    buf[e + 4] = p.mbrType;
    buf.writeUIntLE(0xfeffff, e + 5, 3);
    buf.writeUInt32LE(lba, e + 8);
    buf.writeUInt32LE(count, e + 12);
  });
  buf.writeUInt16LE(0xaa55, 510);
  return buf;
}

export interface SectorWrite {
  offset: number;
  data: Buffer;
  description: string;
}

function buildGptHeader(opts: {
  sectorSize: number;
  currentLba: number;
  backupLba: number;
  firstUsable: number;
  lastUsable: number;
  diskGuid: string;
  entriesLba: number;
  entryCount: number;
  entrySize: number;
  entriesCrc: number;
}): Buffer {
  const h = Buffer.alloc(opts.sectorSize);
  h.write('EFI PART', 0, 'latin1');
  h.writeUInt32LE(0x00010000, 8);
  h.writeUInt32LE(92, 12);
  writeU64(h, 24, opts.currentLba);
  writeU64(h, 32, opts.backupLba);
  writeU64(h, 40, opts.firstUsable);
  writeU64(h, 48, opts.lastUsable);
  stringToGuid(opts.diskGuid, h, 56);
  writeU64(h, 72, opts.entriesLba);
  h.writeUInt32LE(opts.entryCount, 80);
  h.writeUInt32LE(opts.entrySize, 84);
  h.writeUInt32LE(opts.entriesCrc, 88);
  h.writeUInt32LE(crc32(h.subarray(0, 92)), 16);
  return h;
}

/** 보호 MBR + 기본 GPT + 백업 GPT 전체를 생성한다. */
export function buildGpt(parts: NewPartition[], diskSize: number, sectorSize: number, diskGuid?: string): SectorWrite[] {
  const ss = sectorSize;
  const entryCount = 128;
  const entrySize = 128;
  const entriesBytes = entryCount * entrySize;
  const entrySectors = Math.ceil(entriesBytes / ss);
  const lastLba = Math.floor(diskSize / ss) - 1;
  const firstUsable = 2 + entrySectors;
  const lastUsable = lastLba - entrySectors - 1;

  const entries = Buffer.alloc(entrySectors * ss);
  parts.forEach((p, i) => {
    const e = i * entrySize;
    const first = p.offset / ss;
    const last = first + p.size / ss - 1;
    if (first < firstUsable || last > lastUsable) {
      throw new Error('파티션이 GPT 사용 가능 영역을 벗어납니다.');
    }
    stringToGuid(p.gptType, entries, e);
    stringToGuid(p.guid ?? randomGuid(), entries, e + 16);
    writeU64(entries, e + 32, first);
    writeU64(entries, e + 40, last);
    p.attributes?.copy(entries, e + 48);
    if (p.name) entries.write(p.name.slice(0, 36), e + 56, 'utf16le');
  });
  const crc = crc32(entries.subarray(0, entriesBytes));
  const guid = diskGuid ?? randomGuid();
  const common = { sectorSize: ss, firstUsable, lastUsable, diskGuid: guid, entryCount, entrySize, entriesCrc: crc };
  const primary = buildGptHeader({ ...common, currentLba: 1, backupLba: lastLba, entriesLba: 2 });
  const backupEntriesLba = lastLba - entrySectors;
  const backup = buildGptHeader({ ...common, currentLba: lastLba, backupLba: 1, entriesLba: backupEntriesLba });

  const pmbr = Buffer.alloc(ss);
  pmbr.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, 440);
  pmbr[446 + 1] = 0x00;
  pmbr[446 + 2] = 0x02;
  pmbr[446 + 4] = 0xee;
  pmbr.writeUIntLE(0xffffff, 446 + 5, 3);
  pmbr.writeUInt32LE(1, 446 + 8);
  pmbr.writeUInt32LE(Math.min(lastLba, 0xffffffff), 446 + 12);
  pmbr.writeUInt16LE(0xaa55, 510);

  return [
    { offset: 0, data: pmbr, description: '보호 MBR' },
    { offset: ss, data: primary, description: '기본 GPT 헤더' },
    { offset: 2 * ss, data: entries, description: '기본 GPT 파티션 배열' },
    { offset: backupEntriesLba * ss, data: entries, description: '백업 GPT 파티션 배열' },
    { offset: lastLba * ss, data: backup, description: '백업 GPT 헤더' },
  ];
}
