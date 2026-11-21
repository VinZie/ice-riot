// ICE RIOT - couch co-op tests (node test/couch.test.js). Exit code 1 on failure.
//
// Runs a tiny fake game server (http + minimal RFC 6455 handshake/framing, implemented here so the
// test does not depend on server/*), mocks navigator.getGamepads() with fake pads, and drives
// public/couch.js through Node's built-in WebSocket client.

import http from 'node:http';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createCouch, mapPad, readButtons, PAD, LEAVE_HOLD_MS } from '../public/couch.js';
import { BTN } from '../shared/constants.js';

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------
// Fake gamepads
// ------------------------------------------------------------------------------------------------

function makePad(index) {
  return {
    index, id: `Fake Pad ${index} (STANDARD GAMEPAD)`, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
}
let pads = [];
const resetPads = () => { pads = [0, 1, 2, 3].map(makePad); };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { getGamepads: () => pads },
});
function press(pad, i, on = true) { pad.buttons[i].pressed = on; pad.buttons[i].value = on ? 1 : 0; }
const release = (pad, i) => press(pad, i, false);

// ------------------------------------------------------------------------------------------------
// Fake server: hello -> welcome + lobby broadcast; pick -> team + lobby broadcast; records everything.
// ------------------------------------------------------------------------------------------------

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(op, payload) {
  const len = payload.length;
  let h;
  if (len < 126) h = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
  return Buffer.concat([h, payload]);
}

