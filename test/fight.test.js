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

// ------------------------------------------------------------------ fight view (public/fight-view.js)
// Pure helpers, then the real view driven through a tiny fake DOM + a no-op 2D context.
const viewMod = await import('../public/fight-view.js');
const { parseHint, popFor, FIGHT_COPY, winsText, comboText, DEFAULT_HINT, LOW_HP, createFightView } = viewMod;
const { TEAMS } = await import('../shared/constants.js');

test('view: parseHint splits the extras hint into key tiles (mouse keys get the glyph)', () => {
  const h = parseHint('Left click jab · L haymaker · Right click block · L-Shift dodge');
  assert(JSON.stringify(h) === JSON.stringify([
    { key: 'Left click', mouse: 'left', label: 'Jab' }, { key: 'L', mouse: null, label: 'Haymaker' },
    { key: 'Right click', mouse: 'right', label: 'Block' }, { key: 'L-Shift', mouse: null, label: 'Dodge' },
  ]), JSON.stringify(h));
  // the old all-caps hint still reads in sentence case
  const old = parseHint('J JAB · L HAYMAKER · K BLOCK · SHIFT DODGE');
  assert(old.map((x) => x.key + ' ' + x.label).join('|') === 'J Jab|L Haymaker|K Block|Shift Dodge', JSON.stringify(old));
  const misc = parseHint('Middle click poke · Mouse2 block · Num + jab · R = new fight · ↑ up · Wave');
  assert(misc[0].mouse === 'middle' && misc[1].mouse === 'right' && misc[1].key === 'Right click', JSON.stringify(misc));
  assert(misc[2].key === 'Num +' && misc[2].label === 'Jab', 'keys with spaces: the action is the last word');
  assert(misc[3].key === 'R' && misc[3].label === 'New fight', '"key = action" form');
  assert(misc[4].key === '↑' && misc[5].key === '' && misc[5].label === 'Wave', 'glyph key, key-less item');
  assert(parseHint(DEFAULT_HINT).length === 4 && parseHint('').length === 0 && parseHint(null).length === 0 && parseHint(false).length === 0);
});

test('view: pop-up words for fight events', () => {
  const by = 0;
  const t = (e, b = by) => { const p = popFor(e, b); return p ? `${p.text}@${p.side}` : null; };
  assert(t({ type: 'punch', kind: 'jab' }) === null, 'plain jab: no pop');
  assert(t({ type: 'punch', kind: 'hay' }) === 'Haymaker!@0');
  assert(t({ type: 'punch', kind: 'jab', ctr: 1 }) === 'Counter!@0');
  assert(t({ type: 'punch', kind: 'jab', int: 1 }) === 'Interrupted!@1', 'interrupted shows on the victim');
  assert(t({ type: 'fight', sub: 'block', brk: 0 }, 1) === 'Blocked@1' && t({ type: 'block', brk: 1 }) === 'Guard break!@0');
  assert(t({ type: 'dodge' }) === 'Whiff!@1', 'whiff shows on the attacker');
  assert(t({ type: 'grab', clash: 1 }) === 'Tie-up!@0' && t({ type: 'grab' }) === null);
  assert(t({ type: 'punch', kind: 'hay' }, -1) === null && t(null) === null && t({ type: 'ko' }) === null);
});

test('view: copy is sentence case (no shouting), callout words as designed', () => {
  for (const [k, v] of Object.entries(FIGHT_COPY)) {
    assert(typeof v === 'string' && v.length, k);
    assert(!/[A-Z]{2,}/.test(v), `${k} has caps: ${v}`);
    assert(/^[A-Z]/.test(v), `${k} starts upper case: ${v}`);
  }
  assert(FIGHT_COPY.tempers === 'Tempers boil over' && FIGHT_COPY.gloves === 'Gloves off!' && FIGHT_COPY.brawl === 'Brawl!');
  assert(FIGHT_COPY.ko === 'Lights out!' && FIGHT_COPY.time === 'Time!' && FIGHT_COPY.reward === 'Full turbo + on fire');
  assert(winsText('Oduya') === 'Oduya wins the scrap' && comboText(6) === '6 hit combo' && LOW_HP === 30);
});

