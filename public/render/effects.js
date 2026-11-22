// ICE RIOT renderer - effects: GPU point particles (additive + alpha), glass shards, puck with
// trail / flame, full-screen flash. All buffers preallocated; nothing allocates per frame.
import * as THREE from 'three';
import { RINK, PUCK, glassPanels } from '/shared/constants.js';

const VS = `attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;
void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uScale / max(0.2, -mv.z), 1.0, 256.0); gl_Position = projectionMatrix * mv; }`;
const FS = `varying vec4 vC;
void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c, c) * 4.0; if (d > 1.0) discard;
  float a = 1.0 - d; a *= a; gl_FragColor = vec4(vC.rgb + vec3(0.25) * a * a * vC.a, vC.a * a); }`;

class Particles {
  constructor(max, blending, uScale) {
    this.max = max; this.n = 0; this.density = 1;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.inv = new Float32Array(max);
    this.c0 = new Float32Array(max * 3); this.c1 = new Float32Array(max * 3);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max); this.a0 = new Float32Array(max);
    this.grav = new Float32Array(max); this.drag = new Float32Array(max); this.bounce = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aColor', this.aCol); g.setAttribute('aSize', this.aSize);
    g.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({ uniforms: { uScale }, vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, blending });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = blending === THREE.AdditiveBlending ? 8 : 7;
  }
  spawn(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, a, grav, drag, bounce) {
    if (this.density < 1 && Math.random() > this.density) return;
    let i = this.n;
    if (i >= this.max) i = (Math.random() * this.max) | 0; else this.n++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = life; this.inv[i] = 1 / life;
    this.c0[i3] = c0[0]; this.c0[i3 + 1] = c0[1]; this.c0[i3 + 2] = c0[2];
    this.c1[i3] = c1[0]; this.c1[i3 + 1] = c1[1]; this.c1[i3 + 2] = c1[2];
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a; this.grav[i] = grav; this.drag[i] = drag; this.bounce[i] = bounce;
    this.size[i] = 0; this.col[i * 4 + 3] = 0;
  }
  _move(dst, src) {
    const d3 = dst * 3, s3 = src * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[d3 + k] = this.pos[s3 + k]; this.vel[d3 + k] = this.vel[s3 + k];
      this.c0[d3 + k] = this.c0[s3 + k]; this.c1[d3 + k] = this.c1[s3 + k];
    }
    this.life[dst] = this.life[src]; this.inv[dst] = this.inv[src]; this.s0[dst] = this.s0[src]; this.s1[dst] = this.s1[src];
    this.a0[dst] = this.a0[src]; this.grav[dst] = this.grav[src]; this.drag[dst] = this.drag[src]; this.bounce[dst] = this.bounce[src];
  }
  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.n--; if (i !== this.n) this._move(i, this.n); continue; }
      const i3 = i * 3;
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= dr; this.vel[i3 + 2] *= dr;
      this.vel[i3 + 1] = this.vel[i3 + 1] * dr + this.grav[i] * dt;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < 0.02 && this.bounce[i] >= 0) {
        this.pos[i3 + 1] = 0.02;
        if (this.vel[i3 + 1] < 0) this.vel[i3 + 1] *= -this.bounce[i];
        this.vel[i3] *= 0.85; this.vel[i3 + 2] *= 0.85;
      }
      const t = 1 - this.life[i] * this.inv[i];
      const c = i * 4;
      this.col[c] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
      this.col[c + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
      this.col[c + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
      this.col[c + 3] = this.a0[i] * Math.min(1, t * 10) * (1 - t);
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      i++;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    if (this.n > 0) {
      this.aPos.clearUpdateRanges(); this.aPos.addUpdateRange(0, this.n * 3); this.aPos.needsUpdate = true;
      this.aCol.clearUpdateRanges(); this.aCol.addUpdateRange(0, this.n * 4); this.aCol.needsUpdate = true;
      this.aSize.clearUpdateRanges(); this.aSize.addUpdateRange(0, this.n); this.aSize.needsUpdate = true;
    }
  }
}

