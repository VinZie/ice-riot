// ICE RIOT - tutorial hint logic tests. Run: node test/tutorial.test.js  (exit 1 on failure)

import {
  createTutorialCore, createTutorial, analyze, openTeammateAhead, opponentInFront, nearOpponentCarrier,
  carrierNearBoards, aiTeammateNearerPuck, passIncoming, hintMarkup, glyphHTML, prettyKey, mouseButton, hintKind,
  HINTS, HINT_ORDER, HINT_IDS, TUNING, DEVICES, TUTORIAL_CSS,
} from '../public/tutorial.js';
import { PHASE, PSTATE, EVENT } from '../shared/constants.js';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e}`); }
}
function eq(a, b, msg = '') { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); }
function near(a, b, eps, msg = '') { if (Math.abs(a - b) > eps) throw new Error(`${msg} expected ~${b}, got ${a}`); }

// ---------------------------------------------------------------------------------------------
// fixtures

const ME = 7;                  // my clientId
const KEY = 'iceRiot.tutorial';
const DT = 1 / 30;

// Neutral situation: nothing hint-worthy. Me = player 0 (team 0, attacks +X) at (-10,0) facing +X,
// teammates behind me, opponents spread out in the other half, puck loose at center (10 m from me).
function base() {
  const P = (id, tm, x, z, extra = {}) => ({
    id, tm, g: id % 4 === 3 ? 1 : 0, x, y: 0, z, vx: 0, vz: 0, f: tm === 0 ? 0 : Math.PI,
    s: PSTATE.SKATE, sT: 0, tb: 1, fire: 0, ch: 0, c: 0, n: id + 1, ...extra,
  });
  return {
    tick: 1000, ph: PHASE.PLAY, phT: 0, per: 1, clk: 100, sc: [0, 0], teams: [0, 1],
    p: [P(0, 0, -10, 0, { c: ME }), P(1, 0, -14, 6), P(2, 0, -14, -6), P(3, 0, -26, 0),
      P(4, 1, 10, 5), P(5, 1, 10, -5), P(6, 1, 14, 0), P(7, 1, 26, 0)],
    k: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, o: -1 },
    gl: [],
  };
}
const st = (fn) => { const s = base(); if (fn) fn(s); return s; };
const put = (s, id, x, z, extra = {}) => Object.assign(s.p[id], { x, z }, extra);
const carry = (s, id) => { s.k.o = id; s.k.x = s.p[id].x + Math.cos(s.p[id].f); s.k.z = s.p[id].z + Math.sin(s.p[id].f); };
const ev = (type, o = {}) => ({ type, ...o });
const ctx = { myId: ME };

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m,
  };
}
// a core whose storage already has the given hints exhausted (default: the game-start move hint)
function mk(exhaust = ['move'], storage = memStorage(), extra = {}) {
  const n = {};
  for (const id of exhaust) n[id] = 99;
  if (exhaust.length) storage.setItem(KEY, JSON.stringify({ v: 1, n, done: {} }));
  const shown = [], hidden = [];
  const c = createTutorialCore({ storage, storageKey: KEY, onShow: (id) => shown.push(id), onHide: (id, r) => hidden.push([id, r]), ...extra });
  return { c, storage, shown, hidden };
}
// run `seconds` of frames with the same state; events only on the first frame. Returns the ids
// that were visible at some point, in order of first appearance, plus timing of first appearance.
function hold(c, state, seconds, events = [], cx = ctx) {
  const seen = [], firstAt = {};
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) {
    const id = c.update(typeof state === 'function' ? state(i * DT) : state, i === 0 ? events : [], cx, DT);
    if (id && !(id in firstAt)) { firstAt[id] = c.time; seen.push(id); }
  }
  return { seen, firstAt };
}

console.log('tutorial: pure analysis');

test('analyze finds me, carrier and overtime', () => {
  const v = analyze(st((s) => carry(s, 0)), ME);
  eq(v.myPid, 0); eq(v.myTm, 0); eq(v.iCarry, true); eq(v.oppCarry, false);
  const v2 = analyze(st((s) => { carry(s, 4); s.per = 4; }), ME);
  eq(v2.iCarry, false); eq(v2.oppCarry, true); eq(v2.carrier.id, 4); eq(v2.ot, true);
  eq(analyze(st((s) => { s.per = 4; }), ME, 5).ot, false, 'custom periods');
  eq(analyze(st(), 99).me, null, 'unknown client');
  eq(analyze(null, ME).valid, false);
  eq(analyze({ p: 'x' }, ME).valid, false);
  eq(analyze(st(), 0).me, null, 'myId 0 never matches AI skaters');
});

test('openTeammateAhead: open + ahead only', () => {
  const s = st((s) => { carry(s, 0); put(s, 1, 0, 4); });
  eq(openTeammateAhead(analyze(s, ME))?.id, 1);
  eq(openTeammateAhead(analyze(st((s) => carry(s, 0)), ME)), null, 'teammates behind');
  eq(openTeammateAhead(analyze(st((s) => { carry(s, 0); put(s, 1, 0, 4); put(s, 4, 1, 4.5); }), ME)), null, 'covered');
  eq(openTeammateAhead(analyze(st((s) => { carry(s, 0); put(s, 1, 0, 4); put(s, 5, -5, 2); }), ME)), null, 'lane blocked');
  eq(openTeammateAhead(analyze(st((s) => { carry(s, 0); put(s, 1, 0, 4); put(s, 5, -5, 2, { s: PSTATE.DOWN }); }), ME))?.id, 1, 'downed defender ignored');
  eq(openTeammateAhead(analyze(st((s) => { put(s, 1, 0, 4); }), ME)), null, 'not carrying');
  // team 1 attacks -X
  const s1 = st((s) => { s.p[0].c = 0; s.p[4].c = ME; put(s, 4, 10, 0); carry(s, 4); put(s, 5, 0, 3); put(s, 0, -20, -8); put(s, 1, -20, 8); put(s, 2, -22, 0); });
  eq(openTeammateAhead(analyze(s1, ME))?.id, 5, 'team 1 direction');
});

test('opponentInFront: 3 m cone in front of my facing', () => {
  const v = (fn) => analyze(st((s) => { carry(s, 0); fn(s); }), ME);
  eq(opponentInFront(v((s) => put(s, 4, -7.5, 0.5)))?.id, 4);
  eq(opponentInFront(v((s) => put(s, 4, -12, 0))), null, 'behind');
  eq(opponentInFront(v((s) => put(s, 4, -6.5, 0))), null, '3.5 m away');
  eq(opponentInFront(v((s) => put(s, 4, -9, 2.5))), null, 'off to the side');
  eq(opponentInFront(v((s) => put(s, 4, -7.5, 0, { s: PSTATE.DOWN }))), null, 'knocked down');
  eq(opponentInFront(v((s) => { s.p[0].f = Math.PI; put(s, 4, -12, 0); }))?.id, 4, 'facing -X');
  eq(opponentInFront(analyze(st((s) => put(s, 4, -7.5, 0)), ME)), null, 'not carrying');
  eq(opponentInFront(v((s) => put(s, 1, -8, 0))), null, 'teammates are not defenders');
});

test('nearOpponentCarrier / carrierNearBoards', () => {
  eq(nearOpponentCarrier(analyze(st((s) => { put(s, 4, -6, 0); carry(s, 4); }), ME)), true);
  eq(nearOpponentCarrier(analyze(st((s) => { put(s, 4, -2, 0); carry(s, 4); }), ME)), false, '8 m');
  eq(nearOpponentCarrier(analyze(st((s) => { put(s, 1, -6, 0); carry(s, 1); }), ME)), false, 'teammate carries');
  eq(nearOpponentCarrier(analyze(st((s) => { put(s, 4, -6, 0); carry(s, 4); s.p[0].s = PSTATE.DOWN; }), ME)), false, 'me down');
  eq(carrierNearBoards(analyze(st((s) => { put(s, 4, -8, -11.8); carry(s, 4); put(s, 0, -10, -7); }), ME)), true);
  eq(carrierNearBoards(analyze(st((s) => { put(s, 4, -8, -6); carry(s, 4); put(s, 0, -10, -2); }), ME)), false, 'mid-ice');
  eq(carrierNearBoards(analyze(st((s) => { put(s, 4, 8, -11.8); carry(s, 4); }), ME)), false, 'too far from me');
  eq(carrierNearBoards(analyze(st((s) => { put(s, 4, 28.5, 0); carry(s, 4); put(s, 0, 22, 0); }), ME)), true, 'end boards');
});

test('aiTeammateNearerPuck: far from puck, AI mate close', () => {
  const far = (fn) => st((s) => { s.k.x = -24; s.k.z = 8; put(s, 0, 10, 0); put(s, 1, -20, 6); put(s, 2, 5, -8); if (fn) fn(s); });
  eq(aiTeammateNearerPuck(analyze(far(), ME))?.id, 1);
  eq(aiTeammateNearerPuck(analyze(far((s) => { s.p[1].c = 99; }), ME)), null, 'teammate is human');
  eq(aiTeammateNearerPuck(analyze(far((s) => put(s, 0, -16, 4)), ME)), null, 'I am close enough');
  eq(aiTeammateNearerPuck(analyze(far((s) => put(s, 1, 0, 6)), ME)), null, 'mate not much nearer');
  eq(aiTeammateNearerPuck(analyze(far((s) => { put(s, 0, -23, 8); carry(s, 0); }), ME)), null, 'I carry');
  eq(aiTeammateNearerPuck(analyze(far((s) => { put(s, 4, -22, 7); carry(s, 4); }), ME))?.id, 1, 'opponent carries');
  eq(aiTeammateNearerPuck(analyze(far((s) => { put(s, 1, -23, 8); carry(s, 1); }), ME)), null, 'my AI teammate carries: I am a pass option');
});

test('passIncoming: recent PASS to me with the puck loose', () => {
  const pass = { at: 0, by: 1, to: 0 };
  const loose = analyze(st(), ME);
  eq(passIncoming(pass, loose, 1), true);
  eq(passIncoming(pass, loose, TUNING.oneTimerWindow + 0.1), false, 'expired');
  eq(passIncoming(pass, analyze(st((s) => carry(s, 0)), ME), 0.5), false, 'received');
  eq(passIncoming(pass, analyze(st((s) => carry(s, 4)), ME), 0.5), false, 'intercepted');
  eq(passIncoming(pass, analyze(st((s) => carry(s, 1)), ME), 0.1), true, 'passer still shown (interp lag)');
  eq(passIncoming(pass, analyze(st((s) => carry(s, 1)), ME), 0.6), false, 'passer kept it');
  eq(passIncoming({ ...pass, to: 2 }, loose, 0.5), false, 'to someone else');
  eq(passIncoming(null, loose, 0.5), false);
});

console.log('tutorial: triggers (each fires in its scenario and not otherwise)');

test('neutral play: no hint for 30 s', () => {
  const { c } = mk();
  eq(hold(c, st(), 30).seen.length, 0);
});

test('move: at game start (faceoff) only', () => {
  const { c } = mk([]);
  eq(c.update(st((s) => { s.ph = PHASE.FACEOFF; }), [], ctx, DT), 'move', 'first frame');
  const spectator = mk([]).c;
  eq(hold(spectator, st((s) => { s.p[0].c = 0; }), 20).seen.length, 0, 'spectating');
  const goal = mk([]).c;
  eq(hold(goal, st((s) => { s.ph = PHASE.GOAL; }), 5).seen.length, 0, 'GOAL phase');
  const late = mk([]).c;
  hold(late, st((s) => { s.p[0].c = 0; }), 20);           // watched for 20 s, then dropped in
  eq(late.update(st(), [], ctx, DT), 'move', 'drop-in counts as my game start');
  const once = mk([]).c;
  const r = hold(once, st(), 40);
  eq(r.seen.join(), 'move', 'once per game');
});

test('shoot: when I first get the puck', () => {
  const { c } = mk();
  eq(hold(c, st(), 3).seen.length, 0);
  eq(c.update(st((s) => carry(s, 0)), [], ctx, DT), 'shoot');
  const c2 = mk().c;
  eq(hold(c2, st((s) => { put(s, 4, -6, 6); carry(s, 4); }), 10).seen.includes('shoot'), false, 'someone else carries');
  const c3 = mk().c;
  eq(hold(c3, st((s) => { carry(s, 0); s.ph = PHASE.FACEOFF; }), 5).seen.length, 0, 'not during faceoff');
});

test('pass: carrying with an open teammate ahead', () => {
  const { c } = mk(['move', 'shoot']);
  eq(hold(c, st((s) => { carry(s, 0); put(s, 1, 0, 4); }), 1).seen.join(), 'pass');
  const c2 = mk(['move', 'shoot']).c;
  eq(hold(c2, st((s) => { carry(s, 0); put(s, 1, 0, 4); put(s, 4, 1, 4.5); }), 10).seen.length, 0, 'covered');
  const c3 = mk(['move', 'shoot']).c;
  eq(hold(c3, st((s) => { carry(s, 0); }), 10).seen.length, 0, 'nobody ahead');
});

test('deke: opponent within 3 m in front while I carry', () => {
  const { c } = mk(['move', 'shoot']);
  eq(hold(c, st((s) => { carry(s, 0); put(s, 4, -7.5, 0.5); }), 1).seen.join(), 'deke');
  const c2 = mk(['move', 'shoot']).c;
  eq(hold(c2, st((s) => { carry(s, 0); put(s, 4, -12, 0.5); }), 10).seen.length, 0, 'behind me');
  const c3 = mk(['move', 'shoot']).c;
  eq(hold(c3, st((s) => { put(s, 4, -7.5, 0.5); }), 10).seen.length, 0, 'not carrying');
});

test('onetimer: shows the same frame a PASS to me arrives', () => {
  const { c } = mk();
  const s = st((s) => { put(s, 1, -4, 3); });
  eq(c.update(s, [ev(EVENT.PASS, { by: 1, to: 0 })], ctx, DT), 'onetimer');
  const c2 = mk().c;
  eq(hold(c2, s, 4, [ev(EVENT.PASS, { by: 1, to: 2 })]).seen.length, 0, 'pass to someone else');
  const c3 = mk().c;
  eq(hold(c3, st((s) => carry(s, 0)), 1, [ev(EVENT.PASS, { by: 1, to: 0 })]).seen.includes('onetimer'), false, 'already received');
  const c4 = mk().c;
  eq(hold(c4, st((s) => carry(s, 1)), 1, [ev(EVENT.PASS, { by: 1, to: 0 })]).seen.join(), 'onetimer', 'passer still shown with puck (lag)');
  const c5 = mk().c;
  hold(c5, s, 3, [ev(EVENT.PASS, { by: 1, to: 0 })]);
  eq(c5.visible, null, 'gone once the pass window is over');
});

test('check: defending near an opponent carrier', () => {
  const { c } = mk();
  eq(hold(c, st((s) => { put(s, 4, -6, 0); carry(s, 4); }), 1).seen.join(), 'check');
  const c2 = mk().c;
  eq(hold(c2, st((s) => { put(s, 4, 5, 0); carry(s, 4); }), 10).seen.length, 0, 'carrier far away');
  const c3 = mk().c;
  eq(hold(c3, st((s) => { put(s, 1, -6, 0); carry(s, 1); }), 10).seen.length, 0, 'teammate carries');
});

test('glass: opponent carrier near the boards', () => {
  const { c } = mk(['move', 'check']);
  eq(hold(c, st((s) => { put(s, 4, -8, -11.8); carry(s, 4); put(s, 0, -10, -7); }), 1).seen.join(), 'glass');
  const c2 = mk(['move', 'check']).c;
  eq(hold(c2, st((s) => { put(s, 4, -8, -4); carry(s, 4); put(s, 0, -10, 0); }), 10).seen.length, 0, 'mid-ice');
  // with check still available, the basic check hint comes first, the glass hint next time round
  const c3 = mk().c;
  const r = hold(c3, st((s) => { put(s, 4, -8, -11.8); carry(s, 4); put(s, 0, -10, -7); }), 12);
  eq(r.seen.join(), 'check,glass', 'check then glass');
  ok(r.firstAt.glass - r.firstAt.check >= TUNING.duration + TUNING.gap - 0.05, 'spaced');
});

test('switch: AI teammate much nearer the puck while I am far', () => {
  const far = (fn) => st((s) => { s.k.x = -24; s.k.z = 8; put(s, 0, 10, 0); put(s, 1, -20, 6); put(s, 2, 5, -8); if (fn) fn(s); });
  const { c } = mk();
  eq(hold(c, far(), 1).seen.join(), 'switch');
  const c2 = mk().c;
  eq(hold(c2, far((s) => { s.p[1].c = 99; }), 10).seen.length, 0, 'teammate is human');
  const c3 = mk().c;
  eq(hold(c3, far((s) => put(s, 0, -16, 4)), 10).seen.length, 0, 'I am near the puck');
});

test('fire: when I catch fire (event or state edge)', () => {
  const { c } = mk();
  hold(c, st(), 1);
  eq(c.update(st((s) => { s.p[0].fire = 1; }), [ev(EVENT.FIRE, { player: 0, on: true })], ctx, DT), 'fire');
  const c2 = mk().c;
  hold(c2, st(), 1);
  eq(hold(c2, st((s) => { s.p[0].fire = 1; }), 1).seen.join(), 'fire', 'state edge without event');
  const c3 = mk().c;
  eq(hold(c3, st((s) => { s.p[4].fire = 1; }), 3, [ev(EVENT.FIRE, { player: 4, on: true })]).seen.length, 0, 'opponent on fire');
  const c4 = mk().c;
  eq(hold(c4, st((s) => { s.p[0].fire = 1; }), 10).seen.length, 0, 'already on fire when I joined (no edge)');
});

test('overtime: first sudden-death faceoff only', () => {
  const { c } = mk();
  eq(c.update(st((s) => { s.per = 4; s.ph = PHASE.FACEOFF; }), [ev(EVENT.PERIOD, { period: 4 })], ctx, DT), 'overtime');
  const c2 = mk().c;
  eq(hold(c2, st((s) => { s.per = 3; s.ph = PHASE.FACEOFF; }), 5).seen.length, 0, 'regulation period');
  const c3 = mk().c;
  eq(hold(c3, st((s) => { s.per = 4; s.ph = PHASE.FACEOFF; }), 5, [], { myId: ME, periods: 5 }).seen.length, 0, 'ctx.periods respected');
  const c4 = mk().c;
  eq(hold(c4, st((s) => { s.per = 4; }), 60).seen.join(), 'overtime', 'once per game');
});

console.log('tutorial: limits, spacing, hiding');

test('show-count limits persist across instances and games', () => {
  const storage = memStorage();
  const seenPerGame = [];
  for (let g = 0; g < 5; g++) {
    const { c } = mk([], storage);
    if (g === 0) storage.removeItem(KEY);
    // whole game: faceoff, then I carry the puck for a while
    const r = hold(c, (t) => st((s) => { s.ph = t < 1 ? PHASE.FACEOFF : PHASE.PLAY; if (t > 12) carry(s, 0); }), 20);
    seenPerGame.push(r.seen.filter((x) => x === 'shoot' || x === 'move').join('+'));
  }
  eq(seenPerGame.join(' | '), 'move+shoot | move+shoot | shoot |  | ', 'move max 2, shoot max 3');
  const saved = JSON.parse(storage.getItem(KEY));
  eq(saved.n.shoot, 3); eq(saved.n.move, 2);
});

test('new game inside one instance (GAME_OVER -> faceoff, tick reset) re-arms per-game hints', () => {
  const { c } = mk(['move']);
  eq(hold(c, st((s) => carry(s, 0)), 6).seen.join(), 'shoot');
  eq(hold(c, st((s) => carry(s, 0)), 30).seen.includes('shoot'), false, 'not twice in one game');
  hold(c, st((s) => { s.ph = PHASE.GAME_OVER; }), 2);
  eq(hold(c, st((s) => carry(s, 0)), 6).seen.join(), 'shoot', 'after GAME_OVER');
  hold(c, st(), TUNING.cooldown);                                     // let the per-hint cooldown pass
  eq(hold(c, st((s) => { s.tick = 5; carry(s, 0); }), 6).seen.join(), 'shoot', 'after tick reset');
  eq(c.count('shoot'), 3);
  hold(c, st((s) => { s.ph = PHASE.GAME_OVER; }), 2);
  eq(hold(c, st((s) => carry(s, 0)), 10).seen.length, 0, 'limit reached');
});

test('one at a time + >= 6 s of quiet between hints', () => {
  const { c } = mk(['move']);
  // I carry; 1 s later a defender closes in front of me (deke wanted while shoot is up)
  const r = hold(c, (t) => st((s) => { carry(s, 0); if (t > 1) put(s, 4, -7.5, 0.5); }), 12);
  eq(r.seen.join(), 'shoot,deke');
  near(r.firstAt.shoot, DT, 1e-9);
  ok(r.firstAt.deke >= r.firstAt.shoot + TUNING.duration + TUNING.gap - 1e-6, `deke too early: ${r.firstAt.deke}`);
  ok(r.firstAt.deke <= r.firstAt.shoot + TUNING.duration + TUNING.gap + 2 * DT, `deke too late: ${r.firstAt.deke}`);
});

test('quiet gap counts from when a hint hides early', () => {
  const { c } = mk(['move']);
  c.update(st((s) => carry(s, 0)), [], ctx, DT);
  eq(c.visible, 'shoot');
  c.update(st((s) => { put(s, 4, -7.5, 0.5); carry(s, 0); }), [ev(EVENT.SHOT, { by: 0, kind: 'wrist' })], ctx, DT);
  eq(c.visible, null, 'hidden by the shot');
  const hiddenAt = c.time;
  const r = hold(c, st((s) => { carry(s, 0); put(s, 4, -7.5, 0.5); }), 8);
  ok(Math.abs(r.firstAt.deke - (hiddenAt + TUNING.gap)) <= 2 * DT, `deke at ${r.firstAt.deke}, hidden at ${hiddenAt}`);
});

test('onetimer ignores the quiet gap and replaces the visible hint', () => {
  const { c, hidden } = mk([]);
  c.update(st((s) => { s.ph = PHASE.FACEOFF; }), [], ctx, DT);
  eq(c.visible, 'move');
  hold(c, st(), 1);
  // a teammate passes to me while the move hint is still up
  eq(c.update(st((s) => put(s, 1, -4, 3)), [ev(EVENT.PASS, { by: 1, to: 0 })], ctx, DT), 'onetimer');
  eq(hidden[0].join(), 'move,preempt');
  // and right after a hint was hidden (inside the gap; past the one-timer's own 4 s cooldown)
  hold(c, st(), 4.2);
  eq(c.visible, null);
  ok(c.time - 1 - TUNING.oneTimerWindow < TUNING.gap, 'still inside the quiet gap');
  eq(c.update(st((s) => put(s, 1, -4, 3)), [ev(EVENT.PASS, { by: 1, to: 0 })], ctx, DT), 'onetimer', 'within the gap');
});

test('auto-hide after 4 s', () => {
  const { c, hidden } = mk(['move']);
  const r = hold(c, st((s) => carry(s, 0)), 6);
  eq(r.seen.join(), 'shoot');
  eq(c.visible, null);
  eq(hidden[0].join(), 'shoot,timeout');
});

test('auto-hide when the hinted action is performed (and that retires the hint)', () => {
  const cases = [
    ['shoot', ['move'], st((s) => carry(s, 0)), [ev(EVENT.SHOT, { by: 0, kind: 'wrist' })]],
    ['pass', ['move', 'shoot'], st((s) => { carry(s, 0); put(s, 1, 0, 4); }), [ev(EVENT.PASS, { by: 0, to: 1 })]],
    ['deke', ['move', 'shoot'], st((s) => { carry(s, 0); put(s, 4, -7.5, 0.5); }), [ev(EVENT.DEKE, { by: 0 })]],
    ['check', ['move'], st((s) => { put(s, 4, -6, 0); carry(s, 4); }), [ev(EVENT.HIT, { by: 0, target: 4, power: 0.5, big: false })]],
    ['glass', ['move', 'check'], st((s) => { put(s, 4, -8, -11.8); carry(s, 4); put(s, 0, -10, -7); }), [ev(EVENT.GLASS, { panel: 3, by: 0, target: 4 })]],
    ['switch', ['move'], st((s) => { s.k.x = -24; s.k.z = 8; put(s, 0, 10, 0); put(s, 1, -20, 6); put(s, 2, 5, -8); }), [ev(EVENT.SWITCH, { client: ME, from: 0, to: 1 })]],
    ['onetimer', ['move'], st((s) => put(s, 1, -4, 3)), [ev(EVENT.SHOT, { by: 0, kind: 'onetimer' })]],
  ];
  for (const [id, ex, state, action] of cases) {
    const { c, hidden } = mk(ex);
    if (id === 'onetimer') c.update(state, [ev(EVENT.PASS, { by: 1, to: 0 })], ctx, DT);
    else c.update(state, [], ctx, DT);
    eq(c.visible, id, `${id} shown`);
    c.update(state, [ev(EVENT.SHOT, { by: 5, kind: 'wrist' })], ctx, DT);   // someone else's action
    eq(c.visible, id, `${id} survives other players' actions`);
    c.update(state, action, ctx, DT);
    eq(c.visible, null, `${id} hidden by its action`);
    eq(hidden[hidden.length - 1].join(), `${id},done`);
    eq(c.learned(id), true, `${id} retired`);
  }
});

