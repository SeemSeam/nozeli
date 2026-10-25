// Settings edit existing project contracts; no application/type/file inheritance.
export function mountProjectSettings({invoke,getProjectId}) {
  const sections=['settings-project-reading','settings-project-workspace','settings-project-tex','settings-project-confirmations'];
  const pages=new Map();
  window.nozeli.subscribe('workspace.control',event=>{if(event.type!=='settings')return;const page=pages.get('settings-project-reading:'+event.projectId);if(!page)return;const region=pages.get('settings-project-reading')===page?document.getElementById('settings-project-reading'):page.fragment;if(!region)return;for(const input of region.querySelectorAll('[data-project-reading]'))if(event.workspace?.[input.dataset.projectReading]!==undefined)input.value=String(event.workspace[input.dataset.projectReading]);});
  const call=async(op,payload={})=>{const result=await invoke(op,payload);if(!result.ok)throw Error(result.error?.message||'设置请求失败');return result.value;};
  const node=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
  function button(text,run){const n=node('button',text);n.type='button';n.onclick=()=>void Promise.resolve().then(run).catch(error=>{const status=n.closest('section').querySelector('[role="status"]');if(status)status.textContent=error.message;});return n;}
  function field(container,title,input){const label=node('label',title);label.append(input);container.append(label);return input;}
  function select(values,value){const input=node('select');for(const [key,title]of values)input.append(new Option(title,String(key)));input.value=String(value);return input;}
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
        const automatic=node('input');automatic.type='checkbox';automatic.checked=data.config.automatic;field(container,'自动编译',automatic);
        container.append(node('p','保存会取消当前编译；启用自动编译后，打开或修改 TeX 文档可能触发本地构建。编译、取消和预览仍在文件旁操作。'));
        container.append(button('保存编译配置',()=>guarded(async()=>{await call('tex.configure',{projectId:id,root:root.value,engine:engine.value,automatic:automatic.checked});page.dirty=false;status.textContent='编译配置已保存。';})));
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
