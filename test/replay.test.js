// ICE RIOT - instant replay tests. Run: node test/replay.test.js  (exit 1 on failure)
import v8 from 'node:v8';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReplay, goalCaption, SLOWMO_SPEED, FINISH_SPEED, STORE_HZ, RESET_GAP_MS } from '../public/replay.js';
import { EVENT, PSTATE, PHASE } from '../shared/constants.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + ((e && e.stack) || e)); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
function near(a, b, eps, msg) {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg || 'near'}: got ${a}, want ${b} (eps ${eps})`);
}
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg || 'eq'}: got ${ja}, want ${jb}`);
}

// ---- synthetic recording ---------------------------------------------------------------------
const OFF = 1e6;                    // fake server-clock offset carried in state.time
const FPS = 60;
const tOf = (i, fps = FPS) => (i * 1000) / fps;   // exact for the frame indices used below
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const NO_EV = [];

function makeState() {
  const p = [];
  for (let i = 0; i < 8; i++) {
    p.push({ id: i, tm: i >> 2, g: (i & 3) === 3 ? 1 : 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, f: 0,
      s: PSTATE.SKATE, sT: 0, tb: 1, fire: 0, ch: 0, c: i === 0 ? 7 : 0, n: 10 + i });
  }
  return { tick: 0, ph: PHASE.PLAY, phT: 0, per: 1, clk: 120, sc: [0, 0], teams: [2, 4], p,
    k: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, o: -1 }, gl: [], time: 0 };
}
// Every continuous field is linear in t, so interpolated values can be checked exactly.
const expX = (i, t) => -20 + i * 5 + (t / 1000) * 0.5;
const expZ = (i, t) => -6 + i + (t / 1000) * 0.25;
const expF = (i, t) => (t / 1000) * 1.3 + i;           // wrapped when stored -> exercises lerpAngle wrap
const expK = (t) => -5 + t / 1000;
function setState(st, t) {   // mutates in place: the recorder must deep-copy
  const sec = t / 1000;
  st.time = OFF + t; st.tick = Math.round(sec * 60); st.clk = 120 - sec;
  for (let i = 0; i < 8; i++) {
    const pl = st.p[i];
    pl.x = expX(i, t); pl.z = expZ(i, t); pl.vx = 0.5; pl.vz = 0.25;
    pl.f = wrap(expF(i, t)); pl.sT = sec; pl.tb = 1 - sec / 20;
  }
  st.k.x = expK(t); st.k.z = 2; st.k.vx = 1;
}

// 10 s at 60 fps; `evAt` maps frame index -> events array released on that frame.
function record10s(r, evAt = {}, fps = FPS, secs = 10) {
  const st = makeState();
  for (let i = 0; i <= secs * fps; i++) {
    const t = tOf(i, fps);
    setState(st, t);
    r.record(st, evAt[i] || NO_EV, t);
  }
  return st;
}
const playheadOf = (state) => state.time - OFF;

// Plays to the end with a fixed or generated dt. Returns [{res, dt}] of non-null updates.
function playAll(r, dtFn) {
  const out = [];
  for (let n = 0; n < 100000; n++) {
    const dt = typeof dtFn === 'function' ? dtFn(n) : dtFn;
    const res = r.update(dt);
    if (!res) return out;
    out.push({ res, dt });
  }
  throw new Error('replay never ended');
}

function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ---- tests -----------------------------------------------------------------------------------

test('module passes node --check and imports without a DOM', () => {
  const path = fileURLToPath(new URL('../public/replay.js', import.meta.url));
  execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
  assert(typeof globalThis.document === 'undefined', 'test runs without document');
  const r = createReplay();                      // default container -> null in Node
  record10s(r);
  assert(r.start({}) > 0, 'plays without an overlay');
  r.dispose();
});

test('ring keeps only the last `seconds` after 10 s at 60 fps', () => {
  const r = createReplay({ seconds: 5, container: null });
  record10s(r);
  const s = r.stats();
  assert(s.capacity === Math.ceil(5 * STORE_HZ) + 8, 'capacity');
  assert(s.frames === s.capacity, `ring full: ${s.frames}/${s.capacity}`);
  near(s.toMs, 10000, 1e-9, 'newest');
  near(s.fromMs, 5000, 1e-9, 'replayable window starts `seconds` before the newest frame');
  assert(s.oldestMs > 0 && s.oldestMs <= 5000, 'physical ring covers at least `seconds`');
  // A window longer than `seconds` is clamped to the last 5 s.
  const W = r.start({ endMs: 10000, lengthSec: 9, speed: 1, slowmoTailSec: 0 });
  near(W, 5, 1e-9, 'clamped length');
  const first = r.update(1e-6);
  near(playheadOf(first.state), 5000, 0.01, 'starts at the window edge');
  r.stop();
  // Anything ending before the window is gone.
  assert(r.start({ endMs: 4000 }) === 0 && !r.isPlaying(), 'old window not playable');
  // Partially old window: start clamps to the window, all of it falls in the slow-mo tail.
  near(r.start({ endMs: 5200, lengthSec: 3, speed: 0.6, slowmoTailSec: 1 }), 0.2 / SLOWMO_SPEED, 1e-9, 'clamped tail');
  r.dispose();
});

