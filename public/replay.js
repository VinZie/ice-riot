// ICE RIOT - instant goal replay.
//
// createReplay({ seconds, container }) keeps the last `seconds` of rendered (already interpolated)
// states in a fixed-size ring of preallocated typed arrays, plus the events released on each frame.
// After a goal, start() plays a window leading up to it: `speed` for the run-up, then a 0.35x
// slow-motion tail, optionally ending in an even slower finish (finishSec at finishSpeed, 0.15x: the
// puck going in). update(dt) returns a freshly interpolated Snapshot-shaped state (positions lerped,
// facings lerpAngle'd, discrete fields from the newer frame) and the recorded events whose time the
// playhead crossed, each exactly once per playback.
//
// record() never allocates: the ring is preallocated, states are copied field by field into typed
// arrays, and events are kept by reference. update() (only while a replay plays) allocates the fresh
// state it returns plus shallow `{...event, replay: true}` copies.
//
// Imports constants through a RELATIVE path so the same file loads in the browser (served at
// /replay.js -> /shared/constants.js) and in Node tests (public/../shared/constants.js).
// Nothing touches `document` at import time; the overlay is built lazily on the first start(), and
// skipped entirely when `container` is null (Node / headless).
//
// Overlay (design "Final · in game / Replay"): ground-colour letterbox bars, a top-left bug (red dot,
// "Replay", a "Slow-mo 0.35×" chip during the slow-motion tail, plus the tail camera's name, e.g.
// "Goal cam", when start({ tailLabel }) gives one), a caption plate naming the scorer
// when the replayed window ends on a goal, and a bottom progress line with a Skip glyph: the A button
// on a pad, the bound shoot key on keyboard and mouse, "Tap" on touch (setSkipHint({ device, label })).
// The caption comes from start({ caption }) when given ({ name, detail, team } or false), else it is
// built from the recorded GOAL event: nameOf(playerId, player) (createReplay option) names the
// scorer / assister, falling back to the roster names in TEAMS.

import { EVENT, TEAM_SIZE, TEAMS, lerp, lerpAngle } from '../shared/constants.js';

export const SLOWMO_SPEED = 0.35;      // playback rate of the slow-motion tail
export const FINISH_SPEED = 0.15;      // optional slower finish at the very end of the tail (start({ finishSec }))
export const STORE_HZ = 75;            // at most this many stored frames per second (decimates 120/144 Hz)
export const RESET_GAP_MS = 1000;      // a hole longer than this in the recording = discontinuity => start over
export const EVENT_CAPACITY = 512;     // events remembered (ring)
export const MAX_GLASS = 64;           // broken-glass indices stored per frame (the rink has 44 panels)
const MIN_FRAME_MS = 1000 / STORE_HZ;
const TELEPORT_DIST2 = 4 * 4;          // same as net.js TELEPORT_DIST: bigger jumps snap instead of lerp

// Per-frame top-level fields.
const TF = 4;  const T_TIME = 0, T_PHT = 1, T_CLK = 2, T_TICK = 3;                       // Float64
const TI = 10; const I_PH = 0, I_PER = 1, I_SC0 = 2, I_SC1 = 3, I_TM0 = 4, I_TM1 = 5,
  I_NP = 6, I_K = 7, I_KO = 8, I_GL = 9;                                                 // Int32
// Per-player fields.
const PF = 9;  const P_X = 0, P_Y = 1, P_Z = 2, P_VX = 3, P_VZ = 4, P_F = 5, P_ST = 6, P_TB = 7, P_CH = 8; // Float32
const PIN = 7;  const Q_ID = 0, Q_TM = 1, Q_G = 2, Q_S = 3, Q_FIRE = 4, Q_C = 5, Q_N = 6;  // Int32
// Puck.
const KF = 6;  const K_X = 0, K_Y = 1, K_Z = 2, K_VX = 3, K_VY = 4, K_VZ = 5;            // Float32

// Finite number, booleans as 1/0, anything else 0. (No allocation.)
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  return v === true ? 1 : 0;
}

// Same tolerant event-type lookup as net.js evType (events are {type: EVENT.*, ...}).
const evType = (e) => (e && (e.type ?? e.t ?? e.e ?? e.ev)) || '';
const defaultIsGoal = (e) => evType(e) === EVENT.GOAL;

// Roster name of player `id` given the TEAMS indices [home, away] of the match.
function rosterName(id, teams, tm) {
  const team = TEAMS[teams && teams[tm] != null ? teams[tm] : tm] || null;
  if (!team) return '';
  const k = ((id % TEAM_SIZE) + TEAM_SIZE) % TEAM_SIZE;
  const r = k < team.skaters.length ? team.skaters[k] : team.goalie;
  return (r && r.name) || '';
}

/**
 * Caption for a goal event: { name, detail, team } (team = TEAMS index of the scoring side), or null
 * when there is no scorer. `state` is the recorded state at the goal (teams + players), `nameOf`
 * an optional (playerId, player) => string that wins over the roster name (e.g. the human's name).
 */
