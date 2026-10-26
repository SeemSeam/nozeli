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
  async function selectText(request){const c=check(request);if(!c.editor)throw Error('文本编辑器未就绪');setTextMode('edit');const text=c.editor.adapter.getText(),start=text.indexOf('方法');const from=start>=0?start:0,to=Math.min(text.length,from+28);if(from===to)throw Error('示例原文为空');c.editor.adapter.revealRange(from,to);c.editor.adapter.focus();return {relPath:c.file.relPath,kind:'text-selection',anchor:{start:from,end:to,quote:text.slice(from,to)},excerpt:text.slice(from,to),materialText:text};}
  async function saveTag(material,request){check(request);const tag=addTag(material,{autoEdit:false});if(!tag)throw Error('真实讨论标签未建立');const result=await persistTag(tag);if(!result?.ok)throw Error(result?.error?.message||'讨论未持久化');lastTag=tag;return tag;}
  async function sendTag(tag,text,request){check(request);const previous=tag.acceptedRequestId;tagActions.onDraft(tag.id,text);const result=await tagActions.save(tag.id,text);return result||(tag.acceptedRequestId&&tag.acceptedRequestId!==previous?{requestId:tag.acceptedRequestId}:null);}
  async function execute(request){
    let c=check(request);const action=request.args?.semantic??request.action??request.command;
    const surfaceTarget=c.editor?.adapter.getEditorElement()??document.querySelector('#word-host:not([hidden]),#image-host:not([hidden]),#pdf-host:not([hidden]),.workspace-pane.is-focused');if(surfaceTarget){const rect=surfaceTarget.getBoundingClientRect();indicator.hidden=false;indicator.style.left=Math.max(6,rect.left+12)+'px';indicator.style.top=Math.max(6,rect.top+12)+'px';}badge.hidden=false;
    if(action==='notification'){
      const key=request.projectId+':'+request.args.todoId,row=[...document.querySelectorAll('[data-attention-item]')].find(node=>node.dataset.attentionItem===key);
      if(row){if(row.getAttribute('aria-current')!=='true'){document.querySelector('[data-attention-expand]').click();row.click();}document.querySelector('[data-attention-open]').click();}
      else{if(typeof window.__workspaceOpenTodo!=='function')throw Error('正常待办入口未就绪');await window.__workspaceOpenTodo(request.args.todoId);}
      const end=Date.now()+14000;
      while(Date.now()<end){check(request,true);const report=Object.values(workspaceGroups().snapshot().views).find(view=>view.kind==='report'&&view.resourceId===request.args.todoId),windows=await value('workspace.windows.list',{projectId:request.projectId});if(report&&windows.some(window=>window.surfaces.some(surface=>surface.viewId===report.id&&surface.visible)))return {todoId:request.args.todoId,viewId:report.id};await new Promise(resolve=>setTimeout(resolve,50));}
      throw Error('正常报告处理面未确认就绪');
    }
    if(action==='report'){if(scope.kind!=='report')throw Error('演示报告未在正常报告面打开');await wait(()=>document.querySelector('#managed-doc .isolated-status[data-state="ready"]'),request);return {report:true};}
    if(action==='decision'){
      const current=await value('managed.status',{projectId:request.projectId}),todo=current.state.todos.find(todo=>todo.id===request.args.todoId);
      if(!todo)throw Error('原演示事项已不存在');
      if(todo.status!=='open'&&todo.resolution?.choice)return {decided:true,choice:todo.resolution.choice,alreadyDecided:true};
      const visible=()=>value('workspace.windows.list',{projectId:request.projectId}).then(windows=>windows.some(window=>window.surfaces.some(surface=>surface.viewId===scope.viewId&&surface.visible)));
      const deadline=Date.now()+14000;while(Date.now()<deadline){check(request,true);if(await visible())break;await new Promise(resolve=>setTimeout(resolve,50));}
      if(!await visible())throw Error('报告处理面尚未可见，未执行决定');
      const button=await wait(()=>document.querySelector('#managed-result-actions [data-demo-decision="accept"]'),request);
      button.click();
      let decided=null;const settle=Date.now()+14000;
      while(Date.now()<settle){
        check(request,true);
        const status=await value('managed.status',{projectId:request.projectId});
        decided=status.state.todos.find(todo=>todo.id===request.args.todoId);
        if(decided?.status!=='open')break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(decided?.status!=='resolved'||decided?.resolution?.choice!=='accept')throw Error('演示决定没有取得正常回执');return {decided:true,choice:'accept',todoId:decided.id};
    }
    if(action==='open'){if(!c.file)throw Error('真实文件驱动未就绪');return {relPath:c.file.relPath,kind:c.file.kind};}
    if(request.relPath&&c.file?.relPath!==request.relPath)throw Error('请先打开本章来源材料');
    if(action==='text-edit'){setTextMode('edit');const adapter=c.editor?.adapter;if(!adapter)throw Error('文本编辑器未就绪');const text='\n演示记录：方法 B 的误差更小，仍需检查样本量。\n';adapter.applyEdit({from:adapter.getText().length,insert:text});adapter.focus();const result=await flush();if(!result.ok)throw Error(result.error?.message||'文本保存未完成');return {saved:true,text:adapter.getText()};}
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
    if(action==='diff'){$('open-beside').click();await wait(()=>[...$('beside-file').options].some(o=>o.value==='comparison-after.txt'),request);$('beside-file').value='comparison-after.txt';$('beside-file').dispatchEvent(new Event('change'));$('beside-diff').click();await wait(()=>document.querySelector('.cm-mergeView'),request);return {compared:true};}
    if(['split','detach','dock'].includes(action))return runDemoLayout(workspaceGroups(),request.projectId,action);
    throw Error('语义动作必须由宿主演示源处理：'+action);
  }
  subscribe('workspace.control',request=>{if(request.type!=='demo-action'||request.projectId!==scope.projectId||request.viewId!==scope.viewId)return;void (async()=>{const state=await value('demo.state',{projectId:request.projectId});if(!state.demo)throw Error('不是登记的演示项目');session=state.session;interrupted=session.status!=='playing';return execute(request);})().then(result=>invoke('demo.result',{projectId:request.projectId,sessionId:request.sessionId,epoch:request.epoch,requestId:request.requestId,ok:true,value:result}),error=>invoke('demo.result',{projectId:request.projectId,sessionId:request.sessionId,epoch:request.epoch,requestId:request.requestId,ok:false,error:{code:error.code,message:error.message}}));});
  const interrupt=event=>{if(!event.isTrusted||event.type==='pointermove'&&!event.movementX&&!event.movementY||!session||session.status!=='playing'||event.target?.closest?.('#guided-demo-player,#guided-demo-disclosure'))return;if(event.type!=='pointermove')interrupted=true;void invoke('demo.interrupt',{...demoIdentity(session),reason:event.type}).then(result=>{if(result.ok&&result.value?.session){session=result.value.session;interrupted=session.status!=='playing';}});};
  for(const name of ['pointerdown','pointermove','keydown','beforeinput','wheel'])window.addEventListener(name,interrupt,true);
  // Same-origin Office drivers have their own input documents; attach when loaded.
  const frames=new WeakSet();const wire=()=>{for(const frame of document.querySelectorAll('iframe')){const doc=frame.contentDocument;if(!doc||frames.has(doc))continue;frames.add(doc);for(const name of ['pointerdown','pointermove','keydown','beforeinput','wheel'])doc.addEventListener(name,interrupt,true);}};new MutationObserver(wire).observe(document.body,{childList:true,subtree:true});document.addEventListener('load',wire,true);wire();
  if(scope.projectId)void value('demo.state',{projectId:scope.projectId}).then(state=>{if(state.demo){session=state.session;interrupted=session.status!=='playing';badge.hidden=false;}}).catch(()=>{});
}
