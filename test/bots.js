#!/usr/bin/env node
// ICE RIOT - QA bot swarm.
//
// Spawns N headless WebSocket clients that speak the docs/CONTRACT.md protocol, play plausibly
// (chase the puck, carry it to the opponent net and shoot, check / poke opponents, occasional
// pass / deke / turbo), validate every server message against the contract, and measure
// network quality per bot: snaps/s, inter-snap gap (mean / p95 / max), bytes/s received, RTT
// via ping/pong, events seen by type.
//
// CLI:
//   node test/bots.js --url ws://localhost:8765/ws --bots 5 --room main --seconds 60 [--start]
//   options:
//     --url <ws url>        server WebSocket endpoint            (default ws://localhost:8765/ws)
//     --bots <n>            number of bots                       (default 5)
//     --room <name>         room to join                         (default main)
//     --seconds <s>         how long to run                      (default 60)
//     --start               if a bot is host: send config + start once everyone joined
//                           (and again whenever the room falls back to the lobby)
//     --period <s>          periodLength sent with --start       (default 60)
//     --difficulty <0..2>   difficulty sent with --start         (default 1)
//     --teams <h,a>         TEAMS indices sent with --start      (default 0,1)
//     --team-start <0|1>    team of bot #1; the rest alternate   (default 0)
//     --team <t>            force every bot onto team t (-1 = spectate)
//     --name <prefix>       bot name prefix                      (default Bot)
//     --min-rate <n>        fail if a bot's snaps/s is below n   (default 25)
//     --stagger <ms>        delay between bot connects           (default 60)
//     --json <path>         also write the full results as JSON
//     --quiet               no progress lines, summary only
//   exit code: 0 = all bots OK, 1 = snaps/s too low or any protocol error, 2 = bad usage.
//
// Module:
//   import { startBots, runBots } from './bots.js';
//   const swarm = startBots({ url, bots: 3, room: 'main', seconds: 30, start: true, teamStart: 1 });
//   swarm.bots            // live Bot objects (id, team, latest snap, ...)
//   await swarm.done      // -> results (same shape as --json); swarm.stop() ends early
//
// Zero dependencies: uses Node's global WebSocket (Node >= 22).

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { BTN, PHASE, PSTATE, EVENT, RINK, TEAMS, TEAM_SIZE, GOALIE_K } from '../shared/constants.js';

const PHASES = new Set(Object.values(PHASE));
const PSTATES = new Set(Object.values(PSTATE));
const EVENT_TYPES = new Set(Object.values(EVENT));
const SERVER_MSGS = new Set(['welcome', 'lobby', 'snap', 'pong', 'err']);
const PHASE_NAME = Object.fromEntries(Object.entries(PHASE).map(([k, v]) => [v, k]));
const GLASS_PANELS = 44;
const SEND_HZ = 60;
const SEND_PERIOD = 1000 / SEND_HZ;
const PING_EVERY_MS = 1000;
const MAX_STORED_ERRORS = 40;
const STALL_MS = 250;          // an inter-snap gap above this is recorded as a stall

export const DEFAULTS = {
  url: 'ws://localhost:8765/ws',
  bots: 5,
  room: 'main',
  seconds: 60,
  start: false,
  period: 60,
  difficulty: 1,
  teams: [0, 1],
  teamStart: 0,
  team: null,          // null = alternate starting at teamStart
  name: 'Bot',
  minRate: 25,
  stagger: 60,
  json: null,
  quiet: false,
  log: null,           // (line) => void ; default console.log unless quiet
  seed: 12345,
};

// ---------------------------------------------------------------- small helpers

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => Number.isInteger(v);
const flag = (v) => v === 0 || v === 1 || v === true || v === false;
const truthy = (v) => v === 1 || v === true;
const hyp = Math.hypot;

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function pct(a, p) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
function round(v, d = 1) { const m = 10 ** d; return Math.round(v * m) / m; }

// Mulberry32: deterministic per-bot randomness so runs are comparable.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Event objects carry their type under some key; the contract lists the values (EVENT.*) but not
// the key name, so accept the usual suspects.
export function eventType(e) {
  if (!e || typeof e !== 'object') return '?';
  for (const k of ['type', 't', 'e', 'ev', 'kind']) {
    if (typeof e[k] === 'string' && EVENT_TYPES.has(e[k])) return e[k];
  }
  return typeof e.type === 'string' ? e.type : typeof e.t === 'string' ? e.t : '?';
}

// Count numbers that carry more than 3 decimals (contract: server rounds to 3 decimals).
function countUnrounded(obj) {
  let n = 0;
  const walk = (v) => {
    if (typeof v === 'number') {
      if (Number.isFinite(v) && Math.abs(v * 1000 - Math.round(v * 1000)) > 1e-6) n++;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const k in v) walk(v[k]);
  };
  walk(obj);
  return n;
}

