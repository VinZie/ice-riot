// ICE RIOT - challenges tests. Run: node test/achievements.test.js  (exit code 1 on failure)
import {
  createAchievements, CHALLENGES, SECRETS, ALL_CHALLENGES, GAME_STATS, CAREER_STATS, RULES, STORAGE_KEY,
  createProgress, stepProgress, serializeProgress, summarize, clearedLabel,
} from '../public/achievements.js';
import { PHASE, EVENT, TICK_RATE, DT } from '../shared/constants.js';
import { createGame, step, snapshot, drainEvents } from '../shared/sim.js';
import { EV_FIGHT_END } from '../shared/sim-fight.js';
import { FL_SHOT } from '../shared/sim-util.js';

let passes = 0, failures = 0;
function test(name, fn) {
  try { fn(); passes++; console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e}`); }
}
function eq(a, b, msg = 'value') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg}: expected ${B}, got ${A}`);
}
function ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); }

// ------------------------------------------------------------------------------------ helpers

function memStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    map, writes: 0,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { this.writes++; map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

function makeState() {
  return {
    tick: 0, ph: PHASE.FACEOFF, phT: 1.6, per: 1, clk: 120, sc: [0, 0], teams: [0, 1],
    p: Array.from({ length: 8 }, (_, i) => ({
      id: i, tm: i >> 2, g: (i & 3) === 3 ? 1 : 0, x: i >> 2 ? 10 : -10, y: 0, z: 0, vx: 0, vz: 0,
      f: 0, s: 0, sT: 0, tb: 1, fire: 0, ch: 0, c: 0, n: 10 + i,
    })),
    k: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, o: -1 },
    gl: [],
  };
}

const ME = 7, OTHER = 9;
const ev = (type, fields = {}) => ({ type, ...fields });
// Local wall-clock times (getHours() sees exactly these hours whatever the machine's time zone).
const at = (h, min = 0) => new Date(2026, 10, 21, h, min).getTime();
const NIGHT = at(2, 30), DAY = at(14, 0);

// A scripted client: keeps a Snapshot-shaped state, feeds it with events into handle().
class Rig {
  constructor({ storage = memStorage(), ctl = 0, myId = ME, periods, onUnlock, clock = 1234567, init } = {}) {
    this.storage = storage;
    this.myId = myId;
    this.periods = periods;
    this.clock = clock;
    this.ach = createAchievements({ storage, container: null, now: () => this.clock, onUnlock });
    this.st = makeState();
    if (ctl >= 0) this.st.p[ctl].c = myId;
    if (init) init(this.st);                          // shape of the first state this client sees
    this.unlocks = [];
    this.feed([]);
  }
  feed(events = [], ticks = 2) {
    this.st.tick += ticks;
    const ctx = { myId: this.myId };
    if (this.periods) ctx.periods = this.periods;
    const fresh = this.ach.handle(events, structuredClone(this.st), ctx);
    this.unlocks.push(...fresh.map((c) => c.id));
    return fresh;
  }
  me() { return this.st.p.findIndex((p) => p.c === this.myId); }
  setControl(id, client = this.myId) {
    for (const p of this.st.p) if (p.c === client) p.c = 0;
    if (id >= 0) this.st.p[id].c = client;
  }
  advance(secs) { this.feed([], Math.round(secs * TICK_RATE)); }
  drop() { this.st.ph = PHASE.PLAY; this.feed([ev(EVENT.FACEOFF, { x: 0, z: 0 })]); }
  shot(kind = 'wrist', power = 0.6, by = this.me()) { this.st.ph = PHASE.PLAY; this.feed([ev(EVENT.SHOT, { by, power, kind })]); }
  goal({ scorer = this.me(), assist = -1, oneTimer = false, team } = {}) {
    team ??= scorer >> 2;
    this.st.sc[team]++;
    this.st.ph = PHASE.GOAL;
    this.feed([ev(EVENT.GOAL, { team, scorer, assist, oneTimer, x: team ? -26.7 : 26.7, z: 0 })]);
    this.st.ph = PHASE.PLAY;
    this.advance(4);
  }
  hit(big = false, by = this.me(), target = 5) { this.feed([ev(EVENT.HIT, { by, target, power: big ? 1 : 0.4, big: big ? 1 : 0, x: 0, z: 12 })]); }
  glass(by = this.me()) { this.feed([ev(EVENT.HIT, { by, target: 5, power: 1, big: 1, x: 0, z: 12.5 }), ev(EVENT.GLASS, { panel: 5, by, target: 5, x: 0, z: 13 })]); }
  steal(by = this.me()) { this.feed([ev(EVENT.STEAL, { by, from: 5 })]); }
  deke(by = this.me()) { this.feed([ev(EVENT.DEKE, { by })]); }
  fire(on = true, player = this.me()) { this.st.p[player].fire = on ? 1 : 0; this.feed([ev(EVENT.FIRE, { player, on: on ? 1 : 0 })]); }
  post() { this.feed([ev(EVENT.POST, { x: 26.6, z: 0.9 })]); }
  ringPost(by = this.me()) { this.shot('wrist', 0.7, by); this.advance(0.3); this.post(); }
  fightEnd(winner = this.me(), loser = 5) { this.feed([ev(EV_FIGHT_END, { winner, loser, how: 'ko' })]); }
  endGame({ ot = false } = {}) {
    if (ot) { this.st.per = 4; this.feed([ev(EVENT.PERIOD, { period: 4 })]); }
    this.st.ph = PHASE.GAME_OVER;
    this.feed([ev(EVENT.FINAL, { score: [...this.st.sc] })]);
    this.advance(2);
  }
  // Score goals for each side, then end the game. Opponent goals go in first.
  play(mine, theirs, opts) {
    const myTeam = this.me() >> 2;
    const opp = myTeam ? 0 : 4;
    for (let i = 0; i < theirs; i++) this.goal({ scorer: opp });
    for (let i = 0; i < mine; i++) this.goal();
    this.endGame(opts);
  }
  newGame({ keepTick = false, ctl } = {}) {
    const tick = this.st.tick;
    const c = ctl ?? this.me();
    this.st = makeState();
    if (keepTick) this.st.tick = tick;
    if (c >= 0) this.st.p[c].c = this.myId;
    this.feed([]);
  }
  entry(id) { const e = this.ach.list().find((c) => c.id === id); if (!e) throw new Error(`no challenge ${id}`); return e; }
  unlocked(id) { return this.entry(id).unlocked; }
  progress(id) { return this.entry(id).progress; }
}

