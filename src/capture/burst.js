// 連写まわり。
//
// 方針: 全フレームをメモリに溜めない。1920x1080 の RGBA は 1枚 8MB を超えるので、
// 30枚保持すると iOS Safari では簡単に落ちる。そのため
//   - 直前フレームの保持は「シャッターラグ 0」用の数枚だけ（リングバッファ）
//   - 合成用のフレームは取得しながら逐次 GPU に流し込む（ストリーミング加算）
// という構成にしている。

/** video 要素の新フレームごとにコールバックする（rVFC が無ければ rAF で代用）。 */
export function onEachFrame(videoEl, callback) {
  let stopped = false;
  if (typeof videoEl.requestVideoFrameCallback === 'function') {
    const step = (now, metadata) => {
      if (stopped) return;
      callback(now, metadata);
      if (!stopped) videoEl.requestVideoFrameCallback(step);
    };
    videoEl.requestVideoFrameCallback(step);
    return () => { stopped = true; };
  }
  const step = (now) => {
    if (stopped) return;
    callback(now, null);
    if (!stopped) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return () => { stopped = true; };
}

/**
 * 直近 N フレームを保持するリングバッファ。
 * シャッターを押した「瞬間より前」のフレームも候補にできる。
 */
export class FrameRing {
  constructor(capacity = 6) {
    this.capacity = capacity;
    this.items = [];
  }

  push(bitmap, meta = {}) {
    this.items.push({ bitmap, meta, t: performance.now() });
    while (this.items.length > this.capacity) {
      const old = this.items.shift();
      old.bitmap.close?.();
    }
  }

  toArray() {
    return this.items.slice();
  }

  clear() {
    for (const item of this.items) item.bitmap.close?.();
    this.items = [];
  }
}

/**
 * これから来る count 枚を順に受け取る。
 * onFrame は同期的に処理し終える前提（戻り値が Promise なら待つ）。
 */
export async function collectFrames(videoEl, count, onFrame, { timeoutMs = 8000 } = {}) {
  let received = 0;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const stop = onEachFrame(videoEl, async (now, metadata) => {
      if (performance.now() - started > timeoutMs) {
        stop();
        reject(new Error('連写がタイムアウトしました'));
        return;
      }
      try {
        const bitmap = await createImageBitmap(videoEl);
        received += 1;
        await onFrame(bitmap, received, metadata);
        bitmap.close?.();
      } catch (err) {
        stop();
        reject(err);
        return;
      }
      if (received >= count) {
        stop();
        resolve(received);
      }
    });
  });
}

/** ブレの少なさの指標。ラプラシアン分散が大きいほどシャープ。 */
export function sharpnessScore(imageData) {
  const { data, width, height } = imageData;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  const lum = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      const v = 4 * lum(i)
        - lum(i - 4)
        - lum(i + 4)
        - lum(i - width * 4)
        - lum(i + width * 4);
      sum += v;
      sumSq += v * v;
      n += 1;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}