// Validate a `snap` message against the contract. Returns { errors: [], warnings: [] }.
export function validateSnapshot(m) {
  const errors = [];
  const warnings = [];
  const E = (s) => errors.push(s);
  const W = (s) => warnings.push(s);
  if (!num(m.time)) E('snap.time missing / not a number');
  if (!int(m.tick)) E('snap.tick missing / not an integer');
  if (!PHASES.has(m.ph)) E(`snap.ph invalid (${JSON.stringify(m.ph)})`);
  if (!num(m.phT) || m.phT < 0) E(`snap.phT invalid (${JSON.stringify(m.phT)})`);
  if (!int(m.per) || m.per < 1) E(`snap.per invalid (${JSON.stringify(m.per)})`);
  if (!num(m.clk) || m.clk < 0) E(`snap.clk invalid (${JSON.stringify(m.clk)})`);
  if (!Array.isArray(m.sc) || m.sc.length !== 2 || !m.sc.every((v) => int(v) && v >= 0)) E(`snap.sc invalid (${JSON.stringify(m.sc)})`);
  if (!Array.isArray(m.teams) || m.teams.length !== 2 || !m.teams.every((v) => int(v) && v >= 0 && v < TEAMS.length)) E(`snap.teams invalid (${JSON.stringify(m.teams)})`);
  if (!Array.isArray(m.ev)) E('snap.ev missing / not an array');
  if (!Array.isArray(m.gl) || !m.gl.every((v) => int(v) && v >= 0 && v < GLASS_PANELS)) E(`snap.gl invalid (${JSON.stringify(m.gl)})`);
  if (!Array.isArray(m.p) || m.p.length !== 2 * TEAM_SIZE) {
    E(`snap.p must have 8 entries (got ${Array.isArray(m.p) ? m.p.length : typeof m.p})`);
  } else {
    m.p.forEach((p, i) => {
      if (!p || typeof p !== 'object') { E(`snap.p[${i}] not an object`); return; }
      if (p.id !== i) E(`snap.p[${i}].id = ${p.id} (index must equal id)`);
      if (p.tm !== Math.floor(i / TEAM_SIZE)) E(`snap.p[${i}].tm = ${p.tm} (expected ${Math.floor(i / TEAM_SIZE)})`);
      if (!flag(p.g) || truthy(p.g) !== (i % TEAM_SIZE === GOALIE_K)) E(`snap.p[${i}].g = ${JSON.stringify(p.g)}`);
      for (const k of ['x', 'y', 'z', 'vx', 'vz', 'f', 'sT', 'tb', 'ch']) {
        if (!num(p[k])) E(`snap.p[${i}].${k} missing / not a number (${JSON.stringify(p[k])})`);
      }
      if (!PSTATES.has(p.s)) E(`snap.p[${i}].s invalid (${JSON.stringify(p.s)})`);
      if (!flag(p.fire)) E(`snap.p[${i}].fire invalid (${JSON.stringify(p.fire)})`);
      if (!int(p.c) || p.c < 0) E(`snap.p[${i}].c invalid (${JSON.stringify(p.c)})`);
      if (!int(p.n)) E(`snap.p[${i}].n invalid (${JSON.stringify(p.n)})`);
      if (num(p.tb) && (p.tb < -0.001 || p.tb > 1.001)) W(`snap.p[${i}].tb out of 0..1 (${p.tb})`);
      if (num(p.ch) && (p.ch < -0.001 || p.ch > 1.001)) W(`snap.p[${i}].ch out of 0..1 (${p.ch})`);
      if (num(p.ch) && p.ch > 0 && p.s !== PSTATE.CHARGE) W(`snap.p[${i}].ch > 0 while s != CHARGE`);
      if (num(p.y) && p.y < -0.01) W(`snap.p[${i}].y below the ice (${p.y})`);
      if (num(p.x) && num(p.z) && (Math.abs(p.x) > RINK.halfLength + 1 || Math.abs(p.z) > RINK.halfWidth + 1)) {
        W(`snap.p[${i}] outside the rink (${p.x}, ${p.z})`);
      }
      if (truthy(p.g) && p.c !== 0) E(`snap.p[${i}] goalie controlled by client ${p.c} (goalies are always AI)`);
    });
    const ctl = m.p.filter((p) => p && p.c > 0).map((p) => p.c);
    if (new Set(ctl).size !== ctl.length) E(`snap.p: a client controls more than one skater (${ctl.join(',')})`);
  }
  const k = m.k;
  if (!k || typeof k !== 'object') E('snap.k missing');
  else {
    for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz']) if (!num(k[key])) E(`snap.k.${key} missing / not a number`);
    if (!int(k.o) || k.o < -1 || k.o >= 2 * TEAM_SIZE) E(`snap.k.o invalid (${JSON.stringify(k.o)})`);
    if (num(k.x) && num(k.z) && (Math.abs(k.x) > RINK.halfLength + 2 || Math.abs(k.z) > RINK.halfWidth + 2)) {
      W(`snap.k puck outside the rink (${k.x}, ${k.z})`);
    }
  }
  return { errors, warnings };
}

