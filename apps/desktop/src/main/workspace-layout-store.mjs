import {validateLayout,singleContentLayout} from '../domain/workspace-layout.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
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
  const layout = {...pick(source, ['schema','singleContent','projectId','revision','maximized']), mainRoot: node(source.mainRoot), detached: source.detached.map(window => ({...pick(window, ['id','boundsDip','alwaysOnTop']), root: node(window.root)})), views: Object.fromEntries(Object.entries(source.views).map(([id, view]) => [id, {...pick(view, ['id','projectId','resourceId','kind','relPath','documentSource','pinned','preview','readOnly','sourceViewId']), ...(view.viewState ? {viewState: navigation(view.viewState)} : {})}]))};
  return validateLayout(layout);
}
export class WorkspaceLayoutStore {
  constructor({storage}) {
    this.storage = storage;
    this.pending = Promise.resolve();
  }
  serial(work) {
    const result = this.pending.then(work, work);
    this.pending = result.catch(() => {});
    return result;
  }
  async records(projectId) {
    return (await this.storage.getLocal(checkedProject(projectId), 'workspace:named-layouts')) ?? {};
  }
  record(records, projectId, name) {
    if (!Object.hasOwn(records, name)) fail('LAYOUT_NOT_FOUND', 'Named layout does not exist.');
    const record = records[name];
    if (record.schema !== 1 || record.name !== name || record.projectId !== projectId || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) fail('LAYOUT_INVALID', 'Named layout record is invalid.');
    return {...record, layout: snapshot(projectId, record.layout)};
  }
  list(projectId) {
    return this.serial(async () => {
      const records = await this.records(projectId);
      const layouts = Object.keys(records).sort().map(name => {
        const record = this.record(records, projectId, checkedName(name));
        return {name, updatedAt: record.updatedAt};
      });
      return {layouts};
    });
  }
  save(projectId, name, layout) {
    projectId = checkedProject(projectId); name = checkedName(name);
    const saved = snapshot(projectId, layout);
    return this.serial(async () => {
      const records = await this.records(projectId);
      const record = {schema: 1, projectId, name, updatedAt: new Date().toISOString(), layout: saved};
      await this.storage.putLocal(projectId, 'workspace:named-layouts', {...records, [name]: record});
      return {name, updatedAt: record.updatedAt};
    });
  }
  load(projectId, name) {
    name = checkedName(name);
    return this.serial(async () => this.record(await this.records(projectId), projectId, name).layout);
  }
  rename(projectId, name, newName) {
    name = checkedName(name); newName = checkedName(newName);
    return this.serial(async () => {
      const records = await this.records(projectId), record = this.record(records, projectId, name);
      if (name === newName) return {name, updatedAt: record.updatedAt};
      if (Object.hasOwn(records, newName)) fail('LAYOUT_EXISTS', 'A layout with that name already exists.');
      const renamed = {...record, name: newName, updatedAt: new Date().toISOString()};
      const next = {...records, [newName]: renamed}; delete next[name];
      await this.storage.putLocal(projectId, 'workspace:named-layouts', next);
      return {name: newName, updatedAt: renamed.updatedAt};
    });
  }
  delete(projectId, name) {
    name = checkedName(name);
    return this.serial(async () => {
      const records = await this.records(projectId); this.record(records, projectId, name);
      delete records[name];
      await this.storage.putLocal(projectId, 'workspace:named-layouts', records);
      return {deleted: true};
    });
  }
}
