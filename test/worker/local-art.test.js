// tools/fetch-local-art.mjs: this fork's Cloudflare build copies the local-client art from a site that extracted it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchLocalArt, localArtPath } from '../../tools/fetch-local-art.mjs';

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
