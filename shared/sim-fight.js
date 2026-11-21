// ICE RIOT sim - hockey-fight integration. The fight mini-game itself lives in
// shared/fight.js (pure + deterministic, owned by another agent); this module only wires it
// into the game: trigger after a big hit, freeze the world while it runs, relay its events.
//
// Game state:  game.fight (fight.js state object or null), game.fightPending ({a,b,t} or null),
//              game.fights (count this game).
// Events:      'fightStart' {a, b}, 'fight' {sub, ...fight.js event}, 'fightEnd' {winner, loser, how}
//              (+ a 'whistle' when the gloves drop). Snapshot gets `fi` (see fightSnap).

import { PSTATE, EVENT } from './constants.js';
import {
  createFight, stepFight, fightSnapshot, drainFightEvents, fightResult, shouldTriggerFight,
} from './fight.js';
import { rand, emit, r3, clampInside, collideNets } from './sim-util.js';

export const EV_FIGHT = 'fight', EV_FIGHT_START = 'fightStart', EV_FIGHT_END = 'fightEnd';
const FIGHT_DELAY = 0.7;    // let the hit play out before the gloves drop
const tmp = { x: 0, z: 0, vx: 0, vz: 0 };

// Called for every big skater-on-skater hit during PLAY.
export function queueFight(game, hitter, target) {
  if (game.fight || game.fightPending || hitter.g || target.g || hitter.tm === target.tm) return;
  const roll = rand(game);
  if (!shouldTriggerFight({ big: true, chkBy: hitter.chk, chkTarget: target.chk, fights: game.fights, roll })) return;
  game.fightPending = { a: hitter.id, b: target.id, t: FIGHT_DELAY };
}

// Called at the end of each PLAY tick. Returns true when a fight just started.
export function tickPendingFight(game, dt) {
  const pf = game.fightPending;
  if (!pf || (pf.t -= dt) > 0) return false;
  game.fightPending = null;
  const A = game.players[pf.a], B = game.players[pf.b];
  game.fight = createFight({
    a: A.id, b: B.id, teamA: A.tm, teamB: B.tm, chkA: A.chk, chkB: B.chk,
    seed: (rand(game) * 2147483647) | 0, difficulty: game.cfg.difficulty,
  });
  game.fights++;
  // freeze the world where it stands; the two combatants square up
  for (const p of game.players) { p.vx = 0; p.vz = 0; p.vy = 0; p.y = 0; }
  const pk = game.puck;
  pk.vx = 0; pk.vy = 0; pk.vz = 0;
  if (pk.o < 0) pk.y = 0;
  placeFighters(A, B);
  emit(game, EVENT.WHISTLE, {});
  emit(game, EV_FIGHT_START, { a: A.id, b: B.id });
  return true;
}

function placeFighters(A, B) {
  let dx = B.x - A.x, dz = B.z - A.z;
  let d = Math.hypot(dx, dz);
  if (d < 1e-3) { dx = Math.cos(A.f); dz = Math.sin(A.f); d = 1; }
  dx /= d; dz /= d;
  clampInside(tmp, (A.x + B.x) / 2, (A.z + B.z) / 2, 1.6);
  tmp.vx = 0; tmp.vz = 0;
  collideNets(tmp, 1.3);
  const fa = Math.atan2(dz, dx);
  for (const [P, s] of [[A, -1], [B, 1]]) {
    P.x = tmp.x + dx * 0.6 * s; P.z = tmp.z + dz * 0.6 * s;
    P.f = s < 0 ? fa : (fa > 0 ? fa - Math.PI : fa + Math.PI);
    P.s = PSTATE.SKATE; P.sT = 0; P.ch = 0; P.downDur = 0; P.glassT = 0;
  }
}

function inputFor(game, id) {
  const p = game.players[id];
  if (!p.c) return null;                          // AI-controlled skater: fight.js AI
  const cl = game.clients.get(p.c);
  return cl ? { b: cl.b } : null;
}

// One frozen-world tick of an active fight. Returns fightResult() once it is done, else null.
export function fightTick(game, dt) {
  const f = game.fight;
  stepFight(f, dt, inputFor(game, f.A.id), inputFor(game, f.B.id));
  for (const e of drainFightEvents(f)) game.events.push({ ...e, type: EV_FIGHT, t: EV_FIGHT, sub: e.type });
  return f.done ? fightResult(f) : null;
}

// Snapshot field `fi`: fight.js snapshot with numbers rounded like the rest (JSON-safe).
export function fightSnap(game) {
  if (!game.fight) return null;
  const s = fightSnapshot(game.fight);
  for (const k in s) if (typeof s[k] === 'number') s[k] = r3(s[k]);
  return s;
}
