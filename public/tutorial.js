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
// `keyLabel(button, action)` (optional, keyboard only) returns the primary binding of a button.
//   button: 'move' | 'shoot' | 'pass' | 'action' | 'turbo'   (the physical BTN, lowercase)
//   action: contextual meaning, e.g. 'check' for button 'shoot' without the puck
//   It may return a KeyboardEvent.code ('KeyJ', 'ShiftLeft'), a mouse code ('Mouse0' left,
//   'Mouse1' middle, 'Mouse2' right) or a display label ('J', 'Space', 'Left click');
//   null / '' / a throw falls back to the default binding (Mouse0 / Mouse2 / KeyL / ShiftLeft).
//   Mouse buttons draw a mouse glyph with that button filled, everything else an ice keycap.
//
// Look: the hint cards of the Coqui "Final · in game" page (tutorial hint, one-timer hint ·
// urgent), built on the design tokens of public/style.css (var(--name, fallback) throughout).
// Bottom-centre, 56px above the bottom edge (top-centre under the scoreboard on touch, where the
// thumbs and on-screen buttons own the bottom of the screen; a compact top-right card on a phone
// held sideways, clear of the far boards' head tags).

import { PHASE, PSTATE, EVENT, DEFAULT_CONFIG, boardDistance } from '../shared/constants.js';

export const DEVICES = Object.freeze(['keyboard', 'gamepad', 'touch']);

