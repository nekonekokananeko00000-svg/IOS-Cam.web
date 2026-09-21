// 画面とモードの制御。ページは一度も再読み込みしない（iOS のカメラ許可は
// リロードのたびに聞き直されるため、単一ページのまま状態だけ切り替える）。

import {
  openStream, openBestStream, stopStream, inspectTrack, attachToVideo, applyIfSupported,
} from './camera.js';
import { grabToCanvas, detectSilentPaths, resetImageCaptureCache } from './capture/frame.js';
import { captureStack } from './pipeline/stack.js';
import { isPhotoModeAvailable, takePhotoBlob } from './capture/photo.js';
import { canvasToBlob, saveImage, timestampName } from './encode.js';

const $ = (id) => document.getElementById(id);

const el = {
  video: $('preview'),
  grid: $('grid'),
  status: $('statusChip'),
  shutter: $('shutter'),
  flip: $('flip'),
  thumb: $('thumb'),
  sheet: $('sheet'),
  overlay: $('overlay'),
  shot: $('shot'),
  shotMeta: $('shotMeta'),
  toast: $('toast'),
  progress: $('progress'),
  progressText: $('progressText'),
  progressBar: $('progressBar'),
  start: $('start'),
  startNote: $('startNote'),
  deviceInfo: $('deviceInfo'),
};

const SETTINGS_KEY = 'ios-cam.settings.v1';

const state = {
  stream: null,
  track: null,
  facingMode: 'environment',
  mode: 'single',
  busy: false,
  lastBlob: null,
  lastMeta: '',
  wakeLock: null,
  photoWarned: false,
  settings: {
    frames: 12,
    drizzle: false,
    sharpen: 0.35,
    resolution: 'auto',
    quality: 0.95,
    grid: false,
  },
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch { /* 読めなければ既定値のまま */ }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch { /* プライベートブラウズでは保存できないことがある */ }
}

