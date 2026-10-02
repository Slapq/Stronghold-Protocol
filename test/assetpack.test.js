// test/assetpack.test.js — art/audio kept out of the server (docs/DEPLOY.md「素材与服务器分离」): the pack format
// (shared/assetPack.js), the pack builder + zip writer (tools/pack-assets.mjs, tools/assets/zipwrite.mjs), the browser
// zip reader and importer (public/js/assetpack/zip.js, importer.js — run in Node against an in-memory Cache Storage),
// the boot-gate decision (gate.js decideGate), the service worker (public/sw.js in a vm sandbox) and the server's
// SP_ASSETS / SP_ASSET_URL / GET /client-config.json.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectLayout, packRelToSite, isPackPath, checkPackIndex, contentTypeFor, PACK_INDEX } from '../shared/assetPack.js';
import { collectPackFiles, packIndex, writeDir } from '../tools/pack-assets.mjs';
import { writeZip, crc32 } from '../tools/assets/zipwrite.mjs';
import { openZip } from '../public/js/assetpack/zip.js';
import { createPackStore, PACK_CACHE, META_PATH } from '../public/js/assetpack/importer.js';
import { decideGate, normaliseSources } from '../public/js/assetpack/gate.js';
import { startServer, resolveAssetsMode, parseAssetSources } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://game.test';

// ---- fixtures ----------------------------------------------------------------------------------------------------

/** A fake repository with a little art: random PNG bytes, a compressible skeleton, fonts, the manifests. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pack-'));
  const put = (rel, data) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
  put('public/assets/char/avatar/char_002_amiya.png', crypto.randomBytes(5000));
  put('public/assets/spine/char_002_amiya/front.skel', Buffer.from('skeleton '.repeat(400)));
  put('public/assets/spine/char_002_amiya/front.atlas', 'front.png\nsize: 64,64\n');
  put('public/assets/audio/bgm/menu.mp3', crypto.randomBytes(3000));
  put('public/assets/.DS_Store', 'junk');
  put('public/fonts/fonts.css', '@font-face{font-family:Bender;src:url(/fonts/bender.woff2)}');
  put('public/fonts/bender.woff2', crypto.randomBytes(800));
  put('data/assets.json', JSON.stringify({ version: 1, hash: 'abc123', chars: {} }));
  return dir;
}

/** In-memory CacheStorage (the subset the importer and the service worker use). */
function fakeCaches() {
  const stores = new Map();
  const mk = () => {
    const m = new Map();
    return {
      _m: m,
      async match(key) { const r = m.get(String(key)); return r ? r.clone() : undefined; },
      async put(key, res) { m.set(String(key), new Response(await res.blob(), { status: res.status, headers: res.headers })); },
      async keys() { return [...m.keys()]; },
    };
  };
  return {
    stores,
    async open(name) { if (!stores.has(name)) stores.set(name, mk()); return stores.get(name); },
    async delete(name) { return stores.delete(name); },
    async has(name) { return stores.has(name); },
  };
}

const zipBlob = (file) => new Blob([fs.readFileSync(file)]);
const readEntryText = async (zip, name) => (await zip.read(zip.entries.find((e) => e.name === name))).text();

// ---- format ------------------------------------------------------------------------------------------------------

