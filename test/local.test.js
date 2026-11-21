// ICE RIOT - tests for public/local.js (offline practice mode).
//
//   node test/local.test.js            stub sim suite, then the real shared/sim.js if it exists
//   node test/local.test.js --stub     stub sim only
//   node test/local.test.js --real     real sim only (fails if it is missing)
//   node test/local.test.js --sim URL  generic suite against any sim module URL
//
// The stub is an API-compatible miniature of shared/sim.js (CONTRACT "Sim API"). It is written
// to <tmp>/claude/ice-riot-local/stub-sim.js and loaded through createLocalSession's simUrl as a
// file:// URL, exactly like the browser loads the real one. It deliberately returns references
// to its internal objects from snapshot() to prove local.js keeps its own copies.
// Exit code 1 on any failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalSession, MAX_STEPS_PER_TICK, interpolateSnapshots } from '../public/local.js';
import { DT, TICK_RATE, PHASE, BTN, EVENT, TEAM_SIZE, DEFAULT_CONFIG } from '../shared/constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REAL_SIM = path.join(ROOT, 'shared', 'sim.js');
const FRAME = 1000 / 60;

// ------------------------------------------------------------------------------------------------
// tiny harness
// ------------------------------------------------------------------------------------------------
let passed = 0, failed = 0;
const failures = [];
class AssertError extends Error {}
function ok(cond, msg) { if (!cond) throw new AssertError(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new AssertError(`${msg || 'expected equal'}: got ${fmt(a)}, expected ${fmt(b)}`); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new AssertError(`${msg || 'expected near'}: got ${a}, expected ${b} +/- ${tol}`); }
const fmt = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) {
    failed++; failures.push(name);
    console.log(`  FAIL ${name}\n       ${e instanceof AssertError ? e.message : (e && e.stack) || e}`);
  }
}
const angDiff = (a, b) => { const d = ((a - b + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return Math.abs(d); };
const evType = (e) => (e && (e.type ?? e.t ?? e.e ?? e.ev ?? e.name)) ?? '?';

// ------------------------------------------------------------------------------------------------
// stub sim
// ------------------------------------------------------------------------------------------------
const STUB_SOURCE = String.raw`// API-compatible stub of shared/sim.js, written by test/local.test.js. Do not edit by hand.
const DT = 1 / 60;
const PH = { FACEOFF: 1, PLAY: 2, GOAL: 3, PERIOD_END: 4, GAME_OVER: 5 };
export const STUB = true;
export function createGame(config, seed) {
  if (!config || !Array.isArray(config.teams) || config.teams.length !== 2) throw new Error('stub: bad config');
  if (!Number.isInteger(seed)) throw new Error('stub: seed must be an integer, got ' + seed);
  const p = [];
  for (let tm = 0; tm < 2; tm++) for (let k = 0; k < 4; k++) {
    p.push({ id: tm * 4 + k, tm, g: k === 3 ? 1 : 0, x: tm ? 10 + k : -10 - k, y: 0, z: k * 2 - 3,
      vx: 0, vz: 0, f: tm ? Math.PI : 0, s: 0, sT: 0, tb: 1, fire: 0, ch: 0, c: 0, n: 10 + k });
  }
  return { config, seed, tick: 0, ph: PH.FACEOFF, phT: 1.6, per: 1, clk: config.periodLength, sc: [0, 0],
    teams: [...config.teams], p, k: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, o: -1 }, gl: [],
    queue: [{ type: 'period', period: 1 }], seq: 0, prevB: {} };
}
export function assignClient(g, team, cid) {
  for (let k = 0; k < 3; k++) { const pl = g.p[team * 4 + k]; if (!pl.c) { pl.c = cid; return pl.id; } }
  return -1;
}
export function releaseClient(g, cid) { for (const pl of g.p) if (pl.c === cid) pl.c = 0; delete g.prevB[cid]; }
export function step(g, dt, inputs) {
  if (dt !== DT) throw new Error('stub: dt must be DT, got ' + dt);
  if (!inputs || typeof inputs !== 'object') throw new Error('stub: inputsByClient must be an object');
  g.tick++;
  if (g.ph === PH.FACEOFF) {
    g.phT -= dt;
    if (g.phT <= 1e-9) { g.ph = PH.PLAY; g.phT = 0; g.queue.push({ type: 'faceoff', x: 0, z: 0 }); }
  } else if (g.ph === PH.PLAY) {
    g.clk = Math.max(0, g.clk - dt);
    if (g.config.stubOverAt && g.tick >= g.config.stubOverAt) { g.ph = PH.GAME_OVER; g.queue.push({ type: 'final', score: [...g.sc] }); }
  }
  // AI skater 1 (home, k=1): constant +6 m/s along X, teleports from x>20 back to -20
  const a = g.p[1];
  if (!a.c) { a.vx = 6; a.x += 6 * dt; if (a.x > 20) a.x -= 40; }
  // AI skater 2 (home, k=2): spins at 3 rad/s, facing kept in (-PI, PI]
  const b = g.p[2];
  if (!b.c) { b.f += 3 * dt; if (b.f > Math.PI) b.f -= 2 * Math.PI; }
  // human-controlled skaters follow input; SHOOT press edge -> shot event
  for (const pl of g.p) {
    if (!pl.c) continue;
    const inp = inputs[pl.c] || { mx: 0, mz: 0, b: 0 };
    pl.vx = inp.mx * 8; pl.vz = inp.mz * 8;
    pl.x += pl.vx * dt; pl.z += pl.vz * dt;
    const pb = g.prevB[pl.c] || 0;
    if ((inp.b & 1) && !(pb & 1)) g.queue.push({ type: 'shot', by: pl.id, power: 0.5, kind: 'wrist' });
    g.prevB[pl.c] = inp.b;
  }
  g.queue.push({ type: 'stubtick', seq: ++g.seq, tick: g.tick });
}
// deliberately aliases the game's internal objects
export function snapshot(g) { return { tick: g.tick, ph: g.ph, phT: g.phT, per: g.per, clk: g.clk, sc: g.sc, teams: g.teams, p: g.p, k: g.k, gl: g.gl }; }
export function drainEvents(g) { const out = g.queue; g.queue = []; return out; }
`;

function writeStub() {
  const dir = process.env.LOCAL_STUB_DIR || path.join(os.tmpdir(), 'claude', 'ice-riot-local');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'stub-sim.js');
  fs.writeFileSync(file, STUB_SOURCE);
  return pathToFileURL(file).href;
}

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------
// Run frames of `frameMs` (or a function i -> ms) for `totalMs`, starting after `t`. Returns
// { t, frames, events, last }.
function run(sess, t, totalMs, frameMs = FRAME, onFrame = null) {
  const events = [];
  let last = null, elapsed = 0, i = 0;
  while (elapsed < totalMs - 1e-6) {
    const ms = typeof frameMs === 'function' ? frameMs(i) : frameMs;
    elapsed += ms; t += ms; i++;
    if (onFrame) onFrame(sess, last, i);
    const r = sess.tick(t);
    for (const e of r.events) events.push(e);
    last = r.state;
  }
  return { t, frames: i, events, last };
}

const SNAP_KEYS = ['tick', 'ph', 'phT', 'per', 'clk', 'sc', 'teams', 'p', 'k', 'gl'];
const PLAYER_KEYS = ['id', 'tm', 'g', 'x', 'y', 'z', 'vx', 'vz', 'f', 's', 'sT', 'tb', 'fire', 'ch', 'c', 'n'];
const PUCK_KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'o'];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function checkSnapshotShape(st, time, cfgTeams) {
  ok(st && typeof st === 'object', 'state is an object');
  for (const k of SNAP_KEYS) ok(k in st, `snapshot has ${k}`);
  eq(st.time, time, 'state.time === nowMs');
  ok(Number.isInteger(st.tick) && st.tick >= 0, 'tick is a non-negative int');
  ok(Object.values(PHASE).includes(st.ph), `ph is a PHASE value (${st.ph})`);
  for (const k of ['phT', 'per', 'clk']) ok(isNum(st[k]), `${k} is a number`);
  ok(Array.isArray(st.sc) && st.sc.length === 2 && st.sc.every(Number.isInteger), 'sc = [int, int]');
  ok(Array.isArray(st.teams) && st.teams.length === 2, 'teams = [h, a]');
  if (cfgTeams) { eq(st.teams[0], cfgTeams[0], 'teams[0] matches config'); eq(st.teams[1], cfgTeams[1], 'teams[1] matches config'); }
  ok(Array.isArray(st.p) && st.p.length === 2 * TEAM_SIZE, 'p has 8 entries');
  st.p.forEach((p, i) => {
    for (const k of PLAYER_KEYS) ok(k in p, `p[${i}] has ${k}`);
    eq(p.id, i, `p[${i}].id`);
    eq(p.tm, Math.floor(i / TEAM_SIZE), `p[${i}].tm`);
    eq(p.g ? 1 : 0, i % TEAM_SIZE === 3 ? 1 : 0, `p[${i}].g`);
    for (const k of ['x', 'y', 'z', 'vx', 'vz', 'f', 'sT', 'tb', 'ch']) ok(isNum(p[k]), `p[${i}].${k} is a finite number (${p[k]})`);
    ok(Object.values({ a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7, i: 8 }).includes(p.s), `p[${i}].s is a PSTATE (${p.s})`);
    ok(Number.isInteger(p.c) && p.c >= 0, `p[${i}].c is a clientId or 0`);
  });
  ok(st.k && typeof st.k === 'object', 'k is an object');
  for (const k of PUCK_KEYS) ok(k in st.k && isNum(st.k[k]), `k.${k} is a number`);
  ok(Number.isInteger(st.k.o) && st.k.o >= -1 && st.k.o < 8, 'k.o is -1 or a player id');
  ok(Array.isArray(st.gl) && st.gl.every(Number.isInteger), 'gl is an int array');
  ok(!('ev' in st) && !('t' in st), 'no transport keys (t/ev) in state');
  const rt = JSON.parse(JSON.stringify(st));
  eq(JSON.stringify(rt), JSON.stringify(st), 'state is JSON-safe');
}

