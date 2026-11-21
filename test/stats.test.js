// ICE RIOT - stats tests: node test/stats.test.js  (exit code 1 on failure)
//
// Covers: per-game tally from a synthetic snapshot/event stream (incl. control switches, drop-in,
// leave, OT, freeze after GAME_OVER), store record + leaderboard ordering + persistence across
// reopen + corrupt-file recovery + debounced/atomic writes, and handleStatsRequest on a real
// http server bound to an ephemeral port.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EVENT, PHASE } from '../shared/constants.js';
import {
  createGameTally,
  createStatsStore,
  handleStatsRequest,
  atomicWriteFileSync,
  playerKey,
  sanitizePlayerName,
  RECENT_LIMIT,
  STATS_SCHEMA,
} from '../server/stats-store.js';

// ---------------------------------------------------------------------------------------------
// tiny harness

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ice-riot-stats-test-'));
const tmpFile = (...parts) => path.join(tmpRoot, ...parts);
const approx = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} !~ ${b}`);

// ---------------------------------------------------------------------------------------------
// synthetic stream helpers

function snap({ tick, ph = PHASE.PLAY, per = 1, sc = [0, 0], ctrl = {}, teams = [2, 3] }) {
  const p = [];
  for (let id = 0; id < 8; id++) {
    p.push({
      id, tm: id < 4 ? 0 : 1, g: id % 4 === 3 ? 1 : 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, f: 0,
      s: 0, sT: 0, tb: 1, fire: 0, ch: 0, c: ctrl[id] || 0, n: id,
    });
  }
  return { tick, ph, phT: 0, per, clk: 60, sc, teams, p, k: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, o: -1 }, gl: [] };
}
const ev = (type, o = {}) => ({ type, ...o });

const KEL = 11, SAM = 22, ANA = 33;

/** Feeds a whole synthetic game; returns { tally, present } (present = clients still in the room). */
function playSyntheticGame() {
  const present = new Map([[KEL, 'Kel'], [SAM, 'Sam'], [ANA, 'Ana']]);
  const tally = createGameTally({
    config: { teams: [2, 3], periodLength: 60, periods: 3, difficulty: 1 },
    teams: [2, 3],
    names: (id) => present.get(id),
  });
  // 1: faceoff. Kel on p0 (home), Sam on p4 (away).
  tally.add([ev(EVENT.PERIOD, { period: 1 })], snap({ tick: 0, ph: PHASE.FACEOFF, ctrl: { 0: KEL, 4: SAM } }));
  // 2: play. Kel shoots, Sam lays a big hit through the glass, away goalie saves.
  tally.add([
    ev(EVENT.FACEOFF, { x: 0, z: 0 }),
    ev(EVENT.SHOT, { by: 0, power: 0.4, kind: 'wrist' }),
    ev(EVENT.SAVE, { goalie: 7, x: 26, z: 0 }),
    ev(EVENT.HIT, { by: 4, target: 1, power: 1, big: true, x: 0, z: 12 }),
    ev(EVENT.GLASS, { panel: 30, by: 4, target: 1, x: 0, z: 13 }),
  ], snap({ tick: 30, ctrl: { 0: KEL, 4: SAM } }));
  // 3: p1 (still AI) hits, THEN Kel switches 0->1, AI p2 passes to p1, Kel one-times it, Kel
  //    switches 1->2 while the puck travels, goal by p1 assisted by p2 (AI at pass time).
  tally.add([
    ev(EVENT.HIT, { by: 1, target: 5, power: 0.5, big: false, x: 1, z: 1 }),
    ev(EVENT.SWITCH, { client: KEL, from: 0, to: 1 }),
    ev(EVENT.PASS, { by: 2, to: 1 }),
    ev(EVENT.SHOT, { by: 1, power: 1, kind: 'onetimer' }),
    ev(EVENT.SWITCH, { client: KEL, from: 1, to: 2 }),
    ev(EVENT.GOAL, { team: 0, scorer: 1, assist: 2, oneTimer: true, x: 26.6, z: 0 }),
  ], snap({ tick: 60, sc: [1, 0], ctrl: { 2: KEL, 4: SAM } }));
  // 4: Sam steals (still on p4 when it happened), then Sam leaves and Ana drops in on p0 (no events).
  tally.add([ev(EVENT.STEAL, { by: 4, from: 0 })], snap({ tick: 90, sc: [1, 0], ctrl: { 0: ANA, 2: KEL } }));
  present.delete(SAM);
  // 5: AI p4 big hit (not Sam), Kel catches fire, Ana's fire-off is not a fire, Ana smashes glass, away ties it.
  tally.add([
    ev(EVENT.HIT, { by: 4, target: 0, power: 1, big: true, x: 0, z: -12 }),
    ev(EVENT.FIRE, { player: 2, on: 1 }),
    ev(EVENT.FIRE, { player: 0, on: 0 }),
    ev(EVENT.GLASS, { panel: 3, by: 0, target: 6, x: 0, z: -13 }),
    ev(EVENT.GOAL, { team: 1, scorer: 5, assist: -1, oneTimer: false, x: -26.6, z: 0 }),
  ], snap({ tick: 120, sc: [1, 1], ctrl: { 0: ANA, 2: KEL } }));
  // 6-8: end of regulation, OT faceoff, OT play.
  tally.add([ev(EVENT.PERIOD_END, { period: 3 })], snap({ tick: 150, ph: PHASE.PERIOD_END, per: 3, sc: [1, 1], ctrl: { 0: ANA, 2: KEL } }));
  tally.add([ev(EVENT.PERIOD, { period: 4 })], snap({ tick: 200, ph: PHASE.FACEOFF, per: 4, sc: [1, 1], ctrl: { 0: ANA, 2: KEL } }));
  tally.add([ev(EVENT.FACEOFF, { x: 0, z: 0 })], snap({ tick: 230, per: 4, sc: [1, 1], ctrl: { 0: ANA, 2: KEL } }));
  // 9: Kel (p2) passes to Ana (p0), Ana slaps it home in OT.
  tally.add([
    ev(EVENT.PASS, { by: 2, to: 0 }),
    ev(EVENT.SHOT, { by: 0, power: 0.9, kind: 'slap' }),
    ev(EVENT.GOAL, { team: 0, scorer: 0, assist: 2, oneTimer: false, x: 26.6, z: 0.2 }),
  ], snap({ tick: 260, per: 4, sc: [2, 1], ctrl: { 0: ANA, 2: KEL } }));
  // 10: final.
  tally.add([ev(EVENT.FINAL, { score: [2, 1] })], snap({ tick: 290, ph: PHASE.GAME_OVER, per: 4, sc: [2, 1], ctrl: { 0: ANA, 2: KEL } }));
  // 11: snaps keep coming during the post-game linger: ignored.
  tally.add([ev(EVENT.HIT, { by: 2, target: 4, power: 1, big: true })], snap({ tick: 320, ph: PHASE.GAME_OVER, per: 4, sc: [2, 1], ctrl: { 0: ANA, 2: KEL } }));
  return { tally, present };
}

/** Quick synthetic result for store tests. */
function makeResult({ score = [1, 0], winner, ot = false, endedAt = Date.now(), teams = [0, 1], players = [] }) {
  return {
    endedAt,
    config: { teams, periodLength: 120, periods: 3, difficulty: 1 },
    teams,
    score,
    winner: winner ?? (score[0] > score[1] ? 0 : score[1] > score[0] ? 1 : -1),
    ot,
    players: players.map((p, i) => ({
      clientId: p.clientId ?? i + 1, name: p.name, team: p.team ?? 0,
      goals: 0, assists: 0, shots: 0, hits: 0, bigHits: 0, glass: 0, steals: 0, oneTimers: 0, fires: 0, secondsPlayed: 100,
      ...p,
    })),
    teamsStats: [
      { shots: 5, hits: 3, bigHits: 1, glass: 0, saves: 2, goals: score[0] },
      { shots: 4, hits: 2, bigHits: 0, glass: 1, saves: 4, goals: score[1] },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// tally

test('tally: credits humans at event time across switches, drop-ins and leaves', () => {
  const { tally } = playSyntheticGame();
  assert.equal(tally.done, true);
  const r = tally.result();
  assert.deepEqual(r.score, [2, 1]);
  assert.equal(r.winner, 0);
  assert.equal(r.ot, true);
  assert.equal(r.final, true);
  assert.deepEqual(r.teams, [2, 3]);
  assert.equal(r.config.periodLength, 60);
  assert.equal(typeof r.endedAt, 'number');
  assert.equal(typeof r.id, 'string');

  const by = Object.fromEntries(r.players.map((p) => [p.clientId, p]));
  assert.deepEqual(Object.keys(by).map(Number).sort((a, b) => a - b), [KEL, SAM, ANA], 'humans only');

  const kel = by[KEL];
  assert.equal(kel.name, 'Kel');
  assert.equal(kel.team, 0);
  assert.equal(kel.shots, 2, 'wrist from p0 + one-timer from p1');
  assert.equal(kel.oneTimers, 1);
  assert.equal(kel.goals, 1, 'goal credited to the shooter even though he switched away mid-flight');
  assert.equal(kel.assists, 1, 'OT assist from p2; the p2 pass in period 1 was by the AI');
  assert.equal(kel.hits, 0, 'p1 hit happened before the switch -> AI');
  assert.equal(kel.fires, 1);
  assert.equal(kel.bigHits, 0, 'post-GAME_OVER events are ignored');
  approx(kel.secondsPlayed, 3.0, 1e-6, `kel seconds ${kel.secondsPlayed}`);

  const sam = by[SAM];
  assert.equal(sam.name, 'Sam', 'name kept after leaving');
  assert.equal(sam.team, 1);
  assert.equal(sam.hits, 1);
  assert.equal(sam.bigHits, 1, 'later big hit by AI p4 is not Sam');
  assert.equal(sam.glass, 1);
  assert.equal(sam.steals, 1, 'steal in the same batch as the leave still counts');
  approx(sam.secondsPlayed, 1.0);

  const ana = by[ANA];
  assert.equal(ana.team, 0);
  assert.equal(ana.goals, 1);
  assert.equal(ana.shots, 1);
  assert.equal(ana.glass, 1);
  assert.equal(ana.fires, 0, 'FIRE on:0 is not a fire');
  assert.equal(ana.assists, 0);
  approx(ana.secondsPlayed, 2.0);

  assert.deepEqual(r.teamsStats[0], { shots: 3, hits: 1, bigHits: 0, glass: 1, saves: 0, goals: 2 });
  assert.deepEqual(r.teamsStats[1], { shots: 0, hits: 2, bigHits: 2, glass: 1, saves: 1, goals: 1 });
});

test('tally: own goals, no self-assists, ev taken from snapshot when events omitted, regulation win', () => {
  const t = createGameTally({ config: { periods: 3 }, teams: [0, 1] });
  t.add([], snap({ tick: 0, ph: PHASE.PLAY, teams: [0, 1], ctrl: { 0: 5, 5: 6 } }));
  // p0 (client 5) passes to himself? No: passes to p1, then switches onto p1 and scores -> goal only.
  const s1 = snap({ tick: 30, teams: [0, 1], sc: [1, 0], ctrl: { 1: 5, 5: 6 } });
  s1.ev = [
    ev(EVENT.PASS, { by: 0, to: 1 }),
    ev(EVENT.SWITCH, { client: 5, from: 0, to: 1 }),
    ev(EVENT.SHOT, { by: 1, power: 0.5, kind: 'wrist' }),
    ev(EVENT.GOAL, { team: 0, scorer: 1, assist: 0, oneTimer: false }),
  ];
  t.add(undefined, s1);
  // Own goal: client 6 (away p5) knocks it into his own net -> team 0 goal, nobody credited.
  t.add([ev(EVENT.GOAL, { team: 0, scorer: 5, assist: -1 })], snap({ tick: 60, teams: [0, 1], sc: [2, 0], ctrl: { 1: 5, 5: 6 } }));
  t.add([ev(EVENT.FINAL, { score: [2, 0] })], snap({ tick: 90, ph: PHASE.GAME_OVER, teams: [0, 1], sc: [2, 0], ctrl: { 1: 5, 5: 6 } }));
  const r = t.result();
  const p5 = r.players.find((p) => p.clientId === 5);
  const p6 = r.players.find((p) => p.clientId === 6);
  assert.equal(p5.goals, 1);
  assert.equal(p5.assists, 0, 'no self-assist');
  assert.equal(p6.goals, 0, 'own goal not credited');
  assert.equal(p5.name, null, 'no names source -> null (filled in by recordGame)');
  assert.equal(r.ot, false);
  assert.equal(r.winner, 0);
  assert.equal(r.teamsStats[0].goals, 2);
  approx(p5.secondsPlayed, 1.5);
});

test('tally: result() mid-game is usable and not final', () => {
  const t = createGameTally({ config: {}, teams: [1, 4] });
  t.add([], snap({ tick: 0, ctrl: { 0: 9 }, teams: [1, 4] }));
  t.add([ev(EVENT.SHOT, { by: 0, kind: 'wrist' })], snap({ tick: 30, ctrl: { 0: 9 }, teams: [1, 4] }));
  const r = t.result();
  assert.equal(r.final, false);
  assert.equal(r.winner, -1);
  assert.equal(r.players[0].shots, 1);
  assert.deepEqual(r.teams, [1, 4]);
});

// ---------------------------------------------------------------------------------------------
// store

test('names: sanitize + case-insensitive key', () => {
  assert.equal(sanitizePlayerName('  <b>Kel</b>\u0007  the   Great!!!!!!! '), 'bKel/b the Great');
  const zw = String.fromCharCode(0x200b), rlo = String.fromCharCode(0x202e), bom = String.fromCharCode(0xfeff);
  assert.equal(sanitizePlayerName(`A${zw}B${rlo}C${bom}D`), 'ABCD', 'zero-width / bidi / BOM stripped');
  assert.equal(playerKey('KeL'), playerKey('kel'));
  assert.equal(playerKey(String.fromCharCode(0xff2b, 0xff45, 0xff4c)), 'kel', 'full-width folds to the same key');
  assert.equal(playerKey('   '), '');
  assert.equal(Array.from(sanitizePlayerName('x'.repeat(40))).length, 16);
});

test('store: record from a real tally, careers, leaderboard ordering, case-insensitive merge', () => {
  const file = tmpFile('a', 'deep', 'stats.json');   // parent dirs do not exist yet
  const store = createStatsStore(file, { debounceMs: 50 });
  const { tally } = playSyntheticGame();
  const r = tally.result();
  const summary = store.recordGame(r, { [KEL]: 'Kel', [SAM]: 'Sam', [ANA]: 'Ana' });
  assert.ok(summary);
  assert.equal(store.recordGame(r), null, 'same result id is not recorded twice');

  const kel = store.player('KEL');
  assert.equal(kel.name, 'Kel');
  assert.equal(kel.games, 1);
  assert.equal(kel.wins, 1);
  assert.equal(kel.otWins, 1);
  assert.equal(kel.goals, 1);
  assert.equal(kel.assists, 1);
  assert.equal(kel.oneTimers, 1);
  assert.equal(kel.fires, 1);
  assert.ok(kel.best && kel.best.goals === 1 && kel.best.won === true);
  assert.equal(kel.recent.length, 1);
  const sam = store.player('sam');
  assert.equal(sam.losses, 1);
  assert.equal(sam.otLosses, 1);
  assert.equal(sam.glass, 1);

  // More games. "kel" in lower case must merge into the same career; display name follows latest.
  const t0 = Date.now();
  store.recordGame(makeResult({ score: [3, 1], endedAt: t0 + 1, players: [
    { name: 'kel', team: 0, goals: 2, hits: 1 },
    { name: 'Sam', team: 1, goals: 1, hits: 6, glass: 2 },
  ] }));
  store.recordGame(makeResult({ score: [0, 2], endedAt: t0 + 2, players: [
    { name: 'Ana', team: 0, hits: 1 },
    { name: 'Bo', team: 1, goals: 2, hits: 2, glass: 1 },
    { name: 'Sam', team: 1, hits: 3 },
  ] }));
  store.recordGame(makeResult({ score: [1, 0], endedAt: t0 + 3, players: [
    { name: '   ', team: 0, goals: 1 },            // unusable name -> skipped
    { name: 'Zed', team: 1, hits: 0 },
  ] }));

  // Careers now: kel 2W/2GP 3G 1H | Sam 1W/3GP 1G 10H 3GLS | Ana 1W/2GP 1G 1H 1GLS | Bo 1W/1GP 2G 2H 1GLS | Zed 0W/1GP
  const rows = (b, limit) => store.leaderboard({ by: b, limit }).map((r) => [r.name, r.value]);
  const wins = store.leaderboard({ by: 'wins' });
  // ties on wins -> more goals; then fewer games played
  assert.deepEqual(wins.map((r) => [r.name, r.value]), [['kel', 2], ['Bo', 1], ['Ana', 1], ['Sam', 1], ['Zed', 0]]);
  assert.deepEqual(wins.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.equal(wins[0].games, 2);
  assert.equal(wins[0].winPct, 1);
  assert.equal(wins[0].points, 4);
  // ties on goals -> more wins; then fewer games played
  assert.deepEqual(rows('goals'), [['kel', 3], ['Bo', 2], ['Ana', 1], ['Sam', 1], ['Zed', 0]]);
  assert.deepEqual(rows('hits'), [['Sam', 10], ['Bo', 2], ['kel', 1], ['Ana', 1], ['Zed', 0]]);
  assert.deepEqual(rows('glass', 2), [['Sam', 3], ['Bo', 1]]);
  assert.equal(store.leaderboard({ by: 'nonsense' })[0].name, 'kel', 'unknown category falls back to wins');
  assert.equal(store.leaderboard({ limit: 1 }).length, 1);

  const recent = store.recent();
  assert.equal(recent.length, 4);
  assert.deepEqual(recent.map((g) => g.endedAt).slice(0, 3), [t0 + 3, t0 + 2, t0 + 1], 'newest first');
  assert.equal(recent[3].ot, true);
  assert.deepEqual(recent[3].teams, [2, 3]);
  assert.equal(store.player('nobody'), null);
  store.close();
});

test('store: goals leaderboard order is exact', () => {
  const store = createStatsStore(tmpFile('goals.json'), { debounceMs: 50 });
  const t0 = Date.now();
  store.recordGame(makeResult({ score: [5, 4], endedAt: t0, players: [
    { name: 'A', team: 0, goals: 3 }, { name: 'B', team: 0, goals: 2 }, { name: 'C', team: 1, goals: 4 }, { name: 'D', team: 1, goals: 0 },
  ] }));
  store.recordGame(makeResult({ score: [2, 0], endedAt: t0 + 1, players: [{ name: 'b', team: 0, goals: 2 }] }));
  const rows = store.leaderboard({ by: 'goals' });
  // b and C both have 4 goals; tiebreak is wins (b: 2, C: 0) -> b first.
  assert.deepEqual(rows.map((r) => [r.name, r.value]), [['b', 4], ['C', 4], ['A', 3], ['D', 0]]);
  store.close();
});

test('store: persistence across reopen, bounded recent list, schema on disk', () => {
  const file = tmpFile('persist', 'stats.json');
  let store = createStatsStore(file, { debounceMs: 50 });
  const t0 = Date.now();
  for (let i = 0; i < RECENT_LIMIT + 7; i++) {
    store.recordGame(makeResult({ score: [i % 3, 1], endedAt: t0 + i, players: [
      { name: 'Grinder', team: 0, hits: 1, goals: i % 3 },
      { name: 'Wall', team: 1, glass: i % 2 },
    ] }));
  }
  const before = { wins: store.leaderboard({ by: 'wins' }), recent: store.recent(5), kel: store.player('grinder') };
  store.close();

  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.schema, STATS_SCHEMA);
  assert.equal(disk.recent.length, RECENT_LIMIT, 'recent list is bounded');
  assert.equal(disk.gamesRecorded, RECENT_LIMIT + 7);

  store = createStatsStore(file, { debounceMs: 50 });
  assert.deepEqual(store.leaderboard({ by: 'wins' }), before.wins);
  assert.deepEqual(store.recent(5), before.recent);
  assert.deepEqual(store.player('GRINDER'), before.kel);
  assert.equal(store.player('grinder').games, RECENT_LIMIT + 7);
  assert.equal(store.recent(1000).length, RECENT_LIMIT);
  store.close();
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'no temp files left behind');
});

test('store: corrupt or wrong-schema file is backed up and the store starts fresh', () => {
  const dir = tmpFile('corrupt');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'stats.json');
  fs.writeFileSync(file, '{"schema": 1, "players": {"x": ');   // truncated JSON
  const logs = [];
  let store = createStatsStore(file, { debounceMs: 50, log: (s) => logs.push(s) });
  let backups = fs.readdirSync(dir).filter((f) => f.startsWith('stats.json.corrupt-'));
  assert.equal(backups.length, 1, 'backup created');
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{"schema": 1, "players": {"x": ');
  assert.equal(store.leaderboard({}).length, 0);
  assert.equal(store.recent().length, 0);
  assert.ok(logs.some((l) => /corrupt|unreadable/i.test(l)));
  store.recordGame(makeResult({ players: [{ name: 'Fresh', team: 0, goals: 1 }] }));
  store.close();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).players.fresh.goals, 1);

  // Valid JSON but an unknown schema / shape is treated the same way.
  fs.writeFileSync(file, JSON.stringify({ schema: 999, players: [] }));
  store = createStatsStore(file, { debounceMs: 50 });
  backups = fs.readdirSync(dir).filter((f) => f.startsWith('stats.json.corrupt-'));
  assert.equal(backups.length, 2);
  assert.equal(store.player('fresh'), null);
  store.close();

  // Tolerates junk inside an otherwise valid file (bad numbers, bad recent entries).
  fs.writeFileSync(file, String.fromCharCode(0xfeff) + JSON.stringify({
    schema: STATS_SCHEMA, players: { 'MiXeD': { name: 'MiXeD', games: '7', wins: 2, goals: -5, hits: 3.7 }, bad: 42 },
    recent: [null, { score: [1, 0], players: 'nope' }, 'x'],
  }));
  store = createStatsStore(file, { debounceMs: 50 });
  const m = store.player('mixed');
  assert.equal(m.games, 0, 'non-numeric -> 0');
  assert.equal(m.wins, 2);
  assert.equal(m.goals, 0, 'negative -> 0');
  assert.equal(m.hits, 3);
  assert.equal(store.recent().length, 1);
  assert.deepEqual(store.recent()[0].players, []);
  store.close();
});

test('store: writes are debounced (<= 1 per interval), coalesced, and flush/close write immediately', async () => {
  const file = tmpFile('debounce', 'stats.json');
  const store = createStatsStore(file, { debounceMs: 300 });
  const g = (n) => makeResult({ endedAt: Date.now() + n, players: [{ name: 'P' + n, team: 0 }] });
  for (let i = 0; i < 5; i++) store.recordGame(g(i));
  assert.equal(store.writes, 0, 'nothing written synchronously');
  assert.equal(fs.existsSync(file), false);
  await sleep(200);
  assert.equal(store.writes, 1, 'burst coalesced into one write');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).recent.length, 5);

  const t1 = Date.now();
  store.recordGame(g(5));
  store.recordGame(g(6));
  await sleep(120);
  assert.equal(store.writes, 1, 'second write waits for the debounce interval');
  while (store.writes < 2 && Date.now() - t1 < 2000) await sleep(20);
  assert.equal(store.writes, 2);
  assert.ok(Date.now() - t1 >= 150, 'not written early');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).recent.length, 7);

  store.recordGame(g(7));
  assert.equal(store.flush(), true, 'flush writes now');
  assert.equal(store.writes, 3);
  assert.equal(store.flush(), false, 'nothing dirty');
  store.recordGame(g(8));
  store.close();
  assert.equal(store.writes, 4, 'close flushes');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).recent.length, 9);
  await sleep(350);
  assert.equal(store.writes, 4, 'no timer left after close');
  assert.throws(() => store.recordGame(g(9)), /closed/);
});

test('atomic write: falls back to unlink+rename when Windows refuses rename-over-existing', () => {
  const dir = tmpFile('atomic');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, 'old');
  let renames = 0;
  const flaky = {
    ...fs,
    writeFileSync: fs.writeFileSync,
    unlinkSync: fs.unlinkSync,
    renameSync(a, b) {
      renames++;
      if (fs.existsSync(b)) {
        const err = new Error('EPERM: operation not permitted, rename');
        err.code = 'EPERM';
        throw err;
      }
      return fs.renameSync(a, b);
    },
  };
  assert.equal(atomicWriteFileSync(file, 'new', flaky), 'unlink+rename');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(renames, 3);
  assert.deepEqual(fs.readdirSync(dir), ['x.json'], 'temp file cleaned up');
  assert.equal(atomicWriteFileSync(file, 'newer'), 'rename');
  assert.equal(fs.readFileSync(file, 'utf8'), 'newer');
});

// ---------------------------------------------------------------------------------------------
// http

test('handleStatsRequest: JSON endpoints on a real http server', async () => {
  const store = createStatsStore(tmpFile('http', 'stats.json'), { debounceMs: 50 });
  const t0 = Date.now();
  store.recordGame(makeResult({ score: [4, 2], endedAt: t0 - 60000, players: [
    { name: 'Kel', team: 0, goals: 3, hits: 2 }, { name: 'Sam', team: 1, goals: 2, hits: 5, glass: 1 },
  ] }));
  store.recordGame(makeResult({ score: [1, 2], ot: true, endedAt: t0, teams: [4, 5], players: [
    { name: 'kel', team: 0, goals: 1 }, { name: 'Bo', team: 1, goals: 1, assists: 1 },
  ] }));

  const server = http.createServer((req, res) => {
    if (handleStatsRequest(req, res, store)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('static fallthrough');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p, init) => {
    const res = await fetch(base + p, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { res, text, json };
  };
  try {
    let { res, json } = await get('/api/leaderboard?by=goals&limit=2');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(json.ok, true);
    assert.equal(json.by, 'goals');
    assert.deepEqual(json.rows.map((r) => [r.name, r.value]), [['kel', 4], ['Sam', 2]]);
    assert.equal(typeof json.now, 'number');

    ({ json } = await get('/api/leaderboard'));
    assert.equal(json.by, 'wins');
    assert.equal(json.rows[0].name, 'kel');

    ({ res, json } = await get('/api/leaderboard?by=bogus'));
    assert.equal(res.status, 400);
    assert.equal(json.ok, false);

    ({ res, json } = await get('/api/recent'));
    assert.equal(res.status, 200);
    assert.equal(json.games.length, 2);
    assert.equal(json.games[0].ot, true);
    assert.deepEqual(json.games[0].teams, [4, 5]);
    assert.deepEqual(json.games[0].score, [1, 2]);
    assert.equal(json.games[0].winner, 1);

    ({ json } = await get('/api/recent?limit=1'));
    assert.equal(json.games.length, 1);

    ({ res, json } = await get('/api/player?name=KEL'));
    assert.equal(res.status, 200);
    assert.equal(json.player.games, 2);
    assert.equal(json.player.goals, 4);
    assert.equal(json.player.recent.length, 2);

    ({ res, json } = await get('/api/player?name=' + encodeURIComponent('Nobody Here')));
    assert.equal(res.status, 404);
    assert.equal(json.ok, false);
    ({ res } = await get('/api/player'));
    assert.equal(res.status, 400);

    ({ res, json } = await get('/api/recent', { method: 'POST', body: 'x' }));
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');

    const head = await get('/api/recent', { method: 'HEAD' });
    assert.equal(head.res.status, 200);
    assert.equal(head.text, '');

    let text;
    ({ res, text } = await get('/index.html'));
    assert.equal(res.status, 404);
    assert.equal(text, 'static fallthrough', 'other URLs are not handled');
    ({ text } = await get('/api/leaderboardx'));
    assert.equal(text, 'static fallthrough');
    ({ res } = await get('/api/leaderboard/?by=hits'));
    assert.equal(res.status, 200, 'trailing slash tolerated');
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }

  // No store -> 503 (still handled).
  const s2 = http.createServer((req, res) => {
    if (!handleStatsRequest(req, res, null)) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${s2.address().port}/api/recent`);
    assert.equal(res.status, 503);
    await res.text();
  } finally {
    await new Promise((r) => s2.close(r));
  }
});

// ---------------------------------------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok   - ${t.name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL - ${t.name}\n${err?.stack || err}`);
  }
}
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
