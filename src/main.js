// 画面とモードの制御。ページは一度も再読み込みしない（iOS のカメラ許可は
// リロードのたびに聞き直されるため、単一ページのまま状態だけ切り替える）。

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
    highFps: false,
    format: 'image/jpeg',
  },
  encoders: null,
  probe: null,
  permission: null,
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
    syncCapabilityControls(info.capabilities);

    // どの取得経路が速く、正しい向きを返すかは端末依存なので一度だけ測る
    state.probe = await probeBestPath(el.video, state.track).catch(() => null);
    el.deviceInfo.textContent = describeDevice(info);
    el.shutter.disabled = false;
    el.start.classList.add('hidden');
    updatePermissionInfo();
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

/** トラックが生きているか。死んでいれば開き直しが要る。 */
function isStreamAlive() {
  return state.track?.readyState === 'live';
}

/** 起動時に調べた許可の状態を設定シートに出す。 */
function updatePermissionInfo() {
  const info = $('permissionInfo');
  if (!info) return;
  const p = state.permission;
  if (!p) {
    info.textContent = '起動時の判定: 未取得';
    return;
  }
  const source = {
    'permissions-api': 'Permissions API',
    'device-labels': 'デバイス名が見えている',
    denied: '拒否されている',
    unknown: '判定できない',
  }[p.reason] ?? p.reason;
  info.textContent = p.granted
    ? `起動時の判定: 前回の許可が残っていた（${source}）`
    : `起動時の判定: 許可は残っていなかった（${source}）`;
}

