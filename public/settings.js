// ICE RIOT - player settings.
//
//   createSettings()       persisted + validated settings store (localStorage; works with no storage,
//                          throwing storage, or a fake storage for tests) with change subscriptions and
//                          a reverse key lookup for input handling.
//   createSettingsPanel()  in-game settings overlay: Audio / Video / Controls / Gameplay.
//   rebindKeys()           pure key-rebinding helper (conflicts swap bindings).
//
// Everything above the "PANEL" banner is pure (no DOM, no imports) so it runs under Node for tests.

export const SETTINGS_VERSION = 1;
export const STORAGE_KEY = 'iceRiot.settings';
export const MAX_SLOTS = 2;            // key slots per action (primary + alternate)
export const NAME_MAX = 16;            // matches the server's hello.name limit

export const ACTIONS = Object.freeze(['up', 'down', 'left', 'right', 'shoot', 'pass', 'action', 'turbo']);
export const ACTION_LABELS = Object.freeze({
  up: 'Move up', down: 'Move down', left: 'Move left', right: 'Move right',
  shoot: 'Shoot / Check', pass: 'Pass / Switch', action: 'Deke / Poke', turbo: 'Turbo',
});
export const QUALITY_LEVELS = Object.freeze(['auto', 'high', 'medium', 'low']);
// Codes that can never be bound: Escape cancels a rebind and opens/closes menus.
export const RESERVED_CODES = Object.freeze(['Escape']);

// Gamepad mapping is fixed (standard mapping, see public/input.js). Shown read-only in the panel.
export const GAMEPAD_LAYOUT = deepFreeze([
  { buttons: [{ t: 'L', shape: 'stick' }], label: 'Move', sub: 'Left stick or D-pad' },
  { buttons: [{ t: 'A', shape: 'round' }], label: 'Shoot / Check', sub: 'Hold to charge a slapshot' },
  { buttons: [{ t: 'X', shape: 'round' }], label: 'Pass / Switch', sub: 'No puck: switch skater' },
  { buttons: [{ t: 'B', shape: 'round' }], label: 'Deke / Poke', sub: 'No puck: stick check' },
  { buttons: [{ t: 'RB', shape: 'pill' }, { t: 'RT', shape: 'pill' }, { t: 'LT', shape: 'pill' }], label: 'Turbo', sub: 'Hold to sprint' },
]);

export const DEFAULTS = deepFreeze({
  version: 1,
  sfxVolume: 0.8, musicVolume: 0.45, announcerVolume: 0.9, announcer: true, muted: false,
  quality: 'auto',            // 'auto' | 'high' | 'medium' | 'low'
  cameraShake: 1.0,           // 0..1
  showNames: true, showTutorial: true, reduceFlashes: false,
  keys: { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
          shoot: ['KeyJ', 'Space'], pass: ['KeyK'], action: ['KeyL'], turbo: ['ShiftLeft', 'ShiftRight'] },
  name: '',
});

const FIELD_KEYS = Object.keys(DEFAULTS).filter((k) => k !== 'version');
const UNIT_FIELDS = new Set(['sfxVolume', 'musicVolume', 'announcerVolume', 'cameraShake']);
const BOOL_FIELDS = new Set(['announcer', 'muted', 'showNames', 'showTutorial', 'reduceFlashes']);

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

// ---------------------------------------------------------------------------------------------
// Validation. Each validator returns the cleaned value, or undefined when the input is unusable
// (the caller then keeps the current value on set(), or the default on load).

/** True if `code` is a KeyboardEvent.code-shaped string that may be bound to an action. */
export function isBindableCode(code) {
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(code) && !RESERVED_CODES.includes(code);
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
        const alt = DEFAULTS.keys[a][1];       // keep the v1 alternate key when it doesn't collide
        keys[a] = alt && alt !== c ? [c, alt] : [c];
      }
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

const KEY_SHORT = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Bksp', CapsLock: 'Caps',
  ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
  AltLeft: 'L-Alt', AltRight: 'R-Alt', MetaLeft: 'L-Meta', MetaRight: 'R-Meta', ContextMenu: 'Menu',
  ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlBackslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .', NumpadEnter: 'Num Ent',
};
const KEY_LONG = {
  ArrowUp: 'Up arrow', ArrowDown: 'Down arrow', ArrowLeft: 'Left arrow', ArrowRight: 'Right arrow',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left Meta', MetaRight: 'Right Meta', Backspace: 'Backspace',
};