test('auto-hide from my own state: turbo use (move), check / poke lunge (check), deke spin', () => {
  const m1 = mk([]).c;
  m1.update(st((s) => { s.ph = PHASE.FACEOFF; }), [], ctx, DT);
  eq(m1.visible, 'move');
  m1.update(st(), [], ctx, DT);
  m1.update(st((s) => { s.p[0].tb = 0.95; }), [], ctx, DT);
  eq(m1.visible, null, 'turbo drained -> move hidden');
  const m2 = mk().c;
  m2.update(st((s) => { put(s, 4, -6, 0); carry(s, 4); }), [], ctx, DT);
  m2.update(st((s) => { put(s, 4, -6, 0); carry(s, 4); s.p[0].s = PSTATE.POKE; }), [], ctx, DT);
  eq(m2.visible, null, 'poke -> check hidden');
  const m3 = mk(['move', 'shoot']).c;
  m3.update(st((s) => { carry(s, 0); put(s, 4, -7.5, 0.5); }), [], ctx, DT);
  m3.update(st((s) => { carry(s, 0); put(s, 4, -7.5, 0.5); s.p[0].s = PSTATE.DEKE; }), [], ctx, DT);
  eq(m3.visible, null, 'deke state -> deke hidden');
});

test('hint hides when its situation is over (lost the puck, phase change)', () => {
  const { c, hidden } = mk(['move']);
  c.update(st((s) => carry(s, 0)), [], ctx, DT);
  eq(c.visible, 'shoot');
  c.update(st((s) => carry(s, 4)), [], ctx, DT);
  eq(c.visible, null);
  eq(hidden[0].join(), 'shoot,stale');
  eq(c.learned('shoot'), false, 'losing the puck does not retire the hint');
  const c2 = mk().c;
  c2.update(st((s) => { put(s, 4, -6, 0); carry(s, 4); }), [], ctx, DT);
  eq(c2.visible, 'check');
  c2.update(st((s) => { s.ph = PHASE.GOAL; }), [ev(EVENT.GOAL, { team: 1 })], ctx, DT);
  eq(c2.visible, null, 'goal scored');
  const c3 = mk().c;
  c3.update(st((s) => { put(s, 4, -6, 0); carry(s, 4); }), [], ctx, DT);
  c3.update(null, [], ctx, DT);
  eq(c3.visible, null, 'back to the lobby (null state)');
});