export function goalCaption(ev, state, nameOf = null) {
  if (!ev || typeof ev !== 'object') return null;
  const scorer = Number.isInteger(ev.scorer) ? ev.scorer : -1;
  if (scorer < 0) return null;
  const teams = (state && state.teams) || [0, 1];
  const P = (state && state.p) || [];
  const who = (id) => {
    const p = P.find((q) => q && q.id === id) || P[id] || null;
    let n = null;
    if (typeof nameOf === 'function') { try { n = nameOf(id, p); } catch { n = null; } }
    if (typeof n === 'string' && n.trim()) return n.trim();
    return rosterName(id, teams, p ? p.tm : Math.floor(id / TEAM_SIZE));
  };
  const name = who(scorer);
  if (!name) return null;
  const assist = Number.isInteger(ev.assist) && ev.assist >= 0 && ev.assist !== scorer ? who(ev.assist) : '';
  let detail;
  if (ev.oneTimer) detail = assist ? `one-timer from ${assist}` : 'one-timer';
  else detail = assist ? `assist ${assist}` : 'unassisted';
  const side = ev.team === 0 || ev.team === 1 ? ev.team : Math.floor(scorer / TEAM_SIZE);
  const team = Number.isInteger(teams[side]) ? teams[side] : -1;
  return { name, detail, team };
}

