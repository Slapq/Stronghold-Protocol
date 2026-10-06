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
// The same site's other files come along too (fetchSiteExtras): every /assets/… and /fonts/… file of its resource
// manifest that our data/assets.json does not list, except /assets/local/ (the local art above, all or nothing) — the
// files its own deploy machine carries beyond what this fork's tools/fetch-assets.mjs downloads (more UI art,
// emoticons, 玩法说明 pages, BGM and sound effects) — so the resource manager and the resource ZIP offer the same files
// as that site. The files data/assets.json lists stay tools/fetch-assets.mjs's (the public mirrors, run by
// tools/build-worker.mjs); a file already on disk is never replaced; each copied file is checked against the manifest's
// SHA-256 and kept on its own (a failed one is reported and skipped, the build goes on).
//
// Both steps share one time budget (SITE_BUDGET_MS): a slow or failing site must not push the build past Workers
// Builds' 20 minutes. Out of time, the local art is not used (all or nothing) and the extras copied so far are kept.
//
// Usage (wrangler.jsonc build command): node tools/fetch-local-art.mjs --from=https://stronghold.lunar.ag
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = '/assets/local/';
const STAGING = '.local-art-incoming'; // under public/assets: copyTree skips dot folders, so it never ships
/** The time both steps may take together on a build (typically ~25 s for ~110 MiB). */
export const SITE_BUDGET_MS = 6 * 60 * 1000;

/** Disk path (relative to public/) of a manifest URL under /assets/local/, or null when it is not a safe one. */
export function localArtPath(url) {
  if (typeof url !== 'string' || !url.startsWith(PREFIX)) return null;
  let parts;
  try { parts = url.slice(1).split('/').map(decodeURIComponent); } catch { return null; }
  if (parts.some((p) => !p || p === '.' || p === '..' || /[\\\0]/.test(p))) return null;
  return parts;
}

/**
 * Disk path (relative to public/) of a manifest URL under /assets/ or /fonts/, or null when it is not a safe one. A name
 * that starts with a dot is refused too: tools/build-worker.mjs never ships one, and this tool's partial files are such.
 */
