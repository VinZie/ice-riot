// ICE RIOT renderer - rink: ice, boards (with a digital LED ad band), glass, goals (frames, rippling
// nets, goal lights).
import * as THREE from 'three';
import { RINK, glassPanels } from '/shared/constants.js';
import { outline, sweepBand, mergeGeometries, lin } from './util.js';
import { makeIceTexture, makeBoardTexture, makeNetTexture, makeGlassTexture, makeRadialTexture } from './textures.js';
import { getAdNetwork } from './ads.js';

const BOARD_T = 0.18; // board thickness (outward)

export function createRink(scene, mirror, aniso, track) {
  const L = RINK.halfLength, W = RINK.halfWidth, R = RINK.cornerRadius;
  const group = new THREE.Group();
  group.name = 'rink';
  scene.add(group);

  // ------------------------------------------------------------------ ice
  const shape = new THREE.Shape();
  shape.moveTo(-L + R, -W);
  shape.lineTo(L - R, -W); shape.absarc(L - R, -W + R, R, -Math.PI / 2, 0, false);
  shape.lineTo(L, W - R); shape.absarc(L - R, W - R, R, 0, Math.PI / 2, false);
  shape.lineTo(-L + R, W); shape.absarc(-L + R, W - R, R, Math.PI / 2, Math.PI, false);
  shape.lineTo(-L, -W + R); shape.absarc(-L + R, -W + R, R, Math.PI, Math.PI * 1.5, false);
  const iceGeo = new THREE.ShapeGeometry(shape, 24);
  iceGeo.rotateX(Math.PI / 2); // shape (x, y) -> world (x, 0, y)
  {
    const p = iceGeo.attributes.position, uv = iceGeo.attributes.uv, n = iceGeo.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      uv.setXY(i, (p.getX(i) + L) / (2 * L), 1 - (p.getZ(i) + W) / (2 * W));
      n.setXYZ(i, 0, 1, 0);
    }
    // rotateX(+90deg) flipped the winding to face -Y: flip triangles so the ice faces up
    const idx = iceGeo.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  }
  const iceTex = track(makeIceTexture(aniso));
  // transparent so the mirrored scene below shows through as a reflection; the emissive map keeps the
  // ice bright white even though the "under-ice" background is dark
  // Blend = src + dst * (1 - a): the ice keeps full brightness and the reflection only ADDS light.
  const iceMat = new THREE.MeshStandardMaterial({
    map: iceTex, roughness: 0.14, metalness: 0.0, transparent: true, opacity: 0.8, envMapIntensity: 0.5,
    emissive: 0xffffff, emissiveIntensity: 0.62, emissiveMap: iceTex,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const ice = new THREE.Mesh(iceGeo, iceMat);
  ice.receiveShadow = true;
  ice.renderOrder = -10;
  group.add(ice);

  // ------------------------------------------------------------------ boards
  const per = outline(0).total;
  const period = per / 5;
  const boardTex = track(makeBoardTexture(period, aniso));
  const bh = RINK.boardHeight;
  const inner = sweepBand(0, 0, 0, bh, -1, 0, 20, (s, k) => [s / period, k]);
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.45, metalness: 0.0, envMapIntensity: 0.6 });
  // LED screens along the boards: animated ads from the shared network (arena.js drives the redraws)
  getAdNetwork(scene, { track, aniso }).patchBoards(boardMat, { periodM: period });
  const boardsInner = new THREE.Mesh(inner, boardMat);
  boardsInner.receiveShadow = true;
  group.add(boardsInner);
  // top cap + outer face (plain), dark rubber floor ring behind the boards
  const cap = sweepBand(-0.02, bh, BOARD_T + 0.03, bh, 0, 1, 20, null, 0xdfe3ea);
  const capIn = sweepBand(-0.02, bh - 0.06, -0.02, bh, -1, 0, 20, null, 0xdfe3ea);
  const outer = sweepBand(BOARD_T + 0.03, 0, BOARD_T + 0.03, bh, 1, 0, 20, null, 0x8d95a2);
  const floor = sweepBand(BOARD_T, -0.01, 3.2, -0.01, 0, 1, 20, null, 0x16181e);
  const boardTrimGeo = mergeGeometries([cap, capIn, outer, floor]);
  const trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 });
  const boardsTrim = new THREE.Mesh(boardTrimGeo, trimMat);
  boardsTrim.receiveShadow = true;
  group.add(boardsTrim);
  // reflection copy of the inner boards
  const boardsMirror = new THREE.Mesh(inner, boardMat);
  mirror.add(boardsMirror);

  // ------------------------------------------------------------------ glass
  const panels = glassPanels();
  const gh = RINK.glassHeight;
  const glassTex = track(makeGlassTexture());
  // unlit: the texture carries the edge + streak highlights (lit glass cost ~1 ms on a weak iGPU)
  const glassFar = new THREE.MeshBasicMaterial({
    color: 0xd8f0ff, map: glassTex, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false,
  });
  const glassNear = glassFar.clone();
  glassNear.opacity = 0.08;
  const lens = new Map();
  const panelMeshes = [];
  for (const p of panels) {
    const key = p.len.toFixed(3);
    if (!lens.has(key)) lens.set(key, new THREE.PlaneGeometry(p.len - 0.03, gh));
    const near = p.nz < -0.3 && p.z > W - R * 0.6; // camera-side straight + the near half of the corners
    const m = new THREE.Mesh(lens.get(key), near || p.z > 6 ? glassNear : glassFar);
    m.position.set(p.x, bh + gh / 2, p.z);
    m.rotation.y = p.angle;
    m.renderOrder = 2;
    group.add(m);
    panelMeshes.push(m);
  }
  // stanchions between panels (+ thin top edge highlight), one merged mesh
  const posts = [];
  const postGeo = () => new THREE.BoxGeometry(0.05, gh + 0.04, 0.07);
  // the low play camera looks through the camera-side glass: no posts there (they would cut across the
  // bottom of the frame), like a broadcast that never shows the near stanchions
  const camSide = (p) => p.nz < -0.3 && p.z > W - R * 0.6;
  for (let i = 0; i < panels.length; i++) {
    const a = panels[i], b = panels[(i + 1) % panels.length];
    if (camSide(a) && camSide(b)) continue;
    // shared endpoint of a and b ~ midpoint of their ends
    // panel local +X = (cos a, -sin a) points against the traversal order, so a's far end is at -X local
    const ax = a.x - Math.cos(a.angle) * a.len / 2, az = a.z + Math.sin(a.angle) * a.len / 2;
    const bx = b.x + Math.cos(b.angle) * b.len / 2, bz = b.z - Math.sin(b.angle) * b.len / 2;
    const g = postGeo();
    g.rotateY((a.angle + b.angle) / 2 + (Math.abs(a.angle - b.angle) > Math.PI ? Math.PI : 0));
    g.translate((ax + bx) / 2, bh + gh / 2, (az + bz) / 2);
    posts.push(g);
  }
  const postMat = new THREE.MeshStandardMaterial({ color: 0xc9d2de, roughness: 0.35, metalness: 0.5 });
  const postsMesh = new THREE.Mesh(mergeGeometries(posts), postMat);
  group.add(postsMesh);

  const broken = new Uint8Array(panels.length);
  const brokenAt = new Float64Array(panels.length).fill(-1e9);
  function syncGlass(gl, now) {
    for (let i = 0; i < panels.length; i++) {
      let b = 0;
      if (gl) for (let k = 0; k < gl.length; k++) if (gl[k] === i) { b = 1; break; }
      if (!b && now - brokenAt[i] < 1.0) b = 1; // event arrived before the snapshot listed it
      if (b !== broken[i]) { broken[i] = b; panelMeshes[i].visible = !b; }
    }
  }
  function breakPanel(i, now) {
    if (i < 0 || i >= panels.length) return;
    brokenAt[i] = now;
    broken[i] = 1; panelMeshes[i].visible = false;
  }

  // ------------------------------------------------------------------ goals
  const gx = RINK.goalLineX, gw = RINK.goalHalfWidth, ghgt = RINK.goalHeight, gd = RINK.goalDepth;
  const frameParts = [];
  const red = lin(0xe01020), white = lin(0xf2f2f2);
  const tube = (x0, y0, z0, x1, y1, z1, r, rgb) => {
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const g = new THREE.CylinderGeometry(r, r, len, 10, 1, false);
    const dir = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const c = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < c.length; i += 3) { c[i] = rgb[0]; c[i + 1] = rgb[1]; c[i + 2] = rgb[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    frameParts.push(g);
  };
  const dBase = (z) => gd - 0.45 * Math.pow(Math.abs(z) / gw, 4); // depth of the base curve at z
  const shelf = 0.5;
  for (const s of [-1, 1]) {
    const x = s * gx, pr = RINK.postRadius + 0.012;
    tube(x, 0, -gw, x, ghgt, -gw, pr, red);
    tube(x, 0, gw, x, ghgt, gw, pr, red);
    tube(x, ghgt, -gw - pr, x, ghgt, gw + pr, pr, red);
    // top shelf rails + rear base curve (white)
    for (const z of [-gw, gw]) tube(x, ghgt, z, x + s * shelf, ghgt, z, 0.025, white);
    const N = 8;
    let px = x, pz = -gw;
    for (let k = 1; k <= N; k++) {
      const z = -gw + (2 * gw) * k / N;
      const xx = x + s * dBase(z);
      tube(px, 0.03, pz, xx, 0.03, z, 0.03, white);
      px = xx; pz = z;
    }
    tube(x, 0.03, -gw, x + s * dBase(-gw), 0.03, -gw, 0.03, white);
    tube(x, 0.03, gw, x + s * dBase(gw), 0.03, gw, 0.03, white);
    tube(x + s * shelf, ghgt, -gw, x + s * dBase(-gw), 0.03, -gw, 0.025, white);
    tube(x + s * shelf, ghgt, gw, x + s * dBase(gw), 0.03, gw, 0.025, white);
  }
  const frameGeo = mergeGeometries(frameParts);
  const frameMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.25, emissive: 0x220000 });
  const frames = new THREE.Mesh(frameGeo, frameMat);
  frames.castShadow = true;
  group.add(frames);
  mirror.add(new THREE.Mesh(frameGeo, frameMat));

  // nets: main sheet (top shelf + sloped back) and two sides, per goal; rippled on GOAL
  const netTex = track(makeNetTexture());
  const netMat = new THREE.MeshBasicMaterial({
    map: netTex, color: 0xf4f6fa, transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false,
  });
  const CELL = 0.1;
  const nets = [];
  for (const s of [-1, 1]) {
    const x0 = s * gx;
    const pos = [], uv = [], nrm = [], idx = [];
    const addGrid = (nu, nv, fn) => {
      const base = pos.length / 3;
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        const r = fn(i / nu, j / nv);
        pos.push(x0 + s * r.d, r.y, r.z);
        nrm.push(s * r.nd, r.ny, r.nz);
        uv.push(r.u / CELL, r.v / CELL);
      }
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    };
    // main sheet: v 0..0.3 top shelf (front->back), 0.3..1 sloped back down to the base
    addGrid(18, 14, (u, v) => {
      const z = -gw + 2 * gw * u;
      if (v <= 0.3) {
        const t = v / 0.3;
        return { d: shelf * t, y: ghgt, z, nd: 0, ny: 1, nz: 0, u: z, v: shelf * t };
      }
      const t = (v - 0.3) / 0.7, db = dBase(z);
      const d = shelf + (db - shelf) * t, y = ghgt * (1 - t);
      const nd = ghgt, ny = db - shelf, l = Math.hypot(nd, ny);
      return { d, y, z, nd: nd / l, ny: ny / l, nz: 0, u: z, v: shelf + Math.hypot(db - shelf, ghgt) * t };
    });
    for (const sz of [-1, 1]) {
      addGrid(8, 10, (u, v) => {
        const y = ghgt * v, dEdge = dBase(sz * gw) + (shelf - dBase(sz * gw)) * v;
        const d = dEdge * u;
        return { d, y, z: sz * gw, nd: 0, ny: 0, nz: sz, u: d, v: y };
      });
    }
    const g = new THREE.BufferGeometry();
    const pa = new THREE.Float32BufferAttribute(pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, netMat);
    mesh.renderOrder = 1;
    group.add(mesh);
    nets.push({
      s, mesh, rest: new Float32Array(pos), nrm: new Float32Array(nrm),
      t: 99, z0: 0, y0: 0.5, active: false,
    });
  }

  function rippleNet(side, z, y) {
    const n = nets[side > 0 ? 1 : 0];
    n.t = 0; n.active = true;
    n.z0 = Math.max(-gw, Math.min(gw, z || 0));
    n.y0 = Math.max(0.1, Math.min(ghgt - 0.1, y ?? 0.4));
  }

  function updateNets(dt) {
    for (const n of nets) {
      if (!n.active) continue;
      n.t += dt;
      const pa = n.mesh.geometry.attributes.position, arr = pa.array, rest = n.rest, nr = n.nrm;
      if (n.t > 2.2) {
        arr.set(rest); n.active = false; pa.needsUpdate = true; continue;
      }
      const t = n.t;
      const ix = n.s * gx + n.s * dBase(n.z0) * 0.9;
      const env = Math.exp(-t * 2.2);
      const bulge = Math.sin(Math.min(1, t * 6) * Math.PI * 0.5) * Math.max(0, 1 - t * 1.4) * 0.38;
      for (let i = 0; i < arr.length; i += 3) {
        const dx = rest[i] - ix, dy = rest[i + 1] - n.y0, dz = rest[i + 2] - n.z0;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const disp = bulge * Math.exp(-d * d * 2.2) + env * 0.1 * Math.sin(d * 12 - t * 18) * Math.exp(-d * 1.1);
        arr[i] = rest[i] + nr[i] * disp;
        arr[i + 1] = rest[i + 1] + nr[i + 1] * disp;
        arr[i + 2] = rest[i + 2] + nr[i + 2] * disp;
      }
      pa.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------ goal lights
  const glowTex = track(makeRadialTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]));
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1, 0.08, 0.05) }, uI: { value: 0 } },
    vertexShader: `varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uColor; uniform float uI; varying float vY; void main(){ float a = pow(vY, 1.6) * uI; gl_FragColor = vec4(uColor * a, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const lights = [];
  const housingMat = new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.5, metalness: 0.6 });
  for (const s of [-1, 1]) {
    const root = new THREE.Group();
    root.position.set(s * (L + 0.35), bh + gh + 0.22, 0);
    group.add(root);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.16, 12), housingMat);
    root.add(base);
    const domeMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a0a, emissiveIntensity: 0.15, roughness: 0.2, transparent: true, opacity: 0.95 });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
    dome.position.y = 0.08;
    root.add(dome);
    const spin = new THREE.Group();
    spin.position.y = 0.16;
    root.add(spin);
    const beamGeo = new THREE.ConeGeometry(1.6, 6, 16, 1, true);
    beamGeo.translate(0, -3, 0); // apex at origin, opening along -Y
    for (const dir of [-1, 1]) {
      const b = new THREE.Mesh(beamGeo, beamMat);
      b.rotation.z = dir * Math.PI / 2;
      spin.add(b);
    }
    spin.visible = false;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff2010, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    halo.scale.set(2.4, 2.4, 1);
    halo.position.y = 0.15;
    root.add(halo);
    // red pool of light on the ice in front of / around the net
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({ map: glowTex, color: 0xff1a0a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0, toneMapped: false }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(s * (gx - 1.0), 0.03, 0);
    pool.renderOrder = 3;
    group.add(pool);
    lights.push({ s, root, dome, domeMat, spin, halo, pool, t: 99, on: 0 });
  }
  function goalLight(side, dur = 4.2) {
    const l = lights[side > 0 ? 1 : 0];
    l.t = 0; l.dur = dur;
  }
  let calm = false; // reduceFlashes: steady glow instead of a strobing rotating beacon
  function updateLights(dt, time) {
    let any = 0;
    for (const l of lights) {
      l.t += dt;
      const on = l.t < (l.dur || 0) ? 1 : 0;
      l.on += ((on ? 1 : 0) - l.on) * Math.min(1, dt * (calm ? 3 : 10));
      const k = l.on;
      if (k > 0.01) any = Math.max(any, k);
      l.spin.visible = k > 0.01 && !calm;
      l.spin.rotation.y = time * 5.5;
      const pulse = calm ? 0.35 : 0.5 + 0.5 * Math.cos(time * 5.5 * 2);
      l.domeMat.emissiveIntensity = 0.15 + k * (calm ? 2.2 : 2.5 + 2.0 * pulse);
      l.halo.material.opacity = k * (0.55 + 0.45 * pulse);
      l.pool.material.opacity = k * (calm ? 0.22 : 0.25 + 0.35 * pulse);
    }
    beamMat.uniforms.uI.value = any * 0.95;
  }

  return {
    group, ice, panels, panelMeshes,
    syncGlass, breakPanel, rippleNet, goalLight,
    setReduceFlashes(v) { calm = !!v; },
    update(dt, time) { updateNets(dt); updateLights(dt, time); },
    netDepthAt: dBase,
  };
}