// ---- fake DOM
class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.cls = new Set(); this.attrs = {}; this.txt = ''; this.html = ''; this.id = '';
    this.offsetWidth = 140; this.offsetHeight = 52; this.clientWidth = 1440; this.clientHeight = 900;
    const st = {}; st.setProperty = (k, v) => { st[k] = String(v); }; st.removeProperty = (k) => { delete st[k]; };
    this.style = st;
  }
  get className() { return [...this.cls].join(' '); }
  set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this.cls;
    return {
      add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c),
      toggle: (c, on) => { const w = on === undefined ? !s.has(c) : !!on; if (w) s.add(c); else s.delete(c); return w; },
    };
  }
  get textContent() { return this.txt + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this.html = ''; this.txt = String(v); }
  get innerHTML() { return this.html; }
  set innerHTML(v) { this.children = []; this.txt = ''; this.html = String(v); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'src') delete this.src; }
  getContext() {
    const grad = { addColorStop() {} };
    return new Proxy({}, {
      get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : String(k).startsWith('create') ? () => grad : () => {}),
      set: (t, k, v) => { t[k] = v; return true; },
    });
  }
}
function fakeDoc() {
  const doc = {
    createElement: (t) => new FakeEl(t, doc),
    createTextNode: (s) => ({ textContent: String(s), parentNode: null }),
    defaultView: { devicePixelRatio: 1, getComputedStyle: () => ({ position: 'relative' }), matchMedia: () => ({ matches: false }) },
  };
  doc.head = new FakeEl('head', doc); doc.body = new FakeEl('body', doc); doc.documentElement = new FakeEl('html', doc);
  doc.getElementById = (id) => all(doc.head, (e) => e.id === id)[0] || null;
  return doc;
}
function all(el, pred, out = []) { if (el && el.children) { if (pred(el)) out.push(el); for (const c of el.children) all(c, pred, out); } return out; }
const q1 = (root, cls) => all(root, (e) => e.cls && e.cls.has(cls))[0];
const qa = (root, cls) => all(root, (e) => e.cls && e.cls.has(cls));

