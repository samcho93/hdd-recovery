import { spawn } from 'node:child_process';

/**
 * Windows 저장소 관리 기능(PowerShell Storage 모듈) 래퍼.
 * 모든 인자는 스크립트 문자열에 끼워 넣지 않고 환경 변수로 넘겨 명령 주입을 원천 차단한다.
 */

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

const PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
`;

export function runPowerShell(script: string, args: Record<string, string | number> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(PRELUDE + script, 'utf16le').toString('base64');
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(args)) env[`HDDR_${k}`] = String(v);
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

function cleanError(stderr: string): string {
  // stderr가 파이프면 PowerShell은 오류를 CLIXML로 내보낸다. 메시지 부분만 꺼낸다.
  let text = stderr;
  if (text.includes('#< CLIXML')) {
    const parts = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
    text = parts
      .join('')
      .replace(/_x000D__x000A_/g, '\n')
      .replace(/_x[0-9A-Fa-f]{4}_/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  const lines = text
    .replace(/\s*Activity ID: \{[^}]*\}/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(At line|At char|\+ |위치 줄|CategoryInfo|FullyQualifiedErrorId)/.test(l));
  return lines.slice(0, 3).join(' ').slice(0, 600) || '알 수 없는 오류';
}

async function ps(script: string, args: Record<string, string | number> = {}): Promise<string> {
  // 종료 코드와 메시지를 직접 다뤄 CLIXML 없이도 오류 내용이 보이게 한다.
  const wrapped = `try {\n${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  const r = await runPowerShell(wrapped, args);
  if (r.code !== 0) throw new Error(cleanError(r.stderr));
  return r.stdout.trim();
}

async function psJson<T>(script: string, args: Record<string, string | number> = {}): Promise<T> {
  const out = await ps(script, args);
  return (out ? JSON.parse(out) : null) as T;
}

export interface VolumeInfo {
  letter: string | null;
  label: string;
  fileSystem: string;
  size: number;
  free: number;
  health: string;
}

export interface PartitionInfo {
  number: number;
  offset: number;
  size: number;
  type: string;
  letter: string | null;
  isBoot: boolean;
  isSystem: boolean;
  isHidden: boolean;
  volume: VolumeInfo | null;
}

export interface SmartInfo {
  temperature: number | null;
  readErrors: number | null;
  writeErrors: number | null;
  powerOnHours: number | null;
  wear: number | null;
}

export interface DiskInfo {
  number: number;
  name: string;
  serial: string;
  size: number;
  sectorSize: number;
  physicalSectorSize: number;
  style: string;
  busType: string;
  mediaType: string;
  isBoot: boolean;
  isSystem: boolean;
  isOffline: boolean;
  isReadOnly: boolean;
  health: string;
  guid: string;
  /** 앱이 실행 중인 디스크, 페이지 파일 등을 포함한 쓰기 금지 여부 */
  protected: boolean;
  smart: SmartInfo | null;
  partitions: PartitionInfo[];
}

const LIST_SCRIPT = String.raw`
$vols = @{}
foreach ($v in Get-Volume) { if ($v.Path) { $vols[$v.Path] = $v } }
$phys = @{}
foreach ($p in Get-PhysicalDisk) { $phys[[string]$p.DeviceId] = $p }
$pagefileDrives = @()
try { $pagefileDrives = Get-CimInstance Win32_PageFileUsage | ForEach-Object { $_.Name.Substring(0,1).ToUpper() } } catch {}
$out = foreach ($d in Get-Disk) {
  $parts = @()
  $hasPage = $false
  foreach ($p in (Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue)) {
    $vol = $null
    foreach ($ap in @($p.AccessPaths)) { if ($ap -and $vols.ContainsKey($ap)) { $vol = $vols[$ap]; break } }
    $letter = if ($p.DriveLetter -and [char]$p.DriveLetter -ne [char]0) { [string]$p.DriveLetter } else { $null }
    if ($letter -and $pagefileDrives -contains $letter.ToUpper()) { $hasPage = $true }
    $parts += [ordered]@{
      number = [int]$p.PartitionNumber; offset = [double]$p.Offset; size = [double]$p.Size; type = [string]$p.Type
      letter = $letter; isBoot = [bool]$p.IsBoot; isSystem = [bool]$p.IsSystem; isHidden = [bool]$p.IsHidden
      volume = if ($vol) { [ordered]@{ letter = $letter; label = [string]$vol.FileSystemLabel; fileSystem = [string]$vol.FileSystem; size = [double]$vol.Size; free = [double]$vol.SizeRemaining; health = [string]$vol.HealthStatus } } else { $null }
    }
  }
  $ph = $phys[[string]$d.Number]
  $smart = $null
  $media = 'Unknown'
  if ($ph) {
    $media = [string]$ph.MediaType
    try {
      $c = $ph | Get-StorageReliabilityCounter -ErrorAction Stop
      $smart = [ordered]@{ temperature = $c.Temperature; readErrors = $c.ReadErrorsTotal; writeErrors = $c.WriteErrorsTotal; powerOnHours = $c.PowerOnHours; wear = $c.Wear }
    } catch {}
  }
  [ordered]@{
    number = [int]$d.Number; name = [string]$d.FriendlyName; serial = ([string]$d.SerialNumber).Trim(); size = [double]$d.Size
    sectorSize = [int]$d.LogicalSectorSize; physicalSectorSize = [int]$d.PhysicalSectorSize
    style = [string]$d.PartitionStyle; busType = [string]$d.BusType; mediaType = $media
    isBoot = [bool]$d.IsBoot; isSystem = [bool]$d.IsSystem; isOffline = [bool]$d.IsOffline; isReadOnly = [bool]$d.IsReadOnly
    health = [string]$d.HealthStatus; guid = [string]$d.Guid; hasPageFile = $hasPage; smart = $smart; partitions = $parts
  }
}
ConvertTo-Json -InputObject @($out) -Depth 6 -Compress
`;

export async function listDisks(): Promise<DiskInfo[]> {
  const raw = await psJson<(DiskInfo & { hasPageFile: boolean })[]>(LIST_SCRIPT);
  return (raw ?? [])
    .map((d) => ({
      ...d,
      partitions: (d.partitions ?? []).sort((a, b) => a.offset - b.offset),
      protected: d.isBoot || d.isSystem || d.hasPageFile,
    }))
    .sort((a, b) => a.number - b.number);
}

export function assertPosInt(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`잘못된 값입니다: ${name}`);
  return v;
}

