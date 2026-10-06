# Match layer (server/match): agent context brief

Scope: the authoritative match engine: phases, rounds, drafts, shop/pool/merges, 联防, boss rounds, results, bots, 甄选 / 外援, checkpoints and replays, rules versions, and how a lobby room starts a match. Written 2026-10-06 by reading this worktree (node v22.22.0, 4 cores). Every `file:line` cites this tree. Anything not confirmed is marked UNVERIFIED. Long-form docs: DESIGN §6 (docs/DESIGN.md:319), META.md (840 lines), DESIGN §24 (5–8 seats, :2131), DESIGN §27 (甄选, :2309).

## 1. Facts agents get wrong (read first)

1. **There is no `PREP_END` or `BAND_CHECK` phase.** `PHASE` = LOBBY, INFO_CHECK, BAND_DRAFT, BATTLE_CHECK, ROUND_START, SP_DRAFT, PREP, COMBAT, UNITE, SETTLE, FINAL_ASSAULT, HIDDEN_CORE, RESULT (shared/constants.js:39-53). DESIGN's "PREP_END" is the method `Match.endPrep()` (Match.js:2090). "BAND_CHECK" is only the official step name in `config.timers.enterSteps`.
2. **`Match.setPicks` refuses picks during the strategy draft.** It tests `PHASE.BAND_CHECK` (Match.js:608), which is `undefined`, so only LOBBY / INFO_CHECK pass. `start()` leaves LOBBY at once (Match.js:533-546), so in practice picks change only during INFO_CHECK. DESIGN §27 (:2309 table, "When") says LOBBY / INFO_CHECK / BAND_CHECK.
3. **甄选 picks never show up in the owner's shop (verified gap).** `SharedPool.addOwned` creates an owner-scoped entry (pool.js:82). `_eligible` skips owned entries unless `playerId` matches (pool.js:128). But `PlayerState._rollChessSlot` calls `pool.roll(rng, { maxTier })` with no `playerId` (PlayerState.js:839), and so do the merge reward offer (:663), choices.js:509 and effectsMeta.js:548. Measured: 3000 shop rolls at level 6 with two picks gave 0 DIY slots, while `pool.roll({ playerId })` returned the pick. The tests call `pool.roll` directly (test/match/waiguan.test.js:77-97), so they pass anyway.
4. **Leftover funds are wiped at every prep end** (PlayerState.js:1495). The one exception is the band `band_cannot` 坎诺特 (gamedata.js:51 `leftoverFundsKeptByBands`). Battle coins go to `pendingFunds` and arrive with the next ROUND_START income (PlayerState.js:1466-1471).
5. **Prep intents are refused while Ready.** `_gate` returns `WRONG_PHASE 'ready'` (PlayerState.js:878-885). Ready is refused while temp is non-empty (`TEMP_NOT_EMPTY`, :1426).
6. **Temp (临时整备区) is NOT wiped at round start.** Each temp piece has a due prep (`tempDue` / `_putTemp`, PlayerState.js:184-209). It is resolved only at that prep's deadline (`resolveTemp` :1443, called from `endPrep` :1489). Resolving sells a chess back, destroys an item, and removes a summon stack.
7. **Elite = golden = id `_a`→`_b`** (or the record's `goldenId`; gamedata.js:259-270). An elite holds `goldenCopies` (3) pool copies, and granting one takes 3 (PlayerState.js:486-487). A merge's elite lands on a consumed **deployed** copy's tile, else in the hand, else in temp (PlayerState.js:549-556; DESIGN §20.11 :1012).
8. **A co-op room with one human keeps co-op rules but runs untimed.** It stays MULTI: 6 机变 cards, 联防, pool share 1. `soloUntimed` = `isSolo || loneHuman` (Match.js:431, 875). Only a true solo match can pause (`g.pause`, Match.js:1444).
9. **Solo has no 联防** (unite.js:137). Its leader pool is bloodPoint × 0.25 (gamedata.js:175), and its Hidden Core threshold is 350 instead of 1200 (gamedata.js:536-540).
10. **1–4 players play official rules whatever the room capacity.** Scaling applies only above 4 and is f = n/4. Some rules read n = seats at match start (pool copies, draft turn); others read n = alive at the phase start (机变 cards, 联防 fields, leader pool, drain) (gamedata.js:52-66, :201-213).
11. **A match that reaches the Hidden Core ends `victory: true` even if the team LP hits 0 there.** R14 was already won. `hiddenCleared` = the hidden pool reached 0 (Match.js:3491, `_endFinal` :3091). The exception is every human leaving, which ends it as 'abandoned' (:748-749).
12. **Summons (tokens) take no deploy slot and cannot be sold.** `deployCount` counts chess only (PlayerState.js:177), and `sell` refuses tokens (:966).
13. **Disconnected ≠ bot-played.** A disconnected human keeps its lineup and auto-resolves at deadlines. The bot plays the seat only with AI 托管 (`g.autoplay`) (Match.js:133-137; `botControlled` PlayerState.js:174). A departed human (`onLeave`) is eliminated (`_quit`, Match.js:761).
14. **Checkpoints do not record `setPicks`.** The recorded methods are start/handle/onDisconnect/onReconnect/onLeave/setLoadout (checkpoint.js:7), but the lobby calls `match.setPicks` mid-match (lobby.js:931-934). Impact on a Worker restore: UNVERIFIED.
15. **Bot 甄选 bond filters read missing fields.** Match.js:275 reads `gd.disabledBonds`, and GameData has no such field. Match.js:452 reads `this.modeInactiveBonds`, and Match has no such field (the real ones are `this.disabledBonds` and `gd.modeInactiveBonds`; verified by grep). So each filter sees only one ban list. Gameplay impact: UNVERIFIED, likely minor.
16. **Editing anything bundled into the engines mints a new rules version.** That covers server/match, server/sim, data, and the shared modules they import. A CI deploy fails until the version is archived (section 9).
17. **`node --test test/match` (a directory) fails on Node 22** with MODULE_NOT_FOUND (verified). Use a glob: `node --test 'test/match/*.test.js'`. The `npm run test:fast -- test/worker` example in tools/test-fast.mjs:5 passes a directory the same way.

## 2. Where to look

| Topic | Code | Docs |
|---|---|---|
| Lobby⇄Match contract (opts, start/handle/onLeave …) | Match.js:7-74 (header), StubMatch.js:1 (reference stub, tests only) | DESIGN §8.1 :420 |
| Phase enum, names, GEO rows/cols, ERR | shared/constants.js:39, :55, :62, :134 | DESIGN §3 :125 |
| State machine overview | Match.js:1510-1800 (info → draft → round start → 机变), :1971-2110 (prep), :2179-2290 (combat/联防), :3158-3255 (settle), :3255-3497 (boss), :3498 (finish) | DESIGN §6.1 :321; META §1 :33 |
| Intent routing `g.*` / `b.*` | Match._handle Match.js:1304-1338 | DESIGN §8.2 :428, §8.3 :444 |
| Client-side combat, authority, verify | Match.js:75-112, `_startCombatClient` :2677, `_onResult` :2777, fields.js `validateClientResult` :738 | DESIGN §14 :547 |
| Player state, shop, merges, temp, tokens | PlayerState.js:1-71 (rules header), handlers :888-1460 | DESIGN §6.2 :351; §20.1 :858; §20.11 :1012 |
| Shared pool, bans | pool.js:1-17 (model), `drawDisabledBonds` :27, `SharedPool` :53 | DESIGN §24.2 :2142 |
| Data lookups, tunables, scaling | gamedata.js DEFAULTS :21, GameData :75 | DATA.md; DESIGN §24 :2131 |
| Bonds / layers (cap 999) | bondsMeta.js `computeBonds` :104, `activatedLayers` :184; constants.js:101 | DESIGN §6.3 :379; §20.12 :1023 |
| Meta effects (特质 / band / item / 机变 handlers) | effectsMeta.js HOOKS :45, GARRISON_HOOK :54, EffectDispatcher :140 | DESIGN §6.4 :388; META §2 :293 |
| 机变 drafts | choices.js `spDraftCardCount` :129, `generateDraft` :159, `applyCard` :443 | META §1.2 :102; DESIGN §24.3 :2146 |
| Waves, stages, bounties in waves | waves.js `setupMatchWaves` :181, `buildNormalWave` :359, `buildBossWave` :384 | DESIGN §6.5 :392 |
| 联防 | unite.js:1-44 (rules), `planUnite` :136, `helperRankings` :246 | META §4 :657; DESIGN §24.4 :2151; §23.1 :1721; §23.22 :1949 |
| Final Assault / Hidden Core | finalAssault.js `pairPlayers` :63, `bossPoolHp` :71, `SharedBossPool` :95, `hiddenEligible` :123 | DESIGN §24.5 :2159; §20.5 :931; §20.10 :995 |
| Results / titles | results.js `assignTitles` :37, `buildResult` :108 | DESIGN §24.6 :2166 |
| Bots | bot.js:1-92 (prep routine), `botPickBand` :135, `botPickCard` :164, `botPrep` :1363 | DESIGN §6.6 :396; §21.6 :1203; META §1.5 :226 |
| 甄选 / 外援 | shared/waiguan.js; Match.js:242-329, :604-653; pool.js:82 | DESIGN §27 :2309 |
| Checkpoint / replay record | checkpoint.js, recorder.js | ACCOUNTS-HISTORY.md:89 (规则版本与容量边界) |
| Rules version / archive | shared/rules-version.js:1, tools/build-replay.mjs, replay-versions.json | ACCOUNTS-HISTORY.md:89-103; CLOUDFLARE.md:38 |
| Invariants / audit | invariants.js:1-20, audit.js:1-49 | DESIGN §11 :516 |
| Rooms → match, 匹配 queue | lobby.js:1-82 (rules), `start` :864, `startMatch` :951, `onMatchEnd` :1004 | DESIGN §24.1 :2135; §28.1 :2348; §23.19 :1911 (spectators) |

## 3. Glossary (mode term ↔ code)

| 中文 | Code identifier | Where |
|---|---|---|
| 盟约 (bond) | bond, `bonds.json` ids `*Ship` (23 bonds; 8 core `isCore`: 炎 yanShip, 萨尔贡, 维多利亚, 谢拉格, 拉特兰, 阿戈尔, 叙拉古, 卡西米尔) | bondsMeta.js:104 |
| 层数 (layers) | `ps.layers[bondId]`, cap `BOND_LAYER_CAP` 999; Σ activated layers decide the Hidden Core | constants.js:101; Match.js:2098 |
| 策略 (strategy) | band, `bands.json` `band_*` (40), `ps.bandId`; LP = band `totalHp` | gamedata.js:575 |
| 华法琳 (default strategy) | `band_bldsk` (`bandDraft.timeoutBandId`) | gamedata.js:547; Match.js:1636 |
| 队友已选 | `Match.bandTaken` (co-op: one strategy per team) | Match.js:1622 |
| 特质 | garrison, `garrisons.json` `garrison_NN_a/_b` | effectsMeta.js:54; DATA.md:263 |
| 甄选 / 外援 (DIY) | waiguan: slots `diy5a diy5b diy6a diy6b`, records `chess_char_diy_<tier>_<charId>_a/_b`, `isDiy` | shared/waiguan.js:22 |
| 精锐 (elite) | golden: `_b` chess id, `isGolden`, `gd.goldenIdOf` | gamedata.js:265 |
| 晋升奖励 | `ps.offers[0]` with source `'merge'` → `m.private.shop.rewardOffer` | PlayerState.js:653, :1652 |
| 整备区 | hand, 10 slots (GEO row 7), filled right→left | constants.js:68; PlayerState.js:5 |
| 临时整备区 | temp, 5 slots (row 8, cols 4–8) | constants.js:69; PlayerState.js:184 |
| 作战区 / 部署 | board `Map<'r,c', piece>`, rows 9–12 × cols 2–10 (`GEO.FIELD`) | constants.js:64 |
| 部署上限 | `ps.deployCap` = 8 + `deployCapBonus` (`BOARD_FULL`) | PlayerState.js:176, :1119 |
| 部署费用 | in-battle DP (redeploy cost): battle flags `dpInit 10 / dpPerSec 1 / dpMax 99` | gamedata.js:510 |
| 技能策略 | skill auto-trigger rule `skillTrigger.rule` (data), built by `resolveTrigger` | tools/build-data.mjs:481; DESIGN :291 |
| 召唤物 | token piece `kind:'token'`, `tokens.json placeable`, `ownerUid`, stacks (`count`) | gamedata.js:606; PlayerState.js:440 |
| 机变 | `PHASE.SP_DRAFT`, `m.sp`; families 悬赏决策 bounty / 道具补给 supply / 机密商店 shop / 战术决策 tactic | choices.js:70 |
| 悬赏 | bounty `ps.bounties` (multi-round = 2 battles) | Match.js:1882; choices.js:80 |
| 联防 | `PHASE.UNITE`, unite.js, fields `'u'`, `'u2'`… | unite.js:136 |
| 最终攻势 / 隐秘核心 | `FINAL_ASSAULT` (`gd.bossRound`) / `HIDDEN_CORE` (`gd.hiddenRound`) | gamedata.js:375-376 |
| 领袖 (leader / boss) | `bossId`, shared pool `SharedBossPool` | finalAssault.js:95 |
| 目标生命值 | LP `ps.lp`; team LP `m.teamLp` in boss rounds | Match.js:3263 |
| 休整期 / 作战 / 结算 | PREP / COMBAT / SETTLE | constants.js:55-59 |
| 调度中心 等级 | `ps.shop.level` 1–6, `g.levelUp` | PlayerState.js:947 |
| 冻结 / 刷新 / 出售 / 销毁 | `g.freeze` / `g.refresh` / `g.sell` / `g.destroy` | Match.js:1314-1324 |
| 干员调配 | operator loadout `{ [baseChessId]: { skill, module } }` | PlayerState.js:211; DESIGN §16 :605 |
| AI 托管 | `ps.autoplay` via `g.autoplay` | Match.js:1377 |
| 中途退出 | `onLeave` → `_quit` (eliminated, copies returned) | Match.js:736-803 |
| 本局禁用 | drawn `m.disabledBonds` ∪ mode `inactiveBondIds` | pool.js:27; Match.js:440-443 |
| 同盟 / 独立模拟 | `mode:'coop'` → `mode_multi_*` / `mode:'solo'` → `mode_single_*` | constants.js:35 |
| 标准 / 险境 / 绝境 / 终极 | FUNNY / NORMAL / HARD / ABYSS | constants.js:31-32 |
| 协防干员 / 调和 | `emptyShip` / `maniShip` (`HARMONY_BOND`) | bondsMeta.js:28 |
| 观战席 / 匹配 | spectators (`MAX_SPECTATORS` 2) / queue (`queue.join`) | constants.js:27; lobby.js:470 |

## 4. Match lifecycle (Match.js)

| Phase | Entered by | Timer (co-op; solo and one-human matches untimed) | Ends when |
|---|---|---|---|
| INFO_CHECK | `start()` → `enterInfoCheck` :1510 | `timers.infoCheck` 25 s | all humans `g.infoReady` (:1521); loadout locks after this |
| BAND_DRAFT | `enterBandDraft` :1539 | one countdown per turn: 30 s (`BAND_TURN_SECONDS` :232), 20 s above 4 seats | every seat picked; timeout → highlighted (`g.bandFocus`) else 华法琳 else the first free strategy (:1636-1656) |
| BATTLE_CHECK | `enterBattleCheck` :1728 | 3 s (silent when untimed) | → `startRound(1)` |
| ROUND_START | `startRound` :1734 | 2 s (`DELAYS.ROUND_START` :216) | waves planned first (boss pairing for R14/R15), then `ps.startRound` (income, price −1, frozen shop kept), `onRoundStart` |
| SP_DRAFT | `afterRoundStart` :1776 if r ∈ `spRounds` | first picker 30 s, later 16 s (12 s above 4 alive) (:1821) | every alive player picked; timeout → random free card |
| PREP | `enterPrep` :1971 (deferred item merges, `onPrepStart`) | `prepTime(r)` per round (:1986) | all alive ready (:2059) or deadline (`prepDeadline` :2079 auto-resolves temp) |
| (endPrep) | :2090 `onPrepEnd` → `ps.endPrep` | none | R=bossRound → FINAL_ASSAULT (Σ layers snapshot :2098); R=hiddenRound → HIDDEN_CORE; else COMBAT |
| COMBAT | `startCombat` :2179 | the wave's time limit at 2× (`GAME_SPEED` fields.js:39) | all fields done → 1.5 s → `_afterCombat` :2240 |
| UNITE | `planUnite` non-null (co-op, ≥1 leaker and ≥1 perfect) | wave time limit | all 联防 fields done → SETTLE |
| SETTLE | `settle` :3158 | 3 s | LP −= min(10, counted leaks or the 联防 bill) (:3173); layer gains; LP ≤ 0 ⇒ eliminated (:3211) → next round |
| FINAL_ASSAULT / HIDDEN_CORE | `startFinalAssault` :3255 | leader countdown `levelMaxPlayTime` 120 real s (not a hard stop); drain from 150 real s | pool 0 → win, team LP 0 → loss (the first end registered decides, :3472); a win plus `hiddenEligible` → R15 |
| RESULT | `finish` :3498 | n/a | `buildResult`, `m.result` per viewer, `onEnd(summary)` once |

**Rounds per mode** (data/config.json `modes`, read at gamedata.js:371-384):

| modeId | rounds / boss | hidden | 机变 rounds | prep s (R1→R14[,R15]) |
|---|---|---|---|---|
| mode_multi_funny | 14 / R14 | none | 3, 9 | 65,65,65,95,95,100,105,105,125×4,150,195 |
| mode_multi_normal | 14 / R14 | R15 | 3, 6, 9 | same, R15 195 |
| mode_multi_hard, _abyss | 14 / R14 | R15 | 3, 9, 11 | same, R15 215 |
| mode_single_funny | 9 / R9 | none | none | untimed |
| mode_single_normal | 14 / R14 | R15 | 6, 9 | untimed |
| mode_single_hard, _abyss | 14 / R14 | R15 | 3, 9, 11 | untimed |

- **Hidden Core gate** (finalAssault.js:123): win R14, difficulty ∈ NORMAL/HARD/ABYSS, Σ activated layers at the R14 prep end > 350 (solo) / 1200 × max(1, n/4) (co-op), and team LP > 1.
- **Final Assault**: team LP = Σ alive LP (Match.js:3263); fields pair alive players by seat, `b1`…`b4` (finalAssault.js:63). One shared pool = bloodPoint[difficulty] × share (solo 0.25, co-op 1, × n/4 above 4) (gamedata.js:156-184). Overtime drain is 1 team LP per real second after 150 s (× n/4 above 4) (gamedata.js:43-44, :488-508). No layer gains.
- **Randomness**: six seeded streams (setup, shop, waves, draft, bots, meta) from `deriveSeed(seed, name)` (Match.js:401-407). Draft order is shuffled in co-op only (:1543, :1791). Determinism is what makes checkpoints restorable.
- **Co-op vs solo**: solo draft is free, has no skip and no timer. Co-op has 1 skip per player (`skipBand` :1692) and never allows duplicate strategies. 机变: co-op 6 cards (max(6, alive+2) above 4), solo 3 (choices.js:129-157).
- **Large rooms 5–8** (DESIGN §24): pool copies ceil(x·n/4) with n = seats at start (gamedata.js:342); draft turn 20 s; 机变 cards alive+2, later picks 12 s; 联防 up to ⌈alive/4⌉ fields (unite.js:58-70); leader pool and drain × alive/4; hidden threshold × n/4; a second title pass (results.js:37). Overrides: `config.largeRoom` (gamedata.js:188).

## 5. PlayerState.js (one per seat; handlers return `{ok}` / `{error}`, never throw)

| Rule | Value / behaviour | Cite |
|---|---|---|
| Income | `income(r)` table = min(3+r, 12) (R1 4 … R9+ 12) + pending coins, at ROUND_START (`onIncome` may rewrite) | gamedata.js:22, :281; PlayerState.js:1466-1471 |
| Shop slots | level 1: 3 chess + 1 item; 2–3: 4+1; 4–6: 5+1 (co-op data; solo FUNNY differs) | gamedata.js:39, :398 |
| Prices | chess tier 1: 2, tiers 2–4: 3, tiers 5–6: 4 (elite same); sell +1; refresh 1 (free refreshes first) | gamedata.js:24-26; PlayerState.js:923-937 |
| Level up | prices [5, 8, 11, 12, 13] (solo FUNNY [1, 1, 5, 8, 10]); −1 per round from R2, floor 0; resets to the next base on level-up; max 6 | PlayerState.js:947-960, :1465 |
| Freeze | toggles all unsold slots. At round start frozen slots are kept and everything else rerolls, then the freeze is released. At prep end unfrozen slots are cleared | PlayerState.js:939, :1479-1481, :1494 |
| Rolls | copy-weighted over unbanned visible chess with tier ≤ level; a display reserves no copies; `SOLD_OUT` when copies left < need | pool.js:9-15, :142; PlayerState.js:903 |
| Buy with full hand | refused (`HAND_FULL`) unless the buy completes a merge | PlayerState.js:904 |
| Merge | 3 normal copies (风丸 `chess_char_2_11_a`: 2) → elite. Copies are consumed new → temp → hand → board. Equipment goes back to the hand, summons are removed, and an elite on the board gets a fresh summon stack. Then a reward offer of 3 different free chess at tier min(level+1, 6) (topped up from lower tiers), the `GOLDEN_CHAR` ticker, `onMerge` | PlayerState.js:525-581, :334-340, :653-672 |
| Offers | queue `ps.offers`; `g.reward` picks from `offers[0]`; all offers expire at prep end | PlayerState.js:1392, :1493 |
| Items | 2 per chess (`equipPerChess`). A 3rd replaces `replaceUid` (else the oldest). Equipped items are locked (no destroy). 2 identical normal items auto-merge into the golden one. Items are never sold. Arts: 2 per round | PlayerState.js:1285-1345, :764; gamedata.js:30, :34-35 |
| Board | `g.move` onto the own region, legality from the stage's deploy map (normal / bossL / bossR in boss rounds); facing `dir` (default RIGHT); chess ≤ deployCap | PlayerState.js:994-1160; Match.js:918-929 |
| Tokens | placing an owner grants a stack of each placeable summon (count = deployLimit ≤ 9; depends on the chosen skill via `bySkill`); topped up every round start; moving the owner lifts its summons back to the stack; range-bound summons (狼群, 流形) only inside the owner's attack range | gamedata.js:606-624; PlayerState.js:403-455, :1478, :1025-1060 |
| Loadout | human-only, re-checked against match data; `Match.setLoadout` only in INFO_CHECK; bots use the defaults; `battleInput` resolves `skillIndex` / `moduleId` | PlayerState.js:211-243, :1548; Match.js:583-593 |
| Eliminate | returns every copy, clears board / hand / temp / offers / bounties / funds; keeps `effects` (a pending 信标 gift still fires) | PlayerState.js:1500-1521 |

## 6. pool.js and gamedata.js

- **Pool entry** `{ cap, left, tier, owner }`. The invariant is left + Σ held copies == cap. `piece.poolCopies` records exactly what each piece holds, and sell, elimination and temp resolution return it (pool.js:1-15; PlayerState.js:395).
- **Copies**: tiers 1–6 = 12 / 14 / 18 / 16 / 8 / 5; 缪尔赛思 (`chess_char_6_11_a`) 4; ceil(×n/4) for 5–8 seats, sized once at the start (gamedata.js:27, :342-356).
- **Bans** (`drawDisabledBonds` pool.js:27): FUNNY draws 0 core + 1 add-on bond; NORMAL / HARD / ABYSS draw 3 + 4. A chess is banned iff every one of its bonds is drawn or mode-inactive. The FUNNY modes switch 10 bonds off statically (data `inactiveBondIds`).
- **`addOwned(owner, baseId, cap)`** (pool.js:82): a private entry, fixed at 8 copies (tier V) or 5 (tier VI) (`WAIGUAN_POOL_COPIES` shared/waiguan.js:34), never scaled. `has` / `left` / `roll` respect the owner only when a `playerId` is passed (pool.js:94-158; see section 1, item 3).
- **GameData** (gamedata.js:75): own-property lookups that return null and never throw: `chess` / `item` / `bond` / `band` / `token` / `enemy` / `boss` (:244-254). It sits on `data/config.json` with defaults for missing keys (header :1-5, DEFAULTS :21). `visibleChess` excludes golden, DIY and hidden chess (:96-100). `addChess` adds a 甄选 record to this match only (:127). `placeableTokens(chessId, loadout)` (:606). `isLargeRoom` / `largeRoomFactor` (:201-213).

## 7. 外援 / 甄选 (shared/waiguan.js, DESIGN §27 :2309)

- Four slots: `diy5a`, `diy5b` (tier V) and `diy6a`, `diy6b` (tier VI) (waiguan.js:22-27). Empty templates `chess_char_{5,6}_diy{1,2}_a/_b` sit in data/chess.json and are never shop-reachable.
- Candidates are the 6★ operators outside the shop pool: 87 in data/waiguan.json. That file holds the full tier VI records plus tier V overlays of 9 fields, rebuilt by `waiguanRecords` (waiguan.js:45-66). `isWaiguanRecord` tells a real pick from a template (:95).
- Flow:
  1. `room.pick` → `checkWaiguanPicks` (shared/protocol.js:110: a known slot and a real candidate, never one operator in both slots of one tier).
  2. The pick is stored on the session and seat (lobby.js:922-945). `startMatch` passes `seats[].picks` (humans only, lobby.js:959).
  3. `Match` merges only the picked records into this match's GameData (Match.js:349-357) and adds owner pool entries (:446-475). Bots get `botWaiguanPicks` (:291).
  4. `setPicks` later: section 1, item 2. `releaseWaiguanCopies` returns copies when a slot changes (:647).
- Loadout: a 甄选 chess is a valid loadout target, widened by the player's own picks (`waiguanChessOf` lobby.js:160, used at :893).

## 8. Bots (bot.js) and auto-play

- Bots act only through the validated PlayerState handlers, with the match's `rngBots`, and see only what a player sees (bot.js:1-6).
- Band and 机变 picks: `botPickBand` / `botPickCard` (bot.js:135, :164). Band picks happen at once (Match.js:1603). 机变 picks come after `DELAYS.BOT_ACTION` 900 ms (:1839).
- Prep: economy → lineup → placement → rehearsal of up to `botRehearsal` (default 3) layouts with the real Battle → items → Ready. It runs in wall-clock slices of 8 ms (`scheduleBotPrep` Match.js:2003-2051; bot.js:7-60).
- The bot plays AI seats and AI 托管 humans (`botControlled`, PlayerState.js:174; it also covers departed seats, but those are already eliminated). Tools: `tools/botbench.mjs` (META §6 :777).

## 9. Checkpoints, replays, rules version

- **RecordedMatch** (checkpoint.js:28) runs on the Worker only: room-runtime.js:135 and lobby-gateway.js:90. The Node server uses a plain `Match` (lobby.js:92).
  - It drives a manually pumped `VirtualScheduler` and logs every input (checkpoint.js:7) and every timer firing as `{ kind, at, args }` (:66-99, `pump` :179).
  - `exportMatch` = recording + `publicView()` + the 6 rng states (:194).
  - `restoreMatch` replays the log and throws `CHECKPOINT_VERSION` (rules version mismatch, :202), `CHECKPOINT_EVENT_LIMIT` (> 200 000 events) or `CHECKPOINT_STATE_DIVERGED` (view or rng differs, :213).
- **recorder.js** captures battle traces:
  - `appendReplayReport` (:4): the authority's client inputs, contiguous `seq`, ≤ 20 000 inputs.
  - `recordServerSpec` (:37): a server battle is its spec plus forced-end inputs.
  - `recordServerBattle` (:63): frames, used for shared-pool boss battles.
  - Each trace becomes a `replayBattles` entry `{ source: client|server|missing, spec, inputs, tick, complete, … }` (checkpoint.js:148-171).
- **RULES_VERSION** (shared/rules-version.js:1): esbuild's `define` (tools/build-worker.mjs:262), else `'development-v1'` (Node server, tests).
  - The id is the first 20 hex characters of a sha256 over two engine bundles built with a placeholder (build-replay.mjs:31-35, :66-89).
  - The bundles are `worker/replay-engine.js` (browser replay: server/data + server/sim) and `worker/recovery-engine.js` (server/match/checkpoint → all of Match + data).
  - Only code or data inside those bundles changes the id. Docs, Worker HTTP code and assets.json do not (ACCOUNTS-HISTORY.md:91).
- **Archive**: replay-versions.json has 14 entries (newest `c9d8e0a46e1bb4257a21`). It stores sha256 hashes of `replay-versions/<id>.json.gz`, which is committed and never changed (build-replay.mjs:9-12, :112-121).
- **Why archive before a CI deploy**:
  - `npm run deploy:worker` = `node tools/build-replay.mjs --release && wrangler deploy` (package.json:41). It needs a clean tree (:135-145). A new version is archived and the command exits 1: commit the two files, then run it again.
  - A CI build (`CI` / `WORKERS_CI`) never mints (:40). It throws "Rules version … is not archived" (:105-110 via build-worker.mjs:165-166).
  - The reasons: an old match replays only with its own archived engine, every archived engine stays published, and a live match restores after a deploy only if its version is current or among the `RECOVERY_RETAINED` = 3 newest older ones (build-replay.mjs:33; worker/do-storage.js:17; room-runtime.js:277). Without the archive, production would run a version whose replays and restores cannot be reproduced.
  - Roll back with `git revert`, never with the Cloudflare console across a rules change (ACCOUNTS-HISTORY.md:96).

## 10. Invariants and audit

- `collectViolations(m)` (invariants.js:33) checks structure and never throws: pool sums, economy ≥ 0, uid uniqueness, hand 10 / temp 5, no un-merged triples, board legality and the deploy cap, `ps.bonds` == a fresh `computeBonds`, layers ≤ 999, eliminated players owning nothing, team LP / boss pool ranges (header :1-17). `test/match/harness.js checkInvariants` asserts the list is empty.
- `attachAudit(m)` (audit.js:63) wraps phase transitions and checks rules: income, price −1, freeze, temp lifetime, prep-end funds wipe, merge tile, draft LP = totalHp, 机变 card count, 联防 helper order, settle LP, boss pairing / pool, hidden gate, titles, deadline lengths (header :1-49). It is used by `tools/matchrun.mjs --check` and the fullmatch tests.

## 11. How a lobby room starts a match (server/lobby.js)

- **Room**: solo rooms have 1 seat. Co-op rooms have `capacity` 4–8 (`coopCapacity` lobby.js:125, :197). The host adds bots (`addBot` :809, names from `BOT_NAMES` :122, ids `ai_<hex>`).
- **`room.start`** (host only, :864): every other human must be connected and ready (`NOT_READY` :871). Solo needs exactly 1 human and 0 bots (:874-875). There is a per-network running-match limit, `maxMatchesPerAddr` 8.
- **`startMatch`** (:951) builds `seats[]` = `{ seat, playerId, name, isBot, connected, loadout, picks }` (humans only for the last two, :954-960), a random seed, `matchNo` = matchCount + 1 (:976), spectators and the send / broadcast / onEnd closures. It then announces the room and calls `match.start()` (:992).
- **During the match** the lobby forwards `g.*` / `b.*` to `match.handle`; `g.leave` becomes `onLeave`. It also forwards `room.loadout` → `setLoadout`, `room.pick` → `setPicks` and reconnects → `onReconnect` / `addSpectator`.
- **`onMatchEnd`** (:1004) returns the room to LOBBY, frees departed seats, un-readies humans and disposes the match on the next macrotask.
- **匹配** queue groups ≤ 4 same-difficulty players into a normal co-op room (`startQueuedMatch` :595; DESIGN §28.1 :2348).

## 12. How to test

| Command | What | Measured here (4 cores) |
|---|---|---|
| `node --test test/match/waiguan.test.js test/match/pool.test.js test/match/merge.test.js test/match/largeroom.test.js test/match/checkpoint.test.js` | targeted unit files | 52 tests, 35 s |
| `MATCH_SEEDS=3 node --test 'test/match/*.test.js'` | whole match suite (glob, not the directory) | 605 tests (603 pass, 2 skipped), 227 s |
| `npm run test:fast` | every test file, `MATCH_SEEDS=3` (tools/test-fast.mjs:12) | 4321 tests (4295 pass, 26 skipped, 0 fail), 428 s (the header's "≈1–2 min" does not hold on 4 cores) |
| `npm test` | `node --test`, `MATCH_SEEDS` default 20 (test/match/fullmatchRun.js:11); the release gate per test-fast.mjs:8 | not run; UNVERIFIED. The test-fast.mjs:2 header claims about 3 min, but `test:fast` took 428 s here; expect longer with 20 seeds |
| `SP_E2E=1 node --test test/ui/waiguan.e2e.test.js` | browser e2e (needs Chrome); every `*.e2e.test.js` skips without `SP_E2E` (e.g. waiguan.e2e.test.js:21) | not run |
| `node tools/matchrun.mjs --mode coop --difficulty NORMAL --players 4 --seed 1 --check --errors` | one headless bot match with the rule audit (`--players 1..8`, `--seeds N`, `--lp N`, `--layers N`) | 17 s, 1121 rule checks, 0 violations (seed 1 won R14, no Hidden Core) |

- **`MATCH_SEEDS`** sets the seeds per full-match soak file. The 5- and 8-seat files use min(MATCH_SEEDS, 6) (fullmatch-coop-5seats.test.js:4).
- **Harness** (test/match/harness.js:1-16): `makeMatch({ mode, difficulty, humans, bots, seats, seed, fake, clientCombat … })`. It runs in virtual time with instant combat by default and `clientCombat: false` (the legacy server-run mode). Helpers: `h.toPrep(r)` drives the human decisions, `h.drive(pred)`, `h.autoHumans()`, `h.invariants()`, `h.ps(id)`, `h.lastTo(id, type)`.
- **Harness gotcha (verified)**: `h.start(); h.runToPhase('PREP')` stalls at INFO_CHECK when a human seat exists. Use `h.toPrep(1)` (harness.js:89-130).
- **Other test files**: `test/match/fakeBattle.js` is a scriptable Battle (`BattleClass` option). Full-match soaks: fullmatch*.test.js via fullmatchRun.js; above 4 seats, fullmatchLarge.js checks every view.
