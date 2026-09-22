// 静的ファイルだけをキャッシュする Service Worker。
// 撮影した画像は扱わない。キャッシュにも端末の外にも出さない。
//
// ファイルを追加したときは ASSETS に加え、CACHE の名前も上げること。
// 名前を上げると、古いキャッシュは activate で削除される。

const CACHE = 'ios-cam-2026-09-22.1';
const ASSETS = [
  './',
  './index.html',
  './diag.html',
  './manifest.webmanifest',
  './src/main.js',
  './src/diag.js',
  './src/camera.js',
  './src/encode.js',
  './src/permission.js',
  './src/version.js',
  './src/capture/frame.js',
  './src/capture/burst.js',
  './src/capture/photo.js',
  './src/pipeline/align.js',
  './src/pipeline/accumulate.js',
  './src/pipeline/merge.js',
  './src/pipeline/cpu-merge.js',
  './src/pipeline/stack.js',
  './src/ui/styles.css',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // 通信を優先し、失敗したときだけキャッシュを使う。
  // 更新が届きやすく、通信できない場所でも起動できる。
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html'))),
  );
});
