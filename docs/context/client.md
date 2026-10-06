# Browser client: agent context brief

Scope: `public/` (index.html, js, css, dev harnesses), the render engine, audio, resource manager, Android shell, client tests. Written 2026-10-06 (package.json:3 version 0.1.3, node v22.22.0) by reading this worktree; `file:line` cites are to this tree. Paths are repo-relative. UNVERIFIED = not run or not traced. Section index of every doc: docs/context/DOC-INDEX.md.

## 1. Facts agents get wrong

1. **No client build step.** `public/js/**` ships as native ES modules. Vendor libs are copied by `npm run vendor` / postinstall (package.json:30,33; tools/vendor.mjs:35-45) into git-ignored `public/vendor/` (.gitignore:3-4). esbuild bundles only the Worker (tools/build-worker.mjs:6,257); the client tree is copied as is (build-worker.mjs:68). Versions: pixi.js 7.4.2, pixi-spine 4.0.6, preact 10.29.8, three 0.186.1, htm (package.json:51-58).
2. **UI is Preact + htm, not React/JSX.** Use `html` from public/js/ui/components.js:36 (htm bound to `hFresh`, :30, which turns off htm's static-vnode cache; toasts.js:13-17 has its own copy). Attributes are `class=`, `onClick=`. `TextField onInput` receives the string value, not the event (components.js:836-842; DESIGN.md §27 records a bug from the DOM convention).
3. **Imports are relative; no bare specifiers in client code.** `'../vendor/preact.module.js'`, hooks from `'../vendor/hooks.module.js'` (main.js:33-34), `'../../shared/…'`. The import map (index.html:48-50) is a safety net; tests forbid bare specifiers (test/client-static.test.js:1232, 1243) and check the import graph (:201-246). URL mounts: `/data/`←`data/`, `/shared/`←`shared/`, `/sim/`←`server/sim/*.js` (server/index.js:3-10, 358-363).
4. **Two runtimes, one client.** The Node server serves public/index.html verbatim. The Cloudflare build rewrites it (tools/build-worker.mjs:94-99): `data-sp-runtime="cloudflare"`, `data-sp-build`, `data-sp-rules`, entry becomes js/worker-entry.js, Google Fonts links removed, css/resources.css added. `public/dev`, `assets`, `fonts` are not copied there (:67). `net` is `export let`, replaced by `configureTransport` (net.js:867-873) with RoomNet in account mode (worker-entry.js:1-4; room-net.js:591). Account + resource-manager code runs only under that attribute (main.js:373).
5. **Routing is derived from the store, no URL routes** (main.js:3-8; store.js:102-109). The only routing query is `?room=CODE` (main.js:386).
6. **Combat runs in the browser.** The sim (server/sim) is served at /sim/ and stepped by public/js/battle/runner.js (runner.js:1-6); `b.snap` / `b.ev` are not sent for combat (docs/DESIGN.md:569). Under client combat the runner publishes `store.match.field` (store.js:8-13). A server-side `combatMode:'server'` fallback still exists (DESIGN.md:549-551).
7. **FX, clips and sounds are keyed by event kind / model id, never by skill.** A new skill needs no client registration, with two exceptions (section 8): a new literal `fx` kind needs an `FX_KINDS` row (enforced by test/render/boardart.test.js:139-168), and a new `atk` projectile kind needs a `PROJ` row plus a sim `PROJECTILE_SPEEDS` row (test/render/fxproj.test.js:56). An unknown `atk` kind draws NO projectile (render/fx.js:521-525).
8. **docs/DESIGN.md §2 (lines 40-121) is stale for the client.** It lists files that do not exist: shared/format.js, shared/rules.js, ui/tooltip.js, ui/bondPopup.js (DESIGN.md:90-91,104-105). Tooltip lives in ui/components.js:523, BondPopup in ui/bondStrip.js. It omits screens loadout/history/replay. DESIGN §9's API block (:469-498) is partial: the real contract is the header of public/js/render/app.js:1-120.
9. **Generated data is not hand-edited:** `data/*.json` come from `npm run build-data` (README.md:194); `data/assets.json` from tools/fetch-assets.mjs (docs/context/assets.md). `data/local-assets.json` is git-ignored (.gitignore:12); the server answers an empty stand-in when absent (server/index.js:354-355, 430-434).
10. **3D board needs local art.** three.js is fetched only if local-assets.json lists the board atlas (render/app.js:91-100; board3d/load.js:78); otherwise the 2D atlas board. On this machine data/local-assets.json is absent, so browser renders are 2D here (observed).
11. **`data.list('waiguan')` is junk.** waiguan.json is `{candidates, chess, chessT5}` (shared/waiguan.js:3-9); `buildIndex` (data.js:62-82) would index those 3 keys. Use `data.get('waiguan').candidates` (screens/loadout.js:539).
12. **外援 picks follow the account in account mode** (`waiguan` is in PREFERENCE_KEYS, validated on client and Worker; a one-time upload of an older local selection where the cloud has none); the Node server keeps localStorage `sp.pref.waiguan`. In a match, `data.lookup('chess', id)` (public/js/data.js) falls back to the 外援 records (tier V/VI, normal/elite) once waiguan.json is loaded, so shop cards, pieces, unit detail, bonds, voice and replays resolve them; `m.private.picks` carries the match's locked picks.
13. **`ui.accountPage` and `ui.replayMatchId` are written but not declared** in `initialState.ui` (store.js:90; accountMenu.js:106; screens/history.js:92). `ui.accountPage` ∈ 'history'|'statistics'|'replay'|null picks the screen (main.js:327).
14. **Other stores exist** and are not in `store`: `loadoutStore` (loadoutSync.js:31, survives room/match resets), `settingsStore` (ui/settings.js:23), `awayStore` (ui/matchChrome.js:26), `guideStore` (ui/guide.js:69). `useStore(sel, eq, target)` binds any of them (store.js:224).
15. **rem scale:** `1rem = 100 design px` at 1920x1080, root clamped 40-240 px (css/theme.css:109-113). A phone is ~40 px/rem, so text uses px floors, e.g. `max(.15rem, 9px)` (css/devices.css:180-210). Do not write layout in px.
16. **Resource manager / PWA / Android are separate mechanisms** (section 10): manager only in the Cloudflare runtime and not in the bundled Android app (resources/index.js:31-42).
17. **CI runs no browser tests** (SP_E2E / SP_REAL_E2E / RENDER_E2E = '0', .github/workflows/ci.yml:29-31; no public/assets there). Browser regressions are invisible to CI: run them locally.
18. **`node --test <dir>` fails on Node 22** ("Cannot find module …/test/ui", verified). Use quoted globs (section 12).
19. **E2E Chrome default is a macOS path** (test/ui/mock.e2e.test.js:24; test/e2e/client.mjs:13), Windows for account suites (account-flows.e2e.test.js:13). Always pass CHROME_PATH on Linux. With the flag set but no Chrome the suite reports 0 tests, no failure (verified), so a "green" run may have run nothing.
20. **docs-consistency.test.js pins wording across docs and code** (test/docs-consistency.test.js:1-30, imports client modules). After editing a client rule or a doc, run it. After editing any docs/*.md heading or length, regenerate the index: `node tools/doc-index.mjs` (test/doc-index.test.js:20 fails when stale).
21. **index.html is test-checked** (test/client-static.test.js:174-199): every src/href must exist (except /fonts, /assets), and it must boot main.js and contain the rotate hint.
22. **Chinese strings are the product.** Docs are Chinese, code and comments English (README.md:230). Keep UI copy and docs wording consistent with PLAYING.md / DESIGN.md; tests grep some of it.
23. **Browser floor is old on purpose:** Chrome/Edge/Firefox (incl. ESR 115), Safari 15+, iOS/iPadOS 15+, Android Chrome (test/client-static.test.js:1194-1197; the in-page failure text says 16.4+ / Chrome 90+ / Firefox 108+, index.html:91). Enforced by tests over all browser JS, including `shared/` and `server/sim/` (:1200): no regex lookbehind (:1256); in CSS no `:has()` (use `useDocClass`, ui/device.js:128), container queries, nesting, `color-mix()`; `backdrop-filter` needs its `-webkit-` twin. Feature-detect newer APIs; ui/compat.js polyfills are imported first (main.js:31; test :1225). Background-tab timers are throttled to ~1/min: never treat a late timer as a dead connection (net.js:3-8).

## 2. Where to look

| Task | Start here |
|---|---|
| Boot, net wiring, toasts on server frames, deep link join | public/js/main.js:151-289 (handlers + wireNet), :369-445 (boot) |
| State shape, route, spectator checks, prefs hooks | public/js/store.js:74-109, 118-132, 185-205 |
| WebSocket client, identity/token per tab | public/js/net.js (REQUEST_TIMEOUT_MS :35, identity :677-864) |
| Account-mode transport (Workers) | public/js/room-net.js, public/js/account.js, public/js/worker-entry.js |
| Data files, lookups, `useData` | public/js/data.js:24-42, 116-263, 352-365 |
| In-match screens by phase | public/js/screens/game.js:138-167 (router), :211 (MatchScreen), :1369-1479 (tree) |
| In-match intents (`g.*`) | public/js/ui/gameActions.js:21-74 |
| Pure in-match logic (placement, camera, HUD delay) | public/js/ui/gameLogic.js (1979 lines; unit-tested) |
| 干员调配 + 外援 slots | public/js/screens/loadout.js, ui/loadoutModel.js, ui/loadoutSync.js |
| Field view mount / fallback | public/js/ui/fieldHost.js:204-271; DOM fallback ui/fallbackField.js |
| Render engine | public/js/render/app.js (contract :1-120), units.js, spine.js, fx.js, fxsustain.js, style.js |
| Local battle runner | public/js/battle/runner.js, observe.js; replay: replay-runner.js |
| Audio, voice | public/js/audio.js; URL helpers assets.js:222-232; media.js |
| Asset manifest helpers, Spine LRU | public/js/assets.js (941 lines) |
| Resource manager | public/js/resources/*, public/resource-sw.js, tools/resource-pack.mjs |
| Device / touch / fullscreen | public/js/ui/device.js, public/css/devices.css |
| Dev harnesses (Node server only) | public/dev/game-mock.html(+js), render-demo.html(+js), uikit.html |
| Android | public/js/appShell.js, android/app/src/main/java/ag/lunar/stronghold/*, docs/ANDROID.md |
| Client tests | test/client-static.test.js (import graph, compat rules), test/ui/*.test.js (units), test/ui/*.e2e.test.js, test/render/*, test/resources/*, test/e2e/client.mjs (helpers) |
| Doc sections by line | docs/context/DOC-INDEX.md; section 14 below for the client-relevant ones |

## 3. Page, boot, runtimes

- public/index.html (112 lines): fonts (Google, non-blocking :26; self-hosted /fonts/fonts.css :29), 16 stylesheets in fixed order (:31-46, devices.css last), import map :48, modulepreload :51-54, prefetch of pixi + pixi-spine :57-58, `#app` :61, boot splash `#boot` :63, rotate hint :71, boot-failure ES5 script :82-101, `main.js` :102, 9 s slow-boot hint :105-110.
- `boot()` (main.js:369): global error handlers -> `installDeviceSupport()` -> Cloudflare branch (loadAccount, preferences.start, resources.prepareResources/installResourceManager, :373-380) -> `identity.init()` -> store seed (name, `entered`, pendingJoin) -> `wireNet()` -> `installLoadoutSync({net})` (:398) -> `installAudio` (:401) -> data warm: `assets`, `config`, `local` (:402-406) -> connect -> wait fonts (<=1.2 s) -> `render(<App/>)` (:417) -> hide splash -> `globalThis.__SP__ = { store, net, data, audio }` (:432, used by e2e) -> `startBuildGuard` (:438; ui/buildGuard.js reloads a stale tab outside a match).
- `App` (main.js:323-337): `selectRoute` + `ui.accountPage` choose Title/Lobby/Room/Game/History/Replay, then always mounts ConnectionBanner, ToastHost, UiHosts (dialogs + tooltip layer), GuideHost, LoadoutHost. Screen crashes show ScreenCrashed via `useErrorBoundary` (:312, :326).
- `warmGameData()` (main.js:298): once `s.room` appears (:277) it loads every `GAME_FILES` entry and imports render/app.js `ensurePixi()` and assets.js, in idle time. The match screen waits for them (game.js:149-156).

## 4. main.js net -> store wiring

| Server frame | Effect (main.js) |
|---|---|
| `status` / `clock` | `store.connection` (menu status clears the room token) / `store.clock` (:215-227) |
| `welcome` | `me`; new playerId while a room/match was shown -> `backToLobby()` + toast `sessionResetNotice` (:151-179); same id -> `ui.restoring` for RESTORE_GRACE_MS 1500 (:59) |
| `room.state` | `store.room`; not seated and not spectator -> drop room, toast (:181-199); new match -> `emptyMatch()` (:195) |
| `room.closed` | `CLOSE_REASON` toast table (:201-212), `backToLobby()`; ended match with result keeps the final view (:244-250) |
| `m.public` / `m.private` / `m.field` / `m.result` | `store.match.{public,private,field,result}` (:251-254) |
| `m.toast` / `m.ticker` / `m.emote` | `toast()` (:255-258); `store.ticker` (keep 20, :259-268); `store.emotes` (keep 20, :269-271) |
| `queue.status` / `queue.matched` | `store.queue`; a seated match sets `ui.pendingJoin` and joins (:233-243, 281-287) |
| `replaced` / `helloError` / `unhandledError` | toasts (:229-231) |

- Toasts: `toast(text, kind, {ttl})` in ui/toasts.js:44 (kinds info/success/warn/error :19; max 4 :20; merges identical within 2.5 s :22, 50-56; text cut to 200 chars). `toastError(err)` :108 maps codes through shared ERR_TEXT (:94). Host: `ToastHost` :120. Never add a second toast system.

## 5. store.js shape (public/js/store.js)

`createStore` get/set/patch/subscribe/reset (:34-71): `set` shallow-merges top-level keys, `patch(key, obj)` one level deeper; listeners run synchronously.

| Key | Contents |
|---|---|
| `connection` | {status, ping, attempt, retryAt, lastError, everOnline} (:78) |
| `me` / `session` | {playerId, name, token} / {entered} (:79-80) |
| `room` | last `room.state` payload or null (:81) |
| `match` | `emptyMatch()` {public, private, field, result, battle} (:74); `battle` = local runner state (:8-13) |
| `queue`, `ticker`, `emotes`, `clock`, `ui` | :86-90 (`ui` declared: pendingJoin, restoring, buildStale) |

Helpers: `selectRoute` :102, `isSpectating` :118 (Node-server seat), `isSpectator` :130 (also Worker public-match watchers), `serverNow` :154, `shallowEqual` :165, `loadPref/savePref/usePref/usePrefStatus` :185-211, `useStore` :224.

## 6. data.js (public/js/data.js)

- `DATA_FILES` names 12 files (:24-42): chess bonds items bands enemies bosses stages tokens choices config assets waiguan, plus `local`->`local-assets.json`. Any other name loads `/data/<name>.json`. `GAME_FILES` (ui/gameComponents.js:16) adds effects, garrisons, factions (16 files).
- Fetch once per page, shared promise; transient failure retried at 600/2000 ms (:85); missing -> `null` + one console warning. `assets` and `local` are abandoned after 8 s and read `missing` so emote buttons draw glyphs (:92-95, GitHub #99).
- Tolerant indexing by ID_KEYS (:44, :62). Sync getters return null until loaded: `getChess/getBond/getItem/getBand/getEnemy/getBoss/getStage/getToken/getConfig/getMode` (:272-345). `localAsset(group,name)` :296, `artUrls` :313 (local first, then mirror copy), `nextArtUrl` :330. In components use `useData(...names)` :352 or `useGameData()` (gameComponents.js:25) which exposes `chess(id)`, `bond`, `item`, `band`, `enemy`, `boss`, `stage`, `token`, `effect`, `garrison` (:31-50).

## 7. Screens and UI layer

| File | Role |
|---|---|
| screens/title.js:149 | nickname, 开始 (`enterSession` :34); account card in Worker mode; install/fullscreen/guide/resource buttons |
| screens/lobby.js:261 | 独立/同盟模拟, difficulty, create/join by 4-char code, spectate, 匹配 queue; `MODE_TEXT` fallback texts :29 |
| screens/room.js:228 | seat cards (capacity 1-8, `roomCapacity` :38), host controls, invite link, ready/start |
| screens/briefing.js:22 / bandDraft.js:171 / result.js:71 | INFO_CHECK / BAND_DRAFT / RESULT; shared blocks in ui/matchInfo.js |
| screens/game.js:138 | `GameScreen` routes by `phaseMode(pub.phase)`: spectator -> MatchScreen, result, briefing, draft, else MatchScreen (:153-159); waits for `useGameData().ready` (:149) |
| screens/game.js:211 | `MatchScreen`: `useFieldView(hostRef)` :232, HUD tree :1369-1479 (TopBar, bond strip, TeamPanel, ShopBar, DetailPanel, CombatHud, Ticker, EmoteWheel, Underframe, FacingWheel, overlays), `html.sp-in-match` via `useDocClass` |
| screens/history.js:23 / replay.js:24 | account history/statistics and replay, reached from the account menu (`ui.accountPage`; Worker mode; `accountRequest`, `verifyReplayChunks`) |
| screens/loadout.js:507 | 干员调配 overlay `LoadoutScreen`; `LoadoutHost` :693 mounted in App; `LoadoutButton` :724 on lobby/room/briefing; `shouldAutoClose` :686 |

- **Loadout overlay + 外援 slots.** Roster = `rosterOf` over `data.list('chess')` + the player's picked 外援 records: `isLoadoutSlot` (loadoutModel.js:322-323) keeps non-golden, non-hidden, base, `visible !== false`, non-`isDiy` chess (112 in data/chess.json, verified) or real 外援 records (`waiguanPickChess` :377, `withWaiguan` :404). `locked` = in match and phase not INFO_CHECK/LOBBY, or sync 'locked' (loadout.js:532). `WaiguanSlots` :189 renders the 4 slots `diy5a diy5b diy6a diy6b` (`PICK_SLOT_META` :168; `PICK_SLOTS` loadoutModel.js:73; tiers 5,5,6,6); `WaiguanPicker` :225 searches `data.get('waiguan').candidates` (87 in data/waiguan.json, verified), blocks the sibling slot of the same tier; `pickAsChess` :181 fakes a chess record so avatar helpers work. State: `loadoutStore.picks` (loadoutSync.js:31-44), `setPicks` :55 (persists via `savePref('waiguan')`), sync `flushPicks` :126 (skips empty selections so waiguan.json is not downloaded in the lobby, :135-142) then `flush`. Refusals: WRONG_PHASE/ROOM_STARTED -> toast 本局的外援干员已锁定 (:159-160). A leftover debug hook `globalThis.__SP_DBG_PICKS` is at :136.
- **ui/components.js** (864 lines): `Button` :126 (variant primary|secondary|danger|amber|ice|ghost, size sm..xl, `loading` shows a bottom bar not a spinner, :119-143), `Panel` :150, `Modal` :397 (`modalStack` :390: Esc closes only the topmost), `confirmDialog/alertDialog` :464-470 (need `UiHosts`), `closeAllDialogs` :476, `Tooltip` :523 (hover 120 ms; touch: a tap shows none, a 450 ms long press shows, :521-582) with `TooltipLayer` :584, `Tabs` :644, `ProgressBar` :622, `Countdown` :357, `TextField` :829, `AvatarFrame` :696, `ICONS` :44. Icons are inline SVG paths, no icon font.
- **ui/gameComponents.js**: `Img` with fallback node :56, `Sprite` :63, `LocalSprite` :72, `RichText` :80, `UnitThumb` :98. URL helpers: ui/assetUrls.js (pure, manifest-first, return null on unknown ids; callers draw a fallback).
- **ui/device.js**: feature detection, never UA sniffing (:1-26). `installDeviceSupport` :239 sets `<html>` classes `sp-touch sp-coarse sp-hover sp-no-hover sp-fs sp-standalone sp-reduced-motion sp-rotatable` (:104-117), `--sp-vh` (:261), blocks pinch zoom (:279-284), synthetic long-press `contextmenu` after 520 ms (:33, 292-324). `useDocClass(name,on)` :128 replaces CSS :has(). `useWakeLock` :178, `fullscreen` :184, `FullscreenButton` :212, `isPhone` :98 (short side < 500 px, :36).
- Match HUD modules: hud.js (top bar), shopBar.js, teamPanel.js, bondStrip.js (+BondPopup), detailPanel.js, choiceOverlay.js (机变), combatHud.js, enemyDrawer.js, emotes.js, ticker.js, underframe.js, facingWheel.js + facing.js (direction wheel), equipReplace.js, watchBonds.js, matchChrome.js (exit/away), connBanner.js, settings.js, guide.js, install.js (PWA button), richText.js (official markup -> spans, pure), buildGuard.js.

## 8. Battle pipeline, renderer, FX and sound keying

**Data flow.** Server `b.start {spec}` -> `battleRunner` (battle/runner.js:219, singleton :927) builds `Battle` from /sim/spec.js and steps fixed 1/30 s ticks -> emits `snap` / `ev` / `field` / `state` (screens/game.js:583) -> `view.pushSnapshot/pushEvents` (frames in the same wire format the server once streamed; SIM.md:1182 documents tuples) -> view draws `LOOK_AHEAD` = 1 game s behind (render/app.js:151) and re-emits `battleEvents` to audio (:1711-1714; game.js:584).

**Mounting.** `useFieldView(hostRef)` (ui/fieldHost.js:244) -> `mountFieldView` :204: tries `import('../render/app.js').createFieldView(host, {data, assets, audio, settings, padding: hudPadding, hud: hudBands})` within one 30 s deadline (:21, 204-240), else DOM `createFallbackView`. `guardView` :157 wraps every method (METHODS :22, OPTIONAL :26) so a render bug cannot crash the HUD. `?render=fallback|engine` (:140), `?board=2d|3d` (render/app.js:332). `globalThis.__SP_VIEW__` exposes the view to e2e (:254). `ensurePixi()` (app.js:209) loads classic scripts /vendor/pixi.min.js and pixi-spine.js into `globalThis.PIXI`.

**Engine modules (public/js/render).** app.js `createFieldView` :449 (camera, layers, event dispatch `handleEvent` :1717), projection.js (Camera, presets, `clearHud`), tiles.js (2D board + highlights), board3d/* (three.js scene, atlas, layout, load), units.js (`UnitView` :318, `FORMS` :238, `ItemView`, `DeviceView`), spine.js (`SpineActor`), fx.js + fxsustain.js, interp.js (`SnapshotBuffer`, `COSMETIC_EVENTS` :57), pick.js / drag.js (picking by tile), pen.js / prepfield.js (enemy preview pen, boss-field prep), impostor.js (shared atlas for crowds), textures.js, style.js, loadlevel.js (adaptive quality).

**SpineActor (render/spine.js:115).** Owns one `PIXI.spine.Spine` from cached skeleton data; clip roles come from the manifest `chars[id].spine.front.anims` (idle, deploy, attack{begin,loop,end}, attackDown, skill{begin,loop,end,idle,index}, skills{idx}, die, move, stun; docs/ASSETS.md:313-330). `setSkillIndex(i)` :172 picks `anims.skills[i]`, else the default skill clip; called from units.js:512 with `UnitInfo.skillIndex`. `setSkill(on)` :568 plays begin/loop/end by the rules in the file header :1-65 (DESIGN.md §23.13, §25.1). Spine data are LRU + refcounted in assets.js (`RefLru` :264, budget constants :668-682).

**Event -> visual keys** (render/app.js:1733-1791; tuples SIM.md:1182+, shared/protocol.js:429):

| b.ev tuple | Client lookup |
|---|---|
| `['atk', src, tgt, projKind]` | `PROJ[projKind]` (render/style.js:107: arrow bolt orb bomb lob drone enemy boomerang droneBomb); `chain`/`chainHeal`/`beam` are beams (fx.js:519-520); `none`/missing = melee slash; speed from sim `PROJECTILE_SPEEDS` (server/sim/constants.js:53) loaded at runtime (fx.js:54-70) |
| `['fx', kind, x, y, extra]` | `fxSpec(kind, extra)` (fx.js:275): `FX_KINDS[kind]` (:177) -> keyword guess `FX_GUESS` -> generic sparkle; archetype `a` selects the branch in `simFx` (:1723); `SUSTAINED[kind]` (fxsustain.js:50) makes it a lasting aura/field/link (state; kept for late joiners, game.js:131-136) |
| `['skill', id, on]` | `view.setSkill(on)` (clip) + `fx.skill(view,on)` generic gold pillar/ring (fx.js:1547). No per-skill art |
| `['status', id, key, on]` | `statusIconKey(key)` (style.js:158): `STATUS_ICON`, then tail after `:`, then `STATUS_GUESS` regexes; unknown -> no icon |
| `['die'/'deploy'/'dmg'/'heal'/'leak'/'layer'/'bounty']` | views, damage numbers (`DMG_STYLE` style.js:73), pops |

**What a new skill needs client-side**
1. Sim kit in server/sim/content/kits/tier*.js. It runs in the browser unchanged (served at /sim/); no client edit for logic. Coverage tool: `node tools/kit-coverage.mjs --missing` (SIM.md:879).
2. If the kit calls `battle.fx('newKind', …)`: add an `FX_KINDS` row (fx.js:177-258) or the scan test fails (boardart.test.js:139-168). Without a row at runtime it still draws via keyword guess / generic. Use `tiles`, `r`, `dur`, `id`, `target`, `element` extras as `simFx` documents (fx.js:1715-1722).
3. A held visual (field, wall, aura, link, drones): `SUSTAINED` row, and its end is the skill ending or a bound `status` key (fxsustain.js:36-50).
4. New projectile look: `PROJ` row + `PROJECTILE_SPEEDS` row; `test/render/fxproj.test.js:56` requires them to match.
5. Skill clip: nothing to code. tools/assets/anim-roles.mjs derives `anims.skills` from clip names; DESIGN.md §25.1 (:2186) covers a clip without Begin/Idle.
6. Skill icon/text/SP data come from data/chess.json `skills[]` (docs/DATA.md §2.2) and the manifest `skills`/`skillsById` (assets.js:110); rebuild data with `npm run build-data`.
7. Skill sound: manifest `audio.sfx.units[charId].skills[index]` else `.skill` (audio.js:793-806; assets.js:225-232). Regenerated by the assets pipeline, not hand-written.
8. Re-run: `node --test test/render/boardart.test.js test/render/fxproj.test.js test/render/recordings.test.js`; look at it in public/dev/render-demo.html (`?scene=…`, FX cycle scene, header comment render-demo.js:1-18).

## 9. Audio (public/js/audio.js, 1148 lines)

- `audio` singleton :1110, `installAudio` :1119 (called main.js:401): BGM follows route/phase (`bgmKeyFor` :192, 开战 track by round `combatTrackFor` :250, switch at round 7 :240); UI SFX `audio.sfx(name)` reads `manifest.audio.sfx.ui[name]` (:771; 55 keys in data/assets.json); battle sounds `audio.battle(name)` :779; per-unit `audio.unit(defId, kind, unitId, skillIndex)` :793.
- **Keys.** Unit sounds: `audio.sfx.units[UnitInfo.spine || defId]` (`_track` :1005-1010). Voice: `audio.voice.<cn|jp>.<charId>.<select|deploy|combat|start|win3|win|fail>` (`voiceUrl` :113); played by `audio.voice(charId, role)` :828 under official battle-voice rules (`voiceRulesOf` :126, header :40-57; docs/ASSETS.md:117-184). Only own operators speak. Manifest has voice for 198 charIds; 9 of the 87 外援 candidates have none (measured on data/assets.json).
- Where voice is triggered: select = tap own unit in a combat phase (screens/game.js:964, charId from `UnitInfo`); deploy = bench-to-board drop (game.js:1080, charId from `pieceCharId(piece, getChess)` gameLogic.js:1043); combat = own skill start (audio.js:1062-1068); start/end lines by the squad leader `voiceLeader` (gameLogic.js:1067).
- Fetch: extension-less `/media/…` first, falls back to the original URL (audio.js:630-637; media.js:30-48; shared/media.js:19-20; SW and Android resolve it too). AudioContext is created on first gesture; limits MAX_VOICES 8, per-URL 2 (:74-79). Settings: ui/settings.js (store `sp.pref.settings`, device-local).

## 10. Resource manager, PWA, Android shell

- **Resource manager (Cloudflare runtime only).** `prepareResources()` (resources/index.js:91) runs before the first render: returning player -> register `/resource-sw.js` and check in the background; first visit -> blocking dialog (download / import ZIP / skip). Mode key `localStorage stronghold-resource-mode` (:18). All cache ops hold Web Lock `stronghold-resources` (:20, 67-71). `ResourceStore` (resources/store.js) keeps ONE Cache Storage cache keyed by URL, entries verified by size + SHA-256 against `/resource-manifest.json` (store.js:1-10; common.js:3-8, 25-39). Download 6 files in parallel, retries 1 s/3 s (store.js:178, :17). ZIP import/export: resources/zip.js (zip.js lib vendored as vendor/zip.module.js), dialog resources/view.js (PACK_URL `/stronghold-resources.zip` :7), opener button ui/resourceButton.js:14.
- **Service worker** public/resource-sw.js:14-19 answers only `/assets/*`, `/fonts/*` and `/media/*` GETs from cache (resources/service.js:13-22); never code/API.
- **Manifest and pack build:** `npm run resources:manifest` (writes git-ignored public/resource-manifest.json), `resources:pack`, `resources:zip` (package.json:42-44; tools/resource-pack.mjs:66,96,143). Docs: docs/CLOUDFLARE.md:48 (资源包). Browser e2e: SP_RESOURCES_E2E=1 (test/resources/browser.e2e.test.js:3).
- **Android app** (android/, docs/ANDROID.md): full-screen WebView of the chosen server. The page detects it via UA token `StrongholdApp/<ver>[ bundled]` (appShell.js:6-12; MainActivity.java:44,75). `inApp` makes `standalone` true and `fullscreen` false, which hides the install and fullscreen buttons (device.js:70-72, 81); `appBundled` disables the resource manager (resources/index.js:33). BundledAssets.java intercepts `/assets`, `/fonts`, `/media` only (docs/ANDROID.md:23-37). Build: `npm run android:assets` then `cd android && ./gradlew assembleRelease` (ANDROID.md:38-56). Contract test: test/android.test.js (UA, /media extensions, version).
- **PWA:** public/manifest.webmanifest (fullscreen, landscape, icons in public/icons), install button ui/install.js; test/pwa.test.js.

## 11. CSS layout

- Tokens, fonts, root scale, rotate hint, z-layers in css/theme.css (:10 tokens, :109 root scale, :316 rotate-hint, :379 `.sp-rotatable .rotate-hint`). Component styles css/components.css (948 lines; `.sp-in-match` toast/banner offsets :876-880). Per-screen files under css/screens/: title, lobby, room, game (672), game-shop, game-panels (707), briefing, draft, result, guide, loadout (439; `.sp-loadout-open` hides the screen under the overlay :343), account. Also css/emotes.css, css/resources.css (Worker build only, tools/build-worker.mjs:99), css/devices.css (210 lines, loaded last).
- devices.css sections: 1 gestures/touch-action :22-32; 2 safe areas (`--sa-t/r/b/l`, `--tap-min` 44 px :12-18, :34-53); 3 invisible 44 px touch targets for `.sp-coarse` controls :55-106 (add new small controls to that list); 4 misc; narrow `<768px` :141-153; short `<=460px` :155-178; phone type floor :180-210.
- Phone rules live in media queries `max-height: 460px` / `600px` with `(pointer: coarse)`, `max-width: 767px`; per-screen files add their own (game.css :252, :342, :641; loadout.css :346-364; room.css :73). Camera HUD bands mirror CSS rem numbers in ui/fieldHost.js `HUD_REM` (:58; DESIGN.md §19.8, §26.1); change CSS and `HUD_REM` together (test/ui/playtest5-ui.test.js checks).

## 12. Tests: exact commands

| Kind | Command | Notes |
|---|---|---|
| Everything | `node --test` (or `npm test`; `npm run test:fast` = MATCH_SEEDS=3) | package.json:28-29; CI does this (ci.yml:48) |
| Client unit (no browser) | `node --test 'test/ui/*.test.js' 'test/render/*.test.js' 'test/resources/*.test.js' test/client-static.test.js test/pwa.test.js test/android.test.js test/docs-consistency.test.js` | verified 2026-10-06: 1460 tests, 1444 pass, 16 skipped, 0 fail, 45 s |
| One file | `node --test test/ui/loadout.test.js` | 外援: loadout.test.js `picks:` block, waiguan-loadout.test.js |
| UI e2e (mock harness / real server) | `CHROME_PATH=/path/to/chrome SP_E2E=1 node --test test/ui/mock.e2e.test.js` | gate: `SP_E2E=1` and the Chrome path exists; `SP_RENDER=fallback` forces the DOM view; shots -> test/e2e/out/ (git-ignored) |
| Other UI e2e | `SP_E2E=1 node --test test/ui/waiguan.e2e.test.js` (also loadout, devices, emotes, eight-players, bond-collapse, …) | 35 `*.e2e.test.js` files in test/ui, most gated on SP_E2E=1 |
| Real assets e2e | `SP_REAL_E2E=1 node --test test/ui/real.e2e.test.js` | needs public/assets (SP_REAL_ROUNDS) |
| Render browser | `RENDER_E2E=1 node --test 'test/render/*.browser.test.js'` | needs Chrome + public/assets; some need local board art |
| Accounts / Worker | `SP_ACCOUNTS_E2E=1 node --test test/ui/account-flows.e2e.test.js …` (list: docs/ACCOUNTS-HISTORY.md:126-130) | builds the Worker; `SP_SPECTATORS_E2E=1` for spectators.e2e |
| Resource cache | `SP_RESOURCES_E2E=1 node --test test/resources/browser.e2e.test.js` | |

- E2E stack: puppeteer-core 25.12 (package.json devDependencies) + system Chrome, `--no-sandbox`. Helpers test/e2e/client.mjs (`startRealServer`, `Client` with real mouse/keys/drags, `problemsOf`), test/e2e/fastServer.mjs (scaled timers; env hooks SP_START_ROUND, SP_START_CHESS, SP_AUTO_PLACE … :1-25). Every e2e asserts zero console/page errors and no failed requests. In e2e pages state is readable at `window.__SP__.store.get()`; set `localStorage sp.name` and `sessionStorage sp.entered=1` to skip the title (waiguan.e2e.test.js:46-47).
- Mock harness: `node server/index.js` then open `/dev/game-mock.html?phase=PREP&variant=reward,temp&shot=1&render=engine&players=8` (params documented in game-mock.html:3-12). It stubs `net.request` and fabricates m.* frames; the default way to build/screenshot in-match UI without a match. `/dev/render-demo.html?scene=prep|<recording>|stress` for the engine; `/dev/uikit.html` for components.
- Unit UI tests import client modules straight into Node with fakes (fake Web Audio in ui/audio.test.js, fake DOM events in ui/devices.test.js, `test/render/fakepixi.js` for PIXI + canvas). There is no jsdom. Keep new logic in pure modules (gameLogic.js style) so it is testable.

## 13. Recipes, storage keys, debug hooks

| Change | What must move together |
|---|---|
| New stylesheet | `<link>` in public/index.html:31-46 (devices.css stays last) and in any dev page that renders the screen (public/dev/game-mock.html:15-26); dead links fail test/client-static.test.js:174. Keep the literals tools/build-worker.mjs rewrites: `<html `, `src="/js/main.js"`, `</head>`, Google Fonts `<link>`s (:95-99) |
| New small touch control | add its class to the 44 px hit-area lists in css/devices.css:56-70 |
| New `g.*` / `room.*` request | C2S validator in shared/protocol.js:307 first (net.js:463,500 rejects unknown types locally as BAD_MSG), then `actions` (ui/gameActions.js:50) / `net.request`, then the server handler |
| New server push | add to S2C (shared/protocol.js:391-408), then `net.on(type, …)` in main.js `wireNet` (:214) |
| New data file | emitted by tools/build-data.mjs (docs/context/data-pipeline.md); served at `/data/<name>.json`; add to `GAME_FILES` (gameComponents.js:16) only if the match screen must wait for it; the Worker copies `data/*.json` (tools/build-worker.mjs:74) |
| New error text | shared `ERR_TEXT` (shared/constants.js:161) or `CLIENT_ERR_TEXT` (net.js:42); shown by `describeError` (toasts.js:94) |
| New saved setting | `loadPref/savePref/usePref` (store.js:185-205). Account-synced only if added to PREFERENCE_KEYS + `validPreference` (preferenceSchema.js:7-19); the Worker side of that is UNVERIFIED |

- **Storage keys.** sessionStorage `sp.token`, `sp.entered`; localStorage `sp.name`, `sp.tokens` (net.js:690-694), `sp.pref.<key>` (`settings`, `loadout`, `waiguan`, `lobby.mode`, `lobby.difficulty`, `recentRooms`, `emoteTheme`; preferences.js:109-117; lobby.js:160-273; emotes.js:32), `sp.accountPrefs.<accountId>` (preferences.js:27,85), `stronghold-resource-mode` (resources/index.js:18). Wrap storage access in try/catch like preferences.js:23-24 (private mode throws).
- **Debug hooks.** `globalThis.__SP__ = { store, net, data, audio }` (main.js:432); `globalThis.__SP_VIEW__` = guarded field view, `.raw.stats()` gives fps/units/particles (fieldHost.js:254); `audio.voiceLog` (audio.js:443); `window.__demo` in render-demo (render-demo.js:14-15). URL flags: `?render=fallback|engine`, `?board=2d|3d`, mock `?shot=1&phase=…&variant=…&players=5..8`.

## 14. Docs describing the client (line numbers verified 2026-10-06)

| Doc | Section (line) |
|---|---|
| docs/DESIGN.md | §8.3 view shapes :444; §9 render contract :469 (partial); §10 UI :500; §13 local art :534; §14 client-side combat :547; §15 3D board :592; §16 loadout :605 |
| docs/DESIGN.md | §17.1 Spine store :627; §17.3 FX :635; §18.1 picking :663; §18.4 battle sounds :687; §19.8 settings gear / phone HUD :822; §20.15 bond strip follows watched player :1058 |
| docs/DESIGN.md | §21.27 client fixes #5/#8 :1449; §21.28 match info :1461; §22.1 back-facing fall :1486; §22.5 emotes/guide without local client :1537; §22.16 loadout stats :1704 |
| docs/DESIGN.md | §23.13 skill idle clip :1855; §23.15 unit sound mix :1873; §23.16 hung model loads :1883; §23.17 shots/chest :1892; §23.19 spectator seats :1911; §25.1 skill clip with no Begin :2186 |
| docs/DESIGN.md | §26 phones :2197 (26.1 :2201, 26.2 slow link :2229, 26.3 :2236, 26.4 type floor :2250, 26.5 keyboards :2269, 26.6 wake lock/rotation :2276); §27 外援 :2309; §28 匹配 :2342 (28.2 Worker :2371) |
| docs/ASSETS.md | Operator voice :117; 外援 operator entries :185; manifest schema :230; Spine object :295; Roles :313; renderer rules from research 07 :372; other fallbacks :413 |
| docs/DATA.md | chess loadout choices §2.2 :202; waiguan.json §14b :486 |
| docs/ANDROID.md | 素材怎么用 :23; 构建 :38; 代码 :96 |
| docs/CLOUDFLARE.md | 资源包 :48; 公开对局观战 :74 |
| docs/ACCOUNTS-HISTORY.md | 账号偏好与跨设备同步 :34; 验证命令 :124 |
| docs/DEPLOY.md | 本地客户端素材 :247 |
| docs/PLAYING.md | 外援干员 :170; 表情与观战 :118; README.md 操作 :149, 开发与测试 :184 |
| docs/research/ | 06-multiplayer-ux.md (HUD look), 07-assets.md (Spine roles), 09-ux-official.md (interaction rules) cited throughout DESIGN |

## 15. Open questions / UNVERIFIED

- UNVERIFIED: no Chrome on this machine, so no browser/e2e suite was run; only Node-side tests (section 12).
- UNVERIFIED: how a bought 外援 piece resolves in match UI. In-match lookups read only data/chess.json (gameComponents.js:36), which holds the 8 empty `chess_char_{5,6}_diy{1,2}_{a,b}` templates and 0 `chess_char_diy_*` records (grep/python on data/chess.json); no client merge of waiguan records outside loadoutModel/loadout.js (grep of public/js). If shop cards or hand pieces show blank names/art, or `pieceCharId` (gameLogic.js:1043) returns null (no deploy voice, no leader pick), start there. Battle units are unaffected (UnitInfo carries `spine`).
- UNVERIFIED: whether adding a sim kit changes the replay rules version (shared/rules-version.js:1 defaults 'development-v1'; runner.js:210-214 loads an older engine when `b.start` names other rules; replay-versions.json pins engines). That is a server/sim concern; check docs/ACCOUNTS-HISTORY.md:89 before shipping sim changes.
- UNVERIFIED: unrelated debug residue `globalThis.__SP_DBG_PICKS` console.log in ui/loadoutSync.js:136 (harmless, off unless set).
