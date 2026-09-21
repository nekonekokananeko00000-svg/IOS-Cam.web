// カメラの起動と能力探索。
// iOS Safari は要求した解像度に最も近い「プリセット」へ勝手に落とすため、
// 要求値ではなく track.getSettings() の実測値を常に信用する。

/** 高い順に試す解像度候補。 */
export const RESOLUTION_LADDER = [
  { width: 3840, height: 2160 },
  { width: 1920, height: 1440 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 640, height: 480 },
];

/**
 * 映像トラックを1本開く。既存ストリームは呼び出し側で必ず止めてから呼ぶこと
 * （iOS では2本目の getUserMedia が1本目の映像を殺す）。
 */
export async function openStream({
  facingMode = 'environment',
  width,
  height,
  powerEfficient = false,
} = {}) {
  const video = {
    facingMode: { ideal: facingMode },
  };
  if (width && height) {
    video.width = { ideal: width };
    video.height = { ideal: height };
  }
  // WebKit 独自。省電力のための binned プリセット選択を抑止できる場合がある。
  // 未知の制約は仕様上無視されるだけなので、そのまま渡して構わない。
  if (powerEfficient === false) video.powerEfficientPixelFormat = false;

  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  return stream;
}

/** ストリームを完全に停止する。 */
export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/** トラックの実測設定と能力をまとめて取り出す。 */
export function inspectTrack(track) {
  const settings = track.getSettings ? track.getSettings() : {};
  let capabilities = {};
  try {
    capabilities = track.getCapabilities ? track.getCapabilities() : {};
  } catch {
    // 一部の iOS バージョンは getCapabilities で投げる
  }
  return {
    label: track.label,
    width: settings.width ?? 0,
    height: settings.height ?? 0,
    frameRate: settings.frameRate ?? 0,
    facingMode: settings.facingMode ?? '',
    settings,
    capabilities,
  };
}

/**
 * 解像度ラダーを順に試し、最初に成功したストリームを返す。
 * 戻り値の actual は getSettings() による実測値。
 */
export async function openBestStream({ facingMode = 'environment', maxPixels = Infinity } = {}) {
  let lastError = null;
  for (const res of RESOLUTION_LADDER) {
    if (res.width * res.height > maxPixels) continue;
    try {
      const stream = await openStream({ facingMode, ...res });
      const track = stream.getVideoTracks()[0];
      const info = inspectTrack(track);
      return { stream, track, requested: res, actual: info };
    } catch (err) {
      lastError = err;
    }
  }
  // ラダーが全滅したら制約なしで最後の望みを賭ける
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facingMode } },
    audio: false,
  }).catch((err) => {
    throw lastError ?? err;
  });
  const track = stream.getVideoTracks()[0];
  return { stream, track, requested: null, actual: inspectTrack(track) };
}

/** capabilities にある場合だけ制約を適用する（無い端末で投げさせない）。 */
export async function applyIfSupported(track, constraints) {
  let caps = {};
  try {
    caps = track.getCapabilities ? track.getCapabilities() : {};
  } catch {
    return { applied: false, reason: 'no-capabilities' };
  }
  const advanced = {};
  for (const [key, value] of Object.entries(constraints)) {
    if (!(key in caps)) continue;
    const cap = caps[key];
    if (Array.isArray(cap) && !cap.includes(value)) continue;
    if (cap && typeof cap === 'object' && 'min' in cap && 'max' in cap) {
      if (value < cap.min || value > cap.max) continue;
    }
    advanced[key] = value;
  }
  if (Object.keys(advanced).length === 0) return { applied: false, reason: 'unsupported' };
  try {
    await track.applyConstraints({ advanced: [advanced] });
    return { applied: true, constraints: advanced };
  } catch (err) {
    return { applied: false, reason: String(err) };
  }
}

/** video 要素にストリームを載せて、最初のフレームが来るまで待つ。 */
export function attachToVideo(videoEl, stream) {
  return new Promise((resolve, reject) => {
    videoEl.srcObject = stream;
    videoEl.playsInline = true;
    videoEl.muted = true;
    const done = () => {
      videoEl.removeEventListener('loadedmetadata', done);
      videoEl.play().then(() => resolve(videoEl)).catch(reject);
    };
    if (videoEl.readyState >= 1) done();
    else videoEl.addEventListener('loadedmetadata', done);
  });
}
