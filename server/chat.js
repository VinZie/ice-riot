// ICE RIOT - room chat + quick-chat emotes (server side). Pure: no sockets, no timers, no IO.
// The room owns one instance (`createChat()`), feeds it client messages, and broadcasts what
// it returns. The browser half lives in public/chat.js (it keeps its own copy of QUICK_CHAT;
// test/chat.test.js checks the two lists are identical).
//
// PROTOCOL EXTENSION (on top of docs/CONTRACT.md)
//
//   client -> server
//     {t:'chat',  text}   free text. Sanitized here: control / zero-width / bidi-override chars
//                         stripped, whitespace (incl. newlines) collapsed to one space, trimmed,
//                         capped at maxLen (120) code points. Empty after that => ignored.
//     {t:'emote', id}     quick chat; id = integer index into QUICK_CHAT.
//
//   server -> clients (broadcast to the whole room)
//     {t:'chat', from, name, team, text, emote, ts}
//        from  : sender clientId
//        name  : sender name (already sanitized by the room at hello)
//        team  : sender team when sent: 0 home, 1 away, -1 spectator
//        text  : sanitized text (for an emote: QUICK_CHAT[id]). NOT HTML-escaped: clients must
//                render it with textContent only.
//        emote : QUICK_CHAT index, or null for free text
//        ts    : the nowMs passed to handle() (the room passes Date.now(), so wall-clock ms)
//
//   Optional: when the room replays history() to a client that just joined it may add
//   `hist: true` to each replayed message; public/chat.js then files them into the log without
//   popping them into the in-game feed (and de-duplicates them after a reconnect).
//
// Rate limit: one token bucket per client shared by chat + emotes (burst 5, refill 1/s).
// A message with no token left is dropped; handle() returns {error} for it at most once per
// `warnEveryMs` per client (null for the rest of that streak) so a spammer can't turn the
// limiter into an error-message flood.
//
// API
//   const chat = createChat({ maxLen, burst, refillPerSec, historySize, warnEveryMs })
//   chat.handle(client /* {id, name, team} */, msg, nowMs) -> broadcastMsg | {error} | null
//   chat.history()       -> copies of the last `historySize` broadcast messages, oldest first
//   chat.forget(clientId) -> drop that client's rate-limit state (call on leave)

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

// C0 + DEL + C1 controls, zero-width / joiners / direction marks (200B-200F), bidi embeddings and
// overrides (202A-202E), word joiner .. invisible operators + bidi isolates (2060-206F), BOM.
// Tab / newline / CR / VT / FF and the Unicode line + paragraph separators become spaces first.
const SPACE_LIKE_RE = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
// Unpaired UTF-16 surrogates (JSON.parse happily produces them).
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
// "Zalgo" stacks: keep at most 2 combining marks in a row.
const MARK_STACK_RE = /(\p{M}{2})\p{M}+/gu;
const RAW_SCAN_LIMIT = 4096; // never run the regexes over more than this many UTF-16 units

/** Sanitize one chat line. Returns '' when nothing printable is left. */
export function sanitizeChat(raw, maxLen = CHAT_MAX_LEN) {
  if (typeof raw !== 'string') return '';
  let s = raw.length > RAW_SCAN_LIMIT ? raw.slice(0, RAW_SCAN_LIMIT) : raw;
  s = s
    .replace(SPACE_LIKE_RE, ' ')
    .replace(CONTROL_RE, '')
    .replace(LONE_SURROGATE_RE, '')
    .replace(MARK_STACK_RE, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = Array.from(s); // cap by code points so a surrogate pair is never split
  if (cps.length > maxLen) s = cps.slice(0, maxLen).join('').trimEnd();
  return s;
}

const teamOf = (t) => (t === 0 || t === 1 ? t : -1);

export function createChat({
  maxLen = CHAT_MAX_LEN,
  burst = 5,
  refillPerSec = 1,
  historySize = 50,
  warnEveryMs = 2000,
} = {}) {
  const buckets = new Map(); // clientId -> { tokens, last, warnedAt }
  const log = [];

  // Token bucket. Tolerates a clock that goes backwards (no refill, no negative time).
  function take(id, now) {
    let b = buckets.get(id);
    if (!b) {
      b = { tokens: burst, last: now, warnedAt: -Infinity };
      buckets.set(id, b);
    }
    if (now > b.last) {
      b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * refillPerSec);
    }
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      b.warnedAt = -Infinity; // next limited streak gets a fresh warning
      return { ok: true };
    }
    const warn = now - b.warnedAt >= warnEveryMs;
    if (warn) b.warnedAt = now;
    return { ok: false, warn };
  }

  function handle(client, msg, nowMs) {
    if (!client || client.id == null || !msg || typeof msg !== 'object') return null;
    const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();

    let text;
    let emote = null;
    if (msg.t === 'chat') {
      text = sanitizeChat(msg.text, maxLen);
      if (!text) return null; // empty / whitespace-only / non-string: ignore, costs no token
    } else if (msg.t === 'emote') {
      const id = msg.id;
      if (!Number.isInteger(id) || id < 0 || id >= QUICK_CHAT.length) return { error: 'Unknown quick chat' };
      emote = id;
      text = QUICK_CHAT[id];
    } else {
      return null;
    }

    const r = take(client.id, now);
    if (!r.ok) return r.warn ? { error: 'Slow down - too many chat messages' } : null;

    const out = {
      t: 'chat',
      from: client.id,
      name: typeof client.name === 'string' ? client.name : String(client.name ?? ''),
      team: teamOf(client.team),
      text,
      emote,
      ts: now,
    };
    if (historySize > 0) {
      log.push(out);
      if (log.length > historySize) log.splice(0, log.length - historySize);
    }
    return { ...out };
  }

  return {
    handle,
    history: () => log.map((m) => ({ ...m })),
    forget: (clientId) => {
      buckets.delete(clientId);
    },
  };
}
