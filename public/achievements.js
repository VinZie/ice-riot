// ICE RIOT - challenges ("tasks"): persistent, per-browser goals for the LOCAL player, with
// arcade unlock toasts and a progress panel.
//
//   import { createAchievements } from './achievements.js';
//   const ach = createAchievements({ container: document.body });
//   ach.handle(events, state, { myId });   // every frame, same events/state the renderer gets
//   ach.openPanel();                       // e.g. from a "CHALLENGES" button
//
// Layers (top to bottom):
//   CHALLENGES          data: { id, title, desc, tier, scope: 'game'|'career', stat, goal }.
//   tracker (pure)      createProgress / stepProgress / progressOf / serializeProgress:
//                       attribution, per-game + career counters, game boundaries, unlock rules.
//                       No IO, no DOM, no clock (the caller passes `now`), so it runs in Node.
//   createAchievements  storage (tolerates missing / throwing storage) + DOM (toasts, panel).
//                       DOM is created lazily on first use and skipped entirely when container is null.
//
// Attribution: an event counts for the local player when the player id it names (by / scorer /
// assist / player) is a skater controlled by ctx.myId. Ownership comes from the state
// (state.p[id].c === ctx.myId) and is advanced in event order by SWITCH events. The interpolated
// state handed out by net.js takes discrete fields from the snapshot AFTER the one whose events are
// being released, so when the state's controlled skater changes with no SWITCH event to explain it,
// the old ownership is kept for a short grace window (the SWITCH normally shows up one snapshot
// later); if none arrives (drop-in, team change, release) the state's ownership is adopted.

import { PHASE, EVENT, RINK, TICK_RATE, TEAM_SIZE, DEFAULT_CONFIG } from '../shared/constants.js';

export const STORAGE_KEY = 'iceRiot.achievements';
const SAVE_VERSION = 1;

export const TIERS = {
  1: { name: 'TIER I', roman: 'I', color: '#37e2ff' },
  2: { name: 'TIER II', roman: 'II', color: '#ff4fd8' },
  3: { name: 'TIER III', roman: 'III', color: '#ffc933' },
};

