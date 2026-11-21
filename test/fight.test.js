// ICE RIOT - fight mini-game tests. Run: node test/fight.test.js  (exit code 1 on any failure)
import {
  createFight, stepFight, fightSnapshot, drainFightEvents, fightAI, fightResult,
  shouldTriggerFight, FIGHT,
} from '../shared/fight.js';
import { BTN, DT } from '../shared/constants.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

// ---- helpers
const NONE = { b: 0 };
function toFight(f, inA = NONE, inB = NONE) {
  let n = 0;
  while (f.ph === 'intro' && n < 1000) { stepFight(f, DT, inA, inB); n++; }
  drainFightEvents(f);
  return n;
}
// run n ticks; fa/fb(i) -> button bits (i = tick index from now)
function steps(f, n, fa, fb) {
  const ev = [];
  for (let i = 0; i < n && !f.done; i++) {
    stepFight(f, DT, { b: fa(i) }, { b: fb(i) });
    ev.push(...drainFightEvents(f));
  }
  return ev;
}
const nothing = () => 0;
const press = (bit, ...at) => (i) => (at.includes(i) ? bit : 0);
const hold = (bit, from = 0, to = Infinity) => (i) => (i >= from && i < to ? bit : 0);
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function runAI(seed, dA, dB, opts = {}) {
  const f = createFight({ a: 1, b: 6, teamA: 0, teamB: 1, chkA: 7, chkB: 7, seed, ...opts });
  const ev = [];
  let ticks = 0, koAt = -1;
  while (!f.done && ticks < 5000) {
    stepFight(f, DT, fightAI(f, 'a', dA), fightAI(f, 'b', dB));
    ev.push(...drainFightEvents(f));
    if (koAt < 0 && f.ph === 'ko') koAt = f.clock;
    ticks++;
  }
  return { f, ev, ticks, koAt };
}
function allFinite(o, path = 'f') {
  if (typeof o === 'number') { if (!Number.isFinite(o)) throw new Error('non-finite number at ' + path + ' = ' + o); return; }
  if (o && typeof o === 'object') for (const k of Object.keys(o)) allFinite(o[k], path + '.' + k);
}

console.log('fight.test.js');

// ------------------------------------------------------------------ phases
test('intro lasts FIGHT.INTRO and ignores button presses', () => {
  const f = createFight({ a: 0, b: 4, seed: 3 });
  assert(fightSnapshot(f).ph === 'intro');
  const n = toFight(f, { b: BTN.SHOOT | BTN.ACTION }, { b: BTN.TURBO });
  assert(Math.abs(n * DT - FIGHT.INTRO) < DT + 1e-9, 'intro ticks ' + n);
  assert(f.A.hp === FIGHT.HP && f.B.hp === FIGHT.HP, 'no damage during intro');
  assert(f.A.n === 0 && f.B.n === 0, 'no actions during intro');
  assert(fightSnapshot(f).ph === 'fight' && Math.abs(fightSnapshot(f).t - FIGHT.DURATION) < 1e-9);
  // held buttons at the bell do not fire (need a fresh press)
  steps(f, 30, () => BTN.SHOOT | BTN.ACTION, () => BTN.TURBO);
  assert(f.A.n === 0 && f.B.n === 0, 'held-through-intro buttons must not trigger');
});

test('fight start emits a grab (tie-up) event', () => {
  const f = createFight({ a: 2, b: 5, seed: 9 });
  let ev = [];
  while (f.ph === 'intro') { stepFight(f, DT, NONE, NONE); ev.push(...drainFightEvents(f)); }
  assert(ev.length === 1 && ev[0].type === 'grab' && [2, 5].includes(ev[0].by), JSON.stringify(ev));
});

// ------------------------------------------------------------------ determinism
test('determinism: same seed + same inputs -> identical events and snapshots', () => {
  const play = (seed) => {
    const f = createFight({ a: 0, b: 4, chkA: 8, chkB: 6, seed });
    const rA = lcg(77), rB = lcg(1234);
    const log = [];
    for (let i = 0; i < 1200 && !f.done; i++) {
      const ia = { b: rA() < 0.15 ? (1 << Math.floor(rA() * 4)) : 0 };
      const ib = i % 3 === 0 ? null : { b: rB() < 0.15 ? (1 << Math.floor(rB() * 4)) : 0 }; // mix human + AI
      stepFight(f, DT, ia, ib);
      log.push(JSON.stringify(fightSnapshot(f)), JSON.stringify(drainFightEvents(f)));
    }
    return log.join('\n');
  };
  const a = play(42), b = play(42), c = play(43);
  assert(a === b, 'same seed diverged');
  assert(a !== c, 'different seed should (almost surely) differ');
});

