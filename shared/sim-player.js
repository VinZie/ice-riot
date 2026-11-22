// ICE RIOT sim - skater control + actions (skating, shots, passes, checks, pokes, dekes,
// hits, glass, ON FIRE heat). Humans and AI both drive skaters through controlSkater().

import { BTN, PSTATE, EVENT, boardDistance, nearestGlassPanel, glassPanels, clamp } from './constants.js';
import {
  rand, gauss, attackDir, wrapAngle, turnToward, emit, radiusOf, newFlight, r3,
  DIFF, GRAV, GX, HW, FL_LOOSE, FL_SHOT, FL_PASS,
} from './sim-util.js';
import { queueFight } from './sim-fight.js';

const { SKATE, CHARGE, SHOOT, CHECK, POKE, DEKE, DOWN, CELEBRATE } = PSTATE;
const PANELS = glassPanels();
const GLASS_DIST = 1.6;   // a big hit this close to the boards shatters the glass

// ---- tuning -----------------------------------------------------------------------
export const T = {
  accel: 13, turboAccel: 19, turboMul: 1.35,
  glideDecel: 6.5,            // no input: ~1.5 s from full speed to a stop
  turboDrain: 1 / 3, turboFill: 1 / 5,
  wristTap: 0.18, chargeTime: 0.8,
  otGrace: 0.15,              // SHOOT pressed this soon after receiving a pass = one-timer
  checkT: 0.35, checkMissT: 0.62, pokeT: 0.3, dekeT: 0.45, dekeCd: 1.0, shootT: 0.25,
  pickCdShot: 0.3,
};

export const maxSpeed = (p) => 7.5 + p.spd * 0.35;

export function setState(p, s) {
  p.s = s; p.sT = 0;
  if (s !== CHARGE) p.ch = 0;
}

// Effective AI difficulty for a player's team: AI teammates of humans (vs an all-AI
// opponent) never play below "pro" so they're useful; everyone else uses config.
export function aiLevel(game, team) {
  const d = game.cfg.difficulty;
  const h = game.humans;
  if (h[team] > 0 && h[1 - team] === 0) return d > 1 ? d : 1;
  return d;
}

// ---- puck ownership helpers -------------------------------------------------------

// Record a touch. Possession changes to the other team reset the assist chain.
export function touch(game, p, possession) {
  const t = game.touches;
  if (possession) {
    if (game.possTeam !== p.tm) t.length = 0;
    game.possTeam = p.tm;
  }
  if (t.length === 0 || t[t.length - 1] !== p.id) t.push(p.id);
  if (t.length > 8) t.shift();
  game.untouched = 0; game.untouchedAll = 0;
}

export function loosePuck(game, vx, vy, vz, by) {
  const pk = game.puck;
  pk.o = -1;
  pk.vx = vx; pk.vy = vy; pk.vz = vz;
  if (vy > 0 && pk.y < 0.02) pk.y = 0.02;
  game.flight = newFlight(game, FL_LOOSE, by);
}

export function givePuck(game, p) {
  const pk = game.puck, fl = game.flight;
  const recv = !!fl && fl.kind === FL_PASS && fl.to === p.id;
  const oneTimer = recv && !p.g && p.otTick === fl.tick;
  pk.o = p.id; pk.y = 0; pk.vy = 0;
  game.flight = null;
  touch(game, p, true);
  p.possT = 0; p.holdT = 0; p.otTick = -1;
  if (p.g) return;
  p.recvT = recv ? 0 : -1;
  if (oneTimer && p.s !== DOWN && p.s !== CELEBRATE) doShot(game, p, 'onetimer', 0);
}

// ---- ON FIRE ------------------------------------------------------------------------

export const HEAT_COOL = 25;   // seconds of play without gaining heat -> lose 1 heat (not while on fire)

export function addHeat(game, p, n) {
  if (p.g) return;
  p.heat += n;
  p.heatT = 0;
  if (p.fire) { p.fireT = 40; return; }
  if (p.heat >= 4) {
    p.fire = 1; p.fireT = 40; p.tb = 1;
    emit(game, EVENT.FIRE, { player: p.id, on: true });
  }
}