const controlled = (st, id = 1) => st.p.filter((p) => p.c === id);

// ------------------------------------------------------------------------------------------------
// generic suite: valid for the stub and the real sim
// ------------------------------------------------------------------------------------------------
async function genericSuite(simUrl, label) {
  console.log(`\n[${label}] generic suite (${simUrl})`);
  const mk = (o = {}) => createLocalSession({ simUrl, name: 'Tester', team: 0, seed: 1234, ...o });

  await test('lobby() has the CONTRACT lobby shape before start', async () => {
    const s = await mk({ config: { teams: [2, 3], periodLength: 60, difficulty: 2 } });
    eq(s.myId, 1, 'myId');
    const L = s.lobby();
    eq(L.state, 'lobby', 'state');
    eq(L.host, 1, 'host');
    ok(Array.isArray(L.clients) && L.clients.length === 1, 'one client');
    eq(JSON.stringify(L.clients[0]), JSON.stringify({ id: 1, name: 'Tester', team: 0, ping: 0 }), 'client entry');
    eq(L.config.teams.join(), '2,3', 'config.teams');
    eq(L.config.periodLength, 60, 'config.periodLength');
    eq(L.config.difficulty, 2, 'config.difficulty');
    eq(L.config.periods, DEFAULT_CONFIG.periods, 'config.periods default');
    const r = s.tick(5);
    eq(r.state, null, 'tick() before start -> null state');
    eq(r.events.length, 0, 'no events before start');
    s.dispose();
  });

  await test('start(): lobby goes to game, emits lobby event, human gets a home skater', async () => {
    const s = await mk();
    const seen = [];
    s.on('lobby', (m) => seen.push(m.state));
    const pid = s.start({ periodLength: 120 });
    ok(Number.isInteger(pid) && pid >= 0 && pid < 3, `start returns a home skater id (${pid})`);
    eq(s.lobby().state, 'game', 'lobby state');
    eq(seen.join(), 'game', 'lobby event');
    const r = s.tick(1000);
    ok(r.state, 'first tick returns a state');
    checkSnapshotShape(r.state, 1000, [0, 1]);
    const mine = controlled(r.state);
    eq(mine.length, 1, 'exactly one skater controlled by client 1');
    eq(mine[0].id, pid, 'controlled skater is the returned id');
    eq(mine[0].tm, 0, 'on home team');
    eq(mine[0].g, 0, 'not the goalie');
    s.dispose();
  });

  await test('sim advances at 60 Hz of injected real time (60 fps, 144 fps, jittery frames)', async () => {
    const s = await mk();
    s.start();
    let t = 10000;
    const t0 = s.tick(t).state.tick;
    let r = run(s, t, 2000, FRAME); t = r.t;
    near(r.last.tick - t0, 120, 1, '2 s @ 60 fps');
    let tb = r.last.tick;
    r = run(s, t, 1000, 1000 / 144); t = r.t;
    near(r.last.tick - tb, 60, 1, '1 s @ 144 fps');
    tb = r.last.tick;
    const jitter = [7, 25, 3, 31, 16, 18, 12, 40, 1, 47];   // sums to 200 ms
    r = run(s, t, 1000, (i) => jitter[i % jitter.length]); t = r.t;
    near(r.last.tick - tb, 60, 1, '1 s of jittery frames');
    s.dispose();
  });

  await test(`fixed-step catch-up is capped at ${MAX_STEPS_PER_TICK} steps per tick, backlog dropped`, async () => {
    const s = await mk();
    s.start();
    let t = 0;
    const t0 = s.tick(t).state.tick;
    let r = s.tick(t += 1000);                              // 1 s hitch
    eq(r.state.tick - t0, MAX_STEPS_PER_TICK, 'steps after a 1 s gap');
    const t1 = r.state.tick;
    r = s.tick(t += FRAME);
    ok(r.state.tick - t1 <= 2, `backlog dropped (next frame did ${r.state.tick - t1} steps)`);
    const t2 = r.state.tick;
    r = s.tick(t += 50);                                    // 3 ticks worth
    eq(r.state.tick - t2, 3, 'a 50 ms frame does 3 steps');
    const t3 = r.state.tick;
    r = s.tick(t += 60000);                                 // tab hidden for a minute
    eq(r.state.tick - t3, MAX_STEPS_PER_TICK, 'huge gap still capped');
    r = s.tick(t - 5000);                                   // clock going backwards: no steps, no throw
    ok(r.state, 'backwards time still returns a state');
    s.dispose();
  });

  await test('pause freezes the sim; resume does not jump', async () => {
    const s = await mk();
    s.start();
    let t = 0;
    s.tick(t);
    let r = run(s, t, 500); t = r.t;
    const before = r.last;
    s.pause(true);
    ok(s.isPaused(), 'isPaused() true');
    r = run(s, t, 3000); t = r.t;
    eq(r.last.tick, before.tick, 'tick frozen while paused');
    eq(r.events.length, 0, 'no events while paused');
    for (let i = 0; i < 8; i++) {
      near(r.last.p[i].x, before.p[i].x, 1e-9, `p[${i}].x frozen`);
      near(r.last.p[i].z, before.p[i].z, 1e-9, `p[${i}].z frozen`);
    }
    near(r.last.k.x, before.k.x, 1e-9, 'puck frozen');
    eq(r.last.clk, before.clk, 'clock frozen');
    eq(r.last.time, t, 'time still reported as nowMs while paused');
    s.pause(false);
    ok(!s.isPaused(), 'isPaused() false');
    r = s.tick(t += 10000);                                 // long gap since the pause began
    ok(r.state.tick - before.tick <= 1, `no catch-up burst after resume (${r.state.tick - before.tick} steps)`);
    r = run(s, t, 1000); t = r.t;
    near(r.last.tick - before.tick, 60, 2, 'runs normally again');
    s.dispose();
  });

  await test('events are returned exactly once (no object handed out twice)', async () => {
    const s = await mk();
    s.start();
    s.setInput({ mx: 1, mz: 0, b: BTN.TURBO });
    let t = 0;
    s.tick(t);
    const seen = new Set();
    let dup = 0, total = 0;
    run(s, t, 20000, (i) => (i % 7 === 0 ? 45 : FRAME), (sess, last, i) => {
      sess.setInput({ mx: Math.cos(i / 30), mz: Math.sin(i / 50), b: (i % 40 < 3 ? BTN.SHOOT : 0) | (i % 90 === 0 ? BTN.PASS : 0) | BTN.TURBO });
    }).events.forEach((e) => { total++; if (seen.has(e)) dup++; seen.add(e); });
    eq(dup, 0, 'duplicate event objects');
    ok(total > 0, `some events were produced in 20 s (${total})`);
    s.dispose();
  });

  await test('pick() switches control: home -> away -> spectate -> home', async () => {
    const s = await mk();
    s.start();
    let t = 0;
    let r = s.tick(t);
    eq(controlled(r.state).length, 1, 'one controlled');
    eq(controlled(r.state)[0].tm, 0, 'home');
    const pid1 = s.pick(1);
    ok(pid1 >= 4 && pid1 < 7, `pick(1) returns an away skater id (${pid1})`);
    r = s.tick(t += FRAME);
    eq(controlled(r.state).length, 1, 'one controlled after pick(1)');
    eq(controlled(r.state)[0].tm, 1, 'away');
    eq(controlled(r.state)[0].id, pid1, 'the id pick returned');
    eq(s.lobby().clients[0].team, 1, 'lobby team updated');
    r = run(s, t, 500); t = r.t;
    eq(controlled(r.last)[0].tm, 1, 'still away after running');
    eq(s.pick(-1), -1, 'pick(-1) returns -1');
    r = s.tick(t += FRAME);
    eq(controlled(r.state).length, 0, 'spectating: nobody controlled');
    eq(s.lobby().clients[0].team, -1, 'lobby team -1');
    r = run(s, t, 500); t = r.t;
    ok(r.last.tick > 0, 'AI-only game keeps running');
    const pid0 = s.pick(0);
    ok(pid0 >= 0 && pid0 < 3, 'back to home');
    r = s.tick(t += FRAME);
    eq(controlled(r.state).length, 1, 'controlled again');
    eq(controlled(r.state)[0].tm, 0, 'home again');
    s.dispose();
  });

  await test('pick() in the lobby sets the team used by start(); spectator start is AI vs AI', async () => {
    const s = await mk();
    s.pick(1);
    eq(s.lobby().clients[0].team, 1, 'lobby team');
    s.start();
    let r = s.tick(0);
    eq(controlled(r.state)[0].tm, 1, 'starts on away');
    s.backToLobby();
    s.pick(-1);
    eq(s.start(), -1, 'spectator start returns -1');
    r = s.tick(0);
    eq(controlled(r.state).length, 0, 'no human skater');
    r = run(s, 0, 2000);
    ok(r.last.tick >= 119, 'AI vs AI runs');
    s.dispose();
  });

  await test('backToLobby() and dispose()', async () => {
    const s = await mk();
    const seen = [];
    s.on('lobby', (m) => seen.push(m.state));
    s.start();
    run(s, 0, 300);
    s.backToLobby();
    eq(s.lobby().state, 'lobby', 'lobby state');
    eq(seen.join(), 'game,lobby', 'lobby events');
    eq(s.tick(500).state, null, 'tick in lobby -> null');
    s.start();
    ok(s.tick(600).state, 'can start again');
    s.dispose();
    const r = s.tick(700);
    eq(r.state, null, 'disposed -> null state');
    eq(r.events.length, 0, 'disposed -> no events');
  });

  await test('interpolated state stays between consecutive sim snapshots (positions/facing sane)', async () => {
    const s = await mk();
    s.start();
    s.setInput({ mx: 1, mz: 0.3, b: BTN.TURBO });
    let t = 0;
    s.tick(t);
    let prevSt = null, maxJump = 0;
    run(s, t, 8000, 25, (sess, last) => {
      if (last && prevSt) {
        for (let i = 0; i < 8; i++) {
          const d = Math.hypot(last.p[i].x - prevSt.p[i].x, last.p[i].z - prevSt.p[i].z);
          if (d < 4) maxJump = Math.max(maxJump, d);
        }
      }
      prevSt = last;
    });
    // 25 ms frames at <= ~15 m/s skating => well under 1 m per frame
    ok(maxJump < 1.0, `per-frame skater movement is smooth (max ${maxJump.toFixed(3)} m)`);
    s.dispose();
  });
}

