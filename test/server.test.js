// ICE RIOT - server tests. Plain node script: `node test/server.test.js` (exit code 1 on failure).
// Uses the fake sim (test/fake-sim.js); if shared/sim.js exists it also runs a smoke test with it.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGameServer, ROOT_DIR } from '../server/app.js';
import { EventEmitter } from 'node:events';
import { acceptKey, encodeText } from '../server/ws.js';
import { sanitizeName, sanitizeRoom, RoomManager } from '../server/room.js';
import { tailscaleStatus, httpsPortState, proxyTargetsPort, httpsUrl, offCommand } from '../server/tailnet.js';
import { PHASE, TICK_RATE, SNAP_RATE } from '../shared/constants.js';
import { createFakeSim } from './fake-sim.js';

const VERBOSE = process.argv.includes('--verbose');
let passed = 0;
let failed = 0;
let skipped = 0;
const metrics = {};
const cleanups = [];

async function test(name, fn) {
  const t0 = performance.now();
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name} (${Math.round(performance.now() - t0)} ms)`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(err?.stack || err).split('\n').slice(0, 6).join('\n        ')}`);
  }
}
function skip(name, why) {
  skipped++;
  console.log(`  skip  ${name} - ${why}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quietLog = VERBOSE ? (m) => console.log(`        [server] ${m}`) : () => {};

// ---------------------------------------------------------------------------------------------
// helpers

class Client {
  static open(port, { path: p = '/ws' } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`);
      const c = new Client(ws);
      cleanups.push(() => c.close());
      ws.addEventListener('open', () => resolve(c), { once: true });
      ws.addEventListener('error', () => reject(new Error('websocket error before open')), { once: true });
    });
  }
  constructor(ws) {
    this.ws = ws;
    this.msgs = [];
    this.snaps = [];
    this.markAt = 0;
    this.waiters = new Set();
    this.closeInfo = null;
    this.closed = new Promise((r) => (this._resolveClosed = r));
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      m._rx = performance.now();
      if (m.t === 'snap') {
        this.snaps.push(m);
        if (this.snaps.length > 5000) this.snaps.splice(0, 1000);
      } else {
        this.msgs.push(m);
      }
      for (const w of this.waiters) w.check(m);
    });
    ws.addEventListener('close', (e) => {
      this.closeInfo = { code: e.code, reason: e.reason };
      this._resolveClosed(this.closeInfo);
    });
  }
  send(obj) {
    this.ws.send(typeof obj === 'string' || obj instanceof Uint8Array ? obj : JSON.stringify(obj));
  }
  mark() {
    this.markAt = this.msgs.length;
    this.snapMark = this.snaps.length;
  }
  /** Resolve with the first non-snap message (since the last mark) matching pred. */
  expect(pred, timeout = 2000, label = 'message') {
    const hit = this.msgs.slice(this.markAt).find(pred);
    if (hit) return Promise.resolve(hit);
    return this._wait((m) => m.t !== 'snap' && pred(m), timeout, label);
  }
  /** Resolve with the next snap (received from now on) matching pred. */
  nextSnap(pred = () => true, timeout = 2000) {
    return this._wait((m) => m.t === 'snap' && pred(m), timeout, 'snap');
  }
  _wait(pred, timeout, label) {
    return new Promise((resolve, reject) => {
      const w = {
        check: (m) => {
          if (!pred(m)) return;
          clearTimeout(timer);
          this.waiters.delete(w);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeout);
      this.waiters.add(w);
    });
  }
  async hello(name, room) {
    this.mark();
    this.send({ t: 'hello', name, room });
    const w = await this.expect((m) => m.t === 'welcome', 2000, 'welcome');
    this.id = w.id;
    this.room = w.room;
    return w;
  }
  lobby() {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === 'lobby') return this.msgs[i];
    return null;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

function httpGet(port, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Raw HTTP request over a socket (no client-side path normalization at all). */
function rawHttp(port, requestText) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(requestText));
    let buf = '';
    sock.on('data', (d) => (buf += d.toString('latin1')));
    sock.on('end', () => resolve(buf));
    sock.on('close', () => resolve(buf));
    sock.on('error', reject);
    setTimeout(() => {
      sock.destroy();
      resolve(buf);
    }, 1500);
  });
}

/** Build one masked client frame. */
function clientFrame(opcode, payload, { fin = true, mask = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
  const len = data.length;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + ext + (mask ? 4 : 0));
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([head, data]);
  head[1] |= 0x80;
  const key = crypto.randomBytes(4);
  key.copy(head, 2 + ext);
  const out = Buffer.from(data);
  for (let i = 0; i < len; i++) out[i] ^= key[i & 3];
  return Buffer.concat([head, out]);
}

/** Raw-socket WebSocket client: manual handshake + server frame parser. */
class RawWs {
  static connect(port, extraHeaders = '', reqPath = '/ws', version = '13', withKey = true) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          `GET ${reqPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n` +
            (withKey ? `Sec-WebSocket-Key: ${key}\r\n` : '') +
            `Sec-WebSocket-Version: ${version}\r\n${extraHeaders}\r\n`,
        );
      });
      cleanups.push(() => sock.destroy());
      let buf = Buffer.alloc(0);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        sock.off('data', onData);
        const head = buf.subarray(0, i).toString('latin1');
        resolve(new RawWs(sock, key, head, buf.subarray(i + 4)));
      };
      sock.on('data', onData);
      sock.on('error', reject);
    });
  }
  constructor(sock, key, head, rest) {
    this.sock = sock;
    this.key = key;
    this.head = head;
    this.status = Number(head.split(' ')[1]);
    this.frames = [];
    this.waiters = [];
    this.buf = Buffer.alloc(0);
    this.ended = false;
    this.endedP = new Promise((r) => (this._ended = r));
    sock.on('data', (d) => this._data(d));
    sock.on('close', () => {
      this.ended = true;
      this._ended();
    });
    sock.on('error', () => {});
    if (rest.length) this._data(rest);
  }
  header(name) {
    const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(this.head);
    return m ? m[1].trim() : null;
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      assert.equal(b[1] & 0x80, 0, 'server frames must not be masked');
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      if (b.length < off + len) return;
      const frame = { fin: (b[0] & 0x80) !== 0, op: b[0] & 0x0f, payload: b.subarray(off, off + len) };
      this.buf = b.subarray(off + len);
      this.frames.push(frame);
      this.waiters = this.waiters.filter((w) => !w(frame));
    }
  }
  write(buf) {
    this.sock.write(buf);
  }
  next(pred, timeout = 2000, label = 'frame') {
    const i = this.frames.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.frames.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`raw: timed out waiting for ${label}`)), timeout);
      this.waiters.push((f) => {
        if (!pred(f)) return false;
        clearTimeout(timer);
        this.frames.splice(this.frames.indexOf(f), 1);
        resolve(f);
        return true;
      });
    });
  }
  nextJson(pred, timeout = 2000, label = 'json') {
    return this.next((f) => f.op === 1 && pred(JSON.parse(f.payload.toString())), timeout, label).then((f) => JSON.parse(f.payload.toString()));
  }
}

