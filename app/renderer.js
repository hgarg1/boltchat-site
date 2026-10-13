/* global marked, DOMPurify, ConversationHistory, ProjectContext */
const api = window.groq;
const conversationHistory = ConversationHistory;
const $ = id => document.getElementById(id);

const el = {
  app: document.querySelector('.app'),
  chatList: $('chat-list'),
  chatSearch: $('chat-search'),
  newChat: $('new-chat'),
  toggleSidebar: $('toggle-sidebar'),
  modelPicker: $('model-picker'),
  effortPicker: $('effort-picker'),
  effortSlot: $('effort-dropdown'),
  effortNote: $('effort-note'),
  themeBtn: $('theme-btn'),
  onboarding: $('onboarding'),
  keyForm: $('key-form'),
  keyInput: $('key-input'),
  keySave: $('key-save'),
  keyError: $('key-error'),
  thread: $('thread'),
  empty: $('empty'),
  suggestions: $('suggestions'),
  messages: $('messages'),
  composerWrap: $('composer-wrap'),
  composer: $('composer'),
  prompt: $('prompt'),
  sendBtn: $('send-btn'),
  attachBtn: $('attach-btn'),
  fileInput: $('file-input'),
  attachments: $('attachments'),
  micBtn: $('mic-btn'),
  hint: $('composer-hint'),
  limits: $('limits'),
  limitRequests: $('limit-requests'),
  limitTokens: $('limit-tokens'),
  meterRequests: $('meter-requests'),
  meterTokens: $('meter-tokens'),
  limitNote: $('limit-note'),
  settingsModal: $('settings-modal'),
  openSettings: $('open-settings'),
  closeSettings: $('close-settings'),
  settingsSaved: $('settings-saved'),
  settingsTabs: document.querySelectorAll('.settings-tab'),
  settingsSections: document.querySelectorAll('.settings-section'),
  defaultModelSlot: $('default-model-dropdown'),
  tempPresets: $('temp-presets'),
  temperature: $('temperature'),
  temperatureValue: $('temperature-value'),
  maxTokensSlot: $('max-tokens-dropdown'),
  maxTokensNote: $('max-tokens-note'),
  promptTemplates: $('prompt-templates'),
  systemPrompt: $('system-prompt'),
  promptCount: $('prompt-count'),
  themeCards: $('theme-cards'),
  accentSwatches: $('accent-swatches'),
  textSizeSlot: $('text-size-dropdown'),
  voiceModelSlot: $('voice-model-dropdown'),
  chimeSwitch: $('chime-switch'),
  chimePreview: $('chime-preview'),
  suggestionsSwitch: $('suggestions-switch'),
  keyDot: $('key-dot'),
  keyStatus: $('key-status'),
  keyMeta: $('key-meta'),
  testKey: $('test-key'),
  testResult: $('test-result'),
  changeKey: $('change-key'),
  removeKey: $('remove-key'),
  usageCard: $('usage-card'),
  usageModel: $('usage-model'),
  usageReq: $('usage-req'),
  usageTok: $('usage-tok'),
  aboutVersion: $('about-version'),
  openData: $('open-data'),
  toolCards: $('tool-cards'),
  toolNote: $('tool-note'),
  slashList: $('slash-list'),
  memorySwitch: $('memory-switch'),
  memoryLearnSwitch: $('memory-learn-switch'),
  memoryNote: $('memory-note'),
  memoryCount: $('memory-count'),
  memoryForm: $('memory-form'),
  memoryInput: $('memory-input'),
  memoryList: $('memory-list'),
  memoryClear: $('memory-clear'),
  slashMenu: $('slash-menu'),
  modeChip: $('mode-chip')
};

const state = {
  settings: null,
  models: [],
  chats: [],
  activeId: null,
  pending: [], // image data URLs waiting to be sent
  streaming: null, // { requestId, chatId, msg, node }
  recorder: null,
  lastLimits: null,
  forcedTool: null, // 'web' | 'code' when a slash command is active for the next message
  slash: { items: [], highlighted: 0 },
  editingMessage: null, // { chatId, index, content, images, waitingForStop, parkedIndex, saving }
  renamingChat: null, // { chatId, draft }
  projects: [], // see projects.js
  projectView: null, // id of the project page being shown instead of the thread
  newChatProjectId: null, // project the next new chat will be created in
  renamingProject: null, // { projectId, draft }
  memories: [] // shown in Settings → Memory
};

// Groq runs these for the GPT-OSS models (see TOOL_DEFS in main.js)
const TOOLS = {
  web: {
    icon: '🌐',
    name: 'Web search',
    chip: 'Web search',
    description: 'Searches the web and reads pages to answer questions about current events, docs and facts.',
    caution: 'Reading pages can use tens of thousands of tokens per answer on the free tier.'
  },
  code: {
    icon: '🐍',
    name: 'Code runner',
    chip: 'Run code',
    description: 'Writes and runs Python in a sandbox for math, data crunching and exact answers.',
    caution: 'Usually light on tokens.'
  }
};
const TOOL_MODEL = 'openai/gpt-oss-120b';
const supportsTools = id => /^openai\/gpt-oss-(120b|20b)$/.test(id || '');

const SLASH_COMMANDS = [
  { cmd: 'web', icon: '🌐', args: '<question>', description: 'Search the web for this message' },
  { cmd: 'code', icon: '🐍', args: '<task>', description: 'Run Python to answer this message' },
  { cmd: 'model', icon: '◆', args: '<name>', description: 'Switch to another model' },
  { cmd: 'system', icon: '✎', args: '<prompt>', description: 'Set the system prompt for all chats' },
  { cmd: 'remember', icon: '✦', args: '<fact>', description: 'Save something to memory' },
  { cmd: 'new', icon: '＋', args: '', description: 'Start a new chat' }
];

const ACCENTS = {
  groq: { label: 'Groq orange', dark: ['#f55036', '#ff6a52'], light: ['#e0442b', '#c93a23'] },
  violet: { label: 'Violet', dark: ['#8b5cf6', '#a078ff'], light: ['#7c3aed', '#6d28d9'] },
  blue: { label: 'Blue', dark: ['#3b82f6', '#5b9bff'], light: ['#2563eb', '#1d4ed8'] },
  teal: { label: 'Teal', dark: ['#14b8a6', '#2dd4bf'], light: ['#0d9488', '#0f766e'] },
  pink: { label: 'Pink', dark: ['#ec4899', '#f472b6'], light: ['#db2777', '#be185d'] },
  amber: { label: 'Amber', dark: ['#f59e0b', '#fbbf24'], light: ['#d97706', '#b45309'] }
};

const TEXT_SIZES = {
  small: { label: 'Small', description: 'Fits more on screen', px: 14 },
  default: { label: 'Default', description: 'Comfortable for most displays', px: 15 },
  large: { label: 'Large', description: 'Easier to read', px: 16.5 },
  xlarge: { label: 'Extra large', description: 'Big and clear', px: 18 }
};

const MAX_TOKEN_OPTIONS = [
  [1024, 'Short', 'About a paragraph or two'],
  [2048, 'Medium', 'A page of text'],
  [4096, 'Long', 'Detailed answers (recommended)'],
  [8192, 'Very long', 'Long documents and code'],
  [16384, 'Extra long', 'Very large outputs'],
  [32768, 'Maximum', 'Only some models allow this much']
];

const PROMPT_TEMPLATES = [
  ['Concise', 'You are a concise assistant. Answer directly, prefer short paragraphs and bullet points, and skip filler.'],
  ['Coding buddy', 'You are a senior software engineer. Give working code first, then a brief explanation. Point out edge cases and pitfalls.'],
  ['Patient teacher', 'You are a patient teacher. Explain step by step with simple examples, check for understanding, and avoid jargon unless you define it.'],
  ['Writing editor', 'You are a careful editor. Improve clarity and flow while keeping the author\'s voice. Show the revised text, then list the key changes.'],
  ['Translator', 'You are a professional translator. Translate the user\'s text naturally, keep formatting, and note any phrases that have no direct equivalent.']
];

marked.setOptions({ gfm: true, breaks: false });

// ---------- Helpers ----------

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---------- Toasts ----------
// Stacked at the bottom and tinted by what triggered them. toast(text[, ms]) is a neutral note;
// toast.success / .error / .warn / .memory / .agent / .undo pick a color and icon. Options:
//   ms       how long it stays (defaults by kind and length; hovering pauses it)
//   action   { label, run } — a button on the toast
//   onExpire called when the toast goes away without its action being used
//   effect   'celebrate' | 'shimmer' | 'rewind' — reserved for rare moments, never for errors
// The same message again bumps a ×N counter instead of stacking a duplicate.
const TOAST_ICONS = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>',
  success: '<path class="draw" d="M5.5 12.5l4.2 4.2L18.5 7.5"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
  warn: '<path d="M12 3.8 2.9 19.5h18.2z"/><path d="M12 10v4M12 17v.01"/>',
  memory: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  agent: '<path d="m8.5 8-4.5 4 4.5 4M15.5 8l4.5 4-4.5 4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'
};
const TOAST_MAX = 4;
const toastRegion = (() => {
  const region = document.createElement('div');
  region.className = 'toasts';
  region.setAttribute('aria-live', 'polite');
  document.body.appendChild(region);
  return region;
})();

// Sit just above whatever is at the bottom: the chat composer (centered on it), or the Code
// status bar, so a toast never covers what you're typing
function placeToasts() {
  const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
  const composer = document.querySelector('.composer');
  const status = document.getElementById('ws-status');
  const codeMode = !!document.querySelector('.mode-code');
  let bottom = 22;
  let center = innerWidth / 2;
  if (!codeMode && visible(composer)) {
    const r = composer.getBoundingClientRect();
    bottom = Math.max(22, innerHeight - r.top + 12);
    center = r.left + r.width / 2;
  } else if (visible(status)) {
    bottom = status.getBoundingClientRect().height + 14;
  }
  toastRegion.style.bottom = `${Math.round(bottom)}px`;
  toastRegion.style.left = `${Math.round(center)}px`;
}
addEventListener('resize', () => toastRegion.childElementCount && placeToasts());

function toast(text, opts = {}) {
  if (typeof opts === 'number') opts = { ms: opts };
  placeToasts();
  const kind = TOAST_ICONS[opts.kind] ? opts.kind : 'info';
  text = String(text ?? '').replace(/^[✦✓⌨↶]\s*/, ''); // the icon says it now
  const ms = opts.ms || Math.min(9000, (kind === 'error' ? 5200 : kind === 'warn' ? 4200 : 2800) + Math.max(0, text.length - 40) * 45);

  // Same message still showing: count it instead of stacking a copy
  const same = [...toastRegion.children].find(t => !t.classList.contains('leaving') && t.dataset.kind === kind && t.dataset.text === text);
  if (same) {
    const count = Number(same.dataset.count || 1) + 1;
    same.dataset.count = count;
    same.querySelector('.toast-count').textContent = `×${count}`;
    same.classList.remove('bump');
    void same.offsetWidth;
    same.classList.add('bump');
    same.restart(ms);
    return same;
  }

  const node = document.createElement('div');
  node.className = `toast toast-${kind}${opts.effect ? ` fx-${opts.effect}` : ''}`;
  node.dataset.kind = kind;
  node.dataset.text = text;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.innerHTML = `<span class="toast-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TOAST_ICONS[kind]}</svg></span><span class="toast-text"></span><span class="toast-count"></span><button class="toast-close" aria-label="Dismiss">✕</button><span class="toast-bar"></span>`;
  node.querySelector('.toast-text').textContent = text;
  if (opts.action) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.textContent = opts.action.label;
    button.addEventListener('click', e => {
      e.stopPropagation();
      acted = true;
      dismiss();
      opts.action.run();
    });
    node.insertBefore(button, node.querySelector('.toast-close'));
  }

  let acted = false;
  let timer = 0;
  let endsAt = 0;
  let left = ms;
  function dismiss() {
    clearTimeout(timer);
    if (node.classList.contains('leaving')) return;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 260);
    if (!acted) opts.onExpire?.();
  }
  node.restart = next => {
    clearTimeout(timer);
    left = next;
    endsAt = Date.now() + next;
    timer = setTimeout(dismiss, next);
    const bar = node.querySelector('.toast-bar');
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = '';
    node.style.setProperty('--toast-ms', `${next}ms`);
  };
  node.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    left = Math.max(800, endsAt - Date.now());
  });
  node.addEventListener('mouseleave', () => {
    endsAt = Date.now() + left;
    timer = setTimeout(dismiss, left);
  });
  node.querySelector('.toast-close').addEventListener('click', e => {
    e.stopPropagation();
    dismiss();
  });
  node.addEventListener('click', dismiss);

  toastRegion.appendChild(node);
  const live = [...toastRegion.children].filter(t => !t.classList.contains('leaving'));
  live.slice(0, Math.max(0, live.length - TOAST_MAX)).forEach(t => t.querySelector('.toast-close').click());
  node.restart(ms);
  if (opts.effect && !matchMedia('(prefers-reduced-motion: reduce)').matches) toastEffect(node, opts.effect);
  return node;
}
for (const kind of Object.keys(TOAST_ICONS)) toast[kind] = (text, opts = {}) => toast(text, { ...(typeof opts === 'number' ? { ms: opts } : opts), kind });

// Particles for the special moments: a confetti burst, drifting sparkles
function toastEffect(node, effect) {
  const icon = node.querySelector('.toast-icon');
  const burst = (count, make) => {
    for (let i = 0; i < count; i++) {
      const p = document.createElement('i');
      p.className = 'toast-particle';
      make(p, i);
      icon.appendChild(p);
      p.addEventListener('animationend', () => p.remove());
      setTimeout(() => p.remove(), 2000); // in case the animation never ends (e.g. a hidden window)
    }
  };
  if (effect === 'celebrate') {
    const colors = ['#22c55e', '#facc15', '#38bdf8', '#f472b6', '#a78bfa', '#fb923c'];
    burst(26, (p, i) => {
      const angle = (i / 26) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 60 + Math.random() * 75;
      p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--dy', `${Math.sin(angle) * dist * 0.8 - 34}px`);
      p.style.setProperty('--rot', `${Math.random() * 540 - 270}deg`);
      p.style.setProperty('--delay', `${Math.random() * 90}ms`);
      p.style.background = colors[i % colors.length];
      if (i % 3 === 0) p.classList.add('round');
    });
  } else if (effect === 'shimmer') {
    burst(9, (p, i) => {
      p.classList.add('spark');
      p.textContent = '✦';
      p.style.setProperty('--dx', `${(Math.random() - 0.5) * 70}px`);
      p.style.setProperty('--dy', `${-26 - Math.random() * 30}px`);
      p.style.setProperty('--delay', `${i * 70}ms`);
      p.style.fontSize = `${8 + Math.random() * 8}px`;
    });
  }
}

// ---------- Math ----------
// Math is lifted out before Markdown runs (Markdown would eat the backslashes in \[ \frac … \]),
// replaced by placeholders, and typeset with KaTeX after sanitizing. KaTeX output is built from
// escaped TeX with trust disabled, so inserting it after DOMPurify is safe.

