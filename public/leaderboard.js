// ICE RIOT - leaderboard + recent games panel (self-styled: injects one <style id="ir-lb-style">).
//
//   import { createLeaderboard } from './leaderboard.js';
//   const lb = createLeaderboard(document.body);          // overlay; { inline: true } fills `container`
//   lb.open();  lb.close();  lb.refresh();  lb.dispose();
//
// Data comes from the server's GET /api/leaderboard?by=..&limit=.. and /api/recent?limit=..
// (server/stats-store.js). All user-supplied text is inserted with textContent.

import { TEAMS } from '../shared/constants.js';

const STYLE_ID = 'ir-lb-style';
const FETCH_TIMEOUT_MS = 8000;

const TABS = [
  { by: 'wins', label: 'Wins' },
  { by: 'goals', label: 'Goals' },
  { by: 'hits', label: 'Hits' },
  { by: 'glass', label: 'Glass' },
];

// Table columns; the active tab's column is highlighted. `opt` columns hide on narrow screens.
const COLS = [
  { k: 'games', label: 'GP', title: 'Games played' },
  { k: 'wins', label: 'W', title: 'Wins' },
  { k: 'goals', label: 'G', title: 'Goals' },
  { k: 'assists', label: 'A', title: 'Assists', opt: true },
  { k: 'hits', label: 'HIT', title: 'Hits' },
  { k: 'glass', label: 'GLS', title: 'Glass smashed' },
];

const ICON_REFRESH = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>';

