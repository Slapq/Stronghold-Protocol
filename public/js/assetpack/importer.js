// assetpack/importer.js — install an art/audio pack into this browser (Cache Storage), from a zip File / Blob, a zip URL
// or a web directory that holds pack.json (shared/assetPack.js has the format). public/sw.js serves the stored files back
// under /assets/…, /fonts/…, /data/assets.json and /data/local-assets.json, so the rest of the client is unchanged.
//
//   const pack = createPackStore();                 // { status, clear, importBlob, importUrl }
//   await pack.status()                             // null | { hash, files, bytes, installedAt, source, complete }
//   await pack.importBlob(file, { onProgress, signal })
//   await pack.importUrl('https://host/pack/', { onProgress, signal })   // directory (resumable) or …/x.zip
//
// Keys are absolute same-origin URLs without a query (the service worker strips the query before matching). The
// metadata record is written last: a pack is "installed" only when every file landed. A directory import that stops
// half way resumes where it was (files already stored with the right size are skipped).
// Injectable caches / fetch / origin for the Node tests.

import { openZip } from './zip.js';
import {
  PACK_INDEX, detectLayout, packRelToSite, checkPackIndex, contentTypeFor, encodeRel,
} from '../../../shared/assetPack.js';

export const PACK_CACHE = 'sp-assets-v1';
export const META_PATH = '/__sp/pack-meta.json';
const DIR_CONCURRENCY = 6;
const RETRIES = 3;

const abortError = () => Object.assign(new Error('已取消'), { name: 'AbortError' });
const checkAbort = (signal) => { if (signal && signal.aborted) throw abortError(); };

/** Read a JSON file from a (zip) blob. */
async function blobJson(blob) {
  try { return JSON.parse(await blob.text()); } catch { return null; }
}

/**
 * @param {{ caches?: CacheStorage, fetch?: typeof fetch, origin?: string, wait?: (ms: number) => Promise<void> }} [opts]
 */
