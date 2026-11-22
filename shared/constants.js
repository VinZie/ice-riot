// ICE RIOT - shared constants. Imported by the server (Node ESM) and the browser
// (served at /shared/constants.js). Pure data + pure helpers only: no IO, no DOM.
//
// COORDINATES (meters, right-handed, Y up):
//   X runs along the rink length (-30 .. +30). Team 0 (HOME) defends the goal at -X
//   and attacks +X. Team 1 (AWAY) defends +X and attacks -X. Sides never swap.
//   Z runs across the width (-13 .. +13). The broadcast camera sits on the +Z side
//   looking toward -Z, so on screen: right = +X, "up" key = -Z, "down" key = +Z.
//   Y = 0 is the ice surface.

export const GAME_NAME = 'ICE RIOT';

export const TICK_RATE = 60;            // sim steps per second (server)
export const SNAP_RATE = 30;            // snapshots per second (server -> clients)
export const DT = 1 / TICK_RATE;
export const DEFAULT_PORT = 8765;

export const RINK = {
  halfLength: 30,       // end boards at x = +/-30
  halfWidth: 13,        // side boards at z = +/-13
  cornerRadius: 8,
  boardHeight: 1.07,
  glassHeight: 1.6,     // glass rises this far above the top of the boards
  goalLineX: 26.6,      // goal lines at x = +/-26.6
  blueLineX: 7.6,       // blue lines at x = +/-7.6 (cosmetic: no offside/icing)
  centerCircleR: 4.5,
  faceoffCircleR: 4.5,
  goalHalfWidth: 1.0,   // goal mouth spans z = -1..+1 (arcade-sized)
  goalHeight: 1.22,
  goalDepth: 1.1,       // net extends this far behind the goal line, toward the end boards
  creaseRadius: 1.8,
  postRadius: 0.06,
};

export const PUCK = {
  radius: 0.12,         // arcade-sized collision radius (rendered a bit larger)
  height: 0.06,
};

export const PLAYER = {
  radius: 0.45,         // skater body collision radius
  goalieRadius: 0.6,
  height: 1.85,
  stickReach: 1.0,      // puck carried this far in front of the skater, along facing
};

export const TEAM_SIZE = 4;             // 3 skaters + 1 goalie per team
export const SKATERS_PER_TEAM = 3;
export const MAX_HUMANS_PER_TEAM = 3;   // goalies are always AI

// Player ids are fixed for a game: team t, index k (0..3) -> id = t*4 + k.
// k = 0..2 are skaters, k = 3 is the goalie.
export const playerId = (team, k) => team * TEAM_SIZE + k;
export const GOALIE_K = 3;

// Input button bits (client -> server `in.b`). The meaning depends on context:
//   SHOOT : with puck -> tap = wrist shot, hold+release = charged slapshot.
//           pressed while a pass is arriving to you -> one-timer.
//           without puck -> body check (with TURBO held = big hit).
//   PASS  : with puck -> pass toward the teammate nearest the stick direction.
//           without puck -> switch to the AI teammate nearest the puck (if any).
//   ACTION: with puck -> deke / spin move (brief evade, beats stick checks).
//           without puck -> stick check (poke the puck loose).
//   TURBO : hold to sprint (drains the turbo meter; refills when released).
export const BTN = { SHOOT: 1, PASS: 2, ACTION: 4, TURBO: 8 };

// Game phases (snapshot `ph`).
export const PHASE = {
  FACEOFF: 1,     // players are placed for a faceoff, puck drops when phaseT ends
  PLAY: 2,
  GOAL: 3,        // celebration, then FACEOFF
  PERIOD_END: 4,  // intermission, then FACEOFF of next period (or GAME_OVER)
  GAME_OVER: 5,
};
// GOAL holds play long enough for the client's instant replay (public/extras.js planReplay), which
// starts 0.8 s after the goal and must end before the faceoff drops the puck: the run-up, the 0.35x
// windup and the 0.15x puck-going-in finish.
export const PHASE_DURATION = { FACEOFF: 1.6, GOAL: 9, PERIOD_END: 4.0 };

// Skater / goalie states (snapshot player `s`).
export const PSTATE = {
  SKATE: 0,
  CHARGE: 1,      // winding up a slapshot (charge in `ch`)
  SHOOT: 2,       // shot follow-through
  CHECK: 3,       // body-check lunge
  POKE: 4,        // stick-check
  DEKE: 5,        // spin move
  DOWN: 6,        // knocked down, sliding / getting up
  CELEBRATE: 7,
  SAVE: 8,        // goalie save / dive
};

