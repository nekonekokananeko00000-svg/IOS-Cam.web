// 実機計測ハーネス。推測で設計しないために、端末の実力をここで確定させる。

import {
  RESOLUTION_LADDER, openStream, stopStream, inspectTrack, attachToVideo,
} from './camera.js';
import { grabSilentFrame, detectSilentPaths, resetImageCaptureCache } from './capture/frame.js';
import { onEachFrame } from './capture/burst.js';
import { isPhotoModeAvailable, takePhotoBlob, getPhotoCapabilities } from './capture/photo.js';
import { isGpuStackSupported, GpuStacker } from './pipeline/merge.js';

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
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      try {
        const frame = await grabSilentFrame(video, track, { prefer: path });
        if (frame.path !== path) { error = `${path} 非対応（${frame.path} が使われました）`; frame.bitmap.close?.(); break; }
        times.push(performance.now() - t0);
        size = `${frame.width}×${frame.height}`;
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
      note: error,
    });
    $('benchOut').innerHTML = table(rows, [
      { key: 'path', label: '経路' },
      { key: 'size', label: '解像度' },
      { key: 'median', label: '中央値' },
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
$('photoBtn').addEventListener('click', async () => {
  if (!track) return show('photoOut', '先にカメラを開いてください');
  if (!isPhotoModeAvailable()) {
    report.takePhoto = { supported: false };
    return show('photoOut', 'この Safari は takePhoto に対応していません');
  }
  $('photoBtn').disabled = true;
  const t0 = performance.now();
  try {
    const { blob, width, height, requested } = await takePhotoBlob(track);
    const settings = track.getSettings();
    report.takePhoto = {
      supported: true,
      photoSize: `${width}×${height}`,
      videoSize: `${settings.width}×${settings.height}`,
      largerThanVideo: width * height > (settings.width ?? 0) * (settings.height ?? 0),
      type: blob.type,
      bytes: blob.size,
      elapsedMs: Math.round(performance.now() - t0),
      requested,
      shutterSound: 'unknown',
    };
    $('photoOut').innerHTML = `<pre>${JSON.stringify(report.takePhoto, null, 2)}</pre>`;
    $('soundAsk').hidden = false;
  } catch (err) {
    report.takePhoto = { supported: true, error: String(err?.message ?? err) };
    $('photoOut').innerHTML = `<pre>失敗: ${err?.message ?? err}</pre>`;
  }
  refreshResult();
  $('photoBtn').disabled = false;
});

const recordSound = (value) => {
  if (report.takePhoto) report.takePhoto.shutterSound = value;
  $('photoOut').innerHTML = `<pre>${JSON.stringify(report.takePhoto, null, 2)}</pre>`;
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
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  let p3 = false;
  try {
    const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
    p3 = ctx?.getContextAttributes?.().colorSpace === 'display-p3';
  } catch { p3 = false; }
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c33';
  ctx.fillRect(0, 0, 64, 64);

  const types = {};
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/avif']) {
    // eslint-disable-next-line no-await-in-loop
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
    types[type] = blob ? blob.type : 'null';
  }
  report.encode = { displayP3Canvas: p3, toBlob: types };
  show('encodeOut', report.encode);
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
  const size = 96;
  const shifts = [
    { dx: 0, dy: 0, isReference: true },
    { dx: 2, dy: 1 },
    { dx: -1.5, dy: 0.5 },
    { dx: 0.25, dy: -2 },
  ];
  // フレーム内容を shifts と逆向きにずらして作る（重ねると一致するはず）
  const frames = shifts.map((s) => syntheticFrame(size, size, s.dx, s.dy));

  const result = { size, frames: shifts.length };
  try {
    const { CpuStacker } = await import('./pipeline/cpu-merge.js');
    const cpu = new CpuStacker();
    cpu.begin(size, size, { noise: 0.14 });
    shifts.forEach((s, i) => cpu.addFrame(frames[i], { ...s, weight: 1 }));
    const cpuBytes = readCanvas(cpu.finish({ sharpen: 0 }), size, size);
    cpu.dispose();

    const gpu = new GpuStacker();
    gpu.begin(size, size, { scale: 1, bicubic: false, noise: 0.14 });
    shifts.forEach((s, i) => gpu.addFrame(frames[i], { ...s, weight: 1 }));
    const gpuBytes = readCanvas(gpu.finish({ sharpen: 0 }), size, size);
    gpu.dispose();

    // 端はサンプル範囲外の扱いが違うので内側だけ比べる
    let worst = 0;
    let total = 0;
    let count = 0;
    const margin = 6;
    for (let y = margin; y < size - margin; y += 1) {
      for (let x = margin; x < size - margin; x += 1) {
        for (let c = 0; c < 3; c += 1) {
          const d = Math.abs(cpuBytes[(y * size + x) * 4 + c] - gpuBytes[(y * size + x) * 4 + c]);
          worst = Math.max(worst, d);
          total += d;
          count += 1;
        }
      }
    }
    result.maxDiff = worst;
    result.meanDiff = +(total / count).toFixed(3);
    result.verdict = worst <= 6 ? 'ok（一致）' : worst <= 16 ? '許容範囲（精度差）' : 'NG（シェーダを確認）';
  } catch (err) {
    result.error = String(err?.message ?? err);
  }
  report.selfTest = result;
  show('gpuOut', result);
});
