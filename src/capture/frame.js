// 映像から 1 コマを取り出す処理。いずれも映像の複製であり、
// 写真撮影の仕組み（AVCapturePhotoOutput）を通らないため、シャッター音は鳴らない。
//
//   1. ImageCapture.grabFrame()  Safari 26 以降で使える。実測では 34 ミリ秒と遅かった
//   2. new VideoFrame(video)     実測では横向きに回転したコマが返った
//   3. drawImage(video)          どの環境でも動く。実測では最も速かった
//
// どれが速く、どれが正しい向きで返るかは端末によって変わるため、起動時に一度測って決める。

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

/** 使える取り出し方を調べる。 */
export function detectSilentPaths() {
  return {
    grabFrame: typeof ImageCapture !== 'undefined'
      && typeof ImageCapture.prototype.grabFrame === 'function',
    videoFrame: typeof VideoFrame !== 'undefined',
    drawImage: true,
  };
}

/** video 要素と縦横の向きが一致しているか。回転して返る方法を除くために使う。 */
export function matchesOrientation(width, height, videoEl) {
  if (!videoEl?.videoWidth || !videoEl?.videoHeight) return true;
  const portraitSource = height > width;
  const portraitVideo = videoEl.videoHeight > videoEl.videoWidth;
  if (width === height || videoEl.videoWidth === videoEl.videoHeight) return true;
  return portraitSource === portraitVideo;
}

/** 指定した方法で 1 コマ取り出す。その方法を使えなければ null を返す。 */
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
 * それぞれの方法を実際に試し、正しい向きで返るもののうち最も速いものを選ぶ。
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
 * 1 コマを ImageBitmap として取り出す。
 * 向きが video 要素と食い違う方法は使わない。
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
        // 回転して返る方法（実測では VideoFrame）は使わない
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
 * 通常撮影で使う。display-p3 を使える場合は、その色域のまま受け取る。
 * 合成を挟まないため、ブラウザ側の色変換をそのまま活かせる。
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