const MATH_NONCE = Math.random().toString(36).slice(2, 8).toUpperCase();
const MATH_TOKEN = new RegExp(`<p>KTX${MATH_NONCE}(\\d+)E</p>|KTX${MATH_NONCE}(\\d+)E`, 'g');
const MATH_ENVS = 'equation|align|alignat|gather|multline|flalign|eqnarray|split|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|array|CD';
const MATH_PATTERN = new RegExp([
  String.raw`\$\$([\s\S]+?)\$\$`, // $$ display $$
  String.raw`\\\[([\s\S]+?)\\\]`, // \[ display \]
  String.raw`(\\begin\{(${MATH_ENVS})\*?\}[\s\S]+?\\end\{\4\*?\})`, // bare \begin{align}…\end{align}
  String.raw`\\\(([\s\S]+?)\\\)`, // \( inline \)
  // $inline$: no space just inside the dollars and no digit right after, so "$5 and $10" stays text
  String.raw`(?<![\\$\w])\$(?=[^\s$])([^\n$]*?[^\s\\$])\$(?![\w$])`
].join('|'), 'g');
// Some models write display math as a bare "[ … ]" line; treat it as math only if it contains TeX
const BARE_BRACKET_LINE = /^[ \t]*\[[ \t]*([^\n]*?(?:\\[a-zA-Z]+|[\^_]\{)[^\n]*?)[ \t]*\][ \t]*$/gm;
const CODE_SPANS = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/;

const mathCache = new Map();

function typeset(tex, display) {
  const key = `${display ? 'D' : 'I'}${tex}`;
  if (mathCache.has(key)) return mathCache.get(key);
  let html;
  try {
    html = katex.renderToString(tex.trim(), {
      displayMode: display,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml'
    });
    if (display) {
      html = `<div class="math-block" data-tex="${escapeHtml(tex.trim())}"><div class="math-scroll">${html}</div><button class="math-copy" title="Copy LaTeX">TeX</button></div>`;
    } else {
      html = `<span class="math-inline">${html}</span>`;
    }
  } catch (err) {
    const message = String(err.message || err).replace(/^KaTeX parse error:\s*/, '');
    html = `<code class="math-error" title="Couldn't typeset: ${escapeHtml(message)}">${escapeHtml(tex)}</code>`;
  }
  if (mathCache.size > 800) mathCache.clear();
  mathCache.set(key, html);
  return html;
}

function extractMath(text) {
  const math = [];
  const placeholder = (tex, display) => {
    math.push({ tex, display });
    return `KTX${MATH_NONCE}${math.length - 1}E`;
  };
  const prepared = text
    .split(CODE_SPANS)
    .map((part, i) => {
      if (i % 2 === 1) return part; // code: leave untouched
      return part
        .replace(BARE_BRACKET_LINE, (_, tex) => `\n${placeholder(tex, true)}\n`)
        .replace(MATH_PATTERN, (match, dollars, brackets, env, _envName, parens, inline) => {
          if (dollars !== undefined) return `\n${placeholder(dollars, true)}\n`;
          if (brackets !== undefined) return `\n${placeholder(brackets, true)}\n`;
          if (env !== undefined) return `\n${placeholder(env, true)}\n`;
          if (parens !== undefined) return placeholder(parens, false);
          return placeholder(inline, false);
        });
    })
    .join('');
  return { prepared, math };
}

// While streaming, hide a display equation that hasn't closed yet instead of flashing raw TeX
function trimOpenMath(text) {
  const outside = text.split(CODE_SPANS).filter((_, i) => i % 2 === 0).join('');
  const cuts = [];
  if ((outside.match(/\$\$/g) || []).length % 2 === 1) cuts.push(text.lastIndexOf('$$'));
  if (outside.lastIndexOf('\\[') > outside.lastIndexOf('\\]')) cuts.push(text.lastIndexOf('\\['));
  const begins = (outside.match(new RegExp(String.raw`\\begin\{(${MATH_ENVS})`, 'g')) || []).length;
  const ends = (outside.match(new RegExp(String.raw`\\end\{(${MATH_ENVS})`, 'g')) || []).length;
  if (begins > ends) cuts.push(text.lastIndexOf('\\begin{'));
  const cut = Math.min(...cuts.filter(i => i >= 0));
  return Number.isFinite(cut) ? { text: text.slice(0, cut), pending: true } : { text, pending: false };
}

function renderMarkdown(text, { streaming = false } = {}) {
  let source = text || '';
  let pending = false;
  if (streaming) ({ text: source, pending } = trimOpenMath(source));
  const { prepared, math } = extractMath(source);
  let html = DOMPurify.sanitize(marked.parse(prepared));
  if (math.length) {
    html = html.replace(MATH_TOKEN, (_, blockIndex, inlineIndex) => {
      const item = math[Number(blockIndex ?? inlineIndex)];
      return item ? typeset(item.tex, item.display) : '';
    });
  }
  if (pending) html += '<div class="math-pending"><span>∑</span> typesetting…</div>';
  return html;
}

function formatNumber(n) {
  if (n == null || Number.isNaN(Number(n))) return '–';
  n = Number(n);
  // One decimal, dropped when it's .0; switch units before rounding would show "1000.0k"
  if (n >= 999_950) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Search ranking: whole word > word prefix > anywhere, so "20b" finds "GPT OSS 20B" before "120B"
function matchScore(text, q) {
  if (!q) return 1;
  const hay = text.toLowerCase();
  const words = hay.split(/[\s/·_-]+/);
  if (words.includes(q)) return 3;
  if (words.some(w => w.startsWith(q))) return 2;
  return hay.includes(q) ? 1 : 0;
}

function rankBy(items, q, textOf) {
  return items
    .map((item, i) => ({ item, i, score: matchScore(textOf(item), q) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(r => r.item);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Some models (e.g. Qwen) put their thinking inline as <think>…</think>
function splitThinking(content) {
  const open = content.indexOf('<think>');
  if (open === -1) return { answer: content, thinking: '' };
  const close = content.indexOf('</think>', open);
  if (close === -1) return { answer: content.slice(0, open), thinking: content.slice(open + 7) };
  return {
    answer: (content.slice(0, open) + content.slice(close + 8)).trimStart(),
    thinking: content.slice(open + 7, close)
  };
}

// Web-search answers cite internal browser steps as 【3†L10-L14】; those can't be mapped to URLs
// reliably, so we drop them and list the pages the model actually read under "Sources".
function stripCitations(text) {
  return text.replace(/\s?【[^】]*】/g, '');
}

function answerText(content) {
  return stripCitations(splitThinking(content || '').answer);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function activeChat() {
  return state.chats.find(c => c.id === state.activeId) || null;
}

function currentModel() {
  return state.models.find(m => m.id === state.settings?.model) || null;
}

function replyModelIdFor(tool = null) {
  const selected = state.settings?.model;
  return tool && !supportsTools(selected) ? TOOL_MODEL : selected;
}

function replyModelFor(tool = null) {
  const id = replyModelIdFor(tool);
  return state.models.find(m => m.id === id) || null;
}

function cleanError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

let saveTimer = null;
function persistChats() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.saveChats(state.chats.map(chat => conversationHistory.forStorage(chat)));
  }, 300);
}

// Boltchat is about to quit on its own (background work finished): save now, not in 300 ms
api.onFlush(async () => {
  clearTimeout(saveTimer);
  try {
    await Promise.all([
      api.saveChats(state.chats.map(chat => conversationHistory.forStorage(chat))),
      window.saveWorkspaceNow?.() // Code workspace, from workspace.js
    ]);
  } finally {
    api.flushed();
  }
});

// ---------- Custom dropdown ----------
// One component for every picker in the app: keyboard navigable, type-to-search for long lists.

function createDropdown({ options = [], value, onChange, variant = 'field', searchable = false, placeholder = 'Select…', align = 'left' }) {
  const root = document.createElement('div');
  root.className = `dd dd-${variant}`;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dd-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const triggerLabel = document.createElement('span');
  triggerLabel.className = 'dd-trigger-label';
  const caret = document.createElement('span');
  caret.className = 'dd-caret';
  caret.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  trigger.append(triggerLabel, caret);

  const panel = document.createElement('div');
  panel.className = `dd-panel dd-align-${align}`;
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;
  const search = document.createElement('input');
  search.className = 'dd-search';
  search.placeholder = 'Search…';
  search.hidden = !searchable;
  const list = document.createElement('div');
  list.className = 'dd-list';
  panel.append(search, list);
  root.append(trigger);
  // Lives on <body> so scrolling or animated ancestors can never clip or offset it
  document.body.appendChild(panel);

  let current = value;
  let highlighted = -1;
  let visible = [];

  // Keyboard highlight skips options that don't apply right now
  function nextEnabled(from, step) {
    for (let n = 1; n <= visible.length; n++) {
      const i = (from + step * n + visible.length * n) % visible.length;
      if (!visible[i].disabled) return i;
    }
    return from;
  }

  function renderTrigger() {
    const opt = options.find(o => o.value === current);
    triggerLabel.innerHTML = '';
    if (opt?.swatch) {
      const dot = document.createElement('span');
      dot.className = 'dd-swatch';
      dot.style.background = opt.swatch;
      triggerLabel.appendChild(dot);
    }
    const text = document.createElement('span');
    text.className = 'dd-trigger-text';
    text.textContent = opt ? opt.label : placeholder;
    triggerLabel.appendChild(text);
    if (opt?.hint && variant === 'field') {
      const hint = document.createElement('span');
      hint.className = 'dd-trigger-hint';
      hint.textContent = opt.hint;
      triggerLabel.appendChild(hint);
    }
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    visible = rankBy(options, q, o => `${o.label} ${o.description || ''} ${(o.badges || []).map(b => b[0]).join(' ')}`);
    if (visible.length && (!visible[highlighted] || visible[highlighted].disabled)) highlighted = nextEnabled(-1, 1);
    list.innerHTML = '';
    if (!visible.length) {
      const none = document.createElement('div');
      none.className = 'dd-empty';
      none.textContent = 'Nothing matches';
      list.appendChild(none);
      return;
    }
    visible.forEach((o, i) => {
      const item = document.createElement('div');
      item.className = 'dd-option' + (o.value === current ? ' selected' : '') + (i === highlighted ? ' highlighted' : '') + (o.disabled ? ' disabled' : '');
      if (o.disabled) item.setAttribute('aria-disabled', 'true');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', o.value === current ? 'true' : 'false');
      const top = document.createElement('div');
      top.className = 'dd-option-top';
      if (o.swatch) {
        const dot = document.createElement('span');
        dot.className = 'dd-swatch';
        dot.style.background = o.swatch;
        top.appendChild(dot);
      }
      const label = document.createElement('span');
      label.className = 'dd-option-label';
      label.textContent = o.label;
      top.appendChild(label);
      if (o.hint) {
        const hint = document.createElement('span');
        hint.className = 'dd-option-hint';
        hint.textContent = o.hint;
        top.appendChild(hint);
      }
      const check = document.createElement('span');
      check.className = 'dd-check';
      check.textContent = o.value === current ? '✓' : '';
      top.appendChild(check);
      item.appendChild(top);
      if (o.description || o.badges?.length || o.reason) {
        const meta = document.createElement('div');
        meta.className = 'dd-option-meta';
        if (o.reason) {
          const r = document.createElement('span');
          r.className = 'dd-reason';
          r.textContent = o.reason;
          meta.appendChild(r);
        }
        if (o.description) {
          const d = document.createElement('span');
          d.textContent = o.description;
          meta.appendChild(d);
        }
        for (const [text, cls] of o.badges || []) {
          const b = document.createElement('span');
          b.className = `badge ${cls || ''}`;
          b.textContent = text;
          meta.appendChild(b);
        }
        item.appendChild(meta);
      }
      item.addEventListener('mousemove', () => {
        if (highlighted !== i) {
          highlighted = i;
          list.querySelectorAll('.dd-option').forEach((n, j) => n.classList.toggle('highlighted', j === i));
        }
      });
      item.addEventListener('click', () => {
        if (!o.disabled) choose(o.value);
      });
      list.appendChild(item);
    });
  }

  // Scroll only the list itself (scrollIntoView would also scroll the settings page behind it)
  function scrollHighlightedIntoView() {
    const item = list.querySelectorAll('.dd-option')[highlighted];
    if (!item) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
    }
  }

  // The panel is position:fixed so scrolling containers can't clip it; flip upward when needed
  function position() {
    const r = trigger.getBoundingClientRect();
    const gap = 6;
    const margin = 12;
    const width = Math.max(r.width, variant === 'header' ? Math.min(400, innerWidth - 2 * margin) : 0);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(margin, Math.min(align === 'right' ? r.right - width : r.left, innerWidth - width - margin))}px`;
    const below = innerHeight - r.bottom - gap - margin;
    const above = r.top - gap - margin;
    const wanted = panel.scrollHeight;
    const up = wanted > below && above > below;
    panel.classList.toggle('up', up);
    panel.style.maxHeight = `${Math.max(160, up ? above : below)}px`;
    panel.style.top = up ? '' : `${r.bottom + gap}px`;
    panel.style.bottom = up ? `${innerHeight - r.top + gap}px` : '';
  }

  function onViewportChange(e) {
    if (e?.target && panel.contains(e.target)) return; // scrolling inside the list
    position();
  }

  function open() {
    if (!options.length) return;
    document.querySelectorAll('.dd.open').forEach(d => d !== root && d._close?.());
    search.value = '';
    highlighted = Math.max(0, options.findIndex(o => o.value === current));
    renderList();
    panel.hidden = false;
    root.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    position();
    addEventListener('scroll', onViewportChange, true);
    addEventListener('resize', onViewportChange);
    if (searchable) search.focus();
    scrollHighlightedIntoView();
  }

  function close(refocus = false) {
    if (panel.hidden) return;
    removeEventListener('scroll', onViewportChange, true);
    removeEventListener('resize', onViewportChange);
    panel.hidden = true;
    root.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    if (refocus) trigger.focus();
  }
  root._close = close;

  function choose(v) {
    const changed = v !== current;
    current = v;
    renderTrigger();
    close(true);
    if (changed) onChange?.(v);
  }

  function onKey(e) {
    if (panel.hidden) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && e.target === trigger) {
        e.preventDefault();
        open();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      highlighted = nextEnabled(highlighted, e.key === 'ArrowDown' ? 1 : -1);
      renderList();
      scrollHighlightedIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = visible[highlighted];
      if (o && !o.disabled) choose(o.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close();
    }
  }

  trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
  root.addEventListener('keydown', onKey);
  panel.addEventListener('keydown', onKey);
  search.addEventListener('input', () => {
    highlighted = -1;
    renderList();
    position();
  });
  document.addEventListener('mousedown', e => {
    if (!root.contains(e.target) && !panel.contains(e.target)) close();
  });

  renderTrigger();
  return {
    el: root,
    setOptions(next) {
      options = next;
      renderTrigger();
      if (!panel.hidden) renderList();
    },
    setValue(v) {
      current = v;
      renderTrigger();
    },
    setPlaceholder(text) {
      placeholder = text;
      renderTrigger();
    }
  };
}

// ---------- Situational choices ----------
// Pickers only offer what will actually work for the message you're about to send.

// Rough size of the current chat in tokens (~3.5 chars per token, ~1k per image)
function chatTokenEstimate(chat = activeChat()) {
  if (!chat) return 0;
  const editing = state.editingMessage?.chatId === chat.id ? state.editingMessage : null;
  let chars = instructionMessages(chat).reduce((sum, m) => sum + m.content.length, 0);
  let images = 0;
  for (let index = 0; index < chat.messages.length; index++) {
    if (editing && index > editing.index) break;
    const message = chat.messages[index];
    chars += answerText(editing && index === editing.index ? editing.content : message.content).length;
    images += editing && index === editing.index ? editing.images.length : message.images?.length || 0;
  }
  return Math.round(chars / 3.5) + images * 1000 + pinnedTokensFor(chat);
}

// Computed once per refresh, then checked against every model
function currentSituation() {
  const chat = activeChat();
  const editing = state.editingMessage?.chatId === chat?.id ? state.editingMessage : null;
  const editedMessage = editing ? chat.messages[editing.index] : null;
  const branchHasImages = editing
    ? chat.messages.slice(0, editing.index).some(msg => msg.images?.length) || !!editing.images.length
    : !!chat?.messages.some(msg => msg.images?.length);
  return {
    attached: editing ? false : state.pending.length > 0,
    chatImages: branchHasImages,
    tool: editing ? editedMessage?.tool || null : state.forcedTool,
    tokens: chatTokenEstimate(chat) + 500 // room for the next message
  };
}

// Why a model can't handle the next message right now (or null if it can)
function modelBlocker(m, s = currentSituation()) {
  if ((s.attached || s.chatImages) && !m.vision) return s.attached ? "Can't see the attached image" : "Can't read the images in this chat";
  if (s.tool && !supportsTools(m.id)) return `No ${TOOLS[s.tool].name.toLowerCase()}`;
  if (m.contextWindow && s.tokens > m.contextWindow * 0.9) {
    return `Chat is ~${formatNumber(s.tokens)} tokens — only fits ${tokK(m.contextWindow)}`;
  }
  return null;
}

function modelOptions() {
  const situation = currentSituation();
  return state.models.map(m => {
    const reason = modelBlocker(m, situation);
    return {
      value: m.id,
      label: m.name,
      hint: m.contextWindow ? `${tokK(m.contextWindow)} ctx` : '',
      description: m.owner || '',
      disabled: !!reason,
      reason: reason || '',
      badges: [
        m.reasoning && ['Reasoning', 'accent'],
        m.vision && ['Vision', 'accent'],
        m.tools && ['Tools', '']
      ].filter(Boolean)
    };
  });
}

// The saved length is a preference; each request is capped at what the model can actually write
// Token counts read better in binary thousands: 4096 -> "4k", 65536 -> "64k"
const tokK = n => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));

function effectiveMaxTokens(modelId = state.settings?.model) {
  const cap = state.models.find(m => m.id === modelId)?.maxOutput;
  const wanted = Number(state.settings?.maxTokens) || 4096;
  return cap ? Math.min(wanted, cap) : wanted;
}

function maxTokenOptions() {
  const model = currentModel();
  const cap = model?.maxOutput;
  const opts = MAX_TOKEN_OPTIONS.map(([value, label, description]) => ({
    value,
    label,
    description,
    hint: `${tokK(value)} tokens`,
    disabled: !!cap && value > cap,
    reason: cap && value > cap ? `Over ${model.name}'s ${tokK(cap)} limit` : ''
  }));
  if (cap && !MAX_TOKEN_OPTIONS.some(([value]) => value === cap)) {
    opts.push({
      value: cap,
      label: 'Model maximum',
      description: `The most ${model.name} can write in one reply`,
      hint: `${tokK(cap)} tokens`,
      badges: [['Max', 'accent']]
    });
  }
  return opts.sort((a, b) => a.value - b.value);
}

