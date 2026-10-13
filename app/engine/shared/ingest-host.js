// Runs project files through the ingest worker one at a time, and answers search-query embeddings
// from the same worker. The worker itself is started through `spawn`, so the app can
// use an Electron utilityProcess and the tests a plain Node child.
// A file moves queued -> indexing -> ready | error | no-text; every change is reported through
// onChange(projectId) so the page can refresh its file list.
// Shared with the Windows app, where this file is src/ingest-host.js.
Boltchat.define('ingest-host', function (require, module, exports) {
  function createIngestHost({ files, spawn, onChange = () => {}, timeoutMs = 600000 }) {
    const queue = [];
    let worker = null;
    let running = null; // { pid, id, cancelled }
    let jobSeq = 0;
    let idleWaiters = [];
    const pending = new Map(); // request id -> settle(message)

    const failAll = message => {
      for (const settle of [...pending.values()]) settle(message);
    };

    const ensureWorker = () => {
      if (worker) return worker;
      const w = spawn();
      w.onMessage(message => pending.get(message?.id)?.(message));
      w.onExit(() => {
        // Only the worker that is current can fail requests; an old one dying late must not
        const current = worker === w;
        if (current) worker = null;
        if (current) failAll({ ok: false, code: 'crash', message: 'The indexing process stopped unexpectedly. Try again.' });
      });
      worker = w;
      return w;
    };

    // One request to the worker; always resolves (with { ok: false, … } on timeout, crash or a send error)
    function request(message, limit) {
      return new Promise(resolve => {
        const id = ++jobSeq;
        let timer;
        const settle = reply => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(reply);
        };
        pending.set(id, settle);
        timer = setTimeout(() => {
          // A request that hangs the worker must not block everything after it: restart the worker
          if (!pending.has(id)) return;
          const w = worker;
          worker = null;
          w?.kill();
          failAll({ ok: false, code: 'failed', message: 'Reading this file took too long.' });
        }, limit);
        try {
          ensureWorker().postMessage({ ...message, id });
        } catch (err) {
          settle({ ok: false, code: 'failed', message: `Could not start indexing (${err.message}).` });
        }
      });
    }

    async function run(entry) {
      const file = files.get(entry.pid, entry.id);
      if (!file) return;
      files.patch(entry.pid, entry.id, { status: 'indexing' });
      onChange(entry.pid);
      const job = { ...entry, cancelled: false };
      running = job;
      const result = await request({ type: 'index', path: files.originalPath(entry.pid, file), name: file.name }, timeoutMs);
      running = null;
      if (job.cancelled) return; // the project or file was deleted meanwhile
      // The worker died: not necessarily this file's fault, so it gets one more try on a fresh worker
      if (result.code === 'crash' && !entry.retried) {
        files.patch(entry.pid, entry.id, { status: 'queued' });
        queue.unshift({ ...entry, retried: true });
        return;
      }
      if (result.ok) files.saveIndex(entry.pid, entry.id, result);
      else files.patch(entry.pid, entry.id, { status: result.code === 'no-text' ? 'no-text' : 'error', error: result.message });
      onChange(entry.pid);
    }

    let pumping = false;
    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (queue.length) {
          const entry = queue.shift();
          try {
            await run(entry);
          } catch (err) {
            console.warn('Indexing failed:', err);
            files.patch(entry.pid, entry.id, { status: 'error', error: 'Could not index this file.' });
            onChange(entry.pid);
          }
        }
      } finally {
        pumping = false;
        const waiters = idleWaiters;
        idleWaiters = [];
        waiters.forEach(resolve => resolve());
      }
    }

    const enqueue = (pid, id) => {
      if (queue.some(e => e.pid === pid && e.id === id) || (running && running.pid === pid && running.id === id)) return;
      queue.push({ pid, id });
      pump();
    };

    const host = {
      enqueue,
      // Start over for files left unfinished by the last session
      resume(pids) {
        for (const pid of pids) for (const f of files.resetInterrupted(pid)) enqueue(pid, f.id);
      },
      retry(pid, id) {
        if (!files.get(pid, id)) return;
        files.patch(pid, id, { status: 'queued' });
        onChange(pid);
        enqueue(pid, id);
      },
      // Index every file of a project again (e.g. after the embedding model changed)
      reindex(pid) {
        for (const f of files.list(pid)) host.retry(pid, f.id);
      },
      // A project or file is going away: forget its queued work and ignore any result in flight
      drop(pid, id = null) {
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].pid === pid && (!id || queue[i].id === id)) queue.splice(i, 1);
        if (running && running.pid === pid && (!id || running.id === id)) running.cancelled = true;
      },
      // Embeds a search query as a Float32Array, or null when there is no model (keyword search only).
      // Goes straight to the worker, so it isn't stuck behind files being indexed.
      async embedQuery(text, limit = 8000) {
        const reply = await request({ type: 'embedQuery', text: String(text).slice(0, 2000) }, limit);
        if (!reply.ok || !reply.vector) return null;
        const bytes = Buffer.from(reply.vector, 'base64');
        return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      },
      // Whether meaning-based search is available (the model loaded), or only keyword search
      async embeddingsAvailable(limit = 15000) {
        const reply = await request({ type: 'status' }, limit);
        return !!(reply.ok && reply.embeddings);
      },
      // Embeds passages (not queries) as Float32Arrays, or null when there is no model
      async embedTexts(texts, limit = 120000) {
        if (!texts.length) return [];
        const reply = await request({ type: 'embed', texts }, limit);
        if (!reply.ok || !reply.vectors) return null;
        const bytes = Buffer.from(reply.vectors, 'base64');
        const all = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        return texts.map((_, i) => all.subarray(i * 384, (i + 1) * 384));
      },
      idle: () => (pumping ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve()),
      shutdown() {
        queue.length = 0;
        worker?.kill();
        worker = null;
      }
    };
    return host;
  }

  module.exports = { createIngestHost };
});
