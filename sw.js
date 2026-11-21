/*
  껍데기만 캐시한다. 방송 소리는 절대 캐시하지 않는다 — 생방송이라 의미도 없고
  용량만 먹는다. 화면·서체만 담아두면 인터넷이 잠깐 끊겨도 앱은 열린다.

  파일을 고쳤는데 옛것이 계속 보이면 아래 VER 숫자를 올린다. 그게 전부다.
*/
var VER = "radio-v5";
var SHELL = [
  "./",
  "./index.html",
  "./engine.js",
  "./manifest.json",
  "./fonts/barlow-400.woff2",
  "./fonts/barlow-500.woff2",
  "./fonts/barlow-600.woff2",
  "./fonts/barlow-700.woff2"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VER).then(function (c) { return c.addAll(SHELL); })
          .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VER; })
                            .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);

  // 방송 스트림과 방송사 API 는 손대지 않는다. 그대로 흘려보낸다.
  if (url.origin !== self.location.origin) return;

  // 우리 파일은 캐시를 먼저 보고, 없으면 받아서 넣어둔다.
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(VER).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () { return hit; });
    })
  );
});