let toastTimer = null;
function toast(message, ms = 2200) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function setStatus(text, strong = '') {
  el.status.innerHTML = strong ? `${text} <strong>${strong}</strong>` : text;
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
  setStatus('起動中…');
  try {
    let opened;
    if (state.settings.resolution === 'auto') {
      opened = await openBestStream({ facingMode: state.facingMode });
    } else {
      const [width, height] = state.settings.resolution.split('x').map(Number);
      const stream = await openStream({ facingMode: state.facingMode, width, height });
      const track = stream.getVideoTracks()[0];
      opened = { stream, track, actual: inspectTrack(track) };
    }
    state.stream = opened.stream;
    state.track = opened.track;
    await attachToVideo(el.video, state.stream);

    const info = inspectTrack(state.track);
    el.video.classList.toggle('mirrored', info.facingMode === 'user' || state.facingMode === 'user');
    setStatus(`${info.width}×${info.height}`, modeLabel());
    el.deviceInfo.textContent = describeDevice(info);
    syncCapabilityControls(info.capabilities);
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

function handleCameraError(err) {
  const name = err?.name ?? '';
  let message = `カメラを開けません: ${err?.message ?? err}`;
  if (name === 'NotAllowedError') {
    message = 'カメラが許可されていません。Safari の「ぁあ」→ Web サイトの設定 → カメラ を「許可」にしてください。';
  } else if (name === 'NotFoundError') {
    message = 'カメラが見つかりません。';
  } else if (name === 'NotReadableError') {
    message = '他のアプリがカメラを使用中の可能性があります。';
  }
  el.start.classList.remove('hidden');
  el.startNote.textContent = message;
  setStatus('エラー');
  toast(message, 4000);
}

function describeDevice(info) {
  const paths = detectSilentPaths();
  const available = Object.entries(paths).filter(([, ok]) => ok).map(([k]) => k).join(' / ');
  return `${info.width}×${info.height} @${Math.round(info.frameRate)}fps・経路: ${available}`
    + (isPhotoModeAvailable() ? '・写真API あり' : '・写真API なし');
}

function syncCapabilityControls(caps) {
  const zoomRow = $('zoomRow');
  const torchRow = $('torchRow');
  if (caps?.zoom && typeof caps.zoom.min === 'number') {
    zoomRow.hidden = false;
    const input = $('zoomInput');
    input.min = caps.zoom.min;
    input.max = Math.min(caps.zoom.max ?? 5, 8);
    input.step = caps.zoom.step || 0.1;
    input.value = state.track.getSettings().zoom ?? caps.zoom.min;
    $('zoomValue').textContent = `${Number(input.value).toFixed(1)}×`;
  } else {
    zoomRow.hidden = true;
  }
  torchRow.hidden = !(caps && 'torch' in caps);
}

// ---------- 撮影 ----------

function modeLabel() {
  if (state.mode === 'single') return '静音1枚';
  if (state.mode === 'stack') return `静音合成×${state.settings.frames}`;
  return '写真API';
}

function setMode(mode) {
  state.mode = mode;
  $('modeSingle').setAttribute('aria-pressed', String(mode === 'single'));
  $('modeStack').setAttribute('aria-pressed', String(mode === 'stack'));
  $('modePhoto').setAttribute('aria-pressed', String(mode === 'photo'));
  const info = state.track ? inspectTrack(state.track) : null;
  setStatus(info ? `${info.width}×${info.height}` : '待機中', modeLabel());
}

async function shoot() {
  if (!state.track || state.busy) return;
  try {
    if (state.mode === 'single') await shootSingle();
    else if (state.mode === 'stack') await shootStack();
    else await shootPhotoApi();
  } catch (err) {
    setBusy(false);
    toast(`撮影に失敗しました: ${err?.message ?? err}`, 3500);
  }
}

async function shootSingle() {
  setBusy(true);
  const started = performance.now();
  const { canvas, width, height, path, colorSpace } = await grabToCanvas(el.video, state.track);
  const blob = await canvasToBlob(canvas, { quality: state.settings.quality });
  setBusy(false);
  showResult(blob, `${width}×${height}・${path}・${colorSpace}・${Math.round(performance.now() - started)}ms`);
}

async function shootStack() {
  const frames = state.settings.frames;
  setBusy(true, `連写中… 0/${frames}`);
  const started = performance.now();
  const result = await captureStack(el.video, state.track, {
    frames,
    scale: state.settings.drizzle ? 2 : 1,
    sharpen: state.settings.sharpen,
    onProgress: ({ used }) => setProgress(used / frames, `連写中… ${used}/${frames}`),
  });
  setProgress(1, '書き出し中…');
  const blob = await canvasToBlob(result.canvas, { quality: state.settings.quality });
  result.stacker?.dispose?.();
  setBusy(false);
  const elapsed = Math.round(performance.now() - started);
  if (result.scaleReduced) {
    toast('解像度が高いため 2 倍格子は見送りました（メモリ保護）', 3200);
  }
  showResult(
    blob,
    `${result.width}×${result.height}・${result.used}/${result.total}枚採用`
    + `・${result.kind}${result.scale > 1 ? `・${result.scale}倍格子` : ''}・${elapsed}ms`,
  );
}

async function shootPhotoApi() {
  if (!isPhotoModeAvailable()) {
    toast('この端末の Safari は写真 API に対応していません', 3000);
    return;
  }
  if (!state.photoWarned) {
    const ok = window.confirm(
      '写真 API は端末内部の写真撮影処理（AVCapturePhotoOutput）を使います。\n'
      + '日本国内向けの端末では、この経路でシャッター音が鳴る可能性が高いです。\n\n'
      + '続けますか？',
    );
    if (!ok) return;
    state.photoWarned = true;
  }
  setBusy(true, '撮影中…');
  const started = performance.now();
  const { blob, width, height } = await takePhotoBlob(state.track);
  setBusy(false);
  showResult(blob, `${width}×${height}・写真API・${Math.round(performance.now() - started)}ms`);
}

// ---------- 結果 ----------

function showResult(blob, meta) {
  state.lastBlob = blob;
  state.lastMeta = meta;
  const url = URL.createObjectURL(blob);
  el.shot.src = url;
  el.shot.onload = () => URL.revokeObjectURL(url);
  el.shotMeta.textContent = `${meta}・${(blob.size / 1024 / 1024).toFixed(2)}MB`;
  el.overlay.classList.add('open');
  updateThumb(blob);
}

function updateThumb(blob) {
  const url = URL.createObjectURL(blob);
  el.thumb.innerHTML = '';
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.onload = () => URL.revokeObjectURL(url);
  el.thumb.appendChild(img);
}

async function saveLast() {
  if (!state.lastBlob) return;
  const ext = state.lastBlob.type.includes('png') ? 'png' : 'jpg';
  const result = await saveImage(state.lastBlob, timestampName(ext));
  if (result === 'shared') toast('共有シートから「画像を保存」を選んでください');
  else if (result === 'downloaded') toast('ダウンロードしました');
}

// ---------- 画面のライフサイクル ----------

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* 取れなくても支障はない */ }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    stopCamera();
  } else if (!state.stream && el.start.classList.contains('hidden')) {
    // 復帰時にカメラを開き直す（iOS はバックグラウンドでトラックを止める）
    await startCamera();
  }
});

