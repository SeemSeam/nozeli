import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectWatcher } from './project-watcher.mjs';

const skipped = new Set(['node_modules', 'target', 'dist', 'build', 'vendor']);
const generated = /\.(?:aux|log|fls|fdb_latexmk|synctex(?:\.gz)?|xdv|toc|out|blg|bcf|run\.xml)$/i;
export const ignoredTexEntry = name => name.startsWith('.') || skipped.has(name) || generated.test(name);

// Native recursive fs.watch traverses synchronously, including excluded trees.
// Subscribe to each eligible directory before asynchronously discovering children.
// ProjectWatcher supplies nonrecursive handles, identity checks and cancellation.
export class TexSourceWatcher {
  constructor(root, onChange, { createWatcher = options => new ProjectWatcher(options), filesystem = fs, debounceMs = 200 } = {}) {
    this.root = path.resolve(root);
    this.onChange = onChange;
    this.createWatcher = createWatcher;
    this.fs = filesystem;
    this.debounceMs = debounceMs;
    this.directories = new Map();
    this.pending = new Set(['']);
    this.closed = false;
    this.timer = null;
    this.running = null;
    this.ready = this.drain();
  }

  changed({ parentRelPath, paths }) {
    if (this.closed) return;
    if (paths.length && paths.every(file => ignoredTexEntry(path.posix.basename(file)))) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.onChange();
    }, this.debounceMs);
    this.timer.unref?.();
    this.pending.add(parentRelPath);
    void this.drain();
  }

  async drain() {
    if (this.running) return this.running;
    this.running = (async () => {
      while (!this.closed && this.pending.size) {
        const rel = this.pending.values().next().value;
        this.pending.delete(rel);
        await this.scan(rel);
      }
    })();
    try { await this.running; }
    finally { this.running = null; }
  }

  remove(rel) {
    for (const [key, watcher] of this.directories) {
      if (key === rel || !rel || key.startsWith(rel + '/')) {
        watcher.close();
        this.directories.delete(key);
        this.pending.delete(key);
      }
    }
  }

  async scan(rel) {
    if (this.closed) return;
    let directory;
    try {
      // Check the complete path, not just its final component: an ancestor may
      // have been replaced by a symlink since the parent was enumerated.
      const absolute = path.join(this.root, rel);
      if (await this.fs.realpath(absolute) !== absolute) { this.remove(rel); return; }
      if (this.closed) return;
      let watcher = this.directories.get(rel);
      if (!watcher) {
        watcher = this.createWatcher({ onChange: event => this.changed(event), debounceMs: 0, maxDirectories: 1 });
        this.directories.set(rel, watcher);
      }
      const status = await watcher.watch('tex', this.root, rel);
      if (this.closed || this.directories.get(rel) !== watcher) return;
      if (!status.watching) { this.remove(rel); return; }
      // Recheck after subscription before opening; never enumerate a symlink.
      if (await this.fs.realpath(absolute) !== absolute) { this.remove(rel); return; }
      if (this.closed) return;
      directory = await this.fs.opendir(absolute);
      const children = new Set();
      for await (const entry of directory) {
        if (this.closed) break;
        if (ignoredTexEntry(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const child = rel ? rel + '/' + entry.name : entry.name;
        children.add(child);
        // Existing children are revalidated too: rename can replace an inode.
        this.pending.add(child);
      }
      directory = null; // for-await closes its directory, including early exit.
      if (this.closed) return;
      for (const child of this.directories.keys()) {
        if (child && path.posix.dirname(child) === (rel || '.') && !children.has(child)) this.remove(child);
      }
    } catch {
      // Deleted/replaced/unreadable directories must not retain stale handles.
      this.remove(rel);
    } finally {
      if (directory) await directory.close().catch(() => {});
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.pending.clear();
    this.remove('');
  }
}
