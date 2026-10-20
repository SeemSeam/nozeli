import test from 'node:test';
import assert from 'node:assert/strict';
import { createTagSessionProjection } from '../src/renderer/tag-session-projection.mjs';
import { tagProjectionContent } from '../src/renderer/tag-projection-state.mjs';

const noteTag = await import('../src/renderer/note-tag.mjs');
const { projectTextAnchor } = await import('../src/renderer/text-view.mjs');
class Element {
  constructor(tag = 'span') { this.tag = tag; this.children = []; this.handlers = {}; this.style = {}; this.dataset = {}; this.hidden = false; this.value = ''; this.textContent = ''; this.attributes = new Map(); const classes = new Set(); this.classList = { add: (...items) => items.forEach(item => classes.add(item)), remove: (...items) => items.forEach(item => classes.delete(item)), toggle: (item, force) => force === undefined ? (classes.has(item) ? (classes.delete(item), false) : (classes.add(item), true)) : (force ? classes.add(item) : classes.delete(item), force), contains: item => classes.has(item) }; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  getBoundingClientRect() { return {left:0,top:0,right:420,bottom:42,width:420,height:42}; }
  removeEventListener(type, fn) { this.handlers[type]=(this.handlers[type]||[]).filter(handler=>handler!==fn); }
  closest() { return null; }
  querySelector(selector) { const match=/^:scope > \.([\w-]+)$/.exec(selector);if(!match)throw Error('Unsupported fixture selector: '+selector);return this.children.find(node=>node.classList.contains(match[1])||String(node.className||'').split(' ').includes(match[1]))||null; }
  querySelectorAll() { return []; }
  append(...nodes) { this.children.push(...nodes); for(const node of nodes) node.parentElement=this; }
  insertBefore(node, reference) { const index=reference==null?this.children.length:this.children.indexOf(reference);if(index<0)throw Error('reference is not a child');this.children.splice(index,0,node);node.parentElement=this; }
  before(node) { const p=this.parentElement;p.children.splice(p.children.indexOf(this),0,node);node.parentElement=p; }
  after(node) { const p=this.parentElement;p.children.splice(p.children.indexOf(this)+1,0,node);node.parentElement=p; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  focus() { this.emit('focus'); }
  emit(type, props = {}) { const event = { target: this, propagationStopped: false, preventDefault(){}, stopPropagation(){ this.propagationStopped = true; }, ...props }; for (const fn of this.handlers[type] ?? []) fn(event); return event; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  async emitAsync(type, props = {}) {
    const event = { target: this, preventDefault() {}, stopPropagation() {}, ...props };
    await Promise.all((this.handlers[type] ?? []).map(handler => handler(event)));
  }
}
globalThis.document = { createElement: tag => new Element(tag), createElementNS: (_namespace,tag) => new Element(tag), elementFromPoint: () => null };
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback=callback; this.targets=new Set(); }
  observe(target) { this.targets.add(target); this.callback([{target,contentRect:target.getBoundingClientRect()}],this); }
  disconnect() { this.targets.clear(); }
};


test('note and discussion drafts update summaries and survive collapse/re-expansion', () => {
  for (const kind of ['note', 'discuss']) {
    let draft = 'OLD';
    const root = noteTag.makeAnchorTag({ id: kind, ordinal: 1, kind, text: 'OLD', status: kind === 'note' ? {value: 'OLD'} : 'draft' }, { autoEdit: () => true, onDraft: (_id, value) => { draft = value; } });
    const card = root.children[1];
    const head = card.children[0];
    const summary = head.children[1];
    const editor = card.children.find(node => node.className === 'tag-editor');
    editor.value = 'NEW_TYPED';
    editor.emit('input');
    assert.equal(draft, 'NEW_TYPED');
    assert.equal(summary.textContent, 'NEW_TYPED');
    head.emit('keydown', { key: 'Enter' });
    assert.equal(summary.hidden, false);
    assert.equal(summary.textContent, 'NEW_TYPED');
    assert.equal(editor.hidden, true);
    head.emit('keydown', { key: 'Enter' });
    assert.equal(summary.textContent, 'NEW_TYPED');
    assert.equal(editor.hidden, kind === 'note');
    if (kind === 'note') card.children.find(node => node.className === 'tag-controls').children.find(e => e.className === 'tag-edit').emit('click');
    assert.equal(editor.hidden, false);
  }
});

test('closing keeps tags visible as summaries and explicit opening restores the card', () => {
  for (const kind of ['note', 'discuss']) {
    let removed = 0;
    const root = noteTag.makeAnchorTag({ id: kind, ordinal: 2, kind, text: 'SUMMARY_START and more detail', status: kind === 'note' ? '' : 'completed', open: true }, { remove: () => { removed += 1; } });
    const index = root.children[0], card = root.children[1], head = card.children[0], close = head.children.find(node=>node.className==='tag-close');
    close.emit('click');
    assert.equal(card.hidden, false);
    assert.equal(card.classList.contains('is-collapsed'), true);
    assert.equal(index.getAttribute('aria-expanded'), 'false');
    assert.match(head.children[1].textContent, /^SUMMARY_START/);
    assert.equal(removed, 0);
    index.emit('click');
    assert.equal(card.hidden, false);
    assert.equal(card.classList.contains('is-collapsed'), false);
    assert.equal(index.getAttribute('aria-expanded'), 'true');
  }
});

test('header single clicks preserve geometry until double click toggles', () => {
  for (const kind of ['note', 'discuss']) {
    const root = noteTag.makeAnchorTag({ id: kind, ordinal: 3, kind, text: 'CLICK_SUMMARY', status: kind === 'note' ? '' : 'completed', open: true });
    const index = root.children[0], card = root.children[1], head = card.children[0], summary = head.children[1], close = head.children.find(node=>node.className==='tag-close');
    const closed = close.emit('click');
    assert.equal(closed.propagationStopped, true);
    assert.equal(card.classList.contains('is-collapsed'), true);
    summary.emit('click');
    assert.equal(card.classList.contains('is-collapsed'), true);
    head.emit('click', { detail: 1 });
    head.emit('click', { detail: 2 });
    assert.equal(card.classList.contains('is-collapsed'), true);
    head.emit('dblclick');
    assert.equal(card.classList.contains('is-collapsed'), false);
    index.emit('click');
    assert.equal(card.classList.contains('is-collapsed'), false);
  }
});

test('text projections clamp stale note and discussion anchors without rewriting persistence', () => {
  for (const kind of ['note', 'discuss']) {
    const anchor = { start: 20, end: 30, quote: '原始引文' };
    const projected = projectTextAnchor(anchor, 4);
    assert.deepEqual(projected.mark, [3, 4]);
    assert.equal(projected.start, 4);
    assert.equal(projected.drifted, true);
    assert.deepEqual(anchor, { start: 20, end: 30, quote: '原始引文' });
    const root = noteTag.makeAnchorTag({ id: kind, ordinal: 8, kind, text: '旧标签', status: kind === 'note' ? '' : 'completed', anchorDrift: true, open: false }, {});
    const index = root.children[0];
    const card = root.children[1];
    assert.equal(card.hidden, false);
    card.children[0].emit('keydown', { key: 'Enter' });
    assert.equal(card.hidden, false);
    assert.equal(index.getAttribute('aria-expanded'), 'true');
    card.children[0].emit('keydown', { key: 'Enter' });
    assert.equal(card.hidden, false);
    assert.equal(index.getAttribute('aria-expanded'), 'false');
    index.emit('click');
    assert.equal(index.getAttribute('aria-expanded'), 'true');
  }
});

test('local note deletion is an explicit expanded-card action', () => {
  let removed = 0;
  const root = noteTag.makeAnchorTag({ id: 'note', ordinal: 3, kind: 'note', text: 'KEEP', open: true }, { remove: () => { removed += 1; } });
  const card = root.children[1], content = card.children[0].children[1], close = card.children[0].children.find(node=>node.className==='tag-close');
  close.emit('click');
  assert.equal(removed, 0);
  card.children[0].emit('dblclick');
  const controls = card.children.find(node => node.className === 'tag-controls');
  assert.equal(controls.hidden, false);
  controls.children.find(node => node.className === 'tag-delete').emit('click');
  assert.equal(removed, 1);
});

test('conversation removal is available in both states and distinct from collapse', () => {
  for (const open of [true, false]) {
    const removed = [];
    const root = noteTag.makeAnchorTag({ id: 'thread', ordinal: 7, kind: 'discuss', text: 'Question', status: 'completed', open }, { remove: id => removed.push(id) });
    const card = root.children[1], head = card.children[0];
    const remove = head.children.find(node => node.className === 'tag-remove');
    assert.ok(remove);
    assert.equal(remove.hidden, false);
    head.children.find(node=>node.className==='tag-close').emit('click');
    assert.deepEqual(removed, [], 'collapse must not remove a projection');
    const event = remove.emit('click');
    assert.equal(event.propagationStopped, true);
    assert.deepEqual(removed, ['thread']);
  }
});


test('passive note and discussion remounts preserve long offsets without focus or moves', async () => {
  const pane = { querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600 }) };
  let focused = 0;
  const oldDocument = globalThis.document;
  class GeometryElement extends Element {
    closest(selector) { return selector.includes('word-note-overlay') || selector.includes('image-page') ? null : pane; }
    getBoundingClientRect() { return { left: 180, right: 404, top: 4405, bottom: 4545 }; }
    focus() { focused += 1; }
  }
  globalThis.document = { ...oldDocument, createElement: () => new GeometryElement(), createElementNS: () => new GeometryElement() };
  try {
    for (const kind of ['note', 'discuss']) {
      const moves = [];
      const root = noteTag.makeAnchorTag({ id: kind, ordinal: 1, kind, text: 'draft', status: kind === 'note' ? { value: 'draft' } : 'draft' }, { offset: () => [180, 4405], move: (_id, delta) => moves.push(delta) });
      await new Promise(resolve => queueMicrotask(resolve));
      assert.deepEqual(moves, [], `${kind} passive remount changed offset`);
    }
    assert.equal(focused, 0, 'passive remount focused an editor');
  } finally { globalThis.document = oldDocument; }
});

