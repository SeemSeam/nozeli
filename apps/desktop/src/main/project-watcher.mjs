import {watch as watchDirectory} from 'node:fs';
import {lstat} from 'node:fs/promises';
import path from 'node:path';

const MAX_PENDING_PATHS = 1024;

function failure(code, message) {
  return Object.assign(new Error(message), {code});
}

function relativeParts(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw failure('INVALID_PATH', 'Watch directory must be a project-relative path');
  }
  if (value === '') return [];
  const parts = value.split('/');
  if (parts.some(part => !part || part.startsWith('.') || part === 'node_modules' || part.includes(':'))) {
    throw failure('INVALID_PATH', 'Watch directory contains a forbidden component');
  }
  return parts;
}

async function directoryIdentity(root, parts) {
  let absolute = root;
  let stat;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) absolute = path.join(absolute, parts[index]);
    stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw failure('SYMLINK', 'Watching symbolic links is not allowed');
    if (!stat.isDirectory()) throw failure('NOT_DIRECTORY', 'Watch target must be a directory');
  }
  return {absolute, dev: stat.dev, ino: stat.ino};
}

/**
 * Explicit, nonrecursive directory subscriptions, shared across no projects.
 * watch() is idempotent for a project/directory and returns its subscription status.
 * Paths in changes are project-relative; [] invalidates the entire parent directory.
 * Capacity exhaustion reports overflow instead of silently omitting a subscription.
 * onError receives {projectId,parentRelPath,code,message}; setup failures also reject.
 * No file contents are read. Directory metadata is checked when subscribing only;
 * new/replaced directories are followed only by a subsequent explicit watch().
 * close() is terminal. All handles and debounce timers are unref'ed.
 */
