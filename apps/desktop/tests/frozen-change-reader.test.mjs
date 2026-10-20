import test from 'node:test';
import assert from 'node:assert/strict';
import { mountFrozenChangeReader, frozenChangePresentation } from '../src/renderer/frozen-change-reader.mjs';

// Only DOM ownership/focus primitives are needed; MergeView is injected below.
class Node {
  constructor(document, tag = 'div') {
    this.ownerDocument = document; this.tagName = tag; this.children = []; this.style = { visibility: '' };
    this.attributes = new Map(); this.listeners = new Map(); this.inert = false; this.isConnected = true;
  }
  append(...children) { for (const child of children) { if (typeof child === 'object') child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  click() { this.listeners.get('click')?.(); }
  focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
}
function fixture(invoke) {
  const document = { createElement(tag) { return new Node(this, tag); } };
  const parent = new Node(document), reading = new Node(document), comparison = new Node(document);
  const editor = { buffer: 'unsaved draft', undo: ['original'], selection: { anchor: 2, head: 5 } };
  reading.editor = editor; reading.scrollTop = 712; reading.append(new Node(document));
  comparison.inert = true; comparison.style.visibility = 'visible'; comparison.setAttribute('aria-hidden', 'false');
  parent.append(reading, comparison); reading.focus();
  const mounts = [], navigation = []; let destroyed = 0, projectId = 'p';
  const reader = mountFrozenChangeReader({ parent, invoke, currentProjectId: () => projectId, mountDiff(options) {
    mounts.push(options); options.parent.replaceChildren(new Node(document)); options.onNavigate(-1, 2);
    return { navigate: direction => navigation.push(direction), destroy() { destroyed++; options.parent.replaceChildren(); } };
  } });
  return { reader, parent, reading, comparison, editor, mounts, navigation, document,
    destroyed: () => destroyed, switchProject: () => { projectId = 'other'; } };
}
const target = { projectId: 'p', changeSetId: 'frozen', fileId: 'opaque-id' };
const available = { availability: 'available', file: { path: '中文\nname.ts' }, before: { text: 'before\n' }, after: { text: 'after' } };

test('opens exact immutable before/after, navigates hunks and returns the retained editor unchanged', async () => {
  const calls = [], f = fixture(async (...args) => { calls.push(args); return { ok: true, value: available }; });
  const selection = f.editor.selection, undo = f.editor.undo;
  assert.equal((await f.reader.open(target)).ok, true);
  assert.deepEqual(calls, [['managed.changes.read', target]]);
  assert.equal(f.mounts[0].leftText, 'before\n'); assert.equal(f.mounts[0].rightText, 'after');
  assert.equal(f.reading.inert, true); assert.equal(f.reading.style.visibility, 'hidden');
  assert.equal(f.parent.children[0], f.reading);
  const overlay = f.parent.children[2], head = overlay.children[0];
  const navigation = head.children[1].children[1];
  navigation.children[0].click(); navigation.children[2].click();
  assert.deepEqual(f.navigation, [-1, 1]);
  head.children[0].children[0].click();
  assert.equal(f.reader.active, false); assert.equal(f.destroyed(), 1);
  assert.deepEqual(f.parent.children, [f.reading, f.comparison]);
  assert.equal(f.reading.editor, f.editor); assert.equal(f.editor.buffer, 'unsaved draft');
  assert.equal(f.editor.selection, selection); assert.equal(f.editor.undo, undo); assert.equal(f.reading.scrollTop, 712);
  assert.equal(f.reading.inert, false); assert.equal(f.reading.style.visibility, ''); assert.equal(f.reading.getAttribute('aria-hidden'), null);
  assert.equal(f.comparison.inert, true); assert.equal(f.comparison.style.visibility, 'visible'); assert.equal(f.comparison.getAttribute('aria-hidden'), 'false');
  assert.equal(f.document.activeElement, f.reading); assert.deepEqual(f.reading.focusOptions, { preventScroll: true });
});

test('absent sides differ from unavailable text and empty files are valid', () => {
  for (const [before, after] of [[null, { text: '' }], [{ text: '' }, null], [{ text: '' }, { text: '' }]]) {
    assert.deepEqual(frozenChangePresentation({ ...available, before, after }), { path: available.file.path, leftPath: available.file.path, rightPath: available.file.path, beforeMode:null, afterMode:null, modeChange:null, text: true, before: '', after: '' });
  }
  for (const side of [undefined, {}, { bytes: 100 }]) {
    assert.equal(frozenChangePresentation({ ...available, before: side }).text, false);
  }
});

test('binary, symlink/gitlink, non-UTF8 and oversized evidence show truthful reasons and never mount a diff', async () => {
  for (const reason of ['binary', 'special-file', 'non-utf8', 'byte-budget', 'line-budget']) {
    const f = fixture(async () => ({ ok: true, value: { ...available, availability: 'unsupported', reason } }));
    await f.reader.open(target);
    assert.equal(f.mounts.length, 0);
    const status = f.parent.children[2].children[1].children[0];
    assert.equal(status.textContent, frozenChangePresentation({ ...available, availability: 'unsupported', reason }).reason);
    assert.match(status.textContent, /不会读取当前文件/);
    f.reader.restore(); assert.equal(f.reading.inert, false);
  }
});

test('restoring while evidence is pending prevents late mounting', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.reader.open(target); f.reader.restore({ focus: false });
  resolve({ ok: true, value: available });
  assert.deepEqual(await pending, { ok: false, stale: true });
  assert.equal(f.mounts.length, 0); assert.equal(f.parent.children.length, 2);
});

test('a newer change supersedes older pending evidence without replacing retained DOM', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => pending.push(resolve)));
  const first = f.reader.open(target), second = f.reader.open({ ...target, fileId: 'second' });
  pending[1]({ ok: true, value: { ...available, after: { text: 'second' } } }); await second;
  pending[0]({ ok: true, value: available }); assert.equal((await first).stale, true);
  assert.equal(f.mounts.length, 1); assert.equal(f.mounts[0].rightText, 'second');
  f.reader.restore(); assert.equal(f.parent.children[0], f.reading);
});