async function startServer() {
  const room = { state: 'lobby', extra: [], nextId: 10, conns: [], pickErr: null };
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });

  const sendTo = (c, obj) => { if (c.open) c.socket.write(frame(1, Buffer.from(JSON.stringify(obj)))); };
  function broadcastLobby() {
    const clients = [...room.extra, ...room.conns.filter((c) => c.open && c.id).map((c) => ({ id: c.id, name: c.name, team: c.team, ping: 0 }))];
    const msg = { t: 'lobby', state: room.state, host: 1, clients, config: {} };
    for (const c of room.conns) if (c.open && c.id) sendTo(c, msg);
  }
  function markClosed(c) {
    if (!c.open) return;
    c.open = false;
    c.closedAt = now();
    broadcastLobby();
  }
  function onText(c, str) {
    let m;
    try { m = JSON.parse(str); } catch { return; }
    m._at = now();
    c.msgs.push(m);
    if (m.t === 'hello') {
      c.id = room.nextId++;
      c.name = m.name;
      c.room = m.room;
      sendTo(c, { t: 'welcome', id: c.id, room: m.room || 'main' });
      broadcastLobby();
    } else if (m.t === 'pick') {
      if (room.pickErr) { sendTo(c, { t: 'err', msg: room.pickErr }); return; }
      c.team = m.team;
      broadcastLobby();
    }
  }

  srv.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    const c = { socket, open: true, id: 0, name: '', room: '', team: -1, msgs: [], openedAt: now(), closedAt: 0, url: req.url };
    room.conns.push(c);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        const masked = buf[1] & 0x80;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
        const maskAt = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i & 3)];
        buf = buf.subarray(off + len);
        if (op === 1) onText(c, payload.toString('utf8'));
        else if (op === 8) {            // close: echo and hang up
          if (c.open) { c.socket.end(frame(8, Buffer.from([0x03, 0xe8]))); }
          c.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          markClosed(c);
          return;
        } else if (op === 9) socket.write(frame(10, payload));
      }
    });
    socket.on('close', () => markClosed(c));
    socket.on('error', () => {});
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return {
    room,
    url: `ws://127.0.0.1:${port}/ws`,
    open: () => room.conns.filter((c) => c.open),
    byPadName: (name) => room.conns.filter((c) => c.name === name),
    setState(st) { room.state = st; broadcastLobby(); },
    broadcastLobby,
    sendTo,
    kill(c) { c.socket.destroy(); markClosed(c); },
    snapAll() { for (const c of room.conns) if (c.open && c.id) sendTo(c, { t: 'snap', time: now(), tick: 1, ph: 2, p: [], k: { x: 0, y: 0, z: 0, o: -1 }, ev: [] }); },
    async close() {
      for (const c of room.conns) c.socket.destroy();
      await new Promise((r) => srv.close(r));
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Harness
// ------------------------------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function mk(ctx, opts = {}) {
  ctx.changes = [];
  ctx.couch = createCouch({ wsUrl: ctx.url, onChange: (list, err) => ctx.changes.push({ list, err }), ...opts });
  return ctx.couch;
}

// Run the "game loop" (update every ~8 ms) for ms milliseconds.
async function frames(couch, ms) {
  const end = now() + ms;
  while (now() < end) { couch.update(); await sleep(8); }
}

// Run frames until pred() is truthy.
async function until(couch, pred, what, timeout = 2500) {
  const end = now() + timeout;
  for (;;) {
    couch.update();
    const v = pred();
    if (v) return v;
    if (now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(8);
  }
}

const ins = (c) => c.msgs.filter((m) => m.t === 'in');
const lastIn = (c) => { const a = ins(c); return a[a.length - 1]; };
const types = (c) => c.msgs.map((m) => m.t);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

async function joinPad(ctx, couch, padIndex, buttons = [PAD.START], { release: rel = true } = {}) {
  const before = ctx.room.conns.length;
  for (const b of buttons) press(pads[padIndex], b);
  couch.update();
  const c = await until(couch, () => ctx.room.conns.slice(before).find((x) => x.id && x.msgs.some((m) => m.t === 'pick')), `pad ${padIndex} hello+pick`);
  if (rel) for (const b of buttons) release(pads[padIndex], b);
  await until(couch, () => couch.list().some((e) => e.pad === padIndex && e.connected && e.clientId === c.id), `pad ${padIndex} listed online`);
  return c;
}

// ------------------------------------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------------------------------------

test('mapPad: deadzone, scaling, d-pad, buttons, normalization (same as input.js)', () => {
  const out = { mx: 0, mz: 0, b: 0 };
  const p = makePad(1);
  const m = () => mapPad(p, readButtons(p), out);

  p.axes = [0.1, 0.1, 0, 0]; m();
  assert.equal(out.mx, 0); assert.equal(out.mz, 0); assert.equal(out.b, 0);
  p.axes = [0.19, 0, 0, 0]; m(); assert.equal(out.mx, 0, 'inside radial deadzone');
  p.axes = [0.6, 0, 0, 0]; m(); assert.ok(near(out.mx, 0.5), `rescaled past deadzone: ${out.mx}`);
  p.axes = [1, 0, 0, 0]; m(); assert.ok(near(out.mx, 1)); assert.equal(out.mz, 0);
  p.axes = [0, -1, 0, 0]; m(); assert.ok(near(out.mz, -1), 'stick up = screen up = -mz');
  p.axes = [0, 1, 0, 0]; m(); assert.ok(near(out.mz, 1), 'stick down = +mz');
  p.axes = [1, 1, 0, 0]; m(); assert.ok(near(Math.hypot(out.mx, out.mz), 1), 'diagonal clamped to unit length');
  p.axes = [NaN, Infinity, 0, 0]; m(); assert.equal(out.mx, 0); assert.equal(out.mz, 0);
  p.axes = [0, 0, 1, 1]; m(); assert.equal(out.mx, 0, 'right stick ignored');

  p.axes = [0, 0, 0, 0];
  press(p, PAD.UP); m(); assert.equal(out.mz, -1, 'd-pad up = -mz');
  press(p, PAD.LEFT); m(); assert.ok(near(out.mx, -Math.SQRT1_2) && near(out.mz, -Math.SQRT1_2), 'd-pad diagonal normalized');
  release(p, PAD.UP); release(p, PAD.LEFT);
  press(p, PAD.DOWN); m(); assert.equal(out.mz, 1);
  release(p, PAD.DOWN); press(p, PAD.RIGHT); p.axes = [1, 0, 0, 0]; m(); assert.ok(near(out.mx, 1), 'stick + d-pad clamped');
  release(p, PAD.RIGHT); p.axes = [0, 0, 0, 0];

  const btn = (i, expect) => { press(p, i); m(); assert.equal(out.b, expect, `button ${i}`); release(p, i); };
  btn(PAD.A, BTN.SHOOT);
  btn(PAD.X, BTN.PASS);
  btn(PAD.B, BTN.ACTION);
  btn(PAD.RB, BTN.TURBO);
  btn(PAD.RT, BTN.TURBO);
  btn(PAD.LT, BTN.TURBO);
  btn(PAD.Y, 0);
  btn(PAD.LB, 0);
  btn(PAD.START, 0);
  btn(PAD.SELECT, 0);
  // analog triggers: value above 0.35 counts even if `pressed` is false
  p.buttons[PAD.RT] = { pressed: false, value: 0.5 }; m(); assert.equal(out.b, BTN.TURBO, 'analog RT 0.5');
  p.buttons[PAD.RT] = { pressed: false, value: 0.2 }; m(); assert.equal(out.b, 0, 'analog RT 0.2');
  p.buttons[PAD.RT] = { pressed: false, value: 0 };
  press(p, PAD.A); press(p, PAD.X); press(p, PAD.RB); m();
  assert.equal(out.b, BTN.SHOOT | BTN.PASS | BTN.TURBO, 'combined');
  // legacy numeric buttons
  const q = { axes: [0, 0], buttons: [1, 0, 0.9] }; mapPad(q, readButtons(q), out);
  assert.equal(out.b, BTN.SHOOT | BTN.PASS);
});

test('reservePads: reserved pads never join, others do', async (ctx) => {
  const couch = mk(ctx);
  press(pads[0], PAD.START); press(pads[0], PAD.A);
  await frames(couch, 300);
  assert.equal(ctx.room.conns.length, 0, 'pad 0 is reserved for the main player');
  assert.equal(couch.list().length, 0);
  await frames(couch, 100);  // other pads idle: nothing happens
  assert.equal(ctx.room.conns.length, 0);
  await joinPad(ctx, couch, 1);
  assert.equal(ctx.room.conns.length, 1);
  couch.dispose();

  // reservePads = 2: pad 1 is reserved too
  resetPads();
  const c2 = mk(ctx, { reservePads: 2 });
  const before = ctx.room.conns.length;
  press(pads[1], PAD.START);
  await frames(c2, 300);
  assert.equal(ctx.room.conns.length, before, 'pad 1 reserved with reservePads=2');
  const c = await joinPad(ctx, c2, 2);
  assert.equal(c.name, 'Couch P3', 'numbering starts after the reserved pads');
});

test('join on START: hello, welcome -> clientId, list(), clientIds(), onChange', async (ctx) => {
  const couch = mk(ctx);
  const c = await joinPad(ctx, couch, 1);
  const hello = c.msgs[0];
  assert.equal(hello.t, 'hello');
  assert.equal(hello.name, 'Couch P2');
  assert.equal(hello.room, 'main');
  const e = couch.list().find((x) => x.pad === 1);
  assert.deepEqual({ ...e }, { pad: 1, clientId: c.id, name: 'Couch P2', team: c.team, connected: true });
  assert.ok(couch.clientIds().has(c.id));
  assert.equal(couch.clientIds().size, 1);
  assert.ok(ctx.changes.length >= 2, 'onChange on join and on welcome');
  assert.ok(ctx.changes.some((ch) => ch.list.some((x) => x.clientId === c.id && x.connected)));
  // list() is cached between changes (no per-frame allocation)
  assert.equal(couch.list(), couch.list());

  // second pad gets the next free number; custom room/prefix are used
  couch.dispose();
  resetPads();
  const c2 = mk(ctx, { room: 'den', namePrefix: 'Sofa' });
  const a = await joinPad(ctx, c2, 2);
  const b = await joinPad(ctx, c2, 3, [PAD.A]);
  assert.equal(a.msgs[0].name, 'Sofa P2');
  assert.equal(a.msgs[0].room, 'den');
  assert.equal(b.msgs[0].name, 'Sofa P3');
  assert.equal(c2.list().length, 2);
});

test('sequence: hello -> pick -> (nothing while lobby) -> in only once state is game', async (ctx) => {
  ctx.room.extra = [{ id: 1, name: 'Main', team: 0, ping: 0 }];
  const couch = mk(ctx);
  const c = await joinPad(ctx, couch, 1);
  pads[1].axes = [1, 0, 0, 0];
  await frames(couch, 300);
  assert.deepEqual(types(c), ['hello', 'pick'], 'no input in the lobby');
  ctx.setState('game');
  await until(couch, () => ins(c).length >= 5, '5 in messages');
  assert.deepEqual(types(c).slice(0, 3), ['hello', 'pick', 'in']);
  const seqs = ins(c).map((m) => m.seq);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'seq increases');
  const m = lastIn(c);
  assert.deepEqual(Object.keys(m).filter((k) => k !== '_at').sort(), ['b', 'mx', 'mz', 'seq', 't']);
  assert.equal(m.mx, 1); assert.equal(m.mz, 0); assert.equal(m.b, 0);
  // snapshots arriving on the couch socket are ignored without trouble
  for (let i = 0; i < 5; i++) ctx.snapAll();
  await frames(couch, 100);
  // back to the lobby: input stops
  ctx.setState('lobby');
  await frames(couch, 120);
  const n = ins(c).length;
  await frames(couch, 250);
  assert.equal(ins(c).length, n, 'no input after returning to the lobby');
});

test('team choice: A = fewer humans, LB = home, RB = away, simultaneous joins split, both full = spectate', async (ctx) => {
  ctx.room.extra = [{ id: 1, name: 'Main', team: 0, ping: 0 }];
  const couch = mk(ctx);
  const p1 = await joinPad(ctx, couch, 1, [PAD.A]);
  assert.equal(p1.msgs[1].team, 1, 'main on home -> away has fewer');
  const p2 = await joinPad(ctx, couch, 2, [PAD.A]);
  assert.equal(p2.msgs[1].team, 0, 'tie (1 v 1) -> home');
  const p3 = await joinPad(ctx, couch, 3, [PAD.LB, PAD.START]);
  assert.equal(p3.msgs[1].team, 0, 'LB = home even though home has more');
  await until(couch, () => couch.list().every((e) => e.team === ctx.room.conns.find((c) => c.id === e.clientId).team), 'list teams track lobby');
  assert.deepEqual(couch.list().map((e) => e.team), [1, 0, 0]);

  // lobby: RB switches pad 3 to away
  press(pads[3], PAD.RB); couch.update(); release(pads[3], PAD.RB);
  await until(couch, () => couch.list().find((e) => e.pad === 3).team === 1, 'pad 3 switched to away');
  assert.deepEqual(p3.msgs.filter((m) => m.t === 'pick').map((m) => m.team), [0, 1]);
  couch.dispose();
  await frames(couch, 50);

  // RB held at join = away even when away has more
  resetPads();
  ctx.room.extra = [{ id: 2, name: 'Remote', team: 1, ping: 0 }];
  const c2 = mk(ctx);
  const r = await joinPad(ctx, c2, 1, [PAD.RB, PAD.A]);
  assert.equal(r.msgs[1].team, 1, 'RB = away');
  c2.dispose();
  await frames(c2, 50);

  // two pads pressing A in the same frame still split up
  resetPads();
  ctx.room.extra = [{ id: 1, name: 'Main', team: 0, ping: 0 }];
  const c3 = mk(ctx);
  const before = ctx.room.conns.length;
  press(pads[1], PAD.A); press(pads[2], PAD.A);
  c3.update();
  await until(c3, () => ctx.room.conns.slice(before).filter((c) => c.msgs.some((m) => m.t === 'pick')).length === 2, 'two picks');
  const picks = ctx.room.conns.slice(before).map((c) => c.msgs.find((m) => m.t === 'pick').team).sort();
  assert.deepEqual(picks, [0, 1], 'main(home) + 2 couch -> one home, one away');
  c3.dispose();
  await frames(c3, 50);

  // both teams full -> spectate instead of a doomed pick
  resetPads();
  ctx.room.extra = [0, 0, 0, 1, 1, 1].map((team, i) => ({ id: 100 + i, name: `R${i}`, team, ping: 0 }));
  const c4 = mk(ctx);
  const s = await joinPad(ctx, c4, 1, [PAD.A]);
  assert.equal(s.msgs[1].team, -1);
});

test('input over the wire: mapping, deadzone, buttons held at join are ignored until released', async (ctx) => {
  ctx.setState('game');   // mid-game drop-in
  const couch = mk(ctx);
  const c = await joinPad(ctx, couch, 1, [PAD.A], { release: false });  // A still held
  await until(couch, () => ins(c).length >= 3, 'input flowing');
  await frames(couch, 80);
  assert.equal(lastIn(c).b, 0, 'the A that joined does not shoot');
  release(pads[1], PAD.A);
  await frames(couch, 60);
  press(pads[1], PAD.A);
  await until(couch, () => lastIn(c).b === BTN.SHOOT, 'A = SHOOT after re-press');
  release(pads[1], PAD.A);

  const expectIn = async (what, fn) => { await until(couch, () => fn(lastIn(c)), what); };
  pads[1].axes = [0.15, -0.1, 0, 0];
  await expectIn('deadzone -> 0', (m) => m.mx === 0 && m.mz === 0 && m.b === 0);
  pads[1].axes = [0.6, 0, 0, 0];
  await expectIn('0.6 -> 0.5', (m) => m.mx === 0.5 && m.mz === 0);
  pads[1].axes = [0, -1, 0, 0];
  await expectIn('stick up -> mz -1', (m) => m.mz === -1 && m.mx === 0);
  pads[1].axes = [0.70710678, 0.70710678, 0, 0];
  await expectIn('diagonal rounded to 3 decimals', (m) => m.mx === 0.707 && m.mz === 0.707);
  pads[1].axes = [0, 0, 0, 0];
  press(pads[1], PAD.LEFT);
  await expectIn('d-pad left -> mx -1', (m) => m.mx === -1);
  release(pads[1], PAD.LEFT);
  press(pads[1], PAD.X);
  await expectIn('X = PASS', (m) => m.b === BTN.PASS);
  release(pads[1], PAD.X); press(pads[1], PAD.B);
  await expectIn('B = ACTION', (m) => m.b === BTN.ACTION);
  release(pads[1], PAD.B); press(pads[1], PAD.RT);
  await expectIn('RT = TURBO', (m) => m.b === BTN.TURBO);
  release(pads[1], PAD.RT); press(pads[1], PAD.LT);
  await expectIn('LT = TURBO', (m) => m.b === BTN.TURBO);
  release(pads[1], PAD.LT); press(pads[1], PAD.RB);
  await expectIn('RB = TURBO (and no team switch in game)', (m) => m.b === BTN.TURBO);
  release(pads[1], PAD.RB);
  assert.equal(c.msgs.filter((m) => m.t === 'pick').length, 1, 'LB/RB do not re-pick during a game');
});

test('input rate is capped at 60 Hz even when update() runs much faster', async (ctx) => {
  ctx.setState('game');
  const couch = mk(ctx);
  const c = await joinPad(ctx, couch, 1);
  await until(couch, () => ins(c).length > 0, 'input flowing');
  const seq0 = lastIn(c).seq;
  await sleep(50);
  const seqA = lastIn(c).seq;
  // busy "frames": thousands of update() calls in 500 ms
  const t0 = now();
  let calls = 0;
  while (now() - t0 < 500) { couch.update(); calls++; }
  const elapsed = now() - t0;
  await sleep(100);  // let the sends flush
  const sent = ins(c).filter((m) => m.seq > seqA).length;
  const max = Math.ceil(elapsed / (1000 / 60)) + 1;
  assert.ok(calls > 1000, `update() ran ${calls} times`);
  assert.ok(sent <= max, `sent ${sent} in ${elapsed.toFixed(0)} ms (max ${max})`);
  assert.ok(sent >= max - 4, `still ~60 Hz: sent ${sent} (max ${max})`);
  assert.ok(seqA >= seq0);
});

test('setPaused(true) sends zero input, setPaused(false) resumes', async (ctx) => {
  ctx.setState('game');
  const couch = mk(ctx);
  const c = await joinPad(ctx, couch, 1);
  pads[1].axes = [1, 0, 0, 0];
  press(pads[1], PAD.A); press(pads[1], PAD.RB);
  await until(couch, () => { const m = lastIn(c); return m && m.mx === 1 && m.b === (BTN.SHOOT | BTN.TURBO); }, 'live input');
  couch.setPaused(true);
  couch.update();
  const n = ins(c).length;
  await frames(couch, 200);
  const during = ins(c).slice(n + 1);
  assert.ok(during.length >= 5, `still sending while paused (${during.length})`);
  for (const m of during) assert.deepEqual([m.mx, m.mz, m.b], [0, 0, 0], 'zero input while paused');
  couch.setPaused(false);
  await until(couch, () => { const m = lastIn(c); return m.mx === 1 && m.b === (BTN.SHOOT | BTN.TURBO); }, 'input resumes');
});

test('SELECT held 1 s leaves (socket closed); a shorter hold does not; START rejoins', async (ctx) => {
  const couch = mk(ctx);
  const c = await joinPad(ctx, couch, 1);
  press(pads[1], PAD.SELECT);
  await frames(couch, 500);
  release(pads[1], PAD.SELECT);
  await frames(couch, 50);
  press(pads[1], PAD.SELECT);
  await frames(couch, 600);
  assert.ok(c.open, 'two 0.5-0.6 s holds do not add up');
  const t0 = now();
  await until(couch, () => !c.open, 'socket closed after the hold', 2000);
  const held = now() - t0 + 600;
  assert.ok(held >= LEAVE_HOLD_MS - 20, `closed after ~${held.toFixed(0)} ms of holding`);
  assert.equal(c.closeCode, 1000, 'clean close');
  assert.equal(couch.list().length, 0);
  assert.equal(couch.clientIds().size, 0);
  assert.equal(ctx.changes[ctx.changes.length - 1].list.length, 0, 'onChange told about the leave');
  // still holding SELECT / no reconnect after a deliberate leave
  await frames(couch, 800);
  assert.equal(ctx.room.conns.length, 1, 'no reconnect after leaving');
  release(pads[1], PAD.SELECT);
  const c2 = await joinPad(ctx, couch, 1);
  assert.notEqual(c2, c);
  assert.equal(c2.msgs[0].name, 'Couch P2');
});

test('pad disconnect (connected=false, null slot, different device) closes that socket only', async (ctx) => {
  const couch = mk(ctx);
  const a = await joinPad(ctx, couch, 1);
  const b = await joinPad(ctx, couch, 2);
  const d = await joinPad(ctx, couch, 3);
  assert.equal(couch.list().length, 3);
  pads[2].connected = false;
  await until(couch, () => !b.open, 'pad 2 socket closed');
  assert.ok(a.open && d.open);
  assert.deepEqual(couch.list().map((e) => e.pad), [1, 3]);
  assert.ok(!couch.clientIds().has(b.id));
  pads[3] = null;
  await until(couch, () => !d.open, 'pad 3 (null) socket closed');
  pads[1] = { ...makePad(1), id: 'Some Other Controller' };
  await until(couch, () => !a.open, 'pad 1 replaced by another device -> closed');
  assert.equal(couch.list().length, 0);
  await frames(couch, 700);
  assert.equal(ctx.open().length, 0, 'no reconnects for unplugged pads');
});

test('reconnect with backoff while joined; re-hello + re-pick same team; clientIds updated', async (ctx) => {
  const couch = mk(ctx);
  const c = await joinPad(ctx, couch, 1, [PAD.RB, PAD.START]);
  assert.equal(c.msgs[1].team, 1);
  const oldId = c.id;
  ctx.kill(c);
  await until(couch, () => couch.list()[0] && !couch.list()[0].connected, 'shown as disconnected');
  assert.ok(!couch.clientIds().has(oldId));
  const t0 = now();
  const c2 = await until(couch, () => ctx.room.conns.find((x) => x !== c && x.msgs.some((m) => m.t === 'pick')), 'reconnected', 3000);
  const waited = now() - t0;
  assert.ok(waited >= 250, `backoff before reconnecting (${waited.toFixed(0)} ms)`);
  assert.equal(c2.msgs[0].t, 'hello');
  assert.equal(c2.msgs[0].name, 'Couch P2');
  assert.equal(c2.msgs[1].team, 1, 'same team re-picked');
  await until(couch, () => couch.list()[0].connected && couch.clientIds().has(c2.id), 'online with the new id');
  assert.equal(couch.clientIds().size, 1);
  assert.equal(couch.list()[0].clientId, c2.id);

  // server unreachable: keeps retrying with growing delay, no crash; starts working when reachable
  const dead = await startServer();
  const deadUrl = dead.url;
  await dead.close();
  resetPads();
  const c3 = createCouch({ wsUrl: deadUrl });
  press(pads[2], PAD.START);
  const t1 = now();
  while (now() - t1 < 600) { c3.update(); await sleep(10); }
  assert.equal(c3.list().length, 1);
  assert.equal(c3.list()[0].connected, false);
  c3.dispose();
});

test('err -> onChange with an error string', async (ctx) => {
  ctx.room.pickErr = 'team full';
  const couch = mk(ctx);
  press(pads[1], PAD.A);
  await until(couch, () => ctx.changes.find((ch) => typeof ch.err === 'string'), 'error reported');
  const e = ctx.changes.find((ch) => typeof ch.err === 'string');
  assert.match(e.err, /Couch P2/);
  assert.match(e.err, /team full/);
  assert.ok(Array.isArray(e.list));
});

test('dispose closes every socket and stops all activity', async (ctx) => {
  ctx.setState('game');
  const couch = mk(ctx);
  const a = await joinPad(ctx, couch, 1);
  const b = await joinPad(ctx, couch, 2);
  couch.dispose();
  await until({ update() {} }, () => !a.open && !b.open, 'sockets closed');
  const n = ctx.room.conns.length;
  press(pads[3], PAD.START);
  await frames(couch, 600);
  assert.equal(ctx.room.conns.length, n, 'no joins / reconnects after dispose');
  assert.equal(couch.list().length, 0);
  assert.equal(couch.clientIds().size, 0);
});

test('update() is safe without navigator.getGamepads and before any pad exists', async () => {
  const saved = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {} });
  const couch = createCouch({ wsUrl: 'ws://127.0.0.1:1/ws' });
  couch.update();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { getGamepads: () => [null, null, null, null] } });
  couch.update();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { getGamepads: () => { throw new Error('nope'); } } });
  couch.update();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: saved });
  assert.equal(couch.list().length, 0);
  couch.dispose();
});

// ------------------------------------------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  resetPads();
  const ctx = await startServer();
  const t0 = now();
  try {
    await t.fn(ctx);
    console.log(`ok   ${t.name} (${(now() - t0).toFixed(0)} ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${t.name}\n     ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e}`);
  } finally {
    try { ctx.couch?.dispose(); } catch { /* ignore */ }
    await ctx.close();
  }
}
console.log(failed ? `\n${failed} of ${tests.length} couch tests FAILED` : `\nall ${tests.length} couch tests passed`);
process.exit(failed ? 1 : 0);
