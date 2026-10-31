export function mountProviderSettings({invoke,providers=document.getElementById('settings-provider'),models=document.getElementById('settings-models')}) {
 const call=async(op,payload={})=>{const response=await invoke(op,payload);if(response?.ok===false)throw Error(response.error?.message||'设置操作未完成');return response?.ok===true?response.value:response;};
 const node=(tag,text,attrs={})=>{const el=document.createElement(tag);if(text)el.textContent=text;for(const [key,value]of Object.entries(attrs))el.setAttribute(key,value);return el;};
 const field=(form,label,name,type='text',value='')=>{const wrap=node('label',label),input=node('input',null,{name,type,autocomplete:'off'});input.value=value;wrap.append(input);form.append(wrap);return input;};
 const message=node('p','',{role:'status','aria-live':'polite','data-provider-status':''});
 const modelMessage=node('p','',{role:'status','aria-live':'polite','data-model-status':''});models.append(modelMessage);
 const parseModelLines=value=>String(value??'').split(/[\n,]+/).map(line=>line.trim()).filter(Boolean).map(line=>{
  const thinking=/\s*\[thinking\]\s*$/.test(line);
  const id=line.replace(/\s*\[thinking\]\s*$/,'').trim();
  return {id,...(thinking?{reasoning:true}:{})};
 });
 const list=node('div',null,{'data-provider-list':''}),loginArea=node('div',null,{'data-provider-login':''});
 providers.append(node('h2','账号与 API 源'),node('p','管理 Nozeli 私有 Pi 账号与 API 源。密钥仅存于本机私有配置和认证存储，不会回传界面；留空保存即保留已存密钥。目录或凭据状态不代表服务端授权任何模型。'),list);
 const form=node('form',null,{'data-provider-api-form':''});
 const providerField=field(form,'源 ID（不可改名；改名需新增源）','provider');
 const baseUrlField=field(form,'API 地址（base URL）','baseUrl','url');
 const modelLines=node('textarea','',{name:'models',rows:'4','data-provider-models':'',placeholder:'每行一个模型ID；声明支持思考的模型在行尾加 [thinking]'});
 const modelsWrap=node('label','模型ID（每行一个，可多个；[thinking] 声明该模型支持思考）');modelsWrap.append(modelLines);form.append(modelsWrap);
 const protocol=node('label','API协议'),api=node('select',null,{name:'api'});for(const value of ['openai-completions','openai-responses','anthropic-messages']){const opt=node('option',value,{value});api.append(opt);}protocol.append(api);form.append(protocol);
 const key=field(form,'API密钥（编辑时留空＝保留已存密钥）','key','password');key.placeholder='新增必填；编辑留空保留原密钥，输入则替换';
 const originConsent=node('label','API地址来源变化时复用原密钥');const originConsentBox=node('input',null,{type:'checkbox',name:'confirmNewOrigin'});originConsent.prepend(originConsentBox);form.append(originConsent);originConsent.hidden=true;
 const submitButton=node('button','添加API源',{type:'submit',class:'ui-action','data-ui-action':'primary'});
 const cancelEdit=node('button','取消编辑',{type:'button','data-provider-cancel-edit':''});cancelEdit.hidden=true;
 const draftDiscover=node('button','先测试发现（不保存）',{type:'button','data-provider-draft-discover':''});form.append(draftDiscover);
 form.append(submitButton,cancelEdit);providers.append(form);
 const loginForm=node('form',null,{'data-provider-login-form':''}),loginLabel=node('label','选择Pi支持的账号源'),loginProvider=node('select',null,{name:'provider','data-login-provider':'',required:''}),loginStart=node('button','登录 / 激活所选源',{type:'submit'});
 loginProvider.append(node('option','请选择账号源',{value:''}));loginLabel.append(loginProvider);loginForm.append(node('h3','账号登录'),loginLabel,loginStart);providers.append(loginForm,loginArea,message);
 providers.insertBefore(loginForm,form);providers.insertBefore(loginArea,form);loginStart.disabled=true;
 const discoveryArea=node('div',null,{'data-provider-discovery':''});providers.append(discoveryArea);
 const refreshButton=node('button','刷新源和模型',{type:'button','data-provider-refresh':''});providers.append(refreshButton);
 providers.append(node('p','模型目录刷新不发送对话或模型请求；“发现模型”只调用该源的模型列表接口，不发起对话，也不证明推理授权。'));
 models.append(node('h2','默认模型'),node('p','为前台、主控和 Worker 分别配置默认模型与思考档位。保存后同步同角色在线会话；执行中的回合结束后应用，休眠会话恢复时应用。清除选择即恢复会话原生默认并取消排队中的切换。'));
 const modelForm=node('form',null,{'data-role-model-form':''}),selects={},thinkingSelects={};
 for(const [role,label]of [['frontdesk','前台 · 最快'],['orchestrator','编排 · 强模型'],['worker','Worker · 中等及以上']]){
  const wrap=node('label',label),select=node('select',null,{'data-default-role':role,name:role});selects[role]=select;wrap.append(select);
  const thinkWrap=node('label',label.split(' · ')[0]+' · 思考档位'),think=node('select',null,{'data-default-thinking':role,name:role+'-thinking'});thinkingSelects[role]=think;thinkWrap.append(think);
  modelForm.append(wrap,thinkWrap);
 }
 modelForm.append(node('button','保存三角色默认',{type:'submit',class:'ui-action','data-ui-action':'primary'}));models.append(modelForm);
 const catalogMessage=node('p','正在读取目录模型…',{role:'status','aria-live':'polite','data-model-catalog-status':''});
 const modelRefresh=node('button','刷新模型列表',{type:'button','data-model-refresh':''}),configureSource=node('button','配置 Pi 源',{type:'button','data-model-configure-source':''});
 const modelActions=node('div',null,{class:'settings-actions'});modelActions.append(modelRefresh,configureSource);modelForm.before(catalogMessage,modelActions);
 const modelSave=modelForm.querySelector('button[type="submit"]');let catalogReady=false,refreshFlight=null,editing=null,lastSources=[],lastCatalog=[],storedDefaultsExist=false;
 for(const select of Object.values(selects)){select.disabled=true;select.append(node('option','正在读取模型…',{value:''}));}modelSave.disabled=true;
 for(const think of Object.values(thinkingSelects)){think.disabled=true;think.append(node('option','正在读取…',{value:''}));}
 configureSource.onclick=()=>window.dispatchEvent(new CustomEvent('nozeli-open-settings',{detail:'settings-provider'}));
 let polling=null,loginId=null,busy=false;
 const report=error=>{message.textContent=error?.message||'操作未完成。';modelMessage.textContent=message.textContent;};
 // Read-DTO -> write-DTO: only allowlisted fields; unknown/null capability values are omitted, never forwarded to settings.providers.save.
 const writeModel=m=>({id:m.id,...(text200(m.name)?{name:m.name}:{}),...(m.reasoning===true?{reasoning:true}:{})});
 const text200=v=>typeof v==='string'&&v.trim()&&v.length<=200&&v.trim()===v?v:null;
 const formatModelLines=modelsList=>(modelsList??[]).map(m=>m.id+(m.reasoning===true?' [thinking]':'')).join('\n');
 function renderSync(sync,{saved=false}={}){
  if(!sync){if(saved)modelMessage.textContent='默认模型已保存。';return;}
  const parts=[saved?'默认模型已保存。':''];
  if(sync.applied)parts.push(`已切换 ${sync.applied} 个 Agent。`);
  if(sync.pending)parts.push(`${sync.pending} 个 Agent 待当前回合结束后切换。`);
  if(sync.failed?.length)parts.push(`${sync.failed.length} 个 Agent 切换未完成：`+sync.failed.map(item=>item.message||'请检查源配置后重新保存。').join('；'));
  const details=(sync.sessions??[]).filter(row=>row.state&&row.state!=='unchanged').map(row=>{
   const name=row.target==='frontdesk'?'前台':row.target==='orchestrator'?'主控':'Worker '+(row.target.slice(0,6));
   const desired=row.desired?.model?row.desired.model+(row.desired.effort?'·'+row.desired.effort:''):'原生默认';
   const effective=row.effective?.model?`${row.effective.model}${row.effective.effort?'·'+row.effective.effort:''}`:'未配置';
   return `${name}→${desired}（当前生效 ${effective}，${row.state==='applied'?'已应用':row.state==='pending'?'待回合结束':row.state==='failed'?'失败':'未变化'}${row.clamped?`，原生收窄为 ${row.clamped.effective}`:''}）`;
  });
  if(details.length)parts.push(details.join('；')+'。');
  if(saved&&!sync.applied&&!sync.pending&&!sync.failed?.length&&!details.length)parts.push('休眠及尚未启动的 Agent 将在恢复时应用。');
  modelMessage.textContent=parts.join('');
 }
 function syncModelControls(){const disabled=busy||!catalogReady;for(const select of Object.values(selects))if(select.disabled!==disabled)select.disabled=disabled;modelSave.disabled=busy||(!catalogReady&&!storedDefaultsExist);modelRefresh.disabled=refreshButton.disabled=busy||!!refreshFlight;for(const think of Object.values(thinkingSelects))think.disabled=busy;}
 async function run(action){if(busy)return;busy=true;for(const b of [...providers.querySelectorAll('button'),...models.querySelectorAll('button')])b.disabled=true;syncModelControls();try{await refreshFlight;await action();}catch(e){report(e);}finally{busy=false;for(const b of [...providers.querySelectorAll('button'),...models.querySelectorAll('button')])b.disabled=false;syncModelControls();loginStart.disabled=!loginProvider.value||loginProvider.disabled;}}
 function renderLogin(login){
  const draft=loginArea.querySelector('input')?.value||'';
  loginArea.replaceChildren();loginId=login?.id??null;if(!login)return;
  const states={running:'等待授权',complete:'登录完成',failed:'登录未完成',cancelled:'已取消',expired:'已过期'};
  loginArea.append(node('p',(login.name||login.provider||'Pi')+' · '+(states[login.state]||login.state)),node('pre',login.output||'请按所选源的官方流程继续。',{'data-login-output':''}));
  if(login.state==='running'){
   const inputForm=node('form',null,{'data-login-input-form':''});const input=field(inputForm,'授权流程要求的验证码或回调地址','text');input.value=draft;
   inputForm.append(node('button','提交登录输入',{type:'submit'}));inputForm.addEventListener('submit',event=>{event.preventDefault();const text=input.value;input.value='';run(()=>call('settings.login.input',{id:loginId,text}));});
   const cancel=node('button','取消登录',{type:'button','data-login-cancel':''});cancel.onclick=()=>run(async()=>renderLogin(await call('settings.login.cancel',{id:loginId})));loginArea.append(inputForm,cancel);
  }else{clearInterval(polling);polling=null;}
 }
 async function refreshLoginProviders(){
  const selected=loginProvider.value;loginProvider.disabled=loginStart.disabled=true;
  try{const providers=await call('settings.login.providers');loginProvider.replaceChildren(node('option','请选择账号源',{value:''}));for(const p of providers)loginProvider.append(node('option',p.name,{value:p.id}));if(providers.some(p=>p.id===selected))loginProvider.value=selected;loginProvider.disabled=false;loginStart.disabled=busy||!loginProvider.value;}
  catch(error){loginProvider.replaceChildren(node('option','登录源目录暂不可用，请刷新',{value:''}));report(error);}
 }
 loginProvider.addEventListener('change',()=>{loginStart.disabled=busy||!loginProvider.value;});
 const pendingChoices=new Map();
 function renderModelChoices(select,available,savedDefault){
  // Do not replace options underneath an open native picker or keyboard editing.
  if(available.length&&!busy&&document.activeElement===select){pendingChoices.set(select,{available,savedDefault});return;}
  pendingChoices.delete(select);
  const selected=select.dataset.dirty==='true'?select.value:savedDefault;
  const choices=[['','会话原生默认（清除全局覆盖）'],...available.map(model=>[model.selector,`${model.name||model.id||model.selector} · ${model.provider} · ${model.catalogSource==='configured'?'手动配置':model.credentialConfigured?'内置目录（凭据已配置）':'内置目录'}${model.thinking?.supported===true?' · 支持思考':''}`])];
  if(selected&&selected!==''&&!available.some(model=>model.selector===selected))choices.push([selected,selected+'（当前目录不可见，保留原设置；不可重新选择）','disabled']);
  if(select.options.length!==choices.length||choices.some(([value,text],index)=>select.options[index].value!==value||select.options[index].textContent!==text)){
   select.replaceChildren(...choices.map(([value,text,disabled])=>{const option=node('option',text,{value});if(disabled)option.disabled=true;return option;}));
  }
  if(select.value!==selected)select.value=selected;
 }
 // Thinking options are model-bound: only the natively reported levels of the
 // selected model are offered; unknown capability is labeled explicitly and
 // never presented as a tier list.
 function renderThinkingChoices(think,savedLevel,levels){
  const selected=think.dataset.dirty==='true'?think.value:savedLevel;
  const known=Array.isArray(levels)&&levels.length;
  const choices=[['',known?'会话原生默认':'会话原生默认（此模型档位未知，保存后以原生生效为准）'],...(known?levels.map(level=>[level,level+'（原生档位）']):[])];
  if(selected&&selected!==''&&!choices.some(([value])=>value===selected))choices.push([selected,selected+'（当前选择模型未列出该档位，保留原设置；不可重新选择）','disabled']);
  if(think.options.length!==choices.length||choices.some(([value,text],index)=>think.options[index].value!==value||think.options[index].textContent!==text))think.replaceChildren(...choices.map(([value,text,disabled])=>{const option=node('option',text,{value});if(disabled)option.disabled=true;return option;}));
  if(think.value!==selected)think.value=selected;
 }
 function flushModelChoices(select){const pending=pendingChoices.get(select);if(!pending)return;renderModelChoices(select,pending.available,pending.savedDefault);const think=thinkingSelects[select.dataset.defaultRole];if(think)renderThinkingChoices(think,think.value,lastCatalog.find(model=>model.selector===select.value)?.thinking?.levels??null);}
 function startEdit(source){
  editing=source;providerField.value=source.provider;providerField.readOnly=true;baseUrlField.value=source.baseUrl||'';api.value=source.api||'openai-completions';
  modelLines.value=formatModelLines(source.models);key.value='';originConsentBox.checked=false;originConsent.hidden=true;consentBinding='';updateOriginConsent();submitButton.textContent='保存修改（留空密钥＝保留）';cancelEdit.hidden=false;
  message.textContent='正在编辑 '+source.provider+'；密钥不回显，留空保存即保留原密钥。';
 }
 function clearEdit(){editing=null;providerField.value='';providerField.readOnly=false;baseUrlField.value='';modelLines.value='';key.value='';api.value='openai-completions';originConsent.hidden=true;originConsentBox.checked=false;consentBinding='';submitButton.textContent='添加API源';cancelEdit.hidden=true;}
 cancelEdit.onclick=()=>{clearEdit();message.textContent='';};
 function renderDiscovery(source){
  discoveryArea.replaceChildren();
  const state=source.discovery;
  if(!state||state.status==='none')return;
  const title={succeeded:'服务端模型列表（实际返回，仅证明可列出）',stale:'上次服务端列表（已过期，可能因源修改或最近失败）',unsupported:'此源端点不支持模型列表查询',failed:'模型列表请求失败'}[state.status]||'模型列表';
  const box=node('div',null,{'data-discovery-box':source.provider});
  box.append(node('h3',source.provider+' · '+title));
  if(state.fetchedAt)box.append(node('p','获取时间 '+state.fetchedAt+(state.error?` · ${state.error.code}`:'')));
  if(state.error?.message)box.append(node('p','未回传服务端原文；可检查密钥或地址后重试。'));
  const rows=state.models??[];
  if(rows.length){
   const listNode=node('ul',null,{'data-discovery-models':source.provider});
   for(const row of rows)listNode.append(node('li',row.id+(row.name&&row.name!==row.id?' · '+row.name:'')+' · 服务返回，不代表推理授权'));
   box.append(listNode);
   const add=node('button','把服务返回的模型加入此源',{type:'button','data-discovery-add':source.provider});
   add.onclick=()=>run(async()=>{
    const fresh=lastSources.find(row=>row.provider===source.provider);
    if(!fresh)throw Error('源信息已变化，请刷新后重试。');
    const existing=new Map((fresh.models??[]).map(m=>[m.id,writeModel(m)]));
    for(const row of rows)if(!existing.has(row.id))existing.set(row.id,writeModel(row));
    await call('settings.providers.save',{operation:'update',provider:fresh.provider,expectedRevision:fresh.revision,baseUrl:fresh.baseUrl,api:fresh.api||'openai-completions',credential:{action:'keep'},models:[...existing.values()]});
    await refreshAfterChange();message.textContent='已把服务返回的模型加入 '+fresh.provider+'；手动配置与服务返回都会标注来源，不宣称授权。';
   });
   box.append(add);
  }
  discoveryArea.append(box);
 }
 async function refresh(duringAction=false){if(refreshFlight)return refreshFlight;if(busy&&!duringAction)return;
  modelRefresh.disabled=refreshButton.disabled=true;catalogMessage.textContent=catalogReady?'正在刷新模型目录；现有目录和选择保留。':'正在读取目录模型…';
  refreshFlight=(async()=>{try{
   const value=await call('settings.providers.status');list.replaceChildren();
   lastSources=value.sources??[];
   if(!value.sources?.length)list.append(node('p','尚无已配置账号或 API 源。请登录或添加 API 源。'));
   for(const source of value.sources??[]){
    const row=node('div',null,{'data-provider-row':source.provider});
    const modelNote=(source.models?.length??0)?` · ${source.models.length} 个模型（手动配置）`:'';
    row.append(node('strong',source.provider),node('span',' · '+(source.type==='oauth'?'账号登录':'API')+(source.credential?.configured?' · 凭据已配置':' · 未配置凭据')+(source.baseUrl?' · '+source.baseUrl:'')+modelNote+(source.revision?` · 修订 ${source.revision}`:'')));
    const edit=node('button','编辑',{type:'button','data-provider-edit':source.provider});
    edit.disabled=busy;
    edit.onclick=()=>{startEdit(source);};
    const discover=node('button','发现模型',{type:'button','data-provider-discover':source.provider});
    discover.disabled=busy;
    discover.onclick=()=>run(async()=>{
     discoveryArea.replaceChildren(node('p','正在向 '+source.provider+' 的模型列表接口发起有界请求…'));
     try{const result=await call('settings.providers.discover',{provider:source.provider,expectedRevision:source.revision});renderDiscovery({...source,discovery:{status:result.status,fetchedAt:result.fetchedAt,models:result.models,error:result.error}});}
     catch(error){discoveryArea.replaceChildren();report(error);}
    });
    const remove=node('button','移除',{type:'button','data-ui-action':'danger','data-provider-remove':source.provider});
    remove.disabled=busy;
    remove.onclick=()=>{remove.disabled=true;row.append(node('p','确认移除 '+source.provider+'？将禁用其私有凭据；仍有会话引用时会拒绝。'));const confirm=node('button','确认移除 '+source.provider,{type:'button','data-ui-action':'danger','data-provider-confirm-remove':source.provider});confirm.onclick=()=>run(async()=>{await call('settings.providers.remove',{provider:source.provider,confirm:source.provider});await refreshAfterChange();message.textContent='已移除源。';});const cancel=node('button','取消',{type:'button'});cancel.onclick=()=>refresh();row.append(confirm,cancel);};
    row.append(edit,discover,remove);list.append(row);
    if(source.discovery&&source.discovery.status!=='none')renderDiscovery(source);
   }
   const available=value.models??[];lastCatalog=available;catalogReady=available.length>0;storedDefaultsExist=Object.values(value.defaults??{}).some(entry=>entry?.model?.mode==='explicit');
   const defaults=value.defaults??{};
   for(const [role,select]of Object.entries(selects))renderModelChoices(select,available,defaults[role]?.model?.mode==='explicit'?defaults[role].model.selector:'');
   const levelsFor=selector=>{const model=available.find(candidate=>candidate.selector===selector);return model?.thinking?.levels??null;};
   for(const [role,think]of Object.entries(thinkingSelects))renderThinkingChoices(think,defaults[role]?.thinking?.mode==='explicit'?defaults[role].thinking.level:'',levelsFor(selects[role].value));
   catalogMessage.textContent=catalogReady?`目录模型 ${available.length} 个（手动配置 ${available.filter(m=>m.catalogSource==='configured').length}／内置目录 ${available.filter(m=>m.catalogSource!=='configured').length}）。凭据已配置或服务列出都不代表推理授权，实际调用以服务端为准。`:value.sources?.length?'已配置账号或 API 源，但当前没有凭据已配置的目录模型。请检查授权或 API 配置后刷新；原设置未更改。':'尚无目录模型：请先登录账号或配置 API 源，再刷新模型列表。';
   message.textContent=value.notice??'';renderSync(value.modelSync);if(value.login)renderLogin(value.login);
  }catch(e){catalogMessage.textContent=catalogReady?'模型目录刷新失败；现有目录和选择保留，仍可保存未变化的默认。请稍后刷新或检查 Pi 源配置。':'模型目录读取失败，暂无目录。已保存且未变化的选择仍可保存；新选择需刷新。';if(!catalogReady)for(const select of Object.values(selects))if(select.options.length===1&&!select.value)select.options[0].textContent='暂无目录模型，请刷新';report(e);}finally{refreshFlight=null;syncModelControls();}})();return refreshFlight;}
 async function refreshAfterChange(){await refreshFlight;return refresh(true);}
 form.addEventListener('submit',event=>{event.preventDefault();
  const modelsList=parseModelLines(modelLines.value);
  if(!modelsList.length){message.textContent='请至少提供一个模型ID；可先用“发现模型”从服务端获取。';return;}
  const payload=editing?{operation:'update',provider:editing.provider,expectedRevision:editing.revision,baseUrl:baseUrlField.value,api:api.value,credential:key.value?{action:'replace',value:key.value}:{action:'keep',...(originConsentBox.checked&&consentBinding?{confirmNewOrigin:true}:{})},models:modelsList}
   :{operation:'create',provider:providerField.value,baseUrl:baseUrlField.value,api:api.value,credential:{action:'replace',value:key.value},models:modelsList};
  originConsentBox.checked=false;
  key.value='';
  run(async()=>{
   const result=await call('settings.providers.save',payload);
   await refreshAfterChange();
   const app=result?.application;
   const appNote=app?(app.failed?.length?`；${app.failed.length} 个在线Agent未能刷新凭据（已保留原会话，可重试保存源）`:(app.applied||app.pending?`；已同步 ${app.applied} 个、${app.pending} 个待回合结束`:'')):'';
   message.textContent=(editing?'源已更新（修订 '+result?.revision+'）。':'API 源已保存。')+'请在默认模型中选择目录模型。'+appNote;
   clearEdit();
  });
 });
 draftDiscover.onclick=()=>{if(editing){message.textContent='编辑已有源请使用行内“发现模型”。';return;}
  run(async()=>{
   discoveryArea.replaceChildren(node('p','正在用表单密钥向模型列表接口发起有界请求；密钥仅此一次使用，不保存。'));
   try{
    const result=await call('settings.providers.discover',{baseUrl:baseUrlField.value,api:api.value,credential:{action:'replace',value:key.value}});
    discoveryArea.replaceChildren();
    const box=node('div',null,{'data-discovery-box':'draft'});
    box.append(node('h3','草稿发现 · '+(result.status==='succeeded'?'服务端返回以下模型':result.status==='unsupported'?'此地址不支持模型列表查询':'列表请求失败')));
    if(result.error?.code)box.append(node('p','错误码 '+result.error.code+'；未回传服务端原文。'));
    if((result.models??[]).length){const ul=node('ul',null,{'data-discovery-models':'draft'});for(const row of result.models)ul.append(node('li',row.id+(row.name&&row.name!==row.id?' · '+row.name:'')+' · 服务返回，不代表推理授权'));box.append(ul,node('p','确认后仍需保存源才会进入 Pi 私有目录。'));}
    discoveryArea.append(box);
   }catch(error){discoveryArea.replaceChildren();report(error);}
  });
 };
 // Origin consent is bound to provider|oldOrigin|newOrigin and re-earned fresh
 // for every edit and every destination change; switching sources or moving
 // the destination can never carry over a previous acknowledgment.
 let consentBinding='';
 function updateOriginConsent(){
  if(!editing){originConsent.hidden=true;return;}
  let binding='';
  try{const previous=new URL(editing.baseUrl).origin,next=new URL(baseUrlField.value).origin;binding=editing.provider+'|'+previous+'|'+next;originConsent.hidden=previous===next;}catch{originConsent.hidden=true;}
  if(binding!==consentBinding){consentBinding=binding;originConsentBox.checked=false;}
 }
 baseUrlField.addEventListener('change',updateOriginConsent);
 baseUrlField.addEventListener('input',updateOriginConsent);
 loginForm.addEventListener('submit',event=>{event.preventDefault();const provider=loginProvider.value;if(!provider)return;run(async()=>{renderLogin(await call('settings.login.start',{provider}));clearInterval(polling);polling=setInterval(async()=>{try{const login=await call('settings.login.status');renderLogin(login);if(login&&login.state!=='running')await refresh();}catch(e){clearInterval(polling);polling=null;report(e);}},1000);});});
 for(const select of Object.values(selects)){select.onchange=()=>{select.dataset.dirty='true';const role=select.dataset.defaultRole,think=thinkingSelects[role];if(think)renderThinkingChoices(think,think.dataset.dirty==='true'?think.value:'',select.value?(lastCatalog.find(candidate=>candidate.selector===select.value)?.thinking?.levels??null):null);};select.addEventListener('blur',()=>flushModelChoices(select));}
 for(const think of Object.values(thinkingSelects))think.onchange=()=>{think.dataset.dirty='true';};
 modelForm.addEventListener('submit',event=>{event.preventDefault();if(busy)return;
  const defaults={};
  for(const role of Object.keys(selects))defaults[role]={model:selects[role].value?{mode:'explicit',selector:selects[role].value}:{mode:'native-default'},thinking:thinkingSelects[role].value?{mode:'explicit',level:thinkingSelects[role].value}:{mode:'native-default'}};
  for(const select of Object.values(selects))select.dataset.dirty='true';
  modelMessage.textContent='正在保存默认模型…';
  run(async()=>{const result=await call('settings.models.save',defaults);for(const select of Object.values(selects)){flushModelChoices(select);delete select.dataset.dirty;}for(const think of Object.values(thinkingSelects))delete think.dataset.dirty;renderSync(result?.modelSync,{saved:true});});
 });
 refreshButton.onclick=()=>{if(!busy)return Promise.all([refreshLoginProviders(),refresh()]);};
 modelRefresh.onclick=()=>refresh();
 return {refresh,refreshProviders:()=>Promise.all([refreshLoginProviders(),refresh()])};
}
