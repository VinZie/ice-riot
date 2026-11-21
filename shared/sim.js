// ICE RIOT - authoritative game simulation (pure module: no IO, no timers, no Date.now,
// no Math.random, no DOM/Node APIs; runs in Node and in the browser).
//
// API (see docs/CONTRACT.md):
//   createGame(config, seed?) -> game
//   step(game, dt, inputsByClient)
//   snapshot(game) -> Snapshot
//   drainEvents(game) -> events[]
//   assignClient(game, team, clientId) -> player id | -1
//   releaseClient(game, clientId)
//
// Modules: sim-util (PRNG/math/collision helpers), sim-player (skater control + actions),
// sim-goalie (goalie AI + saves), sim-puck (puck physics + pickups), sim-ai (skater AI).

import {
  DT, PHASE, PHASE_DURATION, PSTATE, EVENT, BTN, TEAMS, DEFAULT_CONFIG, FACEOFF_SPOTS,
  GOALIE_K, playerId, boardDistance, clamp,
} from './constants.js';
import {
  rand, emit, attackDir, radiusOf, collideBoards, collideNets, newFlight, r3,
  GRAV, GX, FL_LOOSE, FL_SHOT,
} from './sim-util.js';
import { controlSkater, addHeat, extinguish, igniteFire, glide, setState, shatterGlass, HEAT_COOL } from './sim-player.js';
import { tickPendingFight, fightTick, fightSnap, EV_FIGHT_END } from './sim-fight.js';
import { updateGoalie } from './sim-goalie.js';
import { stepPuck, checkPickups } from './sim-puck.js';
import { aiInput, makeAi, resetAi } from './sim-ai.js';

const { SKATE, CHARGE, DOWN, CELEBRATE } = PSTATE;
const MAX_EVENTS = 2000;
const ORDER_A = [0, 1, 2, 4, 5, 6], ORDER_B = [4, 5, 6, 0, 1, 2];   // skater ids

// ---- creation -------------------------------------------------------------------------

function attr(v, d) { return Number.isFinite(v) ? v : d; }

function makePlayer(team, k, def) {
  const g = k === GOALIE_K;
  const a = (g ? def && def.goalie : def && def.skaters && def.skaters[k]) || {};
  return {
    id: playerId(team, k), tm: team, k, g: g ? 1 : 0, n: attr(a.num, g ? 30 + team : 10 + k),
    spd: g ? 5 : attr(a.spd, 6), sht: g ? 3 : attr(a.sht, 6), pas: g ? 6 : attr(a.pas, 6),
    chk: g ? 3 : attr(a.chk, 6), hnd: g ? 5 : attr(a.hnd, 6), skill: g ? attr(a.skill, 7) : 0,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, f: 0,
    s: SKATE, sT: 0, tb: 1, fire: 0, heat: 0, heatT: 0, fireT: 0, ch: 0, c: 0,
    holdT: 0, possT: 0, downDur: 0, checkBig: false, hitDone: false, whiff: false,
    pokeDone: false, dekeSide: 1, pickCd: 0, dekeCd: 0, checkCd: 0, pokeCd: 0,
    otTick: -1, recvT: -1, mx: 0, mz: 0, glassT: 0, glassBy: -1, glassPow: 0,
    ai: makeAi(),
  };
}

export function createGame(config, seed) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  let teams = Array.isArray(cfg.teams) ? cfg.teams.slice(0, 2).map((t) => t | 0) : [0, 1];
  if (teams.length < 2 || teams.some((t) => t < 0 || t >= TEAMS.length)) teams = [0, 1];
  cfg.teams = teams;
  cfg.periodLength = Number(cfg.periodLength) > 0 ? Number(cfg.periodLength) : DEFAULT_CONFIG.periodLength;
  cfg.periods = Math.max(1, Number(cfg.periods) | 0 || DEFAULT_CONFIG.periods);
  const diff = Number(cfg.difficulty);
  cfg.difficulty = Number.isFinite(diff) ? clamp(Math.round(diff), 0, 2) : DEFAULT_CONFIG.difficulty;

  const game = {
    cfg,
    rng: (Number.isFinite(seed) ? seed : 12345) | 0,
    tick: 0, ph: PHASE.FACEOFF, phT: PHASE_DURATION.FACEOFF, per: 1, clk: cfg.periodLength,
    sc: [0, 0], teams: teams.slice(),
    players: [],
    puck: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, o: -1 },
    flight: null, gl: [], events: [],
    clients: new Map(), humans: [0, 0],
    touches: [], possTeam: -1, untouched: 0, untouchedAll: 0,
    pending: null, pendingSide: 0, puckInNet: 0, lastBoardsTick: -100, blocks: 0,
    fight: null, fightPending: null, fights: 0,
  };
  for (let t = 0; t < 2; t++) {
    for (let k = 0; k < 4; k++) game.players.push(makePlayer(t, k, TEAMS[teams[t]]));
  }
  emit(game, EVENT.PERIOD, { period: 1 });
  startFaceoff(game, FACEOFF_SPOTS[0]);
  return game;
}

