// ICE RIOT - static file handler.  "/" -> public/, "/shared/*" -> shared/.
// GET/HEAD only, Cache-Control: no-cache, path traversal blocked, 404 otherwise.

import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
};

// Windows device names would open a device instead of a file.
const WIN_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\.|$)/i;

function sendText(res, status, text, headers = {}) {
  const body = `${status} ${text}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
    ...headers,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

/**
 * Resolve a URL pathname to a file inside one of the roots, or null if it is not allowed.
 * Exported for tests.
 */
export function resolveStaticPath(urlPath, { publicDir, sharedDir }) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (!pathname.startsWith('/') || pathname.includes('\0')) return null;

  let base;
  let rel;
  if (pathname === '/shared' || pathname.startsWith('/shared/')) {
    base = sharedDir;
    rel = pathname.slice('/shared'.length);
  } else {
    base = publicDir;
    rel = pathname;
  }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  const segments = rel.split(/[/\\]+/).filter(Boolean);
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || seg.startsWith('.')) return null; // traversal + dotfiles
    if (seg.includes(':')) return null; // drive letters, NTFS alternate data streams
    if (WIN_DEVICE.test(seg)) return null;
  }
  const full = path.resolve(base, ...segments);
  const root = path.resolve(base);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return { full, root };
}

export function createStaticHandler({ publicDir, sharedDir }) {
  const realRoots = new Map();
  async function realRoot(root) {
    if (!realRoots.has(root)) realRoots.set(root, await fsp.realpath(root).catch(() => root));
    return realRoots.get(root);
  }

  return async function handleStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }
    const raw = req.url || '/';
    const cut = raw.search(/[?#]/);
    const urlPath = cut === -1 ? raw : raw.slice(0, cut);
    const resolved = resolveStaticPath(urlPath, { publicDir, sharedDir });
    if (!resolved) return sendText(res, 404, 'Not Found');

    let file = resolved.full;
    let stat;
    try {
      stat = await fsp.stat(file);
      if (stat.isDirectory()) {
        if (!urlPath.endsWith('/')) {
          return sendText(res, 301, 'Moved Permanently', { Location: urlPath + '/' });
        }
        file = path.join(file, 'index.html');
        stat = await fsp.stat(file);
      }
      if (!stat.isFile()) return sendText(res, 404, 'Not Found');
      // Symlinks must not escape the root either.
      const real = await fsp.realpath(file);
      const rootReal = await realRoot(resolved.root);
      if (!real.startsWith(rootReal + path.sep)) return sendText(res, 404, 'Not Found');
    } catch {
      return sendText(res, 404, 'Not Found');
    }

    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'Last-Modified': stat.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };
}
