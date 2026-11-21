// ICE RIOT - instant goal replay.
//
// createReplay({ seconds, container }) keeps the last `seconds` of rendered (already interpolated)
// states in a fixed-size ring of preallocated typed arrays, plus the events released on each frame.
// After a goal, start() plays a window leading up to it: `speed` for the run-up, then a 0.35x
// slow-motion tail. update(dt) returns a freshly interpolated Snapshot-shaped state (positions lerped,
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

import { EVENT, TEAM_SIZE, lerp, lerpAngle } from '../shared/constants.js';

export const SLOWMO_SPEED = 0.35;      // playback rate of the slow-motion tail
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

export function createReplay({
  seconds = 5,
  container = (typeof document !== 'undefined' ? document.body : null),
  isGoal = defaultIsGoal,          // optional override: (event) => boolean
  maxPlayers = TEAM_SIZE * 2,      // snapshot `p` always has 8 entries
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
  let disposed = false;

  // ---- playback state ------------------------------------------------------------------------
  let playing = false, ended = false;
  let t0 = 0, t1 = 0, ts = 0;        // window start, end, slow-mo tail start (record clock, ms)
  let spd = 0.6, slo = SLOWMO_SPEED;
  let wall = 0, wallNormal = 0, wallTotal = 0;
  let evIdx = 0;                     // next logical event index to release

  let overlay = null, overlayTried = false;

  const slotOf = (i) => (head - count + i + CAP) % CAP;           // logical frame i (0 = oldest)
  const evSlotOf = (i) => (evHead - evCount + i + EVENT_CAPACITY) % EVENT_CAPACITY;

  function clear() {
    head = 0; count = 0;
    evHead = 0; evCount = 0;
    goalMs = NaN;
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
    if (isGoal(e)) goalMs = now;
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

  // Returns the planned wall-clock duration in seconds (0 = nothing to play; not started).
  // Extra optional fields: slowmoSpeed (default 0.35), maxWallSec (trim the run-up, then the tail,
  // so the replay never lasts longer than this).
  function start(opts) {
    const {
      endMs, lengthSec = 3.5, speed = 0.6, slowmoTailSec = 1.0,
      slowmoSpeed = SLOWMO_SPEED, maxWallSec = Infinity,
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
    let len = Math.min(SECS, Math.max(0, finite(lengthSec, 3.5)));
    let tail = Math.min(len, Math.max(0, finite(slowmoTailSec, 1.0)));
    if (typeof maxWallSec === 'number' && maxWallSec >= 0 && maxWallSec < Infinity) {
      const tailWall = tail / sl;
      if (tailWall >= maxWallSec) { tail = maxWallSec * sl; len = tail; }
      else if ((len - tail) / sp + tailWall > maxWallSec) len = tail + (maxWallSec - tailWall) * sp;
    }

    let a = end - len * 1000;
    if (a < from) a = from;
    let b = end - tail * 1000;
    if (b < a) b = a;
    if (!(end > a)) return 0;

    t0 = a; t1 = end; ts = b; spd = sp; slo = sl;
    wall = 0;
    wallNormal = (ts - t0) / 1000 / spd;
    wallTotal = wallNormal + (t1 - ts) / 1000 / slo;

    // First event at or after the window start.
    let lo = 0, hi = evCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (evT[evSlotOf(mid)] < t0) lo = mid + 1; else hi = mid;
    }
    evIdx = lo;

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
      rate = t1 > ts ? slo : spd;
    } else if (wall <= wallNormal) {
      p = t0 + wall * spd * 1000; rate = spd;
    } else {
      p = ts + (wall - wallNormal) * slo * 1000; rate = slo;
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
    const slowmo = rate === slo && p > ts;
    if (overlay) overlay.set(progress, slowmo);
    return { state: sampleState(p), events, progress, rate, slowmo };
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
    if (overlay) overlay.show();
  }

  return {
    record,
    start,
    isPlaying: () => playing,
    update,
    stop,
    dispose,
    // Introspection (tests / debugging).
    lastGoalMs: () => goalMs,
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
// DOM overlay: "REPLAY" bug with a blinking red dot, letterbox bars, progress bar. Never blocks input.
// ------------------------------------------------------------------------------------------------

const STYLE_ID = 'ir-replay-style';
const CSS = `
.ir-replay-root{--ir-replay-bar:clamp(22px,6vh,64px);position:absolute;inset:0;z-index:var(--ir-replay-z,30);
  display:none;overflow:hidden;pointer-events:none;user-select:none;-webkit-user-select:none;color:#fff;
  font-family:"Arial Black","Segoe UI Black","Helvetica Neue",Impact,system-ui,sans-serif}
.ir-replay-root.ir-replay-fixed{position:fixed}
.ir-replay-root *{pointer-events:none}
.ir-replay-root.ir-replay-on{display:block}
.ir-replay-bar{position:absolute;left:0;right:0;height:var(--ir-replay-bar);background:rgba(0,0,0,.5)}
.ir-replay-top{top:0;animation:ir-replay-top .35s cubic-bezier(.2,.8,.2,1) both}
.ir-replay-bot{bottom:0;animation:ir-replay-bot .35s cubic-bezier(.2,.8,.2,1) both}
.ir-replay-track{position:absolute;left:0;right:0;top:0;height:3px;background:rgba(255,255,255,.14)}
.ir-replay-fill{height:100%;background:linear-gradient(90deg,#ff3b30,#ffcc00);transform-origin:0 50%;transform:scaleX(0)}
.ir-replay-hint{position:absolute;right:max(16px,env(safe-area-inset-right));top:50%;transform:translateY(-50%);
  font-size:11px;font-weight:700;letter-spacing:.18em;opacity:.7;white-space:nowrap}
.ir-replay-bug{position:absolute;left:max(16px,env(safe-area-inset-left));top:calc(var(--ir-replay-bar) + 12px);
  display:flex;align-items:center;gap:10px;padding:7px 14px 7px 12px;background:rgba(12,12,20,.78);
  border-left:4px solid #ff3b30;border-radius:0 4px 4px 0;box-shadow:0 4px 18px rgba(0,0,0,.35);
  font-size:22px;font-style:italic;font-weight:900;letter-spacing:.14em;line-height:1;
  text-shadow:0 2px 0 rgba(0,0,0,.5);animation:ir-replay-pop .4s cubic-bezier(.2,1.4,.4,1) both}
.ir-replay-dot{width:11px;height:11px;border-radius:50%;background:#ff3b30;box-shadow:0 0 10px #ff3b30;
  animation:ir-replay-blink 1s linear infinite}
.ir-replay-slo{display:none;padding-left:10px;border-left:1px solid rgba(255,255,255,.3);color:#ffcc00;
  font-size:12px;letter-spacing:.2em}
.ir-replay-is-slow .ir-replay-slo{display:inline-block}
@keyframes ir-replay-top{from{transform:translateY(-100%)}to{transform:none}}
@keyframes ir-replay-bot{from{transform:translateY(100%)}to{transform:none}}
@keyframes ir-replay-pop{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:none}}
@keyframes ir-replay-blink{0%,49%{opacity:1}50%,100%{opacity:.15}}
@media (max-width:600px){.ir-replay-bug{font-size:16px;padding:6px 10px}.ir-replay-hint{font-size:9px;letter-spacing:.12em}}
@media (prefers-reduced-motion:reduce){.ir-replay-top,.ir-replay-bot,.ir-replay-bug,.ir-replay-dot{animation:none}}
`;

function makeOverlay(container) {
  const doc = container.ownerDocument || globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') return null;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement || container).appendChild(style);
  }
  const div = (cls, parent, text) => {
    const e = doc.createElement('div');
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
  div('ir-replay-hint', bot, 'PRESS ANY BUTTON TO SKIP');
  const bug = div('ir-replay-bug', root);
  div('ir-replay-dot', bug);
  div('ir-replay-word', bug, 'REPLAY');
  div('ir-replay-slo', bug, 'SLO-MO');
  container.appendChild(root);

  let lastP = -1, lastSlow = null;
  const ov = {
    root,
    show() {
      root.className = base + ' ir-replay-on';
      lastP = -1; lastSlow = null;
      ov.set(0, false);
    },
    hide() { root.className = base; },
    set(p, slow) {
      if (Math.abs(p - lastP) >= 0.002 || (p === 1 && lastP !== 1)) {
        lastP = p;
        fill.style.transform = 'scaleX(' + p.toFixed(4) + ')';
      }
      if (slow !== lastSlow) {
        lastSlow = slow;
        bug.className = slow ? 'ir-replay-bug ir-replay-is-slow' : 'ir-replay-bug';
      }
    },
    destroy() { if (root.parentNode) root.parentNode.removeChild(root); },
  };
  return ov;
}
