import {makeOriginalReplyReader} from './tag-original-reader.mjs';
import {setIconButton} from './ui-icons.mjs';
import { renderTagMarkdown, tagMarkdownSummary } from './tag-markdown.mjs';
import { mountAnnotationComposer, describeAnnotationSource } from './annotation-composer.mjs';
import { panelButton, observePanelWidth } from './panel-menu.mjs';
// Tags are persistent view projections with two display states: open and closed-summary.
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

export function makeAnchorTag({ id, ordinal, kind, text, replyText = '', replyAvailability, readReply, status = '', open = true, anchorDrift = false, history = [], draftText = '', anchor = {}, material = {}, relPath = '', displayLocation, information, executeStatus = '' }, { draw, filePath = () => '', sourceText = () => '', remove, save, execute = null, offset = () => [0, 0], move = () => {}, size = () => null, resize = () => {}, onDraft, onOpen, autoEdit = () => false } = {}) {
  const conversation = kind !== 'note';
  const pending = status === 'pending' || status === 'accepted-awaiting-reply';
  const root = document.createElement('span');
  root.className = `note-anchor tag-${kind}${status === 'followup' ? ' tag-followup' : ''}`;
  root.dataset.annotation = id;
  const index = document.createElement('button');
  index.type = 'button'; index.className = 'note-index';
  index.textContent = String(ordinal);
  index.setAttribute('aria-label', `打开${kind === 'note' ? '备注' : '对话'} ${ordinal}`);
  const card = document.createElement('span'); card.className = 'note-projection'; card.hidden = false;
  card.classList.add('tag-chat-window');
  const savedSize = size(id);
  if (savedSize) {
    card.style.width = `${savedSize.width}px`;
    card.style.height = `${savedSize.height}px`;
  }
  let delta = offset(id), collapsed = !open, paneObserver = null, cardObserver = null;
  let composer = null;
  let boundPane = null, layoutMounted = false, layoutDisposed = false, layoutFrame = null;
  const layoutTimers = [];
  card.classList.toggle('is-collapsed', collapsed);
  index.setAttribute('aria-expanded', String(open));
  const head = document.createElement('span'); head.className = 'note-projection-head'; head.tabIndex = 0;
  const disposeHeader = observePanelWidth(head);
  head.setAttribute('aria-label', '拖动或方向键移动，双击打开或关闭');
  const initialDraft = kind === 'note' && status && typeof status === 'object' ? status.value : conversation && status !== 'draft' ? draftText : text || '';
  const cardNumber = document.createElement('span'); cardNumber.className = 'tag-ordinal'; cardNumber.textContent = String(ordinal);
  const content = document.createElement('span'); content.className = 'note-projection-content';
  const sourceChange = document.createElement('span'); sourceChange.className = 'note-source-change'; sourceChange.textContent = anchorDrift ? '来源/位置已变化' : '';
  sourceChange.hidden = !anchorDrift;
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
  const position = () => { card.style.transform = `translate(${delta[0]}px,${delta[1]}px)`; fitConversation(); };
  const disposeLayout = () => {
    disposeHeader();
    layoutDisposed = true;
    composer?.dispose();
    paneObserver?.disconnect();
    cardObserver?.disconnect();
    boundPane?.removeEventListener('scroll', fitConversation);
    window.removeEventListener('resize', fitConversation);
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    layoutTimers.forEach(clearTimeout);
  };
  const fitConversation = () => {
    if (layoutDisposed || !root.isConnected) return;
    const paneNode = root.closest('.cm-scroller, #markdown-preview-scroll, .reader-scroll, .monaco-editor');
    const pane = paneNode?.getBoundingClientRect();
    if (!pane || pane.width < 1 || pane.height < 1) return;
    if (boundPane !== paneNode) {
      boundPane?.removeEventListener('scroll', fitConversation);
      paneObserver?.disconnect();
      boundPane = paneNode;
      boundPane.addEventListener('scroll', fitConversation, { passive: true });
      if (typeof ResizeObserver === 'function') {
        paneObserver = new ResizeObserver(fitConversation);
        paneObserver.observe(boundPane);
      }
    }
    if (!layoutMounted) {
      layoutMounted = true;
      window.addEventListener('resize', fitConversation);
      watchTagRemoval(root, disposeLayout);
    }
    const markdownPane=root.closest('#markdown-preview-scroll');
    if(markdownPane){const anchor=root.getBoundingClientRect();card.style.visibility=anchor.top<pane.top||anchor.top>pane.bottom?'hidden':'';}
    const overlay = root.closest('.word-note-overlay');
    const viewport = document.documentElement;
    const paneLeft = pane.left + paneNode.clientLeft, paneTop = pane.top + paneNode.clientTop;
    let left = Math.max(0, paneLeft), top = Math.max(0, paneTop);
    let right = Math.min(viewport.clientWidth, paneLeft + paneNode.clientWidth);
    let bottom = Math.min(viewport.clientHeight, paneTop + paneNode.clientHeight);
    if (overlay) {
      const box = overlay.getBoundingClientRect();
      left = Math.max(left, box.left); right = Math.min(right, box.right);
      top = Math.max(top, box.top + Number(overlay.dataset.clipTop || 0)); bottom = Math.min(bottom, box.bottom);
    }
    if (right <= left || bottom <= top) return;
    const insetX = Math.min(8, (right - left) / 2), insetY = Math.min(8, (bottom - top) / 2);
    left += insetX; right -= insetX; top += insetY; bottom -= insetY;
    card.style.minWidth = '0px';
    card.style.maxWidth = Math.max(0, right - left) + 'px';
    const anchorBox = root.getBoundingClientRect();
    const below = bottom - (anchorBox.top + delta[1] + 8);
    const limitBelow = (overlay || markdownPane || root.closest('.image-page')) && delta[0] === 0 && delta[1] === 0 && below >= 180;
    card.style.maxHeight = Math.max(0, Math.min(bottom - top, limitBelow ? below : Infinity)) + 'px';
    // Measure the translated natural origin, including the anchor's containing block.
    // The ordinal gutter is preferred, never a lower bound that defeats edge clamping.
    card.style.left = '0px'; card.style.top = '0px';
    const bounds = card.getBoundingClientRect();
    card.style.left = (Math.max(left, Math.min(bounds.left + 18, right - bounds.width)) - bounds.left) + 'px';
    card.style.top = (Math.max(top, Math.min(bounds.top + 8, bottom - bounds.height)) - bounds.top) + 'px';
  };
  const canFollowup = conversation && status !== 'draft';
  const setOpen = (next) => {
    open = Boolean(next);
    collapsed = !open;
    card.classList.toggle('is-collapsed', collapsed);
    content.hidden = false;
    if (collapsed) editing = false;
    editor.hidden = collapsed || !conversation && !editing;
    card.classList.toggle('editing-note', !conversation && editing && !collapsed);
    if (editor.hidden) composer?.hide(); else composer?.reset();
    controls.hidden = collapsed;
    submit.hidden = !conversation && !editing;
    editButton.hidden = conversation || editing;
    transcript.hidden = collapsed; source.hidden = collapsed;
    setIconButton(close,collapsed?'plus':'minus');
    close.setAttribute('aria-label', (collapsed ? '展开' : '折叠') + (conversation ? '对话 ' : '备注 ') + ordinal);
    close.title = close.getAttribute('aria-label');
    index.setAttribute('aria-expanded', String(open));
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitConversation);
    onOpen?.(id, open);
  };
  const toggle = () => setOpen(!open);
  const editor = document.createElement('textarea'); editor.className = 'tag-editor'; editor.hidden = true;
  editor.setAttribute('aria-label', kind === 'note' ? '编辑本地备注' : '继续讨论');
  let editing = false, draftValue = initialDraft;
  editor.addEventListener('input', () => {
    draftValue = editor.value;
    if (kind === 'note' || status === 'draft') content.textContent = tagMarkdownSummary(draftValue || (kind === 'note' ? '（无文字）' : '（未发送）'));
    if (!conversation) renderTagMarkdown(noteBody, draftValue || '（无文字）');
    onDraft?.(id, draftValue);
  });
  const focusEditor = () => { if (root.isConnected) editor.focus(); else queueMicrotask(() => { if (root.isConnected && editing) editor.focus(); }); };
  const edit = () => {
    setOpen(true);
    focusCard(); editing = true; card.classList.toggle('editing-note', !conversation); editor.value = draftValue; editor.hidden = false; composer?.reset(); controls.hidden = false; submit.hidden = false; editButton.hidden = true; focusEditor();
  };
  content.addEventListener('click', event => { event.stopPropagation(); focusCard(); });
  editor.addEventListener('focus', focusCard);
  editor.addEventListener('dblclick', event => event.stopPropagation());
  const executeButton = document.createElement('button'); executeButton.type = 'button'; executeButton.className = 'tag-execute'; executeButton.textContent = '执行';
  executeButton.title = '把这条材料作为修改要求交给后台执行；本地保存本身不派工';
  executeButton.setAttribute('aria-label', `执行 ${ordinal} 对应的修改要求`);
  const executeStatusLine = document.createElement('span'); executeStatusLine.className = 'tag-execute-status'; executeStatusLine.setAttribute('role', 'status');
  let executing = false;
  executeButton.addEventListener('click', async () => {
    if (executeButton.disabled || executing) return;
    if (!execute) { executeStatusLine.textContent = '当前会话不支持后台执行。'; return; }
    executing = true; executeButton.disabled = true;
    try {
      // An empty local-note edit is intentional, not a request to resend the old text.
      const effective = kind === 'note' ? draftValue : editor.value || draftValue;
      await execute(id, effective);
    }
    finally { executing = false; executeButton.disabled = false; }
  });

  const controls = document.createElement('span'); controls.className = 'tag-controls'; controls.hidden = true;
  const submit = document.createElement('button'); submit.type = 'button'; submit.textContent = kind === 'note' ? '保存备注' : (canFollowup ? '发送续问' : '发送讨论');
  submit.disabled = conversation && pending;
  submit.addEventListener('click', async () => {
    if (submit.disabled) return;
    submit.disabled = true;
    const submitted = editor.value;
    try {
      const accepted = await save?.(id, editor.value);
      if (!accepted) { delivery.textContent = '发送未被确认，输入已保留；请检查会话状态后手动发送。'; return; }
      if (editor.value === submitted) {
        if (conversation) {
          draftValue = '';
          editor.value = '';
          onDraft?.(id, '');
          editing = true;
          if (!collapsed) { editor.hidden = false; controls.hidden = false; }
        } else {
          draftValue = accepted.text;
          content.textContent = tagMarkdownSummary(accepted.text || '（无文字）');
          editor.hidden = true; composer?.hide(); card.classList.remove('editing-note'); content.hidden = false; controls.hidden = collapsed; editing = false; submit.hidden = true; editButton.hidden = false;
          renderTagMarkdown(noteBody, accepted.text || '（无文字）');
        }
      }
    } catch (error) { delivery.textContent = error?.message || '发送失败，输入已保留'; }
    finally { submit.disabled = conversation && pending; }
  });
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '关闭';
  cancel.addEventListener('click', () => { content.textContent = tagMarkdownSummary(draftValue || (kind === 'note' ? '（无文字）' : '（未发送）')); setOpen(false); });
  const removeButton = document.createElement('button'); removeButton.type = 'button';
  removeButton.className = conversation ? 'tag-remove' : 'tag-delete';
  if(conversation){setIconButton(removeButton,'close');removeButton.classList.add('ui-danger');}else removeButton.textContent='删除备注';
  removeButton.setAttribute('aria-label', conversation ? `移除对话标签 ${ordinal}，保留对话历史` : `删除备注 ${ordinal}`);
  removeButton.title = conversation ? '移除标签，保留对话历史' : '删除备注';
  removeButton.addEventListener('click', event => { event.stopPropagation(); remove?.(id); });
  const editButton = document.createElement('button'); editButton.type = 'button'; editButton.className = 'tag-edit'; editButton.textContent = '编辑备注';
  editButton.addEventListener('click', () => openEdit());
  controls.append(submit, cancel, executeButton);
  if (kind === 'note' && remove) controls.append(removeButton);
  controls.append(editButton);
  if(information?.drawing&&draw){const button=document.createElement('button');button.type='button';button.className='tag-drawing-edit';button.textContent='编辑涂鸦';button.onclick=()=>draw(id);controls.append(button);}
  const openEdit = () => { focusCard(); edit(); controls.hidden = !(conversation || editing); };
  head.addEventListener('click', () => focusCard());
  close.addEventListener('click', event => { event.stopPropagation(); toggle(); });
  let indexClickOpen;
  index.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation(); focusCard();
    if (event.detail === 1) indexClickOpen = open;
    const pane = root.closest('.cm-scroller, #markdown-preview-scroll, .reader-scroll, .monaco-editor')?.getBoundingClientRect();
    const current = pane ? card.getBoundingClientRect() : null;
    const outside = pane && (current.left < pane.left + 8 || current.right > pane.right - 8 || current.top < pane.top + 8 || current.bottom > pane.bottom - 8);
    setOpen(true);
    if (!pane || !outside) return;
    const box = card.getBoundingClientRect();
    const dx = box.left < pane.left + 8 ? pane.left + 8 - box.left : box.right > pane.right - 8 ? pane.right - 8 - box.right : 0;
    const dy = box.top < pane.top + 8 ? pane.top + 8 - box.top : box.bottom > pane.bottom - 8 ? pane.bottom - 8 - box.bottom : 0;
    if (dx || dy) { delta = [delta[0] + dx, delta[1] + dy]; position(); move(id, delta); }
  });
  index.addEventListener('dblclick', event => {
    event.preventDefault(); event.stopPropagation(); setOpen(!(indexClickOpen ?? open)); indexClickOpen = undefined;
  });
  head.addEventListener('dblclick', event => {
    if (dragged || event.target.closest?.('button,textarea,input')) return;
    event.preventDefault(); event.stopPropagation();
    focusCard();
    toggle();
  });
  head.addEventListener('keydown', event => {
    focusCard();
    if (event.target !== head) return;
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); toggle(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    delta = event.key === 'Home' ? [0, 0] : [delta[0] + (event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0), delta[1] + (event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0)];
    position(); move(id, delta);
  });
  let dragged = false;
  head.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button,textarea,input')) return;
    dragged = false;
    focusCard();
    event.stopPropagation();
    const scroller = root.closest('.cm-scroller, #markdown-preview-scroll, .reader-scroll, .monaco-editor');
    const start = [event.clientX, event.clientY, scroller?.scrollLeft || 0, scroller?.scrollTop || 0], original = [...delta];
    let dragging = false;
    const moving = e => {
      if (e.pointerId !== event.pointerId) return;
      if (!dragging && Math.hypot(e.clientX - start[0], e.clientY - start[1]) < 3) return;
      if (!dragging) { dragging = true; dragged = true; head.setPointerCapture(e.pointerId); }
      delta = [original[0] + e.clientX - start[0] + (scroller?.scrollLeft || 0) - start[2], original[1] + e.clientY - start[1] + (scroller?.scrollTop || 0) - start[3]];
      position();
    };
    const end = e => {
      if (e.pointerId !== event.pointerId) return;
      document.removeEventListener('pointermove', moving); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end);
      if (e.type === 'pointercancel') { delta = original; position(); }
      else if (dragging && (delta[0] !== original[0] || delta[1] !== original[1])) move(id, delta);
      if (dragging) setTimeout(() => { dragged = false; }, 0);
    };
    document.addEventListener('pointermove', moving); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  });
  const title = document.createElement('span'); title.className = 'tag-window-title'; title.textContent = conversation ? '选区对话' : '本地备注';
  const transcript = document.createElement('span'); transcript.className = 'tag-transcript'; transcript.setAttribute('role', 'log'); transcript.setAttribute('aria-label', '此标签的完整对话');
  const source = document.createElement('details'); source.className = 'tag-source';
  const sourceLabel = document.createElement('summary'); sourceLabel.textContent = describeAnnotationSource({ relPath: relPath || filePath(), anchor, text: sourceText(), displayLocation });
  const quote = document.createElement('blockquote'); quote.textContent = anchor.quote || material.excerpt || '已固定的选区'; source.append(sourceLabel, quote);
  if (material.imageDataUrl || anchor.imageDataUrl) { const image = document.createElement('img'); image.src = material.imageDataUrl || anchor.imageDataUrl; image.alt = '发送时固定的选区截图'; source.append(image); }
  if (conversation) {
    const entries = history.length ? history : (status === 'draft' ? [] : [{ question: text, reply: replyText, replyAvailability, readReply, status }]);
    const bubble = (role, value) => {
      const message = document.createElement('span'); message.className = 'tag-message tag-message-' + role;
      const label = document.createElement('strong'); label.textContent = role === 'user' ? '你' : '前台';
      const body = document.createElement('span'); body.className = 'tag-markdown'; renderTagMarkdown(body, value); message.append(label, body); transcript.append(message);
    };
    for (const entry of entries) {
      if (entry.question) bubble('user', entry.question);
      if (entry.reply) bubble('assistant', entry.reply);
      if (entry.replyAvailability === 'read-required' && entry.readReply) transcript.append(makeOriginalReplyReader(entry.readReply));
    }
    if (!entries.length) { const welcome = document.createElement('span'); welcome.className = 'tag-conversation-empty'; welcome.textContent = '围绕这处材料继续讨论。输入问题后发送，回复会留在这里。'; transcript.append(welcome); }
    editor.value = draftValue || ''; editor.placeholder = pending ? '继续记下问题，收到回复后发送…' : '关于这处材料，聊一聊…（Ctrl+Enter 发送）';
    editor.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !event.repeat && !submit.disabled) { event.preventDefault(); submit.click(); } });
    setIconButton(close,'minus');
  }
  const noteBody = document.createElement('span'); noteBody.className = 'tag-markdown tag-note-body';
  if (!conversation) { renderTagMarkdown(noteBody, initialDraft || '（无文字）'); transcript.append(noteBody); editor.placeholder = '用 Markdown 记录你的理解…'; }
  const delivery = document.createElement('span'); delivery.className = 'tag-delivery'; delivery.setAttribute('role', 'status');
  delivery.textContent = pending ? '等待前台回复…' : status === 'failed' ? '回复失败 · 可保留问题并重试' : conversation ? 'Ctrl / ⌘ + Enter 发送' : '本地保存 · 不发送给 AI';
  head.append(cardNumber, content, close, sourceChange); card.append(head, editor, controls);
  head.append(title); card.append(source, transcript); controls.append(executeStatusLine, delivery);
  if (conversation && remove) head.append(removeButton);
  const font = panelButton(null, '对话字号', true); font.dataset.chatFont = '';
  const more = panelButton(); more.dataset.chatMore = '';
  head.insertBefore(font, close); head.append(more);
  if (!conversation) composer = mountAnnotationComposer({root:card,input:editor});
  root.append(index, card); position();
  setOpen(open);
  queueMicrotask(() => {
    if (!root.isConnected || layoutDisposed) return;
    fitConversation();
    if (typeof requestAnimationFrame === 'function') layoutFrame = requestAnimationFrame(fitConversation);
    layoutTimers.push(setTimeout(fitConversation, 0), setTimeout(fitConversation, 80));
    if (typeof ResizeObserver === 'function') {
      let observedWidth = card.style.width, observedHeight = card.style.height;
      cardObserver = new ResizeObserver(() => {
        if (!root.isConnected) return;
        const changed = observedWidth !== card.style.width || observedHeight !== card.style.height;
        observedWidth = card.style.width; observedHeight = card.style.height;
        const bounds = card.getBoundingClientRect();
        if (changed && !card.classList.contains('is-collapsed') && bounds.width >= 250 && bounds.height >= 100) resize(id, bounds);
        fitConversation();
      });
      cardObserver.observe(card);
    }
  });
  root.updateAnchor = value => {
    anchor = value || {};
    sourceLabel.textContent = describeAnnotationSource({ relPath: relPath || filePath(), anchor, text: sourceText(), displayLocation });
    quote.textContent = anchor.quote || material.excerpt || '已固定的选区';
  };
  root.relayout = fitConversation;
  root.setOrdinal = value => {
    ordinal = value;
    index.textContent = String(value); cardNumber.textContent = String(value);
    index.setAttribute('aria-label', `打开${conversation ? '对话' : '备注'} ${value}`);
    close.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'}${conversation ? '对话' : '备注'} ${value}`);
    close.title = close.getAttribute('aria-label');
    removeButton.setAttribute('aria-label', conversation ? `移除对话标签 ${value}，保留对话历史` : `删除备注 ${value}`);
  };
  root.fitConversation = fitConversation;
  root.updateExecuteStatus = value => { executeStatusLine.textContent = value || ''; executeButton.disabled = Boolean(value && /执行中|已排队|转入后台/.test(value)); };
  executeStatusLine.textContent = executeStatus || '';
  if (((kind === 'discuss' && status === 'draft') || (kind === 'note' && typeof status === 'object')) && autoEdit(id)) openEdit();
  return root;
}

export function makeNoteTag(note, actions = {}) {
  return makeAnchorTag({ id: note.id, ordinal: note.ordinal, kind: 'note', relPath: note.relPath, displayLocation: note.displayLocation,information:note.information, text: note.note, status: actions.draft?.(note.id) ?? '', open: actions.open?.(note.id) ?? true, anchor: note.anchor || {}, material: { imageDataUrl: note.anchor?.imageDataUrl || '' }, executeStatus: note.execute?.jobId ? (note.execute.status || '已提交 · 见工作与待办') : '' }, { ...actions, onDraft: (id, text) => actions.onDraft?.(id, text, note), save: (_, text) => actions.update?.(note, text), execute: (id, text) => actions.execute?.(note, text) });
}