const SNAP_FIELDS = ['t', 'time', 'tick', 'ph', 'phT', 'per', 'clk', 'sc', 'teams', 'p', 'k', 'gl', 'ev'];
const P_FIELDS = ['id', 'tm', 'g', 'x', 'y', 'z', 'vx', 'vz', 'f', 's', 'sT', 'tb', 'fire', 'ch', 'c', 'n'];
const K_FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'o'];

function checkSnapShape(s) {
  for (const f of SNAP_FIELDS) assert.ok(f in s, `snap missing ${f}`);
  assert.equal(s.t, 'snap');
  assert.equal(typeof s.time, 'number');
  assert.ok(Number.isInteger(s.tick), 'tick is an int');
  assert.ok(Array.isArray(s.sc) && s.sc.length === 2, 'sc is [h,a]');
  assert.ok(Array.isArray(s.teams) && s.teams.length === 2, 'teams is [h,a]');
  assert.ok(Array.isArray(s.p) && s.p.length === 8, 'p has 8 entries');
  s.p.forEach((p, i) => {
    for (const f of P_FIELDS) assert.ok(f in p, `p[${i}] missing ${f}`);
    assert.equal(p.id, i, 'p index == id');
  });
  for (const f of K_FIELDS) assert.ok(f in s.k, `k missing ${f}`);
  assert.ok(Array.isArray(s.gl), 'gl is an array');
  assert.ok(Array.isArray(s.ev), 'ev is an array');
}