test('explicit index recovery still moves an offscreen card into the pane', () => {
  const pane = { querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600 }) };
  const oldDocument = globalThis.document;
  class GeometryElement extends Element {
    closest(selector) { return selector.includes('word-note-overlay') || selector.includes('image-page') ? null : pane; }
    getBoundingClientRect() { return { left: 180, right: 404, top: 4405, bottom: 4545 }; }
  }
  globalThis.document = { ...oldDocument, createElement: () => new GeometryElement(), createElementNS: () => new GeometryElement() };
  try {
    const moves = [];
    const root = noteTag.makeAnchorTag({ id: 'recover', ordinal: 1, kind: 'note', text: 'draft', status: { value: 'draft' } }, { offset: () => [180, 4405], move: (_id, delta) => moves.push(delta) });
    root.children[0].emit('click', { clientX: 180, clientY: 4405 });
    assert.deepEqual(moves, [[180, 452]]);
  } finally { globalThis.document = oldDocument; }
});

test('send acknowledgement preserves explicit collapse', async () => {
  let resolve;
  const root = noteTag.makeAnchorTag({ id: 'pending-collapse', ordinal: 1, kind: 'discuss', text: '问题', status: 'draft', open: true }, { save: () => new Promise(r => { resolve = r; }) });
  root.children[1].children.find(node => node.className === 'tag-editor').value = '问题';
  const send = root.children[1].children.find(node => node.className === 'tag-controls').children[0];
  const sent = send.emitAsync('click');
  root.children[1].children[0].children.find(node=>node.className==='tag-close').emit('click');
  assert.equal(root.children[0].getAttribute('aria-expanded'), 'false');
  resolve({ text: '问题' });
  await sent;
  assert.equal(root.children[0].getAttribute('aria-expanded'), 'false');
});

