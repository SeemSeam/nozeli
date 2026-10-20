import { installTex, isTex } from './tex-intelligence.mjs';
import { lineAuthorship } from '../domain/authorship-groups.mjs';
import { authorshipLayer, authorshipFragments } from './authorship-gutter.mjs';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import { formatEditor } from './document-context-menu.mjs';
import * as javascript from 'monaco-editor/languages/definitions/javascript/javascript.js';
import * as typescript from 'monaco-editor/languages/definitions/typescript/typescript.js';
import * as python from 'monaco-editor/languages/definitions/python/python.js';
import * as css from 'monaco-editor/languages/definitions/css/css.js';
import * as html from 'monaco-editor/languages/definitions/html/html.js';
import * as sql from 'monaco-editor/languages/definitions/sql/sql.js';
import * as java from 'monaco-editor/languages/definitions/java/java.js';
import * as cpp from 'monaco-editor/languages/definitions/cpp/cpp.js';
import * as go from 'monaco-editor/languages/definitions/go/go.js';
import * as rust from 'monaco-editor/languages/definitions/rust/rust.js';
import { checkOffset, normalizeEditorText, validateEdit, canonicalChanges } from './editor-adapter.mjs';
import { makeNoteTag, makeAnchorTag } from './note-tag.mjs';
import { completionLabelsFor, documentSymbols, languageIdForPath, navigationTarget } from './code-language.mjs';
import { mapTextAnchor } from '../domain/tag-anchors.mjs';