test('determinism: built-in AI (null inputs) is reproducible', () => {
  const play = () => {
    const f = createFight({ a: 0, b: 4, seed: 2024, difficulty: 2 });
    const out = [];
    while (!f.done) { stepFight(f, DT, null, null); out.push(...drainFightEvents(f)); }
    return JSON.stringify([out, fightSnapshot(f)]);
  };
  assert(play() === play());
});

test('determinism: a JSON round-trip of the fight mid-way continues identically', () => {
  const f1 = createFight({ a: 0, b: 4, seed: 555, difficulty: 1 });
  for (let i = 0; i < 200; i++) stepFight(f1, DT, null, null);
  drainFightEvents(f1);
  const f2 = JSON.parse(JSON.stringify(f1));
  const f3 = structuredClone(f1);
  const ev = [[], [], []];
  [f1, f2, f3].forEach((f, k) => { while (!f.done) { stepFight(f, DT, null, null); ev[k].push(...drainFightEvents(f)); } });
  const s = [f1, f2, f3].map((f, k) => JSON.stringify([ev[k], fightSnapshot(f)]));
  assert(s[0] === s[1] && s[0] === s[2], 'clone diverged');
});

// ------------------------------------------------------------------ AI vs AI always resolves
test('AI vs AI: every fight ends within the time limit with a winner (all difficulty pairs, 40 seeds)', () => {
  const limit = FIGHT.INTRO + FIGHT.DURATION + 1e-6;
  let kos = 0, decisions = 0;
  for (let dA = 0; dA <= 2; dA++) for (let dB = 0; dB <= 2; dB++) for (let s = 1; s <= 40; s++) {
    const { f, ev, koAt } = runAI(s * 131 + dA * 7 + dB, dA, dB);
    assert(f.done === 1, 'not done');
    assert(koAt > 0 && koAt <= limit, 'ended at ' + koAt);
    assert(f.winner === f.A.id || f.winner === f.B.id, 'no winner');
    const kos2 = ev.filter((e) => e.type === 'ko');
    assert(kos2.length === 1 && kos2[0].by === f.winner, 'exactly one ko event naming the winner');
    const r = fightResult(f);
    assert(r && r.winner === f.winner && r.loser !== r.winner && r.done === 1);
    const snap = fightSnapshot(f);
    assert(snap.winner === f.winner && snap.ph === 'ko' && snap.done === 1);
    if (f.how === 'ko') { kos++; assert(Math.min(f.A.hp, f.B.hp) === 0); }
    else { decisions++; assert(f.how === 'time'); }
    assert(Math.abs(f.clock - (koAt + FIGHT.OUTRO)) < DT * 1.5, 'outro length');
  }
  assert(kos > 0 && decisions > 0, `expected both KOs and decisions (ko ${kos}, time ${decisions})`);
});

test('time-out: higher hp wins; exact tie is a seeded coin flip', () => {
  const winners = new Set();
  for (let s = 1; s <= 24; s++) {
    const f = createFight({ a: 0, b: 4, seed: s });
    toFight(f);
    const ev = steps(f, 2000, nothing, nothing);
    assert(f.how === 'time' && f.A.hp === f.B.hp, 'passive fight should be a tied decision');
    assert(ev.some((e) => e.type === 'ko' && e.how === 'time'));
    winners.add(f.winner === f.A.id ? 'a' : 'b');
  }
  assert(winners.size === 2, 'coin flip should pick both sides across seeds');
  // a single landed jab decides a decision
  const f = createFight({ a: 0, b: 4, seed: 1 });
  toFight(f);
  steps(f, 2000, press(BTN.SHOOT, 0), nothing);
  assert(f.how === 'time' && f.winner === f.A.id, 'A landed the only punch -> A wins');
});

