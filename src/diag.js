// 実機計測ハーネス。推測で設計しないために、端末の実力をここで確定させる。

import {
  RESOLUTION_LADDER, openStream, stopStream, inspectTrack, attachToVideo,
} from './camera.js';
import {
  grabSilentFrame, detectSilentPaths, resetImageCaptureCache, matchesOrientation,
} from './capture/frame.js';
import { onEachFrame, sharpnessScore } from './capture/burst.js';
import { isPhotoModeAvailable, takePhotoBlob, getPhotoCapabilities, isTrackAlive } from './capture/photo.js';
import { isGpuStackSupported, GpuStacker } from './pipeline/merge.js';
import { probeEncoders, canvasToBlob } from './encode.js';

const $ = (id) => document.getElementById(id);
const video = $('video');

const report = {
  generatedAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
};

let stream = null;
let track = null;

function show(id, value) {
  $(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  refreshResult();
}

function refreshResult() {
  $('resultOut').textContent = JSON.stringify(report, null, 2);
}

function table(rows, columns) {
  const head = columns.map((c) => `<th>${c.label}</th>`).join('');
  const body = rows.map((row) => `<tr>${columns.map((c) => `<td>${row[c.key] ?? ''}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---- 0. 環境 ----
(function environment() {
  const paths = detectSilentPaths();
  report.environment = {
    standalone: !!window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches,
    secureContext: window.isSecureContext,
    devicePixelRatio: window.devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    silentPaths: paths,
    imageCapture: typeof ImageCapture !== 'undefined',
    takePhoto: isPhotoModeAvailable(),
    webCodecs: typeof VideoFrame !== 'undefined',
    mediaStreamTrackProcessor: typeof MediaStreamTrackProcessor !== 'undefined',
    webgpu: 'gpu' in navigator,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    wakeLock: 'wakeLock' in navigator,
    shareFiles: !!(navigator.canShare && navigator.canShare({
      files: [new File([new Uint8Array([0])], 'a.jpg', { type: 'image/jpeg' })],
    })),
  };
  show('envOut', report.environment);
}());

// ---- 1. カメラを開く ----
async function open(facingMode) {
  stopStream(stream);
  resetImageCaptureCache();
  show('openOut', '起動中…');
  try {
    stream = await openStream({ facingMode });
    track = stream.getVideoTracks()[0];
    await attachToVideo(video, stream);
    const info = inspectTrack(track);
    report.opened = { facingMode, ...info };
    show('openOut', info);
  } catch (err) {
    show('openOut', `失敗: ${err?.name ?? ''} ${err?.message ?? err}`);
  }
}
$('openBack').addEventListener('click', () => open('environment'));
$('openFront').addEventListener('click', () => open('user'));

// ---- 2. 解像度ラダー ----
$('ladderBtn').addEventListener('click', async () => {
  $('ladderBtn').disabled = true;
  const rows = [];
  const facingMode = report.opened?.facingMode ?? 'environment';
  for (const res of RESOLUTION_LADDER) {
    for (const powerEfficient of [true, false]) {
      let local = null;
      try {
        local = await openStream({ facingMode, ...res, powerEfficient });
        const t = local.getVideoTracks()[0];
        const s = t.getSettings();
        rows.push({
          requested: `${res.width}×${res.height}`,
          binned: powerEfficient ? '既定' : '抑止',
          actual: `${s.width}×${s.height}`,
          fps: Math.round(s.frameRate ?? 0),
        });
      } catch (err) {
        rows.push({
          requested: `${res.width}×${res.height}`,
          binned: powerEfficient ? '既定' : '抑止',
          actual: `× ${err?.name ?? ''}`,
          fps: '',
        });
      } finally {
        stopStream(local);
      }
      $('ladderOut').innerHTML = table(rows, [
        { key: 'requested', label: '要求' },
        { key: 'binned', label: 'binned' },
        { key: 'actual', label: '実際' },
        { key: 'fps', label: 'fps' },
      ]);
    }
  }
  report.resolutionLadder = rows;
  refreshResult();
  $('ladderBtn').disabled = false;
  // 探索でストリームを開き直したので元の状態に戻す
  await open(facingMode);
});

// ---- 3. 能力 ----
$('capsBtn').addEventListener('click', async () => {
  if (!track) return show('capsOut', '先にカメラを開いてください');
  const info = inspectTrack(track);
  const photoCaps = await getPhotoCapabilities(track);
  report.capabilities = { settings: info.settings, capabilities: info.capabilities, photoCapabilities: photoCaps };
  show('capsOut', report.capabilities);
});

// ---- 4. 取得経路ベンチ ----
$('benchBtn').addEventListener('click', async () => {
  if (!track) return show('benchOut', '先にカメラを開いてください');
  $('benchBtn').disabled = true;
  const rows = [];
  for (const path of ['grabFrame', 'videoFrame', 'drawImage']) {
    const times = [];
    let size = '';
    let error = '';
    let oriented = null;
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      try {
        const frame = await grabSilentFrame(video, track, { prefer: path });
        if (frame.path !== path) { error = `${path} 非対応（${frame.path} が使われました）`; frame.bitmap.close?.(); break; }
        times.push(performance.now() - t0);
        size = `${frame.width}×${frame.height}`;
        oriented = matchesOrientation(frame.width, frame.height, video);
        frame.bitmap.close?.();
      } catch (err) {
        error = String(err?.message ?? err);
        break;
      }
    }
    times.sort((a, b) => a - b);
    rows.push({
      path,
      size: size || '—',
      median: times.length ? `${times[Math.floor(times.length / 2)].toFixed(1)}ms` : '—',
      oriented: oriented === null ? '—' : (oriented ? '一致' : '回転'),
      note: error,
    });
    $('benchOut').innerHTML = table(rows, [
      { key: 'path', label: '経路' },
      { key: 'size', label: '解像度' },
      { key: 'median', label: '中央値' },
      { key: 'oriented', label: '向き' },
      { key: 'note', label: '備考' },
    ]);
  }
  report.framePaths = rows;
  refreshResult();
  $('benchBtn').disabled = false;
});

// ---- 5. 連写レート ----
$('fpsBtn').addEventListener('click', async () => {
  if (!track) return show('fpsOut', '先にカメラを開いてください');
  $('fpsBtn').disabled = true;
  let frames = 0;
  let bitmaps = 0;
  const started = performance.now();
  await new Promise((resolve) => {
    const stop = onEachFrame(video, async () => {
      frames += 1;
      try {
        const bmp = await createImageBitmap(video);
        bitmaps += 1;
        bmp.close?.();
      } catch { /* 取りこぼしも計測対象 */ }
      if (performance.now() - started > 3000) { stop(); resolve(); }
    });
  });
  const seconds = (performance.now() - started) / 1000;
  report.burst = {
    callbackFps: +(frames / seconds).toFixed(1),
    bitmapFps: +(bitmaps / seconds).toFixed(1),
    api: typeof video.requestVideoFrameCallback === 'function' ? 'requestVideoFrameCallback' : 'requestAnimationFrame',
  };
  show('fpsOut', report.burst);
  $('fpsBtn').disabled = false;
});

// ---- 6. 写真 API ----
async function runTakePhoto(maxSize) {
  const key = maxSize ? 'takePhotoMaxSize' : 'takePhoto';
  if (!track) return show('photoOut', '先にカメラを開いてください');
  if (!isPhotoModeAvailable()) {
    report[key] = { supported: false };
    return show('photoOut', 'この Safari は takePhoto に対応していません');
  }
  $('photoBtn').disabled = true;
  $('photoMaxBtn').disabled = true;
  const t0 = performance.now();
  const settings = track.getSettings();
  try {
    const { blob, width, height, requested } = await takePhotoBlob(track, { maxSize });
    report[key] = {
      supported: true,
      maxSizeRequested: maxSize,
      photoSize: `${width}×${height}`,
      videoSize: `${settings.width}×${settings.height}`,
      largerThanVideo: width * height > (settings.width ?? 0) * (settings.height ?? 0),
      type: blob.type,
      bytes: blob.size,
      elapsedMs: Math.round(performance.now() - t0),
      requested,
      trackAliveAfter: isTrackAlive(track),
      shutterSound: 'unknown',
    };
    $('soundAsk').hidden = false;
    lastPhotoKey = key;
  } catch (err) {
    report[key] = {
      supported: true,
      maxSizeRequested: maxSize,
      error: String(err?.message ?? err),
      trackAliveAfter: isTrackAlive(track),
      hint: isTrackAlive(track) ? '' : 'トラックが死にました。カメラを開き直してください。',
    };
  }
  $('photoOut').innerHTML = `<pre>${JSON.stringify(report[key], null, 2)}</pre>`;
  refreshResult();
  $('photoBtn').disabled = false;
  $('photoMaxBtn').disabled = false;
}

let lastPhotoKey = 'takePhoto';
$('photoBtn').addEventListener('click', () => runTakePhoto(false));
$('photoMaxBtn').addEventListener('click', () => runTakePhoto(true));

const recordSound = (value) => {
  const entry = report[lastPhotoKey];
  if (entry) entry.shutterSound = value;
  $('photoOut').innerHTML = `<pre>${JSON.stringify(entry, null, 2)}</pre>`;
  refreshResult();
};
$('soundYes').addEventListener('click', () => recordSound('played'));
$('soundNo').addEventListener('click', () => recordSound('silent'));

// ---- 7. GPU ----
$('gpuBtn').addEventListener('click', async () => {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  const info = {
    webgl2: !!gl,
    floatRenderTarget: isGpuStackSupported(),
    webgpu: 'gpu' in navigator,
    maxTextureSize: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0,
    renderer: gl ? (() => {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
    })() : 'none',
  };

  if (info.floatRenderTarget) {
    // ベンチは 1920x1080 相当の合成画像で行う（カメラの実解像度で 2 倍格子まで
    // 試すとメモリを使い切るため）。
    try {
      const sample = syntheticFrame(1920, 1080, 0, 0);
      const stacker = new GpuStacker();
      for (const scale of [1, 2]) {
        stacker.begin(1920, 1080, { scale, bicubic: scale > 1 });
        const t0 = performance.now();
        for (let i = 0; i < 10; i += 1) {
          stacker.addFrame(sample, { dx: i * 0.3, dy: i * 0.2, weight: 1 });
        }
        stacker.finish({ sharpen: 0.3 });
        info[`stack10x${scale}Ms`] = Math.round(performance.now() - t0);
        info[`output${scale}x`] = `${stacker.outWidth}×${stacker.outHeight}`;
        info[`accumFormat${scale}x`] = stacker.accumFormat;
      }
      stacker.dispose();
    } catch (err) {
      info.stackError = String(err?.message ?? err);
    }
  }
  report.gpu = info;
  show('gpuOut', info);
});

// ---- 8. 書き出し ----
$('encodeBtn').addEventListener('click', async () => {
  $('encodeBtn').disabled = true;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  let p3 = false;
  try {
    const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
    p3 = ctx?.getContextAttributes?.().colorSpace === 'display-p3';
  } catch { p3 = false; }

  // blob.type を鵜呑みにせず、マジックバイトと再デコードで実体を確かめる
  report.encode = { displayP3Canvas: p3, encoders: await probeEncoders() };
  show('encodeOut', report.encode);
  $('encodeBtn').disabled = false;
});

// ---- 9. 結果 ----
$('copyBtn').addEventListener('click', async () => {
  const text = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $('copyBtn').textContent = 'コピーしました';
    setTimeout(() => { $('copyBtn').textContent = '結果をコピー'; }, 1500);
  } catch {
    window.prompt('コピーしてください', text);
  }
});
$('shareBtn').addEventListener('click', async () => {
  const text = JSON.stringify(report, null, 2);
  const file = new File([text], 'ios-cam-diag.json', { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
  else if (navigator.share) await navigator.share({ text });
});
$('backBtn').addEventListener('click', () => { window.location.href = './index.html'; });

refreshResult();
window.addEventListener('pagehide', () => stopStream(stream));

// ---- 7b. GPU シェーダと CPU 実装の一致テスト ----
// シェーダはヘッドレスで検証できないため、同じ入力・同じずれを両経路に通し、
// 出力がどれだけ一致するかを端末上で確かめる。

function syntheticFrame(width, height, offsetX, offsetY) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x + offsetX;
      const v = y + offsetY;
      const i = (y * width + x) * 4;
      image.data[i] = 40 + ((u * 5) % 180);
      image.data[i + 1] = 30 + ((v * 7) % 200);
      image.data[i + 2] = 60 + (((u + v) * 3) % 150);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function readCanvas(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

$('selfTestBtn').addEventListener('click', async () => {
  $('selfTestBtn').disabled = true;
  const size = 96;
  const shifts = [
    { dx: 0, dy: 0, isReference: true },
    { dx: 2, dy: 1 },
    { dx: -1.5, dy: 0.5 },
    { dx: 0.25, dy: -2 },
  ];
  // 合成器は出力画素 (x,y) に対しソースの (x+dx, y+dy) を引く。
  // そのため内容を -dx だけずらして作れば、指定シフトで重ねたとき元の絵に戻る。
  const canvases = shifts.map((s) => syntheticFrame(size, size, -s.dx, -s.dy));

  const { CpuStacker } = await import('./pipeline/cpu-merge.js');

  const runPair = async (sources) => {
    const cpu = new CpuStacker();
    cpu.begin(size, size, { noise: 0.14 });
    shifts.forEach((s, i) => cpu.addFrame(sources[i], { ...s, weight: 1 }));
    const cpuBytes = readCanvas(cpu.finish({ sharpen: 0 }), size, size);
    cpu.dispose();

    const gpu = new GpuStacker();
    gpu.begin(size, size, { scale: 1, bicubic: false, noise: 0.14 });
    shifts.forEach((s, i) => gpu.addFrame(sources[i], { ...s, weight: 1 }));
    const gpuBytes = readCanvas(gpu.finish({ sharpen: 0 }), size, size);
    gpu.dispose();

    // 端はサンプル範囲外の扱いが違うので内側だけ比べる
    const margin = 6;
    let worst = 0;
    let total = 0;
    let count = 0;
    let flippedWorst = 0;
    for (let y = margin; y < size - margin; y += 1) {
      for (let x = margin; x < size - margin; x += 1) {
        for (let c = 0; c < 3; c += 1) {
          const cpuValue = cpuBytes[(y * size + x) * 4 + c];
          const d = Math.abs(cpuValue - gpuBytes[(y * size + x) * 4 + c]);
          worst = Math.max(worst, d);
          total += d;
          count += 1;
          // 上下反転した場合との差も測り、「たまたま対称で気づけない」状況を避ける
          const flipped = gpuBytes[((size - 1 - y) * size + x) * 4 + c];
          flippedWorst = Math.max(flippedWorst, Math.abs(cpuValue - flipped));
        }
      }
    }
    return {
      maxDiff: worst,
      meanDiff: +(total / count).toFixed(3),
      maxDiffIfFlipped: flippedWorst,
      verdict: worst <= 6 ? 'ok（一致）' : worst <= 16 ? '許容範囲（精度差）' : 'NG（シェーダを確認）',
    };
  };

  const result = { size, frames: shifts.length };
  try {
    result.canvasInput = await runPair(canvases);
    // 実撮影と同じ ImageBitmap 入力でも確かめる。
    // WebGL は ImageBitmap で UNPACK_FLIP_Y_WEBGL が無視されるため、ここが本番の条件になる。
    const bitmaps = await Promise.all(canvases.map((c) => createImageBitmap(c)));
    result.imageBitmapInput = await runPair(bitmaps);
    bitmaps.forEach((b) => b.close?.());

    result.orientationOk = result.imageBitmapInput.maxDiff <= 6
      && result.imageBitmapInput.maxDiffIfFlipped > result.imageBitmapInput.maxDiff;
  } catch (err) {
    result.error = String(err?.message ?? err);
  }
  report.selfTest = result;
  show('gpuOut', result);
  $('selfTestBtn').disabled = false;
});


// ---- 10. 写真API と フレーム切り出しの比較 ----
//
// 「写真 API が無音なら、他の方式は要らないのでは」を数字で判断するための計測。
// 解像度・バイト数・所要時間に加えて、シャープネス（ラプラシアン分散）と
// ノイズ（平坦部の標準偏差）を同じ条件で比べる。

/** 中央を切り出して解析用の ImageData を返す。両者を同じ画素数で比べるため。 */
async function centerCrop(source, size = 512) {
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
  const side = Math.min(size, bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(
    bitmap,
    Math.floor((bitmap.width - side) / 2), Math.floor((bitmap.height - side) / 2), side, side,
    0, 0, side, side,
  );
  const data = ctx.getImageData(0, 0, side, side);
  if (source instanceof Blob) bitmap.close?.();
  return data;
}

/**
 * 平坦な場所の標準偏差をノイズの目安として返す。
 * 8x8 ブロックごとの標準偏差を求め、その下位 10% の中央値を取る
 * （模様のある場所を避けて、のっぺりした部分だけを見る）。
 */
function noiseFloor(imageData) {
  const { data, width, height } = imageData;
  const block = 8;
  const stds = [];
  for (let by = 0; by + block <= height; by += block) {
    for (let bx = 0; bx + block <= width; bx += block) {
      let sum = 0;
      let sumSq = 0;
      for (let y = 0; y < block; y += 1) {
        for (let x = 0; x < block; x += 1) {
          const i = ((by + y) * width + (bx + x)) * 4;
          const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          sum += v;
          sumSq += v * v;
        }
      }
      const n = block * block;
      stds.push(Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2)));
    }
  }
  if (stds.length === 0) return 0;
  stds.sort((a, b) => a - b);
  const flat = stds.slice(0, Math.max(1, Math.round(stds.length * 0.1)));
  return flat[Math.floor(flat.length / 2)];
}

async function measureBlob(blob) {
  const crop = await centerCrop(blob);
  return {
    bytes: blob.size,
    type: blob.type,
    sharpness: Math.round(sharpnessScore(crop)),
    noise: +noiseFloor(crop).toFixed(2),
  };
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 1 つの解像度について、写真 API とフレーム切り出しを同条件で撮り比べる。 */
async function compareAtResolution(res) {
  const facingMode = report.opened?.facingMode ?? 'environment';
  if (res) {
    stopStream(stream);
    resetImageCaptureCache();
    stream = await openStream({ facingMode, ...res });
    track = stream.getVideoTracks()[0];
    await attachToVideo(video, stream);
    await wait(1200); // 露出と焦点が落ち着くのを待つ
  }
  const settings = track.getSettings();
  const entry = {
    requested: res ? `${res.width}×${res.height}` : '現在の設定',
    videoSize: `${settings.width}×${settings.height}`,
    photo: null,
    frame: null,
    shutterSound: 'unknown',
  };

  // 写真 API を 3 回（初回だけ遅いのかを見る）
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      const shot = await takePhotoBlob(track);
      // eslint-disable-next-line no-await-in-loop
      const metrics = await measureBlob(shot.blob);
      runs.push({
        ok: true,
        size: `${shot.width}×${shot.height}`,
        ms: Math.round(performance.now() - t0),
        ...metrics,
      });
    } catch (err) {
      runs.push({ ok: false, error: String(err?.message ?? err), ms: Math.round(performance.now() - t0) });
      break;
    }
  }
  entry.photoRuns = runs;
  entry.photo = runs.find((r) => r.ok) ?? null;
  entry.trackAliveAfterPhoto = isTrackAlive(track);

  // 同じ場面をフレーム切り出しでも撮る
  if (isTrackAlive(track)) {
    const t0 = performance.now();
    const frame = await grabSilentFrame(video, track);
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext('2d').drawImage(frame.bitmap, 0, 0);
    frame.bitmap.close?.();
    const blob = await canvasToBlob(canvas, { type: 'image/jpeg', quality: 0.95 });
    entry.frame = {
      ok: true,
      path: frame.path,
      size: `${frame.width}×${frame.height}`,
      ms: Math.round(performance.now() - t0),
      ...(await measureBlob(blob)),
    };
  }
  return entry;
}

function renderComparison(entries) {
  const rows = [];
  for (const e of entries) {
    for (const [label, m] of [['写真API', e.photo], ['フレーム', e.frame]]) {
      rows.push({
        session: e.videoSize,
        method: label,
        size: m?.size ?? (e.photoRuns?.[0]?.error ? '×' : '—'),
        bytes: m ? `${(m.bytes / 1024).toFixed(0)}KB` : '—',
        ms: m ? `${m.ms}ms` : (e.photoRuns?.[0]?.ms ? `${e.photoRuns[0].ms}ms` : '—'),
        sharp: m ? m.sharpness : '—',
        noise: m ? m.noise : '—',
      });
    }
  }
  $('compareOut').innerHTML = table(rows, [
    { key: 'session', label: 'セッション' },
    { key: 'method', label: '方式' },
    { key: 'size', label: '解像度' },
    { key: 'bytes', label: 'サイズ' },
    { key: 'ms', label: '所要' },
    { key: 'sharp', label: 'シャープ↑' },
    { key: 'noise', label: 'ノイズ↓' },
  ]);

  // 解像度ごとに音の有無を記録できるようにする
  const holder = $('compareSound');
  holder.innerHTML = '<p class="hint">写真 API の撮影時、シャッター音は鳴りましたか？</p>';
  entries.forEach((e, index) => {
    const line = document.createElement('div');
    line.innerHTML = `<span class="hint">${e.videoSize}: </span>`;
    for (const [label, value, cls] of [['鳴った', 'played', 'bad'], ['鳴らなかった', 'silent', 'good']]) {
      const button = document.createElement('button');
      button.className = cls;
      button.textContent = label;
      button.addEventListener('click', () => {
        report.comparison[index].shutterSound = value;
        line.querySelector('.mark')?.remove();
        const mark = document.createElement('span');
        mark.className = 'mark hint';
        mark.textContent = ` → ${label}`;
        line.appendChild(mark);
        refreshResult();
      });
      line.appendChild(button);
    }
    holder.appendChild(line);
  });
}

async function runComparison(resolutions) {
  $('compareBtn').disabled = true;
  $('compareCurrentBtn').disabled = true;
  report.comparison = [];
  try {
    for (const res of resolutions) {
      $('compareOut').innerHTML = `<pre>${res ? `${res.width}×${res.height}` : '現在の設定'} を計測中…</pre>`;
      // eslint-disable-next-line no-await-in-loop
      const entry = await compareAtResolution(res);
      report.comparison.push(entry);
      renderComparison(report.comparison);
      refreshResult();
    }
  } catch (err) {
    $('compareOut').innerHTML += `<pre>中断: ${err?.message ?? err}</pre>`;
  }
  $('compareBtn').disabled = false;
  $('compareCurrentBtn').disabled = false;
}

$('compareBtn').addEventListener('click', () => runComparison([
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 3840, height: 2160 },
]));
$('compareCurrentBtn').addEventListener('click', () => runComparison([null]));

// ---- 11. 写真 API の要求サイズ上限 ----
$('limitBtn').addEventListener('click', async () => {
  if (!track) return show('limitOut', '先にカメラを開いてください');
  $('limitBtn').disabled = true;
  const base = track.getSettings();
  const caps = await getPhotoCapabilities(track);
  const candidates = [
    { label: '×1（映像と同じ）', width: base.width, height: base.height },
    { label: '×1.5', width: Math.round(base.width * 1.5), height: Math.round(base.height * 1.5) },
    { label: '×2', width: base.width * 2, height: base.height * 2 },
  ];
  if (caps?.imageWidth?.max) {
    candidates.push({ label: '能力値の最大', width: caps.imageWidth.max, height: caps.imageHeight.max });
  }

  const rows = [];
  for (const candidate of candidates) {
    let row;
    try {
      // eslint-disable-next-line no-await-in-loop
      const shot = await takePhotoBlob(track, { size: { width: candidate.width, height: candidate.height } });
      row = {
        requested: `${candidate.label} ${candidate.width}×${candidate.height}`,
        result: `${shot.width}×${shot.height}`,
        bytes: `${(shot.blob.size / 1024).toFixed(0)}KB`,
        alive: isTrackAlive(track) ? '生存' : '死亡',
      };
    } catch (err) {
      row = {
        requested: `${candidate.label} ${candidate.width}×${candidate.height}`,
        result: `× ${err?.message ?? err}`,
        bytes: '—',
        alive: isTrackAlive(track) ? '生存' : '死亡',
      };
    }
    rows.push(row);
    $('limitOut').innerHTML = table(rows, [
      { key: 'requested', label: '要求' },
      { key: 'result', label: '結果' },
      { key: 'bytes', label: 'サイズ' },
      { key: 'alive', label: 'トラック' },
    ]);
    if (!isTrackAlive(track)) {
      // eslint-disable-next-line no-await-in-loop
      await open(report.opened?.facingMode ?? 'environment');
    }
  }
  report.photoSizeLimit = rows;
  refreshResult();
  $('limitBtn').disabled = false;
});