/**
 * 解像度を変える。まず applyConstraints で試し、駄目なときだけ開き直す。
 * ストリームを作り直さなければ、許可の再取得も起きない。
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
    // iOS は縦横を入れ替えて返すので、画素数で近さを判定する
    const wanted = width * height;
    const got = info.width * info.height;
    if (Math.abs(got - wanted) / wanted > 0.25) throw new Error('要求に届きませんでした');
    setStatus(`${info.width}×${info.height}`, modeLabel());
    el.deviceInfo.textContent = describeDevice(info);
    toast(`${info.width}×${info.height} に変更しました`);
  } catch {
    await startCamera();
  }
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
  const available = Object.entries(paths).filter(([, ok]) => ok).map(([k]) => k).join('/');
  const chosen = getPreferredPath();
  const timing = state.probe?.results
    ?.filter((r) => r.usable)
    .map((r) => `${r.path} ${r.median.toFixed(1)}ms`)
    .join('・');
  return `${info.width}×${info.height} @${Math.round(info.frameRate)}fps`
    + `・経路 ${available}（採用: ${chosen ?? '—'}）`
    + (timing ? `・${timing}` : '')
    + (isPhotoModeAvailable() ? '・写真API あり' : '・写真API なし');
}

function syncZoomButtons(caps) {
  const holder = $('zooms');
  holder.innerHTML = '';
  const zoom = caps?.zoom;
  if (!zoom || typeof zoom.min !== 'number') {
    holder.hidden = true;
    return;
  }
  const current = state.track?.getSettings?.().zoom ?? 1;
  const steps = [0.5, 1, 2, 3].filter((v) => v >= zoom.min && v <= (zoom.max ?? v));
  if (steps.length < 2) {
    holder.hidden = true;
    return;
  }
  holder.hidden = false;
  for (const value of steps) {
    const button = document.createElement('button');
    button.textContent = `${value}×`;
    button.setAttribute('aria-pressed', String(Math.abs(current - value) < 0.05));
    button.addEventListener('click', async () => {
      const result = await applyIfSupported(state.track, { zoom: value });
      if (!result.applied) {
        toast('この端末ではズームを変えられません');
        return;
      }
      for (const other of holder.children) other.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      const slider = $('zoomInput');
      slider.value = value;
      $('zoomValue').textContent = `${value.toFixed(1)}×`;
    });
    holder.appendChild(button);
  }
}

function syncCapabilityControls(caps) {
  const zoomRow = $('zoomRow');
  const torchRow = $('torchRow');
  syncZoomButtons(caps);
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
  if (state.mode === 'single') return '即写';
  if (state.mode === 'stack') return `合成×${state.settings.frames}`;
  return '単写';
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
  const blob = await canvasToBlob(canvas, {
    type: state.settings.format,
    quality: state.settings.quality,
  });
  setBusy(false);
  showResult(blob, `${width}×${height}・${path}・${colorSpace}・${Math.round(performance.now() - started)}ms`);
}

async function shootStack() {
  const frames = state.settings.frames;
  setBusy(true, `連写中… 0/${frames}`);
  const started = performance.now();

  // 撮影時間が短いほど手ぶれの累積が減るので、可能なら一時的に 60fps を要求する
  let restoreFrameRate = null;
  if (state.settings.highFps) {
    const before = state.track.getSettings?.().frameRate;
    const applied = await applyIfSupported(state.track, { frameRate: 60 });
    if (applied.applied && before) restoreFrameRate = before;
  }

  const result = await captureStack(el.video, state.track, {
    frames,
    scale: state.settings.drizzle ? 2 : 1,
    sharpen: state.settings.sharpen,
    onProgress: ({ used }) => setProgress(used / frames, `連写中… ${used}/${frames}`),
  });
  setProgress(1, '書き出し中…');
  const blob = await canvasToBlob(result.canvas, {
    type: state.settings.format,
    quality: state.settings.quality,
  });
  result.stacker?.dispose?.();
  if (restoreFrameRate) await applyIfSupported(state.track, { frameRate: restoreFrameRate });
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
      '単写は端末内部の写真撮影処理（AVCapturePhotoOutput）を使います。\n\n'
      + '手元の iPhone（iOS 18.7）では無音でしたが、WebKit 側に音を止める処理は無く、'
      + '機種や iOS の版によっては鳴る可能性があります。\n'
      + '初めて使うときは、音量を上げた状態で一度試してください。\n\n'
      + '・解像度は映像と同じ（高解像にはならない）\n'
      + '・撮影に 0.3〜1.4 秒かかる\n'
      + '・モードに入って 1 枚目は焦点や露出が甘いことがある\n\n'
      + '続けますか？',
    );
    if (!ok) return;
    state.photoWarned = true;
  }
  setBusy(true, '撮影中…');
  const started = performance.now();
  try {
    // サイズは要求しない。実測では要求しても映像と同じ大きさに丸められ、
    // 能力値の最大を要求したときだけカメラ接続が落ちた。
    const { blob, width, height } = await takePhotoBlob(state.track);
    setBusy(false);
    showResult(blob, `${width}×${height}・単写（写真API）・${Math.round(performance.now() - started)}ms`);
  } catch (err) {
    setBusy(false);
    const dead = !isTrackAlive(state.track);
    toast(
      `写真 API が失敗しました: ${err?.message ?? err}`
      + (dead ? '（カメラを開き直します）' : ''),
      4500,
    );
    // IPC が切れるとトラックごと死ぬので、開き直して撮影を続けられるようにする
    if (dead) await startCamera();
  }
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
  const ext = EXTENSION_OF_TYPE[state.lastBlob.type] ?? 'jpg';
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

// バックグラウンドに回ってもストリームは止めない。
// 止めて取り直すと getUserMedia をもう一度呼ぶことになり、許可を聞かれる場合があるため。
// iOS 側がトラックを終了させたときだけ開き直す。
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (el.start.classList.contains('hidden') && !isStreamAlive()) {
    await startCamera();
  } else if (isStreamAlive()) {
    // 復帰直後に映像が止まって見えることがあるので、再生だけ促す
    el.video.play().catch(() => {});
    requestWakeLock();
  }
});

// ---------- 入力の結線 ----------

/** 端末が本当に符号化できる形式だけを選択肢に出す。 */
async function populateFormats() {
  const select = $('formatSelect');
  const results = await probeEncoders().catch(() => null);
  state.encoders = results;
  if (!results) return;

  const labels = {
    'image/jpeg': 'JPEG',
    'image/heic': 'HEIC（iOS 標準・同画質で小さい）',
    'image/avif': 'AVIF',
    'image/webp': 'WebP',
    'image/png': 'PNG（無圧縮に近い・巨大）',
  };
  const supported = Object.entries(results)
    .filter(([, r]) => r.supported)
    .map(([type]) => type);

  select.innerHTML = '';
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
    // ストリームを作り直すと許可を聞かれることがあるので、まず制約の適用で済ませる
    await changeResolution();
  });

  highFps.addEventListener('change', () => {
    state.settings.highFps = highFps.checked;
    saveSettings();
  });
  format.addEventListener('change', () => {
    state.settings.format = format.value;
    saveSettings();
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
    // 別ページへ移ると文書が変わり、戻ったときに許可を取り直しになることがある
    const ok = window.confirm(
      '診断ページへ移動します。\n'
      + 'アプリから離れるため、戻ったときにカメラの許可をもう一度聞かれる場合があります。\n\n'
      + '移動しますか？',
    );
    if (ok) window.location.href = './diag.html';
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

/**
 * 起動処理。
 * 許可が残っているなら開始ボタンを待たずにカメラを開く（タップ 1 回ぶん省ける）。
 * 判定は getUserMedia を呼ばずに行うので、これ自体でプロンプトは出ない。
 */
async function boot() {
  if (!navigator.mediaDevices?.getUserMedia) {
    el.startNote.textContent = 'この環境ではカメラ API が使えません。HTTPS で開いているか確認してください。';
    $('startBtn').disabled = true;
    return;
  }

  const permission = await inspectCameraPermission();
  state.permission = permission;

  if (permission.granted) {
    el.startNote.textContent = '前回の許可が残っています。カメラを開いています…';
    await startCamera();
    return;
  }
  if (permission.permissionState === 'denied') {
    el.startNote.textContent = 'カメラが拒否されています。'
      + '設定 → アプリ → Safari → カメラ を「許可」または「確認」に戻してください。';
    return;
  }
  el.startNote.textContent = '';
}

loadSettings();
bindSettings();
bindUi();
setMode('single');
registerServiceWorker();
populateFormats();
boot();
