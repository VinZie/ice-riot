// ICE RIOT - procedural team crests, game wordmark and favicon (owner: Agent LOGOS).
//
// Everything here is generated SVG markup: no image files, no fonts, no network.
// Lettering uses a built-in angular stroke font, so output is identical on every machine.
// Output is deterministic (same arguments -> byte-identical string) and works in Node
// (strings only) and in the browser (svgToCanvas additionally needs a DOM).
//
//   teamLogoSVG(teamIndex, { size = 128, variant = 'full' | 'mark' | 'mono', mono = '#ffffff' })
//       'full' = badge + glyph + team key plate, in TEAMS colors with a dark outline
//       'mark' = the glyph alone, scaled to fill the 100x100 viewBox (HUD / small sizes)
//       'mono' = the full crest as a single-color stencil (details are transparent
//                knock-outs), e.g. for ice decals
//   gameLogoSVG({ width = 480, theme = 'dark' | 'light' })  -> "ICE RIOT" wordmark
//   svgToDataURI(svg)   -> 'data:image/svg+xml;utf8,<percent-encoded svg>'
//   faviconDataURI()    -> data URI of a 64x64 "IR" monogram
//   svgToCanvas(svg, w, h) -> Promise<HTMLCanvasElement> (browser only)
//
// Ids: 'full' and 'mark' crests use no element ids. 'mono' uses one <mask id="irm-KEY">
// and the wordmark uses ids prefixed "irw-<theme>-". Ids depend only on team / theme and
// the referenced content is identical for equal ids, so many logos can be inlined into
// one HTML document safely. (Avoid putting the FIRST inline copy inside display:none;
// some browsers then fail to resolve masks/gradients referenced by later copies.)

import { TEAMS, GAME_NAME } from '../shared/constants.js';

const INK = '#0a0e17';          // universal dark outline
const WHITE = '#ffffff';
const BLACK = '#000000';
const PREFIX = 'data:image/svg+xml;utf8,';
const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------------------
// Small numeric / path helpers
// ---------------------------------------------------------------------------------------

function num(n) {
  if (!Number.isFinite(n)) throw new Error(`logos: non-finite number ${n}`);
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? '0' : String(v);
}
const pt = (x, y) => `${num(x)} ${num(y)}`;
const hex = (n) => '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function poly(pts, close = true) {
  return 'M' + pts.map(([x, y]) => pt(x, y)).join(' L') + (close ? ' Z' : '');
}
function circle(cx, cy, r) {
  return `M${pt(cx - r, cy)} A${num(r)} ${num(r)} 0 1 0 ${pt(cx + r, cy)}` +
         ` A${num(r)} ${num(r)} 0 1 0 ${pt(cx - r, cy)} Z`;
}
const mx = (pts) => pts.map(([x, y]) => [100 - x, y]);
// Left half outline from top-center to bottom-center -> full symmetric polygon.
function sym(half) {
  return [...half, ...mx(half.slice(1, -1)).reverse()];
}
function ring(cx, cy, r, n, rot) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * 2 * Math.PI) / n;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}
function star(cx, cy, r1, r2, n, rot) {
  const out = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i * Math.PI) / n;
    const r = i % 2 ? r2 : r1;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

// Conservative bounding box of an absolute path made of M/L/H/V/Q/C/A/Z commands.
function pathBBox(d) {
  const tok = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  let i = 0, cmd = '', x = 0, y = 0;
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (px, py, pad = 0) => {
    b[0] = Math.min(b[0], px - pad); b[1] = Math.min(b[1], py - pad);
    b[2] = Math.max(b[2], px + pad); b[3] = Math.max(b[3], py + pad);
  };
  const n = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    switch (cmd) {
      case 'M': case 'L': x = n(); y = n(); add(x, y); break;
      case 'H': x = n(); add(x, y); break;
      case 'V': y = n(); add(x, y); break;
      case 'Q': add(n(), n()); x = n(); y = n(); add(x, y); break;
      case 'C': add(n(), n()); add(n(), n()); x = n(); y = n(); add(x, y); break;
      case 'A': { const rx = n(), ry = n(); n(); n(); n(); x = n(); y = n(); add(x, y, Math.max(rx, ry)); break; }
      case 'Z': case 'z': cmd = ''; break;
      default: i++; break;
    }
  }
  return b;
}

// ---------------------------------------------------------------------------------------
// Angular stroke font (centerline polylines on a 4 x 6 grid, y down). Rendered with square
// caps + miter joins, which gives a bold athletic block face. Only the letters the crests
// and wordmark need are defined (unknown characters advance like a space).
// ---------------------------------------------------------------------------------------

