import {mountConfiguration} from './configuration-setup.mjs';
import {setIconButton} from './ui-icons.mjs';
import {mountManagedAgent} from './managed-agent-panel.mjs';
import { mountPopupMenu } from './popup-menu.mjs';
import { renderTagMarkdown } from './tag-markdown.mjs';
import './conversation-rendering.css';
const $ = (id) => document.getElementById(id);


import {mountSettingsPanel} from './settings-panel.mjs';
export function mountAgent({ invoke, toast, attachment, getProjectId, openManaged, openProjectFile, openExternal, openFrozenChange, onMessages = () => {}, onConversation = () => {}, subscribe = window.nozeli.subscribe }) {
  const managed = mountManagedAgent({invoke,toast,onMessages,openManaged,onConversation,openProjectFile,openExternal,openFrozenChange});
  let projectId = null;
  let generation = 0;
  let consoleVisible = false;
  let restoredDraft = '';
  let filePaths = new Set();
  const legacyArchive = document.createElement('details');
  legacyArchive.id = 'legacy-conversation-history';
  legacyArchive.hidden = true;
  $('conversation').before(legacyArchive);
  async function loadLegacyHistory(id, gen) {
    const [messages, reports, listing] = await Promise.all([
      invoke('agents.messages', {projectId:id}),
      invoke('agents.reports', {projectId:id}),
      invoke('project.list', {projectId:id}),
    ]);
    if (id !== projectId || gen !== generation) return;
    if (listing.ok) filePaths = new Set(listing.value.entries.filter(entry => entry.kind !== 'dir').map(entry => entry.relPath));
    legacyArchive.replaceChildren();
    const summary = document.createElement('summary');
    summary.textContent = '旧版会话与报告（只读，不会重连或重放）';
    legacyArchive.append(summary);
    if (messages.ok) for (const message of messages.value.messages) {
      const article = document.createElement('article');
      article.dataset.legacyMessage = message.id;
      const label = document.createElement('strong'); label.textContent = message.role === 'user' ? '你' : '历史 Agent';
      const body = document.createElement('div');
      renderTagMarkdown(body,String(message.text ?? ''),{filePaths,onFile:target=>openProjectFile?.({projectId:id,...target}),onExternal:openExternal});
      article.append(label,body);legacyArchive.append(article);
    }
    if (reports.ok) for (const report of reports.value.reports) {
      const button = document.createElement('button');button.type='button';button.textContent=report.title;
      button.onclick=()=>openReport(report.id);legacyArchive.append(button);
    }
    legacyArchive.hidden = legacyArchive.childElementCount === 1;
  }


  function setAi(text, state) {
    const node = $('ai-status');
    node.dataset.state = state;
    node.textContent = text;
    onConversation({state,label:text});
  }



  function roleCard(role) {
    return document.querySelector('[data-provider-role="' + role + '"]');
  }

  function closeConsole() {
    consoleVisible = false;
    $('provider-console').hidden = true;
    document.body.classList.remove('provider-console-open');
    setReadingInert(false);
    $('provider-console-toggle').setAttribute('aria-pressed', 'false');
    setIconButton($('provider-console-toggle'),'terminal',{text:'终端',label:'切换到终端'});
  }

  function setReadingInert(value) {
    for (const node of document.querySelectorAll('#work-surface,#files,#side,#selection-menu')) node.inert = value;
    if (value) $('selection-menu').hidden = true;
  }

  async function refreshConsole() {
    return managed.console();
  }

  async function openReport(reportId) {
    const id = projectId;
    const gen = generation;
    const result = await invoke('agents.report.read', { projectId: id, reportId });
    if (!result.ok) { toast(result.error.message); return; }
    if (id !== projectId || gen !== generation) return;
    if (openManaged) { await openManaged({...result.value,history:true,title:result.value.title+' · 旧版只读报告'}); return; }
    const report = result.value;
    $('empty').hidden = true;
    $('text-host').hidden = true;
    $('pdf-host').hidden = true;
    $('pdf-toolbar').hidden = true;
    $('managed-doc').hidden = false;
    $('managed-doc').textContent = report.text;
    $('file-path').textContent = report.writtenBack === false ? '报告 · 未写回源文件' : report.writtenBack === true ? '报告 · 已检测到源文件变化' : '报告 · 写回未核验';
    $('subject-title').textContent = report.title;
    $('save-status').dataset.state = 'idle';
    $('save-status').textContent = report.writtenBack === false ? '未写回源文件' : report.writtenBack === true ? '源文件有变化' : '写回未核验';
  }

  const configuration = mountConfiguration({document, invoke, onError: error => setAi(error.message, 'failed'), onInitialized: async () => {
    if (projectId) await loadProjectSettings(projectId, generation);
  }});

  async function loadProjectSettings(id, gen) {
    try {
      const initialized = await configuration.ready;
      if (id !== projectId || gen !== generation) return;
      void loadLegacyHistory(id, gen).catch(error => {
        if (id === projectId && gen === generation) toast('旧版只读历史加载失败：' + error.message);
      });
      const connect = initialized || configuration.initialized;
      const loaded = await managed.load(id, {connect, draft: restoredDraft});
      if (id !== projectId || gen !== generation) return;
      if (!loaded && connect) await managed.enable(id);
      else if (!connect) setAi('请完成 Nozeli 配置初始化；仍可阅读项目和历史记录。', 'unavailable');
    } catch (error) {
      if (id === projectId && gen === generation) setAi(error.message, 'failed');
    }
  }
  const settingsPanel=mountSettingsPanel({invoke,getProjectId,onInitialize:async()=>{
    await configuration.ready;
    if(!configuration.initialized)return configuration.open();
    toast('Nozeli 独立配置已初始化，无需重复导入。');
  }});
  async function openConsole() {
    if (!projectId) return;
    window.dispatchEvent(new Event('nozeli-layout-change'));
    consoleVisible = true;
    $('provider-console').hidden = false;
    document.body.classList.add('provider-console-open');
    $('provider-console-toggle').setAttribute('aria-pressed', 'true');
    setIconButton($('provider-console-toggle'),'book-open',{text:'阅读',label:'切换到阅读'});
    setReadingInert(true);
    await refreshConsole();
  }
  window.__setProjectView = view => { if(view === 'terminal') void openConsole(); else closeConsole(); };
  function selectView(view) { window.__setProjectView(view); window.dispatchEvent(new CustomEvent('project-view-change',{detail:view})); }
  $('provider-console-toggle').addEventListener('click',()=>{if(!configuration.initialized)return configuration.open();selectView(consoleVisible?'reading':'terminal');});
  $('provider-console-close').addEventListener('click', () => {
    selectView('reading');
    $('open-settings').focus();
  });
  for (const role of ['qa','task']) {
    const head=roleCard(role).querySelector('header');
    const trigger=document.createElement('button');trigger.type='button';trigger.className='provider-role-action';trigger.id='terminal-menu-'+role;setIconButton(trigger,'ellipsis');trigger.title=role==='qa'?'前台 Agent 设置':'后台 Agent 设置';trigger.setAttribute('aria-label',trigger.title);head.append(trigger);
    const menu=document.createElement('div');menu.className='surface-menu';menu.id='terminal-actions-'+role;
    const reconnect=role==='qa'?$('provider-console-refresh'):document.createElement('button');reconnect.type='button';reconnect.textContent='刷新终端视图';reconnect.onclick=()=>refreshConsole();
    menu.append(reconnect);document.body.append(menu);mountPopupMenu(trigger,menu);
  }
  $('quit-stay').addEventListener('click', async () => {
    $('quit-choice').close();
    await invoke('session.quitChoice', { choice: 'stay' });
  });
  $('quit-cancel').addEventListener('click', async () => {
    const result = await invoke('session.quitChoice', { choice: 'cancel' });
    if (!result.ok) $('quit-error').textContent = result.error.message;
  });
  subscribe('quit.confirm', () => {
    $('quit-error').textContent = '';
    if (!$('quit-choice').open) $('quit-choice').showModal();
  });
  $('composer').addEventListener('input', () => { if(projectId)restoredDraft=$('composer').value; });
  window.__agentProject = (id, {draft = ''} = {}) => {
    void invoke('managed.project.active',{projectId:id||null}).then(result=>{if(!result?.ok)toast(result?.error?.message||'更新活跃项目失败');}).catch(error=>toast(error.message));
    managed.clear({rememberDraft:false});
    // The workspace supplies its restored draft explicitly; never infer it from the old composer.
    if (projectId !== id) {
      closeConsole();
      legacyArchive.replaceChildren();legacyArchive.hidden=true;
      for (const role of ['qa', 'task']) roleCard(role).querySelector('.provider-output').replaceChildren();
    }
    filePaths = new Set();
    projectId = id;
    settingsPanel.projectChanged();
    restoredDraft = draft;
    $('send-message').disabled = true;
    $('selection-discuss').disabled = false;
    $('selection-explain').disabled = true;
    $('selection-explain').title = '请先完成配置并连接前台 Agent';
    $('send-message').title = '前台尚未就绪';
    setAi(id ? '正在加载项目会话；草稿不会自动发送。' : '尚未打开项目。', id ? 'pending' : 'unavailable');
    $('provider-console-toggle').hidden = !id;
    $('provider-console-project').textContent = id ? `项目：${$('project-name').textContent || id}` : '尚未打开项目';
    generation += 1;
    const gen = generation;
    $('composer').value = draft;
    $('managed-doc').hidden = true;
    if (id) void loadProjectSettings(id, gen);
    if (! $('provider-console').hidden) void refreshConsole();
  };
  window.__agentSelectionAction = async ({ action, excerpt, relPath, materialText, annotationRef, comment = '', background = false }) => {
    const id = projectId;
    const gated = $('send-message').disabled;
    if (!id || gated || !managed.active) { const reason=!id?'尚未打开项目。':$('send-message').title||'Agent 尚未就绪或当前内容只读。';toast('发送未发出：'+reason);return false; }
    if (!excerpt?.trim() && !(action === 'task' && annotationRef)) return false;
    const prompt = annotationRef
      ? action==='explain'?'请解释这处选区。':action==='task'?`请修改这处材料：\n${comment}`:comment
      : action==='explain'?`请解释：\n${excerpt}`:`${comment}\n\n选区：\n${excerpt}`;
    const context = annotationRef ? { tags: [annotationRef], ...(background ? { background: true } : {}) } : { relPath, materialText, ...(background ? { background: true } : {}) };
    const result = await managed.send(prompt, context).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    if (!result.ok) { toast(result.error.message); return false; }
    return { ...result.value, requestId: result.value.requestId ?? result.value.jobId };
  };
  window.__agentSend = async ({background=false}={}) => {
    delete $('compose-status').dataset.draftSaving;
    const id = projectId;
    const materialsApi = window.__composerMaterials;
    const rawText = $('composer').value;
    const reject = reason => { $('compose-status').textContent='发送未发出：'+reason+'；草稿与材料仍保留';toast($('compose-status').textContent);return false; };
    if (!id) return reject('尚未打开项目');
    if (!managed.active) return reject('Agent 尚未启用或连接，请完成配置并重试连接');
    if ($('send-message').disabled) return reject($('send-message').title||'Agent 尚未就绪或当前内容只读');
    if (materialsApi?.blocked()) return reject('有材料未就绪（失败/读取中），请先移除或重新添加再发送');
    const snap = materialsApi?.snapshot();
    const text = snap?.text || rawText;
    if (!text.trim() && !(snap?.attachments?.length)) return;
    const externals = (snap?.attachments || []).filter(a => a.digest);
    if (externals.length) {
      toast('当前前台尚不支持本地材料附件；请引用项目文件与选区。');
      $('compose-status').textContent = '发送未发出：附件不受当前前台支持';
      return;
    }
    const relPath = $('attach-file').checked ? attachment() : (snap?.attachments || []).find(a => a.relPath && a.source !== 'selection')?.relPath || null;
    const materialText = relPath && typeof window.__nozeliInput?.text === 'function' ? window.__nozeliInput.text() : null;
    const result = await managed.send(text,{relPath,materialText,background}).then(value=>({ok:true,value}),error=>({ok:false,error}));
    if (!result.ok) return reject(result.error.message);
    return result.value;
  };
}