export function createReplay({
  seconds = 5,
  container = (typeof document !== 'undefined' ? document.body : null),
  isGoal = defaultIsGoal,          // optional override: (event) => boolean
  maxPlayers = TEAM_SIZE * 2,      // snapshot `p` always has 8 entries
  nameOf = null,                   // optional (playerId, player) => display name for the caption
} = {}) {
  const SECS = Number.isFinite(seconds) && seconds > 0 ? seconds : 5;
  const MP = Math.max(1, maxPlayers | 0);
  const CAP = Math.ceil(SECS * STORE_HZ) + 8;   // >= SECS of coverage at any display refresh rate

  // ---- preallocated storage ------------------------------------------------------------------
  const frameT = new Float64Array(CAP);          // record clock (nowMs) per frame
  const fTop = new Float64Array(CAP * TF);
  const iTop = new Int32Array(CAP * TI);
  const pFlt = new Float32Array(CAP * MP * PF);
  const pInt = new Int32Array(CAP * MP * PIN);
  const kFlt = new Float32Array(CAP * KF);
  const glA = new Uint8Array(CAP * MAX_GLASS);
  const evRef = new Array(EVENT_CAPACITY).fill(null);
  const evT = new Float64Array(EVENT_CAPACITY);
  const BYTES = frameT.byteLength + fTop.byteLength + iTop.byteLength + pFlt.byteLength +
    pInt.byteLength + kFlt.byteLength + glA.byteLength + evT.byteLength + EVENT_CAPACITY * 8;

  let head = 0, count = 0;           // frame ring: next write slot, stored frames
  let evHead = 0, evCount = 0;       // event ring
  let goalMs = NaN;                  // record time of the most recent GOAL event
  let goalEv = null;                 // ...and the event itself (caption)
  let disposed = false;

  // ---- playback state ------------------------------------------------------------------------
  let playing = false, ended = false;
  let t0 = 0, t1 = 0, ts = 0, tf = 0; // window start, end, slow-mo tail start, finish start (record clock, ms)
  let spd = 0.6, slo = SLOWMO_SPEED, fsp = FINISH_SPEED;
  let wall = 0, wallNormal = 0, wallSlow = 0, wallTotal = 0;
  let evIdx = 0;                     // next logical event index to release

  let overlay = null, overlayTried = false;
  let caption = null;                // { name, detail, team } of the current / last playback
  let playGoal = null;               // { x, z, team } of the goal the current window ends on, else null
  let tailLabel = '';                // camera name shown in the slow-mo tail ("Goal cam"), '' = none
  let skipHint = { device: 'gamepad', label: 'A' }; // the "Skip" glyph (setSkipHint)

  const slotOf = (i) => (head - count + i + CAP) % CAP;           // logical frame i (0 = oldest)
  const evSlotOf = (i) => (evHead - evCount + i + EVENT_CAPACITY) % EVENT_CAPACITY;

  function clear() {
    head = 0; count = 0;
    evHead = 0; evCount = 0;
    goalMs = NaN; goalEv = null;
  }

  // ---- recording -----------------------------------------------------------------------------
  function writeFrame(s, st, now) {
    frameT[s] = now;
    const f = s * TF, i = s * TI;
    fTop[f + T_TIME] = typeof st.time === 'number' && Number.isFinite(st.time) ? st.time : now;
    fTop[f + T_PHT] = num(st.phT);
    fTop[f + T_CLK] = num(st.clk);
    fTop[f + T_TICK] = num(st.tick);
    iTop[i + I_PH] = num(st.ph);
    iTop[i + I_PER] = num(st.per);
    const sc = st.sc, tm = st.teams;
    iTop[i + I_SC0] = sc ? num(sc[0]) : 0;
    iTop[i + I_SC1] = sc ? num(sc[1]) : 0;
    iTop[i + I_TM0] = tm ? num(tm[0]) : 0;
    iTop[i + I_TM1] = tm ? num(tm[1]) : 0;

    const P = st.p;
    const np = P && P.length ? (P.length < MP ? P.length : MP) : 0;
    iTop[i + I_NP] = np;
    for (let j = 0; j < np; j++) {
      const pl = P[j];
      const pf = (s * MP + j) * PF, pi = (s * MP + j) * PIN;
      if (!pl) {
        for (let q = 0; q < PF; q++) pFlt[pf + q] = 0;
        for (let q = 0; q < PIN; q++) pInt[pi + q] = 0;
        pInt[pi + Q_ID] = j;
        continue;
      }
      pFlt[pf + P_X] = num(pl.x);
      pFlt[pf + P_Y] = num(pl.y);
      pFlt[pf + P_Z] = num(pl.z);
      pFlt[pf + P_VX] = num(pl.vx);
      pFlt[pf + P_VZ] = num(pl.vz);
      pFlt[pf + P_F] = num(pl.f);
      pFlt[pf + P_ST] = num(pl.sT);
      pFlt[pf + P_TB] = num(pl.tb);
      pFlt[pf + P_CH] = num(pl.ch);
      pInt[pi + Q_ID] = typeof pl.id === 'number' ? pl.id : j;
      pInt[pi + Q_TM] = num(pl.tm);
      pInt[pi + Q_G] = num(pl.g);
      pInt[pi + Q_S] = num(pl.s);
      pInt[pi + Q_FIRE] = num(pl.fire);
      pInt[pi + Q_C] = num(pl.c);
      pInt[pi + Q_N] = num(pl.n);
    }

    const k = st.k;
    if (k && typeof k === 'object') {
      const kf = s * KF;
      iTop[i + I_K] = 1;
      iTop[i + I_KO] = typeof k.o === 'number' ? k.o : -1;
      kFlt[kf + K_X] = num(k.x);
      kFlt[kf + K_Y] = num(k.y);
      kFlt[kf + K_Z] = num(k.z);
      kFlt[kf + K_VX] = num(k.vx);
      kFlt[kf + K_VY] = num(k.vy);
      kFlt[kf + K_VZ] = num(k.vz);
    } else {
      iTop[i + I_K] = 0;
      iTop[i + I_KO] = -1;
    }

    const G = st.gl;
    const ng = G && G.length ? (G.length < MAX_GLASS ? G.length : MAX_GLASS) : 0;
    iTop[i + I_GL] = ng;
    for (let j = 0; j < ng; j++) glA[s * MAX_GLASS + j] = num(G[j]);
  }

  function pushEvent(e, now) {
    if (!e || typeof e !== 'object') return;
    evRef[evHead] = e;
    evT[evHead] = now;
    evHead = (evHead + 1) % EVENT_CAPACITY;
    if (evCount < EVENT_CAPACITY) evCount++;
    if (isGoal(e)) { goalMs = now; goalEv = e; }
  }

  // Call every rendered frame with the live interpolated state. Ignored for null states (lobby)
  // and while a replay is playing (so the window being replayed is never overwritten).
  function record(state, events, nowMs) {
    if (disposed || playing || !state || typeof state !== 'object') return;
    let now = +nowMs;
    if (!Number.isFinite(now)) return;
    const nEv = events && typeof events.length === 'number' ? events.length : 0;

    let slot;
    if (count > 0) {
      const last = frameT[(head - 1 + CAP) % CAP];
      // Clock went backwards or a long hole (tab hidden, lobby, after a replay): start over.
      if (now < last - 1 || now - last > RESET_GAP_MS) clear();
    }
    if (count === 0) {
      slot = head;
    } else {
      const newest = (head - 1 + CAP) % CAP;
      const last = frameT[newest];
      if (now < last) now = last;
      if (now - last >= MIN_FRAME_MS) slot = head;
      else if (nEv > 0) slot = newest;   // too soon, but it carries events: overwrite the newest frame
      else return;                       // too soon (high-refresh display): skip
    }
    if (slot === head) {
      head = (head + 1) % CAP;
      if (count < CAP) count++;
    }
    writeFrame(slot, state, now);
    for (let j = 0; j < nEv; j++) pushEvent(events[j], now);
  }

  // ---- sampling ------------------------------------------------------------------------------
  function build(sa, sb, u, p) {
    const fA = sa * TF, fB = sb * TF, iA = sa * TI, iB = sb * TI;
    const lerpOk = sa !== sb;
    const secsBeforeB = Math.max(0, (frameT[sb] - p) / 1000);
    const samePhase = iTop[iA + I_PH] === iTop[iB + I_PH] && iTop[iA + I_PER] === iTop[iB + I_PER];

    const npA = iTop[iA + I_NP], npB = iTop[iB + I_NP];
    const players = new Array(npB);
    for (let j = 0; j < npB; j++) {
      const fb = (sb * MP + j) * PF, ib = (sb * MP + j) * PIN;
      const o = {
        id: pInt[ib + Q_ID], tm: pInt[ib + Q_TM], g: pInt[ib + Q_G],
        x: pFlt[fb + P_X], y: pFlt[fb + P_Y], z: pFlt[fb + P_Z],
        vx: pFlt[fb + P_VX], vz: pFlt[fb + P_VZ],
        f: pFlt[fb + P_F],
        s: pInt[ib + Q_S], sT: pFlt[fb + P_ST],
        tb: pFlt[fb + P_TB], fire: pInt[ib + Q_FIRE], ch: pFlt[fb + P_CH],
        c: pInt[ib + Q_C], n: pInt[ib + Q_N],
      };
      if (lerpOk && j < npA) {
        const fa = (sa * MP + j) * PF, ia = (sa * MP + j) * PIN;
        const sameState = pInt[ia + Q_S] === pInt[ib + Q_S];
        const dx = pFlt[fb + P_X] - pFlt[fa + P_X], dz = pFlt[fb + P_Z] - pFlt[fa + P_Z];
        if (dx * dx + dz * dz <= TELEPORT_DIST2) {
          o.x = lerp(pFlt[fa + P_X], o.x, u);
          o.y = lerp(pFlt[fa + P_Y], o.y, u);
          o.z = lerp(pFlt[fa + P_Z], o.z, u);
          o.vx = lerp(pFlt[fa + P_VX], o.vx, u);
          o.vz = lerp(pFlt[fa + P_VZ], o.vz, u);
          o.f = lerpAngle(pFlt[fa + P_F], o.f, u);
          o.tb = lerp(pFlt[fa + P_TB], o.tb, u);
          if (sameState) {
            o.ch = lerp(pFlt[fa + P_CH], o.ch, u);
            o.sT = lerp(pFlt[fa + P_ST], o.sT, u);
          }
        }
        // A state switch happens at the newer frame; wind its timer back to the playhead.
        if (!sameState) o.sT = Math.max(0, o.sT - secsBeforeB);
      }
      players[j] = o;
    }

    let k = null;
    if (iTop[iB + I_K]) {
      const kb = sb * KF;
      k = {
        x: kFlt[kb + K_X], y: kFlt[kb + K_Y], z: kFlt[kb + K_Z],
        vx: kFlt[kb + K_VX], vy: kFlt[kb + K_VY], vz: kFlt[kb + K_VZ],
        o: iTop[iB + I_KO],
      };
      if (lerpOk && iTop[iA + I_K]) {
        const ka = sa * KF;
        const dx = k.x - kFlt[ka + K_X], dz = k.z - kFlt[ka + K_Z];
        if (dx * dx + dz * dz <= TELEPORT_DIST2) {
          k.x = lerp(kFlt[ka + K_X], k.x, u);
          k.y = lerp(kFlt[ka + K_Y], k.y, u);
          k.z = lerp(kFlt[ka + K_Z], k.z, u);
          k.vx = lerp(kFlt[ka + K_VX], k.vx, u);
          k.vy = lerp(kFlt[ka + K_VY], k.vy, u);
          k.vz = lerp(kFlt[ka + K_VZ], k.vz, u);
          // Carried puck: interpolate around the (interpolated) carrier so it stays on the stick
          // arc through spins instead of cutting the chord (visible at 0.35x).
          const ow = k.o;
          if (ow >= 0 && ow === iTop[iA + I_KO] && ow < npA && ow < npB) {
            const pa = (sa * MP + ow) * PF, pb = (sb * MP + ow) * PF;
            const ax = kFlt[ka + K_X] - pFlt[pa + P_X], az = kFlt[ka + K_Z] - pFlt[pa + P_Z];
            const bx = kFlt[kb + K_X] - pFlt[pb + P_X], bz = kFlt[kb + K_Z] - pFlt[pb + P_Z];
            const r = lerp(Math.hypot(ax, az), Math.hypot(bx, bz), u);
            const ang = lerpAngle(Math.atan2(az, ax), Math.atan2(bz, bx), u);
            k.x = players[ow].x + Math.cos(ang) * r;
            k.z = players[ow].z + Math.sin(ang) * r;
          }
        }
      }
    }

    const ng = iTop[iB + I_GL];
    const gl = new Array(ng);
    for (let j = 0; j < ng; j++) gl[j] = glA[sb * MAX_GLASS + j];

    return {
      tick: fTop[fB + T_TICK],
      ph: iTop[iB + I_PH],
      phT: lerpOk && samePhase ? lerp(fTop[fA + T_PHT], fTop[fB + T_PHT], u) : fTop[fB + T_PHT],
      per: iTop[iB + I_PER],
      clk: lerpOk && samePhase ? lerp(fTop[fA + T_CLK], fTop[fB + T_CLK], u) : fTop[fB + T_CLK],
      sc: [iTop[iB + I_SC0], iTop[iB + I_SC1]],
      teams: [iTop[iB + I_TM0], iTop[iB + I_TM1]],
      p: players,
      k,
      gl,
      time: lerpOk ? lerp(fTop[fA + T_TIME], fTop[fB + T_TIME], u) : fTop[fB + T_TIME],
      replay: true,
    };
  }

  // Fresh interpolated state at playhead p (record clock, ms).
  function sampleState(p) {
    let lo = 0, hi = count - 1;
    if (p <= frameT[slotOf(lo)]) { const s = slotOf(lo); return build(s, s, 1, p); }
    if (p >= frameT[slotOf(hi)]) { const s = slotOf(hi); return build(s, s, 1, p); }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (frameT[slotOf(mid)] <= p) lo = mid; else hi = mid;
    }
    const sa = slotOf(lo), sb = slotOf(hi);
    const span = frameT[sb] - frameT[sa];
    return build(sa, sb, span > 0 ? (p - frameT[sa]) / span : 1, p);
  }

  // ---- playback ------------------------------------------------------------------------------
  const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  /**
   * The newest recorded event at or after `fromMs` and at or before `toMs` (record clock) for which
   * pred(event) is true, as { ms, event }; null when there is none. Lets the caller time and frame a
   * replay around what happened (the shot that scored, a glass break before the goal).
   */
  function findEvent(pred, fromMs = -Infinity, toMs = Infinity) {
    if (typeof pred !== 'function') return null;
    for (let i = evCount - 1; i >= 0; i--) {
      const s = evSlotOf(i), t = evT[s];
      if (t > toMs) continue;
      if (t < fromMs) break;
      let hit = false;
      try { hit = !!pred(evRef[s]); } catch { hit = false; }
      if (hit) return { ms: t, event: evRef[s] };
    }
    return null;
  }
  /** findEvent's time only (ms), NaN when there is none. */
  function findEventMs(pred, fromMs, toMs) {
    const f = findEvent(pred, fromMs, toMs);
    return f ? f.ms : NaN;
  }

  // Returns the planned wall-clock duration in seconds (0 = nothing to play; not started).
  // Extra optional fields: slowmoSpeed (default 0.35), finishSec (the last this many seconds of the
  // tail play at finishSpeed instead, default 0 = none) and finishSpeed (default 0.15), maxWallSec
  // (trim the run-up, then the 0.35x part of the tail, then the finish, so the replay never lasts
  // longer than this), caption ({ name, detail, team } for the caption plate, false for none;
  // default: built from the goal the window ends on, see goalCaption), tailLabel (the slow-mo tail's
  // camera name for the overlay, e.g. "Goal cam"; default none).
  function start(opts) {
    const {
      endMs, lengthSec = 3.5, speed = 0.6, slowmoTailSec = 1.0,
      slowmoSpeed = SLOWMO_SPEED, finishSec = 0, finishSpeed = FINISH_SPEED, maxWallSec = Infinity,
    } = opts || {};
    if (disposed) return 0;
    if (playing) finish();
    if (count < 2) return 0;

    const oldest = frameT[slotOf(0)], newest = frameT[slotOf(count - 1)];
    const from = Math.max(oldest, newest - SECS * 1000);   // only the last `seconds` are replayable
    let end = Number.isFinite(endMs) ? endMs : Number.isFinite(goalMs) ? goalMs : newest;
    if (end > newest) end = newest;
    if (!(end > from)) return 0;

    const sp = Math.min(8, Math.max(0.05, finite(speed, 0.6)));
    const sl = Math.min(8, Math.max(0.05, finite(slowmoSpeed, SLOWMO_SPEED)));
    const fs = Math.min(8, Math.max(0.02, finite(finishSpeed, FINISH_SPEED)));
    let len = Math.min(SECS, Math.max(0, finite(lengthSec, 3.5)));
    let tail = Math.min(len, Math.max(0, finite(slowmoTailSec, 1.0)));
    let fin = Math.min(tail, Math.max(0, finite(finishSec, 0)));
    if (typeof maxWallSec === 'number' && maxWallSec >= 0 && maxWallSec < Infinity) {
      const finWall = fin / fs, tailWall = (tail - fin) / sl + finWall;
      if (finWall >= maxWallSec) { fin = maxWallSec * fs; tail = fin; len = tail; }
      else if (tailWall >= maxWallSec) { tail = fin + (maxWallSec - finWall) * sl; len = tail; }
      else if ((len - tail) / sp + tailWall > maxWallSec) len = tail + (maxWallSec - tailWall) * sp;
    }

    let a = end - len * 1000;
    if (a < from) a = from;
    let b = end - tail * 1000;
    if (b < a) b = a;
    let c = end - fin * 1000;
    if (c < b) c = b;
    if (!(end > a)) return 0;

    t0 = a; t1 = end; ts = b; tf = c; spd = sp; slo = sl; fsp = fs;
    wall = 0;
    wallNormal = (ts - t0) / 1000 / spd;
    wallSlow = (tf - ts) / 1000 / slo;
    wallTotal = wallNormal + wallSlow + (t1 - tf) / 1000 / fsp;

    // First event at or after the window start.
    let lo = 0, hi = evCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (evT[evSlotOf(mid)] < t0) lo = mid + 1; else hi = mid;
    }
    evIdx = lo;

    // Caption plate: explicit, or built from the goal this window ends on.
    const inWindow = !!goalEv && Number.isFinite(goalMs) && goalMs >= t0 - 1 && goalMs <= t1 + 1;
    playGoal = inWindow ? {
      x: typeof goalEv.x === 'number' && Number.isFinite(goalEv.x) ? goalEv.x : 0,
      z: typeof goalEv.z === 'number' && Number.isFinite(goalEv.z) ? goalEv.z : 0,
      team: goalEv.team === 1 ? 1 : 0,
    } : null;
    const capOpt = opts && opts.caption;
    caption = null;
    if (capOpt && typeof capOpt === 'object') caption = normCaption(capOpt);
    else if (capOpt !== false && inWindow) {
      caption = goalCaption(goalEv, sampleState(Math.min(goalMs, t1)), nameOf);
    }
    const lab = opts && opts.tailLabel;
    tailLabel = typeof lab === 'string' ? lab.trim().slice(0, 24) : '';

    playing = true; ended = false;
    showOverlay();
    return wallTotal;
  }

  function update(dtSec) {
    if (!playing) return null;
    if (ended) { finish(); return null; }
    const dt = typeof dtSec === 'number' && dtSec > 0 && dtSec < Infinity ? dtSec : 0;
    wall += dt;
    let p, rate;
    if (wall >= wallTotal - 1e-9) {
      wall = wallTotal; p = t1; ended = true;
      rate = t1 > tf ? fsp : t1 > ts ? slo : spd;
    } else if (wall <= wallNormal) {
      p = t0 + wall * spd * 1000; rate = spd;
    } else if (wall <= wallNormal + wallSlow) {
      p = ts + (wall - wallNormal) * slo * 1000; rate = slo;
      if (p > tf) p = tf;
    } else {
      p = tf + (wall - wallNormal - wallSlow) * fsp * 1000; rate = fsp;
      if (p > t1) p = t1;
    }

    const events = [];
    while (evIdx < evCount) {
      const s = evSlotOf(evIdx);
      if (evT[s] > p) break;
      events.push({ ...evRef[s], replay: true });
      evIdx++;
    }

    const progress = wallTotal > 0 ? Math.min(1, wall / wallTotal) : 1;
    const slowmo = (rate === slo || rate === fsp) && p > ts;
    if (overlay) overlay.set(progress, slowmo, rate);
    // tail: the playhead is in the slow-mo tail; goal: the goal this window ends on ({ x, z, team });
    // ms: the playhead on the record clock (compare with findEvent times)
    return { state: sampleState(p), events, progress, rate, slowmo, tail: t1 > ts && p > ts, goal: playGoal, ms: p };
  }

  function finish() {
    playing = false; ended = false;
    if (overlay) overlay.hide();
  }

  function stop() { if (playing) finish(); }

  function dispose() {
    stop();
    if (overlay) overlay.destroy();
    overlay = null;
    disposed = true;
    evRef.fill(null);
    clear();
  }

  // ---- overlay -------------------------------------------------------------------------------
  function showOverlay() {
    if (!overlayTried) {
      overlayTried = true;
      if (container) {
        try { overlay = makeOverlay(container); } catch { overlay = null; }
      }
    }
    if (overlay) { overlay.setSkip(skipHint); overlay.show(caption, slo, tailLabel); }
  }

  /**
   * What skips: { device: 'gamepad' | 'keyboard' | 'touch', label } - the pad shows the A button, the
   * keyboard and mouse the bound shoot key (label, e.g. "Left click" or "J"), touch "Tap".
   */
  function setSkipHint(h) {
    const device = h && (h.device === 'keyboard' || h.device === 'touch') ? h.device : 'gamepad';
    const label = device === 'gamepad' ? 'A' : device === 'touch' ? 'Tap' : (h && typeof h.label === 'string' && h.label.trim()) || 'Shoot';
    if (label === skipHint.label && device === skipHint.device) return;
    skipHint = { device, label };
    if (overlay) overlay.setSkip(skipHint);
  }

  return {
    record,
    start,
    findEvent,
    findEventMs,
    isPlaying: () => playing,
    update,
    stop,
    dispose,
    setSkipHint,
    skipHint: () => ({ ...skipHint }),
    // Introspection (tests / debugging).
    lastGoalMs: () => goalMs,
    caption: () => (caption ? { ...caption } : null),
    stats: () => ({
      frames: count,
      capacity: CAP,
      events: evCount,
      fromMs: count ? Math.max(frameT[slotOf(0)], frameT[slotOf(count - 1)] - SECS * 1000) : NaN,
      toMs: count ? frameT[slotOf(count - 1)] : NaN,
      oldestMs: count ? frameT[slotOf(0)] : NaN,
      bytes: BYTES,
    }),
  };
}