const FONT = {
  A: [4, [[[0, 6], [0, 1.5], [1.5, 0], [2.5, 0], [4, 1.5], [4, 6]], [[0, 3.6], [4, 3.6]]]],
  C: [4, [[[4, 0], [1.3, 0], [0, 1.3], [0, 4.7], [1.3, 6], [4, 6]]]],
  E: [3.7, [[[3.7, 0], [0, 0], [0, 6], [3.7, 6]], [[0, 3], [3, 3]]]],
  F: [3.7, [[[3.7, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]]],
  H: [4, [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]]],
  I: [0, [[[0, 0], [0, 6]]]],
  K: [4, [[[0, 0], [0, 6]], [[4, 0], [1.4, 3], [4, 6]], [[0, 3], [1.4, 3]]]],
  L: [3.6, [[[0, 0], [0, 6], [3.6, 6]]]],
  M: [5, [[[0, 6], [0, 0], [2.5, 3], [5, 0], [5, 6]]]],
  N: [4, [[[0, 6], [0, 0], [4, 6], [4, 0]]]],
  O: [4, [[[1.3, 0], [2.7, 0], [4, 1.3], [4, 4.7], [2.7, 6], [1.3, 6], [0, 4.7], [0, 1.3], [1.3, 0]]]],
  P: [4, [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2.6], [3, 3.6], [0, 3.6]]]],
  R: [4, [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2.4], [3, 3.4], [0, 3.4]], [[2.2, 3.4], [4, 6]]]],
  S: [4, [[[4, 0], [1, 0], [0, 1], [0, 2.1], [1, 3], [3, 3], [4, 3.9], [4, 5], [3, 6], [0, 6]]]],
  T: [4, [[[0, 0], [4, 0]], [[2, 0], [2, 6]]]],
  V: [4, [[[0, 0], [2, 6], [4, 0]]]],
  W: [5.4, [[[0, 0], [1.2, 6], [2.7, 2.2], [4.2, 6], [5.4, 0]]]],
  Y: [4, [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]]],
};
const SPACE = 2.6;

// Lay out `str` so the text's centerline box (cap height 6 grid units * k) is centered on
// (cx, cy). Returns { letters: [{ ch, d }], width } in user units. Skew slants to the right.
function layoutText(str, { cx, cy, k, track, skew }) {
  const chars = [...String(str).toUpperCase()];
  let gw = 0;
  const xs = [];
  chars.forEach((ch, idx) => {
    const g = FONT[ch];
    xs.push(gw);
    gw += g ? g[0] : SPACE;
    if (idx < chars.length - 1) gw += track;
  });
  const total = gw + skew * 6;
  const x0 = cx - (total * k) / 2, y0 = cy - 3 * k;
  const letters = chars.map((ch, idx) => {
    const g = FONT[ch];
    if (!g) return null;
    const d = g[1].map((line) => 'M' + line.map(([gx, gy]) =>
      pt(x0 + (xs[idx] + gx + skew * (6 - gy)) * k, y0 + gy * k)).join(' L')).join(' ');
    return { ch, d };
  }).filter(Boolean);
  return { letters, width: total * k };
}

// ---------------------------------------------------------------------------------------
// Crest "ops": every crest is a list of paint operations with semantic color tones so the
// same geometry renders in team colors ('full'/'mark') or as a stencil mask ('mono').
//   d   path data            f  fill tone or null        s  stroke tone or null
//   w   stroke width         o  opacity                  j/c  linejoin / linecap
//   po  stroke behind fill (outline outside the shape; default when f and s are both set)
//   m   mono role of the fill: 'ink' (solid) | 'cut' (transparent) | 'skip' (ignored)
//   ms  mono role of the stroke (default: 'cut' for the dark outline tone, else m)
//   only  'color' | 'mono' to restrict an op to one rendering
// Tones: p/s/a = team primary/secondary/accent, ink = dark outline, w = white, k = black.
// ---------------------------------------------------------------------------------------

const F = (d, f, extra) => ({ d, f, ...extra });
const O = (d, f, s, w, extra) => ({ d, f, s, w, ...extra });   // outlined shape
const S = (d, s, w, extra) => ({ d, f: null, s, w, ...extra }); // stroke only

function paletteFor(team) {
  const c = team.colors;
  return { p: hex(c.primary), s: hex(c.secondary), a: hex(c.accent), ink: INK, w: WHITE, k: BLACK };
}

function renderOp(op, pal) {
  const a = [`d="${op.d}"`];
  a.push(`fill="${op.f ? pal[op.f] : 'none'}"`);
  if (op.s) {
    a.push(`stroke="${pal[op.s]}"`, `stroke-width="${num(op.w)}"`);
    a.push(`stroke-linejoin="${op.j || 'round'}"`);
    if (op.c) a.push(`stroke-linecap="${op.c}"`);
    if (op.da) a.push(`stroke-dasharray="${op.da}"`);
    if (op.po ?? !!op.f) a.push('paint-order="stroke"');
  }
  if (op.o != null && op.o !== 1) a.push(`opacity="${num(op.o)}"`);
  return `<path ${a.join(' ')}/>`;
}

function renderMaskOp(op) {
  const m = op.m || 'ink';
  if (m === 'skip' && !op.ms) return '';
  const col = (role) => (role === 'cut' ? '#000' : '#fff');
  const ms = op.ms || (op.s === 'ink' ? 'cut' : m);
  const a = [`d="${op.d}"`];
  a.push(`fill="${op.f && m !== 'skip' ? col(m) : 'none'}"`);
  if (op.s && ms !== 'skip') {
    a.push(`stroke="${col(ms)}"`, `stroke-width="${num(op.w)}"`, `stroke-linejoin="${op.j || 'round'}"`);
    if (op.c) a.push(`stroke-linecap="${op.c}"`);
    if (op.da) a.push(`stroke-dasharray="${op.da}"`);
    if (op.po ?? !!op.f) a.push('paint-order="stroke"');
  }
  return `<path ${a.join(' ')}/>`;
}

