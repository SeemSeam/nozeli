export function mountAgentSettings({invoke,container,getProjectId=()=>null}) {
  container.innerHTML=`<h3>Agent 额度</h3>
    <form data-agent-limits-form>
      <div class="settings-scope-divider">通用设置 · 所有项目共享</div>
      <div class="settings-card"><label>全局存活总 Agent 数 <input data-agent-global-limit type="number" min="2" max="64" required></label><p data-agent-global-used role="status"></p><p class="settings-hint">所有项目共享。前台、主控和 Worker 的原生进程均计数，空闲也占用；启动前预留名额，确认进程退出后释放，不按模型回合计数。</p></div>
      <div class="settings-scope-divider">当前项目设置 · 仅作用于当前打开的项目</div>
      <div class="settings-card"><label>当前项目 Worker 数 <input data-agent-project-limit type="number" min="1" max="16" required></label><p data-agent-project-used role="status"></p><p class="settings-hint">限制当前项目同时开放的 Work，不是仅运行中的进程数。paused（暂停）、review（待审阅）和 closing（关闭中）仍占额度；已关闭 Work 不占用。</p></div>
      <p class="settings-hint">降低额度不能低于当前占用，不会强杀已有任务；名额不足的工作保留在队列等待。不活跃项目的安全空闲 Agent 自动休眠释放进程；运行任务和原生终端未发送输入受保护。再次使用时恢复原线程，不重放消息。</p>
      <p data-agent-process-status role="status"></p><p data-agent-limits-status role="status"></p><button type="submit" data-agent-limits-save disabled>保存额度</button>
    </form>`;
  const $=selector=>container.querySelector(selector),form=$('[data-agent-limits-form]'),global=$('[data-agent-global-limit]'),project=$('[data-agent-project-limit]'),save=$('[data-agent-limits-save]'),message=$('[data-agent-limits-status]');
  let generation=0,loadedProject,loaded=false;
  const call=async(op,payload)=>{const result=await invoke('settings.agents.'+op,payload);if(!result?.ok)throw Error(result?.error?.message||'Agent 额度请求失败');return result.value;};
  function render(status,id){
    global.value=status.globalLimit;project.value=id?status.projectLimit:'';project.disabled=!id;
    $('[data-agent-global-used]').textContent=`当前占用：${status.globalUsed} / ${status.globalLimit} 个存活 Agent`;
    $('[data-agent-project-used]').textContent=id?`当前占用：${status.projectUsed} / ${status.projectLimit} 个开放 Work`:'尚未打开项目；当前项目 Worker 数不可修改，全局额度仍可保存。';
    const names={sleeping:'休眠',waiting:'等待名额',reserved:'启动预留',starting:'启动中（已预留）',live:'存活',unconfirmed:'退出待确认（仍占用）',running:'运行中',idle:'空闲',closing:'关闭中'};
    const roleNames={frontdesk:'前台',orchestrator:'主控'};
    $('[data-agent-process-status]').textContent=(status.agents||[]).map(agent=>`${agent.projectName||'其他项目'} · ${roleNames[agent.target]||agent.workName||'Worker'}：${names[agent.state]||agent.state}${agent.blockedReason?'（'+agent.blockedReason+'）':''}`).join('；');
  }
  async function refresh(){
    const version=++generation,id=getProjectId()||null;loaded=false;save.disabled=true;project.disabled=true;message.textContent='正在读取 Agent 额度…';
    try{const status=await call('status',id?{projectId:id}:{});if(version!==generation)return;loadedProject=id;loaded=true;render(status,id);message.textContent='';save.disabled=false;}
    catch(error){if(version===generation)message.textContent=error.message;}
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!loaded||save.disabled)return;
    const id=getProjectId()||null;if(id!==loadedProject){await refresh();return;}
    if(!form.reportValidity())return;
    const version=++generation;save.disabled=true;message.textContent='正在保存…';
    try{const status=await call('save',{globalLimit:Number(global.value),...(id?{projectId:id,projectLimit:Number(project.value)}:{})});if(version!==generation)return;render(status,id);message.textContent='Agent 额度已保存。';}
    catch(error){if(version===generation)message.textContent=error.message;}
    finally{if(version===generation)save.disabled=false;}
  });
  return {refresh};
}
