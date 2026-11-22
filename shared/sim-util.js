// ICE RIOT sim - small shared helpers (pure: no IO, no timers, no globals).
// Imported by sim.js and the other shared/sim-*.js modules.

import { RINK, PUCK, PLAYER } from './constants.js';

export const GRAV = 9.81;
export const GX = RINK.goalLineX;        // goal line |x|
export const HW = RINK.goalHalfWidth;    // goal mouth half width (z)
export const GH = RINK.goalHeight;
export const GD = RINK.goalDepth;
export const PR = PUCK.radius;
export const POST_R = RINK.postRadius;
export const REACH = PLAYER.stickReach;

// Flight kinds (what the loose puck is currently doing).
export const FL_LOOSE = 0, FL_SHOT = 1, FL_PASS = 2;

// AI difficulty table (index = config.difficulty 0..2).
//   think: seconds between AI decisions (reaction delay)
//   aim:   multiplier on shot aim error
//   check/turboCheck/poke/deke/ot/turbo: per-decision probabilities
//   noise: gaussian noise added to AI value estimates (decision quality)
//   strip: bonus to stick-check strip chance
export const DIFF = [
  { think: 0.30, aim: 1.45, check: 0.28, turboCheck: 0.22, poke: 0.22, deke: 0.22, ot: 0.16, turbo: 0.55, noise: 0.08, strip: -0.08 },
  { think: 0.19, aim: 1.00, check: 0.45, turboCheck: 0.35, poke: 0.35, deke: 0.40, ot: 0.28, turbo: 0.80, noise: 0.04, strip: 0.00 },
  { think: 0.11, aim: 0.75, check: 0.62, turboCheck: 0.48, poke: 0.50, deke: 0.55, ot: 0.42, turbo: 1.00, noise: 0.015, strip: 0.08 },
];

// mulberry32 seeded PRNG; the state lives on the game object so games are independent.
export function rand(game) {
  let t = (game.rng = (game.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Approximate standard normal (Irwin-Hall with 4 samples, rescaled to unit variance).
export function gauss(game) {
  return (rand(game) + rand(game) + rand(game) + rand(game) - 2) * 1.7320508;
}

export const attackDir = (team) => (team === 0 ? 1 : -1);   // +X for home
export const defendSide = (team) => (team === 0 ? -1 : 1);  // x-sign of the goal a team defends

export function wrapAngle(a) {
  if (a > Math.PI || a <= -Math.PI) {
    a = (a + Math.PI) % (2 * Math.PI);
    if (a <= 0) a += 2 * Math.PI;
    a -= Math.PI;
  }
  return a;
}

export function turnToward(a, target, maxStep) {
  const d = wrapAngle(target - a);
  if (d <= maxStep && d >= -maxStep) return wrapAngle(a + d);
  return wrapAngle(a + (d > 0 ? maxStep : -maxStep));
}

export const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);

// Events carry their type both as `type` and `t` so consumers can use either key.
export function emit(game, type, data) {
  const e = { type, t: type };
  if (data) Object.assign(e, data);
  game.events.push(e);
}

export const radiusOf = (p) => (p.g ? PLAYER.goalieRadius : PLAYER.radius);

export function distPointSeg(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 1e-12 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + abx * t - px, dz = az + abz * t - pz;
  return Math.sqrt(dx * dx + dz * dz);
}

// Allocation-free twin of constants.boardDistance() for hot paths (same math). Returns a
// shared scratch object: read its fields before calling it again.
const BD = { d: 0, nx: 0, nz: 0 };
const BL = RINK.halfLength, BW = RINK.halfWidth, BR = RINK.cornerRadius;
export function boardDist(x, z) {
  const ax = Math.abs(x), az = Math.abs(z);
  const sx = x < 0 ? -1 : 1, sz = z < 0 ? -1 : 1;
  const cx = BL - BR, cz = BW - BR;
  if (ax > cx && az > cz) {
    const dx = ax - cx, dz = az - cz;
    const d = Math.hypot(dx, dz) || 1e-6;
    BD.d = BR - d; BD.nx = (-sx * dx) / d; BD.nz = (-sz * dz) / d;
    return BD;
  }
  const dX = BL - ax, dZ = BW - az;
  if (dX < dZ) { BD.d = dX; BD.nx = -sx; BD.nz = 0; } else { BD.d = dZ; BD.nx = 0; BD.nz = -sz; }
  return BD;
}

// Push a circle (o.x, o.z, radius r) back inside the boards. e = restitution of the
// normal velocity component. Returns the impact speed (0 if no contact).
export function collideBoards(o, r, e) {
  const b = boardDist(o.x, o.z);
  if (b.d >= r) return 0;
  const pen = r - b.d;
  o.x += b.nx * pen; o.z += b.nz * pen;
  const vn = o.vx * b.nx + o.vz * b.nz;
  if (vn < 0) {
    o.vx -= (1 + e) * vn * b.nx;
    o.vz -= (1 + e) * vn * b.nz;
    return -vn;
  }
  return 0;
}

// Nets are solid boxes behind each goal line (x in [GX, GX+GD] * side, z in [-HW, HW]).
// Push a circle out of both boxes and kill the velocity component into the box.
export function collideNets(o, r) {
  for (let s = -1; s <= 1; s += 2) {
    const x0 = s > 0 ? GX : -GX - GD, x1 = s > 0 ? GX + GD : -GX;
    if (o.x < x0 - r || o.x > x1 + r || o.z < -HW - r || o.z > HW + r) continue;
    const cx = o.x < x0 ? x0 : o.x > x1 ? x1 : o.x;
    const cz = o.z < -HW ? -HW : o.z > HW ? HW : o.z;
    let nx = o.x - cx, nz = o.z - cz;
    const d = Math.sqrt(nx * nx + nz * nz);
    let pen;
    if (d > 1e-6) {
      pen = r - d;
      if (pen <= 0) continue;
      nx /= d; nz /= d;
    } else {
      // centre inside the box: leave through the nearest face
      const front = s > 0 ? o.x - x0 : x1 - o.x;
      const back = s > 0 ? x1 - o.x : o.x - x0;
      const sp = HW - o.z, sn = o.z + HW;
      let m = front; nx = -s; nz = 0;
      if (back < m) { m = back; nx = s; nz = 0; }
      if (sp < m) { m = sp; nx = 0; nz = 1; }
      if (sn < m) { m = sn; nx = 0; nz = -1; }
      pen = m + r;
    }
    o.x += nx * pen; o.z += nz * pen;
    const vn = o.vx * nx + o.vz * nz;
    if (vn < 0) { o.vx -= vn * nx; o.vz -= vn * nz; }
  }
}

// Clamp a target point to be at least `margin` inside the boards. Writes into out {x,z}.
export function clampInside(out, x, z, margin) {
  const b = boardDist(x, z);
  if (b.d < margin) { x += b.nx * (margin - b.d); z += b.nz * (margin - b.d); }
  out.x = x; out.z = z;
  return out;
}

export function newFlight(game, kind, by) {
  const pk = game.puck;
  return {
    kind, by,
    team: by >= 0 ? game.players[by].tm : -1,
    to: -1,
    tick: game.tick,
    rolled: 0,          // bitmask of players that already rolled a block/intercept for this flight
    saveDone: false,    // goalie already rolled a save on this flight
    saveG: -1,          // goalie who will save it when it reaches him (a save decided early)
    beaten: false,      // goalie was beaten on this flight (can't cover it)
    shotKind: '',
    fire: 0,
    x0: pk.x, z0: pk.z, // release point
  };
}
