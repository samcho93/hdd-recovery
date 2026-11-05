// Electron 앱을 실제로 띄워 이미지 파일 대상으로 복구/복원 흐름을 조작한다.
// 실제 디스크에는 어떤 쓰기도 하지 않는다(시스템 디스크의 관리 화면은 비활성 상태만 확인).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { _electron as electron } from 'playwright-core';

const shotDir = resolve('test-output/screens');
mkdirSync(shotDir, { recursive: true });
const work = mkdtempSync(join(process.env.E2E_DIR ?? tmpdir(), 'hddr-e2e-'));
const manifest = JSON.parse(readFileSync('test/fixtures/manifest.json', 'utf8').replace(/^﻿/, ''));

const disk = gunzipSync(readFileSync('test/fixtures/disk.vhd.gz'));
const imagePath = join(work, 'healthy.vhd');
writeFileSync(imagePath, disk);

// 파일시스템 부트 섹터를 지운 손상 이미지
const damaged = Buffer.from(disk);
damaged.fill(0, manifest.ntfs.offset, manifest.ntfs.offset + 512);
const damagedPath = join(work, 'damaged.vhd');
writeFileSync(damagedPath, damaged);

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const app = await electron.launch({ args: ['.'] });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const setDialogs = (open, folder, save) =>
  app.evaluate(
    ({ dialog }, a) => {
      dialog.showOpenDialog = async (_w, opts) => {
        const isFolder = opts?.properties?.includes('openDirectory');
        return { canceled: false, filePaths: [isFolder ? a.folder : a.open] };
      };
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: a.save });
    },
    { open, folder, save },
  );

const shot = (name) => page.screenshot({ path: join(shotDir, `${name}.png`) });

