// ブラウザでの通し確認。偽のカメラを持つ Chromium で、撮影から保存までを実際に動かす。
//
//   npm i -D playwright && node tests/e2e.mjs
//   （ブラウザの場所が違う場合は PW_CHROMIUM=/path/to/chrome を指定する）
//
// Safari ではなく Chromium での確認なので、解像度や音、許可といった iOS 固有の挙動は
// diag.html を実機で動かして確かめる。ここで守るのは、撮影から書き出しまでの配線と、
// GPU で動く処理が CPU の実装と一致していることの 2 点。
//
// 上下の向きは、診断ページの照合（ImageBitmap を入力にしたもの）で確認している。
// 撮影結果どうしを見比べる方法も試したが、偽のカメラの絵が上下に対称で判別できなかった。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8123);
const BASE = `http://localhost:${PORT}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, BASE);
    const file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

let failures = 0;
const log = (...a) => console.log(...a);
const check = (name, cond, extra = '') => {
  if (cond) log(`  ok  ${name}`);
  else { failures += 1; log(`FAIL  ${name} ${extra}`); }
};

const server = await serve();
const { chromium } = await import('playwright');

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({
  permissions: ['camera'],
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const shotInfo = () => page.evaluate(() => ({
  w: document.getElementById('shot').naturalWidth,
  h: document.getElementById('shot').naturalHeight,
  meta: document.getElementById('shotMeta').textContent,
}));


await page.goto(`${BASE}/index.html`);

// 開始ボタンを押さなくてもカメラが開くこと。操作の回数を減らすための要
const autoStarted = await page
  .waitForFunction(() => !document.getElementById('shutter').disabled, null, { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
check('起動と同時にカメラが開く', autoStarted);
if (!autoStarted) {
  await page.click('#startBtn');
  await page.waitForFunction(() => !document.getElementById('shutter').disabled, null, { timeout: 15000 });
}

check('解像度が画面に表示される', /\d+×\d+/.test(await page.textContent('#statusChip')));
check('最初の説明画面が隠れる', await page.locator('#start').evaluate((e) => e.classList.contains('hidden')));

// 通常撮影
await page.click('#shutter');
await page.waitForSelector('#overlay.open', { timeout: 15000 });
const single = await shotInfo();
check('通常撮影で画像ができる', single.w > 0 && single.h > 0, JSON.stringify(single));
log(`      → ${single.meta}`);
await page.click('#discardBtn');

// 合成撮影
await page.click('#settingsBtn');
await page.locator('#framesInput').evaluate((el) => {
  el.value = '6';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#closeSheet');
await page.click('#modeStack');
await page.click('#shutter');
await page.waitForSelector('#overlay.open', { timeout: 40000 });
const stacked = await shotInfo();
check('合成撮影で画像ができる', stacked.w > 0 && stacked.h > 0, JSON.stringify(stacked));
check('合成に複数枚採用されている', /[2-9]\d* \/ \d+ 枚を採用/.test(stacked.meta), stacked.meta);
log(`      → ${stacked.meta}`);
await page.click('#discardBtn');

// 解像度が高いときは、2 倍にする処理を行わない
await page.click('#settingsBtn');
await page.locator('#drizzleInput').check();
await page.click('#closeSheet');
await page.click('#shutter');
await page.waitForSelector('#overlay.open', { timeout: 40000 });
const capped = await shotInfo();
check('4K では解像度 2 倍を行わない', capped.w === stacked.w && !/解像度 2 倍/.test(capped.meta),
  JSON.stringify(capped));
log(`      → ${capped.meta}`);
await page.click('#discardBtn');

// 720p なら 2 倍にする処理が効く
await page.click('#settingsBtn');
await page.selectOption('#resolutionSelect', '1280x720');
await page.click('#closeSheet');
await page.waitForFunction(() => /1280×720/.test(document.getElementById('statusChip').textContent),
  null, { timeout: 15000 });
await page.click('#shutter');
await page.waitForSelector('#overlay.open', { timeout: 40000 });
const drizzled = await shotInfo();
check('720p では解像度 2 倍が効く',
  drizzled.w === 2560 && drizzled.h === 1440 && /解像度 2 倍/.test(drizzled.meta), JSON.stringify(drizzled));
log(`      → ${drizzled.meta}`);
await page.click('#discardBtn');

// 写真API（Chromium も takePhoto に対応している）
await page.click('#modePhoto');
await page.click('#shutter');
const photoOk = await page.waitForSelector('#overlay.open', { timeout: 20000 }).then(() => true).catch(() => false);
check('写真API 撮影が確認なしで動く', photoOk);
if (photoOk) {
  log(`      → ${(await shotInfo()).meta}`);
  await page.click('#discardBtn');
}

// 設定画面は背景を押しても閉じる
await page.click('#settingsBtn');
await page.waitForSelector('#sheet.open');
await page.click('#sheetBackdrop', { position: { x: 10, y: 10 } });
const sheetClosed = await page
  .waitForFunction(() => !document.getElementById('sheet').classList.contains('open'), null, { timeout: 3000 })
  .then(() => true)
  .catch(() => false);
check('設定画面は背景を押すと閉じる', sheetClosed);

// 保存すると撮影結果の表示が閉じる
await page.click('#modeFrame');
await page.click('#shutter');
await page.waitForSelector('#overlay.open', { timeout: 15000 });
await page.click('#saveBtn');
const overlayClosed = await page
  .waitForFunction(() => !document.getElementById('overlay').classList.contains('open'), null, { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
check('保存すると撮影結果の表示が閉じる', overlayClosed);

// 診断ページ
const diag = await context.newPage();
diag.on('pageerror', (e) => errors.push(`diag: ${e}`));
await diag.goto(`${BASE}/diag.html`);
await diag.click('#openBack');
await diag.waitForFunction(() => document.getElementById('openOut').textContent.includes('width'), null, { timeout: 15000 });
await diag.click('#capsBtn');
await diag.click('#benchBtn');
await diag.waitForFunction(() => document.querySelectorAll('#benchOut tbody tr').length >= 3, null, { timeout: 30000 });
await diag.click('#gpuBtn');
await diag.waitForFunction(() => document.getElementById('gpuOut').textContent.includes('webgl2'), null, { timeout: 30000 });
await diag.click('#encodeBtn');
await diag.click('#selfTestBtn');
await diag.waitForFunction(() => /verdict|error/.test(document.getElementById('gpuOut').textContent), null, { timeout: 30000 });

// 写真API と通常撮影の比較（配線が正しいかを確かめる）
await diag.click('#compareCurrentBtn');
await diag.waitForFunction(() => document.querySelectorAll('#compareOut tbody tr').length >= 2,
  null, { timeout: 60000 });

const report = await diag.evaluate(() => JSON.parse(document.getElementById('resultOut').textContent));
log('\n--- diag（抜粋）---');
log(JSON.stringify({ framePaths: report.framePaths, gpu: report.gpu, selfTest: report.selfTest }, null, 2));

check('1 コマを取り出す速さを測れた', Array.isArray(report.framePaths) && report.framePaths.length === 3);
check('GPU と CPU の照合を実行できた', !!report.selfTest && !report.selfTest.error, JSON.stringify(report.selfTest));
if (report.selfTest && !report.selfTest.error) {
  check('GPU と CPU が一致する（canvas を入力）', report.selfTest.canvasInput?.maxDiff <= 6,
    JSON.stringify(report.selfTest.canvasInput));
  // 実撮影と同じ条件。ここが本番（WebGL は ImageBitmap で flipY が効かない）
  check('GPU と CPU が一致する（ImageBitmap を入力）', report.selfTest.imageBitmapInput?.maxDiff <= 6,
    JSON.stringify(report.selfTest.imageBitmapInput));
  check('ImageBitmap を入力しても上下が反転しない', report.selfTest.orientationOk === true,
    JSON.stringify(report.selfTest.imageBitmapInput));
}
const comparison = report.comparison?.[0];
check('写真API と通常撮影を比較できた',
  !!comparison?.photo && !!comparison?.frame, JSON.stringify(comparison));
if (comparison?.photo && comparison?.frame) {
  log(`      → 写真API ${comparison.photo.size} ${(comparison.photo.bytes / 1024).toFixed(0)}KB `
    + `${comparison.photo.ms}ms 輪郭 ${comparison.photo.sharpness} ノイズ ${comparison.photo.noise}`);
  log(`      → 通常撮影 ${comparison.frame.size} ${(comparison.frame.bytes / 1024).toFixed(0)}KB `
    + `${comparison.frame.ms}ms 輪郭 ${comparison.frame.sharpness} ノイズ ${comparison.frame.noise}`);
}

check('ページエラーが出ていない', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
server.close();
log(`\n${failures === 0 ? 'すべて成功' : `${failures} 件失敗`}`);
process.exit(failures === 0 ? 0 : 1);
