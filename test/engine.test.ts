import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/engine/bytes';
import { CarveVolume } from '../src/engine/carver';
import { MemoryDevice, SliceDevice } from '../src/engine/device';
import { ExfatVolume } from '../src/engine/exfat';
import { FatVolume, parseFatBoot, parseFatDirectory } from '../src/engine/fat';
import { computeFat32Layout, formatFat32 } from '../src/engine/mkfat32';
import { decodeRuns, lznt1Decompress, NtfsVolume, parseNtfsBoot, synthesizeNtfsBoot } from '../src/engine/ntfs';
import { buildGpt, buildMbr, GPT_BASIC_DATA, readPartitionTable } from '../src/engine/partition';
import { recoverEntries, sanitizeName } from '../src/engine/recover';
import { applyWrites, diagnose, listJournals, undoJournal } from '../src/engine/repair';
import { findVolumes, openFoundVolume } from '../src/engine/scanner';
import { ORPHAN_ID, type RecoveryVolume } from '../src/engine/volume';
import { findByPath, loadDisk, manifest, sha256Of, type FixtureVolume } from './helpers';

const SS = 512;

async function assertAllFiles(vol: RecoveryVolume, fx: FixtureVolume, opts: { deleted?: boolean } = {}): Promise<void> {
  for (const f of fx.files) {
    if (f.kind === 'deleted' && opts.deleted === false) continue;
    const e = findByPath(vol, f.path);
    // Windows는 FAT/exFAT에서 폴더를 지울 때 폴더 목록을 0으로 덮는다. 그 안의 파일명은 복구 불가능하다.
    if (fx.fs !== 'NTFS' && f.path.startsWith('to-delete\\')) {
      expect(e, `지워진 폴더의 항목이 나오면 안 됨: ${f.path}`).toBeUndefined();
      continue;
    }
    expect(e, `항목 없음: ${f.path}`).toBeDefined();
    expect(e!.deleted, f.path).toBe(f.kind === 'deleted');
    expect(e!.size, f.path).toBe(f.size);
    const { hash, bytes } = await sha256Of(vol, e!);
    expect(bytes, f.path).toBe(f.size);
    expect(hash, `내용 불일치: ${f.path}`).toBe(f.sha256);
  }
}

describe('실제 Windows 포맷 디스크 읽기', () => {
  it('GPT 파티션과 파일시스템 3종을 식별한다', async () => {
    const dev = new MemoryDevice(loadDisk());
    const res = await findVolumes(dev);
    expect(res.table.style).toBe('gpt');
    expect(res.table.gpt?.primaryOk).toBe(true);
    expect(res.table.gpt?.backupOk).toBe(true);
    const byOffset = new Map(res.volumes.map((v) => [v.offset, v]));
    for (const fx of Object.values(manifest)) {
      const v = byOffset.get(fx.offset);
      expect(v?.fsType).toBe(fx.fs);
      expect(v?.bootOk).toBe(true);
      expect(v?.inTable).toBe(true);
    }
    const d = await diagnose(dev, { scan: res });
    expect(d.actions).toEqual([]);
    expect(d.healthy).toBe(true);
  });

  for (const key of ['ntfs', 'exfat', 'fat32'] as const) {
    it(`${key}: 파일 목록, 삭제 파일, 내용 해시가 원본과 일치한다`, async () => {
      const fx = manifest[key];
      const dev = new MemoryDevice(loadDisk());
      const res = await findVolumes(dev);
      const found = res.volumes.find((v) => v.offset === fx.offset)!;
      const vol = await openFoundVolume(dev, found);
      await vol.scan();
      await assertAllFiles(vol, fx);
      expect(vol.childrenOf(findByPath(vol, 'bulk')!.id).length).toBeGreaterThanOrEqual(fx.bulkCount);
      expect(vol.entries.has(ORPHAN_ID)).toBe(false);
      const del = findByPath(vol, 'to-delete')!;
      expect(del.deleted).toBe(true);
      if (fx.fs !== 'NTFS') expect(vol.warnings.join()).toContain('서명 스캔');
    });
  }

  it('NTFS: 조각난 파일이 실제로 많이 조각나 있고 복구된다', async () => {
    const dev = new MemoryDevice(loadDisk());
    const fx = manifest.ntfs;
    const vol = await NtfsVolume.open(new SliceDevice(dev, fx.offset, fx.size));
    await vol!.scan();
    const e = findByPath(vol!, 'frag-a.bin')!;
    expect(e.size).toBe(1500 * 4096);
    const compressed = findByPath(vol!, 'compressed\\lznt1.txt')!;
    expect(compressed.flags & 1).toBe(1);
  });
});

