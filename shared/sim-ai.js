// ICE RIOT sim - skater AI. Produces synthetic {mx, mz, b} inputs for AI-controlled
// skaters; sim.js feeds them through exactly the same controlSkater() code humans use.
//
// Structure: every `think` interval (difficulty-scaled reaction delay) a skater picks a
// target point + intended button presses based on the situation (carrier / support /
// receiver / defense / loose puck). Every tick it steers toward the target with
// teammate spacing and net avoidance, and emits the queued presses as clean edges.

import { BTN, PSTATE, boardDistance, clamp } from './constants.js';
import {
  rand, gauss, attackDir, distPointSeg, clampInside, DIFF,
  GX, HW, GD, FL_PASS,
} from './sim-util.js';
import { aiLevel, maxSpeed } from './sim-player.js';
import { saveProb } from './sim-goalie.js';

const { DOWN, CHARGE, SHOOT, CHECK, CELEBRATE } = PSTATE;
const tmp = { x: 0, z: 0 };

export function makeAi() {
  return {
    thinkT: 0, tx: 0, tz: 0, arrive: true, spacing: 0.6, lane: 0,
    turbo: false, press: 0, pressHas: false, hold: 0, holding: false, prevB: 0,
    ovX: 0, ovZ: 0, ovT: 0, passCd: 0, otFlight: -1,
    out: { mx: 0, mz: 0, b: 0 },
  };
}

export function resetAi(p, game) {
  const ai = p.ai;
  ai.press = 0; ai.hold = 0; ai.holding = false; ai.turbo = false; ai.ovT = 0; ai.prevB = 0;
  ai.tx = p.x; ai.tz = p.z; ai.otFlight = -1; ai.passCd = 0;
  ai.thinkT = game ? DIFF[aiLevel(game, p.tm)].think * rand(game) : 0;
}

// ---- small helpers ------------------------------------------------------------------

// Estimated goal chance of a shot from (x,z) by `team` (no randomness, no aim error).
export function shotChance(game, team, x, z, speed, kind) {
  const att = attackDir(team);
  const ahead = GX - att * x;
  if (ahead < 1.0 || ahead > 30) return 0;
  const g = game.players[(1 - team) * 4 + 3];
  return 1 - saveProb(game, g, x, z, speed, kind, 0, 0.6, 0.4, kind === 'onetimer' ? 1.5 : 0);
}

// Minimum distance from any opponent of `team` to the segment a->b.
function laneClear(game, team, ax, az, bx, bz) {
  let m = 99;
  for (const q of game.players) {
    if (q.tm === team || q.s === DOWN) continue;
    const d = distPointSeg(q.x, q.z, ax, az, bx, bz);
    if (d < m) m = d;
  }
  return m;
}

function openness(game, p) {
  let m = 99;
  for (const q of game.players) {
    if (q.tm === p.tm || q.g || q.s === DOWN) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < m) m = d;
  }
  return m;
}

function timeTo(p, x, z) {
  const d = Math.hypot(x - p.x, z - p.z);
  const facing = d > 0.01 ? (Math.cos(p.f) * (x - p.x) + Math.sin(p.f) * (z - p.z)) / d : 1;
  return d / maxSpeed(p) + (1 - facing) * 0.25 + (p.s === DOWN ? 1.5 : 0);
}

function intercept(game, p) {
  const pk = game.puck, vmax = maxSpeed(p);
  let tx = pk.x, tz = pk.z;
  for (let i = 0; i < 3; i++) {
    const t = Math.min(1.5, Math.hypot(tx - p.x, tz - p.z) / vmax);
    tx = pk.x + pk.vx * t * 0.92; tz = pk.z + pk.vz * t * 0.92;
  }
  return clampInside(tmp, tx, tz, 0.6);
}

function setTarget(ai, x, z, margin) {
  clampInside(tmp, x, z, margin);
  ai.tx = tmp.x; ai.tz = tmp.z;
}

// ---- per-tick entry point -------------------------------------------------------------

