// A very small module registry, so the chat's engine can be plain script files with no build step.
// Each file wraps itself:   Boltchat.define('retrieval', function (require, module, exports) { … });
// and asks for others by name:   const { search } = require('./retrieval');
// Names are matched by their last part, so './ingest/chunker', 'chunker' and 'node:path' → 'path'
// all work. A module runs the first time something requires it. Used by the page and by the
// file-indexing worker (engine/ingest-worker.js).
(scope => {
  const factories = new Map();
  const loaded = new Map();
  const key = name => String(name).replace(/^node:/, '').replace(/\.js$/, '').split('/').pop();

  function require(name) {
    const id = key(name);
    if (loaded.has(id)) return loaded.get(id).exports;
    const factory = factories.get(id);
    if (!factory) throw new Error(`Module "${name}" is not loaded. Is its <script> on the page?`);
    const module = { exports: {} };
    loaded.set(id, module); // set first, so two modules that need each other don't loop
    factory(require, module, module.exports);
    return module.exports;
  }

  scope.Boltchat = {
    define(name, factory) { factories.set(key(name), factory); },
    require
  };
})(self);