export const EVENT = {
  GOAL: 'goal',         // {team, scorer, assist, oneTimer, x, z}
  SHOT: 'shot',         // {by, power, kind:'wrist'|'slap'|'onetimer'}
  PASS: 'pass',         // {by, to}
  SAVE: 'save',         // {goalie, x, z}
  POST: 'post',         // {x, z}
  HIT: 'hit',           // {by, target, power (0..1), big, x, z}
  GLASS: 'glass',       // {panel, by, target, x, z}
  BOARDS: 'boards',     // puck hit the boards {x, z, power}
  STEAL: 'steal',       // {by, from}
  DEKE: 'deke',         // {by}
  FACEOFF: 'faceoff',   // puck dropped {x, z}
  WHISTLE: 'whistle',   // play stopped
  PERIOD: 'period',     // new period started {period}
  PERIOD_END: 'periodEnd', // {period}
  FINAL: 'final',       // {score:[h,a]}
  FIRE: 'fire',         // {player, on}
  SWITCH: 'switch',     // human control moved {client, from, to}
};

export const DEFAULT_CONFIG = {
  teams: [0, 1],        // indices into TEAMS for [home, away]
  periodLength: 120,    // seconds per period
  periods: 3,           // then sudden-death overtime if tied
  difficulty: 1,        // AI: 0 = rookie, 1 = pro, 2 = all-star
};

// Fictional teams. Attributes are 1..10 and scale speed / shot power / pass accuracy /
// checking power / puck handling in the sim. colors: primary, secondary, accent (hex ints).
export const TEAMS = [
  {
    key: 'HAM', city: 'Harbor', name: 'Hammers',
    colors: { primary: 0xff6a13, secondary: 0x14213d, accent: 0xffffff },
    skaters: [
      { name: 'Brask', num: 12, spd: 7, sht: 8, pas: 6, chk: 8, hnd: 6 },
      { name: 'Oduya', num: 4, spd: 6, sht: 6, pas: 7, chk: 9, hnd: 5 },
      { name: 'Lindqvist', num: 27, spd: 9, sht: 7, pas: 8, chk: 5, hnd: 8 },
    ],
    goalie: { name: 'Mertz', num: 31, skill: 7 },
  },
  {
    key: 'FWV', city: 'Frostbite', name: 'Wolves',
    colors: { primary: 0x7fd3ff, secondary: 0x0b2545, accent: 0xffffff },
    skaters: [
      { name: 'Kallio', num: 19, spd: 8, sht: 7, pas: 8, chk: 6, hnd: 8 },
      { name: 'Bergeron-Ash', num: 2, spd: 6, sht: 7, pas: 6, chk: 9, hnd: 5 },
      { name: 'Tamura', num: 88, spd: 9, sht: 8, pas: 7, chk: 4, hnd: 9 },
    ],
    goalie: { name: 'Novak', num: 30, skill: 8 },
  },
  {
    key: 'NVP', city: 'Neon', name: 'Vipers',
    colors: { primary: 0x39ff14, secondary: 0x111111, accent: 0xff2bd6 },
    skaters: [
      { name: 'Vex', num: 9, spd: 9, sht: 9, pas: 6, chk: 5, hnd: 8 },
      { name: 'Crane', num: 44, spd: 5, sht: 7, pas: 6, chk: 10, hnd: 5 },
      { name: 'Ito', num: 17, spd: 8, sht: 6, pas: 9, chk: 5, hnd: 9 },
    ],
    goalie: { name: 'Draxler', num: 1, skill: 6 },
  },
  {
    key: 'IYT', city: 'Iron', name: 'Yetis',
    colors: { primary: 0xb8c4d6, secondary: 0x4b1d80, accent: 0xffd400 },
    skaters: [
      { name: 'Haugen', num: 55, spd: 5, sht: 8, pas: 6, chk: 10, hnd: 5 },
      { name: 'Petrov', num: 8, spd: 7, sht: 9, pas: 7, chk: 7, hnd: 7 },
      { name: 'Okafor', num: 21, spd: 8, sht: 6, pas: 8, chk: 6, hnd: 8 },
    ],
    goalie: { name: 'Sorensen', num: 35, skill: 8 },
  },
  {
    key: 'SFL', city: 'Solar', name: 'Flares',
    colors: { primary: 0xffd23f, secondary: 0xc1121f, accent: 0x1d1d1d },
    skaters: [
      { name: 'Raines', num: 10, spd: 8, sht: 8, pas: 7, chk: 6, hnd: 8 },
      { name: 'Mbeki', num: 3, spd: 6, sht: 6, pas: 7, chk: 9, hnd: 6 },
      { name: 'Castell', num: 91, spd: 9, sht: 9, pas: 6, chk: 5, hnd: 7 },
    ],
    goalie: { name: 'Quill', num: 40, skill: 7 },
  },
  {
    key: 'MKR', city: 'Midnight', name: 'Krakens',
    colors: { primary: 0x00a6a6, secondary: 0x0d0d1a, accent: 0xe0e0e0 },
    skaters: [
      { name: 'Abernathy', num: 6, spd: 7, sht: 7, pas: 9, chk: 7, hnd: 7 },
      { name: 'Sato', num: 23, spd: 9, sht: 8, pas: 7, chk: 4, hnd: 9 },
      { name: 'Grimsby', num: 77, spd: 6, sht: 8, pas: 5, chk: 10, hnd: 5 },
    ],
    goalie: { name: 'Vuori', num: 33, skill: 9 },
  },
];