// scope 'game': the goal must be reached inside a single game (stat resets every game; progress
// shows the best single game so far). scope 'career': lifetime counter.
export const CHALLENGES = [
  // ---- tier 1
  { id: 'lamp-lighter', title: 'LAMP LIGHTER', desc: 'Score a goal.', tier: 1, scope: 'career', stat: 'goals', goal: 1 },
  { id: 'bone-rattler', title: 'BONE RATTLER', desc: 'Land a turbo-charged big hit.', tier: 1, scope: 'career', stat: 'bigHits', goal: 1 },
  { id: 'pane-in-the-glass', title: 'PANE IN THE GLASS', desc: 'Check someone hard enough to shatter the glass.', tier: 1, scope: 'career', stat: 'glass', goal: 1 },
  { id: 'ignition', title: 'IGNITION', desc: 'Get yourself ON FIRE.', tier: 1, scope: 'career', stat: 'fires', goal: 1 },
  { id: 'pickpocket', title: 'PICKPOCKET', desc: 'Strip the puck from an opponent 3 times in one game.', tier: 1, scope: 'game', stat: 'steals', goal: 3 },
  { id: 'spin-cycle', title: 'SPIN CYCLE', desc: 'Pull off 5 dekes in one game.', tier: 1, scope: 'game', stat: 'dekes', goal: 5 },
  { id: 'full-windup', title: 'FULL WIND-UP', desc: 'Let rip a fully charged slapshot.', tier: 1, scope: 'career', stat: 'maxSlaps', goal: 1 },
  { id: 'victory-lap', title: 'VICTORY LAP', desc: 'Win a game.', tier: 1, scope: 'career', stat: 'wins', goal: 1 },
  // ---- tier 2
  { id: 'no-hesitation', title: 'NO HESITATION', desc: 'Bury a one-timer.', tier: 2, scope: 'career', stat: 'oneTimerGoals', goal: 1 },
  { id: 'long-bomb', title: 'LONG BOMB', desc: 'Score on a slapshot fired from outside the attacking blue line.', tier: 2, scope: 'career', stat: 'longSlapGoals', goal: 1 },
  { id: 'demolition-shift', title: 'DEMOLITION SHIFT', desc: 'Land 5 big hits in one game.', tier: 2, scope: 'game', stat: 'bigHits', goal: 5 },
  { id: 'hot-hands', title: 'HOT HANDS', desc: 'Score while you are ON FIRE.', tier: 2, scope: 'career', stat: 'fireGoals', goal: 1 },
  { id: 'table-setter', title: 'TABLE SETTER', desc: 'Feed a teammate for a one-timer goal.', tier: 2, scope: 'career', stat: 'oneTimerAssists', goal: 1 },
  { id: 'off-the-drop', title: 'OFF THE DROP', desc: 'Score within 10 seconds of a puck drop.', tier: 2, scope: 'career', stat: 'quickGoals', goal: 1 },
  { id: 'sauce-boss', title: 'SAUCE BOSS', desc: 'Rack up 3 assists in one game.', tier: 2, scope: 'game', stat: 'assists', goal: 3 },
  { id: 'overtime-outlaw', title: 'OVERTIME OUTLAW', desc: 'Win a game in sudden-death overtime.', tier: 2, scope: 'career', stat: 'otWins', goal: 1 },
  { id: 'brick-wall', title: 'BRICK WALL', desc: 'Win without giving up a single goal.', tier: 2, scope: 'career', stat: 'shutoutWins', goal: 1 },
  { id: 'no-mercy', title: 'NO MERCY', desc: 'Win by 4 or more goals.', tier: 2, scope: 'career', stat: 'blowoutWins', goal: 1 },
  { id: 'rink-rat', title: 'RINK RAT', desc: 'Play 10 games through to the final horn.', tier: 2, scope: 'career', stat: 'games', goal: 10 },
  // ---- tier 3
  { id: 'three-alarm', title: 'THREE-ALARM', desc: 'Score 3 goals in one game.', tier: 3, scope: 'game', stat: 'goals', goal: 3 },
  { id: 'glaziers-nightmare', title: "GLAZIER'S NIGHTMARE", desc: 'Shatter the glass 3 times in one game.', tier: 3, scope: 'game', stat: 'glass', goal: 3 },
  { id: 'rise-from-the-slush', title: 'RISE FROM THE SLUSH', desc: 'Win a game after trailing by 2 or more.', tier: 3, scope: 'career', stat: 'comebackWins', goal: 1 },
  { id: 'beat-the-horn', title: 'BEAT THE HORN', desc: 'Score with 5 seconds or less left on the period clock.', tier: 3, scope: 'career', stat: 'hornGoals', goal: 1 },
  { id: 'wrecking-ball', title: 'HUMAN WRECKING BALL', desc: 'Deliver 100 career hits.', tier: 3, scope: 'career', stat: 'hits', goal: 100 },
  { id: 'quarter-century', title: 'QUARTER CENTURY', desc: 'Score 25 career goals.', tier: 3, scope: 'career', stat: 'goals', goal: 25 },
].map((c) => Object.freeze(c));
Object.freeze(CHALLENGES);

export const GAME_STATS = ['goals', 'assists', 'bigHits', 'glass', 'steals', 'dekes'];
export const CAREER_STATS = [
  'goals', 'assists', 'hits', 'bigHits', 'glass', 'steals', 'dekes', 'fires', 'maxSlaps',
  'oneTimerGoals', 'longSlapGoals', 'fireGoals', 'oneTimerAssists', 'quickGoals', 'hornGoals',
  'games', 'wins', 'otWins', 'shutoutWins', 'blowoutWins', 'comebackWins',
];

export const RULES = Object.freeze({
  quickGoalSecs: 10,     // OFF THE DROP: goal this soon after the FACEOFF (puck drop) event
  hornSecs: 5,           // BEAT THE HORN: period clock at or under this when the goal goes in
  fullSlapPower: 0.95,   // FULL WIND-UP: slapshot power at least this
  shotMemorySecs: 6,     // a goal is matched with the scorer's own SHOT event at most this old
  comebackDeficit: 2,    // RISE FROM THE SLUSH
  blowoutMargin: 4,      // NO MERCY
  graceTicks: 15,        // keep old ownership this long while waiting for a SWITCH event (0.25 s)
  graceCalls: 30,        // ...or this many handle() calls if the tick is not advancing
});

// ---------------------------------------------------------------------------------------------
// Pure tracker
// ---------------------------------------------------------------------------------------------

const MAX_ID = TEAM_SIZE * 2;
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const isId = (v) => Number.isInteger(v) && v >= 0 && v < MAX_ID;
const teamOfId = (id) => Math.floor(id / TEAM_SIZE);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const evType = (e) => (e && (e.type ?? e.t ?? e.e ?? e.ev)) || '';
const zeroes = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
const BY_ID = new Map(CHALLENGES.map((c) => [c.id, c]));

