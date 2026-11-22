// ICE RIOT - offline practice mode.
//
// Runs the exact same shared simulation (shared/sim.js) inside the page, so a player can play
// solo vs AI with no server (also the fallback when the server can't be reached). Everything it
// hands back has the same shape as the network path:
//   lobby()        -> the body of a server {t:'lobby'} message
//   tick(now)      -> { state, events }: state is what net.getState() returns (Snapshot + time),
//                     events are what net.takeEvents() returns.
// so main.js can swap a local session in for createNet() without touching render / ui / audio.
//
// The sim is loaded with a dynamic import() so this module itself always loads, even when the
// sim file is missing; createLocalSession() rejects with a clear error in that case.

import { TICK_RATE, DT, DEFAULT_CONFIG, PHASE, TEAMS, lerp, lerpAngle } from '../shared/constants.js';

export const LOCAL_CLIENT_ID = 1;
export const MAX_STEPS_PER_TICK = 5;     // fixed-step catch-up cap per tick() call
export const MAX_FRAME_MS = 250;         // real-time gaps longer than this are clamped (tab hidden, breakpoint...)
export const GAME_OVER_LOBBY_MS = 12000; // like the server: back to the lobby 12 s after GAME_OVER
const TELEPORT_DIST = 4;                 // meters in one tick => snap, don't lerp (faceoff reset)
const SIM_EXPORTS = ['createGame', 'step', 'snapshot', 'drainEvents', 'assignClient', 'releaseClient'];

const nowMs = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now());
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clampUnit = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);

// Deep copy of plain JSON-like data. The sim may hand out references to its own internals from
// snapshot(); we keep prev/cur snapshots across steps, so they must be ours.
function cloneData(v) {
  if (Array.isArray(v)) return v.map(cloneData);
  if (v && typeof v === 'object') {
    const o = {};
    for (const key in v) o[key] = cloneData(v[key]);
    return o;
  }
  return v;
}

// Sanitize a config the same way the server's lobby would (lenient on periodLength so dev /
// tests can use short periods; the lobby UI only offers 60/120/180/300).
export function sanitizeConfig(cfg = {}) {
  const out = { ...DEFAULT_CONFIG, ...cfg };
  const nT = TEAMS.length;
  const ti = (v, d) => (Number.isInteger(v) && v >= 0 && v < nT ? v : d);
  let teams = Array.isArray(out.teams) ? out.teams : DEFAULT_CONFIG.teams;
  let h = ti(teams[0], DEFAULT_CONFIG.teams[0]);
  let a = ti(teams[1], DEFAULT_CONFIG.teams[1]);
  if (h === a) a = (h + 1) % nT;
  out.teams = [h, a];
  const pl = Number(out.periodLength);
  out.periodLength = Number.isFinite(pl) && pl >= 5 && pl <= 3600 ? pl : DEFAULT_CONFIG.periodLength;
  const per = Number(out.periods);
  out.periods = Number.isInteger(per) && per >= 1 && per <= 9 ? per : DEFAULT_CONFIG.periods;
  const d = Math.round(Number(out.difficulty));
  out.difficulty = Number.isFinite(d) ? Math.max(0, Math.min(2, d)) : DEFAULT_CONFIG.difficulty;
  return out;
}

// --- interpolation between two consecutive sim snapshots (a = previous tick, b = current) -------

function lerpPlayer(pa, pb, t) {
  const o = { ...pb };
  if (!pa) return o;
  const sameState = pa.s === pb.s;
  if (!sameState) o.sT = Math.max(0, num(pb.sT) - (1 - t) * DT);
  const dx = num(pb.x) - num(pa.x), dz = num(pb.z) - num(pa.z);
  if (dx * dx + dz * dz > TELEPORT_DIST * TELEPORT_DIST) return o; // faceoff reset: show new spot
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
  // Carried puck: interpolate around the (interpolated) carrier so it stays on the stick arc.
  if (ka.o >= 0 && ka.o === kb.o && pa && pb && P) {
    const ax = num(ka.x) - num(pa.x), az = num(ka.z) - num(pa.z);
    const bx = num(kb.x) - num(pb.x), bz = num(kb.z) - num(pb.z);
    const r = lerp(Math.hypot(ax, az), Math.hypot(bx, bz), t);
    const ang = lerpAngle(Math.atan2(az, ax), Math.atan2(bz, bx), t);
    o.x = num(P.x) + Math.cos(ang) * r;
    o.z = num(P.z) + Math.sin(ang) * r;
  }
  return o;
}

