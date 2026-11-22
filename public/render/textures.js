// ICE RIOT renderer - procedural canvas textures. Everything is drawn at runtime; no assets.
import * as THREE from 'three';
import { RINK, FACEOFF_SPOTS, TEAMS } from '/shared/constants.js';
import { rng } from './util.js';

export const FONT = '"Arial Black", "Segoe UI Black", Impact, "Helvetica Neue", Arial, sans-serif';
export const FONT_COND = 'Impact, "Haettenschweiler", "Arial Narrow Bold", "Arial Black", sans-serif';

export const css = (hex) => '#' + (hex >>> 0).toString(16).padStart(6, '0');

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function canvasTex(c, { srgb = true, repeat = false, aniso = 1, mips = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = aniso;
  t.generateMipmaps = mips;
  if (!mips) t.minFilter = THREE.LinearFilter;
  return t;
}

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
  g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r);
  g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r);
  g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r);
  g.closePath();
}

/** Fit text into maxW by shrinking the font size. Returns the size used. */
function fitText(g, text, size, maxW, font = FONT, weight = '') {
  let s = size;
  g.font = `${weight} ${s}px ${font}`;
  while (g.measureText(text).width > maxW && s > 6) { s -= 2; g.font = `${weight} ${s}px ${font}`; }
  return s;
}

// --------------------------------------------------------------------------------------------
// Center-ice emblem (original ICE RIOT mark): hexagonal badge, lightning slash, stacked type.
export function drawEmblem(g, cx, cy, r, { alpha = 1, ring = true } = {}) {
  g.save();
  g.globalAlpha = alpha;
  g.translate(cx, cy);
  const hex = (rr) => {
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + i * Math.PI / 3;
      const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  };
  if (ring) {
    hex(r); g.fillStyle = '#0d1630'; g.fill();
    g.lineWidth = r * 0.07; g.strokeStyle = '#22c3ff'; g.stroke();
    hex(r * 0.86); g.lineWidth = r * 0.025; g.strokeStyle = '#ff6a13'; g.stroke();
  }
  // lightning slash behind the type
  g.beginPath();
  g.moveTo(-r * 0.62, -r * 0.62); g.lineTo(r * 0.12, -r * 0.1); g.lineTo(-r * 0.05, -r * 0.02);
  g.lineTo(r * 0.64, r * 0.62); g.lineTo(-r * 0.1, r * 0.08); g.lineTo(r * 0.06, 0.0);
  g.closePath();
  const lg = g.createLinearGradient(-r, -r, r, r);
  lg.addColorStop(0, '#ffd23f'); lg.addColorStop(1, '#ff4d1a');
  g.fillStyle = lg; g.fill();
  // stacked wordmark
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const s1 = r * 0.5;
  g.font = `italic ${s1}px ${FONT}`;
  g.lineWidth = r * 0.09; g.strokeStyle = '#0d1630';
  g.strokeText('ICE', -r * 0.04, -r * 0.3);
  g.fillStyle = '#ffffff'; g.fillText('ICE', -r * 0.04, -r * 0.3);
  const s2 = r * 0.44;
  g.font = `italic ${s2}px ${FONT}`;
  g.strokeText('RIOT', r * 0.04, r * 0.3);
  g.fillStyle = '#22c3ff'; g.fillText('RIOT', r * 0.04, r * 0.3);
  // stars
  const star = (x, y, rr) => {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? rr * 0.45 : rr;
      g.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q);
    }
    g.closePath(); g.fillStyle = '#ffffff'; g.fill();
  };
  if (ring) { star(-r * 0.66, 0, r * 0.08); star(r * 0.66, 0, r * 0.08); }
  g.restore();
}