// ---- clients --------------------------------------------------------------------------

function recountHumans(game) {
  game.humans[0] = 0; game.humans[1] = 0;
  for (const p of game.players) if (p.c) game.humans[p.tm]++;
}

function handOver(game, p, clientId) {
  if (p.s === CHARGE) setState(p, SKATE);
  p.c = clientId;
  resetAi(p, game);
}

export function assignClient(game, team, clientId) {
  const cid = Number(clientId);
  team = Number(team);
  if (!(cid > 0) || (team !== 0 && team !== 1)) return -1;
  const cur = game.clients.get(cid);
  if (cur) {
    if (game.players[cur.pid].tm === team) return cur.pid;
    releaseClient(game, cid);
  }
  for (let k = 0; k < GOALIE_K; k++) {
    const p = game.players[playerId(team, k)];
    if (p.c === 0) {
      handOver(game, p, cid);
      game.clients.set(cid, { pid: p.id, prevB: 0, b: 0, mx: 0, mz: 0, pressed: 0 });
      recountHumans(game);
      return p.id;
    }
  }
  return -1;
}

export function releaseClient(game, clientId) {
  const cid = Number(clientId);
  const cl = game.clients.get(cid);
  if (!cl) return;
  const p = game.players[cl.pid];
  if (p.c === cid) handOver(game, p, 0);
  game.clients.delete(cid);
  recountHumans(game);
}

// PASS without the puck: move control to the AI teammate nearest the puck.
function trySwitch(game, cid, cl) {
  const from = game.players[cl.pid], pk = game.puck;
  let best = null, bd = Infinity;
  for (const q of game.players) {
    if (q.tm !== from.tm || q.g || q.c !== 0 || q === from) continue;
    const d = (q.x - pk.x) ** 2 + (q.z - pk.z) ** 2;
    if (d < bd) { bd = d; best = q; }
  }
  if (!best) return false;
  handOver(game, from, 0);
  handOver(game, best, cid);
  cl.pid = best.id;
  emit(game, EVENT.SWITCH, { client: cid, from: from.id, to: best.id });
  return true;
}

// ---- phases -----------------------------------------------------------------------------

function placeFormation(game, spot) {
  for (let t = 0; t < 2; t++) {
    const a = attackDir(t);
    const sideZ = spot.z === 0 ? (t === 0 ? 1 : -1) : -Math.sign(spot.z);
    const f = a > 0 ? 0 : Math.PI;
    const pos = [
      [spot.x - a * 1.1, spot.z],                    // centre on the dot
      [spot.x - a * 2.4, spot.z + sideZ * 4.2],      // wing
      [spot.x - a * 7.5, spot.z - sideZ * 2.0],      // defense
    ];
    for (let k = 0; k < 3; k++) {
      const p = game.players[t * 4 + k];
      let x = clamp(pos[k][0], -24, 24), z = pos[k][1];
      const b = boardDistance(x, z);
      if (b.d < 1.5) { x += b.nx * (1.5 - b.d); z += b.nz * (1.5 - b.d); }
      p.x = x; p.z = z; p.f = f;
    }
    const g = game.players[t * 4 + GOALIE_K];
    g.x = -a * (GX - 0.75); g.z = 0; g.f = f;
  }
}