function syncMaxTokens() {
  maxTokensPicker.setOptions(maxTokenOptions());
  maxTokensPicker.setValue(effectiveMaxTokens());
  const model = currentModel();
  const saved = Number(state.settings?.maxTokens);
  syncEffortPickers();
  el.maxTokensNote.textContent = !model?.maxOutput
    ? 'Upper limit on tokens per reply.'
    : saved > model.maxOutput
      ? `${model.name} tops out at ${tokK(model.maxOutput)} tokens, so replies are capped there. Your ${tokK(saved)} choice applies again on bigger models.`
      : `${model.name} can write up to ${tokK(model.maxOutput)} tokens per reply.`;
}

async function selectModel(id) {
  state.settings = await api.saveSettings({ model: id });
  syncModelPickers();
  updateComposerState();
  if (state.editingMessage?.chatId === state.activeId) renderThread();
  if (!el.settingsModal.hidden) {
    renderToolsSection();
    syncMaxTokens();
  }
}

const modelPicker = createDropdown({
  variant: 'header',
  searchable: true,
  placeholder: 'Loading models…',
  onChange: id => {
    selectModel(id);
    el.prompt.focus();
  }
});
el.modelPicker.appendChild(modelPicker.el);

const defaultModelPicker = createDropdown({
  searchable: true,
  placeholder: 'No models loaded',
  onChange: id => {
    selectModel(id);
    flashSaved();
  }
});
el.defaultModelSlot.appendChild(defaultModelPicker.el);

function syncModelPickers() {
  const opts = modelOptions();
  for (const picker of [modelPicker, defaultModelPicker]) {
    picker.setOptions(opts);
    picker.setValue(state.settings?.model);
  }
  syncEffortPickers();
}

// ---------- Thinking (reasoning level) ----------
// Each model that takes a level remembers its own; "Groq's default" sends nothing. The levels a
// model accepts come with the model list (src/reasoning.js), because Groq rejects the wrong ones.

const EFFORT_LABELS = {
  auto: ['Groq’s default', 'No level is sent; Groq picks.'],
  none: ['Off', 'Answers straight away, without thinking first'],
  default: ['On', 'The model thinks as it normally does'],
  low: ['Quick', 'Thinks briefly: fastest, cheapest'],
  medium: ['Balanced', 'A fair amount of thinking'],
  high: ['Deep', 'Thinks longest: best for hard problems, slowest']
};

// The top bar has no row label beside it, so its labels say what they are
function effortOptions(model, prefix = '') {
  return ['auto', ...(model?.efforts || [])].map(level => ({ value: level, label: prefix + EFFORT_LABELS[level][0], description: EFFORT_LABELS[level][1] }));
}

const currentEffort = (model = currentModel()) => state.settings?.reasoningEffort?.[model?.id] || 'auto';

async function selectEffort(level) {
  const model = currentModel();
  if (!model?.efforts?.length) return;
  // null clears the choice (the saved map drops entries a model doesn't accept)
  state.settings = await api.saveSettings({ reasoningEffort: { [model.id]: level === 'auto' ? null : level } });
  syncEffortPickers();
}

const effortPicker = createDropdown({ variant: 'header', onChange: selectEffort });
el.effortPicker.appendChild(effortPicker.el);
const effortSettingPicker = createDropdown({
  onChange: async level => {
    await selectEffort(level);
    flashSaved();
  }
});
el.effortSlot.appendChild(effortSettingPicker.el);

function syncEffortPickers() {
  const model = currentModel();
  const adjustable = !!model?.efforts?.length;
  el.effortPicker.hidden = !adjustable;
  effortPicker.setOptions(effortOptions(model, 'Thinking: '));
  effortSettingPicker.setOptions(effortOptions(model));
  for (const picker of [effortPicker, effortSettingPicker]) picker.setValue(currentEffort(model));
  // Thinking is written out of the answer budget, so deep thinking with a short limit can run dry before the answer
  const tight = adjustable && currentEffort(model) === 'high' && effectiveMaxTokens(model.id) <= 1024;
  el.effortNote.textContent = !model
    ? 'How hard the model thinks before it answers.'
    : adjustable
      ? `How hard ${model.name} thinks before it answers. Quick is fastest and cheapest; Deep is best for hard problems. Each model keeps its own choice.${tight ? ` Thinking counts toward the answer length, and Short is tight for Deep: raise Max answer length if replies cut off.` : ''}`
      : `${model.name} doesn't have an adjustable thinking level.`;
  effortSettingPicker.el.querySelector('.dd-trigger').disabled = !adjustable;
}

// ---------- Theme, accent, text size ----------

function resolvedTheme(theme) {
  return theme === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
}

function applyAppearance(s = state.settings) {
  const theme = resolvedTheme(s?.theme || 'system');
  const root = document.documentElement;
  root.dataset.theme = theme;
  const accent = ACCENTS[s?.accent] || ACCENTS.groq;
  const [base, hover] = accent[theme];
  root.style.setProperty('--accent', base);
  root.style.setProperty('--accent-hover', hover);
  root.style.setProperty('--accent-soft', `${base}${theme === 'dark' ? '24' : '1a'}`);
  root.style.setProperty('--base-size', `${(TEXT_SIZES[s?.textSize] || TEXT_SIZES.default).px}px`);
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyAppearance());

el.themeBtn.addEventListener('click', async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  state.settings = await api.saveSettings({ theme: next });
  applyAppearance();
  renderAppearanceControls();
});

// ---------- Key onboarding ----------

function showOnboarding(show) {
  el.onboarding.hidden = !show;
  el.thread.hidden = show;
  el.composerWrap.hidden = show;
  if (show) setTimeout(() => el.keyInput.focus(), 50);
}

el.keyForm.addEventListener('submit', async e => {
  e.preventDefault();
  el.keyError.hidden = true;
  el.keySave.disabled = true;
  el.keySave.textContent = 'Checking…';
  try {
    state.settings = await api.setKey(el.keyInput.value);
    el.keyInput.value = '';
    showOnboarding(false);
    await loadModels();
    toast.success('Connected to Groq — you’re all set', { effect: 'celebrate' });
    el.prompt.focus();
  } catch (err) {
    el.keyError.textContent = cleanError(err);
    el.keyError.hidden = false;
  } finally {
    el.keySave.disabled = false;
    el.keySave.textContent = 'Connect';
  }
});

document.querySelectorAll('[data-href]').forEach(btn =>
  btn.addEventListener('click', () => api.openExternal(btn.dataset.href)));

// ---------- Models ----------

async function loadModels() {
  try {
    state.models = await api.listModels();
    if (!state.models.some(m => m.id === state.settings.model) && state.models.length) {
      const fallback = state.models.find(m => m.id === 'openai/gpt-oss-120b') || state.models[0];
      state.settings = await api.saveSettings({ model: fallback.id });
    }
    syncModelPickers();
    updateComposerState();
    if (state.editingMessage?.chatId === state.activeId) renderThread();
  } catch (err) {
    modelPicker.setPlaceholder('Models unavailable');
    toast.error(cleanError(err));
  }
}

// ---------- Sidebar ----------

function renderChatList() {
  const q = el.chatSearch.value.trim().toLowerCase();
  // Chats in a project live under it in the sidebar; a search looks across all of them
  const chats = state.chats
    .filter(c => q || !projectOf(c))
    .filter(c => !q || c.title.toLowerCase().includes(q) ||
      conversationHistory.allMessages(c).some(m => (m.content || '').toLowerCase().includes(q)))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  el.chatList.innerHTML = '';
  if (!chats.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = q ? 'No matching chats' : state.chats.length ? 'Your other chats will appear here' : 'Your chats will appear here';
    el.chatList.appendChild(empty);
    renderProjects();
    return;
  }

  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const groups = [
    ['Today', c => c.updatedAt >= startOfToday],
    ['Previous 7 days', c => c.updatedAt >= startOfToday - 6 * 864e5],
    ['Older', () => true]
  ];
  const placed = new Set();
  for (const [label, test] of groups) {
    const items = chats.filter(c => !placed.has(c.id) && test(c));
    if (!items.length) continue;
    const heading = document.createElement('div');
    heading.className = 'chat-group-label';
    heading.textContent = label;
    el.chatList.appendChild(heading);
    for (const chat of items) {
      placed.add(chat.id);
      const row = document.createElement('div');
      row.className = 'chat-item' + (chat.id === state.activeId ? ' active' : '');
      row.dataset.chatId = chat.id;
      row.title = chat.title;
      const renaming = state.renamingChat?.chatId === chat.id;
      let title;
      if (renaming) {
        row.classList.add('renaming');
        row.removeAttribute('title');
        title = document.createElement('input');
        title.className = 'chat-rename-input';
        title.value = state.renamingChat.draft;
        title.maxLength = 60;
        title.setAttribute('aria-label', 'Chat name');
        title.addEventListener('click', e => e.stopPropagation());
        title.addEventListener('input', () => {
          if (state.renamingChat?.chatId === chat.id) state.renamingChat.draft = title.value;
          title.classList.remove('invalid');
          title.removeAttribute('aria-invalid');
        });
        title.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitChatRename(chat.id, { showInvalid: true });
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancelChatRename();
          }
        });
        title.addEventListener('blur', () => {
          if (state.renamingChat?.chatId === chat.id) commitChatRename(chat.id, { showInvalid: false });
        });
      } else {
        title = document.createElement('span');
        title.className = 'chat-item-title';
        title.textContent = chat.title;
        title.addEventListener('dblclick', e => {
          e.stopPropagation();
          beginChatRename(chat.id);
        });
      }

      const actions = document.createElement('span');
      actions.className = 'chat-item-actions';
      const rename = document.createElement('button');
      rename.className = 'chat-item-action chat-item-rename';
      rename.title = 'Rename chat';
      rename.setAttribute('aria-label', `Rename ${chat.title}`);
      rename.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11.8V14h2.2L12.7 6.5l-2.2-2.2L3 11.8Zm10.8-6.4a.8.8 0 0 0 0-1.1l-1.1-1.1a.8.8 0 0 0-1.1 0l-.6.6L13.2 6l.6-.6Z" fill="currentColor"/></svg>';
      rename.addEventListener('click', e => {
        e.stopPropagation();
        beginChatRename(chat.id);
      });
      const del = document.createElement('button');
      del.className = 'chat-item-action chat-item-delete';
      del.title = 'Delete chat';
      del.setAttribute('aria-label', `Delete ${chat.title}`);
      del.textContent = '✕';
      del.addEventListener('click', e => {
        e.stopPropagation();
        deleteChat(chat.id);
      });
      actions.append(moveToProjectButton(chat), rename, del);
      row.append(title, actions);
      row.draggable = !renaming;
      row.addEventListener('dragstart', e => e.dataTransfer.setData('application/x-boltchat-chat', chat.id));
      row.addEventListener('click', () => {
        if (!renaming) openChat(chat.id);
      });
      el.chatList.appendChild(row);
    }
  }
  renderProjects();
}

function beginChatRename(chatId) {
  const chat = state.chats.find(c => c.id === chatId);
  if (!chat) return;
  if (state.editingMessage) cancelMessageEdit();
  state.renamingChat = { chatId, draft: chat.title };
  renderChatList();
  requestAnimationFrame(() => {
    const input = el.chatList.querySelector('.chat-rename-input');
    input?.focus();
    input?.select();
  });
}

function commitChatRename(chatId, { showInvalid } = {}) {
  const rename = state.renamingChat;
  const chat = state.chats.find(c => c.id === chatId);
  if (!rename || rename.chatId !== chatId || !chat) return;
  const title = rename.draft.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!title) {
    if (!showInvalid) return cancelChatRename();
    const input = el.chatList.querySelector('.chat-rename-input');
    input?.classList.add('invalid');
    input?.setAttribute('aria-invalid', 'true');
    input?.focus();
    return;
  }
  chat.title = title;
  state.renamingChat = null;
  persistChats();
  renderChatList();
  const row = el.chatList.querySelector(`[data-chat-id="${chatId}"]`);
  row?.classList.add('rename-saved');
  setTimeout(() => row?.classList.remove('rename-saved'), 700);
  toast.success('Chat renamed');
}

function cancelChatRename() {
  if (!state.renamingChat) return;
  state.renamingChat = null;
  renderChatList();
}

