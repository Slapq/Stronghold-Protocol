// public/js/battle/digest.js — what a view that did not see a span of a local battle still has to learn (pure; runner.js).
//
// The runner steps a battle it does not render (a hidden tab's 250 ms pump, a battle off screen, the silent catch-up
// before a field is shown) and used to throw away every event of that span. Lasting state is event-driven in the view
// (units.js statuses, render/fxsustain.js records bound to them), so a status that ended in the dark left its aura and
// its icon up to the end of the battle, a unit that spawned in the dark stayed a nameless placeholder, and a 影哨
// recalled in the dark stayed drawn. The digest keeps the little that fixes this, and nothing that would draw a stale
// one-shot:
//   * the LAST status change of every (unit, key) — on or off (an off ends what the view holds, an on starts its icon
//     and, marked 'late', the lasting look of a kind that names that status: expose / wanted / taunt / shields …);
//   * the END of a skill (its last 'off' of the span): a skill that began meanwhile and still runs is turned on by the
//     snapshots' SKILL flag (render/units.js) — replaying its start would flash its activation and play its voice long
//     after it began;
//   * the spawn of every unit still alive (survivors only, in order; a die / leak drops the unit's spawn);
//   * the last 影哨 event of every caster ('sentry' placed / 'sentryRecall' taken back: the later one wins), marked
//     `late`: its record only, not its summon pillar / recall streak.
// Never atk / dmg / heal / fx one-shots, and never die / leak: they replay at stale positions in one burst, and
// the snapshots already take a unit that left away (render/app.js syncBattle). Lasting fx STARTS (a wall, a link, drones)
// are not kept either: a viewer that was not looking misses what began meanwhile (it shows less, never something false),
// except the auras a handed-over status names (above).
// Fed ONLY with events that nobody saw; delivered frames never touch it.

import { isLastingFxEvent } from '../render/fxsustain.js';

const isStr = (v) => typeof v === 'string';

/** The state-bearing b.ev kinds: what a catch-up frame carries, and what a field entered mid-battle still wants. */
export const STATE_EV = new Set(['spawn', 'die', 'deploy', 'status', 'skill', 'leak']);

/**
 * The events a view that is entered mid-battle takes from the span between its field meta and its first frame
 * (screens/game.js early buffer): the state events and the lasting fx starts / ends (影哨, a wall, drones …), never a
 * stale one-shot (atk / dmg / heal / layer / bounty / any other fx).
 */
export const isEnterEvent = (e) => Array.isArray(e) && (STATE_EV.has(e[0]) || isLastingFxEvent(e));

/** 伊内丝's 影哨 fx (placed / recalled): the only fx the digest keeps. */
export const isSentryFx = (e) => Array.isArray(e) && e[0] === 'fx' && (e[1] === 'sentry' || e[1] === 'sentryRecall') && !!e[4] && typeof e[4] === 'object' && e[4].id != null;

export class EventDigest {
  constructor() { this.reset(); }

  reset() {
    this.seq = 0;
    this.spawns = new Map();      // unit id → ['spawn', info] (insertion order = spawn order)
    this.statuses = new Map();    // unit id → Map(key → { n, e })
    this.skills = new Map();      // unit id → { n, e }
    this.sentries = new Map();    // caster id → { n, e }
  }

  /** Number of events take() would return. */
  get size() {
    let n = this.spawns.size + this.skills.size + this.sentries.size;
    for (const m of this.statuses.values()) n += m.size;
    return n;
  }

  /** Remember what matters of `evs` (a drained batch, in order). */
  feed(evs) {
    if (!Array.isArray(evs)) return;
    for (const e of evs) {
      if (!Array.isArray(e)) continue;
      const n = ++this.seq;
      switch (e[0]) {
        case 'status': {
          if (e[1] == null || !isStr(e[2])) break;
          let m = this.statuses.get(e[1]);
          if (!m) this.statuses.set(e[1], (m = new Map()));
          m.set(e[2], { n, e });
          break;
        }
        case 'skill':
          // only an end: what began and still runs comes back with the SKILL flag (a later start keeps the end: the view
          // must still end what it held from before)
          if (e[1] != null && !e[2]) this.skills.set(e[1], { n, e });
          break;
        case 'spawn': {
          const id = e[1] && typeof e[1] === 'object' ? e[1].id : null;
          if (id == null) break;
          this.spawns.delete(id);       // (re-spawned: its new place in the order)
          this.spawns.set(id, e);
          break;
        }
        case 'die': case 'leak':
          // gone: the snapshots remove it, so its spawn is not worth telling. Its last status / skill events stay: the sim
          // ends an operator's buffs and skill at its death, and a knocked-out operator's view outlives it (a view that
          // is gone ignores them)
          if (e[1] != null) this.spawns.delete(e[1]);
          break;
        case 'fx':
          if (isSentryFx(e)) this.sentries.set(e[4].id, { n, e });
          break;
        default: break;
      }
    }
  }

  /**
   * The events to hand over, then forget them: the survivors' spawns first (`spawns: false` when the view builds the
   * live units itself — a field shown again — see runner.js show()), then every status / skill / 影哨 event in the order
   * the sim sent it.
   */
  take({ spawns = true } = {}) {
    const out = [];
    // (a `late` mark: render/app.js draws no spawn ring at the gate for a unit that came in while nobody looked)
    if (spawns) for (const e of this.spawns.values()) out.push([e[0], e[1], 'late']);
    const rest = [];
    for (const m of this.statuses.values()) for (const r of m.values()) rest.push(r);
    for (const r of this.skills.values()) rest.push(r);
    for (const r of this.sentries.values()) rest.push(r);
    rest.sort((a, b) => a.n - b.n);
    // marked late: a status that is on makes the lasting look its (unreplayed) fx would have made (render/fxsustain.js
    // status); a 影哨 event updates its record without its one-shot look (fx.js simFx)
    for (const { e } of rest) {
      if (e[0] === 'status' && e[3]) out.push([e[0], e[1], e[2], e[3], 'late']);
      else if (e[0] === 'fx') out.push([e[0], e[1], e[2], e[3], { ...e[4], late: true }]);
      else out.push(e);
    }
    this.reset();
    return out;
  }
}
