// 화면 파일을 변경해 게시할 때 캐시 버전도 함께 올립니다.
const CACHE = 'tisc-field-notes-v2';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './archive.js', './storage.js', './icons/icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('tisc-field-notes-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const allowed = ASSETS.map(path => new URL(path, scope).pathname);
  if (!allowed.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const stored = await cache.match(event.request, { ignoreSearch: true });
    return stored || fetch(event.request);
  }));
});
