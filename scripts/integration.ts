/**
 * 실제 Windows 환경 통합 테스트. 관리자 권한 필요.
 * 임시 VHD를 만들어 연결하고 그 VHD에서만 작업한다. 대상이 가상 디스크가 아니면 즉시 중단한다.
 *
 *   npm run test:integration
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDevice, SliceDevice } from '../src/engine/device';
import { formatFat32 } from '../src/engine/mkfat32';
import { parseNtfsBoot } from '../src/engine/ntfs';
import { recoverEntries } from '../src/engine/recover';
import { applyWrites, diagnose } from '../src/engine/repair';
import { findVolumes, openFoundVolume } from '../src/engine/scanner';
import * as win from '../src/main/windows-disk';

const work = mkdtempSync(join(process.env.INTEGRATION_DIR ?? tmpdir(), 'hddr-int-'));
const vhd = join(work, 'test.vhd');
const SS = 512;
const GiB = 1024 ** 3;
const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) throw new Error(`검증 실패: ${name} ${detail}`);
}

async function diskpart(lines: string[]): Promise<void> {
  const f = join(work, 'dp.txt');
  writeFileSync(f, lines.join('\r\n'), 'ascii');
  const r = await win.runPowerShell(`diskpart /s $env:HDDR_F; exit $LASTEXITCODE`, { F: f });
  if (r.code !== 0) throw new Error(`diskpart 실패: ${r.stdout}`);
}

async function vhdDiskNumber(): Promise<number> {
  const r = await win.runPowerShell(
    `$d = Get-DiskImage -ImagePath $env:HDDR_P | Get-Disk
if ($d.FriendlyName -notmatch 'Virtual Disk') { throw '가상 디스크가 아닙니다' }
[string]$d.Number`,
    { P: vhd },
  );
  if (r.code !== 0) throw new Error(r.stderr);
  return Number(r.stdout.trim());
}

async function diskInfo(n: number): Promise<win.DiskInfo> {
  const d = (await win.listDisks()).find((x) => x.number === n);
  if (!d || !/Virtual Disk/.test(d.name)) throw new Error('대상이 가상 디스크가 아닙니다.');
  return d;
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function settle(n: number): Promise<win.DiskInfo> {
  await win.refreshDisk(n).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  return diskInfo(n);
}

async function rawZero(n: number, ranges: { offset: number; length: number }[]): Promise<void> {
  const d = await diskInfo(n);
  await win.withRawWriteAccess(n, async () => {
    const dev = await FileDevice.openPhysical(n, d.size, d.sectorSize, true);
    for (const r of ranges) await dev.write(r.offset, Buffer.alloc(r.length));
    await dev.close();
  });
}

async function main(): Promise<void> {
  if (!(await win.isElevated())) throw new Error('관리자 권한으로 실행하세요.');
  await diskpart([`create vdisk file="${vhd}" maximum=${40 * 1024} type=expandable`, `select vdisk file="${vhd}"`, 'attach vdisk']);
  const n = await vhdDiskNumber();
  const before = await win.listDisks();
  console.log(`임시 VHD: 디스크 ${n}, 전체 디스크 ${before.length}개`);

  try {
    // ── 디스크 제어 ──────────────────────────────
    let d = await diskInfo(n);
    check('새 가상 디스크는 RAW로 보인다', d.style === 'RAW');
    check('가상 디스크는 보호 대상이 아니다', !d.protected);
    check('시스템 디스크는 보호 대상이다', before.filter((x) => x.isSystem || x.isBoot).every((x) => x.protected));

    await win.initializeDisk(n, 'GPT');
    await win.createPartition(n, { size: 3 * GiB, fs: 'NTFS', label: 'DATA1', quick: true });
    await win.createPartition(n, { size: 3 * GiB, fs: 'NTFS', label: 'DATA2', quick: true });
    d = await settle(n);
    const data = d.partitions.filter((p) => p.volume?.fileSystem === 'NTFS');
    check('파티션 생성과 빠른 포맷', data.length === 2 && !!data[0].letter && !!data[1].letter, `${data.map((p) => p.letter).join(',')}`);
    const [p1, p2] = data;

    const big = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i * 2654435761 % 2 ** 32, i);
    mkdirSync(`${p1.letter}:\\폴더`, { recursive: true });
    writeFileSync(`${p1.letter}:\\폴더\\중요한 파일.bin`, big);
    writeFileSync(`${p2.letter}:\\p2.txt`, 'partition two');
    await win.runPowerShell(`Write-VolumeCache -DriveLetter $env:HDDR_A; Write-VolumeCache -DriveLetter $env:HDDR_B`, { A: p1.letter!, B: p2.letter! });

    // ── 분할 ─────────────────────────────────────
    const MiB = 1024 * 1024;
    const alignMiB = (v: number): number => Math.ceil(v / MiB) * MiB;
    const range = await win.supportedSize(n, p2.number);
    check('축소 가능 범위 조회', range.min < p2.size && range.max >= p2.size, `min=${range.min} max=${range.max}`);
    const shrinkTo = alignMiB(range.min + (p2.size - range.min) * 0.8);
    await win.resizePartition(n, p2.number, shrinkTo);
    d = await settle(n);
    check('크기 변경(축소)', Math.abs(d.partitions.find((p) => p.number === p2.number)!.size - shrinkTo) < MiB);
    check('축소 후에도 파일 유지', readFileSync(`${p2.letter}:\\p2.txt`, 'utf8') === 'partition two');

    const range2 = await win.supportedSize(n, p2.number);
    const splitAt = alignMiB(range2.min + (shrinkTo - range2.min) * 0.2);
    await win.splitPartition(n, p2.number, { firstSize: splitAt, fs: 'NTFS', label: 'SPLIT' });
    d = await settle(n);
    const afterSplit = d.partitions.filter((p) => p.volume?.fileSystem === 'NTFS');
    check('분할', afterSplit.length >= 3, `NTFS ${afterSplit.length}개`);
    const splitNew = afterSplit.find((p) => p.volume?.label === 'SPLIT')!;
    check('분할 새 파티션 드라이브 문자', !!splitNew?.letter);
    check('분할 후 기존 파일 유지', readFileSync(`${p2.letter}:\\p2.txt`, 'utf8') === 'partition two');

    // ── 통합(데이터 보존) ────────────────────────
    writeFileSync(`${splitNew.letter}:\\merge-me.txt`, '통합 전 파일');
    await win.mergePartitions(n, p2.number, splitNew.number, true, (m) => console.log('   ', m));
    d = await settle(n);
    const merged = d.partitions.find((p) => p.number === p2.number)!;
    check('통합 후 크기 = 두 파티션의 합(뒤쪽 미할당은 그대로)', Math.abs(merged.size - (splitNew.offset + splitNew.size - p2.offset)) < MiB, `${merged.size}`);
    const tooBig = await win.resizePartition(n, p2.number, 1024 * GiB).then(() => '', (e: Error) => e.message);
    check('Windows 오류 메시지를 사용자에게 전달', tooBig !== '' && tooBig !== '알 수 없는 오류', tooBig);
    check('통합 후 오른쪽 파티션 제거', !d.partitions.some((p) => p.volume?.label === 'SPLIT'));
    check('통합 후 왼쪽 파일 유지', readFileSync(`${p2.letter}:\\p2.txt`, 'utf8') === 'partition two');
    check(
      '통합 시 오른쪽 파일 보존',
      readFileSync(`${p2.letter}:\\통합된_${splitNew.letter}_드라이브\\merge-me.txt`, 'utf8') === '통합 전 파일',
    );

    // ── 포맷 ─────────────────────────────────────
    await win.formatPartition(n, p2.number, { fs: 'exFAT', label: 'EX', quick: true });
    d = await settle(n);
    check('빠른 포맷: NTFS → exFAT', d.partitions.find((p) => p.number === p2.number)?.volume?.fileSystem === 'exFAT');
    check('포맷으로 기존 파일 제거', !existsSync(`${p2.letter}:\\p2.txt`));

    // ── 자체 FAT32 포맷터(>32GB) ──────────────────
    await win.createPartition(n, { size: 33 * GiB });
    d = await settle(n);
    const raw = d.partitions[d.partitions.length - 1];
    await win.withRawWriteAccess(n, async () => {
      const dev = await FileDevice.openPhysical(n, d.size, d.sectorSize, true);
      await formatFat32(new SliceDevice(dev, raw.offset, raw.size), { label: 'BIGFAT' }, raw.offset / SS);
      await dev.close();
    });
    d = await settle(n);
    const fatVol = d.partitions.find((p) => p.number === raw.number)!;
    check('33GB FAT32를 Windows가 인식', fatVol.volume?.fileSystem === 'FAT32', `fs=${fatVol.volume?.fileSystem}`);
    if (!fatVol.letter) await win.setDriveLetter(n, raw.number, null);
    d = await settle(n);
    const fatLetter = d.partitions.find((p) => p.number === raw.number)!.letter!;
    writeFileSync(`${fatLetter}:\\on-fat32.bin`, big);
    check('33GB FAT32에 Windows로 파일 쓰기/읽기', sha(readFileSync(`${fatLetter}:\\on-fat32.bin`)) === sha(big));
    const fatCheck = await win.checkVolume(n, raw.number, false);
    check('33GB FAT32 chkdsk 통과', /NoErrorsFound/i.test(fatCheck), fatCheck);
    const exCheck = await win.checkVolume(n, p2.number, false);
    check('exFAT 검사 동작', /NoErrorsFound/i.test(exCheck), exCheck);

    // ── 원시 장치 읽기/복구 ──────────────────────
    // 비워진 MFT 레코드는 Windows가 곧 재사용할 수 있어, 삭제는 스캔 직전에 한다.
    // 디스크에 기록되기 전에 지우면 MFT에 흔적이 남지 않으므로 먼저 플러시한다.
    writeFileSync(`${p1.letter}:\\삭제될 파일.bin`, big.subarray(0, 100000));
    await win.runPowerShell(`Write-VolumeCache -DriveLetter $env:HDDR_A`, { A: p1.letter! });
    unlinkSync(`${p1.letter}:\\삭제될 파일.bin`); // Node 24의 rmSync는 한글 경로에서 프로세스가 죽는다
    await win.runPowerShell(`Write-VolumeCache -DriveLetter $env:HDDR_A`, { A: p1.letter! });
    d = await diskInfo(n);
    const readDev = await FileDevice.openPhysical(n, d.size, d.sectorSize, false);
    const scan = await findVolumes(readDev);
    check('물리 디스크에서 파티션 테이블 읽기', scan.table.style === 'gpt' && scan.volumes.some((v) => v.fsType === 'NTFS' && v.offset === p1.offset));
    const volInfo = scan.volumes.find((v) => v.offset === p1.offset)!;
    const vol = await openFoundVolume(readDev, volInfo);
    await vol.scan();
    const found = [...vol.entries.values()];
    check('마운트 상태의 물리 디스크에서 파일 목록 읽기', found.some((e) => e.name === '중요한 파일.bin'));
    const deletedEntry = found.find((e) => e.name === '삭제될 파일.bin');
    check('삭제 파일 탐지', !!deletedEntry?.deleted, deletedEntry?.deleted ? '' : found.filter((e) => e.id > 1).map((e) => `${e.name}${e.deleted ? '[D]' : ''}`).join(' | '));
    const out = join(work, 'recovered');
    const rep = await recoverEntries(vol, [deletedEntry!.id, found.find((e) => e.name === '폴더')!.id], out);
    check('복구 저장 후 해시 일치', sha(readFileSync(join(out, '폴더', '중요한 파일.bin'))) === sha(big) && rep.filesFailed === 0);
    check('삭제 파일 복구 해시 일치', sha(readFileSync(join(out, '삭제될 파일.bin'))) === sha(big.subarray(0, 100000)));
    await readDev.close();

    // ── 손상 후 복원: NTFS 부트 섹터 2개 모두 제거 ──
    d = await diskInfo(n);
    const bootDev = await FileDevice.openPhysical(n, d.size, d.sectorSize, false);
    const bootOrig = parseNtfsBoot(await bootDev.read(p1.offset, SS))!;
    await bootDev.close();
    await rawZero(n, [
      { offset: p1.offset, length: SS },
      { offset: p1.offset + bootOrig.totalSectors * SS, length: SS },
    ]);
    d = await settle(n);
    const broken = d.partitions.find((p) => p.number === p1.number)!;
    check('부트 섹터를 지우면 Windows가 RAW로 인식', broken.volume?.fileSystem !== 'NTFS', `fs=${broken.volume?.fileSystem || 'RAW'}`);
    check('이 시점에 파일 접근 불가(복구 대상 상태 재현)', !existsSync(`${p1.letter}:\\폴더\\중요한 파일.bin`));

    const started = Date.now();
    let dev = await FileDevice.openPhysical(n, d.size, d.sectorSize, false);
    let diag = await diagnose(dev, { deep: true });
    console.log(`    정밀 진단 ${(Date.now() - started) / 1000}초`);
    const rebuilt = diag.actions.find((a) => a.kind === 'ntfs-boot-rebuild');
    check('$MFT 역산으로 부트 재생성 제안', !!rebuilt);
    const brokenVol = diag.volumes.find((v) => v.offset === p1.offset)!;
    const vol2 = await openFoundVolume(dev, brokenVol);
    await vol2.scan();
    check('손상 상태(RAW)에서도 파일 목록 복구', [...vol2.entries.values()].some((e) => e.name === '중요한 파일.bin'));
    const writes = await diag.plans.get(rebuilt!.id)!();
    await dev.close();
    await win.withRawWriteAccess(n, async () => {
      const w = await FileDevice.openPhysical(n, d.size, d.sectorSize, true);
      await applyWrites(w, writes, { title: rebuilt!.title, target: 'int', journalDir: join(work, 'j') });
      await w.close();
    });
    d = await settle(n);
    const fixed = d.partitions.find((p) => p.number === p1.number)!;
    check('부트 재생성 후 Windows가 NTFS로 다시 마운트', fixed.volume?.fileSystem === 'NTFS', `fs=${fixed.volume?.fileSystem}`);
    const letter1 = fixed.letter ?? p1.letter!;
    check('재마운트 후 파일 내용 일치', sha(readFileSync(`${letter1}:\\폴더\\중요한 파일.bin`)) === sha(big));
    const ntfsCheck = await win.checkVolume(n, p1.number, false);
    check('재생성한 볼륨 chkdsk 통과', /NoErrorsFound/i.test(ntfsCheck), ntfsCheck);

    // ── 손상 후 복원: 파티션 테이블 전체 소실 ────
    const partsBefore = d.partitions.map((p) => p.offset);
    const lastLba = Math.floor(d.size / SS) - 1;
    await rawZero(n, [
      { offset: 0, length: 34 * SS },
      { offset: (lastLba - 32) * SS, length: 33 * SS },
    ]);
    d = await settle(n);
    check('테이블을 지우면 Windows에서 파티션이 사라짐', d.style === 'RAW' || d.partitions.length === 0, `style=${d.style} parts=${d.partitions.length}`);

    dev = await FileDevice.openPhysical(n, d.size, d.sectorSize, false);
    diag = await diagnose(dev, { deep: true });
    const rebuildTable = diag.actions.find((a) => a.kind === 'table-rebuild-gpt');
    check('잃어버린 볼륨으로 GPT 재생성 제안', !!rebuildTable, `찾은 볼륨 ${diag.volumes.length}개`);
    const tableWrites = await diag.plans.get(rebuildTable!.id)!();
    await dev.close();
    await win.withRawWriteAccess(n, async () => {
      const w = await FileDevice.openPhysical(n, d.size, d.sectorSize, true);
      await applyWrites(w, tableWrites, { title: rebuildTable!.title, target: 'int', journalDir: join(work, 'j') });
      await w.close();
    });
    d = await settle(n);
    check('테이블 재생성 후 GPT로 인식', d.style === 'GPT');
    const restored = d.partitions.find((p) => p.offset === p1.offset);
    check('재생성 후 NTFS 볼륨 복귀', restored?.volume?.fileSystem === 'NTFS', `fs=${restored?.volume?.fileSystem}`);
    if (restored && !restored.letter) await win.setDriveLetter(n, restored.number, null);
    d = await settle(n);
    const again = d.partitions.find((p) => p.offset === p1.offset)!;
    check('재생성 후 파일 내용 일치', sha(readFileSync(`${again.letter}:\\폴더\\중요한 파일.bin`)) === sha(big));
    check('데이터 파티션 위치 유지', [p1.offset, p2.offset, raw.offset].every((o) => d.partitions.some((p) => p.offset === o)), JSON.stringify(partsBefore));
    const exVol = d.partitions.find((p) => p.offset === p2.offset);
    check('exFAT/FAT32 볼륨도 복귀', exVol?.volume?.fileSystem === 'exFAT' && d.partitions.find((p) => p.offset === raw.offset)?.volume?.fileSystem === 'FAT32');

    // ── 삭제 / 테이블 재초기화 ───────────────────
    await win.deletePartition(n, again.number);
    d = await settle(n);
    check('파티션 삭제', !d.partitions.some((p) => p.offset === p1.offset));
    await win.clearDisk(n);
    await win.initializeDisk(n, 'MBR');
    d = await settle(n);
    check('테이블 초기화 후 MBR로 재초기화', d.style === 'MBR' && d.partitions.length === 0);

    // 실제 디스크 목록이 그대로인지 마지막으로 확인
    const afterList = await win.listDisks();
    for (const b of before.filter((x) => x.number !== n)) {
      const a = afterList.find((x) => x.number === b.number);
      check(`실제 디스크 ${b.number} 변화 없음`, !!a && a.style === b.style && a.partitions.length === b.partitions.length, b.name);
    }
  } finally {
    await diskpart([`select vdisk file="${vhd}"`, 'detach vdisk']).catch((e) => console.error(e));
    await win.runPowerShell(`Remove-Item -LiteralPath $env:HDDR_W -Recurse -Force`, { W: work });
  }
  console.log(`\n통과 ${results.filter((r) => r.ok).length} / ${results.length}`);
}

main().catch((e) => {
  console.error('\n실패:', e);
  process.exitCode = 1;
});