// ------------------------------------------------------------------ mechanics
function jabDamage({ defend = nothing, kind = BTN.SHOOT, chkA = 5, chkB = 5, at = 0 } = {}) {
  const f = createFight({ a: 0, b: 4, chkA, chkB, seed: 1 });
  toFight(f);
  const ev = steps(f, 60, press(kind, at), defend);
  return { dmg: FIGHT.HP - f.B.hp, ev, f };
}

test('block reduces jab damage to ~25% and drains stamina', () => {
  const open = jabDamage();
  const blk = jabDamage({ defend: hold(BTN.PASS) });
  assert(open.dmg > 0 && blk.dmg > 0, `dmg open ${open.dmg} blocked ${blk.dmg}`);
  assert(Math.abs(blk.dmg / open.dmg - FIGHT.BLOCK.mul) < 1e-6, 'ratio ' + blk.dmg / open.dmg);
  assert(blk.ev.some((e) => e.type === 'block' && e.by === 4 && e.target === 0 && e.kind === 'jab'));
  assert(!blk.ev.some((e) => e.type === 'punch'), 'a blocked jab is not a punch event');
  assert(open.ev.some((e) => e.type === 'punch' && e.by === 0 && e.target === 4 && e.kind === 'jab'));
  assert(blk.f.B.en < open.f.B.en, 'blocking costs stamina');
});

test('block reduces haymaker damage too', () => {
  const open = jabDamage({ kind: BTN.ACTION });
  const blk = jabDamage({ kind: BTN.ACTION, defend: hold(BTN.PASS) });
  assert(open.dmg > 15, 'haymaker hurts: ' + open.dmg);
  assert(blk.dmg < open.dmg * 0.3, `blocked ${blk.dmg} vs ${open.dmg}`);
  assert(blk.ev.some((e) => e.type === 'block' && e.kind === 'hay'));
});

test('blocking with no stamina left = guard break (stun)', () => {
  const f = createFight({ a: 0, b: 4, seed: 1 });
  toFight(f);
  f.B.en = 0.1;
  const ev = steps(f, 50, press(BTN.ACTION, 0), hold(BTN.PASS));
  const b = ev.find((e) => e.type === 'block');
  assert(b && b.brk === 1, 'guard break flagged');
  assert(f.B.en >= 0, 'stamina stays >= 0');
});

test('chk attribute scales damage', () => {
  const weak = jabDamage({ chkA: 1 }), strong = jabDamage({ chkA: 10 });
  assert(strong.dmg > weak.dmg * 1.4, `chk10 ${strong.dmg} vs chk1 ${weak.dmg}`);
  const tough = jabDamage({ chkB: 10 });
  assert(tough.dmg < jabDamage().dmg, 'high chk defender takes slightly less');
});

test('combo: consecutive clean jabs build a combo and hit harder', () => {
  const f = createFight({ a: 0, b: 4, seed: 1 });
  toFight(f);
  const ev = steps(f, 60, press(BTN.SHOOT, 0, 17), nothing);   // 2nd press buffered during the 1st jab
  const p = ev.filter((e) => e.type === 'punch');
  assert(p.length === 2, 'two jabs landed: ' + p.length);
  assert(p[0].combo === 1 && p[1].combo === 2 && p[1].dmg > p[0].dmg, JSON.stringify(p));
});

test('dodge: invulnerable inside the window, hit outside it', () => {
  // B dodges at tick 0; A's jab lands 0.12-0.13 s after A presses.
  const inside = jabDamage({ at: 5, defend: press(BTN.TURBO, 0) });
  assert(inside.dmg === 0, 'jab landing inside the invulnerability window must whiff, dmg ' + inside.dmg);
  const d = inside.ev.find((e) => e.type === 'dodge');
  assert(d && d.by === 4 && d.target === 0, 'dodge event by the dodger');
  const late = jabDamage({ at: 12, defend: press(BTN.TURBO, 0) });
  assert(late.dmg > 0, 'jab landing after the invulnerability window must hit');
  // exact window edge from the constants: hit lands at (at + hitTicks) ticks into the dodge
  const hitTicks = Math.ceil(FIGHT.JAB.hit / DT - 1e-6);
  const lastSafe = Math.ceil(FIGHT.DODGE.invuln / DT) - 1 - hitTicks;
  assert(jabDamage({ at: lastSafe, defend: press(BTN.TURBO, 0) }).dmg === 0, 'edge inside');
  assert(jabDamage({ at: lastSafe + 1, defend: press(BTN.TURBO, 0) }).dmg > 0, 'edge outside');
});