export function createPackStore(opts = {}) {
  const cachesApi = opts.caches || globalThis.caches;
  const doFetch = opts.fetch || ((...a) => globalThis.fetch(...a));
  const origin = opts.origin || globalThis.location?.origin || 'http://localhost';
  const wait = opts.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const keyFor = (site) => new URL(site, origin).href;

  const open = () => {
    if (!cachesApi) throw new Error('此浏览器不支持 Cache Storage（需要 HTTPS 或 localhost）');
    return cachesApi.open(PACK_CACHE);
  };

  async function status() {
    if (!cachesApi) return null;
    try {
      const cache = await cachesApi.open(PACK_CACHE);
      const res = await cache.match(keyFor(META_PATH));
      return res ? await res.json() : null;
    } catch { return null; }
  }

  async function writeMeta(cache, meta) {
    await cache.put(keyFor(META_PATH), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  }

  async function putFile(cache, site, blob) {
    await cache.put(keyFor(site), new Response(blob, {
      headers: { 'Content-Type': contentTypeFor(site), 'Content-Length': String(blob.size), 'X-SP-Pack': '1' },
    }));
  }

  async function clear() {
    if (!cachesApi) return;
    await cachesApi.delete(PACK_CACHE);
  }

  /** Hash of the art manifest a pack carries (data/assets.json) or null. */
  async function manifestHash(cache) {
    try {
      const res = await cache.match(keyFor('/data/assets.json'));
      const j = res ? await res.json() : null;
      return j && typeof j.hash === 'string' ? j.hash : null;
    } catch { return null; }
  }

  /**
   * Import a zip (File / Blob). Replaces any installed pack.
   * @param {Blob} blob
   * @param {{ onProgress?: (p: object) => void, signal?: AbortSignal, source?: string }} [o]
   */
  async function importBlob(blob, o = {}) {
    const onProgress = o.onProgress || (() => {});
    onProgress({ phase: 'scan', done: 0, total: blob.size });
    const zip = await openZip(blob);
    const names = zip.entries.map((e) => e.name);
    const layout = detectLayout(names);
    if (!layout) throw new Error('这个 zip 不是素材包：里面没有 pack.json，也没有 public/assets/ 目录');
    const picked = [];
    for (const e of zip.entries) {
      if (e.dir) continue;
      const site = layout.map(e.name);
      if (site) picked.push({ e, site });
    }
    if (!picked.some((x) => x.site.startsWith('/assets/'))) throw new Error('素材包里没有 assets/ 文件');
    let index = null;
    const idxEntry = zip.entries.find((e) => e.name === layout.root + PACK_INDEX);
    if (idxEntry) index = await blobJson(await zip.read(idxEntry));
    if (index) { const err = checkPackIndex(index); if (err) throw new Error(err); }

    await clear();
    const cache = await open();
    const total = picked.reduce((s, x) => s + x.e.size, 0);
    let done = 0;
    let files = 0;
    for (const { e, site } of picked) {
      checkAbort(o.signal);
      await putFile(cache, site, await zip.read(e));
      done += e.size;
      files++;
      onProgress({ phase: 'store', done, total, files, filesTotal: picked.length });
    }
    const meta = {
      hash: (index && index.hash) || (await manifestHash(cache)), app: (index && index.app) || null,
      files, bytes: total, installedAt: Date.now(), source: o.source || (blob.name ? `文件 ${blob.name}` : 'zip'),
      layout: layout.layout, complete: true,
    };
    await writeMeta(cache, meta);
    return meta;
  }

  async function fetchRetry(url, signal, init) {
    let last;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      checkAbort(signal);
      try {
        const res = await doFetch(url, { signal, cache: 'no-cache', ...init });
        if (res.ok) return res;
        last = new Error(`HTTP ${res.status}：${url}`);
        if (res.status === 404 || res.status === 401 || res.status === 403) break;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        last = err;
      }
      if (attempt < RETRIES) await wait(500 * 2 ** attempt);
    }
    throw last || new Error(`下载失败：${url}`);
  }

  /** Download a body with progress (bytes) into a Blob. */
  async function download(res, onChunk) {
    if (!res.body || typeof res.body.getReader !== 'function') { const b = await res.blob(); onChunk(b.size); return b; }
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      onChunk(value.byteLength);
    }
    return new Blob(chunks);
  }

  /**
   * Import from a URL: `…/x.zip` (downloaded whole, then imported) or a directory holding pack.json.
   * @param {string} url absolute, or relative to the page (e.g. '/pack/')
   * @param {{ onProgress?: (p: object) => void, signal?: AbortSignal }} [o]
   */
  async function importUrl(url, o = {}) {
    const onProgress = o.onProgress || (() => {});
    const abs = new URL(url, origin);
    if (/\.zip$/i.test(abs.pathname)) {
      const res = await fetchRetry(abs.href, o.signal);
      const total = Number(res.headers.get('content-length')) || 0;
      let done = 0;
      const blob = await download(res, (n) => { done += n; onProgress({ phase: 'download', done, total }); });
      return importBlob(blob, { ...o, source: abs.href });
    }
    let base = abs.href;
    if (/\/pack\.json$/i.test(abs.pathname)) base = base.replace(/pack\.json(\?.*)?$/i, '');
    else if (!base.endsWith('/')) base += '/';
    const idxRes = await fetchRetry(base + PACK_INDEX, o.signal);
    let index;
    try { index = await idxRes.json(); } catch { throw new Error(`${base}${PACK_INDEX} 不是有效的 JSON`); }
    const err = checkPackIndex(index);
    if (err) throw new Error(err);
    const list = [];
    for (const [rel, size] of index.files) {
      const site = packRelToSite(rel);
      if (site) list.push({ rel, size, site });
    }
    if (!list.some((x) => x.site.startsWith('/assets/'))) throw new Error('pack.json 里没有 assets/ 文件');

    // resume a half-finished import of the same pack; anything else starts from an empty cache
    const prev = await status();
    if (!prev || prev.complete || prev.source !== base || prev.hash !== index.hash) await clear();
    const cache = await open();
    const total = list.reduce((s, x) => s + x.size, 0);
    let done = 0;
    let files = 0;
    const report = () => onProgress({ phase: 'download', done, total, files, filesTotal: list.length });
    await writeMeta(cache, { hash: index.hash || null, app: index.app || null, files: 0, bytes: total, source: base, complete: false });

    // one failing file stops the other workers too
    const ctl = new AbortController();
    const signal = ctl.signal;
    const onAbort = () => ctl.abort();
    if (o.signal) { if (o.signal.aborted) ctl.abort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }
    let next = 0;
    async function worker() {
      while (next < list.length) {
        const item = list[next++];
        checkAbort(signal);
        const have = await cache.match(keyFor(item.site));
        if (have && Number(have.headers.get('content-length')) === item.size) {
          done += item.size; files++; report();
          continue;
        }
        const res = await fetchRetry(base + encodeRel(item.rel), signal);
        let got = 0;
        const blob = await download(res, (n) => { got += n; done += n; report(); });
        if (blob.size !== item.size) {
          done -= got;
          throw new Error(`${item.rel}: 大小不符（${blob.size} ≠ ${item.size}），素材目录可能正在更新，请稍后重试`);
        }
        await putFile(cache, item.site, blob);
        files++;
        report();
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(DIR_CONCURRENCY, list.length) }, () => worker().catch((e) => { ctl.abort(); throw e; })));
    } finally {
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
    }
    checkAbort(o.signal);
    const meta = {
      hash: index.hash || (await manifestHash(cache)), app: index.app || null, files, bytes: total,
      installedAt: Date.now(), source: base, layout: 'pack', complete: true,
    };
    await writeMeta(cache, meta);
    return meta;
  }

  return { status, clear, importBlob, importUrl };
}