describe('pack format (shared/assetPack.js)', () => {
  test('pack paths: only the art, the fonts and the two art manifests', () => {
    for (const p of ['/assets/a.png', '/assets/x/y.skel', '/fonts/fonts.css', '/data/assets.json', '/data/local-assets.json']) assert.ok(isPackPath(p), p);
    for (const p of ['/data/chess.json', '/js/main.js', '/index.html', '/assets/', '/sw.js', '/assets/../server/index.js']) assert.ok(!isPackPath(p), p);
    assert.equal(packRelToSite('assets/a.png'), '/assets/a.png');
    assert.equal(packRelToSite('data/config.json'), null, 'game data always comes from the server');
    assert.equal(packRelToSite('assets/../../etc/passwd'), null);
    assert.equal(packRelToSite('server/index.js'), null);
  });

  test('layouts: pack (pack.json root, nested in a folder) and the upstream release bundle', () => {
    const pack = detectLayout(['pack.json', 'assets/a.png', 'fonts/fonts.css', 'data/assets.json', 'README.txt']);
    assert.equal(pack.layout, 'pack');
    assert.equal(pack.map('assets/a.png'), '/assets/a.png');
    assert.equal(pack.map('README.txt'), null);
    const nested = detectLayout(['my pack/', 'my pack/pack.json', 'my pack/assets/a.png']);
    assert.equal(nested.map('my pack/assets/a.png'), '/assets/a.png');
    const noIndex = detectLayout(['x/assets/a.png', 'x/data/assets.json']);
    assert.equal(noIndex.layout, 'pack');
    assert.equal(noIndex.map('x/data/assets.json'), '/data/assets.json');
    const rel = detectLayout([
      'Stronghold-Protocol/node_modules/three/examples/public/assets/x.png',
      'Stronghold-Protocol/public/assets/char/a.png', 'Stronghold-Protocol/public/fonts/fonts.css',
      'Stronghold-Protocol/public/js/main.js', 'Stronghold-Protocol/data/assets.json', 'Stronghold-Protocol/data/chess.json',
      'Stronghold-Protocol/data/local-assets.json', 'Stronghold-Protocol/server/index.js',
    ]);
    assert.equal(rel.layout, 'release');
    assert.equal(rel.map('Stronghold-Protocol/public/assets/char/a.png'), '/assets/char/a.png');
    assert.equal(rel.map('Stronghold-Protocol/public/fonts/fonts.css'), '/fonts/fonts.css');
    assert.equal(rel.map('Stronghold-Protocol/data/local-assets.json'), '/data/local-assets.json');
    for (const n of ['Stronghold-Protocol/public/js/main.js', 'Stronghold-Protocol/data/chess.json', 'Stronghold-Protocol/server/index.js',
      'Stronghold-Protocol/node_modules/three/examples/public/assets/x.png']) assert.equal(rel.map(n), null, n);
    assert.equal(detectLayout(['a.txt', 'b/c.png']), null);
  });

  test('pack.json validation and content types', () => {
    assert.equal(checkPackIndex({ format: 'stronghold-assets', version: 1, files: [['assets/a.png', 3]] }), null);
    assert.match(checkPackIndex({ format: 'x', version: 1, files: [] }), /format/);
    assert.match(checkPackIndex({ format: 'stronghold-assets', version: 99, files: [['a', 1]] }), /更新/);
    assert.match(checkPackIndex({ format: 'stronghold-assets', version: 1, files: [['a']] }), /格式/);
    assert.equal(contentTypeFor('/assets/a.PNG'), 'image/png');
    assert.equal(contentTypeFor('/assets/x.skel'), 'application/octet-stream');
    assert.equal(contentTypeFor('/fonts/a.woff2'), 'font/woff2');
    assert.match(contentTypeFor('/assets/x.atlas'), /^text\/plain/);
  });
});

// ---- builder + zip -----------------------------------------------------------------------------------------------