test('dodge: whiff gives the dodger a counter (x' + FIGHT.COUNTER.mul + ') and has a cooldown', () => {
  const f = createFight({ a: 0, b: 4, seed: 1 });
  toFight(f);
  const ev = steps(f, 90, press(BTN.SHOOT, 2), (i) => (i === 0 ? BTN.TURBO : i === 26 ? BTN.SHOOT : 0));
  const pB = ev.find((e) => e.type === 'punch' && e.by === 4);
  assert(pB && pB.ctr === 1, 'counter punch flagged');
  const base = jabDamage().dmg;
  assert(Math.abs(pB.dmg - base * FIGHT.COUNTER.mul) < 1e-6, `counter dmg ${pB.dmg} vs ${base}`);
  // cooldown: second dodge press 0.6 s later is rejected, one after the cooldown works
  const g = createFight({ a: 0, b: 4, seed: 1 });
  toFight(g);
  steps(g, 40, nothing, press(BTN.TURBO, 0, 36));
  assert(g.B.n === 1, 'second dodge inside cooldown must not start');
  steps(g, 60, nothing, press(BTN.TURBO, 50));
  assert(g.B.n === 2, 'dodge after cooldown works');
});

test('haymaker is interrupted by a jab during the windup', () => {
  const f = createFight({ a: 0, b: 4, seed: 1 });
  toFight(f);
  const ev = steps(f, 90, press(BTN.ACTION, 0), press(BTN.SHOOT, 6));
  const pB = ev.find((e) => e.type === 'punch' && e.by === 4);
  assert(pB && pB.int === 1 && pB.kind === 'jab', 'interrupt flagged: ' + JSON.stringify(ev));
  assert(!ev.some((e) => e.type === 'punch' && e.by === 0), 'interrupted haymaker never lands');
  assert(f.B.hp === FIGHT.HP, 'defender untouched');
  // a jab that arrives after the haymaker's hit frame does not save you
  const g = createFight({ a: 0, b: 4, seed: 1 });
  toFight(g);
  const ev2 = steps(g, 90, press(BTN.ACTION, 0), press(BTN.SHOOT, 25));
  assert(ev2.some((e) => e.type === 'punch' && e.by === 0 && e.kind === 'hay'), 'late jab: haymaker lands');
  assert(!ev2.some((e) => e.type === 'punch' && e.by === 4), 'late jab got cancelled by the stun');
});

test('simultaneous punches clash into a tie-up', () => {
  const f = createFight({ a: 0, b: 4, seed: 1 });
  toFight(f);
  const ev = steps(f, 30, press(BTN.SHOOT, 0), press(BTN.SHOOT, 0));
  assert(ev.filter((e) => e.type === 'punch').length === 2, 'both land');
  assert(ev.some((e) => e.type === 'grab' && e.clash === 1), 'grab event');
  assert(f.A.hp === f.B.hp, 'symmetric damage');
});

test('KO when hp reaches 0: ko event, winner/loser states, done after the outro', () => {
  const f = createFight({ a: 3, b: 7, seed: 1 });
  toFight(f);
  f.B.hp = 5;
  const ev = steps(f, 40, press(BTN.ACTION, 0), nothing);
  const ko = ev.find((e) => e.type === 'ko');
  assert(ko && ko.by === 3 && ko.target === 7 && ko.how === 'ko', JSON.stringify(ko));
  const s = fightSnapshot(f);
  assert(s.ph === 'ko' && s.winner === 3 && s.stA === 'win' && s.stB === 'ko' && s.hpB === 0);
  steps(f, Math.ceil(FIGHT.OUTRO / DT) + 2, nothing, nothing);
  assert(f.done === 1 && fightSnapshot(f).done === 1);
  const before = JSON.stringify(f);
  stepFight(f, DT, { b: 15 }, { b: 15 });
  assert(JSON.stringify(f) === before, 'stepping a finished fight is a no-op');
});

