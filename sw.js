/**
 * sw.js — Service Worker
 * SPEC §13.2
 *
 * 版本化 cache-first。全部资源均为本地且体积极小（约 50KB），
 * 因此 install 时预缓存全部，无需运行时 fetch 策略。
 *
 * ⚠️ 陈旧缓存是 Service Worker 的经典陷阱。
 *    CACHE_NAME 必须在每次发布时递增，否则用户会被钉在旧版本上。
 *
 * ⚠️ 尚未实现 —— 仅结构骨架。
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
];

self.addEventListener('install', (event) => {
  // TODO: caches.open(CACHE_NAME) → addAll(PRECACHE_URLS) → self.skipWaiting()
});

self.addEventListener('activate', (event) => {
  // TODO: 删除所有非 CACHE_NAME 的缓存 → self.clients.claim()
});

self.addEventListener('fetch', (event) => {
  // TODO: cache-first，未命中则网络回源
});