el.chatSearch.addEventListener('input', renderChatList);

function newChat() {
  if (state.streaming) stopStreaming();
  state.editingMessage = null;
  state.renamingChat = null;
  state.activeId = null;
  state.projectView = null;
  state.newChatProjectId = null;
  state.pending = [];
  renderAttachments();
  renderThread();
  renderChatList();
  el.prompt.focus();
  loadSuggestions().catch(err => console.warn('Suggestions failed:', err));
}

function openChat(id) {
  if (state.streaming && state.streaming.chatId !== id) stopStreaming();
  if (state.activeId !== id) {
    state.editingMessage = null;
    state.renamingChat = null;
  }
  state.activeId = id;
  state.projectView = null;
  renderThread();
  renderChatList();
}

function deleteChat(id) {
  const chat = state.chats.find(c => c.id === id);
  if (!chat) return;
  if (state.streaming?.chatId === id) stopStreaming();
  if (state.editingMessage?.chatId === id) state.editingMessage = null;
  if (state.renamingChat?.chatId === id) state.renamingChat = null;
  state.chats = state.chats.filter(c => c.id !== id);
  if (state.activeId === id) state.activeId = null;
  persistChats();
  renderThread();
  renderChatList();
  toast.undo(`Deleted “${chat.title.slice(0, 40)}”`);
}

el.newChat.addEventListener('click', newChat);
el.toggleSidebar.addEventListener('click', () => el.app.classList.toggle('sidebar-hidden'));

// ---------- Thread rendering ----------

// animateFrom glides newly-created messages in. branchFrom transitions the part of the
// active path that changed when a saved conversation branch is selected.
function renderThread({ animateFrom = Infinity, branchFrom = Infinity, branchDirection = 1 } = {}) {
  const chat = activeChat();
  el.messages.innerHTML = '';
  el.empty.hidden = !!chat?.messages.length;
  if (!chat) {
    updateComposerState();
    return;
  }
  const editing = state.editingMessage?.chatId === chat.id ? state.editingMessage : null;
  chat.messages.forEach((msg, i) => {
    const streaming = state.streaming?.chatId === chat.id && state.streaming.index === i;
    const node = renderMessage(msg, i, chat, { streaming });
    if (i >= animateFrom) node.classList.add('enter');
    if (i >= branchFrom) {
      node.classList.add('history-enter');
      node.classList.add(branchDirection < 0 ? 'history-enter-back' : 'history-enter-forward');
    }
    if (editing && i > editing.index) node.classList.add('edit-downstream');
    el.messages.appendChild(node);
    if (streaming) state.streaming.node = node;
  });
  if (!editing) scrollToBottom(true);
  updateComposerState(); // pickers and hint depend on this chat's length and images
  if (editing) {
    requestAnimationFrame(() => {
      const textarea = el.messages.querySelector('.message-edit-textarea');
      if (!textarea) return;
      sizeMessageEditTextarea(textarea);
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.closest('.msg')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
}

function renderMessage(msg, index, chat, { streaming = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${msg.role}`;
  wrap.dataset.messageIndex = index;

  if (msg.role === 'user') {
    if (state.editingMessage?.chatId === chat.id && state.editingMessage.index === index) {
      renderMessageEditor(wrap, msg, index, chat);
      return wrap;
    }
    if (msg.images?.length) {
      const imgs = document.createElement('div');
      imgs.className = 'msg-images';
      for (const src of msg.images) {
        const img = document.createElement('img');
        img.src = src;
        imgs.appendChild(img);
      }
      wrap.appendChild(imgs);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (msg.tool && TOOLS[msg.tool]) {
      const tag = document.createElement('span');
      tag.className = 'bubble-tool';
      tag.textContent = `${TOOLS[msg.tool].icon} ${TOOLS[msg.tool].chip}`;
      bubble.appendChild(tag);
    }
    bubble.appendChild(document.createTextNode(msg.content));
    const actions = document.createElement('div');
    actions.className = 'user-message-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'user-message-edit';
    edit.title = 'Edit message';
    edit.setAttribute('aria-label', 'Edit message');
    edit.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11.8V14h2.2L12.7 6.5l-2.2-2.2L3 11.8Zm10.8-6.4a.8.8 0 0 0 0-1.1l-1.1-1.1a.8.8 0 0 0-1.1 0l-.6.6L13.2 6l.6-.6Z" fill="currentColor"/></svg><span>Edit</span>';
    edit.addEventListener('click', () => beginMessageEdit(chat.id, index));
    actions.appendChild(edit);
    const meta = document.createElement('div');
    meta.className = 'user-message-meta';
    const historyNav = createHistoryNavigator(chat, msg, 'edit');
    if (historyNav) meta.appendChild(historyNav);
    meta.appendChild(actions);
    wrap.append(bubble, meta);
    return wrap;
  }

  const toolLog = document.createElement('details');
  toolLog.className = 'tool-log';
  const toolSummary = document.createElement('summary');
  const toolSteps = document.createElement('div');
  toolSteps.className = 'tool-steps';
  toolLog.append(toolSummary, toolSteps);

  const sources = document.createElement('div');
  sources.className = 'sources';

  const reasoning = document.createElement('details');
  reasoning.className = 'reasoning';
  const summary = document.createElement('summary');
  const reasoningText = document.createElement('div');
  reasoningText.className = 'reasoning-text';
  reasoning.append(summary, reasoningText);

  const body = document.createElement('div');
  body.className = 'body';

  const error = document.createElement('div');
  error.className = 'msg-error';

  const foot = document.createElement('div');
  foot.className = 'msg-foot';

  // Passages from the project's files and chats that went into this reply (see projects.js)
  const projectSources = document.createElement('div');
  projectSources.className = 'sources project-sources';
  projectSources.hidden = true;

  wrap.append(toolLog, reasoning, body, sources, projectSources, error, foot);
  wrap._parts = { toolLog, toolSummary, toolSteps, sources, projectSources, reasoning, summary, reasoningText, body, error, foot };
  updateAssistantNode(wrap, msg, { index, chat, streaming });
  return wrap;
}

function createHistoryNavigator(chat, msg, kind) {
  const info = conversationHistory.versionInfo(chat, msg.nodeId);
  if (info.count < 2) return null;
  const label = kind === 'response' ? 'response' : 'message edit';
  const nav = document.createElement('div');
  nav.className = `message-history-nav message-history-${kind}`;
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', `${label} history`);

  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'message-history-arrow';
  previous.title = `Previous ${label}`;
  previous.setAttribute('aria-label', `Previous ${label}`);
  previous.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3.5-4.5 4.5 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  previous.disabled = info.index <= 0 || !!state.streaming || !!state.editingMessage;
  previous.addEventListener('click', () => selectMessageHistory(chat, msg, -1));

  const count = document.createElement('span');
  count.className = 'message-history-count';
  count.textContent = `${info.index + 1} / ${info.count}`;
  count.setAttribute('aria-live', 'polite');

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'message-history-arrow';
  next.title = `Next ${label}`;
  next.setAttribute('aria-label', `Next ${label}`);
  next.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  next.disabled = info.index >= info.count - 1 || !!state.streaming || !!state.editingMessage;
  next.addEventListener('click', () => selectMessageHistory(chat, msg, 1));

  nav.append(previous, count, next);
  return nav;
}

function selectMessageHistory(chat, msg, direction) {
  if (state.streaming) {
    toast.warn('Wait for the current response to finish before changing branches');
    return;
  }
  if (state.editingMessage) {
    toast.warn('Finish or cancel the current edit first');
    return;
  }
  const branchFrom = chat.messages.findIndex(message => message.nodeId === msg.nodeId);
  const selected = conversationHistory.selectSibling(chat, msg.nodeId, direction);
  if (!selected.changed) return;
  persistChats();
  renderThread({ branchFrom: Math.max(0, branchFrom), branchDirection: direction });
  renderChatList();
}

function renderMessageEditor(wrap, msg, index, chat) {
  const edit = state.editingMessage;
  const capability = messageEditCapability(edit);
  wrap.classList.add('editing');

  const editor = document.createElement('div');
  editor.className = `message-editor${edit.saving ? ' saving' : ''}`;

  const header = document.createElement('div');
  header.className = 'message-edit-header';
  const label = document.createElement('span');
  label.className = 'message-edit-label';
  label.innerHTML = '<span class="message-edit-spark">✦</span> Editing message';
  header.appendChild(label);
  if (msg.tool && TOOLS[msg.tool]) {
    const tool = document.createElement('span');
    tool.className = 'message-edit-tool';
    const routed = capability.model?.id !== state.settings.model ? ` · ${capability.model?.name || 'GPT OSS 120B'}` : '';
    tool.textContent = `${TOOLS[msg.tool].icon} ${TOOLS[msg.tool].chip} preserved${routed}`;
    header.appendChild(tool);
  }

  const textarea = document.createElement('textarea');
  textarea.className = 'message-edit-textarea';
  textarea.value = edit.content;
  textarea.rows = 1;
  textarea.setAttribute('aria-label', 'Edit message text');
  textarea.disabled = edit.saving;
  textarea.addEventListener('input', () => {
    if (state.editingMessage !== edit) return;
    edit.content = textarea.value;
    sizeMessageEditTextarea(textarea);
    syncMessageEditControls(editor, edit);
  });
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelMessageEdit();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      saveMessageEdit();
    }
  });

  const attachments = document.createElement('div');
  attachments.className = 'message-edit-attachments';
  edit.images.forEach((src, imageIndex) => {
    const item = document.createElement('div');
    item.className = 'message-edit-image';
    const img = document.createElement('img');
    img.src = src;
    img.alt = `Attached image ${imageIndex + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = 'Remove image';
    remove.setAttribute('aria-label', `Remove attached image ${imageIndex + 1}`);
    remove.textContent = '✕';
    remove.disabled = edit.saving;
    remove.addEventListener('click', () => {
      if (state.editingMessage !== edit || edit.saving) return;
      edit.images.splice(imageIndex, 1);
      renderThread();
    });
    item.append(img, remove);
    attachments.appendChild(item);
  });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => addImagesToMessageEdit(fileInput.files));

  if (capability.model?.vision && edit.images.length < 5) {
    const addImage = document.createElement('button');
    addImage.type = 'button';
    addImage.className = 'message-edit-add-image';
    addImage.disabled = edit.saving;
    addImage.innerHTML = '<span>＋</span> Add image';
    addImage.addEventListener('click', () => fileInput.click());
    attachments.appendChild(addImage);
  }
  attachments.appendChild(fileInput);

  const meta = document.createElement('div');
  meta.className = 'message-edit-meta';
  const status = document.createElement('span');
  status.className = 'message-edit-status';
  status.setAttribute('role', 'status');
  const count = document.createElement('span');
  count.className = 'message-edit-count';
  meta.append(status, count);

  const actions = document.createElement('div');
  actions.className = 'message-edit-actions';
  const hint = document.createElement('span');
  hint.className = 'message-edit-shortcut';
  hint.innerHTML = '<kbd>Ctrl</kbd><kbd>Enter</kbd> to regenerate';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'message-edit-cancel';
  cancel.textContent = 'Cancel';
  cancel.disabled = edit.saving;
  cancel.addEventListener('click', cancelMessageEdit);
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'message-edit-save';
  save.innerHTML = '<span>↻</span> Save & regenerate';
  save.addEventListener('click', saveMessageEdit);
  actions.append(hint, cancel, save);

  editor.append(header, textarea, attachments, meta, actions);
  wrap.appendChild(editor);
  syncMessageEditControls(editor, edit);
}

function sizeMessageEditTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 260)}px`;
}

function messageEditCapability(edit = state.editingMessage) {
  const chat = state.chats.find(c => c.id === edit?.chatId);
  const message = chat?.messages[edit?.index];
  const model = replyModelFor(message?.tool || null);
  return {
    model,
    blocker: model ? modelBlocker(model, currentSituation()) : 'Reply model is still loading'
  };
}

function syncMessageEditControls(editor, edit) {
  if (!editor) return;
  const hasContent = !!edit.content.trim() || !!edit.images.length;
  const capability = messageEditCapability(edit);
  const blocked = !!capability.blocker;
  const save = editor.querySelector('.message-edit-save');
  const status = editor.querySelector('.message-edit-status');
  const count = editor.querySelector('.message-edit-count');
  save.disabled = edit.waitingForStop || edit.saving || !hasContent || blocked;
  save.innerHTML = edit.saving
    ? '<span class="mini-spinner"></span> Regenerating…'
    : edit.waitingForStop
      ? '<span class="mini-spinner"></span> Stopping response…'
      : '<span>↻</span> Save & regenerate';
  status.className = `message-edit-status${blocked || !hasContent ? ' warning' : ''}`;
  if (edit.waitingForStop) {
    status.textContent = 'Parking the current response safely…';
  } else if (blocked) {
    status.textContent = `${capability.model?.name || 'Selected model'}: ${capability.blocker}.`;
  } else if (!hasContent) {
    status.textContent = capability.model.vision ? 'Add text or at least one image.' : 'Add text to continue.';
  } else {
    status.textContent = capability.model.vision
      ? `${capability.model.name} · ${edit.images.length}/5 images`
      : `${capability.model.name} · Text only`;
  }
  count.textContent = `${edit.content.length.toLocaleString()} characters`;
}

function beginMessageEdit(chatId, index) {
  const chat = state.chats.find(c => c.id === chatId);
  const msg = chat?.messages[index];
  if (!chat || msg?.role !== 'user') return;
  if (state.editingMessage?.chatId === chatId && state.editingMessage.index === index) return;
  state.renamingChat = null;
  const stream = state.streaming?.chatId === chatId ? state.streaming : null;
  state.editingMessage = {
    chatId,
    index,
    content: msg.content || '',
    images: [...(msg.images || [])],
    waitingForStop: !!stream,
    parkedIndex: stream?.index ?? null,
    saving: false
  };
  if (stream) stopStreaming();
  renderChatList();
  renderThread();
}

function cancelMessageEdit() {
  const edit = state.editingMessage;
  if (!edit || edit.saving) return;
  state.editingMessage = null;
  renderThread();
}

async function saveMessageEdit() {
  const edit = state.editingMessage;
  if (!edit || edit.waitingForStop || edit.saving || state.streaming) return;
  const chat = state.chats.find(c => c.id === edit.chatId);
  const msg = chat?.messages[edit.index];
  if (!chat || msg?.role !== 'user') return;
  const content = edit.content.trim();
  if (!content && !edit.images.length) return;
  if (messageEditCapability(edit).blocker) return;

  edit.saving = true;
  const editor = el.messages.querySelector('.message-editor');
  editor?.classList.add('saving');
  syncMessageEditControls(editor, edit);
  [...el.messages.children].forEach(node => {
    if (Number(node.dataset.messageIndex) > edit.index) node.classList.add('branch-exit');
  });
  await motionDelay(240);
  if (state.editingMessage !== edit) return;

  const replacement = {
    role: 'user',
    content,
    images: edit.images.length ? [...edit.images] : undefined,
    tool: msg.tool || undefined,
    editedAt: Date.now(),
    editedFrom: msg.nodeId,
    justSent: true
  };
  conversationHistory.append(chat, replacement, msg.parentId, uid);
  chat.updatedAt = Date.now();
  state.editingMessage = null;
  persistChats();
  startAssistantReply(chat);
}

async function addImagesToMessageEdit(fileList) {
  const edit = state.editingMessage;
  if (!edit || edit.saving) return;
  const files = [...fileList].slice(0, Math.max(0, 5 - edit.images.length));
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (file.size > 3.5 * 1024 * 1024) {
      toast.error(`${file.name} is too big (Groq allows about 4 MB per image)`);
      continue;
    }
    try {
      const src = await readFileAsDataUrl(file);
      if (state.editingMessage !== edit || edit.images.length >= 5) return;
      edit.images.push(src);
    } catch {
      toast.error(`Couldn't read ${file.name}`);
    }
  }
  if (state.editingMessage === edit) renderThread();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function motionDelay(ms) {
  return matchMedia('(prefers-reduced-motion: reduce)').matches
    ? Promise.resolve()
    : new Promise(resolve => setTimeout(resolve, ms));
}