function validateLobby(m) {
  const errors = [];
  if (m.state !== 'lobby' && m.state !== 'game') errors.push(`lobby.state invalid (${JSON.stringify(m.state)})`);
  if (!int(m.host)) errors.push(`lobby.host invalid (${JSON.stringify(m.host)})`);
  if (!Array.isArray(m.clients)) errors.push('lobby.clients not an array');
  else {
    for (const c of m.clients) {
      if (!c || !int(c.id) || c.id <= 0) errors.push(`lobby.clients entry with bad id (${JSON.stringify(c)})`);
      else {
        if (typeof c.name !== 'string') errors.push(`lobby.clients[${c.id}].name not a string`);
        if (![-1, 0, 1].includes(c.team)) errors.push(`lobby.clients[${c.id}].team invalid (${JSON.stringify(c.team)})`);
        if (!num(c.ping) && c.ping !== null && c.ping !== undefined) errors.push(`lobby.clients[${c.id}].ping invalid`);
      }
    }
  }
  if (!m.config || typeof m.config !== 'object') errors.push('lobby.config missing');
  return errors;
}

// ---------------------------------------------------------------- the bot

export class Bot {
  constructor(index, opts, swarm) {
    this.index = index;
    this.opts = opts;
    this.swarm = swarm;
    this.name = `${opts.name}${index + 1}`.slice(0, 16);
    this.wantTeam = opts.team != null ? opts.team : (opts.teamStart + index) % 2;
    this.rand = rng(opts.seed + index * 7919);
    this.id = 0;
    this.room = null;
    this.ws = null;
    this.stopping = false;
    this.closed = false;
    this.lobby = null;
    this.snap = null;
    this.hostSentAt = -1e9;
    this.seq = 0;
    this.frame = 0;
    this.nextSend = 0;
    this.hold = {};               // bit -> frame index until which it is held
    this.lastRelease = {};        // bit -> frame index of the last release
    this.laneZ = 0;
    this.myPlayer = -1;
    this.lastSnapTick = -1;
    this.lastSnapTime = -Infinity;
    this.gameEpoch = 0;
    // stats
    this.t0 = 0;
    this.welcomeAt = 0;
    this.errors = [];
    this.errorCount = 0;
    this.warnings = new Map();
    this.events = {};
    this.phasesSeen = new Set();
    this.rxBytes = 0;
    this.txBytes = 0;
    this.rxMsgs = {};
    this.inSent = 0;
    this.inFirst = 0;
    this.inLast = 0;
    this.snapCount = 0;
    this.gaps = [];
    this.srvGaps = [];
    this.lastSrvTime = null;
    this.prevSrvTime = null;
    this.stalls = [];
    this.seg = null;
    this.segs = [];
    this.rtts = [];
    this.pingsSent = 0;
    this.maxScore = [0, 0];
    this.controlledTicks = 0;
    this.unassignedSnaps = 0;
    this.switches = 0;
    this.unrounded = 0;
    this.snapBytesMax = 0;
    this.snapBytesSum = 0;
  }

