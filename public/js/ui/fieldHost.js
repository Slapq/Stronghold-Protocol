// Field view loader: mounts the Pixi render engine (public/js/render/app.js → createFieldView, DESIGN §9)
// into a host element, falling back to the DOM view (fallbackField.js) when the engine is missing, times
// out or throws. Every call into the view goes through a guard so a render bug can never crash the HUD.
//
// `?render=fallback` (or globalThis.__SP_RENDER__ = 'fallback') skips the engine (dev / mock harness);
// `?render=engine` never falls back silently (errors are logged and the fallback still mounts).

// relative, like every other client module (the import map only resolves to this same URL; no bare specifier here)
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { createFallbackView } from './fallbackField.js';
import { data } from '../data.js';
import { audio } from '../audio.js';
import { settingsStore } from './settings.js';

// The engine gets this long to mount, all stages together (script downloads + its own startup, which waits ≤ 4 s for
// optional parts — render/app.js STARTUP_WAIT_MS): the DOM fallback is far smaller and flatter, so a slow phone link
// must not land there for a whole match (it did at 12 s on 4G — user report 2026-10-06). An engine that turns up after
// the timeout is destroyed (the fallback owns the host by then).
const LOAD_TIMEOUT_MS = 30000;
const METHODS = ['setStage', 'setCamera', 'setPrep', 'enterBattle', 'pushSnapshot', 'pushEvents', 'highlightTiles', 'on', 'resize', 'destroy'];
// direction-step hooks (ui/facingWheel.js): optional — the wheel falls back to the engine's dev hooks when absent;
// setPen (enemy preview pen list), prepField ({ kind, side, mirror } of the Final Assault prep), stripesUnder (the view
// stripes range previews under the units itself) — render/app.js; the DOM fallback lacks them (→ null)
const OPTIONAL = ['pieceScreenRect', 'setSettings', 'off', 'tileScreen', 'holdPiece', 'setPieceDir', 'setPen', 'prepField', 'stripesUnder'];

/**
 * Camera padding (px) that keeps the field clear of the DOM HUD (top bar + bond strip, team panel, shop bar /
 * combat switcher, effects column). Sizes follow the rem scale of css/theme.css.
 * The Final Assault prep ('bossPrep') has the prep HUD (shop bar below) on the boss field: prep padding; the enemy pen
 * ('pen') is viewed with the shop collapsed.
 * @param {string} kind 'prep'|'bossPrep'|'pen'|'normal'|'unite'|'boss'|'hidden'
 * @param {{ width: number, height: number }} size
 */
export function hudPadding(kind, size) {
  let rem = 100;
  try { rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 100; } catch { /* ignore */ }
  const h = size?.height || 1080;
  const clampH = (v) => Math.min(v, h * 0.4);
  if (kind === 'prep' || kind === 'bossPrep') return { top: clampH(rem * 1.95), bottom: clampH(rem * 3.2), left: rem * 2.25, right: rem * 0.9 };
  if (kind === 'boss' || kind === 'hidden' || kind === 'unite') return { top: clampH(rem * 1.9), bottom: clampH(rem * 0.95), left: rem * 2.1, right: rem * 0.95 };
  return { top: clampH(rem * 1.95), bottom: clampH(rem * 1.0), left: rem * 2.25, right: rem * 1.05 };
}

/**
 * HUD geometry (rem) the prep cameras keep clear (they mirror the CSS; test/ui/playtest5-ui.test.js checks the rules):
 * the bond strip's bottom edge (css/screens/game.css .gm__bonds top 1.36rem + a .bslot: disc .52rem + name ≈
 * 2.15rem measured) and the shop bar's top edge above the viewport's bottom (css/screens/game-shop.css .shopbar
 * bottom .2rem + .shopbar__row padding .1rem ×2 + card height 2.24rem, plus its 2 px + 1 px borders). The shop bar
 * sits on the viewport's bottom edge even on a notched phone (css/devices.css, DESIGN §18.1). Collapsed, only its tab
 * is left, in the bottom-right corner (css/screens/game-shop.css .shopbar-tab, bottom .2rem): the band keeps that margin.
 */
