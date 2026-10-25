import { mountPdf } from './pdf-view.mjs';
import { mountPreviewScrollLink } from './preview-scroll-link.mjs';
import { offsetToPosition } from './editor-adapter.mjs';

// TeX owns only its toolbar and the shared comparison pane while explicitly open.
export function mountTexWorkspace({ getContext, beside, closeBeside, openFile }) {
  const $ = id => document.getElementById(id);
  const toolbar = document.createElement('div'); toolbar.id = 'tex-toolbar'; toolbar.className = 'tex-toolbar'; toolbar.hidden = true;
  toolbar.innerHTML = '<label>主文档 <select id="tex-root" aria-label="TeX 主文档"></select></label><select id="tex-engine" aria-label="TeX 编译引擎"></select><button id="tex-build" type="button">编译</button><button id="tex-cancel" type="button" hidden>取消</button><span id="tex-view-commands" hidden><label><input id="tex-auto" type="checkbox">自动</label><button id="tex-preview" type="button" aria-pressed="true">预览</button><button id="tex-sync" type="button" aria-pressed="true" title="源码与预览联动滚动">联动</button></span><span id="tex-status" role="status"></span>';
  const details = document.createElement('details'); details.id = 'tex-diagnostics'; details.hidden = true;
  const summary = document.createElement('summary'); summary.textContent = '编译诊断与日志';
  const errors = document.createElement('div'), log = document.createElement('pre'); details.append(summary, errors, log);
  $('reader-scroll').before(toolbar, details);
  const positions = new Map();
  const positionKey = (identity=active) => identity ? `${identity.projectId}:${identity.config.engine}:${identity.config.root}` : null;
  let active = null, epoch = 0, timer, showPreview = true, renderEpoch = 0, rendering = null, link = null, linked = true, syncLeader = 'preview';
  let initializing = false, configuring = false, configurationEpoch = 0;
  const persistFailure = (code,message) => ({ok:false,error:{code,message}});
  const stalePersistence = () => persistFailure('STALE_CONTEXT','TeX 上下文已变化，旧保存回执不能确认当前导航。');
  function positionSnapshot(identity){
    const key=positionKey(identity);
    if(beside.tex&&beside.pdf)positions.set(key,{page:beside.pdf.current(),zoom:beside.pdf.zoomLevel(),scrollTop:$('secondary-scroll').scrollTop});
    return {...(positions.get(key)||{page:1,zoom:1,scrollTop:0}),preview:showPreview,linked};
  }
  async function savePosition(checked=true){
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
      const response=await call('tex.view',{projectId,root,view});
      return {result:current()?{ok:true,value:{applicable:true,projectId,root}}:stalePersistence(),response,current};
    }catch(error){
      let unchanged=false;try{unchanged=current();}catch{}
      return {result:unchanged?persistFailure(error.code||'TEX_VIEW_FAILED',error.message||'TeX 预览位置未保存。'):stalePersistence(),current};
    }
  }
  async function rememberPosition(){
    if(!active?.config.root)return;
    const {result,response,current}=await savePosition(false);
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
    const enabled = () => active === identity && linked && identity.syncTool && showPreview && beside.tex && beside.pdf === pdf && getContext().editor?.adapter === adapter && !getContext().composing;
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
  $('tex-sync').onclick = () => { linked = !linked; attachLink(); void rememberPosition(); };
  $('secondary-scroll').addEventListener('click', async event => {
    if (!(event.ctrlKey || event.metaKey) || !active || !beside.tex || !beside.pdf || event.target.closest('.note-anchor')) return;
    const point = beside.pdf.syncPoint(.25, { x: event.clientX, y: event.clientY }); if (!point) return;
    event.preventDefault(); const identity = active, projectId = active.projectId;
    try {
      const result = await query('inverse', point);
      if (active !== identity || !result.relPath) return;
      if (getContext().file.relPath !== result.relPath) await openFile(result.relPath);
      const context = getContext(); if (context.project?.id !== projectId || context.file?.relPath !== result.relPath || !context.editor) return;
      const adapter = context.editor.adapter, text = adapter.getText();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (getContext().editor?.adapter !== adapter || adapter.getText() !== text || digest !== result.sourceDigest) { syncState('paused', '目标源码已变化，请重新编译后定位'); return; }
      const offset = Math.min(text.length, lineOffset(text, result.line, result.column)); adapter.revealRange(offset); adapter.focus();
    } catch (error) { syncState('paused', error.message); }
  });
  function ensurePane() {
    if (beside.tex) return;
    closeBeside(); beside.tex = true; showPreview = true;
    $('secondary-pane').hidden = false; $('pane-divider').hidden = false; $('documents').classList.add('dual');
    $('secondary-pane').setAttribute('aria-label', 'TeX 编译预览，只读');
    $('secondary-pane').querySelector('.compare-switch').hidden = true;
    $('secondary-text').hidden = true; $('secondary-pdf').hidden = false; $('secondary-tools').hidden = false;
    $('secondary-message').hidden = false; $('secondary-message').textContent = '编译成功后在这里显示 PDF。';
    $('secondary-path').dataset.iconPath='preview.pdf'; $('secondary-path').textContent = 'TeX 编译预览';
  }
  async function showArtifact(record) {
    if (!active || !showPreview || record.root !== active.config.root || record.engine !== active.config.engine || beside.texBuildId === record.buildId || rendering === record.buildId) return;
    ensurePane();
    const identity = active, ticket = ++renderEpoch; rendering = record.buildId;
    $('secondary-pdf').dataset.loading = record.buildId;
    let stage, pdf;
    try {
      const result = await call('tex.artifact', { projectId: identity.projectId, buildId: record.buildId });
      if (active !== identity || ticket !== renderEpoch || !showPreview || !beside.tex) return;
      const saved = positions.get(positionKey());
      const page = beside.pdf?.current() || saved?.page || 1, zoom = beside.pdf?.zoomLevel?.() || saved?.zoom || 1, scrollTop = beside.pdf ? $('secondary-scroll').scrollTop : saved?.scrollTop || 0;
      stage = document.createElement('div'); stage.dataset.texStage = record.buildId; stage.style.cssText = `position:absolute;visibility:hidden;width:${$('secondary-pdf').clientWidth || $('secondary-scroll').clientWidth}px;`;
      $('secondary-scroll').append(stage);
      pdf = await mountPdf({ parent: stage, fitViewport: $('secondary-scroll'), bytes: result.bytes, page, initialZoom: zoom, onPage: (p, count) => { if (ticket === renderEpoch) { $('secondary-page').textContent = `${p} / ${count}`; if(beside.pdf===pdf)link?.pageChanged(); } } });
      if (active !== identity || ticket !== renderEpoch || !showPreview || !beside.tex) { pdf.destroy(); stage.remove(); return; }
      beside.pdf?.destroy(); beside.pdf = pdf; beside.texBuildId = record.buildId;
      beside.texFile = { kind: 'pdf', relPath: record.root, buildId: record.buildId, generated: true };
      stage.style.cssText = 'width:100%;min-width:0;flex-shrink:0;'; $('secondary-pdf').replaceChildren(stage); $('secondary-scroll').scrollTop = scrollTop;
      $('secondary-message').hidden = true; $('secondary-path').dataset.iconPath='preview.pdf'; $('secondary-path').textContent = `${record.root} · ${record.buildId.slice(0, 8)}`;
      $('secondary-pdf').dataset.buildId = record.buildId;
      delete $('secondary-pdf').dataset.loading;
      attachLink();
      void rememberPosition();
    } catch (error) { pdf?.destroy(); stage?.remove(); if (active === identity) message('预览加载失败：' + error.message); }
    finally { if (rendering === record.buildId) rendering = null; }
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
      button.onclick = async () => {
        await openFile(diagnostic.relPath);
        const context = getContext(); if (context.file?.relPath !== diagnostic.relPath) return;
        const adapter = context.editor?.adapter; if (!adapter) return;
        const lines = adapter.getText().split('\n'), offset = lines.slice(0, diagnostic.line - 1).reduce((n, l) => n + l.length + 1, 0);
        adapter.setSelection(offset, Math.min(offset + (lines[diagnostic.line - 1]?.length || 0), adapter.getText().length)); adapter.focus();
      };
      errors.append(button);
    }
    if (state.phase === 'error') details.open = true;
    if (state.lastSuccess) void showArtifact(state.lastSuccess);
  }
  async function build() {
    clearTimeout(timer);
    const context = getContext(), identity = active;
    if (!identity || !context.editor || context.composing) return;
    try {
      if (!identity.config.root) throw Error('请选择 TeX 主文档。');
      identity.sentRevision = identity.revision;
      await call('tex.build', { projectId: identity.projectId, buffers: [{ relPath: context.file.relPath, text: context.editor.adapter.getText(), baseDigest: context.baseDigest }] });
    } catch (error) { if (identity === active) message(error.message); }
  }
  function changed() {
    clearTimeout(timer);
    if (!active) return;
    active.revision++;
    link?.pause(); syncState('paused', '源码或项目已有修改，等待对应的新编译结果后恢复联动');
    message('有修改待编译 · 预览为上次成功版本'); $('secondary-pane').classList.add('tex-stale');
    if (active.config.automatic && !getContext().composing) timer = setTimeout(build, 1100);
  }
  async function configure() {
    if (!active) return;
    const identity = active, ticket = ++configurationEpoch;configuring=true;
    try {
      const config = { root: $('tex-root').value, engine: $('tex-engine').value, automatic: $('tex-auto').checked };
      const saved = await call('tex.configure', { projectId: identity.projectId, ...config });
      if (identity !== active || ticket !== configurationEpoch) return;
      identity.config=saved;identity.ready=true;
      if (beside.tex && beside.texBuildId && (identity.state?.lastSuccess?.root !== config.root || identity.state?.lastSuccess?.engine !== config.engine)) { closeBeside(); ensurePane(); }
      if (config.automatic && config.root) void build(); else message('设置已保存');
    } catch (error) { if(identity===active&&ticket===configurationEpoch){identity.ready=false;message(error.message);} }
    finally { if(identity===active&&ticket===configurationEpoch)configuring=false; }
  }
  for (const id of ['tex-root', 'tex-engine', 'tex-auto']) $(id).addEventListener('change', configure);
  $('tex-build').onclick = build;
  $('tex-cancel').onclick = () => { clearTimeout(timer); if (active) void call('tex.cancel', { projectId: active.projectId }).catch(e => message(e.message)); };
  $('tex-preview').onclick = () => {
    showPreview = !showPreview; $('tex-preview').setAttribute('aria-pressed', String(showPreview));
    if (!showPreview && beside.tex) closeBeside();
    else if (showPreview) { ensurePane(); if (active?.state?.lastSuccess) void showArtifact(active.state.lastSuccess); }
  };
  window.nozeli.subscribe('tex', receive);
  window.nozeli.subscribe('workspace.control',event=>{if(event.type!=='tex-configuration'||!active||event.projectId!==active.projectId||configuring)return;clearTimeout(timer);active.config=event.config;configurationEpoch++;$('tex-root').value=event.config.root;$('tex-engine').value=event.config.engine;$('tex-auto').checked=event.config.automatic;message('项目编译设置已更新；下次编译使用新配置。');});
  return {
    changed,
    persist: rememberPosition,
    async persistChecked(){return (await savePosition()).result;},
    composing() { clearTimeout(timer); link?.pause(); },
    paneClosed() { link?.dispose(); link = null; showPreview = false; renderEpoch++; rendering = null; void rememberPosition(); if (active) { $('tex-preview').setAttribute('aria-pressed', 'false'); } },
    leave() { void rememberPosition(); link?.dispose(); link = null; epoch++; configurationEpoch++; initializing=false; configuring=false; renderEpoch++; clearTimeout(timer); active = null; rendering = null; toolbar.hidden = true; details.hidden = true; if (beside.tex) closeBeside(); },
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
        active = { projectId, sourcePath, config: data.config, state: data.state, syncTool: data.syncTool, revision: 0, sentRevision: 0, ready:false };
        $('tex-root').replaceChildren(new Option(data.config.root ? '选择主文档' : '请选择主文档', ''));
        for (const root of data.texFiles) $('tex-root').append(new Option(root, root));
        $('tex-root').value = data.config.root;
        $('tex-root').title = data.inference?.reason || ''; $('tex-engine').title = data.inference?.engineReason || '';
        $('tex-engine').replaceChildren();
        for (const [engine, available] of Object.entries(data.tools)) $('tex-engine').append(new Option(engine + (available ? '' : '（未安装）'), engine));
        $('tex-engine').value = data.config.engine; $('tex-auto').checked = data.config.automatic;
        if (data.view) positions.set(positionKey(), data.view);
        showPreview = data.view?.preview !== false;
        linked = data.view?.linked !== false; syncLeader = 'preview'; $('tex-sync').setAttribute('aria-pressed', String(linked));
        if (showPreview) ensurePane();
        $('tex-preview').setAttribute('aria-pressed', String(showPreview));
        // Persist only the inferred root; entering a file never cancels an existing build.
        if (data.config.root && data.config.root !== data.configuredRoot) await call('tex.configure', { projectId, ...data.config });
        if (!current()) return;
        receive(data.state);
        if (data.config.root && data.config.automatic && !['building', 'queued'].includes(data.state.phase)) void build();
        active.ready=true;
      } catch (error) { if (current()) { message(error.message); details.hidden = false; details.open = true; errors.replaceChildren(); const note = document.createElement('p'); note.textContent = error.message; const retry = document.createElement('button'); retry.textContent = '重新检测 TeX 项目'; retry.onclick = () => this.enter(); errors.append(note,retry); for (const id of ['tex-root','tex-engine']) $(id).replaceChildren(new Option('检测失败','')); } }
      finally { if(generation===epoch)initializing=false; }
    },
  };
}