// Straight to ON FIRE (fight winner). Refreshes the timer if already burning.
export function igniteFire(game, p) {
  if (p.g) return;
  p.heat = Math.max(p.heat, 4); p.heatT = 0; p.fireT = 40; p.tb = 1;
  if (!p.fire) { p.fire = 1; emit(game, EVENT.FIRE, { player: p.id, on: true }); }
}

export function extinguish(game, p) {
  if (p.fire) emit(game, EVENT.FIRE, { player: p.id, on: false });
  p.fire = 0; p.heat = 0; p.fireT = 0; p.heatT = 0;
}

// ---- movement -------------------------------------------------------------------------

export function glide(p, decel, dt) {
  const sp = Math.hypot(p.vx, p.vz);
  if (sp < 1e-6) { p.vx = 0; p.vz = 0; return; }
  const ns = sp > decel * dt ? (sp - decel * dt) / sp : 0;
  p.vx *= ns; p.vz *= ns;
}

// Acceleration-based skating: facing turns toward the stick, velocity is pulled toward
// stick * vmax with limited acceleration (gives icy arcs); no input = glide to a stop.
function skateMove(p, mx, mz, turbo, vmaxMul, accelMul, turnMul, carrying, dt) {
  let vmax = maxSpeed(p) * vmaxMul;
  let accel = T.accel * accelMul;
  if (turbo) { vmax *= T.turboMul; accel = T.turboAccel * accelMul; }
  if (carrying) {
    vmax *= 0.9 + p.hnd * 0.008;
    turnMul *= 0.78 + p.hnd * 0.018;
  }
  const m = Math.hypot(mx, mz);
  if (m <= 0.12) { glide(p, T.glideDecel, dt); return; }
  const sp = Math.hypot(p.vx, p.vz);
  const ux = mx / m, uz = mz / m, mm = m > 1 ? 1 : m;
  const tr = (11 - 5.5 * Math.min(1, sp / vmax)) * turnMul;
  p.f = turnToward(p.f, Math.atan2(uz, ux), tr * dt);
  const dvx = ux * vmax * mm - p.vx, dvz = uz * vmax * mm - p.vz;
  const dl = Math.hypot(dvx, dvz);
  if (dl < 1e-6) return;
  const cosA = sp > 0.5 ? (p.vx * ux + p.vz * uz) / sp : 1;
  let a = accel * (1 + 0.8 * Math.max(0, -cosA));      // stronger "hockey stop" when reversing
  if (sp > vmax * mm && cosA > 0.8) a = Math.min(a, 6); // gentle bleed of overspeed (post turbo / lunge)
  const st = a * dt;
  if (dl <= st) { p.vx += dvx; p.vz += dvz; } else { p.vx += (dvx / dl) * st; p.vz += (dvz / dl) * st; }
}

// ---- the shared control code (humans + AI) ------------------------------------------