test('start() plays exactly the window before the goal, interpolating every frame', () => {
  const r = createReplay({ seconds: 5, container: null });
  record10s(r, { 540: [{ type: EVENT.GOAL, team: 0, scorer: 2, x: 26.6, z: 0 }] });   // goal at 9000 ms
  near(r.lastGoalMs(), 9000, 1e-9, 'goal time remembered');
  const W = r.start({});                                      // defaults: 3.5 s, 0.6x, 1 s tail
  assert(W > 0 && r.isPlaying(), 'started');
  const dt = 1 / 60;
  const frames = playAll(r, dt);
  assert(!r.isPlaying(), 'finished');
  const heads = frames.map((f) => playheadOf(f.res.state));
  near(heads[0], 5500 + dt * 0.6 * 1000, 1e-6, 'first playhead');
  near(heads[heads.length - 1], 9000, 1e-9, 'ends exactly at the goal');
  let maxErr = 0;
  for (let j = 0; j < frames.length; j++) {
    const { state } = frames[j].res;
    const t = heads[j];
    if (j) assert(t > heads[j - 1], 'playhead strictly increases');
    assert(t >= 5500 && t <= 9000, 'inside the window');
    assert(state.replay === true && state.p.length === 8, 'shape');
    for (let i = 0; i < 8; i++) {
      const pl = state.p[i];
      maxErr = Math.max(maxErr, Math.abs(pl.x - expX(i, t)), Math.abs(pl.z - expZ(i, t)),
        Math.abs(pl.sT - t / 1000), Math.hypot(Math.cos(pl.f) - Math.cos(expF(i, t)), Math.sin(pl.f) - Math.sin(expF(i, t))));
      assert(pl.id === i && pl.tm === i >> 2 && pl.n === 10 + i, 'discrete player fields');
    }
    maxErr = Math.max(maxErr, Math.abs(state.k.x - expK(t)), Math.abs(state.clk - (120 - t / 1000)));
    assert(state.p[0].c === 7 && state.k.o === -1, 'controller + puck owner');
    eq(state.teams, [2, 4], 'teams');
  }
  assert(maxErr < 1e-4, `interpolation error ${maxErr}`);
  r.dispose();
});

test('interpolation between two frames: lerp, angle wrap, teleport, state switch, carried puck', () => {
  const r = createReplay({ seconds: 5, container: null });
  const A = makeState(), B = makeState();
  A.p[0].x = 0; A.p[0].f = Math.PI - 0.1;  B.p[0].x = 1; B.p[0].f = -Math.PI + 0.1;   // wraps through +-PI
  A.p[1].x = 0; B.p[1].x = 10;                                                          // teleport (faceoff reset)
  A.p[2].s = PSTATE.CHECK; A.p[2].sT = 0.4; B.p[2].s = PSTATE.SKATE; B.p[2].sT = 0.1;  // state switch
  A.p[3].s = B.p[3].s = PSTATE.CHARGE; A.p[3].ch = 0.2; B.p[3].ch = 0.6; A.p[3].sT = 0.1; B.p[3].sT = 0.15;
  for (const S of [A, B]) { S.p[4].x = 0; S.p[4].z = 0; S.k.o = 4; }
  A.k.x = 1; A.k.z = 0; B.k.x = 0; B.k.z = 1;                                          // puck swings 90 deg on the stick
  A.gl = []; B.gl = [5, 2]; A.sc = [0, 0]; B.sc = [1, 0];
  A.ph = PHASE.PLAY; A.clk = 50; A.phT = 0; B.ph = PHASE.GOAL; B.clk = 49.9; B.phT = 3.5;
  A.time = 1000; B.time = 1050;
  r.record(A, NO_EV, 1000);
  r.record(B, NO_EV, 1050);
  // The copies are deep: mutating the live objects afterwards must not affect the replay.
  A.p[0].x = 999; B.p[0].x = 999; B.gl.push(7); B.k.x = 999;

  near(r.start({ endMs: 1050, lengthSec: 0.05, speed: 1, slowmoTailSec: 0 }), 0.05, 1e-12, 'wall');
  const s0 = r.update(1e-9).state;
  near(s0.p[0].x, 0, 1e-6, 'starts at frame A');
  const { state: s } = r.update(0.025 - 1e-9);               // playhead 1025 => u = 0.5
  near(s.time, 1025, 1e-6, 'time');
  near(s.p[0].x, 0.5, 1e-6, 'x lerp');
  assert(Math.cos(s.p[0].f) < -0.999 && Math.abs(Math.sin(s.p[0].f)) < 0.01, `angle wrapped through PI (f=${s.p[0].f})`);
  near(s.p[1].x, 10, 0, 'teleport snaps to the newer frame');
  assert(s.p[2].s === PSTATE.SKATE, 'discrete state from newer frame');
  near(s.p[2].sT, 0.1 - 0.025, 1e-6, 'switched state timer wound back to the playhead');
  near(s.p[3].ch, 0.4, 1e-6, 'charge lerp'); near(s.p[3].sT, 0.125, 1e-6, 'same-state timer lerp');
  near(s.k.x, Math.SQRT1_2, 1e-5, 'carried puck x on the stick arc');
  near(s.k.z, Math.SQRT1_2, 1e-5, 'carried puck z on the stick arc');
  assert(s.k.o === 4, 'puck owner');
  eq(s.gl, [5, 2], 'glass from newer frame (deep copy)'); eq(s.sc, [1, 0], 'score from newer frame');
  assert(s.ph === PHASE.GOAL, 'phase from newer frame');
  near(s.clk, 49.9, 1e-9, 'phase change => clk from newer');
  near(s.phT, 3.5, 1e-9, 'phase change => phT from newer');
  const last = r.update(0.025);
  near(last.state.p[0].x, 1, 1e-6, 'ends on frame B'); near(last.progress, 1, 0, 'progress 1');
  assert(r.update(0.016) === null, 'then null');
  // Fresh objects every update (a renderer may keep the previous state).
  r.start({ endMs: 1050, lengthSec: 0.05, speed: 1, slowmoTailSec: 0 });
  const u1 = r.update(0.01).state, u2 = r.update(0.01).state;
  assert(u1 !== u2 && u1.p !== u2.p && u1.p[0] !== u2.p[0] && u1.k !== u2.k, 'fresh state objects');
  r.dispose();
});

