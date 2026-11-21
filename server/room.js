// ICE RIOT - rooms, lobby and the authoritative fixed-timestep game loop.
//
// The sim module is injected ({ createGame, step, snapshot, drainEvents, assignClient, releaseClient },
// see docs/CONTRACT.md) so this file never imports shared/sim.js itself.

import { randomInt } from 'node:crypto';
import {
  TICK_RATE,
  SNAP_RATE,
  DT,
  PHASE,
  TEAMS,
  DEFAULT_CONFIG,
  MAX_HUMANS_PER_TEAM,
} from '../shared/constants.js';
import { encodeText } from './ws.js';
import { createChat } from './chat.js';
import { createGameTally } from './stats-store.js';

const STEP_MS = 1000 / TICK_RATE;
const TICKS_PER_SNAP = Math.max(1, Math.round(TICK_RATE / SNAP_RATE));
const MAX_CATCHUP_STEPS = 5;
const SPIN_MS = 1;                       // finish the last ~1 ms with setImmediate
const IS_WINDOWS = process.platform === 'win32';
const SNAP_BACKPRESSURE_BYTES = 512 * 1024;
const PERIOD_LENGTHS = [60, 120, 180, 300];
const MAX_CLIENTS_PER_ROOM = 16;
const ROOM_PING_MS = 2000;               // RTT probe + (at most) one lobby rebroadcast for ping changes
const PING_CHANGE_MS = 5;                // rebroadcast lobby only if someone's ping moved this much
const INPUT_STALE_MS = 1000;             // no input for this long (hidden tab) -> treat as released
const HELLO_TIMEOUT_MS = 10000;
const TEAM_LABEL = ['Home', 'Away'];

// ---------------------------------------------------------------------------------------------
// Sanitizers (exported for tests)

const CONTROL_RE = new RegExp(
  '[' +
    [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]]
      .map(([a, b]) => `\\u${a.toString(16).padStart(4, '0')}-\\u${b.toString(16).padStart(4, '0')}`)
      .join('') +
    ']',
  'g',
);
const HTMLISH_RE = /[<>&"'`\\]/g;

export function sanitizeName(raw, fallback) {
  let s = typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
  s = s.slice(0, 256).replace(CONTROL_RE, '').replace(HTMLISH_RE, '').replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, 16).join('').trim();
  return s || fallback;
}

export function sanitizeRoom(raw) {
  let s = typeof raw === 'string' ? raw : '';
  s = s
    .slice(0, 256)
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return s || 'main';
}

function round3(_key, v) {
  return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
}

