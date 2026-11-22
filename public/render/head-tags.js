// ICE RIOT renderer - head indicators: the plates that float over the skaters' helmets (arcade style,
// in ICE RIOT's own look). Spec: Coqui page "Final · in game", frame "Head indicators".
//
//   local plate (ctx.myId + couch players): slot badge P1.., name, turbo bar, slap-charge bar while
//     charging, "On fire" / "Max" status, and a slot-colour caret pointing down at the helmet
//   remote human: name tag with a 1px border in the team colour
//   AI skater: number + name tag (goalies get none)
//   tough guy (checking >= FIGHT_TRIGGER.minChk): a fist roundel 4px left of the plate or tag
//
// Usage (render/players.js fills the entries, render/renderer.js calls render() after the scene):
//   const tags = createHeadTags();
//   const e = tags.entries[id];          // one per snapshot player id 0..7; fill every frame:
//   e.kind (TAG.*), e.slot (local slot 0..), e.name, e.num (AI jersey), e.team (0xRRGGBB, remote border),
//   e.tb (turbo 0..1), e.ch (charge 0..1), e.charging, e.fire, e.tough, e.anchor (world top of the helmet)
//   tags.update(dt, hidden);             // after filling: visibility + motion (hidden = replay / fight)
//   tags.render(renderer, camera);       // after the main render: one extra pass, skipped when empty
//
// Each plate is a 2D canvas on a quad in a separate orthographic scene whose units are drawing-buffer
// pixels. That keeps plates on top of everything, the same size at any camera distance, and placed on
// whole device pixels (one texel per pixel: crisp text). The anchor is projected with the same camera
// matrices the frame was just drawn with, so a plate never lags its skater. A canvas is redrawn only
// when what it shows changes (bars in 2% steps); nothing is allocated per frame.
import * as THREE from 'three';

export const TAG = { NONE: 0, LOCAL: 1, REMOTE: 2, AI: 3, FIST: 4 };
/** Local slot colours (--slot-1..4). render/players.js uses the same values for the floor rings. */
export const SLOT_COLORS = [0xffe14a, 0x46f0ff, 0xff5ad8, 0x8dff4a];

// layout, in CSS px at 1x (scaled by s = clamp(viewport height / 900, 0.85, 1.5) x pixel ratio)
const CW = 268, CH = 52, CX = CW / 2;      // canvas; plates are centred on CX, bottom-anchored on CH
const PLATE_B = 45;                        // local plate body bottom (the caret fills 45..52)
const GAP_LOCAL = 7, GAP_TAG = 10;         // caret tip / tag bottom above the top of the helmet
const EDGE = 8;                            // keep plates this far inside the viewport
const OFF = 20;                            // a head this far past the edge still counts as on screen (body visible)
const MIN_W = 96, MAX_W = 220, NAME_MAX = 104, AI_NAME_MAX = 96;
const FULL = 0.999;                        // charge counted as full
// motion (seconds)
const T_IN = 0.16, T_OUT = 0.12, T_ROW = 0.12, TAU_BAR = 0.08 / 3, RISE = 4;

const P_FLAME = 'M2.88 0 C3.24 1.92 5.76 3 5.76 6 C5.76 7.59 4.47 8.88 2.88 8.88 C1.29 8.88 0 7.59 0 6 C0 4.68 0.72 3.84 1.38 3.24 C1.5 4.14 1.92 4.68 2.52 4.92 C2.28 3.42 2.28 1.68 2.88 0 Z';
const P_FIST = 'M2.5 3.2a1 1 0 0 1 2 0V2.7a1 1 0 0 1 2 0V2.5a1 1 0 0 1 2 0V3a1 1 0 0 1 2 0V8c0 1.4-1.1 2.5-2.5 2.5H5C3.6 10.5 2.5 9.4 2.5 8Z';
const P_FIST_LINES = 'M4.5 3V5.4M6.5 2.7V5.4M8.5 3V5.4M3.3 6.7H7.4';
const P_CARET = 'M0 0H12L6 7Z';