test('slow-mo tail duration math', () => {
  const cases = [
    { lengthSec: 3.5, speed: 0.6, slowmoTailSec: 1.0 },
    { lengthSec: 2.0, speed: 1.0, slowmoTailSec: 0.5 },
    { lengthSec: 3.0, speed: 0.8, slowmoTailSec: 0 },
    { lengthSec: 1.0, speed: 0.6, slowmoTailSec: 1.0 },
  ];
  const r = createReplay({ seconds: 5, container: null });
  record10s(r, { 540: [{ type: EVENT.GOAL, team: 1 }] });
  for (const c of cases) {
    const want = (c.lengthSec - c.slowmoTailSec) / c.speed + c.slowmoTailSec / SLOWMO_SPEED;
    near(r.start(c), want, 1e-9, `planned wall time ${JSON.stringify(c)}`);
    const dt = 1 / 60;
    const frames = playAll(r, dt);
    near(frames.length * dt, want, dt, 'played wall time (fixed dt)');
    const tailStart = 9000 - c.slowmoTailSec * 1000;
    for (let j = 1; j < frames.length; j++) {
      const h0 = playheadOf(frames[j - 1].res.state), h1 = playheadOf(frames[j].res.state);
      if (frames[j].res.slowmo !== (h1 > tailStart + 1e-6)) throw new Error('slowmo flag');
      if (h0 >= tailStart && j < frames.length - 1) near((h1 - h0) / dt, SLOWMO_SPEED * 1000, 1e-3, 'tail rate');
      if (h1 <= tailStart) near((h1 - h0) / dt, c.speed * 1000, 1e-3, 'normal rate');
    }
    // Same total with random frame times.
    r.start(c);
    const rnd = lcg(42);
    const fr2 = playAll(r, () => 0.002 + rnd() * 0.05);
    const sum = fr2.reduce((a, f) => a + f.dt, 0);
    assert(sum >= want - 1e-9 && sum - fr2[fr2.length - 1].dt < want, `random-dt wall ${sum} vs ${want}`);
  }
  // maxWallSec trims the run-up first, then the tail.
  near(r.start({ lengthSec: 3.5, speed: 0.6, slowmoTailSec: 1, maxWallSec: 4 }), 4, 1e-9, 'trimmed run-up');
  near(playheadOf(r.update(1e-9).state), 9000 - (1 + (4 - 1 / SLOWMO_SPEED) * 0.6) * 1000, 1e-3, 'trimmed start');
  near(r.start({ lengthSec: 3.5, speed: 0.6, slowmoTailSec: 1, maxWallSec: 2 }), 2, 1e-9, 'trimmed tail');
  near(playheadOf(r.update(1e-9).state), 9000 - 2 * SLOWMO_SPEED * 1000, 1e-3, 'all slow-mo');
  r.dispose();
});