test('control switch: "me" follows ctx.myId to the new skater', () => {
  const { c } = mk(['move']);
  // switched onto player 1 who carries the puck
  eq(c.update(st((s) => { s.p[0].c = 0; s.p[1].c = ME; carry(s, 1); }), [ev(EVENT.SWITCH, { client: ME, from: 0, to: 1 })], ctx, DT), 'shoot');
});

console.log('tutorial: enable / storage / API');

test('disabled = nothing (and nothing persisted)', () => {
  const storage = memStorage();
  const { c } = mk([], storage);
  storage.removeItem(KEY);
  c.setEnabled(false);
  let any = false;
  for (let i = 0; i < 600; i++) {
    const s = st((s) => { s.ph = i < 30 ? PHASE.FACEOFF : PHASE.PLAY; if (i > 60) carry(s, 0); });
    if (c.update(s, i === 100 ? [ev(EVENT.PASS, { by: 1, to: 0 })] : [], ctx, DT) !== null) any = true;
  }
  eq(any, false);
  eq(c.visible, null);
  eq(storage.getItem(KEY), null, 'storage untouched');
  c.setEnabled(true);
  eq(hold(c, st((s) => carry(s, 0)), 1).seen.join(), 'move', 're-enabled: my game starts now');
});

test('disabling hides the visible hint', () => {
  const { c, hidden } = mk(['move']);
  c.update(st((s) => carry(s, 0)), [], ctx, DT);
  eq(c.visible, 'shoot');
  c.setEnabled(false);
  eq(c.visible, null);
  eq(hidden[0].join(), 'shoot,disabled');
});

