// On-device text embeddings: BGE small (English, 384 dimensions), run in this browser with ONNX Runtime
// compiled to WebAssembly. Nothing leaves the device: the model's files are downloaded from this site
// (app/models) the first time they are needed.
//   const embedder = createEmbedder(modelUrl)            modelUrl: the folder with the model's files
//   await embedder.embed(['text', …])                   -> [Float32Array(384), …]   (unit length)
//   await embedder.embed(['question'], { query: true })   adds BGE's search-query instruction
// If the model or the runtime can't be loaded, available() resolves false and callers fall back to
// keyword search, so a failed download never breaks a project.
// The page only uses the constants and the pack/unpack helpers; the model itself is loaded by the
// indexing worker (engine/ingest-worker.js), which provides `ort` and the tokenizer.
Boltchat.define('embedder', function (require, module) {
  const MODEL_ID = 'bge-small-en-v1.5';
  const DIMENSIONS = 384;
  const MAX_TOKENS = 512;
  const BATCH = 8;
  const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

  function createEmbedder(modelUrl) {
    let loading = null;

    async function load() {
      const get = async (name, as) => {
        const res = await fetch(new URL(name, modelUrl));
        if (!res.ok) throw new Error(`${name}: ${res.status}`);
        return res[as]();
      };
      const [tokenizerJson, tokenizerConfig, model] = await Promise.all([
        get('tokenizer.json', 'json'),
        get('tokenizer_config.json', 'json'),
        get('onnx/model_quantized.onnx', 'arrayBuffer')
      ]);
      const { Tokenizer } = require('tokenizers');
      const ort = require('onnxruntime');
      const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
      const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      return { ort, tokenizer, session };
    }

    const ready = () => (loading ||= load());

    async function embedBatch({ ort, tokenizer, session }, texts) {
      const encoded = texts.map(text => tokenizer.encode(text));
      const length = Math.min(MAX_TOKENS, Math.max(...encoded.map(e => e.ids.length)));
      const rows = texts.length;
      const ids = new BigInt64Array(rows * length);
      const mask = new BigInt64Array(rows * length);
      encoded.forEach((e, row) => {
        const n = Math.min(length, e.ids.length);
        for (let i = 0; i < n; i++) {
          // A text cut at the limit still ends with the [SEP] token
          ids[row * length + i] = BigInt(i === n - 1 && e.ids.length > n ? e.ids[e.ids.length - 1] : e.ids[i]);
          mask[row * length + i] = 1n;
        }
      });
      const shape = [rows, length];
      const out = await session.run({
        input_ids: new ort.Tensor('int64', ids, shape),
        attention_mask: new ort.Tensor('int64', mask, shape),
        token_type_ids: new ort.Tensor('int64', new BigInt64Array(rows * length), shape)
      });
      const hidden = out.last_hidden_state;
      const dims = hidden.dims[2];
      return texts.map((_, row) => {
        // BGE uses the [CLS] vector, scaled to unit length so a dot product is the cosine similarity
        const vector = Float32Array.from(hidden.data.subarray(row * length * dims, row * length * dims + dims));
        let norm = 0;
        for (const x of vector) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < vector.length; i++) vector[i] /= norm;
        return vector;
      });
    }

    return {
      modelId: MODEL_ID,
      async available() {
        try {
          await ready();
          return true;
        } catch (err) {
          console.warn('The embedding model could not be loaded; files will be searched by keyword only.', err);
          loading = Promise.reject(err); // remember the failure; don't retry on every message
          loading.catch(() => {});
          return false;
        }
      },
      async embed(texts, { query = false } = {}) {
        const model = await ready();
        const prepared = texts.map(t => (query ? QUERY_PREFIX : '') + String(t));
        const out = [];
        for (let i = 0; i < prepared.length; i += BATCH) {
          out.push(...(await embedBatch(model, prepared.slice(i, i + BATCH))));
          await new Promise(resolve => setTimeout(resolve, 0)); // let other messages (a chat query) in between batches
        }
        return out;
      }
    };
  }

  // Vectors travel between the worker and the page, and sit in storage, as one flat Float32 block
  const packVectors = vectors => {
    const flat = new Float32Array(vectors.length * DIMENSIONS);
    vectors.forEach((v, i) => flat.set(v, i * DIMENSIONS));
    return Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
  };
  const unpackVectors = buffer => {
    const copy = new Uint8Array(buffer).buffer; // aligned copy
    return new Float32Array(copy, 0, Math.floor(copy.byteLength / 4 / DIMENSIONS) * DIMENSIONS);
  };

  module.exports = { createEmbedder, packVectors, unpackVectors, MODEL_ID, DIMENSIONS };
});