// One synthetic stream per challenge. The coverage test fails if a challenge has none.
const SCENARIOS = {
  'lamp-lighter': (r) => r.goal(),
  'bone-rattler': (r) => r.hit(true),
  'pane-in-the-glass': (r) => r.glass(),
  'ignition': (r) => r.fire(true),
  'pickpocket': (r) => { for (let i = 0; i < 3; i++) r.steal(); },
  'spin-cycle': (r) => { for (let i = 0; i < 5; i++) r.deke(); },
  'full-windup': (r) => r.shot('slap', 1),
  'victory-lap': (r) => r.play(2, 1),
  'no-hesitation': (r) => {
    r.feed([ev(EVENT.PASS, { by: 1, to: 0 })]);
    r.shot('onetimer', 1);
    r.goal({ oneTimer: true, assist: 1 });
  },
  'long-bomb': (r) => { r.st.p[0].x = 2; r.shot('slap', 0.9); r.goal(); },
  'demolition-shift': (r) => { for (let i = 0; i < 5; i++) r.hit(true); },
  'hot-hands': (r) => { r.fire(true); r.shot('wrist'); r.goal(); },
  'table-setter': (r) => { r.feed([ev(EVENT.PASS, { by: 0, to: 2 })]); r.goal({ scorer: 2, assist: 0, oneTimer: true }); },
  'off-the-drop': (r) => { r.drop(); r.advance(6); r.goal(); },
  'sauce-boss': (r) => { for (let i = 0; i < 3; i++) r.goal({ scorer: 1, assist: 0 }); },
  'overtime-outlaw': (r) => r.play(1, 0, { ot: true }),
  'brick-wall': (r) => r.play(1, 0),
  'no-mercy': (r) => r.play(5, 1),
  'rink-rat': (r) => { for (let g = 0; g < 10; g++) { if (g) r.newGame(); r.play(0, 1); } },
  'three-alarm': (r) => { for (let i = 0; i < 3; i++) r.goal(); },
  'glaziers-nightmare': (r) => { for (let i = 0; i < 3; i++) r.glass(); },
  'rise-from-the-slush': (r) => { r.goal({ scorer: 4 }); r.goal({ scorer: 4 }); r.goal(); r.goal(); r.goal(); r.endGame(); },
  'beat-the-horn': (r) => { r.st.ph = PHASE.PLAY; r.st.clk = 3.2; r.feed([]); r.goal(); },
  'wrecking-ball': (r) => { for (let i = 0; i < 100; i++) r.hit(i % 3 === 0); },
  'quarter-century': (r) => {
    for (let g = 0; g < 5; g++) { if (g) r.newGame(); for (let i = 0; i < 5; i++) r.goal(); r.endGame(); }
  },
  // ---- secrets
  'heavyweight': (r) => r.fightEnd(),
  'bar-down': (r) => { for (let i = 0; i < 3; i++) r.ringPost(); },
  'night-shift': (r) => { r.clock = NIGHT; r.play(1, 2); },
  'glass-and-gas': (r) => { r.glass(); r.advance(RULES.glassGoalSecs - 2); r.goal(); },
  'spectator-sport': (r) => {
    r.advance(1);
    r.setControl(-1);
    r.newGame({ ctl: -1 });                           // the next game, from the stands
    r.goal({ scorer: 0 }); r.goal({ scorer: 4 }); r.goal({ scorer: 4 });
    r.advance(RULES.spectateMinSecs + 30);
    r.endGame();
  },
};

// ------------------------------------------------------------------------------------ data

test('challenge table is well formed', () => {
  ok(CHALLENGES.length >= 20, `only ${CHALLENGES.length} challenges`);
  const ids = new Set();
  for (const c of CHALLENGES) {
    ok(typeof c.id === 'string' && c.id && !ids.has(c.id), `bad/duplicate id ${c.id}`);
    ids.add(c.id);
    ok(c.title && c.desc, `${c.id}: title/desc`);
    ok([1, 2, 3].includes(c.tier), `${c.id}: tier`);
    ok(Number.isInteger(c.goal) && c.goal >= 1, `${c.id}: goal`);
    ok(c.scope === 'game' ? GAME_STATS.includes(c.stat) : c.scope === 'career' && CAREER_STATS.includes(c.stat), `${c.id}: scope/stat`);
  }
  for (const t of [1, 2, 3]) ok(CHALLENGES.some((c) => c.tier === t), `no tier ${t}`);
  ok(CHALLENGES.some((c) => c.scope === 'game') && CHALLENGES.some((c) => c.scope === 'career'), 'mix of scopes');
  // the lobby header is "of 25 cleared" with Tier I x/8 · Tier II x/11 · Tier III x/6
  eq(CHALLENGES.length, 25, 'the 25');
  eq([1, 2, 3].map((t) => CHALLENGES.filter((c) => c.tier === t).length), [8, 11, 6], 'per tier');
  ok(CHALLENGES.every((c) => !c.secret), 'no secret among the 25');
});

test('secret table: 5 hidden challenges, separate from the 25, same rules', () => {
  eq(SECRETS.length, 5, 'five secrets');
  eq(ALL_CHALLENGES.length, CHALLENGES.length + SECRETS.length, 'ALL = 25 + secrets');
  eq(new Set(ALL_CHALLENGES.map((c) => c.id)).size, ALL_CHALLENGES.length, 'ids unique across both');
  for (const c of SECRETS) {
    ok(c.secret === true, `${c.id} flagged secret`);
    ok(c.title && c.desc && [1, 2, 3].includes(c.tier) && Number.isInteger(c.goal) && c.goal >= 1, `${c.id} fields`);
    ok(c.scope === 'game' ? GAME_STATS.includes(c.stat) : c.scope === 'career' && CAREER_STATS.includes(c.stat), `${c.id}: scope/stat`);
  }
  eq(SECRETS.map((c) => c.title), ['Heavyweight', 'Bar down', 'Night shift', 'Glass and gas', 'Spectator sport'], 'titles');
});

test('copy is sentence case (no all-caps titles or descriptions)', () => {
  for (const c of ALL_CHALLENGES) {
    ok(c.title[0] === c.title[0].toUpperCase() && c.title.slice(1) === c.title.slice(1).toLowerCase(), `title "${c.title}"`);
    ok(!/\b[A-Z]{2,}\b/.test(c.desc), `desc "${c.desc}"`);
    ok(/\.$/.test(c.desc), `desc ends with a full stop: "${c.desc}"`);
  }
  eq(CHALLENGES.find((c) => c.id === 'ignition').desc, 'Get yourself on fire.', 'design copy');
  eq(CHALLENGES.find((c) => c.id === 'glaziers-nightmare').title, "Glazier's nightmare", 'design copy');
});

