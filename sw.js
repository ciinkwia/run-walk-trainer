const CACHE_NAME = 'runwalk-v14';

// App shell assets — code/markup/styles. Network-first so updates land
// on the next reload without needing uninstall + reinstall.
const APP_SHELL = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './firebase-config.js',
    './manifest.json'
];

// Static assets — icons + audio. Cache-first because they rarely change
// and they're large enough that network-first would feel slow.
const STATIC_ASSETS = [
    './icon-192.png',
    './icon-512.png',
    './icon-512-maskable.png',
    './icon-192.svg',
    './icon-512.svg',
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
    './audio/completed.mp3'
];

const APP_SHELL_SET = new Set(APP_SHELL.map(p => new URL(p, self.location).href));

function isAppShell(url) {
    // Match the app shell entries by absolute URL OR any HTML navigation request
    if (APP_SHELL_SET.has(url.href)) return true;
    if (url.pathname.endsWith('/') || url.pathname.endsWith('.html') ||
        url.pathname.endsWith('.css') || url.pathname.endsWith('.js') ||
        url.pathname.endsWith('manifest.json')) {
        return true;
    }
    return false;
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            // Pre-fetch app shell so first-launch + offline both work
            await cache.addAll(APP_SHELL);
            // Pre-fetch static assets best-effort (don't fail install if some are missing)
            for (const url of STATIC_ASSETS) {
                try { await cache.add(url); } catch (e) { /* tolerable */ }
            }
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Firebase / Google API — pass through to network (don't intercept)
    if (url.hostname.endsWith('googleapis.com') ||
        url.hostname.endsWith('firebaseio.com') ||
        url.hostname.endsWith('firebaseapp.com') ||
        url.hostname.endsWith('firebasestorage.app') ||
        (url.hostname === 'www.gstatic.com' && url.pathname.includes('/firebasejs/')) ||
        url.hostname.includes('identitytoolkit') ||
        url.hostname.includes('securetoken')) {
        return;
    }

    // Only handle our own origin
    if (url.origin !== self.location.origin) return;

    if (isAppShell(url)) {
        // NETWORK-FIRST for code/markup/styles — fresh on every reload, fall
        // back to cache only when offline. This ensures CSS/JS updates land
        // immediately on the next page load instead of being held back by
        // the previous SW's cache (the issue Erica hit on v10/v11/v12).
        event.respondWith(
            fetch(req).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(c => c.put(req, clone));
                }
                return response;
            }).catch(() => caches.match(req))
        );
    } else {
        // CACHE-FIRST for static assets (icons + audio) — fast, offline-friendly,
        // and they basically never change without a code change anyway.
        event.respondWith(
            caches.match(req).then((cached) => {
                return cached || fetch(req).then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(c => c.put(req, clone));
                    }
                    return response;
                });
            })
        );
    }
});