export function aiInput(game, p, dt) {
  const ai = p.ai;
  const D = DIFF[aiLevel(game, p.tm)];
  ai.thinkT -= dt;
  if (ai.passCd > 0) ai.passCd -= dt;
  if (ai.ovT > 0) ai.ovT -= dt;
  if (ai.thinkT <= 0) {
    think(game, p, D);
    ai.pressHas = game.puck.o === p.id;
    ai.thinkT = D.think * (0.7 + 0.6 * rand(game));
  }
  const out = ai.out;
  if (ai.ovT > 0) { out.mx = ai.ovX; out.mz = ai.ovZ; } else steer(game, p, out);

  // buttons: turbo is held, presses are emitted as clean edges, slapshots are holds
  let b = ai.turbo ? BTN.TURBO : 0;
  if (ai.hold > 0) {
    if (ai.holding) { b |= BTN.SHOOT; ai.hold -= dt; if (ai.hold <= 0) ai.holding = false; }
    else if (!(ai.prevB & BTN.SHOOT)) { b |= BTN.SHOOT; ai.holding = true; }
  }
  // a press decided with/without the puck is dropped if possession changed since
  // (e.g. a body-check SHOOT must never turn into a shot from our own zone)
  if (ai.press && (game.puck.o === p.id) !== ai.pressHas) ai.press = 0;
  if (ai.press) {
    for (let bit = 1; bit <= 4; bit <<= 1) {
      if ((ai.press & bit) && !(ai.prevB & bit)) { b |= bit; ai.press &= ~bit; }
    }
  }
  out.b = b;
  return out;
}

function steer(game, p, out) {
  const ai = p.ai;
  detour(p, ai.tx, ai.tz, tmp);
  const tx = tmp.x, tz = tmp.z;
  const dx = tx - p.x, dz = tz - p.z;
  const d = Math.hypot(dx, dz);
  let mx = 0, mz = 0;
  if (d > 0.2) {
    const m = ai.arrive ? Math.min(1, d / 2.2) : 1;
    mx = (dx / d) * m; mz = (dz / d) * m;
  }
  // spacing: don't clump with teammates
  if (ai.spacing > 0) {
    for (const q of game.players) {
      if (q.tm !== p.tm || q === p || q.g) continue;
      const ex = p.x - q.x, ez = p.z - q.z, e = Math.hypot(ex, ez);
      if (e < 3.4 && e > 0.01) {
        const w = ((3.4 - e) / 3.4) * ai.spacing;
        mx += (ex / e) * w; mz += (ez / e) * w;
      }
    }
  }
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  out.mx = mx; out.mz = mz;
}

// Path around the nets: if the straight line to the target crosses a net (expanded by a
// margin), steer to the front or back corner on our side, preferring one that can see
// the target. Targets hugging the net itself are approached directly.
const NET_M = 0.6, NET_Z0 = -HW - NET_M, NET_Z1 = HW + NET_M, CORNER_Z = HW + 1.1;
function detour(p, tx, tz, out) {
  out.x = tx; out.z = tz;
  for (let s = -1; s <= 1; s += 2) {
    const x0 = s > 0 ? GX : -GX - GD - NET_M, x1 = s > 0 ? GX + GD + NET_M : -GX;
    if (tx > x0 && tx < x1 && tz > NET_Z0 && tz < NET_Z1) continue;
    if (!segHitsBox(p.x, p.z, tx, tz, x0, NET_Z0, x1, NET_Z1)) continue;
    const wz = ((p.z !== 0 ? p.z : tz) >= 0 ? 1 : -1) * CORNER_Z;
    let best = p.x, bd = Infinity;                      // fallback: slide sideways out
    for (let c = 0; c < 2; c++) {
      const cx = c === 0 ? s * (GX - 0.8) : s * (GX + GD + 1.0);
      if (segHitsBox(p.x, p.z, cx, wz, x0, NET_Z0, x1, NET_Z1)) continue;
      const sees = !segHitsBox(cx, wz, tx, tz, x0, NET_Z0, x1, NET_Z1);
      const d = Math.hypot(cx - p.x, wz - p.z) + (sees ? 0 : 100);
      if (d < bd) { bd = d; best = cx; }
    }
    out.x = best; out.z = wz;
    return out;
  }
  return out;
}

