const CACHE_NAME = 'runwalk-v10';

// App shell assets
const APP_ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './firebase-config.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './icon-512-maskable.png',
    './icon-192.svg',
    './icon-512.svg'
];

// Pre-generated voice clips
const AUDIO_ASSETS = [
    './audio/warmup.mp3',
    './audio/run_1.mp3',
    './audio/run_2.mp3',
    './audio/run_3.mp3',
    './audio/run_4.mp3',
    './audio/run_5.mp3',
    './audio/run_6.mp3',
    './audio/run_7.mp3',
    './audio/run_8.mp3',
    './audio/walk_1.mp3',
    './audio/walk_2.mp3',
    './audio/walk_3.mp3',
    './audio/walk_4.mp3',
    './audio/walk_5.mp3',
    './audio/walk_6.mp3',
    './audio/walk_7.mp3',
    './audio/walk_8.mp3',
    './audio/cooldown.mp3',
    './audio/ready_run.mp3',
    './audio/ready_walk.mp3',
    './audio/ready_switch.mp3',
    './audio/nearly_there.mp3',
    './audio/paused.mp3',
    './audio/resumed.mp3',
    './audio/stopped.mp3',
    './audio/completed.mp3',
];

// Install — cache app shell (required), then try audio (optional)
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            // App shell must succeed
            await cache.addAll(APP_ASSETS);
            // Audio files are optional — cache individually, ignore failures
            for (const url of AUDIO_ASSETS) {
                try { await cache.add(url); } catch (e) { /* not yet generated */ }
            }
        })
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

    // Cache-first for app shell + audio assets
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