// ------------------------------------------------------------------------------------------------
// stub-only checks (exact numbers we know from the stub)
// ------------------------------------------------------------------------------------------------
async function stubSuite(simUrl) {
  console.log(`\n[stub] exact checks`);
  const mk = (o = {}) => createLocalSession({ simUrl, name: 'Tester', team: 0, ...o });

  await test('stub actually loaded through simUrl', async () => {
    const mod = await import(simUrl);
    ok(mod.STUB === true, 'stub module');
  });

  await test('a 50/50/50/25 ms frame sequence = 10 steps, alpha 0.5 -> exact midpoint', async () => {
    const s = await mk();
    s.start();
    s.tick(0);
    let r;
    for (const t of [50, 100, 150, 175]) r = s.tick(t);
    eq(r.state.tick, 10, 'tick');
    near(r.state.p[1].x, -11 + 0.1 * 9.5, 1e-9, 'p[1].x midway between tick 9 and 10');
    near(r.state.p[1].vx, 6, 1e-12, 'vx');
    near(r.state.p[2].f, 3 * DT * 9.5, 1e-9, 'p[2].f midway');
    s.dispose();
  });

  await test('render state is exactly one tick behind real time (x and wrapped facing)', async () => {
    const s = await mk();
    s.start();
    s.tick(0);
    let maxErrX = 0, maxErrF = 0, wrapsSeen = 0, lastF = null;
    for (let t = 25; t <= 4000; t += 25) {
      const st = s.tick(t).state;
      const simT = t / 1000 - DT;                 // interpolated sim time
      if (simT <= 0) continue;
      maxErrX = Math.max(maxErrX, Math.abs(st.p[1].x - (-11 + 6 * simT)));
      maxErrF = Math.max(maxErrF, angDiff(st.p[2].f, 3 * simT));
      if (lastF !== null && Math.abs(st.p[2].f - lastF) > Math.PI) wrapsSeen++;
      lastF = st.p[2].f;
    }
    ok(maxErrX < 1e-6, `x error ${maxErrX}`);
    ok(maxErrF < 1e-6, `facing error ${maxErrF} (lerpAngle across the +/-PI wrap)`);
    ok(wrapsSeen >= 1, 'facing wrapped at least once');
    s.dispose();
  });

  await test('teleports (>4 m in one tick) snap instead of lerping', async () => {
    const s = await mk();
    s.start();
    s.tick(0);
    let t = 0, sawWrap = false;
    let prevX = null;
    while (t < 7000) {
      t += 25;
      const x = s.tick(t).state.p[1].x;
      if (prevX !== null && x < prevX - 4) {
        sawWrap = true;
        ok(x < -19, `after the jump x is at the new spot (${x}), not midway`);
      }
      prevX = x;
    }
    ok(sawWrap, 'stub skater wrapped around');
    s.dispose();
  });

  await test('every step\'s events delivered exactly once, in order (seq contiguous)', async () => {
    const s = await mk();
    s.start();
    let t = 0;
    s.tick(t);
    const seqs = [];
    const r = run(s, t, 5000, (i) => [16, 17, 3, 70, 33, 1, 400][i % 7]);
    for (const e of r.events) if (e.type === 'stubtick') seqs.push(e.seq);
    eq(seqs.length, r.last.tick, 'one stubtick event per step');
    for (let i = 0; i < seqs.length; i++) if (seqs[i] !== i + 1) throw new AssertError(`seq ${i} = ${seqs[i]}`);
    s.pause(true);
    eq(run(s, r.t, 1000).events.length, 0, 'paused -> nothing');
    s.dispose();
  });

  await test('events queued by createGame arrive with the first step', async () => {
    const s = await mk();
    s.start();
    let r = s.tick(0);
    eq(r.events.length, 0, 'time-base tick has no steps');
    r = s.tick(FRAME);
    eq(evType(r.events[0]), 'period', 'setup event first');
  });

  await test('input reaches the sim for myId; values sanitized and copied', async () => {
    const s = await mk();
    s.start();
    let t = 0;
    s.tick(t);
    const inp = { mx: 5, mz: NaN, b: 0 };
    s.setInput(inp);
    inp.mx = -1; // mutating the caller's object afterwards must not matter
    const r = run(s, t, 500); t = r.t;
    const me = controlled(r.last)[0];
    near(me.vx, 8, 1e-9, 'mx clamped to 1 -> vx 8');
    near(me.vz, 0, 1e-9, 'NaN -> 0');
    s.dispose();
  });

  await test('a tap shorter than one sim step is latched; holding fires once', async () => {
    const s = await mk();
    s.start();
    let t = 0;
    s.tick(t);
    s.tick(t += 5);
    s.setInput({ mx: 0, mz: 0, b: BTN.SHOOT });   // pressed ...
    s.tick(t += 5);                                 // (no step yet)
    s.setInput({ mx: 0, mz: 0, b: 0 });            // ... released before any step ran
    let shots = run(s, t, 200).events.filter((e) => e.type === 'shot').length; t += 200;
    eq(shots, 1, 'quick tap -> one shot');
    s.setInput({ mx: 0, mz: 0, b: BTN.SHOOT });
    shots = run(s, t, 1000).events.filter((e) => e.type === 'shot').length; t += 1000;
    eq(shots, 1, 'hold -> exactly one press edge');
    s.setInput({ mx: 0, mz: 0, b: 0 });
    run(s, t, 100); t += 100;
    s.setInput({ mx: 0, mz: 0, b: BTN.SHOOT });
    shots = run(s, t, 100).events.filter((e) => e.type === 'shot').length;
    eq(shots, 1, 'second press -> second shot');
    s.dispose();
  });

  await test('taps while paused are not latched into the first step after resume', async () => {
    const s = await mk();
    s.start();
    let t = 0;
    s.tick(t);
    s.pause(true);
    s.setInput({ mx: 0, mz: 0, b: BTN.SHOOT });
    s.setInput({ mx: 0, mz: 0, b: 0 });
    run(s, t, 300); t += 300;
    s.pause(false);
    eq(run(s, t, 300).events.filter((e) => e.type === 'shot').length, 0, 'no shot from a menu key press');
    s.dispose();
  });

  await test('spectator sends no input; release on pick(-1)', async () => {
    const s = await mk({ team: -1 });
    eq(s.start(), -1, 'no skater');
    s.setInput({ mx: 1, mz: 0, b: BTN.SHOOT });
    const r = run(s, 0, 500);
    eq(r.events.filter((e) => e.type === 'shot').length, 0, 'no shots');
    s.dispose();
  });

  await test('GAME_OVER -> automatic return to the lobby after autoLobbyMs (and 0 disables it)', async () => {
    const s = await mk({ autoLobbyMs: 1000, config: { stubOverAt: 120 } });
    const seen = [];
    s.on('lobby', (m) => seen.push(m.state));
    s.start();
    let t = 0;
    s.tick(t);
    let r = run(s, t, 2100); t = r.t;                         // tick 120 = GAME_OVER, +60 ticks = 1 s
    ok(r.events.some((e) => e.type === 'final'), 'final event delivered');
    ok(r.last && r.last.ph === PHASE.GAME_OVER, 'still showing GAME_OVER before the timeout');
    r = run(s, t, 1200); t = r.t;
    eq(r.last, null, 'back in the lobby');
    eq(s.lobby().state, 'lobby', 'lobby state');
    eq(seen.join(), 'game,lobby', 'lobby events');
    s.dispose();
    const s2 = await mk({ autoLobbyMs: 0, config: { stubOverAt: 120 } });
    s2.start();
    s2.tick(0);
    r = run(s2, 0, 30000);
    eq(r.last.ph, PHASE.GAME_OVER, 'autoLobbyMs 0 stays on GAME_OVER');
    s2.dispose();
  });

  await test('random seed per game unless a seed is given', async () => {
    const seeds = new Set();
    const mod = await import(simUrl);
    const spy = { ...mod, createGame: (c, seed) => { seeds.add(seed); return mod.createGame(c, seed); } };
    const s = await mk({ sim: spy });
    for (let i = 0; i < 5; i++) s.start();
    ok(seeds.size >= 4, `random seeds (${[...seeds].join(',')})`);
    for (const sd of seeds) ok(Number.isInteger(sd) && sd > 0, 'positive integer seed');
    seeds.clear();
    const s2 = await mk({ sim: spy, seed: 42 });
    s2.start(); s2.start();
    eq([...seeds].join(), '42', 'fixed seed');
  });

  await test('a sim crash mid-game -> back to the lobby + err event (no throw into the rAF loop)', async () => {
    const mod = await import(simUrl);
    let boom = false;
    const flaky = { ...mod, step: (g, dt, inp) => { if (boom) throw new Error('kaboom'); return mod.step(g, dt, inp); } };
    const s = await mk({ sim: flaky });
    const errs = [], lobbies = [];
    s.on('err', (m) => errs.push(m.msg));
    s.on('lobby', (m) => lobbies.push(m.state));
    s.start();
    run(s, 0, 200);
    boom = true;
    const r = s.tick(1000);
    eq(r.state, null, 'null state');
    eq(s.lobby().state, 'lobby', 'lobby');
    ok(errs.length === 1 && /crashed.*kaboom/.test(errs[0]), `err event (${errs[0]})`);
    eq(lobbies.join(), 'game,lobby', 'lobby events');
    s.dispose();
  });

  await test('asNet() facade mirrors the createNet() surface', async () => {
    const s = await mk();
    const conn = s.asNet();
    ok(conn === s.asNet(), 'same facade every call');
    for (const fn of ['on', 'getState', 'takeEvents', 'serverNow', 'retryIn', 'connected', 'pick', 'sendConfig', 'start', 'toLobby', 'sendInput', 'setName', 'reconnectNow', 'connect']) {
      eq(typeof conn[fn], 'function', `conn.${fn}`);
    }
    eq(conn.myId, 1, 'myId');
    eq(conn.status, 'online', 'status');
    ok(conn.connected(), 'connected()');
    eq(conn.lobby.state, 'lobby', 'lobby is a property (message), like net.lobby');
    const seen = [];
    conn.on('lobby', (m, prev) => seen.push(`${prev && prev.state}->${m.state}`));
    conn.sendConfig({ teams: [4, 5], periodLength: 180, difficulty: 0 });
    eq(conn.lobby.config.teams.join(), '4,5', 'sendConfig applied');
    eq(conn.gameSerial, 0, 'gameSerial before start');
    conn.start();
    eq(conn.gameSerial, 1, 'gameSerial after start');
    eq(conn.lobby.state, 'game', 'lobby.state game');
    ok(conn.getState(0), 'getState returns a state');
    conn.sendInput(1, 0, 0, BTN.SHOOT);
    conn.getState(50);
    const st = conn.getState(100);
    eq(st.tick, 6, 'getState advanced the sim');
    const ev = conn.takeEvents();
    ok(ev.some((e) => e.type === 'shot'), 'sendInput reached the sim');
    eq(ev.filter((e) => e.type === 'stubtick').length, 6, 'events from getState()');
    eq(conn.takeEvents().length, 0, 'takeEvents drains');
    conn.pick(1);
    eq(conn.lobby.clients[0].team, 1, 'pick via facade');
    conn.toLobby();
    eq(conn.getState(200), null, 'toLobby -> null state');
    eq(seen.join(), 'lobby->lobby,lobby->game,game->game,game->lobby', 'lobby events (config, start, pick, lobby)');
    conn.dispose();
    eq(conn.status, 'closed', 'closed after dispose');
  });

  await test('interpolateSnapshots() returns fresh objects (sim internals never exposed)', async () => {
    const s = await mk();
    s.start();
    const a = s.tick(0).state;
    a.p[0].x = 999; a.k.x = 999; a.sc[0] = 99;
    const b = s.tick(1).state;
    ok(b.p[0].x !== 999 && b.k.x !== 999 && b.sc[0] !== 99, 'mutating a returned state does not leak');
    const out = interpolateSnapshots(null, b, 0.5, 7);
    eq(out.time, 7, 'time');
    s.dispose();
  });
}