function segHitsBox(ax, az, bx, bz, x0, z0, x1, z1) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  if (Math.abs(dx) < 1e-9) { if (ax < x0 || ax > x1) return false; }
  else {
    let ta = (x0 - ax) / dx, tb = (x1 - ax) / dx;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  if (Math.abs(dz) < 1e-9) { if (az < z0 || az > z1) return false; }
  else {
    let ta = (z0 - az) / dz, tb = (z1 - az) / dz;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

// ---- decisions ------------------------------------------------------------------------

function think(game, p, D) {
  const ai = p.ai;
  ai.press = 0; ai.turbo = false; ai.arrive = true;
  if (p.s === DOWN || p.s === CELEBRATE) return;
  const pk = game.puck, fl = game.flight;
  const owner = pk.o >= 0 ? game.players[pk.o] : null;
  if (owner === p) return thinkCarrier(game, p, D);
  ai.hold = 0; ai.holding = false;            // lost the puck: drop any slapshot hold
  if (owner) {
    if (owner.tm === p.tm) return thinkSupport(game, p, D, owner);
    return thinkDefense(game, p, D, owner);
  }
  if (fl && fl.kind === FL_PASS) {
    const to = game.players[fl.to];
    if (fl.team === p.tm) {
      if (fl.to === p.id) return thinkReceive(game, p, D);
      return thinkSupport(game, p, D, to);
    }
    return thinkInterceptPass(game, p, D, to);
  }
  return thinkLoose(game, p, D);
}

function thinkCarrier(game, p, D) {
  const ai = p.ai, pk = game.puck;
  const att = attackDir(p.tm), gx = att * GX;
  const ahead = GX - att * p.x;
  const fx = Math.cos(p.f), fz = Math.sin(p.f);
  ai.arrive = false; ai.spacing = 0.15;
  if (p.s === CHARGE) {
    // winding up a slapper: let it rip early if someone is closing in
    if (openness(game, p) < 1.6 && ai.hold > 0.05) ai.hold = 0.02;
    return;
  }
  if (p.s === SHOOT || p.s === CHECK) return;

  let nd = 99, nq = null, frontD = 99, threat = null;
  for (const q of game.players) {
    if (q.tm === p.tm || q.g || q.s === DOWN) continue;
    const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz) || 0.01;
    if (d < nd) { nd = d; nq = q; }
    if ((fx * dx + fz * dz) / d > 0.35 && d < frontD) frontD = d;
    // someone lunging at me?
    if (q.s === CHECK && q.sT < 0.3 && d < 3.5 && -(Math.cos(q.f) * dx + Math.sin(q.f) * dz) / d > 0.7) threat = q;
  }
  const pressure = clamp((4.5 - nd) / 3.5, 0, 1);
  if (threat) {
    // evade an incoming body check: deke through it, or sidestep
    const sx = -Math.sin(threat.f), sz = Math.cos(threat.f);
    const s = (p.x - threat.x) * sx + (p.z - threat.z) * sz >= 0 ? 1 : -1;
    ai.ovX = sx * s + att * 0.3; ai.ovZ = sz * s; ai.ovT = 0.25;
    if (p.dekeCd <= 0 && rand(game) < D.deke + 0.3) ai.press |= BTN.ACTION;
    ai.turbo = p.tb > 0.2;
    return;
  }

  // --- options: wrist shot, slapshot, pass, or keep skating (threshold decays with time)
  const dist = Math.hypot(gx - pk.x, pk.z);
  const noise = gauss(game) * D.noise;
  const open = pressure < 0.35;
  const inRange = ahead > 1.2 && ahead < 24 && p.possT > 0.15;
  const blocked = inRange && laneClear(game, p.tm, pk.x, pk.z, gx, 0) < 0.7 ? 0.55 : 1;
  const svW = inRange ? (shotChance(game, p.tm, pk.x, pk.z, 24 + p.sht, 'wrist') + noise) * blocked : 0;
  const svS = inRange && open && dist > 8.5 && dist < 21
    ? (shotChance(game, p.tm, pk.x, pk.z, 36 + p.sht * 1.2, 'slap') * 0.9 + 0.035 + noise) * blocked : 0;
  const shootV = Math.max(svW, svS);
  const thr = Math.max(0.05, 0.17 - p.possT * 0.02 - pressure * 0.05);

  let best = null, bv = -1;
  if (ai.passCd <= 0 && p.possT > 0.3) {
    for (const m of game.players) {
      if (m.tm !== p.tm || m === p || m.g || m.s === DOWN) continue;
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d < 3 || d > 32) continue;
      const lc = laneClear(game, p.tm, pk.x, pk.z, m.x, m.z);
      if (lc < 1.3) continue;
      // expected value: the receiver one-times it (sometimes) or takes a wrist shot later
      const ot = shotChance(game, p.tm, m.x, m.z, 40 + m.sht, 'onetimer');
      const wr = shotChance(game, p.tm, m.x, m.z, 24 + m.sht, 'wrist');
      const v = (D.ot * ot + (1 - D.ot) * wr) * (lc > 2.5 ? 0.95 : 0.8)
        + Math.min(openness(game, m), 6) * 0.01
        + (m.c ? 0.06 : 0)                      // AI likes feeding its human teammates
        + att * (m.x - p.x) * 0.002
        + gauss(game) * D.noise;
      if (v > bv) { bv = v; best = m; }
    }
  }
  const passIt = best && ((bv > thr + 0.05 && bv > shootV + 0.04 && rand(game) < 0.6) ||
                          (pressure > 0.6 && frontD < 2.4 && bv > 0.02 && shootV < thr));
  if (!passIt && shootV > thr) {
    const g = game.players[(1 - p.tm) * 4 + 3];
    const side = g.z > 0.08 ? -1 : g.z < -0.08 ? 1 : rand(game) < 0.5 ? -1 : 1;  // aim away from the goalie
    ai.ovX = att * 0.6; ai.ovZ = side * (0.45 + rand(game) * 0.5);
    if (svS > svW) {
      ai.hold = 0.3 + rand(game) * 0.6; ai.holding = false; ai.ovT = ai.hold + 0.12;
    } else {
      ai.press |= BTN.SHOOT; ai.ovT = 0.1;
    }
    return;
  }
  if (passIt) {
    const lx = best.x + best.vx * 0.35 - p.x, lz = best.z + best.vz * 0.35 - p.z, l = Math.hypot(lx, lz) || 1;
    ai.ovX = lx / l; ai.ovZ = lz / l; ai.ovT = 0.06;
    ai.press |= BTN.PASS; ai.passCd = 1.0;
    return;
  }

  // --- deke a defender closing in front
  if (frontD < 2.4 && p.dekeCd <= 0 && rand(game) < D.deke) {
    const s = rand(game) < 0.5 ? -1 : 1;
    ai.ovX = fx * 0.5 - fz * s; ai.ovZ = fz * 0.5 + fx * s; ai.ovT = 0.08;
    ai.press |= BTN.ACTION;
    return;
  }

  // --- skate: drive to the slot, swerve around defenders, turbo on open ice
  let tx, tz;
  if (p.possT < 0.4) {
    // fresh possession: pick a rush lane (wide lanes use the whole sheet)
    const s = Math.abs(p.z) > 2 ? (p.z > 0 ? 1 : -1) : rand(game) < 0.5 ? -1 : 1;
    ai.lane = s * (2 + rand(game) * 7.5);
  }
  if (ahead < 0.8) { tx = gx - att * 3.5; tz = (p.z >= 0 ? 1 : -1) * 3.5; }      // behind the net: come out
  else if (ahead > 15) { tx = gx - att * 12; tz = ai.lane; }                       // rush up the lane
  else { tx = gx - att * 6; tz = clamp(p.z * 0.5, -3, 3); }                        // cut to the slot
  if (nq && frontD < 5) tz += (nq.z > p.z ? -1 : 1) * 3;
  setTarget(ai, tx, tz, 1.2);
  ai.turbo = frontD > 5 && p.tb > 0.25 && ahead > 7 && rand(game) < D.turbo;
}

