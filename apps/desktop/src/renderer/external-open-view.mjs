const failure=response=>Object.assign(Error(response.error?.message||'外部打开尚未完成。'),{code:response.error?.code||'OPEN_FAILED'});
const claimPayload=value=>Object.fromEntries(['requestId','attemptId','claimToken','generation'].map(key=>[key,value[key]]));

export function mountExternalDisplay({invoke,subscribe,snapshot}){
 return subscribe('workspace.control',event=>{
  if(event.type!=='external-open-display')return;
  void Promise.resolve().then(snapshot).then(value=>({requestId:event.requestId,ok:true,snapshot:value}),error=>({requestId:event.requestId,ok:false,error:{code:error.code||'OPEN_UNCONFIRMED',message:error.message}}))
   .then(payload=>invoke('workspace.externalDisplayed',payload)).catch(()=>{/* Main retains an unanswered challenge if this renderer disappears. */});
 });
}

// Recovery is explicit: only a newly admitted fresh head may open itself.
// Cold, blocked and later FIFO requests stay visible until the user acts.
export function mountExternalOpen({invoke,subscribe,openTarget,ready,toast}){
 const button=document.createElement('button');button.type='button';button.dataset.externalOpen='status';button.hidden=true;
 document.getElementById('project-name').after(button);
 const dialog=document.createElement('dialog');dialog.dataset.externalOpen='recovery';dialog.className='external-open-recovery';
 const title=document.createElement('h2');title.textContent='待打开的文件与项目';
 const body=document.createElement('div'),close=document.createElement('button');close.type='button';close.textContent='关闭';close.onclick=()=>dialog.close();dialog.append(title,body,close);document.body.append(dialog);
 let busy=false,again=false,state=null;
 const call=async(op,payload={})=>{const response=await invoke('session.external.'+op,payload);if(!response.ok)throw failure(response);return response.value;};
 const action=(caption,run)=>{const node=document.createElement('button');node.type='button';node.textContent=caption;node.disabled=busy;node.onclick=()=>void Promise.resolve().then(run).catch(error=>toast(error.message)).finally(()=>drain(false));return node;};
 function render(){
  if(!state)return;const count=state.requests.length+state.unaccepted.length;
  button.hidden=!count&&!state.refused&&state.status==='ready';button.textContent='外部打开'+(count?' ('+count+')':' · 需处理');
  body.replaceChildren();const message=document.createElement('p');message.textContent=state.error?.message||'重启后保留的请求需要手动打开。移除请求不会删除源文件。';body.append(message);
  if(state.status==='paused')body.append(action('重试保存队列结果',()=>call('retryPersistence')));
  if(state.status==='frozen'){const note=document.createElement('p');note.textContent='队列无法安全读取或已被其他内容替换。原记录已保留；请保留用户数据并报告错误代码：'+state.error?.code;body.append(note);}
  for(const [index,row] of state.requests.entries()){
   const item=document.createElement('p'),label=document.createElement('span');label.textContent=row.absolutePath+(row.lastError?' — '+row.lastError.message:'');item.append(label);
   if(index===0&&state.status==='ready'&&!state.terminalPending)item.append(action('打开／重试',()=>attempt(row,'retry')));
   if(state.status==='ready'&&row.state!=='claimed'){
    const remove=action('移除请求',()=>{});remove.onclick=()=>{remove.textContent='确认移除请求';remove.onclick=()=>void call('remove',{requestId:row.requestId,expectedRevision:state.revision,confirmed:true}).catch(error=>toast(error.message)).finally(()=>drain(false));};item.append(remove);
   }
   body.append(item);
  }
  if(state.unaccepted.length){const note=document.createElement('p');note.textContent='以下请求尚未被持久接收，退出后不能保留；请先解决队列问题并重试接收。';body.append(note,action('重试接收',()=>call('retryAdmissions')));for(const row of state.unaccepted){const item=document.createElement('p');item.textContent=row.absolutePath+' — '+(row.error?.message||'等待前一请求接收');body.append(item);}}
  if(state.refused){const note=document.createElement('p');note.textContent=state.refused+' 个启动参数因格式或容量限制未被接收，请稍后重新打开对应文件。';body.append(note);}
 }
 async function attempt(row,mode){
  dialog.close();busy=true;render();let claim;
  try{
   claim=await call('begin',{requestId:row.requestId,expectedRevision:state.revision,mode});
   await openTarget(claim);await call('confirm',claimPayload(claim));
  }catch(error){
   // Main may already have retained a failed display or an uncertain terminal
   // commit. Defer is safe only for an unfinished original attempt.
   if(claim&&error.code!=='OPEN_PERSISTENCE_UNCONFIRMED')await call('defer',{...claimPayload(claim),error:{code:error.code||'OPEN_FAILED',message:error.message}}).catch(()=>{});
   toast('打开尚未完成，请在“外部打开”中处理：'+error.message);
  }finally{busy=false;}
 }
 async function drain(automatic=true){
  if(!ready())return;if(busy){again=true;return;}busy=true;
  try{state=await call('status');render();const head=state.requests[0];
   if(automatic&&state.status==='ready'&&head?.state==='pending'&&!head.requiresUserAction){busy=false;await attempt(head,'fresh');busy=true;state=await call('status');render();}
  }catch(error){toast('外部打开请求未确认：'+error.message);}
  finally{busy=false;render();if(again){again=false;void drain(false);}}
 }
 button.onclick=()=>{render();dialog.showModal();};subscribe('external.open',()=>void drain());
 return {drain};
}
