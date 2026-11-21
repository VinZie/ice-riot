// ICE RIOT renderer - skater models.
//
// The six skaters are drawn with the rigged, animated player model (models/skater.glb: skinned
// body, skates and hair, helmet / gloves / stick on the bones, 13 clips; built in Múcaro by
// blenderremake/testingmcp/hockey/build-game.mjs with DETAIL=0.35). Every skater gets its own clone
// with team colours, a skin tone, a hair colour, a back number, spring-physics hair
// (render/hair-physics.js) and mirrored copies for the ice reflection. The snapshot picks and
// blends the clips (speed and turbo for skating, PSTATE for shots, checks, pokes, dekes, falls and
// celebrations, events for passes); the root follows the sim's position and facing and leans into
// turns. Goalies stay procedural (players.js), which also keeps drawing procedural skaters until
// the model has loaded, or for good if it can't be loaded.
//
//   const models = createSkaterModels(group, mirror, track, skinTones);
//   await models.load();                       // models.ready = true afterwards
//   models.tick(dt)                            // once per frame, then for each skater:
//   models.update(pv, p, ctx)                  // fills pv.hips / headW / bladeW
//   models.hide(id); models.setTeams(h, a); models.onEvent(type, e); models.setReflections(on)
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from '/vendor/addons/utils/SkeletonUtils.js';
import { PSTATE, PHASE, TEAMS } from '/shared/constants.js';
import { HairPhysics } from './hair-physics.js';
import { makeCanvas, canvasTex, FONT_COND, css } from './textures.js';

const MODEL_URL = '/models/skater.glb', PHYS_URL = '/models/skater.physics.json';
const FPS = 24;                                   // the clips' frame rate
const LOOPS = new Set(['idle', 'skate', 'sprint', 'faceoff', 'celebrate']);
const TEAM_MATS = new Set(['Primary', 'PrimaryGloss', 'Secondary', 'Accent']);
const PLAYER_MATS = new Set(['Skin', 'Lips', 'Hair', 'HairLight', 'Brow']);
const HAIR_COLORS = [0x2b1d14, 0x4a3424, 0x6f5034, 0x8a6a45, 0x1c1a19, 0xa8834f, 0x5a3a22, 0x3a2a1e];
const BACK_NUMBER = { y: 1.33, z: -0.141, size: 0.2 };   // jersey back at chest height (rest pose, metres)
const bone = (name) => THREE.PropertyBinding.sanitizeNodeName(name);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const _v = new THREE.Vector3(), _c = new THREE.Color();