function thinkSupport(game, p, D, carrier) {
  const ai = p.ai;
  const att = attackDir(p.tm), gx = att * GX;
  const side = carrier.z >= 0 ? 1 : -1;
  const aheadC = GX - att * carrier.x;
  let ax, az, bx, bz;
  if (aheadC < 24) {         // in the attacking zone: weak-side slot + high slot
    ax = gx - att * 6.5; az = -side * 3.8;
    bx = gx - att * 13; bz = side * 2.5;
  } else {                   // breakout: lead up ice, wide
    ax = carrier.x + att * 10; az = -side * 6;
    bx = carrier.x + att * 5; bz = side * 4;
  }
  let other = null;
  for (const q of game.players) if (q.tm === p.tm && !q.g && q !== p && q !== carrier) other = q;
  const dA = (p.x - ax) ** 2 + (p.z - az) ** 2, dB = (p.x - bx) ** 2 + (p.z - bz) ** 2;
  let useA = dA <= dB;
  if (other) {
    const oA = (other.x - ax) ** 2 + (other.z - az) ** 2, oB = (other.x - bx) ** 2 + (other.z - bz) ** 2;
    const mine = dA + oB, theirs = dB + oA;
    useA = mine < theirs || (mine === theirs && p.id < other.id);
  }
  let tx = useA ? ax : bx, tz = useA ? az : bz;
  // keep moving: slow drift around the spot
  const ph = game.tick * 0.015 + p.id * 1.9;
  tz += Math.sin(ph) * 1.3; tx += Math.cos(ph * 0.7) * 1.0;
  // get open: step away from the nearest defender
  let nd = 99, nz = 0;
  for (const q of game.players) {
    if (q.tm === p.tm || q.g) continue;
    const d = Math.hypot(q.x - tx, q.z - tz);
    if (d < nd) { nd = d; nz = q.z; }
  }
  if (nd < 2.2) tz += (tz >= nz ? 1 : -1) * 2;
  setTarget(ai, tx, tz, 1.5);
  ai.spacing = 0.8;
  ai.turbo = Math.hypot(ai.tx - p.x, ai.tz - p.z) > 9 && p.tb > 0.5 && rand(game) < D.turbo * 0.5;
}

