// tools/fetch-local-art.mjs: this fork's Cloudflare build copies the local-client art from a site that extracted it, and
// the site's other files our data/assets.json does not list (fetchSiteExtras).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchFromSite, fetchLocalArt, fetchSiteExtras, listedAssets, localArtPath, sitePath } from '../../tools/fetch-local-art.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sha = (b) => createHash('sha256').update(b).digest('hex');
const A = Buffer.from('board atlas'), B = Buffer.from('hud frame');
const LOCAL = { version: 1, source: 'local-client', count: 2, groups: { map: { a: { path: '/assets/local/map/a.png' } }, ui: { b: { path: '/assets/local/ui/b%20c.png' } } } };

function site(files, { corrupt = null } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const u = new URL(url).pathname;
    if (u === '/data/local-assets.json') return Response.json(LOCAL);
    if (u === '/resource-manifest.json') return Response.json({ format: 1, files: [
      { url: '/assets/char/x.png', size: 1, sha256: '0'.repeat(64) },
      ...Object.entries(files).map(([url, buf]) => ({ url, size: buf.length, sha256: sha(buf) })),
    ] });
    const buf = files[u];
    if (!buf) return new Response('missing', { status: 404 });
    return new Response(u === corrupt ? Buffer.from('tampered!!!') : buf);
  };
  return { fetchFn, calls };
}

async function tmpRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-local-art-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('localArtPath accepts only safe /assets/local/ paths', () => {
  assert.deepEqual(localArtPath('/assets/local/ui/b%20c.png'), ['assets', 'local', 'ui', 'b c.png']);
  assert.equal(localArtPath('/assets/char/x.png'), null);
  assert.equal(localArtPath('/assets/local/../x.png'), null);
  assert.equal(localArtPath('/assets/local/%2e%2e/x.png'), null);
  assert.equal(localArtPath('/assets/local/a%5Cb.png'), null);
});

test('copies every /assets/local/ file with its manifest; a second run reuses intact files', async (t) => {
  const root = await tmpRoot(t);
  const files = { '/assets/local/map/a.png': A, '/assets/local/ui/b%20c.png': B };
  const { fetchFn, calls } = site(files);
  const r = await fetchLocalArt({ root, from: 'https://art.example/any', fetchFn, log: () => {} });
  assert.equal(r.status, 'fetched');
  assert.equal(r.files, 2);
  assert.deepEqual(await fs.readFile(path.join(root, 'public/assets/local/map/a.png')), A);
  assert.deepEqual(await fs.readFile(path.join(root, 'public/assets/local/ui/b c.png')), B);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'public/data/local-assets.json'), 'utf8'));
  assert.equal(manifest.fetchedFrom, 'https://art.example');
  assert.deepEqual(manifest.groups, LOCAL.groups);
  await assert.rejects(fs.access(path.join(root, 'data/local-assets.json')), 'data/ (hashed into the rules version) stays untouched');
  assert.ok(!calls.some((u) => u.endsWith('/assets/char/x.png')), 'only local art');
  calls.length = 0;
  assert.equal((await fetchLocalArt({ root, from: 'https://art.example', fetchFn, log: () => {} })).status, 'fetched');
  assert.deepEqual(calls.filter((u) => u.includes('/assets/local/')), [], 'nothing downloaded again');
});

test('a corrupt file fetches nothing and keeps the previous art', async (t) => {
  const root = await tmpRoot(t);
  const files = { '/assets/local/map/a.png': A, '/assets/local/ui/b%20c.png': B };
  assert.equal((await fetchLocalArt({ root, from: 'https://art.example', fetchFn: site(files).fetchFn, log: () => {} })).status, 'fetched');
  const changed = { '/assets/local/map/a.png': Buffer.from('new atlas'), '/assets/local/ui/b%20c.png': B };
  const r = await fetchLocalArt({ root, from: 'https://art.example', fetchFn: site(changed, { corrupt: '/assets/local/map/a.png' }).fetchFn, log: () => {} });
  assert.equal(r.status, 'failed');
  assert.deepEqual(await fs.readFile(path.join(root, 'public/assets/local/map/a.png')), A, 'previous art kept');
  await assert.rejects(fs.access(path.join(root, 'public/assets/.local-art-incoming')), 'no staging left behind');
});