test('slower finish at the end of the tail (finishSec / finishSpeed)', () => {
  const r = createReplay({ seconds: 5, container: null });
  record10s(r, { 540: [{ type: EVENT.GOAL, team: 1 }] });
  const c = { lengthSec: 3, speed: 1, slowmoTailSec: 1, finishSec: 0.4 };
  const want = 2 / 1 + 0.6 / SLOWMO_SPEED + 0.4 / FINISH_SPEED;
  near(r.start(c), want, 1e-9, 'planned wall time with a finish');
  const dt = 1 / 60;
  const frames = playAll(r, dt);
  near(frames.length * dt, want, dt, 'played wall time');
  const tailStart = 9000 - 1000, finStart = 9000 - 400;
  let sawFinish = false;
  for (let j = 1; j < frames.length - 1; j++) {
    const res = frames[j].res, h0 = playheadOf(frames[j - 1].res.state), h1 = playheadOf(res.state);
    if (res.slowmo !== (h1 > tailStart + 1e-6)) throw new Error('slowmo flag');
    if (h0 >= finStart) { near((h1 - h0) / dt, FINISH_SPEED * 1000, 1e-3, 'finish rate'); near(res.rate, FINISH_SPEED, 1e-12, 'finish rate field'); sawFinish = true; }
    else if (h0 >= tailStart && h1 <= finStart) near((h1 - h0) / dt, SLOWMO_SPEED * 1000, 1e-3, 'tail rate');
  }
  assert(sawFinish, 'played the finish');
  // maxWallSec trims the run-up, then the 0.35x part, then the finish
  const finW = 0.4 / FINISH_SPEED;
  near(r.start({ ...c, maxWallSec: finW + 0.5 }), finW + 0.5, 1e-9, 'trimmed into the 0.35x part');
  near(playheadOf(r.update(1e-9).state), 9000 - (0.4 + 0.5 * SLOWMO_SPEED) * 1000, 1e-3, 'tail start after trim');
  near(r.start({ ...c, maxWallSec: 1 }), 1, 1e-9, 'trimmed into the finish');
  near(playheadOf(r.update(1e-9).state), 9000 - FINISH_SPEED * 1000, 1e-3, 'all finish');
  // finishSec 0 (the default) is the plain two-speed replay
  near(r.start({ lengthSec: 3, speed: 1, slowmoTailSec: 1 }), 2 + 1 / SLOWMO_SPEED, 1e-9, 'no finish by default');
  r.dispose();
});

test('events re-fire exactly once per playback, in order, at the right time', () => {
  const r = createReplay({ seconds: 5, container: null });
  const E = {
    329: [{ type: EVENT.HIT, by: 0, target: 5, tag: 'before-window' }],
    330: [{ type: EVENT.SHOT, by: 1, power: 0.5, kind: 'wrist', tag: 'at-window-start' }],   // t = 5500 = t0
    390: [{ type: EVENT.PASS, by: 1, to: 2, tag: 'p' }, { type: EVENT.STEAL, by: 5, from: 2, tag: 's' }],
    480: [{ type: EVENT.HIT, by: 4, target: 1, power: 1, big: true, tag: 'h' }],
    540: [{ type: EVENT.GOAL, team: 0, scorer: 2, assist: 1, tag: 'g' }],
    570: [{ type: EVENT.FACEOFF, tag: 'after-goal' }],
  };
  record10s(r, E);
  const want = ['at-window-start', 'p', 's', 'h', 'g'];
  const wantT = { 'at-window-start': 5500, p: 6500, s: 6500, h: 8000, g: 9000 };
  const dtSeqs = [
    () => 1 / 60,
    (() => { const rnd = lcg(7); return (n) => (n === 40 ? 1.0 : 0.001 + rnd() * 0.12); })(),   // incl. one huge dt
    () => 10,                                                                                   // everything in one update
  ];
  for (const dtFn of dtSeqs) {
    assert(r.start({}) > 0, 'started');
    const got = [];
    let prevHead = -Infinity;
    const frames = playAll(r, dtFn);
    frames.forEach(({ res }) => {
      const head = playheadOf(res.state);
      for (const e of res.events) {
        got.push(e.tag);
        assert(e.replay === true, 'marked as replay');
        assert(wantT[e.tag] <= head + 1e-9 && wantT[e.tag] > prevHead - 1e-9, `${e.tag} fired when crossed`);
      }
      prevHead = head;
    });
    eq(got, want, 'event order');
    const lastEv = frames[frames.length - 1].res.events;
    assert(lastEv.length && lastEv[lastEv.length - 1].type === EVENT.GOAL, 'goal fires on the final frame');
  }
  // Payload preserved, originals untouched.
  r.start({});
  const all = playAll(r, 1 / 30).flatMap((f) => f.res.events);
  const g = all.find((e) => e.tag === 'g');
  assert(g.scorer === 2 && g.assist === 1 && g.team === 0, 'payload copied');
  assert(!('replay' in E[540][0]), 'original event not mutated');
  assert(all[1] !== E[390][0], 'copies, not the live objects');
  r.dispose();
});

