// ICE RIOT renderer - phones in the crowd.
//
// About 7% of the fans hold a phone up (a dark slab with a softly glowing screen, at chest to face
// height, gently swaying); goals, fights and big hype raise up to ~18%, and they come down again as the
// moment passes. A few phones pop a tiny camera flash at big moments (never with reduceFlashes).
// One instanced mesh = one draw call: body + screen + a small additive glow card per phone (premultiplied
// blending, so the opaque body and the additive glow share a material). The fans' motion is the same GLSL
// as the crowd (CROWD_MOTION_GLSL, also used by arena.js), and the holder's right arm is raised by the
// crowd shader from the same per-fan `iUp` value, so phone and hand stay together.
import * as THREE from 'three';

/** Uniform declarations + crowd motion shared by the crowd and the phones (keep them in lockstep). */
export const CROWD_MOTION_GLSL = /* glsl */`
uniform float uTime; uniform vec2 uJump; uniform float uHype; uniform float uWave; uniform float uWaveAmp;
// x: vertical offset of the whole fan, y: jump amount, z: arm raise
vec3 crowdMotion(vec4 meta) {
  float seed = meta.x, team = meta.y, ang = meta.z;
  float jumpAmt = team < 0.5 ? uJump.x : (team < 1.5 ? uJump.y : 0.4 * max(uJump.x, uJump.y));
  jumpAmt = max(jumpAmt, uHype * (0.4 + 0.6 * seed));
  float bob = sin(uTime * (1.6 + seed * 2.2) + seed * 50.0) * 0.022;
  float hop = max(0.0, sin(uTime * (7.0 + seed * 4.0) + seed * 31.0)) * 0.34 * jumpAmt;
  float dw = mod(ang - uWave + 3.14159265, 6.2831853) - 3.14159265;
  float wave = exp(-dw * dw * 9.0) * uWaveAmp;
  float arm = clamp(max(jumpAmt * 1.4, wave * 1.8), 0.0, 1.0) * (0.55 + 0.45 * fract(seed * 7.13));
  return vec3(bob + hop + wave * 0.42, jumpAmt, arm);
}
// phone holders: eased lift (0..1) and how far forward/up the right arm swings (chest .. face height)
float phoneLift(float up) { return up * up * (3.0 - 2.0 * up); }
float phoneHold(float seed) { return mix(1.45, 2.2, fract(seed * 13.37)); }
`;

export const PHONES = { BASE: 0.07, PEAK: 0.185, POOL: 0.2 };

const PW = 0.085, PH = 0.165, PD = 0.014; // phone size (m), a touch oversized so it reads from the broadcast camera

function phoneGeometry() {
  const P = [], K = [];
  const quad = (a, b, c, d, kind) => { P.push(...a, ...b, ...c, ...a, ...c, ...d); for (let i = 0; i < 6; i++) K.push(kind); };
  const x = PW / 2, y = PH / 2, z = PD / 2;
  quad([-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], 0);                 // front (bezel)
  quad([-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z], 0.4);              // top edge
  quad([x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z], 0);                // sides
  quad([-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z], 0);
  const sx = x - 0.006, sy0 = -y + 0.013, sy1 = y - 0.01, sz = z + 0.0015;
  quad([-sx, sy0, sz], [sx, sy0, sz], [sx, sy1, sz], [-sx, sy1, sz], 1);  // screen
  quad([-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], 2);                // glow card (corners)
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(K, 1));
  return g;
}

/**
 * fans: { count, offsets: Float32Array(count*4) xyz+yaw, meta: Float32Array(count*4) seed/team/ang/skin }
 * uniforms: the crowd's uniform objects (uTime, uJump, uHype, uWave, uWaveAmp, uFlash, uFlashOn) - shared by reference.
 * rand: deterministic PRNG.
 * Returns { mesh, fanUp (InstancedBufferAttribute for the crowd's `iUp`), setFanCount(n), update(dt, excite), setTeamColors(a, b) }.
 */
