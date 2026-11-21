// ICE RIOT - Tailscale helpers. Everything degrades gracefully: no Tailscale installed, daemon
// stopped, logged out, Serve not enabled on the tailnet... all come back as { ok/running: false, reason }.
//
// This module never runs `tailscale serve reset` and never replaces somebody else's serve
// handler: if https:443 "/" already proxies to something else it falls back to https:8443.

import { execFile, spawn } from 'node:child_process';

const CANDIDATES = {
  win32: ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'],
  darwin: ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'],
};

let cachedBin = null;

function run(bin, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Run the tailscale CLI, trying PATH first and then the usual install locations. */
async function tailscale(args, timeout = 3000) {
  const list = cachedBin ? [cachedBin] : CANDIDATES[process.platform] || ['tailscale'];
  let last = null;
  for (const bin of list) {
    const r = await run(bin, args, timeout);
    if (r.err && (r.err.code === 'ENOENT' || r.err.code === 'EACCES')) {
      last = r;
      continue;
    }
    cachedBin = bin;
    return { ...r, bin, found: true };
  }
  return { ...(last || { err: new Error('not found'), stdout: '', stderr: '' }), found: false };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const STATE_HINT = {
  NeedsLogin: 'Tailscale is logged out - run `tailscale up` (or sign in from the Tailscale app)',
  NeedsMachineAuth: 'this device is waiting for approval in the Tailscale admin console',
  Stopped: 'Tailscale is stopped - run `tailscale up` (or connect from the Tailscale app)',
  Starting: 'Tailscale is still starting - try again in a few seconds',
  NoState: 'Tailscale is not connected - run `tailscale up` (or connect from the Tailscale app)',
};

/**
 * -> { running, ips: string[], dnsName: string, hostName, magicDNS: boolean, reason: string }
 * `ips` lists IPv4 first. `dnsName` has no trailing dot ('' if unknown).
 */
export async function tailscaleStatus() {
  const r = await tailscale(['status', '--json']);
  const base = { running: false, ips: [], dnsName: '', hostName: '', magicDNS: false, reason: '' };
  if (!r.found) {
    return { ...base, reason: 'Tailscale CLI not found - install Tailscale from https://tailscale.com/download' };
  }
  // `status --json` may exit non-zero while still printing JSON (e.g. when stopped).
  const st = parseJson(r.stdout);
  if (!st) {
    const why = (r.stderr || r.stdout || r.err?.message || 'unknown error').trim().split(/\r?\n/)[0];
    const timedOut = r.err?.killed || r.err?.signal === 'SIGTERM';
    return { ...base, reason: timedOut ? 'tailscale status timed out (is the Tailscale service running?)' : `tailscale status failed: ${why}` };
  }
  const state = st.BackendState || 'unknown';
  const self = st.Self || {};
  const ips = [...(self.TailscaleIPs || st.TailscaleIPs || [])].sort((a, b) => (a.includes(':') ? 1 : 0) - (b.includes(':') ? 1 : 0));
  const dnsName = String(self.DNSName || '').replace(/\.$/, '');
  const magicDNS = st.CurrentTailnet ? st.CurrentTailnet.MagicDNSEnabled !== false : Boolean(dnsName);
  const running = state === 'Running';
  return {
    running,
    state,
    ips,
    dnsName,
    hostName: self.HostName || '',
    magicDNS,
    reason: running ? '' : STATE_HINT[state] || `Tailscale state is ${state} - run \`tailscale up\``,
  };
}

export function proxyTargetsPort(proxy, port) {
  const m = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?$/i.exec(String(proxy || '').trim());
  return Boolean(m && Number(m[1]) === Number(port));
}

/** Inspect `tailscale serve status --json` for one https port: 'free' | 'ours' | 'taken'. */
export function httpsPortState(cfg, httpsPort, port) {
  if (!cfg || typeof cfg !== 'object') return 'free';
  const tcp = cfg.TCP?.[String(httpsPort)];
  if (tcp && (tcp.TCPForward || tcp.TerminateTLS)) return 'taken';
  for (const [hostPort, web] of Object.entries(cfg.Web || {})) {
    if (!hostPort.endsWith(`:${httpsPort}`)) continue;
    const root = web?.Handlers?.['/'];
    if (!root) continue;
    return proxyTargetsPort(root.Proxy, port) ? 'ours' : 'taken';
  }
  return 'free';
}

/**
 * Expose http://127.0.0.1:<port> on the tailnet over HTTPS via `tailscale serve --bg`.
 * Resolves { ok, url, httpsPort, offCommand, reason, output }. Output lines from the CLI
 * (for example the "Serve is not enabled on your tailnet, visit https://login.tailscale.com/..."
 * prompt) are passed to onOutput as they arrive.
 */
export async function tailscaleServe(port, { onOutput = () => {}, timeoutMs = 120000, status } = {}) {
  const st = status || (await tailscaleStatus());
  if (!st.running) return { ok: false, reason: st.reason };
  if (!st.dnsName) return { ok: false, reason: 'this device has no MagicDNS name; enable MagicDNS + HTTPS certificates in the Tailscale admin console' };

  const cur = await tailscale(['serve', 'status', '--json']);
  const cfg = parseJson(cur.stdout) || {};
  let httpsPort = 0;
  for (const p of [443, 8443]) {
    const s = httpsPortState(cfg, p, port);
    if (s === 'ours') {
      return { ok: true, already: true, httpsPort: p, url: httpsUrl(st.dnsName, p), offCommand: offCommand(p) };
    }
    if (s === 'free') {
      httpsPort = p;
      break;
    }
  }
  if (!httpsPort) {
    return { ok: false, reason: 'https ports 443 and 8443 are already used by other `tailscale serve` handlers (left untouched)' };
  }

  const args = ['serve', '--bg'];
  if (httpsPort !== 443) args.push(`--https=${httpsPort}`);
  args.push(String(port));

  const bin = cachedBin || 'tailscale';
  const result = await new Promise((resolve) => {
    let output = '';
    let settled = false;
    let child;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, output });
    };
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return finish({ code: -1, error: err });
    }
    const onData = (buf) => {
      const text = buf.toString();
      output += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) onOutput(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => finish({ code: -1, error: err }));
    child.on('close', (code) => finish({ code }));
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -1, error: new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`) });
    }, timeoutMs);
    timer.unref?.();
  });

  if (result.code === 0) {
    return { ok: true, httpsPort, url: httpsUrl(st.dnsName, httpsPort), offCommand: offCommand(httpsPort), output: result.output };
  }
  const first = (result.output || result.error?.message || '').trim().split(/\r?\n/).filter(Boolean).pop() || 'unknown error';
  return {
    ok: false,
    httpsPort,
    reason: `\`tailscale ${args.join(' ')}\` failed: ${first}`,
    output: result.output,
  };
}

export function httpsUrl(dnsName, httpsPort = 443) {
  return httpsPort === 443 ? `https://${dnsName}/` : `https://${dnsName}:${httpsPort}/`;
}

export function offCommand(httpsPort = 443) {
  return `tailscale serve --https=${httpsPort} off`;
}
