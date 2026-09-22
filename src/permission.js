// カメラの許可が残っているかを、許可を求める表示を出さずに判定する。
//
// ホーム画面から起動したページは、そのたびに新しい文書として読み込まれる。
// 前回の許可が残っていれば、操作を待たずにカメラを開いてよい。
//
// 判定の材料は 2 つ。どちらも getUserMedia を呼ばないため、許可を求める表示は出ない。
//   1. Permissions API。Safari は name: 'camera' に対応しておらず、例外を投げることがある
//   2. enumerateDevices() が返すカメラ名。仕様上、許可されていない間は空文字になる

/** Permissions API による判定。使えなければ null。 */
export async function queryCameraPermission() {
  if (!navigator.permissions?.query) return null;
  try {
    const status = await navigator.permissions.query({ name: 'camera' });
    return status?.state ?? null; // 'granted' | 'prompt' | 'denied'
  } catch {
    return null; // Safari では TypeError になることがある
  }
}

/** カメラ名（ラベル）が読めるか。読めれば過去に許可されている。 */
export async function hasDeviceLabels() {
  if (!navigator.mediaDevices?.enumerateDevices) return false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => d.kind === 'videoinput' && !!d.label);
  } catch {
    return false;
  }
}

/**
 * 許可が残っているかどうかを調べる。
 * @returns {Promise<{granted:boolean, permissionState:string|null, labels:boolean,
 *   videoInputs:number, reason:string}>}
 */
export async function inspectCameraPermission() {
  const [permissionState, labels] = await Promise.all([
    queryCameraPermission(),
    hasDeviceLabels(),
  ]);

  let videoInputs = 0;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoInputs = devices.filter((d) => d.kind === 'videoinput').length;
  } catch { /* 数が取れなくても判定はできる */ }

  const granted = permissionState === 'granted' || labels;
  return {
    granted,
    permissionState,
    labels,
    videoInputs,
    reason: permissionState === 'granted' ? 'permissions-api'
      : labels ? 'device-labels'
        : permissionState === 'denied' ? 'denied'
          : 'unknown',
  };
}
