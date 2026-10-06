# Assets pipeline: agent context brief

Scope: everything that downloads, post-processes, indexes, packs or bundles game art, audio and fonts. Written 2026-10-06 by reading the code in this worktree (node v22.22.0). `file:line` cites this tree. Anything not confirmed is marked UNVERIFIED. Full human docs: `docs/ASSETS.md` (index at the bottom).

## 1. Shape of the system (read this first)

- `node tools/fetch-assets.mjs` (= `npm run assets` after `tools/vendor.mjs`, package.json:32) is the only thing that writes `data/assets.json`. It reads 4 committed research JSONs + 3 cached upstream indexes + optional `data/{enemies,tokens,bosses}.json` + `tools/assets/waiguan-operators.json` (fetch-assets.mjs:224-262), builds a plan, downloads, post-processes Spine and fonts, resolves the plan against what is on disk (fetch-assets.mjs:298), and writes the manifest only if the shrink guard allows (316-317).
- Art, audio, fonts are never committed. The manifest and two JSON side files are (section 2, item 1).
- Run order in `main()`: research JSONs (224) -> indexes (230) -> voice index (233-240) -> data/*.json (243-246) -> local enemy spines (247) -> waiguan file (250-252) -> `buildPlan` (253) -> `--dry-run` exit (268) -> `downloadLeaves` (278) -> fonts (280-290) -> `processModels` Spine (293) -> `resolveTemplate` (298) -> manifest + shrink guard (305-317) -> orphans/`--prune` (321-322) -> report (326-342) -> summary + exit code (345-377).

## 2. Facts agents get wrong

1. **What is committed.** Gitignored: `public/assets/` (.gitignore:8), `public/fonts/` (9), `data/local-assets.json` (12), `.cache/` (14), `/stronghold-resources-*.zip` (16), `public/resource-manifest.json` (50), `android/app/src/main/assets/game/` (57). Committed (`git ls-files`): `data/assets.json`, `tools/assets/waiguan-operators.json`, `tools/assets/local-enemy-spines.json`. Never `git add` anything under public/.
2. **`data/assets.json` is ONE minified line** (1.2 MB, `wc -l` = 1): written without indent (fetch-assets.mjs:317 -> 119-123; only the report uses indent 1, 342). Inspect with `node -e`, not by line range. Its diffs are one line.
3. **Counts in docs are stale.** The real manifest (`data/assets.json` `stats`, 2026-10-06): files 9928, bytes 554,499,781, chars 216, charsWithBack 213, enemies 252 (251 with Spine), tokens 55 (38 with Spine), spineModels 710, bonds 23, items 59, bands 40, skills 543, ui 601, sfxUnits 487, voice cn 198 / jp 198. `stats.files`/`bytes` exclude fonts (distinct `/assets|/fonts` URLs = 9935 = 9928 + 3 faces x 2 files + fonts.css). Size claims disagree everywhere (ASSETS.md:52 "327 MiB / 6,900 files"; `.gitignore` "~270 MB"; make-resource-pack.sh "~340 MiB"; ANDROID.md:43 "~430 MB"); `public/assets` here is 623 MB including `local/`. Trust `stats`, not prose.
4. **Waiguan roster is 78 operators in the file, not 87.** 87 are the candidates in `data/waiguan.json`; the generator skips the 9 already in research 07 (gen-waiguan-operators.mjs:79-81, 142). `chars` 216 = 138 (07) + 78. ASSETS.md:99 and :187 say 87. The file also has 25 `tokens` (no Spine paths, only skin-variant names).
5. **Waiguan URL order contradicts its own comment.** plan.mjs:308-311 and ASSETS.md:192-195 say the reachable jsDelivr URL is tried first. Verified by running `buildPlan` (scratch script): avatar/portrait/skill-icon alts are `[raw, jsDelivr]` because `urlsOf` (plan.mjs:311) puts `mirror` first and the generator stores the raw URL in `mirror` (gen-waiguan-operators.mjs:97). Their Spine files are jsDelivr-ONLY (`fexliModel` reads `.url` only, plan.mjs:280; `mirrorUrl` of a jsDelivr URL is null). Pool operators (research 07): raw first, then derived jsDelivr.
6. **Enemy Spine is NOT from fexli.** fexli = operator + token Spine; enemy Spine = isHarryh/Ark-Models (premultiplied alpha, `pma: true`, plan.mjs:393-411). Avatars/icons = yuanyan. Bonds/items/bands/UI/emotes/guide = ArknightsAssets2 `cn`. All audio = ArknightsAssets2 `voice` branch (sources.mjs:10-18).
7. **Audio has no mirror.** `mirrorUrl` returns null for owner `ArknightsAssets` + branch `voice` (sources.mjs:32; comment says jsDelivr 404s there, UNVERIFIED by me). BGM, SFX and voice (~2,880 voice files, ASSETS.md:53) only come from raw.githubusercontent.com.
8. **Tokens: fexli mostly has only skin variants.** Manifest: 37 of 55 tokens carry `spineVariant`, 1 has a default model, 17 have no Spine. Research 07: 12 of 20 pool tokens are `battleSpineSkinVariantsOnly`, 1 has `battleSpineDefault`. Resolution (plan.mjs:359-381): default model, else `spine/<tokenId>/<variant>/{Spine,Front}/<variant>.*` (first folder that exists). Tokens unknown to 07 and absent from the waiguan file get a guessed variant = their own id (361-365) which 404s -> "no spine", tolerated. `gen-waiguan-operators.mjs` keeps `tokens` verbatim from the committed file (130-140): regenerating operators does NOT refresh token variants; they were read off a `git ls-tree` listing by hand.
9. **Exit code 1 is narrow.** Only (a) a research-07 operator (138) missing avatar/portrait/Front Spine (fetch-assets.mjs:174-183, 324), (b) the manifest was refused by the shrink guard (377), (c) a thrown error `[assets] FAILED:` (383-386; `DEBUG=1` prints the stack). Everything else is exit 0. Known permanent misses (`.cache/assets-report.json`, this worktree, exit 0): `enemy_5601_entlec` icon, 10 token skeletons (`token_10054/10055/10059/10060/10061/10064/10066/10068/10069/10070`), `token_10055_phatm2_mndclv` avatar, skills `skchr_huang_1`/`skchr_lessng_1`; `enemy_9016_acstmr` has no Spine.
10. **Atlases are rewritten in place** (`size:`, `pma: true`, page renames; spine.mjs:180-185), so they are `mutable` jobs: kept when they validate, never size-compared (plan.mjs:289, 409; downloader.mjs:91-94). An upstream atlas change is not picked up without `--force`.
11. **The ledger is not an inventory.** A skipped file with no ledger entry is not recorded (downloader.mjs:145-146, 164): 3,034 ledger entries for 9,928 files here. Deleting the ledger is safe; files are then kept only if they validate (98-99).
12. **`--voice=cn`, `--voice=none` or a failed `charword_table.json` download DROP voice entries.** A load failure only logs `[voice] skipped` (fetch-assets.mjs:239) and the plan then has no `audio.voice`; `--voice=cn` drops all `jp` lists. The shrink guard then refuses the manifest (exit 1) unless `--allow-shrink`. Inferred from 233-239 + 316 + `droppedEntries`; I did not run it. Do not add `--allow-shrink` to get past a failure you did not intend.
13. **`fetch-assets-retry.mjs` builds a different plan** than the main script: no `voice`, no `extraTokens` (retry:54-61 vs fetch-assets.mjs:253-262), `loadLocalEnemySpines(ROOT)` gets a directory so returns `{}` (retry:59 -> spine.mjs:106-111, harmless), needs cached indexes (`offline: true`, retry:46), writes files directly with no ledger, and `--only waiguan` is a substring match on the rel path (72). It never retries voice or waiguan tokens: re-run `fetch-assets.mjs` for those.
14. **`tools/fetch-local-art.mjs` does not exist** (no reference anywhere in the repo). Local-client art is the Python `tools/local-extract/extract.py`, run via `node tools/setup.mjs --local` (setup.mjs:23, 337).
15. **`--dry-run` is not offline.** It runs after the index/voice loading (fetch-assets.mjs:230-271), which downloads missing cache JSONs. `--offline` throws if a cached index is missing (cache.mjs:22-25).
16. **The plan depends on built data, and data depends on the manifest.** `data/enemies.json`, `tokens.json`, `bosses.json` add enemy/token ids to the plan (fetch-assets.mjs:243-246, plan.mjs:354, 415); `tools/build-data.mjs` reads `data/assets.json` for enemy `attackAnim` (build-data.mjs:346-352, 2173; ASSETS.md:309-311). After a manifest change that touches enemy clips, rerun `npm run build-data`.
17. **Enemy aliases**: 8 enemies have `spineAliasOf` (`enemy_1305_mhslim`, `_2` -> `enemy_1007_slime` because Ark-Models lists them with an EMPTY `assetList`, plan.mjs:29-46; six `_2` variants -> base). `spineLocal` for the two worms comes from the committed `local-enemy-spines.json`, never from disk (fetch-assets.mjs:190-215), so the manifest is identical with or without the local extraction.

## 3. Where to look

| Need | File:line |
|---|---|
| CLI flags, exit codes, report fields | tools/fetch-assets.mjs:58-71 (HELP), 78-95 (parseArgs), 326-342 (report), 373-377 |
| Shrink guard | fetch-assets.mjs:106-109 `shrinkGuard`; tools/assets/manifest.mjs:150-180 `droppedEntries` |
| What files are planned, URLs, local paths | tools/assets/plan.mjs:270-580 `buildPlan` |
| UI sprite extras, guide pages, emotes | plan.mjs:57-61 `GUIDE_PAGES`, 72-103 `UI_EXTRAS`, 106-109 `ARTS_GROUPS` |
| Enemy id set | plan.mjs:213-242 `collectEnemyIds`; skill indices 186-204 |
| Sources, mirror mapping, `safeName`, `assetUrl` | tools/assets/sources.mjs:10-18, 27-34, 61, 71 |
| Download engine, ledger, retries | tools/assets/downloader.mjs (219 lines); leaf rounds manifest.mjs:53-73 |
| Index cache (audio_data, models_data, charword_table) | tools/assets/cache.mjs:21-47, 55, 78 |
| Spine processing, local enemy overlay | tools/assets/spine.mjs:129-228 `processModels`; 34-111 local helpers |
| Atlas normalizer, skel parser, role resolver | atlas.mjs:71 `normalizeAtlas`; skel.mjs:64 `parseSkel`; anim-roles.mjs:247 `resolveRoles` (precedence in header 15-40) |
| Audio banks, UI/battle SFX tables | tools/assets/audio.mjs:24 `assetToPath`, 42 `bankMix`, 70 `indexAudio`, 150 `pickUnitSfx`, 188 `UI_SFX`, 247 `BATTLE_SFX` |
| Operator voice | tools/assets/voice.mjs:15 `VOICE_LANGS`, 24 `VOICE_ROLES`, 42 `parseVoiceLangs`, 79 `voiceLines` |
| Fonts + WOFF2 | tools/assets/fonts.mjs:13-17 `FONTS`, 35 `buildFonts`; woff2.mjs |
| Format validators | tools/assets/formats.mjs:94 `validate`, 112 `kindOf` |
| Waiguan roster entries | tools/assets/waiguan-operators.json; tools/gen-waiguan-operators.mjs; tools/probe-waiguan-assets.mjs |
| Missing-file recovery | tools/fetch-assets-retry.mjs |
| Resource manifest + ZIP | tools/resource-pack.mjs:43 `validateManifest`, 66 `buildResourceManifest`, 96 `writeResourcePack` |
| Workers build (copies assets, cuts ZIP into parts) | tools/build-worker.mjs:55 `copyRuntimeAssets`, 137 `missingAssets`, 154 `buildWorker`, 208 `writePackParts` |
| Android bundle | tools/build-android.mjs (107 lines), docs/ANDROID.md:43-52 |
| Client consumers | public/js/assets.js, public/js/ui/assetUrls.js, public/js/audio.js, public/js/data.js:35 |
| Local-client extraction (Python) | tools/local-extract/extract.py (`ENEMY_SPINES` :109), tools/setup.mjs |

## 4. Commands

```bash
npm install                                  # postinstall = tools/vendor.mjs (package.json:33); fetch-assets needs @pixi-spine/runtime-3.8 (fetch-assets.mjs:222)
npm run assets                               # vendor + full fetch; first run is large, re-run ~1 s (ASSETS.md:52-54)
node tools/fetch-assets.mjs --dry-run        # plan counts + notes, no downloads (still loads indexes)
node tools/fetch-assets.mjs --offline        # re-post-process disk, rebuild manifest; needs cached indexes
node tools/fetch-assets.mjs --voice=cn,jp    # default; also cn | jp | none (see item 12)
node tools/fetch-assets.mjs --refresh-index  # re-download audio_data / models_data / charword_table
node tools/fetch-assets.mjs --force          # re-download everything (also the only way to refresh atlases)
node tools/fetch-assets.mjs --concurrency=8  # 1-64, default 16 (fetch-assets.mjs:82)
node tools/fetch-assets.mjs --prune          # delete orphans (never public/assets/local/**); implies --allow-shrink
node tools/fetch-assets.mjs --allow-shrink   # write a smaller manifest on purpose (mapping change)
node tools/fetch-assets.mjs --local-spines   # rewrite tools/assets/local-enemy-spines.json from extracted models
node tools/fetch-assets-retry.mjs [--rounds N] [--only missing|waiguan] [--concurrency N] [--dry-run]   # then fetch-assets again
node tools/gen-waiguan-operators.mjs [--probe FILE] [--verify]   # after tools/probe-waiguan-assets.mjs [--spine-sample N]
npm run resources:manifest | resources:pack | resources:zip       # package.json:42-44
node tools/resource-pack.mjs --out=.         # ZIP into DIR; default is .cache/stronghold-resources-<12hex>.zip
npm run build:worker                         # package.json:37; auto-runs fetch-assets if any manifest URL is missing
SP_SKIP_ASSETS=1 npm run build:worker        # skip that auto-download only (build-worker.mjs:159, 172-174)
node tools/build-android.mjs [--server=URL] [--lite]   # npm run android:assets
node --test test/assets.test.js test/fetch-assets-shrink.test.js   # 54 pass, 0 skipped here (~15 s)
```

Behind a proxy: `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 node tools/fetch-assets.mjs` (Node's `fetch` honours the proxy only with that flag; used in scripts/make-resource-pack.sh:9, .bat:11, docs/CLOUDFLARE.md:53). It prints a harmless `UNDICI-EHPA` experimental warning. In this sandbox (proxy preset, `NODE_EXTRA_CA_CERTS` set) a HEAD of a raw.githubusercontent.com file returned 200 both with and without the flag, so the flag was not needed here.

## 5. Transient mirror failure vs permanent miss

| | Transient (re-run fixes it) | Permanent (404 on every source) |
|---|---|---|
| Per-job status | `error`, text like `HTTP 502 <url>`, `truncated body a/b <url>`, `invalid png payload (N B) <url>`, `fetch failed`, `operation was aborted due to timeout` (downloader.mjs:119-133) | `miss`: "not found (404) on all sources" (170) |
| Progress line | `[files] n/m ok=.. skip=.. miss=.. err=N` with `err` > 0 (downloader.mjs:192) | `miss=N` |
| Summary | `errors N` (fetch-assets.mjs:348); `download errors (N, re-run to retry): ...` (356) for plain files | `missing (N, omitted from manifest; client uses fallbacks):` (357-358) |
| Spine models | NOT in `downloadErrors`: shows as `spine notes`: `<key>: missing skel` / `missing/invalid page` (spine.mjs:168, 176) plus `err=` in the `[spine]` progress line | same `missing skel` text: tell them apart by `err=` vs `miss=` |
| Consequence | entry missing -> shrink guard: `ERROR: data/assets.json NOT written - it would lose N entries ...` (368), `manifest: ... (kept)` (372), exit 1 (377); report `manifestWritten:false`, `droppedEntries[]` | omitted from manifest, exit 0 unless it is a required operator asset or already in the committed manifest |

- Fix: re-run the same command until `errors 0` and `manifestWritten: true`. It is idempotent and skips present files. A leaf with fallbacks (e.g. enemy icon -> base id) only moves to its fallback after a definitive 404, so a transient error never puts a fallback file at the primary's path (manifest.mjs:41-52, 64).
- Persistent on a network where raw or a jsDelivr host fails: `node tools/fetch-assets-retry.mjs`, then `fetch-assets.mjs` to write the manifest (ASSETS.md:206-212). `fastly.jsdelivr.net` failed TLS in the author's network; the retry script rotates `cdn`, `gcore`, `b-cdn` (retry:35).
- An index download that fails after 3 tries per source aborts the run: `[assets] FAILED: cannot fetch <url>: ...` (cache.mjs:28-47).
- Downloader numbers: 16 parallel (clamped 1-64, :49), 3 attempts per source (:46, 50), 120 s timeout (:46), backoff 400 ms x 2^(n-1) + jitter (:133), retry on every non-OK except 404/410 (:115-121), body vs `content-length` check (:124-128), `validate(kind)` (:129), atomic `<rel>.part<pid>` rename (:156-159), ledger saved every 200 writes and at the end (:207-216). Fonts use their own Downloader, concurrency 4, `fonts-ledger.json` (fetch-assets.mjs:283).

## 6. `buildPlan` inputs (plan.mjs:270)

| Param | Source | Notes |
|---|---|---|
| `assets07` | docs/research/07-assets.json | 138 operators, 20 tokens, 200 enemies, bonds/items/bands, `autochessUi`, `arts` |
| `ops03` | docs/research/03-operators.json | skill indices (186-204), token owners (351, 366), enemy ids inside kits (217-220) |
| `enemies05`, `maps05` | docs/research/05-enemies.json, 05-maps.json | `collectEnemyIds` (213-242); tutorial levels excluded (223) |
| `audio` | `indexAudio(audio_data.json)` | cached `.cache/gamedata/excel/audio_data.json` |
| `modelsData` | Ark-Models `models_data.json` | `.cache/ark-models/`; `arkModel()` plan.mjs:396 |
| `extraEnemyIds`, `extraTokenIds`, `extraHandbook` | keys of `data/enemies.json`, `data/tokens.json` (`token_\d+_...` only, 354), `data/bosses.json` enemyKey->handbookId | fetch-assets.mjs:243-246 |
| `voice` | `{ index, langs, rules }` or null | `rules` = `audio_data.json` `battleVoice` -> manifest `audio.voiceRules` (plan.mjs:575-578) |
| `localEnemySpines` | committed `local-enemy-spines.json` `models` | adds `enemies[id].spineLocal` via `literal()` (plan.mjs:444-448) |
| `extraOperators` | `waiguan-operators.json` `.operators` (78) | merged OVER research entries (plan.mjs:303), so a thinner entry drops E2 art/skill SFX; hence the generator skips overlaps |
| `extraTokens` | `waiguan-operators.json` `.tokens` (25) | research 07 entry wins: `assets07.tokens[id] ?? extraTokens[id]` (359) |

- Returns `{ template, models, notes }`. Template leaves: `{ alts: [{rel, urls[], kind, bytes?, mutable?}] }` (first alt that lands on disk wins), `{ model: key }` for a Spine in `plan.models`, `literal(v)` emitted as is (plan.mjs:4-9; manifest.mjs:25).
- Scope: all skill indices of every operator get icons + skill SFX (plan.mjs:314-315); BGM files are flattened to `audio/bgm/<basename>` (517-523); `combatAlts` order is pinned by test/ui/audio.test.js (plan.mjs:531-536); `unite` BGM is optional (525-529).
- Local paths (ls-verified): `char/avatar/<id>.png`, `_2.png`; `char/portrait/<id>_1.png`; `spine/{op/<id>/{front,back},token/<id>,enemy/<id>}/<stem>.{skel,atlas,png}`; `enemy/icon`, `token/avatar`, `bond`, `item`, `band`, `skill`, `prof`, `ui/<group>/<key>.png`; `audio/sfx/<path>`, `audio/bgm`; `voice/<cn|jp>/<wordKey>/cn_NNN.mp3` (upstream folder dropped, plan.mjs:565). `[uc]` in upstream paths becomes `_uc_` locally (`safeName`).
- Skeleton stem is the upstream name, skel and atlas share it (pixi-spine finds the atlas by swapping the extension; plan.mjs:288, ASSETS.md:95).

## 7. Sources (sources.mjs:10-18) and mirrors

| Key | Base | Used for |
|---|---|---|
| `yuanyan` | raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/ | avatars, portraits, skill icons, enemy icons, token avatars |
| `fexli` | .../fexli/ArknightsResource/main/ | operator Front/Back Spine, token Spine (default or skin variant) |
| `arkModels` | .../isHarryh/Ark-Models/main/ | `models_data.json`, `models_enemies/<key>/` enemy Spine |
| `aa2` | .../ArknightsAssets/ArknightsAssets2/cn/assets/dyn/ | `UI_EXTRAS`, battlecard icons, emotes, guide pages; bond/item/band URLs come from research 07 |
| `aa2voice` | .../ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/ | BGM, SFX, voice; no mirror |
| `fonts` | .../TimWangZi/The-font-of-Arknights/master/font/ | Bender x2, Novecento Wide |
| `gamedata` | .../Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/ | `excel/audio_data.json`, `excel/charword_table.json` |

- `mirrorUrl`: `raw.githubusercontent.com/<o>/<r>/<branch>/<p>` -> `cdn.jsdelivr.net/gh/<o>/<r>@<branch>/<p>` (sources.mjs:27-34). The downloader tries each candidate URL, then its mirror (downloader.mjs:148-149). jsDelivr refuses to list these repos (50 MB package limit), so no authoritative sizes exist for Spine files (ASSETS.md:196-199).
- AA2 paths contain `[uc]`, `[pack]`; `joinUrl` percent-encodes each segment (sources.mjs:41-53).

## 8. Spine, audio, voice, fonts

- **Spine** (`processModels`, spine.mjs:129-228): download skel/atlas/pages (134-135) -> fetch extra atlas pages the index omits (136-153) -> normalize atlas against real PNG sizes, rewrite in place (169-185) -> parse skel with `@pixi-spine/runtime-3.8` (194) -> `resolveRoles` (209) -> entry `{skel, atlas, textures, pma, anims, animations, events, hits, bounds}` (210-220). Parse cache `.cache/spine-info.json` is keyed by `rel|skelSize|skelMtime|atlasSize|atlasMtime` (189), rewritten each run with only current models (206, 223-224). A skeleton that fails to parse is deleted and its ledger entry removed so the next online run re-downloads it (197-203; test/assets.test.js:430).
- **Audio** (audio.mjs): banks from `audio_data.json` `soundFXBanks` (alias depth 4, :70+). `pickUnitSfx` roles attack/hit/die/born; operators take normal-mode banks only (files ending `_d/_h/_s` are skill modes, :141-143) with their projectile banks as fallback. `bankMix` -> `sfx.units[id].mix {p?, vol?}` (:42). Up to 4 alternatives per sound (plan.mjs:138).
- **Voice** (voice.mjs): only in-battle lines by official `placeType` (VOICE_ROLES :24-33): select, deploy, combat (4), start, win3, win, fail = 7 roles. `cn` prefers CN_MANDARIN -> LINKAGE -> JP, `jp` prefers JP -> LINKAGE (:15-19); dirs `voice_cn/` or `voice/` (:21). Default `cn,jp` (:35). Operators without a `voiceLangDict` entry get none.
- **Fonts**: 3 files from TimWangZi -> built-in WOFF2 encoder -> `public/fonts/fonts.css`; manifest `fonts.{css,faces}` (fetch-assets.mjs:303).
- **Manifest build**: `resolveTemplate` drops leaves whose files are missing and empty containers (manifest.mjs:104, 119); `tidyManifest` removes dangling `spineAliasOf`, `spineVariant`, `skillsById` and empty `spine` (fetch-assets.mjs:138-145); `hash` = first 12 hex of sha1 of the body (without version/hash/generator/stats; manifest.mjs:146-148, fetch-assets.mjs:299-311); `MANIFEST_VERSION` = 1 (manifest.mjs:13).

## 9. `data/assets.json` structure (verified against the file)

Top-level keys in order: `version, hash, generator, stats, chars, enemies, tokens, bonds, items, bands, skills, skillsById, ui, prof, audio, fonts`.

| Key | Shape |
|---|---|
| `chars` | `{ [charId]: { avatar, avatarE2?, portrait, portraitE2?, spine: { front, back? } } }`, 216 ids |
| `enemies` | `{ [id]: { icon, spine?, spineAliasOf?, spineLocal? } }`, 252 |
| `tokens` | `{ [id]: { owner, avatar?, spine?, spineVariant? } }`, 55 |
| `bonds`, `items`, `bands`, `skills` | `{ id: '/assets/...png' }` (23 / 59 / 40 / 543); `skillsById` skillId -> iconId (545) |
| `ui` | `{ 'group/key': url }` (601); includes `emoticon/<dir>/<picId>` and `guide/<key>` |
| `prof` | `{ icon, large, battlecard (incl. token), sub }` |
| `audio.bgm` | `lobby, prep, combat, boss, combatAlts[], unite` each `{ intro?, loop }`; `audio.bossBgm.boss_1..boss_10` |
| `audio.sfx` | `ui` (55 names), `battle` (10), `units` (487: `attack, hit, skill, skills{idx}, die, born, mix`) |
| `audio.voice` | `{ cn|jp: { charId: { select[], deploy[], combat[], start, win3, win, fail } } }` (198 each); `audio.voiceRules` |
| `fonts` | `{ css, faces: { name: { family, weight, original, woff2 } } }` |
| Spine object | `{ skel, atlas, textures[], pma, anims, animations{name:sec}, events[], hits{anim:[sec]}, bounds }` (ASSETS.md:295-307; Roles 313-343) |

All values are site-root URL paths (`/assets/...`). Only entries whose files exist are emitted, so every consumer needs a fallback (ASSETS.md:232). Schema doc: ASSETS.md:230-293.

**Shrink guard.** `droppedEntries(prev, next)` lists every leaf (string, number, flag, null, or whole array) of the committed manifest absent from the rebuilt one; build fields `version/hash/generator/stats` and additions are never drops; a leaf that became an object (or the reverse) is not a drop (manifest.mjs:150-180). `shrinkGuard` writes only when nothing is dropped, or with `--allow-shrink`/`--prune` (fetch-assets.mjs:106-109). On refusal the old file is kept, report has `droppedEntries`, exit 1. Born from PR #7 (42 audio entries lost, ASSETS.md:28-35). Tests: test/fetch-assets-shrink.test.js:17, 37, 74, 90.

## 10. `.cache/` and `public/` layout (all gitignored)

| Path | Written by | Contents |
|---|---|---|
| `.cache/assets-ledger.json` | downloader | `{ files: { rel: { url, bytes } } }`, only files this tool downloaded |
| `.cache/fonts-ledger.json` | fonts downloader | same for fonts |
| `.cache/spine-info.json` | spine.mjs:223 | `{ skelRel: { key, info } }`, 710 entries here |
| `.cache/assets-report.json` | fetch-assets.mjs:342 | downloadedBytes, totals, stats, requiredMisses, misses, downloadErrors, fallbacks, spineProblems, fontErrors, orphans, pruned, manifestWritten, droppedEntries, notes |
| `.cache/gamedata/excel/{audio_data,charword_table}.json`, `.cache/ark-models/models_data.json` | cache.mjs | upstream indexes (charword ~11 MB) |
| `.cache/waiguan-assets-probe.json` | probe-waiguan-assets.mjs | HEAD byte counts for the generator |
| `.cache/stronghold-resources-<12hex>.zip` | resource-pack.mjs:99 | reused by the worker build (build-worker.mjs:212-214) |
| `public/assets/{char,enemy,token,skill,bond,item,band,prof,ui,spine,audio,voice}/` | fetch-assets | manifest-referenced files |
| `public/assets/local/**` + `data/local-assets.json` | tools/local-extract | optional; never pruned (fetch-assets.mjs:321). Observed here: `local/` has emoticon, guide, map, mesh, module, projectiles, ui but NO `data/local-assets.json` and no `local/spine` |
| `public/fonts/` | fetch-assets | `*.otf|ttf|woff2`, `fonts.css` |

## 11. Resource pack, Worker, Android

- **`tools/resource-pack.mjs`**: walks `public/assets` and `public/fonts` (symlinks skipped :74; extensions outside `RESOURCE_TYPES` skipped :14-19, :78), so `public/assets/local/**` is included. File entry `{ url (segments percent-encoded), size, sha256, type }`, sorted by url (:89); `version` = sha256 of the file list (:90); validation: `^/(assets|fonts)/`, no `..`, unique, <= 25 MiB per file, totalBytes matches (:11, 26, 43-58). Writes `public/resource-manifest.json` (gitignored). `writeResourcePack` writes a STORED zip (:119) and refuses a path inside `public/` (:101-102).
- **Worker build** (`buildWorker`, build-worker.mjs:154-201): vendor -> `missingAssets` (URLs in `data/assets.json` absent under public/, :137-152) -> run `tools/fetch-assets.mjs` if any (:159-164; a non-zero exit throws) -> replay versions -> `buildResourceManifest` (must contain `/assets/` files or throws, :172-174) -> `copyRuntimeAssets` (:55-134: `dist/client`, public minus `dev|assets|fonts` and zip/log/map :67-68, resource files copied from the manifest :69-73, `_headers` :101-119 with day-long cache for `/assets` + `/fonts`, 25 MiB per-file and 100,000-file limits :127, 132) -> `writePackParts` (:208-239: 24 MiB parts `dist/client/pack/<12hex>/part-NNN.bin` + `pack/index.json`) -> bundle. `data/local-assets.json` is published only if the manifest lists every file it names, else build fails; no local extraction publishes an empty stub (:78-89). `worker/pack.js:10-11` serves `/stronghold-resources.zip` and `/pack/index.json`. Client: `public/js/resources/store.js:14` fetches `/resource-manifest.json`. UNVERIFIED: how the plain Node server gets `public/resource-manifest.json` (nothing under `server/` references it; run `npm run resources:manifest`).
- **Android** (`tools/build-android.mjs`): fetches `<server>/resource-manifest.json` (default `https://stronghold.lunar.ag`, :20, 61), wipes `android/app/src/main/assets/game/` (:66), for each `/assets|/fonts` entry hard-links (else copies) the local `public/` file when size AND sha256 match, otherwise downloads (3 attempts, sha256-checked, :41-56, 72-85), 8 in parallel (:21), writes `manifest.json` `{format, server, version, files}` (:98), exit 1 if any file failed (:101-104). `--lite` bundles nothing (:60, 71). So Android assets come from a DEPLOYED server's manifest, not from `data/assets.json`. Tests: test/android.test.js:36, 44.
- **Resource ZIP for friends**: `scripts/make-resource-pack.sh|.bat` = vendor + fetch-assets + `resource-pack --out=.` (no local-client art; docs/CLOUDFLARE.md:50-53).
- `tools/setup.mjs` step 5 runs fetch-assets when `public/assets` is missing or incomplete; failure is only a warning (setup.mjs:409-423); `tools/doctor.mjs:187-189` reports the same check.

## 12. Tests

| Test | Covers |
|---|---|
| test/assets.test.js (759 lines) | pure helpers: role resolver :34, atlas :163, formats :203, WOFF2 :238, audio banks + plan id sets :292, downloader on a fake network :369, emotes/guide plan :478, voice :696. On-disk checks :534-694 run only if `data/assets.json` AND `public/assets` exist (else skipped): every manifest path exists, pool operators complete, atlas `size:`/`pma`, every Spine loads like the client, BGM/SFX present |
| test/fetch-assets-shrink.test.js | `droppedEntries`, `shrinkGuard`, `--help` lists `--allow-shrink` (95 lines) |
| test/render/assets.test.js, test/ui/assetUrls.test.js, test/ui/audio.test.js | client URL helpers against the real manifest |
| test/worker-build.test.js:7, 54, 98; test/worker/pack.test.js:71; test/resources/resources.test.js:80, 90 | worker static build, `_headers`, `missingAssets`, pack parts, resource manifest/ZIP |
| test/android.test.js:36, 44; test/static-local-art.test.js:37 | build-android constants; missing `local-assets.json` -> empty 200 manifest |
| test/docs-consistency.test.js:736 | ASSETS.md must still contain the `--allow-shrink` table row |

Run observed 2026-10-06: assets + shrink tests 54/54 pass; worker-build, pack, resources, android, static-local-art 40/40 pass.

## 13. `docs/ASSETS.md` index (473 lines)

| Lines | Section |
|---|---|
| 8-69 | Running: options table 16-26, shrink guard 28-35, idempotence 37-42, download behaviour 44-50, sizes 52-54, outputs 56-63, caches 65-69 |
| 71-115 | What is downloaded (table 73-93) and Id scope (97-115) |
| 117-183 | Operator voice (role table 123-129, battle voice rules 131-183) |
| 185-212 | Waiguan operator entries, URL order claim 192-195 (see item 5), flaky mirror 206-212 |
| 214-228 | Post-processing (atlas, skeleton, fonts) |
| 230-293 | Manifest schema; Spine object 295-307; Roles object 313-343 |
| 345-411 | Renderer rules from the manifest; Enemy aliases 380-411 |
| 413-436 | Other fallbacks, `data/chess.json` id lookup |
| 438-451 | Verification |
| 453-473 | Licensing and credits |

## 14. UNVERIFIED / not done

- I did not run `fetch-assets.mjs` end to end; pipeline outcomes cite the last `.cache/assets-report.json` of this worktree (ok 1947, skip 7984, miss 34 jobs / 14 leaves, error 0).
- Whether the working `data/assets.json` (rewritten 2026-10-06 19:12 by a local run) differs from HEAD: `git diff` not run.
- The jsDelivr-404-on-voice-branch claim rests on the code comment (sources.mjs:6-7, 31).
- Item 12 (voice option and manifest drops) is inferred from code, not executed.
- How `docs/research/{03,05,07}*.json` are produced: no generator found under `tools/` by my greps; not searched exhaustively.
- Android APK build and Gradle side not exercised.
