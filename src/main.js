// 画面の制御。
//
// このページは一度読み込んだあと再読み込みしない。iOS ではページを読み込み直すたびに
// カメラの許可を求められるため、表示の切り替えだけで操作を完結させている。

import {
  openStream, openBestStream, stopStream, inspectTrack, attachToVideo, applyIfSupported,
} from './camera.js';
import {
  grabToCanvas, detectSilentPaths, resetImageCaptureCache, probeBestPath, getPreferredPath,
} from './capture/frame.js';
import { captureStack } from './pipeline/stack.js';
import { isPhotoModeAvailable, takePhotoBlob, isTrackAlive } from './capture/photo.js';
import {
  canvasToBlob, saveImage, timestampName, probeEncoders, EXTENSION_OF_TYPE,
} from './encode.js';
import { inspectCameraPermission } from './permission.js';
import { APP_VERSION } from './version.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 映像から 1 コマを取り出す方法の表示名。 */
const PATH_LABELS = {
  drawImage: '描画による取得',
  videoFrame: 'VideoFrame による取得',
  grabFrame: 'grabFrame による取得',
};

const el = {
  video: $('preview'),
  grid: $('grid'),
  status: $('statusChip'),
  shutter: $('shutter'),
  flip: $('flip'),
  thumb: $('thumb'),
  sheet: $('sheet'),
  backdrop: $('sheetBackdrop'),
  overlay: $('overlay'),
  shot: $('shot'),
  shotMeta: $('shotMeta'),
  toast: $('toast'),
  progress: $('progress'),
  progressText: $('progressText'),
  progressBar: $('progressBar'),
  start: $('start'),
  startNote: $('startNote'),
  permissionInfo: $('permissionInfo'),
  buildInfo: $('buildInfo'),
  storageInfo: $('storageInfo'),
};

const SETTINGS_KEY = 'ios-cam.settings.v2';

const state = {
  stream: null,
  track: null,
  busy: false,
  lastBlob: null,
  lastShotUrl: null,
  thumbUrl: null,
  wakeLock: null,
  permission: null,
  probe: null,
  encoders: null,
  storageAvailable: false,
  watchdogRunning: false,
  settings: {
    mode: 'frame',
    facingMode: 'environment',
    zoom: 1,
    frames: 8,
    highFps: true,
    drizzle: false,
    sharpen: 0.25,
    resolution: 'auto',
    quality: 0.95,
    format: 'image/jpeg',
    grid: false,
    photoNoticeShown: false,
  },
};

// ---------- 設定の保存 ----------

