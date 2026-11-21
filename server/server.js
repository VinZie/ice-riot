#!/usr/bin/env node
// ICE RIOT - server entry point.
//
//   node server/server.js [--port 8765] [--host 0.0.0.0] [--serve]
//
//   --serve   also publish the game on your tailnet over HTTPS with `tailscale serve --bg`.
//             Binds to 127.0.0.1 unless --host is given (tailscale serve proxies to localhost,
//             so Windows Firewall never gets involved).

import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, GAME_NAME } from '../shared/constants.js';
import { createGameServer, ROOT_DIR } from './app.js';
import { createStatsStore } from './stats-store.js';
import { tailscaleStatus, tailscaleServe } from './tailnet.js';

const USAGE = `Usage: node server/server.js [--port N] [--host ADDR] [--serve]

  --port N      port to listen on (default: $PORT or ${DEFAULT_PORT})
  --host ADDR   address to bind (default: 0.0.0.0, or 127.0.0.1 with --serve)
  --serve       publish over HTTPS on your tailnet via \`tailscale serve --bg\`
  --sim PATH    (dev) load a different sim module, e.g. test/fake-sim.js
  --help        show this help`;

function ts() {
  return new Date().toTimeString().slice(0, 8);
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        serve: { type: 'boolean', default: false },
        sim: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const v = parsed.values;
  if (v.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const port = Number(v.port ?? process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${v.port ?? process.env.PORT}`);
    process.exit(2);
  }
  const host = v.host || (v.serve ? '127.0.0.1' : '0.0.0.0');
  return { port, host, serve: v.serve, hostGiven: Boolean(v.host), sim: v.sim };
}

function isTailscaleIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10 (CGNAT range used by Tailscale)
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal) continue;
      if (a.address.startsWith('169.254.') || isTailscaleIPv4(a.address)) continue;
      if (/tailscale/i.test(name)) continue;
      out.push(a.address);
    }
  }
  return [...new Set(out)];
}

async function loadSim(simPath) {
  const label = simPath || 'shared/sim.js';
  let sim;
  try {
    sim = simPath ? await import(pathToFileURL(path.resolve(simPath)).href) : await import('../shared/sim.js');
  } catch (err) {
    const notFound = err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(path.basename(label));
    console.error(notFound ? `\n${label} not found - the game simulation is missing.\n` : `\nCould not load ${label}:\n  ${err?.stack || err}\n`);
    process.exit(1);
  }
  const missing = ['createGame', 'step', 'snapshot', 'drainEvents', 'assignClient', 'releaseClient'].filter(
    (fn) => typeof sim[fn] !== 'function',
  );
  if (missing.length) {
    console.error(`\n${label} does not export: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  if (simPath) log(`using sim module ${label}`);
  return sim;
}

async function main() {
  const opts = parseCli();
  const tsPromise = tailscaleStatus().catch((err) => ({ running: false, ips: [], dnsName: '', reason: String(err?.message || err) }));
  const sim = await loadSim(opts.sim);

  let srv;
  try {
    // Career stats / leaderboard persist in data/stats.json (skipped for the dev fake sim).
    let stats = null;
    if (!opts.sim) {
      try {
        stats = createStatsStore(path.join(ROOT_DIR, 'data', 'stats.json'), { log });
      } catch (err) {
        log(`stats disabled: ${err?.message || err}`);
      }
    }
    srv = await createGameServer({ sim, port: opts.port, host: opts.host, log, stats });
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      console.error(`\nPort ${opts.port} is already in use - is ${GAME_NAME} already running? Try --port ${opts.port + 1}.\n`);
    } else if (err?.code === 'EACCES') {
      console.error(`\nNot allowed to listen on ${opts.host}:${opts.port} (${err.message}).\n`);
    } else {
      console.error(`\nFailed to start the server: ${err?.stack || err}\n`);
    }
    process.exit(1);
  }

  const port = srv.port;
  const tsInfo = await tsPromise;
  const loopbackOnly = opts.host === '127.0.0.1' || opts.host === 'localhost' || opts.host === '::1';
  const allIfaces = opts.host === '0.0.0.0' || opts.host === '::';
  const lines = [];
  const row = (label, value) => lines.push(`  ${label.padEnd(11)}${value}`);

  lines.push('', `  ${GAME_NAME} server is running   (Ctrl+C to stop)`, '  ' + '-'.repeat(46));
  row('Local:', `http://localhost:${port}/`);
  if (allIfaces) {
    lanAddresses().forEach((ip, i) => row(i === 0 ? 'LAN:' : '', `http://${ip}:${port}/`));
  } else if (!loopbackOnly) {
    row('Bound to:', `http://${opts.host}:${port}/`);
  }
  if (tsInfo.running) {
    if (loopbackOnly) {
      row('Tailscale:', `connected as ${tsInfo.dnsName || tsInfo.ips[0] || '?'} (direct http access disabled: bound to ${opts.host})`);
    } else if (allIfaces) {
      const urls = tsInfo.ips.filter((ip) => !ip.includes(':')).map((ip) => `http://${ip}:${port}/`);
      if (tsInfo.dnsName && tsInfo.magicDNS) urls.push(`http://${tsInfo.dnsName}:${port}/`);
      urls.forEach((u, i) => row(i === 0 ? 'Tailscale:' : '', u));
      lines.push('', '  Friends on your tailnet: open a Tailscale URL above. Add ?room=name for a private room.');
    }
  } else {
    row('Tailscale:', `not available - ${tsInfo.reason}`);
    lines.push('', '  Friends need Tailscale on the same tailnet. On this machine run `tailscale up`,', '  then restart this server to see your tailnet URLs.');
  }
  if (process.platform === 'win32' && !loopbackOnly) {
    lines.push(
      '',
      '  Windows: the first run shows a firewall prompt - allow Node.js on Private networks',
      '  (friends cannot connect otherwise). Or use `npm run serve`: tailscale serve proxies',
      '  to localhost, so no firewall rule is needed.',
    );
  }
  lines.push('');
  console.log(lines.join('\n'));

  if (opts.serve) {
    if (!tsInfo.running) {
      log(`--serve: skipped (${tsInfo.reason})`);
    } else {
      log(`--serve: running \`tailscale serve --bg ${port}\` ...`);
      tailscaleServe(port, { status: tsInfo, onOutput: (line) => log(`[tailscale] ${line}`) })
        .then((r) => {
          if (r.ok) {
            const msg = [
              '',
              `  Tailnet HTTPS: ${r.url}${r.already ? '   (already configured)' : ''}`,
              '  Share that link with friends on your tailnet.',
              `  It stays on after this server stops; turn it off with:  ${r.offCommand}`,
              '',
            ];
            console.log(msg.join('\n'));
          } else {
            log(`--serve: ${r.reason}`);
            if (!opts.hostGiven) log('--serve: falling back is easy: run `npm start` and share the http://100.x.y.z URL instead.');
          }
        })
        .catch((err) => log(`--serve failed: ${err?.message || err}`));
    }
  }

  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) {
      console.log('Forcing exit.');
      process.exit(1);
    }
    stopping = true;
    log(`${sig}: shutting down...`);
    const force = setTimeout(() => process.exit(0), 2000);
    force.unref();
    srv.close().then(() => {
      log('bye');
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // A casual game server is more useful alive: log unexpected errors instead of dying mid-match.
  process.on('uncaughtException', (err) => log(`uncaught exception: ${err?.stack || err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack || err}`));
}

main();