test('list() shape', () => {
  const r = new Rig();
  const l = r.ach.list();
  eq(l.length, ALL_CHALLENGES.length, 'length');
  eq(l.filter((e) => e.secret).map((e) => e.id), SECRETS.map((c) => c.id), 'secrets listed last, flagged');
  for (const e of l) {
    ok('unlocked' in e && 'unlockedAt' in e && 'progress' in e && 'goal' in e && 'title' in e && 'tier' in e && 'isNew' in e && 'secret' in e, `fields of ${e.id}`);
    eq(e.unlocked, false, `${e.id} starts locked`);
    eq(e.unlockedAt, null, `${e.id} unlockedAt`);
    eq(e.progress, 0, `${e.id} progress`);
    eq(e.isNew, false, `${e.id} isNew`);
  }
});

// ------------------------------------------------------------------------------------ coverage

test('every challenge has a synthetic stream that unlocks it', () => {
  const missing = ALL_CHALLENGES.filter((c) => !SCENARIOS[c.id]).map((c) => c.id);
  eq(missing, [], 'challenges without a scenario');
  for (const c of ALL_CHALLENGES) {
    const r = new Rig();
    SCENARIOS[c.id](r);
    const e = r.entry(c.id);
    ok(e.unlocked, `${c.id} did not unlock (progress ${e.progress}/${e.goal})`);
    eq(e.unlockedAt, r.clock, `${c.id} unlockedAt`);
    eq(e.progress, e.goal, `${c.id} progress full`);
    eq(r.unlocks.filter((id) => id === c.id).length, 1, `${c.id} reported once`);
  }
});

test('the same streams unlock for an away-team player', () => {
  for (const c of ALL_CHALLENGES) {
    if (c.id === 'long-bomb') continue;  // position is team-specific; covered below
    const r = new Rig({ ctl: 4 });                     // mirror of id 0 on the away team
    const remap = (id) => (id >= 0 ? (id + 4) % 8 : id);
    const goal = r.goal.bind(r);
    r.goal = (o = {}) => goal({ ...o, scorer: o.scorer !== undefined ? remap(o.scorer) : undefined, assist: o.assist !== undefined ? remap(o.assist) : -1, team: undefined });
    const feed = r.feed.bind(r);
    r.feed = (evs = [], ticks) => feed(evs.map((e) => (e.type === EVENT.PASS ? { ...e, by: remap(e.by), to: remap(e.to) } : e)), ticks);
    SCENARIOS[c.id](r);
    ok(r.unlocked(c.id), `${c.id} did not unlock for team 1`);
  }
});

test('LONG BOMB needs a slapshot from outside the attacking blue line (both directions)', () => {
  let r = new Rig();
  r.st.p[0].x = 20; r.shot('slap', 1); r.goal();             // team 0 deep in the +X zone
  ok(!r.unlocked('long-bomb'), 'inside zone must not count');
  r.st.p[0].x = 5; r.shot('wrist', 1); r.goal();              // outside, but a wrist shot
  ok(!r.unlocked('long-bomb'), 'wrist shot must not count');
  r.st.p[0].x = 5; r.shot('slap', 1); r.advance(RULES.shotMemorySecs + 1); r.goal();
  ok(!r.unlocked('long-bomb'), 'a stale shot must not count');
  r = new Rig({ ctl: 4 });
  r.st.p[4].x = -20; r.shot('slap', 1); r.goal();            // team 1 attacks -X: inside
  ok(!r.unlocked('long-bomb'), 'team 1 inside zone must not count');
  r.st.p[4].x = -3; r.shot('slap', 1); r.goal();             // outside
  ok(r.unlocked('long-bomb'), 'team 1 from outside counts');
});

test('timing rules: OFF THE DROP / BEAT THE HORN / FULL WIND-UP thresholds', () => {
  const r = new Rig();
  r.drop(); r.advance(RULES.quickGoalSecs + 1); r.goal();
  ok(!r.unlocked('off-the-drop'), 'slow goal after drop');
  r.st.clk = RULES.hornSecs + 1; r.goal();
  ok(!r.unlocked('beat-the-horn'), 'goal with 6 s left');
  r.shot('slap', RULES.fullSlapPower - 0.1);
  ok(!r.unlocked('full-windup'), 'half-charged slap');
  r.shot('wrist', 1);
  ok(!r.unlocked('full-windup'), 'wrist shot is not a slapshot');
});

test('BEAT THE HORN ignores an untimed OT (clk 0) but counts a running OT clock', () => {
  let r = new Rig();
  r.st.per = 4; r.st.clk = 0; r.feed([ev(EVENT.PERIOD, { period: 4 })]);
  r.goal();
  ok(!r.unlocked('beat-the-horn'), 'untimed OT');
  r = new Rig();
  r.st.per = 4; r.st.clk = 2; r.feed([ev(EVENT.PERIOD, { period: 4 })]);
  r.goal();
  ok(r.unlocked('beat-the-horn'), 'OT clock at 2 s');
});

// ------------------------------------------------------------------------------------ attribution

test('attribution: AI and other humans never count for me', () => {
  const r = new Rig();
  r.st.p[4].c = OTHER;
  for (const by of [1, 2, 3, 4, 5, 6, 7]) {
    r.hit(true, by); r.glass(by); r.steal(by); r.deke(by); r.fire(true, by); r.shot('slap', 1, by);
  }
  r.goal({ scorer: 1, assist: 2 });
  r.goal({ scorer: 4, assist: 5 });
  eq(r.ach.list().filter((c) => c.progress > 0).map((c) => c.id), [], 'progress made by others');
  eq(r.unlocks, [], 'unlocks');
});

test('attribution: no local id (myId 0 / missing) attributes nothing even though AI has c=0', () => {
  for (const myId of [0, undefined, null, -3]) {
    const r = new Rig({ myId, ctl: -1 });
    r.hit(true, 0); r.goal({ scorer: 0 }); r.steal(0);
    r.ach.handle([ev(EVENT.HIT, { by: 1, big: 1 })], makeState(), {});
    eq(r.unlocks, [], `myId=${myId}`);
  }
});