const FILE_SYSTEMS = ['NTFS', 'exFAT', 'FAT32', 'ReFS'] as const;
export type FileSystemName = (typeof FILE_SYSTEMS)[number];

export function assertFs(v: unknown): FileSystemName {
  if (!FILE_SYSTEMS.includes(v as FileSystemName)) throw new Error('지원하지 않는 파일시스템입니다.');
  return v as FileSystemName;
}

function cleanLabel(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > 32) throw new Error('볼륨 레이블이 너무 깁니다.');
  return v;
}

export async function initializeDisk(disk: number, style: 'GPT' | 'MBR'): Promise<void> {
  if (style !== 'GPT' && style !== 'MBR') throw new Error('잘못된 파티션 형식입니다.');
  await ps(`Initialize-Disk -Number ([int]$env:HDDR_DISK) -PartitionStyle $env:HDDR_STYLE`, { DISK: disk, STYLE: style });
}

/** 파티션 테이블과 모든 볼륨을 지운다. 이후 Initialize로 새 테이블을 만든다. */
export async function clearDisk(disk: number): Promise<void> {
  await ps(`Clear-Disk -Number ([int]$env:HDDR_DISK) -RemoveData -RemoveOEM -Confirm:$false`, { DISK: disk });
}

export async function createPartition(
  disk: number,
  opts: { offset?: number; size?: number; fs?: FileSystemName; label?: string; quick?: boolean; allocationUnit?: number },
): Promise<void> {
  const args: Record<string, string | number> = { DISK: disk, LABEL: cleanLabel(opts.label) };
  let sizeArg = '-UseMaximumSize';
  if (opts.size !== undefined) {
    args.SIZE = assertPosInt(opts.size, 'size');
    sizeArg = '-Size ([int64]$env:HDDR_SIZE)';
  }
  if (opts.offset !== undefined) {
    args.OFFSET = assertPosInt(opts.offset, 'offset');
    sizeArg += ' -Offset ([int64]$env:HDDR_OFFSET)';
  }
  let fmt = '';
  if (opts.fs) {
    args.FS = assertFs(opts.fs);
    args.AU = opts.allocationUnit ? assertPosInt(opts.allocationUnit, 'allocationUnit') : 0;
    fmt = `
$fmt = @{ FileSystem = $env:HDDR_FS; NewFileSystemLabel = $env:HDDR_LABEL; Confirm = $false; Force = $true }
if ([int]$env:HDDR_AU -gt 0) { $fmt.AllocationUnitSize = [int]$env:HDDR_AU }
${opts.quick === false ? '$fmt.Full = $true' : ''}
Format-Volume -Partition $p @fmt | Out-Null`;
  }
  await ps(`$p = New-Partition -DiskNumber ([int]$env:HDDR_DISK) ${sizeArg} -AssignDriveLetter${fmt}`, args);
}