function describeStep(step) {
  if (step.kind === 'search') return ['🔎', `Searched “${step.label || '…'}”`];
  if (step.kind === 'open') return ['📄', step.label ? `Read ${hostOf(step.label)}` : 'Opened a result'];
  if (step.kind === 'find') return ['🔍', `Looked for “${step.label || '…'}” on the page`];
  if (step.kind === 'memory') {
    if (step.action === 'save') return ['✦', `Remembered “${step.label}”`];
    if (step.action === 'delete') return ['✦', step.failed ? 'Tried to forget a memory that doesn’t exist' : `Forgot “${step.label}”`];
    if (step.action === 'search') {
      const found = `${step.count} memor${step.count === 1 ? 'y' : 'ies'}`;
      return ['✦', step.label ? `Searched memory for “${step.label}” · ${found}` : `Read memory · ${found}`];
    }
    return ['✦', 'Used memory'];
  }
  return ['🐍', step.done ? 'Ran Python' : 'Running Python…'];
}

function renderToolLog(parts, msg, streaming) {
  const { toolLog, toolSummary, toolSteps, sources } = parts;
  const steps = msg.tools || [];
  toolLog.hidden = !steps.length && !msg.toolSkipped;
  toolLog.classList.toggle('skipped', !steps.length && !!msg.toolSkipped);
  sources.hidden = true;
  if (!steps.length) {
    if (msg.toolSkipped && TOOLS[msg.toolSkipped]) {
      const t = TOOLS[msg.toolSkipped];
      toolSummary.textContent = `${t.icon} Answered without ${t.name.toLowerCase()} — the model didn't think it was needed`;
      toolSteps.innerHTML = '';
      toolSteps.dataset.signature = '';
    }
    return;
  }

  const searches = steps.filter(s => s.kind === 'search').length;
  const pages = steps.filter(s => s.kind === 'open' && !s.failed).length;
  const runs = steps.filter(s => s.kind === 'code').length;
  const memorySteps = steps.filter(s => s.kind === 'memory');
  const running = steps.find(s => !s.done);
  toolLog.classList.toggle('live', streaming && !!running);
  if (streaming && running) {
    toolSummary.textContent = describeStep(running).join(' ');
  } else if (memorySteps.length === steps.length) {
    // Memory-only replies: one step reads fine as the summary itself
    toolSummary.textContent = steps.length === 1 ? describeStep(steps[0]).join(' ') : `✦ Used memory · ${steps.length} actions`;
  } else {
    const bits = [];
    if (searches) bits.push(`${searches} search${searches > 1 ? 'es' : ''}`);
    if (pages) bits.push(`${pages} page${pages > 1 ? 's' : ''} read`);
    if (runs) bits.push(`${runs} Python run${runs > 1 ? 's' : ''}`);
    if (memorySteps.length) bits.push('memory');
    toolSummary.textContent = `${searches || pages ? '🌐 Used the web' : '🐍 Used the code runner'} · ${bits.join(', ')}`;
  }

  // Rebuilding the list only when a step starts/finishes keeps <details> state stable while streaming
  const signature = steps.map(s => `${s.index}:${s.done}`).join('|');
  if (toolSteps.dataset.signature !== signature) {
    toolSteps.dataset.signature = signature;
    toolSteps.innerHTML = '';
    for (const step of steps) {
      const row = document.createElement('div');
      row.className = `tool-step${step.done ? '' : ' pending'}${step.failed ? ' failed' : ''}`;
      const [icon, text] = describeStep(step);
      const line = document.createElement('div');
      line.className = 'tool-step-line';
      line.innerHTML = `<span class="tool-step-icon">${icon}</span>`;
      const label = document.createElement('span');
      label.textContent = text;
      line.appendChild(label);
      row.appendChild(line);
      if (step.kind === 'code' && step.code) {
        const pre = document.createElement('pre');
        pre.className = 'tool-code';
        pre.textContent = step.code;
        row.appendChild(pre);
        if (step.output) {
          const out = document.createElement('pre');
          out.className = 'tool-output';
          out.textContent = step.output;
          row.appendChild(out);
        }
      }
      toolSteps.appendChild(row);
    }
  }

  if (streaming) return;
  const opened = steps.filter(s => s.kind === 'open' && !s.failed).flatMap(s => s.urls || []);
  const found = steps.filter(s => s.kind === 'search').flatMap(s => s.urls || []);
  const urls = [...new Set(opened.length ? opened : found)].slice(0, 8);
  sources.hidden = !urls.length;
  sources.innerHTML = '';
  if (!urls.length) return;
  const label = document.createElement('span');
  label.className = 'sources-label';
  label.textContent = 'Sources';
  sources.appendChild(label);
  for (const url of urls) {
    const chip = document.createElement('button');
    chip.className = 'source-chip';
    chip.title = url;
    chip.textContent = hostOf(url);
    chip.addEventListener('click', () => api.openExternal(url));
    sources.appendChild(chip);
  }
}

function updateAssistantNode(node, msg, { index, chat, streaming }) {
  const { reasoning, summary, reasoningText, body, error, foot } = node._parts;
  renderToolLog(node._parts, msg, streaming);
  renderProjectSources(node._parts.projectSources, msg, streaming);
  const { answer: rawAnswer, thinking } = splitThinking(msg.content || '');
  const answer = stripCitations(rawAnswer);
  const allThinking = (msg.reasoning || '') + thinking;

  reasoning.hidden = !allThinking;
  if (allThinking) {
    summary.textContent = streaming && !answer ? 'Thinking…' : 'Reasoning';
    reasoningText.textContent = allThinking;
  }

  body.innerHTML = renderMarkdown(answer, { streaming });
  body.classList.toggle('cursor', streaming);
  if (!streaming) {
    decorateCodeBlocks(body);
    fitWideMath(body);
  }

  error.hidden = !msg.error;
  error.textContent = msg.error || '';

  foot.innerHTML = '';
  const editing = state.editingMessage;
  if (editing?.chatId === chat?.id && editing.parkedIndex === index) {
    const parked = document.createElement('span');
    parked.className = `parked-response-status${editing.waitingForStop ? ' stopping' : ''}`;
    parked.innerHTML = editing.waitingForStop
      ? '<span class="mini-spinner"></span> Stopping for edit…'
      : '<span>✓</span> Stopped for editing';
    foot.appendChild(parked);
    node.classList.add('parked-for-edit');
  }
  if (streaming) return;

  if (msg.stats) {
    const s = msg.stats;
    const stats = document.createElement('span');
    stats.className = 'stats';
    const genSeconds = s.completionTime || (s.totalMs - (s.firstTokenMs || 0)) / 1000;
    const speed = s.completionTokens && genSeconds > 0 ? Math.round(s.completionTokens / genSeconds) : null;
    const parts = [];
    if (speed) parts.push(`<span class="speed">⚡ ${speed} tok/s</span>`);
    if (s.completionTokens) parts.push(`${s.completionTokens} tokens`);
    // Tool answers also pay for every page/output the model read, which dwarfs the reply itself
    if (msg.tools?.length && s.promptTokens) parts.push(`${formatNumber(s.promptTokens + (s.completionTokens || 0))} total incl. tool results`);
    if (s.totalMs) parts.push(`${(s.totalMs / 1000).toFixed(2)}s`);
    if (msg.stopped) parts.push(msg.interrupted ? 'interrupted in voice chat' : 'stopped');
    if (msg.truncated) parts.push('hit max tokens');
    const modelName = state.models.find(m => m.id === msg.model)?.name || msg.model;
    if (modelName) parts.push(modelName);
    stats.innerHTML = parts.map(p => (p.startsWith('<') ? p : escapeHtml(p))).join(' · ');
    foot.appendChild(stats);
  }

  const historyNav = chat ? createHistoryNavigator(chat, msg, 'response') : null;
  if (historyNav) foot.appendChild(historyNav);

  if (answer) {
    foot.appendChild(actionButton('Copy', () => {
      navigator.clipboard.writeText(answer);
      toast.success('Copied', 1600);
    }));
  }
  const isLast = chat && index === chat.messages.length - 1;
  if (isLast) foot.appendChild(actionButton('↻ Regenerate', () => regenerate()));
  if (answer && chat) {
    const report = actionButton(msg.reported ? '⚑ Reported' : '⚑ Report', () => openReportPanel(node, msg, chat, index));
    report.classList.add('report-action');
    if (msg.reported) report.classList.add('done');
    report.title = 'Report a harmful, offensive or wrong response';
    foot.appendChild(report);
  }
}

// ---------- Reporting AI responses ----------
// Store policy asks AI apps to let people report problematic output. A report opens a
// pre-filled email to the developer; nothing leaves the PC unless the user sends it.
const REPORT_EMAIL = 'harshit.garg@harshit-garg.com';
const REPORT_REASONS = ['Harmful or unsafe', 'Offensive or hateful', 'Wrong or misleading', 'Something else'];

function openReportPanel(node, msg, chat, index) {
  node.querySelector('.report-panel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'report-panel';
  panel.innerHTML = '<strong>What’s wrong with this response?</strong><div class="chips"></div><p class="report-note">This opens your email app with the details filled in — nothing is sent until you press Send.</p>';
  const chips = panel.querySelector('.chips');
  for (const reason of REPORT_REASONS) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = reason;
    chip.addEventListener('click', async () => {
      const prompt = [...chat.messages.slice(0, index)].reverse().find(m => m.role === 'user')?.content || '';
      const info = await api.appInfo();
      const body = [
        `Reason: ${reason}`,
        `Model: ${msg.model}`,
        `App: Boltchat ${info.version}`,
        `Time: ${new Date().toISOString()}`,
        '',
        'Prompt:',
        prompt.slice(0, 400),
        '',
        'Response:',
        answerText(msg.content).slice(0, 900),
        '',
        'Anything else you want to add:'
      ].join('\n');
      api.openExternal(`mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(`Boltchat report: ${reason}`)}&body=${encodeURIComponent(body)}`);
      msg.reported = reason;
      persistChats();
      panel.remove();
      updateAssistantNode(node, msg, { index, chat, streaming: false });
      toast('Thanks — finish the report in your email app');
    });
    chips.appendChild(chip);
  }
  const cancel = document.createElement('button');
  cancel.className = 'chip ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => panel.remove());
  chips.appendChild(cancel);
  node.appendChild(panel);
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Wide derivations (one big aligned block) shrink to fit the card, down to 70%; beyond that they scroll
function fitWideMath(container) {
  requestAnimationFrame(() => {
    for (const scroller of container.querySelectorAll('.math-scroll')) {
      const katexEl = scroller.querySelector('.katex');
      if (!katexEl) continue;
      katexEl.style.fontSize = '';
      const overflow = scroller.scrollWidth / scroller.clientWidth;
      if (overflow > 1.01) katexEl.style.fontSize = `${Math.max(0.7, 1 / overflow) * 1.28}em`;
    }
  });
}
addEventListener('resize', () => fitWideMath(el.messages));

// One listener for every equation's "TeX" button (bodies are re-rendered while streaming)
el.messages.addEventListener('click', e => {
  const btn = e.target.closest('.math-copy');
  if (!btn) return;
  navigator.clipboard.writeText(btn.closest('.math-block').dataset.tex);
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'TeX'; }, 1200);
});

function actionButton(label, onClick) {
  const b = document.createElement('button');
  b.className = 'msg-action';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function decorateCodeBlocks(container) {
  container.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    const lang = [...(code?.classList || [])].find(c => c.startsWith('language-'))?.slice(9);
    if (lang) {
      const tag = document.createElement('span');
      tag.className = 'code-lang';
      tag.textContent = lang;
      pre.classList.add('has-lang');
      pre.appendChild(tag);
    }
    const btn = document.createElement('button');
    btn.className = 'copy-code';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(code ? code.innerText : pre.innerText);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });
    pre.appendChild(btn);
  });
}

function nearBottom() {
  const t = el.thread;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || nearBottom()) {
    el.thread.style.scrollBehavior = 'auto';
    el.thread.scrollTop = el.thread.scrollHeight;
    el.thread.style.scrollBehavior = '';
  }
}

// ---------- Sending ----------

function updateComposerState() {
  syncModelPickers();
  const streaming = !!state.streaming;
  const editing = state.editingMessage?.chatId === state.activeId;
  el.prompt.disabled = editing;
  el.composer.classList.toggle('locked-for-edit', editing);
  el.sendBtn.classList.toggle('stop', streaming);
  el.sendBtn.textContent = streaming ? '■' : '↑';
  el.sendBtn.title = streaming ? 'Stop (Esc)' : 'Send (Enter)';
  el.sendBtn.disabled = editing || (!streaming && !el.prompt.value.trim() && !state.pending.length);

  const model = currentModel();
  const vision = !!model?.vision;
  el.attachBtn.disabled = editing || !vision;
  el.attachBtn.title = editing ? 'Finish editing the message above' : vision ? 'Attach image' : 'Pick a Vision model to attach images';
  if (editing) {
    el.hint.textContent = state.editingMessage.waitingForStop
      ? 'Stopping the current response before regenerating…'
      : 'Finish or cancel the message edit above to keep chatting.';
    return;
  }
  if (state.pending.length && !vision) {
    el.hint.textContent = `${model?.name || 'This model'} can't see images — switch to a Vision model.`;
  } else if (state.forcedTool && !supportsTools(model?.id)) {
    el.hint.textContent = `${TOOLS[state.forcedTool].name} needs GPT-OSS — this message will use GPT OSS 120B.`;
  } else if (state.forcedTool) {
    el.hint.textContent = `${TOOLS[state.forcedTool].icon} ${model?.name || 'The model'} will use ${TOOLS[state.forcedTool].name.toLowerCase()} for this message · Backspace to cancel`;
  } else if (model && modelBlocker(model)) {
    el.hint.textContent = `⚠ ${model.name}: ${modelBlocker(model)} — pick another model from the top bar.`;
  } else {
    el.hint.textContent = model?.contextWindow
      ? `${model.name} · ${tokK(model.contextWindow)} context window`
      : '';
  }
}

function autoGrow() {
  el.prompt.style.height = 'auto';
  el.prompt.style.height = `${Math.min(el.prompt.scrollHeight, 240)}px`;
}

el.prompt.addEventListener('input', () => {
  autoGrow();
  updateSlashMenu();
  updateComposerState();
});

el.prompt.addEventListener('keydown', e => {
  if (!el.slashMenu.hidden && handleSlashKey(e)) return;
  if (e.key === 'Backspace' && state.forcedTool && el.prompt.selectionStart === 0 && el.prompt.selectionEnd === 0) {
    e.preventDefault();
    setForcedTool(null);
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    el.composer.requestSubmit();
  }
});

