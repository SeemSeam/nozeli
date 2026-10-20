import { inferTex } from './tex-inference.mjs';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { normalizedTexText, parseSynctexResults, syncSourcePath } from './tex-synctex.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const engines = ['xelatex', 'pdflatex', 'lualatex', 'tectonic'];
const skipped = new Set(['node_modules', 'target', 'dist', 'build', 'vendor']);
const generated = /\.(?:aux|log|fls|fdb_latexmk|synctex(?:\.gz)?|xdv|toc|out|blg|bcf|run\.xml)$/i;
const MAX_BYTES = 64 * 1024 * 1024;
async function json(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function atomic(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const temp = file + '.' + randomUUID(); await fs.writeFile(temp, JSON.stringify(value, null, 2)); await fs.rename(temp, file); }
function relPath(value) { if (typeof value !== 'string' || !value || path.posix.isAbsolute(value) || value.includes('\\') || value.split('/').some(p => !p || p === '..' || p === '.' || p.startsWith('.')) || /[\x00-\x1f:]/.test(value)) throw fail('TEX_PATH', 'TeX 文件路径必须位于项目内，且不能是隐藏文件。'); return value; }

async function walk(root, rel = '', result = [], discover = false) {
  for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skipped.has(entry.name) || generated.test(entry.name)) continue;
    const file = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink() && discover) continue;
    if (entry.isSymbolicLink()) throw fail('TEX_SYMLINK', `编译快照不跟随符号链接：${file}`);
    if (entry.isDirectory()) await walk(root, file, result, discover);
    else if (entry.isFile() && (!discover || /\.tex$/i.test(file))) { result.push(file); if (result.length > 3000) throw fail('TEX_LIMIT', '项目超过 3000 个编译资源，请为论文选择独立项目目录。'); }
  }
  return result;
}
async function diskUsage(dir) {
  let bytes = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += await diskUsage(file);
    else if (entry.isFile()) bytes += (await fs.stat(file)).size;
  }
  return bytes;
}
async function executable(name) {
  const home = os.homedir();
  const platformRoot = process.platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')) : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.local', 'share');
  const managed = path.join(platformRoot, 'nozeli', 'toolchains', '.TinyTeX', 'bin');
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  try { for (const entry of await fs.readdir(managed, { withFileTypes: true })) if (entry.isDirectory()) directories.push(path.join(managed, entry.name)); } catch {}
  directories.push(path.join(home, '.local', 'bin'));
  for (const directory of directories) for (const suffix of process.platform === 'win32' ? ['.exe', '.bat', '.cmd', ''] : ['']) {
    // Batch launchers require a shell; this adapter intentionally supports native executables only.
    if (suffix === '.bat' || suffix === '.cmd') continue;
    const file = path.join(directory, name + suffix);
    try { await fs.access(file, process.platform === 'win32' ? 0 : 1); return file; } catch {}
  }
  return null;
}
async function run(exe, args, options = {}, job = {}) {
  return new Promise((resolve, reject) => {
    let output = '', timedOut = false;
    const child = spawn(exe, args, { ...options, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    job.child = child;
    const capture = bytes => { output = (output + bytes.toString()).slice(-512 * 1024); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; terminate(child); }, options.timeout || 120000);
    child.on('error', error => { clearTimeout(timer); job.child = null; reject(error); });
    child.on('close', code => { clearTimeout(timer); job.child = null; resolve({ code, output, timedOut }); });
    if (job.cancelled) terminate(child);
  });
}
function terminate(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
export function parseTexDiagnostics(log, files, cwdRel = '') {
  const diagnostics = [];
  for (const line of log.split(/\r?\n/)) {
    const match = line.match(/^(.+?\.(?:tex|sty|cls)):(\d+):\s*(.+)$/);
    if (match) {
      const candidate = path.posix.normalize(path.posix.join(cwdRel, match[1].replace(/^\.\//, '').replaceAll('\\', '/')));
      const rel = files.includes(candidate) ? candidate : files.includes(match[1]) ? match[1] : null;
      if (rel) diagnostics.push({ relPath: rel, line: Number(match[2]), message: match[3] });
    }
  }
  return diagnostics.slice(0, 100);
}
export class TexBuildManager {
  constructor({ host, onEvent = () => {}, timeout = 120000, findSynctex = () => executable('synctex') } = {}) { this.host = host; this.onEvent = onEvent; this.slots = new Map(); this.watchers = new Map(); this.syncJobs = new Set(); this.timeout = timeout; this.stopping = false; this.findSynctex = findSynctex; }
  dir(projectId) { return path.join(this.host.projectDir(projectId), 'tex'); }
  async slot(projectId) {
    await this.host.requireProject(projectId);
    if (!this.slots.has(projectId)) this.slots.set(projectId, json(path.join(this.dir(projectId), 'last-success.json'), null).then(lastSuccess => ({ sequence: 0, state: { phase: 'idle', lastSuccess }, pending: null, job: null })));
    return this.slots.get(projectId);
  }
  publish(projectId, slot, patch) { slot.state = { ...slot.state, ...patch, projectId, sequence: slot.sequence }; this.onEvent(structuredClone(slot.state)); return structuredClone(slot.state); }
  async config(projectId) { await this.host.requireProject(projectId); return json(path.join(this.dir(projectId), 'config.json'), { root: '', engine: 'xelatex', automatic: true }); }
  async configure({ projectId, root, engine, automatic }) {
    const project = await this.host.requireProject(projectId);
    if (root && /["'`$;&|<>!]/.test(root)) throw fail('TEX_ROOT', '入口文件名含编译器不支持的特殊字符。');
    if (!engines.includes(engine) || typeof automatic !== 'boolean') throw fail('TEX_CONFIG', '不支持的 TeX 引擎或自动编译设置。');
    if (root) { relPath(root); if (!/\.tex$/i.test(root)) throw fail('TEX_ROOT', '入口必须是 .tex 文件。'); const file = await this.host.resolveFile(project, root); if (file.missing) throw fail('TEX_ROOT', '入口文件不存在。'); }
    await this.cancel({ projectId });
    const value = { root: root || '', engine, automatic }; await atomic(path.join(this.dir(projectId), 'config.json'), value); return value;
  }
  async inspect({ projectId, relPath: current }) {
    const project = await this.host.requireProject(projectId), config = await this.config(projectId);
    if (!this.watchers.has(projectId)) {
      try {
        let timer;
        const watcher = watch(project.root, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const rel = String(filename).replaceAll('\\', '/');
          if (rel.split('/').some(p => p.startsWith('.') || skipped.has(p)) || generated.test(rel)) return;
          clearTimeout(timer); timer = setTimeout(() => this.onEvent({ projectId, sourceChanged: true }), 200); timer.unref?.();
        });
        watcher.unref(); watcher.on('error', () => { watcher.close(); this.watchers.delete(projectId); });
        this.watchers.set(projectId, { close() { clearTimeout(timer); watcher.close(); } });
      } catch { /* Manual compilation and editor changes remain available without native watching. */ }
    }
    const configuredRoot = config.root;
    const files = await walk(project.root, '', [], true), roots = [], texts = new Map();
    for (const rel of files.filter(p => /\.tex$/i.test(p))) {
      const located = await this.host.resolveFile(project, rel), stat = await fs.stat(located.abs);
      if (stat.size > 4 * 1024 * 1024) continue;
      const text = await fs.readFile(located.abs, 'utf8'); texts.set(rel,text);
      if (/^[^%\n]*\\documentclass(?:\[|\{)/m.test(text)) roots.push(rel);
    }
    const tools = {};
    for (const engine of engines) tools[engine] = Boolean(await executable(engine) && (engine === 'tectonic' || await executable('latexmk')));
    const hasConfig = Boolean(await json(path.join(this.dir(projectId),'config.json'),null));
    const inference = inferTex({texts,current,config,tools,hasConfig});
    config.root = inference.root; config.engine = inference.engine;
    return { inference, config, configuredRoot, view: config.root ? await this.view({ projectId, root: config.root }) : null, roots, texFiles: files.filter(p => /\.tex$/i.test(p)), tools, syncTool: Boolean(await this.findSynctex()), state: structuredClone((await this.slot(projectId)).state) };
  }
  async view({ projectId, root, view }) {
    await this.host.requireProject(projectId); relPath(root);
    const file = path.join(this.dir(projectId), 'views', hash(root) + '.json');
    if (view !== undefined) {
      if (typeof view.preview !== 'boolean' || !Number.isInteger(view.page) || view.page < 1 || view.page > 100000 || !Number.isFinite(view.zoom) || view.zoom < .4 || view.zoom > 3 || !Number.isFinite(view.scrollTop) || view.scrollTop < 0 || view.scrollTop > 1e7) throw fail('TEX_VIEW', '无效预览位置。');
      await this.host.track(atomic(file, { preview: view.preview, page: view.page, zoom: view.zoom, scrollTop: view.scrollTop, linked: view.linked !== false }));
    }
    return json(file, { preview: true, page: 1, zoom: 1, scrollTop: 0, linked: true });
  }
  async status({ projectId }) { return structuredClone((await this.slot(projectId)).state); }
  async request({ projectId, buffers = [] }) {
    if (this.stopping) throw fail('TEX_STOPPED', '应用正在退出。');
    const config = await this.config(projectId);
    if (!config.root) throw fail('TEX_ROOT', '请先选择 TeX 根文档。');
    if (!Array.isArray(buffers) || buffers.length > 40) throw fail('TEX_BUFFER', '编译草稿数量超过限制。');
    for (const b of buffers) { relPath(b.relPath); if (typeof b.text !== 'string' || Buffer.byteLength(b.text) > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(b.baseDigest)) throw fail('TEX_BUFFER', '编译草稿或原件基线无效。'); }
    const slot = await this.slot(projectId), sequence = ++slot.sequence;
    slot.pending = { projectId, config, buffers: structuredClone(buffers), sequence };
    this.publish(projectId, slot, { phase: slot.job ? 'queued' : 'building', message: slot.job ? '已合并为最新编译请求' : '准备编译', diagnostics: [] });
    if (!slot.job) slot.running = this.drain(projectId, slot);
    return { sequence };
  }
  async cancel({ projectId }) {
    const slot = await this.slot(projectId); slot.sequence++; slot.pending = null;
    if (slot.job) { slot.job.cancelled = true; terminate(slot.job.child); }
    return this.publish(projectId, slot, { phase: 'cancelled', message: '已取消；保留上次成功结果' });
  }
  async drain(projectId, slot) {
    if (slot.job) return;
    while (slot.pending && !this.stopping) {
      const request = slot.pending; slot.pending = null;
      const job = { cancelled: false }; slot.job = job;
      try {
        const result = await this.build(request, job);
        if (request.sequence === slot.sequence && !job.cancelled) {
          await atomic(path.join(this.dir(projectId), 'last-success.json'), result);
          if (request.sequence !== slot.sequence || job.cancelled) {
            if (slot.state.lastSuccess) await atomic(path.join(this.dir(projectId), 'last-success.json'), slot.state.lastSuccess);
            else await fs.rm(path.join(this.dir(projectId), 'last-success.json'), { force: true });
            continue;
          }
          this.publish(projectId, slot, { phase: 'success', lastSuccess: result, diagnostics: result.diagnostics, message: `已更新 · ${(result.durationMs / 1000).toFixed(1)} 秒`, log: result.log });
        }
      } catch (error) {
        if (request.sequence === slot.sequence && !job.cancelled) this.publish(projectId, slot, { phase: 'error', message: slot.state.lastSuccess ? error.message : error.message.replace('显示上次成功结果', '尚无成功预览'), code: error.code, diagnostics: error.diagnostics || [], log: error.log || '' });
      } finally { slot.job = null; }
    }
  }
  async build({ projectId, config, buffers, sequence }, job) {
    const start = Date.now(), project = await this.host.requireProject(projectId);
    const engine = await executable(config.engine), compiler = config.engine === 'tectonic' ? engine : await executable('latexmk');
    if (!engine || !compiler) throw fail('TEX_TOOL_MISSING', `未检测到 ${config.engine === 'tectonic' ? 'Tectonic' : 'latexmk 和 ' + config.engine}。请安装 TeX 工具链后重试。`);
    const environment = { ...process.env, PATH: path.dirname(engine) + path.delimiter + path.dirname(compiler) + path.delimiter + (process.env.PATH || ''), openin_any: 'p', openout_any: 'p', shell_escape: 'f' };
    const version = await run(engine, ['--version'], { env: environment, timeout: 10000 }, job);
    if (job.cancelled) throw fail('TEX_CANCELLED', '编译已取消。');
    const cache = this.dir(projectId), builds = path.join(cache, 'builds'); await fs.mkdir(builds, { recursive: true });
    const old = await fs.readdir(builds);
    const used = await diskUsage(builds);
    if (old.length >= 100 || used + 3 * MAX_BYTES > 512 * 1024 * 1024) throw fail('TEX_CACHE_LIMIT', 'TeX 历史缓存已达上限；请保留所需历史后清理应用 TeX 缓存。');
    const buildId = randomUUID(), buildDir = path.join(builds, buildId), input = path.join(buildDir, 'input'), workKey = hash(config.engine + ':' + config.root).slice(0, 16), work = path.join(cache, 'work', workKey);
    await fs.mkdir(input, { recursive: true });
    const files = await walk(project.root), manifest = [], overlays = new Map(buffers.map(b => [b.relPath, b])); let total = 0;
    for (const rel of files) {
      if (job.cancelled) throw fail('TEX_CANCELLED', '编译已取消。');
      const located = await this.host.resolveFile(project, rel), stat = await fs.stat(located.abs);
      if (stat.size > MAX_BYTES || total + stat.size > MAX_BYTES) throw fail('TEX_LIMIT', '编译资源超过 64 MiB 限制。');
      const disk = await fs.readFile(located.abs), diskDigest = hash(disk);
      const draft = overlays.get(rel) || await this.host.readDraftRecord(projectId, rel);
      if (draft?.draftError) throw fail('TEX_DRAFT', `草稿无法读取：${rel}`);
      const active = draft && draft.status !== 'saved';
      if (active && draft.baseDigest !== diskDigest) throw fail('TEX_CONFLICT', `原件与草稿版本冲突，未编译：${rel}`);
      const bytes = active ? Buffer.from(draft.text, 'utf8') : disk;
      total += bytes.length; if (total > MAX_BYTES) throw fail('TEX_LIMIT', '编译资源超过 64 MiB 限制。');
      const target = path.join(input, rel); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
      manifest.push({ relPath: rel, diskDigest, digest: hash(bytes), draft: Boolean(active), bytes: bytes.length });
    }
    if (!manifest.some(f => f.relPath === config.root) || buffers.some(b => !manifest.some(f => f.relPath === b.relPath))) throw fail('TEX_ROOT', '入口或草稿文件已移除。');
    const base = { schemaVersion: 1, projectId, sequence, buildId, root: config.root, engine: config.engine, engineVersion: version.output.split('\n')[0], files: manifest, snapshotBytes: total, createdAt: new Date().toISOString() };
    await atomic(path.join(buildDir, 'manifest.json'), base);
    // Preserve aux between serialized builds; remove inputs deleted since the previous snapshot.
    const previous = await json(path.join(cache, 'work', workKey + '.json'), []);
    await fs.mkdir(work, { recursive: true });
    for (const rel of previous) if (!files.includes(rel)) await fs.rm(path.join(work, rel), { force: true });
    await fs.cp(input, work, { recursive: true }); await atomic(path.join(cache, 'work', workKey + '.json'), files);
    const cwdRel = path.posix.dirname(config.root), cwd = path.join(work, cwdRel), filename = path.posix.basename(config.root), stem = filename.replace(/\.tex$/i, '');
    const out = path.join(cwd, stem + '.pdf'); await fs.rm(out, { force: true });
    const args = config.engine === 'tectonic'
      ? ['-X', 'compile', '--only-cached', '--untrusted', '--synctex', '--keep-logs', '--keep-intermediates', './' + filename]
      : ['-norc', config.engine === 'xelatex' ? '-xelatex' : config.engine === 'lualatex' ? '-lualatex' : '-pdf', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1', '-no-shell-escape', './' + filename];
    const executed = await run(compiler, args, { cwd, env: environment, timeout: this.timeout }, job);
    const log = executed.output; await fs.writeFile(path.join(buildDir, 'build.log'), log);
    const diagnostics = parseTexDiagnostics(log, files, cwdRel === '.' ? '' : cwdRel);
    if (job.cancelled) throw fail('TEX_CANCELLED', '编译已取消。');
    if (executed.code !== 0 || executed.timedOut) throw Object.assign(fail(executed.timedOut ? 'TEX_TIMEOUT' : 'TEX_COMPILE', executed.timedOut ? '编译超时，显示上次成功结果' : '编译失败，显示上次成功结果；请查看诊断'), { diagnostics, log });
    const pdf = await fs.readFile(out); if (pdf.length > MAX_BYTES || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw fail('TEX_PDF', '编译未产生有效 PDF。');
    const after = await walk(project.root);
    if (JSON.stringify([...after].sort()) !== JSON.stringify([...files].sort())) throw fail('TEX_CONFLICT', '编译期间项目文件已增删，请重新编译。');
    for (const entry of manifest) {
      const located = await this.host.resolveFile(project, entry.relPath);
      const currentDigest = hash(await fs.readFile(located.abs));
      // An ordinary autosave of exactly the frozen draft is not a concurrent conflict.
      if (currentDigest !== entry.diskDigest && currentDigest !== entry.digest) throw fail('TEX_CONFLICT', `编译期间原件变化：${entry.relPath}；旧预览保留，请重新编译。`);
    }
    await fs.writeFile(path.join(buildDir, 'preview.pdf'), pdf);
    let synctexDigest = null;
    try { const syncFile = path.join(cwd, stem + '.synctex.gz'); if ((await fs.stat(syncFile)).size > MAX_BYTES) throw fail('TEX_LIMIT', 'SyncTeX 产物超过体积限制。'); const data = await fs.readFile(syncFile); await fs.writeFile(path.join(buildDir, 'preview.synctex.gz'), data); synctexDigest = hash(data); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = { ...base, durationMs: Date.now() - start, pdfDigest: hash(pdf), synctexDigest, diagnostics, log };
    await atomic(path.join(buildDir, 'manifest.json'), result); return result;
  }
  async artifact({ projectId, buildId }) {
    await this.host.requireProject(projectId);
    if (typeof buildId !== 'string' || !/^[0-9a-f-]{36}$/.test(buildId)) throw fail('TEX_BUILD', '无效编译版本。');
    const dir = path.join(this.dir(projectId), 'builds', buildId), metadata = await json(path.join(dir, 'manifest.json'), null);
    if (!metadata?.pdfDigest) throw fail('TEX_BUILD', '编译结果不存在。');
    const bytes = await fs.readFile(path.join(dir, 'preview.pdf'));
    if (hash(bytes) !== metadata.pdfDigest) throw fail('TEX_INTEGRITY', '编译产物校验失败。');
    return { bytes, metadata };
  }
  async sync({ projectId, buildId, relPath: source, text, direction, line, column = 0, page, x, y }) {
    if (this.stopping) throw fail('TEX_STOPPED', '应用正在退出。');
    const project = await this.host.requireProject(projectId); relPath(source);
    if (!['forward', 'inverse'].includes(direction) || typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024 || !/\.(?:tex|sty|cls)$/i.test(source)) throw fail('TEX_SYNC_INPUT', '无效的源码定位请求。');
    if (direction === 'forward' ? !Number.isInteger(line) || line < 1 || line > text.split('\n').length || !Number.isInteger(column) || column < 0 || column > 100000 : !Number.isInteger(page) || page < 1 || page > 100000 || ![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 20000)) throw fail('TEX_SYNC_INPUT', '无效的源码行或PDF坐标。');
    const { metadata } = await this.artifact({ projectId, buildId });
    if (metadata.projectId !== projectId || metadata.buildId !== buildId || !engines.includes(metadata.engine)) throw fail('TEX_BUILD', '构建不属于当前项目。');
    relPath(metadata.root);
    const entry = metadata.files.find(file => file.relPath === source);
    const buildDir = path.join(this.dir(projectId), 'builds', buildId), inputDir = path.join(buildDir, 'input');
    if (!entry) throw fail('TEX_SYNC_SOURCE', '当前源码不属于此编译结果。');
    const frozen = await fs.readFile(path.join(inputDir, source));
    if (hash(frozen) !== entry.digest) throw fail('TEX_INTEGRITY', '编译源码快照校验失败。');
    if (normalizedTexText(text) !== normalizedTexText(frozen.toString('utf8'))) throw fail('TEX_SYNC_STALE', '源码已有修改，等待对应的新编译结果后恢复联动。');
    if (!metadata.synctexDigest) throw fail('TEX_SYNC_MISSING', '此编译结果没有位置映射，无法联动。');
    const syncFile = path.join(buildDir, 'preview.synctex.gz');
    if ((await fs.stat(syncFile)).size > MAX_BYTES || hash(await fs.readFile(syncFile)) !== metadata.synctexDigest) throw fail('TEX_INTEGRITY', '编译位置映射校验失败。');
    const tool = await this.findSynctex();
    if (!tool) throw fail('TEX_SYNC_TOOL', '未安装SyncTeX定位工具；预览可独立阅读。');
    if (this.syncJobs.size >= 4) throw fail('TEX_SYNC_BUSY', '定位请求正在处理。');
    const workRoot = path.join(this.dir(projectId), 'work', hash(metadata.engine + ':' + metadata.root).slice(0, 16)), cwd = path.join(workRoot, path.posix.dirname(metadata.root));
    const pdf = path.join(buildDir, 'preview.pdf');
    const args = direction === 'forward' ? ['view', '-i', `${line}:${column}:${path.join(workRoot, source)}`, '-o', pdf] : ['edit', '-o', `${page}:${x}:${y}:${pdf}`];
    if (this.stopping) throw fail('TEX_STOPPED', '应用正在退出。');
    const job = { cancelled: false }; this.syncJobs.add(job);
    try {
      job.completion = run(tool, args, { cwd, timeout: 2000 }, job);
      const result = await job.completion;
      if (result.code !== 0 || result.timedOut || job.cancelled) throw fail('TEX_SYNC_QUERY', '位置查询未完成，请稍后重试。');
      const records = parseSynctexResults(result.output);
      if (direction === 'forward') {
        const points = records.filter(r => Number.isInteger(r.Page) && r.Page > 0 && [r.x, r.y].every(n => Number.isFinite(n) && n >= 0 && n <= 20000)).map(r => ({ page: r.Page, x: r.x, y: r.y }));
        return { buildId, relPath: source, points };
      }
      for (const r of records) {
        const target = syncSourcePath(r.Input, workRoot, cwd, metadata.files);
        if (!target || !Number.isInteger(r.Line) || r.Line < 1) continue;
        const targetEntry = metadata.files.find(file => file.relPath === target), bytes = await fs.readFile(path.join(inputDir, target));
        if (hash(bytes) !== targetEntry.digest) throw fail('TEX_INTEGRITY', '定位源码快照校验失败。');
        const frozenText = normalizedTexText(bytes.toString('utf8'));
        if (r.Line > frozenText.split('\n').length) continue;
        // Never route a PDF location into a newer draft or concurrent disk change.
        if (target !== source) {
          const current = await this.host.readFile(projectId, target);
          const draft = await this.host.readDraftRecord(projectId, target);
          const currentText = draft && draft.status !== 'saved' ? draft.text : current.text;
          if (current.sourceChanged || draft?.draftError || draft && draft.status !== 'saved' && draft.baseDigest !== current.digest || normalizedTexText(currentText) !== frozenText) throw fail('TEX_SYNC_STALE', '目标源码已变化，请重新编译后定位。');
        } else await this.host.resolveFile(project, target);
        return { buildId, relPath: target, line: r.Line, column: Number.isInteger(r.Column) && r.Column > 0 ? r.Column : null, sourceDigest: hash(Buffer.from(frozenText)) };
      }
      return { buildId, relPath: null };
    } finally { this.syncJobs.delete(job); }
  }
  async stopAll() { this.stopping = true; const syncJobs = [...this.syncJobs]; for (const job of syncJobs) { job.cancelled = true; terminate(job.child); } for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear(); for (const [projectId] of this.slots) await this.cancel({ projectId }); await Promise.allSettled([...syncJobs.map(job => job.completion), ...[...this.slots.values()].map(async slot => (await slot).running)]); }
}
