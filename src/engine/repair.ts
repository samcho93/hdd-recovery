import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatBytes, throwIfAborted, yieldToLoop, type ProgressFn } from './bytes';
import type { BlockDevice } from './device';
import { exfatBootChecksum, parseExfatBoot } from './exfat';
import { parseFatBoot } from './fat';
import { parseNtfsBoot, synthesizeNtfsBoot } from './ntfs';
import {
  buildGpt,
  buildMbr,
  GPT_BASIC_DATA,
  readPartitionTable,
  type NewPartition,
  type PartitionEntry,
  type SectorWrite,
  type TableInfo,
} from './partition';
import { findVolumes, probeAt, type FoundVolume, type ScanResult } from './scanner';

export type RepairKind =
  | 'gpt-restore-primary'
  | 'gpt-restore-backup'
  | 'table-rebuild-mbr'
  | 'table-rebuild-gpt'
  | 'ntfs-boot-from-backup'
  | 'ntfs-backup-from-boot'
  | 'ntfs-boot-rebuild'
  | 'fat-boot-from-backup'
  | 'fat-backup-from-boot'
  | 'fat-copy-from-second'
  | 'exfat-boot-from-backup'
  | 'exfat-backup-from-boot';

export interface RepairAction {
  id: string;
  kind: RepairKind;
  title: string;
  detail: string;
  risk: 'low' | 'medium';
  recommended: boolean;
  /** 영향받는 영역 요약 */
  regions: { offset: number; length: number; description: string }[];
}

export interface Diagnosis {
  table: TableInfo;
  volumes: FoundVolume[];
  healthy: boolean;
  actions: RepairAction[];
  findings: string[];
  /** 내부용: 액션별 실제 쓰기 내용 */
  plans: Map<string, () => Promise<SectorWrite[]>>;
}

function toRegions(writes: SectorWrite[]): RepairAction['regions'] {
  return writes.map((w) => ({ offset: w.offset, length: w.data.length, description: w.description }));
}

function toNewPartition(p: PartitionEntry): NewPartition {
  const isGuid = p.type.includes('-');
  return {
    offset: p.offset,
    size: p.size,
    mbrType: isGuid ? 0x07 : parseInt(p.type, 16),
    gptType: isGuid ? p.type : GPT_BASIC_DATA,
    name: p.name,
    guid: p.guid,
    attributes: p.attributes,
  };
}

function volumeToPartition(v: FoundVolume): NewPartition {
  const mbrType = v.fsType === 'FAT32' ? 0x0c : v.fsType === 'FAT16' ? 0x0e : v.fsType === 'FAT12' ? 0x01 : 0x07;
  return { offset: v.offset, size: v.size, mbrType, gptType: GPT_BASIC_DATA, name: 'Basic data partition' };
}

