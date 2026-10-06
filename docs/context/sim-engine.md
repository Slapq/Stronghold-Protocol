# Context brief: battle simulation engine (`server/sim`)

Agent-facing digest of the sim. Each claim cites `file:line` (verified against the tree at `3ed980f`, 2026-10-06; line numbers drift, so grep the
named symbol when one is off). Normative contract: DESIGN.md §5 (lines 154–318); full reference: docs/SIM.md (map in §16); section index of every
long doc: docs/context/DOC-INDEX.md. `UNVERIFIED` = not checked here; `[ASSUMED]` in the code = the authors' own guess at official behaviour.

**Model.** One `Battle` = one field (`kind` normal / unite / boss / hidden; rects shared/constants.js:65-67): a fixed-step (TICK = 1/30 game s,
constants.js:7), seeded, fully automatic sim. Players never act during a battle; they only place pieces in prep (tile, `dir`, items, skill/module
loadout). The engine deploys everything, auto-casts every skill by trigger rule, redeploys knocked-out operators for DP and reports a
`BattleResult`; the match turns it into LP, coins and layers. Content plugs in only through hooks and engine helpers (DESIGN §5.4, SIM.md §5–6).

## 1. Facts agents get wrong
| Wrong belief | Truth | Evidence |
|---|---|---|
| "There is no DP / deployment cost in battles." | Each player has `ps.dp`: starts at `dpInit` 10, gains `dpPerSec` 1, capped at `dpMax` 99 (data/config.json `dp`). The **initial** deployment is free. Every **redeploy** after a knock-out waits for DP ≥ `base.cost` (chess.json `stats.cost` 8–36; `respawnTime` 18–80 s) and pays it. Content also spends and grants DP. | constants.js:147; gamedata.js:511-514; Battle.js:202, 411, 371-375 (no DP in `_deploy` 869-922), 1078-1085, 2209-2214; professions.js:126-146; 29 `addDp` calls in kits/ |
| "MANUAL skills need a player to press them." | No client→server message casts or retreats anything: the only battle C2S messages are `b.progress` / `b.result`. `SkillRuntime` auto-casts **every** skill by its 技能策略 trigger rule. `skillType` MANUAL only adds the 3 s automatic-operation cooldown, which is also armed by the battle-start deployment. | shared/protocol.js:377-388; skills.js:8-31, 98, 344, 450; Battle.js:909; constants.js:148-156 |
| "Trigger rule `MANUAL` = skillType MANUAL." | Two different fields. The trigger **rule** `MANUAL` is renamed `NEVER`: no auto-cast, the kit calls `skill.activate()` itself. `def.skillType` MANUAL/AUTO decides only the cooldown. | skills.js:87-89, 98, 333 |
| "Tests behave like production." | `makeBattle` sets `flags.startOpCooldown: 0`. Production uses 3 s. Pass it explicitly when you test cast timing. | battleHarness.js:25-28, 193; Battle.js:109-111 |
| "A stunned unit's SP stops." | Time SP keeps recovering while stunned. Only 阻回 (`noSp`) and a running timed skill stop it. Stun / 沉默 block **casting**. | skills.js:259-261, 313-320, 327 |
| "Skill ATK+X% and bond ATK+Y% multiply." | They are summed into `atkPct`: (base+flat)×(1+Σpct)×Π*Mul. Only `*Mul` keys multiply. | units.js:3-9, 121; constants.js:220-232; generic.js:10 |
| "Two buffs with the same key stack." | One instance per key, governed by `refresh` (default `replace`). Only `independent` keeps several instances. Different keys stack. | buffs.js:5-8, 147; Battle.js:1227-1276 |
| "A KO'd operator respawns at its home tile." | It lies where it fell (`body`) and redeploys there. Exception: when it fell on another piece's home, it goes back to its own home if that is free. No ally may deploy on a body tile. | Battle.js:2112-2147, 1073-1088 |
| "Kits are keyed by chess id incl. `_b`." | Kits are keyed by `baseId` (`chess_char_X_YY_a`). The exact id or the suffix-less id is also accepted. Elites `_b` share the kit. | content/index.js:64-67; kits/tier1.js:3 |
| "A non-default skill uses `kit.skill`." | Lookup order: `kit.skills[selectedSkillId]`, else `kit.skill` (default skill only), else the **generic** spec. Talents, trait and `install` always come from the kit. | content/index.js:155-167 |
| "The Battle decides win/loss/LP." | The Battle only reports `reason` 'cleared' / 'timeout' / 'forced' plus per-player `leaked` / `perfect`. On timeout, enemies still alive count as leaks. The match charges LP = min(lpCapPerRound, counted leaks) per normal round. | Battle.js:479-544; Match.js:3164-3174 |
| "Only enemies in range can be hit." | A blocker can always target the enemies it blocks, in range or not, whatever its facing (ranged blockers too). Heal attacks are the exception. | Battle.js:1159-1164; ai.js:107-143 |
| "Summons cost DP / come only with the skill." | `spawnToken` never charges DP. A skill summon placed on the board deploys once, free, at the battle start (`SKILL_SUMMON_START_DEPLOY = true`). After that it is docked until the skill gives one. | Battle.js:1812-1839; shared/constants.js:87; tokens.js:290-345 |
| "The server simulates every battle." | The default is client-side combat (`SP_COMBAT=server` = legacy). The browser runs `createBattleFromSpec` from the same spec. The server re-simulates on takeover or verification. | Match.js:180-181, 374, 2541-2601; public/js/battle/runner.js:730 |
| "Time limits are real seconds." | Battle time is game seconds. The match passes the real `combatTimeLimit` × `combatTimeScale` (2). | gamedata.js:431-439 |
| "Defs from `battle.data` can be tweaked." | They are deep-frozen and shared by every battle in the process. Copy them (`{...bb}`) first. | simdata.js:500-506, 553; SIM.md:1255 |

