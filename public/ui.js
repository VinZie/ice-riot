// ICE RIOT - DOM overlay: lobby shell (rail, top bar, matchup, match bar, view mounts), in-game HUD,
// callouts, pause menu, final screen, toasts and the 2D-fallback banner.
//
// createUI(root, handlers) -> ui
//   handlers: { pick(team), config(cfg), start(), toLobby(), setName(name), toggleMute(),
//               setVolume(v), blip(kind), audioState() -> {muted, volume}, menuChanged(open),
//               extra(name), view(name, el), playerStats(name) -> Promise<career row | null> }
//   ui.update(frame) every animation frame, frame = { now, status, rtt, retryIn, lobby, myId,
//               state, events, names, gameSerial }
// DOM writes only happen when a displayed value changes.
//
// Layout and copy follow the Coqui canvas ("Final · lobby", "Final · in game" and "Final · mobile"
// pages). Phones in portrait (style.css breakpoint) get one column with a bottom tab bar: Match,
// Chat (the rail's #ir-lobby-chat), Leaders and Challenges (the view mounts); a phone held
// portrait in game gets the "Turn your phone sideways" prompt (main.js pauses its input).

import {
  TEAMS, PHASE, EVENT, DEFAULT_CONFIG, MAX_HUMANS_PER_TEAM, SKATERS_PER_TEAM, TEAM_SIZE, GOALIE_K,
} from '../shared/constants.js';
import { evType } from './net.js';
import { teamLogoSVG, gameLogoSVG } from './logos.js';
import { ICON, signalSVG, pingQuality } from './ui-icons.js';

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
const DIFF_NAMES = ['Rookie', 'Pro', 'All-star'];
const SIDE = ['home', 'away'];
const SIDE_CAP = ['Home', 'Away'];
const POST_GAME_SECONDS = 12;
const LS_NAME = 'iceriot.name';
const STATS_TTL_MS = 30000;