test('update() returns null after the end, stop() skips, restart works', () => {
  const r = createReplay({ seconds: 5, container: null });
  assert(r.update(0.016) === null, 'null when idle');
  assert(r.start({}) === 0, 'nothing recorded yet => 0');
  record10s(r, { 540: [{ type: EVENT.GOAL, team: 0, tag: 'g' }], 400: [{ type: EVENT.SHOT, tag: 'shot' }] });
  r.start({});
  playAll(r, 0.05);
  assert(!r.isPlaying(), 'not playing after end');
  for (let i = 0; i < 3; i++) assert(r.update(0.016) === null, 'stays null');
  // stop mid-way
  r.start({});
  for (let i = 0; i < 10; i++) assert(r.update(1 / 60), 'playing');
  r.stop();
  assert(!r.isPlaying() && r.update(1 / 60) === null, 'stopped');
  r.stop();                                                       // idempotent
  // restart from the top: the shot (6667 ms) fires again
  r.start({});
  const tags = playAll(r, 1 / 60).flatMap((f) => f.res.events.map((e) => e.tag));
  eq(tags, ['shot', 'g'], 'full replay after a stop');
  // start() while playing restarts
  r.start({}); r.update(3); const W = r.start({ lengthSec: 1, slowmoTailSec: 0, speed: 1 });
  near(W, 1, 1e-9, 'restart'); near(playheadOf(r.update(1e-9).state), 8000, 1e-3, 'restarted window');
  r.dispose();
  assert(r.start({}) === 0 && r.update(1) === null, 'disposed');
});

test('null states ignored, recording frozen while playing, gaps reset the ring', () => {
  const r = createReplay({ seconds: 5, container: null });
  const st = record10s(r);
  const before = JSON.stringify(r.stats());
  r.record(null, [{ type: EVENT.GOAL }], 10020);
  r.record(undefined, NO_EV, 10040);
  r.record(st, NO_EV, NaN);
  eq(JSON.stringify(r.stats()), before, 'ignored');
  assert(Number.isNaN(r.lastGoalMs()), 'goal on a null state not recorded');
  // Frozen during playback (so the window being replayed can't be overwritten).
  r.start({ endMs: 10000 });
  for (let i = 1; i <= 200; i++) { setState(st, 10000 + i * 16); r.record(st, NO_EV, 10000 + i * 16); r.update(1 / 60); }
  eq(JSON.stringify(r.stats()), before, 'frozen while playing');
  r.stop();
  // After a long hole (here: the replay itself) the ring starts over.
  const t = 10000 + RESET_GAP_MS + 500;
  setState(st, t); r.record(st, NO_EV, t);
  assert(r.stats().frames === 1 && r.stats().toMs === t, 'reset after gap');
  // Clock going backwards also resets.
  r.record(st, NO_EV, t + 100); r.record(st, NO_EV, 50);
  assert(r.stats().frames === 1 && r.stats().toMs === 50, 'reset on backwards clock');
  r.dispose();
});

test('high-refresh displays: decimated to <= 75 Hz, still covers `seconds`, event frames kept', () => {
  const r = createReplay({ seconds: 5, container: null });
  // 144 Hz for 10 s; the goal lands on frame 1297 (an odd frame the decimator would otherwise drop).
  const st = makeState();
  const n = 1440;
  let goalT = 0;
  for (let i = 0; i <= n; i++) {
    const t = tOf(i, 144);
    setState(st, t);
    const ev = i === 1297 ? [{ type: EVENT.GOAL, team: 1 }] : NO_EV;
    if (ev !== NO_EV) goalT = t;
    r.record(st, ev, t);
  }
  const s = r.stats();
  assert(s.frames === s.capacity, 'full');
  assert(s.toMs - s.oldestMs >= 5000, `coverage ${s.toMs - s.oldestMs} ms`);
  near(s.fromMs, s.toMs - 5000, 1e-9, 'window');
  near(r.lastGoalMs(), goalT, 1e-9, 'goal time');
  r.start({});
  const frames = playAll(r, 1 / 144);
  const lastFrame = frames[frames.length - 1].res;
  near(playheadOf(lastFrame.state), goalT, 1e-6, 'goal frame was stored exactly');
  near(lastFrame.state.p[3].x, expX(3, goalT), 1e-4, 'state at goal');
  assert(lastFrame.events.some((e) => e.type === EVENT.GOAL), 'goal re-fires');
  r.dispose();
});

