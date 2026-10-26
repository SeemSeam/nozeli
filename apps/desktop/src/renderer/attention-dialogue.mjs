// Native answers stay bound to one source interaction, separate from conversation input.
export function mountAttentionDialogue(container,{document,projectId,todo,invoke,current,onRefresh,openSettings,recover,drafts,confirm:confirmDialog,meta={}}){
 const destination=todo.destination||{},question=destination.question,identity=JSON.stringify([projectId,todo.id,destination.target,destination.ownerId,destination.threadId,destination.interactionId]);
 const storageKey='nozeli-attention:'+identity;
 let saved=drafts.get(identity);
 if(!saved){try{saved=JSON.parse(sessionStorage.getItem(storageKey)||'{}');}catch{saved={};}drafts.set(identity,saved);}
 let pending=false,latest=todo,phase='answering';
 const node=(tag,text)=>Object.assign(document.createElement(tag),text===undefined?{}:{textContent:text});
 const section=node('section');section.className='managed-attention-dialogue';section.setAttribute('aria-label','待办对话');
 section.dataset.attentionConversation=todo.id;
 // Compact header: the question title appears once; live status sits beside it; raw
 // identities collapse behind human names that are only shown when actually known.
 const header=node('header');header.className='managed-attention-header';header.dataset.attentionHeader='';
 const heading=node('h2',question?.method==='askDialog'?'待回答':(question?.title||todo.title||'待办对话'));heading.dataset.attentionTitle='';
 const status=node('p');status.dataset.attentionStatus='';status.setAttribute('role','status');
 const names=[meta.projectName,meta.sourceName].filter(value=>typeof value==='string'&&value.trim());
 header.append(heading);
 if(names.length){const line=node('p','来源 '+names.join(' · '));line.className='managed-attention-names';line.dataset.attentionNames='';header.append(line);}
 header.append(status);
 const source=node('details');source.dataset.attentionSource='';
 const ids=['项目 '+projectId,'待办 '+todo.id,destination.target?'会话 '+destination.target:null,destination.ownerId?'所有者 '+destination.ownerId:null,destination.threadId?'线程 '+destination.threadId:null,destination.interactionId?'交互 '+destination.interactionId:null].filter(Boolean).join(' · ');
 const idsLine=node('p',ids);idsLine.className='managed-attention-ids';
 source.append(node('summary','来源详情'),idsLine);header.append(source);
 const explanation=node('p');explanation.className='managed-attention-explanation';
 explanation.textContent=destination.kind==='conversation'&&question?[question.detail].filter(value=>typeof value==='string'&&value).join('\n'):(todo.text||'');
 const form=node('form'),fields=node('fieldset'),actions=node('div');actions.className='managed-attention-actions';
 form.append(fields,actions);section.append(header,...(explanation.textContent?[explanation]:[]),form);container.append(section);
 const retain=()=>{drafts.set(identity,saved);try{sessionStorage.setItem(storageKey,JSON.stringify(saved));}catch{}};
 const setStatus=(text,state='')=>{status.textContent=text;if(state)status.dataset.state=state;else delete status.dataset.state;};
 const control=(text,run,variant)=>{const b=node('button',text);b.type='button';b.className='ui-action';if(variant)b.dataset.uiAction=variant;b.onclick=()=>Promise.resolve().then(run).catch(error=>{setStatus(error.message,'error');});return b;};
 const paragraph=text=>{const p=node('p',text);fields.append(p);return p;};
 const textInput=(key,label,{value='',placeholder='',multiline=false}={})=>{const wrap=node('label',label);wrap.className='attention-text';const input=node(multiline?'textarea':'input');if(!multiline)input.type='text';input.dataset.attentionInput=key;input.value=saved[key]??value;input.placeholder=placeholder;input.oninput=()=>{saved[key]=input.value;retain();};wrap.append(input);fields.append(wrap);return input;};
 // Optional fields stay collapsed until used; a nonempty draft reopens them and
 // closing the toggle never discards what was typed (the input keeps its value).
 const collapsible=(key,summaryText,{multiline=false,placeholder=''}={})=>{const wrap=node('details');wrap.className='attention-extra';wrap.dataset.attentionExtra=key;const input=node(multiline?'textarea':'input');if(!multiline)input.type='text';input.dataset.attentionInput=key;input.setAttribute('aria-label',summaryText);input.value=saved[key]??'';input.placeholder=placeholder;input.oninput=()=>{saved[key]=input.value;retain();};wrap.append(node('summary',summaryText),input);if(String(saved[key]??'').length>0)wrap.open=true;fields.append(wrap);return input;};
 // Whole choice cards keep the native radio/checkbox focusable inside the label, so
 // keyboard focus, space and arrow keys keep working; selecting never submits.
 const choice=(key,label,options,{multi=false,recommended=null}={})=>{const group=node('fieldset');group.dataset.attentionChoices='';const legend=node('legend',label);group.append(legend);const inputs=[],cards=[];let matched=false;
  // Markers are recomputed for every card in the group, so a formerly selected
  // radio never keeps a stale data-attention-selected flag.
  const markAll=()=>{for(let i=0;i<inputs.length;i++){if(inputs[i].checked)cards[i].dataset.attentionSelected='true';else delete cards[i].dataset.attentionSelected;}};
  options.forEach((option,index)=>{const labelText=typeof option==='string'?option:option.label;if(typeof labelText!=='string')return;
   const card=node('div');card.className='attention-choice';card.dataset.attentionOption=labelText;
   const row=node('label');const input=node('input');input.type=multi?'checkbox':'radio';input.name=key;input.value=labelText;input.checked=multi?(saved[key]||[]).includes(labelText):saved[key]===labelText;
   input.onchange=()=>{saved[key]=multi?inputs.filter(i=>i.checked).map(i=>i.value):input.value;retain();markAll();};
   row.append(input);const body=node('span');body.className='attention-choice-body';const text=node('span',labelText);text.className='attention-choice-label';body.append(text);
   if(typeof option==='object'&&option.description){const description=node('small',option.description);description.className='attention-choice-desc';body.append(description);}
   row.append(body);
   if((typeof recommended==='number'&&recommended===index)||(typeof recommended==='string'&&recommended===labelText)){matched=true;const badge=node('span','推荐');badge.className='attention-choice-badge';badge.dataset.attentionRecommended='';row.append(badge);}
   card.append(row);
   if(typeof option==='object'&&option.preview!=null){const preview=node('details');preview.className='attention-choice-preview';preview.dataset.attentionPreview=labelText;const pre=node('pre',typeof option.preview==='string'?option.preview:JSON.stringify(option.preview,null,2));preview.append(node('summary','展开预览'),pre);card.append(preview);}
   group.append(card);inputs.push(input);cards.push(card);});
  if(!matched&&recommended!=null&&recommended!==false){const note=node('span','推荐：'+(typeof recommended==='string'?recommended:JSON.stringify(recommended)));note.dataset.attentionRecommendation='';legend.append(note);}
  markAll();fields.append(group);return ()=>multi?inputs.filter(i=>i.checked).map(i=>i.value):inputs.find(i=>i.checked)?.value;};
 let readAnswer=null,allowCancel=question?.capability?.cancel!==false,draftPair=null,settingsButton=null,recoverButton=null;
 const method=question?.method;
 if(destination.kind==='conversation'&&question){
  if(question.capability?.respond===false){
   allowCancel=false;paragraph('原生会话当前不支持响应此交互：'+(question.capability.reason||method||'未知方法')+'。不会生成替代答案、发送普通消息或跳转终端。');
  }else if(method==='select'&&Array.isArray(question.options)){
   const read=choice('selection','请选择',question.options);readAnswer=()=>{const answer=read();if(answer===undefined)throw Error('请选择一个选项。');return answer;};
  }else if(method==='confirm'){
   if(question.message)paragraph(question.message);const read=choice('confirm','确认决定',[{label:'确认'},{label:'拒绝'}]);readAnswer=()=>{const value=read();if(!value)throw Error('请明确选择确认或拒绝。');return value==='确认';};
  }else if(method==='input'||method==='editor'){
   const input=textInput('text','回答',{value:question.prefill??'',placeholder:question.placeholder??'',multiline:method==='editor'});readAnswer=()=>input.value;
  }else if(method==='askDialog'&&Array.isArray(question.questions)){
   const readers=question.questions.map((q,index)=>{if(q.header)paragraph(q.header);const recommended=q.recommended!=null&&q.recommended!==false?q.recommended:null;const selected=choice('question:'+index,q.question||q.id,q.options||[],{multi:q.multi===true,recommended});const custom=collapsible('custom:'+index,'其他回答（可选）',{multiline:true}),note=collapsible('note:'+index,'备注（可选）');return ()=>({id:q.id,selectedOptions:q.multi?selected():(selected()===undefined?[]:[selected()]),...(custom.value?{customInput:custom.value}:{}),...(note.value?{note:note.value}:{})});});
   readAnswer=()=>({kind:'submit',results:readers.map(read=>read())});
  }else if(method==='approve'){
   if(question.prompt?.full)paragraph(question.prompt.full);else if(question.prompt?.compact)paragraph(question.prompt.compact);
   const options=[{label:'仅允许本次',value:'once'},{label:'拒绝',value:'deny'}];if(question.prompt?.session)options.push({label:'允许本会话',value:'session'});
   for(const grant of question.prompt?.grants||[])if(['folder','target'].includes(grant.scope)){options.push({label:grant.label,value:{grant:grant.scope,always:false}});options.push({label:grant.alwaysLabel,value:{grant:grant.scope,always:true}});}
   const read=choice('approval','授权决定',options);readAnswer=()=>{const selected=options.find(option=>option.label===read());if(!selected)throw Error('请选择授权决定。');return selected.value;};
  }else if(method==='plan'&&Array.isArray(question.options)){
   allowCancel=false;if(question.planContent){const pre=node('pre',question.planContent);fields.append(pre);}if(question.planFilePath)paragraph(question.planFilePath);
   const options=question.options.filter(option=>!option.disabled&&['execute','compact','keep','refine','save'].includes(option.id));const read=choice('plan','计划决定',options),feedback=collapsible('feedback','反馈（可选；选择“细化计划”时必填）',{multiline:true});
   const tiers=question.tiers||[],role=tiers.length?choice('role','执行角色（可选）',tiers.map(tier=>({label:[tier.role,tier.provider,tier.model,tier.thinkingLevel].filter(Boolean).join(' · ')}))):null;
   readAnswer=()=>{const selected=options.find(option=>option.label===read());if(!selected)throw Error('请选择计划操作。');if(selected.id==='refine'&&!feedback.value.trim())throw Error('细化计划需要填写反馈。');const tier=role?tiers.find(tier=>[tier.role,tier.provider,tier.model,tier.thinkingLevel].filter(Boolean).join(' · ')===role()):null;return {choice:selected.id,...(feedback.value?{feedback:feedback.value}:{}),...(tier&&['execute','compact','keep'].includes(selected.id)?{role:tier.role}:{})};};paragraph('原生计划界面不支持取消；只有明确提交所选操作才会响应。');
  }else{allowCancel=false;paragraph('当前工作区不支持原生交互方法：'+(method||'未知')+'。未生成替代答案，也不会跳转终端或发送普通消息。');}
 }else if(destination.kind==='native-draft'){
  allowCancel=false;
  paragraph('读取并编辑来源原生会话的未发送文字。保存前宿主保留原文；图片保持不变，保存不会自动发送，也不会改动主对话草稿。');
  const editor=textInput('nativeDraft','原生未发送文字',{multiline:true});editor.dataset.attentionNativeDraft='';
  const load=control('读取原生草稿',()=>draftOperation(async()=>{
   const result=await invoke('managed.attention.draft.read',{projectId,todoId:todo.id});if(!result.ok)throw Error(result.error?.message||'原生草稿读取失败');if(!same())throw Error('原生会话已变化，读取结果未应用。');
   saved.nativeOriginal=result.value.text;if(saved.nativeDraft===undefined){saved.nativeDraft=result.value.text;editor.value=result.value.text;}retain();setStatus('已读取来源草稿。编辑后需明确保存，不会自动发送。');
  }));load.dataset.attentionDraftRead='';
  const save=control('保存原生草稿（不发送）',()=>draftOperation(async()=>{
   if(typeof saved.nativeOriginal!=='string')throw Error('请先读取原生草稿，确认来源原文。');
   const result=await invoke('managed.attention.draft.write',{projectId,todoId:todo.id,expectedText:saved.nativeOriginal,text:editor.value});if(!result.ok)throw Error(result.error?.message||'原生草稿保存失败');saved.nativeOriginal=editor.value;saved.nativeDraft=editor.value;retain();setStatus('原生文字已保存；图片未改动，未自动发送。');try{await onRefresh();}catch{status.textContent+=' 状态刷新失败，可点击“刷新状态”重试。';}
  }),'primary');save.dataset.attentionDraftWrite='';
  draftPair={load,save};
 async function draftOperation(run){if(pending||!same())throw Error('来源待办已变化，编辑保留。');pending=true;fields.disabled=true;for(const b of actions.querySelectorAll('button'))b.disabled=true;try{await run();}catch(error){setStatus(error.message+'；编辑内容保留。','error');}finally{pending=false;update(latest);}}
 }else{
  allowCancel=false;
  paragraph(destination.kind==='settings'?'此事项需要配置账号、服务或 Agent 资源。设置完成后请刷新核对；不会自动发送对话草稿。':'此事项需要恢复或核对原会话。恢复不代表重放旧任务，也不会发送未提交草稿。');
  settingsButton=control('打开相关设置',()=>openSettings(destination.section||'settings-provider'));settingsButton.dataset.attentionSettings='';
  if(destination.kind==='connection'&&recover){recoverButton=control('查看并恢复原会话（不重放）',recover);recoverButton.dataset.attentionRecover='';}
 }
 const same=()=>{const d=latest?.destination||{};return current()&&latest?.status==='open'&&JSON.stringify([projectId,latest.id,d.target,d.ownerId,d.threadId,d.interactionId])===identity;};
 async function respond(answer,cancel=false){
 if(pending||!same())throw Error('来源待办或会话已变化；答案草稿保留，请重新核对。');if(phase!=='answering')throw Error('本次请求已处理，不再重复提交；请刷新核对。');pending=true;fields.disabled=true;for(const b of actions.querySelectorAll('button'))b.disabled=true;setStatus(cancel?'正在向原生会话发送取消…':'正在提交给原生会话…','busy');
 try{const result=await invoke('managed.attention.respond',{projectId,todoId:todo.id,answer,...(cancel?{cancel:true}:{})});if(!result.ok)throw Object.assign(Error(result.error?.message||'回答未受理'),{code:result.error?.code});phase=cancel?'cancelled':'submitted';setStatus(cancel?'已向原生会话发送取消，本次请求已中断。':'回答已提交给原生会话。','ok');drafts.delete(identity);try{sessionStorage.removeItem(storageKey);}catch{}try{await onRefresh();}catch{status.textContent+=' 状态刷新失败，可点击“刷新状态”重试。';}}
  catch(error){setStatus((error.code?error.code+'：':'')+error.message+'；未提交草稿保留。','error');}
  finally{pending=false;update(latest);}
 }
 if(readAnswer){const submit=node('button','提交回答');submit.type='submit';submit.className='ui-action';submit.dataset.uiAction='primary';submit.dataset.attentionSubmit='';actions.append(submit);}
 if(allowCancel){const cancel=control('取消本次请求',async()=>{
  if(pending||!same())throw Error('来源待办或会话已变化；请刷新核对。');
  if(confirmDialog&&!await confirmDialog('取消会向原生会话发送中断，结束正在等待的本次请求；已填写的回答不再提交。仅关闭此视图不会取消请求。','确认取消本次请求'))return;
  if(!same())throw Error('确认期间原待办或会话已变化；未发送取消，请刷新核对。');
  await respond(undefined,true);
 },'danger');cancel.dataset.attentionCancel='';actions.append(cancel);}
 if(method==='askDialog'&&readAnswer){const more=node('details');more.className='attention-more';more.dataset.attentionMore='';const chat=control('转为原生对话',async()=>{if(pending||!same())throw Error('来源待办或会话已变化；请刷新核对。');await respond({kind:'chat'});});chat.dataset.attentionChat='';const note=node('p','转为原生对话：按“转为原生对话”提交本次交互；原生不再等待结构化答案，原会话转为自由对话，已选内容不会作为答案提交。');note.className='attention-more-note';more.append(node('summary','更多操作'),note,chat);actions.append(more);}
 if(draftPair)actions.append(draftPair.load,draftPair.save);
 if(settingsButton)actions.append(settingsButton);
 if(recoverButton)actions.append(recoverButton);
 const refresh=control('刷新状态',onRefresh);refresh.dataset.attentionRefresh='';actions.append(refresh);
 form.onsubmit=event=>{event.preventDefault();if(!readAnswer)return;try{void respond(readAnswer()).catch(error=>{setStatus(error.message,'error');});}catch(error){setStatus(error.message,'error');}};
 setStatus(destination.kind==='conversation'?(readAnswer?'等待明确回答；选择或输入不会自动提交。':'此原生交互不支持在工作区结构化回答。'):destination.kind==='native-draft'?'先读取来源原生草稿，再明确保存；不会自动发送。':destination.kind==='settings'?'打开相关设置完成配置后刷新核对。':destination.kind==='connection'?'查看并恢复原会话后刷新核对。':destination.kind==='terminal'?'原生会话被外部占用；等待释放后刷新核对。':'请核对来源状态后刷新。');
 function update(next){latest=next;const available=same(),settled=phase!=='answering';fields.disabled=pending||!available||settled;for(const b of actions.querySelectorAll('button'))b.disabled=pending||b!==refresh&&(!available||settled);if(pending)return;if(settled)return;if(!available)setStatus('原待办已结束或来源已变化；未发送的回答仍保留，不会交给其他会话。','stale');}
 update(todo);return {update};
}