test('a fresh build whose source is down gets no local art (the 2D board)', async (t) => {
  const root = await tmpRoot(t);
  const r = await fetchLocalArt({ root, from: 'https://art.example', fetchFn: async () => new Response('down', { status: 503 }), log: () => {} });
  assert.equal(r.status, 'failed');
  await assert.rejects(fs.access(path.join(root, 'public/assets/local')));
  await assert.rejects(fs.access(path.join(root, 'public/data/local-assets.json')));
});

test('a machine with its own client extraction is left alone', async (t) => {
  const root = await tmpRoot(t);
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data/local-assets.json'), JSON.stringify(LOCAL));
  const { fetchFn, calls } = site({ '/assets/local/map/a.png': A });
  assert.equal((await fetchLocalArt({ root, from: 'https://art.example', fetchFn, log: () => {} })).status, 'own');
  assert.equal(calls.length, 0);
});

// ---- the site's files beyond data/assets.json ----------------------------------------------------------------------

const BGM = Buffer.from('a new bgm'), FONT = Buffer.from('a font'), FACE = Buffer.from('emoticon'), LISTED = Buffer.from('mirror file');
const EXTRAS = {
  '/assets/audio/bgm/m_new.mp3': BGM,
  '/assets/ui/emoticon/basic/pic%20happy.png': FACE,
  '/fonts/extra.woff2': FONT,
  '/assets/char/listed.png': LISTED,      // data/assets.json lists it: tools/fetch-assets.mjs downloads it
  '/assets/local/map/a.png': A,           // local art: fetchLocalArt's
};

// site() also lists /assets/char/x.png, which no site serves: a listed file, never asked for
async function withAssetList(t, list = { chars: { c: { avatar: '/assets/char/listed.png', portrait: '/assets/char/x.png' } }, fonts: { f: '/fonts/listed.woff2' } }) {
  const root = await tmpRoot(t);
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data/assets.json'), JSON.stringify(list));
  return root;
}

async function walkFiles(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(p, out); else out.push(p);
  }
  return out;
}

test('sitePath accepts only safe /assets/ and /fonts/ paths', () => {
  assert.deepEqual(sitePath('/assets/ui/emoticon/basic/pic%20happy.png'), ['assets', 'ui', 'emoticon', 'basic', 'pic happy.png']);
  assert.deepEqual(sitePath('/fonts/extra.woff2'), ['fonts', 'extra.woff2']);
  assert.deepEqual(sitePath('/assets/local/map/fx/%5Bopt%5Dmerged.png'), ['assets', 'local', 'map', 'fx', '[opt]merged.png']);
  for (const bad of ['/data/assets.json', '/js/main.js', '/assets/../x.png', '/assets/%2e%2e/x.png', '/assets/a%2Fb.png',
    '/assets/a%5Cb.png', '/assets/.hidden.png', '/assets//x.png', '/assets/%E0%A4%A.png', '/assets/a%00.png', null]) {
    assert.equal(sitePath(bad), null, String(bad));
  }
});

test('listedAssets: every /assets and /fonts path of data/assets.json, decoded; null without one', async (t) => {
  const root = await withAssetList(t, { a: ['/assets/x%20y.png', 'not a path'], b: { c: { d: '/fonts/f.woff2', e: '/data/z.json' } } });
  assert.deepEqual([...await listedAssets(root)].sort(), ['/assets/x y.png', '/fonts/f.woff2']);
  assert.equal(await listedAssets(await tmpRoot(t)), null);
});

test('copies the site\'s files data/assets.json does not list; never the listed ones, the local art or a file on disk', async (t) => {
  const root = await withAssetList(t);
  const mine = Buffer.from('this machine\'s own copy');
  await fs.mkdir(path.join(root, 'public/fonts'), { recursive: true });
  await fs.writeFile(path.join(root, 'public/fonts/extra.woff2'), mine);
  const { fetchFn, calls } = site(EXTRAS);
  const r = await fetchSiteExtras({ root, from: 'https://art.example/x', fetchFn, log: () => {} });
  assert.equal(r.status, 'fetched');
  assert.equal(r.files, 2);
  assert.equal(r.bytes, BGM.length + FACE.length);
  assert.equal(r.kept, 1, 'a different file of that path on disk is kept');
  assert.deepEqual(await fs.readFile(path.join(root, 'public/assets/audio/bgm/m_new.mp3')), BGM);
  assert.deepEqual(await fs.readFile(path.join(root, 'public/assets/ui/emoticon/basic/pic happy.png')), FACE);
  assert.deepEqual(await fs.readFile(path.join(root, 'public/fonts/extra.woff2')), mine, 'never replaced');
  await assert.rejects(fs.access(path.join(root, 'public/assets/char/listed.png')), 'the listed file is tools/fetch-assets.mjs\'s');
  await assert.rejects(fs.access(path.join(root, 'public/assets/local')), 'local art is fetchLocalArt\'s (all or nothing)');
  assert.deepEqual(calls.filter((u) => !u.endsWith('/resource-manifest.json')).sort(),
    ['https://art.example/assets/audio/bgm/m_new.mp3', 'https://art.example/assets/ui/emoticon/basic/pic%20happy.png']);
  calls.length = 0;
  const again = await fetchSiteExtras({ root, from: 'https://art.example', fetchFn, log: () => {} });
  assert.equal(again.files, 0);
  assert.deepEqual(calls, ['https://art.example/resource-manifest.json'], 'nothing downloaded again');
});

