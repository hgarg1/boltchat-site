// The searchable record of a project's earlier chats, so a new chat in the project can
// draw on what was said before. Every settled turn (a question and its answer) of each chat that
// belongs to the project becomes an item, embedded in the background like a file chunk.
//   projects/<id>/index/chats.json   { chats: { <chatId>: { title, turns: [{ key, hash, text, vec }] } } }
// The renderer owns conversations.json; this only reads what it saves (see sync(), called from the
// chats:save handler), so there is nothing to keep in step: moving, renaming and deleting chats are
// noticed from the next save. Everything here is derived data and can be rebuilt.
// Shared with the Windows app, where this file is src/chat-index.js.
Boltchat.define('chat-index', function (require, module, exports) {
  const fs = require('fs');
  const path = require('path');
  const { chunkParts } = require('./ingest/chunker');
  const { DIMENSIONS, unpackVectors, packVectors } = require('./ingest/embedder');

  const TURN_MAX_CHARS = 12000;
  const EMBED_BATCH = 12;

  // Same clean-up the page applies before showing or re-sending an answer: reasoning and web citations out
  const answerText = text => String(text || '')
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/【[^】]*】/g, '')
    .trim();

  // FNV-1a: a quick fingerprint to notice that a turn changed
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + text.length.toString(36);
  }

  // The turns of a chat's selected path as { key, text }. In-progress or failed replies are left out, and
  // a long turn is split into several items.
  function turnsOf(chat, now = Date.now()) {
    const out = [];
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    for (let i = 0; i < messages.length - 1; i++) {
      const user = messages[i];
      const reply = messages[i + 1];
      if (user.role !== 'user' || reply.role !== 'assistant') continue;
      if (reply.error && !reply.content) continue;
      // A reply saved mid-stream has no stats yet; give it a minute to finish before counting what is there
      if (!reply.stats && !reply.stopped && !reply.error && now - (chat.updatedAt || 0) < 60000) continue;
      const answer = answerText(reply.content);
      if (!answer) continue;
      const question = String(user.content || '').trim() || (user.images?.length ? '[image]' : '');
      if (!question) continue;
      const text = `User: ${question}\nAssistant: ${answer}`.slice(0, TURN_MAX_CHARS);
      const chunks = chunkParts([{ loc: {}, text }]);
      chunks.forEach((chunk, n) => out.push({ key: `${i}:${n}`, text: chunk.text }));
    }
    return out;
  }

  function createChatIndex({ projects, embedTexts, onChange = () => {}, saveDelayMs = 1000 }) {
    const states = new Map(); // project id -> { chats, version, dirty, timer }
    const file = pid => path.join(projects.folder(pid), 'index', 'chats.json');
    let embedding = false;
    const embedQueue = new Set(); // project ids with items waiting for vectors

    function load(pid) {
      let state = states.get(pid);
      if (state) return state;
      state = { chats: {}, version: 0, dirty: false, timer: null };
      try {
        const saved = JSON.parse(fs.readFileSync(file(pid), 'utf8'));
        for (const [chatId, chat] of Object.entries(saved.chats || {})) {
          state.chats[chatId] = {
            title: String(chat.title || ''),
            turns: (chat.turns || []).map(t => ({
              key: t.key,
              hash: t.hash,
              text: t.text,
              vec: t.vec ? unpackVectors(Buffer.from(t.vec, 'base64')).subarray(0, DIMENSIONS) : null
            }))
          };
        }
      } catch {
        // no index yet, or an unreadable one: it is rebuilt from the chats
      }
      states.set(pid, state);
      return state;
    }

    function save(pid) {
      const state = states.get(pid);
      if (!state?.dirty || !fs.existsSync(projects.folder(pid))) return;
      state.dirty = false;
      clearTimeout(state.timer);
      const chats = {};
      for (const [chatId, chat] of Object.entries(state.chats)) {
        chats[chatId] = { title: chat.title, turns: chat.turns.map(t => ({ key: t.key, hash: t.hash, text: t.text, vec: t.vec ? packVectors([t.vec]).toString('base64') : null })) };
      }
      fs.mkdirSync(path.dirname(file(pid)), { recursive: true });
      fs.writeFileSync(`${file(pid)}.tmp`, JSON.stringify({ chats }));
      fs.renameSync(`${file(pid)}.tmp`, file(pid));
    }

    function touch(pid) {
      const state = states.get(pid);
      state.version++;
      state.dirty = true;
      clearTimeout(state.timer);
      state.timer = setTimeout(() => save(pid), saveDelayMs);
      state.timer.unref?.();
    }

    // Turns still without a vector are embedded a few at a time in the background
    async function pumpEmbeddings() {
      if (embedding) return;
      embedding = true;
      try {
        while (embedQueue.size) {
          const pid = embedQueue.values().next().value;
          const state = states.get(pid);
          const waiting = [];
          for (const chat of Object.values(state?.chats || {})) {
            for (const turn of chat.turns) if (!turn.vec && !turn.skipEmbed) waiting.push(turn);
          }
          if (!waiting.length) {
            embedQueue.delete(pid);
            continue;
          }
          const batch = waiting.slice(0, EMBED_BATCH);
          let vectors = null;
          try {
            vectors = await embedTexts(batch.map(t => t.text));
          } catch {
            vectors = null;
          }
          batch.forEach((turn, i) => {
            if (vectors?.[i]) turn.vec = vectors[i];
            else turn.skipEmbed = true; // no model (or it failed): keyword search only for this turn
          });
          if (states.get(pid) === state) touch(pid);
          onChange(pid);
        }
      } finally {
        embedding = false;
      }
    }

    return {
      // Brings every project's index in line with the chats just saved
      sync(chats) {
        const known = new Set(projects.list().map(p => p.id));
        const byProject = new Map();
        for (const chat of Array.isArray(chats) ? chats : []) {
          if (chat?.projectId && known.has(chat.projectId)) {
            if (!byProject.has(chat.projectId)) byProject.set(chat.projectId, []);
            byProject.get(chat.projectId).push(chat);
          }
        }
        // A project with chats now, or an index from before: both need a look
        const pids = new Set([...byProject.keys(), ...[...known].filter(pid => states.has(pid) || fs.existsSync(file(pid)))]);
        for (const pid of pids) {
          const state = load(pid);
          let changed = false;
          const present = new Set();
          for (const chat of byProject.get(pid) || []) {
            present.add(chat.id);
            const turns = turnsOf(chat);
            const previous = state.chats[chat.id];
            const title = String(chat.title || 'Untitled');
            const old = new Map((previous?.turns || []).map(t => [t.key, t]));
            const next = turns.map(t => {
              const h = hash(t.text);
              const existing = old.get(t.key);
              return existing && existing.hash === h ? existing : { key: t.key, hash: h, text: t.text, vec: null };
            });
            const same = previous && previous.title === title && previous.turns.length === next.length && next.every((t, i) => t === previous.turns[i]);
            if (!same) {
              state.chats[chat.id] = { title, turns: next };
              changed = true;
            }
          }
          for (const chatId of Object.keys(state.chats)) {
            if (!present.has(chatId)) {
              delete state.chats[chatId]; // deleted, or moved out of the project
              changed = true;
            }
          }
          if (changed) {
            touch(pid);
            embedQueue.add(pid);
            onChange(pid);
          }
        }
        if (embedQueue.size) pumpEmbeddings();
      },

      // Items for knowledge search: every turn of the project's other chats
      items(pid, excludeChatId = null) {
        const state = load(pid);
        const items = [];
        for (const [chatId, chat] of Object.entries(state.chats)) {
          if (chatId === excludeChatId) continue;
          for (const turn of chat.turns) items.push({ source: 'chat', chatId, chatTitle: chat.title, loc: {}, text: turn.text, vec: turn.vec });
        }
        return { signature: `chats:${state.version}:${excludeChatId || ''}`, items };
      },

      count(pid) {
        return Object.values(load(pid).chats).reduce((sum, c) => sum + c.turns.length, 0);
      },

      forget(pid) {
        const state = states.get(pid);
        if (state) clearTimeout(state.timer);
        states.delete(pid);
        embedQueue.delete(pid);
      },

      // Wait for background embedding to finish (tests, and a clean quit)
      async idle() {
        while (embedding || embedQueue.size) await new Promise(resolve => setTimeout(resolve, 5));
      },

      flush() {
        for (const pid of states.keys()) save(pid);
      }
    };
  }

  module.exports = { createChatIndex, turnsOf, hash, answerText };
});
