// ICE RIOT sim - puck: carried puck, loose-puck physics (substepped so 45+ m/s shots
// never tunnel), boards/glass, posts/crossbar, solid nets, goal detection, pickups.

import { PSTATE, PHASE, EVENT, RINK, nearestGlassPanel } from './constants.js';
import {
  rand, emit, distPointSeg, collideBoards, collideNets, newFlight, defendSide, r3, boardDist,
  GRAV, GX, HW, GH, GD, PR, POST_R, REACH, FL_LOOSE, FL_SHOT, FL_PASS,
} from './sim-util.js';
import { givePuck, touch } from './sim-player.js';
import { checkSave } from './sim-goalie.js';

const { DOWN, CELEBRATE } = PSTATE;
const GLASS_TOP = RINK.boardHeight + RINK.glassHeight;

// Advance the puck one tick. Sets game.pending = 'goal' | 'out' when play must stop.
export function stepPuck(game, dt) {
  const pk = game.puck;
  if (pk.o >= 0) { carryPuck(game, dt); return; }
  const fl = game.flight;
  if (fl && fl.kind === FL_PASS && game.tick - fl.tick > 120) fl.kind = FL_LOOSE;  // pass flights expire
  const sp = Math.hypot(pk.vx, pk.vy, pk.vz);
  let n = Math.ceil((sp * dt) / 0.09);
  n = n < 4 ? 4 : n > 12 ? 12 : n;
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    substep(game, h);
    if (game.pending || pk.o >= 0) break;
  }
}

function carryPuck(game, dt) {
  const pk = game.puck, o = game.players[pk.o];
  const reach = o.g ? 0.55 : REACH;
  const tx = o.x + Math.cos(o.f) * reach, tz = o.z + Math.sin(o.f) * reach;
  const ox = pk.x, oz = pk.z;
  let nx = pk.x + o.vx * dt, nz = pk.z + o.vz * dt;
  nx += (tx - nx) * 0.45; nz += (tz - nz) * 0.45;
  pk.x = nx; pk.z = nz; pk.y = 0; pk.vy = 0; pk.vx = 0; pk.vz = 0;
  collideBoards(pk, PR, 0);
  collideNets(pk, PR);                       // can't carry the puck into the net
  pk.vx = (pk.x - ox) / dt; pk.vz = (pk.z - oz) / dt;
}

function substep(game, h) {
  const pk = game.puck;
  const px = pk.x, py = pk.y, pz = pk.z;
  const play = game.ph === PHASE.PLAY;

  pk.x += pk.vx * h; pk.z += pk.vz * h;
  if (pk.y > 0 || pk.vy > 0) {
    pk.vy -= GRAV * h;
    pk.y += pk.vy * h;
    if (pk.y <= 0) {
      pk.y = 0;
      pk.vy = pk.vy < -1.2 ? -pk.vy * 0.32 : 0;  // bounce damping on the ice
    }
  }
  // friction on the ice (+ tiny drag), only air drag while airborne
  const hs = Math.hypot(pk.vx, pk.vz);
  if (hs > 1e-6) {
    const dec = (pk.y <= 0.001 ? 0.25 + 0.012 * hs : 0.006 * hs) * h;
    const ns = hs > dec ? (hs - dec) / hs : 0;
    pk.vx *= ns; pk.vz *= ns;
  }

  // boards + glass
  const bd = boardDist(pk.x, pk.z);
  if (bd.d < PR) {
    const bnx = bd.nx, bnz = bd.nz, bdd = bd.d;
    if (play && (pk.y > GLASS_TOP ||
        (pk.y > RINK.boardHeight && game.gl.length > 0 && game.gl.includes(nearestGlassPanel(pk.x, pk.z))))) {
      game.pending = 'out';                   // over the glass / through a broken pane
      return;
    }
    const pen = PR - bdd;
    pk.x += bnx * pen; pk.z += bnz * pen;
    const vn = pk.vx * bnx + pk.vz * bnz;
    const tx = -bnz, tz = bnx;
    if (vn < 0) {
      pk.vx -= 1.65 * vn * bnx; pk.vz -= 1.65 * vn * bnz;   // restitution 0.65
      const vt = pk.vx * tx + pk.vz * tz;
      pk.vx -= vt * 0.12 * tx; pk.vz -= vt * 0.12 * tz;
      if (-vn > 2.5 && game.tick - game.lastBoardsTick > 4) {
        game.lastBoardsTick = game.tick;
        emit(game, EVENT.BOARDS, { x: r3(pk.x), z: r3(pk.z), power: r3(Math.min(1, -vn / 30)) });
      }
      const fl = game.flight;
      if (fl) {
        // off the boards it's just a loose puck (anyone can play it)
        fl.kind = FL_LOOSE; fl.shotKind = '';
        fl.saveDone = false; fl.beaten = false; fl.rolled = 0;
        fl.x0 = pk.x; fl.z0 = pk.z;
      }
    }
    // rimming: the puck rubs along the boards and bleeds speed
    const vt = pk.vx * tx + pk.vz * tz, rub = 6 * h;
    const nvt = vt > rub ? vt - rub : vt < -rub ? vt + rub : 0;
    pk.vx += (nvt - vt) * tx; pk.vz += (nvt - vt) * tz;
  }

  netCollide(game, 1, px, py, pz);
  if (game.pending) return;
  netCollide(game, -1, px, py, pz);
  if (game.pending) return;
  if (play && game.flight) checkSave(game);
}