function checkStorage() {
  try {
    const probe = `${SETTINGS_KEY}.probe`;
    localStorage.setItem(probe, '1');
    const ok = localStorage.getItem(probe) === '1';
    localStorage.removeItem(probe);
    return ok;
  } catch {
    return false;
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch {
    // 読めない場合は初期値のまま使う
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    // 保存できない端末では、その場の変更だけが有効になる
  }
}

// ---------- 画面の小道具 ----------

let toastTimer = null;
function toast(message, ms = 2400) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function setStatus(text) {
  el.status.textContent = text;
}

function updateStatus() {
  const info = state.track ? inspectTrack(state.track) : null;
  const size = info ? `${info.width}×${info.height}` : '準備中';
  setStatus(`${size}　${modeLabel()}`);
}

function setBusy(busy, label = '') {
  state.busy = busy;
  el.shutter.disabled = busy || !state.track;
  el.shutter.classList.toggle('busy', busy);
  if (busy && label) {
    el.progressText.textContent = label;
    el.progressBar.style.width = '0%';
    el.progress.classList.add('show');
  } else if (!busy) {
    el.progress.classList.remove('show');
  }
}

function setProgress(ratio, label) {
  el.progressBar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  if (label) el.progressText.textContent = label;
}

// ---------- カメラ ----------

async function startCamera() {
  stopCamera();
  resetImageCaptureCache();
  setStatus('カメラを起動しています');
  try {
    let opened;
    if (state.settings.resolution === 'auto') {
      opened = await openBestStream({ facingMode: state.settings.facingMode });
    } else {
      const [width, height] = state.settings.resolution.split('x').map(Number);
      const stream = await openStream({ facingMode: state.settings.facingMode, width, height });
      opened = { stream, track: stream.getVideoTracks()[0] };
    }
    state.stream = opened.stream;
    state.track = opened.track;
    await attachToVideo(el.video, state.stream);

    const info = inspectTrack(state.track);
    el.video.classList.toggle('mirrored', state.settings.facingMode === 'user');
    syncCapabilityControls(info.capabilities);
    await restoreZoom();

    // どの取得方法が速く、正しい向きで返るかは端末によって違うため、起動時に一度だけ測る
    state.probe = await probeBestPath(el.video, state.track).catch(() => null);
    el.buildInfo.textContent = describeBuild(info);

    updateStatus();
    el.shutter.disabled = false;
    el.start.classList.add('hidden');
    requestWakeLock();
  } catch (err) {
    handleCameraError(err);
  }
}

function stopCamera() {
  stopStream(state.stream);
  state.stream = null;
  state.track = null;
  el.shutter.disabled = true;
}

function isStreamAlive() {
  return state.track?.readyState === 'live';
}

function handleCameraError(err) {
  console.error(err);
  const name = err?.name ?? '';
  let message = 'カメラを開けませんでした。しばらく待ってからやり直してください。';
  if (name === 'NotAllowedError') {
    message = 'カメラの使用が許可されていません。設定アプリの「アプリ」から Safari を開き、'
      + '「カメラ」を「許可」または「確認」にしてください。';
  } else if (name === 'NotFoundError') {
    message = 'カメラが見つかりませんでした。';
  } else if (name === 'NotReadableError') {
    message = '他のアプリがカメラを使っている可能性があります。そのアプリを閉じてからやり直してください。';
  }
  el.start.classList.remove('hidden');
  el.startNote.textContent = message;
  setStatus('カメラを使えません');
}

/**
 * 解像度を変える。まず制約の適用で試し、届かなかったときだけ開き直す。
 * ストリームを作り直さなければ、許可を求められることもない。
 */
async function changeResolution() {
  if (!isStreamAlive() || state.settings.resolution === 'auto') {
    await startCamera();
    return;
  }
  const [width, height] = state.settings.resolution.split('x').map(Number);
  try {
    await state.track.applyConstraints({ width: { ideal: width }, height: { ideal: height } });
    const info = inspectTrack(state.track);
    // iOS は縦横を入れ替えて返すことがあるため、画素数の近さで判定する
    const wanted = width * height;
    const got = info.width * info.height;
    if (Math.abs(got - wanted) / wanted > 0.25) throw new Error('要求した解像度に届きませんでした');
    updateStatus();
    el.buildInfo.textContent = describeBuild(info);
    toast(`解像度を ${info.width}×${info.height} に変更しました`);
  } catch {
    await startCamera();
  }
}

/**
 * 映像が止まっていないか確かめ、止まっていれば立て直す。
 * 写真API での撮影後や、バックグラウンドから戻ったあとに呼ぶ。
 */
async function ensurePreviewRunning() {
  if (state.watchdogRunning) return;
  state.watchdogRunning = true;
  try {
    if (!isStreamAlive()) {
      await startCamera();
      return;
    }
    const before = el.video.currentTime;
    await sleep(2000);
    if (el.video.currentTime > before) return;

    await el.video.play().catch(() => {});
    const afterPlay = el.video.currentTime;
    await sleep(800);
    if (el.video.currentTime > afterPlay) return;

    toast('映像が止まったため、カメラを開き直します');
    await startCamera();
  } finally {
    state.watchdogRunning = false;
  }
}

function describeBuild(info) {
  const paths = detectSilentPaths();
  const available = Object.entries(paths)
    .filter(([, ok]) => ok)
    .map(([key]) => PATH_LABELS[key] ?? key)
    .join('、');
  const chosen = PATH_LABELS[getPreferredPath()] ?? 'まだ調べていません';
  return `版 ${APP_VERSION}／${info.width}×${info.height}／毎秒 ${Math.round(info.frameRate)} コマ`
    + `／取得方法：${chosen}（使えるもの：${available}）`
    + `／写真API：${isPhotoModeAvailable() ? 'あり' : 'なし'}`;
}

function updatePermissionInfo() {
  const permission = state.permission;
  if (!permission) {
    el.permissionInfo.textContent = '起動時の判定：まだ調べていません';
    return;
  }
  const source = {
    'permissions-api': 'Permissions API による判定',
    'device-labels': 'カメラ名が読めたことによる判定',
    denied: '設定で拒否されているため',
    unknown: '判定する手段がないため',
  }[permission.reason] ?? permission.reason;
  el.permissionInfo.textContent = permission.granted
    ? `起動時の判定：前回の許可が残っていました（${source}）`
    : `起動時の判定：許可は残っていませんでした（${source}）`;
}

// ---------- カメラの機能 ----------

function syncZoomButtons(caps) {
  const holder = $('zooms');
  holder.textContent = '';
  const zoom = caps?.zoom;
  if (!zoom || typeof zoom.min !== 'number') {
    holder.hidden = true;
    return;
  }
  const steps = [0.5, 1, 2, 3].filter((value) => value >= zoom.min && value <= (zoom.max ?? value));
  if (steps.length < 2) {
    holder.hidden = true;
    return;
  }
  holder.hidden = false;
  for (const value of steps) {
    const button = document.createElement('button');
    button.textContent = `${value} 倍`;
    button.setAttribute('aria-pressed', String(Math.abs(state.settings.zoom - value) < 0.05));
    button.addEventListener('click', () => applyZoom(value, holder, button));
    holder.appendChild(button);
  }
}

async function applyZoom(value, holder, button) {
  const result = await applyIfSupported(state.track, { zoom: value });
  if (!result.applied) {
    toast('この端末ではズームを変えられません');
    return;
  }
  state.settings.zoom = value;
  saveSettings();
  if (holder && button) {
    for (const other of holder.children) other.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
  }
  $('zoomInput').value = value;
  $('zoomValue').textContent = `${value.toFixed(1)} 倍`;
}

async function restoreZoom() {
  if (state.settings.zoom === 1) return;
  await applyIfSupported(state.track, { zoom: state.settings.zoom });
  syncZoomButtons(inspectTrack(state.track).capabilities);
}

function syncCapabilityControls(caps) {
  syncZoomButtons(caps);
  const zoomRow = $('zoomRow');
  if (caps?.zoom && typeof caps.zoom.min === 'number') {
    zoomRow.hidden = false;
    const input = $('zoomInput');
    input.min = caps.zoom.min;
    input.max = Math.min(caps.zoom.max ?? 5, 8);
    input.step = caps.zoom.step || 0.1;
    input.value = state.track.getSettings().zoom ?? caps.zoom.min;
    $('zoomValue').textContent = `${Number(input.value).toFixed(1)} 倍`;
  } else {
    zoomRow.hidden = true;
  }
  $('torchRow').hidden = !(caps && 'torch' in caps);
}

// ---------- 撮影 ----------

function modeLabel() {
  if (state.settings.mode === 'frame') return '通常';
  if (state.settings.mode === 'stack') return `合成 ${state.settings.frames} 枚`;
  return '写真API';
}

function setMode(mode) {
  state.settings.mode = mode;
  saveSettings();
  $('modeFrame').setAttribute('aria-pressed', String(mode === 'frame'));
  $('modeStack').setAttribute('aria-pressed', String(mode === 'stack'));
  $('modePhoto').setAttribute('aria-pressed', String(mode === 'photo'));
  updateStatus();

  if (mode === 'photo' && !state.settings.photoNoticeShown) {
    toast('写真API では、端末によってはシャッター音が鳴ることがあります。', 5000);
    state.settings.photoNoticeShown = true;
    saveSettings();
  }
}

async function shoot() {
  if (!state.track || state.busy) return;
  try {
    if (state.settings.mode === 'frame') await shootFrame();
    else if (state.settings.mode === 'stack') await shootStack();
    else await shootPhotoApi();
  } catch (err) {
    console.error(err);
    setBusy(false);
    toast('撮影できませんでした。もう一度お試しください。', 3500);
  }
}

async function shootFrame() {
  setBusy(true);
  const started = performance.now();
  const { canvas, width, height, path, colorSpace } = await grabToCanvas(el.video, state.track);
  const blob = await canvasToBlob(canvas, {
    type: state.settings.format,
    quality: state.settings.quality,
  });
  setBusy(false);
  showResult(blob, [
    `${width}×${height}`,
    `通常撮影（${path}／${colorSpace}）`,
    `${Math.round(performance.now() - started)} ミリ秒`,
  ]);
}

async function shootStack() {
  const frames = state.settings.frames;
  setBusy(true, `連写しています 0 / ${frames}`);
  const started = performance.now();

  // 撮影が短いほど手ぶれの積み重ねが減るため、対応する端末では毎秒 60 コマを要求する
  let previousFrameRate = null;
  if (state.settings.highFps) {
    const before = state.track.getSettings?.().frameRate;
    const applied = await applyIfSupported(state.track, { frameRate: 60 });
    if (applied.applied && before) previousFrameRate = before;
  }

  const result = await captureStack(el.video, state.track, {
    frames,
    scale: state.settings.drizzle ? 2 : 1,
    sharpen: state.settings.sharpen,
    onProgress: ({ used }) => setProgress(used / frames, `連写しています ${used} / ${frames}`),
  });

  setProgress(1, '画像を書き出しています');
  const blob = await canvasToBlob(result.canvas, {
    type: state.settings.format,
    quality: state.settings.quality,
  });
  result.stacker?.dispose?.();
  if (previousFrameRate) await applyIfSupported(state.track, { frameRate: previousFrameRate });
  setBusy(false);

  if (result.scaleReduced) {
    toast('解像度が高いため、今回は 2 倍にする処理を省きました');
  }
  showResult(blob, [
    `${result.width}×${result.height}`,
    `合成撮影（${result.used} / ${result.total} 枚を採用${result.scale > 1 ? '、解像度 2 倍' : ''}）`,
    `${Math.round(performance.now() - started)} ミリ秒`,
  ]);
}

async function shootPhotoApi() {
  if (!isPhotoModeAvailable()) {
    toast('この端末のブラウザは写真API に対応していません', 3000);
    return;
  }
  setBusy(true, '撮影しています');
  const started = performance.now();
  try {
    // 大きさは指定しない。指定しても映像と同じ大きさに調整されるうえ、
    // 端末の上限を指定するとカメラとの接続が切れることがある。
    const { blob, width, height } = await takePhotoBlob(state.track);
    setBusy(false);
    showResult(blob, [
      `${width}×${height}`,
      '写真API 撮影',
      `${Math.round(performance.now() - started)} ミリ秒`,
    ]);
  } catch (err) {
    console.error(err);
    setBusy(false);
    toast('写真API で撮影できませんでした。もう一度お試しください。', 4000);
  } finally {
    // 撮影のあとに映像が止まることがあるため、止まっていれば立て直す
    ensurePreviewRunning();
  }
}

// ---------- 撮影結果 ----------

function showResult(blob, parts) {
  state.lastBlob = blob;
  if (state.lastShotUrl) URL.revokeObjectURL(state.lastShotUrl);
  state.lastShotUrl = URL.createObjectURL(blob);
  el.shot.src = state.lastShotUrl;
  el.shotMeta.textContent = `${parts.join('　')}　${(blob.size / 1024 / 1024).toFixed(2)} MB`;
  el.overlay.classList.add('open');
  updateThumb(blob);
}

function updateThumb(blob) {
  if (state.thumbUrl) URL.revokeObjectURL(state.thumbUrl);
  state.thumbUrl = URL.createObjectURL(blob);
  el.thumb.textContent = '';
  const image = document.createElement('img');
  image.src = state.thumbUrl;
  image.alt = '';
  el.thumb.appendChild(image);
}

async function saveLast() {
  if (!state.lastBlob) return;
  const extension = EXTENSION_OF_TYPE[state.lastBlob.type] ?? 'jpg';
  const result = await saveImage(state.lastBlob, timestampName(extension));
  if (result === 'shared') {
    el.overlay.classList.remove('open');
    toast('共有メニューの「画像を保存」で写真アプリに保存できます');
  } else if (result === 'downloaded') {
    el.overlay.classList.remove('open');
    toast('ダウンロードしました');
  }
}

// ---------- 画面の状態 ----------

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    // 取得できなくても撮影には影響しない
  }
}