  error(msg) {
    this.errorCount++;
    if (this.errors.length < MAX_STORED_ERRORS) this.errors.push(msg);
    this.swarm.log(`[${this.name}] ERROR ${msg}`, true);
  }
  warn(msg) { this.warnings.set(msg, (this.warnings.get(msg) || 0) + 1); }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    const s = JSON.stringify(obj);
    this.txBytes += Buffer.byteLength(s);
    this.ws.send(s);
    return true;
  }

  connect() {
    return new Promise((resolve) => {
      this.t0 = performance.now();
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
      const timer = setTimeout(() => { this.error('no welcome within 10 s'); done(false); }, 10000);
      this.onWelcome = () => done(true);
      let ws;
      try {
        ws = new WebSocket(this.opts.url);
      } catch (e) {
        this.error(`WebSocket constructor failed: ${e.message}`);
        done(false);
        return;
      }
      this.ws = ws;
      ws.addEventListener('open', () => {
        this.send({ t: 'hello', name: this.name, room: this.opts.room });
      });
      ws.addEventListener('message', (ev) => this.onMessage(ev.data));
      ws.addEventListener('error', (ev) => {
        if (!this.stopping) this.error(`socket error: ${ev.message || ev.error?.message || 'unknown'}`);
        done(false);
      });
      ws.addEventListener('close', (ev) => {
        this.closed = true;
        this.closeSegment();
        if (!this.stopping) this.error(`socket closed by server (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ''})`);
        done(false);
        if (this.onClosed) this.onClosed();
      });
    });
  }

  close() {
    this.stopping = true;
    this.closeSegment();
    return new Promise((resolve) => {
      if (!this.ws || this.closed || this.ws.readyState >= 2) { resolve(); return; }
      const timer = setTimeout(resolve, 2000);
      this.onClosed = () => { clearTimeout(timer); resolve(); };
      try { this.ws.close(1000, 'bot done'); } catch { clearTimeout(timer); resolve(); }
    });
  }

  closeSegment() {
    if (this.seg) { this.segs.push(this.seg); this.seg = null; }
  }

  onMessage(raw) {
    const now = performance.now();
    if (typeof raw !== 'string') { this.error('received a binary frame (protocol is JSON text frames)'); return; }
    const bytes = Buffer.byteLength(raw);
    this.rxBytes += bytes;
    if (this.seg) this.seg.bytes += bytes;
    let m;
    try { m = JSON.parse(raw); } catch { this.error(`invalid JSON frame: ${raw.slice(0, 80)}`); return; }
    if (!m || typeof m !== 'object' || !SERVER_MSGS.has(m.t)) { this.error(`unknown server message t=${JSON.stringify(m && m.t)}`); return; }
    this.rxMsgs[m.t] = (this.rxMsgs[m.t] || 0) + 1;
    if (m.t !== 'welcome' && !this.id) this.warn(`'${m.t}' received before 'welcome'`);
    switch (m.t) {
      case 'welcome': return this.onWelcomeMsg(m, now);
      case 'lobby': return this.onLobby(m, now);
      case 'snap': return this.onSnap(m, now, bytes);
      case 'pong': return this.onPong(m, now);
      case 'err': return this.error(`server err: ${m.msg}`);
    }
  }

  onWelcomeMsg(m, now) {
    if (this.id) { this.error('second welcome received'); return; }
    if (!int(m.id) || m.id <= 0) { this.error(`welcome.id invalid (${JSON.stringify(m.id)})`); return; }
    if (typeof m.room !== 'string') this.warn('welcome.room missing');
    else if (m.room !== this.opts.room) this.warn(`welcome.room = ${m.room} (asked for ${this.opts.room})`);
    this.id = m.id;
    this.room = m.room;
    this.welcomeAt = now;
    this.send({ t: 'pick', team: this.wantTeam });
    if (this.onWelcome) this.onWelcome();
  }

  onLobby(m, now) {
    for (const e of validateLobby(m)) this.error(e);
    const prev = this.lobby;
    this.lobby = m;
    if (m.state === 'lobby') {
      this.closeSegment();
      if (prev && prev.state === 'game') { this.gameEpoch++; this.lastSnapTick = -1; this.lastSrvTime = null; }
    }
    if (Array.isArray(m.clients) && this.id) {
      const me = m.clients.find((c) => c && c.id === this.id);
      if (!me) this.warn('not listed in lobby.clients');
    }
    this.maybeHost(now);
  }

  // Host duty (only with --start): config + start once all bots have joined.
  maybeHost(now) {
    if (!this.opts.start || !this.lobby || this.lobby.state !== 'lobby') return;
    if (this.lobby.host !== this.id) return;
    if (now - this.hostSentAt < 5000) return;
    const listed = new Set((this.lobby.clients || []).map((c) => c.id));
    const allIn = this.swarm.bots.every((b) => b.id && listed.has(b.id));
    if (!allIn && now - this.welcomeAt < 4000) {
      clearTimeout(this.hostTimer);
      this.hostTimer = setTimeout(() => this.maybeHost(performance.now()), 500);
      return;
    }
    this.hostSentAt = now;
    const [h, a] = this.opts.teams;
    this.send({ t: 'config', teams: [h, a], periodLength: this.opts.period, difficulty: this.opts.difficulty });
    this.send({ t: 'start' });
    this.swarm.log(`[${this.name}] host: sent config (teams ${h},${a}, period ${this.opts.period}s, difficulty ${this.opts.difficulty}) + start`);
  }

  onSnap(m, now, bytes) {
    const v = validateSnapshot(m);
    for (const e of v.errors) this.error(e);
    for (const w of v.warnings) this.warn(w);
    if (v.errors.length) return;
    const un = countUnrounded(m);
    if (un) { this.unrounded += un; this.warn('snap contains numbers with > 3 decimals'); }
    if (this.lobby && this.lobby.state === 'lobby') this.warn("snap received while lobby.state == 'lobby'");
    this.snapCount++;
    this.snapBytesSum += bytes;
    if (bytes > this.snapBytesMax) this.snapBytesMax = bytes;
    // tick / time monotonic within one game
    if (this.lastSnapTick >= 0 && m.tick <= this.lastSnapTick) {
      if (m.tick < 10) this.warn('tick reset without a lobby message (new game?)');
      else this.error(`snap.tick not increasing (${this.lastSnapTick} -> ${m.tick})`);
    }
    this.lastSnapTick = m.tick;
    if (this.lastSrvTime !== null) {
      if (m.time < this.lastSrvTime) this.error(`snap.time went backwards (${this.lastSrvTime} -> ${m.time})`);
      else this.srvGaps.push(m.time - this.lastSrvTime);
    }
    this.prevSrvTime = this.lastSrvTime;
    this.lastSrvTime = m.time;
    // receive-side timing
    if (!this.seg) this.seg = { first: now, last: now, n: 1, bytes };
    else {
      const gap = now - this.seg.last;
      this.gaps.push(gap);
      if (gap > STALL_MS && this.stalls.length < 20) {
        // Was it the server (snap.time jumped too) or the network / this process?
        this.stalls.push({
          atSec: round((now - this.t0) / 1000, 2), gapMs: round(gap, 1),
          serverGapMs: this.prevSrvTime != null ? round(m.time - this.prevSrvTime, 1) : null,
          tick: m.tick, ph: PHASE_NAME[m.ph] || m.ph, events: m.ev.map(eventType),
        });
      }
      this.seg.last = now; this.seg.n++;
    }
    this.lastSnapTime = now;
    // bookkeeping
    this.phasesSeen.add(m.ph);
    for (const e of m.ev) {
      const ty = eventType(e);
      this.events[ty] = (this.events[ty] || 0) + 1;
      if (!EVENT_TYPES.has(ty)) this.warn(`unknown event type ${JSON.stringify(ty)} (${JSON.stringify(e).slice(0, 80)})`);
      if (ty === EVENT.SWITCH && e.client === this.id) this.switches++;
    }
    this.maxScore = [Math.max(this.maxScore[0], m.sc[0]), Math.max(this.maxScore[1], m.sc[1])];
    const mine = m.p.filter((p) => p.c === this.id);
    if (mine.length === 1) {
      this.myPlayer = mine[0].id;
      this.controlledTicks++;
      if (this.wantTeam >= 0 && mine[0].tm !== this.wantTeam) this.warn(`controlling a skater on team ${mine[0].tm}, picked ${this.wantTeam}`);
    } else {
      this.myPlayer = -1;
      if (this.wantTeam >= 0) this.unassignedSnaps++;
    }
    if (this.wantTeam < 0 && mine.length) this.error('spectator controls a skater');
    this.snap = m;
  }

  onPong(m, now) {
    if (!num(m.c)) { this.error(`pong.c invalid (${JSON.stringify(m.c)})`); return; }
    if (!num(m.s)) this.warn('pong.s missing / not a number');
    const rtt = now - m.c;
    if (rtt < 0 || rtt > 30000) this.warn(`implausible RTT ${rtt} ms`);
    else this.rtts.push(rtt);
  }

  get inGame() {
    return (this.lobby && this.lobby.state === 'game') || performance.now() - this.lastSnapTime < 500;
  }

  // Called by the swarm ticker (every few ms). Sends `in` at 60 Hz, `ping` at 1 Hz.
  tick(now) {
    if (!this.id || this.closed || this.stopping) return;
    if (now - (this.lastPing || 0) >= PING_EVERY_MS) {
      this.lastPing = now;
      this.pingsSent++;
      this.send({ t: 'ping', c: now });
    }
    if (this.wantTeam < 0 || !this.inGame) { this.nextSend = now; return; }
    if (now < this.nextSend) return;
    this.nextSend = now - this.nextSend > SEND_PERIOD * 3 ? now + SEND_PERIOD : this.nextSend + SEND_PERIOD;
    const inp = this.think();
    this.frame++;
    this.seq++;
    if (this.send({ t: 'in', seq: this.seq, mx: inp.mx, mz: inp.mz, b: inp.b })) {
      if (!this.inSent) this.inFirst = now;
      this.inLast = now;
      this.inSent++;
    }
  }

  // --- input helpers: press a button for `frames` frames (needs a released frame in between)
  press(bit, frames) {
    const f = this.frame;
    if ((this.hold[bit] || 0) > f) return false;
    if (f - (this.lastRelease[bit] ?? -10) < 2) return false;
    this.hold[bit] = f + frames;
    this.lastRelease[bit] = f + frames;
    return true;
  }
  held(bit) { return (this.hold[bit] || 0) > this.frame; }
  buttons() {
    let b = 0;
    for (const bit of [BTN.SHOOT, BTN.PASS, BTN.ACTION, BTN.TURBO]) if (this.held(bit)) b |= bit;
    return b;
  }

  // Plausible arcade play from the latest snapshot.
  think() {
    const s = this.snap;
    const r = this.rand;
    const zero = { mx: 0, mz: 0, b: 0 };
    if (!s) return zero;
    const me = s.p.find((p) => p.c === this.id);
    if (!me) return zero;
    const atk = me.tm === 0 ? 1 : -1;            // HOME attacks +X, AWAY attacks -X
    const goalX = atk * RINK.goalLineX;
    const k = s.k;
    const owner = k.o >= 0 ? s.p[k.o] : null;
    let tx = k.x, tz = k.z;
    if (this.frame % 90 === 0) this.laneZ = (r() - 0.5) * 8;

    if (s.ph !== PHASE.PLAY) {
      // faceoff / goal / intermission: drift toward the puck, no buttons
      return this.steer(me, k.x, k.z, 0, false);
    }

    const opponents = s.p.filter((p) => p.tm !== me.tm && !truthy(p.g));
    const nearestOpp = opponents.reduce((best, p) => {
      const d = hyp(p.x - me.x, p.z - me.z);
      return d < best.d ? { p, d } : best;
    }, { p: null, d: Infinity });

    if (owner && owner.id === me.id) {
      // carry the puck toward the slot, then shoot
      tx = goalX - atk * 6;
      tz = this.laneZ;
      const dGoal = hyp(goalX - me.x, me.z);
      if (dGoal < 13 && Math.sign(goalX - me.x) === atk) {
        tx = goalX; tz = (r() - 0.5) * 1.6;
        if (!this.held(BTN.SHOOT)) {
          if (r() < 0.3) this.press(BTN.SHOOT, 20 + Math.floor(r() * 30));   // charged slapshot
          else this.press(BTN.SHOOT, 2 + Math.floor(r() * 3));               // wrist shot
        }
      } else if (nearestOpp.d < 2.4 && r() < 0.04) {
        this.press(BTN.ACTION, 3);                                          // deke
      } else if (r() < 0.006) {
        this.press(BTN.PASS, 3);                                            // pass
      }
      if (me.tb > 0.4 && r() < 0.02) this.press(BTN.TURBO, 30 + Math.floor(r() * 40));
    } else if (owner && owner.tm === me.tm) {
      // a teammate has it: get open ahead of the carrier
      tx = owner.x + atk * 7;
      tz = -Math.sign(owner.z || 1) * (4 + r());
      if (r() < 0.001) this.press(BTN.PASS, 3);                            // switch control
    } else if (owner) {
      // opponent carries: chase with lead, then check / poke
      tx = owner.x + owner.vx * 0.3;
      tz = owner.z + owner.vz * 0.3;
      const d = hyp(owner.x - me.x, owner.z - me.z);
      if (d < 2.4) {
        if (r() < 0.06) {
          if (me.tb > 0.3 && r() < 0.5) this.press(BTN.TURBO, 12);          // big hit
          this.press(BTN.SHOOT, 3);                                          // body check
        } else if (r() < 0.04) this.press(BTN.ACTION, 3);                    // stick check
      }
    } else {
      // loose puck: chase it, leading its motion
      tx = k.x + k.vx * 0.25;
      tz = k.z + k.vz * 0.25;
      if (nearestOpp.p && nearestOpp.d < 1.8 && r() < 0.02) this.press(BTN.SHOOT, 3);
      if (r() < 0.002) this.press(BTN.PASS, 3);
    }
    const d = hyp(tx - me.x, tz - me.z);
    const wantTurbo = d > 9 && me.tb > 0.35 && r() < 0.5;
    return this.steer(me, tx, tz, this.buttons(), wantTurbo);
  }

  steer(me, tx, tz, b, turbo) {
    const dx = tx - me.x, dz = tz - me.z;
    const d = hyp(dx, dz);
    let mx = 0, mz = 0;
    if (d > 0.35) { mx = dx / d; mz = dz / d; }
    mx = Math.max(-1, Math.min(1, mx + (this.rand() - 0.5) * 0.1));
    mz = Math.max(-1, Math.min(1, mz + (this.rand() - 0.5) * 0.1));
    if (turbo) b |= BTN.TURBO;
    return { mx: round(mx, 3), mz: round(mz, 3), b };
  }

  stats() {
    const segs = this.seg ? [...this.segs, this.seg] : this.segs;
    let n = 0, dur = 0, bytes = 0;
    for (const s of segs) { n += s.n - 1; dur += (s.last - s.first) / 1000; bytes += s.bytes; }
    const snapsPerSec = dur > 0 ? n / dur : 0;
    const inDur = (this.inLast - this.inFirst) / 1000;
    const totalDur = (performance.now() - this.t0) / 1000;
    return {
      name: this.name,
      id: this.id,
      team: this.wantTeam,
      player: this.myPlayer,
      snaps: this.snapCount,
      gameSeconds: round(dur, 2),
      snapsPerSec: round(snapsPerSec, 2),
      gapMeanMs: round(mean(this.gaps), 2),
      gapP95Ms: round(pct(this.gaps, 0.95), 2),
      gapMaxMs: round(this.gaps.length ? Math.max(...this.gaps) : 0, 2),
      serverGapMeanMs: round(mean(this.srvGaps), 2),
      serverGapP95Ms: round(pct(this.srvGaps, 0.95), 2),
      serverGapMaxMs: round(this.srvGaps.length ? Math.max(...this.srvGaps) : 0, 2),
      stalls: [...this.stalls],
      rxBytesPerSecInGame: Math.round(dur > 0 ? bytes / dur : 0),
      rxBytesPerSecTotal: Math.round(totalDur > 0 ? this.rxBytes / totalDur : 0),
      txBytesPerSec: Math.round(totalDur > 0 ? this.txBytes / totalDur : 0),
      snapBytesMean: Math.round(this.snapCount ? this.snapBytesSum / this.snapCount : 0),
      snapBytesMax: this.snapBytesMax,
      rttMeanMs: round(mean(this.rtts), 2),
      rttP95Ms: round(pct(this.rtts, 0.95), 2),
      rttMaxMs: round(this.rtts.length ? Math.max(...this.rtts) : 0, 2),
      pings: this.pingsSent,
      pongs: this.rtts.length,
      inSent: this.inSent,
      inPerSec: round(inDur > 0 ? (this.inSent - 1) / inDur : 0, 1),
      controlledSnaps: this.controlledTicks,
      unassignedSnaps: this.unassignedSnaps,
      switches: this.switches,
      events: { ...this.events },
      phasesSeen: [...this.phasesSeen].sort().map((p) => PHASE_NAME[p] || p),
      maxScore: this.maxScore,
      rxMsgs: { ...this.rxMsgs },
      errorCount: this.errorCount,
      errors: [...this.errors],
      warnings: Object.fromEntries(this.warnings),
    };
  }
}

