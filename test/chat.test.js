// ICE RIOT - chat tests. Run: node test/chat.test.js (exit code 1 on any failure).
// Covers server/chat.js (sanitization, rate limiting + refill, emote validation, history, forget)
// and public/chat.js: loads without a DOM, ships the same QUICK_CHAT list, and (on a tiny fake DOM)
// renders lines, handles the lobby / in-game keys, quick-line cooldown, feed fade and cleanup.

import assert from 'node:assert/strict';
import { createChat, sanitizeChat, QUICK_CHAT, CHAT_MAX_LEN } from '../server/chat.js';
import * as clientChat from '../public/chat.js';
import { TEAMS } from '../shared/constants.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(err?.stack || err).split('\n').join('\n       ')}`);
  }
}

const A = { id: 1, name: 'Blizz', team: 0 };
const B = { id: 2, name: 'Rook', team: 1 };
const S = { id: 3, name: 'Watcher', team: -1 };
const say = (text) => ({ t: 'chat', text });
const emote = (id) => ({ t: 'emote', id });

console.log('chat: sanitization');

test('strips C0/C1 control chars and DEL', () => {
  // NEL (U+0085) is treated as a line break -> space; everything else is removed outright.
  assert.equal(sanitizeChat('a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg'), 'abcde fg');
  assert.equal(sanitizeChat('a\u0000b\u0007c\u001bd\u007fe\u009fg'), 'abcdeg');
  assert.equal(sanitizeChat('x\u0085y'), 'x y');
});

test('strips zero-width, bidi overrides and BOM', () => {
  assert.equal(sanitizeChat('he\u200bl\u200dl\u202eo\u2066\ufeff!'), 'hello!');
});

test('newlines/tabs become single spaces; whitespace collapsed + trimmed', () => {
  assert.equal(sanitizeChat('  one\n\ntwo\t\tthree\r\n  four  '), 'one two three four');
  assert.equal(sanitizeChat('a\u2028b\u2029c'), 'a b c');
  assert.equal(sanitizeChat('wide\u3000\u00a0gap'), 'wide gap');
});

test('HTML stays literal text (not escaped, not stripped)', () => {
  const s = '<img src=x onerror="alert(1)"> & <b>bold</b>';
  assert.equal(sanitizeChat(s), s);
  const chat = createChat();
  const out = chat.handle(A, say('<script>x</script>'), 1000);
  assert.equal(out.text, '<script>x</script>');
});

test('length cap at 120 code points, never splits a surrogate pair', () => {
  assert.equal(CHAT_MAX_LEN, 120);
  assert.equal(sanitizeChat('x'.repeat(500)).length, 120);
  const astral = '\u{1F3D2}'.repeat(130); // 2 UTF-16 units each
  const capped = sanitizeChat(astral);
  assert.equal(Array.from(capped).length, 120);
  assert.equal(capped.length, 240);
  assert.equal(sanitizeChat('ab cd', 3), 'ab'); // trailing space trimmed after the cut
  const chat = createChat({ maxLen: 10 });
  assert.equal(chat.handle(A, say('0123456789ABCDEF'), 0).text, '0123456789');
});

test('lone surrogates and zalgo mark stacks are cleaned', () => {
  assert.equal(sanitizeChat('a\ud800b\udc00c'), 'abc');
  assert.equal(sanitizeChat('e\u0301\u0301\u0301\u0301x'), 'e\u0301\u0301x');
});

test('empty / whitespace-only / control-only / non-string text is ignored (null)', () => {
  const chat = createChat();
  assert.equal(chat.handle(A, say(''), 0), null);
  assert.equal(chat.handle(A, say('   \n\t '), 0), null);
  assert.equal(chat.handle(A, say('\u0000\u200b\u202e'), 0), null);
  assert.equal(chat.handle(A, say(42), 0), null);
  assert.equal(chat.handle(A, say(null), 0), null);
  assert.equal(chat.handle(A, { t: 'chat' }, 0), null);
  assert.equal(chat.handle(A, { t: 'nope', text: 'hi' }, 0), null);
  assert.equal(chat.handle(A, null, 0), null);
  assert.equal(chat.handle(null, say('hi'), 0), null);
  assert.equal(chat.history().length, 0);
});

console.log('chat: broadcast format');

