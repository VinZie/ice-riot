// ICE RIOT - minimal RFC 6455 WebSocket server (zero dependencies).
//
// attachWebSocketServer(httpServer, { path, onConnection, ... }) hooks the http 'upgrade' event.
// Each accepted socket becomes a WebSocketConnection (EventEmitter):
//   conn.send(str)          send a text frame (returns false if not open)
//   conn.sendFrame(buf)     send a pre-encoded frame from encodeText() (broadcast: encode once)
//   conn.close(code, why)   close handshake (sends Close, then ends the TCP stream)
//   conn.terminate()        drop the socket immediately
//   conn.ping()             send a ping carrying a timestamp; the pong updates conn.rtt / emits 'rtt'
//   conn.bufferedAmount     bytes queued in the socket (socket.writableLength) for backpressure
//   events: 'message' (string), 'close' (code, reason), 'rtt' (ms)
// Text messages only (binary messages are accepted and ignored). Client frames must be masked.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { STATUS_CODES } from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export const DEFAULT_MAX_MESSAGE = 64 * 1024;
export const DEFAULT_HEARTBEAT_MS = 15000;
export const DEFAULT_TIMEOUT_MS = 30000;

const EMPTY = Buffer.alloc(0);
const KEY_RE = /^[A-Za-z0-9+/]{22}==$/;

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode one unmasked, final frame. */
export function encodeFrame(opcode, payload = EMPTY) {
  const len = payload.length;
  const hl = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const buf = Buffer.allocUnsafe(hl + len);
  writeHeader(buf, opcode, len);
  payload.copy(buf, hl);
  return buf;
}

/** Encode a string as a single unmasked text frame (encode once, write to many sockets). */
export function encodeText(str) {
  const len = Buffer.byteLength(str, 'utf8');
  const hl = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const buf = Buffer.allocUnsafe(hl + len);
  writeHeader(buf, OP_TEXT, len);
  buf.write(str, hl, len, 'utf8');
  return buf;
}

function writeHeader(buf, opcode, len) {
  buf[0] = 0x80 | opcode;
  if (len < 126) {
    buf[1] = len;
  } else if (len < 65536) {
    buf[1] = 126;
    buf.writeUInt16BE(len, 2);
  } else {
    buf[1] = 127;
    buf.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    buf.writeUInt32BE(len >>> 0, 6);
  }
}

function closePayload(code, reason) {
  if (!code) return EMPTY;
  const r = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
  const buf = Buffer.allocUnsafe(2 + r.length);
  buf.writeUInt16BE(code, 0);
  r.copy(buf, 2);
  return buf;
}

function validCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, { maxMessage = DEFAULT_MAX_MESSAGE, remoteAddress = '' } = {}) {
    super();
    this.socket = socket;
    this.maxMessage = maxMessage;
    this.remoteAddress = remoteAddress;
    this.readyState = OPEN;
    this.lastSeen = performance.now();
    this.rtt = -1;
    this.closeCode = 1006;
    this.closeReason = '';
    this._chunks = [];     // received bytes not yet parsed
    this._len = 0;
    this._need = 0;        // bytes needed before parsing is worth retrying
    this._fragOp = 0;      // 0 = no fragmented message in progress, else OP_TEXT / OP_BINARY
    this._frags = [];
    this._fragLen = 0;
    this._killTimer = null;
    this._decoder = new TextDecoder('utf-8', { fatal: true });

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('end', () => {
      // Peer half-closed without (or after) a close frame: finish our side too.
      if (this.readyState === OPEN) this.readyState = CLOSING;
      socket.end();
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this._finish());
  }

  get bufferedAmount() {
    return this.socket.writableLength;
  }

  send(str) {
    if (this.readyState !== OPEN) return false;
    this.socket.write(encodeText(String(str)));
    return true;
  }

  sendFrame(frame) {
    if (this.readyState !== OPEN) return false;
    this.socket.write(frame);
    return true;
  }

  ping() {
    if (this.readyState !== OPEN) return false;
    this.socket.write(encodeFrame(OP_PING, Buffer.from(performance.now().toFixed(3))));
    return true;
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    this.closeCode = code;
    this.closeReason = reason;
    this._chunks = [];
    this._frags = [];
    // Send Close, then FIN. The peer answers with its own Close (ignored) and drops the TCP connection.
    this.socket.end(encodeFrame(OP_CLOSE, closePayload(code, reason)));
    this._armKill(1500);
  }

  terminate() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    this.socket.destroy();
  }

  _armKill(ms) {
    if (this._killTimer) return;
    this._killTimer = setTimeout(() => this.socket.destroy(), ms);
    this._killTimer.unref?.();
  }

  _finish() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    if (this._killTimer) clearTimeout(this._killTimer);
    this._chunks = [];
    this._frags = [];
    this.emit('close', this.closeCode, this.closeReason);
  }

  _emitSafe(event, arg) {
    try {
      this.emit(event, arg);
    } catch (err) {
      console.error(`[ws] '${event}' handler threw:`, err);
    }
  }

  _onData(chunk) {
    if (this.readyState !== OPEN) return; // closing: discard whatever the peer still sends
    this.lastSeen = performance.now();
    // Collect chunks and only concatenate once a whole frame is available, so a peer that
    // trickles a large frame in tiny TCP segments costs O(n), not O(n^2).
    this._chunks.push(chunk);
    this._len += chunk.length;
    if (this._len < this._need) return;
    const buf = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._len);
    this._chunks = [];
    this._len = 0;
    this._need = 0;

    let pos = 0;
    const keep = (need) => {
      if (pos < buf.length) {
        this._chunks.push(buf.subarray(pos));
        this._len = buf.length - pos;
      }
      this._need = need;
    };
    while (this.readyState === OPEN) {
      const avail = buf.length - pos;
      if (avail < 2) return keep(2);
      const b0 = buf[pos];
      const b1 = buf[pos + 1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      if (b0 & 0x70) return this.close(1002, 'reserved bits set');
      if (!(b1 & 0x80)) return this.close(1002, 'client frames must be masked');

      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (avail < 4) return keep(4);
        len = buf.readUInt16BE(pos + 2);
        off = 4;
      } else if (len === 127) {
        if (avail < 10) return keep(10);
        const hi = buf.readUInt32BE(pos + 2);
        const lo = buf.readUInt32BE(pos + 6);
        if (hi > 0) return this.close(1009, 'message too big');
        len = lo;
        off = 10;
      }

      if (op >= 0x8) {
        if (op !== OP_CLOSE && op !== OP_PING && op !== OP_PONG) return this.close(1002, 'unknown opcode');
        if (!fin || len > 125) return this.close(1002, 'bad control frame');
      } else {
        if (op !== OP_CONT && op !== OP_TEXT && op !== OP_BINARY) return this.close(1002, 'unknown opcode');
        if (op === OP_CONT && !this._fragOp) return this.close(1002, 'unexpected continuation');
        if (op !== OP_CONT && this._fragOp) return this.close(1002, 'expected continuation');
        const total = (op === OP_CONT ? this._fragLen : 0) + len;
        // Reject as soon as the header announces an oversized message (don't wait for the bytes).
        if (total > this.maxMessage) return this.close(1009, 'message too big');
      }

      const frameLen = off + 4 + len;
      if (avail < frameLen) return keep(frameLen);
      const mo = pos + off;
      const m0 = buf[mo], m1 = buf[mo + 1], m2 = buf[mo + 2], m3 = buf[mo + 3];
      const payload = buf.subarray(mo + 4, pos + frameLen);
      for (let i = 0; i < len; i++) {
        const m = (i & 3) === 0 ? m0 : (i & 3) === 1 ? m1 : (i & 3) === 2 ? m2 : m3;
        payload[i] ^= m;
      }
      pos += frameLen;
      this._handleFrame(fin, op, payload);
    }
  }

  _handleFrame(fin, op, payload) {
    switch (op) {
      case OP_TEXT:
      case OP_BINARY:
      case OP_CONT: {
        if (op !== OP_CONT) {
          this._fragOp = op;
          this._frags = [];
          this._fragLen = 0;
        }
        this._frags.push(payload);
        this._fragLen += payload.length;
        if (!fin) return;
        const kind = this._fragOp;
        const data = this._frags.length === 1 ? this._frags[0] : Buffer.concat(this._frags, this._fragLen);
        this._fragOp = 0;
        this._frags = [];
        this._fragLen = 0;
        if (kind !== OP_TEXT) return; // binary messages are ignored
        let str;
        try {
          str = this._decoder.decode(data);
        } catch {
          return this.close(1007, 'invalid UTF-8');
        }
        this._emitSafe('message', str);
        return;
      }
      case OP_PING:
        this.socket.write(encodeFrame(OP_PONG, payload));
        return;
      case OP_PONG: {
        const sent = Number(payload.toString('latin1'));
        const now = performance.now();
        if (Number.isFinite(sent) && sent > 0 && sent <= now) {
          this.rtt = now - sent;
          this._emitSafe('rtt', this.rtt);
        }
        return;
      }
      case OP_CLOSE: {
        let code = 1005;
        let reason = '';
        if (payload.length === 1) {
          code = 1002;
        } else if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString('utf8');
          if (!validCloseCode(code)) code = 1002;
        }
        this.readyState = CLOSING;
        this.closeCode = code;
        this.closeReason = reason;
        this.socket.end(encodeFrame(OP_CLOSE, closePayload(code === 1005 ? 1000 : code, '')));
        this._armKill(1000);
        return;
      }
      default:
    }
  }
}

