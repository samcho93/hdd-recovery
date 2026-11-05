/** 64비트 리틀엔디언 정수를 JS number로 읽는다. 2^53을 넘으면 정밀도가 떨어진다(디스크 오프셋에는 충분). */
export function u64(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off) + buf.readUInt32LE(off + 4) * 0x100000000;
}

export function writeU64(buf: Buffer, off: number, value: number): void {
  buf.writeUInt32LE(value % 0x100000000 >>> 0, off);
  buf.writeUInt32LE(Math.floor(value / 0x100000000) >>> 0, off + 4);
}

export function ascii(buf: Buffer, off: number, len: number): string {
  return buf.toString('latin1', off, off + len);
}

/** Windows FILETIME(1601년 기준 100ns)을 epoch ms로 변환한다. 유효 범위를 벗어나면 null. */
export function filetimeToMs(buf: Buffer, off: number): number | null {
  const ft = u64(buf, off);
  if (ft === 0) return null;
  const ms = ft / 10000 - 11644473600000;
  if (ms < 0 || ms > 4102444800000) return null;
  return Math.round(ms);
}

/** FAT 날짜/시간을 epoch ms로 변환한다(로컬 시간). 잘못된 값이면 null. */
export function dosTimeToMs(date: number, time: number): number | null {
  const day = date & 0x1f;
  const month = (date >> 5) & 0x0f;
  const year = ((date >> 9) & 0x7f) + 1980;
  if (day < 1 || month < 1 || month > 12) return null;
  const sec = (time & 0x1f) * 2;
  const min = (time >> 5) & 0x3f;
  const hour = (time >> 11) & 0x1f;
  if (hour > 23 || min > 59 || sec > 59) return null;
  return new Date(year, month - 1, day, hour, min, sec).getTime();
}

let crcTable: Uint32Array | null = null;
export function crc32(buf: Buffer | Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function isAllZero(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

export class CancelledError extends Error {
  constructor() {
    super('작업이 취소되었습니다.');
    this.name = 'CancelledError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

/** 긴 CPU 루프 중간에 이벤트 루프를 양보한다. */
export function yieldToLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export interface ProgressInfo {
  done: number;
  total: number;
  message?: string;
}
export type ProgressFn = (p: ProgressInfo) => void;