const CSS = `
.ir-lb{--ir-ice:#7fe9ff;--ir-hot:#ff3d6e;--ir-gold:#ffd23f;--ir-orange:#ff8a1f;--ir-text:#eef6ff;--ir-dim:rgba(226,238,255,.58);--ir-faint:rgba(226,238,255,.1);
  --ir-font:"Bahnschrift Condensed","Bahnschrift SemiCondensed","Bahnschrift","Roboto Condensed","Arial Narrow","Avenir Next Condensed","Helvetica Neue",system-ui,sans-serif;
  --ir-display:Impact,"Haettenschweiler","Bahnschrift Condensed","Arial Narrow Bold","Roboto Condensed",sans-serif;
  position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;
  font-family:var(--ir-font);font-stretch:condensed;color:var(--ir-text);-webkit-font-smoothing:antialiased;line-height:1.2;text-align:left}
.ir-lb *,.ir-lb *::before,.ir-lb *::after{box-sizing:border-box}
.ir-lb[hidden]{display:none!important}
.ir-lb.ir-lb--inline{position:relative;inset:auto;z-index:auto;padding:0;width:100%;height:100%}
.ir-lb-backdrop{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 30%,rgba(10,30,60,.35),rgba(0,0,0,.72));-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.ir-lb--inline .ir-lb-backdrop{display:none}
.ir-lb-panel{position:relative;display:flex;flex-direction:column;width:min(1000px,100%);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow:hidden;
  border-radius:16px;border:1px solid rgba(127,233,255,.22);
  background:repeating-linear-gradient(-45deg,rgba(255,255,255,.016) 0 2px,transparent 2px 11px),linear-gradient(165deg,rgba(18,28,56,.94),rgba(6,9,22,.95) 60%,rgba(20,6,24,.95));
  box-shadow:0 30px 90px rgba(0,0,0,.65),0 0 0 1px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.07);
  animation:ir-lb-in .22s cubic-bezier(.2,.9,.3,1.2)}
.ir-lb--inline .ir-lb-panel{width:100%;height:100%;max-height:none;animation:none}
.ir-lb-panel::before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:linear-gradient(90deg,var(--ir-hot),var(--ir-orange) 35%,var(--ir-gold) 60%,var(--ir-ice))}
@keyframes ir-lb-in{from{transform:translateY(14px) scale(.97);opacity:0}to{transform:none;opacity:1}}
.ir-lb-head{display:flex;align-items:flex-end;gap:12px;padding:20px 22px 14px}
.ir-lb-titles{flex:1;min-width:0}
.ir-lb-kicker{display:inline-block;padding:3px 10px 2px;margin-bottom:6px;transform:skewX(-14deg);background:rgba(127,233,255,.12);border-left:3px solid var(--ir-ice);
  color:var(--ir-ice);font-size:12px;font-weight:700;letter-spacing:.32em;text-transform:uppercase}
.ir-lb-kicker>span{display:inline-block;transform:skewX(14deg)}
.ir-lb-title{margin:0;font-family:var(--ir-display);font-weight:900;font-style:italic;font-size:clamp(30px,6vw,46px);line-height:.95;letter-spacing:.03em;text-transform:uppercase;
  background:linear-gradient(180deg,#fff 8%,#ffe680 46%,var(--ir-orange) 88%);-webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 3px 0 rgba(0,0,0,.55)) drop-shadow(0 0 22px rgba(255,138,31,.3))}
.ir-lb-actions{display:flex;gap:8px}
.ir-lb-btn{display:inline-grid;place-items:center;width:40px;height:40px;padding:0;border-radius:10px;border:1px solid rgba(127,233,255,.25);
  background:rgba(255,255,255,.06);color:var(--ir-text);cursor:pointer;transition:background .15s,border-color .15s,transform .1s}
.ir-lb-btn:hover{background:rgba(127,233,255,.16);border-color:rgba(127,233,255,.6)}
.ir-lb-btn:active{transform:scale(.94)}
.ir-lb-btn:focus-visible,.ir-lb-tab:focus-visible,.ir-lb-retry:focus-visible{outline:2px solid var(--ir-gold);outline-offset:2px}
.ir-lb-btn.is-busy svg{animation:ir-lb-spin .8s linear infinite}
@keyframes ir-lb-spin{to{transform:rotate(360deg)}}
.ir-lb-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:20px;padding:0 22px 22px}
.ir-lb-col{min-height:0;display:flex;flex-direction:column}
.ir-lb-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(127,233,255,.3) transparent;padding-right:2px}
.ir-lb-tabs{display:flex;gap:6px;padding:2px 0 12px 6px;flex-wrap:wrap}
.ir-lb-tab{flex:0 0 auto;transform:skewX(-14deg);padding:8px 18px 7px;border:1px solid rgba(127,233,255,.2);border-radius:4px;background:rgba(255,255,255,.05);
  color:var(--ir-dim);font:inherit;font-size:16px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;cursor:pointer;transition:color .15s,background .15s,border-color .15s,box-shadow .15s}
.ir-lb-tab>span{display:inline-block;transform:skewX(14deg)}
.ir-lb-tab:hover{color:var(--ir-text);border-color:rgba(127,233,255,.5)}
.ir-lb-tab[aria-selected="true"]{color:#1d0e00;border-color:transparent;background:linear-gradient(180deg,#ffe680,var(--ir-orange));box-shadow:0 0 18px rgba(255,138,31,.45),inset 0 -2px 0 rgba(0,0,0,.18)}
.ir-lb-sub{display:flex;align-items:center;gap:10px;margin:2px 0 12px;font-size:16px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--ir-ice);min-height:36px}
.ir-lb-sub::after{content:"";flex:1;height:2px;background:linear-gradient(90deg,rgba(127,233,255,.5),transparent)}
.ir-lb-table{width:100%;border-collapse:separate;border-spacing:0 4px;font-variant-numeric:tabular-nums;table-layout:auto}
.ir-lb-table th{padding:0 8px 2px;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--ir-dim);text-align:right;white-space:nowrap;position:sticky;top:0;background:rgba(9,14,30,.96);z-index:1}
.ir-lb-table th.ir-lb-c-name{text-align:left}
.ir-lb-table td{padding:7px 8px;background:rgba(255,255,255,.045);font-size:17px;font-weight:700;text-align:right;white-space:nowrap;border-top:1px solid rgba(255,255,255,.04)}
.ir-lb-table td:first-child{border-radius:8px 0 0 8px;padding-left:6px;width:1%}
.ir-lb-table td:last-child{border-radius:0 8px 8px 0}
.ir-lb-table tr.is-top td{background:rgba(255,210,63,.075)}
.ir-lb-table tr.is-me td{background:rgba(127,233,255,.12);border-top-color:rgba(127,233,255,.35)}
.ir-lb-table td.ir-lb-c-name{text-align:left;width:99%;max-width:0;overflow:hidden;text-overflow:ellipsis;font-size:18px;letter-spacing:.02em}
.ir-lb-table .is-active{color:var(--ir-gold)}
.ir-lb-table td.is-active{font-family:var(--ir-display);font-weight:400;font-size:22px;text-shadow:0 0 12px rgba(255,210,63,.35)}
.ir-lb-table td.is-zero{color:rgba(226,238,255,.35)}
.ir-lb-table td.is-active.is-zero{color:rgba(255,210,63,.45)}
.ir-lb-rank{display:inline-grid;place-items:center;min-width:28px;height:26px;padding:0 4px;transform:skewX(-12deg);border-radius:4px;background:rgba(255,255,255,.08);
  font-family:var(--ir-display);font-weight:400;font-size:16px;color:var(--ir-text)}
.ir-lb-rank>span{transform:skewX(12deg)}
.ir-lb-rank.r1{background:linear-gradient(180deg,#fff1a6,#e3a800);color:#2a1a00;box-shadow:0 0 14px rgba(255,210,63,.5)}
.ir-lb-rank.r2{background:linear-gradient(180deg,#f4f7fb,#9aa7b8);color:#141a22}
.ir-lb-rank.r3{background:linear-gradient(180deg,#ffc79a,#b0622a);color:#231004}
.ir-lb-you{display:inline-block;margin-left:6px;padding:1px 5px;border-radius:3px;background:var(--ir-ice);color:#04202a;font-size:10px;letter-spacing:.12em;vertical-align:3px}
.ir-lb-games{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.ir-lb-game{position:relative;padding:8px 10px 8px 12px;border-radius:9px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.05);overflow:hidden}
.ir-lb-game::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--ir-win,#888)}
.ir-lb-team{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:8px;color:var(--ir-dim);padding:1px 0}
.ir-lb-team.is-win{color:var(--ir-text)}
.ir-lb-sw{width:18px;height:18px;border-radius:4px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.28),0 1px 2px rgba(0,0,0,.5)}
.ir-lb-tname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px;text-transform:uppercase;letter-spacing:.04em}
.ir-lb-tname .ir-lb-city{font-weight:400;opacity:.75;font-size:13px;letter-spacing:.08em}
.ir-lb-tname b{font-weight:800}
.ir-lb-score{font-family:var(--ir-display);font-size:24px;line-height:1;min-width:22px;text-align:right;font-variant-numeric:tabular-nums}
.ir-lb-team.is-win .ir-lb-score{color:var(--ir-gold);text-shadow:0 0 12px rgba(255,210,63,.35)}
.ir-lb-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;margin-top:5px;font-size:12px;color:var(--ir-dim);letter-spacing:.05em}
.ir-lb-tag{padding:1px 6px;border-radius:3px;transform:skewX(-12deg);font-weight:800;font-size:11px;letter-spacing:.14em;background:var(--ir-hot);color:#fff;box-shadow:0 0 10px rgba(255,61,110,.45)}
.ir-lb-tag.is-final{background:rgba(255,255,255,.12);color:var(--ir-dim);box-shadow:none}
.ir-lb-ago{margin-left:auto;white-space:nowrap}
.ir-lb-who{flex-basis:100%;display:flex;flex-wrap:wrap;gap:2px 10px;color:rgba(226,238,255,.75)}
.ir-lb-who span{white-space:nowrap}
.ir-lb-who i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:1px}
.ir-lb-who em{font-style:normal;color:var(--ir-dim)}
.ir-lb-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:180px;padding:24px 12px;text-align:center;border-radius:10px;
  border:1px dashed rgba(127,233,255,.22);background:rgba(255,255,255,.025)}
.ir-lb-state-big{font-family:var(--ir-display);font-style:italic;font-size:24px;letter-spacing:.06em;text-transform:uppercase;color:var(--ir-text)}
.ir-lb-state-small{font-size:14px;color:var(--ir-dim);max-width:30ch}
.ir-lb-state.is-error{border-color:rgba(255,61,110,.45);background:rgba(255,61,110,.06)}
.ir-lb-state.is-error .ir-lb-state-big{color:#ff8aa6}
.ir-lb-retry{margin-top:6px;transform:skewX(-12deg);padding:7px 18px;border:0;border-radius:4px;background:var(--ir-hot);color:#fff;font:inherit;font-weight:800;font-size:14px;letter-spacing:.16em;text-transform:uppercase;cursor:pointer;box-shadow:0 0 14px rgba(255,61,110,.4)}
.ir-lb-retry>span{display:inline-block;transform:skewX(12deg)}
.ir-lb-skel{height:40px;margin-bottom:4px;border-radius:8px;background:linear-gradient(90deg,rgba(255,255,255,.04) 20%,rgba(255,255,255,.1) 40%,rgba(255,255,255,.04) 60%) 0 0/300% 100%;animation:ir-lb-shimmer 1.2s linear infinite}
.ir-lb-skel.tall{height:72px;margin-bottom:8px}
@keyframes ir-lb-shimmer{from{background-position:100% 0}to{background-position:-50% 0}}
.ir-lb-stale{opacity:.55;transition:opacity .2s}
@media (max-width:760px){
  .ir-lb{padding:8px;align-items:stretch}
  .ir-lb-panel{max-height:calc(100vh - 16px);max-height:calc(100dvh - 16px)}
  .ir-lb-head{padding:16px 14px 10px}
  .ir-lb-body{display:block;overflow-y:auto;overscroll-behavior:contain;padding:0 14px 16px}
  .ir-lb-col+.ir-lb-col{margin-top:18px}
  .ir-lb-scroll{overflow:visible}
  .ir-lb-tab{padding:7px 12px 6px;font-size:14px;letter-spacing:.1em}
}
@media (max-width:480px){
  .ir-lb-table .ir-lb-opt{display:none}
  .ir-lb-table td{padding:6px 5px;font-size:15px}
  .ir-lb-table th{padding:0 5px 2px}
  .ir-lb-table td.ir-lb-c-name{font-size:16px}
  .ir-lb-table td.is-active{font-size:19px}
  .ir-lb-tabs{gap:4px;padding-left:4px}
  .ir-lb-tab{padding:7px 10px 6px;letter-spacing:.06em}
}
@media (prefers-reduced-motion:reduce){.ir-lb-panel,.ir-lb-skel,.ir-lb-btn.is-busy svg{animation:none}}
`;

