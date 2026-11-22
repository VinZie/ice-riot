// ICE RIOT sim - goalies (always AI): crease positioning, save rolls, rebounds,
// catch-and-hold + outlet pass, poke checks on carriers who get too close.

import { PSTATE, PHASE, EVENT, clamp } from './constants.js';
import {
  rand, defendSide, turnToward, emit, newFlight, distPointSeg, r3,
  GRAV, GX, HW, GH, FL_LOOSE, FL_SHOT,
} from './sim-util.js';
import { givePuck, loosePuck, doPass, touch, glide, setState } from './sim-player.js';

const { SKATE, DOWN, SAVE, CELEBRATE, DEKE } = PSTATE;
export const SAVE_T = 0.55;
const HOLD_T = 0.6;
// A shot's fate is decided this far out from the goal line (a pass or loose puck: when it reaches
// the goalie). A save is then made when the puck gets to him; a goal is steered so its path clears
// his body by BODY (centre to puck) and still goes in at least POST_IN inside a post - if it has to,
// he slides the wrong way, at up to BEAT_VMAX - and he can't move into the path until it's by him.
const DECIDE = 6.0, BODY = 0.58, POST_IN = 0.15, BEAT_VMAX = 6.5;

// Difficulty nudges the save chance of the all-AI team's goalie when humans play it.
function goalieBonus(game, team) {
  const h = game.humans, d = game.cfg.difficulty - 1;
  if (h[team] === 0 && h[1 - team] > 0) return d * 0.05;
  if (h[team] > 0 && h[1 - team] === 0) return -d * 0.03;
  return 0;
}

// Probability that goalie g stops a puck released at (x0,z0) with `speed`, crossing the
// goal line at (zc, yc). `lat` = goalie lateral speed relative to the shot direction. `tArr`
// (optional): seconds until the puck reaches him - a save decided early is judged on the goalie as
// he will be then (still diving from the last save or not, mostly done shuffling across).
export function saveProb(game, g, x0, z0, speed, kind, fire, zc, yc, lat, tArr = 0) {
  if (tArr > 0) lat *= clamp(1 - tArr / 0.25, 0, 1);
  const side = defendSide(g.tm);
  const ahead = Math.max(0.1, GX - side * x0);
  const dist = Math.hypot(ahead, z0);
  const ang = Math.atan2(Math.abs(z0), ahead);
  // reaction time is what matters: far + slow = easy, close + hard = tough
  const react = clamp(dist / Math.max(5, speed), 0.1, 0.6);
  let p = 0.67 + g.skill * 0.03;
  p += (react - 0.2) * 0.4;
  p += Math.max(0, ang - 0.7) * 0.3;          // sharp angles are easier
  p -= Math.min(1, Math.abs(zc) / HW) * 0.06; // corners
  if (yc > 0.75) p -= 0.03;                   // up high
  if (kind === 'onetimer') p -= 0.05 + Math.min(0.08, lat * 0.03);  // goalie still sliding across
  else p -= Math.min(0.06, lat * 0.02);
  if (fire) p -= 0.12;
  if (g.s === SAVE && g.sT + tArr < SAVE_T) p -= 0.25;   // already committed to a dive
  else if (g.s === DOWN) p -= 0.6;
  p += goalieBonus(game, g.tm);
  return clamp(p, 0.04, 0.97);
}

