// ICE RIOT - settings store tests. Run: node test/settings.test.js (exit 1 on failure).
import assert from 'node:assert/strict';
import {
  DEFAULTS, ACTIONS, SETTINGS_VERSION, STORAGE_KEY, createSettings, sanitizeSettings, sanitizeKeys,
  migrate, rebindKeys, keyLabel, isBindableCode, GAMEPAD_LAYOUT,
} from '../public/settings.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (err) { failures.push([name, err]); }
}

class FakeStorage {
  constructor(init = {}) { this.map = new Map(Object.entries(init)); this.writes = 0; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.writes++; this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
const throwingStorage = {
  getItem() { throw new Error('SecurityError: blocked'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('blocked'); },
};
const plain = (v) => JSON.parse(JSON.stringify(v));
const quiet = (fn) => {           // silence console.error from deliberately failing subscribers
  const orig = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = orig; }
};
const noDupes = (keys) => {
  const seen = new Set();
  for (const a of ACTIONS) for (const c of keys[a]) { assert.ok(!seen.has(c), `duplicate binding ${c}`); seen.add(c); }
  for (const a of ACTIONS) assert.ok(keys[a].length <= 2, `${a} has > 2 slots`);
};

// ---------------------------------------------------------------- defaults
test('DEFAULTS has the contract shape and is frozen', () => {
  assert.equal(DEFAULTS.version, 1);
  assert.equal(SETTINGS_VERSION, 1);
  assert.equal(DEFAULTS.sfxVolume, 0.8);
  assert.equal(DEFAULTS.musicVolume, 0.45);
  assert.equal(DEFAULTS.announcerVolume, 0.9);
  assert.equal(DEFAULTS.quality, 'auto');
  assert.equal(DEFAULTS.cameraShake, 1);
  assert.deepEqual(plain(DEFAULTS.keys.shoot), ['KeyJ', 'Space']);
  assert.deepEqual(plain(DEFAULTS.keys.turbo), ['ShiftLeft', 'ShiftRight']);
  assert.equal(DEFAULTS.name, '');
  assert.deepEqual(Object.keys(DEFAULTS.keys), ACTIONS.slice());
  assert.ok(Object.isFrozen(DEFAULTS) && Object.isFrozen(DEFAULTS.keys) && Object.isFrozen(DEFAULTS.keys.up));
  noDupes(DEFAULTS.keys);
  assert.equal(GAMEPAD_LAYOUT.length, 5);
});

test('fresh store returns DEFAULTS; get/all return copies', () => {
  const s = createSettings({ storage: null });
  assert.deepEqual(s.all(), plain(DEFAULTS));
  assert.equal(s.get('sfxVolume'), 0.8);
  assert.equal(s.get('version'), 1);
  assert.equal(s.get('nope'), undefined);
  assert.equal(s.get(), undefined);
  const k = s.get('keys');
  k.up.push('KeyQ');
  k.shoot = [];
  assert.deepEqual(s.get('keys'), plain(DEFAULTS.keys));
  const all = s.all();
  all.sfxVolume = 0;
  all.keys.pass = ['KeyZ'];
  assert.equal(s.get('sfxVolume'), 0.8);
  assert.equal(s.keyFor('KeyZ'), null);
});

test('createSettings() without options works in Node (no localStorage)', () => {
  const s = createSettings();
  assert.equal(s.get('quality'), 'auto');
  s.set('quality', 'low');
  assert.equal(s.get('quality'), 'low');
});

test('a localStorage getter that throws is tolerated', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    const s = createSettings();
    assert.equal(s.get('muted'), false);
    s.set('muted', true);
    assert.equal(s.get('muted'), true);
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage;
  }
});

// ---------------------------------------------------------------- clamping / validation on set
test('numbers are clamped, rounded and coerced; junk is ignored', () => {
  const s = createSettings({ storage: null });
  assert.equal(s.set('sfxVolume', 5), 1);
  assert.equal(s.set('sfxVolume', -2), 0);
  assert.equal(s.set('musicVolume', '0.25'), 0.25);
  assert.equal(s.set('announcerVolume', 0.123456), 0.123);
  assert.equal(s.set('cameraShake', 1.5), 1);
  s.set('cameraShake', 0.4);
  for (const junk of [NaN, Infinity, 'loud', '', null, undefined, {}, [], true]) {
    assert.equal(s.set('cameraShake', junk), 0.4, `junk ${String(junk)}`);
  }
});

