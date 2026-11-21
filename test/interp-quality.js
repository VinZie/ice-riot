// ICE RIOT - offline quality lab for the client's snapshot interpolation (public/net.js).
//
//   node test/interp-quality.js                     full report: 4 network profiles x 60/144 fps (~10 s)
//   node test/interp-quality.js --quick             shorter runs (60 s virtual each)
//   node test/interp-quality.js --sweep             + fixed-delay sweep, constant variants, net.js vs REC table
//   node test/interp-quality.js --live [--seconds 60] [--profile derp]
//                                                   real server -> netem proxy -> test/bots.js + net.js probes
//   options: --seconds N (virtual seconds per run, default 180), --seed N,
//            --profiles lan,tailnet,derp,wifi[,shift], --fps 60,144, --json <path>,
//            --server-timer win|precise (server loop wake model, default win),
//            --variants '[["name",{...params}]]' (custom mirror variants for --sweep, see NETJS_PARAMS)
//
// What it does (offline mode, fully deterministic, runs in virtual time - no sockets, no real timers):
//   * Synthesises the server: the exact room.js fixed-timestep loop (60 Hz sim, snapshot every 2 ticks,
//     snapshot `time` = scheduled step time), woken like Node on Windows (15.625 ms system tick, plus
//     rare 5-40 ms hiccups), producing CONTRACT-shaped JSON snapshots (8 players + puck, rounded to
//     3 decimals) of a skater on a curvy path and a puck that is shot around and bounces off the boards.
//     The server clock runs at an offset (and 25 ppm drift) from the client clock.
//   * Network: two ordered TCP lanes (same model as test/netem-proxy.js): one-way delay latency/2 +/-
//     jitter/2, optional spikes, delivery = max(previous delivery, send + delay) => head-of-line bursts.
//   * Client: the REAL createNet() from public/net.js (fake WebSocket + virtual setTimeout/setInterval),
//     driven by a rAF-like loop at 60 or 144 fps that sends inputs (<= 60/s) and calls getState(now).
//     If net.js is missing or lacks createNet, a reference implementation of the CONTRACT is used.
//   * Metrics vs ground truth at the render time the client chose (rt = serverNow - interpDelay):
//     position error (skater + puck), % frames extrapolating, % frames stalled (rendered skater did not
//     move although the truth did), visible jerk (2nd difference of the rendered skater position minus
//     the 2nd difference of an ideal constant-delay playback), render-clock warp, visual latency
//     (true server time - rt), clock-offset error.
//
// The --sweep variants use a parameterised mirror of createNet().getState() built on net.js's exported
// pure functions (createInterpBuffer / pushSnap / sampleAt / clockSample / estimateClock), so constants
// can be compared without editing net.js. "mirror(net.js)" must reproduce the real createNet numbers.
// REC_PARAMS is the recommended configuration (spike-robust lateness, coast, correction blend).
//
// Live mode (--live) starts the real server (server/app.js + shared/sim.js, without the stats store, so
// nothing is written to data/), test/netem-proxy.js in its own process, test/bots.js through the proxy
// (one bot hosts and starts a game), and two spectating createNet() probes in this process: one through
// the proxy and one direct. The direct probe's snapshot stream is the ground truth for the proxied one.
// Logs and JSON go to <tmp>/claude/ice-riot-netem/. All child processes are killed at the end.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROFILES as PROXY_PROFILES, mulberry32 } from './netem-proxy.js';
import { boardDistance, PUCK, SNAP_RATE, TICK_RATE, PHASE, PSTATE } from '../shared/constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STEP_MS = 1000 / TICK_RATE;
const SNAP_MS = 1000 / SNAP_RATE;
const TICKS_PER_SNAP = Math.max(1, Math.round(TICK_RATE / SNAP_RATE));
const WARMUP_MS = 8000;            // ignore the first seconds (clock sync settling)

export const LAB_PROFILES = {
  lan: { label: 'LAN 2+/-1', ...PROXY_PROFILES.lan },
  tailnet: { label: 'tailnet 25+/-5', ...PROXY_PROFILES.tailnet },
  derp: { label: 'DERP 90+/-30 +1%x300', ...PROXY_PROFILES.derp },
  wifi: { label: 'Wi-Fi 60+/-60', ...PROXY_PROFILES.wifi },
  // Tailscale path change: direct 25+/-5, falls back to a DERP relay (90+/-30, no spikes) after 1/3 of the
  // run, upgrades back to direct after 2/3. Checks that spike rejection still follows real level shifts.
  shift: { label: 'route 25->90->25', ...PROXY_PROFILES.tailnet, phases: [[1 / 3, { latencyMs: 90, jitterMs: 30 }], [2 / 3, { latencyMs: 25, jitterMs: 5 }]] },
};

// ---------------------------------------------------------------------------------------------
// net.js loading (with a reference fallback)
// ---------------------------------------------------------------------------------------------

const NET_PATH = path.join(ROOT, 'public', 'net.js');
const CORE_FNS = ['createInterpBuffer', 'pushSnap', 'sampleAt', 'clockSample', 'estimateClock'];

async function loadNet() {
  if (!existsSync(NET_PATH)) return { mod: null, why: 'public/net.js not found' };
  try {
    // cache-bust so a long-running session always sees the current file
    const mod = await import(`${pathToFileURL(NET_PATH).href}?t=${Date.now()}`);
    return { mod, why: null };
  } catch (e) {
    return { mod: null, why: `import failed: ${e.message}` };
  }
}

// Reference interpolation core per docs/CONTRACT.md (used only when net.js lacks the functions).
const REF = (() => {
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAngle = (a, b, t) => a + ((((b - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) * t;
  function lerpSnapshots(a, b, rt) {
    const span = b.time - a.time;
    const t = span > 0 ? Math.min(1, Math.max(0, (rt - a.time) / span)) : 1;
    const out = { ...b, time: rt };
    out.p = b.p.map((pb, i) => {
      const pa = a.p[i];
      if (!pa || Math.hypot(pb.x - pa.x, pb.z - pa.z) > 4) return { ...pb };
      return { ...pb, x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t), z: lerp(pa.z, pb.z, t), f: lerpAngle(pa.f, pb.f, t) };
    });
    const ka = a.k, kb = b.k;
    out.k = Math.hypot(kb.x - ka.x, kb.z - ka.z) > 4 ? { ...kb } : { ...kb, x: lerp(ka.x, kb.x, t), y: lerp(ka.y, kb.y, t), z: lerp(ka.z, kb.z, t) };
    return out;
  }
  function extrapolateSnapshot(s, ms, maxMs = 100) {
    const dt = Math.max(0, Math.min(ms, maxMs)) / 1000;
    return { ...s, time: s.time + dt * 1000, p: s.p.map((p) => ({ ...p, x: p.x + p.vx * dt, z: p.z + p.vz * dt })),
      k: { ...s.k, x: s.k.x + s.k.vx * dt, z: s.k.z + s.k.vz * dt } };
  }
  return {
    createInterpBuffer: (o = {}) => ({ snaps: [], maxExtrapMs: o.maxExtrapMs ?? 100, lastRT: -Infinity }),
    pushSnap(buf, s) {
      const last = buf.snaps[buf.snaps.length - 1];
      if (last && s.time <= last.time) return false;
      buf.snaps.push(s);
      if (buf.snaps.length > 120) buf.snaps.shift();
      return true;
    },
    sampleAt(buf, rt) {
      const S = buf.snaps;
      if (!S.length) return { state: null, events: [], mode: 'empty' };
      rt = Math.max(rt, buf.lastRT); buf.lastRT = rt;
      if (rt <= S[0].time) return { state: extrapolateSnapshot(S[0], 0), events: [], mode: 'hold' };
      const newest = S[S.length - 1];
      if (rt >= newest.time) return { state: extrapolateSnapshot(newest, rt - newest.time, buf.maxExtrapMs), events: [], mode: 'extrap' };
      let j = 0;
      while (j < S.length - 2 && S[j + 1].time <= rt) j++;
      if (j > 0) S.splice(0, j);
      return { state: lerpSnapshots(S[0], S[1], rt), events: [], mode: 'interp' };
    },
    clockSample: (c, s, now) => ({ rtt: Math.max(0, now - c), offset: s - (c + Math.max(0, now - c) / 2), at: now }),
    estimateClock(samples) {
      const by = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(samples.length / 3)));
      const o = by.map((s) => s.offset).sort((a, b) => a - b);
      return { offset: o[o.length >> 1], minRtt: by[0].rtt };
    },
  };
})();

