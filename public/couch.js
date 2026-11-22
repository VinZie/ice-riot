// ICE RIOT - couch co-op: extra gamepads on this PC join as their own network clients.
//
// The main player (keyboard / the first gamepad) goes through input.js + net.js as usual. Every
// ADDITIONAL gamepad (index >= reservePads) can join by pressing START or A: it opens its OWN
// WebSocket to the server, says hello as "<namePrefix> P<n>", picks a team and then streams `in`
// messages from that pad. The server treats it exactly like a remote player.
//
// Pad controls (standard mapping):
//   START or A (not joined)      join. Team: LB held = home, RB held = away, otherwise the side with
//                                fewer humans (latest lobby message + other couch pads; tie = home).
//   LB / RB (joined, in lobby)   switch to home / away.
//   SELECT/BACK held 1 s         leave (socket closed). Unplugging the pad also leaves.
//   in game: same mapping as input.js - left stick (radial deadzone 0.2) / d-pad move in world
//            space (screen up = -mz), A = SHOOT, X = PASS, B = ACTION, RB / RT / LT = TURBO.
//            Buttons already held at the moment of joining are ignored until released.
//
// Input is only sent while that socket's latest lobby message says state 'game', at <= 60 Hz.
// update() is allocation-free apart from the JSON string of an outgoing `in` message.

import { BTN, MAX_HUMANS_PER_TEAM } from '../shared/constants.js';

export const PAD = Object.freeze({
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  SELECT: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
});
export const DEADZONE = 0.2;              // same as input.js
export const BUTTON_THRESHOLD = 0.35;     // analog value that counts as pressed (input.js)
export const LEAVE_HOLD_MS = 1000;
export const SEND_INTERVAL_MS = 1000 / 60;
export const AUTO_PICK_FALLBACK_MS = 1000; // no lobby message after welcome -> pick with what we know
const MAX_BUTTONS = 31;                    // raw buttons are kept as a 31-bit mask
const MAX_NAME = 16;
const MAX_BUFFERED = 65536;

const B_A = 1 << PAD.A, B_B = 1 << PAD.B, B_X = 1 << PAD.X;
const B_LB = 1 << PAD.LB, B_RB = 1 << PAD.RB, B_LT = 1 << PAD.LT, B_RT = 1 << PAD.RT;
const B_SELECT = 1 << PAD.SELECT, B_START = 1 << PAD.START;
const B_UP = 1 << PAD.UP, B_DOWN = 1 << PAD.DOWN, B_LEFT = 1 << PAD.LEFT, B_RIGHT = 1 << PAD.RIGHT;
const JOIN_MASK = B_START | B_A;
const TURBO_MASK = B_RB | B_RT | B_LT;

// Pressed-button bitmask (bit i = buttons[i]) of a Gamepad, same threshold as input.js.
export function readButtons(pad) {
  const bs = pad && pad.buttons;
  if (!bs) return 0;
  const n = bs.length < MAX_BUTTONS ? bs.length : MAX_BUTTONS;
  let raw = 0;
  for (let i = 0; i < n; i++) {
    const x = bs[i];
    if (!x) continue;
    const on = typeof x === 'object' ? (x.pressed || x.value > BUTTON_THRESHOLD) : x > BUTTON_THRESHOLD;
    if (on) raw |= 1 << i;
  }
  return raw;
}

const finite = (v) => (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : 0);

// Map a pad (+ its raw button mask from readButtons) to world-space input. Writes out.mx/mz/b.
export function mapPad(pad, raw, out) {
  const axes = pad && pad.axes;
  let ax = axes ? finite(axes[0]) : 0;
  let az = axes ? finite(axes[1]) : 0;   // stick down = +axis1 = +Z (screen down)
  const mag = Math.sqrt(ax * ax + az * az);
  if (mag < DEADZONE) { ax = 0; az = 0; }
  else {
    const s = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE));
    ax = (ax / mag) * s; az = (az / mag) * s;
  }
  if (raw & B_UP) az -= 1;
  if (raw & B_DOWN) az += 1;
  if (raw & B_LEFT) ax -= 1;
  if (raw & B_RIGHT) ax += 1;
  const len = Math.sqrt(ax * ax + az * az);
  if (len > 1) { ax /= len; az /= len; }
  let b = 0;
  if (raw & B_A) b |= BTN.SHOOT;
  if (raw & B_X) b |= BTN.PASS;
  if (raw & B_B) b |= BTN.ACTION;
  if (raw & TURBO_MASK) b |= BTN.TURBO;
  out.mx = ax; out.mz = az; out.b = b;
  return out;
}