test('throwing storage is tolerated (limits still apply in memory)', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
  const c = createTutorialCore({ storage: bad, storageKey: KEY });
  let shows = 0;
  const s = st((s) => put(s, 1, -4, 3));
  for (let k = 0; k < 5; k++) {
    if (c.update(s, [ev(EVENT.PASS, { by: 1, to: 0 })], ctx, DT) === 'onetimer') shows++;
    hold(c, s, 8);
  }
  eq(shows, HINTS.onetimer.max);
  c.reset();
  eq(c.update(s, [ev(EVENT.PASS, { by: 1, to: 0 })], ctx, DT), 'onetimer', 'reset works without storage');
  // null storage, corrupt JSON, wrong types
  for (const storage of [null, undefined, {}, { getItem: () => 'not json{' }, { getItem: () => '{"n":{"shoot":"x"},"done":5}' }, { getItem: () => 'null' }]) {
    const cc = createTutorialCore({ storage, storageKey: KEY });
    eq(cc.update(st((s) => carry(s, 0)), [], ctx, DT), 'move', 'fresh start');
  }
  // createTutorial's default storage (globalThis.localStorage) throwing on access
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    const t = createTutorial();
    eq(t.update(st((s) => { s.ph = PHASE.FACEOFF; }), [], ctx, DT), 'move');
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev); else delete globalThis.localStorage;
  }
});