// ---------------------------------------------------------------------------------------------
// Virtual time: event heap + fake timers + fake WebSocket
// ---------------------------------------------------------------------------------------------

class Sched {
  constructor() { this.now = 0; this.h = []; this.seq = 0; }
  at(t, fn) {
    const ev = { t, s: this.seq++, fn, dead: false };
    const h = this.h;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].t < ev.t || (h[p].t === ev.t && h[p].s < ev.s)) break;
      h[i] = h[p]; i = p;
    }
    h[i] = ev;
    return ev;
  }
  pop() {
    const h = this.h, top = h[0], last = h.pop();
    if (h.length) {
      let i = 0;
      const n = h.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mv = last;
        if (l < n && (h[l].t < mv.t || (h[l].t === mv.t && h[l].s < mv.s))) { m = l; mv = h[l]; }
        if (r < n && (h[r].t < mv.t || (h[r].t === mv.t && h[r].s < mv.s))) { m = r; mv = h[r]; }
        if (m === i) break;
        h[i] = h[m]; i = m;
      }
      h[i] = last;
    }
    return top;
  }
  runUntil(T) {
    while (this.h.length && this.h[0].t <= T) {
      const ev = this.pop();
      if (ev.dead) continue;
      this.now = ev.t;
      ev.fn();
    }
    this.now = T;
  }
}

function installVirtualGlobals(sched, FakeWS) {
  const saved = {};
  for (const k of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'WebSocket']) saved[k] = globalThis[k];
  globalThis.setTimeout = (fn, ms = 0, ...a) => { const h = { ev: null }; h.ev = sched.at(sched.now + Math.max(0, +ms || 0), () => fn(...a)); return h; };
  globalThis.clearTimeout = (h) => { if (h && h.ev) h.ev.dead = true; };
  globalThis.setInterval = (fn, ms = 0, ...a) => {
    const h = { ev: null };
    const period = Math.max(1, +ms || 0);
    const tick = () => { h.ev = sched.at(sched.now + period, tick); fn(...a); };
    h.ev = sched.at(sched.now + period, tick);
    return h;
  };
  globalThis.clearInterval = globalThis.clearTimeout;
  globalThis.WebSocket = FakeWS;
  return () => { for (const k in saved) globalThis[k] = saved[k]; };
}

// Ordered lane: one-way delay latency/2 +/- jitter/2 (+ spike), FIFO (TCP head-of-line).
function makeLane(rand, prof, endT = Infinity) {
  let last = 0;
  return (t) => {
    let pr = prof;
    if (prof.phases) for (const [frac, over] of prof.phases) if (t >= frac * endT) pr = { ...prof, ...over };
    let d = pr.latencyMs / 2 + (rand() - 0.5) * pr.jitterMs;
    if (pr.spike && rand() < pr.spike.prob) d += pr.spike.ms;
    const at = Math.max(last, t + Math.max(0, d));
    last = at;
    return at;
  };
}

const round3 = (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);

// ---------------------------------------------------------------------------------------------
// Ground truth: skaters on smooth curvy paths, a puck that is shot around and bounces off boards
// ---------------------------------------------------------------------------------------------

function skaterPath(id) {
  // sum of sinusoids: speeds ~3-11 m/s, lateral accelerations up to ~12 m/s^2 (tight turns)
  const ph = id * 1.7;
  const ax = [16 - id, 0.37 + 0.03 * id, ph], bx = [3.5, 1.31, ph * 2.1], cx = [0.8, 3.1, ph * 0.7];
  const az = [7.5, 0.59 + 0.02 * id, ph + 0.3], bz = [3, 1.73, ph * 1.3], cz = [0.6, 2.7, ph * 0.4];
  const sx = (id % 4) * 1.5 - 2;
  return (tau) => {
    const x = sx + ax[0] * Math.sin(ax[1] * tau + ax[2]) + bx[0] * Math.sin(bx[1] * tau + bx[2]) + cx[0] * Math.sin(cx[1] * tau + cx[2]);
    const z = az[0] * Math.sin(az[1] * tau + az[2]) + bz[0] * Math.sin(bz[1] * tau + bz[2]) + cz[0] * Math.sin(cz[1] * tau + cz[2]);
    const vx = ax[0] * ax[1] * Math.cos(ax[1] * tau + ax[2]) + bx[0] * bx[1] * Math.cos(bx[1] * tau + bx[2]) + cx[0] * cx[1] * Math.cos(cx[1] * tau + cx[2]);
    const vz = az[0] * az[1] * Math.cos(az[1] * tau + az[2]) + bz[0] * bz[1] * Math.cos(bz[1] * tau + bz[2]) + cz[0] * cz[1] * Math.cos(cz[1] * tau + cz[2]);
    return { x, z, vx, vz };
  };
}

// Puck track at 1 ms resolution: random shots / passes every 0.6-2.2 s, ice friction, board bounces.
function puckTrack(seconds, seed) {
  const rand = mulberry32(seed * 97 + 5);
  const n = Math.ceil(seconds * 1000) + 2;
  const X = new Float64Array(n), Z = new Float64Array(n), VX = new Float64Array(n), VZ = new Float64Array(n);
  let x = 0, z = 0, vx = 8, vz = 3, nextShot = 500;
  const r = PUCK.radius;
  for (let i = 0; i < n; i++) {
    if (i >= nextShot) {
      const a = rand() * Math.PI * 2, sp = rand() < 0.6 ? 18 + rand() * 16 : 8 + rand() * 6; // shot or pass
      vx = Math.cos(a) * sp; vz = Math.sin(a) * sp;
      nextShot = i + 600 + Math.floor(rand() * 1600);
    }
    const dt = 0.001;
    const fr = Math.exp(-0.35 * dt);
    vx *= fr; vz *= fr;
    x += vx * dt; z += vz * dt;
    const b = boardDistance(x, z);
    if (b.d < r) {
      const vn = vx * b.nx + vz * b.nz;
      if (vn < 0) { vx -= 1.8 * vn * b.nx; vz -= 1.8 * vn * b.nz; } // restitution 0.8
      x += (r - b.d) * b.nx; z += (r - b.d) * b.nz;
    }
    X[i] = x; Z[i] = z; VX[i] = vx; VZ[i] = vz;
  }
  return (tau) => {
    const f = Math.max(0, Math.min(n - 1.000001, tau * 1000));
    const i = Math.floor(f), u = f - i;
    return { x: X[i] + (X[i + 1] - X[i]) * u, z: Z[i] + (Z[i + 1] - Z[i]) * u, vx: VX[i], vz: VZ[i] };
  };
}

