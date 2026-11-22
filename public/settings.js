// ICE RIOT - player settings.
//
//   createSettings()       persisted + validated settings store (localStorage; works with no storage,
//                          throwing storage, or a fake storage for tests) with change subscriptions and
//                          a reverse key lookup for input handling.
//   createSettingsPanel()  600px settings sheet from the right: Audio / Video / Controls / Gameplay.
//   rebindKeys()           pure key-rebinding helper (conflicts swap bindings).
//   keyLabel()             human label for a binding code ('KeyJ' -> 'J', 'Mouse0' -> 'Left click').
//
// Binding codes are KeyboardEvent.code values plus the mouse buttons 'Mouse0' (left), 'Mouse1'
// (middle) and 'Mouse2' (right).
//
// Everything above the "PANEL" banner is pure (no DOM, no imports) so it runs under Node for tests.

export const SETTINGS_VERSION = 2;
export const STORAGE_KEY = 'iceRiot.settings';
export const MAX_SLOTS = 2;            // key slots per action (primary + alternate)
export const NAME_MAX = 16;            // matches the server's hello.name limit

export const ACTIONS = Object.freeze(['up', 'down', 'left', 'right', 'shoot', 'pass', 'action', 'turbo']);
export const ACTION_LABELS = Object.freeze({
  up: 'Skate up', down: 'Skate down', left: 'Skate left', right: 'Skate right',
  shoot: 'Shoot \u00b7 check', pass: 'Pass \u00b7 switch', action: 'Deke \u00b7 poke', turbo: 'Turbo',
});
export const QUALITY_LEVELS = Object.freeze(['auto', 'high', 'medium', 'low']);
// Codes that can never be bound: Escape cancels a rebind and opens/closes menus.
export const RESERVED_CODES = Object.freeze(['Escape']);
// Mouse buttons that can be bound, indexed by MouseEvent.button (0 left, 1 middle, 2 right).
export const MOUSE_CODES = Object.freeze(['Mouse0', 'Mouse1', 'Mouse2']);

// Gamepad mapping is fixed (standard mapping, see public/input.js). Shown read-only in the sheet.
export const GAMEPAD_LAYOUT = deepFreeze([
  { buttons: [{ t: 'L', shape: 'stick' }], label: 'Skate', sub: 'Left stick or D-pad' },
  { buttons: [{ t: 'A', shape: 'round' }], label: 'Shoot \u00b7 check', sub: 'Hold to charge a slapshot' },
  { buttons: [{ t: 'X', shape: 'round' }], label: 'Pass \u00b7 switch', sub: 'No puck switches skater' },
  { buttons: [{ t: 'B', shape: 'round' }], label: 'Deke \u00b7 poke', sub: 'No puck stick-checks' },
  { buttons: [{ t: 'RB', shape: 'pill' }, { t: 'RT', shape: 'pill' }, { t: 'LT', shape: 'pill' }], label: 'Turbo', sub: 'Hold to sprint' },
  { buttons: [{ t: 'Start', shape: 'pill' }], label: 'Menu, or join on a spare pad', sub: 'Pause menu in game' },
]);

export const DEFAULTS = deepFreeze({
  version: 2,
  sfxVolume: 0.8, musicVolume: 0.45, announcerVolume: 0.9, announcer: true, muted: false,
  quality: 'auto',            // 'auto' | 'high' | 'medium' | 'low'
  cameraShake: 1.0,           // 0..1
  showNames: true, showTutorial: true, reduceFlashes: false,
  puckCam: false,             // goal replays: slow-mo from behind the puck instead of the goal cam
  keys: { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
          shoot: ['Mouse0', 'Space'], pass: ['Mouse2', 'KeyK'], action: ['KeyL'], turbo: ['ShiftLeft', 'ShiftRight'] },
  name: '',
});

// Version-1 default bindings. The migrations below compare against these (never against DEFAULTS,
// which moves on with every version).
const V1_KEYS = deepFreeze({
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  shoot: ['KeyJ', 'Space'], pass: ['KeyK'], action: ['KeyL'], turbo: ['ShiftLeft', 'ShiftRight'],
});

const FIELD_KEYS = Object.keys(DEFAULTS).filter((k) => k !== 'version');
const UNIT_FIELDS = new Set(['sfxVolume', 'musicVolume', 'announcerVolume', 'cameraShake']);
const BOOL_FIELDS = new Set(['announcer', 'muted', 'showNames', 'showTutorial', 'reduceFlashes', 'puckCam']);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const copy = (v) => (v !== null && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((c, i) => c === b[i]);

// ---------------------------------------------------------------------------------------------
// Validation. Each validator returns the cleaned value, or undefined when the input is unusable
// (the caller then keeps the current value on set(), or the default on load).

/** True for a mouse binding code ('Mouse0' | 'Mouse1' | 'Mouse2'). */
export function isMouseCode(code) {
  return MOUSE_CODES.includes(code);
}

/** True if `code` is a KeyboardEvent.code-shaped string (or a mouse code) that may be bound. */
export function isBindableCode(code) {
  if (typeof code !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(code) || RESERVED_CODES.includes(code)) return false;
  if (/^Mouse\d+$/.test(code)) return isMouseCode(code);   // only left, middle and right
  return true;
}

function toUnit(v) {
  if (typeof v === 'string' && v.trim() !== '') v = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
}
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  if (v === 'true' || v === 'false') return v === 'true';
  return undefined;
}
function toQuality(v) {
  if (typeof v !== 'string') return undefined;
  const q = v.trim().toLowerCase();
  return QUALITY_LEVELS.includes(q) ? q : undefined;
}
function toName(v) {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  let s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > NAME_MAX) {
    s = s.slice(0, NAME_MAX);
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);   // don't leave half a surrogate pair
    s = s.trim();
  }
  return s;
}

// One action's slot list: a code string or an array of codes -> up to MAX_SLOTS unique bindable codes.
// [] is valid (action deliberately unbound). A non-empty array with nothing usable is invalid.
function normalizeSlots(v) {
  if (typeof v === 'string') v = [v];
  if (!Array.isArray(v)) return undefined;
  const out = [];
  for (const c of v) if (out.length < MAX_SLOTS && isBindableCode(c) && !out.includes(c)) out.push(c);
  return out.length || v.length === 0 ? out : undefined;
}

/**
 * Clean a key-binding map. Actions present in `raw` win; missing/invalid actions inherit from
 * `base` (the current bindings on set(), DEFAULTS on load). Each code ends up on at most one action:
 * conflicts are resolved by priority (raw before base, primary slot before alternate, then ACTIONS
 * order). An action that lost all its keys to a conflict falls back to its unclaimed defaults.
 */
export function sanitizeKeys(raw, base = DEFAULTS.keys) {
  const src = isPlainObject(raw) ? raw : {};
  const baseSrc = isPlainObject(base) ? base : DEFAULTS.keys;
  const cand = {}, explicit = {};
  for (const a of ACTIONS) {
    const own = hasOwn(src, a) ? normalizeSlots(src[a]) : undefined;
    explicit[a] = own !== undefined;
    cand[a] = own ?? normalizeSlots(baseSrc[a]) ?? DEFAULTS.keys[a].slice();
  }
  const claimed = new Set();
  const out = {};
  for (const a of ACTIONS) out[a] = [];
  for (const tier of [true, false]) {
    for (let s = 0; s < MAX_SLOTS; s++) {
      for (const a of ACTIONS) {
        if (explicit[a] !== tier) continue;
        const c = cand[a][s];
        if (c === undefined || claimed.has(c)) continue;
        claimed.add(c);
        out[a].push(c);
      }
    }
  }
  for (const a of ACTIONS) {
    if (out[a].length || !cand[a].length) continue;
    for (const c of DEFAULTS.keys[a]) {
      if (out[a].length < MAX_SLOTS && !claimed.has(c)) { claimed.add(c); out[a].push(c); }
    }
  }
  return out;
}

