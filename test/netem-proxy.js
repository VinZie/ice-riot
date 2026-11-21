// ICE RIOT - "netem" lag proxy: a TCP proxy that adds latency, jitter, rare latency spikes and an
// optional bandwidth cap, so the game can be played / tested as if over a slow tailnet.
// Works for HTTP and WebSocket alike (WebSocket is just TCP after the upgrade).
//
// CLI:
//   node test/netem-proxy.js --listen 9000 --target 127.0.0.1:8765 --latency 60 --jitter 25 \
//                            --spikes 0.01:300 --kbps 0
//   node test/netem-proxy.js --listen 9000 --profile derp        (lan | tailnet | derp | wifi)
//   then open http://localhost:9000/ in a browser instead of :8765.
//   Options: --host <ip> (listen address, default 127.0.0.1; use 0.0.0.0 for other machines),
//            --seed <int>, --stats <seconds between stat lines, 0 = off>, --burst <bytes>,
//            --coarse (do not spin for sub-15 ms timer precision on Windows; saves CPU).
//
// Module:
//   import { createLagProxy } from './netem-proxy.js';
//   const proxy = createLagProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: 8765,
//                                  latencyMs: 90, jitterMs: 30, spike: '0.01:300', kbps: 0 });
//   await proxy.ready;        // resolves when listening (proxy.port is valid right away for IP hosts)
//   proxy.port; proxy.stats(); await proxy.close();
//
// Model (per TCP connection, independently per direction):
//   * every chunk read from one side is delivered to the other after a one-way delay of
//       latencyMs/2 + U(-jitterMs/2, +jitterMs/2)       (so RTT = latencyMs +/- jitterMs)
//     plus, with probability spike.prob, an extra spike.ms (models DERP relay hiccups / Wi-Fi stalls).
//   * byte order is preserved: deliveryTime = max(previous deliveryTime, now + delay). That is TCP
//     head-of-line blocking: a spiked chunk holds back everything behind it, which then arrives in a
//     burst - exactly what a browser sees from a stalled TCP connection.
//   * kbps > 0: a token-bucket bottleneck (rate kbps, burst `burstBytes`) in front of the delay line.
//     Chunks are sliced to 4 KB so large writes stream out at the capped rate.
//   * a receive "window": when more than windowBytes are queued in one direction the source socket is
//     paused, so a capped link pushes back on the sender (the game server then sees bufferedAmount
//     grow, like on a real slow link) instead of the proxy buffering without bound.
//   * FIN is forwarded in order after all queued data (half-close works); resets/errors tear down both.
//
// Timer precision: Windows Node timers fire on the ~15.6 ms system tick, which would wreck a 2 ms
// LAN profile. The proxy therefore sleeps with setTimeout until ~33 ms before the next delivery and
// spins with setImmediate for the rest (one busy core while traffic flows). Pass coarse:true /
// --coarse to trade precision for CPU.

import net from 'node:net';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const DEFAULT_SLACK_MS = IS_WIN ? 33 : 3;     // sleep until this long before a deadline, then spin (2 Windows ticks: loaded machines fire late)
const SLICE_BYTES = 4096;                     // chunk slicing when a bandwidth cap is active
const DELAY_RING = 4096;                      // recent per-chunk delays kept for percentiles

export const PROFILES = {
  lan: { latencyMs: 2, jitterMs: 1, spike: null },
  tailnet: { latencyMs: 25, jitterMs: 5, spike: null },
  derp: { latencyMs: 90, jitterMs: 30, spike: { prob: 0.01, ms: 300 } },
  wifi: { latencyMs: 60, jitterMs: 60, spike: null },
};

