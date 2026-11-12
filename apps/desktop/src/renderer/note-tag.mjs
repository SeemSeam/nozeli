import {mountLocalWindow,ensureLocalWindowLayer,viewportWindowEnvironment,defaultLocalWindowView} from './local-window.mjs';
import {createLocalWindowView} from './local-window-view.mjs';
import {sourcePageWindowEnvironment} from './source-page-window-environment.mjs';
const tagWindows = new Set();
const tagSessions = new Map();
const tagMounts = new Set();
function sourceMarker(key, fallback) { const session=tagSessions.get(key);return session?.marker?.isConnected?session.marker:[...(session?.markers || [])].find(marker=>marker.isConnected) || session?.marker || fallback; }
export async function disposeTagWindows(annotationId) {
  await Promise.all([...tagMounts]);
  for (const [key, session] of tagSessions) {
    if (annotationId && session.id !== annotationId) continue;
    await session.root.localWindow?.dispose();
    session.dispose();tagSessions.delete(key);
  }
}
export async function flushTagWindows() { await Promise.all([...tagMounts]); await Promise.all([...tagWindows].map(window => window.flush())); }
import {setIconButton} from './ui-icons.mjs';
import { renderTagMarkdown, tagMarkdownSummary } from './tag-markdown.mjs';
import { mountAnnotationComposer, describeAnnotationSource } from './annotation-composer.mjs';
import { mountThreadTranscript, threadRounds } from './discussion-thread.mjs';
import { panelButton, panelMenuPosition, observePanelWidth } from './panel-menu.mjs';
import { mountContextMenu } from './context-menu.mjs';
// Tags are persistent view projections with two display states: open and closed-summary.
// Compact card contract: ~28px header (number/title/more/collapse, no local font
// control — conversation size stays a global setting), source shown through the
// number + <details> instead of a persistent row, a bounded composer with
// discussion and task actions, status lines only when they carry state, and
// secondary actions (including removal behind confirmation) in the more menu.
const mountedTagCleanups = new Map();
let tagRemovalObserver = null;
function watchTagRemoval(root, cleanup) {
  if (typeof MutationObserver !== 'function' || !document.body) return;
  mountedTagCleanups.set(root, cleanup);
  if (tagRemovalObserver) return;
  tagRemovalObserver = new MutationObserver(() => {
    for (const [tag, dispose] of mountedTagCleanups) {
      if (tag.isConnected) continue;
      mountedTagCleanups.delete(tag);
      dispose();
    }
    if (!mountedTagCleanups.size) {
      tagRemovalObserver.disconnect();
      tagRemovalObserver = null;
    }
  });
  tagRemovalObserver.observe(document.body, { childList: true, subtree: true });
}

// One card-action menu per document, built on the shared context-menu shell.
// Triggers carry [data-tag-more]; the conversation-wide right-click menu
// (conversation-font.mjs) keeps its own [data-chat-more]/[data-chat-font] path.
let cardMenu = null;
function tagCardMenu(doc = globalThis.document) {
  if (!cardMenu) cardMenu = mountContextMenu({
    id: 'tag-card-menu', label: '标签操作',
    onClose: () => doc.querySelectorAll('[data-tag-more]').forEach(button => button.setAttribute('aria-expanded', 'false')),
    onError: error => console.warn('标签操作失败：', error?.message || error),
  });
  return cardMenu;
}

// Per-instance ids: the same annotation can project into several cards.
let tagSourceSeq = 0;