/** 스캔 결과를 바탕으로 복원 가능한 항목을 만든다. 디스크에는 아무것도 쓰지 않는다. */
export async function diagnose(
  dev: BlockDevice,
  opts: { deep?: boolean; signal?: AbortSignal; onProgress?: ProgressFn; scan?: ScanResult } = {},
): Promise<Diagnosis> {
  const scan = opts.scan ?? (await findVolumes(dev, opts));
  const { table, volumes } = scan;
  const ss = dev.sectorSize;
  const actions: RepairAction[] = [];
  const plans = new Map<string, () => Promise<SectorWrite[]>>();
  const findings: string[] = [...table.issues];

  const addAction = async (
    a: Omit<RepairAction, 'id' | 'regions'>,
    plan: () => Promise<SectorWrite[]>,
  ): Promise<void> => {
    const writes = await plan();
    const id = randomUUID();
    plans.set(id, plan);
    actions.push({ ...a, id, regions: toRegions(writes) });
  };

  // ── GPT 복원 ────────────────────────────────────────────────
  if (table.style === 'gpt' && table.gpt) {
    const g = table.gpt;
    if (!g.primaryOk || !g.backupOk) {
      const fromBackup = !g.primaryOk;
      const plan = async (): Promise<SectorWrite[]> => {
        const parts = table.partitions.map(toNewPartition);
        const all = buildGpt(parts, dev.size, ss, g.diskGuid);
        return fromBackup ? all.slice(0, 3) : all.slice(3);
      };
      await addAction(
        {
          kind: fromBackup ? 'gpt-restore-primary' : 'gpt-restore-backup',
          title: fromBackup ? '백업 GPT로 기본 GPT 복원' : '기본 GPT로 백업 GPT 복원',
          detail: `손상되지 않은 쪽의 파티션 항목 ${table.partitions.length}개로 ${fromBackup ? '디스크 앞쪽' : '디스크 끝'}의 GPT를 다시 씁니다.`,
          risk: 'low',
          recommended: true,
        },
        plan,
      );
    }
  }

  // ── 파티션 테이블 재생성 ────────────────────────────────────
  const known = volumes.filter((v) => v.fsType !== 'unknown');
  const lost = known.filter((v) => !v.inTable && v.offset > 0);
  const needsRebuild = lost.length > 0 && !(table.style === 'gpt' && table.gpt && !table.gpt.primaryOk && !lost.length);
  if (lost.length) {
    findings.push(`파티션 테이블에 없는 볼륨 ${lost.length}개를 찾았습니다.`);
  }
  if (needsRebuild || (table.style === 'none' && known.some((v) => v.offset > 0))) {
    const kept = table.partitions.filter((p) => {
      const lostOverlap = lost.some((v) => v.offset < p.offset + p.size && p.offset < v.offset + v.size);
      return !lostOverlap;
    });
    const merged: NewPartition[] = [...kept.map(toNewPartition), ...lost.map(volumeToPartition)].sort(
      (a, b) => a.offset - b.offset,
    );
    const overlap = merged.some((p, i) => i > 0 && merged[i - 1].offset + merged[i - 1].size > p.offset);
    const fitsDisk = merged.every((p) => p.offset + p.size <= dev.size);
    if (overlap) findings.push('찾은 볼륨끼리 위치가 겹칩니다. 오래된 파티션의 흔적일 수 있어 자동 재생성을 제안하지 않습니다.');
    if (!fitsDisk) findings.push('찾은 볼륨이 디스크 끝을 넘습니다. 디스크 크기가 달라졌을 수 있습니다.');
    if (!overlap && fitsDisk) {
      const preferGpt = table.style === 'gpt' || dev.size > 2 * 1024 ** 4;
      const lastLba = Math.floor(dev.size / ss) - 1;
      const gptFirstUsable = 2 + Math.ceil(16384 / ss);
      const gptLastUsable = lastLba - Math.ceil(16384 / ss) - 1;
      const gptOk = merged.every((p) => p.offset / ss >= gptFirstUsable && (p.offset + p.size) / ss - 1 <= gptLastUsable);
      const mbrOk = merged.length <= 4 && merged.every((p) => (p.offset + p.size) / ss <= 0xffffffff);
      const list = merged.map((p) => `${Math.round(p.size / 1024 / 1024).toLocaleString()} MiB`).join(', ');
      if (gptOk) {
        await addAction(
          {
            kind: 'table-rebuild-gpt',
            title: 'GPT 파티션 테이블 재생성',
            detail: `찾은 볼륨 ${merged.length}개(${list})로 GPT를 새로 만듭니다. 데이터 영역은 건드리지 않습니다.`,
            risk: 'medium',
            recommended: preferGpt,
          },
          async () => buildGpt(merged, dev.size, ss, table.gpt?.diskGuid),
        );
      }
      if (mbrOk) {
        await addAction(
          {
            kind: 'table-rebuild-mbr',
            title: 'MBR 파티션 테이블 재생성',
            detail: `찾은 볼륨 ${merged.length}개(${list})로 MBR을 새로 만듭니다. 부트 코드는 유지합니다.`,
            risk: 'medium',
            recommended: !preferGpt,
          },
          async () => {
            const existing = await dev.read(0, ss);
            return [{ offset: 0, data: buildMbr(merged, ss, existing), description: 'MBR' }];
          },
        );
      }
    }
  }

  // ── 볼륨별 부트 섹터 복원 ───────────────────────────────────
  for (const v of volumes) {
    const name = `${v.fsType} (시작 ${formatBytes(v.offset)})`;
    if (v.fsType === 'NTFS') {
      if (v.mft && !v.bootOk) {
        if (v.backupOk) {
          await addAction(
            {
              kind: 'ntfs-boot-from-backup',
              title: `${name}: 백업 부트 섹터로 복원`,
              detail: '볼륨 끝의 백업 부트 섹터를 맨 앞으로 복사합니다.',
              risk: 'low',
              recommended: true,
            },
            async () => {
              const backup = await dev.read(v.offset + v.size - ss, ss);
              return [{ offset: v.offset, data: backup, description: 'NTFS 부트 섹터' }];
            },
          );
        } else {
          const m = v.mft;
          await addAction(
            {
              kind: 'ntfs-boot-rebuild',
              title: `${name}: $MFT로 부트 섹터 재생성`,
              detail: `기본/백업 부트 섹터가 모두 손상되어 $MFT에서 역산한 값으로 새로 만듭니다(클러스터 ${m.clusterSize} 바이트). 부트 코드는 없으므로 데이터 디스크에 적합합니다.`,
              risk: 'medium',
              recommended: true,
            },
            async () => {
              const boot = synthesizeNtfsBoot({
                bytesPerSector: ss,
                clusterSize: m.clusterSize,
                totalSectors: m.totalSectors,
                mftLcn: m.mftLcn,
                mftMirrLcn: m.mirrLcn,
                mftRecordSize: m.recordSize,
                hiddenSectors: v.offset / ss,
              });
              return [
                { offset: v.offset, data: boot, description: 'NTFS 부트 섹터(재생성)' },
                { offset: v.offset + m.totalSectors * ss, data: boot, description: 'NTFS 백업 부트 섹터(재생성)' },
              ];
            },
          );
        }
      } else if (!v.bootOk && v.backupOk) {
        await addAction(
          {
            kind: 'ntfs-boot-from-backup',
            title: `${name}: 백업 부트 섹터로 복원`,
            detail: '볼륨 끝의 백업 부트 섹터를 맨 앞으로 복사합니다.',
            risk: 'low',
            recommended: true,
          },
          async () => [
            { offset: v.offset, data: await dev.read(v.offset + v.size - ss, ss), description: 'NTFS 부트 섹터' },
          ],
        );
      } else if (v.bootOk && v.backupOk === false) {
        await addAction(
          {
            kind: 'ntfs-backup-from-boot',
            title: `${name}: 백업 부트 섹터 갱신`,
            detail: '정상인 기본 부트 섹터를 볼륨 끝의 백업 위치에 복사합니다.',
            risk: 'low',
            recommended: true,
          },
          async () => [
            { offset: v.offset + v.size - ss, data: await dev.read(v.offset, ss), description: 'NTFS 백업 부트 섹터' },
          ],
        );
      }
    }

    if (v.fsType === 'FAT32') {
      if (!v.bootOk && v.backupOk) {
        await addAction(
          {
            kind: 'fat-boot-from-backup',
            title: `${name}: 백업 부트 섹터로 복원`,
            detail: '6~8번 섹터의 백업 부트 영역을 0~2번 섹터로 복사합니다.',
            risk: 'low',
            recommended: true,
          },
          async () => [
            { offset: v.offset, data: await dev.read(v.offset + 6 * ss, 3 * ss), description: 'FAT32 부트 영역' },
          ],
        );
      } else if (v.bootOk && v.backupOk === false) {
        await addAction(
          {
            kind: 'fat-backup-from-boot',
            title: `${name}: 백업 부트 섹터 갱신`,
            detail: '정상인 0~2번 섹터를 6~8번 섹터에 복사합니다.',
            risk: 'low',
            recommended: true,
          },
          async () => [
            { offset: v.offset + 6 * ss, data: await dev.read(v.offset, 3 * ss), description: 'FAT32 백업 부트 영역' },
          ],
        );
      }
    }

    if (v.fsType.startsWith('FAT')) {
      const bootRaw = await dev.read(v.bootOk ? v.offset : v.offset + 6 * ss, ss);
      const boot = parseFatBoot(bootRaw);
      if (boot && boot.numFats >= 2) {
        const fat1Off = v.offset + boot.reservedSectors * boot.bytesPerSector;
        const fatLen = boot.fatSectors * boot.bytesPerSector;
        const head1 = await dev.read(fat1Off, ss);
        const head2 = await dev.read(fat1Off + fatLen, ss);
        const firstBad = !(head1[0] === boot.media && head1[1] === 0xff);
        const secondGood = head2[0] === boot.media && head2[1] === 0xff;
        if (firstBad && secondGood) {
          findings.push(`${name}: FAT 1번 사본이 손상되었습니다.`);
          await addAction(
            {
              kind: 'fat-copy-from-second',
              title: `${name}: FAT 2번 사본으로 1번 사본 복원`,
              detail: `FAT 영역 ${Math.round(fatLen / 1024).toLocaleString()} KiB를 복사합니다.`,
              risk: 'low',
              recommended: true,
            },
            async () => [
              { offset: fat1Off, data: await dev.read(fat1Off + fatLen, fatLen), description: 'FAT 1번 사본' },
            ],
          );
        }
      }
    }

    if (v.fsType === 'exFAT') {
      if (!v.bootOk && v.backupOk) {
        await addAction(
          {
            kind: 'exfat-boot-from-backup',
            title: `${name}: 백업 부트 영역으로 복원`,
            detail: '12~23번 섹터의 백업 부트 영역을 0~11번 섹터로 복사합니다.',
            risk: 'low',
            recommended: true,
          },
          async () => [
            { offset: v.offset, data: await dev.read(v.offset + 12 * ss, 12 * ss), description: 'exFAT 부트 영역' },
          ],
        );
      } else if (v.bootOk && v.backupOk === false) {
        const region = await dev.read(v.offset, 12 * ss);
        const primaryValid =
          parseExfatBoot(region) !== null && region.readUInt32LE(ss * 11) === exfatBootChecksum(region, ss);
        if (primaryValid) {
          await addAction(
            {
              kind: 'exfat-backup-from-boot',
              title: `${name}: 백업 부트 영역 갱신`,
              detail: '정상인 0~11번 섹터를 12~23번 섹터에 복사합니다.',
              risk: 'low',
              recommended: true,
            },
            async () => [
              { offset: v.offset + 12 * ss, data: await dev.read(v.offset, 12 * ss), description: 'exFAT 백업 부트 영역' },
            ],
          );
        }
      }
    }

    if (v.fsType === 'unknown') findings.push(`파티션 ${v.partition?.index ?? '?'}: 파일시스템을 식별하지 못했습니다.`);
    for (const n of v.notes) findings.push(`${name}: ${n}`);
  }

  const healthy = actions.length === 0 && table.issues.length === 0 && volumes.every((v) => v.bootOk);
  return { table, volumes, healthy, actions, findings: [...new Set(findings)], plans };
}

