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
 * サイズは既定では要求しない。実機で測ったところ、
 *   - 映像の ×1.5 や ×2 を要求しても、映像と同じ大きさに丸められる
 *   - 能力値の最大（4032×3024。映像と縦横比が違う）を要求したときだけ
 *     `IPC Connection closed` でキャプチャ接続が落ちる
 * となり、要求して得られるものが無かった。
 * size は診断ページの上限探索でだけ使う。
 *
 * @returns {Promise<{blob: Blob, width:number, height:number, requested:object}>}
 */
export async function takePhotoBlob(track, { size = null } = {}) {
  if (!isPhotoModeAvailable()) throw new Error('この端末は高画質モードに対応していません');
  const ic = new ImageCapture(track);

  const settings = {};
  if (size) {
    settings.imageWidth = size.width;
    settings.imageHeight = size.height;
  }

  const blob = Object.keys(settings).length > 0
    ? await ic.takePhoto(settings)
    : await ic.takePhoto();

  const bitmap = await createImageBitmap(blob);
  const actual = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  return { blob, ...actual, requested: settings };
}