// Snapshot-shaped (CONTRACT "Snapshot" + time) state at fraction t between a and b.
// Continuous fields are lerped; discrete fields come from b. Always returns fresh objects.
export function interpolateSnapshots(a, b, t, time) {
  const out = {};
  for (const key in b) {
    if (key === 'p' || key === 'k' || key === 't' || key === 'ev') continue;
    const v = b[key];
    out[key] = Array.isArray(v) ? v.slice() : v;
  }
  out.time = time;
  if (!a) a = b;
  if (a.ph === b.ph && a.per === b.per) {
    out.clk = lerp(num(a.clk), num(b.clk), t);
    out.phT = lerp(num(a.phT), num(b.phT), t);
  }
  const pa = a.p || [], pb = b.p || [];
  out.p = pb.map((p, i) => lerpPlayer(pa[i], p, t));
  if (b.k) {
    const o = b.k.o;
    out.k = lerpPuck(a.k, b.k, t, pa[o], pb[o], out.p[o]);
  } else out.k = b.k;
  return out;
}

// -------------------------------------------------------------------------------------------------

export async function createLocalSession({
  config = {},
  name = 'You',
  team = 0,
  simUrl = '../shared/sim.js',
  // extras (optional):
  sim = null,                       // pass an already-imported sim module instead of loading simUrl
  seed = null,                      // fixed seed for every start() (default: random per game)
  autoLobbyMs = GAME_OVER_LOBBY_MS, // 0 = stay on GAME_OVER until backToLobby()
} = {}) {
  let S = sim;
  if (!S) {
    let url = simUrl;
    try { url = new URL(simUrl, import.meta.url).href; } catch { /* bare specifier: import as-is */ }
    try {
      S = await import(url);
    } catch (e) {
      throw new Error(`ICE RIOT offline mode: could not load the game simulation from ${url} (${e && e.message ? e.message : e})`);
    }
  }
  const missing = SIM_EXPORTS.filter((k) => typeof S[k] !== 'function');
  if (missing.length) {
    throw new Error(`ICE RIOT offline mode: the game simulation is missing export(s): ${missing.join(', ')}`);
  }

  const myId = LOCAL_CLIENT_ID;
  const listeners = {};
  const emit = (type, ...args) => { for (const fn of listeners[type] || []) { try { fn(...args); } catch (e) { console.error(e); } } };

  let cfg = sanitizeConfig(config);
  let myName = String(name || 'You').slice(0, 16);
  let myTeam = team === 0 || team === 1 ? team : -1;
  let state = 'lobby';           // 'lobby' | 'game'
  let game = null;
  let prev = null, cur = null;   // previous / current sim snapshot (our own copies)
  let acc = 0;                   // seconds of real time not yet simulated
  let lastNow = null;            // ms; null => next tick() just sets the time base
  let paused = false;
  let disposed = false;
  let overSec = 0;               // sim seconds spent in GAME_OVER
  let input = { mx: 0, mz: 0, b: 0 };
  let latched = 0;               // buttons seen by setInput() since the last sim step
  let lastState = null;
  let gameSerial = 0;            // +1 per start(), like net.gameSerial

  function lobby() {
    return {
      t: 'lobby',
      state,
      host: myId,
      clients: [{ id: myId, name: myName, team: myTeam, ping: 0 }],
      config: { ...cfg, teams: [...cfg.teams] },
      offline: true,
    };
  }
  let lastLobby = null;
  function lobbyChanged() {
    const prevLobby = lastLobby;
    lastLobby = lobby();
    emit('lobby', lastLobby, prevLobby);
  }

  function takeSnapshot() {
    return cloneData(S.snapshot(game));
  }

  function stepOnce(events) {
    const inputs = {};
    if (myTeam >= 0) inputs[myId] = { mx: input.mx, mz: input.mz, b: input.b | latched };
    latched = 0;
    S.step(game, DT, inputs);
    const ev = S.drainEvents(game);
    if (Array.isArray(ev)) for (const e of ev) events.push(e);
    prev = cur;
    cur = takeSnapshot();
    if (cur && cur.ph === PHASE.GAME_OVER) overSec += DT; else overSec = 0;
  }

  function assignMe() {
    if (!game || myTeam < 0) return -1;
    const id = S.assignClient(game, myTeam, myId);
    return typeof id === 'number' ? id : -1;
  }

  function endGame() {
    game = null; prev = null; cur = null; lastState = null;
    acc = 0; lastNow = null; overSec = 0; paused = false; latched = 0;
  }

  const session = {
    myId,
    offline: true,

    lobby,

    // Start (or restart) a game. Returns the player id the local human controls (-1 = spectating).
    start(configOverrides) {
      if (disposed) throw new Error('local session disposed');
      if (configOverrides) cfg = sanitizeConfig({ ...cfg, ...configOverrides });
      const s = Number.isInteger(seed) ? seed : (Math.floor(Math.random() * 0x7fffffff) + 1);
      game = S.createGame({ ...cfg, teams: [...cfg.teams] }, s);
      const pid = assignMe();
      if (pid < 0) myTeam = -1; // like the server: no free skater -> spectator
      // (events queued by createGame/assignClient stay in the sim queue and come out with the
      //  first step's drain, exactly like they would in the server's first snap)
      cur = takeSnapshot();
      prev = cur;
      acc = 0; lastNow = null; overSec = 0; paused = false; latched = 0; lastState = null;
      state = 'game';
      gameSerial++;
      lobbyChanged();
      return pid;
    },

    // Latest local input (values are copied; input.poll() returns a reused object).
    setInput(inp) {
      if (!inp) return;
      const mx = clampUnit(num(inp.mx)), mz = clampUnit(num(inp.mz));
      const b = num(inp.b) & 15; // same mask as the server (BTN bits only)
      input = { mx, mz, b };
      // a tap that starts and ends between two sim steps is still seen by one step
      // (not while paused: menu key presses must not fire a shot on resume)
      if (!paused) latched |= b;
    },

    // Advance the sim by real elapsed time (fixed 60 Hz steps) and return the interpolated state
    // plus every event drained during this call. state is null outside a game (like net.getState()).
    tick(now = nowMs()) {
      const events = [];
      if (disposed || state !== 'game' || !game) return { state: null, events };
      if (lastNow === null) lastNow = now;
      let elapsed = now - lastNow;
      lastNow = now;
      if (!(elapsed > 0)) elapsed = 0;
      if (elapsed > MAX_FRAME_MS) elapsed = MAX_FRAME_MS;
      if (!paused) {
        acc += elapsed / 1000;
        let steps = 0;
        try {
          // (tiny epsilon so 16.6667 ms frames don't alternate 0/2 steps through float error)
          while (acc >= DT - 1e-9 && steps < MAX_STEPS_PER_TICK) {
            stepOnce(events);
            acc -= DT;
            steps++;
          }
        } catch (err) {
          // Same as the server's _simCrashed(): report it and go back to the lobby instead of
          // throwing out of the caller's rAF loop.
          console.error('ICE RIOT offline: sim crashed', err);
          session.backToLobby();
          emit('err', { t: 'err', msg: `The game simulation crashed, so you're back in the lobby (${err && err.message ? err.message : err})` });
          return { state: null, events };
        }
        if (acc < 0) acc = 0;
        if (acc >= DT) acc %= DT; // hit the cap: drop the backlog instead of spiraling
      }
      const alpha = Math.max(0, Math.min(1, acc / DT));
      const st = interpolateSnapshots(prev, cur, alpha, now);
      lastState = st;
      if (autoLobbyMs > 0 && overSec * 1000 >= autoLobbyMs) {
        session.backToLobby();
        return { state: null, events };
      }
      return { state: st, events };
    },

    pause(on = true) {
      on = !!on;
      if (on === paused) return;
      paused = on;
      if (!on) lastNow = null; // don't count the paused time when resuming
      latched = 0;
    },
    isPaused() { return paused; },

    // Switch side: 0 home, 1 away, -1 spectate. Works in the lobby and mid-game.
    // Returns the controlled player id in a game (-1 if none), or the team in the lobby.
    pick(t) {
      const nt = t === 0 || t === 1 ? t : -1;
      if (!game) {
        if (nt !== myTeam) { myTeam = nt; lobbyChanged(); }
        return myTeam;
      }
      if (nt === myTeam) return currentPlayerId();
      S.releaseClient(game, myId);
      myTeam = nt;
      const pid = assignMe();
      if (pid < 0 && nt >= 0) myTeam = -1; // no AI skater left on that team (can't happen solo)
      // The sim's snapshot changes immediately (ctrl moved); refresh cur so the next frame shows it.
      cur = takeSnapshot();
      lobbyChanged();
      return pid;
    },

    backToLobby() {
      if (state === 'lobby' && !game) return;
      endGame();
      state = 'lobby';
      lobbyChanged();
    },

    dispose() {
      if (disposed) return;
      endGame();
      state = 'lobby';
      disposed = true;
      for (const k in listeners) delete listeners[k];
    },

    // --- extras, mirroring net.js so main.js can treat both the same way ---
    on(type, fn) { (listeners[type] ||= []).push(fn); return session; },
    setConfig(c) { if (!c) return; cfg = sanitizeConfig({ ...cfg, ...c }); lobbyChanged(); },
    setName(n) { myName = String(n || 'You').slice(0, 16); lobbyChanged(); },
    lastState() { return lastState; },   // last value tick() returned as `state` (null outside a game)
    get inGame() { return state === 'game' && !!game; },
    get gameSerial() { return gameSerial; },
    get tickRate() { return TICK_RATE; },

    // A drop-in stand-in for the object createNet() returns (same property/method names), so
    // main.js can do `conn = local.asNet()` and keep calling conn.getState(), conn.takeEvents(),
    // conn.sendInput(), conn.pick(), conn.sendConfig(), conn.start(), conn.toLobby(), conn.lobby...
    asNet() {
      if (facade) return facade;
      const evq = [];
      facade = {
        offline: true,
        session,
        myId,
        room: 'offline',
        rtt: 0,
        interpDelay: 0,
        retryAt: 0,
        everConnected: true,
        lastMode: 'local',
        get status() { return disposed ? 'closed' : 'online'; },
        get name() { return myName; },
        get lobby() { return lastLobby; },
        get gameSerial() { return gameSerial; },
        on(type, fn) { session.on(type, fn); return facade; },
        getState(t = nowMs()) {
          const r = session.tick(t);
          for (const e of r.events) evq.push(e);
          return r.state;
        },
        takeEvents: () => (evq.length ? evq.splice(0) : []),
        serverNow: (t = nowMs()) => t,
        retryIn: () => 0,
        connected: () => !disposed,
        pick: (team) => { session.pick(team); return true; },
        sendConfig: (c) => { session.setConfig(c); return true; },
        start: () => { session.start(); return true; },
        toLobby: () => { session.backToLobby(); return true; },
        sendInput: (seq, mx, mz, b) => { session.setInput({ mx, mz, b }); return true; },
        setName: (n) => session.setName(n),
        reconnectNow() {},
        connect() { return facade; },
        pause: (on) => session.pause(on),
        isPaused: () => session.isPaused(),
        dispose: () => session.dispose(),
      };
      return facade;
    },
  };
  let facade = null;

  function currentPlayerId() {
    if (!cur || !Array.isArray(cur.p)) return -1;
    const me = cur.p.find((p) => p && p.c === myId);
    return me ? me.id : -1;
  }

  lastLobby = lobby();
  return session;
}
