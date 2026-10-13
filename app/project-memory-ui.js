// What a project remembers (renderer): whether its chats draw on its earlier chats, and the notes it
// keeps for itself. A plain <script> sharing globals with renderer.js and projects.js.
// Both switches are per project. Notes are opt-in, like your general memory: nothing is learned in a
// project until you turn them on.

function memorySection(project) {
  const card = projectCard('What this project remembers');

  card.appendChild(projectSwitch(
    'Use earlier chats in this project',
    'New chats here can draw on what was said in this project’s other chats. They’re searched in this browser; only the passages that match are sent to Groq with your message.',
    project.pastChats !== false,
    on => saveProject(project.id, { pastChats: on })
  ));

  const notesBox = document.createElement('div');
  notesBox.className = 'project-notes';
  card.append(
    projectSwitch(
      'Keep notes about this project',
      'Boltchat can note decisions, terms and preferences from this project’s chats, and uses them in its later chats. You can also add and edit notes yourself. They stay in this browser.',
      !!project.memory,
      on => {
        saveProject(project.id, { memory: on });
        notesBox.hidden = !on && !notesBox.dataset.has;
      }
    ),
    notesBox
  );
  renderProjectNotes(project.id, notesBox);
  return card;
}
projectSections.push(memorySection);

async function renderProjectNotes(projectId, box) {
  let notes = [];
  try {
    notes = await api.projectMemory.list(projectId);
  } catch (err) {
    return toast.error(cleanError(err));
  }
  box.innerHTML = '';
  box.dataset.has = notes.length ? '1' : '';
  box.dataset.projectId = projectId;
  box.hidden = !notes.length && !projectById(projectId)?.memory;

  const list = document.createElement('div');
  list.className = 'project-note-list';
  for (const note of notes) {
    const row = document.createElement('div');
    row.className = 'project-note';
    const text = document.createElement('button');
    text.type = 'button';
    text.className = 'project-note-text';
    text.textContent = note.text;
    text.title = 'Click to edit';
    text.addEventListener('click', () => editProjectNote(projectId, note, row, text));
    const del = document.createElement('button');
    del.className = 'chat-item-action';
    del.textContent = '✕';
    del.title = 'Delete note';
    del.setAttribute('aria-label', `Delete note: ${note.text}`);
    del.addEventListener('click', () => api.projectMemory.remove(projectId, note.id).catch(err => toast.error(cleanError(err))));
    row.append(text, del);
    list.appendChild(row);
  }
  if (!notes.length) {
    const none = document.createElement('p');
    none.className = 'project-hint';
    none.textContent = 'No notes yet.';
    list.appendChild(none);
  }

  const form = document.createElement('form');
  form.className = 'project-note-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Add a note…';
  input.maxLength = 500;
  input.setAttribute('aria-label', 'Add a note about this project');
  const add = document.createElement('button');
  add.className = 'ghost-btn small';
  add.type = 'submit';
  add.textContent = 'Add';
  form.append(input, add);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    try {
      await api.projectMemory.add(projectId, value);
      input.value = '';
    } catch (err) {
      toast.error(cleanError(err));
    }
  });
  box.append(list, form);
  if (notes.length > 1) {
    const clear = document.createElement('button');
    clear.className = 'ghost-btn small danger';
    clear.textContent = 'Clear all notes';
    clear.addEventListener('click', async () => {
      if (clear.dataset.confirm) return api.projectMemory.clear(projectId);
      clear.dataset.confirm = '1';
      clear.textContent = 'Click again to clear';
      setTimeout(() => { delete clear.dataset.confirm; clear.textContent = 'Clear all notes'; }, 3000);
    });
    box.appendChild(clear);
  }
}

// Notes change while chatting (learned or saved by the model), so the page follows
api.projectMemory.onChanged(({ projectId }) => {
  const box = document.querySelector(`.project-notes[data-project-id="${projectId}"]`);
  if (box && state.projectView === projectId) renderProjectNotes(projectId, box);
});

// Click a note to change its wording in place: Enter saves, Escape leaves it alone
function editProjectNote(projectId, note, row, textButton) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'project-note-edit';
  input.value = note.text;
  input.maxLength = 500;
  input.setAttribute('aria-label', 'Edit note');
  let finished = false;
  const finish = async save => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (save && value && value !== note.text) {
      try {
        await api.projectMemory.update(projectId, note.id, value);
        return; // the change event redraws the list
      } catch (err) {
        toast.error(cleanError(err));
      }
    }
    input.replaceWith(textButton);
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  textButton.replaceWith(input);
  input.focus();
  input.select();
}
