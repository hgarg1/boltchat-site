// Projects (renderer). A project groups chats and carries instructions, files and memory.
// This is a plain <script> that shares globals with renderer.js (state, el, api, toast, uid,
// persistChats, renderChatList, openChat, newChat, …). The renderer owns conversations.json, so every
// chat-side change below goes through state.chats followed by persistChats(); main only stores the
// project rows and folders (src/project-store.js).
const projectEl = {
  section: document.getElementById('project-section'),
  list: document.getElementById('project-list'),
  add: document.getElementById('new-project'),
  view: document.getElementById('project-view'),
  chip: document.getElementById('project-chip'),
  thread: document.getElementById('thread'),
  composerWrap: document.getElementById('composer-wrap')
};
const PROJECT_NAME_MAX = 60;
const PROJECT_INSTRUCTIONS_MAX = 8000;
const expandedProjects = new Set();

const projectOf = chat => (chat?.projectId && state.projects.find(p => p.id === chat.projectId)) || null;
const projectById = id => state.projects.find(p => p.id === id) || null;
const chatsIn = id => state.chats.filter(c => c.projectId === id).sort((a, b) => b.updatedAt - a.updatedAt);

// ---------- Small UI helpers ----------

function showMenu(anchor, items) {
  document.querySelector('.pop-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'pop-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item.heading) {
      const h = document.createElement('div');
      h.className = 'pop-menu-heading';
      h.textContent = item.heading;
      menu.appendChild(h);
      continue;
    }
    const button = document.createElement('button');
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    if (item.current) button.classList.add('current');
    button.addEventListener('click', e => {
      e.stopPropagation();
      close();
      item.run();
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
  function close() {
    menu.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  }
  const outside = e => { if (!menu.contains(e.target)) close(); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
  menu.querySelector('button')?.focus();
}

// Resolves with the chosen button's value, or null when dismissed
function askChoice({ title, body, choices }) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = body;
    const row = document.createElement('div');
    row.className = 'dialog-actions';
    const done = value => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(value);
    };
    for (const choice of choices) {
      const b = document.createElement('button');
      b.className = choice.danger ? 'danger-btn' : choice.primary ? 'primary-btn' : 'ghost-btn';
      b.textContent = choice.label;
      b.addEventListener('click', () => done(choice.value));
      row.appendChild(b);
    }
    const cancel = document.createElement('button');
    cancel.className = 'ghost-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => done(null));
    row.appendChild(cancel);
    dialog.append(h, p, row);
    backdrop.appendChild(dialog);
    backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) done(null); });
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    row.querySelector('button').focus();
  });
}

const FOLDER_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.2c0-.7.5-1.2 1.2-1.2h2.6l1.3 1.5h5.7c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2V4.2Z" fill="currentColor"/></svg>';

// ---------- Sidebar ----------

function renderProjects() {
  projectEl.list.innerHTML = '';
  projectEl.section.classList.toggle('empty', !state.projects.length);
  if (!state.projects.length) {
    const hint = document.createElement('div');
    hint.className = 'chat-empty';
    hint.textContent = 'Group chats, files and instructions';
    projectEl.list.appendChild(hint);
  }
  for (const project of state.projects) projectEl.list.appendChild(projectRow(project));
  renderProjectChrome();
}