## 2. Where to look
| Topic | Code | Doc |
|---|---|---|
| Ctor / initial deployment / tick loop | Battle.js:3-5, 79-177, 349-398, 400-455 | SIM.md §1 (34, 59-77) |
| End checks / timeout / result | Battle.js:479-578 | SIM.md §1.3 (373) |
| Deploy / kill / retreat / redeploy | Battle.js:869-1088, 2094-2147, 2375-2392 | SIM.md §1 (81-96) |
| Buffs / statuses | buffs.js:20-208; Battle.js:1227-1507 | SIM.md §3 (503) |
| Stat aggregation | units.js:113-169 | SIM.md §2 (438) |
| Damage / heal / elements | damage.js:1-542; Battle.js:1512-1540 | SIM.md §4 (644) |
| Hooks (names + ctx) | Battle.js:583-648; battleHarness.js:40-44 | SIM.md §5 (708) |
| Engine helpers for content | Battle.js:1785-2263 | SIM.md §6 (752) |
| Skills / triggers | skills.js:1-553; tools/build-data.mjs:440-507 | SIM.md §7.1 (792); DESIGN §5.6 (280), §21.29 (1469) |
| Ally attack loop + enemy AI | ai.js:68-315, 447-716; grid.js:409 (findPath) | SIM.md §1.2 (165) |
| Targeting / ranges / blocking | targeting.js:25-229; Battle.js:1122-1222, 1731-1775; constants.js:30-37 | DESIGN §3 (125); SIM.md §1.2 (211) |
| Professions | professions.js:39-648 | SIM.md §8 (1112) |
| Data / loadouts | simdata.js:99-198, 514-725 | SIM.md §12 (1268); DESIGN §16 (605) |
| Kit loader, generic kit, summons | content/index.js:1-218; generic.js:1-393; tokens.js:1-90, 285-345 | SIM.md §7.2–7.4 (851-970) |
| Spec, client combat, match → battle opts | spec.js:1-133; Match.js:2112-2166, 2290-2363; PlayerState.js:1548-1581 | DESIGN §14 (547), §6 (319) |
| Wire format | snapshot.js:22, 110; Battle.js:2313-2362 | SIM.md §9 (1182) |

## 3. Battle lifecycle (Battle.js)
- **Construct** (79-177). Sanitises rect/timeLimit/DP flags (96-116). A non-boss with a bad limit gets 60 s; boss/hidden get ∞ (107). Then
  `_addPlayer` per input (182-235), queues spawns (169-170) and runs `installContent` (174). Last, `_setupUnit` per ally (317-344): kit →
  `resolveProfile` → `SkillRuntime` → profile/talent/kit `install`.
- **`start()`** (349-398), on the first `step()`. Spawns stage devices. Deploys every op, then every token, column by column left→right and top→bottom
  within a column (363-364). On shared fields the i-th unit of every player comes in together (371-375). Skips `deferDeploy` pieces. Initial-deploy
  summons rank after all operators in aggro (380-381). Forces out 联防 `carryState.down` operators (386-390) → `battleStart` → re-reads their redeploy
  timers (394-397).
