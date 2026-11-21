// Tests for test/netem-proxy.js. Run: node test/netem.test.js   (exits 1 on failure)
// An echo TCP server sits behind the proxy; we check the RTT distribution, byte order under heavy
// jitter, the bandwidth cap, spikes + head-of-line blocking, HTTP pass-through and clean shutdown.

import net from 'node:net';
import http from 'node:http';
import { createLagProxy, parseSpike } from './netem-proxy.js';

let failures = 0, passes = 0;
const results = [];
async function test(name, fn) {
  const t0 = performance.now();
  try {
    const note = await fn();
    passes++;
    console.log(`  ok   ${name} (${((performance.now() - t0) / 1000).toFixed(1)} s)${note ? `\n       ${note}` : ''}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e}`);
  }
  results.push(name);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Await p, failing with msg after ms (the timer is cleared either way so no handle leaks).
function within(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function startEcho() {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (s) => {
    s.setNoDelay(true);
    sockets.add(s);
    s.on('data', (b) => s.write(b));
    s.on('end', () => s.end());
    s.on('error', () => {});
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    server, sockets, port: server.address().port,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  })));
}

function connect(port) {
  return new Promise((res, rej) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.setNoDelay(true); res(s); });
    s.once('error', rej);
  });
}

// Line-oriented reader: calls onLine(line) for each '\n'-terminated line.
function lines(sock, onLine) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
}

const watchdog = setTimeout(() => { console.log('  FAIL watchdog: test run exceeded 120 s'); process.exit(1); }, 120000);

console.log('netem.test.js');

const echo = await startEcho();

await test('parseSpike', () => {
  const s = parseSpike('0.01:300');
  assert(s && s.prob === 0.01 && s.ms === 300, JSON.stringify(s));
  assert(parseSpike(null) === null && parseSpike('0') === null, 'null/0 => no spikes');
  assert(parseSpike({ prob: 0.5, ms: 10 }).ms === 10, 'object form');
  let threw = false;
  try { parseSpike('garbage'); } catch { threw = true; }
  assert(threw, 'bad spec throws');
});

await test('RTT distribution matches latency 60 +/- 20 (mean within 15%, spread ~ uniform sum)', async () => {
  const L = 60, J = 20;
  const expectSd = J / Math.sqrt(6); // sum of two independent U(-J/2, J/2)
  // Timing on a shared, busy machine is disturbed by other processes (20-150 ms scheduler stalls were
  // observed with the CPU at ~75%): allow up to 3 attempts.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const proxy = createLagProxy({ listenPort: 0, targetPort: echo.port, latencyMs: L, jitterMs: J, seed: 7 + attempt });
    await proxy.ready;
    const rtts = [];
    // 4 independent connections in parallel, each a strictly sequential ping-pong (no HOL effects).
    await Promise.all([0, 1, 2, 3].map(async () => {
      const s = await connect(proxy.port);
      let resolveLine;
      lines(s, (l) => resolveLine(l));
      for (let i = 0; i < 60; i++) {
        const t0 = performance.now();
        const got = new Promise((r) => { resolveLine = r; });
        s.write(`${i}\n`);
        const l = await got;
        assert(l === String(i), `echo mismatch ${l} != ${i}`);
        rtts.push(performance.now() - t0);
      }
      s.end();
    }));
    const st = proxy.stats();
    await proxy.close();
    const m = mean(rtts), sd = std(rtts), lo = Math.min(...rtts), p99 = pct(rtts, 0.99);
    const info = `n=${rtts.length} mean ${m.toFixed(1)} sd ${sd.toFixed(1)} (expect ${expectSd.toFixed(1)}) min ${lo.toFixed(1)} p50 ${pct(rtts, 0.5).toFixed(1)} p95 ${pct(rtts, 0.95).toFixed(1)} p99 ${p99.toFixed(1)} ms; proxy timer lateness mean ${st.s2c.timerLateMs.mean} max ${st.s2c.timerLateMs.max} ms`;
    try {
      assert(Math.abs(m - L) <= 0.15 * L, `mean RTT ${m.toFixed(1)} not within 15% of ${L}`);
      assert(lo >= L - J - 1, `min RTT ${lo.toFixed(1)} below ${L - J}`);
      assert(p99 <= L + J + 8, `p99 RTT ${p99.toFixed(1)} above ${L + J} (+8 ms slack)`);
      assert(sd > expectSd * 0.6 && sd < expectSd * 1.5, `RTT stdev ${sd.toFixed(1)} vs expected ${expectSd.toFixed(1)}`);
      return `${info}${attempt > 1 ? ` (attempt ${attempt}; first: ${lastErr.message})` : ''}`;
    } catch (e) {
      lastErr = new Error(`${e.message} [${info}]`);
    }
  }
  throw lastErr;
});

