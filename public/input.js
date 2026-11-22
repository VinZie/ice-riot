// ICE RIOT - keyboard + mouse + gamepad input.
//
// poll() -> { mx, mz, b } in WORLD space (see shared/constants.js): screen right = +mx,
// screen up = -mz, screen down = +mz. b is the BTN bitfield. Buttons tapped between two polls
// are latched so a quick tap (or click) is never lost on high-refresh displays.
//
// Mouse buttons are binding codes like keys: 'Mouse0' (left), 'Mouse1' (middle), 'Mouse2' (right),
// resolved through the same keymap (settings.keyFor). They only act while a game is active, input
// is not suppressed, and the press lands on the game itself (#game / #fallback2d canvas or the bare
// #ui overlay) - never on a button, field, menu, sheet or chat. Touch is left to touch.js.

import { BTN } from '/shared/constants.js';

const MOVE_KEYS = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};
// Used until a keymap is set (mirrors settings.js DEFAULTS.keys).
const BUTTON_KEYS = {
  Mouse0: BTN.SHOOT, Space: BTN.SHOOT,
  Mouse2: BTN.PASS, KeyK: BTN.PASS,
  KeyL: BTN.ACTION,
  ShiftLeft: BTN.TURBO, ShiftRight: BTN.TURBO,
};
const DEADZONE = 0.2;
const ACTION_BTN = { shoot: BTN.SHOOT, pass: BTN.PASS, action: BTN.ACTION, turbo: BTN.TURBO };
const MOVE_ACTIONS = { up: 1, down: 1, left: 1, right: 1 };

export const MOUSE_CODES = Object.freeze(['Mouse0', 'Mouse1', 'Mouse2']);   // by MouseEvent.button
const MOUSE_MASK = { Mouse0: 1, Mouse1: 4, Mouse2: 2 };                       // MouseEvent.buttons bits
const GAME_SURFACES = new Set(['game', 'fallback2d', 'ui']);
const NOT_GAME = 'button, input, textarea, select, option, a, label, summary, [contenteditable], '
  + '[role="button"], [role="dialog"], [role="menu"], .menu, [data-act]';
const TOUCH_GRACE_MS = 1000;     // compatibility mouse events trail a touch by a few hundred ms

export function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** 0 -> 'Mouse0', 1 -> 'Mouse1', 2 -> 'Mouse2', anything else -> null. */
export function mouseCode(button) {
  return MOUSE_CODES[button] || null;
}

/** True when a mouse press on `el` is meant for the game (canvas or the bare #ui overlay). */
export function isGameSurface(el) {
  if (!el || el.nodeType !== 1 || !GAME_SURFACES.has(el.id)) return false;
  return !(typeof el.closest === 'function' && el.closest(NOT_GAME));
}

