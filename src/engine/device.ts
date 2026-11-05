import { open, stat, type FileHandle } from 'node:fs/promises';

/**
 * 블록 장치 추상화. 물리 디스크(\\.\PhysicalDriveN), 이미지 파일, 파티션 슬라이스, 메모리 버퍼를
 * 같은 방식으로 다룬다. read는 불량 섹터가 있어도 실패하지 않고 해당 영역을 0으로 채워 반환한다.
 */
export interface BlockDevice {
  readonly size: number;
  readonly sectorSize: number;
  readonly writable: boolean;
  read(offset: number, length: number): Promise<Buffer>;
  write(offset: number, data: Buffer): Promise<void>;
  close(): Promise<void>;
  /** 지금까지 읽지 못한 섹터 수 */
  badSectorCount(): number;
  badRanges(): BadRange[];
}

export interface BadRange {
  offset: number;
  length: number;
}

const MAX_TRACKED_BAD_RANGES = 10000;

export class FileDevice implements BlockDevice {
  private bad: BadRange[] = [];
  private badCount = 0;

  private constructor(
    private handle: FileHandle,
    public readonly size: number,
    public readonly sectorSize: number,
    public readonly writable: boolean,
  ) {}

  /** 이미지 파일을 연다. 고정 VHD라면 끝의 512바이트 푸터를 디스크 크기에서 제외한다. */
  static async openImage(path: string, writable = false): Promise<FileDevice> {
    const st = await stat(path);
    const handle = await open(path, writable ? 'r+' : 'r');
    let size = st.size;
    if (size > 512) {
      const footer = Buffer.alloc(512);
      await handle.read(footer, 0, 512, size - 512);
      if (footer.toString('latin1', 0, 8) === 'conectix') size -= 512;
    }
    return new FileDevice(handle, size, 512, writable);
  }

  /** 물리 디스크를 연다. 크기는 Windows 쿼리로 미리 알아야 한다. */
  static async openPhysical(
    diskNumber: number,
    size: number,
    sectorSize: number,
    writable = false,
  ): Promise<FileDevice> {
    if (!Number.isInteger(diskNumber) || diskNumber < 0) throw new Error('잘못된 디스크 번호입니다.');
    const handle = await open(`\\\\.\\PhysicalDrive${diskNumber}`, writable ? 'r+' : 'r');
    return new FileDevice(handle, size, sectorSize, writable);
  }

  async read(offset: number, length: number): Promise<Buffer> {
    const out = Buffer.alloc(length);
    if (offset < 0 || length <= 0 || offset >= this.size) return out;
    const end = Math.min(offset + length, this.size);
    const ss = this.sectorSize;
    const alignedStart = offset - offset % ss;
    const alignedEnd = Math.min(Math.ceil(end / ss) * ss, this.size);
    if (alignedStart === offset && alignedEnd === end) {
      await this.readTolerant(offset, end - offset, out, 0);
      return out;
    }
    const tmp = Buffer.alloc(alignedEnd - alignedStart);
    await this.readTolerant(alignedStart, tmp.length, tmp, 0);
    tmp.copy(out, 0, offset - alignedStart, end - alignedStart);
    return out;
  }

  /** 오류가 나면 이분 탐색으로 불량 영역을 좁혀 정상 섹터는 최대한 살린다. */
  private async readTolerant(pos: number, len: number, out: Buffer, outOff: number): Promise<void> {
    try {
      let done = 0;
      while (done < len) {
        const { bytesRead } = await this.handle.read(out, outOff + done, len - done, pos + done);
        if (bytesRead === 0) throw new Error('EOF');
        done += bytesRead;
      }
    } catch {
      if (len <= this.sectorSize) {
        out.fill(0, outOff, outOff + len);
        this.noteBad(pos, len);
        return;
      }
      const half = Math.max(this.sectorSize, Math.floor(len / 2 / this.sectorSize) * this.sectorSize);
      await this.readTolerant(pos, half, out, outOff);
      await this.readTolerant(pos + half, len - half, out, outOff + half);
    }
  }

