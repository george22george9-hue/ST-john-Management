// Service Worker for St. John Church Management System
// كنيسة مارجرجس بسندبيس - اجتماع القديس يوحنا الحبيب
const CACHE_VERSION = 'stjohn-pwa-v1.0.5';
const STATIC_CACHE_NAME = `static-${CACHE_VERSION}`;
const DYNAMIC_CACHE_NAME = `dynamic-${CACHE_VERSION}`;

// Core static assets for offline use
const STATIC_ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './firebase-app.js',
    './firebase-firestore.js',
    './manifest.json',
    './logo.png',
    './qrcode-generator.min.js',
    './html5-qrcode.min.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-192.png',
    './icons/icon-maskable-512.png',
    './icons/apple-touch-icon.png',
    './icons/favicon-32.png'
];

// Domains that should always bypass service worker caching (e.g. Firebase/Firestore)
const BYPASS_DOMAINS = [
    'firestore.googleapis.com',
    'firebase.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'st-john-g.firebaseapp.com'
];

// Install Event: Pre-cache core shell
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE_NAME).then(async (cache) => {
            console.log('[SW] Pre-caching static assets for offline mode...');
            // Cache resiliently - don't fail whole install if one asset is missing
            await Promise.allSettled(
                STATIC_ASSETS.map((asset) =>
                    cache.add(asset).catch((err) => {
                        console.warn(`[SW] Failed to precache: ${asset}`, err);
                    })
                )
            );
        }).then(() => self.skipWaiting())
    );
});

// Activate Event: Clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== STATIC_CACHE_NAME && key !== DYNAMIC_CACHE_NAME) {
                        console.log(`[SW] Removing outdated cache: ${key}`);
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch Event Strategy:
// 1. Navigation requests: Network-First with cache fallback to ./index.html
// 2. Firebase/Firestore: Pass through untouched
// 3. Static local assets: Cache-First with Network Revalidation (Stale-While-Revalidate)
// 4. External CDN assets (fonts, icons, cdnjs): Stale-While-Revalidate into DYNAMIC_CACHE
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);

    // Only handle GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Bypass Firebase/Firestore cloud calls to prevent sync interference
    if (BYPASS_DOMAINS.some(domain => url.hostname.includes(domain))) {
        return;
    }

    // Bypass chrome-extension and unsupported schemes
    if (!url.protocol.startsWith('http')) {
        return;
    }

    // 1. Handle Navigation Requests (HTML pages / shortcuts)
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        const responseClone = networkResponse.clone();
                        caches.open(STATIC_CACHE_NAME).then((cache) => {
                            cache.put(request, responseClone);
                        });
                    }
                    return networkResponse;
                })
                .catch(async () => {
                    // Offline fallback: serve cached index.html
                    const cachedResponse = await caches.match(request);
                    if (cachedResponse) return cachedResponse;
                    return caches.match('./index.html') || caches.match('./');
                })
        );
        return;
    }

    // 2. Handle Local Static Assets (App Shell)
    if (url.origin === self.location.origin) {
        // Versioned assets (e.g. app.js?v=... or style.css?v=...) use Network-First to immediately fetch new updates
        if (url.search) {
            event.respondWith(
                fetch(request)
                    .then((networkResponse) => {
                        if (networkResponse && networkResponse.status === 200) {
                            const responseClone = networkResponse.clone();
                            caches.open(STATIC_CACHE_NAME).then((cache) => {
                                cache.put(request, responseClone);
                            });
                        }
                        return networkResponse;
                    })
                    .catch(() => caches.match(request))
            );
            return;
        }

        event.respondWith(
            caches.match(request).then((cachedResponse) => {
                if (cachedResponse) {
                    // Update cache in the background (stale-while-revalidate)
                    fetch(request).then((networkResponse) => {
                        if (networkResponse && networkResponse.status === 200) {
                            caches.open(STATIC_CACHE_NAME).then((cache) => {
                                cache.put(request, networkResponse);
                            });
                        }
                    }).catch(() => { /* Ignore background update failures */ });

                    return cachedResponse;
                }

                // Not in cache: fetch from network and cache
                return fetch(request).then((networkResponse) => {
                    if (!networkResponse || networkResponse.status !== 200) {
                        return networkResponse;
                    }
                    const responseClone = networkResponse.clone();
                    caches.open(STATIC_CACHE_NAME).then((cache) => {
                        cache.put(request, responseClone);
                    });
                    return networkResponse;
                });
            })
        );
        return;
    }

    // 3. Handle External CDNs (Google Fonts, Phosphor Icons, Unpkg, etc.)
    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            const fetchPromise = fetch(request).then((networkResponse) => {
                if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
                    const responseClone = networkResponse.clone();
                    caches.open(DYNAMIC_CACHE_NAME).then((cache) => {
                        cache.put(request, responseClone);
                    });
                }
                return networkResponse;
            }).catch(() => {
                // If network fails and nothing in cache, return undefined
                return cachedResponse;
            });

            return cachedResponse || fetchPromise;
        })
    );
});

// Communication with frontend clients
self.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }
});
