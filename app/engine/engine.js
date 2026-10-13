// Boltchat's chat engine for the browser: everything behind `window.groq`, which the page's
// scripts (renderer.js, projects.js, voice-chat-ui.js …) call for settings, chats, projects, memory,
// and every request to Groq. It is the same logic as the Windows app's main process, as plain script.
//
// There is no server behind this. Requests go from this page straight to Groq with the user's own
// key, and everything that is kept is kept in this browser (engine/storage.js). The only address
// this file ever contacts is API_BASE below; the page's Content-Security-Policy enforces that too.
//
// Load order: engine/loader.js, buffer.js, fs.js, path.js, crypto.js, the engine/shared modules,
// engine/storage.js, then this file, then the page's scripts.
(() => {
  const { require } = Boltchat;
  const fs = require('fs');
  const path = require('path');
  const storage = require('storage');
  const { createProjectStore } = require('project-store');
  const { createFileStore, FileError, LIMITS } = require('project-files');
  const { createIngestHost } = require('ingest-host');
  const { createChatIndex } = require('chat-index');
  const voiceSettings = require('voice-settings');
  const reasoningRules = require('reasoning');
  const ProjectContext = self.ProjectContext; // project-context.js, shared with the page
  Boltchat.define('project-context', (_require, module) => { module.exports = ProjectContext; });
  const { createKnowledge } = require('project-knowledge');

  const VERSION = '2.9.0';
  const API_BASE = 'https://api.groq.com/openai/v1';

  // The data folder: an in-memory file tree that engine/storage.js keeps in this browser's IndexedDB
  const dataDir = () => '/data';
  const settingsFile = () => path.join(dataDir(), 'settings.json');
  const chatsFile = () => path.join(dataDir(), 'conversations.json');
  const memoryFile = () => path.join(dataDir(), 'memory.json');

  // --- Events to the page (replies streaming in, memories changing, files finishing indexing) ---

  const listeners = new Map(); // channel -> Set of handlers
  // Values passed between the engine and the page are copied, so neither can change the other's objects
  const copy = value => {
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value ?? null));
    }
  };
  function emit(channel, payload) {
    const value = copy(payload);
    for (const handler of [...(listeners.get(channel) || [])]) {
      try {
        handler(value);
      } catch (err) {
        console.error(err);
      }
    }
  }
  // on('chat:delta') -> subscribe(handler) -> unsubscribe()
  const on = channel => handler => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(handler);
    return () => listeners.get(channel).delete(handler);
  };

  // --- Projects, their files and the search over them ---

  let projectStore = null;
  const projects = () => (projectStore ||= createProjectStore(dataDir()));
  let projectFiles = null;
  const files = () => (projectFiles ||= createFileStore(projects()));
  // Earlier chats of a project, searchable by its later chats (rebuilt from what the page saves)
  let chatIndexInstance = null;
  const chatIndex = () => (chatIndexInstance ||= createChatIndex({ projects: projects(), embedTexts: texts => ingest().embedTexts(texts) }));
  let projectKnowledge = null;
  const knowledge = () => (projectKnowledge ||= createKnowledge({
    files: files(),
    host: ingest(),
    // A project can switch off drawing on its earlier chats
    extraItems: (projectId, chatId) => (projects().get(projectId)?.pastChats === false ? { signature: 'chats-off', items: [] } : chatIndex().items(projectId, chatId))
  }));
  // Reading, parsing, chunking and embedding project files happens in a Web Worker (engine/ingest-worker.js).
  // A job names its file by path; the worker has no access to the data folder, so the bytes travel with the job.
  let ingestHost = null;
  const ingest = () => (ingestHost ||= createIngestHost({
    files: files(),
    onChange: projectId => emit('files:changed', { projectId }),
    spawn: () => {
      const worker = new Worker(new URL('engine/ingest-worker.js', document.baseURI), { name: 'Boltchat file indexer' });
      const handlers = { message: new Set(), exit: new Set() };
      let alive = true;
      worker.addEventListener('message', e => handlers.message.forEach(handler => handler(e.data)));
      worker.addEventListener('error', e => {
        console.warn('The file indexer stopped:', e.message || e);
        if (!alive) return;
        alive = false;
        worker.terminate();
        handlers.exit.forEach(handler => handler());
      });
      let queue = Promise.resolve();
      return {
        postMessage(message) {
          queue = queue.then(async () => {
            if (!alive) return;
            if (message?.type !== 'index') return worker.postMessage(message);
            try {
              const { path: file, ...job } = message;
              const bytes = new Uint8Array(await fs.vfs.readAsync(file)).slice();
              worker.postMessage({ ...job, bytes }, [bytes.buffer]);
            } catch {
              handlers.message.forEach(handler => handler({ id: message.id, ok: false, code: 'failed', message: 'Could not read this file from this browser’s storage.' }));
            }
          });
        },
        onMessage: handler => handlers.message.add(handler),
        onExit: handler => handlers.exit.add(handler),
        kill() {
          alive = false;
          worker.terminate();
        }
      };
    }
  }));

  const DEFAULT_SETTINGS = {
    model: 'openai/gpt-oss-120b',
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: 4096,
    // Reasoning level per model id; a model with no entry is left to Groq's own default (see engine/shared/reasoning.js)
    reasoningEffort: {},
    theme: 'system',
    accent: 'groq',
    textSize: 'default',
    tools: { web: true, code: true },
    voiceModel: 'whisper-large-v3-turbo',
    // Voice chat (hands-free conversation); see engine/shared/voice-settings.js
    voiceChat: voiceSettings.DEFAULTS,
    chime: true,
    suggestions: true, // fresh start-screen ideas from memory and the model
    // Off until the user opts in. `learn` lets a small model pick up facts after each reply.
    memory: { enabled: false, learn: true }
  };

  const activeRequests = new Map();
  const modelCaps = new Map(); // model id -> { tools }, filled whenever the model list is fetched

  // --- Storage ---

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  }

  const { TTS_MODELS, TTS_VOICES, clean: cleanVoiceChat } = voiceSettings;

  function loadSettings() {
    const saved = readJson(settingsFile(), {});
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      reasoningEffort: reasoningRules.clean(saved.reasoningEffort),
      memory: { ...DEFAULT_SETTINGS.memory, ...saved.memory },
      voiceChat: cleanVoiceChat({ ...DEFAULT_SETTINGS.voiceChat, ...saved.voiceChat })
    };
  }

  // --- Memory ---
  // Facts about the user, kept in memory.json in this browser. When memory is on they're added to every
  // request as a system message, so they reach Groq with the chat but are never stored there.
  // A project can keep its own notes (projects/<id>/memory.json) with the same rules: a "scope" says
  // which file a memory function reads and writes, and what to tell the page when it changes.

  const MEMORY_LIMIT = 200;
  const MEMORY_MAX_CHARS = 500;

  const GLOBAL_MEMORY = {
    kind: 'global',
    file: () => memoryFile(),
    changed: list => {
      emit('memory:changed', list);
    }
  };
  const projectMemoryScope = projectId => ({
    kind: 'project',
    projectId,
    file: () => path.join(projects().folder(projectId), 'memory.json'),
    changed: list => {
      emit('projects:memory-changed', { projectId, list });
    }
  });

  function loadMemories(scope = GLOBAL_MEMORY) {
    const list = readJson(scope.file(), []);
    return Array.isArray(list) ? list : [];
  }

  function saveMemories(list, scope = GLOBAL_MEMORY) {
    writeJson(scope.file(), list);
    scope.changed(list);
    return list;
  }

  const normalizeFact = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_MAX_CHARS);
  const memoryId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // Returns the stored memory, or the existing one when it's a duplicate
  function addMemory(text, source, scope = GLOBAL_MEMORY) {
    const fact = normalizeFact(text);
    if (!fact) throw new Error('Nothing to remember.');
    const list = loadMemories(scope);
    const existing = list.find(m => m.text.toLowerCase() === fact.toLowerCase());
    if (existing) return existing;
    const memory = { id: memoryId(), text: fact, source, createdAt: Date.now() };
    list.push(memory);
    saveMemories(list.slice(-MEMORY_LIMIT), scope); // oldest fall off first
    return memory;
  }

  function updateMemory(id, text, scope = GLOBAL_MEMORY) {
    const fact = normalizeFact(text);
    const list = loadMemories(scope);
    const memory = list.find(m => m.id === id);
    if (!memory || !fact) return null;
    Object.assign(memory, { text: fact, updatedAt: Date.now() });
    saveMemories(list, scope);
    return memory;
  }

  function deleteMemory(id, scope = GLOBAL_MEMORY) {
    const list = loadMemories(scope);
    const memory = list.find(m => m.id === id);
    if (memory) saveMemories(list.filter(m => m !== memory), scope);
    return memory || null;
  }

  // Plain keyword match: enough for a few hundred short facts
  function searchMemories(query, scope = GLOBAL_MEMORY) {
    const list = loadMemories(scope);
    const words = String(query || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    if (!words.length) return list;
    return list
      .map(m => ({ m, score: words.filter(w => m.text.toLowerCase().includes(w)).length }))
      .filter(r => r.score)
      .sort((a, b) => b.score - a.score)
      .map(r => r.m);
  }

  function memoryPrompt(memories, withTools, scope = GLOBAL_MEMORY) {
    const project = scope.kind === 'project';
    const lines = [
      project
        ? 'You keep notes about the project this chat belongs to, from earlier conversations in it: its goals, decisions, terms and preferences. Use them when relevant, without listing or announcing them unless asked. If a note seems out of date, trust what the user says now.'
        : 'You have a long-term memory of facts about the user from earlier conversations. Use them when relevant to personalise answers, without listing or announcing them unless asked. If a memory seems out of date, trust what the user says now.'
    ];
    if (withTools) {
      lines.push(project
        ? 'Only call memory_save when the user explicitly asks you to remember something for this project, or corrects something you noted (then memory_delete the old entry). Call memory_search when the user asks what you remember or asks you to recall something. Call memory_delete when asked to forget something. These tools only touch this project’s notes.'
        : 'Only call memory_save when the user explicitly asks you to remember something, or corrects something you remembered (then memory_delete the old entry). Call memory_search when the user asks what you remember or asks you to recall something. Call memory_delete when asked to forget something.');
    }
    lines.push(memories.length
      ? `${project ? 'Project notes' : 'Memories'} (id: fact):\n${memories.map(m => `- ${m.id}: ${m.text}`).join('\n')}`
      : project ? 'No project notes saved yet.' : 'No memories saved yet.');
    return lines.join('\n\n');
  }

  const MEMORY_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'memory_save',
        description: 'Save one fact about the user to long-term memory, available in future chats. Use only when the user asks you to remember something.',
        parameters: {
          type: 'object',
          properties: { fact: { type: 'string', description: 'A short, self-contained fact written in third person, e.g. "Prefers metric units".' } },
          required: ['fact']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_search',
        description: 'Look up saved memories about the user. An empty query returns everything.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Keywords to match, or "" for all memories.' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_delete',
        description: 'Forget a saved memory by its id.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The memory id, e.g. "m1a2b3c".' } },
          required: ['id']
        }
      }
    }
  ];

  // Runs one memory tool call; returns what the model sees and the step the UI shows
  function runMemoryTool(name, rawArgs, scope = GLOBAL_MEMORY) {
    const args = parseJson(rawArgs || '{}') || {};
    try {
      if (name === 'memory_save') {
        const memory = addMemory(args.fact, 'chat', scope);
        return { result: { saved: memory }, step: { action: 'save', label: memory.text } };
      }
      if (name === 'memory_search') {
        const found = searchMemories(args.query, scope).slice(0, 50);
        return { result: { memories: found.map(({ id, text }) => ({ id, text })) }, step: { action: 'search', label: args.query || '', count: found.length } };
      }
      if (name === 'memory_delete') {
        const memory = deleteMemory(String(args.id || ''), scope);
        return {
          result: memory ? { deleted: memory.id } : { error: `No memory with id ${args.id}` },
          step: { action: 'delete', label: memory?.text || String(args.id || ''), failed: !memory }
        };
      }
      return { result: { error: `Unknown tool ${name}` }, step: { action: 'unknown', label: name, failed: true } };
    } catch (err) {
      return { result: { error: err.message }, step: { action: name.replace('memory_', ''), label: '', failed: true } };
    }
  }

  // After a reply, a small model reads the exchange and keeps durable facts about the user.
  // Runs in the background; failures only cost a missed memory.
  const LEARN_MODEL = 'openai/gpt-oss-20b';
  const LEARN_PROMPT = `You maintain a long-term memory of facts about a user of a chat assistant.
Read the latest exchange and decide whether it reveals anything worth remembering for future conversations:
durable facts and preferences the USER states about themselves (name, job, location, projects, tools they use, tastes, how they like answers).
Do NOT save: what the user is asking for or working on right now ("User wants tips on X", "User asked about Y" are never memories), things only the assistant said, general knowledge, guesses, secrets or credentials, or sensitive details (health, finances, religion, politics, sexuality) unless the user asked to be remembered.
Combine related details into one fact ("Backend engineer who mostly writes Go", not two entries).
If a new fact replaces an existing memory, remove the old id.
Reply with JSON only: {"add": ["short third-person fact", ...], "remove": ["memory id", ...]}. Use empty arrays when nothing changes (the usual case). Add at most 3 facts.`;
  // The same job for a project's notes: facts about the work, not about the person
  const LEARN_PROMPT_PROJECT = `You maintain short notes about ONE project that a user works on with a chat assistant.
Read the latest exchange and decide whether it settles anything worth remembering for future chats in this project:
decisions that were made, the project's goals and constraints, names and terms it uses, conventions to follow, preferences about how work for this project should be done.
Do NOT save: what the user is asking right now ("User asked about X" is never a note), anything only the assistant said, general knowledge, guesses, open questions, secrets or credentials, or personal details about the user.
Combine related details into one note ("Report is written in British English with numbered sections", not two entries).
If a new note replaces an existing one, remove the old id.
Reply with JSON only: {"add": ["short self-contained note", ...], "remove": ["note id", ...]}. Use empty arrays when nothing changes (the usual case). Add at most 3 notes.`;

  const messageText = content => (Array.isArray(content)
    ? content.filter(p => p.type === 'text').map(p => p.text).join('\n')
    : String(content || ''));

  // One background JSON request. Groq's JSON mode occasionally rejects a generation outright
  // ("Failed to validate JSON"), so that case gets one retry without it, parsing the reply ourselves.
  async function jsonCompletion(key, { messages, temperature, maxTokens = 1024 }) {
    const call = jsonMode => fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LEARN_MODEL,
        temperature,
        max_completion_tokens: maxTokens,
        messages,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
      })
    });
    let res = await call(true);
    if (res.status === 400) res = await call(false);
    if (!res.ok) throw new Error(await groqError(res));
    const text = (await res.json()).choices?.[0]?.message?.content || '';
    return parseJson(text) || parseJson(/\{[\s\S]*\}/.exec(text)?.[0] || '') || {};
  }

  async function learnFromTurn(key, userText, replyText, scope = GLOBAL_MEMORY) {
    if (!userText.trim()) return;
    const memories = loadMemories(scope);
    const project = scope.kind === 'project';
    const out = await jsonCompletion(key, {
      temperature: 0.2,
      messages: [
        { role: 'system', content: project ? LEARN_PROMPT_PROJECT : LEARN_PROMPT },
        {
          role: 'user',
          content: [
            `Existing ${project ? 'notes' : 'memories'}:\n${memories.map(m => `- ${m.id}: ${m.text}`).join('\n') || '(none)'}`,
            `User said:\n${userText.slice(0, 6000)}`,
            `Assistant replied:\n${replyText.slice(0, 3000)}`
          ].join('\n\n')
        }
      ]
    });
    const ids = new Set(memories.map(m => m.id));
    const remove = (Array.isArray(out.remove) ? out.remove : []).filter(id => ids.has(id));
    const known = new Set(memories.map(m => m.text.toLowerCase()));
    const add = (Array.isArray(out.add) ? out.add : [])
      .map(normalizeFact)
      .filter(text => text && !known.has(text.toLowerCase()))
      .slice(0, 3);
    for (const id of remove) deleteMemory(id, scope);
    const added = add.map(text => addMemory(text, 'learned', scope));
    if (added.length || remove.length) {
      emit('memory:learned', { added, removed: remove.length, projectId: scope.projectId || null });
    }
  }

  // --- Start-screen suggestions ---
  // Always SUGGESTION_SLOTS buttons, filled in priority order: ideas from memory, then fun ideas from
  // the model. A tier with nothing to offer hands its slots to the next one; the page's built-in
  // suggestions fill anything still empty (offline, no key, feature off).
  // The Windows app has a news tier too. A web page can't read the newsrooms' feeds, and this page
  // talks to nothing but Groq, so here that tier is always empty.

  const suggestionsFile = () => path.join(dataDir(), 'suggestions.json');
  const SUGGESTION_SLOTS = 4;
  const SUGGESTIONS_MAX_AGE = 3 * 60 * 60 * 1000;
  const SUGGESTIONS_MIN_GAP = 10 * 60 * 1000; // memory changes alone refresh at most this often
  // Fingerprint of what the memory tier depends on, so new memories trigger fresh ideas
  const memorySignature = memories => memories.map(m => m.id).join(',');

  const SUGGEST_PROMPT = `You write the example prompts shown as buttons on a chat app's start screen. Each is something the user could send to the assistant, written in the user's voice, under 70 characters, with no quotes or emoji.
Return JSON only: {"memory": [...], "news": [...], "fun": [...]} with exactly the number of items requested for each list.
- memory: each built on ONE fact about the user (a different fact per item), something they would plausibly ask on a normal day. Never combine unrelated facts or restate a fact.
- news: objects {"story": <story number>, "text": "..."}, each based on a different story from today's list, phrased as a neutral question that invites an explanation ("What's behind …?", "Explain the … situation"). No opinions, loaded words or sides taken. Stories are listed by how many independent outlets cover them, so prefer the top ones, and prefer politics, science, economy or culture stories of broad interest over deaths and disasters.
- fun: varied, playful or curious ideas for anyone that a text chat assistant can do (explanations, small creative tasks, quick games, useful mini-projects). Do not use the user's facts here.
Nothing may resemble the "avoid" list.`;

  async function generateSuggestions(key) {
    const { memory } = loadSettings();
    const memories = memory.enabled ? loadMemories() : [];
    const news = { outlets: [], stories: [] };
    const stories = news.stories;
    const plan = { memory: memories.length ? 2 : 0 };
    plan.news = stories.length ? (plan.memory ? 1 : 2) : 0;
    plan.fun = SUGGESTION_SLOTS - plan.memory - plan.news;
    const previous = readJson(suggestionsFile(), {}).items || [];

    const out = await jsonCompletion(key, {
      temperature: 1,
      maxTokens: 2048,
      messages: [
        { role: 'system', content: SUGGEST_PROMPT },
        {
          role: 'user',
          content: [
            // Ask for spare fun ideas so a short tier above can still be filled
            `Counts: memory ${plan.memory}, news ${plan.news}, fun ${plan.fun + 2}.`,
            plan.memory && `Facts about the user:\n${memories.map(m => `- ${m.text}`).join('\n')}`,
            plan.news && `Today's top stories, merged from ${news.outlets.join(', ')}:\n${stories.map((st, i) =>
            `${i + 1}. ${st.headline} [covered by ${st.outlets.length}: ${st.outlets.join(', ')}]${st.summaries[0] ? ` — ${st.summaries[0]}` : ''}`).join('\n')}`,
            previous.length && `Avoid:\n${previous.map(s => `- ${s.text}`).join('\n')}`
          ].filter(Boolean).join('\n\n')
        }
      ]
    });
    // News ideas name their story, so the button can say which outlets reported it
    const ideas = kind => (Array.isArray(out[kind]) ? out[kind] : [])
      .map(idea => (typeof idea === 'string' ? { text: idea } : idea || {}))
      .map(idea => ({ text: normalizeFact(idea.text).slice(0, 120), story: stories[Number(idea.story) - 1] }))
      .filter(idea => idea.text)
      .map(({ text, story }) => ({ kind, text, ...(kind === 'news' && story ? { outlets: story.outlets } : {}) }));
    const tiers = ['memory', 'news', 'fun'].map(kind => ({ kind, ideas: ideas(kind) }));
    // Each tier's share first; then, if the model came up short somewhere, spares in tier order
    const items = tiers.flatMap(t => t.ideas.splice(0, plan[t.kind]));
    items.push(...tiers.flatMap(t => t.ideas).slice(0, SUGGESTION_SLOTS - items.length));
    items.sort((a, b) => tiers.findIndex(t => t.kind === a.kind) - tiers.findIndex(t => t.kind === b.kind));

    const result = { createdAt: Date.now(), memorySignature: memorySignature(memories), items };
    writeJson(suggestionsFile(), result);
    return result;
  }

  let suggestionsInFlight = null;
  function refreshSuggestions() {
    const cached = readJson(suggestionsFile(), null);
    const key = getApiKey();
    const { memory, suggestions } = loadSettings();
    if (!key || suggestions === false) return Promise.resolve(cached);
    const age = Date.now() - (cached?.createdAt || 0);
    const memoryChanged = cached?.memorySignature !== memorySignature(memory.enabled ? loadMemories() : []);
    const stale = !cached?.items?.length || age > SUGGESTIONS_MAX_AGE || (memoryChanged && age > SUGGESTIONS_MIN_GAP);
    if (!stale) return Promise.resolve(cached);
    suggestionsInFlight ||= generateSuggestions(key)
      .catch(err => {
        console.error('Suggestions failed:', err.message);
        return cached;
      })
      .finally(() => { suggestionsInFlight = null; });
    return suggestionsInFlight;
  }

  // --- Groq API ---

  // Groq's rate-limit headers (console.groq.com/docs/rate-limits): the "requests" ones always mean
  // requests per DAY and the "tokens" ones tokens per MINUTE, for the model called, across the whole
  // Groq organization. Resets come as Go-style durations like "2h13m27.2s" or "17ms". They don't say
  // which plan the organization is on, so neither does the app.
  function parseResetMs(value) {
    if (!value) return null;
    const units = { h: 3600000, m: 60000, s: 1000, ms: 1 };
    let total = 0;
    let matched = false;
    for (const [, n, unit] of String(value).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
      total += Number(n) * units[unit];
      matched = true;
    }
    return matched ? Math.round(total) : null;
  }

  function rateLimitsFrom(headers) {
    const pick = name => headers.get(`x-ratelimit-${name}`);
    const num = name => (pick(name) == null ? null : Number(pick(name)));
    const at = Date.now();
    const resetAt = name => {
      const ms = parseResetMs(pick(name));
      return ms == null ? null : at + ms;
    };
    return {
      at, // when Groq reported these (they're a snapshot, not live)
      requestsLimit: num('limit-requests'), // per day
      requestsRemaining: num('remaining-requests'),
      requestsResetAt: resetAt('reset-requests'),
      tokensLimit: num('limit-tokens'), // per minute
      tokensRemaining: num('remaining-tokens'),
      tokensResetAt: resetAt('reset-tokens')
    };
  }

  async function groqError(res) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {
      detail = res.statusText;
    }
    if (res.status === 401) return 'Your Groq API key was rejected. Check it in Settings.';
    if (res.status === 429) {
      const wait = parseResetMs(res.headers.get('retry-after') ? `${res.headers.get('retry-after')}s` : null);
      return `Groq rate limit reached for this model${wait ? ` — try again in ${Math.ceil(wait / 1000)}s` : ''}. ${detail}`;
    }
    return `Groq error ${res.status}: ${detail}`;
  }

  async function listModels(key = getApiKey()) {
    if (!key) throw new Error('Add your Groq API key in Settings first.');
    const res = await fetch(`${API_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(await groqError(res));
    const data = await res.json();
    for (const m of data.data || []) {
      modelCaps.set(m.id, { tools: !!m.supported_features?.includes('tools'), vision: !!m.input_modalities?.includes('image'), contextWindow: m.context_window || 0 });
    }
    return (data.data || [])
      .filter(m => m.active !== false)
      .filter(m => !m.output_modalities || m.output_modalities.includes('text'))
      .filter(m => !/whisper|prompt-guard/i.test(m.id))
      .map(m => ({
        id: m.id,
        name: m.name || m.id,
        owner: m.owned_by,
        contextWindow: m.context_window,
        maxOutput: m.max_completion_tokens,
        vision: !!m.input_modalities?.includes('image'),
        reasoning: !!m.supported_features?.includes('reasoning'),
        efforts: reasoningRules.levelsFor(m.id),
        tools: !!m.supported_features?.includes('tools')
      }))
      .sort((a, b) => (b.contextWindow || 0) - (a.contextWindow || 0) || a.name.localeCompare(b.name));
  }

  // --- Built-in tools ---
  // Groq runs these server-side for the GPT-OSS models; we only switch them on and show what happened.

  // /web and /code don't use tool_choice "required": Groq then rejects the whole reply
  // ("Tool choice is required, but model did not call a tool") whenever the model judges the tool
  // pointless, e.g. for "hi". Instead we offer only that tool plus an explicit instruction, which
  // used the tool on every real request in testing and still answers small talk normally.
  const TOOL_DEFS = {
    web: {
      api: { type: 'browser_search' },
      nudge: 'The user explicitly asked you to search the web for this message. Use the browser search tool before answering; if searching truly makes no sense, answer normally.'
    },
    code: {
      api: { type: 'code_interpreter' },
      nudge: 'The user explicitly asked you to use the Python code interpreter for this message. Run code with it before answering whenever the request involves any calculation, data or verifiable fact; if running code truly makes no sense, answer normally.'
    }
  };

  const supportsBuiltInTools = model => /^openai\/gpt-oss-(120b|20b)$/.test(model || '');

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // Turn one executed_tools entry into a small, UI-friendly step
  function toolStep(t) {
    const name = t.name || '';
    const rawArgs = typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments || {});
    const args = parseJson(rawArgs) || {};
    const output = typeof t.output === 'string' ? t.output : null;
    const step = { index: t.index, done: output !== null };

    if (name.startsWith('browser.')) {
      step.kind = name.slice(8); // search | open | find
      const urls = new Set();
      const pageUrl = output && /URL:\s*(?:\n\s*L\d+:\s*)?(https?:\/\/[^\s)]+)/.exec(output)?.[1];
      if (pageUrl) urls.add(pageUrl);
      if (typeof args.id === 'string' && /^https?:\/\//.test(args.id)) urls.add(args.id);
      for (const r of t.search_results?.results || []) if (r?.url) urls.add(r.url);
      step.urls = [...urls].filter(u => !/^https?:\/\/(www\.)?exa\.ai\//.test(u));
      step.label = step.kind === 'search' ? args.query : step.kind === 'find' ? args.pattern : step.urls[0] || '';
      step.failed = !!output && /^(No pages to access|Error:)/.test(output.trim());
    } else {
      step.kind = 'code';
      step.code = typeof args.code === 'string' ? args.code : rawArgs;
      if (output !== null) step.output = output.length > 4000 ? `${output.slice(0, 4000)}\n…` : output;
    }
    return step;
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // What the project a chat belongs to adds to this request (see engine/shared/project-knowledge.js)
  async function gatherProjectKnowledge({ projectId, chatId, model, messages, maxTokens }) {
    if (!projects().get(projectId)) return { messages: [], sources: [], pinnedFiles: [], note: '' };
    const limit = tokenLimits.get(model);
    const tpm = limit && Date.now() - limit.at < 10 * 60 * 1000 ? limit.tpm : undefined;
    return knowledge().gather({ projectId, chatId, messages, maxTokens, contextWindow: modelCaps.get(model)?.contextWindow || 0, tpm });
  }

  // One chat request, streamed back to the page as chat:* events. bare: no memory or project knowledge.
  async function streamChat({ requestId, model, messages, temperature, maxTokens, tools = [], forceTool = null, bare = false, projectId = null, chatId = null, ignoreEffort = false }) {
    const controller = new AbortController();
    activeRequests.set(requestId, controller);
    const send = (channel, payload) => emit(channel, { requestId, ...payload });

    const started = Date.now();
    let firstTokenAt = null;
    try {
      const key = getApiKey();
      if (!key) throw new Error('Add your Groq API key in Settings first.');
      const toolIds = (forceTool ? [forceTool] : tools).filter(id => TOOL_DEFS[id]);
      if (forceTool && !supportsBuiltInTools(model)) {
        throw new Error('Web search and the code runner only work with GPT OSS 120B or 20B.');
      }
      const builtInTools = toolIds.length && supportsBuiltInTools(model) ? toolIds.map(id => TOOL_DEFS[id].api) : [];
      const memory = bare ? { enabled: false } : loadSettings().memory;
      const canCallFunctions = !!modelCaps.get(model)?.tools;
      // Every model gets its memories as context; only function-calling models get the tools
      // A project with its own notes switched on keeps them separate: its chats read and write those
      // notes through the memory tools and learning, while your general memory (if on) is still read
      const projectMemory = projectId && !bare && projects().get(projectId)?.memory ? projectMemoryScope(projectId) : null;
      const toolScope = projectMemory || GLOBAL_MEMORY;
      const memoryTools = (memory.enabled || projectMemory) && canCallFunctions ? MEMORY_TOOLS : [];
      // Project files (pinned ones, then matching passages)
      let knowledgeMessages = [];
      if (projectId && !bare) {
        const found = await gatherProjectKnowledge({ projectId, chatId, model, messages, maxTokens });
        knowledgeMessages = found.messages;
        if (found.sources.length || found.pinnedFiles.length || found.note) {
          send('chat:meta', { sources: found.sources, pinnedFiles: found.pinnedFiles, knowledgeNote: found.note });
        }
      }
      // Memory and pinned project files go right after any system prompt. What changes with every message
      // (matching excerpts, the /web or /code instruction) goes just before the newest user message, so the
      // start of the request stays identical and Groq can serve it from its prompt cache.
      const { stable: pinnedKnowledge, volatile: excerptKnowledge } = ProjectContext.splitKnowledge(knowledgeMessages);
      const stableSystem = [];
      if (memory.enabled) stableSystem.push({ role: 'system', content: memoryPrompt(loadMemories(), memoryTools.length > 0 && !projectMemory) });
      if (projectMemory) stableSystem.push({ role: 'system', content: memoryPrompt(loadMemories(projectMemory), memoryTools.length > 0, projectMemory) });
      stableSystem.push(...pinnedKnowledge);
      const volatileSystem = [...excerptKnowledge];
      if (forceTool) volatileSystem.push({ role: 'system', content: TOOL_DEFS[forceTool].nudge });
      const sendMessages = ProjectContext.arrangeSystem(messages, { stable: stableSystem, volatile: volatileSystem });

      // The level is looked up for the model actually sent (a /web message may run on another model than
      // the selected one). A voice call leaves it to Groq: its short answers share a small token cap with the thinking.
      let effort = ignoreEffort ? undefined : reasoningRules.effortFor(model, loadSettings().reasoningEffort);
      const post = (tokens, offerFunctions) => {
        const tools = [...builtInTools, ...(offerFunctions ? memoryTools : [])];
        return fetch(`${API_BASE}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: sendMessages,
            temperature,
            max_completion_tokens: tokens,
            stream: true,
            ...(effort ? { reasoning_effort: effort } : {}),
            ...(tools.length ? { tools, tool_choice: 'auto' } : {})
          })
        });
      };
      // If Groq stops taking a level it used to, send the message without it instead of failing
      const request = async (tokens, offerFunctions) => {
        const res = await post(tokens, offerFunctions);
        if (!effort || res.status !== 400 || !reasoningRules.isEffortError(await groqError(res.clone()))) return res;
        effort = undefined;
        return post(tokens, offerFunctions);
      };

      // Memory tools run here, so a reply that calls one takes another round trip to finish.
      // The last round doesn't offer them, which forces a written answer.
      const MAX_ROUNDS = 4;
      const totals = { prompt_tokens: 0, completion_tokens: 0, completion_time: 0, queue_time: 0, cached_tokens: 0 };
      let finishReason = null;
      let replyText = '';
      let usedMemoryTools = false;
      let memoryStep = 0;

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const offerFunctions = round < MAX_ROUNDS - 1;
        let res = await request(maxTokens, offerFunctions);
        for (let retry = 0; res.status === 429 && retry < 3; retry++) {
          const message = await groqError(res.clone());
          // Groq reserves max_completion_tokens against the per-minute output budget, which is
          // small for some free-tier models; retry with a request that fits that budget.
          const limit = /output tokens per minute.*?Limit (\d+)/i.exec(message)?.[1];
          if (/Request too large/i.test(message) && limit && Number(limit) < maxTokens) {
            res = await request(Math.floor(Number(limit) * 0.9), offerFunctions);
            continue;
          }
          // Per-minute limits reset quickly: wait out a short one instead of failing mid-task. The
          // Retry-After header says how long; Groq's wording ("try again in 990ms / 7.5s / 1m2s") is
          // only a fallback for when it's missing.
          const hint = /try again in (?:(\d+)m(?!s))?([\d.]+)(ms|s)\b/i.exec(message);
          const headerWait = Number(res.headers.get('retry-after'));
          const wait = headerWait > 0 ? headerWait : hint && !hint[1] ? Number(hint[2]) / (hint[3] === 'ms' ? 1000 : 1) : NaN;
          if (!(wait > 0 && wait <= 30)) break;
          send('chat:status', { message: `Waiting ${Math.ceil(wait)}s for Groq's per-minute limit…` });
          await sleep(wait * 1000 + 250);
          send('chat:status', { message: '' });
          res = await request(maxTokens, offerFunctions);
        }
        if (!res.ok) throw new Error(await groqError(res));
        send('chat:meta', { rateLimits: rateLimitsFrom(res.headers) });
        rememberTokenLimit(model, res.headers);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let usage = null;
        let roundText = '';
        const calls = [];
        finishReason = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let chunk;
            try {
              chunk = JSON.parse(payload);
            } catch {
              continue;
            }
            if (chunk.error) throw new Error(chunk.error.message || 'Stream error');
            const choice = chunk.choices?.[0];
            let content = choice?.delta?.content || '';
            const reasoning = choice?.delta?.reasoning || '';
            // Keep text from before and after a memory call from running together
            if (content && !roundText && replyText) content = `\n\n${content}`;
            roundText += content;
            replyText += content;
            if ((content || reasoning) && !firstTokenAt) firstTokenAt = Date.now();
            if (content || reasoning) send('chat:delta', { content, reasoning });
            // Each built-in tool step arrives once when it starts and again with its output
            for (const t of choice?.delta?.executed_tools || []) send('chat:tool', { step: toolStep(t) });
            // Function calls can arrive in pieces; stitch them together by index
            for (const c of choice?.delta?.tool_calls || []) {
              const call = (calls[c.index ?? calls.length] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
              if (c.id) call.id = c.id;
              if (c.function?.name) call.function.name += c.function.name;
              if (c.function?.arguments) call.function.arguments += c.function.arguments;
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            usage = chunk.x_groq?.usage || chunk.usage || usage;
          }
        }
        for (const k of Object.keys(totals)) totals[k] += usage?.[k] || 0;
        totals.cached_tokens += usage?.prompt_tokens_details?.cached_tokens || 0;

        const toolCalls = calls.filter(Boolean);
        if (!toolCalls.length) break;
        sendMessages.push({ role: 'assistant', content: roundText || null, tool_calls: toolCalls });
        usedMemoryTools = true;
        for (const call of toolCalls) {
          const outcome = runMemoryTool(call.function.name, call.function.arguments, toolScope);
          send('chat:tool', { step: { index: `memory-${memoryStep++}`, kind: 'memory', done: true, ...outcome.step } });
          sendMessages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.result) });
        }
      }

      send('chat:done', {
        finishReason,
        stats: {
          totalMs: Date.now() - started,
          firstTokenMs: firstTokenAt ? firstTokenAt - started : null,
          promptTokens: totals.prompt_tokens || null,
          cachedTokens: totals.cached_tokens || null,
          completionTokens: totals.completion_tokens || null,
          completionTime: totals.completion_time || null,
          queueTime: totals.queue_time || null
        }
      });

      // Skip learning when the model already handled memory itself this turn
      const learning = projectMemory ? loadSettings().memory.learn : memory.enabled && memory.learn;
      if (learning && !usedMemoryTools) {
        const userText = messageText(messages.findLast(m => m.role === 'user')?.content);
        learnFromTurn(key, userText, replyText, toolScope).catch(err => console.error('Memory learning failed:', err.message));
      }
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        send('chat:done', { finishReason: 'stopped', stats: { totalMs: Date.now() - started } });
      } else {
        send('chat:error', { message: err.message });
      }
    } finally {
      activeRequests.delete(requestId);
    }
  }

  // The account's tokens-per-minute limit for a model, when Groq's response let the page read it
  const tokenLimits = new Map(); // model -> { tpm, at }

  function rememberTokenLimit(model, headers) {
    const tpm = Number(headers.get('x-ratelimit-limit-tokens'));
    if (tpm > 0) tokenLimits.set(model, { tpm, at: Date.now() });
  }

  const WHISPER_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];
  // Whisper spells unfamiliar names by sound ("Groq" comes out as "Grok"); a short prompt fixes that
  const WHISPER_VOCAB = 'Groq, GPT-OSS, Qwen, LaTeX, KaTeX, Python, JavaScript.';
  const AUDIO_EXTENSIONS = { webm: 'webm', ogg: 'ogg', mp4: 'mp4', m4a: 'm4a', mpeg: 'mp3', mp3: 'mp3', wav: 'wav', flac: 'flac' };

  async function transcribe(audioBytes, mimeType) {
    const key = getApiKey();
    if (!key) throw new Error('Add your Groq API key in Settings first.');
    const { voiceModel } = loadSettings();
    const form = new FormData();
    const ext = Object.entries(AUDIO_EXTENSIONS).find(([k]) => mimeType.includes(k))?.[1] || 'webm';
    form.append('file', new Blob([audioBytes], { type: mimeType }), `voice.${ext}`);
    form.append('model', WHISPER_MODELS.includes(voiceModel) ? voiceModel : WHISPER_MODELS[0]);
    form.append('prompt', WHISPER_VOCAB);
    form.append('temperature', '0');
    form.append('response_format', 'json');
    const res = await fetch(`${API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form
    });
    if (!res.ok) throw new Error(await groqError(res));
    const data = await res.json();
    return (data.text || '').trim();
  }

  // Voice chat: the same transcription, but with Whisper's segment confidences so the page can drop the
  // "Thank you." it makes up for silence
  async function transcribeVerbose(audioBytes, mimeType) {
    const key = getApiKey();
    if (!key) throw new Error('Add your Groq API key in Settings first.');
    const { voiceModel } = loadSettings();
    const form = new FormData();
    const ext = Object.entries(AUDIO_EXTENSIONS).find(([k]) => mimeType.includes(k))?.[1] || 'wav';
    form.append('file', new Blob([audioBytes], { type: mimeType }), `voice.${ext}`);
    form.append('model', WHISPER_MODELS.includes(voiceModel) ? voiceModel : WHISPER_MODELS[0]);
    form.append('prompt', WHISPER_VOCAB);
    form.append('temperature', '0');
    form.append('response_format', 'verbose_json');
    const res = await fetch(`${API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form
    });
    if (!res.ok) throw new Error(await groqError(res));
    const data = await res.json();
    return {
      text: (data.text || '').trim(),
      segments: (data.segments || []).map(s => ({ no_speech_prob: s.no_speech_prob, avg_logprob: s.avg_logprob, compression_ratio: s.compression_ratio }))
    };
  }

  // Text to speech (Groq Orpheus). One request is at most 200 characters and comes back as WAV; the
  // page chunks the reply and plays the pieces in order. Requests can be cancelled by id so an
  // interruption stops fetching audio nobody will hear.
  const speechRequests = new Map();
  async function speak({ id, text, voice, model }) {
    const key = getApiKey();
    if (!key) return { ok: false, status: 401, message: 'Add your Groq API key in Settings first.' };
    const vc = loadSettings().voiceChat;
    const input = String(text || '').slice(0, 200);
    if (!input.trim()) return { ok: false, status: 400, message: 'Nothing to say.' };
    const controller = new AbortController();
    speechRequests.set(id, controller);
    try {
      const res = await fetch(`${API_BASE}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TTS_MODELS.includes(model) ? model : vc.ttsModel,
          voice: TTS_VOICES.includes(voice) ? voice : vc.voice,
          input,
          response_format: 'wav'
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        const message = await groqError(res).catch(() => `Speech failed (${res.status})`);
        return { ok: false, status: res.status, message, retryAfter: Number(res.headers.get('retry-after')) || 0 };
      }
      return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
    } catch (err) {
      return { ok: false, status: 0, aborted: err?.name === 'AbortError', message: err?.name === 'AbortError' ? 'Cancelled' : err.message };
    } finally {
      speechRequests.delete(id);
    }
  }

  // --- Settings and the API key ---

  // The key is kept in settings.json, inside the data folder that engine/storage.js encrypts before storing
  const getApiKey = () => loadSettings().plainKey || '';

  // What the page may see: everything except the key itself
  function publicSettings() {
    const { plainKey, ...rest } = loadSettings();
    return {
      ...rest,
      hasKey: !!plainKey,
      keySource: plainKey ? 'saved' : '',
      keyHint: plainKey ? `${plainKey.slice(0, 4)}…${plainKey.slice(-4)}` : ''
    };
  }

  function saveSettings(updates = {}) {
    const current = loadSettings();
    const allowed = ['model', 'systemPrompt', 'temperature', 'maxTokens', 'theme', 'accent', 'textSize', 'tools', 'voiceModel', 'chime', 'suggestions'];
    for (const k of allowed) if (k in updates) current[k] = updates[k];
    if (updates.reasoningEffort) current.reasoningEffort = reasoningRules.clean({ ...current.reasoningEffort, ...updates.reasoningEffort });
    if (updates.memory) current.memory = { ...current.memory, enabled: !!updates.memory.enabled, learn: !!updates.memory.learn };
    if (updates.voiceChat) current.voiceChat = cleanVoiceChat({ ...current.voiceChat, ...updates.voiceChat });
    writeJson(settingsFile(), current);
    return publicSettings();
  }

  async function setKey(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) throw new Error('Paste a key that starts with gsk_.');
    await listModels(key); // validate before saving
    writeJson(settingsFile(), { ...loadSettings(), plainKey: key });
    return publicSettings();
  }

  function clearKey() {
    const { plainKey, ...rest } = loadSettings();
    writeJson(settingsFile(), rest);
    return publicSettings();
  }

  // --- Project files ---

  function addProjectFiles(projectId, uploads) {
    const added = [];
    const errors = [];
    for (const upload of uploads) {
      try {
        const entry = files().add(projectId, upload);
        added.push(entry.name);
        ingest().enqueue(projectId, entry.id);
      } catch (err) {
        if (!(err instanceof FileError)) console.warn('Could not add a project file:', err);
        errors.push(err instanceof FileError ? err.message : `Could not add “${upload.name}”.`);
      }
    }
    if (added.length) emit('files:changed', { projectId });
    return { added, errors };
  }

  // "Add files": the browser's own file chooser
  function pickProjectFiles(projectId) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.addEventListener('cancel', () => resolve({ added: [], errors: [] }));
      input.addEventListener('change', async () => {
        const uploads = [];
        const errors = [];
        for (const file of input.files) {
          try {
            // Look at the size first, so a huge file is refused without being read
            if (file.size > LIMITS.fileBytes) errors.push(`“${file.name}” is larger than ${LIMITS.fileBytes / 1024 / 1024} MB.`);
            else uploads.push({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
          } catch {
            errors.push(`Could not read “${file.name}”.`);
          }
        }
        const result = addProjectFiles(projectId, uploads);
        resolve({ added: result.added, errors: [...errors, ...result.errors] });
      });
      input.click();
    });
  }

  // A project's own notes (the page manages them from the project's page)
  const projectNotes = projectId => (projects().get(projectId) ? projectMemoryScope(projectId) : null);

  // --- Starting up, one tab at a time ---

  // Two tabs would each keep their own copy of the data in memory and overwrite each other's saves,
  // so one tab at a time holds the data. Another tab can take it over; this one then steps aside.
  const LOCK = 'boltchat-data';
  const tabs = 'BroadcastChannel' in self ? new BroadcastChannel('boltchat-tabs') : null;
  let steppedAside = false;

  // A full-page note: open in another tab, moved to another tab, or could not start
  function notice({ title, body, button, action }) {
    document.querySelector('.web-notice')?.remove();
    const box = document.createElement('div');
    box.className = 'web-notice';
    box.setAttribute('role', 'alertdialog');
    const card = box.appendChild(document.createElement('div'));
    card.className = 'web-notice-card';
    card.appendChild(document.createElement('h1')).textContent = title;
    card.appendChild(document.createElement('p')).textContent = body;
    if (button) {
      const b = card.appendChild(document.createElement('button'));
      b.className = 'primary-btn';
      b.textContent = button;
      b.addEventListener('click', action);
    }
    document.body.appendChild(box);
    return box;
  }

  async function holdData() {
    if (!navigator.locks) return;
    let waiting = null;
    await new Promise(acquired => {
      const hold = () => new Promise(release => {
        acquired();
        // Another tab asked for the data: save, let go, and stop using it here
        tabs?.addEventListener('message', async e => {
          if (e.data !== 'take-over') return;
          notice({ title: 'Boltchat moved to another tab', body: 'Your chats are open in the tab you just switched to. Reload this one to use it here again.', button: 'Reload', action: () => location.reload() });
          await saveNow().catch(() => {});
          await storage.idle().catch(() => {});
          steppedAside = true;
          release();
        });
      });
      navigator.locks.request(LOCK, { ifAvailable: true }, lock => {
        if (lock) return hold();
        waiting = notice({
          title: 'Boltchat is open in another tab',
          body: 'Your chats live in this browser, and one tab at a time works with them so nothing gets overwritten.',
          button: 'Use Boltchat here',
          action: () => tabs?.postMessage('take-over')
        });
        navigator.locks.request(LOCK, hold); // waits until the other tab closes or steps aside
        return undefined;
      });
    });
    waiting?.remove();
  }

  // The page keeps the chats and saves all of them at once. Until it has read them from storage it has
  // none, and asking it to save then would replace the stored chats with nothing.
  let pageHasChats = false;
  let flushed = () => {};

  // Asks the page to hand over anything it hasn't saved yet (it saves chats 300 ms after a change)
  function saveNow() {
    if (!pageHasChats) return storage.flush();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, 1500);
      flushed = () => {
        clearTimeout(timer);
        resolve();
      };
      emit('app:flush');
    }).then(() => storage.flush());
  }

  // Leaving the tab (or the browser closing it) is the last chance to write to storage
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveNow().catch(() => {});
  });
  addEventListener('pagehide', () => { storage.flush().catch(() => {}); });

  // The page's scripts are separate files that call each other; none of their requests may be answered
  // before all of them have run
  const pageLoaded = new Promise(resolve => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve, { once: true });
    else resolve();
  });

  const ready = (async () => {
    await holdData();
    await pageLoaded;
    const stored = await storage.load();
    // A project deleted last session can no longer be undone
    try { projects().purgeAllTrash(); } catch (err) { console.warn('Could not clear deleted projects:', err); }
    // Files left unfinished by the last session start over
    try { ingest().resume(projects().list().map(p => p.id)); } catch (err) { console.warn('Could not resume file indexing:', err); }
    return { stored };
  })();
  ready.catch(err => {
    console.error(err);
    notice({ title: 'Boltchat could not start', body: String(err?.message || err), button: 'Reload', action: () => location.reload() });
  });

  // --- What the page calls ---

  // Every call waits until the data folder is loaded, and copies what goes in and what comes out
  const call = fn => async (...args) => {
    await ready;
    if (steppedAside) return new Promise(() => {}); // this tab no longer holds the data
    return copy(await fn(...args.map(copy)));
  };

  window.groq = {
    getSettings: call(publicSettings),
    saveSettings: call(saveSettings),
    setKey: call(setKey),
    clearKey: call(clearKey),
    listModels: call(() => listModels()),
    testKey: call(async () => {
      const started = Date.now();
      const models = await listModels();
      return { ms: Date.now() - started, modelCount: models.length };
    }),
    appInfo: call(() => ({ version: VERSION })),
    loadChats: call(() => {
      const chats = readJson(chatsFile(), []);
      try { chatIndex().sync(chats); } catch (err) { console.warn('Could not index earlier chats:', err); }
      setTimeout(() => { pageHasChats = true; }, 0);
      return chats;
    }),
    saveChats: call(chats => {
      const list = Array.isArray(chats) ? chats : [];
      writeJson(chatsFile(), list);
      // Project chats feed the search of later chats in the same project
      try { chatIndex().sync(list); } catch (err) { console.warn('Could not index earlier chats:', err); }
      return true;
    }),
    send: call(request => {
      streamChat(request); // streams back over the chat:* events
      return true;
    }),
    stop: call(requestId => {
      activeRequests.get(requestId)?.abort();
      return true;
    }),
    transcribe: call((bytes, mimeType) => transcribe(bytes, mimeType)),
    transcribeVerbose: call((bytes, mimeType) => transcribeVerbose(bytes, mimeType)),
    speak: call(request => speak(request)),
    speakCancel: call(id => {
      // no id: cancel everything in flight (the call ended or the user interrupted)
      for (const [key, controller] of speechRequests) if (!id || key === id) controller.abort();
      return true;
    }),
    // https for links, mailto for "Report a response" (opens the user's email app, nothing is sent by Boltchat)
    openExternal: async url => {
      if (/^(https:\/\/|mailto:)/.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
    },
    listMemories: call(() => loadMemories()),
    addMemory: call(text => addMemory(text, 'user')),
    updateMemory: call((id, text) => updateMemory(id, text)),
    deleteMemory: call(id => deleteMemory(id)),
    clearMemories: call(() => saveMemories([])),
    // Projects. The page owns the chats, so it moves and deletes a project's chats itself;
    // these only manage the project rows and their folders.
    projects: {
      list: call(() => projects().list()),
      create: call(name => projects().create(name)),
      update: call((id, changes) => projects().update(id, changes)),
      remove: call(id => {
        ingest().drop(id);
        chatIndex().forget(id);
        knowledge().forget(id);
        return projects().remove(id);
      }),
      restore: call(project => {
        const restored = projects().restore(project);
        if (restored) ingest().resume([restored.id]); // files that were still indexing carry on
        return restored;
      }),
      purge: call(id => projects().purge(id))
    },
    projectMemory: {
      list: call(projectId => { const s = projectNotes(projectId); return s ? loadMemories(s) : []; }),
      add: call((projectId, text) => { const s = projectNotes(projectId); if (!s) throw new Error('That project no longer exists.'); return addMemory(text, 'user', s); }),
      update: call((projectId, id, text) => { const s = projectNotes(projectId); return s ? updateMemory(id, text, s) : null; }),
      remove: call((projectId, id) => { const s = projectNotes(projectId); return s ? deleteMemory(id, s) : null; }),
      clear: call(projectId => { const s = projectNotes(projectId); return s ? saveMemories([], s) : []; }),
      onChanged: on('projects:memory-changed')
    },
    files: {
      list: call(projectId => files().list(projectId)),
      add: call((projectId, uploads) => {
        const list = Array.isArray(uploads) ? uploads.filter(u => u && typeof u.name === 'string' && u.bytes) : [];
        return addProjectFiles(projectId, list.map(u => ({ name: u.name, bytes: Buffer.from(u.bytes) })));
      }),
      pick: call(pickProjectFiles),
      remove: call((projectId, id) => {
        ingest().drop(projectId, id);
        const removed = files().remove(projectId, id);
        if (removed) emit('files:changed', { projectId });
        return removed;
      }),
      setMode: call((projectId, id, mode) => files().setMode(projectId, id, mode)),
      retry: call((projectId, id) => ingest().retry(projectId, id)),
      status: call(async () => ({ embeddings: await ingest().embeddingsAvailable() })),
      // Reads every file of the project again, and the project's earlier chats too
      reindex: call(projectId => {
        if (!projects().get(projectId)) return false;
        ingest().reindex(projectId);
        try {
          fs.rmSync(path.join(projects().folder(projectId), 'index', 'chats.json'), { force: true });
          chatIndex().forget(projectId);
          chatIndex().sync(readJson(chatsFile(), []));
        } catch (err) {
          console.warn('Could not rebuild the chat index:', err);
        }
        return true;
      }),
      onChanged: on('files:changed')
    },
    getSuggestions: call(() => {
      const { suggestions } = loadSettings();
      return suggestions === false ? null : readJson(suggestionsFile(), null);
    }),
    refreshSuggestions: call(() => refreshSuggestions()),
    onStatus: on('chat:status'),
    onMemoryChanged: on('memory:changed'),
    onMemoryLearned: on('memory:learned'),
    onMeta: on('chat:meta'),
    onDelta: on('chat:delta'),
    onTool: on('chat:tool'),
    onDone: on('chat:done'),
    onError: on('chat:error'),
    // Before the tab goes away, the engine asks the page to save everything right away
    onFlush: on('app:flush'),
    flushed: () => flushed(),
    // Parts of the Windows app that a web page doesn't have; the page's scripts still name them
    onNavigate: () => () => {},
    openDataFolder: async () => {},
    openStartupSettings: async () => {},
    testNotification: async () => {}
  };

  // What the page's web-only controls use (web-shell.js): storage status, backup, restore and erase
  window.boltchatWeb = {
    version: VERSION,
    ready,
    storage: {
      status: () => storage.status(),
      keepSafe: () => storage.keepSafe(),
      onSaveError: handler => storage.onSaveError(handler),
      exportBackup: async () => {
        await saveNow();
        return storage.exportBackup();
      },
      importBackup: file => storage.importBackup(file),
      erase: () => storage.eraseEverything()
    }
  };
})();
