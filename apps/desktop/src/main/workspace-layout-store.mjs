import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {validateLayout,singleContentLayout} from '../domain/workspace-layout.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const hash = value => createHash('sha256').update(value).digest('hex');
function checkedProject(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_PROJECT', 'Project identity is invalid.');
  return value;
}
function checkedName(value) {
  if (typeof value !== 'string' || /[\\/\x00-\x1f\x7f]/.test(value)) fail('INVALID_LAYOUT_NAME', 'Layout name must not contain slashes or controls.');
  const name = value.normalize('NFC').trim();
  if (!name || [...name].length > 80 || /[\\/\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') fail('INVALID_LAYOUT_NAME', 'Layout names must contain 1–80 characters without slashes or controls.');
  return name;
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]));
// Named layouts contain navigation, not editor buffers, conversation drafts,
// attachment packages, report bodies, or credentials. Unknown state is omitted.
const navigationKeys = new Set(['pdfPage','scrollTop','scrollLeft','fileView','textMode','selection','anchor','head','start','end','line','column','startLineNumber','endLineNumber','startColumn','endColumn','positionLineNumber','positionColumn','selectionStartLineNumber','selectionStartColumn','zoom','mode','scale','markdownPreview','visible','ratio','width','height','workspace','dock','chatWidth','chatHeight','minimized','chatExpanded','fontSize','conversationFontSize','readingWidth','target','report','id','projectId','kind','relPath','resourceId','objectId','workId','eventId','changeId','requestId','history','scope','file','version','baselineVersion','currentVersion']);
function navigation(value, depth = 0) {
  if (depth > 16) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return value.length <= 8192 ? value : undefined;
  if (Array.isArray(value)) return value.slice(0, 512).map(item => navigation(item, depth + 1)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => navigationKeys.has(key)).map(([key, item]) => [key, navigation(item, depth + 1)]).filter(([, item]) => item !== undefined));
}
function snapshot(projectId, input) {
  const source = singleContentLayout(input);
  if (source.projectId !== projectId) fail('PROJECT_SCOPE_DENIED', 'Layout belongs to another project.');
  const node = value => value.kind === 'split'
    ? {...pick(value, ['kind','id','axis','ratio']), first: node(value.first), second: node(value.second)}
    : pick(value, ['kind','id','views','activeViewId','historyViewIds']);
  const layout = {...pick(source, ['schema','singleContent','projectId','revision','maximized']), mainRoot: node(source.mainRoot), detached: source.detached.map(window => ({...pick(window, ['id','boundsDip','alwaysOnTop']), root: node(window.root)})), views: Object.fromEntries(Object.entries(source.views).map(([id, view]) => [id, {...pick(view, ['id','projectId','resourceId','kind','relPath','pinned','preview','readOnly','sourceViewId']), ...(view.viewState ? {viewState: navigation(view.viewState)} : {})}]))};
  return validateLayout(layout);
}
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export class WorkspaceLayoutStore {
  constructor({directory}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('INVALID_DIRECTORY', 'Layout directory must be absolute.');
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  serial(work) {
    const result = this.pending.then(work, work);
    this.pending = result.catch(() => {});
    return result;
  }
  projectDirectory(projectId) { return path.join(this.directory, hash(checkedProject(projectId))); }
  filename(projectId, name) { return path.join(this.projectDirectory(projectId), `${hash(name)}.json`); }
  async read(projectId, name) {
    let record;
    try { record = JSON.parse(await fs.readFile(this.filename(projectId, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') fail('LAYOUT_NOT_FOUND', 'Named layout does not exist.'); throw error; }
    if (record.schema !== 1 || record.name !== name || record.projectId !== projectId || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) fail('LAYOUT_INVALID', 'Named layout record is invalid.');
    return {...record, layout: snapshot(projectId, record.layout)};
  }
  async write(record) {
    const directory = this.projectDirectory(record.projectId);
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const destination = this.filename(record.projectId, record.name), temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, destination);
      await syncDirectory(directory);
    } finally { await fs.rm(temporary, {force: true}); }
  }
  list(projectId) {
    return this.serial(async () => {
      const directory = this.projectDirectory(projectId);
      let names;
      try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return {layouts: []}; throw error; }
      const layouts = [];
      for (const filename of names) {
        if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
        const record = JSON.parse(await fs.readFile(path.join(directory, filename), 'utf8'));
        const name = checkedName(record.name);
        if (filename !== `${hash(name)}.json`) fail('LAYOUT_INVALID', 'Named layout filename does not match its name.');
        const valid = await this.read(projectId, name);
        layouts.push({name, updatedAt: valid.updatedAt});
      }
      layouts.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      return {layouts};
    });
  }
  save(projectId, name, layout) {
    projectId = checkedProject(projectId); name = checkedName(name);
    const saved = snapshot(projectId, layout);
    return this.serial(async () => {
      const record = {schema: 1, projectId, name, updatedAt: new Date().toISOString(), layout: saved};
      await this.write(record);
      return {name, updatedAt: record.updatedAt};
    });
  }
  load(projectId, name) {
    name = checkedName(name);
    return this.serial(async () => (await this.read(projectId, name)).layout);
  }
  rename(projectId, name, newName) {
    name = checkedName(name); newName = checkedName(newName);
    return this.serial(async () => {
      const record = await this.read(projectId, name);
      if (name === newName) return {name, updatedAt: record.updatedAt};
      try { await fs.lstat(this.filename(projectId, newName)); fail('LAYOUT_EXISTS', 'A layout with that name already exists.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const renamed = {...record, name: newName, updatedAt: new Date().toISOString()};
      // Publish the destination without replacement, including across store instances.
      const destination = this.filename(projectId, newName), source = this.filename(projectId, name);
      try { await fs.link(source, destination); } catch (error) { if (error.code === 'EEXIST') fail('LAYOUT_EXISTS', 'A layout with that name already exists.'); throw error; }
      try { await this.write(renamed); } catch (error) { await fs.rm(destination, {force: true}); throw error; }
      await fs.unlink(source);
      await syncDirectory(this.projectDirectory(projectId));
      return {name: newName, updatedAt: renamed.updatedAt};
    });
  }
  delete(projectId, name) {
    name = checkedName(name);
    return this.serial(async () => {
      await this.read(projectId, name);
      await fs.unlink(this.filename(projectId, name));
      await syncDirectory(this.projectDirectory(projectId));
      return {deleted: true};
    });
  }
}
