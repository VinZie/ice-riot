// Unit tests for the pure interpolation / clock-sync core in public/net.js.
// Run: node test/interp.test.js   (exits 1 on failure)
import {
  lerpAngle, lerpSnapshots, extrapolateSnapshot, createInterpBuffer, pushSnap, sampleAt,
  resetBuffer, clockSample, estimateClock, targetInterpDelay, TELEPORT_DIST, MAX_EXTRAP_MS,
  coastSeconds, MIN_INTERP_DELAY_MS, createCorrector,
} from '../public/net.js';

let failures = 0, passes = 0;
function test(name, fn) {
  try { fn(); passes++; console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, eps = 1e-6, msg = '') {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg} expected ${b}, got ${a}`);
}
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

function player(id, over = {}) {
  return { id, tm: id < 4 ? 0 : 1, g: id % 4 === 3 ? 1 : 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, f: 0,
    s: 0, sT: 0, tb: 1, fire: 0, ch: 0, c: 0, n: 10 + id, ...over };
}
function snap(time, over = {}) {
  const s = {
    t: 'snap', time, tick: Math.round(time / 1000 * 60), ph: 2, phT: 0, per: 1, clk: 100, sc: [0, 0],
    teams: [0, 1], p: Array.from({ length: 8 }, (_, i) => player(i)),
    k: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, o: -1 }, gl: [], ev: [],
  };
  return Object.assign(s, over);
}

console.log('interp.test.js');

test('midpoint lerp of positions / velocities / turbo / clock', () => {
  const a = snap(1000, { clk: 100 });
  const b = snap(1100, { clk: 99.9 });
  a.p[0] = player(0, { x: 0, z: 2, vx: 4, vz: 0, tb: 1.0, f: 0 });
  b.p[0] = player(0, { x: 2, z: 4, vx: 8, vz: 2, tb: 0.5, f: 1 });
  a.k = { x: 5, y: 0, z: 0, vx: 0, vy: 0, vz: 0, o: -1 };
  b.k = { x: 7, y: 0.4, z: -2, vx: 10, vy: 2, vz: 0, o: -1 };
  const s = lerpSnapshots(a, b, 1050);
  near(s.p[0].x, 1); near(s.p[0].z, 3); near(s.p[0].vx, 6); near(s.p[0].vz, 1);
  near(s.p[0].tb, 0.75); near(s.p[0].f, 0.5);
  near(s.k.x, 6); near(s.k.y, 0.2); near(s.k.z, -1); near(s.k.vx, 5);
  near(s.clk, 99.95); near(s.time, 1050);
  assert(!('ev' in s) && !('t' in s), 'transport fields should be stripped');
});

test('discrete fields come from the newer snapshot', () => {
  const a = snap(1000, { sc: [0, 0], ph: 2 });
  const b = snap(1033, { sc: [1, 0], ph: 3, gl: [5] });
  a.p[1] = player(1, { s: 0, sT: 1.0, c: 0, fire: 0 });
  b.p[1] = player(1, { s: 3, sT: 0.02, c: 7, fire: 1 });
  b.k.o = 2;
  const s = lerpSnapshots(a, b, 1010);
  assert(s.sc[0] === 1 && s.ph === 3 && s.gl[0] === 5, 'snapshot-level discrete fields');
  assert(s.p[1].s === 3 && s.p[1].c === 7 && s.p[1].fire === 1, 'player discrete fields');
  near(s.p[1].sT, 0, 1e-9, 'sT wound back to render time and clamped at 0:');
  assert(s.k.o === 2, 'puck owner from newer');
});

test('facing lerp wraps across +/-pi (shortest path)', () => {
  const a = snap(0), b = snap(100);
  a.p[2] = player(2, { f: Math.PI - 0.1 });
  b.p[2] = player(2, { f: -Math.PI + 0.1 });
  const s = lerpSnapshots(a, b, 50);
  near(angDiff(s.p[2].f, Math.PI), 0, 1e-9, 'midpoint should be pi:');
  near(angDiff(lerpAngle(0.2, -0.2 + 2 * Math.PI, 0.5), 0), 0, 1e-9, 'wrapped zero');
  // the quarter point lies on the short arc, not through 0
  const q = lerpSnapshots(a, b, 25).p[2].f;
  near(angDiff(q, Math.PI - 0.05), 0, 1e-9, 'quarter point:');
});

test('teleport > 4 m snaps instead of lerping (players and puck)', () => {
  const a = snap(0), b = snap(100, { ph: 1 });
  a.p[0] = player(0, { x: -20, z: 5 });
  b.p[0] = player(0, { x: -2, z: 0 });       // faceoff reset
  a.p[1] = player(1, { x: 0, z: 0 });
  b.p[1] = player(1, { x: TELEPORT_DIST * 0.5, z: 0 }); // ordinary move, lerped
  a.k = { x: 20, y: 0, z: 3, vx: 0, vy: 0, vz: 0, o: -1 };
  b.k = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, o: -1 };
  const s = lerpSnapshots(a, b, 10);
  near(s.p[0].x, -2); near(s.p[0].z, 0);
  near(s.p[1].x, TELEPORT_DIST * 0.5 * 0.1);
  near(s.k.x, 0); near(s.k.z, 0);
});

test('buffer: interpolates between the bracketing pair', () => {
  const buf = createInterpBuffer();
  for (let i = 0; i < 5; i++) {
    const s = snap(1000 + i * 33);
    s.p[0] = player(0, { x: i });
    pushSnap(buf, s);
  }
  const r = sampleAt(buf, 1000 + 2.5 * 33);
  assert(r.mode === 'interp', 'mode ' + r.mode);
  near(r.state.p[0].x, 2.5, 1e-9);
  assert(!pushSnap(buf, snap(1000 + 33)), 'stale/duplicate snapshot rejected');
});

test('events are released exactly once, in order, when render time passes them', () => {
  const buf = createInterpBuffer();
  const times = [1000, 1033, 1066, 1100, 1133];
  times.forEach((t, i) => pushSnap(buf, snap(t, { ev: [{ type: 'e', n: i * 2 }, { type: 'e', n: i * 2 + 1 }] })));
  const got = [];
  const take = (rt) => { const r = sampleAt(buf, rt); for (const e of r.events) got.push(e.n); return r; };
  take(990);
  assert(got.length === 0, 'nothing before the first snapshot: ' + got);
  take(1000);                        // reaches snap 0 exactly
  assert(got.join() === '0,1', 'first release ' + got);
  take(1000); take(1010); take(1032);
  assert(got.join() === '0,1', 'no re-release ' + got);
  take(1100);                        // jumps over 1033 + 1066 + reaches 1100
  assert(got.join() === '0,1,2,3,4,5,6,7', 'catch-up release in order ' + got);
  take(1090);                        // render time can't go backwards
  take(5000);
  take(6000);
  assert(got.join() === '0,1,2,3,4,5,6,7,8,9', 'all released exactly once ' + got);
  // a late snapshot (behind render time) still releases its events on the next sample
  pushSnap(buf, snap(5500, { ev: [{ n: 10 }] }));
  take(6000);
  assert(got.join() === '0,1,2,3,4,5,6,7,8,9,10', 'late snapshot events ' + got);
});

test('extrapolation is bounded (MAX_EXTRAP_MS) and coasts when starved', () => {
  const buf = createInterpBuffer();
  const a = snap(1000), b = snap(1033);
  a.p[0] = player(0, { x: 0, vx: 10 });
  b.p[0] = player(0, { x: 0.33, vx: 10 });
  b.k = { x: 1, y: 0, z: 0, vx: 20, vy: 0, vz: 0, o: -1 };
  pushSnap(buf, a); pushSnap(buf, b);
  const r1 = sampleAt(buf, 1033 + 50);
  assert(r1.mode === 'extrap', 'mode ' + r1.mode);
  near(r1.state.p[0].x, 0.33 + 10 * 0.05, 1e-9, '50 ms extrapolation:');
  near(r1.state.k.x, 1 + 20 * 0.05, 1e-9, 'puck 50 ms:');
  const r2 = sampleAt(buf, 1033 + 1000);
  near(r2.state.p[0].x, 0.33 + 10 * coastSeconds(MAX_EXTRAP_MS), 1e-9, 'clamped (coasting) extrapolation:');
  assert(coastSeconds(MAX_EXTRAP_MS) < MAX_EXTRAP_MS / 1000, 'velocity decays after the linear window');
  near(coastSeconds(80), 0.08, 1e-12, 'linear inside the first 100 ms:');
  near(r2.state.time, 1033 + MAX_EXTRAP_MS, 1e-9, 'clamped time:');
  near(extrapolateSnapshot(b, 1e6).clk, 100 - MAX_EXTRAP_MS / 1000, 1e-9, 'clock runs during PLAY:');
});

test('buffer reset flushes unreleased events and empties the buffer', () => {
  const buf = createInterpBuffer();
  pushSnap(buf, snap(1000, { ev: [{ n: 1 }] }));
  pushSnap(buf, snap(1033, { ev: [{ n: 2 }] }));
  pushSnap(buf, snap(1066, { ev: [{ n: 3 }] }));
  const r = sampleAt(buf, 1010);
  assert(r.events.map((e) => e.n).join() === '1', 'released first');
  const flushed = resetBuffer(buf);
  assert(flushed.map((e) => e.n).join() === '2,3', 'flush returns the rest in order: ' + flushed.map((e) => e.n));
  const r2 = sampleAt(buf, 2000);
  assert(r2.state === null && r2.mode === 'empty' && r2.events.length === 0, 'empty after reset');
  // after a reset the buffer accepts earlier times again (e.g. a server restart)
  assert(pushSnap(buf, snap(10)), 'accepts new timeline');
  assert(sampleAt(buf, 10).state !== null, 'samples new timeline');
});

test('new game (tick goes backwards) resets the buffer but keeps old events', () => {
  const buf = createInterpBuffer();
  pushSnap(buf, snap(1000, { tick: 900, ev: [{ n: 'old' }] }));
  pushSnap(buf, snap(1033, { tick: 2, ev: [{ n: 'new' }] }));
  assert(buf.snaps.length === 1, 'old timeline dropped');
  const r = sampleAt(buf, 1040);
  assert(r.events.map((e) => e.n).join() === 'old,new', 'events ' + r.events.map((e) => e.n));
});

test('buffer overflow keeps events', () => {
  const buf = createInterpBuffer({ maxSnaps: 4 });
  for (let i = 0; i < 10; i++) pushSnap(buf, snap(1000 + i * 33, { ev: [{ n: i }] }));
  assert(buf.snaps.length === 4, 'capped');
  const r = sampleAt(buf, 99999);
  assert(r.events.map((e) => e.n).join() === '0,1,2,3,4,5,6,7,8,9', 'all events kept ' + r.events.map((e) => e.n));
});

test('carried puck stays on the stick arc while the carrier turns', () => {
  const a = snap(0), b = snap(100);
  a.p[0] = player(0, { x: 0, z: 0, f: 0 });
  b.p[0] = player(0, { x: 0, z: 0, f: Math.PI / 2 });
  a.k = { x: 1, y: 0, z: 0, vx: 0, vy: 0, vz: 0, o: 0 };
  b.k = { x: 0, y: 0, z: 1, vx: 0, vy: 0, vz: 0, o: 0 };
  const s = lerpSnapshots(a, b, 50);
  near(Math.hypot(s.k.x, s.k.z), 1, 1e-9, 'radius preserved:');
});

test('clock offset from the lowest-RTT samples', () => {
  // true offset 5000; good samples have symmetric 10 ms RTT, bad ones have asymmetric 200 ms
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const c = 100 * i;
    samples.push(clockSample(c, c + 5000 + 5, c + 10));          // offset exactly 5000
    samples.push(clockSample(c + 50, c + 50 + 5000 + 180, c + 250)); // biased by +80
  }
  const est = estimateClock(samples);
  near(est.offset, 5000, 1e-9, 'offset:');
  near(est.minRtt, 10, 1e-9, 'minRtt:');
  assert(estimateClock([]) === null, 'empty');
});

test('interp delay: 55 ms floor, rises with jitter, capped at 150 ms', () => {
  near(targetInterpDelay(30, 0, 0), MIN_INTERP_DELAY_MS, 1e-9, 'base:');
  assert(targetInterpDelay(30, 40, 10) > 2000 / 30, 'jitter raises delay');
  near(targetInterpDelay(30, 500, 100), 150, 1e-9, 'cap:');
});

test('corrector blends a post-stall correction instead of teleporting, then decays', () => {
  const c = createCorrector();
  const mk = (x) => ({ ph: 2, p: [{ x, z: 0, vx: 0, vz: 0 }], k: { x: 0, z: 0, vx: 0, vz: 0, o: -1 } });
  c.apply(mk(0), 'extrap', 1000, 16);          // was extrapolating at x=0
  const s = c.apply(mk(2), 'interp', 1100, 16); // fresh data says x=2
  near(s.p[0].x, 0, 1e-9, 'first corrected frame continues from the old position:');
  let last = s.p[0].x;
  for (let i = 0; i < 30; i++) last = c.apply(mk(2), 'interp', 1100, 16).p[0].x;
  assert(Math.abs(last - 2) < 0.02, 'correction decays to the true position, got ' + last);
  const far = createCorrector();
  far.apply(mk(0), 'extrap', 1000, 16);
  near(far.apply(mk(9), 'interp', 1100, 16).p[0].x, 9, 1e-9, 'jumps > 6 m snap:');
});

console.log(`${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
