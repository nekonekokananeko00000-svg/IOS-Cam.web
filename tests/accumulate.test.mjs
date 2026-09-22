// 合成の計算（accumulate.js）の単体テスト。
// ノイズが 1/√N に減ること、ずれたコマが正しく重なること、
// 動いたものが混ざらないことを確かめる。
import assert from 'node:assert/strict';
import {
  createAccumulator, accumulateFrame, normalize, toLinear, toSrgb, bilinearSample,
} from '../src/pipeline/accumulate.js';

const W = 48;
const H = 48;

function makeFrame(fn) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const v = fn(x, y);
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
    }
  }
  return px;
}

function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 正規分布に近い乱数。一様乱数を足し合わせて作る。 */
function gauss(rand) {
  return (rand() + rand() + rand() + rand() + rand() + rand() - 3) * 1.4;
}

function stdevAgainst(bytes, truth) {
  let sum = 0;
  let n = 0;
  for (let o = 0; o < W * H; o += 1) {
    const d = bytes[o * 4] - truth[o * 4];
    sum += d * d;
    n += 1;
  }
  return Math.sqrt(sum / n);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('明るさの変換は往復しても元に戻る', () => {
  for (const v of [0, 17, 128, 200, 255]) {
    assert.ok(Math.abs(toSrgb(toLinear(v)) - v) < 0.6, `v=${v}`);
  }
});

test('双線形補間は、格子の上では元の値を返す', () => {
  const px = makeFrame((x) => x * 4);
  const out = [0, 0, 0];
  bilinearSample(px, W, H, 5, 5, out);
  assert.ok(Math.abs(out[0] - 20) < 0.001, `got ${out[0]}`);
  bilinearSample(px, W, H, 5.5, 5, out);
  assert.ok(Math.abs(out[0] - 22) < 0.001, `got ${out[0]}`);
});

test('枚数を重ねるとノイズが 1/√N ほどに減る', () => {
  const truthFn = (x, y) => 100 + ((x + y) % 16) * 6;
  const truth = makeFrame(truthFn);
  const rand = rng(7);

  const measure = (frames) => {
    const acc = createAccumulator(W, H);
    let ref = null;
    for (let i = 0; i < frames; i += 1) {
      const px = makeFrame((x, y) => truthFn(x, y) + gauss(rand) * 12);
      if (!ref) ref = px;
      accumulateFrame({
        px, ref, width: W, height: H, sum: acc.sum, weights: acc.weights,
        // ノイズで弾かれないよう寛容にする（ノイズ低減そのものを測りたい）
        noise: 1.5, isReference: i === 0,
      });
    }
    return stdevAgainst(normalize({ ...acc, width: W, height: H, sharpen: 0 }), truth);
  };

  const one = measure(1);
  const sixteen = measure(16);
  assert.ok(sixteen < one * 0.5, `1枚=${one.toFixed(2)} 16枚=${sixteen.toFixed(2)}`);
});

test('ずれたコマを、指定したずれの分だけ動かして重ねられる', () => {
  const truthFn = (x, y) => 40 + ((x * 3 + y * 2) % 200);
  const truth = makeFrame(truthFn);
  const acc = createAccumulator(W, H);
  const ref = makeFrame(truthFn);
  accumulateFrame({
    px: ref, ref, width: W, height: H, sum: acc.sum, weights: acc.weights, isReference: true,
  });
  // 内容が (+2, +1) ずれたフレーム → (-2, -1) でサンプルすれば重なる
  const shifted = makeFrame((x, y) => truthFn(x - 2, y - 1));
  accumulateFrame({
    px: shifted, ref, width: W, height: H, sum: acc.sum, weights: acc.weights,
    dx: 2, dy: 1, noise: 1.5,
  });
  const out = normalize({ ...acc, width: W, height: H, sharpen: 0 });
  // 端はサンプル範囲外になるので内側だけ比較する
  let worst = 0;
  for (let y = 4; y < H - 4; y += 1) {
    for (let x = 4; x < W - 4; x += 1) {
      worst = Math.max(worst, Math.abs(out[(y * W + x) * 4] - truth[(y * W + x) * 4]));
    }
  }
  assert.ok(worst < 2, `最大差 ${worst}`);
});

test('基準から大きく外れた画素は重みが下がる', () => {
  const truthFn = () => 120;
  const ref = makeFrame(truthFn);
  const acc = createAccumulator(W, H);
  accumulateFrame({
    px: ref, ref, width: W, height: H, sum: acc.sum, weights: acc.weights, isReference: true,
  });
  // 右半分だけ大きく違うフレームを足す
  const intruder = makeFrame((x) => (x > W / 2 ? 240 : 120));
  accumulateFrame({
    px: intruder, ref, width: W, height: H, sum: acc.sum, weights: acc.weights, noise: 0.14,
  });
  const out = normalize({ ...acc, width: W, height: H, sharpen: 0 });
  const left = out[(24 * W + 8) * 4];
  const right = out[(24 * W + 40) * 4];
  assert.ok(Math.abs(left - 120) < 2, `左 ${left}`);
  // 単純平均なら 180 付近になるが、ロバスト重みで 120 側に寄るはず
  assert.ok(right < 150, `右 ${right}（ゴーストが残っている）`);
});

test('輪郭の強調で境目の差が大きくなる', () => {
  const edge = makeFrame((x) => (x < W / 2 ? 80 : 160));
  const acc = createAccumulator(W, H);
  accumulateFrame({
    px: edge, ref: edge, width: W, height: H, sum: acc.sum, weights: acc.weights, isReference: true,
  });
  const plain = normalize({ ...acc, width: W, height: H, sharpen: 0 });
  const sharp = normalize({ ...acc, width: W, height: H, sharpen: 0.8 });
  const idx = (x) => (24 * W + x) * 4;
  const plainGap = plain[idx(W / 2)] - plain[idx(W / 2 - 1)];
  const sharpGap = sharp[idx(W / 2)] - sharp[idx(W / 2 - 1)];
  assert.ok(sharpGap > plainGap, `plain=${plainGap} sharp=${sharpGap}`);
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
