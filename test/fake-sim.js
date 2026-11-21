// A tiny stand-in for shared/sim.js that satisfies the CONTRACT.md sim API, so the server can be
// tested without the real simulation. createFakeSim() returns a fresh "module" object.
//
//   - human-controlled skaters move with their input (5 m/s * stick), AI skaters drift in circles
//   - FACEOFF for 0.25 s, then PLAY; a SHOT event every 45 ticks; GAME_OVER after `gameSeconds`
//   - records step counts and the last inputs it saw for assertions

import { PHASE, EVENT, TEAM_SIZE, GOALIE_K, DEFAULT_CONFIG } from '../shared/constants.js';

export function createFakeSim({ gameSeconds = 1e9 } = {}) {
  const sim = {
    steps: 0,
    games: [],
    lastInputs: {},
    lastDt: 0,
    configs: [],
    seeds: [],

    createGame(config = DEFAULT_CONFIG, seed = 1) {
      const players = [];
      for (let id = 0; id < 2 * TEAM_SIZE; id++) {
        const tm = Math.floor(id / TEAM_SIZE);
        const k = id % TEAM_SIZE;
        players.push({
          id, tm, g: k === GOALIE_K ? 1 : 0,
          x: (tm === 0 ? -1 : 1) * (k === GOALIE_K ? 25.5 : 3 + k * 2.1234567),
          y: 0, z: (k - 1) * 3.3333333, vx: 0, vz: 0,
          f: tm === 0 ? 0 : Math.PI, s: 0, sT: 0, tb: 1, fire: 0, ch: 0, c: 0, n: 10 + id,
        });
      }
      const game = {
        config: { ...config }, seed, tick: 0, time: 0,
        ph: PHASE.FACEOFF, phT: 0.25, per: 1, clk: config.periodLength ?? 120,
        sc: [0, 0], teams: [...(config.teams || [0, 1])], players,
        puck: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, o: -1 },
        events: [{ type: EVENT.PERIOD, period: 1 }], gl: [],
      };
      sim.games.push(game);
      sim.configs.push(game.config);
      sim.seeds.push(seed);
      return game;
    },

    assignClient(game, team, clientId) {
      sim.releaseClient(game, clientId);
      for (let k = 0; k < GOALIE_K; k++) {
        const p = game.players[team * TEAM_SIZE + k];
        if (p.c === 0) {
          p.c = clientId;
          return p.id;
        }
      }
      return -1;
    },

    releaseClient(game, clientId) {
      for (const p of game.players) if (p.c === clientId) p.c = 0;
    },

    step(game, dt, inputs) {
      sim.steps++;
      sim.lastDt = dt;
      sim.lastInputs = {};
      for (const [id, v] of Object.entries(inputs || {})) sim.lastInputs[id] = { ...v };
      game.tick++;
      game.time += dt;

      if (game.ph === PHASE.FACEOFF) {
        game.phT -= dt;
        if (game.phT <= 0) {
          game.ph = PHASE.PLAY;
          game.phT = 0;
          game.events.push({ type: EVENT.FACEOFF, x: 0, z: 0 });
        }
      } else if (game.ph === PHASE.PLAY) {
        game.clk = Math.max(0, game.clk - dt);
        if (game.time >= gameSeconds) {
          game.ph = PHASE.GAME_OVER;
          game.events.push({ type: EVENT.FINAL, score: [...game.sc] });
        }
      }

      for (const p of game.players) {
        const inp = p.c ? inputs?.[p.c] : null;
        if (p.c) {
          p.vx = (inp?.mx || 0) * 5;
          p.vz = (inp?.mz || 0) * 5;
        } else if (!p.g) {
          const a = game.time * 0.7 + p.id;
          p.vx = Math.cos(a) * 1.234567;
          p.vz = Math.sin(a) * 1.234567;
        }
        p.x = Math.max(-29, Math.min(29, p.x + p.vx * dt));
        p.z = Math.max(-12, Math.min(12, p.z + p.vz * dt));
        if (p.vx || p.vz) p.f = Math.atan2(p.vz, p.vx);
        p.sT += dt;
      }
      game.puck.x = Math.sin(game.time) * 10.0000123;
      game.puck.vx = Math.cos(game.time) * 10.0000123;
      if (game.tick % 45 === 0) {
        game.events.push({ type: EVENT.SHOT, by: 0, power: 0.123456789, kind: 'wrist' });
      }
    },

    snapshot(game) {
      return {
        tick: game.tick,
        ph: game.ph,
        phT: game.phT,
        per: game.per,
        clk: game.clk,
        sc: [...game.sc],
        teams: [...game.teams],
        p: game.players.map((p) => ({ ...p })),
        k: { ...game.puck },
        gl: [...game.gl],
      };
    },

    drainEvents(game) {
      const ev = game.events;
      game.events = [];
      return ev;
    },
  };
  return sim;
}

// Module-style exports so it can stand in for shared/sim.js: node server/server.js --sim test/fake-sim.js
const moduleSim = createFakeSim({ gameSeconds: 90 });
export const { createGame, step, snapshot, drainEvents, assignClient, releaseClient } = moduleSim;