function freshTrack(myId = 0) {
  return {
    started: false,      // a state of the current game has been seen
    lastTick: -Infinity,
    lastPer: 0,
    tick: 0,
    clk: Infinity,
    sawOver: false,      // GAME_OVER seen in this game
    finalized: false,    // win/loss/games already credited for this game
    played: false,       // the local player controlled a skater at some point this game
    team: -1,            // team of the local player's most recent skater this game
    periods: DEFAULT_CONFIG.periods,
    maxPer: 0,
    lastSc: null,
    deficit: [0, 0],     // largest deficit each team faced this game
    myId,
    owned: new Set(),    // skater ids the local player controls, as of the last processed event
    mismatchTick: null,
    mismatchCalls: 0,
    fire: new Set(),     // player ids currently ON FIRE
    shots: {},           // id -> { kind, x, tick } of that player's latest shot (local player only)
    faceoffTick: null,
  };
}

// saved: the object from serializeProgress() (or anything; invalid parts are ignored).
export function createProgress(saved = null) {
  const m = {
    unlocked: {},                    // id -> unlockedAt (ms epoch)
    career: zeroes(CAREER_STATS),
    best: zeroes(GAME_STATS),        // best single game per game-scoped stat
    game: zeroes(GAME_STATS),        // current game
    t: freshTrack(),
    dirty: false,                    // persistent data changed since the last save
  };
  if (saved && typeof saved === 'object') {
    const u = saved.unlocked;
    if (u && typeof u === 'object') {
      for (const k of Object.keys(u)) if (typeof u[k] === 'number' && Number.isFinite(u[k]) && u[k] >= 0) m.unlocked[k] = u[k];
    }
    const c = saved.career && typeof saved.career === 'object' ? saved.career : {};
    const b = saved.best && typeof saved.best === 'object' ? saved.best : {};
    for (const k of CAREER_STATS) m.career[k] = count(c[k]);
    for (const k of GAME_STATS) m.best[k] = count(b[k]);
  }
  return m;
}

export function serializeProgress(m) {
  return { v: SAVE_VERSION, unlocked: { ...m.unlocked }, career: { ...m.career }, best: { ...m.best } };
}

export function progressOf(m, ch) {
  const v = ch.scope === 'game'
    ? Math.max(m.best[ch.stat] || 0, m.game[ch.stat] || 0)
    : m.career[ch.stat] || 0;
  return Math.min(ch.goal, v);
}

export function isUnlocked(m, id) { return hasOwn(m.unlocked, id); }

// Advance the tracker by one frame. Mutates m. Returns the ids unlocked by this call (each id is
// returned at most once, ever). `now` is only used as the unlock timestamp.
export function stepProgress(m, events, state, ctx = {}, now = 0) {
  const myId = Number(ctx && ctx.myId) > 0 ? Number(ctx.myId) : 0;
  if (myId !== m.t.myId) { m.t.myId = myId; m.t.owned = new Set(); m.t.mismatchTick = null; }

  const st = state && typeof state === 'object' && Array.isArray(state.p) ? state : null;
  if (st) observeState(m, st);         // may start a new game (replaces m.t)
  const t = m.t;
  t.periods = num(ctx && ctx.periods, DEFAULT_CONFIG.periods);
  let fromState = null;
  if (st) {
    fromState = ownedIn(st, myId);
    if (!t.owned.size && fromState.size) adopt(t, fromState);   // drop-in / game start
  }
  noteTeam(t);
  if (Array.isArray(events)) {
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      try { applyEvent(m, e, st); } catch { /* malformed event: ignore */ }
    }
  }
  if (fromState) reconcile(t, fromState);
  noteTeam(t);
  return evaluate(m, now);
}

function observeState(m, st) {
  let t = m.t;
  const tick = num(st.tick, t.started ? t.lastTick : 0);
  const per = num(st.per, t.lastPer);
  const sc = Array.isArray(st.sc) ? [num(st.sc[0]), num(st.sc[1])] : null;
  // New game: anything but GAME_OVER after a GAME_OVER (it is terminal), or something that never
  // goes backwards within one game did: the tick, the period, either score.
  if (t.started && (
    (t.sawOver && st.ph !== PHASE.GAME_OVER) || tick < t.lastTick || per < t.lastPer
    || (sc && t.lastSc && (sc[0] < t.lastSc[0] || sc[1] < t.lastSc[1])))) {
    if (t.sawOver) finalizeGame(m, null);   // game ended but its FINAL event never reached us
    m.game = zeroes(GAME_STATS);
    m.t = t = freshTrack(t.myId);
  }
  if (!t.started) {
    t.started = true;
    st.p.forEach((p, i) => { if (p && p.fire) t.fire.add(isId(p.id) ? p.id : i); });  // joined mid-streak
  }
  t.lastTick = t.tick = tick;
  t.lastPer = per;
  t.clk = num(st.clk, Infinity);
  if (st.ph === PHASE.GAME_OVER) t.sawOver = true;
  t.maxPer = Math.max(t.maxPer, per);
  if (sc) {
    t.lastSc = sc;
    t.deficit[0] = Math.max(t.deficit[0], sc[1] - sc[0]);
    t.deficit[1] = Math.max(t.deficit[1], sc[0] - sc[1]);
  }
}

