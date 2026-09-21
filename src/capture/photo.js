// 高画質モード（ImageCapture.takePhoto）。
//
// 重要: この経路は WebKit 内部で AVCapturePhotoOutput.capturePhotoWithSettings を呼ぶ。
// 日本・韓国版の端末はシステム側でシャッター音抑止が許可されていない
// （AVCapturePhotoOutput.isShutterSoundSuppressionSupported が false）ため、
// 撮影時に音が鳴る可能性が高い。既定では使わず、ユーザーが明示的に選んだときだけ使う。

/** トラックが生きているか（IPC 切断後は ended になる）。 */
export function isTrackAlive(track) {
  return !!track && track.readyState === 'live';
}

export function isPhotoModeAvailable() {
  return typeof ImageCapture !== 'undefined'
    && typeof ImageCapture.prototype.takePhoto === 'function';
}

/** 写真パイプラインの能力を取得する（対応していなければ null）。 */
export async function getPhotoCapabilities(track) {
  if (!isPhotoModeAvailable()) return null;
  try {
    const ic = new ImageCapture(track);
    return await ic.getPhotoCapabilities();
  } catch {
    return null;
  }
}

/**
 * 写真パイプラインで 1 枚撮る。
 *
 * maxSize を true にすると能力値の最大（実機では 4032×3024）を要求するが、
 * 映像セッションが小さいときにこれを要求すると WebKit のキャプチャ側が
 * `IPC Connection closed` で落ちることがある。そのため既定は要求しない。
 *
 * @returns {Promise<{blob: Blob, width:number, height:number, requested:object}>}
 */
export async function takePhotoBlob(track, { maxSize = false, size = null } = {}) {
  if (!isPhotoModeAvailable()) throw new Error('この端末は高画質モードに対応していません');
  const ic = new ImageCapture(track);

  const settings = {};
  if (size) {
    settings.imageWidth = size.width;
    settings.imageHeight = size.height;
  } else if (maxSize) {
    try {
      const caps = await ic.getPhotoCapabilities();
      if (caps?.imageWidth?.max) settings.imageWidth = caps.imageWidth.max;
      if (caps?.imageHeight?.max) settings.imageHeight = caps.imageHeight.max;
    } catch {
      // 能力が取れない端末ではそのまま既定値で撮る
    }
  }

  const blob = Object.keys(settings).length > 0
    ? await ic.takePhoto(settings)
    : await ic.takePhoto();

  const bitmap = await createImageBitmap(blob);
  const actual = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  return { blob, ...actual, requested: settings };
}