- **`step()`** (400-455): scheduled → spawns → DP → buffs + HP regen → enemies → enemy tile index → allies (`skill.tick` then `updateAlly`) →
  projectiles → auto-redeploys → boss-pool sync → `tick` hook → release removed units' hooks → `time = tickCount × dt` → `_checkEnd`. Every phase and
  content callback is try-wrapped. Errors are logged once per key, and more than 200 internal errors force a timeout (2406-2438; constants.js:176). A
  hook nesting depth above 32 skips the handlers (623-631; constants.js:200).
- **End** (479-491). 'cleared': the shared boss pool is empty, or (autoFinish, not a pool-holding boss field) no pending spawns + no live enemies + no
  `holdsBattle` timers. 'timeout' fires at `timeLimit` or MAX_BATTLE_TIME 3600 s. `_timeout` (498-518) turns live non-boss enemies into leaks and
  drops unspawned ones from `total` (`result.unspawned`). `forceEnd` (520-528) defers to the phase end while a step runs.
- **Result** (546-572): `{ time, reason, perPlayer: { killed, total, leaked[], perfect, layerGains, coins, damageDealt, bossDamage, healingDone,
  deaths, unitsEnd[{uid,hpPct,sp,…}], unitStats[] }, killed, total, errors, bossHpLeft? }`. `perfect` = no counted leak (550). `unitsEnd.sp` =
  `spTotal` (charges × cost + sp), the 联防 carry (skills.js:176-180).
- **Coordinates** (20-24, 238-255). Input tiles are board coords (rows 9–12, cols 2–10). Boss fields: row − 7. The mirrored right side maps col → 20 −
  col and swaps RIGHT ↔ LEFT. `abs` or `coords:'field'` passes tiles through.

## 4. DP, deployment, retreat, knock-out
- DP: per player `ps.dp` (202) += `dpPerSec × dt` capped at `dpMax` (411). `addDp(pid, n)` clamps to [0, dpMax] (2209-2214). The snapshot sends `dp`
  (player 0) and `dps` per player (2338-2345).
- `_deploy(u, {initial, carry, tile, keepSp})` (869-922) costs no DP. It refuses tiles outside the rect, occupied tiles and body tiles (872-881).
  Effects: full HP (or the 联防 `hpPct`), `skill.reset(carry)`, `opReadyAt = now + startOpCooldown` on the initial deploy (909), then the `deploy` hook.
  The 联防 SP is re-set after the hooks (920).
- `kill()` (925-937) emits `kill` (a handler may revive the unit) → `_remove(…'killed')`. `retreat(unit, {reason, permanent})` (943-946). `_remove`
  (948-1003) ends the running skill, releases blocked enemies, keeps only `persist` buffs, and for an op sets `respawnAt = now + respawnTime ×
  persist.redeployMul × s.redeployMul` (975-976) and lays the body (977). Tokens/devices/enemies are `removed` for good (978-980, 983). Reasons: 'killed' /
  'retreat' / 'merchant' / 'expired' / 'forcedExit' / 'leak' (SIM.md §5; constants.js:171), and 'raid' = no body (2376).
- Auto-redeploy `_checkRedeploys` (1073-1088): timer done, then DP ≥ `base.cost`, then the rest tile free → pay → `_deploy`. `isDown` (2375-2378) /
  `_downState` (2385-2392) → snapshot `down` with COUNTING / WAIT_DP / WAIT_TILE (constants.js:162).
- `redeploy(unit, {free=true, tile, keepSp})` (1039-1066) is the content-driven redeploy; `free:false` pays the cost and refunds it on failure.
  `moveRedeploy` (1944-1955) = 【移动】, a new deployment with no exit. `persist.freeRedeploys` (units.js:90) is declared but unused in server/sim (grep).
- Data defaults when a record lacks values: cost 10, respawnTime 70 (simdata.js:143-144).

## 5. Units (units.js)
- `kind` op | token | enemy | device (33). `base` holds the raw stats (52-56). `s` is the lazily aggregated stats (105-169), invalidated by
  `markDirty()`. Changing maxHp keeps the HP ratio (166-168). ASPD is clamped to 20–600 and `interval = bat×(1+ΣbatPct)×100/aspd` (124-129).
  `s.flags.stun` = stun | freeze | sleep | levitate (163). `canAct` (175). `isFlying` = FLY motion, or an enemy that is `float` / `levitate`
  (184-189).
