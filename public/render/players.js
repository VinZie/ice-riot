// ICE RIOT renderer - players. Chunky low-poly skaters + goalies built from primitives.
// Every body segment of every player is one instance of a per-segment InstancedMesh whose
// vertices carry a palette "slot" (primary / secondary / accent / skin / fixed). Team colors are
// per-instance attributes, so all 8 players draw in ~17 calls (plus the same again for the ice
// reflection, which shares the instance buffers). Arms + legs are solved with 2-bone IK every frame.
import * as THREE from 'three';
import { TEAMS, PSTATE, PHASE } from '/shared/constants.js';
import { PartBuilder, lin, smoothstep, clamp01 } from './util.js';
import { makeCanvas, canvasTex, drawNumberAtlas, makeNameTag, makeRingTexture, makeRadialTexture, makeToughIcon } from './textures.js';
import { FIGHT_TRIGGER } from '/shared/fight.js';

// "Tough guys" (checking >= this) are the only skaters who can start a fight; they get a fist badge.
const TOUGH_CHK = (FIGHT_TRIGGER && FIGHT_TRIGGER.minChk) || 6;

const K = 0, P = 1, S = 2, A = 3, SKIN = 4;

// pose parameter layout (blended frame-to-frame)
const HIP = 0, BP = 1, BR = 2, BDX = 3, BDY = 4, BDZ = 5, LEAN = 6, TWIST = 7, SIDE = 8,
  BX = 9, BY = 10, BZ = 11, HX = 12, HY = 13, HZ = 14, STANCE = 15, STRIDE = 16,
  FREE = 17, LX = 18, LY = 19, LZ = 20, RFREE = 21, RX = 22, RY = 23, RZ = 24,
  FOOTX = 25, FOOTY = 26, KNEEOUT = 27, KNEEDN = 28, HANDLE = 29, HOP = 30, PUMP = 31, NP = 32;

const DIM_S = { ua: 0.30, la: 0.31, th: 0.45, sh: 0.45, ankle: 0.19, hipW: 0.12, shY: 0.47, shZ: 0.25, spineY: 0.10, grip1: 1.27, grip2: 0.86, headY: 0.69 };
const DIM_G = { ua: 0.31, la: 0.31, th: 0.45, sh: 0.45, ankle: 0.19, hipW: 0.16, shY: 0.47, shZ: 0.31, spineY: 0.10, grip1: 1.2, grip2: 0.80, headY: 0.71 };

const SKIN_TONES = [0xf1c7a5, 0xd9a07a, 0xa8714c, 0x6e4529, 0xe8b893, 0x8d5a3b, 0xf5d2b8, 0xc48a5e];
// marker colors for local players: [0] = ctx.myId, then couch co-op players in ctx.couchIds order
const LOCAL_COLORS = [0xffe14a, 0x46f0ff, 0xff5ad8, 0x8dff4a, 0xff9a3c];

/** Index of a local player's marker color: 0 for myId, 1.. for couch ids, -1 if not local. */
function localIndex(c, myId, couch) {
  if (!c) return -1;
  if (c === myId) return 0;
  if (!couch) return -1;
  let i = 1;
  if (typeof couch.has === 'function') {
    if (!couch.has(c)) return -1;
    for (const id of couch) { if (id === c) return Math.min(i, LOCAL_COLORS.length - 1); if (id !== myId) i++; }
  } else if (Array.isArray(couch)) {
    for (const id of couch) { if (id === c) return Math.min(i, LOCAL_COLORS.length - 1); if (id !== myId) i++; }
  }
  return -1;
}

// ---------------------------------------------------------------------------------- geometry
function skaterGeos() {
  const D = DIM_S, g = {};
  let b = new PartBuilder();
  const J = [-0.15, 0.15, -0.23, 0.23, 0.0, -0.17, 0.17, -0.29, 0.29, 0.44];
  b.taper(...J, P);
  b.band(...J, 0.045, 0.1, 0.008, S);
  b.band(...J, 0.115, 0.14, 0.008, A);
  b.taper(-0.18, 0.18, -0.33, 0.33, 0.34, -0.15, 0.15, -0.27, 0.27, 0.53, P);
  b.taper(-0.152, 0.152, -0.272, -0.19, 0.525, -0.14, 0.14, -0.26, -0.19, 0.545, S); // epaulettes
  b.taper(-0.152, 0.152, 0.19, 0.272, 0.525, -0.14, 0.14, 0.19, 0.26, 0.545, S);
  b.box(0.165, 0.178, 0.22, 0.34, -0.08, 0.08, A); // chest crest
  b.box(-0.1, 0.1, 0.5, 0.56, -0.11, 0.11, S); // collar
  b.box(-0.06, 0.06, 0.52, 0.62, -0.07, 0.07, SKIN);
  const hy = D.headY;
  b.geom(new THREE.SphereGeometry(0.155, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.62), new THREE.Matrix4().compose(
    new THREE.Vector3(-0.005, hy - 0.02, 0), new THREE.Quaternion(), new THREE.Vector3(1.1, 1.0, 0.96)), P);
  b.box(-0.165, 0.0, hy - 0.12, hy - 0.0, -0.14, 0.14, P); // helmet back / ear guards
  b.box(-0.12, 0.12, hy + 0.115, hy + 0.15, -0.032, 0.032, S); // helmet stripe
  b.box(0.03, 0.14, hy - 0.13, hy + 0.0, -0.085, 0.085, SKIN); // face
  b.box(0.115, 0.168, hy - 0.035, hy + 0.035, -0.135, 0.135, K, 0x0d1822); // visor
  g.torso = b.build();

  b = new PartBuilder();
  b.taper(-0.16, 0.16, -0.24, 0.24, -0.17, -0.15, 0.15, -0.22, 0.22, 0.14, S);
  b.taper(-0.045, 0.045, 0.24, 0.252, -0.15, -0.045, 0.045, 0.222, 0.234, 0.11, P);
  b.taper(-0.045, 0.045, -0.252, -0.24, -0.15, -0.045, 0.045, -0.234, -0.222, 0.11, P);
  g.pelvis = b.build();

  b = new PartBuilder();
  const UA = [-0.058, 0.058, -0.058, 0.058, -0.30, -0.078, 0.078, -0.078, 0.078, 0.04];
  b.taper(...UA, P);
  b.band(...UA, -0.24, -0.19, 0.007, S);
  b.box(-0.09, 0.09, -0.08, 0.07, -0.09, 0.09, P);
  g.uarm = b.build();

  b = new PartBuilder();
  b.taper(-0.052, 0.052, -0.052, 0.052, -0.15, -0.06, 0.06, -0.06, 0.06, 0.03, P);
  b.box(-0.07, 0.07, -0.27, -0.12, -0.075, 0.075, S);
  b.box(-0.073, 0.073, -0.16, -0.135, -0.078, 0.078, A);
  b.box(-0.05, 0.075, -0.35, -0.26, -0.06, 0.06, S);
  g.larm = b.build();

  b = new PartBuilder();
  b.taper(-0.1, 0.1, -0.1, 0.1, -0.31, -0.115, 0.115, -0.115, 0.115, 0.04, S);
  b.taper(-0.075, 0.075, -0.075, 0.075, -0.47, -0.088, 0.088, -0.088, 0.088, -0.29, P);
  b.box(0.035, 0.105, -0.48, -0.36, -0.07, 0.07, P);
  g.thigh = b.build();

  b = new PartBuilder();
  const SH = [-0.064, 0.064, -0.064, 0.064, -0.4, -0.08, 0.08, -0.08, 0.08, 0.03];
  b.taper(...SH, P);
  b.band(...SH, -0.17, -0.11, 0.007, S);
  b.band(...SH, -0.205, -0.185, 0.007, A);
  g.shin = b.build();

  b = new PartBuilder();
  b.box(-0.095, 0.06, -0.135, 0.07, -0.058, 0.058, K, 0x14161a);
  b.box(0.05, 0.175, -0.135, -0.045, -0.052, 0.052, K, 0x14161a);
  b.box(-0.1, 0.175, -0.165, -0.135, -0.02, 0.02, K, 0xe6e6e6);
  b.box(-0.125, 0.205, -0.19, -0.165, -0.007, 0.007, K, 0xc8d2dc);
  g.skate = b.build();

  b = new PartBuilder();
  b.box(-0.016, 0.016, 0.06, 1.52, -0.012, 0.012, K, 0x1d2127);
  b.box(-0.019, 0.019, 1.0, 1.17, -0.015, 0.015, P);
  b.box(-0.019, 0.019, 1.45, 1.535, -0.015, 0.015, K, 0xf2f2f2);
  b.box(-0.02, 0.03, 0.0, 0.09, -0.012, 0.012, K, 0x1d2127);
  b.box(-0.02, 0.31, 0.0, 0.075, -0.011, 0.011, K, 0x16181c);
  b.box(0.06, 0.295, 0.006, 0.07, -0.0125, 0.0125, K, 0xf0f0f0);
  g.stick = b.build();
  return g;
}

