// The file indexer: a Web Worker that reads a project file, extracts its text, chunks it and embeds
// the chunks, off the page's thread and entirely in this browser. Started by engine/engine.js and
// driven by engine/shared/ingest-host.js.
//   { id, type: 'index', bytes, name }  ->  { id, ok: true, kind, parts, chunks, vectors?, model? }
//                                           { id, ok: false, code, message }
//   { id, type: 'embedQuery', text }    ->  { id, ok: true, vector }  |  { id, ok: false, code: 'no-model' }
//   { id, type: 'status' }              ->  { id, ok: true, embeddings: boolean }
//   { id, type: 'embed', texts }        ->  { id, ok: true, vectors }  (passages, e.g. earlier chat turns)
// `vectors` and `vector` are base64 of little-endian Float32 data. If the embedding model can't be
// loaded, files are still indexed, for keyword search only.
const VENDOR = new URL('../vendor/', self.location.href).href;
self.BOLTCHAT_VENDOR = VENDOR; // where engine/shared/extract.js finds pdf.js

importScripts(
  'loader.js',
  'buffer.js',
  'path.js',
  `${VENDOR}jszip.min.js`,
  `${VENDOR}ort/ort.wasm.min.js`,
  'shared/chunker.js',
  'shared/extract.js',
  'shared/embedder.js'
);

Boltchat.define('jszip', (require, module) => { module.exports = self.JSZip; });
// One thread: a static site can't send the headers that shared memory between threads needs
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = `${VENDOR}ort/`;
Boltchat.define('onnxruntime', (require, module) => { module.exports = ort; });

const { extractFile, IngestError } = Boltchat.require('extract');
const { chunkParts } = Boltchat.require('chunker');
const { createEmbedder, packVectors } = Boltchat.require('embedder');

const embedder = createEmbedder(new URL('../models/bge-small-en-v1.5/', self.location.href));
// The tokenizer is an ES module, so it is loaded once here before the embedder first needs it
const tokenizerReady = import(`${VENDOR}tokenizers/tokenizers.min.mjs`)
  .then(tokenizers => Boltchat.define('tokenizers', (require, module) => { module.exports = tokenizers; }))
  .catch(err => console.warn('The tokenizer could not be loaded:', err));
const embeddings = async () => {
  await tokenizerReady;
  return embedder.available();
};

const reply = message => self.postMessage(message);
const brief = err => String(err?.message || err).slice(0, 120);

async function index(job) {
  try {
    const { parts, kind } = await extractFile(Buffer.from(job.bytes), job.name);
    const chunks = chunkParts(parts);
    const result = { id: job.id, ok: true, kind, parts, chunks };
    if (await embeddings()) {
      try {
        result.vectors = packVectors(await embedder.embed(chunks.map(c => c.text))).toString('base64');
        result.model = embedder.modelId;
      } catch (err) {
        console.warn('Embedding failed, keyword search only for this file:', err?.message || err);
      }
    }
    reply(result);
  } catch (err) {
    const known = err instanceof IngestError;
    reply({ id: job.id, ok: false, code: known ? err.code : 'failed', message: known ? err.message : `Could not read this file (${brief(err)}).` });
  }
}

async function embedQuery(job) {
  try {
    if (!(await embeddings())) return reply({ id: job.id, ok: false, code: 'no-model' });
    const [vector] = await embedder.embed([job.text], { query: true });
    reply({ id: job.id, ok: true, vector: packVectors([vector]).toString('base64') });
  } catch (err) {
    reply({ id: job.id, ok: false, code: 'failed', message: brief(err) });
  }
}

async function embedPassages(job) {
  try {
    if (!(await embeddings())) return reply({ id: job.id, ok: false, code: 'no-model' });
    const vectors = await embedder.embed((job.texts || []).map(String));
    reply({ id: job.id, ok: true, vectors: packVectors(vectors).toString('base64') });
  } catch (err) {
    reply({ id: job.id, ok: false, code: 'failed', message: brief(err) });
  }
}

// Jobs overlap on purpose: a search query is answered while a big file is still being embedded
self.addEventListener('message', async e => {
  const job = e.data;
  if (job?.type === 'index') index(job);
  else if (job?.type === 'embedQuery') embedQuery(job);
  else if (job?.type === 'embed') embedPassages(job);
  else if (job?.type === 'status') reply({ id: job.id, ok: true, embeddings: await embeddings() });
});