// Inset a convex polygon by distance d (offset every edge inward, intersect neighbours).
function inset(pts, d) {
  const n = pts.length;
  const c = pts.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
    let nx = -uy, ny = ux;
    if (nx * (c[0] - p[0]) + ny * (c[1] - p[1]) < 0) { nx = -nx; ny = -ny; }
    return { px: p[0] + nx * d, py: p[1] + ny * d, ux, uy };
  });
  return lines.map((l1, i) => {
    const l0 = lines[(i - 1 + n) % n];
    const t = ((l1.px - l0.px) * l1.uy - (l1.py - l0.py) * l1.ux) / (l0.ux * l1.uy - l0.uy * l1.ux);
    return [l0.px + l0.ux * t, l0.py + l0.uy * t];
  });
}
// Rotate points (deg) about (cx, cy) after scaling local coordinates by sc.
function place(pts, cx, cy, deg, sc = 1) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return pts.map(([x, y]) => [cx + (x * c - y * s) * sc, cy + (x * s + y * c) * sc]);
}

// Team key plate: slanted bar with the 3-letter key. Text and plate share the same slant.
function keyPlate(key, { y = 71.5, h = 15, x0 = 13, x1 = 87, plate, text, rim = null }) {
  const skew = 0.2, sk = h * skew;
  const pts = [[x0 + sk, y], [x1 + sk, y], [x1, y + h], [x0, y + h]];
  const ops = [O(poly(pts), plate, 'ink', 3.2, { j: 'miter', ms: 'skip' })];
  if (rim) ops.push(S(poly(inset(pts, 2)), rim, 0.9, { j: 'miter', m: 'skip', ms: 'cut' }));
  const k = (h * 0.56) / 7.6; // visual cap height ~56% of the plate height (incl. stroke)
  const { letters } = layoutText(key, { cx: 50 + sk / 2 - 0.4, cy: y + h / 2, k, track: 2.1, skew });
  ops.push(S(letters.map((l) => l.d).join(' '), text, 1.6 * k, { j: 'miter', c: 'square', ms: 'cut' }));
  return ops;
}

// Badge: bright outer band (base) with the dark outline, a dark inner field separated from
// the band by a thin dark line, and an optional thin rim line just inside the field.
// Mono: solid band, field knocked out, thin rim line kept.
function badge(outer, field, rim, { base, fieldTone, rimTone, outW = 4.6 }) {
  const ops = [
    O(outer, base, 'ink', outW, { ms: 'skip' }),
    O(field, fieldTone, 'ink', 2.2, { m: 'cut', ms: 'cut' }),
  ];
  if (rim) ops.push(S(rim, rimTone, 1.4, { ms: 'ink' }));
  return ops;
}

// --- Harbor Hammers: heater shield, crossed sledgehammers over a harbor life ring --------
function crestHAM() {
  const shield = 'M50 4 L87 11.5 Q91 12.5 91 16.5 L91 45 Q91 75 50 96.5 Q9 75 9 45 L9 16.5 Q9 12.5 13 11.5 Z';
  const field = 'M50 11.2 L84.2 18 L84.2 45 Q84.2 69.8 50 88.6 Q15.8 69.8 15.8 45 L15.8 18 Z';
  const rim = 'M50 15 L80.8 21 L80.8 45 Q80.8 67.6 50 84.6 Q19.2 67.6 19.2 45 L19.2 21 Z';
  const cx = 50, cy = 46.5, sc = 0.9;
  const hammer = (deg) => {
    const P = (pts) => poly(place(pts, cx, cy, deg, sc));
    return [
      O(P([[-3.6, -18], [3.6, -18], [3.6, 31], [-3.6, 31]]), 'a', 'ink', 3, { j: 'miter' }),
      F(P([[-3.6, 21], [3.6, 21], [3.6, 23.5], [-3.6, 23.5]]), 's', { m: 'cut' }),
      F(P([[-3.6, 26], [3.6, 26], [3.6, 28.5], [-3.6, 28.5]]), 's', { m: 'cut' }),
      O(P([[-11.5, -32], [11.5, -32], [15, -28.5], [15, -18.5], [11.5, -15], [-11.5, -15], [-15, -18.5], [-15, -28.5]]),
        'p', 'ink', 3.2, { j: 'miter' }),
      F(P([[-11.5, -32], [11.5, -32], [15, -28.5], [-15, -28.5]]), 'w', { o: 0.38, m: 'skip' }),
      F(P([[-6.8, -32], [-4, -32], [-4, -15], [-6.8, -15]]), 's', { m: 'cut' }),
      F(P([[4, -32], [6.8, -32], [6.8, -15], [4, -15]]), 's', { m: 'cut' }),
    ];
  };
  const lifeRing = circle(cx, cy, 13.5);
  return {
    badge: badge(shield, field, rim, { base: 'p', fieldTone: 's', rimTone: 'a' }),
    glyph: [
      S(lifeRing, 'ink', 10.5, { ms: 'cut' }),
      S(lifeRing, 'a', 6),
      S(lifeRing, 'p', 6, { da: '10.6 10.6', m: 'skip', ms: 'skip' }),
      ...hammer(-42),
      ...hammer(42),
    ],
    plate: keyPlate('HAM', { plate: 's', text: 'a', rim: 'p' }),
  };
}