function ownedIn(st, myId) {
  const s = new Set();
  if (!myId) return s;
  st.p.forEach((p, i) => {
    if (!p || p.g) return;                       // goalies are always AI
    const id = isId(p.id) ? p.id : i;
    if (Number(p.c) === myId) s.add(id);
  });
  return s;
}

function adopt(t, set) { t.owned = new Set(set); t.mismatchTick = null; t.mismatchCalls = 0; }

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function reconcile(t, fromState) {
  if (sameSet(t.owned, fromState)) { t.mismatchTick = null; t.mismatchCalls = 0; return; }
  if (t.mismatchTick === null) { t.mismatchTick = t.tick; t.mismatchCalls = 0; return; }
  t.mismatchCalls++;
  if (t.tick - t.mismatchTick >= RULES.graceTicks || t.mismatchCalls >= RULES.graceCalls) adopt(t, fromState);
}

function noteTeam(t) {
  for (const id of t.owned) { t.played = true; t.team = teamOfId(id); return; }
}

function bump(m, stat) { m.career[stat] = (m.career[stat] || 0) + 1; m.dirty = true; }
function bumpGame(m, stat) {
  m.game[stat] = (m.game[stat] || 0) + 1;
  if (m.game[stat] > (m.best[stat] || 0)) { m.best[stat] = m.game[stat]; m.dirty = true; }
}
function bumpBoth(m, stat) { bump(m, stat); bumpGame(m, stat); }

// Shot taken from outside the attacking zone. Team 0 attacks +X, team 1 attacks -X.
function outsideZone(x, team) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return false;
  return team === 1 ? x > -RINK.blueLineX : x < RINK.blueLineX;
}

function applyEvent(m, e, st) {
  const t = m.t;
  const mine = (id) => isId(id) && t.owned.has(id);
  // SHOT events carry no position: take the shooter's from the state (LONG BOMB needs it).
  const posX = (id) => { const p = st && st.p[id]; return p && typeof p.x === 'number' ? p.x : undefined; };
  switch (evType(e)) {
    case EVENT.SWITCH:
      if (t.myId && Number(e.client) === t.myId) {
        if (isId(e.from)) t.owned.delete(e.from);
        if (isId(e.to) && (e.to % TEAM_SIZE) !== TEAM_SIZE - 1) t.owned.add(e.to);
        noteTeam(t);
      }
      break;
    case EVENT.SHOT:
      if (!mine(e.by)) break;
      t.shots[e.by] = { kind: e.kind, x: typeof e.x === 'number' ? e.x : posX(e.by), tick: t.tick };
      if (e.kind === 'slap' && num(e.power) >= RULES.fullSlapPower) bump(m, 'maxSlaps');
      break;
    case EVENT.GOAL: onGoal(m, e); break;
    case EVENT.HIT:
      if (!mine(e.by)) break;
      bump(m, 'hits');
      if (e.big) bumpBoth(m, 'bigHits');
      break;
    case EVENT.GLASS: if (mine(e.by)) bumpBoth(m, 'glass'); break;
    case EVENT.STEAL: if (mine(e.by)) bumpBoth(m, 'steals'); break;
    case EVENT.DEKE: if (mine(e.by)) bumpBoth(m, 'dekes'); break;
    case EVENT.FIRE:
      if (!isId(e.player)) break;
      if (e.on) {
        if (!t.fire.has(e.player) && mine(e.player)) bump(m, 'fires');
        t.fire.add(e.player);
      } else t.fire.delete(e.player);
      break;
    case EVENT.FACEOFF: t.faceoffTick = t.tick; break;
    case EVENT.PERIOD: t.maxPer = Math.max(t.maxPer, num(e.period)); break;
    case EVENT.FINAL: {
      const sc = Array.isArray(e.score) ? [num(e.score[0]), num(e.score[1])] : null;
      t.sawOver = true;
      finalizeGame(m, sc);
      break;
    }
    default: break;
  }
}

