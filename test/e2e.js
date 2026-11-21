#!/usr/bin/env node
// ICE RIOT - end-to-end test: real server + headless Vivaldi (via the DevTools protocol) + bots.
//
//   node test/e2e.js [--seconds 30] [--bots 3] [--browser <chromium exe>] [--out <dir>]
//                    [--hud-selector <css>] [--no-fuzz] [--keep-profile] [--headful]
//                    [--sim test/fake-sim.js]   (passed to the server as --sim)
//                    [--attach-port N]   (test a server already listening on 127.0.0.1:N instead)
//
// Browser: env BROWSER (or --browser) overrides the default
//   %LOCALAPPDATA%\Vivaldi\Application\vivaldi.exe (any Chromium works; set BROWSER to override).
// Only the browser process tree this script spawned is ever killed (taskkill /PID <pid> /T /F,
// plus processes whose command line carries this run's unique temp profile dir).
//
// What it does:
//   1. `node --check` every JS file under server/, shared/, public/ (vendor excluded).
//   2. Starts `node server/server.js --port <free> --host 127.0.0.1`, logs to <out>/server.log,
//      waits for GET / and probes a few static URLs (MIME types, 404s, path traversal).
//   3. Robustness probes over /ws in throwaway rooms (garbage frames, bad config, absurd input
//      values -> snapshots must stay valid), then checks the server still answers.
//   4. Launches a headless browser with --remote-debugging-port, attaches over CDP at browser
//      level (Target.createTarget + attachToTarget flatten; Node's global WebSocket, no deps),
//      records console messages / exceptions / failed requests / every game WebSocket frame, and
//      opens /?name=E2E&team=0&autostart=1 so the page becomes host and starts the game. Then 3
//      bots (test/bots.js) drop in on the other slots.
//   5. Screenshots at a few moments, HUD probe, keyboard input probe, FPS probe.
//   6. Fails on: server crash / stack traces in its log, uncaught page exceptions, console errors,
//      failed requests, no snaps reaching the bots (or < 25/s), HUD never visible, blank canvas.
//   Writes <out>/report.json (+ screenshots, logs) and prints the absolute paths. All child
//   processes (server, browser tree) are killed on exit, including on failure / Ctrl+C.
//
// Default <out>: %TEMP%\claude\ice-riot-qa\e2e-<timestamp>

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { startBots, formatSummary, validateSnapshot } from './bots.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_OUT = path.join(os.tmpdir(), 'claude', 'ice-riot-qa');
const DEFAULT_BROWSER = path.join(process.env.LOCALAPPDATA || '', 'Vivaldi', 'Application', 'vivaldi.exe');
// Vivaldi's built-in extensions log noise that is not the game's fault.
const BROWSER_NOISE = /RSS_Basic_Detect|chrome-extension:|Receiving end does not exist/;
// public/ui.js renders the in-game HUD as <section id="hud"> with a .scoreboard inside.
const DEFAULT_HUD = '#hud .scoreboard, #hud';
const IS_WIN = process.platform === 'win32';
const VIEW_W = 1280, VIEW_H = 720;    // emulated viewport + screenshot clip

// ---------------------------------------------------------------- options

function parseArgs(argv) {
  const o = {
    seconds: 30, bots: 3, browser: process.env.BROWSER || DEFAULT_BROWSER, out: null, sim: null,
    hudSelector: DEFAULT_HUD, fuzz: true, keepProfile: false, headful: false, name: 'E2E', team: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`missing value for ${a}`); return x; };
    switch (a) {
      case '--seconds': o.seconds = Number(v()); break;
      case '--bots': o.bots = Number(v()); break;
      case '--browser': o.browser = v(); break;
      case '--sim': o.sim = v(); break;
      case '--out': o.out = v(); break;
      case '--hud-selector': o.hudSelector = v(); break;
      case '--no-fuzz': o.fuzz = false; break;
      case '--keep-profile': o.keepProfile = true; break;
      case '--headful': o.headful = true; break;
      case '--name': o.name = v(); break;
      case '--team': o.team = Number(v()); break;
      case '--attach-port': o.attachPort = Number(v()); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

// ---------------------------------------------------------------- process bookkeeping

const children = new Map();   // pid -> label
function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
  children.delete(pid);
}
function killAllSync() { for (const pid of [...children.keys()]) killTree(pid); }
process.on('exit', killAllSync);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  try { process.on(sig, () => { console.log(`\n${sig}: cleaning up`); killAllSync(); process.exit(130); }); } catch { /* unsupported */ }
}

// Belt and braces after the tree kill: stop any process of OUR browser binary whose command line
// carries this run's unique temp profile dir. Never matches the user's own browser windows.
function sweepBrowser(exePath, profileDir) {
  if (!IS_WIN || !profileDir || !exePath) return;
  const exe = path.basename(exePath).replace(/'/g, "''");
  const needle = profileDir.replace(/'/g, "''");
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true, timeout: 20000 }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- utils

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = performance.now();
const elapsed = () => ((performance.now() - T0) / 1000).toFixed(1).padStart(6);
let logStream = null;
function log(line) {
  const s = `[${elapsed()}s] ${line}`;
  console.log(s);
  if (logStream) logStream.write(s + '\n');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function httpGet(port, rawPath, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => resolve({ status: 0, error: e.message }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end();
  });
}

async function waitFor(pred, timeoutMs, stepMs = 100) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

function listJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== 'vendor' && ent.name !== 'node_modules') listJs(p, out); }
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- PNG (for blank-canvas / motion checks)