export const TUNING = Object.freeze({
  duration: 4,           // s a hint stays up
  gap: 6,                // s of quiet after a hint hides before the next one may show
  cooldown: 25,          // s before the same hint may show again (default; per hint overridable)
  oneTimerWindow: 2.5,   // s after a PASS to me during which the pass counts as "on its way"
  passLag: 0.3,          // s the passer may still appear to own the puck (interpolation lag)
  moveWindow: 12,        // s after I first appear in a game during which the move hint may show
  fireWindow: 10,        // s after catching fire during which the on-fire hint may show
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
// Hint content + glyph markup (pure strings, so Node can test them too).
//
// Three card kinds, ported from the Coqui frames ("Final · in game"):
//   normal  "HUD · play" / tutorial hint: 52px plate, 15px bold title left, glyph + label pairs right
//   urgent  "HUD · chat open ..." / one-timer hint · urgent: goal-red tint, 48px key tile,
//           "Shoot now" (italic) over "One-timer: hit it as the pass arrives"
//   hot     glyph + title + note on a tinted plate: fire for "You're on fire", amber (warn) for
//           overtime, the colours the callout kit uses for those two moments

// contextual action -> physical button
const ACTION_BUTTON = { move: 'move', shoot: 'shoot', check: 'shoot', pass: 'pass', switch: 'pass', deke: 'action', poke: 'action', turbo: 'turbo' };
// default primary bindings (same as settings.js DEFAULTS.keys[button][0])
const KEYBOARD = { shoot: 'Mouse0', pass: 'Mouse2', action: 'KeyL', turbo: 'ShiftLeft' };
const GAMEPAD = { shoot: ['a', 'A'], pass: ['x', 'X'], action: ['b', 'B'] };
// touch buttons relabel by context (see touch.js): Shoot/Check, Pass/Switch, Deke/Poke, Turbo
const TOUCH_TEXT = { shoot: 'Shoot', check: 'Check', pass: 'Pass', switch: 'Switch', deke: 'Deke', poke: 'Poke', turbo: 'Turbo' };
const TOUCH_CLASS = { shoot: 'shoot', pass: 'pass', action: 'deke', turbo: 'turbo' };

const CONTENT = {
  move: {
    title: 'Hit the ice',
    items: [
      { keys: ['move'], label: { default: 'Skate', touch: 'Drag to skate' } },
      { keys: ['turbo'], label: 'Hold for turbo' },
    ],
  },
  shoot: {
    title: "Puck's yours",
    items: [{ keys: ['shoot'], label: 'Tap to wrist' }, { keys: ['shoot'], label: 'Hold to slap' }],
  },
  pass: { title: 'Teammate open', items: [{ keys: ['pass'], label: 'Pass it' }] },
  deke: { title: 'Defender ahead', items: [{ keys: ['deke'], label: 'Deke around him' }] },
  onetimer: { kind: 'urgent', key: 'shoot', title: 'Shoot now', note: 'One-timer: hit it as the pass arrives' },
  check: {
    title: 'Stop the carrier',
    items: [
      { keys: ['check'], label: 'Check' },
      { keys: ['turbo', 'check'], label: 'Big hit' },
      { keys: ['poke'], label: 'Poke' },
    ],
  },
  glass: { title: 'Carrier on the boards', items: [{ keys: ['turbo', 'check'], label: 'Big hit into the glass' }] },
  switch: { title: 'Too far away', items: [{ keys: ['switch'], label: 'Switch skater' }] },
  fire: { kind: 'hot', icon: 'flame', title: "You're on fire", note: 'Shots and hits land harder' },
  overtime: { kind: 'hot', tone: 'warn', icon: 'clock', title: 'Sudden death', note: 'Overtime · next goal wins' },
};

export const HINT_IDS = Object.freeze(Object.keys(CONTENT));

/** 'normal' | 'urgent' | 'hot' for a hint id (the root carries it as .ir-tut-k-<kind>). */
export function hintKind(id) {
  const c = CONTENT[id];
  return c && c.kind ? c.kind : 'normal';
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const normDevice = (d) => (DEVICES.includes(d) ? d : 'keyboard');
const pick = (label, device) => (label && typeof label === 'object' ? label[device] ?? label.default : label) || '';

// Labels match settings.js keyLabel(code) (contract: "Left click", "Space", "L-Shift", arrow glyphs).
const CODE_NAMES = {
  Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
  AltLeft: 'L-Alt', AltRight: 'R-Alt', MetaLeft: 'L-Meta', MetaRight: 'R-Meta', Enter: 'Enter', Tab: 'Tab',
  Backspace: 'Bksp', Escape: 'Esc', CapsLock: 'Caps', ContextMenu: 'Menu',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', IntlBackslash: '\\',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
  Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  Mouse0: 'Left click', Mouse1: 'Middle click', Mouse2: 'Right click',
};
const MOUSE_LABEL = ['left click', 'middle click', 'right click'];

/** 'KeyJ' -> 'J', 'Digit1' -> '1', 'ShiftLeft' -> 'L-Shift', 'Numpad5' -> 'Num 5', 'Mouse0' -> 'Left click',
 *  'space' -> 'Space', 'SHIFT' -> 'Shift'. Anything else (a display label) passes through. */
export function prettyKey(label) {
  const s = String(label).trim();
  if (Object.prototype.hasOwnProperty.call(CODE_NAMES, s)) return CODE_NAMES[s];
  let mt = /^Key([A-Z])$/.exec(s);
  if (mt) return mt[1];
  mt = /^Digit(\d)$/.exec(s);
  if (mt) return mt[1];
  mt = /^Numpad(\w+)$/.exec(s);
  if (mt) return 'Num ' + mt[1];
  if (/^[a-z][a-z ]*$/.test(s) && s.length > 1) return s[0].toUpperCase() + s.slice(1);   // sentence case
  if (/^[A-Z]{3,}$/.test(s)) return s[0] + s.slice(1).toLowerCase();                     // no all-caps words
  return s;
}

/** 0 | 1 | 2 for a mouse button code ('Mouse0') or label ('Left click'), else -1. */
export function mouseButton(label) {
  const s = String(label ?? '').trim();
  const mt = /^Mouse([0-2])$/.exec(s);
  if (mt) return Number(mt[1]);
  return MOUSE_LABEL.indexOf(s.toLowerCase());
}

function customKey(keyLabel, button, action) {
  if (typeof keyLabel !== 'function') return null;
  try {
    const r = keyLabel(button, action);
    if (r == null || r === '') return null;
    return String(r).trim().slice(0, 24) || null;
  } catch { return null; }
}

// --- glyphs ----------------------------------------------------------------------------------

// Mouse: body outline + button split, the pressed button filled (on-ice ink inside an ice tile).
// Paths from the Coqui canvas mouse glyph (viewBox 0 0 12 16).
const MOUSE_FILL = [
  '<path d="M6 0.75A5.25 5.25 0 0 0 0.75 6V6.5H6Z"/>',
  '<rect x="5" y="2.6" width="2" height="3.2" rx="1"/>',
  '<path d="M6 0.75A5.25 5.25 0 0 1 11.25 6V6.5H6Z"/>',
];
function mouseSVG(btn) {
  const split = btn === 1 ? 'M0.75 6.5H11.25' : 'M6 0.75V6.5M0.75 6.5H11.25';
  return '<svg class="ir-tut-mouse-ico" viewBox="0 0 12 16" aria-hidden="true" focusable="false">' +
    '<g fill="none" stroke="currentColor" stroke-width="1.5">' +
    `<rect x="0.75" y="0.75" width="10.5" height="14.5" rx="5.25"/><path d="${split}"/></g>` +
    `<g fill="currentColor">${MOUSE_FILL[btn]}</g></svg>`;
}
const MOUSE_SIDE = ['l', 'm', 'r'];
function mouseCap(btn) {
  return `<span class="ir-tut-key ir-tut-wide ir-tut-mouse ir-tut-mouse-${MOUSE_SIDE[btn]}">${mouseSVG(btn)}<b>${CODE_NAMES['Mouse' + btn]}</b></span>`;
}

function keyCap(label) {
  const wide = [...label].length > 1;
  return `<span class="ir-tut-key${wide ? ' ir-tut-wide' : ''}"><b>${esc(label)}</b></span>`;
}

/** Glyph for a key code / label: a mouse tile for Mouse0-2, otherwise an ice keycap. */
function codeGlyph(code) {
  const mb = mouseButton(code);
  if (mb >= 0) return mouseCap(mb);
  const s = prettyKey(code).slice(0, 12);
  return keyCap(s || '?');
}

const WASD = '<span class="ir-tut-wasd">' + ['W', 'A', 'S', 'D'].map((k) => `<span class="ir-tut-key"><b>${k}</b></span>`).join('') + '</span>';

// Flame and clock: the icons of the "On fire" and "Overtime" callouts in the Coqui callout kit.
const ICONS = {
  flame: '<svg class="ir-tut-ico-flame" viewBox="0 0 23.04 35.52" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" ' +
    'd="M11.52 0 C12.96 7.68 23.04 12 23.04 24 C23.04 30.36 17.88 35.52 11.52 35.52 C5.16 35.52 0 30.36 0 24 C0 18.72 2.88 15.36 5.52 12.96 C6 16.56 7.68 18.72 10.08 19.68 C9.12 13.68 9.12 6.72 11.52 0 Z"/></svg>',
  clock: '<svg class="ir-tut-ico-clock" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.44" stroke-linecap="round">' +
    '<circle cx="8" cy="8.8" r="5.2"/><path d="M8 6v2.8l2 1.2M6.4 2h3.2"/></g></svg>',
};

/** Markup of one button glyph for a contextual action on a device. */
export function glyphHTML(action, device = 'keyboard', keyLabel = null) {
  const dev = normDevice(device);
  const btn = ACTION_BUTTON[action] || 'shoot';
  if (dev === 'gamepad') {
    if (btn === 'move') return '<span class="ir-tut-stick">L</span>';
    if (btn === 'turbo') return '<span class="ir-tut-bumper">RB</span>';
    const [cls, txt] = GAMEPAD[btn];
    return `<span class="ir-tut-pad ir-tut-pad-${cls}">${txt}</span>`;
  }
  if (dev === 'touch') {
    if (btn === 'move') return '<span class="ir-tut-joy" role="img" aria-label="Touch stick"><i></i></span>';
    return `<span class="ir-tut-tbtn ir-tut-tbtn-${TOUCH_CLASS[btn]}"><b>${TOUCH_TEXT[action] || TOUCH_TEXT[btn]}</b></span>`;
  }
  const custom = customKey(keyLabel, btn, action);
  if (btn === 'move') return custom ? codeGlyph(custom) : WASD;
  return codeGlyph(custom || KEYBOARD[btn]);
}

/** Full card markup for a hint on a device ('' for an unknown id). */
export function hintMarkup(id, device = 'keyboard', keyLabel = null) {
  const c = CONTENT[id];
  if (!c) return '';
  const dev = normDevice(device);
  const cls = ['ir-tut-card', `ir-tut-h-${id}`];
  if (c.kind === 'urgent') {
    cls.push('ir-tut-urgent');
    return `<div class="${cls.join(' ')}"><span class="ir-tut-glyphs ir-tut-big">${glyphHTML(c.key, dev, keyLabel)}</span>` +
      `<div class="ir-tut-text"><div class="ir-tut-title">${esc(c.title)}</div><div class="ir-tut-note">${esc(c.note)}</div></div></div>`;
  }
  if (c.kind === 'hot') {
    cls.push('ir-tut-hot');
    if (c.tone) cls.push(`ir-tut-${c.tone}`);
    return `<div class="${cls.join(' ')}"><div class="ir-tut-head"><span class="ir-tut-ico">${ICONS[c.icon] || ''}</span>` +
      `<div class="ir-tut-title">${esc(c.title)}</div></div><div class="ir-tut-note">${esc(c.note)}</div></div>`;
  }
  const items = (c.items || []).map((it) => {
    const glyphs = it.keys.map((a) => glyphHTML(a, dev, keyLabel)).join('<span class="ir-tut-plus">+</span>');
    return `<span class="ir-tut-item"><span class="ir-tut-glyphs">${glyphs}</span><span class="ir-tut-lbl">${esc(pick(it.label, dev))}</span></span>`;
  }).join('');
  return `<div class="${cls.join(' ')}"><div class="ir-tut-title">${esc(c.title)}</div><div class="ir-tut-row">${items}</div></div>`;
}

// ---------------------------------------------------------------------------------------------
// Style (injected once per document, ref-counted). Colours, radii and fonts come from the design
// tokens on :root (public/style.css); every var() carries its fallback so test pages without
// style.css look the same. Plain hex fallbacks precede each color-mix() for older engines.

const STYLE_ID = 'ir-tut-style';

export const TUTORIAL_CSS = `
.ir-tut-root {
  position: absolute; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 56px);
  transform: translateX(-50%); z-index: 45; width: max-content; max-width: calc(100% - 32px);
  min-width: min(440px, calc(100% - 32px));
  pointer-events: none; -webkit-user-select: none; user-select: none;
  opacity: 0; visibility: hidden; transition: opacity 120ms ease-out, visibility 0s linear 120ms;
  font-family: var(--f-ui, Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif);
  font-size: 13px; line-height: 18px; font-weight: 400; font-style: normal;
  color: var(--ink, #E8EDF5); text-transform: none; letter-spacing: 0; text-align: left;
}
.ir-tut-root * { box-sizing: border-box; }
.ir-tut-root.ir-tut-fixed { position: fixed; }
.ir-tut-root.ir-tut-on { opacity: 1; visibility: visible; transition: opacity 180ms ease-out; }
/* the one-timer prompt sits higher, nearer the play (frame: y 620 of 900 = 202px above the bottom) */
.ir-tut-root.ir-tut-k-urgent { min-width: min(400px, calc(100% - 32px)); bottom: calc(env(safe-area-inset-bottom, 0px) + 202px); }
/* stay clear of the in-game chat feed (bottom-left, x 20..380): a wide hint wraps before it reaches it */
@media (min-width: 900px) { .ir-tut-root { max-width: calc(100% - 792px); } }
.ir-tut-root.ir-tut-dev-touch {
  bottom: auto; top: calc(env(safe-area-inset-top, 0px) + clamp(60px, 10.5%, 96px)); max-width: calc(100% - 32px);
}

.ir-tut-card {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 32px;
  width: 100%; min-height: 52px; padding: 7px 18px;
  background: rgba(10, 15, 28, .92); background: color-mix(in srgb, var(--ground, #0A0F1C) 92%, transparent);
  border: 1px solid var(--hairline-strong, #34425F); border-radius: var(--r-lg, 16px);
  animation: ir-tut-in 180ms ease-out both;
}
.ir-tut-title { font-size: 15px; line-height: 18px; font-weight: 700; color: var(--ink, #E8EDF5); white-space: nowrap; }
.ir-tut-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.ir-tut-item { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.ir-tut-glyphs { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.ir-tut-plus { font-size: 12px; line-height: 14px; font-weight: 700; color: var(--ink-3, #6A7590); }
.ir-tut-lbl, .ir-tut-note { font-size: 13px; line-height: 16px; color: var(--ink-2, #A1ACC0); }

/* keyboard: ice keycaps with on-ice ink */
.ir-tut-key {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px; flex: none;
  min-width: 24px; height: 24px; padding: 0 7px; border-radius: var(--r-sm, 6px);
  background: var(--ice, #DCEAF6); color: var(--on-ice, #0A0F1C);
  font-size: 12px; line-height: 14px; font-weight: 700; white-space: nowrap;
}
.ir-tut-key b { font-weight: 700; }
.ir-tut-wasd { display: inline-flex; gap: 3px; }
.ir-tut-mouse { padding: 0 8px 0 7px; }
.ir-tut-mouse-ico { display: block; width: 12px; height: 16px; flex: none; }

/* gamepad: neutral circles, stick outline, RB pill (as in the settings sheet) */
.ir-tut-pad, .ir-tut-stick {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 26px; height: 26px; border-radius: 50%;
  font-size: 11px; line-height: 13px; font-weight: 700; color: var(--ink, #E8EDF5);
}
.ir-tut-pad { background: var(--surface-3, #1E2940); }
.ir-tut-stick { border: 1px solid var(--hairline-strong, #34425F); }
.ir-tut-bumper {
  display: inline-flex; align-items: center; height: 24px; padding: 0 6px; flex: none;
  border-radius: var(--r-sm, 6px); background: var(--surface-3, #1E2940); color: var(--ink, #E8EDF5);
  font-size: 11px; line-height: 13px; font-weight: 700;
}

/* touch: the on-screen buttons in small (shoot = ice, the rest dark with a light ring, turbo ring blue) */
.ir-tut-tbtn {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  min-width: 24px; height: 24px; padding: 0 9px; border-radius: 12px;
  background: rgba(10, 15, 28, .82); border: 1px solid rgba(232, 237, 245, .45); color: var(--ink, #E8EDF5);
  font-size: 12px; line-height: 14px; font-weight: 700; white-space: nowrap;
}
.ir-tut-tbtn b { font-weight: 700; }
.ir-tut-tbtn-shoot { background: var(--ice, #DCEAF6); border-color: var(--ice, #DCEAF6); color: var(--on-ice, #0A0F1C); }
.ir-tut-tbtn-turbo { border-color: var(--turbo, #7CC4FF); }
.ir-tut-joy {
  position: relative; display: inline-block; flex: none; width: 24px; height: 24px; border-radius: 50%;
  background: rgba(10, 15, 28, .45); border: 2px solid rgba(232, 237, 245, .55);
}
.ir-tut-joy i {
  position: absolute; left: 50%; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%;
  background: var(--ink, #E8EDF5); transform: translate(2px, -2px);
}

/* urgent: the one-timer prompt */
.ir-tut-urgent {
  flex-wrap: nowrap; justify-content: flex-start; gap: 16px; padding: 14px 18px;
  background: #311921; background: color-mix(in srgb, var(--goal, #FF4B3E) 16%, var(--ground, #0A0F1C));
  border-color: var(--goal, #FF4B3E); animation-duration: 200ms;
}
.ir-tut-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ir-tut-urgent .ir-tut-title { font-size: 22px; line-height: 26px; font-style: italic; }
.ir-tut-big { animation: ir-tut-pop 220ms ease-out both; }
.ir-tut-big .ir-tut-key { min-width: 48px; height: 48px; padding: 0 14px; border-radius: var(--r-md, 10px); font-size: 22px; line-height: 26px; }
.ir-tut-big .ir-tut-mouse { gap: 8px; padding: 0 14px 0 12px; font-size: 15px; line-height: 18px; }
.ir-tut-big .ir-tut-mouse-ico { width: 18px; height: 24px; }
.ir-tut-big .ir-tut-pad { width: 48px; height: 48px; font-size: 22px; line-height: 26px; }
.ir-tut-big .ir-tut-tbtn { min-width: 48px; height: 48px; padding: 0 18px; border-radius: 24px; font-size: 15px; line-height: 18px; }

/* hot: on fire (fire) and sudden death (warn) */
.ir-tut-hot {
  --tut-acc: var(--fire, #FF8A2A);
  background: #2C201E; background: color-mix(in srgb, var(--tut-acc) 14%, var(--ground, #0A0F1C));
  border-color: #915324; border-color: color-mix(in srgb, var(--tut-acc) 55%, var(--ground, #0A0F1C));
}
.ir-tut-hot.ir-tut-warn {
  --tut-acc: var(--warn, #F2C14E);
  background: #2B2823; background: color-mix(in srgb, var(--tut-acc) 14%, var(--ground, #0A0F1C));
  border-color: #7E6835; border-color: color-mix(in srgb, var(--tut-acc) 50%, var(--ground, #0A0F1C));
}
.ir-tut-head { display: flex; align-items: center; gap: 8px; }
.ir-tut-ico { display: inline-flex; align-items: center; color: var(--tut-acc, #FF8A2A); }
.ir-tut-ico-flame { display: block; width: 12px; height: 18px; }
.ir-tut-ico-clock { display: block; width: 18px; height: 18px; }

/* a phone held sideways: a top-centre band would sit on the far boards and their head tags, so the
   hint becomes a compact card in the top-right corner beside the scoreboard (the pause button, turbo
   bar and chat own the top-left, the buttons the bottom-right). The one-timer prompt stays centred. */
@media (orientation: landscape) and (max-height: 540px) {
  .ir-tut-root.ir-tut-dev-touch:not(.ir-tut-k-urgent) {
    left: auto; right: max(14px, env(safe-area-inset-right, 0px)); top: max(10px, env(safe-area-inset-top, 0px));
    transform: none; min-width: 0; max-width: max(200px, calc(50% - 150px));
  }
  .ir-tut-dev-touch:not(.ir-tut-k-urgent) .ir-tut-card {
    min-height: 0; padding: 7px 12px; gap: 6px 12px; border-radius: var(--r-md, 10px);
  }
  .ir-tut-dev-touch:not(.ir-tut-k-urgent) .ir-tut-title { font-size: 13px; line-height: 16px; }
  .ir-tut-dev-touch:not(.ir-tut-k-urgent) .ir-tut-row { gap: 6px 12px; }
}

@keyframes ir-tut-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes ir-tut-pop { from { transform: scale(.86); } to { transform: none; } }
@media (max-width: 520px) {
  .ir-tut-root, .ir-tut-root.ir-tut-k-urgent { min-width: 0; }
  .ir-tut-card { padding: 7px 14px; gap: 6px 20px; }
  .ir-tut-urgent { padding: 12px 14px; gap: 12px; }
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
    root.className = 'ir-tut-root' + (fixed ? ' ir-tut-fixed' : '') + ` ir-tut-dev-${device}` +
      (hint ? ` ir-tut-k-${hintKind(hint)}` : '') + (on ? ' ir-tut-on' : '');
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
