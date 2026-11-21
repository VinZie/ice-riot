// ICE RIOT - chat UI (browser). Lobby chat box + compact in-game feed with quick-chat emotes.
// Imports nothing and touches no DOM at import time, so Node can load it (test/chat.test.js).
//
// PROTOCOL EXTENSION (on top of docs/CONTRACT.md; server half in server/chat.js)
//
//   client -> server
//     {t:'chat',  text}   free text, <= 120 chars (the server sanitizes + rate limits again)
//     {t:'emote', id}     quick chat, id = index into QUICK_CHAT (same list as server/chat.js)
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
//     container     element the lobby chat box fills (100% of its size, min 220px tall)
//     send(obj)     called with {t:'chat', text} / {t:'emote', id}
//     gameContainer optional: in-game the root is moved here (default: stays in `container`).
//                   In-game the root is position:fixed bottom-left, so either works as long as
//                   the element is not display:none during the game.
//     onTyping(on)  optional: called when isTyping() flips (e.g. input.clear() on true)
//   chat.receive(msg)            render one server {t:'chat'} message (anything else is ignored)
//   chat.setMyId(id)             highlights your own lines
//   chat.setInGame(bool)         false = lobby box, true = in-game fading feed
//   chat.setTeamColors([h, a])   name colors, hex ints (0xff6a13) or '#rrggbb'; dark ones are lifted
//   chat.isTyping()              true while the chat input has the keyboard -> game must ignore keys
//   chat.open() / chat.close()   in-game: show / hide the one-line input; lobby: focus / blur it
//   chat.sendQuick(id)           send QUICK_CHAT[id] (honours the 2 s cooldown); returns bool
//   chat.dispose()
//
// Keys (window keydown, in-game only, ignored while any text field has focus):
//   Enter / T  open the input     Esc  cancel     Enter  send (empty = just close)
//   1..8       quick chat (2 s client-side cooldown)
// Keydown inside the input never propagates (game handlers can't see it). Keyup is left alone
// on purpose so a movement key held when the input opened is still released in input.js.
// CSS knobs on the root / any ancestor: --ir-chat-bottom (in-game bottom offset, default 14px),
// --ir-chat-z (in-game z-index, default 40).

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

const FEED_MS = 8000;          // how long a line stays visible in the closed in-game feed
const MAX_LINES = 120;         // DOM cap for the log
const SEEN_CAP = 300;          // de-dup window
const DEFAULT_COLORS = ['#ff8c3a', '#5fc8ff'];
const STYLE_ID = 'ir-chat-style';
let styleRefs = 0;

