import roleRegistry from '../agents/managed/roles.json';
import {frontdeskSkillCommands} from '../agents/managed/frontdesk-skill-commands.mjs';
import {uiIcon} from './ui-icons.mjs';

// Settings edit existing project contracts; no application/type/file inheritance.
export function mountProjectSettings({invoke,getProjectId}) {
  const sections=['settings-project-reading','settings-project-workspace','settings-project-tex','settings-project-confirmations','settings-project-agents'];
  const pages=new Map();
  const roleDrafts=new Map(),expandedRoles=new Map();
  window.nozeli.subscribe('workspace.control',event=>{if(event.type!=='settings')return;const page=pages.get('settings-project-reading:'+event.projectId);if(!page)return;const region=pages.get('settings-project-reading')===page?document.getElementById('settings-project-reading'):page.fragment;if(!region)return;for(const input of region.querySelectorAll('[data-project-reading]'))if(event.workspace?.[input.dataset.projectReading]!==undefined)input.value=String(event.workspace[input.dataset.projectReading]);});
  const call=async(op,payload={})=>{const result=await invoke(op,payload);if(!result.ok)throw Error(result.error?.message||'设置请求失败');return result.value;};
  const node=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
  function button(text,run){const n=node('button',text);n.type='button';n.onclick=()=>void Promise.resolve().then(run).catch(error=>{const status=n.closest('section').querySelector('[role="status"]');if(status)status.textContent=error.message;});return n;}
  function field(container,title,input){const label=node('label',title);label.append(input);container.append(label);return input;}
  function select(values,value){const input=node('select');for(const [key,title]of values)input.append(new Option(title,String(key)));input.value=String(value);return input;}
  function skillLabel(name){
    return frontdeskSkillCommands.find(skill=>skill.name===name)?.label??({
      'nozeli-frontdesk-history-handoff':'只读历史查询','nozeli-worker-report':'提交报告',
      'nozeli-worker-question':'提出问题','nozeli-worker-material':'读取材料','nozeli-worker-task-boundary':'任务边界',
    })[name]??name;
  }
  async function renderAgents(container,status,id,current){
    const [store,managed]=await Promise.allSettled([call('store.skills.list',{projectId:id}),call('managed.status',{projectId:id})]);
    if(!current())return;
    let saving=false;
    const save=(op,payload,renderSaved)=>async()=>{
      if(!current()||saving)return;
      saving=true;
      const controls=[...container.querySelectorAll('button,input')].filter(control=>!control.disabled);
      for(const control of controls)control.disabled=true;
      status.textContent='正在保存…';
      try{
        const result=await call(op,{projectId:id,...payload});
        if(current()){renderSaved?.(result);status.textContent='已保存到当前项目。';}
      }catch(error){
        if(current())status.textContent='未保存：'+error.message;
      }finally{
        if(current())for(const control of controls)control.disabled=false;
        saving=false;
      }
    };
    function appendStoreSkills(section,roleId,roleName){
      section.append(node('h4','商店技能'));
      if(store.status==='rejected'){section.append(node('p',store.reason.message));return;}
      let count=0;
      for(const skill of store.value)for(const role of skill.roles.filter(role=>role.installed&&role.id===roleId)){
        ++count;
        const row=node('div'),availability=node('p');row.className='project-role-store-skill';row.append(node('strong',skill.name),availability);
        let enabled=role.enabled;
        const toggle=button('',()=>save('store.skills.'+(enabled?'disable':'enable'),{skillId:skill.id,role:role.id},rows=>{
          enabled=rows.find(item=>item.id===skill.id).roles.find(item=>item.id===role.id).enabled;renderToggle();
        })());
        function renderToggle(){
          availability.textContent=enabled?'当前项目可用':'当前项目已关闭';
          toggle.textContent=enabled?'关闭':'恢复';
          toggle.setAttribute('aria-label',`${toggle.textContent}${skill.name}（${roleName}）`);
        }
        renderToggle();toggle.dataset.projectStoreSkill=skill.id;row.append(toggle);section.append(row);
      }
      if(!count)section.append(node('p','无已安装技能'));
    }
    const roles=node('div');roles.className='project-role-list';
    container.append(node('p','仅影响当前项目。安装和卸载在资源商店。'),roles);
    const state=managed.status==='fulfilled'?managed.value.state:null;
    for(const [role,spec] of Object.entries(roleRegistry.roles)){
      const roleName=role==='orchestrator'?'主控':spec.displayName;
      const entry=node('details'),summary=node('summary'),section=node('div');
      entry.dataset.projectRole=role;
      entry.setAttribute('name','project-role-skills');
      entry.open=expandedRoles.get(id)===role;
      entry.ontoggle=()=>{if(!current())return;if(entry.open)expandedRoles.set(id,role);else if(expandedRoles.get(id)===role)expandedRoles.delete(id);};
      summary.append(uiIcon(role==='frontdesk'?'message-square':role==='orchestrator'?'list-tree':'terminal'),node('strong',roleName),uiIcon('chevron-right'));
      section.className='project-role-skills';entry.append(summary,section);roles.append(entry);
      appendStoreSkills(section,role,roleName);
      section.append(node('h4','内置技能'));
      const selected=state?.bindings?.[role]?.skills,available=state?.roleSkills?.[role];
      if(role==='orchestrator')section.append(node('p','主控技能由宿主管理。'));
      if(managed.status==='rejected'){section.append(node('p',managed.reason.message));continue;}
      if(!Array.isArray(selected)||!Array.isArray(available)){section.append(node('p','连接项目 AI 后可查看。'));continue;}
      const required=(spec.requiredSkills??[]).map(name=>`nozeli-${role}-${name}`);
      const choices=[];
      const key=JSON.stringify([id,role]),draft=roleDrafts.get(key)??new Map();
      const saved=new Set(selected),dirty=node('small','未保存');
      dirty.hidden=!draft.size;summary.insertBefore(dirty,summary.lastChild);
      for(const name of available){
        const label=node('label'),input=node('input');input.type='checkbox';input.value=name;
        input.checked=draft.get(name)??saved.has(name);input.disabled=role==='orchestrator'||required.includes(name);
        input.onchange=()=>{
          if(input.checked===saved.has(name))draft.delete(name);else draft.set(name,input.checked);
          if(draft.size)roleDrafts.set(key,draft);else roleDrafts.delete(key);
          dirty.hidden=!draft.size;
        };
        label.append(input,document.createTextNode(' '+skillLabel(name)+(required.includes(name)?'（必需）':'')));section.append(label);choices.push(input);
      }
      if(role!=='orchestrator'){
        const commit=button('保存技能',()=>{
          if(!draft.size)return;
          const skills=choices.filter(input=>input.checked).map(input=>input.value);
          return save('managed.binding',{role,skills},()=>{
            saved.clear();for(const name of skills)saved.add(name);
            draft.clear();roleDrafts.delete(key);dirty.hidden=true;
          })();
        });
        const discard=button('放弃更改',()=>{
          for(const input of choices)input.checked=saved.has(input.value);
          draft.clear();roleDrafts.delete(key);dirty.hidden=true;
        });
        commit.dataset.projectRoleSave=role;
        section.append(node('p',role==='worker'?'只影响新建的工作 Agent。':'前台空闲时可保存，保留原对话线程。'),commit,discard);
      }
    }
  }
  async function refresh(section){
    if(!sections.includes(section))return;
    const container=document.getElementById(section),id=getProjectId();
    const retain=page=>page?.ready&&(page.dirty||section==='settings-project-reading');
    const existing=pages.get(section);if(existing?.id===id&&retain(existing))return;
    if(existing){existing.fragment=document.createDocumentFragment();existing.fragment.append(...container.childNodes);}
    const cached=pages.get(section+':'+id);if(retain(cached)){container.replaceChildren(cached.fragment);pages.set(section,cached);container.oninput=section==='settings-project-reading'?null:()=>{cached.dirty=true;cached.editVersion=(cached.editVersion||0)+1;};return;}
    const page={id,ready:false,dirty:false,editVersion:0,fragment:null};pages.set(section,page);pages.set(section+':'+id,page);
    container.replaceChildren(node('h3',container.getAttribute('aria-label')));
    if(section==='settings-project-tex'||section==='settings-project-workspace')container.oninput=()=>{page.dirty=true;page.editVersion=(page.editVersion||0)+1;};else container.oninput=null;
    const status=node('p',id?'正在读取…':'未打开项目；此处仅影响当前项目。');status.setAttribute('role','status');container.append(status);
    if(!id){page.ready=true;return;}
    const current=()=>id===getProjectId()&&pages.get(section)===page;
    const guarded=async work=>{if(!current())throw Error('项目已切换，请重新打开本页。');return work();};
    try {
      if(section==='settings-project-reading'){
        const {state={}}=await call('state.read',{projectId:id});if(!current())return;
        const values={fontSize:14,conversationFontSize:14,readingWidth:72,...state?.workspace};let queue=Promise.resolve();
        container.append(node('p','作用于本项目所有内容窗口。正文字号不改变 PDF 或 Office 原件排版；阅读行宽仅影响 Markdown。'));
        for(const [key,label,options]of [['fontSize','正文字号',Array.from({length:14},(_,i)=>[i+11,(i+11)+' px'])],['conversationFontSize','对话与标签字号',Array.from({length:14},(_,i)=>[i+11,(i+11)+' px'])],['readingWidth','Markdown 阅读行宽',[[72,'72 字符'],[100,'100 字符']]]]){
          const input=field(container,label,select(options,values[key]));input.dataset.projectReading=key;
          input.onchange=()=>{const value=Number(input.value);status.textContent='正在保存…';queue=queue.catch(()=>{}).then(()=>guarded(async()=>{await call('workspace.settings',{projectId:id,workspace:{[key]:value}});if(current())status.textContent='已应用并保存到当前项目。';})).catch(error=>{if(current())status.textContent='未保存：'+error.message;});};
        }
      }else if(section==='settings-project-workspace'){
        const result=await call('workspace.layouts.list',{projectId:id});if(!current())return;
        const name=field(container,'布局名称',node('input'));name.maxLength=80;
        const reload=async(submittedEdit)=>{if(page.editVersion!==submittedEdit)return;if(pages.get(section+':'+id)===page)pages.delete(section+':'+id);if(!current())return;pages.delete(section);await refresh(section);};
        const save=button('保存当前布局',()=>guarded(async()=>{if(!name.value.trim())throw Error('请输入布局名称。');const edit=page.editVersion;await call('workspace.layouts.save',{projectId:id,name:name.value.trim()});await reload(edit);}));container.append(save);
        for(const item of result.layouts){
          const row=node('div');row.className='settings-card';row.append(node('strong',item.name));
          row.append(button('载入',()=>guarded(async()=>{await call('workspace.layouts.load',{projectId:id,name:item.name});status.textContent='布局已载入；正文与草稿保留。';})),button('重命名为上方名称',()=>guarded(async()=>{if(!name.value.trim())throw Error('请输入新名称。');const edit=page.editVersion;await call('workspace.layouts.rename',{projectId:id,name:item.name,newName:name.value.trim()});await reload(edit);})),button('删除布局记录',()=>guarded(async()=>{const edit=page.editVersion;await call('workspace.layouts.delete',{projectId:id,name:item.name});await reload(edit);})));container.append(row);
        }
        container.append(node('p','命名布局保存项目导航与分区，不保存正文副本。载入前宿主保存当前编辑现场。'));
      }else if(section==='settings-project-tex'){
        const data=await call('tex.inspect',{projectId:id});if(!current())return;
        if(!data.texFiles.length){status.textContent='当前项目没有 TeX 文件；编译配置不可用。';return;}
        const root=field(container,'根文档',select([['','请选择根文档'],...data.texFiles.map(value=>[value,value])],data.config.root));
        const engine=field(container,'编译引擎',select(Object.entries(data.tools).map(([key,available])=>[key,key+(available?'':'（未安装）')]),data.config.engine));
        container.append(node('p','仅点击编译时构建。预览读取当前 TeX 同目录同名 PDF，点击刷新才重读；编译成功可显示冻结产物。'));
        container.append(button('保存编译配置',()=>guarded(async()=>{await call('tex.configure',{projectId:id,root:root.value,engine:engine.value,automatic:false});page.dirty=false;status.textContent='编译配置已保存。';})));
      }else if(section==='settings-project-agents'){
        await renderAgents(container,status,id,current);
      }else{
        const {state={}}=await call('state.read',{projectId:id});if(!current())return;
        const count=Object.values(state?.workspace?.confirmationSkips||{}).filter(Boolean).length;
        container.append(node('p',`此项目已关闭 ${count} 类操作提醒。清空前台上下文等强制确认不受影响。`));
        container.append(button('恢复此项目的操作确认',()=>guarded(async()=>{const detail={projectId:id,result:null};document.dispatchEvent(new CustomEvent('nozeli-restore-confirmations',{detail}));if(!detail.result)throw Error('当前项目尚未就绪。');await detail.result;status.textContent='已恢复并保存此项目的操作确认。';})));
      }
      if(current()){page.ready=true;if(status.textContent==='正在读取…')status.textContent='';}
    }catch(error){if(current())status.textContent=error.message;}
  }
  return {refresh};
}
