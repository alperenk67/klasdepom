// Uygulamayı internetsiz çalıştırmak için önbellek.
// Uygulama dosyalarını değiştirince VERSION'ı artırın.
const VERSION = 'depo-v3';
const CDN_CACHE = 'depo-cdn';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== CDN_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Barkod okuyucu (ZXing JS + WASM): bir kez indir, sonra hep önbellekten
  if (url.hostname.endsWith('jsdelivr.net')) {
    e.respondWith(caches.open(CDN_CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Uygulama dosyaları: önce internet (güncelleme gelsin), yoksa önbellek
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || caches.match('./index.html'))
    );
  }
});