// --- Frostbite Wolves: hexagon, frontal low-poly wolf mask ------------------------------
function crestFWV() {
  const hexa = (r) => ring(50, 50, r, 6, -Math.PI / 2);
  const head = sym([[50, 26], [41, 28.5], [27, 11.5], [23.5, 36.5], [12.5, 47], [30, 58.5], [50, 74]]);
  const earL = [[28.5, 18.5], [38.5, 29.5], [26, 34.5]];
  const eyeL = [[27.5, 38.5], [44, 44.5], [35.5, 48.5]];
  const glintL = [[33, 41.3], [38, 43], [35, 44.5]];
  return {
    badge: badge(poly(hexa(47)), poly(hexa(39)), poly(hexa(35.4)), { base: 'p', fieldTone: 's', rimTone: 'a' }),
    glyph: [
      O(poly(head), 'p', 'ink', 4),
      F(poly([[50, 26], [59, 28.5], [73, 11.5], [76.5, 36.5], [87.5, 47], [70, 58.5], [50, 74]]), 'k', { o: 0.16, m: 'skip' }),
      F(poly([[23.5, 36.5], [12.5, 47], [30, 58.5], [35, 47.5]]), 'w', { o: 0.3, m: 'skip' }),
      F(poly([[27, 11.5], [41, 28.5], [35, 36]]), 'w', { o: 0.22, m: 'skip' }),
      F(poly(earL), 's', { m: 'cut' }),
      F(poly(mx(earL)), 's', { m: 'cut' }),
      F(poly([[50, 29], [54.5, 34], [50, 45], [45.5, 34]]), 'a', { m: 'cut' }),
      F(poly([[40.5, 50.5], [50, 47], [59.5, 50.5], [56, 62.5], [50, 72], [44, 62.5]]), 'a', { m: 'cut' }),
      F(poly([[50, 47], [59.5, 50.5], [56, 62.5], [50, 72]]), 'k', { o: 0.12, m: 'skip' }),
      O(poly(eyeL), 'ink', 'ink', 1, { m: 'cut', ms: 'cut' }),
      O(poly(mx(eyeL)), 'ink', 'ink', 1, { m: 'cut', ms: 'cut' }),
      F(poly(glintL), 'p', { only: 'color' }),
      F(poly(mx(glintL)), 'p', { only: 'color' }),
      O(poly([[45, 60], [55, 60], [50, 66]]), 'ink', 'ink', 1, { m: 'ink', ms: 'ink' }),
    ],
    plate: keyPlate('FWV', { y: 73.5, plate: 'a', text: 's' }),
  };
}

// --- Neon Vipers: slanted speed badge, neon-tube serpent coiled into a zig-zag S ---------
function crestNVP() {
  const outer = [[23, 5], [85, 5], [93, 15], [77, 95], [15, 95], [7, 85]];
  // upright design, shrunk 10% about (50, 42), then given the badge's italic slant
  const lean = (pts) => pts.map(([x, y]) => [50 + (x - 50) * 0.9, 42 + (y - 42) * 0.9])
    .map(([x, y]) => [x + 0.2 * (50 - y), y]);
  const body = lean([[57, 22], [38.5, 22], [30, 32.5], [70, 52], [61.5, 62.5], [41, 62.5]]);
  const head = lean([[51, 12.5], [63, 13], [73.5, 19], [77, 22], [73.5, 25], [63, 31], [51, 31.5], [55, 22]]);
  const jaw = lean([[55, 22], [77, 22], [73.5, 25], [63, 31], [51, 31.5]]);
  const eye = lean([[60.5, 16.8], [69.5, 19.6], [62, 22]]);
  const tail = lean([[42.5, 58], [42.5, 67], [23.5, 65]]);
  const t = lean([[77, 22], [82.5, 22], [86.5, 18.5], [86.5, 25.5]]);
  const tongue = `M${pt(...t[0])} L${pt(...t[1])} L${pt(...t[2])} M${pt(...t[1])} L${pt(...t[3])}`;
  const bodyD = poly(body, false);
  return {
    badge: badge(poly(outer), poly(inset(outer, 7)), poly(inset(outer, 10.4)), { base: 'p', fieldTone: 's', rimTone: 'a' }),
    glyph: [
      S(tongue, 'ink', 4.4, { c: 'round', ms: 'cut' }),
      S(tongue, 'a', 1.8, { c: 'round' }),
      O(poly(tail), 'p', 'ink', 3.4, { j: 'miter' }),
      S(bodyD, 'ink', 14.5, { j: 'miter', c: 'butt', ms: 'cut' }),
      S(bodyD, 'p', 9, { j: 'miter', c: 'butt' }),
      S(bodyD, 'w', 2.4, { j: 'miter', c: 'butt', o: 0.6, m: 'skip', ms: 'cut' }),
      O(poly(head), 'p', 'ink', 3.4, { j: 'miter' }),
      F(poly(jaw), 'k', { o: 0.22, m: 'skip' }),
      F(poly(eye), 'a', { m: 'cut' }),
    ],
    plate: keyPlate('NVP', { y: 72, plate: 'a', text: 's' }),
  };
}