describe('pack builder and zip round trip', () => {
  let repo, tmp;
  before(() => { repo = makeRepo(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-zip-')); });
  after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('collectPackFiles: art, fonts, manifests; no dotfiles; sorted', () => {
    const files = collectPackFiles(repo);
    assert.deepEqual(files.map((f) => f[0]), [
      'assets/audio/bgm/menu.mp3', 'assets/char/avatar/char_002_amiya.png', 'assets/spine/char_002_amiya/front.atlas',
      'assets/spine/char_002_amiya/front.skel', 'data/assets.json', 'fonts/bender.woff2', 'fonts/fonts.css',
    ]);
    const idx = packIndex(files, { hash: 'abc123' });
    assert.equal(checkPackIndex(idx), null);
    assert.equal(idx.bytes, files.reduce((s, f) => s + f[2], 0));
  });

  test('crc32 matches the reference value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  test('writeZip → openZip reads every entry back (stored + deflated)', async () => {
    const files = collectPackFiles(repo);
    const out = path.join(tmp, 'p.zip');
    writeZip(out, [{ name: PACK_INDEX, data: Buffer.from(JSON.stringify(packIndex(files, { hash: 'abc123' }))) }, ...files.map(([n, file]) => ({ name: n, file }))]);
    const zip = await openZip(zipBlob(out));
    assert.equal(zip.entries.length, files.length + 1);
    const skel = zip.entries.find((e) => e.name.endsWith('.skel'));
    assert.equal(skel.method, 8, 'text-like files are deflated');
    assert.ok(skel.csize < skel.size);
    assert.equal(zip.entries.find((e) => e.name.endsWith('.png')).method, 0, 'images are stored');
    for (const [name, file] of files) {
      const got = Buffer.from(await (await zip.read(zip.entries.find((e) => e.name === name))).arrayBuffer());
      assert.ok(got.equals(fs.readFileSync(file)), name);
    }
    assert.equal(JSON.parse(await readEntryText(zip, PACK_INDEX)).hash, 'abc123');
    if (spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0) {
      const t = spawnSync('unzip', ['-t', out], { encoding: 'utf8' });
      assert.equal(t.status, 0, t.stdout + t.stderr);
    }
  });

  test('zips from other tools (Info-ZIP, streamed with data descriptors) read too', { skip: spawnSync('zip', ['-v']).status !== 0 }, async () => {
    const a = path.join(tmp, 'a.zip');
    assert.equal(spawnSync('zip', ['-qr', a, 'public', 'data'], { cwd: repo }).status, 0);
    const za = await openZip(zipBlob(a));
    assert.equal(await readEntryText(za, 'public/fonts/fonts.css'), fs.readFileSync(path.join(repo, 'public/fonts/fonts.css'), 'utf8'));
    // `zip -` writes to a pipe: sizes only in data descriptors after each entry
    const piped = spawnSync('zip', ['-qr', '-', 'public'], { cwd: repo, maxBuffer: 1 << 26 });
    const b = path.join(tmp, 'b.zip');
    fs.writeFileSync(b, piped.stdout);
    const zb = await openZip(zipBlob(b));
    const skel = await zb.read(zb.entries.find((e) => e.name.endsWith('front.skel')));
    assert.equal(await skel.text(), fs.readFileSync(path.join(repo, 'public/assets/spine/char_002_amiya/front.skel'), 'utf8'));
  });

  test('a truncated or foreign file is refused with a clear message', async () => {
    await assert.rejects(openZip(new Blob([Buffer.from('not a zip at all, sorry')])), /不是 zip/);
    const out = path.join(tmp, 't.zip');
    writeZip(out, [{ name: 'assets/a.png', data: crypto.randomBytes(2000) }]);
    const buf = fs.readFileSync(out);
    const cut = Buffer.concat([buf.subarray(0, 1000), buf.subarray(buf.length - 200)]);
    await assert.rejects(async () => { const z = await openZip(new Blob([cut])); await z.read(z.entries[0]); }, /不完整|损坏|不是 zip/);
  });

  test('writeDir: web directory with pack.json; stale files of an older pack are removed', () => {
    const files = collectPackFiles(repo);
    const dir = path.join(tmp, 'web');
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'old.png'), 'x');
    fs.writeFileSync(path.join(dir, 'index.html'), 'keep me');
    writeDir(dir, files, packIndex(files, { hash: 'abc123' }), { link: true });
    assert.ok(!fs.existsSync(path.join(dir, 'assets', 'old.png')));
    assert.ok(fs.existsSync(path.join(dir, 'index.html')), 'files outside assets/ fonts/ data/ are left alone');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, PACK_INDEX), 'utf8')).files.length, files.length);
    assert.ok(fs.readFileSync(path.join(dir, 'fonts', 'fonts.css')).equals(fs.readFileSync(path.join(repo, 'public/fonts/fonts.css'))));
  });
});

// ---- importer ----------------------------------------------------------------------------------------------------

