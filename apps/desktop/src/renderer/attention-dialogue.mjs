import {appendFrontdeskRouteContext} from './frontdesk-routes.mjs';
// Native answers stay bound to one source interaction, separate from conversation input.
export function mountAttentionDialogue(container,{document,projectId,todo,invoke,current,onRefresh,openSettings,recover,drafts,confirm:confirmDialog,meta={}}){
 const destination=todo.destination||{},question=destination.question,isRoute=destination.kind==='frontdesk-route',isPermission=destination.kind==='effect-permission',isGrantRevoke=destination.kind==='effect-grant',isMergeConsent=destination.kind==='merge-consent',isDecision=isRoute||isPermission||isGrantRevoke||isMergeConsent,attentionId=isRoute?destination.proposalId:destination.requestId??destination.grantId;
 const binding=entry=>{const d=entry?.destination||{},q=d.question||{};return JSON.stringify([projectId,entry?.id,d.target,d.ownerId,d.threadId,d.interactionId,...(['frontdesk-route','effect-permission','effect-grant','merge-consent'].includes(d.kind)?[d.kind,d.proposalId??d.requestId??d.grantId,d.expectedVersion,d.sourceJobId]:[]),...(d.kind==='effect-permission'?[q.command,q.args,q.cwd,q.elevation,q.effectHash]:[]),...(d.kind==='effect-grant'?[q.command,q.effectHash,q.grantedAt,q.expiresAt]:[]),...(d.kind==='merge-consent'?[q.effectHash,q.candidateCommit,q.reviewVersion,q.repo,q.targetRef]:[])]);};
 const identity=binding(todo);
 const storageKey='nozeli-attention:'+identity;
 let saved=drafts.get(identity);
 if(!saved){try{saved=JSON.parse(sessionStorage.getItem(storageKey)||'{}');}catch{saved={};}drafts.set(identity,saved);}
 let pending=false,latest=todo,phase='answering';
 const node=(tag,text)=>Object.assign(document.createElement(tag),text===undefined?{}:{textContent:text});
 const section=node('section');section.className='managed-attention-dialogue';section.setAttribute('aria-label','待办对话');
 section.dataset.attentionConversation=todo.id;
 if(isDecision){section.dataset.attentionKind=destination.kind;section.dataset.attentionId=attentionId;}
 // Compact header: the question title appears once; live status sits beside it; raw
 // identities collapse behind human names that are only shown when actually known.
 const header=node('header');header.className='managed-attention-header';header.dataset.attentionHeader='';
 const heading=node('h2',isRoute?'处理方式决定':isPermission?'提权/敏感执行授权':isGrantRevoke?'任务执行授权（可撤销）':isMergeConsent?'一次性本地合入批准':question?.method==='askDialog'?'待回答':(question?.title||todo.title||'待办对话'));heading.dataset.attentionTitle='';
 const status=node('p');status.dataset.attentionStatus='';status.setAttribute('role','status');
 const names=[meta.projectName,meta.sourceName].filter(value=>typeof value==='string'&&value.trim());
 header.append(heading);
 if(names.length){const line=node('p','来源 '+names.join(' · '));line.className='managed-attention-names';line.dataset.attentionNames='';header.append(line);}
 header.append(status);
 const source=node('details');source.dataset.attentionSource='';
 const ids=['项目 '+projectId,'待办 '+todo.id,destination.target?'会话 '+destination.target:null,destination.ownerId?'所有者 '+destination.ownerId:null,destination.threadId?'线程 '+destination.threadId:null,destination.interactionId?'交互 '+destination.interactionId:null,isDecision?'决定 '+attentionId:null,isDecision?'版本 '+destination.expectedVersion:null,isDecision?'来源请求 '+destination.sourceJobId:null].filter(Boolean).join(' · ');
 const idsLine=node('p',ids);idsLine.className='managed-attention-ids';
 source.append(node('summary','来源详情'),idsLine);header.append(source);
 const explanation=node('p');explanation.className='managed-attention-explanation';
 explanation.textContent=isDecision?'':destination.kind==='conversation'&&question?[question.detail].filter(value=>typeof value==='string'&&value).join('\n'):(todo.text||'');
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
 if(isRoute){
  allowCancel=false;
  appendFrontdeskRouteContext(fields,{document,route:question||{}});
  const options=[{label:'送到后台',action:'background',description:'只继续原任务尚未完成的动作，不扩大授权范围。'},{label:'继续前台',action:'continue',description:'在前台已有能力范围内继续；不增加 shell 或其他权限。'},{label:'暂不继续',action:'cancel',description:'暂停本请求，保留已完成修改，不自动重试。'}];
  const read=choice('route','请选择处理方式',options);
  for(const input of fields.querySelectorAll('input')){const option=options.find(option=>option.label===input.value);if(option)input.dataset.attentionRouteAction=option.action;}
  readAnswer=()=>{const option=options.find(option=>option.label===read());if(!option)throw Error('请明确选择处理方式。');return option.action;};
 }else if(isPermission){
  allowCancel=false;
  const detail=(key,label,text)=>{const block=node('section');block.dataset.attentionPermissionDetail=key;block.append(node('h3',label),node('p',text||'未提供'));fields.append(block);};
  detail('original','原任务',question?.originalText);
  const args=(Array.isArray(question?.args)?question.args:[]).map(value=>JSON.stringify(String(value))).join(' ');
  detail('command','将执行的命令',(question?.elevation==='admin'?'[提权 root/管理员] ':'[当前用户·敏感] ')+String(question?.command??'')+' '+args);
  detail('cwd','工作目录',question?.cwd);
  detail('purpose','申请原因',question?.purpose);
  detail('risk','范围与风险',question?.risk);
  if(question?.remainingActions)detail('remaining','批准后继续的剩余动作',question.remainingActions);
  if(question?.completedOperations?.length){const receipts=node('details');receipts.dataset.attentionPermissionDetail='receipts';receipts.append(node('summary','已完成操作回执（保留，不重放）'),node('pre',JSON.stringify(question.completedOperations,null,2)));fields.append(receipts);}
  const hash=node('details');hash.dataset.attentionPermissionDetail='hash';hash.append(node('summary','冻结效果哈希（防篡改绑定）'),node('pre',String(question?.effectHash??'')));fields.append(hash);
  const elevated=question?.elevation==='admin';
  paragraph('单次授权仅执行上方冻结命令一次；本任务授权仅允许原任务再次执行完全相同的冻结命令，不覆盖其他命令、参数或工作目录。可随时撤销，重启后失效。');
  paragraph(elevated?'root/管理员具有系统最高权限；工作目录检查不是文件访问沙箱，命令参数仍可影响目录以外乃至全盘，不能保证可回滚。系统认证仍逐次交给操作系统。':'当前用户范围执行；仍按显式批准执行并留回执，不扩大到其他任务。');
  paragraph('批准前零执行；拒绝或暂不授权不自动重试。系统认证（pkexec/UAC/系统授权）取消或失败不会伪造成功；执行结果未知时不自动重放。');
  // The host normalized and validated the frozen DTO (OS-absolute cwd per
  // platform); the renderer only checks shape, never POSIX-only patterns that
  // would strand Windows paths without authorization controls.
  const valid=typeof question?.command==='string'&&question.command.trim()&&typeof question?.cwd==='string'&&question.cwd.trim()&&typeof question?.effectHash==='string'&&/^[a-f0-9]{64}$/.test(question.effectHash)&&Array.isArray(question.args)&&question.args.every(v=>typeof v==='string');
  if(valid){
   const options=[{label:'仅允许执行这一次',action:'approve-once',description:'执行上方冻结命令一次；之后需重新申请。'},{label:'本任务内允许该冻结命令',action:'approve-task',description:'仅原任务可再次执行完全相同的冻结命令、参数和工作目录；不覆盖其他管理命令。撤销、到期、任务结束或重启后失效；提权仍需真实系统认证。'},{label:'拒绝此执行',action:'deny',description:'不执行该命令，不自动重试；继续原范围内其他工作需模型自行安排。'},{label:'暂不授权',action:'cancel',description:'暂停本次申请，保留现有进度；之后可重新申请。'}];
   const read=choice('permission',(elevated?'请选择提权执行授权决定':'请选择敏感执行授权决定'),options);
   for(const input of fields.querySelectorAll('input')){const option=options.find(option=>option.label===input.value);if(option)input.dataset.attentionPermissionAction=option.action;}
   readAnswer=()=>{const option=options.find(option=>option.label===read());if(!option)throw Error('请明确选择授权决定。');return option.action;};
  }else paragraph('请求未提供可核对的命令、工作目录或冻结哈希；请刷新核对，不会默认授权。');
 }else if(isGrantRevoke){
  allowCancel=false;
  const detail=(key,label,text)=>{const block=node('section');block.dataset.attentionPermissionDetail=key;block.append(node('h3',label),node('p',text||'未提供'));fields.append(block);};
  detail('command','已授权的冻结命令',String(question?.command??''));
  detail('cwd','工作目录',question?.cwd);
  detail('window','授权窗口','自 '+String(question?.grantedAt??'')+(question?.expiresAt?' 至 '+question.expiresAt:'（无固定到期，任务结束或重启失效）'));
  paragraph('撤销仅关闭未来准入，不承诺逆转已执行的命令效果；结果未知的执行仍需单独核对。');
  const options=[{label:'撤销本任务的执行授权',action:'revoke',description:'之后同一冻结命令需重新申请；已执行效果不受影响。'},{label:'保留授权',action:'keep',description:'不撤销；此待办可稍后再看。'}];
  const read=choice('grant','请选择',options);
  for(const input of fields.querySelectorAll('input')){const option=options.find(option=>option.label===input.value);if(option)input.dataset.attentionGrantAction=option.action;}
  readAnswer=()=>{const option=options.find(option=>option.label===read());if(!option)throw Error('请明确选择。');if(option.action==='keep'){phase='cancelled';throw Error('已选择保留授权；未提交任何决定，可关闭此视图。');}return option.action;};
 }else if(isMergeConsent){
  allowCancel=false;
  const detail=(key,label,text)=>{const block=node('section');block.dataset.attentionPermissionDetail=key;block.append(node('h3',label),node('p',text||'未提供'));fields.append(block);};
  detail('candidate','将合入的候选提交',String(question?.candidateCommit??''));
  detail('review','人工审校版本',question?.reviewVersion==null?'未绑定':String(question.reviewVersion));
  detail('repo','仓库 / 目标分支',[question?.repo,question?.targetRef].filter(Boolean).join(' · ')||'未提供');
  const hash=node('details');hash.dataset.attentionPermissionDetail='hash';hash.append(node('summary','冻结授权哈希（防篡改绑定）'),node('pre',String(question?.effectHash??'')));fields.append(hash);
  paragraph(question?.note||'仅授权把已审校候选提交到原仓库目标分支。');
  paragraph('此批准只涉及本地 Git 合入，不是提权/root 执行授权；批准后宿主按原队列继续合入，不重放 Worker、不改写原请求。拒绝则保持阻断并保留现场。与提权/敏感执行授权是不同类别的待办，不会因本批准获得任何系统权限。');
  const valid=typeof question?.candidateCommit==='string'&&question.candidateCommit.trim()&&typeof question?.effectHash==='string'&&/^[a-f0-9]{64}$/.test(question.effectHash)&&question?.binding&&typeof question.binding==='object'&&typeof destination.requestId==='string'&&Number.isSafeInteger(destination.expectedVersion);
  if(valid){
   const options=[{label:'仅此一次：批准该候选本地合入',action:'approve',description:'绑定当前候选、审校版本、仓库与目标分支；批准一次，按原队列合入。'},{label:'拒绝本次合入',action:'deny',description:'保持 MERGE_CONSENT_DENIED 阻断；成果与资源保留，可稍后重新处理。'}];
   const read=choice('mergeConsent','请选择合入批准决定',options);
   for(const input of fields.querySelectorAll('input')){const option=options.find(option=>option.label===input.value);if(option)input.dataset.attentionMergeConsentAction=option.action;}
   readAnswer=()=>{const option=options.find(option=>option.label===read());if(!option)throw Error('请明确选择合入批准决定。');return option.action;};
  }else paragraph('待办缺少可核对的候选提交、请求版本或绑定身份；请刷新核对，不会默认授权。');
 }else if(destination.kind==='conversation'&&question){
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
   const read=choice('approval','授权决定',options);readAnswer=()=>{const label=read(),selected=label===undefined?null:options.find(option=>option.label===label);if(!selected)throw Error('请选择授权决定。');return selected.value;};
  }else if(method==='plan'&&Array.isArray(question.options)){
   allowCancel=false;if(question.planContent){const pre=node('pre',question.planContent);fields.append(pre);}if(question.planFilePath)paragraph(question.planFilePath);
   const options=question.options.filter(option=>!option.disabled&&['execute','compact','keep','refine','save'].includes(option.id));const read=choice('plan','计划决定',options),feedback=collapsible('feedback','反馈（可选；选择“细化计划”时必填）',{multiline:true});
   const tiers=question.tiers||[],role=tiers.length?choice('role','执行角色（可选）',tiers.map(tier=>({label:[tier.role,tier.provider,tier.model,tier.thinkingLevel].filter(Boolean).join(' · ')}))):null;
   readAnswer=()=>{const label=read(),selected=label===undefined?null:options.find(option=>option.label===label);if(!selected)throw Error('请选择计划操作。');if(selected.id==='refine'&&!feedback.value.trim())throw Error('细化计划需要填写反馈。');const tier=role?tiers.find(tier=>[tier.role,tier.provider,tier.model,tier.thinkingLevel].filter(Boolean).join(' · ')===role()):null;return {choice:selected.id,...(feedback.value?{feedback:feedback.value}:{}),...(tier&&['execute','compact','keep'].includes(selected.id)?{role:tier.role}:{})};};paragraph('原生计划界面不支持取消；只有明确提交所选操作才会响应。');
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
 const same=()=>current()&&latest?.status==='open'&&binding(latest)===identity;
 async function respond(answer,cancel=false){
 if(pending||!same())throw Error('来源待办或会话已变化；答案草稿保留，请重新核对。');if(phase!=='answering')throw Error('本次请求已处理，不再重复提交；请刷新核对。');pending=true;fields.disabled=true;for(const b of actions.querySelectorAll('button'))b.disabled=true;section.setAttribute('aria-busy','true');setStatus(isDecision?'正在提交决定…':cancel?'正在向原生会话发送取消…':'正在提交给原生会话…','busy');
 try{
  const payload=isMergeConsent?{projectId,workId:destination.workId,requestId:destination.requestId,expectedVersion:destination.expectedVersion,decision:answer,requestKey:'attention:'+destination.requestId+':'+destination.expectedVersion+':'+answer,binding:question.binding}:isDecision?{projectId,attentionKind:destination.kind,attentionId,expectedVersion:destination.expectedVersion,action:answer,sourceJobId:destination.sourceJobId,requestKey:'attention:'+attentionId+':'+destination.expectedVersion+':'+answer}:{projectId,todoId:todo.id,answer,...(cancel?{cancel:true}:{})};
  const result=await invoke(isMergeConsent?'managed.merge.consent':'managed.attention.respond',payload);if(!result.ok)throw Object.assign(Error(result.error?.message||'回答未受理'),{code:result.error?.code});if(isDecision&&result.value?.accepted!==true&&!(isMergeConsent&&result.value?.status))throw Error('宿主尚未确认本次决定。');
  phase=cancel||isDecision&&['cancel','deny'].includes(answer)?'cancelled':'submitted';
  setStatus(isMergeConsent?(answer==='approve'?'已批准该候选的一次性本地合入；宿主按原队列继续，不重放 Worker。此批准不涉及任何提权执行。':'已拒绝本次合入；保持阻断并保留现场，未执行合入。'):isPermission?(answer==='approve-once'?'已批准执行一次；宿主将以真实系统认证执行该冻结命令，不扩大到其他命令或新任务。':answer==='approve-task'?'已批准本任务内该冻结命令；可再次执行同一条命令，随时可撤销，不覆盖未来命令。':'本次执行未授权；不执行该命令，不自动重试。'):isGrantRevoke?(answer==='revoke'?'已撤销本任务的执行授权；未来准入关闭，已执行效果不受影响。':'已保留授权；未提交撤销。'):isRoute?(answer==='cancel'?'已暂停本请求；保留已完成修改，不自动重试。':'处理方式决定已受理；只继续原范围剩余工作。'):cancel?'已向原生会话发送取消，本次请求已中断。':'回答已提交给原生会话。','ok');
  drafts.delete(identity);try{sessionStorage.removeItem(storageKey);}catch{}try{await onRefresh();}catch{status.textContent+=' 状态刷新失败，可点击“刷新状态”重试。';}
 }
  catch(error){setStatus((error.code?error.code+'：':'')+error.message+'；未提交草稿保留。','error');}
  finally{pending=false;section.setAttribute('aria-busy','false');update(latest);}
 }
 if(readAnswer){const submit=node('button',isRoute?'提交处理方式':isPermission?'提交授权决定':'提交回答');submit.type='submit';submit.className='ui-action';submit.dataset.uiAction='primary';submit.dataset.attentionSubmit='';actions.append(submit);}
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
 setStatus(isRoute?'等待明确选择；此决定不授予额外安全权限。':isPermission?'请逐字核对待执行命令、参数与工作目录后明确决定；批准前零执行，没有默认授权。':isGrantRevoke?'此授权生效中；可撤销未来准入或保留。':isMergeConsent?'请核对候选提交与审校版本后明确决定；这是本地 Git 合入授权，不是提权执行授权。':destination.kind==='conversation'?(readAnswer?'等待明确回答；选择或输入不会自动提交。':'此原生交互不支持在工作区结构化回答。'):destination.kind==='native-draft'?'先读取来源原生草稿，再明确保存；不会自动发送。':destination.kind==='settings'?'打开相关设置完成配置后刷新核对。':destination.kind==='connection'?'查看并恢复原会话后刷新核对。':destination.kind==='terminal'?'原生会话被外部占用；等待释放后刷新核对。':'请核对来源状态后刷新。');
 function update(next){latest=next;const available=same(),settled=phase!=='answering';fields.disabled=pending||!available||settled;for(const b of actions.querySelectorAll('button'))b.disabled=pending||b!==refresh&&(!available||settled);if(pending)return;if(settled)return;if(!available)setStatus('原待办已结束或来源已变化；未发送的回答仍保留，不会交给其他会话。','stale');}
 update(todo);return {update};
}
