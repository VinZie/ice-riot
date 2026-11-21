# ICE RIOT — build contract

Original 3-on-3 arcade hockey (3 skaters + 1 AI goalie per side) for the browser, with an
authoritative Node server so friends on the same Tailscale tailnet can play together.
Mechanics: turbo sprint, body checks (turbo = big hit) that can shatter the glass, wrist shots,
charged slapshots, one-timers, passes, dekes, stick checks, "ON FIRE" streaks, 3 periods +
sudden-death OT, no icing/offside/penalties.

**Originality rule (hard requirement):** this is NOT a port of any existing game. Do not use any
real league, team, player, logo, or brand names, and do not imitate any existing game's UI/art.
All visuals are procedural (Three.js primitives / canvas textures), all audio is synthesized
(WebAudio). No external assets, no CDN requests at runtime (three.js is vendored).

Zero runtime npm dependencies. Node >= 20, ES modules everywhere (`"type": "module"`).

## Layout and ownership

| Path | Owner | Notes |
|---|---|---|
| `shared/constants.js` | lead (frozen) | Rink geometry, ids, buttons, phases, states, events, teams, `glassPanels()`, `boardDistance()`. Do not edit; if you need a constant, define it locally in your own file. |
| `docs/CONTRACT.md` | lead (frozen) | This file. |
| `shared/sim.js` (+ any `shared/sim-*.js`) | **Agent SIM** | Authoritative game simulation + AI. Pure: no IO, no timers, no `Date.now()`, no DOM, no Node APIs. Must run in Node and in a browser. |
| `test/sim.test.js` | Agent SIM | Headless tests (`node test/sim.test.js`). |
| `server/*.js` | **Agent SERVER** | HTTP static server + hand-rolled WebSocket + rooms/lobby + game loop + tailnet helper. |
| `test/server.test.js`, `README.md`, `start.ps1` | Agent SERVER | |
| `public/render/*.js`, `public/render-test.html` | **Agent RENDER** | Three.js scene. |
| `public/index.html`, `public/style.css`, `public/main.js`, `public/net.js`, `public/input.js`, `public/ui.js`, `public/audio.js` | **Agent CLIENT** | App shell, lobby, HUD, input, networking, interpolation, audio. |
| `public/vendor/three.module.min.js` | lead | three.js r160, self-contained module. |

URL mapping (server): `/` -> `public/`, `/shared/*` -> `shared/*`, `/ws` -> WebSocket upgrade.
Browser imports three via an import map in `index.html`: `{"imports": {"three": "/vendor/three.module.min.js"}}`,
so render code writes `import * as THREE from 'three'`. Browser imports constants from `/shared/constants.js`.

## Sim API (`shared/sim.js`)

```js
import { createGame, step, snapshot, drainEvents, assignClient, releaseClient } from '../shared/sim.js';

const game = createGame(config, seed?)   // config = {...DEFAULT_CONFIG, ...overrides}; seed = integer for the sim's own PRNG
assignClient(game, team, clientId)       // clientId: positive integer. Gives that client an AI-controlled skater on `team`
                                         // (never the goalie). Returns the player id, or -1 if that team has no AI skater left.
releaseClient(game, clientId)            // that client's skater goes back to AI. No-op if unknown.
step(game, dt, inputsByClient)           // advance one fixed tick (dt = DT). inputsByClient: { [clientId]: {mx, mz, b} }
                                         // Missing client => treat as no input (mx=mz=0, b=0). Sim does edge detection itself
                                         // (pressed / released) by remembering the previous `b` per clientId.
snapshot(game)                           // -> plain JSON-safe object, format "Snapshot" below (without t/time/ev)
drainEvents(game)                        // -> array of events emitted since the last drain, then clears the queue
```

The sim owns everything about gameplay: phases, the clock, faceoffs, the puck, skater + goalie AI,
control switching (PASS without the puck moves that client's `ctrl` to the AI teammate nearest the
puck; emits SWITCH), and ON FIRE. When the game ends the phase stays GAME_OVER; the server decides
what to do next. All randomness goes through the sim's seeded PRNG.

## Network protocol (JSON text frames over `/ws`)

Client -> server:

| msg | meaning |
|---|---|
| `{t:'hello', name, room}` | first message. `name` <= 16 chars (server sanitizes). `room` defaults to `'main'`. |
| `{t:'pick', team}` | `0` home, `1` away, `-1` spectate. Works in the lobby and mid-game (drop-in onto an AI skater). |
| `{t:'config', teams:[h,a], periodLength, difficulty}` | host only, lobby only. `periodLength` in {60,120,180,300}; `difficulty` 0..2; teams = indices into TEAMS, must differ. |
| `{t:'start'}` | host only, lobby only. Starts a game; empty skater slots are AI. |
| `{t:'lobby'}` | host only, during a game or GAME_OVER: abort / return everyone to the lobby. |
| `{t:'in', seq, mx, mz, b}` | input, sent every animation frame (throttled to <= 60/s) while in a game. `mx`,`mz` in [-1,1] are WORLD-space stick direction (see constants.js header: up key = -Z). `b` = BTN bitfield. |
| `{t:'ping', c}` | `c` = client `performance.now()`. |

