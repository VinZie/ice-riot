// ICE RIOT renderer - broadcast camera rig. Critically-damped springs on camera position and
// look-at target; modes: play (follow puck from +Z), goal push-in, intermission, game-over orbit,
// attract orbit (no state). Trauma-based screen shake. Aspect-aware FOV (portrait widens).
import * as THREE from 'three';
import { PHASE, RINK } from '/shared/constants.js';

const BASE_FOV = 40;
// camera sits BASE_H up and BASE_D toward +Z from the focus, looking at focus + LOOK_Z (so the near
// boards stay on screen at the bottom and the far glass + first crowd rows at the top)
const BASE_H = 15, BASE_D = 21.8, LOOK_Z = 2.3;

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
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export function createCameraRig(camera) {
  const cx = S(0), cy = S(12), cz = S(36), lx = S(0), ly = S(0), lz = S(0);
  let aspect = 16 / 9, fovBase = BASE_FOV, distK = 1, hK = 1, dK = 1, xClamp = 15.5, lookZ = LOOK_Z;
  let trauma = 0, orbitA = 0, time = 0, mode = 'attract', modeT = 0, shakeScale = 1;

  function setAspect(a) {
    aspect = Math.max(0.3, a || 1.6);
    // keep at least ~56 deg of horizontal view; portrait phones get a much wider vertical FOV
    const minH = 56 * Math.PI / 180;
    const v = 2 * Math.atan(Math.tan(minH / 2) / aspect) * 180 / Math.PI;
    // portrait: moderate FOV widening + a steeper, higher camera so the rink's width fills the tall screen
    const portrait = clamp((1.25 - aspect) / 0.8, 0, 1);
    fovBase = clamp(Math.max(BASE_FOV, v), BASE_FOV, 60);
    distK = aspect < 1 ? 1 + (1 - aspect) * 0.55 : 1;
    hK = 1 + portrait * 0.7;
    dK = 1 - portrait * 0.3;
    lookZ = LOOK_Z * (1 - portrait) - portrait * 0.8;
    xClamp = 15.5 + portrait * 6;
    camera.aspect = aspect;
    camera.fov = fovBase;
    camera.updateProjectionMatrix();
  }

  function noise(t, s) { return Math.sin(t * 23.7 + s) * 0.55 + Math.sin(t * 41.3 + s * 2.1) * 0.3 + Math.sin(t * 67.1 + s * 3.7) * 0.15; }

  function apply(dt, omegaPos, omegaLook, tx, ty, tz, tlx, tly, tlz) {
    spring(cx, tx, omegaPos, dt); spring(cy, ty, omegaPos, dt); spring(cz, tz, omegaPos, dt);
    spring(lx, tlx, omegaLook, dt); spring(ly, tly, omegaLook, dt); spring(lz, tlz, omegaLook, dt);
    trauma = Math.max(0, trauma - dt * 1.5);
    const sh = trauma * trauma * shakeScale;
    const ox = noise(time, 1.3) * sh * 0.8, oy = noise(time, 4.1) * sh * 0.6, oz = noise(time, 7.7) * sh * 0.5;
    camera.position.set(cx.x + ox, cy.x + oy, cz.x + oz);
    camera.lookAt(lx.x + ox * 0.5, ly.x + oy * 0.5, lz.x);
    camera.rotateZ(noise(time, 9.9) * sh * 0.05);
  }

  /** info: { scorer: {x, z} | null, fight: {x, z} | null } */
  function update(state, dt, info) {
    time += dt;
    let m;
    if (!state) m = 'attract';
    else if (state.ph === PHASE.GAME_OVER) m = 'orbit';
    else if (info && info.fight) m = 'fight';
    else if (state.ph === PHASE.GOAL) m = 'goal';
    else if (state.ph === PHASE.PERIOD_END) m = 'wide';
    else m = 'play';
    if (m !== mode) { mode = m; modeT = 0; if (m === 'attract' || m === 'orbit') orbitA = Math.atan2(cx.x, cz.x); }
    modeT += dt;

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
      apply(dt, 1.5, 2, 0, 18 * hK, 31 * dK, 0, 0, -1);
      return;
    }
    const k = state.k || { x: 0, z: 0, vx: 0, vz: 0 };
    if (m === 'fight') {
      // push in on the two fighters (the client draws its 2D fight overlay on top)
      const f = info.fight;
      const fx = clamp(f.x, -26, 26), fz = clamp(f.z, -10, 10);
      const push = sstep(0, 0.9, modeT);
      const d = (BASE_D - push * 13) * dK, h = (BASE_H - push * 9.5) * hK;
      apply(dt, 2.4, 3.0, fx * 0.9, h, fz + d, fx, 0.9, fz);
      return;
    }
    if (m === 'goal') {
      const f = info && info.scorer ? info.scorer : k;
      const fx = clamp(f.x, -27, 27), fz = clamp(f.z, -9, 9);
      const side = Math.sign(fx) || 1;
      const push = sstep(0, 1.2, modeT);
      const d = (BASE_D - push * 12.5) * dK, h = (BASE_H - push * 9) * hK;
      apply(dt, 2.2, 2.8, fx - side * (1.5 + push * 2.5), h, fz + d, fx, 0.6 + push * 0.5, fz);
      return;
    }
    // play: follow puck x (and some z), lead in the direction of travel, zoom near the goals
    const lead = clamp((k.vx || 0) * 0.28, -4.5, 4.5);
    const fx = clamp((k.x || 0) + lead, -xClamp, xClamp);
    const fz = clamp((k.z || 0) * 0.38 + clamp((k.vz || 0) * 0.12, -1.5, 1.5), -3.6, 2.6);
    const near = sstep(14, 24, Math.abs(k.x || 0));
    const zoom = 1 - near * 0.1;
    const tx = fx * 0.8, ty = BASE_H * zoom * hK, tz = fz + BASE_D * zoom * dK;
    apply(dt, 3.0, 3.6, tx, ty, tz, fx, 0.0, fz + lookZ * zoom);
  }

  setAspect(16 / 9);
  return {
    update,
    setAspect,
    shake(amount) { trauma = Math.min(1, trauma + amount); },
    /** 0..1 multiplier on shake amplitude (ctx.video.cameraShake). */
    setShakeScale(s) { shakeScale = Math.max(0, Math.min(1, s)); },
    get mode() { return mode; },
    snap() { cx.v = cy.v = cz.v = lx.v = ly.v = lz.v = 0; },
  };
}