// Posts, crossbar, the net mouth (goal detection) and the solid outside of the net,
// computed in goal-local coordinates: u = distance behind the goal line, w = z.
function netCollide(game, side, px, py, pz) {
  const pk = game.puck;
  let u = side * pk.x - GX, w = pk.z, y = pk.y;
  if (u < -0.4 || u > GD + 0.4 || w > HW + 0.4 || w < -HW - 0.4) return;
  let vu = side * pk.vx, vw = pk.vz, vy = pk.vy;
  const pu = side * px - GX;
  const play = game.ph === PHASE.PLAY;
  let changed = false;

  if (y < GH) {
    for (let ps = -1; ps <= 1; ps += 2) {
      const dx = u, dz = w - ps * HW, d2 = dx * dx + dz * dz, rr = PR + POST_R;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      const nx = d > 1e-6 ? dx / d : -1, nz = d > 1e-6 ? dz / d : 0;
      u = nx * rr; w = ps * HW + nz * rr;
      const vn = vu * nx + vw * nz;
      if (vn < 0) {
        vu -= 1.45 * vn * nx; vw -= 1.45 * vn * nz;   // posts are lively but not trampolines
        if (-vn > 2 && play) { emit(game, EVENT.POST, { x: r3(side * (u + GX)), z: r3(w) }); postLoose(game); }
      }
      changed = true;
    }
  }

  if (game.puckInNet !== side && pu < 0 && u >= 0 && Math.abs(w) < HW) {
    if (y >= GH - 0.07 && y <= GH + 0.09) {
      // crossbar
      u = -0.01; vu = -Math.abs(vu) * 0.35;
      vy = y > GH ? Math.abs(vy) * 0.4 + 1.0 : -Math.abs(vy) * 0.4 - 0.5;
      if (play) { emit(game, EVENT.POST, { x: r3(side * GX), z: r3(w) }); postLoose(game); }
      changed = true;
    } else if (y < GH - 0.07) {
      game.puckInNet = side;                 // through the mouth from the front
    }
  }

  if (game.puckInNet === side) {
    if (u < 0) game.puckInNet = 0;           // bounced back out before fully crossing
    else {
      if (u > PR && play && !game.pending) { game.pending = 'goal'; game.pendingSide = side; }
      if (u > GD - PR) { u = GD - PR; if (vu > 0) vu = -vu * 0.15; }
      if (w > HW - PR) { w = HW - PR; if (vw > 0) vw = -vw * 0.15; }
      else if (w < -HW + PR) { w = -HW + PR; if (vw < 0) vw = -vw * 0.15; }
      if (y > GH - 0.08) { y = GH - 0.08; if (vy > 0) vy = 0; }
      vu *= 0.97; vw *= 0.97;                // the mesh soaks it up
      changed = true;
    }
  } else if (u > 0 && u < GD + PR && Math.abs(w) < HW + PR && y < GH + 0.05) {
    // solid net from the outside: back, side mesh, top, or (rare) shoved back out the front
    if (pu >= GD) { u = GD + PR; if (vu < 0) vu = -vu * 0.35; }
    else if (Math.abs(pz) >= HW) { w = (pz > 0 ? 1 : -1) * (HW + PR); vw = -vw * 0.35; }
    else if (py >= GH) { y = GH + 0.05; vy = Math.abs(vy) * 0.3; }
    else { u = -0.01; vu = -Math.abs(vu) * 0.3; }
    changed = true;
  }

  if (changed) {
    pk.x = side * (u + GX); pk.z = w; pk.y = y;
    pk.vx = side * vu; pk.vz = vw; pk.vy = vy;
  }
}

