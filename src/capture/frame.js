// 無音のフレーム取得。いずれの経路も映像ストリームのコピーであり、
// 写真撮影 API（AVCapturePhotoOutput）を経由しないのでシャッター音は鳴らない。
//
// 優先順位:
//   1. ImageCapture.grabFrame()  … Safari 26+。トラック解像度そのままで受け取れる
//   2. new VideoFrame(video)     … WebCodecs（Safari 16.4+）。中間コピーが少ない
//   3. drawImage(video)          … どこでも動く最終手段

let cachedImageCapture = null;
let cachedTrack = null;

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

/**
 * 1フレームを ImageBitmap として取り出す（無音）。
 * @returns {Promise<{bitmap: ImageBitmap, width: number, height: number, path: string}>}
 */
export async function grabSilentFrame(videoEl, track, { prefer = 'auto' } = {}) {
  const paths = detectSilentPaths();
  const order = prefer === 'auto'
    ? ['grabFrame', 'videoFrame', 'drawImage']
    : [prefer, 'grabFrame', 'videoFrame', 'drawImage'];

  let lastError = null;
  for (const path of order) {
    if (!paths[path]) continue;
    try {
      if (path === 'grabFrame') {
        const ic = getImageCapture(track);
        if (!ic) continue;
        const bitmap = await ic.grabFrame();
        return { bitmap, width: bitmap.width, height: bitmap.height, path };
      }
      if (path === 'videoFrame') {
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
