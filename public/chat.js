// ICE RIOT - chat UI (browser). Lobby rail chat + compact in-game feed with quick lines.
// Imports nothing and touches no DOM at import time, so Node can load it (test/chat.test.js).
//
// PROTOCOL EXTENSION (on top of docs/CONTRACT.md; server half in server/chat.js)
//
//   client -> server
//     {t:'chat',  text}   free text, <= 120 chars (the server sanitizes + rate limits again)
//     {t:'emote', id}     quick line, id = index into QUICK_CHAT (same list as server/chat.js)
//
//   server -> clients
//     {t:'chat', from, name, team, text, emote, ts}
//        from: sender clientId (0 / missing = system line), team: 0 home / 1 away / -1 spectator,
//        text: plain text (rendered with textContent only - never parsed as HTML),
//        emote: QUICK_CHAT index or null, ts: server Date.now() ms.
//        Optional `hist: true` = replayed history (sent on join): logged, but not popped into the
//        in-game feed. Duplicates (same from/ts/emote/text, e.g. history replayed after a
//        reconnect) are dropped.
//
// API
//   const chat = createChat(container, { send, myId = 0, gameContainer, onTyping })
//     container     element the lobby chat fills (100% of its width and height; the lobby rail
//                   sizes it and the log scrolls inside)
//     send(obj)     called with {t:'chat', text} / {t:'emote', id}
//     gameContainer optional: in-game the root is moved here (default: stays in `container`).
//                   In-game the root is position:fixed bottom-left, so either works as long as
//                   the element is not display:none during the game.
//     onTyping(on)  optional: called when isTyping() flips (e.g. input.clear() on true)
//   chat.receive(msg)            render one server {t:'chat'} message (anything else is ignored)
//   chat.setMyId(id)             marks your own lines (.ir-chat-line--me)
//   chat.setInGame(bool)         false = lobby rail chat, true = in-game fading feed
//   chat.setTeamColors([h, a])   name colours, hex ints (0xff6a13) or '#rrggbb'; dark ones are lifted
//   chat.isTyping()              true while the chat input has the keyboard -> game must ignore keys
//   chat.open() / chat.close()   in-game: show / hide the chat panel; lobby: focus / blur the input
//   chat.sendQuick(id)           send QUICK_CHAT[id] (honours the 2 s cooldown); returns bool
//   chat.dispose()
//
// Keys (window keydown, ignored while any text field has focus):
//   lobby    T          focus the input (not while a dialog / sheet is open or the chat is hidden)
//   in-game  Enter / T  open the panel   Esc  close   Enter  send (empty = just close)
//            1..8       quick line (2 s client-side cooldown, the chips dim meanwhile)
// Keydown inside the input never propagates (game handlers can't see it). Keyup is left alone
// on purpose so a movement key held when the input opened is still released in input.js.
// In-game, mouse/pointer downs on the chat (hint, panel) do not bubble past the chat root, so a
// click on it is not also a "Mouse0" shot for window-level input handlers.
// The in-game "Chat" toggle button is for touch screens only ("HUD · play" draws just the feed on
// desktop, where T / Enter open the panel and the lobby chat head shows the T hint).
//
// Look: design tokens (--ground, --surface-2, --ink ...) with fallbacks, so it also renders on
// pages without style.css. CSS knobs on the root / any ancestor: --ir-chat-lift (extra in-game
// bottom offset on top of the 20px margin, default 0px), --ir-chat-z (in-game z-index, default 40).

export const QUICK_CHAT = Object.freeze([
  'Nice!',
  'Pass it!',
  'Shoot!',
  'My bad',
  'What a hit!',
  'GG',
  'Rematch?',
  'On fire!',
]);

export const CHAT_MAX_LEN = 120;
export const EMOTE_COOLDOWN_MS = 2000;
export const FEED_MS = 8000;   // how long a line stays visible in the closed in-game feed
// Default name colours = TEAMS[0] / TEAMS[1] primaries in shared/constants.js (test checks it).
export const DEFAULT_TEAM_COLORS = Object.freeze(['#ff6a13', '#7fd3ff']);