test('attribution: follows SWITCH events (old skater stops counting, new one starts)', () => {
  const r = new Rig();
  r.hit(true, 0);                                     // me
  r.setControl(1);
  r.feed([ev(EVENT.SWITCH, { client: ME, from: 0, to: 1 })]);
  r.hit(true, 0);                                     // now AI
  r.hit(true, 1);                                     // me
  r.hit(true, 1);                                     // me
  eq(r.progress('demolition-shift'), 3, 'big hits counted');
  r.goal({ scorer: 0 });                              // AI teammate scores
  ok(!r.unlocked('lamp-lighter'), 'old skater goal not mine');
  r.goal({ scorer: 2, assist: 1 });
  eq(r.progress('sauce-boss'), 1, 'assist by new skater counts');
});

test('attribution: SWITCH ordering inside one batch', () => {
  const r = new Rig();
  r.setControl(1);                                    // state already shows the new skater
  r.feed([
    ev(EVENT.HIT, { by: 0, target: 5, big: 1 }),      // before the switch: mine
    ev(EVENT.HIT, { by: 1, target: 5, big: 1 }),      // before the switch: AI
    ev(EVENT.SWITCH, { client: ME, from: 0, to: 1 }),
    ev(EVENT.HIT, { by: 0, target: 5, big: 1 }),      // after: AI
    ev(EVENT.HIT, { by: 1, target: 5, big: 1 }),      // after: mine
  ]);
  eq(r.progress('demolition-shift'), 2, 'big hits');
});

test('attribution: state one snapshot ahead of its SWITCH event (interpolation lag)', () => {
  const r = new Rig();
  r.setControl(1);                                    // newer snapshot already moved control...
  r.hit(true, 0);                                     // ...but this event happened before it: mine
  r.hit(true, 1);                                     // and this was still the AI
  eq(r.progress('demolition-shift'), 1, 'before the SWITCH arrives');
  r.feed([ev(EVENT.SWITCH, { client: ME, from: 0, to: 1 })]);
  r.hit(true, 1);                                     // mine
  r.hit(true, 0);                                     // AI
  eq(r.progress('demolition-shift'), 2, 'after the SWITCH arrives');
  r.advance(5);
  r.hit(true, 0);
  eq(r.progress('demolition-shift'), 2, 'old skater still AI later');
});

test('attribution: control change without SWITCH (team change) adopted after grace', () => {
  const r = new Rig();
  r.setControl(5);                                    // release + drop-in on the away team
  r.hit(true, 5);
  r.advance(1);                                       // longer than the grace window
  r.hit(true, 5);
  r.hit(true, 0);
  eq(r.progress('demolition-shift'), 1, 'only the post-grace hit by the new skater');
  r.play(1, 0);                                       // win as the away team
  ok(r.unlocked('victory-lap'), 'credited to the new team');
  ok(r.unlocked('brick-wall'), 'shutout for the new team');
});

test('attribution: drop-in mid-game counts immediately; spectating counts nothing', () => {
  const r = new Rig({ ctl: -1 });
  r.hit(true, 2);
  eq(r.progress('demolition-shift'), 0, 'spectating');
  r.setControl(2);
  r.hit(true, 2);
  eq(r.progress('demolition-shift'), 1, 'drop-in');
  const s = new Rig({ ctl: -1 });
  s.play(3, 0);
  eq(s.progress('rink-rat'), 0, 'spectated game not counted');
  ok(!s.unlocked('victory-lap'), 'no win for a spectator');
});

test('attribution: own goals, goalies, own-team assists', () => {
  const r = new Rig();
  r.goal({ scorer: 0, team: 1 });                     // puck off my stick into my own net
  eq(r.progress('lamp-lighter'), 0, 'own goal');
  r.st.p[3].c = ME;                                   // bogus: goalie marked as mine
  r.goal({ scorer: 3 });
  eq(r.progress('lamp-lighter'), 0, 'goalie never mine');
  r.goal({ scorer: 1, assist: 0 });
  eq(r.progress('sauce-boss'), 1, 'assist');
  eq(r.progress('lamp-lighter'), 0, 'assist is not a goal');
});

test('event type key aliases (type / t / e / ev)', () => {
  const r = new Rig();
  r.feed([{ t: EVENT.HIT, by: 0, big: 1 }, { e: EVENT.HIT, by: 0, big: 1 }, { ev: EVENT.HIT, by: 0, big: 1 }]);
  eq(r.progress('demolition-shift'), 3, 'aliases');
});

// ------------------------------------------------------------------------------------ per game

test('per-game counters reset on a new game (tick decreases); career persists', () => {
  const r = new Rig();
  r.goal(); r.goal(); r.steal(); r.steal();
  r.newGame();
  r.goal(); r.steal();
  ok(!r.unlocked('three-alarm'), 'goals spread over 2 games');
  ok(!r.unlocked('pickpocket'), 'steals spread over 2 games');
  eq(r.progress('three-alarm'), 2, 'best single game');
  eq(r.progress('quarter-century'), 3, 'career goals');
  r.goal(); r.goal();
  ok(r.unlocked('three-alarm'), 'three in the second game');
});

test('per-game counters reset on FACEOFF of period 1 after GAME_OVER (tick keeps going)', () => {
  const r = new Rig();
  for (let i = 0; i < 4; i++) r.deke();
  r.glass(); r.glass();
  r.endGame();
  r.newGame({ keepTick: true });
  r.deke(); r.glass();
  ok(!r.unlocked('spin-cycle'), 'dekes spread over 2 games');
  ok(!r.unlocked('glaziers-nightmare'), 'glass spread over 2 games');
  eq(r.progress('spin-cycle'), 4, 'best game');
});

test('period or score going backwards also means a new game (aborted game, missed GAME_OVER)', () => {
  const r = new Rig();
  r.st.per = 2; r.feed([]);
  r.goal(); r.goal();
  r.st = makeState(); r.st.p[0].c = ME; r.st.tick = 99999;   // fresh game, tick not lower
  r.feed([]);
  r.goal();
  ok(!r.unlocked('three-alarm'), 'reset by period/score regression');
  eq(r.progress('rink-rat'), 0, 'aborted game not counted as played');
});

test('game result credited exactly once (repeated FINAL / lingering GAME_OVER states)', () => {
  const r = new Rig();
  r.play(2, 0);
  r.feed([ev(EVENT.FINAL, { score: [2, 0] })]);
  for (let i = 0; i < 20; i++) r.advance(0.5);
  r.newGame();
  r.advance(1);
  eq(r.progress('rink-rat'), 1, 'games');
  eq(r.entry('victory-lap').unlocked, true, 'win');
});