el.composer.addEventListener('submit', e => {
  e.preventDefault();
  if (state.streaming) return stopStreaming();
  let text = el.prompt.value.trim();
  if (runSlashCommand(text)) return;
  // "/web question" typed and sent in one go
  const inline = /^\/(web|code)\s+([\s\S]+)$/.exec(text);
  if (inline) {
    setForcedTool(inline[1]);
    text = inline[2].trim();
  }
  if (!text && !state.pending.length) return;
  if (state.pending.length && !currentModel()?.vision) {
    return toast.warn('Switch to a Vision model to send images');
  }
  sendMessage(text, state.pending, state.forcedTool);
  el.prompt.value = '';
  state.pending = [];
  setForcedTool(null);
  renderAttachments();
  autoGrow();
});

// ---------- Slash commands ----------

function setForcedTool(id) {
  state.forcedTool = id && TOOLS[id] ? id : null;
  el.modeChip.hidden = !state.forcedTool;
  el.modeChip.innerHTML = '';
  if (state.forcedTool) {
    const t = TOOLS[state.forcedTool];
    const label = document.createElement('span');
    label.textContent = `${t.icon} ${t.chip}`;
    const x = document.createElement('button');
    x.type = 'button';
    x.title = 'Cancel';
    x.textContent = '✕';
    x.addEventListener('click', () => {
      setForcedTool(null);
      el.prompt.focus();
    });
    el.modeChip.append(label, x);
  }
  updateComposerState();
}

function slashItems(value) {
  const model = /^\/model(?:\s+(.*))?$/i.exec(value);
  if (model && /\s/.test(value)) {
    const q = (model[1] || '').toLowerCase();
    const situation = currentSituation();
    return rankBy(state.models, q, m => `${m.name} ${m.id}`)
      .map(m => {
        const reason = modelBlocker(m, situation);
        return {
          type: 'model',
          id: m.id,
          icon: m.id === state.settings.model ? '✓' : '◆',
          title: m.name,
          disabled: !!reason,
          detail: reason || [m.owner, m.contextWindow && `${tokK(m.contextWindow)} ctx`, supportsTools(m.id) && 'tools'].filter(Boolean).join(' · ')
        };
      });
  }
  const cmd = /^\/(\w*)$/.exec(value);
  if (!cmd) return null;
  const q = cmd[1].toLowerCase();
  return SLASH_COMMANDS
    .filter(c => c.cmd.startsWith(q))
    .map(c => ({ type: 'command', id: c.cmd, icon: c.icon, title: `/${c.cmd}`, args: c.args, detail: c.description }));
}

function updateSlashMenu() {
  const value = el.prompt.value;
  // "/web " or "/code " followed by a space turns into the mode chip
  const mode = /^\/(web|code)\s([\s\S]*)$/i.exec(value);
  if (mode) {
    setForcedTool(mode[1].toLowerCase());
    el.prompt.value = mode[2];
    autoGrow();
  }
  const items = mode ? null : slashItems(el.prompt.value);
  if (!items) {
    el.slashMenu.hidden = true;
    return;
  }
  state.slash.items = items;
  state.slash.highlighted = Math.min(state.slash.highlighted, Math.max(0, items.length - 1));
  if (items[state.slash.highlighted]?.disabled) state.slash.highlighted = nextUsableSlash(-1, 1);
  renderSlashMenu();
}

function renderSlashMenu() {
  const { items, highlighted } = state.slash;
  el.slashMenu.innerHTML = '';
  el.slashMenu.hidden = false;
  if (!items.length) {
    const none = document.createElement('div');
    none.className = 'dd-empty';
    none.textContent = 'No matching commands';
    el.slashMenu.appendChild(none);
    return;
  }
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = `slash-item${i === highlighted ? ' highlighted' : ''}${item.disabled ? ' disabled' : ''}`;
    row.setAttribute('role', 'option');
    row.innerHTML = `<span class="slash-icon"></span><span class="slash-title"></span><span class="slash-args"></span><span class="slash-detail"></span>`;
    row.querySelector('.slash-icon').textContent = item.icon;
    row.querySelector('.slash-title').textContent = item.title;
    row.querySelector('.slash-args').textContent = item.args || '';
    row.querySelector('.slash-detail').textContent = item.detail || '';
    row.addEventListener('mousedown', e => {
      e.preventDefault(); // keep focus in the textarea
      chooseSlashItem(item);
    });
    row.addEventListener('mousemove', () => {
      if (state.slash.highlighted !== i) {
        state.slash.highlighted = i;
        renderSlashMenu();
      }
    });
    el.slashMenu.appendChild(row);
  });
  el.slashMenu.querySelector('.highlighted')?.scrollIntoView({ block: 'nearest' });
}

function handleSlashKey(e) {
  const { items } = state.slash;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return true;
    state.slash.highlighted = nextUsableSlash(state.slash.highlighted, e.key === 'ArrowDown' ? 1 : -1);
    renderSlashMenu();
    return true;
  }
  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    const item = items[state.slash.highlighted];
    if (!item) return false;
    e.preventDefault();
    if (!item.disabled) chooseSlashItem(item);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    el.slashMenu.hidden = true;
    return true;
  }
  return false;
}

function nextUsableSlash(from, step) {
  const { items } = state.slash;
  for (let n = 1; n <= items.length; n++) {
    const i = (from + step * n + items.length * n) % items.length;
    if (!items[i].disabled) return i;
  }
  return Math.max(0, from);
}

function chooseSlashItem(item) {
  if (item.disabled) {
    toast.warn(`${item.title}: ${item.detail}`);
    return;
  }
  el.slashMenu.hidden = true;
  state.slash.highlighted = 0;
  if (item.type === 'model') {
    selectModel(item.id);
    el.prompt.value = '';
    toast(`Switched to ${state.models.find(m => m.id === item.id)?.name || item.id}`);
  } else if (item.id === 'web' || item.id === 'code') {
    el.prompt.value = '';
    setForcedTool(item.id);
  } else if (item.id === 'model') {
    el.prompt.value = '/model ';
    updateSlashMenu();
  } else if (item.id === 'system') {
    el.prompt.value = '/system ';
    el.hint.textContent = 'Type the new system prompt and press Enter · leave it empty to open Settings';
  } else if (item.id === 'remember') {
    el.prompt.value = '/remember ';
    el.hint.textContent = 'Type what Boltchat should remember and press Enter · leave it empty to see your memories';
  } else if (item.id === 'new') {
    el.prompt.value = '';
    newChat();
  }
  autoGrow();
  updateComposerState();
  el.prompt.focus();
}

// Commands that act immediately instead of sending a message
function runSlashCommand(text) {
  const system = /^\/system(?:\s+([\s\S]*))?$/i.exec(text);
  if (system) {
    const prompt = (system[1] || '').trim();
    el.prompt.value = '';
    autoGrow();
    if (!prompt) {
      openSettings('behavior');
    } else {
      api.saveSettings({ systemPrompt: prompt }).then(s => {
        state.settings = s;
        toast.success('System prompt updated for all chats');
      });
    }
    return true;
  }
  const remember = /^\/remember(?:\s+([\s\S]*))?$/i.exec(text);
  if (remember) {
    const fact = (remember[1] || '').trim();
    el.prompt.value = '';
    autoGrow();
    if (!fact) {
      openSettings('memory');
    } else {
      api.addMemory(fact).then(() => {
        if (state.settings.memory?.enabled) toast.memory('Remembered', { effect: 'shimmer' });
        else toast.memory('Saved — turn on Memory to use it', { action: { label: 'Settings', run: () => openSettings('memory') } });
      }, err => toast.error(cleanError(err)));
    }
    return true;
  }
  if (/^\/new$/i.test(text)) {
    el.prompt.value = '';
    newChat();
    return true;
  }
  if (/^\/model(\s.*)?$/i.test(text)) {
    toast.warn('Pick a model from the list');
    return true;
  }
  return false;
}

// ---------- Start-screen suggestions ----------
// Always SUGGESTION_SLOTS buttons. main.js fills them from memory, then the news, then fun ideas;
// these built-in ones cover whatever it couldn't (first run, offline, no key, feature off).

const SUGGESTION_SLOTS = 4;
const BUILTIN_SUGGESTIONS = [
  'Explain how Groq\'s LPU makes inference fast',
  'Write a Python script that renames photos by date',
  'Give me a 3-day study plan for learning SQL',
  'Compare REST and GraphQL in a table'
].map(text => ({ kind: 'builtin', text }));

const SUGGESTION_KINDS = {
  memory: { icon: '✦', title: 'Based on what Boltchat remembers about you' },
  news: { icon: '📰', title: 'From today\'s headlines — answered with web search' },
  fun: { icon: '✨', title: 'An idea from the model' },
  builtin: { icon: '→', title: '' }
};

function renderSuggestions(items = []) {
  const seen = new Set();
  const slots = [...items, ...BUILTIN_SUGGESTIONS]
    .filter(s => s?.text && !seen.has(s.text.toLowerCase()) && seen.add(s.text.toLowerCase()))
    .slice(0, SUGGESTION_SLOTS);
  el.suggestions.innerHTML = '';
  for (const s of slots) {
    const kind = SUGGESTION_KINDS[s.kind] || SUGGESTION_KINDS.builtin;
    const button = document.createElement('button');
    button.dataset.kind = s.kind;
    button.title = s.kind === 'news' && s.outlets?.length
      ? `Reported today by ${s.outlets.join(', ')} — answered with web search`
      : kind.title;
    button.innerHTML = '<span class="suggestion-ico" aria-hidden="true"></span><span class="suggestion-text"></span>';
    button.querySelector('.suggestion-ico').textContent = kind.icon;
    button.querySelector('.suggestion-text').textContent = s.text;
    el.suggestions.appendChild(button);
  }
}

// Show what's cached right away, then swap in fresh ideas if main decides they're due
async function loadSuggestions() {
  renderSuggestions((await api.getSuggestions())?.items);
  const fresh = await api.refreshSuggestions();
  if (fresh?.items && state.settings.suggestions !== false) renderSuggestions(fresh.items);
}

el.suggestions.addEventListener('click', e => {
  const button = e.target.closest('button');
  if (!button) return;
  el.prompt.value = button.querySelector('.suggestion-text').textContent;
  // Headlines are newer than any model's training data
  if (button.dataset.kind === 'news') setForcedTool('web');
  autoGrow();
  el.composer.requestSubmit();
});

function sendMessage(text, images, tool = null) {
  let chat = activeChat();
  if (!chat) {
    chat = {
      id: uid(),
      title: (text || 'Image').replace(/\s+/g, ' ').slice(0, 60),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    if (state.newChatProjectId && state.projects.some(p => p.id === state.newChatProjectId)) chat.projectId = state.newChatProjectId;
    state.newChatProjectId = null;
    state.chats.push(chat);
    state.activeId = chat.id;
  }
  conversationHistory.append(chat, {
    role: 'user',
    content: text,
    images: images.length ? [...images] : undefined,
    tool: tool || undefined,
    justSent: true
  }, undefined, uid);
  startAssistantReply(chat);
}

function regenerate() {
  const chat = activeChat();
  if (!chat || state.streaming) return;
  const last = chat.messages.at(-1);
  if (!last) return;
  const replyToNodeId = last.role === 'assistant' ? last.parentId : last.nodeId;
  const replyTo = conversationHistory.node(chat, replyToNodeId);
  if (replyTo?.role !== 'user') return;
  startAssistantReply(chat, { replyToNodeId });
}

// The general system prompt, then the project's instructions layered on top (see project-context.js)
function instructionMessages(chat) {
  return ProjectContext.instructionMessages({ globalPrompt: state.settings?.systemPrompt, project: projectOf(chat) });
}

function buildApiMessages(chat, throughIndex = chat.messages.length - 1) {
  const out = instructionMessages(chat);
  for (const m of chat.messages.slice(0, throughIndex + 1)) {
    if (m.role === 'assistant') {
      if (m.error && !m.content) continue;
      // A reply cut off by voice chat: the model only gets the part that was actually spoken
      const text = typeof m.spokenChars === 'number'
        ? `${answerText((m.content || '').slice(0, m.spokenChars)).trim()} [interrupted by user]`.trim()
        : answerText(m.content);
      if (!text.trim()) continue; // stopped before saying anything
      out.push({ role: 'assistant', content: text });
    } else if (m.images?.length) {
      out.push({
        role: 'user',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.images.map(url => ({ type: 'image_url', image_url: { url } }))
        ]
      });
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

function startAssistantReply(chat, { replyToNodeId = null } = {}) {
  conversationHistory.rebuild(chat);
  const activePath = [...chat.messages];
  const replyTo = replyToNodeId
    ? conversationHistory.node(chat, replyToNodeId)
    : activePath.at(-1);
  const replyToIndex = activePath.findIndex(message => message.nodeId === replyTo?.nodeId);
  if (replyTo?.role !== 'user' || replyToIndex < 0) return;
  // A /web or /code message must run on a GPT-OSS model, even if another model is selected
  const forceTool = replyTo.tool || null;
  // In a voice call a fast model answers, the tools only run when asked for, and the reply is written
  // to be heard (see voice-chat-ui.js)
  const voice = state.voiceCall && window.VoiceUI ? window.VoiceUI : null;
  const model = voice ? voice.modelFor(forceTool) : replyModelIdFor(forceTool);
  const enabledTools = voice ? [] : Object.entries(state.settings.tools || {}).filter(([, on]) => on).map(([id]) => id);
  const apiMessages = buildApiMessages(chat, replyToIndex);
  if (voice) {
    const at = apiMessages.findIndex(m => m.role !== 'system');
    apiMessages.splice(at < 0 ? apiMessages.length : at, 0, { role: 'system', content: voice.systemNote() });
  }
  const msg = conversationHistory.append(
    chat,
    { role: 'assistant', content: '', reasoning: '', model },
    replyTo.nodeId,
    uid
  );
  chat.updatedAt = Date.now();
  persistChats();
  // A fresh send animates the user's message and the reply; a regenerate only the reply
  const lastUser = chat.messages.findIndex(message => message.nodeId === replyTo.nodeId);
  renderThread({ animateFrom: chat.messages[lastUser]?.justSent ? lastUser : chat.messages.length - 1 });
  if (chat.messages[lastUser]) delete chat.messages[lastUser].justSent;
  renderChatList();

  const node = el.messages.lastElementChild;
  const requestId = uid();
  state.streaming = { requestId, chatId: chat.id, msg, node, index: chat.messages.length - 1 };
  updateComposerState();
  updateAssistantNode(node, msg, { index: state.streaming.index, chat, streaming: true });
  scrollToBottom(true);

  api.send({
    requestId,
    model,
    messages: apiMessages,
    temperature: voice ? 0.7 : Number(state.settings.temperature),
    maxTokens: voice ? Math.min(400, effectiveMaxTokens(model)) : effectiveMaxTokens(model),
    tools: enabledTools,
    forceTool,
    // The project (if any) whose files and memory this reply may use; main does the searching
    projectId: projectOf(chat)?.id || null,
    chatId: chat.id,
    ignoreEffort: !!voice
  });
}

function stopStreaming() {
  if (state.streaming) api.stop(state.streaming.requestId);
}

let frame = null;
function scheduleStreamRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const s = state.streaming;
    if (!s || state.activeId !== s.chatId) return;
    const chat = state.chats.find(c => c.id === s.chatId);
    updateAssistantNode(s.node, s.msg, { index: s.index, chat, streaming: true });
    scrollToBottom();
  });
}

