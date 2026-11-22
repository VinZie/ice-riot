// ICE RIOT renderer - the arena's "digital" LED ad network (fictional sponsors only).
//
// One small canvas atlas (4 channels of 384x64 side by side) is redrawn at <= 15 fps and shared by the
// dasher-board LED band (rink.js) and the fascia ribbon (arena.js). Every channel runs its own playlist
// of animated ads and changes slot with a wipe, slide or drop. A goal takes every channel over in the
// scoring team's colours, all in sync. The jumbotron gets its own canvas: score during play, animated
// ad breaks during stoppages (with a score strip), a goal screen in the scorer's colours. The ring under
// the jumbotron is a smooth-crawling ticker. The LED pixel grid and a faint refresh band are added by the
// surface shaders (patch*), so the canvases stay small and flat and nothing strobes when calm.
//
//   const ads = getAdNetwork(scene, { track, aniso });   // one network per scene (rink + arena share it)
//   ads.patchBoards(mat, { periodM })   // MeshStandardMaterial of the inner boards (emissive LED band)
//   ads.patchRibbon(mat)                // MeshBasicMaterial with map = ads.atlas, uv.x in tile units
//   ads.patchScreen(mat, ledsX, ledsY)  // LED grid over any MeshBasicMaterial map (jumbotron, ring)
//   ads.setTeams(h, a); ads.setJumbo(teams, sc, per, mode); ads.takeover(team)
//   ads.update(dt, time, { stoppage, stoppageLabel, goalTeam, calm })
import * as THREE from 'three';
import { TEAMS } from '/shared/constants.js';
import {
  makeCanvas, canvasTex, css, FONT, UI_FONT, SPONSORS, BOARD_LED, drawEmblem, drawJumboScreen, periodLabel,
} from './textures.js';

