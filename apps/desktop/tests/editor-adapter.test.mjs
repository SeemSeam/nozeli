import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEditorText, offsetToPosition, positionToOffset, canonicalChanges, validateEdit, codeMirrorAdapter } from '../src/renderer/editor-adapter.mjs';
import { mapTextAnchor } from '../src/domain/tag-anchors.mjs';
test('UTF-16 positions round trip at every offset including emoji and newline', () => {
  const text = normalizeEditorText('中文😀\r\nline\r尾');
  assert.equal(text, '中文😀\nline\n尾');
  for (let i = 0; i <= text.length; i++) assert.equal(positionToOffset(text, offsetToPosition(text, i)), i);
  for (const bad of [-1, text.length + 1, 0.5, NaN]) assert.throws(() => offsetToPosition(text, bad));
  assert.throws(() => positionToOffset(text, { lineNumber: 0, column: 1 }));
  assert.throws(() => positionToOffset(text, { lineNumber: 1, column: 999 }));
});
test('exact engine edits preserve repeated text anchoring and reject inconsistent versions', () => {
  const before = 'same same 😀', edits = [{ from: 0, to: 0, insert: 'same ' }], after = 'same ' + before;
  const changes = canonicalChanges(before, edits, after);
  const mapped = mapTextAnchor({ start: 5, end: 9, quote: 'same' }, before, after, changes);
  assert.equal(mapped.anchor.start, 10);
  assert.throws(() => canonicalChanges(before, edits, 'different'));
  assert.throws(() => validateEdit(before, { from: 10, to: 1, insert: '' }));
});
test('multi-range Monaco edits map text and detect deleted anchors', () => {
  const before = 'left target right', after = 'LEFT  RIGHT';
  const changes = canonicalChanges(before, [{ from: 12, to: 17, insert: 'RIGHT' }, { from: 5, to: 11, insert: '' }, { from: 0, to: 4, insert: 'LEFT' }], after);
  assert.equal(mapTextAnchor({ start: 5, end: 11, quote: 'target' }, before, after, changes).locationStatus, 'orphaned');
});

test('freezing a native candidate retains editor state and rejects edits until permission changes',()=>{
 const state={doc:{toString:()=> 'candidate'},selection:{main:{anchor:1,head:3,from:1,to:3}}},calls=[];
 const view={state,dispatch:transaction=>calls.push(transaction)},adapter=codeMirrorAdapter(view);
 adapter.setReadOnly(true);assert.equal(view.state,state);assert.equal(adapter.getText(),'candidate');assert.deepEqual(adapter.getSelection(),{anchor:1,head:3,from:1,to:3});
 assert.throws(()=>adapter.applyEdit({from:0,insert:'bad'}),/read-only/);assert.throws(()=>adapter.applyEdits([{from:0,insert:'bad'}]),/read-only/);
 adapter.undo();adapter.redo();assert.equal(calls.length,0);
 adapter.setReadOnly(false);adapter.applyEdit({from:0,insert:'human'});assert.equal(calls.length,1);assert.equal(view.state,state);
});
