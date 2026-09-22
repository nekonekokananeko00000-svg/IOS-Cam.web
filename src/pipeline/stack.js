// 合成撮影の司令塔。
//   1. 連写で来たフレームを 1 枚ずつ受け取る
//   2. 縮小画像のピラミッドで粗くずれを求め、原寸の中央クロップで詰める
//   3. その場で GPU（無ければ CPU）の累積バッファへ足す
// フレームを溜め込まないので、枚数を増やしてもメモリは増えない。

import { collectFrames, sharpnessScore } from '../capture/burst.js';
import {
  toLuma, buildPyramid, estimateShift, estimateShiftAtLevel, isUsableShift,
} from './align.js';
import { GpuStacker, isGpuStackSupported, MAX_OUTPUT_PIXELS } from './merge.js';
import { CpuStacker } from './cpu-merge.js';

const ALIGN_WIDTH = 480;   // ピラミッド探索に使う縮小幅
const REFINE_SIZE = 256;   // 原寸で詰めるときの中央クロップ

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
}

/** 縮小した輝度ピラミッドと、原寸中央クロップの輝度を作る。source は video 要素でよい。 */
function makeAlignmentViews(source, small, crop, srcWidth, srcHeight) {
  small.ctx.drawImage(source, 0, 0, small.canvas.width, small.canvas.height);
  const smallImage = small.ctx.getImageData(0, 0, small.canvas.width, small.canvas.height);

  const size = crop.canvas.width;
  const sx = Math.max(0, Math.floor((srcWidth - size) / 2));
  const sy = Math.max(0, Math.floor((srcHeight - size) / 2));
  crop.ctx.drawImage(source, sx, sy, size, size, 0, 0, size, size);
  const cropImage = crop.ctx.getImageData(0, 0, size, size);

  return {
    pyramid: buildPyramid(toLuma(smallImage), 3),
    crop: toLuma(cropImage),
    sharpness: sharpnessScore(smallImage),
  };
}

export function createStacker() {
  if (isGpuStackSupported()) {
    try {
      return { stacker: new GpuStacker(), kind: 'webgl2' };
    } catch {
      // 生成に失敗したら CPU へ
    }
  }
  return { stacker: new CpuStacker(), kind: 'cpu' };
}

/**
 * 連写 → 位置合わせ → 合成。
 * @returns {Promise<{canvas: HTMLCanvasElement, used:number, total:number, kind:string,
 *   scale:number, shifts:Array, width:number, height:number}>}
 */
export async function captureStack(videoEl, track, {
  frames = 12,
  scale = 1,
  sharpen = 0.35,
  noise = 0.14,
  onProgress = () => {},
} = {}) {
  const settings = track.getSettings ? track.getSettings() : {};
  const srcWidth = settings.width || videoEl.videoWidth;
  const srcHeight = settings.height || videoEl.videoHeight;
  if (!srcWidth || !srcHeight) throw new Error('映像のサイズが取れません');

  const { stacker, kind } = createStacker();
  // 4K の映像を 2 倍の格子に重ねると 3300 万画素になり、計算用の領域だけで 1GB を超える。
  // 端末が確保できる大きさに収まるまで倍率を下げる。いまのところ倍率は 1 か 2 しか渡らないので、
  // この繰り返しは 2 から 1 へ落とすためにだけ動く。
  let effectiveScale = kind === 'cpu' ? 1 : scale;
  let scaleReduced = false;
  while (effectiveScale > 1 && srcWidth * srcHeight * effectiveScale * effectiveScale > MAX_OUTPUT_PIXELS) {
    effectiveScale -= 1;
    scaleReduced = true;
  }

  const alignHeight = Math.max(1, Math.round((ALIGN_WIDTH * srcHeight) / srcWidth));
  const small = makeCanvas(ALIGN_WIDTH, alignHeight);
  const crop = makeCanvas(
    Math.min(REFINE_SIZE, srcWidth),
    Math.min(REFINE_SIZE, srcHeight),
  );
  const alignToSrc = srcWidth / ALIGN_WIDTH;

  stacker.begin(srcWidth, srcHeight, { scale: effectiveScale, noise, bicubic: effectiveScale > 1 });

  let reference = null;
  const shifts = [];
  let used = 0;

  const total = await collectFrames(videoEl, frames, async (source, index) => {
    const views = makeAlignmentViews(source, small, crop, srcWidth, srcHeight);

    if (!reference) {
      reference = views;
      stacker.addFrame(source, { dx: 0, dy: 0, weight: 1, isReference: true });
      used += 1;
      shifts.push({ dx: 0, dy: 0, score: 0 });
      onProgress({ index, used, frames });
      return;
    }

    // 粗い推定（縮小画像）→ 原寸スケールへ
    const coarse = estimateShift(reference.pyramid, views.pyramid);
    let dx = coarse.dx * alignToSrc;
    let dy = coarse.dy * alignToSrc;

    // 原寸の中央クロップで ±1px を詰める
    const refined = estimateShiftAtLevel(reference.crop, views.crop, {
      search: 1,
      guessX: Math.round(dx),
      guessY: Math.round(dy),
      margin: 6,
    });
    if (Number.isFinite(refined.score)) {
      dx = refined.dx;
      dy = refined.dy;
    }

    const shift = { dx, dy, score: coarse.score };
    if (!isUsableShift(shift, { maxShift: Math.max(32, srcWidth * 0.03), maxScore: 28 })) {
      shifts.push({ ...shift, rejected: true });
      onProgress({ index, used, frames });
      return;
    }

    // ブレの大きいフレームは軽く扱う
    const relative = views.sharpness / Math.max(reference.sharpness, 1e-3);
    const weight = Math.max(0.25, Math.min(1, relative));

    stacker.addFrame(source, { dx, dy, weight });
    used += 1;
    shifts.push(shift);
    onProgress({ index, used, frames });
  });

  const canvas = stacker.finish({ sharpen });
  return {
    canvas,
    used,
    total,
    kind,
    scale: effectiveScale,
    scaleReduced,
    requestedScale: scale,
    shifts,
    width: canvas.width,
    height: canvas.height,
    stacker,
  };
}
