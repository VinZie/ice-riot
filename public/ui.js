// ICE RIOT - DOM overlay: lobby, in-game HUD, callouts, final screen, Esc menu, toasts.
//
// createUI(root, handlers) -> ui
//   handlers: { pick(team), config(cfg), start(), toLobby(), setName(name), toggleMute(),
//               setVolume(v), blip(kind), audioState() -> {muted, volume}, menuChanged(open) }
//   ui.update(frame) every animation frame, frame = { now, status, rtt, retryIn, lobby, myId,
//               state, events, names, gameSerial }
// DOM writes only happen when a displayed value changes.

import {
  TEAMS, PHASE, PSTATE, EVENT, DEFAULT_CONFIG, MAX_HUMANS_PER_TEAM, SKATERS_PER_TEAM, TEAM_SIZE, GOALIE_K,
} from '/shared/constants.js';
import { evType } from './net.js';
import { teamLogoSVG } from './logos.js';

const crestCache = new Map();
function crest(ti, size, variant = 'full') {
  const key = `${ti}:${size}:${variant}`;
  if (!crestCache.has(key)) {
    let svg = '';
    try { svg = teamLogoSVG(ti, { size, variant }); } catch { svg = ''; }
    crestCache.set(key, svg);
  }
  return crestCache.get(key);
}

const PERIOD_OPTS = [60, 120, 180, 300];
const DIFF_NAMES = ['ROOKIE', 'PRO', 'ALL-STAR'];
const SIDE = ['HOME', 'AWAY'];
const POST_GAME_SECONDS = 12;
const LS_NAME = 'iceriot.name';

