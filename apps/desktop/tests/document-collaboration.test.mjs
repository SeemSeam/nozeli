import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSet, EditorState, Text, Transaction } from '@codemirror/state';
import { history } from '@codemirror/commands';
import { codeMirrorAdapter, remoteDocumentChange } from '../src/renderer/editor-adapter.mjs';
import { rebaseDocumentEvent } from '../src/renderer/document-collaboration.mjs';

const apply = (changes, text) => changes.apply(Text.of(text.split('\n'))).toString();
function editor(text) {
  const view = {
    state: EditorState.create({ doc: text, extensions: [history()] }),
    dispatch(spec) { this.last = spec instanceof Transaction ? spec : this.state.update(spec); this.state = this.last.state; },
  };
  view.dispatch = view.dispatch.bind(view);
  return { view, adapter: codeMirrorAdapter(view) };
}

test('two Agent ranges map through preceding human typing and deletion; local undo preserves both Agent edits', () => {
  const before = 'remove this line\nheading\nfirst target\nsecond target\ntail';
  const { view, adapter } = editor(before);
  adapter.applyEdit({ from: 0, to: 'remove this line\n'.length, insert: 'human prefix\n' });
  const local = view.last.changes;
  const first = before.indexOf('first'), second = before.indexOf('second');
  const incoming = ChangeSet.of([{ from: first, to: first + 5, insert: 'AGENT ONE' }, { from: second, to: second + 6, insert: 'AGENT TWO' }], before.length);
  const event = { changes: incoming.toJSON(), text: apply(incoming, before) };
  adapter.setSelection(adapter.getText().indexOf('tail'), adapter.getText().length);
  const selection = adapter.getSelection();
  const { remote, pending } = rebaseDocumentEvent({ before, current: adapter.getText(), transactions: [local], event });
  adapter.applyRemoteChanges(remote);
  assert.equal(view.last.annotation(Transaction.addToHistory), false);
  assert.equal(view.last.annotation(remoteDocumentChange), true);
  assert.equal(adapter.getText(), apply(pending, event.text));
  assert.equal(adapter.getSelection().anchor, remote.mapPos(selection.anchor));
  assert.equal(adapter.getSelection().head, remote.mapPos(selection.head));
  assert.match(adapter.getText(), /^human prefix/);
  assert.match(adapter.getText(), /AGENT ONE target\nAGENT TWO target/);
  adapter.undo();
  assert.equal(adapter.getText(), event.text, 'undo removes only the human change');
  adapter.redo();
  assert.equal(adapter.getText(), apply(pending, event.text));
});

test('human edits after Agent changes remain undoable without undoing Agent changes', () => {
  const before = 'alpha\nbeta\ngamma';
  const { view, adapter } = editor(before);
  adapter.applyEdit({ from: 0, insert: 'human\n' });
  const incoming = ChangeSet.of([{ from: 6, to: 10, insert: 'AGENT' }], before.length);
  const event = { changes: incoming.toJSON(), text: apply(incoming, before) };
  const { remote } = rebaseDocumentEvent({ before, current: adapter.getText(), transactions: [view.last.changes], event });
  adapter.applyRemoteChanges(remote);
  adapter.applyEdit({ from: adapter.getText().length, insert: '\nhuman tail' });
  adapter.undo();
  assert.equal(adapter.getText(), 'human\nalpha\nAGENT\ngamma');
  adapter.undo();
  assert.equal(adapter.getText(), event.text);
  adapter.undo();
  assert.equal(adapter.getText(), event.text, 'Agent edits never become local undo entries');
});

test('overlap and malformed exact change events do not silently overwrite human input', () => {
  const before = 'repeated repeated';
  const local = ChangeSet.of([{ from: 0, to: 8, insert: 'human' }], before.length);
  const incoming = ChangeSet.of([{ from: 0, to: 8, insert: 'agent' }], before.length);
  const args = { before, current: apply(local, before), transactions: [local], event: { changes: incoming.toJSON(), text: apply(incoming, before) } };
  assert.throws(() => rebaseDocumentEvent(args), /intersect/);
  assert.throws(() => rebaseDocumentEvent({ ...args, event: { ...args.event, text: 'incorrect' } }), /baseline/);
});