export function createSkaterModels(group, mirror, track, skinTones) {
  let template = null, clips = null, physData = null;
  let teams = [0, 1], reflections = true, clock = 0;
  const rigs = new Map();                         // player id -> rig
  const api = { ready: false };

  api.load = async () => {
    const [gltf, phys] = await Promise.all([
      new GLTFLoader().loadAsync(MODEL_URL),
      fetch(PHYS_URL).then((r) => { if (!r.ok) throw new Error(`${PHYS_URL}: HTTP ${r.status}`); return r.json(); }),
    ]);
    template = gltf.scene;
    template.getObjectByName('Puck')?.removeFromParent();      // the game draws its own puck
    clips = {};
    for (const c of gltf.animations) {
      // Keep the body bones' rotation / translation: hair is physics-driven, the puck is the game's.
      c.tracks = c.tracks.filter((t) => {
        const node = t.name.slice(0, t.name.lastIndexOf('.'));
        return !node.startsWith('hair_') && node !== 'Puck' && !t.name.endsWith('.scale');
      });
      clips[c.name] = c;
    }
    physData = phys;
    api.ready = true;
  };

  const dur = (name) => clips[name].duration;

  function makeRig(id) {
    const root = new THREE.Group(), lean = new THREE.Group();
    const model = cloneSkinned(template);
    root.name = `skater${id}`;
    root.add(lean); lean.add(model); group.add(root);
    const bones = {};
    model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    // Per-player materials for team colours, skin and hair; everything else is shared.
    const mats = {};
    model.traverse((o) => {
      if (!o.isMesh) return;
      // thin strands and the clear visor add shadow-pass cost without a visible shadow
      o.castShadow = !/^(Hair|HairLight|Visor)/.test(o.name); o.receiveShadow = false; o.frustumCulled = false;
      const remap = (m) => (mats[m.name] ||= TEAM_MATS.has(m.name) || PLAYER_MATS.has(m.name) ? m.clone() : m);
      o.material = Array.isArray(o.material) ? o.material.map(remap) : remap(o.material);
    });
    // Bind pose: the back number and the blade point are measured in it, and the hair springs start from it.
    let skeleton = null;
    model.traverse((o) => { if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton; });
    skeleton?.pose();
    model.updateMatrixWorld(true);
    let hair = null;
    try { hair = new HairPhysics(model, physData); hair.params.substep = 1 / 60; } catch (e) { console.warn('skater hair physics off:', e); }
    model.updateMatrixWorld(true);
    // Blade point in the stick's own frame: the far end of the stick from the top hand. (The stick
    // has several materials, so it loads as a group with one mesh per material.)
    const stick = model.getObjectByName('Stick'), hand = bones[bone('hand.R')];
    const handW = hand.getWorldPosition(new THREE.Vector3());
    let maxD = 0;
    const pts = [];
    stick.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) { const p = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); const d = p.distanceTo(handW); pts.push([p, d]); if (d > maxD) maxD = d; }
    });
    const blade = new THREE.Vector3();
    let n = 0;
    for (const [p, d] of pts) if (d > maxD - 0.2) { blade.add(p); n++; }
    const bladeLocal = stick.worldToLocal(blade.multiplyScalar(1 / Math.max(1, n)));
    // Back number, riding the chest bone.
    const numCanvas = makeCanvas(128, 128), numTex = track(canvasTex(numCanvas));
    const numPlane = new THREE.Mesh(new THREE.PlaneGeometry(BACK_NUMBER.size, BACK_NUMBER.size),
      new THREE.MeshStandardMaterial({ map: numTex, transparent: true, roughness: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    numPlane.position.set(0, BACK_NUMBER.y, BACK_NUMBER.z);
    numPlane.rotation.y = Math.PI;
    model.add(numPlane);
    bones.chest.attach(numPlane);
    // Ice reflection: skinned copies share the skeleton (bound "detached" so the mirror's flip
    // applies); rigid parts copy their source's world matrix each frame.
    const mirrors = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      let m;
      if (o.isSkinnedMesh) { m = new THREE.SkinnedMesh(o.geometry, o.material); m.bindMode = 'detached'; m.bind(o.skeleton, new THREE.Matrix4()); }
      else { m = new THREE.Mesh(o.geometry, o.material); m.matrixAutoUpdate = false; }
      m.frustumCulled = false;
      mirror.add(m);
      mirrors.push({ src: o, m });
    });
    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    for (const [name, clip] of Object.entries(clips)) actions[name] = mixer.clipAction(clip);
    const r = {
      id, root, lean, model, bones, mats, hair, stick, bladeLocal, numPlane, numCanvas, numTex, mirrors, mixer, actions,
      cur: null, curName: '', lock: null, lastS: -1, lastST: 0, lastCh: 0, prevTb: 1, sprintT: 0, moving: false,
      passT: -1, shotKind: null, shotT: -1, roll: 0, teamKey: '', num: null, last: new THREE.Vector3(), inited: false,
    };
    rigs.set(id, r);
    paint(r);
    return r;
  }

  /** Team colours, skin tone, hair colour and back number for one rig. */
  function paint(r, num = r.num) {
    const team = TEAMS[teams[r.id < 4 ? 0 : 1]] || TEAMS[0];
    const key = `${teams[r.id < 4 ? 0 : 1]}|${num}`;
    if (r.teamKey === key) return;
    r.teamKey = key; r.num = num;
    const c = team.colors, M = r.mats;
    for (const nm of ['Primary', 'PrimaryGloss']) M[nm]?.color.setHex(c.primary);
    M.Secondary?.color.setHex(c.secondary);
    M.Accent?.color.setHex(c.accent);
    const skin = skinTones[(r.id * 5 + 3) % skinTones.length], hair = HAIR_COLORS[(r.id * 3 + 1) % HAIR_COLORS.length];
    M.Skin?.color.setHex(skin);
    M.Lips?.color.setHex(skin).lerp(_c.setHex(0xb0584f), 0.35);
    M.Hair?.color.setHex(hair);
    M.HairLight?.color.setHex(hair).lerp(_c.setHex(0xc9a073), 0.25);
    M.Brow?.color.setHex(hair).multiplyScalar(0.75);
    // back number: accent with a secondary outline
    const g = r.numCanvas.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    if (num != null) {
      g.font = `96px ${FONT_COND}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineJoin = 'round'; g.lineWidth = 12; g.strokeStyle = css(c.secondary); g.strokeText(String(num), 64, 70);
      g.fillStyle = css(c.accent); g.fillText(String(num), 64, 70);
    }
    r.numTex.needsUpdate = true;
  }

  // ---- clips -----------------------------------------------------------------------------------
  function play(r, name, { fade = 0.15, at = 0, scale = 1, restart = false } = {}) {
    const a = r.actions[name];
    if (!a) return;
    if (r.curName === name && !restart) { a.timeScale = scale; return; }
    const prev = r.cur;
    a.reset();
    a.setLoop(LOOPS.has(name) ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = true;
    a.time = at; a.timeScale = scale;
    a.play();
    if (prev && prev !== a) a.crossFadeFrom(prev, fade, false);
    r.cur = a; r.curName = name;
  }
  /** Hold a clip at time t (driven by the game state instead of the clock). */
  function scrub(r, name, t, fade = 0.12) {
    play(r, name, { fade, scale: 0 });
    r.actions[name].time = clamp(t, 0, dur(name));
  }
  const running = (r, name) => { const a = r.actions[name]; return a && a.isRunning() && a.time < dur(name) - 1e-3; };

  function animate(r, p, ph, faceoffTaker, dt) {
    const s = p.s | 0, sT = p.sT || 0, sp = Math.hypot(p.vx || 0, p.vz || 0);
    const fresh = s !== r.lastS || sT + 1e-3 < r.lastST;        // entered (or re-entered) this state
    const prevS = r.lastS, prevCh = r.lastCh;
    r.lastS = s; r.lastST = sT; r.lastCh = p.ch || 0;
    // turbo: the meter drains while it is held
    const tb = typeof p.tb === 'number' ? p.tb : 1;
    if (r.prevTb - tb > 0.002 || sp > 10.3) r.sprintT = 0.35; else r.sprintT -= dt;
    r.prevTb = tb;
    switch (s) {
      case PSTATE.DOWN:
        r.lock = null;
        if (sT < 0.9) scrub(r, 'knockdown', sT * 1.15);
        else scrub(r, 'get_up', (sT - 0.9) * 1.6);
        return;
      case PSTATE.CHARGE:
        r.lock = null;
        scrub(r, 'slapshot', (11 / FPS) * smooth(0, 0.35, p.ch || 0));       // wind-up follows the charge
        return;
      case PSTATE.SHOOT:
        if (fresh) {
          const kind = r.shotT > clock - 0.5 ? r.shotKind : prevS === PSTATE.CHARGE && prevCh > 0.05 ? 'slap' : 'wrist';
          if (kind === 'slap') {
            const from = r.curName === 'slapshot' ? r.actions.slapshot.time : 11 / FPS;
            play(r, 'slapshot', { at: from, scale: 1.35, fade: 0.05 }); r.actions.slapshot.timeScale = 1.35;
          } else if (kind === 'onetimer') play(r, 'slapshot', { at: 8 / FPS, scale: 1.8, restart: true, fade: 0.06 });
          else play(r, 'wrist_shot', { scale: 1.45, restart: true, fade: 0.06 });
          r.lock = r.curName;
        }
        return;
      case PSTATE.CHECK: if (fresh) { play(r, 'check', { scale: 1.1, restart: true, fade: 0.08 }); r.lock = 'check'; } return;
      case PSTATE.POKE: if (fresh) { play(r, 'poke', { scale: 1.45, restart: true, fade: 0.06 }); r.lock = 'poke'; } return;
      case PSTATE.DEKE: if (fresh) { play(r, 'deke', { scale: 1.5, restart: true, fade: 0.06 }); r.lock = 'deke'; } return;
      case PSTATE.CELEBRATE: r.lock = null; play(r, 'celebrate', { fade: 0.25 }); return;
      default: break;
    }
    // SKATE: let a one-shot finish, then passes, faceoffs, then skating by speed.
    if (r.lock && running(r, r.lock)) return;
    r.lock = null;
    if (r.passT > clock - 0.3) { r.passT = -1; play(r, 'pass', { scale: 1.35, restart: true, fade: 0.08 }); r.lock = 'pass'; return; }
    if (ph === PHASE.FACEOFF && faceoffTaker) { play(r, 'faceoff', { fade: 0.25 }); return; }
    r.moving = r.moving ? sp > 0.5 : sp > 0.9;
    const name = !r.moving ? 'idle' : r.sprintT > 0 ? 'sprint' : 'skate';
    const scale = name === 'idle' ? 1 : name === 'skate' ? clamp(0.5 + sp / 11, 0.6, 1.5) : clamp(0.55 + sp / 14, 0.7, 1.6);
    // skate <-> sprint keep their stride phase
    const at = r.cur && (r.curName === 'skate' || r.curName === 'sprint') && name !== 'idle' ? (r.cur.time / dur(r.curName)) * dur(name) : 0;
    play(r, name, { scale, at, fade: 0.22 });
  }

  // ---- per-frame ---------------------------------------------------------------------------------
  /** Pose skater `pv.id` from snapshot player `p`; writes pv.hips (position), pv.headW, pv.bladeW. */
  api.update = (pv, p, { dt, ph, faceoffTaker }) => {
    const r = rigs.get(pv.id) || makeRig(pv.id);
    if (p.n != null && p.n !== r.num) paint(r, p.n);
    animate(r, p, ph, faceoffTaker, dt);
    const sp = Math.hypot(p.vx || 0, p.vz || 0);
    r.root.visible = true;
    r.root.position.set(p.x, Math.max(0, p.y || 0), p.z);
    r.root.rotation.y = Math.PI / 2 - ((p.f || 0) + pv.spin);      // the model faces +Z; the sim's f is from +X
    r.roll += (clamp(pv.turn * sp * 0.035, -0.32, 0.32) - r.roll) * Math.min(1, dt * 8);
    r.lean.rotation.z = r.roll;
    r.mixer.update(dt);
    r.root.updateMatrixWorld(true);
    if (r.hair) {
      if (!r.inited || r.last.distanceTo(r.root.position) > 2.5) r.hair.reset();
      r.hair.update(dt);
    }
    r.last.copy(r.root.position);
    r.inited = true;
    for (const { src, m } of r.mirrors) { m.visible = reflections; if (!m.isSkinnedMesh) m.matrix.copy(src.matrixWorld); }
    r.bones.hips.getWorldPosition(_v);
    pv.hips.makeTranslation(_v.x, _v.y, _v.z);
    r.bones.head.getWorldPosition(pv.headW);
    pv.headW.y += 0.24;
    pv.bladeW.copy(r.bladeLocal).applyMatrix4(r.stick.matrixWorld);
  };

  /** Once per frame, before the skaters' update(). */
  api.tick = (dt) => { clock += dt; };

  api.hide = (id) => {
    const r = rigs.get(id);
    if (!r) return;
    r.root.visible = false;
    for (const { m } of r.mirrors) m.visible = false;
    r.inited = false;
  };
  api.hideAll = () => { for (const id of rigs.keys()) api.hide(id); };
  api.setTeams = (h, a) => { teams = [h, a]; for (const r of rigs.values()) paint(r); };
  api.setReflections = (on) => { reflections = !!on; };
  /** Snapshot events that pick clips: 'pass' {by}, 'shot' {by, kind}. */
  api.onEvent = (type, e) => {
    const r = e && rigs.get(e.by);
    if (!r) return;
    if (type === 'pass') r.passT = clock;
    if (type === 'shot') { r.shotKind = e.kind; r.shotT = clock; }
  };
  /** Stop using the models (after an error): hide them; players.js goes back to procedural skaters. */
  api.disable = () => { api.hideAll(); api.ready = false; };
  api.dispose = () => {
    for (const r of rigs.values()) { r.mixer.stopAllAction(); r.root.removeFromParent(); for (const { m } of r.mirrors) m.removeFromParent(); }
    rigs.clear();
  };
  return api;
}
