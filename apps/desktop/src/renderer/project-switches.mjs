// One reserved action slot and one replaceable intent; edits keep their FIFO slots.
export function createProjectSwitches({schedule,transition,current,ready,onPending=()=>{},onError=()=>{}}) {
  let active=null,pending=null,desired=null;
  const cancelled=projectId=>({ok:false,error:{code:'PROJECT_SWITCH_SUPERSEDED',message:'项目切换已被新的选择取代。'},projectId});
  function settle(request,result){for(const resolve of request.waiters)resolve(result);request.waiters=[];}
  function notify(){onPending(desired);}
  function start(request){
    active=request;
    void schedule(async()=>{
      // A queued slot has not begun touching its source: replace it in place.
      if(pending){settle(active,cancelled(active.id));active=pending;pending=null;}
      const running=active;
      let result;
      try {
        result=current()===running.id&&ready()?{ok:true,projectId:running.id}:await transition(running.id,{isCurrent:()=>desired===running.id});
        if(!result||typeof result.ok!=='boolean')throw Error('项目切换未返回完成状态');
      } catch(error){result={ok:false,error:{code:error.code||'PROJECT_SWITCH_FAILED',message:error.message}};onError(result.error);}
      settle(running,desired!==running.id?cancelled(running.id):result);
      active=null;
      // Failed retention/binding stops here. A later click must retry the source
      // barrier rather than silently continuing to the replacement destination.
      if(!result.ok&&result.error?.code!=='PROJECT_SWITCH_SUPERSEDED'){
        if(pending)settle(pending,result);
        pending=null;desired=null;notify();return result;
      }
      if(pending){const next=pending;pending=null;start(next);}
      else {desired=null;notify();}
      return result;
    });
  }
  return {request(id){
    if(!active&&current()===id&&ready())return Promise.resolve({ok:true,projectId:id});
    desired=id;
    const promise=new Promise(resolve=>{
      if(pending?.id===id){pending.waiters.push(resolve);return;}
      if(pending){settle(pending,cancelled(pending.id));pending=null;}
      if(active?.id===id){active.waiters.push(resolve);return;}
      const request={id,waiters:[resolve]};
      if(active)pending=request;else start(request);
    });
    notify();return promise;
  },pending:()=>desired};
}

export async function requireProjectSwitch(result){
  const receipt=await result;
  if(!receipt?.ok)throw Object.assign(new Error(receipt?.error?.message||'项目未能切换'),{code:receipt?.error?.code});
  return receipt;
}
