// Where the chat keeps its data folder: this browser's IndexedDB, and nowhere else.
// The engine works on an in-memory file tree (engine/fs.js). This module fills that tree when the
// page opens and writes every change back, so the engine can use plain synchronous file calls.
//   database "boltchat"
//     meta   "key" -> the AES-GCM key every record is encrypted with (not extractable by page code)
//     hot    path  -> { iv, data, mtimeMs }            files kept in memory while the app is open
//                     { cold: true, size, mtimeMs }    a file whose bytes are in `cold`
//     cold   path  -> { iv, data }                     originals of project files, read on demand
// Encryption here keeps the stored bytes from being readable as plain text in the browser profile.
// It is not a defence against other code running on this site, which is why the site runs none.
Boltchat.define('storage', function (require, module, exports) {
  const fs = require('fs');
  const JSZip = self.JSZip; // vendor/jszip.min.js

  const { vfs } = fs;
  const DATA = '/data';
  const DB_NAME = 'boltchat';
  const FLUSH_DELAY_MS = 250;
  // Uploaded originals are large and only the indexer reads them, so they don't stay in memory
  const isCold = path => /^\/data\/projects\/(\.trash\/)?[^/]+\/files\//.test(path);
  const stored = path => path.startsWith(`${DATA}/`);

  let db = null;
  let key = null;
  let failure = null; // why nothing can be stored (private window, storage blocked…), else null

  const promised = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const finished = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
  });

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        for (const name of ['meta', 'hot', 'cold']) request.result.createObjectStore(name);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Storage is in use by another tab'));
    });
  }

  async function encrypt(bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes) };
  }
  const decrypt = async record => new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.data));

  // Opens the database and fills the file tree. Returns false when this browser won't store anything;
  // the app then runs from memory and says so (see status()).
  async function load() {
    fs.mkdirSync(DATA, { recursive: true });
    try {
      db = await openDb();
      key = await promised(db.transaction('meta').objectStore('meta').get('key'));
      if (!key) {
        key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(key, 'key');
        await finished(tx);
      }
      const store = db.transaction('hot').objectStore('hot');
      const [paths, records] = await Promise.all([promised(store.getAllKeys()), promised(store.getAll())]);
      await Promise.all(paths.map(async (path, i) => {
        const record = records[i];
        if (record.cold) return vfs.restore(path, null, record.size, record.mtimeMs);
        try {
          vfs.restore(path, await decrypt(record), undefined, record.mtimeMs);
        } catch (err) {
          console.warn(`Could not read ${path} from storage:`, err); // the app treats it as missing
        }
      }));
    } catch (err) {
      console.warn('Browser storage is unavailable, so nothing will be kept:', err);
      failure = err;
      db = null;
    }
    vfs.coldLoader(async path => {
      await idle();
      const record = db && await promised(db.transaction('cold').objectStore('cold').get(path));
      if (!record) throw new Error(`${path} is missing from storage`);
      return decrypt(record);
    });
    vfs.onChange(schedule);
    return !failure;
  }

  // --- Writing changes back ---

  let timer = null;
  let flushing = null;
  let onSaveError = () => {};

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      flush().catch(err => {
        console.error('Could not save to browser storage:', err);
        onSaveError(err);
      });
    }, FLUSH_DELAY_MS);
  }

  async function writeBatch() {
    const ops = vfs.journal.splice(0).filter(op => (op.op === 'move' ? stored(op.to) || stored(op.from) : stored(op.path)));
    if (!db || !ops.length) return;
    // A path written several times since the last flush is stored once, as it is now
    const last = new Map();
    ops.forEach((op, i) => { if (op.op !== 'move') last.set(op.path, i); });
    const writes = [];
    for (const [i, op] of ops.entries()) {
      if (op.op === 'move') {
        writes.push(op);
      } else if (last.get(op.path) === i) {
        const entry = op.op === 'put' ? vfs.files.get(op.path) : null;
        if (entry?.data) writes.push({ op: 'put', path: op.path, entry, record: await encrypt(entry.data) });
        else if (!entry) writes.push({ op: 'del', path: op.path });
      }
    }
    for (const write of writes) {
      const tx = db.transaction(['hot', 'cold'], 'readwrite');
      const hot = tx.objectStore('hot');
      const cold = tx.objectStore('cold');
      if (write.op === 'del') {
        hot.delete(write.path);
        cold.delete(write.path);
      } else if (write.op === 'put') {
        const { path, entry, record } = write;
        if (isCold(path)) {
          cold.put(record, path);
          hot.put({ cold: true, size: entry.size, mtimeMs: entry.mtimeMs }, path);
        } else {
          hot.put({ ...record, mtimeMs: entry.mtimeMs }, path);
          cold.delete(path);
        }
      } else {
        // A cold file changed place (a project moved to or from the trash): move its stored bytes too
        const [meta, bytes] = await Promise.all([promised(hot.get(write.from)), promised(cold.get(write.from))]);
        hot.delete(write.from);
        cold.delete(write.from);
        if (meta && stored(write.to)) hot.put(meta, write.to);
        if (bytes && stored(write.to)) cold.put(bytes, write.to);
      }
      await finished(tx);
      // Stored safely: an original no longer needs to stay in memory (unless it changed meanwhile)
      if (write.op === 'put' && isCold(write.path) && vfs.files.get(write.path) === write.entry) write.entry.data = null;
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    flushing = (flushing || Promise.resolve()).catch(() => {}).then(writeBatch);
    return flushing;
  }

  // Resolves once everything changed so far is stored
  async function idle() {
    do {
      await flush();
    } while (vfs.journal.some(op => stored(op.path || op.to)));
  }

  // --- Backup, restore and erase (Settings → About; see web-shell.js) ---

  const dataFiles = () => [...vfs.files.keys()].filter(path => stored(path) && !path.endsWith('.tmp') && !path.includes('/projects/.trash/'));

  // A backup never carries the API key: it is a file that gets copied around
  function withoutKey(bytes) {
    try {
      const { plainKey, encryptedKey, ...settings } = JSON.parse(new TextDecoder().decode(bytes));
      return new TextEncoder().encode(JSON.stringify(settings));
    } catch {
      return bytes;
    }
  }

  async function exportBackup() {
    await idle();
    const zip = new JSZip();
    for (const path of dataFiles()) {
      const bytes = await vfs.readAsync(path);
      zip.file(path.slice(DATA.length + 1), path === `${DATA}/settings.json` ? withoutKey(bytes) : bytes);
    }
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }

  // Replaces everything in this browser with the backup, keeping the API key that is saved here
  async function importBackup(file) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entries = Object.values(zip.files).filter(entry => !entry.dir && !entry.name.split('/').includes('..'));
    if (!entries.some(entry => /^(conversations|settings|projects|memory)\.json$/.test(entry.name))) {
      throw new Error('That file is not a Boltchat backup.');
    }
    let savedKey = {};
    try {
      const { plainKey } = JSON.parse(fs.readFileSync(`${DATA}/settings.json`, 'utf8'));
      if (plainKey) savedKey = { plainKey };
    } catch {
      // no settings yet
    }
    fs.rmSync(DATA, { recursive: true, force: true });
    for (const entry of entries) {
      const path = `${DATA}/${entry.name}`;
      let bytes = await entry.async('uint8array');
      if (entry.name === 'settings.json') bytes = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(withoutKey(bytes))), ...savedKey }));
      fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      fs.writeFileSync(path, bytes);
    }
    if (!entries.some(entry => entry.name === 'settings.json') && savedKey.plainKey) {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(`${DATA}/settings.json`, JSON.stringify(savedKey));
    }
    await idle();
  }

  async function eraseEverything() {
    clearTimeout(timer);
    vfs.onChange(() => {});
    await (flushing || Promise.resolve()).catch(() => {});
    db?.close();
    db = null;
    await new Promise(resolve => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }

  async function status() {
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    const used = [...vfs.files.entries()].filter(([path]) => stored(path)).reduce((sum, [, file]) => sum + file.size, 0);
    return {
      available: !failure,
      used,
      quota: estimate?.quota || 0,
      persistent: !!(await navigator.storage?.persisted?.().catch(() => false))
    };
  }

  // Asks the browser not to clear this site's data when the disk runs low (it may say no)
  const keepSafe = async () => !!(await navigator.storage?.persist?.().catch(() => false));

  module.exports = { onSaveError: handler => { onSaveError = handler; }, load, flush, idle, exportBackup, importBackup, eraseEverything, status, keepSafe };
});
