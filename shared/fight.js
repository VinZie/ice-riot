// ICE RIOT - hockey-fight mini-game ("the scrap").
//
// PURE + DETERMINISTIC: no IO, no timers, no Date, no Math.random, no DOM, no Node APIs.
// Runs in Node (authoritative server) and in the browser (local test page). Every bit of state,
// including the AI's memory and the seeded PRNGs, lives in one plain JSON-safe object, so the
// sim can keep a fight inside its game state and structuredClone / JSON round-trips still work.
//
// API
//   createFight({ a, b, teamA, teamB, chkA, chkB, seed, difficulty }) -> fight
//   stepFight(fight, dt, inA, inB)   inA/inB = {b} (BTN bitfield) or null => built-in AI (fight.difficulty)
//   fightSnapshot(fight)             -> JSON-safe snapshot (see bottom of file)
//   drainFightEvents(fight)          -> [{type:'punch'|'block'|'dodge'|'grab'|'ko', by, power, ...}]
//   fightAI(fight, side, difficulty) -> {b}   call at most once per side per tick, BEFORE stepFight
//
// CONTROLS (existing BTN bits)
//   SHOOT  = jab       fast (lands 0.12 s after the press), low damage, interrupts a haymaker windup
//   ACTION = haymaker  0.5 s windup, big damage + long stun, cancelled if you get hit while winding up
//   PASS   = block     hold. Takes 25% damage, drains stamina; empty stamina while blocking = guard break
//   TURBO  = dodge     lean back: 0.26 s of invulnerability, 1.1 s cooldown. A whiffed punch leaves the
//                      attacker off balance and gives the dodger a COUNTER (next punch x1.4)
//   Presses made while busy are buffered for 0.18 s. Consecutive clean hits build a combo (+12%/hit).
//   Damage scales with the attacker's chk (and slightly with the defender's chk), and drops when
//   the attacker is low on stamina.
//
// FLOW: 'intro' (1.2 s, inputs ignored) -> 'fight' (up to 15 s) -> 'ko' (2.4 s outro) -> done = 1.
// Ends on hp <= 0 (how = 'ko') or when the clock runs out (how = 'time': higher hp wins, an exact tie
// is decided by the fight's PRNG).

import { BTN, clamp } from './constants.js';

export const FIGHT = {
  INTRO: 1.2,
  DURATION: 15,        // was 8: longer scraps, more of them end in a KO
  OUTRO: 2.4,
  HP: 100,
  JAB: { hit: 0.12, total: 0.3, dmg: 7.5, cost: 0.07, stun: 0.2, stun2: 0.15, whiff: 0.12, recoil: 0.1 },
  HAY: { hit: 0.5, total: 0.86, dmg: 24, cost: 0.2, stun: 0.5, intStun: 0.42, whiff: 0.4, recoil: 0.22 },
  BLOCK: { mul: 0.25, drain: 0.16, cost: { jab: 0.05, hay: 0.2 }, breakStun: 0.65, minEn: 0.02 },
  DODGE: { total: 0.34, invuln: 0.26, cd: 1.1, cost: 0.1 },
  COUNTER: { win: 0.6, mul: 1.4 },
  COMBO: { win: 1.2, step: 0.12, max: 5 },
  CLASH: 0.4,          // both punches land on the same tick -> tie-up ('grab') for this long
  REGEN: { idle: 0.28, act: 0.1, stun: 0.18, block: -0.16, dodge: 0 },
  BUFFER: 0.18,
};

// Suggested trigger rule + outcome effects for the sim (pure helpers, optional to use).
// chance tuned down from 0.25 (≈1.4 fights/game, too many stoppages) to ≈0.6-0.7 fights/game
export const FIGHT_TRIGGER = { minChk: 6, chance: 0.12, maxPerGame: 2 };
export const FIGHT_REWARD = { winnerTurbo: 1, winnerFire: true, loserTurbo: 0, loserDown: 1.4 };

const SPEC = { jab: FIGHT.JAB, hay: FIGHT.HAY };
const ACT_BIT = { jab: BTN.SHOOT, hay: BTN.ACTION, dodge: BTN.TURBO };

