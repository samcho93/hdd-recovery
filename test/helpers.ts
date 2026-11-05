import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { RecoveryVolume, FsEntry } from '../src/engine/volume';

const dir = join(__dirname, 'fixtures');

export interface FixtureFile {
  path: string;
  sha256: string;
  size: number;
  kind: 'active' | 'deleted';
}
export interface FixtureVolume {
  fs: string;
  offset: number;
  size: number;
  bulkCount: number;
  files: FixtureFile[];
}
export type Manifest = Record<'ntfs' | 'exfat' | 'fat32', FixtureVolume>;

export const manifest: Manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, ''));

let cached: Buffer | null = null;
/** 고정 VHD 푸터(512바이트)를 뺀 디스크 내용의 복사본 */
export function loadDisk(): Buffer {
  if (!cached) {
    const raw = gunzipSync(readFileSync(join(dir, 'disk.vhd.gz')));
    cached = raw.subarray(0, raw.length - 512);
  }
  return Buffer.from(cached);
}

export function findByPath(vol: RecoveryVolume, path: string): FsEntry | undefined {
  const parts = path.split('\\');
  let cur = 0;
  let entry: FsEntry | undefined;
  for (const part of parts) {
    entry = vol.childrenOf(cur).find((c) => c.name.toLowerCase() === part.toLowerCase());
    if (!entry) return undefined;
    cur = entry.id;
  }
  return entry;
}

export async function sha256Of(vol: RecoveryVolume, e: FsEntry): Promise<{ hash: string; warnings: string[]; bytes: number }> {
  const h = createHash('sha256');
  const res = await vol.readEntry(e, async (c) => {
    h.update(c);
  });
  return { hash: h.digest('hex'), warnings: res.warnings, bytes: res.bytes };
}