function rejectUpgrade(socket, status, extraHeaders = '') {
  socket.on('error', () => {});
  if (!socket.writable) return socket.destroy();
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] || ''}\r\n` +
      'Connection: close\r\nContent-Length: 0\r\n' +
      extraHeaders +
      '\r\n',
  );
}

/**
 * Accept WebSocket upgrades on `path`. Returns { connections, close() }.
 * Heartbeat: every heartbeatMs each connection is pinged; one that has sent nothing (no pong,
 * no data) for timeoutMs is terminated.
 */
export function attachWebSocketServer(
  httpServer,
  {
    path = '/ws',
    onConnection,
    maxMessage = DEFAULT_MAX_MESSAGE,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  const connections = new Set();

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const url = req.url || '/';
      const q = url.indexOf('?');
      const pathname = q === -1 ? url : url.slice(0, q);
      if (pathname !== path) return rejectUpgrade(socket, 404);
      if (req.method !== 'GET') return rejectUpgrade(socket, 405);
      if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return rejectUpgrade(socket, 400);
      const connTokens = String(req.headers.connection || '').toLowerCase().split(',').map((s) => s.trim());
      if (!connTokens.includes('upgrade')) return rejectUpgrade(socket, 400);
      if (String(req.headers['sec-websocket-version'] || '').trim() !== '13') {
        return rejectUpgrade(socket, 426, 'Sec-WebSocket-Version: 13\r\n');
      }
      const key = String(req.headers['sec-websocket-key'] || '').trim();
      if (!KEY_RE.test(key)) return rejectUpgrade(socket, 400);

      let protoHeader = '';
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (protocols.length && /^[\w.-]+$/.test(protocols[0])) protoHeader = `Sec-WebSocket-Protocol: ${protocols[0]}\r\n`;

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
          protoHeader +
          '\r\n',
      );
      socket.setNoDelay(true);
      socket.setTimeout(0);
      socket.setKeepAlive(true, 30000);

      const conn = new WebSocketConnection(socket, { maxMessage, remoteAddress: socket.remoteAddress || '' });
      connections.add(conn);
      conn.on('close', () => connections.delete(conn));
      onConnection?.(conn, req);
      if (head && head.length) conn._onData(head);
    } catch (err) {
      console.error('[ws] upgrade failed:', err);
      socket.destroy();
    }
  });

  const heartbeat = setInterval(() => {
    const now = performance.now();
    for (const conn of connections) {
      if (conn.readyState !== OPEN) continue;
      if (now - conn.lastSeen > timeoutMs) conn.terminate();
      else conn.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    connections,
    close(code = 1001, reason = 'server shutting down') {
      clearInterval(heartbeat);
      for (const conn of connections) conn.close(code, reason);
    },
    terminateAll() {
      clearInterval(heartbeat);
      for (const conn of connections) conn.terminate();
    },
  };
}
