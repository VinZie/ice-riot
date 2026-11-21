// ICE RIOT - headless sim tests. Plain node script: `node test/sim.test.js`. Exit code 1 on failure.

import { createGame, step, snapshot, drainEvents, assignClient, releaseClient } from '../shared/sim.js';
import {
  DT, PHASE, PSTATE, EVENT, BTN, DEFAULT_CONFIG, boardDistance, glassPanels, TEAMS,
} from '../shared/constants.js';
import { boardDist } from '../shared/sim-util.js';

let failures = 0, passes = 0;
function check(cond, msg) {
  if (cond) { passes++; return true; }
  failures++;
  console.error('  FAIL:', msg);
  return false;
}
function section(name) { console.log(`\n== ${name}`); }
const now = () => performance.now();

// ---- snapshot / event validation ------------------------------------------------------

const PLAYER_KEYS = ['id', 'tm', 'g', 'x', 'y', 'z', 'vx', 'vz', 'f', 's', 'sT', 'tb', 'fire', 'ch', 'c', 'n'];
const PUCK_KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'o'];
const TOP_KEYS = ['tick', 'ph', 'phT', 'per', 'clk', 'sc', 'teams', 'p', 'k', 'gl', 'fi'];
const EV_FIGHT = 'fight', EV_FIGHT_START = 'fightStart', EV_FIGHT_END = 'fightEnd';
const FIGHT_SUBS = ['punch', 'block', 'dodge', 'grab', 'ko'];
const N = 'number', B = 'boolean', S = 'string';
const EVENT_FIELDS = {
  [EVENT.GOAL]: { team: N, scorer: N, assist: N, oneTimer: B, x: N, z: N },
  [EVENT.SHOT]: { by: N, power: N, kind: S },
  [EVENT.PASS]: { by: N, to: N },
  [EVENT.SAVE]: { goalie: N, x: N, z: N },
  [EVENT.POST]: { x: N, z: N },
  [EVENT.HIT]: { by: N, target: N, power: N, big: B, x: N, z: N },
  [EVENT.GLASS]: { panel: N, by: N, target: N, x: N, z: N },
  [EVENT.BOARDS]: { x: N, z: N, power: N },
  [EVENT.STEAL]: { by: N, from: N },
  [EVENT.DEKE]: { by: N },
  [EVENT.FACEOFF]: { x: N, z: N },
  [EVENT.WHISTLE]: {},
  [EVENT.PERIOD]: { period: N },
  [EVENT.PERIOD_END]: { period: N },
  [EVENT.FINAL]: { score: 'array' },
  [EVENT.FIRE]: { player: N, on: B },
  [EVENT.SWITCH]: { client: N, from: N, to: N },
  [EV_FIGHT_START]: { a: N, b: N },
  [EV_FIGHT_END]: { winner: N, loser: N, how: S },
  [EV_FIGHT]: { sub: S, by: N, power: N },
};
const NUM_PANELS = glassPanels().length;

// Returns an error string or null.
function validateSnapshot(s) {
  for (const k of TOP_KEYS) if (!(k in s)) return `missing top-level key ${k}`;
  for (const k of ['tick', 'ph', 'phT', 'per', 'clk']) if (!Number.isFinite(s[k])) return `bad ${k}=${s[k]}`;
  if (!Array.isArray(s.sc) || s.sc.length !== 2 || !s.sc.every(Number.isInteger)) return 'bad sc';
  if (!Array.isArray(s.teams) || s.teams.length !== 2) return 'bad teams';
  if (!Array.isArray(s.p) || s.p.length !== 8) return 'p must have 8 entries';
  for (let i = 0; i < 8; i++) {
    const p = s.p[i];
    for (const k of PLAYER_KEYS) {
      if (!(k in p)) return `player ${i} missing ${k}`;
      if (!Number.isFinite(p[k])) return `player ${i} ${k} not finite (${p[k]})`;
    }
    if (p.id !== i) return `player index ${i} has id ${p.id}`;
    if (p.tm !== (i < 4 ? 0 : 1) || p.g !== (i % 4 === 3 ? 1 : 0)) return `player ${i} bad tm/g`;
    if (p.ch !== 0 && p.s !== PSTATE.CHARGE) return `player ${i} ch!=0 outside CHARGE`;
    if (p.g && p.c !== 0) return `goalie ${i} is human-controlled`;
    if (p.tb < 0 || p.tb > 1 || p.ch < 0 || p.ch > 1) return `player ${i} tb/ch out of range`;
  }
  for (const k of PUCK_KEYS) if (!Number.isFinite(s.k[k])) return `puck ${k} not finite`;
  if (s.k.o < -1 || s.k.o > 7) return 'bad puck owner';
  if (!s.gl.every((g) => Number.isInteger(g) && g >= 0 && g < NUM_PANELS)) return 'bad gl';
  if (s.fi !== null) {
    if (typeof s.fi !== 'object') return 'fi must be null or an object';
    for (const k of ['a', 'b', 'tA', 'tB', 't', 'hpA', 'hpB', 'enA', 'enB', 'winner', 'done']) {
      if (!Number.isFinite(s.fi[k])) return `fi.${k} not finite`;
    }
    if (typeof s.fi.ph !== 'string') return 'fi.ph not a string';
  }
  return null;
}

