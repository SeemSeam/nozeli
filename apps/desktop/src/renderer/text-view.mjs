import { codeMirrorAdapter } from './editor-adapter.mjs';
import { authorshipGutter } from './authorship-gutter.mjs';
import { codeExtensions, languageIdForPath, navigationTarget } from './code-language.mjs';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { makeNoteTag, makeAnchorTag } from './note-tag.mjs';
import { tagProjectionContent } from './tag-projection-state.mjs';
import { basicSetup } from 'codemirror';
import { invertedEffects, toggleLineComment } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { acceptCompletion, moveCompletionSelection, selectedCompletionIndex, startCompletion } from '@codemirror/autocomplete';
import { mapTextAnchor } from '../domain/tag-anchors.mjs';
export function projectTextAnchor(anchor, length) {
  const size = Math.max(0, Number.isInteger(length) ? length : 0);
  const start = Number.isInteger(anchor?.start) ? anchor.start : null;
  const end = Number.isInteger(anchor?.end) ? anchor.end : null;
  if (start === null || end === null || start < 0 || end <= start) return { start: 0, end: size, mark: size > 0 ? [0, size] : null, drifted: true };
  const projectedStart = Math.max(0, Math.min(start, size));
  const projectedEnd = Math.max(0, Math.min(end, size));
  let mark = projectedStart < projectedEnd ? [projectedStart, projectedEnd] : null;
  if (!mark && size > 0) {
    const boundary = Math.min(projectedStart, size - 1);
    mark = [boundary, boundary + 1];
  }
  return { start: projectedStart, end: projectedEnd, mark, drifted: projectedStart !== start || projectedEnd !== end };
}

