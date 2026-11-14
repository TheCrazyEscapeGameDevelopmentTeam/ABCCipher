// ========================================
// ABC Cipher - Service Worker
// ========================================

// キャッシュのバージョン
const CACHE_NAME = "abc-cipher-v2";

// キャッシュするファイル
const PRECACHE_FILES = [
  "./",
  "./index.html",
  "./guide.html",
  "./specification.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./settings.html",
  "./settings.js"
];


// ========================================
// インストール処理
// ========================================

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(PRECACHE_FILES);
      })
      .then(() => {
        // 新しいService Workerを待機させずに有効化
        return self.skipWaiting();
      })
  );
});


// ========================================
// 有効化処理
// ========================================

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => {
              return name.startsWith("abc-cipher-")
                && name !== CACHE_NAME;
            })
            .map(name => caches.delete(name))
        );
      })
      .then(() => {
        // 現在開いているページも制御対象にする
        return self.clients.claim();
      })
  );
});


// ========================================
// 通信処理
// ========================================


self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 外部サイトへの通信は対象外
  if (url.origin !== self.location.origin) return;

  // モバイルデータ通信かどうかを判定
  const isCellular =
    self.navigator.connection?.type === "cellular";

  // モバイルデータ通信ならキャッシュ優先
  if (isCellular) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);

        if (cached) {
          return cached;
        }

        try {
          const response = await fetch(request);

          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
          }

          return response;
        } catch {
          if (request.mode === "navigate") {
            return await caches.match("./index.html");
          }

          return new Response("オフラインです。", {
            status: 503,
            headers: {
              "Content-Type": "text/plain; charset=utf-8"
            }
          });
        }
      })()
    );

    return;
  }

  // ここから下はWi-Fiなど、通常時の動作

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();

            caches.open(CACHE_NAME)
              .then(cache => cache.put(request, copy));
          }

          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);

          if (cached) return cached;

          return await caches.match("./index.html");
        })
    );

    return;
  }

  // CSS・JS・画像などはキャッシュ優先
  const path = url.pathname;

  const isStaticFile =
    path.endsWith("/style.css") ||
    path.endsWith("/script.js") ||
    path.endsWith("/settings.js") ||
    path.endsWith("/manifest.json") ||
    path.endsWith("/icon-192.png") ||
    path.endsWith("/icon-512.png");

  if (isStaticFile) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;

        return fetch(request).then(response => {
          if (response.ok) {
            const copy = response.clone();

            caches.open(CACHE_NAME)
              .then(cache => cache.put(request, copy));
          }

          return response;
        });
      })
    );
  }
});


  // --------------------------------------
  // 静的ファイル：キャッシュ優先
  // --------------------------------------

  const path = url.pathname;

  const isStaticFile =
    path.endsWith("/style.css") ||
    path.endsWith("/script.js") ||
    path.endsWith("/manifest.json") ||
    path.endsWith("/icon-192.png") ||
    path.endsWith("/icon-512.png");

  if (isStaticFile) {
    event.respondWith(
      caches.match(request)
        .then(cached => {
          if (cached) {
            return cached;
          }

          return fetch(request).then(response => {
            if (response.ok) {
              const copy = response.clone();

              caches.open(CACHE_NAME)
                .then(cache => cache.put(request, copy));
            }

            return response;
          });
        })
    );

    return;
  }

  // その他の通信は通常どおりネットワークへ
});
