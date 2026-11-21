// ICE RIOT - client entry point: wires net + input + renderer + UI + audio and runs the loop.
//
// URL params:
//   ?room=NAME            room to join (default 'main')
//   ?name=X               player name for this session
//   ?team=0|1             auto-pick that team on welcome           (used by end-to-end tests)
//   ?autostart=1          if host, start the game once the pick is in (used by end-to-end tests)
//   ?demo=lobby|hud|final|menu   offline UI preview with fake data (no server needed)
//   ?nogl=1               skip the 3D renderer (2D fallback view)

import { SNAP_RATE, DEFAULT_CONFIG, TEAMS, PHASE, PSTATE, EVENT, RINK, TEAM_SIZE } from '/shared/constants.js';
import { createNet } from './net.js';
import { createInput, isTypingTarget } from './input.js';
import { createUI } from './ui.js';
import { createAudio } from './audio.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui');

function showFatal(title, detail) {
  const el = document.getElementById('fatal');
  if (!el) { alert(`${title}\n${detail}`); return; }
  el.querySelector('.fatal-title').textContent = title;
  el.querySelector('.fatal-detail').textContent = String(detail || '');
  el.hidden = false;
}

function defaultName() {
  const fromUrl = params.get('name');
  if (fromUrl) return fromUrl.slice(0, 16);
  try { const s = localStorage.getItem('iceriot.name'); if (s) return s.slice(0, 16); } catch { /* ignore */ }
  const tags = ['BLADE', 'SLAPPER', 'ICEMAN', 'RINKRAT', 'ZAMBONI', 'BISCUIT', 'CELLY', 'SNIPER'];
  return `${tags[Math.floor(Math.random() * tags.length)]}${Math.floor(10 + Math.random() * 90)}`;
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
const demo = params.get('demo');
// `net` is swapped for an in-browser session during offline practice (see extras.js);
// everything below reads the variable at call time, so the swap is transparent.
let net = demo
  ? createDemoNet(demo)
  : createNet({ name: defaultName(), room: params.get('room') || 'main', snapRate: SNAP_RATE });
const onlineNet = net;
let extras = null;
const input = createInput();
const audio = createAudio();
const ui = createUI(uiRoot, {
  pick: (team) => net.pick(team),
  config: (cfg) => net.sendConfig(cfg),
  start: () => net.start(),
  toLobby: () => net.toLobby(),
  setName: (n) => net.setName(n),
  toggleMute: () => audio.toggleMute(),
  setVolume: (v) => audio.setVolume(v),
  blip: (k) => audio.blip(k),
  audioState: () => ({ muted: audio.muted, volume: audio.volume }),
  menuChanged: () => input.clear(),
  extra: (x) => { if (extras) extras.extra(x); else ui.toast('Still loading…', 'info'); },
});
ui.setName(net.name);
window.__iceRiotBooted = true;

// Optional feature modules (settings, music, replay, touch, chat, couch, challenges,
// tutorial, leaderboard, offline practice). Loaded async; the game runs fine without them.
if (!demo) {
  import('./extras.js')
    .then((m) => m.createExtras({ onlineNet, getNet: () => net, setNet: (n) => { net = n; }, ui, input, audio, uiRoot }))
    .then((x) => { extras = x; window.__iceRiotExtras = true; })
    .catch((e) => console.warn('[ICE RIOT] extras unavailable:', e));
}

net.on('err', (m) => { ui.toast(m.msg || 'Server error', 'error'); audio.blip('error'); });

// Test hooks: ?team=0|1 auto-picks on welcome, ?autostart=1 starts the game when we are host.
const autoTeam = params.has('team') ? Number(params.get('team')) : null;
const autoStart = params.get('autostart') === '1';
let autoPicked = false, autoStarted = false;
net.on('welcome', () => {
  if (!autoPicked && (autoTeam === 0 || autoTeam === 1 || autoTeam === -1)) { autoPicked = true; net.pick(autoTeam); }
});
net.on('lobby', (L) => {
  if (!autoStart || autoStarted || !L || L.state !== 'lobby' || L.host !== net.myId) return;
  const me = (L.clients || []).find((c) => c.id === net.myId);
  if (autoTeam === null || (me && me.team === autoTeam)) { autoStarted = true; net.start(); }
});
net.connect();

// ---------------------------------------------------------------------------------------------
// Renderer (loaded asynchronously so the lobby works even if 3D fails)
// ---------------------------------------------------------------------------------------------
let renderer = null;
let fallback = null;
let rendererFailed = false;
let lastTeamsKey = '';

function useFallback(reason) {
  rendererFailed = true;
  renderer = null;
  if (!fallback) fallback = createFallback2D();
  const msg = reason && reason.message ? reason.message : String(reason || 'unknown error');
  console.error('[ICE RIOT] renderer unavailable:', reason);
  ui.banner(`3D renderer unavailable (${msg}). Showing the simple 2D view instead — the game is still playable.`);
  resize();
}

async function loadRenderer() {
  if (params.get('nogl') === '1') { useFallback(new Error('disabled with ?nogl=1')); return; }
  try {
    const mod = await import('./render/renderer.js');
    if (typeof mod.createRenderer !== 'function') throw new Error('render/renderer.js has no createRenderer export');
    renderer = mod.createRenderer(canvas);
    lastTeamsKey = '';
    resize();
  } catch (e) {
    useFallback(e);
  }
}
loadRenderer();

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (renderer) { try { renderer.resize(w, h); } catch (e) { useFallback(e); } }
  if (fallback) fallback.resize(w, h);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));

