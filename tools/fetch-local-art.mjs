// The art tools/local-extract pulls from a locally installed Arknights client (public/assets/local/** and its manifest
// /data/local-assets.json: the real board tile atlas, the 3D board's meshes and materials, the autochess UI sprites,
// emoticons, guidebook pages) cannot be extracted on Cloudflare Workers Builds, which has no client. This fork copies it
// from a deployed site that has it: its /data/local-assets.json, and every /assets/local/ file of its
// /resource-manifest.json, each checked against the manifest's SHA-256.
//
// - The manifest goes to public/data/local-assets.json (served as /data/local-assets.json; tools/build-worker.mjs keeps
//   it), not data/: tools/build-replay.mjs hashes data/*.json into the rules version, and a new version would bundle one
//   more replay engine into the Worker.
// - Skipped when this machine has its own extraction (data/local-assets.json).
// - All or nothing: files are downloaded into a staging folder and only replace public/assets/local once every one
//   arrived intact; a failure leaves the previous state (on a fresh build: no local art, the 2D board), is reported and
//   does not fail the build.
//
// Usage (wrangler.jsonc build command): node tools/fetch-local-art.mjs --from=https://stronghold.lunar.ag
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = '/assets/local/';
const STAGING = '.local-art-incoming'; // under public/assets: copyTree skips dot folders, so it never ships

/** Disk path (relative to public/) of a manifest URL under /assets/local/, or null when it is not a safe one. */
export function localArtPath(url) {
  if (typeof url !== 'string' || !url.startsWith(PREFIX)) return null;
  let parts;
  try { parts = url.slice(1).split('/').map(decodeURIComponent); } catch { return null; }
  if (parts.some((p) => !p || p === '.' || p === '..' || /[\\\0]/.test(p))) return null;
  return parts;
}

async function getJson(fetchFn, url) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function download(fetchFn, url, expect, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const sha = createHash('sha256').update(buf).digest('hex');
      if (buf.length !== expect.size || sha !== expect.sha256) throw new Error('size / SHA-256 mismatch');
      return buf;
    } catch (error) {
      if (i >= tries) throw new Error(`${url}: ${error.message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    }
  }
}

/**
 * Copy a site's local-client art into public/assets/local + data/local-assets.json.
 * @returns {Promise<{ status: 'own' | 'fetched' | 'failed', files?: number, bytes?: number, error?: string }>}
 */
export async function fetchLocalArt({ root = ROOT, from, fetchFn = globalThis.fetch, concurrency = 8, log = console.log } = {}) {
  const manifestFile = path.join(root, 'public/data/local-assets.json');
  try {
    const own = JSON.parse(await fs.readFile(path.join(root, 'data/local-assets.json'), 'utf8'));
    if (own && own.source && own.source !== 'none') {
      log('local art: this machine has its own client extraction — not fetched');
      return { status: 'own' };
    }
  } catch { /* none */ }
  const origin = new URL(from).origin;
  const staging = path.join(root, 'public/assets', STAGING);
  try {
    const [local, resources] = await Promise.all([getJson(fetchFn, `${origin}/data/local-assets.json`), getJson(fetchFn, `${origin}/resource-manifest.json`)]);
    if (!local || typeof local.groups !== 'object' || !Array.isArray(resources?.files)) throw new Error('unexpected manifest format');
    const files = resources.files.filter((f) => typeof f?.url === 'string' && f.url.startsWith(PREFIX));
    for (const f of files) {
      if (!localArtPath(f.url) || !Number.isInteger(f.size) || !/^[0-9a-f]{64}$/.test(f.sha256 || '')) throw new Error(`bad manifest entry ${f.url}`);
    }
    if (!files.length) throw new Error(`${origin} has no local art`);
    await fs.rm(staging, { recursive: true, force: true });
    let next = 0, bytes = 0;
    const worker = async () => {
      while (next < files.length) {
        const f = files[next++];
        const rel = localArtPath(f.url).slice(2); // drop 'assets', 'local'
        let buf = null;
        try { // reuse an intact copy from an earlier fetch
          const have = await fs.readFile(path.join(root, 'public/assets/local', ...rel));
          if (have.length === f.size && createHash('sha256').update(have).digest('hex') === f.sha256) buf = have;
        } catch { /* not there */ }
        buf ??= await download(fetchFn, origin + f.url, f);
        const dest = path.join(staging, ...rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buf);
        bytes += buf.length;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
    const target = path.join(root, 'public/assets/local');
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
    await fs.mkdir(path.dirname(manifestFile), { recursive: true });
    await fs.writeFile(manifestFile, JSON.stringify({ ...local, fetchedFrom: origin }));
    log(`local art: ${files.length} files, ${(bytes / 1048576).toFixed(1)} MiB from ${origin}`);
    return { status: 'fetched', files: files.length, bytes };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    log(`local art: NOT fetched from ${origin} (${error.message}) — the site falls back to the 2D board and web-sourced UI art`);
    return { status: 'failed', error: error.message };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const from = process.argv.find((a) => a.startsWith('--from='))?.slice(7);
  if (!from) { console.error('usage: node tools/fetch-local-art.mjs --from=https://<site>'); process.exit(2); }
  await fetchLocalArt({ from }); // a failure is reported, not fatal: the site works with the 2D board
}
