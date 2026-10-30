import {workPath,safeBytes} from '../agents/managed/execution-workspace.mjs';
import {validateDrawing} from '../domain/region-drawing.mjs';
import { imageExtension, imageInfo } from './image-format.mjs';
import {importLegacyWord} from './legacy-word.mjs';
import {buildAnnotationPackage,pptSnapshot,verifyAnnotationPackage} from './annotation-package.mjs';
import { validateWordAnchor, wordText, locateWordQuote, applyWordTextEdits } from './word-anchors.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { constants,lstatSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateSheet } from './sheet-package.mjs';
import { validateWord } from './word-package.mjs';
import { MaterialStore, digestBytes } from '../domain/material-store.mjs';
import { FileTags } from '../domain/file-tags.mjs';
import { FileChanges, publicChanges } from '../domain/file-changes.mjs';
import { userActor } from '../domain/document-changes.mjs';
import { listDocumentVersions, readDocumentVersion } from '../domain/document-versions.mjs';
import { validateDocumentSource, isProjectDocumentSource, reviewTagNamespace } from '../domain/document-source.mjs';
import { anchorText, anchorAdvisory, resolveTextAnchor, textChangeSet, mapTextAnchor, validTextAnchor, validTextPointAnchor, mapTextPointAnchor, resolveTextPointAnchor } from '../domain/tag-anchors.mjs';
import {rebaseDocumentEdits, documentChangesSince, resolveTextReplacements} from '../domain/document-collaboration.mjs';
import { treeViewValue } from './file-tree-ops.mjs';
import {ProjectStorage} from './project-storage.mjs';
import {ensureProjectGit} from './project-git.mjs';
import {ProjectAttachments,validateDrawingPng} from './project-attachments.mjs';

  const NOTE_KINDS = ['image-region','image-point','ppt-selection','ppt-region','ppt-point','word-region', 'word-selection', 'text-selection', 'text-point', 'pdf-page', 'pdf-point', 'pdf-selection', 'pdf-region'];
  function boundNoteOffsets(value, { strict = false } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      if (strict && value != null) throw new HostError('INVALID_PAYLOAD', 'Note offsets must be an object.');
      return {};
    }
    const out = {};
    for (const [id, delta] of Object.entries(value).slice(0, 500)) {
      if (!/^[0-9a-f-]{36}$/i.test(id) || !Array.isArray(delta) || delta.length !== 2) {
        if (strict) throw new HostError('INVALID_PAYLOAD', 'Note offset identity or shape is invalid.');
        continue;
      }
      const [x, y] = delta;
      const valid = Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= Number.MAX_SAFE_INTEGER && Math.abs(y) <= Number.MAX_SAFE_INTEGER;
      if (!valid) { if (strict) throw new HostError('INVALID_PAYLOAD', 'Note offsets must be finite safe numbers.'); continue; }
      out[id] = [x, y];
    }
    return out;
  }
  function boundAnchor(anchor, kind) {
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) throw new HostError('INVALID_ANCHOR', 'Note draft anchor is missing.');
    if(kind==='image-region'){
      if(anchor.space!=='image-normalized'||![anchor.width,anchor.height].every(n=>Number.isInteger(n)&&n>0&&n<=20000))throw new HostError('INVALID_ANCHOR','图片坐标或尺寸无效。');
      const bounded=boundAnchor({space:'rendered-page-normalized',page:1,rotation:0,rects:anchor.rects,quote:''},'pdf-region');
      return {space:'image-normalized',width:anchor.width,height:anchor.height,rects:bounded.rects,quote:''};
    }
    if(kind==='ppt-selection'||kind==='ppt-region'){
      if(typeof anchor.slideId!=='string'||anchor.slideId.length>100)throw new HostError('INVALID_ANCHOR','PPT 幻灯片标识无效');
      if(kind==='ppt-selection'){
        if(anchor.space!=='pptx-text-object'||typeof anchor.elementId!=='string'||anchor.elementId.length>100||typeof anchor.quote!=='string'||!anchor.quote.trim()||anchor.quote.length>100000||typeof anchor.prefix!=='string'||typeof anchor.suffix!=='string'||anchor.prefix.length>32||anchor.suffix.length>32)throw new HostError('INVALID_ANCHOR','PPT 文字锚点无效');
        return {space:anchor.space,slideId:anchor.slideId,elementId:anchor.elementId,quote:anchor.quote,prefix:anchor.prefix,suffix:anchor.suffix};
      }
      if(anchor.space!=='pptx-slide-normalized'||typeof anchor.layout!=='string'||anchor.layout.length>1000000)throw new HostError('INVALID_ANCHOR','PPT 区域锚点无效');
      const a=boundAnchor({space:'rendered-page-normalized',page:1,rotation:0,rects:anchor.rects,quote:''},'pdf-region');
      return {space:anchor.space,slideId:anchor.slideId,layout:anchor.layout,rects:a.rects,quote:''};
    }
    if (kind === 'word-region') {
      if(anchor.space!=='docx-rendered-page-normalized')throw new HostError('INVALID_ANCHOR','Word 区域坐标无效。');
      const bounded=boundAnchor({...anchor,space:'rendered-page-normalized'},'pdf-region');
      return {...bounded,space:'docx-rendered-page-normalized'};
    }
    if (kind === 'word-selection') return validateWordAnchor(anchor);
    if (kind === 'text-selection') {
      if (Object.keys(anchor).some(key => !['start', 'end', 'quote'].includes(key))) throw new HostError('INVALID_ANCHOR', 'Text note draft anchor has unsupported fields.');
      if (!Number.isInteger(anchor.start) || !Number.isInteger(anchor.end) || anchor.start < 0 || anchor.end <= anchor.start || anchor.end > 8_000_000 || typeof anchor.quote !== 'string' || anchor.quote.length > 8_000_000) {
        throw new HostError('INVALID_ANCHOR', 'Text note draft anchor is outside the annotation range.');
      }
      return { start: anchor.start, end: anchor.end, quote: anchor.quote };
    }
    if (kind === 'text-point') {
      if (Object.keys(anchor).some(key => !['start', 'end', 'quote'].includes(key))) throw new HostError('INVALID_ANCHOR', 'Text point draft anchor has unsupported fields.');
      if (!Number.isInteger(anchor.start) || anchor.start !== anchor.end || anchor.start < 0 || anchor.start > 8_000_000 || anchor.quote !== '') throw new HostError('INVALID_ANCHOR', 'Text point draft anchor must be a zero-length position without a quote.');
      return { start: anchor.start, end: anchor.end, quote: '' };
    }
    if (kind === 'pdf-point') {
      if (Object.keys(anchor).some(key => !['page', 'rotation', 'space', 'x', 'y'].includes(key))) throw new HostError('INVALID_ANCHOR', 'Unexpected PDF point draft anchor fields.');
      if (!Number.isInteger(anchor.page) || anchor.page < 1 || anchor.page > 100000 || ![0, 90, 180, 270].includes(anchor.rotation) || anchor.space !== 'rendered-page-normalized' || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || anchor.x < 0 || anchor.x > 1 || anchor.y < 0 || anchor.y > 1) throw new HostError('INVALID_ANCHOR', 'PDF point draft must be a normalized point on a valid page.');
      return { page: anchor.page, rotation: anchor.rotation, space: anchor.space, x: anchor.x, y: anchor.y };
    }
    if (kind === 'image-point') {
      if (anchor.space !== 'image-normalized' || ![anchor.width, anchor.height].every(n => Number.isInteger(n) && n > 0 && n <= 20000) || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || anchor.x < 0 || anchor.x > 1 || anchor.y < 0 || anchor.y > 1) throw new HostError('INVALID_ANCHOR', '图片位置坐标或尺寸无效。');
      return { space: 'image-normalized', width: anchor.width, height: anchor.height, x: anchor.x, y: anchor.y };
    }
    if (kind === 'ppt-point') {
      if (typeof anchor.slideId !== 'string' || anchor.slideId.length > 100 || anchor.space !== 'pptx-slide-normalized' || typeof anchor.layout !== 'string' || anchor.layout.length > 1000000 || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || anchor.x < 0 || anchor.x > 1 || anchor.y < 0 || anchor.y > 1) throw new HostError('INVALID_ANCHOR', 'PPT 位置锚点无效');
      return { space: anchor.space, slideId: anchor.slideId, layout: anchor.layout, x: anchor.x, y: anchor.y };
    }
    if (kind === 'pdf-page') {
      if (Object.keys(anchor).some(key => key !== 'page') || !Number.isInteger(anchor.page) || anchor.page < 1 || anchor.page > 100000) throw new HostError('INVALID_ANCHOR', 'PDF page draft requires only a page number.');
      return { page: anchor.page };
    }
    if (kind === 'pdf-selection' || kind === 'pdf-region') {
      if (Object.keys(anchor).some(key => !['page', 'rotation', 'space', 'rects', 'quote'].includes(key))) throw new HostError('INVALID_ANCHOR', 'Unexpected PDF draft anchor fields.');
      if (!Number.isInteger(anchor.page) || anchor.page < 1 || anchor.page > 100000 || ![0, 90, 180, 270].includes(anchor.rotation) || anchor.space !== 'rendered-page-normalized') throw new HostError('INVALID_ANCHOR', 'Invalid PDF draft page or coordinate space.');
      const rects = anchor.rects;
      if (!Array.isArray(rects) || !rects.length || rects.length > 1000 || rects.some(rect => !Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite) || rect[0] < 0 || rect[1] < 0 || rect[2] <= 0 || rect[3] <= 0 || rect[0] + rect[2] > 1.000001 || rect[1] + rect[3] > 1.000001)) {
        throw new HostError('INVALID_ANCHOR', 'PDF draft selection must stay inside the page.');
      }
      if (typeof anchor.quote !== 'string' || anchor.quote.length > 20000 || (kind === 'pdf-selection' && !anchor.quote.trim())) throw new HostError('INVALID_ANCHOR', 'PDF draft quote is missing or larger than the annotation limit.');
      return { page: anchor.page, rotation: anchor.rotation, space: anchor.space, rects: rects.map(rect => rect.slice()), quote: anchor.quote };
    }
    throw new HostError('INVALID_ANCHOR', 'Unsupported note draft kind.');
  }
  function boundDrawingDraft(item){
    if(!item.drawing&&!item.regionImage)return {};
    const image=item.regionImage;
    if(!item.kind.endsWith('-region')||!image||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl||'')||image.dataUrl.length>24*1024*1024)throw new HostError('INVALID_PAYLOAD','区域草稿截图无效');
    const bytes=Buffer.from(image.dataUrl.split(',')[1],'base64');if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new HostError('INVALID_PAYLOAD','草稿不是PNG');
    const drawing=item.drawing?validateDrawing(item.drawing):undefined;
    if(drawing&&(drawing.width!==bytes.readUInt32BE(16)||drawing.height!==bytes.readUInt32BE(20)))throw new HostError('INVALID_PAYLOAD','草稿笔迹与截图尺寸不同');
    return {regionImage:{dataUrl:image.dataUrl,captureMode:image.captureMode,clipped:!!image.clipped},...(drawing?{drawing}:{}),...(typeof item.sourceDraftDigest==='string'&&/^[a-f0-9]{64}$/.test(item.sourceDraftDigest)?{sourceDraftDigest:item.sourceDraftDigest}:{}),...(item.drawingEdit?{drawingEdit:{id:String(item.drawingEdit.id),updatedAt:String(item.drawingEdit.updatedAt)}}:{})};
  }
  function boundNoteDrafts(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 40) throw new HostError('INVALID_PAYLOAD', 'Note drafts must be a list of at most 40.');
    return value.map(item => {
      if (!item || typeof item.text !== 'string' || item.text.length > 4000 || typeof item.relPath !== 'string' || item.relPath.length > 1024 || !/^[a-f0-9]{64}$/.test(item.materialDigest || '')) {
        throw new HostError('INVALID_PAYLOAD', 'Note draft text or material identity is not acceptable.');
      }
      if (!NOTE_KINDS.includes(item.kind)) throw new HostError('INVALID_ANCHOR', 'Unsupported note draft kind.');
      const edit = item.annotationId === undefined ? {} : { annotationId: item.annotationId, baselineUpdatedAt: item.baselineUpdatedAt };
      if (item.annotationId !== undefined && (typeof item.annotationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.annotationId) || typeof item.baselineUpdatedAt !== 'string' || !item.baselineUpdatedAt || item.baselineUpdatedAt.length > 100)) throw new HostError('INVALID_PAYLOAD', 'Existing-note draft requires annotation identity and its original update baseline.');
      return { projectId: typeof item.projectId === 'string' ? item.projectId : '', relPath: item.relPath, materialDigest: item.materialDigest, kind: item.kind, anchor: boundAnchor(item.anchor, item.kind), text: item.text, updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0, ...boundDrawingDraft(item), ...edit };
    });
  }
  function retainDraft(item, reason) {
    return { recovery: 'pending', reason, original: item && typeof item === 'object' ? JSON.parse(JSON.stringify(item)) : item };
  }
  function draftIdentity(item, kind, anchor) {
    return { projectId: typeof item.projectId === 'string' ? item.projectId : '', relPath: item.relPath, materialDigest: item.materialDigest, kind, anchor, text: item.text, updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0, migratedFrom: item.kind };
  }
  function usableIdentity(item) {
    return item && typeof item.text === 'string' && item.text.length <= 4000 && typeof item.relPath === 'string' && item.relPath.length <= 1024 && /^[a-f0-9]{64}$/.test(item.materialDigest || '');
  }
  function interpretDraft(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { retained: retainDraft(item, '旧备注草稿不是可解释的记录，原记录已保留。') };
    if (item.recovery === 'pending' && Object.hasOwn(item, 'original')) return { retained: retainDraft(item.original, typeof item.reason === 'string' ? item.reason : '旧备注草稿待恢复，原记录已保留。') };
    if (NOTE_KINDS.includes(item.kind)) {
      try { return { draft: boundNoteDrafts([item])[0] }; }
      catch (error) { return { retained: retainDraft(item, error.message || '备注草稿无法校验，原记录已保留。') }; }
    }
    if (item.kind === 'text') {
      const anchor = item.anchor;
      const rangeMatches = anchor && typeof anchor.quote === 'string' && Number.isInteger(anchor.start) && Number.isInteger(anchor.end) && anchor.quote.length === anchor.end - anchor.start;
      if (!rangeMatches) return { retained: retainDraft(item, anchor == null ? '旧文本备注没有锚点，未猜测选区。' : '旧文本引文与范围不一致，未从当前正文补齐。') };
      try {
        const checked = boundAnchor(anchor, 'text-selection');
        if (!usableIdentity(item)) return { retained: retainDraft(item, '旧文本备注身份不完整，原记录已保留。') };
        return { draft: draftIdentity(item, 'text-selection', checked) };
      } catch (error) { return { retained: retainDraft(item, error.message || '旧文本备注无法安全迁移。') }; }
    }
    if (item.kind === 'pdf') {
      const anchor = item.anchor;
      if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return { retained: retainDraft(item, '旧 PDF 备注没有锚点，未猜测页码。') };
      if (!Number.isInteger(anchor.page)) return { retained: retainDraft(item, '旧 PDF 备注缺少页码，未猜测当前页。') };
      if (typeof anchor.quote === 'string' && anchor.quote.length === 4000 && anchor.end == null && !Array.isArray(anchor.rects)) return { retained: retainDraft(item, '旧 PDF 引文停在 4000 字边界，未当作完整选文。') };
      const keys = Object.keys(anchor);
      if (keys.length === 1 && keys[0] === 'page') {
        try {
          const checked = boundAnchor(anchor, 'pdf-page');
          if (!usableIdentity(item)) return { retained: retainDraft(item, '旧 PDF 页级备注身份不完整，原记录已保留。') };
          return { draft: draftIdentity(item, 'pdf-page', checked) };
        } catch (error) { return { retained: retainDraft(item, error.message || '旧 PDF 页级备注无法安全迁移。') }; }
      }
      if (!Object.hasOwn(anchor, 'quote') || !Array.isArray(anchor.rects)) return { retained: retainDraft(item, '旧 PDF 选区不完整，未猜测缺失字段。') };
      const nextKind = String(anchor.quote).trim() ? 'pdf-selection' : 'pdf-region';
      try {
        const checked = boundAnchor(anchor, nextKind);
        if (!usableIdentity(item)) return { retained: retainDraft(item, '旧 PDF 选区身份不完整，原记录已保留。') };
        return { draft: draftIdentity(item, nextKind, checked) };
      } catch (error) { return { retained: retainDraft(item, error.message || '旧 PDF 选区无法安全迁移，原记录已保留。') }; }
    }
    return { retained: retainDraft(item, '无法识别的旧备注草稿，原记录已保留。') };
  }
  function readDraftList(value) {
    if (value == null) return { noteDrafts: [], retainedNoteDrafts: [] };
    if (!Array.isArray(value)) return { noteDrafts: [], retainedNoteDrafts: [retainDraft(value, '旧备注草稿不是列表，原记录已保留。')] };
    const noteDrafts = [];
    const retainedNoteDrafts = [];
    for (const item of value) {
      const read = interpretDraft(item);
      if (read.draft) noteDrafts.push(read.draft);
      if (read.retained) retainedNoteDrafts.push(read.retained);
    }
    return { noteDrafts, retainedNoteDrafts };
  }
  function mergeRetained(previous, incoming) {
    const out = [];
    const seen = new Set();
    for (const item of [...(previous || []), ...(incoming || [])]) {
      if (!item || item.recovery !== 'pending' || !Object.hasOwn(item, 'original')) continue;
      const key = JSON.stringify(item.original);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ recovery: 'pending', reason: typeof item.reason === 'string' ? item.reason : '旧备注草稿待恢复，原记录已保留。', original: item.original });
    }
    return out;
  }
export class HostError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.details = details;
  }
}

