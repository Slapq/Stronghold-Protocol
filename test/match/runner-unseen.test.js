// What the runner hands the view after a span it did not render (public/js/battle/runner.js + battle/digest.js; review of
// the upstream PR, point 8): a hidden tab's pump, an authoritative battle off screen, the silent catch-up before a field
// is shown. Lasting state is event-driven in the view, so the last status / skill change per unit, the survivors' spawns
// and the 影哨 pairing come back as ONE b.ev before the next snapshot; never a stale one-shot (atk / dmg / heal / die / leak).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { EventDigest, isSentryFx, isEnterEvent, STATE_EV } from '../../public/js/battle/digest.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { makeBattle } from '../helpers/battleHarness.js';

// ---- the digest itself (pure) -------------------------------------------------------------------------------------

const spawn = (id, side = 'enemy') => ['spawn', { id, side, kind: side === 'enemy' ? 'enemy' : 'op', x: id, y: 10 }];
const names = (evs) => evs.map((e) => (e[0] === 'fx' ? `fx:${e[1]}:${e[4].id}` : e[0] === 'spawn' ? `spawn:${e[1].id}` : e.slice(0, e[0] === 'status' ? 4 : 3).join(':')));

test('digest: the last status change of every (unit, key), on or off; the end of a skill, never its start', () => {
  const d = new EventDigest();
  d.feed([['status', 1, 'a', 1], ['atk', 1, 2, 'none'], ['dmg', 2, 10, 'phys'], ['status', 1, 'a', 0], ['status', 1, 'b', 1], ['skill', 1, 1]]);
  d.feed([['status', 1, 'a', 1], ['skill', 1, 0], ['status', 2, 'a', 0], ['heal', 1, 3], ['fx', 'burst', 3, 3, { id: 1 }]]);
  assert.equal(d.size, 4);
  assert.deepEqual(names(d.take()), ['status:1:b:1', 'status:1:a:1', 'skill:1:0', 'status:2:a:0'], 'in the order the sim sent them; nothing else');
  assert.equal(d.size, 0, 'take() empties it');
  assert.deepEqual(d.take(), []);
});

test('digest: a skill that began in the dark is not replayed (no stale activation flash / voice); one that ended is, even if it began again', () => {
  const d = new EventDigest();
  d.feed([['skill', 1, 1], ['skill', 2, 1], ['skill', 2, 0], ['skill', 3, 0], ['skill', 3, 1]]);
  assert.deepEqual(names(d.take()), ['skill:2:0', 'skill:3:0'], 'unit 1: only a start (the SKILL flag turns it on); unit 3: its end, then the flag');
});

test('digest: survivors only — a die / leak drops the unit\'s spawn (never replayed itself); its last status / skill stay (a knocked-out operator\'s view outlives it)', () => {
  const d = new EventDigest();
  d.feed([spawn(1), spawn(2), spawn(3), spawn(4), ['status', 1, 'x', 1], ['status', 2, 'x', 1], ['skill', 2, 1], ['skill', 2, 0], ['status', 2, 'x', 0], ['die', 2, 'killed'], ['status', 3, 'y', 1], ['leak', 3], ['die', 9, 'killed']]);
  assert.deepEqual(names(d.take()), ['spawn:1', 'spawn:4', 'status:1:x:1', 'skill:2:0', 'status:2:x:0', 'status:3:y:1'], 'units 2 (killed) and 3 (leaked) come without their spawn, the die / leak events are not replayed');
  // a unit that was alive before the window and died in it: the sim's offs at its death are what its view needs
  d.feed([['status', 7, 'z', 0], ['skill', 7, 0], ['die', 7, 'killed']]);
  assert.deepEqual(names(d.take()), ['status:7:z:0', 'skill:7:0']);
});