test('reset() clears the persisted counts', () => {
  const storage = memStorage();
  const { c } = mk(['move', 'shoot'], storage);
  eq(hold(c, st((s) => carry(s, 0)), 5).seen.length, 0);
  c.reset();
  eq(storage.getItem(KEY), null);
  hold(c, st((s) => { s.ph = PHASE.FACEOFF; }), 5);                     // move shows again (and times out)
  eq(hold(c, st((s) => carry(s, 0)), 8).seen.join(), 'shoot');
});

test('bad inputs do not throw', () => {
  const { c } = mk([]);
  for (const s of [null, undefined, 0, 'x', {}, { p: [] }, { p: [null, 5, {}] }, { p: base().p, k: null }]) c.update(s, null, ctx, DT);
  c.update(st(), [null, 5, 'x', {}, { type: EVENT.PASS }], null, NaN);
  c.update(st(), undefined, undefined, -5);
  c.update(st(), [], { myId: ME }, 1e9);
  ok(c.time <= 2 * TUNING.maxDt + 1);
});

test('createTutorial without a container: logic only, API shape', () => {
  const t = createTutorial({ container: null, storage: memStorage(), device: 'gamepad' });
  eq(Object.keys(t).sort().join(), 'dispose,reset,setDevice,setEnabled,update');
  eq(t.update(st((s) => { s.ph = PHASE.FACEOFF; }), [], ctx, DT), 'move');
  t.setDevice('touch'); t.setDevice('nonsense');
  t.setEnabled(false);
  eq(t.update(st(), [], ctx, DT), null);
  t.setEnabled(true);
  t.reset();
  t.dispose();
  eq(t.update(st((s) => { s.ph = PHASE.FACEOFF; }), [], ctx, DT), null, 'disposed');
  t.dispose();
});

