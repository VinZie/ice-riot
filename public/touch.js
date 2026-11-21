// ICE RIOT - on-screen touch controls for phones / tablets.
//
// Self-contained: injects its own <style> (every rule is prefixed .ir-touch-*), builds its own
// DOM inside `container`, and hands back a poll() that speaks the same language as input.js:
//   { mx, mz, b }  mx/mz in [-1,1] WORLD space (screen right = +mx, screen up = -mz,
//                  screen down = +mz), b = BTN bitfield from /shared/constants.js.
//
// Left half  : floating analog stick (appears where the thumb lands, radial deadzone, knob
//              clamps to the ring, base follows the thumb if it drags far past the ring).
// Bottom-right: 4 arcade buttons in an arc. SHOOT/CHECK (big), PASS/SWITCH, DEKE/POKE, TURBO.
//              Hit-testing is forgiving (nearest button within 1.3 radii) and a held finger
//              can slide onto a neighbouring button.
// Multi-touch via Pointer Events (tracked by pointerId, setPointerCapture). While visible the
// page cannot scroll / pinch / double-tap-zoom / long-press. Everything is released on
// pointercancel, window blur, pagehide and visibilitychange.

import { BTN, clamp } from '/shared/constants.js';

// ---------------------------------------------------------------------------------------------
// Pure helpers (no DOM) - exported so they can be unit-tested in Node.

/**
 * Analog stick math. (dx, dy) = finger offset from the stick origin in screen pixels
 * (screen y grows DOWN). Returns the stick output with a radial deadzone that is rescaled so
 * output magnitude ramps smoothly 0..1 from the deadzone edge to the ring, plus the clamped
 * knob offset in pixels.
 *   x, y : output vector, |(x,y)| = mag <= 1. World mapping: mx = x, mz = y.
 *   mag  : output magnitude after deadzone (0..1)
 *   raw  : finger distance / radius, clamped to 0..1 (before deadzone)
 *   kx,ky: knob offset in px, clamped to the ring radius
 */
export function stickVector(dx, dy, radius, deadzone = 0.12) {
  const len = Math.hypot(dx, dy);
  if (!(radius > 0) || !(len > 0)) return { x: 0, y: 0, mag: 0, raw: 0, kx: 0, ky: 0 };
  const ux = dx / len, uy = dy / len;
  const raw = Math.min(len / radius, 1);
  const dz = clamp(deadzone, 0, 0.95);
  const mag = raw <= dz ? 0 : Math.min(1, (raw - dz) / (1 - dz));
  const kr = Math.min(len, radius);
  return { x: ux * mag, y: uy * mag, mag, raw, kx: ux * kr, ky: uy * kr };
}

/** True on coarse-pointer (phone / tablet) devices, or touch-capable devices without a fine
 *  primary pointer. Touchscreen laptops (fine primary pointer + touch) return false: show the
 *  controls there on the first pointerType==='touch' pointerdown instead (see integration). */
export function isTouchDevice() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const mq = (q) => { try { return !!window.matchMedia && window.matchMedia(q).matches; } catch { return false; } };
  if (mq('(pointer: coarse)')) return true;
  const touchPoints = navigator.maxTouchPoints || navigator.msMaxTouchPoints || 0;
  const hasTouch = touchPoints > 0 || 'ontouchstart' in window;
  return hasTouch && !mq('(pointer: fine)');
}

// ---------------------------------------------------------------------------------------------

const DEFAULTS = {
  autoTurbo: false,       // TURBO also on while the stick is pushed past turboThreshold
  turboThreshold: 0.95,   // output magnitude (after deadzone) that triggers auto-turbo
  deadzone: 0.12,         // radial deadzone, fraction of the ring radius
  haptics: true,          // navigator.vibrate(8) on button press where supported
  mouse: false,           // also accept mouse pointers (desktop testing)
  visible: false,         // initial visibility
  hasPuck: false,         // initial button context
  followStick: true,      // stick base trails the thumb when it drags past FOLLOW_AT radii
  minPressMs: 60,         // a tap is reported for at least this long (never lost between frames)
  stickZone: 0.5,         // fraction of the width captured by the floating stick
  topReserve: 56,         // px at the top (below the safe-area inset) left free for HUD buttons
  zIndex: 40,
};

