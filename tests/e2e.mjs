// ブラウザ結合テスト。偽のカメラを持つ Chromium で実際に撮影まで行う。
//
//   npm i -D playwright && node tests/e2e.mjs
//   （ブラウザが別の場所にある場合は PW_CHROMIUM=/path/to/chrome を指定）
//
// これは Safari ではなく Chromium での検証なので、iOS 固有の挙動（解像度・音・許可）は
// diag.html を実機で動かして確認すること。ここで守りたいのは、撮影から書き出しまでの
// 配線と、GPU シェーダが CPU 実装と一致していることの 2 点。
//
// 上下反転の回帰は diag の自己テスト（ImageBitmap 入力）が担当する。実撮影どうしを
// 見比べる方法も試したが、偽カメラの絵が上下に対称的で反転を検出できなかったため採らない。

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

// 許可が残っていれば開始ボタンを押さずにカメラが開くはず（プロンプト削減の要）
const autoStarted = await page
  .waitForFunction(() => !document.getElementById('shutter').disabled, null, { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
check('許可済みなら自動でカメラが開く', autoStarted);
if (!autoStarted) {
  await page.click('#startBtn');
  await page.waitForFunction(() => !document.getElementById('shutter').disabled, null, { timeout: 15000 });
}

check('カメラが起動し解像度が表示される', /\d+×\d+/.test(await page.textContent('#statusChip')));
check('スタート画面が隠れる', await page.locator('#start').evaluate((e) => e.classList.contains('hidden')));

// 静音・1枚
await page.click('#shutter');
await page.waitForSelector('#overlay.open', { timeout: 15000 });
const single = await shotInfo();
check('1枚撮影で画像ができる', single.w > 0 && single.h > 0, JSON.stringify(single));
log(`      → ${single.meta}`);
await page.click('#discardBtn');

// 静音・高画質（合成）
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
check('合成に複数枚採用されている', /([2-9]|\d\d)\/\d+枚採用/.test(stacked.meta), stacked.meta);
log(`      → ${stacked.meta}`);
await page.click('#discardBtn');

// 大きな素材では 2 倍格子が抑制される（メモリ保護）
await page.click('#settingsBtn');
await page.locator('#drizzleInput').check();
await page.click('#closeSheet');
await page.click('#shutter');
await page.waitForSelector('#overlay.open', { timeout: 40000 });
const capped = await shotInfo();
check('4K 素材では 2 倍格子が抑制される', capped.w === stacked.w && !/2倍格子/.test(capped.meta),
  JSON.stringify(capped));
log(`      → ${capped.meta}`);
await page.click('#discardBtn');

// 720p なら 2 倍格子が効く
await page.click('#settingsBtn');
await page.selectOption('#resolutionSelect', '1280x720');
await page.click('#closeSheet');
await page.waitForFunction(() => /1280×720/.test(document.getElementById('statusChip').textContent),
  null, { timeout: 15000 });
await page.click('#shutter');
await page.waitForSelector('#overlay.open', { timeout: 40000 });
const drizzled = await shotInfo();
check('720p 素材では 2 倍格子で出力が倍になる',
  drizzled.w === 2560 && drizzled.h === 1440 && /2倍格子/.test(drizzled.meta), JSON.stringify(drizzled));
log(`      → ${drizzled.meta}`);
await page.click('#discardBtn');

// 写真API（Chromium は takePhoto に対応。確認ダイアログを承諾する）
page.once('dialog', (d) => d.accept());
await page.click('#modePhoto');
await page.click('#shutter');
const photoOk = await page.waitForSelector('#overlay.open', { timeout: 20000 }).then(() => true).catch(() => false);
check('写真APIモードが動作する', photoOk);
if (photoOk) {
  log(`      → ${(await shotInfo()).meta}`);
  await page.click('#discardBtn');
}

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

// 写真API と フレーム切り出しの比較（Chromium は takePhoto に対応しているので配線を確認できる）
await diag.click('#compareCurrentBtn');
await diag.waitForFunction(() => document.querySelectorAll('#compareOut tbody tr').length >= 2,
  null, { timeout: 60000 });

const report = await diag.evaluate(() => JSON.parse(document.getElementById('resultOut').textContent));
log('\n--- diag（抜粋）---');
log(JSON.stringify({ framePaths: report.framePaths, gpu: report.gpu, selfTest: report.selfTest }, null, 2));

check('フレーム取得経路を計測できた', Array.isArray(report.framePaths) && report.framePaths.length === 3);
check('GPU/CPU 一致テストが実行できた', !!report.selfTest && !report.selfTest.error, JSON.stringify(report.selfTest));
if (report.selfTest && !report.selfTest.error) {
  check('GPU と CPU が一致する（canvas 入力）', report.selfTest.canvasInput?.maxDiff <= 6,
    JSON.stringify(report.selfTest.canvasInput));
  // 実撮影と同じ条件。ここが本番（WebGL は ImageBitmap で flipY が効かない）
  check('GPU と CPU が一致する（ImageBitmap 入力）', report.selfTest.imageBitmapInput?.maxDiff <= 6,
    JSON.stringify(report.selfTest.imageBitmapInput));
  check('ImageBitmap 入力で上下が反転していない', report.selfTest.orientationOk === true,
    JSON.stringify(report.selfTest.imageBitmapInput));
}
const comparison = report.comparison?.[0];
check('写真API とフレーム切り出しを比較できた',
  !!comparison?.photo && !!comparison?.frame, JSON.stringify(comparison));
if (comparison?.photo && comparison?.frame) {
  log(`      → 写真API ${comparison.photo.size} ${(comparison.photo.bytes / 1024).toFixed(0)}KB `
    + `${comparison.photo.ms}ms シャープ ${comparison.photo.sharpness} ノイズ ${comparison.photo.noise}`);
  log(`      → フレーム ${comparison.frame.size} ${(comparison.frame.bytes / 1024).toFixed(0)}KB `
    + `${comparison.frame.ms}ms シャープ ${comparison.frame.sharpness} ノイズ ${comparison.frame.noise}`);
}

check('ページエラーが出ていない', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
server.close();
log(`\n${failures === 0 ? 'すべて成功' : `${failures} 件失敗`}`);
process.exit(failures === 0 ? 0 : 1);