test('hint definitions are consistent', () => {
  eq([...HINT_ORDER].sort().join(), Object.keys(HINTS).sort().join());
  eq([...HINT_IDS].sort().join(), Object.keys(HINTS).sort().join());
  eq(HINT_ORDER[0], 'onetimer');
  for (const id of HINT_ORDER) ok(HINTS[id].max >= 2 && HINTS[id].max <= 3, `${id} max`);
});

console.log('tutorial: markup');

// classic all-keyboard bindings (what a player who rebinds away from the mouse gets)
const KEYS_ONLY = (btn) => ({ shoot: 'KeyJ', pass: 'KeyK', action: 'KeyL', turbo: 'ShiftLeft' })[btn] ?? null;
// visible text of a card: tags stripped, entities decoded
const textOf = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

test('glyphs per device', () => {
  // default bindings: shoot = left click, pass = right click, deke = L, turbo = L-Shift
  const k = hintMarkup('shoot', 'keyboard');
  ok(k.includes('ir-tut-mouse ir-tut-mouse-l') && k.includes('<b>Left click</b>'), 'default shoot = left click');
  ok(hintMarkup('pass', 'keyboard').includes('ir-tut-mouse-r') && hintMarkup('pass', 'keyboard').includes('<b>Right click</b>'), 'default pass = right click');
  ok(hintMarkup('switch', 'keyboard').includes('<b>Right click</b>'), 'switch = pass button');
  ok(hintMarkup('deke', 'keyboard').includes('<b>L</b>'), 'deke L keycap');
  ok(hintMarkup('move', 'keyboard').includes('ir-tut-wasd'), 'WASD row');
  ok(hintMarkup('move', 'keyboard').includes('<b>L-Shift</b>'), 'L-Shift');
  ok(hintMarkup('shoot', 'keyboard', KEYS_ONLY).includes('<b>J</b>') && !hintMarkup('shoot', 'keyboard', KEYS_ONLY).includes('ir-tut-mouse'), 'keyboard J');
  ok(hintMarkup('pass', 'keyboard', KEYS_ONLY).includes('<b>K</b>'), 'keyboard K');
  const g = hintMarkup('check', 'gamepad');
  ok(g.includes('ir-tut-pad-a') && g.includes('ir-tut-bumper') && g.includes('ir-tut-pad-b'), 'gamepad A, RB, B');
  ok(g.includes('>RB<') && g.includes('>A<') && g.includes('>B<'), 'gamepad letters');
  ok(hintMarkup('switch', 'gamepad').includes('ir-tut-pad-x'), 'gamepad X');
  ok(hintMarkup('move', 'gamepad').includes('ir-tut-stick'), 'left stick');
  ok(hintMarkup('shoot', 'touch').includes('<b>Shoot</b>') && hintMarkup('shoot', 'touch').includes('ir-tut-tbtn-shoot'), 'touch Shoot');
  ok(hintMarkup('check', 'touch').includes('<b>Check</b>') && hintMarkup('check', 'touch').includes('<b>Poke</b>'), 'touch Check/Poke (context labels)');
  ok(hintMarkup('check', 'touch').includes('ir-tut-tbtn-turbo'), 'touch Turbo');
  ok(hintMarkup('switch', 'touch').includes('<b>Switch</b>'), 'touch Switch');
  ok(hintMarkup('move', 'touch').includes('ir-tut-joy') && textOf(hintMarkup('move', 'touch')).includes('Drag to skate'), 'touch stick');
  for (const d of DEVICES) {
    const u = hintMarkup('onetimer', d);
    ok(u.includes('ir-tut-big') && u.includes('ir-tut-urgent'), `big one-timer prompt (${d})`);
  }
  for (const id of HINT_IDS) for (const d of DEVICES) ok(hintMarkup(id, d).includes('ir-tut-title'), `${id}/${d}`);
  eq(hintMarkup('nope', 'keyboard'), '');
  eq(hintMarkup('shoot', 'banana'), hintMarkup('shoot', 'keyboard'), 'unknown device -> keyboard');
});

