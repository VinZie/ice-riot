// ICE RIOT - stats: per-game tally, persistent career stats, and the /api/* JSON endpoints.
//
//   const tally = createGameTally({ config, teams, names: (id) => room.clients.get(id)?.name });
//   tally.add(ev, snap);            // once per snapshot, with the events drained for that snapshot
//   store.recordGame(tally.result(), names);   // once, when the snapshot phase is GAME_OVER
//
//   const store = createStatsStore();          // default: <project>/data/stats.json
//   if (handleStatsRequest(req, res, store)) return;   // before static file handling
//
// Zero dependencies. All store operations are synchronous (the file is small and is written at
// most once per debounce interval), so handleStatsRequest() can answer inline and return a boolean.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EVENT, PHASE, TEAMS, TEAM_SIZE, DT, SNAP_RATE, DEFAULT_CONFIG } from '../shared/constants.js';

export const STATS_SCHEMA = 1;
export const STATS_KIND = 'ice-riot-stats';
export const RECENT_LIMIT = 100;
export const DEFAULT_DEBOUNCE_MS = 2000;
export const DEFAULT_STATS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'stats.json',
);

/** Per-player counters kept by the tally and summed into careers. */
export const COUNTERS = ['goals', 'assists', 'shots', 'hits', 'bigHits', 'glass', 'steals', 'oneTimers', 'fires'];
const CAREER_COUNTERS = ['games', 'wins', 'losses', 'otWins', 'otLosses', ...COUNTERS, 'secondsPlayed'];

/** Leaderboard categories. The client tabs use wins / goals / hits / glass; the rest also work. */
export const LEADERBOARD_BY = ['wins', 'goals', 'hits', 'glass', 'assists', 'points', 'bigHits', 'steals', 'shots', 'oneTimers', 'fires', 'otWins', 'games'];

const MAX_SNAP_GAP_S = 1;                // cap per-snapshot time credit (dropped snaps, debugger)
const TEAM_COUNT = TEAMS.length;

// ---------------------------------------------------------------------------------------------
// Names

// Control chars, zero-width / bidi overrides, word joiners, BOM (built from code points so the
// source stays pure ASCII).
const CONTROL_RE = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]]
  .map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('') + ']', 'gu');