const CSS = `
.ir-chat{--ir-chat-home:${DEFAULT_COLORS[0]};--ir-chat-away:${DEFAULT_COLORS[1]};--ir-chat-spec:#9aa3ad;
  --ir-chat-accent:#2de2ff;--ir-chat-hot:#ffd23f;--ir-chat-bg:rgba(8,12,28,.9);
  font-family:"Bahnschrift SemiCondensed","Bahnschrift","Roboto Condensed","Arial Narrow","Helvetica Neue",Arial,sans-serif;
  font-stretch:semi-condensed;font-size:15px;line-height:1.3;color:#eef3ff;box-sizing:border-box;
  -webkit-text-size-adjust:100%;text-size-adjust:100%}
.ir-chat *,.ir-chat *::before,.ir-chat *::after{box-sizing:border-box}
.ir-chat--lobby{display:flex;flex-direction:column;width:100%;height:100%;min-height:220px;
  background:var(--ir-chat-bg);border:2px solid var(--ir-chat-accent);border-radius:4px;overflow:hidden;
  box-shadow:0 0 0 2px rgba(0,0,0,.55),0 10px 30px rgba(0,0,0,.45),inset 0 0 28px rgba(45,226,255,.08)}
.ir-chat-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;
  background:linear-gradient(90deg,rgba(45,226,255,.24),rgba(45,226,255,0) 70%);border-bottom:1px solid rgba(45,226,255,.35)}
.ir-chat-title{font-weight:800;font-style:italic;font-size:16px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--ir-chat-hot);text-shadow:0 0 10px rgba(255,210,63,.5)}
.ir-chat-hint{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8fa3c0;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.ir-chat-log{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:6px 8px;display:flex;
  flex-direction:column;gap:2px;overscroll-behavior:contain;scrollbar-width:thin;
  scrollbar-color:rgba(45,226,255,.5) transparent}
.ir-chat-log>:first-child{margin-top:auto}
.ir-chat-empty{color:#5f7190;font-style:italic;font-size:13px;padding:2px 6px}
.ir-chat-line{padding:2px 6px;border-left:3px solid transparent;overflow-wrap:anywhere;word-break:break-word}
.ir-chat-line--new{animation:ir-chat-in .18s ease-out}
.ir-chat-line--me{border-left-color:var(--ir-chat-accent);background:rgba(45,226,255,.08)}
.ir-chat-time{color:#5f7190;font-size:11px;margin-right:6px;font-variant-numeric:tabular-nums}
.ir-chat-name{font-weight:800;text-transform:uppercase;letter-spacing:.04em;margin-right:6px}
.ir-chat-name::after{content:':';color:#8fa3c0;margin-left:1px}
.ir-chat-line--emote .ir-chat-name::after{content:'\\203A';color:var(--ir-chat-hot);margin-left:5px}
.ir-chat-name--home{color:var(--ir-chat-home)}
.ir-chat-name--away{color:var(--ir-chat-away)}
.ir-chat-name--spec{color:var(--ir-chat-spec)}
.ir-chat-line--emote .ir-chat-text{font-weight:800;font-style:italic;text-transform:uppercase;letter-spacing:.06em;
  color:var(--ir-chat-hot);text-shadow:0 0 10px rgba(255,210,63,.45)}
.ir-chat-line--sys .ir-chat-text{color:#8fa3c0;font-style:italic}
.ir-chat-quick{display:flex;flex-wrap:wrap;gap:5px;padding:6px 8px 0}
.ir-chat-chip{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;gap:5px;
  border:1px solid rgba(255,210,63,.55);background:rgba(255,210,63,.08);color:#ffe9a3;font:inherit;font-size:12px;
  font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:3px 8px;border-radius:3px;cursor:pointer;
  white-space:nowrap;flex:0 0 auto;transition:opacity .2s,background .15s}
.ir-chat-chip:hover{background:rgba(255,210,63,.22)}
.ir-chat-chip:active{transform:translateY(1px)}
.ir-chat-key{display:none;min-width:15px;padding:0 3px;border-radius:2px;background:var(--ir-chat-hot);color:#0a0f1e;
  font-size:11px;font-weight:800;text-align:center;line-height:15px}
.ir-chat--game .ir-chat-key{display:inline-block}
.ir-chat--cooldown .ir-chat-chip{opacity:.38;cursor:default}
.ir-chat-row{display:flex;gap:6px;padding:8px}
.ir-chat-input{flex:1 1 auto;min-width:0;font:inherit;font-size:16px;color:#fff;background:rgba(0,0,0,.45);
  border:1px solid rgba(45,226,255,.45);border-radius:3px;padding:7px 10px;outline:none}
.ir-chat-input:focus{border-color:var(--ir-chat-accent);box-shadow:0 0 0 2px rgba(45,226,255,.25)}
.ir-chat-input::placeholder{color:#6d7f9c}
.ir-chat-send{flex:0 0 auto;font:inherit;font-weight:800;font-style:italic;letter-spacing:.1em;text-transform:uppercase;
  color:#0a0f1e;background:linear-gradient(#ffe066,#ffb800);border:0;border-radius:3px;padding:0 14px;cursor:pointer}
.ir-chat-send:hover{filter:brightness(1.08)}
.ir-chat-toggle{display:none}
.ir-chat--game{position:fixed;left:calc(12px + env(safe-area-inset-left,0px));
  bottom:calc(var(--ir-chat-bottom,14px) + env(safe-area-inset-bottom,0px));width:min(400px,calc(100vw - 24px));
  z-index:var(--ir-chat-z,40);display:flex;flex-direction:column;align-items:stretch;pointer-events:none;font-size:14px}
.ir-chat--game .ir-chat-head,.ir-chat--game .ir-chat-quick,.ir-chat--game .ir-chat-row,.ir-chat--game .ir-chat-empty{display:none}
.ir-chat--game .ir-chat-log{overflow:hidden;padding:0;gap:3px;align-items:flex-start}
.ir-chat--game .ir-chat-line{background:rgba(4,7,18,.84);border-radius:3px;text-shadow:0 1px 2px #000;
  transition:opacity .9s ease;max-width:100%}
.ir-chat--game .ir-chat-line--me{background:rgba(6,34,52,.88)}
.ir-chat--game .ir-chat-time{display:none}
.ir-chat--game:not(.ir-chat--open) .ir-chat-line--faded{opacity:0}
.ir-chat--game:not(.ir-chat--open) .ir-chat-line:nth-last-child(n+7){display:none}
.ir-chat--game .ir-chat-toggle{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;margin-top:6px;
  pointer-events:auto;font:inherit;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
  color:#cfe9ff;background:rgba(5,8,20,.55);border:1px solid rgba(45,226,255,.35);border-radius:999px;
  padding:3px 10px;cursor:pointer;opacity:.7}
.ir-chat--game .ir-chat-toggle:hover{opacity:1}
.ir-chat--game.ir-chat--open{pointer-events:auto;background:var(--ir-chat-bg);border:2px solid var(--ir-chat-accent);
  border-radius:4px;box-shadow:0 0 0 2px rgba(0,0,0,.55),0 10px 30px rgba(0,0,0,.5)}
.ir-chat--game.ir-chat--open .ir-chat-head,.ir-chat--game.ir-chat--open .ir-chat-quick,
.ir-chat--game.ir-chat--open .ir-chat-row{display:flex}
.ir-chat--game.ir-chat--open .ir-chat-log{max-height:min(32vh,230px);overflow-y:auto;padding:6px 8px 0;align-items:stretch}
.ir-chat--game.ir-chat--open .ir-chat-line{background:transparent;text-shadow:none}
.ir-chat--game.ir-chat--open .ir-chat-line--me{background:rgba(45,226,255,.08)}
.ir-chat--game.ir-chat--open .ir-chat-toggle{display:none}
@keyframes ir-chat-in{from{opacity:0;transform:translateX(-10px)}}
@media (max-width:420px){.ir-chat{font-size:14px}.ir-chat-hint{display:none}.ir-chat-send{padding:0 10px}}
@media (prefers-reduced-motion:reduce){.ir-chat-line--new{animation:none}.ir-chat--game .ir-chat-line{transition:none}}
`;