export interface JournalInfo {
  id: string;
  createdAt: number;
  title: string;
  target: string;
  writes: { offset: number; length: number; description: string }[];
  undone?: boolean;
}

/**
 * 쓰기 전에 원래 내용을 저널에 남기고 쓴다. 쓴 뒤에는 다시 읽어 검증한다.
 * 저널의 경로는 undo에 쓰인다.
 */
export async function applyWrites(
  dev: BlockDevice,
  writes: SectorWrite[],
  meta: { title: string; target: string; journalDir: string; signal?: AbortSignal; onProgress?: ProgressFn },
): Promise<JournalInfo> {
  await mkdir(meta.journalDir, { recursive: true });
  const ss = dev.sectorSize;
  for (const w of writes) {
    if (w.offset % ss !== 0 || w.data.length % ss !== 0) throw new Error(`정렬되지 않은 쓰기입니다: ${w.description}`);
    if (w.offset + w.data.length > dev.size) throw new Error(`디스크 범위를 벗어난 쓰기입니다: ${w.description}`);
  }
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const olds: Buffer[] = [];
  for (const w of writes) olds.push(await dev.read(w.offset, w.data.length));
  const info: JournalInfo = {
    id,
    createdAt: Date.now(),
    title: meta.title,
    target: meta.target,
    writes: writes.map((w) => ({ offset: w.offset, length: w.data.length, description: w.description })),
  };
  await writeFile(join(meta.journalDir, `${id}.bin`), Buffer.concat(olds));
  await writeFile(join(meta.journalDir, `${id}.json`), JSON.stringify(info, null, 2));

  const total = writes.reduce((s, w) => s + w.data.length, 0);
  let done = 0;
  for (const w of writes) {
    throwIfAborted(meta.signal);
    await dev.write(w.offset, w.data);
    const check = await dev.read(w.offset, w.data.length);
    if (!check.equals(w.data)) throw new Error(`기록 검증 실패: ${w.description}. 저널 ${id}로 되돌릴 수 있습니다.`);
    done += w.data.length;
    meta.onProgress?.({ done, total, message: w.description });
    await yieldToLoop();
  }
  return info;
}

export async function listJournals(journalDir: string): Promise<JournalInfo[]> {
  let names: string[];
  try {
    names = await readdir(journalDir);
  } catch {
    return [];
  }
  const out: JournalInfo[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await readFile(join(journalDir, n), 'utf8')));
    } catch {
      // 깨진 저널은 건너뛴다
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function undoJournal(dev: BlockDevice, journalDir: string, id: string): Promise<void> {
  if (!/^[\w-]+$/.test(id)) throw new Error('잘못된 저널 ID입니다.');
  const info = JSON.parse(await readFile(join(journalDir, `${id}.json`), 'utf8')) as JournalInfo;
  const data = await readFile(join(journalDir, `${id}.bin`));
  let pos = 0;
  for (const w of info.writes) {
    await dev.write(w.offset, data.subarray(pos, pos + w.length));
    pos += w.length;
  }
  info.undone = true;
  await writeFile(join(journalDir, `${id}.json`), JSON.stringify(info, null, 2));
}

export { probeAt, readPartitionTable, parseNtfsBoot };
