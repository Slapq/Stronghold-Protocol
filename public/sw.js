// sw.js — service worker: serves the art/audio pack this browser imported (js/assetpack/importer.js, Cache Storage
// 'sp-assets-v1') under the URLs the client already uses. Only the pack paths are intercepted:
//   /assets/**  /fonts/**  /data/assets.json  /data/local-assets.json      (shared/assetPack.js PACK_PATH_RE)
// A stored file answers from the cache (query string ignored, single byte ranges honoured); anything not stored goes to
// the network as usual, so a server that still hosts the art (SP_ASSETS=server) keeps working without an import.
// Everything else (pages, code, game data, /ws) is never touched. Classic script (no imports): Firefox and older
// Safari cannot run module service workers.
/* eslint-env serviceworker */
'use strict';

var PACK_CACHE = 'sp-assets-v1';
var PACK_PATH_RE = /^\/(?:assets\/.+|fonts\/.+|data\/(?:local-)?assets\.json)$/;

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' && req.method !== 'HEAD') return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin || !PACK_PATH_RE.test(url.pathname)) return;
  event.respondWith(respond(req, url));
});

function respond(req, url) {
  return caches.open(PACK_CACHE)
    .then(function (cache) { return cache.match(url.origin + url.pathname); })
    .catch(function () { return null; })
    .then(function (hit) {
      if (!hit) return fetch(req);
      return fromCache(req, hit);
    });
}

function fromCache(req, res) {
  var range = req.headers.get('range');
  if (!range && req.method === 'GET') return res;
  return res.blob().then(function (blob) {
    var type = res.headers.get('content-type') || 'application/octet-stream';
    var size = blob.size;
    var headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    var m = range ? /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(range) : null;
    if (m && (m[1] !== '' || m[2] !== '')) {
      var start, end;
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
      else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
      if (start >= size || end < start) {
        return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
      headers['Content-Length'] = String(end - start + 1);
      return new Response(req.method === 'HEAD' ? null : blob.slice(start, end + 1), { status: 206, headers: headers });
    }
    headers['Content-Length'] = String(size);
    return new Response(req.method === 'HEAD' ? null : blob, { status: 200, headers: headers });
  });
}