function defaultWsUrl() {
  const loc = globalThis.location;
  if (!loc || !loc.host) return 'ws://localhost:8765/ws';
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

function makeSlot(pad) {
  return {
    pad,               // gamepad index
    padId: '',         // Gamepad.id at join (a different device on the same index = disconnect)
    joined: false,
    n: 0,              // player number used in the name
    name: '',
    ws: null,
    status: 'idle',    // 'idle' | 'connecting' | 'online' | 'reconnecting'
    everOnline: false,
    clientId: 0,
    team: -1,          // team confirmed by the latest lobby message (-1 = spectator / unknown)
    want: -1,          // team we asked for; re-picked after every reconnect
    auto: false,       // waiting to auto-balance (needs a lobby message)
    lobby: null,       // latest lobby message on this socket
    inGame: false,     // latest lobby state === 'game'
    welcomeAt: 0,
    attempt: 0,
    retryTimer: 0,
    seq: 0,
    nextSendAt: 0,
    latchB: 0,         // buttons seen since the last sent `in` (quick taps are never lost)
    prevRaw: 0,
    suppress: 0,       // raw buttons held at join time, ignored until released
    selectSince: -1,
    mx: 0, mz: 0, b: 0,
  };
}

export function createCouch({ wsUrl, room = 'main', reservePads = 1, namePrefix = 'Couch', onChange = () => {} } = {}) {
  const url = wsUrl || defaultWsUrl();
  const reserve = Math.max(0, reservePads | 0);
  const prefix = namePrefix == null ? 'Couch' : String(namePrefix);
  const notify = typeof onChange === 'function' ? onChange : () => {};
  const slots = [];                  // by gamepad index (created lazily, once per index)
  const ids = new Set();             // live set of couch clientIds (updated in place)
  let listOut = Object.freeze([]);   // rebuilt on change only, so list() is allocation-free
  let lastLobby = null;              // latest lobby message from any couch socket
  let paused = false;
  let disposed = false;
  const inMsg = { t: 'in', seq: 0, mx: 0, mz: 0, b: 0 };   // reused for every input message
  const now = () => performance.now();

  function changed(err) {
    const out = [];
    ids.clear();
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s || !s.joined) continue;
      out.push(Object.freeze({ pad: s.pad, clientId: s.clientId, name: s.name, team: s.team, connected: s.status === 'online' }));
      if (s.clientId) ids.add(s.clientId);
    }
    listOut = Object.freeze(out);
    if (disposed) return;
    try { notify(listOut, err); } catch (e) { console.error(e); }
  }

  function sendJson(s, msg) {
    const ws = s.ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  function isCouchId(id) {
    if (!id) return false;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s && s.joined && s.clientId === id) return true;
    }
    return false;
  }

  function playerNumber() {
    for (let n = reserve + 1; ; n++) {
      let used = false;
      for (let i = 0; i < slots.length; i++) if (slots[i] && slots[i].joined && slots[i].n === n) { used = true; break; }
      if (!used) return n;
    }
  }

  function makeName(n) {
    const suffix = ` P${n}`;
    return prefix.slice(0, Math.max(0, MAX_NAME - suffix.length)) + suffix;
  }

  // Side with fewer humans: non-couch humans from the lobby + every other couch pad (by the team
  // it asked for, so pads joining in the same frame still split up). Tie = home; both full = spectate.
  function resolveAuto(s) {
    const L = s.lobby || lastLobby;
    let home = 0, away = 0;
    const cl = L && Array.isArray(L.clients) ? L.clients : null;
    if (cl) {
      for (let i = 0; i < cl.length; i++) {
        const c = cl[i];
        if (!c || c.id === s.clientId || isCouchId(c.id)) continue;
        if (c.team === 0) home++; else if (c.team === 1) away++;
      }
    }
    for (let i = 0; i < slots.length; i++) {
      const o = slots[i];
      if (!o || o === s || !o.joined) continue;
      const tm = o.want === 0 || o.want === 1 ? o.want : o.team;
      if (tm === 0) home++; else if (tm === 1) away++;
    }
    let team = away < home ? 1 : 0;
    if ((team === 0 ? home : away) >= MAX_HUMANS_PER_TEAM) team = -1;
    s.auto = false;
    s.want = team;
    sendJson(s, { t: 'pick', team });
  }

  function onMessage(s, data) {
    if (typeof data !== 'string') return;
    // Couch sockets get every snapshot too; skip them without parsing.
    if (data.startsWith('{"t":"snap"') || data.startsWith('{"t":"pong"')) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'welcome': {
        const id = Number(m.id);
        if (!(id > 0)) return;
        s.clientId = id;
        s.status = 'online';
        s.everOnline = true;
        s.attempt = 0;
        s.welcomeAt = now();
        if (s.want === 0 || s.want === 1) sendJson(s, { t: 'pick', team: s.want });
        else if (s.auto && s.lobby) resolveAuto(s);
        changed();
        break;
      }
      case 'lobby': {
        lastLobby = m;
        s.lobby = m;
        s.inGame = m.state === 'game';
        let team = -1;
        const cl = Array.isArray(m.clients) ? m.clients : null;
        if (cl && s.clientId) {
          for (let i = 0; i < cl.length; i++) {
            const c = cl[i];
            if (c && c.id === s.clientId) { team = c.team === 0 || c.team === 1 ? c.team : -1; break; }
          }
        }
        if (!s.auto && team >= 0) s.want = team;   // server truth wins (sticky across reconnects)
        if (s.auto && s.clientId) resolveAuto(s);
        if (team !== s.team) { s.team = team; changed(); }
        break;
      }
      case 'err':
        changed(`${s.name}: ${m.msg != null ? String(m.msg) : 'something went wrong'}`);
        break;
      default: break;
    }
  }

  function connect(s) {
    clearTimeout(s.retryTimer); s.retryTimer = 0;
    const WS = globalThis.WebSocket;
    if (typeof WS !== 'function') {
      leave(s);
      changed(`${s.name} can't connect: this browser has no WebSocket support`);
      return;
    }
    s.clientId = 0; s.team = -1; s.lobby = null; s.inGame = false;
    if (s.want !== 0 && s.want !== 1) s.auto = true;
    s.status = s.everOnline ? 'reconnecting' : 'connecting';
    let ws;
    try { ws = new WS(url); } catch { s.ws = null; scheduleReconnect(s); return; }
    s.ws = ws;
    ws.onopen = () => {
      if (s.ws !== ws) return;
      sendJson(s, { t: 'hello', name: s.name, room });
    };
    ws.onmessage = (e) => { if (s.ws === ws) onMessage(s, e.data); };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (s.ws !== ws) return;
      s.ws = null;
      const had = s.clientId;
      s.clientId = 0; s.team = -1; s.lobby = null; s.inGame = false;
      if (s.joined && !disposed) scheduleReconnect(s);
      if (had || s.status === 'online') { s.status = 'reconnecting'; changed(); }
      else s.status = s.everOnline ? 'reconnecting' : 'connecting';
    };
  }

  function scheduleReconnect(s) {
    s.attempt++;
    const delay = Math.min(8000, 400 * 2 ** Math.min(s.attempt - 1, 5)) * (0.8 + Math.random() * 0.4);
    clearTimeout(s.retryTimer);
    s.retryTimer = setTimeout(() => {
      s.retryTimer = 0;
      if (s.joined && !disposed && !s.ws) connect(s);
    }, delay);
  }

  function join(s, pad, raw, t) {
    s.n = 0;
    s.n = playerNumber();
    s.joined = true;
    s.padId = typeof pad.id === 'string' ? pad.id : '';
    s.name = makeName(s.n);
    s.want = raw & B_LB ? 0 : raw & B_RB ? 1 : -1;
    s.auto = s.want < 0;
    s.suppress = raw;
    s.selectSince = -1;
    s.attempt = 0;
    s.everOnline = false;
    s.latchB = 0;
    s.nextSendAt = t;
    connect(s);
    changed();
  }

  // Close the socket and forget the pad's membership. Returns true if it was joined.
  function leave(s) {
    if (!s.joined) return false;
    s.joined = false;
    s.auto = false;
    s.want = -1;
    clearTimeout(s.retryTimer); s.retryTimer = 0;
    const ws = s.ws;
    s.ws = null;
    s.clientId = 0; s.team = -1; s.lobby = null; s.inGame = false;
    s.status = 'idle';
    s.selectSince = -1;
    s.latchB = 0; s.mx = 0; s.mz = 0; s.b = 0;
    if (ws) { try { ws.close(1000, 'left'); } catch { /* ignore */ } }
    return true;
  }

  function sendInput(s, t) {
    if (t < s.nextSendAt - 1) return;   // <= 60 Hz (1 ms tolerance for rAF jitter)
    const ws = s.ws;
    if (ws.bufferedAmount > MAX_BUFFERED) return;
    s.nextSendAt = t - s.nextSendAt > SEND_INTERVAL_MS ? t + SEND_INTERVAL_MS : s.nextSendAt + SEND_INTERVAL_MS;
    inMsg.seq = ++s.seq;
    if (paused) { inMsg.mx = 0; inMsg.mz = 0; inMsg.b = 0; }
    else { inMsg.mx = round3(s.mx); inMsg.mz = round3(s.mz); inMsg.b = s.latchB; }
    s.latchB = 0;
    try { ws.send(JSON.stringify(inMsg)); } catch { /* socket closing */ }
  }

  function update() {
    if (disposed) return;
    const nav = globalThis.navigator;
    let pads = null;
    try { pads = nav && typeof nav.getGamepads === 'function' ? nav.getGamepads() : null; } catch { pads = null; }
    if (!pads) return;
    const count = pads.length | 0;
    const t = now();
    let dirty = false;

    // Joined pads that vanished (unplugged, or another device took the index) leave.
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s || !s.joined) continue;
      const p = i < count ? pads[i] : null;
      if (!p || !p.connected || (s.padId && p.id !== s.padId)) {
        s.prevRaw = 0;
        if (leave(s)) dirty = true;
      }
    }

    for (let i = reserve; i < count; i++) {
      const p = pads[i];
      let s = slots[i];
      if (!p || !p.connected) { if (s) s.prevRaw = 0; continue; }
      if (!s) s = slots[i] = makeSlot(i);
      const raw = readButtons(p);
      const pressed = raw & ~s.prevRaw;
      s.prevRaw = raw;

      if (!s.joined) {
        if (pressed & JOIN_MASK) join(s, p, raw, t);
        continue;
      }

      s.suppress &= raw;
      if (raw & B_SELECT) {
        if (s.selectSince < 0) s.selectSince = t;
        else if (t - s.selectSince >= LEAVE_HOLD_MS) { leave(s); dirty = true; continue; }
      } else s.selectSince = -1;

      if (s.clientId && !s.inGame) {
        const tm = pressed & B_LB ? 0 : pressed & B_RB ? 1 : -1;
        if (tm >= 0 && tm !== s.team) { s.want = tm; s.auto = false; sendJson(s, { t: 'pick', team: tm }); }
      }
      if (s.auto && s.clientId && t - s.welcomeAt >= AUTO_PICK_FALLBACK_MS) resolveAuto(s);

      mapPad(p, raw & ~s.suppress, s);
      if (s.inGame && s.clientId && s.ws && s.ws.readyState === 1) {
        s.latchB |= s.b;
        sendInput(s, t);
      } else {
        s.latchB = 0;
        s.nextSendAt = t;
      }
    }
    if (dirty) changed();
  }

  return {
    update,
    list() { return listOut; },
    clientIds() { return ids; },
    setPaused(on) {
      paused = !!on;
      if (paused) for (let i = 0; i < slots.length; i++) if (slots[i]) slots[i].latchB = 0;
    },
    // Debug / test-page view of one pad's internal state (allocates; not for the game loop).
    debug(padIndex) {
      const s = slots[padIndex];
      if (!s) return null;
      return {
        pad: s.pad, joined: s.joined, status: s.status, name: s.name, clientId: s.clientId,
        team: s.team, want: s.want, auto: s.auto, inGame: s.inGame, seq: s.seq,
        holdMs: s.selectSince >= 0 ? now() - s.selectSince : 0,
        mx: s.mx, mz: s.mz, b: s.b, paused, reserved: padIndex < reserve,
      };
    },
    get reservePads() { return reserve; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (let i = 0; i < slots.length; i++) if (slots[i]) leave(slots[i]);
      ids.clear();
      listOut = Object.freeze([]);
    },
  };
}
