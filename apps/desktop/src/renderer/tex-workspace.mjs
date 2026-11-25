import { mountPdf } from './pdf-view.mjs';
import { mountPreviewScrollLink } from './preview-scroll-link.mjs';
import {setActionButton} from './ui-actions.mjs';
import {offsetToPosition} from './editor-adapter.mjs';

// TeX owns only its toolbar and the shared comparison pane while explicitly open.
export function mountTexWorkspace({ getContext, beside, closeBeside }) {
  const $ = id => document.getElementById(id);
  const toolbar = document.createElement('div'); toolbar.id = 'tex-toolbar'; toolbar.className = 'tex-toolbar'; toolbar.hidden = true;
  toolbar.innerHTML = '<label>主文档 <select id="tex-root" aria-label="TeX 主文档"></select></label><select id="tex-engine" aria-label="TeX 编译引擎"></select><button id="tex-build" type="button">编译</button><button id="tex-cancel" type="button" hidden>取消</button><button id="tex-preview" type="button" aria-pressed="false">预览</button><button id="tex-refresh" type="button">刷新预览</button><span id="tex-view-commands" hidden><button id="tex-sync" type="button" aria-pressed="true" title="源码与预览联动滚动">联动</button></span><span id="tex-status" role="status"></span>';
  const details = document.createElement('details'); details.id = 'tex-diagnostics'; details.hidden = true;
  const summary = document.createElement('summary'); summary.textContent = '编译诊断与日志';
  const errors = document.createElement('div'), log = document.createElement('pre'); details.append(summary, errors, log);
  $('reader-scroll').before(toolbar, details);
  const positions = new Map();
  const positionKey = (identity=active) => identity ? `${identity.projectId}:${identity.config.engine}:${identity.config.root}` : null;
  let active = null, epoch = 0, showPreview = false, renderEpoch = 0, link = null, linked = true, syncLeader = 'preview';
  let initializing = false, configuring = false, configurationEpoch = 0;
  const persistFailure = (code,message) => ({ok:false,error:{code,message}});
  const stalePersistence = () => persistFailure('STALE_CONTEXT','TeX 上下文已变化，旧保存回执不能确认当前导航。');
  function positionSnapshot(identity){
    const key=positionKey(identity);
    if(beside.tex&&beside.pdf)positions.set(key,{page:beside.pdf.current(),zoom:beside.pdf.zoomLevel(),scrollTop:$('secondary-scroll').scrollTop});
    const {page=1,zoom=1,scrollTop=0}=positions.get(key)??{};
    return {page,zoom,scrollTop,preview:showPreview};
  }
  async function savePosition(checked=true, linkChoice){
    let current=()=>false;
    try{
      let context;try{context=getContext();}catch(error){return {result:persistFailure(error.code||'TEX_CONTEXT_FAILED',error.message||'TeX 上下文无法读取。'),current};}
      const identity=active;
      if(checked&&(initializing||configuring||identity&&identity.ready!==true))return {result:persistFailure('TEX_CONTEXT_NOT_READY','TeX 上下文尚未就绪或配置结果不确定，尚不能确认保存。'),current};
      if(!identity){
        const result=/\.tex$/i.test(context?.file?.relPath||'')?persistFailure('TEX_CONTEXT_NOT_READY','TeX 身份尚未就绪，未将保存视为不适用。'):{ok:true,value:{applicable:false}};
        return {result,current};
      }
      const projectId=identity.projectId,root=identity.config?.root,engine=identity.config?.engine,sourcePath=identity.sourcePath,generation=epoch,configuration=configurationEpoch,viewGeneration=renderEpoch;
      if(!projectId||!root||!engine)return {result:persistFailure('TEX_CONTEXT_NOT_READY','TeX 项目或主文档身份尚未确定。'),current};
      current=()=>{
        const now=getContext();
        return active===identity&&epoch===generation&&configurationEpoch===configuration&&renderEpoch===viewGeneration&&(!checked||!initializing&&!configuring&&identity.ready===true)&&identity.config?.root===root&&identity.config?.engine===engine&&now?.project?.id===projectId&&now?.file?.relPath===sourcePath;
      };
      if(!current())return {result:stalePersistence(),current};
      let view;
      try{view=positionSnapshot(identity);}catch(error){return {result:current()?persistFailure(error.code||'TEX_POSITION_FAILED',error.message||'TeX 预览位置无法读取。'):stalePersistence(),current};}
      if(!current())return {result:stalePersistence(),current};
      if (linkChoice !== undefined) view.linked = linkChoice;
      const response=await call('tex.view',{projectId,root,view});
      return {result:current()?{ok:true,value:{applicable:true,projectId,root}}:stalePersistence(),response,current};
    }catch(error){
      let unchanged=false;try{unchanged=current();}catch{}
      return {result:unchanged?persistFailure(error.code||'TEX_VIEW_FAILED',error.message||'TeX 预览位置未保存。'):stalePersistence(),current};
    }
  }
  async function rememberPosition(linkChoice){
    if(!active?.config.root)return;
    const {result,response,current}=await savePosition(false,linkChoice);
    if(result.ok)return response;
    try{if(current())message('预览位置未保存：'+result.error.message);}catch{}
  }
  const call = async (op, payload) => { const result = await window.nozeli.invoke(op, payload); if (!result.ok) throw Object.assign(Error(result.error.message), { code: result.error.code }); return result.value; };
  const message = value => { $('tex-status').textContent = value; };
  const syncState = (state, title) => { $('tex-sync').dataset.state = state; $('tex-sync').title = title; };
  const lineOffset = (text, line, column = 1) => text.split('\n').slice(0, line - 1).reduce((n, row) => n + row.length + 1, 0) + Math.max(0, (column || 1) - 1);
  async function query(direction, extra = {}) {
    const context = getContext();
    return call('tex.sync', { projectId: active.projectId, buildId: beside.texBuildId, relPath: context.file.relPath, text: context.editor.adapter.getText(), direction, ...extra });
  }
  function attachLink() {
    const savedLink = link?.snapshot();
    link?.dispose(); link = null;
    $('tex-sync').setAttribute('aria-pressed', String(linked));
    syncState(linked ? 'ready' : 'off', linked ? '源码与预览按内容位置联动；Ctrl/Cmd+点击PDF定位源码' : '点击恢复源码与预览联动');
    const adapter = getContext().editor?.adapter, identity = active, pdf = beside.pdf;
    if (!adapter || !identity || !pdf || !beside.tex) return;
    if (!identity.syncTool) syncState('unavailable', '未安装SyncTeX定位工具；预览可独立阅读');
    const enabled = () => active === identity && linked && identity.syncTool && beside.texBuildId && showPreview && beside.tex && beside.pdf === pdf && getContext().editor?.adapter === adapter && !getContext().composing;
    link = mountPreviewScrollLink({ source: adapter, preview: $('secondary-scroll'), enabled, delay: 65,
      onError: error => { if (active === identity) syncState('paused', error.message); },
      fromSource: async ({ current, write, offset }) => {
        syncLeader = 'source';
        const pos = offsetToPosition(adapter.getText(), Number.isInteger(offset) ? Math.min(offset,adapter.getText().length) : adapter.getViewportOffset(.25));
        const result = await query('forward', { line: pos.lineNumber, column: pos.column - 1 });
        if (!current()) return;
        const point = result.points.find(p => p.page === pdf.current()) || result.points[0];
        if (!point) { syncState('unmapped', '这段源码没有对应排版位置'); return; }
        await write(async () => {
          await pdf.go(point.page);
          if (!current()) return;
          const pixel = pdf.syncClientPoint(point), viewport = $('secondary-scroll');
          if (pixel) viewport.scrollTop += pixel.y - viewport.getBoundingClientRect().top - viewport.clientHeight * .25;
        });
        if (current()) syncState('ready', '源码与预览按内容位置联动；Ctrl/Cmd+点击PDF定位源码');
      },
      fromPreview: async ({ current, write }) => {
        syncLeader = 'preview';
        const point = pdf.syncPoint(); if (!point) return;
        const result = await query('inverse', point);
        if (!current()) return;
        if (!result.relPath) { syncState('unmapped', '此处没有项目源码位置'); return; }
        if (result.relPath !== getContext().file.relPath) { syncState('other-source', `此处来自${result.relPath}；Ctrl/Cmd+点击可定位`); return; }
        const offset = Math.min(adapter.getText().length, lineOffset(adapter.getText(), result.line, result.column));
        await write(() => adapter.setScrollTop(adapter.getOffsetTop(offset) - adapter.getScrollMetrics().height * .25));
        if (current()) syncState('ready', '源码与预览按内容位置联动；Ctrl/Cmd+点击PDF定位源码');
      },
    });
    if(savedLink?.leader==='source'&&Number.isInteger(savedLink.offset))link.alignSourceOffset(savedLink.offset);else link.align(syncLeader);
  }
  async function revealSource({projectId,relPath,sourceDigest,line,column,selectLine=false}) {
    const context = getContext();
    if (context.project?.id !== projectId || context.file?.relPath !== relPath || !context.editor) return;
    const adapter = context.editor.adapter, text = adapter.getText();
    const comparable = selectLine ? text.replace(/\r\n?/g, '\n') : text;
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(comparable)))].map(n => n.toString(16).padStart(2, '0')).join('');
    const now = getContext();
    if (now.project?.id !== projectId || now.file?.relPath !== relPath || now.editor?.adapter !== adapter) return;
    if (adapter.getText() !== text || digest !== sourceDigest) { syncState('paused', '目标源码已变化，请重新编译后定位'); if(selectLine) message('目标源码已变化，请重新编译后定位'); return; }
    if (selectLine) {
      const breaks = /\r\n?|\n/g;
      let start = 0;
      for (let index = 1; index < line; index++) {
        if (!breaks.exec(text)) return;
        start = breaks.lastIndex;
      }
      adapter.revealRange(start, breaks.exec(text)?.index ?? text.length);
    } else adapter.revealRange(Math.min(text.length, lineOffset(text, line, column)));
    adapter.focus();
  }
  $('tex-sync').onclick = () => { linked = !linked; attachLink(); void rememberPosition(linked); };
  $('secondary-scroll').addEventListener('click', async event => {
    if (!(event.ctrlKey || event.metaKey) || !active || !beside.tex || !beside.pdf || event.target.closest('.note-anchor')) return;
    if (!beside.texBuildId) return;
    const point = beside.pdf.syncPoint(.25, { x: event.clientX, y: event.clientY }); if (!point) return;
    event.preventDefault(); const identity = active, projectId = active.projectId;
    try {
      const result = await query('inverse', point);
      if (active !== identity || !result.relPath) return;
      const locator={projectId,relPath:result.relPath,sourceDigest:result.sourceDigest,line:result.line,column:Math.max(1,result.column||1)};
      if (getContext().file.relPath !== result.relPath) await call('workspace.control', {type:'tex-source-open',...locator});
      else await revealSource(locator);
    } catch (error) { syncState('paused', error.message); }
  });
  function ensurePane() {
    if (beside.tex) return;
    closeBeside(); beside.tex = true; showPreview = true;
    $('secondary-pane').hidden = false; $('pane-divider').hidden = false; $('documents').classList.add('dual');
    $('secondary-pane').setAttribute('aria-label', 'TeX PDF 预览，只读');
    $('secondary-pane').querySelector('.compare-switch').hidden = true;
    $('secondary-text').hidden = true; $('secondary-pdf').hidden = false; $('secondary-tools').hidden = false;
    $('secondary-message').hidden = false; $('secondary-message').textContent = '请选择预览或编译。';
    $('secondary-path').dataset.iconPath='preview.pdf'; $('secondary-path').textContent = 'TeX PDF 预览';
  }
  async function renderPreview(load, {record = null, relPath, label}) {
    const identity = active;
    if (!identity) return;
    ensurePane(); showPreview = true; $('tex-preview').setAttribute('aria-pressed', 'true');
    const ticket = ++renderEpoch;
    const configuration = configurationEpoch;
    const current = () => active === identity && ticket === renderEpoch && configuration === configurationEpoch && showPreview && beside.tex && getContext()?.project?.id === identity.projectId && getContext()?.file?.relPath === identity.sourcePath;
    $('secondary-pdf').dataset.loading = String(ticket);
    let stage, pdf;
    try {
      const result = await load();
      if (!current()) return;
      if (result.previewRecord) { record = result.previewRecord; relPath = record.root; label = `${record.root} · ${record.buildId.slice(0, 8)}`; }
      const saved = positions.get(positionKey());
      const page = beside.pdf?.current() || saved?.page || 1, zoom = beside.pdf?.zoomLevel?.() || saved?.zoom || 1, scrollTop = beside.pdf ? $('secondary-scroll').scrollTop : saved?.scrollTop || 0;
      stage = document.createElement('div'); stage.dataset.texStage = record?.buildId || relPath;
      stage.style.cssText = 'position:absolute;visibility:hidden;inset:0;min-width:0;';
      $('secondary-pdf').append(stage);
      pdf = await mountPdf({ parent: stage, fitViewport: $('secondary-scroll'), bytes: result.bytes, page, initialZoom: zoom, onPage: (p, count) => { if (current()) { $('secondary-page').textContent = `${p} / ${count}`; if(beside.pdf===pdf)link?.pageChanged(); } } });
      if (!current()) { pdf.destroy(); stage.remove(); return; }
      link?.dispose(); link = null;
      beside.pdf?.destroy(); beside.pdf = pdf; beside.texBuildId = record?.buildId || null;
      beside.texFile = { kind: 'pdf', relPath, buildId: record?.buildId, generated: true };
      stage.style.cssText = 'min-width:0;flex-shrink:0;'; $('secondary-pdf').replaceChildren(stage); $('secondary-scroll').scrollTop = scrollTop;
      $('secondary-message').hidden = true; $('secondary-path').dataset.iconPath='preview.pdf'; $('secondary-path').textContent = label;
      if (record) $('secondary-pdf').dataset.buildId = record.buildId; else delete $('secondary-pdf').dataset.buildId;
      attachLink();
      if (!record) syncState('unavailable', '同名 PDF 为冻结预览；编译后可使用源码定位');
      message(record ? '显示编译结果' : '已加载同名 PDF');
      void rememberPosition();
    } catch (error) {
      pdf?.destroy(); stage?.remove();
      if (current()) {
        const text = `预览加载失败（${relPath}）：${error.message}`;
        message(text); $('secondary-message').hidden = false; $('secondary-message').textContent = text + (beside.pdf ? '；保留原预览。' : '');
      }
    } finally { if (current()) delete $('secondary-pdf').dataset.loading; }
  }
  function showArtifact(record) {
    if (!active || record.root !== active.config.root || record.engine !== active.config.engine || beside.texBuildId === record.buildId) return;
    const projectId = active.projectId;
    return renderPreview(() => call('tex.artifact', {projectId, buildId: record.buildId}), {record, relPath: record.root, label: `${record.root} · ${record.buildId.slice(0, 8)}`});
  }
  function refreshPreview() {
    if (!active) return;
    const identity = active, relPath = identity.sourcePath.replace(/\.tex$/i, '.pdf');
    return renderPreview(async () => {
      try {
        const file = await call('workspace.tex.companion', {projectId: identity.projectId, sourcePath: identity.sourcePath});
        if (file.kind !== 'pdf' || !file.bytes) throw Error(`${relPath} 不是有效 PDF`);
        return file;
      } catch (error) {
        const record = identity.state?.lastSuccess;
        if ((error.code !== 'NOT_FOUND' && error.code !== 'ENOENT') || record?.root !== identity.config.root || record.engine !== identity.config.engine) throw error;
        const artifact = await call('tex.artifact', {projectId: identity.projectId, buildId: record.buildId});
        return {...artifact, previewRecord:record};
      }
    }, {relPath, label: relPath});
  }
  function receive(state) {
    if (!active || state.projectId && state.projectId !== active.projectId) return;
    if (state.sourceChanged) { changed(); return; }
    active.state = state;
    $('tex-cancel').hidden = !['building', 'queued'].includes(state.phase);
    const unbuilt = active.revision !== active.sentRevision;
    message(unbuilt ? '有修改待编译 · 预览为上次成功版本' : state.message || '选择入口后编译');
    $('secondary-pane').classList.toggle('tex-stale', state.phase !== 'success' || unbuilt);
    errors.replaceChildren(); log.textContent = state.log?.length > 65536 ? '（显示日志末尾 64 KiB；完整日志随构建保存）\n' + state.log.slice(-65536) : state.log || '';
    details.hidden = state.phase !== 'error' && !state.log && !state.diagnostics?.length;
    if (state.phase === 'error' && state.message) { const note = document.createElement('p'); note.textContent = state.message; errors.append(note); }
    for (const diagnostic of state.diagnostics || []) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `${diagnostic.relPath}:${diagnostic.line} · ${diagnostic.message}`;
      button.disabled = !diagnostic.sourceDigest || !Number.isSafeInteger(diagnostic.line) || diagnostic.line < 1;
      button.onclick = async () => {
        const identity = active;
        if (!identity || identity.state !== state || button.disabled) return;
        const locator = { projectId: identity.projectId, relPath: diagnostic.relPath, sourceDigest: diagnostic.sourceDigest, line: diagnostic.line, column: 1, selectLine: true };
        try {
          if (identity.sourcePath === locator.relPath) await revealSource(locator);
          else await call('workspace.control', { type: 'tex-source-open', ...locator });
        } catch (error) { if (active === identity && active.state === state) message(error.message); }
      };
      errors.append(button);
    }
    if (state.phase === 'error') details.open = true;
    if (state.phase === 'success' && state.lastSuccess && state.lastSuccess.buildId !== active.observedBuildId) {
      active.observedBuildId = state.lastSuccess.buildId;
      void showArtifact(state.lastSuccess);
    }
  }
  async function build() {
    const context = getContext(), identity = active;
    if (!identity || !context.editor || context.composing) return;
    try {
      if (!identity.config.root) throw Error('请选择 TeX 主文档。');
      identity.sentRevision = identity.revision;
      await call('tex.build', { projectId: identity.projectId, buffers: [{ relPath: context.file.relPath, text: context.editor.adapter.getText(), baseDigest: context.baseDigest }] });
    } catch (error) { if (identity === active) message(error.message); }
  }
  function changed() {
    if (!active) return;
    active.revision++;
    link?.pause(); syncState('paused', '源码或项目已有修改，等待对应的新编译结果后恢复联动');
    message('有修改待编译 · 预览为上次成功版本'); $('secondary-pane').classList.add('tex-stale');
  }
  async function configure() {
    if (!active) return;
    const identity = active, ticket = ++configurationEpoch;configuring=true;
    try {
      const config = { root: $('tex-root').value, engine: $('tex-engine').value, automatic: false };
      const saved = await call('tex.configure', { projectId: identity.projectId, ...config });
      if (identity !== active || ticket !== configurationEpoch) return;
      identity.config=saved;identity.ready=true;
      renderEpoch++;
      message('设置已保存；点击编译后生效');
    } catch (error) { if(identity===active&&ticket===configurationEpoch){identity.ready=false;message(error.message);} }
    finally { if(identity===active&&ticket===configurationEpoch)configuring=false; }
  }
  for (const id of ['tex-root', 'tex-engine']) $(id).addEventListener('change', configure);
  setActionButton($('tex-build'),'compile');$('tex-build').onclick = build;
  $('tex-cancel').onclick = () => { if (active) void call('tex.cancel', { projectId: active.projectId }).catch(e => message(e.message)); };
  $('tex-preview').onclick = () => {
    if (showPreview && beside.tex) closeBeside();
    else void refreshPreview();
  };
  $('tex-refresh').onclick = () => void refreshPreview();
  window.nozeli.subscribe('tex', receive);
  window.nozeli.subscribe('workspace.control',event=>{if(event.type!=='tex-configuration'||!active||event.projectId!==active.projectId||configuring)return;active.config=event.config;configurationEpoch++;renderEpoch++;$('tex-root').value=event.config.root;$('tex-engine').value=event.config.engine;message('编译设置已更新');});
  return {
    revealSource,
    changed,
    persist: rememberPosition,
    async persistChecked(){return (await savePosition()).result;},
    composing() { link?.pause(); },
    paneClosed() { link?.dispose(); link = null; showPreview = false; renderEpoch++; void rememberPosition(); if (active) { $('tex-preview').setAttribute('aria-pressed', 'false'); } },
    leave() { void rememberPosition(); link?.dispose(); link = null; epoch++; configurationEpoch++; initializing=false; configuring=false; renderEpoch++; active = null; toolbar.hidden = true; details.hidden = true; if (beside.tex) closeBeside(); },
    async enter() {
      const context = getContext(); if (!/\.tex$/i.test(context.file?.relPath || '')) return;
      const generation = ++epoch;configurationEpoch++;initializing=true;configuring=false;active = null; toolbar.hidden = false; message('检测 TeX 项目…');
      const projectId=context.project?.id,sourcePath=context.file.relPath;
      const current=()=>generation===epoch&&getContext()?.project?.id===projectId&&getContext()?.file?.relPath===sourcePath;
      for (const id of ['tex-root','tex-engine']) { $(id).replaceChildren(new Option('检测中…','')); $(id).disabled = true; }
      $('tex-build').disabled = true;
      try {
        const data = await call('tex.inspect', { projectId, relPath: sourcePath });
        if (!current()) return;
        for (const id of ['tex-root','tex-engine','tex-build']) $(id).disabled = false;
        active = { projectId, sourcePath, config: data.config, state: data.state, observedBuildId: data.state.lastSuccess?.buildId, syncTool: data.syncTool, revision: 0, sentRevision: 0, ready:false };
        $('tex-root').replaceChildren(new Option(data.config.root ? '选择主文档' : '请选择主文档', ''));
        for (const root of data.texFiles) $('tex-root').append(new Option(root, root));
        $('tex-root').value = data.config.root;
        $('tex-root').title = data.inference?.reason || ''; $('tex-engine').title = data.inference?.engineReason || '';
        $('tex-engine').replaceChildren();
        for (const [engine, available] of Object.entries(data.tools)) $('tex-engine').append(new Option(engine + (available ? '' : '（未安装）'), engine));
        $('tex-engine').value = data.config.engine;
        if (data.view) positions.set(positionKey(), data.view);
        showPreview = false;
        linked = data.view?.linked !== false; syncLeader = 'preview'; $('tex-sync').setAttribute('aria-pressed', String(linked));
        $('tex-preview').setAttribute('aria-pressed', String(showPreview));
        // Persist only the inferred root; entering a file never cancels an existing build.
        if (data.config.root && data.config.root !== data.configuredRoot) await call('tex.configure', { projectId, ...data.config, automatic:false });
        if (!current()) return;
        receive(data.state);
        active.ready=true;
      } catch (error) { if (current()) { message(error.message); details.hidden = false; details.open = true; errors.replaceChildren(); const note = document.createElement('p'); note.textContent = error.message; const retry = document.createElement('button'); retry.textContent = '重新检测 TeX 项目'; retry.onclick = () => this.enter(); errors.append(note,retry); for (const id of ['tex-root','tex-engine']) $(id).replaceChildren(new Option('检测失败','')); } }
      finally { if(generation===epoch)initializing=false; }
    },
  };
}