// ---------------------------------------------------------------------------------------------
// One simulated session
// ---------------------------------------------------------------------------------------------

function runSession({ prof, fps, seed, seconds, makeClient, serverTimer = 'win', truth }) {
  const sched = new Sched();
  const rUp = mulberry32(seed * 7 + 11), rDown = mulberry32(seed * 13 + 17);
  const rSrv = mulberry32(seed * 19 + 23), rFr = mulberry32(seed * 29 + 31);
  const O = 3_600_000 + 1234.567, drift = 25e-6;
  const S = (t) => O + t * (1 + drift);                // server clock vs true (client) time
  const T0 = 1000;                                      // client performance.now() at session start
  const endT = T0 + seconds * 1000;
  const upLane = makeLane(rUp, prof, endT), downLane = makeLane(rDown, prof, endT);

  // --- fake WebSocket (the client's only socket) ---
  let sock = null, helloed = false, bytesDown = 0, inputs = 0, snapsSent = 0;
  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.bufferedAmount = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      sock = this;
      // TCP handshake + HTTP upgrade: ~2 round trips
      const tOpen = downLane(upLane(downLane(upLane(sched.now))));
      sched.at(tOpen, () => { this.readyState = 1; if (this.onopen) this.onopen({}); });
    }
    send(str) {
      if (this.readyState !== 1) throw new Error('not open');
      const at = upLane(sched.now);
      sched.at(at, () => serverRecv(String(str)));
    }
    close() { this.readyState = 3; }
  }

  function toClient(obj) {
    const str = JSON.stringify(obj, round3);
    bytesDown += str.length;
    const at = downLane(sched.now);
    sched.at(at, () => { if (sock && sock.readyState === 1 && sock.onmessage) sock.onmessage({ data: str }); });
  }
  function serverRecv(str) {
    let m;
    try { m = JSON.parse(str); } catch { return; }
    if (m.t === 'hello') {
      helloed = true;
      toClient({ t: 'welcome', id: 1, room: 'main' });
      toClient({ t: 'lobby', state: 'game', host: 1, clients: [{ id: 1, name: 'lab', team: 0, ping: 0 }], config: { teams: [0, 1], periodLength: 120, periods: 3, difficulty: 1 } });
    } else if (m.t === 'ping') {
      toClient({ t: 'pong', c: m.c, s: Math.round(S(sched.now) * 1000) / 1000 });
    } else if (m.t === 'in') inputs++;
  }

  // --- server game loop (room.js), woken like Node timers on Windows ---
  const startS = S(0);
  let acc = 0, lastWake = startS, ticks = 0;
  const TICK = 15.625;
  function serverLoop() {
    const nowS = S(sched.now);
    acc += nowS - lastWake;
    lastWake = nowS;
    let steps = 0, snapDue = false;
    while (acc >= STEP_MS && steps < 5) { acc -= STEP_MS; steps++; ticks++; if (ticks % TICKS_PER_SNAP === 0) snapDue = true; }
    if (acc >= STEP_MS) acc %= STEP_MS;
    if (snapDue && helloed) sendSnap(nowS - acc);
    // schedule next wake
    const wait = STEP_MS - acc;
    let next;
    if (wait <= 1) next = sched.now + wait + 0.005;                 // setImmediate spin to the step
    else if (serverTimer === 'win') {
      next = (Math.floor((sched.now + 1) / TICK) + 1) * TICK + 0.02 + rSrv() * 0.3;
    } else next = sched.now + wait + rSrv() * 0.1;
    if (rSrv() < 0.002) next += 5 + rSrv() * 35;                      // GC / OS hiccup
    sched.at(next, serverLoop);
  }
  function sendSnap(time) {
    const tau = ticks / TICK_RATE;
    const p = [];
    for (let id = 0; id < 8; id++) {
      const g = id % 4 === 3;
      const q = g ? { x: (id < 4 ? -25.5 : 25.5), z: Math.sin(tau * 1.3 + id) * 0.8, vx: 0, vz: Math.cos(tau * 1.3 + id) * 1.04 } : truth.players[id](tau);
      p.push({ id, tm: id < 4 ? 0 : 1, g: g ? 1 : 0, x: q.x, y: 0, z: q.z, vx: q.vx, vz: q.vz, f: Math.atan2(q.vz, q.vx),
        s: PSTATE.SKATE, sT: tau % 7, tb: 0.5 + 0.5 * Math.sin(tau), fire: 0, ch: 0, c: id === 0 ? 1 : 0, n: 10 + id });
    }
    const k = truth.puck(tau);
    snapsSent++;
    toClient({ t: 'snap', time, tick: ticks, ph: PHASE.PLAY, phT: 0, per: 1, clk: Math.max(0, 120 - tau), sc: [0, 0], teams: [0, 1],
      p, k: { x: k.x, y: 0, z: k.z, vx: k.vx, vy: 0, vz: k.vz, o: -1 }, gl: [], ev: [] });
  }

  const restore = installVirtualGlobals(sched, FakeWS);
  const frames = [];
  try {
    sched.at(0.3, serverLoop);
    sched.runUntil(T0);
    const client = makeClient(() => sched.now);
    client.connect();
    // --- rAF loop ---
    const frameMs = 1000 / fps;
    const tStart = T0 + 20;
    let k = 0, lastSend = -1e9, seq = 0;
    const frame = () => {
      const t = sched.now;
      if (t - lastSend >= 1000 / 60 - 1.5) { lastSend = t; client.sendInput(++seq, 0.5, -0.25, 0); }
      const st = client.getState(t);
      if (client.takeEvents) client.takeEvents();
      const rt = client.serverNow(t) - client.interpDelay;
      if (t >= T0 + WARMUP_MS) {
        frames.push({
          t, rt, trueS: S(t), mode: client.lastMode, delay: client.interpDelay, clockErr: client.serverNow(t) - S(t),
          sx: st ? st.p[0].x : NaN, sz: st ? st.p[0].z : NaN, kx: st ? st.k.x : NaN, kz: st ? st.k.z : NaN,
        });
      }
      k++;
      let next = tStart + k * frameMs + (rFr() - 0.5) * 0.6;
      if (rFr() < 0.004) { k++; next += frameMs; }                    // occasional dropped browser frame
      sched.at(next, frame);
    };
    sched.at(tStart, frame);
    sched.runUntil(endT);
    if (client.close) client.close();
  } finally {
    restore();
  }
  return { frames, startS, snapsSent, bytesDown, inputs, seconds };
}

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

const q = (arr, p) => {
  if (!arr.length) return NaN;
  const a = Float64Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
};
const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN);