- Enemies are built in `spawnEnemy` (Battle.js:777-859): wave mods hpMul / atkMul / …, `enemyOverrides`, `tag:'boss'` → `isBoss` + shared pool
  (848-851). Ally defs go through `_makeAlly` (293-314).

## 6. Buffs and stacking (buffs.js)
- Mod keys: additive `ADD_KEYS` (×stacks), multiplicative `MUL_KEYS` (^stacks), boolean `FLAG_KEYS` (OR) (20-45, 171-208). Dodge sources combine as 1
  − Π(1 − p) (177-206). Shields add up (201).
- `addBuff` refresh on a same-key hit (Battle.js:1231-1268): `replace` (default; new object), `extend` (longer time, new mods, max shield), `stack`
  (+stacks up to max, timer reset), `independent` (≤ maxStacks instances, oldest dropped), `keep` (ignore the new one).
- Catalogue statuses `STATUS` (53-120) go through `applyStatus` (Battle.js:1365-1429): enemy immunities (1375) → `beforeStatus` (1380-1387) → 抵抗
  shortens `RESIST_STATUSES` (127-128; 1388-1391) → levitate halved above massLevel 3 (1392) → a second 寒冷 becomes 冻结 (1394-1409). The default refresh
  is `extend` (1419). "Valued" statuses (slow, fragile, weaken, defDown, …) keep the strongest value; a weaker one resumes later as a tail
  (1476-1505). `applyStrongest` does the same for non-catalogue effects (1466).
- `persist: true` buffs survive death and redeploy (Battle.js:965-971). The tick loop decrements buffs, runs `onTick`/`interval` and `onExpire`, then
  natural HP regen (1300-1344).

## 7. Skills (skills.js)
- **SP types**: time (+spRecovery/s), attack (+1 per attack), hurt (+1 per hit taken), none (3; simdata.js:80-86). No gain while a
  duration/ammo/toggle skill runs (259) or under `noSp` (261). Attacks made by the skill itself never give attack-SP (482-484, 501). Charges: SP fills
  → +1 charge, until max (277-283). `initSp` is applied on every (re)deploy (217). A free (cost 0) skill is available once per deployment (219).
- **Kinds** (32-34, 79): `duration` / `ammo` (optional duration cap) / `instant` / `charges` (instant + charges) / `passive` (on from deployment, no
  SP: 100, 212-214) / `toggle` (on until death). Timed kinds apply `spec.mods` as buff `skill:<id>` (243-254). An instant skill with `spec.attack`
  overrides exactly the next attack (`pending`, 460, 497-500).
- **Trigger rules** (`rule`, 86-91; data from build-data `resolveTrigger`, tools/build-data.mjs:481-507):

| Rule | Fires when | Checked |
|---|---|---|
| DEFAULT | ready + about to attack/heal + an enemy (heal skill: an injured ally) in the **initial** range (`baseRangeKeys`), or an enemy it blocks, or an enemy in a content trigger range (400-413, 416-424). A no-attack unit checks every tick (336-339). Options `trigger.allies` / `hpAtMost` (92-95, 321-326). | `ai.js:84` before each attack |
| SKILL_RANGE | any living enemy on the skill's own range grid, incl. stealthed / untargetable / flying ones (`trigger.allies`: an injured ally instead) (383-387) | every tick |
| TAKE_DAMAGE | ready + just took a hit (427-433); 重装 class row | on `damaged` (damage.js:318) |
| SP_FULL (=ALWAYS) | as soon as ready (88, 375) | every tick |
| CUSTOM_RANGE* | an enemy on the custom grid (379-382) | every tick |
| SEARCH | an enemy in the initial range, no attack needed (378) | every tick |
| GDGLOW_SKILL_2 | a targetable enemy anywhere (heal: an injured ally) (389-392) | every tick |
| NEVER (=MANUAL rule) | never; the kit calls `activate()` | — |
| unknown (e.g. data `MLYSS_WTRMAN`) | treated as DEFAULT (333-340, 419) | — |

- Class rows (profession / subProfession) apply only to MANUAL skills. A MANUAL operator skill that has its own 技能范围 and no row gets SKILL_RANGE.
  `TRIGGER_DEVIATIONS` sends six 重装 skills and 余 S2 elsewhere (build-data.mjs:440-460, 481-507; simdata.js:107-110).
- **AUTO_OP_COOLDOWN** = 3 s: a MANUAL skill auto-casts no sooner than 3 s after its last cast or after the battle-start deployment (344, 450;
  Battle.js:909). AUTO skills are exempt. A direct `activate()` is not held back but still restarts the cooldown (26-31). Kits that cast on their own
  check `skill.opCooling` (347).