export function createInput(target = window) {
  const down = new Set();        // currently held binding codes (keys and mouse buttons)
  let latched = 0;               // buttons pressed since the last poll
  let gameActive = false;        // only swallow game keys while a game is on screen
  let padIndex = -1;
  let lastPadButtons = [];
  const padListeners = [];       // fn(buttonIndex) on gamepad button press edges (menu nav)
  const state = { mx: 0, mz: 0, b: 0, usingPad: false };
  let keyFor = null;             // optional rebinding: code -> 'up'|'down'|'left'|'right'|'shoot'|'pass'|'action'|'turbo'|null
  let padLimit = Infinity;       // only read gamepads with index < padLimit (couch co-op reserves the rest)
  let suppressed = false;        // e.g. while typing in chat
  let lastTouchAt = -Infinity;

  const moveOf = (code) => {
    if (keyFor) { const a = keyFor(code); return MOVE_ACTIONS[a] ? a : null; }
    return MOVE_KEYS[code] || null;
  };
  const btnOf = (code) => {
    if (keyFor) return ACTION_BTN[keyFor(code)] || 0;
    return BUTTON_KEYS[code] || 0;
  };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function onKeyDown(e) {
    if (isTypingTarget(e.target) || suppressed) return;
    const code = e.code;
    const bit = btnOf(code);
    const isGameKey = !!bit || !!moveOf(code);
    if (!isGameKey) return;
    if (gameActive) e.preventDefault();
    if (e.repeat) return;
    down.add(code);
    if (bit) latched |= bit;
    state.usingPad = false;
  }
  function onKeyUp(e) {
    // Always release, even if unmapped now, so a rebind mid-hold can't leave a key stuck.
    if (down.delete(e.code) && gameActive && !isTypingTarget(e.target)) e.preventDefault();
  }

  // --- mouse ---
  function fromTouch(e) {
    if (e.pointerType === 'touch') return true;
    if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return true;
    return now() - lastTouchAt < TOUCH_GRACE_MS;
  }
  function onPointerDown(e) {
    if (e.pointerType === 'touch') lastTouchAt = now();
  }
  function onMouseDown(e) {
    const code = mouseCode(e.button);
    if (!code || !gameActive || suppressed || fromTouch(e) || !isGameSurface(e.target)) return;
    const bit = btnOf(code);
    if (!bit && !moveOf(code)) return;
    e.preventDefault();          // no focus change, text selection or middle-click autoscroll
    down.add(code);
    if (bit) latched |= bit;
    state.usingPad = false;
  }
  function onMouseUp(e) {        // anywhere: a press that started on the game always ends
    const code = mouseCode(e.button);
    if (code) down.delete(code);
  }
  function onMouseMove(e) {      // a release outside the window shows up as a missing `buttons` bit
    if (!down.size || typeof e.buttons !== 'number') return;
    for (const c of MOUSE_CODES) if (down.has(c) && !(e.buttons & MOUSE_MASK[c])) down.delete(c);
  }
  function onContextMenu(e) {
    if (gameActive && isGameSurface(e.target)) e.preventDefault();
  }

  function clear() {
    down.clear();
    latched = 0;
  }
  const onVisibility = () => { if (document.hidden) clear(); };
  const onPadOn = (e) => { if (padIndex < 0) padIndex = e.gamepad.index; };
  const onPadOff = (e) => { if (padIndex === e.gamepad.index) padIndex = -1; };
  const LISTENERS = [
    [target, 'keydown', onKeyDown], [target, 'keyup', onKeyUp],
    [target, 'mousedown', onMouseDown], [window, 'mouseup', onMouseUp, true], [window, 'mousemove', onMouseMove, true],
    [window, 'pointerdown', onPointerDown, true], [target, 'contextmenu', onContextMenu],
    [window, 'blur', clear], [document, 'visibilitychange', onVisibility],
    [window, 'gamepadconnected', onPadOn], [window, 'gamepaddisconnected', onPadOff],
  ];
  for (const [t, type, fn, cap] of LISTENERS) t.addEventListener(type, fn, !!cap);

  function readPad() {
    let pads;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch { pads = []; }
    if (!pads) return null;
    let pad = padIndex >= 0 && padIndex < padLimit ? pads[padIndex] : null;
    if (!pad || !pad.connected) {
      pad = null;
      for (const p of pads) if (p && p.connected && p.index < padLimit) { pad = p; padIndex = p.index; break; }
    }
    return pad;
  }

  function poll() {
    // keyboard + mouse
    let kx = 0, kz = 0;
    for (const code of down) {
      const dir = moveOf(code);
      if (dir === 'left') kx -= 1;
      else if (dir === 'right') kx += 1;
      else if (dir === 'up') kz -= 1;
      else if (dir === 'down') kz += 1;
    }
    kx = Math.max(-1, Math.min(1, kx));
    kz = Math.max(-1, Math.min(1, kz));
    let b = latched;
    latched = 0;
    for (const code of down) b |= btnOf(code);
    let mx = kx, mz = kz;

    // gamepad (standard mapping)
    const pad = readPad();
    if (pad) {
      const btn = (i) => { const x = pad.buttons[i]; return x ? (typeof x === 'object' ? x.pressed || x.value > 0.35 : x > 0.35) : false; };
      let ax = pad.axes[0] || 0, az = pad.axes[1] || 0;
      const mag = Math.hypot(ax, az);
      if (mag < DEADZONE) { ax = 0; az = 0; }
      else {
        const scaled = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE));
        ax = (ax / mag) * scaled; az = (az / mag) * scaled; // stick down = +axis1 = +Z
      }
      if (btn(12)) az -= 1;
      if (btn(13)) az += 1;
      if (btn(14)) ax -= 1;
      if (btn(15)) ax += 1;
      if (ax || az) { mx += ax; mz += az; state.usingPad = true; }
      if (btn(0)) b |= BTN.SHOOT;
      if (btn(2)) b |= BTN.PASS;
      if (btn(1)) b |= BTN.ACTION;
      if (btn(5) || btn(7) || btn(6)) b |= BTN.TURBO;
      // press edges for UI (Start = 9 opens the menu, A/B for menus)
      const now = pad.buttons.map((_, i) => btn(i));
      for (let i = 0; i < now.length; i++) {
        if (now[i] && !lastPadButtons[i]) {
          state.usingPad = true;
          for (const fn of padListeners) { try { fn(i); } catch (e) { console.error(e); } }
        }
      }
      lastPadButtons = now;
    } else {
      lastPadButtons = [];
    }

    // normalize diagonals / combined inputs to unit length
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    state.mx = mx; state.mz = mz; state.b = b;
    return state;
  }

  return {
    poll,
    clear,
    setGameActive(on) {
      on = !!on;
      if (gameActive && !on) clear();
      gameActive = on;
    },
    onPadButton(fn) { padListeners.push(fn); },
    setKeymap(fn) { keyFor = typeof fn === 'function' ? fn : null; clear(); },
    setPadLimit(n) { padLimit = n > 0 ? n : Infinity; if (padIndex >= padLimit) padIndex = -1; },
    setSuppressed(on) { suppressed = !!on; if (suppressed) clear(); },
    /** Remove every listener (tests / hot reload). */
    dispose() {
      for (const [t, type, fn, cap] of LISTENERS) t.removeEventListener(type, fn, !!cap);
      clear();
    },
    get hasPad() { return !!readPad(); },
    get usingPad() { return state.usingPad; },
  };
}
