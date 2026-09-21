// 書き出しと保存。
// iOS では canvas から写真アプリへ直接保存できないため、共有シート経由が実質唯一の経路。

export function timestampName(extension = 'jpg') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `IOSCam_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${extension}`;
}

/** canvas を Blob にする。Safari が未対応の形式を求めると PNG になる点に注意。 */
export function canvasToBlob(canvas, { type = 'image/jpeg', quality = 0.95 } = {}) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('画像の書き出しに失敗しました'));
    }, type, quality);
  });
}

/** 共有シートに出せるか（ユーザー操作の中から呼ぶこと）。 */
export function canShareFiles(file) {
  return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
}

/**
 * 保存する。共有シートが使えるならそれを開き（→「画像を保存」で写真アプリへ）、
 * 駄目ならダウンロードにフォールバックする。
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function saveImage(blob, filename = timestampName()) {
  const file = new File([blob], filename, { type: blob.type, lastModified: Date.now() });

  if (canShareFiles(file)) {
    try {
      // iOS では title/text を付けると画像ではなくテキスト共有になることがあるので files だけ渡す
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      // 共有に失敗したらダウンロードへ
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