function goalieGeos() {
  const D = DIM_G, g = {};
  let b = new PartBuilder();
  const J = [-0.2, 0.2, -0.28, 0.28, 0.0, -0.22, 0.22, -0.35, 0.35, 0.42];
  b.taper(...J, P);
  b.band(...J, 0.045, 0.1, 0.009, S);
  b.band(...J, 0.115, 0.14, 0.009, A);
  b.taper(-0.24, 0.24, -0.42, 0.42, 0.33, -0.2, 0.2, -0.36, 0.36, 0.55, P);
  b.taper(-0.202, 0.202, -0.362, -0.26, 0.545, -0.19, 0.19, -0.35, -0.26, 0.565, S);
  b.taper(-0.202, 0.202, 0.26, 0.362, 0.545, -0.19, 0.19, 0.26, 0.35, 0.565, S);
  b.box(0.215, 0.228, 0.2, 0.34, -0.1, 0.1, A);
  const hy = D.headY;
  b.geom(new THREE.SphereGeometry(0.165, 8, 6), new THREE.Matrix4().compose(
    new THREE.Vector3(0, hy, 0), new THREE.Quaternion(), new THREE.Vector3(1.05, 1.06, 0.93)), P);
  b.box(-0.05, 0.05, hy + 0.12, hy + 0.17, -0.12, 0.12, S); // mask stripe (side to side)
  b.box(0.12, 0.19, hy - 0.11, hy + 0.06, -0.1, 0.1, K, 0x1a1d22); // cage
  b.box(0.05, 0.14, 0.52, 0.6, -0.08, 0.08, K, 0xf0f0f0); // throat guard
  g.torso = b.build();

  b = new PartBuilder();
  b.taper(-0.2, 0.2, -0.29, 0.29, -0.2, -0.19, 0.19, -0.27, 0.27, 0.14, S);
  b.taper(-0.05, 0.05, 0.29, 0.302, -0.18, -0.05, 0.05, 0.272, 0.284, 0.11, P);
  b.taper(-0.05, 0.05, -0.302, -0.29, -0.18, -0.05, 0.05, -0.284, -0.272, 0.11, P);
  g.pelvis = b.build();

  b = new PartBuilder();
  const UA = [-0.075, 0.075, -0.075, 0.075, -0.31, -0.098, 0.098, -0.098, 0.098, 0.05];
  b.taper(...UA, P);
  b.band(...UA, -0.24, -0.18, 0.007, S);
  b.box(-0.12, 0.12, -0.1, 0.08, -0.12, 0.12, P);
  g.uarm = b.build();

  // left lower arm = catch glove
  b = new PartBuilder();
  b.taper(-0.068, 0.068, -0.068, 0.068, -0.14, -0.075, 0.075, -0.075, 0.075, 0.03, P);
  b.box(-0.088, 0.088, -0.18, -0.12, -0.092, 0.092, P);
  b.box(-0.1, 0.1, -0.47, -0.17, -0.15, 0.15, K, 0xf3f3f3);
  b.box(-0.104, 0.104, -0.47, -0.43, -0.154, 0.154, P);
  b.box(-0.06, 0.06, -0.52, -0.42, -0.12, 0.12, K, 0xdcdcdc);
  g.larmG = b.build();

  // right lower arm = blocker
  b = new PartBuilder();
  b.taper(-0.068, 0.068, -0.068, 0.068, -0.14, -0.075, 0.075, -0.075, 0.075, 0.03, P);
  b.box(-0.088, 0.088, -0.18, -0.12, -0.092, 0.092, P);
  b.box(-0.07, 0.08, -0.36, -0.16, -0.075, 0.075, K, 0xeeeeee);
  b.box(0.08, 0.125, -0.5, -0.12, -0.15, 0.15, K, 0xf5f5f5);
  b.box(0.082, 0.128, -0.5, -0.46, -0.155, 0.155, P);
  b.box(0.082, 0.128, -0.16, -0.12, -0.155, 0.155, P);
  g.larmB = b.build();

  b = new PartBuilder();
  b.box(-0.125, 0.155, -0.43, 0.03, -0.135, 0.135, K, 0xf2f2f2);
  b.box(-0.128, 0.158, -0.22, -0.15, -0.138, 0.138, P);
  g.thigh = b.build();

  b = new PartBuilder();
  b.box(-0.09, 0.175, -0.43, 0.15, -0.155, 0.155, K, 0xf4f4f4);
  b.box(0.0, 0.2, 0.06, 0.17, -0.165, 0.165, P); // knee roll
  b.box(0.176, 0.186, -0.13, -0.06, -0.145, 0.145, P);
  b.box(0.176, 0.186, -0.3, -0.24, -0.145, 0.145, S);
  b.box(0.0, 0.2, -0.43, -0.37, -0.14, 0.14, P); // toe bridge
  g.shin = b.build();

  b = new PartBuilder();
  b.box(-0.017, 0.017, 0.7, 1.46, -0.013, 0.013, K, 0x1d2127);
  b.box(-0.046, 0.046, 0.04, 0.72, -0.016, 0.016, K, 0x1d2127);
  b.box(-0.048, 0.048, 0.42, 0.6, -0.018, 0.018, P);
  b.box(-0.02, 0.02, 1.38, 1.47, -0.016, 0.016, K, 0xf2f2f2);
  b.box(-0.04, 0.39, 0.0, 0.095, -0.014, 0.014, K, 0x16181c);
  b.box(0.06, 0.37, 0.007, 0.088, -0.0155, 0.0155, K, 0xf0f0f0);
  g.stick = b.build();
  return g;
}

function paletteMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.04, envMapIntensity: 0.7 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute float slot;\nattribute vec3 iP;\nattribute vec3 iS;\nattribute vec3 iA;\nattribute vec3 iK;\n' +
      sh.vertexShader.replace('#include <color_vertex>', `
  vColor = color;
  if (slot > 0.5) {
    if (slot < 1.5) vColor = iP;
    else if (slot < 2.5) vColor = iS;
    else if (slot < 3.5) vColor = iA;
    else vColor = color * iK;
  }`);
  };
  m.customProgramCacheKey = () => 'iceriot-palette';
  return m;
}

// ---------------------------------------------------------------------------------- temps
const _mRoot = new THREE.Matrix4(), _mLoc = new THREE.Matrix4(), _mTmp = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1);
const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _right = new THREE.Vector3();
const _B = new THREE.Vector3(), _H = new THREE.Vector3(), _dir = new THREE.Vector3(), _toe = new THREE.Vector3(), _zz = new THREE.Vector3();
const _hTop = new THREE.Vector3(), _hLow = new THREE.Vector3(), _Lw = new THREE.Vector3(), _Rw = new THREE.Vector3();
const _sh = new THREE.Vector3(), _el = new THREE.Vector3(), _hand = new THREE.Vector3(), _pole = new THREE.Vector3();
const _hip = new THREE.Vector3(), _knee = new THREE.Vector3(), _ank = new THREE.Vector3(), _ft = new THREE.Vector3();
const _d = new THREE.Vector3(), _bend = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _tmpv = new THREE.Vector3();

function composeTRS(out, x, y, z, rx, ry, rz, order) {
  _e.set(rx, ry, rz, order); _q.setFromEuler(_e); _p.set(x, y, z);
  return out.compose(_p, _q, ONE);
}

function solveIK(Sv, Tv, a, b, pole, outE, outT) {
  _d.subVectors(Tv, Sv);
  let d = _d.length();
  if (d < 1e-5) { _d.set(0, -1, 0); d = 1e-5; } else _d.multiplyScalar(1 / d);
  const maxD = (a + b) * 0.999, minD = Math.abs(a - b) + 0.03;
  d = d > maxD ? maxD : d < minD ? minD : d;
  outT.copy(Sv).addScaledVector(_d, d);
  const ca = (a * a + d * d - b * b) / (2 * a * d);
  const sa = Math.sqrt(Math.max(0, 1 - ca * ca));
  _bend.copy(pole).addScaledVector(_d, -pole.dot(_d));
  const bl = _bend.length();
  if (bl < 1e-5) { _bend.set(0, 1, 0).addScaledVector(_d, -_d.y); _bend.normalize(); } else _bend.multiplyScalar(1 / bl);
  outE.copy(Sv).addScaledVector(_d, a * ca).addScaledVector(_bend, a * sa);
}

/** Segment matrix: origin at `from`, local -Y pointing at `to`, local +X toward `hint`. */
function segMatrix(out, from, to, hint) {
  _y.subVectors(from, to);
  const l = _y.length();
  if (l < 1e-6) _y.copy(_up); else _y.multiplyScalar(1 / l);
  _x.copy(hint).addScaledVector(_y, -hint.dot(_y));
  if (_x.lengthSq() < 1e-8) { _x.copy(_fwd).addScaledVector(_y, -_fwd.dot(_y)); }
  _x.normalize();
  _z.crossVectors(_x, _y);
  out.makeBasis(_x, _y, _z);
  out.setPosition(from);
  return out;
}

function bodyPoint(out, pv, x, y, z) { return out.set(x, y, z).applyMatrix4(pv.body); }
function bodyDir(out, pv, x, y, z) { return out.set(x, y, z).transformDirection(pv.body); }

const lerp = (a, b, t) => a + (b - a) * t;
function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

