// ICE RIOT - client networking.
//
// Two layers:
//   1. A pure interpolation / clock-sync core (exported functions, no DOM, no timers) that is
//      unit-tested in Node by test/interp.test.js.
//   2. createNet(): the browser WebSocket client (hello, auto-reconnect with backoff, ping/pong
//      clock sync, snapshot buffering) built on top of the core.
//
// This file deliberately imports nothing so it loads identically in Node and the browser.
// The few game constants it needs are passed in by main.js (snapRate) or mirrored below.

export const TELEPORT_DIST = 4;        // meters between snapshots => snap, don't lerp (faceoff resets)
export const MAX_EXTRAP_MS = 300;      // never extrapolate further than this past the newest snapshot
export const EXTRAP_LINEAR_MS = 100;   // linear dead reckoning for this long, then velocity decays (coast)
export const EXTRAP_COAST_TAU_MS = 120;
export const MIN_INTERP_DELAY_MS = 55;
export const MAX_INTERP_DELAY_MS = 150;
const PUCK_LIMIT_X = 29.88, PUCK_LIMIT_Z = 12.88; // keep a coasting puck inside the boards
const PH_PLAY = 2;                     // mirrors PHASE.PLAY in shared/constants.js (clock only runs in PLAY)
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// Pure math helpers
// ---------------------------------------------------------------------------------------------

export const lerp = (a, b, t) => a + (b - a) * t;