function analyze(run, truth) {
  const F = run.frames, n = F.length;
  const tauOf = (serverMs) => (serverMs - run.startS) / 1000;
  const errS = [], errK = [], lat = [], delay = [], clk = [];
  let extrap = 0, hold = 0, empty = 0, stalled = 0;
  for (let i = 0; i < n; i++) {
    const f = F[i];
    lat.push(f.trueS - f.rt);
    delay.push(f.delay);
    clk.push(Math.abs(f.clockErr));
    if (f.mode === 'extrap') extrap++;
    else if (f.mode === 'hold') hold++;
    else if (f.mode === 'empty') empty++;
    if (Number.isNaN(f.sx)) { stalled++; continue; }
    const ts = truth.players[0](tauOf(f.rt)), tk = truth.puck(tauOf(f.rt));
    errS.push(Math.hypot(f.sx - ts.x, f.sz - ts.z));
    errK.push(Math.hypot(f.kx - tk.x, f.kz - tk.z));
    if (i > 0 && f.sx === F[i - 1].sx && f.sz === F[i - 1].sz) stalled++;
  }
  // Visible jerk: 2nd difference of the rendered skater vs an ideal constant-delay playback.
  const D = avg(lat);
  const ideal = F.map((f) => truth.players[0](tauOf(f.trueS - D)));
  const jerk = [];
  let hitch20 = 0, jump100 = 0;
  for (let i = 1; i < n - 1; i++) {
    const a = F[i - 1], b = F[i], c = F[i + 1];
    if (Number.isNaN(a.sx) || Number.isNaN(b.sx) || Number.isNaN(c.sx)) continue;
    const rx = c.sx - 2 * b.sx + a.sx, rz = c.sz - 2 * b.sz + a.sz;
    const ix = ideal[i + 1].x - 2 * ideal[i].x + ideal[i - 1].x, iz = ideal[i + 1].z - 2 * ideal[i].z + ideal[i - 1].z;
    const e = Math.hypot(rx - ix, rz - iz) * 1000; // mm
    jerk.push(e);
    if (e > 20) hitch20++;
    if (e > 100) jump100++;
  }
  const minutes = n > 1 ? (F[n - 1].t - F[0].t) / 60000 : 1;
  // Render-clock warp: d(rt)/dt over ~100 ms windows.
  const warp = [];
  for (let i = 0, j = 0; i < n; i++) {
    while (j < n && F[j].t - F[i].t < 100) j++;
    if (j >= n) break;
    warp.push((F[j].rt - F[i].rt) / (F[j].t - F[i].t));
  }
  const pctOf = (c) => (100 * c) / Math.max(1, n);
  return {
    frames: n,
    latency: { mean: avg(lat), p95: q(lat, 0.95) },
    delay: { mean: avg(delay), min: Math.min(...delay), max: Math.max(...delay) },
    errSkater: { mean: avg(errS) * 100, p95: q(errS, 0.95) * 100, max: Math.max(...errS) * 100 },   // cm
    errPuck: { mean: avg(errK) * 100, p95: q(errK, 0.95) * 100, max: Math.max(...errK) * 100 },     // cm
    extrapPct: pctOf(extrap), holdPct: pctOf(hold + empty), stallPct: pctOf(stalled),
    // p50/p95 = micro-stutter of normal playback; hitches = frames with > 20 mm excess, jumps = > 100 mm
    jerk: { p50: q(jerk, 0.5), p95: q(jerk, 0.95), max: Math.max(...jerk), hitchPerMin: hitch20 / minutes, jumpPerMin: jump100 / minutes },
    warp: { p1: q(warp, 0.01), p99: q(warp, 0.99) },
    clockErr: { mean: avg(clk), p95: q(clk, 0.95) },
    snapsSent: run.snapsSent, kbps: (run.bytesDown * 8) / 1000 / run.seconds,
  };
}

// ---------------------------------------------------------------------------------------------
// Clients: the real createNet, or a parameterised mirror of its getState() logic
// ---------------------------------------------------------------------------------------------

function realNetClient(mod) {
  return (now) => mod.createNet({ name: 'lab', room: 'main', snapRate: SNAP_RATE, url: 'ws://lab.invalid/ws', now });
}

// Mirror of createNet (net.js as of this lab) with tunable constants.
export const NETJS_PARAMS = {
  est: 'ewma', alpha: 0.08, kDev: 2, marginMs: 4, floorMs: 2 * SNAP_MS, capMs: 150,
  riseMs: 250, relaxMs: 4000, maxWarp: Infinity, maxExtrapMs: 100, pingMs: 2000, samples: 10,
  windowN: 90, quant: 0.95, fixedDelay: null, offTauMs: 1000,
  // extras (not in net.js): clipK > 0 clips a lateness sample to mean + clipK*dev (+clipMinMs) before the
  // EWMA update, so one DERP hiccup + its head-of-line burst does not pump the delay;
  // coastMs > 0 replaces the hard 100 ms extrapolation stop by an exponential coast (velocity decays
  // with coastTauMs) for up to coastMs; smoothMs > 0 blends the position jump that happens when fresh
  // data replaces an extrapolation into an offset that decays with time constant smoothMs.
  clipK: 0, clipMinMs: 10, coastMs: 0, coastTauMs: 120, coastLinMs: 0, smoothMs: 0, smoothPuckMs: null, smoothGuard: 6,
  // dropK > 0: a lateness sample above mean + dropK*dev + dropMinMs is treated as a spike / head-of-line
  // follower and skipped, unless dropRun such samples arrive in a row (a real latency level shift).
  dropK: 0, dropMinMs: 15, dropRun: 15,
};

const newestSnap = (buf) => {
  const w = buf.snaps[buf.snaps.length - 1];
  return w ? (w.snap || w) : null;
};

// Coast from snapshot s to render time rt: linear dead reckoning for the first linMs (what net.js does
// now), then the velocity decays exponentially (time constant T) instead of stopping dead; capped at maxMs.
function coastState(s, rt, maxMs, T, linMs = 0) {
  const dt = Math.max(0, Math.min(rt - s.time, maxMs));
  const lin = Math.min(dt, linMs);
  const k = (lin + T * (1 - Math.exp(-(dt - lin) / T))) / 1000;
  const out = { ...s, time: rt };
  out.p = s.p.map((p) => ({ ...p, x: p.x + (p.vx || 0) * k, z: p.z + (p.vz || 0) * k }));
  if (s.k) {
    let x = s.k.x + (s.k.vx || 0) * k, z = s.k.z + (s.k.vz || 0) * k;
    const b = boardDistance(x, z);
    if (b.d < PUCK.radius) { x += (PUCK.radius - b.d) * b.nx; z += (PUCK.radius - b.d) * b.nz; } // don't coast through the boards
    out.k = { ...s.k, x, z };
  }
  return out;
}

