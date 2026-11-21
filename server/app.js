// ICE RIOT - injectable server factory (used by server.js and the tests).
//
//   const srv = await createGameServer({ sim, port: 0, host: '127.0.0.1' });
//   srv.port; await srv.close();

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '../shared/constants.js';
import { createStaticHandler } from './static.js';
import { attachWebSocketServer } from './ws.js';
import { RoomManager } from './room.js';
import { handleStatsRequest } from './stats-store.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function createGameServer({
  sim,
  port = DEFAULT_PORT,
  host = '0.0.0.0',
  log = () => {},
  rootDir = ROOT_DIR,
  heartbeatMs,
  timeoutMs,
  maxMessage,
  gameOverLingerMs = 12000,
  stats = null, // optional stats store (server/stats-store.js createStatsStore); tests leave it null
} = {}) {
  const rooms = new RoomManager({ sim, log, gameOverLingerMs, stats });
  const handleStatic = createStaticHandler({
    publicDir: path.join(rootDir, 'public'),
    sharedDir: path.join(rootDir, 'shared'),
  });

  const server = http.createServer((req, res) => {
    if (stats && handleStatsRequest(req, res, stats)) return; // /api/leaderboard, /api/recent, /api/player
    handleStatic(req, res).catch((err) => {
      log(`static error for ${req.url}: ${err?.message || err}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('500 Internal Server Error\n');
    });
  });
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  const wss = attachWebSocketServer(server, {
    path: '/ws',
    heartbeatMs,
    timeoutMs,
    maxMessage,
    onConnection: (conn) => rooms.handleConnection(conn),
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', (err) => log(`http server error: ${err?.message || err}`));

  let closing = null;
  return {
    port: server.address().port,
    host,
    server,
    rooms,
    wss,
    close() {
      closing ||= new Promise((resolve) => {
        rooms.close();
        try { stats?.close(); } catch (err) { log(`stats close error: ${err?.message || err}`); }
        wss.close(1001, 'server shutting down');
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => {
          server.closeAllConnections?.();
          wss.terminateAll();
        }, 300).unref();
      });
      return closing;
    },
  };
}