test('no allocation growth: 100k recorded frames, constant buffer size and heap', () => {
  let gc = null;
  try { v8.setFlagsFromString('--expose-gc'); gc = vm.runInNewContext('gc'); } catch { gc = null; }
  const r = createReplay({ seconds: 5, container: null });
  const st = makeState();
  const evPool = [{ type: EVENT.SHOT, by: 0 }, { type: EVENT.PASS, by: 1, to: 2 }];
  const goalPool = [{ type: EVENT.GOAL, team: 0 }];
  let i = 0;
  const run = (frames) => {
    for (const end = i + frames; i < end; i++) {
      const t = i * (1000 / 60);
      st.time = t; st.tick = i; st.clk = (i % 7200) / 60;
      const pl = st.p[i & 7]; pl.x = Math.sin(i * 0.01) * 20; pl.f = (i * 0.05) % 6.283; pl.s = (i >> 6) & 7;
      st.k.x = Math.cos(i * 0.01) * 25; st.k.o = (i >> 7) % 9 - 1;
      st.gl.length = (i >> 9) % 4; for (let g = 0; g < st.gl.length; g++) st.gl[g] = g * 3;
      r.record(st, i % 50 === 0 ? evPool : i % 997 === 0 ? goalPool : NO_EV, t);
    }
  };
  run(10000);                                   // warm up (JIT, ring full)
  const cap = r.stats().capacity, bytes = r.stats().bytes;
  if (gc) gc();
  const h0 = process.memoryUsage().heapUsed;
  for (let k = 0; k < 10; k++) {
    run(10000);
    const s = r.stats();
    assert(s.frames === cap && s.bytes === bytes && s.events <= 512, `ring size constant at ${i}`);
  }
  if (gc) {
    gc();
    const grow = process.memoryUsage().heapUsed - h0;
    assert(grow < 512 * 1024, `heap grew ${grow} bytes over 100k frames`);
    console.log(`     heap delta over 100k frames: ${(grow / 1024).toFixed(1)} KB; buffer ${(bytes / 1024).toFixed(1)} KB, ${cap} frames`);
  } else {
    console.log('     (gc not exposable; heap check skipped)');
  }
  // still replays fine after wrapping thousands of times
  const s = r.stats();
  if (r.lastGoalMs() < s.fromMs) assert(r.start({}) === 0, 'a goal older than the window is not replayable');
  assert(r.start({ endMs: s.toMs, lengthSec: 2 }) > 0 && r.update(0.1).state.p.length === 8, 'replay after wrap');
  r.dispose();
});

// ---- overlay with a tiny fake DOM ------------------------------------------------------------
class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.className = ''; this.textContent = ''; this.id = ''; this.style = {}; this.attrs = {};
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
}
function findAll(el, pred, out = []) { if (pred(el)) out.push(el); for (const c of el.children) findAll(c, pred, out); return out; }
const byClass = (root, cls) => findAll(root, (e) => e.className.split(' ').includes(cls))[0];
function makeFakeDoc() {
  const doc = { createElement: (t) => new FakeEl(t, doc) };
  doc.documentElement = new FakeEl('html', doc);
  doc.head = new FakeEl('head', doc);
  doc.body = new FakeEl('body', doc);
  doc.getElementById = (id) => findAll(doc.head, (e) => e.id === id)[0] || findAll(doc.body, (e) => e.id === id)[0] || null;
  return doc;
}

