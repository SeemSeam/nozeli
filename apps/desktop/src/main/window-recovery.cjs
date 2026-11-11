const {randomUUID} = require('node:crypto');
const windows = new WeakMap();

// Main owns this state: the page may be dead or may change while saving settles.
class WindowRecovery {
  constructor(win, {dialog, settle, busy, stop, onClose, reveal, prepareClose=null, forceQuit=null, timeoutMs=8000, setTimer=setTimeout, clearTimer=clearTimeout, report=console.error}) {
    Object.assign(this, {win, wc:win.webContents, dialog, settle, busy, stop, onClose, reveal, prepareClose, forceQuit, timeoutMs, setTimer, clearTimer, report});
    this.generation=0;this.pending=null;this.prompt=null;this.phase='ready';this.gone=false;this.dismissed=new Set();this.forced=false;
    windows.set(win,this);
  }
  alive(){return !this.win.isDestroyed()&&!this.wc.isDestroyed()&&this.win.webContents===this.wc;}
  current(p){return this.alive()&&this.pending===p&&p.generation===this.generation;}
  invalidate(){if(this.pending)this.clearTimer(this.pending.timer);this.pending=null;}
  navigation(){this.generation++;this.invalidate();this.gone=false;this.phase='loading';this.dismissed.clear();}
  loaded(){if(this.alive()){this.gone=false;this.phase='ready';}}
  destroyed(){this.generation++;this.invalidate();this.prompt=null;}
  rendererGone(details){
    if(!this.alive())return;
    if(!this.gone){this.generation++;this.invalidate();this.gone=true;this.phase='renderer-gone';}
    this.offer('gone',details);
  }
  requestClose(){
    if(!this.alive()||this.forced||this.pending||this.prompt)return;
    if(this.gone){this.offer('gone',{},true);return;}
    // Only an admitted user close retries cancelled close failures. Automatic
    // repeats and coalesced closes retain their cancellation/deduplication.
    for(const reason of ['timeout','save-failed','stop-failed','prepare-failed'])this.dismissed.delete(this.generation+':'+reason);
    const p={id:randomUUID(),generation:this.generation,stage:'preparing'};
    this.pending=p;this.phase='flush-pending';
    p.timer=this.setTimer(()=>this.stall(p),this.timeoutMs);
    void this.prepare(p).catch(error=>this.report('close prepare failed',error));
  }
  // prepareClose runs before the flush request under the same watchdog: a hung
  // or failing preparation (e.g. finishing an active drawing capture) must
  // reach this same native recovery dialog instead of wedging the exit.
  async prepare(p){
    try{
      if(this.prepareClose)await this.prepareClose();
    }catch(error){
      if(!this.current(p))return;
      if(p.stage==='stalled'){if(!p.parked)p.parked={kind:'prepare-failed',error};this.report('close prepare failed',error);return;}
      this.invalidate();this.phase='prepare-failed';this.offer('prepare-failed',error);this.report('close prepare failed',error);
      return;
    }
    if(!this.current(p))return;
    if(p.stage==='stalled'){if(!p.parked)p.parked={kind:'prepared'};return;}
    this.sendFlush(p);
  }
  sendFlush(p){
    p.stage='waiting';
    try{this.wc.send('nozeli:flush',p.id);}catch(error){
      if(this.current(p)){this.invalidate();this.phase='save-unconfirmed';this.offer('timeout');}
      this.report('close flush send failed',error);
    }
  }
  // The supervision keeps the waiter bound to its request/generation: a late
  // ack can still resume this close (never a newer one), and an expired save is
  // never approved without the user's explicit choice to keep waiting.
  stall(p){
    if(!this.current(p)||p.stage==='stalled')return;
    this.clearTimer(p.timer);
    p.stalledFrom=p.stage;p.stage='stalled';
    this.phase='save-unconfirmed';this.offer('timeout');
  }
  async acknowledge(sender,payload){
    const p=this.pending;
    if(!p||!this.current(p)||sender!==this.wc||payload?.requestId!==p.id)return {accepted:false};
    if(p.stage==='stalled'){
      if(p.stalledFrom==='waiting'&&!p.parked)p.parked={kind:'ack',ok:payload.ok===true,error:payload.error};
      return {accepted:false};
    }
    if(p.stage!=='waiting')return {accepted:false};
    p.stage='settling';
    try{await this.settle();}catch(error){
      if(!this.current(p))return {accepted:false};
      if(p.stage==='stalled'){if(!p.parked)p.parked={kind:'outcome',ok:false,error};throw error;}
      this.invalidate();this.phase='save-unconfirmed';this.offer('save-failed',error);
      throw error;
    }
    // Never fetch a different waiter after the await: it may belong to a new close.
    if(!this.current(p))return {accepted:false};
    if(p.stage==='stalled'){if(!p.parked)p.parked={kind:'outcome',ok:payload.ok===true,error:payload.error};return {accepted:false};}
    return this.complete(p,payload);
  }
  async complete(p,payload){
    this.clearTimer(p.timer);
    if(!payload.ok){this.invalidate();this.phase='save-unconfirmed';this.reveal();this.offer('save-failed',payload.error);return {accepted:true};}
    if(this.busy()){
      this.invalidate();this.phase='agent-busy';this.reveal();this.wc.send('nozeli:quit-confirm');return {accepted:true};}
    p.stage='stopping';
    // A hanging cleanup must not make the window unreachable: supervise stop
    // with the same bounded timeout and keep the recovery choice with the user.
    p.timer=this.setTimer(()=>{
      if(!this.current(p))return;
      this.invalidate();this.phase='stop-failed';
      this.offer('stop-failed',Object.assign(Error('等待清理完成超时。'),{code:'STOP_STALLED'}));
    },this.timeoutMs);
    try{await this.stop({isCurrent:()=>this.current(p)});}catch(error){
      if(!this.current(p))return {accepted:false};
      this.invalidate();this.phase='stop-failed';this.offer('stop-failed',error);this.report('close cleanup failed',error);return {accepted:true};
    }
    if(!this.current(p))return {accepted:false};
    this.invalidate();this.phase='closing';
    try{this.onClose();}catch(error){this.phase='stop-failed';this.offer('stop-failed',error);this.report('native window close failed',error);}
    return {accepted:true};
  }
  // 继续等待 (and cancelling a confirmation) resumes the real in-flight close:
  // re-supervise it, or continue it from whatever outcome parked while the
  // recovery dialog was deciding.
  async resume(){
    const p=this.pending;
    if(!p||!this.current(p)||p.stage!=='stalled')return;
    this.dismissed.delete(this.generation+':timeout');
    if(p.parked){
      const parked=p.parked;delete p.parked;
      if(parked.kind==='prepare-failed'){this.invalidate();this.phase='prepare-failed';this.offer('prepare-failed',parked.error);return;}
      if(parked.kind==='prepared'){this.phase='flush-pending';this.sendFlush(p);if(this.current(p))p.timer=this.setTimer(()=>this.stall(p),this.timeoutMs);return;}
      if(parked.kind==='ack'){this.phase='flush-pending';p.stage='waiting';p.timer=this.setTimer(()=>this.stall(p),this.timeoutMs);return this.acknowledge(this.wc,{requestId:p.id,ok:parked.ok,error:parked.error});}
      if(parked.kind==='reload-ready'){this.navigation();this.wc.reload();return;}
      if(parked.kind==='reload-failed'){this.invalidate();this.phase='save-unconfirmed';this.offer('save-failed',parked.error);return;}
      return this.complete(p,parked);
    }
    this.phase='flush-pending';
    p.stage=p.stalledFrom;
    p.timer=this.setTimer(()=>this.stall(p),this.timeoutMs);
  }
  validPrompt(ticket){return this.alive()&&this.prompt===ticket&&ticket.generation===this.generation;}
  offer(reason,details={},explicit=false){
    if(this.forced)return;
    const key=this.generation+':'+reason;
    if(!this.alive()||this.prompt||(!explicit&&this.dismissed.has(key)))return;
    const ticket={generation:this.generation,reason,key};this.prompt=ticket;
    // Detached only from the IPC caller, never from the dialog identity.
    void this.recover(ticket,details).catch(error=>this.report('workspace recovery failed',error)).finally(()=>{
      if(this.prompt===ticket)this.prompt=null;
    });
  }
  async recover(ticket,details){
    const messages={gone:'工作区页面已退出。',timeout:'工作区暂未响应，关闭前保存尚未确认。','save-failed':'关闭前未能确认保存完成。','stop-failed':'关闭清理未完成，窗口已保留。','prepare-failed':'关闭准备未完成，窗口已保留。'};
    const causes={'save-failed':'保存失败：','stop-failed':'清理未完成：','prepare-failed':'准备失败：'};
    const fallbacks={'save-failed':'工作区未确认保存，请检查保存提示并重试关闭。','stop-failed':'清理被拒绝或未完成，请重试关闭。','prepare-failed':'关闭前的准备步骤未完成，请重试关闭。'};
    const first={timeout:'继续等待',gone:'继续等待','save-failed':'返回工作区','stop-failed':'返回检查','prepare-failed':'返回工作区'}[ticket.reason];
    const buttons=[first,'重新加载工作区…'];
    if(this.forceQuit)buttons.push('强制退出…');
    const response=await this.dialog.showMessageBox(this.win,{type:'none',title:'工作区恢复',message:messages[ticket.reason],
      detail:(causes[ticket.reason]?causes[ticket.reason]+String(details?.message||fallbacks[ticket.reason])+' ':'')+'已持久化的文件和草稿将保留。未获得保存确认的输入可能仅在内存中；重新加载可能丢失这些输入。'+(ticket.reason==='gone'?' 页面退出原因：'+String(details.reason||'未知')+'。':'')+(this.forceQuit?' 强制退出将不再等待保存或清理，直接终止整个应用。':''),
      buttons,defaultId:0,cancelId:0,noLink:true});
    if(!this.validPrompt(ticket))return;
    if(response.response===2&&this.forceQuit){
      const confirmed=await this.dialog.showMessageBox(this.win,{type:'warning',title:'确认强制退出',message:'强制退出会立即终止 Nozeli 的全部窗口，不再等待保存或清理。',
        detail:'未确认保存的输入可能丢失；正在运行的 Agent 任务和网站会话会被终止，不会重放，也不会被记为已完成。已写入磁盘的文件、草稿和恢复记录保留。',
        buttons:['取消','强制退出'],defaultId:0,cancelId:0,noLink:true});
      if(!this.validPrompt(ticket))return;
      if(confirmed.response!==1){this.dismissed.add(ticket.key);this.prompt=null;await this.resume();return;}
      // Terminal native exit: the callback owns the process; never wait for
      // settle/stop/page afterwards and never treat this close as confirmed.
      this.forced=true;this.invalidate();this.phase='force-quitting';this.forceQuit();
      return;
    }
    if(response.response!==1){this.dismissed.add(ticket.key);this.prompt=null;await this.resume();return;}
    const confirmed=await this.dialog.showMessageBox(this.win,{type:'none',title:'确认重新加载',message:'重新加载可能丢失未保存的输入。',
      detail:'程序会先等待已在途的文件保存完成。无法确认仅存内存的输入能恢复；不会强制退出、取消 Agent 或重新执行任务。',
      buttons:['取消','确认重新加载'],defaultId:0,cancelId:0,noLink:true});
    if(!this.validPrompt(ticket))return;
    if(confirmed.response!==1){this.dismissed.add(ticket.key);this.prompt=null;await this.resume();return;}
    // Reload settlement also remains supervised; it must not hide force exit.
    this.invalidate();this.prompt=null;
    const p={id:randomUUID(),generation:this.generation,stage:'settling'};
    this.pending=p;this.phase='flush-pending';p.timer=this.setTimer(()=>this.stall(p),this.timeoutMs);
    try{await this.settle();}catch(error){
      if(!this.current(p))return;
      if(p.stage==='stalled'){p.parked={kind:'reload-failed',error};return;}
      this.invalidate();this.phase='save-unconfirmed';this.offer('save-failed',error);
      this.report('recovery save settlement failed',error);return;
    }
    if(!this.current(p))return;
    if(p.stage==='stalled'){p.parked={kind:'reload-ready'};return;}
    this.navigation();this.wc.reload();
  }
  snapshot(){return {generation:this.generation,phase:this.phase,pending:this.pending?{id:this.pending.id,generation:this.pending.generation,stage:this.pending.stage,parked:Boolean(this.pending.parked)}:null,prompt:this.prompt?{reason:this.prompt.reason,generation:this.prompt.generation}:null,forced:this.forced};}
}
module.exports={WindowRecovery,forWindow:win=>windows.get(win)};