await test('LAN profile 2 +/- 1 ms stays precise despite the 15.6 ms Windows timer tick', async () => {
  const proxy = createLagProxy({ listenPort: 0, targetPort: echo.port, latencyMs: 2, jitterMs: 1, seed: 3 });
  await proxy.ready;
  const s = await connect(proxy.port);
  let resolveLine;
  lines(s, (l) => resolveLine(l));
  const rtts = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    const got = new Promise((r) => { resolveLine = r; });
    s.write(`${i}\n`);
    await got;
    rtts.push(performance.now() - t0);
  }
  s.end();
  await proxy.close();
  const m = mean(rtts);
  assert(m < 5, `mean LAN RTT ${m.toFixed(2)} ms (expected ~2-3 ms)`);
  return `mean ${m.toFixed(2)} p95 ${pct(rtts, 0.95).toFixed(2)} max ${Math.max(...rtts).toFixed(2)} ms`;
});

await test('byte order preserved under jitter: 10k numbered messages, jitter >> spacing', async () => {
  const proxy = createLagProxy({ listenPort: 0, targetPort: echo.port, latencyMs: 20, jitterMs: 40, seed: 11 });
  await proxy.ready;
  const s = await connect(proxy.port);
  const N = 10000;
  let next = 0, bad = null, bytesBack = 0, bytesOut = 0;
  const done = new Promise((res) => {
    lines(s, (l) => {
      bytesBack += l.length + 1;
      const [n, pad] = l.split(',');
      if (bad === null && (Number(n) !== next || pad !== 'x'.repeat(next % 50))) bad = `got "${l.slice(0, 40)}" expected #${next}`;
      next++;
      if (next === N) res();
    });
  });
  for (let i = 0; i < N; i++) {
    const msg = `${i},${'x'.repeat(i % 50)}\n`;
    bytesOut += msg.length;
    s.write(msg);
    if (i % 7 === 0) await new Promise((r) => setImmediate(r)); // separate TCP segments => many chunks
  }
  await done;
  const st = proxy.stats();
  s.end();
  await proxy.close();
  assert(bad === null, `order broken: ${bad}`);
  assert(bytesBack === bytesOut, `byte count ${bytesBack} != ${bytesOut}`);
  assert(st.c2s.chunks > 100, `too few upstream chunks to be meaningful (${st.c2s.chunks})`);
  assert(st.c2s.holChunks > 0 || st.s2c.holChunks > 0, 'expected head-of-line holds (jitter > chunk spacing)');
  return `${N} msgs, ${st.c2s.chunks} up / ${st.s2c.chunks} down chunks, HOL holds ${st.c2s.holChunks}/${st.s2c.holChunks}, delay p50 ${st.c2s.delayMs.p50} p95 ${st.c2s.delayMs.p95} ms`;
});

await test('bandwidth cap 800 kbps (100 KB/s) respected within 15%', async () => {
  const kbps = 800, rateBps = (kbps * 1000) / 8;
  const proxy = createLagProxy({ listenPort: 0, targetPort: echo.port, latencyMs: 0, jitterMs: 0, kbps, seed: 5 });
  await proxy.ready;
  const s = await connect(proxy.port);
  const total = 240 * 1024;
  let got = 0, tFirst = 0, firstLen = 0, tLast = 0;
  const done = new Promise((res) => s.on('data', (d) => {
    const t = performance.now();
    if (!got) { tFirst = t; firstLen = d.length; }
    got += d.length;
    tLast = t;
    if (got >= total) res();
  }));
  const block = Buffer.alloc(1024, 97);
  for (let i = 0; i < total / 1024; i++) s.write(block);
  await done;
  s.end();
  const st = proxy.stats();
  await proxy.close();
  const rate = (got - firstLen) / ((tLast - tFirst) / 1000);
  assert(Math.abs(rate - rateBps) <= 0.15 * rateBps, `measured ${(rate / 1024).toFixed(1)} KB/s vs cap ${(rateBps / 1024).toFixed(1)} KB/s`);
  return `measured ${(rate / 1000).toFixed(1)} kB/s (cap ${(rateBps / 1000).toFixed(1)} kB/s) over ${((tLast - tFirst) / 1000).toFixed(2)} s, source pauses ${st.c2s.pauses}`;
});