function validateField(key, value, keysBase) {
  if (UNIT_FIELDS.has(key)) return toUnit(value);
  if (BOOL_FIELDS.has(key)) return toBool(value);
  if (key === 'quality') return toQuality(value);
  if (key === 'name') return toName(value);
  if (key === 'keys') return isPlainObject(value) ? sanitizeKeys(value, keysBase) : undefined;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Migration. MIGRATIONS[n] turns a version-n object into a version-(n+1) object. Steps must be
// tolerant: fields already in the newer shape are carried over untouched. sanitizeSettings() runs
// afterwards, so steps only need to map shapes, not validate.

const LEGACY_QUALITY = { hi: 'high', high: 'high', med: 'medium', mid: 'medium', medium: 'medium', lo: 'low', low: 'low', auto: 'auto' };

export const MIGRATIONS = {
  // v0 = prototype format (no `version` field):
  //   volume / sfx / music / voice : 0..100 percents (volume = master, multiplied into each channel)
  //   mute: bool   gfx: 'hi'|'med'|'lo'|'auto'   shake: bool or 0..100   names, tips: bool
  //   flashes: bool (true = flashes allowed)     bindings: { action: 'KeyCode' } (one key each)
  //   playerName: string
  0(o) {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) if (hasOwn(o, k)) out[k] = o[k];
    const pct = (x) => {
      const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
      return typeof n === 'number' && Number.isFinite(n) ? n / 100 : undefined;
    };
    const master = pct(o.volume);
    const channel = (legacy, key) => {
      if (hasOwn(out, key)) return;
      const p = pct(o[legacy]);
      if (p !== undefined) out[key] = p * (master ?? 1);
      else if (master !== undefined) out[key] = DEFAULTS[key] * master;
    };
    channel('sfx', 'sfxVolume');
    channel('music', 'musicVolume');
    channel('voice', 'announcerVolume');
    if (!hasOwn(out, 'muted') && hasOwn(o, 'mute')) out.muted = o.mute;
    if (!hasOwn(out, 'quality') && typeof o.gfx === 'string') out.quality = LEGACY_QUALITY[o.gfx.trim().toLowerCase()];
    if (!hasOwn(out, 'cameraShake') && hasOwn(o, 'shake')) out.cameraShake = typeof o.shake === 'boolean' ? (o.shake ? 1 : 0) : pct(o.shake);
    if (!hasOwn(out, 'showNames') && hasOwn(o, 'names')) out.showNames = o.names;
    if (!hasOwn(out, 'showTutorial') && hasOwn(o, 'tips')) out.showTutorial = o.tips;
    if (!hasOwn(out, 'reduceFlashes') && typeof o.flashes === 'boolean') out.reduceFlashes = !o.flashes;
    if (!hasOwn(out, 'name') && typeof o.playerName === 'string') out.name = o.playerName;
    if (!hasOwn(out, 'keys') && isPlainObject(o.bindings)) {
      const keys = {};
      for (const a of ACTIONS) {
        const c = o.bindings[a];
        if (!isBindableCode(c)) continue;
        const alt = V1_KEYS[a][1];             // keep the v1 alternate key when it doesn't collide
        keys[a] = alt && alt !== c ? [c, alt] : [c];
      }
      out.keys = keys;
    }
    return out;
  },
  // v1 -> v2: mouse controls. Shoot and pass that still equal the v1 defaults move to the new
  // defaults (left click / right click as primary, Space / K as alternate); custom bindings stay.
  1(o) {
    const out = { ...o };
    if (isPlainObject(o.keys)) {
      const keys = { ...o.keys };
      if (sameList(keys.shoot, V1_KEYS.shoot)) keys.shoot = ['Mouse0', 'Space'];
      if (sameList(keys.pass, V1_KEYS.pass)) keys.pass = ['Mouse2', 'KeyK'];
      out.keys = keys;
    }
    return out;
  },
};

/** Run migration steps from raw.version (missing = 0) up to SETTINGS_VERSION. Never throws. */
export function migrate(raw) {
  if (!isPlainObject(raw)) return { version: SETTINGS_VERSION };
  let o = { ...raw };
  let v = Number.isInteger(o.version) && o.version >= 0 ? o.version : 0;
  while (v < SETTINGS_VERSION) {
    const step = MIGRATIONS[v];
    if (typeof step === 'function') {
      let next;
      try { next = step(o); } catch { next = null; }
      o = isPlainObject(next) ? next : {};
    }
    v += 1;
    o.version = v;
  }
  return o;
}

/** Any value (stored JSON, old version, garbage) -> a complete, valid, current-version settings object. */
export function sanitizeSettings(raw) {
  const o = migrate(raw);
  const out = { version: SETTINGS_VERSION };
  for (const k of FIELD_KEYS) {
    if (k === 'keys') { out.keys = sanitizeKeys(isPlainObject(o.keys) ? o.keys : {}, DEFAULTS.keys); continue; }
    const v = hasOwn(o, k) ? validateField(k, o[k]) : undefined;
    out[k] = v === undefined ? copy(DEFAULTS[k]) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rebinding (pure).

/**
 * Bind `code` to keys[action][slot] (slot 0 = primary, 1 = alternate). Pure: returns a new map.
 *   - code already on another action  -> swap: that action receives this slot's old code (or loses
 *                                        the binding if this slot was empty).
 *   - code on the same action's other slot -> the two slots swap.
 *   - code === null                   -> clear the slot.
 * Returns { keys, changed, swap, unbound, error }
 *   swap    = null | { action, slot, code }  the other binding that was touched; `code` is what it holds
 *             now (null = it was removed)
 *   unbound = actions left with no key at all
 *   error   = null | 'action' | 'slot' | 'reserved' | 'invalid'  (keys unchanged when set)
 */
export function rebindKeys(keys, action, slot, code) {
  const next = sanitizeKeys(keys, keys);
  const res = { keys: next, changed: false, swap: null, unbound: [], error: null };
  const finish = () => { res.unbound = ACTIONS.filter((a) => next[a].length === 0); return res; };
  if (!ACTIONS.includes(action)) { res.error = 'action'; return finish(); }
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) { res.error = 'slot'; return finish(); }
  const own = next[action];
  const old = slot < own.length ? own[slot] : null;

  if (code === null) {
    if (old !== null) { own.splice(slot, 1); res.changed = true; }
    return finish();
  }
  if (!isBindableCode(code)) { res.error = RESERVED_CODES.includes(code) ? 'reserved' : 'invalid'; return finish(); }
  if (old === code) return finish();

  let owner = null, ownerSlot = -1;
  for (const a of ACTIONS) {
    const i = next[a].indexOf(code);
    if (i >= 0) { owner = a; ownerSlot = i; break; }
  }
  if (owner === action) {
    // Same action, other slot. If this slot is empty the lists are compacted, so nothing changes.
    if (old === null) return finish();
    own[ownerSlot] = old;
    own[slot] = code;
    res.changed = true;
    res.swap = { action, slot: ownerSlot, code: old };
    return finish();
  }
  if (slot < own.length) own[slot] = code; else own.push(code);
  if (owner) {
    const other = next[owner];
    if (old !== null) other[ownerSlot] = old; else other.splice(ownerSlot, 1);
    res.swap = { action: owner, slot: ownerSlot, code: old };
  }
  res.changed = true;
  return finish();
}

// ---------------------------------------------------------------------------------------------
// Key labels.

const MOUSE_LABEL = { Mouse0: 'Left click', Mouse1: 'Middle click', Mouse2: 'Right click' };
const KEY_SHORT = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Bksp', CapsLock: 'Caps',
  ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
  AltLeft: 'L-Alt', AltRight: 'R-Alt', MetaLeft: 'L-Meta', MetaRight: 'R-Meta', ContextMenu: 'Menu',
  ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlBackslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .', NumpadEnter: 'Num Enter',
};
const KEY_LONG = {
  ArrowUp: 'Up arrow', ArrowDown: 'Down arrow', ArrowLeft: 'Left arrow', ArrowRight: 'Right arrow',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left Meta', MetaRight: 'Right Meta', Backspace: 'Backspace',
};

/**
 * Human label for a binding code: 'KeyW' -> 'W', 'ArrowUp' -> '\u2191' (long: 'Up arrow'),
 * 'ShiftLeft' -> 'L-Shift', 'Mouse0' -> 'Left click', 'Mouse2' -> 'Right click'.
 */