test('game whose FINAL event never arrived is still credited at the next game', () => {
  const r = new Rig();
  r.goal(); r.goal({ scorer: 4 }); r.goal();
  r.st.ph = PHASE.GAME_OVER; r.feed([]);               // no FINAL event
  ok(!r.unlocked('victory-lap'), 'not yet');
  r.newGame();
  ok(r.unlocked('victory-lap'), 'credited from the last score');
  eq(r.progress('rink-rat'), 1, 'games');
});

test('OT, shutout, blowout and comeback need the right game shape', () => {
  let r = new Rig(); r.play(1, 0);
  ok(!r.unlocked('overtime-outlaw'), 'regulation win is not OT');
  r = new Rig({ periods: 5 }); r.st.per = 4; r.feed([]); r.play(1, 0);
  ok(!r.unlocked('overtime-outlaw'), 'period 4 of 5 is not OT');
  r = new Rig(); r.play(2, 3, { ot: true });
  ok(!r.unlocked('overtime-outlaw') && !r.unlocked('victory-lap'), 'OT loss');
  r = new Rig(); r.play(3, 1);
  ok(!r.unlocked('brick-wall') && !r.unlocked('no-mercy'), 'not shutout, margin 2');
  r = new Rig(); r.goal({ scorer: 4 }); r.goal(); r.goal({ scorer: 4 }); r.goal(); r.goal(); r.endGame();
  ok(!r.unlocked('rise-from-the-slush'), 'never down by 2');
  r = new Rig(); r.goal({ scorer: 4 }); r.goal({ scorer: 4 }); r.goal(); r.goal(); r.endGame();
  ok(!r.unlocked('rise-from-the-slush'), 'came back to a tie only');
});

test('ON FIRE tracking: scoring after the fire went out does not count', () => {
  const r = new Rig();
  r.fire(true);
  ok(r.unlocked('ignition'), 'ignition');
  r.fire(false);
  r.goal();
  ok(!r.unlocked('hot-hands'), 'fire was out');
  r.fire(true);
  r.goal();
  ok(r.unlocked('hot-hands'), 'on fire');
});

// ------------------------------------------------------------------------------------ persistence

test('persistence round trip through storage', () => {
  const storage = memStorage({ other: 'keep me' });
  const a = new Rig({ storage });
  a.goal(); a.hit(true); for (let i = 0; i < 36; i++) a.hit(false); a.steal(); a.steal();
  a.play(1, 0);
  const before = a.ach.list();
  a.ach.dispose();
  const raw = storage.getItem(STORAGE_KEY);
  ok(raw, 'saved under the default key');
  const saved = JSON.parse(raw);
  eq(saved.v, 1, 'version');
  eq(saved.career.hits, 37, 'career hits saved');
  eq(storage.getItem('other'), 'keep me', 'other keys untouched');

  const b = createAchievements({ storage, container: null, now: () => 999 });
  const noNew = (l) => l.map(({ isNew, ...rest }) => rest);           // "New" is per session
  eq(noNew(b.list()), noNew(before), 'list after reload');
  ok(before.some((e) => e.isNew) && b.list().every((e) => !e.isNew), 'New chips only for unlocks of this session');
  eq(b.list().find((c) => c.id === 'wrecking-ball').progress, 37, 'career progress');
  eq(b.list().find((c) => c.id === 'pickpocket').progress, 2, 'best-game progress');

  const c = createAchievements({ storage, storageKey: 'alt.key', container: null });
  ok(c.list().every((e) => !e.unlocked), 'separate key starts empty');
});

test('reset() wipes progress and storage', () => {
  const storage = memStorage();
  const r = new Rig({ storage });
  r.goal(); r.hit(true);
  r.ach.reset();
  ok(r.ach.list().every((e) => !e.unlocked && e.progress === 0), 'wiped');
  eq(storage.getItem(STORAGE_KEY), null, 'storage cleared');
  r.goal();
  ok(r.unlocked('lamp-lighter'), 'can unlock again after reset');
  eq(createAchievements({ storage, container: null }).list().find((e) => e.id === 'lamp-lighter').unlocked, true, 'saved again');
});

test('throwing / missing / corrupt storage is tolerated', () => {
  const thrower = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
  const hostile = new Proxy({}, { get() { throw new Error('SecurityError'); } });
  for (const storage of [thrower, hostile, null, undefined, {}]) {
    const r = new Rig({ storage });
    r.goal(); r.hit(true);
    ok(r.unlocked('lamp-lighter') && r.unlocked('bone-rattler'), 'unlocks in memory');
    r.ach.reset(); r.ach.openPanel(); r.ach.closePanel(); r.ach.dispose();
  }
  for (const raw of ['{not json', '"str"', '[1,2]', 'null', JSON.stringify({ v: 1, unlocked: { 'lamp-lighter': 'yes', bogus: 5 }, career: { hits: -4, goals: 'lots', wins: 2.7 }, best: null })]) {
    const s = memStorage({ [STORAGE_KEY]: raw });
    const a = createAchievements({ storage: s, container: null });
    const l = a.list();
    ok(!l.find((e) => e.id === 'lamp-lighter').unlocked, `bad unlock value ignored (${raw.slice(0, 12)})`);
    ok(l.every((e) => Number.isFinite(e.progress) && e.progress >= 0), 'sane progress');
  }
  const p = createProgress({ career: { wins: 2.7, hits: -4 } });
  eq([p.career.wins, p.career.hits], [2, 0], 'sanitized counters');
});

test('the default storage is resolved safely when globalThis.localStorage throws', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    const a = createAchievements();
    a.handle([], makeState(), { myId: 1 });
    eq(a.list().length, ALL_CHALLENGES.length, 'works');
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage;
  }
});

// ------------------------------------------------------------------------------------ duplicates

test('no duplicate unlocks (repeats, big batches, reloads, onUnlock)', () => {
  const storage = memStorage();
  const seen = [];
  const r = new Rig({ storage, onUnlock: (c) => seen.push(c.id) });
  for (let i = 0; i < 6; i++) r.goal();
  r.feed(Array.from({ length: 250 }, () => ev(EVENT.HIT, { by: 0, target: 5, big: 1 })));
  r.feed(Array.from({ length: 50 }, () => ev(EVENT.HIT, { by: 0, target: 5, big: 1 })));
  eq(new Set(r.unlocks).size, r.unlocks.length, 'handle() results unique');
  eq(seen, r.unlocks, 'onUnlock matches handle() results');
  ok(r.unlocks.includes('wrecking-ball') && r.unlocks.includes('three-alarm'), 'thresholds crossed');
  const r2 = new Rig({ storage });
  r2.goal(); r2.goal(); r2.goal(); r2.hit(true);
  eq(r2.unlocks, [], 'nothing re-unlocks after reload');
  eq(r2.entry('lamp-lighter').unlockedAt, 1234567, 'original timestamp kept');
});

