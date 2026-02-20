const CACHE_NAME = 'runwalk-v2';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './firebase-config.js',
    './manifest.json',
    './icon-192.svg',
    './icon-512.svg'
];

// Install — cache all assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

// Fetch — cache-first for app assets, bypass for Firebase/Google API
self.addEventListener('fetch', (event) => {
    const url = event.request.url;

    // Let Firebase/Google requests go straight to network (don't intercept)
    if (url.includes('googleapis.com') ||
        url.includes('firebaseio.com') ||
        url.includes('firebaseapp.com') ||
        url.includes('firebasestorage.app') ||
        url.includes('gstatic.com/firebasejs') ||
        url.includes('identitytoolkit') ||
        url.includes('securetoken')) {
        return;
    }

    // Cache-first for app shell assets
    event.respondWith(
        caches.match(event.request).then((cached) => {
            return cached || fetch(event.request).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            });
        })
    );
});