// --- Iron Yetis: riveted octagon plate, glaring mountain-head ---------------------------
function crestIYT() {
  const oct = (r) => poly(ring(50, 50, r, 8, Math.PI / 8));
  const rivets = ring(50, 50, 44, 8, Math.PI / 8);
  const eyeL = [[34.5, 45], [47, 49], [46, 53], [37, 50.5]];
  const fangL = [[42, 59.5], [46.2, 59.5], [44.1, 64.8]];
  return {
    badge: [
      ...badge(oct(48), oct(40), null, { base: 'p' , fieldTone: 's' }),
      ...rivets.map(([x, y]) => O(circle(x, y, 1.9), 'ink', 'ink', 0.6, { m: 'cut', ms: 'cut' })),
      ...rivets.map(([x, y]) => F(circle(x - 0.6, y - 0.6, 0.7), 'w', { o: 0.75, m: 'skip' })),
    ],
    glyph: [
      O(poly([[50, 13], [84, 68.5], [16, 68.5]]), 'p', 'ink', 3.8),
      F(poly([[50, 13], [84, 68.5], [50, 68.5]]), 'k', { o: 0.17, m: 'skip' }),
      F(poly([[50, 13], [61.2, 31.2], [56.5, 28.2], [53, 34.5], [49, 29], [44.5, 33.5], [38.8, 31.2]]), 'w'),
      S(poly([[61.2, 31.2], [56.5, 28.2], [53, 34.5], [49, 29], [44.5, 33.5], [38.8, 31.2]], false), 'k', 1.8,
        { only: 'mono', ms: 'cut', c: 'round' }),
      F(poly([[50, 13], [61.2, 31.2], [56.5, 28.2], [53, 34.5], [50, 30.4]]), 'p', { o: 0.35, m: 'skip' }),
      F(poly([[32, 42.5], [50, 47.5], [68, 42.5], [67, 49.5], [50, 56], [33, 49.5]]), 's', { m: 'cut' }),
      F(poly(eyeL), 'a', { m: 'ink' }),
      F(poly(mx(eyeL)), 'a', { m: 'ink' }),
      F(poly([[38.5, 59], [61.5, 59], [64.6, 68.5], [35.4, 68.5]]), 's', { m: 'cut' }),
      F(poly(fangL), 'w', { m: 'ink' }),
      F(poly(mx(fangL)), 'w', { m: 'ink' }),
    ],
    plate: keyPlate('IYT', { plate: 'a', text: 's' }),
  };
}

// --- Solar Flares: 16-spike sun ring with a twin-tongue flare ---------------------------
function crestSFL() {
  const spikes = star(50, 47, 48, 35, 16, -Math.PI / 2);
  const flame = 'M50 16 C52.5 25 60 28 61.5 36.5 C63 31.5 66 30 67.5 27.5 C72 37 72.5 47 68.5 54.5 ' +
    'C65 61 58 64.5 50 64.5 C42 64.5 35 61 31.5 54.5 C27.5 47 29 37.5 34.5 31 C35.5 35 37.5 37 40 38.5 ' +
    'C39.5 29.5 44 22.5 50 16 Z';
  const inner = 'M50 31 C52 37.5 57 40 58 46 C59.5 44 60.5 43 61 41.5 C64.5 47.5 63.5 54 60.5 57.5 ' +
    'C57.5 61 54 62 50 62 C46 62 42.5 61 39.5 57.5 C36.5 53.5 37 48 40.5 43.5 C41.5 46.5 43.5 48 45.5 48 ' +
    'C45 41.5 47 36 50 31 Z';
  const core = 'M50 45 C51.5 49 55 51 55 55 C55 58.5 52.5 60 50 60 C47.5 60 45 58.5 45 55 C45 51 48.5 49 50 45 Z';
  return {
    badge: [],
    glyph: [
      O(poly(spikes), 's', 'ink', 3.2, { j: 'miter', ms: 'skip' }),
      S(circle(50, 47, 33.5), 'k', 4.5, { only: 'mono', ms: 'cut' }),
      O(circle(50, 47, 31.5), 'p', 'ink', 3, { m: 'cut', ms: 'cut' }),
      S(circle(50, 47, 27.5), 's', 1.6, { m: 'skip', ms: 'ink', o: 0.9 }),
      O(flame, 's', 'ink', 2.8, { m: 'ink' }),
      F(inner, 'p', { m: 'cut' }),
      F(core, 'w', { m: 'ink' }),
    ],
    plate: keyPlate('SFL', { y: 72, plate: 'a', text: 'p' }),
  };
}

// --- Midnight Krakens: roundel, crescent over a deep-sea eye riding the swell -----------
function crestMKR() {
  const eye = 'M18 42 Q50 12 82 42 Q50 72 18 42 Z';
  const wave = 'M24 63 Q30.5 56.5 37 63 Q43.5 69.5 50 63 Q56.5 56.5 63 63 Q69.5 69.5 76 63';
  const pupil = 'M38.5 42 Q50 36 61.5 42 Q50 48 38.5 42 Z'; // horizontal lens, cephalopod-style
  return {
    badge: badge(circle(50, 50, 47), circle(50, 50, 40), circle(50, 50, 36.6), { base: 'p', fieldTone: 's', rimTone: 'a', outW: 4 }),
    glyph: [
      O(circle(50, 20.5, 6), 'a', 'ink', 2.2),
      F(circle(54, 19.3, 5.2), 's', { m: 'cut' }),
      S(wave, 'ink', 7.5, { c: 'round', ms: 'cut' }),
      S(wave, 'p', 3.6, { c: 'round' }),
      O(eye, 'a', 'ink', 3.4),
      O(circle(50, 42, 13), 'p', 'ink', 2.4, { m: 'cut', ms: 'cut' }),
      S(circle(50, 42, 9), 's', 1.3, { o: 0.45, m: 'skip' }),
      O(pupil, 'ink', 'ink', 0.8, { m: 'ink', ms: 'ink' }),
      F(circle(55.5, 36.4, 2.1), 'w', { m: 'cut' }),
      F('M24 42 Q50 20 76 42 Q50 26 24 42 Z', 'w', { o: 0.4, m: 'skip' }),
    ],
    plate: keyPlate('MKR', { y: 72, plate: 's', text: 'p', rim: 'a' }),
  };
}

const CRESTS = [crestHAM, crestFWV, crestNVP, crestIYT, crestSFL, crestMKR];
const _crestCache = new Map();
function crestOps(teamIndex) {
  if (!_crestCache.has(teamIndex)) _crestCache.set(teamIndex, CRESTS[teamIndex]());
  return _crestCache.get(teamIndex);
}

