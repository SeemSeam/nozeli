// Deadline-driven owner expiry. Controller remains the authority for safe stops.
export class AgentIdleLifecycle {
 constructor({controllers,idleTimeoutMs=300000,clock={now:()=>performance.now(),setTimeout,clearTimeout},onError=()=>{}}){
  if(!Number.isFinite(idleTimeoutMs)||idleTimeoutMs<0)throw new TypeError('Invalid idle timeout');
  Object.assign(this,{controllers,idleTimeoutMs,clock,onError});this.entries=new Map();this.failed=new WeakSet();this.timer=null;this.flight=null;this.pending=false;this.stopped=false;
 }
 observe(){
  if(this.stopped)return;
  const now=this.clock.now();
  for(const [id,entry] of this.entries)if(this.controllers.get(id)!==entry.controller||entry.controller.stopping||entry.controller.store?.offline)this.entries.delete(id);
  for(const [id,controller] of this.controllers){
   if(controller.stopping||controller.store?.offline)continue;
   let entry=this.entries.get(id);if(!entry){entry={controller,targets:new Map()};this.entries.set(id,entry);}
   for(const [target,record] of entry.targets)if(controller.sessions?.get(target)!==record.session||!controller.canReclaimIdle?.(target,record.session))entry.targets.delete(target);
   for(const [target,session] of controller.sessions??[]){
    if(!this.failed.has(session)&&controller.canReclaimIdle?.(target,session)&&!entry.targets.has(target))entry.targets.set(target,{session,since:now});
   }
  }
  this.queue();
 }
 observeTarget(id,controller,target){
  if(this.stopped||this.controllers.get(id)!==controller)return;
  if(controller.stopping||controller.store?.offline){this.forget(id);return;}
  let entry=this.entries.get(id);
  if(entry?.controller!==controller){entry={controller,targets:new Map()};this.entries.set(id,entry);}
  const session=controller.sessions?.get(target),record=entry.targets.get(target);
  if(!session||this.failed.has(session)||!controller.canReclaimIdle?.(target,session)){
   if(record){entry.targets.delete(target);this.queue();}return;
  }
  if(record?.session!==session){entry.targets.set(target,{session,since:this.clock.now()});this.queue();}
 }
 forget(id){this.entries.delete(id);this.queue();}
 queue(){
  if(this.stopped)return;
  this.pending=true;if(this.flight)return;
  this.flight=Promise.resolve().then(async()=>{
   while(this.pending&&!this.stopped){this.pending=false;await this.expire();}
  }).finally(()=>{this.flight=null;if(this.pending&&!this.stopped)this.queue();else this.arm();});
  // Controller eligibility is synchronous; reclaim failures are handled per owner.
  this.flight.catch(()=>{});
 }
 async expire(){
  for(const [id,entry] of this.entries){
   for(const [target,record] of entry.targets){
    if(this.stopped)return;
    const c=entry.controller;
    if(this.controllers.get(id)!==c||c.stopping||c.store?.offline||c.sessions?.get(target)!==record.session||!c.canReclaimIdle?.(target,record.session)){entry.targets.delete(target);continue;}
    if(this.clock.now()-record.since<this.idleTimeoutMs)continue;
    // Remove before awaiting: state events from the stop cannot run a second stop.
    entry.targets.delete(target);this.failed.add(record.session);
    try{if(await c.reclaimIdle(target)===false){this.failed.delete(record.session);this.observe();}}catch(error){this.onError(id,error);}
   }
  }
 }
 arm(){
  if(this.timer!==null){this.clock.clearTimeout(this.timer);this.timer=null;}
  if(this.stopped)return;
  let deadline=Infinity;
  for(const entry of this.entries.values())for(const record of entry.targets.values())deadline=Math.min(deadline,record.since+this.idleTimeoutMs);
  if(deadline===Infinity)return;
  this.timer=this.clock.setTimeout(()=>{this.timer=null;this.observe();},Math.max(0,deadline-this.clock.now()));this.timer?.unref?.();
 }
 stop(){this.stopped=true;if(this.timer!==null)this.clock.clearTimeout(this.timer);this.timer=null;this.entries.clear();}
}
