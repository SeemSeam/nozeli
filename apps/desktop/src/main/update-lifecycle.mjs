// Update restarts are stricter than ordinary close: never save over a dirty
// original or cancel a business task just to make an update installable.
export function createUpdateLifecycle({workspace,host,managedAgents,agents,powerMonitor,isClosing,freeze,quit,idleSeconds=60}){
  let frozen=false;
  async function canInstall(){
    if(isClosing())return {ready:false,reason:'正在关闭或处理其他生命周期操作'};
    if(workspace.onlineBrowser?.slots.size)return {ready:false,reason:'请先关闭网站工作面，避免自动更新丢失网页表单输入'};
    if(powerMonitor.getSystemIdleTime()<idleSeconds)return {ready:false,reason:'等待系统空闲至少一分钟'};
    if(host.active||workspace.receipts.size||workspace.lifecycle.size||workspace.drags.size)return {ready:false,reason:'等待文件操作与保存回执完成'};
    if(agents?.busy()||managedAgents?.busy())return {ready:false,reason:'等待后台任务结束'};
    for(const c of managedAgents?.controllers.values()||[]){
      if(c.starting?.size||c.closures?.size||c.running?.size||c.nativeDraftTargets?.size||c.externalTerminalTargets?.size||c.store.state.jobs.some(j=>['queued','running','unknown','cancelling'].includes(j.status)))return {ready:false,reason:'后台仍有待执行任务、未确认操作或终端输入'};
    }
    const records=[...workspace.senders.values()].filter(r=>!r.dead&&!['demo-controls','demo-hint'].includes(r.role));
    if(!records.length)return {ready:false,reason:'等待主窗口就绪'};
    for(const r of records){
      if(!r.ready||r.contentFailed||r.transferring||r.held||r.recoveryHeld||r.syncHolds?.size)return {ready:false,reason:'有阅读面尚未就绪或正在保留编辑'};
      if(r.kind==='terminal')continue;
      let state,timer;
      try{state=await Promise.race([r.wc.executeJavaScript('window.__nozeliUpdateState?.()'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('更新就绪查询超时')),3000);timer.unref?.();})]);}catch{return {ready:false,reason:'无法确认全部阅读面的保存状态'};}finally{clearTimeout(timer);}
      if(!state?.ready||state.dirty||state.blocked)return {ready:false,reason:'有未保存编辑、输入组合、打开的对话框或待处理操作'};
    }
    if(host.active||agents?.busy()||managedAgents?.busy()||powerMonitor.getSystemIdleTime()<idleSeconds)return {ready:false,reason:'检测期间出现新的活动，稍后再更新'};
    return {ready:true,reason:''};
  }
  async function prepareShutdown(){
    if(!(await canInstall()).ready)return false;
    frozen=true;freeze(true);
    try{await workspace.flush([...workspace.senders.values()]);await host.settled();if(!(await canInstall()).ready){resumeShutdown();return false;}return true;}
    catch(error){resumeShutdown();throw error;}
  }
  function resumeShutdown(){if(!frozen)return;frozen=false;freeze(false);}
  async function finish(){
    if(!frozen||!(await canInstall()).ready)throw Error('出现新活动，已取消自动重启');
    // Only idle services reach this point; do not cancel running work.
    await managedAgents?.stop();await agents?.stopIdle?.();await host.settled();
    await quit();
  }
  return {canInstall,prepareShutdown,resumeShutdown,quit:finish};
}
