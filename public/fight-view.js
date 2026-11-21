// ICE RIOT - fight mini-game overlay ("the scrap"). 2D canvas, procedural art only.
//
//   import { createFightView } from './fight-view.js';
//   const view = createFightView(containerElement);
//   view.show(fightSnap, { nameA, nameB, colorA, colorB, numA?, numB?, hint?, reward? });
//   view.update(fightSnap, dt, fightEvents);   // every animation frame while shown (events may be [])
//   view.hide();                               // fades out (CSS), keeps the canvas for the next fight
//   view.dispose();                            // removes canvas + injected <style>
//
// fightSnap = fightSnapshot() from shared/fight.js. colorA/colorB: 0xRRGGBB, '#rrggbb', or a TEAMS
// `colors` object {primary, secondary, accent}. The view runs no timers of its own: everything
// advances inside update(). The overlay is pointer-events:none and fills the container.

import { FIGHT } from '../shared/fight.js';

const FONT = `'Arial Black','Segoe UI Black','Franklin Gothic Heavy',Impact,system-ui,sans-serif`;
const INK = [10, 14, 28];
const SKINS = ['#f2c9a8', '#e3ae86', '#c98b62', '#a06a45', '#74482f', '#f6d6bf', '#b77b55'];
const HAIRS = ['#22160e', '#5b3a1e', '#a26f2c', '#dcb66e', '#151515', '#8a2f17', '#6b6b6b'];
const DEFAULT_COLORS = ['#ff6a13', '#7fd3ff'];
const BASE_X = -0.25;           // each fighter's feet, in its own facing-right frame (world units = fighter height)