function validateEvent(e) {
  const spec = EVENT_FIELDS[e.type];
  if (!spec) return `unknown event type ${e.type}`;
  if (e.t !== e.type) return `event t/type mismatch`;
  for (const [k, t] of Object.entries(spec)) {
    const v = e[k];
    if (t === 'array') { if (!Array.isArray(v)) return `${e.type}.${k} not array`; continue; }
    if (typeof v !== t) return `${e.type}.${k} is ${typeof v}, expected ${t}`;
    if (t === N && !Number.isFinite(v)) return `${e.type}.${k} not finite`;
  }
  if (e.type === EVENT.SHOT && !['wrist', 'slap', 'onetimer'].includes(e.kind)) return `bad shot kind ${e.kind}`;
  if (e.type === EV_FIGHT && !FIGHT_SUBS.includes(e.sub)) return `bad fight sub ${e.sub}`;
  if (e.type === EV_FIGHT_END && !['ko', 'time'].includes(e.how)) return `bad fightEnd how ${e.how}`;
  return null;
}

// ---- full-game runner -----------------------------------------------------------------

function newStats() {
  return {
    goals: [0, 0], shots: [0, 0], hits: [0, 0], big: [0, 0], glass: [0, 0], saves: [0, 0],
    fires: [0, 0], passes: [0, 0], steals: [0, 0], onetimers: [0, 0], whistles: 0, posts: 0,
    fights: 0, fightEnds: 0,
    phases: new Set(), periods: 0, periodEnds: 0, finals: 0, ot: false, simMs: 0, ticks: 0,
    maxSnap: 0, errors: [],
  };
}
const teamOf = (pid) => (pid < 4 ? 0 : 1);

function runGame(cfg, seed, { validate = false, inputs = null } = {}) {
  const game = createGame({ ...DEFAULT_CONFIG, ...cfg }, seed);
  const st = newStats();
  let pendingOutside = 0;   // ticks the puck has been outside the rink without a whistle
  const tally = (ev) => {
    for (const e of ev) {
      if (validate) { const err = validateEvent(e); if (err) st.errors.push(err); }
      switch (e.type) {
        case EVENT.GOAL: st.goals[e.team]++; break;
        case EVENT.SHOT: st.shots[teamOf(e.by)]++; if (e.kind === 'onetimer') st.onetimers[teamOf(e.by)]++; break;
        case EVENT.HIT: st.hits[teamOf(e.by)]++; if (e.big) st.big[teamOf(e.by)]++; break;
        case EVENT.GLASS: st.glass[teamOf(e.by)]++; break;
        case EVENT.SAVE: st.saves[teamOf(e.goalie)]++; break;
        case EVENT.FIRE: if (e.on) st.fires[teamOf(e.player)]++; break;
        case EVENT.PASS: st.passes[teamOf(e.by)]++; break;
        case EVENT.STEAL: st.steals[teamOf(e.by)]++; break;
        case EVENT.WHISTLE: st.whistles++; pendingOutside = 0; break;
        case EVENT.POST: st.posts++; break;
        case EVENT.PERIOD: st.periods++; break;
        case EVENT.PERIOD_END: st.periodEnds++; break;
        case EVENT.FINAL: st.finals++; break;
        case EV_FIGHT_START: st.fights++; break;
        case EV_FIGHT_END: st.fightEnds++; break;
      }
    }
  };
  tally(drainEvents(game));
  const maxTicks = 60 * (cfg.periodLength * 12 + 300);
  while (game.ph !== PHASE.GAME_OVER && st.ticks < maxTicks) {
    const t0 = now();
    step(game, DT, inputs ? inputs(game, st.ticks) : {});
    st.simMs += now() - t0;
    st.ticks++;
    const ev = drainEvents(game);
    tally(ev);
    st.phases.add(game.ph);
    if (validate) {
      const s = snapshot(game);
      const err = validateSnapshot(s);
      if (err && st.errors.length < 10) st.errors.push(`tick ${s.tick}: ${err}`);
      const json = JSON.stringify(s);
      if (json.length > st.maxSnap) st.maxSnap = json.length;
      if (JSON.parse(json).tick !== s.tick) st.errors.push('snapshot does not round-trip');
      if (boardDistance(s.k.x, s.k.z).d < -0.3) {
        // outside the rink: must be followed by a whistle right away
        if (++pendingOutside > 2 && st.errors.length < 10) st.errors.push(`tick ${s.tick}: puck outside rink (${s.k.x},${s.k.z}) without whistle`);
      } else pendingOutside = 0;
    }
  }
  st.ot = game.per > game.cfg.periods;
  st.final = game.sc.slice();
  st.game = game;
  return st;
}