export function controlSkater(game, p, mx, mz, b, pressed, dt) {
  const pk = game.puck;
  p.sT += dt;
  if (p.pickCd > 0) p.pickCd -= dt;
  if (p.dekeCd > 0) p.dekeCd -= dt;
  if (p.checkCd > 0) p.checkCd -= dt;
  if (p.pokeCd > 0) p.pokeCd -= dt;
  if (p.recvT >= 0) { p.recvT += dt; if (p.recvT > 0.5) p.recvT = -1; }
  const has = pk.o === p.id;
  p.possT = has ? p.possT + dt : 0;

  if (!Number.isFinite(mx)) mx = 0;
  if (!Number.isFinite(mz)) mz = 0;
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  p.mx = mx; p.mz = mz;

  // turbo meter
  const turboHeld = (b & BTN.TURBO) !== 0;
  let turbo = false;
  if (p.fire) p.tb = 1;
  if (turboHeld) {
    if (p.fire || p.tb > 0.01) {
      turbo = true;
      if (!p.fire) p.tb = Math.max(0, p.tb - T.turboDrain * dt);
    }
  } else if (p.tb < 1) p.tb = Math.min(1, p.tb + T.turboFill * dt);

  switch (p.s) {
    case DOWN:
      glide(p, p.y > 0 ? 0.5 : 3.5, dt);
      if (p.sT >= p.downDur && p.y <= 0) setState(p, SKATE);
      return;
    case CELEBRATE:
      glide(p, 3, dt);
      return;
    case CHECK:
      if (p.sT <= T.checkT) {
        glide(p, 1.0, dt);                       // lunge: mostly momentum
        if (!p.hitDone) tryHit(game, p);
      } else {
        const missed = !p.hitDone || p.whiff;
        glide(p, missed ? 9 : 5, dt);            // missed check = brief recovery
        if (p.sT >= (missed ? T.checkMissT : T.checkT + 0.05)) { setState(p, SKATE); p.checkCd = 0.2; }
      }
      return;
    case POKE:
      skateMove(p, mx, mz, turbo, 0.85, 0.8, 0.8, has, dt);
      if (!p.pokeDone && p.sT >= 0.08) { p.pokeDone = true; tryPoke(game, p); }
      if (p.sT >= T.pokeT) { setState(p, SKATE); p.pokeCd = 0.15; }
      return;
    case SHOOT:
      skateMove(p, mx, mz, false, 0.85, 0.6, 0.5, false, dt);
      if (p.sT >= T.shootT) setState(p, SKATE);
      return;
    case CHARGE:
      if (!has) { setState(p, SKATE); break; }
      p.holdT += dt;
      p.ch = clamp((p.holdT - T.wristTap) / T.chargeTime, 0, 1);
      if (pressed & BTN.PASS) { setState(p, SKATE); passFrom(game, p, mx, mz); }   // fake slapper -> pass
      else if (!(b & BTN.SHOOT)) {
        if (p.holdT < T.wristTap) doShot(game, p, 'wrist', 0);
        else doShot(game, p, 'slap', p.ch);
      }
      if (p.s === CHARGE) skateMove(p, mx, mz, false, 0.55, 0.7, 0.45, true, dt);
      else skateMove(p, mx, mz, false, 0.85, 0.6, 0.5, false, dt);
      return;
    case DEKE:
      skateMove(p, mx, mz, turbo, 1.08, 0.9, 1.2, has, dt);
      if (has && p.sT > 0.15) {
        if (pressed & BTN.SHOOT) { setState(p, CHARGE); p.holdT = 0; }
        else if (pressed & BTN.PASS) { setState(p, SKATE); passFrom(game, p, mx, mz); }
      }
      if (p.s === DEKE && p.sT >= T.dekeT) setState(p, SKATE);
      return;
    default:
      break;
  }

  // ---- SKATE ----
  if (pressed & BTN.SHOOT) {
    if (pk.o === p.id) {
      if (p.recvT >= 0 && p.recvT <= T.otGrace) doShot(game, p, 'onetimer', 0);
      else { setState(p, CHARGE); p.holdT = 0; }
    } else if (pk.o < 0 && game.flight && game.flight.kind === FL_PASS && game.flight.to === p.id) {
      p.otTick = game.flight.tick;               // one-timer queued: shoot on reception
    } else if (p.checkCd <= 0) {
      startCheck(game, p, turboHeld);
      return;
    }
  }
  if (p.s === SKATE && (pressed & BTN.PASS) && pk.o === p.id) passFrom(game, p, mx, mz);
  if (p.s === SKATE && (pressed & BTN.ACTION)) {
    if (pk.o === p.id) { if (p.dekeCd <= 0) startDeke(game, p, mx, mz); }
    else if (p.pokeCd <= 0) { setState(p, POKE); p.pokeDone = false; }
  }
  if (p.s === CHARGE) skateMove(p, mx, mz, false, 0.55, 0.7, 0.45, true, dt);
  else if (p.s === SHOOT) skateMove(p, mx, mz, false, 0.85, 0.6, 0.5, false, dt);
  else skateMove(p, mx, mz, turbo, 1, 1, 1, pk.o === p.id, dt);
}