function thinkReceive(game, p, D) {
  const ai = p.ai, pk = game.puck, fl = game.flight;
  const v2 = pk.vx * pk.vx + pk.vz * pk.vz;
  let t = v2 > 1e-3 ? ((p.x - pk.x) * pk.vx + (p.z - pk.z) * pk.vz) / v2 : 0;
  t = clamp(t, 0, 1.5);
  setTarget(ai, pk.x + pk.vx * t, pk.z + pk.vz * t, 0.8);
  ai.spacing = 0; ai.arrive = true;
  if (ai.otFlight !== fl.tick) {
    ai.otFlight = fl.tick;
    const sv = shotChance(game, p.tm, ai.tx, ai.tz, 40 + p.sht, 'onetimer');
    if (sv > 0.15 && rand(game) < D.ot) ai.press |= BTN.SHOOT;   // one-time it
  }
}

function thinkInterceptPass(game, p, D, receiver) {
  const ai = p.ai, pk = game.puck;
  const v2 = pk.vx * pk.vx + pk.vz * pk.vz;
  let t = v2 > 1e-3 ? ((p.x - pk.x) * pk.vx + (p.z - pk.z) * pk.vz) / v2 : 0;
  t = clamp(t, 0, 1.2);
  const cx = pk.x + pk.vx * t, cz = pk.z + pk.vz * t;
  const myD = Math.hypot(cx - p.x, cz - p.z);
  let closer = false;
  for (const q of game.players) {
    if (q.tm !== p.tm || q === p || q.g) continue;
    if (distPointSeg(q.x, q.z, pk.x, pk.z, pk.x + pk.vx * 1.2, pk.z + pk.vz * 1.2) < myD) closer = true;
  }
  if (!closer && myD < 6) {
    setTarget(ai, cx, cz, 0.6);
    ai.arrive = false; ai.spacing = 0.1;
    ai.turbo = myD > 3 && p.tb > 0.3 && rand(game) < D.turbo;
    return;
  }
  thinkDefense(game, p, D, receiver);
}

function thinkDefense(game, p, D, carrier) {
  const ai = p.ai;
  const att = attackDir(p.tm), ownX = -att * GX;
  const myD = Math.hypot(p.x - carrier.x, p.z - carrier.z);
  let rank = 0;
  for (const q of game.players) {
    if (q.tm !== p.tm || q === p || q.g || q.s === DOWN) continue;
    const d = Math.hypot(q.x - carrier.x, q.z - carrier.z);
    if (d < myD || (d === myD && q.id < p.id)) rank++;
  }
  if (rank === 0 && !carrier.g) {
    // pressure the carrier from the goal side
    const lead = clamp(myD / 14, 0.05, 0.45);
    let tx = carrier.x + carrier.vx * lead, tz = carrier.z + carrier.vz * lead;
    if (myD > 3) {
      const gx = ownX - carrier.x, gz = -carrier.z, gl = Math.hypot(gx, gz) || 1;
      tx += (gx / gl) * 1.2; tz += (gz / gl) * 1.2;
    }
    setTarget(ai, tx, tz, 0.5);
    ai.arrive = false; ai.spacing = 0.1;
    ai.turbo = myD > 4 && p.tb > 0.3 && rand(game) < D.turbo;
    const dx = carrier.x - p.x, dz = carrier.z - p.z;
    const fd = (Math.cos(p.f) * dx + Math.sin(p.f) * dz) / (myD || 1);
    if (myD < 1.9 && fd > 0.5 && p.pokeCd <= 0 && rand(game) < D.poke) {
      ai.press |= BTN.ACTION;
    } else if (myD < 2.9 && myD > 0.5 && fd > 0.82 && p.checkCd <= 0 && carrier.s !== DOWN && rand(game) < D.check) {
      // turbo held at the press = big hit; the AI loves to pin carriers on the boards
      const pinned = boardDistance(carrier.x, carrier.z).d < 3.5 ? 2.2 : 1;
      ai.turbo = p.tb > 0.3 && rand(game) < D.turboCheck * pinned;
      ai.press |= BTN.SHOOT;
    }
    return;
  }
  thinkMark(game, p, D, carrier, carrier.g ? rank + 1 : rank);
}