function decodePng(buf) {
  try {
    let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
    const idat = [];
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      off += 12 + len;
    }
    if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) return null;
    const bpp = ctype === 6 ? 4 : 3;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = w * bpp;
    const out = Buffer.alloc(h * stride);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
      const ft = raw[y * (stride + 1)];
      const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const cur = out.subarray(y * stride, (y + 1) * stride);
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        let v = line[x];
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        cur[x] = v & 255;
      }
      prev = cur;
    }
    return { w, h, bpp, data: out };
  } catch { return null; }
}

function imageStats(img) {
  let n = 0, sum = 0, sum2 = 0;
  const colors = new Set();
  for (let y = 0; y < img.h; y += 4) {
    for (let x = 0; x < img.w; x += 4) {
      const i = (y * img.w + x) * img.bpp;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++; sum += l; sum2 += l * l;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
  }
  const meanL = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - meanL * meanL));
  return { width: img.w, height: img.h, meanLuma: +meanL.toFixed(1), stdLuma: +std.toFixed(1), colors: colors.size, blank: colors.size < 8 || std < 3 };
}

function imageDiff(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return null;
  let n = 0, changed = 0;
  for (let y = 0; y < a.h; y += 4) {
    for (let x = 0; x < a.w; x += 4) {
      const i = (y * a.w + x) * a.bpp, j = (y * b.w + x) * b.bpp;
      const d = Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]);
      n++;
      if (d > 48) changed++;
    }
  }
  return +(changed / n).toFixed(4);
}

// ---------------------------------------------------------------- minimal CDP client