api.onDelta(({ requestId, content, reasoning }) => {
  const s = state.streaming;
  if (!s || s.requestId !== requestId) return;
  s.msg.content += content || '';
  s.msg.reasoning += reasoning || '';
  scheduleStreamRender();
  window.VoiceUI?.onDelta(requestId, s.msg);
});

api.onTool(({ requestId, step }) => {
  const s = state.streaming;
  if (!s || s.requestId !== requestId) return;
  s.msg.tools ||= [];
  const existing = s.msg.tools.find(t => t.index === step.index);
  if (existing) Object.assign(existing, step);
  else s.msg.tools.push(step);
  scheduleStreamRender();
  window.VoiceUI?.onTool(requestId);
});

api.onMeta(({ requestId, rateLimits, sources, pinnedFiles, knowledgeNote }) => {
  const s = state.streaming;
  if (s?.requestId !== requestId) return;
  if (rateLimits) renderLimits(rateLimits, s.msg.model);
  // What the project contributed to this reply, kept with the message
  if (sources?.length) s.msg.projectSources = sources;
  if (pinnedFiles?.length) s.msg.pinnedFiles = pinnedFiles;
  if (knowledgeNote) s.msg.knowledgeNote = knowledgeNote;
  if (sources || pinnedFiles || knowledgeNote) scheduleStreamRender();
});

function finishStreaming(requestId, apply) {
  const s = state.streaming;
  if (!s || s.requestId !== requestId) return;
  apply(s.msg);
  if (!s.msg.reasoning) delete s.msg.reasoning;
  state.streaming = null;
  const chat = state.chats.find(c => c.id === s.chatId);
  const editing = state.editingMessage?.chatId === s.chatId ? state.editingMessage : null;
  if (editing?.parkedIndex === s.index) editing.waitingForStop = false;
  if (chat) chat.updatedAt = Date.now();
  persistChats();
  updateComposerState();
  if (state.activeId === s.chatId && chat) {
    if (editing) {
      renderThread();
      return;
    }
    const scrolledDown = nearBottom();
    updateAssistantNode(s.node, s.msg, { index: s.index, chat, streaming: false });
    if (scrolledDown) scrollToBottom(true);
  }
}

api.onDone(({ requestId, finishReason, stats }) => {
  finishStreaming(requestId, msg => {
    msg.stats = stats;
    if (finishReason === 'stopped') msg.stopped = true;
    if (finishReason === 'length') msg.truncated = true;
    // /web or /code was asked for, but the model judged the tool unnecessary (e.g. "hi")
    const s = state.streaming;
    const asked = state.chats.find(c => c.id === s.chatId)?.messages[s.index - 1]?.tool;
    if (asked && !msg.tools?.some(t => t.kind !== 'memory') && !msg.stopped) msg.toolSkipped = asked;
    if (!msg.stopped && state.settings.chime !== false && !state.voiceCall) playChime();
  });
  window.VoiceUI?.onDone(requestId, finishReason);
});

api.onError(({ requestId, message }) => {
  finishStreaming(requestId, msg => { msg.error = message; });
  window.VoiceUI?.onError(requestId, message);
});

// ---------- Rate limits ----------

// What Groq reported with the last reply (main.js rateLimitsFrom): requests per DAY and tokens per
// MINUTE, for that model, across the whole Groq organization. It's a snapshot, so the panel says
// how old it is and when each window resets, and never guesses the plan.
const LIMITS_URL = 'https://console.groq.com/settings/limits';

function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return 'under a second';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
const resetText = (at, window = 'day') => {
  if (at == null) return '';
  const left = at - Date.now();
  if (left > 0) return `resets in ${formatDuration(left)}`;
  return window === 'minute' ? 'refilled since this reading' : 'reset since this reading';
};
const ageText = at => {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : `${formatDuration(s * 1000)} ago`;
};

function renderLimits(r, modelId) {
  if (!r || r.requestsLimit == null) return;
  const modelName = state.models.find(m => m.id === modelId)?.name || modelId || 'this model';
  state.lastLimits = { ...r, at: r.at || Date.now(), modelName };
  paintLimits();
}

function paintLimits() {
  const l = state.lastLimits;
  if (!l) return;
  el.limits.hidden = false;
  el.limitRequests.textContent = `${formatNumber(l.requestsRemaining)} / ${formatNumber(l.requestsLimit)}`;
  el.limitTokens.textContent = `${formatNumber(l.tokensRemaining)} / ${formatNumber(l.tokensLimit)}`;
  setMeter(el.meterRequests, l.requestsRemaining / l.requestsLimit);
  setMeter(el.meterTokens, l.tokensRemaining / l.tokensLimit);
  const daily = resetText(l.requestsResetAt);
  const minute = resetText(l.tokensResetAt, 'minute');
  $('limit-requests-row').title = `Requests you can still make today with ${l.modelName}${daily ? ` — the daily count ${daily}` : ''}.`;
  $('limit-tokens-row').title = `Tokens (sent + received) you could still use this minute with ${l.modelName}, as of the last reply${minute ? ` — ${minute}` : ''}.`;
  el.limitNote.textContent = `${l.modelName} · as of ${ageText(l.at)}`;
  el.limitNote.title = `Your Groq rate limits for ${l.modelName}, as reported with the last reply. They apply to your whole Groq organization. Click to see your exact limits at console.groq.com.`;
}

el.limitNote.addEventListener('click', () => api.openExternal(LIMITS_URL));
setInterval(() => {
  if (state.lastLimits && !document.hidden) paintLimits();
}, 15000);

function setMeter(node, ratio) {
  const pct = Math.max(0, Math.min(1, ratio || 0)) * 100;
  node.style.width = `${pct}%`;
  node.style.background = pct < 10 ? 'var(--danger)' : pct < 30 ? '#eab308' : 'var(--ok)';
}

// ---------- Images ----------

el.attachBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  addImages([...el.fileInput.files]);
  el.fileInput.value = '';
});

document.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    addImages(files);
  }
});

el.thread.addEventListener('dragover', e => e.preventDefault());
el.thread.addEventListener('drop', e => {
  e.preventDefault();
  addImages([...e.dataTransfer.files].filter(f => f.type.startsWith('image/')));
});

function addImages(files) {
  if (!files.length) return;
  if (!currentModel()?.vision) {
    toast.warn('Pick a model with the Vision badge to use images');
    return;
  }
  for (const file of files.slice(0, 5 - state.pending.length)) {
    if (file.size > 3.5 * 1024 * 1024) {
      toast.error(`${file.name} is too big (Groq allows about 4 MB per image)`);
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.pending.push(reader.result);
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
}

function renderAttachments() {
  el.attachments.innerHTML = '';
  el.attachments.hidden = !state.pending.length;
  state.pending.forEach((src, i) => {
    const item = document.createElement('div');
    item.className = 'attachment';
    const img = document.createElement('img');
    img.src = src;
    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.title = 'Remove';
    remove.addEventListener('click', () => {
      state.pending.splice(i, 1);
      renderAttachments();
    });
    item.append(img, remove);
    el.attachments.appendChild(item);
  });
  updateComposerState();
}

// ---------- Voice input (Whisper) ----------

el.micBtn.addEventListener('click', async () => {
  if (state.recorder) {
    state.recorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast.error('Microphone access was blocked');
    return;
  }
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = e => chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    state.recorder = null;
    el.micBtn.classList.remove('recording');
    el.micBtn.title = 'Voice input (Whisper)';
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    if (blob.size < 2000) return;
    el.hint.textContent = 'Transcribing…';
    try {
      const text = await api.transcribe(new Uint8Array(await blob.arrayBuffer()), blob.type);
      if (text) {
        el.prompt.value = el.prompt.value ? `${el.prompt.value.trimEnd()} ${text}` : text;
        autoGrow();
        el.prompt.focus();
      } else {
        toast.warn("Didn't catch that — try again");
      }
    } catch (err) {
      toast.error(cleanError(err));
    } finally {
      updateComposerState();
    }
  };
  recorder.start();
  state.recorder = recorder;
  el.micBtn.classList.add('recording');
  el.micBtn.title = 'Stop recording';
  el.hint.textContent = 'Listening… click the mic again to finish';
});

// ---------- Settings ----------
// Every control saves on change; the header shows a brief "Saved" confirmation.

let savedTimer = null;
function flashSaved() {
  el.settingsSaved.textContent = 'Saved ✓';
  el.settingsSaved.classList.add('flash');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    el.settingsSaved.textContent = 'All changes saved';
    el.settingsSaved.classList.remove('flash');
  }, 1400);
}

async function saveSetting(updates) {
  state.settings = await api.saveSettings(updates);
  applyAppearance();
  flashSaved();
}

const maxTokensPicker = createDropdown({
  onChange: async v => {
    await saveSetting({ maxTokens: v });
    syncMaxTokens();
  }
});
el.maxTokensSlot.appendChild(maxTokensPicker.el);

const textSizePicker = createDropdown({
  options: Object.entries(TEXT_SIZES).map(([value, t]) => ({ value, label: t.label, description: t.description, hint: `${t.px}px` })),
  onChange: v => saveSetting({ textSize: v })
});
el.textSizeSlot.appendChild(textSizePicker.el);

const voiceModelPicker = createDropdown({
  options: [
    { value: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', hint: 'Fastest', description: 'Near-identical accuracy, quickest results (recommended)' },
    { value: 'whisper-large-v3', label: 'Whisper Large v3', hint: 'Most accurate', description: 'Best for accents, background noise and technical words' }
  ],
  onChange: v => saveSetting({ voiceModel: v })
});
el.voiceModelSlot.appendChild(voiceModelPicker.el);

// Accent swatches
for (const [key, accent] of Object.entries(ACCENTS)) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.dataset.accent = key;
  b.title = accent.label;
  b.style.setProperty('--swatch', accent.dark[0]);
  b.addEventListener('click', async () => {
    await saveSetting({ accent: key });
    renderAppearanceControls();
  });
  el.accentSwatches.appendChild(b);
}

// Theme cards
el.themeCards.querySelectorAll('button').forEach(card => {
  card.addEventListener('click', async () => {
    await saveSetting({ theme: card.dataset.themeChoice });
    renderAppearanceControls();
  });
});

// Prompt templates
for (const [name, text] of PROMPT_TEMPLATES) {
  const chip = document.createElement('button');
  chip.className = 'chip';
  chip.textContent = name;
  chip.addEventListener('click', () => {
    el.systemPrompt.value = text;
    el.systemPrompt.dispatchEvent(new Event('input'));
    el.systemPrompt.focus();
  });
  el.promptTemplates.appendChild(chip);
}
const clearChip = document.createElement('button');
clearChip.className = 'chip ghost';
clearChip.textContent = 'Clear';
clearChip.addEventListener('click', () => {
  el.systemPrompt.value = '';
  el.systemPrompt.dispatchEvent(new Event('input'));
});
el.promptTemplates.appendChild(clearChip);

let promptTimer = null;
// ---------- Chime ----------
// Synthesized with Web Audio (no sound file): two soft bell notes, a fifth apart, with a gentle shimmer.
let audioCtx = null;
function playChime() {
  try {
    audioCtx ||= new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const master = audioCtx.createGain();
    master.gain.value = 0.22;
    master.connect(audioCtx.destination);
    [[880, 0], [1318.5, 0.11]].forEach(([freq, delay]) => {
      for (const [mult, level] of [[1, 1], [2.01, 0.18], [3.0, 0.06]]) { // fundamental + bell-like partials
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq * mult;
        gain.gain.setValueAtTime(0, now + delay);
        gain.gain.linearRampToValueAtTime(level, now + delay + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + (mult === 1 ? 1.1 : 0.45));
        osc.connect(gain).connect(master);
        osc.start(now + delay);
        osc.stop(now + delay + 1.2);
      }
    });
  } catch (err) {
    console.warn('Chime failed:', err);
  }
}

function renderChimeSwitch() {
  const on = state.settings.chime !== false;
  el.chimeSwitch.setAttribute('aria-checked', String(on));
}

el.chimeSwitch.addEventListener('click', async () => {
  await saveSetting({ chime: state.settings.chime === false });
  renderChimeSwitch();
  if (state.settings.chime) playChime();
});
el.chimePreview.addEventListener('click', playChime);

function renderSuggestionsSwitch() {
  el.suggestionsSwitch.setAttribute('aria-checked', String(state.settings.suggestions !== false));
}

el.suggestionsSwitch.addEventListener('click', async () => {
  await saveSetting({ suggestions: state.settings.suggestions === false });
  renderSuggestionsSwitch();
  if (state.settings.suggestions === false) renderSuggestions();
  else loadSuggestions().catch(err => console.warn('Suggestions failed:', err));
});

el.systemPrompt.addEventListener('input', () => {
  updatePromptCount();
  clearTimeout(promptTimer);
  promptTimer = setTimeout(() => saveSetting({ systemPrompt: el.systemPrompt.value }), 500);
});

function updatePromptCount() {
  const n = el.systemPrompt.value.length;
  el.promptCount.textContent = n ? `${n} characters` : 'Empty — using model defaults';
}

// Temperature
function renderTemperature(t) {
  el.temperature.value = t;
  el.temperatureValue.textContent = Number(t).toFixed(2);
  el.temperature.style.setProperty('--fill', `${(t / 2) * 100}%`);
  el.tempPresets.querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', Math.abs(Number(b.dataset.temp) - t) < 0.001));
}

let tempTimer = null;
el.temperature.addEventListener('input', () => {
  const t = Number(el.temperature.value);
  renderTemperature(t);
  clearTimeout(tempTimer);
  tempTimer = setTimeout(() => saveSetting({ temperature: t }), 250);
});
el.tempPresets.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  const t = Number(b.dataset.temp);
  renderTemperature(t);
  saveSetting({ temperature: t });
}));

function renderAppearanceControls() {
  const s = state.settings;
  el.themeCards.querySelectorAll('button').forEach(c => c.classList.toggle('active', c.dataset.themeChoice === (s.theme || 'system')));
  el.accentSwatches.querySelectorAll('.swatch').forEach(b => b.classList.toggle('active', b.dataset.accent === (s.accent || 'groq')));
  textSizePicker.setValue(s.textSize || 'default');
}

function renderToolsSection() {
  voiceModelPicker.setValue(state.settings.voiceModel || 'whisper-large-v3-turbo');
  const enabled = state.settings.tools || {};
  el.toolCards.innerHTML = '';
  for (const [id, tool] of Object.entries(TOOLS)) {
    const card = document.createElement('div');
    card.className = `tool-card${enabled[id] ? ' on' : ''}`;
    card.innerHTML = `
      <div class="tool-icon"></div>
      <div class="tool-info">
        <div class="tool-title"><strong></strong><kbd></kbd></div>
        <p class="tool-desc"></p>
        <p class="tool-caution"></p>
      </div>
      <button class="switch" role="switch"><span></span></button>`;
    card.querySelector('.tool-icon').textContent = tool.icon;
    card.querySelector('.tool-title strong').textContent = tool.name;
    card.querySelector('.tool-title kbd').textContent = `/${id}`;
    card.querySelector('.tool-desc').textContent = tool.description;
    card.querySelector('.tool-caution').textContent = tool.caution;
    const sw = card.querySelector('.switch');
    sw.setAttribute('aria-checked', String(!!enabled[id]));
    sw.setAttribute('aria-label', `${tool.name} ${enabled[id] ? 'on' : 'off'}`);
    sw.addEventListener('click', async () => {
      await saveSetting({ tools: { ...state.settings.tools, [id]: !enabled[id] } });
      renderToolsSection();
    });
    el.toolCards.appendChild(card);
  }

  const model = currentModel();
  const ok = supportsTools(model?.id);
  el.toolNote.className = `tool-note ${ok ? 'ok' : 'warn'}`;
  el.toolNote.textContent = ok
    ? `✓ ${model.name} can use these tools. When a tool is on, the model decides when it's needed; /web and /code force it for one message.`
    : `Tools only run on GPT OSS 120B and 20B. You're on ${model?.name || 'another model'}, so tools stay idle — except /web and /code, which switch that one message to GPT OSS 120B.`;

  el.slashList.innerHTML = '';
  for (const c of SLASH_COMMANDS) {
    const row = document.createElement('div');
    row.innerHTML = '<span><kbd></kbd><span class="slash-args"></span></span><span class="slash-detail"></span>';
    row.querySelector('kbd').textContent = `/${c.cmd}`;
    row.querySelector('.slash-args').textContent = c.args;
    row.querySelector('.slash-detail').textContent = c.description;
    el.slashList.appendChild(row);
  }
}