// "0.01:300" | {prob, ms} | null -> {prob, ms} | null
export function parseSpike(v) {
  if (v == null || v === '' || v === false || v === 0 || v === '0') return null;
  if (typeof v === 'object') {
    const prob = Number(v.prob ?? v.p ?? 0), ms = Number(v.ms ?? 0);
    return prob > 0 && ms > 0 ? { prob: Math.min(1, prob), ms } : null;
  }
  const m = /^\s*([0-9.eE+-]+)\s*[:@x]\s*([0-9.]+)\s*$/.exec(String(v));
  if (!m) throw new Error(`bad spike spec "${v}" (expected probability:ms, e.g. 0.01:300)`);
  return parseSpike({ prob: Number(m[1]), ms: Number(m[2]) });
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function summarize(ring, n) {
  const len = Math.min(n, ring.length);
  if (!len) return { n: 0, min: 0, p50: 0, p95: 0, max: 0 };
  const a = Array.from(ring.subarray(0, len)).sort((x, y) => x - y);
  const q = (p) => a[Math.min(len - 1, Math.floor(p * len))];
  return { n: len, min: a[0], p50: q(0.5), p95: q(0.95), max: a[len - 1] };
}

const r1 = (v) => Math.round(v * 10) / 10;

/**
 * Create and start a lag proxy. Returns synchronously:
 *   { port, ready: Promise<proxy>, stats(), close(): Promise<void>, setConfig(partial) }
 */
export function createLagProxy(opts = {}) {
  const {
    listenPort = 0,
    listenHost = '127.0.0.1',
    targetHost = '127.0.0.1',
    targetPort,
    seed = (Math.random() * 2 ** 31) | 0,
    windowBytes = 256 * 1024,
    coarse = false,
    timerSlackMs = DEFAULT_SLACK_MS,
    log = null,
  } = opts;
  if (!targetPort) throw new Error('createLagProxy: targetPort is required');

  const cfg = {};
  function applyConfig(o) {
    if (o.latencyMs !== undefined) cfg.latencyMs = Math.max(0, Number(o.latencyMs) || 0);
    if (o.jitterMs !== undefined) cfg.jitterMs = Math.max(0, Number(o.jitterMs) || 0);
    if (o.spike !== undefined) cfg.spike = parseSpike(o.spike);
    if (o.kbps !== undefined) cfg.kbps = Math.max(0, Number(o.kbps) || 0);
    if (o.burstBytes !== undefined || cfg.burstBytes === undefined) {
      cfg.burstBytes = o.burstBytes ?? null; // null => auto: max(4 KB, 20 ms worth of rate)
    }
  }
  applyConfig({ latencyMs: 0, jitterMs: 0, spike: null, kbps: 0, ...opts });

  const rand = mulberry32(seed);
  const conns = new Set();
  const lanes = new Set();
  const totals = { connections: 0, refused: 0 };
  const dirTotals = { c2s: newDirStats(), s2c: newDirStats() };
  let timer = null, immediate = null, closed = false;

  function newDirStats() {
    return { chunks: 0, bytes: 0, spikes: 0, holChunks: 0, holMs: 0, timerLateMax: 0, timerLateSum: 0,
      delivered: 0, pauses: 0, ring: new Float64Array(DELAY_RING), ringN: 0, ringI: 0, delaySum: 0 };
  }

  // ---- token bucket (per lane) ------------------------------------------------------------
  function bucketDeparture(lane, now, size) {
    const rate = cfg.kbps / 8;                                  // bytes per ms
    const cap = cfg.burstBytes ?? Math.max(4096, rate * 20);
    const b = lane.bucket;
    if (b.tAt === 0) { b.tokens = cap; b.tAt = now; }
    let t0 = Math.max(now, b.lastDep);
    let tok = Math.min(cap, b.tokens + (t0 - b.tAt) * rate);
    const need = Math.min(size, cap);
    if (tok < need) { t0 += (need - tok) / rate; tok = need; }
    b.tokens = tok - size;
    b.tAt = t0;
    b.lastDep = t0;
    return t0;
  }

  function drawDelay(st, allowSpike) {
    let d = cfg.latencyMs / 2 + (rand() - 0.5) * cfg.jitterMs;
    if (allowSpike && cfg.spike && rand() < cfg.spike.prob) { d += cfg.spike.ms; st.spikes++; }
    return Math.max(0, d);
  }

  // ---- lanes: one ordered delay line per direction per connection --------------------------
  function makeLane(dir, src, dst) {
    const lane = { dir, src, dst, q: [], qi: 0, lastAt: 0, queuedBytes: 0, paused: false, ended: false,
      bucket: { tokens: 0, tAt: 0, lastDep: 0 }, st: dirTotals[dir] };
    lanes.add(lane);
    return lane;
  }

  function enqueue(lane, buf) {
    if (closed) return;
    const now = performance.now();
    const st = lane.st;
    const pieces = cfg.kbps > 0 && buf.length > SLICE_BYTES
      ? Array.from({ length: Math.ceil(buf.length / SLICE_BYTES) }, (_, i) => buf.subarray(i * SLICE_BYTES, (i + 1) * SLICE_BYTES))
      : [buf];
    for (const piece of pieces) {
      const dep = cfg.kbps > 0 ? bucketDeparture(lane, now, piece.length) : now;
      const delay = drawDelay(st, true);
      let at = dep + delay;
      if (at < lane.lastAt) { st.holChunks++; st.holMs += lane.lastAt - at; at = lane.lastAt; }
      lane.lastAt = at;
      lane.q.push({ at, buf: piece });
      lane.queuedBytes += piece.length;
      st.chunks++;
      st.bytes += piece.length;
      st.ring[st.ringI] = at - now;
      st.ringI = (st.ringI + 1) % DELAY_RING;
      st.ringN++;
      st.delaySum += at - now;
    }
    if (!lane.paused && lane.queuedBytes + lane.dst.writableLength > windowBytes) {
      lane.paused = true;
      st.pauses++;
      lane.src.pause();
    }
    kick();
  }

  function enqueueEnd(lane) {
    if (closed || lane.ended) return;
    lane.ended = true;
    const now = performance.now();
    const at = Math.max(lane.lastAt, now + drawDelay(lane.st, false));
    lane.lastAt = at;
    lane.q.push({ at, buf: null });
    kick();
  }

  function flushLane(lane, now) {
    const st = lane.st;
    while (lane.qi < lane.q.length && lane.q[lane.qi].at <= now + 0.05) {
      const item = lane.q[lane.qi++];
      const late = Math.max(0, now - item.at);
      if (late > st.timerLateMax) st.timerLateMax = late;
      st.timerLateSum += late;
      if (item.buf === null) {
        if (!lane.dst.destroyed) lane.dst.end();
      } else {
        lane.queuedBytes -= item.buf.length;
        st.delivered++;
        if (!lane.dst.destroyed && lane.dst.writable) lane.dst.write(item.buf);
      }
    }
    if (lane.qi > 256 && lane.qi * 2 > lane.q.length) { lane.q = lane.q.slice(lane.qi); lane.qi = 0; }
    if (lane.paused && lane.queuedBytes + lane.dst.writableLength <= windowBytes / 2) {
      lane.paused = false;
      if (!lane.src.destroyed) lane.src.resume();
    }
  }

  // ---- one pump for the whole proxy: sleep coarsely, spin the last few ms ------------------
  function nextDeadline() {
    let best = Infinity;
    for (const lane of lanes) if (lane.qi < lane.q.length && lane.q[lane.qi].at < best) best = lane.q[lane.qi].at;
    return best;
  }

  function pump() {
    timer = immediate = null;
    if (closed) return;
    const now = performance.now();
    for (const lane of lanes) flushLane(lane, now);
    schedule();
  }

  function schedule() {
    if (closed || immediate) return;
    const dl = nextDeadline();
    if (dl === Infinity) return;
    const wait = dl - performance.now();
    if (timer) clearTimeout(timer), (timer = null);
    if (wait <= 0.05) immediate = setImmediate(pump);
    else if (coarse) timer = setTimeout(pump, Math.max(1, Math.ceil(wait)));
    else if (wait <= timerSlackMs) immediate = setImmediate(pump);
    else timer = setTimeout(pump, Math.max(1, Math.floor(wait - timerSlackMs)));
  }

  function kick() { if (!immediate) schedule(); }

  // ---- connections -------------------------------------------------------------------------
  const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: false }, (client) => {
    if (closed) { client.destroy(); return; }
    totals.connections++;
    const upstream = net.connect({ host: targetHost, port: targetPort, allowHalfOpen: true });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const conn = { client, upstream, up: makeLane('c2s', client, upstream), down: makeLane('s2c', upstream, client), done: false };
    conns.add(conn);
    let connected = false;
    upstream.once('connect', () => { connected = true; });

    // Error / reset on either side: drop everything (like an RST). A clean shutdown instead flows
    // through the lanes: FIN is queued behind the data and forwarded with dst.end(); with
    // allowHalfOpen each socket closes once both of its directions are done.
    const teardown = () => {
      if (conn.done) return;
      conn.done = true;
      conns.delete(conn);
      lanes.delete(conn.up);
      lanes.delete(conn.down);
      client.destroy();
      upstream.destroy();
    };
    let closedCount = 0;
    const onClose = (hadError) => { if (hadError || ++closedCount === 2) teardown(); };
    client.on('data', (b) => enqueue(conn.up, b));
    upstream.on('data', (b) => enqueue(conn.down, b));
    client.on('end', () => enqueueEnd(conn.up));
    upstream.on('end', () => enqueueEnd(conn.down));
    client.on('error', teardown);
    upstream.on('error', (err) => {
      if (!connected) totals.refused++;
      if (log) log(`upstream ${targetHost}:${targetPort}: ${err.code || err.message}`);
      teardown();
    });
    client.on('close', onClose);
    upstream.on('close', onClose);
  });

  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {});
  server.on('error', (err) => { if (log) log(`proxy server error: ${err.message}`); rejectReady(err); });
  server.listen(listenPort, listenHost, () => resolveReady(proxy));

  const proxy = {
    get port() { const a = server.address(); return a && typeof a === 'object' ? a.port : listenPort; },
    ready,
    config: cfg,
    setConfig(partial) { applyConfig(partial); return { ...cfg }; },
    stats() {
      const dir = (s) => {
        const sum = summarize(s.ring, s.ringN);
        return {
          chunks: s.chunks, bytes: s.bytes, delivered: s.delivered, spikes: s.spikes,
          holChunks: s.holChunks, holMsTotal: r1(s.holMs), pauses: s.pauses,
          delayMs: { mean: s.chunks ? r1(s.delaySum / s.chunks) : 0, min: r1(sum.min), p50: r1(sum.p50), p95: r1(sum.p95), max: r1(sum.max), window: sum.n },
          timerLateMs: { mean: s.delivered ? Math.round((s.timerLateSum / s.delivered) * 100) / 100 : 0, max: r1(s.timerLateMax) },
        };
      };
      let queued = 0, queuedBytes = 0;
      for (const lane of lanes) { queued += lane.q.length - lane.qi; queuedBytes += lane.queuedBytes; }
      return {
        port: proxy.port,
        target: `${targetHost}:${targetPort}`,
        config: { latencyMs: cfg.latencyMs, jitterMs: cfg.jitterMs, spike: cfg.spike, kbps: cfg.kbps, seed },
        connections: { active: conns.size, total: totals.connections, refused: totals.refused },
        queued, queuedBytes,
        c2s: dir(dirTotals.c2s),
        s2c: dir(dirTotals.s2c),
      };
    },
    close() {
      if (closed) return proxy._closing;
      closed = true;
      if (timer) clearTimeout(timer);
      if (immediate) clearImmediate(immediate);
      timer = immediate = null;
      for (const c of [...conns]) { c.done = true; c.client.destroy(); c.upstream.destroy(); }
      conns.clear();
      lanes.clear();
      proxy._closing = new Promise((resolve) => server.close(() => resolve()));
      return proxy._closing;
    },
  };
  return proxy;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[key] = true;
    else { a[key] = next; i++; }
  }
  return a;
}