export const HUD_REM = Object.freeze({ bondStripBottom: 2.16, shopBarTop: 2.64, shopBarBorderPx: 3, shopTabTop: 0.2 });

/**
 * CSS px of HUD along the top edge (top bar + bond strip) and the bottom edge (the shop bar) of the viewport during
 * prep — the own board ('prep') or the Final Assault half ('bossPrep'); null for every other camera. The prep camera
 * keeps the bench / temp rows and the field's back row clear of them (render/projection.js clearHud; user playtest
 * #5 item 9: the rem floor of 40 px makes the HUD relatively taller on phones in landscape and the shop bar covered
 * the bench). The prep camera is the shop camera while the bar shows, so the band assumes the bar — also for an
 * eliminated player's own board (no shop bar: the band only costs size there, while a camera following the bar's
 * presence would have to re-frame whenever it appears, e.g. when the private state arrives after the prep camera was
 * set). On a touch screen collapsing the bar asks for the official prepare camera (`o.shop === false`, like the
 * client's collapsed shop): the bench is kept clear of the bottom-left corner's buttons (measured) and the collapsed
 * tab (HUD_REM.shopTabTop) only. Touch screens also floor the
 * zoom-out (`minZoom` 1: the official framing, the bench kept clear and the back rows under the top HUD; on a phone
 * with the browser's bars showing the zoom-out shrank the board to 15 px pieces). Scouting a teammate's board uses the
 * 'normal' camera: no band. An armed shop card (two-tap buy,
 * css/screens/game-shop.css .scard.is-armed) rises 4 px above the bar's top on a phone and covers the bench pads'
 * near corners by ≈ 3 px while it stays armed — less than under the unchanged official camera at 1920×1080 (13 px
 * above the bar, ≈ 11 px over the pads).
 * @param {string} kind
 * @param {{ width: number, height: number }} size
 * @param {{ shop?: boolean }} [o] the camera request (`shop: false` = the bar is collapsed)
 * @returns {{ top: number, bottom: number, minZoom?: number }|null}
 */
export function hudBands(kind, size, o) {
  if (kind !== 'prep' && kind !== 'bossPrep') return null;
  let rem = 100;
  let safeTop = 0;
  let touch = false;
  let corner = 0;
  try {
    rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 100;
    // the HUD layer starts below the top safe-area inset (css/devices.css .gm__hud)
    safeTop = Math.max(0, document.querySelector('.gm__hud')?.getBoundingClientRect().top || 0);
    touch = document.documentElement.classList.contains('sp-coarse');
    // the bottom-left corner (交流 ⚙ 📖 ⛶; two rows under 768 px, css/devices.css) stands where the collapsed bar was
    const r = document.querySelector('.gm__corner')?.getBoundingClientRect();
    if (r && r.height > 0) corner = Math.max(0, (size?.height || 0) - r.top + 1);
  } catch { /* ignore */ }
  const h = size?.height || 1080;
  const bottom = touch && o?.shop === false ? Math.max(rem * HUD_REM.shopTabTop, corner) : rem * HUD_REM.shopBarTop + HUD_REM.shopBarBorderPx;
  const bands = { top: Math.min(h * 0.4, safeTop + rem * HUD_REM.bondStripBottom), bottom: Math.min(h * 0.4, bottom) };
  return touch ? { ...bands, minZoom: 1 } : bands;
}

function renderPref() {
  try {
    const q = new URLSearchParams(globalThis.location?.search || '').get('render');
    if (q === 'fallback' || q === 'engine') return q;
  } catch { /* ignore */ }
  return globalThis.__SP_RENDER__ === 'fallback' ? 'fallback' : 'auto';
}

function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
}

/**
 * Wrap a view so no method can throw into the UI (each failing method is logged once).
 * @param {any} view
 * @param {'engine'|'fallback'} kind
 */
