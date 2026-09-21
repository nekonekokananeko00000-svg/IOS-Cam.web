// 無音のフレーム取得。いずれの経路も映像ストリームのコピーであり、
// 写真撮影 API（AVCapturePhotoOutput）を経由しないのでシャッター音は鳴らない。
//
//   1. ImageCapture.grabFrame()  … Safari 26+。ただし実機では 34ms と遅い場合がある
//   2. new VideoFrame(video)     … WebCodecs。実機では回転したフレーム（横長）を返すことがある
//   3. drawImage(video)          … どこでも動く。実測では最速だった
//
// どれが速く、どれが正しい向きを返すかは端末依存なので、起動時に一度測って決める。

let cachedImageCapture = null;
let cachedTrack = null;
let preferredPath = null;

function getImageCapture(track) {
  if (typeof ImageCapture === 'undefined') return null;
  if (cachedTrack === track && cachedImageCapture) return cachedImageCapture;
  try {
    cachedImageCapture = new ImageCapture(track);
    cachedTrack = track;
    return cachedImageCapture;
  } catch {
    return null;
  }
}

export function resetImageCaptureCache() {
  cachedImageCapture = null;
  cachedTrack = null;
  preferredPath = null;
}

/** 利用可能な無音経路を調べる。 */
export function detectSilentPaths() {
  return {
    grabFrame: typeof ImageCapture !== 'undefined'
      && typeof ImageCapture.prototype.grabFrame === 'function',
    videoFrame: typeof VideoFrame !== 'undefined',
    drawImage: true,
  };
}

/** video 要素と縦横の向きが一致しているか（回転して返す経路を弾くため）。 */
export function matchesOrientation(width, height, videoEl) {
  if (!videoEl?.videoWidth || !videoEl?.videoHeight) return true;
  const portraitSource = height > width;
  const portraitVideo = videoEl.videoHeight > videoEl.videoWidth;
  if (width === height || videoEl.videoWidth === videoEl.videoHeight) return true;
  return portraitSource === portraitVideo;
}

/** 指定経路で 1 枚取り出す（経路が使えなければ null）。 */
async function grabVia(path, videoEl, track) {
  if (path === 'grabFrame') {
    const ic = getImageCapture(track);
    if (!ic || typeof ic.grabFrame !== 'function') return null;
    const bitmap = await ic.grabFrame();
    return { bitmap, width: bitmap.width, height: bitmap.height, path };
  }
  if (path === 'videoFrame') {
    if (typeof VideoFrame === 'undefined') return null;
    const frame = new VideoFrame(videoEl, { timestamp: performance.now() * 1000 });
    try {
      const bitmap = await createImageBitmap(frame);
      return { bitmap, width: bitmap.width, height: bitmap.height, path };
    } finally {
      frame.close();
    }
  }
  const bitmap = await createImageBitmap(videoEl);
  return { bitmap, width: bitmap.width, height: bitmap.height, path };
}

/**
 * 各経路を実際に試し、正しい向きを返すもののうち最速を既定にする。
 * 起動時に一度だけ呼ぶ。
 * @returns {Promise<{best:string, results:Array}>}
 */
export async function probeBestPath(videoEl, track, { samples = 3 } = {}) {
  const paths = detectSilentPaths();
  const results = [];
  for (const path of ['drawImage', 'grabFrame', 'videoFrame']) {
    if (!paths[path]) continue;
    const times = [];
    let size = null;
    let oriented = true;
    let error = '';
    for (let i = 0; i < samples; i += 1) {
      const t0 = performance.now();
      try {
        // eslint-disable-next-line no-await-in-loop
        const frame = await grabVia(path, videoEl, track);
        if (!frame) { error = 'unavailable'; break; }
        times.push(performance.now() - t0);
        size = { width: frame.width, height: frame.height };
        oriented = matchesOrientation(frame.width, frame.height, videoEl);
        frame.bitmap.close?.();
        if (!oriented) break;
      } catch (err) {
        error = String(err?.message ?? err);
        break;
      }
    }
    if (times.length === 0) {
      results.push({ path, usable: false, error: error || 'failed' });
      continue;
    }
    times.sort((a, b) => a - b);
    results.push({
      path,
      usable: oriented,
      oriented,
      median: times[Math.floor(times.length / 2)],
      size,
      error,
    });
  }
  const usable = results.filter((r) => r.usable);
  usable.sort((a, b) => a.median - b.median);
  preferredPath = usable[0]?.path ?? 'drawImage';
  return { best: preferredPath, results };
}

export function getPreferredPath() {
  return preferredPath;
}

/**
 * 1フレームを ImageBitmap として取り出す（無音）。
 * 向きが video 要素と食い違う経路は採用しない。
 */
export async function grabSilentFrame(videoEl, track, { prefer = 'auto' } = {}) {
  const paths = detectSilentPaths();
  const first = prefer === 'auto' ? (preferredPath ?? 'drawImage') : prefer;
  const order = [first, 'drawImage', 'grabFrame', 'videoFrame']
    .filter((p, i, arr) => arr.indexOf(p) === i);

  let lastError = null;
  for (const path of order) {
    if (!paths[path]) continue;
    try {
      const frame = await grabVia(path, videoEl, track);
      if (!frame) continue;
      if (prefer === 'auto' && !matchesOrientation(frame.width, frame.height, videoEl)) {
        // 回転して返す経路（実機の VideoFrame など）は使わない
        frame.bitmap.close?.();
        lastError = new Error(`${path} は向きが一致しません`);
        continue;
      }
      return frame;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('フレームを取得できませんでした');
}

/**
 * 単発撮影用。display-p3 が使えるならそのまま広色域で受ける。
 * 合成を挟まない経路なので、ブラウザ側の色変換をそのまま活かせる。
 */
export async function grabToCanvas(videoEl, track, { wideGamut = true } = {}) {
  const { bitmap, width, height, path } = await grabSilentFrame(videoEl, track);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let colorSpace = 'srgb';
  let ctx = null;
  if (wideGamut) {
    try {
      ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
      if (ctx) colorSpace = ctx.getContextAttributes?.().colorSpace ?? 'display-p3';
    } catch {
      ctx = null;
    }
  }
  if (!ctx) ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return { canvas, width, height, path, colorSpace };
}