test('discussion send keys ignore IME and held keys and share click submission', async () => {
  let calls=0,settle;
  const root=noteTag.makeAnchorTag({id:'keyboard',ordinal:1,kind:'discuss',text:'keep draft',status:'draft',open:true},{save:()=>{calls++;return new Promise(resolve=>{settle=resolve;});}});
  const card=root.children[1],editor=card.children.find(node=>node.className==='tag-editor'),send=card.children.find(node=>node.className==='tag-controls').children[0];
  send.click=()=>send.emit('click');
  editor.value='keep draft';
  for(const extra of [{isComposing:true},{keyCode:229},{repeat:true}])editor.emit('keydown',{key:'Enter',ctrlKey:true,...extra});
  assert.equal(calls,0);
  editor.emit('keydown',{key:'Enter',metaKey:true});
  assert.equal(calls,1);
  editor.emit('keydown',{key:'Enter',ctrlKey:true});
  assert.equal(calls,1,'pending submission cannot dispatch again');
  settle(false);await new Promise(resolve=>queueMicrotask(resolve));
  assert.equal(editor.value,'keep draft');
  assert.equal(send.disabled,false);
  const pending=send.emitAsync('click');assert.equal(calls,2);settle({text:'keep draft'});await pending;
  assert.equal(editor.value,'');
});
test('completed conversation opens with full history and a follow-up editor', () => {
  const root = noteTag.makeAnchorTag({ id: 'completed', ordinal: 9, kind: 'discuss', text: '完整问题', status: 'completed', replyText: '完整回复第一行\n完整回复第二行', open: true });
  const card = root.children[1];
  assert.match(card.children[0].children[1].textContent, /完整问题/);
  assert.match(card.children[0].children[1].textContent, /完整回复第一行/);
  assert.equal(card.children.find(node => node.className === 'tag-editor').hidden, false);
  assert.equal(card.children.find(node => node.className === 'tag-controls').hidden, false);
  card.children.find(node => node.className === 'tag-editor').value = '续问内容';
  card.children.find(node => node.className === 'tag-editor').emit('input');
  assert.equal(card.children.find(node => node.className === 'tag-editor').value, '续问内容');
  card.children[0].children.find(node=>node.className==='tag-close').emit('click');
  assert.equal(card.classList.contains('is-collapsed'), true);
  assert.match(card.children[0].children[1].textContent, /完整回复第一行/);
});
test('completed replies remain visible on their original tag', () => {
  const root = noteTag.makeAnchorTag({ id: 'reply', ordinal: 3, kind: 'discuss', text: '为什么？', status: 'completed', replyText: '因为它保持同一锚点。' });
  assert.ok(root.children[1].children[0].children[1].textContent.includes('为什么？'));
  assert.ok(root.children[1].children[0].children[1].textContent.includes('因为它保持同一锚点。'));
});

