import {demoIdentity,unwrapDemo,runDemoLayout} from '../domain/guided-demo.mjs';

export function mountDemoSurface({invoke,subscribe,scope,getCurrent,setTextMode,flush,beginNote,addTag,persistTag,tagActions,regionDrawing,startDrawing,workspaceGroups}){
  let session=null,lastTag=null,interrupted=false;
  const $=id=>document.getElementById(id),value=async(op,payload)=>unwrapDemo(await invoke(op,payload));
  const indicator=document.createElement('span');indicator.className='guided-demo-target';indicator.hidden=true;indicator.setAttribute('aria-hidden','true');document.body.append(indicator);
  const badge=document.createElement('span');badge.dataset.demoBadge='true';badge.className='guided-demo-content-badge';badge.textContent='演示内容 · 离线';badge.hidden=true;document.body.append(badge);
  subscribe('demo.changed',event=>{const next=event.session??event;if(next.projectId===scope.projectId){session=next;interrupted=next.status!=='playing';badge.hidden=false;if(interrupted)indicator.hidden=true;}});
  window.addEventListener('nozeli-project-change',()=>{if(session?.projectId!==scope.projectId){session=null;interrupted=true;badge.hidden=true;indicator.hidden=true;}});
  const check=(request,settling=false)=>{const c=getCurrent();if(c.project?.id!==request.projectId||scope.projectId!==request.projectId)throw Object.assign(Error('演示目标项目已变化'),{code:'DEMO_SCOPE_CHANGED'});if(session&&(session.id??session.sessionId)!==request.sessionId||!settling&&(interrupted||session&&session.epoch!==request.epoch))throw Object.assign(Error('演示已暂停或原动作身份失效'),{code:'DEMO_ACTION_CANCELLED'});return c;};
  const wait=async(predicate,request,ms=15000,settling=false)=>{const end=Date.now()+ms;while(Date.now()<end){check(request,settling);const result=predicate();if(result)return result;await new Promise(r=>setTimeout(r,50));}throw Error('真实工作面未在期限内达到预期状态');};
  const selectDemoTag=annotationId=>window.dispatchEvent(new CustomEvent('nozeli-demo-active-tag',{detail:{annotationId}}));
  async function showDemoTag(annotationId,request){
    selectDemoTag(annotationId);
    const find=()=>[...document.querySelectorAll('.note-anchor[data-annotation]')].find(node=>node.dataset.annotation===annotationId);
    const root=await wait(find,request,15000,true);
    const index=root.querySelector('.note-index');if(!index)throw Error('演示标签没有可用的打开入口');
    index.click();
    await wait(()=>{
      const current=find(),controller=current?.localWindow,card=controller?.node,box=card?.getBoundingClientRect(),view=controller?.snapshot();
      return box&&box.width>0&&box.height>0&&!view.hidden&&!view.collapsed&&getComputedStyle(card).visibility!=='hidden';
    },request,15000,true);
  }
  async function selectText(request){const c=check(request);if(!c.editor)throw Error('文本编辑器未就绪');setTextMode('edit');const text=c.editor.adapter.getText(),start=text.indexOf('方法');const from=start>=0?start:0,to=Math.min(text.length,from+28);if(from===to)throw Error('示例原文为空');c.editor.adapter.revealRange(from,to);c.editor.adapter.focus();return {relPath:c.file.relPath,kind:'text-selection',anchor:{start:from,end:to,quote:text.slice(from,to)},excerpt:text.slice(from,to),materialText:text};}
  async function saveTag(material,request){check(request);const tag=addTag(material,{autoEdit:false});if(!tag)throw Error('真实讨论标签未建立');selectDemoTag(tag.id);const result=await persistTag(tag);if(!result?.ok)throw Error(result?.error?.message||'讨论未持久化');lastTag=tag;await showDemoTag(tag.id,request);return tag;}
  async function sendTag(tag,text,request){check(request);await showDemoTag(tag.id,request);const previous=tag.acceptedRequestId;tagActions.onDraft(tag.id,text);const result=await tagActions.save(tag.id,text);return result||(tag.acceptedRequestId&&tag.acceptedRequestId!==previous?{requestId:tag.acceptedRequestId}:null);}
  async function execute(request){
    let c=check(request);const action=request.args?.semantic??request.action??request.command;
    const surfaceTarget=c.editor?.adapter.getEditorElement()??document.querySelector('#word-host:not([hidden]),#image-host:not([hidden]),#pdf-host:not([hidden]),.workspace-pane.is-focused');if(surfaceTarget){const rect=surfaceTarget.getBoundingClientRect();indicator.hidden=false;indicator.style.left=Math.max(6,rect.left+12)+'px';indicator.style.top=Math.max(6,rect.top+12)+'px';}badge.hidden=false;
    if(action==='md-preview'){setTextMode('edit');const toggle=await wait(()=>!$('markdown-preview-toggle').hidden?$('markdown-preview-toggle'):null,request);toggle.click();return {preview:true};}
    if(action==='report'||action==='report-revised'){
      // Runs on the report surface: the opened view must be the report bound
      // to this step's exact result todo (V1 for report, V2 for report-revised),
      // and the static report must actually be ready on screen.
      if(scope.kind!=='report')throw Error('演示报告未在正常报告面打开');
      const todoId=request.args?.todoId;
      if(!todoId)throw Error('演示报告缺少成果事项身份');
      const end=Date.now()+10000;let bound=false;
      while(Date.now()<end){
        check(request,true);
        const layout=(await value('workspace.snapshot',{projectId:request.projectId}).catch(()=>null))?.layout;
        const view=layout?.views?.[scope.viewId];
        if(view?.kind==='report'&&view.resourceId===todoId){bound=true;break;}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(!bound)throw Error('打开的报告不是本步骤绑定的成果版本');
      await wait(()=>document.querySelector('#managed-doc .isolated-status[data-state="ready"]'),request);
      const status=await value('managed.status',{projectId:request.projectId});
      const todo=status.state.todos.find(item=>item.id===todoId);
      if(!todo)throw Error('演示成果事项已不存在');
      return {report:true,todoId,revision:todo.revision??null};
    }
    if(action==='task-submit'){
      // Runs on the real conversation surface: the step types into the actual
      // composer and presses the real 后台任务 control (never 发送). The send
      // receipt clears the input and the exchange becomes visible in the same
      // timeline; re-visits only verify the recorded exchange, never resubmit.
      if(scope.kind!=='conversation')throw Error('演示后台任务未在真实对话内容面显示');
      const composer=$('composer'),background=$('submit-background'),send=$('send-message');
      if(!composer||!background)throw Error('项目对话输入区未就绪');
      const text='请整理两种方法的测量数据，并生成一份方法比较报告。';
      if(!document.body.innerText.includes(text)){
        await wait(()=>!background.disabled&&!send.disabled&&!composer.disabled&&!composer.readOnly?true:null,request,10000);
        composer.value=text;composer.dispatchEvent(new Event('input',{bubbles:true}));
        background.click();
        await wait(()=>!composer.value&&document.body.innerText.includes(text)?true:null,request,15000,true);
      }
      return {submitted:true,background:true,text};
    }
    if(['frontdesk-ask'].includes(action)){
      // Runs on the real conversation surface: the step only settles once the
      // timeline actually shows this step's message text on screen.
      if(scope.kind!=='conversation')throw Error('演示对话未在真实对话内容面显示');
      const expected=request.args?.expect;
      if(typeof expected!=='string'||!expected)throw Error('演示对话缺少可见内容锚点');
      await wait(()=>document.body.innerText.includes(expected)?true:null,request,12000);
      return {conversation:true,visible:true};
    }
    if(action==='task-a-done'||action==='task-a-revised'){
      // Shell side: walk the fresh result todo (V1 delivery or V2 delivery of
      // the same task) through the real attention prompt into a visible report
      // surface. A completed task is only acknowledged after its report view
      // is actually on screen.
      const todoId=request.args?.todoId;
      if(!todoId)throw Error('演示任务缺少待办身份');
      const attentionRow=()=>[...document.querySelectorAll('[data-attention-item]')].find(node=>node.dataset.attentionItem===request.projectId+':'+todoId);
      const row=attentionRow();
      if(row){if(row.getAttribute('aria-current')!=='true'){document.querySelector('[data-attention-expand]')?.click();row.click();}document.querySelector('[data-attention-open]')?.click();}
      else await window.__workspaceOpenTodo?.(todoId);
      const end=Date.now()+12000;
      while(Date.now()<end){
        check(request,true);
        const report=Object.values(workspaceGroups().snapshot().views).find(view=>view.kind==='report'&&view.resourceId===todoId);
        const windows=await value('workspace.windows.list',{projectId:request.projectId});
        if(report&&windows.some(window=>window.surfaces.some(surface=>surface.viewId===report.id&&surface.visible)))return {todoId,viewId:report.id};
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw Error('审核报告未在真实内容面打开');
    }
    if(action==='decision-continue'){
      // Runs on the report surface: open the real 追加讨论 affordance of the
      // demo report bound to this exact result todo, type the followup and
      // send it explicitly. Only the host-recorded proof rendered back into
      // the discussion settles this step; opening the composer or leaving a
      // draft never counts as sent, and sending is not acceptance.
      if(scope.kind!=='report')throw Error('演示追加讨论未在真实报告面打开');
      const todoId=request.args?.todoId;
      if(!todoId)throw Error('演示追加讨论缺少成果事项身份');
      const opener=await wait(()=>{const node=document.querySelector('[data-demo-discuss="open"]');return node&&!node.disabled&&!node.hidden?node:null;},request,10000);
      if(opener.getAttribute('aria-expanded')!=='true')opener.click();
      const input=await wait(()=>{const node=document.querySelector(`[data-demo-discussion="${todoId}"] [data-demo-discussion-input]`);return node&&!node.hidden&&!node.readOnly&&node.getClientRects().length?node:null;},request,8000);
      const text='请补充采样时段的说明，并在下一版候选中反映。';
      if(!document.querySelector(`[data-demo-discussion="${todoId}"] [data-demo-discussion-reply]`)?.textContent?.trim()){
        input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));
        const send=await wait(()=>{const node=document.querySelector(`[data-demo-discussion="${todoId}"] [data-demo-discussion-send]`);return node&&!node.disabled&&node.getClientRects().length?node:null;},request,8000);
        send.click();
        await wait(()=>document.querySelector(`[data-demo-discussion="${todoId}"] [data-demo-discussion-reply]`)?.textContent?.trim()?true:null,request,15000,true);
      }
      return {sent:true,todoId,text};
    }
    if(action==='decision-accept'||action==='decision-discard'){
      // Runs on the report surface: press the same footer button a user
      // would, confirm the explicit decision dialog, then verify the todo
      // actually settled through todo.manage. The deciding surface must be
      // the report view bound to the todo under decision (V2 for acceptance).
      const todoId=request.args?.todoId,choice=request.args?.decision??(action==='decision-accept'?'accept':'discard');
      if(!todoId)throw Error('演示决定缺少待办身份');
      const end=Date.now()+10000;let bound=false;
      while(Date.now()<end){
        check(request,true);
        const layout=(await value('workspace.snapshot',{projectId:request.projectId}).catch(()=>null))?.layout;
        const view=layout?.views?.[scope.viewId];
        if(view?.kind==='report'&&view.resourceId===todoId){bound=true;break;}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(!bound)throw Error('演示决定未绑定当前审核的成果版本');
      const current=await value('managed.status',{projectId:request.projectId});
      const todo=current.state.todos.find(todo=>todo.id===todoId);
      if(!todo)throw Error('原演示事项已不存在');
      if(todo.status!=='open')return {decided:true,choice:todo.resolution?.choice,alreadyDecided:true,todoId};
      const visible=()=>value('workspace.windows.list',{projectId:request.projectId}).then(windows=>windows.some(window=>window.surfaces.some(surface=>surface.viewId===scope.viewId&&surface.visible)));
      const shown=Date.now()+6000;while(Date.now()<shown){check(request,true);if(await visible())break;await new Promise(resolve=>setTimeout(resolve,50));}
      if(!await visible())throw Error('报告处理面尚未可见，未执行决定');
      const button=await wait(()=>document.querySelector(`#managed-result-actions [data-demo-decision="${choice}"]`),request,6000);
      button.click();
      const confirmButton=await wait(()=>{const node=document.querySelector('dialog[data-confirmation-dialog][open] [data-confirmation-confirm]');return node&&!node.disabled?node:null;},request,8000);
      confirmButton.click();
      const settled=Date.now()+8000;let decided=todo;
      while(Date.now()<settled){
        check(request,true);
        const status=await value('managed.status',{projectId:request.projectId});
        decided=status.state.todos.find(todo=>todo.id===todoId)??decided;
        if(decided.status!=='open')break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if((choice==='accept'?decided.status!=='resolved':decided.status!=='cancelled')||decided.resolution?.choice!==choice)throw Error('演示决定没有取得正常回执');
      return {decided:true,choice,todoId};
    }
    if(action==='open'){if(!c.file)throw Error('真实文件驱动未就绪');return {relPath:c.file.relPath,kind:c.file.kind};}
    if(request.relPath&&c.file?.relPath!==request.relPath)throw Error('请先打开本章来源材料');
    if(action==='text-edit'){setTextMode('edit');const adapter=c.editor?.adapter;if(!adapter)throw Error('文本编辑器未就绪');const text='\n演示记录：方法 B 的误差更小，仍需检查样本量。\n';adapter.applyEdit({from:adapter.getText().length,insert:text});adapter.focus();const result=await flush();if(!result.ok)throw Error(result.error?.message||'文本保存未完成');return {saved:true,text:adapter.getText()};}
    if(action==='human-edit'){setTextMode('edit');const adapter=c.editor?.adapter;if(!adapter)throw Error('文本编辑器未就绪');const text='\n（我的补充）采样时段已核对，可并入结论。\n';adapter.applyEdit({from:adapter.getText().length,insert:text});adapter.focus();const result=await flush();if(!result.ok)throw Error(result.error?.message||'文本保存未完成');return {saved:true,author:'user'};}
    if(action==='point-note'||action==='selection-explain'||action==='discussion-create'){
      const material=await selectText(request);
      if(action==='point-note'){const adapter=c.editor.adapter;adapter.setSelection(material.anchor.start);const node=adapter.getEditorElement(),rect=node.getBoundingClientRect();node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:rect.left+50,clientY:rect.top+40,button:2}));await wait(()=>document.querySelector('.nozeli-context-menu:not([hidden])'),request);const button=[...document.querySelectorAll('.nozeli-context-menu button')].find(b=>b.textContent.includes('备注'));if(!button)throw Error('位置备注菜单不可用');button.click();await wait(()=>!$('note-form').hidden,request);$('note-input').value='演示备注：先记录想法，本地保存不派工。';$('note-form').requestSubmit();await wait(()=>$('note-form').hidden,request);return {saved:true};}
      const tag=await saveTag(material,request);if(action==='selection-explain'){const sent=await sendTag(tag,'请解释这处选区。',request);if(!sent)throw Error('选区解释未接收');await wait(()=>tag.status==='completed'||interrupted,request,15000,true);}return {annotationId:tag.id};
    }
    if(['discussion-send','discussion-followup','drawing-send'].includes(action)){lastTag=c.tags?.find(tag=>tag.id===lastTag?.id)??c.tags?.filter(tag=>action!=='drawing-send'||tag.drawing).at(-1);if(!lastTag)throw Error('原讨论标签未就绪，请回到建立标签步骤');const sent=await sendTag(lastTag,action==='discussion-followup'?'为什么仍要检查样本量？':'请结合这处材料说明两种方法的差异。',request);if(!sent)throw Error('讨论未被演示源接收');await wait(()=>lastTag.status==='completed'||interrupted,request,15000,true);if(action==='discussion-followup'&&!interrupted&&session.epoch===request.epoch){const card=[...document.querySelectorAll('[data-annotation]')].find(n=>n.dataset.annotation===lastTag.id);const toggle=card?.querySelector('[aria-expanded]');if(!toggle)throw Error('讨论折叠控件不可用');toggle.click();toggle.click();}return {annotationId:lastTag.id,requestId:lastTag.requestId};
    }
    // All reply state comes from the canonical fixture timeline, not tutorial text.
    if(action==='pdf-page'){if(!c.pdf)throw Error('PDF 驱动未就绪');await c.pdf.go(2);await c.pdf.zoom(1.1);return {page:c.pdf.current()};}
    if(action==='pdf-selection'){
      const layer=await wait(()=>{const layer=document.querySelector('.textLayer');return layer?.isConnected&&[...layer.querySelectorAll('span')].some(node=>node.textContent.trim())?layer:null;},request);
      const node=[...layer.querySelectorAll('span')].find(node=>node.textContent.trim());
      layer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));
      const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0}));
      await wait(()=>!$('selection-menu').hidden&&selection.toString().trim(),request);
      const selected=selection.toString(),before=new Set(getCurrent().tags.map(tag=>tag.id));
      $('selection-explain').click();
      const tag=await wait(()=>getCurrent().tags.find(tag=>!before.has(tag.id)&&tag.requestId),request,15000,true);
      await wait(()=>getCurrent().tags.find(current=>current.id===tag.id)?.status==='completed'||interrupted,request,15000,true);
      return {selected,annotationId:tag.id};
    }
    if(action==='image-note'||action==='drawing'){
      if(!c.pdf||!$('image-host').selectRegion)throw Error('图片驱动未就绪');$('image-host').selectRegion([.15,.2,.5,.45]);
      if(action==='image-note'){beginNote({anchored:true});$('note-input').value='演示图片备注：比较两组误差。';$('note-form').requestSubmit();await wait(()=>$('note-form').hidden,request,15000,true);return {saved:true};}
      await startDrawing();await wait(()=>regionDrawing.active(),request);const drawing=$('region-drawing').semantic;drawing.stroke([[.2,.3],[.45,.5],[.7,.7]]);const snapshot=regionDrawing.snapshot();await drawing.save();await wait(()=>!regionDrawing.active(),request,15000,true);return {strokes:snapshot.drawing.strokes.length};
    }
    if(action==='ppt-note'){const frame=$('ppt-frame');if(!frame)throw Error('PPT 驱动未就绪');const canvas=frame.contentDocument.querySelector('.slide-canvas,.canvas');if(!canvas)throw Error('PPT 画布尚未就绪');const r=canvas.getBoundingClientRect();canvas.dispatchEvent(new frame.contentWindow.MouseEvent('contextmenu',{bubbles:true,button:2,clientX:r.left+r.width*.4,clientY:r.top+r.height*.4}));const button=await wait(()=>frame.contentDocument.querySelector('[data-command="note-here"]'),request);button.click();await wait(()=>!$('note-form').hidden,request);$('note-input').value='演示幻灯片位置备注';$('note-form').requestSubmit();await wait(()=>$('note-form').hidden,request);return {saved:true};}
    if(action==='word-edit'){const frame=document.querySelector('#word-host iframe'),editor=frame?.contentWindow.nozeliWordEditor?.activeEditor;if(!editor)throw Error('Word 编辑入口未就绪');const text=' 演示修订：继续核查样本。',position=Math.max(1,editor.state.doc.content.size-1);editor.commands.setTextSelection(position);editor.view.focus();editor.view.dispatch(editor.state.tr.insertText(text,position));await wait(()=>c.office.getText().includes(text),request,15000,true);const result=await flush();if(!result.ok)throw Error(result.error?.message||'Word 保存未完成');return {saved:true,text:c.office.getText()};}
    if(action==='sheet-edit'){const frame=document.querySelector('#word-host iframe'),editor=frame?.contentWindow.nozeliSheetEditor;if(!editor)throw Error('表格编辑器未就绪');const range={row:[1,1],column:[1,1]},before=c.officeRevision;editor.setSelection([range]);editor.batchCallApis([{name:'clearCell',args:[1,1]},{name:'setCellValuesByRange',args:[[['12.5']],range,frame.contentDocument.querySelector('#luckysheet-rich-text-editor')]},{name:'calculateFormula',args:[]}]);await wait(()=>getCurrent().officeRevision>before,request,15000,true);const result=await flush();if(!result.ok)throw Error(result.error?.message||'表格保存未完成');return {saved:true};}
    if(action==='diff'){
      // Runs on the report surface: press the report's own frozen-deliverable
      // diff affordance, then verify a real frozen diff view opened for THIS
      // report's change set and that its frozen text is actually available.
      // The workspace's loose beside-file comparison is never used here; the
      // same handler serves V1 and V2 through the step's exact todo binding.
      if(scope.kind!=='report')throw Error('演示冻结 Diff 未在真实报告面打开');
      const todoId=request.args?.todoId;
      if(!todoId)throw Error('演示冻结 Diff 缺少成果事项身份');
      const end=Date.now()+10000;let todo=null;
      while(Date.now()<end){
        check(request,true);
        const layout=(await value('workspace.snapshot',{projectId:request.projectId}).catch(()=>null))?.layout;
        const status=await value('managed.status',{projectId:request.projectId}).catch(()=>null);
        const view=layout?.views?.[scope.viewId];
        todo=status?.state?.todos.find(item=>item.id===todoId)??null;
        if(view?.kind==='report'&&view.resourceId===todoId&&todo?.objectId)break;
        todo=null;await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(!todo?.objectId)throw Error('演示冻结 Diff 未绑定当前报告的成果事项');
      const review=await value('managed.review.read',{projectId:request.projectId,objectId:todo.objectId});
      const files=(review?.files??[]).filter(item=>typeof item.relPath==='string');
      const file=files.find(item=>item.changeFileId)??files[0];
      if(!review?.changeSetId||!file?.changeFileId)throw Error('此报告没有登记冻结交付差异；不会比较当前工作区文件');
      const button=await wait(()=>{const node=document.querySelector(`[data-demo-frozen-diff="${CSS.escape(file.relPath)}"]`)??document.querySelector('[data-demo-frozen-diff]');return node&&!node.disabled?node:null;},request,10000);
      button.click();
      const opened=Date.now()+12000;let compared=false;
      while(Date.now()<opened){
        check(request,true);
        const layout=(await value('workspace.snapshot',{projectId:request.projectId}).catch(()=>null))?.layout;
        if(Object.values(layout?.views??{}).some(view=>view.kind==='diff'&&view.viewState?.target?.changeSetId===review.changeSetId)){compared=true;break;}
        await new Promise(resolve=>setTimeout(resolve,60));
      }
      if(!compared)throw Error('冻结交付 Diff 未在真实内容面打开');
      const frozen=await value('managed.changes.read',{projectId:request.projectId,changeSetId:review.changeSetId,fileId:file.changeFileId});
      if(frozen?.availability!=='available'||typeof frozen.before?.text!=='string'||typeof frozen.after?.text!=='string')throw Error('冻结正文不可用；不会以当前文件替代');
      return {compared:true,todoId,relPath:file.relPath,revision:todo.revision??null};
    }
    if(['split','detach','dock'].includes(action))return runDemoLayout(workspaceGroups(),request.projectId,action);
    throw Error('语义动作必须由宿主演示源处理：'+action);
  }
  subscribe('workspace.control',request=>{if(request.type!=='demo-action'||request.projectId!==scope.projectId||request.viewId!==scope.viewId)return;void (async()=>{const state=await value('demo.state',{projectId:request.projectId});if(!state.demo)throw Error('不是登记的演示项目');session=state.session;interrupted=session.status!=='playing';const result=await execute(request);if(result?.annotationId)await showDemoTag(result.annotationId,request);return result;})().then(result=>invoke('demo.result',{projectId:request.projectId,sessionId:request.sessionId,epoch:request.epoch,requestId:request.requestId,ok:true,value:result}),error=>invoke('demo.result',{projectId:request.projectId,sessionId:request.sessionId,epoch:request.epoch,requestId:request.requestId,ok:false,error:{code:error.code,message:error.message}}));});
  const interrupt=event=>{if(!event.isTrusted||event.type==='pointermove'&&!event.movementX&&!event.movementY||!session||session.status!=='playing')return;if(event.type!=='pointermove')interrupted=true;void invoke('demo.interrupt',{...demoIdentity(session),reason:event.type}).then(result=>{if(result.ok&&result.value?.session){session=result.value.session;interrupted=session.status!=='playing';}});};
  for(const name of ['pointerdown','pointermove','keydown','beforeinput','wheel'])window.addEventListener(name,interrupt,true);
  // Same-origin Office drivers have their own input documents; attach when loaded.
  const frames=new WeakSet();const wire=()=>{for(const frame of document.querySelectorAll('iframe')){const doc=frame.contentDocument;if(!doc||frames.has(doc))continue;frames.add(doc);for(const name of ['pointerdown','pointermove','keydown','beforeinput','wheel'])doc.addEventListener(name,interrupt,true);}};new MutationObserver(wire).observe(document.body,{childList:true,subtree:true});document.addEventListener('load',wire,true);wire();
  if(scope.projectId)void value('demo.state',{projectId:scope.projectId}).then(state=>{if(state.demo){session=state.session;interrupted=session.status!=='playing';badge.hidden=false;}}).catch(()=>{});
}