export function createCrowdPhones({ count, offsets, meta, uniforms, rand }) {
  // pick the pool of potential phone holders; rank decides who goes up first
  const fanIdx = [], rank = [];
  for (let i = 0; i < count; i++) {
    const r = rand();
    if (r < PHONES.POOL) { fanIdx.push(i); rank.push(r); }
  }
  const N = fanIdx.length;
  const prefix = new Uint32Array(count + 1); // phones whose fan index is < n
  for (let p = 0, i = 0; i <= count; i++) { while (p < N && fanIdx[p] < i) p++; prefix[i] = p; }

  const iOff = new Float32Array(N * 4), iMeta = new Float32Array(N * 4), iPh = new Float32Array(N * 4);
  const up = new Float32Array(N), rate = new Float32Array(N), rk = new Float32Array(rank);
  const fanUpArr = new Float32Array(count);
  for (let p = 0; p < N; p++) {
    const f = fanIdx[p];
    for (let k = 0; k < 4; k++) { iOff[p * 4 + k] = offsets[f * 4 + k]; iMeta[p * 4 + k] = meta[f * 4 + k]; }
    iPh[p * 4] = rank[p]; iPh[p * 4 + 1] = rand(); iPh[p * 4 + 2] = rand(); iPh[p * 4 + 3] = rand();
    rate[p] = 1.6 + rand() * 2.4;
    up[p] = rank[p] < PHONES.BASE ? 1 : 0;
    fanUpArr[f] = up[p];
  }
  const geo = phoneGeometry();
  geo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(iOff, 4));
  geo.setAttribute('iMeta', new THREE.InstancedBufferAttribute(iMeta, 4));
  geo.setAttribute('iPh', new THREE.InstancedBufferAttribute(iPh, 4));
  const upAttr = new THREE.InstancedBufferAttribute(up, 1);
  upAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iUp', upAttr);
  geo.instanceCount = N;
  const fanUp = new THREE.InstancedBufferAttribute(fanUpArr, 1);
  fanUp.setUsage(THREE.DynamicDrawUsage);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: uniforms.uTime, uJump: uniforms.uJump, uHype: uniforms.uHype, uWave: uniforms.uWave, uWaveAmp: uniforms.uWaveAmp,
      uFlash: uniforms.uFlash, uFlashOn: uniforms.uFlashOn,
      uTeamA: { value: new THREE.Color(1, 1, 1) }, uTeamB: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: /* glsl */`
attribute float aKind; attribute vec4 iOffset; attribute vec4 iMeta; attribute vec4 iPh; attribute float iUp;
uniform float uFlash; uniform float uFlashOn; uniform vec3 uTeamA; uniform vec3 uTeamB;
varying vec3 vCol; varying vec2 vQ; varying float vKind; varying float vA;
${CROWD_MOTION_GLSL}
float hash11(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vKind = aKind; vQ = position.xy; vA = 0.0; vCol = vec3(0.0);
  if (iUp < 0.003) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float seed = iMeta.x, team = iMeta.y;
  vec3 mo = crowdMotion(iMeta);
  float lift = phoneLift(iUp);
  float th = -lift * phoneHold(seed);
  vec3 hand = vec3(0.25, 0.5 - 0.38 * cos(th), -0.38 * sin(th));
  float sw = sin(uTime * (1.1 + seed * 0.9) + seed * 37.0);
  vec3 anchor = hand + vec3(-0.05 + sw * 0.012, 0.085, 0.015);
  anchor.y += mo.x;
  float k = smoothstep(0.0, 0.6, iUp);
  // a few phones pop a camera flash at big moments (10 slots a second)
  float fl = hash11(iPh.w * 97.13 + floor(uTime * 10.0 + iPh.w * 7.0) * 1.618);
  float flash = step(1.0 - (0.0006 + uFlash * 0.006), fl) * uFlashOn * step(0.95, iUp);
  // screen: camera viewfinder blue, warm white, or a team-coloured "sign"
  float kind = iPh.z;
  vec3 scol = kind < 0.55 ? vec3(0.6, 0.76, 1.0) : (kind < 0.8 ? vec3(1.0, 0.88, 0.7) : (team < 0.5 ? uTeamA : (team < 1.5 ? uTeamB : vec3(0.85))));
  scol *= 1.05 * (0.86 + 0.14 * sin(uTime * 1.7 + seed * 23.0));
  float cr = cos(iOffset.w), sr = sin(iOffset.w);
  vec4 mv;
  if (aKind > 1.5) {
    vec3 c = anchor;
    mv = modelViewMatrix * vec4(vec3(cr * c.x + sr * c.z, c.y, -sr * c.x + cr * c.z) + iOffset.xyz, 1.0);
    mv.xy += position.xy * mix(0.19, 0.5, flash) * k;
    mv.z += 0.05;
    vA = mix(0.3, 2.4, flash);
    vCol = mix(scol, vec3(1.0, 0.97, 0.92), flash);
  } else {
    vec3 p = position * k;
    float pitch = -0.32;                                  // tipped back toward the (higher) broadcast camera
    float roll = sw * 0.08 + (iPh.y - 0.5) * 0.4;
    float cp = cos(pitch), sp = sin(pitch);
    p = vec3(p.x, cp * p.y - sp * p.z, sp * p.y + cp * p.z);
    float cro = cos(roll), sro = sin(roll);
    p = vec3(cro * p.x - sro * p.y, sro * p.x + cro * p.y, p.z);
    vec3 l = anchor + p;
    mv = modelViewMatrix * vec4(vec3(cr * l.x + sr * l.z, l.y, -sr * l.x + cr * l.z) + iOffset.xyz, 1.0);
    vCol = aKind > 0.7 ? mix(scol, vec3(5.0), flash) : vec3(aKind > 0.2 ? 0.05 : 0.016) + vec3(flash * 0.6);
  }
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
varying vec3 vCol; varying vec2 vQ; varying float vKind; varying float vA;
void main() {
  if (vKind > 1.5) {
    float r2 = dot(vQ, vQ);
    if (r2 > 1.0 || vA <= 0.0) discard;
    float a = 1.0 - r2;
    a *= a * vA;
    gl_FragColor = vec4(vCol * a, 0.0);   // premultiplied, alpha 0 = purely additive
  } else {
    vec3 c = vCol;
    if (vKind > 0.7) c *= 0.84 + 0.3 * clamp(vQ.y / ${PH.toFixed(3)} + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(c, 1.0);
  }
  #include <colorspace_fragment>
}`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'crowd-phones';

  let frac = PHONES.BASE, settled = true;
  /** excite 0..1: how much is going on (goal, fight, hype); phones follow it up quickly, down slowly. */
  function update(dt, excite) {
    const target = PHONES.BASE + (PHONES.PEAK - PHONES.BASE) * Math.max(0, Math.min(1, excite));
    const prev = frac;
    frac += (target - frac) * Math.min(1, dt * (target > frac ? 2.2 : 0.35));
    if (settled && Math.abs(frac - prev) < 1e-5) return;
    let moving = false;
    for (let p = 0; p < N; p++) {
      const want = rk[p] < frac ? 1 : 0;
      let u = up[p];
      if (u === want) continue;
      u += want ? dt * rate[p] : -dt * rate[p] * 0.75;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      up[p] = u; fanUpArr[fanIdx[p]] = u;
      moving = true;
    }
    if (moving) { upAttr.needsUpdate = true; fanUp.needsUpdate = true; }
    settled = !moving;
  }

  return {
    mesh, fanUp, count: N,
    /** follow setCrowdDensity: only fans in the drawn prefix hold phones */
    setFanCount(n) { geo.instanceCount = prefix[Math.max(0, Math.min(count, n | 0))]; },
    update,
    /** linear rgb arrays (team-coloured phone screens) */
    setTeamColors(a, b) { mat.uniforms.uTeamA.value.setRGB(a[0], a[1], a[2]); mat.uniforms.uTeamB.value.setRGB(b[0], b[1], b[2]); },
    get raised() { return frac; },
  };
}