export function keyLabel(code, long = false) {
  if (typeof code !== 'string' || !code) return long ? 'none' : '\u2014';
  if (MOUSE_LABEL[code]) return MOUSE_LABEL[code];
  if (long && KEY_LONG[code]) return KEY_LONG[code];
  if (KEY_SHORT[code]) return KEY_SHORT[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return `Num ${m[1]}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code.replace(/([a-z])([A-Z0-9])/g, '$1 $2');
}

// ---------------------------------------------------------------------------------------------
// Store.

function defaultStorage() {
  // Reading globalThis.localStorage itself throws in some sandboxed / cookie-blocked contexts.
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
function buildReverse(keys) {
  const m = new Map();
  for (const a of ACTIONS) for (const c of keys[a] || []) if (!m.has(c)) m.set(c, a);
  return m;
}

/**
 * createSettings({ storageKey = 'iceRiot.settings', storage = globalThis.localStorage })
 * storage may be null/undefined/broken: settings then live in memory only.
 */
export function createSettings(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const storageKey = typeof opts.storageKey === 'string' && opts.storageKey ? opts.storageKey : STORAGE_KEY;
  const storage = opts.storage !== undefined ? opts.storage : defaultStorage();
  const subs = new Set();

  function read() {
    try {
      if (!storage || typeof storage.getItem !== 'function') return null;
      const txt = storage.getItem(storageKey);
      return typeof txt === 'string' && txt ? JSON.parse(txt) : null;
    } catch { return null; }
  }
  function write() {
    try {
      if (storage && typeof storage.setItem === 'function') storage.setItem(storageKey, JSON.stringify(state));
    } catch { /* quota / blocked: keep going in memory */ }
  }
  function emit(key) {
    for (const sub of [...subs]) {
      if (!subs.has(sub)) continue;                    // unsubscribed by an earlier listener
      try { sub.fn(key, copy(state[key]), copy(state)); } catch (err) {
        try { console.error('[settings] subscriber error', err); } catch { /* no console */ }
      }
    }
  }

  const raw = read();
  let state = sanitizeSettings(raw);
  let reverse = buildReverse(state.keys);
  // Persist the migrated form of an older save (never downgrade a newer one).
  if (isPlainObject(raw) && !(Number.isInteger(raw.version) && raw.version >= SETTINGS_VERSION)) write();

  return {
    /** Current value (a copy for `keys`). Unknown key -> undefined. */
    get(key) {
      return typeof key === 'string' && hasOwn(state, key) ? copy(state[key]) : undefined;
    },
    /**
     * Validate + clamp + store + persist + notify. Out-of-range numbers are clamped; unusable values
     * (wrong type, unknown quality, ...) are ignored. `keys` may be partial: given actions replace the
     * current ones, the rest are kept. Returns the value now stored (undefined for unknown keys).
     */
    set(key, value) {
      if (typeof key !== 'string' || !FIELD_KEYS.includes(key)) return undefined;
      const v = validateField(key, value, state.keys);
      if (v !== undefined && !same(state[key], v)) {
        state = { ...state, [key]: v };
        if (key === 'keys') reverse = buildReverse(v);
        write();
        emit(key);
      }
      return copy(state[key]);
    },
    all() { return copy(state); },
    /** Everything back to DEFAULTS (persisted); notifies once per key that actually changed. */
    reset() {
      const prev = state;
      state = sanitizeSettings(null);
      reverse = buildReverse(state.keys);
      write();
      for (const k of FIELD_KEYS) if (!same(prev[k], state[k])) emit(k);
    },
    /** fn(key, value, all) after every change. Returns unsubscribe(). */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      const sub = { fn };
      subs.add(sub);
      return () => { subs.delete(sub); };
    },
    /** Binding code (KeyboardEvent.code or 'Mouse0'..'Mouse2') -> action name or null. */
    keyFor(code) {
      return (typeof code === 'string' && reverse.get(code)) || null;
    },
  };
}

// =============================================================================================
// PANEL (DOM only below this line)
// =============================================================================================

const STYLE_ID = 'ir-set-style';
let panelSeq = 0;

// Design tokens (public/style.css :root). Fallbacks keep the sheet right on pages without style.css.
const T = {
  ground: 'var(--ground, #0A0F1C)', surface: 'var(--surface, #111829)', surface2: 'var(--surface-2, #172034)',
  surface3: 'var(--surface-3, #1E2940)', hairline: 'var(--hairline, #253049)', hairline2: 'var(--hairline-strong, #34425F)',
  ink: 'var(--ink, #E8EDF5)', ink2: 'var(--ink-2, #A1ACC0)', ink3: 'var(--ink-3, #6A7590)',
  ice: 'var(--ice, #DCEAF6)', onIce: 'var(--on-ice, #0A0F1C)', focus: 'var(--focus, #E8EDF5)',
  good: 'var(--good, #3FD98A)', warn: 'var(--warn, #F2C14E)', goal: 'var(--goal, #FF4B3E)',
  rSm: 'var(--r-sm, 6px)', rMd: 'var(--r-md, 10px)',
  font: 'var(--f-ui, Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif)',
};

const PANEL_CSS = `
.ir-set-overlay {
  position: fixed; inset: 0; z-index: 1000;
  color: ${T.ink}; font-family: ${T.font}; font-size: 13px; line-height: 18px; font-weight: 400;
  letter-spacing: normal; text-transform: none; text-align: left; font-style: normal;
  -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent;
  box-sizing: border-box; pointer-events: none;
}
.ir-set-overlay.is-open { pointer-events: auto; }
.ir-set-overlay.ir-set-local { position: absolute; }
.ir-set-overlay *, .ir-set-overlay *::before, .ir-set-overlay *::after { box-sizing: border-box; }
.ir-set-overlay[hidden], .ir-set-overlay [hidden] { display: none !important; }
.ir-set-overlay button, .ir-set-overlay input, .ir-set-overlay output {
  font: inherit; color: inherit; margin: 0; letter-spacing: inherit; text-transform: none;
}
.ir-set-overlay button { cursor: pointer; -webkit-appearance: none; appearance: none; }
.ir-set-overlay :focus { outline: none; }
.ir-set-overlay :focus-visible { outline: 2px solid ${T.focus}; outline-offset: 2px; }
.ir-set-ico { display: inline-flex; flex: none; width: 16px; height: 16px; align-items: center; justify-content: center; }
.ir-set-ico svg { display: block; }

.ir-set-scrim {
  position: absolute; inset: 0; background: color-mix(in srgb, ${T.ground} 55%, transparent);
  opacity: 0; transition: opacity 120ms ease-out;
}
.ir-set-overlay.is-open .ir-set-scrim { opacity: 1; transition-duration: 180ms; }

.ir-set-dialog {
  position: absolute; top: 0; right: 0; bottom: 0; width: 600px; max-width: 100%;
  display: flex; flex-direction: column; padding: 0 0 0 1px;
  background: ${T.surface};
  box-shadow: -16px 0 40px rgba(3, 6, 14, 0.45), inset 1px 0 0 ${T.hairline2};
  container-type: inline-size;
  transform: translateX(100%);
}
.ir-set-overlay.is-open .ir-set-dialog { transform: none; transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1); }
.ir-set-overlay.is-closing .ir-set-dialog { transform: translateX(40px); opacity: 0; transition: transform 120ms ease-out, opacity 120ms ease-out; }
.ir-set-overlay.is-closing .ir-set-scrim { opacity: 0; transition: opacity 120ms ease-out; }

.ir-set-head { flex: none; height: 72px; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ir-set-title { margin: 0; font-size: 22px; line-height: 1.18; font-weight: 700; letter-spacing: -0.22px; color: ${T.ink}; }
.ir-set-head-r { display: flex; align-items: center; gap: 8px; }
.ir-set-esc {
  display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border-radius: 4px;
  background: ${T.surface3}; color: ${T.ink2}; font-size: 11px; line-height: 1.18;
}
.ir-set-x {
  width: 34px; height: 34px; padding: 0; display: grid; place-items: center; color: ${T.ink};
  background: transparent; border: 1px solid ${T.hairline2}; border-radius: ${T.rMd};
  transition: background-color 160ms ease-out;
}
.ir-set-x:hover { background: ${T.surface2}; }

.ir-set-tabs {
  flex: none; height: 38px; margin: 0 24px; padding: 3px; display: flex; gap: 2px;
  background: ${T.ground}; border: 1px solid ${T.hairline}; border-radius: ${T.rMd};
}
.ir-set-tab {
  flex: 1 1 0; min-width: 0; padding: 0 6px; border: 0; border-radius: ${T.rSm};
  background: transparent; color: ${T.ink2}; font-size: 13px; line-height: 1.23; white-space: nowrap;
  transition: background-color 160ms ease-out, color 160ms ease-out;
}
.ir-set-tab:hover { color: ${T.ink}; }
.ir-set-tab[aria-selected="true"] { background: ${T.surface3}; color: ${T.ink}; }

.ir-set-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  padding: 20px 24px; scrollbar-width: thin; scrollbar-color: ${T.hairline2} transparent;
}
.ir-set-pane { display: flex; flex-direction: column; }
.ir-set-pane[data-pane="controls"] { gap: 12px; }

/* rows: audio / video / gameplay */
.ir-set-row { display: flex; align-items: center; gap: 16px; min-height: 64px; transition: opacity 160ms ease-out; }
.ir-set-row.is-tall { min-height: 72px; }
.ir-set-row + .ir-set-row { padding-top: 1px; box-shadow: inset 0 1px 0 ${T.hairline}; }
.ir-set-row.is-dim { opacity: 0.45; }
.ir-set-label { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 14px; line-height: 1.21; color: ${T.ink}; }
.ir-set-label.is-fixed { flex: none; width: 150px; }
.ir-set-label small { display: block; font-size: 12px; line-height: 1.17; color: ${T.ink3}; }

.ir-set-switch {
  position: relative; flex: none; width: 40px; height: 22px; padding: 0; border-radius: 999px;
  background: ${T.surface3}; border: 1px solid ${T.hairline2};
  transition: background-color 160ms ease-out, border-color 160ms ease-out;
}
.ir-set-knob {
  position: absolute; left: 3px; top: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: ${T.ink2}; transition: transform 160ms ease-out, background-color 160ms ease-out;
}
.ir-set-switch[aria-checked="true"] { background: ${T.ice}; border-color: ${T.ice}; }
.ir-set-switch[aria-checked="true"] .ir-set-knob { transform: translateX(16px); background: ${T.ground}; }

.ir-set-slider { flex: 1 1 0; min-width: 0; height: 16px; display: flex; align-items: center; }
.ir-set-range {
  -webkit-appearance: none; appearance: none; display: block; width: 296px; max-width: 100%; height: 16px;
  margin: 0; padding: 0; background: transparent; cursor: pointer; --p: 0.5;
}
.ir-set-range::-webkit-slider-runnable-track {
  height: 4px; border: 0; border-radius: 2px;
  background: linear-gradient(to right, ${T.ink} 0, ${T.ink} calc(8px + (100% - 16px) * var(--p)),
    ${T.surface3} calc(8px + (100% - 16px) * var(--p)), ${T.surface3} 100%);
}
.ir-set-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 16px; height: 16px; margin-top: -6px;
  border-radius: 50%; background: ${T.ice}; border: 2px solid ${T.surface};
}
.ir-set-range::-moz-range-track { height: 4px; border: 0; border-radius: 2px; background: ${T.surface3}; }
.ir-set-range::-moz-range-progress { height: 4px; border-radius: 2px; background: ${T.ink}; }
.ir-set-range::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: ${T.ice}; border: 2px solid ${T.surface}; }
.ir-set-val { flex: none; width: 40px; text-align: right; font-size: 13px; line-height: 1.23; color: ${T.ink}; font-variant-numeric: tabular-nums; }