export function guardView(view, kind) {
  const warned = new Set();
  const safe = { kind, raw: view };
  for (const name of [...METHODS, ...OPTIONAL]) {
    safe[name] = (...args) => {
      const fn = view && view[name];
      if (typeof fn !== 'function') return name === 'on' ? () => {} : null;
      try {
        const out = fn.apply(view, args);
        if (out && typeof out.then === 'function') out.catch((err) => { if (!warned.has(name)) { warned.add(name); console.warn(`[field] ${name} failed`, err); } });
        if (name === 'on') return typeof out === 'function' ? out : () => { try { view.off?.(args[0], args[1]); } catch { /* ignore */ } };
        return out;
      } catch (err) {
        if (!warned.has(name)) { warned.add(name); console.warn(`[field] ${kind} view ${name} failed`, err); }
        return name === 'on' ? () => {} : null;
      }
    };
  }
  return safe;
}

/**
 * Create a field view in `host`: the render engine when available, else the DOM fallback.
 * @param {HTMLElement} host
 * @returns {Promise<ReturnType<typeof guardView>>}
 */
export async function mountFieldView(host) {
  const pref = renderPref();
  const opts = { data, assets: data.get('assets'), audio, settings: settingsStore.get(), padding: hudPadding, hud: hudBands };
  if (pref !== 'fallback') {
    // one deadline for the whole mount (the imports and the view's startup): LOAD_TIMEOUT_MS each would add up to 90 s
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    const left = () => Math.max(0, deadline - Date.now());
    try {
      // the shared asset store (public/js/assets.js) keeps its Spine cache across remounts (next match, reconnect)
      const am = await withTimeout(import('../assets.js'), left(), 'asset store import').catch(() => null);
      if (am?.assets && typeof am.assets.ready === 'function') opts.assets = am.assets;
      const mod = await withTimeout(import('../render/app.js'), left(), 'render engine import');
      if (typeof mod?.createFieldView !== 'function') throw new Error('createFieldView missing');
      const mounting = Promise.resolve(mod.createFieldView(host, opts));
      const view = await withTimeout(mounting, left(), 'createFieldView').catch((err) => {
        mounting.then((late) => { try { late?.destroy?.(); } catch { /* ignore */ } }, () => {});
        throw err;
      });
      const missing = METHODS.filter((k) => typeof view?.[k] !== 'function');
      if (missing.length) {
        try { view?.destroy?.(); } catch { /* ignore */ }
        throw new Error(`view lacks ${missing.join(', ')}`);
      }
      return guardView(view, 'engine');
    } catch (err) {
      console.warn('[field] render engine unavailable, using the simplified view:', err?.message || err);
      // anything the engine left behind in the host goes
      try { while (host.firstChild) host.removeChild(host.firstChild); } catch { /* ignore */ }
    }
  }
  return guardView(createFallbackView(host, { ...opts, assets: data.get('assets') }), 'fallback');
}

/**
 * Preact hook: mount a field view into `hostRef` once; returns { view, kind } (view null while loading).
 * @param {{ current: HTMLElement|null }} hostRef
 */
export function useFieldView(hostRef) {
  const [state, setState] = useState({ view: null, kind: 'loading' });
  const viewRef = useRef(null);
  useEffect(() => {
    let dead = false;
    const host = hostRef.current;
    if (!host) return undefined;
    mountFieldView(host).then((view) => {
      if (dead) { view.destroy(); return; }
      viewRef.current = view;
      globalThis.__SP_VIEW__ = view; // dev / E2E introspection (view.raw.stats?.())
      setState({ view, kind: view.kind });
    }, (err) => console.error('[field] mount failed', err));
    const unsub = settingsStore.subscribe((s) => viewRef.current?.setSettings?.(s));
    const onResize = () => viewRef.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      dead = true;
      unsub();
      window.removeEventListener('resize', onResize);
      // the dev hook must not keep the destroyed view — and through its host the whole detached match screen — alive
      if (viewRef.current && globalThis.__SP_VIEW__ === viewRef.current) globalThis.__SP_VIEW__ = null;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);
  return state;
}
