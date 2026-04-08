const CACHE_NAME = 'miyoviajo-v1';
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
];

// Instalar Service Worker
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching app shell');
      return cache.addAll(URLS_TO_CACHE).catch((err) => {
        console.warn('[SW] Cache addAll error:', err);
        // Continuar si algunos archivos fallan
      });
    })
  );
  self.skipWaiting();
});

// Activar Service Worker
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Estrategia: Network first, fallback to cache
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Ignorar solicitudes no-GET
  if (request.method !== 'GET') {
    return;
  }

  // Ignorar solicitudes a orígenes externos (excepto APIs necesarias)
  const url = new URL(request.url);
  if (url.origin !== self.location.origin &&
      !url.hostname.includes('basemaps.cartocdn.com') &&
      !url.hostname.includes('project-osrm.org') &&
      !url.hostname.includes('unpkg.com')) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cachear respuesta exitosa
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // Usar caché como fallback
        return caches.match(request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // Si es una navegación, retornar index.html
          if (request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return null;
        });
      })
  );
});

// Escuchar mensajes desde la app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Background sync para detectar paradas en background
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync:', event.tag);

  if (event.tag === 'sync-tracking') {
    // Continuar geolocalización en background
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'SYNC_TRACKING',
            message: 'Continuando grabación en background',
          });
        });
      })
    );
  }
});

console.log('[SW] Service Worker loaded');