.ir-set-seg {
  flex: none; display: flex; gap: 2px; height: 36px; padding: 3px;
  background: ${T.ground}; border: 1px solid ${T.hairline}; border-radius: ${T.rMd};
}
.ir-set-seg-opt {
  flex: none; width: 60px; padding: 0; border: 0; border-radius: ${T.rSm}; background: transparent;
  color: ${T.ink2}; font-size: 13px; line-height: 1.23; white-space: nowrap;
  transition: background-color 160ms ease-out, color 160ms ease-out;
}
.ir-set-seg-opt:hover { color: ${T.ink}; }
.ir-set-seg-opt[aria-checked="true"] { background: ${T.surface3}; color: ${T.ink}; }

.ir-set-field {
  flex: none; width: 240px; max-width: 100%; height: 38px; padding: 0 12px; display: flex; align-items: center; gap: 8px;
  background: ${T.ground}; border: 1px solid ${T.hairline}; border-radius: ${T.rMd};
}
.ir-set-field:has(.ir-set-text:focus-visible) { outline: 2px solid ${T.focus}; outline-offset: 2px; }
.ir-set-text {
  flex: 1 1 auto; min-width: 0; height: 100%; padding: 0; border: 0; background: transparent;
  color: ${T.ink}; font-size: 14px; line-height: 1.21;
}
.ir-set-overlay .ir-set-text:focus-visible { outline: none; }
.ir-set-text::placeholder { color: ${T.ink3}; }
.ir-set-count { flex: none; font-size: 12px; line-height: 1.17; color: ${T.ink3}; font-variant-numeric: tabular-nums; }

/* controls */
.ir-set-khead { display: flex; align-items: center; }
.ir-set-khead-t { flex: 1 1 0; min-width: 0; font-size: 13px; line-height: 1.23; font-weight: 600; }
.ir-set-khead-c { flex: none; width: 120px; font-size: 12px; line-height: 1.17; color: ${T.ink3}; }
.ir-set-khead-c.is-alt { width: 110px; }
.ir-set-keys { display: flex; flex-direction: column; }
.ir-set-krow { display: flex; align-items: center; min-height: 54px; padding-top: 1px; box-shadow: inset 0 1px 0 ${T.hairline}; }
.ir-set-krow.is-skate { min-height: 48px; padding-top: 0; box-shadow: none; }
.ir-set-keyname { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding-right: 12px; }
.ir-set-keyname-t { font-size: 13px; line-height: 1.23; color: ${T.ink}; }
.ir-set-keyname-h { font-size: 12px; line-height: 1.17; color: ${T.ink3}; }
.ir-set-keyname-w { display: none; align-items: center; gap: 4px; font-size: 12px; line-height: 1.17; color: ${T.ink}; }
.ir-set-keyname-w .ir-set-ico { width: 14px; height: 14px; color: ${T.warn}; }
.ir-set-keyname.is-unbound .ir-set-keyname-h { display: none; }
.ir-set-keyname.is-unbound .ir-set-keyname-w { display: flex; }
.ir-set-kcol { flex: none; min-width: 120px; display: flex; gap: 3px; }
.ir-set-kcol.is-alt { min-width: 110px; }
.ir-set-key {
  flex: none; width: 72px; height: 30px; padding: 0 4px; display: inline-flex; align-items: center; justify-content: center;
  background: ${T.surface3}; border: 1px solid ${T.hairline2}; border-radius: ${T.rSm};
  color: ${T.ink}; font-size: 12px; line-height: 1.17; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: border-color 160ms ease-out, background-color 160ms ease-out;
}
.ir-set-key > span { overflow: hidden; text-overflow: ellipsis; }
.ir-set-key:hover { border-color: ${T.ink3}; }
.ir-set-key.is-mini { width: 24px; padding: 0; }
.ir-set-key.is-mini.is-wide { width: auto; min-width: 24px; padding: 0 5px; }
.ir-set-key.is-empty { background: transparent; border-style: dashed; color: ${T.ink3}; }
.ir-set-key.is-capturing { background: ${T.ground}; border: 1px solid ${T.ink}; color: ${T.ink}; font-size: 11px; line-height: 1.18; }
.ir-set-key.is-capturing:not(.is-mini) { width: 110px; }
.ir-set-key.is-mouse { width: 96px; gap: 6px; }
.ir-set-key.is-mouse svg { flex: none; }
.ir-set-key.is-flash { border-color: ${T.good}; transition: none; }
.ir-set-key svg { display: block; }

