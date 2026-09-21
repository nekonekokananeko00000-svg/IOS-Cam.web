// 合成の中核（CPU 版）。DOM に触れない純関数なので単体テストできる。
// GPU 版（merge.js のシェーダ）と同じ式を実装しており、
// diag.html の自己テストで両者の一致を確認できる。

const GAMMA = 2.2;

/** sRGB(0-255) → リニア(0-1) */
export function toLinear(v) {
  return (v / 255) ** GAMMA;
}

/** リニア(0-1) → sRGB(0-255) */
export function toSrgb(v) {
  return Math.max(0, Math.min(255, (Math.max(v, 0) ** (1 / GAMMA)) * 255));
}

/** RGBA バッファから双線形補間で 1 画素取り出す（範囲外は端に張り付く）。 */
export function bilinearSample(px, width, height, x, y, out) {
  const cx = Math.max(0, Math.min(width - 1, x));
  const cy = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  for (let c = 0; c < 3; c += 1) {
    const top = px[i00 + c] * (1 - fx) + px[i10 + c] * fx;
    const bottom = px[i01 + c] * (1 - fx) + px[i11 + c] * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

/**
 * 1 フレームを累積バッファへ足す。
 * dx, dy は「参照に重ねるためにソースをサンプルする位置のずれ」（画素単位）。
 * 基準フレームから離れた画素は重みを落とす（動体のゴースト対策）。
 */
export function accumulateFrame({
  px, ref, width, height, sum, weights,
  dx = 0, dy = 0, weight = 1, noise = 0.14, isReference = false,
}) {
  const noiseSq = Math.max(noise * noise, 1e-5) * 255 * 255;
  const rgb = [0, 0, 0];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = x + dx;
      const sy = y + dy;
      if (sx < -0.5 || sy < -0.5 || sx > width - 0.5 || sy > height - 0.5) continue;
      bilinearSample(px, width, height, sx, sy, rgb);
      const o = y * width + x;
      let w = weight;
      if (!isReference && ref) {
        let dist = 0;
        for (let c = 0; c < 3; c += 1) {
          const d = rgb[c] - ref[o * 4 + c];
          dist += d * d;
        }
        w *= Math.exp(-dist / noiseSq);
      }
      if (w <= 0) continue;
      for (let c = 0; c < 3; c += 1) sum[o * 3 + c] += toLinear(rgb[c]) * w;
      weights[o] += w;
    }
  }
}

/** 累積を正規化し、任意でアンシャープを掛けて RGBA バイト列にする。 */
export function normalize({ sum, weights, width, height, sharpen = 0 }) {
  const norm = new Float32Array(width * height * 3);
  for (let o = 0; o < width * height; o += 1) {
    const w = Math.max(weights[o], 1e-4);
    for (let c = 0; c < 3; c += 1) norm[o * 3 + c] = sum[o * 3 + c] / w;
  }

  const at = (x, y, c) => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    return norm[(cy * width + cx) * 3 + c];
  };

  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = y * width + x;
      for (let c = 0; c < 3; c += 1) {
        let v = norm[o * 3 + c];
        if (sharpen > 0) {
          const blur = (at(x, y, c) * 4
            + (at(x + 1, y, c) + at(x - 1, y, c) + at(x, y + 1, c) + at(x, y - 1, c)) * 2
            + at(x + 1, y + 1, c) + at(x - 1, y + 1, c)
            + at(x + 1, y - 1, c) + at(x - 1, y - 1, c)) / 16;
          v += (v - blur) * sharpen;
        }
        out[o * 4 + c] = toSrgb(v);
      }
      out[o * 4 + 3] = 255;
    }
  }
  return out;
}

/** 累積バッファ一式を作る。 */
export function createAccumulator(width, height) {
  return {
    width,
    height,
    sum: new Float32Array(width * height * 3),
    weights: new Float32Array(width * height),
  };
}