function startFaceoff(game, spot) {
  game.ph = PHASE.FACEOFF;
  game.phT = PHASE_DURATION.FACEOFF;
  game.faceSpot = spot;
  game.gl = [];                                       // broken glass is restored
  const pk = game.puck;
  pk.x = spot.x; pk.z = spot.z; pk.y = 0; pk.vx = 0; pk.vy = 0; pk.vz = 0; pk.o = -1;
  game.flight = null; game.puckInNet = 0; game.pending = null; game.fightPending = null;
  game.touches.length = 0; game.possTeam = -1; game.untouched = 0; game.untouchedAll = 0;
  placeFormation(game, spot);
  for (const p of game.players) {
    p.vx = 0; p.vy = 0; p.vz = 0; p.y = 0;
    setState(p, SKATE);
    p.holdT = 0; p.possT = 0; p.otTick = -1; p.recvT = -1; p.glassT = 0;
    p.pickCd = 0; p.dekeCd = 0; p.checkCd = 0; p.pokeCd = 0;
    resetAi(p, game);
  }
}

function dropPuck(game) {
  const pk = game.puck, s = game.faceSpot;
  pk.x = s.x; pk.z = s.z; pk.y = 0.5; pk.vy = 0;
  // a little random bounce off the drop so faceoffs aren't identical
  const a = rand(game) * 2 * Math.PI;
  pk.vx = Math.cos(a) * 0.6; pk.vz = Math.sin(a) * 0.6;
  pk.o = -1;
  game.flight = newFlight(game, FL_LOOSE, -1);
  game.ph = PHASE.PLAY; game.phT = 0;
  emit(game, EVENT.FACEOFF, { x: s.x, z: s.z });
}

function whistle(game) {
  emit(game, EVENT.WHISTLE, {});
  startFaceoff(game, nearestSpot(game.puck.x, game.puck.z));
}

function scoreGoal(game, team) {
  game.sc[team]++;
  const t = game.touches;
  let scorer = -1, assist = -1;
  for (let i = t.length - 1; i >= 0; i--) {
    if (game.players[t[i]].tm !== team) continue;
    if (scorer < 0) scorer = t[i];
    else if (t[i] !== scorer) { assist = t[i]; break; }
  }
  const fl = game.flight;
  const oneTimer = !!fl && fl.kind === FL_SHOT && fl.shotKind === 'onetimer' && fl.by === scorer;
  const pk = game.puck;
  emit(game, EVENT.GOAL, { team, scorer, assist, oneTimer, x: r3(pk.x), z: r3(pk.z) });
  for (const p of game.players) if (p.tm !== team) extinguish(game, p);   // scored on: heat resets
  if (scorer >= 0) {
    const s = game.players[scorer];
    addHeat(game, s, oneTimer ? 3 : 2);
    if (!s.g) setState(s, CELEBRATE);
  }
  if (assist >= 0) addHeat(game, game.players[assist], 1);
  pk.o = -1;
  game.flight = null;
  if (game.per > game.cfg.periods) endGame(game);    // sudden death
  else { game.ph = PHASE.GOAL; game.phT = PHASE_DURATION.GOAL; }
}

function endPeriod(game) {
  game.ph = PHASE.PERIOD_END;
  game.phT = PHASE_DURATION.PERIOD_END;
  game.clk = 0;
  emit(game, EVENT.PERIOD_END, { period: game.per });
  const pk = game.puck;
  if (pk.o >= 0) { pk.o = -1; game.flight = newFlight(game, FL_LOOSE, -1); }
}

function endGame(game) {
  game.ph = PHASE.GAME_OVER;
  game.phT = 0;
  game.fightPending = null;
  emit(game, EVENT.FINAL, { score: game.sc.slice() });
  const w = game.sc[0] > game.sc[1] ? 0 : game.sc[1] > game.sc[0] ? 1 : -1;
  for (const p of game.players) if (p.tm === w && !p.g && p.s !== DOWN) setState(p, CELEBRATE);
}

// ---- tick ---------------------------------------------------------------------------------

function readInputs(game, inputs) {
  const isMap = inputs instanceof Map;
  for (const [cid, cl] of game.clients) {
    let inp = null;
    if (inputs) inp = isMap ? (inputs.get(cid) || inputs.get(String(cid))) : inputs[cid];
    let mx = 0, mz = 0, b = 0;
    if (inp) {
      mx = Number(inp.mx); mz = Number(inp.mz); b = (inp.b | 0) & 15;
      if (!Number.isFinite(mx)) mx = 0;
      if (!Number.isFinite(mz)) mz = 0;
    }
    cl.mx = clamp(mx, -1, 1); cl.mz = clamp(mz, -1, 1);
    cl.pressed = b & ~cl.prevB;
    cl.b = b; cl.prevB = b;
  }
}