// Called every puck substep while the puck is loose in PLAY. Returns true if the save roll
// changed the puck's motion (a save, or a goal steered past the goalie).
export function checkSave(game) {
  const fl = game.flight;
  if (!fl) return false;
  const pk = game.puck;
  if (fl.saveDone) {
    // a save decided early: he makes it when the puck gets to him (or reaches his line)
    if (fl.saveG >= 0) {
      const g = game.players[fl.saveG];
      const dx = pk.x - g.x, dz = pk.z - g.z, reach = g.s === SAVE ? 1.35 : 1.12;
      if (dx * dx + dz * dz <= reach * reach || defendSide(g.tm) * (pk.x - g.x) >= 0) {
        fl.saveG = -1;
        if (g.s !== DOWN) { makeSave(game, g, Math.hypot(pk.vx, pk.vz)); return true; }
      }
    }
    return false;
  }
  for (let t = 0; t < 2; t++) {
    const g = game.players[t * 4 + 3];
    if (fl.team === g.tm && fl.kind !== FL_LOOSE) continue;  // own team's pass/shot
    const side = defendSide(g.tm);
    const vu = side * pk.vx;
    if (vu < 4) continue;                                  // not moving at this goal
    const u = side * pk.x - GX;
    if (u > 0.02) continue;
    const dx = pk.x - g.x, dz = pk.z - g.z;
    const reach = g.s === SAVE ? 1.35 : 1.12;
    const inReach = dx * dx + dz * dz <= reach * reach;
    if (!inReach && !(fl.kind === FL_SHOT && -u <= DECIDE)) continue;
    if (pk.y > 1.75) continue;
    // will it hit the net?
    const tt = -u / vu;
    const zc = pk.z + pk.vz * tt;
    const yc = pk.y > 0.001 || pk.vy > 0 ? pk.y + pk.vy * tt - 0.5 * GRAV * tt * tt : 0;
    if (Math.abs(zc) > HW + 0.04 || yc > GH + 0.04) continue;  // wide/high: let it go
    // deciding a shot early: only one whose path comes near him (else he rolls when it's in reach)
    if (!inReach && distPointSeg(g.x, g.z, pk.x, pk.z, pk.x + pk.vx * tt, zc) > reach + 0.3) continue;
    fl.saveDone = true;
    const sp = Math.hypot(pk.vx, pk.vz);
    const lat = Math.abs((-pk.vz * g.vx + pk.vx * g.vz) / (sp || 1));
    const tArr = inReach ? 0 : Math.max(0, (g.x - pk.x) / pk.vx - 0.03);   // ~ when it gets in his reach
    const ps = saveProb(game, g, fl.x0, fl.z0, sp, fl.kind === FL_SHOT ? fl.shotKind : 'loose', fl.fire, zc, yc, lat, tArr);
    let save = g.s !== DOWN && rand(game) < ps;
    if (!save && g.s !== DOWN && !beatGoalie(game, g, tt)) save = true;   // no way past him that goes in
    if (save) {
      if (inReach) { makeSave(game, g, sp); return true; }
      fl.saveG = g.id;
      return false;
    }
    fl.beaten = true;
    return true;
  }
  return false;
}

// A goal: make sure the puck's path clears his body. Already clear: he just mustn't move into it.
// Else bend it past him on the side it is beating him (still inside the post), or - when that would
// go wide - aim it inside the post and have him slide the other way (he bit on it). `tl` = time to
// the goal line. Returns false when there's no way past him in time (then he saves it after all).
function beatGoalie(game, g, tl) {
  const pk = game.puck;
  const tg = (g.x - pk.x) / pk.vx;                     // time to his plane
  if (!(tg > 0.004)) return true;                      // level with or past him already
  const yg = pk.y > 0.001 || pk.vy > 0 ? pk.y + pk.vy * tg - 0.5 * GRAV * tg * tg : 0;
  if (yg > 1.5) return true;                           // over him
  const zg = pk.z + pk.vz * tg, k = tl / tg;           // k: goal-line distance / his-plane distance
  const lim = HW - POST_IN;
  const begin = (pz, stay) => { g.beatT = tg + 0.05; g.beatZ = pz; g.beatS = stay; };
  if (Math.abs(zg - g.z) >= BODY) { begin(zg, g.z >= zg ? 1 : -1); return true; }
  const first = Math.sign(pk.z + pk.vz * tl - g.z) || Math.sign(zg - g.z) || (g.z > 0 ? -1 : 1);
  for (const s2 of [first, -first]) {
    const zg1 = g.z + s2 * BODY;                       // just past him on that side...
    if (Math.abs(pk.z + (zg1 - pk.z) * k) <= lim) { pk.vz = (zg1 - pk.z) / tg; begin(zg1, -s2); return true; }
    const zg2 = pk.z + (s2 * lim - pk.z) / k;          // ...or inside that post, and he slides off it
    if (Math.abs(zg2 - s2 * BODY - g.z) <= BEAT_VMAX * tg * 0.8) { pk.vz = (zg2 - pk.z) / tg; begin(zg2, -s2); return true; }
  }
  return false;
}

