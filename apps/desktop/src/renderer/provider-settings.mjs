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
 const key=field(form,'API密钥','key','password');form.append(node('button','添加API源',{type:'submit'}));providers.append(form);
 const loginForm=node('form',null,{'data-provider-login-form':''});field(loginForm,'登录Provider ID（留空使用官方列表选择）','provider');loginForm.append(node('button','账号登录',{type:'submit'}));providers.append(loginForm,loginArea,message);
 const refreshButton=node('button','刷新源和模型',{type:'button','data-provider-refresh':''});providers.append(refreshButton);
 providers.append(node('p','模型目录可能联网更新；不会发送对话或模型请求。'));
 models.append(node('h2','三角色默认模型'),node('p','前台：优先最快响应；编排：优先强推理与规划；Worker：中等及以上能力。仅用于新会话，不改变已有会话的模型。'));
 const modelForm=node('form',null,{'data-role-model-form':''}),selects={};for(const [role,label]of [['frontdesk','前台 · 最快'],['orchestrator','编排 · 强模型'],['worker','Worker · 中等及以上']]){const wrap=node('label',label),select=node('select',null,{'data-default-role':role,name:role});selects[role]=select;wrap.append(select);modelForm.append(wrap);}modelForm.append(node('button','保存三角色默认',{type:'submit'}));models.append(modelForm);
 let polling=null,loginId=null,busy=false;
 const report=error=>{message.textContent=error?.message||'操作未完成。';modelMessage.textContent=message.textContent;};
 async function run(action){if(busy)return;busy=true;const buttons=[...providers.querySelectorAll('button'),...models.querySelectorAll('button')];for(const b of buttons)b.disabled=true;try{await action();}catch(e){report(e);}finally{busy=false;for(const b of buttons)if(b.isConnected)b.disabled=false;}}
 function renderLogin(login){
  const draft=loginArea.querySelector('input')?.value||'';
  loginArea.replaceChildren();loginId=login?.id??null;if(!login)return;
  loginArea.append(node('p','登录状态：'+login.state),node('pre',login.output||'正在启动官方OMP登录…',{'data-login-output':''}));
  if(login.state==='running'){
   const inputForm=node('form',null,{'data-login-input-form':''});const input=field(inputForm,'官方流程输入（列表序号、验证码或回调地址）','text');input.value=draft;
   inputForm.append(node('button','提交登录输入',{type:'submit'}));inputForm.addEventListener('submit',event=>{event.preventDefault();const text=input.value;input.value='';run(()=>call('settings.login.input',{id:loginId,text}));});
   const cancel=node('button','取消登录',{type:'button','data-login-cancel':''});cancel.onclick=()=>run(async()=>renderLogin(await call('settings.login.cancel',{id:loginId})));loginArea.append(inputForm,cancel);
  }else{clearInterval(polling);polling=null;}
 }
 async function refresh(){try{
  const value=await call('settings.providers.status');list.replaceChildren();
  if(!value.sources?.length)list.append(node('p','尚无已配置源。请登录或添加API源。'));
  for(const source of value.sources??[]){
   const row=node('div',null,{'data-provider-row':source.provider});row.append(node('strong',source.provider),node('span',' · '+(source.type==='oauth'?'账号登录':'API')+(source.baseUrl?' · '+source.baseUrl:'')));
   const remove=node('button','移除',{type:'button','data-provider-remove':source.provider});
   remove.onclick=()=>{remove.disabled=true;row.append(node('p','确认移除 '+source.provider+'？将禁用其私有凭据；仍有会话引用时会拒绝。'));const confirm=node('button','确认移除 '+source.provider,{type:'button','data-provider-confirm-remove':source.provider});confirm.onclick=()=>run(async()=>{await call('settings.providers.remove',{provider:source.provider,confirm:source.provider});await refresh();message.textContent='已移除源。';});const cancel=node('button','取消',{type:'button'});cancel.onclick=()=>refresh();row.append(confirm,cancel);};row.append(remove);list.append(row);
  }
  for(const [role,select]of Object.entries(selects)){const selected=select.dataset.dirty==='true'?select.value:value.defaults?.[role]||'';select.replaceChildren(node('option','沿用原生OMP选择',{value:''}));for(const model of value.models??[])select.append(node('option',model.selector,{value:model.selector}));if(selected&&!(value.models??[]).some(m=>m.selector===selected))select.append(node('option',selected+'（目录暂不可用；未自动改写）',{value:selected}));select.value=selected;}
  message.textContent=value.notice??'';if(value.login)renderLogin(value.login);
 }catch(e){report(e);}}
 form.addEventListener('submit',event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));key.value='';run(async()=>{await call('settings.providers.save',data);await refresh();message.textContent='API源已保存。新建Agent目录可使用此源，已有会话不变。';});});
 loginForm.addEventListener('submit',event=>{event.preventDefault();const provider=new FormData(loginForm).get('provider').trim();run(async()=>{renderLogin(await call('settings.login.start',provider?{provider}:{}));clearInterval(polling);polling=setInterval(async()=>{try{const login=await call('settings.login.status');renderLogin(login);if(login&&login.state!=='running')await refresh();}catch(e){clearInterval(polling);polling=null;report(e);}},1000);});});
 for(const select of Object.values(selects))select.onchange=()=>{select.dataset.dirty='true';};
 modelForm.addEventListener('submit',event=>{event.preventDefault();run(async()=>{await call('settings.models.save',Object.fromEntries(new FormData(modelForm)));for(const select of Object.values(selects))delete select.dataset.dirty;modelMessage.textContent='默认模型已保存；仅绑定新会话，已有会话不变。';});});
 refreshButton.onclick=()=>run(refresh);
 return {refresh};
}