function integratePlayers(game, dt) {
  const P = game.players;
  for (const p of P) {
    p.x += p.vx * dt; p.z += p.vz * dt;
    if (p.y > 0 || p.vy > 0) {
      p.vy -= GRAV * dt; p.y += p.vy * dt;
      if (p.y <= 0) { p.y = 0; p.vy = 0; }
    }
  }
  // soft bumps between bodies (goalies are heavy)
  for (let i = 0; i < P.length; i++) {
    const a = P[i], ra = radiusOf(a), ma = a.g ? 3 : 1;
    for (let j = i + 1; j < P.length; j++) {
      const b = P[j];
      const dx = b.x - a.x, dz = b.z - a.z, rr = ra + radiusOf(b);
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2), pen = rr - d;
      const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0;   // exact overlap: split along x
      const mb = b.g ? 3 : 1, wa = mb / (ma + mb), wb = ma / (ma + mb);
      a.x -= nx * pen * wa; a.z -= nz * pen * wa;
      b.x += nx * pen * wb; b.z += nz * pen * wb;
      const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (rel < 0) {
        const j2 = (-1.2 * rel) / (1 / ma + 1 / mb);
        a.vx -= (j2 / ma) * nx; a.vz -= (j2 / ma) * nz;
        b.vx += (j2 / mb) * nx; b.vz += (j2 / mb) * nz;
      }
    }
  }
  for (const p of P) {
    const r = radiusOf(p);
    const impact = collideBoards(p, r, 0.3);
    if (p.glassT > 0) {
      p.glassT -= dt;
      if (impact > 2 && game.ph === PHASE.PLAY) shatterGlass(game, p.glassBy, p, p.glassPow);
    }
    collideNets(p, r);
  }
}

function playTick(game, dt) {
  const P = game.players, pk = game.puck;
  game.clk -= dt;

  // human control switches (PASS without the puck)
  for (const [cid, cl] of game.clients) {
    if ((cl.pressed & BTN.PASS) && pk.o !== cl.pid && trySwitch(game, cid, cl)) cl.pressed &= ~BTN.PASS;
  }
  // skaters: humans and AI through the same control code. The team processed first
  // alternates every tick so neither side gets a first-mover edge on hits/pokes.
  const order = game.tick & 1 ? ORDER_B : ORDER_A;
  for (let i = 0; i < order.length; i++) {
    const p = P[order[i]];
    if (p.c) {
      const cl = game.clients.get(p.c);
      controlSkater(game, p, cl.mx, cl.mz, cl.b, cl.pressed, dt);
    } else {
      const o = aiInput(game, p, dt);
      const pressed = o.b & ~p.ai.prevB;
      p.ai.prevB = o.b;
      controlSkater(game, p, o.mx, o.mz, o.b, pressed, dt);
    }
  }
  if (game.tick & 1) { updateGoalie(game, P[4 + GOALIE_K], dt); updateGoalie(game, P[GOALIE_K], dt); }
  else { updateGoalie(game, P[GOALIE_K], dt); updateGoalie(game, P[4 + GOALIE_K], dt); }
  integratePlayers(game, dt);

  const px = pk.x, pz = pk.z;
  stepPuck(game, dt);
  if (!game.pending && pk.o < 0) checkPickups(game, px, pz);

  if (game.pending === 'goal') { game.pending = null; scoreGoal(game, game.pendingSide > 0 ? 0 : 1); return; }
  if (game.pending === 'out') { game.pending = null; whistle(game); return; }
  if (pk.o < 0) {
    // stuck = nobody touched it for 5 s while it was barely moving (15 s cap regardless)
    if (pk.vx * pk.vx + pk.vz * pk.vz < 16) game.untouched += dt;
    game.untouchedAll += dt;
    if (game.untouched > 5 || game.untouchedAll > 15) { whistle(game); return; }
  }
  for (const p of P) {
    if (p.fire) { if ((p.fireT -= dt) <= 0) extinguish(game, p); }
    else if (p.heat > 0 && (p.heatT += dt) >= HEAT_COOL) { p.heat--; p.heatT = 0; }   // streaks cool off
  }
  if (game.clk <= 0) { endPeriod(game); return; }
  if (game.fightPending) tickPendingFight(game, dt);   // gloves off: the world freezes from next tick
}