const FOLLOW_AT = 1.3;     // base follows once the finger is this many radii away
const HIT_SLACK = 1.3;     // press: nearest button within this many of its radii
const SLIDE_SLACK = 0.85;  // slide: finger must enter this deep into another button to switch
const ALL_BITS = [BTN.SHOOT, BTN.PASS, BTN.ACTION, BTN.TURBO];

// Fixed per physical button so muscle memory survives the context relabel. Team-neutral.
const BUTTON_DEFS = [
  { key: 'shoot', bit: BTN.SHOOT, big: true, on: 'SHOOT', off: 'CHECK', hintOn: 'HOLD = SLAP', hintOff: '+TURBO = HIT', acc: '255,72,92' },
  { key: 'pass', bit: BTN.PASS, on: 'PASS', off: 'SWITCH', acc: '56,214,255', angle: 180 },
  { key: 'deke', bit: BTN.ACTION, on: 'DEKE', off: 'POKE', acc: '255,201,60', angle: 225 },
  { key: 'turbo', bit: BTN.TURBO, on: 'TURBO', off: 'TURBO', acc: '186,128,255', angle: 270 },
];

const STYLE_ID = 'ir-touch-style';
const FONT = '"Avenir Next Condensed", "Bahnschrift", "Roboto Condensed", "sans-serif-condensed", "Arial Narrow", "Helvetica Neue", Impact, system-ui, sans-serif';
const OUTLINE = '0 2px 0 rgba(0,0,0,.85), 1.5px 1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px -1.5px 0 #000, 0 0 6px rgba(0,0,0,.6)';