test('digest: spawns come first in spawn order (a re-spawn takes its new place); `spawns: false` drops them (the field meta has the live units)', () => {
  const d = new EventDigest();
  d.feed([spawn(1), ['status', 1, 'x', 1], spawn(2), spawn(1), ['skill', 2, 1]]);
  const out = d.take();
  assert.deepEqual(names(out), ['spawn:2', 'spawn:1', 'status:1:x:1'], 'a skill start is not kept');
  assert.deepEqual(out.filter((e) => e[0] === 'spawn').map((e) => e[2]), ['late', 'late'], 'marked late: no spawn ring at the gate for a unit that came in while nobody looked');
  d.feed([spawn(1), ['status', 1, 'x', 1], spawn(2)]);
  assert.deepEqual(names(d.take({ spawns: false })), ['status:1:x:1']);
  assert.equal(d.size, 0);
});

test('digest: 影哨 pairing — the later of placed / recalled wins per caster, and the caster\'s death does not drop it', () => {
  const sentry = (id) => ['fx', 'sentry', 6, 10, { id }];
  const recall = (id) => ['fx', 'sentryRecall', 6, 10, { id, tx: 5, ty: 10 }];
  const d = new EventDigest();
  d.feed([sentry(1), recall(1), sentry(2), recall(2), sentry(2), sentry(3), ['die', 3, 'killed']]);
  assert.deepEqual(names(d.take()), ['fx:sentryRecall:1', 'fx:sentry:2', 'fx:sentry:3']);
  assert.ok(isSentryFx(sentry(1)) && isSentryFx(recall(1)));
  assert.ok(!isSentryFx(['fx', 'sentry', 1, 1, {}]) && !isSentryFx(['fx', 'beam', 1, 1, { id: 1 }]) && !isSentryFx(['atk', 1, 2]) && !isSentryFx(null));
});

test('a field entered mid-battle keeps the state events and the lasting fx of its early buffer (screens/game.js), never a stale one-shot', () => {
  const keep = [['spawn', { id: 1 }], ['die', 1, 'killed'], ['deploy', 1], ['status', 1, 'x', 1], ['skill', 1, 1], ['leak', 2],
    ['fx', 'sentry', 1, 1, { id: 1 }], ['fx', 'firewall', 5, 10, { id: 1 }], ['fx', 'sentryRecall', 1, 1, { id: 1 }], ['fx', 'beam', 1, 1, { from: 1, to: 2, kind: 'deathEye', dur: 6 }]];
  const drop = [['atk', 1, 2, 'none'], ['dmg', 2, 5, 'phys'], ['heal', 1, 3], ['layer', 1, 'bond', 1], ['bounty', 1, 5], ['fx', 'burst', 1, 1, {}], ['fx', 'beam', 1, 1, { from: 1, to: 2, kind: 'enemyShot' }]];
  assert.deepEqual([...keep, ...drop].filter(isEnterEvent), keep);
  assert.ok(!isEnterEvent(null) && !isEnterEvent('status') && !isEnterEvent([]));
  assert.deepEqual([...STATE_EV].sort(), ['deploy', 'die', 'leak', 'skill', 'spawn', 'status']);
});

test('digest: malformed events are skipped', () => {
  const d = new EventDigest();
  d.feed(null);
  d.feed([null, 'x', [], ['status'], ['status', 1], ['status', 1, 5, 1], ['skill'], ['spawn'], ['spawn', null], ['spawn', {}], ['fx', 'sentry', 1, 1, null]]);
  assert.equal(d.size, 0);
});


// ---- the runner ---------------------------------------------------------------------------------------------------

const POS = [[10, 4], [10, 5], [10, 6], [10, 7], [11, 4], [11, 5], [11, 6], [11, 7], [9, 5], [12, 5]];
const TEAM = ['chess_char_6_03_a', 'chess_char_1_06_a', 'chess_char_4_17_a', 'chess_char_4_22_a', 'chess_char_4_25_a', 'chess_char_4_04_a', 'chess_char_6_02_a', 'chess_char_6_18_a', 'chess_char_6_16_a', 'chess_char_6_08_a'];
/** A real sim battle: ten operators against a stream of enemies (statuses, skills, spawns all through it). */
const makeHarness = () => makeBattle({
  units: TEAM.map((chessId, i) => ({ chessId, row: POS[i][0], col: POS[i][1] })),
  enemies: Array.from({ length: 40 }, (_, i) => ({ key: 'enemy_1402_tgshd_2', time: 2 + i * 1.5, route: i % 2 })),
  seed: 3, timeLimit: 120,
});

