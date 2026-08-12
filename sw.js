/**
 * sw.js — Service Worker
 * SPEC §13.2
 *
 * 版本化 cache-first。全部资源均为本地且体积极小（约 50KB），
 * 因此 install 时预缓存全部，无需运行时 fetch 策略。
 *
 * ⚠️ 陈旧缓存是 Service Worker 的经典陷阱。
 *    CACHE_NAME 必须在每次发布时递增，否则用户会被钉在旧版本上。
 */

const CACHE_NAME = 'wolf-v1';

/** 相对路径 —— 项目站点子路径下绝对路径会导致注册失败（SPEC §2.3）。 */
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './engine.js',
  './roles.js',
  './storage.js',
  './icons.svg',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
