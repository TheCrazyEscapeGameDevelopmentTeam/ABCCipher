
"use strict";

// ========================================
// ABC Cipher - Service Worker
// ========================================

const CACHE_NAME = "abc-cipher-v4";

const PRECACHE_FILES = [
  "./",
  "./index.html",
  "./guide.html",
  "./specification.html",
  "./settings.html",
  "./googlea84bdbef9c58fe9f.html",
  "./style.css",
  "./script.js",
  "./settings.js",
  "./update-manager.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

// ========================================
// インストール
// ========================================

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_FILES))
  );

  // ここではskipWaiting()を実行しない。
  // 更新管理側からの指示を待つ。
});

// ========================================
// 有効化
// ========================================

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => Promise.all(
        cacheNames
          .filter(name =>
            name.startsWith("abc-cipher-") &&
            name !== CACHE_NAME
          )
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// ========================================
// 更新指示
// ========================================

self.addEventListener("message", event => {
  if (event.data?.type === "ACTIVATE_UPDATE") {
    event.waitUntil(self.skipWaiting());
  }
});

// ========================================
// 通信処理
// ========================================

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 外部サイトは対象外
  if (url.origin !== self.location.origin) return;

  // ページ：キャッシュ優先
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);

        if (cached) return cached;

        try {
          const response = await fetch(request);

          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
          }

          return response;
        } catch {
          return (
            await caches.match("./index.html") ||
            new Response("オフラインです。", {
              status: 503
            })
          );
        }
      })()
    );

    return;
  }

  // 静的ファイル：キャッシュ優先
  const isStaticFile =
    url.pathname.endsWith("/style.css") ||
    url.pathname.endsWith("/script.js") ||
    url.pathname.endsWith("/settings.js") ||
    url.pathname.endsWith("/update-manager.js") ||
    url.pathname.endsWith("/manifest.json") ||
    url.pathname.endsWith("/icon-192.png") ||
    url.pathname.endsWith("/icon-512.png") ||
    url.pathname.endsWith("/googlea84bdbef9c58fe9f.html");

  if (isStaticFile) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);

        if (cached) return cached;

        try {
          const response = await fetch(request);

          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
          }

          return response;
        } catch {
          return new Response("ファイルを取得できませんでした。", {
            status: 503
          });
        }
      })()
    );
  }
});