// Glass panels sit on top of the boards around the whole rounded-rectangle perimeter.
// Both the sim (which panel broke) and the renderer (where to draw it) use this list,
// so the panel index in a GLASS event / snapshot `gl` array means the same thing everywhere.
// Each panel: { i, x, z (center on the board line), nx, nz (unit normal pointing INTO the rink),
//               angle (rotation about Y so the panel's local +X runs along the board), len }
export function glassPanels() {
  const { halfLength: L, halfWidth: W, cornerRadius: R } = RINK;
  const panels = [];
  const add = (x, z, nx, nz, len) => {
    // tangent = normal rotated 90deg; angle chosen so local +X aligns with tangent
    const tx = -nz, tz = nx;
    panels.push({ i: panels.length, x, z, nx, nz, len, angle: Math.atan2(-tz, tx) });
  };
  const straight = (x0, z0, x1, z1, n, nx, nz) => {
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const len = Math.hypot(x1 - x0, z1 - z0) / n;
      add(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, nx, nz, len);
    }
  };
  const corner = (cx, cz, a0, n) => {
    // arc of 90deg starting at angle a0 (radians, measured in the XZ plane from +X toward +Z)
    const chord = 2 * R * Math.sin(Math.PI / 4 / n);
    for (let k = 0; k < n; k++) {
      const a = a0 + (Math.PI / 2) * (k + 0.5) / n;
      const ox = Math.cos(a), oz = Math.sin(a);
      add(cx + ox * R, cz + oz * R, -ox, -oz, chord);
    }
  };
  // far side (z = -W), from -X to +X
  straight(-(L - R), -W, L - R, -W, 11, 0, 1);
  // +X far corner, +X end, +X near corner
  corner(L - R, -(W - R), -Math.PI / 2, 4);
  straight(L, -(W - R), L, W - R, 3, -1, 0);
  corner(L - R, W - R, 0, 4);
  // near side (z = +W, camera side), from +X to -X
  straight(L - R, W, -(L - R), W, 11, 0, -1);
  // -X near corner, -X end, -X far corner
  corner(-(L - R), W - R, Math.PI / 2, 4);
  straight(-L, W - R, -L, -(W - R), 3, 1, 0);
  corner(-(L - R), -(W - R), Math.PI, 4);
  return panels; // 44 panels
}

// Signed distance from point (x,z) to the inside of the board line. Positive = inside the rink,
// value = distance to the nearest board. Also returns the inward normal at the closest point.
export function boardDistance(x, z) {
  const { halfLength: L, halfWidth: W, cornerRadius: R } = RINK;
  const ax = Math.abs(x), az = Math.abs(z);
  const sx = Math.sign(x) || 1, sz = Math.sign(z) || 1;
  const cx = L - R, cz = W - R;
  if (ax > cx && az > cz) {
    const dx = ax - cx, dz = az - cz;
    const d = Math.hypot(dx, dz) || 1e-6;
    return { d: R - d, nx: -sx * dx / d, nz: -sz * dz / d };
  }
  const dX = L - ax, dZ = W - az;
  return dX < dZ ? { d: dX, nx: -sx, nz: 0 } : { d: dZ, nx: 0, nz: -sz };
}

// Index of the glass panel nearest to a point on/near the boards.
let _panels = null;
export function nearestGlassPanel(x, z) {
  _panels ||= glassPanels();
  let best = 0, bd = Infinity;
  for (const p of _panels) {
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bd) { bd = d; best = p.i; }
  }
  return best;
}

// Faceoff dots (cosmetic + sim faceoff spots).
export const FACEOFF_SPOTS = [
  { x: 0, z: 0 },
  { x: -20, z: -7 }, { x: -20, z: 7 }, { x: 20, z: -7 }, { x: 20, z: 7 },
];

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
// Shortest-path angle lerp (radians).
export function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return a + d * t;
}