// --------------------------------------------------------------------------------------------
export const ICE_PPM = 64;
export function makeIceTexture(aniso) {
  const PPM = ICE_PPM;
  const L = RINK.halfLength, Wd = RINK.halfWidth;
  const W = 2 * L * PPM, H = 2 * Wd * PPM;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const X = (x) => (x + L) * PPM, Z = (z) => (z + Wd) * PPM, M = (m) => m * PPM;
  const rand = rng(1337);

  g.fillStyle = '#f2f7fc';
  g.fillRect(0, 0, W, H);
  roundRectPath(g, 0, 0, W, H, M(RINK.cornerRadius));
  g.save();
  g.clip();

  // large-scale tone: slightly cooler / greyer toward the boards
  const rg = g.createRadialGradient(W / 2, H / 2, M(4), W / 2, H / 2, M(32));
  rg.addColorStop(0, 'rgba(255,255,255,0)');
  rg.addColorStop(1, 'rgba(160,185,210,0.22)');
  g.fillStyle = rg; g.fillRect(0, 0, W, H);

  // skate scratches
  g.lineCap = 'round';
  for (let i = 0; i < 4200; i++) {
    const x = rand() * W, y = rand() * H;
    const a = rand() * Math.PI * 2, len = M(0.4 + rand() * 2.6);
    const bend = (rand() - 0.5) * len * 0.6;
    g.strokeStyle = `rgba(${110 + rand() * 40 | 0},${140 + rand() * 40 | 0},${170 + rand() * 40 | 0},${0.025 + rand() * 0.05})`;
    g.lineWidth = 1 + rand() * 1.6;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a) * len * 0.5 - Math.sin(a) * bend, y + Math.sin(a) * len * 0.5 + Math.cos(a) * bend,
      x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }
  // snow buildup near the boards
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  for (let k = 0; k < 3; k++) {
    g.lineWidth = M(0.5 + k * 0.4);
    g.globalAlpha = 0.18;
    roundRectPath(g, 0, 0, W, H, M(RINK.cornerRadius));
    g.stroke();
  }
  g.globalAlpha = 1;

  // ---- paint (under the ice) ----
  const RED = '#d0142c', BLUE = '#0d4fc9';
  const line = (x, w, color) => { g.fillStyle = color; g.fillRect(X(x) - M(w) / 2, 0, M(w), H); };
  line(-RINK.blueLineX, 0.32, BLUE);
  line(RINK.blueLineX, 0.32, BLUE);
  // center red line with a dashed white core (original look)
  line(0, 0.34, RED);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  for (let z = -Wd; z < Wd; z += 0.9) g.fillRect(X(0) - M(0.04), Z(z), M(0.08), M(0.42));
  line(-RINK.goalLineX, 0.08, RED);
  line(RINK.goalLineX, 0.08, RED);

  // end-zone trapezoids behind the nets
  g.strokeStyle = RED; g.lineWidth = M(0.06);
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(X(s * RINK.goalLineX), Z(-3.3)); g.lineTo(X(s * L), Z(-4.4));
    g.moveTo(X(s * RINK.goalLineX), Z(3.3)); g.lineTo(X(s * L), Z(4.4));
    g.stroke();
  }

  const circle = (x, z, r, color, w) => {
    g.beginPath(); g.arc(X(x), Z(z), M(r), 0, Math.PI * 2);
    g.strokeStyle = color; g.lineWidth = M(w); g.stroke();
  };
  const dot = (x, z, r, color) => { g.beginPath(); g.arc(X(x), Z(z), M(r), 0, Math.PI * 2); g.fillStyle = color; g.fill(); };

  // creases (blue fill + red outline semicircle toward center ice)
  for (const s of [-1, 1]) {
    const gx = s * RINK.goalLineX;
    g.beginPath();
    g.moveTo(X(gx), Z(-RINK.creaseRadius));
    g.arc(X(gx), Z(0), M(RINK.creaseRadius), -Math.PI / 2, Math.PI / 2, s > 0);
    g.closePath();
    g.fillStyle = 'rgba(70,160,240,0.78)'; g.fill();
    g.strokeStyle = RED; g.lineWidth = M(0.06); g.stroke();
    // little crease ticks
    g.fillStyle = RED;
    g.fillRect(X(gx - s * 1.2) - M(0.03), Z(-RINK.creaseRadius * 0.72) - M(0.15), M(0.06), M(0.3));
    g.fillRect(X(gx - s * 1.2) - M(0.03), Z(RINK.creaseRadius * 0.72) - M(0.15), M(0.06), M(0.3));
  }

  // faceoff circles, hash marks, Ls, dots
  for (const f of FACEOFF_SPOTS) {
    if (f.x === 0 && f.z === 0) continue;
    circle(f.x, f.z, RINK.faceoffCircleR, RED, 0.07);
    g.fillStyle = RED;
    for (const sx of [-1, 1]) {
      for (const dz of [-0.9, 0.9]) {
        // hash marks on the left/right of the circle
        const hx = f.x + sx * Math.sqrt(RINK.faceoffCircleR ** 2 - dz * dz);
        g.fillRect(Math.min(X(hx), X(hx + sx * 0.6)), Z(f.z + dz) - M(0.035), M(0.6), M(0.07));
      }
      // L marks near the dot
      for (const sz of [-1, 1]) {
        const lx = f.x + sx * 0.6, lz = f.z + sz * 0.45;
        g.fillRect(Math.min(X(lx), X(lx + sx * 1.1)), Z(lz) - M(0.03), M(1.1), M(0.06));
        g.fillRect(X(lx) - M(0.03), Math.min(Z(lz), Z(lz + sz * 0.9)), M(0.06), M(0.9));
      }
    }
    dot(f.x, f.z, 0.34, RED);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillRect(X(f.x) - M(0.34), Z(f.z) - M(0.07), M(0.68), M(0.14));
  }

  // center circle + emblem
  circle(0, 0, RINK.centerCircleR, BLUE, 0.08);
  drawEmblem(g, X(0), Z(0), M(3.6), { alpha: 0.93 });

  // ice sponsor marks (faded paint)
  const iceText = (text, x, z, size, color, alpha) => {
    g.save();
    g.globalAlpha = alpha;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    fitText(g, text, M(size), M(6.2), FONT, 'italic');
    g.fillStyle = color;
    g.fillText(text, X(x), Z(z));
    g.restore();
  };
  iceText('COLD BREW CO.', -13.5, -9.6, 1.1, '#5a3a22', 0.42);
  iceText('PUCK & PIE', 13.5, -9.6, 1.2, '#b0182a', 0.42);
  iceText('TAILNET ARENA', -13.5, 9.6, 1.0, '#13335e', 0.38);
  iceText('GLACIER GUM', 13.5, 9.6, 1.1, '#0b7a7a', 0.38);
  iceText('ICE RIOT', -RINK.goalLineX - 1.7, 0, 0.7, '#1a2d55', 0.0); // reserved

  // thin frost veil over the paint
  g.fillStyle = 'rgba(240,246,252,0.10)';
  g.fillRect(0, 0, W, H);

  g.restore();
  const t = canvasTex(c, { aniso });
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// --------------------------------------------------------------------------------------------
// The game's fictional sponsors. `key` picks the animated LED ad in ads.js; the wordmark keeps the
// brand's own lettering, the tagline is plain sentence-case copy.
export const SPONSORS = [
  { key: 'iceriot', text: 'ICE RIOT', bg: '#d0142c', fg: '#ffffff', accent: '#ffd23f', font: FONT, italic: true, tagline: 'Three on three, all glass' },
  { key: 'coldbrew', text: 'COLD BREW CO.', bg: '#3b2414', fg: '#f3dfc1', accent: '#ffb547', font: FONT, tagline: 'Brewed cold, served colder' },
  { key: 'puckpie', text: 'PUCK & PIE', bg: '#ffd23f', fg: '#a3122a', accent: '#ff6a13', font: FONT, italic: true, tagline: 'Hot slices between periods' },
  { key: 'tailnet', text: 'TAILNET ARENA', bg: '#0f2a57', fg: '#ffffff', accent: '#7fd3ff', font: FONT, tagline: 'Every seat on the network' },
  { key: 'glacier', text: 'GLACIER GUM', bg: '#0b8f8f', fg: '#e9fffb', accent: '#bff6ff', font: FONT, italic: true, tagline: 'Fresh breath, frozen solid' },
  { key: 'slapshot', text: 'SLAPSHOT SODA', bg: '#ffffff', fg: '#e0262f', accent: '#e0262f', font: FONT, italic: true, border: '#e0262f', tagline: 'Crack one open' },
  { key: 'zerok', text: 'ZERO KELVIN COLA', bg: '#0a0a0f', fg: '#5ee7ff', accent: '#ffffff', font: FONT, tagline: 'The coldest cola, physically' },
  { key: 'hattrick', text: 'HAT TRICK HOT SAUCE', bg: '#121212', fg: '#ff7a1a', accent: '#ffd23f', font: FONT, italic: true, tagline: 'Three peppers, no mercy' },
];

