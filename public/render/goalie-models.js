// ICE RIOT renderer - goalie models.
//
// The two goalies are drawn with the rigged, animated goalie model (models/goalie.glb: skinned body,
// leg pads, catching glove on the left, blocker on the stick hand, mask, spring-physics hair, 15
// clips; built in Múcaro by blenderremake/testingmcp/hockey/build-goalie.mjs). It shares the
// skater's rig, bone names and team-colour material slots, so each goalie gets the same treatment as
// a skater in render/skater-models.js: its own clone with team colours, skin tone, hair colour, a back
// number, hair physics and mirrored copies for the ice reflection. The clips follow the goalie sim
// (shared/sim-goalie.js): ready stance, shuffles across the crease, a save picked from where the puck
// met him (butterfly, glove, blocker, pad stretch), covering a caught puck, outlet passes, poke checks,
// falls and celebrations. players.js keeps drawing procedural goalies until the model has loaded, or
// for good if it can't be loaded.
//
//   const goalies = createGoalieModels(group, mirror, track, skinTones);
//   await goalies.load();                       // goalies.ready = true afterwards
//   goalies.tick(dt)                            // once per frame, then for each goalie:
//   goalies.update(pv, p, { dt, k })            // fills pv.hips / headW / bladeW
//   goalies.hide(id); goalies.setTeams(h, a); goalies.onEvent(type, e); goalies.setReflections(on)
//   goalies.covering(id)                        // true while he holds the puck in his glove
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from '/vendor/addons/utils/SkeletonUtils.js';
import { PSTATE, TEAMS } from '/shared/constants.js';
import { HairPhysics } from './hair-physics.js';
import { makeCanvas, canvasTex, FONT_COND, css } from './textures.js';

const MODEL_URL = '/models/goalie.glb', PHYS_URL = '/models/goalie.physics.json';
const FPS = 24;                                   // the clips' frame rate
const LOOPS = new Set(['idle', 'shuffle_left', 'shuffle_right', 'skate', 'cover', 'celebrate']);
const SAVES = new Set(['butterfly', 'glove_save', 'blocker_save', 'stretch_left', 'stretch_right']);
const TEAM_MATS = new Set(['Primary', 'PrimaryGloss', 'Secondary', 'Accent']);
const PLAYER_MATS = new Set(['Skin', 'Lips', 'Hair', 'HairLight', 'Brow']);
const HAIR_COLORS = [0x2b1d14, 0x4a3424, 0x6f5034, 0x8a6a45, 0x1c1a19, 0xa8834f, 0x5a3a22, 0x3a2a1e];
const NUMBER_SIZE = 0.24;                         // back number, metres (a little bigger than a skater's)
const bone = (name) => THREE.PropertyBinding.sanitizeNodeName(name);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const _v = new THREE.Vector3(), _c = new THREE.Color();