test('broadcast message shape', () => {
  const chat = createChat();
  const out = chat.handle(A, say('  hello   there '), 12345);
  assert.deepEqual(out, { t: 'chat', from: 1, name: 'Blizz', team: 0, text: 'hello there', emote: null, ts: 12345 });
  assert.equal(chat.handle(S, say('hi'), 1).team, -1);
  assert.equal(chat.handle({ id: 9, name: 'X', team: 7 }, say('hi'), 1).team, -1);
  assert.equal(chat.handle({ id: 10, name: 'Y' }, say('hi'), 1).team, -1);
});

test('nowMs missing -> Date.now()', () => {
  const chat = createChat();
  const before = Date.now();
  const out = chat.handle(A, say('hi'));
  assert.ok(out.ts >= before && out.ts <= Date.now());
});

console.log('chat: emotes');

test('valid emote ids map to QUICK_CHAT text', () => {
  assert.equal(QUICK_CHAT.length, 8);
  const chat = createChat({ burst: 100 });
  for (let i = 0; i < QUICK_CHAT.length; i++) {
    const out = chat.handle(B, emote(i), i * 10);
    assert.equal(out.emote, i);
    assert.equal(out.text, QUICK_CHAT[i]);
    assert.equal(out.team, 1);
  }
});

test('invalid emote ids are rejected with {error} and cost no token', () => {
  const chat = createChat({ burst: 1, refillPerSec: 0 });
  for (const id of [-1, 8, 99, 1.5, '1', null, undefined, NaN, Infinity, [0], { id: 0 }]) {
    const r = chat.handle(A, emote(id), 0);
    assert.ok(r && typeof r.error === 'string', `id ${String(id)} should be rejected`);
  }
  assert.equal(chat.handle(A, emote(0), 0).emote, 0); // the one token is still there
  assert.equal(chat.history().length, 1);
});

test('QUICK_CHAT is frozen', () => {
  assert.ok(Object.isFrozen(QUICK_CHAT));
});

console.log('chat: rate limiting');

test('burst of 5 then limited; first limited message warns, rest of streak is silent', () => {
  const chat = createChat(); // burst 5, 1/s, warn every 2 s
  for (let i = 0; i < 5; i++) assert.equal(chat.handle(A, say(`m${i}`), 1000).t, 'chat');
  const w = chat.handle(A, say('spam'), 1000);
  assert.ok(w && typeof w.error === 'string' && !w.t, 'first limited message returns {error}');
  assert.equal(chat.handle(A, say('spam'), 1001), null);
  assert.equal(chat.handle(A, say('spam'), 1500), null);
  assert.equal(chat.history().length, 5);
});

test('refills at 1 token/s, capped at burst', () => {
  const chat = createChat();
  for (let i = 0; i < 5; i++) chat.handle(A, say('x'), 0);
  assert.ok(!chat.handle(A, say('x'), 500)?.t, 'half a token is not enough');
  assert.equal(chat.handle(A, say('x'), 1000)?.t, 'chat', 'one token after 1 s');
  assert.ok(!chat.handle(A, say('x'), 1100)?.t);
  // A long idle refills to the burst cap, not beyond.
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(chat.handle(A, say('x'), t)?.t, 'chat');
  assert.ok(!chat.handle(A, say('x'), t)?.t, 'cap is burst (5), not elapsed seconds');
});

test('a warning is re-issued after warnEveryMs during a long spam streak', () => {
  const chat = createChat({ burst: 1, refillPerSec: 0, warnEveryMs: 2000 });
  chat.handle(A, say('x'), 0);
  assert.ok(chat.handle(A, say('x'), 0)?.error);
  assert.equal(chat.handle(A, say('x'), 1999), null);
  assert.ok(chat.handle(A, say('x'), 2000)?.error);
});

test('steady 1 msg/s is never limited', () => {
  const chat = createChat();
  for (let i = 0; i < 60; i++) assert.equal(chat.handle(A, say(`n${i}`), i * 1000)?.t, 'chat');
});

