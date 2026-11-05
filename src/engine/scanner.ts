import { randomUUID } from 'node:crypto';
import { throwIfAborted, yieldToLoop, type ProgressFn } from './bytes';
import { SliceDevice, type BlockDevice } from './device';
import { ExfatVolume, exfatBootChecksum, parseExfatBoot, type ExfatBoot } from './exfat';
import { FatVolume, parseFatBoot, type FatBoot } from './fat';
import { discoverFromMftRecord, NtfsVolume, parseNtfsBoot, type NtfsBoot } from './ntfs';
import { readPartitionTable, type PartitionEntry, type TableInfo } from './partition';
import type { RecoveryVolume } from './volume';

export type FsType = 'NTFS' | 'FAT12' | 'FAT16' | 'FAT32' | 'exFAT' | 'BitLocker' | 'ReFS' | 'ext' | 'HFS+' | 'unknown';

export interface FoundVolume {
  id: string;
  offset: number;
  size: number;
  fsType: FsType;
  /** 어떻게 찾았는가: 파티션 테이블 / 부트 섹터 / 백업 부트 섹터 / MFT 역산 */
  source: 'table' | 'boot' | 'backup-boot' | 'mft' | 'empty';
  bootOk: boolean;
  backupOk: boolean | null;
  inTable: boolean;
  partition?: PartitionEntry;
  notes: string[];
  /** 복구 지원 여부 */
  recoverable: boolean;
  clusterSize?: number;
  /** MFT 역산으로 찾은 경우의 구조 정보 */
  mft?: {
    mftOffset: number;
    clusterSize: number;
    recordSize: number;
    mftLcn: number;
    mirrLcn: number;
    totalSectors: number;
  };
}

export interface ScanResult {
  table: TableInfo;
  volumes: FoundVolume[];
  sectorsRead: number;
  mode: 'quick' | 'deep';
}

interface Probe {
  fsType: FsType;
  size: number;
  bootOk: boolean;
  clusterSize?: number;
  notes: string[];
}

function verifyMftSignature(buf: Buffer): boolean {
  return buf.toString('latin1', 0, 4) === 'FILE';
}

async function probeNtfsBoot(dev: BlockDevice, offset: number, boot: NtfsBoot): Promise<boolean> {
  const mft = await dev.read(offset + boot.mftLcn * boot.clusterSize, 512);
  if (verifyMftSignature(mft)) return true;
  if (boot.mftMirrLcn) {
    const mirr = await dev.read(offset + boot.mftMirrLcn * boot.clusterSize, 512);
    if (verifyMftSignature(mirr)) return true;
  }
  return false;
}

async function verifyFatStructure(dev: BlockDevice, offset: number, b: FatBoot): Promise<boolean> {
  const fat = await dev.read(offset + b.reservedSectors * b.bytesPerSector, 512);
  return fat[0] === b.media && fat[1] === 0xff;
}

async function verifyExfatStructure(dev: BlockDevice, offset: number, b: ExfatBoot): Promise<boolean> {
  const fat = await dev.read(offset + b.fatOffset * b.bytesPerSector, 512);
  return fat.readUInt32LE(0) === 0xfffffff8;
}

