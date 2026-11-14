// Demo-only initializer injected by integrated-demo.mjs into an isolated real Nozeli shell.
export function mountIntegratedAdminDemo(){
 if(window.__integratedAdminDemo)return;
 const $=s=>document.querySelector(s),make=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
 const state={connected:false,model:'',draft:'',messages:[],bound:false,appearance:'跟随系统'};
 const style=make('style');style.textContent=`#admin-demo-surface{position:absolute;inset:0;z-index:25;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);min-width:0}#admin-demo-surface[hidden]{display:none!important}.adm-head{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--line);flex:none}.adm-head strong{flex:1}.adm-scope{padding:6px 20px;background:var(--green-soft);font-size:12px;color:var(--muted);flex:none}.adm-log{overflow:auto;flex:1;min-height:0;padding:24px max(16px,calc((100% - 740px)/2));line-height:1.7}.adm-log h2{font-size:23px;margin:0 0 8px}.adm-log p{margin:6px 0}.adm-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.adm-message{margin:20px 0}.adm-user{padding:10px 14px;border-radius:8px;background:var(--green-soft);margin-left:12%}.adm-note{color:var(--muted);font-size:12px}.adm-proposal{border:1px solid var(--line);padding:14px;border-radius:8px;margin-top:10px}.adm-compose{padding:12px max(16px,calc((100% - 740px)/2));border-top:1px solid var(--line);flex:none}.adm-compose textarea{box-sizing:border-box;width:100%;height:74px;resize:vertical;max-height:160px;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit}.adm-compose footer{display:flex;align-items:center;gap:10px;padding:6px 0}.adm-compose small{flex:1;color:var(--muted)}#adm-demo-banner{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:10000;background:var(--green-soft);color:var(--ink);border:1px solid var(--line);padding:2px 12px;font-size:11px;pointer-events:none}#adm-settings-section select{max-width:100%}#admin-demo-surface button{font:inherit;min-height:32px}#reader:has(>#admin-demo-surface:not([hidden])){isolation:isolate}@media(max-width:600px){.adm-head{padding:8px 12px;gap:5px;flex-wrap:wrap}.adm-log{padding:18px 12px}.adm-compose{padding:10px 12px}.adm-scope{padding:6px 12px}.adm-head strong{flex-basis:45%}.adm-note{font-size:11px}}`;
 style.nonce=document.querySelector('meta[name="nozeli-style-nonce"]')?.content||'';
 document.head.append(style);
 const banner=make('div','融合交互 Demo · 独立隔离配置 · 管理回复/登录为模拟');banner.id='adm-demo-banner';document.body.append(banner);
 const surface=make('section');surface.id='admin-demo-surface';surface.hidden=true;surface.setAttribute('aria-label','管理员 Agent 工作面');$('#reader').append(surface);
 const settings=$('#settings-dialog'),nav=$('.settings-nav'),body=$('.settings-content');
 const navButton=make('button','管理员 Agent');navButton.type='button';navButton.dataset.settingsSection='adm-settings-section';nav.prepend(navButton);
 const section=make('section');section.id='adm-settings-section';section.hidden=true;body.prepend(section);
 const sources={builtin:['通用助手 · 示例','推理模型 · 示例'],custom:['自定义模型A · 示例','自定义模型B · 示例']};
 function button(label,action,parent){const b=make('button',label);b.type='button';b.onclick=action;parent?.append(b);return b;}
 function open(){if(settings.open)settings.close();surface.hidden=false;render();}
 function close(){state.draft=$('#adm-input')?.value??state.draft;surface.hidden=true;}
 function showSection(id){close();if(!settings.open)$('#open-settings').click();for(const n of body.querySelectorAll(':scope>section'))n.hidden=n.id!==id;for(const b of nav.querySelectorAll('[data-settings-section]'))b.setAttribute('aria-current',b.dataset.settingsSection===id?'page':'false');settingsViews();}
 navButton.onclick=()=>showSection('adm-settings-section');
 for(const b of nav.querySelectorAll('[data-settings-section]'))if(b!==navButton)b.addEventListener('click',()=>{section.hidden=true;});
 function settingsViews(){
  section.replaceChildren(make('h2','管理员 Agent'),make('p','独立管理应用；不默认读取项目内容。开始页与设置共用原管理会话。'));button('打开管理员 Agent',open,section);
  const row=make('div');row.className='settings-card';row.append(make('h3','开始前：API／登录'),make('p',state.connected?'已完成演示连接，不代表真实账号有效。':'先配置服务，再选择管理员默认模型。'));
  const actions=make('div',null,'adm-actions');row.append(actions);
  for(const [label,method]of [['设置 API（模拟）','API'],['登录账号（模拟）','登录']])button(label,()=>confirmConnection(method),actions);
  button('打开 Nozeli 原有 AI 连接设置',()=>{showSection('settings-provider');$('#adm-provider-note')?.scrollIntoView({block:'start'});},actions);section.append(row);
  mountModelRow();
 }
 function confirmConnection(method){
  const d=make('dialog');d.className='settings-dialog';d.style.height='auto';d.style.maxWidth='500px';d.append(make('h2',method+' · 交互模拟'),make('p','不输入真实密钥、不打开授权网站、不调用模型。继续只登记Demo连接状态。'));const actions=make('div',null,'adm-actions');d.append(actions);d.style.padding='20px';button('取消',()=>{d.close();d.remove();},actions);button('完成模拟并选模型',()=>{state.connected=true;d.close();d.remove();settingsViews();showSection('settings-models');$('#adm-model-row').scrollIntoView({block:'start'});},actions);document.body.append(d);d.showModal();
 }
 function mountModelRow(){
  const models=$('#settings-models');$('#adm-model-row')?.remove();const field=make('fieldset');field.id='adm-model-row';field.className='settings-card';field.append(make('legend','管理员 Agent 默认模型 · Demo'),make('p','只影响独立管理员，不改变前台/主控/工作助手。'));
  const source=make('select');source.id='adm-model-source';source.setAttribute('aria-label','管理员模型源');for(const [id,label]of [['builtin','示例内置源'],['custom','示例自定义源']]){const o=make('option',label);o.value=id;source.append(o);}source.value=state.model.split('/')[0]||'builtin';
  const model=make('select');model.id='adm-model-choice';model.setAttribute('aria-label','管理员模型');const fill=()=>{model.replaceChildren();const blank=make('option','未选择');blank.value='';model.append(blank);sources[source.value].forEach((label,index)=>{const o=make('option',label);o.value=source.value+'/'+index;model.append(o);});model.value=state.model.startsWith(source.value+'/')?state.model:'';};fill();source.onchange=()=>{fill();note.textContent='仅浏览源，原模型尚未改变。';};source.disabled=model.disabled=!state.connected;
  for(const [label,control]of [['模型源',source],['模型',model]]){const wrapper=make('label',label);wrapper.append(control);field.append(wrapper);}
  const note=make('p',state.connected?'选择并保存后生效。':'请先设置 API／登录。');note.id='adm-model-note';field.append(note);const actions=make('div',null,'adm-actions');field.append(actions);const save=button('保存管理员模型（模拟）',()=>{if(!state.connected)return;state.model=model.value;note.textContent='管理员模型已模拟保存；原项目角色未改。';},actions);save.disabled=!state.connected;button('先设置 API／登录',()=>showSection('adm-settings-section'),actions);button('返回原管理会话',open,actions);models.prepend(field);
 }
 const providerNote=make('p','本窗口使用隔离演示配置。管理员“模拟连接”不写入这里的真实服务配置；请勿输入个人密钥。');providerNote.id='adm-provider-note';providerNote.className='settings-hint';$('#settings-provider').prepend(providerNote);
 function send(text){state.draft=$('#adm-input')?.value||'';text=text.trim();if(!text)return;state.messages.push({user:true,text});state.draft='';
  if(/资源|安装技能|商店/.test(text))state.messages.push({text:'本期不接资源库或扩展安装。'});
  else if(/诊断|状态|检查/.test(text))state.messages.push({text:'应用状态 · 示例：管理员连接'+(state.connected?'已模拟配置':'未配置')+'；开发工作区'+(state.bound?'已模拟绑定':'未绑定')+'。未扫描真实项目或检查真实账号。'});
  else if(/开发|功能|源码/.test(text))state.messages.push(state.bound?{text:'候选计划：在Nozeli开发副本准备修改和验证，再单独决定激活。',plan:'development',status:'pending'}:{text:'先绑定开发副本，不把当前论文项目或运行目录作为开发目标。',binding:true});
  else if(/设置|深色|外观/.test(text))state.messages.push({text:'设置变更计划：应用外观改为深色；不改变项目文件、字号或阅读位置。',plan:'settings',status:'pending'});
  else state.messages.push({text:'本期原型只预设应用诊断、外观设置与功能开发回复，不是通用模型。'});
  render();$('.adm-log').scrollTop=$('.adm-log').scrollHeight;
 }
 function bind(){state.draft=$('#adm-input')?.value??state.draft;state.bound=true;render();}
 function render(){surface.replaceChildren();const head=make('header',null,'adm-head');head.append(make('strong','管理员 Agent'),make('span','独立会话 · Demo','badge'));button('开发副本：'+(state.bound?'合成已绑定':'未绑定'),bind,head);button('返回工作区',close,head);surface.append(head,make('div','应用管理 · 不继承当前项目内容 · 不授予系统管理员权限','adm-scope'));
  const log=make('div',null,'adm-log');log.setAttribute('role','log');log.append(make('h2','先把 Nozeli 配置好，再开始工作。'),make('p','与当前项目讨论分开；项目、文件与阅读工作面保留在原处。'));
  const setup=make('div',null,'adm-proposal');setup.append(make('strong',state.connected?'连接已模拟配置':'先设置 API／登录'),make('p','管理员默认模型：'+(state.model||'未选择')));const setupActions=make('div',null,'adm-actions');button('先设置 API／登录',()=>showSection('adm-settings-section'),setupActions);button('管理员模型设置',()=>showSection('settings-models'),setupActions);setup.append(setupActions);log.append(setup);
  const examples=make('div',null,'adm-actions');for(const [label,text]of [['检查应用状态','检查应用状态'],['调整外观设置','调整外观为深色'],['准备功能开发','开发Nozeli新功能']])button(label,()=>send(text),examples);log.append(examples);
  state.messages.forEach(m=>{const article=make('article',null,'adm-message'+(m.user?' adm-user':''));article.append(make('small',m.user?'你':'管理员 · 固定回复','adm-note'),make('p',m.text));if(m.binding)button('绑定演示开发副本',bind,article);if(m.plan){const card=make('div',null,'adm-proposal');card.append(make('p',{pending:'待确认 · 无真实执行',cancelled:'已取消',completed:'已模拟完成 · 未修改真实设置',candidate:'候选已模拟准备 · 未安装'}[m.status]));if(m.status==='pending'){button('取消方案',()=>{state.draft=$('#adm-input').value;m.status='cancelled';render();},card);button('查看变更',()=>{const d=make('dialog');d.style.padding='20px';d.append(make('h3','确认具体变更 · 模拟'),make('p',m.text),make('p','只登记演示状态，不执行安装、修改文件或启动Worker。'));const a=make('div',null,'adm-actions');button('取消',()=>{d.close();d.remove();},a);button('确认模拟',()=>{state.draft=$('#adm-input').value;m.status=m.plan==='settings'?'completed':'candidate';d.close();d.remove();render();},a);d.append(a);document.body.append(d);d.showModal();},card);}article.append(card);}log.append(article);});surface.append(log);
  const form=make('form',null,'adm-compose'),input=make('textarea');input.id='adm-input';input.setAttribute('aria-label','管理员Agent输入');input.placeholder='描述希望检查或调整的应用行为…';input.value=state.draft;input.oninput=()=>state.draft=input.value;const footer=make('footer');footer.append(make('small','模拟回复 · 不调用模型，不执行真实管理操作'));const submit=make('button','发送');submit.type='submit';footer.append(submit);form.append(input,footer);form.onsubmit=e=>{e.preventDefault();send(input.value)};surface.append(form);
 }
 function addEntry(){for(const actions of document.querySelectorAll('.guided-start-actions')){if(actions.querySelector('[data-adm-start]'))continue;const b=button('从管理员 Agent 开始',open,actions);b.dataset.admStart='true';}}
 const observer=new MutationObserver(addEntry);observer.observe($('#reader'),{childList:true,subtree:true});addEntry();settingsViews();
 window.__integratedAdminDemo={state,open,close,settings:showSection};
}