test('a corrupt or missing file is skipped and reported; the others are kept; no partial file is left', async (t) => {
  const root = await withAssetList(t);
  const files = { ...EXTRAS };
  const { fetchFn } = site(files, { corrupt: '/assets/audio/bgm/m_new.mp3' });
  const logs = [];
  const r = await fetchSiteExtras({ root, from: 'https://art.example', fetchFn: async (url) => {
    if (url.endsWith('/fonts/extra.woff2')) return new Response('gone', { status: 404 });
    return fetchFn(url);
  }, log: (m) => logs.push(m) });
  assert.equal(r.status, 'partial');
  assert.equal(r.files, 1);
  assert.equal(r.failed.length, 2);
  assert.deepEqual(await fs.readFile(path.join(root, 'public/assets/ui/emoticon/basic/pic happy.png')), FACE);
  await assert.rejects(fs.access(path.join(root, 'public/assets/audio/bgm/m_new.mp3')));
  await assert.rejects(fs.access(path.join(root, 'public/fonts/extra.woff2')));
  const left = (await walkFiles(path.join(root, 'public'))).filter((p) => path.basename(p).startsWith('.'));
  assert.deepEqual(left, [], 'no .incoming files');
  assert.ok(logs.some((m) => /2 file\(s\) NOT copied/.test(m)));
});

test('without data/assets.json nothing is fetched (every file would otherwise come from the site)', async (t) => {
  const root = await tmpRoot(t);
  const { fetchFn, calls } = site(EXTRAS);
  assert.equal((await fetchSiteExtras({ root, from: 'https://art.example', fetchFn, log: () => {} })).status, 'skipped');
  assert.equal(calls.length, 0);
});

test('a site that is down: reported, the build goes on with its own asset list', async (t) => {
  const root = await withAssetList(t);
  const r = await fetchSiteExtras({ root, from: 'https://art.example', fetchFn: async () => new Response('down', { status: 503 }), log: () => {} });
  assert.equal(r.status, 'failed');
  await assert.rejects(fs.access(path.join(root, 'public')));
});

test('unsafe or malformed manifest entries are skipped, not written', async (t) => {
  const root = await withAssetList(t);
  const fetchFn = async (url) => {
    const u = new URL(url).pathname;
    if (u === '/resource-manifest.json') return Response.json({ format: 1, files: [
      { url: '/assets/%2e%2e/escape.png', size: 1, sha256: sha(Buffer.from('x')) },
      { url: '/assets/ok.png', size: 'big', sha256: sha(Buffer.from('x')) },
      { url: '/assets/.hidden.png', size: 1, sha256: sha(Buffer.from('x')) },
      { url: '/index.html', size: 1, sha256: sha(Buffer.from('x')) },
    ] });
    return new Response('x');
  };
  const logs = [];
  const r = await fetchSiteExtras({ root, from: 'https://art.example', fetchFn, log: (m) => logs.push(m) });
  assert.equal(r.status, 'fetched');
  assert.equal(r.files, 0);
  assert.ok(logs.some((m) => /3 unsafe entries skipped/.test(m)));
  assert.deepEqual(await walkFiles(path.join(root, 'public')), []);
});

test('the build step reads the site\'s resource manifest once for the local art and the extras', async (t) => {
  const root = await withAssetList(t);
  const { fetchFn, calls } = site(EXTRAS);
  const r = await fetchFromSite({ root, from: 'https://art.example', fetchFn, log: () => {} });
  assert.equal(r.art.status, 'fetched');
  assert.equal(r.extras.status, 'fetched');
  assert.equal(r.extras.files, 3);
  assert.equal(calls.filter((u) => u.endsWith('/resource-manifest.json')).length, 1);
  assert.deepEqual(await fs.readFile(path.join(root, 'public/assets/local/map/a.png')), A);
  assert.deepEqual(await fs.readFile(path.join(root, 'public/fonts/extra.woff2')), FONT);
});