export function makeAnchorTag({ id, ordinal, kind, text, replyText = '', replyAvailability, readReply, replyEntries = [], status = '', open = true, anchorDrift = false, resolution, history = [], draftText = '', anchor = {}, material = {}, relPath = '', displayLocation, information, executeStatus = '', anchorKind = '' }, { draw, filePath = () => '', sourceText = () => '', remove, save, execute = null, legacyView = () => null, onDraft, onOpen, autoEdit = () => false, inline = false, readOnly = false } = {}) {
  const sessionKey = JSON.stringify([window.__workspaceScope?.projectId,window.__workspaceScope?.viewId,relPath || filePath(),id]);
  const existing = !inline && tagSessions.get(sessionKey);
  if (existing) {
    existing.root.updateReadOnly(readOnly);
    const marker = document.createElement('span');marker.className=existing.root.className;marker.dataset.annotation=id;
    if(existing.root.dataset.anchorKind)marker.dataset.anchorKind=existing.root.dataset.anchorKind;
    const button=document.createElement('button');button.type='button';button.className='note-index';button.textContent=String(ordinal);button.setAttribute('aria-label',`打开标签 ${ordinal}`);
    button.addEventListener('click',()=>{existing.marker=marker;existing.root.openWindow(button);});marker.append(button);existing.marker=marker;
    existing.markers = new Set([...existing.markers].filter(node=>node.isConnected));existing.markers.add(marker);
    for (const method of ['updateAnchor','updateConversation','relayout','fitConversation','updateExecuteStatus','refreshNote']) marker[method]=(...args)=>existing.root[method]?.(...args);
    marker.setOrdinal=value=>{button.textContent=String(value);existing.root.setOrdinal(value);};
    Object.defineProperty(marker,'localWindow',{get:()=>existing.root.localWindow});
    if(kind!=='note')existing.root.updateConversation?.({text,replyText,replyAvailability,readReply,replyEntries,status,history,anchor,material,anchorKind,resolution,anchorDrift});
    return marker;
  }
  const conversation = kind !== 'note';
  let pending = status === 'pending' || status === 'accepted-awaiting-reply';
  const root = document.createElement('span');
  root.className = `note-anchor tag-${kind}${status === 'followup' ? ' tag-followup' : ''}`;
  root.classList.toggle('tag-inline', inline);
  root.dataset.annotation = id;
  const index = document.createElement('button');
  index.type = 'button'; index.className = 'note-index';
  index.textContent = String(ordinal);
  index.setAttribute('aria-label', `打开${kind === 'note' ? '备注' : '对话'} ${ordinal}`);
  const card = document.createElement('span'); card.className = 'note-projection'; card.hidden = false;
  card.classList.add('tag-chat-window');
  let collapsed = !open, controller = null, layoutDisposed = false, requestedOpen = false;
  let composer = null;
  const scope = globalThis.window?.__workspaceScope || {};
  const key = {projectId:scope.projectId,projectInstanceId:scope.projectId,ownerKind:'annotation',ownerId:JSON.stringify({id,relPath:relPath || filePath(),documentSource:scope.documentSource || {type:'project'}}),surfaceId:scope.viewId || scope.windowId || scope.role || 'shell'};
  const oldView = legacyView(id);
  card.classList.toggle('is-collapsed', collapsed);
  index.setAttribute('aria-expanded', String(open));
  const head = document.createElement('span'); head.className = 'note-projection-head';
  const disposeHeader = observePanelWidth(head);
  const initialDraft = kind === 'note' && status && typeof status === 'object' ? status.value : conversation && status !== 'draft' ? draftText : text || '';
  // The header number doubles as the source disclosure: material identity and
  // the frozen quote live behind it in a <details>, never a persistent row.
  const sourceId = `tag-source-${String(id).replace(/[^\w-]/g, '')}-${++tagSourceSeq}`;
  const cardNumber = document.createElement('button');
  cardNumber.type = 'button'; cardNumber.className = 'tag-ordinal';
  cardNumber.textContent = String(ordinal);
  cardNumber.title = '查看来源';
  cardNumber.setAttribute('aria-label', `查看${kind === 'note' ? '备注' : '对话'} ${ordinal} 的来源`);
  cardNumber.setAttribute('aria-controls', sourceId);
  cardNumber.setAttribute('aria-expanded', 'false');
  const content = document.createElement('span'); content.className = 'note-projection-content';
  const sourceChange=document.createElement('span');sourceChange.className='note-source-change';
  const renderAdvisory=()=>{const label=anchorKind==='file'?'':resolution?resolution.advisory||'':anchorDrift?'位置可能偏移':'';sourceChange.textContent=label;sourceChange.hidden=!label;sourceChange.title=label?'原引用与历史已保留；可继续讨论或提交任务，重新定位为可选。':'';};
  renderAdvisory();
  const displayText = () => {
    if (kind === 'note') return initialDraft || '（无文字）';
    const entries = history.length ? history : [{ question: text, reply: replyText, status }];
    return entries.map(entry => {
      const question = entry.question || '（未填写）';
      if (entry.reply) return `问题：${question}\n回复：${entry.reply}`;
      if (entry.status === 'pending' || entry.status === 'accepted-awaiting-reply') return `问题：${question}\n等待前台回复…`;
      if (entry.status === 'failed') return `问题：${question}\n回复失败，请重试。`;
      return question;
    }).join('\n\n');
  };
  content.textContent = tagMarkdownSummary(displayText());
  const close = document.createElement('button'); close.type = 'button'; close.className = 'tag-close'; close.textContent = '×';
  close.setAttribute('aria-label', `关闭${kind === 'note' ? '备注' : '对话'} ${ordinal}`);
  const focusCard = () => {
    const scope = root.closest('.cm-scroller, #markdown-preview-scroll, .reader-scroll, .monaco-editor') || root.parentElement;
    scope?.querySelectorAll('.note-anchor.is-focused').forEach(node => node.classList.remove('is-focused'));
    root.classList.add('is-focused');
  };
  const disposeLayout = () => {
    if (layoutDisposed) return;
    layoutDisposed = true; renderThread?.disposeOriginalReaders?.(); composer?.dispose(); disposeHeader(); tagWindows.delete(controller);
  };
  const fitConversation = () => { if (!layoutDisposed) { autoGrow(); controller?.update(); } };
  // Content-sized composer: empty is one ~32px row, real multiline text grows
  // the textarea (bounded by CSS at ~4 lines, then it scrolls). Height follows
  // only actual content, so an async reply re-render never shrinks a draft.
  const editor = document.createElement('textarea'); editor.className = 'tag-editor'; editor.rows = 1;
  editor.setAttribute('aria-label', kind === 'note' ? '编辑本地备注' : '继续讨论');
  // scrollHeight is 0 while detached — never pin a bogus height then.
  const autoGrow = () => { editor.style.height = 'auto'; const box = editor.scrollHeight; if (box > 0) editor.style.height = box + 'px'; };
  let editing = false, draftValue = initialDraft;
  editor.addEventListener('input', () => {
    draftValue = editor.value;
    autoGrow();
    if (kind === 'note' || status === 'draft') content.textContent = tagMarkdownSummary(draftValue || (kind === 'note' ? '（无文字）' : '（未发送）'));
    if (!conversation) renderTagMarkdown(noteBody, draftValue || '（无文字）');
    onDraft?.(id, draftValue);
  });
  const focusEditor = () => { if (editor.isConnected) editor.focus(); else queueMicrotask(() => { if (editor.isConnected && editing) editor.focus(); }); };
  const canFollowup = conversation && status !== 'draft';
  const composerRow = document.createElement('span'); composerRow.className = 'tag-composer';
  const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'tag-send';
  submit.textContent = kind === 'note' ? '保存备注' : (canFollowup ? '发送续问' : '发送讨论');
  submit.disabled = readOnly || (conversation && pending);
  composerRow.append(editor, submit);
  // Status lines exist only when they carry state (pending/failed/execute).
  const delivery = document.createElement('span'); delivery.className = 'tag-delivery'; delivery.setAttribute('role', 'status'); delivery.hidden = true;
  const setDelivery = value => { delivery.textContent = value || ''; delivery.hidden = !delivery.textContent; };
  setDelivery(pending ? '等待前台回复…' : status === 'failed' ? '回复失败 · 原问题已保留' : '');
  const executeStatusLine = document.createElement('span'); executeStatusLine.className = 'tag-execute-status'; executeStatusLine.setAttribute('role', 'status'); executeStatusLine.hidden = !executeStatus;
  // Keep secondary actions as real buttons for shared menu dispatch.
  // Discussion/task submission stays visible next to the composer.
  const menuActions = document.createElement('span'); menuActions.className = 'tag-menu-actions';
  const executeButton = document.createElement('button'); executeButton.type = 'button'; executeButton.className = 'tag-execute'; executeButton.textContent = '提交任务';
  executeButton.title = '把当前要求与材料直接提交后台；保存备注和打开小窗不派工';
  executeButton.setAttribute('aria-label', `提交 ${ordinal} 对应的任务`);
  executeButton.disabled=readOnly;
  let executing = false;
  executeButton.addEventListener('click', async () => {
    if (readOnly || executeButton.disabled || executing) return;
    if (!execute) { executeStatusLine.textContent = '当前会话不支持后台执行。'; executeStatusLine.hidden = false; return; }
    executing = true; executeButton.disabled = true; submit.disabled = true;
    const submitted = conversation ? editor.value : draftValue;
    try {
      if (!submitted.trim()) { setDelivery('请先填写任务要求；不会重复发送上一条内容。'); return; }
      const accepted = await execute(id, submitted);
      if (!accepted?.accepted) { setDelivery('任务未确认接收，输入已保留。'); return; }
      setDelivery('任务已接收，进展与成果见工作栏。');
      if (conversation && accepted.clearDraft!==false && editor.value === submitted) { draftValue='';editor.value='';autoGrow();onDraft?.(id,''); }
    } catch(error) { setDelivery(error?.message || '提交失败，输入已保留'); }
    finally { executing=false;executeButton.disabled=readOnly;submit.disabled=readOnly||(conversation&&pending); }
  });
  const removeButton = document.createElement('button'); removeButton.type = 'button';
  removeButton.className = conversation ? 'tag-remove' : 'tag-delete';
  if (conversation) { setIconButton(removeButton, 'close'); removeButton.classList.add('ui-danger'); } else removeButton.textContent = '删除备注';
  removeButton.setAttribute('aria-label', conversation ? `移除对话标签 ${ordinal}，保留对话历史` : `删除备注 ${ordinal}`);
  removeButton.title = conversation ? '移除标签，保留对话历史' : '删除备注';
  removeButton.disabled = readOnly;
  removeButton.addEventListener('click', event => { event.stopPropagation(); if (!readOnly) remove?.(id); });
  const editButton = document.createElement('button'); editButton.type = 'button'; editButton.className = 'tag-edit'; editButton.textContent = '编辑备注';
  editButton.addEventListener('click', () => openEdit());
  editButton.disabled = readOnly;
  const drawingButton = information?.drawing && draw ? document.createElement('button') : null;
  if (drawingButton) { drawingButton.type = 'button'; drawingButton.className = 'tag-drawing-edit'; drawingButton.textContent = '编辑涂鸦'; drawingButton.onclick = () => draw(id); }
  if(conversation&&execute)composerRow.append(executeButton);else menuActions.append(executeButton);
  menuActions.append(editButton);
  if (drawingButton) menuActions.append(drawingButton);
  if (remove) menuActions.append(removeButton);
  const source = document.createElement('details'); source.className = 'tag-source'; source.id = sourceId;
  source.open = false; source.hidden = true;
  const sourceLabel = document.createElement('summary'); sourceLabel.className = 'tag-source-summary';
  const quote = document.createElement('blockquote'); quote.className = 'tag-source-quote';
  const pointNote = document.createElement('span'); pointNote.className = 'tag-source-point';
  const pointContext = document.createElement('blockquote'); pointContext.className = 'tag-source-context';
  source.append(sourceLabel, quote, pointNote, pointContext);
  // Position anchors never fake a quote: the host's verified label leads, the
  // optional nearby source text is context (clearly labeled), never an excerpt.
  const renderSource = () => {
    const point = Boolean(material.point || anchor.point);
    const label = describeAnnotationSource({
      relPath: relPath || filePath(), anchor, text: sourceText(),
      displayLocation: point && material.pointLabel ? { label: material.pointLabel } : displayLocation,
    });
    const fileDiscussion=anchorKind==='file';
    sourceLabel.textContent=fileDiscussion?`${relPath||filePath()} · 文件讨论`:label;
    quote.hidden=point||fileDiscussion;
    quote.textContent=point||fileDiscussion?'':material.anchor?.quote||anchor.quote||material.excerpt||'已固定的选区';
    pointNote.hidden=!point&&!fileDiscussion;
    pointNote.textContent=fileDiscussion?'绑定整个文件；每次发送独立冻结材料，不依赖正文位置':point?'文档位置 · 无文字摘录':'';
    const context = point && material.pointContext ? material.pointContext : null;
    const nearby = typeof context?.nearby === 'string' ? context.nearby : '';
    const around = context && (context.before || context.after) ? context : null;
    pointContext.hidden = !context || (!nearby && !around);
    pointContext.textContent = around ? `附近原文：${around.before || ''}⟨位置⟩${around.after || ''}` : nearby ? `附近文字：${nearby}` : '';
    const hasImage = !point && (material.imageDataUrl || anchor.imageDataUrl);
    sourceImage.hidden = !hasImage;
    if (hasImage) sourceImage.src = material.imageDataUrl || anchor.imageDataUrl;
  };
  const sourceImage = document.createElement('img'); sourceImage.alt = '发送时固定的选区截图'; source.append(sourceImage);
  renderSource();
  const syncSource = () => { cardNumber.setAttribute('aria-expanded', String(!source.hidden && source.open)); };
  const toggleSource = () => {
    if (collapsed) return;
    source.open = !source.open;
    source.hidden = !source.open;
    syncSource();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitConversation);
  };
  cardNumber.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); focusCard(); toggleSource(); });
  source.addEventListener('toggle', () => {
    source.hidden = collapsed || !source.open;
    syncSource();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitConversation);
  });
  const setOpen = (next, notify = true, opener = index) => {
    if (notify) requestedOpen = Boolean(next);
    open = Boolean(next);
    collapsed = !open;
    card.classList.toggle('is-collapsed', collapsed);
    content.hidden = false;
    if (collapsed) editing = false;
    const composing = !readOnly && !collapsed && (conversation || editing);
    composerRow.hidden = !composing;
    editor.hidden = !composing;
    card.classList.toggle('editing-note', !conversation && editing && !collapsed);
    if (!composing) composer?.hide(); else { composer?.reset(); autoGrow(); }
    transcript.hidden = collapsed;
    source.hidden = collapsed || !source.open;
    syncSource();
    editButton.hidden = conversation || editing;
    setIconButton(close, collapsed ? 'plus' : 'minus');
    close.setAttribute('aria-label', (collapsed ? '展开' : '折叠') + (conversation ? '对话 ' : '备注 ') + ordinal);
    close.title = close.getAttribute('aria-label');
    index.setAttribute('aria-expanded', String(open));
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitConversation);
    if (notify && controller) void (open ? controller.show(opener) : controller.collapse(true)).catch(error => setDelivery(error.message));
    if (notify && !readOnly) onOpen?.(id, open);
  };
  root.openWindow = opener => setOpen(true, true, opener);
  const toggle = () => setOpen(!open);
  const edit = () => {
    if (readOnly) return;
    setOpen(true);
    focusCard(); editing = true;
    card.classList.toggle('editing-note', !conversation);
    editor.value = draftValue;
    composerRow.hidden = editor.hidden = false;
    editButton.hidden = true;
    composer?.reset(); autoGrow(); focusEditor();
  };
  const openEdit = () => { focusCard(); edit(); };
  content.addEventListener('click', event => { event.stopPropagation(); focusCard(); });
  editor.addEventListener('focus', focusCard);
  editor.addEventListener('dblclick', event => event.stopPropagation());
  submit.addEventListener('click', async () => {
    if (submit.disabled || executing) return;
    submit.disabled = true;
    const submitted = editor.value;
    try {
      const accepted = await save?.(id, editor.value);
      if (!accepted) { setDelivery('发送未被确认，输入已保留；请检查会话状态后手动发送。'); return; }
      if (editor.value === submitted) {
        if (conversation) {
          draftValue = '';
          editor.value = '';
          autoGrow();
          onDraft?.(id, '');
          editing = true;
          if (!collapsed) { composerRow.hidden = editor.hidden = false; }
        } else {
          draftValue = accepted.text;
          content.textContent = tagMarkdownSummary(accepted.text || '（无文字）');
          editing = false;
          composerRow.hidden = editor.hidden = true;
          composer?.hide(); card.classList.remove('editing-note'); content.hidden = false; editButton.hidden = false;
          renderTagMarkdown(noteBody, accepted.text || '（无文字）');
        }
      }
    } catch (error) { setDelivery(error?.message || '发送失败，输入已保留'); }
    finally { submit.disabled = readOnly || (conversation && pending); }
  });
  const more = panelButton(); more.dataset.tagMore = '';
  const cardMenuItems = () => {
    const items = [], isCollapsed = controller?.snapshot().collapsed ?? collapsed;
    if (execute && !readOnly && !conversation) items.push({ id: 'card-execute', label: '提交任务', enabled: !executeButton.disabled });
    if (drawingButton && !readOnly) items.push({ id: 'card-drawing', label: '编辑涂鸦' });
    if (!conversation && !readOnly) items.push({ id: 'card-edit', label: '编辑备注', enabled: !editing });
    items.push({ id: 'card-source', label: source.open ? '收起来源' : '查看来源', enabled: !isCollapsed });
    items.push({ id: 'card-collapse', label: isCollapsed ? `展开${conversation ? '对话' : '备注'}` : `折叠${conversation ? '对话' : '备注'}` });
    if (remove && !readOnly) items.push({ separator: true }, { id: 'card-remove', label: conversation ? '移除标签，保留对话历史…' : '删除备注…' });
    return items;
  };
  const runCardMenu = command => {
    if (command === 'card-collapse') return controller ? controller.collapse(!controller.snapshot().collapsed).catch(error=>setDelivery(error.message)) : toggle();
    if (command === 'card-source') return toggleSource();
    // Removal clicks the retained button so the shared destructive-action
    // confirmation (#action-confirmation) intercepts and validates it.
    if (command === 'card-remove') return removeButton.click();
    if (command === 'card-execute') return executeButton.click();
    if (command === 'card-drawing') return drawingButton.click();
    if (command === 'card-edit') return openEdit();
  };
  more.addEventListener('click', event => {
    event.stopPropagation();
    more.setAttribute('aria-expanded', 'true');
    tagCardMenu(document).open(cardMenuItems(), { ...panelMenuPosition(more), focus: more, run: runCardMenu });
  });
  head.addEventListener('click', () => focusCard());
  close.addEventListener('click', event => { event.stopPropagation(); toggle(); });
  index.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); focusCard(); setOpen(true); });
  const isPoint = () => Boolean(material.point || anchor.point);
  const title = document.createElement('span'); title.className = 'tag-window-title';
  const renderTitle = () => { title.textContent = anchorKind==='file'?'文件讨论':!conversation ? (isPoint() ? '位置备注' : '本地备注') : isPoint() ? '位置讨论' : '选区对话'; };
  renderTitle();
  if (anchorKind) root.dataset.anchorKind = anchorKind;
  const transcript = document.createElement('span'); transcript.className = 'tag-transcript'; transcript.setAttribute('role', 'log'); transcript.setAttribute('aria-label', '此标签的完整对话');
  const renderThread = mountThreadTranscript(transcript);
  const renderConversation = () => renderThread(threadRounds({ text, replyText, replyEntries, replyAvailability, readReply, status, history }));
  if (conversation) {
    renderConversation();
    editor.value = draftValue || '';
    editor.placeholder = pending ? '继续记下问题，收到回复后发送…' : '关于这处材料，聊一聊…';
    editor.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !event.repeat && !submit.disabled) { event.preventDefault(); submit.click(); } });
    setIconButton(close, 'minus');
  }
  const noteBody = document.createElement('span'); noteBody.className = 'tag-markdown tag-note-body';
  if (!conversation) { renderTagMarkdown(noteBody, initialDraft || '（无文字）'); transcript.append(noteBody); editor.placeholder = '用 Markdown 记录你的理解…'; }
  head.append(cardNumber, title, content, sourceChange, more);
  if (inline) head.append(close);
  card.append(head, source, transcript, composerRow, delivery, executeStatusLine, menuActions);
  if (inline) {
    if (conversation) { removeButton.classList.remove('ui-icon-button'); removeButton.textContent = '移除标签（保留历史）'; }
    const view = document.createElement('button'); view.type = 'button'; view.className = 'tag-view'; view.textContent = '查看原文与备注';
    view.addEventListener('click', () => { setOpen(true); if (!source.open) toggleSource(); });
    menuActions.append(view);
    executeButton.hidden = readOnly || !execute;
    if (drawingButton) drawingButton.hidden = readOnly;
  }
  if (!conversation) {
    composer = mountAnnotationComposer({ root: card, input: editor });
    // Keep the note composer's 输入/预览 tabs and preview body outside the
    // single-row composer so the row stays textarea + send.
    const tabs = composerRow.querySelector(':scope > .composer-tabs');
    const previewBody = composerRow.querySelector(':scope > .composer-preview');
    if (tabs) composerRow.before(tabs);
    if (previewBody) composerRow.after(previewBody);
  }
  root.append(index, card);
  setOpen(open, false);
  const mounting = Promise.resolve().then(async () => {
    if (layoutDisposed || !sourceMarker(sessionKey,root).isConnected) return;
    renderThread.attachOriginalReaders?.();
    if (inline) { watchTagRemoval(root, disposeLayout); autoGrow(); return; }
    const pageAnchored=Boolean(root.closest('.word-note-overlay')&&anchor?.space?.startsWith('docx-'));
    const initial = {...defaultLocalWindowView(),hidden:!open,...(pageAnchored?{schema:2,placement:{mode:'auto',space:'source-page'}}:{})};
    const offset = oldView?.noteOffset, marker = index.getBoundingClientRect();
    const pane = root.closest('.cm-scroller, #markdown-preview-scroll, .reader-scroll, .monaco-editor');
    const paneRect = pane?.getBoundingClientRect();
    // A one-shot legacy measurement, never a second positioning listener. Hidden,
    // clipped Office overlays and missing sources retain their original migration record.
    const measurable = open && paneRect?.width > 0 && paneRect.height > 0 && !root.closest('[data-tag-layout="viewport"],.word-note-overlay') && marker.width > 0 && marker.bottom > paneRect.top && marker.top < paneRect.bottom;
    if (Array.isArray(offset) && offset.length === 2 && offset.every(Number.isFinite) && measurable) {
      let left=Math.max(0,paneRect.left+pane.clientLeft),top=Math.max(0,paneRect.top+pane.clientTop),right=Math.min(document.documentElement.clientWidth,paneRect.left+pane.clientLeft+pane.clientWidth),bottom=Math.min(document.documentElement.clientHeight,paneRect.top+pane.clientTop+pane.clientHeight);
      const gutter=pane.querySelector(':scope > .cm-gutters')?.getBoundingClientRect();if(gutter&&gutter.left<=left)left=Math.max(left,gutter.right);
      for(let ancestor=pane.parentElement;ancestor;ancestor=ancestor.parentElement){if(/(auto|scroll|hidden|clip)/.test(getComputedStyle(ancestor).overflowY)){const box=ancestor.getBoundingClientRect();top=Math.max(top,box.top+ancestor.clientTop);bottom=Math.min(bottom,box.top+ancestor.clientTop+ancestor.clientHeight);}}
      left+=8;right-=8;top+=8;bottom-=8;
      if(right>left&&bottom>top){
        Object.assign(card.style,{position:'relative',left:'0px',top:'0px',width:'420px',height:'430px',maxWidth:`${right-left}px`,maxHeight:`${bottom-top}px`,transform:`translate(${offset[0]}px,${offset[1]}px)`});
        const oldRect=card.getBoundingClientRect();
        if(oldRect.width>0&&oldRect.height>0)initial.placement={mode:'manual',x:Math.max(left,Math.min(oldRect.x+18,right-oldRect.width)),y:Math.max(top,Math.min(oldRect.y+8,bottom-oldRect.height))};
        card.removeAttribute('style');
      }
    }
    card.hidden=true;
    const store = createLocalWindowView({invoke:(...args)=>window.nozeli.invoke(...args),key,initial,legacy:oldView});
    const parent = sourceMarker(sessionKey,root).closest('#documents') || document.body;
    const layer = ensureLocalWindowLayer(parent);
    const environment = pageAnchored ? sourcePageWindowEnvironment(layer,()=>sourceMarker(sessionKey,root).sourcePageGeometry,{epoch:()=>scope.generation || 0}) : viewportWindowEnvironment(layer, {epoch:()=>scope.generation || 0,defaultRect:()=>{
      const marker = sourceMarker(sessionKey,root).querySelector('.note-index').getBoundingClientRect();
      const visible = marker.width > 0 && marker.bottom > 0 && marker.top < document.documentElement.clientHeight;
      return {x:visible ? marker.right+8 : 24,y:visible ? marker.top : 24,width:380,height:380};
    }});
    let state = initial, loadError = null;
    try { state = await store.load(); } catch (error) { loadError = error; setDelivery(error.message); }
    if (layoutDisposed) return;
    if (requestedOpen) state = {...state,hidden:false,collapsed:false};
    setOpen(!state.collapsed, false);
    card.hidden=false;
    controller = mountLocalWindow({layer,key,title:head,body:card,state,environment,commitView:store.commitView,beforeHide:async()=>{if(readOnly||!conversation&&!editing)return;const result=await onDraft?.(id,draftValue);if(result?.ok===false)throw Error(result.error?.message || '草稿尚未保存，窗口保留。');},onError:error=>setDelivery(error.message)});
    controller.node.dataset.annotation = id;
    controller.node.classList.add(`tag-${kind}`);
    card.localWindow = controller;
    controller.node.classList.add('tag-chat-window');
    if (loadError) controller.update({error:loadError});
    tagWindows.add(controller);
    root.localWindow = controller;
    autoGrow();
  });
  tagMounts.add(mounting);
  mounting.finally(()=>tagMounts.delete(mounting)).catch(error=>setDelivery(error.message));
  root.updateAnchor = value => {
    anchor = value || {};
    renderSource();
  };
  root.updateConversation = value => {
    if (!conversation || value.kind === 'note') return false;
    ({ text, replyText = '', replyAvailability, readReply, replyEntries = [], status = '', history = [] } = value);
    if (value.material) { material = value.material; renderTitle(); }
    if (value.anchorKind) { anchorKind = value.anchorKind; root.dataset.anchorKind = anchorKind; }
    if(value.resolution!==undefined)resolution=value.resolution;
    if(value.anchorDrift!==undefined)anchorDrift=value.anchorDrift;
    renderAdvisory();
    pending = status === 'pending' || status === 'accepted-awaiting-reply';
    submit.disabled = readOnly || pending;
    setDelivery(pending ? '等待前台回复…' : status === 'failed' ? '回复失败 · 原问题已保留' : '');
    content.textContent = tagMarkdownSummary(displayText());
    editor.placeholder = pending ? '继续记下问题，收到回复后发送…' : '关于这处材料，聊一聊…';
    renderConversation(); root.updateAnchor(value.anchor); return true;
  };
  root.relayout = fitConversation;
  root.setOrdinal = value => {
    ordinal = value;
    index.textContent = String(value); cardNumber.textContent = String(value);
    index.setAttribute('aria-label', `打开${conversation ? '对话' : '备注'} ${value}`);
    cardNumber.setAttribute('aria-label', `查看${conversation ? '对话' : '备注'} ${value} 的来源`);
    close.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'}${conversation ? '对话' : '备注'} ${value}`);
    close.title = close.getAttribute('aria-label');
    removeButton.setAttribute('aria-label', conversation ? `移除对话标签 ${value}，保留对话历史` : `删除备注 ${value}`);
  };
  root.fitConversation = fitConversation;
  root.updateExecuteStatus = value => { executeStatusLine.textContent=value||'';executeStatusLine.hidden=!executeStatusLine.textContent;executeButton.disabled=readOnly||executing; };
  root.updateReadOnly = value => { readOnly=Boolean(value);editor.readOnly=readOnly;submit.disabled=readOnly||pending;executeButton.disabled=readOnly||executing;removeButton.disabled=readOnly;editButton.disabled=readOnly;if(drawingButton)drawingButton.disabled=readOnly; };
  root.updateReadOnly(readOnly);
  root.acceptNoteProjection = value => { if(conversation||editing||status&&typeof status==='object')return false;draftValue=value.note||'';editor.value=draftValue;content.textContent=tagMarkdownSummary(draftValue||'（无文字）');renderTagMarkdown(noteBody,draftValue||'（无文字）');anchor=value.anchor||anchor;renderSource();return true; };
  executeStatusLine.textContent = executeStatus || '';
  if (((kind === 'discuss' && status === 'draft') || (kind === 'note' && typeof status === 'object')) && autoEdit(id)) openEdit();
  if (!inline) tagSessions.set(sessionKey,{id,root,marker:root,markers:new Set([root]),dispose:disposeLayout});
  return root;
}

