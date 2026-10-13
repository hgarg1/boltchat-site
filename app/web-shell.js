// What the web chat adds around the page it shares with the Windows app (loaded last):
// backup, restore and erase in Settings → About, warnings about this browser's storage, and a
// sidebar that gets out of the way on a phone. `toast` is renderer.js's; `boltchatWeb` is engine/engine.js's.
(() => {
  const web = window.boltchatWeb;
  const $ = id => document.getElementById(id);
  const app = document.querySelector('.app');
  const megabytes = bytes => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

  // Inside chat.html this page is in a frame. Focusing a field (the message box, on load) would make the
  // browser scroll the outer page to it, so focus never scrolls here; this page has nothing to scroll to.
  if (window.top !== window) {
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options) { focus.call(this, { ...options, preventScroll: true }); };
  }

  // --- Storage ---

  async function describeStorage() {
    const s = await web.storage.status();
    $('web-storage-note').textContent = !s.available
      ? 'This browser is not storing anything: it will be gone when the tab closes'
      : `Kept in this browser only · ${megabytes(s.used)}${s.persistent ? ' · protected from automatic clean-up' : ''}`;
  }

  web.ready.then(({ stored }) => {
    if (!stored) toast.warn('This browser is blocking storage (a private window?), so chats will be gone when you close the tab.', { ms: 12000 });
    describeStorage();
  }).catch(() => {});

  let warned = 0;
  web.storage.onSaveError(err => {
    if (Date.now() - warned < 60000) return;
    warned = Date.now();
    toast.error(/quota/i.test(`${err?.name} ${err?.message}`)
      ? 'This browser’s storage for Boltchat is full, so recent changes aren’t saved. Download a backup, then delete some chats or project files.'
      : 'Could not save to this browser’s storage. Download a backup from Settings → About to be safe.', { ms: 12000 });
  });

  $('open-settings').addEventListener('click', () => describeStorage().catch(() => {}));

  // Once there is a key worth keeping, ask the browser not to clear this site when the disk is low
  $('key-form').addEventListener('submit', () => { web.storage.keepSafe().then(describeStorage).catch(() => {}); });

  $('web-backup').addEventListener('click', async () => {
    const button = $('web-backup');
    button.disabled = true;
    try {
      const blob = await web.storage.exportBackup();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `boltchat-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      toast.success('Backup downloaded. It holds your chats, memories, projects and settings, but not your API key.');
    } catch (err) {
      toast.error(`Could not make a backup: ${err.message}`);
    } finally {
      button.disabled = false;
    }
  });

  $('web-restore').addEventListener('click', () => $('web-restore-file').click());
  $('web-restore-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('Restore this backup?\n\nIt replaces the chats, memories, projects and settings in this browser. Your saved API key stays.')) return;
    try {
      await web.storage.importBackup(file);
      location.reload();
    } catch (err) {
      toast.error(`Could not restore: ${err.message}`);
    }
  });

  $('web-erase').addEventListener('click', async () => {
    if (!confirm('Erase everything Boltchat keeps in this browser?\n\nChats, memories, projects, settings and your saved API key are deleted from this browser. This cannot be undone. Nothing is stored anywhere else, so download a backup first if you want one.')) return;
    await web.storage.erase();
    location.reload();
  });

  // --- Small screens: the sidebar covers the chat, so it starts closed and closes after a choice ---

  const narrow = matchMedia('(max-width: 760px)');
  if (narrow.matches) app.classList.add('sidebar-hidden');
  $('sidebar').addEventListener('click', e => {
    if (narrow.matches && e.target.closest('.chat-item, .new-chat, .project-row, #open-settings') && !e.target.closest('.chat-item-action')) app.classList.add('sidebar-hidden');
  });
  document.querySelector('.main').addEventListener('click', e => {
    if (narrow.matches && !app.classList.contains('sidebar-hidden') && !e.target.closest('#toggle-sidebar')) app.classList.add('sidebar-hidden');
  }, true);

  // --- Offline: keep the app's own files, so it opens (and old chats can be read) without a connection ---

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