- Hooks: `skillStart` / `skillEnd` / `ammoUsed` / `spGain`. `onEnd` runs while the mods are still applied (505-523). Content API: `addAmmo`, `extend`,
  `addCharge`, `stop`, `spCostMul`, `addTriggerRange` (124-128, 541-548).

## 8. Damage, heal, shields, elements (damage.js)
- `dealDamage` (218-272) runs in this order: `type:'element'` → gauge path · invulnerable / sleep / 起飞 evasion · `hit` hook (mutable `dmg`, `cancel`)
  · dodge with `battle.rng()` (237-244) · 频次 units take 1 per instance (248-251) · mitigation with a 5 % floor (145-161; constants.js:58) · ×
  `dmg.mul` × target `dmgTakenMul` (not elemental) × source `dmgDealtMul` × phys/arts dealt mul × type-taken mul (262-265) · 限伤 (176-181) · shields
  (184-213) · `applyHpLoss` (277-322).
  - Mitigation: phys A − D′ (D′ = D×(1−defIgnorePct) − defIgnoreFlat); arts A×(1 − R′/100); true unchanged; elemental by 元素抗性.
  - 限伤: a leader hit ≥ 300000 in a boss/hidden battle is cancelled (shared/constants.js:125).
  - Shields: `shieldHits` barriers first, then HP shields.
  - `applyHpLoss`: boss-pool routing → `fatal` (may set `prevented`) → `damaged` → SP-on-hurt / TAKE_DAMAGE → `kill`.
- `sourceless` (无来源) damage: hooks see `source:null`, `credit` keeps the stats and kill credit (29-34, 222-226). `loseHp` (流失, tag 'hpLoss') skips
  DEF/RES, dodge and shields (Battle.js:1529-1536).
- `heal` (513-542): `noHeal` blocks heals from others, `healFree` (禁疗) blocks self heals too; × `healingDealtMul` × `healingTakenMul`; `heal` hook;
  `overheal` → shield.
- Elements: gauge 1000 (leaders 2000). Bursts have side-specific effects plus a lock during which nothing fills (constants.js:60-102;
  damage.js:381-482). `reduceElement` = element healing (496-505).

## 9. Targeting, ranges, blocking
- Range grid = `[dRow, dCol]` offsets in the facing-RIGHT frame, rotated by `unit.dir`. `rangeExtend` adds tiles past each row's far end
  (targeting.js:3-7, 25-47). `_refreshRange` (Battle.js:1731-1748) builds two key sets: `rangeKeys` (current range = skill grid or own grid, + extend,
  + `extraRangeKeys`) and `baseRangeKeys` (initial range = own grid + permanent extend; the DEFAULT/SEARCH trigger uses it).
- Ally target choice `acquireTargets` (ai.js:107-143): heal profiles pick injured allies; otherwise enemies in `rangeKeys` plus everything blocked.
  Then `sortEnemyTargets` (targeting.js:189-204): blocked by me → profile priority → enemy taunt → least remaining path → earliest spawn.
  `canTargetEnemy` (78-86) applies stealth / untargetable / flying / sleep.
- Enemy choice of an ally (targeting.js:212-229): its blocker → higher taunt → latest deployed (`aggroSeq`). `canTargetAlly` (99-106).
- Blocking `_checkBlock` (Battle.js:1122-1148): contact radius ground 0.7071 / air 0.8944 / device 0.4472 (constants.js:36-37); capacity counts each
  enemy's `blockWeight`. Excess is released latest-first (ai.js:95-104).
- Attack loop `updateAlly` (ai.js:68-92): the cooldown runs only while the unit can act. Checks: noAttack / disarm / canAttack → targets →
  `skill.onAboutToAttack()` → `performAttack` → `atkCd = s.interval`. `resolveHit` (205-282) = ATK × atkScale × atkScaleMul × skill/profile mul,
  `hits` instances, splash (centre test), chain.

## 10. Projectiles (projectiles.js)
- A ranged profile whose projectile is not 'none' or 'beam' fires one projectile per target, and the damage lands on impact (ai.js:158, 167-171).
  'beam' and melee hit instantly (172-173).
- A projectile homes on the target. It fizzles when the target dies or redeploys (tracked by `tseq`) unless `hitDead`; attacks set `hitDead =
  splashRadius > 0` (projectiles.js:28-30, 52-55; ai.js:170). `maxAge` defaults to 10 s (40).