function projectRow(project) {
  const wrap = document.createElement('div');
  wrap.className = 'project';
  const open = expandedProjects.has(project.id);
  const row = document.createElement('div');
  row.className = 'chat-item project-item' + (state.projectView === project.id ? ' active' : '');
  row.dataset.projectId = project.id;
  const chats = chatsIn(project.id);

  const caret = document.createElement('button');
  caret.className = 'project-caret' + (open ? ' open' : '');
  caret.setAttribute('aria-label', open ? `Collapse ${project.name}` : `Expand ${project.name}`);
  caret.setAttribute('aria-expanded', String(open));
  caret.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  caret.addEventListener('click', e => {
    e.stopPropagation();
    if (expandedProjects.has(project.id)) expandedProjects.delete(project.id);
    else expandedProjects.add(project.id);
    renderProjects();
  });

  const renaming = state.renamingProject?.projectId === project.id;
  let title;
  if (renaming) {
    row.classList.add('renaming');
    title = document.createElement('input');
    title.className = 'chat-rename-input';
    title.value = state.renamingProject.draft;
    title.maxLength = PROJECT_NAME_MAX;
    title.setAttribute('aria-label', 'Project name');
    title.addEventListener('click', e => e.stopPropagation());
    title.addEventListener('input', () => {
      if (state.renamingProject?.projectId === project.id) state.renamingProject.draft = title.value;
      title.classList.remove('invalid');
    });
    title.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitProjectRename(project.id, { showInvalid: true }); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelProjectRename(); }
    });
    title.addEventListener('blur', () => {
      if (state.renamingProject?.projectId === project.id) commitProjectRename(project.id, { showInvalid: false });
    });
  } else {
    title = document.createElement('span');
    title.className = 'chat-item-title';
    title.textContent = project.name;
    title.title = project.name;
    title.addEventListener('dblclick', e => { e.stopPropagation(); beginProjectRename(project.id); });
  }

  const count = document.createElement('span');
  count.className = 'project-count';
  count.textContent = chats.length ? String(chats.length) : '';

  const actions = document.createElement('span');
  actions.className = 'chat-item-actions';
  const rename = document.createElement('button');
  rename.className = 'chat-item-action chat-item-rename';
  rename.title = 'Rename project';
  rename.setAttribute('aria-label', `Rename ${project.name}`);
  rename.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11.8V14h2.2L12.7 6.5l-2.2-2.2L3 11.8Zm10.8-6.4a.8.8 0 0 0 0-1.1l-1.1-1.1a.8.8 0 0 0-1.1 0l-.6.6L13.2 6l.6-.6Z" fill="currentColor"/></svg>';
  rename.addEventListener('click', e => { e.stopPropagation(); beginProjectRename(project.id); });
  const del = document.createElement('button');
  del.className = 'chat-item-action chat-item-delete';
  del.title = 'Delete project';
  del.setAttribute('aria-label', `Delete ${project.name}`);
  del.textContent = '✕';
  del.addEventListener('click', e => { e.stopPropagation(); deleteProject(project.id); });
  actions.append(rename, del);

  row.append(caret, title, count, actions);
  row.addEventListener('click', () => { if (!renaming) openProject(project.id); });

  // A chat dragged from the list drops into the project
  row.addEventListener('dragover', e => {
    if ([...e.dataTransfer.types].includes('application/x-boltchat-chat')) { e.preventDefault(); row.classList.add('drop'); }
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop'));
  row.addEventListener('drop', e => {
    row.classList.remove('drop');
    const id = e.dataTransfer.getData('application/x-boltchat-chat');
    if (id) { e.preventDefault(); moveChatToProject(id, project.id); }
  });
  wrap.appendChild(row);

  if (open) {
    const sub = document.createElement('div');
    sub.className = 'project-chats';
    if (!chats.length) {
      const none = document.createElement('div');
      none.className = 'chat-empty';
      none.textContent = 'No chats yet';
      sub.appendChild(none);
    }
    for (const chat of chats) {
      const item = document.createElement('div');
      item.className = 'chat-item project-chat' + (chat.id === state.activeId && !state.projectView ? ' active' : '');
      item.title = chat.title;
      item.draggable = true;
      item.addEventListener('dragstart', e => e.dataTransfer.setData('application/x-boltchat-chat', chat.id));
      const t = document.createElement('span');
      t.className = 'chat-item-title';
      t.textContent = chat.title;
      const a = document.createElement('span');
      a.className = 'chat-item-actions';
      a.append(moveToProjectButton(chat));
      item.append(t, a);
      item.addEventListener('click', () => openChat(chat.id));
      sub.appendChild(item);
    }
    wrap.appendChild(sub);
  }
  return wrap;
}

function moveToProjectButton(chat) {
  const button = document.createElement('button');
  button.className = 'chat-item-action chat-item-move';
  button.title = 'Move to project';
  button.setAttribute('aria-label', `Move ${chat.title} to a project`);
  button.innerHTML = FOLDER_ICON;
  button.addEventListener('click', e => {
    e.stopPropagation();
    const items = [{ heading: 'Move to project' }];
    for (const p of state.projects) {
      items.push({ label: p.name, current: chat.projectId === p.id, run: () => moveChatToProject(chat.id, p.id) });
    }
    items.push({ label: '＋ New project…', run: () => createProject({ moveChatId: chat.id }) });
    if (projectOf(chat)) items.push({ label: 'Remove from project', run: () => moveChatToProject(chat.id, null) });
    showMenu(button, items);
  });
  return button;
}

// Keep the header chip and the project page in step with the state
function renderProjectChrome() {
  const chat = activeChat();
  const inProject = !state.projectView && projectOf(chat);
  const pending = !state.projectView && !chat && projectById(state.newChatProjectId);
  const project = inProject || pending || null;
  projectEl.chip.hidden = !project;
  if (project) {
    projectEl.chip.textContent = project.name;
    projectEl.chip.dataset.projectId = project.id;
    projectEl.chip.title = `Project: ${project.name}`;
    projectEl.chip.prepend(Object.assign(document.createElement('span'), { className: 'project-chip-ico', innerHTML: FOLDER_ICON }));
  }
  const viewing = state.projectView && projectById(state.projectView);
  if (state.projectView && !viewing) state.projectView = null;
  projectEl.view.hidden = !viewing;
  projectEl.thread.classList.toggle('behind-project', !!viewing);
  projectEl.composerWrap.classList.toggle('behind-project', !!viewing);
  if (viewing) renderProjectView(viewing);
}

projectEl.chip.addEventListener('click', () => {
  if (projectEl.chip.dataset.projectId) openProject(projectEl.chip.dataset.projectId);
});

// ---------- Create / open / rename ----------

async function createProject({ moveChatId = null } = {}) {
  try {
    const project = await api.projects.create('New project');
    state.projects.push(project);
    expandedProjects.add(project.id);
    if (moveChatId) moveChatToProject(moveChatId, project.id);
    openProject(project.id, { renameName: true });
  } catch (err) {
    toast.error(cleanError(err));
  }
}

function openProject(id, { renameName = false } = {}) {
  if (!projectById(id)) return;
  if (state.editingMessage) cancelMessageEdit();
  state.projectView = id;
  renderChatList();
  if (renameName) requestAnimationFrame(() => {
    const input = projectEl.view.querySelector('.project-name');
    input?.focus();
    input?.select();
  });
}

function beginProjectRename(projectId) {
  const project = projectById(projectId);
  if (!project) return;
  state.renamingProject = { projectId, draft: project.name };
  renderProjects();
  requestAnimationFrame(() => {
    const input = projectEl.list.querySelector('.chat-rename-input');
    input?.focus();
    input?.select();
  });
}

function cancelProjectRename() {
  if (!state.renamingProject) return;
  state.renamingProject = null;
  renderProjects();
}

async function commitProjectRename(projectId, { showInvalid } = {}) {
  const rename = state.renamingProject;
  if (!rename || rename.projectId !== projectId) return;
  const name = rename.draft.trim().replace(/\s+/g, ' ').slice(0, PROJECT_NAME_MAX);
  if (!name) {
    if (!showInvalid) return cancelProjectRename();
    const input = projectEl.list.querySelector('.chat-rename-input');
    input?.classList.add('invalid');
    input?.focus();
    return;
  }
  state.renamingProject = null;
  await saveProject(projectId, { name });
  toast.success('Project renamed');
}

// Applies a change locally right away, then reconciles with what main stored
async function saveProject(id, changes) {
  const project = projectById(id);
  if (!project) return null;
  Object.assign(project, changes);
  try {
    const saved = await api.projects.update(id, changes);
    // Only the timestamp comes back into the local copy: a slower answer to an earlier edit must
    // not overwrite a newer one that was already applied
    if (saved) project.updatedAt = saved.updatedAt;
  } catch (err) {
    toast.error(cleanError(err));
  }
  renderChatList();
  return project;
}

// ---------- Moving chats ----------

function moveChatToProject(chatId, projectId) {
  const chat = state.chats.find(c => c.id === chatId);
  if (!chat || (chat.projectId || null) === (projectId || null)) return;
  if (projectId) chat.projectId = projectId;
  else delete chat.projectId;
  persistChats();
  if (projectId) expandedProjects.add(projectId);
  renderChatList();
  const target = projectById(projectId);
  toast.success(target ? `Moved to “${target.name}”` : 'Removed from project');
}

// ---------- Delete ----------

async function deleteProject(id) {
  const project = projectById(id);
  if (!project) return;
  const chats = chatsIn(id);
  const choice = await askChoice({
    title: `Delete “${project.name}”?`,
    body: chats.length
      ? `Its files, search index and project memory are deleted for good. It has ${chats.length} chat${chats.length === 1 ? '' : 's'}: delete them too, or keep them as regular chats.`
      : 'Its files, search index and project memory are deleted for good.',
    choices: chats.length
      ? [{ label: `Delete project and ${chats.length} chat${chats.length === 1 ? '' : 's'}`, value: 'chats', danger: true }, { label: 'Delete project, keep chats', value: 'keep', primary: true }]
      : [{ label: 'Delete project', value: 'keep', danger: true }]
  });
  if (!choice) return;

  if (state.streaming && chats.some(c => c.id === state.streaming.chatId)) stopStreaming();
  if (state.editingMessage && chats.some(c => c.id === state.editingMessage.chatId)) state.editingMessage = null;
  const order = state.projects.findIndex(p => p.id === id);
  let removed;
  try {
    removed = await api.projects.remove(id);
  } catch (err) {
    return toast.error(cleanError(err));
  }
  if (!removed) return;
  state.projects.splice(order, 1);
  expandedProjects.delete(id);
  if (state.renamingProject?.projectId === id) state.renamingProject = null;
  if (state.projectView === id) state.projectView = null;
  if (state.newChatProjectId === id) state.newChatProjectId = null;

  const deletedChats = choice === 'chats' ? chats : [];
  const keptChats = choice === 'keep' ? chats : [];
  if (deletedChats.length) {
    const ids = new Set(deletedChats.map(c => c.id));
    state.chats = state.chats.filter(c => !ids.has(c.id));
    if (ids.has(state.activeId)) state.activeId = null;
  }
  for (const chat of keptChats) delete chat.projectId;
  persistChats();
  renderThread();
  renderChatList();

  // Undo brings back the row, the folder and the chats together; the folder is only really
  // deleted once the toast goes away unused
  toast.undo(`Deleted project “${project.name.slice(0, 40)}”`, {
    ms: 10000,
    action: {
      label: 'Undo',
      run: async () => {
        try {
          await api.projects.restore(removed);
        } catch (err) {
          return toast.error(cleanError(err));
        }
        const { order: _order, ...row } = removed;
        state.projects.splice(Math.min(removed.order, state.projects.length), 0, row);
        for (const chat of deletedChats) state.chats.push(chat);
        for (const chat of keptChats) chat.projectId = id;
        persistChats();
        renderChatList();
      }
    },
    onExpire: () => api.projects.purge(id).catch(() => {})
  });
}

// ---------- Project page ----------

let instructionsTimer = 0;

function renderProjectView(project) {
  // Rebuilding while someone types would steal focus, so only rebuild when the project changed
  const keep = projectEl.view.dataset.projectId === project.id && projectEl.view.contains(document.activeElement);
  if (keep) {
    // A focused field can still be out of date (renamed from the sidebar meanwhile)
    const field = projectEl.view.querySelector('.project-name');
    if (field && !field.dataset.dirty) field.value = project.name;
    return updateProjectChatList(project);
  }
  projectEl.view.dataset.projectId = project.id;
  projectEl.view.innerHTML = '';

  const inner = document.createElement('div');
  inner.className = 'project-inner';

  const head = document.createElement('div');
  head.className = 'project-title-row';
  const name = document.createElement('input');
  name.className = 'project-name';
  name.value = project.name;
  name.maxLength = PROJECT_NAME_MAX;
  name.setAttribute('aria-label', 'Project name');
  const commitName = () => {
    // Untouched fields never save, so a stale value can't overwrite a newer name
    if (!name.dataset.dirty) return;
    delete name.dataset.dirty;
    const next = name.value.trim().replace(/\s+/g, ' ');
    if (!next) { name.value = project.name; return; }
    if (next !== project.name) saveProject(project.id, { name: next });
  };
  name.addEventListener('input', () => { name.dataset.dirty = '1'; });
  name.addEventListener('blur', commitName);
  name.addEventListener('keydown', e => {
    if (e.key === 'Enter') name.blur();
    else if (e.key === 'Escape') { delete name.dataset.dirty; name.value = project.name; name.blur(); }
  });
  const del = document.createElement('button');
  del.className = 'ghost-btn danger project-delete';
  del.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 2.5h5M2.5 4.5h11M4 4.5l.6 8a1.2 1.2 0 0 0 1.2 1.1h4.4a1.2 1.2 0 0 0 1.2-1.1l.6-8M6.6 7v4M9.4 7v4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Delete</span>';
  del.title = 'Delete this project';
  del.addEventListener('click', () => deleteProject(project.id));
  head.append(name, del);

  const meta = document.createElement('p');
  meta.className = 'project-meta';
  meta.id = 'project-meta';
  meta.textContent = projectMetaText(project);

  const start = document.createElement('button');
  start.className = 'primary-btn project-start';
  start.innerHTML = '<span aria-hidden="true">＋</span> New chat in this project';
  start.addEventListener('click', () => newChatInProject(project.id));

  const hero = document.createElement('div');
  hero.className = 'project-hero';
  hero.append(head, meta, start);

  inner.append(hero, instructionsSection(project));
  for (const build of projectSections) {
    const section = build(project);
    if (section) inner.appendChild(section);
  }
  const chatsSection = document.createElement('section');
  chatsSection.className = 'project-card';
  chatsSection.id = 'project-chats-section';
  inner.appendChild(chatsSection);
  projectEl.view.appendChild(inner);
  updateProjectChatList(project);
}

// Later features (files, memory) add their own cards to the page
const projectSections = [];

function projectCard(title, hint) {
  const card = document.createElement('section');
  card.className = 'project-card';
  card.appendChild(projectCardHead(title, hint));
  return card;
}

function projectCardHead(title, hint) {
  const head = document.createElement('header');
  head.className = 'project-card-head';
  const h = document.createElement('h3');
  h.textContent = title;
  head.appendChild(h);
  if (hint) {
    const p = document.createElement('p');
    p.className = 'project-hint';
    p.textContent = hint;
    head.appendChild(p);
  }
  return head;
}

// "3 chats · updated today": the line under a project's name
function projectMetaText(project) {
  const chats = chatsIn(project.id);
  const bits = [`${chats.length} chat${chats.length === 1 ? '' : 's'}`];
  if (project.updatedAt) bits.push(`updated ${relativeDay(project.updatedAt)}`);
  return bits.join(' · ');
}

function relativeDay(time) {
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(time).setHours(0, 0, 0, 0)) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

function projectSwitch(label, description, checked, onChange) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  const text = document.createElement('div');
  text.className = 'setting-label';
  const strong = document.createElement('strong');
  strong.textContent = label;
  const span = document.createElement('span');
  span.textContent = description;
  text.append(strong, span);
  const button = document.createElement('button');
  button.className = 'switch';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-checked', String(checked));
  button.appendChild(document.createElement('span'));
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  row.append(text, button);
  return row;
}

