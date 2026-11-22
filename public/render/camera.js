// ICE RIOT renderer - broadcast camera rig. Critically-damped springs on camera position, look-at target
// and field of view; modes: play (follow the puck from +Z), goal push-in, fight push-in, intermission
// (wide), game-over orbit, attract orbit (no state). Trauma-based screen shake. Aspect-aware.
//
// Instant replay shots (info.replay = { cam, goal }): 'cast' is the play camera following the replayed
// puck, panning to a glass break while info.glass is set; 'net' is the goal cam, low in the back of
// the net behind the goalie, looking out and zooming from the shooter to wide as the puck flies at it;
// 'puck' rides just behind the puck along its path; 'glass' (the glass-smash picture-in-picture) stands
// on the ice a few metres off a broken pane, at a three-quarter angle, slowly pushing in on it with
// the crowd behind. Entering, leaving or switching a replay shot is a hard cut, like a TV
// broadcast, instead of a spring move.
//
// The play camera is the classic arcade side view (NHL Hitz 20-02 style): low, close and slightly
// telephoto on the +Z side, tracking your own skater (or the puck, with no local player) tightly so
// the skaters are big on screen, about one zone
// fills the frame, the far boards sit near the top with a thin strip of crowd and the near boards show
// at the bottom when play comes close. Orbits and the intermission shot stay wide.
import * as THREE from 'three';
import { PHASE, RINK } from '/shared/constants.js';

// play camera (landscape): sits PLAY_H up and PLAY_D toward +Z from the focus, looking at focus + LOOK_Z
const PLAY_FOV = 32, PLAY_H = 10, PLAY_D = 18.2, LOOK_Z = 1.0;
const MIN_HFOV = 50;          // degrees of horizontal view the play camera always keeps (4:3 widens)
// goal / fight push-ins end here (relative to the scorer or the fight)
const GOAL_H = 7.2, GOAL_D = 11.5, FIGHT_H = 6.8, FIGHT_D = 11;
// wide shots (orbits, attract, period end) keep the old broadcast lens
const WIDE_FOV = 40;
// portrait (tall screens): a higher, steeper, wider view so the rink's width fills the tall screen
const PORT_H = 25.5, PORT_D = 15.3, PORT_LOOK_Z = -0.8;
// the hanging scoreboard's lowest point (ticker ring); a camera above it can look down through it
const JUMBO_BOTTOM = 10.3;
// goal cam: inside the net, at the back, low, behind the goalie. The net is 1.22 m tall with a 0.5 m
// top shelf, then its back slopes down to the ice 1.1 m behind the goal line (0.65 m at the posts),
// so this spot sits 5-7 cm in front of the back netting (anywhere up to NET_MAX_Z across) with the
// crossbar and posts framing the goalie and the play. Zooms from FAR (the shot coming from up ice,
// past the goalie) to NEAR (wide, the puck flying into the net at the lens).
const NET_D = 0.82, NET_Y = 0.4, NET_MAX_Z = 0.55;
const NET_FOV_FAR = 44, NET_FOV_NEAR = 66, NET_HFOV_FAR = 58, NET_HFOV_NEAR = 80;
// puck cam: this far behind and above the puck; a wide lens for speed
const PUCK_BACK = 1.4, PUCK_UP = 0.3, PUCK_FOV = 58, PUCK_MIN_HFOV = 84;
// glass cam: this far off the pane (pushing in from FAR to NEAR), this high, looking at glass height
const GLASS_FAR = 8, GLASS_NEAR = 6, GLASS_Y = 2.1, GLASS_LOOK_Y = 1.2, GLASS_FOV = 42, GLASS_MIN_HFOV = 62;
const REPLAY_MODES = new Set(['cast', 'net', 'puck', 'glass']);

function spring(s, target, omega, dt) {
  // Critically damped spring (SmoothDamp form), stable for any dt.
  const x = omega * dt;
  const ex = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = s.x - target;
  const temp = (s.v + omega * change) * dt;
  s.v = (s.v - omega * temp) * ex;
  s.x = target + (change + temp) * ex;
  return s.x;
}
const S = (x) => ({ x, v: 0 });
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const D2R = Math.PI / 180;