let seq = 0, accB = 0;

// ---------------------------------------------------------------------------------------------
// Global keys: Esc menu, M mute, F fullscreen
// ---------------------------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Escape') {
    if (isTypingTarget(e.target)) { e.target.blur(); return; }
    if (ui.screen === 'game') { e.preventDefault(); ui.toggleMenu(); }
    return;
  }
  if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'KeyM') {
    const m = audio.toggleMute();
    ui.syncSound();
    ui.toast(m ? 'Sound off' : 'Sound on', 'info');
  } else if (e.code === 'KeyF') {
    toggleFullscreen();
  }
});
function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  } catch { /* unsupported */ }
}
input.onPadButton((btn) => ui.padNav(btn));

// rAF stops in background tabs, so tell the server "hands off the stick" right away instead of
// letting it keep applying the last held input.
function releaseStick() {
  input.clear();
  accB = 0;
  const L = net.lobby;
  const me = L && (L.clients || []).find((c) => c.id === net.myId);
  if (L && L.state === 'game' && me && (me.team === 0 || me.team === 1)) net.sendInput(++seq, 0, 0, 0);
}
window.addEventListener('blur', releaseStick);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseStick(); });

// ---------------------------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------------------------
let last = performance.now();
let lastSend = 0;
let renderErrors = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;

  const L = net.lobby;
  const clients = (L && L.clients) || [];
  const me = clients.find((c) => c.id === net.myId);
  const myTeam = me ? me.team : -1;
  const inGame = !!L && L.state === 'game';
  const playing = inGame && (myTeam === 0 || myTeam === 1);

  // input -> server (<= 60/s); buttons are OR-ed between sends so taps are never dropped
  input.setGameActive(inGame && !ui.menuOpen);
  const rawInp = input.poll();
  const inp = extras ? extras.filterInput(rawInp, { inGame, menuOpen: ui.menuOpen }) : rawInp;
  if (playing) {
    accB |= ui.menuOpen ? 0 : inp.b;
    if (now - lastSend >= 1000 / 60 - 1.5) {
      // advance on a 60 Hz grid (not to `now`) so 66-144 Hz displays still send ~60 inputs/s
      lastSend = Math.max(lastSend + 1000 / 60, now - 1000 / 60);
      if (ui.menuOpen) net.sendInput(++seq, 0, 0, 0);
      else net.sendInput(++seq, inp.mx, inp.mz, accB);
      accB = 0;
    }
  } else {
    accB = 0;
  }

  const state = net.getState(now);
  const events = net.takeEvents();
  const names = {};
  for (const c of clients) names[c.id] = c.name;
  const ctx = { myId: net.myId, names };
  // What the renderer shows (an instant replay may substitute recorded frames for the live state).
  const view = extras ? extras.view(state, events, now, dt) : { state, events, dt };
  const rctx = extras ? extras.decorateCtx({ myId: net.myId, names: { ...names } }) : ctx;

  const teams = (state && state.teams) || (L && L.config && L.config.teams) || DEFAULT_CONFIG.teams;
  const teamsKey = teams.join(',');
  if (teamsKey !== lastTeamsKey) {
    lastTeamsKey = teamsKey;
    if (renderer) { try { renderer.setTeams(teams); } catch (e) { console.error(e); } }
  }

  if (renderer) {
    try {
      renderer.update(view.state, view.dt, view.events, rctx);
      renderer.render();
    } catch (e) {
      console.error('[ICE RIOT] renderer error', e);
      if (++renderErrors > 30) useFallback(e);
    }
  } else if (fallback) {
    fallback.draw(view.state, rctx);
  }

  ui.update({
    now, status: net.status, rtt: net.rtt, retryIn: net.retryIn(), lobby: L, myId: net.myId,
    state, events, names, gameSerial: net.gameSerial,
  });
  audio.setScene(inGame ? 'game' : 'lobby');
  audio.handle(events, state, ctx);
  if (extras) {
    try {
      extras.after({ state, events, ctx, dt, lobby: L, inGame, playing, menuOpen: ui.menuOpen, myTeam });
    } catch (e) { console.warn('[ICE RIOT] extras error', e); }
  }
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------------------------
// 2D fallback view (only used if the 3D renderer cannot load)
// ---------------------------------------------------------------------------------------------
function createFallback2D() {
  const c = document.createElement('canvas');
  c.id = 'fallback2d';
  canvas.after(c);
  canvas.style.visibility = 'hidden';
  const g = c.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');
  return {
    resize(w, h) {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = w; H = h;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = w + 'px'; c.style.height = h + 'px';
    },
    draw(state, ctx) {
      if (!W) this.resize(window.innerWidth, window.innerHeight);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#05080f'; g.fillRect(0, 0, W, H);
      const L = RINK.halfLength, Wd = RINK.halfWidth;
      const s = Math.min((W * 0.92) / (2 * L), (H * 0.8) / (2 * Wd));
      const ox = W / 2, oz = H / 2 + H * 0.04;
      const X = (x) => ox + x * s, Z = (z) => oz + z * s;
      // ice
      g.beginPath();
      g.roundRect(X(-L), Z(-Wd), 2 * L * s, 2 * Wd * s, RINK.cornerRadius * s);
      g.fillStyle = '#dfeaf3'; g.fill();
      g.lineWidth = 4; g.strokeStyle = '#ffd400'; g.stroke();
      const line = (x, col, w) => { g.fillStyle = col; g.fillRect(X(x) - w / 2, Z(-Wd), w, 2 * Wd * s); };
      line(0, '#e0263f', 4); line(-RINK.blueLineX, '#1f5fd6', 5); line(RINK.blueLineX, '#1f5fd6', 5);
      line(-RINK.goalLineX, '#e0263f', 2); line(RINK.goalLineX, '#e0263f', 2);
      g.strokeStyle = '#1f5fd6'; g.lineWidth = 2;
      g.beginPath(); g.arc(X(0), Z(0), RINK.centerCircleR * s, 0, Math.PI * 2); g.stroke();
      for (const side of [-1, 1]) {
        g.fillStyle = 'rgba(80,140,255,0.35)';
        g.beginPath(); g.arc(X(side * RINK.goalLineX), Z(0), RINK.creaseRadius * s, side < 0 ? -Math.PI / 2 : Math.PI / 2, side < 0 ? Math.PI / 2 : Math.PI * 1.5); g.fill();
        g.fillStyle = '#c21d2f';
        const gx = side < 0 ? X(-RINK.goalLineX - RINK.goalDepth) : X(RINK.goalLineX);
        g.fillRect(gx, Z(-RINK.goalHalfWidth), RINK.goalDepth * s, 2 * RINK.goalHalfWidth * s);
      }
      if (!state) return;
      const teams = state.teams || DEFAULT_CONFIG.teams;
      for (const p of state.p || []) {
        if (!p) continue;
        const T = TEAMS[teams[p.tm ?? Math.floor(p.id / TEAM_SIZE)]] || TEAMS[0];
        const r = (p.g ? 0.6 : 0.45) * s * 1.25;
        g.beginPath(); g.arc(X(p.x), Z(p.z), r, 0, Math.PI * 2);
        g.fillStyle = hex(T.colors.primary); g.fill();
        g.lineWidth = p.c ? 3 : 1.5;
        g.strokeStyle = p.c && p.c === ctx.myId ? '#ffffff' : p.c ? '#ffd400' : hex(T.colors.secondary);
        g.stroke();
        g.beginPath(); g.moveTo(X(p.x), Z(p.z));
        g.lineTo(X(p.x + Math.cos(p.f) * 1.0), Z(p.z + Math.sin(p.f) * 1.0));
        g.strokeStyle = '#111'; g.lineWidth = 2; g.stroke();
        if (p.fire) { g.beginPath(); g.arc(X(p.x), Z(p.z), r + 4, 0, Math.PI * 2); g.strokeStyle = '#ff6a00'; g.lineWidth = 3; g.stroke(); }
        if (p.c) {
          g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'center'; g.fillStyle = '#111';
          g.fillText(String(ctx.names[p.c] || '').toUpperCase(), X(p.x), Z(p.z) - r - 6);
        }
      }
      if (state.k) {
        g.beginPath(); g.arc(X(state.k.x), Z(state.k.z), Math.max(3, 0.2 * s), 0, Math.PI * 2);
        g.fillStyle = '#000'; g.fill();
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Offline demo (?demo=...) - fake lobby / snapshots for UI previews and screenshots.
// ---------------------------------------------------------------------------------------------
function createDemoNet(mode) {
  const listeners = {};
  const t0 = performance.now();
  const myId = 1;
  const clients = [
    { id: 1, name: 'BLADE', team: 0, ping: 18 },
    { id: 2, name: 'Mags', team: 0, ping: 31 },
    { id: 3, name: 'DeepFreeze', team: 1, ping: 44 },
    { id: 4, name: 'Toaster', team: -1, ping: 72 },
    { id: 5, name: 'nik', team: -1, ping: 25 },
  ];
  const config = { ...DEFAULT_CONFIG, teams: [0, 2], periodLength: 180, difficulty: 1 };
  const lobby = { t: 'lobby', state: mode === 'lobby' ? 'lobby' : 'game', host: myId, clients, config };
  const evQueue = [];
  const fired = new Set();
  let menuOpened = false;
  const at = (sec, key, evs) => {
    if (fired.has(key) || (performance.now() - t0) / 1000 < sec) return;
    fired.add(key);
    evQueue.push(...evs);
  };
  const net = {
    status: 'online', myId, room: 'main', name: 'BLADE', lobby, rtt: 21, gameSerial: 1, interpDelay: 66,
    on(type, fn) { (listeners[type] ||= []).push(fn); return net; },
    connect() { return net; },
    retryIn: () => 0,
    pick(team) { clients[0].team = team; net.lobby = { ...lobby, clients: [...clients] }; },
    sendConfig(c) { Object.assign(config, c); net.lobby = { ...lobby, config: { ...config }, clients: [...clients] }; },
    start() { net.lobby = { ...net.lobby, state: 'game' }; },
    toLobby() { net.lobby = { ...net.lobby, state: 'lobby' }; },
    sendInput() { return true; },
    setName(n) { clients[0].name = n; net.name = n; net.lobby = { ...net.lobby, clients: [...clients] }; },
    takeEvents() { return evQueue.splice(0); },
    getState(now) {
      if (!net.lobby || net.lobby.state !== 'game') return null;
      const t = (now - t0) / 1000;
      const over = mode === 'final';
      if (mode === 'menu' && !menuOpened) { menuOpened = true; queueMicrotask(() => ui.toggleMenu()); }
      if (over) {
        at(0.1, 'stats', [
          ...Array.from({ length: 23 }, () => ({ type: EVENT.SHOT, by: 0, kind: 'wrist' })),
          ...Array.from({ length: 17 }, () => ({ type: EVENT.SHOT, by: 5, kind: 'slap' })),
          ...Array.from({ length: 14 }, () => ({ type: EVENT.HIT, by: 1, target: 4, power: 0.5, big: false })),
          ...Array.from({ length: 9 }, () => ({ type: EVENT.HIT, by: 6, target: 2, power: 0.5, big: false })),
          { type: EVENT.HIT, by: 1, target: 4, power: 1, big: true }, { type: EVENT.HIT, by: 1, target: 5, power: 1, big: true },
          { type: EVENT.HIT, by: 6, target: 0, power: 1, big: true },
          { type: EVENT.GLASS, by: 1, target: 4, panel: 3 },
          ...Array.from({ length: 13 }, () => ({ type: EVENT.SAVE, goalie: 3 })),
          ...Array.from({ length: 19 }, () => ({ type: EVENT.SAVE, goalie: 7 })),
        ]);
      } else {
        const evName = params.get('ev') || 'goal';
        const demoEvents = {
          goal: { type: EVENT.GOAL, team: 0, scorer: 0, assist: 1, oneTimer: false, x: 26, z: 0 },
          hit: { type: EVENT.HIT, by: 1, target: 5, power: 1, big: true, x: 4, z: 3 },
          glass: { type: EVENT.GLASS, by: 1, target: 5, panel: 4, x: 0, z: -13 },
          fire: { type: EVENT.FIRE, player: 0, on: true },
          ot: { type: EVENT.PERIOD, period: 4 },
          save: { type: EVENT.SAVE, goalie: 7, x: 26, z: 0 },
          onetimer: { type: EVENT.SHOT, by: 0, kind: 'onetimer', power: 1 },
        };
        if (demoEvents[evName]) at(Number(params.get('evat') || 3.6), 'ev', [demoEvents[evName]]);
      }
      const p = [];
      for (let id = 0; id < 8; id++) {
        const tm = id < 4 ? 0 : 1, k = id % 4;
        const goalie = k === 3;
        const ph = t * 0.6 + id * 0.8;
        const x = goalie ? (tm === 0 ? -25.6 : 25.6) : Math.sin(ph) * 14 + (tm === 0 ? -3 : 3);
        const z = goalie ? Math.sin(t + id) * 0.6 : Math.cos(ph * 1.3) * 8;
        p.push({ id, tm, g: goalie ? 1 : 0, x, y: 0, z, vx: Math.cos(ph) * 8, vz: -Math.sin(ph * 1.3) * 10, f: Math.atan2(-Math.sin(ph * 1.3), Math.cos(ph)),
          s: id === 0 ? PSTATE.CHARGE : PSTATE.SKATE, sT: 0.5, tb: id === 0 ? 0.62 : 1, fire: id === 0 ? 1 : 0, ch: id === 0 ? (t * 0.5) % 1 : 0,
          c: id === 0 ? 1 : id === 1 ? 2 : id === 4 ? 3 : 0, n: 10 + id });
      }
      const owner = p[0];
      return {
        time: now, tick: Math.floor(t * 60), ph: over ? PHASE.GAME_OVER : PHASE.PLAY, phT: 0, per: 2, clk: Math.max(0, 94.3 - t),
        sc: over ? [4, 3] : [2, 1], teams: config.teams, p,
        k: { x: owner.x + Math.cos(owner.f), y: 0, z: owner.z + Math.sin(owner.f), vx: 0, vy: 0, vz: 0, o: 0 },
        gl: [],
      };
    },
  };
  return net;
}