test('chat and emotes share one bucket; clients are independent', () => {
  const chat = createChat({ burst: 2, refillPerSec: 0 });
  assert.ok(chat.handle(A, say('a'), 0)?.t);
  assert.ok(chat.handle(A, emote(1), 0)?.t);
  assert.ok(!chat.handle(A, emote(2), 0)?.t);
  assert.ok(!chat.handle(A, say('b'), 0)?.t);
  assert.ok(chat.handle(B, say('b'), 0)?.t, 'B has its own bucket');
});

test('a clock going backwards does not refill or break the bucket', () => {
  const chat = createChat({ burst: 2 });
  chat.handle(A, say('a'), 10_000);
  chat.handle(A, say('b'), 10_000);
  assert.ok(!chat.handle(A, say('c'), 5_000)?.t);
  assert.equal(chat.handle(A, say('d'), 6_000)?.t, 'chat', 'refill resumes from the new (earlier) time');
});

test('custom burst / refill options', () => {
  const chat = createChat({ burst: 3, refillPerSec: 2 });
  for (let i = 0; i < 3; i++) assert.ok(chat.handle(A, say('x'), 0)?.t);
  assert.ok(!chat.handle(A, say('x'), 0)?.t);
  assert.ok(chat.handle(A, say('x'), 500)?.t, '2/s -> one token after 500 ms');
});

console.log('chat: history + forget');

test('history keeps the last historySize messages, oldest first', () => {
  const chat = createChat({ historySize: 50, burst: 1000 });
  for (let i = 0; i < 70; i++) chat.handle(A, say(`msg ${i}`), i);
  const h = chat.history();
  assert.equal(h.length, 50);
  assert.equal(h[0].text, 'msg 20');
  assert.equal(h[49].text, 'msg 69');
  const small = createChat({ historySize: 3, burst: 100 });
  for (let i = 0; i < 5; i++) small.handle(B, emote(i), i);
  assert.deepEqual(small.history().map((m) => m.emote), [2, 3, 4]);
});

test('history excludes ignored / rejected / rate-limited messages', () => {
  const chat = createChat({ burst: 1, refillPerSec: 0 });
  chat.handle(A, say('   '), 0);
  chat.handle(A, emote(77), 0);
  chat.handle(A, say('kept'), 0);
  chat.handle(A, say('dropped'), 0);
  assert.deepEqual(chat.history().map((m) => m.text), ['kept']);
});

test('history returns copies (callers can add hist:true safely)', () => {
  const chat = createChat();
  const out = chat.handle(A, say('hi'), 0);
  out.text = 'mutated';
  const h = chat.history();
  h[0].hist = true;
  h[0].text = 'also mutated';
  assert.deepEqual(chat.history()[0], { t: 'chat', from: 1, name: 'Blizz', team: 0, text: 'hi', emote: null, ts: 0 });
});

test('historySize 0 keeps nothing', () => {
  const chat = createChat({ historySize: 0 });
  assert.ok(chat.handle(A, say('hi'), 0)?.t);
  assert.equal(chat.history().length, 0);
});

test('forget(clientId) resets that client only and keeps history', () => {
  const chat = createChat({ burst: 2, refillPerSec: 0 });
  chat.handle(A, say('a1'), 0);
  chat.handle(A, say('a2'), 0);
  chat.handle(B, say('b1'), 0);
  chat.handle(B, say('b2'), 0);
  assert.ok(!chat.handle(A, say('a3'), 0)?.t);
  chat.forget(A.id);
  assert.ok(chat.handle(A, say('a4'), 0)?.t, 'A gets a fresh bucket');
  assert.ok(!chat.handle(B, say('b3'), 0)?.t, 'B is still limited');
  chat.forget(12345); // unknown id: no-op
  assert.deepEqual(chat.history().map((m) => m.text), ['a1', 'a2', 'b1', 'b2', 'a4']);
});

test('name/team are taken from the client at send time', () => {
  const chat = createChat();
  const c = { id: 5, name: 'Old', team: 0 };
  assert.equal(chat.handle(c, say('x'), 0).name, 'Old');
  c.name = 'New';
  c.team = -1;
  const out = chat.handle(c, say('y'), 1);
  assert.equal(out.name, 'New');
  assert.equal(out.team, -1);
  assert.equal(chat.history()[0].name, 'Old');
});

console.log('chat: client module');