const MAX_LINES = 120;         // DOM cap for the log
const SEEN_CAP = 300;          // de-dup window
const CLOSE_MS = 120;          // in-game panel exit
const STYLE_ID = 'ir-chat-style';
let styleRefs = 0;

const CSS = `
.ir-chat{--irc-ground:var(--ground,#0A0F1C);--irc-s2:var(--surface-2,#172034);--irc-s3:var(--surface-3,#1E2940);
  --irc-line:var(--hairline,#253049);--irc-line2:var(--hairline-strong,#34425F);--irc-ink:var(--ink,#E8EDF5);
  --irc-ink2:var(--ink-2,#A1ACC0);--irc-ink3:var(--ink-3,#6A7590);--irc-focus:var(--focus,#E8EDF5);
  --ir-chat-home:${DEFAULT_TEAM_COLORS[0]};--ir-chat-away:${DEFAULT_TEAM_COLORS[1]};--ir-chat-spec:var(--irc-ink2);
  font-family:var(--f-ui,Bahnschrift,"DIN Alternate","Segoe UI",sans-serif);font-size:13px;line-height:18px;
  font-weight:400;color:var(--irc-ink);box-sizing:border-box;-webkit-text-size-adjust:100%;text-size-adjust:100%}
.ir-chat *,.ir-chat *::before,.ir-chat *::after{box-sizing:border-box}
.ir-chat :focus-visible{outline:2px solid var(--irc-focus);outline-offset:2px}
.ir-chat--lobby{display:flex;flex-direction:column;gap:12px;width:100%;height:100%;min-height:160px}
.ir-chat-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:18px}
.ir-chat-title{font-size:13px;line-height:16px;color:var(--irc-ink)}
.ir-chat-hint{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:14px;color:var(--irc-ink3);
  white-space:nowrap}
.ir-chat-cap{display:inline-flex;align-items:center;justify-content:center;height:18px;min-width:16px;padding:0 5px;
  border-radius:4px;background:var(--irc-s3);color:var(--irc-ink2);font-family:inherit;font-size:11px;line-height:13px;
  font-weight:400;font-style:normal}
.ir-chat-log{flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;display:flex;flex-direction:column;gap:12px;
  overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--irc-line2) transparent}
.ir-chat-log>:first-child{margin-top:auto}
.ir-chat-empty{font-size:12px;line-height:14px;color:var(--irc-ink3)}
.ir-chat-line{display:flex;flex-direction:column;gap:2px;min-width:0}
.ir-chat-line--new{animation:ir-chat-in .18s ease-out}
.ir-chat-meta{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:12px;line-height:14px}
.ir-chat-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ir-chat-spec)}
.ir-chat-name--home{color:var(--ir-chat-home)}
.ir-chat-name--away{color:var(--ir-chat-away)}
.ir-chat-time{flex:none;color:var(--irc-ink3);font-variant-numeric:tabular-nums}
.ir-chat-text{min-width:0;font-size:13px;line-height:18px;color:var(--irc-ink);overflow-wrap:anywhere}
.ir-chat-line--sys .ir-chat-text{font-size:12px;line-height:14px;color:var(--irc-ink3)}
.ir-chat-quick{flex:none;display:flex;flex-wrap:wrap;gap:4px}
.ir-chat-chip{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;gap:5px;height:26px;margin:0;
  padding:0 9px;border:0;border-radius:6px;background:var(--irc-s2);color:var(--irc-ink2);font:inherit;font-size:12px;
  line-height:14px;white-space:nowrap;cursor:pointer;transition:background-color .12s ease-out,color .12s ease-out,opacity .16s ease-out}
.ir-chat-chip:hover{background:var(--irc-s3);color:var(--irc-ink)}
.ir-chat-num{display:none}
.ir-chat--cooldown .ir-chat-chip{opacity:.4;cursor:default}
.ir-chat--cooldown .ir-chat-chip:hover{background:var(--irc-s2);color:var(--irc-ink2)}
.ir-chat-row{flex:none;position:relative;display:flex}
.ir-chat-input{flex:1 1 auto;min-width:0;height:38px;margin:0;padding:0 12px;border:1px solid var(--irc-line);
  border-radius:10px;background:var(--irc-ground);color:var(--irc-ink);font:inherit;font-size:13px;line-height:16px;
  outline:none;transition:border-color .12s ease-out}
.ir-chat-input::placeholder{color:var(--irc-ink3);opacity:1}
.ir-chat-input:focus,.ir-chat .ir-chat-input:focus-visible{border-color:var(--irc-focus);outline:none}
.ir-chat-keys,.ir-chat-toggle{display:none}
.ir-chat--game{position:fixed;left:calc(20px + env(safe-area-inset-left,0px));
  bottom:calc(20px + var(--ir-chat-lift,0px) + env(safe-area-inset-bottom,0px));z-index:var(--ir-chat-z,40);
  width:min(360px,calc(100vw - 40px));display:flex;flex-direction:column;align-items:flex-start;gap:8px;pointer-events:none}
.ir-chat--game .ir-chat-head,.ir-chat--game .ir-chat-quick,.ir-chat--game .ir-chat-row,.ir-chat--game .ir-chat-empty{display:none}
.ir-chat--game .ir-chat-log{flex:none;width:100%;overflow:hidden;gap:4px;align-items:flex-start}
.ir-chat--game .ir-chat-line{flex-direction:row;align-items:baseline;gap:8px;max-width:100%;padding:5px 10px;border-radius:6px;
  background:rgba(10,15,28,.8);background:color-mix(in srgb,var(--irc-ground) 80%,transparent);transition:opacity .12s ease-out}
.ir-chat--game .ir-chat-meta{flex:none;max-width:180px;font-size:13px;line-height:16px}
.ir-chat--game .ir-chat-time{display:none}
.ir-chat--game .ir-chat-text,.ir-chat--game .ir-chat-line--sys .ir-chat-text{font-size:13px;line-height:16px}
.ir-chat--game .ir-chat-line--sys .ir-chat-text{color:var(--irc-ink2)}
.ir-chat--game:not(.ir-chat--panel) .ir-chat-line--faded{opacity:0}
.ir-chat--game:not(.ir-chat--panel) .ir-chat-line:nth-last-child(n+7){display:none}
.ir-chat--game .ir-chat-toggle{display:inline-flex;align-items:center;gap:8px;height:28px;margin:0;padding:0 10px 0 4px;
  border:0;border-radius:6px;background:rgba(10,15,28,.72);background:color-mix(in srgb,var(--irc-ground) 72%,transparent);
  color:var(--irc-ink2);font:inherit;font-size:12px;line-height:14px;white-space:nowrap;cursor:pointer;pointer-events:auto;
  transition:color .12s ease-out}
.ir-chat--game .ir-chat-toggle:hover{color:var(--irc-ink)}
.ir-chat-toggle .ir-chat-cap{height:20px;padding:0 6px;color:var(--irc-ink);font-weight:600}
.ir-chat--game.ir-chat--panel{width:min(400px,calc(100vw - 40px));align-items:stretch;gap:10px;padding:12px;
  border:1px solid var(--irc-line2);border-radius:16px;background:rgba(10,15,28,.94);
  background:color-mix(in srgb,var(--irc-ground) 94%,transparent);pointer-events:auto}
.ir-chat--game.ir-chat--panel .ir-chat-quick,.ir-chat--game.ir-chat--panel .ir-chat-row{display:flex}
.ir-chat--game.ir-chat--panel .ir-chat-toggle{display:none}
.ir-chat--game.ir-chat--panel .ir-chat-log{max-height:min(28vh,200px);overflow-y:auto;gap:6px;align-items:stretch}
.ir-chat--game.ir-chat--panel .ir-chat-line{padding:0;border-radius:0;background:none}
.ir-chat--game .ir-chat-chip{padding:0 8px 0 4px}
.ir-chat--game .ir-chat-num{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;
  border-radius:4px;background:var(--irc-s3);color:var(--irc-ink);font-size:11px;line-height:13px}
.ir-chat--game .ir-chat-input{height:36px;padding-right:156px}
.ir-chat--game.ir-chat--panel .ir-chat-input{border-color:var(--irc-focus)}
.ir-chat--game .ir-chat-keys{display:block;position:absolute;right:12px;top:50%;transform:translateY(-50%);
  font-size:12px;line-height:14px;color:var(--irc-ink3);white-space:nowrap;pointer-events:none}
.ir-chat--open{animation:ir-chat-pop .18s ease-out}
.ir-chat--closing{animation:ir-chat-out .12s ease-out forwards;pointer-events:none!important}
@keyframes ir-chat-in{from{opacity:0;transform:translateY(4px)}}
@keyframes ir-chat-pop{from{opacity:0;transform:translateY(6px)}}
@keyframes ir-chat-out{to{opacity:0;transform:translateY(4px)}}
.ir-chat-count,.ir-chat-send{display:none}
@media (max-width:360px){.ir-chat--game .ir-chat-keys{display:none}.ir-chat--game .ir-chat-input{padding-right:12px}}
@media (max-width:600px),(orientation:portrait) and (pointer:coarse){
  .ir-chat--lobby{gap:0;min-height:0}
  .ir-chat--lobby .ir-chat-log{padding:12px 16px}
  .ir-chat--lobby .ir-chat-quick{flex-wrap:nowrap;gap:6px;height:44px;padding:4px 16px;overflow-x:auto;overflow-y:hidden;
    scrollbar-width:none;overscroll-behavior-x:contain}
  .ir-chat--lobby .ir-chat-quick::-webkit-scrollbar{display:none}
  .ir-chat--lobby .ir-chat-chip{flex:none;height:36px;padding:0 12px;border:1px solid var(--irc-line);border-radius:10px;
    font-size:13px;line-height:16px}
  .ir-chat--lobby .ir-chat-row{align-items:center;gap:8px;padding:6px 16px 10px}
  .ir-chat--lobby .ir-chat-input{height:44px;padding:0 14px;border-color:var(--irc-line2);font-size:15px;line-height:18px}
  .ir-chat--lobby.ir-chat--has-text .ir-chat-input{padding-right:64px}
  .ir-chat--lobby.ir-chat--has-text .ir-chat-count{display:block;position:absolute;right:82px;top:50%;transform:translateY(-50%);
    font-size:12px;line-height:14px;color:var(--irc-ink3);font-variant-numeric:tabular-nums;pointer-events:none}
  .ir-chat--lobby .ir-chat-send{flex:none;display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0;
    padding:0;border:0;border-radius:10px;background:var(--irc-s3);color:var(--irc-ink3);cursor:pointer;
    transition:background-color .12s ease-out,color .12s ease-out}
  .ir-chat--lobby.ir-chat--has-text .ir-chat-send{background:var(--ice,#DCEAF6);color:var(--on-ice,#0A0F1C)}
}
@media (pointer:coarse){.ir-chat-input{font-size:16px}}
@media (hover:hover) and (pointer:fine){.ir-chat--game .ir-chat-toggle{display:none}}
@media (hover:none) and (pointer:coarse){.ir-chat-hint,.ir-chat-toggle .ir-chat-cap,.ir-chat-toggle-keys,.ir-chat--game .ir-chat-keys{display:none}
  .ir-chat--game .ir-chat-toggle{padding:0 10px}.ir-chat--game .ir-chat-input{padding-right:12px}}
@media (prefers-reduced-motion:reduce){.ir-chat,.ir-chat *{animation:none!important;transition:none!important}}
`;