function axis(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

// ---------------------------------------------------------------------------------------------

export class RoomManager {
  constructor({ sim, log = () => {}, gameOverLingerMs = 12000, stats = null } = {}) {
    for (const fn of ['createGame', 'step', 'snapshot', 'drainEvents', 'assignClient', 'releaseClient']) {
      if (typeof sim?.[fn] !== 'function') throw new Error(`sim module is missing ${fn}()`);
    }
    this.sim = sim;
    this.log = log;
    this.stats = stats; // optional persistent stats store (server/stats-store.js)
    this.gameOverLingerMs = gameOverLingerMs;
    this.rooms = new Map();
    this.nextClientId = 1;
  }

  handleConnection(conn) {
    let client = null;
    const helloTimer = setTimeout(() => {
      if (!client) conn.close(1008, 'expected hello');
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    conn.on('message', (str) => {
      let msg;
      try {
        msg = JSON.parse(str);
      } catch {
        return; // malformed JSON: ignore
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
      try {
        if (client) {
          client.room.handle(client, msg);
        } else if (msg.t === 'hello') {
          clearTimeout(helloTimer);
          client = this._join(conn, msg);
        } else if (msg.t === 'ping') {
          conn.send(JSON.stringify({ t: 'pong', c: typeof msg.c === 'number' ? msg.c : 0, s: now3() }));
        }
      } catch (err) {
        this.log(`error handling '${String(msg.t).slice(0, 16)}': ${err?.stack || err}`);
      }
    });
    conn.on('rtt', (rtt) => client?.room.onRtt(client, rtt));
    conn.on('close', () => {
      clearTimeout(helloTimer);
      if (client) {
        try {
          client.room.leave(client);
        } catch (err) {
          this.log(`error on leave: ${err?.stack || err}`);
        }
        client = null;
      }
    });
  }

  _join(conn, msg) {
    const roomName = sanitizeRoom(msg.room);
    let room = this.rooms.get(roomName);
    if (room && room.clients.size >= MAX_CLIENTS_PER_ROOM) {
      conn.send(JSON.stringify({ t: 'err', msg: `Room "${roomName}" is full` }));
      conn.close(1008, 'room full');
      return null;
    }
    if (!room) {
      room = new Room(this, roomName);
      this.rooms.set(roomName, room);
    }
    const id = this.nextClientId++;
    const name = sanitizeName(msg.name, `Player ${id}`);
    return room.join(conn, id, name);
  }

  _destroyRoom(room) {
    if (this.rooms.get(room.name) === room) this.rooms.delete(room.name);
  }

  close() {
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
  }
}

// ---------------------------------------------------------------------------------------------

export class Room {
  constructor(manager, name) {
    this.manager = manager;
    this.sim = manager.sim;
    this.log = (s) => manager.log(`[${name}] ${s}`);
    this.name = name;
    this.clients = new Map(); // insertion order == join order; first entry is the host
    this.config = { ...DEFAULT_CONFIG, teams: [...DEFAULT_CONFIG.teams] };
    this.game = null;
    this.inputs = {};
    this.chat = createChat();
    this.tally = null;
    this.destroyed = false;
    this._lobbyQueued = false;
    this._pingDirty = false;
    this._host = 0;
    this._pingTimer = setInterval(() => this._pingTick(), ROOM_PING_MS);
    this._pingTimer.unref?.();
    this._resetLoopState();
  }

  // ---- membership -------------------------------------------------------------------------

  hostId() {
    const first = this.clients.values().next();
    return first.done ? 0 : first.value.id;
  }

  humansOn(team, except = null) {
    let n = 0;
    for (const c of this.clients.values()) if (c !== except && c.team === team) n++;
    return n;
  }

  join(conn, id, name) {
    const client = {
      id,
      name,
      conn,
      room: this,
      team: -1,
      ping: 0,
      pingSent: 0,
      lastInputAt: 0,
      snapsSkipped: 0,
    };
    if (!this.game) {
      // Lobby: auto-balance onto the team with fewer humans (players can re-pick).
      const h = this.humansOn(0);
      const a = this.humansOn(1);
      if (Math.min(h, a) < MAX_HUMANS_PER_TEAM) client.team = a < h ? 1 : 0;
    }
    this.clients.set(id, client);
    if (!this._host) this._host = id;
    conn.send(JSON.stringify({ t: 'welcome', id, room: this.name }));
    for (const m of this.chat.history()) conn.send(JSON.stringify({ ...m, hist: true }));
    conn.ping();
    this.log(`+ ${name} (#${id}${conn.remoteAddress ? ' ' + conn.remoteAddress : ''}) joined, ${this.clients.size} in room${this.game ? ', game running' : ''}`);
    this.scheduleLobby();
    return client;
  }

  leave(client) {
    if (this.clients.get(client.id) !== client) return;
    this.clients.delete(client.id);
    delete this.inputs[client.id];
    this.chat.forget(client.id);
    if (this.game && client.team !== -1) this._simRelease(client.id);
    this.log(`- ${client.name} (#${client.id}) left, ${this.clients.size} in room`);
    if (this.clients.size === 0) {
      this.destroy();
      return;
    }
    const host = this.hostId();
    if (host !== this._host) {
      this._host = host;
      this.log(`host is now ${this.clients.get(host).name} (#${host})`);
    }
    this.scheduleLobby();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stopLoop();
    this.game = null;
    clearInterval(this._pingTimer);
    this.manager._destroyRoom(this);
    this.log('room closed');
  }

  // ---- messaging --------------------------------------------------------------------------

  send(client, obj) {
    client.conn.send(JSON.stringify(obj));
  }

  err(client, msg) {
    this.send(client, { t: 'err', msg });
  }

  broadcast(obj) {
    const frame = encodeText(JSON.stringify(obj));
    for (const c of this.clients.values()) c.conn.sendFrame(frame);
  }

  lobbyMessage() {
    const clients = [];
    for (const c of this.clients.values()) {
      clients.push({ id: c.id, name: c.name, team: c.team, ping: Math.round(c.ping) });
      c.pingSent = Math.round(c.ping);
    }
    this._pingDirty = false;
    return {
      t: 'lobby',
      state: this.game ? 'game' : 'lobby',
      host: this.hostId(),
      clients,
      config: { ...this.config, teams: [...this.config.teams] },
    };
  }

  /** Coalesce lobby changes made in the same turn into one broadcast. */
  scheduleLobby() {
    if (this._lobbyQueued || this.destroyed) return;
    this._lobbyQueued = true;
    queueMicrotask(() => {
      this._lobbyQueued = false;
      if (!this.destroyed && this.clients.size) this.broadcast(this.lobbyMessage());
    });
  }

  onRtt(client, rtt) {
    if (!this.clients.has(client.id)) return;
    client.ping = client.ping > 0 ? client.ping * 0.7 + rtt * 0.3 : rtt;
    if (Math.abs(Math.round(client.ping) - client.pingSent) >= PING_CHANGE_MS) this._pingDirty = true;
  }

  _pingTick() {
    if (this._pingDirty) this.scheduleLobby(); // results of the previous probe round
    for (const c of this.clients.values()) c.conn.ping();
  }

  handle(client, msg) {
    switch (msg.t) {
      case 'in':
        return this.onInput(client, msg);
      case 'ping':
        return this.send(client, { t: 'pong', c: typeof msg.c === 'number' ? msg.c : 0, s: now3() });
      case 'pick':
        return this.onPick(client, msg);
      case 'config':
        return this.onConfig(client, msg);
      case 'start':
        return this.onStart(client);
      case 'lobby':
        return this.onLobby(client);
      case 'hello':
        return this.onRename(client, msg); // a second hello renames (the room cannot change)
      case 'chat':
      case 'emote': {
        const r = this.chat.handle(client, msg, Date.now());
        if (!r) return undefined;
        if (r.error) return this.err(client, r.error);
        return this.broadcast(r);
      }
      default:
        return undefined; // unknown types: ignore
    }
  }

  onRename(client, msg) {
    if (!Object.hasOwn(msg, 'name')) return;
    const name = sanitizeName(msg.name, client.name);
    if (name === client.name) return;
    this.log(`${client.name} (#${client.id}) is now ${name}`);
    client.name = name;
    this.scheduleLobby();
  }

  // ---- lobby commands ---------------------------------------------------------------------

  onPick(client, msg) {
    const team = Number(msg.team);
    if (team !== 0 && team !== 1 && team !== -1) return this.err(client, 'Invalid team');
    if (team === client.team) return this.scheduleLobby();
    if (team !== -1 && this.humansOn(team, client) >= MAX_HUMANS_PER_TEAM) {
      return this.err(client, `${TEAM_LABEL[team]} team is full`);
    }
    if (!this.game) {
      client.team = team;
      return this.scheduleLobby();
    }
    // Mid-game: hand the old skater back to the AI, then drop in on the new team.
    const old = client.team;
    if (old !== -1) this._simRelease(client.id);
    delete this.inputs[client.id];
    client.team = -1;
    if (team !== -1) {
      if (this._simAssign(team, client.id) >= 0) {
        client.team = team;
      } else {
        this.err(client, `${TEAM_LABEL[team]} team has no free skater`);
        if (old !== -1 && this._simAssign(old, client.id) >= 0) client.team = old;
      }
    }
    if (client.team !== old) {
      this.log(`${client.name} -> ${client.team === -1 ? 'spectators' : TEAM_LABEL[client.team]}`);
    }
    this.scheduleLobby();
  }

  onConfig(client, msg) {
    if (client.id !== this.hostId()) return this.err(client, 'Only the host can change the settings');
    if (this.game) return this.err(client, 'Settings can only be changed in the lobby');
    const next = { ...this.config, teams: [...this.config.teams] };
    if (Object.hasOwn(msg, 'teams')) {
      const t = msg.teams;
      if (!Array.isArray(t) || t.length !== 2) return this.err(client, 'Invalid teams');
      const h = Number(t[0]);
      const a = Number(t[1]);
      const ok = (i) => Number.isInteger(i) && i >= 0 && i < TEAMS.length;
      if (!ok(h) || !ok(a)) return this.err(client, 'Invalid teams');
      if (h === a) return this.err(client, 'Home and away must be different teams');
      next.teams = [h, a];
    }
    if (Object.hasOwn(msg, 'periodLength')) {
      const p = Number(msg.periodLength);
      if (!PERIOD_LENGTHS.includes(p)) return this.err(client, `Period length must be one of ${PERIOD_LENGTHS.join(', ')}`);
      next.periodLength = p;
    }
    if (Object.hasOwn(msg, 'difficulty')) {
      const d = Number(msg.difficulty);
      if (!Number.isInteger(d) || d < 0 || d > 2) return this.err(client, 'Difficulty must be 0, 1 or 2');
      next.difficulty = d;
    }
    this.config = next;
    this.scheduleLobby();
  }

  onStart(client) {
    if (client.id !== this.hostId()) return this.err(client, 'Only the host can start the game');
    if (this.game) return this.err(client, 'A game is already running');
    const seed = randomInt(1, 0x7fffffff);
    let game;
    try {
      game = this.sim.createGame({ ...DEFAULT_CONFIG, ...this.config, teams: [...this.config.teams] }, seed);
    } catch (err) {
      this.log(`createGame failed: ${err?.stack || err}`);
      return this.err(client, `Could not start the game: ${err?.message || err}`);
    }
    this.game = game;
    this.inputs = {};
    for (const c of this.clients.values()) {
      if (c.team === -1) continue;
      if (this._simAssign(c.team, c.id) < 0) c.team = -1;
    }
    this.tally = this.manager.stats
      ? createGameTally({
          config: { ...DEFAULT_CONFIG, ...this.config },
          teams: [...this.config.teams],
          names: (id) => this.clients.get(id)?.name,
        })
      : null;
    const [h, a] = this.config.teams;
    const humans = [...this.clients.values()].filter((c) => c.team !== -1).length;
    this.log(`game started: ${TEAMS[h].name} vs ${TEAMS[a].name}, ${this.config.periodLength}s periods, difficulty ${this.config.difficulty}, ${humans} human skater(s), seed ${seed}`);
    this._startLoop();
    this.scheduleLobby();
  }

  onLobby(client) {
    if (client.id !== this.hostId()) return this.err(client, 'Only the host can end the game');
    if (!this.game) return undefined;
    this.endGame('ended by host');
  }

  onInput(client, msg) {
    if (!this.game || client.team === -1) return;
    let inp = this.inputs[client.id];
    if (!inp) inp = this.inputs[client.id] = { mx: 0, mz: 0, b: 0 };
    inp.mx = axis(msg.mx);
    inp.mz = axis(msg.mz);
    inp.b = (Number(msg.b) | 0) & 15;
    client.lastInputAt = performance.now();
  }

  endGame(reason) {
    if (!this.game) return;
    this._stopLoop();
    this.game = null;
    this.inputs = {};
    this.tally = null; // a game aborted before GAME_OVER is not recorded
    this.log(`back to lobby (${reason})`);
    this.scheduleLobby();
  }

  // ---- sim wrappers -----------------------------------------------------------------------

  _simAssign(team, id) {
    try {
      const pid = this.sim.assignClient(this.game, team, id);
      return Number.isInteger(pid) ? pid : -1;
    } catch (err) {
      this.log(`assignClient failed: ${err?.stack || err}`);
      return -1;
    }
  }

  _simRelease(id) {
    try {
      this.sim.releaseClient(this.game, id);
    } catch (err) {
      this.log(`releaseClient failed: ${err?.stack || err}`);
    }
  }

  _simCrashed(where, err) {
    this.log(`sim ${where}() threw, aborting game: ${err?.stack || err}`);
    for (const c of this.clients.values()) this.err(c, 'The game simulation crashed - back to the lobby');
    this.endGame('simulation error');
  }

  // ---- fixed-timestep loop ----------------------------------------------------------------
  //
  // Windows timers wake at the ~15.6 ms system tick no matter what delay is requested
  // (setTimeout(fn, 16) actually sleeps ~31 ms). So on Windows we always ask for setTimeout(1),
  // which wakes on the next system tick (~64 wakes/s), and an accumulator decides how many
  // 1/60 s steps are due. On other platforms we sleep until ~1 ms before the next step.
  // Either way the last <= 1 ms is spun with setImmediate. Snapshot `time` is the step's
  // scheduled time (not the wake time), so timestamps are exactly 1000/SNAP_RATE ms apart and
  // client interpolation stays smooth despite wake-up jitter.

  _resetLoopState() {
    this.running = false;
    this._timer = null;
    this._immediate = null;
    this.acc = 0;
    this.lastWake = 0;
    this.ticks = 0;
    this.droppedSteps = 0;
    this.gameOverAt = 0;
    this.loopStartedAt = 0;
  }

  _startLoop() {
    this._stopLoop();
    this._resetLoopState();
    this.running = true;
    this.lastWake = this.loopStartedAt = performance.now();
    this._loopFn ||= () => this._loop();
    this._schedule();
  }

  _stopLoop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    if (this._immediate) clearImmediate(this._immediate);
    this._timer = this._immediate = null;
  }

  _schedule() {
    if (!this.running) return;
    const wait = STEP_MS - this.acc - (performance.now() - this.lastWake);
    if (wait <= SPIN_MS) {
      this._immediate = setImmediate(this._loopFn);
    } else {
      this._timer = setTimeout(this._loopFn, IS_WINDOWS ? 1 : Math.max(1, Math.floor(wait - SPIN_MS)));
    }
  }

  _loop() {
    this._timer = this._immediate = null;
    if (!this.running || !this.game) return;
    const now = performance.now();
    this.acc += now - this.lastWake;
    this.lastWake = now;

    let steps = 0;
    let snapDue = false;
    while (this.acc >= STEP_MS && steps < MAX_CATCHUP_STEPS) {
      this.acc -= STEP_MS;
      steps++;
      try {
        this.sim.step(this.game, DT, this.inputs);
      } catch (err) {
        return this._simCrashed('step', err);
      }
      this.ticks++;
      if (this.ticks % TICKS_PER_SNAP === 0) snapDue = true;
    }
    if (this.acc >= STEP_MS) {
      // Too far behind (debugger, GC storm, sleeping laptop): drop the backlog instead of fast-forwarding.
      this.droppedSteps += Math.floor(this.acc / STEP_MS);
      this.acc %= STEP_MS;
    }
    if (snapDue) {
      this._expireStaleInputs(now);
      this._sendSnap(now - this.acc, now);
      if (!this.game) return; // snapshot crashed
    }
    if (this.gameOverAt && now - this.gameOverAt >= this.manager.gameOverLingerMs) {
      this.endGame('final whistle');
      return;
    }
    this._schedule();
  }

  _expireStaleInputs(now) {
    for (const id in this.inputs) {
      const c = this.clients.get(Number(id));
      const inp = this.inputs[id];
      if (!c) {
        delete this.inputs[id];
      } else if (now - c.lastInputAt > INPUT_STALE_MS && (inp.mx || inp.mz || inp.b)) {
        inp.mx = inp.mz = inp.b = 0;
      }
    }
  }

  _sendSnap(time, now) {
    let snap;
    let ev;
    try {
      snap = this.sim.snapshot(this.game);
    } catch (err) {
      return this._simCrashed('snapshot', err);
    }
    try {
      ev = this.sim.drainEvents(this.game);
    } catch (err) {
      return this._simCrashed('drainEvents', err);
    }
    const msg = { t: 'snap', time: 0, ...snap };
    msg.t = 'snap';
    msg.time = time;
    msg.ev = Array.isArray(ev) ? ev : [];
    if (this.tally) {
      try {
        this.tally.add(msg.ev, snap);
        if (this.tally.done) {
          this.manager.stats.recordGame(this.tally.result());
          this.tally = null; // record exactly once
        }
      } catch (err) {
        this.log(`stats error: ${err?.stack || err}`);
        this.tally = null;
      }
    }
    const frame = encodeText(JSON.stringify(msg, round3)); // serialize + frame once for everyone
    for (const c of this.clients.values()) {
      if (c.conn.bufferedAmount > SNAP_BACKPRESSURE_BYTES) {
        c.snapsSkipped++;
        continue;
      }
      c.conn.sendFrame(frame);
    }
    if (snap && snap.ph === PHASE.GAME_OVER && !this.gameOverAt) {
      this.gameOverAt = now;
      const sc = Array.isArray(snap.sc) ? snap.sc.join('-') : '?';
      this.log(`final: ${TEAMS[this.config.teams[0]].name} ${sc} ${TEAMS[this.config.teams[1]].name}`);
    }
  }

  stats() {
    const elapsed = (performance.now() - this.loopStartedAt) / 1000;
    return {
      running: this.running,
      ticks: this.ticks,
      elapsed,
      tickRate: elapsed > 0 ? this.ticks / elapsed : 0,
      droppedSteps: this.droppedSteps,
    };
  }
}

function now3() {
  return Math.round(performance.now() * 1000) / 1000;
}