test('public/chat.js loads in Node (no DOM at import) and matches QUICK_CHAT', () => {
  assert.equal(typeof clientChat.createChat, 'function');
  assert.deepEqual([...clientChat.QUICK_CHAT], [...QUICK_CHAT]);
  assert.equal(clientChat.EMOTE_COOLDOWN_MS, 2000);
  assert.equal(clientChat.CHAT_MAX_LEN, CHAT_MAX_LEN);
  assert.equal(clientChat.FEED_MS, 8000);
});

test('default name colours are the TEAMS[0] / TEAMS[1] primaries', () => {
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  assert.deepEqual([...clientChat.DEFAULT_TEAM_COLORS], [hex(TEAMS[0].colors.primary), hex(TEAMS[1].colors.primary)]);
});

test('nameColor: parses ints / #rgb / #rrggbb, lifts dark colours, keeps every team primary readable', () => {
  const { nameColor } = clientChat;
  const lum = (h) => { const n = parseInt(h.slice(1), 16); return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255; };
  assert.equal(nameColor(0xff6a13, 'x'), '#ff6a13');
  assert.equal(nameColor('#FF6A13', 'x'), '#ff6a13');
  assert.equal(nameColor('fff', 'x'), '#ffffff');
  assert.equal(nameColor('nope', 'x'), 'x');
  assert.equal(nameColor(null, 'x'), 'x');
  assert.ok(lum(nameColor(0x14213d, 'x')) >= 0.41, 'navy is lifted');
  assert.ok(lum(nameColor(0x000000, 'x')) >= 0.41, 'black is lifted');
  for (const t of TEAMS) assert.ok(lum(nameColor(t.colors.primary, 'x')) >= 0.41, `${t.key} readable`);
});

test('formatTime: HH:MM for epoch ms, empty for junk', () => {
  const ts = new Date(2026, 10, 21, 9, 5).getTime();
  assert.equal(clientChat.formatTime(ts), '09:05');
  assert.equal(clientChat.formatTime(1234), '');
  assert.equal(clientChat.formatTime('1700000000000'), '');
  assert.equal(clientChat.formatTime(NaN), '');
});

