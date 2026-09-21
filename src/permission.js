// カメラ許可の状態を、プロンプトを出さずに推定する。
//
// iOS のホーム画面 Web アプリは起動のたびに新しい文書になるため、前回の許可が
// 残っているかどうかで体験が大きく変わる。残っているなら開始ボタンを待たずに
// カメラを開いてよい（タップも不要になる）。
//
// 判定材料は 2 つ。どちらも getUserMedia を呼ばないので、プロンプトは出ない。
//   1. Permissions API … Safari は camera を知らず例外を投げることがあるので try/catch
//   2. enumerateDevices() のラベル … 仕様上、許可されていない間は空文字

/** Permissions API による判定。使えなければ null。 */
export async function queryCameraPermission() {
  if (!navigator.permissions?.query) return null;
  try {
    const status = await navigator.permissions.query({ name: 'camera' });
    return status?.state ?? null; // 'granted' | 'prompt' | 'denied'
  } catch {
    return null; // Safari は name: 'camera' を知らず TypeError を投げる
  }
}

/** デバイスのラベルが見えているか（= 過去に許可されている）。 */
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
 * 許可が残っていそうかを調べる。
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