// design tokens (read from :root when style.css is loaded; these fallbacks are the same values)
const TOKENS = {
  ground: ['--ground', '#0A0F1C'], surface3: ['--surface-3', '#1E2940'], hairlineStrong: ['--hairline-strong', '#34425F'],
  ink: ['--ink', '#E8EDF5'], ink2: ['--ink-2', '#A1ACC0'], ink3: ['--ink-3', '#6A7590'], onIce: ['--on-ice', '#0A0F1C'],
  turbo: ['--turbo', '#7CC4FF'], goal: ['--goal', '#FF4B3E'], fire: ['--fire', '#FF8A2A'],
  slot1: ['--slot-1', '#FFE14A'], slot2: ['--slot-2', '#46F0FF'], slot3: ['--slot-3', '#FF5AD8'], slot4: ['--slot-4', '#8DFF4A'],
  font: ['--f-ui', 'Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif'],
};
function readTokens() {
  let cs = null;
  try { cs = getComputedStyle(document.documentElement); } catch { cs = null; }
  const out = {};
  for (const key of Object.keys(TOKENS)) {
    const [name, fb] = TOKENS[key];
    let v = '';
    try { v = cs ? cs.getPropertyValue(name).trim() : ''; } catch { v = ''; }
    out[key] = v || fb;
  }
  out.slots = [out.slot1, out.slot2, out.slot3, out.slot4];
  return out;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const easeOut = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
const hexCss = (n) => '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');

