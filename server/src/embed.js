'use strict';

// Node-side embeddings via transformers.js. Model: Xenova/all-MiniLM-L6-v2
// (Apache-2.0), 384 dims, quantized ONNX (~23MB). Downloads once into
// EMBED_CACHE; offline-safe afterwards. Every consumer degrades gracefully:
// embed() returns null while loading or on failure, callers keep working
// without vectors (positions/communities then fall back to type+edges).
// ponytail: one model, one pipeline object; swap to a bigger embedder only
// when MiniLM demonstrably misses domain matches.

const fs = require('fs');
const path = require('path');

const EMBED_DIM = 384;
const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBED_CACHE = path.join(process.env.MEMHUB_DATA || path.join(__dirname, '..', 'data'), 'llm-cache');

// Disabled mode skips the model entirely (tests, offline servers).
const DISABLED = process.env.MEMHUB_NO_EMBED === '1';

let pipePromise = null;
let tf = null;
let state = DISABLED ? 'failed' : 'loading'; // loading | ready | failed
let lastError = DISABLED ? 'disabled' : null;

function cleanError(err) {
  let s = String(err && err.message || err || '');
  s = s.replace(/[A-Za-z]:[\\/][^'"\r\n]*/g, '<cache>');
  s = s.replace(/\/(?:[\w.@+-]+\/){2,}[\w.@+-]+/g, '<cache>'); // POSIX paths
  return s.length > 200 ? s.slice(0, 200) : s;
}

function setStatus(s, err) {
  state = s;
  if (err) lastError = cleanError(err);
}

function loadPipe() {
  if (DISABLED) return Promise.resolve(null);
  if (pipePromise) return pipePromise;
  pipePromise = (async () => {
    try {
      fs.mkdirSync(EMBED_CACHE, { recursive: true }); // only when a model is actually wanted
      if (!tf) {
        tf = require('@xenova/transformers');
        tf.env.cacheDir = EMBED_CACHE;
      }
      const pipe = await tf.pipeline('feature-extraction', EMBED_MODEL, { quantized: true });
      await pipe('warmup', { pooling: 'mean', normalize: true }); // touch weights once
      setStatus('ready');
      return pipe;
    } catch (err) {
      setStatus('failed', err);
      pipePromise = Promise.resolve(null); // do not retry in-process
      return null;
    }
  })();
  return pipePromise;
}

async function embed(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const pipe = await loadPipe();
  if (!pipe) return null;
  try {
    const out = await pipe(s, { pooling: 'mean', normalize: true });
    return Array.from(out.data).slice(0, EMBED_DIM).map((x) => Math.round(x * 1e4) / 1e4);
  } catch (err) {
    // A loaded pipe that hiccups stays usable; record the error but keep ready.
    lastError = cleanError(err);
    return null;
  }
}

function status() {
  return { status: state, model: EMBED_MODEL, dim: EMBED_DIM, error: lastError };
}

module.exports = { embed, status, EMBED_DIM, EMBED_MODEL };