function sanitizeColor(c, fallback) {
  if (typeof c === 'number' && Number.isFinite(c)) return hex(c);
  if (typeof c === 'string') {
    const s = c.trim();
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s.toLowerCase();
    if (/^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%\s,/+-]+\)$/i.test(s)) return s;
    if (/^[a-z]{3,20}$/i.test(s)) return s.toLowerCase();
  }
  return fallback;
}

function svgOpen(w, h, vw, vh, label) {
  return `<svg xmlns="${SVG_NS}" width="${num(w)}" height="${num(h)}" viewBox="0 0 ${num(vw)} ${num(vh)}" ` +
         `role="img" aria-label="${esc(label)}">`;
}

/**
 * Team crest as complete <svg> markup (viewBox 0 0 100 100).
 * @param {number} teamIndex index into TEAMS
 * @param {{size?: number, variant?: 'full'|'mark'|'mono', mono?: string|number}} [opts]
 */
export function teamLogoSVG(teamIndex, { size = 128, variant = 'full', mono = '#ffffff' } = {}) {
  if (!Number.isInteger(teamIndex) || teamIndex < 0 || teamIndex >= TEAMS.length || !CRESTS[teamIndex]) {
    throw new RangeError(`teamLogoSVG: teamIndex must be an integer 0..${TEAMS.length - 1}, got ${teamIndex}`);
  }
  if (variant !== 'full' && variant !== 'mark' && variant !== 'mono') {
    throw new RangeError(`teamLogoSVG: unknown variant "${variant}" (use 'full', 'mark' or 'mono')`);
  }
  const px = Number.isFinite(+size) && +size > 0 ? +size : 128;
  const team = TEAMS[teamIndex];
  const pal = paletteFor(team);
  const crest = crestOps(teamIndex);
  const label = `${team.city} ${team.name} ${variant === 'mark' ? 'mark' : 'crest'}`;
  const color = (op) => op.only !== 'mono';
  let body;
  if (variant === 'full') {
    body = [...crest.badge, ...crest.glyph, ...crest.plate].filter(color).map((op) => renderOp(op, pal)).join('');
  } else if (variant === 'mark') {
    const ops = crest.glyph.filter(color);
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const op of ops) {
      if (op.o === 0) continue;
      const b = pathBBox(op.d);
      const pad = op.s ? op.w / 2 : 0;
      bb[0] = Math.min(bb[0], b[0] - pad); bb[1] = Math.min(bb[1], b[1] - pad);
      bb[2] = Math.max(bb[2], b[2] + pad); bb[3] = Math.max(bb[3], b[3] + pad);
    }
    const inner = 92; // leave a 4-unit margin
    const sc = inner / Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    const tx = 50 - ((bb[0] + bb[2]) / 2) * sc, ty = 50 - ((bb[1] + bb[3]) / 2) * sc;
    body = `<g transform="translate(${pt(tx, ty)}) scale(${num(Math.round(sc * 1000) / 1000)})">` +
           ops.map((op) => renderOp(op, pal)).join('') + '</g>';
  } else {
    const ink = sanitizeColor(mono, WHITE);
    const ops = [...crest.badge, ...crest.glyph, ...crest.plate].filter((op) => op.only !== 'color');
    const id = `irm-${team.key}`;
    body = `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">` +
           `<rect width="100" height="100" fill="#000"/>` + ops.map(renderMaskOp).join('') +
           `</mask></defs><rect width="100" height="100" fill="${esc(ink)}" mask="url(#${id})"/>`;
  }
  return svgOpen(px, px, 100, 100, label) + body + '</svg>';
}

// ---------------------------------------------------------------------------------------
// "ICE RIOT" wordmark: slanted block letters (ICE = glacier gradient, RIOT = hot orange)
// over a cracked glass pane with a spider-web impact and flying shards.
// ---------------------------------------------------------------------------------------

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WM = { W: 400, H: 132 };
const _wmCache = new Map();