// Off the iron: the shot is over, it's a loose puck now (the goalie may still have to
// react if it caroms toward the net, so keep the save roll available).
function postLoose(game) {
  const fl = game.flight;
  if (!fl || fl.kind === FL_LOOSE) return;
  fl.kind = FL_LOOSE; fl.shotKind = ''; fl.rolled = 0;
}

// Loose-puck pickups after the puck moved this tick (prevX/prevZ = start of the tick).
export function checkPickups(game, prevX, prevZ) {
  const pk = game.puck;
  if (pk.o >= 0 || game.pending) return;
  const fl = game.flight;
  const sp = Math.hypot(pk.vx, pk.vz);
  let best = null, bw = -1;
  for (const p of game.players) {
    if (p.pickCd > 0 || p.s === DOWN || p.s === CELEBRATE || p.y > 0.3) continue;
    if (p.g) {
      // goalies cover slow pucks in their own area
      if (pk.y > 1.0 || sp > 9 || (fl && fl.beaten)) continue;
      const side = defendSide(p.tm);
      if (side * pk.x - GX > 0.3 || Math.hypot(pk.x - side * GX, pk.z) > 3.2) continue;
      if (distPointSeg(p.x, p.z, prevX, prevZ, pk.x, pk.z) > 0.9) continue;
      const w = 3 + rand(game);
      if (w > bw) { bw = w; best = p; }
      continue;
    }
    if (pk.y > 0.5) continue;
    const sx = p.x + Math.cos(p.f) * REACH, sz = p.z + Math.sin(p.f) * REACH;
    let d = distPointSeg(sx, sz, prevX, prevZ, pk.x, pk.z);
    const db = distPointSeg(p.x, p.z, prevX, prevZ, pk.x, pk.z);
    const recv = !!fl && fl.kind === FL_PASS && fl.to === p.id;
    let r = 0.9;
    if (recv) { r = 1.25; if (db < d) d = db; }
    else if (db + 0.35 < d) d = db + 0.35;    // puck in the skates
    if (d > r) continue;
    const bit = 1 << p.id;
    if (fl && !recv) {
      if (fl.kind === FL_SHOT) {
        if (p.tm === fl.team) { if (game.tick - fl.tick < 15) continue; }
        else if (sp > 15) {
          if (fl.rolled & bit) continue;
          fl.rolled |= bit;
          if (rand(game) < 0.12 + p.chk * 0.008) { blockShot(game, p); return; }
          continue;
        }
      } else if (fl.kind === FL_PASS && p.tm !== fl.team) {
        if (fl.rolled & bit) continue;      // interception attempt: one roll per pass
        fl.rolled |= bit;
        if (rand(game) > 0.3 + p.hnd * 0.04) continue;
      } else if (sp > 18) {
        if (fl.rolled & bit) continue;      // hot loose puck: may handcuff you
        fl.rolled |= bit;
        if (rand(game) > 0.45 + p.hnd * 0.04) continue;
      }
    }
    // contested pickups favour hands + luck
    const w = (recv ? 2 : 0) + p.hnd * 0.1 + rand(game) * 0.8;
    if (w > bw) { bw = w; best = p; }
  }
  if (best) givePuck(game, best);
}

function blockShot(game, p) {
  const pk = game.puck, sp = Math.hypot(pk.vx, pk.vz);
  const a = Math.atan2(-pk.vz, -pk.vx) + (rand(game) - 0.5) * 2.4;
  const ns = sp * (0.2 + rand(game) * 0.2);
  pk.vx = Math.cos(a) * ns; pk.vz = Math.sin(a) * ns;
  pk.vy = 0.5 + rand(game) * 1.5; if (pk.y < 0.02) pk.y = 0.02;
  touch(game, p, false);
  game.flight = newFlight(game, FL_LOOSE, p.id);
  game.blocks++;
}