test('pending conversations retain their follow-up editor and legacy labels remain readable', () => {
  const conversation = noteTag.makeAnchorTag({ id: 'conversation', ordinal: 1, kind: 'discuss', text: '请解释', status: 'accepted-awaiting-reply', open: true });
  assert.equal(conversation.children[1].hidden, false);
  assert.equal(conversation.children[1].children.find(node => node.className === 'tag-editor').hidden, false);
  const legacyExplain = noteTag.makeAnchorTag({ id: 'legacy', ordinal: 2, kind: 'explain', text: '解释', status: 'completed', replyText: '回答' });
  assert.equal(legacyExplain.children[0].textContent, '2');
});

test('conversation remount restores renderer-session dimensions', () => {
  const sizes = new Map([['thread-1', { width: 345, height: 380 }]]);
  const root = noteTag.makeAnchorTag({ id: 'thread-1', ordinal: 1, kind: 'discuss', status: 'completed', text: '问题' }, { size: id => sizes.get(id) });
  assert.equal(root.children[1].style.width, '345px');
  assert.equal(root.children[1].style.height, '380px');
});



test('both label types share the window shell, complete collapse, and size restoration', () => {
  for (const kind of ['note', 'discuss', 'explain']) {
    const root = noteTag.makeAnchorTag({ id: kind, ordinal: 3, kind, text: 'text', status: 'completed' }, { size: () => ({width:350,height:400}) });
    const card=root.children[1],head=card.children[0];
    assert.ok(card.classList.contains('tag-chat-window'));
    assert.equal(card.style.width,'350px'); assert.equal(card.style.height,'400px');
    for(let i=0;i<4;i++) {
      const before=card.classList.contains('is-collapsed');
      head.emit('click',{detail:1});head.emit('click',{detail:2});
      assert.equal(card.classList.contains('is-collapsed'),before);
      head.emit('dblclick');assert.equal(card.classList.contains('is-collapsed'),!before);
      if(!before) for(const child of card.children.slice(1)) assert.equal(child.hidden,true);
    }
    assert.equal(card.style.width,'350px'); assert.equal(card.style.height,'400px');
  }
});

// DOM callbacks only: host admission and app lifecycle races require Electron.
function discussion(data = {}, actions = {}) {
  const root = noteTag.makeAnchorTag({ id: 'thread', ordinal: 1, kind: 'discuss',
    text: 'FIRST', status: 'draft', open: true, ...data }, actions);
  const card = root.children[1];
  return { root, card, editor: card.children.find(node => node.className === 'tag-editor'),
    send: card.children.find(node => node.className === 'tag-controls').children[0] };
}

test('late acknowledgements preserve newer edits and leave another tag draft untouched', async () => {
  let accept;
  const drafts = new Map();
  const first = discussion({}, { save: () => new Promise(resolve => { accept = resolve; }),
    onDraft: (id, value) => drafts.set(id, value) });
  const other = discussion({ id: 'other' }, { onDraft: (id, value) => drafts.set(id, value) });
  first.editor.value = 'FIRST';
  const pending = first.send.emitAsync('click');
  first.editor.value = 'SECOND'; first.editor.emit('input');
  other.editor.value = 'OTHER EDIT'; other.editor.emit('input');
  accept({ text: 'FIRST' }); await pending;
  assert.equal(first.editor.value, 'SECOND');
  assert.equal(other.editor.value, 'OTHER EDIT');
  assert.deepEqual([...drafts], [['thread', 'SECOND'], ['other', 'OTHER EDIT']]);
  assert.equal(first.send.disabled, false);
});