test('review regression: a failed local-art file stops the other downloads before the staging folder goes', async (t) => {
  // Before: the other workers kept writing after the folder was removed and brought it back; buildResourceManifest lists
  // dot folders, so their files reached the manifest and the ZIP as URLs the site does not serve.
  const root = await tmpRoot(t);
  const files = { '/assets/local/a/0-missing.png': Buffer.from('gone') };
  for (let i = 1; i <= 80; i++) files[`/assets/local/a/${i}.png`] = Buffer.from(`tile ${i}`);
  const { fetchFn } = site(files);
  const asked = [];
  const slow = async (url) => {
    const u = new URL(url).pathname;
    if (u.startsWith('/assets/')) asked.push(u);
    if (u === '/assets/local/a/0-missing.png') return new Response('gone', { status: 404 });
    if (u.startsWith('/assets/')) await sleep(15);
    return fetchFn(url);
  };
  const r = await fetchLocalArt({ root, from: 'https://art.example', fetchFn: slow, concurrency: 4, log: () => {} });
  assert.equal(r.status, 'failed');
  await sleep(200); // a worker still running would write now
  await assert.rejects(fs.access(path.join(root, 'public/assets/.local-art-incoming')), 'no staging folder comes back');
  assert.equal(asked.filter((u) => u.endsWith('0-missing.png')).length, 1, 'a 404 is not asked again');
  assert.ok(asked.length < 20, `the others stopped (${asked.length} of 81 asked)`);
});

test('a listed path is matched in its decoded form ([opt], spaces): neither asked for nor written', async (t) => {
  const root = await withAssetList(t, { ui: { a: '/assets/ui/a b.png', fx: '/assets/map/fx/[opt]merged.png', x: '/assets/char/x.png' } });
  const files = { '/assets/ui/a%20b.png': Buffer.from('listed 1'), '/assets/map/fx/%5Bopt%5Dmerged.png': Buffer.from('listed 2'),
    '/assets/ui/c%20d.png': Buffer.from('extra') };
  const { fetchFn, calls } = site(files);
  const r = await fetchSiteExtras({ root, from: 'https://art.example', fetchFn, log: () => {} });
  assert.equal(r.files, 1);
  assert.deepEqual(calls.filter((u) => !u.endsWith('/resource-manifest.json')), ['https://art.example/assets/ui/c%20d.png']);
  assert.deepEqual((await walkFiles(path.join(root, 'public'))).map((p) => path.relative(root, p)), [path.join('public', 'assets', 'ui', 'c d.png')]);
});

test('a file that cannot be written is reported and leaves no partial file', async (t) => {
  const root = await withAssetList(t);
  await fs.mkdir(path.join(root, 'public/assets/audio/bgm/m_new.mp3/inside'), { recursive: true }); // a folder in the way
  const r = await fetchSiteExtras({ root, from: 'https://art.example', fetchFn: site(EXTRAS).fetchFn, log: () => {} });
  assert.equal(r.status, 'partial');
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0], /m_new\.mp3/);
  assert.equal(r.files, 2);
  const dots = (await walkFiles(path.join(root, 'public'))).filter((p) => path.basename(p).startsWith('.'));
  assert.deepEqual(dots, [], 'the .incoming file was removed');
});

test('the time budget: out of time, the extras copied so far are kept and the rest reported', async (t) => {
  const root = await withAssetList(t);
  const files = {};
  for (let i = 0; i < 40; i++) files[`/assets/ui/extra/${i}.png`] = Buffer.from(`extra ${i}`);
  const { fetchFn } = site(files);
  const slow = async (url, opts) => { if (new URL(url).pathname.startsWith('/assets/')) await sleep(25); return fetchFn(url, opts); };
  const r = await fetchSiteExtras({ root, from: 'https://art.example', fetchFn: slow, concurrency: 2, log: () => {}, signal: AbortSignal.timeout(120) });
  assert.equal(r.status, 'partial');
  assert.ok(r.files > 0 && r.files < 40, `${r.files} copied in time`);
  assert.equal(r.files + r.failed.length, 40, 'every other file reported');
  assert.ok(r.failed.every((m) => /out of time/.test(m)));
  assert.equal((await walkFiles(path.join(root, 'public'))).length, r.files);
});