/** The real runner on that battle ('b1'; a second copy for 'b2') behind a fake net / manual clock / manual frames. */
async function rig() {
  const h = makeHarness(), h2 = makeHarness();
  let t = 1000;
  const frames = [], intervals = [];
  const doc = { hidden: false, addEventListener() {} };
  const net = {
    sent: [], handlers: new Map(),
    on(tt, fn) { if (!this.handlers.has(tt)) this.handlers.set(tt, new Set()); this.handlers.get(tt).add(fn); return () => this.handlers.get(tt).delete(fn); },
    emit(tt, m) { for (const fn of this.handlers.get(tt) || []) fn({ t: tt, ...m }); },
    send(tt, f) { this.sent.push({ ...f, t: tt }); return true; },
    request(tt, f) { this.sent.push({ ...f, t: tt }); return Promise.resolve({ t: 'ok' }); },
  };
  const store = createStore(initialState);
  const runner = createBattleRunner({
    net, store, doc, now: () => t, raf: (fn) => { frames.push(fn); return frames.length; }, caf: () => {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval: () => {},
    loadSim: async () => ({ spec: { ...specMod, createBattleFromSpec: (spec) => (spec.battleId === 'b2' ? h2.b : h.b) }, ds: null }),
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  const feed = { snaps: [], evs: [], log: [] };
  runner.on('snap', (x) => { feed.snaps.push(x); feed.log.push(['snap', x.fieldId]); });
  runner.on('ev', (x) => { feed.evs.push(x); feed.log.push(['ev', x.fieldId]); });
  runner.on('field', (x) => { feed.log.push(['field', x.fieldId]); });
  const settle = async () => { for (let i = 0; i < 50; i++) { await new Promise((res) => setImmediate(res)); for (const fn of frames.splice(0)) fn(t); } };
  return {
    runner, h, doc, net, feed, settle,
    get t() { return t; },
    advance(ms, step = 1000 / 60) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + step);
        if (doc.hidden) { for (const fn of intervals) fn(); continue; }
        for (const fn of frames.splice(0)) fn(t);
      }
    },
    /** b.start of 'b1' (authoritative) or 'b2' (a display replica), `elapsed` game s in */
    start(id = 'b1', o = {}) {
      const spec = { fieldId: id === 'b1' ? 'f1' : 'f2', kind: 'normal', players: [{ playerId: 'p1' }], battleId: id };
      net.emit('b.start', { battleId: id, fieldId: spec.fieldId, kind: 'normal', spec, authoritative: id === 'b1', speed: 2, elapsed: 0, ...o });
      return settle();
    },
    entry(id = 'b1') { return runner._entries.get(id); },
  };
}

/** The events of a reference run of the same battle, by tick: ref[n] = what tick n emitted (ref[0] unused). */
function referenceTicks(n) {
  const h = makeHarness();
  const out = [null];
  for (let i = 0; i < n; i++) { h.b.step(); out.push(h.b.drainEvents()); }
  return out;
}

/** What the digest must hand over for a window of events (an independent, naive replay of the rules). */
function expectedDigest(win) {
  const status = new Map(), skill = new Map(), spawned = new Map();
  for (const e of win) {
    if (e[0] === 'status') status.set(`${e[1]}|${e[2]}`, e);
    else if (e[0] === 'skill' && !e[2]) skill.set(e[1], e);   // only an end (a start comes back with the SKILL flag)
    else if (e[0] === 'spawn') spawned.set(e[1].id, e);
    else if (e[0] === 'die' || e[0] === 'leak') {
      spawned.delete(e[1]);
    }
  }
  return { status, skill, spawned };
}