function onGoal(m, e) {
  const t = m.t;
  const scorer = isId(e.scorer) ? e.scorer : -1;
  const team = e.team === 0 || e.team === 1 ? e.team : scorer >= 0 ? teamOfId(scorer) : -1;
  const onTeam = (id) => id >= 0 && teamOfId(id) === team;          // own goals earn nothing
  const mineScorer = scorer >= 0 && t.owned.has(scorer) && onTeam(scorer);
  const assist = isId(e.assist) && e.assist !== scorer ? e.assist : -1;
  const mineAssist = assist >= 0 && t.owned.has(assist) && onTeam(assist);
  const shot = scorer >= 0 ? t.shots[scorer] : null;
  const recent = !!shot && t.tick - shot.tick <= RULES.shotMemorySecs * TICK_RATE;
  const oneTimer = !!e.oneTimer || (recent && shot.kind === 'onetimer');
  if (mineScorer) {
    bumpBoth(m, 'goals');
    if (oneTimer) bump(m, 'oneTimerGoals');
    if (recent && shot.kind === 'slap' && outsideZone(shot.x, team)) bump(m, 'longSlapGoals');
    if (t.fire.has(scorer)) bump(m, 'fireGoals');
    if (t.faceoffTick !== null && t.tick - t.faceoffTick <= RULES.quickGoalSecs * TICK_RATE) bump(m, 'quickGoals');
    // (an untimed sudden-death OT may report clk 0: only a running OT clock counts)
    if (t.clk <= RULES.hornSecs && (t.lastPer <= t.periods || t.clk > 0)) bump(m, 'hornGoals');
  }
  if (mineAssist) {
    bumpBoth(m, 'assists');
    if (oneTimer) bump(m, 'oneTimerAssists');
  }
  if (scorer >= 0) delete t.shots[scorer];
  t.faceoffTick = null;
}

function finalizeGame(m, sc) {
  const t = m.t;
  if (t.finalized) return;
  t.finalized = true;
  if (!t.played || (t.team !== 0 && t.team !== 1)) return;     // spectated: no credit
  bump(m, 'games');
  const s = sc || t.lastSc;
  if (!s) return;
  const mine = num(s[t.team]), theirs = num(s[1 - t.team]);
  if (mine <= theirs) return;
  bump(m, 'wins');
  if (t.maxPer > t.periods) bump(m, 'otWins');
  if (theirs === 0) bump(m, 'shutoutWins');
  if (mine - theirs >= RULES.blowoutMargin) bump(m, 'blowoutWins');
  if (t.deficit[t.team] >= RULES.comebackDeficit) bump(m, 'comebackWins');
}

function evaluate(m, now) {
  const fresh = [];
  for (const ch of CHALLENGES) {
    if (hasOwn(m.unlocked, ch.id)) continue;
    if (progressOf(m, ch) >= ch.goal) {
      m.unlocked[ch.id] = num(now);
      m.dirty = true;
      fresh.push(ch.id);
    }
  }
  return fresh;
}

// ---------------------------------------------------------------------------------------------
// Storage + DOM
// ---------------------------------------------------------------------------------------------

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }   // blocked storage throws
}