// While a goal is on its way past him: keep his body (centre) BODY clear of its path on his side
// (g.beatS), sliding out at up to BEAT_VMAX if he has to. Once it's by him he dives, too late.
function holdBeat(game, g, dt) {
  const pk = game.puck, fl = game.flight;
  if (!(fl && fl.beaten && pk.o < 0)) { g.beatT = 0; return; }   // blocked / picked up / scored
  g.beatT -= dt;
  if (g.beatT <= 0 || defendSide(g.tm) * (pk.x - g.x) > 0) { lateDive(g); return; }
  const zLim = g.beatZ + g.beatS * BODY, nz = g.z + g.vz * dt;
  if (g.beatS * (nz - zLim) >= 0) return;
  if (g.beatS * (g.z - zLim) >= 0) g.vz = (zLim - g.z) / dt;   // stop at the edge of the path
  else g.vz = clamp((zLim - g.z) / Math.max(dt, g.beatT * 0.8), -BEAT_VMAX, BEAT_VMAX);
}

/** The puck is past him (or in): end a beat with a late dive. Also called when the goal is scored. */
export function lateDive(g) {
  if (!(g.beatT > 0)) return;
  g.beatT = 0;
  if (g.s === SKATE) setState(g, SAVE);
}

function makeSave(game, g, sp) {
  const pk = game.puck;
  const out = -defendSide(g.tm);
  setState(g, SAVE);
  g.vz += clamp((pk.z - g.z) * 4, -3, 3);
  emit(game, EVENT.SAVE, { goalie: g.id, x: r3(pk.x), z: r3(pk.z) });
  const catchP = sp < 30 ? 0.5 : sp < 40 ? 0.35 : 0.22;
  if (pk.y < 1.4 && rand(game) < catchP) {
    // glove / cover: hold it, then outlet pass
    pk.x = g.x + out * 0.5; pk.z = g.z; pk.vx = 0; pk.vz = 0;
    givePuck(game, g);
    g.holdT = 0;
    return;
  }
  // deflect: rebound out to the side / corner
  const sgn = Math.abs(pk.z - g.z) > 0.1 ? Math.sign(pk.z - g.z) : (rand(game) < 0.5 ? -1 : 1);
  const a = 0.6 + rand(game) * 0.75;
  const ns = sp * (0.2 + rand(game) * 0.22) + 2;
  pk.x = g.x + out * 0.75; pk.z = g.z + sgn * 0.3; pk.y = Math.max(pk.y, 0.05);
  pk.vx = out * Math.cos(a) * ns; pk.vz = sgn * Math.sin(a) * ns; pk.vy = 0.8 + rand(game) * 2.2;
  touch(game, g, false);
  game.flight = newFlight(game, FL_LOOSE, g.id);
  g.pickCd = 0.5;
}

// Outlet pass from a goalie holding the puck: the most open skater (humans favoured).
function goaliePass(game, g) {
  let best = null, bs = -1e9;
  for (const q of game.players) {
    if (q.tm !== g.tm || q.g || q.s === DOWN) continue;
    let open = 10, lane = 10;
    for (const o of game.players) {
      if (o.tm === g.tm) continue;
      open = Math.min(open, Math.hypot(o.x - q.x, o.z - q.z));
      lane = Math.min(lane, distPointSeg(o.x, o.z, g.x, g.z, q.x, q.z));
    }
    const s = open + Math.min(lane, 3) * 1.2 + (q.c > 0 ? 1.5 : 0);
    if (s > bs) { bs = s; best = q; }
  }
  if (!best) { g.holdT = HOLD_T * 0.5; return; }
  doPass(game, g, best.x - g.x, best.z - g.z, best);
  g.pickCd = 0.6;
}