const SCHEMA = 1;
const LIST_LIMIT = 2000;
const LIST_DEPTH = 6;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_NOTE = 4000;
const MAX_REL = 1024;
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.text', '.tex', '.js', '.mjs', '.cjs', '.json', '.css', '.html',
  '.py', '.yml', '.yaml', '.csv', '.xml', '.svg', '.ts', '.tsx', '.jsx', '.log',
  '.bib', '.sty', '.cls', '.toml', '.ini', '.sh',
]);
const OFFICE_EXT = new Set(['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.odp', '.ods']);

function lock() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
}

function normalizeRel(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > MAX_REL) {
    throw new HostError('BAD_PATH', 'A project-relative path is required.');
  }
  if (relPath.includes('\0') || relPath.includes('\\') || relPath.includes(':')) {
    throw new HostError('BAD_PATH', 'Path contains a forbidden character.');
  }
  if (path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
    throw new HostError('BAD_PATH', 'Absolute paths are not accepted.');
  }
  const parts = relPath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new HostError('ESCAPE', 'Path escapes the open project.');
  }
  return parts.join('/');
}

function navigationLimit(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new HostError('INVALID_PAYLOAD', 'Limit must be a positive integer.');
  return Math.min(value, max);
}

function navigationHidden(rel, roots) {
  for (let current = rel; current && current !== '.'; current = path.posix.dirname(current)) if (roots.has(current)) return true;
  return false;
}

function navigationTextCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function navigationCompare(a, b) {
  return (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1) || navigationTextCompare(a.name, b.name);
}

/** Execute links store only the program-issued job identity; status always
 * derives from the managed work record, never from persisted display text. */
function validExecuteRef(value) {
  return !value || (typeof value === 'object' && typeof value.jobId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.jobId));
}

const validProjectId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);

function draftKey(relPath) {
  return createHash('sha256').update(relPath).digest('hex');
}

