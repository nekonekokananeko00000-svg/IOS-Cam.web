// 画像の書き出しと保存。
// iOS では canvas から写真アプリへ直接保存できないため、共有メニューを経由する。

// 拡張子の対応表。実際に選べるのは probeEncoders() を通った形式だけで、
// 測定した端末では JPEG と PNG だけが残った。
export const EXTENSION_OF_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/avif': 'avif',
};

export function timestampName(extension = 'jpg') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `IOSCam_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${extension}`;
}

// ファイル先頭の数バイトから、実際の形式を判定する。
// toBlob は対応していない形式を指定されても例外を出さず、PNG を返す仕様である。
// blob.type は指定した値をそのまま返すことがあるため、それだけでは判断できない。
export async function sniffFormat(blob) {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const ascii = (from, to) => String.fromCharCode(...head.slice(from, to));
  if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'jpeg';
  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand.startsWith('avi')) return 'avif';
    if (brand.startsWith('hei') || brand === 'mif1' || brand === 'msf1') return 'heic';
    return `ftyp:${brand}`;
  }
  return 'unknown';
}

const FORMAT_OF_TYPE = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/avif': 'avif',
};

/**
 * どの形式で実際に書き出せるかを調べる。
 * 「type が一致する」「中身が一致する」「読み込み直せる」の 3 つを満たしたものだけ採用する。
 */
export async function probeEncoders(types = ['image/jpeg', 'image/png', 'image/heic', 'image/avif', 'image/webp']) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 64, 64);
  gradient.addColorStop(0, '#c33');
  gradient.addColorStop(1, '#36c');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);

  const results = {};
  for (const type of types) {
    // eslint-disable-next-line no-await-in-loop
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
    if (!blob) {
      results[type] = { supported: false, reason: 'toBlob が null を返しました' };
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const sniffed = await sniffFormat(blob);
    let decodable = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      const bitmap = await createImageBitmap(blob);
      decodable = bitmap.width === 64 && bitmap.height === 64;
      bitmap.close?.();
    } catch { /* デコードできなければ不採用 */ }
    const expected = FORMAT_OF_TYPE[type];
    results[type] = {
      supported: blob.type === type && sniffed === expected && decodable,
      reportedType: blob.type,
      sniffed,
      decodable,
      bytes: blob.size,
    };
  }
  return results;
}

/** canvas を Blob にする。対応していない形式を指定すると PNG が返る点に注意する。 */
export function canvasToBlob(canvas, { type = 'image/jpeg', quality = 0.95 } = {}) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('画像の書き出しに失敗しました'));
    }, type, quality);
  });
}

/** 共有メニューに渡せるかどうか。利用者の操作の中から呼ぶ必要がある。 */
export function canShareFiles(file) {
  return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
}

/**
 * 保存する。共有メニューを使える場合はそれを開き、使えない場合はダウンロードする。
 * 共有メニューの「画像を保存」を選ぶと写真アプリに入る。
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function saveImage(blob, filename = timestampName()) {
  const file = new File([blob], filename, { type: blob.type, lastModified: Date.now() });

  if (canShareFiles(file)) {
    try {
      // iOS では title や text を付けると、画像ではなく文字列の共有になることがある
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      // 共有できなかった場合はダウンロードに切り替える
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