export async function formatPartition(
  disk: number,
  partition: number,
  opts: { fs: FileSystemName; label?: string; quick: boolean; allocationUnit?: number },
): Promise<void> {
  const args = {
    DISK: disk,
    PART: partition,
    FS: assertFs(opts.fs),
    LABEL: cleanLabel(opts.label),
    AU: opts.allocationUnit ? assertPosInt(opts.allocationUnit, 'allocationUnit') : 0,
  };
  await ps(
    `
$p = Get-Partition -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_PART)
$fmt = @{ FileSystem = $env:HDDR_FS; NewFileSystemLabel = $env:HDDR_LABEL; Confirm = $false; Force = $true }
if ([int]$env:HDDR_AU -gt 0) { $fmt.AllocationUnitSize = [int]$env:HDDR_AU }
${opts.quick ? '' : '$fmt.Full = $true'}
Format-Volume -Partition $p @fmt | Out-Null`,
    args,
  );
}

export async function deletePartition(disk: number, partition: number): Promise<void> {
  await ps(`Remove-Partition -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_PART) -Confirm:$false`, {
    DISK: disk,
    PART: partition,
  });
}

export async function supportedSize(disk: number, partition: number): Promise<{ min: number; max: number }> {
  const r = await psJson<{ min: number; max: number }>(
    `$s = Get-PartitionSupportedSize -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_PART)
[ordered]@{ min = [double]$s.SizeMin; max = [double]$s.SizeMax } | ConvertTo-Json -Compress`,
    { DISK: disk, PART: partition },
  );
  return r;
}

export async function resizePartition(disk: number, partition: number, size: number): Promise<void> {
  await ps(`Resize-Partition -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_PART) -Size ([int64]$env:HDDR_SIZE) -Confirm:$false`, {
    DISK: disk,
    PART: partition,
    SIZE: assertPosInt(size, 'size'),
  });
}

/**
 * 분할: 파티션을 축소하고 비는 공간에 새 파티션을 만든다.
 * 축소는 NTFS에서 데이터를 유지한 채 가능하다.
 */
export async function splitPartition(
  disk: number,
  partition: number,
  opts: { firstSize: number; fs: FileSystemName; label?: string },
): Promise<void> {
  const range = await supportedSize(disk, partition);
  if (opts.firstSize < range.min) {
    throw new Error(`이 파티션은 데이터 때문에 ${Math.ceil(range.min / 1024 / 1024).toLocaleString()} MiB 아래로 줄일 수 없습니다.`);
  }
  const cur = await psJson<{ offset: number; size: number }>(
    `$p = Get-Partition -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_PART)
[ordered]@{ offset = [double]$p.Offset; size = [double]$p.Size } | ConvertTo-Json -Compress`,
    { DISK: disk, PART: partition },
  );
  // 새 파티션은 원래 파티션이 차지하던 자리 안에만 만든다. 뒤쪽 미할당 공간은 건드리지 않는다.
  const MiB = 1024 * 1024;
  const newOffset = Math.ceil((cur.offset + opts.firstSize) / MiB) * MiB;
  const oldEnd = cur.offset + cur.size;
  const newSize = Math.floor((oldEnd - newOffset) / MiB) * MiB;
  if (newSize < 16 * MiB) throw new Error('새 파티션에 쓸 공간이 너무 작습니다.');
  await resizePartition(disk, partition, opts.firstSize);
  await createPartition(disk, { offset: newOffset, size: newSize, fs: opts.fs, label: opts.label, quick: true });
}

export interface MergeProgress {
  (message: string): void;
}

