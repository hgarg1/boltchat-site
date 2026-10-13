// What a project contributes to one chat request: the files pinned into context, and
// the passages of its files (and earlier chats) that best match the message being sent.
//   const knowledge = createKnowledge({ files, host, extraItems })
//   knowledge.pinned(projectId)                       -> { files: [{ name, text, tokens }], tokens }
//   await knowledge.excerpts({ projectId, query, tail, budgetTokens, chatId })
//                                                    -> { excerpts: [{ n, label, text }], sources: [...], tokens }
// The search index of a project is rebuilt in memory only when its files change.
// Shared with the Windows app, where this file is src/project-knowledge.js.
Boltchat.define('project-knowledge', function (require, module, exports) {
  const { buildCorpus, search, withinBudget, tokensOf, excerptBudget } = require('./retrieval');
  const ProjectContext = require('./project-context');
  const { locLabel } = require('./ingest/chunker');
  const { DIMENSIONS } = require('./ingest/embedder');

  function createKnowledge({ files, host, extraItems = () => ({ signature: '', items: [] }) }) {
    const cache = new Map(); // project id -> { signature, corpus }


    const signatureOf = list => list.map(f => `${f.id}:${f.chunks}:${f.model || ''}:${f.mode}`).join('|');

    // Chunks of every indexed file that is searched (pinned files are sent whole instead)
    function fileItems(projectId, list) {
      const items = [];
      for (const file of list) {
        const chunks = files.loadChunks(projectId, file.id);
        if (!chunks?.length) continue;
        const vectors = file.model ? files.loadVectors(projectId, file.id) : null;
        const aligned = vectors && vectors.length === chunks.length * DIMENSIONS;
        chunks.forEach((chunk, i) => {
          items.push({
            source: 'file',
            fileId: file.id,
            fileName: file.name,
            loc: chunk.loc,
            text: chunk.text,
            vec: aligned ? vectors.subarray(i * DIMENSIONS, (i + 1) * DIMENSIONS) : null
          });
        });
      }
      return items;
    }

    // The search index is rebuilt only when the files, or the earlier chats it includes, change.
    // extraItems(projectId, chatId) -> { signature, items } (the signature changes whenever the items do)
    function corpusFor(projectId, chatId) {
      const searched = files.list(projectId).filter(f => f.status === 'ready' && f.mode === 'search');
      const extra = extraItems(projectId, chatId);
      const signature = `${signatureOf(searched)}#${extra.signature}`;
      let entry = cache.get(projectId);
      if (!entry || entry.signature !== signature) {
        entry = { signature, corpus: buildCorpus([...fileItems(projectId, searched), ...extra.items]) };
        cache.set(projectId, entry);
      }
      return entry.corpus;
    }

    return {
      pinned(projectId) {
        const list = files.list(projectId).filter(f => f.status === 'ready' && f.mode === 'context');
        const out = [];
        for (const file of list) {
          const parts = files.loadText(projectId, file.id);
          if (!parts?.length) continue;
          const text = parts.map(p => (p.loc?.page ? `[page ${p.loc.page}]\n` : p.loc?.sheet ? `[sheet ${p.loc.sheet}]\n` : p.loc?.slide ? `[slide ${p.loc.slide}]\n` : '') + p.text).join('\n\n');
          out.push({ name: file.name, text, tokens: tokensOf(text) });
        }
        return { files: out, tokens: out.reduce((sum, f) => sum + f.tokens, 0) };
      },

      forget(projectId) {
        cache.delete(projectId);
      },

      // Everything a project adds to one request, within what the model can take. Throws (instead of
      // silently cutting) when pinned files can't fit, so the user can pick another model or unpin a file.
      //   messages: the request's chat messages (OpenAI shape)   caps: { contextWindow }   tpm: tokens per minute, if known
      async gather({ projectId, chatId = null, messages, maxTokens = 0, contextWindow = 0, tpm }) {
        const text = content => (Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join(' ') : String(content ?? ''));
        const images = content => (Array.isArray(content) ? content.filter(p => p.type === 'image_url').length : 0);
        const historyTokens = messages.reduce((sum, m) => sum + text(m.content).length / 3.5 + images(m.content) * 1000, 0);
        const pinned = this.pinned(projectId);
        const needed = historyTokens + pinned.tokens + maxTokens + 300;
        const ceiling = Math.min(contextWindow ? contextWindow * 0.9 : Infinity, tpm ?? Infinity);
        if (pinned.tokens && needed > ceiling) {
          throw new Error(`The files kept in context for this project (about ${Math.round(pinned.tokens).toLocaleString('en-US')} tokens) don’t fit this model’s limits. Choose a model with more room, or set those files to “Search when relevant”.`);
        }
        const budget = excerptBudget({ contextWindow, tpm, historyTokens, pinnedTokens: pinned.tokens, maxTokens });
        const searchable = files.list(projectId).some(f => f.status === 'ready' && f.mode === 'search');
        let found = { excerpts: [], sources: [] };
        let note = '';
        if (budget === 0) {
          if (searchable) note = 'Project files weren’t searched for this message: there isn’t enough room under this model’s limits.';
        } else {
          const lastUser = text(messages.findLast(m => m.role === 'user')?.content);
          const lastAssistant = text(messages.findLast(m => m.role === 'assistant')?.content);
          try {
            found = await this.excerpts({ projectId, chatId, query: lastUser, tail: lastAssistant, budgetTokens: budget });
          } catch (err) {
            console.warn('Searching project files failed:', err);
            note = 'Project files couldn’t be searched for this message.';
          }
        }
        return {
          messages: ProjectContext.knowledgeMessages({ pinned: pinned.files, excerpts: found.excerpts }),
          sources: found.sources,
          pinnedFiles: pinned.files.map(f => f.name),
          note
        };
      },

      async excerpts({ projectId, query, tail = '', budgetTokens, chatId = null }) {
        const empty = { excerpts: [], sources: [], tokens: 0 };
        if (!query?.trim() || budgetTokens <= 0) return empty;
        const corpus = corpusFor(projectId, chatId);
        if (!corpus.n) return empty;
        // A short follow-up ("and the second one?") only makes sense with the answer before it
        const text = query.trim().length < 40 && tail ? `${query.trim()} ${tail.slice(0, 240)}` : query.trim();
        const queryVec = corpus.withVector.length ? await host.embedQuery(text) : null;
        const hits = search(corpus, text, queryVec);
        const { picked, tokens } = withinBudget(hits, budgetTokens);
        const excerpts = picked.map(({ item }, i) => ({
          n: i + 1,
          label: item.source === 'chat' ? `earlier chat “${item.chatTitle}”` : [item.fileName, locLabel(item.loc)].filter(Boolean).join(', '),
          text: item.text,
          item
        }));
        return {
          excerpts: excerpts.map(({ n, label, text: t }) => ({ n, label, text: t })),
          sources: excerpts.map(({ n, label, item }) => ({ n, label, kind: item.source, name: item.fileName || item.chatTitle })),
          tokens
        };
      }
    };
  }

  module.exports = { createKnowledge };
});