export function createAchievements({
  container = null,
  storage = defaultStorage(),
  storageKey = STORAGE_KEY,
  toastMs = 3600,                 // how long each toast stays up
  onUnlock = null,                // optional (challengeEntry) => void, e.g. to play a jingle
  now = () => Date.now(),
} = {}) {
  let disposed = false;
  let model = createProgress(readSaved());
  const ui = container ? createUi(container, { toastMs }) : null;

  function readSaved() {
    if (!storage) return null;
    try {
      const raw = storage.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function save() {
    model.dirty = false;
    if (!storage) return;
    try { storage.setItem(storageKey, JSON.stringify(serializeProgress(model))); } catch { /* quota / blocked */ }
  }
  function entry(ch) {
    const unlocked = isUnlocked(model, ch.id);
    return { ...ch, unlocked, unlockedAt: unlocked ? model.unlocked[ch.id] : null, progress: unlocked ? ch.goal : progressOf(model, ch), goal: ch.goal };
  }
  function list() { return CHALLENGES.map(entry); }

  return {
    handle(events, state, ctx = {}) {
      if (disposed) return [];
      let ids = [];
      try { ids = stepProgress(model, events, state, ctx || {}, num(now(), 0)); } catch { ids = []; }   // never take the game loop down
      if (model.dirty) save();
      const fresh = ids.map((id) => entry(BY_ID.get(id)));
      for (const ch of fresh) {
        if (ui) ui.toast(ch);
        if (typeof onUnlock === 'function') { try { onUnlock(ch); } catch { /* caller bug */ } }
      }
      if (ui && fresh.length && ui.isOpen()) ui.render(list());
      return fresh;
    },
    list,
    openPanel() { if (ui && !disposed) ui.open(list()); },
    closePanel() { if (ui) ui.close(); },
    reset() {
      const t = model.t;
      model = createProgress(null);
      model.t = t;                       // keep game tracking (ownership, phase) going
      model.game = zeroes(GAME_STATS);
      if (storage) { try { storage.removeItem(storageKey); } catch { /* ignore */ } }
      model.dirty = false;
      if (ui) { ui.clearToasts(); if (ui.isOpen()) ui.render(list()); }
    },
    dispose() {
      disposed = true;
      if (model.dirty) save();
      if (ui) ui.dispose();
    },
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
.ir-ach-root{position:fixed;inset:0;pointer-events:none;z-index:2147483000;font-family:"Arial Black","Segoe UI Black",Impact,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.ir-ach-root *{box-sizing:border-box}
.ir-ach-t1{--c:#37e2ff;--c2:#0b6cff}
.ir-ach-t2{--c:#ff4fd8;--c2:#7a2cff}
.ir-ach-t3{--c:#ffc933;--c2:#ff6a13}
.ir-ach-toasts{position:absolute;top:84px;right:18px;display:flex;flex-direction:column;align-items:flex-end;gap:12px;pointer-events:none}
.ir-ach-toast{position:relative;display:flex;align-items:center;gap:14px;width:380px;max-width:calc(100vw - 32px);padding:10px 22px 10px 12px;
  background:linear-gradient(100deg,rgba(6,10,26,.97) 0%,rgba(18,24,52,.95) 60%,rgba(6,10,26,.97) 100%);
  border:3px solid var(--c);transform:skewX(-10deg);pointer-events:none;overflow:hidden;
  box-shadow:0 0 0 2px rgba(0,0,0,.55),0 0 24px color-mix(in srgb,var(--c) 60%,transparent),7px 7px 0 rgba(0,0,0,.5);
  animation:ir-ach-in .55s cubic-bezier(.18,1.35,.4,1) both}
.ir-ach-toast::before{content:"";position:absolute;inset:0 auto 0 0;width:6px;background:var(--c)}
.ir-ach-toast::after{content:"";position:absolute;top:-20%;bottom:-20%;left:-40%;width:28%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);animation:ir-ach-shine 1.1s .35s ease-out both}
.ir-ach-toast>*{transform:skewX(10deg)}
.ir-ach-toast.ir-ach-out{animation:ir-ach-out .36s ease-in forwards}
.ir-ach-badge{flex:none;width:58px;height:58px;display:grid;place-items:center;margin-left:4px;
  clip-path:polygon(50% 0,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%);
  background:radial-gradient(circle at 35% 30%,#fff 0,var(--c) 38%,var(--c2) 100%);
  color:#0a0f22;font-size:21px;font-style:italic;letter-spacing:-.02em;text-shadow:0 1px 0 rgba(255,255,255,.5)}
.ir-ach-body{min-width:0;display:flex;flex-direction:column;gap:2px}
.ir-ach-kicker{font-size:11px;letter-spacing:.2em;color:var(--c);text-shadow:0 0 10px color-mix(in srgb,var(--c) 70%,transparent)}
.ir-ach-title{font-size:23px;line-height:1.05;font-style:italic;color:#fff;text-transform:uppercase;text-shadow:2px 2px 0 rgba(0,0,0,.65);overflow-wrap:anywhere}
.ir-ach-desc{font:600 12.5px/1.3 system-ui,"Segoe UI",sans-serif;color:#c8d2ec}
@keyframes ir-ach-in{0%{transform:translateX(130%) skewX(-10deg);opacity:0}60%{opacity:1}100%{transform:translateX(0) skewX(-10deg);opacity:1}}
@keyframes ir-ach-out{to{transform:translateX(130%) skewX(-10deg);opacity:0}}
@keyframes ir-ach-shine{to{left:120%}}
@keyframes ir-ach-fade{from{opacity:0}to{opacity:1}}
.ir-ach-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;pointer-events:auto;
  background:rgba(2,4,12,.74);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);animation:ir-ach-fade .18s ease both}
.ir-ach-panel{width:min(1000px,100%);max-height:100%;display:flex;flex-direction:column;color:#e9eefc;overflow:hidden;
  background:linear-gradient(180deg,#121a36 0%,#0a0e1f 100%);border:2px solid #2c3c70;border-radius:14px;
  box-shadow:0 24px 70px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.06)}
.ir-ach-head{display:flex;align-items:center;gap:14px;padding:14px 16px 8px}
.ir-ach-h1{font-size:28px;font-style:italic;letter-spacing:.02em;line-height:1;color:#fff;text-shadow:3px 3px 0 #ff4fd8,-1px -1px 0 #37e2ff}
.ir-ach-count{margin-left:auto;font-size:15px;color:#9fb0dc;white-space:nowrap}
.ir-ach-count b{font-size:22px;color:#fff}
.ir-ach-x{flex:none;width:40px;height:40px;border-radius:10px;border:2px solid #2c3c70;background:#0d1430;color:#fff;font:900 22px/1 system-ui,sans-serif;cursor:pointer}
.ir-ach-x:hover,.ir-ach-x:focus-visible{border-color:#37e2ff;outline:none;box-shadow:0 0 12px rgba(55,226,255,.5)}
.ir-ach-meter{margin:0 16px;height:8px;border-radius:4px;background:#1b2448;overflow:hidden}
.ir-ach-meter i{display:block;height:100%;background:linear-gradient(90deg,#37e2ff,#ff4fd8,#ffc933)}
.ir-ach-tiers{display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px 4px}
.ir-ach-chip{font-size:11px;letter-spacing:.12em;padding:4px 9px;border-radius:999px;border:1.5px solid var(--c);color:var(--c)}
.ir-ach-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));gap:10px;padding:10px 16px 16px;overflow-y:auto;overscroll-behavior:contain;
  scrollbar-width:thin;scrollbar-color:#34467f transparent}
.ir-ach-card{position:relative;display:flex;gap:11px;padding:11px 12px 10px;border-radius:10px;background:#0f1531;border:1.5px solid #222d58;min-width:0}
.ir-ach-card.ir-ach-done{background:linear-gradient(135deg,color-mix(in srgb,var(--c) 16%,#0f1531) 0%,#0f1531 70%);border-color:var(--c);
  box-shadow:0 0 14px color-mix(in srgb,var(--c) 28%,transparent)}
.ir-ach-cbadge{flex:none;width:38px;height:38px;display:grid;place-items:center;font-size:14px;font-style:italic;
  clip-path:polygon(50% 0,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%);background:#26305a;color:#7e8bb5}
.ir-ach-done .ir-ach-cbadge{background:radial-gradient(circle at 35% 30%,#fff 0,var(--c) 40%,var(--c2) 100%);color:#0a0f22}
.ir-ach-cmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ir-ach-ctitle{font-size:14.5px;font-style:italic;line-height:1.1;color:#aeb9da;overflow-wrap:anywhere}
.ir-ach-done .ir-ach-ctitle{color:#fff}
.ir-ach-cdesc{font:600 12px/1.3 system-ui,"Segoe UI",sans-serif;color:#8a96bd}
.ir-ach-done .ir-ach-cdesc{color:#c8d2ec}
.ir-ach-bar{height:6px;margin-top:4px;border-radius:3px;background:#1d2650;overflow:hidden}
.ir-ach-bar i{display:block;height:100%;border-radius:3px;background:var(--c);opacity:.55}
.ir-ach-done .ir-ach-bar i{opacity:1}
.ir-ach-cfoot{display:flex;justify-content:space-between;gap:8px;font:800 10.5px/1.2 system-ui,"Segoe UI",sans-serif;letter-spacing:.08em;color:#6f7ca6}
.ir-ach-cfoot span{white-space:nowrap}
.ir-ach-done .ir-ach-cfoot span:last-child{color:var(--c)}
@media (max-width:560px){
  .ir-ach-toasts{top:12px;left:16px;right:16px;align-items:stretch}
  .ir-ach-toast{width:auto;max-width:none}
  .ir-ach-title{font-size:19px}
  .ir-ach-overlay{padding:16px 16px}
  .ir-ach-h1{font-size:22px}
  .ir-ach-grid{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){
  .ir-ach-toast,.ir-ach-toast.ir-ach-out{animation:ir-ach-fade .2s ease both}
  .ir-ach-toast.ir-ach-out{animation-direction:reverse}
  .ir-ach-toast::after{display:none}
}`;

const STYLE_ID = 'ir-ach-style';
const MAX_VISIBLE = 3;
const STAGGER_MS = 380;
const OUT_MS = 360;

function createUi(container, { toastMs }) {
  const doc = container.ownerDocument || globalThis.document;
  let root = null, toastsEl = null, overlay = null, panelBody = null, lastFocus = null;
  const queue = [];
  const timers = new Set();
  let visible = 0, staggerTimer = 0;

  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };

  function ensureRoot() {
    if (root) return;
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      (doc.head || doc.documentElement).appendChild(style);
    }
    root = doc.createElement('div');
    root.className = 'ir-ach-root';
    toastsEl = doc.createElement('div');
    toastsEl.className = 'ir-ach-toasts';
    toastsEl.setAttribute('role', 'status');
    toastsEl.setAttribute('aria-live', 'polite');
    root.appendChild(toastsEl);
    container.appendChild(root);
  }

  function pump() {
    if (staggerTimer || visible >= MAX_VISIBLE || !queue.length) return;
    const ch = queue.shift();
    visible++;
    const el = doc.createElement('div');
    el.className = `ir-ach-toast ir-ach-t${ch.tier}`;
    el.innerHTML = `<div class="ir-ach-badge">${esc(TIERS[ch.tier]?.roman || ch.tier)}</div>`
      + `<div class="ir-ach-body"><div class="ir-ach-kicker">CHALLENGE COMPLETE</div>`
      + `<div class="ir-ach-title">${esc(ch.title)}</div><div class="ir-ach-desc">${esc(ch.desc)}</div></div>`;
    toastsEl.appendChild(el);
    const hold = queue.length > MAX_VISIBLE ? Math.min(toastMs, 2200) : toastMs;   // hurry a long backlog
    later(() => {
      el.classList.add('ir-ach-out');
      later(() => { el.remove(); visible--; pump(); }, OUT_MS);
    }, hold);
    staggerTimer = later(() => { staggerTimer = 0; pump(); }, STAGGER_MS);
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function render(items) {
    if (!overlay) return;
    const done = items.filter((c) => c.unlocked).length;
    const tiers = [1, 2, 3].map((n) => {
      const all = items.filter((c) => c.tier === n);
      return `<span class="ir-ach-chip ir-ach-t${n}">${TIERS[n].name} &nbsp;${all.filter((c) => c.unlocked).length}/${all.length}</span>`;
    }).join('');
    const cards = items.map((c) => {
      const pct = Math.round((c.progress / c.goal) * 100);
      const scope = c.scope === 'game' ? 'IN ONE GAME' : 'CAREER';
      const right = c.unlocked
        ? `&#10003; ${esc(fmtDate(c.unlockedAt))}`
        : `${c.scope === 'game' && c.goal > 1 ? 'BEST ' : ''}${c.progress} / ${c.goal}`;
      return `<div class="ir-ach-card ir-ach-t${c.tier}${c.unlocked ? ' ir-ach-done' : ''}">`
        + `<div class="ir-ach-cbadge">${TIERS[c.tier].roman}</div><div class="ir-ach-cmain">`
        + `<div class="ir-ach-ctitle">${esc(c.title)}</div><div class="ir-ach-cdesc">${esc(c.desc)}</div>`
        + `<div class="ir-ach-bar"><i style="width:${pct}%"></i></div>`
        + `<div class="ir-ach-cfoot"><span>${c.unlocked ? 'CLEARED' : scope}</span><span>${right}</span></div></div></div>`;
    }).join('');
    panelBody.innerHTML = `<div class="ir-ach-head"><div class="ir-ach-h1">CHALLENGES</div>`
      + `<div class="ir-ach-count"><b>${done}</b> / ${items.length}</div>`
      + `<button type="button" class="ir-ach-x" aria-label="Close challenges">&#10005;</button></div>`
      + `<div class="ir-ach-meter"><i style="width:${Math.round((done / items.length) * 100)}%"></i></div>`
      + `<div class="ir-ach-tiers">${tiers}</div><div class="ir-ach-grid">${cards}</div>`;
    panelBody.querySelector('.ir-ach-x').addEventListener('click', close);
  }

  function open(items) {
    ensureRoot();
    if (!overlay) {
      lastFocus = doc.activeElement;
      overlay = doc.createElement('div');
      overlay.className = 'ir-ach-overlay';
      overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
      panelBody = doc.createElement('div');
      panelBody.className = 'ir-ach-panel';
      panelBody.setAttribute('role', 'dialog');
      panelBody.setAttribute('aria-modal', 'true');
      panelBody.setAttribute('aria-label', 'Challenges');
      overlay.appendChild(panelBody);
      root.insertBefore(overlay, toastsEl);       // toasts stay on top of the panel
      doc.addEventListener('keydown', onKey);
    }
    render(items);
    try { panelBody.querySelector('.ir-ach-x').focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  function close() {
    if (!overlay) return;
    doc.removeEventListener('keydown', onKey);
    overlay.remove();
    overlay = panelBody = null;
    try { if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    lastFocus = null;
  }

  function clearToasts() {
    queue.length = 0;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    staggerTimer = 0;
    visible = 0;
    if (toastsEl) toastsEl.textContent = '';
  }

  return {
    toast(ch) { ensureRoot(); queue.push(ch); pump(); },
    isOpen: () => !!overlay,
    open, close, render, clearToasts,
    dispose() {
      clearToasts();
      close();
      if (root) root.remove();
      root = toastsEl = null;
      // Leave the shared <style> unless no other instance is using it.
      if (!doc.querySelector('.ir-ach-root')) doc.getElementById(STYLE_ID)?.remove();
    },
  };
}

function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; }
}