// ---- shooting ---------------------------------------------------------------------------

export function doShot(game, p, kind, charge) {
  const pk = game.puck;
  if (pk.o !== p.id) return;
  const att = attackDir(p.tm), gx = att * GX;
  let speed = kind === 'wrist' ? 24 + p.sht * 1.0
    : kind === 'slap' ? 30 + p.sht * 1.2 + charge * 10
    : 40 + p.sht;
  if (p.fire) speed *= 1.25;
  if (speed > 55) speed = 55;

  // aim: stick-input z picks the corner, otherwise somewhere in the middle of the mouth
  const aim = clamp(p.mz, -1, 1);
  let tz = Math.abs(aim) > 0.2 ? aim * 0.78 * HW : (rand(game) * 2 - 1) * 0.45 * HW;
  let ty = kind === 'slap' ? 0.12 + charge * 0.45 + rand(game) * 0.35 : 0.12 + rand(game) * 0.65;
  const dist = Math.hypot(gx - pk.x, tz - pk.z);
  let err = Math.max(0.1, 0.6 - p.sht * 0.035) * (0.5 + dist / 10);
  if (kind === 'slap') err *= 1.1 + charge * 0.15;
  else if (kind === 'onetimer') err *= 1.25;
  if (p.c === 0) err *= DIFF[aiLevel(game, p.tm)].aim;
  tz += gauss(game) * err;
  ty += gauss(game) * err * 0.55;
  if (ty < 0.03) ty = 0.03;

  const dx = gx - pk.x, dz = tz - pk.z;
  const dh = Math.max(0.5, Math.hypot(dx, dz));
  const t = dh / speed;
  let vy = (ty - pk.y) / t + 0.5 * GRAV * t;
  if (dh > 24) vy = Math.min(vy, 1.2 + rand(game) * 1.5);  // long dumps stay low
  vy = clamp(vy, 0, 9);

  pk.o = -1;
  pk.vx = (dx / dh) * speed; pk.vz = (dz / dh) * speed; pk.vy = vy;
  if (vy > 0 && pk.y < 0.01) pk.y = 0.01;
  const fl = (game.flight = newFlight(game, FL_SHOT, p.id));
  fl.shotKind = kind; fl.fire = p.fire;

  p.f = Math.atan2(dz, dx);
  setState(p, SHOOT);
  p.holdT = 0; p.pickCd = T.pickCdShot; p.otTick = -1; p.recvT = -1;
  emit(game, EVENT.SHOT, { by: p.id, power: r3(speed / 55), kind });
}

// ---- passing ------------------------------------------------------------------------------

function passFrom(game, p, mx, mz) {
  if (Math.hypot(mx, mz) > 0.3) doPass(game, p, mx, mz, null);
  else doPass(game, p, Math.cos(p.f), Math.sin(p.f), null);
}