function printGame(st, label) {
  const sum = (a) => a[0] + a[1];
  console.log(`  ${label}: final ${st.final[0]}-${st.final[1]}${st.ot ? ' (OT)' : ''}  ticks ${st.ticks}  sim ${st.simMs.toFixed(0)} ms (${(1000 * st.simMs / st.ticks).toFixed(1)} us/step)`);
  console.log(`    shots ${st.shots.join('/')}  saves ${st.saves.join('/')}  hits ${st.hits.join('/')} (big ${st.big.join('/')})  glass ${st.glass.join('/')}  fires ${st.fires.join('/')}  passes ${sum(st.passes)}  one-timers ${sum(st.onetimers)}  steals ${sum(st.steals)}  whistles ${st.whistles}  posts ${st.posts}  fights ${st.fights}`);
}

// =====================================================================================
section('0. helpers');
{
  // allocation-free board distance must match constants.boardDistance exactly
  let ok = true, s = 1;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 5000; i++) {
    const x = (r() - 0.5) * 66, z = (r() - 0.5) * 30;
    const a = boardDistance(x, z), b = boardDist(x, z);
    if (a.d !== b.d || a.nx !== b.nx || a.nz !== b.nz) { ok = false; break; }
  }
  check(ok, 'boardDist matches boardDistance');
  const g = createGame({}, 1);
  const s0 = snapshot(g);
  check(validateSnapshot(s0) === null, 'initial snapshot valid: ' + validateSnapshot(s0));
  check(s0.ph === PHASE.FACEOFF && s0.per === 1 && s0.clk === DEFAULT_CONFIG.periodLength, 'starts in FACEOFF, period 1, full clock');
  const ev = drainEvents(g);
  check(ev.length === 1 && ev[0].type === EVENT.PERIOD && ev[0].period === 1, 'createGame emits PERIOD {period:1}');
  check(drainEvents(g).length === 0, 'drainEvents clears the queue');
  step(g, DT, undefined); step(g, DT, null); step(g, DT, { 99: { mx: NaN, mz: 'x', b: 'zz' } });
  check(validateSnapshot(snapshot(g)) === null, 'step tolerates missing/garbage inputs');
  // snapshot numbers per player: all teams' jersey numbers
  const t = TEAMS[DEFAULT_CONFIG.teams[0]];
  check(s0.p[0].n === t.skaters[0].num && s0.p[3].n === t.goalie.num, 'jersey numbers from TEAMS');
}

// =====================================================================================
section('1. full AI-vs-AI game, periodLength 60');
{
  const wall = now();
  const st = runGame({ periodLength: 60 }, 2024, { validate: true });
  const wallMs = now() - wall;
  printGame(st, 'seed 2024');
  console.log(`    wall clock incl. validation ${wallMs.toFixed(0)} ms, max snapshot ${st.maxSnap} bytes`);
  check(st.game.ph === PHASE.GAME_OVER, 'game reaches GAME_OVER');
  for (const [name, ph] of Object.entries(PHASE)) check(st.phases.has(ph) || ph === PHASE.FACEOFF, `phase ${name} occurs`);
  check(st.periods >= 3 && st.periodEnds >= 3, `PERIOD x${st.periods} / PERIOD_END x${st.periodEnds}`);
  check(st.finals === 1, 'exactly one FINAL event');
  const goals = st.goals[0] + st.goals[1];
  check(goals >= 1 && goals <= 25, `total goals ${goals} in 1..25`);
  check(goals === st.final[0] + st.final[1], 'GOAL events match the score');
  check(st.final[0] !== st.final[1], 'game does not end tied');
  check(st.fights <= 2 && st.fights === st.fightEnds, `fights ${st.fights} <= 2, each one ends`);
  check(st.errors.length === 0, 'no snapshot/event errors' + (st.errors.length ? ': ' + st.errors.slice(0, 5).join(' | ') : ''));
  check(st.maxSnap < 4096, `snapshot JSON < 4 KB (max ${st.maxSnap})`);
  check(st.simMs < 2000, `3x60 s game simulates in < 2 s (${st.simMs.toFixed(0)} ms)`);
  check(st.simMs / st.ticks < 0.2, `< 0.2 ms per step (${(st.simMs / st.ticks).toFixed(4)} ms)`);
  // GAME_OVER is sticky
  const g = st.game;
  for (let i = 0; i < 120; i++) step(g, DT, {});
  check(g.ph === PHASE.GAME_OVER && drainEvents(g).every((e) => e.type !== EVENT.FINAL), 'GAME_OVER is sticky, FINAL once');
}