/** 지정 오프셋의 파일시스템을 식별한다. */
export async function probeAt(dev: BlockDevice, offset: number): Promise<Probe | null> {
  const ss = dev.sectorSize;
  const head = await dev.read(offset, Math.max(4096, ss * 2));
  const oem = head.toString('latin1', 3, 11);
  if (oem === '-FVE-FS-') {
    return { fsType: 'BitLocker', size: 0, bootOk: true, notes: ['BitLocker로 암호화되어 있어 복구 키 없이는 파일을 볼 수 없습니다.'] };
  }
  if (head.toString('latin1', 3, 7) === 'ReFS') {
    return { fsType: 'ReFS', size: 0, bootOk: true, notes: ['ReFS는 식별만 지원합니다.'] };
  }
  const ntfs = parseNtfsBoot(head);
  if (ntfs) {
    const ok = await probeNtfsBoot(dev, offset, ntfs);
    return {
      fsType: 'NTFS',
      size: (ntfs.totalSectors + 1) * ntfs.bytesPerSector,
      bootOk: ok,
      clusterSize: ntfs.clusterSize,
      notes: ok ? [] : ['부트 섹터는 있지만 $MFT 위치가 맞지 않습니다.'],
    };
  }
  const ex = parseExfatBoot(head);
  if (ex) {
    const ok = await verifyExfatStructure(dev, offset, ex);
    return {
      fsType: 'exFAT',
      size: ex.volumeLength * ex.bytesPerSector,
      bootOk: ok,
      clusterSize: ex.clusterSize,
      notes: ok ? [] : ['FAT 영역의 서명이 맞지 않습니다.'],
    };
  }
  const fat = parseFatBoot(head);
  if (fat) {
    const ok = await verifyFatStructure(dev, offset, fat);
    return {
      fsType: fat.type,
      size: fat.totalSectors * fat.bytesPerSector,
      bootOk: ok,
      clusterSize: fat.clusterSize,
      notes: ok ? [] : ['FAT 첫 항목이 BPB와 맞지 않습니다.'],
    };
  }
  if (head.readUInt16LE(1024 + 56) === 0xef53) {
    return { fsType: 'ext', size: 0, bootOk: true, notes: ['ext2/3/4는 식별만 지원합니다.'] };
  }
  if (head.toString('latin1', 1024, 1026) === 'H+' || head.toString('latin1', 1024, 1026) === 'HX') {
    return { fsType: 'HFS+', size: 0, bootOk: true, notes: ['HFS+는 식별만 지원합니다.'] };
  }
  return null;
}

const RECOVERABLE: FsType[] = ['NTFS', 'FAT12', 'FAT16', 'FAT32', 'exFAT'];

function newVolume(base: Omit<FoundVolume, 'id' | 'recoverable'>): FoundVolume {
  return { ...base, id: randomUUID(), recoverable: RECOVERABLE.includes(base.fsType) };
}

/** 파일시스템 시작 위치를 알 때, 백업 부트 섹터가 살아 있는지 확인한다. */
export async function checkBackupBoot(dev: BlockDevice, offset: number, fsType: FsType, size: number): Promise<boolean | null> {
  const ss = dev.sectorSize;
  switch (fsType) {
    case 'NTFS': {
      if (!size) return null;
      const b = await dev.read(offset + size - ss, ss);
      return parseNtfsBoot(b) !== null;
    }
    case 'FAT32': {
      const b = await dev.read(offset + 6 * ss, ss);
      return parseFatBoot(b) !== null;
    }
    case 'exFAT': {
      const b = await dev.read(offset + 12 * ss, ss);
      if (!parseExfatBoot(b)) return false;
      const region = await dev.read(offset + 12 * ss, ss * 12);
      return region.readUInt32LE(ss * 11) === exfatBootChecksum(region, ss);
    }
    default:
      return null;
  }
}

