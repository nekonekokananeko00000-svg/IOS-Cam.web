// 静的資産だけをキャッシュする素朴な Service Worker。
// 撮影データは一切扱わない（写真は端末の外にもキャッシュにも出さない）。

const CACHE = 'ios-cam-v1';
const ASSETS = [
  './',
  './index.html',
  './diag.html',
  './manifest.webmanifest',
  './src/main.js',
  './src/diag.js',
  './src/camera.js',
  './src/encode.js',
  './src/capture/frame.js',
  './src/capture/burst.js',
  './src/capture/photo.js',
  './src/pipeline/align.js',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // ネットワーク優先・失敗したらキャッシュ（更新が届きやすく、オフラインでも動く）
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached
        || caches.match('./index.html'))),
  );
});