// ------------------------------------------------------------------------------------ robustness

test('garbage input never throws; no DOM needed when container is null', () => {
  const a = createAchievements({ storage: memStorage(), container: null });
  a.handle(null, null, null);
  a.handle(undefined, undefined);
  a.handle([null, 5, 'x', {}, { type: EVENT.GOAL }, { type: EVENT.SWITCH, client: 1, from: 'a', to: 99 }], { p: 'nope' }, { myId: 1 });
  a.handle([{ type: EVENT.HIT, by: 0 }], { tick: 'x', p: [null, {}, 7] }, { myId: 1 });
  a.handle([{ type: EVENT.FINAL }], { p: [] }, { myId: 1 });
  a.handle([{ type: EV_FIGHT_END, winner: 'x' }, { type: EVENT.POST }, { type: EVENT.SHOT, by: 99 }, { type: EVENT.POST, x: 1 }], { p: [], k: null }, { myId: 1 });
  a.openPanel(); a.closePanel(); a.mountView(null);
  eq(a.list().length, ALL_CHALLENGES.length, 'still listing');
  eq(a.progress(), { done: 0, total: 25, secretsDone: 0, secretsTotal: 5 }, 'progress');
  a.dispose();
  eq(a.handle([ev(EVENT.HIT, { by: 0, big: 1 })], makeState(), { myId: 1 }), [], 'inert after dispose');
});

test('pure tracker works standalone (createProgress / stepProgress / serializeProgress)', () => {
  const m = createProgress();
  const st = makeState(); st.p[2].c = 5;
  eq(stepProgress(m, [], st, { myId: 5 }, 10), [], 'nothing yet');
  st.tick = 10;
  eq(stepProgress(m, [ev(EVENT.HIT, { by: 2, big: 1 })], st, { myId: 5 }, 42), ['bone-rattler'], 'unlock ids returned');
  const s = serializeProgress(m);
  eq([s.unlocked['bone-rattler'], s.career.hits, s.career.bigHits, s.best.bigHits], [42, 1, 1, 1], 'serialized');
  const m2 = createProgress(JSON.parse(JSON.stringify(s)));
  eq(serializeProgress(m2), s, 'round trip');
});

// ------------------------------------------------------------------------------------ secrets

test('HEAVYWEIGHT: only a fight my skater wins (fightEnd.winner), never the loser or someone else', () => {
  eq(EV_FIGHT_END, 'fightEnd', 'sim-fight event name');
  let r = new Rig();
  r.fightEnd(5, 0);                                   // I lost
  r.fightEnd(1, 4);                                   // AI teammate won
  r.st.p[4].c = OTHER; r.fightEnd(4, 1);              // another human won
  ok(!r.unlocked('heavyweight'), 'no credit');
  r.fightEnd(0, 5);
  ok(r.unlocked('heavyweight'), 'my win');
  r = new Rig({ ctl: -1 });
  r.fightEnd(0, 5);
  ok(!r.unlocked('heavyweight'), 'spectator');
});

test('BAR DOWN: posts off my own shots, 3 in one game', () => {
  const r = new Rig();
  r.ringPost(); r.ringPost();
  eq(r.progress('bar-down'), 2, 'two posts');
  ok(!r.unlocked('bar-down'), 'not yet');
  r.newGame();
  r.ringPost();
  ok(!r.unlocked('bar-down'), 'spread over two games');
  eq(r.progress('bar-down'), 2, 'best single game');
  r.ringPost(); r.ringPost();
  ok(r.unlocked('bar-down'), 'three in one game');
});

test('BAR DOWN: the post must come off my shot, untouched and recent', () => {
  const r = new Rig();
  const p = () => r.progress('bar-down');
  r.shot('wrist', 0.7, 1); r.post();                                  // AI teammate's shot
  r.shot('wrist', 0.7, 5); r.post();                                  // opponent's shot
  r.post();                                                           // no shot at all
  eq(p(), 0, 'not my shot');
  r.shot(); r.advance(RULES.postShotSecs + 0.5); r.post();
  eq(p(), 0, 'stale shot');
  for (const type of [EVENT.SAVE, EVENT.PASS, EVENT.STEAL, EVENT.WHISTLE, EVENT.FACEOFF]) {
    r.shot(); r.feed([ev(type, { goalie: 7, by: 5, to: 6, from: 0, x: 0, z: 0 })]); r.post();
    eq(p(), 0, `touched in between (${type})`);
  }
  r.shot(); r.st.k.o = 5; r.feed([]); r.st.k.o = -1; r.post();
  eq(p(), 0, 'puck picked up in between (state owner)');
  r.shot(); r.post(); r.post();
  eq(p(), 1, 'one shot rings one post');
  r.shot('wrist', 0.7, 1); r.shot(); r.post();
  eq(p(), 2, 'my shot after a teammate\'s');
  r.feed([ev(EVENT.SHOT, { by: 0, power: 0.7, kind: 'wrist' }), ev(EVENT.POST, { x: 26.6, z: 0.9 })]);
  eq(p(), 3, 'shot and post in one batch');
});

test('NIGHT SHIFT: a game I played, finished between 00:00 and 04:59 local time', () => {
  for (const [clock, want, label] of [[at(0, 0), true, '00:00'], [NIGHT, true, '02:30'], [at(4, 59), true, '04:59'],
    [at(5, 0), false, '05:00'], [at(23, 59), false, '23:59'], [DAY, false, '14:00'], [0, false, 'no clock']]) {
    const r = new Rig({ clock });
    r.play(0, 3);                                     // a loss counts: it only has to be finished
    eq(r.unlocked('night-shift'), want, label);
  }
  let r = new Rig({ clock: NIGHT });
  r.goal(); r.goal();
  ok(!r.unlocked('night-shift'), 'unfinished game');
  r = new Rig({ clock: DAY });
  r.goal(); r.st.ph = PHASE.GAME_OVER; r.feed([]);    // FINAL event lost...
  r.clock = NIGHT; r.newGame();                       // ...credited when the next game shows up
  ok(r.unlocked('night-shift'), 'missed FINAL credited with the clock at that moment');
  r = new Rig({ ctl: -1, clock: NIGHT });
  r.play(1, 0);
  ok(!r.unlocked('night-shift'), 'spectated games do not count');
});