/**
 * 통합: 오른쪽 파티션을 지우고 왼쪽 파티션을 그 공간까지 확장한다.
 * preserve가 true면 지우기 전에 오른쪽 파티션의 파일을 왼쪽의 폴더로 먼저 복사하고,
 * 복사에 실패하면 아무것도 지우지 않는다.
 */
export async function mergePartitions(
  disk: number,
  left: number,
  right: number,
  preserve: boolean,
  progress: MergeProgress,
): Promise<{ copiedTo?: string }> {
  const info = await psJson<{
    lOff: number;
    lSize: number;
    rOff: number;
    rSize: number;
    lLetter: string;
    rLetter: string;
    lFs: string;
    lFree: number;
    rUsed: number;
  }>(
    `
$l = Get-Partition -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_L)
$r = Get-Partition -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_R)
$lv = $l | Get-Volume -ErrorAction SilentlyContinue
$rv = $r | Get-Volume -ErrorAction SilentlyContinue
[ordered]@{
  lOff = [double]$l.Offset; lSize = [double]$l.Size; rOff = [double]$r.Offset; rSize = [double]$r.Size
  lLetter = if ($l.DriveLetter -and [char]$l.DriveLetter -ne [char]0) { [string]$l.DriveLetter } else { '' }
  rLetter = if ($r.DriveLetter -and [char]$r.DriveLetter -ne [char]0) { [string]$r.DriveLetter } else { '' }
  lFs = if ($lv) { [string]$lv.FileSystem } else { '' }
  lFree = if ($lv) { [double]$lv.SizeRemaining } else { 0 }
  rUsed = if ($rv) { [double]($rv.Size - $rv.SizeRemaining) } else { 0 }
} | ConvertTo-Json -Compress`,
    { DISK: disk, L: left, R: right },
  );
  if (info.lFs !== 'NTFS') throw new Error('왼쪽 파티션이 NTFS여야 데이터를 유지한 채 확장할 수 있습니다.');
  if (info.lOff + info.lSize > info.rOff || info.rOff - (info.lOff + info.lSize) > 16 * 1024 * 1024) {
    throw new Error('두 파티션이 바로 옆에 붙어 있지 않아 통합할 수 없습니다.');
  }
  let copiedTo: string | undefined;
  if (preserve) {
    if (!info.lLetter || !info.rLetter) throw new Error('데이터를 옮기려면 두 파티션 모두 드라이브 문자가 있어야 합니다.');
    if (info.lFree < info.rUsed * 1.02) throw new Error('왼쪽 파티션에 오른쪽 파티션 데이터를 담을 공간이 부족합니다.');
    const dest = `${info.lLetter}:\\통합된_${info.rLetter}_드라이브`;
    progress(`${info.rLetter}: 드라이브의 파일을 ${dest}로 복사 중`);
    const r = await runPowerShell(
      `
& robocopy.exe $env:HDDR_SRC $env:HDDR_DST /E /COPY:DAT /DCOPY:T /R:1 /W:1 /XJ /XD '$RECYCLE.BIN' 'System Volume Information' /NFL /NDL /NP | Out-Null
exit $LASTEXITCODE`,
      { SRC: `${info.rLetter}:\\`, DST: dest },
    );
    // robocopy는 8 미만이면 성공이다.
    if (r.code >= 8 || r.code < 0) {
      throw new Error(`파일 복사에 실패해(코드 ${r.code}) 통합을 중단했습니다. 어떤 파티션도 지우지 않았습니다.`);
    }
    copiedTo = dest;
  }
  progress('오른쪽 파티션 삭제 중');
  await deletePartition(disk, right);
  progress('왼쪽 파티션 확장 중');
  // 오른쪽 파티션이 있던 자리까지만 넓힌다(그 뒤의 미할당 공간은 건드리지 않는다).
  const targetSize = info.rOff + info.rSize - info.lOff;
  await ps(
    `Update-Disk -Number ([int]$env:HDDR_DISK)
$s = Get-PartitionSupportedSize -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_L)
$size = [Math]::Min([int64]$env:HDDR_SIZE, [int64]$s.SizeMax)
Resize-Partition -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_L) -Size $size -Confirm:$false`,
    { DISK: disk, L: left, SIZE: targetSize },
  );
  return { copiedTo };
}