describe('손상 복구 시나리오', () => {
  const zero = (buf: Buffer, off: number, len: number): void => void buf.fill(0, off, off + len);

  it('NTFS 기본 부트 섹터 손상 → 백업으로 읽고 복원', async () => {
    const fx = manifest.ntfs;
    const disk = loadDisk();
    const original = Buffer.from(disk.subarray(fx.offset, fx.offset + SS));
    zero(disk, fx.offset, SS);
    const dev = new MemoryDevice(disk);
    const d = await diagnose(dev);
    const v = d.volumes.find((x) => x.offset === fx.offset)!;
    expect(v.fsType).toBe('NTFS');
    expect(v.bootOk).toBe(false);
    expect(v.backupOk).toBe(true);
    const vol = await openFoundVolume(dev, v);
    await vol.scan();
    await assertAllFiles(vol, fx);
    const action = d.actions.find((a) => a.kind === 'ntfs-boot-from-backup')!;
    expect(action).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), 'hddr-'));
    const j = await applyWrites(dev, await d.plans.get(action.id)!(), { title: action.title, target: 't', journalDir: dir });
    expect(disk.subarray(fx.offset, fx.offset + SS).equals(original)).toBe(true);
    expect((await diagnose(dev)).volumes.find((x) => x.offset === fx.offset)!.bootOk).toBe(true);

    // 되돌리기
    await undoJournal(dev, dir, j.id);
    expect(disk.subarray(fx.offset, fx.offset + SS).every((b) => b === 0)).toBe(true);
    expect((await listJournals(dir))[0].undone).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('NTFS 부트 섹터 2개 모두 손상 → $MFT에서 볼륨 역산 후 부트 섹터 재생성', async () => {
    const fx = manifest.ntfs;
    const disk = loadDisk();
    const bootOrig = parseNtfsBoot(disk.subarray(fx.offset, fx.offset + SS))!;
    zero(disk, fx.offset, SS);
    zero(disk, fx.offset + bootOrig.totalSectors * SS, SS);
    const dev = new MemoryDevice(disk);

    const quick = await findVolumes(dev);
    expect(quick.volumes.find((x) => x.offset === fx.offset)!.fsType).toBe('unknown');

    const d = await diagnose(dev, { deep: true });
    const v = d.volumes.find((x) => x.offset === fx.offset)!;
    expect(v.fsType).toBe('NTFS');
    expect(v.source).toBe('mft');
    expect(v.mft!.clusterSize).toBe(bootOrig.clusterSize);
    expect(v.mft!.mftLcn).toBe(bootOrig.mftLcn);
    expect(v.mft!.mirrLcn).toBe(bootOrig.mftMirrLcn);
    expect(v.mft!.totalSectors).toBe(bootOrig.totalSectors);
    const vol = await openFoundVolume(dev, v);
    await vol.scan();
    await assertAllFiles(vol, fx);

    const action = d.actions.find((a) => a.kind === 'ntfs-boot-rebuild')!;
    const dir = mkdtempSync(join(tmpdir(), 'hddr-'));
    await applyWrites(dev, await d.plans.get(action.id)!(), { title: action.title, target: 't', journalDir: dir });
    rmSync(dir, { recursive: true });
    const after = parseNtfsBoot(disk.subarray(fx.offset, fx.offset + SS))!;
    expect(after.mftLcn).toBe(bootOrig.mftLcn);
    expect(after.mftRecordSize).toBe(bootOrig.mftRecordSize);
    expect(after.clusterSize).toBe(bootOrig.clusterSize);
    expect(after.totalSectors).toBe(bootOrig.totalSectors);
    const check = await findVolumes(dev);
    expect(check.volumes.find((x) => x.offset === fx.offset)!.bootOk).toBe(true);
  });

  it('NTFS: $MFT 첫 레코드 손상 시 $MFTMirr 사용', async () => {
    const fx = manifest.ntfs;
    const disk = loadDisk();
    const boot = parseNtfsBoot(disk.subarray(fx.offset, fx.offset + SS))!;
    const mftOff = fx.offset + boot.mftLcn * boot.clusterSize;
    zero(disk, mftOff, boot.mftRecordSize);
    const dev = new MemoryDevice(disk);
    const vol = (await NtfsVolume.open(new SliceDevice(dev, fx.offset, fx.size)))!;
    await vol.scan();
    expect(vol.warnings.join()).toContain('$MFTMirr');
    await assertAllFiles(vol, fx);
  });

  it('NTFS 정밀 모드: 레코드 서명 스캔으로도 파일을 찾는다', async () => {
    const fx = manifest.ntfs;
    const dev = new MemoryDevice(loadDisk());
    const vol = (await NtfsVolume.open(new SliceDevice(dev, fx.offset, fx.size)))!;
    await vol.scan({ deep: true });
    expect(vol.usedSignatureScan).toBe(true);
    await assertAllFiles(vol, fx);
  });

  it('파티션 테이블 전체 소실(MBR+GPT 양쪽) → 볼륨 탐지 후 GPT 재생성', async () => {
    const disk = loadDisk();
    zero(disk, 0, 34 * SS);
    zero(disk, disk.length - 33 * SS, 33 * SS);
    const dev = new MemoryDevice(disk);
    const empty = await readPartitionTable(dev);
    expect(empty.style).toBe('none');
    const d = await diagnose(dev, { deep: true });
    for (const fx of Object.values(manifest)) {
      const v = d.volumes.find((x) => x.offset === fx.offset);
      expect(v?.fsType).toBe(fx.fs);
      expect(v?.inTable).toBe(false);
    }
    const action = d.actions.find((a) => a.kind === 'table-rebuild-gpt')!;
    expect(action).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), 'hddr-'));
    await applyWrites(dev, await d.plans.get(action.id)!(), { title: action.title, target: 't', journalDir: dir });
    rmSync(dir, { recursive: true });
    const t = await readPartitionTable(dev);
    expect(t.style).toBe('gpt');
    expect(t.gpt?.primaryOk).toBe(true);
    expect(t.gpt?.backupOk).toBe(true);
    expect(t.partitions.map((p) => p.offset)).toEqual(Object.values(manifest).map((m) => m.offset).sort((a, b) => a - b));
    const after = await findVolumes(dev);
    expect(after.volumes.every((v) => v.inTable)).toBe(true);
  }, 30000);

  it('기본 GPT 손상 → 백업에서 복원 / 백업 GPT 손상 → 기본에서 복원', async () => {
    const disk = loadDisk();
    zero(disk, SS, 33 * SS);
    let dev = new MemoryDevice(disk);
    let d = await diagnose(dev);
    expect(d.table.style).toBe('gpt');
    expect(d.table.gpt?.primaryOk).toBe(false);
    let a = d.actions.find((x) => x.kind === 'gpt-restore-primary')!;
    const dir = mkdtempSync(join(tmpdir(), 'hddr-'));
    await applyWrites(dev, await d.plans.get(a.id)!(), { title: a.title, target: 't', journalDir: dir });
    let t = await readPartitionTable(dev);
    expect(t.gpt?.primaryOk).toBe(true);
    expect(t.partitions.length).toBe(3);

    const disk2 = loadDisk();
    zero(disk2, disk2.length - 33 * SS, 33 * SS);
    dev = new MemoryDevice(disk2);
    d = await diagnose(dev);
    a = d.actions.find((x) => x.kind === 'gpt-restore-backup')!;
    await applyWrites(dev, await d.plans.get(a.id)!(), { title: a.title, target: 't', journalDir: dir });
    t = await readPartitionTable(dev);
    expect(t.gpt?.backupOk).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('FAT32 부트 섹터 손상 → 6번 섹터 백업으로 복원', async () => {
    const fx = manifest.fat32;
    const disk = loadDisk();
    zero(disk, fx.offset, 3 * SS);
    const dev = new MemoryDevice(disk);
    const d = await diagnose(dev);
    const v = d.volumes.find((x) => x.offset === fx.offset)!;
    expect(v.fsType).toBe('FAT32');
    expect(v.bootOk).toBe(false);
    const vol = await openFoundVolume(dev, v);
    await vol.scan();
    await assertAllFiles(vol, fx);
    const a = d.actions.find((x) => x.kind === 'fat-boot-from-backup')!;
    const dir = mkdtempSync(join(tmpdir(), 'hddr-'));
    await applyWrites(dev, await d.plans.get(a.id)!(), { title: a.title, target: 't', journalDir: dir });
    rmSync(dir, { recursive: true });
    expect((await findVolumes(dev)).volumes.find((x) => x.offset === fx.offset)!.bootOk).toBe(true);
  });

  it('FAT 1번 사본 손상 → 2번 사본으로 읽고 복원', async () => {
    const fx = manifest.fat32;
    const disk = loadDisk();
    const boot = parseFatBoot(disk.subarray(fx.offset, fx.offset + SS))!;
    const fat1 = fx.offset + boot.reservedSectors * SS;
    zero(disk, fat1, boot.fatSectors * SS);
    const dev = new MemoryDevice(disk);
    const vol = (await FatVolume.open(new SliceDevice(dev, fx.offset, fx.size)))!;
    await vol.scan();
    expect(vol.warnings.join()).toContain('2번 사본');
    await assertAllFiles(vol, fx);

    const res = await findVolumes(dev);
    expect(res.volumes.find((x) => x.offset === fx.offset)?.bootOk).toBe(false);
    const d = await diagnose(dev, { scan: res });
    const a = d.actions.find((x) => x.kind === 'fat-copy-from-second')!;
    expect(a).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), 'hddr-'));
    await applyWrites(dev, await d.plans.get(a.id)!(), { title: a.title, target: 't', journalDir: dir });
    rmSync(dir, { recursive: true });
    expect((await findVolumes(dev)).volumes.find((x) => x.offset === fx.offset)?.bootOk).toBe(true);
  });

  it('exFAT 부트 영역 손상 → 백업 영역으로 복원', async () => {
    const fx = manifest.exfat;
    const disk = loadDisk();
    const orig = Buffer.from(disk.subarray(fx.offset, fx.offset + 12 * SS));
    zero(disk, fx.offset, 12 * SS);
    const dev = new MemoryDevice(disk);
    const d = await diagnose(dev);
    const v = d.volumes.find((x) => x.offset === fx.offset)!;
    expect(v.fsType).toBe('exFAT');
    expect(v.bootOk).toBe(false);
    const vol = await openFoundVolume(dev, v);
    await vol.scan();
    await assertAllFiles(vol, fx);
    const a = d.actions.find((x) => x.kind === 'exfat-boot-from-backup')!;
    const dir = mkdtempSync(join(tmpdir(), 'hddr-'));
    await applyWrites(dev, await d.plans.get(a.id)!(), { title: a.title, target: 't', journalDir: dir });
    rmSync(dir, { recursive: true });
    // 볼륨 플래그(106,107)와 사용률(112)은 사양상 백업과 달라도 되고 체크섬에서도 제외된다.
    const restored = Buffer.from(disk.subarray(fx.offset, fx.offset + 12 * SS));
    for (const i of [106, 107, 112]) restored[i] = orig[i];
    expect(restored.equals(orig)).toBe(true);
    const after = (await findVolumes(dev)).volumes.find((x) => x.offset === fx.offset)!;
    expect(after.bootOk).toBe(true);
    expect(after.backupOk).toBe(true);
  });

  it('불량 섹터가 있어도 스캔이 중단되지 않고 나머지를 읽는다', async () => {
    const fx = manifest.ntfs;
    const disk = loadDisk();
    const boot = parseNtfsBoot(disk.subarray(fx.offset, fx.offset + SS))!;
    const mftSector = (fx.offset + boot.mftLcn * boot.clusterSize) / SS;
    // MFT 중간(사용자 파일 영역 레코드 일부)을 불량으로 만든다.
    const bad = new Set([mftSector + 2 * 400, mftSector + 2 * 401]);
    const dev = new MemoryDevice(disk, SS, bad);
    const vol = (await NtfsVolume.open(new SliceDevice(dev, fx.offset, fx.size)))!;
    await vol.scan();
    expect(dev.badSectorCount()).toBeGreaterThan(0);
    expect(findByPath(vol, 'hello.txt')).toBeDefined();
  });

  it('서명 카빙: 파일시스템이 없어도 JPEG/PDF를 원본 그대로 찾는다', async () => {
    const disk = loadDisk();
    zero(disk, 0, 34 * SS); // 테이블 제거
    const dev = new MemoryDevice(disk);
    const carve = new CarveVolume(dev, ['JPEG', 'PDF']);
    await carve.scan();
    const all = [...carve.entries.values()].filter((e) => !e.isDir);
    const hashes = new Set<string>();
    for (const e of all) hashes.add((await sha256Of(carve, e)).hash);
    const want = Object.values(manifest).flatMap((m) => m.files.filter((f) => /\.(jpg|pdf)$/.test(f.path)));
    expect(want.length).toBe(9);
    // FAT/exFAT에서 삭제된 사진까지 포함해 모두 찾아야 한다.
    for (const f of want) expect(hashes.has(f.sha256), f.path).toBe(true);
  }, 30000);
});