export function mountText({ parent, relPath, text, marks = [], tags = [], onChange = () => {}, onSelection = () => {}, onNavigate = () => {}, onStatus = () => {}, readOnly = false, noteActions = {}, tagActions = {}, onPasteImage = null }) {
  parent.replaceChildren();
  parent.hidden = false;
  const language = /\.(md|markdown)$/i.test(relPath) ? markdown() : codeExtensions(relPath);
  class NoteWidget extends WidgetType {
    constructor(note, transient = false) { super(); this.note = note; this.transient = transient; this.content = tagProjectionContent(note); }
    updateDOM(dom) {
      if (this.transient !== dom._transientTag || this.content !== dom._tagContent) return false;
      dom.updateAnchor?.(this.note.anchor);
      return true;
    }
    toDOM() {
      const dom = this.transient ? makeAnchorTag(this.note, tagActions) : makeNoteTag(this.note,noteActions);
      dom._transientTag = this.transient; dom._tagContent = this.content;
      return dom;
    }
    ignoreEvent() { return true; }
  }
  const setMarks = StateEffect.define();
  const wrapping=new Compartment();let wrap=/\.(?:md|markdown)$/i.test(relPath);
  let openChange=()=>{};
  const authorship=authorshipGutter(eventId=>openChange(eventId));
  function decorationsFor(items, length = text.length) {
    const projected = items.filter(mark => mark.locationStatus !== 'orphaned' && mark.locationStatus !== 'unresolved').map(mark => ({ mark, anchor: projectTextAnchor(mark, length) }));
    const safe = projected.filter(({ anchor }) => anchor.mark || anchor.start <= length);
    return safe.length ? Decoration.set(safe.flatMap(({ mark, anchor }) => {
      const source = mark.note || mark.tag;
      const item = source ? { ...source, anchorDrift: anchor.drifted || source.anchorDrift || mark.locationStatus === 'estimated' || mark.contentStatus === 'modified' } : null;
      const decorations = anchor.mark ? [Decoration.mark({ class: mark.tag ? `text-tag-${mark.tag.status === 'followup' ? 'followup' : mark.tag.kind}` : 'text-note' }).range(anchor.mark[0], anchor.mark[1])] : [];
      if (item) decorations.push(Decoration.widget({ widget: new NoteWidget(item, Boolean(mark.tag)), side: -1 }).range(anchor.start));
      return decorations;
    }), true) : Decoration.none;
  }
  const field = StateField.define({
    create: () => ({ items: [...marks, ...tags], decorations: decorationsFor([...marks, ...tags]) }),
    update: (value, transaction) => {
      let items = value.items;
      if (transaction.docChanged) items = items.map(item => {
        if (item.locationStatus === 'orphaned' || item.locationStatus === 'unresolved') return item;
        const mapped = mapTextAnchor(item, transaction.startState.doc.toString(), transaction.newDoc.toString(), transaction.changes);
        return { ...item, ...(mapped.anchor || {}), locationStatus: mapped.locationStatus, contentStatus: mapped.contentStatus };
      });
      for (const effect of transaction.effects) if (effect.is(setMarks)) items = effect.value;
      return items === value.items ? value : { items, decorations: decorationsFor(items, transaction.newDoc.length) };
    },
    provide: source => EditorView.decorations.from(source, value => value.decorations),
  });
  const languageId = languageIdForPath(relPath);
  const jump = view => {
    const target = navigationTarget(view.state.doc.toString(), view.state.selection.main.head);
    if (target.kind === 'missing') { onStatus(target.name ? `未找到“${target.name}”的定义或项目路径。` : '当前位置没有可跳转目标。'); return true; }
    if (target.kind === 'path') { onNavigate({ ...target, sourcePath: relPath }); return true; }
    view.dispatch({ selection: { anchor: target.from, head: target.to }, scrollIntoView: true });
    onStatus(`已跳转到 ${target.name} 定义。`);
    return true;
  };
  const acceptTabCompletion = view => {
    if (selectedCompletionIndex(view.state) === null) moveCompletionSelection(true)(view);
    if (acceptCompletion(view)) return true;
    const option = view.dom.ownerDocument.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"] .cm-completionLabel')
      || view.dom.ownerDocument.querySelector('.cm-tooltip-autocomplete li .cm-completionLabel');
    const label = option?.textContent?.trim();
    if (!label || !/^[A-Za-z_$][\w$]*$/.test(label)) return false;
    const head = view.state.selection.main.head;
    const before = view.state.doc.sliceString(0, head);
    const match = /[A-Za-z_$][\w$]*$/.exec(before);
    if (!match) return false;
    view.dispatch({ changes: { from: head - match[0].length, to: head, insert: label } });
    return true;
  };
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        EditorView.cspNonce.of(document.querySelector('meta[name="nozeli-style-nonce"]').content),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        language,
        field,
        authorship.extension,
        wrapping.of(wrap ? EditorView.lineWrapping : []),
        invertedEffects.of(transaction => transaction.docChanged ? [setMarks.of(transaction.startState.field(field).items)] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) { update.view.adapter?._notify(update); onChange(update.view, update); }
          if (update.selectionSet) onSelection(update.view);
        }),
        EditorView.domEventHandlers({ keydown(event, view) {
          if(event.altKey&&!event.ctrlKey&&!event.metaKey&&event.code==='KeyZ'){
            event.preventDefault();wrap=!wrap;view.dispatch({effects:wrapping.reconfigure(wrap?EditorView.lineWrapping:[])});return true;
          }
          if (event.ctrlKey && event.code === 'Space') { event.preventDefault(); startCompletion(view); return true; }
          if (event.key === 'Tab' && !event.shiftKey && acceptTabCompletion(view)) { event.preventDefault(); return true; }
          if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'g') { event.preventDefault(); return jump(view); }
          return false;
        },
          // Real clipboard images become immutable material files; the markdown
          // reference is inserted only after the bytes are durably on disk.
          // The handler must stay synchronous: an async return value would read
          // as "handled" and swallow ordinary text pastes.
          paste(event, view) {
            if (!onPasteImage || readOnly) return false;
            const items = [...(event.clipboardData?.items || [])];
            const images = items.filter(item => item.kind === 'file' && /^image\/(?:png|jpeg|webp)$/.test(item.type));
            if (!images.length) return false;
            event.preventDefault();
            void (async () => {
              let stored = 0;
              for (const item of images) {
                const file = item.getAsFile();
                if (!file) continue;
                try { await onPasteImage({ view, bytes: await file.arrayBuffer(), name: file.name || '' }); stored += 1; }
                catch (error) { onStatus(error?.message || '粘贴图片失败，文字内容未改动。'); }
              }
              if (stored) onStatus(`已插入 ${stored} 张粘贴图片。`);
            })();
            return true;
          } }),
      ],
    }),
  });
  const keydown = event => {
    if (event.ctrlKey && event.code === 'Space') { event.preventDefault(); event.stopPropagation(); startCompletion(view); return; }
    if (event.key === 'Tab' && !event.shiftKey && acceptTabCompletion(view)) { event.preventDefault(); event.stopPropagation(); }
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'g') {
      event.preventDefault(); event.stopImmediatePropagation(); jump(view);
    }
  };
  view.dom.addEventListener('keydown', keydown, true);
  view.adapter = codeMirrorAdapter(view, { readOnly });
  view.adapter.setAuthorship=(value,{visible=true,onOpen=()=>{}}={})=>{openChange=onOpen;view.dispatch({effects:authorship.set.of({authorship:value,visible})});};
  view.adapter.offsetAtPoint = (x, y) => view.posAtCoords({ x, y });
  view.adapter.isWrapped=()=>wrap;
  view.adapter.command = name => { view.focus(); if(name==='wordWrap'){wrap=!wrap;view.dispatch({effects:wrapping.reconfigure(wrap?EditorView.lineWrapping:[])});return;}if (name === 'comment') return toggleLineComment(view); if (name === 'find' || name === 'replace') return openSearchPanel(view); };
  view.codeLanguage = languageId;
  view.jumpToDefinition = () => jump(view);
  view.anchorItems = () => view.state.field(field).items;
  view.setNotes = (items) => { const current = view.anchorItems().filter(item => item.tag); marks = items; view.dispatch({ effects: setMarks.of([...marks, ...current]) }); };
  view.setTags = (items) => { const current = view.anchorItems().filter(item => item.note); tags = items; view.dispatch({ effects: setMarks.of([...current, ...tags]) }); };
  return view;
}