describe('browser importer (Cache Storage)', () => {
  let repo, tmp, files, zipPath, webDir;
  before(() => {
    repo = makeRepo();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-imp-'));
    files = collectPackFiles(repo);
    zipPath = path.join(tmp, 'pack.zip');
    const idx = packIndex(files, { hash: 'abc123' });
    writeZip(zipPath, [{ name: PACK_INDEX, data: Buffer.from(JSON.stringify(idx)) }, ...files.map(([n, file]) => ({ name: n, file }))]);
    webDir = path.join(tmp, 'web');
    writeDir(webDir, files, idx);
  });
  after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('importBlob: every file under its site URL with a content type, metadata last', async () => {
    const caches = fakeCaches();
    const store = createPackStore({ caches, origin: ORIGIN });
    assert.equal(await store.status(), null);
    const seen = [];
    const meta = await store.importBlob(zipBlob(zipPath), { onProgress: (p) => seen.push(p.phase) });
    assert.equal(meta.complete, true);
    assert.equal(meta.hash, 'abc123');
    assert.equal(meta.files, files.length);
    assert.ok(seen.includes('store'));
    const cache = caches.stores.get(PACK_CACHE);
    const png = await cache.match(`${ORIGIN}/assets/char/avatar/char_002_amiya.png`);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await png.arrayBuffer()).equals(fs.readFileSync(path.join(repo, 'public/assets/char/avatar/char_002_amiya.png'))));
    assert.ok(await cache.match(`${ORIGIN}/fonts/fonts.css`));
    assert.ok(await cache.match(`${ORIGIN}/data/assets.json`));
    assert.ok(!(await cache.match(`${ORIGIN}/pack.json`)), 'pack.json itself is not served');
    assert.deepEqual((await store.status()).hash, 'abc123');
    await store.clear();
    assert.equal(await store.status(), null);
  });

  test('importBlob: the upstream release-bundle zip is imported as is (only the art)', async () => {
    const bundle = path.join(tmp, 'bundle.zip');
    const entries = [
      { name: 'Stronghold-Protocol/server/index.js', data: Buffer.from('// code') },
      { name: 'Stronghold-Protocol/data/chess.json', data: Buffer.from('{}') },
      { name: 'Stronghold-Protocol/node_modules/x/assets/y.png', data: Buffer.from('nope') },
      ...files.map(([n, file]) => ({ name: `Stronghold-Protocol/${n.startsWith('data/') ? n : 'public/' + n}`, file })),
    ];
    writeZip(bundle, entries);
    const caches = fakeCaches();
    const meta = await createPackStore({ caches, origin: ORIGIN }).importBlob(zipBlob(bundle));
    assert.equal(meta.layout, 'release');
    assert.equal(meta.hash, 'abc123', 'hash read from the bundled data/assets.json');
    const keys = (await caches.stores.get(PACK_CACHE).keys()).filter((k) => !k.endsWith(META_PATH)).sort();
    assert.deepEqual(keys, files.map(([n]) => `${ORIGIN}/${n}`).sort());
  });

  test('importBlob: a zip without art is refused and nothing is installed', async () => {
    const z = path.join(tmp, 'other.zip');
    writeZip(z, [{ name: 'photos/cat.png', data: crypto.randomBytes(100) }]);
    const caches = fakeCaches();
    const store = createPackStore({ caches, origin: ORIGIN });
    await assert.rejects(store.importBlob(zipBlob(z)), /不是素材包/);
    assert.equal(await store.status(), null);
  });

  /** fetch over the web directory; `failOnce` names a file whose first download fails. */
  function dirFetch(failOnce) {
    const calls = [];
    let failed = false;
    const fn = async (url) => {
      const u = new URL(url);
      calls.push(u.pathname);
      if (!u.pathname.startsWith('/pack/')) return new Response('nope', { status: 404 });
      const rel = decodeURIComponent(u.pathname.slice('/pack/'.length));
      if (failOnce && rel === failOnce && !failed) { failed = true; return new Response('gone', { status: 404 }); }
      const p = path.join(webDir, ...rel.split('/'));
      if (!fs.existsSync(p)) return new Response('nope', { status: 404 });
      const buf = fs.readFileSync(p);
      return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
    };
    return { fn, calls };
  }

  test('importUrl (directory): downloads every file listed in pack.json; a stopped import resumes', async () => {
    const caches = fakeCaches();
    const first = dirFetch('assets/spine/char_002_amiya/front.skel');
    const store1 = createPackStore({ caches, origin: ORIGIN, fetch: first.fn, wait: async () => {} });
    await assert.rejects(store1.importUrl('/pack'), /HTTP 404/);
    const partial = await store1.status();
    assert.equal(partial.complete, false, 'not installed until every file landed');
    const second = dirFetch(null);
    const store2 = createPackStore({ caches, origin: ORIGIN, fetch: second.fn, wait: async () => {} });
    const meta = await store2.importUrl(`${ORIGIN}/pack/`);
    assert.equal(meta.complete, true);
    assert.equal(meta.files, files.length);
    assert.equal(meta.source, `${ORIGIN}/pack/`);
    const fetched = second.calls.filter((p) => p !== '/pack/pack.json');
    assert.ok(fetched.length < files.length, `resumed: ${fetched.length} of ${files.length} downloaded again`);
    assert.ok(fetched.includes('/pack/assets/spine/char_002_amiya/front.skel'));
  });

  test('importUrl (zip URL) and a bad pack.json', async () => {
    const caches = fakeCaches();
    const buf = fs.readFileSync(zipPath);
    const fetchZip = async () => new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
    const phases = new Set();
    const meta = await createPackStore({ caches, origin: ORIGIN, fetch: fetchZip }).importUrl('https://cdn.test/sp/pack.zip', { onProgress: (p) => phases.add(p.phase) });
    assert.equal(meta.complete, true);
    assert.ok(phases.has('download') && phases.has('store'));
    const bad = async () => new Response(JSON.stringify({ format: 'nope' }), { status: 200 });
    await assert.rejects(createPackStore({ caches: fakeCaches(), origin: ORIGIN, fetch: bad }).importUrl('https://x.test/dir/'), /format/);
  });

  test('importUrl honours an abort signal', async () => {
    const ac = new AbortController();
    const d = dirFetch(null);
    const slow = async (url, init) => { ac.abort(); if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return d.fn(url); };
    await assert.rejects(createPackStore({ caches: fakeCaches(), origin: ORIGIN, fetch: slow }).importUrl('/pack/', { signal: ac.signal }), { name: 'AbortError' });
  });
});