function instructionsSection(project) {
  const card = projectCard('Instructions', 'Added on top of your general instructions for every chat in this project. If they conflict, these win.');
  const box = document.createElement('textarea');
  box.className = 'project-instructions';
  box.rows = 6;
  box.maxLength = PROJECT_INSTRUCTIONS_MAX;
  box.placeholder = 'e.g. You are helping me write my thesis on coastal erosion. Use British spelling and cite sources.';
  box.value = project.instructions || '';
  box.setAttribute('aria-label', 'Project instructions');
  const counter = document.createElement('div');
  counter.className = 'project-count-note';
  const update = () => { counter.textContent = `${box.value.length} / ${PROJECT_INSTRUCTIONS_MAX}`; };
  update();
  box.addEventListener('input', () => {
    update();
    clearTimeout(instructionsTimer);
    instructionsTimer = setTimeout(() => saveProject(project.id, { instructions: box.value }), 500);
  });
  box.addEventListener('blur', () => {
    clearTimeout(instructionsTimer);
    if (box.value !== project.instructions) saveProject(project.id, { instructions: box.value });
  });
  card.append(box, counter, projectSwitch(
    'Ignore my general instructions here',
    'Chats in this project use only the project instructions, not the system prompt from Settings.',
    !!project.overrideGlobal,
    on => saveProject(project.id, { overrideGlobal: on })
  ));
  return card;
}