export async function setDriveLetter(disk: number, partition: number, letter: string | null): Promise<void> {
  if (letter !== null && !/^[A-Za-z]$/.test(letter)) throw new Error('잘못된 드라이브 문자입니다.');
  if (letter) {
    await ps(`Set-Partition -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_PART) -NewDriveLetter $env:HDDR_LETTER`, {
      DISK: disk,
      PART: partition,
      LETTER: letter.toUpperCase(),
    });
  } else {
    await ps(`Add-PartitionAccessPath -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_PART) -AssignDriveLetter`, {
      DISK: disk,
      PART: partition,
    });
  }
}

export async function setVolumeLabel(disk: number, partition: number, label: string): Promise<void> {
  await ps(`Get-Partition -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_PART) | Get-Volume | Set-Volume -NewFileSystemLabel $env:HDDR_LABEL`, {
    DISK: disk,
    PART: partition,
    LABEL: cleanLabel(label),
  });
}

export async function checkVolume(disk: number, partition: number, fix: boolean): Promise<string> {
  // Repair-Volume은 NTFS/ReFS만 지원하므로 FAT 계열은 chkdsk를 쓴다. 결과는 언어와 무관하게 종료 코드로 판단한다.
  return ps(
    `
$p = Get-Partition -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_PART)
$v = $p | Get-Volume
if ($v.FileSystem -in 'NTFS','ReFS') {
  [string]($v | Repair-Volume ${fix ? '-OfflineScanAndFix' : '-Scan'} -ErrorAction Stop)
} else {
  if (-not $v.DriveLetter) { throw '이 파일시스템을 검사하려면 드라이브 문자가 필요합니다.' }
  & chkdsk.exe "$($v.DriveLetter):" ${fix ? '/f /x' : ''} | Out-Null
  $code = $LASTEXITCODE
  if ($code -eq 0) { 'NoErrorsFound' } elseif ($code -eq 1 -and ${fix ? '$true' : '$false'}) { 'ErrorsFixed' } else { 'ErrorsFound' }
}`,
    { DISK: disk, PART: partition },
  );
}

export async function setDiskOnline(disk: number, online: boolean): Promise<void> {
  await ps(`Set-Disk -Number ([int]$env:HDDR_DISK) -IsOffline:$${online ? 'false' : 'true'}`, { DISK: disk });
}

export async function setDiskReadOnly(disk: number, readOnly: boolean): Promise<void> {
  await ps(`Set-Disk -Number ([int]$env:HDDR_DISK) -IsReadOnly:$${readOnly ? 'true' : 'false'}`, { DISK: disk });
}

export async function refreshDisk(disk: number): Promise<void> {
  await ps(`Update-Disk -Number ([int]$env:HDDR_DISK); Update-HostStorageCache`, { DISK: disk });
}

export async function setMbrType(disk: number, partition: number, mbrType: number): Promise<void> {
  await ps(`Set-Partition -DiskNumber ([int]$env:HDDR_DISK) -PartitionNumber ([int]$env:HDDR_PART) -MbrType ([int]$env:HDDR_T)`, {
    DISK: disk,
    PART: partition,
    T: assertPosInt(mbrType, 'mbrType'),
  });
}

/**
 * 원시 쓰기를 위해 디스크를 오프라인으로 전환한 뒤 작업을 수행하고, 항상 온라인으로 되돌린다.
 * Windows는 마운트된 볼륨 범위의 원시 쓰기를 막기 때문에 필요하다.
 */
export async function withRawWriteAccess<T>(disk: number, fn: () => Promise<T>): Promise<T> {
  await setDiskOnline(disk, false);
  try {
    await setDiskReadOnly(disk, false);
    return await fn();
  } finally {
    await setDiskOnline(disk, true).catch(() => {});
    await setDiskReadOnly(disk, false).catch(() => {});
    await refreshDisk(disk).catch(() => {});
  }
}

export async function isElevated(): Promise<boolean> {
  const out = await ps(
    `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`,
  );
  return out.trim().toLowerCase() === 'true';
}

/** 경로가 어느 물리 디스크에 있는지 찾는다(복구 저장 위치 검사용). 네트워크 경로 등은 null. */
export async function diskNumberOfPath(path: string): Promise<number | null> {
  const m = /^([A-Za-z]):/.exec(path);
  if (!m) return null;
  const out = await ps(
    `$p = Get-Partition -DriveLetter $env:HDDR_L -ErrorAction SilentlyContinue
if ($p) { [string]$p.DiskNumber }`,
    { L: m[1].toUpperCase() },
  );
  return out === '' ? null : Number(out);
}
