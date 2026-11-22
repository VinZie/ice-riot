// ICE RIOT - challenges: persistent, per-browser goals for the LOCAL player, with unlock toasts,
// an inline lobby view and an in-game sheet.
//
//   import { createAchievements } from './achievements.js';
//   const ach = createAchievements({ container: document.body, onUnlock });
//   ach.handle(events, state, { myId, periods });   // every frame, same events/state the renderer gets
//   ach.mountView(el);                              // lobby "Challenges" view (fills el)
//   ach.openPanel();                                // 600px right-side sheet (in game, from the pause menu)
//   ach.progress();                                 // { done, total, secretsDone, secretsTotal }
//   ach.onProgress(fn);                             // fn(progress()) after every change; returns unsubscribe
//
// Layers (top to bottom):
//   CHALLENGES / SECRETS data: { id, title, desc, tier, scope: 'game'|'career', stat, goal, secret? }.
//                       25 challenges in three tiers, plus 5 hidden ones that are not counted in the 25.
//   tracker (pure)      createProgress / stepProgress / progressOf / serializeProgress:
//                       attribution, per-game + career counters, game boundaries, unlock rules.
//                       No IO, no DOM, no clock (the caller passes `now`), so it runs in Node.
//   createAchievements  storage (tolerates missing / throwing storage) + DOM (toasts, view, sheet).
//                       DOM is created lazily on first use and skipped entirely without a container.
//
// Attribution: an event counts for the local player when the player id it names (by / scorer /
// assist / player / winner) is a skater controlled by ctx.myId. Ownership comes from the state
// (state.p[id].c === ctx.myId) and is advanced in event order by SWITCH events. The interpolated
// state handed out by net.js takes discrete fields from the snapshot AFTER the one whose events are
// being released, so when the state's controlled skater changes with no SWITCH event to explain it,
// the old ownership is kept for a short grace window (the SWITCH normally shows up one snapshot
// later); if none arrives (drop-in, team change, release) the state's ownership is adopted.
//
// Secret challenges and the data they are detected from (all of it reaches handle()):
//   Heavyweight      'fightEnd' {winner, loser, how} (shared/sim-fight.js EV_FIGHT_END) whose
//                    winner is one of my skaters.
//   Bar down         POST {x, z} carries no shooter, so it is credited to the most recent SHOT when
//                    that shot was mine, at most RULES.postShotSecs old, and nothing touched the puck
//                    in between (PASS / STEAL / SAVE / GOAL / FACEOFF / WHISTLE events, or a puck
//                    owner in the state). One shot rings at most one post. 3 in one game.
//   Night shift      a game I played is finished while the caller's clock (`now`) reads 00:00-04:59
//                    local time.
//   Glass and gas    my GOAL at most RULES.glassGoalSecs after my own GLASS event.
//   Spectator sport  a game watched from its opening (period 1, 0-0, first RULES.spectateStartSecs)
//                    through the final horn (FINAL / GAME_OVER) without controlling a skater, with a
//                    client id, at least RULES.spectateMinSecs of game time apart.

import { PHASE, EVENT, RINK, TICK_RATE, TEAM_SIZE, DEFAULT_CONFIG } from '../shared/constants.js';

export const STORAGE_KEY = 'iceRiot.achievements';
// Save format v1 (unchanged since the first release): { v, unlocked: {id: ms}, career: {stat: n},
// best: {stat: n} }. New stats are additive keys, so older saves load as they are (missing counters
// start at 0) and keep every unlock and its timestamp.
const SAVE_VERSION = 1;
const FIGHT_END = 'fightEnd';     // shared/sim-fight.js EV_FIGHT_END (not in EVENT: the fight is an extension)

export const TIERS = {
  1: { name: 'Tier I', roman: 'I', color: '#8FB3D9' },
  2: { name: 'Tier II', roman: 'II', color: '#C08CFF' },
  3: { name: 'Tier III', roman: 'III', color: '#FFB547' },
};