function updateProjectChatList(project) {
  const card = document.getElementById('project-chats-section');
  if (!card) return;
  card.innerHTML = '';
  const chats = chatsIn(project.id);
  card.appendChild(projectCardHead('Chats', chats.length ? '' : 'Everything you discuss in this project lives here.'));
  const meta = document.getElementById('project-meta');
  if (meta) meta.textContent = projectMetaText(project);
  if (!chats.length) {
    card.appendChild(projectEmpty(
      '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h9A2.5 2.5 0 0 1 17 5.5v6a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3A2.5 2.5 0 0 1 3 11.5v-6Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
      'No chats yet',
      'Start one above, or drag a chat from the sidebar onto this project.'
    ));
    return;
  }
  const list = document.createElement('div');
  list.className = 'project-chat-list';
  for (const chat of chats) {
    const row = document.createElement('div');
    row.className = 'project-chat-row';
    const open = document.createElement('button');
    open.className = 'project-chat-open';
    const text = document.createElement('span');
    text.className = 'project-chat-text';
    const title = document.createElement('span');
    title.className = 'project-chat-title';
    title.textContent = chat.title;
    const count = Math.ceil((chat.messages?.length || 0) / 2);
    const when = document.createElement('small');
    when.textContent = `${count} message${count === 1 ? '' : 's'} · ${relativeDay(chat.updatedAt)}`;
    text.append(title, when);
    open.appendChild(text);
    open.addEventListener('click', () => openChat(chat.id));
    const remove = document.createElement('button');
    remove.className = 'project-chat-remove';
    remove.textContent = 'Remove';
    remove.title = 'Take this chat out of the project (it stays in your chats)';
    remove.addEventListener('click', () => moveChatToProject(chat.id, null));
    row.append(open, remove);
    list.appendChild(row);
  }
  card.appendChild(list);
}

// A friendly empty state: a small line icon, a title and one sentence
function projectEmpty(iconPaths, title, text) {
  const box = document.createElement('div');
  box.className = 'project-empty';
  const icon = document.createElement('span');
  icon.className = 'project-empty-icon';
  icon.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${iconPaths}</svg>`;
  const strong = document.createElement('strong');
  strong.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  box.append(icon, strong, p);
  return box;
}

function newChatInProject(id) {
  if (!projectById(id)) return;
  newChat();
  state.newChatProjectId = id;
  expandedProjects.add(id);
  renderChatList();
}

projectEl.add.addEventListener('click', () => createProject());