/**
 * Digital dasher boards: a band of LED screens along the boards (heights in m, `perPeriod` screens per
 * board-texture period, `gap` m of dark bezel between neighbouring screens). rink.js draws the animated
 * content into this band with a shader (ads.js); the board texture only carries the dark housings.
 */
export const BOARD_LED = { y0: 0.27, y1: 0.92, perPeriod: 8, gap: 0.05 };

/** Board texture: one period of `periodM` meters (repeats around the rink). */
export function makeBoardTexture(periodM, aniso) {
  const W = 4096, H = 160;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const bh = RINK.boardHeight;
  const Y = (y) => H * (1 - y / bh); // board height (m) -> canvas y
  const PX = W / periodM;
  g.fillStyle = '#f7f7f4'; g.fillRect(0, 0, W, H);
  // kick plate
  g.fillStyle = '#f2c200'; g.fillRect(0, Y(0.2), W, H - Y(0.2));
  g.fillStyle = '#c99a00'; g.fillRect(0, Y(0.2), W, 3);
  // scuff marks on the kick plate and lower board
  const rand = rng(99);
  for (let i = 0; i < 500; i++) {
    g.fillStyle = `rgba(40,40,40,${0.04 + rand() * 0.1})`;
    const x = rand() * W, y = Y(rand() * 0.45);
    g.fillRect(x, y, 2 + rand() * 16, 1 + rand() * 3);
  }
  // LED screen housings: one continuous dark band with a slim frame, a seam between screens
  const L = BOARD_LED;
  const y0 = Y(L.y1), y1 = Y(L.y0), fr = Math.max(2, PX * 0.025);
  g.fillStyle = '#2b313c'; g.fillRect(0, y0 - fr, W, y1 - y0 + fr * 2);
  g.fillStyle = '#05070b'; g.fillRect(0, y0, W, y1 - y0);
  const slot = W / L.perPeriod;
  g.fillStyle = '#1a1f28';
  for (let i = 0; i <= L.perPeriod; i++) g.fillRect(i * slot - PX * L.gap / 2, y0, PX * L.gap, y1 - y0);
  return canvasTex(c, { repeat: true, aniso });
}