// ---------- 入力の結線 ----------

function bindSettings() {
  const frames = $('framesInput');
  const sharpen = $('sharpenInput');
  const quality = $('qualityInput');
  const drizzle = $('drizzleInput');
  const resolution = $('resolutionSelect');

  frames.value = state.settings.frames;
  sharpen.value = state.settings.sharpen;
  quality.value = state.settings.quality;
  drizzle.checked = state.settings.drizzle;
  resolution.value = state.settings.resolution;
  $('framesValue').textContent = state.settings.frames;
  $('sharpenValue').textContent = state.settings.sharpen;
  $('qualityValue').textContent = state.settings.quality;
  el.grid.classList.toggle('on', state.settings.grid);

  frames.addEventListener('input', () => {
    state.settings.frames = Number(frames.value);
    $('framesValue').textContent = frames.value;
    saveSettings();
    setMode(state.mode);
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
  resolution.addEventListener('change', async () => {
    state.settings.resolution = resolution.value;
    saveSettings();
    await startCamera();
  });

  $('zoomInput').addEventListener('input', async (event) => {
    const value = Number(event.target.value);
    $('zoomValue').textContent = `${value.toFixed(1)}×`;
    if (state.track) await applyIfSupported(state.track, { zoom: value });
  });
  $('torchInput').addEventListener('change', async (event) => {
    if (!state.track) return;
    const result = await applyIfSupported(state.track, { torch: event.target.checked });
    if (!result.applied) toast('この端末ではライトを制御できません');
  });
  $('diagLink').addEventListener('click', () => {
    window.location.href = './diag.html';
  });
}

function bindUi() {
  $('startBtn').addEventListener('click', startCamera);
  el.shutter.addEventListener('click', shoot);
  el.flip.addEventListener('click', async () => {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    await startCamera();
  });
  $('modeSingle').addEventListener('click', () => setMode('single'));
  $('modeStack').addEventListener('click', () => setMode('stack'));
  $('modePhoto').addEventListener('click', () => setMode('photo'));
  $('settingsBtn').addEventListener('click', () => el.sheet.classList.toggle('open'));
  $('closeSheet').addEventListener('click', () => el.sheet.classList.remove('open'));
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
  // 誤操作での拡大を抑える
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* オフライン化は任意 */ });
  });
}

loadSettings();
bindSettings();
bindUi();
setMode('single');
registerServiceWorker();

if (!navigator.mediaDevices?.getUserMedia) {
  el.startNote.textContent = 'この環境ではカメラ API が使えません。HTTPS で開いているか確認してください。';
  $('startBtn').disabled = true;
}