export function createCameraRig(camera) {
  const cx = S(0), cy = S(12), cz = S(36), lx = S(0), ly = S(0), lz = S(0), fv = S(WIDE_FOV);
  let aspect = 16 / 9, portrait = 0, playFov = PLAY_FOV, wideFov = WIDE_FOV, distK = 1;
  let playH = PLAY_H, playD = PLAY_D, lookZ = LOOK_Z, xClamp = 19.5, zLo = -6, zHi = 4.5, zFollow = 0.5;
  let trauma = 0, orbitA = 0, time = 0, mode = 'attract', modeT = 0, shakeScale = 1, fovTarget = WIDE_FOV;
  let cutNext = false, shotShake = 1;          // snap the next frame (replay cut); shake factor of this shot
  let pdx = 1, pdz = 0;                        // puck cam: smoothed travel direction (unit, on the ice)
  let ndx = -1, ndz = 0;                       // goal cam: from the entry point back up the puck's path
  const vFor = (deg) => 2 * Math.atan(Math.tan(deg * D2R / 2) / aspect) / D2R;

  function setAspect(a) {
    aspect = Math.max(0.3, a || 1.6);
    // portrait: 0 at 5:4 and wider, 1 at ~9:20 (a phone held upright)
    portrait = clamp((1.25 - aspect) / 0.8, 0, 1);
    // (vFor: vertical FOV that keeps `deg` of horizontal view at this aspect)
    // play lens: telephoto on wide screens, widened on 4:3 and on tall screens (up to 60 deg)
    playFov = clamp(Math.max(PLAY_FOV, vFor(MIN_HFOV), lerp(PLAY_FOV, vFor(56), portrait)), PLAY_FOV, 60);
    wideFov = clamp(Math.max(WIDE_FOV, vFor(56)), WIDE_FOV, 60);
    distK = aspect < 1 ? 1 + (1 - aspect) * 0.55 : 1;
    playH = lerp(PLAY_H, PORT_H, portrait);
    playD = lerp(PLAY_D, PORT_D, portrait);
    lookZ = lerp(LOOK_Z, PORT_LOOK_Z, portrait);
    // how far the focus may follow the puck toward the end boards: the frame's edge stops near them
    const r = Math.hypot(playH, playD - lookZ);
    const halfSpan = r * Math.tan(playFov * D2R / 2) * aspect;
    xClamp = clamp(RINK.halfLength + 0.5 - halfSpan, 14, 21.5);
    // across the ice: follow the puck more on the tight landscape lens, less on the tall portrait one
    zFollow = lerp(0.7, 0.38, portrait);
    zLo = lerp(-7, -3.6, portrait);
    zHi = lerp(5, 2.6, portrait);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }

  function noise(t, s) { return Math.sin(t * 23.7 + s) * 0.55 + Math.sin(t * 41.3 + s * 2.1) * 0.3 + Math.sin(t * 67.1 + s * 3.7) * 0.15; }

  function apply(dt, omegaPos, omegaLook, tx, ty, tz, tlx, tly, tlz, omegaFov = 2.6) {
    if (cutNext) {
      // a replay cut: jump straight to the new shot
      cutNext = false;
      cx.x = tx; cy.x = ty; cz.x = tz; lx.x = tlx; ly.x = tly; lz.x = tlz; fv.x = fovTarget;
      cx.v = cy.v = cz.v = lx.v = ly.v = lz.v = fv.v = 0;
    } else {
      spring(cx, tx, omegaPos, dt); spring(cy, ty, omegaPos, dt); spring(cz, tz, omegaPos, dt);
      spring(lx, tlx, omegaLook, dt); spring(ly, tly, omegaLook, dt); spring(lz, tlz, omegaLook, dt);
      spring(fv, fovTarget, omegaFov, dt);
    }
    if (Math.abs(camera.fov - fv.x) > 1e-3) { camera.fov = fv.x; camera.updateProjectionMatrix(); }
    trauma = Math.max(0, trauma - dt * 1.5);
    const sh = trauma * trauma * shakeScale * shotShake;
    const ox = noise(time, 1.3) * sh * 0.8, oy = noise(time, 4.1) * sh * 0.6, oz = noise(time, 7.7) * sh * 0.5;
    camera.position.set(cx.x + ox, cy.x + oy, cz.x + oz);
    camera.lookAt(lx.x + ox * 0.5, ly.x + oy * 0.5, lz.x);
    camera.rotateZ(noise(time, 9.9) * sh * 0.05);
  }

  // play camera targets for a focus that follows the puck `k`, pulled toward `g` ({x, z, w: 0..1}, a
  // glass break in a replay) when given
  function play(dt, k, g) {
    const lead = clamp((k.vx || 0) * 0.3, -4.5, 4.5);
    let fx = clamp((k.x || 0) + lead, -xClamp, xClamp);
    let fz = clamp((k.z || 0) * zFollow + clamp((k.vz || 0) * 0.12, -1.5, 1.5), zLo, zHi);
    let zoom = 1 - sstep(14, 24, Math.abs(k.x || 0)) * 0.08, ly0 = 0;
    if (g && g.w > 0) {
      // frame the broken panel mid-screen: pan to it, aim at the boards (past the usual across-ice
      // limits: a few metres short of far glass, well up the ice for near glass so the near boards
      // come into the lower half), look up to glass height and pull back a little
      fx = lerp(fx, clamp(g.x, -xClamp, xClamp), g.w);
      fz = lerp(fz, clamp(g.z < 0 ? g.z + 3 : g.z - 5, -10.5, 8), g.w);
      zoom = lerp(zoom, 1.15, g.w);
      ly0 = (g.z < 0 ? 1.2 : 0) * g.w;
    }
    const tx = fx * 0.8, ty = playH * zoom, tz = fz + playD * zoom;
    apply(dt, 3.2, 3.8, tx, ty, tz, fx, ly0, fz + lookZ * zoom);
  }

  // goal cam: in the back of the net (goal = {x, z} where the puck crossed the line), low, behind
  // the goalie, looking out through the goal mouth. It looks up the puck's path at the shooter past
  // the goalie, then widens as the puck flies at the lens into the twine.
  function netCam(dt, k, goal, entering) {
    const gx = RINK.goalLineX, hw = RINK.goalHalfWidth;
    const kx = k.x || 0, ky = k.y || 0, kz = k.z || 0;
    const s = Math.sign(goal ? goal.x : kx) || 1;
    const ez = clamp(goal ? goal.z : kz, -hw, hw);                 // entry point (s * gx, ez)
    if (entering) {
      // the path: from the entry point back to the puck (on the shooter's stick as the tail starts)
      let ax = kx - s * gx, az = kz - ez;
      if (s * ax > -1.5) { ax = -s * 1.5; az = clamp(az, -1.5, 1.5); }   // puck beside / behind the net
      const l = Math.hypot(ax, az);
      ndx = ax / l; ndz = az / l;
    }
    // toward the side the puck went in: the shot comes at the lens past the goalie, not through him
    const camX = s * (gx + NET_D), camZ = clamp(ez * 0.8, -NET_MAX_Z, NET_MAX_Z);
    const dist = Math.hypot(kx - camX, kz - camZ);
    // far: look up the path, drawn toward the puck; close: follow the puck into the net
    const far = sstep(2.5, 14, dist);
    const px = s * gx + ndx * 7, pz = ez + ndz * 7;                // a point up the path, in the slot
    let tlx = lerp(kx, lerp(px, kx, 0.6), far), tlz = lerp(kz, lerp(pz, kz, 0.6), far);
    const tly = lerp(ky, 0.5, far);
    if (s * (tlx - camX) > -1.3) tlx = camX - s * 1.3;             // always look out of the net
    fovTarget = Math.max(lerp(NET_FOV_NEAR, NET_FOV_FAR, far), vFor(lerp(NET_HFOV_NEAR, NET_HFOV_FAR, far)));
    apply(dt, 30, 7, camX, NET_Y, camZ, tlx, tly, tlz, 7);
  }

  // puck cam: just behind the puck, looking ahead toward the net it is about to go into
  function puckCam(dt, k, goal, entering) {
    const gx = RINK.goalLineX;
    const kx = k.x || 0, ky = k.y || 0, kz = k.z || 0;
    const sp = Math.hypot(k.vx || 0, k.vz || 0);
    const s = Math.sign(goal ? goal.x : kx) || 1;
    const inNet = s * kx > gx - 0.05 && Math.abs(kz) < RINK.goalHalfWidth + 0.3;
    // where it is headed: along its path while that heads at the net (the shot, a deflection), else
    // the line to the net (a pass across for a one-timer, a puck on a stick)
    const ax = s * gx - kx, az = (goal ? goal.z : 0) - kz, al = Math.hypot(ax, az) || 1;
    let hx = ax / al, hz = az / al;
    if (sp > 2.5 && (k.vx * hx + k.vz * hz) / sp > 0.5) { hx = k.vx / sp; hz = k.vz / sp; }
    if (entering) { pdx = hx; pdz = hz; }
    else if (!inNet) {
      // frozen once it is in the net, so the rebound off the back doesn't spin the camera around
      const a = 1 - Math.exp(-dt * 10);
      pdx += (hx - pdx) * a; pdz += (hz - pdz) * a;
      const l = Math.hypot(pdx, pdz) || 1; pdx /= l; pdz /= l;
    }
    let tx = kx - pdx * PUCK_BACK, tz = kz - pdz * PUCK_BACK;
    if (s * tx > gx - 0.15) tx = s * (gx - 0.15);                  // stay out front of the goal mouth
    const ty = Math.max(0.24, ky * 0.7 + PUCK_UP);
    fovTarget = Math.max(PUCK_FOV, vFor(PUCK_MIN_HFOV));
    // locked to the puck (no spring lag): a change of direction orbits it instead of cutting past it
    apply(dt, 150, 150, tx, ty, tz, kx + pdx * 5, ky * 0.5 + 0.16, kz + pdz * 5, 12);
  }

  // glass cam: on the ice off the pane at (g.x, g.z), a three-quarter angle, pushing in slowly
  function glassCam(dt, g) {
    // the pane's inward normal: the rink's (elliptical) gradient, so corners face the right way too
    let nx = -g.x / (RINK.halfLength * RINK.halfLength), nz = -g.z / (RINK.halfWidth * RINK.halfWidth);
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    const tx = -nz, tz = nx;                                        // along the boards
    const side = g.x * tx + g.z * tz > 0 ? -1 : 1;                  // stand toward centre ice
    const d = lerp(GLASS_FAR, GLASS_NEAR, sstep(0, 4, modeT));
    const cxp = g.x + nx * d + tx * side * d * 0.4, czp = g.z + nz * d + tz * side * d * 0.4;
    fovTarget = Math.max(GLASS_FOV, vFor(GLASS_MIN_HFOV));
    apply(dt, 3, 4, cxp, GLASS_Y, czp, g.x, GLASS_LOOK_Y, g.z, 4);
  }

  /**
   * info: { scorer: {x, z} | null, fight: {x, z} | null, replay?: { cam: 'cast'|'net'|'puck'|'glass',
   * goal: {x, z} | null } | null, glass?: {x, z, w} | null, follow?: {x, z, vx, vz} | null (the
   * local player's skater: the play camera follows it instead of the puck) }
   */
  function update(state, dt, info) {
    time += dt;
    const rp = info && info.replay;
    let m;
    if (!state) m = 'attract';
    else if (rp) m = rp.cam === 'glass' && rp.glass ? 'glass' : state.k && (rp.cam === 'net' || rp.cam === 'puck') ? rp.cam : 'cast';
    else if (state.ph === PHASE.GAME_OVER) m = 'orbit';
    else if (info && info.fight) m = 'fight';
    else if (state.ph === PHASE.GOAL) m = 'goal';
    else if (state.ph === PHASE.PERIOD_END) m = 'wide';
    else m = 'play';
    const entering = m !== mode;
    if (entering) {
      // into, out of or between replay shots: cut instead of swinging the camera across the rink
      if (REPLAY_MODES.has(m) || REPLAY_MODES.has(mode)) cutNext = true;
      mode = m; modeT = 0;
      if (m === 'attract' || m === 'orbit') orbitA = Math.atan2(cx.x, cz.x);
    }
    modeT += dt;
    // shake is relative to the lens: a camera inside the net or riding the puck shakes far less
    shotShake = m === 'net' ? 0.25 : m === 'puck' ? 0.35 : 1;
    fovTarget = m === 'attract' || m === 'orbit' || m === 'wide' ? wideFov : playFov;
    if (m === 'net') { netCam(dt, state.k, rp.goal, entering); return; }
    if (m === 'puck') { puckCam(dt, state.k, rp.goal, entering); return; }
    if (m === 'glass') { glassCam(dt, rp.glass); return; }
    if (m === 'cast') { play(dt, state.k || { x: 0, z: 0, vx: 0, vz: 0 }, info.glass); return; }

    // orbits are elliptical (rink-shaped) so the camera never dives into the stands
    if (m === 'attract') {
      orbitA += dt * 0.085;
      const k2 = (1 + Math.sin(time * 0.07) * 0.1) * distK;
      const h = 14 + Math.sin(time * 0.05 + 1) * 3.5;
      apply(dt, 0.9, 1.2, Math.sin(orbitA) * 31 * k2, h, Math.cos(orbitA) * 23 * k2, 0, 0.5, 0);
      return;
    }
    if (m === 'orbit') {
      orbitA += dt * 0.12;
      apply(dt, 1.2, 1.5, Math.sin(orbitA) * 29 * distK, 13, Math.cos(orbitA) * 22 * distK, 0, 1, 0);
      return;
    }
    if (m === 'wide') {
      apply(dt, 1.5, 2, 0, 18 * (1 + portrait * 0.7), 31 * (1 - portrait * 0.3), 0, 0, -1);
      return;
    }
    const k = state.k || { x: 0, z: 0, vx: 0, vz: 0 };
    if (m === 'fight') {
      // push in on the two fighters (the client draws its 2D fight overlay on top)
      const f = info.fight;
      const fx = clamp(f.x, -26, 26), fz = clamp(f.z, -10, 10);
      const push = sstep(0, 0.9, modeT);
      const d = lerp(playD, lerp(FIGHT_D, PORT_D * 0.6, portrait), push);
      const h = lerp(playH, lerp(FIGHT_H, PORT_H * 0.4, portrait), push);
      apply(dt, 2.4, 3.0, fx * 0.9, h, fz + d, fx, 0.9, fz);
      return;
    }
    if (m === 'goal') {
      const f = info && info.scorer ? info.scorer : k;
      const fx = clamp(f.x, -27, 27), fz = clamp(f.z, -9, 9);
      const side = Math.sign(fx) || 1;
      const push = sstep(0, 1.2, modeT);
      const d = lerp(playD, lerp(GOAL_D, PORT_D * 0.6, portrait), push);
      const h = lerp(playH, lerp(GOAL_H, PORT_H * 0.4, portrait), push);
      apply(dt, 2.2, 2.8, fx - side * (1.5 + push * 2.5), h, fz + d, fx, 0.6 + push * 0.5, fz);
      return;
    }
    // play: stay tight on the skater you control (info.follow; the puck when there is none), x and
    // some z, leading in the direction of travel, pushing in near the goals. The renderer draws a puck
    // indicator (render/puck-marker.js) while the puck is elsewhere.
    play(dt, (info && info.follow) || k, null);
  }

  setAspect(16 / 9);
  camera.fov = fv.x;
  camera.updateProjectionMatrix();
  return {
    update,
    setAspect,
    shake(amount) { trauma = Math.min(1, trauma + amount); },
    /** 0..1 multiplier on shake amplitude (ctx.video.cameraShake). */
    setShakeScale(s) { shakeScale = Math.max(0, Math.min(1, s)); },
    get mode() { return mode; },
    /**
     * True when the camera is above the hanging scoreboard and looking down past it (tall portrait screens),
     * where it would block the ice: the renderer hides it then.
     */
    get overJumbo() { return portrait > 0.05 && cy.x > JUMBO_BOTTOM && mode !== 'attract' && mode !== 'orbit'; },
    snap() { cx.v = cy.v = cz.v = lx.v = ly.v = lz.v = fv.v = 0; },
  };
}