// ---- a tiny fake DOM: just enough of the API public/chat.js touches -------------------------
function makeDom() {
  const win = { listeners: {} };
  class Node {
    constructor(tag, text) {
      this.tagName = tag ? tag.toUpperCase() : null;
      this.nodeType = tag ? 1 : 3;
      this._text = text ?? '';
      this.children = [];
      this.parentNode = null;
      this.cls = new Set();
      this.attrs = {};
      this.dataset = {};
      this.listeners = {};
      this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
      this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
      this.hidden = false;
      const self = this;
      this.classList = {
        add: (...c) => c.forEach((x) => self.cls.add(x)),
        remove: (...c) => c.forEach((x) => self.cls.delete(x)),
        contains: (c) => self.cls.has(c),
        toggle: (c, force) => { const on = force === undefined ? !self.cls.has(c) : !!force; if (on) self.cls.add(c); else self.cls.delete(c); return on; },
      };
    }
    set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this.cls].join(' '); }
    set textContent(v) { this.children = []; this._text = String(v); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc.documentElement; }
    appendChild(c) { if (c.parentNode) c.remove(); this.children.push(c); c.parentNode = this; return c; }
    append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new Node(null, c) : c); }
    remove() { if (!this.parentNode) return; const k = this.parentNode.children; k.splice(k.indexOf(this), 1); this.parentNode = null; }
    contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    matches(sel) { return sel.split(',').some((s) => matchOne(this, s.trim())); }
    closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (c.nodeType === 1 && c.matches(sel)) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    getClientRects() { for (let n = this; n; n = n.parentNode) if (n.hidden) return []; return this.isConnected ? [{}] : []; }
    addEventListener(t, fn, o) { (this.listeners[t] ||= []).push({ fn, once: !!(o && o.once) }); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((l) => l.fn !== fn); }
    focus() { const prev = doc.activeElement; if (prev === this) return; doc.activeElement = this; if (prev && prev !== doc.body) fire(prev, 'blur'); fire(this, 'focus'); }
    blur() { if (doc.activeElement !== this) return; doc.activeElement = doc.body; fire(this, 'blur'); }
  }
  function matchOne(n, s) {
    const m = /^([a-z]*)((?:\.[\w-]+|\[[^\]]+\])*)$/i.exec(s);
    if (!m || n.nodeType !== 1) return false;
    if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
    for (const part of m[2].match(/\.[\w-]+|\[[^\]]+\]/g) || []) {
      if (part[0] === '.') { if (!n.cls.has(part.slice(1))) return false; continue; }
      const a = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
      const v = a[1] === 'open' ? (n.open ? '' : null) : n.getAttribute(a[1]);
      if (v === null || (a[2] !== undefined && v !== a[2])) return false;
    }
    return true;
  }
  function fire(node, type, ev = {}) {
    const e = Object.assign({ type, target: node, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }, ev);
    const run = (holder) => {
      const ls = holder.listeners[type] || [];
      holder.listeners[type] = ls.filter((l) => !l.once);
      for (const l of ls) l.fn(e);
    };
    for (let n = node; n && !e.stopped; n = n.parentNode) run(n);
    if (!e.stopped) run(win);
    return e;
  }
  const doc = {
    documentElement: new Node('html'),
    createElement: (t) => new Node(t),
    createTextNode: (s) => new Node(null, s),
    getElementById: (id) => doc.documentElement.querySelectorAll('*').find((n) => n.id === id) || null,
    querySelectorAll: (sel) => doc.documentElement.querySelectorAll(sel),
    hasFocus: () => true,
  };
  // '*' support for getElementById
  const baseMatch = Node.prototype.matches;
  Node.prototype.matches = function (sel) { return sel === '*' ? this.nodeType === 1 : baseMatch.call(this, sel); };
  doc.head = doc.documentElement.appendChild(new Node('head'));
  doc.body = doc.documentElement.appendChild(new Node('body'));
  doc.activeElement = doc.body;
  win.addEventListener = (t, fn) => { (win.listeners[t] ||= []).push({ fn, once: false }); };
  win.removeEventListener = (t, fn) => { win.listeners[t] = (win.listeners[t] || []).filter((l) => l.fn !== fn); };
  win.matchMedia = () => ({ matches: false });
  const key = (target, code, extra = {}) => fire(target || doc.activeElement || doc.body, 'keydown',
    { code, key: extra.key ?? (code.startsWith('Key') ? code.slice(3).toLowerCase() : code.replace(/^Digit/, '')), repeat: false,
      ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 0, ...extra });
  return { doc, win, Node, fire, key };
}

function withDom(fn) {
  const dom = makeDom();
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.doc;
  globalThis.window = dom.win;
  const realNow = performance.now;
  let clock = 100000;
  performance.now = () => clock;
  const advance = (ms) => { clock += ms; };
  // intervals run by hand (the feed fade ticker), timeouts stay real (dispose clears them)
  const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
  const intervals = new Map();
  let nextInterval = 1e6;
  globalThis.setInterval = (fn) => { intervals.set(++nextInterval, fn); return nextInterval; };
  globalThis.clearInterval = (id) => { if (!intervals.delete(id)) realClearInterval(id); };
  const tickIntervals = () => { for (const fn of [...intervals.values()]) fn(); };
  const sent = [];
  const typing = [];
  const lobbyBox = dom.doc.body.appendChild(dom.doc.createElement('div'));
  const gameBox = dom.doc.body.appendChild(dom.doc.createElement('div'));
  const chat = clientChat.createChat(lobbyBox, { send: (m) => sent.push(m), myId: 1, gameContainer: gameBox, onTyping: (on) => typing.push(on) });
  const root = lobbyBox.children[0];
  const q = (sel) => root.querySelectorAll(sel);
  const input = q('.ir-chat-input')[0];
  try {
    fn({ ...dom, chat, root, q, input, sent, typing, lobbyBox, gameBox, advance, tickIntervals, intervals });
  } finally {
    chat.dispose();
    performance.now = realNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  }
}
const say2 = (from, name, team, text, ts, extra = {}) => ({ t: 'chat', from, name, team, text, emote: null, ts, ...extra });
const TS = new Date(2026, 10, 21, 19, 2).getTime();

