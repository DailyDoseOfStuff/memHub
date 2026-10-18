'use strict';

const fs = require('fs');
const path = require('path');

const WEB_DIR = path.join(__dirname, '..', '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // Local tool serves editable files: no validators sent, so heuristic browser
  // caching would pin stale app.js/graph.js across edits. Revalidate always.
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

function handle(req, res, url) {
  try {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS });
      res.end('method not allowed');
      return true;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS });
      res.end('bad path encoding');
      return true;
    }

    if (pathname.includes('..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS });
      res.end('forbidden');
      return true;
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR + path.sep) && file !== WEB_DIR) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS });
      res.end('forbidden');
      return true;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS });
        res.end('not found');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...CORS });
      res.end(data);
    });
    return true;
  } catch {
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS });
      res.end('error');
    } catch {
      // headers already sent
    }
    return false;
  }
}

module.exports = { handle };