/** 부트 섹터가 후보 위치에 있을 때, 그게 백업이면 실제 볼륨 시작 위치를 계산한다. */
async function resolveBootCandidate(dev: BlockDevice, pos: number, head: Buffer): Promise<FoundVolume | null> {
  const ss = dev.sectorSize;
  const ntfs = parseNtfsBoot(head);
  if (ntfs) {
    if (await probeNtfsBoot(dev, pos, ntfs)) {
      const size = (ntfs.totalSectors + 1) * ntfs.bytesPerSector;
      const backupOk = await checkBackupBoot(dev, pos, 'NTFS', size);
      return newVolume({
        offset: pos,
        size,
        fsType: 'NTFS',
        source: 'boot',
        bootOk: true,
        backupOk,
        inTable: false,
        clusterSize: ntfs.clusterSize,
        notes: [],
      });
    }
    // 볼륨 끝에 있는 백업 부트 섹터일 수 있다.
    const start = pos - ntfs.totalSectors * ntfs.bytesPerSector;
    if (start >= 0 && (await probeNtfsBoot(dev, start, ntfs))) {
      const primary = parseNtfsBoot(await dev.read(start, 512));
      return newVolume({
        offset: start,
        size: (ntfs.totalSectors + 1) * ntfs.bytesPerSector,
        fsType: 'NTFS',
        source: 'backup-boot',
        bootOk: primary !== null,
        backupOk: true,
        inTable: false,
        clusterSize: ntfs.clusterSize,
        notes: primary ? [] : ['기본 부트 섹터가 손상되어 볼륨 끝의 백업으로 찾았습니다.'],
      });
    }
    return null;
  }
  const ex = parseExfatBoot(head);
  if (ex) {
    if (await verifyExfatStructure(dev, pos, ex)) {
      return newVolume({
        offset: pos,
        size: ex.volumeLength * ex.bytesPerSector,
        fsType: 'exFAT',
        source: 'boot',
        bootOk: true,
        backupOk: await checkBackupBoot(dev, pos, 'exFAT', 0),
        inTable: false,
        clusterSize: ex.clusterSize,
        notes: [],
      });
    }
    const start = pos - 12 * ex.bytesPerSector;
    if (start >= 0 && (await verifyExfatStructure(dev, start, ex))) {
      const primary = parseExfatBoot(await dev.read(start, ss));
      return newVolume({
        offset: start,
        size: ex.volumeLength * ex.bytesPerSector,
        fsType: 'exFAT',
        source: 'backup-boot',
        bootOk: primary !== null,
        backupOk: true,
        inTable: false,
        clusterSize: ex.clusterSize,
        notes: primary ? [] : ['기본 부트 섹터가 손상되어 백업 부트 영역으로 찾았습니다.'],
      });
    }
    return null;
  }
  const fat = parseFatBoot(head);
  if (fat) {
    if (await verifyFatStructure(dev, pos, fat)) {
      return newVolume({
        offset: pos,
        size: fat.totalSectors * fat.bytesPerSector,
        fsType: fat.type,
        source: 'boot',
        bootOk: true,
        backupOk: await checkBackupBoot(dev, pos, fat.type, 0),
        inTable: false,
        clusterSize: fat.clusterSize,
        notes: [],
      });
    }
    if (fat.type === 'FAT32' && fat.backupBootSector) {
      const start = pos - fat.backupBootSector * fat.bytesPerSector;
      if (start >= 0 && (await verifyFatStructure(dev, start, fat))) {
        const primary = parseFatBoot(await dev.read(start, 512));
        return newVolume({
          offset: start,
          size: fat.totalSectors * fat.bytesPerSector,
          fsType: 'FAT32',
          source: 'backup-boot',
          bootOk: primary !== null,
          backupOk: true,
          inTable: false,
          clusterSize: fat.clusterSize,
          notes: primary ? [] : ['기본 부트 섹터가 손상되어 6번 섹터의 백업으로 찾았습니다.'],
        });
      }
    }
  }
  return null;
}

function contains(list: FoundVolume[], pos: number): boolean {
  return list.some((v) => v.size > 0 && v.source !== 'empty' && pos >= v.offset && pos < v.offset + v.size);
}

function sameStart(list: FoundVolume[], v: FoundVolume): boolean {
  return list.some((x) => x.offset === v.offset && x.fsType !== 'unknown');
}

export interface FindOptions {
  deep?: boolean;
  signal?: AbortSignal;
  onProgress?: ProgressFn;
  onFound?: (v: FoundVolume) => void;
}

async function probeTableEntry(dev: BlockDevice, p: PartitionEntry): Promise<FoundVolume> {
  const probe = await probeAt(dev, p.offset);
  if (probe) {
    const size = probe.size || p.size;
    return newVolume({
      offset: p.offset,
      size,
      fsType: probe.fsType,
      source: 'table',
      bootOk: probe.bootOk,
      backupOk: await checkBackupBoot(dev, p.offset, probe.fsType, size),
      inTable: true,
      partition: p,
      clusterSize: probe.clusterSize,
      notes: probe.notes,
    });
  }
  // 테이블 항목은 있는데 파일시스템을 모르는 경우: 백업 부트 섹터로 다시 시도
  const end = p.offset + p.size;
  const tail = await dev.read(end - dev.sectorSize, dev.sectorSize);
  const candidates: { off: number; fs: FsType }[] = [];
  if (parseNtfsBoot(tail)) candidates.push({ off: end - dev.sectorSize, fs: 'NTFS' });
  const fatBackup = await dev.read(p.offset + 6 * dev.sectorSize, dev.sectorSize);
  if (parseFatBoot(fatBackup)) candidates.push({ off: p.offset + 6 * dev.sectorSize, fs: 'FAT32' });
  const exBackup = await dev.read(p.offset + 12 * dev.sectorSize, dev.sectorSize);
  if (parseExfatBoot(exBackup)) candidates.push({ off: p.offset + 12 * dev.sectorSize, fs: 'exFAT' });
  for (const c of candidates) {
    const head = await dev.read(c.off, Math.max(512, dev.sectorSize));
    const v = await resolveBootCandidate(dev, c.off, head);
    if (v && v.offset === p.offset) {
      return { ...v, inTable: true, partition: p, source: 'backup-boot' };
    }
  }
  return newVolume({
    offset: p.offset,
    size: p.size,
    fsType: 'unknown',
    source: 'table',
    bootOk: false,
    backupOk: null,
    inTable: true,
    partition: p,
    notes: ['파일시스템을 식별할 수 없습니다. 정밀 스캔으로 $MFT를 찾아보세요.'],
  });
}

