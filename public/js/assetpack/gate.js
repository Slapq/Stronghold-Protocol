// assetpack/gate.js — boot gate for client-side art (docs/DEPLOY.md「素材与服务器分离」). Runs before the app renders:
//
//   1. GET /client-config.json  → { assets: 'client' | 'server', sources: [{ url, label }], hash, app }
//      (an older server without it counts as 'server').
//   2. registers /sw.js (needs a secure context: https or localhost) so an imported pack is served from this browser.
//   3. decides (decideGate): boot the game, or show the 素材包 screen — when the server runs with SP_ASSETS=client and
//      this browser has no complete pack, or when the page was opened with `?assets` (settings → 素材包).
//
// The screen imports from a server-listed source, any URL (a zip or a directory with pack.json), or a local zip file
// (the pack built by tools/pack-assets.mjs, or the upstream Releases 整合包 as is). After an import the page reloads so
// every request (fonts.css included) goes through the service worker. "先不导入" boots with the placeholder art.

import { html, Button, MicroLabel, ProgressBar, TextField } from '../ui/components.js';
import { render } from '../../vendor/preact.module.js';
import { useState, useEffect, useRef } from '../../vendor/hooks.module.js';
import { createPackStore } from './importer.js';
import { formatBytes } from '../../../shared/assetPack.js';

const SKIP_KEY = 'sp.assets.skip';
const URL_KEY = 'sp.assets.url';
const CONTROLLER_WAIT_MS = 3000;

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } };

/**
 * Pure decision (tested): what the boot does.
 * @param {{ config: { assets?: string }, status: object | null, supported: boolean, force: boolean, skipped: boolean }} s
 * @returns {'boot' | 'import' | 'manage' | 'unsupported'}
 */
export function decideGate({ config, status, supported, force, skipped }) {
  if (force) return supported ? 'manage' : 'unsupported';
  if (status && status.complete) return 'boot';
  if (!config || config.assets !== 'client') return 'boot';
  if (skipped) return 'boot';
  return supported ? 'import' : 'unsupported';
}

/** Normalise the server's source list ([{ url, label }] or strings). */
export function normaliseSources(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const url = typeof s === 'string' ? s : s && typeof s.url === 'string' ? s.url : null;
    if (!url) continue;
    const label = (s && typeof s.label === 'string' && s.label) || url;
    if (!out.some((o) => o.url === url)) out.push({ url, label });
  }
  return out;
}

async function loadConfig() {
  try {
    const res = await fetch('/client-config.json', { cache: 'no-store' });
    if (!res.ok) return { assets: 'server', sources: [] };
    const j = await res.json();
    return {
      assets: j && j.assets === 'client' ? 'client' : 'server', sources: normaliseSources(j && j.sources),
      hash: (j && j.hash) || null, app: (j && typeof j.app === 'string' && j.app) || null,
    };
  } catch {
    return { assets: 'server', sources: [] };
  }
}

const swSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && globalThis.isSecureContext && 'caches' in globalThis;

async function registerWorker() {
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // `ready` never settles for a worker that fails to activate: never let that hold the boot
    const ready = await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), CONTROLLER_WAIT_MS)),
    ]);
    if (!ready) return false;
    if (navigator.serviceWorker.controller) return true;
    // first install: clients.claim() hands this page to the worker shortly after activation
    return await new Promise((resolve) => {
      const t = setTimeout(() => resolve(!!navigator.serviceWorker.controller), CONTROLLER_WAIT_MS);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); resolve(true); }, { once: true });
    });
  } catch (err) {
    console.warn('[assets] service worker unavailable', err);
    return false;
  }
}

function cleanUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('assets');
  return url.pathname + (url.search || '') + url.hash;
}

const PHASE_TEXT = { scan: '读取 zip 目录…', download: '下载中', store: '写入浏览器存储' };

