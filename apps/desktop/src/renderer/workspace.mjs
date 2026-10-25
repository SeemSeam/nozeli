import {setIconButton} from './ui-icons.mjs';
import { mountConversationFont } from './conversation-font.mjs';
import { mountPanelSplitters } from './panel-splitters.mjs';
import { mountConversationControls } from './workspace-conversation-controls.mjs';
import { mountDocumentHeader } from './document-header.mjs';
import { mountActionConfirmation } from './action-confirmation.mjs';

const $ = id => document.getElementById(id);
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
const defaults = () => ({ filesCollapsed: false, sideCollapsed: true, drawerFilesOpen:false, drawerSideOpen:false, chatCompact:false, chatLayoutExplicit:false, fontSize: 14, conversationFontSize:14, readingWidth:72, split: 50, draft: '', noteOffsets: {}, noteDrafts: [], retainedNoteDrafts: [], confirmationSkips: {} });

// The same composer node survives every layout change. All persisted state is project-scoped.
export function mountWorkspace({ save, saveProjectSettings, openProject, addNote, send }) {
  mountDocumentHeader();
  const ownsConversation=window.__workspaceScope?.role==='surface'&&window.__workspaceScope.kind==='conversation';
  let state = defaults(), toastTimer, chatSizes = new Map();
  let conversationInitialized=false,messageCount=0;
  const historyToggle=document.createElement('button');historyToggle.id='chat-history-toggle';historyToggle.type='button';historyToggle.textContent='⌃';
  const chatStatus=document.createElement('span');chatStatus.id='chat-compact-status';chatStatus.textContent='本地草稿';chatStatus.title='草稿仅保存在当前项目';
  $('conversation-head').insertBefore(chatStatus,$('conversation-head').querySelector('.conversation-controls'));
  $('conversation-head').querySelector('.conversation-controls').prepend(historyToggle);
  const compact=()=>state.chatCompact;
  historyToggle.addEventListener('click',()=>{state.chatCompact=!state.chatCompact;state.chatLayoutExplicit=true;changed();});
  const confirmation = mountActionConfirmation({
    scope: () => state,
    preferences: () => state.confirmationSkips,
    async setPreferences(value) {
      const current = state, previous = current.confirmationSkips;
      current.confirmationSkips = value;
      try {
        const projectId=window.__workspaceScope?.projectId;
        const result=await window.nozeli.invoke('workspace.settings',{projectId,workspace:{confirmationSkips:value}});
        if (result?.ok === false) current.confirmationSkips = previous;
        return result;
      } catch (error) { current.confirmationSkips = previous; throw error; }
    },
    toast,
  });
  document.addEventListener('nozeli-restore-confirmations',event=>{event.detail.result=confirmation.restore();});
  const controls = mountConversationControls({close: () => conversationFont.close()});
  const conversationFont = mountConversationFont({
    getSize: () => state.conversationFontSize,
    scope: () => state,
    setSize(value) { state.conversationFontSize = value; changed(); },
    views: () => controls.commands(state),
    runView: command => controls.run(command),
    toast,
  });
  function fitComposer() {
    const composer = $('composer');
    if (!composer) return;
    const panelLimit = Math.min(180, Math.max(108, innerHeight * 0.24));
    composer.style.height = '0px';
    const contentHeight = composer.value ? composer.scrollHeight : 0;
    const height = clamp(contentHeight, compact()?28:42, panelLimit);
    composer.style.height = height + 'px';
    composer.style.overflowY = contentHeight > panelLimit ? 'auto' : 'hidden';
  }
  function render() {
    confirmation.refresh();
    $('app').classList.toggle('files-collapsed', state.filesCollapsed);
    $('app').classList.toggle('side-collapsed', state.sideCollapsed);
    const narrow=innerWidth<=1000;
    $('app').classList.toggle('narrow-layout',narrow);
    $('app').classList.toggle('drawer-files-open',narrow && state.drawerFilesOpen);
    $('app').classList.toggle('drawer-side-open',narrow && state.drawerSideOpen);
    $('file-toggle').setAttribute('aria-expanded', String(!state.filesCollapsed));
    $('toggle-sidebar').setAttribute('aria-expanded', String(!state.sideCollapsed));
    $('file-toggle').setAttribute('aria-label', state.filesCollapsed ? '展开项目文件' : '收起项目文件');
    $('file-toggle').title = state.filesCollapsed ? '展开项目文件' : '收起项目文件';
    $('toggle-sidebar').setAttribute('aria-label', state.sideCollapsed ? '展开工作与待办' : '收起工作与待办');
    $('toggle-sidebar').title = state.sideCollapsed ? '展开工作与待办' : '收起工作与待办';
    if(narrow){
      $('file-toggle').setAttribute('aria-expanded',String(state.drawerFilesOpen));
      $('toggle-sidebar').setAttribute('aria-expanded',String(state.drawerSideOpen));
      $('file-toggle').title=state.drawerFilesOpen?'收起项目文件':'展开项目文件';
      $('toggle-sidebar').title=state.drawerSideOpen?'收起工作与待办':'展开工作与待办';
      $('file-toggle').setAttribute('aria-label',$('file-toggle').title);$('toggle-sidebar').setAttribute('aria-label',$('toggle-sidebar').title);
    }
    const badgeCount=Number($('toggle-sidebar').dataset.badgeCount||0);
    if(badgeCount)$('toggle-sidebar').setAttribute('aria-label',$('toggle-sidebar').getAttribute('aria-label')+'，'+badgeCount+' 项未处理');
    const conversationSurface = window.__workspaceScope?.role === 'surface' && window.__workspaceScope.kind === 'conversation';
    $('conversation-panel').hidden = !conversationSurface;
    const panel = $('conversation-panel');
    panel.classList.toggle('compact-composer',compact());
    historyToggle.hidden = !conversationSurface;
    setIconButton(historyToggle,state.chatCompact?'chevron-up':'chevron-down');
    historyToggle.title=(state.chatCompact?'展开完整对话':'收为紧凑输入')+(messageCount?' · '+messageCount+' 条消息':'');
    historyToggle.setAttribute('aria-label',historyToggle.title);historyToggle.setAttribute('aria-expanded',String(!state.chatCompact));
    $('app').style.setProperty('--reader-font', state.fontSize + 'px');
    document.documentElement.style.setProperty('--conversation-font', state.conversationFontSize + 'px');
    conversationFont.render();
    $('app').style.setProperty('--reading-width',state.readingWidth+'ch');
    const fontLabel = $('font-size-label');
    if (fontLabel) {
      fontLabel.textContent = state.fontSize + 'px';
      fontLabel.title = `正文大小 ${state.fontSize}px`;
      fontLabel.setAttribute('aria-label', `当前正文大小 ${state.fontSize}px`);
    }
    $('documents').style.setProperty('--split', state.split + '%');
    controls.render(state);
    queueMicrotask(() => {
      fitComposer();
      window.dispatchEvent(new Event('nozeli-layout-change'));
    });
  }
  function changed() { render(); save(); }
  function markDraftSaved() {
    const status = $('compose-status');
    if (status.dataset.draftSaving !== 'true') return;
    delete status.dataset.draftSaving;
    status.textContent = $('composer').value ? '本地草稿已保存 · 未发送' : '未发送';
  }
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
  $('file-toggle').addEventListener('click', () => {if(innerWidth<=1000)state.drawerFilesOpen=!state.drawerFilesOpen;else state.filesCollapsed = !state.filesCollapsed; changed(); });
  document.addEventListener('nozeli-reveal-work-sidebar',()=>{if(innerWidth<=1000)state.drawerSideOpen=true;else state.sideCollapsed=false;changed();});
  $('toggle-sidebar').addEventListener('click', () => {if(innerWidth<=1000)state.drawerSideOpen=!state.drawerSideOpen;else state.sideCollapsed = !state.sideCollapsed; changed(); });
  if(ownsConversation){
    $('composer').addEventListener('input', () => { fitComposer(); state.draft = $('composer').value; $('compose-status').dataset.draftSaving = 'true'; $('compose-status').textContent = '正在保存本地草稿…'; save(); });
    $('compose-form').addEventListener('submit', event => { event.preventDefault(); if (send) send(); else toast('AI 尚未接通，草稿保留在本机，未发送。'); });
  }
  for (const id of ['open-folder', 'welcome-open']) $(id).addEventListener('click', openProject);
  for (const [id, delta] of [['font-smaller', -1], ['font-larger', 1]]) $(id).addEventListener('click', () => { state.fontSize = clamp(state.fontSize + delta, 11, 24); changed(); });
  $('font-reset').addEventListener('click',()=>{state.fontSize=14;changed();});
  for(const button of document.querySelectorAll('[data-reader-font]'))button.addEventListener('click',()=>{state.fontSize=Number(button.dataset.readerFont);changed();});
  for(const button of document.querySelectorAll('[data-reading-width]'))button.addEventListener('click',()=>{state.readingWidth=Number(button.dataset.readingWidth);changed();});
  function applyFocusMode(enabled) {
    $('app').classList.toggle('focus-mode', enabled);
    $('toggle-focus').setAttribute('aria-pressed', String(enabled));
    $('toggle-focus').setAttribute('aria-label', enabled ? '退出 Zen 专注模式' : '进入 Zen 专注模式');
    $('toggle-focus').title = enabled ? '退出 Zen (Esc)' : 'Zen 专注模式 (Ctrl/Cmd+Shift+F11)';
    $('focus-exit').hidden = !enabled;
    document.dispatchEvent(new CustomEvent('zen:change', { detail: { enabled } }));
  }
  function focusMode(enabled, persist = true) {
    projectSettings.focusMode = Boolean(enabled);
    applyFocusMode(projectSettings.focusMode);
    render();
    if (persist && saveProjectSettings && !$('provider-console-toggle').hidden) void saveProjectSettings({ ...projectSettings });
  }
  const modalOpen = () => [...document.querySelectorAll('dialog[open], [role="dialog"]:not([hidden]), [aria-modal="true"]:not([hidden]), [popover]:popover-open, .nozeli-context-menu:not([hidden])')].some(node => node.getClientRects().length > 0);
  const modalEscapes = new WeakSet();
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modalOpen()) modalEscapes.add(event);
  }, true);
  let focusTransition = false;
  async function toggleFocus(enabled = !$('app').classList.contains('focus-mode')) {
    if ((focusTransition && enabled) || modalOpen()) return;
    focusTransition = true;
    if (enabled) window.__setProjectView?.('reading');
    focusMode(enabled);
    try {
      if (enabled && !document.fullscreenElement) {
        await $('app').requestFullscreen();
        // Electron/compositors may resolve fullscreen after the user already exited Zen.
        if (!$('app').classList.contains('focus-mode') && document.fullscreenElement) await document.exitFullscreen();
      }
      else if (!enabled && document.fullscreenElement) await document.exitFullscreen();
    } catch { /* Window-filling remains useful when fullscreen is denied. */ }
    finally { focusTransition = false; }
  }
  window.nozeli.subscribe('menu.action', action => { if(action === 'focus') void toggleFocus(); if(action === 'open-project') openProject(); });
  document.addEventListener('keydown', event => {
    if(event.key === 'F11' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!event.repeat) void toggleFocus();
    }
  });
  window.addEventListener('project-view-change', event => { state.projectView=event.detail; save(); });
  $('toggle-focus').addEventListener('click', () => { void toggleFocus(); });
  $('focus-exit').addEventListener('click', () => { void toggleFocus(false); });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && projectSettings.focusMode && !focusTransition && !modalOpen()) focusMode(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || modalEscapes.has(event) || modalOpen()) return;
    // Leave native dialogs and popovers first; only an unclaimed Escape exits Zen.
    if (!$('selection-menu').hidden) { $('selection-menu').hidden = true; return; }
    if ($('app').classList.contains('focus-mode')) { event.preventDefault(); void toggleFocus(false); }
  });
  $('show-note').addEventListener('click', addNote);
  $('selection-note').addEventListener('click', () => { $('selection-menu').hidden = true; addNote({ anchored: true }); });
  $('cancel-note').addEventListener('click', () => { const form = $('note-form'); form.hidden = true; form.classList.remove('anchored'); form.style.removeProperty('left'); form.style.removeProperty('top'); });
  function drag(node, update) {
    node.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button,summary,details')) return;
      const initial = { ...state, px: event.clientX, py: event.clientY };
      event.preventDefault(); node.setPointerCapture(event.pointerId);
      const move = e => { update(e.clientX - initial.px, e.clientY - initial.py, initial); render(); };
      const end = () => { node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', end); node.removeEventListener('pointercancel', end); save(); };
      node.addEventListener('pointermove', move); node.addEventListener('pointerup', end); node.addEventListener('pointercancel', end);
    });
  }
  drag($('pane-divider'), (dx, dy, initial) => { state.split = clamp(initial.split + dx / $('documents').clientWidth * 100, 25, 75); });
  $('pane-divider').addEventListener('keydown', event => { if (['ArrowLeft','ArrowRight','Home'].includes(event.key)) { event.preventDefault(); state.split = event.key === 'Home' ? 50 : clamp(state.split + (event.key === 'ArrowLeft' ? -5 : 5), 25, 75); changed(); } });
  $('pane-divider').addEventListener('dblclick', () => { state.split=50; changed(); });
  mountPanelSplitters({ state:()=>state, render, save });
  window.addEventListener('resize', () => { render(); fitComposer(); });
  document.addEventListener('pointerdown',event=>{
    if(innerWidth>1000)return;
    let touched=false;
    if(state.drawerFilesOpen && !event.target.closest('#files,#file-tree-dialog,#file-label-dialog,#file-tree-menu')){state.drawerFilesOpen=false;touched=true;}
    if(state.drawerSideOpen && !event.target.closest('#side')){state.drawerSideOpen=false;touched=true;}
    if(touched)changed();
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape' && innerWidth<=1000 && (state.drawerFilesOpen || state.drawerSideOpen)){state.drawerFilesOpen=false;state.drawerSideOpen=false;changed();}});
  render();
  function noteKey(draft) { return [draft.projectId, draft.annotationId || '', draft.relPath, draft.materialDigest, JSON.stringify(draft.anchor ?? null)].join('\0'); }
  render();
  let projectSettings = { focusMode: false };
  // Overflow edits never enter the bounded durable snapshot or evict another draft.
  const overflowEdits = new Map();
  const editKey = (projectId, id) => `${projectId}:${id}`;
  return { toast,
    inheritSettings(value={}) { for(const key of ['fontSize','conversationFontSize','readingWidth'])if(Number.isFinite(value[key]))state[key]=value[key];if(Object.hasOwn(value,'confirmationSkips')){state.confirmationSkips={...value.confirmationSkips};confirmation.refresh();}render(); },
    editDraft(projectId, annotationId) { return overflowEdits.get(editKey(projectId, annotationId)) || (state.noteDrafts || []).find(item => item.annotationId === annotationId && item.projectId === projectId) || null; },
    hasOverflowEdits(projectId) { return [...overflowEdits.values()].some(item => item.projectId === projectId); },
    rememberEdit(draft) {
      const key = editKey(draft.projectId, draft.annotationId);
      const drafts = state.noteDrafts || [];
      const index = drafts.findIndex(item => item.annotationId === draft.annotationId && item.projectId === draft.projectId);
      if (index < 0 && drafts.length >= 40) { overflowEdits.set(key, draft); return false; }
      overflowEdits.delete(key);
      state.noteDrafts = index < 0 ? [...drafts, draft] : drafts.map((item, at) => at === index ? draft : item);
      return true;
    },
    clearEdit(draft) {
      const key = editKey(draft.projectId, draft.annotationId);
      if (overflowEdits.get(key) === draft) overflowEdits.delete(key);
      state.noteDrafts = (state.noteDrafts || []).filter(item => item !== draft);
    },
    conversationContent(info) {
    if(info?.state){chatStatus.textContent=info.state==='ready'?'前台已连接':info.state==='failed'?'连接失败':'未接入 Agent · 本地草稿';chatStatus.title=info.label||chatStatus.textContent;}
    if(Number.isInteger(info?.count)){
      messageCount=info.count;
      if(!conversationInitialized){conversationInitialized=true;if(messageCount && !state.chatLayoutExplicit && state.chatCompact){state.chatCompact=false;render();}}
      historyToggle.title=(state.chatCompact?'展开完整对话':'收为紧凑输入')+(messageCount?' · '+messageCount+' 条消息':'');historyToggle.setAttribute('aria-label',historyToggle.title);
    }
  }, revealContent() { controls.close(); }, offset: id => state.noteOffsets[id] || [0,0], moveNote(id, delta) { state.noteOffsets = {...state.noteOffsets, [id]: delta}; save(); }, chatSize: id => chatSizes.get(id) || null, resizeChat(id, size) { if (!id || !size) return; chatSizes.set(id, { width: Math.round(size.width), height: Math.round(size.height) }); }, remapFiles(from, to) { state.noteDrafts = (state.noteDrafts || []).map(d => d.relPath === from || d.relPath.startsWith(from + '/') ? { ...d, relPath: to + d.relPath.slice(from.length) } : d); }, snapshot: () => ({ ...state, draft: $('composer').value, noteDrafts: state.noteDrafts || [], retainedNoteDrafts: state.retainedNoteDrafts || [] }),
    restore(value, settings) {
      conversationFont.close(); conversationInitialized=false; messageCount=0;
      const initial = defaults();
      // Native workspace layout owns geometry; restore only content and sidebar preferences.
      for (const key of [...Object.keys(initial), 'projectView', 'filesWidth', 'sideWidth', 'workRatio', 'terminalRatio']) {
        if (value && Object.hasOwn(value, key)) initial[key] = value[key];
      }
      state = initial;
      state.noteDrafts = Array.isArray(value?.noteDrafts) ? value.noteDrafts : [];
      state.retainedNoteDrafts = Array.isArray(value?.retainedNoteDrafts) ? value.retainedNoteDrafts : [];
      state.conversationFontSize=Number.isFinite(state.conversationFontSize)?clamp(state.conversationFontSize,11,24):14;
      projectSettings = { focusMode: settings?.focusMode === true };
      if(ownsConversation)$('composer').value = state.draft || '';
      $('compose-status').textContent = state.draft ? '本地草稿 · 未发送' : '未发送';
      applyFocusMode(projectSettings.focusMode);
      window.__setProjectView?.(state.projectView || 'reading'); render();
    },
    saved() { markDraftSaved(); },
    rememberNote(draft) { if (!draft) return; const key = noteKey(draft); state.noteDrafts = (state.noteDrafts || []).filter(item => noteKey(item) !== key); if (draft.text || draft.drawing?.strokes?.length) state.noteDrafts.push({ ...draft, updatedAt: Date.now() }); },
    noteFor(projectId, relPath, materialDigest, anchor) { return (state.noteDrafts || []).filter(item => !item.annotationId && item.projectId === projectId && item.relPath === relPath && item.materialDigest === materialDigest && (item.text || item.drawing?.strokes?.length) && item.recovery !== 'pending' && (!anchor || JSON.stringify(item.anchor)===JSON.stringify(anchor))).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null; }
  }
}
