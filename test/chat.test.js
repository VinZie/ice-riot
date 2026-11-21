// ICE RIOT - chat tests. Run: node test/chat.test.js (exit code 1 on any failure).
// Covers server/chat.js (sanitization, rate limiting + refill, emote validation, history, forget)
// and checks that public/chat.js loads without a DOM and ships the same QUICK_CHAT list.

import assert from 'node:assert/strict';
import { createChat, sanitizeChat, QUICK_CHAT, CHAT_MAX_LEN } from '../server/chat.js';
import * as clientChat from '../public/chat.js';

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
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