/**
 * 디스크에서 볼륨을 찾는다.
 * - 빠른 스캔: 파티션 테이블 + 흔한 시작 위치(1MiB 정렬)
 * - 정밀 스캔: 디스크 전체를 순차로 읽어 부트 섹터와 $MFT 레코드를 찾는다.
 */
export async function findVolumes(dev: BlockDevice, opts: FindOptions = {}): Promise<ScanResult> {
  const table = await readPartitionTable(dev);
  const volumes: FoundVolume[] = [];
  const add = (v: FoundVolume): void => {
    volumes.push(v);
    opts.onFound?.(v);
  };

  for (const p of table.partitions) {
    throwIfAborted(opts.signal);
    if (p.offset + dev.sectorSize > dev.size) continue;
    add(await probeTableEntry(dev, p));
  }

  const ss = dev.sectorSize;
  // 슈퍼플로피(테이블 없이 0번 섹터부터 볼륨)
  if (table.style === 'none') {
    const head = await dev.read(0, Math.max(512, ss));
    const v = await resolveBootCandidate(dev, 0, head);
    if (v) add(v);
  }

  let sectorsRead = 0;
  const tryCandidate = async (pos: number, head: Buffer): Promise<void> => {
    const known = volumes.find((v) => v.fsType !== 'unknown' && v.offset === pos);
    if (known) return;
    if (contains(volumes.filter((v) => v.fsType !== 'unknown'), pos)) return;
    const v = await resolveBootCandidate(dev, pos, head);
    if (!v || sameStart(volumes, v)) return;
    const unknown = volumes.find((x) => x.fsType === 'unknown' && x.offset === v.offset);
    if (unknown) {
      Object.assign(unknown, { ...v, id: unknown.id, inTable: true, partition: unknown.partition });
      return;
    }
    add(v);
  };

  const tryMftRecord = async (pos: number): Promise<void> => {
    if (contains(volumes.filter((v) => v.fsType !== 'unknown'), pos)) return;
    const d = await discoverFromMftRecord(dev, pos);
    if (!d) return;
    if (volumes.some((v) => v.offset === d.volumeOffset && v.fsType !== 'unknown')) return;
    const unknown = volumes.find((x) => x.fsType === 'unknown' && x.offset === d.volumeOffset);
    // 파티션 항목이 남아 있고 크기가 맞으면 파티션 끝까지가 볼륨이다(NTFS 총 섹터 수 = 파티션 섹터 수 - 1).
    let totalSectors = d.totalSectors;
    if (unknown && unknown.size >= (totalSectors + 1) * ss && unknown.size - (totalSectors + 1) * ss < d.clusterSize) {
      totalSectors = unknown.size / ss - 1;
    }
    const size = (totalSectors + 1) * ss;
    const mft = {
      mftOffset: d.mftOffset,
      clusterSize: d.clusterSize,
      recordSize: d.recordSize,
      mftLcn: d.mftLcn,
      mirrLcn: d.mirrLcn,
      totalSectors,
    };
    const backupOk = await checkBackupBoot(dev, d.volumeOffset, 'NTFS', size);
    const notes = ['부트 섹터 없이 $MFT에서 볼륨 구조를 역산했습니다.'];
    if (unknown) {
      Object.assign(unknown, {
        fsType: 'NTFS',
        size,
        source: 'mft',
        bootOk: false,
        backupOk,
        clusterSize: d.clusterSize,
        mft,
        notes,
        recoverable: true,
      });
      return;
    }
    add(
      newVolume({
        offset: d.volumeOffset,
        size,
        fsType: 'NTFS',
        source: 'mft',
        bootOk: false,
        backupOk,
        inTable: false,
        clusterSize: d.clusterSize,
        mft,
        notes,
      }),
    );
  };

  if (!opts.deep) {
    // 빠른 스캔: 앞쪽 2GiB에서 1MiB 정렬 위치와 고전적인 63섹터 위치만 본다.
    const step = 1024 * 1024;
    const limit = Math.min(dev.size, 2 * 1024 * 1024 * 1024);
    const positions = [63 * ss];
    for (let p = step; p < limit; p += step) positions.push(p);
    for (let i = 0; i < positions.length; i++) {
      throwIfAborted(opts.signal);
      const head = await dev.read(positions[i], Math.max(512, ss));
      sectorsRead++;
      await tryCandidate(positions[i], head);
      if (i % 64 === 0) {
        opts.onProgress?.({ done: i, total: positions.length, message: '주요 시작 위치 확인 중' });
        await yieldToLoop();
      }
    }
    opts.onProgress?.({ done: positions.length, total: positions.length, message: '완료' });
  } else {
    const chunk = 4 * 1024 * 1024;
    for (let pos = 0; pos < dev.size; pos += chunk) {
      throwIfAborted(opts.signal);
      const len = Math.min(chunk, dev.size - pos);
      const buf = await dev.read(pos, len);
      sectorsRead += len / ss;
      for (let p = 0; p + ss <= len; p += ss) {
        const b0 = buf[p];
        // 부트 섹터 후보
        if ((b0 === 0xeb || b0 === 0xe9) && buf[p + 510] === 0x55 && buf[p + 511] === 0xaa) {
          await tryCandidate(pos + p, buf.subarray(p, p + ss));
        } else if (b0 === 0x46 && buf.readUInt32LE(p) === 0x454c4946 && buf.readUInt32LE(p + 44) === 0) {
          // 'FILE' + 레코드 번호 0 = $MFT 또는 $MFTMirr
          await tryMftRecord(pos + p);
        }
      }
      opts.onProgress?.({
        done: pos + len,
        total: dev.size,
        message: `정밀 스캔: 볼륨 ${volumes.filter((v) => v.fsType !== 'unknown').length}개 발견`,
      });
      await yieldToLoop();
    }
  }

  volumes.sort((a, b) => a.offset - b.offset);
  return { table, volumes, sectorsRead, mode: opts.deep ? 'deep' : 'quick' };
}

