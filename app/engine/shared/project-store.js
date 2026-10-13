// Projects on disk. A project groups chats, files and instructions.
//   projects.json                    the list of projects (this file owns it)
//   projects/<id>/                   files, search index and memory for one project
//   projects/.trash/<id>/            a deleted project, kept until its undo expires
// Chats are NOT stored here: the renderer owns conversations.json and tags each chat with a
// projectId, so chat-side changes (moving, deleting) always go through the renderer.
// Shared with the Windows app, where this file is src/project-store.js.
Boltchat.define('project-store', function (require, module, exports) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');

  const NAME_MAX = 60;
  const INSTRUCTIONS_MAX = 8000;
  const DEFAULTS = { instructions: '', overrideGlobal: false, pastChats: true, memory: false };

  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

  function createProjectStore(root) {
    const listFile = path.join(root, 'projects.json');
    const folder = id => path.join(root, 'projects', id);
    const trash = id => path.join(root, 'projects', '.trash', id);
    const safeId = id => typeof id === 'string' && /^[a-z0-9]{6,40}$/.test(id);

    function read() {
      try {
        const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
        return Array.isArray(list) ? list.filter(p => p && safeId(p.id)) : [];
      } catch {
        return [];
      }
    }

    function write(list) {
      fs.mkdirSync(root, { recursive: true });
      const tmp = `${listFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list));
      fs.renameSync(tmp, listFile);
    }

    const find = (list, id) => list.find(p => p.id === id);

    function list() {
      return read();
    }

    function create(name) {
      const projects = read();
      const now = Date.now();
      const project = {
        id: `${now.toString(36)}${crypto.randomBytes(4).toString('hex')}`,
        name: clean(name).slice(0, NAME_MAX) || 'New project',
        ...DEFAULTS,
        createdAt: now,
        updatedAt: now
      };
      projects.push(project);
      fs.mkdirSync(folder(project.id), { recursive: true });
      write(projects);
      return project;
    }

    // Only known fields are accepted, so a renderer bug can't write arbitrary keys
    function update(id, changes = {}) {
      const projects = read();
      const project = find(projects, id);
      if (!project) return null;
      if ('name' in changes) {
        const name = clean(changes.name).slice(0, NAME_MAX);
        if (name) project.name = name;
      }
      if ('instructions' in changes) project.instructions = String(changes.instructions ?? '').slice(0, INSTRUCTIONS_MAX);
      for (const key of ['overrideGlobal', 'pastChats', 'memory']) {
        if (key in changes) project[key] = !!changes[key];
      }
      project.updatedAt = Date.now();
      write(projects);
      return project;
    }

    // Soft delete: the row leaves the list and the folder moves to the trash, so undo can restore both
    function remove(id) {
      const projects = read();
      const project = find(projects, id);
      if (!project) return null;
      write(projects.filter(p => p.id !== id));
      fs.mkdirSync(path.dirname(trash(id)), { recursive: true });
      fs.rmSync(trash(id), { recursive: true, force: true });
      if (fs.existsSync(folder(id))) fs.renameSync(folder(id), trash(id));
      return { ...project, order: projects.indexOf(project) };
    }

    function restore(project) {
      if (!project || !safeId(project.id)) return null;
      const { order, ...row } = project;
      const projects = read().filter(p => p.id !== row.id);
      projects.splice(Math.min(Number.isInteger(order) ? order : projects.length, projects.length), 0, row);
      write(projects);
      fs.mkdirSync(path.dirname(folder(row.id)), { recursive: true });
      if (fs.existsSync(trash(row.id))) fs.renameSync(trash(row.id), folder(row.id));
      else fs.mkdirSync(folder(row.id), { recursive: true });
      return row;
    }

    // Called once the undo window closes, and for anything left over from a previous run
    function purge(id) {
      if (safeId(id)) fs.rmSync(trash(id), { recursive: true, force: true });
    }

    function purgeAllTrash() {
      fs.rmSync(path.join(root, 'projects', '.trash'), { recursive: true, force: true });
    }

    return { list, create, update, remove, restore, purge, purgeAllTrash, folder, get: id => find(read(), id) || null };
  }

  module.exports = { createProjectStore, NAME_MAX, INSTRUCTIONS_MAX };
});