function wordmarkBody(theme) {
  if (_wmCache.has(theme)) return _wmCache.get(theme);
  const dark = theme !== 'light';
  const { W, H } = WM;
  const skew = 0.24, track = 2.55, swG = 1.95;
  const words = String(GAME_NAME).toUpperCase().split(/\s+/);
  const text = words.join(' ');
  // fit to width
  let gw = 0; const chars = [...text];
  chars.forEach((ch, i) => { gw += FONT[ch] ? FONT[ch][0] : SPACE; if (i < chars.length - 1) gw += track; });
  const k = Math.min((W - 44) / (gw + skew * 6 + swG), (H - 54) / (6 + swG));
  const sw = swG * k;
  const cx = W / 2, cy = H / 2 + 1;
  const { letters } = layoutText(text, { cx, cy, k, track, skew });
  // split letters into words
  const groups = [];
  let li = 0;
  for (const w of words) { const n = [...w].filter((c) => FONT[c]).length; groups.push(letters.slice(li, li + n)); li += n; }
  const dWord = groups.map((g) => g.map((l) => l.d).join(' '));
  const dAll = dWord.join(' ');
  const top = cy - 3 * k - sw / 2, bot = cy + 3 * k + sw / 2;
  const id = (s) => `irw-${dark ? 'dark' : 'light'}-${s}`;

  const C = dark
    ? { outline: '#06101f', pane: '#7fd3ff', paneO: 0.07, paneEdge: '#9fdcff', paneEdgeO: 0.55, crack: '#d8f3ff', crackO: 0.55,
        glowIce: '#7fd3ff', glowFire: '#ff6a13', glowO: 0.24, shard: '#cfeeff', shardEdge: '#06101f' }
    : { outline: '#0b1a2e', pane: '#0b2545', paneO: 0.06, paneEdge: '#0b2545', paneEdgeO: 0.4, crack: '#0b2545', crackO: 0.35,
        glowIce: '#0b1a2e', glowFire: '#0b1a2e', glowO: 0.16, shard: '#bfe9ff', shardEdge: '#0b1a2e' };

  // glass pane (parallelogram) with a broken top-right corner
  const py0 = top - 13, py1 = bot + 13, sk = skew * (py1 - py0);
  const px0 = 14, px1 = W - 14 - sk;
  const pane = poly([
    [px0 + sk, py0], [px1 + sk - 46, py0], [px1 + sk - 38, py0 + 7], [px1 + sk - 30, py0 + 2], [px1 + sk - 21, py0 + 14],
    [px1 + sk - 12, py0 + 11], [px1 + sk - 6, py0 + 24], [px1 + (sk * (py1 - py0 - 30)) / (py1 - py0), py0 + 30], [px1, py1], [px0, py1],
  ]);

  // crack network from an impact point between the words
  const rnd = prng(0x1ce5);
  const gap0 = groups[0][groups[0].length - 1], gap1 = groups[1] && groups[1][0];
  const bx = (pathBBox(gap0.d)[2] + (gap1 ? pathBBox(gap1.d)[0] : W - 40)) / 2;
  const ix = bx + 4, iy = cy - k * 0.6;
  const rays = [];
  const N = 12;
  for (let r = 0; r < N; r++) {
    let a = (r / N) * Math.PI * 2 + (rnd() - 0.5) * 0.35;
    let x = ix, y = iy, len = 0;
    const maxLen = 60 + rnd() * 120;
    const pts = [[x, y]];
    while (len < maxLen) {
      const seg = 10 + rnd() * 16;
      a += (rnd() - 0.5) * 0.5;
      const nx = x + Math.cos(a) * seg, ny = y + Math.sin(a) * seg * 0.8;
      if (ny < py0 + 2 || ny > py1 - 2 || nx < px0 + 4 || nx > W - 18) break;
      x = nx; y = ny; len += seg; pts.push([x, y]);
    }
    rays.push(pts);
  }
  const at = (pts, dist) => {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const s = Math.hypot(x1 - x0, y1 - y0);
      if (acc + s >= dist) { const t = (dist - acc) / s; return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]; }
      acc += s;
    }
    return null;
  };
  let crackD = rays.filter((p) => p.length > 1).map((p) => poly(p, false)).join(' ');
  for (const rad of [11, 26, 44]) {
    for (let r = 0; r < N; r++) {
      if (rnd() < 0.3) continue;
      const a = at(rays[r], rad * (0.9 + rnd() * 0.2)), b = at(rays[(r + 1) % N], rad * (0.9 + rnd() * 0.2));
      if (a && b) {
        const m = [(a[0] + b[0]) / 2 + (ix - (a[0] + b[0]) / 2) * 0.12, (a[1] + b[1]) / 2 + (iy - (a[1] + b[1]) / 2) * 0.12];
        crackD += ' ' + poly([a, m, b], false);
      }
    }
  }

  // shards flying out of the broken corner and the impact
  const shards = [];
  const shardAt = (x, y, s, rot) => {
    const p = [[0, -s], [s * 0.75, s * 0.55], [-s * 0.5, s * 0.35]].map(([u, v]) => [
      x + u * Math.cos(rot) - v * Math.sin(rot), y + u * Math.sin(rot) + v * Math.cos(rot)]);
    shards.push(poly(p));
  };
  const cxr = px1 + sk - 24, cyr = py0 + 6;
  for (let i = 0; i < 6; i++) {
    const s = 6.4 - i * 0.75 + rnd() * 1.2;
    shardAt(cxr + 6 + i * 6.2 + rnd() * 2.5, Math.max(s + 1.5, cyr - 3 - i * 1.4 + (rnd() - 0.5) * 6), s, rnd() * 6.28);
  }
  for (let i = 0; i < 4; i++) {
    const s = 4.6 - i * 0.7 + rnd() * 0.8;
    shardAt(px0 + 26 - i * 7.5 + rnd() * 2, Math.min(H - s - 1.5, py1 + 2 + i * 0.8 + rnd() * 2), s, rnd() * 6.28);
  }
  const shardD = shards.join(' ');
  const starImpact = poly(star(ix, iy, 6.5, 1.6, 6, rnd()));

  const g0 = top, g1 = bot;
  const defs =
    `<defs>` +
    `<linearGradient id="${id('ice')}" gradientUnits="userSpaceOnUse" x1="0" y1="${num(g0)}" x2="0" y2="${num(g1)}">` +
    `<stop offset="0" stop-color="#ffffff"/><stop offset="0.47" stop-color="#e4f6ff"/>` +
    `<stop offset="0.53" stop-color="#93d8ff"/><stop offset="1" stop-color="#2f8fe0"/></linearGradient>` +
    `<linearGradient id="${id('fire')}" gradientUnits="userSpaceOnUse" x1="0" y1="${num(g0)}" x2="0" y2="${num(g1)}">` +
    `<stop offset="0" stop-color="#fff2c2"/><stop offset="0.47" stop-color="#ffc53d"/>` +
    `<stop offset="0.53" stop-color="#ff7a1a"/><stop offset="1" stop-color="#d9300c"/></linearGradient>` +
    `<mask id="${id('letters')}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">` +
    `<path d="${dAll}" fill="none" stroke="#fff" stroke-width="${num(sw)}" stroke-linejoin="miter" stroke-linecap="square"/>` +
    `</mask></defs>`;

  const L = (d, stroke, w, extra = '', join = 'miter') =>
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${num(w)}" stroke-linejoin="${join}" stroke-linecap="square"${extra}/>`;

  let out = defs;
  // pane
  out += `<path d="${pane}" fill="${C.pane}" fill-opacity="${C.paneO}" stroke="${C.paneEdge}" stroke-opacity="${C.paneEdgeO}" stroke-width="1.4" stroke-linejoin="round"/>`;
  out += `<path d="${crackD}" fill="none" stroke="${C.crack}" stroke-opacity="${C.crackO}" stroke-width="1" stroke-linejoin="round" stroke-linecap="round"/>`;
  // glow / shadow
  if (dark) {
    out += L(dWord[0], C.glowIce, sw + 15, ` stroke-opacity="${C.glowO}"`, 'round');
    if (dWord[1]) out += L(dWord[1], C.glowFire, sw + 15, ` stroke-opacity="${C.glowO}"`, 'round');
  } else {
    out += `<g transform="translate(3.5 4.5)">` + L(dAll, C.glowIce, sw + 7, ` stroke-opacity="${C.glowO}"`) + '</g>';
  }
  // outline + fills
  out += L(dAll, C.outline, sw + 7);
  out += L(dWord[0], `url(#${id('ice')})`, sw);
  if (dWord[1]) out += L(dWord[1], `url(#${id('fire')})`, sw);
  // cracks etched into the letters
  out += `<g mask="url(#${id('letters')})">` +
    `<path d="${crackD}" fill="none" stroke="#06101f" stroke-opacity="0.55" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<g transform="translate(0.9 0.9)"><path d="${crackD}" fill="none" stroke="#ffffff" stroke-opacity="0.75" stroke-width="0.8" stroke-linejoin="round" stroke-linecap="round"/></g>` +
    `<path d="M0 ${num(top + sw * 0.75)} L${W} ${num(top + sw * 0.75)}" stroke="#ffffff" stroke-opacity="0.55" stroke-width="${num(sw * 0.16)}"/>` +
    `</g>`;
  // impact + shards
  out += `<path d="${starImpact}" fill="#ffffff" fill-opacity="${dark ? 0.9 : 0.95}" stroke="${C.outline}" stroke-width="1.2" stroke-linejoin="round"/>`;
  out += `<path d="${shardD}" fill="${C.shard}" stroke="${C.shardEdge}" stroke-width="1.3" stroke-linejoin="round" paint-order="stroke"/>`;
  _wmCache.set(theme, out);
  return out;
}