await test('spikes: 1% x 150 ms per chunk add head-of-line bursts, order preserved', async () => {
  const proxy = createLagProxy({ listenPort: 0, targetPort: echo.port, latencyMs: 10, jitterMs: 2, spike: '0.01:150', seed: 99 });
  await proxy.ready;
  const s = await connect(proxy.port);
  const N = 300, sentAt = [], rtt = [];
  let next = 0, bad = null;
  const done = new Promise((res) => lines(s, (l) => {
    if (Number(l) !== next && !bad) bad = `${l} != ${next}`;
    rtt.push(performance.now() - sentAt[next]);
    if (++next === N) res();
  }));
  for (let i = 0; i < N; i++) { sentAt.push(performance.now()); s.write(`${i}\n`); await sleep(10); } // 10..16 ms apart
  await done;
  const st = proxy.stats();
  s.end();
  await proxy.close();
  assert(!bad, `order broken ${bad}`);
  const spikes = st.c2s.spikes + st.s2c.spikes;
  const slow = rtt.filter((v) => v > 100).length;
  assert(spikes >= 1 && spikes <= 20, `spike count ${spikes} implausible for 1% of ${2 * N}`);
  assert(slow > spikes, `HOL should make more slow messages (${slow}) than spikes (${spikes})`);
  assert(pct(rtt, 0.5) < 25, `median RTT ${pct(rtt, 0.5).toFixed(1)} should stay near 10 ms`);
  return `${spikes} spikes -> ${slow}/${N} messages > 100 ms RTT, p50 ${pct(rtt, 0.5).toFixed(1)} p95 ${pct(rtt, 0.95).toFixed(1)} max ${Math.max(...rtt).toFixed(1)} ms`;
});

await test('HTTP request through the proxy', async () => {
  const hs = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`hello ${req.url}`); });
  await new Promise((r) => hs.listen(0, '127.0.0.1', r));
  const proxy = createLagProxy({ listenPort: 0, targetPort: hs.address().port, latencyMs: 30, jitterMs: 4 });
  await proxy.ready;
  const t0 = performance.now();
  const r = await fetch(`http://127.0.0.1:${proxy.port}/x?y=1`, { headers: { connection: 'close' } });
  const body = await r.text();
  const ms = performance.now() - t0;
  await proxy.close();
  await new Promise((r2) => { hs.closeAllConnections?.(); hs.close(r2); });
  assert(r.status === 200 && body === 'hello /x?y=1', `bad response ${r.status} ${body}`);
  assert(ms >= 30, `HTTP round trip ${ms.toFixed(1)} ms should include >= 1 proxied RTT`);
  return `GET took ${ms.toFixed(1)} ms through a 30 ms RTT proxy`;
});

await test('clean close: half-close delivers queued data + FIN, both sides close, stats return to 0', async () => {
  const proxy = createLagProxy({ listenPort: 0, targetPort: echo.port, latencyMs: 80, jitterMs: 10 });
  await proxy.ready;
  const s = await connect(proxy.port);
  let back = '';
  const ended = new Promise((r) => s.on('end', r));
  const closed = new Promise((r) => s.on('close', r));
  s.setEncoding('utf8');
  s.on('data', (d) => { back += d; });
  const payload = 'last words before FIN\n'.repeat(50);
  s.write(payload);
  s.end(); // FIN right behind the data: the proxy must deliver the data first
  await ended;
  await closed;
  assert(back === payload, `got ${back.length} bytes back, expected ${payload.length}`);
  await sleep(50);
  const st = proxy.stats();
  assert(st.connections.active === 0, `active connections ${st.connections.active} after close`);
  assert(echo.sockets.size === 0, `echo server still has ${echo.sockets.size} sockets`);

  // Server-initiated abrupt close propagates to the client.
  const s2 = await connect(proxy.port);
  const c2 = new Promise((r) => s2.on('close', r));
  s2.on('error', () => {});
  s2.resume();
  s2.write('hi\n');
  await sleep(150);
  for (const es of echo.sockets) es.destroy();
  await within(c2, 2000, 'client not closed after server destroy');

  // Client abrupt destroy propagates to the server.
  const s3 = await connect(proxy.port);
  s3.write('x\n');
  await sleep(120);
  const n0 = echo.sockets.size;
  s3.destroy();
  await sleep(100);
  assert(n0 === 1 && echo.sockets.size === 0, `server socket not closed after client destroy (${n0} -> ${echo.sockets.size})`);

  // Target refused: client gets closed promptly instead of hanging.
  const dead = net.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  const p2 = createLagProxy({ listenPort: 0, targetPort: deadPort, latencyMs: 10 });
  await p2.ready;
  const s4 = await connect(p2.port);
  s4.on('error', () => {});
  s4.resume();
  await within(new Promise((r) => s4.on('close', r)), 3000, 'refused target: client not closed');
  assert(p2.stats().connections.refused === 1, 'refused count');
  await p2.close();

  // close() with live connections destroys them and leaves no handles behind.
  const s5 = await connect(proxy.port);
  s5.on('error', () => {});
  s5.resume();
  s5.write('pending data\n');
  const c5 = new Promise((r) => s5.on('close', r));
  await proxy.close();
  await within(c5, 2000, 'client not closed by proxy.close()');
  await proxy.close(); // idempotent
  return 'FIN ordering, RST both ways, refused target, close() with live connections';
});

await echo.close();
clearTimeout(watchdog);
await sleep(50);
const leftovers = process.getActiveResourcesInfo().filter((r) => /TCP|Timeout|Immediate/.test(r));
if (leftovers.length) { failures++; console.log(`  FAIL leftover handles after close: ${leftovers.join(', ')}`); }
else console.log('  ok   no leftover sockets/timers after close');

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