// ---------------------------------------------------------------------------------- module
export function createPlayers(scene, mirror, fx, track) {
  const group = new THREE.Group();
  group.name = 'players';
  scene.add(group);
  const mat = paletteMaterial();
  const sk = skaterGeos(), gk = goalieGeos();

  const parts = []; // {mesh, mir, owner: Int8Array(count)}
  function partMesh(geo, count) {
    for (const nm of ['iP', 'iS', 'iA', 'iK']) geo.setAttribute(nm, new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    group.add(mesh);
    const mir = new THREE.InstancedMesh(geo, mat, count);
    mir.instanceMatrix = mesh.instanceMatrix;
    mir.frustumCulled = false;
    mirror.add(mir);
    const pt = { mesh, mir, geo, owner: new Int8Array(count).fill(-1), count };
    parts.push(pt);
    return pt;
  }
  const M = {
    sTorso: partMesh(sk.torso, 6), sPelvis: partMesh(sk.pelvis, 6), sUarm: partMesh(sk.uarm, 12), sLarm: partMesh(sk.larm, 12),
    sThigh: partMesh(sk.thigh, 12), sShin: partMesh(sk.shin, 12), skate: partMesh(sk.skate, 16), sStick: partMesh(sk.stick, 6),
    gTorso: partMesh(gk.torso, 2), gPelvis: partMesh(gk.pelvis, 2), gUarm: partMesh(gk.uarm, 4), gLarmG: partMesh(gk.larmG, 2),
    gLarmB: partMesh(gk.larmB, 2), gThigh: partMesh(gk.thigh, 4), gShin: partMesh(gk.shin, 4), gStick: partMesh(gk.stick, 2),
  };

  // jersey numbers: one instanced quad per player sampling a 4x2 atlas cell
  const atlasCanvas = makeCanvas(512, 256);
  const atlasTex = track(canvasTex(atlasCanvas, { aniso: 4 }));
  const numMat = new THREE.MeshStandardMaterial({ map: atlasTex, roughness: 0.6, envMapIntensity: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  numMat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute float aCell;\n' + sh.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
  vMapUv = (vMapUv + vec2(mod(aCell, 4.0), 1.0 - floor(aCell / 4.0))) * vec2(0.25, 0.5);`);
  };
  numMat.customProgramCacheKey = () => 'iceriot-numbers';
  const numGeo = new THREE.PlaneGeometry(0.26, 0.26);
  numGeo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]), 1));
  const numMesh = new THREE.InstancedMesh(numGeo, numMat, 8);
  numMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  numMesh.frustumCulled = false;
  group.add(numMesh);
  const decalS = composeTRS(new THREE.Matrix4(), -0.168, 0.27, 0, 0, -Math.PI / 2, 0, 'XYZ');
  const decalG = new THREE.Matrix4().multiplyMatrices(composeTRS(new THREE.Matrix4(), -0.214, 0.26, 0, 0, -Math.PI / 2, 0, 'XYZ'), new THREE.Matrix4().makeScale(1.25, 1.25, 1));
  const atlasNums = new Array(8).fill(null);

  // markers
  const ringTex = track(makeRingTexture(false)), ringTexLocal = track(makeRingTexture(true));
  const glowTex = track(makeRadialTexture());
  const toughTex = track(makeToughIcon());
  const toughMat = new THREE.SpriteMaterial({ map: toughTex, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
  const shadowTex = track(makeRadialTexture([[0, 'rgba(255,255,255,0.75)'], [0.55, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']], 64));
  const ringGeo = new THREE.PlaneGeometry(1.7, 1.7); ringGeo.rotateX(-Math.PI / 2);
  const glowGeo = new THREE.PlaneGeometry(2.6, 2.6); glowGeo.rotateX(-Math.PI / 2);
  // local-player markers (always on top): one per local player on this PC (ctx.myId + ctx.couchIds)
  const arrowOutMat = new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
  const arrowGeo = new THREE.ConeGeometry(0.2, 0.42, 4); arrowGeo.rotateX(Math.PI);
  const arrows = [];
  for (let i = 0; i < LOCAL_COLORS.length; i++) {
    const a = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: LOCAL_COLORS[i], depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
    a.renderOrder = 51;
    const o = new THREE.Mesh(arrowGeo, arrowOutMat); o.renderOrder = 50; o.scale.set(1.35, 1.25, 1.35);
    a.visible = o.visible = false;
    group.add(o, a);
    arrows.push({ a, o });
  }

  // blob shadows (8 players + puck)
  const blobGeo = new THREE.PlaneGeometry(1, 1); blobGeo.rotateX(-Math.PI / 2);
  const blobMat = new THREE.MeshBasicMaterial({ map: shadowTex, color: 0x000000, transparent: true, depthWrite: false, opacity: 0.55 });
  const blobs = new THREE.InstancedMesh(blobGeo, blobMat, 9);
  blobs.frustumCulled = false; blobs.renderOrder = 1;
  blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(blobs);

  const tagCache = new Map();
  function tagTexture(name, team, localColor) {
    const key = `${name}|${team}|${localColor ?? '-'}`;
    let t = tagCache.get(key);
    if (!t) { t = makeNameTag(name, (TEAMS[team] || TEAMS[0]).colors.primary, localColor); tagCache.set(key, t); }
    return t;
  }

  // per-player visual state
  const pvs = [];
  for (let id = 0; id < 8; id++) {
    const team = id < 4 ? 0 : 1, k = id % 4, isG = k === 3;
    const pv = {
      id, team, isG, si: isG ? team : team * 3 + k,
      pose: new Float32Array(NP), target: new Float32Array(NP),
      body: new THREE.Matrix4(), hips: new THREE.Matrix4(), spine: new THREE.Matrix4(),
      bladeW: new THREE.Vector3(), headW: new THREE.Vector3(), rootW: new THREE.Vector3(),
      stride: id * 1.7, handle: id, turn: 0, prevF: null, prevSpeed: 0, lastS: -1, recover: 0,
      saveSide: 1, saveHigh: 0, saveMode: 0, spin: 0, sprayCd: 0, fireAcc: 0, inited: false, visible: false,
      ring: null, tag: null, chargeGlow: null, fireGlow: null, tagKey: '', tough: null, isTough: false,
    };
    pv.tough = new THREE.Sprite(toughMat); pv.tough.scale.set(0.46, 0.46, 1); pv.tough.renderOrder = 41; pv.tough.visible = false;
    const ringMat = new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0.95 });
    pv.ring = new THREE.Mesh(ringGeo, ringMat); pv.ring.renderOrder = 3; pv.ring.visible = false;
    const tagMat = new THREE.SpriteMaterial({ map: null, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
    pv.tag = new THREE.Sprite(tagMat); pv.tag.scale.set(1.7, 0.425, 1); pv.tag.renderOrder = 40; pv.tag.visible = false;
    // normal-blended colored halos: additive glows wash out to white over the bright ice
    const cgMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xffaa33, depthWrite: false, transparent: true, toneMapped: false });
    pv.chargeGlow = new THREE.Sprite(cgMat); pv.chargeGlow.renderOrder = 6; pv.chargeGlow.visible = false;
    const fgMat = new THREE.MeshBasicMaterial({ map: glowTex, color: 0xff5a00, depthWrite: false, transparent: true, toneMapped: false });
    pv.fireGlow = new THREE.Mesh(glowGeo, fgMat); pv.fireGlow.renderOrder = 2; pv.fireGlow.visible = false;
    group.add(pv.ring, pv.tag, pv.chargeGlow, pv.fireGlow, pv.tough);
    pvs.push(pv);
  }
  // owners for color assignment
  for (const pv of pvs) {
    const s = pv.si;
    if (pv.isG) {
      M.gTorso.owner[s] = pv.id; M.gPelvis.owner[s] = pv.id; M.gStick.owner[s] = pv.id;
      M.gLarmG.owner[s] = pv.id; M.gLarmB.owner[s] = pv.id;
      for (const side of [0, 1]) { M.gUarm.owner[s * 2 + side] = pv.id; M.gThigh.owner[s * 2 + side] = pv.id; M.gShin.owner[s * 2 + side] = pv.id; M.skate.owner[12 + s * 2 + side] = pv.id; }
    } else {
      M.sTorso.owner[s] = pv.id; M.sPelvis.owner[s] = pv.id; M.sStick.owner[s] = pv.id;
      for (const side of [0, 1]) for (const nm of ['sUarm', 'sLarm', 'sThigh', 'sShin', 'skate']) M[nm].owner[s * 2 + side] = pv.id;
    }
  }

  let teamsCur = [0, 1];
  const tmpc = [0, 0, 0];
  function setTeams(h, a) {
    teamsCur = [h, a];
    for (const pt of parts) {
      const aP = pt.geo.attributes.iP.array, aS = pt.geo.attributes.iS.array, aA = pt.geo.attributes.iA.array, aK = pt.geo.attributes.iK.array;
      for (let i = 0; i < pt.count; i++) {
        const id = pt.owner[i];
        if (id < 0) continue;
        const team = TEAMS[teamsCur[id < 4 ? 0 : 1]] || TEAMS[0];
        const c = team.colors;
        lin(c.primary, tmpc); aP.set(tmpc, i * 3);
        lin(c.secondary, tmpc); aS.set(tmpc, i * 3);
        lin(c.accent, tmpc); aA.set(tmpc, i * 3);
        lin(SKIN_TONES[(id * 5 + 3) % SKIN_TONES.length], tmpc); aK.set(tmpc, i * 3);
      }
      pt.geo.attributes.iP.needsUpdate = pt.geo.attributes.iS.needsUpdate = pt.geo.attributes.iA.needsUpdate = pt.geo.attributes.iK.needsUpdate = true;
    }
    for (let id = 0; id < 8; id++) {
      const team = TEAMS[teamsCur[id < 4 ? 0 : 1]] || TEAMS[0];
      const k = id % 4;
      atlasNums[id] = k === 3 ? team.goalie.num : team.skaters[k].num;
      pvs[id].isTough = k !== 3 && (team.skaters[k].chk || 0) >= TOUGH_CHK;
    }
    drawNumberAtlas(atlasCanvas, teamsCur, atlasNums);
    atlasTex.needsUpdate = true;
    for (const pv of pvs) pv.tagKey = '';
  }
  setTeams(0, 1);

  function hideAll() {
    for (const pt of parts) { for (let i = 0; i < pt.count; i++) pt.mesh.setMatrixAt(i, _zero); pt.mesh.instanceMatrix.needsUpdate = true; }
    for (let i = 0; i < 8; i++) numMesh.setMatrixAt(i, _zero);
    numMesh.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < 9; i++) blobs.setMatrixAt(i, _zero);
    blobs.instanceMatrix.needsUpdate = true;
    for (const pv of pvs) { pv.ring.visible = pv.tag.visible = pv.chargeGlow.visible = pv.fireGlow.visible = pv.tough.visible = false; pv.visible = false; pv.inited = false; }
    for (const ar of arrows) ar.a.visible = ar.o.visible = false;
  }

  // ------------------------------------------------------------------ pose targets
  function poseTarget(pv, p, k, dt, time, phase) {
    const T = pv.target;
    const sp = Math.hypot(p.vx || 0, p.vz || 0);
    const run = clamp01(sp / 9);
    const hasPuck = k && k.o === p.id;
    const s = p.s | 0, sT = p.sT || 0;
    // defaults: skating
    T[HIP] = 0.98 - 0.08 * run; T[BP] = 0; T[BR] = Math.max(-0.42, Math.min(0.42, pv.turn * sp * 0.05));
    T[BDX] = 0; T[BDY] = 0; T[BDZ] = 0;
    T[LEAN] = 0.2 + 0.35 * run; T[TWIST] = 0; T[SIDE] = 0;
    if (hasPuck) { T[BX] = 0.9; T[BY] = 0; T[BZ] = 0.15; T[HX] = 0.24; T[HY] = 0.98; T[HZ] = -0.12; T[HANDLE] = 1; }
    else { T[BX] = 0.78 + 0.08 * run; T[BY] = 0; T[BZ] = 0.3; T[HX] = 0.16; T[HY] = 0.95; T[HZ] = -0.12; T[HANDLE] = 0; }
    T[STANCE] = 0.15; T[STRIDE] = clamp01(sp / 5.5); T[FOOTX] = 0; T[FOOTY] = 0; T[KNEEOUT] = 0.2; T[KNEEDN] = 0;
    T[FREE] = hasPuck ? 0 : clamp01((sp - 5) / 3) * 0.85; T[LX] = 0.2; T[LY] = 0.92; T[LZ] = -0.42; T[PUMP] = T[FREE];
    T[RFREE] = 0; T[RX] = 0.3; T[RY] = 0.85; T[RZ] = 0.42; T[HOP] = 0;
    let rate = 11;

    if (pv.isG) {
      T[HIP] = 0.64; T[LEAN] = 0.42; T[STANCE] = 0.34; T[STRIDE] = clamp01(sp / 3) * 0.45; T[KNEEOUT] = 0.45;
      T[BX] = 0.62; T[BY] = 0; T[BZ] = 0.16; T[HX] = 0.3; T[HY] = 0.75; T[HZ] = 0.28; T[HANDLE] = 0;
      T[FREE] = 1; T[LX] = 0.36; T[LY] = 0.78; T[LZ] = -0.52; T[PUMP] = 0; T[BR] *= 0.3;
    }

    switch (s) {
      case PSTATE.CHARGE: {
        const w = smoothstep(0, 0.35, p.ch || 0);
        T[BX] = lerp(T[BX], -0.75, w); T[BY] = lerp(0, 1.45, w); T[BZ] = lerp(T[BZ], 0.8, w);
        T[HX] = lerp(T[HX], 0.05, w); T[HY] = lerp(T[HY], 1.25, w); T[HZ] = lerp(T[HZ], 0.2, w);
        T[TWIST] = -0.65 * w; T[LEAN] = 0.25; T[SIDE] = -0.1 * w; T[HIP] = 0.93; T[STANCE] = 0.2 + 0.08 * w;
        T[HANDLE] = 0; T[FREE] = 0; T[PUMP] = 0; T[STRIDE] *= 0.5;
        if ((p.ch || 0) > 0.85) { T[BY] += Math.sin(time * 61) * 0.03; T[BZ] += Math.sin(time * 47) * 0.03; }
        rate = 14;
        break;
      }
      case PSTATE.SHOOT:
        T[BX] = 1.05; T[BY] = 0.95; T[BZ] = -0.55; T[HX] = 0.42; T[HY] = 1.28; T[HZ] = -0.25;
        T[TWIST] = 0.55; T[LEAN] = 0.3; T[HANDLE] = 0; T[FREE] = 0; T[PUMP] = 0; T[HIP] = 0.93;
        rate = 28;
        break;
      case PSTATE.CHECK: {
        const l = smoothstep(0, 0.12, sT);
        T[LEAN] = 0.55; T[TWIST] = 0.45; T[SIDE] = 0.2; T[HIP] = 0.84; T[BDX] = 0.2 * l;
        T[BX] = 0.72; T[BZ] = 0.42; T[HX] = 0.2; T[HY] = 0.9; T[HZ] = 0.0; T[HANDLE] = 0;
        T[FREE] = 0.65; T[LX] = 0.45; T[LY] = 1.25; T[LZ] = -0.18; T[PUMP] = 0; T[STANCE] = 0.22;
        rate = 18;
        break;
      }
      case PSTATE.POKE:
        T[LEAN] = 0.5; T[TWIST] = -0.25; T[HIP] = 0.84; T[BDX] = 0.12;
        T[BX] = 1.5; T[BY] = 0; T[BZ] = 0.05; T[HX] = 0.6; T[HY] = 0.95; T[HZ] = 0.1; T[HANDLE] = 0;
        T[RFREE] = 0.85; T[RX] = 0.15; T[RY] = 0.85; T[RZ] = 0.42; T[FREE] = 0; T[PUMP] = 0; T[STANCE] = 0.24;
        rate = 22;
        break;
      case PSTATE.DEKE:
        T[LEAN] = 0.38; T[HIP] = 0.84; T[HANDLE] = 1.7; T[BX] = 0.85; T[BZ] = 0.1; T[FREE] = 0; T[PUMP] = 0;
        rate = 14;
        break;
      case PSTATE.DOWN: {
        const g = smoothstep(0.9, 1.7, sT);
        T[BP] = lerp(1.42, 0.3, g); T[BDX] = lerp(0.95, 0.15, g); T[BDY] = lerp(0.13, 0, g); T[BR] = 0;
        T[HIP] = lerp(0.95, 0.62, g); T[LEAN] = lerp(-0.1, 0.5, g); T[STRIDE] = 0; T[STANCE] = 0.24;
        T[KNEEOUT] = 0.35; T[KNEEDN] = 0; T[HANDLE] = 0; T[PUMP] = 0;
        T[BX] = 0.95; T[BY] = 0.55; T[BZ] = 0.55; T[HX] = 0.3; T[HY] = 1.05; T[HZ] = 0.3;
        T[FREE] = 1; T[LX] = 0.25; T[LY] = 1.35; T[LZ] = -0.6; T[RFREE] = 0.6; T[RX] = 0.4; T[RY] = 1.1; T[RZ] = 0.6;
        rate = 14;
        break;
      }
      case PSTATE.CELEBRATE:
        T[HIP] = 0.97; T[LEAN] = 0.02; T[TWIST] = Math.sin(time * 2.5 + pv.id) * 0.25;
        T[BX] = 0.35; T[BY] = 2.55; T[BZ] = 0.35; T[HX] = 0.1; T[HY] = 1.45; T[HZ] = 0.12; T[HANDLE] = 0;
        T[FREE] = 0.85; T[LX] = 0.25; T[LY] = 2.0; T[LZ] = -0.42; T[PUMP] = 0; T[HOP] = 1;
        if (pv.isG) { T[HIP] = 0.9; T[STANCE] = 0.25; }
        rate = 8;
        break;
      case PSTATE.SAVE: {
        // keep tracking the puck for the first moments of the save, then commit to the move
        if ((pv.lastS !== PSTATE.SAVE || sT < 0.2) && k) {
          const dx = k.x - p.x, dz = k.z - p.z;
          const lat = -dx * Math.sin(p.f) + dz * Math.cos(p.f);
          pv.saveSide = lat >= 0 ? 1 : -1;
          pv.saveHigh = clamp01(((k.y || 0) - 0.2) / 0.8);
          const reach = clamp01(Math.abs(lat) / 1.1);
          pv.saveMode = reach < 0.4 && pv.saveHigh < 0.35 ? 0 : 1;
        }
        const sd = pv.saveSide, hi = pv.saveHigh;
        T[PUMP] = 0; T[HANDLE] = 0;
        if (pv.saveMode === 0) { // butterfly
          T[HIP] = 0.36; T[LEAN] = 0.18; T[STANCE] = 0.8; T[FOOTX] = -0.38; T[FOOTY] = -0.06; T[KNEEOUT] = -0.5; T[KNEEDN] = -0.9; T[STRIDE] = 0;
          T[BX] = 0.72; T[BZ] = 0.05; T[HX] = 0.55; T[HY] = 0.7; T[HZ] = 0.18;
          T[LX] = 0.42; T[LY] = 0.55 + hi * 0.6; T[LZ] = -0.62;
        } else { // dive / stretch toward the puck side
          T[BR] = sd * 0.7; T[BDZ] = sd * 0.35; T[HIP] = 0.55; T[LEAN] = 0.15; T[STANCE] = 0.45; T[STRIDE] = 0; T[KNEEOUT] = 0.2;
          T[BZ] = 0.18 + sd * 0.4;
          if (sd < 0) { T[LX] = 0.35; T[LY] = 0.85 + hi * 0.5; T[LZ] = -1.05; }
          else { T[RFREE] = 0.85; T[RX] = 0.35; T[RY] = 0.85 + hi * 0.4; T[RZ] = 1.0; }
        }
        rate = 22;
        break;
      }
      default: break;
    }
    if (pv.lastS === PSTATE.DOWN && s !== PSTATE.DOWN) pv.recover = 0.7;
    if (pv.recover > 0) { pv.recover -= dt; rate = Math.min(rate, 5); }
    // deke spin (not blended: a full turn over 0.38 s)
    pv.spin = s === PSTATE.DEKE ? -smoothstep(0, 0.38, sT) * Math.PI * 2 : 0;
    pv.lastS = s;
    return rate;
  }

  // ------------------------------------------------------------------ rig evaluation
  function evalRig(pv, p, time) {
    const D = pv.isG ? DIM_G : DIM_S, Pp = pv.pose;
    composeTRS(_mRoot, p.x, Math.max(0, p.y || 0), p.z, 0, -((p.f || 0) + pv.spin), 0, 'XYZ');
    const hop = Pp[HOP] * Math.abs(Math.sin(time * 6.5 + pv.id)) * 0.2;
    composeTRS(_mLoc, Pp[BDX], Pp[BDY] + hop, Pp[BDZ], Pp[BR], 0, Pp[BP], 'XYZ');
    pv.body.multiplyMatrices(_mRoot, _mLoc);
    const strideAmp = Pp[STRIDE];
    composeTRS(_mLoc, 0, Pp[HIP], 0, 0, Math.sin(pv.stride) * 0.12 * strideAmp, 0, 'XYZ');
    pv.hips.multiplyMatrices(pv.body, _mLoc);
    composeTRS(_mLoc, 0, D.spineY, 0, Pp[SIDE], Pp[TWIST] - Math.sin(pv.stride) * 0.1 * strideAmp, -Pp[LEAN], 'YZX');
    pv.spine.multiplyMatrices(pv.hips, _mLoc);
    _fwd.setFromMatrixColumn(pv.body, 0); _up.setFromMatrixColumn(pv.body, 1); _right.setFromMatrixColumn(pv.body, 2);
    pv.rootW.set(p.x, 0, p.z);

    const si = pv.si;
    if (pv.isG) { M.gTorso.mesh.setMatrixAt(si, pv.spine); M.gPelvis.mesh.setMatrixAt(si, pv.hips); }
    else { M.sTorso.mesh.setMatrixAt(si, pv.spine); M.sPelvis.mesh.setMatrixAt(si, pv.hips); }
    _mTmp.multiplyMatrices(pv.spine, pv.isG ? decalG : decalS);
    numMesh.setMatrixAt(pv.id, _mTmp);
    pv.headW.set(0, D.headY + 0.2, 0).applyMatrix4(pv.spine);

    // stick
    const hs = Math.sin(pv.handle) * Pp[HANDLE];
    bodyPoint(_B, pv, Pp[BX] + Math.cos(pv.handle * 2) * 0.03 * Pp[HANDLE], Pp[BY], Pp[BZ] + hs * 0.13);
    bodyPoint(_H, pv, Pp[HX], Pp[HY], Pp[HZ] + hs * 0.05);
    _dir.subVectors(_H, _B);
    if (_dir.lengthSq() < 1e-8) _dir.copy(_up); else _dir.normalize();
    _toe.copy(_right).negate().addScaledVector(_dir, _right.dot(_dir));
    if (_toe.lengthSq() < 1e-6) _toe.copy(_fwd).addScaledVector(_dir, -_fwd.dot(_dir));
    _toe.normalize();
    _zz.crossVectors(_toe, _dir);
    _mTmp.makeBasis(_toe, _dir, _zz).setPosition(_B);
    (pv.isG ? M.gStick : M.sStick).mesh.setMatrixAt(si, _mTmp);
    // blade center (where the puck sits)
    pv.bladeW.copy(_B).addScaledVector(_toe, pv.isG ? 0.18 : 0.15).addScaledVector(_fwd, 0.1);
    pv.bladeW.y = _B.y;

    // hands
    _hTop.copy(_B).addScaledVector(_dir, D.grip1);
    _hLow.copy(_B).addScaledVector(_dir, D.grip2);
    const pump = Pp[PUMP];
    bodyPoint(_Lw, pv, Pp[LX] + Math.sin(pv.stride) * 0.3 * pump, Pp[LY] + Math.cos(pv.stride) * 0.08 * pump, Pp[LZ]);
    bodyPoint(_Rw, pv, Pp[RX], Pp[RY], Pp[RZ]);
    if (Pp[HOP] > 0.01) _Lw.y += Math.sin(time * 9 + pv.id) * 0.12 * Pp[HOP];
    _Lw.lerpVectors(_hTop, _Lw, Pp[FREE]);
    _Rw.lerpVectors(_hLow, _Rw, Pp[RFREE]);

    // arms
    for (let side = 0; side < 2; side++) {
      const sg = side ? 1 : -1;
      _sh.set(0, D.shY, sg * D.shZ).applyMatrix4(pv.spine);
      bodyDir(_pole, pv, -0.35, -0.5, sg * 1.0);
      solveIK(_sh, side ? _Rw : _Lw, D.ua, D.la, _pole, _el, _hand);
      const ui = si * 2 + side;
      segMatrix(_mTmp, _sh, _el, _pole);
      (pv.isG ? M.gUarm : M.sUarm).mesh.setMatrixAt(ui, _mTmp);
      segMatrix(_mTmp, _el, _hand, _pole);
      if (pv.isG) (side ? M.gLarmB : M.gLarmG).mesh.setMatrixAt(si, _mTmp);
      else M.sLarm.mesh.setMatrixAt(ui, _mTmp);
    }

    // legs
    for (let side = 0; side < 2; side++) {
      const sg = side ? 1 : -1;
      const ph = pv.stride + (side ? Math.PI : 0);
      const c = Math.cos(ph), sn = Math.sin(ph);
      _hip.set(0, 0, sg * D.hipW).applyMatrix4(pv.hips);
      const fx = Pp[FOOTX] + strideAmp * 0.24 * c;
      const fz = sg * (Pp[STANCE] + strideAmp * 0.11 * (1 - c));
      const fy = D.ankle + Pp[FOOTY] + strideAmp * 0.1 * Math.max(0, -sn);
      bodyPoint(_ft, pv, fx, fy, fz);
      bodyDir(_pole, pv, 1, Pp[KNEEDN], sg * Pp[KNEEOUT]);
      solveIK(_hip, _ft, D.th, D.sh, _pole, _knee, _ank);
      const li = si * 2 + side;
      segMatrix(_mTmp, _hip, _knee, _pole);
      (pv.isG ? M.gThigh : M.sThigh).mesh.setMatrixAt(li, _mTmp);
      segMatrix(_mTmp, _knee, _ank, _pole);
      (pv.isG ? M.gShin : M.sShin).mesh.setMatrixAt(li, _mTmp);
      // skate: flat to the body, toe splayed out during the push
      const splay = strideAmp * 0.3 * (0.5 - 0.5 * c) + (pv.isG ? 0.25 : 0.05);
      _x.copy(_fwd).multiplyScalar(Math.cos(splay)).addScaledVector(_right, sg * Math.sin(splay));
      _z.crossVectors(_x, _up);
      _mTmp.makeBasis(_x, _up, _z).setPosition(_ank);
      M.skate.mesh.setMatrixAt(pv.isG ? 12 + si * 2 + side : li, _mTmp);
    }
  }

  // ------------------------------------------------------------------ per-frame update
  const fireCol0 = [1, 0.85, 0.35], fireCol1 = [1, 0.18, 0.03];
  function update(state, dt, ctx, time) {
    const pl = state.p || [];
    const k = state.k;
    const myId = ctx && ctx.myId;
    const couch = ctx && ctx.couchIds;
    const names = (ctx && ctx.names) || {};
    let arrowsUsed = 0;
    for (let id = 0; id < 8; id++) {
      const pv = pvs[id];
      const p = pl[id];
      if (!p) {
        if (pv.visible) hidePlayer(pv);
        continue;
      }
      pv.visible = true;
      if (p.n != null && atlasNums[id] !== p.n) {
        atlasNums[id] = p.n;
        drawNumberAtlas(atlasCanvas, teamsCur, atlasNums);
        atlasTex.needsUpdate = true;
      }
      // turn rate + stride clocks
      const f = p.f || 0;
      if (pv.prevF == null || !pv.inited) pv.prevF = f;
      const tr = dt > 0 ? angDiff(pv.prevF, f) / dt : 0;
      pv.prevF = f;
      pv.turn += (Math.max(-6, Math.min(6, tr)) - pv.turn) * Math.min(1, dt * 8);
      const sp = Math.hypot(p.vx || 0, p.vz || 0);
      pv.stride += dt * (sp > 0.3 ? 2.6 + sp * 0.62 : 0.6) * (pv.isG ? 0.8 : 1);
      pv.handle += dt * 9.5;

      const rate = poseTarget(pv, p, k, dt, time, state.ph);
      if (!pv.inited) { pv.pose.set(pv.target); pv.inited = true; }
      else {
        const a = 1 - Math.exp(-rate * dt);
        const P0 = pv.pose, T0 = pv.target;
        for (let i = 0; i < NP; i++) P0[i] += (T0[i] - P0[i]) * a;
      }
      evalRig(pv, p, time);

      // blob shadow
      const air = Math.max(0, p.y || 0);
      const bs = (pv.isG ? 1.7 : 1.3) * (1 + air * 0.3) * (p.s === PSTATE.DOWN ? 1.4 : 1);
      _mTmp.makeScale(bs, 1, bs);
      _mTmp.setPosition(pv.hips.elements[12], 0.012, pv.hips.elements[14]);
      blobs.setMatrixAt(id, _mTmp);

      // hard-stop / sharp-turn ice spray
      pv.sprayCd -= dt;
      const decel = dt > 0 ? (pv.prevSpeed - sp) / dt : 0;
      if (pv.sprayCd <= 0 && pv.prevSpeed > 4 && (decel > 14 || Math.abs(pv.turn) * sp > 26) && p.s !== PSTATE.DOWN) {
        fx.iceSpray(p.x + _fwd.x * 0.3, p.z + _fwd.z * 0.3, _fwd.x * 3 + (p.vx || 0) * 0.4, _fwd.z * 3 + (p.vz || 0) * 0.4, 10 + Math.min(20, decel));
        pv.sprayCd = 0.25;
      }
      pv.prevSpeed = sp;

      // name tag (every player) + human ring + tough-guy badge + local marker
      const human = p.c && p.c !== 0;
      const li = human ? localIndex(p.c, myId, couch) : -1; // local player on this PC (me or couch co-op)
      const isLocal = li >= 0;
      const lc = isLocal ? LOCAL_COLORS[li] : null;
      const team = TEAMS[teamsCur[pv.team]] || TEAMS[0];
      const hx = pv.hips.elements[12], hz = pv.hips.elements[14];
      pv.ring.visible = !!human;
      if (human) {
        pv.ring.position.set(hx, 0.025, hz);
        pv.ring.material.map = isLocal ? ringTexLocal : ringTex;
        pv.ring.material.color.setHex(isLocal ? lc : team.colors.primary);
        const pulse = isLocal ? 1 + Math.sin(time * 6 + li) * 0.08 : 1;
        pv.ring.scale.set(pulse, 1, pulse);
        if (isLocal) pv.ring.rotation.y = time * 1.5; else pv.ring.rotation.y = 0;
      }
      let top = Math.max(pv.headW.y, 0.9) + 0.42;      // height of the next floating marker
      const showTag = !(ctx && ctx.showNames === false);
      if (showTag) {
        const ros = pv.isG ? team.goalie : team.skaters[id % 4];
        const name = human
          ? String(names[p.c] ?? names[String(p.c)] ?? `P${p.c}`).slice(0, 16)
          : String(ros ? ros.name : `#${p.n ?? ''}`).toUpperCase().slice(0, 16);
        const key = `${name}|${teamsCur[pv.team]}|${lc ?? '-'}`;
        if (pv.tagKey !== key) { pv.tag.material.map = tagTexture(name, teamsCur[pv.team], lc); pv.tag.material.needsUpdate = true; pv.tagKey = key; }
        const s = human ? 1 : 0.8;                       // AI tags a bit smaller than human ones
        pv.tag.scale.set(1.7 * s, 0.425 * s, 1);
        pv.tag.material.opacity = human ? 1 : 0.85;
        pv.tag.position.set(hx, top, hz);
        pv.tag.visible = true;
        top += 0.4;
      } else pv.tag.visible = false;
      pv.tough.visible = pv.isTough;
      if (pv.isTough) {
        const by = top + 0.06 + Math.sin(time * 3 + id) * 0.05;
        pv.tough.position.set(hx, by, hz);
        top = by + 0.3;
      }
      if (isLocal && arrowsUsed < arrows.length) {
        const ar = arrows[arrowsUsed++];
        ar.a.material.color.setHex(lc);
        const ay = top + 0.2 + Math.sin(time * 5 + li) * 0.1;
        ar.a.position.set(hx, ay, hz); ar.o.position.set(hx, ay + 0.02, hz);
        ar.a.rotation.y = ar.o.rotation.y = time * 2;
        ar.a.visible = ar.o.visible = true;
      }

      // slapshot charge glow
      const ch = p.s === PSTATE.CHARGE ? (p.ch || 0) : 0;
      pv.chargeGlow.visible = ch > 0.02;
      if (ch > 0.02) {
        pv.chargeGlow.position.copy(pv.bladeW);
        const sz = 0.35 + ch * 0.85 + (ch > 0.95 ? Math.sin(time * 40) * 0.12 : 0);
        pv.chargeGlow.scale.set(sz, sz, 1);
        pv.chargeGlow.material.color.setRGB(1 - ch * 0.85, 0.5 + ch * 0.2, 0.05 + ch * 0.95);
        pv.chargeGlow.material.opacity = 0.6 + ch * 0.35;
        if (ch > 0.6 && Math.random() < dt * 30 * ch) fx.chargeSpark(pv.bladeW.x, pv.bladeW.y + 0.1, pv.bladeW.z);
      }

      // ON FIRE
      const onFire = p.fire === 1 || p.fire === true;
      pv.fireGlow.visible = onFire;
      if (onFire) {
        pv.fireGlow.position.set(hx, 0.03, hz);
        const fs = 1 + Math.sin(time * 9 + id) * 0.12;
        pv.fireGlow.scale.set(fs, 1, fs);
        pv.fireGlow.material.opacity = 0.42 + Math.sin(time * 13 + id) * 0.08;
        pv.fireAcc += dt * 75;
        while (pv.fireAcc >= 1) {
          pv.fireAcc -= 1;
          const r = Math.random();
          const yy = 0.2 + r * 1.5;
          const ang = Math.random() * Math.PI * 2, rad = 0.12 + Math.random() * 0.22;
          fx.flame(hx + Math.cos(ang) * rad, (p.y || 0) + yy, hz + Math.sin(ang) * rad, (p.vx || 0) * 0.35, (p.vz || 0) * 0.35, 0.35 + (1 - r) * 0.3, fireCol0, fireCol1);
        }
      }
    }
    for (let i = arrowsUsed; i < arrows.length; i++) arrows[i].a.visible = arrows[i].o.visible = false;
    for (const pt of parts) pt.mesh.instanceMatrix.needsUpdate = true;
    numMesh.instanceMatrix.needsUpdate = true;
    blobs.instanceMatrix.needsUpdate = true;
  }

  function hidePlayer(pv) {
    pv.visible = false; pv.inited = false;
    pv.ring.visible = pv.tag.visible = pv.chargeGlow.visible = pv.fireGlow.visible = pv.tough.visible = false;
    for (const pt of parts) for (let i = 0; i < pt.count; i++) if (pt.owner[i] === pv.id) pt.mesh.setMatrixAt(i, _zero);
    numMesh.setMatrixAt(pv.id, _zero);
    blobs.setMatrixAt(pv.id, _zero);
  }

  function setPuckShadow(x, z, y, visible) {
    if (!visible) { blobs.setMatrixAt(8, _zero); }
    else {
      const s = 0.42 + Math.min(1.5, y) * 0.4;
      _mTmp.makeScale(s, 1, s); _mTmp.setPosition(x, 0.013, z);
      blobs.setMatrixAt(8, _mTmp);
    }
    blobs.instanceMatrix.needsUpdate = true;
  }

  hideAll();
  return {
    group, pvs, setTeams, update, hideAll, setPuckShadow,
    setBlobOpacity(v) { blobMat.opacity = v; },
    bladeOf(id) { const pv = pvs[id]; return pv && pv.visible ? pv.bladeW : null; },
    headOf(id) { const pv = pvs[id]; return pv && pv.visible ? pv.headW : null; },
    dispose() { for (const t of tagCache.values()) t.dispose(); tagCache.clear(); },
  };
}
