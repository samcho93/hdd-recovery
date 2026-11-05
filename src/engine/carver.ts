import { throwIfAborted, u64, yieldToLoop } from './bytes';
import type { BlockDevice } from './device';
import { BaseVolume, ROOT_ID, makeDir, type ChunkSink, type FsEntry, type ReadResult, type ScanOptions } from './volume';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** 앞에서부터 순서대로 스트림을 읽어 size를 찾아내는 도우미 */
class Reader {
  private cache: Buffer = Buffer.alloc(0);
  private cacheStart = -1;
  constructor(
    private dev: BlockDevice,
    private base: number,
  ) {}

  get available(): number {
    return this.dev.size - this.base;
  }

  async bytes(off: number, len: number): Promise<Buffer> {
    if (this.cacheStart < 0 || off < this.cacheStart || off + len > this.cacheStart + this.cache.length) {
      const readLen = Math.max(len, MB);
      this.cache = await this.dev.read(this.base + off, readLen);
      this.cacheStart = off;
    }
    return this.cache.subarray(off - this.cacheStart, off - this.cacheStart + len);
  }

  /** needle을 찾아 위치를 돌려준다. 없으면 -1 */
  async find(needle: Buffer, from: number, max: number): Promise<number> {
    const step = 4 * MB;
    for (let pos = from; pos < max; pos += step) {
      const len = Math.min(step + needle.length, max - pos);
      if (len < needle.length) break;
      const buf = await this.dev.read(this.base + pos, len);
      const idx = buf.indexOf(needle);
      if (idx >= 0) return pos + idx;
      await yieldToLoop();
    }
    return -1;
  }
}

export interface CarveHit {
  size: number;
  ext: string;
}

type Measure = (r: Reader, head: Buffer) => Promise<CarveHit | null>;

interface Signature {
  label: string;
  group: string;
  test: (b: Buffer) => boolean;
  measure: Measure;
}

const measureJpeg: Measure = async (r) => {
  // 세그먼트를 따라가 썸네일의 EOI에 속지 않게 SOS까지 간 뒤 EOI를 찾는다.
  let p = 2;
  for (let guard = 0; guard < 256; guard++) {
    const h = await r.bytes(p, 4);
    if (h[0] !== 0xff) return null;
    const marker = h[1];
    if (marker === 0xda) break;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00) return null;
    const segLen = h.readUInt16BE(2);
    if (segLen < 2) return null;
    p += 2 + segLen;
    if (p > 32 * MB) return null;
  }
  const end = await r.find(Buffer.from([0xff, 0xd9]), p, Math.min(r.available, 256 * MB));
  return end < 0 ? null : { size: end + 2, ext: 'jpg' };
};

const measurePng: Measure = async (r) => {
  let p = 8;
  for (let guard = 0; guard < 1000000; guard++) {
    const h = await r.bytes(p, 8);
    const len = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (!/^[A-Za-z]{4}$/.test(type) || len > 512 * MB) return null;
    p += 12 + len;
    if (type === 'IEND') return { size: p, ext: 'png' };
    if (p > r.available) return null;
    if (guard % 1000 === 999) await yieldToLoop();
  }
  return null;
};

const measureGif: Measure = async (r) => {
  const h = await r.bytes(0, 13);
  let p = 13;
  if (h[10] & 0x80) p += 3 * (1 << ((h[10] & 7) + 1));
  const skipSub = async (): Promise<void> => {
    for (;;) {
      const n = (await r.bytes(p, 1))[0];
      p += 1 + n;
      if (n === 0 || p > 256 * MB) return;
    }
  };
  for (let guard = 0; guard < 200000; guard++) {
    const t = (await r.bytes(p, 1))[0];
    if (t === 0x3b) return { size: p + 1, ext: 'gif' };
    if (t === 0x21) {
      p += 2;
      await skipSub();
    } else if (t === 0x2c) {
      const d = await r.bytes(p, 10);
      p += 10;
      if (d[9] & 0x80) p += 3 * (1 << ((d[9] & 7) + 1));
      p += 1;
      await skipSub();
    } else {
      return null;
    }
    if (p > 256 * MB) return null;
  }
  return null;
};

const measureBmp: Measure = async (r, head) => {
  const size = head.readUInt32LE(2);
  const dib = head.readUInt32LE(14);
  const dataOff = head.readUInt32LE(10);
  if (head.readUInt32LE(6) !== 0 || ![12, 40, 52, 56, 108, 124].includes(dib)) return null;
  if (size < 54 || size > 512 * MB || dataOff >= size) return null;
  return size <= r.available ? { size, ext: 'bmp' } : null;
};