// ---------------------------------------------------------------- the swarm

export function startBots(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const logFn = opts.log || ((line) => console.log(line));
  const swarm = {
    opts,
    bots: [],
    log: (line, important = false) => { if (!opts.quiet || important) logFn(line); },
  };
  let stopResolve;
  const stopped = new Promise((r) => { stopResolve = r; });
  swarm.stop = () => stopResolve();

  swarm.done = (async () => {
    const tStart = performance.now();
    for (let i = 0; i < opts.bots; i++) swarm.bots.push(new Bot(i, opts, swarm));
    const ticker = setInterval(() => {
      const now = performance.now();
      for (const b of swarm.bots) b.tick(now);
    }, 2);
    const connects = [];
    for (const b of swarm.bots) {
      connects.push(b.connect());
      if (opts.stagger > 0) await new Promise((r) => setTimeout(r, opts.stagger));
    }
    const ok = await Promise.all(connects);
    swarm.log(`${ok.filter(Boolean).length}/${opts.bots} bots welcomed: ` +
      swarm.bots.map((b) => `${b.name}#${b.id || '?'}->team ${b.wantTeam}`).join(', '));
    const progress = setInterval(() => {
      const b0 = swarm.bots[0];
      const s = b0 && b0.snap;
      const st = b0 && b0.stats();
      swarm.log(`  t=${round((performance.now() - tStart) / 1000, 0)}s lobby=${b0?.lobby?.state ?? '-'} ` +
        (s ? `ph=${PHASE_NAME[s.ph]} per=${s.per} clk=${round(s.clk, 0)} score=${s.sc.join('-')} ` : 'no snaps yet ') +
        (st ? `snaps/s=${st.snapsPerSec} rtt=${st.rttMeanMs}ms` : ''));
    }, 5000);
    await Promise.race([stopped, new Promise((r) => setTimeout(r, opts.seconds * 1000))]);
    clearInterval(progress);
    clearInterval(ticker);
    for (const b of swarm.bots) clearTimeout(b.hostTimer);
    await Promise.all(swarm.bots.map((b) => b.close()));
    return summarize(swarm.bots, opts, (performance.now() - tStart) / 1000);
  })();
  return swarm;
}

