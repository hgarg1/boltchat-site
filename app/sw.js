// Service worker of the Boltchat web chat: keeps a copy of the chat's own files so it opens without a
// connection (old chats can be read; new replies still need Groq). It only ever handles requests for
// files under app/, and never touches requests to Groq.
// The chat's files are always fetched fresh when there is a connection; the copy is only for when there isn't.
const APP_CACHE = 'boltchat-app-v1';
// The embedding model and the large libraries don't change, so they are served from the copy first.
// Change this name when one of them is replaced.
const HEAVY_CACHE = 'boltchat-heavy-v1';
const scope = new URL(self.registration.scope);

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('boltchat-') && name !== APP_CACHE && name !== HEAVY_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const heavy = /\/(models|vendor\/ort|vendor\/pdfjs)\//.test(url.pathname);
  event.respondWith((async () => {
    const cache = await caches.open(heavy ? HEAVY_CACHE : APP_CACHE);
    if (heavy) {
      const hit = await cache.match(event.request);
      if (hit) return hit;
    }
    try {
      const response = await fetch(event.request);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    } catch (err) {
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