function mirrorClient(core, P0) {
  const P = { ...NETJS_PARAMS, ...P0 };
  return (now) => {
    const net = { interpDelay: P.fixedDelay ?? 2 * SNAP_MS, lastMode: 'empty', lobby: null };
    let ws = null, samples = [], offset = 0, haveOffset = false, haveSeed = false, smoothOff = 0, smoothInit = false;
    let lateMean = 0, lateDev = 0, lateInit = false, lastFrame = 0, outRun = 0;
    const ring = [], buf = core.createInterpBuffer({ maxExtrapMs: P.maxExtrapMs });
    let cachedTarget = null;
    const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
    const ping = () => send({ t: 'ping', c: now() });
    net.connect = () => {
      ws = new WebSocket('ws://lab.invalid/ws');
      ws.onopen = () => {
        send({ t: 'hello', name: 'lab', room: 'main' });
        ping();
        for (const ms of [150, 400, 800]) setTimeout(ping, ms);
        setInterval(ping, P.pingMs);
      };
      ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    };
    function onMessage(m) {
      if (m.t === 'lobby') net.lobby = m;
      else if (m.t === 'pong') {
        const smp = core.clockSample(m.c, m.s, now());
        samples.push(smp);
        if (samples.length > P.samples) samples.shift();
        offset = core.estimateClock(samples).offset;
        haveOffset = true;
      } else if (m.t === 'snap') {
        const t = now();
        if (!haveOffset && !haveSeed) { offset = m.time - t; haveSeed = true; }
        if (!core.pushSnap(buf, m)) return;
        let late = t + offset - m.time;
        let skip = false;
        if (lateInit && P.dropK > 0) {
          if (late > lateMean + P.dropK * lateDev + P.dropMinMs) skip = ++outRun < P.dropRun;
          else outRun = 0;
        }
        if (!lateInit) { lateMean = late; lateDev = 0; lateInit = true; } else if (!skip) {
          if (P.clipK > 0) late = Math.min(late, lateMean + P.clipK * lateDev + P.clipMinMs);
          lateMean += (late - lateMean) * P.alpha;
          lateDev += (Math.abs(late - lateMean) - lateDev) * P.alpha;
        }
        ring.push(late);
        if (ring.length > P.windowN) ring.shift();
        cachedTarget = null;
      }
    }
    function target() {
      if (cachedTarget !== null) return cachedTarget;
      let need;
      if (!lateInit) need = 0;
      else if (P.est === 'window') need = SNAP_MS + q(ring, P.quant) + P.marginMs;
      else need = SNAP_MS + Math.max(0, lateMean) + P.kDev * Math.max(0, lateDev) + P.marginMs;
      cachedTarget = Math.min(P.capMs, Math.max(P.floorMs, need));
      return cachedTarget;
    }
    net.getState = (t) => {
      const dtMs = lastFrame ? Math.min(250, Math.max(0, t - lastFrame)) : 16;
      lastFrame = t;
      if (!net.lobby || net.lobby.state !== 'game') { net.lastMode = 'empty'; return null; }
      if (!smoothInit || Math.abs(offset - smoothOff) > 300) { smoothOff = offset; smoothInit = true; }
      else smoothOff += (offset - smoothOff) * Math.min(1, dtMs / P.offTauMs);
      if (P.fixedDelay == null) {
        const tg = target();
        const k = tg > net.interpDelay ? Math.min(1, dtMs / P.riseMs) : Math.min(1, dtMs / P.relaxMs);
        let d = (tg - net.interpDelay) * k;
        const lim = P.maxWarp * dtMs;
        if (d > lim) d = lim; else if (d < -lim) d = -lim;
        net.interpDelay += d;
      }
      const rt = t + smoothOff - net.interpDelay;
      let { state, mode } = core.sampleAt(buf, rt);
      net.lastMode = mode;
      if (state && mode === 'extrap' && P.coastMs > 0) state = coastState(newestSnap(buf), rt, P.coastMs, P.coastTauMs, P.coastLinMs);
      if (state && P.smoothMs > 0) state = smooth(state, mode, dtMs);
      return state;
    };

    // Correction smoothing: when the previous frame was extrapolating and the source changed (new data
    // arrived), keep the rendered position continuous and decay the difference.
    const corr = new Map(), prevOut = new Map();
    let prevMode = 'empty', prevBase = -1;
    function smooth(state, mode, dtMs) {
      const base = mode === 'extrap' ? newestSnap(buf).time : -1;
      const transition = prevMode === 'extrap' && (mode !== 'extrap' || base !== prevBase);
      const puckMs = P.smoothPuckMs ?? P.smoothMs;
      const decayP = Math.exp(-dtMs / P.smoothMs), decayK = puckMs > 0 ? Math.exp(-dtMs / puckMs) : 0;
      const ents = state.p.map((p, i) => [i, p]);
      if (state.k) ents.push(['k', state.k]);
      const out = { ...state, p: state.p.slice() };
      for (const [key, e] of ents) {
        let c = corr.get(key) || { x: 0, z: 0 };
        const pv = prevOut.get(key);
        const decay = key === 'k' ? decayK : decayP;
        if (transition && pv && decay > 0) {
          const jx = e.x - (pv.x + (e.vx || 0) * dtMs / 1000), jz = e.z - (pv.z + (e.vz || 0) * dtMs / 1000);
          c = Math.hypot(jx, jz) > P.smoothGuard ? { x: 0, z: 0 } : { x: -jx, z: -jz };
        } else c = { x: c.x * decay, z: c.z * decay };
        corr.set(key, c);
        const o = { ...e, x: e.x + c.x, z: e.z + c.z };
        prevOut.set(key, o);
        if (key === 'k') out.k = o; else out.p[key] = o;
      }
      prevMode = mode; prevBase = base;
      return out;
    }
    net.serverNow = (t) => t + (smoothInit ? smoothOff : offset);
    net.sendInput = (seq, mx, mz, b) => send({ t: 'in', seq, mx, mz, b });
    net.takeEvents = () => [];
    return net;
  };
}

// ---------------------------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------------------------

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');

function table(rows, cols) {
  const head = cols.map((c) => c[0]);
  const body = rows.map((r) => cols.map((c) => String(c[1](r))));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => '| ' + cells.map((c, i) => c.padEnd(w[i])).join(' | ') + ' |';
  return [line(head), '|' + w.map((x) => '-'.repeat(x + 2)).join('|') + '|', ...body.map(line)].join('\n');
}

const MAIN_COLS = [
  ['profile', (r) => r.profile],
  ['fps', (r) => r.fps],
  ['client', (r) => r.client],
  ['delay ms (min-max)', (r) => `${f1(r.m.delay.mean)} (${f1(r.m.delay.min)}-${f1(r.m.delay.max)})`],
  ['vis.lat ms', (r) => f1(r.m.latency.mean)],
  ['skater err cm mean/p95', (r) => `${f2(r.m.errSkater.mean)} / ${f2(r.m.errSkater.p95)}`],
  ['puck err cm mean/p95', (r) => `${f1(r.m.errPuck.mean)} / ${f1(r.m.errPuck.p95)}`],
  ['extrap %', (r) => f2(r.m.extrapPct)],
  ['stall %', (r) => f2(r.m.stallPct)],
  ['jerk mm p50/p95', (r) => `${f2(r.m.jerk.p50)} / ${f2(r.m.jerk.p95)}`],
  ['hitch/min >2cm', (r) => f1(r.m.jerk.hitchPerMin)],
  ['jump/min >10cm', (r) => f1(r.m.jerk.jumpPerMin)],
  ['max jump cm', (r) => f1(r.m.jerk.max / 10)],
  ['warp p1-p99', (r) => `${f2(r.m.warp.p1)}-${f2(r.m.warp.p99)}`],
  ['clock err ms', (r) => f1(r.m.clockErr.mean)],
];

// ---------------------------------------------------------------------------------------------
// Offline lab
// ---------------------------------------------------------------------------------------------

