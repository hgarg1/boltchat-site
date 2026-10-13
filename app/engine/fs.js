// The engine reads and writes its data folder with the same synchronous calls as Node's `fs`. Here the
// folder is this in-memory file tree, which engine/storage.js loads from IndexedDB before the chat
// starts and writes back after every change. Only the calls the engine makes are implemented.
//   files: path -> { data: Uint8Array | null, size, mtimeMs }
// `data` is null for a "cold" file: one whose bytes were written to IndexedDB and dropped from memory
// (the originals of project files, which only the indexer reads, and it gets them through readAsync).
Boltchat.define('fs', function (require, module, exports) {
  const files = new Map();
  const dirs = new Set(['/']);
  const journal = []; // { op: 'put' | 'del', path } or { op: 'move', from, to } for cold files
  let onChange = () => {};
  let loadCold = async () => null;

  const norm = p => {
    const parts = [];
    for (const part of String(p).replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return `/${parts.join('/')}`;
  };
  const parent = p => p.slice(0, p.lastIndexOf('/')) || '/';

  function fail(code, path, syscall) {
    const err = new Error(`${code}: ${syscall} '${path}'`);
    err.code = code;
    err.path = path;
    return err;
  }

  function record(entry) {
    journal.push(entry);
    onChange();
  }

  function mkdirp(dir) {
    for (let d = dir; d !== '/' && !dirs.has(d); d = parent(d)) dirs.add(d);
  }

  function existsSync(p) {
    const path = norm(p);
    return files.has(path) || dirs.has(path);
  }

  function mkdirSync(p, options = {}) {
    const path = norm(p);
    if (files.has(path)) throw fail('EEXIST', path, 'mkdir');
    if (!options.recursive && !dirs.has(parent(path))) throw fail('ENOENT', path, 'mkdir');
    mkdirp(path);
  }

  function readFileSync(p, options) {
    const path = norm(p);
    const file = files.get(path);
    if (!file) throw fail(dirs.has(path) ? 'EISDIR' : 'ENOENT', path, 'open');
    if (!file.data) throw fail('EBUSY', path, 'open'); // cold: only readAsync can fetch it
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const buffer = Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength);
    return encoding ? buffer.toString(encoding) : Buffer.from(buffer);
  }

  function writeFileSync(p, data) {
    const path = norm(p);
    if (dirs.has(path)) throw fail('EISDIR', path, 'open');
    if (!dirs.has(parent(path))) throw fail('ENOENT', path, 'open');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    files.set(path, { data: bytes, size: bytes.byteLength, mtimeMs: Date.now() });
    record({ op: 'put', path });
  }

  function moveFile(from, to) {
    const file = files.get(from);
    files.delete(from);
    files.set(to, file);
    if (file.data) {
      record({ op: 'del', path: from });
      record({ op: 'put', path: to });
    } else {
      record({ op: 'move', from, to });
    }
  }

  function renameSync(a, b) {
    const from = norm(a);
    const to = norm(b);
    if (!dirs.has(parent(to))) throw fail('ENOENT', to, 'rename');
    if (files.has(from)) return moveFile(from, to);
    if (!dirs.has(from)) throw fail('ENOENT', from, 'rename');
    const under = path => path === from || path.startsWith(`${from}/`);
    for (const dir of [...dirs].filter(under)) {
      dirs.delete(dir);
      dirs.add(to + dir.slice(from.length));
    }
    for (const path of [...files.keys()].filter(under)) moveFile(path, to + path.slice(from.length));
  }

  function rmSync(p, options = {}) {
    const path = norm(p);
    if (files.has(path)) {
      files.delete(path);
      return record({ op: 'del', path });
    }
    if (!dirs.has(path)) {
      if (options.force) return;
      throw fail('ENOENT', path, 'rm');
    }
    if (!options.recursive) throw fail('EISDIR', path, 'rm');
    for (const dir of [...dirs]) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
    for (const file of [...files.keys()]) {
      if (file.startsWith(`${path}/`)) {
        files.delete(file);
        record({ op: 'del', path: file });
      }
    }
  }

  function statSync(p) {
    const path = norm(p);
    const file = files.get(path);
    if (!file && !dirs.has(path)) throw fail('ENOENT', path, 'stat');
    return { size: file ? file.size : 0, mtimeMs: file ? file.mtimeMs : 0, isFile: () => !!file, isDirectory: () => !file };
  }

  function copyFileSync(a, b) {
    writeFileSync(b, readFileSync(a));
  }

  function readdirSync(p) {
    const path = norm(p);
    if (!dirs.has(path)) throw fail('ENOENT', path, 'scandir');
    const prefix = path === '/' ? '/' : `${path}/`;
    const names = new Set();
    for (const entry of [...files.keys(), ...dirs]) {
      if (entry !== path && entry.startsWith(prefix)) names.add(entry.slice(prefix.length).split('/')[0]);
    }
    return [...names].sort();
  }

  const realpathSync = p => {
    const path = norm(p);
    if (!existsSync(path)) throw fail('ENOENT', path, 'realpath');
    return path;
  };

  // There is nothing outside the page that could change a file
  const watch = () => ({ close() {} });

  // --- For engine/storage.js and engine/engine.js; not part of Node's fs ---
  const vfs = {
    files,
    dirs,
    journal,
    norm,
    // Put a file in place while loading, without recording a change
    restore(path, data, size = data ? data.byteLength : 0, mtimeMs = Date.now()) {
      mkdirp(parent(path));
      files.set(path, { data, size, mtimeMs });
    },
    onChange(handler) { onChange = handler; },
    coldLoader(loader) { loadCold = loader; },
    // Bytes of any file, fetching a cold one from IndexedDB
    async readAsync(p) {
      const path = norm(p);
      const file = files.get(path);
      if (!file) throw fail('ENOENT', path, 'open');
      return file.data || loadCold(path);
    }
  };

  module.exports = { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, copyFileSync, readdirSync, realpathSync, watch, vfs };
});