// scope 'game': the goal must be reached inside a single game (stat resets every game; progress
// shows the best single game so far). scope 'career': lifetime counter.
export const CHALLENGES = [
  // ---- tier 1
  { id: 'lamp-lighter', title: 'Lamp lighter', desc: 'Score a goal.', tier: 1, scope: 'career', stat: 'goals', goal: 1 },
  { id: 'bone-rattler', title: 'Bone rattler', desc: 'Land a turbo-charged big hit.', tier: 1, scope: 'career', stat: 'bigHits', goal: 1 },
  { id: 'pane-in-the-glass', title: 'Pane in the glass', desc: 'Check someone hard enough to shatter the glass.', tier: 1, scope: 'career', stat: 'glass', goal: 1 },
  { id: 'ignition', title: 'Ignition', desc: 'Get yourself on fire.', tier: 1, scope: 'career', stat: 'fires', goal: 1 },
  { id: 'pickpocket', title: 'Pickpocket', desc: 'Strip the puck from an opponent 3 times in one game.', tier: 1, scope: 'game', stat: 'steals', goal: 3 },
  { id: 'spin-cycle', title: 'Spin cycle', desc: 'Pull off 5 dekes in one game.', tier: 1, scope: 'game', stat: 'dekes', goal: 5 },
  { id: 'full-windup', title: 'Full wind-up', desc: 'Let rip a fully charged slapshot.', tier: 1, scope: 'career', stat: 'maxSlaps', goal: 1 },
  { id: 'victory-lap', title: 'Victory lap', desc: 'Win a game.', tier: 1, scope: 'career', stat: 'wins', goal: 1 },
  // ---- tier 2
  { id: 'no-hesitation', title: 'No hesitation', desc: 'Bury a one-timer.', tier: 2, scope: 'career', stat: 'oneTimerGoals', goal: 1 },
  { id: 'long-bomb', title: 'Long bomb', desc: 'Score on a slapshot fired from outside the attacking blue line.', tier: 2, scope: 'career', stat: 'longSlapGoals', goal: 1 },
  { id: 'demolition-shift', title: 'Demolition shift', desc: 'Land 5 big hits in one game.', tier: 2, scope: 'game', stat: 'bigHits', goal: 5 },
  { id: 'hot-hands', title: 'Hot hands', desc: 'Score while you are on fire.', tier: 2, scope: 'career', stat: 'fireGoals', goal: 1 },
  { id: 'table-setter', title: 'Table setter', desc: 'Feed a teammate for a one-timer goal.', tier: 2, scope: 'career', stat: 'oneTimerAssists', goal: 1 },
  { id: 'off-the-drop', title: 'Off the drop', desc: 'Score within 10 seconds of a puck drop.', tier: 2, scope: 'career', stat: 'quickGoals', goal: 1 },
  { id: 'sauce-boss', title: 'Sauce boss', desc: 'Rack up 3 assists in one game.', tier: 2, scope: 'game', stat: 'assists', goal: 3 },
  { id: 'overtime-outlaw', title: 'Overtime outlaw', desc: 'Win a game in sudden-death overtime.', tier: 2, scope: 'career', stat: 'otWins', goal: 1 },
  { id: 'brick-wall', title: 'Brick wall', desc: 'Win without giving up a single goal.', tier: 2, scope: 'career', stat: 'shutoutWins', goal: 1 },
  { id: 'no-mercy', title: 'No mercy', desc: 'Win by 4 or more goals.', tier: 2, scope: 'career', stat: 'blowoutWins', goal: 1 },
  { id: 'rink-rat', title: 'Rink rat', desc: 'Play 10 games through to the final horn.', tier: 2, scope: 'career', stat: 'games', goal: 10 },
  // ---- tier 3
  { id: 'three-alarm', title: 'Three-alarm', desc: 'Score 3 goals in one game.', tier: 3, scope: 'game', stat: 'goals', goal: 3 },
  { id: 'glaziers-nightmare', title: "Glazier's nightmare", desc: 'Shatter the glass 3 times in one game.', tier: 3, scope: 'game', stat: 'glass', goal: 3 },
  { id: 'rise-from-the-slush', title: 'Rise from the slush', desc: 'Win a game after trailing by 2 or more.', tier: 3, scope: 'career', stat: 'comebackWins', goal: 1 },
  { id: 'beat-the-horn', title: 'Beat the horn', desc: 'Score with 5 seconds or less left on the period clock.', tier: 3, scope: 'career', stat: 'hornGoals', goal: 1 },
  { id: 'wrecking-ball', title: 'Human wrecking ball', desc: 'Deliver 100 career hits.', tier: 3, scope: 'career', stat: 'hits', goal: 100 },
  { id: 'quarter-century', title: 'Quarter century', desc: 'Score 25 career goals.', tier: 3, scope: 'career', stat: 'goals', goal: 25 },
].map((c) => Object.freeze(c));
Object.freeze(CHALLENGES);

// Hidden challenges: not part of the 25, shown as "Secret / ???" until cleared. The tier only
// picks the colour of the cleared card and the toast.
export const SECRETS = [
  { id: 'heavyweight', title: 'Heavyweight', desc: 'Win a fight.', tier: 2, scope: 'career', stat: 'fightWins', goal: 1, secret: true },
  { id: 'bar-down', title: 'Bar down', desc: 'Ring the post 3 times in one game.', tier: 2, scope: 'game', stat: 'posts', goal: 3, secret: true },
  { id: 'night-shift', title: 'Night shift', desc: 'Finish a game between midnight and 5 am.', tier: 1, scope: 'career', stat: 'nightGames', goal: 1, secret: true },
  { id: 'glass-and-gas', title: 'Glass and gas', desc: 'Score within 10 seconds of shattering the glass yourself.', tier: 3, scope: 'career', stat: 'glassGoals', goal: 1, secret: true },
  { id: 'spectator-sport', title: 'Spectator sport', desc: 'Watch a whole game from the stands, through to the final horn.', tier: 1, scope: 'career', stat: 'spectated', goal: 1, secret: true },
].map((c) => Object.freeze(c));
Object.freeze(SECRETS);

export const ALL_CHALLENGES = Object.freeze([...CHALLENGES, ...SECRETS]);

