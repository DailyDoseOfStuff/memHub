const http = require('http');
const store = require('./store');
const api = require('./api');
const staticSrv = require('./static');
const embed = require('./embed');

store.setEmbedEngine({ embed: embed.embed, model: embed.EMBED_MODEL });

// Background backfill: vectors for nodes missing, stale, or edited while the
// model was loading/failing. Converges lazily, ui works meanwhile. Re-armed on
// an interval so MCP-only writes get vectors without a restart.
async function backfillVectors() {
  await embed.embed('__warmup__'); // blocks until load finished or failed
  if (embed.status().status !== 'ready') return;
  const stale = () => Object.values(store.getStore().nodes).filter((n) => store.needsEmbedding(n.id));
  for (let round = 0; round < 100; round++) {
    const batch = stale().slice(0, 64);
    if (!batch.length) return;
    const before = stale().length;
    await Promise.all(batch.map((n) => store.refreshEmbedding(n.id)));
    const after = stale().length;
    if (after >= before) break; // no progress this round: stop instead of burning inferences
    if (after) await new Promise((r) => setTimeout(r, 50)); // small pause between rounds only
  }
}

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
// Default bind: loopback only (local-by-design). Containers set MEMHUB_BIND=0.0.0.0.
const BIND = process.env.MEMHUB_BIND || '127.0.0.1';
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
server.listen(PORT, BIND, () => {
  const s = store.getStore();
  console.log(`[memhub] http://127.0.0.1:${PORT} (nodes: ${Object.keys(s.nodes).length}, edges: ${s.edges.length})`);
  backfillVectors();
  // ponytail: 60s sweep instead of a watch hook; lower it if MCP-only writes
  // need vectors faster than the next poll.
  const sweeper = setInterval(backfillVectors, 60000);
  if (sweeper.unref) sweeper.unref();
});
