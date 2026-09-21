// 連写まわり。
//
// 方針: フレームを溜め込まない。4K の ImageBitmap は 1 枚で 8MP（RGBA なら 33MB）を確保するため、
// 実機では 12 枚の撮影に 3.8 秒かかっていた。撮影に時間がかかるほど手ぶれが累積し、
// 位置合わせで弾かれる枚数も増える。
// そこで ImageBitmap を作らず、video 要素をそのまま GPU / canvas へ渡し、逐次累積する。

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
 * これから来る count 枚を順に処理する。
 * onFrame には video 要素をそのまま渡す（コピーを作らない）。
 * onFrame は次のフレームが来る前に処理し終える必要があるため、重い処理は避けること。
 */
export async function collectFrames(videoEl, count, onFrame, { timeoutMs = 15000 } = {}) {
  let received = 0;
  let busy = false;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const stop = onEachFrame(videoEl, async (now, metadata) => {
      if (busy) return; // 処理中に来たフレームは捨てる（溜めると破綻する）
      if (performance.now() - started > timeoutMs) {
        stop();
        if (received > 0) resolve(received);
        else reject(new Error('連写がタイムアウトしました'));
        return;
      }
      busy = true;
      try {
        received += 1;
        await onFrame(videoEl, received, metadata);
      } catch (err) {
        stop();
        reject(err);
        return;
      } finally {
        busy = false;
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