- Speeds: constants.js:46-55. Boomerang: out then back, and the thrower waits for its return (ai.js:189-202).
- Content API: `battle.addProjectile({from, target|to, speed, onHit, visual, source, hitDead})` (Battle.js:1910).

## 11. Professions (professions.js)
- Profile resolution (593-645): `PROFESSION_DEFAULTS` (39-49) → `SUB[subProf]` (412-526) → `TUNE` from the trait blackboard (532-582) → data fields
  (dmgType / attackKind / projectile / canHitFly / targetPriority / splashRadius) → `kit.trait` → `rangeAoe` ⇒ allInRange + 'beam' (640-643). Tokens
  with ATK 0 never attack (627-630).
- Notable traits:
  - snipers (414-443): fastshot ×vs flyers; longrange lowDef; aoesniper splash 1.1; bombarder 0.9 ground-only + aftershocks; hunter ammo; loopshooter
    boomerang; reaperrange all-in-range + front ×1.5.
  - casters (451-465): splash 1.1; blast/phalanx range-AoE; chain 3 jumps, −15 %, r 1.7 + sluggish; funnel ramp; mystic stored hits. Medics (467-472):
    single / multi 3 / chain / far ×0.8 / element heal / incantation (arts → heal).
  - supporters (474-479): slower sluggish; bard aura, no attack. Tanks (481-487): shotprotector ranged; unyield noHeal; fortress.
  - guards (489-506): centurion/crusher hit all blocked; hammer splash; instructor ×1.2 unblocked; librator; lord ranged ×0.8; musha/reaper self-heal;
    sword 2 hits.
  - vanguards: charger +DP on kill (509, 142-146); tactician 援军 ×1.5 (510-511).
  - specialists: merchant pays DP every 3 s, else retreats (521, 126-140); dollkeeper substitute (517, 148-260); geek drain, pusher, skywalker
    blockFly, stalker dodge (516-525).
- Coverage test: `KNOWN_SUBPROFESSIONS` (648); test/sim/professions.test.js. Behaviour notes: SIM.md §8.

## 12. Data → unit (simdata.js)
- `DataSource` (514+) normalises raw `data/*.json` once and deep-freezes the result (500-506). Without generated data the research JSON fallback is
  used (header 1-23). `normalizeChess` (154-198), `normalizeSkill` (99-131: skillType default MANUAL, trigger `{rule, grid}`, `skcom_withdraw`
  dropped) and `normStats` (133-151).