async function loadErrorsSuite(stubUrl) {
  console.log(`\n[errors] module loading`);
  await test('missing sim file -> clear error from createLocalSession', async () => {
    const bad = pathToFileURL(path.join(os.tmpdir(), 'claude', 'ice-riot-local', 'does-not-exist.js')).href;
    let err = null;
    try { await createLocalSession({ simUrl: bad }); } catch (e) { err = e; }
    ok(err, 'rejected');
    ok(/could not load the game simulation/.test(err.message), `message: ${err.message}`);
    ok(err.message.includes('does-not-exist.js'), 'message names the URL');
  });
  await test('sim without the required exports -> clear error', async () => {
    let err = null;
    try { await createLocalSession({ simUrl: 'data:text/javascript,export const createGame = () => ({});' }); } catch (e) { err = e; }
    ok(err && /missing export\(s\): step, snapshot, drainEvents, assignClient, releaseClient/.test(err.message), `message: ${err && err.message}`);
  });
  await test('stub loads by file:// URL', async () => {
    const s = await createLocalSession({ simUrl: stubUrl });
    eq(s.myId, 1, 'myId');
  });
}

// ------------------------------------------------------------------------------------------------
// real sim: a 30-s scripted offline game (+ a full short game)
// ------------------------------------------------------------------------------------------------
function botInput(st, myId) {
  // Scripted human for team 0 (attacks +X): chase the puck with turbo; with the puck skate at the
  // +X goal and shoot from range; without it, body-check / poke when close; pass now and then.
  const me = st.p.find((p) => p.c === myId);
  if (!me) return { mx: 0, mz: 0, b: 0 };
  const k = st.k;
  const haveIt = k.o === me.id;
  let tx, tz, b = 0;
  const tick = st.tick;
  if (haveIt) {
    tx = 24; tz = 0;
    if (me.x > 14 && tick % 30 < 2) b |= BTN.SHOOT;
    else if (tick % 240 < 2) b |= BTN.PASS;
    b |= BTN.TURBO;
  } else {
    tx = k.x; tz = k.z;
    const d = Math.hypot(k.x - me.x, k.z - me.z);
    if (d < 3) b |= tick % 20 < 2 ? BTN.SHOOT : 0;
    if (d < 2) b |= tick % 25 < 2 ? BTN.ACTION : 0;
    if (d > 6) b |= BTN.TURBO;
  }
  let mx = tx - me.x, mz = tz - me.z;
  const L = Math.hypot(mx, mz) || 1;
  mx /= L; mz /= L;
  return { mx, mz, b };
}