test('booleans, quality enum, name sanitizing', () => {
  const s = createSettings({ storage: null });
  assert.equal(s.set('muted', true), true);
  assert.equal(s.set('muted', 0), false);
  assert.equal(s.set('muted', 'true'), true);
  assert.equal(s.set('muted', 'yes'), true, 'unrecognized -> unchanged');
  assert.equal(s.set('showNames', null), true);
  assert.equal(s.set('quality', 'High'), 'high');
  assert.equal(s.set('quality', ' LOW '), 'low');
  assert.equal(s.set('quality', 'ultra'), 'low');
  assert.equal(s.set('quality', 3), 'low');
  assert.equal(s.set('name', '  Big\u0000  Al \n'), 'Big Al');
  assert.equal(s.set('name', 'X'.repeat(40)), 'X'.repeat(16));
  assert.equal(s.set('name', 42), 'X'.repeat(16));
  const emoji = 'A'.repeat(15) + '\u{1F3D2}';       // hockey emoji = 2 UTF-16 units
  assert.equal(s.set('name', emoji), 'A'.repeat(15), 'no dangling surrogate');
  assert.equal(s.set('version', 9), undefined);
  assert.equal(s.get('version'), 1);
  assert.equal(s.set('bogus', 1), undefined);
  assert.equal('bogus' in s.all(), false);
});

test('keys: validation, max 2 slots, reserved Escape, partial merge, conflicts resolved', () => {
  const s = createSettings({ storage: null });
  assert.equal(isBindableCode('KeyW'), true);
  assert.equal(isBindableCode('Escape'), false);
  assert.equal(isBindableCode('bad code'), false);
  assert.equal(isBindableCode(''), false);
  // partial update: only shoot replaced, invalid entries dropped, capped to 2
  s.set('keys', { shoot: ['KeyZ', 'Escape', 'nope!', 7, 'KeyZ', 'KeyX', 'KeyC'] });
  assert.deepEqual(s.get('keys').shoot, ['KeyZ', 'KeyX']);
  assert.deepEqual(s.get('keys').up, ['KeyW', 'ArrowUp']);
  // a single string is accepted
  s.set('keys', { pass: 'KeyP' });
  assert.deepEqual(s.get('keys').pass, ['KeyP']);
  // explicit [] = deliberately unbound
  s.set('keys', { action: [] });
  assert.deepEqual(s.get('keys').action, []);
  assert.equal(s.keyFor('KeyL'), null);
  // explicit actions beat inherited ones on conflict
  s.set('keys', { turbo: ['KeyW'] });
  assert.deepEqual(s.get('keys').turbo, ['KeyW']);
  assert.deepEqual(s.get('keys').up, ['ArrowUp']);
  // junk for the whole map is ignored
  const before = s.get('keys');
  s.set('keys', 'KeyW');
  s.set('keys', ['KeyW']);
  s.set('keys', null);
  assert.deepEqual(s.get('keys'), before);
  noDupes(s.get('keys'));
});

test('sanitizeKeys: primaries beat alternates; stolen actions fall back to defaults', () => {
  const k = sanitizeKeys({ shoot: ['KeyZ', 'KeyQ'], pass: ['KeyQ'] });
  assert.deepEqual(k.pass, ['KeyQ']);
  assert.deepEqual(k.shoot, ['KeyZ']);
  const k2 = sanitizeKeys({ up: ['KeyW'], down: ['KeyW'] });
  assert.deepEqual(k2.up, ['KeyW']);
  assert.deepEqual(k2.down, ['KeyS', 'ArrowDown'], 'down lost every key to a conflict -> defaults');
  const k3 = sanitizeKeys({ up: [5, null] });
  assert.deepEqual(k3.up, ['KeyW', 'ArrowUp'], 'non-empty array with nothing valid = invalid -> default');
  noDupes(k); noDupes(k2); noDupes(k3);
});