function injectStyle() {
  styleRefs++;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

function releaseStyle() {
  styleRefs = Math.max(0, styleRefs - 1);
  if (!styleRefs) document.getElementById(STYLE_ID)?.remove();
}

function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
}

// 0xff6a13 | '#ff6a13' | '#f61' | 'ff6a13' -> '#rrggbb' lifted to a readable luminance on dark ground.
function nameColor(c, fallback) {
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

const clampText = (s) => Array.from(String(s).replace(/\s+/g, ' ').trim()).slice(0, CHAT_MAX_LEN).join('').trim();
const pad2 = (n) => String(n).padStart(2, '0');
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export function createChat(container, { send, myId = 0, gameContainer = null, onTyping = null } = {}) {
  const home = container || document.body;
  injectStyle();

  let me = myId;
  let inGame = false;
  let isOpen = false;          // in-game input visible
  let disposed = false;
  let lastEmoteAt = -Infinity;
  let cooldownTimer = 0;
  let fadeTimer = 0;
  let typingWas = false;
  const pending = [];          // in-game feed lines not faded yet: [{line, born}] (born ascending)
  const seen = new Set();
  const seenOrder = [];

  // ---- DOM ---------------------------------------------------------------------------------
  const root = el('div', 'ir-chat ir-chat--lobby');
  const head = el('div', 'ir-chat-head');
  head.append(el('span', 'ir-chat-title', 'Chat'), el('span', 'ir-chat-hint', 'Enter to send'));
  const hint = head.lastChild;
  const log = el('div', 'ir-chat-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  let emptyNote = el('div', 'ir-chat-empty', 'No messages yet - say hi.');
  log.appendChild(emptyNote);
  const quick = el('div', 'ir-chat-quick');
  QUICK_CHAT.forEach((label, i) => {
    const b = el('button', 'ir-chat-chip');
    b.type = 'button';
    b.dataset.id = String(i);
    b.title = `Quick chat ${i + 1}`;
    b.append(el('span', 'ir-chat-key', String(i + 1)), document.createTextNode(label));
    quick.appendChild(b);
  });
  const row = el('div', 'ir-chat-row');
  const input = el('input', 'ir-chat-input');
  input.type = 'text';
  input.maxLength = CHAT_MAX_LEN;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Say something...';
  input.setAttribute('aria-label', 'Chat message');
  input.setAttribute('enterkeyhint', 'send');
  input.setAttribute('autocapitalize', 'sentences');
  const sendBtn = el('button', 'ir-chat-send', 'Send');
  sendBtn.type = 'button';
  row.append(input, sendBtn);
  const toggle = el('button', 'ir-chat-toggle');
  toggle.type = 'button';
  toggle.append(el('span', 'ir-chat-key', 'T'), document.createTextNode('Chat \u00b7 1-8 quick'));
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

  function open() {
    if (disposed) return;
    if (inGame) {
      isOpen = true;
      root.classList.add('ir-chat--open');
      scrollToEnd();
    }
    input.focus({ preventScroll: true });
    syncTyping();
  }

  function close() {
    if (disposed) return;
    if (inGame) {
      isOpen = false; // before blur() so the blur handler doesn't re-enter
      root.classList.remove('ir-chat--open');
    }
    if (document.activeElement === input) input.blur();
    syncTyping();
  }

  function submit() {
    const text = clampText(input.value);
    input.value = '';
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
    if (inGame && isOpen && document.hasFocus()) {
      isOpen = false;
      root.classList.remove('ir-chat--open');
    }
    syncTyping();
  }
  function onWindowKeyDown(e) {
    if (disposed || !inGame || isOpen) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    const code = e.code;
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
  // Keep focus in the input when tapping chips / SEND (in-game: anywhere in the open panel),
  // otherwise the blur would close the in-game input before the click lands.
  function onRootPointerDown(e) {
    if (e.target === input || document.activeElement !== input) return;
    if (inGame || e.target.closest('.ir-chat-chip, .ir-chat-send')) e.preventDefault();
  }
  function onQuickClick(e) {
    const chip = e.target.closest('.ir-chat-chip');
    if (!chip) return;
    sendQuick(Number(chip.dataset.id));
    if (inGame) close();
  }
  function onToggleClick() { open(); }

  input.addEventListener('keydown', onInputKeyDown);
  input.addEventListener('focus', onInputFocus);
  input.addEventListener('blur', onInputBlur);
  root.addEventListener('pointerdown', onRootPointerDown);
  quick.addEventListener('click', onQuickClick);
  sendBtn.addEventListener('click', submit);
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
    if (typeof msg.ts === 'number' && msg.ts > 1e12) {
      const d = new Date(msg.ts);
      line.appendChild(el('span', 'ir-chat-time', `${pad2(d.getHours())}:${pad2(d.getMinutes())}`));
    }
    if (from) {
      const name = typeof msg.name === 'string' && msg.name ? msg.name.slice(0, 24) : `#${from}`;
      line.appendChild(el('span', `ir-chat-name ir-chat-name--${team === 0 ? 'home' : team === 1 ? 'away' : 'spec'}`, name));
    } else {
      line.classList.add('ir-chat-line--sys');
    }
    line.appendChild(el('span', 'ir-chat-text', text));
    line.addEventListener('animationend', () => line.classList.remove('ir-chat-line--new'), { once: true });

    if (emptyNote) { emptyNote.remove(); emptyNote = null; }
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    log.appendChild(line);
    let lines = log.querySelectorAll('.ir-chat-line');
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
    root.classList.toggle('ir-chat--game', on);
    root.classList.toggle('ir-chat--lobby', !on);
    root.classList.remove('ir-chat--open');
    hint.textContent = on ? 'Enter send \u00b7 Esc cancel' : 'Enter to send';
    input.placeholder = on ? 'Say something - Enter to send' : 'Say something...';
    const parent = on && gameContainer ? gameContainer : home;
    if (root.parentNode !== parent) parent.appendChild(root);
    clearInterval(fadeTimer);
    fadeTimer = 0;
    if (on) {
      fadeAll(); // the feed starts clean; lobby chatter stays readable when the input opens
      fadeTimer = setInterval(fadeTick, 250);
    } else {
      scrollToEnd();
    }
    syncTyping();
  }

  function setTeamColors(colors) {
    if (!Array.isArray(colors)) return;
    root.style.setProperty('--ir-chat-home', nameColor(colors[0], DEFAULT_COLORS[0]));
    root.style.setProperty('--ir-chat-away', nameColor(colors[1], DEFAULT_COLORS[1]));
  }

  function dispose() {
    if (disposed) return;
    const wasTyping = typingWas;
    disposed = true;
    clearInterval(fadeTimer);
    clearTimeout(cooldownTimer);
    window.removeEventListener('keydown', onWindowKeyDown);
    root.remove();
    releaseStyle();
    if (wasTyping && typeof onTyping === 'function') {
      try { onTyping(false); } catch (e) { console.error(e); }
    }
  }

  return { receive, setMyId, setInGame, setTeamColors, isTyping, open, close, sendQuick, dispose };
}