test('overlay: lazy, non-blocking, shows/hides with playback, progress + slow-mo tag', () => {
  const doc = makeFakeDoc();
  const r = createReplay({ seconds: 5, container: doc.body });
  record10s(r, { 540: [{ type: EVENT.GOAL, team: 0 }] });
  assert(doc.body.children.length === 0 && doc.head.children.length === 0, 'nothing built before start()');
  r.start({});
  const root = doc.body.children[0];
  assert(root && root.className.includes('ir-replay-root') && root.className.includes('ir-replay-on'), 'shown');
  assert(root.className.includes('ir-replay-fixed'), 'fixed when mounted on body');
  assert(root.attrs['aria-hidden'] === 'true', 'decorative');
  const style = doc.head.children[0];
  assert(style.tagName === 'STYLE' && style.id === 'ir-replay-style', 'style injected');
  assert(/\.ir-replay-root\{[^}]*pointer-events:none/.test(style.textContent.replace(/\s+/g, '')), 'root ignores pointer events');
  assert(/\.ir-replay-root\*\{pointer-events:none\}/.test(style.textContent.replace(/\s+/g, '')), 'children ignore pointer events');
  assert(/ir-replay-blink/.test(style.textContent) && /letterbox|ir-replay-top/.test(style.textContent), 'blink + bars');
  assert(byClass(root, 'ir-replay-word').textContent === 'Replay', 'bug text (sentence case)');
  assert(byClass(root, 'ir-replay-dot') && byClass(root, 'ir-replay-top') && byClass(root, 'ir-replay-bot'), 'dot + letterbox');
  assert(byClass(root, 'ir-replay-glyph').textContent === 'A' && byClass(root, 'ir-replay-skiptxt').textContent === 'Skip', 'A Skip glyph');
  assert(byClass(root, 'ir-replay-slo').textContent === 'Slow-mo 0.35×', `slow-mo chip: ${byClass(root, 'ir-replay-slo').textContent}`);
  // Design tokens with fallbacks, no shouting / glow / text shadows.
  const css = style.textContent;
  assert(/var\(--ground,#0A0F1C\)/.test(css) && /var\(--goal,#FF4B3E\)/.test(css) && /var\(--f-ui,Bahnschrift/.test(css), 'tokens');
  assert(!/text-shadow|box-shadow|letter-spacing|text-transform|gradient/.test(css), 'no shadow / glow / caps / gradients');
  assert(/prefers-reduced-motion/.test(css), 'reduced motion');
  // Root fades out in ~120 ms instead of vanishing.
  assert(/\.ir-replay-root\{[^}]*transition:opacity 120ms/.test(css.replace(/\n\s*/g, '')), 'exit fade');
  // The goal at frame 540 has no scorer here => no caption plate.
  assert(!root.className.includes('ir-replay-has-cap') && r.caption() === null, 'no caption without a scorer');
  const fill = byClass(root, 'ir-replay-fill');
  const bug = byClass(root, 'ir-replay-bug');
  r.update(1.0);
  assert(/^scaleX\(0\.1\d+\)$/.test(fill.style.transform), `progress ${fill.style.transform}`);
  assert(!bug.className.includes('ir-replay-is-slow'), 'not slow yet');
  r.update(4.5);
  assert(bug.className.includes('ir-replay-is-slow'), 'slow-mo tag in the tail');
  playAll(r, 1 / 60);
  assert(!root.className.includes('ir-replay-on'), 'hidden at the end');
  assert(fill.style.transform === 'scaleX(1.0000)', 'progress reached 1');
  r.start({});
  assert(root.className.includes('ir-replay-on') && doc.body.children.length === 1, 'reused on the next replay');
  assert(!bug.className.includes('ir-replay-is-slow'), 'slow tag reset');
  r.stop();
  assert(!root.className.includes('ir-replay-on'), 'hidden on stop');
  // The Skip glyph follows the device: keyboard/mouse = the bound shoot key, touch = Tap, pad = A.
  const glyph = byClass(root, 'ir-replay-glyph');
  r.setSkipHint({ device: 'keyboard', label: 'Left click' });
  assert(glyph.textContent === 'Left click' && glyph.className.includes('ir-replay-key'), `keyboard skip glyph: ${glyph.textContent}`);
  r.setSkipHint({ device: 'touch' });
  assert(glyph.textContent === 'Tap' && glyph.className.includes('ir-replay-tap'), 'touch skip glyph');
  r.setSkipHint({ device: 'gamepad', label: 'ignored' });
  assert(glyph.textContent === 'A' && glyph.className === 'ir-replay-glyph', 'pad skip glyph');
  r.setSkipHint({ device: 'keyboard', label: '' });
  r.start({});
  assert(glyph.textContent === 'Shoot' && r.skipHint().device === 'keyboard', 'unbound shoot key falls back to the word');
  r.stop();
  // A second instance shares the style tag.
  const r2 = createReplay({ seconds: 5, container: doc.body });
  record10s(r2); r2.start({});
  assert(doc.head.children.length === 1 && doc.body.children.length === 2, 'one style tag');
  r2.dispose();
  r.dispose();
  assert(doc.body.children.length === 0, 'dispose removes the overlay');
  // A bogus container never throws.
  const r3 = createReplay({ seconds: 5, container: {} });
  record10s(r3);
  assert(r3.start({}) > 0 && r3.update(0.1), 'works with a broken container');
  r3.dispose();
});

test('caption plate: scorer from the goal event, nameOf override, explicit and disabled captions', () => {
  // Roster names: teams [2, 4] => home = Neon Vipers (TEAMS[2]), away = Solar Flares (TEAMS[4]).
  const doc = makeFakeDoc();
  const r = createReplay({ seconds: 5, container: doc.body });
  record10s(r, { 540: [{ type: EVENT.GOAL, team: 0, scorer: 1, assist: 0, oneTimer: true }] });
  r.start({});
  eq(r.caption(), { name: 'Crane', detail: 'one-timer from Vex', team: 2 }, 'roster caption');
  const root = doc.body.children[0];
  assert(root.className.includes('ir-replay-has-cap'), 'caption shown');
  assert(byClass(root, 'ir-replay-who').textContent === 'Crane' && byClass(root, 'ir-replay-what').textContent === 'one-timer from Vex', 'caption text');
  const logo = byClass(root, 'ir-replay-logo');
  assert(logo && logo.tagName === 'IMG', 'crest slot');
  r.stop();
  // Explicit caption wins; false disables; a window that does not reach the goal has none.
  r.start({ caption: { name: 'Blade', detail: 'one-timer from Mags', team: 0 } });
  eq(r.caption(), { name: 'Blade', detail: 'one-timer from Mags', team: 0 }, 'explicit');
  r.start({ caption: false });
  assert(r.caption() === null && !root.className.includes('ir-replay-has-cap'), 'disabled');
  r.start({ endMs: 7000 });
  assert(r.caption() === null, 'window before the goal => no caption');
  r.start({ caption: { name: '  ' } });
  assert(r.caption() === null, 'blank name => no caption');
  r.dispose();

  // nameOf names the humans (controller c on the recorded player); assist / unassisted wording.
  const r2 = createReplay({ seconds: 5, container: null, nameOf: (id, p) => (p && p.c === 7 ? 'Blade' : null) });
  record10s(r2, { 540: [{ type: EVENT.GOAL, team: 0, scorer: 0, assist: 2 }] });
  r2.start({});
  eq(r2.caption(), { name: 'Blade', detail: 'assist Ito', team: 2 }, 'nameOf + assist');
  r2.dispose();
  const r3 = createReplay({ seconds: 5, container: null, nameOf: () => { throw new Error('boom'); } });
  record10s(r3, { 540: [{ type: EVENT.GOAL, team: 1, scorer: 5, assist: -1 }] });
  r3.start({});
  eq(r3.caption(), { name: 'Mbeki', detail: 'unassisted', team: 4 }, 'throwing nameOf falls back to the roster');
  r3.dispose();
});

test('replay cameras: findEventMs, tail + goal on each frame, tail camera chip', () => {
  const doc = makeFakeDoc();
  const r = createReplay({ seconds: 5, container: doc.body });
  // shot at 8.7 s, glass at 7.5 s, goal at 9.0 s (frames at 60 fps)
  record10s(r, {
    450: [{ type: EVENT.GLASS, panel: 3 }], 522: [{ type: EVENT.SHOT, by: 1 }],
    540: [{ type: EVENT.GOAL, team: 0, scorer: 1, x: 26.7, z: -0.4 }],
  });
  const isT = (t) => (e) => e.type === t;
  near(r.findEventMs(isT(EVENT.SHOT), 7900, 9000), tOf(522), 1e-6, 'shot time');
  near(r.findEventMs(isT(EVENT.GLASS), 4600, 9000), tOf(450), 1e-6, 'glass time');
  assert(Number.isNaN(r.findEventMs(isT(EVENT.GLASS), 7600, 9000)), 'glass before the range is not found');
  assert(Number.isNaN(r.findEventMs(isT(EVENT.SHOT), 8800, 9000)), 'shot before the range is not found');
  assert(Number.isNaN(r.findEventMs(isT(EVENT.FIGHT || 'nope'))), 'no match => NaN');
  assert(Number.isNaN(r.findEventMs(null)), 'bad predicate => NaN');
  assert(Number.isNaN(r.findEventMs(() => { throw new Error('boom'); })), 'throwing predicate => NaN');
  const fg = r.findEvent(isT(EVENT.GLASS), 4600, 9000);
  assert(fg && fg.event.panel === 3 && Math.abs(fg.ms - tOf(450)) < 1e-6, 'findEvent returns the event and its time');
  assert(r.findEvent(isT(EVENT.GLASS), 7600, 9000) === null, 'findEvent: none in range => null');
  // a beat past the goal, slow-mo from the shot: every frame knows the goal; tail flips on once
  assert(r.start({ endMs: 9300, lengthSec: 2, speed: 1, slowmoTailSec: 0.6, tailLabel: 'Goal cam' }) > 0, 'started');
  const root = doc.body.children[0], bug = byClass(root, 'ir-replay-bug'), cam = byClass(root, 'ir-replay-cam');
  assert(cam && cam.textContent === 'Goal cam' && bug.className.includes('ir-replay-has-cam'), 'camera chip text');
  const frames = playAll(r, 1 / 60);
  assert(frames.every((f) => f.res.goal && f.res.goal.x === 26.7 && f.res.goal.z === -0.4 && f.res.goal.team === 0), 'goal on every frame');
  const firstTail = frames.findIndex((f) => f.res.tail);
  assert(firstTail > 0 && frames.slice(firstTail).every((f) => f.res.tail && f.res.slowmo), 'tail stays on to the end');
  assert(frames.slice(0, firstTail).every((f) => !f.res.tail), 'not in the tail during the run-up');
  near(playheadOf(frames[firstTail].res.state), 8700, 12, 'tail starts at the shot');
  near(playheadOf(frames[frames.length - 1].res.state), 9300, 1e-3, 'ends a beat past the goal');
  assert(frames.every((f) => Math.abs(f.res.ms - playheadOf(f.res.state)) < 1e-6), 'ms is the record-clock playhead');
  // no label => no chip; a window that ends before the goal => no goal
  r.start({ tailLabel: '' });
  assert(!bug.className.includes('ir-replay-has-cam') && cam.textContent === '', 'no chip without a label');
  r.start({ endMs: 7000 });
  assert(r.update(0.1).goal === null, 'window before the goal => no goal');
  r.dispose();
});

test('goalCaption helper', () => {
  const st = { teams: [0, 1], p: [{ id: 3, tm: 0, c: 0 }, { id: 4, tm: 1, c: 2 }] };
  eq(goalCaption({ type: EVENT.GOAL, team: 0, scorer: 3, assist: -1 }, st), { name: 'Mertz', detail: 'unassisted', team: 0 }, 'goalie scores');
  eq(goalCaption({ type: EVENT.GOAL, team: 1, scorer: 4, assist: 6, oneTimer: true }, st, (id) => (id === 4 ? 'Mags' : '')),
    { name: 'Mags', detail: 'one-timer from Tamura', team: 1 }, 'one-timer, nameOf + roster');
  eq(goalCaption({ type: EVENT.GOAL, team: 1, scorer: 5, oneTimer: true }, st), { name: 'Bergeron-Ash', detail: 'one-timer', team: 1 }, 'unassisted one-timer');
  assert(goalCaption({ type: EVENT.GOAL, team: 0, scorer: -1 }, st) === null, 'no scorer');
  assert(goalCaption(null, st) === null && goalCaption({ scorer: 2 }, null).name === 'Lindqvist', 'tolerant inputs');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