test('client: builds the rail chat (header, log, 8 quick chips, input) and injects one style tag', () => {
  withDom(({ doc, root, q, input }) => {
    assert.ok(root.classList.contains('ir-chat') && root.classList.contains('ir-chat--lobby'));
    assert.equal(q('.ir-chat-title')[0].textContent, 'Chat');
    assert.equal(q('.ir-chat-hint')[0].textContent, 'Tto type');
    assert.deepEqual(q('.ir-chat-chip-label').map((n) => n.textContent), [...QUICK_CHAT]);
    assert.deepEqual(q('.ir-chat-num').map((n) => n.textContent), ['1', '2', '3', '4', '5', '6', '7', '8']);
    assert.equal(input.placeholder, 'Say something');
    assert.equal(input.maxLength, CHAT_MAX_LEN);
    assert.equal(q('.ir-chat-keys')[0].textContent, 'Enter sends · Esc closes');
    assert.equal(q('.ir-chat-toggle-label')[0].textContent, 'Chat · 1-8 quick');
    assert.equal(doc.querySelectorAll('style').length, 1);
    assert.equal(q('.ir-chat-empty').length, 1);
  });
});

test('client: lines carry name (team class) + time + text; system lines are bare; HTML stays text', () => {
  withDom(({ chat, q }) => {
    chat.receive(say2(2, 'Mags', 0, 'who\'s bringing snacks', TS));
    chat.receive(say2(0, '', -1, 'DeepFreeze joined away', TS + 1));
    chat.receive(say2(3, 'DeepFreeze', 1, '<b>not bold</b>', TS + 60000));
    chat.receive(say2(4, 'Toaster', -1, 'watching first', TS + 120000));
    const lines = q('.ir-chat-line');
    assert.equal(lines.length, 4);
    assert.equal(q('.ir-chat-empty').length, 0, 'empty note goes with the first line');
    assert.ok(lines[0].querySelectorAll('.ir-chat-name')[0].classList.contains('ir-chat-name--home'));
    assert.equal(lines[0].querySelectorAll('.ir-chat-name')[0].textContent, 'Mags');
    assert.equal(lines[0].querySelectorAll('.ir-chat-time')[0].textContent, '19:02');
    assert.equal(lines[0].querySelectorAll('.ir-chat-text')[0].textContent, 'who\'s bringing snacks');
    assert.ok(lines[1].classList.contains('ir-chat-line--sys'));
    assert.equal(lines[1].querySelectorAll('.ir-chat-name').length, 0);
    assert.ok(lines[2].querySelectorAll('.ir-chat-name')[0].classList.contains('ir-chat-name--away'));
    assert.equal(lines[2].querySelectorAll('.ir-chat-text')[0].textContent, '<b>not bold</b>');
    assert.equal(lines[2].querySelectorAll('b').length, 0);
    assert.ok(lines[3].querySelectorAll('.ir-chat-name')[0].classList.contains('ir-chat-name--spec'));
  });
});

test('client: emotes, own lines, duplicates and replayed history', () => {
  withDom(({ chat, q }) => {
    chat.receive({ t: 'chat', from: 3, name: 'Rook', team: 1, emote: 4, ts: TS });
    chat.receive({ t: 'chat', from: 1, name: 'You', team: 0, text: 'mine', emote: null, ts: TS + 1 });
    chat.receive({ t: 'chat', from: 1, name: 'You', team: 0, text: 'mine', emote: null, ts: TS + 1, hist: true });
    chat.receive({ t: 'nope', text: 'x' });
    chat.receive({ t: 'chat', from: 2, text: '', ts: 5 });
    const lines = q('.ir-chat-line');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].classList.contains('ir-chat-line--emote'));
    assert.equal(lines[0].querySelectorAll('.ir-chat-text')[0].textContent, 'What a hit!');
    assert.ok(lines[1].classList.contains('ir-chat-line--me'));
    chat.setMyId(3);
    assert.ok(lines[0].classList.contains('ir-chat-line--me'));
    assert.ok(!lines[1].classList.contains('ir-chat-line--me'));
  });
});

