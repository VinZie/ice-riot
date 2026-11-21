// ICE RIOT - contextual tutorial hints.
//
//   import { createTutorial } from './tutorial.js';
//   const tutorial = createTutorial({ container: document.getElementById('ui'), device: 'keyboard' });
//   every frame:  tutorial.update(state, events, { myId }, dtSec);   // -> visible hint id or null
//   tutorial.setDevice('gamepad' | 'keyboard' | 'touch');           // from the last input source
//   tutorial.setEnabled(false);  tutorial.reset();  tutorial.dispose();
//
// Short arcade prompts that teach the controls in context:
//   * each hint shows at most 2-3 times in total (counts persisted in `storage` under `storageKey`);
//     performing the hinted action while it is on screen retires that hint for good
//   * at most one hint on screen, and >= 6 s of quiet between two hints
//   * a hint hides after 4 s, as soon as the hinted action is performed, or when its situation is
//     over (e.g. the deke hint hides when I lose the puck)
//   * the one-timer prompt is time-critical: it ignores the quiet gap, replaces any other hint and
//     shows in the same frame the PASS event arrives
//
// All trigger logic is pure (analyze() + the predicates + createTutorialCore()) and runs in Node
// without a DOM - see test/tutorial.test.js. The DOM layer is built lazily on the first hint and is
// skipped entirely when `container` is null. It injects one <style id="ir-tut-style"> (every rule is
// prefixed .ir-tut-*) and never takes pointer events.
//
// `ctx` is the renderer ctx ({ myId, ... }). Optional extra: `ctx.periods` = config.periods (default
// DEFAULT_CONFIG.periods) to recognise overtime (snapshot `per` > periods).
//
// `keyLabel(button, action)` (optional, keyboard only) returns the label for a rebound key.
//   button: 'move' | 'shoot' | 'pass' | 'action' | 'turbo'   (the physical BTN, lowercase)
//   action: contextual meaning, e.g. 'check' for button 'shoot' without the puck
//   It may return a display label ('J', 'Space') or a KeyboardEvent.code ('KeyJ', 'ShiftLeft');
//   null / '' / a throw falls back to the default key.

import { PHASE, PSTATE, EVENT, DEFAULT_CONFIG, boardDistance } from '../shared/constants.js';

export const DEVICES = Object.freeze(['keyboard', 'gamepad', 'touch']);

export const TUNING = Object.freeze({
  duration: 4,           // s a hint stays up
  gap: 6,                // s of quiet after a hint hides before the next one may show
  cooldown: 25,          // s before the same hint may show again (default; per hint overridable)
  oneTimerWindow: 2.5,   // s after a PASS to me during which the pass counts as "on its way"
  passLag: 0.3,          // s the passer may still appear to own the puck (interpolation lag)
  moveWindow: 12,        // s after I first appear in a game during which the move hint may show
  fireWindow: 10,        // s after catching fire during which the ON FIRE hint may show
  otWindow: 15,          // s after overtime starts during which the sudden-death hint may show
  maxDt: 1,              // clamp for one update's dtSec (tab was hidden, breakpoint...)
  deke: Object.freeze({ dist: 3, cos: 0.5 }),                       // within 3 m, +-60 deg of my facing
  pass: Object.freeze({ ahead: 1.5, open: 3.5, lane: 1.2, min: 3, max: 28 }),
  check: Object.freeze({ dist: 6 }),
  glass: Object.freeze({ board: 2.5, dist: 9 }),                    // carrier <= 2.5 m from the boards
  switch: Object.freeze({ far: 12, ratio: 0.6 }),                   // I'm >= 12 m away, AI mate <= 60% of that
});

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const evType = (e) => (e && (e.type ?? e.t ?? e.e ?? e.ev)) || '';

function segDist(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}

// ---------------------------------------------------------------------------------------------
// Pure analysis of one Snapshot-shaped state from my point of view.

export function analyze(state, myId, periods = DEFAULT_CONFIG.periods) {
  const v = {
    valid: false, ph: 0, per: 0, ot: false, tick: -1, players: [],
    me: null, myPid: -1, myTm: -1,
    owner: -1, carrier: null, iCarry: false, oppCarry: false, mateCarry: false,
    puck: { x: 0, z: 0 },
  };
  if (!state || typeof state !== 'object' || !Array.isArray(state.p)) return v;
  v.valid = true;
  v.ph = num(state.ph);
  v.per = num(state.per);
  v.tick = num(state.tick);
  const nPer = Number.isFinite(periods) && periods > 0 ? periods : DEFAULT_CONFIG.periods;
  v.ot = v.per > nPer;
  state.p.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    v.players.push({
      id: Number.isInteger(p.id) ? p.id : i,
      tm: num(p.tm), g: p.g ? 1 : 0,
      x: num(p.x), z: num(p.z), f: num(p.f),
      s: num(p.s), tb: num(p.tb), fire: p.fire ? 1 : 0, c: num(p.c),
    });
  });
  if (myId) v.me = v.players.find((p) => p.c === myId && !p.g) || null;
  const k = state.k && typeof state.k === 'object' ? state.k : {};
  v.puck = { x: num(k.x), z: num(k.z) };
  v.owner = Number.isInteger(k.o) && k.o >= 0 ? k.o : -1;
  v.carrier = v.owner >= 0 ? v.players.find((p) => p.id === v.owner) || null : null;
  if (v.me) {
    v.myPid = v.me.id;
    v.myTm = v.me.tm;
    v.iCarry = v.owner === v.myPid;
    if (v.carrier && !v.iCarry) {
      v.oppCarry = v.carrier.tm !== v.myTm;
      v.mateCarry = v.carrier.tm === v.myTm;
    }
  }
  return v;
}