function openSheet() {
  el.sheet.classList.add('open');
  el.backdrop.hidden = false;
  requestAnimationFrame(() => el.backdrop.classList.add('open'));
}

function closeSheet() {
  el.sheet.classList.remove('open');
  el.backdrop.classList.remove('open');
  setTimeout(() => { el.backdrop.hidden = true; }, 250);
}

// バックグラウンドに回ってもストリームは止めない。止めて取り直すと
// getUserMedia をもう一度呼ぶことになり、許可を求められる場合があるため。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (el.start.classList.contains('hidden')) {
    requestWakeLock();
    ensurePreviewRunning();
  }
});

// ---------- 設定画面 ----------

/** この端末で実際に書き出せた形式だけを選択肢にする。 */
async function populateFormats() {
  const select = $('formatSelect');
  const results = await probeEncoders().catch(() => null);
  state.encoders = results;
  if (!results) return;

  const labels = {
    'image/jpeg': 'JPEG',
    'image/heic': 'HEIC',
    'image/avif': 'AVIF',
    'image/webp': 'WebP',
    'image/png': 'PNG（大きくなります）',
  };
  const supported = Object.entries(results)
    .filter(([, result]) => result.supported)
    .map(([type]) => type);

  select.textContent = '';
  for (const type of ['image/jpeg', 'image/heic', 'image/avif', 'image/webp', 'image/png']) {
    if (!supported.includes(type)) continue;
    const option = document.createElement('option');
    option.value = type;
    option.textContent = labels[type] ?? type;
    select.appendChild(option);
  }
  if (!supported.includes(state.settings.format)) {
    state.settings.format = supported.includes('image/jpeg') ? 'image/jpeg' : supported[0];
    saveSettings();
  }
  select.value = state.settings.format;
  syncQualityRow();
}

