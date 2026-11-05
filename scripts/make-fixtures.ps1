# Windows가 직접 포맷한 NTFS/exFAT/FAT32가 들어 있는 테스트용 디스크 이미지를 만든다.
# 관리자 권한 필요. 임시 VHD만 다루며, 실제 디스크는 건드리지 않는다.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'test\fixtures'
New-Item -ItemType Directory -Force $outDir | Out-Null
$work = Join-Path $env:TEMP "hddr-fixture-$PID"
New-Item -ItemType Directory -Force $work | Out-Null
$vhd = Join-Path $work 'disk.vhd'

function Invoke-DiskPart([string[]]$lines) {
  $f = Join-Path $work 'dp.txt'
  $lines | Set-Content -Encoding ascii $f
  $o = diskpart /s $f
  if ($LASTEXITCODE -ne 0) { throw "diskpart 실패: $o" }
}

$manifest = [ordered]@{}
$rng = [Random]::new(20261105)

function New-Bytes([int]$n) { $b = New-Object byte[] $n; $rng.NextBytes($b); return ,$b }
function Get-Sha([byte[]]$b) {
  $s = [Security.Cryptography.SHA256]::Create()
  return ([BitConverter]::ToString($s.ComputeHash($b)) -replace '-', '').ToLower()
}
function Write-Tracked($vol, [string]$rel, [byte[]]$data, [string]$kind) {
  $p = Join-Path $vol.root $rel
  New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null
  [IO.File]::WriteAllBytes($p, $data)
  $vol.files += [ordered]@{ path = $rel; sha256 = (Get-Sha $data); size = $data.Length; kind = $kind }
}
function New-Jpeg([int]$n) {
  # SOI + APP0 + SOS + 엔트로피 데이터(FF D9 없음) + EOI
  $b = New-Bytes $n
  for ($i = 0; $i -lt $n - 1; $i++) { if ($b[$i] -eq 0xFF) { $b[$i] = 0xFE } }
  $b[0] = 0xFF; $b[1] = 0xD8; $b[2] = 0xFF; $b[3] = 0xE0; $b[4] = 0; $b[5] = 16
  [byte[]][char[]]'JFIF' | ForEach-Object -Begin { $k = 6 } -Process { $b[$k] = $_; $k++ }
  $b[20] = 0xFF; $b[21] = 0xDA
  $b[$n - 2] = 0xFF; $b[$n - 1] = 0xD9
  return ,$b
}
function New-Pdf([int]$n) {
  $b = New-Bytes $n
  $h = [Text.Encoding]::ASCII.GetBytes('%PDF-1.7')
  [Array]::Copy($h, $b, $h.Length)
  for ($i = 8; $i -lt $n - 6; $i++) { if ($b[$i] -eq 0x25) { $b[$i] = 0x24 } }
  $t = [Text.Encoding]::ASCII.GetBytes('%%EOF')
  [Array]::Copy($t, 0, $b, $n - 5, 5)
  return ,$b
}

function Fill-Common($vol) {
  Write-Tracked $vol 'hello.txt' ([Text.Encoding]::UTF8.GetBytes('작은 파일 내용입니다.')) 'active'
  Write-Tracked $vol '한글 폴더\보고서.txt' ([Text.Encoding]::UTF8.GetBytes(('복구 시험 문장. ' * 2000))) 'active'
  Write-Tracked $vol 'docs\sub\deep\random.bin' (New-Bytes 300000) 'active'
  Write-Tracked $vol 'media\photo.jpg' (New-Jpeg 120000) 'active'
  Write-Tracked $vol 'media\manual.pdf' (New-Pdf 80000) 'active'
  Write-Tracked $vol 'a-very-long-file-name-that-does-not-fit-in-eight-dot-three.dat' (New-Bytes 5000) 'active'
  Write-Tracked $vol 'to-delete\deleted-small.txt' ([Text.Encoding]::UTF8.GetBytes('삭제될 작은 파일')) 'deleted'
  Write-Tracked $vol 'to-delete\deleted-big.bin' (New-Bytes 250000) 'deleted'
  Write-Tracked $vol 'keep\removed-photo.jpg' (New-Jpeg 90000) 'deleted'
  for ($i = 0; $i -lt 300; $i++) {
    $d = [Text.Encoding]::ASCII.GetBytes("small file number $i`r`n")
    $p = Join-Path $vol.root "bulk\f$i.txt"
    New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null
    [IO.File]::WriteAllBytes($p, $d)
  }
  $vol.bulkCount = 300
}

function Remove-Tracked($vol) {
  Remove-Item -Force (Join-Path $vol.root 'keep\removed-photo.jpg')
  Remove-Item -Force -Recurse (Join-Path $vol.root 'to-delete')
}

