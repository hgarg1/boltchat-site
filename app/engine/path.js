// The part of Node's `path` the engine uses, for the forward-slash paths of the in-memory file tree (engine/fs.js)
Boltchat.define('path', function (require, module, exports) {
  const sep = '/';

  function normalize(p) {
    const absolute = String(p).startsWith('/');
    const parts = [];
    for (const part of String(p).replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else if (part !== '..' || !absolute) parts.push(part);
    }
    return (absolute ? '/' : '') + parts.join('/') || (absolute ? '/' : '.');
  }

  const join = (...parts) => normalize(parts.filter(p => p !== '' && p != null).join('/'));
  const resolve = (...parts) => {
    let out = '';
    for (const part of parts) out = String(part).startsWith('/') ? String(part) : `${out}/${part}`;
    return normalize(out.startsWith('/') ? out : `/${out}`);
  };

  function dirname(p) {
    const path = String(p).replace(/\/+$/, '');
    const at = path.lastIndexOf('/');
    if (at < 0) return '.';
    return at === 0 ? '/' : path.slice(0, at);
  }

  function basename(p, ext) {
    const name = String(p).replace(/\/+$/, '').split('/').pop() || '';
    return ext && name.endsWith(ext) && name !== ext ? name.slice(0, -ext.length) : name;
  }

  function extname(p) {
    const name = basename(p);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot) : '';
  }

  const isAbsolute = p => String(p).startsWith('/');
  const relative = (from, to) => {
    const a = resolve(from).split('/').filter(Boolean);
    const b = resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  };

  const api = { sep, delimiter: ':', normalize, join, resolve, dirname, basename, extname, isAbsolute, relative };
  api.posix = api;
  module.exports = api;
});