// ------------------------------------------------------------------ AI quality
test('difficulty affects AI win rate vs a scripted jab spammer (rookie beatable, all-star tough)', () => {
  const spam = (tick) => (tick % 10 === 0 ? BTN.SHOOT : 0) | (tick % 97 === 50 ? BTN.ACTION : 0);
  const N = 80, rate = [];
  for (let d = 0; d <= 2; d++) {
    let wins = 0;
    for (let s = 1; s <= N; s++) {
      const f = createFight({ a: 0, b: 4, chkA: 7, chkB: 7, seed: 1000 + s });
      let tick = 0;
      while (!f.done) { stepFight(f, DT, fightAI(f, 'a', d), { b: spam(tick++) }); drainFightEvents(f); }
      if (f.winner === f.A.id) wins++;
    }
    rate.push(wins / N);
  }
  console.log('       AI win rate vs spammer  rookie %s  pro %s  all-star %s', ...rate.map((r) => (r * 100).toFixed(0) + '%'));
  assert(rate[0] < 0.25, 'rookie should usually lose to a spammer');
  assert(rate[2] > 0.6, 'all-star should usually beat a spammer');
  assert(rate[0] < rate[1] && rate[1] < rate[2], 'monotonic in difficulty');
});

test('higher difficulty AI beats lower difficulty AI most of the time', () => {
  let w = 0;
  const N = 60;
  for (let s = 1; s <= N; s++) {
    const r = runAI(s, s % 2 ? 2 : 0, s % 2 ? 0 : 2);          // alternate sides
    const strong = s % 2 ? r.f.A.id : r.f.B.id;
    if (r.f.winner === strong) w++;
  }
  assert(w / N > 0.8, 'all-star vs rookie win rate ' + w / N);
});

test('AI mirror matches are side-fair', () => {
  let wa = 0;
  const N = 300;
  for (let s = 1; s <= N; s++) if (runAI(s * 17, 1, 1).f.winner === 1) wa++;
  assert(Math.abs(wa / N - 0.5) < 0.1, 'side A win rate ' + wa / N);
});

// ------------------------------------------------------------------ robustness
test('no NaN: fuzzed inputs, garbage params, odd dt', () => {
  const junk = [undefined, null, NaN, 'x', -1, 999, 1.5, Infinity, {}, [], '3'];
  for (let s = 0; s < 30; s++) {
    const r = lcg(s + 1);
    const f = createFight({
      a: junk[s % junk.length], b: 4, teamA: junk[(s + 3) % junk.length],
      chkA: junk[(s + 1) % junk.length], chkB: junk[(s + 5) % junk.length],
      seed: junk[(s + 2) % junk.length], difficulty: junk[(s + 4) % junk.length],
    });
    for (let i = 0; i < 900 && !f.done; i++) {
      const pick = () => (r() < 0.1 ? { b: junk[Math.floor(r() * junk.length)] } : r() < 0.3 ? null : { b: Math.floor(r() * 16) });
      const dt = i % 97 === 0 ? junk[Math.floor(r() * junk.length)] : DT;
      stepFight(f, dt, pick(), pick());
      if (i % 5 === 0) fightAI(f, r() < 0.5 ? 'a' : 'b', junk[Math.floor(r() * junk.length)]);
      const snap = fightSnapshot(f);
      allFinite(snap, 'snap');
      assert(JSON.stringify(snap) === JSON.stringify(JSON.parse(JSON.stringify(snap))), 'snapshot JSON-safe');
      for (const e of drainFightEvents(f)) allFinite(e, 'event');
      assert(snap.hpA >= 0 && snap.hpA <= FIGHT.HP && snap.hpB >= 0 && snap.hpB <= FIGHT.HP, 'hp range');
      assert(snap.enA >= 0 && snap.enA <= 1 && snap.enB >= 0 && snap.enB <= 1, 'stamina range');
    }
    allFinite(f);
  }
});

test('shouldTriggerFight rule', () => {
  const base = { big: true, chkBy: 7, chkTarget: 6, fights: 0, roll: 0.1 };
  assert(shouldTriggerFight(base));
  assert(!shouldTriggerFight({ ...base, big: false }));
  assert(!shouldTriggerFight({ ...base, chkTarget: 5 }));
  assert(!shouldTriggerFight({ ...base, roll: 0.3 }));
  assert(!shouldTriggerFight({ ...base, fights: 2 }));
  assert(!shouldTriggerFight());
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