function syncQualityRow() {
  // PNG は画質の指定が効かないため、選んでいるあいだは隠す
  $('qualityRow').hidden = state.settings.format === 'image/png';
}

function bindSettings() {
  const frames = $('framesInput');
  const sharpen = $('sharpenInput');
  const quality = $('qualityInput');
  const drizzle = $('drizzleInput');
  const resolution = $('resolutionSelect');
  const highFps = $('highFpsInput');
  const format = $('formatSelect');

  frames.value = state.settings.frames;
  sharpen.value = state.settings.sharpen;
  quality.value = state.settings.quality;
  drizzle.checked = state.settings.drizzle;
  resolution.value = state.settings.resolution;
  highFps.checked = state.settings.highFps;
  format.value = state.settings.format;
  $('framesValue').textContent = state.settings.frames;
  $('sharpenValue').textContent = Number(state.settings.sharpen).toFixed(2);
  $('qualityValue').textContent = Number(state.settings.quality).toFixed(2);
  el.grid.classList.toggle('on', state.settings.grid);
  syncQualityRow();

  frames.addEventListener('input', () => {
    state.settings.frames = Number(frames.value);
    $('framesValue').textContent = frames.value;
    saveSettings();
    updateStatus();
  });
  sharpen.addEventListener('input', () => {
    state.settings.sharpen = Number(sharpen.value);
    $('sharpenValue').textContent = Number(sharpen.value).toFixed(2);
    saveSettings();
  });
  quality.addEventListener('input', () => {
    state.settings.quality = Number(quality.value);
    $('qualityValue').textContent = Number(quality.value).toFixed(2);
    saveSettings();
  });
  drizzle.addEventListener('change', () => {
    state.settings.drizzle = drizzle.checked;
    saveSettings();
  });
  highFps.addEventListener('change', () => {
    state.settings.highFps = highFps.checked;
    saveSettings();
  });
  format.addEventListener('change', () => {
    state.settings.format = format.value;
    saveSettings();
    syncQualityRow();
  });
  resolution.addEventListener('change', async () => {
    state.settings.resolution = resolution.value;
    saveSettings();
    await changeResolution();
  });

  $('zoomInput').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    $('zoomValue').textContent = `${value.toFixed(1)} 倍`;
    if (state.track) applyZoom(value);
  });
  $('torchInput').addEventListener('change', async (event) => {
    if (!state.track) return;
    const result = await applyIfSupported(state.track, { torch: event.target.checked });
    if (!result.applied) toast('この端末ではライトを操作できません');
  });
  $('diagLink').addEventListener('click', () => {
    const ok = window.confirm(
      '端末チェックのページを開きます。\n'
      + 'このページから離れるため、戻るときにカメラの許可を求められることがあります。',
    );
    if (ok) window.location.href = './diag.html';
  });
}