async function offline(args) {
  const seconds = Number(args.seconds ?? (args.quick ? 60 : 180));
  const seed = Number(args.seed ?? 1);
  const profiles = String(args.profiles ?? 'lan,tailnet,derp,wifi').split(',');
  const fpsList = String(args.fps ?? '60,144').split(',').map(Number);
  const serverTimer = args['server-timer'] || 'win';

  const { mod, why } = await loadNet();
  const hasCreate = mod && typeof mod.createNet === 'function';
  const hasCore = mod && CORE_FNS.every((k) => typeof mod[k] === 'function');
  const core = hasCore ? mod : REF;
  console.log(`interp-quality: net.js ${mod ? `loaded (exports: ${Object.keys(mod).join(', ')})` : `NOT used (${why})`}`);
  console.log(`  ${seconds} s virtual per run, seed ${seed}, server timer model '${serverTimer}', warmup ${WARMUP_MS / 1000} s excluded`);
  if (mod && hasCore) {
    console.log(`  net.js constants: MAX_EXTRAP_MS=${mod.MAX_EXTRAP_MS} MAX_INTERP_DELAY_MS=${mod.MAX_INTERP_DELAY_MS} TELEPORT_DIST=${mod.TELEPORT_DIST}` +
      (typeof mod.targetInterpDelay === 'function' ? `, targetInterpDelay(30,0,0)=${f1(mod.targetInterpDelay(30, 0, 0))} (45,9)=>${f1(mod.targetInterpDelay(30, 45, 9))}` : ''));
  }

  const truth = { players: Array.from({ length: 8 }, (_, i) => skaterPath(i)), puck: puckTrack(seconds + 5, seed) };
  const clients = [];
  if (hasCreate) clients.push(['net.js', realNetClient(mod)]);
  else clients.push(['reference', mirrorClient(core, {})]);
  if (args.sweep) clients.push(['mirror(net.js)', mirrorClient(core, {})]);

  const rows = [];
  for (const pk of profiles) {
    const prof = LAB_PROFILES[pk];
    if (!prof) throw new Error(`unknown profile ${pk}`);
    for (const fps of fpsList) {
      for (const [name, make] of clients) {
        const run = runSession({ prof, fps, seed, seconds, makeClient: make, serverTimer, truth });
        rows.push({ profile: prof.label, pk, fps, client: name, m: analyze(run, truth) });
      }
    }
  }
  console.log('\nMain results (errors vs ground truth at the render time; jerk = rendered skater 2nd difference minus ideal):\n');
  console.log(table(rows, MAIN_COLS));

  const out = { seconds, seed, serverTimer, rows };
  if (args.sweep) out.sweep = await sweep({ args, seconds, seed, profiles, fpsList, serverTimer, truth, core });
  if (args.json) { writeFileSync(args.json, JSON.stringify(out, null, 1)); console.log(`\nwrote ${args.json}`); }
  return out;
}

async function sweep({ args, seconds, seed, profiles, fpsList, serverTimer, truth, core }) {
  const res = {};
  // 1) Oracle: fixed interpolation delay (no adaptation) - minimum delay for a given extrapolation rate.
  console.log('\nFixed-delay sweep (60 fps): % frames extrapolating / stalled at a constant interpDelay\n');
  const delays = [45, 55, 67, 80, 90, 100, 110, 120, 135, 150, 175, 200];
  const fixedRows = [];
  for (const pk of profiles) {
    const prof = LAB_PROFILES[pk];
    const row = { profile: prof.label };
    for (const d of delays) {
      const m = analyze(runSession({ prof, fps: 60, seed, seconds: Math.min(seconds, 120), makeClient: mirrorClient(core, { fixedDelay: d }), serverTimer, truth }), truth);
      row[d] = m;
    }
    fixedRows.push(row);
  }
  console.log(table(fixedRows, [['profile', (r) => r.profile], ...delays.map((d) => [`${d}ms`, (r) => `${f1(r[d].extrapPct)}/${f1(r[d].stallPct)}`])]));
  for (const r of fixedRows) {
    const ok = (lim) => delays.find((d) => r[d].extrapPct <= lim);
    console.log(`  ${r.profile.padEnd(22)} smallest fixed delay with <=1% extrapolation: ${ok(1) ?? '>200'} ms, <=0.25%: ${ok(0.25) ?? '>200'} ms`);
  }
  res.fixed = fixedRows.map((r) => ({ profile: r.profile, ...Object.fromEntries(delays.map((d) => [d, { extrap: r[d].extrapPct, stall: r[d].stallPct, jerk99: r[d].jerk.p99 }])) }));

  // 2) Constant variants of the adaptive logic.
  const variants = [
    ['mirror(net.js)', {}],
    ...(args.variants ? JSON.parse(args.variants) : DEFAULT_VARIANTS),
  ];
  console.log('\nAdaptive variants (mirror of createNet().getState with different constants):\n');
  const vrows = [];
  for (const pk of profiles) {
    for (const fps of fpsList) {
      for (const [name, P] of variants) {
        const m = analyze(runSession({ prof: LAB_PROFILES[pk], fps, seed, seconds, makeClient: mirrorClient(core, P), serverTimer, truth }), truth);
        vrows.push({ profile: LAB_PROFILES[pk].label, pk, fps, client: name, m });
      }
    }
  }
  console.log(table(vrows, MAIN_COLS));
  console.log('\nnet.js today vs recommended (REC = ' + JSON.stringify(REC_PARAMS) + '):\n');
  console.log(table(vrows.filter((r) => r.client === 'mirror(net.js)' || r.client === 'REC'), [
    ['profile', (r) => r.profile], ['fps', (r) => r.fps], ['client', (r) => (r.client === 'REC' ? 'REC' : 'net.js')],
    ['vis.lat ms', (r) => f1(r.m.latency.mean)], ['extrap %', (r) => f2(r.m.extrapPct)], ['stall %', (r) => f2(r.m.stallPct)],
    ['skater err cm mean/p95', (r) => `${f2(r.m.errSkater.mean)} / ${f2(r.m.errSkater.p95)}`],
    ['puck err cm mean/p95', (r) => `${f1(r.m.errPuck.mean)} / ${f1(r.m.errPuck.p95)}`],
    ['jump/min >10cm', (r) => f1(r.m.jerk.jumpPerMin)], ['max jump cm', (r) => f1(r.m.jerk.max / 10)],
  ]));
  res.variants = vrows;
  return res;
}

// Recommended for net.js (see the report printed by --sweep): spike-robust lateness, coast instead of
// a hard extrapolation stop, short correction blend (players 100 ms, puck 50 ms), floor 55 ms.
export const REC_PARAMS = { dropK: 3, dropMinMs: 15, dropRun: 15, coastMs: 300, coastLinMs: 100, coastTauMs: 120, smoothMs: 100, smoothPuckMs: 50, floorMs: 55 };

const DEFAULT_VARIANTS = [
  ['cap250', { capMs: 250 }],
  ['window p90', { est: 'window', quant: 0.9, windowN: 90 }],
  ['clip3', { clipK: 3 }],
  ['drop3', { dropK: 3 }],
  ['drop3+coast', { dropK: 3, coastMs: 300, coastLinMs: 100 }],
  ['drop3+smooth', { dropK: 3, smoothMs: 100, smoothPuckMs: 50 }],
  ['REC', REC_PARAMS],
  ['REC floor67', { ...REC_PARAMS, floorMs: 2 * SNAP_MS }],
];