globalThis.MonacoEnvironment = { getWorker: () => new Worker(new URL('./monaco-worker.js', import.meta.url), { type: 'module' }) };
// Monaco ships JSON semantic services separately; use its JavaScript tokenizer
// as a safe offline fallback until the JSON worker is wired into the host.
const languageDefinitions = { javascript, typescript, python, json: javascript, css, html, sql, java, cpp, go, rust };
for (const [id, module] of Object.entries(languageDefinitions)) {
  monaco.languages.register({ id });
  monaco.languages.setLanguageConfiguration(id, module.conf);
  monaco.languages.setMonarchTokensProvider(id, module.language);
}
const completionProviders = new Map();
const lspRequest = (state, action, extra = {}) => state?.projectId && /\.(?:[cm]?js|jsx|ts|tsx|tex|bib|sty|cls)$/i.test(state.relPath) ? window.nozeli.invoke('lsp.request', { projectId: state.projectId, relPath: state.relPath, text: state.model.getValue(), version: state.version, action, ...extra }) : Promise.resolve({ ok: false });
installTex(monaco, lspRequest).catch(error => console.error('TeX highlighting', error));
const fallbackCompletions = (id, model, range) => {
  const symbols = new Set(documentSymbols(model.getValue()).map(item => item.name));
  return { suggestions: completionLabelsFor(id, model.getValue()).map(label => ({ label, insertText: label, kind: symbols.has(label) ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Keyword, range })) };
};
const lspLocations = value => Array.isArray(value) ? value : value ? [value] : [];
for (const id of Object.keys(languageDefinitions)) {
  completionProviders.set(id, monaco.languages.registerCompletionItemProvider(id, {
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: position.column };
      const state = model.__nozeliLsp;
      const response = await lspRequest(state, 'completion', { line: position.lineNumber - 1, column: position.column - 1 });
      const items = response.ok ? (response.value?.items || response.value || []) : [];
      if (!items.length) return fallbackCompletions(id, model, range);
      return { suggestions: items.map(item => ({ label: item.label, insertText: item.insertText || item.label, detail: item.detail, documentation: item.documentation, kind: monaco.languages.CompletionItemKind.Text, range })) };
    },
  }));
  monaco.languages.registerHoverProvider(id, { async provideHover(model, position) {
    const state = model.__nozeliLsp;
    const response = await lspRequest(state, 'hover', { line: position.lineNumber - 1, column: position.column - 1 });
    const hover = response.ok ? response.value : null;
    if (!hover) return null;
    const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
    return { contents: contents.filter(Boolean).map(item => ({ value: typeof item === 'string' ? item : item.value || '' })) };
  }});
}
let sequence = 0;
export function mountMonaco({ parent, projectId, relPath, text, marks = [], tags = [], readOnly = false, onChange = () => {}, onSelection = () => {}, onNavigate = () => {}, onStatus = () => {}, projectionActions = {}, noteActions = {} }) {
  if (!projectId || !relPath) throw new Error('Project and document identities are required.');
  parent.replaceChildren();
  parent.hidden = false;
  const uri = monaco.Uri.from({ scheme: 'nozeli', authority: projectId, path: '/' + relPath, query: 'instance=' + ++sequence });
  const language = languageIdForPath(relPath) || 'javascript';
  const model = monaco.editor.createModel(normalizeEditorText(text), language, uri);
  const lspState = { projectId, relPath, model, version: 1, syncTimer: 0 };
  model.__nozeliLsp = lspState;
  const syncLsp = () => { if (!/\.(?:[cm]?js|jsx|ts|tsx|tex|bib|sty|cls)$/i.test(relPath)) return; window.clearTimeout(lspState.syncTimer); lspState.syncTimer = window.setTimeout(() => window.nozeli.invoke('lsp.sync', { projectId, relPath, text: model.getValue(), version: lspState.version }).then(result => { if (!model.isDisposed() && !result.ok) onStatus(`代码智能已降级：${result.error?.message || '语言服务器不可用'}`); }).catch(() => {}), 120); };
  syncLsp();
  // The reader owns viewport sizing; Monaco owns its virtual line geometry.
  const editor = monaco.editor.create(parent, { model, readOnly, contextmenu: false, automaticLayout: false, minimap: { enabled: false }, folding: true, showFoldingControls: 'always', foldingHighlight: true, scrollBeyondLastLine: false, fontSize: 14, tabSize: 2, tabCompletion: 'on', editContext: false, inlineSuggest: { enabled: false }, suggest: { preview: true, showMethods: true, showFunctions: true, showKeywords: true }, padding: { top: 16, bottom: 12 } });
  let before = model.getValue(), disposed = false;
  const normalizeItem = item => item?.anchor ? item : Number.isInteger(item?.start) && Number.isInteger(item?.end) ? { ...item, anchor: { start: item.start, end: item.end, quote: item.quote } } : item;
  let items = [...marks, ...tags].map(normalizeItem);
  let facade;
  const listeners = new Set();
  const listener = model.onDidChangeContent(event => {
    lspState.version += 1; syncLsp();
    const after = model.getValue();
    const edits = event.changes.map(change => ({ from: change.rangeOffset, to: change.rangeOffset + change.rangeLength, insert: change.text }));
    const changes = canonicalChanges(before, edits, after);
    const old = before; before = after;
    const change = { before: old, text: after, changes, undo: event.isUndoing, redo: event.isRedoing };
    items = items.map(item => {
      if (!item?.anchor && !Number.isInteger(item?.start)) return item;
      const anchor = item.anchor || item;
      const mapped = mapTextAnchor(anchor, old, after, changes);
      return { ...item, ...(item.anchor ? { anchor: mapped.anchor } : mapped.anchor), ...(item.anchor ? {} : mapped.anchor), locationStatus: mapped.locationStatus, contentStatus: mapped.contentStatus };
    });
    setProjections(items);
    if (onChange.length > 1) onChange(facade, change);
    else onChange(change);
    for (const listener of listeners) listener(change);
  });
  const widgets = new Map();
  const projectionId = item => item?.tag?.id || item?.note?.id || item?.id || `projection-${item?.anchor?.start ?? 0}-${item?.anchor?.end ?? 0}`;
  const projectionSignature = item => JSON.stringify({
    id: projectionId(item),
    kind: item?.tag?.kind || item?.note?.kind || item?.kind,
    status: item?.tag?.status || item?.note?.status,
    open: item?.tag?.open ?? item?.note?.open,
    text: item?.tag?.text || item?.note?.note || item?.text || '',
    replyText: item?.tag?.replyText || '',
    replyAvailability: item?.tag?.replyAvailability,
    draftText: item?.tag?.draftText || '',
    history: item?.tag?.history || [],
  });
  const projectionPosition = item => {
    const anchor = item?.anchor;
    if (!anchor) return null;
    const offset = Math.max(0, Math.min(model.getValue().length, Number.isInteger(anchor.start) ? anchor.start : 0));
    return model.getPositionAt(offset);
  };
  const removeProjection = id => {
    const current = widgets.get(id);
    if (!current) return;
    editor.removeContentWidget(current.widget);
    widgets.delete(id);
  };
  const mountProjection = item => {
    const id = projectionId(item);
    if (!id || !item?.anchor) return;
    const source = item.tag || (item.note && typeof item.note === 'object' ? item.note : { ...item, id: item.id || `projection-${item.anchor.start}-${item.anchor.end}`, note: item.note || item.text || '' });
    const node = item.tag
      ? makeAnchorTag({ ...source, anchor: item.anchor }, projectionActions)
      : makeNoteTag({ ...source, anchor: item.anchor }, noteActions);
    const state = { item, signature: projectionSignature(item), node };
    // Keep card drag/input out of Monaco's selection mouse handler. Pointer
    // moves still bubble to the document listener used by the shared tag.
    node.addEventListener('mousedown', event => event.stopPropagation());
    const widget = {
      suppressMouseDown: true,
      // The ordinal sits left of column 1, outside the text scroller. Keep
      // it in Monaco’s overflow layer, still clipped by the document pane.
      allowEditorOverflow: true,
      getId: () => 'nozeli-projection-' + id,
      getDomNode: () => node,
      getPosition: () => {
        const position = projectionPosition(state.item);
        return position ? { position, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] } : null;
      },
    };
    state.widget = widget;
    widgets.set(id, state);
    editor.addContentWidget(widget);
  };
  const setProjections = items => {
    live();
    const next = new Map((items || []).filter(item => item?.anchor).map(item => [projectionId(item), item]));
    decoration.set([...next.values()].flatMap(item => {
      const start = Math.max(0, Math.min(model.getValue().length, Number.isInteger(item.anchor.start) ? item.anchor.start : 0));
      const end = Math.max(start, Math.min(model.getValue().length, Number.isInteger(item.anchor.end) ? item.anchor.end : start));
      if (start >= end) return [];
      const source = item.tag || item.note || item;
      return [{ range: range(start, end), options: { inlineClassName: 'editor-tag-mark', hoverMessage: { value: typeof source === 'string' ? source : source.note || source.text || '标签' } } }];
    }));
    for (const id of widgets.keys()) if (!next.has(id)) removeProjection(id);
    for (const [id, item] of next) {
      const current = widgets.get(id);
      if (!current) { mountProjection(item); continue; }
      if (current.signature !== projectionSignature(item)) {
        if(item.tag&&current.node.updateConversation?.(item.tag)){current.item=item;current.signature=projectionSignature(item);editor.layoutContentWidget(current.widget);continue;}
        removeProjection(id);mountProjection(item);
        continue;
      }
      current.item = item;
      editor.layoutContentWidget(current.widget);
    }
  };
  const live = () => { if (disposed) throw new Error('Editor disposed.'); };
  const range = (from, to) => { checkOffset(model.getValue(), from); checkOffset(model.getValue(), to); return monaco.Range.fromPositions(model.getPositionAt(from), model.getPositionAt(to)); };
  const decoration = editor.createDecorationsCollection();
  let authorshipGroups=[],openChange=()=>{},authorshipFrame=0;
  const authorship=authorshipLayer('monaco-authorship',group=>openChange(group));
  editor.getDomNode().append(authorship.node);
  const projectAuthorship=()=>{
    if(disposed)return;
    const layout=editor.getLayoutInfo(),scroll=editor.getScrollTop(),lines=[],seen=new Set();
    const addLine=line=>{
      if(line<1||line>model.getLineCount()||seen.has(line))return;
      const top=editor.getTopForLineNumber(line)-scroll,bottom=editor.getBottomForLineNumber(line)-scroll;
      if(bottom>0&&top<layout.height){lines.push({line,top,bottom});seen.add(line);}
    };
    const ranges=editor.getVisibleRanges();
    for(const range of ranges)for(let line=range.startLineNumber;line<=range.endLineNumber;line++)addLine(line);
    // getVisibleRanges returns completely visible rows. Include a partial
    // edge row only when its actual geometry differs from the visible row.
    const first=ranges[0]?.startLineNumber,last=ranges.at(-1)?.endLineNumber;
    if(first>1&&editor.getTopForLineNumber(first-1)<editor.getTopForLineNumber(first))addLine(first-1);
    if(last<model.getLineCount()&&editor.getTopForLineNumber(last+1)>editor.getTopForLineNumber(last))addLine(last+1);
    lines.sort((a,b)=>a.line-b.line);
    authorship.node.style.left=layout.glyphMarginLeft+'px';authorship.node.style.width=layout.glyphMarginWidth+'px';authorship.node.style.height=layout.height+'px';
    authorship.draw(authorshipFragments(authorshipGroups,lines,0,layout.height));
  };
  const scheduleAuthorship=()=>{cancelAnimationFrame(authorshipFrame);authorshipFrame=requestAnimationFrame(projectAuthorship);};
  const authorshipListeners=[editor.onDidScrollChange(scheduleAuthorship),editor.onDidLayoutChange(scheduleAuthorship),
    editor.onDidChangeHiddenAreas(scheduleAuthorship),editor.onDidContentSizeChange(scheduleAuthorship),editor.onDidChangeConfiguration(scheduleAuthorship)];
  const lspUnsubscribe = window.nozeli.subscribe('lsp', event => {
    if (event.projectId !== projectId || (event.server === 'texlab') !== isTex(relPath) || disposed) return;
    if (event.type === 'diagnostics' && event.text != null && event.text !== model.getValue()) return;
    if (event.type === 'ready') onStatus(isTex(relPath) ? 'TexLab 编辑智能已连接。' : 'TypeScript 代码智能已连接。');
    if (event.type === 'exit') onStatus(event.server === 'texlab' ? 'TexLab 已退出；本地模板仍可用。' : `代码智能已降级；服务器已退出（日志：${event.logFile}）。`);
    if (event.type !== 'diagnostics' || event.relPath !== relPath) return;
    const markers = (event.diagnostics || []).map(item => ({
      severity: item.severity === 1 ? monaco.MarkerSeverity.Error : item.severity === 2 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
      message: item.message || 'TypeScript diagnostic',
      startLineNumber: (item.range?.start?.line || 0) + 1,
      startColumn: (item.range?.start?.character || 0) + 1,
      endLineNumber: (item.range?.end?.line ?? item.range?.start?.line ?? 0) + 1,
      endColumn: (item.range?.end?.character ?? item.range?.start?.character ?? 0) + 1,
    }));
    monaco.editor.setModelMarkers(model, 'typescript-language-server', markers);
  });
  const requestPosition = () => { const selection = editor.getSelection(); const position = selection?.getPosition() || { lineNumber: 1, column: 1 }; return { line: position.lineNumber - 1, column: position.column - 1 }; };
  const lspJump = async () => {
    const revision = model.getVersionId(); const position = requestPosition(); const response = await lspRequest(lspState, 'definition', position);
    if (disposed || model.getVersionId() !== revision) return false;
    const location = lspLocations(response.ok ? response.value : null).find(item => item.relPath);
    if (!location) return jumpFallback();
    const rangeValue = location.range || location.targetSelectionRange; const rel = location.relPath;
    if (rel !== relPath) return onNavigate({ path: rel, sourcePath: relPath, projectRelative: true, targetRange: rangeValue });
    const start = model.getPositionAt(model.getOffsetAt({ lineNumber: (rangeValue?.start?.line || 0) + 1, column: (rangeValue?.start?.character || 0) + 1 }));
    const end = model.getPositionAt(model.getOffsetAt({ lineNumber: (rangeValue?.end?.line || rangeValue?.start?.line || 0) + 1, column: (rangeValue?.end?.character || rangeValue?.start?.character || 0) + 1 }));
    editor.setSelection(new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column)); editor.revealPositionInCenter(start); onStatus('已跳转到定义。'); return true;
  };
  const jumpFallback = () => {
    if (disposed) return false;
    if (isTex(relPath)) { onStatus('当前位置未找到 TeX 定义；请检查 TexLab 是否可用。'); return false; }
    const selection = editor.getSelection(); if (!selection) return false;
    const target = navigationTarget(model.getValue(), model.getOffsetAt(selection.getPosition()));
    if (target.kind === 'missing') { onStatus(target.name ? `未找到“${target.name}”的定义或项目路径。` : '当前位置没有可跳转目标。'); return false; }
    if (target.kind === 'path') { onNavigate({ ...target, sourcePath: relPath }); return true; }
    editor.setSelection(new monaco.Selection(model.getPositionAt(target.from).lineNumber, model.getPositionAt(target.from).column, model.getPositionAt(target.to).lineNumber, model.getPositionAt(target.to).column)); editor.revealPositionInCenter(model.getPositionAt(target.from)); onStatus(`已跳转到 ${target.name} 定义。`); return true;
  };
  const jump = () => lspJump().catch(() => jumpFallback());
  const applyLspEdits = edits => {
    const changes = (edits || []).map(edit => ({ from: model.getOffsetAt({ lineNumber: (edit.range.start.line || 0) + 1, column: (edit.range.start.character || 0) + 1 }), to: model.getOffsetAt({ lineNumber: (edit.range.end.line || 0) + 1, column: (edit.range.end.character || 0) + 1 }), insert: edit.newText || '' })).sort((a, b) => b.from - a.from);
    for (const change of changes) facade?.applyEdit(change);
  };
  const formatDocument = () => formatEditor({ adapter: facade, projectId, relPath, current: () => !disposed, status: onStatus });
  editor.addAction({ id: 'nozeli.references', label: '查找 TypeScript 引用', run: async () => { const response = await lspRequest(lspState, 'references', requestPosition()); const count = response.ok && Array.isArray(response.value) ? response.value.length : 0; onStatus(response.ok ? `找到 ${count} 个引用。` : '代码智能不可用，无法查找引用。'); } });
  editor.addAction({ id: 'nozeli.rename-preview', label: '预览 TypeScript 重命名', run: async () => { const name = window.prompt('新名称'); if (!name) return; const response = await lspRequest(lspState, 'rename', { ...requestPosition(), newName: name }); const changes = response.ok ? Object.values(response.value?.changes || {}) : []; const count = changes.reduce((sum, item) => sum + (item.edits?.length || 0), 0); onStatus(response.ok ? `重命名预览：${count} 处修改，未写入文件。` : '代码智能不可用，无法预览重命名。'); } });
  editor.addAction({ id: 'nozeli.format', label: '格式化文档（Prettier / LSP）', keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF], run: formatDocument });
  editor.addAction({id:'nozeli.word-wrap',label:'切换自动换行',keybindings:[monaco.KeyMod.Alt|monaco.KeyCode.KeyZ],
    run:()=>editor.updateOptions({wordWrap:editor.getOption(monaco.editor.EditorOption.wordWrap)==='off'?'on':'off'})});
  editor.addCommand(monaco.KeyCode.F12, jump);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyG, jump);
  const keyListener = event => {
    if ((event.ctrlKey || event.metaKey) && event.code === 'Space') {
      event.preventDefault(); event.stopImmediatePropagation(); editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
    } else if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'g') {
      event.preventDefault(); event.stopImmediatePropagation(); jump();
    }
  };
  editor.getDomNode()?.addEventListener('keydown', keyListener, true);
  const selectionListener = editor.onDidChangeCursorSelection(() => onSelection(facade));
  const adapter = {
    engine: 'monaco',
    setAuthorship(value,{visible=true,onOpen=()=>{}}={}) {
      live();openChange=onOpen;authorshipGroups=visible?lineAuthorship(model.getValue(),value):[];
      const showMargin=authorshipGroups.length>0;if(editor.getOption(monaco.editor.EditorOption.glyphMargin)!==showMargin)editor.updateOptions({glyphMargin:showMargin});
      scheduleAuthorship();
    },
    offsetAtPoint(x, y) { live(); const position = editor.getTargetAtClientPoint(x, y)?.position; return position ? model.getOffsetAt(position) : null; },
    isWrapped:()=>editor.getOption(monaco.editor.EditorOption.wordWrap)!=='off',
    foldAll() { live(); editor.focus(); return editor.getAction('editor.foldAll').run(); },
    unfoldAll() { live(); editor.focus(); return editor.getAction('editor.unfoldAll').run(); },
    command(name) { live(); editor.focus(); return editor.trigger('nozeli-menu', { find: 'actions.find', replace: 'editor.action.startFindReplaceAction', comment: 'editor.action.commentLine',wordWrap:'nozeli.word-wrap' }[name], {}); },
    subscribe(listener) { live(); listeners.add(listener); return () => listeners.delete(listener); },
    getText() { live(); return model.getValue(); },
    getSelection() { live(); const s = editor.getSelection(); if (!s) return { anchor: 0, head: 0, from: 0, to: 0 }; const anchor = model.getOffsetAt(s.getSelectionStart()), head = model.getOffsetAt(s.getPosition()); return { anchor, head, from: Math.min(anchor, head), to: Math.max(anchor, head) }; },
    getEditorElement() { live(); return editor.getDomNode(); },
    getScrollElement() { live(); return editor.getDomNode(); },
    getScrollTop() { live(); return editor.getScrollTop(); },
    setScrollTop(value) { live(); editor.setScrollTop(Math.max(0, Number(value) || 0)); },
    getScrollMetrics() { live(); return { top: editor.getScrollTop(), height: editor.getLayoutInfo().height, total: editor.getScrollHeight() }; },
    getOffsetTop(offset) { live(); checkOffset({ length: model.getValueLength() }, offset); const pos = model.getPositionAt(offset); return editor.getTopForPosition(pos.lineNumber, pos.column); },
    getOffsetBottom(offset) { live(); return this.getOffsetTop(offset) + editor.getOption(monaco.editor.EditorOption.lineHeight); },
    getViewportOffset(fraction = .25) {
      live(); const box = editor.getDomNode().getBoundingClientRect(), info = editor.getLayoutInfo();
      const pos = editor.getTargetAtClientPoint(box.left + info.contentLeft + 8, box.top + info.height * fraction)?.position;
      return pos ? model.getOffsetAt(pos) : model.getOffsetAt(editor.getVisibleRanges()[0]?.getStartPosition() || { lineNumber: 1, column: 1 });
    },
    onScroll(listener) { live(); const disposable = editor.onDidScrollChange(event => { if (event.scrollTopChanged) listener(); }); return () => disposable.dispose(); },
    setViewportHeight(height) {
      live();
      const node = editor.getDomNode();
      // clientWidth rounds fractional CSS pixels up at non-integer display
      // scales. That can create an outer scrollbar and an endless resize loop.
      const width = Math.max(0, Math.floor(parent.getBoundingClientRect().width));
      const size = Math.max(0, Math.floor(Number(height) || 0));
      const current = editor.getLayoutInfo();
      if (current.width === width && current.height === size) return;
      if (node) node.style.removeProperty('max-height');
      editor.layout({ width, height: size });
    },
    setFontSize(value) { live(); if (Number.isFinite(value) && editor.getOption(monaco.editor.EditorOption.fontSize) !== value) { editor.updateOptions({fontSize:value}); } },
    coordsAtOffset(offset) { live(); checkOffset(this.getText(), offset); const position = model.getPositionAt(offset); const visible = editor.getScrolledVisiblePosition(position); const node = editor.getDomNode(); if (!visible || !node) return null; const bounds = node.getBoundingClientRect(); return { left: bounds.left + visible.left, right: bounds.left + visible.left + Math.max(1, visible.width || 1), top: bounds.top + visible.top, bottom: bounds.top + visible.top + Math.max(1, visible.height || 1) }; },
    onComposition({ start, end } = {}) { live(); const element = editor.getDomNode(); if (!element) return () => {}; const onStart = () => start?.(); const onEnd = () => end?.(); element.addEventListener('compositionstart', onStart); element.addEventListener('compositionend', onEnd); return () => { element.removeEventListener('compositionstart', onStart); element.removeEventListener('compositionend', onEnd); }; },
    setSelection(anchor, head = anchor) { live(); const a = model.getPositionAt(checkOffset(this.getText(), anchor)), h = model.getPositionAt(checkOffset(this.getText(), head)); editor.setSelection(new monaco.Selection(a.lineNumber, a.column, h.lineNumber, h.column)); },
    applyEdit(edit) { live(); if (readOnly) throw new Error('Editor is read-only.'); const e = validateEdit(this.getText(), edit); editor.pushUndoStop(); editor.executeEdits('nozeli', [{ range: range(e.from, e.to), text: e.insert }]); editor.pushUndoStop(); },
    applyEdits(edits) { live(); if (readOnly) throw new Error('Editor is read-only.'); const text = this.getText(); const valid = edits.map(edit => validateEdit(text, edit)); editor.pushUndoStop(); editor.executeEdits('nozeli', valid.map(e => ({ range: range(e.from, e.to), text: e.insert }))); editor.pushUndoStop(); },
    revealRange(from, to = from) { live(); this.setSelection(from, to); editor.revealRangeInCenter(range(from, to)); },
    setProjections,
    focus() { live(); editor.focus(); },
    undo() { live(); if (!readOnly) editor.trigger('nozeli', 'undo'); },
    redo() { live(); if (!readOnly) editor.trigger('nozeli', 'redo'); },
    anchorItems() { live(); return items; },
    setNotes(next) { live(); items = [...next.map(normalizeItem), ...items.filter(item => item.tag)]; setProjections(items); },
    setTags(next) { live(); items = [...items.filter(item => item.note), ...next.map(normalizeItem)]; setProjections(items); },
    jumpToDefinition: jump,
    modelCount() { return monaco.editor.getModels().length; },
    dispose() { if (!disposed) { disposed = true; cancelAnimationFrame(authorshipFrame);for(const listener of authorshipListeners)listener.dispose();authorship.node.remove();window.clearTimeout(lspState.syncTimer); lspUnsubscribe?.(); monaco.editor.setModelMarkers(model, 'typescript-language-server', []); listeners.clear(); listener.dispose(); selectionListener.dispose(); editor.getDomNode()?.removeEventListener('keydown', keyListener, true); for (const id of [...widgets.keys()]) removeProjection(id); decoration.clear(); editor.dispose(); model.dispose(); } },
  };
  adapter.setProjections = setProjections;
  adapter.adapter = adapter;
  facade = adapter;
  setProjections(items);
  return adapter;
}