// ---------------------------------------------------------------- PRNG (mulberry32, state in an object)
function mix32(x) {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) | 0;
}
function rnd(o, k) {
  const s = (o[k] = (o[k] + 0x6d2b79f5) | 0);
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const num = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const bits = (b) => (Number.isFinite(+b) ? (+b | 0) & 15 : 0);

// ---------------------------------------------------------------- creation
function makeFighter(id, team, chk) {
  return {
    id, team,
    chk: clamp(num(chk, 5), 1, 10),
    hp: FIGHT.HP,
    en: 1,            // stamina 0..1
    st: 'idle',       // idle|block|jab|hay|dodge|stun|grab|ko|lose|win
    sT: 0,            // seconds in st
    e: 0,             // state-entry counter (AI uses it to make one decision per episode)
    dur: 0,           // duration of timed states (stun / grab)
    extra: 0,         // extra recovery added to the current attack (whiff / blocked)
    hit: 0,           // 1 once the current attack has resolved
    pm: 1,            // power multiplier of the current attack (stamina at the start of the swing)
    ctr: 0,           // current attack is a counter
    ctrT: 0,          // counter window remaining
    cd: 0,            // dodge cooldown remaining
    combo: 0, comboT: 0,
    buf: '', bufT: 0, // buffered action
    pb: 0,            // previous buttons (edge detection)
    n: 0,             // actions started
  };
}
function aiMem(seed) {
  return {
    r: seed, next: -1, blockUntil: 0, dodgeAt: -1, pend: '', lastB: 0,
    readE: -1, guardN: -1, punE: -1, ctrE: -1, opN: 0, acts: [], lastCombo: 0, chain: 0,
  };
}

export function createFight({ a = 0, b = 1, teamA = 0, teamB = 1, chkA = 5, chkB = 5, seed = 1, difficulty = 1 } = {}) {
  const s = Math.floor(num(seed, 1)) | 0;
  return {
    v: 1,
    ph: 'intro',
    t: FIGHT.INTRO,            // seconds left in the current phase
    clock: 0,                  // seconds since createFight
    difficulty: clamp(num(difficulty, 1), 0, 2),
    rng: mix32(s ^ 0x5bd1e995),
    winner: -1,
    how: '',
    done: 0,
    lastPow: 0,
    A: makeFighter(num(a, 0) | 0, num(teamA, 0) | 0, chkA),
    B: makeFighter(num(b, 1) | 0, num(teamB, 1) | 0, chkB),
    ai: { a: aiMem(mix32(s + 0x3c6ef372)), b: aiMem(mix32((s ^ 0x1b873593) - 0x61c88647)) },
    ev: [],
  };
}

// ---------------------------------------------------------------- helpers
function emit(f, type, by, power, extra) {
  f.ev.push(Object.assign({ type, by, power: clamp(power, 0, 1) }, extra));
}
function setState(F, st, dur = 0) {
  F.st = st; F.sT = 0; F.dur = dur; F.e++;
  F.hit = 0; F.extra = 0; F.ctr = 0;
}
const canAct = (F) => F.st === 'idle' || F.st === 'block';
const chkMul = (chk) => 0.75 + 0.05 * chk;          // chk 5 -> 1.00, chk 10 -> 1.25
const defMul = (chk) => 1.1 - 0.02 * chk;           // chk 5 -> 1.00, chk 10 -> 0.90
const staminaMul = (en) => (en >= 0.3 ? 1 : 0.55 + 1.5 * en);

function startAction(F, act) {
  if (act === 'dodge') {
    if (F.cd > 0) return false;
    setState(F, 'dodge');
    F.cd = FIGHT.DODGE.cd;
    F.en = Math.max(0, F.en - FIGHT.DODGE.cost);
    F.n++;
    return true;
  }
  const spec = SPEC[act];
  const ctr = F.ctrT > 0 ? 1 : 0;
  setState(F, act);
  F.pm = staminaMul(F.en);
  F.en = Math.max(0, F.en - spec.cost);
  F.ctr = ctr;
  F.ctrT = 0;
  F.n++;
  return true;
}

function pendingHit(F) {
  if ((F.st === 'jab' || F.st === 'hay') && !F.hit && F.sT >= SPEC[F.st].hit - 1e-9) return F.st;
  return '';
}

// Reads state only: what WOULD happen if att's `kind` punch reached def right now.
function computeHit(att, def, kind) {
  const spec = SPEC[kind];
  if (def.st === 'dodge' && def.sT < FIGHT.DODGE.invuln) return { res: 'dodge', kind, dmg: 0 };
  let dmg = spec.dmg * chkMul(att.chk) * defMul(def.chk) * att.pm * (att.ctr ? FIGHT.COUNTER.mul : 1);
  if (def.st === 'block') return { res: 'block', kind, dmg: dmg * FIGHT.BLOCK.mul };
  const combo = att.comboT > 0 ? att.combo + 1 : 1;
  dmg *= 1 + FIGHT.COMBO.step * (Math.min(combo, FIGHT.COMBO.max) - 1);
  const int = def.st === 'hay' && !def.hit && def.sT < FIGHT.HAY.hit ? 1 : 0;
  return { res: 'hit', kind, dmg, combo, int, ctr: att.ctr };
}

function applyHit(f, att, def, h) {
  const spec = SPEC[h.kind];
  att.hit = 1;
  if (h.res === 'dodge') {
    att.extra = spec.whiff;
    att.combo = 0; att.comboT = 0;
    def.ctrT = FIGHT.COUNTER.win;
    emit(f, 'dodge', def.id, 0, { target: att.id, kind: h.kind });
    return;
  }
  if (h.res === 'block') {
    def.hp -= h.dmg;
    def.en -= FIGHT.BLOCK.cost[h.kind];
    att.extra = spec.recoil;
    att.combo = 0; att.comboT = 0;
    if (h.kind === 'hay') def.ctrT = FIGHT.COUNTER.win * 0.7;
    let brk = 0;
    if (def.en <= 0) {
      def.en = 0; brk = 1;
      setState(def, 'stun', FIGHT.BLOCK.breakStun);
    }
    const power = brk ? 0.7 : h.dmg / 8;
    f.lastPow = power;
    emit(f, 'block', def.id, power, { target: att.id, kind: h.kind, dmg: h.dmg, brk });
    return;
  }
  def.hp -= h.dmg;
  att.combo = h.combo; att.comboT = FIGHT.COMBO.win;
  def.combo = 0; def.comboT = 0;
  def.ctrT = 0;
  const stun = h.kind === 'jab' ? (h.combo >= 2 ? FIGHT.JAB.stun2 : FIGHT.JAB.stun) : FIGHT.HAY.stun;
  setState(def, 'stun', h.int ? Math.max(stun, FIGHT.HAY.intStun) : stun);
  const power = h.dmg / 22;
  f.lastPow = power;
  emit(f, 'punch', att.id, power, { target: def.id, kind: h.kind, dmg: h.dmg, combo: h.combo, ctr: h.ctr, int: h.int });
}

function endFight(f, W, how) {
  const L = W === f.A ? f.B : f.A;
  f.ph = 'ko';
  f.t = FIGHT.OUTRO;
  f.winner = W.id;
  f.how = how;
  L.hp = Math.max(0, L.hp);
  if (W.hp <= 0) W.hp = 1;
  setState(W, 'win');
  setState(L, how === 'ko' ? 'ko' : 'lose');
  W.buf = L.buf = '';
  emit(f, 'ko', W.id, how === 'ko' ? Math.max(0.6, f.lastPow) : 0.35, { target: L.id, how });
}

function handleInput(F, b) {
  const pressed = b & ~F.pb;
  F.pb = b;
  let act = '';
  if (pressed & BTN.TURBO) act = 'dodge';
  else if (pressed & BTN.ACTION) act = 'hay';
  else if (pressed & BTN.SHOOT) act = 'jab';
  if (act) { F.buf = act; F.bufT = FIGHT.BUFFER; }
  if (F.buf && canAct(F)) {
    if (startAction(F, F.buf)) F.buf = '';
  }
  if (F.st === 'idle' && (b & BTN.PASS) && F.en > FIGHT.BLOCK.minEn) setState(F, 'block');
  else if (F.st === 'block' && (!(b & BTN.PASS) || F.en <= 0)) setState(F, 'idle');
}

function tickTimers(F, dt) {
  F.sT += dt;
  if (F.cd > 0) F.cd = Math.max(0, F.cd - dt);
  if (F.ctrT > 0) F.ctrT = Math.max(0, F.ctrT - dt);
  if (F.comboT > 0) { F.comboT -= dt; if (F.comboT <= 0) { F.comboT = 0; F.combo = 0; } }
  if (F.bufT > 0) { F.bufT -= dt; if (F.bufT <= 0) { F.bufT = 0; F.buf = ''; } }
}

function endStates(F) {
  switch (F.st) {
    case 'jab': case 'hay':
      if (F.sT >= SPEC[F.st].total + F.extra - 1e-9) setState(F, 'idle');
      break;
    case 'dodge':
      if (F.sT >= FIGHT.DODGE.total - 1e-9) setState(F, 'idle');
      break;
    case 'stun': case 'grab':
      if (F.sT >= F.dur - 1e-9) setState(F, 'idle');
      break;
  }
}

function regen(F, dt) {
  const R = FIGHT.REGEN;
  let r;
  switch (F.st) {
    case 'idle': r = R.idle; break;
    case 'block': r = R.block; break;
    case 'jab': case 'hay': r = R.act; break;
    case 'dodge': r = R.dodge; break;
    default: r = R.stun;
  }
  F.en = clamp(F.en + r * dt, 0, 1);
}

// ---------------------------------------------------------------- step
export function stepFight(f, dt, inA, inB) {
  if (!f || f.done) return f;
  dt = +dt;
  if (!(dt > 0) || !Number.isFinite(dt)) return f;
  dt = Math.min(dt, 0.1);
  const bA = inA ? bits(inA.b) : fightAI(f, 'a', f.difficulty).b;
  const bB = inB ? bits(inB.b) : fightAI(f, 'b', f.difficulty).b;
  const A = f.A, B = f.B;
  f.clock += dt;

  if (f.ph === 'intro') {
    A.pb = bA; B.pb = bB;          // a button held through the intro does not fire at the bell
    A.sT += dt; B.sT += dt;
    f.t -= dt;
    if (f.t <= 1e-9) {
      f.ph = 'fight';
      f.t = FIGHT.DURATION;
      const first = rnd(f, 'rng') < 0.5 ? A : B;
      emit(f, 'grab', first.id, 0, { target: first === A ? B.id : A.id, start: 1 });
      if (bA & BTN.PASS) setState(A, 'block');
      if (bB & BTN.PASS) setState(B, 'block');
    }
    return f;
  }

  if (f.ph === 'ko') {
    A.sT += dt; B.sT += dt;
    f.t -= dt;
    if (f.t <= 1e-9) { f.t = 0; f.done = 1; }
    return f;
  }

  // ---- fight
  tickTimers(A, dt);
  tickTimers(B, dt);

  const kA = pendingHit(A), kB = pendingHit(B);
  const hA = kA ? computeHit(A, B, kA) : null;   // both computed from the same pre-tick states
  const hB = kB ? computeHit(B, A, kB) : null;
  if (hA) applyHit(f, A, B, hA);
  if (hB) applyHit(f, B, A, hB);
  if (hA && hB && hA.res === 'hit' && hB.res === 'hit') {
    // simultaneous clean hits: both eat it, then they tie each other up
    setState(A, 'grab', FIGHT.CLASH);
    setState(B, 'grab', FIGHT.CLASH);
    A.combo = B.combo = 0; A.comboT = B.comboT = 0;   // symmetric: the tie-up breaks both combos
    const first = rnd(f, 'rng') < 0.5 ? A : B;
    emit(f, 'grab', first.id, 0.3, { target: first === A ? B.id : A.id, clash: 1 });
  }

  if (A.hp <= 0 || B.hp <= 0) {
    let W;
    if (A.hp <= 0 && B.hp <= 0) W = A.hp > B.hp ? A : B.hp > A.hp ? B : (rnd(f, 'rng') < 0.5 ? A : B);
    else W = A.hp <= 0 ? B : A;
    endFight(f, W, 'ko');
    return f;
  }

  endStates(A); endStates(B);
  handleInput(A, bA); handleInput(B, bB);
  regen(A, dt); regen(B, dt);

  f.t -= dt;
  if (f.t <= 1e-9) {
    f.t = 0;
    const d = A.hp - B.hp;
    const W = Math.abs(d) > 1e-9 ? (d > 0 ? A : B) : (rnd(f, 'rng') < 0.5 ? A : B);
    endFight(f, W, 'time');
  }
  return f;
}

// ---------------------------------------------------------------- AI
// Values per difficulty [rookie, pro, all-star]; fractional difficulty interpolates.
const AI_P = {
  react: [0.3, 0.17, 0.12],     // s before a new opponent state is "seen"
  read: [0.3, 0.65, 0.92],     // chance to answer a seen haymaker windup at all
  interrupt: [0.15, 0.45, 0.8],// ...with an interrupting jab (else dodge / block)
  guard: [0.1, 0.55, 0.8],      // chance to raise the guard under jab pressure
  counter: [0.3, 0.8, 0.95],   // chance to punish an opponent who can't act
  chain: [0.25, 0.55, 0.85],   // chance to follow a landed hit with another jab
  gapMin: [0.5, 0.35, 0.22],   // neutral-game pause between attacks
  gapMax: [1.2, 0.85, 0.6],
  hay: [0.3, 0.25, 0.22],      // haymaker share in the neutral game
  mistake: [0.2, 0.08, 0.02],  // wasted dodge / reckless haymaker
};
function aiParams(d) {
  d = clamp(num(d, 1), 0, 2);
  const i = d < 1 ? 0 : 1, t = d - i, o = {};
  for (const k in AI_P) o[k] = AI_P[k][i] + (AI_P[k][i + 1] - AI_P[k][i]) * t;
  return o;
}
// Seconds the fighter is guaranteed unable to act (0 if it can act or is threatening).
function vulnerable(F) {
  switch (F.st) {
    case 'stun': case 'grab': return F.dur - F.sT;
    case 'jab': case 'hay': return F.hit ? SPEC[F.st].total + F.extra - F.sT : 0;
    case 'dodge': return F.sT >= FIGHT.DODGE.invuln ? FIGHT.DODGE.total - F.sT : 0;
    default: return 0;
  }
}

export function fightAI(f, side, difficulty = f.difficulty) {
  const isB = side === 'b';
  const m = f.ai[isB ? 'b' : 'a'];
  const me = isB ? f.B : f.A, op = isB ? f.A : f.B;
  if (f.ph !== 'fight' || f.done) { m.lastB = 0; m.pend = ''; return { b: 0 }; }
  const P = aiParams(difficulty);
  const now = f.clock;
  const R = () => rnd(m, 'r');
  const { JAB, HAY, DODGE } = FIGHT;
  if (m.next < 0) m.next = now + 0.1 + 0.5 * R();   // first swing: staggered after the bell

  if (op.n !== m.opN) { m.opN = op.n; m.acts.push(now); if (m.acts.length > 4) m.acts.shift(); }
  const free = canAct(me);
  const seen = op.sT >= P.react;
  let want = '';

  // 1) read a haymaker windup
  if (op.st === 'hay' && !op.hit && op.sT < HAY.hit && seen && m.readE !== op.e) {
    m.readE = op.e;
    const remain = HAY.hit - op.sT;
    if (R() < P.read) {
      if (free && remain > JAB.hit + 0.04 && R() < P.interrupt) want = 'jab';
      else if (me.cd <= 0 && R() < 0.5) m.dodgeAt = now + Math.max(0, remain - DODGE.invuln * 0.5);
      else m.blockUntil = Math.max(m.blockUntil, now + remain + 0.15);
    }
  }
  if (m.dodgeAt >= 0 && now >= m.dodgeAt - 1e-9) { m.dodgeAt = -1; if (!want) want = 'dodge'; }

  // 2) jab pressure -> raise the guard for a moment
  let recent = 0;
  for (const t of m.acts) if (now - t < 1.0) recent++;
  if (recent >= 2 && op.st === 'jab' && m.guardN !== op.n) {
    m.guardN = op.n;
    if (R() < P.guard) m.blockUntil = Math.max(m.blockUntil, now + 0.3 + 0.3 * R());
  }

  // 3) punish an opponent who can't act (blocked / whiffed / stunned / tied up)
  const vuln = vulnerable(op);
  if (!want && free && seen && vuln > JAB.hit + 0.02 && m.punE !== op.e) {
    m.punE = op.e;
    if (R() < P.counter) want = vuln > HAY.hit + 0.05 && me.en > 0.3 && R() < 0.75 ? 'hay' : 'jab';
  }

  // 4) counter after my own successful dodge / haymaker block
  if (!want && free && me.ctrT > 0 && m.ctrE !== me.e) {
    m.ctrE = me.e;
    if (R() < P.counter) want = vulnerable(op) > HAY.hit ? 'hay' : 'jab';
  }

  // 5) keep a combo going
  if (me.combo > m.lastCombo && R() < P.chain) m.chain = 1;
  m.lastCombo = me.combo;
  if (!want && m.chain && (free || (me.st === 'jab' && me.hit && JAB.total + me.extra - me.sT <= 0.12))) {
    want = 'jab'; m.chain = 0;
  }

  // 6) neutral offense
  if (!want && free && now >= m.next && m.blockUntil <= now) {
    m.next = now + P.gapMin + (P.gapMax - P.gapMin) * R();
    if (R() < P.mistake) want = me.cd <= 0 ? 'dodge' : 'hay';
    else if (me.en < 0.2 && R() < 0.6) want = '';      // catch a breath
    else want = me.en > 0.35 && R() < P.hay ? 'hay' : 'jab';
  }

  if (want) {
    m.pend = want;
    if (want !== 'dodge') m.blockUntil = Math.min(m.blockUntil, now);   // drop the guard to swing
  }
  let b = 0;
  if (m.blockUntil > now && me.en > 0.08) b |= BTN.PASS;
  if (m.pend) {
    const bit = ACT_BIT[m.pend];
    if (!(m.lastB & bit)) { b |= bit; m.pend = ''; }
  }
  m.lastB = b;
  return { b };
}

// ---------------------------------------------------------------- output
export function fightSnapshot(f) {
  const A = f.A, B = f.B;
  return {
    a: A.id, b: B.id,           // player ids
    tA: A.team, tB: B.team,     // team of each fighter
    ph: f.ph,                   // 'intro' | 'fight' | 'ko'
    t: Math.max(0, f.t),        // seconds left in this phase (fight clock during 'fight')
    hpA: A.hp, hpB: B.hp,       // 0..FIGHT.HP
    stA: A.st, stB: B.st,       // fighter state: idle|block|jab|hay|dodge|stun|grab|ko|lose|win
    sTA: A.sT, sTB: B.sT,       // seconds in that state
    enA: A.en, enB: B.en,       // stamina 0..1
    cbA: A.combo, cbB: B.combo, // current combo count
    cdA: A.cd / FIGHT.DODGE.cd, cdB: B.cd / FIGHT.DODGE.cd, // dodge cooldown 1..0 (0 = ready)
    crA: A.ctrT > 0 || A.ctr ? 1 : 0, crB: B.ctrT > 0 || B.ctr ? 1 : 0, // counter ready / counter swing
    winner: f.winner,           // player id or -1
    how: f.how,                 // '' | 'ko' | 'time'
    done: f.done,               // 1 once the outro finished: resume play
  };
}

export function drainFightEvents(f) {
  const ev = f.ev;
  f.ev = [];
  return ev;
}

// { done, winner, loser, how, ...FIGHT_REWARD } once decided, else null.
export function fightResult(f) {
  if (!f || f.winner < 0) return null;
  const loser = f.winner === f.A.id ? f.B.id : f.A.id;
  return { done: f.done, winner: f.winner, loser, how: f.how, ...FIGHT_REWARD };
}

// Suggested trigger rule. roll = a number in [0,1) from the SIM's own PRNG.
export function shouldTriggerFight({ big, chkBy, chkTarget, fights = 0, roll = 1 } = {}) {
  const T = FIGHT_TRIGGER;
  return !!big && num(chkBy, 0) >= T.minChk && num(chkTarget, 0) >= T.minChk && fights < T.maxPerGame && num(roll, 1) < T.chance;
}