test('mouse glyph: which button is filled', () => {
  const svgFill = (html) => /<g fill="currentColor">(.*?)<\/g>/.exec(html)[1];
  const L = glyphHTML('shoot', 'keyboard', () => 'Mouse0');
  const M = glyphHTML('shoot', 'keyboard', () => 'Mouse1');
  const R = glyphHTML('shoot', 'keyboard', () => 'Mouse2');
  ok(L.includes('ir-tut-mouse-l') && L.includes('<b>Left click</b>') && L.includes('<svg'), L);
  ok(M.includes('ir-tut-mouse-m') && M.includes('<b>Middle click</b>'), M);
  ok(R.includes('ir-tut-mouse-r') && R.includes('<b>Right click</b>'), R);
  ok(svgFill(L) !== svgFill(R) && svgFill(L) !== svgFill(M), 'a different button is filled');
  // the Coqui canvas glyph: left button arcs counter-clockwise (sweep 0), right clockwise (sweep 1)
  ok(svgFill(L).includes('M6 0.75A5.25 5.25 0 0 0 0.75 6'), 'left half filled'); ok(svgFill(R).includes('M6 0.75A5.25 5.25 0 0 1 11.25 6'), 'right half filled');
  eq(glyphHTML('pass', 'keyboard', () => 'Right click'), R, 'a display label works too');
  ok(L.includes('aria-hidden="true"'), 'svg hidden from screen readers (the text says it)');
  eq(mouseButton('Mouse0'), 0); eq(mouseButton('Mouse2'), 2); eq(mouseButton('left click'), 0); eq(mouseButton('KeyJ'), -1); eq(mouseButton(null), -1);
  // combos mix a keycap and a mouse tile
  const c = hintMarkup('glass', 'keyboard');
  ok(c.includes('<b>L-Shift</b>') && c.includes('<b>Left click</b>') && c.includes('ir-tut-plus'), 'L-Shift + Left click');
});

test('keyLabel rebinding (keyboard only), escaped, throw-safe', () => {
  const kl = (btn) => ({ shoot: 'KeyF', pass: 'Space', turbo: 'ControlLeft', move: 'ARROWS' })[btn] ?? null;
  const m = hintMarkup('check', 'keyboard', kl);
  ok(m.includes('<b>F</b>') && m.includes('<b>L-Ctrl</b>'), m);
  ok(hintMarkup('pass', 'keyboard', kl).includes('<b>Space</b>'));
  ok(hintMarkup('deke', 'keyboard', kl).includes('<b>L</b>'), 'null -> default');
  ok(hintMarkup('move', 'keyboard', kl).includes('<b>Arrows</b>'), 'all-caps label -> sentence case');
  ok(!hintMarkup('shoot', 'gamepad', kl).includes('<b>F</b>'), 'ignored for gamepad');
  ok(!hintMarkup('shoot', 'touch', kl).includes('<b>F</b>'), 'ignored for touch');
  ok(hintMarkup('shoot', 'keyboard', () => '<img onerror=x>').includes('&lt;img'), 'escaped');
  ok(!hintMarkup('shoot', 'keyboard', () => '<img onerror=x>').includes('<img'), 'no raw tag');
  ok(hintMarkup('shoot', 'keyboard', () => { throw new Error('x'); }).includes('<b>Left click</b>'), 'throw -> default');
  ok(hintMarkup('shoot', 'keyboard', () => '').includes('<b>Left click</b>'), "'' -> default");
  let args = null;
  glyphHTML('poke', 'keyboard', (...a) => { args = a; return null; });
  eq(args.join(), 'action,poke', 'keyLabel(button, action)');
  eq(prettyKey('KeyJ'), 'J'); eq(prettyKey('Digit3'), '3'); eq(prettyKey('ShiftRight'), 'R-Shift'); eq(prettyKey('ShiftLeft'), 'L-Shift');
  eq(prettyKey('ArrowUp'), '↑'); eq(prettyKey('ArrowLeft'), '←'); eq(prettyKey('Numpad5'), 'Num 5'); eq(prettyKey('space'), 'Space');
  eq(prettyKey('Space'), 'Space'); eq(prettyKey('Mouse0'), 'Left click'); eq(prettyKey('Mouse2'), 'Right click'); eq(prettyKey('Mouse1'), 'Middle click');
  eq(prettyKey('F5'), 'F5'); eq(prettyKey('Escape'), 'Esc');
});

test('copy: sentence case, design wording', () => {
  const copy = {
    shoot: ["Puck's yours", 'Tap to wrist', 'Hold to slap'],
    pass: ['Teammate open', 'Pass it'],
    move: ['Hit the ice', 'Skate', 'Hold for turbo'],
    deke: ['Defender ahead'],
    check: ['Stop the carrier', 'Check', 'Big hit', 'Poke'],
    glass: ['Carrier on the boards', 'Big hit'],
    switch: ['Too far away', 'Switch skater'],
    onetimer: ['Shoot now', 'One-timer: hit it as the pass arrives'],
    fire: ["You're on fire"],
    overtime: ['Sudden death', 'Overtime · next goal wins'],
  };
  for (const [id, parts] of Object.entries(copy)) {
    const t = textOf(hintMarkup(id, 'keyboard', KEYS_ONLY));
    for (const p of parts) ok(t.includes(p), `${id}: "${p}" in "${t}"`);
  }
  for (const id of HINT_IDS) for (const d of DEVICES) for (const kl of [null, KEYS_ONLY]) {
    const t = textOf(hintMarkup(id, d, kl));
    ok(!/[A-Z]{3,}/.test(t), `${id}/${d}: no all-caps words in "${t}"`);
    ok(!/!/.test(t), `${id}/${d}: no exclamation marks in "${t}"`);
  }
});