function nearestSpot(x, z) {
  let best = FACEOFF_SPOTS[0], bd = Infinity;
  for (const s of FACEOFF_SPOTS) {
    const d = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

// A fight is running: physics, the clock and skater AI are frozen (phase stays PLAY).
function fightPhaseTick(game, dt) {
  const res = fightTick(game, dt);
  if (!res) return;
  game.fight = null;
  const W = game.players[res.winner], L = game.players[res.loser];
  emit(game, EV_FIGHT_END, { winner: W.id, loser: L.id, how: res.how });
  igniteFire(game, W);
  W.tb = res.winnerTurbo;
  L.tb = res.loserTurbo;
  startFaceoff(game, nearestSpot((W.x + L.x) / 2, (W.z + L.z) / 2));   // where the scrap happened
  setState(L, DOWN);                       // the loser is still picking himself up off the ice
  L.downDur = res.loserDown;
}

// Dead-puck phases: everyone glides, downed players get up, the puck coasts.
function glideTick(game, dt) {
  for (const p of game.players) {
    p.sT += dt;
    glide(p, p.s === CELEBRATE ? 2.5 : 4, dt);
    if (p.s === DOWN && p.sT >= p.downDur && p.y <= 0) setState(p, SKATE);
    if (p.pickCd > 0) p.pickCd -= dt;
    if (!p.fire && p.tb < 1) p.tb = Math.min(1, p.tb + dt / 5);
  }
  integratePlayers(game, dt);
  stepPuck(game, dt);
  game.pending = null;
}

export function step(game, dt, inputsByClient) {
  if (!(dt > 0) || dt > 0.1) dt = DT;
  game.tick++;
  readInputs(game, inputsByClient);
  switch (game.ph) {
    case PHASE.FACEOFF:
      for (const p of game.players) {
        if (p.s === DOWN && (p.sT += dt) >= p.downDur) setState(p, SKATE);   // fight loser gets up
      }
      game.phT -= dt;
      if (game.phT <= 0) dropPuck(game);
      break;
    case PHASE.PLAY:
      if (game.fight) fightPhaseTick(game, dt);
      else playTick(game, dt);
      break;
    case PHASE.GOAL:
      glideTick(game, dt);
      game.phT -= dt;
      if (game.phT <= 0) startFaceoff(game, FACEOFF_SPOTS[0]);
      break;
    case PHASE.PERIOD_END:
      glideTick(game, dt);
      game.phT -= dt;
      if (game.phT <= 0) {
        if (game.per >= game.cfg.periods && game.sc[0] !== game.sc[1]) endGame(game);
        else {
          game.per++;
          game.clk = game.cfg.periodLength;
          emit(game, EVENT.PERIOD, { period: game.per });
          startFaceoff(game, FACEOFF_SPOTS[0]);
        }
      }
      break;
    default: // GAME_OVER: the sim idles, players glide / celebrate
      glideTick(game, dt);
      break;
  }
  if (game.events.length > MAX_EVENTS) game.events.splice(0, game.events.length - MAX_EVENTS / 2);
}

// ---- output -------------------------------------------------------------------------------

export function snapshot(game) {
  const timed = game.ph === PHASE.FACEOFF || game.ph === PHASE.GOAL || game.ph === PHASE.PERIOD_END;
  const p = new Array(game.players.length);
  for (let i = 0; i < game.players.length; i++) {
    const q = game.players[i];
    p[i] = {
      id: q.id, tm: q.tm, g: q.g,
      x: r3(q.x), y: r3(q.y), z: r3(q.z), vx: r3(q.vx), vz: r3(q.vz), f: r3(q.f),
      s: q.s, sT: r3(q.sT), tb: r3(q.tb), fire: q.fire ? 1 : 0,
      ch: q.s === CHARGE ? r3(q.ch) : 0, c: q.c, n: q.n,
    };
  }
  const k = game.puck;
  return {
    tick: game.tick, ph: game.ph, phT: timed ? r3(Math.max(0, game.phT)) : 0,
    per: game.per, clk: r3(Math.max(0, game.clk)),
    sc: [game.sc[0], game.sc[1]], teams: [game.teams[0], game.teams[1]],
    p,
    k: { x: r3(k.x), y: r3(k.y), z: r3(k.z), vx: r3(k.vx), vy: r3(k.vy), vz: r3(k.vz), o: k.o },
    gl: game.gl.slice(),
    fi: fightSnap(game),                 // extension: fight.js snapshot while a fight runs, else null
  };
}

export function drainEvents(game) {
  const ev = game.events;
  game.events = [];
  return ev;
}