Invoke-DiskPart @("create vdisk file=`"$vhd`" maximum=128 type=fixed", "select vdisk file=`"$vhd`"", 'attach vdisk')
try {
  $disk = Get-DiskImage -ImagePath $vhd | Get-Disk
  if ($disk.FriendlyName -notmatch 'Virtual Disk' -or $disk.Size -gt 200MB) { throw "가상 디스크가 아닙니다: $($disk.FriendlyName)" }
  $n = $disk.Number
  Write-Host "임시 VHD = 디스크 $n"
  Initialize-Disk -Number $n -PartitionStyle GPT
  # 탐색기 팝업/자동 할당을 피하려고 AccessPath를 직접 지정한다.
  $vols = @()
  $spec = @(
    @{ key = 'ntfs'; fs = 'NTFS'; size = 56MB; label = 'FIXNTFS' },
    @{ key = 'exfat'; fs = 'exFAT'; size = 16MB; label = 'FIXEX' },
    @{ key = 'fat32'; fs = 'FAT32'; size = 40MB; label = 'FIXFAT' }
  )
  foreach ($s in $spec) {
    $part = New-Partition -DiskNumber $n -Size $s.size
    Format-Volume -Partition $part -FileSystem $s.fs -NewFileSystemLabel $s.label -Confirm:$false -Force | Out-Null
    $mp = Join-Path $work $s.key
    New-Item -ItemType Directory -Force $mp | Out-Null
    Add-PartitionAccessPath -DiskNumber $n -PartitionNumber $part.PartitionNumber -AccessPath "$mp\"
    $vols += [pscustomobject]@{ key = $s.key; fs = $s.fs; root = $mp; files = @(); bulkCount = 0; offset = [int64]$part.Offset; size = [int64]$part.Size; partNo = $part.PartitionNumber }
  }

  foreach ($v in $vols) { Fill-Common $v }

  # NTFS 전용: 압축, 희소, 조각난 파일(속성 목록 유도)
  $ntfs = $vols | Where-Object key -eq 'ntfs'
  $cp = Join-Path $ntfs.root 'compressed\lznt1.txt'
  New-Item -ItemType Directory -Force (Split-Path $cp) | Out-Null
  $sb = [Text.StringBuilder]::new()
  for ($i = 0; $i -lt 40000; $i++) { [void]$sb.Append("line $($i % 97) of compressible text`r`n") }
  $cdata = [Text.Encoding]::ASCII.GetBytes($sb.ToString())
  [IO.File]::WriteAllBytes($cp, $cdata)
  $o = compact /c /a /i (Split-Path $cp) (Join-Path (Split-Path $cp) '*')
  $ntfs.files += [ordered]@{ path = 'compressed\lznt1.txt'; sha256 = (Get-Sha $cdata); size = $cdata.Length; kind = 'active' }

  $sp = Join-Path $ntfs.root 'sparse.bin'
  [IO.File]::WriteAllBytes($sp, [byte[]]@())
  fsutil sparse setflag $sp | Out-Null
  $fs = [IO.File]::OpenWrite($sp)
  $fs.SetLength(3000000)
  $mark = [Text.Encoding]::ASCII.GetBytes('SPARSE-TAIL')
  $fs.Seek(2900000, 'Begin') | Out-Null
  $fs.Write($mark, 0, $mark.Length)
  $fs.Close()
  fsutil sparse setrange $sp 0 2900000 | Out-Null
  $spBytes = New-Object byte[] 3000000
  [Array]::Copy($mark, 0, $spBytes, 2900000, $mark.Length)
  $ntfs.files += [ordered]@{ path = 'sparse.bin'; sha256 = (Get-Sha $spBytes); size = 3000000; kind = 'active' }

  # 두 파일에 번갈아 동기 쓰기를 해서 조각을 만든다.
  $fa = [IO.FileStream]::new((Join-Path $ntfs.root 'frag-a.bin'), 'Create', 'Write', 'None', 4096, 'WriteThrough')
  $fb = [IO.FileStream]::new((Join-Path $ntfs.root 'frag-b.bin'), 'Create', 'Write', 'None', 4096, 'WriteThrough')
  $msA = [IO.MemoryStream]::new(); $msB = [IO.MemoryStream]::new()
  for ($i = 0; $i -lt 1500; $i++) {
    $blk = New-Object byte[] 4096
    [BitConverter]::GetBytes($i).CopyTo($blk, 0)
    $blk[8] = 0xAA; $fa.Write($blk, 0, 4096); $fa.Flush($true); $msA.Write($blk, 0, 4096)
    $blk[8] = 0xBB; $fb.Write($blk, 0, 4096); $fb.Flush($true); $msB.Write($blk, 0, 4096)
  }
  $fa.Close(); $fb.Close()
  $ntfs.files += [ordered]@{ path = 'frag-a.bin'; sha256 = (Get-Sha $msA.ToArray()); size = [int]$msA.Length; kind = 'active' }
  $ntfs.files += [ordered]@{ path = 'frag-b.bin'; sha256 = (Get-Sha $msB.ToArray()); size = [int]$msB.Length; kind = 'active' }

  foreach ($v in $vols) { Remove-Tracked $v }
  foreach ($v in $vols) {
    Write-VolumeCache -Path "$($v.root)\" -ErrorAction SilentlyContinue
    Remove-PartitionAccessPath -DiskNumber $n -PartitionNumber $v.partNo -AccessPath "$($v.root)\"
    $manifest[$v.key] = [ordered]@{ fs = $v.fs; offset = $v.offset; size = $v.size; bulkCount = $v.bulkCount; files = $v.files }
  }
}
finally {
  Invoke-DiskPart @("select vdisk file=`"$vhd`"", 'detach vdisk')
}

$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $outDir 'manifest.json')
$in = [IO.File]::OpenRead($vhd)
$out = [IO.File]::Create((Join-Path $outDir 'disk.vhd.gz'))
$gz = [IO.Compression.GZipStream]::new($out, [IO.Compression.CompressionLevel]::Optimal)
$in.CopyTo($gz)
$gz.Close(); $out.Close(); $in.Close()
Remove-Item -Recurse -Force $work
Get-Item (Join-Path $outDir '*') | Select-Object Name, Length