/** Human label for a KeyboardEvent.code: 'KeyW' -> 'W', 'ArrowUp' -> '\u2191' (long: 'Up arrow'). */
export function keyLabel(code, long = false) {
  if (typeof code !== 'string' || !code) return long ? 'none' : '\u2014';
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
    /** KeyboardEvent.code -> 'up'|'down'|'left'|'right'|'shoot'|'pass'|'action'|'turbo'|null */
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

const PANEL_CSS = `
.ir-set-overlay {
  --ir-fg: #eef4ff;
  --ir-muted: #8ea2c4;
  --ir-line: rgba(130, 196, 255, 0.22);
  --ir-ice: #5ad2ff;
  --ir-hot: #ff5a1f;
  --ir-hot2: #ff2d6f;
  --ir-good: #44f0a0;
  --ir-warn: #ffcf3f;
  --ir-panel-a: rgba(26, 36, 64, 0.95);
  --ir-panel-b: rgba(9, 12, 23, 0.96);
  --ir-key-a: #26345a;
  --ir-key-b: #18213b;
  --ir-track: rgba(255, 255, 255, 0.1);
  --ir-font: "Bahnschrift SemiCondensed", "Bahnschrift Condensed", Bahnschrift, "Roboto Condensed",
             "Arial Narrow", "Helvetica Neue", "Segoe UI", Arial, sans-serif;
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  padding: 12px;
  background: radial-gradient(120% 90% at 50% 35%, rgba(12, 22, 44, 0.5) 0%, rgba(2, 4, 10, 0.86) 100%);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  color: var(--ir-fg);
  font-family: var(--ir-font); font-stretch: condensed; font-size: 16px; line-height: 1.2;
  letter-spacing: normal; text-transform: none; text-align: left;
  -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent;
  box-sizing: border-box;
}
.ir-set-overlay.ir-set-local { position: absolute; }
.ir-set-overlay *, .ir-set-overlay *::before, .ir-set-overlay *::after { box-sizing: border-box; }
.ir-set-overlay[hidden], .ir-set-overlay [hidden] { display: none !important; }
.ir-set-overlay button, .ir-set-overlay input, .ir-set-overlay output {
  font-family: inherit; font-stretch: inherit; color: inherit; margin: 0; line-height: inherit;
}
.ir-set-overlay :focus { outline: none; }
.ir-set-overlay :focus-visible { outline: 2px solid var(--ir-ice); outline-offset: 2px; }

.ir-set-dialog {
  position: relative; container-type: inline-size;
  width: min(860px, 100%); min-width: 0; max-height: 100%;
  display: flex; flex-direction: column;
  background:
    linear-gradient(115deg, transparent 0 62%, rgba(90, 210, 255, 0.05) 62% 70%, transparent 70%),
    linear-gradient(170deg, var(--ir-panel-a) 0%, var(--ir-panel-b) 60%);
  border: 1px solid var(--ir-line);
  clip-path: polygon(24px 0, 100% 0, 100% calc(100% - 24px), calc(100% - 24px) 100%, 0 100%, 0 24px);
  animation: ir-set-in 0.18s ease-out;
}
.ir-set-dialog::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 4px;
  background: linear-gradient(90deg, var(--ir-hot) 0%, var(--ir-hot2) 45%, var(--ir-ice) 100%);
}
.ir-set-head {
  position: relative; display: flex; align-items: flex-end; justify-content: space-between; gap: 12px;
  padding: 18px 20px 12px 34px;
}
.ir-set-head::after {
  content: ''; position: absolute; right: 78px; top: 18px; width: 120px; height: 36px; pointer-events: none;
  background: repeating-linear-gradient(115deg, rgba(255, 90, 31, 0.5) 0 6px, transparent 6px 14px);
  -webkit-mask: linear-gradient(90deg, transparent, #000); mask: linear-gradient(90deg, transparent, #000);
}
.ir-set-kicker {
  display: block; font-size: 12px; font-weight: 700; letter-spacing: 0.34em; color: var(--ir-ice);
  text-transform: uppercase; margin: 0 0 2px 2px;
}
.ir-set-title {
  margin: 0; font-size: 40px; line-height: 0.92; font-weight: 800; font-style: italic;
  letter-spacing: 0.03em; text-transform: uppercase;
  transform: skewX(-8deg); transform-origin: left bottom;
  color: #fff; text-shadow: 3px 3px 0 var(--ir-hot2), 6px 6px 0 rgba(0, 0, 0, 0.35);
}
.ir-set-x {
  position: relative; z-index: 1; flex: none; width: 42px; height: 42px; padding: 0; cursor: pointer;
  display: grid; place-items: center; font-size: 20px; font-weight: 700;
  background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 0;
  transform: skewX(-12deg);
}
.ir-set-x > span { transform: skewX(12deg); }
.ir-set-x:hover { border-color: var(--ir-hot); color: #fff; background: rgba(255, 90, 31, 0.18); }

.ir-set-tabs {
  display: flex; gap: 6px; padding: 0 20px 0 34px; border-bottom: 2px solid var(--ir-line);
  overflow-x: auto; scrollbar-width: none;
}
.ir-set-tabs::-webkit-scrollbar { display: none; }
.ir-set-tab {
  flex: 0 0 auto; margin: 0 0 -2px; padding: 10px 20px 9px; cursor: pointer;
  font-size: 17px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ir-muted); background: transparent; border: 0; border-bottom: 2px solid transparent; border-radius: 0;
  transform: skewX(-14deg);
}
.ir-set-tab > span { display: inline-block; transform: skewX(14deg); }
.ir-set-tab:hover { color: var(--ir-fg); background: rgba(255, 255, 255, 0.05); }
.ir-set-tab[aria-selected="true"] {
  color: #fff; background: linear-gradient(90deg, var(--ir-hot), var(--ir-hot2));
  border-bottom-color: var(--ir-warn); text-shadow: 0 1px 0 rgba(0, 0, 0, 0.35);
}
.ir-set-tab:focus-visible { outline-offset: -3px; outline-color: #fff; }

.ir-set-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 10px 20px 6px 34px;
  scrollbar-width: thin; scrollbar-color: rgba(130, 196, 255, 0.35) transparent;
}
.ir-set-sub {
  display: flex; align-items: center; gap: 10px; margin: 10px 0 4px;
  font-size: 12px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--ir-ice);
}
.ir-set-sub::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, var(--ir-line), transparent); }
.ir-set-sub em { font-style: normal; color: var(--ir-muted); letter-spacing: 0.18em; }
.ir-set-row {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); align-items: center; gap: 6px 22px;
  padding: 11px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  transition: opacity 0.15s;
}
.ir-set-row:last-child { border-bottom: 0; }
.ir-set-row.is-dim { opacity: 0.45; }
.ir-set-label { font-size: 18px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.ir-set-label small {
  display: block; margin-top: 2px; font-size: 13px; font-weight: 400; letter-spacing: 0.02em;
  text-transform: none; color: var(--ir-muted);
}
.ir-set-ctl { display: flex; align-items: center; gap: 14px; min-width: 0; }

.ir-set-range {
  -webkit-appearance: none; appearance: none; flex: 1 1 auto; min-width: 0; height: 30px;
  background: transparent; cursor: pointer; --fill: 50%;
}
.ir-set-range::-webkit-slider-runnable-track {
  height: 8px; border: 0;
  background: linear-gradient(90deg, transparent var(--fill), var(--ir-track) var(--fill)),
              linear-gradient(90deg, var(--ir-ice), var(--ir-hot2));
  transform: skewX(-20deg);
}
.ir-set-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 14px; height: 26px; margin-top: -9px;
  background: #fff; border: 2px solid #0a0e1a; border-radius: 0;
  box-shadow: 0 0 0 2px var(--ir-hot2), 0 2px 8px rgba(0, 0, 0, 0.6);
}
.ir-set-range::-moz-range-track { height: 8px; background: var(--ir-track); border: 0; }
.ir-set-range::-moz-range-progress { height: 8px; background: linear-gradient(90deg, var(--ir-ice), var(--ir-hot2)); }
.ir-set-range::-moz-range-thumb {
  width: 12px; height: 24px; background: #fff; border: 2px solid #0a0e1a; border-radius: 0;
  box-shadow: 0 0 0 2px var(--ir-hot2);
}
.ir-set-range:focus-visible { outline-offset: 4px; }
.ir-set-val {
  flex: none; min-width: 54px; text-align: right; font-size: 20px; font-weight: 700;
  font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
}

.ir-set-switch { position: relative; display: inline-flex; align-items: center; gap: 12px; }
.ir-set-switch input {
  position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; z-index: 1;
}
.ir-set-switch-track {
  position: relative; display: block; width: 60px; height: 28px; flex: none;
  background: #19223b; border: 1px solid rgba(255, 255, 255, 0.16);
  transform: skewX(-14deg); transition: background 0.15s, border-color 0.15s;
}
.ir-set-switch-knob {
  position: absolute; top: 3px; left: 3px; width: 24px; height: 20px; background: var(--ir-muted);
  transition: transform 0.15s, background 0.15s;
}
.ir-set-switch-text {
  min-width: 34px; font-size: 15px; font-weight: 700; letter-spacing: 0.16em; color: var(--ir-muted);
}
.ir-set-switch-text::after { content: 'OFF'; }
.ir-set-switch input:checked + .ir-set-switch-track {
  background: linear-gradient(90deg, var(--ir-hot), var(--ir-hot2)); border-color: transparent;
}
.ir-set-switch input:checked + .ir-set-switch-track .ir-set-switch-knob { transform: translateX(30px); background: #fff; }
.ir-set-switch input:checked ~ .ir-set-switch-text { color: var(--ir-fg); }
.ir-set-switch input:checked ~ .ir-set-switch-text::after { content: 'ON'; }
.ir-set-switch input:focus-visible + .ir-set-switch-track { outline: 2px solid var(--ir-ice); outline-offset: 3px; }

.ir-set-seg {
  display: flex; max-width: 100%; border: 1px solid rgba(255, 255, 255, 0.16); transform: skewX(-14deg);
  margin-left: 4px;
}
.ir-set-seg-opt { position: relative; flex: 1 1 0; min-width: 0; }
.ir-set-seg-opt + .ir-set-seg-opt { border-left: 1px solid rgba(255, 255, 255, 0.12); }
.ir-set-seg-opt input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
.ir-set-seg-face { display: block; padding: 7px 14px; text-align: center; color: var(--ir-muted); transition: background 0.12s; }
.ir-set-seg-txt {
  display: inline-block; transform: skewX(14deg); font-size: 15px; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; white-space: nowrap;
}
.ir-set-seg-opt:hover .ir-set-seg-face { color: var(--ir-fg); background: rgba(255, 255, 255, 0.05); }
.ir-set-seg-opt input:checked + .ir-set-seg-face { color: #fff; background: linear-gradient(90deg, var(--ir-hot), var(--ir-hot2)); }
.ir-set-seg-opt input:focus-visible + .ir-set-seg-face { outline: 2px solid var(--ir-ice); outline-offset: -3px; }

.ir-set-text {
  width: 100%; max-width: 280px; height: 40px; padding: 0 12px;
  font-size: 19px; font-weight: 700; letter-spacing: 0.05em;
  background: rgba(4, 7, 15, 0.7); border: 1px solid rgba(255, 255, 255, 0.18); border-bottom: 2px solid var(--ir-ice);
  border-radius: 0;
}
.ir-set-text::placeholder { color: rgba(142, 162, 196, 0.6); }
.ir-set-text:focus-visible { outline-offset: 1px; }

.ir-set-controls { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr); gap: 4px 28px; align-items: start; }
.ir-set-hint { margin: 2px 0 8px; font-size: 13px; color: var(--ir-muted); letter-spacing: 0.02em; }
.ir-set-hint kbd {
  font: inherit; font-weight: 700; color: var(--ir-fg); padding: 0 5px; border: 1px solid rgba(255, 255, 255, 0.22);
  border-bottom-width: 2px; border-radius: 3px;
}
.ir-set-keys {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(76px, 104px) minmax(76px, 104px);
  gap: 6px 8px; align-items: center;
}
.ir-set-keyhead { font-size: 11px; font-weight: 700; letter-spacing: 0.26em; text-transform: uppercase; color: var(--ir-muted); }
.ir-set-keyname { min-width: 0; font-size: 16px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.ir-set-keyname small {
  display: block; font-size: 12px; font-weight: 400; letter-spacing: 0.01em; text-transform: none; color: var(--ir-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ir-set-keyname.is-unbound { color: var(--ir-hot); }
.ir-set-keyname.is-unbound::after {
  content: 'UNBOUND'; display: inline-block; margin-left: 8px; padding: 1px 5px; font-size: 10px; letter-spacing: 0.16em;
  color: #0a0e1a; background: var(--ir-hot); vertical-align: 2px;
}
.ir-set-key {
  height: 36px; min-width: 0; padding: 0 8px; cursor: pointer;
  font-size: 16px; font-weight: 700; letter-spacing: 0.05em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: #fff; background: linear-gradient(180deg, var(--ir-key-a), var(--ir-key-b));
  border: 1px solid rgba(255, 255, 255, 0.18); border-bottom: 3px solid #070a14; border-radius: 3px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
.ir-set-key:hover { border-color: var(--ir-ice); border-bottom-color: #070a14; }
.ir-set-key.is-empty {
  color: var(--ir-muted); background: transparent; border-style: dashed; border-bottom-width: 1px; box-shadow: none;
}
.ir-set-key.is-capturing {
  color: var(--ir-warn); background: rgba(255, 90, 31, 0.16); border: 1px solid var(--ir-hot);
  border-bottom: 3px solid var(--ir-hot); font-size: 13px; letter-spacing: 0.08em;
  animation: ir-set-pulse 0.9s ease-in-out infinite;
}
.ir-set-key.is-flash { animation: ir-set-flash 0.8s ease-out; }
.ir-set-keys-foot { display: flex; justify-content: flex-start; margin: 12px 0 4px; }

.ir-set-pad { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ir-set-pad li {
  display: flex; align-items: center; gap: 10px; padding: 7px 10px;
  background: rgba(255, 255, 255, 0.035); border-left: 3px solid rgba(90, 210, 255, 0.45);
}
.ir-set-pad-btns { display: flex; justify-content: center; gap: 4px; flex: none; min-width: 92px; }
.ir-set-pad-txt { min-width: 0; font-size: 15px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.ir-set-pad-txt small {
  display: block; font-size: 12px; font-weight: 400; letter-spacing: 0.01em; text-transform: none; color: var(--ir-muted);
}
.ir-set-badge {
  display: inline-grid; place-items: center; height: 28px; min-width: 28px; padding: 0 6px;
  font-size: 13px; font-weight: 700; letter-spacing: 0.04em;
  color: var(--ir-fg); border: 2px solid var(--ir-ice); background: rgba(90, 210, 255, 0.08);
}
.ir-set-badge.is-round { width: 28px; padding: 0; border-radius: 50%; }
.ir-set-badge.is-pill { border-radius: 9px; border-color: var(--ir-warn); background: rgba(255, 207, 63, 0.08); }
.ir-set-badge.is-stick { width: 28px; padding: 0; border-radius: 50%; border-style: double; border-width: 4px; }

.ir-set-status {
  min-height: 26px; padding: 5px 20px 3px 34px; font-size: 14px; font-weight: 700; letter-spacing: 0.04em;
  color: var(--ir-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ir-set-status[data-tone="ok"] { color: var(--ir-good); }
.ir-set-status[data-tone="warn"] { color: var(--ir-warn); }
.ir-set-status[data-tone="info"] { color: var(--ir-ice); }
.ir-set-foot {
  display: flex; align-items: center; gap: 12px; padding: 10px 28px 16px 34px; border-top: 1px solid var(--ir-line);
}
.ir-set-foot-hint {
  flex: 1; text-align: center; font-size: 12px; letter-spacing: 0.24em; text-transform: uppercase; color: var(--ir-muted);
}
.ir-set-foot-hint kbd { font: inherit; color: var(--ir-fg); font-weight: 700; }
.ir-set-btn {
  height: 42px; padding: 0 22px; cursor: pointer; flex: none;
  font-size: 17px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
  border: 0; border-radius: 0; transform: skewX(-14deg);
}
.ir-set-btn > span { display: inline-block; transform: skewX(14deg); }
.ir-set-btn-primary {
  color: #fff; background: linear-gradient(90deg, var(--ir-hot), var(--ir-hot2));
  box-shadow: 0 0 22px rgba(255, 45, 111, 0.35); text-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);
}
.ir-set-btn-primary:hover { filter: brightness(1.12); }
.ir-set-btn-ghost { color: var(--ir-fg); background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.24); }
.ir-set-btn-ghost:hover { border-color: var(--ir-ice); background: rgba(90, 210, 255, 0.08); }
.ir-set-btn-ghost.is-armed { color: var(--ir-warn); border-color: var(--ir-hot); background: rgba(255, 90, 31, 0.16); }
.ir-set-btn-sm { height: 34px; padding: 0 16px; font-size: 14px; }

@keyframes ir-set-in { from { opacity: 0; transform: translateY(12px) scale(0.985); } to { opacity: 1; transform: none; } }
@keyframes ir-set-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 90, 31, 0); }
  50% { box-shadow: 0 0 0 4px rgba(255, 90, 31, 0.4); }
}
@keyframes ir-set-flash { 0% { background: var(--ir-good); color: #07120c; } 100% { } }
.ir-set-calm .ir-set-key.is-capturing, .ir-set-calm .ir-set-key.is-flash, .ir-set-calm .ir-set-dialog { animation: none; }
@media (prefers-reduced-motion: reduce) {
  .ir-set-overlay *, .ir-set-overlay *::before, .ir-set-overlay *::after { animation: none !important; transition: none !important; }
}

@container (max-width: 700px) {
  .ir-set-controls { grid-template-columns: minmax(0, 1fr); }
}
@container (max-width: 560px) {
  .ir-set-head { padding: 16px 12px 10px 20px; }
  .ir-set-head::after { right: 62px; width: 70px; top: 16px; height: 30px; }
  .ir-set-title { font-size: 32px; }
  .ir-set-x { width: 38px; height: 38px; }
  .ir-set-tabs { padding: 0 10px 0 14px; gap: 2px; }
  .ir-set-tab { flex: 1 0 auto; padding: 10px 7px 9px; font-size: 14px; letter-spacing: 0.06em; }
  .ir-set-body { padding: 6px 14px 6px 18px; }
  .ir-set-row { grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 10px 0; }
  .ir-set-row.is-inline { grid-template-columns: minmax(0, 1fr) auto; }
  .ir-set-label { font-size: 16px; }
  .ir-set-label small { font-size: 12px; }
  .ir-set-keys { grid-template-columns: minmax(0, 1fr) 84px 84px; gap: 6px; }
  .ir-set-keyname { font-size: 14px; }
  .ir-set-keyname small { white-space: normal; }
  .ir-set-key { font-size: 15px; padding: 0 4px; }
  .ir-set-key.is-capturing { font-size: 11px; letter-spacing: 0.02em; }
  .ir-set-status { padding: 4px 14px 2px 18px; font-size: 13px; white-space: normal; }
  .ir-set-foot { padding: 10px 16px 14px 18px; }
  .ir-set-foot-hint { display: none; }
  .ir-set-foot .ir-set-btn { flex: 1 1 0; padding: 0 10px; font-size: 15px; }
}
`;

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
  shoot: 'Tap wrist shot \u00b7 hold slapshot \u00b7 no puck: check',
  pass: 'No puck: switch skater',
  action: 'No puck: stick check',
  turbo: 'Hold to sprint \u00b7 + Shoot = big hit',
};
const TABS = [['audio', 'Audio'], ['video', 'Video'], ['controls', 'Controls'], ['gameplay', 'Gameplay']];

