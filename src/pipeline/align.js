// サブピクセル位置合わせ。
//
// 手持ち撮影の微小な揺れは「ほぼ平行移動」なので、回転は無視して並進のみを推定する。
// 縮小した輝度画像でピラミッド探索し、最後に放物線フィットで小数画素まで求める。
// 全て純関数なので Node 上で単体テストできる。

/** RGBA の ImageData から輝度の Float32Array を作る。 */
export function toLuma(imageData) {
  const { data, width, height } = imageData;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p += 1) {
    out[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return { data: out, width, height };
}

/** 2x2 平均で半分に縮小する。 */
export function downsample2(plane) {
  const { data, width, height } = plane;
  const w = width >> 1;
  const h = height >> 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * 2) * width + x * 2;
      out[y * w + x] = (data[i] + data[i + 1] + data[i + width] + data[i + width + 1]) * 0.25;
    }
  }
  return { data: out, width: w, height: h };
}

/** 縮小ピラミッドを作る（levels 段。0 が原寸）。 */
export function buildPyramid(plane, levels = 3) {
  const pyramid = [plane];
  for (let i = 1; i < levels; i += 1) {
    const prev = pyramid[i - 1];
    if (prev.width < 32 || prev.height < 32) break;
    pyramid.push(downsample2(prev));
  }
  return pyramid;
}

/** (dx, dy) だけずらしたときの SAD（小さいほど一致）。端は評価から外す。 */
export function sad(ref, cur, dx, dy, margin) {
  const { width, height } = ref;
  const a = ref.data;
  const b = cur.data;
  let sum = 0;
  let count = 0;
  const x0 = Math.max(margin, -dx + margin);
  const x1 = Math.min(width - margin, width - dx - margin);
  const y0 = Math.max(margin, -dy + margin);
  const y1 = Math.min(height - margin, height - dy - margin);
  for (let y = y0; y < y1; y += 1) {
    const rowA = y * width;
    const rowB = (y + dy) * width + dx;
    for (let x = x0; x < x1; x += 1) {
      sum += Math.abs(a[rowA + x] - b[rowB + x]);
      count += 1;
    }
  }
  if (count === 0) return Number.POSITIVE_INFINITY;
  return sum / count;
}

/** 3点の放物線フィットで極小位置のオフセット（-0.5〜0.5 程度）を返す。 */
export function parabolicOffset(left, center, right) {
  const denom = left - 2 * center + right;
  if (Math.abs(denom) < 1e-9) return 0;
  const delta = (0.5 * (left - right)) / denom;
  if (!Number.isFinite(delta)) return 0;
  return Math.max(-1, Math.min(1, delta));
}

/**
 * 整数シフトを全探索し、周囲の SAD から小数画素を求める。
 * @returns {{dx:number, dy:number, score:number}}
 */
export function estimateShiftAtLevel(ref, cur, { search = 4, guessX = 0, guessY = 0, margin = 4 } = {}) {
  let best = { dx: guessX, dy: guessY, score: Number.POSITIVE_INFINITY };
  for (let dy = guessY - search; dy <= guessY + search; dy += 1) {
    for (let dx = guessX - search; dx <= guessX + search; dx += 1) {
      const score = sad(ref, cur, dx, dy, margin);
      if (score < best.score) best = { dx, dy, score };
    }
  }
  const cx = best.score;
  const left = sad(ref, cur, best.dx - 1, best.dy, margin);
  const right = sad(ref, cur, best.dx + 1, best.dy, margin);
  const up = sad(ref, cur, best.dx, best.dy - 1, margin);
  const down = sad(ref, cur, best.dx, best.dy + 1, margin);
  const subX = Number.isFinite(left) && Number.isFinite(right) ? parabolicOffset(left, cx, right) : 0;
  const subY = Number.isFinite(up) && Number.isFinite(down) ? parabolicOffset(up, cx, down) : 0;
  return { dx: best.dx + subX, dy: best.dy + subY, score: best.score };
}

/**
 * ピラミッドを粗→密にたどって並進を推定する。
 * 返す dx, dy は「cur を ref に重ねるために cur をサンプルする位置のずれ」（原寸の画素単位）。
 */
export function estimateShift(refPyramid, curPyramid, { coarseSearch = 6, fineSearch = 1 } = {}) {
  const levels = Math.min(refPyramid.length, curPyramid.length);
  let dx = 0;
  let dy = 0;
  let score = Number.POSITIVE_INFINITY;
  for (let level = levels - 1; level >= 0; level -= 1) {
    const ref = refPyramid[level];
    const cur = curPyramid[level];
    const isCoarsest = level === levels - 1;
    const guessX = Math.round(dx);
    const guessY = Math.round(dy);
    const result = estimateShiftAtLevel(ref, cur, {
      search: isCoarsest ? coarseSearch : fineSearch,
      guessX,
      guessY,
      margin: 4,
    });
    dx = result.dx;
    dy = result.dy;
    score = result.score;
    if (level > 0) {
      dx *= 2;
      dy *= 2;
    }
  }
  return { dx, dy, score };
}

/**
 * 位置合わせの品質判定。ずれが大きすぎる／一致度が悪いフレームは捨てる。
 */
export function isUsableShift({ dx, dy, score }, { maxShift = 48, maxScore = 24 } = {}) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  if (Math.hypot(dx, dy) > maxShift) return false;
  if (score > maxScore) return false;
  return true;
}