const TAU = Math.PI * 2;
export const ADS = { TW: 384, TH: 64, CH: 4, FPS: 15, FPS_LOW: 8, SLOT: 8, TRANS: 0.42, TAKE: 4.6 };
const JW = 1024, JH = 512;           // jumbotron canvas
const TICK_W = 2048, TICK_H = 48;    // jumbotron ring ticker
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x) => 1 - (1 - x) * (1 - x) * (1 - x);
const lum = (hex) => (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255;

/** The network for this scene (created on first use, so rink.js and arena.js can ask in any order). */
export function getAdNetwork(scene, opts) {
  if (!scene.userData.iceRiotAds) scene.userData.iceRiotAds = createAdNetwork(opts);
  return scene.userData.iceRiotAds;
}

// ------------------------------------------------------------------------------------------------
// Sponsor art. icon(g, cx, cy, s, t, sp): s = box size in px, t = seconds since the ad started.
const zkFonts = new Map();
const ICONS = {
  iceriot(g, cx, cy, s, t) {
    drawEmblem(g, cx, cy, s * 0.47 * (1 + 0.05 * Math.sin(t * 4.2)));
  },
  coldbrew(g, cx, cy, s, t, sp) {
    const u = s / 100;
    g.save(); g.translate(cx, cy + 6 * u);
    // steam: three wisps drifting up
    g.strokeStyle = sp.fg; g.lineWidth = 5 * u; g.lineCap = 'round'; g.lineJoin = 'round';
    for (let k = 0; k < 3; k++) {
      g.globalAlpha = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.6 + k * 2.1));
      g.beginPath();
      for (let i = 0; i <= 7; i++) {
        const yy = -16 * u - i * 5 * u, xx = (k - 1) * 14 * u + Math.sin(i * 0.9 - t * 5 + k * 2.1) * 4.5 * u;
        if (i) g.lineTo(xx, yy); else g.moveTo(xx, yy);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    // cup + handle + saucer
    g.fillStyle = sp.fg;
    g.beginPath(); g.moveTo(-26 * u, -10 * u); g.lineTo(26 * u, -10 * u); g.lineTo(19 * u, 30 * u); g.lineTo(-19 * u, 30 * u); g.closePath(); g.fill();
    g.lineWidth = 6 * u; g.strokeStyle = sp.fg;
    g.beginPath(); g.arc(26 * u, 6 * u, 10 * u, -1.25, 1.25); g.stroke();
    g.fillRect(-34 * u, 32 * u, 68 * u, 5 * u);
    g.fillStyle = sp.accent; g.fillRect(-23 * u, 4 * u, 46 * u, 8 * u);
    g.fillStyle = '#1c0f07'; g.beginPath(); g.ellipse(0, -10 * u, 24 * u, 4.5 * u, 0, 0, TAU); g.fill();
    g.restore();
  },
  puckpie(g, cx, cy, s, t) {
    const u = s / 100;
    g.save(); g.translate(cx, cy - 4 * u); g.rotate(Math.sin(t * 2.4) * 0.13);
    // cheese drip from the tip (grows, falls, repeats)
    const d = (t * 0.8) % 1;
    g.fillStyle = '#fff1b8';
    g.beginPath(); g.ellipse(0, 40 * u + d * 16 * u, 3.4 * u, (3 + d * 5) * u, 0, 0, TAU); g.fill();
    // slice
    g.beginPath(); g.moveTo(-32 * u, -26 * u); g.quadraticCurveTo(0, -40 * u, 32 * u, -26 * u); g.lineTo(0, 42 * u); g.closePath();
    g.fillStyle = '#fff1b8'; g.fill();
    g.lineWidth = 3 * u; g.strokeStyle = '#7a0d1e'; g.stroke();
    // crust
    g.lineWidth = 9 * u; g.lineCap = 'round'; g.strokeStyle = '#b8621b';
    g.beginPath(); g.moveTo(-31 * u, -28 * u); g.quadraticCurveTo(0, -43 * u, 31 * u, -28 * u); g.stroke();
    // pepperoni
    g.fillStyle = '#c8102e';
    g.beginPath(); g.arc(-11 * u, -14 * u, 6 * u, 0, TAU); g.arc(10 * u, -9 * u, 6 * u, 0, TAU); g.fill();
    g.beginPath(); g.arc(-1 * u, 11 * u, 5 * u, 0, TAU); g.fill();
    g.restore();
  },
  tailnet(g, cx, cy, s, t, sp) {
    const u = s / 100, R = 36 * u, rot = t * 0.25;
    g.save(); g.translate(cx, cy);
    g.strokeStyle = sp.accent; g.lineWidth = 3 * u; g.globalAlpha = 0.55;
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = rot + i * TAU / 6, b = rot + (i + 1) * TAU / 6;
      g.moveTo(0, 0); g.lineTo(Math.cos(a) * R, Math.sin(a) * R);
      g.moveTo(Math.cos(a) * R, Math.sin(a) * R); g.lineTo(Math.cos(b) * R, Math.sin(b) * R);
    }
    g.stroke();
    g.globalAlpha = 1;
    // packets running along the spokes
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 6; i++) {
      const a = rot + i * TAU / 6, p = (t * 0.9 + i * 0.37) % 1, q = i % 2 ? p : 1 - p;
      g.beginPath(); g.arc(Math.cos(a) * R * q, Math.sin(a) * R * q, 4 * u, 0, TAU); g.fill();
    }
    for (let i = 0; i < 6; i++) {
      const a = rot + i * TAU / 6;
      g.beginPath(); g.arc(Math.cos(a) * R, Math.sin(a) * R, 6.5 * u, 0, TAU); g.fill();
    }
    const f = (t * 1.1) % 1;
    g.globalAlpha = 1 - f; g.strokeStyle = sp.accent; g.lineWidth = 3 * u;
    g.beginPath(); g.arc(0, 0, (10 + f * 22) * u, 0, TAU); g.stroke();
    g.globalAlpha = 1; g.fillStyle = sp.accent;
    g.beginPath(); g.arc(0, 0, 10 * u, 0, TAU); g.fill();
    g.restore();
  },
  glacier(g, cx, cy, s, t, sp) {
    const u = s / 100;
    g.save(); g.translate(cx, cy);
    // twinkles (do not spin)
    g.fillStyle = sp.accent;
    for (let i = 0; i < 3; i++) {
      const k = Math.max(0, Math.sin(t * 3.3 + i * 2.2)), x = [-38, 36, 30][i] * u, y = [-30, -34, 34][i] * u, r = 7 * u * k;
      g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r * 0.3, y); g.lineTo(x, y + r); g.lineTo(x - r * 0.3, y); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(x - r, y); g.lineTo(x, y + r * 0.3); g.lineTo(x + r, y); g.lineTo(x, y - r * 0.3); g.closePath(); g.fill();
    }
    g.rotate(t * 1.3);
    g.strokeStyle = sp.fg; g.lineWidth = 5 * u; g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = i * TAU / 6, c = Math.cos(a), sn = Math.sin(a);
      const P = (x, y) => [x * c - y * sn, x * sn + y * c];
      let p = P(0, 0); g.moveTo(p[0], p[1]); p = P(0, -38 * u); g.lineTo(p[0], p[1]);
      for (const [y0, l] of [[-20, 11], [-30, 7]]) {
        p = P(0, y0 * u); g.moveTo(p[0], p[1]); p = P(-l * u, (y0 - l) * u); g.lineTo(p[0], p[1]);
        p = P(0, y0 * u); g.moveTo(p[0], p[1]); p = P(l * u, (y0 - l) * u); g.lineTo(p[0], p[1]);
      }
    }
    g.stroke();
    g.restore();
  },
  slapshot(g, cx, cy, s, t, sp) {
    const u = s / 100;
    g.save(); g.translate(cx, cy + 4 * u);
    // bubbles fizzing out of the can
    g.strokeStyle = sp.fg; g.lineWidth = 2.5 * u;
    for (let i = 0; i < 7; i++) {
      const p = (t * 0.85 + i * 0.143) % 1;
      const x = (-9 + (i % 4) * 6) * u + Math.sin(t * 3 + i * 1.7) * 3 * u, y = -38 * u - p * 14 * u;
      g.globalAlpha = 1 - p;
      g.beginPath(); g.arc(x, y, (1.6 + p * 3) * u, 0, TAU); g.stroke();
    }
    g.globalAlpha = 1;
    g.rotate(Math.sin(t * 10) * 0.025);
    // can
    g.fillStyle = sp.fg;
    g.beginPath(); g.roundRect(-20 * u, -34 * u, 40 * u, 72 * u, 7 * u); g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(-20 * u, 2 * u);
    for (let i = 0; i <= 8; i++) g.lineTo((-20 + i * 5) * u, (2 + Math.sin(i * 0.9 + t * 3) * 3) * u);
    g.lineTo(20 * u, 12 * u);
    for (let i = 8; i >= 0; i--) g.lineTo((-20 + i * 5) * u, (12 + Math.sin(i * 0.9 + t * 3) * 3) * u);
    g.closePath(); g.fill();
    g.fillStyle = '#c9d2de'; g.beginPath(); g.ellipse(0, -34 * u, 18 * u, 4.5 * u, 0, 0, TAU); g.fill();
    g.restore();
  },
  zerok(g, cx, cy, s, t, sp) {
    const u = s / 100;
    g.save(); g.translate(cx, cy);
    for (let k = 0; k < 2; k++) {
      const f = (t * 0.8 + k * 0.5) % 1;
      g.globalAlpha = (1 - f) * 0.9; g.strokeStyle = sp.fg; g.lineWidth = 3 * u;
      g.beginPath(); g.arc(0, 0, (28 + f * 22) * u, 0, TAU); g.stroke();
    }
    g.globalAlpha = 1;
    const r = 30 * u * (1 + 0.06 * Math.sin(t * 5));
    g.fillStyle = '#0e2a35'; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
    g.lineWidth = 4 * u; g.strokeStyle = sp.fg; g.stroke();
    const px = Math.round(26 * u);
    let f = zkFonts.get(px);
    if (!f) { f = `italic bold ${px}px ${UI_FONT}`; zkFonts.set(px, f); }
    g.font = f; g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('0K', 0, 1.5 * u);
    g.restore();
  },
  hattrick(g, cx, cy, s, t, sp) {
    const u = s / 100;
    g.save(); g.translate(cx, cy + 6 * u);
    // three flames (a hat trick) flickering over the cap
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * 13 * u, k = 0.75 + 0.35 * Math.abs(Math.sin(t * 11 + i * 2.3)), h = 22 * u * k;
      g.fillStyle = '#ff4a1a';
      g.beginPath(); g.moveTo(x - 7 * u, -36 * u); g.quadraticCurveTo(x - 7 * u, -36 * u - h * 0.6, x, -36 * u - h); g.quadraticCurveTo(x + 7 * u, -36 * u - h * 0.6, x + 7 * u, -36 * u); g.closePath(); g.fill();
      g.fillStyle = sp.accent;
      g.beginPath(); g.moveTo(x - 3.5 * u, -36 * u); g.quadraticCurveTo(x - 3.5 * u, -36 * u - h * 0.4, x, -36 * u - h * 0.6); g.quadraticCurveTo(x + 3.5 * u, -36 * u - h * 0.4, x + 3.5 * u, -36 * u); g.closePath(); g.fill();
    }
    // bottle
    g.fillStyle = sp.fg;
    g.beginPath(); g.roundRect(-15 * u, -8 * u, 30 * u, 48 * u, 7 * u); g.fill();
    g.fillRect(-6 * u, -26 * u, 12 * u, 20 * u);
    g.fillStyle = sp.accent; g.fillRect(-8 * u, -34 * u, 16 * u, 9 * u);
    g.fillStyle = '#121212'; g.fillRect(-11 * u, 8 * u, 22 * u, 16 * u);
    g.fillStyle = sp.accent; g.beginPath(); g.arc(0, 16 * u, 5 * u, 0, TAU); g.fill();
    g.restore();
  },
};