function fmtDir(name, s, prev, dtSec) {
  const msgs = ((s.chunks - (prev?.chunks || 0)) / dtSec).toFixed(0);
  const kbs = ((s.bytes - (prev?.bytes || 0)) / 1024 / dtSec).toFixed(1);
  const d = s.delayMs;
  return `${name} ${msgs}/s ${kbs} KB/s delay p50 ${d.p50} p95 ${d.p95} max ${d.max} ms, spikes ${s.spikes}, hol ${s.holChunks}`;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || a.h) {
    console.log('usage: node test/netem-proxy.js --listen 9000 --target 127.0.0.1:8765 [--latency ms] [--jitter ms] [--spikes p:ms] [--kbps n] [--profile lan|tailnet|derp|wifi] [--host 127.0.0.1] [--seed n] [--stats s] [--burst bytes] [--coarse]');
    return;
  }
  const prof = a.profile ? PROFILES[a.profile] : null;
  if (a.profile && !prof) throw new Error(`unknown profile "${a.profile}" (${Object.keys(PROFILES).join(', ')})`);
  const [th, tp] = String(a.target || '127.0.0.1:8765').split(':');
  const opts = {
    listenPort: Number(a.listen ?? 9000),
    listenHost: a.host || '127.0.0.1',
    targetHost: th || '127.0.0.1',
    targetPort: Number(tp || 8765),
    latencyMs: Number(a.latency ?? prof?.latencyMs ?? 0),
    jitterMs: Number(a.jitter ?? prof?.jitterMs ?? 0),
    spike: a.spikes !== undefined ? a.spikes : prof?.spike ?? null,
    kbps: Number(a.kbps ?? 0),
    coarse: !!a.coarse,
    log: (s) => console.log(`[netem] ${s}`),
  };
  if (a.seed !== undefined) opts.seed = Number(a.seed);
  if (a.burst !== undefined) opts.burstBytes = Number(a.burst);
  const proxy = createLagProxy(opts);
  await proxy.ready;
  const c = proxy.stats().config;
  console.log(`[netem] ${opts.listenHost}:${proxy.port} -> ${opts.targetHost}:${opts.targetPort}  RTT ${c.latencyMs} +/- ${c.jitterMs} ms` +
    `${c.spike ? `, spikes ${c.spike.prob * 100}% x ${c.spike.ms} ms` : ''}${c.kbps ? `, cap ${c.kbps} kbps` : ''}, seed ${c.seed}`);
  const every = Number(a.stats ?? 2);
  let prev = proxy.stats(), prevT = performance.now();
  const iv = every > 0 ? setInterval(() => {
    const s = proxy.stats(), t = performance.now(), dt = (t - prevT) / 1000;
    if (s.c2s.chunks !== prev.c2s.chunks || s.s2c.chunks !== prev.s2c.chunks || s.connections.active !== prev.connections.active) {
      console.log(`[netem] conns ${s.connections.active}/${s.connections.total} | ${fmtDir('up', s.c2s, prev.c2s, dt)} | ${fmtDir('down', s.s2c, prev.s2c, dt)}`);
    }
    prev = s; prevT = t;
  }, every * 1000) : null;
  const stop = async () => {
    if (iv) clearInterval(iv);
    const s = proxy.stats();
    await proxy.close();
    console.log(`[netem] closed. ${JSON.stringify({ connections: s.connections, up: s.c2s.delayMs, down: s.s2c.delayMs })}`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`[netem] ${e.message}`); process.exit(1); });
}
