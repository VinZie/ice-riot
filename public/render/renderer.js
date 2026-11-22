// ICE RIOT renderer - public entry point (see docs/CONTRACT.md "Client module APIs").
//
//   const r = createRenderer(canvas);
//   r.setTeams([h, a]);                     // TEAMS indices, home = team 0
//   r.update(state | null, dt, events, ctx) // ctx = { myId, names: {clientId: name}, couchIds?, showNames?, video? }
//   r.render();                             // scene, then the head indicators (render/head-tags.js)
//   r.resize(cssWidth, cssHeight);
//   r.dispose();
//
// update(null, ...) = attract mode (empty lit rink, slow orbit).
//
// Inset mode (picture-in-picture): createRenderer(null, { shareWith: mainRenderer.three.renderer })
// builds a second, independent scene that draws into a corner of the main canvas through the same
// WebGL context: setInset({ x, y, w, h }) (CSS px, origin bottom-left) places it, render() draws it
// after the main frame (no head plates or puck marker), resize() only follows the inset's aspect and
// dispose() leaves the shared context alone. Used for the glass-smash replays (extras.js).
import * as THREE from 'three';
import { TEAMS, PHASE, EVENT, PSTATE } from '/shared/constants.js';
import { createRink } from './rink.js';
import { createArena, buildEnvironment } from './arena.js';
import { createPlayers } from './players.js';
import { createEffects } from './effects.js';
import { createCameraRig } from './camera.js';
import { createPuckMarker } from './puck-marker.js';