const CSS = `
html.ir-touch-on, html.ir-touch-on body {
  touch-action: none; overscroll-behavior: none; -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; -webkit-text-size-adjust: 100%;
}
.ir-touch-root {
  position: absolute; inset: 0; z-index: var(--ir-z, 40); pointer-events: none; overflow: hidden;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent; font-family: ${FONT}; font-stretch: 75%;
}
.ir-touch-root.ir-touch-fixed { position: fixed; }
.ir-touch-root.ir-touch-hidden { display: none; }
.ir-touch-root * { box-sizing: border-box; }
.ir-touch-probe {
  position: absolute; left: 0; top: 0; width: 0; height: 0; visibility: hidden; pointer-events: none;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
}
.ir-touch-zone {
  position: absolute; pointer-events: auto; touch-action: none; background: transparent;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
}
.ir-touch-stickzone { left: 0; bottom: 0; top: calc(env(safe-area-inset-top, 0px) + var(--ir-top, 56px)); width: var(--ir-stickw, 50%); }

/* ---- stick ---- */
.ir-touch-stick {
  position: absolute; left: 0; top: 0; width: calc(var(--ir-r) * 2); height: calc(var(--ir-r) * 2);
  margin: calc(var(--ir-r) * -1) 0 0 calc(var(--ir-r) * -1); pointer-events: none;
  opacity: .4; transition: opacity .2s ease-out; will-change: transform;
}
.ir-touch-stick.ir-touch-active { opacity: 1; transition: opacity .04s; }
.ir-touch-ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 4px solid rgba(255,255,255,.88);
  background: radial-gradient(circle, rgba(14,22,40,.12) 0, rgba(14,22,40,.30) 55%, rgba(14,22,40,.5) 100%);
  box-shadow: 0 0 0 2.5px rgba(0,0,0,.55), inset 0 0 0 2.5px rgba(0,0,0,.35), inset 0 0 22px rgba(140,210,255,.22);
  transition: border-color .1s, box-shadow .1s;
}
.ir-touch-ring::before {
  content: ""; position: absolute; inset: 22%; border-radius: 50%;
  border: 2px dashed rgba(255,255,255,.22);
}
.ir-touch-tick {
  position: absolute; left: 50%; top: 50%; width: 0; height: 0; margin-left: -7px; pointer-events: none;
  border-left: 7px solid transparent; border-right: 7px solid transparent;
  border-bottom: 9px solid rgba(255,255,255,.75); filter: drop-shadow(0 0 1.5px #000);
  transform-origin: 50% 0;
}
.ir-touch-dir {
  position: absolute; inset: -5px; border-radius: 50%; opacity: 0;
  background: conic-gradient(from -38deg, rgba(120,225,255,.95) 0deg 76deg, transparent 76deg);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 10px), #000 calc(100% - 9px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 10px), #000 calc(100% - 9px));
}
.ir-touch-knob {
  position: absolute; left: 50%; top: 50%; width: calc(var(--ir-r) * .96); height: calc(var(--ir-r) * .96);
  margin: calc(var(--ir-r) * -.48) 0 0 calc(var(--ir-r) * -.48); border-radius: 50%;
  border: 4px solid #fff; will-change: transform;
  background: radial-gradient(circle at 50% 30%, rgba(255,255,255,.75) 0, rgba(200,228,255,.42) 38%, rgba(40,60,96,.72) 100%);
  box-shadow: 0 0 0 2.5px rgba(0,0,0,.65), 0 5px 12px rgba(0,0,0,.45), inset 0 -5px 10px rgba(0,0,0,.3);
}
.ir-touch-stick.ir-touch-turbo .ir-touch-ring {
  border-color: rgb(186,128,255);
  box-shadow: 0 0 0 2.5px rgba(0,0,0,.55), 0 0 22px rgba(186,128,255,.9), inset 0 0 26px rgba(186,128,255,.45);
}
.ir-touch-stick.ir-touch-turbo .ir-touch-dir {
  background: conic-gradient(from -38deg, rgba(200,150,255,1) 0deg 76deg, transparent 76deg);
}

/* ---- buttons ---- */
.ir-touch-btn { position: absolute; left: 0; top: 0; border-radius: 50%; pointer-events: none; }
.ir-touch-face {
  position: absolute; inset: 0; border-radius: 50%; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  border: 4px solid rgb(var(--acc)); color: #fff;
  background:
    radial-gradient(circle at 50% 26%, rgba(255,255,255,.24), rgba(255,255,255,0) 52%),
    radial-gradient(circle at 50% 50%, rgba(var(--acc),.10), rgba(var(--acc),.26)),
    rgba(10,14,26,.46);
  box-shadow: 0 0 0 2.5px rgba(0,0,0,.62), inset 0 0 0 2px rgba(255,255,255,.26), inset 0 -7px 14px rgba(0,0,0,.38);
  transition: transform .07s ease-out, box-shadow .07s;
}
.ir-touch-big .ir-touch-face { border-width: 5px; }
.ir-touch-btn.ir-touch-down .ir-touch-face {
  transform: scale(.9);
  background:
    radial-gradient(circle at 50% 30%, rgba(255,255,255,.38), rgba(255,255,255,0) 58%),
    rgba(var(--acc),.72);
  box-shadow: 0 0 0 2.5px rgba(0,0,0,.7), 0 0 22px rgba(var(--acc),.95), inset 0 0 0 2px rgba(255,255,255,.55), inset 0 5px 12px rgba(0,0,0,.32);
}
.ir-touch-lbl, .ir-touch-hint {
  position: relative; display: block; flex: none; width: max-content; white-space: nowrap; line-height: 1; text-align: center;
  text-transform: uppercase; text-shadow: ${OUTLINE};
}
.ir-touch-lbl { font-size: var(--ir-fs); font-weight: 900; font-style: italic; letter-spacing: .03em; }
.ir-touch-hint { font-size: calc(var(--ir-fs) * .46); font-weight: 800; letter-spacing: .08em; margin-top: .35em; opacity: .9; }
.ir-touch-fill {
  position: absolute; left: 0; right: 0; bottom: 0; height: calc(var(--ir-charge, 0) * 100%);
  background: linear-gradient(to top, rgba(255,72,92,.9), rgba(255,150,60,.85) 60%, rgba(255,214,64,.9));
  box-shadow: 0 -2px 0 rgba(255,255,255,.75);
}
.ir-touch-cring {
  position: absolute; inset: -10px; border-radius: 50%; opacity: 0; transition: opacity .1s;
  background: conic-gradient(rgb(255,214,64) calc(var(--ir-charge, 0) * 1turn), rgba(0,0,0,.35) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px));
}
.ir-touch-charging .ir-touch-cring { opacity: 1; }
.ir-touch-max .ir-touch-face { animation: ir-touch-pulse .3s ease-in-out infinite alternate; }
.ir-touch-max .ir-touch-cring { background: rgb(255,236,120); }
@keyframes ir-touch-pulse {
  from { box-shadow: 0 0 0 2.5px rgba(0,0,0,.7), 0 0 6px rgba(255,214,64,.4); }
  to   { box-shadow: 0 0 0 2.5px rgba(0,0,0,.7), 0 0 30px rgba(255,214,64,1); }
}
@media (prefers-reduced-motion: reduce) {
  .ir-touch-max .ir-touch-face { animation: none; box-shadow: 0 0 0 2.5px rgba(0,0,0,.7), 0 0 24px rgba(255,214,64,1); }
  .ir-touch-face { transition: none; }
}
`;