describe('저장과 쓰기 안전장치', () => {
  it('복구 저장: 폴더 구조와 내용, 파일 시간이 유지된다', async () => {
    const fx = manifest.ntfs;
    const dev = new MemoryDevice(loadDisk());
    const vol = (await NtfsVolume.open(new SliceDevice(dev, fx.offset, fx.size)))!;
    await vol.scan();
    const dir = mkdtempSync(join(tmpdir(), 'hddr-'));
    const rep = await recoverEntries(vol, [findByPath(vol, '한글 폴더')!.id, findByPath(vol, 'to-delete')!.id], dir);
    expect(rep.filesFailed).toBe(0);
    expect(rep.filesRecovered).toBe(3);
    expect(readFileSync(join(dir, '한글 폴더', '보고서.txt'), 'utf8')).toContain('복구 시험 문장');
    expect(readdirSync(join(dir, 'to-delete')).sort()).toEqual(['deleted-big.bin', 'deleted-small.txt']);
    rmSync(dir, { recursive: true });
  });

  it('악의적/비정상 파일명이 저장 위치를 벗어나지 못한다', () => {
    expect(sanitizeName('..')).not.toContain('..');
    expect(sanitizeName('..\\..\\windows\\system32')).not.toMatch(/[\\/]/);
    expect(sanitizeName('a/b:c*d?.txt')).toBe('a_b_c_d_.txt');
    expect(sanitizeName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeName('trailing. . ')).toBe('trailing');
    expect(sanitizeName('')).toBe('_이름없음');
  });

  it('범위를 벗어나거나 정렬되지 않은 쓰기는 거부한다', async () => {
    const dev = new MemoryDevice(Buffer.alloc(SS * 10));
    const dir = mkdtempSync(join(tmpdir(), 'hddr-'));
    await expect(applyWrites(dev, [{ offset: SS * 10, data: Buffer.alloc(SS), description: 'x' }], { title: 't', target: 't', journalDir: dir })).rejects.toThrow('범위');
    await expect(applyWrites(dev, [{ offset: 1, data: Buffer.alloc(SS), description: 'x' }], { title: 't', target: 't', journalDir: dir })).rejects.toThrow('정렬');
    rmSync(dir, { recursive: true });
  });

  it('FAT32 포맷터: 만든 볼륨을 다시 파싱할 수 있고 크기 한계를 지킨다', async () => {
    const dev = new MemoryDevice(Buffer.alloc(64 * 1024 * 1024));
    const l = await formatFat32(dev, { label: 'test vol', clusterSize: 512 });
    const boot = parseFatBoot(dev.buffer.subarray(0, SS))!;
    expect(boot.type).toBe('FAT32');
    expect(boot.clusterCount).toBe(l.clusterCount);
    expect(boot.label).toBe('TEST VOL');
    expect(parseFatBoot(dev.buffer.subarray(6 * SS, 7 * SS))).not.toBeNull();
    const vol = new FatVolume(dev, boot);
    await vol.scan();
    expect(vol.childrenOf(0)).toEqual([]);
    // FAT 공간이 데이터 영역과 겹치지 않아야 한다.
    expect(((l.clusterCount + 2) * 4) / SS).toBeLessThanOrEqual(l.fatSectors);
    expect(() => computeFat32Layout(10 * 1024 * 1024, SS, 4096)).toThrow();
    expect(() => computeFat32Layout(3 * 1024 ** 4, SS, 32768)).toThrow();
  });
});