test('GLASS AND GAS: my goal within 10 s of my own glass shatter', () => {
  let r = new Rig();
  r.glass(); r.advance(RULES.glassGoalSecs + 1); r.goal();
  ok(!r.unlocked('glass-and-gas'), 'too slow');
  r.glass(1); r.goal();
  ok(!r.unlocked('glass-and-gas'), 'teammate broke the glass');
  r.glass(); r.goal({ scorer: 1, assist: 0 });
  ok(!r.unlocked('glass-and-gas'), 'teammate scored');
  r.glass(); r.goal({ scorer: 0, team: 1 });
  ok(!r.unlocked('glass-and-gas'), 'own goal');
  r.glass(); r.advance(RULES.glassGoalSecs - 1); r.goal();
  ok(r.unlocked('glass-and-gas'), 'within the window');
  r = new Rig();
  r.glass(); r.newGame(); r.goal();
  ok(!r.unlocked('glass-and-gas'), 'not across games');
});

test('SPECTATOR SPORT: a whole game from the stands, opening faceoff to final horn', () => {
  // init shapes the first state the client sees; during runs mid-game
  const watch = ({ init, during, opts = {}, secs = RULES.spectateMinSecs + 30 } = {}) => {
    const r = new Rig({ ctl: -1, init, ...opts });
    r.goal({ scorer: 0 });
    if (during) during(r);
    r.goal({ scorer: 4 });
    r.advance(secs);
    r.endGame();
    return r.unlocked('spectator-sport');
  };
  ok(watch(), 'start to finish');
  ok(watch({ init: (s) => { s.tick = (RULES.spectateStartSecs - 5) * TICK_RATE; } }), 'joined during the opening seconds');
  ok(!watch({ init: (s) => { s.tick = (RULES.spectateStartSecs + 5) * TICK_RATE; } }), 'joined late (tick)');
  ok(!watch({ init: (s) => { s.per = 2; } }), 'joined in period 2');
  ok(!watch({ init: (s) => { s.sc = [1, 0]; } }), 'joined after a goal');
  ok(!watch({ init: (s) => { s.ph = PHASE.GAME_OVER; } }), 'joined at the horn');
  ok(!watch({ init: (s) => { delete s.tick; } }), 'no tick in the state');
  ok(!watch({ during: (r) => { r.setControl(2); r.hit(false, 2); r.setControl(-1); r.advance(1); } }), 'played a shift');
  ok(!watch({ opts: { myId: 0 } }), 'no client id');
  ok(!watch({ secs: 0 }), 'too short to be a whole game');
  const r = new Rig({ ctl: -1 });
  r.goal({ scorer: 0 }); r.advance(RULES.spectateMinSecs + 30);
  r.advance(1); r.newGame({ ctl: -1 });               // left / aborted before the horn
  ok(!r.unlocked('spectator-sport'), 'game never finished');
});

test('secrets stay out of the 25: progress() and summarize()', () => {
  const r = new Rig();
  r.fightEnd(); r.goal();
  eq(r.ach.progress(), { done: 1, total: 25, secretsDone: 1, secretsTotal: 5 }, 'progress');
  const s = summarize(r.ach.list());
  eq([s.done, s.total, s.open, s.secretsDone, s.secretsTotal], [1, 25, 24, 1, 5], 'summary');
  eq(s.tiers, [{ tier: 1, total: 8, done: 1 }, { tier: 2, total: 11, done: 0 }, { tier: 3, total: 6, done: 0 }], 'tiers');
});

test('onProgress: fires after unlocks and reset, unsubscribes', () => {
  const r = new Rig();
  const seen = [];
  const off = r.ach.onProgress((p) => seen.push(p));
  r.hit(false);                                       // progress but no unlock: quiet
  eq(seen.length, 0, 'quiet without unlocks');
  r.goal();
  eq(seen.at(-1), { done: 1, total: 25, secretsDone: 0, secretsTotal: 5 }, 'after an unlock');
  r.ach.reset();
  eq(seen.at(-1), { done: 0, total: 25, secretsDone: 0, secretsTotal: 5 }, 'after reset');
  const n = seen.length;
  off();
  r.goal();
  eq(seen.length, n, 'unsubscribed');
  const thrower = r.ach.onProgress(() => { throw new Error('ui bug'); });
  r.hit(true);
  ok(r.unlocked('bone-rattler'), 'a throwing listener does not break handle()');
  thrower();
  eq(typeof r.ach.onProgress(null), 'function', 'bad listener ignored');
});

test('migration: a save from the previous build keeps every unlock, timestamp and counter', () => {
  // Verbatim shape written by the first release (v1, no secret stats).
  const old = {
    v: 1,
    unlocked: { 'lamp-lighter': 1730300000000, 'victory-lap': 1730400000000, 'rink-rat': 1731000000000 },
    career: { goals: 7, assists: 3, hits: 41, bigHits: 9, glass: 1, steals: 4, dekes: 12, fires: 0, maxSlaps: 0,
      oneTimerGoals: 0, longSlapGoals: 0, fireGoals: 0, oneTimerAssists: 0, quickGoals: 0, hornGoals: 0,
      games: 10, wins: 4, otWins: 0, shutoutWins: 0, blowoutWins: 0, comebackWins: 0 },
    best: { goals: 2, assists: 1, bigHits: 3, glass: 1, steals: 2, dekes: 4 },
  };
  const storage = memStorage({ [STORAGE_KEY]: JSON.stringify(old) });
  const a = createAchievements({ storage, container: null, now: () => DAY });
  const l = a.list();
  const by = (id) => l.find((e) => e.id === id);
  eq([by('lamp-lighter').unlockedAt, by('victory-lap').unlockedAt, by('rink-rat').unlockedAt], [1730300000000, 1730400000000, 1731000000000], 'timestamps');
  eq([by('wrecking-ball').progress, by('quarter-century').progress, by('spin-cycle').progress, by('demolition-shift').progress], [41, 7, 4, 3], 'counters');
  ok(SECRETS.every((c) => !by(c.id).unlocked && by(c.id).progress === 0), 'secrets start locked');
  eq(a.progress().done, 3, 'done');
  a.handle([], makeState(), { myId: 1 });
  a.handle([ev(EVENT.HIT, { by: 0, big: 1 })], (() => { const s = makeState(); s.p[0].c = 1; s.tick = 4; return s; })(), { myId: 1 });
  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  eq(saved.v, 1, 'format version unchanged (additive keys only)');
  eq(saved.unlocked['lamp-lighter'], 1730300000000, 'old unlock kept on save');
  eq([saved.career.hits, saved.career.bigHits, saved.career.fightWins, saved.best.posts], [42, 10, 0, 0], 'old counters carried, new ones added');
});