test('cross-project requests and late replies do not mount evidence', async () => {
  let calls = 0, resolve;
  const f = fixture(() => { calls++; return new Promise(done => { resolve = done; }); });
  assert.equal((await f.reader.open({ ...target, projectId: 'other' })).ok, false); assert.equal(calls, 0);
  const pending = f.reader.open(target); f.switchProject(); f.reader.restore({ focus: false });
  resolve({ ok: true, value: available }); assert.equal((await pending).stale, true); assert.equal(f.mounts.length, 0);
});

test('missing/corrupt evidence remains a visible error, never a live-file fallback', async () => {
  for (const mode of ['throws', 'envelope']) {
    const calls = [], f = fixture(async (method) => {
      calls.push(method);
      if (mode === 'throws') throw Error('retained object missing');
      return { ok: false, error: { message: 'retained object missing' } };
    });
    assert.equal((await f.reader.open(target)).ok, false); assert.equal(f.mounts.length, 0);
    assert.deepEqual(calls, ['managed.changes.read']);
    assert.match(f.parent.children[2].children[1].children[0].textContent, /retained object missing/);
    f.reader.restore(); assert.equal(f.reading.editor, f.editor);
  }
});

test('rename and copy retain both syntax paths, title and exact frozen modes', async () => {
  for (const status of ['R100','C100']) {
    const value={...available,file:{path:'new/module.ts',oldPath:'old/module.py',status},before:{text:'same',mode:'100644'},after:{text:'same',mode:'100755'}};
    const f=fixture(async()=>({ok:true,value}));await f.reader.open(target);
    assert.equal(f.mounts[0].leftPath,'old/module.py');assert.equal(f.mounts[0].rightPath,'new/module.ts');
    const head=f.parent.children[2].children[0];
    assert.equal(head.children[0].children[1].textContent,'old/module.py → new/module.ts · 冻结变更 · 只读');
    assert.match(head.children[1].children[0].textContent,/100644 → 100755/);
    f.mounts[0].onNavigate(-1,0);
    assert.equal(head.children[1].children[1].children[1].textContent,'内容相同 · 模式 100644 → 100755');
    assert.equal(head.children[1].children[1].children[0].disabled,true);
    f.reader.restore();
  }
});

test('unsupported files retain exact modes from the frozen file manifest',()=>{
 const value={availability:'unsupported',reason:'special-file',file:{path:'link',before:{mode:'100644'},after:{mode:'120000'}},before:null,after:null};
 const presentation=frozenChangePresentation(value);
 assert.equal(presentation.text,false);assert.equal(presentation.modeChange,'100644 → 120000');
});
