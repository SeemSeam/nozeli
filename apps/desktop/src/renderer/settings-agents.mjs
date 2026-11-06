import {fieldRow, disclosure} from './management-presentation.mjs';

const stateNames={sleeping:'休眠',waiting:'等待名额',reserved:'启动预留',starting:'启动中（已预留）',live:'存活',unconfirmed:'退出待确认（仍占用）',running:'运行中',idle:'空闲',closing:'关闭中'};
const roleNames={frontdesk:'前台',orchestrator:'主控'};

export function mountAgentSettings({invoke,container,getProjectId=()=>null}) {
  const node=(tag,text=null,attrs={})=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;for(const [key,value] of Object.entries(attrs))el.setAttribute(key,value);return el;};
  const form=node('form',null,{'data-agent-limits-form':''});
  const global=node('input',null,{'data-agent-global-limit':'',type:'number',min:'2',max:'64',required:'',autocomplete:'off'});
  const project=node('input',null,{'data-agent-project-limit':'',type:'number',min:'1',max:'16',required:'',autocomplete:'off'});
  // Occupancy lines double as the field hints so each row carries its own scope once.
  const globalUsed=node('p',null,{role:'status','data-agent-global-used':''});
  const projectUsed=node('p',null,{role:'status','data-agent-project-used':''});
  const projectScopeText=node('span','仅当前打开的项目');
  const counting=disclosure({key:'agent-limits-counting',label:'如何计数',content:[
    node('p','全局额度计前台、主控和工作助手的原生进程：启动前预留名额，确认进程退出后释放，不按模型回合计数。'),
    node('p','项目额度计当前项目开放的 Work：已关闭的 Work 不占用。'),
    node('p','降低额度不能低于当前占用，不会强杀已有任务；名额不足的工作保留在队列等待。不活跃项目的空闲 Agent 自动休眠释放进程，再次使用时恢复原线程，不重放消息。'),
  ]});
  const processStatus=node('p',null,{role:'status','data-agent-process-status':''});
  const occupancy=disclosure({key:'agent-limits-occupancy',label:'占用明细',content:processStatus});
  const message=node('p',null,{role:'status','data-agent-limits-status':''});
  const save=node('button','保存额度',{type:'submit',class:'ui-action','data-ui-action':'primary','data-agent-limits-save':''});
  save.disabled=true;
  const projectScope=fieldRow({label:'项目开放任务上限',control:project,scope:projectScopeText,hint:projectUsed});
  form.append(
    fieldRow({label:'全局会话进程上限',control:global,scope:'所有项目',hint:globalUsed}),
    projectScope,
    counting,occupancy,message,save,
  );
  container.replaceChildren(node('h3','Agent 资源'),form);
  let generation=0,loadedProject,loaded=false,dirty=false,editVersion=0,saving=false,refreshPending=false;
  form.addEventListener('input',()=>{dirty=true;editVersion++;});
  const call=async(op,payload)=>{const result=await invoke('settings.agents.'+op,payload);if(!result?.ok)throw Error(result?.error?.message||'Agent 额度请求失败');return result.value;};
  function render(status,id){
    global.value=status.globalLimit;project.value=id?status.projectLimit:'';project.disabled=!id;
    const projectName=id?(document.getElementById('project-name')?.textContent||'').trim():'';
    projectScopeText.textContent=projectName?'当前项目：'+projectName:'仅当前打开的项目';
    globalUsed.textContent=`当前占用 ${status.globalUsed} / ${status.globalLimit} 个存活 Agent；空闲会话也占用。`;
    projectUsed.textContent=id?`当前占用 ${status.projectUsed} / ${status.projectLimit} 项开放任务；暂停、待审阅、收尾中的任务仍占用。`:'尚未打开项目；项目开放任务上限不可修改，全局额度仍可保存。';
    const agents=status.agents||[];
    occupancy.hidden=!agents.length;
    processStatus.textContent=agents.map(agent=>`${agent.projectName||'其他项目'} · ${roleNames[agent.target]||agent.workName||'工作助手'}：${stateNames[agent.state]||agent.state}${agent.blockedReason?'（'+agent.blockedReason+'）':''}`).join('；');
  }
  async function refresh(){
    if(saving){refreshPending=true;return;}
    if(dirty&&loaded){if(loadedProject!==getProjectId()){save.disabled=true;message.textContent='项目已切换；未保存输入保留在原项目，返回原项目后可继续保存。';}else save.disabled=false;return;}
    const version=++generation,id=getProjectId()||null;loaded=false;save.disabled=true;project.disabled=true;message.textContent='正在读取 Agent 额度…';
    try{const status=await call('status',id?{projectId:id}:{});if(version!==generation)return;loadedProject=id;loaded=true;render(status,id);message.textContent='';save.disabled=false;}
    catch(error){if(version===generation)message.textContent=error.message;}
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!loaded||saving||save.disabled)return;
    const id=getProjectId()||null;if(id!==loadedProject){await refresh();return;}
    if(!form.reportValidity())return;
    const version=++generation,submittedEdit=editVersion;saving=true;save.disabled=true;message.textContent='正在保存…';
    try{const status=await call('save',{globalLimit:Number(global.value),...(id?{projectId:id,projectLimit:Number(project.value)}:{})});if(version!==generation)return;if(editVersion===submittedEdit){dirty=false;if(id===(getProjectId()||null)){render(status,id);message.textContent='Agent 额度已保存。';}}else message.textContent='已保存上次提交；当前新输入尚未保存。';}
    catch(error){if(version===generation)message.textContent=error.message;}
    finally{saving=false;if(version===generation)save.disabled=id!==(getProjectId()||null);if(refreshPending||id!==(getProjectId()||null)){refreshPending=false;await refresh();}}
  });
  return {refresh,projectChanged:refresh};
}