test('client: lobby T focuses the input (onTyping), Enter sends, Esc blurs; not while hidden or under a dialog', () => {
  withDom(({ doc, chat, key, input, sent, typing, lobbyBox }) => {
    const e = key(doc.body, 'KeyT');
    assert.ok(e.defaultPrevented, 'the t never reaches the input');
    assert.equal(doc.activeElement, input);
    assert.ok(chat.isTyping());
    assert.deepEqual(typing, [true]);
    input.value = '   hello    rink  ';
    const ent = key(input, 'Enter', { key: 'Enter' });
    assert.ok(ent.stopped, 'keys typed into the chat never bubble to the game');
    assert.deepEqual(sent, [{ t: 'chat', text: 'hello rink' }]);
    assert.equal(input.value, '');
    assert.equal(doc.activeElement, input, 'lobby input keeps focus after sending');
    key(input, 'Enter', { key: 'Enter' });
    assert.equal(sent.length, 1, 'empty input sends nothing');
    key(input, 'Escape', { key: 'Escape' });
    assert.equal(doc.activeElement, doc.body);
    assert.deepEqual(typing, [true, false]);
    // a sheet with aria-modal owns the keyboard
    const sheet = doc.body.appendChild(doc.createElement('div'));
    sheet.setAttribute('aria-modal', 'true');
    assert.ok(!key(doc.body, 'KeyT').defaultPrevented);
    assert.equal(doc.activeElement, doc.body);
    sheet.hidden = true;
    key(doc.body, 'KeyT');
    assert.equal(doc.activeElement, input, 'a hidden sheet does not block');
    input.blur();
    // hidden chat (e.g. the rail is display:none) ignores T; other typing targets too
    lobbyBox.hidden = true;
    assert.ok(!key(doc.body, 'KeyT').defaultPrevented);
    lobbyBox.hidden = false;
    const other = doc.body.appendChild(doc.createElement('input'));
    other.focus();
    assert.ok(!key(other, 'KeyT').defaultPrevented);
    assert.equal(doc.activeElement, other);
    // modifiers / Enter do nothing in the lobby
    other.blur();
    assert.ok(!key(doc.body, 'KeyT', { ctrlKey: true }).defaultPrevented);
    assert.ok(!key(doc.body, 'Enter', { key: 'Enter' }).defaultPrevented);
    assert.ok(!key(doc.body, 'Digit1').defaultPrevented, 'quick keys are in-game only');
    assert.equal(sent.length, 1);
  });
});

test('client: lobby chips send quick lines with a 2 s cooldown (chips dim meanwhile)', () => {
  withDom(({ chat, q, fire, root, sent, advance }) => {
    const chips = q('.ir-chat-chip');
    fire(chips[5], 'click');
    assert.deepEqual(sent, [{ t: 'emote', id: 5 }]);
    assert.ok(root.classList.contains('ir-chat--cooldown'));
    fire(chips[1], 'click');
    assert.equal(sent.length, 1, 'cooldown');
    advance(clientChat.EMOTE_COOLDOWN_MS);
    assert.equal(chat.sendQuick(1), true);
    assert.equal(chat.sendQuick(99), false);
    assert.deepEqual(sent.at(-1), { t: 'emote', id: 1 });
  });
});

test('client: in-game feed moves to the game container; T / Enter open the panel; Esc / Enter close it', () => {
  withDom(({ doc, chat, root, key, input, sent, typing, gameBox }) => {
    chat.setInGame(true);
    assert.equal(root.parentNode, gameBox);
    assert.ok(root.classList.contains('ir-chat--game') && !root.classList.contains('ir-chat--lobby'));
    assert.ok(!chat.isTyping());
    key(doc.body, 'KeyT');
    assert.ok(root.classList.contains('ir-chat--panel') && root.classList.contains('ir-chat--open'));
    assert.ok(chat.isTyping());
    assert.equal(doc.activeElement, input);
    assert.deepEqual(typing, [true]);
    key(input, 'Escape', { key: 'Escape' });
    assert.ok(!chat.isTyping());
    assert.ok(!root.classList.contains('ir-chat--open'));
    assert.deepEqual(typing, [true, false]);
    key(doc.body, 'Enter', { key: 'Enter' });
    assert.ok(chat.isTyping());
    input.value = 'gg go again';
    key(input, 'Enter', { key: 'Enter' });
    assert.deepEqual(sent, [{ t: 'chat', text: 'gg go again' }]);
    assert.ok(!chat.isTyping(), 'sending closes the in-game panel');
    // clicking away closes it too
    chat.open();
    input.blur();
    assert.ok(!chat.isTyping());
    // back to the lobby: panel classes cleared, root returns home
    chat.open();
    chat.setInGame(false);
    assert.ok(!root.classList.contains('ir-chat--panel') && !root.classList.contains('ir-chat--game'));
    assert.ok(!chat.isTyping());
    assert.equal(typing.at(-1), false);
  });
});

