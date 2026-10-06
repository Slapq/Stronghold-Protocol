# Context: data pipeline (official tables -> tools/build-data.mjs -> data/*.json)

Scope: how `data/*.json` are produced, shaped and guarded. Verified 2026-10-06 at HEAD 4bd5b35 (worktree wgc, Node 22.22.0, Linux).
Line numbers are for that commit; `grep -n` the symbol if they drift. Field-by-field reference = `docs/DATA.md` (627 lines): read sections on demand (table in section 11).
Tags: UNVERIFIED = not checked here. "B:" = tools/build-data.mjs (3646 lines).

## 1. Facts agents get wrong

1. **Not every data/*.json comes from build-data.** B writes exactly 15: config chess bonds garrisons items bands effects choices enemies factions waves stages bosses tokens waiguan (B:3591, test/data.test.js:27).
   Others: `assets.json` <- tools/fetch-assets.mjs (header :6, MANIFEST :49); `emotes.json` <- tools/build-emotes.mjs (header :1; `--check`);
   `tuning.json` is HAND-MAINTAINED (its `_doc`; only result-title rules; read at server/match/gamedata.js:116, docs/META.md:639); `data/local-assets.json` is git-ignored, written by tools/local-extract (.gitignore).
   docs/DATA.md:3 ("all except assets.json are produced by build-data") is wrong for emotes.json and tuning.json.
2. **Never hand-edit the 15** (README.md:194, DATA.md:3-4). Change the cause, run `npm run build-data`, commit script change + regenerated files together. Causes live in: constants/rules inside B (fact 5), docs/research JSON, `server/sim/grid.js`, `shared/bandBonds.js`, `shared/waiguan.js`, `data/assets.json`, or upstream.
3. **The output is not a function of the upstream tables alone.** Extra inputs: `data/assets.json` (enemies.json `attackAnim`, B:349, B:2069; docs/ASSETS.md:309-311 "rebuild the data after a manifest change"), `server/sim/grid.js` (stages `groundPaths*`, `deployTiles`; B:37, DATA.md:30-31), `shared/bandBonds.js` (bands `bondIds`, B:3589), `shared/waiguan.js` (tier fields, B:1062).
   Reverse edge: tools/fetch-assets.mjs reads data/enemies.json, tokens.json, bosses.json, waiguan.json (:241-244), and tools/gen-waiguan-operators.mjs reads waiguan.json. Order after a roster change: build-data -> fetch-assets / gen-waiguan-operators -> build-data again if anims moved.
4. **Upstream is not pinned.** Source = Kengxxiao/ArknightsGameData `master` zh_CN (B:45); cache files carry no version stamp. Hard-coded counts in `validateAll` (23 bonds, 40 bands, 112 visible, 266 chess, 8 DIY templates; B:3414-3417, 3479) make a changed upstream fail loudly (exit 1, old data kept).
   Measured 2026-10-06: a cold download of all 58 files reproduced all 15 committed files byte-for-byte.
5. **Hand-curated facts live inside B, not in the game tables:** TRIGGER_DEVIATIONS :454 (+ ATTACK_RANGE_CHANGE :438), TOKEN_ABNORMAL :1363, SHOP_EXCLUDED_ITEMS :1687, ITEM_RULES :1707, HIT_AREAS :1985, STATIC_BODIES :2003, MODEL_SCALES :2029, BAND_SWAP_LPR :2090,
   BOUNTY_INITIAL_SETS/RULE/BOSS_GROUPS/HUNTER_GROUPS/RULE :2844-2892, SHOP_DRAFT :2906, TACTIC_DRAFT :2928, DEFAULT_ENEMY_MULTIPLIERS :3172, and literals in buildConfig (poolCopies, `bossHpScale.solo` 0.25, `timers.bandTurn` 30, titleRules; :3212-3388). Fix a gameplay fact by editing these, not the JSON.
6. **`.cache/` is git-ignored and absent in fresh clones/worktrees.** Here `.cache/gamedata/excel/` holds only audio_data.json + charword_table.json (voice index, tools/assets/cache.mjs:2-4), which satisfies nothing in the build: `--offline` dies with `missing cached file ... (offline mode)` (B:107); without `--offline` it downloads.
   Consequence: 5 data tests skip (data.test.js:121,194,984,1072,1110) and CI never has the cache (.github/workflows/ci.yml:28), so CI cannot detect stale data. Staleness is only caught on a machine with the cache or by running the check in section 3.
7. **Files are compact single-line JSON with no trailing newline** (`JSON.stringify`, B:3597; chess.json is one line, last byte `}`), so `git diff` is useless: compare with `jq -S` (section 3). emotes.json (52 lines, trailing newline, tools/build-emotes.mjs:113) and tuning.json (11 lines, indented) are formatted differently.
8. **chess.json holds only the shop chess (266) + 8 empty DIY slot templates** (`chess_char_{5,6}_diy{1,2}_{a,b}`: `isDiy`, no `stats`, `visible:false`, name `甄选干员`, B:808-810). The 87 外援 operators are only in waiguan.json and must never appear in chess.json (validate B:3461).
9. **Tier V waiguan records are overlays**: a tier V record = its tier VI twin + 9 fields `WAIGUAN_TIER_FIELDS` (chessId baseId goldenId tier identifier price sellPrice upgradeChessId status; shared/waiguan.js:20) and, on an ELITE, the module-level fields `WAIGUAN_ELITE_TIER_FIELDS` (stats trait talents module modules; shared/waiguan.js:30) that differ. Rebuild with `waiguanRecords(waiguan)` (shared/waiguan.js:75), never read `waiguan.chess` alone for tier V.
   Why: the tier V elite slot is 模组 equipLevel 1, tier VI 3 (charChessDataDict `chess_char_{5,6}_diy1_b`). B builds the tier V elite in full (buildWaiguan step 5, B:1271) and stores the diff; `validateAll` checks the overlay reproduces it. Checked: `chess_char_diy_5_char_225_haak_b` = module level 1, 2032 HP / 700 ATK (GEE-X +135/+37) vs tier VI 2137 / 720 (+240/+57). Normal records carry the inactive stub `{id, name, type, level 0, active false}` like pool normals (`null` for the 2 module-less operators). `rarity` 6, `garrisonIds` [], `bonds` derived (B:1110), `diyRequirement` 'TIER_6'.
10. **Waiguan `visible` is true** (B:859) although `isDiy`; it means "real fieldable operator". The shop pool excludes them through `isDiy`, not `visible` (DATA.md:529-533). `placement` is not a data field (validate B:3433; 高台 is decided at place time by shared/highGround.js).
11. **Token variants are keyed by owner chessId**, including the waiguan tier VI ids and the tier V ids (B:1255-1284: tier V normals mirror the tier VI normal's owner entry; tier V elites register their own level-1 module variant): tokens.json `variants` of a waiguan summoner has 4 keys (verified for `token_10002_kalts_mon3tr`). The `tokenOwnerOf` parameter of `chessRecord` (docstring B:770, use B:983) is never passed: its docstring is stale.
12. **Skill triggers have two fields**: `trigger.rule` (what the sim runs) vs `trigger.rawRule` (official row). Six 重装 skills + 余 S2 deliberately deviate (B:454-462, DESIGN §21.29 (docs/DESIGN.md:1469), §22.10 (:1595)); `validateAll` fails if a deviation stops meeting a TAKE_DAMAGE row (B:3481-3492).
13. **Size**: the build prints 5.42 MiB (5,685,493 bytes) for 15 files; waiguan.json 1,618,721 bytes (the tier V elite module overlays cost +193 KB). Hard cap 6 MiB (B:3663, data.test.js:60-67): headroom is 605,963 bytes (about 0.58 MiB).
14. **Research JSON are static snapshots** (no script in the repo writes them; 03-operators/05-maps/05-enemies/07-assets JSON were only ever committed once, 01/02/04 were edited later: 3/9/4 commits). B reads only 01, 02, 04, 05-maps, 07 (section 10); `03-operators.json` is not read by B (used by tools/assets, tests, `server/sim/nodeData.js:47` research fallback); `05-enemies.json` is loaded (B:333) but never consumed. 00-INDEX.md omits 08 and 09.
15. **Docs are test-pinned**: test/docs-consistency.test.js regex-matches literal phrases of DATA.md (:430, 462, 737, 843), tools/build-data.mjs (:825-840) and research .md. After editing those files run `node --test test/docs-consistency.test.js`.
16. **Rules version**: engines bundle the 15 files + tuning.json (worker/data-loader.js:5-22), so a data change that reaches the engine mints a new rules version at deploy (tools/build-replay.mjs header; docs/ACCOUNTS-HISTORY.md:91). assets.json and emotes.json do not (worker/data-loader.js:1-4).
17. **Determinism caveats**: candidate order uses `localeCompare(...,'zh')` (B:1151) and ids use `localeCompare('en',{numeric:true})` (B:263): needs a full-ICU Node (default since 13). Reproduced on Linux Node 22.22.0; Windows/Node 24 byte-identity UNVERIFIED (CI skips the rebuild test).

## 2. Where to look

| Need | Go to |
|---|---|
| Run / flags / exit codes | B:9-27 (header), B:55-77 parseArgs, B:3563-3646 main; `npm run build-data` (package.json:31) |
| Download + cache logic | B:102-132 ensureGamedata (4 attempts, JSON-validated, atomic rename), B:134 loadGamedata, B:160 levelPath |
| What official tables are read | B:290-326 loadContext |
| Blackboards `bb`/`bbStr`, `desc`/`descRaw` | B:201 flattenBB, B:238 resolvePlaceholders, B:257 textPair, B:179 stripRich |
| Auto-cast rule of a skill | B:454 TRIGGER_DEVIATIONS, B:481 resolveTrigger, B:516 buildSkill, DATA.md:196-238 |
| One chess record | B:776 chessRecord (shared by shop chess and waiguan), B:1009 buildChess |
| Waiguan roster | B:1037-1300 (buildWaiguan :1142), shared/waiguan.js, DATA.md §14b, DESIGN.md §27 |
| Summons | B:1303 tokenVariant, B:1381 buildTokens, DATA.md:460-484 |
| Invariants / errors | B:3404 validateAll, test/data.test.js, DATA.md:608 |
| Stage terrain / paths | B:2361-2627, server/sim/grid.js, DATA.md:411-445 |
| 机变 drafts (bounty/shop/tactic) | B:2760-3167, DATA.md:322-335, docs/META.md:115-158 |
| Assets manifest (not build-data) | tools/fetch-assets.mjs, docs/ASSETS.md |
| What a research file means | section 10 below, docs/research/00-INDEX.md |

## 3. Commands (run from repo root)

```
npm run build-data                         # = node tools/build-data.mjs ; downloads missing files into .cache/gamedata, writes data/*.json (15 files) + .cache/build-data-report.json
npm run build-data -- --offline            # never download; needs the full 58-file cache (contents listed below)
node tools/build-data.mjs --refresh        # re-download everything (exclusive with --offline)
node tools/build-data.mjs --no-research --out /tmp/x     # research-free build, other dir (fallback defaults, warnings)
node tools/build-data.mjs --cache DIR --out DIR --report FILE --quiet
node tools/build-data.mjs --force          # write even when validateAll fails (debug only; default keeps old files)
node --test test/data.test.js              # 38 tests; without the cache 33 pass, 5 skipped
node tools/build-emotes.mjs --check        # emotes.json up to date? (verified: "up to date (6 themes, 36 emotes)"; downloads display_meta_table.json if uncached)
node --test test/docs-consistency.test.js  # after touching DATA.md / build-data.mjs text
```
Exit codes: 0 ok; 1 integrity errors (B:3639) or crash (B:3645); 2 bad CLI (unknown option, missing value, `--refresh --offline`; B:74-83). `--help` exits 0 (B:64).
Output files: `<out>/<name>.json` via temp + rename (B:3606-3611). `loadManifest` always reads `<repo>/data/assets.json`, even with `--out` (B:349).

**Byte-identical check** (non-destructive; what data.test.js:989 does; needs the cache or network):
```
OUT=$(mktemp -d); node tools/build-data.mjs --offline --quiet --out $OUT --report $OUT/r.json    # drop --offline + add --cache $(mktemp -d) to test against current upstream (58 files, 71 MB, ~10 s)
for f in config chess bonds garrisons items bands effects choices enemies factions waves stages bosses tokens waiguan; do cmp $OUT/$f.json data/$f.json || echo STALE $f; done
diff <(jq -S . data/X.json) <(jq -S . $OUT/X.json) | head      # semantic diff (jq present here)
```
In-place alternative on a clean tree: `npm run build-data -- --quiet && git status --short data/` (empty = identical). Always commit data/ with the code that changed it.
Cache contents (measured): `excel/{activity,character,skill,range,uniequip,battle_equip,enemy_handbook}_table.json` + `levels/enemydata/enemy_database.json` + 44 files `levels/activities/act1autochess/level_*.json` + 6 files `.../act2autochess/` (h07_05, h07_05_s, m01-m04) = 58 files, 71 MB.
Current-data build log: 1 warning, expected: the stage-name annotation drop (act1autochess_m01). (The 8 "token ... of skill ... is not listed by the character" warnings are gone: every selectable skill's summon is now a token of its chess, `sources` [] + `bySkill[i].sources` ["skill"].) A new warning = investigate.

## 4. Inputs

| Input | Used for | Cite |
|---|---|---|
| `excel/activity_table.json` | `activity.AUTOCHESS_SEASON.act2autochess` = `ctx.act`, `autoChessData` = `ctx.ac`; SEASON = 'act2autochess' | B:46, 297-299 |
| `excel/character_table.json` | operators, tokens, traps, summons (token_table.json is NOT used) | B:293, 305 |
| `skill_table`, `range_table`, `uniequip_table`, `battle_equip_table`, `enemy_handbook_table`, `levels/enemydata/enemy_database.json` | skills, ranges, modules, enemies | B:294-300 |
| `levels/activities/<season>/level_<id>.json` | every template of `battleDataDict` + 2 escaped templates + all stage ids + `level_autochess_enemy_data` | B:303-325 |
| docs/research/*.json (optional; absent = warning + defaults; `--no-research` ignores all) | see section 10 | B:142-148, 329-336 |
| data/assets.json, server/sim/grid.js, shared/bandBonds.js, shared/waiguan.js | see fact 3 | B:37-39, 349 |

## 5. Stages of main() (execution order B:3563-3590)

| # | Stage | Lines | Key points |
|---|---|---|---|
| 1 | context | 290 | loads official + research + manifest into `ctx` |
| 2 | skill / trait / talent / module helpers | 355-701 | `interpolateAttrs` 366 + `statsFrom` 393 (stats at status; module attrs added via MODULE_ATTR_MAP 386); `buildSkill` 516 (level-picked skill, `flattenBB` -> `bb`/`bbStr`, `{key:0%}` placeholders resolved, spType names 510); `resolveTrigger` 481: charId rows (skillIndex or -1) -> subProfession rows -> profession rows (class rows only for MANUAL skills) -> else a MANUAL operator skill with own 技能范围 = `SKILL_RANGE` -> else DEFAULT; then TRIGGER_DEVIATIONS; ALWAYS -> SP_FULL, CUSTOM_RANGE_SEARCH_ENEMY -> CUSTOM_RANGE (TRIGGER_RENAME 431); `splitModuleParts` 558 (`isToken` parts go to summons only); `applyModuleTraitParts` 569 + `traitRecord` 589 (trait text/bb/range + module override); `moduleAttr` 608; talents: `baseTalentList` 634, `moduleTalentChanges` 655, `mergeTalentChanges` 681 (module values win, unrestated keys kept; mirrored by server/sim/simdata.js composeTalents) |
| 3 | chess | 703-1035 | `classifyAttack` 714 (dmgType/attackKind/projectile/canHitFly from profession + trait text); `chessRecord` 776: skills[] = every unlocked skill at the chess skill level, default = `defaultSkillIndex` (873-892); trait + talents (895-896); golden `statsBase/traitBase/talentsBase/modules[]` = every ADVANCED uniequip at the chess equipLevel (898-929); tokens + token-owner map (931-989); `assets` ids (991); `buildChess` 1009 (normal + golden are both records) |
| 4 | effects, bonds, garrisons, items, bands | 1502-1798 | effects 1524; bonds 1552 (thresholds from activeParamList/blackboards/desc, `spec` from research 02); garrisons 1638; items 1720 (research 04 + SHOP_EXCLUDED_ITEMS + ITEM_RULES); bands 1776 (`bondIds` added in main :3589) |
| 5 | enemies | 1800-2203 | merges enemy_database + season override level; MELEE `rangeRadius` forced 0 (`rawRangeRadius` keeps official, 1873); HIT_AREAS/STATIC_BODIES/MODEL_SCALES; `attackAnim` from assets.json (2069); `attrPower` float32 (1957) |
| 6 | 外援 roster | 1037-1300 | `buildWaiguan` 1142: (1) candidates = TIER_6 non-TOKEN/TRAP chars not in shop pool, sorted by zh name (1146-1154); `buildOne` 1164 = one record through the slot template and the same `chessRecord`, default module on both statuses; (2) tier VI records (1213); (3) tier V overlays = nine tier fields from the slot template (1225); (4) tier V normals' token owners mirrored (1255); (5) tier V elites built in full at module level 1, the differing `WAIGUAN_ELITE_TIER_FIELDS` stored in their overlay (1271); (6) light `candidates` list (1286). Bonds: `waiguanBonds` 1110 (mainPower + every subPower, matched per source and UNIONed against core `powerIdList`, else `emptyShip`). Runs BEFORE tokens. |
| 7 | tokens | 1282-1500 | per-owner `variants[chessId]` + `bySkill` + `byModule`; `placeable` = made by talent/skill and not HIDDEN (1415-1440); `ownerRange` regex; `abnormal` from TOKEN_ABNORMAL; 炎佑 `bondSummon` from enemy template (1452); `mapChar` from stage predefines (1468) |
| 8 | waves, stages | 2204-2627 | waves: absolute-time spawns, routes, branches, overrides (2282); stages: 19x21 `rows` (row 0 = bottom), glyph legend (2364), devices, `deployTiles`, `groundPaths*` via sim Grid (2414, 2512) |
| 9 | factions, bosses | 2629-2757 | 67 special entries + generator params; bosses `bloodPoint` per difficulty |
| 10 | choices (机变) | 2760-3167 | events, families, cards (bounty/tactic), `bountyDrafts`, `shopDraft`, `tacticDraft`, `schedule`, `pools`; many [ASSUMED] |
| 11 | config | 3169-3388 | modes (rounds, enemyScale from research 01 `_criticAddendum.enemyStatMultipliers`), economy, timers, titles, trophies, rewards, constants |
| 12 | validate + write | 3390-3646 | `validateAll` 3404; size cap 6 MiB 3601; write only if no errors or `--force` (3603); report 3614-3627 |

## 6. data/ files and their producers

| File | Producer | Top-level shape |
|---|---|---|
| config | B | `{season, seasonName, modes{9: mode_training_1, mode_{single,multi}_{funny,normal,hard,abyss}}, economy, lpCapPerRound, bossOvertimeAfter, bossOvertimeDrainPerSec, bossHpScale, hiddenCore, dp, unite, finalAssault, timers, bans, bandDraft, titles, titleRule, tips, broadcasts, trophies, roundScores, rewards, constants}` |
| chess | B | map chessId -> record (266) |
| bonds 23, garrisons 249, items 115, bands 40, effects 361, enemies 249, waves 38, bosses 10 | B | maps keyed by bondId / garrisonId / itemChessId / bandId / effectId / enemyKey / template id / bossId |
| stages | B | map of 11 stage ids (`act1autochess_m01..m07`, `act2autochess_m01..m04`); 8 active (`weight>0`) |
| choices | B | `{events, families, format, cards{bounty,tactic}, bountyDrafts, shopDraft, tacticDraft, schedule, pools}` |
| factions | B | `{templateSlots, types, entries(67), generation}` |
| tokens | B | map tokenId -> token (61: 58 summon, 1 bondSummon `enemy_9012_acloon`, 2 mapChar); `deployLimit` = maxDeployCount + the summon's talent `max_deploy_count` (外援 only) |
| waiguan | B | `{candidates[87], chess{174 tier VI}, chessT5{174 overlays}}` |
| assets | tools/fetch-assets.mjs | `{version, hash, generator, stats, chars, enemies, tokens, bonds, items, bands, skills, skillsById, ui, prof, audio, fonts}` (docs/ASSETS.md); never shrinks without `--allow-shrink` |
| emotes | tools/build-emotes.mjs | `{version, source, chatCD, chatTime, themes[6], emotes[36]}` from display_meta_table + activity_table |
| tuning | hand | `{_doc, version, titles}` (title rules only) |

**Chess record** (probe of data/chess.json; DATA.md:139-195): `chessId baseId goldenId isGolden tier identifier isHidden isDiy visible chessType shopSortId charId name appellation rarity profession subProfessionId subProfessionName position nationId bonds[] garrisonIds[] price sellPrice upgradeNum upgradeChessId status{phase,level,skillLevel,equipLevel}`
`stats{maxHp atk def res cost blockCnt bat aspd respawnTime spRecovery hpRecoveryPerSec moveSpeed tauntLevel massLevel deployLimit deckStack} immunities rangeId rangeGrid dmgType attackKind projectile canHitFly targetPriority trait{desc descRaw bb bbStr rangeGrid [moduleDesc]}`
`skill{skillId iconId name level desc descRaw skillType durationType duration spType spCost initSp maxChargeTime increment bb bbStr rangeId rangeGrid prefabId trigger{rule rawRule customRangeGrid} index overrideTokenKey} skills[]` (same + `isDefault`; exactly one default = `skill`) `talents[{index name desc descRaw bb bbStr rangeGrid tokenKey hidden fromModule [containerTokenKey]}] tokens[] module{id name type level active} assets{avatar portrait spine skillIcon subProfIcon}`.
Golden with `equipLevel>0` adds `statsBase traitBase talentsBase modules[{uniEquipId name typeName typeIcon icon isDefault level attr traitOverride talentChanges}]`. DIY slot templates add `diyRequirement`. Positions are `[row,col]`, row 0 = bottom; `rangeGrid` is relative, facing right (DATA.md:33-46).

**Token record** (DATA.md:460-484): `tokenId kind name appellation desc descRaw profession subProfessionId position displayType placeable ownerRange owners[] stats rangeGrid dmgType attackKind projectile canHitFly skill{skillId,bb} deployLimit count abnormal[] variants{[ownerChessId]:{phase level stats immunities rangeGrid trait dmgType attackKind projectile canHitFly targetPriority skill talents count sources[] bySkill{[i]:{skill,count,sources}} byModule{[moduleId|'none']:{stats immunities trait talents}}}} assets`. `sources` is a subset of talent/skill/display.
**waiguan.json** (DATA.md:486-540): `candidates[]` = `{charId name appellation rarity profession subProfessionId position nationId bonds[] chessIds{5,6}}` (chess id = `chess_char_diy_<tier>_<charId>_a|_b`, B:1075); `chess{}` = full tier VI records (`isDiy true`, `diyRequirement 'TIER_6'`, `garrisonIds []`); `chessT5{}` = `{from, chessId baseId goldenId tier identifier price sellPrice upgradeChessId status}` + on elites the differing `stats talents module modules` (`trait` when it differs; none today). Runtime merge: server/match/Match.js:353-356 (`waiguanRecords`, `addChess` :470); browser loads it lazily (public/js/data.js:38).

## 7. Validation, report, errors

- `validateAll` (B:3404-3559) returns error strings: non-finite numbers (3410); counts (3414-3417); per-chess refs, exactly one default skill, module-choice consistency (3418-3433); waiguan: unique candidates, bonds exist, 6 star, no 特质, one default skill, bonds equal candidate bonds, not leaked into chess.json, overlay `from`/fields present and no other field (elite: + module-level fields), 174/174 counts; 外援 modules (from 3495): every record at its slot's `equipLevel`, `module.level` = `equipLevel`, elites compose back from `statsBase/traitBase/talentsBase` + default module, the same module ids at both tiers, normal stub, overlay reproduces the full tier V elite (`validateAll(files, { waiguanT5Elite })`); 8 empty DIY templates (3479); trigger deviations (3481-3492); bonds/items/bands refs; waves/spawns/routes; stages 19x21, no `?` glyph, no Latin in names (3521-3523); modes/templates; bosses/factions/choices pools; SHOP_EXCLUDED_ITEMS/TOKEN_ABNORMAL targets (3542-3546); tokens have stats + `sources`; enemies `rangeRadius` contract and core stats (3551-3556). test/data.test.js asserts the same invariants independently.
- Warnings (`warn`, B:91) are deduplicated, printed, written to the report, never change the exit code. Report = `.cache/build-data-report.json` (counts, sizes, `written`, warnings, errors).
- On errors: old files untouched, message `integrity errors: <out> left unchanged` (B:3630).

## 8. Change recipes

| Goal | Edit | Then |
|---|---|---|
| New / changed hard-coded rule (trigger, shop-excluded item, token abnormal, hit area...) | the constant in B (section 1 fact 5) | `npm run build-data`, `node --test test/data.test.js test/docs-consistency.test.js`, update DATA.md text, commit |
| Official data changed upstream | `node tools/build-data.mjs --refresh`; fix failing `validateAll` counts only if the change is real | review `jq -S` diff, rerun tests, commit |
| Change sim pathing (`server/sim/grid.js`) | code | rebuild: stages `groundPaths*` go stale (DATA.md:30) |
| Anim manifest changed (`data/assets.json`) | via tools/fetch-assets.mjs | rebuild: enemies `attackAnim` |
| Result-title rule only | `data/tuning.json` by hand (the one hand-edited file) | tests |
| New emote theme | `THEME_DIRS`/`LABELS` in tools/build-emotes.mjs + shared/constants.js EMOTE_THEMES | `node tools/build-emotes.mjs`; test/ui/emotes.test.js keeps both equal |

## 9. Byte-identity status (measured 2026-10-06)

Cold download into a scratch cache (`--cache` + `--out` scratch dirs; no repo files touched): 15/15 files `cmp`-identical to data/, 5.24 MiB, 10.3 s including download, exit 0, 9 warnings (section 3). Re-measured after the tier V elite module fix (same day): 15/15 identical, 5.42 MiB, 13 warnings. `node tools/build-emotes.mjs --check --cache <scratch>`: up to date. `data/assets.json` regeneration (fetch-assets) NOT tested here (needs ~550 MB of assets): UNVERIFIED.

## 10. docs/research (static snapshots; 00-INDEX.md:5 "Addendum wins", `_criticAddendum` wins in JSON)

| File | Holds | Read by build-data? |
|---|---|---|
| 00-INDEX.md | Index + key numbers, contradictions table (:118), open questions (:136); lists 01-07, 11 but not 08/09 | no |
| 01-core-rules.md / 01-core-data.json (237 KB) | modes, rounds, economy, strategies, 机变, scoring; `_criticAddendum` | JSON yes: `_criticAddendum.enemyStatMultipliers`, `.incomePerRound.CAP` (B:3214-3218), `trophiesPerClear` (B:3299) |
| 02-bonds.md / .json (427 KB) | 23 bonds, layer formulas; `bonds[].spec` | JSON yes: `bonds[]` -> bonds.json `spec` (B:1554,1604) |
| 03-operators.md / .json (1.6 MB) | 133 chess x2 stats/skills/talents; `skillTriggerDataList`, `diyChessDict`, `tokensUsedByPool` | no (tools/assets, tests, simdata fallback) |
| 04-items.md / .json | 56 equipment x2 + 3 Arts; categories, `implFormula` | JSON yes (B:1722) |
| 05-enemies-levels.md / 05-enemies.json / 05-maps.json | terrains, 38 templates, 326 enemies, bosses | 05-maps.json `stages[id].name` yes (B:2513); 05-enemies.json loaded, unused |
| 06-multiplayer-ux.md | co-op flow, UI, settlement | no |
| 07-assets.md / .json (1 MB) | URL patterns, per-operator asset entries | JSON: only `operators[id].avatar/portrait .e2` (B:743); main consumer tools/fetch-assets.mjs:225 |
| 08-waves-official.md | official wave counts, generator, pathing (supersedes 05 s3.2, :5); decoded from client | no (basis of factions `generation`, B:2689) |
| 09-ux-official.md | official prep/co-op UX; wins over 06 and DESIGN on facing/spectating/selling/preview (:12) | no |
| 11-limits-official.md | bond layer cap 999, boss hit limit 300000 | no (shared/constants.js) |
Tags in research: [DATA] client data, [VERIFIED] official/wiki/screenshot, [ASSUMED] proposal kept tunable.

## 11. docs/DATA.md map (627 lines)

| Lines | Section | | Lines | Section |
|---|---|---|---|---|
| 1-31 | header: commands, cache, report, determinism, size | | 337 | 9 enemies (360-364: hitArea/staticBody/modelScale/attackAnim/attackMoves) |
| 33 | 0 conventions (ids, desc/descRaw, bb/bbStr, positions, rangeGrid) | | 366 | 10 factions + official generator steps |
| 48 | 1 config (52 modes, 93 economy, 114 other) | | 386 | 11 waves |
| 139 | 2 chess (196 classification, 202 loadout skills/modules) | | 411 | 12 stages (glyph legend after devices) |
| 239 | 3 bonds | | 447 | 13 bosses |
| 263 | 4 garrisons | | 460 | 14 tokens |
| 276 | 5 items | | 486 | 14b waiguan |
| 298 | 6 bands | | 542 | 15 anomalies (23 numbered) |
| 310 | 7 effects | | 602 | 16 counts |
| 322 | 8 choices | | 608 | 17 integrity guarantees |
Known stale/loose in DATA.md: line 3 (see fact 1), line 28 (size, fact 13), `[ASSUMED]` markers flag reconstructions, not client data.

## 12. Tests that guard data

| Test | Guards | Needs `.cache/gamedata`? |
|---|---|---|
| test/data.test.js (38 tests) | shapes, counts, refs, waiguan (incl. 外援 modules at both tiers, normal stub, tier V elite summons), loadout/module composition, spot checks | `HAS_CACHE` (:25-27: activity, character, skill, battle_equip tables, enemy_database, level_autochess_enemy_data). Skips: :121 roster = every 6 star, :194 bond derivation vs official pool, :984 stat re-derivation, :1072 外援 stat/module re-derivation at the slot's 模组 level, :1110 offline byte-identical rebuild (also skipped if `DATA_DIR` set; `t.skip` on a partial cache). `DATA_DIR=<dir>` validates another build output |
| test/data.test.js:1003 | build CLI rejects `--bogus`, `--out`, `--refresh --offline` with exit 2 | no |
| test/match/waves-crosscheck.test.js (:22-33) | generator + preview zones vs raw level files | yes |
| test/sim/pathing-crosscheck.test.js (:24-27), pathing-official.test.js | stage paths vs raw client SPFA | crosscheck yes (8 stage level files) |
| test/match/playtest5-deploy.test.js (:29,:221) | buildable/height/devices vs raw levels | yes (the independent test) |
| test/match/feedback1-bounty.test.js (:98,:273) | draft sets vs activity_table | partly (diagnostic skip) |
| test/ui/feedback1-gaps.test.js (:115) | 天赋栏 pairings vs character_table | yes |
| test/ui/emotes.test.js (:98-106) | emotes.json == build-emotes output; constants mirror | rebuild test needs display_meta_table.json |
| test/match/waves-official.test.js | 429 official compositions (test/fixtures/official-waves.json) | no |
| test/sim/loadout*.test.js, test/content/summon_loadout_conflicts.test.js | resolve loadouts/summons on real data (`hasGeneratedData()`) | no |
| test/docs-consistency.test.js | pinned phrases in DATA.md / build-data.mjs / research | no |
| test/assets.test.js, test/fetch-assets-shrink.test.js | assets.json, shrink guard | no |
Full suite: `npm test` (= `node --test`, package.json:28); iterate with `npm run test:fast`. CI (ci.yml:48) runs `node --test` without the cache.

## 13. UNVERIFIED

- Windows / Node 24 byte-identity of the rebuild (CI skips it); full-ICU assumption (fact 17).
- Whether `--no-research` still passes `validateAll` (not run).
- Regeneration of assets.json / waiguan-operators.json (needs large downloads).
- Whether other tooling (hooks, release scripts outside this tree) re-runs build-data automatically: none found in package.json, ci.yml, tools/setup.mjs, Dockerfile.
