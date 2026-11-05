import { throwIfAborted, yieldToLoop, type ProgressFn } from './bytes';
import type { BlockDevice } from './device';

export interface Fat32Options {
  label?: string;
  clusterSize?: number;
  serial?: number;
  signal?: AbortSignal;
  onProgress?: ProgressFn;
}

/** Microsoft 기본값을 따른 볼륨 크기별 클러스터 크기 */
export function defaultFat32ClusterSize(volumeBytes: number): number {
  const GB = 1024 ** 3;
  if (volumeBytes <= 8 * GB) return 4096;
  if (volumeBytes <= 16 * GB) return 8192;
  if (volumeBytes <= 32 * GB) return 16384;
  return 32768;
}

export interface Fat32Layout {
  sectorSize: number;
  sectorsPerCluster: number;
  reserved: number;
  fatSectors: number;
  totalSectors: number;
  firstDataSector: number;
  clusterCount: number;
}

export function computeFat32Layout(volumeBytes: number, sectorSize: number, clusterSize: number): Fat32Layout {
  const reserved = 32;
  const numFats = 2;
  const sectorsPerCluster = clusterSize / sectorSize;
  if (!Number.isInteger(sectorsPerCluster) || sectorsPerCluster > 128 || (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0) {
    throw new Error('지원하지 않는 클러스터 크기입니다.');
  }
  const totalSectors = Math.floor(volumeBytes / sectorSize);
  if (totalSectors > 0xffffffff) throw new Error('FAT32 볼륨은 2TiB(512바이트 섹터 기준)를 넘을 수 없습니다.');
  // FAT 크기는 클러스터 수에 의존하고 그 반대도 성립하므로 수렴할 때까지 반복한다.
  // 위에서부터 줄여 가면 FAT가 모자라는 쪽으로 멈출 수 있으므로 아래에서부터 키워 간다.
  let fatSectors = 1;
  for (;;) {
    const clusters = Math.floor((totalSectors - reserved - numFats * fatSectors) / sectorsPerCluster);
    const need = Math.ceil(((clusters + 2) * 4) / sectorSize);
    if (need <= fatSectors) break;
    fatSectors = Math.max(fatSectors + 1, Math.floor((fatSectors + need) / 2));
  }
  const firstDataSector = reserved + numFats * fatSectors;
  const clusterCount = Math.floor((totalSectors - firstDataSector) / sectorsPerCluster);
  if (clusterCount < 65525) {
    throw new Error('볼륨이 작아 FAT32로 포맷할 수 없습니다. 클러스터 크기를 줄이거나 다른 파일시스템을 쓰세요.');
  }
  if (clusterCount > 0x0ffffff5) throw new Error('클러스터 수가 FAT32 한계를 넘습니다.');
  return { sectorSize, sectorsPerCluster, reserved, fatSectors, totalSectors, firstDataSector, clusterCount };
}

function buildBootSector(l: Fat32Layout, label: string, serial: number, hidden: number): Buffer {
  const b = Buffer.alloc(l.sectorSize);
  b[0] = 0xeb;
  b[1] = 0x58;
  b[2] = 0x90;
  b.write('MSDOS5.0', 3, 'latin1');
  b.writeUInt16LE(l.sectorSize, 11);
  b[13] = l.sectorsPerCluster;
  b.writeUInt16LE(l.reserved, 14);
  b[16] = 2;
  b[21] = 0xf8;
  b.writeUInt16LE(63, 24);
  b.writeUInt16LE(255, 26);
  b.writeUInt32LE(hidden, 28);
  b.writeUInt32LE(l.totalSectors, 32);
  b.writeUInt32LE(l.fatSectors, 36);
  b.writeUInt32LE(2, 44); // 루트 클러스터
  b.writeUInt16LE(1, 48); // FSInfo
  b.writeUInt16LE(6, 50); // 백업 부트
  b[64] = 0x80;
  b[66] = 0x29;
  b.writeUInt32LE(serial, 67);
  b.write(label.padEnd(11, ' '), 71, 'latin1');
  b.write('FAT32   ', 82, 'latin1');
  b.writeUInt16LE(0xaa55, 510);
  return b;
}

function buildFsInfo(l: Fat32Layout): Buffer {
  const b = Buffer.alloc(l.sectorSize);
  b.writeUInt32LE(0x41615252, 0);
  b.writeUInt32LE(0x61417272, 484);
  b.writeUInt32LE(l.clusterCount - 1, 488); // 빈 클러스터 수(루트 1개 제외)
  b.writeUInt32LE(3, 492);
  b.writeUInt32LE(0xaa550000, 508);
  return b;
}

export function sanitizeFatLabel(label: string): string {
  return label
    .toUpperCase()
    .replace(/[^A-Z0-9 _-]/g, '')
    .slice(0, 11);
}

/**
 * 장치 전체에 FAT32를 만든다. Windows는 32GB가 넘는 볼륨의 FAT32 포맷을 지원하지 않으므로
 * 그런 경우에 이 포맷터를 쓴다. dev는 파티션 슬라이스여야 한다.
 */
export async function formatFat32(dev: BlockDevice, opts: Fat32Options = {}, hiddenSectors = 0): Promise<Fat32Layout> {
  const clusterSize = opts.clusterSize ?? defaultFat32ClusterSize(dev.size);
  const l = computeFat32Layout(dev.size, dev.sectorSize, clusterSize);
  const label = sanitizeFatLabel(opts.label ?? '') || 'NO NAME';
  const serial = opts.serial ?? (Date.now() & 0xffffffff) >>> 0;
  const ss = l.sectorSize;

  // 쓰기 도중 실패해도 반쯤 유효한 볼륨으로 보이지 않도록 부트 섹터는 마지막에 쓴다.
  await dev.write(0, Buffer.alloc(ss));

  const zero = Buffer.alloc(4 * 1024 * 1024 - (4 * 1024 * 1024) % ss);
  const fatBytes = l.fatSectors * ss;
  const clusterBytes = l.sectorsPerCluster * ss;
  const totalWork = fatBytes * 2 + clusterBytes;
  let done = 0;
  for (let f = 0; f < 2; f++) {
    const start = (l.reserved + f * l.fatSectors) * ss;
    for (let pos = 0; pos < fatBytes; pos += zero.length) {
      throwIfAborted(opts.signal);
      const n = Math.min(zero.length, fatBytes - pos);
      await dev.write(start + pos, zero.subarray(0, n));
      done += n;
      opts.onProgress?.({ done, total: totalWork, message: `FAT ${f + 1} 초기화` });
      await yieldToLoop();
    }
    const head = Buffer.alloc(ss);
    head.writeUInt32LE(0x0ffffff8, 0);
    head.writeUInt32LE(0x0fffffff, 4);
    head.writeUInt32LE(0x0fffffff, 8); // 루트 디렉터리
    await dev.write(start, head);
  }

  const root = Buffer.alloc(clusterBytes);
  if (label !== 'NO NAME') {
    root.write(label.padEnd(11, ' '), 0, 'latin1');
    root[11] = 0x08;
  }
  await dev.write(l.firstDataSector * ss, root);

  const boot = buildBootSector(l, label, serial, hiddenSectors);
  const fsinfo = buildFsInfo(l);
  const third = Buffer.alloc(ss);
  third.writeUInt16LE(0xaa55, 510);
  await dev.write(6 * ss, boot);
  await dev.write(7 * ss, fsinfo);
  await dev.write(8 * ss, third);
  await dev.write(ss, fsinfo);
  await dev.write(2 * ss, third);
  await dev.write(0, boot);
  opts.onProgress?.({ done: totalWork, total: totalWork, message: '완료' });
  return l;
}