test('client: in-game 1-8 send quick lines (cooldown, repeat ignored); no keys while a field has focus', () => {
  withDom(({ doc, chat, key, sent, advance }) => {
    chat.setInGame(true);
    assert.ok(key(doc.body, 'Digit3').defaultPrevented);
    assert.deepEqual(sent, [{ t: 'emote', id: 2 }]);
    key(doc.body, 'Digit4');
    assert.equal(sent.length, 1, 'cooldown');
    advance(2500);
    key(doc.body, 'Numpad8', { repeat: true });
    assert.equal(sent.length, 1, 'auto-repeat ignored');
    key(doc.body, 'Numpad8');
    assert.deepEqual(sent.at(-1), { t: 'emote', id: 7 });
    advance(2500);
    key(doc.body, 'Digit9');
    key(doc.body, 'Digit0');
    assert.equal(sent.length, 2);
    const other = doc.body.appendChild(doc.createElement('textarea'));
    other.focus();
    key(other, 'Digit1');
    assert.equal(sent.length, 2);
  });
});

test('client: in-game lines fade after FEED_MS; history lines arrive faded; panel quick chips close it', () => {
  withDom(({ chat, q, fire, advance, tickIntervals, intervals, sent, input, doc }) => {
    chat.receive(say2(2, 'Mags', 0, 'lobby talk', TS));
    chat.setInGame(true);
    assert.ok(q('.ir-chat-line')[0].classList.contains('ir-chat-line--faded'), 'lobby chatter starts faded');
    chat.receive(say2(3, 'DeepFreeze', 1, 'What a hit!', TS + 1));
    chat.receive(say2(3, 'DeepFreeze', 1, 'old', TS + 2, { hist: true }));
    const [, live, hist] = q('.ir-chat-line');
    assert.ok(!live.classList.contains('ir-chat-line--faded'));
    assert.ok(hist.classList.contains('ir-chat-line--faded'));
    chat.open();
    fire(q('.ir-chat-chip')[0], 'click');
    assert.deepEqual(sent, [{ t: 'emote', id: 0 }]);
    assert.ok(!chat.isTyping());
    assert.notEqual(doc.activeElement, input);
    advance(clientChat.FEED_MS - 10);
    tickIntervals();
    assert.ok(!live.classList.contains('ir-chat-line--faded'), 'still up just before FEED_MS');
    advance(10);
    tickIntervals();
    assert.ok(live.classList.contains('ir-chat-line--faded'));
    chat.setInGame(false);
    assert.equal(intervals.size, 0, 'fade ticker stops in the lobby');
  });
});

test('client: setTeamColors lifts dark team colours; dispose cleans up', () => {
  withDom(({ doc, chat, root, win }) => {
    chat.setTeamColors([0x14213d, '#7fd3ff']);
    assert.notEqual(root.style.props['--ir-chat-home'], '#14213d');
    assert.equal(root.style.props['--ir-chat-away'], '#7fd3ff');
    chat.setTeamColors([null, 'nope']);
    assert.deepEqual([root.style.props['--ir-chat-home'], root.style.props['--ir-chat-away']], [...clientChat.DEFAULT_TEAM_COLORS]);
    chat.dispose();
    assert.equal(root.parentNode, null);
    assert.equal(doc.querySelectorAll('style').length, 0);
    assert.equal((win.listeners.keydown || []).length, 0);
    assert.equal(chat.isTyping(), false);
  });
});

test('client: in-game presses on the chat do not bubble to window mouse handlers', () => {
  withDom(({ chat, q, fire }) => {
    chat.setInGame(true);
    const toggle = q('.ir-chat-toggle')[0];
    assert.ok(fire(toggle, 'mousedown', { button: 0 }).stopped);
    assert.ok(fire(toggle, 'pointerdown', { button: 0 }).stopped);
    chat.setInGame(false);
    assert.ok(!fire(toggle, 'mousedown', { button: 0 }).stopped, 'lobby clicks bubble normally');
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
