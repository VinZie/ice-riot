// ICE RIOT renderer - arena: stands, instanced crowd (GPU-animated), jumbotron, LED ribbon,
// rafters + light rigs, sweeping celebration beams, and the procedural environment map.
import * as THREE from 'three';
import { RINK, TEAMS } from '/shared/constants.js';
import { outline, sweepBand, mergeGeometries, rng, lin } from './util.js';
import { makeCanvas, canvasTex, drawJumbotron, makeRibbonTexture, makeSuiteTexture, makeRadialTexture } from './textures.js';

const LOWER = { o0: 2.4, rows: 13, depth: 0.9, rise: 0.5, h0: 1.25 };
const UPPER = { o0: 16.4, rows: 10, depth: 0.95, rise: 0.62, h0: 9.9 };
const RIBBON = { off: 15.0, y0: 7.95, y1: 9.15 };

/** Build a PMREM environment from a tiny procedural "arena" scene (dark bowl, bright rafters, white ice bounce). */
export function buildEnvironment(renderer) {
  const env = new THREE.Scene();
  const geos = [], mats = [];
  const add = (geo, color, pos, rot) => {
    const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, m);
    if (pos) mesh.position.set(...pos);
    if (rot) mesh.rotation.set(...rot);
    env.add(mesh); geos.push(geo); mats.push(m);
    return mesh;
  };
  add(new THREE.BoxGeometry(120, 50, 90), new THREE.Color(0.012, 0.016, 0.028), [0, 20, 0]);
  add(new THREE.PlaneGeometry(60, 26), new THREE.Color(0.75, 0.8, 0.86), [0, -0.2, 0], [-Math.PI / 2, 0, 0]);
  // stands band (dim, colorful)
  add(new THREE.CylinderGeometry(48, 40, 14, 24, 1, true), new THREE.Color(0.05, 0.05, 0.08), [0, 7, 0]);
  // rafters: rows of hot light panels
  const hot = new THREE.Color(7, 7, 6.5);
  for (let i = -2; i <= 2; i++) for (const z of [-9, 0, 9]) add(new THREE.BoxGeometry(6, 0.3, 1.2), hot, [i * 12, 24, z]);
  add(new THREE.BoxGeometry(8, 4, 5), new THREE.Color(0.4, 0.5, 0.9), [0, 14, 0]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.035, 0.1, 200);
  pmrem.dispose();
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
  return rt;
}