// =====================================================================================
section('2. 10 seeds x full 3x120 s games (tuning stats)');
{
  const agg = newStats();
  let otGames = 0, simMs = 0, ticks = 0, fights = 0, maxFights = 0, fightsOk = true;
  const totals = [];
  for (let i = 1; i <= 10; i++) {
    const st = runGame({ periodLength: 120 }, i * 7919);
    fights += st.fights; maxFights = Math.max(maxFights, st.fights);
    if (st.fights !== st.fightEnds) fightsOk = false;
    for (const k of ['goals', 'shots', 'hits', 'big', 'glass', 'saves', 'fires', 'passes', 'steals', 'onetimers']) {
      agg[k][0] += st[k][0]; agg[k][1] += st[k][1];
    }
    agg.whistles += st.whistles; agg.posts += st.posts;
    if (st.ot) otGames++;
    simMs += st.simMs; ticks += st.ticks;
    totals.push(`${st.final[0]}-${st.final[1]}${st.ot ? 'OT' : ''}`);
  }
  const per = (a) => (a[0] + a[1]) / 10;
  const goals = per(agg.goals), shots = per(agg.shots), saves = per(agg.saves);
  const savePct = (100 * saves) / (saves + goals);
  console.log(`  finals: ${totals.join('  ')}`);
  console.log(`  goals/game ${goals.toFixed(1)}  shots/game ${shots.toFixed(1)}  shooting% ${(100 * goals / shots).toFixed(1)}  save% ${savePct.toFixed(1)}`);
  console.log(`  hits/game ${per(agg.hits).toFixed(1)} (big ${per(agg.big).toFixed(1)})  glass/game ${per(agg.glass).toFixed(1)}  fires/game ${per(agg.fires).toFixed(1)}  OT games ${(10 * otGames)}%`);
  console.log(`  passes/game ${per(agg.passes).toFixed(1)}  one-timers/game ${per(agg.onetimers).toFixed(1)}  steals/game ${per(agg.steals).toFixed(1)}  whistles/game ${(agg.whistles / 10).toFixed(1)}  posts/game ${(agg.posts / 10).toFixed(1)}`);
  console.log(`  fights/game ${(fights / 10).toFixed(1)} (max ${maxFights})  home goals ${agg.goals[0]} away goals ${agg.goals[1]}  avg ${(1000 * simMs / ticks).toFixed(1)} us/step`);
  check(maxFights <= 2 && fightsOk, `fights stay rare (max ${maxFights}/game) and every fight ends`);
  check(goals >= 3 && goals <= 14, `goals/game ${goals.toFixed(1)} in a fun range`);
  check(shots >= 20 && shots <= 90, `shots/game ${shots.toFixed(1)} sane`);
  check(savePct >= 65 && savePct <= 93, `save% ${savePct.toFixed(1)} sane`);
  check(per(agg.hits) >= 15, `plenty of hits (${per(agg.hits).toFixed(1)}/game)`);
  check(per(agg.glass) >= 0.4, `glass breaks happen (${per(agg.glass).toFixed(1)}/game)`);
  check(agg.fires[0] + agg.fires[1] >= 2, 'ON FIRE happens');
  check(per(agg.onetimers) >= 2, 'one-timers happen');
}

// =====================================================================================
// Directed tests helpers

function toPlay(game) {
  for (let i = 0; i < 400 && game.ph !== PHASE.PLAY; i++) step(game, DT, {});
  drainEvents(game);
}
function place(p, x, z, f, vx = 0, vz = 0) {
  p.x = x; p.z = z; p.f = f; p.vx = vx; p.vz = vz; p.y = 0; p.vy = 0;
  p.s = PSTATE.SKATE; p.sT = 0; p.pickCd = 0; p.checkCd = 0; p.pokeCd = 0; p.dekeCd = 0;
}
function givePuckTo(game, p) {
  const pk = game.puck;
  pk.o = p.id; pk.x = p.x + Math.cos(p.f); pk.z = p.z + Math.sin(p.f); pk.y = 0;
  pk.vx = 0; pk.vy = 0; pk.vz = 0; game.flight = null; game.touches = [p.id]; game.possTeam = p.tm;
}
function runFor(game, ticks, inputFn, onTick) {
  const ev = [];
  for (let i = 0; i < ticks; i++) {
    step(game, DT, inputFn ? inputFn(i) : {});
    ev.push(...drainEvents(game));
    if (onTick) onTick(game, i);
  }
  return ev;
}
function runUntil(game, cond, maxTicks) {
  const ev = [];
  for (let i = 0; i < maxTicks && !cond(game); i++) { step(game, DT, {}); ev.push(...drainEvents(game)); }
  return ev;
}