// ------------------------------------------------------------------ helpers
const hex = (n) => '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');
function luminance(n) {
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
const inkOn = (n) => (luminance(n) > 0.55 ? '#0a0e18' : '#ffffff');
export function teamVars(ti) {
  const T = TEAMS[ti] || TEAMS[0];
  const { primary, secondary, accent } = T.colors;
  // a readable "glow" color for text on dark backgrounds
  const glow = luminance(primary) < 0.25 ? accent : primary;
  return `--c1:${hex(primary)};--c2:${hex(secondary)};--c3:${hex(accent)};--ink:${inkOn(primary)};--glow:${hex(glow)}`;
}
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const periodLabel = (per, periods = 3) => (per > periods ? 'OT' : per === 1 ? '1ST' : per === 2 ? '2ND' : per === 3 ? '3RD' : `${per}TH`);
export function fmtClock(s) {
  s = Math.max(0, Number(s) || 0);
  if (s > 0 && s < 10) return s.toFixed(1);
  const t = Math.ceil(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
function loadName() { try { return localStorage.getItem(LS_NAME) || ''; } catch { return ''; } }
function saveName(n) { try { localStorage.setItem(LS_NAME, n); } catch { /* ignore */ } }

// Label for a player id: the human's name if a client controls it, else "#num NAME".
export function playerLabel(state, id, names = {}, teamsOverride) {
  if (typeof id !== 'number' || id < 0) return '';
  const p = state && state.p && state.p[id];
  if (p && p.c && names[p.c]) return String(names[p.c]).toUpperCase();
  const team = Math.floor(id / TEAM_SIZE), k = id % TEAM_SIZE;
  const teams = (state && state.teams) || teamsOverride || DEFAULT_CONFIG.teams;
  const T = TEAMS[teams[team]] || TEAMS[team] || TEAMS[0];
  const r = k === GOALIE_K ? T.goalie : T.skaters[k];
  return r ? `#${r.num} ${r.name.toUpperCase()}` : `#${id}`;
}

function setText(el, v) {
  v = String(v);
  if (el._t !== v) { el._t = v; el.textContent = v; }
}
function setHTML(el, v) {
  if (el._h !== v) { el._h = v; el.innerHTML = v; }
}
function setVar(el, name, v) {
  const k = '_v' + name;
  if (el[k] !== v) { el[k] = v; el.style.setProperty(name, v); }
}
function setClass(el, cls, on) {
  on = !!on;
  const k = '_c' + cls;
  if (el[k] !== on) { el[k] = on; el.classList.toggle(cls, on); }
}
function setAttr(el, name, v) {
  const k = '_a' + name;
  if (el[k] !== v) { el[k] = v; if (v === null || v === false) el.removeAttribute(name); else el.setAttribute(name, v === true ? '' : v); }
}

const CONTROLS_HTML = `
  <div class="ctl-grid">
    <div class="ctl-h"></div><div class="ctl-h">KEYBOARD</div><div class="ctl-h">GAMEPAD</div>
    <div class="ctl-a">MOVE</div><div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / <kbd>&larr;&uarr;&darr;&rarr;</kbd></div><div><kbd>L-STICK</kbd> / <kbd>D-PAD</kbd></div>
    <div class="ctl-a">SHOOT<small>tap = wrister · hold = slapshot · no puck = check</small></div><div><kbd>J</kbd> / <kbd>SPACE</kbd></div><div><kbd class="pad a">A</kbd></div>
    <div class="ctl-a">PASS<small>no puck = switch skater</small></div><div><kbd>K</kbd></div><div><kbd class="pad x">X</kbd></div>
    <div class="ctl-a">ACTION<small>deke · stick check</small></div><div><kbd>L</kbd></div><div><kbd class="pad b">B</kbd></div>
    <div class="ctl-a">TURBO<small>turbo + check = BIG HIT</small></div><div><kbd>SHIFT</kbd></div><div><kbd>RB</kbd> <kbd>RT</kbd> <kbd>LT</kbd></div>
    <div class="ctl-a">MENU</div><div><kbd>ESC</kbd></div><div><kbd>START</kbd></div>
  </div>
  <div class="ctl-foot"><kbd>M</kbd> mute &nbsp; <kbd>F</kbd> fullscreen &nbsp;·&nbsp; pass into a teammate's stick and shoot on arrival for a <b>ONE-TIMER</b></div>`;

const TEMPLATE = `
<div class="scrim"></div>
<section class="screen lobby" id="lobby">
  <header class="lb-head">
    <div class="logo" aria-label="ICE RIOT">
      <span class="logo-ice">ICE</span><span class="logo-riot">RIOT</span>
      <span class="logo-crack"></span>
    </div>
    <div class="tagline"><span>3-ON-3</span><span>ARCADE HOCKEY</span><span>NO WHISTLES · ALL GLASS</span></div>
  </header>
  <div class="conn-pill" data-state="connecting"><i class="dot"></i><span class="conn-text">CONNECTING</span><span class="conn-ping"></span></div>

  <div class="lb-row">
    <div class="panel you">
      <label class="lbl" for="ir-name">YOUR NAME</label>
      <div class="name-row"><input id="ir-name" maxlength="16" autocomplete="off" spellcheck="false" placeholder="Enter a name"><span class="name-ok">SAVED</span></div>
      <div class="room-line">ROOM <b class="room-name">main</b></div>
    </div>
    <div class="panel share">
      <label class="lbl" for="ir-share">INVITE YOUR CREW</label>
      <div class="share-row"><input id="ir-share" readonly><button class="btn sm" data-act="copy">COPY</button></div>
      <div class="hint">Friends on your tailnet: open this address</div>
      <div class="hint warn hidden" id="ir-localhint">You're on localhost — share your machine's tailnet name or 100.x address instead (the server prints it at startup).</div>
    </div>
  </div>

  <div class="matchup">
    <div class="team-card" data-team="0"></div>
    <div class="vs"><span>VS</span></div>
    <div class="team-card" data-team="1"></div>
  </div>

  <div class="lb-row bottom">
    <div class="panel settings">
      <div class="lbl">GAME SETTINGS <span class="host-tag"></span></div>
      <div class="set-row"><span class="set-name">PERIOD</span><div class="seg" data-seg="period"></div></div>
      <div class="set-row"><span class="set-name">AI</span><div class="seg" data-seg="diff"></div></div>
      <button class="btn start" data-act="start">START GAME</button>
      <div class="waiting">Waiting for host…</div>
    </div>
    <div class="panel specs">
      <div class="lbl">SPECTATORS</div>
      <ul class="spec-list"></ul>
      <button class="btn ghost" data-act="pick" data-team="-1">SPECTATE</button>
    </div>
    <div class="panel help">
      <div class="lbl">CONTROLS</div>
      ${CONTROLS_HTML}
    </div>
  </div>

  <div class="lb-row extras">
    <div class="panel chat-panel">
      <div id="ir-lobby-chat" class="lobby-chat"></div>
    </div>
    <div class="panel more">
      <div class="lbl">MORE</div>
      <div class="more-btns">
        <button class="btn ghost" data-act="extra" data-x="offline">PRACTICE OFFLINE</button>
        <button class="btn ghost" data-act="extra" data-x="leaderboard">LEADERBOARD</button>
        <button class="btn ghost" data-act="extra" data-x="challenges">CHALLENGES</button>
        <button class="btn ghost" data-act="extra" data-x="settings">SETTINGS</button>
      </div>
      <div class="hint couch-hint">Extra controllers on this PC: press START to join as another player (LB/RB picks a side, hold SELECT to leave).</div>
    </div>
  </div>
  <footer class="lb-foot">ICE RIOT · an original arcade hockey game · <span class="foot-sound" data-act="mute">SOUND ON</span></footer>
</section>

<section class="screen hud hidden" id="hud">
  <div class="scoreboard">
    <div class="sb-team sb-home"><span class="sb-key">HOM</span><span class="sb-score">0</span></div>
    <div class="sb-mid"><span class="sb-per">1ST</span><span class="sb-clk">2:00</span></div>
    <div class="sb-team sb-away"><span class="sb-score">0</span><span class="sb-key">AWY</span></div>
    <div class="sb-strip"></div>
  </div>
  <div class="hud-ping"><i class="dot"></i><span>-- ms</span></div>
  <div class="hud-hint">ESC · MENU</div>

  <div class="me-panel hidden">
    <div class="me-top"><span class="me-tag">YOU</span><span class="me-name">—</span><span class="fire-badge hidden">ON FIRE</span></div>
    <div class="meter turbo"><span class="m-lbl">TURBO</span><div class="m-bar"><i></i></div></div>
    <div class="meter charge hidden"><span class="m-lbl">SLAP</span><div class="m-bar"><i></i></div></div>
  </div>

  <div class="spec-banner hidden">
    <span>SPECTATING</span>
    <button class="btn sm" data-act="pick" data-team="0">JOIN HOME</button>
    <button class="btn sm" data-act="pick" data-team="1">JOIN AWAY</button>
  </div>

  <div class="faceoff hidden"><div class="fo-title">FACEOFF</div><div class="fo-bar"><i></i></div></div>
  <div class="callout"><div class="co-title"></div><div class="co-sub"></div></div>
  <div class="loading hidden">LOADING GAME…</div>

  <div class="final hidden">
    <div class="fin-card">
      <div class="fin-title">FINAL</div>
      <div class="fin-score">
        <div class="fin-team fin-home"><span class="fin-city"></span><span class="fin-name"></span><span class="fin-num">0</span></div>
        <div class="fin-dash">—</div>
        <div class="fin-team fin-away"><span class="fin-num">0</span><span class="fin-city"></span><span class="fin-name"></span></div>
      </div>
      <div class="fin-winner"></div>
      <table class="fin-stats"><tbody></tbody></table>
      <div class="fin-foot"><span class="fin-count"></span><button class="btn sm host-only" data-act="tolobby">BACK TO LOBBY</button></div>
    </div>
  </div>
</section>

<div class="menu hidden" id="ir-menu" role="dialog" aria-label="Menu">
  <div class="menu-card">
    <div class="menu-title">PAUSE<span>the game keeps going!</span></div>
    <button class="btn wide" data-act="resume">RESUME</button>
    <div class="menu-sub">SWITCH SIDE</div>
    <div class="menu-sides">
      <button class="btn side" data-act="pick" data-team="0">HOME</button>
      <button class="btn side" data-act="pick" data-team="1">AWAY</button>
      <button class="btn side" data-act="pick" data-team="-1">SPECTATE</button>
    </div>
    <button class="btn wide ghost" data-act="controls">CONTROLS</button>
    <div class="menu-controls hidden">${CONTROLS_HTML}</div>
    <button class="btn wide ghost" data-act="extra" data-x="settings">SETTINGS</button>
    <button class="btn wide ghost" data-act="extra" data-x="challenges">CHALLENGES</button>
    <div class="menu-sound">
      <button class="btn sm ghost" data-act="mute">MUTE</button>
      <input type="range" min="0" max="100" step="1" class="vol" aria-label="Volume">
    </div>
    <button class="btn wide danger host-only" data-act="tolobby">END GAME (BACK TO LOBBY)</button>
  </div>
</div>

<div class="toasts" aria-live="polite"></div>
<div class="banner hidden" id="ir-banner"><span class="banner-msg"></span><button class="btn sm ghost" data-act="banner-close">OK</button></div>
`;

// ------------------------------------------------------------------ UI
export function createUI(root, h = {}) {
  root.innerHTML = TEMPLATE;
  const $ = (sel, el = root) => el.querySelector(sel);
  const $$ = (sel, el = root) => [...el.querySelectorAll(sel)];

  const els = {
    lobby: $('#lobby'), hud: $('#hud'), menu: $('#ir-menu'), scrim: $('.scrim'),
    pill: $('.conn-pill'), pillText: $('.conn-pill .conn-text'), pillPing: $('.conn-pill .conn-ping'),
    name: $('#ir-name'), nameOk: $('.name-ok'), roomName: $('.room-name'),
    share: $('#ir-share'), localHint: $('#ir-localhint'),
    cards: $$('.team-card'), seqPeriod: $('[data-seg="period"]'), seqDiff: $('[data-seg="diff"]'),
    startBtn: $('.btn.start'), waiting: $('.waiting'), hostTag: $('.host-tag'),
    specList: $('.spec-list'), specBtn: $('.specs .btn'), footSound: $('.foot-sound'),
    sb: $('.scoreboard'), sbHome: $('.sb-home'), sbAway: $('.sb-away'),
    sbHomeKey: $('.sb-home .sb-key'), sbHomeScore: $('.sb-home .sb-score'),
    sbAwayKey: $('.sb-away .sb-key'), sbAwayScore: $('.sb-away .sb-score'),
    sbPer: $('.sb-per'), sbClk: $('.sb-clk'),
    hudPing: $('.hud-ping'), hudPingText: $('.hud-ping span'),
    me: $('.me-panel'), meName: $('.me-name'), fire: $('.fire-badge'),
    turbo: $('.meter.turbo'), turboBar: $('.meter.turbo i'), charge: $('.meter.charge'), chargeBar: $('.meter.charge i'),
    specBanner: $('.spec-banner'), faceoff: $('.faceoff'), foBar: $('.fo-bar i'),
    callout: $('.callout'), coTitle: $('.co-title'), coSub: $('.co-sub'), loading: $('.loading'),
    final: $('.final'), finTitle: $('.fin-title'), finWinner: $('.fin-winner'), finStats: $('.fin-stats tbody'),
    finCount: $('.fin-count'), finHome: $('.fin-home'), finAway: $('.fin-away'),
    toasts: $('.toasts'), banner: $('#ir-banner'), bannerMsg: $('#ir-banner .banner-msg'),
    menuControls: $('.menu-controls'), vol: $('.menu .vol'), menuMute: $('.menu [data-act="mute"]'),
    menuSides: $$('.menu-sides .btn'),
    hostOnly: $$('.host-only'),
  };

  // persistent UI state
  const S = {
    frame: null, screen: '', menuOpen: false, lobbyKey: '', prevClients: null,
    lastStatus: '', statsSerial: -1, stats: freshStats(), finalAt: 0, coUntil: 0, coPrio: -1,
    lastPhase: 0, isHost: false, myTeam: -1, gameTeams: null, lastLobbyState: '',
  };

  // ---------------------------------------------------------------- name + share
  const urlName = new URLSearchParams(location.search).get('name');
  els.name.value = (urlName || loadName() || '').slice(0, 16);
  function commitName() {
    const n = els.name.value.replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!n) return;
    els.name.value = n;
    saveName(n);
    els.nameOk.classList.remove('flash'); void els.nameOk.offsetWidth; els.nameOk.classList.add('flash');
    h.setName && h.setName(n);
  }
  els.name.addEventListener('change', commitName);
  els.name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); els.name.blur(); }
    e.stopPropagation(); // typing must not trigger game / mute / fullscreen keys
  });
  const room = new URLSearchParams(location.search).get('room') || 'main';
  const shareUrl = location.origin + location.pathname + (room !== 'main' ? `?room=${encodeURIComponent(room)}` : '');
  els.share.value = shareUrl;
  els.roomName.textContent = room;
  const isLocal = /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/.test(location.hostname);
  setClass(els.localHint, 'hidden', !isLocal);

  async function copyShare() {
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(shareUrl); ok = true; } } catch { ok = false; }
    if (!ok) {
      els.share.focus(); els.share.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      els.share.blur();
    }
    toast(ok ? 'Invite link copied' : 'Select the address and copy it manually', ok ? 'info' : 'warn');
  }

  // ---------------------------------------------------------------- toasts / banner
  function toast(msg, kind = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    els.toasts.appendChild(t);
    while (els.toasts.children.length > 5) els.toasts.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, kind === 'error' ? 4500 : 3200);
  }
  function banner(msg) {
    els.bannerMsg.textContent = msg;
    els.banner.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- menu
  function setMenu(open) {
    open = !!open && S.screen === 'game';
    if (open === S.menuOpen) return;
    S.menuOpen = open;
    setClass(els.menu, 'hidden', !open);
    if (!open) setClass(els.menuControls, 'hidden', true);
    h.blip && h.blip(open ? 'select' : 'back');
    if (open) {
      syncSound();
      const first = els.menu.querySelector('[data-act="resume"]');
      first && first.focus({ preventScroll: true });
    } else if (document.activeElement && els.menu.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    h.menuChanged && h.menuChanged(open);
  }
  function syncSound() {
    const a = h.audioState ? h.audioState() : { muted: false, volume: 0.8 };
    setText(els.menuMute, a.muted ? 'UNMUTE' : 'MUTE');
    setText(els.footSound, a.muted ? 'SOUND OFF (M)' : 'SOUND ON (M)');
    const v = String(Math.round(a.volume * 100));
    if (els.vol.value !== v && document.activeElement !== els.vol) els.vol.value = v;
  }
  els.vol.addEventListener('input', () => { h.setVolume && h.setVolume(els.vol.value / 100); syncSound(); });

  // gamepad navigation inside the menu
  function padNav(btn) {
    if (btn === 9) { setMenu(!S.menuOpen); return; }
    if (!S.menuOpen) return;
    const items = $$('.menu .btn, .menu .vol').filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    let i = items.indexOf(document.activeElement);
    if (btn === 12 || btn === 14) i = (i - 1 + items.length) % items.length;
    else if (btn === 13 || btn === 15) i = (i + 1) % items.length;
    else if (btn === 0 && i >= 0) { items[i].click(); return; }
    else if (btn === 1) { setMenu(false); return; }
    else return;
    items[i].focus();
    h.blip && h.blip('move');
  }

  // ---------------------------------------------------------------- click actions
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    const L = S.frame && S.frame.lobby;
    const cfg = { ...DEFAULT_CONFIG, ...((L && L.config) || {}) };
    const sendCfg = (over) => {
      const c = { teams: [...cfg.teams], periodLength: cfg.periodLength, difficulty: cfg.difficulty, ...over };
      h.config && h.config(c);
    };
    switch (act) {
      case 'pick': {
        const team = Number(b.dataset.team);
        h.pick && h.pick(team);
        h.blip && h.blip('select');
        if (S.screen === 'game') setMenu(false);
        break;
      }
      case 'team': {
        if (!S.isHost) break;
        const side = Number(b.dataset.team), dir = Number(b.dataset.dir);
        const teams = [...cfg.teams];
        let n = teams[side];
        do { n = (n + dir + TEAMS.length) % TEAMS.length; } while (n === teams[1 - side]);
        teams[side] = n;
        sendCfg({ teams });
        h.blip && h.blip('move');
        break;
      }
      case 'period': if (S.isHost) { sendCfg({ periodLength: Number(b.dataset.v) }); h.blip && h.blip('move'); } break;
      case 'diff': if (S.isHost) { sendCfg({ difficulty: Number(b.dataset.v) }); h.blip && h.blip('move'); } break;
      case 'start': if (S.isHost) { h.start && h.start(); h.blip && h.blip('start'); } break;
      case 'copy': copyShare(); h.blip && h.blip('select'); break;
      case 'resume': setMenu(false); break;
      case 'controls': setClass(els.menuControls, 'hidden', !els.menuControls.classList.contains('hidden')); h.blip && h.blip('move'); break;
      case 'mute': h.toggleMute && h.toggleMute(); syncSound(); break;
      case 'tolobby': if (S.isHost) { h.toLobby && h.toLobby(); setMenu(false); } break;
      case 'banner-close': els.banner.classList.add('hidden'); break;
      case 'extra': h.extra && h.extra(b.dataset.x); h.blip && h.blip('select'); break;
      default: break;
    }
  });
  els.menu.addEventListener('click', (e) => { if (e.target === els.menu) setMenu(false); });

  // ---------------------------------------------------------------- lobby rendering
  function teamCardHTML(side, ti, members, myTeam, isHost, myId, disabled) {
    const T = TEAMS[ti] || TEAMS[side];
    const slots = [];
    for (let i = 0; i < SKATERS_PER_TEAM; i++) {
      const c = members[i];
      if (c) {
        const me = c.id === myId;
        slots.push(`<li class="slot human${me ? ' me' : ''}"><span class="slot-n">${i + 1}</span><b>${escHtml(c.name)}</b>${me ? '<em>YOU</em>' : ''}${c.ping ? `<span class="slot-ping">${Math.round(c.ping)}ms</span>` : ''}</li>`);
      } else {
        slots.push(`<li class="slot ai"><span class="slot-n">${i + 1}</span><b>AI</b><span class="slot-cpu">CPU SKATER</span></li>`);
      }
    }
    const roster = T.skaters.map((s) => `#${s.num} ${escHtml(s.name)}`).join(' · ') + ` · <i>G</i> #${T.goalie.num} ${escHtml(T.goalie.name)}`;
    const full = members.length >= MAX_HUMANS_PER_TEAM;
    const mine = myTeam === side;
    const joinLabel = mine ? `YOU'RE ${SIDE[side]}` : full ? `${SIDE[side]} FULL` : `JOIN ${SIDE[side]}`;
    const arrows = (dir) => isHost
      ? `<button class="cyc" data-act="team" data-team="${side}" data-dir="${dir}" aria-label="${dir < 0 ? 'Previous' : 'Next'} team">${dir < 0 ? '&#9664;' : '&#9654;'}</button>`
      : '';
    return `
      <div class="tc-band"><span class="tc-side">${SIDE[side]}</span><span class="tc-key">${T.key}</span></div>
      <div class="tc-head">${arrows(-1)}
        <div class="tc-crest" aria-hidden="true">${crest(TEAMS.indexOf(T), 84)}</div>
        <div class="tc-name"><div class="tc-city">${escHtml(T.city)}</div><div class="tc-title">${escHtml(T.name)}</div></div>
      ${arrows(1)}</div>
      <div class="tc-swatches"><i style="background:${hex(T.colors.primary)}"></i><i style="background:${hex(T.colors.secondary)}"></i><i style="background:${hex(T.colors.accent)}"></i></div>
      <ol class="tc-slots">${slots.join('')}</ol>
      <div class="tc-roster">${roster}</div>
      <button class="btn join${mine ? ' on' : ''}" data-act="pick" data-team="${side}" ${mine || (full && !mine) || disabled ? 'disabled' : ''}>${joinLabel}</button>`;
  }

  function segHTML(kind, options, value, enabled) {
    return options.map(([v, label]) =>
      `<button class="seg-b${v === value ? ' on' : ''}" data-act="${kind}" data-v="${v}" ${enabled ? '' : 'disabled'}>${label}</button>`).join('');
  }

  function renderLobby(f) {
    const L = f.lobby;
    if (L === S.lobbyRef && f.status === S.lobbyStatus && f.myId === S.lobbyMyId) return; // nothing changed
    S.lobbyRef = L; S.lobbyStatus = f.status; S.lobbyMyId = f.myId;
    const online = f.status === 'online' && !!L;
    const cfg = { ...DEFAULT_CONFIG, ...((L && L.config) || {}) };
    const clients = (L && L.clients) || [];
    const isHost = !!(L && f.myId && L.host === f.myId);
    const me = clients.find((c) => c.id === f.myId);
    const myTeam = me ? me.team : -1;
    const key = JSON.stringify([online, cfg.teams, cfg.periodLength, cfg.difficulty, clients.map((c) => [c.id, c.name, c.team, Math.round((c.ping || 0) / 10)]), L && L.host, f.myId, L && L.state]);
    if (key === S.lobbyKey) return;
    S.lobbyKey = key;

    for (const card of els.cards) {
      const side = Number(card.dataset.team);
      const ti = cfg.teams[side];
      const members = clients.filter((c) => c.team === side);
      card.setAttribute('style', teamVars(ti));
      setClass(card, 'mine', myTeam === side);
      card.innerHTML = teamCardHTML(side, ti, members, myTeam, isHost, f.myId, !online);
    }
    els.seqPeriod.innerHTML = segHTML('period', PERIOD_OPTS.map((v) => [v, `${v / 60}<small>MIN</small>`]), cfg.periodLength, isHost && online);
    els.seqDiff.innerHTML = segHTML('diff', DIFF_NAMES.map((n, i) => [i, n]), cfg.difficulty, isHost && online);
    setClass(els.startBtn, 'hidden', !isHost);
    els.startBtn.disabled = !online;
    setClass(els.waiting, 'hidden', isHost || !online);
    const host = clients.find((c) => L && c.id === L.host);
    setText(els.hostTag, isHost ? '· YOU ARE HOST' : host ? `· HOST: ${host.name}` : '');
    const specs = clients.filter((c) => c.team !== 0 && c.team !== 1);
    els.specList.innerHTML = specs.length
      ? specs.map((c) => `<li${c.id === f.myId ? ' class="me"' : ''}>${escHtml(c.name)}${c.id === f.myId ? ' <em>YOU</em>' : ''}${L && c.id === L.host ? ' <span class="crown">HOST</span>' : ''}</li>`).join('')
      : '<li class="empty">Nobody in the stands</li>';
    els.specBtn.disabled = !online || myTeam === -1;
    setText(els.specBtn, myTeam === -1 && me ? 'IN THE STANDS' : 'SPECTATE');
  }

  function updateConn(f) {
    const st = f.status === 'online' && f.lobby ? 'online' : f.status;
    setAttr(els.pill, 'data-state', st);
    let text = 'CONNECTING';
    if (st === 'online') text = 'CONNECTED';
    else if (st === 'reconnecting') text = `RECONNECTING${f.retryIn ? ` IN ${f.retryIn}s` : '…'}`;
    else if (f.status === 'online') text = 'JOINING…';
    else text = `CONNECTING${f.retryIn ? ` · RETRY ${f.retryIn}s` : '…'}`;
    setText(els.pillText, text);
    const ping = st === 'online' && f.rtt ? `${Math.round(f.rtt)} ms` : '';
    setText(els.pillPing, ping);
    const q = !f.rtt ? '' : f.rtt < 60 ? 'good' : f.rtt < 130 ? 'ok' : 'bad';
    setAttr(els.pill, 'data-q', q);
    setAttr(els.hudPing, 'data-q', st === 'online' ? q : 'bad');
    setText(els.hudPingText, st === 'online' ? (f.rtt ? `${Math.round(f.rtt)} ms` : '-- ms') : 'OFFLINE');
    if (S.lastStatus && S.lastStatus !== f.status) {
      if (f.status === 'reconnecting') toast('Connection lost — reconnecting…', 'warn');
      else if (f.status === 'online' && S.lastStatus === 'reconnecting') toast('Reconnected', 'info');
    }
    S.lastStatus = f.status;
  }

  // ---------------------------------------------------------------- join/leave toasts
  function diffClients(f) {
    const L = f.lobby;
    if (!L) { S.prevClients = null; return; }
    const cur = new Map((L.clients || []).map((c) => [c.id, c]));
    if (S.prevClients) {
      for (const [id, c] of cur) {
        if (id === f.myId) continue;
        const p = S.prevClients.get(id);
        if (!p) toast(`${c.name} joined${c.team === 0 || c.team === 1 ? ` ${SIDE[c.team]}` : ''}`, 'join');
        else if (p.team !== c.team) toast(`${c.name} → ${c.team === 0 || c.team === 1 ? SIDE[c.team] : 'SPECTATORS'}`, 'join');
      }
      for (const [id, p] of S.prevClients) if (!cur.has(id) && id !== f.myId) toast(`${p.name} left`, 'leave');
      const prevHost = S.prevHost;
      if (prevHost && prevHost !== L.host && L.host === f.myId) toast('You are now the host', 'info');
    }
    S.prevClients = cur;
    S.prevHost = L.host;
  }

  // ---------------------------------------------------------------- stats
  function freshStats() {
    const t = () => ({ shots: 0, hits: 0, big: 0, glass: 0, saves: 0 });
    return [t(), t()];
  }
  const teamOf = (id) => (typeof id === 'number' && id >= 0 ? Math.floor(id / TEAM_SIZE) : -1);

  // ---------------------------------------------------------------- callouts
  function callout(now, title, sub = '', opts = {}) {
    const { kind = '', dur = 1.6, prio = 1, vars = '' } = opts;
    if (S.gameOver) return; // the final card owns the screen
    if (now < S.coUntil && prio < S.coPrio) return;
    S.coPrio = prio;
    S.coUntil = now + dur * 1000;
    const el = els.callout;
    el.className = 'callout';
    el.setAttribute('style', `${vars};--dur:${dur}s`);
    els.coTitle.textContent = title;
    els.coSub.textContent = sub;
    void el.offsetWidth; // restart the animation
    el.className = `callout show ${kind}`;
  }

  function handleEvents(f) {
    const { events, state, now } = f;
    const over = !!state && state.ph === PHASE.GAME_OVER;
    if (over && !S.gameOver) { S.coUntil = 0; els.callout.className = 'callout'; }
    S.gameOver = over;
    if (!events || !events.length) return;
    const names = f.names || {};
    const teams = (state && state.teams) || S.gameTeams || DEFAULT_CONFIG.teams;
    const label = (id) => playerLabel(state, id, names, teams);
    const T = (side) => TEAMS[teams[side]] || TEAMS[side];
    const periods = ((f.lobby && f.lobby.config && f.lobby.config.periods) || DEFAULT_CONFIG.periods);
    S.finalDirty = true;
    for (const e of events) {
      const type = evType(e);
      switch (type) {
        case EVENT.SHOT: {
          const tm = teamOf(e.by);
          if (tm >= 0) S.stats[tm].shots++;
          if (e.kind === 'onetimer') callout(now, 'ONE-TIMER!', label(e.by), { kind: 'onetimer', dur: 1.1, prio: 2 });
          break;
        }
        case EVENT.HIT: {
          const tm = teamOf(e.by);
          if (tm >= 0) { S.stats[tm].hits++; if (e.big) S.stats[tm].big++; }
          if (e.big) callout(now, 'BIG HIT!', `${label(e.by)}  ▸  ${label(e.target)}`, { kind: 'hit', dur: 1.5, prio: 2, vars: tm >= 0 ? teamVars(teams[tm]) : '' });
          break;
        }
        case EVENT.GLASS: {
          const tm = teamOf(e.by);
          if (tm >= 0) S.stats[tm].glass++;
          callout(now, 'GLASS SHATTERED!', e.by >= 0 ? label(e.by) : '', { kind: 'glass', dur: 1.9, prio: 3 });
          break;
        }
        case EVENT.SAVE: {
          const tm = teamOf(e.goalie);
          if (tm >= 0) S.stats[tm].saves++;
          callout(now, 'SAVE!', label(e.goalie), { kind: 'save', dur: 0.95, prio: 1 });
          break;
        }
        case EVENT.POST: callout(now, 'POST!', 'DING!', { kind: 'save', dur: 0.9, prio: 1 }); break;
        case EVENT.GOAL: {
          const tm = e.team === 0 || e.team === 1 ? e.team : teamOf(e.scorer);
          const parts = [label(e.scorer)];
          if (typeof e.assist === 'number' && e.assist >= 0) parts.push(`ASSIST ${label(e.assist)}`);
          const title = e.oneTimer ? 'ONE-TIMER GOAL!' : 'GOAL!';
          callout(now, title, parts.join('  ·  '), { kind: 'goal', dur: 3.2, prio: 5, vars: tm >= 0 ? teamVars(teams[tm]) : '' });
          break;
        }
        case EVENT.FIRE:
          if (e.on) callout(now, `${label(e.player)} IS ON FIRE!`, '', { kind: 'fire', dur: 2.0, prio: 3 });
          break;
        case EVENT.FACEOFF: callout(now, 'GO!', '', { kind: 'go', dur: 0.7, prio: 1 }); break;
        case EVENT.PERIOD: {
          const n = e.period ?? (state && state.per) ?? 1;
          if (n > periods) callout(now, 'OVERTIME', 'NEXT GOAL WINS', { kind: 'ot', dur: 2.6, prio: 4 });
          else callout(now, `PERIOD ${n}`, n === 1 ? `${T(0).name.toUpperCase()} VS ${T(1).name.toUpperCase()}` : '', { kind: 'period', dur: 2.0, prio: 4 });
          break;
        }
        case EVENT.PERIOD_END: {
          const n = e.period ?? (state && state.per) ?? 1;
          const sc = (state && state.sc) || [0, 0];
          callout(now, n > periods ? 'END OF OT' : `END OF ${periodLabel(n, periods)}`, `${T(0).key} ${sc[0]}  —  ${sc[1]} ${T(1).key}`, { kind: 'period', dur: 3.2, prio: 4 });
          break;
        }
        case EVENT.SWITCH:
          if (e.client && e.client === f.myId) {
            els.me.classList.remove('pulse');
            void els.me.offsetWidth;
            els.me.classList.add('pulse');
          }
          break;
        default: break;
      }
    }
  }

  // ---------------------------------------------------------------- HUD
  function updateHud(f) {
    const st = f.state;
    setClass(els.loading, 'hidden', !!st);
    if (!st) {
      setClass(els.me, 'hidden', true);
      setClass(els.faceoff, 'hidden', true);
      setClass(els.final, 'hidden', true);
      return;
    }
    const teams = st.teams || DEFAULT_CONFIG.teams;
    S.gameTeams = teams;
    const tKey = teams.join(',');
    if (els.sb._teams !== tKey) {
      els.sb._teams = tKey;
      els.sbHome.setAttribute('style', teamVars(teams[0]));
      els.sbAway.setAttribute('style', teamVars(teams[1]));
      els.sb.setAttribute('style', `--h1:${hex(TEAMS[teams[0]].colors.primary)};--a1:${hex(TEAMS[teams[1]].colors.primary)}`);
      setText(els.sbHomeKey, TEAMS[teams[0]].key);
      setText(els.sbAwayKey, TEAMS[teams[1]].key);
    }
    const sc = st.sc || [0, 0];
    if (els.sbHomeScore._t !== String(sc[0]) && els.sbHomeScore._t !== undefined) bump(els.sbHomeScore);
    if (els.sbAwayScore._t !== String(sc[1]) && els.sbAwayScore._t !== undefined) bump(els.sbAwayScore);
    setText(els.sbHomeScore, sc[0]);
    setText(els.sbAwayScore, sc[1]);
    const periods = (f.lobby && f.lobby.config && f.lobby.config.periods) || DEFAULT_CONFIG.periods;
    setText(els.sbPer, st.ph === PHASE.PERIOD_END ? 'INT' : st.ph === PHASE.GAME_OVER ? 'FINAL' : periodLabel(st.per || 1, periods));
    setText(els.sbClk, fmtClock(st.clk));
    setClass(els.sbClk, 'low', st.ph === PHASE.PLAY && st.clk < 10);
    setClass(els.sb, 'ot', (st.per || 1) > periods);

    // local player
    const mine = f.myId ? (st.p || []).find((p) => p && p.c === f.myId) : null;
    setClass(els.me, 'hidden', !mine);
    setClass(els.specBanner, 'hidden', !!mine || S.myTeam === 0 || S.myTeam === 1 || st.ph === PHASE.GAME_OVER);
    if (mine) {
      const tm = mine.tm ?? teamOf(mine.id);
      setVar(els.me, '--tc', hex(TEAMS[teams[tm]].colors.primary));
      setText(els.meName, playerLabel(null, mine.id, {}, teams)); // roster identity of my skater
      const tb = Math.max(0, Math.min(1, mine.tb ?? 0));
      const tbS = `scaleX(${tb.toFixed(3)})`;
      if (els.turboBar._tr !== tbS) { els.turboBar._tr = tbS; els.turboBar.style.transform = tbS; }
      setClass(els.turbo, 'low', tb < 0.2);
      const charging = mine.s === PSTATE.CHARGE;
      setClass(els.charge, 'hidden', !charging);
      if (charging) {
        const ch = Math.max(0, Math.min(1, mine.ch ?? 0));
        const chS = `scaleX(${ch.toFixed(3)})`;
        if (els.chargeBar._tr !== chS) { els.chargeBar._tr = chS; els.chargeBar.style.transform = chS; }
        setClass(els.charge, 'full', ch > 0.97);
      }
      setClass(els.fire, 'hidden', !mine.fire);
      setClass(els.me, 'on-fire', !!mine.fire);
    }

    // faceoff banner (phase driven, yields to bigger callouts)
    const fo = st.ph === PHASE.FACEOFF && !(f.now < S.coUntil && S.coPrio >= 3);
    setClass(els.faceoff, 'hidden', !fo);
    if (fo) {
      const k = Math.max(0, Math.min(1, (st.phT || 0) / 1.6));
      const s = `scaleX(${k.toFixed(3)})`;
      if (els.foBar._tr !== s) { els.foBar._tr = s; els.foBar.style.transform = s; }
    }

    // final screen
    const over = st.ph === PHASE.GAME_OVER;
    if (over && !S.finalAt) { S.finalAt = f.now; S.finalDirty = true; }
    if (over && S.finalDirty) { S.finalDirty = false; renderFinal(st, periods); }
    if (!over) S.finalAt = 0;
    setClass(els.final, 'hidden', !over);
    if (over) {
      const left = Math.max(0, Math.ceil(POST_GAME_SECONDS - (f.now - S.finalAt) / 1000));
      setText(els.finCount, `BACK TO LOBBY IN ${left}s`);
    }
    S.lastPhase = st.ph;
  }

  function bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }

  function renderFinal(st, periods = DEFAULT_CONFIG.periods) {
    const teams = st.teams || DEFAULT_CONFIG.teams;
    const sc = st.sc || [0, 0];
    const fill = (el, side) => {
      const T = TEAMS[teams[side]];
      el.setAttribute('style', teamVars(teams[side]));
      el.querySelector('.fin-city').textContent = T.city.toUpperCase();
      el.querySelector('.fin-name').textContent = T.name.toUpperCase();
      el.querySelector('.fin-num').textContent = sc[side];
    };
    fill(els.finHome, 0); fill(els.finAway, 1);
    const w = sc[0] === sc[1] ? -1 : sc[0] > sc[1] ? 0 : 1;
    const ot = (st.per || 1) > periods ? ' IN OVERTIME' : '';
    els.finWinner.textContent = w < 0 ? 'ALL TIED UP' : `${TEAMS[teams[w]].city.toUpperCase()} ${TEAMS[teams[w]].name.toUpperCase()} WIN${ot}!`;
    els.finWinner.setAttribute('style', w >= 0 ? teamVars(teams[w]) : '');
    const myWin = S.myTeam === w;
    els.finTitle.textContent = S.myTeam === 0 || S.myTeam === 1 ? (myWin ? 'VICTORY' : 'FINAL') : 'FINAL';
    const s = S.stats;
    const rows = [['GOALS', sc[0], sc[1]], ['SHOTS', s[0].shots, s[1].shots], ['HITS', s[0].hits, s[1].hits],
      ['BIG HITS', s[0].big, s[1].big], ['GLASS BROKEN', s[0].glass, s[1].glass], ['SAVES', s[0].saves, s[1].saves]];
    els.finStats.innerHTML = `<tr class="hdr"><td style="${teamVars(teams[0])}">${TEAMS[teams[0]].key}</td><td></td><td style="${teamVars(teams[1])}">${TEAMS[teams[1]].key}</td></tr>` +
      rows.map(([n, a, b]) => `<tr><td class="${a > b ? 'lead' : ''}">${a}</td><th>${n}</th><td class="${b > a ? 'lead' : ''}">${b}</td></tr>`).join('');
  }

  // ---------------------------------------------------------------- main update
  function update(f) {
    S.frame = f;
    const L = f.lobby;
    const clients = (L && L.clients) || [];
    const me = clients.find((c) => c.id === f.myId);
    S.myTeam = me ? me.team : -1;
    S.isHost = !!(L && f.myId && L.host === f.myId);

    if (f.gameSerial !== S.statsSerial) { S.statsSerial = f.gameSerial; S.stats = freshStats(); S.finalAt = 0; }
    if (L !== S.lastLobbyRef) { S.lastLobbyRef = L; diffClients(f); }

    const screen = L && L.state === 'game' ? 'game' : 'lobby';
    if (screen !== S.screen) {
      S.screen = screen;
      setClass(els.lobby, 'hidden', screen !== 'lobby');
      setClass(els.scrim, 'hidden', screen !== 'lobby');
      setClass(els.hud, 'hidden', screen !== 'game');
      setClass(root, 'in-game', screen === 'game');
      if (screen !== 'game') { setMenu(false); S.coUntil = 0; els.callout.className = 'callout'; }
      if (screen === 'game' && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    }
    for (const el of els.hostOnly) setClass(el, 'hidden', !S.isHost);
    for (const b of els.menuSides) setClass(b, 'on', Number(b.dataset.team) === S.myTeam);

    updateConn(f);
    if (screen === 'lobby') renderLobby(f);
    else { handleEvents(f); updateHud(f); }
  }

  syncSound();
  return {
    update,
    toast,
    banner,
    padNav,
    syncSound,
    toggleMenu() { setMenu(!S.menuOpen); },
    closeMenu() { setMenu(false); },
    get menuOpen() { return S.menuOpen; },
    get screen() { return S.screen; },
    get name() { return els.name.value.trim(); },
    setName(n) { if (document.activeElement !== els.name) els.name.value = n; },
  };
}
