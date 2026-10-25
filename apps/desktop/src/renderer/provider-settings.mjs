export function mountProviderSettings({invoke,providers=document.getElementById('settings-provider'),models=document.getElementById('settings-models')}) {
 const call=async(op,payload={})=>{const response=await invoke(op,payload);if(response?.ok===false)throw Error(response.error?.message||'设置操作未完成');return response?.ok===true?response.value:response;};
 const node=(tag,text,attrs={})=>{const el=document.createElement(tag);if(text)el.textContent=text;for(const [key,value]of Object.entries(attrs))el.setAttribute(key,value);return el;};
 const field=(form,label,name,type='text',value='')=>{const wrap=node('label',label),input=node('input',null,{name,type,autocomplete:'off'});input.value=value;wrap.append(input);form.append(wrap);return input;};
 const message=node('p','',{role:'status','aria-live':'polite','data-provider-status':''});
 const modelMessage=node('p','',{role:'status','aria-live':'polite','data-model-status':''});models.append(modelMessage);
 const list=node('div',null,{'data-provider-list':''}),loginArea=node('div',null,{'data-provider-login':''});
 providers.append(node('h2','OMP 源'),node('p','使用Nozeli私有OMP账号登录或配置API源。密钥仅存宿主私有配置与认证库，不回传界面。'),list);
 const form=node('form',null,{'data-provider-api-form':''});field(form,'Provider ID','provider');field(form,'API地址（base URL）','baseUrl','url');field(form,'模型ID','model');
 const protocol=node('label','API协议'),api=node('select',null,{name:'api'});for(const value of ['openai-completions','openai-responses','anthropic-messages']){const opt=node('option',value,{value});api.append(opt);}protocol.append(api);form.append(protocol);
 const key=field(form,'API密钥','key','password');form.append(node('button','添加API源',{type:'submit',class:'ui-action','data-ui-action':'primary'}));providers.append(form);
 const loginForm=node('form',null,{'data-provider-login-form':''}),loginLabel=node('label','选择OMP支持的账号源'),loginProvider=node('select',null,{name:'provider','data-login-provider':'',required:''}),loginStart=node('button','登录 / 激活所选源',{type:'submit'});
 loginProvider.append(node('option','请选择账号源',{value:''}));loginLabel.append(loginProvider);loginForm.append(node('h3','账号登录'),loginLabel,loginStart);providers.append(loginForm,loginArea,message);
 providers.insertBefore(loginForm,form);providers.insertBefore(loginArea,form);loginStart.disabled=true;
 const refreshButton=node('button','刷新源和模型',{type:'button','data-provider-refresh':''});providers.append(refreshButton);
 providers.append(node('p','模型目录可能联网更新；不会发送对话或模型请求。'));
 models.append(node('h2','三角色默认模型'),node('p','前台：优先最快响应；编排：优先强推理与规划；Worker：中等及以上能力。保存后，所有项目同角色 Agent 联动切换；执行中的回合不打断，结束后应用。休眠 Agent 恢复时应用，不新建对话。'));
 const modelForm=node('form',null,{'data-role-model-form':''}),selects={};for(const [role,label]of [['frontdesk','前台 · 最快'],['orchestrator','编排 · 强模型'],['worker','Worker · 中等及以上']]){const wrap=node('label',label),select=node('select',null,{'data-default-role':role,name:role});selects[role]=select;wrap.append(select);modelForm.append(wrap);}modelForm.append(node('button','保存三角色默认',{type:'submit',class:'ui-action','data-ui-action':'primary'}));models.append(modelForm);
 const catalogMessage=node('p','正在读取可用模型…',{role:'status','aria-live':'polite','data-model-catalog-status':''});
 const modelRefresh=node('button','刷新模型列表',{type:'button','data-model-refresh':''}),configureSource=node('button','配置 OMP 源',{type:'button','data-model-configure-source':''});
 const modelActions=node('div',null,{class:'settings-actions'});modelActions.append(modelRefresh,configureSource);modelForm.before(catalogMessage,modelActions);
 const modelSave=modelForm.querySelector('button[type="submit"]');let catalogReady=false,refreshFlight=null;
 for(const select of Object.values(selects)){select.disabled=true;select.append(node('option','正在读取模型…',{value:''}));}modelSave.disabled=true;
 configureSource.onclick=()=>window.dispatchEvent(new CustomEvent('nozeli-open-settings',{detail:'settings-provider'}));
 let polling=null,loginId=null,busy=false;
 const report=error=>{message.textContent=error?.message||'操作未完成。';modelMessage.textContent=message.textContent;};
 function renderSync(sync,{saved=false}={}){
  if(!sync){if(saved)modelMessage.textContent='默认模型已保存。';return;}
  const parts=[saved?'默认模型已保存。':''];
  if(sync.applied)parts.push(`已切换 ${sync.applied} 个 Agent。`);
  if(sync.pending)parts.push(`${sync.pending} 个 Agent 待当前回合结束后切换。`);
  if(sync.failed?.length)parts.push(`${sync.failed.length} 个 Agent 切换未完成：`+sync.failed.map(item=>item.message||'请检查源配置后重新保存。').join('；'));
  if(saved&&!sync.applied&&!sync.pending&&!sync.failed?.length)parts.push('休眠及尚未启动的 Agent 将在恢复时应用。');
  modelMessage.textContent=parts.join('');
 }
 async function run(action){if(busy)return;busy=true;const buttons=[...providers.querySelectorAll('button'),...models.querySelectorAll('button')];for(const b of buttons)b.disabled=true;try{await refreshFlight;await action();}catch(e){report(e);}finally{busy=false;for(const b of buttons)if(b.isConnected)b.disabled=false;modelSave.disabled=!catalogReady;loginStart.disabled=!loginProvider.value||loginProvider.disabled;}}
 function renderLogin(login){
  const draft=loginArea.querySelector('input')?.value||'';
  loginArea.replaceChildren();loginId=login?.id??null;if(!login)return;
  const states={running:'等待授权',complete:'登录完成',failed:'登录未完成',cancelled:'已取消',expired:'已过期'};
  loginArea.append(node('p',(login.name||login.provider||'OMP')+' · '+(states[login.state]||login.state)),node('pre',login.output||'请按所选源的官方流程继续。',{'data-login-output':''}));
  if(login.state==='running'){
   const inputForm=node('form',null,{'data-login-input-form':''});const input=field(inputForm,'授权流程要求的验证码或回调地址','text');input.value=draft;
   inputForm.append(node('button','提交登录输入',{type:'submit'}));inputForm.addEventListener('submit',event=>{event.preventDefault();const text=input.value;input.value='';run(()=>call('settings.login.input',{id:loginId,text}));});
   const cancel=node('button','取消登录',{type:'button','data-login-cancel':''});cancel.onclick=()=>run(async()=>renderLogin(await call('settings.login.cancel',{id:loginId})));loginArea.append(inputForm,cancel);
  }else{clearInterval(polling);polling=null;}
 }
 async function refreshLoginProviders(){
  const selected=loginProvider.value;loginProvider.disabled=loginStart.disabled=true;
  try{const providers=await call('settings.login.providers');loginProvider.replaceChildren(node('option','请选择账号源',{value:''}));for(const p of providers)loginProvider.append(node('option',p.name,{value:p.id}));if(providers.some(p=>p.id===selected))loginProvider.value=selected;loginProvider.disabled=false;loginStart.disabled=!loginProvider.value;}
  catch(error){loginProvider.replaceChildren(node('option','登录源目录暂不可用，请刷新',{value:''}));report(error);}
 }
 loginProvider.addEventListener('change',()=>{loginStart.disabled=!loginProvider.value;});
 async function refresh(){if(refreshFlight)return refreshFlight;
 catalogReady=false;modelSave.disabled=true;modelRefresh.disabled=true;catalogMessage.textContent='正在读取可用模型…';
 for(const select of Object.values(selects))select.disabled=true;
 refreshFlight=(async()=>{try{
  const value=await call('settings.providers.status');list.replaceChildren();
  if(!value.sources?.length)list.append(node('p','尚无已配置源。请登录或添加API源。'));
  for(const source of value.sources??[]){
   const row=node('div',null,{'data-provider-row':source.provider});row.append(node('strong',source.provider),node('span',' · '+(source.type==='oauth'?'账号登录':'API')+(source.baseUrl?' · '+source.baseUrl:'')));
   const remove=node('button','移除',{type:'button','data-ui-action':'danger','data-provider-remove':source.provider});
   remove.onclick=()=>{remove.disabled=true;row.append(node('p','确认移除 '+source.provider+'？将禁用其私有凭据；仍有会话引用时会拒绝。'));const confirm=node('button','确认移除 '+source.provider,{type:'button','data-ui-action':'danger','data-provider-confirm-remove':source.provider});confirm.onclick=()=>run(async()=>{await call('settings.providers.remove',{provider:source.provider,confirm:source.provider});await refreshAfterChange();message.textContent='已移除源。';});const cancel=node('button','取消',{type:'button'});cancel.onclick=()=>refresh();row.append(confirm,cancel);};row.append(remove);list.append(row);
  }
  const available=value.models??[];catalogReady=available.length>0;
  for(const [role,select]of Object.entries(selects)){const selected=select.dataset.dirty==='true'?select.value:value.defaults?.[role]||'';select.replaceChildren(node('option','沿用原生OMP选择',{value:''}));for(const model of available)select.append(node('option',`${model.name||model.id||model.selector} · ${model.provider}`,{value:model.selector}));if(selected&&!available.some(m=>m.selector===selected))select.append(node('option',selected+'（当前目录不可用；原选择保留）',{value:selected}));select.value=selected;select.disabled=!catalogReady;}
  catalogMessage.textContent=catalogReady?`可用模型：${available.length} 个。三个角色可分别选择。`:value.sources?.length?'已配置源，但 OMP 暂无可用模型。请检查源的授权或模型配置，再刷新列表；原选择未改动。':'尚无可用模型：此独立配置还没有 OMP 源。请先配置账号或 API 源，再刷新模型列表。';
  message.textContent=value.notice??'';renderSync(value.modelSync);if(value.login)renderLogin(value.login);
 }catch(e){catalogMessage.textContent='模型列表读取失败；原选择保留。请重试刷新，或检查 OMP 源配置。';report(e);}finally{modelRefresh.disabled=false;modelSave.disabled=busy||!catalogReady;refreshFlight=null;}})();return refreshFlight;}
 async function refreshAfterChange(){await refreshFlight;return refresh();}
 form.addEventListener('submit',event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));key.value='';run(async()=>{await call('settings.providers.save',data);await refreshAfterChange();message.textContent='API源已保存。选择默认模型并保存后，所有项目同角色 Agent 联动切换。';});});
 loginForm.addEventListener('submit',event=>{event.preventDefault();const provider=loginProvider.value;if(!provider)return;run(async()=>{renderLogin(await call('settings.login.start',{provider}));clearInterval(polling);polling=setInterval(async()=>{try{const login=await call('settings.login.status');renderLogin(login);if(login&&login.state!=='running')await refresh();}catch(e){clearInterval(polling);polling=null;report(e);}},1000);});});
 for(const select of Object.values(selects))select.onchange=()=>{select.dataset.dirty='true';};
 modelForm.addEventListener('submit',event=>{event.preventDefault();if(!catalogReady)return;run(async()=>{const result=await call('settings.models.save',Object.fromEntries(new FormData(modelForm)));for(const select of Object.values(selects))delete select.dataset.dirty;renderSync(result?.sync,{saved:true});});});
 refreshButton.onclick=()=>run(()=>Promise.all([refreshLoginProviders(),refresh()]));
 modelRefresh.onclick=()=>refresh();
 return {refresh,refreshProviders:()=>Promise.all([refreshLoginProviders(),refresh()])};
}