// ------------------------------------------------------------------ small math / color utils
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeIn = (t) => t * t * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function bounce(t) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}
function hexOf(c, fb) {
  if (typeof c === 'number' && Number.isFinite(c)) return '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  if (typeof c === 'string') {
    const s = c.trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(s)) return '#' + s.toLowerCase();
    if (/^[0-9a-f]{3}$/i.test(s)) return '#' + s.split('').map((ch) => ch + ch).join('').toLowerCase();
  }
  return fb;
}
const rgbOf = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c, k) => (k < 1 ? mixc(c, [0, 0, 0], 1 - k) : mixc(c, [255, 255, 255], k - 1));
const css = (c, a = 1) => (a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`);
const lum = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
function teamColors(c, i) {
  let p, s, a;
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    p = hexOf(c.primary ?? c.p, DEFAULT_COLORS[i]);
    s = hexOf(c.secondary ?? c.s, null);
    a = hexOf(c.accent ?? c.a, '#ffffff');
  } else p = hexOf(c, DEFAULT_COLORS[i]);
  const P = rgbOf(p);
  const Sc = s ? rgbOf(s) : shade(P, 0.32);
  const A = a ? rgbOf(a) : [255, 255, 255];
  return { p: P, s: Sc, a: A };
}
function hash32(x) {
  x = Math.imul((x | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}
function lookFor(id, team) {
  let h = hash32(id * 7919 + team * 131 + 17);
  const pick = (arr) => { const v = arr[h % arr.length]; h = hash32(h); return v; };
  return { skin: rgbOf(pick(SKINS)), hair: rgbOf(pick(HAIRS)), style: pick([0, 1, 2, 3, 4]), beard: pick([0, 0, 1]) };
}
// two-bone IK: joint between a and the (reach-clamped) end point. bend +1 = joint below (arms), -1 = forward (legs)
function ik(a, t, l1, l2, bend) {
  let dx = t[0] - a[0], dy = t[1] - a[1];
  let d = Math.hypot(dx, dy) || 1e-6;
  const max = l1 + l2 - 1e-4, min = Math.abs(l1 - l2) + 1e-3;
  const dc = clamp(d, min, max);
  const end = [a[0] + (dx / d) * dc, a[1] + (dy / d) * dc];
  const base = Math.atan2(dy, dx);
  const ang = Math.acos(clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1));
  const j = [a[0] + Math.cos(base + bend * ang) * l1, a[1] + Math.sin(base + bend * ang) * l1];
  return [j, end];
}

// ------------------------------------------------------------------ style injection
let styleUsers = 0;
const STYLE_ID = 'ir-fight-style';
const STYLE = `
.ir-fight-root{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:40;overflow:hidden;
  opacity:0;visibility:hidden;transition:opacity .22s ease,visibility 0s linear .22s;contain:strict}
.ir-fight-root.ir-fight-fixed{position:fixed}
.ir-fight-root.ir-fight-on{opacity:1;visibility:visible;transition:opacity .16s ease}
.ir-fight-canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none}
`;

// ------------------------------------------------------------------ poses
// A pose is in the fighter's own frame: +x toward the opponent, y down (canvas), units = fighter height.
// nf / ff = near / far fist position relative to the near / far shoulder.
const GUARD = { hx: 0, hy: 0, lean: 0.17, head: -0.04, crouch: 0.02, rot: 0, down: 0, nf: [0.115, -0.05], ff: [0.165, -0.02], mouth: 0, eyes: 0, glow: 0 };
const POSE_KEYS = ['hx', 'hy', 'lean', 'head', 'crouch', 'rot', 'down', 'glow'];
const clonePose = (p) => ({ ...p, nf: [...p.nf], ff: [...p.ff] });
function blendPose(a, b, t) {
  const o = clonePose(t < 0.5 ? a : b);
  for (const k of POSE_KEYS) o[k] = lerp(a[k], b[k], t);
  o.nf = lerp2(a.nf, b.nf, t); o.ff = lerp2(a.ff, b.ff, t);
  return o;
}

function skeleton(P) {
  const hip = [BASE_X + P.hx, -(0.5 - P.crouch) + P.hy];
  const sl = Math.sin(P.lean), cl = Math.cos(P.lean);
  const sh = [hip[0] + sl * 0.3, hip[1] - cl * 0.3];
  const nsh = [sh[0] - 0.012, sh[1] + 0.012];
  const fsh = [sh[0] + 0.022, sh[1] - 0.004];
  const neck = [sh[0] + sl * 0.03, sh[1] - cl * 0.03];
  const ha = P.lean * 0.6 + P.head;
  const head = [neck[0] + Math.sin(ha) * 0.07 + 0.012, neck[1] - Math.cos(ha) * 0.07];
  const [nel, nfist] = ik(nsh, [nsh[0] + P.nf[0], nsh[1] + P.nf[1]], 0.155, 0.15, 1);
  const [fel, ffist] = ik(fsh, [fsh[0] + P.ff[0], fsh[1] + P.ff[1]], 0.155, 0.15, 1);
  let footF = [BASE_X + 0.085 + P.hx * 0.25, -0.065], footB = [BASE_X - 0.15 + P.hx * 0.25, -0.065];
  if (P.down > 0.001) {
    // knocked down: the whole body is drawn rotated by P.rot about (BASE_X + hx, 0). Pick the feet so
    // that AFTER that rotation they lie flat on the ice in front of the pivot (legs slide out).
    const cx = BASE_X + P.hx, c = Math.cos(-P.rot), s = Math.sin(-P.rot), d = P.down;
    const unrot = (x, y) => { const dx = x - cx; return [cx + dx * c - y * s, dx * s + y * c]; };
    const gy = lerp(-0.065, -0.04, d);
    footF = lerp2(footF, unrot(cx + 0.085 + 0.22 * d, gy), d);
    footB = lerp2(footB, unrot(cx - 0.15 + 0.32 * d, gy), d);
  }
  const [kneeF, ankF] = ik([hip[0] + 0.02, hip[1]], footF, 0.245, 0.235, -1);
  const [kneeB, ankB] = ik([hip[0] - 0.02, hip[1]], footB, 0.245, 0.235, -1);
  return { hip, sh, nsh, fsh, neck, head, ha, nel, nfist, fel, ffist, kneeF, ankF, kneeB, ankB, lean: P.lean };
}

// ------------------------------------------------------------------ the view
export function createFightView(container) {
  if (!container) throw new Error('createFightView(container): container element required');
  const doc = container.ownerDocument || document;
  const win = doc.defaultView || window;
  if (!doc.getElementById(STYLE_ID)) {
    const st = doc.createElement('style');
    st.id = STYLE_ID;
    st.textContent = STYLE;
    doc.head.appendChild(st);
  }
  styleUsers++;
  const isPage = container === doc.body || container === doc.documentElement;
  if (!isPage) {
    try { if (win.getComputedStyle(container).position === 'static') container.style.position = 'relative'; } catch { /* ignore */ }
  }
  const root = doc.createElement('div');
  root.className = 'ir-fight-root' + (isPage ? ' ir-fight-fixed' : '');
  root.setAttribute('aria-hidden', 'true');
  const canvas = doc.createElement('canvas');
  canvas.className = 'ir-fight-canvas';
  root.appendChild(canvas);
  container.appendChild(root);
  let ctx = canvas.getContext('2d');      // swapped to an offscreen context while caching the backdrop
  const main = ctx;

  let S = null;
  let disposed = false;

  function fresh(snap, opts) {
    const o = opts || {};
    const cols = [teamColors(o.colorA, 0), teamColors(o.colorB, 1)];
    const ids = [snap ? snap.a : 0, snap ? snap.b : 1];
    const tms = [snap ? snap.tA | 0 : 0, snap ? snap.tB | 0 : 1];
    const mk = (i) => ({
      st: '', t: 0, cur: clonePose(GUARD), sk: skeleton(GUARD), kick: 0, flash: 0, lastAtk: 'jab',
      off: 0, ghosts: [], headW: [0, -0.85], hpShow: FIGHT.HP, hpTrail: FIGHT.HP, trailWait: 0,
      gloves: true, helmet: true, phase: i * 2.1 + 0.7, comboShow: 0, comboN: 0,
    });
    return {
      on: true, snap, opts: o, cols, ids,
      names: [String(o.nameA ?? 'HOME').toUpperCase(), String(o.nameB ?? 'AWAY').toUpperCase()],
      nums: [o.numA ?? '', o.numB ?? ''],
      looks: [o.lookA || lookFor(ids[0], tms[0]), o.lookB || lookFor(ids[1], tms[1])],
      hint: o.hint === false ? '' : (o.hint || 'SHOOT jab  ·  ACTION haymaker  ·  PASS block  ·  TURBO dodge'),
      reward: o.reward === false ? '' : (o.reward || 'FULL TURBO  +  ON FIRE'),
      W: 0, H: 0, dpr: 1, u: 1, gy: 0,
      real: 0, anim: 0, shown: 0, alphaMul: 1, quiet: false, slowT: 0, shake: 0, flash: 0, flashCol: [255, 255, 255], hype: 0,
      cam: { x: 0, y: -0.5, z: 1.25, p: 0 }, introT: 0, lastPh: '', brawlT: -1, ko: null,
      F: [mk(0), mk(1)], props: [], parts: [], pops: [], bulbs: [], crowd: [], scratches: [],
      sticks: [{ x: -0.62, r: 0.06 }, { x: 0.7, r: -0.1 }],
    };
  }

  function fit() {
    const w = root.clientWidth || container.clientWidth || 960;
    const h = root.clientHeight || container.clientHeight || 540;
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    if (w === S.W && h === S.H && dpr === S.dpr) return;
    S.W = w; S.H = h; S.dpr = dpr;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    S.gy = h * 0.865;
    S.u = Math.min(h * 0.6, w * 0.46);   // world unit (one fighter height) in CSS px
    buildBackdrop();
  }

  const BG_PAD = 0.12;   // cached backdrop overdraw on each side (covers shake + parallax zoom)
  function offscreen(w, h) {
    const c = doc.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }

  function buildBackdrop() {
    const { W, H, u, gy } = S;
    const crowd = [];
    // rows of fans stacked up from the glass; extra (smaller) rows fill tall portrait screens
    let rTop = 0;
    while (gy - u * (1.16 + (-rTop + 1) * 0.105) > -H * 0.12 && rTop > -12) rTop--;
    for (let r = rTop; r < 6; r++) {
      const y = gy - u * (1.16 - r * 0.113);
      const sz = u * Math.max(0.02, 0.0267 + r * 0.007);
      const step = sz * 2.25;
      for (let x = -W * 0.25 + Math.random() * step; x < W * 1.25; x += step * (0.78 + Math.random() * 0.44)) {
        const fan = Math.random() < 0.62 ? (x < W / 2 ? 0 : 1) : -1;
        crowd.push({ x, y: y + (Math.random() - 0.5) * sz * 0.8, r: sz * (0.82 + Math.random() * 0.36), row: Math.max(0, r), ph: Math.random() * 6.283, fan, v: Math.random(), live: Math.random() < 0.16 });
      }
    }
    S.crowd = crowd;
    S.liveCrowd = crowd.filter((h) => h.live);
    const sc = [];
    for (let i = 0; i < 46; i++) sc.push({ x: (Math.random() * 1.6 - 0.3) * W, y: gy + u * (Math.random() * 0.75 - 0.38), w: (0.07 + Math.random() * 0.3) * u, c: (Math.random() - 0.5) * 0.13 * u, a: 0.04 + Math.random() * 0.08 });
    S.scratches = sc;
    // paint everything static once: arena, still fans, glass, boards, ice, lights
    const dpr = S.dpr;
    const bg = offscreen(W * (1 + 2 * BG_PAD) * dpr, H * (1 + 2 * BG_PAD) * dpr);
    const bctx = bg.getContext('2d');
    bctx.setTransform(dpr, 0, 0, dpr, BG_PAD * W * dpr, BG_PAD * H * dpr);
    ctx = bctx;
    try { drawBackdrop(); } finally { ctx = main; }
    S.bg = bg;
    const vig = offscreen(W * dpr, H * dpr);
    const vctx = vig.getContext('2d');
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vg = vctx.createRadialGradient(W / 2, H * 0.5, Math.min(W, H) * 0.35, W / 2, H * 0.5, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,8,0.72)');
    vctx.fillStyle = vg; vctx.fillRect(0, 0, W, H);
    S.vig = vig;
  }

  // ---------------------------------------------------------------- helpers bound to state
  const sideOf = (id) => (id === S.snap.a ? 0 : id === S.snap.b ? 1 : -1);
  const sgn = (i) => (i === 0 ? 1 : -1);
  const toWorld = (i, p) => [p[0] * sgn(i), p[1]];
  const toLocal = (i, p) => [p[0] * sgn(i), p[1]];

  function pop(text, i, o = {}) {
    if (S.quiet) return;
    const F = S.F[i];
    S.pops.push({
      text, x: o.x ?? F.headW[0] + (o.dx || 0), y: o.y ?? F.headW[1] - 0.2, t: 0, life: o.life || 0.85,
      size: o.size || 0.055, c1: o.c1 || [255, 255, 255], c2: o.c2 || [255, 210, 63], rise: o.rise ?? 0.16,
    });
  }
  function burst(x, y, power, col) {
    S.parts.push({ k: 'star', x, y, t: 0, life: 0.16 + power * 0.12, s: 0.08 + power * 0.14, rot: Math.random() * 6.28, col });
    if (power > 0.55) S.parts.push({ k: 'ring', x, y, t: 0, life: 0.32, s: 0.05, col });
    const n = 5 + Math.round(power * 12);
    for (let k = 0; k < n; k++) {
      const a = -Math.PI * Math.random();
      const sp = 0.4 + Math.random() * (0.9 + power * 1.6);
      S.parts.push({ k: 'drop', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.2, t: 0, life: 0.45 + Math.random() * 0.35, s: 0.006 + Math.random() * 0.009 });
    }
  }
  function spray(x, n, dir) {
    for (let k = 0; k < n; k++) {
      S.parts.push({ k: 'ice', x: x + (Math.random() - 0.5) * 0.08, y: -0.01, vx: dir * (0.3 + Math.random() * 0.9), vy: -(0.2 + Math.random() * 0.6), t: 0, life: 0.35 + Math.random() * 0.3, s: 0.005 + Math.random() * 0.007 });
    }
  }
  function dropGear(i, what) {
    const F = S.F[i], sk = F.sk;
    if (what === 'gloves' && F.gloves) {
      F.gloves = false;
      for (const p of [sk.nfist, sk.ffist]) {
        const w = toWorld(i, p);
        S.props.push({ k: 'glove', i, x: w[0], y: w[1], vx: sgn(i) * (Math.random() * 0.5 - 0.6), vy: 0.2 + Math.random() * 0.3, r: Math.random() * 3, vr: (Math.random() - 0.5) * 14, rest: 0 });
      }
    }
    if (what === 'helmet' && F.helmet) {
      F.helmet = false;
      const w = toWorld(i, [sk.head[0], sk.head[1] - 0.04]);
      S.props.push({ k: 'helmet', i, x: w[0], y: w[1], vx: -sgn(i) * (0.55 + Math.random() * 0.25), vy: -1.55, r: 0, vr: -sgn(i) * (6 + Math.random() * 4), rest: 0 });
    }
  }
  function layGearFlat() {
    for (let i = 0; i < 2; i++) {
      const F = S.F[i];
      if (F.gloves) { F.gloves = false; for (const dx of [0.1, 0.32]) S.props.push({ k: 'glove', i, x: sgn(i) * -(0.16 + dx), y: -0.03, vx: 0, vy: 0, r: dx * 9, vr: 0, rest: 1 }); }
      if (F.helmet) { F.helmet = false; S.props.push({ k: 'helmet', i, x: sgn(i) * -0.95, y: -0.05, vx: 0, vy: 0, r: 2.6, vr: 0, rest: 1 }); }
    }
  }

  // ---------------------------------------------------------------- events + phase changes
  function onEvent(e) {
    if (!e || typeof e !== 'object') return;
    const by = sideOf(e.by);
    const pw = clamp(+e.power || 0, 0, 1);
    // accepts raw drainFightEvents() objects or sim-wrapped ones: {type:'fight', sub:'punch', ...}
    const type = e.type === 'fight' ? e.sub : e.type;
    switch (type) {
      case 'punch': {
        if (by < 0) return;
        const d = 1 - by, F = S.F[d];
        F.kick = Math.max(0.35, pw); F.flash = 1;
        S.F[by].lastAtk = e.kind === 'hay' ? 'hay' : 'jab';
        const hx = F.headW[0] - sgn(d) * 0.04, hy = F.headW[1];
        burst(hx, hy, pw, e.kind === 'hay' ? [255, 196, 64] : [255, 255, 255]);
        S.shake = Math.max(S.shake, 4 + pw * 22);
        S.flash = Math.max(S.flash, e.kind === 'hay' ? 0.22 + pw * 0.2 : 0.06);
        S.flashCol = [255, 255, 255];
        S.hype = Math.min(1, S.hype + 0.15 + pw * 0.4);
        S.cam.z += e.kind === 'hay' ? 0.06 : 0.015;
        F.trailWait = 0.35;
        if (e.int) pop('INTERRUPTED!', d, { c2: [255, 120, 80], size: 0.05 });
        else if (e.ctr) pop('COUNTER!', by, { c2: [120, 230, 255], size: 0.06 });
        else if (e.kind === 'hay') pop('HAYMAKER!', by, { c2: [255, 170, 40], size: 0.065 });
        if ((e.combo | 0) >= 2) { S.F[by].comboN = e.combo | 0; S.F[by].comboShow = 1.4; }
        break;
      }
      case 'block': {
        if (by < 0) return;
        const F = S.F[by];
        F.kick = 0.25;
        const fw = toWorld(by, lerp2(F.sk.nfist, F.sk.ffist, 0.5));
        S.parts.push({ k: 'shield', x: fw[0] + sgn(by) * 0.03, y: fw[1], t: 0, life: 0.28, s: 0.11 + pw * 0.06, dir: sgn(by) });
        for (let k = 0; k < 6; k++) S.parts.push({ k: 'spark', x: fw[0], y: fw[1], vx: sgn(by) * (0.4 + Math.random()) * -1, vy: (Math.random() - 0.6) * 1.4, t: 0, life: 0.25, s: 0.01 });
        S.shake = Math.max(S.shake, e.brk ? 16 : 5);
        S.F[1 - by].off = 0.6;
        if (e.brk) { pop('GUARD BREAK!', by, { c2: [255, 90, 90], size: 0.06 }); S.flash = 0.25; S.flashCol = [255, 80, 80]; }
        else pop('BLOCKED', by, { c2: [140, 220, 255], size: 0.04, life: 0.6 });
        break;
      }
      case 'dodge': {
        if (by < 0) return;
        const F = S.F[by];
        F.ghostT = 0.4;
        S.F[1 - by].off = 1;
        spray(toWorld(by, [BASE_X - 0.1, 0])[0], 10, -sgn(by));
        pop('WHIFF!', 1 - by, { c2: [190, 255, 160], size: 0.05 });
        break;
      }
      case 'grab': {
        if (e.clash) { pop('TIE-UP!', by < 0 ? 0 : by, { x: 0, y: -1.12, c2: [255, 230, 120], size: 0.05 }); S.shake = Math.max(S.shake, 8); }
        break;
      }
      case 'ko': startKO(e.how, by >= 0 ? S.ids[by] : S.snap.winner, pw); break;
    }
  }

  function startKO(how, winnerId, pw = 0.8) {
    if (S.ko) return;
    const w = sideOf(winnerId);
    const wi = w < 0 ? 0 : w;
    S.ko = { t: 0, how: how || S.snap.how || 'time', w: wi, l: 1 - wi };
    if (S.ko.how === 'ko') {
      S.slowT = 0.95;
      S.flash = 0.9; S.flashCol = [255, 255, 255];
      S.shake = Math.max(S.shake, 30 + pw * 10);
      S.hype = 1;
      const L = S.F[S.ko.l];
      burst(L.headW[0], L.headW[1], 1, [255, 220, 90]);
      for (let k = 0; k < 3; k++) burst(L.headW[0] + (Math.random() - 0.5) * 0.1, L.headW[1] + (Math.random() - 0.5) * 0.1, 0.4, [255, 255, 255]);
    } else {
      S.flash = 0.3; S.flashCol = [255, 230, 150];
      S.shake = Math.max(S.shake, 6);
    }
  }

  function phaseCheck(snap) {
    if (snap.ph !== S.lastPh) {
      if (S.lastPh === 'intro' && snap.ph === 'fight') { S.brawlT = 0; S.shake = Math.max(S.shake, 10); S.flash = 0.25; S.flashCol = [255, 240, 200]; }
      if (snap.ph !== 'intro') layGearFlatIfMissed();
      if (snap.ph === 'ko') startKO(snap.how, snap.winner);
      S.lastPh = snap.ph;
    }
  }
  function layGearFlatIfMissed() { for (let i = 0; i < 2; i++) { dropGear(i, 'gloves'); dropGear(i, 'helmet'); } }

  // ---------------------------------------------------------------- pose targets
  function targetPose(i, adt) {
    const F = S.F[i], snap = S.snap;
    const st = i === 0 ? snap.stA : snap.stB;
    const t = F.t;
    const O = S.F[1 - i];
    const oppHead = toLocal(i, O.headW);
    const P = clonePose(GUARD);
    const bob = Math.sin(S.anim * 7.3 + F.phase), bob2 = Math.sin(S.anim * 3.1 + F.phase * 1.7);
    P.hy += bob * 0.006; P.lean += bob2 * 0.025; P.nf = [P.nf[0] + bob2 * 0.008, P.nf[1] + bob * 0.008];
    P.ff = [P.ff[0] - bob2 * 0.01, P.ff[1] - bob * 0.006];
    const sk = F.sk;
    const jabTarget = [oppHead[0] - 0.06 - sk.fsh[0], oppHead[1] + 0.012 - sk.fsh[1]];
    const hayTarget = [oppHead[0] - 0.055 - sk.nsh[0], oppHead[1] + 0.02 - sk.nsh[1]];

    if (snap.ph === 'intro') {
      const it = S.introT;
      if (it < 0.3) {
        P.lean = 0.34 + Math.sin(S.anim * 18 + F.phase) * 0.02; P.head = -0.22;
        P.nf = [0.11, 0.1]; P.ff = [0.14, 0.11]; P.mouth = 3;
      } else if (it < 0.44) {
        const k = (it - 0.3) / 0.14;
        P.lean = 0.3; P.head = -0.1;
        P.nf = [0.1, 0.1 + Math.sin(k * Math.PI) * 0.12]; P.ff = [0.12, 0.12 + Math.sin(k * Math.PI) * 0.12];
      } else if (it < 0.66) {
        const k = (it - 0.44) / 0.22;
        P.head = -0.4 * Math.sin(k * Math.PI);
        P.lean = lerp(0.3, GUARD.lean, k);
        P.nf = lerp2([0.1, 0.12], GUARD.nf, easeOut(k)); P.ff = lerp2([0.12, 0.12], GUARD.ff, easeOut(k));
      } else {
        P.hy += bob * 0.01;
      }
      return P;
    }

    const attackPose = (kind, tt, extra) => {
      const A = clonePose(P);
      A.mouth = 1;
      if (kind === 'jab') {
        const J = FIGHT.JAB;
        let e;
        if (tt < J.hit) e = easeOut(tt / J.hit);
        else if (tt < J.hit + 0.05) e = 1;
        else e = 1 - easeInOut(clamp((tt - J.hit - 0.05) / (J.total + extra - J.hit - 0.05), 0, 1));
        A.ff = lerp2(P.ff, jabTarget, e);
        A.nf = lerp2(P.nf, [0.09, -0.08], e);
        A.lean += 0.12 * e; A.hx += 0.03 * e; A.head += 0.06 * e;
      } else {
        const Hm = FIGHT.HAY, cock = [-0.155, 0.035], wind = Hm.hit - 0.075;
        if (tt < wind) {
          const w = easeInOut(tt / wind);
          const tr = Math.sin(S.anim * 60) * 0.006 * w;
          A.nf = [lerp(P.nf[0], cock[0], w) + tr, lerp(P.nf[1], cock[1], w) - tr];
          A.ff = lerp2(P.ff, [0.19, 0.0], w);
          A.lean = P.lean - 0.14 * w; A.hx = -0.025 * w; A.head = P.head - 0.08 * w; A.glow = w; A.crouch += 0.02 * w;
        } else if (tt < Hm.hit) {
          const s = easeIn((tt - wind) / (Hm.hit - wind));
          const c = [-0.02, -0.2];
          const a1 = lerp2(cock, c, s), a2 = lerp2(c, hayTarget, s);
          A.nf = lerp2(a1, a2, s);
          A.ff = [0.12, 0.04];
          A.lean = lerp(P.lean - 0.14, P.lean + 0.28, s); A.hx = lerp(-0.025, 0.06, s); A.glow = 1; A.crouch += 0.02;
        } else {
          const r = tt - Hm.hit;
          const fol = easeOut(clamp(r / 0.13, 0, 1));
          const rec = easeInOut(clamp((r - 0.13) / Math.max(0.05, Hm.total + extra - Hm.hit - 0.13), 0, 1));
          A.nf = lerp2(lerp2(hayTarget, [0.25, 0.1], fol), P.nf, rec);
          A.ff = lerp2([0.12, 0.04], P.ff, rec);
          A.lean = lerp(P.lean + 0.3 + F.off * 0.12, P.lean, rec); A.hx = lerp(0.06 + F.off * 0.03, 0, rec);
          A.glow = 1 - fol;
        }
      }
      return A;
    };

    switch (st) {
      case 'jab': case 'hay': {
        F.lastAtk = st;
        return attackPose(st, t, F.off > 0.8 ? (st === 'hay' ? FIGHT.HAY.whiff : FIGHT.JAB.whiff) : F.off > 0 ? FIGHT.JAB.recoil : 0);
      }
      case 'block': {
        P.nf = [0.075, -0.125]; P.ff = [0.105, -0.095]; P.head = 0.3; P.lean = 0.07 - F.kick * 0.1; P.crouch = 0.05; P.hx = -0.012 - F.kick * 0.03;
        return P;
      }
      case 'dodge': {
        const D = FIGHT.DODGE;
        const k = t < 0.06 ? easeOut(t / 0.06) : t < D.invuln ? 1 : 1 - easeInOut(clamp((t - D.invuln) / (D.total - D.invuln), 0, 1));
        P.lean = lerp(P.lean, -0.4, k); P.hx = -0.08 * k; P.head = -0.2 * k; P.crouch += 0.04 * k;
        P.nf = lerp2(P.nf, [0.1, -0.1], k); P.ff = lerp2(P.ff, [0.13, -0.06], k);
        return P;
      }
      case 'stun': {
        const d = Math.exp(-t * 6.5), k = F.kick;
        const wob = Math.sin(t * 22) * 0.06 * d;
        P.head = -0.6 * k * d + wob; P.lean = GUARD.lean - 0.3 * k * d; P.hx = -0.06 * k * d;
        P.nf = lerp2(P.nf, [0.04, 0.09], 0.7 * d); P.ff = lerp2(P.ff, [0.1, 0.1], 0.7 * d);
        P.mouth = 2; P.eyes = d > 0.35 ? 1 : 0;
        return P;
      }
      case 'grab': {
        const osh = toLocal(i, toWorld(1 - i, O.sk.sh));
        P.ff = [osh[0] - 0.02 - sk.fsh[0], osh[1] + 0.03 - sk.fsh[1]];
        P.nf = [0.0, 0.03 + Math.sin(S.anim * 30) * 0.01];
        P.lean = 0.32 + Math.sin(S.anim * 26 + F.phase) * 0.03; P.hx = 0.035; P.head = 0.1; P.mouth = 1;
        return P;
      }
      case 'win': {
        const W = clonePose(P);
        W.ff = [-0.02, -0.3]; W.nf = [0.13, Math.sin(S.anim * 9) * 0.03]; W.lean = -0.04; W.head = -0.3;
        W.hy = -Math.abs(Math.sin(t * 6)) * 0.018; W.mouth = 3;
        if (S.ko && S.ko.how === 'ko' && t < 0.8) {
          const A = attackPose(F.lastAtk, (F.lastAtk === 'hay' ? FIGHT.HAY.hit : FIGHT.JAB.hit) + 0.02 + t * 0.5, 0.5);
          return blendPose(A, W, smooth(0.35, 0.8, t));
        }
        return W;
      }
      case 'lose': {
        P.lean = 0.45; P.head = 0.4; P.nf = [0.03, 0.2]; P.ff = [0.07, 0.21]; P.crouch = 0.07; P.eyes = 1; P.mouth = 2; P.hy = 0;
        return P;
      }
      case 'ko': {
        const f = bounce(clamp((t - 0.05) / 0.85, 0, 1));
        P.rot = -1.45 * f; P.down = f; P.hx = -0.1 * f - 0.04; P.head = -0.7 * (1 - 0.6 * f); P.lean = GUARD.lean - 0.25;
        P.nf = [-0.06, 0.12]; P.ff = [0.14, -0.2 + f * 0.1]; P.eyes = 2; P.mouth = 2; P.hy = 0; P.crouch = 0;
        return P;
      }
      default:
        return P;
    }
  }

  // ---------------------------------------------------------------- per-frame update
  function step(dt) {
    const snap = S.snap;
    S.real += dt;
    S.shown = Math.min(1, S.shown + dt * 4);
    let ts = 1;
    if (S.slowT > 0) { S.slowT -= dt; ts = S.slowT > 0.15 ? 0.2 : lerp(1, 0.2, clamp(S.slowT / 0.15, 0, 1)); }
    const adt = dt * ts;
    S.anim += adt;

    // intro clock
    const prevIntro = S.introT;
    if (snap.ph === 'intro') {
      const target = FIGHT.INTRO - snap.t;
      S.introT = Math.abs(S.introT + adt - target) > 0.1 ? target : S.introT + adt;
    } else S.introT = Math.max(S.introT, FIGHT.INTRO);
    if (snap.ph === 'intro') {
      if (prevIntro < 0.3 && S.introT >= 0.3) for (let i = 0; i < 2; i++) dropGear(i, 'gloves');
      if (prevIntro < 0.5 && S.introT >= 0.5) for (let i = 0; i < 2; i++) dropGear(i, 'helmet');
    }
    if (S.brawlT >= 0) S.brawlT += dt;
    if (S.ko) S.ko.t += dt;

    // fighters
    const kSmooth = 1 - Math.exp(-adt * 30);
    for (let i = 0; i < 2; i++) {
      const F = S.F[i];
      const st = i === 0 ? snap.stA : snap.stB;
      const sT = +(i === 0 ? snap.sTA : snap.sTB) || 0;
      if (st !== F.st) {
        if (F.st === 'dodge' || st === 'dodge') F.ghosts = [];
        F.st = st; F.t = snap.ph === 'ko' ? 0 : Math.min(sT, 0.05);
        if (st !== 'jab' && st !== 'hay' && st !== 'win') F.off = 0;
      } else {
        F.t += adt;
        if (snap.ph !== 'ko' && Math.abs(F.t - sT) > 0.12) F.t = sT;
      }
      F.kick *= Math.exp(-adt * 1.5);
      F.flash = Math.max(0, F.flash - adt * 9);
      const tgt = targetPose(i, adt);
      const c = F.cur;
      for (const k of POSE_KEYS) c[k] += (tgt[k] - c[k]) * (k === 'rot' || k === 'down' ? Math.min(1, kSmooth * 1.5) : kSmooth);
      const kf = 1 - Math.exp(-adt * 42);
      c.nf = lerp2(c.nf, tgt.nf, kf); c.ff = lerp2(c.ff, tgt.ff, kf);
      c.mouth = tgt.mouth; c.eyes = tgt.eyes;
      F.sk = skeleton(c);
      F.headW = toWorld(i, rotAboutFeet(F.sk.head, c));
      if (F.st === 'dodge') { F.ghosts.unshift(clonePose(c)); if (F.ghosts.length > 9) F.ghosts.length = 9; }
      else if (F.ghosts.length) F.ghosts.pop();
      // hp bar trails
      const hp = clamp(+(i === 0 ? snap.hpA : snap.hpB) || 0, 0, FIGHT.HP);
      F.hpShow = lerp(F.hpShow, hp, 1 - Math.exp(-dt * 18));
      if (F.trailWait > 0) F.trailWait -= dt;
      else F.hpTrail = Math.max(hp, F.hpTrail - dt * 55);
      if (F.hpTrail < hp) F.hpTrail = hp;
      F.comboShow = Math.max(0, F.comboShow - dt);
    }

    // camera
    let tz = 1, tx = 0, ty = -0.5, tp = 0;
    if (snap.ph === 'intro') tz = lerp(1.25, 1, smooth(0.0, 0.75, S.introT));
    if (S.ko) {
      const L = S.F[S.ko.l], Wf = S.F[S.ko.w];
      if (S.ko.how === 'ko' && S.ko.t < 1.25) { tz = 1.42; tx = L.headW[0] * 0.8; ty = L.headW[1] * 0.75; }
      else {
        tz = 1.0; tx = Wf.headW[0] * 0.2; ty = -0.5;
        // narrow screen: slide toward the fighter lying on the ice so he stays in frame
        const halfW = S.W / (2 * S.u);
        if (S.ko.how === 'ko') tp = clamp(L.headW[0] * 0.5, -0.5, 0.5) * clamp((1.4 - halfW) / 0.4, 0, 1);
      }
    }
    const kc = 1 - Math.exp(-dt * (S.ko ? 5 : 7));
    S.cam.z += (tz - S.cam.z) * kc; S.cam.x += (tx - S.cam.x) * kc; S.cam.y += (ty - S.cam.y) * kc; S.cam.p += (tp - S.cam.p) * kc;

    S.shake *= Math.exp(-dt * 9); if (S.shake < 0.2) S.shake = 0;
    S.flash *= Math.exp(-dt * 6.5); if (S.flash < 0.01) S.flash = 0;
    S.hype = Math.max(0, S.hype - dt * 0.35);

    // props (gloves / helmets) - simple ballistic + bounce, world units
    for (const p of S.props) {
      if (p.rest) continue;
      p.vy += 5.2 * adt; p.x += p.vx * adt; p.y += p.vy * adt; p.r += p.vr * adt;
      const floor = p.k === 'helmet' ? -0.05 : -0.03;
      if (p.y > floor) {
        p.y = floor;
        if (Math.abs(p.vy) < 0.35) { p.rest = 1; p.vy = 0; p.vx = 0; p.vr = 0; if (p.k === 'glove') p.r = Math.round(p.r / Math.PI) * Math.PI; }
        else { p.vy *= -0.32; p.vx *= 0.6; p.vr *= 0.5; spray(p.x, 3, Math.sign(p.vx) || 1); }
      }
    }
    // particles
    for (const p of S.parts) {
      p.t += adt;
      if (p.vx !== undefined) { p.vy += (p.k === 'ice' ? 2.2 : 3.6) * adt; p.x += p.vx * adt; p.y += p.vy * adt; if (p.y > 0 && p.k !== 'ice') { p.y = 0; p.vx *= 0.3; p.vy = 0; } }
    }
    S.parts = S.parts.filter((p) => p.t < p.life);
    for (const p of S.pops) p.t += dt;
    S.pops = S.pops.filter((p) => p.t < p.life);
    // camera bulbs in the crowd
    const rate = 2 + S.hype * 26;
    if (Math.random() < rate * dt && S.crowd.length) {
      const h = S.crowd[(Math.random() * S.crowd.length) | 0];
      S.bulbs.push({ x: h.x, y: h.y - h.r * 0.2, t: 0, life: 0.09 + Math.random() * 0.08, s: h.r * (0.9 + Math.random()) });
    }
    for (const b of S.bulbs) b.t += dt;
    S.bulbs = S.bulbs.filter((b) => b.t < b.life);
  }

  function rotAboutFeet(p, P) {
    if (!P.rot) return p;
    const cx = BASE_X + P.hx, c = Math.cos(P.rot), s = Math.sin(P.rot);
    const dx = p[0] - cx, dy = p[1];
    return [cx + dx * c - dy * s, dx * s + dy * c];
  }

  // ---------------------------------------------------------------- drawing: backdrop (screen px, parallax)
  function paintFan(h, jump, hy) {
    const y = h.y - jump;
    const base = h.fan >= 0 ? shade(S.cols[h.fan].p, 0.22 + h.row * 0.035) : [18 + h.v * 14, 22 + h.v * 12, 38 + h.v * 16];
    ctx.fillStyle = css(base);
    ctx.beginPath(); ctx.ellipse(h.x, y + h.r * 1.55, h.r * 1.25, h.r * 0.95, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = css([12 + h.row * 3, 15 + h.row * 3, 28 + h.row * 4]);
    ctx.beginPath(); ctx.arc(h.x, y, h.r * 0.72, 0, Math.PI * 2); ctx.fill();
    if (hy > 0.25) { // arms up
      ctx.strokeStyle = css(base); ctx.lineWidth = h.r * 0.35; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(h.x - h.r * 0.8, y + h.r); ctx.lineTo(h.x - h.r * 1.1, y - h.r * 1.2 * hy); ctx.stroke();
      if (h.v > 0.5) { ctx.beginPath(); ctx.moveTo(h.x + h.r * 0.8, y + h.r); ctx.lineTo(h.x + h.r * 1.1, y - h.r * 1.2 * hy); ctx.stroke(); }
    }
  }
  // per frame, same transform as the cached backdrop: bouncing fans + camera flashes
  function drawCrowdLive() {
    const hy = S.hype;
    for (const h of S.liveCrowd) {
      const jump = Math.max(0, Math.sin(S.real * (6 + h.v * 5) + h.ph)) * h.r * (0.15 + hy * 0.9);
      paintFan(h, jump, hy);
    }
    for (const b of S.bulbs) {
      const a = 1 - b.t / b.life;
      ctx.fillStyle = `rgba(255,255,255,${(0.9 * a).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.s * 0.35, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${(0.5 * a).toFixed(3)})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(b.x - b.s, b.y); ctx.lineTo(b.x + b.s, b.y); ctx.moveTo(b.x, b.y - b.s); ctx.lineTo(b.x, b.y + b.s); ctx.stroke();
    }
  }

  // Laid out relative to the ground line (gy) and the fighter scale (u), so the arena keeps its
  // proportions from wide landscape down to tall portrait screens.
  function drawBackdrop() {
    const { W, H, u } = S;
    const gy = S.gy;
    const cA = S.cols[0].p, cB = S.cols[1].p;
    const gTop = gy - 0.84 * u, bTop = gy - 0.44 * u, bBot = gy - 0.29 * u;
    // arena darkness
    let g = ctx.createLinearGradient(0, 0, 0, bBot);
    g.addColorStop(0, '#04060d'); g.addColorStop(0.7, '#0b1124'); g.addColorStop(1, '#0e1630');
    ctx.fillStyle = g; ctx.fillRect(-W, -H, W * 3, H * 3);
    // team-tinted halves split by a slanted seam
    const seamTop = W / 2 + u * 0.15, seamBot = W / 2 - u * 0.15;
    for (let i = 0; i < 2; i++) {
      ctx.save();
      ctx.beginPath();
      if (i === 0) { ctx.moveTo(-W, -H); ctx.lineTo(seamTop, -H); ctx.lineTo(seamBot, H * 2); ctx.lineTo(-W, H * 2); }
      else { ctx.moveTo(seamTop, -H); ctx.lineTo(W * 2, -H); ctx.lineTo(W * 2, H * 2); ctx.lineTo(seamBot, H * 2); }
      ctx.closePath(); ctx.clip();
      const cx = W / 2 + (i === 0 ? -1 : 1) * Math.min(W * 0.3, u * 0.9);
      const rad = Math.max(W * 0.62, u * 1.4);
      g = ctx.createRadialGradient(cx, gy - 0.6 * u, 0, cx, gy - 0.6 * u, rad);
      const col = i === 0 ? cA : cB;
      g.addColorStop(0, css(col, 0.42)); g.addColorStop(0.55, css(col, 0.14)); g.addColorStop(1, css(col, 0));
      ctx.fillStyle = g; ctx.fillRect(-W, -H, W * 3, H * 3);
      // diagonal hatching for texture
      ctx.strokeStyle = css(col, 0.06); ctx.lineWidth = u * 0.02;
      for (let x = -W; x < W * 2 + H; x += u * 0.083) { ctx.beginPath(); ctx.moveTo(x, -H * 0.1); ctx.lineTo(x - (bTop + H * 0.1) * 0.8, bTop); ctx.stroke(); }
      ctx.restore();
    }
    // crowd (still fans; the "live" ones are drawn every frame by drawCrowdLive)
    for (const h of S.crowd) if (!h.live) paintFan(h, 0, 0);
    // glass band: soft reflections
    ctx.fillStyle = 'rgba(150,190,230,0.05)'; ctx.fillRect(-W, gTop, W * 3, bTop - gTop);
    ctx.strokeStyle = 'rgba(200,230,255,0.07)'; ctx.lineWidth = u * 0.05;
    for (let x = -W * 0.2; x < W * 1.3; x += u * 0.47) { ctx.beginPath(); ctx.moveTo(x, bTop); ctx.lineTo(x + u * 0.2, gTop); ctx.stroke(); }
    ctx.fillStyle = 'rgba(200,225,255,0.12)';
    for (let x = W / 2 - u * 3.3; x < W * 1.3; x += u * 0.33) ctx.fillRect(x, gTop, 2, bTop - gTop);
    // boards
    g = ctx.createLinearGradient(0, bTop, 0, bBot);
    g.addColorStop(0, '#c9d3df'); g.addColorStop(0.5, '#a9b6c6'); g.addColorStop(1, '#6f7d92');
    ctx.fillStyle = g; ctx.fillRect(-W, bTop, W * 3, bBot - bTop);
    ctx.fillStyle = '#1c2436'; ctx.fillRect(-W, bTop - u * 0.013, W * 3, u * 0.02);
    ctx.fillStyle = '#121a2b'; ctx.fillRect(-W, bBot - u * 0.03, W * 3, u * 0.03);
    // board panels with our own wordmark + team stripes
    ctx.save();
    ctx.font = `italic 900 ${Math.round(u * 0.075)}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let k = -6; k <= 6; k++) {
      const x = W / 2 - u * 0.62 + k * u * 0.77;
      ctx.fillStyle = 'rgba(20,28,48,0.16)';
      ctx.fillText('ICE RIOT', x, (bTop + bBot) / 2 - u * 0.007);
      ctx.fillStyle = css(k % 2 ? cA : cB, 0.35);
      ctx.fillRect(x + u * 0.3, bTop + u * 0.02, u * 0.09, bBot - bTop - u * 0.058);
    }
    ctx.restore();
    // ice
    g = ctx.createLinearGradient(0, bBot, 0, gy + 0.3 * u);
    g.addColorStop(0, '#58718c'); g.addColorStop(0.35, '#9ab5cc'); g.addColorStop(1, '#c9dcea');
    ctx.fillStyle = g; ctx.fillRect(-W, bBot, W * 3, H * 2);
    // board reflection on ice
    ctx.fillStyle = 'rgba(30,40,60,0.18)'; ctx.fillRect(-W, bBot, W * 3, u * 0.04);
    // painted line across the ice
    ctx.fillStyle = 'rgba(40,90,200,0.38)';
    ctx.fillRect(-W, gy - 0.18 * u, W * 3, 0.025 * u);
    // scratches
    ctx.lineCap = 'round';
    for (const s of S.scratches) {
      ctx.strokeStyle = `rgba(255,255,255,${s.a})`; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.quadraticCurveTo(s.x + s.w / 2, s.y + s.c, s.x + s.w, s.y); ctx.stroke();
    }
    // spotlight pool on the ice + beams
    const pool = u * 1.25;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(W / 2, gy);
    ctx.scale(1, 0.16);
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, pool);
    g.addColorStop(0, 'rgba(210,235,255,0.42)'); g.addColorStop(0.6, 'rgba(160,200,255,0.12)'); g.addColorStop(1, 'rgba(160,200,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, pool, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const side of [-1, 1]) {
      const x0 = W / 2 + side * u * 0.53;
      g = ctx.createLinearGradient(0, 0, 0, gy);
      g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(1, 'rgba(200,225,255,0.02)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(x0 - u * 0.06, -H * 0.05); ctx.lineTo(x0 + u * 0.06, -H * 0.05);
      ctx.lineTo(W / 2 - side * u * 0.15 + u * 0.6, gy); ctx.lineTo(W / 2 - side * u * 0.15 - u * 0.6, gy); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    // the seam
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = u * 0.01;
    ctx.beginPath(); ctx.moveTo(seamTop + (seamTop - seamBot) * (H * 0.1) / (2 * H), -H * 0.1); ctx.lineTo(W / 2 + (seamBot - W / 2) * 0.33, bTop); ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- drawing: world (units = fighter height)
  function limb(a, b, w, col, outline = true) {
    if (outline) { ctx.strokeStyle = css(INK); ctx.lineWidth = w + 0.018; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
  function blob(x, y, rx, ry, rot, fill) {
    ctx.fillStyle = fill; ctx.strokeStyle = css(INK); ctx.lineWidth = 0.012;
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  function drawSkate(ank, toeDir, dark) {
    const boot = css(shade([30, 32, 40], dark ? 0.7 : 1));
    ctx.save();
    ctx.translate(ank[0], ank[1]);
    ctx.fillStyle = boot; ctx.strokeStyle = css(INK); ctx.lineWidth = 0.012;
    ctx.beginPath();
    ctx.moveTo(-0.035, -0.035); ctx.lineTo(0.03, -0.035); ctx.quadraticCurveTo(0.05, 0.0, 0.085 * toeDir, 0.025);
    ctx.lineTo(-0.045, 0.03); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = css([235, 238, 245]); ctx.fillRect(0.045 * toeDir - 0.02, 0.005, 0.04, 0.012);
    ctx.strokeStyle = css(dark ? [150, 160, 175] : [215, 225, 238]); ctx.lineWidth = 0.012;
    ctx.beginPath(); ctx.moveTo(-0.05, 0.058); ctx.lineTo(0.085, 0.058); ctx.quadraticCurveTo(0.1, 0.05, 0.095, 0.04); ctx.stroke();
    ctx.strokeStyle = css([60, 65, 80]); ctx.lineWidth = 0.01;
    ctx.beginPath(); ctx.moveTo(-0.03, 0.03); ctx.lineTo(-0.03, 0.056); ctx.moveTo(0.06, 0.03); ctx.lineTo(0.06, 0.056); ctx.stroke();
    ctx.restore();
  }

  function drawFist(p, skin, gloveOn, cols, dark, glow) {
    if (glow > 0.02) {
      const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], 0.13 * (0.6 + glow * 0.6));
      g.addColorStop(0, `rgba(255,190,70,${(0.55 * glow).toFixed(3)})`); g.addColorStop(1, 'rgba(255,120,30,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p[0], p[1], 0.14, 0, Math.PI * 2); ctx.fill();
    }
    if (gloveOn) {
      ctx.fillStyle = css(shade(cols.p, dark ? 0.7 : 1)); ctx.strokeStyle = css(INK); ctx.lineWidth = 0.012;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(p[0] - 0.05, p[1] - 0.045, 0.1, 0.09, 0.025) : ctx.rect(p[0] - 0.05, p[1] - 0.045, 0.1, 0.09); ctx.fill(); ctx.stroke();
      ctx.fillStyle = css(shade(cols.s, dark ? 0.7 : 1)); ctx.fillRect(p[0] - 0.05, p[1] + 0.015, 0.1, 0.025);
      return;
    }
    blob(p[0], p[1], 0.04, 0.036, 0, css(shade(skin, dark ? 0.8 : 1)));
    ctx.strokeStyle = css(shade(skin, 0.6)); ctx.lineWidth = 0.007;
    ctx.beginPath(); ctx.moveTo(p[0] + 0.012, p[1] - 0.024); ctx.lineTo(p[0] + 0.012, p[1] + 0.022); ctx.stroke();
  }

  function drawHead(F, P, look, cols, flash) {
    const sk = F.sk;
    const skin = mixc(look.skin, [255, 255, 255], flash);
    const hair = css(mixc(look.hair, [255, 255, 255], flash));
    ctx.save();
    ctx.translate(sk.head[0], sk.head[1]);
    ctx.rotate(sk.ha);
    // back hair (flow)
    if (look.style === 1 && !F.helmet) {
      ctx.fillStyle = hair; ctx.strokeStyle = css(INK); ctx.lineWidth = 0.01;
      ctx.beginPath(); ctx.moveTo(-0.06, -0.03); ctx.quadraticCurveTo(-0.1, 0.03, -0.085 + Math.sin(S.anim * 9) * 0.008, 0.085); ctx.lineTo(-0.035, 0.05); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // skull + jaw
    ctx.fillStyle = css(skin); ctx.strokeStyle = css(INK); ctx.lineWidth = 0.012;
    ctx.beginPath();
    ctx.moveTo(-0.062, -0.01);
    ctx.bezierCurveTo(-0.066, -0.095, 0.06, -0.1, 0.066, -0.03);
    ctx.lineTo(0.074, 0.0); ctx.lineTo(0.066, 0.012);
    ctx.quadraticCurveTo(0.07, 0.055, 0.045, 0.07);
    ctx.quadraticCurveTo(-0.01, 0.085, -0.04, 0.055);
    ctx.quadraticCurveTo(-0.068, 0.03, -0.062, -0.01);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // ear
    blob(-0.018, 0.004, 0.014, 0.019, 0, css(shade(skin, 0.88)));
    // beard
    if (look.beard) {
      ctx.fillStyle = hair;
      ctx.beginPath(); ctx.moveTo(-0.035, 0.03); ctx.quadraticCurveTo(0.0, 0.095, 0.06, 0.055); ctx.lineTo(0.058, 0.035); ctx.quadraticCurveTo(0.01, 0.06, -0.025, 0.02); ctx.fill();
    }
    // hair
    if (!F.helmet) {
      ctx.fillStyle = hair; ctx.strokeStyle = css(INK); ctx.lineWidth = 0.01;
      ctx.beginPath();
      if (look.style === 0 || look.style === 3) { // short crop
        ctx.moveTo(-0.064, 0.0); ctx.bezierCurveTo(-0.07, -0.1, 0.058, -0.108, 0.064, -0.04); ctx.quadraticCurveTo(0.02, -0.065, -0.03, -0.05); ctx.quadraticCurveTo(-0.045, -0.02, -0.064, 0.0);
      } else if (look.style === 2) { // curls
        for (let k = 0; k < 6; k++) { const a = Math.PI * (1.05 + k * 0.16); ctx.moveTo(Math.cos(a) * 0.064 + 0.024, Math.sin(a) * 0.064 - 0.02); ctx.arc(Math.cos(a) * 0.064, Math.sin(a) * 0.064 - 0.02, 0.024, 0, Math.PI * 2); }
      } else if (look.style === 4) { // spikes
        ctx.moveTo(-0.064, -0.005);
        for (let k = 0; k <= 5; k++) { const a = Math.PI * (1.0 + k * 0.17); ctx.lineTo(Math.cos(a) * 0.1, Math.sin(a) * 0.1 - 0.012); ctx.lineTo(Math.cos(a + 0.26) * 0.06, Math.sin(a + 0.26) * 0.06 - 0.012); }
        ctx.lineTo(0.062, -0.035); ctx.quadraticCurveTo(0, -0.05, -0.064, -0.005);
      } else { // flow on top
        ctx.moveTo(-0.066, 0.01); ctx.bezierCurveTo(-0.075, -0.11, 0.062, -0.115, 0.066, -0.035); ctx.quadraticCurveTo(0.01, -0.07, -0.04, -0.03); ctx.quadraticCurveTo(-0.05, 0.0, -0.066, 0.01);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else {
      // helmet (intro only)
      ctx.fillStyle = css(cols.s); ctx.strokeStyle = css(INK); ctx.lineWidth = 0.012;
      ctx.beginPath(); ctx.moveTo(-0.075, 0.02); ctx.bezierCurveTo(-0.085, -0.13, 0.08, -0.13, 0.078, -0.03); ctx.lineTo(0.03, -0.03); ctx.lineTo(-0.01, 0.0); ctx.lineTo(-0.02, 0.035); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = css(cols.p); ctx.fillRect(-0.05, -0.085, 0.07, 0.016);
      ctx.strokeStyle = 'rgba(200,230,255,0.85)'; ctx.lineWidth = 0.012;
      ctx.beginPath(); ctx.moveTo(0.062, -0.03); ctx.lineTo(0.082, 0.012); ctx.stroke();
    }
    // face
    const eyeX = 0.04, eyeY = -0.012;
    ctx.strokeStyle = css(INK); ctx.fillStyle = css(INK); ctx.lineCap = 'round';
    if (P.eyes === 2) {
      ctx.lineWidth = 0.008;
      ctx.beginPath(); ctx.moveTo(eyeX - 0.011, eyeY - 0.011); ctx.lineTo(eyeX + 0.011, eyeY + 0.011); ctx.moveTo(eyeX + 0.011, eyeY - 0.011); ctx.lineTo(eyeX - 0.011, eyeY + 0.011); ctx.stroke();
    } else if (P.eyes === 1) {
      ctx.lineWidth = 0.007; ctx.beginPath(); ctx.moveTo(eyeX - 0.012, eyeY + 0.002); ctx.lineTo(eyeX + 0.01, eyeY - 0.002); ctx.stroke();
    } else {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(eyeX, eyeY, 0.011, 0.008, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = css(INK); ctx.beginPath(); ctx.arc(eyeX + 0.004, eyeY, 0.0055, 0, Math.PI * 2); ctx.fill();
    }
    ctx.lineWidth = 0.011;
    ctx.beginPath(); ctx.moveTo(eyeX - 0.018, eyeY - 0.022); ctx.lineTo(eyeX + 0.02, eyeY - 0.01); ctx.stroke(); // angry brow
    if (P.mouth === 1) { // gritted teeth
      ctx.fillStyle = '#f4f4ee'; ctx.fillRect(0.028, 0.035, 0.034, 0.013);
      ctx.lineWidth = 0.006; ctx.strokeRect(0.028, 0.035, 0.034, 0.013);
      ctx.beginPath(); ctx.moveTo(0.04, 0.035); ctx.lineTo(0.04, 0.048); ctx.moveTo(0.051, 0.035); ctx.lineTo(0.051, 0.048); ctx.stroke();
    } else if (P.mouth === 2 || P.mouth === 3) {
      ctx.fillStyle = '#3a0d12'; ctx.beginPath(); ctx.ellipse(0.046, 0.042, P.mouth === 3 ? 0.017 : 0.012, P.mouth === 3 ? 0.014 : 0.01, 0, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.lineWidth = 0.007; ctx.beginPath(); ctx.moveTo(0.03, 0.044); ctx.lineTo(0.058, 0.04); ctx.stroke();
    }
    ctx.restore();
  }

  function drawFighter(i, P, opt = {}) {
    const F = S.F[i], cols = S.cols[i], look = S.looks[i];
    const sk = opt.sk || F.sk;
    const flash = opt.flash ?? F.flash * 0.8;
    const J = (c, k = 1) => css(mixc(shade(c, k), [255, 255, 255], flash));
    ctx.save();
    if (i === 1) ctx.scale(-1, 1);
    if (P.rot) { const cx = BASE_X + P.hx; ctx.translate(cx, 0); ctx.rotate(P.rot); ctx.translate(-cx, 0); }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const jersey = cols.p, stripe = cols.s, acc = cols.a;
    // far leg
    limb(sk.hip, sk.kneeB, 0.105, J(stripe, 0.72));
    limb(sk.kneeB, sk.ankB, 0.075, J(jersey, 0.72));
    drawSkate(sk.ankB, 1, true);
    // far arm (lead / jab hand)
    limb(sk.fsh, sk.fel, 0.085, J(jersey, 0.72));
    limb(sk.fel, sk.ffist, 0.075, J(jersey, 0.72));
    drawFist(sk.ffist, look.skin, F.gloves, cols, true, 0);
    // near leg
    limb(sk.hip, sk.kneeF, 0.11, J(stripe));
    limb(sk.kneeF, sk.ankF, 0.078, J(jersey));
    const shinMid = lerp2(sk.kneeF, sk.ankF, 0.45), shinMid2 = lerp2(sk.kneeF, sk.ankF, 0.62);
    ctx.lineCap = 'butt'; limb(shinMid, shinMid2, 0.078, J(acc), false); ctx.lineCap = 'round';
    drawSkate(sk.ankF, 1, false);
    // breezers
    blob(sk.hip[0] + 0.005, sk.hip[1] + 0.03, 0.088, 0.062, sk.lean * 0.5, J(stripe));
    // torso
    const sl = Math.sin(sk.lean), cl = Math.cos(sk.lean);
    const d = [sl, -cl], f = [cl, sl];
    const at = (o, a, b) => [o[0] + d[0] * a + f[0] * b, o[1] + d[1] * a + f[1] * b];
    const hem = at(sk.hip, -0.04, 0), top = at(sk.sh, 0.045, -0.01);
    const torso = () => {
      ctx.beginPath();
      const p0 = at(hem, 0, -0.105), p1 = at(hem, 0, 0.095);
      ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
      const c1 = at(sk.hip, 0.16, 0.125), s1 = at(sk.sh, -0.005, 0.1);
      ctx.quadraticCurveTo(c1[0], c1[1], s1[0], s1[1]);
      const c2 = at(top, 0, 0.07);
      ctx.quadraticCurveTo(c2[0], c2[1], top[0], top[1]);
      const c3 = at(top, 0, -0.11), s2 = at(sk.sh, -0.02, -0.12);
      ctx.quadraticCurveTo(c3[0], c3[1], s2[0], s2[1]);
      const c4 = at(sk.hip, 0.15, -0.135);
      ctx.quadraticCurveTo(c4[0], c4[1], p0[0], p0[1]);
      ctx.closePath();
    };
    torso();
    ctx.fillStyle = J(jersey); ctx.fill();
    ctx.save(); ctx.clip();
    // hem stripes + shoulder yoke
    const band = (a0, a1, col) => { const q = [at(hem, a0, -0.3), at(hem, a0, 0.3), at(hem, a1, 0.3), at(hem, a1, -0.3)]; ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(...q[0]); for (const p of q.slice(1)) ctx.lineTo(...p); ctx.fill(); };
    band(0.035, 0.085, J(stripe)); band(0.045, 0.055, J(acc)); band(0.065, 0.075, J(acc));
    band(0.31, 0.5, J(stripe));
    // shading on the back side
    const sh0 = at(sk.hip, 0.15, -0.2), sh1 = at(sk.hip, 0.15, -0.04);
    const g = ctx.createLinearGradient(sh0[0], sh0[1], sh1[0], sh1[1]);
    g.addColorStop(0, 'rgba(0,0,0,0.32)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(-2, -2, 4, 4);
    ctx.restore();
    torso(); ctx.strokeStyle = css(INK); ctx.lineWidth = 0.013; ctx.stroke();
    // jersey number (kept readable when mirrored)
    if (S.nums[i] !== '' && S.nums[i] != null) {
      const np = at(sk.hip, 0.17, -0.025);
      ctx.save();
      ctx.translate(np[0], np[1]); ctx.rotate(sk.lean); if (i === 1) ctx.scale(-1, 1);
      ctx.scale(0.0085, 0.0085);
      ctx.font = `900 11px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 2.4; ctx.strokeStyle = J(stripe); ctx.strokeText(String(S.nums[i]), 0, 0);
      ctx.fillStyle = J(acc); ctx.fillText(String(S.nums[i]), 0, 0);
      ctx.restore();
    }
    // neck + head
    limb(sk.sh, sk.neck, 0.05, css(mixc(look.skin, [255, 255, 255], flash)));
    drawHead(F, P, look, cols, flash);
    // near arm (power hand)
    limb(sk.nsh, sk.nel, 0.09, J(jersey));
    limb(sk.nel, sk.nfist, 0.08, J(jersey));
    const c0 = lerp2(sk.nel, sk.nfist, 0.3), c1 = lerp2(sk.nel, sk.nfist, 0.45);
    ctx.lineCap = 'butt'; limb(c0, c1, 0.08, J(stripe), false); ctx.lineCap = 'round';
    drawFist(sk.nfist, look.skin, F.gloves, cols, false, P.glow);
    ctx.restore();
  }

  function drawProps() {
    for (const p of S.props) {
      const cols = S.cols[p.i];
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.strokeStyle = css(INK); ctx.lineWidth = 0.012;
      if (p.k === 'glove') {
        ctx.fillStyle = css(cols.p);
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-0.06, -0.035, 0.12, 0.07, 0.022) : ctx.rect(-0.06, -0.035, 0.12, 0.07); ctx.fill(); ctx.stroke();
        ctx.fillStyle = css(cols.s); ctx.fillRect(-0.06, -0.035, 0.03, 0.07);
        ctx.strokeStyle = css(shade(cols.p, 0.6)); ctx.lineWidth = 0.006;
        ctx.beginPath(); ctx.moveTo(0.0, -0.02); ctx.lineTo(0.05, -0.02); ctx.moveTo(0.0, 0.0); ctx.lineTo(0.05, 0.0); ctx.stroke();
      } else {
        ctx.fillStyle = css(cols.s);
        ctx.beginPath(); ctx.moveTo(-0.08, 0.03); ctx.bezierCurveTo(-0.09, -0.1, 0.085, -0.1, 0.082, 0.03); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = css(cols.p); ctx.fillRect(-0.05, -0.05, 0.08, 0.016);
        ctx.strokeStyle = 'rgba(200,230,255,0.85)'; ctx.lineWidth = 0.012;
        ctx.beginPath(); ctx.moveTo(0.066, -0.01); ctx.lineTo(0.09, 0.03); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawSticks() {
    for (let k = 0; k < 2; k++) {
      const s = S.sticks[k], cols = S.cols[k];
      ctx.save(); ctx.translate(s.x, -0.012); ctx.rotate(s.r * (k ? -1 : 1));
      ctx.strokeStyle = css(INK); ctx.lineWidth = 0.034; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-0.42, 0); ctx.lineTo(0.3, 0); ctx.lineTo(0.42, 0.012); ctx.stroke();
      ctx.strokeStyle = '#d8c39a'; ctx.lineWidth = 0.02;
      ctx.beginPath(); ctx.moveTo(-0.42, 0); ctx.lineTo(0.3, 0); ctx.stroke();
      ctx.strokeStyle = css(cols.p); ctx.lineWidth = 0.024;
      ctx.beginPath(); ctx.moveTo(0.3, 0); ctx.lineTo(0.42, 0.012); ctx.stroke();
      ctx.strokeStyle = '#1b1b1b'; ctx.beginPath(); ctx.moveTo(-0.42, 0); ctx.lineTo(-0.34, 0); ctx.stroke();
      ctx.restore();
    }
  }

  function drawParticles() {
    for (const p of S.parts) {
      const a = 1 - p.t / p.life;
      if (p.k === 'star') {
        const s = p.s * (0.6 + easeOut(clamp(p.t / p.life * 2, 0, 1)) * 0.6);
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.beginPath();
        for (let k = 0; k < 18; k++) { const r = k % 2 ? s * 0.38 : s * (0.8 + (k % 4) * 0.12); const ang = (k / 18) * Math.PI * 2; ctx.lineTo(Math.cos(ang) * r, Math.sin(ang) * r); }
        ctx.closePath();
        ctx.fillStyle = css(p.col, a); ctx.fill();
        ctx.lineWidth = 0.008; ctx.strokeStyle = css(INK, a * 0.8); ctx.stroke();
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`; ctx.beginPath(); ctx.arc(0, 0, s * 0.3, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      } else if (p.k === 'ring') {
        ctx.strokeStyle = css(p.col, a * 0.8); ctx.lineWidth = 0.02 * a;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.s + p.t * 1.2, 0, Math.PI * 2); ctx.stroke();
      } else if (p.k === 'shield') {
        ctx.strokeStyle = `rgba(150,225,255,${(a * 0.9).toFixed(3)})`; ctx.lineWidth = 0.016;
        const r = p.s * (0.8 + p.t * 2);
        ctx.beginPath(); ctx.arc(p.x - p.dir * r * 0.6, p.y, r, -0.9 + (p.dir < 0 ? Math.PI : 0), 0.9 + (p.dir < 0 ? Math.PI : 0)); ctx.stroke();
      } else if (p.k === 'drop') {
        ctx.fillStyle = `rgba(200,235,255,${(a * 0.9).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2); ctx.fill();
      } else if (p.k === 'spark') {
        ctx.strokeStyle = `rgba(190,240,255,${a.toFixed(3)})`; ctx.lineWidth = 0.008;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
      } else if (p.k === 'ice') {
        ctx.fillStyle = `rgba(255,255,255,${(a * 0.85).toFixed(3)})`;
        ctx.fillRect(p.x - p.s, p.y - p.s, p.s * 2, p.s * 2);
      }
    }
  }

  function drawWorld() {
    // shadows
    for (let i = 0; i < 2; i++) {
      const P = S.F[i].cur;
      const cx = sgn(i) * (BASE_X + P.hx) + (P.rot ? -sgn(i) * Math.sin(-P.rot) * 0.45 : 0);
      ctx.fillStyle = 'rgba(5,10,25,0.38)';
      ctx.beginPath(); ctx.ellipse(cx, 0.0, 0.2 + Math.abs(P.rot) * 0.3, 0.028, 0, 0, Math.PI * 2); ctx.fill();
    }
    drawSticks();
    // KO'd fighter on the ice is drawn first; otherwise draw the attacker last so the punch reads on top
    const order = [0, 1];
    if (S.ko && S.ko.how === 'ko') { order[0] = S.ko.l; order[1] = S.ko.w; }
    else {
      const busy = (i) => { const st = S.F[i].st; return st === 'jab' || st === 'hay' ? 2 : st === 'grab' ? 1 : 0; };
      if (busy(0) > busy(1)) { order[0] = 1; order[1] = 0; }
    }
    for (const i of order) {
      const F = S.F[i];
      // dodge afterimages
      for (let g = F.ghosts.length - 1; g >= 2; g -= 2) {
        ctx.save(); ctx.globalAlpha = 0.18 * (1 - g / 10);
        drawFighter(i, F.ghosts[g], { sk: skeleton(F.ghosts[g]), flash: 0.65 });
        ctx.restore();
      }
      drawFighter(i, F.cur);
    }
    drawProps();          // dropped gloves / helmets lie on the near side of the skates
    drawParticles();
  }

  // ---------------------------------------------------------------- drawing: overlay (screen px)
  function title(txt, x, y, size, o = {}) {
    ctx.save();
    ctx.translate(x, y);
    ctx.transform(1, 0, o.skew ?? -0.2, 1, 0, 0);
    ctx.font = `italic 900 ${Math.round(size)}px ${FONT}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(size * (o.ls || 0))}px`;
    let sc = o.scale ?? 1;
    if (o.maxW) { const w = ctx.measureText(txt).width; if (w * sc > o.maxW) sc = o.maxW / w; }
    ctx.scale(sc, sc);
    ctx.rotate(o.rot || 0);
    ctx.globalAlpha = clamp((o.alpha ?? 1) * S.alphaMul, 0, 1);
    ctx.textAlign = o.align || 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.fillStyle = o.shadow || 'rgba(0,0,0,0.6)';
    ctx.fillText(txt, size * 0.05, size * 0.08);
    if (o.sw !== 0) { ctx.lineWidth = size * (o.sw ?? 0.17); ctx.strokeStyle = o.stroke || css(INK); ctx.strokeText(txt, 0, 0); }
    const g = ctx.createLinearGradient(0, -size * 0.45, 0, size * 0.45);
    g.addColorStop(0, o.top || '#ffffff'); g.addColorStop(0.55, o.mid || o.top || '#ffffff'); g.addColorStop(1, o.bot || '#ffd23f');
    ctx.fillStyle = g; ctx.fillText(txt, 0, 0);
    ctx.restore();
  }
  function para(x, y, w, h, sk) {
    ctx.beginPath(); ctx.moveTo(x + sk, y); ctx.lineTo(x + w + sk, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
  }

  function drawHUD() {
    const { W, H } = S, snap = S.snap;
    const hs = clamp(Math.max(Math.min(W / 1150, H / 640), Math.min(W / 760, 1)), 0.5, 1.7);
    const labels = hs >= 0.68;   // tiny screens: drop the STAMINA / DODGE captions, keep the meters
    const top = Math.max(8, H * 0.03);
    const gap = 46 * hs;
    const bw = Math.min(W / 2 - gap - 12 * hs, 430 * hs), bh = 20 * hs, sk = 10 * hs;
    const nameY = top + 12 * hs, barY = top + 26 * hs, stY = barY + bh + 7 * hs;
    for (let i = 0; i < 2; i++) {
      const F = S.F[i], cols = S.cols[i];
      const x0 = i === 0 ? W / 2 - gap - bw : W / 2 + gap;
      // name plate
      ctx.save();
      ctx.font = `italic 900 ${Math.round(Math.max(9.5, 15 * hs))}px ${FONT}`; ctx.textBaseline = 'middle';
      ctx.textAlign = i === 0 ? 'left' : 'right';
      const nx = i === 0 ? x0 + 4 * hs : x0 + bw - 4 * hs;
      const label = S.names[i] + (S.nums[i] !== '' ? `  #${S.nums[i]}` : '');
      ctx.lineWidth = 4 * hs; ctx.strokeStyle = css(INK); ctx.strokeText(label, nx, nameY);
      ctx.fillStyle = '#fff'; ctx.fillText(label, nx, nameY);
      ctx.restore();
      // hp bar
      ctx.save();
      para(x0 - 3 * hs, barY - 3 * hs, bw + 6 * hs, bh + 6 * hs, i === 0 ? sk : -sk);
      ctx.fillStyle = 'rgba(5,8,18,0.85)'; ctx.fill();
      ctx.lineWidth = 2 * hs; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
      para(x0, barY, bw, bh, i === 0 ? sk : -sk); ctx.clip();
      // hp is anchored at the inner (clock) side and drains toward the outer edge
      const fill = (v, col) => {
        const w = clamp(v / FIGHT.HP, 0, 1) * bw;
        if (w <= 0.5) return;
        para(i === 0 ? x0 + bw - w : x0, barY, w, bh, i === 0 ? sk : -sk);
        ctx.fillStyle = col; ctx.fill();
      };
      fill(F.hpTrail, 'rgba(255,255,255,0.9)');
      const low = F.hpShow < FIGHT.HP * 0.3;
      const pulse = low ? 0.5 + 0.5 * Math.sin(S.real * 12) : 0;
      const g = ctx.createLinearGradient(0, barY, 0, barY + bh);
      const base = low ? mixc(cols.p, [255, 50, 50], 0.5 + pulse * 0.3) : cols.p;
      g.addColorStop(0, css(shade(base, 1.45))); g.addColorStop(0.5, css(base)); g.addColorStop(1, css(shade(base, 0.7)));
      fill(F.hpShow, g);
      ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(x0 - sk, barY + 2 * hs, bw + sk * 2, bh * 0.22);
      ctx.restore();
      // stamina pills (fill from the inner side, like the hp bar)
      const en = clamp(+(i === 0 ? snap.enA : snap.enB) || 0, 0, 1);
      const segs = 10, sw = (bw * 0.72) / segs, shh = 7 * hs;
      for (let k = 0; k < segs; k++) {
        const idx = i === 0 ? segs - 1 - k : k;
        const amt = clamp(en * segs - idx, 0, 1);
        const xx = i === 0 ? x0 + bw * 0.28 + k * sw : x0 + k * sw;
        para(xx + 1.5 * hs, stY, sw - 3 * hs, shh, i === 0 ? 3 * hs : -3 * hs);
        ctx.fillStyle = 'rgba(5,8,18,0.8)'; ctx.fill();
        if (amt > 0) {
          ctx.save(); ctx.globalAlpha = (0.35 + 0.65 * amt) * S.alphaMul;
          para(xx + 1.5 * hs, stY, sw - 3 * hs, shh, i === 0 ? 3 * hs : -3 * hs);
          ctx.fillStyle = en < 0.25 ? '#ff9b3d' : '#7fe3ff'; ctx.fill(); ctx.restore();
        }
      }
      ctx.save();
      ctx.font = `italic 900 ${Math.round(8.5 * hs)}px ${FONT}`; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(220,235,255,0.75)';
      ctx.textAlign = i === 0 ? 'right' : 'left';
      if (labels) ctx.fillText('STAMINA', i === 0 ? x0 + bw * 0.27 : x0 + bw * 0.73, stY + shh / 2);
      // dodge pip
      const cd = clamp(+(i === 0 ? snap.cdA : snap.cdB) || 0, 0, 1);
      const px = i === 0 ? x0 + 10 * hs : x0 + bw - 10 * hs, py = stY + shh / 2, pr = 6 * hs;
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fillStyle = 'rgba(5,8,18,0.85)'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(px, py); ctx.arc(px, py, pr * 0.8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - cd)); ctx.closePath();
      ctx.fillStyle = cd <= 0 ? '#b6ff7a' : 'rgba(182,255,122,0.4)'; ctx.fill();
      ctx.font = `italic 900 ${Math.round(8 * hs)}px ${FONT}`; ctx.fillStyle = 'rgba(220,235,255,0.75)';
      ctx.textAlign = i === 0 ? 'left' : 'right';
      if (labels) ctx.fillText('DODGE', i === 0 ? px + pr + 4 * hs : px - pr - 4 * hs, py);
      ctx.restore();
      // counter-ready glint + combo
      const cr = (i === 0 ? snap.crA : snap.crB) | 0;
      if (cr && snap.ph === 'fight') {
        title('COUNTER READY', i === 0 ? x0 + bw * 0.5 : x0 + bw * 0.5, stY + shh + 13 * hs, 12 * hs, { alpha: 0.6 + 0.4 * Math.sin(S.real * 20), top: '#dff8ff', bot: '#62d6ff', sw: 0.2 });
      }
      if (F.comboShow > 0 && F.comboN >= 2) {
        const a = clamp(F.comboShow / 0.4, 0, 1);
        const pop = 1 + Math.max(0, F.comboShow - 1.2) * 2;
        title(`${F.comboN} HIT COMBO`, i === 0 ? x0 + 6 * hs : x0 + bw - 6 * hs, stY + shh + 34 * hs, 20 * hs, { alpha: a, scale: pop, align: i === 0 ? 'left' : 'right', top: '#fff6c8', bot: '#ff9d2e', maxW: bw * 0.6 });
      }
    }
    // clock badge
    const cx = W / 2, cy = top + 30 * hs, r = 30 * hs;
    ctx.save();
    ctx.beginPath();
    for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3; ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(5,8,18,0.92)'; ctx.fill();
    ctx.lineWidth = 2.5 * hs; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.restore();
    let clockTxt = '';
    let urgent = false;
    if (snap.ph === 'intro') clockTxt = String(FIGHT.DURATION);
    else if (snap.ph === 'fight') { const t = Math.ceil(snap.t - 1e-6); clockTxt = String(Math.max(0, t)); urgent = snap.t <= 3; }
    else clockTxt = snap.how === 'ko' ? 'KO' : '0';
    title(clockTxt, cx, cy + 1 * hs, (clockTxt.length > 1 ? 24 : 30) * hs, { skew: -0.12, sw: 0.12, top: urgent ? '#ffd0d0' : '#ffffff', bot: urgent ? '#ff4040' : '#ffd23f', scale: urgent ? 1 + 0.08 * Math.max(0, Math.sin(S.real * 14)) : 1 });
    ctx.save();
    ctx.font = `italic 900 ${Math.round(9 * hs)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(230,240,255,0.85)';
    ctx.fillText('THE SCRAP', cx, cy + r + 9 * hs);
    ctx.restore();
  }

  function drawOverlayFx() {
    const { W, H } = S, snap = S.snap;
    const big = Math.min(W * 0.115, H * 0.17);
    // popups (anchored in world space)
    for (const p of S.pops) {
      const [x, y] = S.w2s(p.x, p.y - easeOut(clamp(p.t / p.life, 0, 1)) * p.rise);
      const a = p.t < p.life * 0.7 ? 1 : 1 - (p.t - p.life * 0.7) / (p.life * 0.3);
      const sc = p.t < 0.08 ? 1.5 - (p.t / 0.08) * 0.5 : 1;
      title(p.text, x, y, p.size * H * 1.1, { alpha: a, scale: sc, top: css(p.c1), bot: css(p.c2), maxW: W * 0.45 });
    }
    // intro
    if (snap.ph === 'intro') {
      const it = S.introT;
      const subA = smooth(0.0, 0.2, it);
      title('TEMPERS BOIL OVER', W / 2 + (1 - subA) * W * 0.3, H * 0.25, big * 0.28, { alpha: subA * (1 - 0.45 * smooth(0.3, 0.5, it)), ls: 0.12, sw: 0.25, top: '#d9ecff', bot: '#8fc4ff', maxW: W * 0.8 });
      if (it > 0.3) {
        const k = clamp((it - 0.3) / 0.16, 0, 1);
        const sc = k < 1 ? 2.4 - easeOut(k) * 1.4 : 1 + Math.sin((it - 0.46) * 9) * 0.015;
        title('GLOVES OFF!', W / 2, H * 0.45, big, { scale: sc, alpha: k * 1.2, top: '#ffffff', mid: '#fff1a8', bot: '#ff8a1f', maxW: W * 0.9, rot: -0.04 });
      }
    }
    // bell
    if (S.brawlT >= 0 && S.brawlT < 0.8 && !S.ko) {
      const k = S.brawlT / 0.8;
      title('BRAWL!', W / 2, H * 0.44, big * 1.1, { scale: 0.7 + easeOut(clamp(k * 3, 0, 1)) * 0.5 + k * 0.15, alpha: 1 - smooth(0.6, 1, k), top: '#fff', mid: '#ffd8d8', bot: '#ff3b3b', maxW: W * 0.9 });
    }
    // KO / decision
    if (S.ko) {
      const t = S.ko.t;
      const wi = S.ko.w, cols = S.cols[wi];
      if (S.ko.how === 'ko') {
        if (t > 0.18) {
          const k = clamp((t - 0.18) / 0.22, 0, 1);
          // radial speed lines
          if (t < 1.4) {
            ctx.save(); ctx.globalAlpha = 0.35 * (1 - smooth(0.9, 1.4, t)); ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1, H * 0.003);
            const ccx = W / 2, ccy = H * 0.42;
            for (let n = 0; n < 40; n++) { const a = n * 0.157 + S.real * 0.2; const r0 = H * (0.35 + ((n * 37) % 10) * 0.02); ctx.beginPath(); ctx.moveTo(ccx + Math.cos(a) * r0, ccy + Math.sin(a) * r0); ctx.lineTo(ccx + Math.cos(a) * W, ccy + Math.sin(a) * W); ctx.stroke(); }
            ctx.restore();
          }
          const out = smooth(1.05, 1.45, t);
          if (out < 1) title('LIGHTS OUT!', W / 2, H * (0.4 - 0.06 * out), big * 1.05, { scale: 2.2 - easeOut(k) * 1.2 - out * 0.25, alpha: k * (1 - out), top: '#ffffff', mid: '#fff3b0', bot: '#ffb21f', maxW: W * 0.92, rot: -0.05 });
        }
      } else if (t < 1.0) {
        const k = clamp(t / 0.2, 0, 1);
        title('TIME!', W / 2, H * 0.42, big, { scale: 1.8 - easeOut(k) * 0.8, alpha: k * (1 - smooth(0.7, 1.0, t)), top: '#fff', bot: '#9fd8ff' });
      }
      const bt = S.ko.how === 'ko' ? 1.05 : 0.75;
      if (t > bt) {
        const k = easeOut(clamp((t - bt) / 0.3, 0, 1));
        const by = H * 0.035, bh2 = H * 0.13;   // replaces the HUD strip (the HUD fades out underneath)
        ctx.save();
        ctx.translate((1 - k) * -W, 0);
        ctx.beginPath(); ctx.moveTo(-10, by); ctx.lineTo(W * 0.96, by); ctx.lineTo(W * 0.9, by + bh2); ctx.lineTo(-10, by + bh2); ctx.closePath();
        const g = ctx.createLinearGradient(0, by, W, by);
        g.addColorStop(0, css(shade(cols.p, 0.55))); g.addColorStop(0.5, css(cols.p)); g.addColorStop(1, css(shade(cols.p, 0.75)));
        ctx.fillStyle = g; ctx.fill();
        ctx.fillStyle = css(cols.s); ctx.fillRect(-10, by + bh2 - H * 0.012, W * 0.9, H * 0.012);
        ctx.fillStyle = css(cols.a, 0.9); ctx.fillRect(-10, by, W * 0.96, H * 0.006);
        ctx.restore();
        const light = lum(cols.p) > 0.62;
        const txtTop = light ? '#1a1a1a' : '#ffffff', txtBot = light ? '#3a3a3a' : '#ffe9a6';
        title(`${S.names[wi]} WINS THE SCRAP`, W * 0.46 + (1 - k) * -W, by + bh2 * 0.42, bh2 * 0.46, { top: txtTop, bot: txtBot, stroke: light ? 'rgba(255,255,255,0.6)' : css(INK), maxW: W * 0.82 });
        if (S.reward) title(S.reward, W * 0.46 + (1 - k) * -W * 1.3, by + bh2 * 0.82, bh2 * 0.2, { top: '#ffffff', bot: '#ffcf4a', ls: 0.12, maxW: W * 0.7, sw: 0.3 });
      }
    }
  }

  function drawFrame() {
    const { W, H, dpr } = S;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (W < 2 || H < 2) return;
    const u = S.u, gy = S.gy;
    const sx = (Math.random() - 0.5) * 2 * S.shake, sy = (Math.random() - 0.5) * 2 * S.shake;
    ctx.globalAlpha = 1;
    // backdrop with a little parallax
    const zb = 1 + (S.cam.z - 1) * 0.3, pan = S.cam.p * u;
    ctx.setTransform(dpr * zb, 0, 0, dpr * zb, dpr * (W / 2 + sx * 0.4 - (W / 2) * zb + S.cam.x * u * 0.15 - pan * 0.4), dpr * (gy + sy * 0.4 - gy * zb));
    if (S.bg) ctx.drawImage(S.bg, -BG_PAD * W, -BG_PAD * H, W * (1 + 2 * BG_PAD), H * (1 + 2 * BG_PAD));
    drawCrowdLive();
    // world: zoom z about the focus point (fx, fy), plus a sideways pan p (narrow screens, after a KO)
    const z = S.cam.z, fx = S.cam.x, fy = S.cam.y, k = u * z;
    const s0x = W / 2 + fx * u - pan, s0y = gy + fy * u;
    const ox = s0x - fx * k + sx, oy = s0y - fy * k + sy;
    S.w2s = (x, y) => [ox + x * k, oy + y * k];
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    drawWorld();
    // screen-space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // vignette
    if (S.vig) ctx.drawImage(S.vig, 0, 0, W, H);
    if (S.slowT > 0) { ctx.fillStyle = `rgba(20,0,10,${(0.25 * clamp(S.slowT / 0.3, 0, 1)).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
    // cinematic bars
    const lb = H * 0.055 * easeOut(S.shown);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, lb); ctx.fillRect(0, H - lb * 1.25, W, lb * 1.25);
    drawOverlayFx();
    // the HUD bows out while the winner banner slides over it
    const hudA = S.ko ? 1 - smooth(S.ko.how === 'ko' ? 1.0 : 0.7, S.ko.how === 'ko' ? 1.3 : 1.0, S.ko.t) : 1;
    if (hudA > 0.01) {
      S.alphaMul = hudA; ctx.globalAlpha = hudA;
      drawHUD();
      S.alphaMul = 1; ctx.globalAlpha = 1;
    }
    if (S.hint && S.snap.ph !== 'ko') {
      ctx.save();
      ctx.font = `italic 800 ${Math.round(clamp(H * 0.022, 10, 18))}px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
      ctx.fillStyle = 'rgba(230,240,255,0.78)';
      let txt = S.hint;
      const maxW = W - 24;
      if (ctx.measureText(txt).width > maxW) { ctx.font = `italic 800 ${Math.round(clamp(H * 0.022, 10, 18) * maxW / ctx.measureText(txt).width)}px ${FONT}`; }
      ctx.fillText(txt, W / 2, H - lb * 0.62);
      ctx.restore();
    }
    if (S.flash > 0) { ctx.fillStyle = css(S.flashCol, S.flash); ctx.fillRect(0, 0, W, H); }
  }

  // ---------------------------------------------------------------- public API
  function show(snap, opts) {
    if (disposed) return;
    S = fresh(snap || null, opts);
    if (snap) {
      S.lastPh = snap.ph;
      if (snap.ph === 'intro') S.introT = clamp(FIGHT.INTRO - (+snap.t || 0), 0, FIGHT.INTRO);
      else { S.introT = FIGHT.INTRO; S.cam.z = 1; layGearFlat(); }
      if (snap.ph === 'ko') startKO(snap.how, snap.winner);
      for (let i = 0; i < 2; i++) S.F[i].hpShow = S.F[i].hpTrail = clamp(+(i ? snap.hpB : snap.hpA) || 0, 0, FIGHT.HP);
    }
    if (S.introT >= 0.3) for (let i = 0; i < 2; i++) S.F[i].gloves = S.F[i].gloves && false;
    if (S.introT >= 0.5) for (let i = 0; i < 2; i++) S.F[i].helmet = false;
    root.classList.add('ir-fight-on');
    fit();
    if (S.snap) { step(0); drawFrame(); }
  }

  function update(snap, dt, events) {
    if (disposed || !S || !S.on) return;
    if (snap) S.snap = snap;
    if (!S.snap) return;
    dt = clamp(+dt || 0, 0, 0.1);
    fit();
    phaseCheck(S.snap);
    if (Array.isArray(events) && events.length) {
      // the knockout punch speaks for itself: no "INTERRUPTED!/COUNTER!" chatter on that frame
      S.quiet = events.some((e) => e && (e.type === 'ko' || (e.type === 'fight' && e.sub === 'ko')) && e.how === 'ko');
      for (const e of events) onEvent(e);
      S.quiet = false;
    }
    step(dt);
    drawFrame();
  }

  function hide() {
    if (!S) return;
    S.on = false;
    root.classList.remove('ir-fight-on');
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    hide();
    root.remove();
    styleUsers = Math.max(0, styleUsers - 1);
    if (!styleUsers) { const st = doc.getElementById(STYLE_ID); if (st) st.remove(); }
  }

  return { show, update, hide, dispose, get visible() { return !!(S && S.on); }, canvas };
}