export function createHeadTags() {
  const scene = new THREE.Scene();
  scene.name = 'head-tags';
  const cam = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10);
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.translate(0.5, -0.5, 0);            // origin at the top-left corner, y up (screen y is -y)
  const _v = new THREE.Vector3(), _size = new THREE.Vector2(), _buf = new THREE.Vector2();

  let K = 0;                               // canvas px per CSS px (s x drawing-buffer pixel ratio)
  let tok = null;
  let paths = null;                        // Path2D, built on first draw
  const metrics = new Map();               // font -> { a, d } (ascent / descent, device px)
  let redraws = 0, passes = 0;

  let reducedMQ = null;
  try { reducedMQ = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null; } catch { reducedMQ = null; }
  const reduced = () => !!(reducedMQ && reducedMQ.matches);

  function makeTex(c) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
  }

  function makeEntry(id) {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const tex = makeTex(canvas);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
    const mesh = new THREE.Mesh(quad, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return {
      id,
      // ---- input: written by render/players.js every frame
      kind: TAG.NONE, slot: 0, name: '', num: 0, team: 0xffffff,
      tb: 1, ch: 0, charging: false, fire: false, tough: false,
      anchor: new THREE.Vector3(),
      // ---- shown state + motion
      vk: TAG.NONE, vslot: 0,              // kind / slot being shown (kept while fading out)
      a: 0, exiting: false,                // appear progress 0..1
      turbo: 1, slap: 0, row: 0,           // displayed turbo, charge, slap-row height 0..1
      vStat: 0, statA: 0,                  // displayed status bits (1 fire, 2 max) and its opacity
      onScreen: true,
      // ---- last drawn (redraw only when one of these changes)
      dk: -1, dSlot: -1, dName: null, dNum: -1, dTeam: -1, dTough: false, dTq: -1, dSq: -1, dRq: -1, dAq: -1,
      dStat: -1, dFull: -1, dFire: -1, dK: 0,
      // ---- layout of the drawing, logical px inside the canvas (for the viewport clamp)
      l: CX, r: CX, t: CH, gap: GAP_TAG,
      canvas, g: canvas.getContext('2d'), tex, mat, mesh,
    };
  }
  const entries = [];
  for (let id = 0; id < 8; id++) entries.push(makeEntry(id));

  const statusOf = (e) => (e.kind === TAG.LOCAL ? (e.fire ? 1 : 0) | (e.charging && e.ch >= FULL ? 2 : 0) : 0);

  function snapContent(e) {
    e.turbo = clamp01(e.tb);
    e.slap = e.charging ? clamp01(e.ch) : 0;
    e.row = e.charging ? 1 : 0;
    e.vStat = statusOf(e);
    e.statA = e.vStat ? 1 : 0;
  }

  /** Visibility and motion. hidden = hide every plate (instant replay, fight, final). */
  function update(dt, hidden) {
    const rm = reduced();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.kind !== TAG.NONE && (e.kind !== e.vk || e.slot !== e.vslot)) {
        // a different plate on this skater (control switch, names toggled): appear afresh
        e.vk = e.kind; e.vslot = e.slot; e.a = 0; e.exiting = false;
        snapContent(e);
      }
      const want = !hidden && e.kind !== TAG.NONE && e.onScreen;
      if (want) { e.exiting = false; e.a = rm ? 1 : Math.min(1, e.a + dt / T_IN); }
      else if (e.a > 0) { e.exiting = true; e.a = rm ? 0 : Math.max(0, e.a - dt / T_OUT); }
      if (e.a <= 0) {
        if (e.kind === TAG.NONE) e.vk = TAG.NONE;
        else snapContent(e);
        continue;
      }
      if (e.kind !== e.vk || e.vk !== TAG.LOCAL) continue;
      // local plate content motion: bars 80 ms, slap row + status 120 ms
      const f = rm ? 1 : 1 - Math.exp(-dt / TAU_BAR);
      e.turbo += (clamp01(e.tb) - e.turbo) * f;
      if (e.charging) e.slap += (clamp01(e.ch) - e.slap) * f;
      const rt = e.charging ? 1 : 0;
      if (rm) e.row = rt;
      else if (e.row < rt) e.row = Math.min(rt, e.row + dt / T_ROW);
      else if (e.row > rt) e.row = Math.max(rt, e.row - dt / T_ROW);
      const st = statusOf(e);
      if (st !== e.vStat) {
        if (st && e.vStat) e.vStat = st;                         // "On fire" <-> "Max": swap in place
        else if (st) { e.vStat = st; e.statA = rm ? 1 : 0; }     // fade in
        else {                                                    // fade out, then drop
          e.statA = rm ? 0 : e.statA - dt / T_ROW;
          if (e.statA <= 0) { e.statA = 0; e.vStat = 0; }
        }
      } else if (st && e.statA < 1) e.statA = rm ? 1 : Math.min(1, e.statA + dt / T_ROW);
    }
  }

  function hideAll() {
    for (const e of entries) { e.kind = TAG.NONE; e.vk = TAG.NONE; e.a = 0; e.mesh.visible = false; e.onScreen = true; }
  }

  // ------------------------------------------------------------------ drawing
  function setScale(k) {
    K = k;
    tok = readTokens();
    metrics.clear();
    const w = Math.ceil(CW * k), h = Math.ceil(CH * k);
    for (const e of entries) {
      e.canvas.width = w; e.canvas.height = h;
      e.g = e.canvas.getContext('2d');
      e.tex.dispose();                     // the GPU texture has the old size: make a new one
      e.tex = makeTex(e.canvas);
      e.mat.map = e.tex;
      e.dk = -1;                           // force a redraw
    }
  }

  const font = (w, px) => `${w} ${px * K}px ${tok.font}`;
  const P = (v) => Math.round(v * K);

  /** CSS-style vertical centring: the alphabetic baseline (device px) of a line box `lh` tall at `top`. */
  function baseline(g, f, top, lh) {
    let m = metrics.get(f);
    if (!m) {
      g.font = f;
      const tm = g.measureText('Hg');
      const a = tm.fontBoundingBoxAscent ?? tm.actualBoundingBoxAscent ?? 0.8 * parseFloat(f.split(' ')[1]);
      const d = tm.fontBoundingBoxDescent ?? tm.actualBoundingBoxDescent ?? 0.2 * parseFloat(f.split(' ')[1]);
      m = { a, d };
      metrics.set(f, m);
    }
    return top * K + (lh * K - (m.a + m.d)) / 2 + m.a;
  }

  /** text cut with an ellipsis to fit `max` CSS px (g.font must be set). Returns [text, width in CSS px]. */
  function fit(g, text, max) {
    let w = g.measureText(text).width;
    if (w <= max * K) return [text, w / K];
    let n = text.length;
    let s = text;
    while (n > 1) {
      n--;
      s = text.slice(0, n).trimEnd() + '…';
      w = g.measureText(s).width;
      if (w <= max * K) break;
    }
    return [s, w / K];
  }

  function rrect(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r);
    g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r);
    g.closePath();
  }

  /** A CSS border-box: 1px border in `border`, ground fill. Logical rect. */
  function box(g, x0, y0, x1, y1, radius, border) {
    const X0 = P(x0), Y0 = P(y0), X1 = P(x1), Y1 = P(y1), bw = Math.max(1, Math.round(K));
    g.fillStyle = border; rrect(g, X0, Y0, X1 - X0, Y1 - Y0, radius * K); g.fill();
    g.fillStyle = tok.ground; rrect(g, X0 + bw, Y0 + bw, X1 - X0 - 2 * bw, Y1 - Y0 - 2 * bw, radius * K - bw); g.fill();
  }

  function bar(g, x, y, w, v, fill, gradient) {
    const X = P(x), Y = P(y), W = P(x + w) - X, H = P(y + 5) - Y, r = 3 * K;
    g.fillStyle = tok.surface3; rrect(g, X, Y, W, H, r); g.fill();
    const fw = Math.round(W * clamp01(v));
    if (fw <= 0) return;
    if (gradient) {
      const gr = g.createLinearGradient(X, 0, X + fw, 0);
      gr.addColorStop(0, tok.fire); gr.addColorStop(1, tok.goal);
      g.fillStyle = gr;
    } else g.fillStyle = fill;
    rrect(g, X, Y, fw, H, r); g.fill();
  }

  function path(g, p, x, y, scale, fill) {
    g.setTransform(K * scale, 0, 0, K * scale, x * K, y * K);
    g.fillStyle = fill; g.fill(p);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Fist roundel centred at (cx, cy): 20px goal circle, 1.5px ground ring, 12px fist. */
  function fist(g, cx, cy) {
    const X = cx * K, Y = cy * K;
    g.fillStyle = tok.ground; g.beginPath(); g.arc(X, Y, 10 * K, 0, Math.PI * 2); g.fill();
    g.fillStyle = tok.goal; g.beginPath(); g.arc(X, Y, 8.5 * K, 0, Math.PI * 2); g.fill();
    g.setTransform(K, 0, 0, K, X - 6 * K, Y - 6 * K);
    g.fillStyle = tok.ink; g.fill(paths.fist);
    g.strokeStyle = tok.goal; g.lineWidth = 0.8; g.lineCap = 'round'; g.lineJoin = 'miter'; g.stroke(paths.fistLines);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawLocal(e, g, tq, sq, rq, aq, full) {
    const slotCol = tok.slots[Math.min(e.vslot, tok.slots.length - 1)];
    const fName = font(700, 13), f700 = font(700, 12), f600 = font(600, 12);
    g.font = fName;
    const [name, nameW] = fit(g, e.name, NAME_MAX);
    const st = e.vStat;
    let stText = '', stFont = '', stColor = '', stW = 0;
    const flame = !!(st & 1);
    if (st) {
      const max = !!(st & 2);
      stText = max ? 'Max' : 'On fire'; stFont = max ? f700 : f600; stColor = max ? tok.goal : tok.fire;
      g.font = stFont;
      stW = (flame ? 12 : 0) + g.measureText(stText).width / K;
    }
    const contentW = 24 + 6 + nameW + (st ? 6 + stW : 0);
    const bodyW = clamp(Math.ceil(1 + 4 + contentW + 8 + 1), MIN_W, MAX_W);
    const row = rq / 16;
    const bodyH = 37 + 8 * row;
    const x0 = Math.round(CX - bodyW / 2), x1 = x0 + bodyW, y1 = PLATE_B, y0 = y1 - bodyH;
    const border = full ? tok.goal : e.fire ? tok.fire : slotCol;
    box(g, x0, y0, x1, y1, 6, border);
    // content, laid out from the bottom so the plate grows upward when the slap bar comes in
    const cx0 = x0 + 1 + 4, innerW = bodyW - 2 - 12;
    const slapY = y1 - 1 - 5 - 5, turboY = slapY - 8 * row, rowY = turboY - 3 - 18;
    if (row > 0) {
      g.globalAlpha = row;
      bar(g, cx0, slapY, innerW, sq / 50, tok.goal, !full);
      g.globalAlpha = 1;
    }
    const tv = tq / 50;
    bar(g, cx0, turboY, innerW, tv, tv < 0.25 ? tok.goal : tok.turbo, false);
    // name row: badge, name, status
    g.fillStyle = slotCol; rrect(g, P(cx0), P(rowY), P(cx0 + 24) - P(cx0), P(rowY + 18) - P(rowY), 4 * K); g.fill();
    g.textBaseline = 'alphabetic';
    g.textAlign = 'center'; g.font = f700; g.fillStyle = tok.onIce;
    g.fillText('P' + (e.vslot + 1), (cx0 + 12) * K, baseline(g, f700, rowY, 18));
    g.textAlign = 'left'; g.font = fName; g.fillStyle = tok.ink;
    g.fillText(name, (cx0 + 30) * K, baseline(g, fName, rowY, 18));
    if (st) {
      g.globalAlpha = aq / 10;
      let sx = cx0 + 30 + nameW + 6;
      if (flame) { const sc = 12 / 8.88; path(g, paths.flame, sx + (8 - 5.76 * sc) / 2, rowY + 3, sc, tok.fire); sx += 12; }
      g.font = stFont; g.fillStyle = stColor;
      g.fillText(stText, sx * K, baseline(g, stFont, rowY, 18));
      g.globalAlpha = 1;
    }
    // caret, touching the plate's bottom edge
    path(g, paths.caret, CX - 6, y1, 1, slotCol);
    if (e.tough) fist(g, x0 - 4 - 10, (y0 + y1) / 2);
    e.l = e.tough ? x0 - 24 : x0; e.r = x1; e.t = y0; e.gap = GAP_LOCAL;
  }

  function drawRemote(e, g) {
    const fName = font(700, 13);
    g.font = fName;
    const [name, nameW] = fit(g, e.name, NAME_MAX);
    const w = Math.ceil(1 + 9 + nameW + 9 + 1);
    const x0 = Math.round(CX - w / 2), x1 = x0 + w, y1 = CH, y0 = CH - 24;
    box(g, x0, y0, x1, y1, 6, hexCss(e.team));
    g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.font = fName; g.fillStyle = tok.ink;
    g.fillText(name, (x0 + 10) * K, baseline(g, fName, y0 + 3, 18));
    if (e.tough) fist(g, x0 - 4 - 10, y0 + 12);
    e.l = e.tough ? x0 - 24 : x0; e.r = x1; e.t = y0; e.gap = GAP_TAG;
  }

  function drawAI(e, g) {
    const f = font(600, 12);
    g.font = f;
    const num = String(e.num);
    const numW = g.measureText(num).width / K;
    const [name, nameW] = fit(g, e.name, AI_NAME_MAX);
    const w = Math.ceil(1 + 7 + numW + 4 + nameW + 7 + 1);
    const x0 = Math.round(CX - w / 2), x1 = x0 + w, y1 = CH, y0 = CH - 20;
    box(g, x0, y0, x1, y1, 6, tok.hairlineStrong);
    g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    const by = baseline(g, f, y0 + 3, 14);
    g.fillStyle = tok.ink3; g.fillText(num, (x0 + 8) * K, by);
    g.fillStyle = tok.ink2; g.fillText(name, (x0 + 8 + numW + 4) * K, by);
    if (e.tough) fist(g, x0 - 4 - 10, y0 + 10);
    e.l = e.tough ? x0 - 24 : x0; e.r = x1; e.t = y0; e.gap = GAP_TAG;
  }

  function drawFistOnly(e, g) {
    fist(g, CX, CH - 10);
    e.l = CX - 10; e.r = CX + 10; e.t = CH - 20; e.gap = GAP_TAG;
  }

  /** Redraw the entry's canvas if what it shows changed since the last draw. */
  function refresh(e) {
    const local = e.vk === TAG.LOCAL;
    const tq = local ? Math.round(e.turbo * 50) : 0;
    const sq = local ? Math.round(e.slap * 50) : 0;
    const rq = local ? Math.round(e.row * 16) : 0;
    const aq = local ? Math.round(e.statA * 10) : 0;
    const full = local && e.charging && e.ch >= FULL ? 1 : 0;
    const fire = local && e.fire ? 1 : 0;
    const stat = local ? e.vStat : 0;
    const num = e.vk === TAG.AI ? e.num : 0;
    const team = e.vk === TAG.REMOTE ? e.team : 0;
    const slot = local ? e.vslot : 0;
    if (e.dk === e.vk && e.dSlot === slot && e.dName === e.name && e.dNum === num && e.dTeam === team && e.dTough === e.tough &&
      e.dTq === tq && e.dSq === sq && e.dRq === rq && e.dAq === aq && e.dStat === stat && e.dFull === full && e.dFire === fire && e.dK === K) return;
    e.dk = e.vk; e.dSlot = slot; e.dName = e.name; e.dNum = num; e.dTeam = team; e.dTough = e.tough;
    e.dTq = tq; e.dSq = sq; e.dRq = rq; e.dAq = aq; e.dStat = stat; e.dFull = full; e.dFire = fire; e.dK = K;
    if (!paths) paths = { flame: new Path2D(P_FLAME), fist: new Path2D(P_FIST), fistLines: new Path2D(P_FIST_LINES), caret: new Path2D(P_CARET) };
    const g = e.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, e.canvas.width, e.canvas.height);
    if (e.vk === TAG.LOCAL) drawLocal(e, g, tq, sq, rq, aq, full);
    else if (e.vk === TAG.REMOTE) drawRemote(e, g);
    else if (e.vk === TAG.AI) drawAI(e, g);
    else drawFistOnly(e, g);
    e.tex.needsUpdate = true;
    redraws++;
  }

  // ------------------------------------------------------------------ per-frame placement + draw
  /** Call right after renderer.render(scene, camera): projects with the matrices that frame used. */
  function render(renderer, camera) {
    renderer.getSize(_size);
    renderer.getDrawingBufferSize(_buf);
    const W = _buf.x, H = _buf.y;
    if (!(W > 0 && H > 0 && _size.y > 0)) return;
    const k = Math.round(clamp(_size.y / 900, 0.85, 1.5) * (H / _size.y) * 1000) / 1000;
    if (k !== K) setScale(k);
    if (cam.right !== W || cam.bottom !== -H) { cam.left = 0; cam.right = W; cam.top = 0; cam.bottom = -H; cam.updateProjectionMatrix(); }
    const ax = P(CX), ay = P(CH), m = EDGE * K, off = OFF * K;
    let drawn = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.kind === TAG.NONE && e.a <= 0) { e.mesh.visible = false; continue; }
      _v.copy(e.anchor).project(camera);
      const behind = !(_v.z > -1 && _v.z < 1);
      const hx = (_v.x + 1) * 0.5 * W, hy = (1 - _v.y) * 0.5 * H;
      e.onScreen = !behind && hx >= -off && hx <= W + off && hy >= -off && hy <= H + off;
      if (e.a <= 0 || behind || e.vk === TAG.NONE) { e.mesh.visible = false; continue; }
      refresh(e);
      const ea = easeOut(e.a);
      let left = hx - ax;
      let top = hy - e.gap * K - ay + (e.exiting ? 0 : (1 - ea) * RISE * K);
      const cl = left + e.l * K, cr = left + e.r * K, ct = top + e.t * K, cb = top + CH * K;
      if (cl < m) left += m - cl; else if (cr > W - m) left -= cr - (W - m);
      if (ct < m) top += m - ct; else if (cb > H - m) top -= cb - (H - m);
      const mesh = e.mesh;
      mesh.position.set(Math.round(left), -Math.round(top), 0);
      mesh.scale.set(e.canvas.width, e.canvas.height, 1);
      e.mat.opacity = ea;
      // local plates over remote tags over AI tags; nearer skaters on top within a group
      mesh.renderOrder = (e.vk === TAG.LOCAL ? 30 : e.vk === TAG.REMOTE ? 20 : 10) + (1 - _v.z);
      mesh.visible = true;
      drawn++;
    }
    if (!drawn) return;
    const ac = renderer.autoClear, ar = renderer.info.autoReset;
    renderer.autoClear = false;            // draw over the frame
    renderer.info.autoReset = false;       // count into the frame's draw stats
    renderer.render(scene, cam);
    renderer.autoClear = ac;
    renderer.info.autoReset = ar;
    passes++;
  }

  function dispose() {
    for (const e of entries) { e.tex.dispose(); e.mat.dispose(); }
    quad.dispose();
  }

  return {
    entries, update, render, hideAll, dispose,
    /** debug: canvas redraws and overlay passes since creation */
    stats: () => ({ tagRedraws: redraws, tagPasses: passes }),
  };
}