const KNOWN = new Set(Object.values(EVENT));
const TYPE_KEYS = ['type', 't', 'e', 'ev', 'name', 'kind'];
function evType(e) {
  if (!e) return null;
  for (const k of TYPE_KEYS) { const v = e[k]; if (typeof v === 'string' && KNOWN.has(v)) return v; }
  return null;
}
const EMPTY_CTX = { myId: 0, names: {} };
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createRenderer(canvas, opts = {}) {
  const dbg = opts.debug || {};
  const inset = !!opts.shareWith;
  const renderer = inset ? opts.shareWith : new THREE.WebGLRenderer({
    canvas, antialias: !dbg.noAA, powerPreference: 'high-performance',
    preserveDrawingBuffer: !!opts.preserveDrawingBuffer, stencil: false,
  });
  if (!inset) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
  const insetRect = { x: 0, y: 0, w: 0, h: 0 };          // inset mode: where it draws (CSS px, bottom-left origin)
  const _full = new THREE.Vector4();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04060b);
  scene.fog = new THREE.Fog(0x04060b, 62, 150);
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.3, 400);
  scene.add(camera);

  const textures = [];
  const track = (t) => { textures.push(t); return t; };
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const envRT = buildEnvironment(renderer);
  scene.environment = envRT.texture;

  // lights: cool sky/ice bounce, one shadow-casting key tightly fit to the rink, camera-side fill
  const hemi = new THREE.HemisphereLight(0xe4ecff, 0x7c8aa0, 0.95);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff8f0, 2.3);
  key.position.set(0, 32, 9);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 1024);
  const sc = key.shadow.camera;
  sc.up.set(0, 0, -1);
  sc.left = -31.5; sc.right = 31.5; sc.top = 14.8; sc.bottom = -14.8; sc.near = 18; sc.far = 46;
  sc.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.025;
  scene.add(key, key.target);
  // (no separate camera-side fill light: folded into the hemisphere light, ~1 ms cheaper on a weak iGPU)

  // ice reflection: mirrored copies of players / puck / boards / goal frames (scale y = -1)
  const mirror = new THREE.Group();
  mirror.scale.y = -1;
  mirror.name = 'reflection';
  scene.add(mirror);

  const rink = createRink(scene, mirror, aniso, track);
  const arena = createArena(scene, aniso, track);
  const fx = createEffects(scene, mirror, track);
  const players = createPlayers(scene, mirror, fx, track);
  const rig = createCameraRig(camera);
  const marker = createPuckMarker();
  if (dbg.noReflect) mirror.visible = false;
  if (dbg.noCrowd) arena.crowd.visible = false;
  if (dbg.noGlass) for (const m of rink.panelMeshes) m.visible = false;

  let teams = [0, 1];
  let time = 0;
  let wasNull = true;
  let lastGoalT = -99, scorerId = -1;
  const scorerPos = { x: 0, z: 0 };
  const puckOff = { x: 0, z: 0 };
  // a carried puck sits just in front of the blade (along the carrier's facing), not centred on it
  const PUCK_SEAT = fx.puckRadius + 0.035;
  const _v2 = new THREE.Vector2();

  const reqTeams = [0, 1]; // last requested (raw) indices, so invalid values don't re-trigger every frame
  function setTeams(t) {
    const h = Array.isArray(t) ? t[0] : 0, a = Array.isArray(t) ? t[1] : 1;
    reqTeams[0] = h; reqTeams[1] = a;
    teams = [TEAMS[h] ? h : 0, TEAMS[a] ? a : 1];
    players.setTeams(teams[0], teams[1]);
    arena.setTeams(teams[0], teams[1]);
  }
  setTeams([0, 1]);

  function playerOf(state, id) {
    if (!state || !state.p || id == null || id < 0) return null;
    return state.p[id] || null;
  }

  function handleEvent(e, state) {
    const ty = evType(e);
    if (!ty) return;
    const k = (state && state.k) || null;
    switch (ty) {
      case EVENT.GOAL: {
        const side = e.x != null && e.x !== 0 ? Math.sign(e.x) : (e.team === 1 ? -1 : 1);
        rink.goalLight(side);
        rink.rippleNet(side, num(e.z, k ? k.z : 0), k ? num(k.y, 0.4) : 0.4);
        arena.cheer(e.team, 1);
        arena.hype(0.6);
        const tm = TEAMS[teams[e.team === 1 ? 1 : 0]] || TEAMS[0];
        const ca = [((tm.colors.primary >> 16) & 255) / 255, ((tm.colors.primary >> 8) & 255) / 255, (tm.colors.primary & 255) / 255];
        const cb = [((tm.colors.accent >> 16) & 255) / 255, ((tm.colors.accent >> 8) & 255) / 255, (tm.colors.accent & 255) / 255];
        fx.goalBurst(side * 26.9, 0, ca, cb);
        rig.shake(0.35);
        fx.setFlash(0.25, 1, 0.35, 0.25);
        scorerId = e.scorer ?? -1;
        lastGoalT = time;
        break;
      }
      case EVENT.PASS:
        players.onEvent('pass', e);
        break;
      case EVENT.SHOT: {
        players.onEvent('shot', e);
        const p = playerOf(state, e.by);
        if (p && (p.fire === 1 || p.fire === true)) fx.puckFire();
        const pw = num(e.power, 0.5);
        if (e.kind === 'slap' || e.kind === 'onetimer' || pw > 0.75) {
          rig.shake(0.08 + pw * 0.1);
          const b = players.bladeOf(e.by);
          if (b) { fx.iceSpray(b.x, b.z, 0, 0, 14); fx.sparks(b.x, 0.1, b.z, 6, 3); }
        }
        break;
      }
      case EVENT.HIT: {
        const pw = Math.max(0, Math.min(1, num(e.power, 0.5)));
        const big = !!e.big;
        let x = e.x, z = e.z;
        if (x == null) { const t = playerOf(state, e.target); if (t) { x = t.x; z = t.z; } }
        if (x == null) break;
        fx.hit(x, z, pw, big);
        rig.shake(big ? 0.5 + 0.45 * pw : 0.12 + 0.2 * pw);
        if (big) { fx.setFlash(0.12 + 0.18 * pw); arena.hype(0.6 + pw * 0.4); }
        else arena.hype(0.15);
        break;
      }
      case EVENT.GLASS: {
        const i = num(e.panel, -1) | 0;
        rink.breakPanel(i, time);
        fx.shatter(i);
        rig.shake(0.6);
        fx.setFlash(0.3, 0.85, 0.95, 1);
        arena.hype(1.2);
        break;
      }
      case EVENT.POST: {
        const x = num(e.x, k ? k.x : 0), z = num(e.z, k ? k.z : 0);
        fx.sparks(x, Math.max(0.3, k ? num(k.y, 0.5) : 0.5), z, 22, 5);
        rig.shake(0.14);
        arena.hype(0.25);
        break;
      }
      case EVENT.BOARDS: {
        const pw = num(e.power, 0.5);
        if (pw > 0.25 && e.x != null) { fx.sparks(e.x, 0.15, e.z, Math.round(3 + pw * 8), 3); fx.iceSpray(e.x, e.z, 0, 0, 4 + pw * 6); }
        break;
      }
      case EVENT.SAVE: {
        players.onEvent('save', e);
        const x = num(e.x, k ? k.x : 0), z = num(e.z, k ? k.z : 0);
        fx.iceSpray(x, z, 0, 0, 16);
        arena.hype(0.2);
        break;
      }
      case EVENT.STEAL: case EVENT.DEKE: {
        if (ty === EVENT.STEAL) players.onEvent('steal', e);
        const p = playerOf(state, e.by);
        if (p) fx.iceSpray(p.x, p.z, num(p.vx) * 0.5, num(p.vz) * 0.5, 10);
        break;
      }
      case EVENT.FACEOFF:
        fx.iceSpray(num(e.x), num(e.z), 0, 0, 12);
        fx.resetTrail(num(e.x), 0.05, num(e.z));
        break;
      case EVENT.FIRE: {
        if (e.on) {
          const p = playerOf(state, e.player);
          if (p) for (let i = 0; i < 40; i++) fx.flame(p.x + (Math.random() - 0.5) * 0.8, 0.2 + Math.random() * 1.6, p.z + (Math.random() - 0.5) * 0.8, 0, 0, 0.6);
          arena.hype(0.5);
        }
        break;
      }
      case EVENT.FINAL: {
        const s = e.score || (state && state.sc) || [0, 0];
        if (s[0] !== s[1]) arena.cheer(s[0] > s[1] ? 0 : 1, 1.2);
        arena.hype(0.8);
        break;
      }
      case EVENT.PERIOD_END:
        arena.hype(0.4);
        break;
      default: break;
    }
  }

  // ctx.video = { quality, cameraShake, reduceFlashes } (all optional); applied only when a value changes
  const vid = { q: null, shake: -1, rf: null };
  function applyVideo(v) {
    const q = v && typeof v.quality === 'string' ? v.quality : 'auto';
    const shake = v && typeof v.cameraShake === 'number' && Number.isFinite(v.cameraShake) ? v.cameraShake : 1;
    const rf = !!(v && v.reduceFlashes);
    if (q !== vid.q) { vid.q = q; setQuality(q); }
    if (shake !== vid.shake) { vid.shake = shake; rig.setShakeScale(shake); }
    if (rf !== vid.rf) {
      vid.rf = rf;
      fx.setFlashScale(rf ? 0 : 1);
      rink.setReduceFlashes(rf);
      arena.setReduceFlashes(rf);
    }
  }
  const camInfo = { scorer: null, fight: null, replay: null, glass: null, follow: null };
  const fightPos = { x: 0, z: 0 };
  const followPos = { x: 0, z: 0, vx: 0, vz: 0 };
  /** The skater client `myId` controls (human client ids are > 0; 0 = AI), or null. */
  function controlledBy(state, myId) {
    if (!state || !Array.isArray(state.p) || !(typeof myId === 'number' && myId > 0)) return null;
    for (const p of state.p) if (p && p.c === myId) return p;
    return null;
  }
  // instant replay: ctx.replay = { cam: 'cast' | 'net' | 'puck', goal: {x, z} | null,
  // glass?: {x, z, w} | null } picks the shot; glass pulls the broadcast camera onto a breaking panel
  const REPLAY_CAST = { cam: 'cast', goal: null, glass: null };

  function update(state, dt, events, ctx) {
    dt = num(dt, 1 / 60);
    dt = dt < 0 ? 0 : dt > 0.1 ? 0.1 : dt;
    time += dt;
    ctx = ctx || EMPTY_CTX;
    applyVideo(ctx.video);
    if (state && Array.isArray(state.teams) && (state.teams[0] !== reqTeams[0] || state.teams[1] !== reqTeams[1])) setTeams(state.teams);
    if (events && events.length) for (let i = 0; i < events.length; i++) handleEvent(events[i], state);

    if (!state) {
      if (!wasNull) {
        players.hideAll();
        fx.updatePuck(null, 0, 0, dt, false, false);
        players.setPuckShadow(0, 0, 0, false);
        wasNull = true;
      }
      rink.syncGlass(null, time);
      arena.setJumbo(teams, [0, 0], 1, 'attract');
      arena.update(dt, time, { wave: true, beams: 0.55 });
      rig.update(null, dt, null);
      marker.update(dt, false);
    } else {
      wasNull = false;
      const ph = state.ph;
      players.update(state, dt, ctx, time);
      // puck (rides the blade wiggle when carried)
      const k = state.k;
      let puckShown = false, prx = 0, prz = 0;
      if (k) {
        let ox = 0, oz = 0;
        const owned = k.o != null && k.o >= 0;
        if (owned) {
          const b = players.bladeOf(k.o), op = playerOf(state, k.o);
          if (b && Math.hypot(b.x - k.x, b.z - k.z) < 0.9) {
            const f = op ? num(op.f) : 0;
            ox = b.x + Math.cos(f) * PUCK_SEAT - k.x; oz = b.z + Math.sin(f) * PUCK_SEAT - k.z;
          }
        }
        const a = 1 - Math.exp(-(owned ? 30 : 12) * dt);
        puckOff.x += (ox - puckOff.x) * a; puckOff.z += (oz - puckOff.z) * a;
        const rx = num(k.x) + puckOff.x, rz = num(k.z) + puckOff.z;
        const shown = !(owned && players.covering(k.o));      // a goalie's covered puck is in his glove
        fx.updatePuck(k, rx, rz, dt, shown, owned);
        players.setPuckShadow(rx, rz, Math.max(0, num(k.y)), shown);
        puckShown = shown; prx = rx; prz = rz;
      } else {
        fx.updatePuck(null, 0, 0, dt, false, false);
        players.setPuckShadow(0, 0, 0, false);
      }
      rink.syncGlass(state.gl, time);
      // late join into a GOAL phase: still light it up
      if (ph === PHASE.GOAL && time - lastGoalT > 5 && k) { rink.goalLight(Math.sign(k.x) || 1, Math.max(0.5, num(state.phT, 2))); lastGoalT = time; }
      const scoreArr = Array.isArray(state.sc) ? state.sc : [0, 0];
      arena.setJumbo(teams, scoreArr, num(state.per, 1), ph === PHASE.GOAL ? 'goal' : ph === PHASE.GAME_OVER ? 'final' : 'score');
      let goalColor = null;
      if (ph === PHASE.GOAL) {
        const sp = playerOf(state, scorerId);
        const team = sp ? sp.tm : (k && k.x < 0 ? 1 : 0);
        goalColor = (TEAMS[teams[team === 1 ? 1 : 0]] || TEAMS[0]).colors.primary;
      }
      arena.update(dt, time, { wave: ph === PHASE.GAME_OVER || ph === PHASE.PERIOD_END, beams: ph === PHASE.GOAL ? 1 : ph === PHASE.GAME_OVER ? 0.7 : 0, goalTeamColor: goalColor, phase: ph, fight: !!state.fi });
      // camera: in GOAL push toward the scorer; during a fight (state.fi) push toward the two fighters
      camInfo.scorer = null; camInfo.fight = null;
      if (ph === PHASE.GOAL) {
        let sp = playerOf(state, scorerId);
        if (!sp && state.p) for (const p of state.p) if (p && p.s === PSTATE.CELEBRATE) { sp = p; break; }
        if (sp) { scorerPos.x = sp.x; scorerPos.z = sp.z; camInfo.scorer = scorerPos; }
      }
      const fi = state.fi;
      if (fi && typeof fi === 'object') {
        const a = playerOf(state, fi.a), b = playerOf(state, fi.b);
        if (a && b) { fightPos.x = (num(a.x) + num(b.x)) / 2; fightPos.z = (num(a.z) + num(b.z)) / 2; camInfo.fight = fightPos; }
      }
      camInfo.replay = null; camInfo.glass = null;
      if (state.replay) {
        camInfo.replay = ctx.replay && typeof ctx.replay === 'object' ? ctx.replay : REPLAY_CAST;
        const g = camInfo.replay.glass;
        if (g && num(g.w) > 0) camInfo.glass = g;
      }
      // live play: the camera follows the skater you control (it changes when you switch players);
      // without one (spectating, attract) it follows the puck. Replays always follow the puck.
      camInfo.follow = null;
      const me = state.replay ? null : controlledBy(state, ctx.myId);
      if (me) {
        followPos.x = num(me.x); followPos.z = num(me.z); followPos.vx = num(me.vx); followPos.vz = num(me.vz);
        camInfo.follow = followPos;
      }
      rig.update(state, dt, camInfo);
      // puck indicator while the camera follows a skater: chevron over the puck, edge arrow off screen
      const live = !state.replay && !state.fi && (ph === PHASE.PLAY || ph === PHASE.FACEOFF);
      marker.update(dt, live && !!me && puckShown, prx, k ? num(k.y) : 0, prz, !!me && !!k && k.o === me.id);
      // the puck cam flies through whoever the puck passes: don't draw players right at the lens
      if (rig.mode === 'puck') players.cullNear(camera.position.x, camera.position.z, 1.0);
    }
    // a tall (portrait) screen's high camera looks down through the hanging scoreboard: hide it then
    const jumboOn = !rig.overJumbo;
    if (arena.jumbo.visible !== jumboOn) arena.jumbo.visible = jumboOn;
    rink.update(dt, time);
    fx.update(dt);
  }

  // Dynamic resolution safety net: if frames are consistently slow (>19 ms avg over 60 frames, twice in a
  // row) lower the pixel ratio a notch; raise it again when there is headroom. Effective ratio stays >= 0.75.
  // Disable with createRenderer(canvas, { dynamicResolution: false }).
  const dyn = { on: opts.dynamicResolution !== false, last: 0, acc: 0, n: 0, slow: 0, fast: 0, scale: 1, shadowOff: false, mirrorOff: false };
  let quality = '', prCap = 2;
  const basePR = () => Math.min(window.devicePixelRatio || 1, prCap);
  function applyPR() { if (!inset) renderer.setPixelRatio(basePR() * dyn.scale); }
  function setShadows(on) {
    if (dbg.noShadow) on = false;
    if (key.castShadow !== on) key.castShadow = on; // toggling rebuilds lit shaders once
    players.setBlobOpacity(on ? 0.55 : 0.78);
  }
  /**
   * ctx.video.quality: 'high' = DPR<=2 + shadows; 'medium' = DPR<=1.5 + shadows; 'low' = DPR 1, no shadows,
   * no skater reflections, half particles + crowd; 'auto' (default) = DPR<=2 + shadows with the adaptive
   * fallback below.
   */
  function setQuality(q) {
    if (q !== 'high' && q !== 'medium' && q !== 'low') q = 'auto';
    if (q === quality) return;
    quality = q;
    prCap = q === 'medium' ? 1.5 : q === 'low' ? 1 : 2;
    dyn.on = q === 'auto' && opts.dynamicResolution !== false && !inset;
    dyn.acc = 0; dyn.n = 0; dyn.slow = 0; dyn.fast = 0; dyn.last = 0;
    if (q !== 'auto') dyn.scale = 1;
    setShadows(q === 'low' ? false : q === 'auto' ? !dyn.shadowOff : true);
    fx.setDensity(q === 'low' ? 0.5 : 1);
    arena.setCrowdDensity(q === 'low' ? 0.5 : 1);
    players.setQuality(q === 'auto' && dyn.mirrorOff ? 'low' : q);
    applyPR();
  }
  function tickDyn() {
    const now = performance.now();
    if (dyn.last) { const d = now - dyn.last; if (d < 100) { dyn.acc += d; dyn.n++; } }
    dyn.last = now;
    if (dyn.n < 60) return;
    const avg = dyn.acc / dyn.n;
    dyn.acc = 0; dyn.n = 0;
    const minScale = Math.max(0.5, 0.75 / basePR());
    if (avg > 20) {
      dyn.fast = 0;
      if (++dyn.slow >= 2) {
        dyn.slow = 0;
        // tier 1: drop the shadow map (one-time shader rebuild), blob shadows carry the grounding
        if (key.castShadow) { dyn.shadowOff = true; setShadows(false); }
        // tier 2: drop the skater models' ice reflections (a second skinned pass)
        else if (!dyn.mirrorOff && players.modelsReady) { dyn.mirrorOff = true; players.setQuality('low'); }
        else if (dyn.scale > minScale) { dyn.scale = Math.max(minScale, dyn.scale - 0.15); applyPR(); }
      }
    } else if (avg < 15) {
      dyn.slow = 0;
      if (++dyn.fast >= 4 && dyn.scale < 1) { dyn.scale = Math.min(1, dyn.scale + 0.1); applyPR(); dyn.fast = 0; }
    } else { dyn.slow = 0; dyn.fast = 0; }
  }

  function render() {
    if (inset) { renderInset(); return; }
    if (dyn.on) tickDyn();
    renderer.getDrawingBufferSize(_v2);
    fx.setPointScale(_v2.y / (2 * Math.tan(camera.fov * Math.PI / 360)));
    renderer.render(scene, camera);
    // head indicators: screen-space plates, projected with the camera this frame was drawn with
    // (their pass adds to this frame's renderer.info instead of resetting it)
    players.renderTags(renderer, camera);
    marker.render(renderer, camera);
  }

  // inset mode: draw into insetRect only (scissored, so the main frame around it is untouched)
  function renderInset() {
    const r = insetRect;
    if (!(r.w >= 2 && r.h >= 2)) return;
    renderer.getViewport(_full);                   // (CSS px) restored afterwards
    const pr = renderer.getPixelRatio();
    fx.setPointScale((r.h * pr) / (2 * Math.tan(camera.fov * Math.PI / 360)));
    renderer.setViewport(r.x, r.y, r.w, r.h);
    renderer.setScissor(r.x, r.y, r.w, r.h);
    renderer.setScissorTest(true);
    const ar = renderer.info.autoReset;
    renderer.info.autoReset = false;               // count into the frame's draw stats
    renderer.render(scene, camera);
    renderer.info.autoReset = ar;
    renderer.setScissorTest(false);
    renderer.setViewport(_full);
  }
  /** Inset mode: where to draw, in CSS px with the origin at the bottom-left of the canvas. */
  function setInset(rect) {
    const w = Math.max(0, Math.floor(num(rect && rect.w))), h = Math.max(0, Math.floor(num(rect && rect.h)));
    insetRect.x = Math.floor(num(rect && rect.x)); insetRect.y = Math.floor(num(rect && rect.y));
    if (w !== insetRect.w || h !== insetRect.h) { insetRect.w = w; insetRect.h = h; if (w > 0 && h > 0) rig.setAspect(w / h); }
  }

  function resize(w, h) {
    if (inset) return;                             // follows setInset() instead
    w = Math.max(1, Math.floor(num(w, canvas.clientWidth || 1280)));
    h = Math.max(1, Math.floor(num(h, canvas.clientHeight || 720)));
    renderer.setPixelRatio(basePR() * dyn.scale);
    renderer.setSize(w, h, true);
    rig.setAspect(w / h);
  }
  setQuality(inset ? 'low' : 'auto');
  if (!inset) resize(canvas.clientWidth || window.innerWidth || 1280, canvas.clientHeight || window.innerHeight || 720);

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    const mats = new Set(), geos = new Set();
    scene.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
    });
    for (const g of geos) g.dispose();
    for (const m of mats) {
      for (const key2 of ['map', 'alphaMap', 'emissiveMap', 'normalMap']) if (m[key2] && m[key2].dispose) m[key2].dispose();
      m.dispose();
    }
    for (const t of textures) t.dispose();
    players.dispose();
    marker.dispose();
    envRT.dispose();
    if (key.shadow.map) key.shadow.map.dispose();
    if (!inset) renderer.dispose();                // an inset leaves the shared context alone
  }

  return {
    setTeams, update, render, resize, dispose, setInset,
    /** Compile this scene's shaders now (an inset warms up before its first showing). */
    warm() { try { renderer.compile(scene, camera); } catch { /* optional */ } },
    // debug helpers (not part of the contract)
    info: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs ? renderer.info.programs.length : 0, ...fx.stats(), ...players.tagStats(), crowd: arena.crowdCount }),
    three: { renderer, scene, camera },
  };
}