/** 찾은 볼륨을 파일 탐색용 객체로 연다. */
export async function openFoundVolume(dev: BlockDevice, v: FoundVolume): Promise<RecoveryVolume> {
  const size = Math.max(v.size, 0) || dev.size - v.offset;
  const slice = new SliceDevice(dev, v.offset, Math.min(size, dev.size - v.offset));
  if (v.mft) {
    return new NtfsVolume(slice, {
      clusterSize: v.mft.clusterSize,
      recordSize: v.mft.recordSize,
      mftOffset: v.mft.mftOffset - v.offset,
      mirrOffset: v.mft.mirrLcn ? v.mft.mirrLcn * v.mft.clusterSize : null,
    });
  }
  let vol: RecoveryVolume | null = null;
  if (v.fsType === 'NTFS') vol = await NtfsVolume.open(slice);
  else if (v.fsType === 'exFAT') vol = await ExfatVolume.open(slice);
  else if (v.fsType.startsWith('FAT')) vol = await FatVolume.open(slice);

  if (vol) return vol;

  // 기본 부트 섹터가 망가진 경우 백업 부트 섹터 내용으로 읽는다.
  if (v.source === 'backup-boot') {
    const ss = dev.sectorSize;
    if (v.fsType === 'NTFS') {
      const boot = parseNtfsBoot(await dev.read(v.offset + v.size - ss, ss));
      if (boot) {
        return new NtfsVolume(slice, {
          clusterSize: boot.clusterSize,
          recordSize: boot.mftRecordSize,
          mftOffset: boot.mftLcn * boot.clusterSize,
          mirrOffset: boot.mftMirrLcn * boot.clusterSize,
        });
      }
    } else if (v.fsType === 'exFAT') {
      const boot = parseExfatBoot(await dev.read(v.offset + 12 * ss, ss));
      if (boot) return new ExfatVolume(slice, boot);
    } else if (v.fsType === 'FAT32') {
      const boot = parseFatBoot(await dev.read(v.offset + 6 * ss, ss));
      if (boot) return new FatVolume(slice, boot);
    }
  }
  throw new Error(`${v.fsType} 볼륨을 열 수 없습니다.`);
}