test('rejection or provider exception retains component input and releases send', async () => {
  for (const outcome of ['rejected', 'exception']) {
    const view = discussion({}, { save: async () => {
      if (outcome === 'exception') throw new Error('controlled failure');
      return null;
    } });
    view.editor.value = 'UNSENT'; view.editor.emit('input');
    await view.send.emitAsync('click');
    assert.equal(view.editor.value, 'UNSENT');
    assert.equal(view.editor.hidden, false);
    assert.equal(view.send.disabled, false);
  }
});

test('repeated component sends reserve once until the receipt settles', async () => {
  let calls = 0, accept;
  const view = discussion({}, { save: () => {
    calls++;
    return new Promise(resolve => { accept = resolve; });
  } });
  view.editor.value = 'FIRST';
  const first = view.send.emitAsync('click');
  await view.send.emitAsync('click');
  assert.equal(calls, 1);
  accept({ text: 'FIRST' }); await first;
  assert.equal(view.editor.value, '');
  assert.equal(view.send.disabled, false);
});

function projectionFixture(values) {
  let projectId = 'P', messages = [];
  const persisted = [];
  const projection = createTagSessionProjection({ currentProjectId: () => projectId,
    tags: () => values.values(), persistTag: tag => persisted.push(tag.id), renderTags() {} });
  return { persisted, apply: () => projection.apply([], { projectId,
    getMessages: () => messages, ensureMessage: async () => {} }),
    messages: next => { messages = next; }, project: next => { projectId = next; } };
}

test('historical replies cannot complete the current request or overwrite an unsent draft', () => {
  const tag = { id: 'T', projectId: 'P', requestId: 'B', status: 'draft', text: 'NEW DRAFT',
    draftText: 'NEW DRAFT', history: [{ requestId: 'A', question: 'OLD' }, { requestId: 'B', question: 'SENT' }] };
  const f = projectionFixture(new Map([[tag.id, tag]]));
  f.messages([{ id: 'A-message', requestId: 'A', role: 'qa', text: 'OLD REPLY' }]); f.apply();
  assert.equal(tag.status, 'draft'); assert.equal(tag.text, 'NEW DRAFT');
  assert.equal(tag.replyText, ''); assert.equal(tag.history[0].reply, 'OLD REPLY');
  f.messages([{ id: 'A-message', requestId: 'A', role: 'qa', text: 'OLD REPLY' },
    { id: 'B-message', requestId: 'B', role: 'qa', text: 'NEW REPLY' }]); f.apply();
  assert.equal(tag.status, 'draft'); assert.equal(tag.draftText, 'NEW DRAFT');
  assert.equal(tag.replyText, 'NEW REPLY');
  assert.deepEqual(tag.history.map(entry => entry.reply), ['OLD REPLY', 'NEW REPLY']);
  const writes = f.persisted.length;
  f.apply();
  assert.equal(f.persisted.length, writes, 'unchanged identities do not rewrite tag persistence');
});

test('project switching isolates colliding request identities and local drafts', () => {
  const first = { id: 'first', projectId: 'P', requestId: 'R', status: 'accepted-awaiting-reply' };
  const second = { id: 'second', projectId: 'Q', requestId: 'R', status: 'draft', draftText: 'Q DRAFT' };
  const f = projectionFixture(new Map([[first.id, first], [second.id, second]]));
  f.messages([{ id: 'P-message', requestId: 'R', role: 'qa', text: 'P REPLY' }]); f.apply();
  assert.equal(first.replyText, 'P REPLY'); assert.equal(second.messageId, undefined);
  f.project('Q'); f.messages([]); f.apply();
  assert.equal(first.replyText, ''); assert.equal(second.replyText, '');
  f.messages([{ id: 'Q-message', requestId: 'R', role: 'qa', text: 'Q REPLY' }]); f.apply();
  assert.equal(second.replyText, 'Q REPLY'); assert.equal(second.draftText, 'Q DRAFT');
  assert.equal(first.messageId, 'P-message'); assert.equal(first.replyText, '');
});

test('projection invalidation ignores draft typing and anchor movement but notices replies', () => {
  const tag = { id: 'T', kind: 'discuss', status: 'draft', text: 'FIRST',
    anchor: { start: 1, end: 5, quote: 'QUOTE' } };
  const before = tagProjectionContent(tag);
  tag.text = 'SECOND'; tag.draftText = 'SECOND'; tag.anchor.start = 10; tag.anchor.end = 14;
  assert.equal(tagProjectionContent(tag), before, 'draft and coordinate changes retain interactive roots');
  tag.replyText = 'CANONICAL REPLY';
  assert.notEqual(tagProjectionContent(tag), before);
});
