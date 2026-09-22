// 写真API（ImageCapture.takePhoto）による撮影。
//
// WebKit はこの API を AVCapturePhotoOutput で実装している。日本国内向けの端末では、
// システム側でシャッター音を消すことが許可されていないため、本来は音が鳴る経路である。
// ただし iPhone 1 台（iOS 18.7 / Safari 26.6.1）で試した範囲では、どの解像度でも鳴らなかった。
// WebKit 側に音を止める処理は無く、この経路が音の対象から外れているだけなので、
// 端末や iOS の版によっては鳴る可能性がある。
//
// 解像度は映像と同じで、画素数は増えない。1 枚あたり 0.3 秒から 1.4 秒かかる。
// 以上から、既定の撮影方法にはせず、利用者が選んだときだけ使う。

/** カメラとの接続が生きているか。接続が切れると ended になる。 */
export function isTrackAlive(track) {
  return !!track && track.readyState === 'live';
}

export function isPhotoModeAvailable() {
  return typeof ImageCapture !== 'undefined'
    && typeof ImageCapture.prototype.takePhoto === 'function';
}

/** 写真API で撮れる大きさなどを取得する。対応していなければ null を返す。 */
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
 * 写真API で 1 枚撮る。
 *
 * サイズは既定では要求しない。実機で測ったところ、
 *   - 映像の ×1.5 や ×2 を要求しても、映像と同じ大きさに丸められる
 *   - 端末の上限（4032×3024。映像と縦横比が違う）を指定したときだけ
 *     `IPC Connection closed` でカメラとの接続が切れる
 * となり、要求して得られるものが無かった。
 * size は端末チェックで上限を調べるときだけ使う。
 *
 * @returns {Promise<{blob: Blob, width:number, height:number, requested:object}>}
 */
export async function takePhotoBlob(track, { size = null } = {}) {
  if (!isPhotoModeAvailable()) throw new Error('この端末のブラウザは写真API に対応していません');
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
