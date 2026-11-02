'use strict';

// Recall-quality eval: measures retrieval of the right context node for
// agent-style paraphrased queries. Compares bare token search against the
// hybrid semantic recall that `memhub_recall` / GET /api/recall serve.
//
// Run: npm run eval   (needs the local model; downloads once, then offline)
// Exit: 0 when hybrid recall@5 >= threshold AND beats token search.
//       Re-tune the blend in server/src/graph.js recall(), never the golden set,
//       unless the golden set itself was wrong.

const path = require('path');
const store = require('../server/src/store');
const graph = require('../server/src/graph');
const embed = require('../server/src/embed');
const golden = require('./golden.json');

const K = 5;
const MIN_RECALL = 0.95;

async function rankQueries(ranker) {
  let hits = 0;
  let mrr = 0;
  const misses = [];
  for (const g of golden) {
    const res = await ranker(g.q);
    const rank = res.findIndex((r) => r.id === g.expect);
    if (rank >= 0 && rank < K) {
      hits++;
      mrr += 1 / (rank + 1);
    } else {
      misses.push({ q: g.q, want: g.expect, got: res.slice(0, K).map((r) => r.id) });
    }
  }
  return { recall: hits / golden.length, mrr: mrr / golden.length, misses };
}

function pct(x) {
  return (x * 100).toFixed(1) + '%';
}

(async () => {
  store.setEmbedEngine({ embed: embed.embed, model: embed.EMBED_MODEL });
  store.load();

  const t0 = Date.now();
  await embed.embed('warmup');
  const st = embed.status();
  if (st.status !== 'ready') {
    console.error(`embedding engine not ready: ${st.status} (${st.error || 'no detail'})`);
    console.error('eval needs the local model; run without MEMHUB_NO_EMBED=1 and with network for the first download.');
    process.exit(2);
  }

  const nodeIds = Object.keys(store.getStore().nodes);
  const todo = nodeIds.filter((id) => store.needsEmbedding(id));
  for (const id of todo) await store.refreshEmbedding(id);
  store.saveNow();
  console.log(`vectors: ${nodeIds.length} nodes (${todo.length} embedded now) in ${Date.now() - t0}ms`);

  const token = await rankQueries(async (q) => graph.search(q, K));
  const hybrid = await rankQueries(async (q) => (await graph.recall(q, K, embed.embed)).results);

  console.log('');
  console.log(`retriever   recall@${K}   MRR`);
  console.log(`token       ${pct(token.recall).padStart(8)}   ${token.mrr.toFixed(3)}`);
  console.log(`hybrid      ${pct(hybrid.recall).padStart(8)}   ${hybrid.mrr.toFixed(3)}`);

  if (hybrid.misses.length) {
    console.log('\nhybrid misses:');
    for (const m of hybrid.misses) console.log(`- "${m.q}"  want ${m.want}  got ${m.got.join(', ')}`);
  }
  if (token.misses.length) {
    console.log('\ntoken misses (for contrast):');
    for (const m of token.misses) console.log(`- "${m.q}"  want ${m.want}  got ${m.got.join(', ')}`);
  }

  const ok = hybrid.recall >= MIN_RECALL && hybrid.recall >= token.recall;
  console.log(`\nthreshold: hybrid recall@${K} >= ${pct(MIN_RECALL)} and >= token baseline -> ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('eval error:', err && err.message ? err.message : err);
  process.exit(2);
});