const key = (e) => JSON.stringify(e);
const STALE = new Set(['atk', 'dmg', 'heal', 'die', 'leak', 'layer', 'bounty']);
const STATE = new Set(['spawn', 'die', 'deploy', 'status', 'skill', 'leak']);
const tickOf = (gt) => Math.round(gt * 30);

/** `got` (the digest part of a batch) must be exactly the naive replay of `win`. */
function assertDigest(got, win, { spawns = true, label = '' } = {}) {
  const want = expectedDigest(win);
  const skillEvents = win.filter((e) => e[0] === 'skill').length;
  assert.ok(want.status.size >= 5 && skillEvents >= 1, `${label}: the window is not trivial (${want.status.size} statuses, ${skillEvents} skill events)`);
  assert.deepEqual(got.filter((x) => x[0] === 'status').map(key).sort(), [...want.status.values()].map(key).sort(), `${label}: the last status change of every (unit, key)`);
  assert.deepEqual(got.filter((x) => x[0] === 'skill').map(key).sort(), [...want.skill.values()].map(key).sort(), `${label}: the last skill end of every unit`);
  assert.ok(got.every((x) => x[0] !== 'skill' || !x[2]), `${label}: no skill start replayed (its activation flash / voice)`);
  assert.deepEqual(got.filter((x) => x[0] === 'spawn').map(key), spawns ? [...want.spawned.values()].map((x) => key([x[0], x[1], 'late'])) : [], `${label}: survivors' spawns, in order${spawns ? '' : ' (none: the meta has the live units)'}`);
  assert.ok(got.every((x) => !STALE.has(x[0]) && x[0] !== 'fx'), `${label}: no atk / dmg / heal / die / leak / fx`);
  const nSpawn = got.filter((x) => x[0] === 'spawn').length;
  assert.ok(got.slice(0, nSpawn).every((x) => x[0] === 'spawn'), `${label}: spawns first`);
  assert.ok(got.length < win.length / 4, `${label}: a digest (${got.length} of ${win.length} events), not the log`);
  return want;
}

test('hidden tab: nothing is rendered, and the first frame back starts with ONE digest — the last status / skill per unit and the survivors\' spawns, no stale one-shots', async () => {
  const r = await rig();
  await r.start();
  r.advance(20000);                                   // 20 real s = 40 game s on screen
  const e = r.entry();
  const hideTick = e.battle.tickCount;
  const nSnaps = r.feed.snaps.length, nEvs = r.feed.evs.length, nLog = r.feed.log.length;
  r.doc.hidden = true;
  r.advance(20000, 250);                              // 20 real s hidden: the 250 ms pump keeps the battle on its clock
  const returnTick = e.battle.tickCount;
  assert.ok(returnTick - hideTick >= 1100, `pumped while hidden (${returnTick - hideTick} ticks)`);
  assert.equal(r.feed.snaps.length, nSnaps, 'no snapshot while hidden');
  assert.equal(r.feed.evs.length, nEvs, 'no event batch while hidden (the digest waits for the view)');
  assert.ok(e.unseen.size > 0);

  r.doc.hidden = false;
  r.advance(100);
  const first = r.feed.evs[nEvs], firstSnap = r.feed.snaps[nSnaps];
  assert.ok(first && firstSnap, 'the first frame back');
  assert.ok(Math.abs(first.gt - firstSnap.gt) < 0.001, 'stamped with the snapshot\'s game time');
  assert.deepEqual(r.feed.log.slice(nLog, nLog + 2).map((x) => x[0]), ['ev', 'snap'], 'the digest batch comes right before the first snapshot');
  const frameTicks = tickOf(first.gt) - returnTick;
  assert.ok(frameTicks >= 1 && frameTicks <= 8, `the first frame steps ${frameTicks} ticks`);
  const ref = referenceTicks(returnTick + frameTicks);
  const win = ref.slice(hideTick + 1, returnTick + 1).flat();
  const frameEvs = ref.slice(returnTick + 1).flat();
  assert.deepEqual(first.ev.slice(first.ev.length - frameEvs.length), frameEvs, 'the frame\'s own events follow the digest unchanged');
  const want = assertDigest(first.ev.slice(0, first.ev.length - frameEvs.length), win, { label: 'hidden' });
  assert.ok(want.spawned.size >= 2, 'units spawned in the dark come with their spawn');
  assert.ok([...want.status.values()].some((x) => !x[3]), 'some status ended in the dark (what used to leave a stuck aura)');
  assert.equal(e.unseen.size, 0, 'taken: later frames carry nothing of it');
  r.runner.dispose();
});