async function realGame(simUrl) {
  console.log(`\n[real sim] scripted offline games`);
  await test('default simUrl (../shared/sim.js relative to public/local.js) loads the real sim', async () => {
    const s = await createLocalSession();
    s.start();
    ok(s.tick(0).state, 'state');
    s.dispose();
  });

  await test('30 s of simulated offline play with scripted inputs', async () => {
    const wall0 = performance.now();
    const s = await createLocalSession({ simUrl, name: 'Bot', team: 0, config: { periodLength: 120, difficulty: 1 } });
    s.start();
    let t = 0;
    let st = s.tick(t).state;
    const counts = {};
    let frames = 0, maxSteps = 0, prevTick = st.tick;
    const startTick = st.tick;
    while (t < 30000) {
      const ms = frames % 11 === 0 ? 33 : FRAME;           // a little frame jitter
      t += ms; frames++;
      s.setInput(botInput(st, s.myId));
      const r = s.tick(t);
      st = r.state;
      maxSteps = Math.max(maxSteps, st.tick - prevTick); prevTick = st.tick;
      for (const e of r.events) { const ty = evType(e); counts[ty] = (counts[ty] || 0) + 1; }
      if (frames === 1 || frames % 600 === 0) checkSnapshotShape(st, t, [0, 1]);
    }
    const simSec = (st.tick - startTick) / TICK_RATE;
    near(simSec, 30, 0.1, 'simulated seconds');
    ok(maxSteps <= MAX_STEPS_PER_TICK, 'cap respected');
    const totalEv = Object.values(counts).reduce((a, b) => a + b, 0);
    const wallMs = performance.now() - wall0;
    console.log(`       score ${st.sc[0]}-${st.sc[1]}  period ${st.per}  clock ${st.clk.toFixed(1)}s  phase ${st.ph}  ticks ${st.tick}  frames ${frames}  (${wallMs.toFixed(0)} ms wall, ${(wallMs / (st.tick - startTick) * 1000).toFixed(0)} us per step incl. interpolation)`);
    console.log(`       events (${totalEv}): ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    ok(st.clk < 120, 'game clock ran');
    ok(totalEv > 0, 'events were produced');
    ok(counts[EVENT.FACEOFF] >= 1, 'at least one faceoff event');
    s.dispose();
  });

  await test('full short game (3 x 10 s periods) reaches GAME_OVER, then auto-returns to the lobby', async () => {
    const s = await createLocalSession({ simUrl, name: 'Bot', team: 0, config: { periodLength: 10 } });
    let lobbyEvents = [];
    s.on('lobby', (m) => lobbyEvents.push(m.state));
    s.start();
    let t = 0;
    let st = s.tick(t).state;
    const counts = {};
    let overAt = -1, final = null;
    // up to 20 min of sim (sudden-death OT can run long)
    while (t < 20 * 60 * 1000) {
      t += 50;                                                // 20 fps "browser": 3 steps / tick
      s.setInput(st ? botInput(st, s.myId) : { mx: 0, mz: 0, b: 0 });
      const r = s.tick(t);
      for (const e of r.events) { const ty = evType(e); counts[ty] = (counts[ty] || 0) + 1; if (ty === EVENT.FINAL) final = e; }
      if (!r.state) break;
      st = r.state;
      if (st.ph === PHASE.GAME_OVER && overAt < 0) overAt = t;
    }
    ok(overAt >= 0, 'reached GAME_OVER');
    console.log(`       final ${st.sc[0]}-${st.sc[1]} after period ${st.per} (${(overAt / 1000).toFixed(1)} s)  final event: ${fmt(final)}`);
    console.log(`       events: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    near(t - overAt, 12000, 100, 'auto lobby ~12 s after GAME_OVER');
    eq(s.lobby().state, 'lobby', 'lobby');
    eq(lobbyEvents.join(), 'game,lobby', 'lobby events');
    ok(final, 'FINAL event delivered');
    s.dispose();
  });
}

// ------------------------------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--stub') ? 'stub' : args.includes('--real') ? 'real' : null;
  const simIdx = args.indexOf('--sim');
  if (simIdx >= 0) {
    await genericSuite(args[simIdx + 1], 'custom');
  } else {
    if (only !== 'real') {
      const stubUrl = writeStub();
      await loadErrorsSuite(stubUrl);
      await genericSuite(stubUrl, 'stub');
      await stubSuite(stubUrl);
    }
    if (only !== 'stub') {
      let mod = null, why = '';
      if (!fs.existsSync(REAL_SIM)) why = 'shared/sim.js does not exist yet';
      else {
        try { mod = await import(pathToFileURL(REAL_SIM).href); }
        catch (e) { failed++; failures.push('import shared/sim.js'); console.log(`\n  FAIL import shared/sim.js\n       ${(e && e.stack) || e}`); }
        if (mod && typeof mod.createGame !== 'function') { why = 'shared/sim.js has no createGame export yet'; mod = null; }
      }
      if (mod) {
        const realUrl = pathToFileURL(REAL_SIM).href;
        await genericSuite(realUrl, 'real sim');
        await realGame(realUrl);
      } else if (why) {
        if (only === 'real') { failed++; failures.push(why); }
        console.log(`\n[real sim] SKIPPED: ${why}`);
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed${failed ? ': ' + failures.join(' | ') : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