function isUtf8Text(bytes) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function classify(relPath, bytes) {
  const ext = path.posix.extname(relPath).toLowerCase();
  if (imageExtension.test(relPath)) { imageInfo(bytes); return {kind:'image'}; }
  if (ext === '.pptx') return { kind: 'ppt' };
  if (ext === '.xlsx') return { kind: 'sheet' };
  if (ext === '.docx') return { kind: 'word' };
  if (ext === '.doc') return {kind:'legacy-word'};
  if (ext === '.pdf' || bytes.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf' };
  if (OFFICE_EXT.has(ext)) {
    return { kind: 'unsupported', unsupportedReason: 'Office 预览未纳入本包。' };
  }
  if (TEXT_EXT.has(ext) || (ext === '' && isUtf8Text(bytes))) {
    if (!isUtf8Text(bytes)) return { kind: 'unsupported', unsupportedReason: '不是可编辑的 UTF-8 文本。' };
    return { kind: 'text' };
  }
  if (isUtf8Text(bytes) && bytes.length < 1024 * 1024) return { kind: 'text' };
  return { kind: 'unsupported', unsupportedReason: '本包只阅读 PDF 与 UTF-8 文本。' };
}

async function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class DesktopHost {
  constructor(userDataDir, { materialMaxBytes = 64 * 1024 * 1024, onDocumentChange = () => {} } = {}) {
    if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) {
      throw new HostError('INVALID_DIRECTORY', 'Application metadata directory must be absolute.');
    }
    this.userDataDir = path.resolve(userDataDir);
    this.storage=new ProjectStorage(this.userDataDir);
    this.attachments=new ProjectAttachments(this.storage);
    this.metaRoot = path.join(this.userDataDir,'nozeli','settings');
    this.maxReadBytes = materialMaxBytes;
    this.metaLock = lock();
    this.fileLocks = new Map();
    this.projectLocks = new Map();
    this.documentReads = new Map();
    this.documentReadCursors = new Map();
    this.documentReadBytes = 0;
    this.documentStatusCache = new Map();
    this.onDocumentChange = onDocumentChange;
    // Review-candidate document adapter; wired by the main process to the
    // managed review controller. Absent wiring fails closed for review reads.
    this.reviewDocuments = null;
    this.active = 0;
    this.idle = [];
  }

  boundDocumentSource(value) {
    if (value === undefined || value === null) return { type: 'project' };
    try { return validateDocumentSource(value); }
    catch (error) { throw new HostError('INVALID_DOCUMENT_SOURCE', error.message); }
  }
  requireReviewDocuments() {
    if (!this.reviewDocuments) throw new HostError('REVIEW_DOCUMENTS_UNAVAILABLE', '审校文档服务尚未就绪；未回退读取项目源文件。');
    return this.reviewDocuments;
  }

  track(work) {
    this.active += 1;
    return Promise.resolve(work).finally(() => {
      this.active -= 1;
      if (this.active === 0) {
        const waiters = this.idle.splice(0);
        for (const resolve of waiters) resolve();
      }
    });
  }

  settled() {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  fileLock(projectId, relPath) {
    const key = `${projectId}\0${relPath}`;
    let held = this.fileLocks.get(key);
    if (!held) {
      held = lock();
      this.fileLocks.set(key, held);
    }
    return work => this.projectLock(projectId)(() => held(work));
  }

  projectLock(projectId) {
    let held=this.projectLocks.get(projectId);
    if(!held){held=lock();this.projectLocks.set(projectId,held);}
    return held;
  }

  async ensureMeta() {
    await fs.mkdir(this.metaRoot, { recursive: true, mode: 0o700 });
  }

  async readVersioned(file) {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new HostError('METADATA_IO', 'Metadata could not be read.', { cause: error.code });
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new HostError('METADATA_CORRUPT', 'Metadata is corrupt and was left unchanged.', { file: path.basename(file) });
    }
    if (!data || data.schemaVersion !== SCHEMA) {
      throw new HostError('SCHEMA_UNSUPPORTED', 'Unknown metadata version; refusing to overwrite.', {
        schemaVersion: data?.schemaVersion ?? null,
      });
    }
    return data;
  }

  async writeAtomic(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      try { await handle.writeFile(payload); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(tmp, file);
      await syncDirectory(path.dirname(file));
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async writeVersioned(file, value) {
    const existing = await this.readVersioned(file);
    if (existing && existing.schemaVersion !== SCHEMA) {
      throw new HostError('SCHEMA_UNSUPPORTED', 'Unknown metadata version; refusing to overwrite.');
    }
    await this.writeAtomic(file, { ...value, schemaVersion: SCHEMA });
  }

  async viewAuthorship(visible) {
    if(visible!==undefined&&typeof visible!=='boolean')throw new HostError('INVALID_PAYLOAD','修改者显示设置无效。');
    return this.track(this.metaLock(async()=>{
      await this.ensureMeta();
      const file=path.join(this.metaRoot,'view-preferences.json'),previous=await this.readVersioned(file);
      if(previous?.authorshipVisible!=null&&typeof previous.authorshipVisible!=='boolean')throw new HostError('CORRUPT_METADATA','修改者显示设置损坏，未覆盖。');
      if(visible===undefined)return {visible:previous?.authorshipVisible!==false};
      await this.writeVersioned(file,{...previous,authorshipVisible:visible});
      return {visible};
    }));
  }

  async updateRegistry(mutator) {
    const current={schemaVersion:SCHEMA,projects:await this.storage.list()},next=mutator(current);
    for(const p of next.projects)await this.storage.db.request(this.storage.catalog,'put',{collection:'instances',id:p.id,value:p});
    return next;
  }

  projectDir(projectId) {
    if(!validProjectId(projectId))throw new HostError('UNKNOWN_PROJECT','项目身份无效');
    const p=this.storage.bindings.get(projectId);if(!p)throw new HostError('UNKNOWN_PROJECT','项目尚未加载');
    return path.join(this.storage.root,'recovery',p.instanceId);
  }

  async requireRegisteredProject(projectId){return this.storage.requireRegistered(projectId);}
  async requireProject(projectId){return this.storage.requireOnline(projectId);}

  async resolveFile(project, relPath) {
    const rel = normalizeRel(relPath);
    const root = project.root;
    const abs = path.resolve(root, ...rel.split('/'));
    const relative = path.relative(root, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new HostError('ESCAPE', 'Path escapes the open project.');
    }
    const realRoot = await fs.realpath(root);
    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        const relReal = path.relative(realRoot, real);
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
          throw new HostError('ESCAPE', 'Path resolves outside the project through a link.');
        }
        break;
      } catch (error) {
        if (error instanceof HostError) throw error;
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    let lst;
    try {
      lst = await fs.lstat(abs);
    } catch (error) {
      if (error.code === 'ENOENT') return { rel, abs, missing: true };
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new HostError('ACCESS_DENIED', 'Path cannot be accessed.', { cause: error.code });
      }
      throw error;
    }
    if (lst.isSymbolicLink()) throw new HostError('SYMLINK', 'Refusing to follow a symlink.');
    if (!lst.isFile()) throw new HostError('NOT_A_FILE', 'Only regular files can be read or saved.');
    return { rel, abs, missing: false };
  }

  async registerDirectory(input, options) {
    if(typeof input!=='string'||!path.isAbsolute(input))throw new HostError('NOT_A_DIRECTORY','请选择绝对目录');
    const project=await this.storage.register(input,options),key='git-init',previous=await this.storage.getRecovery(project.id,key);
    const operationId=previous?.operationId??randomUUID();
    await ensureProjectGit(project.root,{operationId,expectedIdentity:project.identity,journal:{read:()=>this.storage.getRecovery(project.id,key),write:value=>this.storage.putRecovery(project.id,key,value)}});
    return this.publicProject(project);
  }

  publicProject(project) {
    return { id: project.id, name: project.name, rootDisplay: project.root, openedAt: project.openedAt, lastOpenedAt: project.lastOpenedAt,...(this.guidedDemo?.isDemo(project.id)?{demo:true,source:'demo-fixture'}:{}) };
  }

  async pick(directory, options) {
    return this.track((async () => {
      if (directory == null) return { canceled: true };
      const project = await this.registerDirectory(directory, options);
      return { canceled: false, project };
    })());
  }

  async removeProject(projectId,options={}){return this.track(this.storage.remove(projectId,options));}

  async recent(){return this.track((async()=>{const projects=[];for(const p of await this.storage.list()){if(p.removed)continue;const available=await this.storage.requireOnline(p.id).then(()=>true,()=>false);projects.push({...this.publicProject(p),available});}projects.sort((a,b)=>String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt)));return {projects};})());}

  async open(projectId) {
    return this.track((async () => {
      const project = await this.requireProject(projectId);
      const now = new Date().toISOString();
      const value={...project,lastOpenedAt:now};
      await this.storage.db.request(this.storage.catalog,'put',{collection:'instances',id:project.id,value});
      this.storage.bindings.set(project.id,value);
      return { project: { ...this.publicProject(project), lastOpenedAt: now } };
    })());
  }

  async navigationView(projectId, treeView) {
    return treeView ? treeViewValue(await this.storage.getLocal(projectId,'file-tree-view')) : null;
  }

  async navigationDirectory(project, rel) {
    let abs = project.root;
    for (const name of rel ? normalizeRel(rel).split('/') : []) {
      if (name.startsWith('.') || name === 'node_modules') throw new HostError('BAD_PATH', 'Dot and dependency paths cannot be listed.');
      abs = path.join(abs, name);
      const stat = await fs.lstat(abs);
      if (stat.isSymbolicLink()) throw new HostError('SYMLINK', 'Refusing to follow a symlink.');
      if (!stat.isDirectory()) throw new HostError('NOT_A_DIRECTORY', 'Parent must be a project directory.');
    }
    const relative = path.relative(project.root, await fs.realpath(abs));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new HostError('ESCAPE', 'Directory escapes the project.');
    return abs;
  }

  async children(projectId, { parentRelPath = '', cursor = null, limit = 200, treeView = false } = {}) {
    return this.track((async () => {
      const project = await this.requireProject(projectId);
      const parent = parentRelPath === '' ? '' : normalizeRel(parentRelPath);
      const bounded = navigationLimit(limit, 200, 500);
      const view = await this.navigationView(projectId, treeView);
      const hidden = new Set(view?.hidden ?? []);
      const abs = await this.navigationDirectory(project, parent);
      const scope = createHash('sha256').update(JSON.stringify([projectId, parent,view?{hidden:view.hidden,showHidden:view.showHidden}:null])).digest('hex');
      let after = null;
      if (cursor != null) {
        try {
          if (typeof cursor !== 'string' || cursor.length > 8192) throw Error();
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
          if (decoded.scope !== scope || !Array.isArray(decoded.key) || decoded.key.length !== 2 || !['dir', 'file'].includes(decoded.key[0]) || typeof decoded.key[1] !== 'string') throw Error();
          after = {kind: decoded.key[0], name: decoded.key[1]};
        } catch { throw new HostError('INVALID_CURSOR', 'Cursor does not belong to this directory and view.'); }
      }
      const entries = [];
      if (!navigationHidden(parent, hidden)) {
        for (const item of await fs.readdir(abs, {withFileTypes: true})) {
          const {name} = item;
          if (name.startsWith('.') || name === 'node_modules' || item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue;
          const relPath = parent ? `${parent}/${name}` : name;
          const isHidden = navigationHidden(relPath, hidden);
          if (isHidden && !view?.showHidden) continue;
          const entry = {relPath, name, kind: item.isDirectory() ? 'dir' : 'file', depth: relPath.split('/').length - 1, ...(view ? {hidden: isHidden, hiddenRoot: hidden.has(relPath)} : {})};
          if (!after || navigationCompare(entry, after) > 0) entries.push(entry);
        }
      }
      entries.sort(navigationCompare);
      const hasMore = entries.length > bounded;
      entries.length = Math.min(entries.length, bounded);
      const last = entries.at(-1);
      const nextCursor = hasMore ? Buffer.from(JSON.stringify({scope, key: [last.kind, last.name]})).toString('base64url') : null;
      return {entries, parentRelPath: parent, nextCursor, hasMore, truncated: hasMore, limit: bounded, ...(view ? {hiddenCount: hidden.size} : {})};
    })());
  }

  async search(projectId, { query = '', limit = 100, treeView = true, filesOnly = false } = {}) {
    return this.track((async () => {
      const project = await this.requireProject(projectId);
      if (typeof query !== 'string' || query.length > 256) throw new HostError('INVALID_PAYLOAD', 'Search query must contain at most 256 characters.');
      const bounded = navigationLimit(limit, 100, 200), needle = query.trim().toLowerCase();
      const view = await this.navigationView(projectId, treeView), hidden = new Set(view?.hidden ?? []);
      const workLimit = 10000, matches = [], stack = [''];
      if(query.trim().includes('/')){try{const rel=normalizeRel(query.trim()),parts=rel.split('/');if(parts.some(part=>part.startsWith('.')||part==='node_modules'))throw new HostError('BAD_PATH','Excluded path');const parent=path.posix.dirname(rel),name=path.posix.basename(rel),abs=path.join(await this.navigationDirectory(project,parent==='.'?'':parent),name),stat=await fs.lstat(abs),isHidden=navigationHidden(rel,hidden);if(!stat.isSymbolicLink()&&(stat.isFile()||(filesOnly!==true&&stat.isDirectory()))&&(!isHidden||view?.showHidden))return {entries:[{relPath:rel,name,kind:stat.isDirectory()?'dir':'file',depth:parts.length-1,...(view?{hidden:isHidden,hiddenRoot:hidden.has(rel)}:{})}],limit:bounded,truncated:false,hasMore:false,budgetExceeded:false,work:1,workLimit,reason:null};}catch{/* A non-exact path continues through bounded name/path search. */}}
      let work = 0, matched = 0, budgetExceeded = false, unreadable = false;
      while (stack.length) {
        if (work >= workLimit) { budgetExceeded = true; break; }
        const rel = stack.pop();
        let dir;
        try { dir = await fs.opendir(await this.navigationDirectory(project, rel)); } catch { unreadable = true; continue; }
        try {
          for (;;) {
            if (work >= workLimit) { budgetExceeded = true; break; }
            const item = await dir.read();
            work++;
            if (!item) break;
            const {name} = item;
            if (name.startsWith('.') || name === 'node_modules' || item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue;
            const relPath = rel ? `${rel}/${name}` : name;
            if (relPath.length > MAX_REL) { unreadable = true; continue; }
            const isHidden = navigationHidden(relPath, hidden);
            if (isHidden && !view?.showHidden) continue;
            if (item.isDirectory() && !isHidden) stack.push(relPath);
            if (filesOnly === true && item.isDirectory()) continue;
            const lowerName = name.toLowerCase(), lowerPath = relPath.toLowerCase();
            if (!lowerName.includes(needle) && !lowerPath.includes(needle)) continue;
            matched++;
            const rank = lowerName === needle ? 0 : lowerName.startsWith(needle) ? 1 : lowerName.includes(needle) ? 2 : 3;
            matches.push({relPath, name, kind: item.isDirectory() ? 'dir' : 'file', depth: relPath.split('/').length - 1, ...(view ? {hidden: isHidden, hiddenRoot: hidden.has(relPath)} : {}), rank});
            matches.sort((a, b) => a.rank - b.rank || navigationCompare(a, b) || navigationTextCompare(a.relPath, b.relPath));
            if (matches.length > bounded) matches.pop();
          }
        } finally { await dir.close(); }
        if (budgetExceeded) break;
      }
      const truncated = budgetExceeded || unreadable || matched > bounded;
      return {entries: matches.map(({rank, ...entry}) => entry), limit: bounded, truncated, hasMore: truncated, budgetExceeded, work, workLimit, reason: budgetExceeded ? 'work-budget' : unreadable ? 'unreadable' : matched > bounded ? 'result-limit' : null};
    })());
  }

  async list(projectId, { treeView = false } = {}) {
    return this.track((async () => {
      const project = await this.requireProject(projectId);
      const view = treeView === true ? treeViewValue(await this.storage.getLocal(projectId,'file-tree-view')) : null;
      const hiddenRoots = new Set(view?.hidden ?? []);
      const isHidden = rel => {
        for (let current = rel; current; current = path.posix.dirname(current)) {
          if (hiddenRoots.has(current)) return true;
          if (current === '.' || !current.includes('/')) break;
        }
        return false;
      };
      const entries = [];
      const stack = [{ dir: project.root, rel: '', depth: 0 }];
      const skip = new Set(['node_modules']);
      while (stack.length && entries.length < LIST_LIMIT) {
        const current = stack.pop();
        if (current.depth > LIST_DEPTH) continue;
        let names;
        try {
          names = await fs.readdir(current.dir);
        } catch {
          continue;
        }
        names.sort((a, b) => a.localeCompare(b, 'zh'));
        for (const name of names) {
          if (name.startsWith('.') || skip.has(name)) continue;
          const abs = path.join(current.dir, name);
          const relPath = current.rel ? `${current.rel}/${name}` : name;
          // Prune before stat/stack insertion: hidden subtrees never consume the visible budget.
          if (hiddenRoots.has(relPath)) continue;
          let stat;
          try {
            stat = await fs.lstat(abs);
          } catch {
            continue;
          }
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) {
            entries.push({ relPath, name, kind: 'dir', depth: current.depth });
            stack.push({ dir: abs, rel: relPath, depth: current.depth + 1 });
          } else if (stat.isFile()) {
            entries.push({ relPath, name, kind: 'file', depth: current.depth });
          }
          if (entries.length >= LIST_LIMIT) break;
        }
      }
      const truncated = entries.length >= LIST_LIMIT;
      if (view) {
        for (const entry of entries) Object.assign(entry, { hidden: false, hiddenRoot: false });
        if (view.showHidden) {
          const included = new Set(entries.map(entry => entry.relPath));
          // Explicit roots and their ancestors remain recoverable beyond the normal limit/depth.
          // Do not enumerate hidden directories: their contents must not displace visible entries.
          for (const root of hiddenRoots) {
            let abs = project.root, rel = '';
            const pending = [];
            let valid = true;
            for (const name of root.split('/')) {
              abs = path.join(abs, name);
              rel = rel ? `${rel}/${name}` : name;
              let stat;
              try { stat = await fs.lstat(abs); } catch { valid = false; break; }
              if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (rel !== root && !stat.isDirectory())) { valid = false; break; }
              pending.push({ relPath: rel, name, kind: stat.isDirectory() ? 'dir' : 'file', depth: rel.split('/').length - 1, hidden: isHidden(rel), hiddenRoot: hiddenRoots.has(rel) });
            }
            if (valid) for (const entry of pending) if (!included.has(entry.relPath)) {
              included.add(entry.relPath);
              entries.push(entry);
            }
          }
        }
      }
      return { entries, truncated, limit: LIST_LIMIT, ...(view ? { hiddenCount: hiddenRoots.size } : {}) };
    })());
  }


  async readDraftRecord(projectId, relPath) {
    try {
      return await this.storage.getRecovery(projectId,'draft:'+draftKey(relPath));
    } catch (error) {
      if (error instanceof HostError && (error.code === 'METADATA_CORRUPT' || error.code === 'SCHEMA_UNSUPPORTED')) {
        return { draftError: { code: error.code, message: error.message } };
      }
      throw error;
    }
  }

  async persistDraft(projectId, relPath, baseDigest, text, status, lastError = null) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT_BYTES) {
      throw new HostError('INVALID_PAYLOAD', 'Draft text is missing or too large.');
    }
    if (typeof baseDigest !== 'string' || !/^[a-f0-9]{64}$/.test(baseDigest)) {
      throw new HostError('INVALID_PAYLOAD', 'Draft baseline digest is required.');
    }
    await this.requireRegisteredProject(projectId);
    const record = {
      schemaVersion: SCHEMA,
      projectId,
      relPath,
      baseDigest,
      text,
      status,
      lastError,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.putRecovery(projectId,'draft:'+draftKey(relPath),record);
    return record;
  }

  async importDoc(projectId,input){
    return this.track((async()=>{
      const project=await this.requireProject(projectId),source=await this.resolveFile(project,input?.relPath);
      if(source.missing||path.posix.extname(source.rel).toLowerCase()!=='.doc')throw new HostError('INVALID_PAYLOAD','请选择项目内 .doc 文件。');
      const original=await this.readSource(source.abs),digest=digestBytes(original);
      if(digest!==input.digest)throw new HostError('CONFLICT','DOC 已变化，请重新打开后再导入。');
      const converted=await importLegacyWord(original);
      if(digestBytes(await this.readSource(source.abs))!==digest)throw new HostError('CONFLICT','DOC 在导入期间发生变化，未生成副本。');
      const base=source.rel.slice(0,-4);
      for(let n=1;n<=100;n++){
        const relPath=base+(converted.mode==='body-only'?'.正文导入':'.导入')+(n===1?'':'-'+n)+'.docx';
        const target=await this.resolveFile(project,relPath);if(!target.missing)continue;
        let handle;try{handle=await fs.open(target.abs,'wx',0o600);}catch(error){if(error.code==='EEXIST')continue;throw error;}
        try{await handle.writeFile(converted.bytes);await handle.sync();}catch(error){await handle.close();await fs.unlink(target.abs);throw error;}
        await handle.close();return {relPath,mode:converted.mode,sourceDigest:digest};
      }
      throw new HostError('CONFLICT','导入副本名称已占用，请先整理已有副本。');
    })());
  }

  async fileAvailability(projectId, paths) {
    return this.track((async () => {
      if (!Array.isArray(paths) || paths.length > 500 || paths.some(p => typeof p !== 'string')) throw new HostError('INVALID_PAYLOAD', 'Expected at most 500 file paths.');
      const project = await this.requireProject(projectId), entries = [];
      for (const relPath of new Set(paths)) {
        try {
          const located = await this.resolveFile(project, relPath);
          entries.push({relPath, status: located.missing ? 'missing' : 'present'});
        } catch (error) {
          entries.push({relPath, status: 'unavailable', code: error.code || 'IO_ERROR'});
        }
      }
      return {entries};
    })());
  }

  async readFile(projectId, relPath, documentSource) {
    const source = this.boundDocumentSource(documentSource);
    if (source.type !== 'project') return this.track(this.requireReviewDocuments().read({ projectId, source, relPath: normalizeRel(relPath) }));
    return this.track(this.fileLock(projectId, normalizeRel(relPath))(async () => {
      const project = await this.requireProject(projectId);
      let located;
      try{located=await this.resolveFile(project,relPath);}catch(error){
        if(!['NOT_A_FILE','SYMLINK','ESCAPE','ACCESS_DENIED','EACCES','EPERM','ENOTDIR'].includes(error.code))throw error;
        const rel=normalizeRel(relPath),draft=await this.readDraftRecord(projectId,rel);
        if(!draft||draft.draftError)throw error;
        return {relPath:rel,kind:'text',unsupportedReason:null,digest:null,materialDigest:null,byteLength:0,text:null,bytes:null,encoding:'utf-8',draft:{text:draft.text,baseDigest:draft.baseDigest,status:draft.status,updatedAt:draft.updatedAt,lastError:draft.lastError??null},draftError:null,sourceChanged:true,diskPresent:false,pathUnavailable:error.code,mtimeMs:null};
      }
      if (located.missing) {
        const draftWrap = await this.readDraftRecord(projectId, located.rel);
        const draft = draftWrap && !draftWrap.draftError ? draftWrap : null;
        if (!draft) throw new HostError('NOT_FOUND', 'File does not exist.', { relPath: located.rel });
        return {
          relPath: located.rel, kind: 'text', unsupportedReason: null, digest: null, materialDigest: null,
          byteLength: 0, text: null, bytes: null, encoding: 'utf-8',
          draft: { text: draft.text, baseDigest: draft.baseDigest, status: draft.status, updatedAt: draft.updatedAt, lastError: draft.lastError ?? null },
          draftError: null, sourceChanged: true, diskPresent: false, mtimeMs: null,
        };
      }
      const bytes = await this.readSource(located.abs);
      const digest = digestBytes(bytes);
      const kind = classify(located.rel, bytes);
      if (kind.kind === 'word') await validateWord(bytes);
      if (kind.kind === 'sheet') await validateSheet(bytes);
      if (kind.kind === 'text' && bytes.length > MAX_TEXT_BYTES) throw new HostError('TOO_LARGE', 'Text exceeds the 8 MiB editor limit; no content was truncated.');
      let materialDigest = null;
      if (kind.kind !== 'unsupported') {
        const stored = await this.rememberMaterial(projectId, located.rel, bytes);
        materialDigest = stored.digest;
      }
      const draftWrap = await this.readDraftRecord(projectId, located.rel);
      const draft = draftWrap?.draftError || draftWrap?.status === 'saved' ? null : draftWrap;
      const stat = await fs.stat(located.abs);
      const text = kind.kind === 'text' ? new TextDecoder('utf-8').decode(bytes) : null;
      const authorshipText = kind.kind === 'word' ? await wordText(bytes) : text;
      let authorship = null, authorshipError = null;
      if (authorshipText != null) {
        try { const store = new FileChanges({storage:this.storage,projectId:project.id,root:project.root}); authorship = publicChanges(await store.withLock(located.rel, () => store.observe(located.rel, authorshipText, digest, kind.kind === 'word' ? {textSpace:'docx-main-text'} : {}))); }
        catch (error) { authorshipError = { code:error.code || 'CHANGE_HISTORY_IO', message:error.message }; }
      }
      return {
        relPath: located.rel,
        kind: kind.kind,
        unsupportedReason: kind.unsupportedReason ?? null,
        digest,
        materialDigest,
        byteLength: bytes.length,
        text,
        authorship,
        authorshipText: kind.kind === 'word' ? authorshipText : null,
        authorshipError,
        image: kind.kind === 'image' ? imageInfo(bytes) : null,
        bytes: ['image','pdf','word','sheet','ppt'].includes(kind.kind) ? bytes : null,
        encoding: kind.kind === 'text' ? 'utf-8' : null,
        draft: draft ? {
          text: draft.text,
          baseDigest: draft.baseDigest,
          status: draft.status,
          updatedAt: draft.updatedAt,
          lastError: draft.lastError ?? null,
        } : null,
        draftError: draftWrap?.draftError ?? null,
        sourceChanged: Boolean(draft && draft.baseDigest !== digest),
        diskPresent: true,
        mtimeMs: stat.mtimeMs,
      };
    }));
  }

  async documentHistory(projectId, relPath, { eventId = null, scope = null, cursor = null, limit = 100 } = {}, documentSource) {
    if (this.boundDocumentSource(documentSource).type !== 'project') throw new HostError('UNSUPPORTED', '审校文档没有项目修改账本；请使用版本列表。');
    return this.track(this.fileLock(projectId, normalizeRel(relPath))(async () => {
      const project = await this.requireProject(projectId), located = await this.resolveFile(project, relPath);
      const store = new FileChanges({storage:this.storage,projectId:project.id,root:project.root});
      return store.withLock(located.rel, async () => {
        let ledger;
        if (located.missing) ledger = await store.read(located.rel);
        else {
          const bytes = await this.readSource(located.abs);
          const kind=classify(located.rel, bytes).kind;
          if (!['text','word'].includes(kind) || kind === 'text' && bytes.length > MAX_TEXT_BYTES) throw new HostError('UNSUPPORTED','当前署名支持UTF-8文本及DOCX正文。');
          ledger = await store.observe(located.rel, kind === 'word' ? await wordText(bytes) : new TextDecoder('utf-8').decode(bytes), digestBytes(bytes), kind === 'word' ? {textSpace:'docx-main-text'} : {});
        }
        if (!ledger) return { authorship:null, events:[], total:0, hasMore:false, nextCursor:null };
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HostError('INVALID_PAYLOAD','每页修改记录应为1至100批。');
        const version={docId:ledger.docId,revision:ledger.revision,digest:ledger.digest};
        const matches=value=>value?.docId===ledger.docId&&value.revision===ledger.revision&&value.digest===ledger.digest;
        if (scope && !matches(scope) || cursor && !matches(cursor)) throw new HostError('STALE_HISTORY','文件版本已变化；请关闭记录后点击当前标记重新查看。',version);
        if (cursor && (!Number.isSafeInteger(cursor.beforeRevision) || cursor.beforeRevision < 1 || cursor.beforeRevision > ledger.revision+1)) throw new HostError('INVALID_PAYLOAD','修改记录分页位置无效。');
        let selected=ledger.events;
        if(scope){
          if(!Number.isSafeInteger(scope.from)||!Number.isSafeInteger(scope.to)||scope.from<0||scope.to<scope.from||scope.to>ledger.text.length
            ||!['text','deletion'].includes(scope.kind)||!Array.isArray(scope.actorIds)||!scope.actorIds.length||scope.actorIds.length>128
            ||scope.actorIds.some(id=>typeof id!=='string'||id.length>512)
            ||scope.eventIds!=null&&(!Array.isArray(scope.eventIds)||scope.eventIds.length>50000||scope.eventIds.some(id=>typeof id!=='string'||id.length>256)))
            throw new HostError('INVALID_PAYLOAD','修改段范围无效。');
          const actors=new Map(ledger.events.map(event=>[event.id,event.actor.id])),allowed=new Set(scope.actorIds),requested=scope.eventIds?new Set(scope.eventIds):null;
          const intersect=scope.kind==='deletion'?ledger.points.filter(point=>point.from===scope.from)
            :ledger.spans.filter(span=>span.from<scope.to&&span.to>scope.from);
          const ids=new Set(intersect.filter(item=>allowed.has(actors.get(item.eventId))&&(!requested||requested.has(item.eventId))).map(item=>item.eventId));
          selected=ledger.events.filter(event=>ids.has(event.id));
        }else if(eventId)selected=ledger.events.filter(event=>event.id===eventId);
        const total=selected.length,remaining=selected.filter(event=>!cursor||event.revision<cursor.beforeRevision).slice().reverse();
        const events=remaining.slice(0,limit),hasMore=remaining.length>events.length;
        return { authorship:publicChanges(ledger), events, total, hasMore,
          nextCursor:hasMore?{...version,beforeRevision:events.at(-1).revision}:null,interruptedCount:ledger.attempts.length };
      });
    }));
  }

  async withDocumentLedger(projectId, relPath, work) {
    return this.track(this.fileLock(projectId, normalizeRel(relPath))(async () => {
      const project = await this.requireProject(projectId), located = await this.resolveFile(project, relPath);
      const store = new FileChanges({storage:this.storage,projectId:project.id,root:project.root});
      return store.withLock(located.rel, async () => {
        let ledger;
        if (located.missing) ledger = await store.read(located.rel);
        else {
          const bytes = await this.readSource(located.abs);
          if (classify(located.rel, bytes).kind !== 'text' || bytes.length > MAX_TEXT_BYTES) throw new HostError('UNSUPPORTED', '历史对比仅支持UTF-8文本文件。');
          ledger = await store.observe(located.rel, new TextDecoder('utf-8').decode(bytes), digestBytes(bytes));
        }
        if (!ledger) throw new HostError('HISTORY_VERSION_UNAVAILABLE', '此文件尚无已记录版本。');
        return work(ledger);
      });
    }));
  }

  documentVersions(projectId, relPath, options = {}, documentSource) {
    if (this.boundDocumentSource(documentSource).type !== 'project') return this.track(this.requireReviewDocuments().versions({ projectId, source: this.boundDocumentSource(documentSource), relPath: normalizeRel(relPath), cursor: options.cursor ?? null, limit: options.limit ?? 50 }));
    return this.withDocumentLedger(projectId, relPath, ledger => listDocumentVersions(ledger, options));
  }

  documentVersion(projectId, relPath, version, documentSource) {
    if (this.boundDocumentSource(documentSource).type !== 'project') return this.track(this.requireReviewDocuments().version({ projectId, source: this.boundDocumentSource(documentSource), relPath: normalizeRel(relPath), version }));
    return this.withDocumentLedger(projectId, relPath, ledger => readDocumentVersion(ledger, version, digest => this.storage.readObject(projectId,digest)));
  }

  async documentStatus(projectId,relPath) {
    const rel=normalizeRel(relPath),project=await this.requireProject(projectId),located=await this.resolveFile(project,rel);
    if(located.missing)return {deleted:true};
    const store=new FileChanges({storage:this.storage,projectId:project.id,root:project.root});
    const [source,revision]=await Promise.all([fs.stat(located.abs),store.recordRevision(rel)]);
    const signature=JSON.stringify([source.ino,source.size,source.mtimeMs,source.ctimeMs,revision]),key=projectId+'\0'+rel;
    const cached=this.documentStatusCache.get(key);
    if(cached?.signature===signature)return {authorship:cached.authorship};
    const result=await this.documentHistory(projectId,rel);
    this.documentStatusCache.set(key,{signature,authorship:result.authorship});
    return {authorship:result.authorship};
  }

  async frontdeskReceipt(projectId,actor,operationId,fingerprint,relPath=null) {
    const project=await this.requireProject(projectId),store=new FileChanges({storage:this.storage,projectId:project.id,root:project.root});
    const entries=relPath?[await store.read(workPath(relPath))].filter(Boolean):await store.all();
    for(const entry of entries){
      if(![...entry.events,...(entry.operationReceipts||[]),entry.pending?.candidate.events.at(-1)].some(event=>event?.operationId===operationId))continue;
      return this.fileLock(projectId,entry.relPath)(()=>store.withLock(entry.relPath,async()=>{
        let ledger=await store.read(entry.relPath);
        if(ledger.pending){const located=await this.resolveFile(project,entry.relPath),bytes=located.missing?null:await this.readSource(located.abs);ledger=await store.observe(entry.relPath,bytes===null?'':ledger.textSpace==='docx-main-text'?await wordText(bytes):new TextDecoder().decode(bytes),bytes===null?null:digestBytes(bytes),ledger.textSpace?{textSpace:ledger.textSpace}:{});}
        const event=[...ledger.events,...(ledger.operationReceipts||[])].find(event=>event.operationId===operationId);if(!event)return null;
        if(event.fingerprint!==fingerprint||['id','sessionId','sessionInstance','requestId'].some(key=>event.actor[key]!==actor[key]))throw new HostError('CONFLICT','操作标识或来源会话不匹配。');
        return {duplicate:true,unchanged:event.unchanged===true,relPath:entry.relPath,eventId:event.id||null,operationId,revision:event.revision,digest:event.afterDigest,actor:event.actor};
      }));
    }
    return null;
  }

  async createDocument(projectId,actor,{relPath,text,operationId,requestFingerprint},{beforeApply=()=>{}}={}) {
    const rel=workPath(relPath);
    const extension=path.posix.extname(rel).toLowerCase();
    if(typeof text!=='string'||Buffer.byteLength(text)>MAX_TEXT_BYTES||!isUtf8Text(Buffer.from(text))||OFFICE_EXT.has(extension)||extension==='.pdf'||imageExtension.test(rel))throw new HostError('UNSUPPORTED','创建支持不超过8MiB的UTF-8文本及源码文件，不以文本伪造Office、PDF或图片。');
    if(typeof operationId!=='string'||!/^[a-f0-9]{64}$/.test(operationId)||typeof requestFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(requestFingerprint))throw new HostError('INVALID_PAYLOAD','创建需要宿主操作标识。');
    text=anchorText(text);
    return this.track(this.fileLock(projectId,rel)(async()=>{
      const project=await this.requireProject(projectId),store=new FileChanges({storage:this.storage,projectId:project.id,root:project.root});
      return store.withLock(rel,async()=>{
        beforeApply();const draft=await this.readDraftRecord(projectId,rel);
        if(draft)throw new HostError('UNSAVED','此路径已有用户草稿，未覆盖。');
        const located=await this.resolveFile(project,rel);if(!located.missing)throw new HostError('CONFLICT','文件已存在，未覆盖。');
        let dir=project.root;
        for(const part of rel.split('/').slice(0,-1)){beforeApply();dir=path.join(dir,part);await fs.mkdir(dir).catch(error=>{if(error.code!=='EEXIST')throw error;});const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new HostError('SYMLINK','父目录不可为链接。');}
        const bytes=Buffer.from(text),digest=digestBytes(bytes),history=await store.observe(rel,'',null),candidate=store.candidate(history,text,digest,textChangeSet('',text),actor,{operationId,fingerprint:requestFingerprint,type:'create'});
        await this.backupBaseline(projectId,rel+'.agent-candidate',bytes,digest);
        const material=await this.rememberMaterial(projectId,rel,bytes);await store.prepare(rel,history,candidate);
        await this.replaceFile(located.abs,bytes,{createOnly:true,beforeCommit:async()=>{const fresh=await this.resolveFile(project,rel);if(!fresh.missing||await this.readDraftRecord(projectId,rel))throw new HostError('CONFLICT','创建时路径或草稿已变化。');beforeApply();}});
        await store.finish(rel,candidate);
        const event=candidate.events.at(-1);this.onDocumentChange({projectId,relPath:rel,digest,actor,eventId:event.id,revision:candidate.revision,authorship:publicChanges(candidate)});
        return {relPath:rel,digest,materialDigest:material.digest,eventId:event.id,operationId,revision:candidate.revision,actor,authorship:publicChanges(candidate)};
      });
    }));
  }

  async saveManagedWord(project,located,bytes,ledger,text,edits,changes,store,actor,{operationId,fingerprint,beforeApply}) {
    const payload=await applyWordTextEdits(bytes,edits),digest=digestBytes(payload),stat=await fs.lstat(located.abs);
    if((stat.mode&0o222)===0)throw new HostError('READONLY','DOCX文件只读。');
    const recoveryPath=await this.backupBaseline(project.id,located.rel,payload,digest);
    await this.backupBaseline(project.id,located.rel,bytes,ledger.digest);
    const candidate=store.candidate(ledger,text,digest,changes,actor,{operationId,fingerprint,type:'word-text'});
    await store.prepare(located.rel,ledger,candidate);
    await this.replaceFile(located.abs,payload,{mode:stat.mode,beforeCommit:async()=>{const fresh=await this.resolveFile(project,located.rel),draft=await this.readDraftRecord(project.id,located.rel);if(draft?.draftError||draft&&draft.status!=='saved')throw new HostError('UNSAVED','用户草稿在DOCX保存期间变化，未覆盖。',{recoveryPath});if(fresh.missing||digestBytes(await this.readSource(fresh.abs))!==ledger.digest)throw new HostError('CONFLICT','DOCX保存期间变化。',{recoveryPath});beforeApply();}});
    await store.finish(located.rel,candidate);const material=await this.rememberMaterial(project.id,located.rel,payload),event=candidate.events.at(-1);
    this.onDocumentChange({projectId:project.id,relPath:located.rel,digest,actor,eventId:event.id,revision:candidate.revision,authorship:publicChanges(candidate)});
    return {relPath:located.rel,digest,materialDigest:material.digest,eventId:event.id,operationId,revision:candidate.revision,actor,recoveryPath,authorship:publicChanges(candidate)};
  }

  async readDocument(projectId, relPath, actor) {
    return this.track(this.fileLock(projectId, normalizeRel(relPath))(async () => {
      const project = await this.requireProject(projectId), located = await this.resolveFile(project, relPath);
      if (located.missing) throw new HostError('NOT_FOUND','文档不存在。');
      const bytes = await this.readSource(located.abs);
      const kind=classify(located.rel,bytes).kind;
      if (!['text','word'].includes(kind) || bytes.length > (kind==='word'?32*1024*1024:MAX_TEXT_BYTES)) throw new HostError('UNSUPPORTED','文档工具支持UTF-8文本及DOCX正文；其他格式请使用对应编辑器。');
      const draft = await this.readDraftRecord(projectId, located.rel);
      if (draft?.draftError || draft && draft.status !== 'saved') throw new HostError('UNSAVED','用户草稿尚未成功保存，未用磁盘旧版本替代；请先处理草稿。');
      const store = new FileChanges({storage:this.storage,projectId:project.id,root:project.root});
      const authorshipText=kind==='word'?await wordText(bytes):new TextDecoder('utf-8').decode(bytes);
      const ledger = await store.withLock(located.rel, () => store.observe(located.rel, authorshipText, digestBytes(bytes),kind==='word'?{textSpace:'docx-main-text'}:{}));
      const readHandle = randomUUID();
      const bytesHeld=ledger.text.length*2;
      while(this.documentReads.size && (this.documentReads.size>=256 || this.documentReadBytes+bytesHeld>64*1024*1024)) { const key=this.documentReads.keys().next().value;this.documentReadBytes-=this.documentReads.get(key).bytesHeld;this.documentReads.delete(key); }
      this.documentReadBytes+=bytesHeld;
      const cursorKey=projectId+'\0'+located.rel+'\0'+actor.id;
      const priorCursor=this.documentReadCursors.get(cursorKey)||null;
      this.documentReads.set(readHandle, { projectId,relPath:located.rel,docId:ledger.docId,revision:ledger.revision,digest:ledger.digest,text:ledger.text,actorId:actor.id,sessionId:actor.sessionId,sessionInstance:actor.sessionInstance,createdAt:Date.now(),bytesHeld });
      const changesSinceLastRead=priorCursor?documentChangesSince({docId:ledger.docId,revision:priorCursor.revision,digest:priorCursor.digest,text:ledger.text},ledger):null;
      this.documentReadCursors.set(cursorKey,{docId:ledger.docId,revision:ledger.revision,digest:ledger.digest});
      return { relPath:located.rel,text:ledger.text,readHandle,version:{docId:ledger.docId,revision:ledger.revision,digest:ledger.digest},authorship:publicChanges(ledger),offsetEncoding:'UTF-16; LF line endings',changesSinceLastRead };
    }));
  }

  async applyDocument(projectId, actor, { readHandle, edits, replacements, operationId, contexts = [], requestFingerprint = null }, {beforeApply=()=>{}}={}) {
    const read = this.documentReads.get(readHandle);
    if (!read || read.projectId !== projectId || read.actorId !== actor.id || read.sessionId !== actor.sessionId || read.sessionInstance !== actor.sessionInstance || Date.now()-read.createdAt > 6*60*60*1000) throw new HostError('READ_HANDLE_REJECTED','读取句柄无效或属于其他会话，请重新读取。');
    workPath(read.relPath);
    // Model calls quote exact text; only host code derives UTF-16 offsets. The
    // resolver also returns the spans contextBefore/contextAfter cover, which
    // must survive rebase unchanged next to the programmatic contexts parameter.
    let replacementContexts = [];
    if (edits === undefined && replacements !== undefined) { const resolved = resolveTextReplacements(read.text, replacements); edits = resolved.edits; replacementContexts = resolved.contexts; }
    if (typeof operationId !== 'string' || !/^[a-f0-9]{64}$/.test(operationId) || !Array.isArray(edits) || !edits.length || edits.length > 1000) throw new HostError('INVALID_PAYLOAD','需要工具生成的操作标识及1至1000处精确编辑。');
    if(!Array.isArray(contexts)||contexts.length>1000)throw new HostError('INVALID_PAYLOAD','必要上下文必须为读取版本的范围数组。');
    const effectiveContexts=[...contexts,...replacementContexts];
    const splitPair = offset => offset > 0 && offset < read.text.length && /[\uD800-\uDBFF]/.test(read.text[offset-1]) && /[\uDC00-\uDFFF]/.test(read.text[offset]);
    let end = -1;
    const normalized = edits.map(edit => {
      if (!edit || !Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < 0 || edit.to < edit.from || edit.to > read.text.length || edit.from <= end || typeof edit.insert !== 'string' || edit.insert.length > MAX_TEXT_BYTES || splitPair(edit.from) || splitPair(edit.to)) throw new HostError('INVALID_PAYLOAD','编辑范围必须按原读取文本的UTF-16位置递增、不重叠，且不拆开Unicode字符。');
      end = Math.max(edit.from, edit.to - 1);
      if (edit.expected !== undefined && edit.expected !== read.text.slice(edit.from,edit.to)) throw new HostError('CONFLICT','编辑原文与读取版本不符。');
      return { from:edit.from,to:edit.to,insert:anchorText(edit.insert), ...(edit.expected!==undefined?{expected:edit.expected}:{}) };
    });
    const fingerprint = requestFingerprint || digestBytes(Buffer.from(JSON.stringify({ readHandle, edits:normalized, contexts:effectiveContexts })));
    return this.track(this.fileLock(projectId, read.relPath)(async () => {
      const project = await this.requireProject(projectId), located = await this.resolveFile(project,read.relPath), store = new FileChanges({storage:this.storage,projectId:project.id,root:project.root});
      return store.withLock(read.relPath, async () => {
        beforeApply();
        const prior = await store.read(read.relPath), receipt = prior?[...prior.events,...(prior.operationReceipts||[])].find(event=>event.operationId===operationId):null;
        if (receipt) {
          if (receipt.fingerprint !== fingerprint || ['id','sessionId','sessionInstance'].some(key=>receipt.actor[key]!==actor[key])) throw new HostError('CONFLICT','操作标识被用于不同修改。');
          return { duplicate:true,unchanged:receipt.unchanged===true,eventId:receipt.id||null,revision:receipt.revision,digest:receipt.afterDigest };
        }
        const recovery = async () => {
          const bytes=Buffer.from(JSON.stringify({format:'nozeli.agent-change-candidate',actor,readHandle,read,edits:normalized,contexts:effectiveContexts,operationId}), 'utf8');
          return this.backupBaseline(projectId,read.relPath+'.agent-candidate.json',bytes,digestBytes(bytes));
        };
        if (located.missing) throw new HostError('DELETED','文件已删除，未应用Agent修改。',{recoveryPath:await recovery()});
        const bytes = await this.readSource(located.abs), kind=classify(read.relPath,bytes).kind;
        if(!['text','word'].includes(kind))throw new HostError('UNSUPPORTED','文档格式已变化，请重新读取。');
        const ledger = await store.observe(read.relPath,kind==='word'?await wordText(bytes):new TextDecoder('utf-8').decode(bytes),digestBytes(bytes),kind==='word'?{textSpace:'docx-main-text'}:{});
        const recovered=ledger.events.find(event=>event.operationId===operationId);
        if(recovered){if(recovered.fingerprint!==fingerprint||recovered.actor.id!==actor.id||recovered.actor.sessionInstance!==actor.sessionInstance)throw new HostError('CONFLICT','操作身份冲突。');return {duplicate:true,relPath:read.relPath,eventId:recovered.id,revision:recovered.revision,digest:recovered.afterDigest};}
        const draft = await this.readDraftRecord(projectId,read.relPath);
        if (draft?.draftError || draft && draft.status !== 'saved') throw new HostError('UNSAVED','用户草稿尚未成功保存，Agent候选已保留，未覆盖。',{recoveryPath:await recovery()});
        let mapped;
        try { mapped = rebaseDocumentEdits(read, ledger, normalized, effectiveContexts); }
        catch(error) { if(error.code!=='STALE_VERSION')throw error;throw new HostError('STALE_VERSION',error.message,{...documentChangesSince(read,ledger),recoveryPath:await recovery()}); }
        let merged=ledger.text;
        for(const edit of mapped){
          if(edit.to>merged.length){throw new HostError('STALE_VERSION','映射后目标超出当前正文；候选已保留，请重新读取。',{currentVersion:{docId:ledger.docId,revision:ledger.revision,digest:ledger.digest},recoveryPath:await recovery()});}
          if(edit.expected!==undefined && merged.slice(edit.from,edit.to)!==edit.expected){throw new HostError('STALE_VERSION','映射后目标内容已变化；候选已保留，请重新读取。',{currentVersion:{docId:ledger.docId,revision:ledger.revision,digest:ledger.digest},recoveryPath:await recovery()});}
        }
        for(const edit of mapped.slice().reverse())merged=merged.slice(0,edit.from)+edit.insert+merged.slice(edit.to);
        if(merged===ledger.text){
          beforeApply();
          const receipt={operationId,fingerprint,actor:{...actor},revision:ledger.revision,afterDigest:ledger.digest,unchanged:true};
          await store.write(read.relPath,{...ledger,operationReceipts:[...(ledger.operationReceipts||[]),receipt]});
          return {relPath:read.relPath,operationId,unchanged:true,eventId:null,revision:ledger.revision,digest:ledger.digest,authorship:publicChanges(ledger)};
        }
        if(Buffer.byteLength(merged,'utf8')>MAX_TEXT_BYTES)throw new HostError('TOO_LARGE','编辑结果超过8MiB正文安全限制，未写入。');
        const changes=textChangeSet(ledger.text,merged,(await import('@codemirror/state')).ChangeSet.of(mapped,ledger.text.length).toJSON());
        const saved=kind==='word'
          ? await this.saveManagedWord(project,located,bytes,ledger,merged,mapped,changes,store,actor,{operationId,fingerprint,beforeApply})
          : await this.saveLocked(project, located, ledger.digest, merged, { anchorChanges:changes.toJSON(),changeStore:store,actor,operationId,fingerprint,agentWrite:true,beforeReplace:beforeApply });
        return {...saved,mappedEdits:mapped,rebased:ledger.revision!==read.revision,changesSinceRead:documentChangesSince(read,ledger)};
      });
    }));
  }

  // Internal managed-Worker API; not renderer-supplied arbitrary byte writes.
  async mergeWorkerFile(projectId, actor, op, payload, {beforeApply=()=>{}}={}) {
    const rel=workPath(op.relPath),operationId=digestBytes(Buffer.from(op.id));
    if(payload!==null&&(!(payload instanceof Uint8Array)||payload.length>32*1024*1024))throw new HostError('INVALID_PAYLOAD','Worker候选无效');
    if((payload===null?null:digestBytes(payload))!==op.afterDigest)throw new HostError('INVALID_PAYLOAD','候选digest不符');
    return this.track(this.fileLock(projectId,rel)(async()=>{
      const project=await this.requireProject(projectId),store=new FileChanges({storage:this.storage,projectId:project.id,root:project.root});
      return store.withLock(rel,async()=>{
        beforeApply();const draft=await this.readDraftRecord(projectId,rel);
        if(draft?.draftError||draft&&draft.status!=='saved')throw new HostError('UNSAVED','用户未保存内容保留，未合入Worker候选');
        const disk=await safeBytes(project.root,rel),digest=disk===null?null:digestBytes(disk);
        const isText=(disk===null||isUtf8Text(disk))&&(payload===null||isUtf8Text(payload));
        let history=isText?await store.observe(rel,disk===null?'':new TextDecoder().decode(disk),digest):null;
        const done=history?.events.find(e=>e.operationId===operationId&&e.actor.id===actor.id);
        if(done){if(done.beforeDigest!==op.beforeDigest||done.afterDigest!==op.afterDigest)throw new HostError('CONFLICT','合入标识冲突');return {relPath:rel,beforeDigest:done.beforeDigest,digest:done.afterDigest,eventId:done.id,duplicate:true};}
        if(digest!==op.beforeDigest)throw new HostError('STALE_VERSION','原文件在执行副本制作后变化，未覆盖');
        if(disk!==null)await this.backupBaseline(projectId,rel,disk,digest);
        const located=await this.resolveFile(project,rel);
        if(disk!==null&&payload!==null&&isText&&TEXT_EXT.has(path.posix.extname(rel).toLowerCase())){
          const value=await this.saveLocked(project,located,digest,new TextDecoder().decode(payload),{changeStore:store,actor,agentWrite:true,operationId,fingerprint:op.afterDigest,beforeReplace:beforeApply});
          return {...value,relPath:rel,beforeDigest:digest};
        }
        if(disk!==null){const stat=await fs.lstat(located.abs);if((stat.mode&0o222)===0)throw new HostError('READONLY','原文件只读');}
        // Refuse any symlink parent, including links that remain within project.
        let dir=project.root;for(const part of rel.split('/').slice(0,-1)){
          dir=path.join(dir,part);await fs.mkdir(dir).catch(e=>{if(e.code!=='EEXIST')throw e;});const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new HostError('SYMLINK','父目录不可为链接');
        }
        const candidate=history?store.candidate(history,payload===null?'':new TextDecoder().decode(payload),op.afterDigest,textChangeSet(history.text,payload===null?'':new TextDecoder().decode(payload)),actor,{operationId,fingerprint:op.afterDigest||'delete',type:payload===null?'delete':disk===null?'create':'edit'}):null;
        if(candidate)await store.prepare(rel,history,candidate);
        const check=async()=>{beforeApply();const fresh=await safeBytes(project.root,rel);if((fresh===null?null:digestBytes(fresh))!==digest)throw new HostError('STALE_VERSION','文件在合入期间变化');};
        if(payload===null){await check();await fs.unlink(located.abs);await syncDirectory(path.dirname(located.abs));}
        else await this.replaceFile(located.abs,Buffer.from(payload),{createOnly:disk===null,mode:op.mode,beforeCommit:check});
        if(candidate)await store.finish(rel,candidate);
        this.onDocumentChange({projectId,relPath:rel,digest:op.afterDigest,actor});
        return {relPath:rel,beforeDigest:digest,digest:op.afterDigest,eventId:candidate?.events.at(-1)?.id,revision:candidate?.revision};
      });
    }));
  }


  async draft(projectId, relPath, baseDigest, text, documentSource, expectedDraftRevision) {
    const source = this.boundDocumentSource(documentSource);
    if (source.type !== 'project') return this.track(this.requireReviewDocuments().save({ projectId, source, relPath: normalizeRel(relPath), text, expectedDraftRevision, mode: 'draft' }));
    return this.track(this.fileLock(projectId, normalizeRel(relPath))(async () => {
      const project = await this.requireProject(projectId);
      const located = await this.resolveFile(project, relPath);
      const record = await this.persistDraft(project.id, located.rel, baseDigest, text, 'dirty');
      return { draft: { text: record.text, baseDigest: record.baseDigest, status: record.status, updatedAt: record.updatedAt } };
    }));
  }

  async retainDraft(projectId, relPath, baseDigest, text, documentSource, expectedDraftRevision) {
    const source = this.boundDocumentSource(documentSource);
    if (source.type !== 'project') return this.track(this.requireReviewDocuments().save({ projectId, source, relPath: normalizeRel(relPath), text, expectedDraftRevision, mode: 'retain' }));
    const rel = normalizeRel(relPath);
    return this.track(this.fileLock(projectId, rel)(async () => {
      const project = await this.requireRegisteredProject(projectId);
      // Retention never accesses the source path, which may now be a directory
      // or an inaccessible link. Require a baseline previously read by this host.
      const provenance=await this.storage.getRecovery(projectId,'provenance:'+rel);
      if(!provenance?.digests?.includes(baseDigest))throw new HostError('BASELINE_UNKNOWN','没有此文件的读取基线，未保存无来源副本。');
      const record = await this.persistDraft(project.id, rel, baseDigest, text, 'dirty');
      return {draft:{text:record.text,baseDigest:record.baseDigest,status:record.status,updatedAt:record.updatedAt}};
    }));
  }

  async readSource(abs) {
    const handle = await fs.open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new HostError('UNSUPPORTED', 'Source is not a regular file.');
      if (stat.size > this.maxReadBytes) throw new HostError('TOO_LARGE', 'File exceeds this development build limit.');
      const chunks = [];
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > this.maxReadBytes) throw new HostError('TOO_LARGE', 'File grew beyond the read limit.');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    } finally { await handle.close(); }
  }

  async backupBaseline(projectId, relPath, bytes, digest) {
    const dir = path.join(this.projectDir(projectId), 'baselines');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${draftKey(relPath)}-${digest}.bin`);
    try {
      await fs.lstat(file);
      return file;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const tmp = path.join(dir, `.tmp-${randomUUID()}`);
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(tmp, file);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        await fs.unlink(tmp).catch(() => {});
        throw error;
      }
    }
    await fs.unlink(tmp).catch(() => {});
    await syncDirectory(dir);
    return file;
  }

  async rememberMaterial(projectId, relPath, bytes) {
    const stored = await this.storage.putObject(projectId,bytes);
    await this.metaLock(async () => {
      const prior = await this.storage.getProject(projectId,'provenance',relPath);
      const digests = [...new Set([...(prior?.digests ?? []), stored.digest])];
      await this.storage.putProject(projectId,'provenance',relPath,{relPath,digests});
      await this.storage.putRecovery(projectId,'provenance:'+relPath,{relPath,digests});
    });
    return stored;
  }

  async replaceFile(abs, payload, { mode = 0o600, beforeCommit = async () => {}, createOnly = false } = {}) {
    const dir = path.dirname(abs);
    const tmp = path.join(dir, `.nozeli-tmp-${randomUUID()}`);
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(payload);
      await handle.chmod(mode & 0o777);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
    await handle.close();
    try {
      await beforeCommit();
      if (createOnly) {
        await fs.link(tmp, abs);
        await fs.unlink(tmp);
      } else await fs.rename(tmp, abs);
      await syncDirectory(dir);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async recoverSheet(projectId, relPath, raw) {
    const rel=normalizeRel(relPath);await this.requireProject(projectId);
    if(path.posix.extname(rel).toLowerCase()!=='.xlsx'||!(raw instanceof Uint8Array)||raw.byteLength>160*1024*1024)throw new HostError('INVALID_PAYLOAD','表格恢复数据无效。');
    const bytes=Buffer.from(raw),data=JSON.parse(bytes.toString('utf8'));
    if(data.schema!=='nozeli-sheet-recovery-v1'||!Array.isArray(data.sheets)||!Array.isArray(data.original))throw new HostError('INVALID_PAYLOAD','表格恢复快照无效。');
    return {recoveryPath:await this.backupBaseline(projectId,rel+'.recovery.json',bytes,digestBytes(bytes))};
  }

  async saveWord(projectId, relPath, baseDigest, raw, options = {}) { return this.saveOffice(projectId, relPath, baseDigest, raw, 'word', options); }
  async saveSheet(projectId, relPath, baseDigest, raw) { return this.saveOffice(projectId, relPath, baseDigest, raw, 'sheet'); }
  async saveOffice(projectId, relPath, baseDigest, raw, kind, {anchorChanges = null} = {}) {
    const rel = normalizeRel(relPath);
    if (path.posix.extname(rel).toLowerCase() !== (kind === 'word' ? '.docx' : '.xlsx') || typeof baseDigest !== 'string' || !/^[a-f0-9]{64}$/.test(baseDigest)) throw new HostError('INVALID_PAYLOAD', 'Office 保存参数无效。');
    if (!(raw instanceof Uint8Array) || raw.byteLength > 32 * 1024 * 1024) throw new HostError('INVALID_PAYLOAD', 'Office 文件数据无效。');
    const bytes = Buffer.from(raw);
    await (kind === 'word' ? validateWord : validateSheet)(bytes);
    return this.track(this.fileLock(projectId, rel)(async () => {
      const project = await this.requireProject(projectId);
      const located = await this.resolveFile(project, rel);
      const digest = digestBytes(bytes);
      // Keep every exported revision even when the original is missing or changes.
      const recoveryPath = await this.backupBaseline(projectId, rel, bytes, digest);
      const changes = kind === 'word' ? new FileChanges({storage:this.storage,projectId:project.id,root:project.root}) : null;
      const commit = async () => {
        try {
          if (located.missing) throw new HostError('DELETED', 'Office 原文件已删除，编辑副本已保留。', { recoveryPath });
          const disk = await this.readSource(located.abs);
          if (digestBytes(disk) !== baseDigest) throw new HostError('CONFLICT', 'Office 原文件已在外部修改，未覆盖；编辑副本已保留。', { recoveryPath });
          const stat = await fs.lstat(located.abs);
          if (stat.isSymbolicLink() || !stat.isFile()) throw new HostError('SYMLINK', '不能覆盖链接。', { recoveryPath });
          if (process.platform !== 'win32' && (stat.mode & 0o222) === 0) throw new HostError('READONLY', 'Office 文件只读，编辑副本已保留。', { recoveryPath });
          await this.backupBaseline(projectId, rel, disk, baseDigest);
          let history=null,candidate=null,authorshipText=null;
          if(changes){
            history=await changes.observe(rel,await wordText(disk),baseDigest,{textSpace:'docx-main-text'});
            authorshipText=await wordText(bytes);
            const mapping=textChangeSet(history.text,authorshipText,anchorChanges);
            candidate=digest===history.digest?history:changes.candidate(history,authorshipText,digest,mapping,userActor,{type:history.text===authorshipText?'word-format':'word-text'});
            if(candidate!==history)await changes.prepare(rel,history,candidate);
          }
          await this.replaceFile(located.abs, bytes, { mode: stat.mode, beforeCommit: async () => {
            const fresh = await this.resolveFile(project, rel);
            if (fresh.missing || fresh.abs !== located.abs || digestBytes(await this.readSource(fresh.abs)) !== baseDigest) throw new HostError('CONFLICT', 'Office 文件在保存时发生变化，编辑副本已保留。', { recoveryPath });
          } });
          if (digestBytes(await this.readSource(located.abs)) !== digest) throw new HostError('CONFLICT', 'Office 文件在保存后发生变化，编辑副本已保留。', { recoveryPath });
          if(changes&&candidate!==history)await changes.finish(rel,candidate);
          const stored = await this.rememberMaterial(projectId, rel, bytes);
          if(changes&&candidate!==history)this.onDocumentChange({projectId,relPath:rel,digest,actor:userActor});
          return { digest, materialDigest: stored.digest, byteLength: bytes.length, recoveryPath, ...(changes?{authorship:publicChanges(candidate),authorshipText}: {}) };
        } catch(error) { throw new HostError(error.code || 'SAVE_FAILED',error.message,{...error.details,recoveryPath}); }
      };
      return changes ? changes.withLock(rel,commit).catch(error=>{throw new HostError(error.code||'CHANGE_HISTORY_IO',error.message,{...error.details,recoveryPath});}) : commit();
    }));
  }

  async save(projectId, relPath, baseDigest, text, options = {}, documentSource) {
    const source = this.boundDocumentSource(documentSource);
    if (source.type !== 'project') {
      if (options.confirmOverwrite === true) throw new HostError('INVALID_PAYLOAD', '审校文档没有覆盖确认语义。');
      return this.track(this.requireReviewDocuments().save({ projectId, source, relPath: normalizeRel(relPath), text, baseDigest, expectedDraftRevision: Number.isSafeInteger(options.expectedDraftRevision) ? options.expectedDraftRevision : undefined, anchorChanges: options.anchorChanges ?? null, mode: 'save' }));
    }
    const rel = normalizeRel(relPath);
    return this.track(this.fileLock(projectId, rel)(async () => {
      const project = await this.requireProject(projectId);
      const located = await this.resolveFile(project, rel);
      const changeStore = new FileChanges({storage:this.storage,projectId:project.id,root:project.root});
      return changeStore.withLock(rel, () => this.saveLocked(project,located,baseDigest,text,{...options,changeStore}));
    }));
  }

  async saveLocked(project, located, baseDigest, text, { confirmOverwrite = false, anchorChanges = null, changeStore, actor = userActor, operationId = null, fingerprint = null, agentWrite = false, beforeReplace=()=>{}, type = null } = {}) {
      const projectId = project.id;
      const persist = async (digest, status, lastError) => {
        if (!agentWrite) return this.persistDraft(project.id, located.rel, digest, text, status, lastError);
        const bytes = Buffer.from(text,'utf8');
        return { updatedAt:Date.now(),recoveryPath:await this.backupBaseline(project.id,located.rel+'.agent-candidate',bytes,digestBytes(bytes)) };
      };
      let draftRecord;
      try {
        draftRecord = await persist(baseDigest, 'saving');
      } catch (error) {
        throw new HostError(error.code || 'DRAFT_FAILED', error.message || 'Draft could not be persisted.', { draftKept: false, memoryOnly: true });
      }
      const fail = async (code, message, details) => {
        await persist(baseDigest, 'conflict', { code, message });
        throw new HostError(code, message, { draftKept: !agentWrite, recoveryPath:draftRecord.recoveryPath, ...details });
      };
      if (located.missing) {
        if (!confirmOverwrite) {
          await fail('DELETED', 'File was deleted. Disk was left empty and the draft was kept.', {
            diskPresent: false,
            diskDigest: null,
            baseDigest,
          });
        }
        const ext = path.posix.extname(located.rel).toLowerCase();
        if (!TEXT_EXT.has(ext)) await fail('UNSUPPORTED', 'Only text files can be recreated from a draft.', { baseDigest });
        const payload = Buffer.from(text, 'utf8');
        const digest = digestBytes(payload);
        const stored = await this.rememberMaterial(projectId, located.rel, payload);
        const before = await changeStore.observe(located.rel,'',null);
        const candidate = changeStore.candidate(before,text,digest,textChangeSet('',text),actor,{operationId,fingerprint,type:'recreate'});
        await changeStore.prepare(located.rel,before,candidate);
        try {
          await this.replaceFile(located.abs, payload, { createOnly: true, beforeCommit: async () => {
            const checked = await this.resolveFile(project, located.rel);
            if (!checked.missing) throw new HostError('CONFLICT', 'File was recreated externally.');
          } });
          if (digestBytes(await this.readSource(located.abs)) !== digest) throw new HostError('CONFLICT', 'File changed after replacement.');
        } catch (error) {
          await fail(error.code === 'EEXIST' || error.code === 'CONFLICT' ? 'CONFLICT' : 'SAVE_FAILED', error.message, { baseDigest });
        }
        await changeStore.finish(located.rel,candidate);
        await persist(digest, 'saved');
        this.onDocumentChange({projectId,relPath:located.rel,digest,actor});
        return { digest, materialDigest: stored.digest, byteLength: payload.length, overwritten: true, authorship:publicChanges(candidate) };
      }
      let disk;
      try {
        disk = await this.readSource(located.abs);
      } catch (error) {
        const code = error.code === 'EACCES' || error.code === 'EPERM' ? 'ACCESS_DENIED' : 'SAVE_FAILED';
        await fail(code, 'File could not be read. Draft was kept.', { cause: error.code, baseDigest });
      }
      const diskDigest = digestBytes(disk);
      const stat = await fs.lstat(located.abs);
      if (stat.isSymbolicLink() || !stat.isFile()) await fail('SYMLINK', 'Refusing to replace a non-regular file.', { baseDigest });
      if (process.platform !== 'win32' && (stat.mode & 0o222) === 0) {
        await fail('READONLY', 'File is read-only. It was not modified and the draft was kept.', {
          diskDigest,
          baseDigest,
          diskPresent: true,
        });
      }
      if (diskDigest !== baseDigest && !confirmOverwrite) {
        await fail('CONFLICT', 'File changed after it was read. Disk content and the draft were both kept.', {
          diskDigest,
          baseDigest,
          diskPresent: true,
        });
      }
      const ext = path.posix.extname(located.rel).toLowerCase();
      if (ext === '.pdf' || OFFICE_EXT.has(ext) || !isUtf8Text(disk)) {
        await fail('UNSUPPORTED', 'This package only saves UTF-8 text. The file was not modified.', { diskDigest, baseDigest });
      }
      try {
        await this.backupBaseline(project.id, located.rel, disk, diskDigest);
      } catch (error) {
        await fail('SAVE_FAILED', 'Baseline backup failed. The original file was not modified.', {
          cause: error.code || error.message,
          diskDigest,
          baseDigest,
        });
      }
      const again = await this.resolveFile(project, located.rel);
      if (again.missing || again.abs !== located.abs) {
        await fail('CONFLICT', 'File changed while saving. Draft was kept.', { diskDigest, baseDigest });
      }
      const fresh = await this.readSource(located.abs);
      const freshDigest = digestBytes(fresh);
      if (freshDigest !== diskDigest) {
        await fail('CONFLICT', 'File changed between the check and the replace. Draft was kept.', {
          diskDigest: freshDigest,
          baseDigest,
          diskPresent: true,
        });
      }
      const payload = Buffer.from(text, 'utf8');
      const stored = await this.rememberMaterial(projectId, located.rel, payload);
      const digest = digestBytes(payload);
      const history = await changeStore.observe(located.rel,new TextDecoder('utf-8').decode(disk),diskDigest);
      const mapping = textChangeSet(history.text,text,diskDigest===baseDigest?anchorChanges:null);
      const candidate = digest === history.digest ? history : changeStore.candidate(history,text,digest,mapping,actor,{operationId,fingerprint,type: typeof type==='string' && /^[\w-]{1,40}$/.test(type) ? type : (confirmOverwrite?'overwrite':'edit')});
      if (candidate !== history) await changeStore.prepare(located.rel,history,candidate);
      await this.stageTagMappings(projectId, located.rel, disk, payload, diskDigest === baseDigest ? anchorChanges : null);
      try {
        await this.replaceFile(located.abs, payload, { mode: stat.mode, beforeCommit: async () => {
          const checked = await this.resolveFile(project, located.rel);
          if (checked.missing || digestBytes(await this.readSource(checked.abs)) !== diskDigest) {
            throw new HostError('CONFLICT', 'File changed during staging.');
          }
          if(agentWrite){const draft=await this.readDraftRecord(projectId,located.rel);if(draft?.draftError||draft&&draft.status!=='saved')throw new HostError('UNSAVED','用户草稿在保存期间变化，未覆盖。');}
          beforeReplace();
        } });
        if (digestBytes(await this.readSource(located.abs)) !== digest) throw new HostError('CONFLICT', 'File changed after replacement; draft retained.');
      } catch (error) {
        const code = ['CONFLICT','WORK_STOPPED','UNSAVED'].includes(error.code) ? error.code : error.code === 'EACCES' || error.code === 'EPERM' ? 'ACCESS_DENIED' : 'SAVE_FAILED';
        await fail(code, 'Replace failed. The original file was left in place if the rename did not complete.', {
          cause: error.code || error.message,
          diskDigest,
          baseDigest,
        });
      }
      if (candidate !== history) await changeStore.finish(located.rel,candidate);
      await persist(digest, 'saved');
      if (candidate !== history) this.onDocumentChange({projectId,relPath:located.rel,beforeDigest:diskDigest,digest,materialDigest:stored.digest,actor,text,changes:mapping.toJSON(),authorship:publicChanges(candidate),eventId:candidate.events.at(-1)?.id,revision:candidate.revision});
      return { digest, materialDigest: stored.digest, byteLength: payload.length, overwritten: confirmOverwrite && diskDigest !== baseDigest, draftUpdatedAt: draftRecord.updatedAt, authorship:publicChanges(candidate), eventId:candidate.events.at(-1)?.id, revision:candidate.revision };
  }

  async readState(projectId) {
    return this.track((async () => {
      await this.requireRegisteredProject(projectId);
      const state = await this.storage.getLocal(projectId,'view');
      if (!state) return { state: null };
      return { state: this.readBoundState(state), files: state.files ?? {} };
    })());
  }

  boundState(input, { strictOffsets = false } = {}) {
    const currentRelPath = typeof input.currentRelPath === 'string' && input.currentRelPath.length <= MAX_REL
      ? input.currentRelPath
      : null;
    const pdfPage = Number.isInteger(input.pdfPage) && input.pdfPage >= 1 && input.pdfPage <= 100000 ? input.pdfPage : 1;
    const scrollTop = Number.isFinite(input.scrollTop) && input.scrollTop >= 0 && input.scrollTop <= 1e9 ? input.scrollTop : 0;
    const w = input.workspace && typeof input.workspace === 'object' ? input.workspace : {};
    const number = (key, fallback, min, max) => Number.isFinite(w[key]) ? Math.min(max, Math.max(min, w[key])) : fallback;
    const workspace = {
      openFiles: [...new Set((Array.isArray(w.openFiles)?w.openFiles:[]).filter(p=>typeof p==='string'&&p.length<=MAX_REL&&!p.startsWith('/')&&!p.split('/').includes('..')))].slice(0,200),
      openFilesCollapsed:w.openFilesCollapsed===true,
      filesWidth: number('filesWidth',174,140,650), sideWidth: number('sideWidth',288,180,650),
      workRatio: number('workRatio',53.5,10,90), terminalRatio: number('terminalRatio',50,20,80),
      projectView: w.projectView === 'terminal' ? 'terminal' : 'reading',
      filesCollapsed: w.filesCollapsed === true, sideCollapsed: w.sideCollapsed === true,
      dock: ['top','right','bottom','left'].includes(w.dock) ? w.dock : 'bottom',
      floating: w.floating === true, minimized: w.minimized === true,
      chatExpanded: w.chatExpanded === true,
      ...(typeof w.chatCompact === 'boolean' ? {chatCompact:w.chatCompact} : {}),
      chatLayoutExplicit: w.chatLayoutExplicit === true,
      readingWidth: number('readingWidth',72,60,100),
      chatWidth: number('chatWidth', 320, 180, 900), chatHeight: number('chatHeight', 210, 120, 800),
      x: number('x', 240, 0, 10000), y: number('y', 180, 0, 10000),
      fontSize: number('fontSize', 14, 11, 24), conversationFontSize: number('conversationFontSize', 14, 11, 24), split: number('split', 50, 25, 75),
      draft: typeof w.draft === 'string' ? w.draft.slice(0, 20000) : '',
      noteOffsets: boundNoteOffsets(w.noteOffsets, { strict: strictOffsets }),
      noteDrafts: boundNoteDrafts(w.noteDrafts),
      confirmationSkips:Object.fromEntries(['closeDocument','closeCompare','removeTag','deleteNote'].filter(key=>typeof w.confirmationSkips?.[key]==='boolean').map(key=>[key,w.confirmationSkips[key]])),
    };
    const projectSettingsIn = input.projectSettings && typeof input.projectSettings === 'object' ? input.projectSettings : {};
    const projectSettings = { focusMode: projectSettingsIn.focusMode === true };
    const v=input.fileView||{},selection=v.selection;
    const fileView={textMode:['read','edit','split'].includes(v.textMode)?v.textMode:null,selection:selection&&Number.isInteger(selection.from)&&Number.isInteger(selection.to)&&selection.from>=0&&selection.to>=selection.from?{from:selection.from,to:selection.to,anchor:selection.anchor===selection.to?selection.to:selection.from,head:selection.head===selection.from?selection.from:selection.to}:null,zoom:v.zoom&&Number.isFinite(v.zoom.scale)?{scale:Math.max(.05,Math.min(8,v.zoom.scale)),mode:['fit','manual','width','page','actual'].includes(v.zoom.mode)?v.zoom.mode:'manual'}:null};
    if (v.markdownPreview && typeof v.markdownPreview === 'object') fileView.markdownPreview = {
      linked: v.markdownPreview.linked !== false,
      ratio: Number.isFinite(v.markdownPreview.ratio) ? Math.max(25, Math.min(75, v.markdownPreview.ratio)) : 50,
      scrollTop: Number.isFinite(v.markdownPreview.scrollTop) ? Math.max(0, Math.min(1e9, v.markdownPreview.scrollTop)) : 0,
    };
    return { currentRelPath, pdfPage, scrollTop, projectSettings, workspace, fileView, updatedAt: input.updatedAt ?? null };
  }

  readBoundState(input) {
    const workspaceIn = input.workspace && typeof input.workspace === 'object' ? input.workspace : {};
    const state = this.boundState({ ...input, workspace: { ...workspaceIn, noteDrafts: [] } });
    const read = readDraftList(workspaceIn.noteDrafts);
    const already = mergeRetained(Array.isArray(workspaceIn.retainedNoteDrafts) ? workspaceIn.retainedNoteDrafts : [], []);
    state.workspace.noteDrafts = read.noteDrafts;
    state.workspace.retainedNoteDrafts = mergeRetained(already, read.retainedNoteDrafts);
    return state;
  }

  async writeState(projectId, input) {
    return this.track(this.metaLock(async () => {
      await this.requireRegisteredProject(projectId);
      const state = { ...this.boundState(input ?? {}, { strictOffsets: true }), updatedAt: new Date().toISOString() };
      const previous = await this.storage.getLocal(projectId,'view');
      const prior = previous ? this.readBoundState(previous).workspace : null;
      if (!Object.hasOwn(input ?? {}, 'workspace') && prior) state.workspace = prior;
      else state.workspace.retainedNoteDrafts = mergeRetained(prior?.retainedNoteDrafts, []);
      if(!Object.hasOwn(input?.workspace??{},'confirmationSkips')&&prior?.confirmationSkips)state.workspace.confirmationSkips=prior.confirmationSkips;
      state.files = { ...(previous?.files ?? {}) };
      if (state.currentRelPath) {
        const fileView = this.readBoundState(state);
        delete fileView.workspace;
        state.files[normalizeRel(state.currentRelPath)] = fileView;
      }
      await this.storage.putLocal(projectId,'view',state);
      return { state };
    }));
  }


  async tagStore(projectId, documentSource) {
    const project = await this.requireProject(projectId);
    const source = this.boundDocumentSource(documentSource);
    return new FileTags({ storage: this.storage, projectId: project.id, root: project.root, ...(source.type !== 'project' ? { namespace: reviewTagNamespace(source) } : {}) });
  }
  // The exact bytes a review document currently presents for anchor
  // resolution: the saved human draft when present, else the frozen candidate
  // (or the pinned version for review-version sources). Never project disk.
  async reviewDocumentBytes(projectId, documentSource, relPath) {
    const source = this.boundDocumentSource(documentSource);
    if (source.type === 'project') return null;
    return this.requireReviewDocuments().currentBytes({ projectId, source, relPath: normalizeRel(relPath) });
  }

  async resolveTag(store, record, bytes) {
    const resolution = await this.resolveTagPosition(store, record, bytes);
    return { ...resolution, advisory: anchorAdvisory(resolution, record.kind) };
  }

  async resolveTagPosition(store, record, bytes) {
    const targetDigest = bytes ? digestBytes(bytes) : null;
    const base = { targetDigest, anchor: null, locationStatus: 'unresolved', contentStatus: 'unknown', method: 'missing-source' };
    if (!bytes) return base;
    if (record.kind === 'file') return { ...base, anchor: record.anchor, locationStatus: 'exact', contentStatus: targetDigest === record.materialDigest ? 'unchanged' : 'modified', method: 'file-resource' };
    const known = record.resolutions?.[targetDigest];
    if (known?.anchor && record.kind === 'text-selection' && !validTextAnchor(known.anchor, anchorText(bytes.toString('utf8')))) return { ...base, method: 'invalid-cached-anchor' };
    if (known?.anchor && record.kind === 'text-point' && !validTextPointAnchor(known.anchor, anchorText(bytes.toString('utf8')))) return { ...base, method: 'invalid-cached-anchor' };
    if (known?.method === 'manual' && record.kind.startsWith('ppt-')) {
      try {
        const snapshot = await pptSnapshot(store.storage, store.projectId, record.relPath, targetDigest);
        if (known.sourceDraftDigest !== snapshot.digest) return { ...base, method: 'changed-ppt-draft' };
      } catch { return { ...base, method: 'missing-ppt-draft' }; }
    }
    if (known?.method === 'manual') return { ...known, targetDigest };
    if (targetDigest === record.materialDigest) {
      if (record.kind === 'text-point' && !validTextPointAnchor(record.anchor, anchorText(bytes.toString('utf8')))) return { ...base, method: 'invalid-origin-anchor' };
      return { ...base, anchor: record.anchor, locationStatus: 'exact', contentStatus: 'unchanged', method: 'same-material' };
    }
    if (known) {
      return { ...known, targetDigest };
    }
    if (record.kind === 'word-selection') return {targetDigest, ...locateWordQuote(await wordText(bytes),record.anchor)};
    if (record.kind === 'text-point') {
      const origin = await store.getMaterial(record.materialDigest);
      if (!isUtf8Text(bytes) || !isUtf8Text(origin)) return { ...base, method: 'not-text' };
      return { targetDigest, ...resolveTextPointAnchor(record.anchor, origin.toString('utf8'), bytes.toString('utf8')) };
    }
    if (record.kind !== 'text-selection') return { ...base, method: 'unknown-image-or-page-change' };
    const origin = await store.getMaterial(record.materialDigest);
    if (!isUtf8Text(bytes) || !isUtf8Text(origin)) return { ...base, method: 'not-text' };
    return { targetDigest, ...resolveTextAnchor(record.anchor, origin.toString('utf8'), bytes.toString('utf8')) };
  }

  async listAnnotations(projectId, relPath, documentSource) {
    return this.track((async () => {
      const source = this.boundDocumentSource(documentSource);
      const project = await this.requireProject(projectId), store = source.type === 'project'
        ? new FileTags({storage:this.storage,projectId:project.id,root:project.root})
        : await this.tagStore(projectId, source);
      const filter = relPath == null ? null : normalizeRel(relPath);
      const files = filter ? [await store.read(filter)].filter(Boolean) : await store.all();
      const annotations = [];
      for (const file of files) {
        let bytes = null;
        if (source.type === 'project') {
          const located = await this.resolveFile(project, file.file.relPath);
          bytes = located.missing ? null : await this.readSource(located.abs);
        } else {
          bytes = await this.reviewDocumentBytes(projectId, source, file.file.relPath);
        }
        for (const record of file.tags) {
          const resolution = await this.resolveTag(store, record, bytes);
          annotations.push({ ...record, projectId, fileId: file.file.fileId, ...(source.type !== 'project' ? { documentSource: structuredClone(source) } : {}), resolution, sourceChanged: resolution.targetDigest !== record.materialDigest });
        }
      }
      annotations.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      return { annotations };
    })());
  }

  async stageTagMappings(projectId, relPath, before, after, mapping = null, documentSource) {
    return this.metaLock(async () => {
      const store = await this.tagStore(projectId, documentSource), file = await store.read(relPath);
      if (!file) return;
      const beforeDigest = digestBytes(before), afterDigest = digestBytes(after);
      const changes = mapping == null ? null : textChangeSet(before.toString('utf8'), after.toString('utf8'), mapping);
      await store.putMaterial(before); await store.putMaterial(after);
      const tags = [];
      for (const tag of file.tags) {
        const previous = await this.resolveTag(store, tag, before);
        const resolution = changes && previous.anchor && ['text-selection', 'text-point'].includes(tag.kind)
          ? { targetDigest: afterDigest, ...(tag.kind === 'text-point' ? mapTextPointAnchor(previous.anchor, before.toString('utf8'), after.toString('utf8'), changes) : mapTextAnchor(previous.anchor, before.toString('utf8'), after.toString('utf8'), changes)) }
          : await this.resolveTag(store, tag, after);
        // An edited span remains modified relative to its origin on later shifts.
        if (afterDigest !== tag.materialDigest && previous.contentStatus === 'modified' && resolution.contentStatus === 'unchanged') resolution.contentStatus = 'modified';
        tags.push({ ...tag, resolutions: { ...(tag.resolutions || {}), [afterDigest]: resolution } });
      }
      // Stage by target digest before changing the source. A crash cannot project
      // this mapping onto an unmatched source version; retry is idempotent.
      await store.write(relPath, { ...file, file: { ...file.file, sourceDigest: afterDigest }, tags }, file.revision);
    });
  }

  async addAnnotation(projectId, input) {
    return this.track((async () => {
      const project = await this.requireProject(projectId);
      const source = this.boundDocumentSource(input?.documentSource);
      const relPath = normalizeRel(input?.relPath);
      if (source.type === 'project') await this.resolveFile(project, relPath);
      const materialDigest = input?.materialDigest;
      if (typeof materialDigest !== 'string' || !/^[a-f0-9]{64}$/.test(materialDigest)) {
        throw new HostError('INVALID_PAYLOAD', 'Annotation requires a material digest.');
      }
      let material;
      if (source.type === 'project') {
        material = await this.storage.readObject(projectId,materialDigest);
        const provenance = await this.storage.getProject(projectId,'provenance',relPath);
        if (!provenance?.digests?.includes(materialDigest)) throw new HostError('ANCHOR_MISMATCH', 'Material does not belong to this document.');
      } else {
        // Review materials are validated against this publication's frozen
        // candidate and saved draft digests — never the same-path project file.
        // Position anchors are text-only; file discussions bind the resource.
        if (!['text-selection', 'text-point', 'file'].includes(input?.kind)) throw new HostError('UNSUPPORTED', '审校文档仅支持文本选区、位置备注与文件讨论。');
        const allowed = await this.requireReviewDocuments().materials({ projectId, source, relPath });
        const bytes = allowed.get(materialDigest);
        if (!bytes) throw new HostError('ANCHOR_MISMATCH', '备注材料不属于此审校文档的冻结候选或人工草稿。');
        material = bytes;
        await this.storage.putObject(projectId, bytes);
      }
      const kind = input?.kind;
      const anchor = input?.anchor;
      let storedAnchor;
      if (kind === 'file') {
        if (!anchor || anchor.scope !== 'file' || Object.keys(anchor).some(key => key !== 'scope')) throw new HostError('INVALID_ANCHOR', '文件讨论只能绑定整个文件。');
        if (input.regionImage || input.drawing || input.annotatedImage) throw new HostError('INVALID_ANCHOR', '文件讨论不能携带位置截图或涂鸦。');
        storedAnchor = { scope: 'file' };
      } else if(kind==='image-region'){
        if(!imageExtension.test(relPath))throw new HostError('ANCHOR_MISMATCH','不是受支持图片');
        const info=imageInfo(material);storedAnchor=boundAnchor(anchor,kind);
        if(info.width!==storedAnchor.width||info.height!==storedAnchor.height)throw new HostError('ANCHOR_MISMATCH','图片尺寸与冻结原件不一致');
        if(!input.regionImage)throw new HostError('INVALID_ANCHOR','图片区域必须携带截图');
      } else if(kind==='ppt-selection'||kind==='ppt-region'){
        if(path.posix.extname(relPath).toLowerCase()!=='.pptx')throw new HostError('ANCHOR_MISMATCH','不是 PPTX 文档');
        storedAnchor=boundAnchor(anchor,kind);
      } else if (kind === 'word-region') {
        if(path.posix.extname(relPath).toLowerCase()!=='.docx')throw new HostError('ANCHOR_MISMATCH','不是 Word 文档。');
        await validateWord(material);storedAnchor=boundAnchor(anchor,kind);
      } else if (kind === 'word-selection') {
        if (path.posix.extname(relPath).toLowerCase() !== '.docx') throw new HostError('ANCHOR_MISMATCH','不是 Word 文档。');
        storedAnchor = validateWordAnchor(anchor);
        if (!locateWordQuote(await wordText(material),storedAnchor).anchor) throw new HostError('ANCHOR_MISMATCH','Word 引文不存在或位置有歧义，请扩大选区后重试。');
      } else if (kind === 'text-selection') {
        const start = anchor?.start;
        const end = anchor?.end;
        const quote = anchor?.quote;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || typeof quote !== 'string') {
          throw new HostError('INVALID_ANCHOR', 'Text note requires start, end, and quote.');
        }
        if (Object.keys(anchor).some((key) => !['start', 'end', 'quote'].includes(key))) {
          throw new HostError('INVALID_ANCHOR', 'Text note anchor has unsupported fields.');
        }
        let text;
        try {
          text = anchorText(new TextDecoder('utf-8', { fatal: true }).decode(material));
        } catch {
          throw new HostError('ANCHOR_MISMATCH', 'Material is not UTF-8 text.');
        }
        if (end > text.length) throw new HostError('INVALID_ANCHOR', 'Selection is outside the material.');
        if (classify(relPath, material).kind !== 'text' || text.slice(start, end) !== quote) {
          throw new HostError('ANCHOR_MISMATCH', 'Quote does not match the frozen material. It was not rebound.');
        }
        storedAnchor = { start, end, quote };
      } else if (kind === 'text-point') {
        if (Object.keys(anchor || {}).some((key) => !['start', 'end', 'quote'].includes(key))) throw new HostError('INVALID_ANCHOR', 'Text point anchor has unsupported fields.');
        if (!Number.isInteger(anchor?.start) || anchor.start !== anchor.end || anchor.start < 0 || anchor.quote !== '') throw new HostError('INVALID_ANCHOR', 'Text point anchor must be zero-length without a quote.');
        let text;
        try {
          text = anchorText(new TextDecoder('utf-8', { fatal: true }).decode(material));
        } catch {
          throw new HostError('ANCHOR_MISMATCH', 'Material is not UTF-8 text.');
        }
        if (anchor.start > text.length) throw new HostError('INVALID_ANCHOR', 'Text point is outside the material.');
        if (classify(relPath, material).kind !== 'text') throw new HostError('ANCHOR_MISMATCH', 'Material is not the annotated text file.');
        storedAnchor = { start: anchor.start, end: anchor.end, quote: '' };
      } else if (kind === 'pdf-point') {
        if (material.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HostError('ANCHOR_MISMATCH', 'Material is not PDF.');
        storedAnchor = boundAnchor(anchor, kind);
      } else if (kind === 'image-point') {
        if (!imageExtension.test(relPath)) throw new HostError('ANCHOR_MISMATCH', '不是受支持图片');
        const info = imageInfo(material);
        storedAnchor = boundAnchor(anchor, kind);
        if (info.width !== storedAnchor.width || info.height !== storedAnchor.height) throw new HostError('ANCHOR_MISMATCH', '图片尺寸与冻结原件不一致');
      } else if (kind === 'ppt-point') {
        if (path.posix.extname(relPath).toLowerCase() !== '.pptx') throw new HostError('ANCHOR_MISMATCH', '不是 PPTX 文档');
        storedAnchor = boundAnchor(anchor, kind);
      } else if (kind === 'pdf-page') {
        const page = anchor?.page;
        if (!Number.isInteger(page) || page < 1 || page > 100000) {
          throw new HostError('INVALID_ANCHOR', 'PDF note requires a page number. This package does not store region anchors.');
        }
        if (!anchor || Object.keys(anchor).some((key) => key !== 'page')) {
          throw new HostError('INVALID_ANCHOR', 'PDF page note cannot carry a region or text-layer anchor.');
        }
        if (material.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HostError('ANCHOR_MISMATCH', 'Material is not PDF.');
        storedAnchor = { page };
      } else if (kind === 'pdf-region' || kind === 'pdf-selection') {
        if (material.subarray(0,5).toString('latin1') !== '%PDF-') throw new HostError('ANCHOR_MISMATCH', 'Material is not PDF.');
        if (!Number.isInteger(anchor?.page) || anchor.page < 1 || anchor.page > 100000 || ![0,90,180,270].includes(anchor.rotation) || anchor.space !== 'rendered-page-normalized') throw new HostError('INVALID_ANCHOR', 'Invalid PDF page/coordinate space.');
        if (Object.keys(anchor).some(key => !['page','rotation','space','rects','quote'].includes(key))) throw new HostError('INVALID_ANCHOR', 'Unexpected PDF anchor fields.');
        const rects = anchor.rects;
        if (!Array.isArray(rects) || !rects.length || rects.length > 1000 || rects.some(r => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite) || r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0 || r[0]+r[2] > 1.000001 || r[1]+r[3] > 1.000001)) throw new HostError('INVALID_ANCHOR', 'PDF selection must be inside the frozen page.');
        if (typeof anchor.quote !== 'string' || anchor.quote.length > 20000 || (kind === 'pdf-selection' && !anchor.quote.trim())) throw new HostError('INVALID_ANCHOR', 'PDF text selection requires a quote.');
        storedAnchor = { page: anchor.page, rotation: anchor.rotation, space: anchor.space, rects, quote: anchor.quote };
      } else {
        throw new HostError('INVALID_ANCHOR', 'Unsupported annotation kind.');
      }
      if (typeof input.note !== 'string' || input.note.length > MAX_NOTE) {
        throw new HostError('INVALID_PAYLOAD', 'Note text is missing or too large.');
      }
      const now = new Date().toISOString();
      return this.metaLock(async () => {
      const store = source.type === 'project' ? new FileTags({storage:this.storage,projectId:project.id,root:project.root}) : await this.tagStore(projectId, source);
      await store.putMaterial(material);
      const sidecar = await store.read(relPath);
      const ordinal = (sidecar?.nextOrdinal || 1);
      const information=await buildAnnotationPackage({store,userDataDir:this.userDataDir,projectId,relPath,kind,anchor:storedAnchor,materialDigest,material,image:input.regionImage,drawing:input.drawing,annotatedImage:input.annotatedImage,sourceDraftDigest:input.sourceDraftDigest,displayLocation:input.displayLocation});
      const record = {
        information,
        schemaVersion: SCHEMA,
        id: input.tagId && /^[0-9a-f-]{36}$/i.test(input.tagId) ? input.tagId : randomUUID(),
        ordinal,
        projectId,
        relPath,
        materialDigest,
        kind,
        anchor: storedAnchor,
        note: input.note,
        createdAt: now,
        updatedAt: now,
        ...(source.type !== 'project' ? { documentSource: structuredClone(source) } : {}),
        ...(input.projection ? { projection: this.tagProjection(input.projection) } : {}),
      };
      if ((sidecar?.tags || []).some(tag => tag.id === record.id)) throw new HostError('ANNOTATION_CONFLICT', 'Tag already exists.');
      await store.write(relPath, { ...sidecar, file: { ...sidecar?.file, sourceDigest: materialDigest }, tags: [...(sidecar?.tags || []), record], nextOrdinal: ordinal + 1 }, sidecar?.revision ?? null);
      return { annotation: { ...record, sourceChanged: false } };
      });
    })());
  }

  async updateAnnotation(projectId, annotationId, input) {
    return this.track(this.metaLock(async () => {
      await this.requireProject(projectId);
      if (typeof annotationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(annotationId)) throw new HostError('NOT_FOUND', 'Annotation was not found.');
      const store = await this.tagStore(projectId, input?.documentSource);
      const sidecar = (await store.all()).find(file => file.tags.some(tag => tag.id === annotationId));
      const record = sidecar?.tags.find(tag => tag.id === annotationId);
      if (!record) throw new HostError('NOT_FOUND', 'Annotation was not found.');
      if (typeof input?.materialDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.materialDigest)) throw new HostError('INVALID_PAYLOAD', 'Annotation material digest is required.');
      if (typeof input?.expectedUpdatedAt !== 'string' || !input.expectedUpdatedAt) throw new HostError('INVALID_PAYLOAD', 'Annotation expectedUpdatedAt is required.');
      if (typeof input?.note !== 'string' || input.note.length > MAX_NOTE) throw new HostError('INVALID_PAYLOAD', 'Note text is missing or too large.');
      if (record.materialDigest !== input.materialDigest) throw new HostError('ANCHOR_MISMATCH', 'Annotation material does not match.');
      if (record.updatedAt !== input.expectedUpdatedAt) throw new HostError('ANNOTATION_CONFLICT', 'Annotation was changed by another writer.');
      if (input.execute !== undefined && !validExecuteRef(input.execute)) throw new HostError('INVALID_PAYLOAD', 'Invalid execute reference.');
      const previousMs = Date.parse(record.updatedAt);
      const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : Date.now())).toISOString();
      const next = { ...record, note: input.note, updatedAt, ...(input.execute !== undefined ? { execute: validExecuteRef(input.execute) ? { jobId: input.execute.jobId } : null } : {}) };
      await store.write(record.relPath, { ...sidecar, tags: sidecar.tags.map(tag => tag.id === annotationId ? next : tag) }, sidecar.revision);
      return { annotation: next };
    }));
  }

  async removeAnnotation(projectId, annotationId, documentSource) {
    return this.track(this.metaLock(async () => {
      const store = await this.tagStore(projectId, documentSource);
      const sidecar = (await store.all()).find(file => file.tags.some(tag => tag.id === annotationId));
      if (!sidecar) throw new HostError('NOT_FOUND', 'Annotation was not found.');
      await store.write(sidecar.file.relPath, { ...sidecar, tags: sidecar.tags.filter(tag => tag.id !== annotationId) }, sidecar.revision);
      return { removed: true, annotationId };
    }));
  }

  tagProjection(value) {
    if (!value || !['discuss', 'explain'].includes(value.kind) || typeof value.text !== 'string' || value.text.length > 20000 || typeof value.draftText !== 'string' || value.draftText.length > 20000 || !Array.isArray(value.history) || value.history.length > 1000) throw new HostError('INVALID_PAYLOAD', 'Invalid conversation projection.');
    const messageIds=ids=>{if(ids==null)return [];if(!Array.isArray(ids)||ids.length>10000||ids.some(id=>typeof id!=='string'||id.length>512))throw new HostError('INVALID_PAYLOAD','Invalid reply identities.');return [...new Set(ids)];};
    const out = { kind: value.kind, text: value.text, draftText: value.draftText, open: value.open !== false, removed: value.removed === true, status: String(value.status || 'draft'), requestId: value.requestId || null, messageId: value.messageId || null, messageIds:messageIds(value.messageIds),
      history: value.history.map(entry => ({ requestId: entry.requestId || null, messageId: entry.messageId || null,messageIds:messageIds(entry.messageIds), question: typeof entry.question === 'string' ? entry.question.slice(0, 20000) : '', status: String(entry.status || '') })),
      execute: value.execute && validExecuteRef(value.execute) ? { jobId: value.execute.jobId } : null };
    if (JSON.stringify(out).length > 1024 * 1024) throw new HostError('INVALID_PAYLOAD', 'Conversation projection is too large.');
    return out;
  }

  async putTag(projectId, input) {
    if (!/^[0-9a-f-]{36}$/i.test(input?.tagId)) throw new HostError('INVALID_PAYLOAD', 'A stable tag UUID is required.');
    const store = await this.tagStore(projectId, input?.documentSource), rel = normalizeRel(input?.relPath);
    const sidecar = await store.read(rel), existing = sidecar?.tags.find(tag => tag.id === input.tagId);
    if (!existing) return this.addAnnotation(projectId, { ...input, relPath: rel, note: '', projection: this.tagProjection(input.projection) });
    return this.track(this.metaLock(async () => {
      const latest = await store.read(rel), record = latest?.tags.find(tag => tag.id === input.tagId);
      if (!record || record.materialDigest !== input.materialDigest) throw new HostError('ANNOTATION_CONFLICT', 'Tag origin changed or was removed.');
      const next = { ...record, projection: this.tagProjection(input.projection) };
      await store.write(rel, { ...latest, tags: latest.tags.map(tag => tag.id === record.id ? next : tag) }, latest.revision);
      return { annotation: next };
    }));
  }

  async tagView(projectId, input) {
    return this.track(this.metaLock(async () => {
      const store = await this.tagStore(projectId, input?.documentSource), rel = normalizeRel(input?.relPath), file = await store.read(rel);
      const tag = file?.tags.find(tag => tag.id === input.annotationId);
      if (!tag) throw new HostError('NOT_FOUND', 'Tag was not found.');
      if (typeof input.collapsed !== 'boolean') throw new HostError('INVALID_PAYLOAD', 'Collapsed state must be boolean.');
      await store.write(rel, { ...file, tags: file.tags.map(t => t.id === tag.id ? { ...t, view: { ...t.view, collapsed: input.collapsed } } : t) }, file.revision);
      return { saved: true };
    }));
  }

  async reanchorTag(projectId, input) {
    return this.track(this.metaLock(async () => {
      const project = await this.requireProject(projectId), source = this.boundDocumentSource(input?.documentSource), store = source.type === 'project' ? new FileTags({storage:this.storage,projectId:project.id,root:project.root}) : await this.tagStore(projectId, source), rel = normalizeRel(input?.relPath);
      const file = await store.read(rel), tag = file?.tags.find(t => t.id === input.annotationId);
      if (!tag) throw new HostError('NOT_FOUND', 'Tag was not found in this document.');
      if ((input.kind != null && input.kind !== tag.kind) || (input.materialDigest != null && input.materialDigest !== tag.materialDigest)) throw new HostError('ANCHOR_MISMATCH', 'Relocation cannot change the tag kind or original material.');
      if (input.expectedUpdatedAt != null && input.expectedUpdatedAt !== tag.updatedAt) throw new HostError('ANNOTATION_CONFLICT', 'Tag changed before relocation.');
      const bytes = source.type === 'project'
        ? await this.readSource((await this.resolveFile(project, rel)).abs)
        : await this.reviewDocumentBytes(projectId, source, rel);
      if (bytes === null) throw new HostError('NOT_FOUND', '此文档当前没有可定位的正文。');
      const digest = digestBytes(bytes);
      if (digest !== input.targetDigest) throw new HostError('CONFLICT', 'Document changed before relocation.');
      const current = boundAnchor(input.anchor, tag.kind);
      let sourceDraftDigest;
      if (tag.kind === 'text-selection' || tag.kind === 'text-point') {
        const valid = tag.kind === 'text-point' ? validTextPointAnchor : validTextAnchor;
        if (classify(rel, bytes).kind !== 'text' || !isUtf8Text(bytes) || !valid(current, anchorText(bytes.toString('utf8')))) throw new HostError('INVALID_ANCHOR', 'Relocation must match the current text.');
      } else if (tag.kind === 'word-selection' || tag.kind === 'word-region') {
        if (path.posix.extname(rel).toLowerCase() !== '.docx') throw new HostError('ANCHOR_MISMATCH', 'Relocation requires the current Word document.');
        if (tag.kind === 'word-selection') {
          if (!locateWordQuote(await wordText(bytes), current).anchor) throw new HostError('ANCHOR_MISMATCH', 'Word selection is missing or ambiguous in the saved document.');
        } else await validateWord(bytes);
      } else if (tag.kind.startsWith('image-')) {
        if (!imageExtension.test(rel)) throw new HostError('ANCHOR_MISMATCH', 'Relocation requires an image.');
        const info = imageInfo(bytes);
        if (info.width !== current.width || info.height !== current.height) throw new HostError('ANCHOR_MISMATCH', 'Image dimensions changed before relocation.');
      } else if (tag.kind.startsWith('pdf-')) {
        if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HostError('ANCHOR_MISMATCH', 'Relocation requires a PDF.');
      } else if (tag.kind.startsWith('ppt-')) {
        if (source.type !== 'project' || path.posix.extname(rel).toLowerCase() !== '.pptx') throw new HostError('ANCHOR_MISMATCH', 'Relocation requires the current PPT document.');
        const snapshot = await pptSnapshot(this.storage, projectId, rel, digest);
        if (input.sourceDraftDigest !== snapshot.digest) throw new HostError('CONFLICT', 'PPT draft changed before relocation.');
        sourceDraftDigest = snapshot.digest;
        const slide = snapshot.model.slides.find(slide => slide.id === current.slideId);
        if (!slide) throw new HostError('ANCHOR_MISMATCH', 'Selected PPT slide no longer exists.');
        if (tag.kind === 'ppt-selection') {
          const element = slide.elements.find(element => element.id === current.elementId);
          // PPTist stores rich text as HTML. Compare its text content using the
          // same DOM text semantics as the selection driver, not raw markup.
          const { DOMParser } = await import('@xmldom/xmldom');
          const text = element && new DOMParser().parseFromString('<div>' + (element.content || element.text?.content || '') + '</div>', 'text/html').documentElement.textContent;
          if (!element || !locateWordQuote(text, current).anchor) throw new HostError('ANCHOR_MISMATCH', 'Selected PPT text no longer matches the saved object.');
        } else {
          const layout = JSON.stringify(slide.elements.map(e => [e.id,e.left,e.top,e.width,e.height,e.rotate,e.content,e.text?.content,e.src?.length]));
          if (current.layout !== layout) throw new HostError('ANCHOR_MISMATCH', 'Selected PPT layout changed before relocation.');
        }
        await store.putMaterial(snapshot.bytes);
      }
      const resolution = { targetDigest: digest, anchor: current, method: 'manual', locationStatus: 'exact', contentStatus: 'modified', ...(sourceDraftDigest ? { sourceDraftDigest } : {}) };
      await store.putMaterial(bytes);
      const latestBytes = source.type === 'project'
        ? await this.readSource((await this.resolveFile(project, rel)).abs)
        : await this.reviewDocumentBytes(projectId, source, rel);
      if (!latestBytes || digestBytes(latestBytes) !== digest) throw new HostError('CONFLICT', 'Document changed while validating relocation.');
      if (sourceDraftDigest && (await pptSnapshot(this.storage, projectId, rel, digest)).digest !== sourceDraftDigest) throw new HostError('CONFLICT', 'PPT draft changed while validating relocation.');
      const updatedAt = new Date(Math.max(Date.now(), (Date.parse(tag.updatedAt) || 0) + 1)).toISOString();
      const next = { ...tag, updatedAt, resolutions: { ...tag.resolutions, [digest]: resolution }, relocations: [...(tag.relocations || []), { ...resolution, createdAt: updatedAt }] };
      await store.write(rel, { ...file, tags: file.tags.map(t => t.id === tag.id ? next : t) }, file.revision);
      return { saved: true };
    }));
  }

  async drawingMaterial(projectId,input,update=false){
    if(this.boundDocumentSource(input?.documentSource).type!=='project')throw new HostError('UNSUPPORTED','审校文档不支持涂鸦区域备注。');
    return this.track(this.metaLock(async()=>{
      const project=await this.requireProject(projectId),store=await this.tagStore(projectId),rel=normalizeRel(input.relPath),file=await store.read(rel),record=file?.tags.find(t=>t.id===input.annotationId);
      if(!record?.information?.drawing)throw new HostError('NOT_FOUND','涂鸦标签不存在');
      const located=await this.resolveFile(project,rel),current=await this.readSource(located.abs);
      if(digestBytes(current)!==record.materialDigest)throw new HostError('CONFLICT','原件已变化，旧涂鸦保留；请在新版本重新框选');
      if(record.kind==='ppt-region'){const draft=await pptSnapshot(this.storage,projectId,rel,record.materialDigest);if(draft.digest!==record.information.draft?.digest)throw new HostError('CONFLICT','PPT草稿已变化，未修改旧涂鸦');}
      const raw=record.information.assets.find(a=>a.role==='region-screenshot');if(!raw)throw new HostError('NOT_FOUND','原始区域截图缺失');
      const regionImage={dataUrl:'data:image/png;base64,'+(await store.getMaterial(raw.digest)).toString('base64'),captureMode:raw.captureMode,clipped:raw.clipped};
      if(!update)return {regionImage,sourceDraftDigest:record.information.draft?.digest};
      if(record.updatedAt!==input.expectedUpdatedAt||record.materialDigest!==input.materialDigest)throw new HostError('ANNOTATION_CONFLICT','涂鸦已被修改，草稿保留，请重新打开');
      const information=await buildAnnotationPackage({store,userDataDir:this.userDataDir,projectId,relPath:rel,kind:record.kind,anchor:record.anchor,materialDigest:record.materialDigest,material:current,image:regionImage,drawing:input.drawing,annotatedImage:input.annotatedImage,sourceDraftDigest:record.information.draft?.digest});
      const history=[...(record.drawingHistory||[]),{updatedAt:record.updatedAt,information:record.information}];
      if(history.length>100)throw new HostError('INVALID_PAYLOAD','此涂鸦已达100个版本，请新建区域备注');
      const next={...record,information,drawingHistory:history,updatedAt:new Date().toISOString()};
      await store.write(rel,{...file,tags:file.tags.map(t=>t.id===next.id?next:t)},file.revision);return {annotation:next};
    }));
  }

  /** Store a pasted clipboard image as an immutable material and return the
   * markdown reference relative to the edited document. Content addressing
   * makes re-pasting the same image idempotent; no file is ever overwritten. */
  async pasteDocumentImage(projectId, input) {
    if(this.boundDocumentSource(input?.documentSource).type!=='project')throw new HostError('UNSUPPORTED','审校文档不支持粘贴图片引用。');
    return this.track((async () => {
      const project = await this.requireProject(projectId);
      const located = await this.resolveFile(project, input?.relPath);
      if (located.missing) throw new HostError('NOT_FOUND', '目标文档不存在，无法粘贴图片。');
      const base64 = typeof input?.bytes === 'string' ? input.bytes : '';
      if (!base64 || base64.length > 12 * 1024 * 1024) throw new HostError('INVALID_IMAGE', '剪贴板图片数据无效或超过 8 MiB。');
      const bytes = Buffer.from(base64, 'base64');
      if (!bytes.length || bytes.byteLength > 8 * 1024 * 1024) throw new HostError('INVALID_IMAGE', '剪贴板图片数据无效或超过 8 MiB。');
      let info; try { info = imageInfo(bytes); } catch (error) { throw new HostError('INVALID_IMAGE', error.message); }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(info.mime)) throw new HostError('UNSUPPORTED_IMAGE', '仅支持粘贴 PNG、JPEG 或 WebP 图片。');
      const store = new FileTags({storage:this.storage,projectId:project.id,root:project.root});
      const { digest, byteLength } = await store.putMaterial(bytes);
      const resource='nozeli-assets/'+digest+(info.mime==='image/png'?'.png':info.mime==='image/jpeg'?'.jpg':'.webp');
      const destination=await this.resolveFile(project,resource);if(destination.missing){await fs.mkdir(path.dirname(destination.abs),{recursive:true});await this.replaceFile(destination.abs,bytes,{createOnly:true});}
      const from = path.posix.dirname(located.rel);
      const relRef = path.posix.relative(from,resource);
      return { relRef, digest, mime: info.mime, byteLength, width: info.width, height: info.height };
    })());
  }

  /** Read an image referenced by markdown so the preview can display it.
   * Only visible project image files and immutable material blobs are exposed. */
  async readDocumentImage(projectId, input) {
    if(this.boundDocumentSource(input?.documentSource).type!=='project')throw new HostError('UNSUPPORTED','审校文档图片请从冻结材料读取。');
    return this.track((async () => {
      const project = await this.requireProject(projectId);
      const located = await this.resolveFile(project, input?.relPath);
      if (located.missing) throw new HostError('NOT_FOUND', '目标文档不存在。');
      const ref = typeof input?.ref === 'string' ? input.ref : '';
      if (!ref || ref.length > 4096 || ref.includes('\\') || ref.startsWith('/') || /[\x00-\x1f]/.test(ref) || /^[a-z][a-z0-9+.-]*:/i.test(ref)) throw new HostError('INVALID_REF', '图片引用无效。');
      // Resolve the reference against the document's directory first so that
      // leading '..' segments climb out of that directory, not the project.
      const base = path.posix.dirname(located.rel) === '.' ? [] : path.posix.dirname(located.rel).split('/');
      const segments = [...base];
      for (const part of ref.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') { if (!segments.length) throw new HostError('INVALID_REF', '图片引用不能超出项目。'); segments.pop(); continue; }
        if (part.startsWith('.') && part !== '.nozeli') throw new HostError('INVALID_REF', '不能引用隐藏路径。');
        segments.push(part);
      }
      const rel = segments.join('/');
      if (!rel) throw new HostError('INVALID_REF', '图片引用无效。');
      if (segments.includes('.nozeli'))throw new HostError('INVALID_REF','正式文档图片必须使用项目公开资源目录，不引用私有元数据');
      const target = await this.resolveFile(project, rel);
      if (target.missing) throw new HostError('NOT_FOUND', '图片文件不存在：' + rel);
      if (!imageExtension.test(target.rel)) throw new HostError('UNSUPPORTED_IMAGE', '引用的文件不是受支持的图片。');
      const bytes = await fs.readFile(target.abs);
      if (bytes.byteLength > 8 * 1024 * 1024) throw new HostError('IMAGE_TOO_LARGE', '图片超过 8 MiB，不能在预览中显示。');
      let info; try { info = imageInfo(bytes); } catch (error) { throw new HostError('INVALID_IMAGE', error.message); }
      return { relPath: target.rel, mime: info.mime, bytes: bytes.toString('base64'), width: info.width, height: info.height };
    })());
  }

  async tagMaterial(projectId, input) {
    return this.track((async () => {
      const project = await this.requireProject(projectId), source = this.boundDocumentSource(input?.documentSource), store = source.type === 'project' ? new FileTags({storage:this.storage,projectId:project.id,root:project.root}) : await this.tagStore(projectId, source), rel = normalizeRel(input?.relPath);
      const file = await store.read(rel), tag = file?.tags.find(t => t.id === input.annotationId);
      if (!tag) throw new HostError('NOT_FOUND', 'Tag was not found.');
      const origin = await store.getMaterial(tag.materialDigest);
      const current = source.type === 'project'
        ? await (async()=>{const located = await this.resolveFile(project, rel);return located.missing ? null : await this.readSource(located.abs);})()
        : await this.reviewDocumentBytes(projectId, source, rel);
      const resolution = await this.resolveTag(store, tag, current);
      let currentSource=null;
      if(current){const {digest,byteLength}=await store.putMaterial(current);currentSource={digest,relPath:'.nozeli/objects/sha256/'+digest,bytes:byteLength};}
      let draftStatus='not-applicable',currentDraft=null;
      if(tag.kind.startsWith('ppt-')){try{const snapshot=await pptSnapshot(this.storage,projectId,rel,resolution.targetDigest);draftStatus=snapshot.digest===tag.information?.draft?.digest?'unchanged':'changed';await store.putMaterial(snapshot.bytes);currentDraft={digest:snapshot.digest,relPath:'.nozeli/objects/sha256/'+snapshot.digest,mime:'application/json',bytes:snapshot.bytes.length};}catch{draftStatus='unavailable';}}
      const reasons=[];
      let information=null;
      try{information=await verifyAnnotationPackage(store,tag.information);}catch{reasons.push('备注资源缺失或摘要校验失败');}
      if(information?.limitations?.length)reasons.push(...information.limitations);
      if(!resolution.anchor||resolution.locationStatus!=='exact'||resolution.contentStatus!=='unchanged')reasons.push('位置不确定或内容已变化');
      if(resolution.targetDigest!==tag.materialDigest)reasons.push('源文件版本已变化，修改前须校验当前版本');
      if(['changed','unavailable'].includes(draftStatus))reasons.push('PPT 当前草稿不同于备注快照或不可用');
      if(tag.kind.endsWith('-point'))reasons.push('位置点仅提供附近上下文，不是对象映射');
      if(!tag.information)reasons.push('旧备注未记录完整材料包');
      return { schema:'nozeli.agent-tag-material-v1',note:tag.note,kind:tag.kind,information,currentSource,currentDraft,draftStatus,discussion:{canContinue:true,relocationRequired:false,advisory:resolution.advisory},execution:{locationVerified:reasons.length===0,canAutoModify:false,reasons:[...reasons,'本接口只提供材料，修改执行器仍需校验并生成可审查差异']},tagId: tag.id, fileId: file.file.fileId, relPath: rel, origin: { materialDigest: tag.materialDigest, anchor: tag.anchor, text: (['text-selection','text-point'].includes(tag.kind) || tag.kind === 'file' && isUtf8Text(origin)) ? anchorText(origin.toString('utf8')) : null }, resolution, currentText: (['text-selection','text-point'].includes(tag.kind) || tag.kind === 'file' && current && isUtf8Text(current)) && current && isUtf8Text(current) ? anchorText(current.toString('utf8')) : null };
    })());
  }

  async attachMaterial(input){return this.track(this.attachments.attach(input));}
  validateDrawingPng(bytes,mime='image/png'){return validateDrawingPng(bytes,mime);}
  async readDrawingImage(ref){const bytes=await this.attachments.readBytes(ref);validateDrawingPng(bytes,ref.mime);return bytes;}
  async drawingImageSources(projectId,ref){return this.attachments.drawingSources(projectId,ref);}
  async readMaterialAttachment(ref){return this.track(this.attachments.read(ref));}

  /** User-action-scoped directory browsing for the composer reference panel.
   * Single level, paged; nothing is read beyond names/types/sizes. */
  async browseDirectory(input) {
 return this.track((async () => {
      const raw = typeof input?.path === 'string' ? input.path.trim() : '';
      const offset = Number.isSafeInteger(input?.offset) && input.offset >= 0 ? input.offset : 0;
      const limit = 500;
      if (!raw || raw.length > 4096 || /[\x00-\x1f]/.test(raw)) throw new HostError('INVALID_PATH', '路径无效。');
      const target = path.resolve(raw);
      let stats;
      try { stats = await fs.lstat(target); } catch (error) { throw new HostError('PATH_UNAVAILABLE', `无法读取目录（${error.code === 'ENOENT' ? '不存在' : error.code === 'EACCES' ? '无权限' : error.code || '错误'}）：${target}`); }
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new HostError('PATH_UNAVAILABLE', `不是可浏览的目录（符号链接不跟随）：${target}`);
      let names;
      try { names = await fs.readdir(target); } catch (error) { throw new HostError('PATH_UNAVAILABLE', `目录无法打开（${error.code || '错误'}）：${target}`); }
      names.sort((a, b) => a.localeCompare(b, 'zh'));
      const page = names.slice(offset, offset + limit);
      const entries = [];
      for (const name of page) {
        const abs = path.join(target, name);
        let info;
        try { info = await fs.lstat(abs); } catch { continue; }
        if (info.isSymbolicLink()) { entries.push({ name, dir: false, kind: 'symlink', size: 0 }); continue; }
        entries.push({ name, dir: info.isDirectory(), kind: info.isDirectory() ? 'dir' : 'file', size: info.isFile() ? info.size : 0 });
      }
      return { path: target, parent: path.dirname(target) === target ? null : path.dirname(target), offset, total: names.length, page: limit, entries, hasMore: offset + limit < names.length };
    })());
  }

  /** Freeze a user-selected absolute-path file as an immutable material copy.
   * Same store/limits as pasted attachments; nothing is written into any project. */
  async attachMaterialPath(input) {
    return this.track((async () => {
      const raw = typeof input?.path === 'string' ? input.path.trim() : '';
      if (!raw || raw.length > 4096 || /[\x00-\x1f]/.test(raw)) throw new HostError('INVALID_ATTACHMENT', '路径无效。');
      const target = path.resolve(raw);
      const handle=await fs.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let bytes;
      try{const before=await handle.stat();if(!before.isFile()||before.size>8*1024*1024)throw new HostError('INVALID_ATTACHMENT','只能引用不超过8MiB的普通文件');const data=Buffer.alloc(Number(before.size)+1);let count=0;while(count<data.length){const result=await handle.read(data,count,data.length-count,count);if(!result.bytesRead)break;count+=result.bytesRead;}const after=await handle.stat(),entry=await fs.lstat(target);if(entry.isSymbolicLink()||count!==before.size||['dev','ino','size','mtimeMs','ctimeMs'].some(k=>before[k]!==after[k]||before[k]!==entry[k]))throw new HostError('INVALID_ATTACHMENT','文件读取期间已变化，未导入');bytes=data.subarray(0,count);}finally{await handle.close();}
      const name = path.basename(target);
      const mime = 'application/octet-stream';
      return this.attachments.attach({projectId:input.projectId,name,mime,source:'path-select',bytes:bytes.toString('base64'),size:bytes.length});
    })());
  }

}

export const ops = {
  'project.pick': () => { throw new HostError('INVALID_PAYLOAD', 'Directory selection is supplied by the host, not the page.'); },
  'project.recent': (host) => host.recent(),
  'project.remove': (host, payload) => host.removeProject(payload.projectId,{operationId:payload.operationId}),
  'project.open': (host, payload) => host.open(payload?.projectId),
  'project.list': (host, payload) => host.list(payload?.projectId, { treeView: payload?.treeView === true }),
  'project.children': (host, payload) => host.children(payload?.projectId, payload ?? {}),
  'project.search': (host, payload) => host.search(payload?.projectId, payload ?? {}),
  'word.import': (host,payload)=>host.importDoc(payload?.projectId,payload),
  'file.read': (host, payload) => host.readFile(payload?.projectId, payload?.relPath, payload?.documentSource),
  'file.availability': (host, payload) => host.fileAvailability(payload?.projectId, payload?.paths),
  'document.history': (host,payload) => host.documentHistory(payload?.projectId,payload?.relPath,{eventId:payload?.eventId || null,scope:payload?.scope??null,cursor:payload?.cursor??null,limit:payload?.limit??100},payload?.documentSource),
  'document.versions': (host,payload) => host.documentVersions(payload?.projectId,payload?.relPath,{cursor:payload?.cursor??null,limit:payload?.limit??50},payload?.documentSource),
  'document.version': (host,payload) => host.documentVersion(payload?.projectId,payload?.relPath,payload?.version,payload?.documentSource),
  'document.status': (host,payload) => host.documentStatus(payload?.projectId,payload?.relPath),
  'sheet.recover': (host,payload)=>host.recoverSheet(payload?.projectId,payload?.relPath,payload?.bytes),
  'sheet.save': (host, payload) => host.saveSheet(payload?.projectId, payload?.relPath, payload?.baseDigest, payload?.bytes),
  'word.save': (host, payload) => host.saveWord(payload?.projectId, payload?.relPath, payload?.baseDigest, payload?.bytes,{anchorChanges:payload?.anchorChanges??null}),
  'file.draft': (host, payload) => host.draft(payload?.projectId, payload?.relPath, payload?.baseDigest, payload?.text, payload?.documentSource, payload?.expectedDraftRevision),
  'file.retain': (host, payload) => host.retainDraft(payload?.projectId, payload?.relPath, payload?.baseDigest, payload?.text, payload?.documentSource, payload?.expectedDraftRevision),
  'file.save': (host, payload) => host.save(payload?.projectId, payload?.relPath, payload?.baseDigest, payload?.text, {
    confirmOverwrite: payload?.confirmOverwrite === true,
    anchorChanges: payload?.anchorChanges ?? null,
    expectedDraftRevision: payload?.expectedDraftRevision,
  }, payload?.documentSource),
  'state.read': (host, payload) => host.readState(payload?.projectId),
  'state.write': (host, payload) => host.writeState(payload?.projectId, payload?.state),
  'annotation.list': (host, payload) => host.listAnnotations(payload?.projectId, payload?.relPath, payload?.documentSource),
  'annotation.drawing.source':async(host,payload)=>{if(host.boundDocumentSource(payload?.documentSource).type!=='project')throw new HostError('UNSUPPORTED','审校文档不支持PPT涂鸦。');await host.requireProject(payload.projectId);const {digest}=await pptSnapshot(host.storage,payload.projectId,normalizeRel(payload.relPath),payload.materialDigest);return {digest};},
  'annotation.drawing.read':(host,payload)=>host.drawingMaterial(payload?.projectId,payload),
  'annotation.drawing':(host,payload)=>host.drawingMaterial(payload?.projectId,payload,true),
  'annotation.add': (host, payload) => host.addAnnotation(payload?.projectId, payload),
  'annotation.remove': (host, payload) => host.removeAnnotation(payload?.projectId, payload?.annotationId, payload?.documentSource),
  'annotation.update': (host, payload) => host.updateAnnotation(payload?.projectId, payload?.annotationId, payload),
  'tag.put': (host, payload) => host.putTag(payload?.projectId, payload),
  'tag.view': (host, payload) => host.tagView(payload?.projectId, payload),
  'tag.reanchor': (host, payload) => host.reanchorTag(payload?.projectId, payload),
  'material.attach': (host, payload) => host.attachMaterial(payload),
  'material.read': (host, payload) => host.readMaterialAttachment(payload),
  'material.browse': (host, payload) => host.browseDirectory(payload),
  'material.attachPath': (host, payload) => host.attachMaterialPath(payload),
  'tag.material': (host, payload) => host.tagMaterial(payload?.projectId, payload),
  'document.image.put': (host, payload) => host.pasteDocumentImage(payload?.projectId, payload),
  'document.image.get': (host, payload) => host.readDocumentImage(payload?.projectId, payload),
};