const measurePdf: Measure = async (r) => {
  const needle = Buffer.from('%%EOF');
  const max = Math.min(r.available, 1 * GB);
  let last = await r.find(needle, 0, max);
  if (last < 0) return null;
  // 증분 저장된 PDF는 %%EOF가 여러 개다. 가까운 뒤쪽 것까지 따라간다.
  for (let i = 0; i < 64; i++) {
    const next = await r.find(needle, last + 5, Math.min(last + 4 * MB, max));
    if (next < 0) break;
    last = next;
  }
  return { size: last + 5, ext: 'pdf' };
};

const measureZip: Measure = async (r, head) => {
  const eocd = await r.find(Buffer.from([0x50, 0x4b, 0x05, 0x06]), 30, Math.min(r.available, 4 * GB));
  if (eocd < 0) return null;
  const tail = await r.bytes(eocd, 22);
  const size = eocd + 22 + tail.readUInt16LE(20);
  // Office/한컴 문서 구분
  const nameLen = head.readUInt16LE(26);
  const firstName = head.toString('latin1', 30, 30 + nameLen);
  let ext = 'zip';
  const sample = (await r.bytes(Math.max(0, eocd - 4096), Math.min(eocd, 4096))).toString('latin1');
  if (sample.includes('word/') || firstName.startsWith('word/')) ext = 'docx';
  else if (sample.includes('xl/') || firstName.startsWith('xl/')) ext = 'xlsx';
  else if (sample.includes('ppt/') || firstName.startsWith('ppt/')) ext = 'pptx';
  else if (firstName === 'mimetypeapplication/hwp+zip' || sample.includes('Contents/section')) ext = 'hwpx';
  return { size, ext };
};

const measureRiff: Measure = async (r, head) => {
  const size = head.readUInt32LE(4) + 8;
  const kind = head.toString('latin1', 8, 12);
  const ext = kind === 'WAVE' ? 'wav' : kind === 'AVI ' ? 'avi' : kind === 'WEBP' ? 'webp' : null;
  if (!ext || size < 44 || size > r.available) return null;
  return { size, ext };
};

const MP4_ATOMS = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'uuid', 'meta', 'moof', 'mfra', 'styp', 'sidx', 'pnot', 'PICT', 'junk']);
const measureMp4: Measure = async (r, head) => {
  const brand = head.toString('latin1', 8, 12);
  let p = 0;
  let sawMedia = false;
  for (let guard = 0; guard < 100000; guard++) {
    if (p + 8 > r.available) break;
    const h = await r.bytes(p, 16);
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (!MP4_ATOMS.has(type)) break;
    if (size === 1) size = h.readUInt32BE(8) * 0x100000000 + h.readUInt32BE(12);
    else if (size === 0) break;
    if (size < 8) break;
    if (type === 'moov' || type === 'mdat') sawMedia = true;
    p += size;
  }
  if (!sawMedia || p <= 32) return null;
  const ext = brand.startsWith('qt') ? 'mov' : brand.startsWith('M4A') ? 'm4a' : brand.startsWith('3g') ? '3gp' : 'mp4';
  return { size: Math.min(p, r.available), ext };
};

const measureSqlite: Measure = async (r, head) => {
  const raw = head.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  const pages = head.readUInt32BE(28);
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0 || pages === 0) return null;
  const size = pageSize * pages;
  return size <= r.available ? { size, ext: 'sqlite' } : null;
};

const measure7z: Measure = async (r, head) => {
  const off = u64(head, 12);
  const len = u64(head, 20);
  const size = 32 + off + len;
  if (len === 0 || size > r.available) return null;
  return { size, ext: '7z' };
};

const measureOle: Measure = async (r, head) => {
  const shift = head.readUInt16LE(30);
  if (shift !== 9 && shift !== 12) return null;
  const sector = 1 << shift;
  const fatSectors = head.readUInt32LE(44);
  if (fatSectors === 0 || fatSectors > 1 << 20) return null;
  // FAT 섹터 수에서 구한 상한값. 실제 파일 끝에는 여유 영역이 조금 붙을 수 있다.
  const upper = Math.min((fatSectors * (sector / 4) + 1) * sector, r.available);
  const sample = (await r.bytes(0, Math.min(upper, 1 * MB))).toString('utf16le');
  let ext = 'ole';
  if (sample.includes('HwpSummaryInformation') || sample.includes('FileHeader')) ext = 'hwp';
  else if (sample.includes('WordDocument')) ext = 'doc';
  else if (sample.includes('Workbook') || sample.includes('Book')) ext = 'xls';
  else if (sample.includes('PowerPoint Document')) ext = 'ppt';
  return { size: upper, ext };
};

const eq = (b: Buffer, sig: number[], off = 0): boolean => sig.every((v, i) => b[off + i] === v);