test('a tab that was never hidden keeps the digest empty: exactly the sim\'s events, in order', async () => {
  const r = await rig();
  await r.start();
  r.advance(10000);
  const e = r.entry();
  assert.equal(e.unseen.size, 0);
  const ref = referenceTicks(e.battle.tickCount).slice(1).flat();
  assert.deepEqual(r.feed.evs.flatMap((x) => x.ev), ref);
  r.runner.dispose();
});

test('a throttled hidden tab (the pump fires twice in 30 s): the catch-up frame hands over the digest, then its state events — still no stale one-shot', async () => {
  const r = await rig();
  await r.start();
  r.advance(2000);
  const e = r.entry();
  const hideTick = e.battle.tickCount;
  const nEvs = r.feed.evs.length, nSnaps = r.feed.snaps.length;
  r.doc.hidden = true;
  r.advance(30000, 15000);
  const returnTick = e.battle.tickCount;
  assert.ok(returnTick - hideTick > 400, `the pump took what it could (${returnTick - hideTick} ticks)`);
  const behind = Math.floor(((r.t - e.t0) / 1000) * e.speed * 30) - returnTick;
  assert.ok(behind > 32, `and the battle is far behind (${behind} ticks): the next frame is a catch-up frame`);
  r.doc.hidden = false;
  r.advance(20);
  const first = r.feed.evs[nEvs];
  assert.ok(first && r.feed.snaps.length > nSnaps);
  const ticks = tickOf(first.gt) - returnTick;
  assert.equal(ticks, 240, 'a full catch-up slice');
  const ref = referenceTicks(returnTick + ticks);
  const win = ref.slice(hideTick + 1, returnTick + 1).flat();
  const frameEvs = ref.slice(returnTick + 1).flat().filter((x) => STATE.has(x[0]));
  assert.deepEqual(first.ev.slice(first.ev.length - frameEvs.length), frameEvs, 'then the catch-up frame\'s state events (as before)');
  assertDigest(first.ev.slice(0, first.ev.length - frameEvs.length), win, { label: 'throttled' });
  r.runner.dispose();
});

test('影哨 placed / recalled while hidden: the later one reaches the view (a recall must end what the view still draws); other fx do not', async () => {
  const r = await rig();
  await r.start();
  r.advance(2000);
  const nEvs = r.feed.evs.length;
  r.doc.hidden = true;
  const sentry = (id) => r.h.b.fx('sentry', { x: 6, y: 10, id });
  const recall = (id) => r.h.b.fx('sentryRecall', { x: 6, y: 10, tx: 5, ty: 10, id });
  sentry(901); r.advance(1000, 250);
  recall(901); sentry(902); r.advance(1000, 250);
  r.h.b.fx('burst', { x: 3, y: 3, id: 901 });
  sentry(903); recall(903); sentry(903); r.advance(1000, 250);
  assert.equal(r.feed.evs.length, nEvs);
  r.doc.hidden = false;
  r.advance(100);
  const fx = r.feed.evs[nEvs].ev.filter((x) => x[0] === 'fx');
  assert.deepEqual(fx.map((x) => `${x[1]}:${x[4].id}`), ['sentryRecall:901', 'sentry:902', 'sentry:903'], 'the last of each caster, in order; no burst');
  r.runner.dispose();
});

