// The Files card on a project's page (renderer). A plain <script> that shares globals with
// renderer.js and projects.js (api, state, toast, formatNumber, projectCard, projectSections, …).
// Uploaded files are read, split and indexed in the background by the main process
// (src/ingest-host.js); this card shows their progress and lets you choose how each one is used.
const FILE_STATUS = {
  queued: 'Waiting',
  indexing: 'Reading…',
  ready: 'Ready',
  error: 'Couldn’t read',
  'no-text': 'No text'
};
const formatBytes = n => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function reportFileResult(result) {
  if (result?.errors?.length) {
    toast.error(result.errors.slice(0, 3).join(' ') + (result.errors.length > 3 ? ` (+${result.errors.length - 3} more)` : ''), 7000);
  }
  if (result?.added?.length) toast.success(result.added.length === 1 ? `Added “${result.added[0]}”` : `Added ${result.added.length} files`);
}

async function addFilesToProject(projectId, uploads) {
  if (!uploads.length) return;
  try {
    reportFileResult(await api.files.add(projectId, uploads));
  } catch (err) {
    toast.error(cleanError(err));
  }
}

function filesSection(project) {
  const card = projectCard('Files', 'Documents, notes, spreadsheets, PDFs, code and more. Boltchat looks through them for each message in this project, and you can also include a small file in every message.');
  card.classList.add('project-files');
  const bar = document.createElement('div');
  bar.className = 'project-files-bar';
  const add = document.createElement('button');
  add.className = 'primary-btn small';
  add.textContent = '＋ Add files…';
  add.addEventListener('click', async () => {
    try {
      reportFileResult(await api.files.pick(project.id));
    } catch (err) {
      toast.error(cleanError(err));
    }
  });
  const summary = document.createElement('span');
  summary.className = 'project-files-summary';
  summary.id = 'project-files-summary';
  const rebuild = document.createElement('button');
  rebuild.className = 'ghost-btn small';
  rebuild.textContent = 'Rebuild search index';
  rebuild.title = 'Read every file and earlier chat of this project again';
  rebuild.addEventListener('click', async () => {
    try {
      await api.files.reindex(project.id);
      toast.success('Rebuilding the search index…');
      refreshProjectFiles(project.id);
    } catch (err) {
      toast.error(cleanError(err));
    }
  });
  bar.append(add, summary, rebuild);
  const note = document.createElement('p');
  note.className = 'project-hint';
  note.id = 'project-search-status';
  note.hidden = true;
  const list = document.createElement('div');
  list.className = 'project-file-list';
  list.id = 'project-files-list';
  const overlay = document.createElement('div');
  overlay.className = 'drop-overlay';
  overlay.innerHTML = '<strong>Drop to add to this project</strong><span>They’ll be read and made searchable</span>';
  card.append(bar, note, list, overlay);
  // Meaning-based search needs the bundled model; say so when it can't load, instead of quietly searching worse
  api.files.status().then(status => {
    if (status?.embeddings === false) {
      note.hidden = false;
      note.textContent = 'Meaning-based search isn’t available in this browser right now, so files are searched by keywords only.';
    }
  }).catch(() => {});

  // Dropping files anywhere on the card adds them
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  card.addEventListener('dragover', e => {
    if (hasFiles(e)) { e.preventDefault(); card.classList.add('drop'); }
  });
  card.addEventListener('dragleave', e => {
    if (!card.contains(e.relatedTarget)) card.classList.remove('drop');
  });
  card.addEventListener('drop', async e => {
    card.classList.remove('drop');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const uploads = [];
    for (const file of [...e.dataTransfer.files]) {
      if (!file.size && !file.type) continue; // a dropped folder
      uploads.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    await addFilesToProject(project.id, uploads);
  });

  // The card isn't on the page yet; load the list once it is
  setTimeout(() => refreshProjectFiles(project.id), 0);
  return card;
}
projectSections.push(filesSection);

async function refreshProjectFiles(projectId) {
  if (!document.getElementById('project-files-list') || state.projectView !== projectId) return;
  let files = [];
  try {
    files = await api.files.list(projectId);
  } catch (err) {
    return toast.error(cleanError(err));
  }
  // The page may have moved on while the list was loading
  if (state.projectView !== projectId || !document.getElementById('project-files-list')) return;
  renderProjectFiles(projectId, files);
}

function renderProjectFiles(projectId, files) {
  const list = document.getElementById('project-files-list');
  const summary = document.getElementById('project-files-summary');
  list.innerHTML = '';
  summary.textContent = files.length
    ? `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(files.reduce((n, f) => n + f.size, 0))}`
    : '';
  if (!files.length) {
    // The empty state is itself the drop target and a button to choose files
    const zone = document.createElement('button');
    zone.type = 'button';
    zone.className = 'project-dropzone';
    zone.innerHTML = '<span class="project-empty-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V4m0 0L6.5 7.5M10 4l3.5 3.5M3.5 12.5v2A1.5 1.5 0 0 0 5 16h10a1.5 1.5 0 0 0 1.5-1.5v-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span><strong>Add your first files</strong><span>Drop them here, or click to choose. PDFs, documents, spreadsheets, notes and code all work.</span>';
    zone.addEventListener('click', () => document.querySelector('.project-files-bar .primary-btn')?.click());
    list.appendChild(zone);
    return;
  }
  for (const file of files) list.appendChild(fileRow(projectId, file));
}

function fileRow(projectId, file) {
  const row = document.createElement('div');
  row.className = 'project-file';
  row.dataset.fileId = file.id;

  const info = document.createElement('div');
  info.className = 'project-file-info';
  const name = document.createElement('span');
  name.className = 'project-file-name';
  name.textContent = file.name;
  name.title = file.name;
  const meta = document.createElement('small');
  const bits = [formatBytes(file.size)];
  if (file.status === 'ready') bits.push(`~${formatNumber(file.tokens)} tokens`);
  meta.textContent = bits.join(' · ');
  info.append(name, meta);
  if (file.error) {
    const why = document.createElement('small');
    why.className = 'project-file-error';
    why.textContent = file.error;
    info.appendChild(why);
  }

  const status = document.createElement('span');
  status.className = `file-chip ${file.status}`;
  status.textContent = FILE_STATUS[file.status] || file.status;

  const actions = document.createElement('span');
  actions.className = 'project-file-actions';
  if (file.status === 'ready') {
    const mode = document.createElement('select');
    mode.className = 'project-file-mode';
    mode.setAttribute('aria-label', `How ${file.name} is used`);
    for (const [value, label] of [['search', 'Search when relevant'], ['context', 'Include in every message']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      mode.appendChild(option);
    }
    mode.value = file.mode;
    mode.addEventListener('change', async () => {
      try {
        await api.files.setMode(projectId, file.id, mode.value);
      } catch (err) {
        toast.error(cleanError(err));
      }
      loadPinnedTokens(projectId);
      refreshProjectFiles(projectId); // shows the stored mode, also when the change was refused
    });
    actions.appendChild(mode);
  } else if (file.status === 'error') {
    const retry = document.createElement('button');
    retry.className = 'ghost-btn small';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => api.files.retry(projectId, file.id));
    actions.appendChild(retry);
  }
  const remove = document.createElement('button');
  remove.className = 'chat-item-action project-file-remove';
  remove.textContent = '✕';
  remove.title = 'Remove file';
  remove.setAttribute('aria-label', `Remove ${file.name}`);
  remove.addEventListener('click', async () => {
    try {
      await api.files.remove(projectId, file.id);
    } catch (err) {
      toast.error(cleanError(err));
    }
    refreshProjectFiles(projectId);
  });
  actions.appendChild(remove);

  row.append(info, status, actions);
  return row;
}

api.files.onChanged(({ projectId }) => {
  loadPinnedTokens(projectId);
  if (state.projectView === projectId) refreshProjectFiles(projectId);
});

// ---------- What a project adds to every request ----------

// Tokens of the files set to “Include in every message”, per project. They count against the model's
// room just like the conversation does, so the model picker can grey out models they wouldn't fit.
const pinnedTokens = new Map();
const pinnedTokensFor = chat => (chat?.projectId ? pinnedTokens.get(chat.projectId) || 0 : 0);

async function loadPinnedTokens(projectId) {
  try {
    const files = await api.files.list(projectId);
    const tokens = files.filter(f => f.mode === 'context' && f.status === 'ready').reduce((sum, f) => sum + f.tokens, 0);
    if ((pinnedTokens.get(projectId) || 0) !== tokens) {
      pinnedTokens.set(projectId, tokens);
      updateComposerState();
    }
  } catch (err) {
    console.warn('Could not read project files:', err);
  }
}

// The "From your project" row under a reply: the passages it used, the files kept in context, and a
// note when search was skipped
function renderProjectSources(container, msg, streaming) {
  const used = msg.projectSources || [];
  const pinned = msg.pinnedFiles || [];
  container.hidden = !(used.length || pinned.length || msg.knowledgeNote);
  container.innerHTML = '';
  if (container.hidden) return;
  const label = document.createElement('span');
  label.className = 'sources-label';
  label.textContent = 'From your project';
  container.appendChild(label);
  for (const name of pinned) {
    const chip = document.createElement('span');
    chip.className = 'source-chip pinned';
    chip.textContent = `📌 ${name}`;
    chip.title = `${name} is kept in context for every message`;
    container.appendChild(chip);
  }
  for (const source of used) {
    const chip = document.createElement('span');
    chip.className = 'source-chip';
    chip.textContent = `[${source.n}] ${source.label}`;
    chip.title = source.label;
    container.appendChild(chip);
  }
  if (msg.knowledgeNote) {
    const note = document.createElement('span');
    note.className = 'project-hint';
    note.textContent = msg.knowledgeNote;
    container.appendChild(note);
  }
}