// ---------------------------------------------------------------- load validation
test('load: garbage fields are validated, unknown keys dropped, missing keys defaulted', () => {
  const json = JSON.stringify({
    version: 1, sfxVolume: 9, musicVolume: 'x', announcerVolume: -1, quality: 'ultra', showNames: 'yes',
    muted: 1, cameraShake: '0.5', name: 'Tester', extra: { evil: true },
    keys: { up: ['KeyW', 'KeyW', 'Escape', 'bad code', 5], shoot: 'KeyZ', bogusAction: ['KeyQ'] },
  }).replace(/^\{/, '{"__proto__":{"polluted":1},');
  const storage = new FakeStorage({ [STORAGE_KEY]: json });
  const s = createSettings({ storage });
  const a = s.all();
  assert.equal(a.sfxVolume, 1);
  assert.equal(a.musicVolume, DEFAULTS.musicVolume);
  assert.equal(a.announcerVolume, 0);
  assert.equal(a.quality, 'auto');
  assert.equal(a.showNames, true);
  assert.equal(a.muted, true);
  assert.equal(a.cameraShake, 0.5);
  assert.equal(a.name, 'Tester');
  assert.equal(a.reduceFlashes, false, 'missing -> default');
  assert.deepEqual(a.keys.up, ['KeyW']);
  assert.deepEqual(a.keys.shoot, ['KeyZ']);
  assert.deepEqual(a.keys.down, ['KeyS', 'ArrowDown']);
  assert.ok(!('extra' in a) && !('bogusAction' in a.keys) && !('polluted' in a));
  assert.deepEqual(Object.keys(a), Object.keys(DEFAULTS));
});

test('load: malformed / non-object JSON falls back to defaults', () => {
  for (const txt of ['{not json', '42', '"str"', '[1,2,3]', 'null', 'true', '']) {
    const s = createSettings({ storage: new FakeStorage({ [STORAGE_KEY]: txt }) });
    assert.deepEqual(s.all(), plain(DEFAULTS), `input ${JSON.stringify(txt)}`);
  }
  assert.deepEqual(sanitizeSettings(undefined), plain(DEFAULTS));
});

// ---------------------------------------------------------------- persistence
test('persistence round trip with a fake storage', () => {
  const storage = new FakeStorage();
  const s1 = createSettings({ storage });
  assert.equal(storage.writes, 0, 'nothing written until something changes');
  s1.set('sfxVolume', 0.3);
  s1.set('quality', 'medium');
  s1.set('reduceFlashes', true);
  s1.set('name', 'Riot');
  s1.set('keys', rebindKeys(s1.get('keys'), 'shoot', 0, 'KeyK').keys);
  const stored = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(stored.version, 1);
  assert.equal(stored.sfxVolume, 0.3);
  const s2 = createSettings({ storage });
  assert.deepEqual(s2.all(), s1.all());
  assert.equal(s2.keyFor('KeyK'), 'shoot');
  assert.equal(s2.keyFor('KeyJ'), 'pass');
  // unchanged set() does not write
  const w = storage.writes;
  s2.set('sfxVolume', 0.3);
  s2.set('quality', 'MEDIUM');
  assert.equal(storage.writes, w);
});

test('storageKey isolates stores', () => {
  const storage = new FakeStorage();
  const a = createSettings({ storage, storageKey: 'a' });
  const b = createSettings({ storage, storageKey: 'b' });
  a.set('muted', true);
  assert.equal(createSettings({ storage, storageKey: 'a' }).get('muted'), true);
  assert.equal(createSettings({ storage, storageKey: 'b' }).get('muted'), false);
  assert.equal(b.get('muted'), false);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test('reset() restores and persists defaults', () => {
  const storage = new FakeStorage();
  const s = createSettings({ storage });
  s.set('musicVolume', 0); s.set('keys', { up: ['KeyI'] }); s.set('name', 'Z');
  s.reset();
  assert.deepEqual(s.all(), plain(DEFAULTS));
  assert.deepEqual(createSettings({ storage }).all(), plain(DEFAULTS));
  assert.equal(s.keyFor('KeyI'), null);
  assert.equal(s.keyFor('KeyW'), 'up');
});

test('throwing / broken / null storage is tolerated (memory only)', () => {
  for (const storage of [throwingStorage, null, {}, { getItem: 5, setItem: 'x' }, 42]) {
    const s = createSettings({ storage });
    assert.deepEqual(s.all(), plain(DEFAULTS));
    assert.equal(s.set('sfxVolume', 0.1), 0.1);
    assert.equal(s.get('sfxVolume'), 0.1);
    s.reset();
    assert.equal(s.get('sfxVolume'), 0.8);
  }
  const quota = new FakeStorage();
  quota.setItem = () => { throw new Error('QuotaExceededError'); };
  const s = createSettings({ storage: quota });
  assert.equal(s.set('muted', true), true);
});

// ---------------------------------------------------------------- subscribe
test('subscribe: (key, value, all), only on change, unsubscribe stops calls', () => {
  const s = createSettings({ storage: null });
  const calls = [];
  const off = s.subscribe((key, value, all) => calls.push({ key, value, all }));
  s.set('musicVolume', 0.2);
  s.set('musicVolume', 0.2);            // no change -> no call
  s.set('musicVolume', 'junk');         // invalid -> no call
  s.set('muted', true);
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[0].key, calls[0].value], ['musicVolume', 0.2]);
  assert.equal(calls[0].all.musicVolume, 0.2);
  assert.equal(calls[1].all.muted, true);
  // values handed out are copies
  s.set('keys', { pass: ['KeyP'] });
  const kv = calls[2].value;
  assert.deepEqual(kv.pass, ['KeyP']);
  kv.pass.push('KeyQ');
  calls[2].all.keys.up = [];
  assert.deepEqual(s.get('keys').pass, ['KeyP']);
  assert.deepEqual(s.get('keys').up, ['KeyW', 'ArrowUp']);
  off();
  off();                                // idempotent
  s.set('muted', false);
  assert.equal(calls.length, 3);
  assert.equal(typeof s.subscribe('nope'), 'function');
});

test('subscribe: a throwing listener does not block others; same fn twice = two subscriptions', () => {
  const s = createSettings({ storage: null });
  let n = 0;
  const fn = () => { n++; };
  s.subscribe(() => { throw new Error('boom'); });
  const off1 = s.subscribe(fn);
  s.subscribe(fn);
  quiet(() => s.set('showNames', false));
  assert.equal(n, 2);
  off1();
  quiet(() => s.set('showNames', true));
  assert.equal(n, 3);
});

test('subscribe: unsubscribing during an emit is safe; reset emits once per changed key', () => {
  const s = createSettings({ storage: null });
  const seen = [];
  let offB = null;
  s.subscribe((k) => { seen.push('A:' + k); offB(); });
  offB = s.subscribe((k) => seen.push('B:' + k));
  s.set('muted', true);
  assert.deepEqual(seen, ['A:muted']);
  seen.length = 0;
  s.set('quality', 'low');
  s.set('name', 'Q');
  seen.length = 0;
  s.reset();
  assert.deepEqual(seen.sort(), ['A:muted', 'A:name', 'A:quality']);
});

// ---------------------------------------------------------------- keyFor
test('keyFor maps KeyboardEvent.code to an action', () => {
  const s = createSettings({ storage: null });
  const expect = {
    KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right', KeyJ: 'shoot', Space: 'shoot', KeyK: 'pass', KeyL: 'action',
    ShiftLeft: 'turbo', ShiftRight: 'turbo',
  };
  for (const [code, action] of Object.entries(expect)) assert.equal(s.keyFor(code), action, code);
  for (const code of ['KeyQ', 'Escape', '', undefined, null, 5, 'keyw']) assert.equal(s.keyFor(code), null);
  s.set('keys', rebindKeys(s.get('keys'), 'turbo', 0, 'KeyJ').keys);
  assert.equal(s.keyFor('KeyJ'), 'turbo');
  assert.equal(s.keyFor('ShiftLeft'), 'shoot');
});

// ---------------------------------------------------------------- rebindKeys
test('rebindKeys: free key binds, nothing else moves', () => {
  const r = rebindKeys(DEFAULTS.keys, 'shoot', 0, 'KeyZ');
  assert.equal(r.changed, true);
  assert.equal(r.swap, null);
  assert.deepEqual(r.keys.shoot, ['KeyZ', 'Space']);
  assert.deepEqual(r.unbound, []);
  const r2 = rebindKeys(DEFAULTS.keys, 'pass', 1, 'KeyP');
  assert.deepEqual(r2.keys.pass, ['KeyK', 'KeyP']);
});

test('rebindKeys: conflict swaps the displaced key onto the other action', () => {
  const r = rebindKeys(DEFAULTS.keys, 'shoot', 0, 'KeyK');
  assert.equal(r.changed, true);
  assert.deepEqual(r.keys.shoot, ['KeyK', 'Space']);
  assert.deepEqual(r.keys.pass, ['KeyJ']);
  assert.deepEqual(r.swap, { action: 'pass', slot: 0, code: 'KeyJ' });
  noDupes(r.keys);
  const r2 = rebindKeys(DEFAULTS.keys, 'up', 1, 'ArrowDown');
  assert.deepEqual(r2.keys.up, ['KeyW', 'ArrowDown']);
  assert.deepEqual(r2.keys.down, ['KeyS', 'ArrowUp']);
  assert.deepEqual(r2.swap, { action: 'down', slot: 1, code: 'ArrowUp' });
});

test('rebindKeys: binding into an empty slot steals the key (other action may become unbound)', () => {
  const r = rebindKeys(DEFAULTS.keys, 'pass', 1, 'Space');
  assert.deepEqual(r.keys.pass, ['KeyK', 'Space']);
  assert.deepEqual(r.keys.shoot, ['KeyJ']);
  assert.deepEqual(r.swap, { action: 'shoot', slot: 1, code: null });
  assert.deepEqual(r.unbound, []);
  const r2 = rebindKeys(DEFAULTS.keys, 'action', 1, 'KeyK');
  assert.deepEqual(r2.keys.action, ['KeyL', 'KeyK']);
  assert.deepEqual(r2.keys.pass, []);
  assert.deepEqual(r2.unbound, ['pass']);
  noDupes(r2.keys);
});

test('rebindKeys: same action other slot swaps primary/alternate', () => {
  const r = rebindKeys(DEFAULTS.keys, 'up', 0, 'ArrowUp');
  assert.deepEqual(r.keys.up, ['ArrowUp', 'KeyW']);
  assert.deepEqual(r.swap, { action: 'up', slot: 1, code: 'KeyW' });
  const one = rebindKeys(DEFAULTS.keys, 'pass', 1, 'KeyK');
  assert.equal(one.changed, false, 'moving the only key into the empty slot is a no-op');
  assert.deepEqual(one.keys.pass, ['KeyK']);
});

test('rebindKeys: no-ops, errors, clearing, purity', () => {
  const input = plain(DEFAULTS.keys);
  const frozen = JSON.stringify(input);
  assert.equal(rebindKeys(input, 'up', 0, 'KeyW').changed, false);
  assert.equal(rebindKeys(input, 'up', 0, 'Escape').error, 'reserved');
  assert.equal(rebindKeys(input, 'up', 0, 'not a code').error, 'invalid');
  assert.equal(rebindKeys(input, 'up', 0, undefined).error, 'invalid');
  assert.equal(rebindKeys(input, 'jump', 0, 'KeyQ').error, 'action');
  assert.equal(rebindKeys(input, 'up', 2, 'KeyQ').error, 'slot');
  assert.equal(rebindKeys(input, 'up', -1, 'KeyQ').error, 'slot');
  assert.equal(rebindKeys(input, 'up', 0.5, 'KeyQ').error, 'slot');
  const cleared = rebindKeys(input, 'up', 0, null);
  assert.equal(cleared.changed, true);
  assert.deepEqual(cleared.keys.up, ['ArrowUp']);
  assert.equal(rebindKeys(input, 'pass', 1, null).changed, false, 'clearing an empty slot');
  const both = rebindKeys(rebindKeys(input, 'pass', 0, null).keys, 'pass', 0, null);
  assert.deepEqual(both.keys.pass, []);
  assert.deepEqual(both.unbound, ['pass']);
  // binding into an unbound action
  const back = rebindKeys(both.keys, 'pass', 1, 'KeyP');
  assert.deepEqual(back.keys.pass, ['KeyP']);
  assert.equal(JSON.stringify(input), frozen, 'input not mutated');
  assert.notEqual(cleared.keys, input);
});

test('rebindKeys: random sequences never produce duplicate bindings', () => {
  let seed = 1234567;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
  const pool = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyJ', 'KeyK', 'KeyL', 'Space', 'ShiftLeft', 'ShiftRight',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'Digit1', 'Numpad0', null, 'Escape'];
  let keys = plain(DEFAULTS.keys);
  for (let i = 0; i < 3000; i++) {
    const r = rebindKeys(keys, ACTIONS[rnd(ACTIONS.length)], rnd(2), pool[rnd(pool.length)]);
    noDupes(r.keys);
    assert.deepEqual(r.unbound, ACTIONS.filter((a) => r.keys[a].length === 0));
    keys = r.keys;
  }
  // the store agrees with the pure helper
  const s = createSettings({ storage: null });
  s.set('keys', keys);
  assert.deepEqual(s.get('keys'), keys);
});

// ---------------------------------------------------------------- migration
const V0 = {
  volume: 50, sfx: 80, music: 100, voice: 60, mute: true, gfx: 'lo', shake: false,
  names: false, tips: false, flashes: false, playerName: '  Goon  ',
  bindings: { shoot: 'KeyZ', pass: 'Space', turbo: 'Escape', up: 'KeyI' },
};

test('migrate: v0 object -> v1 shape', () => {
  const m = migrate(V0);
  assert.equal(m.version, 1);
  assert.equal(m.sfxVolume, 0.4);
  assert.equal(m.musicVolume, 0.5);
  assert.equal(m.announcerVolume, 0.3);
  assert.equal(m.muted, true);
  assert.equal(m.quality, 'low');
  assert.equal(m.cameraShake, 0);
  assert.equal(m.showNames, false);
  assert.equal(m.showTutorial, false);
  assert.equal(m.reduceFlashes, true);
  assert.ok(!('volume' in m) && !('bindings' in m) && !('gfx' in m));
  assert.deepEqual(migrate(null), { version: 1 });
  assert.deepEqual(migrate([1]), { version: 1 });
});

test('sanitizeSettings: v0 -> complete valid v1', () => {
  const s = sanitizeSettings(V0);
  assert.equal(s.version, 1);
  assert.equal(s.name, 'Goon');
  assert.deepEqual(s.keys.shoot, ['KeyZ'], 'Space went to pass (primary beats the alternate)');
  assert.deepEqual(s.keys.pass, ['Space']);
  assert.deepEqual(s.keys.up, ['KeyI', 'ArrowUp'], 'v1 alternate kept');
  assert.deepEqual(s.keys.turbo, ['ShiftLeft', 'ShiftRight'], 'Escape is not bindable -> default');
  assert.deepEqual(s.keys.down, ['KeyS', 'ArrowDown']);
  assert.equal(s.announcer, true);
  noDupes(s.keys);
});

test('migration via storage: v0 is upgraded and written back; v1 fields in a v0 object survive', () => {
  const storage = new FakeStorage({ [STORAGE_KEY]: JSON.stringify(V0) });
  const s = createSettings({ storage });
  assert.equal(s.get('quality'), 'low');
  assert.equal(s.get('sfxVolume'), 0.4);
  const stored = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(stored.version, 1);
  assert.equal(stored.sfxVolume, 0.4);
  assert.ok(!('bindings' in stored));
  // explicit version 0 with some v1 fields already present
  const mixed = sanitizeSettings({ version: 0, sfxVolume: 0.7, sfx: 10, gfx: 'hi', quality: 'medium', master: 3 });
  assert.equal(mixed.sfxVolume, 0.7);
  assert.equal(mixed.quality, 'medium');
  // only a master volume: scales the defaults
  const master = sanitizeSettings({ volume: 50 });
  assert.equal(master.sfxVolume, 0.4);
  assert.equal(master.musicVolume, 0.225);
});

test('a save from a newer version is read best-effort and not overwritten on load', () => {
  const future = JSON.stringify({ version: 2, sfxVolume: 0.5, newThing: 'x' });
  const storage = new FakeStorage({ [STORAGE_KEY]: future });
  const s = createSettings({ storage });
  assert.equal(s.get('sfxVolume'), 0.5);
  assert.equal(s.get('version'), 1);
  assert.equal(storage.getItem(STORAGE_KEY), future);
});

// ---------------------------------------------------------------- labels
test('keyLabel', () => {
  assert.equal(keyLabel('KeyW'), 'W');
  assert.equal(keyLabel('Digit7'), '7');
  assert.equal(keyLabel('Numpad3'), 'Num 3');
  assert.equal(keyLabel('ArrowUp'), '\u2191');
  assert.equal(keyLabel('ArrowUp', true), 'Up arrow');
  assert.equal(keyLabel('ShiftLeft'), 'L-Shift');
  assert.equal(keyLabel('Space'), 'Space');
  assert.equal(keyLabel('F11'), 'F11');
  assert.equal(keyLabel('BracketLeft'), '[');
  assert.equal(keyLabel('MediaPlayPause'), 'Media Play Pause');
  assert.equal(keyLabel(undefined), '\u2014');
  assert.equal(keyLabel(null, true), 'none');
});

// ---------------------------------------------------------------- report
for (const [name, err] of failures) {
  console.error(`FAIL ${name}\n  ${(err && err.stack) || err}\n`);
}
console.log(`settings.test.js: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