// =====================================================================================
section('3a. human shoots into an empty net');
{
  const g = createGame({ periodLength: 60 }, 42);
  const pid = assignClient(g, 0, 1);
  check(pid === 0, `assignClient gives the lowest-index AI skater (${pid})`);
  toPlay(g);
  const p = g.players[pid];
  place(p, 21.5, 0.3, 0);
  // empty the net: away goalie knocked down far away, other skaters out of the play
  const gk = g.players[7];
  place(gk, 5, -10, Math.PI); gk.s = PSTATE.DOWN; gk.downDur = 60;
  for (const id of [1, 2]) place(g.players[id], -20, id * 4 - 6, 0);
  for (const id of [4, 5, 6]) place(g.players[id], -15, id * 3 - 15, 0);
  givePuckTo(g, p);
  const ev = runFor(g, 90, (i) => ({ 1: { mx: 1, mz: 0, b: i === 0 ? BTN.SHOOT : 0 } }));
  const shot = ev.find((e) => e.type === EVENT.SHOT);
  const goal = ev.find((e) => e.type === EVENT.GOAL);
  check(shot && shot.by === pid && shot.kind === 'wrist', 'tap SHOOT = wrist shot');
  check(goal && goal.team === 0 && goal.scorer === pid, 'shot into the empty net scores (GOAL by the human)');
  check(g.sc[0] === 1 && g.ph === PHASE.GOAL, 'score 1-0 and phase GOAL');
  check(g.players[pid].s === PSTATE.CELEBRATE, 'scorer celebrates');
  check(goal && goal.oneTimer === false && goal.assist === -1, 'unassisted, not a one-timer');
  // GOAL -> FACEOFF at center (formation, frozen) -> PLAY
  runUntil(g, (gm) => gm.ph !== PHASE.GOAL, 60 * 5);
  const s = snapshot(g);
  check(s.ph === PHASE.FACEOFF && s.k.x === 0 && s.k.z === 0 && s.phT > 1.5, 'GOAL phase ends with a center-ice faceoff');
  check(s.p.every((q) => q.vx === 0 && q.vz === 0 && q.s === PSTATE.SKATE), 'faceoff formation: nobody moves');
  check(Math.abs(s.p[0].x + 1.1) < 1e-6 && Math.abs(s.p[4].x - 1.1) < 1e-6, 'centers face off on the dot');
  const ev3 = runUntil(g, (gm) => gm.ph === PHASE.PLAY, 60 * 3);
  check(g.ph === PHASE.PLAY && ev3.some((e) => e.type === EVENT.FACEOFF), 'faceoff drops the puck (FACEOFF event)');
}

// =====================================================================================
section('3b. turbo body check on a carrier pinned on the boards -> big HIT + GLASS');
{
  const g = createGame({ periodLength: 60 }, 7);
  // every skater human-controlled (idle) so nothing interferes
  const ids = {};
  for (const [cid, team] of [[1, 0], [3, 0], [5, 0], [2, 1], [4, 1], [6, 1]]) ids[cid] = assignClient(g, team, cid);
  check(assignClient(g, 0, 9) === -1, 'assignClient returns -1 when a team has no AI skater left');
  toPlay(g);
  const checker = g.players[ids[1]], carrier = g.players[ids[2]];
  place(carrier, 0, 11.5, 0);
  place(checker, 0, 8.4, Math.PI / 2, 0, 9);
  place(g.players[ids[3]], -15, 0, 0); place(g.players[ids[5]], -15, 5, 0);
  place(g.players[ids[4]], 15, 0, 0); place(g.players[ids[6]], 15, -5, 0);
  givePuckTo(g, carrier);
  let maxY = 0;
  const ev = runFor(g, 30, (i) => ({ 1: { mx: 0, mz: 1, b: BTN.TURBO | (i === 0 ? BTN.SHOOT : 0) } }),
    (gm) => { maxY = Math.max(maxY, snapshot(gm).p[carrier.id].y); });
  const hit = ev.find((e) => e.type === EVENT.HIT);
  const glass = ev.find((e) => e.type === EVENT.GLASS);
  check(hit && hit.by === checker.id && hit.target === carrier.id, 'HIT event checker -> carrier');
  check(hit && hit.big === true && hit.power > 0.6, `HIT is big (power ${hit && hit.power})`);
  check(glass && glass.by === checker.id && glass.target === carrier.id, 'GLASS event');
  check(glass && snapshot(g).gl.includes(glass.panel), `broken panel ${glass && glass.panel} listed in gl`);
  check(carrier.s === PSTATE.DOWN, 'target is DOWN');
  check(g.puck.o !== carrier.id, 'target dropped the puck');
  check(maxY > 0.2, `target launched airborne (max y ${maxY.toFixed(2)})`);
  // glass is restored at the next faceoff
  g.puck.o = -1; g.puck.y = 5; g.puck.x = 0; g.puck.z = 12.95; g.puck.vz = 3; g.flight = null;
  const ev2 = runFor(g, 5);
  check(ev2.some((e) => e.type === EVENT.WHISTLE), 'puck over the glass -> WHISTLE');
  check(g.ph === PHASE.FACEOFF && snapshot(g).gl.length === 0, 'faceoff after whistle restores broken glass');
}