export function createGoalieModels(group, mirror, track, skinTones) {
  let template = null, clips = null, physData = null, back = null;
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
    for (const name of ['idle', 'butterfly', 'cover', 'knockdown', 'get_up']) if (!clips[name]) throw new Error(`goalie.glb: no "${name}" clip`);
    physData = phys;
    back = measureBack(template);
    api.ready = true;
  };

  const dur = (name) => clips[name].duration;

  /** Where the back number goes: the back of the jersey at chest height, in the rest pose. */
  function measureBack(scene) {
    scene.updateMatrixWorld(true);
    let chestY = 1.3;
    scene.traverse((o) => { if (o.isBone && o.name === 'chest') chestY = o.getWorldPosition(_v).y; });
    const y = chestY - 0.02;
    let minZ = 0;
    const body = scene.getObjectByName('Body');
    body?.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (Math.abs(_v.x) < 0.07 && Math.abs(_v.y - y) < 0.06 && _v.z < minZ) minZ = _v.z;
      }
    });
    return { y, z: (minZ || -0.16) - 0.012 };
  }

  function makeRig(id) {
    const root = new THREE.Group();
    const model = cloneSkinned(template);
    root.name = `goalie${id}`;
    root.add(model); group.add(root);
    const bones = {};
    model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    // Per-goalie materials for team colours, skin and hair; everything else is shared.
    const mats = {};
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = !/^(Hair|HairLight)/.test(o.name); o.receiveShadow = false; o.frustumCulled = false;
      const remap = (m) => (mats[m.name] ||= TEAM_MATS.has(m.name) || PLAYER_MATS.has(m.name) ? m.clone() : m);
      o.material = Array.isArray(o.material) ? o.material.map(remap) : remap(o.material);
    });
    // Bind pose: the back number and the blade point are measured in it, and the hair springs start from it.
    let skeleton = null;
    model.traverse((o) => { if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton; });
    skeleton?.pose();
    model.updateMatrixWorld(true);
    let hair = null;
    try { hair = new HairPhysics(model, physData); hair.params.substep = 1 / 60; } catch (e) { console.warn('goalie hair physics off:', e); }
    model.updateMatrixWorld(true);
    // Blade point in the stick's own frame: the far end of the stick from the blocker hand.
    const stick = model.getObjectByName('Stick'), hand = bones[bone('hand.R')], glove = bones[bone('hand.L')];
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
    const numPlane = new THREE.Mesh(new THREE.PlaneGeometry(NUMBER_SIZE, NUMBER_SIZE),
      new THREE.MeshStandardMaterial({ map: numTex, transparent: true, roughness: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    numPlane.position.set(0, back.y, back.z);
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
      id, root, model, bones, mats, hair, stick, glove, bladeLocal, numPlane, numCanvas, numTex, mirrors, mixer, actions,
      cur: null, curName: '', lock: null, lastS: -1, lastST: 0, moving: false, holding: false,
      passT: -1, pokeT: -1, save: null, pk: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }, pkOk: false,
      teamKey: '', num: null, last: new THREE.Vector3(), inited: false,
    };
    rigs.set(id, r);
    paint(r);
    return r;
  }

  /** Team colours, skin tone, hair colour and back number for one rig. */
  function paint(r, num = r.num) {
    const ti = teams[r.id < 4 ? 0 : 1], team = TEAMS[ti] || TEAMS[0];
    if (num == null) num = team.goalie?.num ?? null;
    const key = `${ti}|${num}`;
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

  /**
   * Where the puck reaches the goalie: `lat` metres to his right (the blocker side; the catching
   * glove is on his left) and height `y`. The sim registers a save about a metre out and then moves
   * the puck (a caught one drops to the ice at his feet), so this projects last frame's puck along
   * its path to his body; without one it falls back to the save event's point and the puck now.
   */
  function contact(r, p, k) {
    const cf = Math.cos(p.f || 0), sf = Math.sin(p.f || 0);
    if (r.pkOk) {
      const q = r.pk, dx = q.x - p.x, dz = q.z - p.z;
      const along = dx * cf + dz * sf, va = q.vx * cf + q.vz * sf;
      const t = va < -1 ? clamp(along / -va, 0, 0.4) : 0;
      return { lat: -dx * sf + dz * cf + (-q.vx * sf + q.vz * cf) * t, y: Math.max(0, q.y + q.vy * t - 4.9 * t * t) };
    }
    const e = r.save && r.save.t > clock - 0.5 ? r.save : null;
    const px = e ? e.x : k ? k.x : p.x, pz = e ? e.z : k ? k.z : p.z;
    return { lat: -(px - p.x) * sf + (pz - p.z) * cf, y: k ? Math.max(0, k.y || 0) : 0 };
  }

  /** The save clip for a puck reaching him at (lat, y); `caught`: he ends up holding it. */
  function pickSave(lat, y, caught) {
    if (y >= 0.4 && (Math.abs(lat) > 0.12 || y > 0.85)) return caught || lat < 0.12 ? 'glove_save' : 'blocker_save';
    if (!caught && y < 0.4 && Math.abs(lat) > 0.3) return lat < 0 ? 'stretch_left' : 'stretch_right';
    return 'butterfly';
  }

  function animate(r, p, k) {
    const s = p.s | 0, sT = p.sT || 0;
    const fresh = s !== r.lastS || sT + 1e-3 < r.lastST;        // entered (or re-entered) this state
    r.lastS = s; r.lastST = sT;
    const f = p.f || 0, cf = Math.cos(f), sf = Math.sin(f);
    const vx = p.vx || 0, vz = p.vz || 0;
    const holding = !!k && k.o === p.id;
    switch (s) {
      case PSTATE.DOWN:
        r.lock = null;
        if (sT < 0.9) scrub(r, 'knockdown', sT * 1.15);
        else scrub(r, 'get_up', (sT - 0.9) * 1.6);
        return;
      case PSTATE.CELEBRATE: r.lock = null; play(r, 'celebrate', { fade: 0.25 }); return;
      case PSTATE.SAVE:
        if (fresh) {
          const { lat, y } = contact(r, p, k);
          const name = pickSave(lat, y, holding);
          r.save = null;
          play(r, name, { at: 3 / FPS, scale: 1.35, restart: true, fade: 0.06 });
          r.lock = name;
        }
        return;
      default: break;
    }
    // SKATE: pokes and outlet passes first, then let a one-shot finish, then cover / stance / shuffles.
    if (r.pokeT > clock - 0.3) { r.pokeT = -1; play(r, 'poke', { scale: 1.5, restart: true, fade: 0.06 }); r.lock = 'poke'; return; }
    if (r.passT > clock - 0.3) { r.passT = -1; play(r, 'pass', { scale: 1.3, restart: true, fade: 0.08 }); r.lock = 'pass'; return; }
    // a caught puck goes to the chest as soon as the save is past its contact frame
    const catchNow = holding && SAVES.has(r.lock) && r.cur && r.cur.time > 9 / FPS;
    if (r.lock && running(r, r.lock) && !catchNow) return;
    r.lock = null;
    if (holding) { play(r, 'cover', { fade: 0.2 }); return; }
    const sp = Math.hypot(vx, vz);
    r.moving = r.moving ? sp > 0.35 : sp > 0.7;
    if (!r.moving) { play(r, 'idle', { fade: 0.3 }); return; }
    const fwdV = vx * cf + vz * sf, latV = -vx * sf + vz * cf;   // latV > 0: toward his right (blocker side)
    const shuffling = r.curName === 'shuffle_left' || r.curName === 'shuffle_right';
    if (Math.abs(latV) > Math.abs(fwdV) * (shuffling ? 0.5 : 0.9)) {
      play(r, latV > 0 ? 'shuffle_right' : 'shuffle_left', { scale: clamp(0.55 + Math.abs(latV) / 2.6, 0.6, 1.7), fade: 0.18 });
    } else {
      play(r, 'skate', { scale: clamp(0.5 + sp / 5, 0.6, 1.5), fade: 0.22 });
    }
  }

  // ---- per-frame ---------------------------------------------------------------------------------
  /** Pose goalie `pv.id` from snapshot player `p` (k = the snapshot puck); writes pv.hips, pv.headW, pv.bladeW. */
  api.update = (pv, p, { dt, k }) => {
    const r = rigs.get(pv.id) || makeRig(pv.id);
    if (p.n != null && p.n !== r.num) paint(r, p.n);
    animate(r, p, k);
    r.holding = !!k && k.o === p.id;                               // caught: in the glove from the save on
    // this frame's puck, for the next frame's save contact
    r.pkOk = !!k;
    if (k) { const q = r.pk; q.x = k.x; q.y = Math.max(0, k.y || 0); q.z = k.z; q.vx = k.vx || 0; q.vy = k.vy || 0; q.vz = k.vz || 0; }
    r.root.visible = true;
    r.root.position.set(p.x, Math.max(0, p.y || 0), p.z);
    r.root.rotation.y = Math.PI / 2 - (p.f || 0);                  // the model faces +Z; the sim's f is from +X
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
    pv.headW.y += 0.26;
    pv.bladeW.copy(r.bladeLocal).applyMatrix4(r.stick.matrixWorld);
  };

  /** Once per frame, before the goalies' update(). */
  api.tick = (dt) => { clock += dt; };

  api.hide = (id) => {
    const r = rigs.get(id);
    if (!r) return;
    r.root.visible = false;
    for (const { m } of r.mirrors) m.visible = false;
    r.inited = false; r.holding = false; r.pkOk = false;
  };
  api.hideAll = () => { for (const id of rigs.keys()) api.hide(id); };
  /** Skip drawing goalie `id` this frame only (a camera inside him); the next update() shows him again. */
  api.cull = (id) => { const r = rigs.get(id); if (r) r.root.visible = false; };
  api.setTeams = (h, a) => { teams = [h, a]; for (const r of rigs.values()) paint(r, null); };
  api.setReflections = (on) => { reflections = !!on; };
  /** True while goalie `id` has the puck clutched in his glove (the renderer hides the puck). */
  api.covering = (id) => { const r = rigs.get(id); return !!(r && r.holding && r.root.visible); };
  /** Snapshot events that pick clips: 'save' {goalie, x, z}, 'pass' {by}, 'steal' {by}. */
  api.onEvent = (type, e) => {
    if (!e) return;
    if (type === 'save') { const r = rigs.get(e.goalie); if (r && Number.isFinite(e.x) && Number.isFinite(e.z)) r.save = { x: e.x, z: e.z, t: clock }; return; }
    const r = rigs.get(e.by);
    if (!r) return;
    if (type === 'pass') r.passT = clock;
    if (type === 'steal') r.pokeT = clock;
  };
  /** Stop using the models (after an error): hide them; players.js goes back to procedural goalies. */
  api.disable = () => { api.hideAll(); api.ready = false; };
  api.dispose = () => {
    for (const r of rigs.values()) { r.mixer.stopAllAction(); r.root.removeFromParent(); for (const { m } of r.mirrors) m.removeFromParent(); }
    rigs.clear();
  };
  return api;
}