test('card kinds: urgent, hot (fire) and hot (overtime, warn)', () => {
  eq(hintKind('onetimer'), 'urgent'); eq(hintKind('fire'), 'hot'); eq(hintKind('overtime'), 'hot'); eq(hintKind('shoot'), 'normal'); eq(hintKind('nope'), 'normal');
  const u = hintMarkup('onetimer', 'keyboard', KEYS_ONLY);
  ok(/<span class="ir-tut-glyphs ir-tut-big"><span class="ir-tut-key"><b>J<\/b><\/span><\/span>/.test(u), 'one big J tile');
  const f = hintMarkup('fire', 'keyboard');
  ok(f.includes('ir-tut-hot') && !f.includes('ir-tut-warn') && f.includes('ir-tut-ico-flame'), 'fire: flame glyph + fire tint');
  const o = hintMarkup('overtime', 'gamepad');
  ok(o.includes('ir-tut-hot ir-tut-warn') && o.includes('ir-tut-ico-clock'), 'overtime: clock glyph + warn tint');
  for (const id of ['fire', 'overtime']) ok(!hintMarkup(id, 'keyboard').includes('ir-tut-key'), `${id}: no button glyphs`);
});

test('view: root classes (device + card kind), refresh on device change, cleanup (fake DOM)', () => {
  const ids = {};
  const mkEl = (tag) => ({
    tagName: tag, children: [], attrs: {}, dataset: {}, className: '', innerHTML: '', textContent: '', id: '', parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); c.parentNode = this; if (c.id) ids[c.id] = c; return c; },
    remove() { const p = this.parentNode; if (p) p.children = p.children.filter((x) => x !== this); if (this.id) delete ids[this.id]; this.parentNode = null; },
  });
  const doc = { createElement: mkEl, getElementById: (id) => ids[id] || null };
  doc.head = mkEl('head'); doc.body = mkEl('body'); doc.documentElement = mkEl('html');
  const host = mkEl('div'); host.ownerDocument = doc;
  const t = createTutorial({ container: host, storage: memStorage(), device: 'keyboard', keyLabel: KEYS_ONLY });
  eq(host.children.length, 0, 'no DOM before the first hint');
  eq(t.update(st((s) => { s.ph = PHASE.FACEOFF; }), [], ctx, DT), 'move');
  const root = host.children[0];
  ok(root && ids['ir-tut-style'], 'root + one style element');
  eq(root.className, 'ir-tut-root ir-tut-dev-keyboard ir-tut-k-normal ir-tut-on');
  ok(root.innerHTML.includes('Hit the ice') && root.innerHTML.includes('<b>L-Shift</b>'), root.innerHTML);
  eq(root.attrs.role, 'status'); eq(root.attrs['aria-live'], 'polite');
  eq(t.update(st((s) => put(s, 1, -4, 3)), [ev(EVENT.PASS, { by: 1, to: 0 })], ctx, DT), 'onetimer');
  eq(root.className, 'ir-tut-root ir-tut-dev-keyboard ir-tut-k-urgent ir-tut-on');
  ok(root.innerHTML.includes('Shoot now') && root.innerHTML.includes('<b>J</b>'), 'urgent card, J tile');
  t.setDevice('touch');
  eq(root.className, 'ir-tut-root ir-tut-dev-touch ir-tut-k-urgent ir-tut-on');
  ok(root.innerHTML.includes('<b>Shoot</b>'), 'redrawn for touch');
  hold(t, st(), 3);
  eq(root.className, 'ir-tut-root ir-tut-dev-touch ir-tut-k-urgent', 'hidden (kind kept for the exit fade)');
  t.dispose();
  eq(host.children.length, 0, 'root removed');
  eq(ids['ir-tut-style'], undefined, 'style removed with the last view');
});

test('stylesheet follows the design rules', () => {
  const css = TUTORIAL_CSS;
  for (const t of ['--ice', '--on-ice', '--ink', '--ink-2', '--hairline-strong', '--goal', '--fire', '--warn', '--surface-3', '--f-ui', '--r-lg', '--r-sm', '--r-md']) {
    ok(new RegExp(`var\\(${t}, [^)]`).test(css), `${t} used with a fallback`);
  }
  ok(!/var\(--[\w-]+\)/.test(css.replace(/var\(--tut-acc\)/g, '')), 'every token var() has a fallback');
  ok(!/text-transform:\s*uppercase/.test(css), 'no uppercase');
  ok(!/letter-spacing:\s*(?!0[;\s])\S/.test(css), 'no letter-spacing');
  ok(!/text-shadow|gradient\(|clip-path|skew/.test(css), 'no text-shadow / gradient / clip-path / skew');
  ok(!/box-shadow/.test(css), 'hairlines, no shadows');
  ok(/bottom: calc\(env\(safe-area-inset-bottom, 0px\) \+ 56px\)/.test(css), 'bottom-centre, 56px');
  ok(/\.ir-tut-k-urgent \{[^}]*bottom: calc\(env\(safe-area-inset-bottom, 0px\) \+ 202px\)/.test(css), 'one-timer prompt 202px up (as in the frame)');
  ok(css.indexOf('.ir-tut-root.ir-tut-dev-touch {') > css.indexOf('.ir-tut-root.ir-tut-k-urgent {'), 'touch placement wins over the urgent offset');
  ok(/@media \(orientation: landscape\) and \(max-height: 540px\) \{\s*\.ir-tut-root\.ir-tut-dev-touch:not\(\.ir-tut-k-urgent\) \{[^}]*right: max\(14px[^}]*top: max\(10px/.test(css),
    'phone held sideways: a compact top-right card, clear of the far boards');
  ok(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'reduced motion');
  for (const m of css.matchAll(/font-size:\s*(\d+)px/g)) ok(Number(m[1]) >= 11, `font-size ${m[1]}px >= 11`);
  for (const m of css.matchAll(/(\d+)ms/g)) ok(Number(m[1]) >= 120 && Number(m[1]) <= 340, `duration ${m[1]}ms within 120-340`);
  ok(!/@import|url\(/.test(css), 'no external requests');
});

console.log(`\ntutorial: ${passed} passed, ${failed} failed`);
if (failed) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