// --- trigger predicates (pure; take analyze() output) -----------------------------------------

/** I carry and a teammate skater is ahead of me (toward the goal I attack), within passing range,
 *  with no standing opponent skater near him or in the passing lane. Returns that teammate or null. */
export function openTeammateAhead(v, t = TUNING.pass) {
  if (!v.me || !v.iCarry) return null;
  const dir = v.myTm === 0 ? 1 : -1;           // team 0 attacks +X, team 1 attacks -X
  let best = null, bestD = Infinity;
  for (const p of v.players) {
    if (p.tm !== v.myTm || p.id === v.myPid || p.g) continue;
    if ((p.x - v.me.x) * dir < t.ahead) continue;
    const d = dist(p, v.me);
    if (d < t.min || d > t.max) continue;
    let open = true;
    for (const o of v.players) {
      if (o.tm === v.myTm || o.g || o.s === PSTATE.DOWN) continue;
      if (dist(o, p) < t.open || segDist(o, v.me, p) < t.lane) { open = false; break; }
    }
    if (open && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

/** I carry and an opponent (skater or goalie, not knocked down) is within `dist` m in front of
 *  me (inside the cone around my facing). Returns that opponent or null. */
export function opponentInFront(v, t = TUNING.deke) {
  if (!v.me || !v.iCarry) return null;
  const fx = Math.cos(v.me.f), fz = Math.sin(v.me.f);
  let best = null, bestD = Infinity;
  for (const o of v.players) {
    if (o.tm === v.myTm || o.s === PSTATE.DOWN) continue;
    const dx = o.x - v.me.x, dz = o.z - v.me.z;
    const d = Math.hypot(dx, dz);
    if (d > t.dist || d < 1e-6) continue;
    if ((dx * fx + dz * fz) / d < t.cos) continue;
    if (d < bestD) { best = o; bestD = d; }
  }
  return best;
}

/** I'm defending: an opponent carries the puck within `dist` m of me and I'm on my feet. */
export function nearOpponentCarrier(v, t = TUNING.check) {
  return !!(v.me && v.oppCarry && v.me.s !== PSTATE.DOWN && dist(v.me, v.carrier) <= t.dist);
}

/** An opponent carries the puck close to the boards and I'm close enough to line up a big hit. */
export function carrierNearBoards(v, t = TUNING.glass) {
  if (!v.me || !v.oppCarry || v.me.s === PSTATE.DOWN) return false;
  if (dist(v.me, v.carrier) > t.dist) return false;
  return boardDistance(v.carrier.x, v.carrier.z).d <= t.board;
}

/** Loose puck or the opponents have it, I'm far from it and an AI-controlled teammate skater is
 *  much nearer. (Not while my own team carries: then I'm a pass option, not out of the play.)
 *  Returns that teammate or null. */
export function aiTeammateNearerPuck(v, t = TUNING.switch) {
  if (!v.me || v.iCarry || v.mateCarry) return null;
  const dMe = dist(v.me, v.puck);
  if (dMe < t.far) return null;
  let best = null, bestD = dMe * t.ratio;
  for (const p of v.players) {
    if (p.tm !== v.myTm || p.id === v.myPid || p.g || p.c) continue;
    const d = dist(p, v.puck);
    if (d <= bestD) { best = p; bestD = d; }
  }
  return best;
}

/** A PASS to me (remembered as {at, by, to}) is still on its way: puck loose (or still shown on the
 *  passer's stick for a few frames of interpolation lag) and the pass is recent. */
export function passIncoming(pass, v, now, T = TUNING) {
  if (!pass || !v.me || pass.to !== v.myPid) return false;
  const age = now - pass.at;
  if (age < 0 || age > T.oneTimerWindow) return false;
  if (v.owner === -1) return true;
  return v.owner === pass.by && age <= T.passLag;
}

// ---------------------------------------------------------------------------------------------
// Hint definitions. want/stale: (v, mem, now, T) -> bool; done: (acts:Set) -> bool.
//   max       : lifetime show limit (persisted)
//   perGame   : at most once per game
//   learn     : performing `done` while visible retires the hint (default true)
//   phases    : phases in which the hint may be (and stay) visible

const { FACEOFF, PLAY, GOAL } = PHASE;

export const HINTS = Object.freeze({
  onetimer: {
    max: 3, cooldown: 4, phases: [PLAY], urgent: true,
    want: (v, m, now, T) => !v.iCarry && passIncoming(m.pass, v, now, T),
    stale: (v, m, now, T) => !passIncoming(m.pass, v, now, T),
    done: (a) => a.has('shot'),
  },
  overtime: {
    max: 2, perGame: true, learn: false, phases: [FACEOFF, PLAY],
    want: (v, m, now, T) => v.ot && m.game.otAt != null && now - m.game.otAt <= T.otWindow,
    done: (a) => a.has('goal'),
  },
  fire: {
    max: 2, learn: false, phases: [GOAL, FACEOFF, PLAY],
    want: (v, m, now, T) => !!v.me.fire && m.fireAt != null && now - m.fireAt <= T.fireWindow,
    stale: (v) => !v.me.fire,
    done: () => false,
  },
  move: {
    max: 2, perGame: true, phases: [FACEOFF, PLAY],
    want: (v, m, now, T) => m.game.meAt != null && now - m.game.meAt <= T.moveWindow,
    done: (a) => a.has('turbo'),
  },
  shoot: {
    max: 3, perGame: true, phases: [PLAY],
    want: (v) => v.iCarry,
    stale: (v) => !v.iCarry,
    done: (a) => a.has('shot'),
  },
  deke: {
    max: 3, phases: [PLAY],
    want: (v, m, now, T) => !!opponentInFront(v, T.deke),
    stale: (v) => !v.iCarry,
    done: (a) => a.has('deke'),
  },
  pass: {
    max: 3, phases: [PLAY],
    want: (v, m, now, T) => !!openTeammateAhead(v, T.pass),
    stale: (v) => !v.iCarry,
    done: (a) => a.has('pass'),
  },
  check: {
    max: 3, phases: [PLAY],
    want: (v, m, now, T) => nearOpponentCarrier(v, T.check),
    stale: (v) => !v.oppCarry,
    done: (a) => a.has('check') || a.has('hit') || a.has('steal'),
  },
  glass: {
    max: 3, phases: [PLAY],
    want: (v, m, now, T) => carrierNearBoards(v, T.glass),
    stale: (v) => !v.oppCarry,
    done: (a) => a.has('bigHit') || a.has('glass'),
  },
  switch: {
    max: 3, phases: [PLAY],
    want: (v, m, now, T) => !!aiTeammateNearerPuck(v, T.switch),
    stale: (v) => v.iCarry || v.mateCarry,
    done: (a) => a.has('switch'),
  },
});

/** Priority when several hints want to show in the same frame (onetimer always first). */
export const HINT_ORDER = Object.freeze(['onetimer', 'overtime', 'fire', 'move', 'shoot', 'deke', 'pass', 'check', 'glass', 'switch']);

// ---------------------------------------------------------------------------------------------
// Persistence: { v:1, n:{hintId: timesShown}, done:{hintId: 1} }. Every storage access is guarded,
// so a missing / full / throwing / corrupt storage just means "remember in memory only".

function safeLocalStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function createStore(storage, key) {
  const fresh = () => ({ v: 1, n: {}, done: {} });
  let data = fresh();
  try {
    const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(key) : null;
    const d = raw ? JSON.parse(raw) : null;
    if (d && typeof d === 'object') {
      if (d.n && typeof d.n === 'object') {
        for (const id of Object.keys(d.n)) {
          const c = d.n[id];
          if (typeof c === 'number' && Number.isFinite(c) && c > 0) data.n[id] = Math.floor(c);
        }
      }
      if (d.done && typeof d.done === 'object') for (const id of Object.keys(d.done)) if (d.done[id]) data.done[id] = 1;
    }
  } catch { data = fresh(); }
  const save = () => {
    try { if (storage && typeof storage.setItem === 'function') storage.setItem(key, JSON.stringify(data)); } catch { /* memory only */ }
  };
  return {
    count: (id) => data.n[id] || 0,
    learned: (id) => !!data.done[id],
    bump(id) { data.n[id] = (data.n[id] || 0) + 1; save(); },
    learn(id) { data.done[id] = 1; save(); },
    clear() {
      data = fresh();
      try { if (storage && typeof storage.removeItem === 'function') storage.removeItem(key); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The DOM-free state machine. createTutorial() wraps it with the view.

const freshGame = () => ({ meAt: null, otAt: null, shown: {} });
const freshMem = () => ({
  game: null, prevTick: -1, prevPh: 0, prevPid: -1, prevTb: null, prevFire: 0, prevS: -1,
  pass: null, fireAt: null,
});

export function createTutorialCore({
  storage = null, storageKey = 'iceRiot.tutorial', tuning = null, onShow = null, onHide = null,
} = {}) {
  const T = tuning ? { ...TUNING, ...tuning } : TUNING;
  const store = createStore(storage, storageKey);
  let enabled = true;
  let now = 0;
  let vis = null;                 // { id, at, dur }
  let lastHideAt = -Infinity;
  let lastShownAt = {};
  let m = freshMem();

  const call = (fn, ...args) => { if (typeof fn === 'function') { try { fn(...args); } catch (e) { console.error('[tutorial]', e); } } };

  function hide(reason) {
    if (!vis) return;
    const id = vis.id;
    if (reason === 'done' && HINTS[id].learn !== false) store.learn(id);
    if (id === 'onetimer') m.pass = null;
    vis = null;
    lastHideAt = now;
    call(onHide, id, reason);
  }

  function show(id) {
    const def = HINTS[id];
    vis = { id, at: now, dur: id === 'onetimer' ? T.oneTimerWindow : T.duration };
    lastShownAt[id] = now;
    store.bump(id);
    if (def.perGame && m.game) m.game.shown[id] = true;
    if (id === 'fire') m.fireAt = null;
    call(onShow, id);
  }

  function eligible(id, v) {
    const def = HINTS[id];
    if (!def.phases.includes(v.ph)) return false;
    if (store.learned(id) || store.count(id) >= def.max) return false;
    if (now - (lastShownAt[id] ?? -Infinity) < (def.cooldown ?? T.cooldown)) return false;
    if (def.perGame && m.game && m.game.shown[id]) return false;
    return true;
  }

  function readActs(v, events, myId) {
    const a = new Set();
    const me = v.myPid;
    if (!Array.isArray(events)) return a;
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      switch (evType(e)) {
        case EVENT.SHOT:
          if (me >= 0 && e.by === me) { a.add('shot'); m.pass = null; }
          break;
        case EVENT.PASS:
          if (me >= 0 && e.by === me) a.add('pass');
          if (me >= 0 && e.to === me && e.by !== me) m.pass = { at: now, by: Number.isInteger(e.by) ? e.by : -1, to: me };
          else m.pass = null;                       // a newer pass went somewhere else
          break;
        case EVENT.DEKE: if (me >= 0 && e.by === me) a.add('deke'); break;
        case EVENT.HIT: if (me >= 0 && e.by === me) { a.add('hit'); if (e.big) a.add('bigHit'); } break;
        case EVENT.GLASS: if (me >= 0 && e.by === me) a.add('glass'); break;
        case EVENT.STEAL: if (me >= 0 && e.by === me) a.add('steal'); break;
        case EVENT.SWITCH: if (myId && e.client === myId) a.add('switch'); break;
        case EVENT.FIRE: if (me >= 0 && e.player === me) m.fireAt = e.on ? now : null; break;
        case EVENT.GOAL: a.add('goal'); break;
        default: break;
      }
    }
    // edges from my own player's state (only when I'm still the same skater as last frame)
    if (v.me && v.myPid === m.prevPid) {
      if (m.prevTb != null && v.me.tb < m.prevTb - 0.003) a.add('turbo');
      if (v.me.fire && !m.prevFire && m.fireAt == null) m.fireAt = now;
      if (v.me.s !== m.prevS) {
        if (v.me.s === PSTATE.CHECK || v.me.s === PSTATE.POKE) a.add('check');
        if (v.me.s === PSTATE.DEKE) a.add('deke');
      }
    }
    return a;
  }

  function update(state, events, ctx, dtSec) {
    if (!enabled) return null;
    const dt = num(dtSec);
    now += dt < 0 ? 0 : dt > T.maxDt ? T.maxDt : dt;
    const myId = ctx && ctx.myId ? ctx.myId : 0;
    const v = analyze(state, myId, ctx && ctx.periods);
    if (!v.valid) {
      hide('stale');
      m.prevPid = -1;
      return null;
    }

    // new game: first state, tick went backwards, or a fresh game after GAME_OVER
    if (!m.game || (m.prevTick >= 0 && v.tick + 30 < m.prevTick) || (m.prevPh === PHASE.GAME_OVER && v.ph !== PHASE.GAME_OVER)) {
      m.game = freshGame();
      m.pass = null;
      m.fireAt = null;
    }
    const live = v.ph === FACEOFF || v.ph === PLAY;
    if (v.me && live && m.game.meAt == null) m.game.meAt = now;
    if (v.ot && live && m.game.otAt == null) m.game.otAt = now;

    const acts = readActs(v, events, myId);

    // the visible hint: done / timed out / no longer relevant?
    if (vis) {
      const def = HINTS[vis.id];
      if (!v.me) hide('stale');
      else if (def.done(acts, v)) hide('done');
      else if (now - vis.at >= vis.dur) hide('timeout');
      else if (!def.phases.includes(v.ph) || (def.stale && def.stale(v, m, now, T))) hide('stale');
    }

    // pick the next hint
    if (v.me) {
      if ((!vis || vis.id !== 'onetimer') && eligible('onetimer', v) && HINTS.onetimer.want(v, m, now, T)) {
        hide('preempt');
        show('onetimer');
      } else if (!vis && now - lastHideAt >= T.gap) {
        for (const id of HINT_ORDER) {
          if (id === 'onetimer') continue;
          if (eligible(id, v) && HINTS[id].want(v, m, now, T)) { show(id); break; }
        }
      }
    }

    // remember for edge detection
    m.prevTick = v.tick;
    m.prevPh = v.ph;
    m.prevPid = v.myPid;
    m.prevTb = v.me ? v.me.tb : null;
    m.prevFire = v.me ? v.me.fire : 0;
    m.prevS = v.me ? v.me.s : -1;
    if (m.pass && !passIncoming(m.pass, v, now, T)) m.pass = null;
    if (!v.me || !v.me.fire) m.fireAt = null;
    return vis ? vis.id : null;
  }

  return {
    update,
    setEnabled(on) {
      on = !!on;
      if (on === enabled) return;
      if (!on) hide('disabled');
      enabled = on;
      if (on) { m.prevPid = -1; m.pass = null; m.fireAt = null; } // no edges across the disabled gap
    },
    reset() {
      hide('reset');
      store.clear();
      m = freshMem();
      lastShownAt = {};
      lastHideAt = -Infinity;
    },
    get visible() { return vis ? vis.id : null; },
    get enabled() { return enabled; },
    get time() { return now; },
    count: (id) => store.count(id),
    learned: (id) => store.learned(id),
  };
}

// ---------------------------------------------------------------------------------------------
// Hint content + key-cap glyph markup (pure strings, so Node can test them too).

// contextual action -> physical button
const ACTION_BUTTON = { move: 'move', shoot: 'shoot', check: 'shoot', pass: 'pass', switch: 'pass', deke: 'action', poke: 'action', turbo: 'turbo' };
const KEYBOARD = { shoot: 'J', pass: 'K', action: 'L', turbo: 'SHIFT' };
const GAMEPAD = { shoot: ['a', 'A'], pass: ['x', 'X'], action: ['b', 'B'], turbo: ['rb', 'RB'] };
// touch buttons relabel by context (see touch.js): SHOOT/CHECK, PASS/SWITCH, DEKE/POKE, TURBO
const TOUCH_TEXT = { shoot: 'SHOOT', check: 'CHECK', pass: 'PASS', switch: 'SWITCH', deke: 'DEKE', poke: 'POKE', turbo: 'TURBO' };
const TOUCH_CLASS = { shoot: 'shoot', pass: 'pass', action: 'deke', turbo: 'turbo' };

const CONTENT = {
  move: {
    title: 'HIT THE ICE',
    items: [
      { keys: ['move'], label: { default: 'SKATE', touch: 'DRAG TO SKATE' } },
      { keys: ['turbo'], label: 'HOLD · TURBO' },
    ],
  },
  shoot: {
    title: "PUCK'S YOURS",
    items: [{ keys: ['shoot'], label: 'TAP · WRIST SHOT', sub: 'HOLD + RELEASE · SLAPSHOT' }],
  },
  pass: { title: 'TEAMMATE OPEN', items: [{ keys: ['pass'], label: 'PASS IT' }] },
  deke: { title: 'DEFENDER AHEAD', items: [{ keys: ['deke'], label: 'DEKE AROUND', sub: 'BEATS STICK CHECKS' }] },
  onetimer: {
    title: 'ONE-TIMER!', urgent: true,
    items: [{ keys: ['shoot'], big: true, label: 'SHOOT NOW', sub: 'HIT IT AS THE PASS ARRIVES' }],
  },
  check: {
    title: 'STOP THE CARRIER',
    items: [
      { keys: ['check'], label: 'CHECK' },
      { keys: ['turbo', 'check'], label: 'BIG HIT' },
      { keys: ['poke'], label: 'POKE' },
    ],
  },
  glass: {
    title: 'CARRIER ON THE BOARDS',
    items: [{ keys: ['turbo', 'check'], label: 'BIG HIT', sub: 'SHATTER THE GLASS!' }],
  },
  switch: { title: 'TOO FAR AWAY', items: [{ keys: ['switch'], label: 'SWITCH PLAYER', sub: 'TO THE TEAMMATE NEAR THE PUCK' }] },
  fire: { title: "YOU'RE ON FIRE!", hot: true, note: 'SUPERCHARGED SHOTS & HITS · KEEP THE STREAK ALIVE' },
  overtime: { title: 'SUDDEN DEATH', hot: true, note: 'OVERTIME · NEXT GOAL WINS' },
};

export const HINT_IDS = Object.freeze(Object.keys(CONTENT));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const normDevice = (d) => (DEVICES.includes(d) ? d : 'keyboard');
const pick = (label, device) => (label && typeof label === 'object' ? label[device] ?? label.default : label) || '';

const CODE_NAMES = {
  Space: 'SPACE', ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL', ControlRight: 'CTRL',
  AltLeft: 'ALT', AltRight: 'ALT', Enter: 'ENTER', Tab: 'TAB', Backspace: 'BKSP', Escape: 'ESC',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', CapsLock: 'CAPS',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
};

/** 'KeyJ' -> 'J', 'Digit1' -> '1', 'ShiftLeft' -> 'SHIFT', 'Numpad5' -> 'NUM 5', 'space' -> 'SPACE'. */
export function prettyKey(label) {
  const s = String(label).trim();
  if (CODE_NAMES[s]) return CODE_NAMES[s];
  let mt = /^Key([A-Z])$/.exec(s);
  if (mt) return mt[1];
  mt = /^Digit(\d)$/.exec(s);
  if (mt) return mt[1];
  mt = /^Numpad(\w+)$/.exec(s);
  if (mt) return 'NUM ' + mt[1].toUpperCase();
  return s.toUpperCase();
}

function customKey(keyLabel, button, action) {
  if (typeof keyLabel !== 'function') return null;
  try {
    const r = keyLabel(button, action);
    if (r == null) return null;
    const s = prettyKey(r);
    return s ? s.slice(0, 12) : null;
  } catch { return null; }
}

function keyCap(label) {
  const wide = [...label].length > 1;
  return `<span class="ir-tut-key${wide ? ' ir-tut-wide' : ''}"><b>${esc(label)}</b></span>`;
}

const WASD = '<span class="ir-tut-wasd">' +
  '<span class="ir-tut-key ir-tut-w"><b>W</b></span><span class="ir-tut-key"><b>A</b></span>' +
  '<span class="ir-tut-key"><b>S</b></span><span class="ir-tut-key"><b>D</b></span></span>';

/** Markup of one button glyph for a contextual action on a device. */
export function glyphHTML(action, device = 'keyboard', keyLabel = null) {
  const dev = normDevice(device);
  const btn = ACTION_BUTTON[action] || 'shoot';
  if (dev === 'gamepad') {
    if (btn === 'move') return '<span class="ir-tut-stick"><i>L</i></span>';
    if (btn === 'turbo') return '<span class="ir-tut-bumper">RB</span>';
    const [cls, txt] = GAMEPAD[btn];
    return `<span class="ir-tut-pad ir-tut-pad-${cls}">${txt}</span>`;
  }
  if (dev === 'touch') {
    if (btn === 'move') return '<span class="ir-tut-joy"><i></i></span>';
    return `<span class="ir-tut-tbtn ir-tut-tbtn-${TOUCH_CLASS[btn]}"><b>${TOUCH_TEXT[action] || TOUCH_TEXT[btn]}</b></span>`;
  }
  const custom = customKey(keyLabel, btn, action);
  if (btn === 'move') return custom ? keyCap(custom) : WASD;
  return keyCap(custom || KEYBOARD[btn]);
}

/** Full card markup for a hint on a device ('' for an unknown id). */
export function hintMarkup(id, device = 'keyboard', keyLabel = null) {
  const c = CONTENT[id];
  if (!c) return '';
  const dev = normDevice(device);
  const cls = ['ir-tut-card', `ir-tut-h-${id}`];
  if (c.urgent) cls.push('ir-tut-urgent');
  if (c.hot) cls.push('ir-tut-hot');
  const items = (c.items || []).map((it) => {
    const glyphs = it.keys.map((a) => glyphHTML(a, dev, keyLabel)).join('<span class="ir-tut-plus">+</span>');
    const sub = it.sub ? `<small class="ir-tut-sub">${esc(it.sub)}</small>` : '';
    return `<span class="ir-tut-item"><span class="ir-tut-glyphs${it.big ? ' ir-tut-big' : ''}">${glyphs}</span>` +
      `<span class="ir-tut-lbl">${esc(pick(it.label, dev))}${sub}</span></span>`;
  }).join('');
  return `<div class="${cls.join(' ')}"><div class="ir-tut-title">${esc(c.title)}</div>` +
    (items ? `<div class="ir-tut-row">${items}</div>` : '') +
    (c.note ? `<div class="ir-tut-note">${esc(c.note)}</div>` : '') + '</div>';
}

// ---------------------------------------------------------------------------------------------
// Style (injected once per document, ref-counted).

const STYLE_ID = 'ir-tut-style';
const FONT = '"Avenir Next Condensed", "Bahnschrift", "Roboto Condensed", "sans-serif-condensed", "Arial Narrow", "Helvetica Neue", Impact, system-ui, sans-serif';
const CAP_FONT = '"Segoe UI", "Helvetica Neue", Roboto, system-ui, sans-serif';

export const TUTORIAL_CSS = `
.ir-tut-root {
  position: absolute; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + clamp(12px, 12%, 120px));
  transform: translateX(-50%); z-index: 45; width: max-content; max-width: calc(100% - 24px);
  pointer-events: none; -webkit-user-select: none; user-select: none;
  opacity: 0; visibility: hidden; transition: opacity .22s ease, visibility 0s linear .22s;
  font-family: ${FONT}; font-stretch: 75%; font-weight: 900; font-style: italic;
  font-size: clamp(14px, 1.1vw + 8px, 22px); line-height: 1.1; color: #fff;
  text-transform: uppercase; letter-spacing: .03em; text-align: center;
}
.ir-tut-root * { box-sizing: border-box; }
.ir-tut-root.ir-tut-fixed { position: fixed; max-width: calc(100vw - 24px); }
.ir-tut-root.ir-tut-on { opacity: 1; visibility: visible; transition: opacity .1s ease; }
.ir-tut-root.ir-tut-dev-touch { bottom: calc(env(safe-area-inset-bottom, 0px) + clamp(12px, 34%, 280px)); }
.ir-tut-card {
  position: relative; display: inline-flex; flex-direction: column; align-items: center; gap: .42em;
  max-width: 100%; padding: .5em 1.1em .65em; border-radius: .45em;
  background: linear-gradient(180deg, rgba(22,28,52,.94), rgba(6,8,18,.93));
  border: .14em solid #ffd400;
  box-shadow: 0 .25em 0 rgba(0,0,0,.55), 0 0 1.4em rgba(255,212,0,.28), inset 0 0 0 .08em rgba(255,255,255,.06);
  animation: ir-tut-pop .3s cubic-bezier(.18,1.5,.4,1) both;
}
.ir-tut-title {
  font-size: 1.4em; line-height: 1; color: #ffd400; letter-spacing: .05em;
  text-shadow: .05em .07em 0 #c1121f, 0 0 .45em rgba(255,212,0,.45);
}
.ir-tut-row { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: .45em 1.1em; }
.ir-tut-item { display: inline-flex; align-items: center; gap: .45em; }
.ir-tut-glyphs { display: inline-flex; align-items: center; gap: .2em; font-style: normal; flex: none; }
.ir-tut-plus { font-size: 1.05em; color: #ffd400; padding: 0 .05em; font-style: normal; }
.ir-tut-lbl { display: inline-flex; flex-direction: column; align-items: flex-start; text-align: left; line-height: 1.02; }
.ir-tut-sub { font-size: .68em; color: #bcd0ff; letter-spacing: .06em; margin-top: .18em; }
.ir-tut-note { font-size: .82em; color: #ffe7a3; letter-spacing: .05em; max-width: 24em; }

.ir-tut-key {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.85em; height: 1.85em; padding: 0 .3em; border-radius: .3em;
  font: normal 900 .9em/1 ${CAP_FONT}; letter-spacing: 0; color: #151821;
  background: linear-gradient(180deg, #fff 0%, #e6e9f0 55%, #c3c8d4 100%);
  border: .07em solid #7d8496; border-bottom: .24em solid #636a7d;
  box-shadow: 0 .1em .25em rgba(0,0,0,.55);
}
.ir-tut-key b { font-weight: 900; }
.ir-tut-key.ir-tut-wide { min-width: 3.1em; padding: 0 .45em; }
.ir-tut-key.ir-tut-wide b { font-size: .68em; letter-spacing: .04em; }
.ir-tut-wasd { display: inline-grid; grid-template-columns: repeat(3, auto); gap: .12em; font-size: .62em; }
.ir-tut-wasd .ir-tut-key { min-width: 1.85em; }
.ir-tut-wasd .ir-tut-w { grid-column: 2; grid-row: 1; }
.ir-tut-wasd .ir-tut-key:not(.ir-tut-w) { grid-row: 2; }

.ir-tut-pad {
  display: inline-flex; align-items: center; justify-content: center; width: 1.9em; height: 1.9em;
  border-radius: 50%; font: normal 900 1em/1 ${CAP_FONT}; color: #fff; text-shadow: 0 .06em 0 rgba(0,0,0,.45);
  border: .09em solid rgba(0,0,0,.45);
  box-shadow: inset 0 -.14em 0 rgba(0,0,0,.28), inset 0 .1em 0 rgba(255,255,255,.35), 0 .1em .28em rgba(0,0,0,.6);
}
.ir-tut-pad-a { background: radial-gradient(circle at 38% 30%, #8af59a, #1fa443 62%, #167a31); }
.ir-tut-pad-b { background: radial-gradient(circle at 38% 30%, #ff9a8f, #e0362c 62%, #a51f17); }
.ir-tut-pad-x { background: radial-gradient(circle at 38% 30%, #93c2ff, #2a6ee8 62%, #1a4cb0); }
.ir-tut-bumper {
  display: inline-flex; align-items: center; justify-content: center; min-width: 2.7em; height: 1.6em; padding: 0 .45em;
  border-radius: .8em .8em .32em .32em; font: normal 900 .8em/1 ${CAP_FONT}; color: #fff;
  background: linear-gradient(180deg, #6b7385, #2b303c); border: .08em solid #0b0d12;
  box-shadow: inset 0 .1em 0 rgba(255,255,255,.25), 0 .1em .28em rgba(0,0,0,.6);
}
.ir-tut-stick {
  display: inline-flex; align-items: center; justify-content: center; width: 2em; height: 2em; border-radius: 50%;
  background: radial-gradient(circle, #2a2f3b 0 58%, #11141b 60%); border: .09em solid #8f98ad;
  box-shadow: 0 .1em .28em rgba(0,0,0,.6);
}
.ir-tut-stick i {
  display: inline-flex; align-items: center; justify-content: center; width: 2em; height: 2em; border-radius: 50%;
  font: normal 900 .6em/1 ${CAP_FONT}; color: #fff; background: radial-gradient(circle at 40% 35%, #b4bccd, #555d71);
  box-shadow: 0 .12em .25em rgba(0,0,0,.6);
}
.ir-tut-joy {
  position: relative; display: inline-block; width: 2.1em; height: 2.1em; border-radius: 50%;
  border: .14em solid rgba(255,255,255,.85); background: rgba(255,255,255,.1); box-shadow: 0 0 0 .1em rgba(0,0,0,.45);
}
.ir-tut-joy i {
  position: absolute; left: 50%; top: 50%; width: .95em; height: .95em; margin: -.475em 0 0 -.475em; border-radius: 50%;
  background: #fff; box-shadow: 0 .08em .2em rgba(0,0,0,.6); transform: translate(.3em, -.3em);
}
.ir-tut-tbtn {
  display: inline-flex; align-items: center; justify-content: center; width: 2.7em; height: 2.7em; border-radius: 50%;
  color: #fff; background: rgba(var(--acc), .22); border: .17em solid rgb(var(--acc));
  box-shadow: 0 0 0 .1em rgba(0,0,0,.5), 0 0 .7em rgba(var(--acc), .5);
  text-shadow: 0 .08em 0 rgba(0,0,0,.8);
}
.ir-tut-tbtn b { font-size: .58em; font-weight: 900; font-style: italic; letter-spacing: .01em; }
.ir-tut-tbtn-shoot { --acc: 255,72,92; }
.ir-tut-tbtn-pass { --acc: 56,214,255; }
.ir-tut-tbtn-deke { --acc: 255,201,60; }
.ir-tut-tbtn-turbo { --acc: 186,128,255; }

.ir-tut-big { font-size: 2em; animation: ir-tut-pulse .5s ease-in-out infinite alternate; }
.ir-tut-urgent {
  padding: .55em 1.4em .75em; border-color: #ff3d2e;
  background: linear-gradient(180deg, rgba(96,10,16,.95), rgba(30,4,8,.94));
  box-shadow: 0 .25em 0 rgba(0,0,0,.55), 0 0 1.8em rgba(255,61,46,.6);
}
.ir-tut-urgent .ir-tut-title { font-size: 2em; color: #fff; text-shadow: .05em .07em 0 #ff3d2e, 0 0 .5em rgba(255,120,60,.85); }
.ir-tut-urgent .ir-tut-row { gap: .5em .9em; }
.ir-tut-urgent .ir-tut-lbl { font-size: 1.3em; }
.ir-tut-hot { border-color: #ff7a00; background: linear-gradient(180deg, rgba(112,32,0,.95), rgba(40,8,0,.93)); box-shadow: 0 .25em 0 rgba(0,0,0,.55), 0 0 1.6em rgba(255,110,0,.55); }
.ir-tut-hot .ir-tut-title { font-size: 1.7em; color: #ffcf3a; text-shadow: .05em .07em 0 #c1121f, 0 0 .6em rgba(255,120,0,.9); }

@keyframes ir-tut-pop { from { opacity: 0; transform: translateY(.7em) scale(.8); } to { opacity: 1; transform: none; } }
@keyframes ir-tut-pulse { from { transform: scale(1); } to { transform: scale(1.14); } }
@media (max-width: 520px) {
  .ir-tut-root { font-size: 14px; }
  .ir-tut-card { padding: .45em .8em .55em; }
  .ir-tut-row { gap: .35em .8em; }
}
@media (prefers-reduced-motion: reduce) {
  .ir-tut-card, .ir-tut-big { animation: none !important; }
  .ir-tut-root, .ir-tut-root.ir-tut-on { transition: none !important; }
}
`;

const styleRefs = new WeakMap();   // document -> ref count

/** Inject the tutorial stylesheet into `doc` (idempotent). Returns the <style> element. */
export function injectTutorialStyle(doc = globalThis.document) {
  let el = doc.getElementById(STYLE_ID);
  if (!el) {
    el = doc.createElement('style');
    el.id = STYLE_ID;
    el.textContent = TUTORIAL_CSS;
    (doc.head || doc.documentElement).appendChild(el);
  }
  return el;
}

function acquireStyle(doc) {
  injectTutorialStyle(doc);
  styleRefs.set(doc, (styleRefs.get(doc) || 0) + 1);
}

function releaseStyle(doc) {
  const n = (styleRefs.get(doc) || 0) - 1;
  styleRefs.set(doc, Math.max(0, n));
  if (n <= 0) { const el = doc.getElementById(STYLE_ID); if (el) el.remove(); }
}

function createView(container) {
  const doc = container.ownerDocument || globalThis.document;
  let root = null;
  let device = 'keyboard', hint = null, on = false;

  function classes() {
    if (!root) return;
    const fixed = container === doc.body || container === doc.documentElement;
    root.className = 'ir-tut-root' + (fixed ? ' ir-tut-fixed' : '') + ` ir-tut-dev-${device}` + (on ? ' ir-tut-on' : '');
  }
  function ensure() {
    if (root) return;
    acquireStyle(doc);
    root = doc.createElement('div');
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-atomic', 'true');
    container.appendChild(root);
  }
  return {
    show(id, dev, keyLabel) {
      ensure();
      hint = id; device = dev; on = true;
      root.innerHTML = hintMarkup(id, dev, keyLabel);
      root.dataset.hint = id;
      classes();
    },
    hide() {
      on = false;
      if (root) { root.dataset.hint = ''; classes(); }
    },
    refresh(dev, keyLabel) {
      device = dev;
      if (!root) return;
      if (on && hint) root.innerHTML = hintMarkup(hint, dev, keyLabel);
      classes();
    },
    dispose() {
      if (!root) return;
      root.remove();
      root = null;
      releaseStyle(doc);
    },
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {object} [o]
 * @param {Element|null} [o.container]  element the prompt is appended to (positioned; document.body => fixed).
 *                                      null => logic only, no DOM.
 * @param {Storage|null} [o.storage]    where show counts persist (default localStorage; null => memory only)
 * @param {string} [o.storageKey]
 * @param {'keyboard'|'gamepad'|'touch'} [o.device]
 * @param {(button:string, action:string)=>string|null} [o.keyLabel]  keyboard labels for rebound keys
 * @returns {{update(state:object|null, events:object[], ctx:{myId:number}, dtSec:number): (string|null),
 *            setDevice(device:string): void, setEnabled(on:boolean): void, reset(): void, dispose(): void}}
 *          update() returns the id of the hint on screen (or null).
 */
export function createTutorial({
  container = null, storage = safeLocalStorage(), storageKey = 'iceRiot.tutorial', device = 'keyboard', keyLabel = null,
} = {}) {
  let dev = normDevice(device);
  let view = null;
  let disposed = false;
  const label = typeof keyLabel === 'function' ? keyLabel : null;
  const guard = (fn) => { try { fn(); } catch (e) { console.error('[tutorial] view', e); } };

  const core = createTutorialCore({
    storage, storageKey,
    onShow(id) {
      if (!container) return;
      guard(() => { view ||= createView(container); view.show(id, dev, label); });
    },
    onHide() { if (view) guard(() => view.hide()); },
  });

  return {
    update(state, events, ctx, dtSec) {
      if (disposed) return null;
      return core.update(state, events, ctx, dtSec);
    },
    setDevice(d) {
      if (!DEVICES.includes(d) || d === dev) return;
      dev = d;
      if (view) guard(() => view.refresh(dev, label));
    },
    setEnabled(on) { if (!disposed) core.setEnabled(on); },
    reset() { if (!disposed) core.reset(); },
    dispose() {
      if (disposed) return;
      core.setEnabled(false);
      disposed = true;
      if (view) guard(() => view.dispose());
      view = null;
    },
  };
}