// ------------------------------------------------------------------ helpers
const hex = (n) => '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');
function luminance(n) {
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
// Text drawn ON a team colour: every team primary is light enough for dark ink (the canvas uses
// --on-ice on the orange goal band); only a genuinely dark primary gets light ink.
const inkOn = (n) => (luminance(n) > 0.4 ? '#0a0f1c' : '#e8edf5');
const teamOf = (id) => (typeof id === 'number' && id >= 0 ? Math.floor(id / TEAM_SIZE) : -1);
const teamT = (ti) => TEAMS[ti] || TEAMS[0];
/** A team colour that reads on the dark surfaces (accent if the primary is too dark). */
function teamText(ti) {
  const { primary, accent } = teamT(ti).colors;
  return hex(luminance(primary) < 0.25 ? accent : primary);
}
const tcVar = (ti) => `--tc:${hex(teamT(ti).colors.primary)};--tt:${teamText(ti)};--to:${inkOn(teamT(ti).colors.primary)}`;

export function teamVars(ti) {
  const T = TEAMS[ti] || TEAMS[0];
  const { primary, secondary, accent } = T.colors;
  const glow = luminance(primary) < 0.25 ? accent : primary;
  return `--c1:${hex(primary)};--c2:${hex(secondary)};--c3:${hex(accent)};--ink:${inkOn(primary)};--glow:${hex(glow)};--tc:${hex(primary)};--tt:${hex(glow)};--to:${inkOn(primary)}`;
}
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const periodLabel = (per, periods = 3) => (per > periods ? 'OT' : per === 1 ? '1st' : per === 2 ? '2nd' : per === 3 ? '3rd' : `${per}th`);
export function fmtClock(s) {
  s = Math.max(0, Number(s) || 0);
  if (s > 0 && s < 10) return s.toFixed(1);
  const t = Math.ceil(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
function loadName() { try { return localStorage.getItem(LS_NAME) || ''; } catch { return ''; } }
function saveName(n) { try { localStorage.setItem(LS_NAME, n); } catch { /* ignore */ } }
const initial = (name) => ([...String(name || '').trim()][0] || '?').toUpperCase();
/** "OVERTIME OUTLAW" -> "Overtime outlaw" (challenge titles may still be stored in caps). */
const sentence = (s) => { s = String(s || ''); return s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s; };

function rosterOf(teams, id) {
  const team = Math.floor(id / TEAM_SIZE), k = id % TEAM_SIZE;
  const T = TEAMS[teams[team]] || TEAMS[team] || TEAMS[0];
  return k === GOALIE_K ? T.goalie : T.skaters[k];
}

// Label for a player id: the human's name if a client controls it, else "#num Name".
export function playerLabel(state, id, names = {}, teamsOverride) {
  if (typeof id !== 'number' || id < 0) return '';
  const p = state && state.p && state.p[id];
  if (p && p.c && names[p.c]) return String(names[p.c]);
  const teams = (state && state.teams) || teamsOverride || DEFAULT_CONFIG.teams;
  const r = rosterOf(teams, id);
  return r ? `#${r.num} ${r.name}` : `#${id}`;
}
/** Short name for callouts and stars: the human's name, else the roster surname. */
function shortName(state, id, names = {}, teamsOverride) {
  if (typeof id !== 'number' || id < 0) return '';
  const p = state && state.p && state.p[id];
  if (p && p.c && names[p.c]) return String(names[p.c]);
  const r = rosterOf((state && state.teams) || teamsOverride || DEFAULT_CONFIG.teams, id);
  return r ? r.name : `#${id}`;
}

/** Head-to-head rows from roster ratings: skater averages (spd, sht, pas, chk) + goalie skill. */
export function teamRatings(ti) {
  const T = teamT(ti);
  const avg = (k) => T.skaters.reduce((s, p) => s + (p[k] || 0), 0) / Math.max(1, T.skaters.length);
  return [
    { label: 'Speed', v: avg('spd'), text: avg('spd').toFixed(1) },
    { label: 'Shooting', v: avg('sht'), text: avg('sht').toFixed(1) },
    { label: 'Passing', v: avg('pas'), text: avg('pas').toFixed(1) },
    { label: 'Hitting', v: avg('chk'), text: avg('chk').toFixed(1) },
    { label: 'Goalie', v: T.goalie.skill, text: String(T.goalie.skill) },
  ];
}

/** One-line head-to-head for the phone "Ratings" row: "Wolves ahead in 3 of 5" (ties count for nobody). */
export function ratingsSummary(teams) {
  const A = teamRatings(teams[0]), B = teamRatings(teams[1]);
  let a = 0, b = 0;
  A.forEach((r, i) => { if (r.v > B[i].v) a++; else if (B[i].v > r.v) b++; });
  if (a === b) return 'Evenly matched';
  return `${teamT(teams[a > b ? 0 : 1]).name} ahead in ${Math.max(a, b)} of ${A.length}`;
}

/**
 * Stars of the game from this game's per-player-id tallies { id: { g, a, h } } (GOAL scorer and
 * assist, HIT by). Ranked by goals; ties go to assists, then hits (then the lower id, for a stable
 * order). Returns the top `n` players who did anything.
 */
export function starsOfGame(tally, n = 3) {
  const rows = Object.entries(tally || {}).map(([id, t]) => ({ id: Number(id), g: t.g | 0, a: t.a | 0, h: t.h | 0 }));
  return rows.filter((r) => r.g + r.a + r.h > 0)
    .sort((x, y) => y.g - x.g || y.a - x.a || y.h - x.h || x.id - y.id)
    .slice(0, n);
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

const TOAST_ICON = {
  join: () => ICON.personPlus(), leave: () => ICON.personMinus(), warn: () => ICON.wifiOff(),
  error: () => ICON.error(), good: () => ICON.check(), info: () => ICON.info(),
};

const TEMPLATE = `
<div class="scrim"></div>
<section class="screen lobby" id="lobby" data-view="match" data-mtab="match">
  <aside class="rail" aria-label="You, invite and chat">
    <div class="rail-mark" role="img" aria-label="ICE RIOT">${gameLogoSVG({ width: 136 })}</div>
    <div class="you">
      <span class="avatar av-lg you-av">?</span>
      <div class="you-txt">
        <div class="you-name">
          <input id="ir-name" maxlength="16" autocomplete="off" spellcheck="false" aria-label="Your name" placeholder="Your name">
          <button type="button" class="name-edit" data-act="edit-name" aria-label="Edit your name" title="Edit your name">${ICON.pencil()}</button>
          <span class="name-ok" aria-live="polite"></span>
        </div>
        <div class="role-line"></div>
      </div>
    </div>
    <div class="invite">
      <label class="lbl" for="ir-share">Invite link</label>
      <div class="invite-field">
        <input id="ir-share" class="mono" readonly aria-haspopup="dialog" aria-expanded="false" aria-controls="ir-invite-pop" title="Show the invite link">
        <button type="button" class="icon-btn sq" data-act="copy" aria-label="Copy invite link" title="Copy invite link">${ICON.copy()}</button>
      </div>
      <div class="pop invite-pop hidden" id="ir-invite-pop" role="dialog" aria-label="Invite friends">
        <div class="pop-title">Invite friends</div>
        <div class="invite-url mono"></div>
        <div class="note-warn local-warn hidden">${ICON.warn()}<div><b>Localhost only works on this PC</b><span>Send the Tailscale address the server printed at start, like 100.101.102.103:8765.</span></div></div>
        <button type="button" class="btn primary" data-act="copy" data-close="1">${ICON.copy(14, 1.26)}<span>Copy link</span></button>
      </div>
    </div>
    <div class="rule" aria-hidden="true"></div>
    <div id="ir-lobby-chat" class="lobby-chat"></div>
  </aside>

  <header class="topbar">
    <div class="m-head">
      <div class="m-mark" role="img" aria-label="ICE RIOT">${gameLogoSVG({ width: 85 }).replace(/irw-dark-/g, 'irw-mob-')}</div>
      <div class="m-title"><div class="m-title-t">Chat</div><div class="m-title-s"></div></div>
    </div>
    <button type="button" class="m-done" data-act="kb-done">Done</button>
    <nav class="views" aria-label="Lobby views">
      <button type="button" class="view-tab on" data-act="view" data-view="match" aria-pressed="true"><span>Match</span></button>
      <button type="button" class="view-tab" data-act="view" data-view="leaderboard" aria-pressed="false">${ICON.leaderboard()}<span>Leaderboard</span></button>
      <button type="button" class="view-tab" data-act="view" data-view="challenges" aria-pressed="false">${ICON.badge()}<span>Challenges</span><span class="count ch-count hidden"></span></button>
    </nav>
    <div class="tools">
      <button type="button" class="tool-btn offline-btn" data-act="extra" data-x="offline"><span class="tool-ico">${ICON.puck()}</span><span class="tool-txt">Practice offline</span></button>
      <button type="button" class="icon-btn" data-act="extra" data-x="settings" aria-label="Settings" title="Settings">${ICON.sliders()}</button>
      <span class="vsep" aria-hidden="true"></span>
      <div class="conn" data-state="connecting" role="status"><i class="dot"></i><span class="conn-text">Connecting</span><span class="conn-ping"></span></div>
    </div>
  </header>

  <main class="lb-main">
    <div class="ir-view view-match" id="ir-view-match">
      <div class="matchup">
        <div class="side" data-side="0"></div>
        <div class="h2h"><div class="vs" aria-hidden="true">vs</div>
          <div class="ratings">
            <button type="button" class="ratings-btn" data-act="ratings" aria-expanded="false" aria-controls="ir-h2h-rows">${ICON.leaderboard()}<span class="rt-t">Ratings</span><span class="rt-s"></span>${ICON.chevD()}</button>
            <div class="h2h-rows" id="ir-h2h-rows" aria-label="Head to head ratings"></div>
          </div>
        </div>
        <div class="side" data-side="1"></div>
        <div class="pop picker hidden" role="dialog"></div>
        <div class="pop pcard hidden" aria-live="polite"></div>
      </div>
      <div class="match-bar"></div>
    </div>
    <div id="ir-view-leaderboard" class="ir-view off" aria-hidden="true"></div>
    <div id="ir-view-challenges" class="ir-view off" aria-hidden="true"></div>
  </main>

  <div class="m-start"></div>
  <nav class="ir-mobile-tabs" aria-label="Lobby sections">
    <button type="button" data-mtab="match" class="on" aria-current="page"><span class="mt-pill">${ICON.tabMatch()}</span><span class="mt-lbl">Match</span></button>
    <button type="button" data-mtab="chat"><span class="mt-pill">${ICON.tabChat()}<span class="mt-unread hidden"></span></span><span class="mt-lbl">Chat</span></button>
    <button type="button" data-mtab="leaders"><span class="mt-pill">${ICON.tabLeaders()}</span><span class="mt-lbl">Leaders</span></button>
    <button type="button" data-mtab="challenges"><span class="mt-pill">${ICON.tabChallenges()}</span><span class="mt-lbl">Challenges</span></button>
  </nav>
</section>

<section class="screen hud hidden" id="hud">
  <div class="hud-hint"><kbd>Esc</kbd><span>Menu</span></div>
  <button type="button" class="hud-menu" data-act="menu" aria-label="Menu" title="Menu"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="3.5" y="2.8" width="2.45" height="8.4" rx="0.7" fill="currentColor"/><rect x="8.05" y="2.8" width="2.45" height="8.4" rx="0.7" fill="currentColor"/></svg></button>
  <div class="scoreboard" role="group" aria-label="Score">
    <div class="sb-team sb-home"><span class="sb-mark"></span><span class="sb-key"></span><span class="sb-score">0</span></div>
    <div class="sb-mid"><span class="sb-per">1st</span><span class="sb-clk">2:00</span></div>
    <div class="sb-team sb-away"><span class="sb-score">0</span><span class="sb-key"></span><span class="sb-mark"></span></div>
  </div>
  <div class="hud-ping"><span class="sig-wrap">${signalSVG('')}</span><span class="hud-ping-txt">-- ms</span></div>
  <div class="callout" aria-live="polite"></div>
  <div class="faceoff plate hidden"><div class="fo-title">Faceoff</div><div class="fo-bar"><i></i></div></div>
  <div class="spec-bar hidden">
    <span class="spec-ico">${ICON.stands(18)}</span>
    <span class="spec-txt">Watching from the stands</span>
    <button type="button" class="btn tbtn spec-join" data-act="pick" data-team="0"><span class="mk"></span><span>Join home</span></button>
    <button type="button" class="btn tbtn spec-join" data-act="pick" data-team="1"><span class="mk"></span><span>Join away</span></button>
  </div>
  <div class="loading hidden">Loading game…</div>
  <div class="rotate" role="status">
    <div class="rot-prompt">${ICON.rotatePhone()}<div class="rot-txt">Turn your phone sideways to play</div></div>
    <button type="button" class="btn rot-menu" data-act="menu">Menu</button>
  </div>

  <div class="final hidden">
    <div class="fin-wrap">
      <div class="fin-result"><span class="chip fin-chip">Final</span><div class="fin-title">Final</div></div>
      <div class="fin-score">
        <div class="fin-side fin-home"><div class="fin-names"><span class="fin-city"></span><span class="fin-name"></span></div><span class="fin-crest"></span></div>
        <div class="fin-nums"><span class="fin-n fin-n0">0</span><span class="fin-dash">–</span><span class="fin-n fin-n1">0</span></div>
        <div class="fin-side fin-away"><span class="fin-crest"></span><div class="fin-names"><span class="fin-city"></span><span class="fin-name"></span></div></div>
      </div>
      <div class="fin-cards">
        <div class="card fin-stats"></div>
        <div class="card fin-stars"></div>
      </div>
      <div class="fin-foot">
        <div class="fin-count"><span class="fin-count-txt"></span><div class="fin-bar"><i></i></div></div>
        <button type="button" class="btn primary host-only fin-now" data-act="tolobby">Back to lobby now</button>
      </div>
    </div>
  </div>
</section>

<div class="menu hidden" id="ir-menu" role="dialog" aria-label="Menu" aria-modal="true">
  <div class="menu-panel">
    <div class="menu-head">
      <div class="menu-title">Menu</div>
      <div class="menu-live"><i class="dot live"></i><span>Live · the game keeps running</span></div>
    </div>
    <button type="button" class="btn primary menu-resume" data-act="resume">Resume</button>
    <div class="menu-side">
      <div class="lbl" id="ir-side-lbl">Your side</div>
      <div class="seg side-seg" role="radiogroup" aria-labelledby="ir-side-lbl">
        <button type="button" class="seg-b" role="radio" data-act="pick" data-team="0"><span class="mk"></span><span>Home</span></button>
        <button type="button" class="seg-b" role="radio" data-act="pick" data-team="1"><span class="mk"></span><span>Away</span></button>
        <button type="button" class="seg-b" role="radio" data-act="pick" data-team="-1">${ICON.stands()}<span>Stands</span></button>
      </div>
    </div>
    <div class="menu-rows">
      <button type="button" class="menu-row" data-act="extra" data-x="controls">${ICON.gamepad()}<span class="mr-txt">Controls</span>${ICON.chevR()}</button>
      <button type="button" class="menu-row" data-act="extra" data-x="settings">${ICON.sliders(18)}<span class="mr-txt">Settings</span>${ICON.chevR()}</button>
      <button type="button" class="menu-row" data-act="extra" data-x="challenges">${ICON.badge(18, 1.53)}<span class="mr-txt">Challenges</span><span class="count ch-count hidden"></span>${ICON.chevR()}</button>
    </div>
    <div class="menu-vol">
      <button type="button" class="vol-mute" data-act="mute" aria-label="Mute" title="Mute (M)"></button>
      <input type="range" min="0" max="100" step="1" class="vol" aria-label="Volume">
      <span class="vol-pct">80%</span>
    </div>
    <div class="menu-spacer"></div>
    <div class="menu-end host-only"><button type="button" class="btn danger" data-act="tolobby">End game for everyone</button></div>
    <div class="pad-hints" aria-hidden="true">
      <span><i class="pad-key">A</i>Select</span><span><i class="pad-key">B</i>Back</span><span><kbd>Esc</kbd>Close</span>
    </div>
  </div>
</div>

<div class="toasts" aria-live="polite"></div>
<div class="banner hidden" id="ir-banner" role="status">${ICON.warn()}<span class="banner-msg"></span><button type="button" class="btn secondary sm" data-act="banner-close">Got it</button></div>
`;

// ------------------------------------------------------------------ UI
export function createUI(root, h = {}) {
  root.innerHTML = TEMPLATE;
  const $ = (sel, el = root) => el.querySelector(sel);
  const $$ = (sel, el = root) => [...el.querySelectorAll(sel)];

  const els = {
    lobby: $('#lobby'), hud: $('#hud'), menu: $('#ir-menu'), scrim: $('.scrim'),
    conn: $('.conn'), connText: $('.conn-text'), connPing: $('.conn-ping'),
    name: $('#ir-name'), nameOk: $('.name-ok'), youAv: $('.you-av'), role: $('.role-line'),
    share: $('#ir-share'), invitePop: $('#ir-invite-pop'), inviteUrl: $('.invite-url'), localWarn: $('.local-warn'),
    offlineBtn: $('.offline-btn'), offlineIco: $('.offline-btn .tool-ico'), offlineTxt: $('.offline-btn .tool-txt'),
    tabs: $$('.view-tab'), chCounts: $$('.ch-count'), mtabs: $$('.ir-mobile-tabs [data-mtab]'),
    views: { match: $('#ir-view-match'), leaderboard: $('#ir-view-leaderboard'), challenges: $('#ir-view-challenges') },
    matchup: $('.matchup'), sides: $$('.matchup .side'), h2h: $('.h2h'), h2hRows: $('.h2h-rows'), matchBar: $('.match-bar'),
    ratingsBtn: $('.ratings-btn'), ratingsSum: $('.ratings-btn .rt-s'),
    picker: $('.picker'), pcard: $('.pcard'), rail: $('.rail'), chatMount: $('#ir-lobby-chat'),
    mStart: $('.m-start'), mTitleS: $('.m-title-s'), mUnread: $('.mt-unread'),
    sb: $('.scoreboard'), sbHome: $('.sb-home'), sbAway: $('.sb-away'),
    sbHomeKey: $('.sb-home .sb-key'), sbHomeScore: $('.sb-home .sb-score'), sbHomeMark: $('.sb-home .sb-mark'),
    sbAwayKey: $('.sb-away .sb-key'), sbAwayScore: $('.sb-away .sb-score'), sbAwayMark: $('.sb-away .sb-mark'),
    sbMid: $('.sb-mid'), sbPer: $('.sb-per'), sbClk: $('.sb-clk'),
    hudPing: $('.hud-ping'), hudSig: $('.hud-ping .sig-wrap'), hudPingText: $('.hud-ping-txt'),
    specBar: $('.spec-bar'), specJoins: $$('.spec-join'), faceoff: $('.faceoff'), foBar: $('.fo-bar i'),
    callout: $('.callout'), loading: $('.loading'),
    final: $('.final'), finChip: $('.fin-chip'), finTitle: $('.fin-title'), finHome: $('.fin-home'), finAway: $('.fin-away'),
    finN0: $('.fin-n0'), finN1: $('.fin-n1'), finStats: $('.fin-stats'), finStars: $('.fin-stars'),
    finCount: $('.fin-count-txt'), finBar: $('.fin-bar i'),
    toasts: $('.toasts'), banner: $('#ir-banner'), bannerMsg: $('#ir-banner .banner-msg'),
    vol: $('.menu .vol'), volPct: $('.vol-pct'), menuMute: $('.vol-mute'),
    menuSides: $$('.side-seg .seg-b'),
    hostOnly: $$('.host-only'),
  };

  // persistent UI state
  const S = {
    frame: null, screen: '', menuOpen: false, prevClients: null, view: 'match',
    lastStatus: '', statsSerial: -1, stats: freshStats(), tally: {}, unlocks: [], otWinner: -1,
    finalAt: 0, coUntil: 0, coPrio: -1, scoredSide: -1, scoredUntil: 0,
    isHost: false, myTeam: -1, gameTeams: null, offline: false, challenges: null,
    sideKeys: ['', ''], barKey: '', h2hKey: '', picker: -1, pcardFor: null, recon: false,
    mtab: 'match', unread: 0, hereKey: '',
  };

  // Portrait phone layout ("Final · mobile"): same breakpoint as style.css.
  const mq = (q) => { try { return window.matchMedia ? window.matchMedia(q) : null; } catch { return null; } };
  const phoneMQ = mq('(max-width: 600px), (orientation: portrait) and (pointer: coarse)');
  const isPhone = () => !!(phoneMQ && phoneMQ.matches);
  /** Rendered and not hidden by display or visibility (inactive phone tabs stay laid out, invisible). */
  const shown = (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';

  // ---------------------------------------------------------------- name + share
  const params = new URLSearchParams(location.search);
  const urlName = params.get('name');
  els.name.value = (urlName || loadName() || '').slice(0, 16);
  let okTimer = 0;
  function commitName() {
    const n = els.name.value.replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!n) { els.name.value = S.lastName || ''; return; }
    els.name.value = n;
    if (n === S.lastName) return;
    S.lastName = n;
    saveName(n);
    els.nameOk.textContent = 'Saved';
    clearTimeout(okTimer); okTimer = setTimeout(() => { els.nameOk.textContent = ''; }, 1400);
    S.youKey = '';
    h.setName && h.setName(n);
  }
  els.name.addEventListener('change', commitName);
  els.name.addEventListener('blur', commitName);
  els.name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); els.name.blur(); }
    e.stopPropagation(); // typing must not trigger game / mute / fullscreen keys
  });
  S.lastName = els.name.value;

  const room = params.get('room') || 'main';
  const shareUrl = location.origin + location.pathname + (room !== 'main' ? `?room=${encodeURIComponent(room)}` : '');
  els.share.value = shareUrl.replace(/^https?:\/\//, '');
  els.inviteUrl.textContent = shareUrl;
  const isLocal = /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/.test(location.hostname);
  setClass(els.localWarn, 'hidden', !isLocal);

  async function copyShare() {
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(shareUrl); ok = true; } } catch { ok = false; }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = shareUrl; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    toast(ok ? 'Invite link copied' : 'Select the address and copy it yourself', ok ? 'good' : 'warn');
  }

  // ---------------------------------------------------------------- popovers (invite, team picker, player card)
  function setInvite(open) {
    open = !!open;
    setClass(els.invitePop, 'hidden', !open);
    els.share.setAttribute('aria-expanded', String(open));
    setClass(els.share.parentElement, 'open', open);
    if (open) { closePicker(); const b = els.invitePop.querySelector('.btn'); b && b.focus({ preventScroll: true }); }
  }
  els.share.addEventListener('click', () => setInvite(els.invitePop.classList.contains('hidden')));
  els.share.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setInvite(true); } });

  function pickerHTML(side, cfg) {
    const other = cfg.teams[1 - side];
    const tiles = TEAMS.map((T, i) => {
      const cur = cfg.teams[side] === i, dis = other === i;
      return `<button type="button" class="pk-tile${cur ? ' cur' : ''}" style="${tcVar(i)}" data-act="pick-team" data-team="${side}" data-ti="${i}"` +
        `${dis ? ' disabled aria-disabled="true"' : ''} aria-pressed="${cur}" aria-label="${escHtml(`${T.city} ${T.name}`)}${dis ? ` (playing ${SIDE[1 - side]})` : ''}">` +
        `<span class="pk-mark">${crest(i, 52, 'mark')}</span><span class="pk-name">${escHtml(`${T.city} ${T.name}`)}</span></button>`;
    }).join('');
    const O = teamT(other);
    return `<div class="pk-head"><span class="pk-title">${SIDE_CAP[side]} team</span><span class="pk-hint">← → to browse</span>` +
      `<button type="button" class="icon-btn pk-close" data-act="picker-close" aria-label="Close">${ICON.close()}</button></div>` +
      `<div class="pk-grid">${tiles}</div>` +
      `<div class="pk-note"><i class="dot"></i><span>${escHtml(`${O.city} ${O.name}`)} are playing ${SIDE[1 - side]}</span></div>`;
  }
  function openPicker(side) {
    const L = S.frame && S.frame.lobby;
    if (!S.isHost || !L) return;
    const cfg = { ...DEFAULT_CONFIG, ...(L.config || {}) };
    S.picker = side;
    setInvite(false); hideCard(true);
    els.picker.innerHTML = pickerHTML(side, cfg);
    els.picker.setAttribute('aria-label', `${SIDE_CAP[side]} team`);
    setClass(els.picker, 'at-away', side === 1);
    const row = els.sides[side].querySelector('.crest-row');
    // phones: the picker is a full-screen sheet (style.css), not a popover under the crest
    els.picker.style.top = row && !isPhone() ? `${row.offsetTop + row.offsetHeight + 14}px` : '';
    setClass(els.picker, 'hidden', false);
    const cur = els.picker.querySelector('.pk-tile.cur') || els.picker.querySelector('.pk-tile:not([disabled])');
    cur && cur.focus({ preventScroll: true });
    h.blip && h.blip('select');
  }
  function closePicker(refocus) {
    if (S.picker < 0) return;
    const side = S.picker;
    S.picker = -1;
    setClass(els.picker, 'hidden', true);
    if (refocus) { const b = els.sides[side].querySelector('.crest-btn'); b && b.focus({ preventScroll: true }); }
  }
  els.picker.addEventListener('keydown', (e) => {
    const tiles = $$('.pk-tile', els.picker);
    let i = tiles.indexOf(document.activeElement);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(true); return; }
    if (!step) return;
    e.preventDefault();
    if (i < 0) i = 0;
    for (let n = 0; n < tiles.length; n++) {
      i = (i + step + tiles.length) % tiles.length;
      if (!tiles[i].disabled) break;
    }
    tiles[i].focus();
    h.blip && h.blip('move');
  });

  // player career card (hover a human in a lineup)
  const statsCache = new Map();
  let cardTimer = 0;
  function fetchStats(name) {
    const key = String(name).toLowerCase();
    const hit = statsCache.get(key);
    if (hit && performance.now() - hit.t < STATS_TTL_MS) return hit.p;
    const p = Promise.resolve(h.playerStats ? h.playerStats(name) : null).catch(() => null);
    statsCache.set(key, { t: performance.now(), p });
    return p;
  }
  function cardHTML(info, st) {
    const stat = (v, l) => `<div class="pc-stat"><b>${v}</b><span>${l}</span></div>`;
    let body;
    if (st === undefined) body = `<div class="pc-stats">${stat('–', 'Record')}${stat('–', 'Goals')}${stat('–', 'Hits')}${stat('–', 'Glass')}</div>`;
    else if (!st) body = '<div class="pc-none">No games on record yet</div>';
    else {
      const pct = Math.round((st.winPct != null ? st.winPct : st.games ? st.wins / st.games : 0) * 100);
      body = `<div class="pc-stats">${stat(`${st.wins | 0}–${st.losses | 0}`, 'Record')}${stat(st.goals | 0, 'Goals')}${stat(st.hits | 0, 'Hits')}${stat(st.glass | 0, 'Glass')}</div>` +
        `<div class="pc-win"><span class="pc-bar"><i style="width:${pct}%"></i></span><span class="pc-pct">${pct}% wins</span></div>`;
    }
    return `<div class="pc-head">${info.avatar}<div><div class="pc-name">${escHtml(info.name)}</div><div class="pc-sub">${escHtml(info.sub)}</div></div></div>${body}`;
  }
  function showCard(row) {
    const side = Number(row.closest('.side').dataset.side);
    const name = row.dataset.name;
    const info = { name, sub: row.dataset.sub || '', avatar: row.querySelector('.avatar').outerHTML.replace('class="avatar', 'class="avatar av-md') };
    S.pcardFor = row;
    els.pcard.style.cssText = row.closest('.side').getAttribute('style') || ''; // team colour vars
    els.pcard.innerHTML = cardHTML(info, undefined);
    // below the row, inset 16 px from its outer edge
    const mr = els.matchup.getBoundingClientRect(), rr = row.getBoundingClientRect();
    els.pcard.style.top = `${rr.bottom - mr.top + 6}px`;
    if (side === 1) { els.pcard.style.left = 'auto'; els.pcard.style.right = `${mr.right - rr.right + 16}px`; } else { els.pcard.style.right = 'auto'; els.pcard.style.left = `${rr.left - mr.left + 16}px`; }
    setClass(els.pcard, 'hidden', false);
    fetchStats(name).then((st) => { if (S.pcardFor === row) els.pcard.innerHTML = cardHTML(info, st || null); });
  }
  function hideCard(now) {
    clearTimeout(cardTimer);
    if (now) { S.pcardFor = null; setClass(els.pcard, 'hidden', true); return; }
    cardTimer = setTimeout(() => { S.pcardFor = null; setClass(els.pcard, 'hidden', true); }, 120);
  }
  els.matchup.addEventListener('mouseover', (e) => {
    const row = e.target.closest('.row.human');
    if (!row || isPhone()) return; // no hover on phones (a tap would pop the card over the list)
    if (S.pcardFor === row) { clearTimeout(cardTimer); return; }
    clearTimeout(cardTimer);
    if (S.picker >= 0) return;
    cardTimer = setTimeout(() => showCard(row), S.pcardFor ? 0 : 220);
  });
  els.matchup.addEventListener('mouseout', (e) => {
    const row = e.target.closest('.row.human');
    if (row && !row.contains(e.relatedTarget)) hideCard(false);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!els.invitePop.classList.contains('hidden') && !e.target.closest('.invite')) setInvite(false);
    if (S.picker >= 0 && !e.target.closest('.picker') && !e.target.closest('.crest-btn')) closePicker(false);
  }, true);
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.invitePop.classList.contains('hidden')) { e.preventDefault(); setInvite(false); els.share.focus(); }
  });

  // ---------------------------------------------------------------- views (match / leaderboard / challenges)
  // Inactive views (and, on phones, the inactive tab panes) stay laid out but invisible, so every
  // view keeps its own scroll position (class "off": visibility hidden, see style.css).
  const MTAB_OF = { match: 'match', leaderboard: 'leaders', challenges: 'challenges' };
  function showView(name, force) {
    if (!els.views[name]) name = 'match';
    const mtab = MTAB_OF[name];
    if (S.mtab !== mtab) setMtab(mtab, true);
    if (name === S.view && !force) return;
    S.view = name;
    for (const [k, el] of Object.entries(els.views)) { setClass(el, 'off', k !== name); setAttr(el, 'aria-hidden', k !== name ? 'true' : null); }
    for (const t of els.tabs) { const on = t.dataset.view === name; setClass(t, 'on', on); t.setAttribute('aria-pressed', String(on)); }
    els.lobby.dataset.view = name;
    closePicker(false); hideCard(true);
    if (h.view) { try { h.view(name, els.views[name]); } catch (e) { console.warn('[ICE RIOT] view handler', e); } }
  }
  /** Phone bottom tabs: match / chat / leaders / challenges (leaders and challenges are the views). */
  function setMtab(tab, fromView) {
    if (!['match', 'chat', 'leaders', 'challenges'].includes(tab)) tab = 'match';
    const was = S.mtab;
    S.mtab = tab;
    els.lobby.dataset.mtab = tab;
    for (const b of els.mtabs) { const on = b.dataset.mtab === tab; setClass(b, 'on', on); setAttr(b, 'aria-current', on ? 'page' : null); }
    if (tab === 'chat') { S.unread = 0; syncUnread(); chatGutters(); }
    if (was === 'chat' && tab !== 'chat' && document.activeElement && els.rail.contains(document.activeElement)) document.activeElement.blur();
    if (fromView) return;
    if (tab === 'match') showView('match');
    else if (tab === 'leaders') showView('leaderboard');
    else if (tab === 'challenges') showView('challenges');
  }
  for (const b of els.mtabs) b.addEventListener('click', () => { setMtab(b.dataset.mtab); h.blip && h.blip('move'); });
  // The chat tab hands chat.js a full-bleed pane; chat.js draws its own 16 px gutters there. Until
  // it does (no horizontal padding on its log), the pane pads itself so text never meets the edge.
  function chatGutters() {
    const log = els.chatMount.querySelector('.ir-chat-log');
    if (!log || !isPhone()) { setClass(els.chatMount, 'pad', false); return; }
    const px = (el) => (el ? parseFloat(getComputedStyle(el).paddingLeft) || 0 : 0);
    setClass(els.chatMount, 'pad', px(log) + px(log.parentElement) === 0);
  }
  function syncUnread() {
    const n = S.unread;
    setText(els.mUnread, n > 99 ? '99+' : n);
    setClass(els.mUnread, 'hidden', !n);
    setAttr(els.mtabs.find((b) => b.dataset.mtab === 'chat'), 'aria-label', n ? `Chat, ${n} unread` : null);
  }

  // Phone keyboard: the lobby follows the visual viewport, so the chat composer rides on the
  // keyboard; the tab bar hides and "Done" (top bar) dismisses the keyboard.
  const vv = window.visualViewport;
  function syncViewport() {
    if (!vv) return;
    setVar(root, '--vv-h', `${Math.round(vv.height)}px`);
    setVar(root, '--vv-top', `${Math.round(vv.offsetTop)}px`);
  }
  if (vv) { vv.addEventListener('resize', syncViewport); vv.addEventListener('scroll', syncViewport); syncViewport(); }
  const typingIn = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit)$/i.test(el.type)));
  function syncKeyboard() {
    const a = document.activeElement;
    setClass(els.lobby, 'kb-open', isPhone() && typingIn(a) && els.lobby.contains(a));
  }
  els.lobby.addEventListener('focusin', syncKeyboard);
  els.lobby.addEventListener('focusout', () => setTimeout(syncKeyboard, 0));
  if (phoneMQ && phoneMQ.addEventListener) phoneMQ.addEventListener('change', () => { syncKeyboard(); if (S.picker >= 0) openPicker(S.picker); });

  // ---------------------------------------------------------------- toasts / banner
  function toast(msg, kind = 'info') {
    if (kind === 'ok') kind = 'good';
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.innerHTML = `<span class="toast-ico">${(TOAST_ICON[kind] || TOAST_ICON.info)()}</span><span class="toast-txt"></span>`;
    t.lastChild.textContent = msg;
    // newest on top, and a warning or error stays above the routine ones ("Lobby · reconnecting, toasts")
    const urgent = (el) => el.classList.contains('warn') || el.classList.contains('error');
    const list = els.toasts;
    const ref = urgent(t) ? list.firstChild : [...list.children].find((el) => !urgent(el)) || null;
    list.insertBefore(t, ref);
    while (list.children.length > 4) {
      const old = [...list.children].reverse().find((el) => !urgent(el)) || list.lastChild;
      old.remove();
    }
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 140); }, kind === 'error' ? 4500 : 3200);
  }
  // The 2D-fallback banner stays in the lobby until "Got it"; in game (where it sits under the
  // scoreboard) it lets go by itself once it has been up there for BANNER_GAME_MS.
  const BANNER_GAME_MS = 8000;
  let bannerGameAt = 0;
  function banner(msg) {
    els.bannerMsg.textContent = msg;
    els.banner.classList.remove('hidden', 'out');
    bannerGameAt = 0;
  }
  function hideBanner() {
    if (els.banner.classList.contains('hidden') || els.banner.classList.contains('out')) return;
    els.banner.classList.add('out');
    setTimeout(() => { els.banner.classList.add('hidden'); els.banner.classList.remove('out'); }, 120);
  }
  function bannerTick(now) {
    if (S.screen !== 'game' || els.banner.classList.contains('hidden')) { bannerGameAt = 0; return; }
    if (!bannerGameAt) bannerGameAt = now;
    else if (now - bannerGameAt > BANNER_GAME_MS) hideBanner();
  }

  // ---------------------------------------------------------------- menu
  function setMenu(open) {
    open = !!open && S.screen === 'game';
    if (open === S.menuOpen) return;
    S.menuOpen = open;
    setClass(els.menu, 'hidden', !open);
    setClass(root, 'menu-open', open);
    h.blip && h.blip(open ? 'select' : 'back');
    if (open) {
      syncSound();
      const first = els.menu.querySelector('[data-act="resume"]');
      first && first.focus({ preventScroll: true });
    } else {
      setClass(root, 'pad-nav', false);
      if (document.activeElement && els.menu.contains(document.activeElement)) document.activeElement.blur();
    }
    h.menuChanged && h.menuChanged(open);
  }
  function syncSound() {
    const a = h.audioState ? h.audioState() : { muted: false, volume: 0.8 };
    const v = Math.round(a.volume * 100);
    if (els.vol.value !== String(v) && document.activeElement !== els.vol) els.vol.value = String(v);
    const shown = Number(els.vol.value);
    setVar(els.vol, '--p', `${shown}%`);
    setText(els.volPct, a.muted ? 'Muted' : `${shown}%`);
    setHTML(els.menuMute, ICON.speaker(18, a.muted));
    const lbl = a.muted ? 'Unmute' : 'Mute';
    if (els.menuMute.getAttribute('aria-label') !== lbl) { els.menuMute.setAttribute('aria-label', lbl); els.menuMute.title = `${lbl} (M)`; }
    setClass(els.menuMute, 'muted', a.muted);
  }
  els.vol.addEventListener('input', () => { h.setVolume && h.setVolume(els.vol.value / 100); syncSound(); });

  // gamepad in the lobby: D-pad walks the buttons, A presses (with nothing focused, a player in the
  // stands joins the first open side - the "A" glyph on the join buttons - and anyone else starts the
  // walk), B lets go of the focus.
  function lobbyPad(btn) {
    if (S.picker >= 0 && btn === 1) { closePicker(true); return; }
    const scope = S.picker >= 0 ? els.picker : els.lobby;
    const items = $$('button', scope).filter((el) => !el.disabled && !el.closest('.ir-mobile-tabs') && shown(el));
    if (!items.length) return;
    let i = items.indexOf(document.activeElement);
    if (btn === 0) {
      if (i >= 0) { items[i].click(); return; }
      // nothing focused: only a player in the stands joins (the join button carries the A glyph). A player
      // already on a team never gets switched by a stray A (it is also shoot): A starts the walk on the
      // current view's tab, where a second press changes nothing.
      const join = S.myTeam !== 0 && S.myTeam !== 1 && S.picker < 0 ? els.lobby.querySelector('.team-btn:not([disabled]) .pad-key') : null;
      if (join) { setClass(root, 'pad-nav', true); join.closest('.team-btn').click(); return; }
      setClass(root, 'pad-nav', true);
      (items.find((el) => el.matches('.view-tab.on')) || items[0]).focus({ preventScroll: true });
      h.blip && h.blip('move');
      return;
    }
    if (btn === 1) { if (i >= 0) document.activeElement.blur(); setClass(root, 'pad-nav', false); return; }
    if (btn === 12 || btn === 14) i = i < 0 ? 0 : (i - 1 + items.length) % items.length;
    else if (btn === 13 || btn === 15) i = (i + 1) % items.length;
    else return;
    setClass(root, 'pad-nav', true);
    items[i].focus({ preventScroll: true });
    h.blip && h.blip('move');
  }

  // gamepad navigation inside the menu (Start toggles, D-pad moves, A selects, B closes)
  function padNav(btn) {
    if (S.screen === 'lobby') { lobbyPad(btn); return; }
    if (btn === 9) { setMenu(!S.menuOpen); if (S.menuOpen) setClass(root, 'pad-nav', true); return; }
    if (!S.menuOpen) return;
    setClass(root, 'pad-nav', true);
    const items = $$('.menu-panel button, .menu-panel .vol').filter((el) => el.offsetParent !== null && !el.disabled);
    if (!items.length) return;
    let i = items.indexOf(document.activeElement);
    const cur = items[i];
    if (cur === els.vol && (btn === 14 || btn === 15)) {
      els.vol.value = String(Math.max(0, Math.min(100, Number(els.vol.value) + (btn === 15 ? 5 : -5))));
      els.vol.dispatchEvent(new Event('input'));
      h.blip && h.blip('move');
      return;
    }
    if (btn === 12 || btn === 14) i = (i - 1 + items.length) % items.length;
    else if (btn === 13 || btn === 15) i = (i + 1) % items.length;
    else if (btn === 0 && i >= 0) { items[i].click(); return; }
    else if (btn === 1) { setMenu(false); return; }
    else return;
    items[i].focus();
    h.blip && h.blip('move');
  }
  // mouse / keyboard use hides the gamepad focus ring again
  root.addEventListener('pointerdown', () => setClass(root, 'pad-nav', false), true);

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
      case 'picker': {
        const side = Number(b.dataset.team);
        if (S.picker === side) closePicker(false); else openPicker(side);
        break;
      }
      case 'pick-team': {
        if (!S.isHost) break;
        const side = Number(b.dataset.team), ti = Number(b.dataset.ti);
        const teams = [...cfg.teams];
        if (ti !== teams[1 - side]) { teams[side] = ti; sendCfg({ teams }); }
        closePicker(true);
        h.blip && h.blip('select');
        break;
      }
      case 'period': if (S.isHost) { sendCfg({ periodLength: Number(b.dataset.v) }); h.blip && h.blip('move'); } break;
      case 'diff': if (S.isHost) { sendCfg({ difficulty: Number(b.dataset.v) }); h.blip && h.blip('move'); } break;
      case 'start': if (S.isHost) { h.start && h.start(); h.blip && h.blip('start'); } break;
      case 'copy': copyShare(); h.blip && h.blip('select'); if (b.dataset.close) setInvite(false); break;
      case 'edit-name': els.name.focus(); els.name.select(); break;
      case 'view': showView(b.dataset.view); h.blip && h.blip('move'); break;
      case 'picker-close': closePicker(true); h.blip && h.blip('back'); break;
      case 'ratings': {
        const open = b.getAttribute('aria-expanded') !== 'true';
        b.setAttribute('aria-expanded', String(open));
        setClass(els.h2h, 'open', open);
        h.blip && h.blip('move');
        break;
      }
      case 'kb-done': if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); break;
      case 'menu': setMenu(true); break;
      case 'resume': setMenu(false); break;
      case 'mute': h.toggleMute && h.toggleMute(); syncSound(); break;
      case 'tolobby': if (S.isHost) { h.toLobby && h.toLobby(); setMenu(false); } break;
      case 'banner-close': hideBanner(); break;
      case 'extra': h.extra && h.extra(b.dataset.x); h.blip && h.blip('select'); break;
      default: break;
    }
  });
  els.menu.addEventListener('click', (e) => { if (e.target === els.menu) setMenu(false); });
  // arrow keys inside a segmented control move the selection (radio-group behaviour)
  root.addEventListener('keydown', (e) => {
    const seg = e.target.closest && e.target.closest('.seg');
    if (!seg || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const opts = $$('.seg-b:not([disabled])', seg);
    const i = opts.indexOf(e.target);
    if (i < 0) return;
    e.preventDefault();
    const next = opts[(i + (e.key === 'ArrowRight' ? 1 : -1) + opts.length) % opts.length];
    next.focus();
    if (!seg.classList.contains('side-seg')) next.click();
  });

  // ---------------------------------------------------------------- lobby rendering
  function rowHTML(kind, o) {
    const num = `<span class="num">${o.num}</span>`;
    if (kind === 'human') {
      const q = pingQuality(o.ping);
      const tail = o.me ? '<span class="you-chip">You</span>'
        : `<span class="ping" data-cid="${o.id}">${signalSVG(q)}<span class="ms">${o.ping ? `${Math.round(o.ping)} ms` : '– ms'}</span></span>`;
      return `<li class="row human${o.me ? ' me' : ''}" data-name="${escHtml(o.name)}" data-sub="${escHtml(o.sub)}">${num}` +
        `<span class="avatar tinted">${escHtml(initial(o.name))}</span><span class="pname">${escHtml(o.name)}</span>${tail}</li>`;
    }
    if (kind === 'ai') {
      return `<li class="row ai">${num}<span class="avatar ghost">${ICON.chip()}</span><span class="pname">${escHtml(o.name)}</span><span class="tag">AI · open</span></li>`;
    }
    return `<li class="row goalie">${num}<span class="avatar ring">${ICON.mask()}</span><span class="pname">${escHtml(o.name)}</span><span class="tag">Goalie · AI</span></li>`;
  }

  function sideHTML(side, ti, members, ctx) {
    const T = teamT(ti);
    const { myTeam, isHost, myId, online, me } = ctx;
    const rows = [];
    for (let i = 0; i < SKATERS_PER_TEAM; i++) {
      const c = members[i], r = T.skaters[i];
      if (c) rows.push(rowHTML('human', { id: c.id, name: c.name, num: r.num, me: c.id === myId, ping: c.ping, sub: `Plays #${r.num} ${r.name}` + (c.ping ? ` · ${Math.round(c.ping)} ms` : '') }));
      else rows.push(rowHTML('ai', { num: r.num, name: r.name }));
    }
    rows.push(rowHTML('goalie', { num: T.goalie.num, name: T.goalie.name }));
    const full = members.length >= MAX_HUMANS_PER_TEAM;
    let act = '';
    if (me && myTeam !== side) {
      const stands = myTeam !== 0 && myTeam !== 1;
      const label = full ? `${SIDE_CAP[side]} is full` : stands ? `Join ${SIDE[side]}` : `Switch to ${SIDE[side]}`;
      act = `<button type="button" class="btn tbtn team-btn" data-act="pick" data-team="${side}"${full || !online ? ' disabled' : ''}>` +
        `${stands && !full ? '<i class="pad-key" aria-hidden="true">A</i>' : ''}<span>${label}</span></button>`;
    }
    // host: prev/next arrows + a crest that opens the picker (shown but disabled while reconnecting)
    const arrow = (dir) => `<button type="button" class="icon-btn cyc" data-act="team" data-team="${side}" data-dir="${dir}" aria-label="${dir < 0 ? 'Previous' : 'Next'} ${SIDE[side]} team"${isHost ? '' : ' tabindex="-1" aria-hidden="true"'}${isHost && online ? '' : ' disabled'}>${dir < 0 ? ICON.chevL() : ICON.chevR()}</button>`;
    const crestEl = isHost
      ? `<button type="button" class="crest-btn" data-act="picker" data-team="${side}" aria-haspopup="dialog" aria-label="Choose the ${SIDE[side]} team (${escHtml(`${T.city} ${T.name}`)})"${online ? '' : ' disabled'}>${crest(ti, 136)}</button>`
      : `<div class="crest-btn" role="img" aria-label="${escHtml(`${T.city} ${T.name}`)}">${crest(ti, 136)}</div>`;
    return `<div class="side-head"><div class="crest-row${isHost ? ' host' : ''}">${arrow(-1)}${crestEl}${arrow(1)}</div>` +
      `<div class="side-title"><div class="side-city">${SIDE_CAP[side]} · ${escHtml(T.city)}</div><div class="side-name">${escHtml(T.name)}</div></div></div>` +
      `<div class="side-body"><div class="lineup-lbl" aria-hidden="true">${SIDE_CAP[side]}</div>` +
      `<ol class="lineup" aria-label="${SIDE_CAP[side]} lineup">${rows.join('')}</ol><div class="side-act">${act}</div></div>`;
  }

  function h2hHTML(teams) {
    const A = teamRatings(teams[0]), B = teamRatings(teams[1]);
    return A.map((a, i) => {
      const b = B[i];
      return `<div class="h2h-row"><div class="h2h-vals"><span>${a.text}</span><span class="h2h-lbl">${a.label}</span><span>${b.text}</span></div>` +
        `<div class="h2h-bars"><span class="hb"><i style="width:${Math.min(100, a.v * 10).toFixed(1)}%"></i></span><span class="hb"><i style="width:${Math.min(100, b.v * 10).toFixed(1)}%"></i></span></div></div>`;
    }).join('');
  }

  function standsHTML(specs, myId) {
    if (!specs.length) return '<span class="stand-names empty">Nobody yet</span>';
    const shown = specs.slice(0, 4);
    const av = shown.map((c) => `<span class="avatar sm${c.id === myId ? ' me' : ''}" title="${escHtml(c.name)}">${escHtml(initial(c.name))}</span>`).join('');
    const names = specs.map((c) => (c.id === myId ? 'You' : c.name));
    return `<span class="stack">${av}${specs.length > 4 ? `<span class="avatar sm more">+${specs.length - 4}</span>` : ''}</span><span class="stand-names">${escHtml(names.join(', '))}</span>`;
  }

  function segHTML(kind, options, value, enabled, label) {
    return `<div class="seg" role="radiogroup" aria-label="${label}">` + options.map(([v, text]) =>
      `<button type="button" class="seg-b${v === value ? ' on' : ''}" role="radio" aria-checked="${v === value}" data-act="${kind}" data-v="${v}"${enabled ? '' : ' disabled'}${v === value ? '' : ' tabindex="-1"'}>${text}</button>`).join('') + '</div>';
  }

  function barHTML(ctx) {
    const { cfg, isHost, online, specs, myId, myTeam, me, host } = ctx;
    const watch = me && (myTeam === 0 || myTeam === 1) ? `<button type="button" class="btn secondary sm" data-act="pick" data-team="-1"${online ? '' : ' disabled'}>Watch</button>` : '';
    const stands = `<div class="mb-field mb-stands"><div class="lbl">In the stands</div><div class="stands-row">${standsHTML(specs, myId)}${watch}</div></div>`;
    if (isHost) {
      return `<div class="mb-field mb-period"><div class="lbl" id="ir-lbl-period">Period length</div>${segHTML('period', PERIOD_OPTS.map((v) => [v, `${v / 60} min`]), cfg.periodLength, online, 'Period length')}</div>` +
        `<div class="mb-field mb-ai"><div class="lbl">AI level</div>${segHTML('diff', DIFF_NAMES.map((n, i) => [i, n]), cfg.difficulty, online, 'AI level')}</div>` +
        stands + `<button type="button" class="btn primary start" data-act="start"${online && !S.recon ? '' : ' disabled'}>Start game</button>`;
    }
    const hostName = host ? host.name : 'the host';
    // desktop shows the values as text; the phone layout shows the same controls, read-only (dimmed,
    // no fill behind the row, and a "Set by the host" note on the label)
    const roNote = '<span class="lbl-note">Set by the host</span>';
    return `<div class="mb-field ro d-only"><div class="lbl">Period length</div><div class="ro-val">${cfg.periodLength / 60} min</div></div>` +
      `<div class="mb-field ro d-only"><div class="lbl">AI level</div><div class="ro-val">${DIFF_NAMES[cfg.difficulty] || 'Pro'}</div></div>` +
      `<div class="mb-field mb-period m-only"><div class="lbl">Period length${roNote}</div>${segHTML('period', PERIOD_OPTS.map((v) => [v, `${v / 60} min`]), cfg.periodLength, false, 'Period length (set by the host)')}</div>` +
      `<div class="mb-field mb-ai m-only"><div class="lbl">AI level${roNote}</div>${segHTML('diff', DIFF_NAMES.map((n, i) => [i, n]), cfg.difficulty, false, 'AI level (set by the host)')}</div>` +
      stands + `<div class="waiting" role="status">${ICON.hourglass()}<span>${online ? `Waiting for ${escHtml(hostName)}` : 'Waiting to connect'}</span></div>`;
  }
  /** Phone layout: the sticky start band under the match tab (Start game, or Waiting for the host). */
  function startHTML(ctx) {
    const { isHost, online, host } = ctx;
    if (isHost) return `<button type="button" class="btn primary start" data-act="start"${online && !S.recon ? '' : ' disabled'}>Start game</button>`;
    const hostName = host ? host.name : 'the host';
    return `<div class="waiting" role="status">${ICON.hourglassSm()}<span>${online ? `Waiting for ${escHtml(hostName)}` : 'Waiting to connect'}</span></div>`;
  }

  function renderLobby(f) {
    const L = f.lobby;
    if (L === S.lobbyRef && f.status === S.lobbyStatus && f.myId === S.lobbyMyId && S.offline === S.lobbyOffline && S.recon === S.lobbyRecon) return; // nothing changed
    S.lobbyRef = L; S.lobbyStatus = f.status; S.lobbyMyId = f.myId; S.lobbyOffline = S.offline; S.lobbyRecon = S.recon;
    const online = f.status === 'online' && !!L;
    const cfg = { ...DEFAULT_CONFIG, ...((L && L.config) || {}) };
    const clients = (L && L.clients) || [];
    const isHost = !!(L && f.myId && L.host === f.myId);
    const me = clients.find((c) => c.id === f.myId);
    const myTeam = me ? me.team : -1;
    const host = clients.find((c) => L && c.id === L.host);
    const ctx = { cfg, online, isHost, me, myTeam, myId: f.myId, host };

    // rail: avatar, role line
    const youKey = JSON.stringify([myTeam, cfg.teams, isHost, S.offline, me && me.name]);
    if (youKey !== S.youKey) {
      S.youKey = youKey;
      const nm = (me && me.name) || els.name.value || '?';
      setText(els.youAv, initial(nm));
      const onTeam = myTeam === 0 || myTeam === 1;
      els.youAv.setAttribute('style', onTeam ? tcVar(cfg.teams[myTeam]) : '');
      setClass(els.youAv, 'tinted', onTeam);
      const parts = [];
      if (isHost) parts.push('host');
      if (S.offline) parts.push('offline practice');
      else if (me && !onTeam) parts.push('watching from the stands');
      else parts.push(`room ${room}`);
      const line = parts.join(' · ');
      setText(els.role, line.charAt(0).toUpperCase() + line.slice(1));
    }

    // matchup sides
    for (const el of els.sides) {
      const side = Number(el.dataset.side);
      const ti = cfg.teams[side];
      const members = clients.filter((c) => c.team === side);
      const key = JSON.stringify([ti, members.map((c) => [c.id, c.name]), myTeam, isHost, f.myId, online, !!me]);
      if (key !== S.sideKeys[side]) {
        S.sideKeys[side] = key;
        const hadFocus = el.contains(document.activeElement) ? document.activeElement.dataset.act + ':' + (document.activeElement.dataset.dir || '') : null;
        if (S.pcardFor && el.contains(S.pcardFor)) hideCard(true);
        el.setAttribute('style', tcVar(ti));
        el.innerHTML = sideHTML(side, ti, members, ctx);
        if (hadFocus) {
          const [a, d] = hadFocus.split(':');
          const back = el.querySelector(`[data-act="${a}"]${d ? `[data-dir="${d}"]` : ''}`);
          back && back.focus({ preventScroll: true });
        }
      } else {
        // only pings moved: patch them in place (keeps hover and focus)
        for (const c of members) {
          const p = el.querySelector(`.ping[data-cid="${c.id}"]`);
          if (!p) continue;
          const q = pingQuality(c.ping);
          if (p._q !== q) { p._q = q; p.firstElementChild.outerHTML = signalSVG(q); }
          setText(p.querySelector('.ms'), c.ping ? `${Math.round(c.ping)} ms` : '– ms');
        }
      }
    }
    const h2hKey = cfg.teams.join(',');
    if (h2hKey !== S.h2hKey) {
      S.h2hKey = h2hKey;
      els.h2h.setAttribute('style', `--home-c:${teamText(cfg.teams[0])};--away-c:${teamText(cfg.teams[1])}`);
      els.h2hRows.innerHTML = h2hHTML(cfg.teams);
      setText(els.ratingsSum, ratingsSummary(cfg.teams));
      if (S.picker >= 0) openPicker(S.picker); // re-render the picker for the new teams
    }
    // phone chat tab title: "Room friday · 6 here"
    const hereKey = `${room}:${clients.length}`;
    if (hereKey !== S.hereKey) { S.hereKey = hereKey; setText(els.mTitleS, `Room ${room} · ${clients.length} here`); }

    // match bar
    const specs = clients.filter((c) => c.team !== 0 && c.team !== 1);
    const barKey = JSON.stringify([isHost, online, cfg.periodLength, cfg.difficulty, specs.map((c) => [c.id, c.name]), myTeam, f.myId, host && host.name, !!me, S.recon]);
    if (barKey !== S.barKey) {
      S.barKey = barKey;
      const focusAct = els.matchBar.contains(document.activeElement) ? document.activeElement.dataset.act : null;
      setClass(els.matchBar, 'guest', !isHost);
      els.matchBar.innerHTML = barHTML({ ...ctx, specs });
      const startFocus = els.mStart.contains(document.activeElement);
      els.mStart.innerHTML = startHTML(ctx);
      if (focusAct) {
        const back = els.matchBar.querySelector(`[data-act="${focusAct}"].on`) || els.matchBar.querySelector(`[data-act="${focusAct}"]`);
        back && back.focus({ preventScroll: true });
      }
      if (startFocus) { const b = els.mStart.querySelector('button'); b && b.focus({ preventScroll: true }); }
    }
    if (!isHost && S.picker >= 0) closePicker(false);
  }

  function updateConn(f) {
    let st = f.status === 'online' && f.lobby ? 'online' : f.status;
    if (S.offline) st = 'offline';
    setAttr(els.conn, 'data-state', st);
    let text = 'Connecting', ping = '';
    if (st === 'offline') text = 'Offline practice';
    else if (st === 'online') { text = 'Connected'; ping = f.rtt ? `${Math.round(f.rtt)} ms` : ''; }
    else if (st === 'reconnecting') { text = 'Reconnecting'; ping = f.retryIn ? `retry in ${f.retryIn} s` : ''; }
    else if (f.status === 'online') text = 'Joining';
    else ping = f.retryIn ? `retry in ${f.retryIn} s` : '';
    setText(els.connText, text);
    setText(els.connPing, ping);
    const recon = st === 'reconnecting';
    if (recon !== S.recon) { S.recon = recon; setClass(els.lobby, 'recon', recon); }

    const q = pingQuality(f.rtt);
    const hq = st === 'online' ? q : '';
    if (els.hudPing._q !== hq) { els.hudPing._q = hq; els.hudSig.innerHTML = signalSVG(hq); }
    setText(els.hudPingText, st === 'online' ? (f.rtt ? `${Math.round(f.rtt)} ms` : '– ms') : st === 'offline' ? 'Offline' : st === 'reconnecting' ? 'Reconnecting' : 'Connecting');
    setAttr(els.hudPing, 'data-q', hq || 'none');
    if (S.lastStatus && S.lastStatus !== f.status && !S.offline) {
      if (f.status === 'reconnecting') toast('Connection lost, reconnecting', 'warn');
      else if (f.status === 'online' && S.lastStatus === 'reconnecting') toast('Reconnected', 'good');
    }
    S.lastStatus = f.status;
  }

  // ---------------------------------------------------------------- join/leave toasts
  function diffClients(f) {
    const L = f.lobby;
    if (!L) { S.prevClients = null; return; }
    // a new id of our own (offline practice <-> online, or a fresh session) is a different lobby:
    // start the diff over instead of announcing our old self as someone who left
    if (f.myId !== S.prevMyId) { S.prevMyId = f.myId; S.prevClients = null; S.prevHost = 0; }
    const cur = new Map((L.clients || []).map((c) => [c.id, c]));
    const where = (t) => (t === 0 || t === 1 ? SIDE[t] : 'the stands');
    if (S.prevClients) {
      for (const [id, c] of cur) {
        if (id === f.myId) continue;
        const p = S.prevClients.get(id);
        if (!p) toast(c.team === 0 || c.team === 1 ? `${c.name} joined ${SIDE[c.team]}` : `${c.name} joined the stands`, 'join');
        else if (p.team !== c.team) toast(c.team === 0 || c.team === 1 ? `${c.name} moved to ${where(c.team)}` : `${c.name} is watching from the stands`, 'join');
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
  function tallyAdd(id, k) {
    if (typeof id !== 'number' || id < 0) return;
    const t = (S.tally[id] ||= { g: 0, a: 0, h: 0 });
    t[k]++;
  }

  // ---------------------------------------------------------------- callouts
  function callout(now, html, opts = {}) {
    const { kind = 'plate', dur = 1.6, prio = 1, vars = '' } = opts;
    if (S.gameOver) return; // the final card owns the screen
    if (now < S.coUntil && prio < S.coPrio) return;
    S.coPrio = prio;
    S.coUntil = now + dur * 1000;
    const el = els.callout;
    el.className = 'callout';
    el.setAttribute('style', `${vars};--dur:${dur}s`);
    el.innerHTML = html;
    void el.offsetWidth; // restart the animation
    el.className = `callout show ${kind}`;
  }
  const nameSpan = (state, id, names, teams) => {
    const tm = teamOf(id);
    const color = tm >= 0 ? `style="color:${teamText(teams[tm])}"` : '';
    return `<b class="co-name" ${color}>${escHtml(shortName(state, id, names, teams))}</b>`;
  };
  const plate = (title, sub, glyph = '') =>
    `<div class="co-plate"><div class="co-head">${glyph ? `<span class="co-glyph">${glyph}</span>` : ''}<span class="co-title">${title}</span></div>${sub ? `<div class="co-sub">${sub}</div>` : ''}</div>`;
  const pill = (title, sub = '') => `<div class="co-pill"><span class="co-title">${title}</span>${sub ? `<span class="co-sub">${sub}</span>` : ''}</div>`;

  function handleEvents(f) {
    const { events, state, now } = f;
    const over = !!state && state.ph === PHASE.GAME_OVER;
    if (over && !S.gameOver) { S.coUntil = 0; els.callout.className = 'callout'; }
    S.gameOver = over;
    if (!events || !events.length) return;
    const names = f.names || {};
    const teams = (state && state.teams) || S.gameTeams || DEFAULT_CONFIG.teams;
    const T = (side) => teamT(teams[side]);
    const periods = ((f.lobby && f.lobby.config && f.lobby.config.periods) || DEFAULT_CONFIG.periods);
    S.finalDirty = true;
    for (const e of events) {
      const type = evType(e);
      switch (type) {
        case EVENT.SHOT: {
          const tm = teamOf(e.by);
          if (tm >= 0) S.stats[tm].shots++;
          if (e.kind === 'onetimer') callout(now, pill('One-timer', nameSpan(state, e.by, names, teams)), { kind: 'pill', dur: 1.1, prio: 2 });
          break;
        }
        case EVENT.HIT: {
          const tm = teamOf(e.by);
          if (tm >= 0) { S.stats[tm].hits++; if (e.big) S.stats[tm].big++; }
          tallyAdd(e.by, 'h');
          if (e.big) {
            const sub = `${nameSpan(state, e.by, names, teams)}<span>flattened</span>${nameSpan(state, e.target, names, teams)}`;
            callout(now, plate('Big hit', sub, ICON.burst()), { kind: 'plate hit', dur: 1.5, prio: 2 });
          }
          break;
        }
        case EVENT.GLASS: {
          const tm = teamOf(e.by);
          if (tm >= 0) S.stats[tm].glass++;
          const sub = e.by >= 0
            ? `${nameSpan(state, e.by, names, teams)}<span>${typeof e.target === 'number' && e.target >= 0 ? `put ${escHtml(shortName(state, e.target, names, teams))} through the glass` : 'broke the glass'}</span>`
            : '<span>The glass gave way</span>';
          callout(now, plate('Glass!', sub, ICON.glass()), { kind: 'plate glass', dur: 1.9, prio: 3 });
          break;
        }
        case EVENT.SAVE: {
          const tm = teamOf(e.goalie);
          if (tm >= 0) S.stats[tm].saves++;
          callout(now, pill('Save', nameSpan(state, e.goalie, names, teams)), { kind: 'pill', dur: 0.95, prio: 1 });
          break;
        }
        case EVENT.POST: callout(now, pill('Post', '<span class="dim">Ding</span>'), { kind: 'pill', dur: 0.9, prio: 1 }); break;
        case EVENT.GOAL: {
          const tm = e.team === 0 || e.team === 1 ? e.team : teamOf(e.scorer);
          tallyAdd(e.scorer, 'g');
          if (typeof e.assist === 'number' && e.assist >= 0) tallyAdd(e.assist, 'a');
          if (state && (state.per || 1) > periods) S.otWinner = e.scorer;
          if (tm < 0) break;
          const sc = (state && state.sc) || [0, 0];
          const lead = sc[0] === sc[1] ? `Tied ${sc[0]}–${sc[1]}` : `${T(sc[0] > sc[1] ? 0 : 1).name} lead ${Math.max(sc[0], sc[1])}–${Math.min(sc[0], sc[1])}`;
          const scorer = shortName(state, e.scorer, names, teams);
          const assist = typeof e.assist === 'number' && e.assist >= 0 ? `<span class="gd-assist">assist ${escHtml(shortName(state, e.assist, names, teams))}</span>` : '';
          const html = `<div class="goal-band"><span class="gb-crest">${crest(teams[tm], 148)}</span><span class="gb-word">${e.oneTimer ? 'One-timer goal' : 'Goal'}</span></div>` +
            `<div class="goal-detail"><span class="avatar tinted">${escHtml(initial(scorer))}</span><b class="gd-name">${escHtml(scorer)}</b>${assist}<span class="gd-rule"></span><span class="gd-lead">${escHtml(lead)}</span></div>`;
          callout(now, html, { kind: 'goal', dur: 3.2, prio: 5, vars: tcVar(teams[tm]) });
          S.scoredSide = tm; S.scoredUntil = now + 3200;
          break;
        }
        case EVENT.FIRE:
          if (e.on) callout(now, plate('On fire', `${nameSpan(state, e.player, names, teams)}<span>shoots and hits harder</span>`, ICON.flame()), { kind: 'plate fire', dur: 2.0, prio: 3 });
          break;
        case EVENT.FACEOFF: callout(now, pill('Go'), { kind: 'pill go', dur: 0.7, prio: 1 }); break;
        case EVENT.PERIOD: {
          const n = e.period ?? (state && state.per) ?? 1;
          if (n > periods) callout(now, plate('Overtime', `${ICON.clock()}<span class="strong">Sudden death · next goal wins</span>`), { kind: 'plate ot', dur: 2.6, prio: 4 });
          else {
            const sub = `<span class="mk">${crest(teams[0], 22, 'mark')}</span><span class="strong">${escHtml(T(0).name)}</span><span class="vs">vs</span><span class="strong">${escHtml(T(1).name)}</span><span class="mk">${crest(teams[1], 22, 'mark')}</span>`;
            callout(now, plate(`Period ${n}`, sub), { kind: 'plate period', dur: 2.0, prio: 4 });
          }
          break;
        }
        case EVENT.PERIOD_END: {
          const n = e.period ?? (state && state.per) ?? 1;
          const sc = (state && state.sc) || [0, 0];
          const s = S.stats;
          const sub = `<span class="strong">${T(0).key} ${sc[0]}–${sc[1]} ${T(1).key}</span><span class="rule"></span><span class="dim">Shots ${s[0].shots}–${s[1].shots} · Hits ${s[0].hits}–${s[1].hits}</span>`;
          callout(now, plate(n > periods ? 'End of OT' : `End of ${periodLabel(n, periods)}`, sub), { kind: 'plate end', dur: 3.2, prio: 4 });
          break;
        }
        default: break;
      }
    }
  }

  // ---------------------------------------------------------------- HUD
  function updateHud(f) {
    const st = f.state;
    setClass(els.loading, 'hidden', !!st);
    if (!st) {
      setClass(els.faceoff, 'hidden', true);
      setClass(els.final, 'hidden', true);
      setClass(els.specBar, 'hidden', true);
      return;
    }
    const teams = st.teams || DEFAULT_CONFIG.teams;
    S.gameTeams = teams;
    const tKey = teams.join(',');
    if (els.sb._teams !== tKey) {
      els.sb._teams = tKey;
      els.sbHome.setAttribute('style', tcVar(teams[0]));
      els.sbAway.setAttribute('style', tcVar(teams[1]));
      setText(els.sbHomeKey, teamT(teams[0]).key);
      setText(els.sbAwayKey, teamT(teams[1]).key);
      els.sbHomeMark.innerHTML = crest(teams[0], 32, 'mark');
      els.sbAwayMark.innerHTML = crest(teams[1], 32, 'mark');
      els.specJoins.forEach((b, i) => { b.setAttribute('style', tcVar(teams[i])); b.querySelector('.mk').innerHTML = crest(teams[i], 20, 'mark'); });
      els.menuSides.forEach((b, i) => { if (i < 2) { b.setAttribute('style', tcVar(teams[i])); b.querySelector('.mk').innerHTML = crest(teams[i], 18, 'mark'); } });
    }
    const sc = st.sc || [0, 0];
    if (els.sbHomeScore._t !== String(sc[0]) && els.sbHomeScore._t !== undefined) bump(els.sbHomeScore);
    if (els.sbAwayScore._t !== String(sc[1]) && els.sbAwayScore._t !== undefined) bump(els.sbAwayScore);
    setText(els.sbHomeScore, sc[0]);
    setText(els.sbAwayScore, sc[1]);
    const scored = f.now < S.scoredUntil ? S.scoredSide : -1;
    setClass(els.sbHome, 'scored', scored === 0);
    setClass(els.sbAway, 'scored', scored === 1);
    const periods = (f.lobby && f.lobby.config && f.lobby.config.periods) || DEFAULT_CONFIG.periods;
    setText(els.sbPer, st.ph === PHASE.PERIOD_END ? 'Intermission' : st.ph === PHASE.GAME_OVER ? 'Final' : periodLabel(st.per || 1, periods));
    setText(els.sbClk, fmtClock(st.clk));
    setClass(els.sb, 'low', (st.ph === PHASE.PLAY || st.ph === PHASE.FACEOFF) && st.clk > 0 && st.clk < 10);
    setClass(els.sb, 'ot', (st.per || 1) > periods);

    const mine = f.myId ? (st.p || []).find((p) => p && p.c === f.myId) : null;
    setClass(els.specBar, 'hidden', !!mine || S.myTeam === 0 || S.myTeam === 1 || st.ph === PHASE.GAME_OVER);

    // faceoff plate (phase driven, yields to bigger callouts)
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
    if (over && S.finalDirty) { S.finalDirty = false; renderFinal(st, periods, f.names || {}); }
    if (!over) S.finalAt = 0;
    setClass(els.final, 'hidden', !over);
    if (over) {
      const elapsed = Math.max(0, (f.now - S.finalAt) / 1000);
      const left = Math.max(0, Math.ceil(POST_GAME_SECONDS - elapsed));
      setText(els.finCount, `Back to the lobby in ${left} s`);
      const s = `scaleX(${Math.min(1, elapsed / POST_GAME_SECONDS).toFixed(3)})`;
      if (els.finBar._tr !== s) { els.finBar._tr = s; els.finBar.style.transform = s; }
    }
  }

  function bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }

  function renderFinal(st, periods = DEFAULT_CONFIG.periods, names = {}) {
    const teams = st.teams || DEFAULT_CONFIG.teams;
    const sc = st.sc || [0, 0];
    const w = sc[0] === sc[1] ? -1 : sc[0] > sc[1] ? 0 : 1;
    const ot = (st.per || 1) > periods;
    const fill = (el, side) => {
      const T = teamT(teams[side]);
      el.setAttribute('style', tcVar(teams[side]));
      setClass(el, 'lost', w >= 0 && w !== side);
      el.querySelector('.fin-city').textContent = T.city;
      el.querySelector('.fin-name').textContent = T.name;
      el.querySelector('.fin-crest').innerHTML = crest(teams[side], 96);
    };
    fill(els.finHome, 0); fill(els.finAway, 1);
    els.finN0.textContent = sc[0]; els.finN1.textContent = sc[1];
    setClass(els.finN0, 'lost', w === 1); setClass(els.finN1, 'lost', w === 0);
    els.finChip.textContent = ot ? 'Final · OT' : 'Final';
    els.finTitle.textContent = (S.myTeam === 0 || S.myTeam === 1) && S.myTeam === w ? 'Victory' : 'Final';

    // team stats: mirrored bars, longest bar = the bigger value
    const s = S.stats;
    const rows = [['Shots', s[0].shots, s[1].shots], ['Hits', s[0].hits, s[1].hits], ['Big hits', s[0].big, s[1].big],
      ['Glass broken', s[0].glass, s[1].glass], ['Saves', s[0].saves, s[1].saves]];
    const cls = (v, o) => (v === 0 ? 'zero' : v >= o ? 'lead' : '');
    els.finStats.setAttribute('style', `--home-c:${teamText(teams[0])};--away-c:${teamText(teams[1])}`);
    els.finStats.innerHTML = `<div class="fs-head"><span class="fs-key home">${teamT(teams[0]).key}</span><span class="card-title">Team stats</span><span class="fs-key away">${teamT(teams[1]).key}</span></div>` +
      rows.map(([n, a, b]) => {
        const m = Math.max(a, b) || 1;
        return `<div class="fs-row"><div class="fs-vals"><span class="${cls(a, b)}">${a}</span><span class="fs-lbl">${n}</span><span class="${cls(b, a)}">${b}</span></div>` +
          `<div class="fs-bars"><span class="hb"><i style="width:${(a / m * 100).toFixed(1)}%"></i></span><span class="hb"><i style="width:${(b / m * 100).toFixed(1)}%"></i></span></div></div>`;
      }).join('');

    // stars of the game
    const stars = starsOfGame(S.tally);
    const rank = ['rank-1', 'rank-2', 'rank-3'];
    const line = (t) => [t.g ? `${t.g} G` : '', t.a ? `${t.a} A` : '', !t.a && t.h ? `${t.h} hit${t.h === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    let starsHTML = stars.map((t, i) => {
      const tm = teamOf(t.id);
      const nm = shortName(st, t.id, names, teams);
      const sub = t.id === S.otWinner && ot ? 'OT winner' : teamT(teams[tm]).name;
      return `<div class="star"><span class="star-rank ${rank[i]}">${i + 1}</span><span class="avatar av-md tinted" style="${tcVar(teams[tm])}">${escHtml(initial(nm))}</span>` +
        `<div class="star-who"><b>${escHtml(nm)}</b><span>${escHtml(sub)}</span></div><span class="star-line">${line(t)}</span></div>`;
    }).join('');
    if (!stars.length) starsHTML = '<div class="star-empty">No goals or hits this game</div>';
    let unlock = '';
    if (S.unlocks.length) {
      const u = S.unlocks[0];
      const more = S.unlocks.length > 1 ? ` and ${S.unlocks.length - 1} more` : '';
      const what = escHtml(sentence(u.title || u.id || 'a challenge'));
      unlock = `<div class="fin-unlock" style="--tier:var(--tier-${u.tier || 1})">${ICON.badge(14, 1.26)}<span>${u.secret ? `Secret challenge cleared: ${what}` : `You cleared ${what}`}${more}</span></div>`;
    }
    els.finStars.innerHTML = `<div class="card-title">Stars of the game</div>${starsHTML}${unlock}`;
  }

  // ---------------------------------------------------------------- main update
  function update(f) {
    S.frame = f;
    const L = f.lobby;
    const clients = (L && L.clients) || [];
    const me = clients.find((c) => c.id === f.myId);
    S.myTeam = me ? me.team : -1;
    S.isHost = !!(L && f.myId && L.host === f.myId);

    if (f.gameSerial !== S.statsSerial) {
      S.statsSerial = f.gameSerial; S.stats = freshStats(); S.tally = {}; S.unlocks = []; S.otWinner = -1; S.finalAt = 0;
    }
    if (L !== S.lastLobbyRef) { S.lastLobbyRef = L; diffClients(f); }

    const screen = L && L.state === 'game' ? 'game' : 'lobby';
    if (screen !== S.screen) {
      S.screen = screen;
      setClass(els.lobby, 'hidden', screen !== 'lobby');
      setClass(els.scrim, 'hidden', screen !== 'lobby');
      setClass(els.hud, 'hidden', screen !== 'game');
      setClass(root, 'in-game', screen === 'game');
      if (screen !== 'game') { setMenu(false); S.coUntil = 0; els.callout.className = 'callout'; }
      else { closePicker(false); hideCard(true); setInvite(false); if (isPhone() && S.mtab !== 'match') setMtab('match'); } // phones: back from a game = Match tab
      if (screen === 'game' && document.activeElement && document.activeElement !== document.body && !document.activeElement.closest('.ir-chat')) document.activeElement.blur();
      syncKeyboard();
    }
    for (const el of els.hostOnly) setClass(el, 'hidden', !S.isHost);
    for (const b of els.menuSides) {
      const on = Number(b.dataset.team) === S.myTeam || (b.dataset.team === '-1' && S.myTeam !== 0 && S.myTeam !== 1);
      setClass(b, 'on', on);
      setAttr(b, 'aria-checked', on ? 'true' : 'false');
    }

    updateConn(f);
    // the instant replay owns the screen: no scoreboard, callouts or hints over it (Replay frame)
    setClass(els.hud, 'replaying', screen === 'game' && !!f.replaying);
    if (screen === 'lobby') renderLobby(f);
    else { handleEvents(f); updateHud(f); }
    bannerTick(typeof f.now === 'number' ? f.now : performance.now());
  }

  function setChallenges(p) {
    S.challenges = p && p.total ? p : null;
    const txt = S.challenges ? `${S.challenges.done}/${S.challenges.total}` : '';
    for (const el of els.chCounts) { setText(el, txt); setClass(el, 'hidden', !txt); }
  }
  function setOffline(on) {
    S.offline = !!on;
    setClass(els.lobby, 'offline', S.offline); // phones show the "Go online" glyph only while offline
    setHTML(els.offlineIco, on ? ICON.wifi() : ICON.puck());
    setText(els.offlineTxt, on ? 'Go online' : 'Practice offline');
    setAttr(els.offlineBtn, 'aria-label', on ? 'Go online' : 'Practice offline');
    S.youKey = '';
  }

  syncSound();
  // first view: tell the host page which mount is showing
  queueMicrotask(() => showView('match', true));
  return {
    update,
    toast,
    banner,
    padNav,
    syncSound,
    showView,
    setChallenges,
    setOffline,
    /** extras: a challenge unlocked during this game (shown on the final screen). */
    noteUnlock(ch) { if (ch && S.screen === 'game') { S.unlocks.push(ch); S.finalDirty = true; } },
    /** extras: a chat line arrived (server {t:'chat'}); counts toward the phone Chat tab's unread pill. */
    noteChat(m) {
      if (!m || m.hist || !m.from || (S.frame && m.from === S.frame.myId)) return;
      if (S.screen !== 'lobby' || !isPhone() || S.mtab === 'chat') return;
      S.unread++; syncUnread();
    },
    /** Phone bottom tab: 'match' | 'chat' | 'leaders' | 'challenges'. */
    showTab(tab) { setMtab(tab); },
    get tab() { return S.mtab; },
    toggleMenu() { setMenu(!S.menuOpen); },
    closeMenu() { setMenu(false); },
    get menuOpen() { return S.menuOpen; },
    get screen() { return S.screen; },
    get view() { return S.view; },
    get name() { return els.name.value.trim(); },
    /** opts.save: also remember it for the next visit (Settings > Gameplay > Player name; not the ?name= boot value) */
    setName(n, opts) {
      if (document.activeElement !== els.name) { els.name.value = n; S.lastName = n; }
      if (opts && opts.save && n) saveName(n);
    },
  };
}