export function makeNetTexture() {
  const S = 64;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(0, S / 2); g.lineTo(S, S / 2);
  g.moveTo(S / 2, 0); g.lineTo(S / 2, S);
  g.stroke();
  const t = canvasTex(c, { repeat: true });
  return t;
}

export function makeGlassTexture() {
  const W = 256, H = 128;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const lg = g.createLinearGradient(0, 0, 0, H);
  lg.addColorStop(0, 'rgba(225,245,255,0.55)');
  lg.addColorStop(1, 'rgba(200,230,250,0.35)');
  g.fillStyle = lg; g.fillRect(0, 0, W, H);
  // streak highlights
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.beginPath(); g.moveTo(40, 0); g.lineTo(70, 0); g.lineTo(20, H); g.lineTo(-10, H); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.3)';
  g.beginPath(); g.moveTo(90, 0); g.lineTo(100, 0); g.lineTo(50, H); g.lineTo(40, H); g.fill();
  // edges
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = 6; g.strokeRect(3, 3, W - 6, H - 6);
  return canvasTex(c);
}

/** Soft radial dot used for glows, shadows, sprites. */
export function makeRadialTexture(stops = [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']], size = 128) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) rg.addColorStop(o, col);
  g.fillStyle = rg; g.fillRect(0, 0, size, size);
  return canvasTex(c);
}

/** Ring marker texture: bright ring with a dark outline (tinted by material color). */
export function makeRingTexture(local = false) {
  const S = 256;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const r = S / 2;
  g.translate(r, r);
  const ring = (r0, r1, style) => {
    g.beginPath(); g.arc(0, 0, r1, 0, Math.PI * 2); g.arc(0, 0, r0, 0, Math.PI * 2, true);
    g.fillStyle = style; g.fill();
  };
  ring(r * 0.62, r * 0.98, 'rgba(0,0,0,0.45)');
  ring(r * 0.68, r * 0.9, 'rgba(255,255,255,1)');
  if (local) {
    // four chevrons pointing inward
    for (let i = 0; i < 4; i++) {
      g.save();
      g.rotate(i * Math.PI / 2 + Math.PI / 4);
      g.beginPath();
      g.moveTo(r * 0.5, 0); g.lineTo(r * 0.66, -r * 0.1); g.lineTo(r * 0.66, r * 0.1); g.closePath();
      g.fillStyle = 'rgba(255,255,255,1)'; g.fill();
      g.restore();
    }
  }
  return canvasTex(c);
}

/** Jersey number atlas: 4x2 cells (cell = player id), drawn on the team primary color. */
export function drawNumberAtlas(canvas, teamIdx, numbers) {
  const g = canvas.getContext('2d');
  const cw = canvas.width / 4, ch = canvas.height / 2;
  for (let id = 0; id < 8; id++) {
    const team = TEAMS[teamIdx[id < 4 ? 0 : 1]] || TEAMS[0];
    const col = id % 4, row = (id / 4) | 0;
    const x = col * cw, y = row * ch;
    g.fillStyle = css(team.colors.primary);
    g.fillRect(x, y, cw, ch);
    const num = String(numbers[id] ?? '');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `${ch * 0.74}px ${FONT}`;
    if (g.measureText(num).width > cw * 0.9) g.font = `${ch * 0.6}px ${FONT}`;
    g.lineJoin = 'round';
    g.lineWidth = ch * 0.1;
    g.strokeStyle = css(team.colors.secondary);
    g.strokeText(num, x + cw / 2, y + ch * 0.54);
    const acc = team.colors.accent;
    g.fillStyle = css(acc === team.colors.primary ? 0xffffff : acc);
    g.fillText(num, x + cw / 2, y + ch * 0.54);
  }
}

/** UI face for in-arena screens (system font only: Bahnschrift ships with Windows). */
export const UI_FONT = 'Bahnschrift, "DIN Alternate", "Segoe UI", Arial, sans-serif';
/** 1 -> '1st' ... 4+ -> 'OT' */
export const periodLabel = (per) => (per > 3 ? 'OT' : ['', '1st', '2nd', '3rd'][per] || '');

/** Jumbotron screen (static content: score, final, attract). The LED dot look is added by the screen shader. */
export function drawJumbotron(canvas, teams, sc, per, mode) {
  drawJumboScreen(canvas.getContext('2d'), canvas.width, canvas.height, teams, sc, per, mode);
}

/** Same as drawJumbotron, into any 2D context / size (used for animated transitions). */
export function drawJumboScreen(g, W, H, teams, sc, per, mode) {
  g.fillStyle = '#050810'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0a1122'; g.fillRect(0, H * 0.16, W, H * 0.5);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  // header bar
  g.fillStyle = '#d0142c'; g.fillRect(0, 0, W, H * 0.16);
  g.fillStyle = '#ffffff';
  g.font = `italic bold ${Math.round(H * 0.095)}px ${UI_FONT}`;
  g.fillText('Tailnet Arena', W / 2, H * 0.085);
  const h = TEAMS[teams[0]] || TEAMS[0], a = TEAMS[teams[1]] || TEAMS[1];
  if (mode === 'attract') {
    drawEmblem(g, W / 2, H * 0.55, H * 0.3);
    g.fillStyle = '#9fe6ff';
    g.font = `600 ${Math.round(H * 0.07)}px ${UI_FONT}`;
    g.fillText('Warming up the ice', W / 2, H * 0.92);
    return;
  }
  const panel = (team, x, w) => {
    g.fillStyle = css(team.colors.primary);
    g.fillRect(x, H * 0.22, w, H * 0.2);
    g.fillStyle = css(team.colors.secondary);
    g.fillRect(x, H * 0.42, w, H * 0.08);
    g.fillStyle = '#ffffff';
    fitText(g, team.key, H * 0.16, w * 0.9, UI_FONT, 'italic bold');
    g.lineWidth = 6; g.lineJoin = 'round'; g.strokeStyle = css(team.colors.secondary);
    g.strokeText(team.key, x + w / 2, H * 0.325);
    g.fillText(team.key, x + w / 2, H * 0.325);
    g.font = `600 ${Math.round(H * 0.052)}px ${UI_FONT}`;
    g.fillText(`${team.city} ${team.name}`, x + w / 2, H * 0.462);
  };
  panel(h, W * 0.04, W * 0.36);
  panel(a, W * 0.60, W * 0.36);
  g.fillStyle = '#ffffff';
  g.font = `italic bold ${Math.round(H * 0.36)}px ${UI_FONT}`;
  g.fillText(String(sc[0] ?? 0), W * 0.22, H * 0.75);
  g.fillText(String(sc[1] ?? 0), W * 0.78, H * 0.75);
  g.fillStyle = '#ffd23f';
  g.font = `bold ${Math.round(H * 0.09)}px ${UI_FONT}`;
  g.fillText(periodLabel(per), W / 2, H * 0.62);
  if (mode === 'goal') {
    g.fillStyle = '#ff4b3e';
    g.font = `italic bold ${Math.round(H * 0.16)}px ${UI_FONT}`;
    g.fillText('Goal', W / 2, H * 0.82);
  } else if (mode === 'final') {
    g.fillStyle = '#9fe6ff';
    g.font = `bold ${Math.round(H * 0.1)}px ${UI_FONT}`;
    g.fillText('Final', W / 2, H * 0.82);
  } else {
    g.fillStyle = '#5a6480';
    g.font = `bold ${Math.round(H * 0.12)}px ${UI_FONT}`;
    g.fillText('–', W / 2, H * 0.78);
  }
}

/** Luxury-suite window band. */
export function makeSuiteTexture() {
  const W = 1024, H = 64;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#07090f'; g.fillRect(0, 0, W, H);
  const rand = rng(7);
  for (let x = 0; x < W; x += 32) {
    const lit = rand();
    g.fillStyle = lit > 0.25 ? `rgba(255,${200 + rand() * 40 | 0},${140 + rand() * 60 | 0},${0.5 + lit * 0.5})` : 'rgba(40,50,70,0.8)';
    g.fillRect(x + 3, 14, 26, 34);
  }
  return canvasTex(c, { repeat: true });
}