export function sitePath(url) {
  if (typeof url !== 'string' || !/^\/(assets|fonts)\//.test(url)) return null;
  let parts;
  try { parts = url.slice(1).split('/').map(decodeURIComponent); } catch { return null; }
  if (parts.some((p) => !p || p.startsWith('.') || /[\\/\0]/.test(p))) return null;
  return parts;
}

/** Every /assets/… and /fonts/… path data/assets.json lists, decoded ("/assets/a b.png"); null when there is none. */
export async function listedAssets(root = ROOT) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(root, 'data/assets.json'), 'utf8')); } catch { return null; }
  if (!manifest || typeof manifest !== 'object') return null;
  const urls = new Set();
  const decode = (url) => { try { return url.split('/').map(decodeURIComponent).join('/'); } catch { return url; } };
  (function walk(value) {
    if (typeof value === 'string') { if (/^\/(assets|fonts)\//.test(value)) urls.add(decode(value)); }
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
  })(manifest);
  return urls;
}

async function getJson(fetchFn, url) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** A file the manifest promised and the server says it does not have: asking again will not help. */
const GONE = new Set([404, 410]);

/** One verified file; `signal` (the time budget) ends the attempts. */
async function download(fetchFn, url, expect, { tries = 3, signal = null } = {}) {
  for (let i = 1; ; i++) {
    let gone = false;
    try {
      if (signal?.aborted) throw new Error('out of time');
      const timeout = AbortSignal.timeout(120000);
      const res = await fetchFn(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!res.ok) { gone = GONE.has(res.status); throw new Error(`HTTP ${res.status}`); }
      const buf = Buffer.from(await res.arrayBuffer());
      const sha = createHash('sha256').update(buf).digest('hex');
      if (buf.length !== expect.size || sha !== expect.sha256) throw new Error('size / SHA-256 mismatch');
      return buf;
    } catch (error) {
      if (i >= tries || gone || signal?.aborted) throw new Error(`${url}: ${signal?.aborted ? 'out of time' : error.message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    }
  }
}

/**
 * Copy a site's local-client art into public/assets/local + data/local-assets.json.
 * @returns {Promise<{ status: 'own' | 'fetched' | 'failed', files?: number, bytes?: number, error?: string }>}
 */
export async function fetchLocalArt({ root = ROOT, from, fetchFn = globalThis.fetch, concurrency = 8, log = console.log, resources = null, signal = null } = {}) {
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
  let local;
  try {
    [local, resources] = await Promise.all([getJson(fetchFn, `${origin}/data/local-assets.json`), resources ?? getJson(fetchFn, `${origin}/resource-manifest.json`)]);
    if (!local || typeof local.groups !== 'object' || !Array.isArray(resources?.files)) throw new Error('unexpected manifest format');
    const files = resources.files.filter((f) => typeof f?.url === 'string' && f.url.startsWith(PREFIX));
    for (const f of files) {
      if (!localArtPath(f.url) || !Number.isInteger(f.size) || !/^[0-9a-f]{64}$/.test(f.sha256 || '')) throw new Error(`bad manifest entry ${f.url}`);
    }
    if (!files.length) throw new Error(`${origin} has no local art`);
    await fs.rm(staging, { recursive: true, force: true });
    let next = 0, bytes = 0, failure = null;
    // The first failure stops every worker, and the staging folder is removed only once all of them returned: a worker
    // still writing would bring it back, and its files would reach the resource manifest (it lists dot folders too).
    const worker = async () => {
      while (!failure && next < files.length) {
        const f = files[next++];
        try {
          const rel = localArtPath(f.url).slice(2); // drop 'assets', 'local'
          let buf = null;
          try { // reuse an intact copy from an earlier fetch
            const have = await fs.readFile(path.join(root, 'public/assets/local', ...rel));
            if (have.length === f.size && createHash('sha256').update(have).digest('hex') === f.sha256) buf = have;
          } catch { /* not there */ }
          buf ??= await download(fetchFn, origin + f.url, f, { signal });
          if (failure) return;
          const dest = path.join(staging, ...rel);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, buf);
          bytes += buf.length;
        } catch (error) {
          failure ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
    if (failure) throw failure;
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

/**
 * Copy the site's files that data/assets.json does not list (see the header) into public/assets and public/fonts.
 * @returns {Promise<{ status: 'fetched' | 'partial' | 'skipped' | 'failed', files?: number, bytes?: number,
 *   failed?: string[], kept?: number, error?: string }>} kept: files of that path already on disk with other content
 */
export async function fetchSiteExtras({ root = ROOT, from, fetchFn = globalThis.fetch, concurrency = 8, log = console.log, resources = null, signal = null } = {}) {
  const origin = new URL(from).origin;
  const listed = await listedAssets(root);
  if (!listed) {
    log('site extras: no data/assets.json here — not fetched (it tells which files tools/fetch-assets.mjs downloads)');
    return { status: 'skipped' };
  }
  try {
    resources ??= await getJson(fetchFn, `${origin}/resource-manifest.json`);
    if (!Array.isArray(resources?.files)) throw new Error('unexpected manifest format');
    const wanted = [];
    let unsafe = 0;
    for (const f of resources.files) {
      if (typeof f?.url !== 'string' || f.url.startsWith(PREFIX) || !/^\/(assets|fonts)\//.test(f.url)) continue;
      const parts = sitePath(f.url);
      if (!parts || !Number.isInteger(f.size) || f.size < 0 || !/^[0-9a-f]{64}$/.test(f.sha256 || '')) { unsafe++; continue; }
      if (!listed.has('/' + parts.join('/'))) wanted.push({ ...f, parts });
    }
    let next = 0, files = 0, bytes = 0, kept = 0;
    const failed = [];
    const worker = async () => {
      while (next < wanted.length) {
        const f = wanted[next++];
        if (signal?.aborted) { failed.push(`${origin}${f.url}: out of time`); continue; }
        const dest = path.join(root, 'public', ...f.parts);
        try {
          const have = await fs.readFile(dest);
          if (have.length !== f.size || createHash('sha256').update(have).digest('hex') !== f.sha256) kept++;
          continue; // on disk already: an intact copy, or this machine's own file (never replaced)
        } catch { /* not there */ }
        const partial = path.join(path.dirname(dest), `.${path.basename(dest)}.incoming-${process.pid}`);
        try {
          const buf = await download(fetchFn, origin + f.url, f, { signal });
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(partial, buf);
          await fs.rename(partial, dest);
          files++;
          bytes += buf.length;
        } catch (error) {
          await fs.rm(partial, { force: true }).catch(() => {});
          failed.push(error.message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
    const notes = [unsafe && `${unsafe} unsafe entries skipped`, kept && `${kept} kept as they are here`].filter(Boolean);
    log(`site extras: ${files} files, ${(bytes / 1048576).toFixed(1)} MiB from ${origin} (${wanted.length} not in data/assets.json`
      + `${notes.length ? '; ' + notes.join(', ') : ''})`);
    if (failed.length) log(`site extras: ${failed.length} file(s) NOT copied:\n  ${failed.slice(0, 20).join('\n  ')}`);
    return { status: failed.length ? 'partial' : 'fetched', files, bytes, failed, kept };
  } catch (error) {
    log(`site extras: NOT fetched from ${origin} (${error.message}) — the site offers only its own asset list`);
    return { status: 'failed', error: error.message };
  }
}

/** The build step: the site's local-client art and its extra files, from one read of its resource manifest. */
export async function fetchFromSite({ root = ROOT, from, fetchFn = globalThis.fetch, log = console.log, budgetMs = SITE_BUDGET_MS } = {}) {
  const origin = new URL(from).origin;
  const signal = AbortSignal.timeout(budgetMs);
  let resources = null;
  try { resources = await getJson(fetchFn, `${origin}/resource-manifest.json`); }
  catch { /* each step reports it (and tries once more) */ }
  const art = await fetchLocalArt({ root, from, fetchFn, log, resources, signal });
  const extras = await fetchSiteExtras({ root, from, fetchFn, log, resources, signal });
  return { art, extras };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const from = process.argv.find((a) => a.startsWith('--from='))?.slice(7);
  if (!from) { console.error('usage: node tools/fetch-local-art.mjs --from=https://<site>'); process.exit(2); }
  await fetchFromSite({ from }); // a failure is reported, not fatal: the site works with its own asset list and the 2D board
}
