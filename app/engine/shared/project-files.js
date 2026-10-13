// A project's uploaded files and their search index.
//   projects/<id>/files/<fileId>.<ext>     the original upload
//   projects/<id>/index/files.json         [{ id, name, ext, size, addedAt, status, mode, tokens, chunks, … }]
//   projects/<id>/index/text/<fileId>.json the extracted text parts (used to pin a file into context)
//   projects/<id>/index/chunks/<fileId>.json the searchable chunks (+ vectors in index/vectors/<fileId>.bin)
// Everything under index/ is derived and can be rebuilt from the originals.
// Shared with the Windows app, where this file is src/project-files.js.
Boltchat.define('project-files', function (require, module, exports) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const { DIMENSIONS, unpackVectors } = require('./ingest/embedder');

  const LIMITS = { fileBytes: 25 * 1024 * 1024, files: 100, totalBytes: 250 * 1024 * 1024 };
  // A file may be pinned into every request only if it is small enough to be reasonable
  const CONTEXT_MAX_TOKENS = 12000;
  const NAME_MAX = 120;
  const STATUSES = ['queued', 'indexing', 'ready', 'error', 'no-text'];

  class FileError extends Error {}

  const safeId = id => typeof id === 'string' && /^[a-z0-9]{6,40}$/.test(id);

  function cleanName(name) {
    const base = path.basename(String(name || '').replace(/\\/g, '/'));
    const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim().slice(0, NAME_MAX);
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
  }

  function createFileStore(projects) {
    const dirs = pid => {
      const root = projects.folder(pid);
      return {
        root,
        files: path.join(root, 'files'),
        index: path.join(root, 'index'),
        meta: path.join(root, 'index', 'files.json'),
        text: path.join(root, 'index', 'text'),
        chunks: path.join(root, 'index', 'chunks'),
        vectors: path.join(root, 'index', 'vectors')
      };
    };
    const exists = pid => safeId(pid) && fs.existsSync(dirs(pid).root);

    const writeAtomic = (file, data) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
    };

    function readMeta(pid) {
      try {
        const list = JSON.parse(fs.readFileSync(dirs(pid).meta, 'utf8'));
        return Array.isArray(list) ? list.filter(f => f && safeId(f.id)) : [];
      } catch {
        return [];
      }
    }
    const writeMeta = (pid, list) => writeAtomic(dirs(pid).meta, JSON.stringify(list));

    const list = pid => (exists(pid) ? readMeta(pid) : []);
    const get = (pid, id) => list(pid).find(f => f.id === id) || null;

    function usage(pid) {
      const files = list(pid);
      return { count: files.length, bytes: files.reduce((sum, f) => sum + (f.size || 0), 0) };
    }

    function removeDerived(pid, id) {
      const d = dirs(pid);
      for (const file of [path.join(d.text, `${id}.json`), path.join(d.chunks, `${id}.json`), path.join(d.vectors, `${id}.bin`)]) {
        fs.rmSync(file, { force: true });
      }
    }

    function remove(pid, id) {
      if (!exists(pid)) return false;
      const files = readMeta(pid);
      const file = files.find(f => f.id === id);
      if (!file) return false;
      writeMeta(pid, files.filter(f => f.id !== id));
      fs.rmSync(path.join(dirs(pid).files, `${id}.${file.ext}`), { force: true });
      removeDerived(pid, id);
      return true;
    }

    // Adds one upload. A file with the same name replaces the old one (and keeps its mode), so
    // dropping an updated copy is the way to refresh it. Throws FileError with a message for the user.
    function add(pid, { name, bytes }) {
      if (!exists(pid)) throw new FileError('That project no longer exists.');
      const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
      const clean = cleanName(name);
      if (!data.length) throw new FileError(`“${clean}” is empty.`);
      if (data.length > LIMITS.fileBytes) throw new FileError(`“${clean}” is larger than ${LIMITS.fileBytes / 1024 / 1024} MB.`);
      const existing = readMeta(pid).find(f => f.name.toLowerCase() === clean.toLowerCase());
      const used = usage(pid);
      const bytesAfter = used.bytes - (existing?.size || 0) + data.length;
      if (!existing && used.count >= LIMITS.files) throw new FileError(`A project can hold ${LIMITS.files} files.`);
      if (bytesAfter > LIMITS.totalBytes) throw new FileError(`A project can hold ${LIMITS.totalBytes / 1024 / 1024} MB of files.`);

      const mode = existing?.mode === 'context' ? 'context' : 'search';
      if (existing) remove(pid, existing.id);
      const id = `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
      const ext = (path.extname(clean).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin').slice(0, 12);
      const d = dirs(pid);
      writeAtomic(path.join(d.files, `${id}.${ext}`), data);
      const entry = { id, name: clean, ext, size: data.length, addedAt: Date.now(), status: 'queued', mode, tokens: 0, chunks: 0 };
      writeMeta(pid, [...readMeta(pid), entry]);
      return { ...entry, replaced: !!existing };
    }

    // Changes bookkeeping fields only; unknown keys and ids can't be written from outside
    function patch(pid, id, changes) {
      if (!exists(pid)) return null;
      const files = readMeta(pid);
      const file = files.find(f => f.id === id);
      if (!file) return null;
      for (const key of ['status', 'error', 'tokens', 'chunks', 'kind', 'model']) {
        if (key in changes) {
          if (changes[key] === undefined || changes[key] === null) delete file[key];
          else file[key] = changes[key];
        }
      }
      if (!STATUSES.includes(file.status)) file.status = 'error';
      if (file.status !== 'error') delete file.error;
      writeMeta(pid, files);
      return file;
    }

    function setMode(pid, id, mode) {
      const file = get(pid, id);
      if (!file) throw new FileError('That file no longer exists.');
      if (mode === 'context') {
        if (file.status !== 'ready') throw new FileError('Wait until the file is indexed.');
        if (file.tokens > CONTEXT_MAX_TOKENS) throw new FileError(`This file (~${file.tokens.toLocaleString('en-US')} tokens) is too big to include in every message. Keep it on Search.`);
      } else if (mode !== 'search') {
        throw new FileError('Unknown mode.');
      }
      const files = readMeta(pid);
      files.find(f => f.id === id).mode = mode;
      writeMeta(pid, files);
      return files.find(f => f.id === id);
    }

    // Results arrive from the worker later; a project or file deleted meanwhile must not come back
    function saveIndex(pid, id, { parts, chunks, kind, vectors, model }) {
      const file = get(pid, id);
      if (!file) return null;
      const d = dirs(pid);
      writeAtomic(path.join(d.text, `${id}.json`), JSON.stringify(parts));
      writeAtomic(path.join(d.chunks, `${id}.json`), JSON.stringify(chunks));
      // Vectors (one per chunk, base64 of Float32) are kept only if they line up with the chunks
      const bytes = vectors ? Buffer.from(vectors, 'base64') : null;
      const vectorFile = path.join(d.vectors, `${id}.bin`);
      const embedded = !!bytes && bytes.length === chunks.length * DIMENSIONS * 4;
      if (embedded) writeAtomic(vectorFile, bytes);
      else fs.rmSync(vectorFile, { force: true });
      const chars = parts.reduce((sum, p) => sum + p.text.length, 0);
      return patch(pid, id, { status: 'ready', tokens: Math.ceil(chars / 3.5), chunks: chunks.length, kind, model: embedded ? model : null });
    }

    const readJson = file => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    };
    const loadChunks = (pid, id) => (exists(pid) ? readJson(path.join(dirs(pid).chunks, `${id}.json`)) : null);
    const loadText = (pid, id) => (exists(pid) ? readJson(path.join(dirs(pid).text, `${id}.json`)) : null);
    // One row of DIMENSIONS floats per chunk, or null for a file indexed without the embedding model
    function loadVectors(pid, id) {
      if (!exists(pid)) return null;
      try {
        return unpackVectors(fs.readFileSync(path.join(dirs(pid).vectors, `${id}.bin`)));
      } catch {
        return null;
      }
    }
    const originalPath = (pid, file) => path.join(dirs(pid).files, `${file.id}.${file.ext}`);

    // After a crash or quit mid-index, anything unfinished starts over
    function resetInterrupted(pid) {
      const files = readMeta(pid);
      let changed = false;
      for (const f of files) {
        if (f.status === 'indexing') { f.status = 'queued'; changed = true; }
      }
      if (changed) writeMeta(pid, files);
      return files.filter(f => f.status === 'queued');
    }

    return { list, get, add, remove, patch, setMode, saveIndex, loadChunks, loadText, loadVectors, originalPath, usage, resetInterrupted, dirs, exists };
  }

  module.exports = { createFileStore, FileError, LIMITS, CONTEXT_MAX_TOKENS, cleanName };
});
