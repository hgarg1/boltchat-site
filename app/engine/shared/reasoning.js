// Which reasoning levels each Groq model accepts, and which one a request should send.
// Groq rejects a level the model doesn't take with a 400, and the sets differ even between
// neighbours (checked live: GPT-OSS takes low/medium/high, Qwen 3.6 only none/default, Qwen 3.8
// all of them), so the sets are listed per model. Unknown models get no control and no parameter.
// The Android app keeps the same table in ModelRules.kt (ReasoningRules).
// Shared with the Windows app, where this file is src/reasoning.js.
Boltchat.define('reasoning', function (require, module, exports) {
  const LEVELS = {
    'openai/gpt-oss-120b': ['low', 'medium', 'high'],
    'openai/gpt-oss-20b': ['low', 'medium', 'high'],
    'openai/gpt-oss-safeguard-20b': ['low', 'medium', 'high'],
    'qwen/qwen3.6-27b': ['none', 'default'],
    'qwen/qwen3.8-27b': ['none', 'low', 'medium', 'high']
  };

  const levelsFor = model => LEVELS[model] || [];

  // The level to send for this model, or undefined to leave it to Groq. `saved` is the per-model map
  // from settings; a value the model doesn't take (stale settings, a different model) is ignored.
  function effortFor(model, saved) {
    const level = saved && typeof saved === 'object' ? saved[model] : null;
    return levelsFor(model).includes(level) ? level : undefined;
  }

  // Keeps only entries a model really accepts
  function clean(saved) {
    const out = {};
    if (saved && typeof saved === 'object') {
      for (const [model, level] of Object.entries(saved)) if (levelsFor(model).includes(level)) out[model] = level;
    }
    return out;
  }

  // Groq's 400 for a level it doesn't take names the parameter in both wordings seen so far
  const isEffortError = text => /reasoning_effort/i.test(String(text || ''));

  module.exports = { LEVELS, levelsFor, effortFor, clean, isEffortError };
});