const BOM = String.fromCharCode(0xfeff);
const HTMLISH_RE = /[<>&"'`\\]/g;

/** Display form of a player name: no control/bidi chars, no HTML-ish chars, <= 16 code points. */
export function sanitizePlayerName(raw) {
  let s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  s = s.slice(0, 256).normalize('NFC').replace(CONTROL_RE, '').replace(HTMLISH_RE, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 16).join('').trim();
}

/** Career key: case-insensitive (and width/compatibility-insensitive) sanitized name, '' if unusable. */
export function playerKey(raw) {
  return sanitizePlayerName(raw).normalize('NFKC').toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Small helpers

const evType = (e) => (e && (e.type ?? e.t ?? e.e ?? e.ev)) || '';
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const isPid = (v) => Number.isInteger(v) && v >= 0 && v < TEAM_SIZE * 2;
const teamOfPid = (pid) => (pid < TEAM_SIZE ? 0 : 1);
const validTeams = (t) => Array.isArray(t) && t.length === 2 && t.every((i) => Number.isInteger(i) && i >= 0 && i < TEAM_COUNT);
const round1 = (v) => Math.round(v * 10) / 10;

function nameLookup(names) {
  if (typeof names === 'function') return names;
  if (names instanceof Map) return (id) => names.get(id) ?? names.get(String(id));
  if (names && typeof names === 'object') return (id) => names[id];
  return () => undefined;
}

function blankTeamStats() {
  return { shots: 0, hits: 0, bigHits: 0, glass: 0, saves: 0, goals: 0 };
}

// ---------------------------------------------------------------------------------------------
// Per-game tally

/**
 * createGameTally({ config, teams, names? }) -> { add(events, snapshot), result(), done }
 *
 * Events are credited to whoever controlled the acting skater *when the event happened*: the
 * controller map starts from the previous snapshot's p[i].c and is updated in order by SWITCH
 * events inside the batch; after the batch it is re-synced from the new snapshot (which also
 * picks up drop-ins / leaves, which emit no event). `names` (optional: function id->name, Map or
 * object) is consulted whenever a human is seen, so players who leave mid-game keep their name.
 * After the first GAME_OVER snapshot the tally is frozen (add() becomes a no-op).
 */
export function createGameTally({ config, teams, names } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const teamIdx = validTeams(teams) ? [...teams] : validTeams(cfg.teams) ? [...cfg.teams] : [0, 1];
  const periods = Number.isInteger(cfg.periods) && cfg.periods > 0 ? cfg.periods : DEFAULT_CONFIG.periods;
  const nameOf = nameLookup(names);

  const humans = new Map();              // clientId -> record
  const ctrl = new Map();                // playerId -> clientId (as of "now" while replaying events)
  const teamsStats = [blankTeamStats(), blankTeamStats()];
  const startedAt = Date.now();
  let score = [0, 0];
  let prev = null;                       // { tick, ph } of the last snapshot
  let ot = false;
  let over = false;
  let endedAt = 0;
  let lastTick = 0;

  function human(clientId, pid) {
    let h = humans.get(clientId);
    if (!h) {
      h = { clientId, name: null, team: teamOfPid(pid), secs: [0, 0], secondsPlayed: 0 };
      for (const k of COUNTERS) h[k] = 0;
      humans.set(clientId, h);
    }
    h.team = teamOfPid(pid);
    let nm;
    try { nm = nameOf(clientId); } catch { nm = undefined; }
    if (nm != null && nm !== '') h.name = String(nm);
    return h;
  }

  function creditClient(cid, pid, field) {
    if (!cid) return null;
    const h = human(cid, pid);
    h[field]++;
    return h;
  }

  function credit(pid, field) {
    return isPid(pid) ? creditClient(ctrl.get(pid), pid, field) : null;
  }

  // Goals / assists are credited to whoever controlled the skater when they SHOT / PASSED, so a
  // control switch while the puck is travelling does not move the credit to the AI.
  let lastShot = null;                   // { pid, cid } of the most recent shot
  const passCtrl = new Map();            // pid -> controller at that skater's most recent pass

  function syncFromSnapshot(snap) {
    if (!Array.isArray(snap.p)) return;
    ctrl.clear();
    snap.p.forEach((p, i) => {
      if (!p) return;
      const pid = isPid(p.id) ? p.id : i;
      const cid = p.c;
      if (Number.isInteger(cid) && cid > 0 && isPid(pid)) {
        ctrl.set(pid, cid);
        human(cid, pid);
      }
    });
  }

  function handleEvent(e) {
    switch (evType(e)) {
      case EVENT.SWITCH: {
        const cid = e.client;
        if (!(Number.isInteger(cid) && cid > 0)) break;
        if (isPid(e.from) && ctrl.get(e.from) === cid) ctrl.delete(e.from);
        for (const [pid, c] of ctrl) if (c === cid) ctrl.delete(pid);   // a client controls one skater
        if (isPid(e.to)) { ctrl.set(e.to, cid); human(cid, e.to); }
        break;
      }
      case EVENT.PASS: {
        if (isPid(e.by)) passCtrl.set(e.by, ctrl.get(e.by) || 0);
        break;
      }
      case EVENT.SHOT: {
        if (!isPid(e.by)) break;
        teamsStats[teamOfPid(e.by)].shots++;
        lastShot = { pid: e.by, cid: ctrl.get(e.by) || 0 };
        const h = credit(e.by, 'shots');
        if (h && e.kind === 'onetimer') h.oneTimers++;
        break;
      }
      case EVENT.GOAL: {
        const team = e.team === 0 || e.team === 1 ? e.team : isPid(e.scorer) ? teamOfPid(e.scorer) : -1;
        if (team === -1) break;
        teamsStats[team].goals++;
        score[team]++;
        // Own goals (scorer on the other team) are not credited to the scorer.
        let scorerCid = 0;
        if (isPid(e.scorer) && teamOfPid(e.scorer) === team) {
          scorerCid = lastShot && lastShot.pid === e.scorer ? lastShot.cid : ctrl.get(e.scorer) || 0;
          creditClient(scorerCid, e.scorer, 'goals');
        }
        if (isPid(e.assist) && e.assist !== e.scorer && teamOfPid(e.assist) === team) {
          const cid = passCtrl.has(e.assist) ? passCtrl.get(e.assist) : ctrl.get(e.assist) || 0;
          if (cid !== scorerCid) creditClient(cid, e.assist, 'assists');   // no self-assists
        }
        lastShot = null;
        passCtrl.clear();
        break;
      }
      case EVENT.FACEOFF: {
        lastShot = null;
        passCtrl.clear();
        break;
      }
      case EVENT.SAVE: {
        if (isPid(e.goalie)) teamsStats[teamOfPid(e.goalie)].saves++;
        break;
      }
      case EVENT.HIT: {
        if (!isPid(e.by)) break;
        const ts = teamsStats[teamOfPid(e.by)];
        ts.hits++;
        if (e.big) ts.bigHits++;
        const h = credit(e.by, 'hits');
        if (h && e.big) h.bigHits++;
        break;
      }
      case EVENT.GLASS: {
        if (!isPid(e.by)) break;
        teamsStats[teamOfPid(e.by)].glass++;
        credit(e.by, 'glass');
        break;
      }
      case EVENT.STEAL: {
        if (isPid(e.by)) credit(e.by, 'steals');
        break;
      }
      case EVENT.FIRE: {
        if (e.on && isPid(e.player)) credit(e.player, 'fires');
        break;
      }
      case EVENT.FINAL: {
        if (Array.isArray(e.score) && e.score.length === 2) score = [count(e.score[0]), count(e.score[1])];
        break;
      }
      default:
        break;
    }
  }

  function add(events, snap) {
    if (over) return;
    if (!Array.isArray(events)) events = Array.isArray(snap?.ev) ? snap.ev : [];
    if (!prev && snap) syncFromSnapshot(snap);   // first snapshot: best knowledge we have
    for (const e of events) {
      try { handleEvent(e); } catch { /* malformed event: ignore */ }
    }
    if (!snap || typeof snap !== 'object') return;

    // Time on ice: game-clock time (PLAY phase) between the previous snapshot and this one.
    const tick = Number.isFinite(snap.tick) ? snap.tick : null;
    if (prev && prev.ph === PHASE.PLAY) {
      let dt = tick != null && prev.tick != null ? (tick - prev.tick) * DT : 1 / SNAP_RATE;
      dt = Math.min(Math.max(dt, 0), MAX_SNAP_GAP_S);
      for (const [pid, cid] of ctrl) {
        const h = humans.get(cid);
        if (h) { h.secondsPlayed += dt; h.secs[teamOfPid(pid)] += dt; }
      }
    }
    syncFromSnapshot(snap);

    if (Array.isArray(snap.sc) && snap.sc.length === 2) score = [count(snap.sc[0]), count(snap.sc[1])];
    if (validTeams(snap.teams)) { teamIdx[0] = snap.teams[0]; teamIdx[1] = snap.teams[1]; }
    if (Number.isInteger(snap.per) && snap.per > periods) ot = true;
    if (tick != null) lastTick = tick;
    prev = { tick, ph: snap.ph };
    if (snap.ph === PHASE.GAME_OVER) {
      over = true;
      endedAt = Date.now();
    }
  }

  function result() {
    const winner = score[0] > score[1] ? 0 : score[1] > score[0] ? 1 : -1;
    const players = [...humans.values()].map((h) => {
      const team = h.secs[0] > h.secs[1] ? 0 : h.secs[1] > h.secs[0] ? 1 : h.team;
      const out = { clientId: h.clientId, name: h.name, team };
      for (const k of COUNTERS) out[k] = h[k];
      out.secondsPlayed = round1(h.secondsPlayed);
      return out;
    });
    const end = endedAt || Date.now();
    return {
      id: `${end.toString(36)}-${randomBytes(4).toString('hex')}`,
      endedAt: end,
      startedAt,
      final: over,
      config: { ...cfg, teams: [...teamIdx] },
      teams: [...teamIdx],
      score: [...score],
      winner,
      ot,
      ticks: lastTick,
      players,
      teamsStats: teamsStats.map((t) => ({ ...t })),
    };
  }

  return {
    add,
    result,
    get done() { return over; },
  };
}

// ---------------------------------------------------------------------------------------------
// Atomic file write (exported for tests)

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);
let tmpCounter = 0;

/**
 * Write `data` to `file` atomically: write a temp file next to it, then rename over the target.
 * Windows can refuse a rename over an existing file (EPERM/EACCES/EBUSY while another process -
 * antivirus, indexer, an editor - has it open): retry once, then unlink the target and rename,
 * and as a last resort write the target in place. The temp file never survives.
 */
export function atomicWriteFileSync(file, data, fsi = fs) {
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  fsi.writeFileSync(tmp, data);
  try {
    try {
      fsi.renameSync(tmp, file);
      return 'rename';
    } catch (err) {
      if (!RETRYABLE.has(err?.code)) throw err;
    }
    try {
      fsi.renameSync(tmp, file);
      return 'rename';
    } catch (err) {
      if (!RETRYABLE.has(err?.code)) throw err;
    }
    try {
      fsi.unlinkSync(file);
    } catch {
      /* missing or locked: try the rename anyway, then fall back to an in-place write */
    }
    try {
      fsi.renameSync(tmp, file);
      return 'unlink+rename';
    } catch {
      fsi.writeFileSync(file, data);
      return 'in-place';
    }
  } finally {
    try { fsi.unlinkSync(tmp); } catch { /* already renamed */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Persistent store

function blankData() {
  const now = Date.now();
  return { schema: STATS_SCHEMA, kind: STATS_KIND, createdAt: now, updatedAt: now, gamesRecorded: 0, players: {}, recent: [] };
}

function blankCareer(name, now) {
  const c = { name };
  for (const k of CAREER_COUNTERS) c[k] = 0;
  c.best = null;
  c.firstPlayed = now;
  c.lastPlayed = now;
  return c;
}

/** "Game rating" used to pick a player's best game. */
export function gameRating(s) {
  return (
    10 * count(s.goals) + 6 * count(s.assists) + count(s.shots) + 2 * count(s.hits) + 2 * count(s.bigHits) +
    5 * count(s.glass) + 3 * count(s.steals) + 2 * count(s.oneTimers) + 4 * count(s.fires) + (s.won ? 5 : 0)
  );
}

function cleanCareer(raw, key) {
  if (!raw || typeof raw !== 'object') return null;
  const name = sanitizePlayerName(raw.name) || key;
  const c = blankCareer(name, num(raw.firstPlayed, 0));
  for (const k of CAREER_COUNTERS) c[k] = k === 'secondsPlayed' ? Math.max(0, num(raw[k])) : count(raw[k]);
  c.lastPlayed = num(raw.lastPlayed, c.firstPlayed);
  c.best = raw.best && typeof raw.best === 'object' ? raw.best : null;
  return c;
}

/** Validate / migrate parsed file contents. Returns clean data or throws. */
function normalizeData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  if (raw.schema !== STATS_SCHEMA) throw new Error(`unsupported schema ${JSON.stringify(raw.schema)}`);
  if (!raw.players || typeof raw.players !== 'object' || Array.isArray(raw.players)) throw new Error('missing players');
  const data = blankData();
  data.createdAt = num(raw.createdAt, data.createdAt);
  data.updatedAt = num(raw.updatedAt, data.updatedAt);
  data.gamesRecorded = count(raw.gamesRecorded);
  for (const [k, v] of Object.entries(raw.players)) {
    const key = playerKey(k);
    const c = key && cleanCareer(v, key);
    if (c) data.players[key] = c;
  }
  data.recent = Array.isArray(raw.recent)
    ? raw.recent
      .filter((g) => g && typeof g === 'object' && Array.isArray(g.score))
      .slice(0, RECENT_LIMIT)
      .map((g) => ({ ...g, players: Array.isArray(g.players) ? g.players.filter((p) => p && typeof p === 'object') : [] }))
    : [];
  return data;
}

function careerRow(c) {
  const row = { name: c.name };
  for (const k of CAREER_COUNTERS) row[k] = c[k];
  row.secondsPlayed = Math.round(c.secondsPlayed);
  row.points = c.goals + c.assists;
  row.winPct = c.games ? Math.round((c.wins / c.games) * 1000) / 1000 : 0;
  row.lastPlayed = c.lastPlayed;
  return row;
}

const statValue = (c, by) => (by === 'points' ? c.goals + c.assists : c[by] || 0);

/**
 * createStatsStore(filePath = data/stats.json, { debounceMs = 2000, log }) ->
 *   { recordGame(result, names), leaderboard({by, limit}), player(name), recent(limit), flush(), close(), path, writes }
 */
export function createStatsStore(filePath = DEFAULT_STATS_PATH, { debounceMs = DEFAULT_DEBOUNCE_MS, log = () => {} } = {}) {
  const file = path.resolve(filePath || DEFAULT_STATS_PATH);
  const dir = path.dirname(file);
  let data = load();
  let dirty = false;
  let closed = false;
  let timer = null;
  let lastWriteAt = 0;
  let writes = 0;

  const onExit = () => { try { flush(); } catch { /* exiting anyway */ } };
  process.on('exit', onExit);

  function load() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') log(`stats: cannot read ${file} (${err?.code || err}), starting fresh`);
      return blankData();
    }
    try {
      return normalizeData(JSON.parse((text.startsWith(BOM) ? text.slice(1) : text)));
    } catch (err) {
      const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        fs.renameSync(file, backup);
      } catch {
        try { fs.copyFileSync(file, backup); } catch { /* keep going with a fresh store */ }
      }
      log(`stats: ${path.basename(file)} is unreadable (${err?.message || err}); backed up to ${path.basename(backup)}, starting fresh`);
      return blankData();
    }
  }

  function writeNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return false;
    dirty = false;
    data.updatedAt = Date.now();
    try {
      fs.mkdirSync(dir, { recursive: true });
      atomicWriteFileSync(file, JSON.stringify(data, null, 1) + '\n');
      writes++;
      lastWriteAt = Date.now();
      return true;
    } catch (err) {
      dirty = true;                            // try again on the next schedule / flush
      lastWriteAt = Date.now();
      log(`stats: write failed: ${err?.message || err}`);
      if (!closed) schedule();
      return false;
    }
  }

  function schedule() {
    if (timer || closed) return;
    // At most one write per debounceMs; a burst of changes in one turn becomes one write.
    const wait = Math.max(Math.min(100, debounceMs), lastWriteAt + debounceMs - Date.now());
    timer = setTimeout(writeNow, wait);
    timer.unref?.();
  }

  function markDirty() {
    dirty = true;
    schedule();
  }

  function recordGame(result, names) {
    if (closed) throw new Error('stats store is closed');
    if (!result || typeof result !== 'object' || !Array.isArray(result.score)) return null;
    if (result.id && data.recent.some((g) => g.id === result.id)) return null;   // recorded already

    const nameOf = nameLookup(names);
    const now = Date.now();
    const endedAt = num(result.endedAt, now);
    const teams = validTeams(result.teams) ? [...result.teams] : validTeams(result.config?.teams) ? [...result.config.teams] : [0, 1];
    const score = [count(result.score[0]), count(result.score[1])];
    const winner = result.winner === 0 || result.winner === 1 ? result.winner
      : score[0] > score[1] ? 0 : score[1] > score[0] ? 1 : -1;
    const ot = Boolean(result.ot);
    const id = typeof result.id === 'string' && result.id ? result.id.slice(0, 40) : `${endedAt.toString(36)}-${randomBytes(4).toString('hex')}`;

    // Merge the game's humans by career key (same name on two clients = one career entry).
    const merged = new Map();
    for (const p of Array.isArray(result.players) ? result.players : []) {
      if (!p || typeof p !== 'object') continue;
      let raw;
      try { raw = nameOf(p.clientId); } catch { raw = undefined; }
      const name = sanitizePlayerName(raw ?? p.name);
      const key = playerKey(name);
      if (!key) continue;
      const team = p.team === 1 ? 1 : 0;
      let m = merged.get(key);
      if (!m) {
        m = { key, name, team, secondsPlayed: 0, teamSecs: [0, 0] };
        for (const k of COUNTERS) m[k] = 0;
        merged.set(key, m);
      }
      for (const k of COUNTERS) m[k] += count(p[k]);
      const secs = Math.max(0, num(p.secondsPlayed));
      m.secondsPlayed += secs;
      m.teamSecs[team] += secs || 1e-6;
      m.team = m.teamSecs[1] > m.teamSecs[0] ? 1 : 0;
    }

    const summaryPlayers = [];
    for (const m of merged.values()) {
      const won = winner !== -1 && m.team === winner;
      const lost = winner !== -1 && m.team !== winner;
      let c = data.players[m.key];
      if (!c) c = data.players[m.key] = blankCareer(m.name, endedAt);
      c.name = m.name;                          // latest spelling wins
      c.games++;
      if (won) { c.wins++; if (ot) c.otWins++; }
      if (lost) { c.losses++; if (ot) c.otLosses++; }
      for (const k of COUNTERS) c[k] += m[k];
      c.secondsPlayed += m.secondsPlayed;
      c.lastPlayed = Math.max(c.lastPlayed, endedAt);
      c.firstPlayed = Math.min(c.firstPlayed || endedAt, endedAt);

      const line = { name: m.name, team: m.team };
      for (const k of COUNTERS) line[k] = m[k];
      line.secondsPlayed = round1(m.secondsPlayed);
      summaryPlayers.push(line);

      const rating = gameRating({ ...m, won });
      if (!c.best || rating > num(c.best.rating, -1)) {
        c.best = { rating, gameId: id, endedAt, team: m.team, teams, score, won, ot, ...Object.fromEntries(COUNTERS.map((k) => [k, m[k]])) };
      }
    }

    const cfg = result.config && typeof result.config === 'object' ? result.config : {};
    const summary = {
      id,
      endedAt,
      teams,
      score,
      winner,
      ot,
      periodLength: num(cfg.periodLength, DEFAULT_CONFIG.periodLength),
      periods: num(cfg.periods, DEFAULT_CONFIG.periods),
      difficulty: num(cfg.difficulty, DEFAULT_CONFIG.difficulty),
      players: summaryPlayers,
      teamsStats: Array.isArray(result.teamsStats)
        ? result.teamsStats.slice(0, 2).map((t) => Object.fromEntries(Object.keys(blankTeamStats()).map((k) => [k, count(t?.[k])])))
        : [blankTeamStats(), blankTeamStats()],
    };
    data.recent.unshift(summary);
    if (data.recent.length > RECENT_LIMIT) data.recent.length = RECENT_LIMIT;
    data.gamesRecorded++;
    markDirty();
    return summary;
  }

  function leaderboard({ by = 'wins', limit = 10 } = {}) {
    if (!LEADERBOARD_BY.includes(by)) by = 'wins';
    limit = Math.min(Math.max(Math.floor(num(Number(limit), 10)) || 10, 1), 100);
    const tie = by === 'wins' ? 'goals' : 'wins';
    const list = Object.values(data.players).filter((c) => c.games > 0);
    list.sort((a, b) =>
      statValue(b, by) - statValue(a, by) ||
      statValue(b, tie) - statValue(a, tie) ||
      a.games - b.games ||                   // same totals in fewer games ranks higher
      b.lastPlayed - a.lastPlayed ||
      a.name.localeCompare(b.name));
    return list.slice(0, limit).map((c, i) => ({ rank: i + 1, value: statValue(c, by), ...careerRow(c) }));
  }

  function player(name) {
    const key = playerKey(name);
    const c = key && data.players[key];
    if (!c) return null;
    const games = data.recent
      .filter((g) => g.players.some((p) => playerKey(p.name) === key))
      .slice(0, 10)
      .map((g) => structuredClone(g));
    return { key, ...careerRow(c), firstPlayed: c.firstPlayed, best: c.best ? { ...c.best } : null, recent: games };
  }

  function recent(limit = 10) {
    limit = Math.min(Math.max(Math.floor(num(Number(limit), 10)) || 10, 1), RECENT_LIMIT);
    return data.recent.slice(0, limit).map((g) => structuredClone(g));
  }

  function flush() {
    return writeNow();
  }

  function close() {
    if (closed) return;
    flush();
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    process.off('exit', onExit);
  }

  return {
    recordGame,
    leaderboard,
    player,
    recent,
    flush,
    close,
    path: file,
    get writes() { return writes; },
    get gamesRecorded() { return data.gamesRecorded; },
    get playerCount() { return Object.keys(data.players).length; },
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP

function sendJson(req, res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const ROUTES = new Set(['/api/leaderboard', '/api/recent', '/api/player']);

/**
 * Handles GET/HEAD /api/leaderboard?by=wins|goals|hits|glass&limit=N, /api/recent?limit=N and
 * /api/player?name=X. Returns true if it handled (answered) the request, false for any other URL.
 */
export function handleStatsRequest(req, res, store) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return false;
  }
  const route = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (!ROUTES.has(route)) return false;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendJson(req, res, 405, { ok: false, error: 'Method not allowed' });
    return true;
  }
  if (!store) {
    sendJson(req, res, 503, { ok: false, error: 'Stats are not available' });
    return true;
  }
  const q = url.searchParams;
  const limitParam = q.get('limit');
  const limit = limitParam == null || limitParam === '' ? undefined : Number(limitParam);
  const now = Date.now();
  try {
    if (route === '/api/leaderboard') {
      const by = q.get('by') || 'wins';
      if (!LEADERBOARD_BY.includes(by)) {
        sendJson(req, res, 400, { ok: false, error: `by must be one of ${LEADERBOARD_BY.join(', ')}` });
      } else {
        sendJson(req, res, 200, { ok: true, now, by, rows: store.leaderboard({ by, limit: limit ?? 10 }) });
      }
    } else if (route === '/api/recent') {
      sendJson(req, res, 200, { ok: true, now, games: store.recent(limit ?? 10) });
    } else {
      const name = q.get('name');
      if (!name || !playerKey(name)) {
        sendJson(req, res, 400, { ok: false, error: 'name is required' });
      } else {
        const p = store.player(name);
        if (p) sendJson(req, res, 200, { ok: true, now, player: p });
        else sendJson(req, res, 404, { ok: false, error: 'No such player' });
      }
    }
  } catch (err) {
    if (!res.headersSent) sendJson(req, res, 500, { ok: false, error: 'Stats error' });
    else res.end();
  }
  return true;
}