// =====================================================================================
section('3c. pass + SHOOT during the pass = one-timer');
{
  const g = createGame({ periodLength: 60 }, 99);
  for (const [cid, team] of [[1, 0], [2, 0], [3, 0], [4, 1], [5, 1], [6, 1]]) assignClient(g, team, cid);
  toPlay(g);
  const passer = g.players[0], recv = g.players[1];
  place(passer, 10, 5, -0.6);
  place(recv, 15, -4, 0);
  place(g.players[2], -10, 0, 0);
  place(g.players[4], -15, 8, 0); place(g.players[5], -15, -8, 0); place(g.players[6], -20, 0, 0);
  givePuckTo(g, passer);
  const dx = recv.x - passer.x, dz = recv.z - passer.z, dl = Math.hypot(dx, dz);
  const ev = runFor(g, 60, (i) => ({
    1: { mx: dx / dl, mz: dz / dl, b: i === 0 ? BTN.PASS : 0 },
    2: { mx: 0, mz: 0, b: i === 4 ? BTN.SHOOT : 0 },
  }));
  const pass = ev.find((e) => e.type === EVENT.PASS);
  const shot = ev.find((e) => e.type === EVENT.SHOT);
  check(pass && pass.by === 0 && pass.to === 1, 'PASS event toward the teammate in the stick direction');
  check(shot && shot.by === 1 && shot.kind === 'onetimer', `SHOT kind onetimer by the receiver (${shot && shot.kind})`);
  check(!ev.some((e) => e.type === EVENT.HIT), 'SHOOT during an incoming pass does not body-check');
}

// =====================================================================================
section('3d. PASS without the puck switches control; releaseClient returns it to AI');
{
  const g = createGame({ periodLength: 60 }, 5);
  const pid = assignClient(g, 0, 7);
  toPlay(g);
  place(g.players[0], -10, 0, 0);
  place(g.players[1], 5, 8, 0);
  place(g.players[2], 1, -1, 0);       // nearest to the puck
  const pk = g.puck;
  pk.o = -1; pk.x = 2; pk.z = -2; pk.vx = 0; pk.vz = 0; pk.y = 0;
  const ev = runFor(g, 2, (i) => ({ 7: { mx: 0, mz: 0, b: i === 0 ? BTN.PASS : 0 } }));
  const sw = ev.find((e) => e.type === EVENT.SWITCH);
  check(sw && sw.client === 7 && sw.from === pid && sw.to === 2, `SWITCH {client:7, from:${pid}, to:2} (${JSON.stringify(sw)})`);
  const s = snapshot(g);
  check(s.p[2].c === 7 && s.p[pid].c === 0, 'snapshot c field moved to the new skater');
  releaseClient(g, 7);
  const s2 = snapshot(g);
  check(s2.p.every((p) => p.c === 0), 'releaseClient returns the skater to AI');
  releaseClient(g, 12345);
  check(true, 'releaseClient of unknown client is a no-op');
  check(assignClient(g, 1, 7) === 4 && snapshot(g).p[4].c === 7, 'client can re-join on the other team');
  check(assignClient(g, 1, 7) === 4, 'assignClient is idempotent for the same team');
  check(assignClient(g, 0, 7) === 0 && snapshot(g).p[4].c === 0, 'assigning to the other team moves the client');
  // no AI skater to switch to -> nothing happens
  assignClient(g, 0, 8); assignClient(g, 0, 9);
  const ev2 = runFor(g, 3, (i) => ({ 7: { mx: 0, mz: 0, b: i === 1 ? BTN.PASS : 0 } }));
  check(!ev2.some((e) => e.type === EVENT.SWITCH), 'no SWITCH when no AI teammate is available');
}