// Pass toward the teammate skater best aligned with (dx,dz). Never to your own goalie: with
// nobody in that direction it goes to the closest-aligned skater instead. `forced`
// (optional) picks the receiver directly (goalie outlet passes).
export function doPass(game, p, dx, dz, forced) {
  const pk = game.puck;
  if (pk.o !== p.id) return false;
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl; dz /= dl;
  let best = null, bs = 1e9, any = null, as = 1e9;
  if (!forced) {
    for (const q of game.players) {
      if (q.tm !== p.tm || q === p || q.g) continue;
      const vx = q.x - pk.x, vz = q.z - pk.z;
      const d = Math.hypot(vx, vz) || 1e-3;
      const ang = Math.acos(clamp((vx * dx + vz * dz) / d, -1, 1));
      const s = ang + d * 0.012 + (q.s === DOWN ? 1.5 : 0);
      if (ang < 1.35 && s < bs) { bs = s; best = q; }
      if (s < as) { as = s; any = q; }
    }
  }
  const r = forced || best || any;
  if (!r) return false;

  const d0 = Math.hypot(r.x - pk.x, r.z - pk.z);
  let spd = Math.min(17 + p.pas * 0.7, 9 + d0 * 1.0);
  if (spd < 8) spd = 8;
  // lead the receiver by their velocity
  let tx = r.x, tz = r.z;
  for (let i = 0; i < 2; i++) {
    const t = Math.hypot(tx - pk.x, tz - pk.z) / spd;
    tx = r.x + r.vx * t * 0.9; tz = r.z + r.vz * t * 0.9;
  }
  const bd = boardDistance(tx, tz);
  if (bd.d < 1.0) { tx += bd.nx * (1.0 - bd.d); tz += bd.nz * (1.0 - bd.d); }
  const ang = Math.atan2(tz - pk.z, tx - pk.x) + gauss(game) * Math.max(0.008, 0.05 - p.pas * 0.004);
  pk.o = -1;
  pk.vx = Math.cos(ang) * spd; pk.vz = Math.sin(ang) * spd; pk.vy = 0; pk.y = 0;
  const fl = (game.flight = newFlight(game, FL_PASS, p.id));
  fl.to = r.id;
  p.f = wrapAngle(ang);
  p.pickCd = T.pickCdShot; p.holdT = 0; p.recvT = -1;
  emit(game, EVENT.PASS, { by: p.id, to: r.id });
  return true;
}

// ---- body checks ----------------------------------------------------------------------------

function startCheck(game, p, turboHeld) {
  setState(p, CHECK);
  p.hitDone = false; p.whiff = false;
  p.checkBig = turboHeld && (p.fire > 0 || p.tb >= 0.15);
  if (p.checkBig && !p.fire) p.tb = Math.max(0, p.tb - 0.3);
  const burst = p.checkBig ? 4.5 : 3.0;
  p.vx += Math.cos(p.f) * burst; p.vz += Math.sin(p.f) * burst;
  const cap = maxSpeed(p) * T.turboMul + 3.5;
  const sp = Math.hypot(p.vx, p.vz);
  if (sp > cap) { p.vx *= cap / sp; p.vz *= cap / sp; }
}

function tryHit(game, p) {
  const fx = Math.cos(p.f), fz = Math.sin(p.f);
  let best = null, bd = 1e9;
  for (const q of game.players) {
    if (q.tm === p.tm || q.s === DOWN || q.y > 0.3) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6 || d > radiusOf(p) + radiusOf(q) + 0.35) continue;
    if ((fx * dx + fz * dz) / d < 0.2) continue;
    if (d < bd) { bd = d; best = q; }
  }
  if (best) resolveHit(game, p, best, (best.x - p.x) / bd, (best.z - p.z) / bd);
}

function resolveHit(game, p, q, nx, nz) {
  p.hitDone = true;
  if (q.s === DEKE && rand(game) < 0.6) { p.whiff = true; return; }  // deke dodges the hit
  const closing = Math.max(0, (p.vx - q.vx) * nx + (p.vz - q.vz) * nz);
  let power = (closing / 15) * (0.6 + p.chk * 0.05);
  if (p.checkBig) power *= 1.6;
  if (p.fire) power *= 1.4;
  power = clamp(power, 0.12, 1);
  if (q.g) power *= 0.35;                  // goalies can be hit, but it's weak
  const big = power > 0.6;
  emit(game, EVENT.HIT, { by: p.id, target: q.id, power: r3(power), big, x: r3((p.x + q.x) / 2), z: r3((p.z + q.z) / 2) });
  p.vx *= 0.45; p.vz *= 0.45;
  if (q.g) {
    q.vx += nx * 1.5; q.vz += nz * 1.5;
    if (power >= 0.3) knockDown(game, q, 0.6, nx, nz, power);
    return;
  }
  knockDown(game, q, 0.8 + 1.2 * power, nx, nz, power);
  if (big) {
    addHeat(game, p, 1);
    queueFight(game, p, q);                  // sometimes the gloves come off
    if (boardDistance(q.x, q.z).d < GLASS_DIST) shatterGlass(game, p.id, q, power);
    else { q.glassT = 0.5 + power * 0.5; q.glassBy = p.id; q.glassPow = power; }  // sent flying: may still hit the glass
  }
}