// Shortest-path angle lerp (radians). Same formula as shared/constants.js lerpAngle.
export function lerpAngle(a, b, t) {
  const d = ((b - a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  return a + d * t;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Event type key. Events are expected as {type: EVENT.*, ...}; tolerate alternative spellings.
export const evType = (e) => (e && (e.type ?? e.t ?? e.e ?? e.ev)) || '';

// ---------------------------------------------------------------------------------------------
// Snapshot interpolation / extrapolation (pure)
// ---------------------------------------------------------------------------------------------

// Copy the top-level snapshot fields, dropping transport-only keys.
function baseCopy(s, time) {
  const out = {};
  for (const key in s) {
    if (key === 't' || key === 'ev' || key === 'p' || key === 'k') continue;
    out[key] = s[key];
  }
  out.time = time;
  return out;
}

function lerpPlayer(pa, pb, t, secsBeforeB) {
  const o = { ...pb };
  if (!pa) return o;
  const dx = num(pb.x) - num(pa.x), dz = num(pb.z) - num(pa.z);
  const sameState = pa.s === pb.s;
  if (dx * dx + dz * dz > TELEPORT_DIST * TELEPORT_DIST) {
    // Teleport (faceoff reset): show the new position right away.
    if (!sameState) o.sT = Math.max(0, num(pb.sT) - secsBeforeB);
    return o;
  }
  o.x = lerp(num(pa.x), num(pb.x), t);
  o.y = lerp(num(pa.y), num(pb.y), t);
  o.z = lerp(num(pa.z), num(pb.z), t);
  o.vx = lerp(num(pa.vx), num(pb.vx), t);
  o.vz = lerp(num(pa.vz), num(pb.vz), t);
  o.f = lerpAngle(num(pa.f), num(pb.f), t);
  o.tb = lerp(num(pa.tb), num(pb.tb), t);
  if (sameState) {
    o.ch = lerp(num(pa.ch), num(pb.ch), t);
    o.sT = lerp(num(pa.sT), num(pb.sT), t);
  } else {
    // Discrete state switches at the newer snapshot; its timer is wound back to render time.
    o.sT = Math.max(0, num(pb.sT) - secsBeforeB);
  }
  return o;
}

function lerpPuck(ka, kb, t, pa, pb, P) {
  const o = { ...kb };
  if (!ka) return o;
  const dx = num(kb.x) - num(ka.x), dz = num(kb.z) - num(ka.z);
  if (dx * dx + dz * dz > TELEPORT_DIST * TELEPORT_DIST) return o;
  o.x = lerp(num(ka.x), num(kb.x), t);
  o.y = lerp(num(ka.y), num(kb.y), t);
  o.z = lerp(num(ka.z), num(kb.z), t);
  o.vx = lerp(num(ka.vx), num(kb.vx), t);
  o.vy = lerp(num(ka.vy), num(kb.vy), t);
  o.vz = lerp(num(ka.vz), num(kb.vz), t);
  // A carried puck: interpolate it in polar coordinates around its (interpolated) owner so it
  // stays on the stick arc while the carrier turns instead of cutting the chord.
  if (ka.o >= 0 && ka.o === kb.o && pa && pb && P) {
    const ax = num(ka.x) - num(pa.x), az = num(ka.z) - num(pa.z);
    const bx = num(kb.x) - num(pb.x), bz = num(kb.z) - num(pb.z);
    const r = lerp(Math.hypot(ax, az), Math.hypot(bx, bz), t);
    const ang = lerpAngle(Math.atan2(az, ax), Math.atan2(bz, bx), t);
    o.x = P.x + Math.cos(ang) * r;
    o.z = P.z + Math.sin(ang) * r;
  }
  return o;
}

// Interpolate between snapshots a (older) and b (newer) at render time rt (ms, server clock).
// Continuous fields are lerped; discrete fields come from b.
export function lerpSnapshots(a, b, rt) {
  const span = b.time - a.time;
  const t = span > 0 ? Math.min(1, Math.max(0, (rt - a.time) / span)) : 1;
  const secsBeforeB = Math.max(0, (b.time - rt) / 1000);
  const out = baseCopy(b, rt);
  if (a.ph === b.ph && a.per === b.per) {
    out.clk = lerp(num(a.clk), num(b.clk), t);
    out.phT = lerp(num(a.phT), num(b.phT), t);
  }
  const pa = a.p || [], pb = b.p || [];
  out.p = pb.map((p, i) => lerpPlayer(pa[i], p, t, secsBeforeB));
  const owner = b.k ? b.k.o : -1;
  out.k = b.k ? lerpPuck(a.k, b.k, t, pa[owner], pb[owner], out.p[owner]) : b.k;
  return out;
}

// Effective "seconds of velocity" after dtMs of extrapolation: linear for EXTRAP_LINEAR_MS, then the
// velocity decays with EXTRAP_COAST_TAU_MS so a stalled stream glides to a stop instead of freezing
// (and the later correction is small enough to blend in rather than teleport).
export function coastSeconds(dtMs) {
  const lin = Math.min(dtMs, EXTRAP_LINEAR_MS);
  const rest = Math.max(0, dtMs - lin);
  return (lin + EXTRAP_COAST_TAU_MS * (1 - Math.exp(-rest / EXTRAP_COAST_TAU_MS))) / 1000;
}

// Dead-reckon a snapshot forward by `ms` (bounded by maxMs) using its velocities.
export function extrapolateSnapshot(s, ms, maxMs = MAX_EXTRAP_MS) {
  const dtMs = Math.max(0, Math.min(ms, maxMs));
  const dt = dtMs / 1000;          // clocks/timers advance in real time
  const k = coastSeconds(dtMs);    // positions coast
  const out = baseCopy(s, s.time + dtMs);
  if (dt > 0) {
    if (out.ph === PH_PLAY) out.clk = Math.max(0, num(s.clk) - dt);
    if (num(s.phT) > 0) out.phT = Math.max(0, num(s.phT) - dt);
  }
  out.p = (s.p || []).map((p) => ({
    ...p,
    x: num(p.x) + num(p.vx) * k,
    z: num(p.z) + num(p.vz) * k,
    sT: num(p.sT) + dt,
  }));
  if (s.k) {
    const kx = num(s.k.x) + num(s.k.vx) * k, kz = num(s.k.z) + num(s.k.vz) * k;
    out.k = {
      ...s.k,
      x: Math.max(-PUCK_LIMIT_X, Math.min(PUCK_LIMIT_X, kx)),
      y: Math.max(0, num(s.k.y) + num(s.k.vy) * k),
      z: Math.max(-PUCK_LIMIT_Z, Math.min(PUCK_LIMIT_Z, kz)),
    };
  }
  return out;
}

// Smooth corrections: when fresh data replaces an extrapolated guess, keep the rendered position
// continuous and let the error decay (tau 100 ms players / 50 ms puck) instead of teleporting.
export function createCorrector({ tauPlayer = 100, tauPuck = 50, maxJump = 6 } = {}) {
  let prev = null, prevMode = 'empty', prevNewest = -1, prevPh = -1;
  const cp = [], ck = { x: 0, z: 0 };
  return {
    apply(state, mode, newestTime, dtMs) {
      if (!state || !state.p) { prev = null; prevMode = mode; return state; }
      const fresh = prevMode === 'extrap' && (mode !== 'extrap' || newestTime !== prevNewest);
      const phaseChanged = state.ph !== prevPh;
      const dt = dtMs / 1000;
      const dp = Math.exp(-dtMs / tauPlayer), dk = Math.exp(-dtMs / tauPuck);
      for (let i = 0; i < state.p.length; i++) {
        const p = state.p[i];
        if (!p) continue;
        let c = cp[i] || (cp[i] = { x: 0, z: 0 });
        const q = prev && prev.p && prev.p[i];
        if (fresh && q && !phaseChanged) {
          c.x = q.x + num(q.vx) * dt - p.x;
          c.z = q.z + num(q.vz) * dt - p.z;
          if (c.x * c.x + c.z * c.z > maxJump * maxJump) c.x = c.z = 0;
        } else if (phaseChanged) {
          c.x = c.z = 0;
        } else {
          c.x *= dp; c.z *= dp;
        }
        p.x += c.x; p.z += c.z;
      }
      const k = state.k;
      if (k) {
        const owner = k.o >= 0 ? cp[k.o] : null;
        if (owner) {
          ck.x = owner.x; ck.z = owner.z; // a carried puck rides with its carrier's correction
        } else if (fresh && prev && prev.k && !phaseChanged) {
          ck.x = prev.k.x + num(prev.k.vx) * dt - k.x;
          ck.z = prev.k.z + num(prev.k.vz) * dt - k.z;
          if (ck.x * ck.x + ck.z * ck.z > maxJump * maxJump) ck.x = ck.z = 0;
        } else if (phaseChanged) {
          ck.x = ck.z = 0;
        } else {
          ck.x *= dk; ck.z *= dk;
        }
        k.x += ck.x; k.z += ck.z;
      }
      prev = state; prevMode = mode; prevNewest = newestTime; prevPh = state.ph;
      return state;
    },
    reset() { prev = null; prevMode = 'empty'; prevNewest = -1; prevPh = -1; cp.length = 0; ck.x = ck.z = 0; },
  };
}

// Snapshot buffer. Each entry remembers whether its `ev` array has been released.
export function createInterpBuffer(opts = {}) {
  return {
    snaps: [],              // [{ snap, done }], ascending by snap.time
    pending: [],            // events from entries dropped before release (overflow / reset)
    lastRT: -Infinity,      // render time never goes backwards
    maxSnaps: opts.maxSnaps ?? 120,
    maxExtrapMs: opts.maxExtrapMs ?? MAX_EXTRAP_MS,
  };
}

function releaseInto(list, w) {
  if (w.done) return;
  w.done = true;
  const ev = w.snap.ev;
  if (Array.isArray(ev)) for (const e of ev) list.push(e);
}

// Add a snapshot ({time, ...Snapshot, ev}). Returns false if it was a stale duplicate.
export function pushSnap(buf, snap) {
  if (!snap || typeof snap.time !== 'number') return false;
  const S = buf.snaps;
  const last = S[S.length - 1];
  if (last) {
    const backwards = snap.time <= last.snap.time;
    const newGame = typeof snap.tick === 'number' && typeof last.snap.tick === 'number' && snap.tick < last.snap.tick;
    if (backwards && last.snap.time - snap.time > 2000) {
      // Server clock restarted: start over (keep unreleased events).
      buf.pending.push(...resetBuffer(buf));
    } else if (backwards) {
      return false;
    } else if (newGame) {
      buf.pending.push(...resetBuffer(buf));
    }
  }
  S.push({ snap, done: false });
  while (S.length > buf.maxSnaps) releaseInto(buf.pending, S.shift());
  return true;
}

// Sample the buffer at render time rt. Returns { state, events, mode }.
// mode: 'empty' | 'hold' (before the first snapshot) | 'interp' | 'extrap'.
// Every snapshot's events are returned exactly once, the first time rt reaches its time.
export function sampleAt(buf, rt) {
  const S = buf.snaps;
  const events = buf.pending.length ? buf.pending.splice(0) : [];
  if (!S.length) return { state: null, events, mode: 'empty' };
  if (rt < buf.lastRT) rt = buf.lastRT;
  buf.lastRT = rt;

  for (const w of S) {
    if (w.snap.time > rt) break;
    releaseInto(events, w);
  }

  const first = S[0].snap, newest = S[S.length - 1].snap;
  if (rt <= first.time) {
    return { state: extrapolateSnapshot(first, 0), events, mode: 'hold' };
  }
  if (rt >= newest.time) {
    if (S.length > 1) S.splice(0, S.length - 1);
    return { state: extrapolateSnapshot(newest, rt - newest.time, buf.maxExtrapMs), events, mode: 'extrap' };
  }
  let j = 0;
  while (j < S.length - 2 && S[j + 1].snap.time <= rt) j++;
  const state = lerpSnapshots(S[j].snap, S[j + 1].snap, rt);
  if (j > 0) S.splice(0, j); // everything before j is in the past and already released
  return { state, events, mode: 'interp' };
}

// Clear the buffer. Returns ("flushes") every event that was never released, in order.
export function resetBuffer(buf) {
  const out = buf.pending.splice(0);
  for (const w of buf.snaps) releaseInto(out, w);
  buf.snaps.length = 0;
  buf.lastRT = -Infinity;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Clock sync + adaptive delay (pure)
// ---------------------------------------------------------------------------------------------

// One ping/pong round trip: c = client send time, s = server time at reply, now = client receive time.
export function clockSample(c, s, now) {
  const rtt = Math.max(0, now - c);
  return { rtt, offset: s - (c + rtt / 2), at: now };
}

// Offset estimate from the lowest-RTT third of the recent samples (median of their offsets).
export function estimateClock(samples) {
  if (!samples || !samples.length) return null;
  const byRtt = [...samples].sort((a, b) => a.rtt - b.rtt);
  const best = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length / 3)));
  const offs = best.map((s) => s.offset).sort((a, b) => a - b);
  const m = offs.length >> 1;
  const offset = offs.length % 2 ? offs[m] : (offs[m - 1] + offs[m]) / 2;
  return { offset, minRtt: byRtt[0].rtt };
}

// Interpolation delay target: two snapshot intervals, raised for observed lateness/jitter, capped.
// latenessMean / latenessDev: EWMA of (arrival in server time - snap.time) and its mean abs deviation.
export function targetInterpDelay(snapRate, latenessMean = 0, latenessDev = 0, cap = MAX_INTERP_DELAY_MS) {
  const interval = 1000 / snapRate;
  const need = interval + Math.max(0, latenessMean) + 2 * Math.max(0, latenessDev) + 4;
  return Math.min(cap, Math.max(Math.min(MIN_INTERP_DELAY_MS, 2 * interval), need));
}

// ---------------------------------------------------------------------------------------------
// Browser WebSocket client
// ---------------------------------------------------------------------------------------------

export function wsUrl(loc = globalThis.location) {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

// opts: { name, room, snapRate, url?, now? }
// Events (net.on): 'status' (status), 'welcome' (msg), 'lobby' (msg, prevLobby), 'err' (msg),
//                  'game' (serial) when a new game's snapshots start.
export function createNet(opts = {}) {
  const snapRate = opts.snapRate || 30;
  const now = opts.now || (() => performance.now());
  const url = opts.url || wsUrl();
  const listeners = {};
  const emit = (type, ...args) => { for (const fn of listeners[type] || []) { try { fn(...args); } catch (e) { console.error(e); } } };

  const net = {
    status: 'connecting',     // 'connecting' | 'online' | 'reconnecting'
    myId: 0,
    room: opts.room || 'main',
    name: opts.name || 'Skater',
    lobby: null,
    rtt: 0,
    interpDelay: 2000 / snapRate,
    retryAt: 0,               // client ms when the next reconnect attempt happens
    gameSerial: 0,
    everConnected: false,
    lastMode: 'empty',
    on(type, fn) { (listeners[type] ||= []).push(fn); return net; },
  };

  let ws = null;
  let attempt = 0;
  let retryTimer = 0, pingTimer = 0, burstTimers = [];
  let samples = [];
  let offset = 0, haveOffset = false, haveSeed = false, smoothOff = 0, smoothInit = false;
  let lateMean = 0, lateDev = 0, lateInit = false, spikeRun = 0;
  const corrector = createCorrector();
  let lastFrameNow = 0;
  let lastTick = -1;
  let wantTeam = null;       // last team we picked (re-picked automatically after a reconnect)
  const buf = createInterpBuffer();
  const eventQueue = [];

  function setStatus(s) {
    if (net.status === s) return;
    net.status = s;
    emit('status', s);
  }

  function send(msg) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  function sendPing() { send({ t: 'ping', c: now() }); }

  function clearTimers() {
    clearInterval(pingTimer); pingTimer = 0;
    for (const t of burstTimers) clearTimeout(t);
    burstTimers = [];
  }

  function connect() {
    clearTimeout(retryTimer); retryTimer = 0;
    let sock;
    try { sock = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      send({ t: 'hello', name: net.name, room: net.room });
      sendPing();
      // A quick burst of pings so the clock estimate settles in the first second.
      burstTimers = [150, 400, 800].map((ms) => setTimeout(sendPing, ms));
      pingTimer = setInterval(sendPing, 2000);
    };
    sock.onmessage = (e) => { if (ws === sock) onMessage(e.data); };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      clearTimers();
      dropGameState();
      net.myId = 0;
      const prev = net.lobby;
      net.lobby = null;
      if (prev) emit('lobby', null, prev);
      scheduleReconnect();
    };
    sock.onerror = () => { /* onclose follows */ };
  }

  function scheduleReconnect() {
    attempt++;
    const delay = Math.min(8000, 400 * 2 ** Math.min(attempt - 1, 5)) * (0.8 + Math.random() * 0.4);
    net.retryAt = now() + delay;
    setStatus(net.everConnected ? 'reconnecting' : 'connecting');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
  }

  function dropGameState() {
    const flushed = resetBuffer(buf);
    for (const e of flushed) eventQueue.push(e);
    lateInit = false;
    spikeRun = 0;
    corrector.reset();
    lastTick = -1;
  }

  function onMessage(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'welcome': {
        net.myId = m.id;
        if (m.room) net.room = m.room;
        attempt = 0;
        net.everConnected = true;
        setStatus('online');
        emit('welcome', m);
        if (wantTeam !== null && wantTeam !== -1) send({ t: 'pick', team: wantTeam });
        break;
      }
      case 'lobby': {
        const prev = net.lobby;
        net.lobby = m;
        const me = (m.clients || []).find((c) => c.id === net.myId);
        if (me) wantTeam = me.team;
        if (m.state !== 'game') dropGameState();
        if (m.state === 'game' && (!prev || prev.state !== 'game')) net.gameSerial++;
        emit('lobby', m, prev);
        break;
      }
      case 'snap': onSnap(m); break;
      case 'pong': {
        if (typeof m.c !== 'number' || typeof m.s !== 'number') break;
        const t = now();
        const smp = clockSample(m.c, m.s, t);
        if (smp.rtt > 5000) break;
        samples.push(smp);
        if (samples.length > 10) samples.shift();
        const est = estimateClock(samples);
        offset = est.offset;
        haveOffset = true;
        net.rtt = net.rtt ? net.rtt * 0.7 + smp.rtt * 0.3 : smp.rtt;
        break;
      }
      case 'err': emit('err', m); break;
      case 'chat': emit('chat', m); break;
      default: break;
    }
  }

  function onSnap(m) {
    const t = now();
    if (!haveOffset && !haveSeed) { offset = m.time - t; haveSeed = true; }
    // Server restarted or estimate is nonsense: a snapshot can't come from the future.
    if (m.time > t + offset + 1000) {
      samples = []; haveOffset = false;
      offset = m.time - t; smoothInit = false;
      sendPing();
    }
    if (typeof m.tick === 'number' && m.tick < lastTick) net.gameSerial++; // a new game began
    if (!pushSnap(buf, m)) return;
    lastTick = typeof m.tick === 'number' ? m.tick : lastTick;
    // Lateness = how long after the server stamped it we got it (in server time).
    const late = t + offset - m.time;
    if (!lateInit) { lateMean = late; lateDev = 0; lateInit = true; spikeRun = 0; }
    else {
      // Isolated lateness spikes (relay hiccups) shouldn't pump the delay up - coasting covers
      // them. A sustained run (route change to a DERP relay) is real and gets tracked.
      const spike = late > lateMean + 3 * lateDev + 15;
      spikeRun = spike ? spikeRun + 1 : 0;
      if (!spike || spikeRun >= 15) {
        lateMean += (late - lateMean) * 0.08;
        lateDev += (Math.abs(late - lateMean) - lateDev) * 0.08;
      }
    }
  }

  // Interpolated state at client time `t` (performance.now()); null when no game is running.
  net.getState = (t = now()) => {
    const dtMs = lastFrameNow ? Math.min(250, Math.max(0, t - lastFrameNow)) : 16;
    lastFrameNow = t;
    if (!net.lobby || net.lobby.state !== 'game') {
      const ev = sampleAt(buf, -Infinity).events; // flushes pending only
      for (const e of ev) eventQueue.push(e);
      net.lastMode = 'empty';
      return null;
    }
    if (!smoothInit || Math.abs(offset - smoothOff) > 300) { smoothOff = offset; smoothInit = true; }
    else smoothOff += (offset - smoothOff) * Math.min(1, dtMs / 1000);
    const target = targetInterpDelay(snapRate, lateInit ? lateMean : 0, lateInit ? lateDev : 0);
    // Rise quickly when the network gets worse, relax slowly when it gets better.
    const k = target > net.interpDelay ? Math.min(1, dtMs / 250) : Math.min(1, dtMs / 4000);
    net.interpDelay += (target - net.interpDelay) * k;
    const rt = t + smoothOff - net.interpDelay;
    const { state, events, mode } = sampleAt(buf, rt);
    for (const e of events) eventQueue.push(e);
    net.lastMode = mode;
    const newest = buf.snaps.length ? buf.snaps[buf.snaps.length - 1].snap.time : -1;
    return corrector.apply(state, mode, newest, dtMs);
  };

  // Events released since the last call (in order).
  net.takeEvents = () => (eventQueue.length ? eventQueue.splice(0) : []);

  net.serverNow = (t = now()) => t + (smoothInit ? smoothOff : offset);
  net.retryIn = () => Math.max(0, Math.ceil((net.retryAt - now()) / 1000));
  net.connected = () => net.status === 'online';

  net.send = (msg) => send(msg);   // raw message (chat/emote)
  net.url = url;
  net.pick = (team) => { wantTeam = team; return send({ t: 'pick', team }); };
  net.sendConfig = (cfg) => send({ t: 'config', ...cfg });
  net.start = () => send({ t: 'start' });
  net.toLobby = () => send({ t: 'lobby' });
  net.sendInput = (seq, mx, mz, b) => {
    if (!ws || ws.readyState !== 1 || ws.bufferedAmount > 65536) return false;
    return send({ t: 'in', seq, mx: Math.round(mx * 1000) / 1000, mz: Math.round(mz * 1000) / 1000, b });
  };
  // Rename: re-send hello on the open socket (the server may treat it as a rename); the new
  // name is also used for every future (re)connect.
  net.setName = (name) => {
    net.name = name;
    send({ t: 'hello', name, room: net.room });
  };
  net.reconnectNow = () => {
    if (ws) return;
    attempt = 0;
    connect();
  };

  net.connect = () => { if (!ws && !retryTimer) connect(); return net; };
  return net;
}