- **Loadout path**: prep `PlayerState.battleInput` (PlayerState.js:1548-1566) puts `skillIndex`, `moduleId`, `dir`, `items` (and `carryState`) on each
  unit. Then: `buildBattleSpec` keeps the loadout fields only when well-formed (spec.js:74, 81-86) → `withUnitLoadouts` builds a per-battle data view,
  so id-only lookups use the inputs' loadout per chess (simdata.js:698-722) → `Battle._createAllyFromInput` calls `getChess(chessId, {skillIndex,
  moduleId})` (Battle.js:273). The def is cached per loadout: `def.skill` = the selected skill and its bb; elites also get module stats, trait and
  talents (simdata.js:539-560). `syncUnitLoadout` (content/index.js:123-141) fixes multi-player id collisions before the start.
- Tokens: `getToken(id, ownerChessId, ownerLoadout)` merges `variants[owner]` + `bySkill[i]` / `byModule[id]` (simdata.js:573-600). Battle always
  passes the owner unit (Battle.js:286-291, 1785-1787). `producesToken` gates summons of non-default skills (1795-1803, 1818).

## 13. Content (server/sim/content)
- `index.js`: `KITS` = merged default exports of kits/tier1..6 (36, 42); `MODULES` install order is tokens, devices, enemies, bosses, bonds,
  garrisons, items, bands, choices (37-45). Modes: 'full' = kits + modules; 'generic' = generic kits only; 'none' = no kits/modules (1-7, 192-210).
  `opts.kits` (tests) take precedence (62-67). Imports are guarded (27-34).
- **Kit contract** `(bb, chess, def) => { skill, skills?, talents:[{install}], trait, install? }` (index.js:11-15; SIM.md §7.2). SkillSpec schema:
  SIM.md §7.3 (914). There are 129 `chess_char_*` keys across tier1–6. `tools/kit-coverage.mjs --missing` (run 2026-10-06) reports 112/112 chess and
  283/283 selectable skills hand-authored.
- `generic.js`: `genericKind` (75-89) and `genericSkillSpec` (106) map blackboard keys (atk → atkPct, …, header 8-38). Used for chess without a kit,
  for non-authored skills, and for tokens with skills (index.js:59, 77).
- `tokens.js`: one kit per token id (1379-1384, header 6-55); `install` (1468) calls `dockSkillSummons` (290-311). `releaseSkillSummon` (337-345)
  deploys a docked piece when the owner's skill grants one: free, at most 1 in stock. Exports `findSummonTile`, `summonToken`, `spawnYanyou`, ….
- Domain modules each export `install(battle)` (battle side) and `registerMeta(registry)` (prep side, called once at boot by
  match/effectsMeta.js:122). Split files:
  - `bonds.js` → core.js (8 core bonds) + addon (15 add-on bonds) (bonds.js:1-40);
  - `bands` / `items` / `garrisons` → `<name>/battle.js` + `<name>/meta.js`;
  - single files: devices.js (514, 583), enemies.js (267), bosses.js (241), choices.js (298, 414).
- support/index.js holds shared helpers: `directMods` gives additive % bonuses, and buff keys are namespaced `bond:` / `item:` / `gar:` / `band:` /
  `choice:`. Its header points to docs/CONTENT.md, which does not exist.

## 14. Determinism
- Only randomness: `battle.rng()`, a mulberry32 PRNG seeded from `opts.seed` (rng.js:1-45; Battle.js:81-82). Never use `Math.random` or wall-clock
  time in sim code. Time is `tickCount × dt`, so it does not drift (Battle.js:446).
- Per-field seeds come from `deriveSeed(match.seed, 'n:<round>:<seat>')` for normal fields and `'<fieldId>:<round>'` for 联防/boss fields (rng.js:48-56;
  Match.js:2150, 2294). Same spec + same data ⇒ same result: the browser and the server compare result digests (spec.js:15-16, 271). Tests:
  battle.test.js:395, core.test.js:105, loadout.test.js:221.
- Module-level sequence counters (Battle.js:48-49, buffs.js:135) are only compared within one battle (Battle.js:698, 1265).

## 15. How the match drives a battle
- Options: `Match._normalOpts(ps)` (Match.js:2142-2166) builds seed, kind 'normal', `NORMAL_RECT`, `timeLimit` = wave.timeLimit, players
  `[ps.battleInput()]`, spawns + bounties, routes, `flags {layerGainsEnabled:true, ...gd.dp}` and enemyOverrides. 联防 (`_uniteOpts`, 2290-2311) uses
  `UNITE_RECT`, helpers carrying `carryState {hpPct, sp}` or `{down:true}` (unite.js:1-30), and layer gains off. Content can edit the opts in
  `onBattleStart` (2147-2148).
- Client combat (default): `_ccField` turns the opts into a JSON `BattleSpec` (2336-2353). `_launch` assigns a human authority, otherwise
  `_runOnServer` (2541-2550). The browser runs it (public/js/battle/runner.js:730) and reports `b.progress` / `b.result`; the server validates them
  (`validateClientResult`, fields.js:738). On a deadline it takes over with `HeadlessJob` (Match.js:2589-2601; fields.js:283-347).
- Server-run (legacy `SP_COMBAT=server`, Final Assault without humans): `FieldRunner` steps fields in lockstep at 2×, snapshots every 3 ticks
  (fields.js:1-47, 88-232). Battles are built through `newBattle` (Match.js:2112-2119) or `_specBattle` (2356-2363).
- Settlement: `settle` charges LP = min(lpCapPerRound, counted leaks), or the 联防 bill, and credits coins and layer gains (Match.js:3158-3200). Boss
  fields charge leaks × `lpr` (2991, 3019).

## 16. docs/SIM.md map (1293 lines; jump with `sed -n 'A,Bp' docs/SIM.md`)
| § | Lines | Content |
|---|---|---|
| intro + file map | 1–33 | module list, determinism rule |
| 1 Driving a battle | 34–96 | ctor opts, deployment order, tick order, knocked-out bodies |
| 1.1 Coordinates | 97–164 | board→field mapping, `dir`, carryState |
| 1.2 Enemies, routes, ownership | 165–372 | routes, fear/attract, blocking, enemy attacks, zones, ownership |
| 1.3 BattleResult | 373–399 | result fields |
| 1.4 Robustness | 400–437 | error isolation, caps |
| 2 Units | 438–502 | Unit fields, hit areas, stat buckets |
| 3 Buffs, mods, statuses | 503–643 | mod/flag keys, status catalogue, elements |
| 4 Damage & heal | 644–707 | pipeline, 限伤 |
| 5 Hook bus | 708–751 | every hook + ctx, re-entrancy rule |
| 6 Engine helpers | 752–789 | content API table |
| 7.1 Skill runtime | 792–850 | SP / trigger / cooldown rules |
| 7.2 Kits / 7.3 SkillSpec / 7.4 Generic | 851–970 | kit contract, schema, blackboard mapping |
| 7.5 Worked examples | 971–1111 | 隐现, 幽灵鲨, 至简, 调香师, 赫默, 古米, 精准, 蕾缪安 |
| 8 Professions | 1112–1181 | per-subProfession behaviour |
| 9 Wire format | 1182–1212 | snapshot / events |
| 10 Testing content | 1213–1260 | harness API, soaks, test rules |
| 11 Tools | 1261–1267 | `tools/simrun.mjs` |
| 12 Data notes | 1268–1293 | def shapes, loadouts, assumption list (1288) |

## 17. How to test (node ≥ 22; times measured 2026-10-06 in this container, node 22.22)
- Sim helper: `test/helpers/battleHarness.js` exports `makeBattle` (150), `chessRec` (105), `enemyRec` (130), `checkInvariants` (264), `flatStage`
  (52), `flatRoutes` (75) and `hashOf` (312). It uses player `p1`, board coords, a synthetic `'flat'` stage and `startOpCooldown: 0`. API: SIM.md §10.
- Match helpers: `test/match/harness.js` `makeMatch({mode, humans, bots, seed, fake, clientCombat})` (31; `fake:true` → `fakeBattle.js`
  FakeBattle:23); `simClient.js` SimClient (23); `fullmatchRun.js` `runFull` (18, `MATCH_SEEDS` env:11).

| Command | Runtime |
|---|---|
| `node --test test/sim/skills.test.js` (17 tests) | ~0.5 s |
| `node --test --test-name-pattern="CUSTOM_RANGE" test/sim/skills.test.js` | ~0.5 s |
| `node --test test/sim/battle.test.js` (26) / `core.test.js` (10) / `combat.test.js` (22) | ~1.0 / 0.4 / 0.6 s |
| `node --test test/sim/professions.test.js` (17) | ~3.5 s |
| `node --test test/content/kits_t1t2.test.js` (58) | ~2.5 s |
| `node --test test/sim/robustness.test.js` (35) / `fuzz.test.js` (default N=200) | ~4.3 / ~19 s |
| `node --test test/sim/*.test.js` (631, 3 skipped) | ~54 s |
| `node --test test/content/*.test.js` (1166) | ~30 s |
| `node --test test/match/combat.test.js` / `loadout.test.js` | ~0.6 s each |
| `node --test test/match/clientCombat.test.js` (20) | ~31 s |
| `MATCH_SEEDS=2 node --test test/match/fullmatch.test.js` | ~54 s |
| `npm run test:fast` (whole suite, MATCH_SEEDS=3) / `npm test` (MATCH_SEEDS=20) | 1–2 min / ~3 min (tools/test-fast.mjs:2 header; UNVERIFIED, not timed) |
| `node tools/simrun.mjs --mode mode_multi_normal --round 5 --stage act2autochess_m01 --lineup "角峰@9,7 隐现@10,4"` | ~0.7 s; per-unit dmg/DPS/casts table |
| `node tools/kit-coverage.mjs --missing` | ~0.4 s |

- Soaks: `SIM_FUZZ_N=3000 SIM_FUZZ_CHECK_EVERY=3 node --test test/sim/fuzz.test.js` (fuzz.test.js:54-56) and
  `SIM_CHAOS_N=500 node --test --test-name-pattern="chaos fuzz" test/sim/robustness.test.js` (robustness.test.js:664-665).
- `loadout.test.js` skips without generated data (`node tools/build-data.mjs`) (test/sim/loadout.test.js:15). Content-test rules: seed everything, use
  synthetic `enemyRec` targets, assert on ids, end with `checkInvariants` (SIM.md:1258).

## 18. Unverified / caveats
- The DESIGN/SIM.md line numbers match docs/context/DOC-INDEX.md as of 3ed980f and drift with edits; regenerate it with `node tools/doc-index.mjs`.
- The official-rule assumptions the engine makes are listed in SIM.md §12 (1288-1293). Grep `[ASSUMED]` in server/sim for the rest, e.g.
  Battle.js:359-361 (shared-field summon aggro) and constants.js:150 (cooldown on the game clock).