// Big hit into the boards: shatter the nearest glass panel and launch the target.
// Called directly for pinned targets, or by sim.js when a flying target hits the boards.
export function shatterGlass(game, byId, q, power) {
  q.glassT = 0;
  const b = boardDistance(q.x, q.z);
  const panel = nearestGlassPanel(q.x - b.nx * b.d, q.z - b.nz * b.d);
  if (!game.gl.includes(panel)) {
    game.gl.push(panel);
    const P = PANELS[panel];
    emit(game, EVENT.GLASS, { panel, by: byId, target: q.id, x: r3(P.x), z: r3(P.z) });
  }
  q.y = Math.max(q.y, 0.02); q.vy = 3 + power * 2.2;
}

function knockDown(game, q, dur, nx, nz, power) {
  const pk = game.puck;
  if (pk.o === q.id) {
    // puck pops loose with some of the hit momentum
    const side = rand(game) < 0.5 ? -1 : 1, lat = 1 + rand(game) * 2;
    loosePuck(game,
      q.vx * 0.5 + nx * (2 + power * 5) - nz * side * lat,
      power * 2,
      q.vz * 0.5 + nz * (2 + power * 5) + nx * side * lat,
      q.id);
  }
  setState(q, DOWN);
  q.downDur = dur; q.otTick = -1; q.holdT = 0;
  q.vx += nx * (1.5 + power * 6); q.vz += nz * (1.5 + power * 6);
  q.pickCd = Math.max(q.pickCd, dur + 0.1);
}

// ---- stick check / deke ---------------------------------------------------------------------

function tryPoke(game, p) {
  const pk = game.puck;
  if (pk.o < 0) return;
  const q = game.players[pk.o];
  if (q.tm === p.tm || q.g) return;
  const dx = pk.x - p.x, dz = pk.z - p.z, d = Math.hypot(dx, dz);
  if (d > 1.7) return;
  if (d > 0.3 && (Math.cos(p.f) * dx + Math.sin(p.f) * dz) / d < 0.3) return;
  if (q.s === DEKE) return;                 // deking = immune to pokes
  let chance = 0.42 + (p.chk - 5) * 0.035 - (q.hnd - 5) * 0.045;
  if (p.c === 0) chance += DIFF[aiLevel(game, p.tm)].strip;
  chance = clamp(chance, 0.08, 0.85);
  if (rand(game) >= chance) return;
  q.pickCd = Math.max(q.pickCd, 0.5);
  if (q.s === CHARGE) setState(q, SKATE);
  if (rand(game) < 0.5 && p.pickCd <= 0) givePuck(game, p);
  else {
    const a = Math.atan2(p.z - pk.z, p.x - pk.x) + (rand(game) - 0.5) * 1.2;
    const s = 3 + rand(game) * 3;
    loosePuck(game, Math.cos(a) * s + q.vx * 0.4, 0, Math.sin(a) * s + q.vz * 0.4, p.id);
    touch(game, p, false);
  }
  emit(game, EVENT.STEAL, { by: p.id, from: q.id });
}

function startDeke(game, p, mx, mz) {
  setState(p, DEKE);
  p.dekeCd = T.dekeT + T.dekeCd;
  const fx = Math.cos(p.f), fz = Math.sin(p.f);
  const cross = fx * mz - fz * mx;
  let side;
  if (Math.abs(cross) > 0.2) side = cross > 0 ? 1 : -1;
  else { p.dekeSide = -p.dekeSide; side = p.dekeSide; }
  p.vx += -fz * side * 3.6 + fx * 0.8;
  p.vz += fx * side * 3.6 + fz * 0.8;
  emit(game, EVENT.DEKE, { by: p.id });
}
