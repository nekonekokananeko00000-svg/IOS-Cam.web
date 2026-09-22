// 位置合わせの単体テスト。自分で作った画像を使い、与えたずれを正しく求められるか確かめる。
import assert from 'node:assert/strict';
import {
  toLuma, buildPyramid, estimateShift, parabolicOffset, isUsableShift,
} from '../src/pipeline/align.js';

/** 繰り返しのない滑らかな模様。粗い乱数を双線形補間で引き伸ばして作る。 */
function makeScene(width, height, seed = 1) {
  const gridW = 17;
  const gridH = 17;
  const grid = new Float32Array(gridW * gridH);
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < grid.length; i += 1) grid[i] = rand();
  return (x, y) => {
    const gx = ((x / width) * (gridW - 1) + gridW) % (gridW - 1);
    const gy = ((y / height) * (gridH - 1) + gridH) % (gridH - 1);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const at = (ix, iy) => grid[Math.min(gridH - 1, iy) * gridW + Math.min(gridW - 1, ix)];
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return (top * (1 - fy) + bottom * fy) * 200 + 28;
  };
}

function render(width, height, shiftX, shiftY, seed = 1) {
  const scene = makeScene(width, height, seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = scene(x + shiftX, y + shiftY);
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

function shiftOf(refShiftX, refShiftY, curShiftX, curShiftY, size = 192) {
  const ref = buildPyramid(toLuma(render(size, size, refShiftX, refShiftY)), 3);
  const cur = buildPyramid(toLuma(render(size, size, curShiftX, curShiftY)), 3);
  return estimateShift(ref, cur);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('整数のずれを符号も含めて求められる', () => {
  // cur は ref より (+3, -2) だけずれている。取り出す位置の補正は (-3, +2) になる
  const { dx, dy } = shiftOf(0, 0, 3, -2);
  assert.ok(Math.abs(dx + 3) < 0.35, `dx=${dx}`);
  assert.ok(Math.abs(dy - 2) < 0.35, `dy=${dy}`);
});

test('画素より細かいずれを 0.3 画素以内で求められる', () => {
  const { dx, dy } = shiftOf(0, 0, 1.5, 0.5);
  assert.ok(Math.abs(dx + 1.5) < 0.3, `dx=${dx}`);
  assert.ok(Math.abs(dy + 0.5) < 0.3, `dy=${dy}`);
});

test('ずれが無ければ 0 に近い値を返す', () => {
  const { dx, dy } = shiftOf(0, 0, 0, 0);
  assert.ok(Math.hypot(dx, dy) < 0.2, `dx=${dx} dy=${dy}`);
});

test('大きなずれも粗い探索で追える', () => {
  const { dx, dy } = shiftOf(0, 0, 12, 9);
  assert.ok(Math.abs(dx + 12) < 0.6, `dx=${dx}`);
  assert.ok(Math.abs(dy + 9) < 0.6, `dy=${dy}`);
});

test('放物線の当てはめは、中央が最小なら 0 を返す', () => {
  assert.equal(parabolicOffset(10, 5, 10), 0);
  assert.ok(parabolicOffset(5, 4, 10) < 0);
  assert.ok(parabolicOffset(10, 4, 5) > 0);
});

test('大きく外れたずれは採用しない', () => {
  assert.equal(isUsableShift({ dx: 200, dy: 0, score: 1 }), false);
  assert.equal(isUsableShift({ dx: 1, dy: 1, score: 999 }), false);
  assert.equal(isUsableShift({ dx: 1, dy: 1, score: 3 }), true);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