function AssetPackScreen({ config, initialStatus, supported, mode, onBoot }) {
  const pack = useRef(null);
  if (!pack.current && supported) pack.current = createPackStore();
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState(null); // { phase, done, total, files, filesTotal }
  const [error, setError] = useState('');
  const [url, setUrl] = useState(() => lsGet(URL_KEY) || '');
  const [quota, setQuota] = useState(null);
  const [drag, setDrag] = useState(false);
  const ctl = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => setQuota(e), () => {});
  }, [status]);

  async function run(job) {
    setError('');
    const ac = new AbortController();
    ctl.current = ac;
    setBusy({ phase: 'scan', done: 0, total: 0 });
    try {
      navigator.storage?.persist?.().catch(() => {});
      const meta = await job(pack.current, { signal: ac.signal, onProgress: (p) => setBusy(p) });
      setStatus(meta);
      lsSet(SKIP_KEY, null);
      setBusy({ phase: 'done', done: 1, total: 1 });
      // reload through the service worker (fonts.css and anything requested before the import)
      setTimeout(() => location.replace(cleanUrl()), 600);
    } catch (err) {
      setBusy(null);
      if (err && err.name === 'AbortError') setError('已取消。目录导入可以稍后继续，已下载的文件不会重复下载。');
      else if (err && err.name === 'QuotaExceededError') setError('浏览器存储空间不足：请清理空间，或在浏览器设置里允许本站使用更多存储。');
      else setError(String((err && err.message) || err));
      setStatus(await pack.current.status());
    } finally {
      ctl.current = null;
    }
  }

  const fromUrl = (u) => {
    const v = String(u || '').trim();
    if (!v) { setError('请输入素材包地址'); return; }
    if (v === url) lsSet(URL_KEY, v);
    run((p, o) => p.importUrl(v, o));
  };
  const fromFile = (file) => { if (file) run((p, o) => p.importBlob(file, { ...o, source: `文件 ${file.name}` })); };

  async function remove() {
    if (!confirm('删除这个浏览器里的素材包？之后需要重新导入。')) return;
    await pack.current.clear();
    setStatus(null);
  }

  // the art manifest hash changes with every download (upstream edits, missing files), so only a pack built for another
  // release of the game is worth a warning
  const mismatch = status && status.complete && config.app && status.app && status.app !== config.app;
  const pct = busy && busy.total ? Math.min(100, (busy.done / busy.total) * 100) : 0;

  if (!supported) {
    return html`<div class="screen ap-screen"><section class="ap-card brackets">
      <${MicroLabel}>ASSET PACK<//><h1 class="ap-title">需要 HTTPS 才能导入素材</h1>
      <p class="ap-text">这台服务器不提供美术和音频素材，素材要导入到你自己的浏览器里，这需要通过 <b>https://</b> 访问（或在本机用 localhost 访问）。
        请让开服的朋友提供 https 地址，或者先用占位画面进入游戏。</p>
      <div class="ap-actions"><${Button} variant="secondary" icon="play" onClick=${onBoot}>用占位画面进入<//></div>
    </section></div>`;
  }

  return html`<div class=${`screen ap-screen${drag ? ' is-drag' : ''}`}
      onDragOver=${(e) => { e.preventDefault(); if (!busy) setDrag(true); }}
      onDragLeave=${() => setDrag(false)}
      onDrop=${(e) => { e.preventDefault(); setDrag(false); if (!busy) fromFile(e.dataTransfer?.files?.[0]); }}>
    <section class="ap-card brackets">
      <${MicroLabel}>ASSET PACK · 素材包<//>
      <h1 class="ap-title">${status && status.complete ? '素材包已安装' : '导入素材包'}</h1>
      <p class="ap-text">这台服务器不提供美术和音频素材（版权归鹰角网络 / Yostar）。素材保存在<b>你自己的浏览器</b>里，只需导入一次，之后进游戏不再下载。
        完整素材约 250 MB。</p>

      ${status && status.complete ? html`<div class="ap-installed">
        <div><span>文件</span><b>${status.files} 个 · ${formatBytes(status.bytes)}</b></div>
        <div><span>版本</span><b>${status.app ? `v${status.app} · ` : ''}${status.hash || '未知'}</b></div>
        <div><span>来源</span><b class="ap-src">${status.source || '—'}</b></div>
        ${mismatch ? html`<p class="ap-warn">素材包是为游戏 v${status.app} 打包的，服务器是 v${config.app}：新加的干员 / 敌人可能显示占位图，建议导入新的素材包。</p>` : null}
      </div>` : status && !status.complete ? html`<p class="ap-warn">上次的导入没有完成（${status.source || ''}），从同一目录重新导入会接着下载。</p>` : null}

      ${busy ? html`<div class="ap-busy">
        <${ProgressBar} value=${busy.phase === 'done' ? 100 : pct} max=${100} size="lg"
          label=${busy.phase === 'done' ? '完成，正在重新载入…' : PHASE_TEXT[busy.phase] || '处理中'} />
        <div class="ap-busy__meta">
          ${busy.total ? html`<span>${formatBytes(busy.done)} / ${formatBytes(busy.total)}</span>` : null}
          ${busy.filesTotal ? html`<span>${busy.files} / ${busy.filesTotal} 个文件</span>` : null}
        </div>
        ${busy.phase !== 'done' ? html`<div class="ap-actions"><${Button} variant="ghost" icon="close" onClick=${() => ctl.current?.abort()}>取消<//></div>` : null}
      </div>` : html`<div class="ap-sources">
        ${config.sources.length ? html`<div class="ap-group">
          <div class="ap-group__title">从服务器推荐的地址下载</div>
          ${config.sources.map((s) => html`<${Button} key=${s.url} variant="primary" icon="signal" block onClick=${() => fromUrl(s.url)}>${s.label}<//>`)}
        </div>` : null}
        <div class="ap-group">
          <div class="ap-group__title">从网址下载</div>
          <div class="ap-row">
            <${TextField} value=${url} onInput=${setUrl} onEnter=${() => fromUrl(url)} placeholder="https://…/pack/  或  https://…/素材包.zip" icon="link" />
            <${Button} variant="secondary" icon="play" onClick=${() => fromUrl(url)}>下载<//>
          </div>
          <p class="ap-hint">网址可以是放着 pack.json 的目录（推荐，可断点续传），也可以是一个 zip。跨站地址需要对方允许 CORS。</p>
        </div>
        <div class="ap-group">
          <div class="ap-group__title">导入本地 zip 文件</div>
          <input ref=${fileRef} type="file" accept=".zip,application/zip" hidden onChange=${(e) => fromFile(e.currentTarget.files?.[0])} />
          <${Button} variant="secondary" icon="plus" block onClick=${() => fileRef.current?.click()}>选择 zip 文件（也可以拖到这里）<//>
          <p class="ap-hint">支持 tools/pack-assets.mjs 打出的素材包，也支持原项目 Releases 的整合包 zip（只取其中的素材）。</p>
        </div>
      </div>`}

      ${error ? html`<p class="ap-error">${error}</p>` : null}
      ${quota && quota.quota ? html`<p class="ap-hint">本站可用存储：已用 ${formatBytes(quota.usage || 0)} / 上限约 ${formatBytes(quota.quota)}</p>` : null}

      ${!busy ? html`<div class="ap-actions">
        ${status && status.complete
          ? html`<${Button} variant="danger" icon="close" onClick=${remove}>删除素材<//>
              <${Button} variant="primary" icon="play" onClick=${() => (mode === 'manage' ? location.replace(cleanUrl()) : onBoot())}>进入游戏<//>`
          : html`<${Button} variant="ghost" onClick=${() => { lsSet(SKIP_KEY, '1'); if (mode === 'manage') location.replace(cleanUrl()); else onBoot(); }}>先不导入，用占位画面进入<//>`}
      </div>` : null}
    </section>
  </div>`;
}