// ------------------------------------------------------------------------------------------------
export function createAdNetwork({ track = (t) => t, aniso = 1 } = {}) {
  const { TW, TH, CH } = ADS;
  const measure = makeCanvas(8, 8).getContext('2d');
  const fitSize = (text, style, family, size, maxW) => {
    let s = size;
    measure.font = `${style} ${s}px ${family}`;
    while (s > 8 && measure.measureText(text).width > maxW) { s -= 1; measure.font = `${style} ${s}px ${family}`; }
    return s;
  };

  // precomputed fonts / sizes (nothing is measured while animating)
  const tileTextX = TH * 1.12, tileTextW = TW - tileTextX - TH * 0.2;
  const bigTextX = JW * 0.42, bigTextW = JW * 0.54;
  const SP = SPONSORS.map((sp) => {
    const style = sp.italic ? 'italic' : '';
    const wTile = fitSize(sp.text, style, sp.font, Math.round(TH * 0.6), tileTextW);
    const tTile = fitSize(sp.tagline, 'bold', UI_FONT, Math.round(TH * 0.46), tileTextW);
    const wBig = fitSize(sp.text, style, sp.font, 92, bigTextW);
    const tBig = fitSize(sp.tagline, '600', UI_FONT, 46, bigTextW);
    return {
      ...sp, icon: ICONS[sp.key] || ICONS.iceriot,
      fWordTile: `${style} ${wTile}px ${sp.font}`, fTagTile: `bold ${tTile}px ${UI_FONT}`,
      fWordBig: `${style} ${wBig}px ${sp.font}`, fTagBig: `600 ${tBig}px ${UI_FONT}`,
    };
  });
  const F = {
    tickTile: `bold ${Math.round(TH * 0.46)}px ${UI_FONT}`, tickBadge: `italic bold ${Math.round(TH * 0.4)}px ${UI_FONT}`,
    takeTile: `italic bold ${Math.round(TH * 0.72)}px ${UI_FONT}`, takeKey: `italic bold ${Math.round(TH * 0.34)}px ${UI_FONT}`,
    jGoal: `italic bold ${Math.round(JH * 0.36)}px ${UI_FONT}`, jLine: `italic bold ${Math.round(JH * 0.1)}px ${UI_FONT}`,
    jStrip: `italic bold ${Math.round(JH * 0.085)}px ${UI_FONT}`, jStripLbl: `600 ${Math.round(JH * 0.06)}px ${UI_FONT}`,
    ring: `italic bold ${Math.round(TICK_H * 0.62)}px ${UI_FONT}`,
  };

  // ---------------------------------------------------------------- canvases + textures
  const atlasCanvas = makeCanvas(TW * CH, TH);
  const ag = atlasCanvas.getContext('2d');
  // dynamic canvases are uploaded as plain RGBA8 (an sRGB texture upload takes a slow path: ~6 ms for the
  // jumbotron vs ~0.2 ms) and decoded to linear in the LED shaders (ledDecode)
  const atlas = track(canvasTex(atlasCanvas, { aniso, srgb: false }));
  const jCanvas = makeCanvas(JW, JH);
  const jg = jCanvas.getContext('2d');
  const jumboTex = track(canvasTex(jCanvas, { aniso, srgb: false }));
  const tickCanvas = makeCanvas(TICK_W, TICK_H);
  const tickTex = track(canvasTex(tickCanvas, { repeat: true, srgb: false }));
  const uniforms = { uLedTime: { value: 0 }, uLedCalm: { value: 0 } };

  // ---------------------------------------------------------------- state
  const st = {
    teams: [0, 1], sc: [0, 0], per: 1, mode: 'attract', calm: false, fps: ADS.FPS, time: 0,
    take: { on: false, t0: -99, end: -99, until: -99, team: 0, final: false },
    lastAtlas: -99, tickerW: 1, tickerStr: '', tickerDirty: true,
    crest: [null, null], crestFor: [-1, -1], scoreStr: '0  –  0', teamName: ['', ''],
  };
  const teamOf = (slot) => TEAMS[st.teams[slot === 1 ? 1 : 0]] || TEAMS[0];
  const teamCss = new Map();
  const tcss = (hex) => { let s = teamCss.get(hex); if (!s) { s = css(hex); teamCss.set(hex, s); } return s; };

  // team crests for the jumbotron goal screen (optional: logos.js is another module, loaded lazily)
  let logos = null;
  import('../logos.js').then((m) => { logos = m; loadCrests(); }).catch(() => {});
  function loadCrests() {
    if (!logos || typeof logos.svgToCanvas !== 'function') return;
    for (let s = 0; s < 2; s++) {
      const ti = st.teams[s];
      if (st.crestFor[s] === ti) continue;
      st.crestFor[s] = ti; st.crest[s] = null;
      try {
        logos.svgToCanvas(logos.teamLogoSVG(ti, { size: 256 }), 256, 256)
          .then((c) => { if (st.crestFor[s] === ti) { st.crest[s] = c; jDirty = true; } }).catch(() => {});
      } catch { /* no crest: the team key is drawn instead */ }
    }
  }

  // ---------------------------------------------------------------- ticker text (ring + ticker ads)
  function buildTicker() {
    const h = teamOf(0), a = teamOf(1);
    st.scoreStr = `${st.sc[0] ?? 0}  –  ${st.sc[1] ?? 0}`;
    st.teamName[0] = `${h.city} ${h.name}`; st.teamName[1] = `${a.city} ${a.name}`;
    st.tickerStr = `${h.city} ${h.name} vs ${a.city} ${a.name}   ·   ${h.key} ${st.sc[0] ?? 0} – ${st.sc[1] ?? 0} ${a.key}`
      + `   ·   Puck & Pie intermission combo: two slices and a Slapshot Soda   ·   Free wifi in every seat at Tailnet Arena`
      + `   ·   Hat Trick Hot Sauce wing night, every Thursday   ·   Zero Kelvin Cola, the coldest cola   ·   `;
    measure.font = F.tickTile;
    st.tickerW = Math.max(1, measure.measureText(st.tickerStr).width);
    // ring texture: the same line twice across the 2048 px strip, fit so it tiles seamlessly
    const g = tickCanvas.getContext('2d');
    g.fillStyle = '#04060b'; g.fillRect(0, 0, TICK_W, TICK_H);
    g.font = F.ring; g.textBaseline = 'middle'; g.textAlign = 'left';
    const line = `${h.key} ${st.sc[0] ?? 0} – ${st.sc[1] ?? 0} ${a.key}  ·  ${periodLabel(st.per) || 'Tonight'}  ·  Tailnet Arena  ·  Cold Brew Co.  ·  Glacier Gum  ·  Slapshot Soda  ·  `;
    const lw = Math.max(1, g.measureText(line).width);
    const reps = Math.max(1, Math.round(TICK_W / lw));
    g.save(); g.scale(TICK_W / (lw * reps), 1);
    for (let i = 0; i < reps; i++) {
      const x = i * lw;
      g.fillStyle = '#ffffff'; g.fillText(line, x, TICK_H * 0.54);
    }
    g.restore();
    g.fillStyle = '#ffd23f'; g.fillRect(0, 0, TICK_W, 2); g.fillRect(0, TICK_H - 2, TICK_W, 2);
    tickTex.needsUpdate = true;
    st.tickerDirty = false;
  }

  // ---------------------------------------------------------------- tile drawing
  function drawSponsor(g, w, h, sp, t, big) {
    g.fillStyle = sp.bg; g.fillRect(0, 0, w, h);
    if (sp.border) { g.strokeStyle = sp.border; g.lineWidth = big ? 10 : 3; g.strokeRect(big ? 12 : 2.5, big ? 12 : 2.5, w - (big ? 24 : 5), h - (big ? 24 : 5)); }
    const box = big ? h * 0.7 : h * 0.86;
    const icx = big ? w * 0.21 : h * 0.58;
    sp.icon(g, icx, h / 2, box, t, sp);
    const x0 = big ? bigTextX : tileTextX, tw = big ? bigTextW : tileTextW;
    g.textAlign = 'left'; g.textBaseline = 'middle';
    const kIn = easeOut(clamp01(t / 0.35));
    if (big) {
      g.fillStyle = sp.fg; g.font = sp.fWordBig;
      g.fillText(sp.text, x0 + (1 - kIn) * tw * 0.4, h * 0.43);
      const k2 = easeOut(clamp01((t - 0.5) / 0.4));
      g.globalAlpha = k2; g.font = sp.fTagBig; g.fillStyle = sp.border ? sp.fg : sp.accent;
      g.fillText(sp.tagline, x0, h * 0.62 + (1 - k2) * 20);
      g.globalAlpha = 1;
      return;
    }
    const kSwap = easeOut(clamp01((t - ADS.SLOT * 0.62) / 0.35));
    if (kSwap < 1) {
      g.fillStyle = sp.fg; g.font = sp.fWordTile;
      g.fillText(sp.text, x0 + (1 - kIn) * tw * 0.6, h * 0.53 - kSwap * h);
    }
    if (kSwap > 0) {
      g.fillStyle = sp.fg; g.font = sp.fTagTile;
      g.fillText(sp.tagline, x0, h * 0.53 + (1 - kSwap) * h);
    }
  }

  function drawTicker(g, w, h, c) {
    g.fillStyle = '#05070d'; g.fillRect(0, 0, w, h);
    const bw = h * 1.9;
    g.textBaseline = 'middle';
    // crawl (clipped right of the badge); runs on the arena clock so every appearance continues the line
    g.save(); g.beginPath(); g.rect(bw, 0, w - bw, h); g.clip();
    const span = st.tickerW;
    const x = Math.round(bw + 8 - ((st.time * 64 + c * span * 0.37) % span)); // channels show different parts
    g.fillStyle = '#e8edf5'; g.font = F.tickTile; g.textAlign = 'left';
    g.fillText(st.tickerStr, x, h * 0.54);
    if (x + span < w) g.fillText(st.tickerStr, x + span, h * 0.54);
    g.restore();
    g.fillStyle = '#d0142c'; g.fillRect(0, 0, bw, h);
    g.fillStyle = '#ffffff'; g.font = F.tickBadge; g.textAlign = 'center';
    g.fillText('Tonight', bw / 2, h * 0.54);
  }

  function chevrons(g, w, h, t, color, speed) {
    const step = h * 0.95, off = (t * speed) % step;
    g.fillStyle = color;
    g.beginPath();
    for (let x = -step + off; x < w + step; x += step) {
      g.moveTo(x - h * 0.28, 0); g.lineTo(x + h * 0.08, 0); g.lineTo(x + h * 0.42, h / 2);
      g.lineTo(x + h * 0.08, h); g.lineTo(x - h * 0.28, h); g.lineTo(x + h * 0.06, h / 2); g.closePath();
    }
    g.fill();
  }

  /** Goal / final takeover tile in the team's colours. t = seconds since the takeover began. */
  function drawTakeover(g, w, h, t) {
    const team = teamOf(st.take.team), c = team.colors;
    g.fillStyle = tcss(c.primary); g.fillRect(0, 0, w, h);
    g.globalAlpha = 0.32;
    chevrons(g, w, h, t, tcss(c.secondary), st.calm ? 40 : 150);
    g.globalAlpha = 1;
    const ink = lum(c.primary) > 0.5 ? '#0a0f1c' : '#ffffff';
    const k = easeOut(clamp01(t / 0.32));
    g.fillStyle = ink; g.textBaseline = 'middle';
    g.textAlign = 'center'; g.font = F.takeTile;
    g.fillText(st.take.final ? 'Final' : 'Goal', w / 2 + (1 - k) * w * 0.7, h * 0.53);
    g.font = F.takeKey;
    g.textAlign = 'left'; g.fillText(team.key, h * 0.3, h * 0.53);
    g.textAlign = 'right'; g.fillText(team.key, w - h * 0.3, h * 0.53);
    if (!st.calm) { // gentle breathing glow, ~1.2 Hz, never a full on/off strobe
      g.globalAlpha = 0.1 * (0.5 + 0.5 * Math.sin(t * TAU * 1.2));
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
      g.globalAlpha = 1;
    }
  }

  // playlist: 8 sponsors with a ticker after every fourth; channels start at different entries
  const PLAY = [0, 1, 2, 3, -1, 4, 5, 6, 7, -1];
  const chOff = [0, 2.1, 4.3, 6.2];   // seconds: transitions do not all land on the same frame
  const chStart = [0, 3, 6, 8];       // playlist entries
  function drawItem(g, w, h, item, t, c) {
    if (item === -1) drawTicker(g, w, h, c);
    else if (item === -2) drawTakeover(g, w, h, t);
    else drawSponsor(g, w, h, SP[item], t, false);
  }

  function drawChannel(c, time) {
    const g = ag, w = TW, h = TH;
    g.save();
    g.translate(c * TW, 0);
    g.beginPath(); g.rect(0, 0, w, h); g.clip();
    const T = time + chOff[c];
    const slot = Math.floor(T / ADS.SLOT), ph = T - slot * ADS.SLOT;
    const cur = PLAY[(slot + chStart[c]) % PLAY.length], prev = PLAY[(slot - 1 + chStart[c] + PLAY.length * 4) % PLAY.length];
    const tk = st.take;
    let a = cur, ta = ph, b = -9, tb = 0, p = 1, kind = (slot + c) % 3;
    if (tk.on || time - tk.end < ADS.TRANS) {
      // synced takeover: every channel wipes at once
      if (tk.on) {
        const tt = time - tk.t0;
        if (tt < ADS.TRANS) { a = -2; ta = tt; b = cur; tb = ph; p = tt / ADS.TRANS; kind = 0; } else { a = -2; ta = tt; }
      } else {
        const tt = time - tk.end;
        a = cur; ta = ph; b = -2; tb = tk.end - tk.t0 + tt; p = tt / ADS.TRANS; kind = 0;
      }
    } else if (ph < ADS.TRANS) {
      b = prev; tb = ph + ADS.SLOT; p = ph / ADS.TRANS;
    }
    if (b === -9 || p >= 1) {
      drawItem(g, w, h, a, ta, c);
    } else {
      const e = easeOut(p);
      if (kind === 0) { // wipe: new content revealed left to right behind a bright edge
        drawItem(g, w, h, b, tb, c);
        const x = e * w;
        g.save(); g.beginPath(); g.rect(0, 0, x, h); g.clip(); drawItem(g, w, h, a, ta, c); g.restore();
        g.fillStyle = '#ffffff'; g.fillRect(x - 3, 0, 3, h);
      } else if (kind === 1) { // slide: push left
        g.save(); g.translate(-e * w, 0); drawItem(g, w, h, b, tb, c); g.restore();
        g.save(); g.translate((1 - e) * w, 0); g.beginPath(); g.rect(0, 0, w, h); g.clip(); drawItem(g, w, h, a, ta, c); g.restore();
      } else { // drop: new content falls in from the top
        g.save(); g.translate(0, e * h); drawItem(g, w, h, b, tb, c); g.restore();
        g.save(); g.translate(0, (e - 1) * h); g.beginPath(); g.rect(0, 0, w, h); g.clip(); drawItem(g, w, h, a, ta, c); g.restore();
      }
    }
    g.restore();
  }

  // ---------------------------------------------------------------- jumbotron director
  let jDirty = true, jShow = 'attract', jPrev = 'attract', jT0 = -99, jTrans = -99, jLast = -99, jAd = 0, jLbl = '', jWasTrans = false;
  const jState = (stoppage, label) => {
    if (st.take.on && !st.take.final) return 'goal';
    if (st.mode === 'goal') return 'goal';
    if (st.mode === 'final') return 'final';
    if (st.mode === 'attract') return (st.time % 22) < 12 ? 'attract' : 'ad';
    if (stoppage) { jLbl = label || 'Stoppage'; return 'ad'; }
    return 'score';
  };
  function drawJumboContent(g, kind, t) {
    if (kind === 'goal') drawJumboGoal(g, t);
    else if (kind === 'ad') drawJumboAd(g, t);
    else drawJumboScreen(g, JW, JH, st.teams, st.sc, st.per, kind === 'final' ? 'final' : kind === 'attract' ? 'attract' : 'score');
  }
  function drawJumboGoal(g, t) {
    const slot = st.take.on ? st.take.team : goalSlot;
    const team = teamOf(slot), c = team.colors;
    g.fillStyle = tcss(c.primary); g.fillRect(0, 0, JW, JH);
    g.globalAlpha = 0.25; chevrons(g, JW, JH, t, tcss(c.secondary), st.calm ? 60 : 260); g.globalAlpha = 1;
    const ink = lum(c.primary) > 0.5 ? '#0a0f1c' : '#ffffff';
    const k = easeOut(clamp01(t / 0.35));
    const crest = st.crest[slot === 1 ? 1 : 0];
    const cs = JH * 0.5, cx = JW * 0.2;
    if (crest) g.drawImage(crest, cx - cs / 2, JH * 0.42 - cs / 2, cs, cs);
    else { g.fillStyle = tcss(c.secondary); g.fillRect(cx - cs * 0.4, JH * 0.42 - cs * 0.3, cs * 0.8, cs * 0.6); g.fillStyle = '#ffffff'; g.font = F.jLine; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(team.key, cx, JH * 0.43); }
    g.fillStyle = ink; g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = F.jGoal;
    g.fillText('Goal', JW * 0.38 + (1 - k) * JW * 0.6, JH * 0.42);
    drawScoreStrip(g, st.teamName[slot === 1 ? 1 : 0]);
    if (!st.calm) { g.globalAlpha = 0.08 * (0.5 + 0.5 * Math.sin(t * TAU * 1.2)); g.fillStyle = '#ffffff'; g.fillRect(0, 0, JW, JH * 0.8); g.globalAlpha = 1; }
  }
  function drawJumboAd(g, t) {
    const sp = SP[jAd % SP.length];
    g.save(); g.beginPath(); g.rect(0, 0, JW, JH * 0.8); g.clip();
    drawSponsor(g, JW, JH * 0.8, sp, t, true);
    g.restore();
    drawScoreStrip(g, st.mode === 'attract' ? 'Warming up' : jLbl);
  }
  function drawScoreStrip(g, label) {
    const y = JH * 0.8, h = JH * 0.2, hT = teamOf(0), aT = teamOf(1);
    g.fillStyle = '#0a0f1c'; g.fillRect(0, y, JW, h);
    g.fillStyle = '#34425f'; g.fillRect(0, y, JW, 3);
    const chip = (team, x) => { g.fillStyle = tcss(team.colors.primary); g.fillRect(x, y + h * 0.18, h * 1.5, h * 0.64); g.fillStyle = lum(team.colors.primary) > 0.5 ? '#0a0f1c' : '#ffffff'; g.textAlign = 'center'; g.fillText(team.key, x + h * 0.75, y + h * 0.52); };
    g.font = F.jStrip; g.textBaseline = 'middle';
    chip(hT, JW * 0.03);
    g.fillStyle = '#e8edf5'; g.textAlign = 'center';
    g.fillText(st.scoreStr, JW * 0.03 + h * 2.55, y + h * 0.52);
    chip(aT, JW * 0.03 + h * 3.6);
    g.font = F.jStripLbl; g.fillStyle = '#a1acc0'; g.textAlign = 'right';
    g.fillText(label, JW * 0.97, y + h * 0.52);
  }

  let goalSlot = 0;
  function updateJumbo(time, stoppage, label, busy) {
    const want = jState(stoppage, label);
    if (want !== jShow) {
      jPrev = jShow; jShow = want; jTrans = time; jT0 = time;
      if (want === 'ad') jAd = (jAd + 1 + (Math.random() * 3 | 0)) % SP.length;
      jDirty = true;
    }
    const trans = time - jTrans < ADS.TRANS;
    if (!trans && jWasTrans) jDirty = true; // one clean frame after a wipe onto a static screen
    jWasTrans = trans;
    const animated = trans || jShow === 'goal' || jShow === 'ad';
    // animated redraws skip frames on which the atlas was redrawn, so the two uploads never stack
    if (!(jDirty || (animated && !busy && time - jLast >= 1 / st.fps))) return;
    jLast = time; jDirty = false;
    const t = time - jT0;
    if (trans) {
      const e = easeOut((time - jTrans) / ADS.TRANS), x = e * JW;
      drawJumboContent(jg, jPrev, t + 10);
      jg.save(); jg.beginPath(); jg.rect(0, 0, x, JH); jg.clip(); drawJumboContent(jg, jShow, t); jg.restore();
      jg.fillStyle = '#ffffff'; jg.fillRect(x - 6, 0, 6, JH);
    } else drawJumboContent(jg, jShow, t);
    jumboTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- per-frame
  function update(dt, time, o = {}) {
    st.time = time;
    uniforms.uLedTime.value = time;
    if (o.goalTeam === 0 || o.goalTeam === 1) {
      goalSlot = o.goalTeam;
      // GOAL phase without a goal event seen (late join): still take the boards over
      if (!st.take.on && time - st.take.end > 1) takeover(o.goalTeam, false);
      if (st.take.on) st.take.until = Math.max(st.take.until, time + 0.6);
    }
    if (st.take.on && time > st.take.until) { st.take.on = false; st.take.end = time; }
    if (st.tickerDirty) buildTicker();
    // ring ticker: crawl in whole-LED steps (2 texels) like a real LED strip
    tickTex.offset.x = (Math.floor(time * 70 / 2) * 2 / TICK_W) % 1;
    let busy = false;
    if (time - st.lastAtlas >= 1 / st.fps || time < st.lastAtlas) {
      st.lastAtlas = time; busy = true;
      for (let c = 0; c < CH; c++) drawChannel(c, time);
      atlas.needsUpdate = true;
    }
    updateJumbo(time, !!o.stoppage, o.stoppageLabel, busy);
  }

  function takeover(slot, final = false) {
    const tk = st.take;
    const t = st.time;
    if (!tk.on) tk.t0 = t;
    tk.on = true; tk.team = slot === 1 ? 1 : 0; tk.final = !!final || st.mode === 'final';
    tk.until = t + ADS.TAKE;
    goalSlot = tk.team;
  }

  // ---------------------------------------------------------------- shaders
  const LED_PARS = /* glsl */`
uniform float uLedTime; uniform float uLedCalm;
vec3 ledDecode(vec3 c) { return mix(c * 0.0773993808, pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), step(0.04045, c)); }
float ledGrid(vec2 cell) {
#if __VERSION__ >= 300 || defined(GL_OES_standard_derivatives)
  vec2 f = abs(fract(cell) - 0.5);
  float d = max(f.x, f.y);
  float dotm = 1.0 - smoothstep(0.3, 0.5, d);
  vec2 fw = fwidth(cell);
  float vis = clamp(1.7 - 2.4 * max(fw.x, fw.y), 0.0, 1.0); // fades out before the grid can alias
  return mix(1.0, (0.3 + 0.7 * dotm) * 1.3, vis);
#else
  return 1.0;
#endif
}
float ledBand(float y) { // faint rolling refresh band (off when calm)
  return 1.0 + 0.05 * (1.0 - uLedCalm) * smoothstep(0.9, 1.0, sin(y * 2.2 - uLedTime * 1.7));
}
`;
  const atlasFetch = /* glsl */`
vec3 ledAtlas(sampler2D tex, float chn, vec2 luv, vec2 dx, vec2 dy) {
  vec2 auv = vec2((chn + clamp(luv.x, 0.002, 0.998)) / ${CH.toFixed(1)}, clamp(luv.y, 0.01, 0.99));
#if __VERSION__ >= 300
  return textureGrad(tex, auv, dx, dy).rgb;
#else
  return texture2D(tex, auv).rgb;
#endif
}
`;

  /** Inner dasher boards: dark LED band with animated content (emissive, so it also glows in the ice reflection). */
  function patchBoards(mat, { periodM }) {
    const bh = 1.07;
    const L = BOARD_LED, slotM = periodM / L.perPeriod;
    const gapF = (L.gap / slotM).toFixed(5), y0 = (L.y0 / bh).toFixed(5), y1 = (L.y1 / bh).toFixed(5);
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uLedAtlas = { value: atlas };
      sh.uniforms.uLedTime = uniforms.uLedTime; sh.uniforms.uLedCalm = uniforms.uLedCalm;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform sampler2D uLedAtlas;\n${LED_PARS}${atlasFetch}`)
        .replace('#include <map_fragment>', `#include <map_fragment>
  vec3 ledEmit = vec3(0.0);
  {
    float pu = vMapUv.x * ${L.perPeriod.toFixed(1)};
    float lx = (fract(pu) - ${gapF} * 0.5) / (1.0 - ${gapF});
    float ly = (vMapUv.y - ${y0}) / (${y1} - ${y0});
    float m = step(0.0, lx) * step(lx, 1.0) * step(0.0, ly) * step(ly, 1.0);
    if (m > 0.5) {
      float chn = mod(floor(pu), ${CH.toFixed(1)});
      vec2 dx = vec2(0.0), dy = vec2(0.0);
#if __VERSION__ >= 300
      float sx = 1.0 / ((1.0 - ${gapF}) * ${CH.toFixed(1)}), sy = 1.0 / (${y1} - ${y0});
      dx = vec2(dFdx(pu) * sx, dFdx(vMapUv.y) * sy); dy = vec2(dFdy(pu) * sx, dFdy(vMapUv.y) * sy);
#endif
      vec3 led = ledDecode(ledAtlas(uLedAtlas, chn, vec2(lx, ly), dx, dy));
      led *= ledGrid(vec2(lx * ${(TW / 2).toFixed(1)}, ly * ${(TH / 2).toFixed(1)})) * ledBand(ly);
      diffuseColor.rgb = vec3(0.012);
      ledEmit = led * 1.5;
    }
  }`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += ledEmit;');
    };
    mat.customProgramCacheKey = () => 'iceriot-led-boards';
    mat.needsUpdate = true;
  }

  /** Fascia ribbon: uv.x counts tiles (4 per atlas), shows the channels in reverse order to the boards. */
  function patchRibbon(mat) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uLedTime = uniforms.uLedTime; sh.uniforms.uLedCalm = uniforms.uLedCalm;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${LED_PARS}${atlasFetch}`)
        .replace('#include <map_fragment>', `
#ifdef USE_MAP
  {
    float pu = vMapUv.x, lx = fract(pu), ly = vMapUv.y;
    float chn = ${(CH - 1).toFixed(1)} - mod(floor(pu), ${CH.toFixed(1)});
    vec2 dx = vec2(0.0), dy = vec2(0.0);
#if __VERSION__ >= 300
    dx = vec2(dFdx(pu) / ${CH.toFixed(1)}, dFdx(ly)); dy = vec2(dFdy(pu) / ${CH.toFixed(1)}, dFdy(ly));
#endif
    vec3 led = ledDecode(ledAtlas(map, chn, vec2(lx, ly), dx, dy));
    float seam = smoothstep(0.0, 0.004, lx) * smoothstep(0.0, 0.004, 1.0 - lx);
    diffuseColor.rgb *= led * ledGrid(vec2(lx * ${(TW / 2).toFixed(1)}, ly * ${(TH / 2).toFixed(1)})) * ledBand(ly) * seam;
  }
#endif`);
    };
    mat.customProgramCacheKey = () => 'iceriot-led-ribbon';
    mat.needsUpdate = true;
  }

  /** Plain LED look over a map (ledsX x ledsY LEDs across the texture). Back faces of a double-sided
   * material (the inside of the ticker ring) stay dark instead of showing mirrored text. */
  function patchScreen(mat, ledsX, ledsY, key = 'screen') {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uLedTime = uniforms.uLedTime; sh.uniforms.uLedCalm = uniforms.uLedCalm;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${LED_PARS}`)
        .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  diffuseColor.rgb = ledDecode(diffuseColor.rgb) * ledGrid(vMapUv * vec2(${ledsX.toFixed(1)}, ${ledsY.toFixed(1)})) * ledBand(vMapUv.y);
#endif
#ifdef DOUBLE_SIDED
  if (!gl_FrontFacing) diffuseColor.rgb = vec3(0.012);
#endif`);
    };
    mat.customProgramCacheKey = () => `iceriot-led-${key}-${ledsX}x${ledsY}`;
    mat.needsUpdate = true;
  }

  return {
    atlas, jumboTex, tickerTex: tickTex, uniforms,
    patchBoards, patchRibbon, patchScreen,
    update, takeover,
    setTeams(h, a) {
      if (st.teams[0] === h && st.teams[1] === a) return;
      st.teams[0] = h; st.teams[1] = a; st.tickerDirty = true; jDirty = true; loadCrests();
    },
    setJumbo(teams, sc, per, mode) {
      const s0 = sc ? sc[0] ?? 0 : 0, s1 = sc ? sc[1] ?? 0 : 0;
      if (teams && (teams[0] !== st.teams[0] || teams[1] !== st.teams[1])) this.setTeams(teams[0], teams[1]);
      if (s0 !== st.sc[0] || s1 !== st.sc[1] || per !== st.per) { st.sc[0] = s0; st.sc[1] = s1; st.per = per; st.tickerDirty = true; jDirty = true; }
      if (mode !== st.mode) { st.mode = mode; jDirty = true; if (mode === 'final' && st.take.on) st.take.final = true; }
    },
    /** reduceFlashes: no breathing glow, slower chevrons, no refresh band. */
    setCalm(v) { st.calm = !!v; uniforms.uLedCalm.value = st.calm ? 1 : 0; jDirty = true; },
    /** 'low' redraws the LED canvases at 8 fps instead of 15. */
    setQuality(q) { st.fps = q === 'low' ? ADS.FPS_LOW : ADS.FPS; },
    get mode() { return jShow; },
  };
}