// Cover the dangerous non-carrier opponents (rank 1 = most dangerous) and the slot.
function thinkMark(game, p, D, carrier, rank) {
  const ai = p.ai;
  const att = attackDir(p.tm), ownX = -att * GX;
  let o1 = null, o2 = null, d1 = 1e9, d2 = 1e9;
  for (const q of game.players) {
    if (q.tm === p.tm || q.g || q === carrier) continue;
    const d = Math.hypot(q.x - ownX, q.z);
    if (d < d1) { o2 = o1; d2 = d1; o1 = q; d1 = d; } else if (d < d2) { o2 = q; d2 = d; }
  }
  const m = rank <= 1 ? o1 : (o2 || o1);
  const slotX = ownX + att * 6;
  let tx, tz;
  if (!m) { tx = slotX; tz = 0; }
  else {
    const gx = ownX - m.x, gz = -m.z, gl = Math.hypot(gx, gz) || 1;
    tx = m.x + (gx / gl) * 1.6; tz = m.z + (gz / gl) * 1.6;
    // shade toward the passing lane from the carrier
    tx = tx * 0.75 + (carrier.x + m.x) * 0.125; tz = tz * 0.75 + (carrier.z + m.z) * 0.125;
    if (rank >= 2) { tx = (tx + slotX) * 0.5; tz = tz * 0.5; }
    // opportunistic hit on the man you're covering
    const dx = m.x - p.x, dz = m.z - p.z, dm = Math.hypot(dx, dz) || 1;
    if (dm < 2.2 && (Math.cos(p.f) * dx + Math.sin(p.f) * dz) / dm > 0.85 && p.checkCd <= 0 &&
        m.s !== DOWN && rand(game) < D.check * 0.12) {
      ai.press |= BTN.SHOOT;
    }
  }
  setTarget(ai, tx, tz, 1.2);
  ai.spacing = 0.6;
  ai.turbo = Math.hypot(ai.tx - p.x, ai.tz - p.z) > 7 && p.tb > 0.5 && rand(game) < D.turbo * 0.5;
}

function thinkLoose(game, p, D) {
  const ai = p.ai, pk = game.puck;
  const myT = timeTo(p, pk.x, pk.z);
  let rank = 0, bestOther = 1e9;
  for (const q of game.players) {
    if (q.tm !== p.tm || q === p || q.g) continue;
    const t = timeTo(q, pk.x, pk.z);
    if (t < myT || (t === myT && q.id < p.id)) rank++;
    if (t < bestOther) bestOther = t;
  }
  if (rank === 0 || (rank === 1 && myT < bestOther + 0.7)) {
    const ip = intercept(game, p);
    ai.tx = ip.x; ai.tz = ip.z;
    ai.arrive = false; ai.spacing = 0.15;
    ai.turbo = myT > 0.8 && p.tb > 0.3 && rand(game) < D.turbo;
    return;
  }
  const att = attackDir(p.tm), ownX = -att * GX;
  let tx, tz;
  if (rank >= 2) {
    // safety: between the puck and our net
    tx = ownX + (pk.x - ownX) * 0.4; tz = pk.z * 0.4;
    if (att * (tx - ownX) < 5) tx = ownX + att * 5;
  } else {
    tx = pk.x + att * 5; tz = -(pk.z >= 0 ? 1 : -1) * 4;
  }
  setTarget(ai, tx, tz, 1.2);
  ai.spacing = 0.7;
}
