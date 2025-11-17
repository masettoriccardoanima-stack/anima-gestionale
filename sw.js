// in sw.js, in alto
self.APP_CHANNEL = self.APP_CHANNEL || 'beta';
self.APP_VERSION = self.APP_VERSION || '0.8.0-beta.1';
const CACHE_NAME = `anima-${self.APP_CHANNEL}-${self.APP_VERSION}`;

// sw.js – cache minimale
const CACHE = CACHE_NAME;
const CORE = [
  '/', '/index.html', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png',
  // aggiungi qui i tuoi file principali:
  '/app.js', '/styles.css', '/anima.css','/shim-desktop.js',
  '/vendor/xlsx.full.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(CORE.map(u => c.add(u)));   // <— sostituisce addAll
  })());
});


self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k === CACHE ? null : caches.delete(k)))))
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // network-first per richieste dinamiche, cache-first per statici
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // evita di mettere in cache chiamate Supabase o altre API
  if (/supabase\.co|supabase\.in/i.test(url.hostname)) return;

  if (CORE.some(p => url.pathname === p)) {
    // cache first per core
    e.respondWith(caches.match(req).then(res => res || fetch(req)));
  } else {
    // network first con fallback cache
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