// ---------- Memory ----------
// The list lives in main (memory.json); it pushes the new list on every change, including
// saves the model makes mid-reply and facts learned in the background.

const MEMORY_SOURCES = { user: 'added by you', chat: 'asked in chat', learned: 'learned' };

async function saveMemorySetting(changes) {
  await saveSetting({ memory: { ...state.settings.memory, ...changes } });
  renderMemorySection();
}

function renderMemorySection() {
  const memory = state.settings.memory || {};
  el.memorySwitch.setAttribute('aria-checked', String(!!memory.enabled));
  el.memoryLearnSwitch.setAttribute('aria-checked', String(!!memory.enabled && !!memory.learn));
  el.memoryLearnSwitch.disabled = !memory.enabled;

  const model = currentModel();
  el.memoryNote.hidden = !memory.enabled;
  el.memoryNote.className = `tool-note ${model?.tools ? 'ok' : 'warn'}`;
  el.memoryNote.textContent = model?.tools
    ? `✓ ${model.name} can save, look up and forget memories when you ask it to.`
    : `${model?.name || 'This model'} can't call tools, so it reads your memories but can't change them from chat. Use /remember or the list below.`;

  const list = state.memories || [];
  el.memoryCount.textContent = list.length ? `${list.length} saved` : 'Nothing yet';
  el.memoryClear.hidden = !list.length;
  el.memoryList.innerHTML = '';
  for (const m of [...list].reverse()) {
    const row = document.createElement('div');
    row.innerHTML = '<span class="memory-text"></span><span class="memory-source"></span><button class="icon-btn" title="Forget">✕</button>';
    row.querySelector('.memory-text').textContent = m.text;
    row.querySelector('.memory-source').textContent = MEMORY_SOURCES[m.source] || '';
    row.querySelector('button').addEventListener('click', () => api.deleteMemory(m.id));
    el.memoryList.appendChild(row);
  }
}

// ---------- Settings → Startup & background ----------

const $s = id => document.getElementById(id);
const setSwitch = (node, on, disabled = false) => {
  node.setAttribute('aria-checked', String(!!on));
  node.disabled = disabled;
};

function renderStartupSection() {
  const s = state.settings.startup || {};
  const login = state.settings.loginItem || { mode: 'dev' };
  const note = $s('startup-login-note');
  const winSettings = $s('startup-windows-settings');
  winSettings.hidden = true;
  if (login.mode === 'store') {
    // The Store version's StartupTask is switched in Windows, not by the app
    setSwitch($s('startup-login-switch'), false, true);
    $s('startup-login-switch').hidden = true;
    winSettings.hidden = false;
    note.textContent = 'In the Microsoft Store version, Windows controls this: switch on Boltchat under Settings → Apps → Startup.';
  } else if (login.mode === 'dev') {
    setSwitch($s('startup-login-switch'), false, true);
    note.textContent = 'Available in the installed app.';
  } else if (login.blocked) {
    setSwitch($s('startup-login-switch'), true, true);
    winSettings.hidden = false;
    note.textContent = 'Turned off in Windows’ Startup apps list. Switch Boltchat back on there.';
  } else {
    $s('startup-login-switch').hidden = false;
    setSwitch($s('startup-login-switch'), s.openAtLogin);
    note.textContent = 'Boltchat starts with Windows, so it’s ready the moment you need it.';
  }
  // Only the installer version can tell a sign-in launch apart from you opening it
  const quietAvailable = login.mode === 'app' && s.openAtLogin && !login.blocked;
  setSwitch($s('startup-quiet-switch'), s.startQuietly !== false, !quietAvailable);
  $s('startup-quiet-row').classList.toggle('muted', !quietAvailable);
  $s('startup-quiet-note').textContent = login.mode === 'store'
    ? 'Not available in the Store version — Windows opens it normally at sign-in.'
    : 'When it opens at sign-in, it waits minimized (or in the notification area) instead of popping up.';

  const close = s.closeAction === 'tray' ? 'tray' : 'quit';
  $s('startup-close').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.close === close));
  $s('startup-close-note').textContent = close === 'tray'
    ? 'Closing hides Boltchat to the notification area. Click its icon to come back; right-click it to quit.'
    : 'Closing quits Boltchat. Running work stops, unless you choose to let it finish when asked below.';
  setSwitch($s('startup-confirm-switch'), s.confirmQuit !== false);
  setSwitch($s('startup-notify-switch'), s.notify !== false);
}

const saveStartup = async patch => {
  await saveSetting({ startup: { ...state.settings.startup, ...patch } });
  renderStartupSection();
};
$s('startup-login-switch').addEventListener('click', async () => {
  const on = !state.settings.startup?.openAtLogin;
  await saveStartup({ openAtLogin: on });
  toast.success(on ? 'Boltchat will open when you sign in' : 'Boltchat won’t open at sign-in');
});
$s('startup-quiet-switch').addEventListener('click', () => saveStartup({ startQuietly: state.settings.startup?.startQuietly === false }));
$s('startup-confirm-switch').addEventListener('click', () => saveStartup({ confirmQuit: state.settings.startup?.confirmQuit === false }));
$s('startup-notify-switch').addEventListener('click', () => saveStartup({ notify: state.settings.startup?.notify === false }));
$s('startup-close').addEventListener('click', e => {
  const b = e.target.closest('button[data-close]');
  if (b) saveStartup({ closeAction: b.dataset.close });
});
$s('startup-windows-settings').addEventListener('click', () => api.openStartupSettings());
$s('startup-notify-test').addEventListener('click', () => api.testNotification().catch(err => toast.error(cleanError(err))));

// Tray menu and notification clicks: go where the work is
api.onNavigate(({ mode, command }) => {
  if (command === 'settings') return openSettings('startup');
  if (command === 'new-chat') {
    window.setWorkspaceMode?.('chat'); // from workspace.js
    return newChat();
  }
  if (mode) window.setWorkspaceMode?.(mode); // from workspace.js
});

el.memorySwitch.addEventListener('click', () => saveMemorySetting({ enabled: !state.settings.memory?.enabled }));
el.memoryLearnSwitch.addEventListener('click', () => saveMemorySetting({ learn: !state.settings.memory?.learn }));

el.memoryForm.addEventListener('submit', async e => {
  e.preventDefault();
  const text = el.memoryInput.value.trim();
  if (!text) return;
  try {
    await api.addMemory(text);
    el.memoryInput.value = '';
    flashSaved();
  } catch (err) {
    toast.error(cleanError(err));
  }
});

// Two clicks, so a stray one can't wipe everything
el.memoryClear.addEventListener('click', async () => {
  if (el.memoryClear.dataset.confirm) {
    delete el.memoryClear.dataset.confirm;
    el.memoryClear.textContent = 'Forget everything';
    await api.clearMemories();
    toast.memory('Memory cleared');
    return;
  }
  el.memoryClear.dataset.confirm = '1';
  el.memoryClear.textContent = 'Click again to forget everything';
  setTimeout(() => {
    delete el.memoryClear.dataset.confirm;
    el.memoryClear.textContent = 'Forget everything';
  }, 4000);
});

api.onMemoryChanged(list => {
  state.memories = list;
  if (!el.settingsModal.hidden) renderMemorySection();
});

api.onMemoryLearned(({ added, projectId }) => {
  const project = projectId && projectById(projectId);
  const where = project ? ` in “${project.name}”` : '';
  if (added.length) toast.memory(`Remembered${where}: ${added.map(m => m.text).join(' · ')}`, { effect: 'shimmer' });
});

function renderKeySection() {
  const s = state.settings;
  el.keyDot.className = `status-dot ${s.hasKey ? 'ok' : 'off'}`;
  el.keyStatus.textContent = s.hasKey ? 'Connected to Groq' : 'Not connected';
  el.keyMeta.innerHTML = '';
  if (s.hasKey) {
    const code = document.createElement('code');
    code.textContent = s.keyHint;
    const source = document.createElement('span');
    source.textContent = s.keySource === 'env' ? 'Loaded from .env' : 'Saved in this browser only';
    el.keyMeta.append(code, source);
  }
  el.removeKey.hidden = s.keySource !== 'saved';
  el.testKey.disabled = !s.hasKey;
  el.testResult.hidden = true;

  const l = state.lastLimits;
  el.usageCard.hidden = !l;
  if (l) {
    el.usageModel.textContent = `${l.modelName} · as of ${ageText(l.at)}`;
    el.usageReq.textContent = `${formatNumber(l.requestsRemaining)}`;
    el.usageTok.textContent = `${formatNumber(l.tokensRemaining)}`;
    el.usageReq.dataset.of = `/ ${formatNumber(l.requestsLimit)}`;
    el.usageTok.dataset.of = `/ ${formatNumber(l.tokensLimit)}`;
    $('usage-req-reset').textContent = resetText(l.requestsResetAt);
    $('usage-tok-reset').textContent = resetText(l.tokensResetAt, 'minute');
  }
}

function showSection(name) {
  el.settingsTabs.forEach(t => t.classList.toggle('active', t.dataset.section === name));
  el.settingsSections.forEach(sec => sec.classList.toggle('active', sec.dataset.section === name));
}

el.settingsTabs.forEach(tab => tab.addEventListener('click', () => showSection(tab.dataset.section)));

let settingsCloseTimer = null;

function finishSettingsClose() {
  if (!el.settingsModal.classList.contains('closing')) return;
  el.settingsModal.hidden = true;
  el.settingsModal.classList.remove('closing');
  if (settingsCloseTimer !== null) {
    clearTimeout(settingsCloseTimer);
    settingsCloseTimer = null;
  }
}

async function openSettings(section) {
  if (settingsCloseTimer !== null) {
    clearTimeout(settingsCloseTimer);
    settingsCloseTimer = null;
  }
  el.settingsModal.classList.remove('closing');
  const s = state.settings;
  syncModelPickers();
  renderTemperature(Number(s.temperature));
  syncMaxTokens();
  el.systemPrompt.value = s.systemPrompt || '';
  updatePromptCount();
  renderChimeSwitch();
  renderSuggestionsSwitch();
  renderAppearanceControls();
  renderToolsSection();
  if (typeof renderVoiceChatSettings === 'function') renderVoiceChatSettings(); // from voice-chat-ui.js
  state.memories = await api.listMemories();
  renderMemorySection();
  if (typeof renderCodeSettings === 'function') await renderCodeSettings(); // from workspace.js
  state.settings = await api.getSettings(); // startup status may have changed in Windows meanwhile
  renderStartupSection();
  renderKeySection();
  if (section) showSection(section);
  const info = await api.appInfo();
  el.aboutVersion.textContent = `Version ${info.version} · Web`;
  el.settingsModal.hidden = false;
}

function closeSettings() {
  if (el.settingsModal.hidden || el.settingsModal.classList.contains('closing')) return;
  document.querySelectorAll('.dd.open').forEach(d => d._close?.());
  el.settingsModal.classList.add('closing');
  settingsCloseTimer = setTimeout(finishSettingsClose, 360);
}

el.openSettings.addEventListener('click', () => openSettings());
el.closeSettings.addEventListener('click', closeSettings);
el.settingsModal.addEventListener('mousedown', e => {
  if (e.target === el.settingsModal) closeSettings();
});
el.settingsModal.addEventListener('animationend', e => {
  if (e.target === el.settingsModal && e.animationName === 'settings-backdrop-out') {
    finishSettingsClose();
  }
});

el.testKey.addEventListener('click', async () => {
  el.testKey.disabled = true;
  el.testKey.textContent = 'Testing…';
  el.testResult.hidden = true;
  try {
    const { ms, modelCount } = await api.testKey();
    el.testResult.className = 'test-result ok';
    el.testResult.textContent = `✓ Key works — Groq answered in ${ms} ms with ${modelCount} chat models available.`;
  } catch (err) {
    el.testResult.className = 'test-result bad';
    el.testResult.textContent = `✕ ${cleanError(err)}`;
  } finally {
    el.testResult.hidden = false;
    el.testKey.disabled = false;
    el.testKey.textContent = 'Test connection';
  }
});

el.changeKey.addEventListener('click', () => {
  closeSettings();
  showOnboarding(true);
});

el.removeKey.addEventListener('click', async () => {
  state.settings = await api.clearKey();
  if (state.settings.hasKey) {
    // Falls back to the .env key
    renderKeySection();
    toast('Saved key removed — using the key from .env');
    return;
  }
  state.models = [];
  syncModelPickers();
  closeSettings();
  showOnboarding(true);
});

el.openData.addEventListener('click', () => api.openDataFolder());

// ---------- Keyboard shortcuts ----------

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.querySelector('.dd.open')) return; // the dropdown closes itself
    if (!el.settingsModal.hidden) return closeSettings();
    if (state.streaming) return stopStreaming();
  }
  // Ctrl+N means "new chat" only in chat mode; the Code workspace has its own shortcuts
  if (e.ctrlKey && e.key.toLowerCase() === 'n' && !el.app.classList.contains('mode-code')) {
    e.preventDefault();
    newChat();
  }
  if (e.ctrlKey && e.key === ',') {
    e.preventDefault();
    openSettings();
  }
});

// ---------- Start ----------

(async function init() {
  state.settings = await api.getSettings();
  applyAppearance();
  state.projects = await api.projects.list();
  for (const project of state.projects) loadPinnedTokens(project.id);
  const loadedChats = await api.loadChats();
  let migratedHistory = false;
  state.chats = (Array.isArray(loadedChats) ? loadedChats : []).map(chat => {
    const normalized = conversationHistory.normalize(chat, uid);
    migratedHistory ||= normalized.migrated;
    return normalized.chat;
  });
  // A reply that was mid-stream when the app closed can't resume
  for (const chat of state.chats) {
    for (const m of chat.messages) {
      if (m.role === 'assistant' && !m.content && !m.error && !m.stats) m.error = 'Interrupted';
    }
  }
  if (migratedHistory) {
    await api.saveChats(state.chats.map(chat => conversationHistory.forStorage(chat)));
  }
  renderChatList();
  renderThread();
  updateComposerState();
  loadSuggestions().catch(err => console.warn('Suggestions failed:', err));

  if (!state.settings.hasKey) {
    modelPicker.setPlaceholder('Groq');
    showOnboarding(true);
    return;
  }
  showOnboarding(false);
  await loadModels();
  el.prompt.focus();
})();