test('a 影哨 inside a catch-up frame is kept among its state events (the other fx are not)', async () => {
  const r = await rig();
  await r.start();
  r.advance(1000);
  const nEvs = r.feed.evs.length;
  r.doc.hidden = true;
  r.advance(30000, 15000);
  r.doc.hidden = false;
  r.h.b.fx('sentry', { x: 6, y: 10, id: 905 });
  r.h.b.fx('burst', { x: 3, y: 3, id: 905 });
  r.advance(20);
  const fx = r.feed.evs[nEvs].ev.filter((x) => x[0] === 'fx');
  assert.deepEqual(fx.map((x) => x[1]), ['sentry'], 'the catch-up frame filters fx down to the 影哨');
  r.runner.dispose();
});

test('an authoritative battle off screen is stepped unseen; show() then hands over its statuses and skills — no spawns, the field meta builds the live units', async () => {
  const r = await rig();
  await r.start('b1');
  r.advance(6000);
  const e1 = r.entry('b1');
  // another field takes the screen (a display replica of a teammate's): b1 goes on, unseen, on its authoritative clock
  await r.start('b2', { authoritative: false, watch: true });
  assert.equal(r.runner.state().fieldId, 'f2');
  const switchTick = e1.battle.tickCount;
  const mark = r.feed.log.length;
  r.advance(20000);
  assert.ok(e1.battle.tickCount - switchTick >= 1100, 'b1 kept its clock');
  assert.ok(!r.feed.log.slice(mark).some((x) => x[1] === 'f1'), 'nothing of b1 is emitted while it is off screen');
  assert.ok(e1.unseen.size > 0);
  // back to b1: the field meta, then ONE batch of what happened, then its first snapshot
  const spec = { fieldId: 'f1', kind: 'normal', players: [{ playerId: 'p1' }], battleId: 'b1' };
  const back0 = r.feed.log.length;
  r.net.emit('b.start', { battleId: 'b1', fieldId: 'f1', kind: 'normal', spec, authoritative: true, speed: 2, elapsed: 0 });
  await r.settle();
  const showTick = tickOf(r.feed.snaps.find((x) => x.fieldId === 'f1' && r.feed.snaps.indexOf(x) >= 0 && x.gt > switchTick / 30 + 5).gt);
  assert.deepEqual(r.feed.log.slice(back0, back0 + 3), [['field', 'f1'], ['ev', 'f1'], ['snap', 'f1']], 'field meta, the hand-over, the first snapshot');
  const batch = r.feed.evs.find((x) => x.fieldId === 'f1' && x.gt > switchTick / 30 + 5);
  assert.ok(showTick >= switchTick + 1100 && batch);
  const ref = referenceTicks(showTick);
  assertDigest(batch.ev, ref.slice(switchTick + 1, showTick + 1).flat(), { spawns: false, label: 'show()' });
  assert.equal(r.runner.state().fieldId, 'f1');
  r.runner.dispose();
});

test('the silent catch-up before a field is shown (a display replica 40 game s in) hands over what happened in it, without spawns', async () => {
  const r = await rig();
  await r.start('b1', { authoritative: false, watch: true, elapsed: 40 });
  const e = r.entry('b1');
  assert.ok(e.battle.time >= 39.8, 'caught up before it was shown');
  assert.deepEqual(r.feed.log.slice(0, 3), [['field', 'f1'], ['ev', 'f1'], ['snap', 'f1']]);
  const showTick = tickOf(r.feed.snaps[0].gt);
  assertDigest(r.feed.evs[0].ev, referenceTicks(showTick).slice(1).flat(), { spawns: false, label: 'catch-up' });
  r.runner.dispose();
});