// ------------------------------------------------------------------------------------------------
// DOM overlay (design "Replay"): ground letterbox bars, the top-left bug (red dot + "Replay" + a
// "Slow-mo 0.35×" chip in the tail), the scorer caption plate, and the bottom progress line with an
// "A Skip" glyph. Never blocks input. Colours / fonts come from the design tokens with fallbacks so
// the overlay also looks right on pages without style.css.
// ------------------------------------------------------------------------------------------------

function normCaption(c) {
  const name = typeof c.name === 'string' ? c.name.trim() : '';
  if (!name) return null;
  const detail = typeof c.detail === 'string' ? c.detail.trim() : '';
  const team = Number.isInteger(c.team) && c.team >= 0 && c.team < TEAMS.length ? c.team : -1;
  return { name, detail, team };
}
const fmtRate = (r) => `${Math.round(r * 100) / 100}`;

const STYLE_ID = 'ir-replay-style';
const CSS = `
.ir-replay-root{--ir-replay-bar:clamp(28px,6.2222vh,84px);position:absolute;inset:0;z-index:var(--ir-replay-z,30);
  overflow:hidden;pointer-events:none;user-select:none;-webkit-user-select:none;
  font-family:var(--f-ui,Bahnschrift,"DIN Alternate","Segoe UI",sans-serif);color:var(--ink,#E8EDF5);
  font-size:13px;line-height:18px;visibility:hidden;opacity:0;transition:opacity 120ms ease-out,visibility 0s linear 120ms}
.ir-replay-root.ir-replay-fixed{position:fixed}
.ir-replay-root *{pointer-events:none}
.ir-replay-root div{box-sizing:border-box}
.ir-replay-root.ir-replay-on{visibility:visible;opacity:1;transition:none}
.ir-replay-bar{position:absolute;left:0;right:0;height:var(--ir-replay-bar);background:var(--ground,#0A0F1C)}
.ir-replay-top{top:0}
.ir-replay-bot{bottom:0;display:flex;align-items:center;gap:16px;
  padding:0 max(24px,env(safe-area-inset-right,0px)) 0 max(24px,env(safe-area-inset-left,0px))}
.ir-replay-track{position:relative;flex:1 1 0;min-width:0;height:4px;border-radius:2px;overflow:hidden;
  background:var(--surface-3,#1E2940)}
.ir-replay-fill{position:absolute;left:0;top:0;width:100%;height:100%;border-radius:2px;background:var(--ink,#E8EDF5);
  transform-origin:0 50%;transform:scaleX(0)}
.ir-replay-skip{flex:none;display:flex;align-items:center;gap:6px}
.ir-replay-glyph{flex:none;width:20px;height:20px;border-radius:10px;display:flex;align-items:center;justify-content:center;
  background:var(--surface-3,#1E2940);color:var(--ink,#E8EDF5);font-size:11px;line-height:13px;font-weight:700}
.ir-replay-glyph.ir-replay-key,.ir-replay-glyph.ir-replay-tap{width:auto;min-width:20px;padding:0 7px;white-space:nowrap}
.ir-replay-glyph.ir-replay-key{border-radius:var(--r-sm,6px);background:var(--ice,#DCEAF6);color:var(--on-ice,#0A0F1C)}
.ir-replay-skiptxt{font-size:12px;line-height:14px;color:var(--ink-2,#A1ACC0);white-space:nowrap}
.ir-replay-bug{position:absolute;left:max(24px,env(safe-area-inset-left,0px));top:calc(var(--ir-replay-bar) + 20px);
  height:44px;display:flex;align-items:center;gap:10px;padding:0 16px;white-space:nowrap;
  background:rgba(10,15,28,.92);border:1px solid var(--hairline-strong,#34425F);border-radius:var(--r-md,10px)}
.ir-replay-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--goal,#FF4B3E)}
.ir-replay-word{font-size:20px;line-height:24px;font-weight:700;font-style:italic}
.ir-replay-slo{display:none;height:22px;align-items:center;padding:0 8px;border-radius:var(--r-sm,6px);
  background:var(--surface-3,#1E2940);font-size:12px;line-height:14px}
.ir-replay-is-slow .ir-replay-slo{display:flex}
.ir-replay-cam{display:none;height:22px;align-items:center;padding:0 8px;border-radius:var(--r-sm,6px);
  background:var(--ice,#DCEAF6);color:var(--on-ice,#0A0F1C);font-size:12px;line-height:14px;font-weight:600}
.ir-replay-is-slow.ir-replay-has-cam .ir-replay-cam{display:flex}
.ir-replay-cap{position:absolute;left:max(24px,env(safe-area-inset-left,0px));top:calc(var(--ir-replay-bar) + 72px);
  height:32px;max-width:calc(100% - 48px);display:none;align-items:center;gap:8px;padding:0 12px;white-space:nowrap;
  overflow:hidden;background:rgba(10,15,28,.8);border-radius:var(--r-sm,6px)}
.ir-replay-has-cap .ir-replay-cap{display:flex}
.ir-replay-logo{flex:none;width:18px;height:18px;display:block}
.ir-replay-logo.ir-replay-nologo{display:none}
.ir-replay-who{font-weight:600}
.ir-replay-what{color:var(--ink-2,#A1ACC0);overflow:hidden;text-overflow:ellipsis}
.ir-replay-on .ir-replay-top{animation:ir-replay-top 260ms cubic-bezier(.2,.8,.2,1) both}
.ir-replay-on .ir-replay-bot{animation:ir-replay-bot 260ms cubic-bezier(.2,.8,.2,1) both}
.ir-replay-on .ir-replay-bug{animation:ir-replay-in 180ms ease-out 60ms both}
.ir-replay-on .ir-replay-cap{animation:ir-replay-in 200ms ease-out 140ms both}
.ir-replay-on .ir-replay-dot{animation:ir-replay-blink 1.2s steps(1,end) infinite}
@keyframes ir-replay-top{from{transform:translateY(-100%)}to{transform:none}}
@keyframes ir-replay-bot{from{transform:translateY(100%)}to{transform:none}}
@keyframes ir-replay-in{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:none}}
@keyframes ir-replay-blink{0%{opacity:1}60%{opacity:.35}}
@media (max-width:600px),(max-height:480px){
  .ir-replay-bug{left:max(12px,env(safe-area-inset-left,0px));top:calc(var(--ir-replay-bar) + 10px);height:36px;gap:8px;padding:0 12px}
  .ir-replay-word{font-size:17px;line-height:20px}
  .ir-replay-cap{left:max(12px,env(safe-area-inset-left,0px));top:calc(var(--ir-replay-bar) + 54px);height:28px;max-width:calc(100% - 24px)}
  .ir-replay-bot{gap:12px;padding:0 max(12px,env(safe-area-inset-right,0px)) 0 max(12px,env(safe-area-inset-left,0px))}
}
@media (prefers-reduced-motion:reduce){
  .ir-replay-root,.ir-replay-root.ir-replay-on{transition:none}
  .ir-replay-on .ir-replay-top,.ir-replay-on .ir-replay-bot,.ir-replay-on .ir-replay-bug,
  .ir-replay-on .ir-replay-cap,.ir-replay-on .ir-replay-dot{animation:none}
}
`;