test('clearedLabel: relative for recent unlocks, a date after that', () => {
  const now = at(14, 0);
  eq(clearedLabel(now - 20e3, now), 'Cleared just now', 'seconds');
  eq(clearedLabel(now - 12 * 60e3, now), 'Cleared 12 min ago', 'minutes');
  eq(clearedLabel(now - 3 * 3600e3, now), 'Cleared 3 h ago', 'hours');
  eq(clearedLabel(new Date(2026, 10, 14, 9, 0).getTime(), now), 'Cleared Nov 14', 'this year');
  eq(clearedLabel(new Date(2025, 9, 30, 9, 0).getTime(), now), 'Cleared Oct 30, 2025', 'other year');
  eq(clearedLabel(0, now), 'Cleared', 'unknown time');
  eq(clearedLabel(null, now), 'Cleared', 'missing');
});

// ------------------------------------------------------------------------------------ real sim
// The secrets must be detectable from what handle() really receives. Record real AI-vs-AI games
// from shared/sim.js at the snapshot rate (events batched per snapshot like net.js releases them),
// then replay them with the local player put on each skater in turn.

function recordGame(seed) {
  const g = createGame({ periodLength: 60 }, seed);
  // Ground truth for BAR DOWN from sim internals: the flight the puck is on when POST is emitted.
  const tap = () => { const a = g.events; a.push = function (e) { if (e && e.type === EVENT.POST) e.fl = g.flight && { by: g.flight.by, kind: g.flight.kind, ref: g.flight }; return Array.prototype.push.call(this, e); }; };
  let pend = drainEvents(g); tap();
  const frames = [], posts = new Map(), flights = new Set(), fights = [];
  for (let i = 0; i < 60 * 60 * 20; i++) {
    step(g, DT, {});
    const evs = drainEvents(g); tap();
    for (const e of evs) {
      if (e.type === EVENT.POST) {
        const fl = e.fl; delete e.fl;
        // a shot flight (FL_SHOT) belongs to its shooter; the first post of each shot counts once
        if (fl && fl.by >= 0 && fl.kind === FL_SHOT && !flights.has(fl.ref)) {
          flights.add(fl.ref); posts.set(fl.by, (posts.get(fl.by) || 0) + 1);
        }
      }
      if (e.type === EV_FIGHT_END) fights.push(e);
    }
    pend.push(...evs);
    if (g.tick % 2 === 0 || g.ph === PHASE.GAME_OVER) { frames.push({ s: snapshot(g), ev: pend }); pend = []; }
    if (g.ph === PHASE.GAME_OVER) break;
  }
  return { frames, posts, fights };
}

function replayGame(frames, { me = -1, myId = 9, clock = DAY, from = 0 } = {}) {
  const ach = createAchievements({ storage: memStorage(), container: null, now: () => clock });
  for (const f of frames.slice(from)) {
    const s = structuredClone(f.s);
    if (me >= 0) s.p[me].c = myId;
    ach.handle(f.ev, s, { myId });
  }
  const m = ach.list();
  return { unlocked: (id) => m.find((e) => e.id === id).unlocked, progress: (id) => m.find((e) => e.id === id).progress, ach };
}

test('real sim streams: every secret is detectable from what handle() receives', () => {
  const SKATERS = [0, 1, 2, 4, 5, 6];
  let postsSeen = 0, fightsSeen = 0;
  for (const seed of [7919, 47514, 95028]) {
    const { frames, posts, fights } = recordGame(seed);
    ok(frames.at(-1).s.ph === PHASE.GAME_OVER, `seed ${seed} played to the horn`);
    for (const me of SKATERS) {
      const r = replayGame(frames, { me });
      const truth = posts.get(me) || 0;
      // BAR DOWN attribution (last SHOT before the POST) matches the sim's own shooter, per skater
      const best = r.ach.list().find((e) => e.id === 'bar-down').progress;
      eq(Math.min(best, 3), Math.min(truth, 3), `seed ${seed} skater ${me}: posts off own shots`);
      const wins = fights.filter((f) => f.winner === me).length;
      eq(r.unlocked('heavyweight'), wins > 0, `seed ${seed} skater ${me}: heavyweight (${wins} fight wins)`);
      ok(r.unlocked('rink-rat') === false && r.progress('rink-rat') === 1, `seed ${seed} skater ${me}: one game credited`);
      ok(!r.unlocked('spectator-sport'), `seed ${seed} skater ${me}: a player is not a spectator`);
    }
    postsSeen += [...posts.values()].reduce((a, b) => a + b, 0);
    fightsSeen += fights.length;
    ok(replayGame(frames).unlocked('spectator-sport'), `seed ${seed}: watched from the stands start to finish`);
    ok(!replayGame(frames, { from: Math.floor(frames.length / 2) }).unlocked('spectator-sport'), `seed ${seed}: joined halfway`);
    ok(!replayGame(frames, { myId: 0 }).unlocked('spectator-sport'), `seed ${seed}: no client id`);
    ok(replayGame(frames, { me: 0, clock: NIGHT }).unlocked('night-shift'), `seed ${seed}: finished at 02:30`);
    ok(!replayGame(frames, { me: 0, clock: DAY }).unlocked('night-shift'), `seed ${seed}: finished at 14:00`);
  }
  ok(postsSeen >= 3, `real games ring posts off shots (${postsSeen})`);
  ok(fightsSeen >= 2, `real games have fights (${fightsSeen})`);
});

test('real sim streams: exact post counts per skater (tracker counter vs sim shooter)', () => {
  // the first seed (from 47514) whose game rings several posts: any change to the sim's timing or
  // tuning reshuffles which games do, so search a few instead of pinning one
  let seed = 47514, rec = recordGame(seed);
  const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  while (total(rec.posts) < 4 && seed < 47514 + 12) rec = recordGame(++seed);
  const { frames, posts } = rec;
  for (const me of [0, 1, 2, 4, 5, 6]) {
    const m = createProgress();
    for (const f of frames) { const s = structuredClone(f.s); s.p[me].c = 9; stepProgress(m, f.ev, s, { myId: 9 }, DAY); }
    eq(m.career.posts, posts.get(me) || 0, `skater ${me}`);
  }
  ok(total(posts) >= 4, `seed ${seed} has several posts (${total(posts)})`);
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