/**
 * createSettingsPanel(container, settings, { onOpen, onClose }?) -> { open, close, isOpen, dispose }
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
  let capture = null;            // { action, slot } while waiting for a key
  let swallowUp = null;          // code whose keyup must not reach the game after a capture
  let lastFocus = null, activeTab = 'audio';
  let statusTimer = 0, armTimer = 0, armed = false, downOnBackdrop = false;
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
  const label = (forId, text, sub, id) => h(forId ? 'label' : 'div', { class: 'ir-set-label', for: forId, id }, text, sub ? h('small', { text: sub }) : null);

  function sliderRow(key, text, sub) {
    const id = `${uid}-${key}`;
    const input = h('input', { type: 'range', id, class: 'ir-set-range', min: 0, max: 100, step: 1 });
    const out = h('output', { class: 'ir-set-val', for: id, 'aria-hidden': 'true' });
    input.addEventListener('input', () => settings.set(key, Number(input.value) / 100));
    syncers.push((s) => {
      const pct = Math.round(s[key] * 100);
      if (Number(input.value) !== pct) input.value = String(pct);
      input.style.setProperty('--fill', `${pct}%`);
      input.setAttribute('aria-valuetext', `${pct}%`);
      out.textContent = `${pct}%`;
    });
    return h('div', { class: 'ir-set-row', 'data-key': key }, label(id, text, sub), h('div', { class: 'ir-set-ctl' }, input, out));
  }
  function toggleRow(key, text, sub) {
    const id = `${uid}-${key}`;
    const input = h('input', { type: 'checkbox', role: 'switch', id });
    input.addEventListener('change', () => settings.set(key, input.checked));
    syncers.push((s) => { input.checked = !!s[key]; });
    return h('div', { class: 'ir-set-row is-inline', 'data-key': key }, label(id, text, sub),
      h('div', { class: 'ir-set-ctl' },
        h('span', { class: 'ir-set-switch' }, input,
          h('span', { class: 'ir-set-switch-track', 'aria-hidden': 'true' }, h('span', { class: 'ir-set-switch-knob' })),
          h('span', { class: 'ir-set-switch-text', 'aria-hidden': 'true' }))));
  }
  function qualityRow() {
    const lid = `${uid}-quality-label`, name = `${uid}-quality`;
    const radios = [];
    const seg = h('div', { class: 'ir-set-seg', role: 'radiogroup', 'aria-labelledby': lid },
      [['auto', 'Auto'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']].map(([v, t]) => {
        const r = h('input', { type: 'radio', name, value: v, 'aria-label': t });
        r.addEventListener('change', () => { if (r.checked) settings.set('quality', v); });
        radios.push(r);
        return h('label', { class: 'ir-set-seg-opt' }, r, h('span', { class: 'ir-set-seg-face' }, h('span', { class: 'ir-set-seg-txt', text: t })));
      }));
    syncers.push((s) => { for (const r of radios) r.checked = r.value === s.quality; });
    return h('div', { class: 'ir-set-row', 'data-key': 'quality' },
      label(null, 'Quality', 'Auto adapts to your device. Lower = smoother frame rate.', lid), h('div', { class: 'ir-set-ctl' }, seg));
  }
  function nameRow() {
    const id = `${uid}-name`;
    const input = h('input', {
      type: 'text', id, class: 'ir-set-text', maxlength: NAME_MAX, autocomplete: 'off', autocapitalize: 'off',
      spellcheck: 'false', placeholder: 'Skater', enterkeyhint: 'done',
    });
    input.addEventListener('input', () => settings.set('name', input.value));
    input.addEventListener('change', () => { input.value = settings.get('name'); });
    syncers.push((s) => { if (doc.activeElement !== input) input.value = s.name; });
    return h('div', { class: 'ir-set-row', 'data-key': 'name' },
      label(id, 'Player name', `Shown to other players when you join a room (max ${NAME_MAX}).`), h('div', { class: 'ir-set-ctl' }, input));
  }

  // --- controls tab ---
  const keyBtns = {};   // 'action:slot' -> button
  const keyNames = {};  // action -> name cell
  const keyRows = ACTIONS.map((a) => {
    keyNames[a] = h('div', { class: 'ir-set-keyname', id: `${uid}-k-${a}` }, ACTION_LABELS[a], ACTION_HINTS[a] ? h('small', { text: ACTION_HINTS[a] }) : null);
    const btns = [0, 1].map((slot) => {
      const b = h('button', { type: 'button', class: 'ir-set-key', 'data-action': a, 'data-slot': slot });
      b.addEventListener('click', () => {
        if (capture && capture.action === a && capture.slot === slot) { cancelCapture('Rebind cancelled'); return; }
        startCapture(a, slot);
      });
      keyBtns[`${a}:${slot}`] = b;
      return b;
    });
    return [keyNames[a], ...btns];
  });
  const resetKeysBtn = h('button', { type: 'button', class: 'ir-set-btn ir-set-btn-ghost ir-set-btn-sm', 'data-act': 'reset-keys' }, h('span', { text: 'Reset controls' }));
  resetKeysBtn.addEventListener('click', () => {
    cancelCapture();
    settings.set('keys', DEFAULTS.keys);
    say('Controls reset to defaults', 'ok');
  });
  const padList = h('ul', { class: 'ir-set-pad', 'aria-label': 'Gamepad buttons (fixed)' },
    GAMEPAD_LAYOUT.map((g) => h('li', null,
      h('span', { class: 'ir-set-pad-btns', 'aria-hidden': 'true' }, g.buttons.map((b) => h('span', { class: `ir-set-badge is-${b.shape}`, text: b.t }))),
      h('span', { class: 'ir-set-pad-txt' }, `${g.label}`, h('small', { text: `${g.buttons.map((b) => b.t).join(' / ')} \u00b7 ${g.sub}` })))));

  function syncKeys(s = settings.all()) {
    for (const a of ACTIONS) {
      const list = s.keys[a] || [];
      keyNames[a].classList.toggle('is-unbound', list.length === 0);
      for (let slot = 0; slot < MAX_SLOTS; slot++) {
        const b = keyBtns[`${a}:${slot}`];
        const code = list[slot];
        const cap = !!capture && capture.action === a && capture.slot === slot;
        b.textContent = cap ? 'PRESS A KEY\u2026' : keyLabel(code);
        b.classList.toggle('is-empty', !code && !cap);
        b.classList.toggle('is-capturing', cap);
        b.setAttribute('aria-pressed', cap ? 'true' : 'false');
        b.setAttribute('aria-label', `${ACTION_LABELS[a]}, ${slot ? 'alternate' : 'primary'} key: ${cap ? 'waiting for a key' : keyLabel(code, true)}`);
        b.title = cap ? 'Press a key \u00b7 Esc cancels \u00b7 Backspace clears' : 'Click to rebind';
      }
    }
  }

  // --- skeleton ---
  const titleId = `${uid}-title`;
  const tabBtns = {}, panes = {};
  const closeBtn = h('button', { type: 'button', class: 'ir-set-x', 'aria-label': 'Close settings', title: 'Close (Esc)' }, h('span', { 'aria-hidden': 'true', text: '\u2715' }));
  const tablist = h('div', { class: 'ir-set-tabs', role: 'tablist', 'aria-label': 'Settings sections' },
    TABS.map(([k, t]) => (tabBtns[k] = h('button', {
      type: 'button', role: 'tab', class: 'ir-set-tab', id: `${uid}-tab-${k}`, 'aria-controls': `${uid}-pane-${k}`, 'data-tab': k,
    }, h('span', { text: t })))));
  const pane = (k, ...kids) => (panes[k] = h('section', { class: 'ir-set-pane', role: 'tabpanel', id: `${uid}-pane-${k}`, 'aria-labelledby': `${uid}-tab-${k}`, 'data-pane': k }, ...kids));

  const body = h('div', { class: 'ir-set-body' },
    pane('audio',
      toggleRow('muted', 'Mute all', 'Silences effects and music'),
      sliderRow('sfxVolume', 'Sound effects', 'Hits, shots, glass, crowd'),
      sliderRow('musicVolume', 'Music')),
    pane('video',
      qualityRow(),
      sliderRow('cameraShake', 'Camera shake', '0% turns it off'),
      toggleRow('reduceFlashes', 'Reduce flashes', 'Softer goal lights, hit flashes and screen flashes'),
      toggleRow('showNames', 'Show player names', 'Name tags over human-controlled skaters')),
    pane('controls',
      h('div', { class: 'ir-set-controls' },
        h('div', null,
          h('div', { class: 'ir-set-sub' }, 'Keyboard'),
          h('p', { class: 'ir-set-hint' }, 'Click a slot, then press a key. ', h('kbd', { text: 'Esc' }), ' cancels \u00b7 ',
            h('kbd', { text: 'Bksp' }), ' clears. Keys already in use swap.'),
          h('div', { class: 'ir-set-keys', role: 'group', 'aria-label': 'Keyboard bindings' },
            h('span', { class: 'ir-set-keyhead', text: 'Action' }), h('span', { class: 'ir-set-keyhead', text: 'Primary' }),
            h('span', { class: 'ir-set-keyhead', text: 'Alternate' }), keyRows),
          h('div', { class: 'ir-set-keys-foot' }, resetKeysBtn)),
        h('div', null,
          h('div', { class: 'ir-set-sub' }, 'Gamepad ', h('em', { text: '\u00b7 fixed' })),
          padList))),
    pane('gameplay',
      toggleRow('showTutorial', 'Show tutorial hints', 'On-screen tips for shooting, passing and checking'),
      nameRow()));

  const statusEl = h('div', { class: 'ir-set-status', role: 'status', 'aria-live': 'polite' });
  const resetAllBtn = h('button', { type: 'button', class: 'ir-set-btn ir-set-btn-ghost', 'data-act': 'reset-all' }, h('span', { text: 'Reset all' }));
  const doneBtn = h('button', { type: 'button', class: 'ir-set-btn ir-set-btn-primary', 'data-act': 'done' }, h('span', { text: 'Done' }));
  const dialog = h('div', { class: 'ir-set-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('header', { class: 'ir-set-head' },
      h('div', null, h('span', { class: 'ir-set-kicker', text: 'Ice Riot' }), h('h2', { class: 'ir-set-title', id: titleId, text: 'Settings' })),
      closeBtn),
    tablist, body, statusEl,
    h('footer', { class: 'ir-set-foot' }, resetAllBtn,
      h('span', { class: 'ir-set-foot-hint' }, h('kbd', { text: 'Esc' }), ' close \u00b7 ', h('kbd', { text: 'Tab' }), ' move'), doneBtn));
  const overlay = h('div', { class: 'ir-set-overlay', hidden: true }, dialog);
  if (container !== doc.body && container !== doc.documentElement) {
    overlay.classList.add('ir-set-local');
    try { if (win.getComputedStyle(container).position === 'static') container.style.position = 'relative'; } catch { /* ignore */ }
  }
  container.appendChild(overlay);

  // --- behaviour ---
  function say(msg, tone = 'info', sticky = false) {
    clearTimeout(statusTimer);
    statusEl.textContent = msg;
    statusEl.dataset.tone = tone;
    if (!sticky) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 5000);
  }
  function flash(action, code) {
    if (!code) return;
    const i = (settings.get('keys')[action] || []).indexOf(code);
    const b = keyBtns[`${action}:${i}`];
    if (!b) return;
    b.classList.remove('is-flash');
    void b.offsetWidth;  // restart the animation
    b.classList.add('is-flash');
    const t = setTimeout(() => { b.classList.remove('is-flash'); flashTimers.delete(t); }, 900);
    flashTimers.add(t);
  }
  function startCapture(action, slot) {
    capture = { action, slot };
    syncKeys();
    say(`Press a key for ${ACTION_LABELS[action]} (${slot ? 'alternate' : 'primary'}) \u00b7 Esc cancels \u00b7 Backspace clears`, 'info', true);
  }
  function cancelCapture(msg) {
    if (!capture) return;
    capture = null;
    syncKeys();
    if (msg) say(msg, 'info'); else statusEl.textContent = '';
  }
  function applyCapture(code) {
    const { action, slot } = capture;
    capture = null;
    const r = rebindKeys(settings.get('keys'), action, slot, code);
    const name = ACTION_LABELS[action];
    if (r.error) {
      say(r.error === 'reserved' ? `${keyLabel(code, true)} is reserved for menus` : "That key can't be bound", 'warn');
    } else if (!r.changed) {
      say(`${name} unchanged`, 'info');
    } else {
      settings.set('keys', r.keys);
      let msg = code === null ? `${name}: ${slot ? 'alternate' : 'primary'} key cleared` : `${name} \u2192 ${keyLabel(code)}`;
      if (r.swap && r.swap.action === action) msg = `${name}: primary and alternate swapped`;
      else if (r.swap) msg += r.swap.code ? ` \u00b7 swapped: ${ACTION_LABELS[r.swap.action]} \u2192 ${keyLabel(r.swap.code)}` : ` \u00b7 taken from ${ACTION_LABELS[r.swap.action]}`;
      if (r.unbound.length) msg += ` \u00b7 ${r.unbound.map((a) => ACTION_LABELS[a]).join(', ')} unbound!`;
      say(msg, r.unbound.length ? 'warn' : 'ok');
      flash(action, code);
      if (r.swap) flash(r.swap.action, r.swap.code);
    }
    syncKeys();
  }

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
    const order = TABS.map((t) => t[0]);
    let i = order.indexOf(activeTab);
    if (e.key === 'ArrowRight') i = (i + 1) % order.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + order.length) % order.length;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = order.length - 1;
    else return;
    e.preventDefault();
    selectTab(order[i], true);
  });

  function sync() {
    const s = settings.all();
    for (const fn of syncers) fn(s);
    syncKeys(s);
    for (const k of ['sfxVolume', 'musicVolume']) {
      const row = body.querySelector(`[data-key="${k}"]`);
      if (row) row.classList.toggle('is-dim', s.muted);
    }
    overlay.classList.toggle('ir-set-calm', !!s.reduceFlashes);
  }
  const unsubscribe = settings.subscribe(() => { if (!disposed) sync(); });

  function disarm() {
    clearTimeout(armTimer);
    armed = false;
    resetAllBtn.classList.remove('is-armed');
    resetAllBtn.firstChild.textContent = 'Reset all';
  }
  resetAllBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      resetAllBtn.classList.add('is-armed');
      resetAllBtn.firstChild.textContent = 'Confirm?';
      say('Click again to restore every setting to its default (your name is kept)', 'warn');
      armTimer = setTimeout(disarm, 3500);
      return;
    }
    disarm();
    cancelCapture();
    for (const k of FIELD_KEYS) if (k !== 'name') settings.set(k, DEFAULTS[k]);
    say('All settings restored to defaults', 'ok');
  });
  closeBtn.addEventListener('click', () => close());
  doneBtn.addEventListener('click', () => close());
  overlay.addEventListener('pointerdown', (e) => {
    downOnBackdrop = e.target === overlay;
    if (capture && !(e.target.closest && e.target.closest('.ir-set-key'))) cancelCapture('Rebind cancelled');
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && downOnBackdrop) close();
    downOnBackdrop = false;
  });
  // Keep game input (window-level listeners) from seeing keys typed inside the panel. keyup is left
  // alone so a key held when the panel opened is still released in the game.
  overlay.addEventListener('keydown', (e) => e.stopPropagation());

  function focusables() {
    return [...dialog.querySelectorAll('button, input, [tabindex]')].filter((el) =>
      !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden]') && el.getClientRects().length > 0);
  }
  function onKeyDown(e) {   // window, capture phase, only while open
    if (capture) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      const code = e.code;
      if (code === 'Escape') { cancelCapture('Rebind cancelled'); return; }
      if (!code) return;    // unidentified key (IME, some virtual keyboards)
      swallowUp = code;
      applyCapture(code === 'Backspace' || code === 'Delete' ? null : code);
      return;
    }
    if (e.code === 'Escape' || e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
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
    if (swallowUp && e.code === swallowUp) {
      e.preventDefault();
      e.stopImmediatePropagation();
      swallowUp = null;
    }
  }
  function onFocusIn(e) {
    if (open_ && !overlay.contains(e.target)) {
      const els = focusables();
      if (els.length) els[0].focus();
    }
  }
  function onBlur() { cancelCapture(); }

  function notify(isOpen) {
    try { container.dispatchEvent(new win.CustomEvent('ir-settings', { bubbles: true, detail: { open: isOpen } })); } catch { /* ignore */ }
    const cb = isOpen ? opts.onOpen : opts.onClose;
    if (typeof cb === 'function') { try { cb(); } catch (err) { console.error(err); } }
  }
  function open() {
    if (disposed || open_) return;
    open_ = true;
    lastFocus = doc.activeElement;
    sync();
    overlay.hidden = false;
    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('keyup', onKeyUp, true);
    win.addEventListener('blur', onBlur);
    doc.addEventListener('focusin', onFocusIn);
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
    statusEl.textContent = '';
    overlay.hidden = true;
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('keyup', onKeyUp, true);
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('focusin', onFocusIn);
    const back = lastFocus;
    lastFocus = null;
    if (back && back.isConnected && typeof back.focus === 'function' && back !== doc.body) {
      try { back.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    notify(false);
  }
  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    unsubscribe();
    clearTimeout(statusTimer);
    clearTimeout(armTimer);
    for (const t of flashTimers) clearTimeout(t);
    flashTimers.clear();
    overlay.remove();
    releaseStyle(doc);
  }

  selectTab(activeTab, false);
  sync();
  return { open, close, isOpen: () => open_, dispose };
}