function checkRounded(v, where = 'snap') {
  if (typeof v === 'number') {
    assert.ok(Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, `${where} = ${v} has more than 3 decimals`);
  } else if (Array.isArray(v)) v.forEach((x, i) => checkRounded(x, `${where}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== '_rx') checkRounded(x, `${where}.${k}`);
}

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

// ---------------------------------------------------------------------------------------------

async function main() {
  console.log('ICE RIOT server tests');

  await test('sanitizers', () => {
    assert.equal(sanitizeName('  Ali<ce>  ', 'P'), 'Alice');
    assert.equal(sanitizeName('a\u0000b\u0007c\u202e', 'P'), 'abc');
    assert.equal(sanitizeName('"x" & \'y\' `z`', 'P'), 'x y z');
    assert.equal(sanitizeName('x'.repeat(40), 'P').length, 16);
    assert.equal(sanitizeName('   ', 'Player 7'), 'Player 7');
    assert.equal(sanitizeName(undefined, 'Player 7'), 'Player 7');
    assert.equal(sanitizeName({ evil: 1 }, 'Player 7'), 'Player 7');
    assert.equal(sanitizeName(42, 'Player 7'), '42');
    assert.equal(sanitizeRoom('My Room!!'), 'my-room');
    assert.equal(sanitizeRoom(''), 'main');
    assert.equal(sanitizeRoom(undefined), 'main');
    assert.equal(sanitizeRoom('../../etc'), 'etc');
    assert.equal(sanitizeRoom('a'.repeat(30)).length, 24);
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='); // RFC 6455 example
  });

  await test('ws: outgoing frames use 7/16/64-bit lengths (large payloads)', () => {
    const small = encodeText('hi');
    assert.deepEqual([...small], [0x81, 2, 0x68, 0x69]);
    const mid = encodeText('é'.repeat(100)); // 200 UTF-8 bytes
    assert.equal(mid[1], 126);
    assert.equal(mid.readUInt16BE(2), 200);
    assert.equal(mid.length, 204);
    const big = encodeText('x'.repeat(70000));
    assert.equal(big[0], 0x81);
    assert.equal(big[1], 127, 'unmasked, 64-bit length');
    assert.equal(big.readBigUInt64BE(2), 70000n);
    assert.equal(big.length, 70010);
    assert.equal(big.subarray(10).toString(), 'x'.repeat(70000));
  });

  await test('room: snaps are skipped for a client with > 512 KB buffered (backpressure)', async () => {
    const decode = (f) => {
      const l = f[1] & 0x7f;
      return JSON.parse(f.subarray(l === 126 ? 4 : l === 127 ? 10 : 2).toString());
    };
    class FakeConn extends EventEmitter {
      constructor() {
        super();
        this.sent = [];
        this.bufferedAmount = 0;
        this.remoteAddress = '';
      }
      send(s) { this.sent.push(JSON.parse(s)); return true; }
      sendFrame(f) { this.sent.push(decode(f)); return true; }
      ping() { return true; }
      close() { this.emit('close', 1000, ''); }
    }
    const mgr = new RoomManager({ sim: createFakeSim() });
    const fast = new FakeConn();
    const slow = new FakeConn();
    for (const [c, n] of [[fast, 'fast'], [slow, 'slow']]) {
      mgr.handleConnection(c);
      c.emit('message', JSON.stringify({ t: 'hello', name: n, room: 'bp' }));
    }
    try {
      slow.bufferedAmount = 600 * 1024;
      fast.emit('message', JSON.stringify({ t: 'start' }));
      await sleep(250);
      const snaps = (c) => c.sent.filter((m) => m.t === 'snap').length;
      assert.ok(snaps(fast) >= 4, `fast client got ${snaps(fast)} snaps`);
      assert.equal(snaps(slow), 0, 'backed-up client got no snaps');
      const room = mgr.rooms.get('bp');
      const slowClient = [...room.clients.values()].find((c) => c.name === 'slow');
      assert.ok(slowClient.snapsSkipped >= 4);
      assert.ok(slow.sent.some((m) => m.t === 'lobby' && m.state === 'game'), 'lobby messages still delivered');
      slow.bufferedAmount = 0;
      await sleep(120);
      assert.ok(snaps(slow) >= 2, 'snaps resume once the buffer drains');
    } finally {
      mgr.close();
    }
  });

  await test('tailnet: status never throws and explains itself', async () => {
    const st = await tailscaleStatus();
    assert.equal(typeof st.running, 'boolean');
    assert.ok(Array.isArray(st.ips));
    assert.equal(typeof st.dnsName, 'string');
    assert.ok(!st.dnsName.endsWith('.'), 'no trailing dot');
    if (!st.running) assert.ok(st.reason.length > 0, 'reason given when not running');
    metrics.tailscale = st.running ? `running ${st.dnsName} ${st.ips.join(' ')}` : `not running (${st.state || st.reason})`;
  });

  await test('tailnet: serve config conflict detection never clobbers other handlers', () => {
    assert.ok(proxyTargetsPort('http://127.0.0.1:8765', 8765));
    assert.ok(proxyTargetsPort('http://localhost:8765/', 8765));
    assert.ok(!proxyTargetsPort('http://127.0.0.1:3000', 8765));
    assert.equal(httpsPortState({}, 443, 8765), 'free');
    assert.equal(httpsPortState(null, 443, 8765), 'free');
    const ours = { TCP: { 443: { HTTPS: true } }, Web: { 'box.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8765' } } } } };
    assert.equal(httpsPortState(ours, 443, 8765), 'ours');
    const other = { TCP: { 443: { HTTPS: true } }, Web: { 'box.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
    assert.equal(httpsPortState(other, 443, 8765), 'taken');
    assert.equal(httpsPortState(other, 8443, 8765), 'free');
    const subpath = { Web: { 'box.tail1.ts.net:443': { Handlers: { '/grafana': { Proxy: 'http://127.0.0.1:3000' } } } } };
    assert.equal(httpsPortState(subpath, 443, 8765), 'free', 'a sub-path mount does not block "/"');
    assert.equal(httpsPortState({ TCP: { 443: { TCPForward: '127.0.0.1:22' } } }, 443, 8765), 'taken');
    assert.equal(httpsUrl('box.tail1.ts.net', 443), 'https://box.tail1.ts.net/');
    assert.equal(httpsUrl('box.tail1.ts.net', 8443), 'https://box.tail1.ts.net:8443/');
    assert.equal(offCommand(443), 'tailscale serve --https=443 off');
  });

  const sim = createFakeSim();
  const srv = await createGameServer({ sim, port: 0, host: '127.0.0.1', log: quietLog });
  const port = srv.port;
  console.log(`  (fake-sim server on port ${port})`);

  // ---- static ------------------------------------------------------------------------------
  const indexPath = path.join(ROOT_DIR, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    await test('static: GET / serves public/index.html', async () => {
      const r = await httpGet(port, '/');
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /^text\/html/);
      assert.equal(r.headers['cache-control'], 'no-cache');
      assert.equal(r.body.toString(), fs.readFileSync(indexPath, 'utf8'));
    });
  } else {
    skip('static: GET / serves public/index.html', 'public/index.html does not exist yet');
  }

  await test('static: /shared/constants.js is text/javascript, no-cache', async () => {
    const r = await httpGet(port, '/shared/constants.js');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/javascript/);
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.ok(r.body.toString().includes('ICE RIOT'));
    const h = await httpGet(port, '/shared/constants.js', 'HEAD');
    assert.equal(h.status, 200);
    assert.equal(h.body.length, 0);
  });

  await test('static: vendored three.js streams with correct length', async () => {
    const file = path.join(ROOT_DIR, 'public', 'vendor', 'three.module.min.js');
    if (!fs.existsSync(file)) return;
    const r = await httpGet(port, '/vendor/three.module.min.js');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/javascript/);
    assert.equal(Number(r.headers['content-length']), fs.statSync(file).size);
    assert.equal(r.body.length, fs.statSync(file).size);
  });

  await test('static: path traversal, device names and junk are refused', async () => {
    const attempts = [
      '/../package.json',
      '/shared/../package.json',
      '/shared/../../package.json',
      '/shared/..%2fpackage.json',
      '/%2e%2e/package.json',
      '/shared/%2e%2e/package.json',
      '/..%5cpackage.json',
      '/shared/..%5c..%5cpackage.json',
      '/shared/..\\package.json',
      '/%2e%2e%2f%2e%2e%2fWindows/win.ini',
      '/C:/Windows/win.ini',
      '/shared/C:%5cWindows%5cwin.ini',
      '//etc/passwd',
      '/shared/constants.js::$DATA',
      '/con',
      '/shared/nul.js',
      '/.git/config',
      '/%00',
      '/%E0%A4%A',
      '/nope.js',
    ];
    for (const p of attempts) {
      const raw = await rawHttp(port, `GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      const status = Number(raw.split(' ')[1]);
      assert.ok(status === 404 || status === 403 || status === 400, `${p} -> ${status}`);
      assert.ok(!raw.includes('"ice-riot"'), `${p} leaked package.json`);
      assert.ok(!raw.includes('[fonts]') && !raw.includes('root:'), `${p} leaked a system file`);
    }
    const post = await httpGet(port, '/', 'POST');
    assert.equal(post.status, 405);
  });

  // ---- handshake ---------------------------------------------------------------------------
  await test('ws: handshake validation (accept key, bad key, wrong path, wrong version)', async () => {
    const ok = await RawWs.connect(port);
    assert.equal(ok.status, 101);
    const expected = crypto.createHash('sha1').update(ok.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    assert.equal(ok.header('Sec-WebSocket-Accept'), expected);
    ok.sock.destroy();
    const noKey = await RawWs.connect(port, '', '/ws', '13', false);
    assert.equal(noKey.status, 400);
    const wrongPath = await RawWs.connect(port, '', '/nope');
    assert.equal(wrongPath.status, 404);
    const oldVersion = await RawWs.connect(port, '', '/ws', '8');
    assert.equal(oldVersion.status, 426);
    assert.equal(oldVersion.header('Sec-WebSocket-Version'), '13');
    const proto = await RawWs.connect(port, 'Sec-WebSocket-Protocol: iceriot, other\r\n');
    assert.equal(proto.status, 101);
    assert.equal(proto.header('Sec-WebSocket-Protocol'), 'iceriot');
    proto.sock.destroy();
  });

  // ---- lobby -------------------------------------------------------------------------------
  let A, B, C;
  await test('ws: two clients hello -> distinct ids, lobby lists both, first is host', async () => {
    A = await Client.open(port);
    const wa = await A.hello('  Ali<ce>  ', 'Test Room');
    assert.ok(Number.isInteger(wa.id) && wa.id > 0);
    assert.equal(wa.room, 'test-room');
    B = await Client.open(port);
    const wb = await B.hello('Bob', 'test-room');
    assert.ok(wb.id > 0 && wb.id !== wa.id, 'distinct ids');
    const la = await A.expect((m) => m.t === 'lobby' && m.clients.length === 2, 2000, 'lobby with 2');
    const lb = await B.expect((m) => m.t === 'lobby' && m.clients.length === 2, 2000, 'lobby with 2');
    for (const l of [la, lb]) {
      assert.equal(l.state, 'lobby');
      assert.equal(l.host, A.id);
      assert.deepEqual(l.clients.map((c) => c.id), [A.id, B.id]);
      for (const c of l.clients) for (const f of ['id', 'name', 'team', 'ping']) assert.ok(f in c, `client.${f}`);
      for (const f of ['teams', 'periodLength', 'periods', 'difficulty']) assert.ok(f in l.config, `config.${f}`);
    }
    assert.equal(la.clients[0].name, 'Alice');
    assert.equal(la.clients[1].name, 'Bob');
    // auto-balanced onto opposite teams
    assert.deepEqual(la.clients.map((c) => c.team), [0, 1]);
  });

  await test('ws: default name, rooms are isolated', async () => {
    const R = await Client.open(port);
    await R.hello('', 'Other');
    assert.equal(R.room, 'other');
    const l = await R.expect((m) => m.t === 'lobby', 2000, 'lobby');
    assert.equal(l.clients.length, 1);
    assert.equal(l.host, R.id);
    assert.equal(l.clients[0].name, `Player ${R.id}`);
    assert.ok(srv.rooms.rooms.has('other'));
    R.close();
    await R.closed;
    for (let i = 0; i < 50 && srv.rooms.rooms.has('other'); i++) await sleep(20);
    assert.ok(!srv.rooms.rooms.has('other'), 'empty room destroyed');
  });

  await test('ws: non-host start/config/lobby -> err', async () => {
    B.mark();
    B.send({ t: 'start' });
    const e1 = await B.expect((m) => m.t === 'err', 2000, 'err for start');
    assert.match(e1.msg, /host/i);
    B.mark();
    B.send({ t: 'config', periodLength: 60 });
    await B.expect((m) => m.t === 'err', 2000, 'err for config');
    B.mark();
    B.send({ t: 'lobby' });
    await B.expect((m) => m.t === 'err', 2000, 'err for lobby');
    assert.equal(sim.games.length, 0, 'no game was created');
  });

  await test('ws: host config is validated and broadcast', async () => {
    for (const bad of [{ teams: [1, 1] }, { teams: [0, 99] }, { teams: 'x' }, { periodLength: 77 }, { difficulty: 5 }, { difficulty: 1.5 }]) {
      A.mark();
      A.send({ t: 'config', ...bad });
      await A.expect((m) => m.t === 'err', 2000, `err for ${JSON.stringify(bad)}`);
    }
    A.mark();
    B.mark();
    A.send({ t: 'config', teams: [2, 3], periodLength: 60, difficulty: 2 });
    for (const c of [A, B]) {
      const l = await c.expect((m) => m.t === 'lobby' && m.config.periodLength === 60, 2000, 'lobby with config');
      assert.deepEqual(l.config.teams, [2, 3]);
      assert.equal(l.config.difficulty, 2);
      assert.equal(l.config.periods, 3);
    }
  });

  await test('ws: lobby picks + team full (max 3 humans per team)', async () => {
    A.mark();
    A.send({ t: 'pick', team: 0 });
    B.send({ t: 'pick', team: 1 });
    await A.expect((m) => m.t === 'lobby' && m.clients.find((c) => c.id === B.id)?.team === 1, 2000, 'lobby after picks');
    const extra = [];
    for (let i = 0; i < 2; i++) {
      const X = await Client.open(port);
      await X.hello(`X${i}`, 'test-room');
      X.mark();
      X.send({ t: 'pick', team: 0 });
      await X.expect((m) => m.t === 'lobby' && m.clients.find((c) => c.id === X.id)?.team === 0, 2000, 'X on home');
      extra.push(X);
    }
    const X3 = await Client.open(port);
    await X3.hello('X3', 'test-room');
    const l3 = await X3.expect((m) => m.t === 'lobby' && m.clients.some((c) => c.id === X3.id), 2000, 'X3 in lobby');
    assert.equal(l3.clients.find((c) => c.id === X3.id).team, 1, 'auto-balance skips the full team');
    X3.mark();
    X3.send({ t: 'pick', team: 0 });
    const e = await X3.expect((m) => m.t === 'err', 2000, 'team full err');
    assert.match(e.msg, /full/i);
    extra.push(X3);
    A.mark();
    for (const X of extra) X.close();
    await A.expect((m) => m.t === 'lobby' && m.clients.length === 2, 3000, 'lobby back to 2');
  });

  // ---- game --------------------------------------------------------------------------------
  let firstSnap;
  await test('ws: host start -> lobby state game + snaps with contract fields', async () => {
    A.mark();
    B.mark();
    const snapA = A.nextSnap();
    const snapB = B.nextSnap();
    A.send({ t: 'start' });
    await A.expect((m) => m.t === 'lobby' && m.state === 'game', 2000, 'lobby state game');
    await B.expect((m) => m.t === 'lobby' && m.state === 'game', 2000, 'lobby state game');
    firstSnap = await snapA;
    await snapB;
    assert.equal(sim.games.length, 1);
    assert.deepEqual(sim.configs[0].teams, [2, 3]);
    assert.equal(sim.configs[0].periodLength, 60);
    assert.equal(sim.configs[0].difficulty, 2);
    assert.ok(Number.isInteger(sim.seeds[0]) && sim.seeds[0] > 0, 'integer seed');
    assert.ok(Math.abs(sim.lastDt - 1 / TICK_RATE) < 1e-12, 'step dt == DT');
    checkSnapShape(firstSnap);
    checkRounded(firstSnap);
    assert.deepEqual(firstSnap.teams, [2, 3]);
    const pa = firstSnap.p.find((p) => p.c === A.id);
    const pb = firstSnap.p.find((p) => p.c === B.id);
    assert.ok(pa && pa.tm === 0 && !pa.g, 'A controls a home skater');
    assert.ok(pb && pb.tm === 1 && !pb.g, 'B controls an away skater');
    assert.ok(firstSnap.ev.some((e) => e.type === 'period'), 'initial events delivered in the first snap');
    // a second start is refused
    A.mark();
    A.send({ t: 'start' });
    await A.expect((m) => m.t === 'err', 2000, 'already running err');
  });

  await test(`ws: snaps arrive at ~${SNAP_RATE} Hz (within 20% over 2 s), events drained once`, async () => {
    const start = B.snaps.length;
    const t0 = performance.now();
    await sleep(2000);
    const got = B.snaps.slice(start);
    const secs = (performance.now() - t0) / 1000;
    const rate = got.length / secs;
    const gaps = got.slice(1).map((s, i) => s._rx - got[i]._rx).sort((a, b) => a - b);
    const tgaps = got.slice(1).map((s, i) => s.time - got[i].time);
    metrics.snapRate = rate.toFixed(2);
    metrics.snapGapMs = `p50 ${percentile(gaps, 0.5).toFixed(1)} / p95 ${percentile(gaps, 0.95).toFixed(1)} / max ${gaps[gaps.length - 1].toFixed(1)}`;
    metrics.snapTimeStepMs = `${Math.min(...tgaps).toFixed(3)}..${Math.max(...tgaps).toFixed(3)}`;
    assert.ok(rate >= SNAP_RATE * 0.8 && rate <= SNAP_RATE * 1.2, `snap rate ${rate.toFixed(2)} Hz`);
    for (let i = 1; i < got.length; i++) {
      assert.ok(got[i].time > got[i - 1].time, 'snap time is monotonic');
      assert.ok(got[i].tick > got[i - 1].tick, 'tick increases');
    }
    const shots = got.flatMap((s) => s.ev).filter((e) => e.type === 'shot');
    const ticks = got[got.length - 1].tick - got[0].tick;
    assert.ok(Math.abs(shots.length - ticks / 45) <= 2, `shots ${shots.length} vs ticks/45 ${ticks / 45}`);
    assert.equal(shots[0].power, 0.123, 'event numbers rounded to 3 decimals');
  });

  await test('ws: inputs are sanitized and reach the sim', async () => {
    A.send({ t: 'in', seq: 1, mx: 5, mz: -7, b: 9999 });
    await sleep(80);
    assert.deepEqual(sim.lastInputs[A.id], { mx: 1, mz: -1, b: 9999 & 15 });
    A.send({ t: 'in', seq: 2, mx: 'abc', mz: null, b: 'x' });
    await sleep(80);
    assert.deepEqual(sim.lastInputs[A.id], { mx: 0, mz: 0, b: 0 });
    A.send({ t: 'in', seq: 3, mx: { a: 1 }, mz: [1], b: -1 });
    await sleep(80);
    assert.deepEqual(sim.lastInputs[A.id], { mx: 0, mz: 1, b: 15 });
    // drive right for 0.5 s and watch A's skater move +x
    const before = A.snaps[A.snaps.length - 1].p.find((p) => p.c === A.id).x;
    for (let i = 0; i < 30; i++) {
      A.send({ t: 'in', seq: 10 + i, mx: 1, mz: 0, b: 8 });
      await sleep(16);
    }
    await sleep(60);
    const after = A.snaps[A.snaps.length - 1].p.find((p) => p.c === A.id).x;
    assert.ok(after - before > 1.5, `skater moved ${after - before} m`);
    A.send({ t: 'in', seq: 99, mx: 0, mz: 0, b: 0 });
  });

  await test('ws: ping -> pong {c, s}', async () => {
    A.mark();
    const t0 = performance.now();
    A.send({ t: 'ping', c: 1234.5 });
    const p = await A.expect((m) => m.t === 'pong', 2000, 'pong');
    metrics.pingRttMs = (performance.now() - t0).toFixed(2);
    assert.equal(p.c, 1234.5);
    assert.equal(typeof p.s, 'number');
    assert.ok(Math.abs(p.s - firstSnap.time) < 60000, 'pong s on the same clock as snap time');
  });

  await test('ws: third client drops in mid-game via pick, then spectates', async () => {
    C = await Client.open(port);
    await C.hello('Cat', 'test-room');
    const l = await C.expect((m) => m.t === 'lobby' && m.clients.some((c) => c.id === C.id), 2000, 'lobby');
    assert.equal(l.state, 'game');
    assert.equal(l.clients.find((c) => c.id === C.id).team, -1, 'mid-game joiners start as spectators');
    const s0 = await C.nextSnap();
    assert.ok(!s0.p.some((p) => p.c === C.id));
    C.send({ t: 'in', seq: 1, mx: 1, mz: 0, b: 0 });
    await sleep(50);
    assert.ok(!(C.id in sim.lastInputs), 'spectator input ignored');
    C.mark();
    C.send({ t: 'pick', team: 0 });
    await C.expect((m) => m.t === 'lobby' && m.clients.find((c) => c.id === C.id)?.team === 0, 2000, 'C on home');
    const s1 = await C.nextSnap((s) => s.p.some((p) => p.c === C.id));
    const pc = s1.p.find((p) => p.c === C.id);
    assert.equal(pc.tm, 0);
    assert.ok(!pc.g, 'never the goalie');
    C.mark();
    C.send({ t: 'pick', team: 1 });
    await C.expect((m) => m.t === 'lobby' && m.clients.find((c) => c.id === C.id)?.team === 1, 2000, 'C on away');
    const s2 = await C.nextSnap((s) => s.p.some((p) => p.c === C.id && p.tm === 1));
    assert.equal(s2.p.filter((p) => p.c === C.id).length, 1, 'only one skater per client');
    C.mark();
    C.send({ t: 'pick', team: -1 });
    await C.expect((m) => m.t === 'lobby' && m.clients.find((c) => c.id === C.id)?.team === -1, 2000, 'C spectating');
    await C.nextSnap((s) => !s.p.some((p) => p.c === C.id));
    C.send({ t: 'pick', team: 0 });
    await C.nextSnap((s) => s.p.some((p) => p.c === C.id && p.tm === 0));
  });

  await test('ws: malformed / unknown messages are ignored, server stays up', async () => {
    const junk = [
      'not json{',
      '',
      '{"t":42}',
      '[]',
      'null',
      '"str"',
      '{"t":"zzz"}',
      '{"t":"in","mx":{"a":1}}',
      '{"__proto__":{"t":"start"}}',
      '{"t":"hello","name":"again","room":"elsewhere"}',
      '{"t":"pick"}',
      '{"t":"pick","team":"x"}',
      '{"t":"config","teams":"x"}',
      '{"t":"ping","c":"not a number"}',
      JSON.stringify({ t: 'in', mx: 1e308, mz: -Infinity, b: 2 ** 40 }),
    ];
    for (const j of junk) B.send(j);
    B.send(new Uint8Array([1, 2, 3, 4]));
    B.mark();
    B.send({ t: 'ping', c: 7 });
    const p = await B.expect((m) => m.t === 'pong' && m.c === 7, 2000, 'pong after junk');
    assert.ok(p);
    assert.equal(B.ws.readyState, WebSocket.OPEN);
    assert.equal(B.room, 'test-room');
    const l = await B.expect((m) => m.t === 'lobby' && m.clients.find((c) => c.id === B.id)?.name === 'again', 2000, 'second hello renames');
    assert.equal(l.clients.length, 3, 'second hello did not re-join');
    assert.equal(srv.rooms.rooms.has('elsewhere'), false, 'second hello cannot switch rooms');
    B.mark();
    B.send({ t: 'hello', name: 'Bob', room: 'test-room' });
    await B.expect((m) => m.t === 'lobby' && m.clients.find((c) => c.id === B.id)?.name === 'Bob', 2000, 'renamed back');
  });

  await test('ws: 100 KB message closes that socket with 1009, server keeps running', async () => {
    const D = await Client.open(port);
    D.send('x'.repeat(100 * 1024));
    const info = await Promise.race([D.closed, sleep(3000).then(() => null)]);
    assert.ok(info, 'socket closed');
    assert.equal(info.code, 1009);
    A.mark();
    A.send({ t: 'ping', c: 8 });
    await A.expect((m) => m.t === 'pong' && m.c === 8, 2000, 'pong after 1009');
    const E = await Client.open(port);
    await E.hello('Eve', 'elsewhere');
    E.close();
  });

  await test('ws: raw socket - masked + fragmented message reassembled, ping/pong, 16/64-bit lengths, close', async () => {
    const r = await RawWs.connect(port);
    assert.equal(r.status, 101);
    const hello = Buffer.from(JSON.stringify({ t: 'hello', name: 'Raw\u00e9\u{1F3D2}', room: 'raw' }));
    const cut1 = 7;
    const cut2 = hello.length - 3; // splits inside the 4-byte UTF-8 emoji
    r.write(clientFrame(0x1, hello.subarray(0, cut1), { fin: false }));
    r.write(clientFrame(0x9, 'hb-1')); // control frame between fragments is legal
    r.write(Buffer.concat([clientFrame(0x0, hello.subarray(cut1, cut2), { fin: false }), clientFrame(0x0, hello.subarray(cut2), { fin: true })]).subarray(0)); // two frames, one write
    const pong = await r.next((f) => f.op === 0xa, 2000, 'pong frame');
    assert.equal(pong.payload.toString(), 'hb-1');
    const welcome = await r.nextJson((m) => m.t === 'welcome', 2000, 'welcome');
    assert.equal(welcome.room, 'raw');
    const lobby = await r.nextJson((m) => m.t === 'lobby', 2000, 'lobby');
    assert.equal(lobby.clients[0].name, 'Raw\u00e9\u{1F3D2}');

    // byte-at-a-time delivery of a frame using a 16-bit length
    const medium = clientFrame(0x1, JSON.stringify({ t: 'ping', c: 16, pad: 'm'.repeat(300) }));
    for (let i = 0; i < medium.length; i += 1) r.write(medium.subarray(i, i + 1));
    assert.equal((await r.nextJson((m) => m.t === 'pong' && m.c === 16, 3000, 'pong 16')).c, 16);

    // exactly 64 KB (the limit) via a 64-bit length, fragmented into 4 frames
    const base = JSON.stringify({ t: 'ping', c: 64, pad: '' });
    const big = Buffer.from(JSON.stringify({ t: 'ping', c: 64, pad: 'p'.repeat(65536 - base.length) }));
    assert.equal(big.length, 65536);
    const whole = clientFrame(0x1, big);
    assert.equal(whole[1] & 0x7f, 127, 'uses the 64-bit length form');
    r.write(whole);
    assert.equal((await r.nextJson((m) => m.t === 'pong' && m.c === 64, 3000, 'pong 64')).c, 64);
    const q = big.length / 4;
    r.write(clientFrame(0x1, big.subarray(0, q), { fin: false }));
    r.write(clientFrame(0x0, big.subarray(q, 2 * q), { fin: false }));
    r.write(clientFrame(0x0, big.subarray(2 * q, 3 * q), { fin: false }));
    r.write(clientFrame(0x0, big.subarray(3 * q), { fin: true }));
    assert.equal((await r.nextJson((m) => m.t === 'pong' && m.c === 64, 3000, 'pong 64 fragmented')).c, 64);

    // close handshake: server echoes the code and ends the TCP connection
    const cp = Buffer.alloc(2);
    cp.writeUInt16BE(1000);
    r.write(clientFrame(0x8, cp));
    const close = await r.next((f) => f.op === 0x8, 2000, 'close frame');
    assert.equal(close.payload.readUInt16BE(0), 1000);
    await Promise.race([r.endedP, sleep(2000).then(() => assert.fail('socket not closed after close handshake'))]);
  });

  await test('ws: protocol violations close with 1002 / 1009 / 1007', async () => {
    const cases = [
      { name: 'unmasked frame', frame: clientFrame(0x1, '{"t":"ping"}', { mask: false }), code: 1002 },
      { name: 'continuation without start', frame: clientFrame(0x0, 'abc'), code: 1002 },
      { name: 'fragmented control frame', frame: clientFrame(0x9, 'x', { fin: false }), code: 1002 },
      { name: '64 KB + 1 byte', frame: clientFrame(0x1, Buffer.alloc(65537, 0x61)), code: 1009 },
      { name: 'fragments totalling > 64 KB', frame: Buffer.concat([clientFrame(0x1, Buffer.alloc(40000, 0x61), { fin: false }), clientFrame(0x0, Buffer.alloc(40000, 0x61))]), code: 1009 },
      { name: 'invalid UTF-8', frame: clientFrame(0x1, Buffer.from([0x7b, 0xff, 0xfe, 0x7d])), code: 1007 },
      { name: 'reserved opcode', frame: clientFrame(0x3, 'x'), code: 1002 },
    ];
    for (const c of cases) {
      const r = await RawWs.connect(port);
      r.write(c.frame);
      const f = await r.next((x) => x.op === 0x8, 2000, `close for ${c.name}`);
      assert.equal(f.payload.readUInt16BE(0), c.code, c.name);
      await Promise.race([r.endedP, sleep(2500).then(() => assert.fail(`${c.name}: socket left open`))]);
    }
  });

  await test('ws: host disconnect transfers host to the oldest remaining client', async () => {
    B.mark();
    C.mark();
    A.close();
    const lb = await B.expect((m) => m.t === 'lobby' && !m.clients.some((c) => c.id === A.id), 2000, 'lobby without A');
    assert.equal(lb.host, B.id);
    const lc = await C.expect((m) => m.t === 'lobby' && !m.clients.some((c) => c.id === A.id), 2000, 'lobby without A');
    assert.equal(lc.host, B.id);
    assert.equal(lc.state, 'game');
    const s = await B.nextSnap((x) => !x.p.some((p) => p.c === A.id));
    assert.ok(s, "A's skater went back to the AI");
    assert.ok(!(A.id in sim.lastInputs), "A's input dropped");
  });

  await test('ws: new host returns the room to the lobby; snaps stop', async () => {
    B.mark();
    B.send({ t: 'lobby' });
    await B.expect((m) => m.t === 'lobby' && m.state === 'lobby', 2000, 'lobby state lobby');
    await sleep(60);
    const n = B.snaps.length;
    await sleep(300);
    assert.equal(B.snaps.length, n, 'no snaps in the lobby');
    const l = B.lobby();
    assert.equal(l.clients.find((c) => c.id === C.id).team, 0, 'teams kept for the next game');
  });

  await test(`loop: tick rate ${TICK_RATE} +/- 2 Hz (3 s measurement)`, async () => {
    B.mark();
    B.send({ t: 'start' });
    await B.expect((m) => m.t === 'lobby' && m.state === 'game', 2000, 'game');
    const first = await B.nextSnap();
    const steps0 = sim.steps;
    const t0 = performance.now();
    await sleep(3000);
    const last = B.snaps[B.snaps.length - 1];
    const wall = (last._rx - first._rx) / 1000;
    const clientRate = (last.tick - first.tick) / wall;
    const serverRate = (sim.steps - steps0) / ((performance.now() - t0) / 1000);
    const room = srv.rooms.rooms.get('test-room');
    const st = room.stats();
    metrics.tickRateClient = clientRate.toFixed(2);
    metrics.tickRateServer = serverRate.toFixed(2);
    metrics.tickRateLoop = st.tickRate.toFixed(2);
    metrics.droppedSteps = st.droppedSteps;
    assert.ok(Math.abs(clientRate - TICK_RATE) <= 2, `client-measured tick rate ${clientRate.toFixed(2)}`);
    assert.ok(Math.abs(serverRate - TICK_RATE) <= 2, `server-measured tick rate ${serverRate.toFixed(2)}`);
    const dt = (last.time - first.time) / (last.tick - first.tick);
    assert.ok(Math.abs(dt - 1000 / TICK_RATE) < 0.5, `snap time advances ${dt.toFixed(3)} ms per tick`);
  });

  await test('rooms: room is destroyed (loop stopped) when everyone leaves', async () => {
    const room = srv.rooms.rooms.get('test-room');
    assert.ok(room?.running);
    B.close();
    C.close();
    await Promise.all([B.closed, C.closed]);
    for (let i = 0; i < 50 && srv.rooms.rooms.has('test-room'); i++) await sleep(20);
    assert.ok(!srv.rooms.rooms.has('test-room'), 'room removed');
    assert.equal(room.running, false, 'loop stopped');
    const steps = sim.steps;
    await sleep(100);
    assert.equal(sim.steps, steps, 'no more sim steps');
  });

  await srv.close();

  // ---- GAME_OVER -> lobby ------------------------------------------------------------------
  await test('game over: snaps continue for the linger time, then the room returns to the lobby', async () => {
    const sim2 = createFakeSim({ gameSeconds: 0.6 });
    const s2 = await createGameServer({ sim: sim2, port: 0, host: '127.0.0.1', log: quietLog, gameOverLingerMs: 700 });
    try {
      const H = await Client.open(s2.port);
      await H.hello('Host', 'go');
      H.mark();
      H.send({ t: 'start' });
      const over = await H.nextSnap((s) => s.ph === PHASE.GAME_OVER, 3000);
      assert.ok(over.ev.some((e) => e.type === 'final') || H.snaps.some((s) => s.ev.some((e) => e.type === 'final')));
      const back = await H.expect((m) => m.t === 'lobby' && m.state === 'lobby' && m._rx > over._rx, 3000, 'automatic return to lobby');
      const lingered = H.snaps.filter((s) => s.ph === PHASE.GAME_OVER).length;
      metrics.gameOverLingerSnaps = lingered;
      assert.ok(lingered >= 15, `only ${lingered} snaps after GAME_OVER`);
      const elapsed = back._rx - over._rx;
      assert.ok(elapsed >= 600 && elapsed < 1500, `returned after ${elapsed.toFixed(0)} ms`);
      // and a new game can start again
      H.mark();
      H.send({ t: 'start' });
      await H.expect((m) => m.t === 'lobby' && m.state === 'game', 2000, 'restart');
      await H.nextSnap();
      H.close();
    } finally {
      await s2.close();
    }
  });

  // ---- heartbeat ---------------------------------------------------------------------------
  await test('heartbeat: silent socket is terminated, a ponging client stays connected', async () => {
    const s3 = await createGameServer({ sim: createFakeSim(), port: 0, host: '127.0.0.1', log: quietLog, heartbeatMs: 100, timeoutMs: 400 });
    try {
      const silent = await RawWs.connect(s3.port); // never answers pings
      const t0 = performance.now();
      const live = await Client.open(s3.port);
      await live.hello('Live', 'hb');
      await Promise.race([silent.endedP, sleep(3000).then(() => assert.fail('silent socket not terminated'))]);
      const took = performance.now() - t0;
      metrics.heartbeatTerminateMs = took.toFixed(0);
      assert.ok(took >= 350, `terminated too early (${took.toFixed(0)} ms)`);
      assert.ok(silent.frames.some((f) => f.op === 0x9), 'server sent pings');
      await sleep(400);
      assert.equal(live.ws.readyState, WebSocket.OPEN, 'auto-ponging client still open');
      live.close();
    } finally {
      await s3.close();
    }
  });

  // ---- real sim smoke test -----------------------------------------------------------------
  const simPath = path.join(ROOT_DIR, 'shared', 'sim.js');
  if (!fs.existsSync(simPath)) {
    skip('real sim smoke test', 'shared/sim.js does not exist yet');
  } else {
    let realSim = null;
    let importError = null;
    try {
      realSim = await import(pathToFileURL(simPath).href);
    } catch (err) {
      importError = err;
    }
    if (!importError && typeof realSim?.createGame !== 'function') {
      skip('real sim smoke test', 'shared/sim.js does not export createGame yet');
    } else {
      await test('real sim: start a game, receive snaps for 3 s, no crash', async () => {
        if (importError) throw importError;
        const logs = [];
        const s4 = await createGameServer({ sim: realSim, port: 0, host: '127.0.0.1', log: (m) => logs.push(m) });
        try {
          const P = await Client.open(s4.port);
          await P.hello('Smoke', 'smoke');
          const Q = await Client.open(s4.port);
          await Q.hello('Smoke2', 'smoke');
          P.mark();
          P.send({ t: 'config', teams: [4, 5], periodLength: 60, difficulty: 1 });
          await P.expect((m) => m.t === 'lobby' && m.config.periodLength === 60, 2000, 'config');
          P.send({ t: 'start' });
          await P.expect((m) => m.t === 'lobby' && m.state === 'game', 2000, 'game');
          const first = await P.nextSnap(() => true, 3000);
          checkSnapShape(first);
          const t0 = performance.now();
          let i = 0;
          while (performance.now() - t0 < 3000) {
            P.send({ t: 'in', seq: i, mx: Math.cos(i / 20), mz: Math.sin(i / 20), b: i % 40 < 3 ? 1 : i % 90 < 2 ? 2 : 8 });
            Q.send({ t: 'in', seq: i, mx: -1, mz: 0, b: i % 50 < 2 ? 1 : 0 });
            i++;
            await sleep(16);
          }
          const got = P.snaps.filter((s) => s._rx >= first._rx);
          const last = got[got.length - 1];
          checkSnapShape(last);
          checkRounded(last);
          const rate = got.length / ((last._rx - first._rx) / 1000);
          metrics.realSimSnapRate = rate.toFixed(2);
          metrics.realSimTicks = last.tick - first.tick;
          metrics.realSimEvents = [...new Set(got.flatMap((s) => s.ev.map((e) => e.type ?? e.e ?? e.t ?? '?')))].join(',') || '(none)';
          assert.ok(rate > SNAP_RATE * 0.8, `snap rate ${rate.toFixed(2)}`);
          assert.ok(last.tick > first.tick, 'sim tick advances');
          assert.ok(last.p.some((p) => p.c === P.id) && last.p.some((p) => p.c === Q.id), 'both humans control skaters');
          const crashed = logs.filter((m) => /threw|failed/.test(m));
          assert.equal(crashed.length, 0, crashed.join('\n'));
          assert.ok(s4.rooms.rooms.get('smoke')?.running, 'loop still running');
          P.close();
          Q.close();
        } finally {
          await s4.close();
        }
      });
    }
  }

  // ---- summary -----------------------------------------------------------------------------
  console.log('\nmetrics:');
  for (const [k, v] of Object.entries(metrics)) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  for (const fn of cleanups) {
    try {
      fn();
    } catch {}
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
