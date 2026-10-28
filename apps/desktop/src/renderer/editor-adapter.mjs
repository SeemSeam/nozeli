import { undo, redo, isolateHistory } from '@codemirror/commands';
import { Annotation, ChangeSet, Transaction } from '@codemirror/state';
import { anchorText, textChangeSet } from '../domain/tag-anchors.mjs';

export const remoteDocumentChange = Annotation.define();
export const normalizeEditorText = anchorText;
export function checkOffset(text, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new RangeError('Invalid UTF-16 document offset.');
  return offset;
}
export function offsetToPosition(text, offset) {
  checkOffset(text, offset);
  const lines = text.slice(0, offset).split('\n');
  return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
}
export function positionToOffset(text, { lineNumber, column }) {
  const lines = text.split('\n');
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > lines.length || !Number.isSafeInteger(column) || column < 1 || column > lines[lineNumber - 1].length + 1) throw new RangeError('Invalid document position.');
  return lines.slice(0, lineNumber - 1).reduce((size, line) => size + line.length + 1, 0) + column - 1;
}
export function validateEdit(text, { from, to = from, insert = '' }) {
  checkOffset(text, from); checkOffset(text, to);
  if (to < from || typeof insert !== 'string') throw new RangeError('Invalid document edit.');
  return { from, to, insert: normalizeEditorText(insert) };
}
export function canonicalChanges(before, edits, after) {
  // Engine-provided edit ranges give exact mapping even with repeated text.
  const exact = ChangeSet.of(edits.map(edit => validateEdit(before, edit)), before.length);
  return textChangeSet(before, after, exact.toJSON());
}

export function codeMirrorAdapter(view, { readOnly = false } = {}) {
  let disposed = false;
  const listeners = new Set();
  const live = () => { if (disposed) throw new Error('Editor disposed.'); };
  return {
    engine: 'codemirror',
    setReadOnly(value) { live(); readOnly = Boolean(value); },
    subscribe(listener) { live(); listeners.add(listener); return () => listeners.delete(listener); },
    _notify(update) { for (const listener of listeners) listener({ before: update.startState.doc.toString(), text: update.state.doc.toString(), changes: update.changes }); },
    undo() { live(); if (!readOnly) undo(view); },
    redo() { live(); if (!readOnly) redo(view); },
    getText() { live(); return view.state.doc.toString(); },
    getSelection() { live(); const s = view.state.selection.main; return { anchor: s.anchor, head: s.head, from: s.from, to: s.to }; },
    getEditorElement() { live(); return view.dom; },
    getScrollElement() { live(); return view.scrollDOM; },
    getScrollTop() { live(); return view.scrollDOM.scrollTop; },
    setScrollTop(value) { live(); view.scrollDOM.scrollTop = Math.max(0, Number(value) || 0); },
    getScrollMetrics() { live(); return { top: view.scrollDOM.scrollTop, height: view.scrollDOM.clientHeight, total: view.scrollDOM.scrollHeight }; },
    getOffsetTop(offset) { live(); checkOffset(view.state.doc, offset); const line = view.lineBlockAt(offset); return line.top + view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop; },
    getOffsetBottom(offset) { live(); checkOffset(view.state.doc, offset); const line = view.lineBlockAt(offset); return line.bottom + view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop; },
    getViewportOffset(fraction = .25) {
      live(); const box = view.scrollDOM.getBoundingClientRect(), content = view.contentDOM.getBoundingClientRect();
      return view.posAtCoords({ x: Math.max(box.left + 8, content.left + 8), y: box.top + box.height * fraction }, false)
        ?? view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop + box.height * fraction - (view.documentTop - box.top + view.scrollDOM.scrollTop))).from;
    },
    onScroll(listener) { live(); view.scrollDOM.addEventListener('scroll', listener, { passive: true }); return () => view.scrollDOM.removeEventListener('scroll', listener); },
    setViewportHeight(height) { live(); const size = Math.max(0, Number(height) || 0); view.dom.style.height = size + 'px'; view.dom.style.removeProperty('max-height'); view.scrollDOM.style.minHeight = '0'; view.scrollDOM.style.overflow = 'auto'; view.requestMeasure?.(); },
    coordsAtOffset(offset) { live(); checkOffset(this.getText(), offset); return view.coordsAtPos(offset); },
    onComposition({ start, end } = {}) { live(); const element = view.dom; const onStart = () => start?.(); const onEnd = () => end?.(); element.addEventListener('compositionstart', onStart); element.addEventListener('compositionend', onEnd); return () => { element.removeEventListener('compositionstart', onStart); element.removeEventListener('compositionend', onEnd); }; },
    setSelection(anchor, head = anchor) { live(); const text = this.getText(); checkOffset(text, anchor); checkOffset(text, head); view.dispatch({ selection: { anchor, head } }); },
    applyEdit(edit) { live(); if (readOnly) throw new Error('Editor is read-only.'); view.dispatch({ changes: validateEdit(this.getText(), edit), userEvent: 'input', annotations: isolateHistory.of('full') }); },
    applyEdits(edits) { live(); if (readOnly) throw new Error('Editor is read-only.'); const text = this.getText(); view.dispatch({ changes: edits.map(edit => validateEdit(text, edit)), userEvent: 'input', annotations: isolateHistory.of('full') }); },
    applyRemoteChanges(changes) {
      live();
      if (!(changes instanceof ChangeSet) || changes.length !== view.state.doc.length) throw new RangeError('Remote changes do not match the current document.');
      // CodeMirror maps selection and local history through this transaction,
      // without adding the Agent edit to the person's undo stack.
      view.dispatch({ changes, annotations: [Transaction.addToHistory.of(false), remoteDocumentChange.of(true)] });
    },
    revealRange(from, to = from) { live(); this.setSelection(from, to); view.dispatch({ scrollIntoView: true }); },
    focus() { live(); view.focus(); },
    dispose() { if (!disposed) { disposed = true; listeners.clear(); view.destroy(); } },
  };
}
