import './admin-agent.css';
import {setActionButton} from './ui-actions.mjs';

// One application-owned surface. No project identity, materials, or pane store.
export function mountAdminAgent({invoke,onOpenProject,document=window.document}) {
 const node=(tag,text,attrs={})=>{const n=document.createElement(tag);if(text)n.textContent=text;for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;};
 const dialog=node('dialog',null,{id:'admin-agent','aria-labelledby':'admin-agent-title'});
 const header=node('header',null,{class:'admin-head'}),title=node('h2','Nozeli 管理助手 · 全局上下文',{id:'admin-agent-title'});
 const close=node('button','返回工作区',{type:'button',id:'admin-close'});setActionButton(close,'close-view',{label:'返回工作区，保留管理会话',text:'返回工作区'});header.append(title,close);
 const scope=node('p','独立于所有项目 · 不读取项目材料 · 仅明确发送时调用模型',{class:'admin-scope'});
 const body=node('div',null,{class:'admin-body'}),intro=node('section',null,{class:'admin-intro'});
 intro.append(node('h3','先把 Nozeli 配置好，再开始工作。'),node('p','查看已登记项目、了解应用配置，或请管理助手准备默认模型变更。所有变更均需在此确认；不会授予系统管理员权限。'));
 const actions=node('div',null,{class:'admin-actions'});
 const button=(parent,label,id,run)=>{const b=node('button',label,{type:'button',...(id?{id}: {})});b.onclick=()=>void run().catch(report);parent.append(b);return b;};
 const error=node('p','',{id:'admin-error',role:'alert'}),notice=node('p','',{id:'admin-notice',role:'status','aria-live':'polite'});
 let state=null,localDraft='',dirty=false,edit=0,configDirty=false,working=false,submitting=false,timer=null,polling=false,disposed=false,queue=Promise.resolve(),saveFlight=null,returnFocus=null;
 let composing=false;
 const report=e=>{error.textContent=e?.message||String(e);};
 const serial=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
 const call=async(op,payload={})=>{const r=await invoke('admin.'+op,payload);if(!r?.ok)throw Object.assign(Error(r?.error?.message||'管理操作未完成'),{code:r?.error?.code});return r.value;};
 const settings=async section=>{const result=await serial(()=>call('openSettings',{section}));hide(false);window.dispatchEvent(new CustomEvent('nozeli-open-settings',{detail:result.section}));};
 button(actions,'AI 连接与账号','admin-open-provider',()=>settings('settings-provider'));
 button(actions,'默认模型设置','admin-open-defaults',()=>settings('settings-models'));
 button(actions,'刷新管理状态','admin-refresh',()=>refresh());intro.append(actions);
 const config=node('details',null,{id:'admin-config'});config.append(node('summary','管理助手模型与应用配置'));
 const modelForm=node('form',null,{id:'admin-model-form'}),model=node('select',null,{id:'admin-model','aria-label':'管理助手独立模型'}),effort=node('select',null,{id:'admin-effort','aria-label':'管理助手思考档位'});
 const field=(text,input)=>{const label=node('label',text);label.append(input);return label;};
 effort.append(node('option','原生默认',{value:''}));
 const saveModel=node('button','保存管理助手模型',{type:'submit',id:'admin-save-model'}),modelNote=node('p','仅影响管理助手；不会修改前台、主控或工作助手。',{id:'admin-model-note'});
 modelForm.append(field('独立模型',model),field('思考档位',effort),saveModel,modelNote);config.append(modelForm);
 const configView=node('div',null,{id:'admin-config-view'});config.append(configView);intro.append(config);
 const projects=node('details',null,{id:'admin-projects'}),projectList=node('div',null,{id:'admin-project-list'});projects.append(node('summary','已登记项目（只读）'),projectList);intro.append(projects);
 const proposals=node('section',null,{id:'admin-proposals','aria-label':'默认模型变更与执行结果'});
 const log=node('section',null,{id:'admin-messages','aria-label':'管理会话记录'});
 body.append(intro,proposals,log);
 const suggestions=node('section',null,{id:'admin-suggestions','aria-label':'管理助手建议的操作'});body.append(suggestions);
 const form=node('form',null,{class:'admin-compose',id:'admin-compose'}),input=node('textarea',null,{id:'admin-input',rows:'3','aria-label':'管理助手草稿',placeholder:'描述希望查看或调整的 Nozeli 配置…'});
 const footer=node('div',null,{class:'admin-compose-footer'}),draftNote=node('span','正在读取草稿…',{id:'admin-draft-status',role:'status'}),send=node('button','发送',{type:'submit',id:'admin-send'});
 const retry=button(footer,'重试保存草稿','admin-retry-draft',()=>saveDraft());retry.hidden=true;
 const cancel=button(footer,'停止生成','admin-cancel',()=>mutate('cancel',{}));cancel.hidden=true;
 footer.append(draftNote,send);form.append(input,footer);dialog.append(header,scope,body,error,notice,form);document.body.append(dialog);
 const signatures=new Map();
 function replace(key,parent,value,render){const signature=JSON.stringify(value);if(signatures.get(key)===signature)return;signatures.set(key,signature);parent.replaceChildren();render();}
 function projectRows(){for(const p of state.projects||[]){const row=node('article',null,{class:'admin-project'});row.append(node('strong',p.name),node('code',p.root));const b=button(row,p.available===false?'项目暂不可用':'打开项目',null,async()=>{const result=await serial(()=>call('openProject',{projectId:p.id}));await onOpenProject(result.projectId);hide();});b.dataset.adminOpenProject=p.id;b.disabled=p.available===false;projectList.append(row);}if(!projectList.childNodes.length)projectList.append(node('p','尚无已登记项目。'));}
 function receiptSummary(receipt){const saved=receipt.saved===true?'全局配置已保存':receipt.saved===false?'全局配置未保存':'保存结果未知，不会自动重放';const sync=receipt.modelSync;if(!sync)return saved+'；会话应用结果未报告。';return saved+'；会话已应用 '+(sync.applied??0)+'，等待当前回合结束 '+(sync.pending??0)+'，应用失败 '+(Array.isArray(sync.failed)?sync.failed.length:sync.failed??0)+'。';}
 function proposalRows(){for(const p of state.pendingChanges||[]){const card=node('article',null,{class:'admin-proposal','data-admin-proposal':p.id});card.append(node('h3','全局角色默认模型变更'),node('p','影响全局默认与同角色会话；项目覆盖保留。运行中会话可能延后应用。'));
 const comparison=node('div',null,{class:'admin-comparison'});for(const [label,value]of [['变更前',p.before],['变更后',p.after]]){const part=node('section');part.append(node('h4',label),node('pre',JSON.stringify(value,null,2)));comparison.append(part);}card.append(comparison,node('p','状态：'+p.status));
 if(p.status==='prepared'){const row=node('div',null,{class:'admin-actions'});const confirm=button(row,'确认并保存此变更',null,()=>mutate('confirm',{id:p.id,expectedVersion:p.expectedVersion}));confirm.dataset.adminConfirm=p.id;const dismiss=button(row,'放弃此变更',null,()=>mutate('dismiss',{id:p.id}));dismiss.dataset.adminDismiss=p.id;card.append(row);}
 if(p.receipt){card.append(node('h4','真实执行回执'),node('p',receiptSummary(p.receipt)),node('pre',JSON.stringify(p.receipt,null,2)));}proposals.append(card);}}
 function effortChoices(selected=''){const levels=state?.models?.find(m=>m.selector===model.value)?.thinking?.levels||[];const choices=[['','原生默认'],...levels.map(level=>[level,({off:'关闭',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'极高'})[level]||level])];if(selected&&!levels.includes(selected))choices.push([selected,selected+'（已存配置，当前目录未声明）']);replace('efforts',effort,choices,()=>{for(const [value,label]of choices)effort.append(node('option',label,{value}));});effort.value=selected;}
 function update(next){state=next;if(!dirty&&!submitting){localDraft=next.draft||'';if(input.value!==localDraft)input.value=localDraft;}
 replace('messages',log,next.messages||[],()=>{for(const m of next.messages||[]){const article=node('article',null,{class:'admin-message admin-message-'+m.role,'data-admin-message':m.id});article.append(node('small',m.role==='user'?'你':m.role==='assistant'?'管理助手':'系统'),node('p',m.text));log.append(article);}});
 replace('projects',projectList,next.projects||[],projectRows);replace('proposals',proposals,next.pendingChanges||[],proposalRows);
 replace('suggestions',suggestions,next.suggestions||[],()=>{for(const item of next.suggestions||[]){const row=node('article',null,{class:'admin-project','data-admin-suggestion':item.id});if(item.action==='openProject'){row.append(node('strong',item.name||'建议打开项目'),node('code',item.root||''));const b=button(row,'打开建议的项目',null,async()=>{const result=await serial(()=>call('openProject',{projectId:item.projectId}));await onOpenProject(result.projectId);hide();});b.dataset.adminSuggestedProject=item.projectId;}else if(item.action==='openSettings'){const labels={'settings-provider':'AI 连接与账号','settings-models':'默认模型','settings-appearance':'外观','settings-agents':'Agent 资源'};if(!labels[item.section])continue;button(row,'打开'+labels[item.section],null,()=>settings(item.section));}suggestions.append(row);}});
 if(!configDirty){const choices=[{selector:'',name:'未选择（发送前需配置）'},...(next.models||[])];replace('models',model,choices,()=>{for(const m of choices)model.append(node('option',m.name||m.selector,{value:m.selector}));});if(next.model&&!choices.some(m=>m.selector===next.model)&&!Array.from(model.children).some(o=>o.value===next.model))model.append(node('option',next.model+'（当前配置）',{value:next.model}));model.value=next.model||'';effortChoices(next.effort||'');}
 replace('config',configView,next.config||null,()=>{if(!next.config){configView.append(node('p','应用配置快照暂不可用，可打开默认模型设置查看。'));return;}configView.append(node('h4','全局角色默认（null 表示继承原生默认）'),node('pre',JSON.stringify(next.config.defaults,null,2)));for(const s of next.config.sources||[])configView.append(node('p',s.provider+' · '+(s.credential?.configured?'已配置凭据':'未配置凭据')+' · '+(s.credential?.kind||'无账号类型')+' · revision '+s.revision));if(next.config.modelSync)configView.append(node('h4','保存后的会话应用状态'),node('pre',JSON.stringify(next.config.modelSync,null,2)));});
 notice.textContent=[next.busy?'正在生成；关闭视图不会停止任务。':'',typeof next.notice==='string'?next.notice:'',typeof next.error==='string'?next.error:next.error?.message||''].filter(Boolean).join(' ');modelNote.textContent='仅影响管理助手；项目角色不变。配置 revision '+next.configRevision;controls();}
 function controls(){input.disabled=!state||submitting;send.disabled=!state||working||submitting||composing||state.busy||!state.model||!input.value.trim()||dirty&&Boolean(error.textContent);cancel.hidden=!state?.busy;cancel.disabled=working;model.disabled=effort.disabled=saveModel.disabled=!state||working||state.busy||submitting;for(const b of proposals.querySelectorAll('button'))b.disabled=working;draftNote.textContent=!state?'正在读取草稿…':dirty?'草稿尚未保存（保留在当前窗口）':'草稿已保存 · 不会自动发送';retry.hidden=!dirty||!error.textContent;}
 async function refresh(){return serial(async()=>{const next=await call('status');update(next);return next;});}
 async function mutate(op,payload){if(working)return;working=true;error.textContent='';controls();try{await serial(async()=>{const next=await call(op,payload);update(next);if(next.receipt){notice.textContent=receiptSummary(next.receipt);if(!(next.pendingChanges||[]).some(p=>p.receipt&&p.id===next.receipt.operationId)){const receipt=node('pre',JSON.stringify(next.receipt,null,2),{'data-admin-receipt':''});proposals.append(receipt);}}});}finally{working=false;controls();}}
 function saveDraft(){if(saveFlight)return saveFlight;if(!dirty||!state)return Promise.resolve();error.textContent='';saveFlight=serial(async()=>{while(dirty){const text=localDraft,version=edit;try{const next=await call('draft',{text,expectedRevision:state.draftRevision});if(edit===version)dirty=false;update(next);}catch(e){report(e);try{update(await call('status'));}catch{}throw e;}}}).finally(()=>{saveFlight=null;controls();});return saveFlight;}
 input.addEventListener('input',()=>{localDraft=input.value;dirty=true;edit++;controls();void saveDraft().catch(report);});
 input.addEventListener('compositionstart',()=>{composing=true;controls();});
 input.addEventListener('compositionend',()=>{composing=false;controls();});
 model.onchange=()=>{configDirty=true;effortChoices('');};effort.onchange=()=>{configDirty=true;};
 modelForm.onsubmit=event=>{event.preventDefault();if(working||state?.busy)return;void (async()=>{await mutate('configure',{model:model.value||null,effort:effort.value||null,expectedRevision:state.configRevision});configDirty=false;await refresh();})().catch(report);};
 form.onsubmit=event=>{event.preventDefault();if(send.disabled)return;void (async()=>{submitting=true;error.textContent='';controls();try{await saveDraft();const text=localDraft;await serial(async()=>{await call('send',{text,requestKey:crypto.randomUUID(),draftRevision:state.draftRevision});dirty=false;submitting=false;update(await call('status'));});}finally{submitting=false;controls();}})().catch(report);};
 input.onkeydown=event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.isComposing){event.preventDefault();form.requestSubmit();}};
 function stopPoll(){clearTimeout(timer);timer=null;}
 async function poll(){if(disposed||!dialog.open||polling)return;polling=true;try{await refresh();}catch(e){report(e);}finally{polling=false;if(dialog.open&&!disposed)timer=setTimeout(poll,state?.busy?900:3000);}}
 function hide(restore=true){stopPoll();if(dialog.open)dialog.close();if(restore&&returnFocus?.isConnected&&!returnFocus.closest('[inert]'))returnFocus.focus();}
 close.onclick=()=>hide();dialog.addEventListener('close',stopPoll);
 controls();
 function open(){if(disposed)return;if(dialog.open)return;returnFocus=document.activeElement;dialog.showModal();close.focus();stopPoll();void poll();}
 const openEvent=()=>open();window.addEventListener('nozeli-open-admin',openEvent);
 // The start page is replaced on project close. Observe only that host, not the
 // conversation DOM; opening remains the same application singleton.
 const home=document.getElementById('workspace-groups');
 const addHome=()=>{for(const row of home?.querySelectorAll('.guided-start-welcome .guided-start-actions')||[]){if(row.querySelector('[data-admin-start]'))continue;const b=button(row,'从管理助手开始',null,async()=>open());b.dataset.adminStart='';}};
 const observer=new MutationObserver(addHome);if(home)observer.observe(home,{childList:true,subtree:true});addHome();
 async function flush(){if(composing)return {ok:false,composing:true,error:{code:'COMPOSING',message:'管理助手输入法组合尚未结束，草稿未完成保存。'}};try{await saveDraft();await queue;if(dirty||submitting||working)return {ok:false,error:{code:'ADMIN_SAVE_PENDING',message:'管理助手操作或草稿保存尚未完成，请稍后重试。'}};return {ok:true};}catch(e){report(e);return {ok:false,error:{code:e.code||'ADMIN_DRAFT_SAVE_FAILED',message:'管理助手草稿未保存：'+e.message}};}}
 function dispose(){disposed=true;stopPoll();observer.disconnect();window.removeEventListener('nozeli-open-admin',openEvent);dialog.remove();}
 window.addEventListener('pagehide',dispose,{once:true});
 return {open,close:hide,dispose,flush,getState:()=>({dirty:Boolean(dirty||saveFlight||composing||submitting||working),blocked:Boolean(configDirty||dirty&&error.textContent)})};
}
