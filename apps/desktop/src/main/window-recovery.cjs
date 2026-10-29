const {randomUUID} = require('node:crypto');
const windows = new WeakMap();

// Main owns this state: the page may be dead or may change while saving settles.
class WindowRecovery {
  constructor(win, {dialog, settle, busy, stop, onClose, reveal, timeoutMs=8000, setTimer=setTimeout, clearTimer=clearTimeout, report=console.error}) {
    Object.assign(this, {win, wc:win.webContents, dialog, settle, busy, stop, onClose, reveal, timeoutMs, setTimer, clearTimer, report});
    this.generation=0;this.pending=null;this.prompt=null;this.phase='ready';this.gone=false;this.dismissed=new Set();
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
    if(!this.alive()||this.pending||this.prompt)return;
    if(this.gone){this.offer('gone',{},true);return;}
    // Only an admitted user close retries cancelled close failures. Automatic
    // repeats and coalesced closes retain their cancellation/deduplication.
    for(const reason of ['timeout','save-failed','stop-failed'])this.dismissed.delete(this.generation+':'+reason);
    const p={id:randomUUID(),generation:this.generation,stage:'waiting'};
    this.pending=p;this.phase='flush-pending';
    p.timer=this.setTimer(()=>{
      if(!this.current(p))return;
      this.invalidate();this.phase='save-unconfirmed';this.offer('timeout');
    },this.timeoutMs);
    try{this.wc.send('nozeli:flush',p.id);}catch(error){
      if(this.current(p)){this.invalidate();this.phase='save-unconfirmed';this.offer('timeout');}
      this.report('close flush send failed',error);
    }
  }
  async acknowledge(sender,payload){
    const p=this.pending;
    if(!p||!this.current(p)||sender!==this.wc||payload?.requestId!==p.id||p.stage!=='waiting')return {accepted:false};
    p.stage='settling';
    try{await this.settle();}catch(error){
      if(!this.current(p))return {accepted:false};
      this.invalidate();this.phase='save-unconfirmed';this.offer('save-failed');
      throw error;
    }
    // Never fetch a different waiter after the await: it may belong to a new close.
    if(!this.current(p))return {accepted:false};
    this.clearTimer(p.timer);
    if(!payload.ok){this.invalidate();this.phase='save-unconfirmed';this.reveal();this.offer('save-failed',payload.error);return {accepted:true};}
    if(this.busy()){
      this.invalidate();this.phase='agent-busy';this.reveal();this.wc.send('nozeli:quit-confirm');return {accepted:true};
    }
    p.stage='stopping';
    try{await this.stop();}catch(error){
      if(!this.current(p))return {accepted:false};
      this.invalidate();this.phase='stop-failed';this.offer('stop-failed');this.report('close cleanup failed',error);return {accepted:true};
    }
    if(!this.current(p))return {accepted:false};
    p.stage='closing';this.phase='closing';
    try{await this.onClose();this.invalidate();}catch(error){
      if(this.current(p)){this.invalidate();this.phase='stop-failed';this.offer('stop-failed');}
      this.report('window close failed',error);
    }
    return {accepted:true};
  }
  validPrompt(ticket){return this.alive()&&this.prompt===ticket&&ticket.generation===this.generation;}
  offer(reason,details={},explicit=false){
    const key=this.generation+':'+reason;
    if(!this.alive()||this.prompt||(!explicit&&this.dismissed.has(key)))return;
    const ticket={generation:this.generation,reason,key};this.prompt=ticket;
    // Detached only from the IPC caller, never from the dialog identity.
    void this.recover(ticket,details).catch(error=>this.report('workspace recovery failed',error)).finally(()=>{
      if(this.prompt===ticket)this.prompt=null;
    });
  }
  async recover(ticket,details){
    const messages={gone:'工作区页面已退出。',timeout:'工作区暂未响应，关闭前保存尚未确认。','save-failed':'关闭前未能确认保存完成。','stop-failed':'关闭清理未完成，窗口已保留。'};
    const response=await this.dialog.showMessageBox(this.win,{type:'none',title:'工作区恢复',message:messages[ticket.reason],
      detail:(ticket.reason==='save-failed'?'保存失败：'+String(details?.message||'工作区未确认保存，请检查保存提示并重试关闭。')+' ':'')+'已持久化的文件和草稿将保留。未获得保存确认的输入可能仅在内存中；重新加载可能丢失这些输入。'+(ticket.reason==='gone'?' 页面退出原因：'+String(details.reason||'未知')+'。':''),
      buttons:['继续等待','重新加载工作区…'],defaultId:0,cancelId:0,noLink:true});
    if(!this.validPrompt(ticket))return;
    if(response.response!==1){this.dismissed.add(ticket.key);return;}
    const confirmed=await this.dialog.showMessageBox(this.win,{type:'none',title:'确认重新加载',message:'重新加载可能丢失未保存的输入。',
      detail:'程序会先等待已在途的文件保存完成。无法确认仅存内存的输入能恢复；不会强制退出、取消 Agent 或重新执行任务。',
      buttons:['取消','确认重新加载'],defaultId:0,cancelId:0,noLink:true});
    if(!this.validPrompt(ticket))return;
    if(confirmed.response!==1){this.dismissed.add(ticket.key);return;}
    try{await this.settle();}catch(error){
      if(!this.validPrompt(ticket))return;
      this.phase='save-unconfirmed';
      await this.dialog.showMessageBox(this.win,{type:'none',title:'工作区已保留',message:'未能确认在途保存完成，未重新加载。',
        detail:'请继续等待或检查保存问题。磁盘材料未被丢弃。',buttons:['保留窗口'],defaultId:0,cancelId:0,noLink:true});
      this.report('recovery save settlement failed',error);return;
    }
    if(!this.validPrompt(ticket))return;
    this.navigation();this.wc.reload();
  }
  snapshot(){return {generation:this.generation,phase:this.phase,pending:this.pending?{id:this.pending.id,generation:this.pending.generation,stage:this.pending.stage}:null,prompt:this.prompt?{reason:this.prompt.reason,generation:this.prompt.generation}:null};}
}
module.exports={WindowRecovery,forWindow:win=>windows.get(win)};
