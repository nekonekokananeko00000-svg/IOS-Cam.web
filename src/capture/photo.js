// 高画質モード（ImageCapture.takePhoto）。
//
// 重要: この経路は WebKit 内部で AVCapturePhotoOutput.capturePhotoWithSettings を呼ぶ。
// 日本・韓国版の端末はシステム側でシャッター音抑止が許可されていない
// （AVCapturePhotoOutput.isShutterSoundSuppressionSupported が false）ため、
// 撮影時に音が鳴る可能性が高い。既定では使わず、ユーザーが明示的に選んだときだけ使う。

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
 * 写真パイプラインで 1 枚撮る。可能なら最大解像度を要求する。
 * @returns {Promise<{blob: Blob, width:number, height:number, requested:object}>}
 */
export async function takePhotoBlob(track, { maxSize = true } = {}) {
  if (!isPhotoModeAvailable()) throw new Error('この端末は高画質モードに対応していません');
  const ic = new ImageCapture(track);

  const settings = {};
  if (maxSize) {
    try {
      const caps = await ic.getPhotoCapabilities();
      if (caps?.imageWidth?.max) settings.imageWidth = caps.imageWidth.max;
      if (caps?.imageHeight?.max) settings.imageHeight = caps.imageHeight.max;
    } catch {
      // 能力が取れない端末ではそのまま既定値で撮る
    }
  }

  const blob = Object.keys(settings).length > 0
    ? await ic.takePhoto(settings).catch(() => ic.takePhoto())
    : await ic.takePhoto();

  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  return { blob, ...size, requested: settings };
}
