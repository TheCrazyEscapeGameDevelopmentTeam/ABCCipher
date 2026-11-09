// ========================================
// ABC Cipher - Service Worker
// ========================================

// キャッシュのバージョン
const CACHE_NAME = "abc-cipher-v1";

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
  "./icons/icon-512.png"
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

  // GET以外は処理しない
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // 同じオリジン以外は処理しない
  if (url.origin !== self.location.origin) {
    return;
  }


  // --------------------------------------
  // HTMLページ：ネットワーク優先
  // --------------------------------------

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          // 正常なレスポンスだけキャッシュする
          if (response.ok) {
            const copy = response.clone();

            caches.open(CACHE_NAME)
              .then(cache => cache.put(request, copy));
          }

          return response;
        })
        .catch(async () => {
          // ネットワークに接続できない場合
          const cached = await caches.match(request);

          if (cached) {
            return cached;
          }

          // キャッシュにページがない場合はトップページを表示
          return await caches.match("./index.html");
        })
    );

    return;
  }


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