// ---- gate decision -----------------------------------------------------------------------------------------------

test('boot gate: import only when the server keeps no art and this browser has no complete pack', () => {
  const client = { assets: 'client' };
  const server = { assets: 'server' };
  const done = { complete: true };
  assert.equal(decideGate({ config: client, status: null, supported: true, force: false, skipped: false }), 'import');
  assert.equal(decideGate({ config: client, status: { complete: false }, supported: true, force: false, skipped: false }), 'import');
  assert.equal(decideGate({ config: client, status: done, supported: true, force: false, skipped: false }), 'boot');
  assert.equal(decideGate({ config: client, status: null, supported: true, force: false, skipped: true }), 'boot', '先不导入 is remembered');
  assert.equal(decideGate({ config: client, status: null, supported: false, force: false, skipped: false }), 'unsupported', 'plain http');
  assert.equal(decideGate({ config: server, status: null, supported: true, force: false, skipped: false }), 'boot', 'classic server: unchanged');
  assert.equal(decideGate({ config: server, status: null, supported: false, force: false, skipped: false }), 'boot');
  assert.equal(decideGate({ config: server, status: done, supported: true, force: true, skipped: false }), 'manage', '?assets');
  assert.equal(decideGate({ config: null, status: null, supported: true, force: false, skipped: false }), 'boot', 'older server');
  assert.deepEqual(normaliseSources(['/pack/', { url: '/pack/', label: 'dup' }, { url: 'https://a/x.zip', label: 'A' }, 3, null]),
    [{ url: '/pack/', label: '/pack/' }, { url: 'https://a/x.zip', label: 'A' }]);
});

// ---- service worker ----------------------------------------------------------------------------------------------