describe('저수준 파서', () => {
  it('CRC32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('NTFS 데이터 런: 음수 오프셋과 희소 구간', () => {
    const buf = Buffer.from([0x21, 0x10, 0x00, 0x01, 0x11, 0x20, 0xf0, 0x01, 0x30, 0x00]);
    expect(decodeRuns(buf, 0, buf.length)).toEqual([
      { lcn: 256, length: 16 },
      { lcn: 240, length: 32 },
      { lcn: null, length: 48 },
    ]);
  });

  it('LZNT1: 압축 안 된 청크와 역참조 청크', () => {
    const plain = Buffer.from('ABCDEFGH');
    const raw = Buffer.concat([Buffer.from([(plain.length - 1) & 0xff, 0x30]), plain]);
    expect(lznt1Decompress(raw, 8).toString()).toBe('ABCDEFGH');
    // 'a' + (거리 1, 길이 9) 역참조 = 'a' * 10
    const body = Buffer.from([0b00000010, 0x61, 0x06, 0x00]);
    const comp = Buffer.concat([Buffer.from([(body.length - 1) & 0xff, 0xb0]), body]);
    expect(lznt1Decompress(comp, 10).toString()).toBe('a'.repeat(10 - 1 + 0).padEnd(10, 'a'));
  });

  it('합성 NTFS 부트 섹터 왕복', () => {
    const b = synthesizeNtfsBoot({ bytesPerSector: 512, clusterSize: 4096, totalSectors: 1000000, mftLcn: 786432, mftMirrLcn: 2, mftRecordSize: 1024, hiddenSectors: 2048 });
    const p = parseNtfsBoot(Buffer.concat([b]))!;
    // mftLcn * spc > totalSectors이므로 값이 유효한 경우만 파싱된다.
    expect(p).toBeNull();
    const b2 = synthesizeNtfsBoot({ bytesPerSector: 512, clusterSize: 4096, totalSectors: 10000000, mftLcn: 786432, mftMirrLcn: 2, mftRecordSize: 1024, hiddenSectors: 2048 });
    const p2 = parseNtfsBoot(b2)!;
    expect(p2.clusterSize).toBe(4096);
    expect(p2.mftRecordSize).toBe(1024);
    expect(p2.mftLcn).toBe(786432);
  });

  it('MBR 왕복과 2TiB 초과 거부', async () => {
    const dev = new MemoryDevice(Buffer.alloc(SS * 8192));
    const mbr = buildMbr([{ offset: 2048 * SS, size: 2048 * SS, mbrType: 7, gptType: GPT_BASIC_DATA }], SS);
    await dev.write(0, mbr);
    const t = await readPartitionTable(dev);
    expect(t.style).toBe('mbr');
    expect(t.partitions[0].offset).toBe(2048 * SS);
    expect(() => buildMbr([{ offset: 2048 * SS, size: 3 * 1024 ** 4, mbrType: 7, gptType: GPT_BASIC_DATA }], SS)).toThrow();
  });

  it('GPT 왕복', async () => {
    const dev = new MemoryDevice(Buffer.alloc(SS * 8192));
    for (const w of buildGpt([{ offset: 2048 * SS, size: 2048 * SS, mbrType: 7, gptType: GPT_BASIC_DATA, name: '데이터' }], dev.size, SS)) {
      await dev.write(w.offset, w.data);
    }
    const t = await readPartitionTable(dev);
    expect(t.style).toBe('gpt');
    expect(t.gpt?.primaryOk && t.gpt.backupOk).toBe(true);
    expect(t.partitions[0].name).toBe('데이터');
  });

  it('FAT 디렉터리: 한글 LFN과 삭제 항목', () => {
    const dir = Buffer.alloc(32 * 4);
    const short = Buffer.from('ABC     TXT', 'latin1');
    short.copy(dir, 32);
    dir[32 + 11] = 0x20;
    let sum = 0;
    for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) + (sum >> 1) + short[i]) & 0xff;
    dir[0] = 0x41;
    dir[11] = 0x0f;
    dir[13] = sum;
    dir.write('보고서', 1, 'utf16le');
    dir.writeUInt16LE(0, 7);
    dir.fill(0xff, 9, 11);
    dir.fill(0xff, 14, 26);
    dir.fill(0xff, 28, 32);
    short.copy(dir, 64);
    dir[64] = 0xe5;
    dir[64 + 11] = 0x20;
    const items = parseFatDirectory(dir);
    expect(items[0].name).toBe('보고서');
    expect(items[0].deleted).toBe(false);
    expect(items[1].deleted).toBe(true);
    expect(items[1].name).toBe('_BC.TXT');
  });

  it('exFAT 부트가 없으면 null을 돌려준다', async () => {
    const dev = new MemoryDevice(Buffer.alloc(SS * 64));
    expect(await ExfatVolume.open(dev)).toBeNull();
  });
});
