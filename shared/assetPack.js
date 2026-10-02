// shared/assetPack.js — the art/audio pack format (docs/ASSETS.md「素材包」, docs/DEPLOY.md). Pure ESM: imported by the
// browser importer (public/js/assetpack/*), the pack builder (tools/pack-assets.mjs) and the tests.
//
// The game art is © Hypergryph / Yostar and never has to live on the game server: a player imports it once into the
// browser (Cache Storage, served back by public/sw.js under the very URLs the client already uses), either from a zip
// file or from any static web directory. Two layouts are recognised:
//
//   pack layout (tools/pack-assets.mjs)          release-bundle layout (the upstream Releases 整合包)
//     pack.json                                    <anything>/public/assets/**
//     assets/**              → /assets/**          <anything>/public/fonts/**
//     fonts/**               → /fonts/**           <anything>/data/assets.json
//     data/assets.json       → /data/assets.json   <anything>/data/local-assets.json   (everything else is ignored)
//     data/local-assets.json → /data/local-assets.json
//
// pack.json: { format: 'stronghold-assets', version: 1, hash, app, createdAt, bytes, files: [[path, size], …] }
// (`hash` = data/assets.json hash, `files` relative to pack.json, sorted). A web directory needs pack.json (it is the
// file list); a zip without one is read through its central directory.

export const PACK_FORMAT = 'stronghold-assets';
export const PACK_VERSION = 1;
export const PACK_INDEX = 'pack.json';

/** Site paths served from an imported pack (everything else always comes from the game server). */
export const PACK_PATH_RE = /^\/(?:assets\/.+|fonts\/.+|data\/(?:local-)?assets\.json)$/;

/** Is `pathname` (decoded or not, no query) one of the paths a pack provides? */
export const isPackPath = (pathname) => typeof pathname === 'string' && PACK_PATH_RE.test(pathname) && !pathname.includes('/../');

/** Pack-relative path ('assets/x.png') → site path ('/assets/x.png'), or null when the pack does not provide it. */
export function packRelToSite(rel) {
  const s = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s || s.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  const site = '/' + s;
  return isPackPath(site) ? site : null;
}

/**
 * Decide how the entry names of an archive map to site paths.
 * @param {string[]} names entry names (forward slashes; directories may end with '/')
 * @returns {{ layout: 'pack' | 'release', root: string, map: (name: string) => string | null } | null}
 */
export function detectLayout(names) {
  const list = names.map((n) => String(n).replace(/\\/g, '/'));
  // pack layout: the shallowest pack.json decides the root
  let best = null;
  for (const n of list) {
    if (n === PACK_INDEX || n.endsWith('/' + PACK_INDEX)) {
      const root = n.slice(0, n.length - PACK_INDEX.length);
      if (best == null || root.length < best.length) best = root;
    }
  }
  if (best == null) {
    // no pack.json: a folder holding assets/ + data/assets.json at the same level is still a pack
    for (const n of list) {
      if (!n.endsWith('data/assets.json') || /(^|\/)public\/data\/assets\.json$/.test(n)) continue;
      const root = n.slice(0, n.length - 'data/assets.json'.length);
      if (list.some((x) => x.startsWith(root + 'assets/')) && (best == null || root.length < best.length)) best = root;
    }
  }
  if (best != null) {
    const root = best;
    return { layout: 'pack', root, map: (name) => (name.startsWith(root) && !name.endsWith('/') ? packRelToSite(name.slice(root.length)) : null) };
  }
  // release-bundle layout: <root>public/assets/…
  let rel = null;
  for (const n of list) {
    const i = n.indexOf('public/assets/');
    if (i < 0 || (i > 0 && n[i - 1] !== '/')) continue;
    const root = n.slice(0, i);
    if (root.split('/').includes('node_modules')) continue;
    if (rel == null || root.length < rel.length) rel = root;
  }
  if (rel == null) return null;
  const root = rel;
  return {
    layout: 'release',
    root,
    map(name) {
      if (!name.startsWith(root) || name.endsWith('/')) return null;
      const rest = name.slice(root.length);
      if (rest.startsWith('public/assets/') || rest.startsWith('public/fonts/')) return packRelToSite(rest.slice('public/'.length));
      if (rest === 'data/assets.json' || rest === 'data/local-assets.json') return '/' + rest;
      return null;
    },
  };
}

/** Validate a pack.json object; returns an error string or null. */
export function checkPackIndex(idx) {
  if (!idx || typeof idx !== 'object') return 'pack.json 不是 JSON 对象';
  if (idx.format !== PACK_FORMAT) return `pack.json format 应为 ${PACK_FORMAT}`;
  if (!Number.isInteger(idx.version) || idx.version < 1) return 'pack.json version 无效';
  if (idx.version > PACK_VERSION) return `素材包版本 ${idx.version} 比本程序支持的 ${PACK_VERSION} 新，请更新游戏`;
  if (!Array.isArray(idx.files) || !idx.files.length) return 'pack.json 没有文件列表';
  for (const f of idx.files) {
    if (!Array.isArray(f) || typeof f[0] !== 'string' || !Number.isFinite(f[1]) || f[1] < 0) return 'pack.json 文件列表格式错误';
  }
  return null;
}

/** Content types of the files a pack can hold (the same values server/index.js MIME uses). */
const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  svg: 'image/svg+xml; charset=utf-8', ico: 'image/x-icon',
  json: 'application/json; charset=utf-8', atlas: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8', skel: 'application/octet-stream', bin: 'application/octet-stream',
  obj: 'text/plain; charset=utf-8', mtl: 'text/plain; charset=utf-8',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  woff2: 'font/woff2', woff: 'font/woff', otf: 'font/otf', ttf: 'font/ttf',
};

/** Content-Type for a path by extension (unknown → application/octet-stream). */
export function contentTypeFor(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p || ''));
  return (m && TYPES[m[1].toLowerCase()]) || 'application/octet-stream';
}

/** Percent-encode each segment of a relative path (for directory downloads). */
export const encodeRel = (rel) => String(rel).split('/').map((s) => encodeURIComponent(s)).join('/');

/** "123.4 MB" style size. */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}
