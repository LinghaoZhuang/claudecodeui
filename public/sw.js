// Service Worker for Claude Code UI PWA + Capacitor
const CACHE_NAME = 'claude-ui-v2';
const STATIC_CACHE_NAME = 'claude-ui-static-v2';
const API_HOST = 'https://code.zaneleo.top';

// Static resources to precache
const STATIC_RESOURCES = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Patterns for static resources to cache
const STATIC_PATTERNS = [
  /\.js$/,
  /\.css$/,
  /\.woff2?$/,
  /\.ttf$/,
  /\.eot$/,
  /\.svg$/,
  /\.png$/,
  /\.ico$/
];

// Check if request is for static resource
function isStaticResource(url) {
  const pathname = new URL(url).pathname;
  return STATIC_PATTERNS.some(pattern => pattern.test(pathname));
}

// Check if request is API request
function isApiRequest(url) {
  const pathname = new URL(url).pathname;
  return pathname.startsWith('/api/') || pathname.startsWith('/ws');
}

// Check if running in Capacitor environment
function isCapacitor() {
  return self.location.protocol === 'capacitor:' ||
         self.location.hostname === 'localhost';
}

// Install event - precache static resources
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then(cache => {
        console.log('[SW] Precaching static resources');
        return cache.addAll(STATIC_RESOURCES);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME && cacheName !== STATIC_CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - handle requests with caching strategies
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Skip WebSocket requests
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return;
  }

  // Handle API requests - Network first, no cache
  if (isApiRequest(url)) {
    // In Capacitor, proxy API requests to remote server
    if (isCapacitor() && !url.includes(API_HOST)) {
      const apiUrl = url.replace(self.location.origin, API_HOST);
      event.respondWith(
        fetch(apiUrl, {
          ...event.request,
          credentials: 'include',
          mode: 'cors'
        }).catch(error => {
          console.error('[SW] API request failed:', error);
          return new Response(JSON.stringify({ error: 'Network unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        })
      );
      return;
    }

    // Regular API request - network only
    event.respondWith(
      fetch(event.request).catch(error => {
        console.error('[SW] API request failed:', error);
        return new Response(JSON.stringify({ error: 'Network unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Handle static resources - Cache first strategy
  if (isStaticResource(url)) {
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        if (cachedResponse) {
          // Return cached response and update cache in background
          event.waitUntil(
            fetch(event.request).then(networkResponse => {
              if (networkResponse.ok) {
                caches.open(STATIC_CACHE_NAME).then(cache => {
                  cache.put(event.request, networkResponse);
                });
              }
            }).catch(() => {})
          );
          return cachedResponse;
        }

        // Not in cache, fetch from network and cache
        return fetch(event.request).then(networkResponse => {
          if (networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(STATIC_CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // Default - Network first with cache fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then(cachedResponse => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // Return offline page for navigation requests
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});

// Listen for messages from main thread
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // Handle cache update requests
  if (event.data && event.data.type === 'CACHE_URLS') {
    const urls = event.data.urls;
    event.waitUntil(
      caches.open(STATIC_CACHE_NAME).then(cache => {
        return Promise.all(
          urls.map(url => {
            return fetch(url).then(response => {
              if (response.ok) {
                return cache.put(url, response);
              }
            }).catch(() => {});
          })
        );
      })
    );
  }
});
