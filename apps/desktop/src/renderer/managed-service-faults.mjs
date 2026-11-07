import './managed-work-control.css';
import {emptyState} from './management-presentation.mjs';
import './management-presentation.css';
import {workRecordServiceState} from './managed-work-directory.mjs';
const node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
const outcomeText=value=>({'accepted':'已接受继续请求','waiting-capacity':'等待运行资源','needs-reconciliation':'原执行效果待核查','unsupported-cold-recovery':'冷开记录只读，未重放','manual-hold':'仍由人工暂停','other-fault':'仍有其他服务阻塞','project-disconnected':'项目未连接，未唤醒','stale':'范围已变化，需重新核对','ended':'工作已结束'}[value]||value);
export function mountServiceFaults({root,invoke,current,onChange=()=>{}}){
 const banner=node('section');banner.className='managed-service-faults';banner.setAttribute('aria-label','需要处理的服务故障');banner.hidden=true;root.append(banner);
 const dialog=node('dialog');dialog.className='managed-control-dialog';dialog.setAttribute('aria-label','服务故障与记录');const heading=node('h2','服务故障与记录'),facts=node('div'),notice=node('p'),more=node('button','加载更多记录'),close=node('button','关闭');notice.setAttribute('role','status');more.type=close.type='button';dialog.append(heading,facts,notice,more,close);document.body.append(dialog);
 // 单层导航：open({onClosed}) 让调用方在故障页关闭后恢复原入口（如连接页与焦点）。
 // suppressClosed 区分用户关闭与 clear() 的程序关闭，项目切换不误触发返回。
 let onClosed=null,suppressClosed=false;
 dialog.addEventListener('close',()=>{if(suppressClosed){suppressClosed=false;return;}const callback=onClosed;onClosed=null;callback?.();});
 close.onclick=()=>dialog.close();
 let generation=0,context=null,flight=null,again=false,stale=true,values=new Map(),selected=null,batch=null,cursor=null,detailSerial=0;
 const cards=new Map(),pending=new Set(),keys=new Map();
 let statusCursor=null,statusRevision=null,statusSummary=null,lastReceipt=null,readError=false;
 const receiptBox=node('article'),receiptText=node('span'),receiptDetails=node('button','查看批次详情'),receiptDismiss=node('button','收起结果');receiptBox.dataset.faultReceipt='';receiptText.setAttribute('role','status');receiptDetails.type=receiptDismiss.type='button';receiptBox.append(receiptText,receiptDetails,receiptDismiss);receiptBox.hidden=true;dialog.insertBefore(receiptBox,facts);
 const overviewText=node('span'),overviewDetails=node('button','查看故障');overviewText.dataset.faultSummary='';overviewDetails.dataset.faultOverviewDetails='';overviewDetails.type='button';banner.append(overviewText,overviewDetails);
 const faultList=node('div');faultList.className='managed-fault-list';faultList.dataset.faultList='';dialog.insertBefore(faultList,facts);
 const faultMore=node('button','加载更多故障');faultMore.type='button';faultMore.hidden=true;dialog.insertBefore(faultMore,close);
 receiptDismiss.onclick=()=>{lastReceipt=null;receiptBox.hidden=true;paint();};
 receiptDetails.onclick=()=>{if(!lastReceipt)return;selected=lastReceipt.faultRef;batch=lastReceipt.batchRef;cursor=null;detailSerial++;heading.textContent='故障解除批次详情';facts.replaceChildren();notice.textContent=receiptText.textContent;more.hidden=true;if(!dialog.open)dialog.showModal();void readBatchPage();};
 overviewDetails.onclick=()=>open();
 // 空态不渲染空选择器：仅多条记录时才提供选择。
 const chooser=node('select');chooser.setAttribute('aria-label','选择服务故障记录');chooser.hidden=true;dialog.insertBefore(chooser,facts);chooser.onchange=()=>openDetails(chooser.value);
 async function call(op,payload){const r=await invoke('managed.fault.'+op,payload);if(!r.ok)throw Error(r.error?.message||'故障状态未确认');return r.value;}
 const identity=()=>JSON.stringify(current());
 const still=(gen,id)=>generation===gen&&identity()===id;
 function paint(){const visible=[...values.values()].filter(f=>f.userCritical&&f.state==='active');const count=statusSummary?.critical??visible.length;banner.hidden=!count&&!readError;overviewText.textContent=count?'故障待处理 · '+count+'项'+(stale?' · 状态待核实':count===1&&visible[0]?.title?' · '+visible[0].title:''):'故障状态待核实';banner.dataset.state=stale?'stale':'active';faultMore.hidden=!statusCursor;faultMore.disabled=stale||!!flight;const wanted=new Set(visible.map(f=>f.faultRef));for(const [id,card]of cards)if(!wanted.has(id)){card.remove();cards.delete(id);}
  for(const fault of visible){let card=cards.get(fault.faultRef);if(!card){card=node('article');const title=node('strong'),scope=node('span'),reason=node('span'),release=node('button','故障解除，继续'),details=node('button','详情'),result=node('p');release.type=details.type='button';release.dataset.faultRelease='';details.dataset.faultDetails='';reason.dataset.faultReleaseReason='';result.setAttribute('role','status');card.append(title,scope,reason,release,details,result);cards.set(fault.faultRef,card);faultList.append(card);}const [title,scope,reason,release,details,result]=card.children;title.textContent=fault.title;scope.textContent=fault.detail;
   // 不可解除的原因直显在本行，不只留在 title。
   reason.textContent=stale?'状态待核实，请从详情刷新':!fault.release?.available?(fault.release?.reason||'当前没有可解除的已启用项目成员'):'';
   release.disabled=stale||pending.has(fault.faultRef)||!fault.release?.available;release.title=stale?'状态待核实，请从详情刷新':fault.release?.reason||'仅继续此故障范围内具备安全资格的原工作';release.onclick=()=>void releaseFault(fault,result);details.onclick=()=>openDetails(fault.faultRef);}
 }
 function syncChooser(){const wanted=new Set(values.keys());for(const option of [...chooser.options])if(!wanted.has(option.value))option.remove();for(const fault of values.values()){let option=[...chooser.options].find(o=>o.value===fault.faultRef);if(!option){option=node('option');option.value=fault.faultRef;chooser.append(option);}option.textContent=fault.title+' · '+fault.detail;}chooser.value=selected||'';chooser.hidden=values.size<2;}
 function paintDetails(){const fault=values.get(selected);if(!fault)return;heading.textContent=fault.title+' · 详情';facts.replaceChildren();facts.append(node('p',fault.detail),node('p','来源：'+[fault.source?.provider,fault.source?.endpointOrigin,fault.source?.modelScope].filter(Boolean).join(' · ')));
  // DTO 不带项目名：如实显示“项目名称未提供”，ID 就近保留身份；不跨项目加载名称。
  for(const project of fault.projects||[])facts.append(node('p','项目名称未提供 · '+project.projectId+' · '+(project.connection==='live'?'已连接':'本机记录')+' · '+outcomeText(project.capability?.release)+(project.capability?.reason?' · '+project.capability.reason:'')));
  const logs=node('details'),summary=node('summary','故障证据（只读）'),body=node('pre');body.textContent=JSON.stringify({faultRef:fault.faultRef,generation:fault.generation,occurrences:fault.occurrenceCount,evidence:fault.evidenceSummary,projects:(fault.projects||[]).map(p=>({projectId:p.projectId,instanceId:p.instanceId,affectedCount:p.affectedCount,blockedWorks:p.blockedWorks}))},null,2);logs.append(summary,body);facts.append(logs);notice.textContent=stale?'上次快照，只读；刷新不会连接项目或重发输入。':'自动修复仅记录在详情；解除服务故障不解除人工暂停或代替审核。';}
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
 async function readBatchPage(){if(!batch)return;const gen=generation,id=identity(),serial=detailSerial,ref=batch,requestedCursor=cursor;more.disabled=true;try{const value=await call('results',{batchRef:ref,limit:20,...(requestedCursor?{cursor:requestedCursor}:{})});if(!still(gen,id)||serial!==detailSerial||batch!==ref)return;if(!requestedCursor)facts.replaceChildren();for(const row of value.rows)facts.append(node('p','项目名称未提供 · '+row.projectId+' · '+outcomeText(row.outcome)+(row.reason?' · '+row.reason:'')));cursor=value.nextCursor;more.hidden=!cursor;more.textContent='加载更多记录';notice.textContent=value.state==='complete'?'本批核对已完成；逐项结果不等于业务执行成功。':'本批仍在核对。';}catch(error){if(still(gen,id)&&serial===detailSerial){notice.textContent='结果读取失败：'+error.message;more.hidden=false;more.textContent='重试读取记录';}}finally{if(still(gen,id)&&serial===detailSerial)more.disabled=false;}}
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
   values=incoming;statusCursor=value.nextCursor;statusRevision=value.revision;statusSummary=value.summary;stale=false;readError=false;if(!values.has(selected))selected=[...values.values()].find(f=>f.userCritical&&f.state==='active')?.faultRef??values.keys().next().value??null;paint();syncChooser();onChange();
   // 无记录与读取失败分开：确认读取成功且为空才显示“暂无服务故障记录”。
   if(dialog.open&&!batch){if(values.size)paintDetails();else{heading.textContent='服务故障与记录';facts.replaceChildren(emptyState({message:'暂无服务故障记录。'}));chooser.hidden=true;notice.textContent='';}}
  }catch(error){if(still(gen,id)){stale=true;readError=true;paint();notice.textContent='读取未确认：'+error.message+'；请刷新第一页。';if(!values.size&&!batch)facts.replaceChildren(node('p','故障记录读取失败；未确认前不当作“暂无故障”。'));}}
  finally{if(flight===token){flight=null;paint();if(again){again=false;void refresh();}}}})();return token.promise;
 }
 faultMore.onclick=()=>void refresh({next:true});
 function clear(){generation++;context=null;flight=null;again=false;stale=true;readError=false;values.clear();cards.clear();faultList.replaceChildren();receiptBox.hidden=true;lastReceipt=null;statusCursor=null;statusRevision=null;statusSummary=null;chooser.replaceChildren();chooser.hidden=true;faultMore.hidden=true;banner.hidden=true;selected=null;batch=null;cursor=null;detailSerial++;if(dialog.open){suppressClosed=true;dialog.close();}}
 function open({onClosed:returnWhenClosed}={}){onClosed=returnWhenClosed??null;const first=[...values.values()].find(f=>f.userCritical&&f.state==='active')?.faultRef??values.keys().next().value;if(first)return openDetails(first);selected=null;batch=null;cursor=null;detailSerial++;heading.textContent='服务故障与记录';facts.replaceChildren(node('p','正在读取服务故障状态…'));chooser.hidden=true;more.hidden=true;notice.textContent='';const prepared=refresh();if(!dialog.open)dialog.showModal();void prepared;}
 return {refresh,clear,recordState(record,projectId){return workRecordServiceState(record,projectId,values.values());},open};
}