export function makeNoteTag(note, actions = {}) {
  const save = async (_, text) => {
    const saved = await actions.update?.(note, text);
    // An unchanged-text save can retain this projection while advancing the host
    // revision. Subsequent drafts/saves must use that confirmed record, not the
    // original closure snapshot; failed saves retain their conflict baseline.
    if (saved) note = saved;
    return saved;
  };
  const tag = makeAnchorTag({ id: note.id, ordinal: note.ordinal, kind: 'note', relPath: note.relPath, displayLocation: note.displayLocation,information:note.information,resolution:note.resolution, anchorKind: note.anchor?.anchorKind || note.anchorKind || note.kind || '', text: note.note, status: actions.draft?.(note.id) ?? '', open: actions.open?.(note.id) ?? true, anchor: note.anchor || {}, material: { imageDataUrl: note.anchor?.imageDataUrl || '', point: Boolean(note.anchor?.point), pointLabel: note.anchor?.pointLabel || '', pointContext: note.anchor?.pointContext || null }, executeStatus: note.execute?.jobId ? (note.execute.status || '已提交 · 见工作与待办') : '' }, { ...actions, onDraft: (id, text) => actions.onDraft?.(id, text, note), save, execute: (id, text) => actions.execute?.(note, text) });
  if(tag.refreshNote)tag.refreshNote(note);else tag.refreshNote=value=>{if(tag.acceptNoteProjection(value))note=value;};
  return tag;
}