export const SIGNATURES: Signature[] = [
  { label: 'JPEG', group: '사진', test: (b) => eq(b, [0xff, 0xd8, 0xff]), measure: measureJpeg },
  { label: 'PNG', group: '사진', test: (b) => eq(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), measure: measurePng },
  { label: 'GIF', group: '사진', test: (b) => b.toString('latin1', 0, 6) === 'GIF89a' || b.toString('latin1', 0, 6) === 'GIF87a', measure: measureGif },
  { label: 'BMP', group: '사진', test: (b) => eq(b, [0x42, 0x4d]), measure: measureBmp },
  { label: 'PDF', group: '문서', test: (b) => b.toString('latin1', 0, 5) === '%PDF-', measure: measurePdf },
  { label: 'ZIP/Office', group: '문서', test: (b) => eq(b, [0x50, 0x4b, 0x03, 0x04]), measure: measureZip },
  { label: 'HWP/DOC', group: '문서', test: (b) => eq(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), measure: measureOle },
  { label: 'SQLite', group: '기타', test: (b) => b.toString('latin1', 0, 15) === 'SQLite format 3', measure: measureSqlite },
  { label: '7z', group: '기타', test: (b) => eq(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), measure: measure7z },
  { label: 'RIFF', group: '영상/음성', test: (b) => b.toString('latin1', 0, 4) === 'RIFF', measure: measureRiff },
  { label: 'MP4/MOV', group: '영상/음성', test: (b) => b.toString('latin1', 4, 8) === 'ftyp', measure: measureMp4 },
];

/**
 * 파일시스템 없이 파일 서명만으로 파일을 찾아낸다. 파일명과 폴더 구조는 복구되지 않는다.
 * 찾은 파일은 확장자별 가상 폴더에 놓인다.
 */
export class CarveVolume extends BaseVolume {
  readonly fsType = '서명 스캔';
  private nextId = 2;
  private dirs = new Map<string, number>();
  private counters = new Map<string, number>();

  constructor(
    private dev: BlockDevice,
    private types?: string[],
  ) {
    super();
  }

  override async scan(opts: ScanOptions = {}): Promise<void> {
    this.resetEntries();
    this.dirs.clear();
    this.counters.clear();
    this.nextId = 2;
    const sigs = SIGNATURES.filter((s) => !this.types || this.types.includes(s.label));
    const ss = this.dev.sectorSize;
    const chunk = 8 * MB;
    let found = 0;
    let pos = 0;
    while (pos < this.dev.size) {
      throwIfAborted(opts.signal);
      const len = Math.min(chunk, this.dev.size - pos);
      const buf = await this.dev.read(pos, len);
      let skipTo = pos;
      for (let p = 0; p + 64 <= len; p += ss) {
        const abs = pos + p;
        if (abs < skipTo) continue;
        const b0 = buf[p];
        // 빠른 사전 필터: 자주 비어 있는 섹터는 건너뛴다.
        if (b0 === 0 && buf[p + 4] !== 0x66) continue;
        const head = buf.subarray(p, Math.min(p + 512, len));
        const sig = sigs.find((s) => s.test(head));
        if (!sig) continue;
        let hit: CarveHit | null = null;
        try {
          hit = await sig.measure(new Reader(this.dev, abs), head);
        } catch {
          hit = null;
        }
        if (!hit || hit.size < 64) continue;
        found++;
        this.addCarved(hit, abs);
        skipTo = abs + Math.ceil(hit.size / ss) * ss;
        throwIfAborted(opts.signal);
      }
      pos = Math.max(pos + len, skipTo);
      opts.onProgress?.({ done: Math.min(pos, this.dev.size), total: this.dev.size, message: `서명 스캔: 파일 ${found.toLocaleString()}개 발견` });
      await yieldToLoop();
    }
  }

  private addCarved(hit: CarveHit, offset: number): void {
    let dir = this.dirs.get(hit.ext);
    if (dir === undefined) {
      dir = this.nextId++;
      this.dirs.set(hit.ext, dir);
      this.addEntry(makeDir(dir, ROOT_ID, hit.ext.toUpperCase()));
    }
    const n = (this.counters.get(hit.ext) ?? 0) + 1;
    this.counters.set(hit.ext, n);
    this.addEntry({
      id: this.nextId++,
      parentId: dir,
      name: `${hit.ext}_${String(n).padStart(6, '0')}.${hit.ext}`,
      isDir: false,
      size: hit.size,
      deleted: false,
      mtime: null,
      ctime: null,
      flags: 0,
      ref: [offset],
    });
  }

  override async readEntry(entry: FsEntry, sink: ChunkSink, signal?: AbortSignal): Promise<ReadResult> {
    let written = 0;
    const step = 4 * MB;
    while (written < entry.size) {
      throwIfAborted(signal);
      const n = Math.min(step, entry.size - written);
      await sink(await this.dev.read(entry.ref[0] + written, n));
      written += n;
    }
    return { bytes: written, warnings: [] };
  }
}