.ir-set-status {
  display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 12px; min-width: 0;
  background: transparent; border: 1px solid ${T.hairline}; border-radius: ${T.rMd};
  transition: background-color 160ms ease-out, border-color 160ms ease-out;
}
.ir-set-status:not([data-tone="idle"]) { background: ${T.surface2}; border-color: ${T.hairline2}; }
.ir-set-status .ir-set-ico { color: ${T.ink2}; }
.ir-set-status[data-tone="capture"] .ir-set-ico { color: ${T.ink}; }
.ir-set-status[data-tone="ok"] .ir-set-ico { color: ${T.good}; }
.ir-set-status[data-tone="warn"] .ir-set-ico { color: ${T.warn}; }
.ir-set-status-msg { flex: 1 1 auto; min-width: 0; font-size: 13px; line-height: 1.23; color: ${T.ink}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ir-set-status[data-tone="idle"] .ir-set-status-msg { color: ${T.ink2}; }
.ir-set-status-aside { flex: none; font-size: 12px; line-height: 1.17; color: ${T.ink3}; white-space: nowrap; }
.ir-set-div { flex: none; height: 1px; background: ${T.hairline}; }
.ir-set-phead { display: flex; align-items: center; justify-content: space-between; }
.ir-set-phead-t { font-size: 13px; line-height: 1.23; font-weight: 600; }
.ir-set-phead-s { font-size: 12px; line-height: 1.17; color: ${T.ink3}; }
.ir-set-pad { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 24px; }
.ir-set-pad li { width: 252px; max-width: 100%; display: flex; align-items: center; gap: 10px; min-height: 26px; }
.ir-set-pad-t { min-width: 0; font-size: 13px; line-height: 1.23; color: ${T.ink2}; }
.ir-set-badge {
  flex: none; display: inline-flex; align-items: center; justify-content: center; height: 26px; width: 26px; border-radius: 13px;
  background: ${T.surface3}; color: ${T.ink}; font-size: 11px; line-height: 1.18; font-weight: 700; white-space: nowrap;
}
.ir-set-badge.is-stick { background: transparent; border: 1px solid ${T.hairline2}; }
.ir-set-badge.is-pill { width: auto; height: 24px; padding: 0 6px; border-radius: ${T.rSm}; }

/* footer */
.ir-set-foot {
  flex: none; height: 80px; padding: 1px 24px 0; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  box-shadow: inset 0 1px 0 ${T.hairline};
}
.ir-set-foot-l { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ir-set-foot-note { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 1.17; color: ${T.ink2}; white-space: nowrap; }
.ir-set-foot-note .ir-set-ico { width: 14px; height: 14px; color: ${T.good}; }
.ir-set-btn {
  flex: none; height: 40px; padding: 0 16px; border-radius: ${T.rMd}; font-size: 14px; line-height: 1.21; white-space: nowrap;
  transition: background-color 160ms ease-out, border-color 160ms ease-out;
}
.ir-set-btn.is-secondary { background: transparent; border: 1px solid ${T.hairline2}; color: ${T.ink}; }
.ir-set-btn.is-secondary:hover { background: ${T.surface2}; }
.ir-set-btn.is-armed {
  background: color-mix(in srgb, ${T.goal} 14%, ${T.surface}); border-color: color-mix(in srgb, ${T.goal} 50%, ${T.surface});
}
.ir-set-btn.is-armed:hover { background: color-mix(in srgb, ${T.goal} 20%, ${T.surface}); }
.ir-set-btn.is-primary {
  padding: 0 28px; background: ${T.ice}; border: 0; color: ${T.onIce}; font-size: 15px; line-height: 1.2; font-weight: 700;
}
.ir-set-btn.is-primary:hover { background: color-mix(in srgb, ${T.ice} 88%, #ffffff); }

.ir-set-calm .ir-set-key.is-flash { border-color: ${T.hairline2}; }
@media (prefers-reduced-motion: reduce) {
  .ir-set-overlay *, .ir-set-overlay *::before, .ir-set-overlay *::after { transition: none !important; animation: none !important; }
}
@container (max-width: 520px) {
  .ir-set-head { padding: 0 16px; }
  .ir-set-tabs { margin: 0 16px; }
  .ir-set-body { padding: 16px; }
  .ir-set-foot { padding: 1px 16px 0; }
  .ir-set-label.is-fixed { width: 104px; }
  .ir-set-row.is-wrap { flex-wrap: wrap; row-gap: 10px; padding-top: 12px; padding-bottom: 12px; }
  .ir-set-row.is-wrap .ir-set-label { flex-basis: 100%; }
  .ir-set-kcol { min-width: 108px; }
  .ir-set-kcol.is-alt { min-width: 104px; }
  .ir-set-khead-c.is-alt { width: 104px; }
  .ir-set-khead-c { width: 108px; }
  .ir-set-status-aside { display: none; }
  .ir-set-foot-note { white-space: normal; }
}
`;

const ICON_X = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_KEYBOARD = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.36" stroke-linejoin="round">'
  + '<path d="M3.2 4 L12.8 4 C13.68 4 14.4 4.72 14.4 5.6 L14.4 10.4 C14.4 11.28 13.68 12 12.8 12 L3.2 12 C2.32 12 1.6 11.28 1.6 10.4 L1.6 5.6 C1.6 4.72 2.32 4 3.2 4 Z"/>'
  + '<path d="M4 6.4 L4.8 6.4 M6.4 6.4 L7.2 6.4 M8.8 6.4 L9.6 6.4 M11.2 6.4 L12 6.4 M4.8 9.6 L11.2 9.6" stroke-linecap="round"/></svg>';
const ICON_WARN = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.44" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M8 2 L14.4 13.2 L1.6 13.2 Z"/><path d="M8 6.4 L8 9.6 M8 11.6 L8 11.68"/></svg>';
const ICON_CHECK = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.54" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 7.35 L5.6 10.15 L11.2 3.85"/></svg>';
// Mouse glyph from the Coqui canvas (12x16, the bound button filled). Shown alone in the 24px skate
// slots and before "Left click" / "Right click" in the 96px action slots.
const MOUSE_FILL = {
  Mouse0: '<path d="M6 0.75A5.25 5.25 0 0 0 0.75 6V6.5H6Z" fill="currentColor" stroke="none"/>',
  Mouse1: '<rect x="5" y="2.6" width="2" height="3.2" rx="1" fill="currentColor" stroke="none"/>',
  Mouse2: '<path d="M6 0.75A5.25 5.25 0 0 1 11.25 6V6.5H6Z" fill="currentColor" stroke="none"/>',
};
const mouseIcon = (code) => '<svg width="12" height="16" viewBox="0 0 12 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">'
  + `${MOUSE_FILL[code] || ''}<rect x="0.75" y="0.75" width="10.5" height="14.5" rx="5.25"/><path d="${code === 'Mouse1' ? 'M0.75 6.5H11.25' : 'M6 0.75V6.5M0.75 6.5H11.25'}"/></svg>`;

function injectStyle(doc) {
  let el = doc.getElementById(STYLE_ID);
  if (!el) {
    el = doc.createElement('style');
    el.id = STYLE_ID;
    el.textContent = PANEL_CSS;
    (doc.head || doc.documentElement).appendChild(el);
  }
  el.dataset.refs = String((Number(el.dataset.refs) || 0) + 1);
}
function releaseStyle(doc) {
  const el = doc.getElementById(STYLE_ID);
  if (!el) return;
  const n = (Number(el.dataset.refs) || 1) - 1;
  if (n <= 0) el.remove(); else el.dataset.refs = String(n);
}

const ACTION_HINTS = {
  shoot: 'Tap wrister, hold slapshot, no puck checks',
  pass: 'No puck switches skater',
  action: 'No puck stick-checks',
  turbo: 'Hold to sprint, add shoot for a big hit',
};
const SKATE_ORDER = ['up', 'left', 'down', 'right'];          // W A S D / up left down right
const MOVE_SET = new Set(SKATE_ORDER);
const TABS = [['audio', 'Audio'], ['video', 'Video'], ['controls', 'Controls'], ['gameplay', 'Gameplay']];
const TAB_KEYS = TABS.map((t) => t[0]);
const IDLE_MSG = 'Click a slot, then press a key or click';
const IDLE_ASIDE = 'Keys in use swap';
const CAPTURE_ASIDE = 'Esc cancels \u00b7 Backspace clears';
const ARM_MS = 3500;

const lc = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const uc = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const isTyping = (el) => !!el && (el.tagName === 'INPUT' && el.type !== 'range' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/**
 * createSettingsPanel(container, settings, { onOpen, onClose }?) -> { open(tab?), close, isOpen, dispose }
 * A 600px full-height sheet sliding in from the right over a 55% scrim.
 *   open(tab)  tab = 'audio' | 'video' | 'controls' | 'gameplay' (optional; default = last tab shown)
 * Also dispatches a bubbling `ir-settings` CustomEvent ({ detail: { open } }) on `container`.
 * container = document.body (full-screen overlay) or any element (overlay fills that element).
 */
export function createSettingsPanel(container, settings, options = {}) {
  const doc = (container && container.ownerDocument) || globalThis.document;
  if (!doc) throw new Error('createSettingsPanel: no DOM available');
  if (!container) container = doc.body;
  if (!settings || typeof settings.get !== 'function' || typeof settings.subscribe !== 'function') {
    throw new Error('createSettingsPanel: a settings store from createSettings() is required');
  }
  const opts = options || {};
  const win = doc.defaultView || globalThis;
  const uid = `ir-set-${++panelSeq}`;
  injectStyle(doc);

  let open_ = false, disposed = false;
  let capture = null;            // { action, slot } while waiting for a key or a click
  let swallowUp = null;          // key code whose keyup must not reach the game after a capture
  let eatMouse = false;          // swallow the click / contextmenu that follows a binding mousedown
  let eatTimer = 0, lastTouchAt = -1e9;
  let lastFocus = null, activeTab = 'audio';
  let statusTimer = 0, armTimer = 0, noteTimer = 0, hideTimer = 0, armed = false;
  const flashTimers = new Set();
  const syncers = [];            // (state) => void, refresh one control from settings

  // --- tiny DOM builder ---
  function h(tag, attrs, ...kids) {
    const el = doc.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;            // static icon markup only
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(typeof kid === 'string' ? doc.createTextNode(kid) : kid);
    }
    return el;
  }
  const icon = (svg) => h('span', { class: 'ir-set-ico', 'aria-hidden': 'true', html: svg });
  const label = (forId, text, sub, extra = '') => h('label', { class: `ir-set-label${extra}`, for: forId },
    h('span', { text }), sub ? h('small', { text: sub }) : null);

  // --- audio / video / gameplay rows ---
  function toggleRow(key, text, sub) {
    const id = `${uid}-${key}`;
    const btn = h('button', { type: 'button', role: 'switch', id, class: 'ir-set-switch', 'aria-checked': 'false' },
      h('span', { class: 'ir-set-knob', 'aria-hidden': 'true' }));
    btn.addEventListener('click', () => settings.set(key, !settings.get(key)));
    syncers.push((s) => btn.setAttribute('aria-checked', s[key] ? 'true' : 'false'));
    return h('div', { class: 'ir-set-row', 'data-key': key }, label(id, text, sub), btn);
  }
  function sliderRow(key, text) {
    const id = `${uid}-${key}`;
    const input = h('input', { type: 'range', id, class: 'ir-set-range', min: 0, max: 100, step: 1 });
    const out = h('output', { class: 'ir-set-val', for: id, 'aria-hidden': 'true' });
    input.addEventListener('input', () => settings.set(key, Number(input.value) / 100));
    syncers.push((s) => {
      const pct = Math.round(s[key] * 100);
      if (Number(input.value) !== pct) input.value = String(pct);
      input.style.setProperty('--p', String(pct / 100));
      input.setAttribute('aria-valuetext', `${pct}%`);
      out.textContent = `${pct}%`;
    });
    return h('div', { class: 'ir-set-row', 'data-key': key }, label(id, text, null, ' is-fixed'),
      h('div', { class: 'ir-set-slider' }, input), out);
  }
  function qualityRow() {
    const lid = `${uid}-quality-label`;
    const optsList = [['auto', 'Auto'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];
    const btns = optsList.map(([v, t]) => {
      const b = h('button', { type: 'button', role: 'radio', class: 'ir-set-seg-opt', 'data-value': v, 'aria-checked': 'false', tabindex: '-1', text: t });
      b.addEventListener('click', () => settings.set('quality', v));
      return b;
    });
    const seg = h('div', { class: 'ir-set-seg', role: 'radiogroup', 'aria-labelledby': lid }, btns);
    seg.addEventListener('keydown', (e) => {
      const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const i = optsList.findIndex(([v]) => v === settings.get('quality'));
      const n = (Math.max(0, i) + dir + optsList.length) % optsList.length;
      settings.set('quality', optsList[n][0]);
      btns[n].focus();
    });
    syncers.push((s) => {
      for (const b of btns) {
        const on = b.dataset.value === s.quality;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
    });
    return h('div', { class: 'ir-set-row is-tall is-wrap', 'data-key': 'quality' },
      h('div', { class: 'ir-set-label', id: lid }, h('span', { text: 'Quality' }), h('small', { text: 'Auto adapts to your device' })),
      seg);
  }
  function nameRow() {
    const id = `${uid}-name`;
    const input = h('input', {
      type: 'text', id, class: 'ir-set-text', maxlength: NAME_MAX, autocomplete: 'off', autocapitalize: 'off',
      spellcheck: 'false', placeholder: 'Skater', enterkeyhint: 'done', 'aria-describedby': `${id}-count`,
    });
    const count = h('span', { class: 'ir-set-count', id: `${id}-count` });
    const recount = () => { count.textContent = `${input.value.length}/${NAME_MAX}`; };
    input.addEventListener('input', () => { settings.set('name', input.value); recount(); });
    input.addEventListener('change', () => { input.value = settings.get('name'); recount(); });
    syncers.push((s) => { if (doc.activeElement !== input) input.value = s.name; recount(); });
    return h('div', { class: 'ir-set-row is-tall is-wrap', 'data-key': 'name' },
      label(id, 'Player name'), h('div', { class: 'ir-set-field' }, input, count));
  }

  // --- controls tab ---
  const keyBtns = {};   // 'action:slot' -> button
  const keyNames = {};  // action -> name cell (the four skate directions share one)
  function slotBtn(action, slot, mini) {
    const b = h('button', { type: 'button', class: `ir-set-key${mini ? ' is-mini' : ''}`, 'data-action': action, 'data-slot': slot });
    b.addEventListener('click', () => { if (!capture) startCapture(action, slot); });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    keyBtns[`${action}:${slot}`] = b;
    return b;
  }
  function nameCell(id, title, hint) {
    return h('div', { class: 'ir-set-keyname', id },
      h('span', { class: 'ir-set-keyname-t', text: title }),
      hint ? h('span', { class: 'ir-set-keyname-h', text: hint }) : null,
      h('span', { class: 'ir-set-keyname-w' }, icon(ICON_WARN), h('span', { class: 'ir-set-keyname-wt', text: 'Not bound' })));
  }
  const skateName = nameCell(`${uid}-k-skate`, 'Skate', null);
  for (const a of SKATE_ORDER) keyNames[a] = skateName;
  const skateRow = h('div', { class: 'ir-set-krow is-skate', 'data-row': 'skate' }, skateName,
    h('div', { class: 'ir-set-kcol' }, SKATE_ORDER.map((a) => slotBtn(a, 0, true))),
    h('div', { class: 'ir-set-kcol is-alt' }, SKATE_ORDER.map((a) => slotBtn(a, 1, true))));
  const actionRows = ['shoot', 'pass', 'action', 'turbo'].map((a) => {
    keyNames[a] = nameCell(`${uid}-k-${a}`, ACTION_LABELS[a], ACTION_HINTS[a]);
    return h('div', { class: 'ir-set-krow', 'data-row': a }, keyNames[a],
      h('div', { class: 'ir-set-kcol' }, slotBtn(a, 0, false)),
      h('div', { class: 'ir-set-kcol is-alt' }, slotBtn(a, 1, false)));
  });

  const statusIco = h('span', { class: 'ir-set-ico', 'aria-hidden': 'true' });
  const statusMsg = h('span', { class: 'ir-set-status-msg' });
  const statusAside = h('span', { class: 'ir-set-status-aside' });
  const statusEl = h('div', { class: 'ir-set-status', role: 'status', 'aria-live': 'polite', 'data-tone': 'idle' }, statusIco, statusMsg, statusAside);

  const padList = h('ul', { class: 'ir-set-pad', 'aria-label': 'Gamepad buttons, fixed layout' },
    GAMEPAD_LAYOUT.map((g) => {
      const shape = g.buttons[0].shape;
      const text = g.buttons.map((b) => b.t).join(' ');
      return h('li', null,
        h('span', { class: `ir-set-badge is-${shape}`, text }),
        h('span', { class: 'ir-set-pad-t', text: g.label }));
    }));

  function slotContent(b, code, cap, mini) {
    b.classList.remove('is-wide');
    b.classList.remove('is-mouse');
    if (cap) { b.textContent = mini ? '\u2026' : 'Press a key or click'; return; }
    if (!code) { b.textContent = '\u2014'; return; }
    if (mini && isMouseCode(code)) { b.innerHTML = mouseIcon(code); return; }
    const t = keyLabel(code);
    if (isMouseCode(code)) { b.classList.add('is-mouse'); b.innerHTML = mouseIcon(code); b.append(h('span', { text: t })); return; }
    if (mini && t.length > 1) b.classList.add('is-wide');
    b.replaceChildren(h('span', { text: t }));
  }
  function syncKeys(s = settings.all()) {
    for (const a of ACTIONS) {
      const list = s.keys[a] || [];
      for (let slot = 0; slot < MAX_SLOTS; slot++) {
        const b = keyBtns[`${a}:${slot}`];
        const code = list[slot];
        const cap = !!capture && capture.action === a && capture.slot === slot;
        const mini = MOVE_SET.has(a);
        slotContent(b, code, cap, mini);
        b.classList.toggle('is-empty', !code && !cap);
        b.classList.toggle('is-capturing', cap);
        b.setAttribute('aria-pressed', cap ? 'true' : 'false');
        b.setAttribute('aria-label', `${ACTION_LABELS[a]}, ${slot ? 'alternate' : 'primary'}: ${cap ? 'press a key or click' : code ? keyLabel(code, true) : 'not bound'}`);
        b.title = cap ? `Press a key or click \u00b7 ${CAPTURE_ASIDE}` : 'Click to change';
      }
    }
    for (const a of ['shoot', 'pass', 'action', 'turbo']) keyNames[a].classList.toggle('is-unbound', !(s.keys[a] || []).length);
    const lost = SKATE_ORDER.filter((a) => !(s.keys[a] || []).length);
    skateName.classList.toggle('is-unbound', lost.length > 0);
    skateName.querySelector('.ir-set-keyname-wt').textContent = lost.length ? `Not bound: ${lost.join(', ')}` : 'Not bound';
  }

  // --- skeleton ---
  const titleId = `${uid}-title`;
  const tabBtns = {}, panes = {};
  const closeBtn = h('button', { type: 'button', class: 'ir-set-x', 'aria-label': 'Close settings', title: 'Close (Esc)', html: ICON_X });
  const tablist = h('div', { class: 'ir-set-tabs', role: 'tablist', 'aria-label': 'Settings sections' },
    TABS.map(([k, t]) => (tabBtns[k] = h('button', {
      type: 'button', role: 'tab', class: 'ir-set-tab', id: `${uid}-tab-${k}`, 'aria-controls': `${uid}-pane-${k}`, 'data-tab': k, text: t,
    }))));
  const pane = (k, ...kids) => (panes[k] = h('section', { class: 'ir-set-pane', role: 'tabpanel', id: `${uid}-pane-${k}`, 'aria-labelledby': `${uid}-tab-${k}`, 'data-pane': k }, ...kids));

  const body = h('div', { class: 'ir-set-body' },
    pane('audio',
      toggleRow('muted', 'Mute all', 'M toggles it anywhere'),
      sliderRow('sfxVolume', 'Sound effects'),
      sliderRow('musicVolume', 'Music'),
      sliderRow('announcerVolume', 'Announcer')),
    pane('video',
      qualityRow(),
      sliderRow('cameraShake', 'Camera shake'),
      toggleRow('reduceFlashes', 'Reduce flashes', 'Softer goal lights and hit flashes'),
      toggleRow('showNames', 'Name tags over players'),
      toggleRow('puckCam', 'Puck cam on goal replays', 'Ride with the puck instead of the goal cam')),
    pane('controls',
      h('div', { class: 'ir-set-khead', 'aria-hidden': 'true' },
        h('span', { class: 'ir-set-khead-t', text: 'Keyboard and mouse' }),
        h('span', { class: 'ir-set-khead-c', text: 'Primary' }),
        h('span', { class: 'ir-set-khead-c is-alt', text: 'Alternate' })),
      h('div', { class: 'ir-set-keys', role: 'group', 'aria-label': 'Keyboard and mouse bindings' }, skateRow, actionRows),
      statusEl,
      h('div', { class: 'ir-set-div' }),
      h('div', { class: 'ir-set-phead' }, h('span', { class: 'ir-set-phead-t', text: 'Gamepad' }), h('span', { class: 'ir-set-phead-s', text: 'Fixed layout' })),
      padList),
    pane('gameplay',
      toggleRow('showTutorial', 'Tutorial hints', 'Tips for shooting, passing and checking'),
      nameRow()));

  const resetAllBtn = h('button', { type: 'button', class: 'ir-set-btn is-secondary', 'data-act': 'reset-all', text: 'Reset all' });
  const footNote = h('span', { class: 'ir-set-foot-note', 'aria-live': 'polite' });
  const doneBtn = h('button', { type: 'button', class: 'ir-set-btn is-primary', 'data-act': 'done', text: 'Done' });
  const dialog = h('div', { class: 'ir-set-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('header', { class: 'ir-set-head' },
      h('h2', { class: 'ir-set-title', id: titleId, text: 'Settings' }),
      h('div', { class: 'ir-set-head-r' }, h('span', { class: 'ir-set-esc', 'aria-hidden': 'true', text: 'Esc' }), closeBtn)),
    tablist, body,
    h('footer', { class: 'ir-set-foot' }, h('div', { class: 'ir-set-foot-l' }, resetAllBtn, footNote), doneBtn));
  const scrim = h('div', { class: 'ir-set-scrim', 'aria-hidden': 'true' });
  const overlay = h('div', { class: 'ir-set-overlay', hidden: true }, scrim, dialog);
  if (container !== doc.body && container !== doc.documentElement) {
    overlay.classList.add('ir-set-local');
    try { if (win.getComputedStyle(container).position === 'static') container.style.position = 'relative'; } catch { /* ignore */ }
  }
  container.appendChild(overlay);

  // --- status line (controls tab) ---
  function setStatus(tone, msg, aside = '') {
    statusEl.dataset.tone = tone;
    statusIco.innerHTML = tone === 'ok' ? ICON_CHECK : tone === 'warn' ? ICON_WARN : ICON_KEYBOARD;
    statusMsg.textContent = msg;
    statusMsg.title = msg;
    statusAside.textContent = aside;
  }
  const idle = () => { clearTimeout(statusTimer); setStatus('idle', IDLE_MSG, IDLE_ASIDE); };
  function say(msg, tone = 'info') {
    clearTimeout(statusTimer);
    setStatus(tone, msg);
    statusTimer = setTimeout(idle, 5000);
  }
  idle();

  // --- rebinding ---
  function flash(action, code) {
    if (!code) return;
    const i = (settings.get('keys')[action] || []).indexOf(code);
    const b = keyBtns[`${action}:${i}`];
    if (!b) return;
    b.classList.add('is-flash');
    const t = setTimeout(() => { b.classList.remove('is-flash'); flashTimers.delete(t); }, 700);
    flashTimers.add(t);
  }
  function startCapture(action, slot) {
    capture = { action, slot };
    clearTimeout(statusTimer);
    syncKeys();
    setStatus('capture', `Press a key or click for ${lc(ACTION_LABELS[action])}`, CAPTURE_ASIDE);
  }
  function cancelCapture(msg) {
    if (!capture) return;
    capture = null;
    syncKeys();
    if (msg) say(msg, 'info'); else idle();
  }
  const word = (code) => (isMouseCode(code) ? lc(keyLabel(code)) : keyLabel(code));
  function applyCapture(code) {
    const { action, slot } = capture;
    capture = null;
    const before = settings.get('keys')[action] || [];
    const r = rebindKeys(settings.get('keys'), action, slot, code);
    const name = lc(ACTION_LABELS[action]);
    if (r.error) {
      say(r.error === 'reserved' ? 'Esc is kept for menus' : "That key can't be bound", 'warn');
    } else if (!r.changed) {
      say(code === null ? 'That slot is already empty' : `${uc(name)} already uses ${word(code)}`, 'info');
    } else {
      settings.set('keys', r.keys);
      let msg;
      if (code === null) msg = `Cleared ${word(before[slot])} from ${name}`;
      else if (r.swap && r.swap.action === action) msg = `Swapped primary and alternate for ${name}`;
      else if (r.swap && r.swap.code) msg = `Bound ${word(code)} to ${name} and moved ${word(r.swap.code)} to ${lc(ACTION_LABELS[r.swap.action])}`;
      else if (r.swap) msg = `Bound ${word(code)} to ${name}, taken from ${lc(ACTION_LABELS[r.swap.action])}`;
      else msg = `Bound ${word(code)} to ${name}`;
      if (r.unbound.length) {
        const list = r.unbound.map((a) => lc(ACTION_LABELS[a])).join(', ');
        msg += `. ${uc(list)} ${r.unbound.length > 1 ? 'have' : 'has'} no key now`;
      }
      say(msg, r.unbound.length ? 'warn' : 'ok');
      flash(action, code);
      if (r.swap) flash(r.swap.action, r.swap.code);
    }
    syncKeys();
  }

  // --- tabs ---
  function selectTab(k, focus) {
    if (!tabBtns[k]) k = 'audio';
    if (k !== activeTab) cancelCapture();
    activeTab = k;
    for (const [name, b] of Object.entries(tabBtns)) {
      const on = name === k;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      panes[name].hidden = !on;
    }
    body.scrollTop = 0;
    if (focus) tabBtns[k].focus();
  }
  tablist.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) selectTab(b.dataset.tab, true);
  });
  tablist.addEventListener('keydown', (e) => {
    let i = TAB_KEYS.indexOf(activeTab);
    if (e.key === 'ArrowRight') i = (i + 1) % TAB_KEYS.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + TAB_KEYS.length) % TAB_KEYS.length;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = TAB_KEYS.length - 1;
    else return;
    e.preventDefault();
    selectTab(TAB_KEYS[i], true);
  });

  function sync() {
    const s = settings.all();
    for (const fn of syncers) fn(s);
    syncKeys(s);
    for (const k of ['sfxVolume', 'musicVolume', 'announcerVolume']) {
      const row = body.querySelector(`[data-key="${k}"]`);
      if (row) row.classList.toggle('is-dim', s.muted);
    }
    overlay.classList.toggle('ir-set-calm', !!s.reduceFlashes);
  }
  const unsubscribe = settings.subscribe(() => { if (!disposed) sync(); });

  // --- footer ---
  function disarm() {
    clearTimeout(armTimer);
    armed = false;
    resetAllBtn.classList.remove('is-armed');
    resetAllBtn.textContent = 'Reset all';
    if (footNote.dataset.kind === 'arm') { footNote.textContent = ''; footNote.dataset.kind = ''; }
  }
  resetAllBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      clearTimeout(noteTimer);
      resetAllBtn.classList.add('is-armed');
      resetAllBtn.textContent = 'Confirm reset';
      footNote.dataset.kind = 'arm';
      footNote.replaceChildren(doc.createTextNode('Your name is kept'));
      armTimer = setTimeout(disarm, ARM_MS);
      return;
    }
    disarm();
    cancelCapture();
    for (const k of FIELD_KEYS) if (k !== 'name') settings.set(k, DEFAULTS[k]);
    footNote.dataset.kind = 'done';
    footNote.replaceChildren(icon(ICON_CHECK), doc.createTextNode('Settings reset'));
    say('All settings are back to defaults', 'ok');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { if (footNote.dataset.kind === 'done') { footNote.textContent = ''; footNote.dataset.kind = ''; } }, 2500);
  });
  closeBtn.addEventListener('click', () => close());
  doneBtn.addEventListener('click', () => close());
  scrim.addEventListener('click', () => close());
  // Keep game input (window-level listeners) from seeing keys typed inside the sheet. keyup is left
  // alone so a key held when the sheet opened is still released in the game.
  overlay.addEventListener('keydown', (e) => e.stopPropagation());

  // --- window listeners while open ---
  function focusables() {
    return [...dialog.querySelectorAll('button, input, [tabindex]')].filter((el) =>
      !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden]') && el.getClientRects().length > 0);
  }
  function swallow(e) { e.preventDefault(); e.stopImmediatePropagation(); }
  function onKeyDown(e) {   // window, capture phase
    if (capture) {
      swallow(e);
      if (e.repeat) return;
      const code = e.code;
      if (code === 'Escape') { cancelCapture('Rebind cancelled'); return; }
      if (!code) return;    // unidentified key (IME, some virtual keyboards)
      swallowUp = code;
      applyCapture(code === 'Backspace' || code === 'Delete' ? null : code);
      return;
    }
    if (e.code === 'Escape' || e.key === 'Escape') { swallow(e); close(); return; }
    if (e.code === 'KeyM' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
      swallow(e);
      settings.set('muted', !settings.get('muted'));
      return;
    }
    if (e.key === 'Tab') {
      const els = focusables();
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1], act = doc.activeElement;
      if (!dialog.contains(act)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
    }
  }
  function onKeyUp(e) {
    if (swallowUp && e.code === swallowUp) { swallow(e); swallowUp = null; }
  }
  // Mouse buttons bind while a slot is capturing. The click that started the capture already
  // happened, so the next mousedown is the one that binds; its click / contextmenu are eaten.
  function onPointerDown(e) {
    if (e.pointerType !== 'touch') return;
    lastTouchAt = Date.now();
    if (capture) cancelCapture('Rebind cancelled');   // no mouse on a tap
  }
  function onMouseDown(e) {
    if (!capture) { eatMouse = false; clearTimeout(eatTimer); return; }
    swallow(e);
    if ((e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) || Date.now() - lastTouchAt < 1000) return;
    const code = MOUSE_CODES[e.button];
    if (!code) return;              // back / forward buttons: keep waiting
    eatMouse = true;
    clearTimeout(eatTimer);
    applyCapture(code);
  }
  function onMouseUp(e) {
    if (!eatMouse) return;
    swallow(e);
    clearTimeout(eatTimer);
    eatTimer = setTimeout(() => { eatMouse = false; }, 400);   // contextmenu fires after mouseup on Windows
  }
  function onEat(e) {             // click, auxclick, contextmenu
    if (capture || eatMouse) swallow(e);
  }
  function onFocusIn(e) {
    if (open_ && !overlay.contains(e.target)) {
      const els = focusables();
      if (els.length) els[0].focus();
    }
  }
  function onBlur() { cancelCapture(); }

  const WIN_EVENTS = [['keydown', onKeyDown], ['keyup', onKeyUp], ['pointerdown', onPointerDown], ['mousedown', onMouseDown],
    ['mouseup', onMouseUp], ['click', onEat], ['auxclick', onEat], ['contextmenu', onEat]];
  function listen(on) {
    for (const [type, fn] of WIN_EVENTS) win[on ? 'addEventListener' : 'removeEventListener'](type, fn, true);
    win[on ? 'addEventListener' : 'removeEventListener']('blur', onBlur);
    doc[on ? 'addEventListener' : 'removeEventListener']('focusin', onFocusIn);
  }

  function notify(isOpen) {
    try { container.dispatchEvent(new win.CustomEvent('ir-settings', { bubbles: true, detail: { open: isOpen } })); } catch { /* ignore */ }
    const cb = isOpen ? opts.onOpen : opts.onClose;
    if (typeof cb === 'function') { try { cb(); } catch (err) { console.error(err); } }
  }
  function reducedMotion() {
    try { return !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
  }
  /** open(tab?) - tab: 'audio' | 'video' | 'controls' | 'gameplay'. Switches tab when already open. */
  function open(tab) {
    if (disposed) return;
    const want = TAB_KEYS.includes(tab) ? tab : null;
    if (open_) { if (want) selectTab(want, true); return; }
    open_ = true;
    if (want) activeTab = want;
    clearTimeout(hideTimer);
    lastFocus = doc.activeElement;
    sync();
    idle();
    overlay.classList.remove('is-closing', 'is-open');
    overlay.hidden = false;
    void overlay.offsetWidth;          // start the slide from the closed position
    overlay.classList.add('is-open');
    listen(true);
    selectTab(activeTab, true);
    notify(true);
  }
  function close() {
    if (!open_) return;
    open_ = false;
    capture = null;
    swallowUp = null;
    disarm();
    clearTimeout(statusTimer);
    syncKeys();
    listen(false);
    eatMouse = false;
    overlay.classList.remove('is-open');
    clearTimeout(hideTimer);
    if (reducedMotion()) overlay.hidden = true;
    else {
      overlay.classList.add('is-closing');
      hideTimer = setTimeout(() => { overlay.hidden = true; overlay.classList.remove('is-closing'); }, 130);
    }
    const back = lastFocus;
    lastFocus = null;
    if (back && back.isConnected && typeof back.focus === 'function' && back !== doc.body) {
      try { back.focus({ preventScroll: true }); } catch { /* ignore */ }
    } else if (overlay.contains(doc.activeElement)) {
      try { doc.activeElement.blur(); } catch { /* ignore */ }
    }
    notify(false);
  }
  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    unsubscribe();
    for (const t of [statusTimer, armTimer, noteTimer, hideTimer, eatTimer]) clearTimeout(t);
    for (const t of flashTimers) clearTimeout(t);
    flashTimers.clear();
    overlay.remove();
    releaseStyle(doc);
  }

  selectTab(activeTab, false);
  sync();
  return { open, close, isOpen: () => open_, dispose };
}