// ---------------------------------------------------------------------------------------------
// Live run: real server -> netem proxy (DERP) -> bots.js + a net.js probe client
// ---------------------------------------------------------------------------------------------

const SCRATCH = path.join(os.tmpdir(), 'claude', 'ice-riot-netem');

// Child mode: the real game server (server/app.js + shared/sim.js) WITHOUT the stats store, so a lab
// run never writes data/stats.json.
async function liveServer(args) {
  const { createGameServer } = await import('../server/app.js');
  const sim = await import('../shared/sim.js');
  const srv = await createGameServer({ sim, port: Number(args.port), host: '127.0.0.1', log: (s) => console.log(`[server] ${s}`) });
  console.log(`LISTENING ${srv.port}`);
  const stop = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function waitPort(port, ms = 15000) {
  const t0 = performance.now();
  for (;;) {
    const ok = await new Promise((r) => {
      const c = net.connect({ port, host: '127.0.0.1' }, () => { c.destroy(); r(true); });
      c.once('error', () => r(false));
    });
    if (ok) return;
    if (performance.now() - t0 > ms) throw new Error(`port ${port} did not open`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function spawnLogged(name, argv, logDir) {
  const out = createWriteStream(path.join(logDir, `${name}.log`));
  const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.exited = new Promise((r) => child.once('exit', (code) => r(code)));
  return child;
}

// A net.js client probe: real createNet() over a real WebSocket, sampled by a 60 fps spin loop.
// [x0, z0, ..., x7, z7, puckX, puckZ]
function entityPos(s) {
  const a = new Float64Array(18);
  for (let i = 0; i < 8; i++) { a[2 * i] = s.p[i].x; a[2 * i + 1] = s.p[i].z; }
  a[16] = s.k.x; a[17] = s.k.z;
  return a;
}

// Rendered positions vs the complete snapshot stream lerped at the same render time (PLAY phase only).
// Normal interpolation gives ~0 error; what remains is extrapolation / freeze / recovery from the network.
function compareToTruth(rec, truth) {
  const T = truth.slice().sort((a, b) => a.time - b.time);
  const errs = [];
  let prevE = null, jumps = 0, maxJump = 0, valid = 0, j = 0;
  for (const r of rec) {
    while (j < T.length - 2 && T[j + 1].time <= r.rt) j++;
    const a = T[j], b = T[j + 1];
    if (!b || r.rt < a.time || r.rt > b.time || a.ph !== PHASE.PLAY || b.ph !== PHASE.PLAY) { prevE = null; continue; }
    const u = (r.rt - a.time) / (b.time - a.time);
    const e = new Float64Array(18);
    let worst = 0;
    for (let i = 0; i < 18; i += 2) {
      const tele = Math.hypot(b.pos[i] - a.pos[i], b.pos[i + 1] - a.pos[i + 1]) > 4;
      const tx = tele ? b.pos[i] : a.pos[i] + (b.pos[i] - a.pos[i]) * u, tz = tele ? b.pos[i + 1] : a.pos[i + 1] + (b.pos[i + 1] - a.pos[i + 1]) * u;
      e[i] = r.pos[i] - tx; e[i + 1] = r.pos[i + 1] - tz;
      worst = Math.max(worst, Math.hypot(e[i], e[i + 1]));
    }
    errs.push(worst);
    valid++;
    if (prevE) {
      let dj = 0;
      for (let i = 0; i < 18; i += 2) dj = Math.max(dj, Math.hypot(e[i] - prevE[i], e[i + 1] - prevE[i + 1]));
      if (dj > 0.1) jumps++;
      if (dj > maxJump) maxJump = dj;
    }
    prevE = e;
  }
  return { truthErrCm: { mean: avg(errs) * 100, p95: q(errs, 0.95) * 100 }, jumpsPerMin: valid ? jumps / (valid / 3600) : NaN, maxJumpCm: maxJump * 100, truthFrames: valid };
}

// The direct probe (no proxy) records every snapshot it receives: that stream, lerped at any render
// time, is the ground truth the proxied probe's rendered positions are compared against.
function startProbe(mod, label, url, room, { recordTruth = false } = {}) {
  const P = { label, late: [], frames: 0, modes: {}, frozen: 0, delays: [], lastArr: 0, gaps: [], rtts: [], truth: [], rec: [] };
  const NativeWS = globalThis.WebSocket;
  class ProbeWS extends NativeWS {
    constructor(u) {
      super(u);
      this.addEventListener('message', (e) => {
        const d = typeof e.data === 'string' ? e.data : '';
        if (!d.startsWith('{"t":"snap"')) return;
        const t = performance.now();
        const m = /"time":([0-9.]+)/.exec(d);
        if (P.lastArr) P.gaps.push(t - P.lastArr);
        P.lastArr = t;
        if (m && P.net && P.net.everConnected) P.late.push(P.net.serverNow(t) - Number(m[1]));
        if (recordTruth) {
          try {
            const s = JSON.parse(d);
            P.truth.push({ time: s.time, ph: s.ph, pos: entityPos(s) });
          } catch { /* ignore */ }
        }
      });
    }
  }
  globalThis.WebSocket = ProbeWS;
  const n = mod.createNet({ name: label.slice(0, 16), room, snapRate: SNAP_RATE, url });
  P.net = n;
  n.on('welcome', () => n.pick(-1));
  n.connect();
  globalThis.WebSocket = NativeWS;
  P.frame = (t) => {
    const st = n.getState(t);
    n.takeEvents();
    if (!st) { P.lastArr = 0; return; }
    P.frames++;
    P.modes[n.lastMode] = (P.modes[n.lastMode] || 0) + 1;
    P.delays.push(n.interpDelay);
    const rt = n.serverNow(t) - n.interpDelay;
    if (n.lastMode === 'extrap' && rt - st.time > 1) P.frozen++;
    if (n.rtt) P.rtts.push(n.rtt);
    P.rec.push({ t, rt, pos: entityPos(st) });
  };
  P.summary = (secs, truth) => {
    const g = P.gaps;
    const out = {
      probe: label, snaps: g.length + 1,
      gapMs: { mean: avg(g), p95: q(g, 0.95), p99: q(g, 0.99), max: g.length ? Math.max(...g) : NaN, over100: g.filter((v) => v > 100).length, over250: g.filter((v) => v > 250).length },
      latenessMs: { p50: q(P.late, 0.5), p95: q(P.late, 0.95), max: P.late.length ? Math.max(...P.late) : NaN },
      rttMs: avg(P.rtts),
      interpDelayMs: { mean: avg(P.delays), min: Math.min(...P.delays), max: Math.max(...P.delays) },
      framePct: Object.fromEntries(Object.entries(P.modes).map(([k, v]) => [k, (100 * v) / Math.max(1, P.frames)])),
      frozenPct: (100 * P.frozen) / Math.max(1, P.frames),
      frames: P.frames, seconds: secs,
    };
    if (truth && truth.length > 10) Object.assign(out, compareToTruth(P.rec, truth));
    return out;
  };
  P.close = () => { try { n.reconnectNow = () => {}; } catch {} };
  return P;
}

async function live(args) {
  const seconds = Number(args.seconds ?? 60);
  const pk = args.profile || 'derp';
  const prof = LAB_PROFILES[pk];
  if (!prof) throw new Error(`unknown profile ${pk}`);
  mkdirSync(SCRATCH, { recursive: true });
  const { mod, why } = await loadNet();
  if (!mod || typeof mod.createNet !== 'function') throw new Error(`live mode needs public/net.js createNet (${why || 'missing export'})`);
  if (!existsSync(path.join(ROOT, 'server', 'app.js')) || !existsSync(path.join(ROOT, 'shared', 'sim.js'))) throw new Error('live mode needs server/app.js and shared/sim.js');
  const portSrv = await freePort(), portProxy = await freePort();
  const room = `netem${process.pid}`;
  console.log(`live run: server :${portSrv} <- proxy :${portProxy} (${prof.label}) <- bots + net.js probe, room ${room}, ${seconds} s; logs in ${SCRATCH}`);
  const kids = [];
  const killAll = () => { for (const k of kids) { try { k.kill(); } catch {} } };
  process.on('exit', killAll);
  try {
    kids.push(spawnLogged('server', [fileURLToPath(import.meta.url), '--live-server', '--port', String(portSrv)], SCRATCH));
    await waitPort(portSrv);
    const spike = prof.spike ? `${prof.spike.prob}:${prof.spike.ms}` : '0';
    kids.push(spawnLogged('proxy', [path.join(HERE, 'netem-proxy.js'), '--listen', String(portProxy), '--target', `127.0.0.1:${portSrv}`,
      '--latency', String(prof.latencyMs), '--jitter', String(prof.jitterMs), '--spikes', spike, '--seed', '1', '--stats', '5'], SCRATCH));
    await waitPort(portProxy);

    const botsJson = path.join(SCRATCH, 'bots.json');
    const haveBots = existsSync(path.join(HERE, 'bots.js'));
    let bots = null;
    if (haveBots) {
      bots = spawnLogged('bots', [path.join(HERE, 'bots.js'), '--url', `ws://127.0.0.1:${portProxy}/ws`, '--bots', '4', '--room', room,
        '--seconds', String(seconds), '--start', '--period', '60', '--min-rate', '20', '--json', botsJson, '--quiet'], SCRATCH);
      kids.push(bots);
    } else console.log('  test/bots.js not found: the probes will host and start the game themselves');
    await new Promise((r) => setTimeout(r, 2500)); // let a bot become host

    const probes = [startProbe(mod, `probe-${pk}`, `ws://127.0.0.1:${portProxy}/ws`, room), startProbe(mod, 'probe-direct', `ws://127.0.0.1:${portSrv}/ws`, room, { recordTruth: true })];
    if (!haveBots) setTimeout(() => { probes[1].net.start(); }, 1500);
    const t0 = performance.now(), tEnd = t0 + (seconds - 4) * 1000;
    let next = t0;
    await new Promise((resolve) => {
      const spin = () => {
        const t = performance.now();
        if (t >= next) {
          for (const p of probes) p.frame(t);
          next += 1000 / 60;
          if (t - next > 100) next = t + 1000 / 60;
        }
        if (t < tEnd) setImmediate(spin); else resolve();
      };
      setImmediate(spin);
    });
    const secs = (performance.now() - t0) / 1000;
    const res = { profile: prof.label, seconds, probes: probes.map((p) => p.summary(secs, probes[1].truth)) };
    for (const p of probes) p.close();
    if (bots) {
      const code = await Promise.race([bots.exited, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
      res.botsExit = code;
      if (existsSync(botsJson)) {
        const b = JSON.parse(readFileSync(botsJson, 'utf8'));
        res.bots = b.bots.map((s) => ({ name: s.name, snapsPerSec: s.snapsPerSec, gapMeanMs: s.gapMeanMs, gapP95Ms: s.gapP95Ms, gapMaxMs: s.gapMaxMs,
          serverGapP95Ms: s.serverGapP95Ms, serverGapMaxMs: s.serverGapMaxMs, rttMeanMs: s.rttMeanMs, rttP95Ms: s.rttP95Ms, stalls: s.stalls.length, snapBytesMean: s.snapBytesMean, kBps: Math.round(s.rxBytesPerSecInGame / 102.4) / 10 }));
        res.botsOk = b.ok; res.botsProblems = b.problems;
      }
    }
    printLive(res);
    if (args.json) writeFileSync(args.json, JSON.stringify(res, null, 1));
    return res;
  } finally {
    killAll();
    await Promise.all(kids.map((k) => Promise.race([k.exited, new Promise((r) => setTimeout(r, 3000))])));
  }
}

function printLive(res) {
  console.log(`\nLive run (${res.profile}, ${res.seconds} s): net.js probes (60 fps spin loop, spectating)\n`);
  console.log(table(res.probes, [
    ['probe', (r) => r.probe], ['snaps', (r) => r.snaps],
    ['gap ms mean/p95/p99/max', (r) => `${f1(r.gapMs.mean)}/${f1(r.gapMs.p95)}/${f1(r.gapMs.p99)}/${f1(r.gapMs.max)}`],
    ['gaps>100/>250', (r) => `${r.gapMs.over100}/${r.gapMs.over250}`],
    ['lateness p50/p95/max', (r) => `${f1(r.latenessMs.p50)}/${f1(r.latenessMs.p95)}/${f1(r.latenessMs.max)}`],
    ['RTT ms', (r) => f1(r.rttMs)],
    ['interpDelay mean (min-max)', (r) => `${f1(r.interpDelayMs.mean)} (${f1(r.interpDelayMs.min)}-${f1(r.interpDelayMs.max)})`],
    ['interp/extrap %', (r) => `${f1(r.framePct.interp || 0)}/${f2(r.framePct.extrap || 0)}`],
    ['frozen %', (r) => f2(r.frozenPct)],
    ['err vs truth cm mean/p95', (r) => (r.truthErrCm ? `${f1(r.truthErrCm.mean)}/${f1(r.truthErrCm.p95)}` : '-')],
    ['jumps/min >10cm', (r) => f1(r.jumpsPerMin)],
    ['max jump cm', (r) => f1(r.maxJumpCm)],
  ]));
  console.log('  (err / jumps: worst of the 8 players + puck vs the full snapshot stream lerped at the same render time, PLAY phase only)');
  if (res.bots) {
    console.log(`\nbots.js through the proxy (exit ${res.botsExit}, ok=${res.botsOk}${res.botsProblems && res.botsProblems.length ? `, ${res.botsProblems.join('; ')}` : ''}):\n`);
    console.log(table(res.bots, [
      ['bot', (r) => r.name], ['snaps/s', (r) => r.snapsPerSec], ['gap ms mean/p95/max', (r) => `${r.gapMeanMs}/${r.gapP95Ms}/${r.gapMaxMs}`],
      ['srv gap p95/max', (r) => `${r.serverGapP95Ms}/${r.serverGapMaxMs}`], ['RTT mean/p95', (r) => `${r.rttMeanMs}/${r.rttP95Ms}`],
      ['stalls>250', (r) => r.stalls], ['snap B', (r) => r.snapBytesMean], ['KB/s', (r) => r.kBps],
    ]));
  }
}

// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) a[k] = true; else { a[k] = v; i++; }
  }
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const job = args['live-server'] ? liveServer(args) : args.live ? live(args) : offline(args);
  job.then(() => process.exit(0), (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}