function injectStyle() {
  styleRefs++;
  if (document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

function releaseStyle() {
  styleRefs = Math.max(0, styleRefs - 1);
  if (!styleRefs) document.getElementById(STYLE_ID)?.remove();
}

function isTypingTarget(node) {
  if (!node || node === document.body || !node.tagName) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!node.isContentEditable;
}

function reducedMotion() {
  try { return !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// 0xff6a13 | '#ff6a13' | '#f61' | 'ff6a13' -> '#rrggbb' lifted to a readable luminance on dark ground.
export function nameColor(c, fallback) {
  let hex = null;
  if (typeof c === 'number' && Number.isFinite(c)) hex = (c & 0xffffff).toString(16).padStart(6, '0');
  else if (typeof c === 'string') {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
    if (m) hex = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  }
  if (!hex) return fallback;
  const n = parseInt(hex, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const MIN = 0.42;
  if (lum < MIN) {
    const k = (MIN - lum) / (1 - lum); // mix toward white
    r = Math.round(r + (255 - r) * k);
    g = Math.round(g + (255 - g) * k);
    b = Math.round(b + (255 - b) * k);
  }
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

const pad2 = (n) => String(n).padStart(2, '0');
/** Server ms timestamp -> local "HH:MM" ('' for anything that is not a plausible epoch ms). */
export function formatTime(ts) {
  if (typeof ts !== 'number' || !(ts > 1e12)) return '';
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const clampText = (s) => Array.from(String(s).replace(/\s+/g, ' ').trim()).slice(0, CHAT_MAX_LEN).join('').trim();
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export function createChat(container, { send, myId = 0, gameContainer = null, onTyping = null } = {}) {
  const home = container || document.body;
  injectStyle();

  let me = Number(myId) || 0;
  let inGame = false;
  let isOpen = false;          // in-game panel open (input has the keyboard)
  let disposed = false;
  let lastEmoteAt = -Infinity;
  let cooldownTimer = 0;
  let closeTimer = 0;
  let fadeTimer = 0;
  let typingWas = false;
  const pending = [];          // in-game feed lines not faded yet: [{line, born}] (born ascending)
  const seen = new Set();
  const seenOrder = [];

  // ---- DOM ---------------------------------------------------------------------------------
  const root = el('div', 'ir-chat ir-chat--lobby');
  const head = el('div', 'ir-chat-head');
  const hint = el('span', 'ir-chat-hint');
  hint.append(el('kbd', 'ir-chat-cap', 'T'), document.createTextNode('to type'));
  head.append(el('span', 'ir-chat-title', 'Chat'), hint);
  const log = el('div', 'ir-chat-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-label', 'Chat messages');
  let emptyNote = el('div', 'ir-chat-empty', 'No messages yet. Say hi.');
  log.appendChild(emptyNote);
  const quick = el('div', 'ir-chat-quick');
  quick.setAttribute('role', 'group');
  quick.setAttribute('aria-label', 'Quick lines');
  QUICK_CHAT.forEach((label, i) => {
    const b = el('button', 'ir-chat-chip');
    b.type = 'button';
    b.dataset.id = String(i);
    const num = el('span', 'ir-chat-num', String(i + 1));
    num.setAttribute('aria-hidden', 'true');
    b.append(num, el('span', 'ir-chat-chip-label', label));
    quick.appendChild(b);
  });
  const row = el('div', 'ir-chat-row');
  const input = el('input', 'ir-chat-input');
  input.type = 'text';
  input.maxLength = CHAT_MAX_LEN;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Say something';
  input.setAttribute('aria-label', 'Chat message');
  input.setAttribute('enterkeyhint', 'send');
  input.setAttribute('autocapitalize', 'sentences');
  const keys = el('span', 'ir-chat-keys', 'Enter sends \u00b7 Esc closes');
  keys.setAttribute('aria-hidden', 'true');
  // Phone portrait (the lobby's Chat tab, "Final · mobile"): a 44x44 send button and an n/120 count.
  const count = el('span', 'ir-chat-count');
  count.setAttribute('aria-hidden', 'true');
  const sendBtn = el('button', 'ir-chat-send');
  sendBtn.type = 'button';
  sendBtn.setAttribute('aria-label', 'Send');
  sendBtn.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  row.append(input, keys, count, sendBtn);
  const toggle = el('button', 'ir-chat-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Open chat (T), quick lines 1 to 8');
  const toggleLabel = el('span', 'ir-chat-toggle-label', 'Chat');
  toggleLabel.appendChild(el('span', 'ir-chat-toggle-keys', ' \u00b7 1-8 quick'));
  toggle.append(el('kbd', 'ir-chat-cap', 'T'), toggleLabel);
  root.append(head, log, quick, row, toggle);
  home.appendChild(root);

  // ---- typing state --------------------------------------------------------------------------
  function isTyping() {
    if (disposed) return false;
    return inGame ? isOpen : document.activeElement === input;
  }
  function syncTyping() {
    const now = isTyping();
    if (now === typingWas) return;
    typingWas = now;
    if (typeof onTyping === 'function') {
      try { onTyping(now); } catch (e) { console.error(e); }
    }
  }

  function scrollToEnd() { log.scrollTop = log.scrollHeight; }

  // In-game panel: .ir-chat--panel = the panel look, .ir-chat--open = open (enter animation),
  // .ir-chat--closing = the short exit before the feed comes back.
  function showPanel() {
    clearTimeout(closeTimer);
    closeTimer = 0;
    isOpen = true;
    root.classList.remove('ir-chat--closing');
    root.classList.add('ir-chat--panel', 'ir-chat--open');
    scrollToEnd();
  }
  function hidePanel() {
    isOpen = false; // before any blur() so the blur handler doesn't re-enter
    root.classList.remove('ir-chat--open');
    if (!root.classList.contains('ir-chat--panel') || root.classList.contains('ir-chat--closing')) return;
    if (reducedMotion()) { root.classList.remove('ir-chat--panel'); return; }
    root.classList.add('ir-chat--closing');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = 0;
      root.classList.remove('ir-chat--panel', 'ir-chat--closing');
    }, CLOSE_MS);
  }

  function open() {
    if (disposed) return;
    if (inGame) showPanel();
    input.focus({ preventScroll: true });
    syncTyping();
  }

  function close() {
    if (disposed) return;
    if (inGame) hidePanel();
    if (document.activeElement === input) input.blur();
    syncTyping();
  }

  function submit() {
    const text = clampText(input.value);
    input.value = '';
    root.classList.remove('ir-chat--has-text');
    if (text && typeof send === 'function') send({ t: 'chat', text });
    if (inGame) close();
  }

  function sendQuick(id) {
    if (disposed || !Number.isInteger(id) || id < 0 || id >= QUICK_CHAT.length) return false;
    const now = performance.now();
    if (now - lastEmoteAt < EMOTE_COOLDOWN_MS) return false;
    lastEmoteAt = now;
    if (typeof send === 'function') send({ t: 'emote', id });
    root.classList.add('ir-chat--cooldown');
    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => root.classList.remove('ir-chat--cooldown'), EMOTE_COOLDOWN_MS);
    return true;
  }

  // ---- events --------------------------------------------------------------------------------
  function isShown() {
    return root.isConnected && root.getClientRects().length > 0;
  }
  // A sheet / dialog owns the keyboard (settings, leaderboard fallback, challenges panel ...).
  function overlayOpen(target) {
    if (target && target !== document.body && typeof target.closest === 'function'
      && target.closest('[role="dialog"],[aria-modal="true"],dialog')) return true;
    for (const d of document.querySelectorAll('[aria-modal="true"],dialog[open]')) {
      if (!root.contains(d) && d.getClientRects().length > 0) return true;
    }
    return false;
  }

  function onInputKeyDown(e) {
    e.stopPropagation(); // game / app key handlers never see keys typed into the chat
    if (e.isComposing || e.keyCode === 229) return; // IME composition
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.value = '';
      close();
    }
  }
  function onInputFocus() { syncTyping(); }
  function onInputBlur() {
    // Clicked away in-game -> close. Ignore blur caused by the whole window losing focus (alt-tab).
    if (inGame && isOpen && document.hasFocus()) hidePanel();
    syncTyping();
  }
  function onWindowKeyDown(e) {
    if (disposed || isOpen) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    const code = e.code;
    if (!inGame) {
      if (code !== 'KeyT' || !isShown() || overlayOpen(e.target)) return;
      e.preventDefault(); // keeps the 't' out of the input we're about to focus
      if (!e.repeat) open();
      return;
    }
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'KeyT') {
      e.preventDefault(); // also keeps the 't' out of the input we're about to focus
      if (!e.repeat) open();
      return;
    }
    const m = /^(?:Digit|Numpad)([1-8])$/.exec(code);
    if (m) {
      e.preventDefault();
      if (!e.repeat) sendQuick(Number(m[1]) - 1);
    }
  }
  // Keep focus in the input when tapping chips (in-game: anywhere in the open panel), otherwise
  // the blur would close the in-game panel before the click lands. In-game, presses on the chat
  // stop here so window-level mouse bindings (Mouse0 = shoot) don't fire through it.
  function onRootPointerDown(e) {
    if (inGame) e.stopPropagation();
    if (e.target === input || document.activeElement !== input) return;
    if (inGame || e.target.closest('.ir-chat-chip')) e.preventDefault();
  }
  function onRootMouseDown(e) {
    if (inGame) e.stopPropagation();
  }
  function onQuickClick(e) {
    const chip = e.target.closest('.ir-chat-chip');
    if (!chip) return;
    sendQuick(Number(chip.dataset.id));
    if (inGame) close();
  }
  function onToggleClick() { open(); }
  function onInputChange() {
    const n = Array.from(input.value).length;
    count.textContent = `${n}/${CHAT_MAX_LEN}`;
    root.classList.toggle('ir-chat--has-text', n > 0);
  }
  // keep the keyboard up: the send button never takes focus from the input
  function onSendDown(e) { e.preventDefault(); }
  function onSendClick() { submit(); onInputChange(); if (!inGame) input.focus({ preventScroll: true }); }

  input.addEventListener('keydown', onInputKeyDown);
  input.addEventListener('focus', onInputFocus);
  input.addEventListener('blur', onInputBlur);
  input.addEventListener('input', onInputChange);
  sendBtn.addEventListener('mousedown', onSendDown);
  sendBtn.addEventListener('click', onSendClick);
  root.addEventListener('pointerdown', onRootPointerDown);
  root.addEventListener('mousedown', onRootMouseDown);
  quick.addEventListener('click', onQuickClick);
  toggle.addEventListener('click', onToggleClick);
  window.addEventListener('keydown', onWindowKeyDown);

  // ---- in-game fade --------------------------------------------------------------------------
  function fadeTick() {
    const now = performance.now();
    while (pending.length && now - pending[0].born >= FEED_MS) pending.shift().line.classList.add('ir-chat-line--faded');
  }
  function fadeAll() {
    for (const line of log.querySelectorAll('.ir-chat-line')) line.classList.add('ir-chat-line--faded');
    pending.length = 0;
  }

  // ---- messages ------------------------------------------------------------------------------
  function receive(msg) {
    if (disposed || !msg || typeof msg !== 'object' || msg.t !== 'chat') return;
    const emote = Number.isInteger(msg.emote) && msg.emote >= 0 && msg.emote < QUICK_CHAT.length ? msg.emote : null;
    const text = typeof msg.text === 'string' && msg.text ? msg.text : emote !== null ? QUICK_CHAT[emote] : '';
    if (!text) return;
    const key = `${msg.from}|${msg.ts}|${emote}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    seenOrder.push(key);
    if (seenOrder.length > SEEN_CAP) seen.delete(seenOrder.shift());

    const from = Number(msg.from) || 0;
    const team = msg.team === 0 || msg.team === 1 ? msg.team : -1;
    const line = el('div', 'ir-chat-line ir-chat-line--new');
    line.dataset.from = String(from);
    if (emote !== null) line.classList.add('ir-chat-line--emote');
    if (from && from === me) line.classList.add('ir-chat-line--me');
    if (from) {
      const side = team === 0 ? 'home' : team === 1 ? 'away' : 'spec';
      const name = typeof msg.name === 'string' && msg.name ? msg.name.slice(0, 24) : `#${from}`;
      const meta = el('div', 'ir-chat-meta');
      meta.appendChild(el('span', `ir-chat-name ir-chat-name--${side}`, name));
      const time = formatTime(msg.ts);
      if (time) meta.appendChild(el('span', 'ir-chat-time', time));
      line.appendChild(meta);
    } else {
      line.classList.add('ir-chat-line--sys');
    }
    line.appendChild(el('span', 'ir-chat-text', text));
    line.addEventListener('animationend', () => line.classList.remove('ir-chat-line--new'), { once: true });

    if (emptyNote) { emptyNote.remove(); emptyNote = null; }
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    log.appendChild(line);
    const lines = log.querySelectorAll('.ir-chat-line');
    for (let i = 0; lines.length - i > MAX_LINES; i++) lines[i].remove();
    if (atEnd || (from && from === me)) scrollToEnd();

    if (inGame) {
      if (msg.hist) line.classList.add('ir-chat-line--faded');
      else pending.push({ line, born: performance.now() });
    }
  }

  function setMyId(id) {
    me = Number(id) || 0;
    for (const line of log.querySelectorAll('.ir-chat-line')) {
      const f = Number(line.dataset.from) || 0;
      line.classList.toggle('ir-chat-line--me', !!f && f === me);
    }
  }

  function setInGame(on) {
    on = !!on;
    if (disposed || on === inGame) return;
    if (document.activeElement === input) input.blur();
    inGame = on;
    isOpen = false;
    clearTimeout(closeTimer);
    closeTimer = 0;
    root.classList.toggle('ir-chat--game', on);
    root.classList.toggle('ir-chat--lobby', !on);
    root.classList.remove('ir-chat--open', 'ir-chat--panel', 'ir-chat--closing');
    const parent = on && gameContainer ? gameContainer : home;
    if (root.parentNode !== parent) parent.appendChild(root);
    clearInterval(fadeTimer);
    fadeTimer = 0;
    if (on) {
      fadeAll(); // the feed starts clean; lobby chatter stays readable when the panel opens
      fadeTimer = setInterval(fadeTick, 250);
    } else {
      scrollToEnd();
    }
    syncTyping();
  }

  function setTeamColors(colors) {
    if (!Array.isArray(colors)) return;
    root.style.setProperty('--ir-chat-home', nameColor(colors[0], DEFAULT_TEAM_COLORS[0]));
    root.style.setProperty('--ir-chat-away', nameColor(colors[1], DEFAULT_TEAM_COLORS[1]));
  }

  function dispose() {
    if (disposed) return;
    const wasTyping = typingWas;
    disposed = true;
    clearInterval(fadeTimer);
    clearTimeout(cooldownTimer);
    clearTimeout(closeTimer);
    window.removeEventListener('keydown', onWindowKeyDown);
    root.remove();
    releaseStyle();
    if (wasTyping && typeof onTyping === 'function') {
      try { onTyping(false); } catch (e) { console.error(e); }
    }
  }

  return { receive, setMyId, setInGame, setTeamColors, isTyping, open, close, sendQuick, dispose };
}
