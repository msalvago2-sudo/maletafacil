// Service worker de Maleta Fácil: permite instalar la web como app y abrirla sin conexión.
// Estrategia: primero internet (así siempre ves la última versión) y, si no hay conexión, la copia guardada.
const CACHE = 'maletafacil-v1';
const BASICOS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/og-image.png', '/agencias/agencias.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASICOS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Solo nuestra web y peticiones de lectura; nunca las funciones (guía, emails)
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/.netlify/')) return;

  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) {
        const copia = res.clone();
        caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? '/' : req, copia));
      }
      return res;
    }).catch(() =>
      caches.match(req.mode === 'navigate' ? '/' : req).then(r => r || caches.match('/'))
    )
  );
});