test('view: DOM HUD - plates, hp, stamina, dodge, clock, titles, pop-ups, winner band, key tiles', () => {
  const doc = fakeDoc();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const view = createFightView(host);
  const style = doc.getElementById('ir-fight-style');
  assert(style && /var\(--ground,#0A0F1C\)/.test(style.textContent) && /prefers-reduced-motion/.test(style.textContent), 'tokens + reduced motion');
  assert(!/text-shadow|letter-spacing:\.|text-transform|skew|clip-path/.test(style.textContent), 'no shadows, caps or skew in the HUD css');
  const f = createFight({ a: 1, b: 5, teamA: 0, teamB: 1, chkA: 9, chkB: 9, seed: 7 });
  view.show(fightSnapshot(f), {
    nameA: 'Oduya', nameB: 'Bergeron-Ash', numA: 4, numB: 2, ctrlA: 'Mags', ctrlB: 'AI',
    colorA: TEAMS[0].colors, colorB: TEAMS[1].colors, teamA: 0, teamB: 1,
    hint: 'Left click jab · L haymaker · Right click block · L-Shift dodge',
  });
  const root = view.el;
  assert(root.cls.has('ir-fight-on') && root.attrs['aria-hidden'] === 'true', 'shown, decorative');
  const [plA, plB] = qa(root, 'ir-fight-plate');
  assert(q1(plA, 'ir-fight-name').textContent === 'Oduya' && q1(plB, 'ir-fight-name').textContent === 'Bergeron-Ash', 'names as given');
  assert(q1(plA, 'ir-fight-ctrl').textContent === 'Mags' && q1(plB, 'ir-fight-ctrl').textContent === 'AI', 'controller names');
  assert(q1(plA, 'ir-fight-num').textContent === '4' && q1(plB, 'ir-fight-num').textContent === '2', 'number avatars');
  assert(q1(plA, 'ir-fight-hp').textContent === '100', 'hp number');
  assert(q1(root, 'ir-fight-clock-n').textContent === String(FIGHT.DURATION) && q1(root, 'ir-fight-clock-l').textContent === 'The scrap', 'clock tile');
  const call = q1(root, 'ir-fight-callout'), callT = q1(root, 'ir-fight-callout-t');
  assert(call.cls.has('ir-fight-show') && callT.textContent === 'Tempers boil over', 'intro title: ' + callT.textContent);
  // key tiles
  const keys = qa(q1(root, 'ir-fight-hint'), 'ir-fight-key');
  assert(keys.length === 4, 'four key tiles');
  assert(/<svg/.test(q1(keys[0], 'ir-fight-tile').innerHTML) && q1(keys[1], 'ir-fight-tile').textContent === 'L', 'mouse glyph / letter tile');
  assert(keys.map((k) => q1(k, 'ir-fight-act').textContent).join(',') === 'Jab,Haymaker,Block,Dodge', 'labels');

  const run = (n, inA = NONE, inB = NONE, extra = []) => {
    for (let i = 0; i < n; i++) {
      if (!f.done) stepFight(f, DT, inA, inB);
      view.update(fightSnapshot(f), DT, i === 0 ? drainFightEvents(f).concat(extra) : drainFightEvents(f));
    }
  };
  run(Math.ceil(0.35 / DT));
  assert(callT.textContent === 'Gloves off!' && q1(root, 'ir-fight-callout-s').textContent === 'Oduyavs' + 'Bergeron-Ash', 'gloves off + names');
  run(Math.ceil(FIGHT.INTRO / DT));
  assert(callT.textContent === 'Brawl!' && call.cls.has('ir-fight-show'), 'brawl: ' + callT.textContent);
  run(Math.ceil(0.9 / DT));
  assert(!call.cls.has('ir-fight-show'), 'title gone');
  // hp low, stamina low, dodge cooldown, counter ready, combo, pop-ups
  f.A.hp = 27; f.A.en = 0.05; f.B.cd = FIGHT.DODGE.cd * 0.9; f.A.ctrT = 2;
  run(24, NONE, NONE, [{ type: 'punch', by: 5, target: 1, kind: 'jab', power: 0.4, combo: 6 }, { type: 'block', by: 1, target: 5, kind: 'jab' }]);
  const hpA = q1(plA, 'ir-fight-hp');
  assert(hpA.textContent === '27' && hpA.cls.has('ir-fight-low'), `hp ${hpA.textContent} low`);
  const [metaA, metaB] = qa(root, 'ir-fight-meta');
  assert(metaA.cls.has('ir-fight-tired') && metaA.textContent.includes('Stamina low'), 'stamina low');
  assert(metaB.cls.has('ir-fight-cool') && metaB.textContent.includes('Dodge recharging') && metaA.textContent.includes('Dodge ready'), 'dodge states');
  const chipsA = q1(root, 'ir-fight-chips-a'), chipsB = q1(root, 'ir-fight-chips-b');
  assert(q1(chipsA, 'ir-fight-counter').cls.has('ir-fight-show') && q1(chipsA, 'ir-fight-counter').textContent === 'Counter ready', 'counter ready chip');
  assert(q1(chipsB, 'ir-fight-combo').cls.has('ir-fight-show') && q1(chipsB, 'ir-fight-combo').textContent === '6 hit combo', 'combo chip');
  const popTexts = qa(root, 'ir-fight-pop-t').map((p) => p.textContent);
  assert(popTexts.includes('Blocked'), 'pop-up: ' + popTexts.join(','));
  const fills = qa(root, 'ir-fight-fill');
  assert(Math.abs(parseFloat(fills[0].style.width) - 27) < 0.3 && /%$/.test(fills[0].style.width), 'hp bar width ' + fills[0].style.width);
  // knockout -> "Lights out!", then the winner band
  f.B.hp = 1;
  for (let i = 0; i < 120 && f.ph !== 'ko'; i++) run(1, i % 30 === 0 ? { b: BTN.ACTION } : NONE, NONE);
  assert(f.ph === 'ko' && f.winner === 1, 'A knocked B out');
  run(Math.ceil(0.4 / DT));
  assert(callT.textContent === 'Lights out!' && call.cls.has('ir-fight-icon'), 'lights out');
  assert(root.cls.has('ir-fight-ko'), 'hint tiles fade during the outro');
  run(Math.ceil(1.0 / DT));
  const banner = q1(root, 'ir-fight-banner');
  assert(banner.cls.has('ir-fight-show') && q1(banner, 'ir-fight-banner-t').textContent === 'Oduya wins the scrap', 'winner band');
  assert(q1(banner, 'ir-fight-banner-s').textContent === 'Full turbo + on fire' && root.cls.has('ir-fight-done'), 'reward line, band content fades');
  assert(q1(root, 'ir-fight-clock-n').textContent === 'KO', 'clock shows KO');
  // next fight: spectator (no hint band), no reward line, state resets
  view.hide();
  assert(!root.cls.has('ir-fight-on') && qa(root, 'ir-fight-pop').length === 0, 'hidden, pop-ups cleared');
  const g = createFight({ a: 2, b: 6, seed: 3 });
  view.show(fightSnapshot(g), { nameA: 'Lindqvist', nameB: 'Tamura', hint: false, reward: false });
  assert(q1(root, 'ir-fight-hint').children.length === 0, 'no hint band for spectators');
  assert(!q1(root, 'ir-fight-banner').cls.has('ir-fight-show') && !root.cls.has('ir-fight-done'), 'reset');
  assert(qa(root, 'ir-fight-ctrl').every((c) => c.style.display === 'none'), 'no controller names given');
  view.dispose();
  assert(!host.children.includes(root) && !doc.getElementById('ir-fight-style'), 'disposed');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