function goaliePoke(game, g, q) {
  const pk = game.puck, out = -defendSide(g.tm);
  const a = Math.atan2(clamp(pk.z - g.z, -1, 1) * 0.8 + (rand(game) - 0.5), out);
  const s = 5 + rand(game) * 3;
  q.pickCd = Math.max(q.pickCd, 0.45);
  loosePuck(game, Math.cos(a) * s, 0, Math.sin(a) * s, g.id);
  touch(game, g, false);
  game.flight.saveDone = true;
  emit(game, EVENT.STEAL, { by: g.id, from: q.id });
}

// Goalie behaviour for one tick (velocity only; sim.js integrates positions).
export function updateGoalie(game, g, dt) {
  g.sT += dt;
  if (g.pickCd > 0) g.pickCd -= dt;
  const pk = game.puck;
  const side = defendSide(g.tm), out = -side, gcx = side * GX;

  if (g.s === DOWN) {
    glide(g, 4, dt);
    if (g.sT >= g.downDur && g.y <= 0) setState(g, SKATE);
    return;
  }
  if (g.s === CELEBRATE) { glide(g, 4, dt); return; }
  if (g.s === SAVE) {
    glide(g, 6, dt);
    if (g.beatT > 0) holdBeat(game, g, dt);
    if (g.sT >= SAVE_T) setState(g, SKATE);
    else if (pk.o !== g.id) return;
  }
  if (pk.o === g.id) {
    g.holdT += dt;
    glide(g, 10, dt);
    g.f = turnToward(g.f, out > 0 ? 0 : Math.PI, 6 * dt);
    if (g.holdT >= HOLD_T) goaliePass(game, g);
    return;
  }

  // target point on the arc between the puck and the goal centre
  let px = pk.x, pz = pk.z;
  if (pk.o < 0 && side * pk.vx > 3) {
    // react to a puck coming at the net: shade toward where it will arrive
    const t = (GX - 1.0 - side * pk.x) / (side * pk.vx);
    if (t > 0 && t < 1) {
      const w = g.skill / 12;
      px += pk.vx * t * w; pz += pk.vz * t * w;
    }
  }
  const ux = (px - gcx) * out, uz = pz;
  let tux, tuz;
  if (ux < 0.25) { tux = 0.62; tuz = (uz >= 0 ? 1 : -1) * 0.75; }   // puck behind the net: hug the post
  else {
    const dist = Math.hypot(ux, uz);
    const th = clamp(Math.atan2(uz, ux), -1.25, 1.25);
    const rr = clamp(0.75 + (dist - 2) * 0.05, 0.8, 1.45);
    tux = Math.max(0.62, Math.cos(th) * rr);
    tuz = clamp(Math.sin(th) * rr, -0.85, 0.85);
  }
  const tx = gcx + out * tux, tz = tuz;
  const vmax = 2.6 + g.skill * 0.28;
  const dx = tx - g.x, dz = tz - g.z, d = Math.hypot(dx, dz);
  const want = Math.min(vmax, d * 8);
  const dvx = (d > 1e-4 ? (dx / d) * want : 0) - g.vx, dvz = (d > 1e-4 ? (dz / d) * want : 0) - g.vz;
  const dl = Math.hypot(dvx, dvz), st = 30 * dt;
  if (dl <= st) { g.vx += dvx; g.vz += dvz; } else { g.vx += (dvx / dl) * st; g.vz += (dvz / dl) * st; }
  g.f = turnToward(g.f, Math.atan2(pk.z - g.z, pk.x - g.x), 10 * dt);
  if (g.beatT > 0) holdBeat(game, g, dt);                // a goal on its way: don't step into its path

  // poke check a carrier who wanders into the blue paint
  if (pk.o >= 0 && game.ph === PHASE.PLAY) {
    const q = game.players[pk.o];
    if (q.tm !== g.tm && q.s !== DEKE && Math.hypot(pk.x - g.x, pk.z - g.z) < 1.25 &&
        rand(game) < 1.4 * dt * (g.skill / 8)) goaliePoke(game, g, q);
  }
}