export const GAME_STATS = ['goals', 'assists', 'bigHits', 'glass', 'steals', 'dekes', 'posts'];
export const CAREER_STATS = [
  'goals', 'assists', 'hits', 'bigHits', 'glass', 'steals', 'dekes', 'fires', 'maxSlaps',
  'oneTimerGoals', 'longSlapGoals', 'fireGoals', 'oneTimerAssists', 'quickGoals', 'hornGoals',
  'games', 'wins', 'otWins', 'shutoutWins', 'blowoutWins', 'comebackWins',
  'fightWins', 'posts', 'nightGames', 'glassGoals', 'spectated',
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
  postShotSecs: 2,       // BAR DOWN: a POST is credited to a SHOT at most this old
  glassGoalSecs: 10,     // GLASS AND GAS: goal at most this long after my own glass shatter
  nightFromHour: 0,      // NIGHT SHIFT: local hour in [from, to)
  nightToHour: 5,
  spectateStartSecs: 20, // SPECTATOR SPORT: first state of the game seen within this of the opening...
  spectateMinSecs: 60,   // ...and at least this much game watched (the shortest game is 3 x 60 s)
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
const BY_ID = new Map(ALL_CHALLENGES.map((c) => [c.id, c]));

function freshTrack(myId = 0) {
  return {
    started: false,      // a state of the current game has been seen
    sawStart: false,     // ...and the first one was the opening of the game (SPECTATOR SPORT)
    firstTick: 0,        // tick of that first state
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
    lastShot: null,      // { mine, tick } of the latest SHOT by anyone, until the puck is touched (BAR DOWN)
    glassTick: null,     // tick of my latest glass shatter (GLASS AND GAS)
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
    now: 0,                          // caller clock of the current step (not saved)
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
// returned at most once, ever). `now` is the unlock timestamp and the NIGHT SHIFT clock.
export function stepProgress(m, events, state, ctx = {}, now = 0) {
  m.now = num(now);
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
  // The state is never older than the events it comes with: a puck owner now means the latest
  // shot was picked up, so a later POST is not off that shot.
  if (st && st.k && typeof st.k === 'object' && num(st.k.o, -1) >= 0) t.lastShot = null;
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
    t.firstTick = tick;
    t.sawStart = Number.isFinite(st.tick) && st.per === 1 && !!sc && sc[0] === 0 && sc[1] === 0
      && tick <= RULES.spectateStartSecs * TICK_RATE && st.ph !== PHASE.GAME_OVER;
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
      t.lastShot = isId(e.by) ? { mine: mine(e.by), tick: t.tick } : null;
      if (!mine(e.by)) break;
      t.shots[e.by] = { kind: e.kind, x: typeof e.x === 'number' ? e.x : posX(e.by), tick: t.tick };
      if (e.kind === 'slap' && num(e.power) >= RULES.fullSlapPower) bump(m, 'maxSlaps');
      break;
    case EVENT.POST: {
      const s = t.lastShot;
      t.lastShot = null;                                              // one shot, one post
      if (s && s.mine && t.tick - s.tick <= RULES.postShotSecs * TICK_RATE) bumpBoth(m, 'posts');
      break;
    }
    case EVENT.PASS: case EVENT.SAVE: case EVENT.WHISTLE: t.lastShot = null; break;
    case EVENT.GOAL: onGoal(m, e); t.lastShot = null; break;
    case EVENT.HIT:
      if (!mine(e.by)) break;
      bump(m, 'hits');
      if (e.big) bumpBoth(m, 'bigHits');
      break;
    case EVENT.GLASS: if (mine(e.by)) { bumpBoth(m, 'glass'); t.glassTick = t.tick; } break;
    case EVENT.STEAL: t.lastShot = null; if (mine(e.by)) bumpBoth(m, 'steals'); break;
    case EVENT.DEKE: if (mine(e.by)) bumpBoth(m, 'dekes'); break;
    case EVENT.FIRE:
      if (!isId(e.player)) break;
      if (e.on) {
        if (!t.fire.has(e.player) && mine(e.player)) bump(m, 'fires');
        t.fire.add(e.player);
      } else t.fire.delete(e.player);
      break;
    case FIGHT_END: if (mine(e.winner)) bump(m, 'fightWins'); break;
    case EVENT.FACEOFF: t.faceoffTick = t.tick; t.lastShot = null; break;
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
    if (t.glassTick !== null && t.tick - t.glassTick <= RULES.glassGoalSecs * TICK_RATE) bump(m, 'glassGoals');
  }
  if (mineAssist) {
    bumpBoth(m, 'assists');
    if (oneTimer) bump(m, 'oneTimerAssists');
  }
  if (scorer >= 0) delete t.shots[scorer];
  t.faceoffTick = null;
}

// Local hour of a ms timestamp, or -1 when there is no usable clock.
function localHour(ms) {
  if (!(typeof ms === 'number' && Number.isFinite(ms) && ms > 0)) return -1;
  const h = new Date(ms).getHours();
  return Number.isInteger(h) ? h : -1;
}

function finalizeGame(m, sc) {
  const t = m.t;
  if (t.finalized) return;
  t.finalized = true;
  if (!t.played || (t.team !== 0 && t.team !== 1)) {             // spectated: no game credit...
    if (!t.played && t.myId > 0 && t.sawStart                   // ...unless watched start to finish
      && t.lastTick - t.firstTick >= RULES.spectateMinSecs * TICK_RATE) bump(m, 'spectated');
    return;
  }
  bump(m, 'games');
  const h = localHour(m.now);
  if (h >= RULES.nightFromHour && h < RULES.nightToHour) bump(m, 'nightGames');
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
  for (const ch of ALL_CHALLENGES) {
    if (hasOwn(m.unlocked, ch.id)) continue;
    if (progressOf(m, ch) >= ch.goal) {
      m.unlocked[ch.id] = num(now);
      m.dirty = true;
      fresh.push(ch.id);
    }
  }
  return fresh;
}

// Counts for the header / top bar: the 25 and the secrets are separate.
export function summarize(items) {
  const main = items.filter((c) => !c.secret);
  const secrets = items.filter((c) => c.secret);
  const tiers = [1, 2, 3].map((n) => {
    const all = main.filter((c) => c.tier === n);
    return { tier: n, total: all.length, done: all.filter((c) => c.unlocked).length };
  });
  return {
    done: main.filter((c) => c.unlocked).length, total: main.length,
    open: main.filter((c) => !c.unlocked).length, tiers,
    secretsDone: secrets.filter((c) => c.unlocked).length, secretsTotal: secrets.length,
  };
}

// "Cleared 12 min ago" for recent unlocks, "Cleared Nov 14" after that.
export function clearedLabel(ts, nowMs) {
  if (!(typeof ts === 'number' && Number.isFinite(ts) && ts > 0)) return 'Cleared';
  const d = num(nowMs) - ts;
  if (d >= 0 && d < 60e3) return 'Cleared just now';
  if (d >= 0 && d < 3600e3) return `Cleared ${Math.floor(d / 60e3)} min ago`;
  if (d >= 0 && d < 6 * 3600e3) return `Cleared ${Math.floor(d / 3600e3)} h ago`;
  try {
    const at = new Date(ts), ref = new Date(num(nowMs));
    const opts = { month: 'short', day: 'numeric' };
    if (at.getFullYear() !== ref.getFullYear()) opts.year = 'numeric';
    return `Cleared ${at.toLocaleDateString('en-US', opts)}`;
  } catch { return 'Cleared'; }
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
  onOpen = null,                  // optional () => void when the sheet opens (e.g. suppress game input)
  onClose = null,                 // optional () => void when it closes
  now = () => Date.now(),
} = {}) {
  let disposed = false;
  let model = createProgress(readSaved());
  const sessionNew = new Set();   // ids unlocked since this instance started ("New" chip)
  const listeners = new Set();
  const clock = () => { try { return num(now(), 0); } catch { return 0; } };
  let ui = container ? createUi(container, { toastMs, now: clock, onOpen, onClose }) : null;
  const viewUi = () => (ui ||= createUi(null, { toastMs, now: clock, onOpen, onClose }));

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
    return {
      ...ch, secret: !!ch.secret, unlocked, unlockedAt: unlocked ? model.unlocked[ch.id] : null,
      isNew: unlocked && sessionNew.has(ch.id), progress: unlocked ? ch.goal : progressOf(model, ch), goal: ch.goal,
    };
  }
  function list() { return ALL_CHALLENGES.map(entry); }
  function progress() {
    const s = summarize(list());
    return { done: s.done, total: s.total, secretsDone: s.secretsDone, secretsTotal: s.secretsTotal };
  }
  function changed() {
    if (ui) ui.refresh(list());
    if (!listeners.size) return;
    const p = progress();
    for (const fn of [...listeners]) { try { fn(p); } catch { /* caller bug */ } }
  }

  return {
    handle(events, state, ctx = {}) {
      if (disposed) return [];
      let ids = [];
      try { ids = stepProgress(model, events, state, ctx || {}, clock()); } catch { ids = []; }   // never take the game loop down
      if (model.dirty) save();
      for (const id of ids) sessionNew.add(id);
      const fresh = ids.map((id) => entry(BY_ID.get(id)));
      for (const ch of fresh) {
        if (ui) ui.toast(ch);
        if (typeof onUnlock === 'function') { try { onUnlock(ch); } catch { /* caller bug */ } }
      }
      if (fresh.length) changed();
      return fresh;
    },
    list,
    progress,
    onProgress(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    mountView(el) { if (el && !disposed) viewUi().mount(el, list()); },
    openPanel() { if (ui && !disposed) ui.open(list()); },
    closePanel() { if (ui) ui.close(); },
    isPanelOpen() { return !!(ui && ui.isOpen()); },
    reset() {
      const t = model.t;
      model = createProgress(null);
      model.t = t;                       // keep game tracking (ownership, phase) going
      model.game = zeroes(GAME_STATS);
      sessionNew.clear();
      if (storage) { try { storage.removeItem(storageKey); } catch { /* ignore */ } }
      model.dirty = false;
      if (ui) ui.clearToasts();
      changed();
    },
    dispose() {
      disposed = true;
      if (model.dirty) save();
      listeners.clear();
      if (ui) ui.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// DOM: toasts, the lobby view, the sheet
// ---------------------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Glyphs (14 px boxes, strokes as drawn in the Coqui frames).
const CHECK_SVG = '<svg class="ir-ach-glyph" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.8 7.35 L5.6 10.15 L11.2 4.55" style="fill:none;stroke:var(--c);stroke-width:1.54px;stroke-linecap:round;stroke-linejoin:round"/></svg>';
// Locked secret: the canvas lock (filled body + shackle, ink-3). Cleared secret toast: the open lock in ice.
const LOCK_SVG = '<svg class="ir-ach-glyph" viewBox="0 0 14 14" aria-hidden="true"><rect x="3" y="6.5" width="8" height="5.5" rx="1.3" style="fill:var(--ach-ink-3)"/><path d="M4.8 6.5V4.8a2.2 2.2 0 0 1 4.4 0V6.5" style="fill:none;stroke:var(--ach-ink-3);stroke-width:1.4px"/></svg>';
const OPEN_LOCK_SVG = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><rect x="3.57" y="9.29" width="12.86" height="8.57" rx="2.14" style="fill:var(--ach-ice)"/><path d="M6.57 9.29V6C6.56 4.29 7.81 2.84 9.49 2.59C11.18 2.34 12.8 3.36 13.28 5" style="fill:none;stroke:var(--ach-ice);stroke-width:2px;stroke-linecap:round"/></svg>';
const CLOSE_SVG = '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

const CSS = `
.ir-ach-root,.ir-ach-view{
  --ach-ground:var(--ground,#0A0F1C);--ach-surface:var(--surface,#111829);--ach-surface-2:var(--surface-2,#172034);
  --ach-surface-3:var(--surface-3,#1E2940);--ach-hairline:var(--hairline,#253049);--ach-hairline-strong:var(--hairline-strong,#34425F);
  --ach-ink:var(--ink,#E8EDF5);--ach-ink-2:var(--ink-2,#A1ACC0);--ach-ink-3:var(--ink-3,#6A7590);--ach-focus:var(--focus,#E8EDF5);--ach-ice:var(--ice,#DCEAF6);
  --ach-t1:var(--tier-1,#8FB3D9);--ach-t2:var(--tier-2,#C08CFF);--ach-t3:var(--tier-3,#FFB547);
  --ach-r-sm:var(--r-sm,6px);--ach-r-md:var(--r-md,10px);--ach-r-lg:var(--r-lg,16px);
  font-family:var(--f-ui,Bahnschrift,"DIN Alternate","Segoe UI",sans-serif);font-size:13px;line-height:18px;font-weight:400;
  color:var(--ach-ink);-webkit-font-smoothing:antialiased;text-align:left}
.ir-ach-root *,.ir-ach-view *,.ir-ach-root *::before,.ir-ach-view *::before{box-sizing:border-box}
.ir-ach-t1{--c:var(--ach-t1)}.ir-ach-t2{--c:var(--ach-t2)}.ir-ach-t3{--c:var(--ach-t3)}
.ir-ach-root{position:fixed;inset:0;pointer-events:none;z-index:2147483000}

.ir-ach-toasts{position:absolute;top:96px;right:20px;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.ir-ach-toast{display:flex;align-items:center;gap:12px;width:376px;max-width:calc(100vw - 32px);padding:12px 14px;
  background:color-mix(in srgb,var(--c) 12%,var(--ach-surface));border:1px solid color-mix(in srgb,var(--c) 45%,var(--ach-surface));
  border-radius:var(--ach-r-lg);box-shadow:0 10px 24px rgba(3,6,14,.45);animation:ir-ach-in .2s ease-out both}
.ir-ach-toast.is-out{animation:ir-ach-out .12s ease-in both}
.ir-ach-tile{flex:none;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:var(--ach-r-md);
  background:color-mix(in srgb,var(--c) 25%,var(--ach-surface));color:var(--c);font-size:15px;font-weight:700;line-height:18px}
.ir-ach-tbody{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px}
.ir-ach-kicker,.ir-ach-tdesc{font-size:12px;line-height:14px;color:var(--ach-ink-2)}
.ir-ach-ttitle{font-size:17px;font-weight:700;line-height:20px;color:var(--ach-ink);overflow-wrap:anywhere}

.ir-ach-view{position:relative;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;gap:16px;padding:20px;
  background:var(--ach-surface);border:1px solid var(--ach-hairline);border-radius:var(--ach-r-lg);overflow:hidden}
.ir-ach-head{flex:none;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px}
.ir-ach-sum{flex:0 1 280px;min-width:200px;display:flex;flex-direction:column;gap:6px}
.ir-ach-count{display:flex;align-items:flex-start;gap:8px}
.ir-ach-big{font-size:28px;font-weight:700;font-style:italic;line-height:34px;letter-spacing:-.56px;color:var(--ach-ink)}
.ir-ach-of{font-size:13px;line-height:16px;color:var(--ach-ink-2)}
.ir-ach-meter{display:flex;gap:2px;height:6px}
.ir-ach-meter i{display:block;flex:1 1 0;min-width:0;border-radius:3px;background:var(--ach-surface-3)}
.ir-ach-meter i.is-done{background:var(--c)}
.ir-ach-seg{flex:none;display:flex;gap:2px;height:36px;padding:3px;max-width:100%;
  background:var(--ach-ground);border:1px solid var(--ach-hairline);border-radius:var(--ach-r-md)}
.ir-ach-seg button{appearance:none;margin:0;border:0;background:transparent;font:inherit;display:flex;align-items:center;gap:6px;
  padding:0 14px;border-radius:var(--ach-r-sm);font-size:13px;line-height:16px;color:var(--ach-ink-2);cursor:pointer;white-space:nowrap}
.ir-ach-seg button span{font-size:12px;line-height:14px;color:var(--ach-ink-3)}
.ir-ach-seg button:hover{color:var(--ach-ink)}
.ir-ach-seg button[aria-pressed="true"]{background:var(--ach-surface-3);color:var(--ach-ink)}
.ir-ach-seg button[aria-pressed="true"] span{color:var(--ach-ink-2)}
.ir-ach-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;
  margin-right:-14px;padding-right:6px;display:flex;flex-direction:column;gap:10px}
.ir-ach-scroll::-webkit-scrollbar{width:8px}
.ir-ach-scroll::-webkit-scrollbar-track{background:transparent}
.ir-ach-scroll::-webkit-scrollbar-thumb{background:var(--ach-hairline-strong);border-radius:4px}
@supports not selector(::-webkit-scrollbar){.ir-ach-scroll{scrollbar-width:thin;scrollbar-color:var(--ach-hairline-strong) transparent}}
.ir-ach-group{flex:none;display:flex;flex-direction:column;gap:10px}
.ir-ach-group+.ir-ach-group .ir-ach-gl{padding-top:6px}
.ir-ach-gl{font-size:12px;line-height:14px;color:var(--ach-ink-2)}
.ir-ach-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.ir-ach-card{display:flex;flex-direction:column;gap:5px;min-width:0;min-height:100px;padding:12px 14px;
  background:var(--ach-surface-2);border:1px solid var(--ach-hairline);border-radius:var(--ach-r-md)}
.ir-ach-card.is-done{background:color-mix(in srgb,var(--c) 9%,var(--ach-surface-2));border-color:color-mix(in srgb,var(--c) 30%,var(--ach-surface-2))}
.ir-ach-card.is-locked{background:transparent;border-style:dashed;border-color:var(--ach-hairline-strong)}
.ir-ach-card.is-secret{--c:var(--ach-ice);background:color-mix(in srgb,var(--ach-ice) 7%,var(--ach-surface-2));border-color:color-mix(in srgb,var(--ach-ice) 28%,var(--ach-surface-2))}
.ir-ach-toast.is-secret{background:color-mix(in srgb,var(--ach-ice) 10%,var(--ach-surface));border-color:color-mix(in srgb,var(--ach-ice) 30%,var(--ach-surface))}
.ir-ach-toast.is-secret .ir-ach-tile{background:color-mix(in srgb,var(--ach-ice) 18%,var(--ach-surface))}
.ir-ach-ctop{display:flex;align-items:center;gap:8px;min-height:17px}
.ir-ach-ctitle{flex:1 1 0;min-width:0;font-size:14px;font-weight:700;line-height:17px;color:var(--ach-ink);overflow-wrap:anywhere}
.ir-ach-card.is-locked .ir-ach-ctitle{color:var(--ach-ink-2)}
.ir-ach-glyph{flex:none;display:block;width:14px;height:14px}
.ir-ach-new{flex:none;display:flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;
  background:color-mix(in srgb,var(--c) 25%,var(--ach-surface-2));font-size:11px;line-height:13px;color:var(--ach-ink)}
.ir-ach-cdesc{font-size:12px;line-height:16px;color:var(--ach-ink-2)}
.ir-ach-card.is-locked .ir-ach-cdesc{color:var(--ach-ink-3)}
.ir-ach-cfoot{margin-top:auto;font-size:11px;line-height:13px;color:var(--ach-ink-3)}
.ir-ach-prog{display:flex;align-items:center;gap:8px}
.ir-ach-bar{flex:1 1 0;min-width:0;height:4px;border-radius:2px;background:var(--ach-surface-3);overflow:hidden}
.ir-ach-bar i{display:block;height:100%;border-radius:2px;background:var(--ach-ink-2)}
.ir-ach-prog span{flex:none;color:var(--ach-ink-2)}
.ir-ach-empty{padding:24px 0;color:var(--ach-ink-2)}

.ir-ach-scrim{position:absolute;inset:0;pointer-events:auto;background:rgba(10,15,28,.55);animation:ir-ach-fade .16s ease-out both}
.ir-ach-scrim.is-out{animation:ir-ach-fade-out .12s ease-in both}
.ir-ach-sheet{position:absolute;top:0;right:0;bottom:0;width:min(600px,100%);display:flex;flex-direction:column;pointer-events:auto;
  background:var(--ach-surface);box-shadow:-16px 0 40px rgba(3,6,14,.45),inset 1px 0 0 var(--ach-hairline-strong);
  animation:ir-ach-sheet-in .24s cubic-bezier(.2,.8,.2,1) both}
.ir-ach-sheet.is-out{animation:ir-ach-sheet-out .12s ease-in both}
.ir-ach-shead{flex:none;height:72px;display:flex;align-items:center;justify-content:space-between;padding:0 24px 0 25px}
.ir-ach-sh1{margin:0;font-size:22px;font-weight:700;line-height:26px;letter-spacing:-.22px;color:var(--ach-ink)}
.ir-ach-shctl{display:flex;align-items:center;gap:8px}
.ir-ach-esc{display:flex;align-items:center;height:20px;padding:0 6px;border-radius:4px;background:var(--ach-surface-3);
  font-size:11px;line-height:13px;color:var(--ach-ink-2)}
.ir-ach-x{appearance:none;margin:0;padding:0;font:inherit;width:34px;height:34px;display:flex;align-items:center;justify-content:center;
  background:transparent;border:1px solid var(--ach-hairline-strong);border-radius:var(--ach-r-md);color:var(--ach-ink);cursor:pointer}
.ir-ach-x:hover{background:var(--ach-surface-2)}
.ir-ach-seg button:focus,.ir-ach-x:focus,.ir-ach-scroll:focus{outline:none}
.ir-ach-seg button:focus-visible,.ir-ach-x:focus-visible,.ir-ach-scroll:focus-visible{outline:2px solid var(--ach-focus);outline-offset:2px}
.ir-ach-sbody{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:16px;padding:4px 24px 20px 25px}

@keyframes ir-ach-in{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}
@keyframes ir-ach-out{from{opacity:1;transform:none}to{opacity:0;transform:translateX(12px)}}
@keyframes ir-ach-fade{from{opacity:0}to{opacity:1}}
@keyframes ir-ach-fade-out{from{opacity:1}to{opacity:0}}
@keyframes ir-ach-sheet-in{from{transform:translateX(100%)}to{transform:none}}
@keyframes ir-ach-sheet-out{from{opacity:1;transform:none}to{opacity:0;transform:translateX(24px)}}
@media (max-width:560px){
  .ir-ach-toasts{top:calc(env(safe-area-inset-top,0px) + 8px);left:16px;right:16px;align-items:stretch}
  .ir-ach-toast{width:auto;max-width:none}
  .ir-ach-shead{padding:0 16px}
  .ir-ach-sbody{padding:4px 16px 16px}
  .ir-ach-view{padding:16px}
  .ir-ach-seg{flex-wrap:wrap;height:auto}
  .ir-ach-seg button{height:28px;padding:0 10px}
}
.ir-ach-ptitle{display:none}
/* phone portrait = the lobby's Challenges tab: same 56 px header and 44 px controls as the Leaders tab */
@media (max-width:600px),(orientation:portrait) and (pointer:coarse){
  .ir-ach-view{gap:12px;padding:0 16px;background:transparent;border:0;border-radius:0}
  .ir-ach-ptitle{flex:none;display:flex;align-items:center;height:56px;margin:0 0 -12px;font-size:17px;font-weight:700;line-height:20px;color:var(--ach-ink)}
  .ir-ach-big{font-size:22px;line-height:26px;letter-spacing:0}
  .ir-ach-sum{flex:1 1 auto;min-width:0}
  .ir-ach-view .ir-ach-seg{flex:1 1 100%;flex-wrap:nowrap;height:44px;overflow-x:auto;scrollbar-width:none;overscroll-behavior-x:contain}
  .ir-ach-view .ir-ach-seg::-webkit-scrollbar{display:none}
  .ir-ach-view .ir-ach-seg button{flex:none;height:auto;padding:0 12px}
  .ir-ach-scroll{margin-right:0;padding:0 0 16px}
}
@media (hover:none) and (pointer:coarse){.ir-ach-esc{display:none}}
@media (prefers-reduced-motion:reduce){
  .ir-ach-toast,.ir-ach-toast.is-out,.ir-ach-scrim,.ir-ach-scrim.is-out,.ir-ach-sheet,.ir-ach-sheet.is-out{animation:none}
}`;

const STYLE_ID = 'ir-ach-style';
const MAX_VISIBLE = 3;
const STAGGER_MS = 200;
const OUT_MS = 120;
const TICK_MS = 30000;           // relative "Cleared 12 min ago" labels refresh

const FILTERS = ['all', 't1', 't2', 't3', 'secrets', 'open'];
const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };

function ensureStyle(doc) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

function reducedMotion(doc) {
  try { return !!(doc.defaultView && doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
}

// ---- markup ----------------------------------------------------------------------------------

/** Card footer: "Cleared Nov 14", or "Secret · cleared Nov 14" on a revealed secret. */
function footLabel(secret, ts, nowMs) {
  const s = clearedLabel(ts, nowMs);
  return secret ? `Secret \u00b7 ${s.charAt(0).toLowerCase()}${s.slice(1)}` : s;
}

function cardHtml(c, nowMs) {
  if (c.secret && !c.unlocked) {
    return '<div class="ir-ach-card is-locked"><div class="ir-ach-ctop"><span class="ir-ach-ctitle">Secret</span>'
      + `${LOCK_SVG}</div><div class="ir-ach-cdesc">???</div><div class="ir-ach-cfoot">Keep playing</div></div>`;
  }
  const badge = c.unlocked ? (c.isNew ? '<span class="ir-ach-new">New</span>' : CHECK_SVG) : '';
  let foot;
  if (c.unlocked) {
    const pre = c.secret ? ' data-pre="Secret \u00b7 "' : '';
    foot = `<div class="ir-ach-cfoot" data-ts="${num(c.unlockedAt)}"${pre}>${esc(footLabel(c.secret, c.unlockedAt, nowMs))}</div>`;
  } else if (c.progress > 0 && c.goal > 1) {
    const pct = Math.max(0, Math.min(100, (c.progress / c.goal) * 100));
    foot = `<div class="ir-ach-cfoot ir-ach-prog"><div class="ir-ach-bar"><i style="width:${pct.toFixed(1)}%"></i></div>`
      + `<span>${c.scope === 'game' ? 'Best ' : ''}${c.progress}/${c.goal}</span></div>`;
  } else {
    foot = `<div class="ir-ach-cfoot">${c.scope === 'game' || c.goal === 1 ? 'In one game' : 'Career'}</div>`;
  }
  return `<div class="ir-ach-card ir-ach-t${c.tier}${c.unlocked ? ' is-done' : ''}${c.secret ? ' is-secret' : ''}" data-id="${esc(c.id)}">`
    + `<div class="ir-ach-ctop"><span class="ir-ach-ctitle">${esc(c.title)}</span>${badge}</div>`
    + `<div class="ir-ach-cdesc">${esc(c.desc)}</div>${foot}</div>`;
}

function headHtml(sum, filter) {
  const seg = [];
  for (const t of sum.tiers) {
    if (t.done) seg.push(`<i class="is-done ir-ach-t${t.tier}" style="flex-grow:${t.done}"></i>`);
    if (t.total - t.done) seg.push(`<i style="flex-grow:${t.total - t.done}"></i>`);
  }
  const btn = (key, label, extra) => `<button type="button" data-filter="${key}" aria-pressed="${filter === key}">`
    + `${label}${extra !== undefined ? `<span>${extra}</span>` : ''}</button>`;
  return '<div class="ir-ach-head"><div class="ir-ach-sum">'
    + `<div class="ir-ach-count"><span class="ir-ach-big">${sum.done}</span><span class="ir-ach-of">of ${sum.total} cleared</span></div>`
    + `<div class="ir-ach-meter" role="img" aria-label="${sum.done} of ${sum.total} cleared">${seg.join('')}</div></div>`
    + '<div class="ir-ach-seg" role="group" aria-label="Show">'
    + btn('all', 'All')
    + sum.tiers.map((t) => btn(`t${t.tier}`, `Tier ${ROMAN[t.tier]}`, `${t.done}/${t.total}`)).join('')
    + btn('secrets', 'Secrets', `${sum.secretsDone}/${sum.secretsTotal}`)
    + btn('open', 'Open', sum.open)
    + '</div></div>';
}

function groupsHtml(items, filter, nowMs) {
  const groups = [];
  for (const n of [1, 2, 3]) {
    if (filter !== 'all' && filter !== 'open' && filter !== `t${n}`) continue;
    let cards = items.filter((c) => !c.secret && c.tier === n);
    if (filter === 'open') cards = cards.filter((c) => !c.unlocked);
    if (cards.length) groups.push([`Tier ${ROMAN[n]}`, cards]);
  }
  if (filter === 'all' || filter === 'secrets') groups.push(['Secret', items.filter((c) => c.secret)]);
  if (!groups.length) return '<div class="ir-ach-empty">Nothing open. Every challenge is cleared.</div>';
  return groups.map(([label, cards]) => `<section class="ir-ach-group" aria-label="${label}"><div class="ir-ach-gl">${label}</div>`
    + `<div class="ir-ach-grid">${cards.map((c) => cardHtml(c, nowMs)).join('')}</div></section>`).join('');
}

// ---- UI --------------------------------------------------------------------------------------

function createUi(container, { toastMs, now, onOpen, onClose }) {
  const cdoc = container ? container.ownerDocument || globalThis.document : null;
  let root = null, toastsEl = null, sheet = null, lastFocus = null, lastItems = null;
  const surfaces = new Set();    // { root, scroll, filter, kind }
  const queue = [];
  const timers = new Set();
  let visible = 0, staggerTimer = 0, tickTimer = 0;

  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };

  function ensureRoot() {
    if (root || !cdoc) return !!root;
    ensureStyle(cdoc);
    root = cdoc.createElement('div');
    root.className = 'ir-ach-root';
    toastsEl = cdoc.createElement('div');
    toastsEl.className = 'ir-ach-toasts';
    toastsEl.setAttribute('role', 'status');
    toastsEl.setAttribute('aria-live', 'polite');
    root.appendChild(toastsEl);
    container.appendChild(root);
    return true;
  }

  // ---- toasts
  function pump() {
    if (staggerTimer || visible >= MAX_VISIBLE || !queue.length || !toastsEl) return;
    const ch = queue.shift();
    visible++;
    const el = cdoc.createElement('div');
    el.className = `ir-ach-toast ir-ach-t${ch.tier}${ch.secret ? ' is-secret' : ''}`;
    el.innerHTML = `<div class="ir-ach-tile" aria-hidden="true">${ch.secret ? OPEN_LOCK_SVG : esc(ROMAN[ch.tier] || ch.tier)}</div>`
      + `<div class="ir-ach-tbody"><div class="ir-ach-kicker">${ch.secret ? 'Secret challenge cleared' : 'Challenge cleared'}</div>`
      + `<div class="ir-ach-ttitle">${esc(ch.title)}</div><div class="ir-ach-tdesc">${esc(ch.desc)}</div></div>`;
    toastsEl.appendChild(el);
    const hold = queue.length > MAX_VISIBLE ? Math.min(toastMs, 2200) : toastMs;   // hurry a long backlog
    later(() => {
      el.classList.add('is-out');
      later(() => { el.remove(); visible--; pump(); }, reducedMotion(cdoc) ? 0 : OUT_MS);
    }, hold);
    staggerTimer = later(() => { staggerTimer = 0; pump(); }, STAGGER_MS);
  }

  function clearToasts() {
    queue.length = 0;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    staggerTimer = 0;
    visible = 0;
    if (toastsEl) toastsEl.textContent = '';
    if (sheet && sheet.closing) finishClose();       // a close animation timer was just cancelled
  }

  // ---- surfaces (lobby view + sheet body share the markup)
  function renderSurface(s, items) {
    const keep = s.scroll ? s.scroll.scrollTop : 0;
    const sum = summarize(items);
    s.root.querySelector('[data-part="head"]').innerHTML = headHtml(sum, s.filter);
    const scroll = s.root.querySelector('.ir-ach-scroll');
    scroll.innerHTML = groupsHtml(items, s.filter, now());
    scroll.scrollTop = s.resetScroll ? 0 : keep;
    s.resetScroll = false;
    s.scroll = scroll;
  }

  function makeSurface(host, kind) {
    const doc = host.ownerDocument;
    const s = { root: host, scroll: null, filter: 'all', kind, resetScroll: false };
    // phone portrait: the lobby's Challenges tab has no top bar above it, so the view names itself
    host.innerHTML = (kind === 'view' ? '<h2 class="ir-ach-ptitle">Challenges</h2>' : '')
      + '<div data-part="head" style="display:contents"></div>'
      + '<div class="ir-ach-scroll" tabindex="0" aria-label="Challenges"></div>';
    host.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-filter]') : null;
      if (!b || !host.contains(b)) return;
      const f = b.getAttribute('data-filter');
      if (!FILTERS.includes(f) || f === s.filter) return;
      s.filter = f;
      s.resetScroll = true;
      renderSurface(s, lastItems || []);
      const again = host.querySelector(`[data-filter="${f}"]`);
      if (again && doc.activeElement !== again) { try { again.focus({ preventScroll: true }); } catch { /* ignore */ } }
    });
    surfaces.add(s);
    startTick();
    return s;
  }

  function mount(el, items) {
    lastItems = items;
    const doc = el.ownerDocument || globalThis.document;
    ensureStyle(doc);
    let s = [...surfaces].find((x) => x.kind === 'view' && x.host === el && x.root.parentNode === el);
    if (!s) {
      for (const x of surfaces) if (x.kind === 'view' && x.host === el) surfaces.delete(x);
      const view = doc.createElement('div');
      view.className = 'ir-ach-view';
      view.setAttribute('role', 'region');
      view.setAttribute('aria-label', 'Challenges');
      el.replaceChildren(view);
      s = makeSurface(view, 'view');
      s.host = el;
    }
    renderSurface(s, items);
  }

  function refresh(items) {
    lastItems = items;
    for (const s of [...surfaces]) {
      if (s.kind === 'view' && !s.root.isConnected) { surfaces.delete(s); continue; }
      renderSurface(s, items);
    }
    stopTickIfIdle();
  }

  function updateTimes() {
    const t = now();
    for (const s of [...surfaces]) {
      if (!s.root.isConnected) { if (s.kind === 'view') surfaces.delete(s); continue; }
      for (const f of s.root.querySelectorAll('[data-ts]')) {
        const label = footLabel(f.hasAttribute('data-pre'), Number(f.getAttribute('data-ts')), t);
        if (f.textContent !== label) f.textContent = label;
      }
    }
    stopTickIfIdle();
  }
  function startTick() { if (!tickTimer) tickTimer = setInterval(updateTimes, TICK_MS); }
  function stopTickIfIdle() { if (tickTimer && !surfaces.size) { clearInterval(tickTimer); tickTimer = 0; } }

  // ---- sheet
  function focusables() {
    return sheet ? [...sheet.el.querySelectorAll('button,[tabindex="0"]')].filter((n) => !n.disabled) : [];
  }
  function onKey(e) {
    if (!sheet || sheet.closing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const i = f.indexOf(cdoc.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
    }
  }

  function open(items) {
    lastItems = items;
    if (!ensureRoot()) return;
    if (sheet && sheet.closing) finishClose();
    if (!sheet) {
      lastFocus = cdoc.activeElement;
      const scrim = cdoc.createElement('div');
      scrim.className = 'ir-ach-scrim';
      scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
      const el = cdoc.createElement('div');
      el.className = 'ir-ach-sheet';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'ir-ach-sheet-title');
      el.innerHTML = '<div class="ir-ach-shead"><h2 class="ir-ach-sh1" id="ir-ach-sheet-title">Challenges</h2>'
        + `<div class="ir-ach-shctl"><span class="ir-ach-esc" aria-hidden="true">Esc</span><button type="button" class="ir-ach-x" aria-label="Close challenges">${CLOSE_SVG}</button></div></div>`
        + '<div class="ir-ach-sbody"></div>';
      el.querySelector('.ir-ach-x').addEventListener('click', () => close());
      root.insertBefore(scrim, toastsEl);           // toasts stay on top of the sheet
      root.insertBefore(el, toastsEl);
      const surface = makeSurface(el.querySelector('.ir-ach-sbody'), 'sheet');
      sheet = { el, scrim, surface, closing: false };
      cdoc.addEventListener('keydown', onKey, true);
      if (typeof onOpen === 'function') { try { onOpen(); } catch { /* caller bug */ } }
    }
    renderSurface(sheet.surface, items);
    try { sheet.el.querySelector('.ir-ach-x').focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  function finishClose() {
    if (!sheet) return;
    const { el, scrim, surface } = sheet;
    surfaces.delete(surface);
    el.remove(); scrim.remove();
    sheet = null;
    stopTickIfIdle();
  }

  function close() {
    if (!sheet || sheet.closing) return;
    sheet.closing = true;
    cdoc.removeEventListener('keydown', onKey, true);
    sheet.el.classList.add('is-out');
    sheet.scrim.classList.add('is-out');
    if (reducedMotion(cdoc)) finishClose(); else later(finishClose, OUT_MS);
    try { if (lastFocus && lastFocus.focus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    lastFocus = null;
    if (typeof onClose === 'function') { try { onClose(); } catch { /* caller bug */ } }
  }

  return {
    toast(ch) { if (!ensureRoot()) return; queue.push(ch); pump(); },
    isOpen: () => !!(sheet && !sheet.closing),
    open, close, mount, refresh, clearToasts,
    dispose() {
      if (sheet && !sheet.closing) close();
      clearToasts();
      finishClose();
      for (const s of surfaces) if (s.kind === 'view') s.root.remove();
      surfaces.clear();
      stopTickIfIdle();
      if (root) root.remove();
      root = toastsEl = null;
      // Leave the shared <style> unless no other instance is using it.
      for (const d of new Set([cdoc, globalThis.document].filter(Boolean))) {
        if (!d.querySelector('.ir-ach-root,.ir-ach-view')) d.getElementById(STYLE_ID)?.remove();
      }
    },
  };
}
