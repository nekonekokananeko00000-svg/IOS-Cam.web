// カメラの起動と、使える機能の確認。
// iOS の Safari は、要求した解像度に近い値へ自動的に調整する。
// そのため、要求した値ではなく track.getSettings() が返す値を常に使う。

// 高い順に試す解像度候補。
// iOS は横で要求しても縦（2160×3840 など）で返すことがあるため、
// 要求値ではなく getSettings() の実測値を常に表示・使用する。
export const RESOLUTION_LADDER = [
  { width: 3840, height: 2160 },
  { width: 1920, height: 1440 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 640, height: 480 },
];

/**
 * 映像を 1 本開く。すでに開いているものは、呼び出す前に必ず止めること。
 * iOS では 2 本目を開くと 1 本目の映像が止まる。
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
  // 実機の getCapabilities は `powerEfficient` を返すが、古い WebKit は
  // `powerEfficientPixelFormat` だったため両方渡す（未知の制約は仕様上無視される）。
  if (powerEfficient === false) {
    video.powerEfficient = false;
    video.powerEfficientPixelFormat = false;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  return stream;
}

/** 映像を完全に止める。 */
export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/** いま適用されている設定と、使える機能をまとめて取り出す。 */
export function inspectTrack(track) {
  const settings = track.getSettings ? track.getSettings() : {};
  let capabilities = {};
  try {
    capabilities = track.getCapabilities ? track.getCapabilities() : {};
  } catch {
    // iOS の版によっては getCapabilities が例外を出す
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
 * 解像度の候補を大きい順に試し、最初に成功したものを返す。
 * 戻り値の actual は getSettings() が返した値である。
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
  // どの候補も通らなかった場合は、解像度を指定せずに開く
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facingMode } },
    audio: false,
  }).catch((err) => {
    throw lastError ?? err;
  });
  const track = stream.getVideoTracks()[0];
  return { stream, track, requested: null, actual: inspectTrack(track) };
}

/** その機能に対応している端末でだけ設定を適用する。対応していなければ何もしない。 */
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

/** video 要素に映像をつなぎ、最初のコマが届くまで待つ。 */
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