/** "ICE RIOT" wordmark as complete <svg> markup (viewBox 0 0 400 132). */
export function gameLogoSVG({ width = 480, theme = 'dark' } = {}) {
  const w = Number.isFinite(+width) && +width > 0 ? +width : 480;
  const t = theme === 'light' ? 'light' : 'dark';
  return svgOpen(w, (w * WM.H) / WM.W, WM.W, WM.H, GAME_NAME) + wordmarkBody(t) + '</svg>';
}

/** Percent-encode an SVG string into a data URI usable in <img src>, CSS url(), favicons. */
export function svgToDataURI(svg) {
  return PREFIX + encodeURIComponent(String(svg)).replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

let _favicon = null;
function faviconSVG() {
  const k = 5.3, sw = 2.05 * k, skew = 0.2;
  const { letters } = layoutText('IR', { cx: 32.6, cy: 32.5, k, track: 2.7, skew });
  const [dI, dR] = letters.map((l) => l.d);
  const L = (d, stroke, w) =>
    `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${num(w)}" stroke-linejoin="miter" stroke-linecap="square"/>`;
  return svgOpen(64, 64, 64, 64, GAME_NAME) +
    `<rect x="1.5" y="1.5" width="61" height="61" rx="14" fill="#0b1a2e" stroke="#7fd3ff" stroke-width="3"/>` +
    L(dI + ' ' + dR, '#020812', sw + 5) +
    L(dI, '#bfe9ff', sw) + L(dR, '#ff6a13', sw) +
    `<path d="M9 44 L22 37 L29 41 L40 27 L47 30 L57 17" fill="none" stroke="#0b1a2e" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M9 44 L22 37 L29 41 L40 27 L47 30 L57 17" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="0.9" stroke-linejoin="round" stroke-linecap="round"/>` +
    '</svg>';
}

/** 64x64 "IR" monogram favicon as a data URI (set as <link rel="icon" href=...>). */
export function faviconDataURI() {
  _favicon ||= svgToDataURI(faviconSVG());
  return _favicon;
}

/**
 * Rasterize SVG markup into a new canvas of w x h device pixels (browser only).
 * The SVG is re-sized to w x h before decoding so it rasterizes crisply at that size.
 * Ready for `new THREE.CanvasTexture(canvas)`.
 */
export async function svgToCanvas(svg, w, h) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new Error('svgToCanvas: needs a browser DOM (document + Image)');
  }
  const cw = Math.max(1, Math.round(+w || 256)), ch = Math.max(1, Math.round(+h || cw));
  const sized = String(svg).replace(/<svg\b([^>]*)>/, (m, attrs) =>
    `<svg${attrs.replace(/\s(?:width|height)="[^"]*"/g, '')} width="${cw}" height="${ch}">`);
  const img = new Image();
  img.decoding = 'async';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('svgToCanvas: SVG failed to decode'));
    img.src = svgToDataURI(sized);
  });
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
  return canvas;
}