let logosMod = null;          // lazily imported ./logos.js (team crests); false once it failed
function crestURI(team, cb) {
  if (logosMod === false || !(team >= 0)) return;
  const use = (m) => { try { cb(m.svgToDataURI(m.teamLogoSVG(team, { size: 36, variant: 'mark' }))); } catch { /* no crest */ } };
  if (logosMod) { use(logosMod); return; }
  import('./logos.js').then((m) => { logosMod = m; use(m); }, () => { logosMod = false; });
}

function makeOverlay(container) {
  const doc = container.ownerDocument || globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') return null;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement || container).appendChild(style);
  }
  const div = (cls, parent, text, tag = 'div') => {
    const e = doc.createElement(tag);
    e.className = cls;
    if (text) e.textContent = text;
    parent.appendChild(e);
    return e;
  };
  const base = container === doc.body ? 'ir-replay-root ir-replay-fixed' : 'ir-replay-root';
  const root = doc.createElement('div');
  root.className = base;
  root.setAttribute('aria-hidden', 'true');
  div('ir-replay-bar ir-replay-top', root);
  const bot = div('ir-replay-bar ir-replay-bot', root);
  const fill = div('ir-replay-fill', div('ir-replay-track', bot));
  const skip = div('ir-replay-skip', bot);
  const glyph = div('ir-replay-glyph', skip, 'A');
  div('ir-replay-skiptxt', skip, 'Skip');
  const bug = div('ir-replay-bug', root);
  div('ir-replay-dot', bug);
  div('ir-replay-word', bug, 'Replay');
  const slo = div('ir-replay-slo', bug, 'Slow-mo 0.35×');
  const camChip = div('ir-replay-cam', bug, '');
  const cap = div('ir-replay-cap', root);
  const logo = div('ir-replay-logo ir-replay-nologo', cap, '', 'img');
  logo.alt = '';
  const who = div('ir-replay-who', cap, '', 'span');
  const what = div('ir-replay-what', cap, '', 'span');
  container.appendChild(root);

  let lastP = -1, lastSlow = null, lastRate = SLOWMO_SPEED, shownCls = base, capSeq = 0, bugBase = 'ir-replay-bug';
  const ov = {
    root,
    show(c, rate, camLabel) {
      slo.textContent = `Slow-mo ${fmtRate(Number.isFinite(rate) ? rate : SLOWMO_SPEED)}×`;
      camChip.textContent = camLabel || '';
      bugBase = camLabel ? 'ir-replay-bug ir-replay-has-cam' : 'ir-replay-bug';
      const seq = ++capSeq;
      if (c && c.name) {
        who.textContent = c.name;
        what.textContent = c.detail || '';
        logo.className = 'ir-replay-logo ir-replay-nologo';
        crestURI(c.team, (uri) => { if (seq === capSeq) { logo.src = uri; logo.className = 'ir-replay-logo'; } });
        shownCls = base + ' ir-replay-on ir-replay-has-cap';
      } else {
        who.textContent = ''; what.textContent = '';
        shownCls = base + ' ir-replay-on';
      }
      root.className = shownCls;
      lastP = -1; lastSlow = null; lastRate = Number.isFinite(rate) ? rate : SLOWMO_SPEED;
      ov.set(0, false);
    },
    hide() { root.className = base; },
    // pad: the round A button; keyboard / mouse: an ice keycap with the bound key; touch: "Tap"
    setSkip(h) {
      glyph.textContent = h.label;
      glyph.className = h.device === 'gamepad' ? 'ir-replay-glyph' : h.device === 'touch' ? 'ir-replay-glyph ir-replay-tap' : 'ir-replay-glyph ir-replay-key';
    },
    set(p, slow, rate) {
      // the chip follows the rate: 0.35x for the tail, then the slower finish
      if (slow && Number.isFinite(rate) && rate !== lastRate) {
        lastRate = rate;
        slo.textContent = `Slow-mo ${fmtRate(rate)}×`;
      }
      if (Math.abs(p - lastP) >= 0.002 || (p === 1 && lastP !== 1)) {
        lastP = p;
        fill.style.transform = 'scaleX(' + p.toFixed(4) + ')';
      }
      if (slow !== lastSlow) {
        lastSlow = slow;
        bug.className = slow ? bugBase + ' ir-replay-is-slow' : bugBase;
      }
    },
    destroy() { if (root.parentNode) root.parentNode.removeChild(root); },
  };
  return ov;
}