try {
  await page.waitForSelector('.disk-item', { timeout: 60000 });
  const diskCount = await page.locator('.disk-item').count();
  check('실제 디스크 목록 표시', diskCount >= 1, `${diskCount}개`);
  await page.waitForTimeout(300);
  await shot('01-overview');

  // ── 시스템 디스크 보호 ──
  const sysDisk = page.locator('.disk-item', { hasText: '시스템' }).first();
  await sysDisk.click();
  await page.getByRole('tab', { name: '디스크 관리' }).click();
  await page.waitForTimeout(200);
  check('시스템 디스크 경고 표시', await page.getByText('이 디스크의 변경 작업은 막아 두었습니다').isVisible());
  const formatBtns = page.getByRole('button', { name: '포맷', exact: true });
  const nBtns = await formatBtns.count();
  let allDisabled = nBtns > 0;
  for (let i = 0; i < nBtns; i++) allDisabled &&= await formatBtns.nth(i).isDisabled();
  check('시스템 디스크의 포맷 버튼 비활성', allDisabled, `${nBtns}개`);
  await shot('02-manage-protected');

  // ── 이미지 열기 + 빠른 스캔 ──
  const out = join(work, 'recovered');
  await setDialogs(imagePath, out, join(work, 'x.img'));
  mkdirSync(out);
  await page.getByRole('button', { name: '이미지 파일 열기…' }).click();
  await page.getByRole('button', { name: '빠른 스캔' }).click();
  await page.getByText('찾은 볼륨').waitFor();
  const rows = page.locator('.panel', { hasText: '찾은 볼륨' }).locator('tbody tr');
  check('스캔: 볼륨 3개 표시', (await rows.count()) === 3, `${await rows.count()}개`);
  await shot('03-scan');

  // ── NTFS 파일 보기 ──
  await rows.filter({ hasText: 'NTFS' }).getByRole('button', { name: '파일 보기' }).click();
  await page.getByText('NTFS 파일 목록').waitFor();
  await page.getByRole('button', { name: /media/ }).waitFor();
  await shot('04-files');
  check('폴더 표시', await page.getByRole('button', { name: /한글 폴더/ }).isVisible());
  check('삭제된 폴더 표시', (await page.locator('tr.deleted', { hasText: 'to-delete' }).count()) === 1);

  // 폴더 이동
  await page.getByRole('button', { name: /to-delete/ }).click();
  await page.locator('tr', { hasText: 'deleted-big.bin' }).waitFor();
  check('삭제 파일 표시', await page.locator('tr.deleted', { hasText: 'deleted-big.bin' }).isVisible());
  await page.getByRole('button', { name: '↑ 상위' }).click();

  // 검색
  await page.getByLabel('파일 이름 검색').fill('보고서');
  await page.locator('tr', { hasText: '보고서.txt' }).waitFor();
  check('검색 결과 경로 표시', await page.locator('tr', { hasText: '한글 폴더\\보고서.txt' }).isVisible());
  await page.getByLabel('파일 이름 검색').fill('');
  await page.getByRole('button', { name: /media/ }).waitFor();

  // 복구 저장
  await page.getByLabel('to-delete 선택').check();
  await page.getByLabel('frag-a.bin 선택').check();
  await page.getByRole('button', { name: '선택 항목 복구' }).click();
  await page.getByText(/개 복구 \(/).waitFor({ timeout: 60000 });
  await shot('05-recovered');
  const want = manifest.ntfs.files.find((f) => f.path === 'to-delete\\deleted-big.bin').sha256;
  const got = createHash('sha256').update(readFileSync(join(out, 'to-delete', 'deleted-big.bin'))).digest('hex');
  check('UI로 복구한 삭제 파일 해시 일치', got === want);
  const wantFrag = manifest.ntfs.files.find((f) => f.path === 'frag-a.bin').sha256;
  const gotFrag = createHash('sha256').update(readFileSync(join(out, 'frag-a.bin'))).digest('hex');
  check('UI로 복구한 조각 파일 해시 일치', gotFrag === wantFrag);

  // ── 서명 스캔 ──
  await page.getByRole('button', { name: '서명 스캔…' }).click();
  await page.getByRole('button', { name: '서명 스캔 시작' }).click();
  await page.getByText('서명 스캔 파일 목록').waitFor({ timeout: 60000 });
  check('서명 스캔: 형식별 폴더 표시', await page.getByRole('button', { name: /JPG/ }).isVisible());
  await shot('06-carve');

  // ── 손상 이미지 진단과 복원 ──
  await setDialogs(damagedPath, out, join(work, 'x.img'));
  await page.getByRole('button', { name: '이미지 파일 열기…' }).click();
  await page.getByRole('tab', { name: '구조 복원' }).click();
  await page.getByRole('button', { name: '빠른 진단' }).click();
  await page.getByText('복원 항목').waitFor({ timeout: 30000 });
  await shot('07-diagnose');
  const repairBtn = page.locator('.action-card', { hasText: '백업 부트 섹터로 복원' }).getByRole('button', { name: '복원' });
  check('손상 진단: 백업 부트 복원 제안', await repairBtn.isVisible());
  await repairBtn.click();
  const confirmBtn = page.getByRole('button', { name: '복원 실행' });
  check('확인 문구 입력 전에는 실행 불가', await confirmBtn.isDisabled());
  await shot('08-confirm');
  await page.locator('#confirm-input').fill('틀린 문구');
  check('틀린 문구로는 실행 불가', await confirmBtn.isDisabled());
  await page.locator('#confirm-input').fill('IMAGE');
  await confirmBtn.click();
  await page.getByText('구조에서 문제를 찾지 못했습니다.').waitFor({ timeout: 30000 });
  const repaired = readFileSync(damagedPath).subarray(manifest.ntfs.offset, manifest.ntfs.offset + 512);
  check('복원 후 이미지의 부트 섹터가 원본과 일치', repaired.equals(disk.subarray(manifest.ntfs.offset, manifest.ntfs.offset + 512)));
  await shot('09-repaired');

  // 되돌리기
  await page.getByRole('button', { name: '되돌리기', exact: true }).first().click();
  await page.locator('#confirm-input').fill('IMAGE');
  await page.locator('.modal').getByRole('button', { name: '되돌리기' }).click();
  await page.getByText('이전 상태로 되돌렸습니다.').waitFor({ timeout: 15000 });
  const undone = readFileSync(damagedPath).subarray(manifest.ntfs.offset, manifest.ntfs.offset + 512);
  check('되돌리기 후 손상 상태로 복귀', undone.every((b) => b === 0));

  // ── 이미지 생성은 실제 디스크 대신 건너뛴다. 복구 탭의 취소 동작 확인 ──
  await page.getByRole('tab', { name: '복구' }).click();
  await page.getByRole('button', { name: '정밀 스캔' }).click();
  await page.locator('.jobbar').waitFor({ timeout: 5000 }).catch(() => {});
  const cancel = page.locator('.jobbar').getByRole('button', { name: '취소' });
  if (await cancel.isVisible().catch(() => false)) await cancel.click().catch(() => {});
  await page.waitForTimeout(800);

  // 레이아웃 넘침 확인
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('가로 넘침 없음', !overflow);
  await page.setViewportSize?.({ width: 980, height: 640 }).catch(() => {});
  check('화면 스크립트 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('시나리오 완료', false, e.message);
  await shot('zz-failure').catch(() => {});
} finally {
  await app.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n통과 ${results.length - failed} / ${results.length}`);
process.exit(failed ? 1 : 0);