function bindUi() {
  $('startBtn').addEventListener('click', startCamera);
  el.shutter.addEventListener('click', shoot);
  el.flip.addEventListener('click', async () => {
    state.settings.facingMode = state.settings.facingMode === 'environment' ? 'user' : 'environment';
    saveSettings();
    await startCamera();
  });
  $('modeFrame').addEventListener('click', () => setMode('frame'));
  $('modeStack').addEventListener('click', () => setMode('stack'));
  $('modePhoto').addEventListener('click', () => setMode('photo'));
  $('settingsBtn').addEventListener('click', () => {
    if (el.sheet.classList.contains('open')) closeSheet();
    else openSheet();
  });
  $('closeSheet').addEventListener('click', closeSheet);
  el.backdrop.addEventListener('click', closeSheet);
  $('gridBtn').addEventListener('click', () => {
    state.settings.grid = !state.settings.grid;
    el.grid.classList.toggle('on', state.settings.grid);
    saveSettings();
  });
  $('saveBtn').addEventListener('click', saveLast);
  $('discardBtn').addEventListener('click', () => el.overlay.classList.remove('open'));
  el.thumb.addEventListener('click', () => {
    if (state.lastBlob) el.overlay.classList.add('open');
  });
  // 二本指などで画面が拡大するのを防ぐ
  document.addEventListener('gesturestart', (event) => event.preventDefault());
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      await registration.update();
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            toast('新しい版があります。次に起動したときに切り替わります。', 4000);
          }
        });
      });
    } catch {
      // 登録できなくても通信できる限り動作する
    }
  });
}

// ---------- 起動 ----------

async function boot() {
  el.buildInfo.textContent = `版 ${APP_VERSION}`;
  state.storageAvailable = checkStorage();
  el.storageInfo.textContent = state.storageAvailable
    ? '設定の保存：この端末では設定を保存できます'
    : '設定の保存：この端末では設定を保存できません。起動のたびに初期値に戻ります。';

  loadSettings();
  bindSettings();
  bindUi();
  setMode(state.settings.mode);
  registerServiceWorker();
  populateFormats();

  if (!navigator.mediaDevices?.getUserMedia) {
    el.startNote.textContent = 'この環境ではカメラを使えません。https で開いているか確認してください。';
    $('startBtn').disabled = true;
    return;
  }

  state.permission = await inspectCameraPermission();
  updatePermissionInfo();

  if (state.permission.permissionState === 'denied') {
    el.startNote.textContent = 'カメラの使用が拒否されています。設定アプリの「アプリ」から Safari を開き、'
      + '「カメラ」を「許可」または「確認」にしてください。';
    return;
  }

  // 起動と同時にカメラを要求する。許可が残っていればそのまま映像が出る。
  // 残っていなければ、この時点で許可を尋ねる画面が出る。
  await startCamera();
}

boot();