const rnd = (a, b) => a + Math.random() * (b - a);
const C = (r, g, b) => [r, g, b];
const SPARK0 = C(1, 0.95, 0.75), SPARK1 = C(1, 0.4, 0.08);
const ICE0 = C(0.92, 0.97, 1), ICE1 = C(0.82, 0.9, 1);
const GLIT0 = C(0.85, 0.97, 1), GLIT1 = C(0.5, 0.8, 1);
const CHG0 = C(0.7, 0.9, 1), CHG1 = C(0.3, 0.6, 1);
const WHITE = C(1, 1, 1);
const FLAME0 = C(1, 0.88, 0.4), FLAME1 = C(1, 0.15, 0.02);
const FLAMEA0 = C(1, 0.62, 0.08), FLAMEA1 = C(0.85, 0.12, 0.02);
const SPARKA0 = C(1, 0.85, 0.15), SPARKA1 = C(1, 0.35, 0.02);

export function createEffects(scene, mirror, track) {
  const uScale = { value: 800 };
  const add = new Particles(3500, THREE.AdditiveBlending, uScale);
  const alpha = new Particles(1800, THREE.NormalBlending, uScale);
  scene.add(add.points, alpha.points);

  // -------------------------------------------------------------- glass shards
  const SH = 420;
  const shardGeo = new THREE.BufferGeometry();
  shardGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.15, 0, -0.13, -0.08, 0, 0.11, -0.1, 0, 0.11, -0.1, 0, 0.2, 0.05, 0, 0, 0.15, 0], 3));
  shardGeo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  const shardMat = new THREE.MeshStandardMaterial({
    color: 0xd8f3ff, roughness: 0.04, metalness: 0.35, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
    envMapIntensity: 3.0, emissive: 0x2a4a5a, depthWrite: false,
  });
  const shards = new THREE.InstancedMesh(shardGeo, shardMat, SH);
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shards.frustumCulled = false;
  shards.renderOrder = 5;
  scene.add(shards);
  const sp = new Float32Array(SH * 3), sv = new Float32Array(SH * 3), sr = new Float32Array(SH * 3), sw = new Float32Array(SH * 3);
  const sl = new Float32Array(SH), ss = new Float32Array(SH);
  let shardNext = 0, shardActive = 0, shardsDirty = true;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < SH; i++) shards.setMatrixAt(i, zeroM);
  const panels = glassPanels();

  function shatter(index) {
    const p = panels[index];
    if (!p) return;
    const tx = Math.cos(p.angle), tz = -Math.sin(p.angle);
    const y0 = RINK.boardHeight, gh = RINK.glassHeight;
    const nShards = Math.round(90 * shardShare);
    for (let k = 0; k < nShards; k++) {
      const i = shardNext; shardNext = (shardNext + 1) % SH;
      const u = rnd(-0.5, 0.5) * p.len, v = rnd(0, 1) * gh;
      const i3 = i * 3;
      sp[i3] = p.x + tx * u; sp[i3 + 1] = y0 + v; sp[i3 + 2] = p.z + tz * u;
      const inward = Math.random() < 0.55 ? 1 : -1; // most spill onto the ice (toward the camera's view)
      const sv0 = rnd(1.5, 6.5);
      sv[i3] = p.nx * inward * sv0 + tx * rnd(-2.5, 2.5);
      sv[i3 + 1] = rnd(-0.5, 3.5);
      sv[i3 + 2] = p.nz * inward * sv0 + tz * rnd(-2.5, 2.5);
      sr[i3] = rnd(0, 6.28); sr[i3 + 1] = rnd(0, 6.28); sr[i3 + 2] = rnd(0, 6.28);
      sw[i3] = rnd(-14, 14); sw[i3 + 1] = rnd(-14, 14); sw[i3 + 2] = rnd(-14, 14);
      sl[i] = rnd(2.6, 3.8); ss[i] = rnd(0.35, 1.5);
    }
    shardActive = SH; shardsDirty = true;
    // glitter + flash
    for (let k = 0; k < 160; k++) {
      const u = rnd(-0.5, 0.5) * p.len;
      add.spawn(p.x + tx * u, y0 + rnd(0, gh), p.z + tz * u, p.nx * rnd(-1, 4) + rnd(-1, 1), rnd(-0.5, 2.5), p.nz * rnd(-1, 4) + rnd(-1, 1),
        rnd(0.6, 1.8), rnd(0.05, 0.12), 0.02, GLIT0, GLIT1, 1, -3.5, 1.4, 0.2);
    }
    if (flashScale > 0) add.spawn(p.x, y0 + gh * 0.5, p.z, 0, 0, 0, 0.25, 2.5, 6.5, WHITE, GLIT1, flashScale, 0, 0, -1);
  }

  function updateShards(dt) {
    if (!shardsDirty) return;
    let alive = 0;
    for (let i = 0; i < SH; i++) {
      if (sl[i] <= 0) continue;
      sl[i] -= dt;
      const i3 = i * 3;
      if (sl[i] <= 0) { shards.setMatrixAt(i, zeroM); continue; }
      alive++;
      sv[i3 + 1] -= 9.8 * dt;
      sp[i3] += sv[i3] * dt; sp[i3 + 1] += sv[i3 + 1] * dt; sp[i3 + 2] += sv[i3 + 2] * dt;
      sr[i3] += sw[i3] * dt; sr[i3 + 1] += sw[i3 + 1] * dt; sr[i3 + 2] += sw[i3 + 2] * dt;
      if (sp[i3 + 1] < 0.015) {
        sp[i3 + 1] = 0.015;
        if (sv[i3 + 1] < 0) sv[i3 + 1] *= -0.25;
        sv[i3] *= 0.55; sv[i3 + 2] *= 0.55;
        sw[i3] *= 0.4; sw[i3 + 1] *= 0.4; sw[i3 + 2] *= 0.4;
        // settle flat on the ice
        sr[i3] += (Math.PI / 2 - (sr[i3] % Math.PI)) * Math.min(1, dt * 8);
        sr[i3 + 2] *= 1 - Math.min(1, dt * 8);
      }
      const sc = ss[i] * Math.min(1, sl[i] / 0.6);
      _e.set(sr[i3], sr[i3 + 1], sr[i3 + 2]); _q.setFromEuler(_e);
      _p.set(sp[i3], sp[i3 + 1], sp[i3 + 2]); _s.set(sc, sc, sc);
      _m.compose(_p, _q, _s);
      shards.setMatrixAt(i, _m);
    }
    shards.instanceMatrix.needsUpdate = true;
    if (!alive) shardsDirty = false;
    shardActive = alive;
  }

  // -------------------------------------------------------------- puck, trail
  // drawn smaller than the arcade collision radius (about twice a real puck) so it sits on the blade
  // instead of swallowing it; the puck marker (players' puck ring) keeps it easy to find
  const pr = PUCK.radius * 0.65, ph = PUCK.height * 0.7;
  const puckGeo = new THREE.CylinderGeometry(pr, pr, ph, 24);
  const puckMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.32, metalness: 0.15, envMapIntensity: 1.2 });
  const puck = new THREE.Mesh(puckGeo, puckMat);
  puck.castShadow = true;
  scene.add(puck);
  const puckMir = new THREE.Mesh(puckGeo, puckMat);
  mirror.add(puckMir);
  // small bright rim so the black puck pops on dark boards
  const rimGeo = new THREE.TorusGeometry(pr * 0.98, 0.008, 4, 24); rimGeo.rotateX(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({ color: 0x8a8f99 }));
  puck.add(rim);
  rim.position.y = ph * 0.5;

  const TN = 15;
  const hist = new Float32Array(TN * 3);
  let histN = 0;
  const tPos = new Float32Array(TN * 2 * 3), tA = new Float32Array(TN * 2);
  const tIdx = [];
  for (let i = 0; i < TN - 1; i++) { const a = i * 2; tIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const trailGeo = new THREE.BufferGeometry();
  const tPosA = new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage);
  const tAA = new THREE.BufferAttribute(tA, 1).setUsage(THREE.DynamicDrawUsage);
  trailGeo.setAttribute('position', tPosA); trailGeo.setAttribute('aA', tAA); trailGeo.setIndex(tIdx);
  const trailMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uCore: { value: new THREE.Color(1, 1, 1) } },
    vertexShader: `attribute float aA; varying float vA; void main(){ vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    // normal (not additive) blending so the colored streak still reads on bright white ice
    fragmentShader: `uniform vec3 uColor; uniform vec3 uCore; varying float vA; void main(){ gl_FragColor = vec4(mix(uColor, uCore, vA * vA * 0.6), vA * 0.85); }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const trail = new THREE.Mesh(trailGeo, trailMat);
  trail.frustumCulled = false; trail.renderOrder = 6;
  scene.add(trail);
  let trailI = 0, puckFire = 0, puckFireT = 0, hot = 0, flameAcc = 0;

  function resetTrail(x, y, z) {
    histN = 0;
    for (let i = 0; i < TN; i++) { hist[i * 3] = x; hist[i * 3 + 1] = y; hist[i * 3 + 2] = z; }
  }

  function updatePuck(k, rx, rz, dt, visible, owned) {
    puck.visible = puckMir.visible = trail.visible = visible;
    if (!visible) { puckFire = 0; return; }
    const y = Math.max(0, k.y || 0);
    puck.position.set(rx, y + ph / 2, rz);
    puckMir.position.copy(puck.position);
    const spd = Math.hypot(k.vx || 0, k.vy || 0, k.vz || 0);
    puck.rotation.y += spd * dt * 0.8;
    if (y > 0.05) { puck.rotation.x += dt * 9; puck.rotation.z += dt * 5; }
    else { puck.rotation.x *= 0.8; puck.rotation.z *= 0.8; }
    puckMir.rotation.copy(puck.rotation);
    // history
    const lx = hist[0], lz = hist[2];
    if (Math.hypot(rx - lx, rz - lz) > 4) resetTrail(rx, y + 0.05, rz);
    for (let i = TN - 1; i > 0; i--) { hist[i * 3] = hist[(i - 1) * 3]; hist[i * 3 + 1] = hist[(i - 1) * 3 + 1]; hist[i * 3 + 2] = hist[(i - 1) * 3 + 2]; }
    hist[0] = rx; hist[1] = y + 0.05; hist[2] = rz;
    histN = Math.min(TN, histN + 1);
    // trail intensity / color by speed
    const target = owned ? 0 : Math.min(1, Math.max(0, (spd - 7) / 14));
    trailI += (target - trailI) * Math.min(1, dt * (target > trailI ? 20 : 6));
    hot += ((spd > 24 && !owned ? 1 : 0) - hot) * Math.min(1, dt * 8);
    if (puckFire) {
      trailMat.uniforms.uColor.value.setRGB(0.95, 0.18, 0.02); trailMat.uniforms.uCore.value.setRGB(1, 0.75, 0.1);
    } else {
      // cool cyan streak for passes, hot orange for hard shots
      trailMat.uniforms.uColor.value.setRGB(0.15 + 0.85 * hot, 0.62 - 0.12 * hot, 1 - 0.95 * hot);
      trailMat.uniforms.uCore.value.setRGB(0.6 + 0.4 * hot, 0.9 - 0.05 * hot, 1 - 0.7 * hot);
    }
    const width = (puckFire ? 0.26 : 0.16) + 0.08 * hot;
    for (let i = 0; i < TN; i++) {
      const a = Math.max(0, i - 1), b = Math.min(TN - 1, i + 1);
      let dx = hist[a * 3] - hist[b * 3], dz = hist[a * 3 + 2] - hist[b * 3 + 2];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const f = 1 - i / (TN - 1);
      const w = width * (0.25 + 0.75 * f);
      const x = hist[i * 3], yy = hist[i * 3 + 1], z = hist[i * 3 + 2];
      const o = i * 6;
      tPos[o] = x - dz * w; tPos[o + 1] = yy; tPos[o + 2] = z + dx * w;
      tPos[o + 3] = x + dz * w; tPos[o + 4] = yy; tPos[o + 5] = z - dx * w;
      const al = (i < histN ? 1 : 0) * trailI * f * f * (puckFire ? 1 : 0.85);
      tA[i * 2] = al; tA[i * 2 + 1] = al;
    }
    tPosA.needsUpdate = true; tAA.needsUpdate = true;
    trail.visible = trailI > 0.01;
    // flaming puck
    if (puckFire) {
      puckFireT += dt;
      if ((spd < 5 && puckFireT > 0.35) || (owned && puckFireT > 0.25) || puckFireT > 3.5) puckFire = 0;
      flameAcc += dt * 140;
      while (flameAcc >= 1) {
        flameAcc -= 1;
        const sys = flameAcc > 0.5 ? alpha : add;
        sys.spawn(rx + rnd(-0.12, 0.12), y + 0.1 + rnd(0, 0.15), rz + rnd(-0.12, 0.12), -(k.vx || 0) * 0.08 + rnd(-0.4, 0.4), rnd(0.8, 2.2), -(k.vz || 0) * 0.08 + rnd(-0.4, 0.4),
          rnd(0.25, 0.5), rnd(0.35, 0.6), 0.06, sys === alpha ? FLAMEA0 : FLAME0, sys === alpha ? FLAMEA1 : FLAME1, 0.9, 1.2, 1.5, -1);
      }
    }
  }

  // -------------------------------------------------------------- flash
  const flashMat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0 }, uC: { value: new THREE.Color(1, 1, 1) } },
    vertexShader: `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform float uA; uniform vec3 uC; void main(){ gl_FragColor = vec4(uC, uA); }`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), flashMat);
  flash.frustumCulled = false; flash.renderOrder = 1000; flash.visible = false;
  scene.add(flash);
  let flashA = 0;

  // -------------------------------------------------------------- public spawners
  // sparks: half additive (glow against dark boards/crowd), half alpha-blended saturated (reads on white ice)
  function sparks(x, y, z, n, speed = 6) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, up = rnd(0.2, 1);
      const s = rnd(0.3, 1) * speed;
      const sys = k & 1 ? alpha : add;
      sys.spawn(x, y, z, Math.cos(a) * s, up * s * 0.8, Math.sin(a) * s, rnd(0.2, 0.55), rnd(0.07, 0.14), 0.02,
        k & 1 ? SPARKA0 : SPARK0, k & 1 ? SPARKA1 : SPARK1, 1, -12, 1.2, 0.35);
    }
  }
  function iceSpray(x, z, vx, vz, n) {
    for (let k = 0; k < n; k++) {
      alpha.spawn(x + rnd(-0.2, 0.2), rnd(0.03, 0.15), z + rnd(-0.2, 0.2), vx * rnd(0.4, 1.1) + rnd(-1.2, 1.2), rnd(0.5, 2.5), vz * rnd(0.4, 1.1) + rnd(-1.2, 1.2),
        rnd(0.35, 0.8), rnd(0.1, 0.2), rnd(0.3, 0.5), ICE0, ICE1, 0.85, -7, 2.8, 0.1);
    }
  }
  function hit(x, z, power, big) {
    const n = Math.round(10 + power * 40 + (big ? 30 : 0));
    sparks(x, 1.0, z, n, 5 + power * 6);
    for (let k = 0; k < (big ? 50 : 18); k++) {
      const a = Math.random() * Math.PI * 2, s = rnd(1, 5 + power * 3);
      alpha.spawn(x, rnd(0.05, 0.4), z, Math.cos(a) * s, rnd(0.5, 3), Math.sin(a) * s, rnd(0.4, 0.9), rnd(0.12, 0.22), rnd(0.35, 0.6), ICE0, ICE1, 0.9, -8, 2.2, 0.1);
    }
    if (big && flashScale > 0) add.spawn(x, 1.0, z, 0, 0, 0, 0.22, 1.5, 4.5, WHITE, SPARK1, flashScale, 0, 0, -1);
  }
  let flameN = 0;
  function flame(x, y, z, vx, vz, size, c0, c1) {
    // alternate: saturated alpha-blended licks (visible over white ice) + additive glowing cores
    if ((flameN++ & 1) === 0) alpha.spawn(x, y, z, vx + rnd(-0.25, 0.25), rnd(1.4, 2.6), vz + rnd(-0.25, 0.25), rnd(0.35, 0.6), size * 0.8, size * 0.15, FLAMEA0, FLAMEA1, 0.8, 1.6, 1.3, -1);
    else add.spawn(x, y, z, vx + rnd(-0.25, 0.25), rnd(1.4, 2.6), vz + rnd(-0.25, 0.25), rnd(0.4, 0.7), size, size * 0.2, c0 || FLAME0, c1 || FLAME1, 0.85, 1.6, 1.3, -1);
  }
  function chargeSpark(x, y, z) {
    add.spawn(x, y, z, rnd(-1.5, 1.5), rnd(0.5, 2.5), rnd(-1.5, 1.5), rnd(0.15, 0.35), rnd(0.05, 0.1), 0.01, CHG0, CHG1, 1, -4, 1, -1);
  }
  const conf = [C(1, 0.2, 0.2), C(1, 0.85, 0.2), C(0.2, 0.8, 1), C(1, 1, 1), C(1, 0.3, 0.9), C(0.3, 1, 0.5)];
  function goalBurst(x, z, colA, colB) {
    for (let k = 0; k < 220; k++) {
      const c = k % 3 === 0 ? colA : k % 3 === 1 ? colB : conf[(Math.random() * conf.length) | 0];
      const a = Math.random() * Math.PI * 2, s = rnd(1, 7);
      add.spawn(x, rnd(2.5, 4), z, Math.cos(a) * s, rnd(2, 8), Math.sin(a) * s, rnd(1.2, 2.4), rnd(0.08, 0.15), 0.05, c, c, 1, -5, 1.1, 0.1);
    }
    sparks(x, 1.0, z, 40, 7);
  }
  let flashScale = 1, shardShare = 1;
  function setFlash(a, r = 1, g = 1, b = 1) {
    a *= flashScale;
    if (a > flashA) { flashA = a; flashMat.uniforms.uC.value.setRGB(r, g, b); }
  }

  return {
    sparks, iceSpray, hit, flame, chargeSpark, shatter, goalBurst, setFlash,
    resetTrail,
    puckFire() { puckFire = 1; puckFireT = 0; },
    updatePuck,
    puck,
    /** Rendered puck radius (m): the renderer seats a carried puck this far in front of the blade. */
    puckRadius: pr,
    setPointScale(s) { uScale.value = s; },
    /** 0..1 multiplier for particle / shard counts (quality 'low' uses 0.5). */
    setDensity(d) { add.density = alpha.density = Math.max(0.1, Math.min(1, d)); shardShare = add.density; },
    /** 0 = no full-screen flashes (accessibility), 1 = normal. */
    setFlashScale(s) { flashScale = Math.max(0, Math.min(1, s)); },
    update(dt) {
      add.update(dt); alpha.update(dt); updateShards(dt);
      flashA = Math.max(0, flashA - dt * 3.2);
      flash.visible = flashA > 0.003;
      flashMat.uniforms.uA.value = flashA;
    },
    stats() { return { additive: add.n, alpha: alpha.n, shards: shardActive }; },
  };
}