export function createArena(scene, aniso, track) {
  const group = new THREE.Group();
  group.name = 'arena';
  scene.add(group);

  // ------------------------------------------------------------------ stands (one merged mesh)
  const parts = [];
  const tier = (cfg, seatHex, riserHex) => {
    // front wall of the first row
    parts.push(sweepBand(cfg.o0, 0, cfg.o0, cfg.h0, -1, 0, 24, null, 0x1b1f2a));
    for (let i = 0; i < cfg.rows; i++) {
      const o = cfg.o0 + i * cfg.depth, h = cfg.h0 + i * cfg.rise;
      parts.push(sweepBand(o, h, o + cfg.depth, h, 0, 1, 24, null, i % 2 ? seatHex : riserHex));
      parts.push(sweepBand(o + cfg.depth, h, o + cfg.depth, h + cfg.rise, -1, 0, 24, null, 0x0e1118));
    }
  };
  tier(LOWER, 0x1c2438, 0x182033);
  tier(UPPER, 0x1a2030, 0x161b29);
  // concourse gap between the bowls + back wall
  const lowTop = LOWER.h0 + LOWER.rows * LOWER.rise, lowBack = LOWER.o0 + LOWER.rows * LOWER.depth;
  parts.push(sweepBand(lowBack, lowTop, UPPER.o0, lowTop, 0, 1, 24, null, 0x0b0d13));
  parts.push(sweepBand(UPPER.o0, lowTop, UPPER.o0, UPPER.h0, -1, 0, 24, null, 0x0b0d13));
  const upTop = UPPER.h0 + UPPER.rows * UPPER.rise, upBack = UPPER.o0 + UPPER.rows * UPPER.depth;
  parts.push(sweepBand(upBack, upTop, upBack, upTop + 6, -1, 0, 24, null, 0x07080c));
  const standMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const stands = new THREE.Mesh(mergeGeometries(parts), standMat);
  group.add(stands);

  // suites band above the upper bowl
  const suiteTex = track(makeSuiteTexture());
  const per = outline(upBack).total;
  suiteTex.repeat.set(1, 1);
  const suites = new THREE.Mesh(
    sweepBand(upBack - 0.05, upTop + 0.6, upBack - 0.05, upTop + 2.4, -1, 0, 24, (s, k) => [s / 12, k]),
    new THREE.MeshBasicMaterial({ map: suiteTex, toneMapped: false, color: 0xbbbbbb }));
  group.add(suites);

  // LED ribbon on the fascia between bowls
  const ribbonTex = track(makeRibbonTexture('ads'));
  const goalRibbonTex = track(makeRibbonTexture('goal', 0xff3030));
  const ribbonPer = outline(0).total;
  const ribbonMat = new THREE.MeshBasicMaterial({ map: ribbonTex, toneMapped: false, color: 0xffffff });
  const ribbonGeo = sweepBand(RIBBON.off, RIBBON.y0, RIBBON.off, RIBBON.y1, -1, 0, 24, (s, k) => [s / ribbonPer * Math.round(ribbonPer / 34), k]);
  const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
  group.add(ribbon);

  // rafters: dark ceiling, two trusses, light fixtures + glows
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(140, 110), new THREE.MeshBasicMaterial({ color: 0x030408 }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = 26;
  group.add(ceil);
  const truss = [], fixtures = [];
  for (const z of [-8.5, 8.5]) {
    const g = new THREE.BoxGeometry(64, 0.6, 0.6); g.translate(0, 21.5, z); truss.push(g);
  }
  for (const x of [-26, 26]) { const g = new THREE.BoxGeometry(0.6, 0.6, 17); g.translate(x, 21.5, 0); truss.push(g); }
  const trussMesh = new THREE.Mesh(mergeGeometries(truss), new THREE.MeshLambertMaterial({ color: 0x1a1d24 }));
  group.add(trussMesh);
  const glowTex = track(makeRadialTexture([[0, 'rgba(255,255,255,1)'], [0.15, 'rgba(255,250,235,0.7)'], [0.5, 'rgba(255,240,210,0.12)'], [1, 'rgba(255,240,210,0)']]));
  const glowPos = [];
  for (const z of [-8.5, 8.5]) for (let i = 0; i < 9; i++) {
    const x = -24 + i * 6;
    const g = new THREE.BoxGeometry(1.0, 0.35, 0.8); g.translate(x, 21.05, z); fixtures.push(g);
    glowPos.push(x, 20.8, z);
  }
  const fixtureMesh = new THREE.Mesh(mergeGeometries(fixtures), new THREE.MeshBasicMaterial({ color: 0xfff6e8, toneMapped: false }));
  group.add(fixtureMesh);
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
  const glows = new THREE.Points(glowGeo, new THREE.PointsMaterial({
    map: glowTex, size: 7, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xfff1d6, opacity: 0.8, fog: false,
  }));
  group.add(glows);

  // ------------------------------------------------------------------ crowd
  const rand = rng(4242);
  const seats = [];
  const fillRow = (o, h, spacing, fill) => {
    const path = outline(o);
    const n = Math.floor(path.total / spacing);
    for (let k = 0; k < n; k++) {
      if (rand() > fill) continue;
      const s = (k + 0.5 + (rand() - 0.5) * 0.25) * path.total / n;
      // aisles every ~14 m
      if ((s % 14) < 1.1) continue;
      const p = path.at(s);
      seats.push({ x: p.x, z: p.z, y: h, nx: p.nx, nz: p.nz, ang: Math.atan2(p.z, p.x * 0.45) });
    }
  };
  for (let i = 0; i < LOWER.rows; i++) fillRow(LOWER.o0 + i * LOWER.depth + 0.42, LOWER.h0 + i * LOWER.rise, 0.72, 0.9);
  for (let i = 0; i < UPPER.rows; i++) fillRow(UPPER.o0 + i * UPPER.depth + 0.45, UPPER.h0 + i * UPPER.rise, 0.75, 0.42);
  // shuffle so any prefix of the instance list is a uniform random subset (crowd density = instanceCount)
  for (let i = seats.length - 1; i > 0; i--) { const j = (rand() * (i + 1)) | 0; const t = seats[i]; seats[i] = seats[j]; seats[j] = t; }
  const COUNT = seats.length;

  // one fan = torso + head + two arms; only faces that can be seen (no back/bottom)
  const fanParts = [];
  const pushBox = (x0, x1, y0, y1, z0, z1, part, faces) => {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    // BoxGeometry groups: +x, -x, +y, -y, +z, -z ; keep the requested ones
    const ng = g.toNonIndexed();
    g.dispose();
    const pos = ng.attributes.position.array, nrm = ng.attributes.normal.array;
    const keep = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 };
    const want = faces.map((f) => keep[f]);
    const P = [], N = [], A = [];
    for (let f = 0; f < 6; f++) {
      if (!want.includes(f)) continue;
      for (let v = 0; v < 6; v++) {
        const i = (f * 6 + v) * 3;
        P.push(pos[i], pos[i + 1], pos[i + 2]); N.push(nrm[i], nrm[i + 1], nrm[i + 2]); A.push(part);
      }
    }
    ng.dispose();
    fanParts.push({ P, N, A });
  };
  pushBox(-0.2, 0.2, 0.0, 0.56, -0.12, 0.12, 0, ['pz', 'py', 'px', 'nx']);
  pushBox(-0.1, 0.1, 0.6, 0.82, -0.1, 0.1, 1, ['pz', 'py', 'px', 'nx']);
  pushBox(-0.3, -0.2, 0.12, 0.52, -0.06, 0.06, 2, ['pz', 'py', 'nx', 'ny']);
  pushBox(0.2, 0.3, 0.12, 0.52, -0.06, 0.06, 3, ['pz', 'py', 'px', 'ny']);
  const fP = [], fN = [], fA = [];
  for (const p of fanParts) { fP.push(...p.P); fN.push(...p.N); fA.push(...p.A); }
  const fanGeo = new THREE.InstancedBufferGeometry();
  fanGeo.setAttribute('position', new THREE.Float32BufferAttribute(fP, 3));
  fanGeo.setAttribute('normal', new THREE.Float32BufferAttribute(fN, 3));
  fanGeo.setAttribute('aPart', new THREE.Float32BufferAttribute(fA, 1));
  fanGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(fP.length).fill(1), 3));
  const shirt = new Float32Array(COUNT * 3), meta = new Float32Array(COUNT * 4);
  const fanTeam = new Uint8Array(COUNT);
  const crowdMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const uniforms = {
    uTime: { value: 0 }, uJump: { value: new THREE.Vector2(0, 0) }, uHype: { value: 0 },
    uWave: { value: 0 }, uWaveAmp: { value: 0 }, uSelf: { value: 0.22 }, uFlash: { value: 0 }, uFlashOn: { value: 1 },
  };
  crowdMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = `attribute float aPart; attribute vec3 iShirt; attribute vec4 iMeta;
uniform float uTime; uniform vec2 uJump; uniform float uHype; uniform float uWave; uniform float uWaveAmp; uniform float uFlash; uniform float uFlashOn;
varying float vFlash;
` + sh.vertexShader
      .replace('#include <color_vertex>', `
  {
    vec3 skin = mix(vec3(0.93, 0.66, 0.5), vec3(0.22, 0.12, 0.07), iMeta.w);
    vColor = (aPart > 0.5 && aPart < 1.5) ? skin : iShirt;
  }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    float seed = iMeta.x, team = iMeta.y, ang = iMeta.z;
    float jumpAmt = team < 0.5 ? uJump.x : (team < 1.5 ? uJump.y : 0.4 * max(uJump.x, uJump.y));
    jumpAmt = max(jumpAmt, uHype * (0.4 + 0.6 * seed));
    float bob = sin(uTime * (1.6 + seed * 2.2) + seed * 50.0) * 0.022;
    float hop = max(0.0, sin(uTime * (7.0 + seed * 4.0) + seed * 31.0)) * 0.34 * jumpAmt;
    float dw = mod(ang - uWave + 3.14159265, 6.2831853) - 3.14159265;
    float wave = exp(-dw * dw * 9.0) * uWaveAmp;
    float arm = clamp(max(jumpAmt * 1.4, wave * 1.8), 0.0, 1.0) * (0.55 + 0.45 * fract(seed * 7.13));
    if (aPart > 1.5) {
      float side = aPart < 2.5 ? -1.0 : 1.0;
      vec2 piv = vec2(side * 0.25, 0.5);
      float a = side * (arm * 2.6 + sin(uTime * 10.0 + seed * 20.0) * 0.3 * jumpAmt);
      vec2 q = transformed.xy - piv;
      float c = cos(a), s = sin(a);
      transformed.xy = piv + vec2(c * q.x - s * q.y, s * q.x + c * q.y);
    }
    transformed.y += bob + hop + wave * 0.42;
    float fl = fract(sin(seed * 913.7 + floor(uTime * 9.0 + seed * 3.0) * 17.3) * 43758.5453);
    vFlash = step(0.997 - uFlash * 0.012, fl) * (0.3 + uFlash) * uFlashOn;
  }`);
    sh.fragmentShader = `uniform float uSelf; varying float vFlash;
` + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += vColor * uSelf + vec3(vFlash * 3.0);`);
  };
  crowdMat.customProgramCacheKey = () => 'iceriot-crowd';
  const crowd = new THREE.Mesh(fanGeo, crowdMat);
  fanGeo.instanceCount = COUNT;
  const offsets = new Float32Array(COUNT * 4); // xyz + rotation
  for (let i = 0; i < COUNT; i++) {
    const s = seats[i];
    offsets[i * 4] = s.x; offsets[i * 4 + 1] = s.y; offsets[i * 4 + 2] = s.z;
    offsets[i * 4 + 3] = Math.atan2(-s.nx, -s.nz);
    const awaySector = s.x > 18 && Math.abs(s.z) < 18;
    const r = rand();
    fanTeam[i] = awaySector ? (r < 0.72 ? 1 : r < 0.9 ? 0 : 2) : (r < 0.8 ? 0 : r < 0.9 ? 1 : 2);
    meta[i * 4] = rand(); meta[i * 4 + 1] = fanTeam[i]; meta[i * 4 + 2] = s.ang; meta[i * 4 + 3] = rand();
  }
  fanGeo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(offsets, 4));
  fanGeo.setAttribute('iShirt', new THREE.InstancedBufferAttribute(shirt, 3));
  fanGeo.setAttribute('iMeta', new THREE.InstancedBufferAttribute(meta, 4));
  // place instances via the iOffset attribute (rotation about Y + translation) before the main transform
  const prevCompile = crowdMat.onBeforeCompile;
  crowdMat.onBeforeCompile = (sh) => {
    prevCompile(sh);
    sh.vertexShader = 'attribute vec4 iOffset;\n' + sh.vertexShader
      .replace('#include <project_vertex>', `
  {
    float cr = cos(iOffset.w), sr = sin(iOffset.w);
    transformed = vec3(cr * transformed.x + sr * transformed.z, transformed.y, -sr * transformed.x + cr * transformed.z) + iOffset.xyz;
  }
  #include <project_vertex>`)
      .replace('#include <defaultnormal_vertex>', `
  {
    float cr0 = cos(iOffset.w), sr0 = sin(iOffset.w);
    objectNormal = vec3(cr0 * objectNormal.x + sr0 * objectNormal.z, objectNormal.y, -sr0 * objectNormal.x + cr0 * objectNormal.z);
  }
  #include <defaultnormal_vertex>`);
  };
  crowd.frustumCulled = false;
  group.add(crowd);

  const neutral = [0x3a3f4a, 0x6b6f78, 0x23262d, 0x8a2b2b, 0x2b4f8a, 0x4a7a3a, 0xc9c9c9, 0x7a5a2b, 0x5a2b7a];
  const tmp = [0, 0, 0];
  function setCrowdColors(h, a) {
    const th = TEAMS[h] || TEAMS[0], ta = TEAMS[a] || TEAMS[1];
    const r2 = rng(777);
    for (let i = 0; i < COUNT; i++) {
      const t = fanTeam[i];
      const r = r2();
      let hex;
      if (t === 2) hex = neutral[(r2() * neutral.length) | 0];
      else {
        const c = (t === 0 ? th : ta).colors;
        hex = r < 0.55 ? c.primary : r < 0.78 ? c.secondary : r < 0.86 ? c.accent : neutral[(r2() * neutral.length) | 0];
      }
      lin(hex, tmp);
      const k = 0.75 + r2() * 0.35;
      shirt[i * 3] = tmp[0] * k; shirt[i * 3 + 1] = tmp[1] * k; shirt[i * 3 + 2] = tmp[2] * k;
    }
    fanGeo.attributes.iShirt.needsUpdate = true;
  }

  // ------------------------------------------------------------------ jumbotron
  const jumbo = new THREE.Group();
  jumbo.position.set(0, 13.2, 0);
  group.add(jumbo);
  const JW = 7.2, JH = 3.6, JD = 4.6;
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x15181f, roughness: 0.6, metalness: 0.5 });
  const jFrame = new THREE.Mesh(new THREE.BoxGeometry(JW + 0.3, JH + 0.5, JD + 0.3), frameMat);
  jumbo.add(jFrame);
  const jCanvas = makeCanvas(1024, 512);
  const jTex = track(canvasTex(jCanvas, { aniso }));
  const screens = [];
  const sGeo = (w, h, x, z, ry) => { const g = new THREE.PlaneGeometry(w, h); g.rotateY(ry); g.translate(x, 0, z); return g; };
  screens.push(sGeo(JW, JH, 0, JD / 2 + 0.16, 0));
  screens.push(sGeo(JW, JH, 0, -JD / 2 - 0.16, Math.PI));
  screens.push(sGeo(JD, JH, JW / 2 + 0.16, 0, Math.PI / 2));
  screens.push(sGeo(JD, JH, -JW / 2 - 0.16, 0, -Math.PI / 2));
  const jScreens = new THREE.Mesh(mergeGeometries(screens), new THREE.MeshBasicMaterial({ map: jTex, toneMapped: false }));
  jumbo.add(jScreens);
  // LED rings above/below the screens
  const ringTex = track(makeRibbonTexture('ads'));
  const ringGeo = new THREE.CylinderGeometry(4.9, 4.9, 0.55, 48, 1, true);
  const jRingMat = new THREE.MeshBasicMaterial({ map: ringTex, toneMapped: false, side: THREE.DoubleSide });
  const jRing = new THREE.Mesh(ringGeo, jRingMat);
  jRing.position.y = -JH / 2 - 0.75;
  jRing.scale.set(1, 1, 0.72);
  jumbo.add(jRing);
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 10, 6), frameMat);
  cable.position.y = JH / 2 + 5;
  jumbo.add(cable);
  let jKey = '';
  function setJumbo(teams, sc, per, mode) {
    const key = `${teams[0]}|${teams[1]}|${sc[0]}|${sc[1]}|${per}|${mode}`;
    if (key === jKey) return;
    jKey = key;
    drawJumbotron(jCanvas, teams, sc, per, mode);
    jTex.needsUpdate = true;
  }

  // ------------------------------------------------------------------ celebration beams
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 } },
    vertexShader: `attribute vec3 color; varying vec3 vC; varying float vY; varying vec3 vN; varying vec3 vV;
      void main(){ vC = color; vY = uv.y; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uI; varying vec3 vC; varying float vY; varying vec3 vN; varying vec3 vV;
      void main(){ float edge = pow(abs(dot(vN, vV)), 1.5); float a = uI * (0.15 + 0.85 * vY) * edge * 0.32; gl_FragColor = vec4(vC * a, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const beams = [];
  const beamGeo = new THREE.CylinderGeometry(0.35, 2.6, 21, 20, 1, true);
  beamGeo.translate(0, -10.5, 0);
  const beamColors = [0xff3b3b, 0x3bc6ff, 0xffd23f, 0xff3bd2, 0x3bff8a, 0xffffff];
  for (let i = 0; i < 6; i++) {
    const g = beamGeo.clone();
    const c = new Float32Array(g.attributes.position.count * 3);
    const rgb = lin(beamColors[i]);
    for (let k = 0; k < c.length; k += 3) { c[k] = rgb[0]; c[k + 1] = rgb[1]; c[k + 2] = rgb[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const m = new THREE.Mesh(g, beamMat);
    const x = -25 + i * 10;
    m.position.set(x, 21, i % 2 ? 8.5 : -8.5);
    m.renderOrder = 4;
    group.add(m);
    beams.push({ m, ph: i * 1.3, base: rgb });
  }
  beamGeo.dispose();

  // ------------------------------------------------------------------ state
  const state = { jump: [0, 0], hype: 0, wave: 0, waveAmp: 0, beams: 0, goalRibbon: 0, flash: 0 };
  function update(dt, time, opts) {
    uniforms.uTime.value = time;
    state.jump[0] = Math.max(0, state.jump[0] - dt * 0.28);
    state.jump[1] = Math.max(0, state.jump[1] - dt * 0.28);
    state.hype = Math.max(0, state.hype - dt * 0.9);
    state.flash = Math.max(0, state.flash - dt * 0.25);
    uniforms.uJump.value.set(state.jump[0], state.jump[1]);
    uniforms.uHype.value = Math.min(1, state.hype);
    uniforms.uFlash.value = Math.min(1, state.flash + Math.max(state.jump[0], state.jump[1]) * 0.6);
    const waveOn = opts.wave ? 1 : 0;
    state.waveAmp += (waveOn - state.waveAmp) * Math.min(1, dt * 0.8);
    state.wave = (state.wave + dt * 0.55) % (Math.PI * 2);
    uniforms.uWave.value = state.wave - Math.PI;
    uniforms.uWaveAmp.value = state.waveAmp;
    // beams
    const bt = opts.beams || 0;
    state.beams += (bt - state.beams) * Math.min(1, dt * 3);
    beamMat.uniforms.uI.value = state.beams;
    const showBeams = state.beams > 0.01;
    for (const b of beams) {
      b.m.visible = showBeams;
      if (!showBeams) continue;
      b.m.rotation.z = Math.sin(time * 0.9 + b.ph) * 0.55;
      b.m.rotation.x = Math.cos(time * 0.7 + b.ph * 1.7) * 0.4;
    }
    // ribbon scroll + goal mode
    const useGoal = opts.goalTeamColor != null;
    ribbonMat.map = useGoal ? goalRibbonTex : ribbonTex;
    ribbonMat.color.setHex(useGoal ? opts.goalTeamColor : 0xffffff);
    if (useGoal && !calm) ribbonMat.color.multiplyScalar(0.75 + 0.25 * Math.sin(time * 12));
    ribbonTex.offset.x = (time * 0.035) % 1;
    goalRibbonTex.offset.x = (time * 0.12) % 1;
    ringTex.offset.x = (-time * 0.05) % 1;
    jRing.rotation.y = 0;
  }

  let calm = false;
  return {
    group, jumbo, crowd, crowdCount: COUNT,
    setTeams(h, a) { setCrowdColors(h, a); },
    /** 0..1 fraction of fans drawn (quality 'low' uses 0.5). */
    setCrowdDensity(d) { fanGeo.instanceCount = Math.max(1, Math.round(COUNT * Math.max(0.1, Math.min(1, d)))); },
    /** reduceFlashes: no crowd camera flashes, no strobing LED ribbon. */
    setReduceFlashes(v) { calm = !!v; uniforms.uFlashOn.value = calm ? 0 : 1; },
    setJumbo,
    cheer(team, amt = 1) { if (team === 0 || team === 1) state.jump[team] = Math.min(1.2, state.jump[team] + amt); state.flash = Math.min(1, state.flash + 0.5 * amt); },
    hype(amt) { state.hype = Math.min(1.5, state.hype + amt); },
    update,
  };
}