describe('service worker (public/sw.js)', () => {
  /** Load sw.js into a sandbox; returns a dispatcher for fetch events. */
  function loadWorker(caches, net) {
    const listeners = {};
    const self = {
      location: new URL(`${ORIGIN}/sw.js`),
      addEventListener: (t, fn) => { listeners[t] = fn; },
      skipWaiting() {}, clients: { claim: async () => {} },
    };
    const ctx = vm.createContext({ self, caches, fetch: net, URL, Response, Blob, console });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8'), ctx);
    return async (url, { method = 'GET', headers = {} } = {}) => {
      let responded = null;
      listeners.fetch({ request: new Request(url, { method, headers }), respondWith: (p) => { responded = p; } });
      return responded ? await responded : null;
    };
  }

  test('serves stored pack files (query ignored), falls back to the network, ignores everything else', async () => {
    const caches = fakeCaches();
    const cache = await caches.open(PACK_CACHE);
    await cache.put(`${ORIGIN}/assets/a.png`, new Response(Buffer.from('0123456789'), { headers: { 'Content-Type': 'image/png' } }));
    const net = async (req) => new Response(`net:${new URL(req.url).pathname}`, { status: 200 });
    const send = loadWorker(caches, net);
    const hit = await send(`${ORIGIN}/assets/a.png?v=3`);
    assert.equal(await hit.text(), '0123456789');
    const miss = await send(`${ORIGIN}/assets/b.png`);
    assert.equal(await miss.text(), 'net:/assets/b.png', 'not imported → the server (SP_ASSETS=server keeps working)');
    assert.equal(await send(`${ORIGIN}/data/chess.json`), null, 'game data is never intercepted');
    assert.equal(await send(`${ORIGIN}/js/main.js`), null);
    assert.equal(await send(`https://elsewhere.test/assets/a.png`), null, 'other origins untouched');
    assert.equal(await send(`${ORIGIN}/assets/a.png`, { method: 'POST' }), null);
  });

  test('byte ranges: 206 with Content-Range, suffix ranges, 416 past the end', async () => {
    const caches = fakeCaches();
    const cache = await caches.open(PACK_CACHE);
    await cache.put(`${ORIGIN}/assets/s.mp3`, new Response(Buffer.from('0123456789'), { headers: { 'Content-Type': 'audio/mpeg' } }));
    const send = loadWorker(caches, async () => new Response('net'));
    const r = await send(`${ORIGIN}/assets/s.mp3`, { headers: { range: 'bytes=2-5' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await r.text(), '2345');
    const tail = await send(`${ORIGIN}/assets/s.mp3`, { headers: { range: 'bytes=-3' } });
    assert.equal(await tail.text(), '789');
    const open = await send(`${ORIGIN}/assets/s.mp3`, { headers: { range: 'bytes=7-' } });
    assert.equal(await open.text(), '789');
    assert.equal((await send(`${ORIGIN}/assets/s.mp3`, { headers: { range: 'bytes=20-' } })).status, 416);
    assert.equal((await send(`${ORIGIN}/assets/s.mp3`, { headers: { range: 'bytes=0-1,4-5' } })).status, 200, 'multi-range → whole body');
  });

  test('sw.js and shared/assetPack.js agree on the pack paths', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
    const m = /var PACK_PATH_RE = (\/.+\/);/.exec(src);
    const shared = fs.readFileSync(path.join(ROOT, 'shared', 'assetPack.js'), 'utf8');
    assert.ok(m && shared.includes(`PACK_PATH_RE = ${m[1]};`), 'same regular expression');
    assert.match(src, new RegExp(`PACK_CACHE = '${PACK_CACHE}'`));
  });
});

// ---- server ------------------------------------------------------------------------------------------------------

describe('server: SP_ASSETS / SP_ASSET_URL / client-config.json', () => {
  test('resolveAssetsMode: explicit values, auto by public/assets contents', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mode-'));
    try {
      assert.equal(resolveAssetsMode('client', dir), 'client');
      assert.equal(resolveAssetsMode('SERVER', dir), 'server');
      assert.equal(resolveAssetsMode(undefined, dir), 'client', 'no public/assets → client');
      fs.mkdirSync(path.join(dir, 'assets'));
      fs.writeFileSync(path.join(dir, 'assets', '.keep'), '');
      assert.equal(resolveAssetsMode('auto', dir), 'client', 'only dotfiles → still empty');
      fs.writeFileSync(path.join(dir, 'assets', 'a.png'), 'x');
      assert.equal(resolveAssetsMode('', dir), 'server');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parseAssetSources: urls, site paths, labels; junk dropped', () => {
    assert.deepEqual(parseAssetSources('/pack/ , https://cdn.test/sp/pack.zip\n本站=/pack2/ javascript:alert(1) //evil ftp://x'), [
      { url: '/pack/', label: '/pack/' },
      { url: 'https://cdn.test/sp/pack.zip', label: 'https://cdn.test/sp/pack.zip' },
      { url: '/pack2/', label: '本站' },
    ]);
    assert.deepEqual(parseAssetSources('https://x.test/a?b=c'), [{ url: 'https://x.test/a?b=c', label: 'https://x.test/a?b=c' }]);
    assert.deepEqual(parseAssetSources(undefined), []);
  });

  let srv;
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assets: 'client', assetSources: [{ url: '/pack/', label: '本站' }] });
  });
  after(async () => { await srv?.close(); });

  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: p, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });

  test('GET /client-config.json, /healthz and /sw.js', async () => {
    const r = await get('/client-config.json');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    const cfg = JSON.parse(r.body);
    assert.equal(cfg.assets, 'client');
    assert.deepEqual(cfg.sources, [{ url: '/pack/', label: '本站' }]);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));
    assert.equal(cfg.hash, manifest.hash);
    assert.equal(JSON.parse((await get('/healthz')).body).assets, 'client');
    const sw = await get('/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers['content-type'], /javascript/);
    assert.equal(sw.headers['cache-control'], 'no-cache', 'the worker is revalidated on every check');
  });
});