export function runBots(options = {}) { return startBots(options).done; }

function summarize(bots, opts, seconds) {
  const stats = bots.map((b) => b.stats());
  const problems = [];
  for (const s of stats) {
    if (s.errorCount) problems.push(`${s.name}: ${s.errorCount} protocol error(s), first: ${s.errors[0]}`);
    if (s.snapsPerSec < opts.minRate) problems.push(`${s.name}: snaps/s ${s.snapsPerSec} < ${opts.minRate}${s.snaps ? '' : ' (no snaps received - did a game start?)'}`);
  }
  const evTypes = [...new Set(stats.flatMap((s) => Object.keys(s.events)))].sort();
  const events = Object.fromEntries(evTypes.map((t) => {
    const counts = stats.map((s) => s.events[t] || 0);
    return [t, { min: Math.min(...counts), max: Math.max(...counts) }];
  }));
  const agg = (k) => round(mean(stats.map((s) => s[k])), 2);
  return {
    ok: problems.length === 0,
    problems,
    url: opts.url,
    room: opts.room,
    seconds: round(seconds, 1),
    bots: stats,
    aggregate: {
      snapsPerSec: agg('snapsPerSec'),
      gapP95Ms: agg('gapP95Ms'),
      rxBytesPerSecInGame: Math.round(agg('rxBytesPerSecInGame')),
      rttMeanMs: agg('rttMeanMs'),
      rttP95Ms: agg('rttP95Ms'),
      inPerSec: agg('inPerSec'),
    },
    events,
  };
}