  private noteBad(offset: number, length: number): void {
    this.badCount += Math.ceil(length / this.sectorSize);
    const last = this.bad[this.bad.length - 1];
    if (last && last.offset + last.length === offset) {
      last.length += length;
    } else if (this.bad.length < MAX_TRACKED_BAD_RANGES) {
      this.bad.push({ offset, length });
    }
  }

  async write(offset: number, data: Buffer): Promise<void> {
    if (!this.writable) throw new Error('읽기 전용으로 열린 장치입니다.');
    if (offset % this.sectorSize !== 0 || data.length % this.sectorSize !== 0) {
      throw new Error('쓰기는 섹터 단위로 정렬되어야 합니다.');
    }
    if (offset < 0 || offset + data.length > this.size) throw new Error('장치 범위를 벗어난 쓰기입니다.');
    let done = 0;
    while (done < data.length) {
      const { bytesWritten } = await this.handle.write(data, done, data.length - done, offset + done);
      if (bytesWritten === 0) throw new Error('장치에 쓸 수 없습니다.');
      done += bytesWritten;
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  badSectorCount(): number {
    return this.badCount;
  }

  badRanges(): BadRange[] {
    return this.bad;
  }
}

/** 장치의 일부 구간(파티션)을 독립 장치처럼 보여준다. close해도 원본은 닫지 않는다. */
export class SliceDevice implements BlockDevice {
  public readonly sectorSize: number;
  public readonly writable: boolean;

  constructor(
    private base: BlockDevice,
    public readonly start: number,
    public readonly size: number,
  ) {
    this.sectorSize = base.sectorSize;
    this.writable = base.writable;
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (offset >= this.size || offset < 0) return Buffer.alloc(length);
    const avail = Math.min(length, this.size - offset);
    const data = await this.base.read(this.start + offset, avail);
    if (avail === length) return data;
    const out = Buffer.alloc(length);
    data.copy(out);
    return out;
  }

  async write(offset: number, data: Buffer): Promise<void> {
    if (offset < 0 || offset + data.length > this.size) throw new Error('파티션 범위를 벗어난 쓰기입니다.');
    await this.base.write(this.start + offset, data);
  }

  async close(): Promise<void> {}

  badSectorCount(): number {
    return this.base.badSectorCount();
  }

  badRanges(): BadRange[] {
    return this.base.badRanges();
  }
}

/** 테스트용 메모리 장치. badSectors에 지정한 섹터는 읽기 시 0으로 나온다. */
export class MemoryDevice implements BlockDevice {
  public readonly writable = true;
  public readonly size: number;
  private bad: BadRange[] = [];

  constructor(
    public buffer: Buffer,
    public readonly sectorSize = 512,
    private badSectors: Set<number> = new Set(),
  ) {
    this.size = buffer.length;
  }

  async read(offset: number, length: number): Promise<Buffer> {
    const out = Buffer.alloc(length);
    if (offset >= this.size) return out;
    this.buffer.copy(out, 0, offset, Math.min(offset + length, this.size));
    if (this.badSectors.size) {
      const first = Math.floor(offset / this.sectorSize);
      const last = Math.floor((offset + length - 1) / this.sectorSize);
      for (let s = first; s <= last; s++) {
        if (!this.badSectors.has(s)) continue;
        const from = Math.max(s * this.sectorSize, offset) - offset;
        const to = Math.min((s + 1) * this.sectorSize, offset + length) - offset;
        out.fill(0, from, to);
        this.bad.push({ offset: s * this.sectorSize, length: this.sectorSize });
      }
    }
    return out;
  }

  async write(offset: number, data: Buffer): Promise<void> {
    if (offset + data.length > this.size) throw new Error('범위를 벗어난 쓰기');
    data.copy(this.buffer, offset);
  }

  async close(): Promise<void> {}

  badSectorCount(): number {
    return this.bad.length;
  }

  badRanges(): BadRange[] {
    return this.bad;
  }
}
