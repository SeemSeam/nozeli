const roleNames={frontdesk:'前台',orchestrator:'后台任务 · 主控',worker:'原 Worker'};

// A choice belongs to one composer, project, role and submission, never to routing.
export function createImportedSkillPicker({invoke,role,target}){
  const root=document.createElement('details'),summary=document.createElement('summary');
  const label=document.createElement('label'),select=document.createElement('select');
  const refresh=document.createElement('button'),status=document.createElement('span');
  let projectId=null, generation=0, choices=new Map(), selected=null;
  root.className='imported-skill-picker';root.dataset.skillRole=role;
  select.dataset.importedSkill=role;label.append(`${roleNames[role]}技能 `,select);
  refresh.type='button';refresh.textContent='刷新';status.setAttribute('role','status');
  root.append(summary,label,refresh,status);
  function paint(){summary.textContent=`${roleNames[role]}技能：${selected?selected.name+' · '+selected.version:'不使用'}`;}
  function reset(){selected=null;select.value='';paint();}
  function bind(id){
    if(projectId===id)return;
    generation++;projectId=id;root.open=false;choices.clear();select.replaceChildren(new Option('不使用',''));status.textContent='';reset();
  }
  async function load(){
    if(!projectId||!target)return;
    const ticket=++generation;status.textContent='读取中…';
    try{
      const result=await invoke('managed.skill.options',{projectId,target});
      if(ticket!==generation)return;
      if(!result.ok)throw Error(result.error.message);
      choices=new Map(result.value.map(row=>[JSON.stringify([row.id,row.version]),row]));
      select.replaceChildren(new Option('不使用',''));
      for(const [key,row] of choices)select.add(new Option(`${row.name} · ${row.version}`,key));
      if(selected){
        const key=JSON.stringify([selected.id,selected.version]);
        if(!choices.has(key))select.add(new Option(`${selected.name} · 已不可用（请重新选择）`,key));
        select.value=key;
      }
      status.textContent=selected&&!choices.has(select.value)?'已选技能不可用；请重新选择。':choices.size?'仅用于这次发送':'此角色没有在当前项目启用的技能';
    }catch(error){if(ticket===generation)status.textContent='读取失败：'+error.message;}
  }
  refresh.onclick=load;root.ontoggle=()=>{if(root.open)void load();};
  const unsubscribe=window.nozeli?.subscribe('workspace.control',event=>{if(event.type==='imported-skills-changed'&&event.projectId===projectId&&root.open&&root.isConnected)void load();});
  window.addEventListener('pagehide',()=>unsubscribe?.(),{once:true});
  select.onchange=()=>{selected=choices.get(select.value)||null;paint();};
  paint();
  return {root,bind,selection(id){return projectId===id&&selected?{id:selected.id,version:selected.version}:null;},accepted(id,ref){if(id===projectId&&ref&&ref.id===selected?.id&&ref.version===selected?.version)reset();}};
}
