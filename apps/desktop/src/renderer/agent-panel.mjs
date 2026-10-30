import {mountConfiguration} from './configuration-setup.mjs';
import {setIconButton} from './ui-icons.mjs';
import {mountManagedAgent} from './managed-agent-panel.mjs';
import { mountPopupMenu } from './popup-menu.mjs';
import { renderTagMarkdown } from './tag-markdown.mjs';
import './conversation-rendering.css';
import {mountDemoConversation} from './guided-demo-conversation.mjs';
const $ = (id) => document.getElementById(id);


import {mountSettingsPanel} from './settings-panel.mjs';
export function mountAgent({ invoke, toast, attachment, getProjectId, openManaged, openProjectFile, openExternal, openFrozenChange, onMessages = () => {}, onConversation = () => {}, subscribe = window.nozeli.subscribe }) {
  const managed = mountManagedAgent({invoke,toast,onMessages,openManaged,onConversation,openProjectFile,openExternal,openFrozenChange});
  const scope=window.__workspaceScope;
  const ownsConversation=!scope||(scope.role==='surface'&&scope.kind==='conversation');
  let projectId = null;
  let generation = 0;
  let consoleVisible = false;
  let restoredInput;
  const demo=mountDemoConversation({invoke,getProjectId:()=>projectId,onMessages,onConversation,subscribe});
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

  const configuration = mountConfiguration({document, invoke, autoOpen:false, onError: error => setAi(error.message, 'failed'), onInitialized: async () => {
    if (projectId) await loadProjectSettings(projectId, generation);
  }});

  async function loadProjectSettings(id, gen) {
    try {
      if(await demo.bind(id)){
        if(id!==projectId||gen!==generation)return;
        managed.observeFixture(id,demo.state);
        $('composer').readOnly=false;$('send-message').disabled=false;$('send-message').title='发送到离线演示源，不使用模型';
        $('selection-explain').disabled=false;$('selection-explain').title='演示选区解释 · 固定回复';
        $('provider-console-toggle').hidden=true;setAi('离线演示 · 非原生 Agent','demo');return;
      }
      const initialized = await configuration.ready;
      if (id !== projectId || gen !== generation) return;
      void loadLegacyHistory(id, gen).catch(error => {
        if (id === projectId && gen === generation) toast('旧版只读历史加载失败：' + error.message);
      });
      const connect = !scope?.viewState?.draftOnly && !scope?.draftOnly && (initialized || configuration.initialized);
      const ownsConnection = scope?.role === 'shell' || ownsConversation;
      const loaded = await managed.load(id, {connect:ownsConnection&&connect, observe:!ownsConnection, ...(ownsConversation?{input:restoredInput}:{})});
      if (id !== projectId || gen !== generation) return;
      if(!loaded&&connect&&scope?.role==='shell')await managed.enable(id);
      if (!connect) setAi('请完成 Nozeli 配置初始化；仍可阅读项目和历史记录。', 'unavailable');
    } catch (error) {
      if (id === projectId && gen === generation) setAi(error.message, 'failed');
    }
  }
  subscribe('workspace.control', event => {
    if (event.type !== 'drawing-connect' || !ownsConversation || event.projectId !== projectId) return;
    if (scope) { scope.draftOnly = false; scope.viewState = {...scope.viewState, draftOnly:false}; }
    void loadProjectSettings(projectId, generation);
  });
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
  window.__setProjectView = view => { if(view === 'terminal') return openConsole(); else closeConsole(); };
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
    $('quit-cancel').disabled = true;
    $('quit-error').textContent = '正在取消任务；如等待过久，可以强制退出。';
    try {
      const result = await invoke('session.quitChoice', { choice: 'cancel' });
      if (!result.ok) $('quit-error').textContent = result.error.message;
    } catch (error) {
      $('quit-error').textContent = error.message;
    } finally {
      $('quit-cancel').disabled = false;
    }
  });
  $('quit-force').addEventListener('click', async () => {
    $('quit-force').disabled = true;
    $('quit-error').textContent = '正在强制退出，不等待任务收尾…';
    try {
      const result = await invoke('session.quitChoice', { choice: 'force' });
      if (!result.ok) { $('quit-error').textContent = result.error.message; $('quit-force').disabled = false; }
    } catch (error) {
      $('quit-error').textContent = error.message;
      $('quit-force').disabled = false;
    }
  });
  subscribe('quit.confirm', () => {
    $('quit-error').textContent = '';
    if (!$('quit-choice').open) $('quit-choice').showModal();
  });
  if(ownsConversation)$('composer').addEventListener('input',()=>{if(projectId)restoredInput={projectId,frame:{...scope?.viewState,workspace:{...scope?.viewState?.workspace,draft:$('composer').value},composerMaterials:window.__composerMaterials?.snapshotPersist()}};});
  window.__agentProject = (id, {input} = {}) => {
    void invoke('managed.project.active',{projectId:id||null}).then(result=>{if(!result?.ok)toast(result?.error?.message||'更新活跃项目失败');}).catch(error=>toast(error.message));
    managed.clear({rememberDraft:false});
    demo.clear();
    // The workspace supplies its restored draft explicitly; never infer it from the old composer.
    if (projectId !== id) {
      closeConsole();
      legacyArchive.replaceChildren();legacyArchive.hidden=true;
      for (const role of ['qa', 'task']) roleCard(role).querySelector('.provider-output').replaceChildren();
    }
    filePaths = new Set();
    projectId = id;
    settingsPanel.projectChanged();
    restoredInput = input;
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
    if(ownsConversation)$('composer').readOnly=true;
    $('managed-doc').hidden = true;
    const loading=id?loadProjectSettings(id, gen):Promise.resolve();
    if (! $('provider-console').hidden) void refreshConsole();
    return loading;
  };
  // Shared send gate (discussion-thread layer): file-tag discussions and the
 // workspace-snapshot thread card join the same readiness contract.
  const agentSendGate = () => {
    const id = projectId;
    const gated = $('send-message').disabled;
    if (!id || gated || (!managed.active&&!demo.active)) return { ok: false, message: '发送未发出：' + (!id ? '尚未打开项目。' : $('send-message').title || 'Agent 尚未就绪或当前内容只读。') };
    return { ok: true, projectId: id };
  };
  window.__agentSelectionAction = async ({ action, excerpt, relPath, materialText, annotationRef, comment = '', background = false }) => {
    const id = projectId;
    const gate = agentSendGate();
    if (!gate.ok) { toast(gate.message); return false; }
    // Point-anchored discussions carry no excerpt by design; their material
    // arrives through the host-verified annotation reference instead.
    if (!excerpt?.trim() && !annotationRef) return false;
    const prompt = annotationRef
      ? action==='explain'?'请解释这处选区。':action==='task'?`请修改这处材料：\n${comment}`:comment
      : action==='explain'?`请解释：\n${excerpt}`:`${comment}\n\n选区：\n${excerpt}`;
    const context = annotationRef ? { tags: [annotationRef], ...(background ? { background: true } : {}) } : { relPath, materialText, ...(background ? { background: true } : {}) };
    const result = await (demo.active?demo.send(prompt,context):managed.send(prompt, context)).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    if (!result.ok) { toast(result.error.message); return false; }
    return { ...result.value, requestId: result.value.requestId ?? result.value.jobId };
  };
  window.__agentSend = async ({background=false}={}) => {
    if(!ownsConversation)return false;
    delete $('compose-status').dataset.draftSaving;
    const id = projectId;
    const materialsApi = window.__composerMaterials;
    const rawText = $('composer').value;
    const reject = reason => { $('compose-status').textContent='发送未发出：'+reason+'；草稿与材料仍保留';toast($('compose-status').textContent);return false; };
    if (!id) return reject('尚未打开项目');
    if (!managed.active&&!demo.active) return reject('Agent 尚未启用或连接，请完成配置并重试连接');
    if ($('send-message').disabled) return reject($('send-message').title||'Agent 尚未就绪或当前内容只读');
    if (materialsApi?.blocked()) return reject('有材料未就绪（失败/读取中），请先移除或重新添加再发送');
    const snap = materialsApi?.snapshot();
    const text = snap?.text || rawText;
    if (!text.trim() && !(snap?.attachments?.length)) return;
    const externals = (snap?.attachments || []).filter(a => a.digest);
    const images = externals.filter(a => a.source === 'drawing' && a.storage === 'recovery' && a.mime === 'image/png');
    if (images.length !== externals.length) return reject('仅支持显式发送涂鸦 PNG，其他本地附件仍不受支持');
    if (images.length > 8 || images.reduce((sum, a) => sum + a.size, 0) > 24 * 1024 * 1024) return reject('图片超过 8 张或 24 MiB 上限');
    const relPath = $('attach-file').checked ? attachment() : (snap?.attachments || []).find(a => a.relPath && a.source !== 'selection')?.relPath || null;
    const materialText = relPath && typeof window.__nozeliInput?.text === 'function' ? window.__nozeliInput.text() : null;
    const send=demo.active?demo.send:managed.send;
    const result = await send(text.trim() ? text : '请查看附带的涂鸦截图。',{relPath,materialText,background,composerText:rawText,imageAttachments:images.map(a=>({digest:a.digest,mime:a.mime,source:a.source,storage:a.storage,projectId:a.projectId,instanceId:a.instanceId,deliveryId:a.deliveryId}))}).then(value=>({ok:true,value}),error=>({ok:false,error}));
    if (!result.ok) return reject(result.error.message);
    if(demo.active&&projectId===id&&$('composer').value===rawText){$('composer').value='';$('composer').dispatchEvent(new Event('input',{bubbles:true}));}
    return result.value;
  };
}