class CDP {
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 10000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CDP(ws)); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`CDP socket error ${e.message || ''}`)); });
    });
  }
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    ws.addEventListener('message', (e) => this.onMessage(e.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('CDP closed')); }
      this.pending.clear();
    });
  }
  onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject, timer, method } = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(timer);
      if (m.error) reject(new Error(`${method}: ${m.error.message}`));
      else resolve(m.result);
    } else if (m.method) {
      for (const fn of this.handlers.get(m.method) || []) {
        try { fn(m.params || {}, m.sessionId); } catch (e) { log(`CDP handler ${m.method} threw: ${e.stack}`); }
      }
    }
  }
  send(method, params = {}, timeoutMs = 20000, sessionId = undefined) {
    if (this.closed) return Promise.reject(new Error('CDP closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: timeout`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  // A flattened target session (Target.attachToTarget {flatten:true}) over the browser socket.
  session(sessionId) {
    return {
      sessionId,
      send: (method, params = {}, timeoutMs = 20000) => this.send(method, params, timeoutMs, sessionId),
      on: (method, fn) => this.on(method, (p, sid) => { if (sid === sessionId) fn(p); }),
    };
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- WebSocket probe (robustness tests)

function wsProbe(url) {
  return new Promise((resolve) => {
    const p = { msgs: [], closed: null, ws: null, error: null };
    const ws = new WebSocket(url);
    p.ws = ws;
    p.send = (data) => { try { if (ws.readyState === 1) { ws.send(data); return true; } } catch (e) { p.error = e.message; } return false; };
    p.json = (obj) => p.send(JSON.stringify(obj));
    p.waitFor = (pred, ms) => waitFor(() => p.msgs.find(pred), ms, 20);
    p.close = () => { try { ws.close(1000); } catch { /* ignore */ } };
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') { p.msgs.push({ t: '<binary>' }); return; }
      try { p.msgs.push(JSON.parse(e.data)); } catch { p.msgs.push({ t: '<bad json>', raw: e.data.slice(0, 100) }); }
    });
    ws.addEventListener('close', (e) => { p.closed = { code: e.code, reason: e.reason }; });
    ws.addEventListener('error', (e) => { p.error = e.message || 'error'; });
    const timer = setTimeout(() => resolve(p), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(p); });
    ws.addEventListener('close', () => { clearTimeout(timer); resolve(p); });
  });
}

async function fuzzServer(wsUrl, report, fail, warn) {
  const res = {};
  // 1) garbage before hello on its own connection
  const a = await wsProbe(wsUrl);
  if (a.ws.readyState !== 1) { fail(`fuzz: could not open ${wsUrl} (${a.error || JSON.stringify(a.closed)})`); return res; }
  a.send('not json at all');
  a.send('{}');
  a.send('[1,2,3]');
  a.send('null');
  a.json({ t: 'in', seq: 1, mx: 0, mz: 0, b: 0 });
  a.json({ t: 'start' });
  a.send(new Uint8Array([0, 1, 2, 3, 255, 254]));
  await sleep(600);
  res.garbageBeforeHello = { closed: a.closed, replies: a.msgs.map((m) => m.t) };
  a.close();

  // 2) a real session in a throwaway room with bad config + absurd input values
  const b = await wsProbe(wsUrl);
  if (b.ws.readyState !== 1) { fail('fuzz: second connection failed to open'); return res; }
  b.json({ t: 'hello', name: '<b>X</b>' + 'X'.repeat(300), room: 'qa-fuzz' });
  const welcome = await b.waitFor((m) => m.t === 'welcome', 3000);
  if (!welcome) { fail('fuzz: no welcome for hello with a 300-char name'); b.close(); return res; }
  const lob = await b.waitFor((m) => m.t === 'lobby', 2000);
  const meName = lob && Array.isArray(lob.clients) ? (lob.clients.find((c) => c.id === welcome.id) || {}).name : undefined;
  res.longName = { length: typeof meName === 'string' ? meName.length : null, value: meName };
  if (typeof meName === 'string' && meName.length > 16) warn(`server did not sanitize a long name to <= 16 chars (got ${meName.length})`);
  b.json({ t: 'pick', team: 7 });
  b.json({ t: 'pick', team: '0' });
  b.json({ t: 'pick' });
  b.json({ t: 'config', teams: [0, 0], periodLength: 7, difficulty: 9 });
  b.json({ t: 'config', teams: [99, -1], periodLength: 'x' });
  b.json({ t: 'config' });
  b.json({ t: 'ping' });
  b.json({ t: 'ping', c: 'abc' });
  b.json({ t: 'nonsense', x: 1 });
  b.json({ t: 'pick', team: 0 });
  b.json({ t: 'config', teams: [2, 3], periodLength: 60, difficulty: 2 });
  b.json({ t: 'start' });
  const firstSnap = await b.waitFor((m) => m.t === 'snap', 4000);
  if (!firstSnap) warn('fuzz: no snaps in the qa-fuzz room after a valid config + start');
  const evil = [
    { t: 'in', seq: 1, mx: 1e308, mz: -1e308, b: 255 },
    { t: 'in', seq: 'x', mx: '1', mz: null, b: -1 },
    { t: 'in', seq: 3, mx: 50, mz: -50, b: 15 },
    { t: 'in', seq: 4, mx: {}, mz: [], b: 'all' },
    { t: 'in', seq: 5 },
    { t: 'in', seq: 6, mx: 1, mz: 0, b: 1.5e9 },
  ];
  const tEnd = performance.now() + 2500;
  let i = 0;
  while (performance.now() < tEnd && b.ws.readyState === 1) {
    b.json(evil[i++ % evil.length]);
    await sleep(16);
  }
  b.send('{"t":"in","seq":7,"mx":0.5,"mz":0.5,"b":0,"pad":"' + 'p'.repeat(70000) + '"}');   // 64-bit length frame
  await sleep(800);
  const snaps = b.msgs.filter((m) => m.t === 'snap');
  const lastSnaps = snaps.slice(-10);
  const bad = [];
  for (const s of lastSnaps) for (const e of validateSnapshot(s).errors) bad.push(e);
  res.absurdInput = { snaps: snaps.length, invalidAfter: [...new Set(bad)].slice(0, 10), stillOpen: b.ws.readyState === 1, closed: b.closed };
  if (bad.length) fail(`absurd input values (mx=1e308, strings, nulls) corrupted the simulation: ${[...new Set(bad)].slice(0, 3).join('; ')}`);
  res.errReplies = b.msgs.filter((m) => m.t === 'err').map((m) => m.msg).slice(0, 12);
  b.json({ t: 'lobby' });
  await sleep(200);
  b.close();

  // 3) the server must still serve a fresh client
  const c = await wsProbe(wsUrl);
  c.json({ t: 'hello', name: 'probe', room: 'qa-fuzz-after' });
  const w2 = await c.waitFor((m) => m.t === 'welcome', 3000);
  c.json({ t: 'ping', c: 123.5 });
  const pong = await c.waitFor((m) => m.t === 'pong', 3000);
  res.afterFuzz = { welcome: !!w2, pong: pong ? { c: pong.c, s: pong.s } : null };
  if (!w2 || !pong) fail('server stopped answering (welcome/pong) after the robustness probes');
  else if (pong.c !== 123.5) fail(`pong.c does not echo ping.c (sent 123.5, got ${JSON.stringify(pong.c)})`);
  c.close();
  report.checks.fuzz = res;
  return res;
}

// ---------------------------------------------------------------- main

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (o.help) {
    console.log('usage: node test/e2e.js [--seconds 30] [--bots 3] [--browser path | env BROWSER] [--out dir] [--hud-selector css]\n' +
      '                         [--no-fuzz] [--keep-profile] [--headful] [--sim test/fake-sim.js] [--attach-port N]');
    return;
  }
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(o.out || path.join(BASE_OUT, `e2e-${runId}`));
  fs.mkdirSync(outDir, { recursive: true });
  logStream = fs.createWriteStream(path.join(outDir, 'e2e.log'));
  const profileDir = path.join(outDir, 'browser-profile');
  const report = {
    ok: false, startedAt: new Date().toISOString(), outDir, options: o, failures: [], warnings: [],
    checks: {}, server: {}, browser: {}, bots: null, screenshots: [], files: {},
  };
  const fail = (m) => { report.failures.push(m); log(`FAIL: ${m}`); };
  const warn = (m) => { if (!report.warnings.includes(m)) { report.warnings.push(m); log(`warn: ${m}`); } };

  let srv = null, srvLog = [], srvExpectedExit = false;
  let browser = null, cdp = null, page = null, swarm = null;

  try {
    // ---- 1. syntax check
    const files = [...listJs(path.join(ROOT, 'server')), ...listJs(path.join(ROOT, 'shared')), ...listJs(path.join(ROOT, 'public'))];
    const syntax = [];
    for (const f of files) {
      try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe', windowsHide: true }); }
      catch (e) { const msg = String(e.stderr || e.message).trim().split('\n').slice(0, 6).join(' | '); syntax.push({ file: path.relative(ROOT, f), error: msg }); fail(`syntax error in ${path.relative(ROOT, f)}: ${msg}`); }
    }
    report.checks.syntax = { files: files.length, errors: syntax };
    const missing = [];
    for (const req of ['server/server.js', 'shared/sim.js', 'public/index.html', 'public/main.js', 'public/render/renderer.js']) {
      if (!fs.existsSync(path.join(ROOT, req))) {
        if (req === 'shared/sim.js' && o.sim) { warn(`shared/sim.js missing - running the server with --sim ${o.sim}`); continue; }
        missing.push(req); fail(`missing ${req}`);
      }
    }
    if (missing.length && !o.attachPort) throw new Error(`preflight failed: missing ${missing.join(', ')}`);

    // ---- 2. server (spawned, or --attach-port to test one that is already running)
    const port = o.attachPort || await freePort();
    const base = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    report.server.port = port;
    if (o.attachPort) {
      log(`attaching to an already running server on ${base} (server log / crash checks skipped)`);
      report.server.attached = true;
    } else {
      const srvLogPath = path.join(outDir, 'server.log');
      const srvLogStream = fs.createWriteStream(srvLogPath);
      report.files.serverLog = srvLogPath;
      const srvArgs = ['server/server.js', '--port', String(port), '--host', '127.0.0.1', ...(o.sim ? ['--sim', o.sim] : [])];
      report.server.cmd = `node ${srvArgs.join(' ')}`;
      log(`starting server: ${report.server.cmd}`);
      srv = spawn(process.execPath, srvArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      children.set(srv.pid, 'server');
      const onSrvData = (stream) => (d) => {
        const text = d.toString();
        srvLogStream.write(text);
        for (const line of text.split(/\r?\n/)) if (line.trim()) { srvLog.push(`[${stream}] ${line}`); if (srvLog.length > 5000) srvLog.shift(); }
      };
      srv.stdout.on('data', onSrvData('out'));
      srv.stderr.on('data', onSrvData('err'));
      srv.on('exit', (code, sig) => {
        children.delete(srv.pid);
        report.server.exit = { code, signal: sig };
        if (!srvExpectedExit) fail(`server process exited unexpectedly (code ${code}, signal ${sig}). Last log lines:\n    ${srvLog.slice(-15).join('\n    ')}`);
      });
    }
    const up = await waitFor(async () => {
      if (report.server.exit) return 'dead';
      const r = await httpGet(port, '/', 1000);
      return r.status === 200 ? r : null;
    }, 15000, 200);
    if (!up || up === 'dead') throw new Error(`server did not serve GET / within 15 s${up === 'dead' ? ' (it exited)' : ''}`);
    log(`server up (GET / -> 200, ${up.headers['content-type']})`);

    // ---- 2b. static checks
    const statics = {};
    const expectType = async (p, re) => {
      const r = await httpGet(port, p);
      statics[p] = { status: r.status, type: r.headers?.['content-type'] };
      if (r.status !== 200) fail(`GET ${p} -> ${r.status} ${r.error || ''}`);
      else if (re && !re.test(r.headers['content-type'] || '')) fail(`GET ${p} served with Content-Type '${r.headers['content-type']}' (module scripts need a JavaScript MIME type)`);
      return r;
    };
    if (!/text\/html/.test(up.headers['content-type'] || '')) fail(`GET / Content-Type is '${up.headers['content-type']}', expected text/html`);
    await expectType('/shared/constants.js', /javascript/);
    if (!o.sim) await expectType('/shared/sim.js', /javascript/);
    await expectType('/main.js', /javascript/);
    await expectType('/render/renderer.js', /javascript/);
    await expectType('/vendor/three.module.min.js', /javascript/);
    const nf = await httpGet(port, '/definitely-not-here-' + runId + '.js');
    statics['404'] = { status: nf.status };
    if (nf.status !== 404) warn(`GET of a missing file returned ${nf.status}, expected 404`);
    const malformed = await httpGet(port, '/%E0%A4%A');
    statics.malformed = { status: malformed.status, error: malformed.error };
    const traversal = [];
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/shared/../package.json', '/shared/%2e%2e/package.json',
      '/%2e%2e%2fpackage.json', '/..%5cpackage.json', '/shared/..%5c..%5cpackage.json', '/%5c..%5cpackage.json',
      '/shared/%2e%2e%2fserver%2fserver.js', '/..%2f..%2fserver/server.js', '/%2e%2e%5cserver%5cserver.js']) {
      const r = await httpGet(port, p);
      const leaked = r.status === 200 && /"name":\s*"ice-riot"|createServer|import /.test(r.body.toString('utf8', 0, 4000)) && !/<html/i.test(r.body.toString('utf8', 0, 400));
      traversal.push({ path: p, status: r.status, leaked });
      if (leaked) fail(`path traversal: GET ${p} -> 200 and served a file outside public/ + shared/`);
    }
    statics.traversal = traversal;
    report.checks.static = statics;
    if (report.server.exit) throw new Error('server died during static checks');

    // ---- 3. robustness probes
    if (o.fuzz) {
      log('robustness probes over /ws (rooms qa-fuzz*)');
      await fuzzServer(wsUrl, report, fail, warn);
      if (report.server.exit) throw new Error('server died during the robustness probes');
    }

    // ---- 4. headless browser (Vivaldi by default) + CDP
    if (!fs.existsSync(o.browser)) throw new Error(`browser not found at ${o.browser} (set env BROWSER or pass --browser)`);
    const dt = await freePort();
    const browserArgs = [
      ...(o.headful ? [] : ['--headless=new']),
      '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
      `--remote-debugging-port=${dt}`, '--remote-allow-origins=*', `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      // Vivaldi's own UI eats ~63x126 px even headless: oversize the window, emulate VIEW_W x VIEW_H
      // and clip screenshots to it (otherwise captures come out tiled / repeated).
      `--window-size=${VIEW_W + 400},${VIEW_H + 400}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ];
    const brErrPath = path.join(outDir, 'browser-stderr.log');
    report.files.browserStderr = brErrPath;
    const brErr = fs.createWriteStream(brErrPath);
    browser = spawn(o.browser, browserArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.set(browser.pid, 'browser');
    report.browser.exe = o.browser;
    report.browser.pid = browser.pid;
    browser.stdout.on('data', (d) => brErr.write(d));
    browser.stderr.on('data', (d) => brErr.write(d));
    browser.on('error', (e) => { report.browser.spawnError = e.message; });
    browser.on('exit', (code) => { children.delete(browser.pid); report.browser.exit = code; });
    const ver = await waitFor(async () => {
      try { return await (await fetch(`http://127.0.0.1:${dt}/json/version`)).json(); } catch { return null; }
    }, 20000, 250);
    if (!ver || !ver.webSocketDebuggerUrl) throw new Error(`browser DevTools endpoint did not come up on port ${dt} within 20 s`);
    report.browser.version = ver.Browser;
    // Browser-level socket + flattened page session. Vivaldi opens new targets paused (waiting for
    // the debugger), so release the page FIRST (without awaiting) or every Runtime/Page call hangs.
    cdp = await CDP.connect(ver.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: false });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    page = cdp.session(sessionId);
    page.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    await sleep(300);
    await page.send('Page.navigate', { url: 'about:blank' });
    log(`attached to ${ver.Browser || 'browser'} over CDP (port ${dt}, pid ${browser.pid})`);

    // collectors
    const consoleMsgs = [], exceptions = [], netFails = [], reqUrls = new Map();
    const gameSockets = new Set();
    const ew = { welcome: null, lobby: null, lobbyCount: 0, snaps: 0, snapTs: [], firstSnapAt: 0, gameAt: 0, inFrames: [], inCount: 0, pings: 0, pongs: 0, errs: [], closed: 0, other: {}, lastSnap: null };
    const isIgnorable = (url = '', text = '') => /favicon\.ico/.test(url) || /favicon\.ico/.test(text) ||
      BROWSER_NOISE.test(String(url)) || BROWSER_NOISE.test(String(text));
    page.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.unserializableValue || a.type)).join(' ');
      const fr = p.stackTrace?.callFrames?.[0];
      const at = fr ? `${fr.url}:${fr.lineNumber + 1}:${fr.columnNumber + 1}` : '';
      consoleMsgs.push({ type: p.type, text: text.slice(0, 1000), at });
      if ((p.type === 'error' || p.type === 'assert') && !isIgnorable(at, text)) log(`console.${p.type}: ${text.slice(0, 300)}`);
    });
    page.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      const desc = d.exception?.description || d.text;
      if (isIgnorable(d.url, desc)) return;
      exceptions.push({ text: d.text, description: desc, url: d.url, line: (d.lineNumber ?? -1) + 1, column: (d.columnNumber ?? -1) + 1 });
      log(`page exception: ${String(desc).split('\n').slice(0, 4).join(' | ')} @ ${d.url}:${(d.lineNumber ?? -1) + 1}`);
    });
    page.on('Log.entryAdded', ({ entry }) => {
      if (!entry) return;
      consoleMsgs.push({ type: `log.${entry.level}`, text: String(entry.text).slice(0, 1000), at: entry.url ? `${entry.url}:${entry.lineNumber ?? ''}` : '', source: entry.source });
      if (entry.level === 'error' && !isIgnorable(entry.url, entry.text)) log(`log.error (${entry.source}): ${String(entry.text).slice(0, 300)} ${entry.url || ''}`);
    });
    page.on('Network.requestWillBeSent', (p) => reqUrls.set(p.requestId, p.request.url));
    page.on('Network.responseReceived', (p) => {
      const r = p.response;
      if (r.status >= 400 && !isIgnorable(r.url)) netFails.push({ url: r.url, status: r.status });
      if (p.type === 'Script' && r.status === 200 && !/javascript|ecmascript/.test(r.mimeType)) netFails.push({ url: r.url, status: r.status, mime: r.mimeType });
    });
    page.on('Network.loadingFailed', (p) => {
      const url = reqUrls.get(p.requestId) || '?';
      if (!p.canceled && !isIgnorable(url)) netFails.push({ url, error: p.errorText });
    });
    page.on('Network.webSocketCreated', (p) => { if (/\/ws(\?|$)/.test(p.url)) gameSockets.add(p.requestId); });
    page.on('Network.webSocketClosed', (p) => { if (gameSockets.has(p.requestId)) { ew.closed++; log('page game WebSocket closed'); } });
    page.on('Network.webSocketFrameError', (p) => { if (gameSockets.has(p.requestId)) ew.errs.push(p.errorMessage); });
    page.on('Network.webSocketFrameReceived', (p) => {
      if (!gameSockets.has(p.requestId) || p.response.opcode !== 1) return;
      let m; try { m = JSON.parse(p.response.payloadData); } catch { ew.errs.push('bad JSON from server'); return; }
      const now = performance.now();
      if (m.t === 'snap') {
        ew.snaps++; ew.snapTs.push(p.timestamp); ew.lastSnap = m;
        if (!ew.firstSnapAt) ew.firstSnapAt = now;
        if (!ew.gameAt) ew.gameAt = now;
      } else if (m.t === 'welcome') { ew.welcome = m; log(`page welcomed: client id ${m.id}, room ${m.room}`); }
      else if (m.t === 'lobby') {
        ew.lobby = m; ew.lobbyCount++;
        if (m.state === 'game' && !ew.gameAt) ew.gameAt = now;
      } else if (m.t === 'pong') ew.pongs++;
      else if (m.t === 'err') { ew.errs.push(`server err: ${m.msg}`); log(`page got err: ${m.msg}`); }
      else ew.other[m.t] = (ew.other[m.t] || 0) + 1;
    });
    page.on('Network.webSocketFrameSent', (p) => {
      if (!gameSockets.has(p.requestId) || p.response.opcode !== 1) return;
      let m; try { m = JSON.parse(p.response.payloadData); } catch { return; }
      if (m.t === 'in') {
        ew.inCount++;
        ew.inFrames.push({ at: performance.now(), mx: m.mx, mz: m.mz, b: m.b, seq: m.seq });
        if (ew.inFrames.length > 6000) ew.inFrames.splice(0, 1000);
      } else if (m.t === 'ping') ew.pings++;
    });
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Network.enable');
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });
    let loaded = false;
    page.on('Page.loadEventFired', () => { loaded = true; });

    const pageUrl = `${base}/?name=${encodeURIComponent(o.name)}&team=${o.team}&autostart=1`;
    report.browser.url = pageUrl;
    log(`navigating to ${pageUrl}`);
    await page.send('Page.navigate', { url: pageUrl });
    if (!(await waitFor(() => loaded, 30000))) fail('page load event did not fire within 30 s');

    // screenshots / probes
    let shotN = 0, prevImg = null;
    const shots = [];
    const hudProbe = async () => {
      const expr = `(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05; };
        let cands = [];
        try { cands = [...document.querySelectorAll(${JSON.stringify(o.hudSelector)})]; } catch (e) { return { error: String(e) }; }
        const visible = cands.filter(vis).filter((e) => (e.innerText || '').trim().length > 0);
        return {
          candidates: cands.length,
          visible: visible.slice(0, 8).map((e) => ({ tag: e.tagName, id: e.id, cls: String(e.className).slice(0, 80), text: (e.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 160) })),
          canvases: [...document.querySelectorAll('canvas')].map((c) => ({ id: c.id, w: c.width, h: c.height, visible: vis(c) })),
          title: document.title,
        };
      })()`;
      try {
        const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 10000);
        return r.result?.value || { error: r.exceptionDetails?.text };
      } catch (e) { return { error: e.message }; }
    };
    const shot = async (name) => {
      const at = ew.gameAt ? +((performance.now() - ew.gameAt) / 1000).toFixed(1) : null;
      let data;
      // Let the page present two fresh frames first (software GL can be slow; a capture taken
      // mid-composite shows stale / tiled content).
      try {
        await page.send('Runtime.evaluate', {
          expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))',
          awaitPromise: true, returnByValue: true,
        }, 10000);
      } catch { /* capture anyway */ }
      try {
        data = (await page.send('Page.captureScreenshot', {
          format: 'png', clip: { x: 0, y: 0, width: VIEW_W, height: VIEW_H, scale: 1 },
        }, 30000)).data;
      }
      catch (e) { fail(`screenshot '${name}' failed: ${e.message}`); return null; }
      const buf = Buffer.from(data, 'base64');
      const file = path.join(outDir, `${String(++shotN).padStart(2, '0')}-${name}.png`);
      fs.writeFileSync(file, buf);
      const img = decodePng(buf);
      const stats = img ? imageStats(img) : null;
      const diffPrev = img && prevImg ? imageDiff(prevImg, img) : null;
      prevImg = img || prevImg;
      const hud = await hudProbe();
      const entry = { name, file, gameSeconds: at, stats, diffFromPrevious: diffPrev, hud };
      shots.push(entry);
      report.screenshots.push(entry);
      log(`screenshot ${file}  luma=${stats?.meanLuma} std=${stats?.stdLuma} colors=${stats?.colors} diff=${diffPrev} hud=${hud.visible ? hud.visible.length : hud.error}`);
      return entry;
    };

    await sleep(1500);
    await shot('loaded');

    // ---- 5. wait for the page to join + autostart
    if (!(await waitFor(() => ew.welcome, 15000))) fail('page never received a welcome over /ws (did main.js connect?)');
    const pageId = ew.welcome?.id;
    report.browser.clientId = pageId;
    const autoStarted = await waitFor(() => ew.gameAt, 10000);
    report.browser.hostAtJoin = ew.lobby ? ew.lobby.host === pageId : null;
    if (ew.lobby && ew.lobby.host !== pageId) warn(`page is not the host (host=${ew.lobby.host}, page=${pageId}) - autostart cannot work`);
    if (!autoStarted) warn('page did not autostart the game within 10 s (?autostart=1); bots will try to start it if one of them is host');
    else log(`game running (autostart by page): first snap ${ew.firstSnapAt ? 'received' : 'pending'}`);

    // ---- 6. bots drop in
    const room = ew.welcome?.room || 'main';
    log(`starting ${o.bots} bots in room '${room}'`);
    swarm = startBots({
      url: wsUrl, bots: o.bots, room, seconds: o.seconds + 6, start: true, teamStart: o.team === 0 ? 1 : 0,
      name: 'QA', quiet: true, log: (l) => log(`bots: ${l}`), period: 60,
    });
    if (!(await waitFor(() => ew.gameAt, 12000))) fail('game never started (no lobby.state=game and no snaps reached the page)');
    const gameAt = ew.gameAt || performance.now();
    const untilGame = async (sec) => { const ms = gameAt + sec * 1000 - performance.now(); if (ms > 0) await sleep(ms); };

    await untilGame(2.5);
    await shot('game-start');
    // keyboard probe: hold ArrowRight then ArrowUp; the page should send `in` with mx>0 then mz<0
    const keyProbe = { right: null, up: null };
    const holdKey = async (key, code, vk, ms) => {
      const t0 = performance.now();
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(ms);
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      const t1 = performance.now();
      return ew.inFrames.filter((f) => f.at >= t0 && f.at <= t1 + 50);
    };
    try {
      await page.send('Page.bringToFront');
      const r = await holdKey('ArrowRight', 'ArrowRight', 39, 900);
      keyProbe.right = { frames: r.length, maxMx: r.length ? Math.max(...r.map((f) => Number(f.mx) || 0)) : null };
      const u = await holdKey('ArrowUp', 'ArrowUp', 38, 900);
      keyProbe.up = { frames: u.length, minMz: u.length ? Math.min(...u.map((f) => Number(f.mz) || 0)) : null };
    } catch (e) { keyProbe.error = e.message; }
    report.checks.keyboard = keyProbe;
    // public/input.js maps ArrowRight -> +mx and ArrowUp -> -mz (contract: up key = -Z).
    if (keyProbe.error) warn(`keyboard probe failed: ${keyProbe.error}`);
    else if (keyProbe.right && keyProbe.right.frames === 0) fail('page sent no `in` frames while in a game');
    else {
      if (!(keyProbe.right.maxMx > 0.5)) fail(`holding ArrowRight never produced in.mx > 0.5 (max ${keyProbe.right.maxMx}) - keyboard input does not reach the server`);
      if (keyProbe.up && !(keyProbe.up.minMz < -0.5)) fail(`holding ArrowUp never produced in.mz < -0.5 (min ${keyProbe.up.minMz}); contract: up key = -Z`);
    }
    log(`keyboard probe: ${JSON.stringify(keyProbe)}`);

    await untilGame(8);
    await shot('game-8s');
    try {
      const r = await page.send('Runtime.evaluate', {
        expression: `new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(f); })`,
        awaitPromise: true, returnByValue: true,
      }, 15000);
      report.browser.fps = +Number(r.result?.value).toFixed(1);
      log(`page rAF rate: ${report.browser.fps} fps (software WebGL)`);
      if (report.browser.fps < 5) warn(`page renders at only ${report.browser.fps} fps under SwiftShader`);
    } catch (e) { warn(`fps probe failed: ${e.message}`); }
    await untilGame(Math.min(16, o.seconds * 0.6));
    await shot('game-mid');
    await untilGame(o.seconds);
    await shot('game-end');

    // ---- 7. collect
    const botRes = await swarm.done;
    swarm = null;
    report.bots = botRes;
    console.log(formatSummary(botRes));
    for (const p of botRes.problems) fail(`bots: ${p}`);

    // page-side network stats
    const ts = ew.snapTs;
    const snapRate = ts.length > 1 ? (ts.length - 1) / (ts[ts.length - 1] - ts[0]) : 0;
    const inF = ew.inFrames;
    const inRate = inF.length > 1 ? (inF.length - 1) / ((inF[inF.length - 1].at - inF[0].at) / 1000) : 0;
    const gapsMs = ts.slice(1).map((t, i) => (t - ts[i]) * 1000).sort((a, b) => a - b);
    report.browser.ws = {
      clientId: pageId, room, snaps: ew.snaps, snapsPerSec: +snapRate.toFixed(2),
      snapGapP95Ms: gapsMs.length ? +gapsMs[Math.ceil(gapsMs.length * 0.95) - 1].toFixed(1) : null,
      inFrames: ew.inCount, inPerSec: +inRate.toFixed(1), pingsSent: ew.pings, pongs: ew.pongs, errors: ew.errs, closed: ew.closed,
      lastLobby: ew.lobby, finalScore: ew.lastSnap?.sc, lastPhase: ew.lastSnap?.ph,
    };
    let badIn = 0, seqBack = 0;
    for (let i = 0; i < inF.length; i++) {
      const f = inF[i];
      const okNum = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -1 && x <= 1;
      if (!okNum(f.mx) || !okNum(f.mz) || !Number.isInteger(f.b) || f.b < 0 || f.b > 15) badIn++;
      if (i && Number.isFinite(f.seq) && Number.isFinite(inF[i - 1].seq) && f.seq <= inF[i - 1].seq) seqBack++;
    }
    report.browser.ws.inMalformed = badIn;
    report.browser.ws.inSeqNotIncreasing = seqBack;
    if (badIn) fail(`page sent ${badIn} malformed 'in' message(s) (mx/mz must be numbers in [-1,1], b a 4-bit int)`);
    if (seqBack) warn(`page 'in'.seq did not increase ${seqBack} time(s)`);
    if (ew.snaps === 0) fail('page received no snaps');
    else if (snapRate < 20) warn(`page received only ${snapRate.toFixed(1)} snaps/s`);
    if (inRate > 75) fail(`page sends ${inRate.toFixed(1)} 'in' msgs/s (contract: throttled to <= 60/s)`);
    if (ew.pings === 0) warn('page never sent a ping (lobby ping column / clock sync need it)');
    if (ew.closed) fail(`page game WebSocket closed ${ew.closed} time(s) during the test`);
    for (const e of ew.errs) warn(`page ws: ${e}`);

    // console / exceptions / network
    const errorsOnly = consoleMsgs.filter((m) => (m.type === 'error' || m.type === 'assert' || m.type === 'log.error') && !isIgnorable(m.at, m.text));
    report.browser.console = { total: consoleMsgs.length, errors: errorsOnly, warnings: consoleMsgs.filter((m) => m.type === 'warning' || m.type === 'log.warning').slice(0, 30), all: consoleMsgs.slice(0, 300) };
    report.browser.exceptions = exceptions;
    report.browser.networkFailures = netFails;
    for (const ex of exceptions) fail(`uncaught page exception: ${String(ex.description).split('\n').slice(0, 3).join(' | ')} @ ${ex.url}:${ex.line}:${ex.column}`);
    const grouped = new Map();   // identical errors (e.g. one per frame) -> one failure line with a count
    for (const e of errorsOnly) {
      const key = `${e.type}|${e.text}|${e.at}`;
      if (grouped.has(key)) grouped.get(key).n++; else grouped.set(key, { e, n: 1 });
    }
    for (const { e, n } of [...grouped.values()].slice(0, 10)) {
      fail(`page console ${e.type}${n > 1 ? ` (x${n})` : ''}: ${e.text.slice(0, 400)} ${e.at}`);
    }
    if (grouped.size > 10) fail(`... and ${grouped.size - 10} more distinct console errors`);
    for (const n of netFails) fail(`request failed: ${n.url} ${n.status || ''} ${n.error || ''} ${n.mime ? `(mime ${n.mime})` : ''}`);

    // HUD + visuals
    const gameShots = shots.filter((s) => s.name.startsWith('game'));
    const hudSeen = gameShots.some((s) => s.hud.visible && s.hud.visible.length > 0);
    report.checks.hud = { selector: o.hudSelector, seen: hudSeen, samples: gameShots.map((s) => s.hud) };
    if (!hudSeen) fail(`HUD never appeared (no visible element with text matching '${o.hudSelector}' during the game)`);
    const hudTexts = gameShots.map((s) => {
      const v = s.hud.visible || [];
      return (v.find((e) => /scoreboard/.test(e.cls)) || v[v.length - 1] || {}).text;
    }).filter(Boolean);
    report.checks.hud.texts = hudTexts;
    if (hudTexts.length >= 2 && new Set(hudTexts).size === 1) warn(`HUD text never changed during the game ('${hudTexts[0]}') - clock not ticking?`);
    const blank = gameShots.filter((s) => s.stats && s.stats.blank);
    if (blank.length) fail(`canvas looks blank in ${blank.map((s) => path.basename(s.file)).join(', ')} (WebGL not rendering?)`);
    const motion = gameShots.slice(1).map((s) => s.diffFromPrevious).filter((d) => d !== null);
    if (motion.length && motion.every((d) => d < 0.002)) warn('game screenshots are (nearly) identical - nothing moves on screen?');

    // server log: stack traces / uncaught errors
    const bad = srvLog.filter((l) => /(TypeError|ReferenceError|RangeError|SyntaxError|\buncaught\b|\bunhandled\b|\bthrew\b|ERR_[A-Z_]+|\bat .+:\d+:\d+\)?$)/i.test(l));
    report.server.errorLines = bad.slice(0, 40);
    if (bad.length) fail(`server log contains ${bad.length} error/stack-trace line(s), first: ${bad[0]}`);
    if (report.server.exit) fail('server is no longer running at the end of the test');
  } catch (e) {
    fail(`e2e aborted: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
  } finally {
    if (swarm) { swarm.stop(); try { report.bots = await swarm.done; } catch { /* ignore */ } }
    if (cdp) { try { await cdp.send('Browser.close', {}, 3000); } catch { /* ignore */ } cdp.close(); }
    await sleep(500);
    if (browser) killTree(browser.pid);   // only the tree WE spawned
    if (browser) sweepBrowser(o.browser, profileDir);
    srvExpectedExit = true;
    if (srv && srv.exitCode === null) killTree(srv.pid);
    killAllSync();
    report.server.logTail = srvLog.slice(-60);
    if (!o.keepProfile) {
      try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch (e) { log(`could not remove ${profileDir}: ${e.message}`); }
    }
    report.ok = report.failures.length === 0;
    report.finishedAt = new Date().toISOString();
    const reportPath = path.join(outDir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log('\n================ ICE RIOT e2e ================');
    console.log(`result: ${report.ok ? 'PASS' : `FAIL (${report.failures.length})`}`);
    for (const f of report.failures) console.log(`  FAIL ${f}`);
    for (const w of report.warnings) console.log(`  warn ${w}`);
    if (report.bots) {
      const a = report.bots.aggregate;
      console.log(`bots: snaps/s ${a.snapsPerSec}, rx ${(a.rxBytesPerSecInGame / 1024).toFixed(1)} KB/s/client, RTT ${a.rttMeanMs} ms (p95 ${a.rttP95Ms})`);
    }
    if (report.browser.ws) console.log(`page: snaps/s ${report.browser.ws.snapsPerSec}, in/s ${report.browser.ws.inPerSec}, fps ${report.browser.fps}`);
    console.log(`report:      ${reportPath}`);
    console.log(`server log:  ${report.files.serverLog || '-'}`);
    for (const s of report.screenshots) console.log(`screenshot:  ${s.file}`);
    if (logStream) logStream.end();
    process.exitCode = report.ok ? 0 : 1;
  }
}

main();