export function formatSummary(res) {
  const cols = [
    ['bot', (s) => s.name], ['id', (s) => s.id], ['team', (s) => s.team], ['pl', (s) => s.player],
    ['snaps', (s) => s.snaps], ['snaps/s', (s) => s.snapsPerSec],
    ['gap ms mean/p95/max', (s) => `${s.gapMeanMs}/${s.gapP95Ms}/${s.gapMaxMs}`],
    ['srv gap p95/max', (s) => `${s.serverGapP95Ms}/${s.serverGapMaxMs}`],
    ['KB/s rx', (s) => round(s.rxBytesPerSecInGame / 1024, 1)],
    ['snap B', (s) => s.snapBytesMean],
    ['RTT ms mean/p95/max', (s) => `${s.rttMeanMs}/${s.rttP95Ms}/${s.rttMaxMs}`],
    ['in/s', (s) => s.inPerSec], ['errs', (s) => s.errorCount], ['warns', (s) => Object.keys(s.warnings).length],
  ];
  const rows = [cols.map((c) => c[0]), ...res.bots.map((s) => cols.map((c) => String(c[1](s))))];
  const w = cols.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = rows.map((r) => r.map((v, i) => v.padStart(w[i])).join('  '));
  lines.splice(1, 0, w.map((n) => '-'.repeat(n)).join('  '));
  const out = [];
  out.push(`ICE RIOT bots - ${res.url} room=${res.room} ${res.seconds}s`);
  out.push(...lines);
  const a = res.aggregate;
  out.push(`mean: snaps/s ${a.snapsPerSec}, gap p95 ${a.gapP95Ms} ms, rx ${round(a.rxBytesPerSecInGame / 1024, 1)} KB/s per client, RTT ${a.rttMeanMs} ms (p95 ${a.rttP95Ms}), in ${a.inPerSec}/s`);
  const ev = Object.entries(res.events).map(([t, c]) => `${t}=${c.min === c.max ? c.max : `${c.min}..${c.max}`}`);
  out.push(`events seen (min..max across bots): ${ev.length ? ev.join(' ') : 'none'}`);
  const b0 = res.bots[0];
  if (b0) out.push(`phases seen: ${b0.phasesSeen.join(', ') || 'none'}; max score ${b0.maxScore.join('-')}`);
  if (b0 && b0.stalls.length) {
    out.push(`stalls > ${STALL_MS} ms seen by ${b0.name} (serverGap ~= gap means the server loop stalled; ~33 means network / bot process):`);
    for (const st of b0.stalls) out.push(`  t=${st.atSec}s gap ${st.gapMs} ms, server gap ${st.serverGapMs} ms, tick ${st.tick}, ${st.ph}, events [${st.events.join(',')}]`);
  }
  for (const s of res.bots) {
    for (const [w2, n] of Object.entries(s.warnings)) out.push(`  warn ${s.name}: ${w2}${n > 1 ? ` (x${n})` : ''}`);
    for (const e of s.errors) out.push(`  ERR  ${s.name}: ${e}`);
  }
  out.push(res.ok ? 'RESULT: PASS' : `RESULT: FAIL\n  - ${res.problems.join('\n  - ')}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    const n = () => {
      const v = Number(val());
      if (!Number.isFinite(v)) throw new Error(`${a} expects a number`);
      return v;
    };
    switch (a) {
      case '--url': o.url = val(); break;
      case '--bots': o.bots = n(); break;
      case '--room': o.room = val(); break;
      case '--seconds': o.seconds = n(); break;
      case '--start': o.start = true; break;
      case '--period': o.period = n(); break;
      case '--difficulty': o.difficulty = n(); break;
      case '--teams': o.teams = val().split(',').map(Number); break;
      case '--team-start': o.teamStart = n(); break;
      case '--team': o.team = n(); break;
      case '--name': o.name = val(); break;
      case '--min-rate': o.minRate = n(); break;
      case '--stagger': o.stagger = n(); break;
      case '--json': o.json = val(); break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (o.help) {
    console.log('usage: node test/bots.js [--url ws://host:port/ws] [--bots N] [--room main] [--seconds 60] [--start]\n' +
      '       [--period 60] [--difficulty 1] [--teams 0,1] [--team-start 0] [--team T] [--name Bot]\n' +
      '       [--min-rate 25] [--stagger ms] [--json out.json] [--quiet]');
    return;
  }
  if (typeof WebSocket !== 'function') {
    console.error('global WebSocket not available - need Node >= 22');
    process.exit(2);
  }
  const swarm = startBots(o);
  process.once('SIGINT', () => { console.log('\nSIGINT - stopping bots...'); swarm.stop(); });
  const res = await swarm.done;
  console.log(formatSummary(res));
  if (o.json) {
    writeFileSync(o.json, JSON.stringify(res, null, 2));
    console.log(`results written to ${o.json}`);
  }
  process.exitCode = res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
