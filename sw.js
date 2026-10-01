// Service worker : l'app fonctionne hors ligne et se met à jour en arrière-plan.
const VERSION = 'pomodoro-v1';
const FONTS = 'pomodoro-fonts';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONTS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Polices Google : en cache dès le premier chargement.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(FONTS).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Fichiers de l'app : réponse immédiate depuis le cache, mise à jour en arrière-plan.
  const key = req.mode === 'navigate' ? './index.html' : req;
  const network = fetch(req).then(async res => {
    if (res.ok) (await caches.open(VERSION)).put(key, res.clone());
    return res;
  });
  event.waitUntil(network.then(() => {}, () => {}));
  event.respondWith(
    caches.match(key, {ignoreSearch: true}).then(hit => hit || network)
  );
});

// Toucher la notification ramène sur l'app.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    const client = list.find(c => c.url.startsWith(self.registration.scope));
    return client ? client.focus() : self.clients.openWindow('./');
  }));
});