Server -> client:

| msg | meaning |
|---|---|
| `{t:'welcome', id, room}` | your clientId (positive int). |
| `{t:'lobby', state, host, clients, config}` | sent on every lobby change. `state`: `'lobby'` or `'game'`. `host`: clientId. `clients`: `[{id, name, team, ping}]` (team -1 = spectator). `config`: current config. |
| `{t:'snap', time, ...Snapshot, ev}` | at SNAP_RATE while a game runs. `time` = server ms clock (monotonic, `performance.now()`-style). `ev` = events drained since the previous snap. |
| `{t:'pong', c, s}` | echo `c`, `s` = server ms clock at reply. |
| `{t:'err', msg}` | human-readable error (team full, not host, ...). |

After GAME_OVER the server keeps sending snaps for 12 s, then returns the room to the lobby automatically
(or earlier if the host sends `{t:'lobby'}`).

## Snapshot format

Numbers rounded to 3 decimals by the server (sim may return full precision).

```js
{
  tick,                 // int, sim tick counter
  ph,                   // PHASE.*
  phT,                  // seconds remaining in the current timed phase (FACEOFF/GOAL/PERIOD_END), else 0
  per,                  // current period, 1-based; per > config.periods means overtime
  clk,                  // seconds left in the period (counts down during PLAY only)
  sc: [home, away],
  teams: [h, a],        // TEAMS indices
  p: [                  // always 8 entries, index == player id (team*4 + k; k=3 is the goalie)
    { id, tm, g,        // g: 1 if goalie
      x, y, z,          // position (y > 0 only when airborne, e.g. launched by a big hit)
      vx, vz,           // velocity m/s
      f,                // facing, radians, angle in the XZ plane measured from +X toward +Z
                        // (i.e. direction vector = (cos f, sin f)); stick/puck is in front along f
      s, sT,            // PSTATE.*, seconds spent in that state
      tb,               // turbo 0..1
      fire,             // 1 when ON FIRE
      ch,               // slapshot charge 0..1 (0 unless s == CHARGE)
      c,                // controlling clientId, 0 = AI
      n }               // jersey number
  ],
  k: { x, y, z, vx, vy, vz, o },   // puck; o = owner player id or -1
  gl: [panelIndex, ...],           // currently broken glass panels (they are restored at each faceoff)
}
```

Note on `f`: a skater at (x,z) facing f carries the puck at (x + cos f * stickReach, z + sin f * stickReach).
In Three.js a mesh whose "forward" is local +X needs `rotation.y = -f` to face that way.

## Client module APIs (so RENDER and CLIENT can be built in parallel)

`public/render/renderer.js` (RENDER) exports:

```js
export function createRenderer(canvas) -> renderer
renderer.setTeams([h, a])                 // recolor jerseys etc. from TEAMS[h], TEAMS[a]
renderer.update(state, dt, events, ctx)   // state: a Snapshot-shaped object (already interpolated by CLIENT);
                                          // dt: seconds since last frame; events: events whose time has come this frame
                                          // (may be []); ctx: { myId: clientId, names: {clientId: name} }
renderer.render()
renderer.resize(width, height)            // CSS pixels; renderer handles devicePixelRatio (cap at 2)
renderer.dispose()
```

The renderer owns: rink/boards/glass/nets/crowd/arena, skater + goalie models, the camera (broadcast
side view from +Z, follows the puck smoothly, slight zoom on action), every visual effect (puck trail,
ON FIRE flames, hit sparks + screen shake on big hits, glass shatter shards, goal light + net ripple,
slapshot charge glow, highlight ring + name tag on human-controlled skaters, extra-visible marker on the
local player `ctx.myId`). When no state has arrived yet (lobby), `update(null, dt, [], ctx)` must still
work and show a slow orbiting attract-mode camera over the empty rink.

`public/main.js` (CLIENT) owns the loop: rAF -> poll input -> send `in` -> get interpolated state from
`net.js` -> `renderer.update(...)` -> `renderer.render()` -> `ui.update(...)` -> `audio.handle(events)`.
CLIENT does interpolation (render ~2 snapshot intervals behind the estimated server clock, lerp positions,
`lerpAngle` facings, snap discrete fields from the newer snapshot) and releases each snapshot's `ev`
when render time passes that snapshot's `time`.