let styleRefs = 0;

function injectStyle() {
  styleRefs++;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function releaseStyle() {
  styleRefs = Math.max(0, styleRefs - 1);
  if (styleRefs === 0) document.getElementById(STYLE_ID)?.remove();
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

const hex = (c) => '#' + ((Number(c) >>> 0) & 0xffffff).toString(16).padStart(6, '0');

function teamInfo(i) {
  const t = Number.isInteger(i) ? TEAMS[i] : undefined;
  if (!t) return { city: '', name: 'Unknown', primary: '#777777', secondary: '#333333' };
  return { city: t.city, name: t.name, primary: hex(t.colors.primary), secondary: hex(t.colors.secondary) };
}

export function formatAgo(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.round(d / 7);
  if (w < 9) return `${w}w ago`;
  return `${Math.round(d / 30)}mo ago`;
}

const n0 = (v) => (Number.isFinite(v) ? v : 0);

/**
 * createLeaderboard(container, { baseUrl = '', limit = 10, recentLimit = 8, inline = false, me })
 *   -> { open(), close(), refresh(), dispose(), isOpen }
 * `me`: the local player's name (string or () => string) to highlight their row.
 */
export function createLeaderboard(container, { baseUrl = '', limit = 10, recentLimit = 8, inline = false, me = null } = {}) {
  const host = container || document.body;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  injectStyle();

  // ---- DOM skeleton ---------------------------------------------------------------------------
  const root = el('div', 'ir-lb' + (inline ? ' ir-lb--inline' : ''));
  root.hidden = true;
  const backdrop = el('div', 'ir-lb-backdrop');
  const panel = el('section', 'ir-lb-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', inline ? 'false' : 'true');
  panel.setAttribute('aria-label', 'Leaderboard');
  panel.tabIndex = -1;

  const head = el('header', 'ir-lb-head');
  const titles = el('div', 'ir-lb-titles');
  const kicker = el('div', 'ir-lb-kicker');
  kicker.appendChild(el('span', null, 'Ice Riot'));
  titles.append(kicker, el('h2', 'ir-lb-title', 'Leaderboard'));
  const actions = el('div', 'ir-lb-actions');
  const btnRefresh = el('button', 'ir-lb-btn');
  btnRefresh.type = 'button';
  btnRefresh.title = 'Refresh';
  btnRefresh.setAttribute('aria-label', 'Refresh');
  btnRefresh.innerHTML = ICON_REFRESH;
  const btnClose = el('button', 'ir-lb-btn');
  btnClose.type = 'button';
  btnClose.title = 'Close (Esc)';
  btnClose.setAttribute('aria-label', 'Close');
  btnClose.innerHTML = ICON_CLOSE;
  actions.append(btnRefresh, btnClose);
  head.append(titles, actions);

  const body = el('div', 'ir-lb-body');
  const colBoard = el('div', 'ir-lb-col ir-lb-board');
  const tabsEl = el('div', 'ir-lb-tabs');
  tabsEl.setAttribute('role', 'tablist');
  tabsEl.setAttribute('aria-label', 'Leaderboard category');
  const tabButtons = TABS.map((t) => {
    const b = el('button', 'ir-lb-tab');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.by = t.by;
    b.appendChild(el('span', null, t.label));
    tabsEl.appendChild(b);
    return b;
  });
  const boardScroll = el('div', 'ir-lb-scroll');
  boardScroll.setAttribute('role', 'tabpanel');
  colBoard.append(tabsEl, boardScroll);

  const colRecent = el('div', 'ir-lb-col ir-lb-recent');
  const recentScroll = el('div', 'ir-lb-scroll');
  colRecent.append(el('h3', 'ir-lb-sub', 'Recent Games'), recentScroll);
  body.append(colBoard, colRecent);
  panel.append(head, body);
  root.append(backdrop, panel);
  host.appendChild(root);

  // ---- state ----------------------------------------------------------------------------------
  let disposed = false;
  let isOpen = false;
  let tab = TABS[0].by;
  const boards = {};            // by -> { rows, at }
  let recentData = null;        // { games, now, at }
  let board = { status: 'idle', error: '' };
  let recent = { status: 'idle', error: '' };
  let boardSeq = 0;
  let recentSeq = 0;
  let boardAbort = null;
  let recentAbort = null;
  let lastFocus = null;

  const myName = () => {
    try {
      const v = typeof me === 'function' ? me() : me;
      return typeof v === 'string' ? v.trim().toLowerCase() : '';
    } catch {
      return '';
    }
  };

  async function getJSON(path, controller) {
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(base + path, { cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
      let j = null;
      try { j = await r.json(); } catch { /* non-JSON */ }
      if (!r.ok || !j || j.ok === false) throw new Error(j?.error || `Server answered ${r.status}`);
      return j;
    } catch (err) {
      if (controller.signal.aborted) throw new Error('Request timed out');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function setBusy() {
    btnRefresh.classList.toggle('is-busy', board.status === 'loading' || recent.status === 'loading');
  }

  // ---- rendering ------------------------------------------------------------------------------
  function stateBox(kind, big, small, retry) {
    const box = el('div', 'ir-lb-state is-' + kind);
    box.appendChild(el('div', 'ir-lb-state-big', big));
    if (small) box.appendChild(el('div', 'ir-lb-state-small', small));
    if (retry) {
      const b = el('button', 'ir-lb-retry');
      b.type = 'button';
      b.appendChild(el('span', null, 'Retry'));
      b.addEventListener('click', retry);
      box.appendChild(b);
    }
    if (kind === 'error') box.setAttribute('role', 'alert');
    return box;
  }

  function skeleton(n, tall) {
    const f = document.createDocumentFragment();
    for (let i = 0; i < n; i++) f.appendChild(el('div', 'ir-lb-skel' + (tall ? ' tall' : '')));
    return f;
  }

  function renderTabs() {
    for (const b of tabButtons) {
      const on = b.dataset.by === tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }

  function renderBoard() {
    renderTabs();
    const cached = boards[tab];
    boardScroll.replaceChildren();
    if (!cached) {
      if (board.status === 'error') {
        boardScroll.appendChild(stateBox('error', 'Stats offline', board.error || 'Could not reach the server.', () => loadBoard(tab)));
      } else {
        boardScroll.appendChild(skeleton(6, false));
      }
      return;
    }
    if (!cached.rows.length) {
      boardScroll.appendChild(stateBox('empty', 'No stats yet', 'Finish a game to put your name on the board.'));
      return;
    }
    const table = el('table', 'ir-lb-table');
    if (board.status === 'loading') table.classList.add('ir-lb-stale');
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', null, '#'), el('th', 'ir-lb-c-name', 'Player'));
    for (const c of COLS) {
      const th = el('th', (c.opt ? 'ir-lb-opt' : '') + (c.k === tab ? ' is-active' : ''), c.label);
      th.title = c.title;
      th.scope = 'col';
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const tbody = el('tbody');
    const mine = myName();
    cached.rows.forEach((r, i) => {
      const rank = Number.isInteger(r.rank) ? r.rank : i + 1;
      const tr = el('tr');
      if (rank === 1) tr.classList.add('is-top');
      const tdRank = el('td');
      const chip = el('span', 'ir-lb-rank' + (rank <= 3 ? ' r' + rank : ''));
      chip.appendChild(el('span', null, rank));
      tdRank.appendChild(chip);
      const tdName = el('td', 'ir-lb-c-name', r.name || '?');
      tdName.title = r.name || '';
      if (mine && String(r.name || '').toLowerCase() === mine) {
        tr.classList.add('is-me');
        tdName.appendChild(el('span', 'ir-lb-you', 'YOU'));
      }
      tr.append(tdRank, tdName);
      for (const c of COLS) {
        const v = n0(r[c.k]);
        const td = el('td', (c.opt ? 'ir-lb-opt' : '') + (c.k === tab ? ' is-active' : '') + (v === 0 ? ' is-zero' : ''), v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    boardScroll.appendChild(table);
  }

  function renderRecent() {
    recentScroll.replaceChildren();
    if (!recentData) {
      if (recent.status === 'error') {
        recentScroll.appendChild(stateBox('error', 'Stats offline', recent.error || 'Could not reach the server.', () => loadRecent()));
      } else {
        recentScroll.appendChild(skeleton(4, true));
      }
      return;
    }
    const games = recentData.games;
    if (!games.length) {
      recentScroll.appendChild(stateBox('empty', 'No games yet', 'Results show up here after the final horn.'));
      return;
    }
    const list = el('ol', 'ir-lb-games');
    if (recent.status === 'loading') list.classList.add('ir-lb-stale');
    const skew = Date.now() - recentData.at;  // time since fetch, added to server-relative ages
    for (const g of games) {
      const teams = Array.isArray(g.teams) ? g.teams : [0, 1];
      const score = Array.isArray(g.score) ? g.score : [0, 0];
      const winner = g.winner === 0 || g.winner === 1 ? g.winner : -1;
      const li = el('li', 'ir-lb-game');
      const infos = [teamInfo(teams[0]), teamInfo(teams[1])];
      li.style.setProperty('--ir-win', winner === -1 ? '#888' : infos[winner].primary);
      for (let s = 0; s < 2; s++) {
        const t = infos[s];
        const row = el('div', 'ir-lb-team' + (winner === s ? ' is-win' : ''));
        const sw = el('span', 'ir-lb-sw');
        sw.style.background = `linear-gradient(135deg, ${t.primary} 0 52%, ${t.secondary} 52% 100%)`;
        const nm = el('span', 'ir-lb-tname');
        if (t.city) {
          nm.appendChild(el('span', 'ir-lb-city', t.city));
          nm.appendChild(document.createTextNode(' '));
        }
        nm.appendChild(el('b', null, t.name));
        nm.title = `${t.city} ${t.name}`.trim();
        row.append(sw, nm, el('span', 'ir-lb-score', n0(score[s])));
        li.appendChild(row);
      }
      const meta = el('div', 'ir-lb-meta');
      if (g.ot) meta.appendChild(el('span', 'ir-lb-tag', 'OT'));
      else meta.appendChild(el('span', 'ir-lb-tag is-final', 'Final'));
      const ago = el('span', 'ir-lb-ago', formatAgo(n0(recentData.now) - n0(g.endedAt) + skew));
      if (Number.isFinite(g.endedAt)) ago.title = new Date(g.endedAt).toLocaleString();
      meta.appendChild(ago);
      const players = Array.isArray(g.players) ? g.players.slice(0, 6) : [];
      if (players.length) {
        const who = el('div', 'ir-lb-who');
        for (const p of players) {
          const s = el('span');
          const dot = el('i');
          dot.style.background = infos[p.team === 1 ? 1 : 0].primary;
          s.append(dot, document.createTextNode(p.name || '?'));
          const bits = [];
          if (n0(p.goals)) bits.push(`${p.goals}G`);
          if (n0(p.assists)) bits.push(`${p.assists}A`);
          if (n0(p.hits)) bits.push(`${p.hits}H`);
          if (bits.length) s.appendChild(el('em', null, ' ' + bits.join(' ')));
          who.appendChild(s);
        }
        meta.appendChild(who);
      }
      li.appendChild(meta);
      list.appendChild(li);
    }
    recentScroll.appendChild(list);
  }

  // ---- loading --------------------------------------------------------------------------------
  async function loadBoard(by = tab) {
    if (disposed) return;
    const seq = ++boardSeq;
    boardAbort?.abort();
    const ctrl = (boardAbort = new AbortController());
    board = { status: 'loading', error: '' };
    renderBoard();
    setBusy();
    try {
      const j = await getJSON(`/api/leaderboard?by=${encodeURIComponent(by)}&limit=${encodeURIComponent(limit)}`, ctrl);
      if (seq !== boardSeq || disposed) return;
      boards[by] = { rows: Array.isArray(j.rows) ? j.rows : [], at: Date.now() };
      board = { status: 'ok', error: '' };
    } catch (err) {
      if (seq !== boardSeq || disposed) return;
      board = { status: 'error', error: err?.message || String(err) };
      delete boards[by];
    }
    if (by === tab) renderBoard();
    setBusy();
  }

  async function loadRecent() {
    if (disposed) return;
    const seq = ++recentSeq;
    recentAbort?.abort();
    const ctrl = (recentAbort = new AbortController());
    recent = { status: 'loading', error: '' };
    renderRecent();
    setBusy();
    try {
      const j = await getJSON(`/api/recent?limit=${encodeURIComponent(recentLimit)}`, ctrl);
      if (seq !== recentSeq || disposed) return;
      recentData = { games: Array.isArray(j.games) ? j.games : [], now: n0(j.now) || Date.now(), at: Date.now() };
      recent = { status: 'ok', error: '' };
    } catch (err) {
      if (seq !== recentSeq || disposed) return;
      recent = { status: 'error', error: err?.message || String(err) };
      recentData = null;
    }
    renderRecent();
    setBusy();
  }

  function selectTab(by, focus = false) {
    if (!TABS.some((t) => t.by === by)) return;
    tab = by;
    renderBoard();
    if (focus) tabButtons.find((b) => b.dataset.by === by)?.focus();
    loadBoard(by);
  }

  // ---- events ---------------------------------------------------------------------------------
  const onTabClick = (e) => {
    const b = e.target.closest('.ir-lb-tab');
    if (b) selectTab(b.dataset.by);
  };
  const onTabKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = TABS.findIndex((t) => t.by === tab);
    const j = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    e.preventDefault();
    selectTab(TABS[j].by, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  tabsEl.addEventListener('click', onTabClick);
  tabsEl.addEventListener('keydown', onTabKey);
  btnClose.addEventListener('click', () => close());
  btnRefresh.addEventListener('click', () => refresh());
  backdrop.addEventListener('click', () => close());

  // ---- API ------------------------------------------------------------------------------------
  function open() {
    if (disposed) return;
    if (!isOpen) {
      isOpen = true;
      lastFocus = document.activeElement;
      root.hidden = false;
      document.addEventListener('keydown', onKey, true);
      renderBoard();
      renderRecent();
      try { panel.focus({ preventScroll: true }); } catch { /* old browsers */ }
    }
    return refresh();
  }

  function close() {
    if (disposed || !isOpen) return;
    isOpen = false;
    root.hidden = true;
    document.removeEventListener('keydown', onKey, true);
    boardAbort?.abort();
    recentAbort?.abort();
    boardSeq++;
    recentSeq++;
    board = { status: boards[tab] ? 'ok' : 'idle', error: '' };
    recent = { status: recentData ? 'ok' : 'idle', error: '' };
    setBusy();
    if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) {
      try { lastFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    lastFocus = null;
  }

  function refresh() {
    if (disposed) return Promise.resolve();
    return Promise.all([loadBoard(tab), loadRecent()]).then(() => undefined);
  }

  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    boardAbort?.abort();
    recentAbort?.abort();
    root.remove();
    releaseStyle();
  }

  renderTabs();
  return {
    open,
    close,
    refresh,
    dispose,
    get isOpen() { return isOpen; },
  };
}
