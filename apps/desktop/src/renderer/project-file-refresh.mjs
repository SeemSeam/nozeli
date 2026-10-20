// Notifications invalidate the directory listing, never the open document.
export function mountProjectFileRefresh({subscribe,getProject,refresh,onError=()=>{},delay=120}){
  let slot=null,disposed=false;
  const current=s=>!disposed&&slot===s&&getProject()===s.project;
  function schedule(s){
    if(s.running||s.timer)return;
    s.timer=setTimeout(async()=>{
      s.timer=null;if(!current(s))return;
      s.running=true;s.dirty=false;
      try{await refresh(s.project);}catch(error){if(current(s))onError(error);}
      finally{s.running=false;if(current(s)&&s.dirty)schedule(s);}
    },delay);
  }
  const unsubscribe=subscribe(event=>{
    const project=getProject();
    if(disposed||event.kind!=='managed-files-changed'||!project||event.projectId!==project.id)return;
    if(slot?.project!==project){if(slot)clearTimeout(slot.timer);slot={project,running:false,dirty:false,timer:null};}
    slot.dirty=true;schedule(slot);
  });
  return {dispose(){disposed=true;if(slot)clearTimeout(slot.timer);unsubscribe?.();}};
}
