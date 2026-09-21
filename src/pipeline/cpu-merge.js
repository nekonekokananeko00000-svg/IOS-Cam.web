// WebGL2 の浮動小数レンダーターゲットが使えない端末向けのフォールバック。
// GPU 版と同じ API を持つ。計算そのものは accumulate.js（純関数）に置いてある。

import { createAccumulator, accumulateFrame, normalize } from './accumulate.js';

export class CpuStacker {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.scratch = document.createElement('canvas');
    this.scratchCtx = this.scratch.getContext('2d', { willReadFrequently: true });
  }

  begin(srcWidth, srcHeight, { noise = 0.14 } = {}) {
    // CPU 経路では等倍のみ（ドリズルは現実的な速度が出ない）
    this.outWidth = srcWidth;
    this.outHeight = srcHeight;
    this.noise = noise;
    this.frameCount = 0;
    this.canvas.width = srcWidth;
    this.canvas.height = srcHeight;
    this.scratch.width = srcWidth;
    this.scratch.height = srcHeight;
    this.acc = createAccumulator(srcWidth, srcHeight);
    this.reference = null;
  }

  _readPixels(source) {
    this.scratchCtx.clearRect(0, 0, this.outWidth, this.outHeight);
    this.scratchCtx.drawImage(source, 0, 0, this.outWidth, this.outHeight);
    return this.scratchCtx.getImageData(0, 0, this.outWidth, this.outHeight).data;
  }

  addFrame(source, { dx = 0, dy = 0, weight = 1, isReference = false } = {}) {
    const px = this._readPixels(source);
    const first = isReference || this.frameCount === 0;
    if (first) this.reference = px;
    accumulateFrame({
      px,
      ref: this.reference,
      width: this.outWidth,
      height: this.outHeight,
      sum: this.acc.sum,
      weights: this.acc.weights,
      dx,
      dy,
      weight,
      noise: this.noise,
      isReference: first,
    });
    this.frameCount += 1;
  }

  finish({ sharpen = 0.25 } = {}) {
    const bytes = normalize({
      sum: this.acc.sum,
      weights: this.acc.weights,
      width: this.outWidth,
      height: this.outHeight,
      sharpen,
    });
    const image = new ImageData(bytes, this.outWidth, this.outHeight);
    this.ctx.putImageData(image, 0, 0);
    return this.canvas;
  }

  dispose() {
    this.acc = null;
    this.reference = null;
  }
}
