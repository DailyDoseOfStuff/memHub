const http = require('http');
const store = require('./store');
const api = require('./api');
const staticSrv = require('./static');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    api.handle(req, res, url).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: err && err.message ? err.message : String(err) }));
    });
  } else {
    try {
      staticSrv.handle(req, res, url);
    } catch (err) {
      res.writeHead(500);
      res.end('server error');
    }
  }
});

store.load();
const PORT = process.env.MEMHUB_PORT || 4777;
server.on('error', (err) => {
  console.error(`[memhub] ${err.code || 'error'}: ${err.message}`);
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.closeForExit();
    server.close();
    process.exit(0);
  });
}
server.listen(PORT, '127.0.0.1', () => {
  const s = store.getStore();
  console.log(`[memhub] http://127.0.0.1:${PORT} (nodes: ${Object.keys(s.nodes).length}, edges: ${s.edges.length})`);
});