/**
 * Run the gate. Resolves when the game may boot (immediately in the common case); otherwise shows the 素材包 screen in
 * `root` and resolves when the player chooses to continue (an import reloads the page instead).
 * @param {HTMLElement} root
 * @param {{ onShow?: () => void }} [opts]
 */
export async function ensureAssets(root, opts = {}) {
  const supported = swSupported();
  const [config, controlled] = await Promise.all([loadConfig(), supported ? registerWorker() : Promise.resolve(false)]);
  const status = supported ? await createPackStore().status() : null;
  const force = new URLSearchParams(location.search).has('assets');
  const mode = decideGate({ config, status, supported, force, skipped: lsGet(SKIP_KEY) === '1' });
  if (mode === 'boot') {
    // an installed pack without a controlling worker (first visit after the browser dropped it): reload once
    if (status && status.complete && !controlled) {
      try {
        if (!sessionStorage.getItem('sp.assets.reloaded')) { sessionStorage.setItem('sp.assets.reloaded', '1'); location.reload(); return new Promise(() => {}); }
      } catch { /* ignore */ }
    }
    return;
  }
  opts.onShow?.();
  await new Promise((resolve) => {
    render(html`<${AssetPackScreen} config=${config} initialStatus=${status} supported=${supported && mode !== 'unsupported'}
      mode=${mode} onBoot=${resolve} />`, root);
  });
  render(null, root);
}