let styleRefs = 0;
function ensureStyle(doc) {
  styleRefs++;
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(s);
}
function releaseStyle(doc) {
  styleRefs = Math.max(0, styleRefs - 1);
  if (styleRefs === 0) doc.getElementById(STYLE_ID)?.remove();
}
let visibleInstances = 0;

const r3 = (v) => Math.round(v * 1000) / 1000 || 0; // also turns -0 into 0

export function createTouchControls(container, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const doc = container?.ownerDocument || document;
  const win = doc.defaultView || window;
  const nav = win.navigator;
  if (!container) container = doc.body;
  ensureStyle(doc);

  const mk = (cls, parent, tag = 'div') => {
    const e = doc.createElement(tag);
    e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  };

  // ---- DOM ----
  const root = mk('ir-touch-root ir-touch-hidden');
  root.setAttribute('aria-hidden', 'true');
  if (container === doc.body || container === doc.documentElement) root.classList.add('ir-touch-fixed');
  root.style.setProperty('--ir-z', String(o.zIndex));
  root.style.setProperty('--ir-top', `${o.topReserve}px`);
  root.style.setProperty('--ir-stickw', `${clamp(o.stickZone, 0.2, 0.8) * 100}%`);
  const probe = mk('ir-touch-probe', root);
  const stickZone = mk('ir-touch-zone ir-touch-stickzone', root);
  const btnZone = mk('ir-touch-zone ir-touch-btnzone', root);

  const stickEl = mk('ir-touch-stick', root);
  const ringEl = mk('ir-touch-ring', stickEl);
  const dirEl = mk('ir-touch-dir', stickEl);
  for (let i = 0; i < 4; i++) {
    const t = mk('ir-touch-tick', ringEl);
    t.dataset.i = String(i);
  }
  const knobEl = mk('ir-touch-knob', stickEl);

  const buttons = BUTTON_DEFS.map((d) => {
    const el = mk(`ir-touch-btn ir-touch-b-${d.key}${d.big ? ' ir-touch-big' : ''}`, root);
    el.style.setProperty('--acc', d.acc);
    const cring = d.big ? mk('ir-touch-cring', el) : null;
    const face = mk('ir-touch-face', el);
    const fill = d.big ? mk('ir-touch-fill', face) : null;
    const lbl = mk('ir-touch-lbl', face, 'span');
    const hint = d.big ? mk('ir-touch-hint', face, 'span') : null;
    return { ...d, el, face, fill, cring, lbl, hint, x: 0, y: 0, rad: 1, down: false };
  });
  const shootBtn = buttons[0];
  const turboBtn = buttons.find((b) => b.bit === BTN.TURBO);
  container.appendChild(root);

  // ---- state ----
  let visible = false, disposed = false;
  let hasPuck = !o.hasPuck; // forces the first relabel below
  let charge = -1;
  const L = { w: 0, h: 0, r: 60, rest: { x: 80, y: 300 }, safe: { t: 0, r: 0, b: 0, l: 0 }, stickTop: 0, stickRight: 0 };
  let rx = 0, ry = 0;                 // root's client-space offset
  const pointers = new Map();         // pointerId -> { kind: 'stick' } | { kind: 'btn', b }
  let stickId = null, ox = 0, oy = 0, sx = 0, sy = 0, smag = 0;
  const held = {}, downAt = {};
  for (const bit of ALL_BITS) { held[bit] = 0; downAt[bit] = -Infinity; }
  const now = () => (win.performance ? win.performance.now() : Date.now());

  // ---- layout ----
  function readSafe() {
    const cs = win.getComputedStyle(probe);
    const p = (v) => parseFloat(v) || 0;
    return { t: p(cs.paddingTop), r: p(cs.paddingRight), b: p(cs.paddingBottom), l: p(cs.paddingLeft) };
  }
  function refreshRect() {
    const rc = root.getBoundingClientRect();
    rx = rc.left; ry = rc.top;
    return rc;
  }
  function fitLabel(span, maxW) {
    if (!span) return;
    span.style.transform = '';
    const w = span.offsetWidth;
    if (w > maxW && w > 0) span.style.transform = `scale(${(maxW / w).toFixed(3)})`;
  }
  function fitLabels() {
    for (const b of buttons) {
      const inner = b.rad * 2 - (b.big ? 10 : 8);
      fitLabel(b.lbl, inner * 0.84);
      fitLabel(b.hint, inner * 0.74);
    }
  }
  function layout() {
    if (disposed || !visible) return;
    const rc = refreshRect();
    const W = rc.width, H = rc.height;
    if (!(W > 0 && H > 0)) return;
    const safe = readSafe();
    const s = Math.min(W, H);
    const r = clamp(Math.round(s * 0.16), 46, 92);
    const bigD = clamp(Math.round(s * 0.25), 84, 140);
    const smallD = Math.round(bigD * 0.66);
    const gap = clamp(Math.round(s * 0.025), 8, 16);
    const m = clamp(Math.round(s * 0.045), 12, 30);
    Object.assign(L, { w: W, h: H, r, safe });
    root.style.setProperty('--ir-r', `${r}px`);

    // stick: resting "ghost" position bottom-left
    L.rest.x = safe.l + m + r * 1.15;
    L.rest.y = H - safe.b - m - r * 1.15;
    L.stickTop = safe.t + o.topReserve;
    L.stickRight = W * clamp(o.stickZone, 0.2, 0.8);
    for (const t of ringEl.querySelectorAll('.ir-touch-tick')) {
      const i = +t.dataset.i;
      t.style.transform = `rotate(${i * 90}deg) translateY(${-(r - 15)}px)`;
    }

    // buttons: big one in the corner, the others on an arc around it (left, up-left, up)
    const cx = W - safe.r - m - bigD / 2;
    const cy = H - safe.b - m - bigD / 2;
    const arc = Math.max(bigD / 2 + smallD / 2 + gap, (smallD + gap) / (2 * Math.sin(Math.PI / 8)));
    let minX = Infinity, minY = Infinity;
    for (const b of buttons) {
      const d = b.big ? bigD : smallD;
      if (b.big) { b.x = cx; b.y = cy; } else {
        const a = (b.angle * Math.PI) / 180;
        b.x = cx + Math.cos(a) * arc;
        b.y = cy + Math.sin(a) * arc;
      }
      b.rad = d / 2;
      b.el.style.width = b.el.style.height = `${d}px`;
      b.el.style.transform = `translate3d(${b.x - d / 2}px, ${b.y - d / 2}px, 0)`;
      b.el.style.setProperty('--ir-fs', `${Math.round(d * (b.big ? 0.19 : 0.235))}px`);
      minX = Math.min(minX, b.x - b.rad * HIT_SLACK);
      minY = Math.min(minY, b.y - b.rad * HIT_SLACK);
    }
    btnZone.style.left = `${Math.max(0, minX)}px`;
    btnZone.style.top = `${Math.max(0, minY)}px`;
    btnZone.style.right = '0px';
    btnZone.style.bottom = '0px';
    fitLabels();
    if (stickId === null) placeStickAtRest();
  }

  // ---- stick ----
  function placeStickAtRest() {
    stickEl.style.transform = `translate3d(${L.rest.x}px, ${L.rest.y}px, 0)`;
    knobEl.style.transform = 'translate3d(0,0,0)';
    dirEl.style.opacity = '0';
  }
  function autoTurboOn() {
    return o.autoTurbo && stickId !== null && smag >= o.turboThreshold;
  }
  function updateStick(x, y) {
    let dx = x - ox, dy = y - oy;
    if (o.followStick) {
      const len = Math.hypot(dx, dy), lim = L.r * FOLLOW_AT;
      if (len > lim) {
        ox = x - (dx / len) * lim; oy = y - (dy / len) * lim;
        dx = x - ox; dy = y - oy;
      }
    }
    const v = stickVector(dx, dy, L.r, o.deadzone);
    sx = v.x; sy = v.y; smag = v.mag;
    stickEl.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
    knobEl.style.transform = `translate3d(${v.kx}px, ${v.ky}px, 0)`;
    if (v.mag > 0) {
      dirEl.style.transform = `rotate(${(Math.atan2(dx, -dy) * 180) / Math.PI}deg)`;
      dirEl.style.opacity = String(0.35 + 0.65 * v.mag);
    } else dirEl.style.opacity = '0';
    syncVisuals();
  }
  function stickDown(id, x, y) {
    stickId = id; ox = x; oy = y;
    stickEl.classList.add('ir-touch-active');
    updateStick(x, y);
  }
  function stickUp() {
    stickId = null; sx = sy = smag = 0;
    stickEl.classList.remove('ir-touch-active');
    placeStickAtRest();
    syncVisuals();
  }

  // ---- buttons ----
  function hitButton(x, y, slack) {
    let best = null, bd = Infinity;
    for (const b of buttons) {
      const d = Math.hypot(x - b.x, y - b.y) / b.rad;
      if (d < bd) { bd = d; best = b; }
    }
    return bd <= slack ? best : null;
  }
  function buzz() {
    if (!o.haptics || !nav || typeof nav.vibrate !== 'function') return;
    try { nav.vibrate(8); } catch { /* not allowed yet */ }
  }
  function press(bit) {
    if (held[bit]++ === 0) { downAt[bit] = now(); buzz(); }
    syncVisuals();
  }
  function release(bit) {
    held[bit] = Math.max(0, held[bit] - 1);
    syncVisuals();
  }
  function syncVisuals() {
    const turbo = autoTurboOn();
    for (const b of buttons) {
      const down = held[b.bit] > 0 || (b === turboBtn && turbo);
      if (down !== b.down) { b.down = down; b.el.classList.toggle('ir-touch-down', down); }
    }
    stickEl.classList.toggle('ir-touch-turbo', turbo);
  }

  // ---- pointer plumbing ----
  const accept = (e) => e.pointerType === 'touch' || e.pointerType === 'pen' || (o.mouse && e.pointerType === 'mouse');
  function capture(el, id) { try { el.setPointerCapture(id); } catch { /* synthetic / already gone */ } }

  function onDown(e) {
    if (!visible || !accept(e)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.cancelable) e.preventDefault();
    if (pointers.has(e.pointerId)) return;
    refreshRect();
    const x = e.clientX - rx, y = e.clientY - ry;
    let rec = null;
    if (e.currentTarget === btnZone) {
      const b = hitButton(x, y, HIT_SLACK);
      if (b) rec = { kind: 'btn', b };
      else if (stickId === null && x < L.stickRight && y >= L.stickTop) rec = { kind: 'stick' };
    } else if (stickId === null) rec = { kind: 'stick' };
    if (!rec) return;
    capture(e.currentTarget, e.pointerId);
    pointers.set(e.pointerId, rec);
    if (rec.kind === 'stick') stickDown(e.pointerId, x, y);
    else press(rec.b.bit);
  }
  function onMove(e) {
    const rec = pointers.get(e.pointerId);
    if (!rec) return;
    if (e.cancelable) e.preventDefault();
    const x = e.clientX - rx, y = e.clientY - ry;
    if (rec.kind === 'stick') { updateStick(x, y); return; }
    const b = hitButton(x, y, SLIDE_SLACK);
    if (b && b !== rec.b) { release(rec.b.bit); rec.b = b; press(b.bit); }
  }
  function onEnd(e) {
    const rec = pointers.get(e.pointerId);
    if (!rec) return;
    pointers.delete(e.pointerId);
    if (rec.kind === 'stick') { if (stickId === e.pointerId) stickUp(); } else release(rec.b.bit);
  }
  function releaseAll() {
    pointers.clear();
    for (const bit of ALL_BITS) { held[bit] = 0; downAt[bit] = -Infinity; }
    if (stickId !== null) stickUp(); else syncVisuals();
  }

  const prevent = (e) => { if (e.cancelable) e.preventDefault(); };
  const guard = (e) => {
    if (!visible) return;
    const t = e.target;
    if (t && t.closest && t.closest('[data-ir-touch-allow]')) return; // escape hatch for overlays
    if (e.cancelable) e.preventDefault();
  };
  const onVis = () => { if (doc.visibilityState === 'hidden') releaseAll(); };
  const onResize = () => layout();
  const onRotate = () => { releaseAll(); layout(); };

  const zoneEvents = [
    ['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onEnd],
    ['pointercancel', onEnd], ['lostpointercapture', onEnd],
    ['touchstart', prevent], ['touchmove', prevent], ['touchend', prevent],
    ['contextmenu', prevent], ['dblclick', prevent], ['selectstart', prevent],
  ];
  // Document-wide guards are non-passive, so they are only attached while visible (lobby /
  // menu scrolling stays on the fast path when the controls are hidden).
  const guardEvents = [['touchmove', guard], ['gesturestart', guard], ['gesturechange', guard], ['dblclick', guard]];
  const winEvents = [['blur', releaseAll], ['pagehide', releaseAll], ['resize', onResize], ['orientationchange', onRotate]];
  const nonPassive = { passive: false };
  let guarded = false;
  function setGuards(on) {
    if (on === guarded) return;
    guarded = on;
    for (const [t, f] of guardEvents) (on ? doc.addEventListener : doc.removeEventListener).call(doc, t, f, nonPassive);
  }
  for (const z of [stickZone, btnZone]) for (const [t, f] of zoneEvents) z.addEventListener(t, f, nonPassive);
  root.addEventListener('contextmenu', prevent);
  doc.addEventListener('visibilitychange', onVis);
  for (const [t, f] of winEvents) win.addEventListener(t, f);
  const ro = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(onResize) : null;
  ro?.observe(root);

  // ---- public API ----
  function poll() {
    if (!visible) return { mx: 0, mz: 0, b: 0 };
    const t = now();
    let b = 0;
    for (const bit of ALL_BITS) if (held[bit] > 0 || t - downAt[bit] < o.minPressMs) b |= bit;
    if (autoTurboOn()) b |= BTN.TURBO;
    return { mx: r3(sx), mz: r3(sy), b };
  }

  function setVisible(v) {
    v = !!v;
    if (disposed || v === visible) return;
    visible = v;
    root.classList.toggle('ir-touch-hidden', !v);
    visibleInstances += v ? 1 : -1;
    doc.documentElement.classList.toggle('ir-touch-on', visibleInstances > 0);
    setGuards(v);
    if (v) layout(); else releaseAll();
  }

  function setContext(ctx = {}) {
    const hp = !!(ctx && ctx.hasPuck);
    if (hp === hasPuck) return;
    hasPuck = hp;
    root.classList.toggle('ir-touch-puck', hp);
    for (const b of buttons) {
      b.lbl.textContent = hp ? b.on : b.off;
      if (b.hint) b.hint.textContent = hp ? b.hintOn : b.hintOff;
    }
    if (visible) fitLabels();
  }

  function setCharge(v) {
    v = clamp(+v || 0, 0, 1);
    if (Math.abs(v - charge) < 0.004 && (v > 0) === (charge > 0) && (v >= 0.999) === (charge >= 0.999)) return;
    charge = v;
    shootBtn.el.style.setProperty('--ir-charge', v.toFixed(3));
    shootBtn.el.classList.toggle('ir-touch-charging', v > 0);
    shootBtn.el.classList.toggle('ir-touch-max', v >= 0.999);
  }

  function dispose() {
    if (disposed) return;
    setVisible(false);
    disposed = true;
    for (const z of [stickZone, btnZone]) for (const [t, f] of zoneEvents) z.removeEventListener(t, f, nonPassive);
    root.removeEventListener('contextmenu', prevent);
    doc.removeEventListener('visibilitychange', onVis);
    for (const [t, f] of winEvents) win.removeEventListener(t, f);
    ro?.disconnect();
    root.remove();
    releaseStyle(doc);
  }

  setContext({ hasPuck: o.hasPuck });
  setCharge(0);
  placeStickAtRest();
  if (o.visible) setVisible(true);

  return { poll, setVisible, setContext, setCharge, dispose, el: root };
}