// =====================================================================================
section('3e. determinism: same seed + same inputs -> identical snapshots');
{
  const script = (seed) => {
    let s = seed;
    const r = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    const plan = [];
    for (let i = 0; i < 5000; i++) {
      if (i % 20 === 0) plan.push({ mx: r() * 2 - 1, mz: r() * 2 - 1, b: Math.floor(r() * 16) });
      else plan.push(plan[plan.length - 1]);
    }
    return plan;
  };
  const plan = script(17);
  const run = () => {
    const g = createGame({ periodLength: 30, difficulty: 2 }, 31337);
    assignClient(g, 0, 1);
    const snaps = [];
    for (let i = 0; i < plan.length; i++) {
      if (i === 2500) releaseClient(g, 1);
      step(g, DT, { 1: plan[i] });
      snaps.push(JSON.stringify(snapshot(g)) + JSON.stringify(drainEvents(g)));
    }
    return snaps;
  };
  const a = run(), b = run();
  let same = a.length === b.length;
  for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) { same = false; console.error('  first diff at tick', i); }
  check(same, 'identical snapshot + event streams');
  const g1 = createGame({}, 1), g2 = createGame({}, 2);
  for (let i = 0; i < 600; i++) { step(g1, DT, {}); step(g2, DT, {}); }
  check(JSON.stringify(snapshot(g1)) !== JSON.stringify(snapshot(g2)), 'different seeds diverge');
}

// =====================================================================================
section('3f. overtime is sudden death');
{
  const g = createGame({ periodLength: 10, periods: 1 }, 3);
  // force a tie at the end of regulation
  for (let i = 0; i < 60 * 60 && g.ph !== PHASE.PERIOD_END; i++) { step(g, DT, {}); g.sc[0] = 0; g.sc[1] = 0; }
  drainEvents(g);
  for (let i = 0; i < 60 * 5 && g.ph === PHASE.PERIOD_END; i++) step(g, DT, {});
  const ev = drainEvents(g);
  check(g.per === 2 && ev.some((e) => e.type === EVENT.PERIOD && e.period === 2), 'tied after regulation -> OT period');
  let goalEv = null, ticks = 0;
  while (g.ph !== PHASE.GAME_OVER && ticks++ < 60 * 300) {
    step(g, DT, {});
    for (const e of drainEvents(g)) if (e.type === EVENT.GOAL && !goalEv) goalEv = e;
  }
  check(g.ph === PHASE.GAME_OVER && goalEv, 'first OT goal ends the game');
  check(g.sc[0] + g.sc[1] === 1, `OT ends 1-0 (${g.sc.join('-')})`);
}

// =====================================================================================
section('3g. AI skater retrieves a puck from behind the net; nets are solid');
{
  for (const [sx, sz] of [[20, 0], [20, 6], [33 - 3, -4]]) {
    const g = createGame({ periodLength: 60 }, 11);
    for (const [cid, team] of [[2, 0], [3, 0], [4, 1], [5, 1], [6, 1]]) assignClient(g, team, cid);  // skaters 0,1 human
    const ai = g.players.find((q) => q.tm === 0 && !q.g && q.c === 0);
    toPlay(g);
    place(ai, Math.min(sx, 24), sz, 0);
    for (const id of [0, 1]) place(g.players[id], -20, id * 5 - 3, 0);
    for (const id of [4, 5, 6]) place(g.players[id], -15, id * 3 - 15, 0);
    const pk = g.puck;
    pk.o = -1; pk.x = 28.6; pk.z = 0.2; pk.y = 0; pk.vx = 0; pk.vz = 0; g.flight = null;
    let got = -1, inNet = false;
    runFor(g, 60 * 5, null, (gm) => {
      if (got < 0 && gm.puck.o === ai.id) got = gm.tick;
      for (const q of gm.players) if (Math.abs(q.x) > 26.6 && Math.abs(q.x) < 27.7 && Math.abs(q.z) < 1.0) inNet = true;
    });
    check(got >= 0, `AI from (${Math.min(sx, 24)},${sz}) picks up the puck behind the net`);
    check(!inNet, 'no skater centre ever inside a net');
  }
}

