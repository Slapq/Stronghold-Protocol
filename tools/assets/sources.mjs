// Upstream asset sources (GitHub dumps of the official client), URL helpers and
// local-path helpers shared by the asset pipeline (tools/fetch-assets.mjs).
// SP_GH_PROXY=https://ghfast.top/ puts a GitHub download proxy in front of every
// raw.githubusercontent.com URL (sourceUrls; servers in mainland China).
//
// Every URL we download from is a raw.githubusercontent.com URL; mirrorUrl()
// maps it to the equivalent jsDelivr URL used as a fallback when GitHub raw
// fails. jsDelivr 404s on the ArknightsAssets2 `voice` branch, so no mirror is
// offered for audio. See docs/ASSETS.md for the full source list and credits.

/** Raw base URLs (always end with '/'). */
export const RAW = Object.freeze({
  yuanyan: 'https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/',
  fexli: 'https://raw.githubusercontent.com/fexli/ArknightsResource/main/',
  arkModels: 'https://raw.githubusercontent.com/isHarryh/Ark-Models/main/',
  aa2: 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/cn/assets/dyn/',
  aa2voice: 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/',
  fonts: 'https://raw.githubusercontent.com/TimWangZi/The-font-of-Arknights/master/font/',
  gamedata: 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/',
});

const RAW_RE = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/;

/**
 * Map a raw.githubusercontent.com URL to its jsDelivr mirror.
 * @param {string} url
 * @returns {string|null} mirror URL, or null when no usable mirror exists
 */
export function mirrorUrl(url) {
  const m = RAW_RE.exec(String(url));
  if (!m) return null;
  const [, owner, repo, branch, path] = m;
  // jsDelivr does not serve the (huge) voice branch of ArknightsAssets2.
  if (owner === 'ArknightsAssets' && branch === 'voice') return null;
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`;
}

/**
 * GitHub download proxy from SP_GH_PROXY (e.g. `https://ghfast.top/`, for servers in mainland China where
 * raw.githubusercontent.com is unreliable), normalised to end with '/'; '' when unset, 'none' or not an http(s) URL.
 * @param {Record<string, string | undefined>} [env]
 */
export function ghProxy(env = process.env) {
  const v = String(env.SP_GH_PROXY ?? '').trim();
  if (!/^https?:\/\/[^\s/]+/i.test(v)) return '';
  return v.endsWith('/') ? v : v + '/';
}

/**
 * Every URL to try for one upstream file, in order. Without a proxy: the URL, then its jsDelivr mirror. With
 * SP_GH_PROXY: the proxied GitHub URL (`<proxy>https://raw.githubusercontent.com/…`), the jsDelivr mirror, and the
 * direct URL last.
 * @param {string} url
 * @param {string} [proxy] ghProxy() by default
 * @returns {string[]}
 */
export function sourceUrls(url, proxy = ghProxy()) {
  const mirror = mirrorUrl(url);
  if (proxy && /^https:\/\/(raw\.githubusercontent\.com|github\.com)\//.test(String(url))) return [proxy + url, mirror, url].filter(Boolean);
  return [url, mirror].filter(Boolean);
}

/**
 * Percent-encode each segment of a repo-relative path ('[uc]x/a b.png' → '%5Buc%5Dx/a%20b.png').
 * @param {string} relPath
 * @returns {string}
 */
export function encodePath(relPath) {
  return String(relPath).split('/').map((s) => encodeURIComponent(s)).join('/');
}

/**
 * Join a base URL and a *decoded* repo-relative path, encoding the path.
 * @param {string} base  base URL ending with '/'
 * @param {string} relPath decoded path
 * @returns {string}
 */
export function joinUrl(base, relPath) {
  return base + encodePath(relPath);
}

/**
 * Sanitize a single file-name component for local storage / URLs:
 * keeps [A-Za-z0-9._-], turns everything else (spaces, brackets, '#') into '_'.
 * @param {string} name
 * @returns {string}
 */
export function safeName(name) {
  const s = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return s.length ? s : '_';
}

/**
 * Site-root URL path for a file under public/assets.
 * @param {string} rel path relative to public/assets (forward slashes)
 * @returns {string} e.g. '/assets/char/avatar/char_002_amiya.png'
 */
export function assetUrl(rel) {
  return '/assets/' + rel;
}

/**
 * Directory part of a URL (everything up to and including the last '/').
 * @param {string} url
 * @returns {string}
 */
export function urlDir(url) {
  const i = String(url).lastIndexOf('/');
  return i >= 0 ? url.slice(0, i + 1) : '';
}

/**
 * Last path component of a URL, percent-decoded.
 * @param {string} url
 * @returns {string}
 */
export function urlBase(url) {
  const s = String(url).split('?')[0];
  const last = s.slice(s.lastIndexOf('/') + 1);
  try { return decodeURIComponent(last); } catch { return last; }
}
