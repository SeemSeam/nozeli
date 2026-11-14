const fail=(code,message)=>Object.assign(new Error(message),{code});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const requestKey=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
// Request ownership is the trusted shell record, never a renderer-supplied window id.
export class ProjectSearchSessions {
 constructor({host,workspace,engine,readDocument}){Object.assign(this,{host,workspace,engine,readDocument});this.sessions=new Map();this.owners=new WeakSet();this.closed=false;}
 current(session){return !this.closed&&!session.owner.dead&&session.owner.projectId===session.projectId&&session.owner.generation===session.generation&&!this.workspace.lifecycle.has(session.projectId);}
 async snapshots(session){
  const records=[...this.workspace.senders.values()].filter(r=>!r.dead&&r.projectId===session.projectId&&r.role==='surface'&&r.kind==='document'&&!r.readOnly&&(!r.documentSource||r.documentSource.type==='project'));
  const values=[];
  for(const record of records){
   if(session.controller.signal.aborted||!this.current(session))break;
   let timer;const generation=record.generation;
   try{
    if(!record.ready||record.transferring||record.contentFailed)throw Error('编辑面尚未就绪');
    const snapshot=await Promise.race([record.wc.executeJavaScript('window.__nozeliSearchSnapshot?.()'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('编辑快照读取超时')),2000);})]);
    if(record.dead||record.generation!==generation||record.projectId!==session.projectId)throw Error('编辑面身份已变化');
    if(!snapshot||snapshot.relPath!==record.relPath)throw Error('编辑快照归属未确认');
    if(!snapshot.disk)values.push({...snapshot,relPath:record.relPath});
   }catch(error){values.push({relPath:record.relPath,blocked:true,reason:error.message});}
   finally{clearTimeout(timer);}
  }
  return values;
 }
 async start(owner,p){
  if(this.closed)throw fail('SEARCH_CLOSED','搜索服务已停止');
  if(owner.role!=='shell'||owner.projectId!==p.projectId)throw fail('PROJECT_SCOPE_DENIED','搜索只允许来自当前项目主窗口');
  if(!requestKey(p.requestId)||typeof p.query!=='string'||!p.query.trim()||p.query.length>256||!['files','content'].includes(p.mode))throw fail('INVALID_PAYLOAD','搜索参数无效');
  const allowed=new Set(['projectId','requestId','query','mode','caseSensitive','regex','wholeWord','include','exclude']);
  if(Object.keys(p).some(k=>!allowed.has(k)))throw fail('INVALID_PAYLOAD','搜索不接受路径、程序或缓冲参数');
  for(const name of ['caseSensitive','regex','wholeWord'])if(p[name]!==undefined&&typeof p[name]!=='boolean')throw fail('INVALID_PAYLOAD','搜索选项无效');
  for(const name of ['include','exclude'])if(p[name]!==undefined&&(typeof p[name]!=='string'||p[name].length>1024))throw fail('INVALID_PAYLOAD','搜索路径过滤过长');
  await this.host.requireProject(p.projectId);
  for(const [key,s]of this.sessions){if(s.owner===owner){s.controller.abort();this.sessions.delete(key);}else if(s.done&&(Date.now()-s.updated>300000||s.owner.dead))this.sessions.delete(key);}
  if(this.sessions.size>=16)throw fail('SEARCH_BUSY','其他窗口仍有搜索，请稍后重试');
  if(this.sessions.has(p.requestId))throw fail('INVALID_PAYLOAD','搜索请求身份重复');
  const s={owner,projectId:p.projectId,generation:owner.generation,controller:new AbortController(),queue:[],hits:[],issues:[],done:false,cancelled:false,truncated:false,updated:Date.now(),error:null};this.sessions.set(p.requestId,s);
  if(!this.owners.has(owner)){this.owners.add(owner);owner.wc.once?.('destroyed',()=>{for(const [key,value]of this.sessions)if(value.owner===owner){value.controller.abort();this.sessions.delete(key);}});}
  const monitor=setInterval(()=>{if(!this.current(s))s.controller.abort();},100);monitor.unref?.();
  s.running=(async()=>{
   try{
    const overlays=p.mode==='content'?await this.snapshots(s):[];
    if(!this.current(s)||s.controller.signal.aborted){s.cancelled=true;return;}
    const result=await this.engine.search({...p,overlays,signal:s.controller.signal,onBatch:batch=>{
     if(!this.current(s)||s.controller.signal.aborted)return;
     const matches=batch.map(hit=>({...hit,requestId:p.requestId}));
     s.hits.push(...matches);s.queue.push({matches});
     if(s.hits.length>1000||s.queue.length>100){s.truncated=true;s.controller.abort();}
    }});
    s.truncated ||= result?.truncated===true;s.issues=result?.issues?.slice(0,50)||[];
   }catch(error){if(!s.controller.signal.aborted)s.error={code:error.code||'SEARCH_FAILED',message:error.message};}
   finally{clearInterval(monitor);s.done=true;s.cancelled ||= !this.current(s)||s.controller.signal.aborted&&!s.truncated;s.updated=Date.now();}
  })();
  return {requestId:p.requestId};
 }
 owned(owner,p){const s=this.sessions.get(p.requestId);if(!s||s.owner!==owner||s.projectId!==p.projectId)throw fail('SEARCH_STALE','搜索已失效，请重新查询');return s;}
 poll(owner,p){const s=this.owned(owner,p);if(!this.current(s)){s.controller.abort();s.cancelled=true;s.queue=[];s.done=true;}return {requestId:p.requestId,batches:s.queue.splice(0,8),done:s.done&&s.queue.length===0,cancelled:s.cancelled,truncated:s.truncated,issues:s.issues,error:s.error};}
 cancel(owner,p){const s=this.sessions.get(p.requestId);if(!s)return {};this.owned(owner,p);s.controller.abort();s.cancelled=true;s.queue=[];return {};}
 async reveal(owner,p){
  const s=this.owned(owner,{...p,requestId:p.hit?.requestId});
  if(!this.current(s)||!p.hit)throw fail('SEARCH_STALE','搜索项目已变化');
  const hit=s.hits.find(h=>JSON.stringify(h)===JSON.stringify(p.hit));if(!hit)throw fail('SEARCH_STALE','命中不是原搜索结果，请刷新');
  const project=await this.host.requireProject(p.projectId);await this.host.resolveFile(project,hit.relPath);
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){
   if(!this.current(s))throw fail('SEARCH_STALE','项目已切换');
   const record=[...this.workspace.senders.values()].find(r=>!r.dead&&r.projectId===p.projectId&&r.role==='surface'&&r.kind==='document'&&r.relPath===hit.relPath&&!r.readOnly&&(!r.documentSource||r.documentSource.type==='project'));
   if(record?.contentFailed)throw fail('SEARCH_OPEN_FAILED','目标编辑器未能打开');
   if(record?.ready){
    if(hit.kind!=='text'&&hit.source!=='buffer'){
     const fresh=await this.readDocument({host:this.host,projectId:p.projectId,relPath:hit.relPath,signal:s.controller.signal});
     if(fresh.digest!==hit.digest)throw fail('SEARCH_CHANGED','文档已变化，请重新搜索后定位');
    }
    if(!this.current(s)||record.dead||record.projectId!==s.projectId||record.relPath!==hit.relPath)throw fail('SEARCH_STALE','文档归属已变化，未跳转');
    const result=await record.wc.executeJavaScript('window.__nozeliSearchReveal?.('+JSON.stringify({...hit,projectId:s.projectId})+')');
    if(!result?.ok)throw fail('SEARCH_CHANGED',result?.message||'目标内容尚未就绪或已经变化，请重新搜索');
    record.win.show();record.win.focus();record.wc.focus();return result;
   }
   await delay(40);
  }
  throw fail('SEARCH_OPEN_TIMEOUT','目标编辑器尚未就绪，请重试');
 }
 async stop(){this.closed=true;for(const s of this.sessions.values())s.controller.abort();await Promise.allSettled([...this.sessions.values()].map(s=>s.running));this.sessions.clear();}
}