// =====================================================================================
section('3h. fights: big hit between two tough guys -> fight mini-game -> faceoff');
{
  // Same pinned turbo check as 3b (Brask chk 8 hits Kallio chk 6). The real trigger is a
  // 25% roll on the sim PRNG, so search seeds for one that drops the gloves.
  // humanFighter: keep client 1 on the hitter and jab during the fight; else everyone -> AI.
  const scenario = (seed, humanFighter) => {
    const g = createGame({ periodLength: 60 }, seed);
    for (const [cid, team] of [[1, 0], [3, 0], [5, 0], [2, 1], [4, 1], [6, 1]]) assignClient(g, team, cid);
    toPlay(g);
    const checker = g.players[0], carrier = g.players[4];
    place(carrier, 0, 11.5, 0);
    place(checker, 0, 8.4, Math.PI / 2, 0, 9);
    place(g.players[1], -15, 0, 0); place(g.players[2], -15, 5, 0);
    place(g.players[5], 15, 0, 0); place(g.players[6], 15, -5, 0);
    givePuckTo(g, carrier);
    const log = [], snaps = [];
    let tick = 0;
    const ev = [];
    const inp = (i) => {
      if (i < 30) return { 1: { mx: 0, mz: 1, b: BTN.TURBO | (i === 0 ? BTN.SHOOT : 0) } };
      return humanFighter ? { 1: { mx: 0, mz: 0, b: i % 24 === 0 ? BTN.SHOOT : 0 } } : {};
    };
    for (; tick < 1100; tick++) {
      if (tick === 30) for (const cid of humanFighter ? [3, 5, 2, 4, 6] : [1, 3, 5, 2, 4, 6]) releaseClient(g, cid);
      step(g, DT, inp(tick));
      const e = drainEvents(g), s = snapshot(g);
      ev.push(...e.map((x) => ({ ...x, at: tick })));
      snaps.push(s);
      log.push(JSON.stringify(s) + JSON.stringify(e));
      if (ev.some((x) => x.type === EV_FIGHT_END) && g.ph === PHASE.PLAY) break;
    }
    return { g, ev, snaps, log };
  };
  let found = null, seed = 0;
  for (let s = 1; s <= 80 && !found; s++) {
    const r = scenario(s, false);
    if (r.ev.some((e) => e.type === EV_FIGHT_START)) { found = r; seed = s; }
  }
  check(found, 'some seed triggers a fight from the big hit');
  if (found) {
    const { g, ev, snaps } = found;
    console.log(`  seed ${seed}: ${ev.filter((e) => e.type === EV_FIGHT).length} fight events`);
    const start = ev.find((e) => e.type === EV_FIGHT_START);
    const end = ev.find((e) => e.type === EV_FIGHT_END);
    const hit = ev.find((e) => e.type === EVENT.HIT);
    check(start.a === 0 && start.b === 4, `fightStart {a:0, b:4} (${JSON.stringify(start)})`);
    check(hit && hit.big && start.at - hit.at >= 35 && start.at - hit.at <= 50, `gloves drop ~0.7 s after the big hit (${start.at - hit.at} ticks)`);
    check(ev.some((e) => e.type === EVENT.WHISTLE && e.at === start.at), 'whistle when the fight starts');
    const during = snaps.slice(start.at + 1, end.at);
    check(during.length > 60 && during.every((s) => s.fi && s.fi.a === 0 && s.fi.b === 4 && s.ph === PHASE.PLAY), 'fi present (phase PLAY) for the whole fight');
    check(during.every((s) => s.clk === during[0].clk), 'clock frozen during the fight');
    check(during.every((s) => s.p.every((p, i) => p.x === during[0].p[i].x && p.z === during[0].p[i].z)), 'skaters frozen during the fight');
    const fe = ev.filter((e) => e.type === EV_FIGHT);
    check(fe.length > 0 && fe.every((e) => FIGHT_SUBS.includes(e.sub) && e.t === EV_FIGHT), 'fight sub-events relayed as {type:"fight", sub}');
    check(fe.some((e) => e.sub === 'ko'), 'fight decided (ko sub-event)');
    check(end && [end.winner, end.loser].sort().join() === '0,4' && ['ko', 'time'].includes(end.how), `fightEnd ${JSON.stringify(end)}`);
    const after = snaps[end.at];
    check(after.fi === null && after.ph === PHASE.FACEOFF, 'fi null and FACEOFF right after the fight');
    check(after.p[end.winner].fire === 1 && after.p[end.winner].tb === 1, 'winner is ON FIRE with full turbo');
    check(ev.some((e) => e.type === EVENT.FIRE && e.on && e.player === end.winner && e.at === end.at), 'FIRE {on:true} for the winner');
    check(after.p[end.loser].tb === 0 && after.p[end.loser].s === PSTATE.DOWN, 'loser has no turbo and is DOWN');
    check(g.ph === PHASE.PLAY && g.players[end.loser].s !== PSTATE.DOWN, 'faceoff drops, loser back up');
    check(g.fights === 1 && validateSnapshot(snapshot(g)) === null, 'fight counted; snapshots valid');
    // determinism with a fight in the stream
    const again = scenario(seed, false);
    check(again.log.length === found.log.length && again.log.every((l, i) => l === found.log[i]), 'fight replay is deterministic');
    // a human-controlled fighter's buttons reach the fight
    const hum = scenario(seed, true);
    const hf = hum.ev.filter((e) => e.type === EV_FIGHT);
    check(hum.ev.some((e) => e.type === EV_FIGHT_START) &&
      hf.some((e) => (e.sub === 'punch' && e.by === 0) || ((e.sub === 'block' || e.sub === 'dodge') && e.target === 0)),
      'human fighter jabs (SHOOT) are applied');
    check(hum.ev.some((e) => e.type === EV_FIGHT_END), 'human-vs-AI fight ends');
  }
}

// =====================================================================================
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
