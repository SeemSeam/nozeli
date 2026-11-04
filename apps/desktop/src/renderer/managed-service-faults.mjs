import './managed-work-control.css';
import {workRecordServiceState} from './managed-work-directory.mjs';
const node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
const outcomeText=value=>({'accepted':'已接受继续请求','waiting-capacity':'等待运行资源','needs-reconciliation':'原执行效果待核查','unsupported-cold-recovery':'冷开记录只读，未重放','manual-hold':'仍由人工暂停','other-fault':'仍有其他服务阻塞','project-disconnected':'项目未连接，未唤醒','stale':'范围已变化，需重新核对','ended':'工作已结束'}[value]||value);
export function mountServiceFaults({root,invoke,current,onChange=()=>{}}){
 const banner=node('section');banner.className='managed-service-faults';banner.setAttribute('aria-label','需要处理的服务故障');banner.hidden=true;root.append(banner);
 const dialog=node('dialog');dialog.className='managed-control-dialog';dialog.setAttribute('aria-label','服务故障详情');const heading=node('h2','服务故障详情'),facts=node('div'),notice=node('p'),more=node('button','加载更多记录'),close=node('button','关闭');notice.setAttribute('role','status');more.type=close.type='button';dialog.append(heading,facts,notice,more,close);document.body.append(dialog);close.onclick=()=>dialog.close();
 let generation=0,context=null,flight=null,again=false,stale=true,values=new Map(),selected=null,batch=null,cursor=null,detailSerial=0;
 const cards=new Map(),pending=new Set(),keys=new Map();
 let statusCursor=null,statusRevision=null,statusSummary=null,lastReceipt=null;
 const receiptBox=node('article'),receiptText=node('span'),receiptDetails=node('button','查看批次详情'),receiptDismiss=node('button','收起结果');receiptBox.dataset.faultReceipt='';receiptText.setAttribute('role','status');receiptDetails.type=receiptDismiss.type='button';receiptBox.append(receiptText,receiptDetails,receiptDismiss);receiptBox.hidden=true;banner.append(receiptBox);
 const overview=node('article'),overviewText=node('span'),overviewDetails=node('button','查看其他故障');overviewDetails.type='button';overview.append(overviewText,overviewDetails);overview.hidden=true;banner.append(overview);
 const faultMore=node('button','加载更多故障');faultMore.type='button';faultMore.hidden=true;dialog.insertBefore(faultMore,close);
 receiptDismiss.onclick=()=>{lastReceipt=null;receiptBox.hidden=true;paint();};
 receiptDetails.onclick=()=>{if(!lastReceipt)return;selected=lastReceipt.faultRef;batch=lastReceipt.batchRef;cursor=null;detailSerial++;heading.textContent='故障解除批次详情';facts.replaceChildren();notice.textContent=receiptText.textContent;more.hidden=true;if(!dialog.open)dialog.showModal();void readBatchPage();};
 overviewDetails.onclick=()=>{const first=values.keys().next().value;if(first)openDetails(first);else if(!dialog.open)dialog.showModal();};
 const chooser=node('select');chooser.setAttribute('aria-label','选择服务故障记录');dialog.insertBefore(chooser,facts);chooser.onchange=()=>openDetails(chooser.value);
 async function call(op,payload){const r=await invoke('managed.fault.'+op,payload);if(!r.ok)throw Error(r.error?.message||'故障状态未确认');return r.value;}
 const identity=()=>JSON.stringify(current());
 const still=(gen,id)=>generation===gen&&identity()===id;
 function paint(){const visible=[...values.values()].filter(f=>f.userCritical&&f.state==='active');const additional=Math.max(0,(statusSummary?.critical||0)-visible.length);overview.hidden=!additional;overviewText.textContent='另有 '+additional+' 项需处理的服务故障 · 全部范围 '+(statusSummary?.projects??'待核实')+' 个项目 / '+(statusSummary?.works??'待核实')+' 项工作';banner.hidden=!visible.length&&!additional&&!lastReceipt;faultMore.hidden=!statusCursor;faultMore.disabled=stale||!!flight;const wanted=new Set(visible.map(f=>f.faultRef));for(const [id,card]of cards)if(!wanted.has(id)){card.remove();cards.delete(id);}
  for(const fault of visible){let card=cards.get(fault.faultRef);if(!card){card=node('article');const title=node('strong'),scope=node('span'),release=node('button','故障解除，继续'),details=node('button','详情'),result=node('p');release.type=details.type='button';release.dataset.faultRelease='';details.dataset.faultDetails='';result.setAttribute('role','status');card.append(title,scope,release,details,result);cards.set(fault.faultRef,card);banner.append(card);}const [title,scope,release,details,result]=card.children;title.textContent=fault.title;scope.textContent=fault.detail;release.disabled=stale||pending.has(fault.faultRef)||!fault.release?.available;release.title=stale?'状态待核实，请从详情刷新':fault.release?.reason||'仅继续此故障范围内具备安全资格的原工作';release.onclick=()=>void releaseFault(fault,result);details.onclick=()=>openDetails(fault.faultRef);}
 }
 function syncChooser(){const wanted=new Set(values.keys());for(const option of [...chooser.options])if(!wanted.has(option.value))option.remove();for(const fault of values.values()){let option=[...chooser.options].find(o=>o.value===fault.faultRef);if(!option){option=node('option');option.value=fault.faultRef;chooser.append(option);}option.textContent=fault.title+' · '+fault.detail;}chooser.value=selected||'';chooser.hidden=values.size<2;}
 function paintDetails(){const fault=values.get(selected);if(!fault)return;heading.textContent=fault.title+' · 详情';facts.replaceChildren();facts.append(node('p',fault.detail),node('p','来源：'+[fault.source?.provider,fault.source?.endpointOrigin,fault.source?.modelScope].filter(Boolean).join(' · ')));for(const project of fault.projects||[])facts.append(node('p',project.projectId+' · '+(project.connection==='live'?'已连接':'本机记录')+' · '+outcomeText(project.capability?.release)+' · '+(project.capability?.reason||'')));const logs=node('details'),summary=node('summary','故障证据（只读）'),body=node('pre');body.textContent=JSON.stringify({generation:fault.generation,occurrences:fault.occurrenceCount,evidence:fault.evidenceSummary},null,2);logs.append(summary,body);facts.append(logs);notice.textContent=stale?'上次快照，只读；刷新不会连接项目或重发输入。':'自动修复仅记录在详情；解除服务故障不解除人工暂停或代替审核。';}
 function openDetails(ref){selected=ref;batch=null;cursor=null;detailSerial++;more.hidden=true;syncChooser();paintDetails();if(!dialog.open)dialog.showModal();}
 async function releaseFault(fault,result){
  if(stale||pending.has(fault.faultRef)||!fault.release?.available)return;
  const gen=generation,id=identity(),signature=JSON.stringify([fault.faultRef,fault.version,fault.generation,fault.release.scopeSnapshot]);
  const requestKey=keys.get(signature)||crypto.randomUUID();keys.set(signature,requestKey);pending.add(fault.faultRef);paint();result.textContent='正在核对原故障范围…';
  try{
   const value=await call('release',{faultRef:fault.faultRef,expectedVersion:fault.release.expectedVersion,scopeSnapshot:fault.release.scopeSnapshot,requestKey});
   if(!still(gen,id))return;
   const latest=values.get(fault.faultRef);
   if(value.faultRef!==fault.faultRef||latest&&latest.generation!==fault.generation){stale=true;result.textContent='故障代次已变化，旧批次结果不用于当前故障；请刷新核对。';await refresh();return;}
   keys.delete(signature);lastReceipt=value;receiptBox.hidden=false;
   receiptText.textContent='已接受继续 '+value.accepted+' 项，等待资源 '+value.waitingCapacity+' 项，仍受阻 '+value.blocked+' 项；不代表执行成功。';
   paint();await refresh();
  }catch(error){if(still(gen,id)){stale=true;result.textContent='仍未恢复或结果未确认：'+error.message+'；未自动重发。';paint();}}
  finally{pending.delete(fault.faultRef);if(still(gen,id))paint();}
 }
 async function readBatchPage(){if(!batch)return;const gen=generation,id=identity(),serial=detailSerial,ref=batch,requestedCursor=cursor;more.disabled=true;try{const value=await call('results',{batchRef:ref,limit:20,...(requestedCursor?{cursor:requestedCursor}:{})});if(!still(gen,id)||serial!==detailSerial||batch!==ref)return;if(!requestedCursor)facts.replaceChildren();for(const row of value.rows)facts.append(node('p',row.projectId+' · '+outcomeText(row.outcome)+(row.reason?' · '+row.reason:'')));cursor=value.nextCursor;more.hidden=!cursor;more.textContent='加载更多记录';notice.textContent=value.state==='complete'?'本批核对已完成；逐项结果不等于业务执行成功。':'本批仍在核对。';}catch(error){if(still(gen,id)&&serial===detailSerial){notice.textContent='结果读取失败：'+error.message;more.hidden=false;more.textContent='重试读取记录';}}finally{if(still(gen,id)&&serial===detailSerial)more.disabled=false;}}
 more.onclick=()=>void readBatchPage();
 const refreshButton=node('button','刷新故障状态');refreshButton.type='button';dialog.insertBefore(refreshButton,close);refreshButton.onclick=()=>void refresh();
 async function refresh({next=false}={}){
  const id=identity();if(context!==id){clear();context=id;}if(!current()?.projectId)return;
  if(flight){if(!next)again=true;return flight.promise;}if(next&&(!statusCursor||stale))return;
  const gen=generation,token={},requestedCursor=next?statusCursor:null;flight=token;faultMore.disabled=true;
  token.promise=(async()=>{try{
   const value=await call('status',{limit:20,...(requestedCursor?{cursor:requestedCursor}:{})});if(!still(gen,id))return;
   if(next&&value.revision!==statusRevision)throw Error('故障范围已变化，请刷新');
   const incoming=next?new Map(values):new Map();for(const fault of value.faults)incoming.set(fault.faultRef,fault);
   values=incoming;statusCursor=value.nextCursor;statusRevision=value.revision;statusSummary=value.summary;stale=false;paint();syncChooser();onChange();if(dialog.open&&!batch)paintDetails();
  }catch(error){if(still(gen,id)){stale=true;paint();notice.textContent='读取未确认：'+error.message+'；请刷新第一页。';}}
  finally{if(flight===token){flight=null;paint();if(again){again=false;void refresh();}}}})();return token.promise;
 }
 faultMore.onclick=()=>void refresh({next:true});
 function clear(){generation++;context=null;flight=null;again=false;stale=true;values.clear();cards.clear();banner.replaceChildren(receiptBox,overview);receiptBox.hidden=overview.hidden=true;lastReceipt=null;statusCursor=null;statusRevision=null;statusSummary=null;chooser.replaceChildren();faultMore.hidden=true;banner.hidden=true;selected=null;batch=null;cursor=null;detailSerial++;if(dialog.open)dialog.close();}
 return {refresh,clear,recordState(record,projectId){return workRecordServiceState(record,projectId,values.values());},open(){const first=values.keys().next().value;if(first)openDetails(first);else{heading.textContent='服务故障详情';facts.replaceChildren();notice.textContent='没有已记录的服务故障；读取不会唤醒 Agent。';more.hidden=true;if(!dialog.open)dialog.showModal();void refresh();}}};
}
