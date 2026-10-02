#!/usr/bin/env node
// tools/pack-assets.mjs — build the art/audio pack players import into their browsers (docs/DEPLOY.md「素材与服务器分离」,
// shared/assetPack.js has the format). Run it on any machine that has the art (`node tools/setup.mjs` first), then
// hand the zip to your friends or put the directory on any static web host (/pack/ of the Caddy deploy, object storage,
// a CDN …) and list it in SP_ASSET_URL.
//
//   node tools/pack-assets.mjs [--zip <file.zip> | --no-zip] [--dir <directory>] [--link] [--quiet]
//
//   (default)        dist/stronghold-assets-<hash>.zip
//   --zip <file>     write the zip there instead
//   --no-zip         no zip (with --dir)
//   --dir <dir>      also write a web directory: <dir>/pack.json + assets/ fonts/ data/ (the directory is emptied of
//                    files the pack no longer lists; a resumable download source for the browser importer)
//   --link           --dir: hard-link the files instead of copying them (same file system; no extra disk space)
//
// Sources: public/assets/**, public/fonts/**, data/assets.json, data/local-assets.json (when present).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACK_FORMAT, PACK_VERSION, PACK_INDEX, packRelToSite, formatBytes } from '../shared/assetPack.js';
import { writeZip } from './assets/zipwrite.mjs';
import { APP_VERSION } from '../shared/constants.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, rel, out) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    if (d.name.startsWith('.')) continue;
    const abs = path.join(dir, d.name);
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) walk(abs, r, out);
    else if (d.isFile()) out.push([r, abs]);
  }
  return out;
}

/**
 * Files of the pack: [[pack-relative path, absolute source path, size], …] sorted by path.
 * @param {string} [root] repository root
 */
export function collectPackFiles(root = ROOT) {
  const list = [];
  walk(path.join(root, 'public', 'assets'), 'assets', list);
  walk(path.join(root, 'public', 'fonts'), 'fonts', list);
  for (const f of ['assets.json', 'local-assets.json']) {
    const abs = path.join(root, 'data', f);
    if (fs.existsSync(abs)) list.push([`data/${f}`, abs]);
  }
  return list
    .filter(([rel]) => packRelToSite(rel))
    .map(([rel, abs]) => [rel, abs, fs.statSync(abs).size])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The pack.json object for a file list. */
export function packIndex(files, { hash = null, app = APP_VERSION, createdAt = new Date().toISOString() } = {}) {
  return {
    format: PACK_FORMAT, version: PACK_VERSION, hash, app, createdAt,
    bytes: files.reduce((s, f) => s + f[2], 0),
    files: files.map(([rel, , size]) => [rel, size]),
  };
}

function manifestHash(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'data', 'assets.json'), 'utf8')).hash || null; } catch { return null; }
}

/** Write the web-directory form. */
export function writeDir(dir, files, index, { link = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set(files.map((f) => f[0]));
  // drop files of an older pack (never anything outside the three pack folders)
  for (const top of ['assets', 'fonts', 'data']) {
    for (const [rel, abs] of walk(path.join(dir, top), top, [])) if (!keep.has(rel)) fs.rmSync(abs, { force: true });
  }
  for (const [rel, abs, size] of files) {
    const dst = path.join(dir, ...rel.split('/'));
    try { if (fs.statSync(dst).size === size && !link) continue; } catch { /* missing */ }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.rmSync(dst, { force: true });
    if (link) {
      try { fs.linkSync(abs, dst); continue; } catch { /* other file system: copy */ }
    }
    fs.copyFileSync(abs, dst);
  }
  fs.writeFileSync(path.join(dir, PACK_INDEX), JSON.stringify(index) + '\n');
}

function parseArgs(argv) {
  const o = { zip: undefined, dir: null, link: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zip') o.zip = argv[++i];
    else if (a.startsWith('--zip=')) o.zip = a.slice(6);
    else if (a === '--no-zip') o.zip = null;
    else if (a === '--dir') o.dir = argv[++i];
    else if (a.startsWith('--dir=')) o.dir = a.slice(6);
    else if (a === '--link') o.link = true;
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown option: ${a} (--help)`);
  }
  if (o.zip === null && !o.dir) throw new Error('--no-zip needs --dir');
  return o;
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }
  if (o.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    console.log(src.slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const files = collectPackFiles(ROOT);
  const assets = files.filter((f) => f[0].startsWith('assets/')).length;
  if (!assets) {
    console.error('public/assets 是空的：先运行 node tools/setup.mjs 下载素材。 / no art in public/assets — run node tools/setup.mjs first.');
    return 1;
  }
  const hash = manifestHash(ROOT);
  const index = packIndex(files, { hash });
  const log = o.quiet ? () => {} : (s) => console.log(s);
  log(`素材包 / asset pack: ${files.length} 个文件, ${formatBytes(index.bytes)}, hash ${hash || '?'}`);
  if (o.dir) {
    const dir = path.resolve(o.dir);
    writeDir(dir, files, index, { link: o.link });
    log(`  目录 / directory: ${dir}  (SP_ASSET_URL 指向它的网址，末尾带 /)`);
  }
  if (o.zip !== null) {
    const out = path.resolve(o.zip || path.join(ROOT, 'dist', `stronghold-assets-${hash || 'pack'}.zip`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const entries = [{ name: PACK_INDEX, data: Buffer.from(JSON.stringify(index) + '\n') }, ...files.map(([rel, abs]) => ({ name: rel, file: abs }))];
    const r = writeZip(out + '.tmp', entries);
    fs.renameSync(out + '.tmp', out);
    log(`  zip: ${out}  (${formatBytes(r.bytes)})`);
  }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
