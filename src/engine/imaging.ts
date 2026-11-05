import { open, writeFile } from 'node:fs/promises';
import { throwIfAborted, yieldToLoop, type ProgressFn } from './bytes';
import type { BadRange, BlockDevice } from './device';

export interface ImagingResult {
  bytes: number;
  badSectors: number;
  badRanges: BadRange[];
  mapPath: string;
  elapsedMs: number;
}

/**
 * 디스크 전체를 이미지 파일로 복제한다. 읽지 못한 섹터는 0으로 채우고 위치를 .badmap.json에 남긴다.
 * 고장 중인 디스크는 복구 시도마다 상태가 나빠질 수 있으므로 먼저 이미지를 뜨고 이미지에서 복구하는 것이 안전하다.
 */
export async function createDiskImage(
  dev: BlockDevice,
  destPath: string,
  opts: { signal?: AbortSignal; onProgress?: ProgressFn } = {},
): Promise<ImagingResult> {
  const started = Date.now();
  const startBad = dev.badSectorCount();
  const handle = await open(destPath, 'wx');
  const chunk = 4 * 1024 * 1024 - (4 * 1024 * 1024) % dev.sectorSize;
  let pos = 0;
  try {
    while (pos < dev.size) {
      throwIfAborted(opts.signal);
      const len = Math.min(chunk, dev.size - pos);
      const data = await dev.read(pos, len);
      let w = 0;
      while (w < len) {
        const { bytesWritten } = await handle.write(data, w, len - w, pos + w);
        w += bytesWritten;
      }
      pos += len;
      const bad = dev.badSectorCount() - startBad;
      opts.onProgress?.({
        done: pos,
        total: dev.size,
        message: bad ? `읽기 실패 섹터 ${bad.toLocaleString()}개 (0으로 채움)` : '이미지 생성 중',
      });
      await yieldToLoop();
    }
  } finally {
    await handle.close();
  }
  const mapPath = `${destPath}.badmap.json`;
  const badRanges = dev.badRanges();
  await writeFile(mapPath, JSON.stringify({ size: dev.size, sectorSize: dev.sectorSize, badRanges }, null, 2));
  return {
    bytes: pos,
    badSectors: dev.badSectorCount() - startBad,
    badRanges,
    mapPath,
    elapsedMs: Date.now() - started,
  };
}
