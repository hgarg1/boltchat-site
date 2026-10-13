// Searching a project's text: keyword ranking (BM25) plus meaning-based ranking (vector similarity),
// merged by reciprocal rank fusion, then trimmed to a token budget. Pure functions, no I/O.
//   const corpus = buildCorpus(items)            items: [{ text, vec?: Float32Array(384), fileId, … }]
//   const hits = search(corpus, query, queryVec) -> [{ item, score }] best first
//   const picked = withinBudget(hits, tokens)    drops the lowest-ranked until it fits
// Shared with the Windows app, where this file is src/retrieval.js.
Boltchat.define('retrieval', function (require, module, exports) {
  const DIMENSIONS = 384;
  const STOPWORDS = new Set(('a an and are as at be but by for from has have he her his i if in into is it its me my of on or our she so than that the their ' +
    'them then there these they this to us was we were what when where which who whom why will with you your do does did can could would should how about ' +
    'tell give show please not no yes any some all more most other such only own same too very just also').split(' '));

  // Lowercased words with a very light stem, so "eroding", "erodes" and "erosion" meet in the middle
  function tokenize(text) {
    const out = [];
    for (const raw of String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (!raw || STOPWORDS.has(raw)) continue;
      if (raw.length < 2 && !/\d/.test(raw)) continue;
      out.push(stem(raw));
    }
    return out;
  }

  function stem(word) {
    if (word.length <= 4 || /\d/.test(word)) return word;
    for (const suffix of ['ing', 'edly', 'ed', 'ies', 'es', 's', 'ly']) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
        return suffix === 'ies' ? `${word.slice(0, -3)}y` : word.slice(0, -suffix.length);
      }
    }
    return word;
  }

  function buildCorpus(items) {
    const n = items.length;
    const docs = items.map(item => tokenize(item.text));
    const df = new Map();
    const postings = new Map(); // term -> [[doc, tf], …]
    let totalLength = 0;
    docs.forEach((tokens, doc) => {
      totalLength += tokens.length;
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, count] of tf) {
        df.set(t, (df.get(t) || 0) + 1);
        if (!postings.has(t)) postings.set(t, []);
        postings.get(t).push([doc, count]);
      }
    });
    // Items with a vector go into one flat matrix, so a similarity pass is a tight loop
    const withVector = [];
    items.forEach((item, i) => { if (item.vec && item.vec.length === DIMENSIONS) withVector.push(i); });
    const matrix = new Float32Array(withVector.length * DIMENSIONS);
    withVector.forEach((i, row) => matrix.set(items[i].vec, row * DIMENSIONS));
    return { items, n, docLengths: docs.map(d => d.length), avgLength: n ? totalLength / n : 0, df, postings, withVector, matrix };
  }

  // Okapi BM25 over the chunks; returns [{ index, score }] for chunks that share at least one term
  function keywordSearch(corpus, query, { k1 = 1.4, b = 0.75 } = {}) {
    const scores = new Map();
    for (const term of new Set(tokenize(query))) {
      const posting = corpus.postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (corpus.n - posting.length + 0.5) / (posting.length + 0.5));
      for (const [doc, tf] of posting) {
        const norm = 1 - b + b * (corpus.docLengths[doc] / (corpus.avgLength || 1));
        scores.set(doc, (scores.get(doc) || 0) + idf * ((tf * (k1 + 1)) / (tf + k1 * norm)));
      }
    }
    return [...scores].map(([index, score]) => ({ index, score })).sort((a, b2) => b2.score - a.score);
  }

  // Cosine similarity (vectors are unit length, so a dot product) for every chunk that has a vector
  function vectorSearch(corpus, queryVec) {
    if (!queryVec || queryVec.length !== DIMENSIONS) return [];
    const out = [];
    for (let row = 0; row < corpus.withVector.length; row++) {
      let dot = 0;
      const base = row * DIMENSIONS;
      for (let i = 0; i < DIMENSIONS; i++) dot += corpus.matrix[base + i] * queryVec[i];
      out.push({ index: corpus.withVector[row], score: dot });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // Reciprocal rank fusion: each list votes 1 / (60 + rank), so a chunk both lists like beats one only a
  // single list likes, without having to compare BM25 scores to cosine similarities
  function fuse(lists, { k = 60 } = {}) {
    const scores = new Map();
    for (const list of lists) list.forEach(({ index }, rank) => scores.set(index, (scores.get(index) || 0) + 1 / (k + rank + 1)));
    return [...scores].map(([index, score]) => ({ index, score })).sort((a, b) => b.score - a.score);
  }

  // Meaning-based matches below this are noise (BGE scores unrelated text around 0.4 to 0.5)
  const MIN_SIMILARITY = 0.55;

  function search(corpus, query, queryVec, { limit = 20, minSimilarity = MIN_SIMILARITY } = {}) {
    if (!corpus.n) return [];
    const keyword = keywordSearch(corpus, query).slice(0, 50);
    const meaning = vectorSearch(corpus, queryVec).filter(h => h.score >= minSimilarity).slice(0, 50);
    return fuse([keyword, meaning]).slice(0, limit).map(({ index, score }) => ({ item: corpus.items[index], score }));
  }

  const tokensOf = text => Math.ceil(String(text).length / 3.5);

  // Word-set overlap, to skip a chunk that mostly repeats one already chosen
  function overlap(a, b) {
    const x = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
    const y = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
    if (!x.size || !y.size) return 0;
    let shared = 0;
    for (const w of x) if (y.has(w)) shared++;
    return shared / Math.min(x.size, y.size);
  }

  // Best hits first, until the budget is used; near-duplicates and a file's 9th chunk are skipped
  function withinBudget(hits, budgetTokens, { maxPerFile = 8, duplicate = 0.85 } = {}) {
    const picked = [];
    const perFile = new Map();
    let used = 0;
    for (const hit of hits) {
      const cost = tokensOf(hit.item.text);
      if (used + cost > budgetTokens) continue;
      const key = hit.item.fileId || hit.item.chatId || '';
      if ((perFile.get(key) || 0) >= maxPerFile) continue;
      if (picked.some(p => overlap(p.item.text, hit.item.text) >= duplicate)) continue;
      picked.push(hit);
      perFile.set(key, (perFile.get(key) || 0) + 1);
      used += cost;
    }
    return { picked, tokens: used };
  }

  // How many tokens of excerpts a request can carry: a quarter of the model's context (at most 6,000),
  // and never more than what is left under its per-minute token limit once the conversation, pinned
  // files and the reply are accounted for. 0 means "skip search for this message".
  function excerptBudget({ contextWindow, tpm, historyTokens = 0, pinnedTokens = 0, maxTokens = 0 }) {
    let budget = Math.min(6000, Math.floor((contextWindow || 16000) * 0.25));
    if (tpm) budget = Math.min(budget, tpm - historyTokens - pinnedTokens - maxTokens - 500);
    return budget < 400 ? 0 : budget;
  }

  module.exports = { tokenize, buildCorpus, keywordSearch, vectorSearch, fuse, search, withinBudget, excerptBudget, tokensOf, MIN_SIMILARITY, DIMENSIONS };
});