test('end to end (real runner → real FxSystem): after a hidden stretch no status-bound record or status icon outlives its status', async () => {
  const { installFakePixi, fakeViewCtx } = await import('../render/fakepixi.js');
  const { presetCamera } = await import('../../public/js/render/projection.js');
  const fake = installFakePixi();
  try {
    const FX = await import('../../public/js/render/fx.js');
    const r = await rig();
    const views = new Map();
    const P = fake.P, ctx = fakeViewCtx(P);
    const cam = presetCamera('normal', { width: 1600, height: 900 });
    const fx = new FX.FxSystem({
      P, layers: ctx.layers, cam: () => cam, heightAt: () => 0, settings: { quality: 'high', damageNumbers: true }, timeScale: () => 2, loadLevel: () => 0,
      subProfOf: () => null, view: (id) => views.get(id) || null, screenSize: () => ({ width: 1600, height: 900 }), fieldTop: () => 120, fieldRect: () => ({ r0: 9, r1: 12, c0: 2, c1: 10 }),
    });
    // render/app.js handleEvent for the state-bearing kinds (a status reaches the unit before fx.status)
    const handle = (e) => {
      if (e[0] === 'spawn') { if (!views.has(e[1].id)) views.set(e[1].id, { id: e[1].id, x: e[1].x, y: e[1].y, z: 0, hover: 0, _headTiles: 1.2, alive: true, destroyed: false, statuses: new Set(), info: e[1], dir: e[1].dir, onHit() {} }); }
      else if (e[0] === 'skill') { const v = views.get(e[1]); if (v) { if (e[2]) v.statuses.add('skill'); else v.statuses.delete('skill'); fx.skill(v, !!e[2]); } }
      else if (e[0] === 'status') { const v = views.get(e[1]); if (v) { if (e[3]) v.statuses.add(e[2]); else v.statuses.delete(e[2]); fx.status(v, e[2], !!e[3]); } }
      else if (e[0] === 'die') { const v = views.get(e[1]); if (v && v.alive) { v.alive = false; fx.death(v); } }
      else if (e[0] === 'fx') fx.simFx(e[1], Number(e[2]), Number(e[3]), e[4]);
    };
    r.runner.on('ev', (m) => { for (const e of m.ev) handle(e); });
    r.runner.on('snap', () => { for (let i = 0; i < 4; i++) fx.update(1 / 60); });

    await r.start();
    r.advance(10000);
    r.doc.hidden = true;
    r.advance(30000, 250);                             // 60 game s unseen
    r.doc.hidden = false;
    r.advance(2000);
    const e = r.entry();
    // the truth: the last status event of every (unit, key) of the whole battle so far
    const truth = new Map();
    for (const ev of referenceTicks(e.battle.tickCount).slice(1).flat()) if (ev[0] === 'status') truth.set(`${ev[1]}|${ev[2]}`, !!ev[3]);
    const alive = (id) => !!e.battle.unitById(id)?.alive;
    const staleIcons = [], stuckRecords = [];
    for (const [id, v] of views) {
      if (!alive(id)) continue;
      for (const k of v.statuses) if (k !== 'skill' && truth.get(`${id}|${k}`) !== true) staleIcons.push(`${id}:${k}`);
      for (const [k, on] of truth) if (on && k.startsWith(`${id}|`) && !v.statuses.has(k.slice(String(id).length + 1))) staleIcons.push(`missing ${k}`);
    }
    for (const [name, S] of fx.sustains) {
      if (S.end || S.until !== 'status' || !alive(S.anchor)) continue;
      if (![...S.bind].some((k) => truth.get(`${S.anchor}|${k}`) === true)) stuckRecords.push(`${name}[${[...S.bind]}]`);
    }
    assert.deepEqual(staleIcons, [], 'every live unit\'s status set equals the sim\'s');
    assert.deepEqual(stuckRecords, [], 'no status-bound record whose statuses are all off');
    assert.ok([...truth.values()].some((on) => !on), 'the battle did end statuses (not a vacuous check)');
    r.runner.dispose();
  } finally { fake.restore(); }
});