export class ProjectWatcher {
  constructor({onChange, onError = () => {}, debounceMs = 120, maxDirectories = 2048} = {}) {
    if (typeof onChange !== 'function' || typeof onError !== 'function') throw new TypeError('Watcher callbacks must be functions');
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > 2 ** 31 - 1) throw new RangeError('Invalid debounceMs');
    if (!Number.isInteger(maxDirectories) || maxDirectories < 1) throw new RangeError('Invalid maxDirectories');
    this.onChange = onChange;
    this.onError = onError;
    this.debounceMs = debounceMs;
    this.maxDirectories = maxDirectories;
    this.projects = new Map();
    this.pending = new Map();
    this.directoryCount = 0;
    this.closed = false;
  }

  async watch(projectId, root, parentRelPath = '') {
    try {
      if (this.closed) throw failure('WATCH_CLOSED', 'Project watcher is closed');
      if (typeof projectId !== 'string' || !projectId) throw failure('INVALID_PROJECT', 'Project id is required');
      if (typeof root !== 'string' || root.includes('\0') || !path.isAbsolute(root)) throw failure('INVALID_PATH', 'Project root must be absolute');
      const parts = relativeParts(parentRelPath);
      root = path.resolve(root);
      let project = this.projects.get(projectId);
      if (project && project.root !== root) throw failure('ROOT_MISMATCH', 'Unwatch a project before changing its root');
      if (!project) {
        project = {root, directories: new Map()};
        this.projects.set(projectId, project);
      }
      const existing = project.directories.get(parentRelPath);
      if (existing) {
        const result = await existing.ready;
        let identity;
        try {
          identity = await directoryIdentity(root, parts);
        } catch (error) {
          if (project.directories.get(parentRelPath) === existing) {
            existing.active = false;
            existing.handle?.close();
            project.directories.delete(parentRelPath);
            this.directoryCount--;
          }
          throw error;
        }
        if (!existing.active) throw failure('WATCH_CANCELLED', 'Watch subscription was cancelled');
        if (identity.dev === existing.identity.dev && identity.ino === existing.identity.ino) return result;
        if (project.directories.get(parentRelPath) !== existing) return this.watch(projectId, root, parentRelPath);
        existing.active = false;
        existing.handle.close();
        project.directories.delete(parentRelPath);
        this.directoryCount--;
      }
      if (this.directoryCount >= this.maxDirectories) {
        this.queue(projectId, parentRelPath, null, true);
        return {projectId, parentRelPath, watching: false, overflow: true};
      }
      const entry = {handle: null, active: true, ready: null};
      project.directories.set(parentRelPath, entry);
      this.directoryCount++;
      entry.ready = this.subscribe(projectId, project, parentRelPath, parts, entry);
      return await entry.ready;
    } catch (error) {
      this.onError({projectId, parentRelPath, code: error.code || 'WATCH_ERROR', message: error.message});
      throw error;
    }
  }

  async subscribe(projectId, project, parentRelPath, parts, entry) {
    const release = () => {
      entry.handle?.close();
      if (project.directories.get(parentRelPath) === entry) {
        project.directories.delete(parentRelPath);
        this.directoryCount--;
      }
      entry.active = false;
    };
    try {
      const before = await directoryIdentity(project.root, parts);
      if (!entry.active) throw failure('WATCH_CANCELLED', 'Watch subscription was cancelled');
      entry.handle = watchDirectory(before.absolute, {recursive: false, persistent: false}, (_event, filename) => {
        if (!entry.active) return;
        if (!entry.installed) { entry.dirty = true; return; }
        this.queue(projectId, parentRelPath, filename);
      });
      entry.handle.unref();
      entry.handle.on('error', error => {
        if (!entry.active) return;
        release();
        this.queue(projectId, parentRelPath, null, true);
        this.onError({projectId, parentRelPath, code: error.code || 'WATCH_ERROR', message: error.message});
      });
      const after = await directoryIdentity(project.root, parts);
      if (!entry.active) throw failure('WATCH_CANCELLED', 'Watch subscription was cancelled');
      if (before.dev !== after.dev || before.ino !== after.ino) throw failure('WATCH_CHANGED', 'Watch directory changed during subscription');
      entry.installed = true;
      entry.identity = after;
      if (entry.dirty) this.queue(projectId, parentRelPath, null);
      return {projectId, parentRelPath, watching: true, overflow: false};
    } catch (error) {
      release();
      throw error;
    }
  }

  queue(projectId, parentRelPath, filename, overflow = false) {
    if (this.closed || !this.projects.has(projectId)) return;
    const key = JSON.stringify([projectId, parentRelPath]);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = {projectId, parentRelPath, paths: new Set(), invalidated: false, overflow: false, timer: null};
      this.pending.set(key, pending);
    }
    pending.overflow ||= overflow;
    const name = filename == null ? null : String(filename);
    // Nonrecursive events are direct children only. Never forward backend paths.
    if (name == null || !name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
      pending.invalidated = true;
      pending.paths.clear();
    } else if (!pending.invalidated) {
      pending.paths.add(parentRelPath ? `${parentRelPath}/${name}` : name);
      if (pending.paths.size > MAX_PENDING_PATHS) {
        pending.paths.clear();
        pending.invalidated = true;
        pending.overflow = true;
      }
    }
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.pending.delete(key);
      const event = {projectId, parentRelPath, paths: [...pending.paths].sort()};
      if (pending.overflow) event.overflow = true;
      this.onChange(event);
    }, this.debounceMs);
    pending.timer.unref();
  }

  unwatchProject(projectId) {
    const project = this.projects.get(projectId);
    if (project) {
      for (const entry of project.directories.values()) {
        entry.active = false;
        entry.handle?.close();
        this.directoryCount--;
      }
      project.directories.clear();
      this.projects.delete(projectId);
    }
    for (const [key, pending] of this.pending) {
      if (pending.projectId !== projectId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(key);
    }
  }

  close() {
    this.closed = true;
    for (const projectId of this.projects.keys()) this.unwatchProject(projectId);
  }
}
