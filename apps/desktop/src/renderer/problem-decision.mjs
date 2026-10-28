import {deviationHeld} from '../domain/work-deviation.mjs';

// Problem approval is a continuation decision, never final result acceptance.
export function mountProblemDecision(container,{document,projectId,work,publication,invoke,connect,refresh,current,discard,drafts}){
 const key=JSON.stringify([projectId,work.id,publication.objectId,publication.revision]),storageKey='nozeli-problem-feedback:'+key;
 let pending=false,settled=false;
 const requests=new Map();
 const section=document.createElement('section');section.className='managed-problem-decision';section.dataset.problemDecision=work.id;
 section.dataset.problemObject=publication.objectId;
 const heading=document.createElement('h3');heading.textContent='问题报告 · 请选择后续处理';
 const note=document.createElement('p');note.textContent='这是尚未完成的阶段问题，不是最终成果。接受即授权报告中明确提出的本任务处理方案，由原 Worker 继续执行；拒绝请写明替代要求。不会仅因点击就自动接受最终成果或冒称完成；方案包含安装/提交等风险时请核对原文，操作系统认证仍独立执行，不授予全局权限。';
 const label=document.createElement('label');label.textContent='补充要求 / 拒绝原因（拒绝时必填）';
 const input=document.createElement('textarea');input.dataset.problemFeedback='';let saved='';try{saved=globalThis.localStorage?.getItem(storageKey)||'';}catch{}input.value=drafts.get(key)??saved;input.rows=3;input.oninput=()=>{drafts.set(key,input.value);try{globalThis.localStorage?.setItem(storageKey,input.value);}catch{}};label.append(input);
 input.maxLength=32000;
 const actions=document.createElement('div');actions.className='managed-work-closure-actions';
 const status=document.createElement('p');status.setAttribute('role','status');status.dataset.problemDecisionStatus='';
 const approve=document.createElement('button'),reject=document.createElement('button'),end=document.createElement('button');
 for(const b of[approve,reject,end])b.type='button';
 approve.textContent='接受处理方案，继续原 Worker';approve.dataset.problemAction='approve';
 reject.textContent='拒绝该方案，按补充要求继续';reject.dataset.problemAction='reject';
 end.textContent='丢弃未合入成果并结束…';end.dataset.problemDiscard='';
 const valid=()=>current()&&work.status==='paused'&&!deviationHeld(work)&&work.problem?.objectId===publication.objectId&&work.revision===publication.revision;
 const paint=()=>{for(const b of[approve,reject,end])b.disabled=pending||settled||!valid();input.disabled=pending||settled||!valid();};
 async function decide(action){
  if(pending||settled)return;
  if(!valid()){status.textContent='问题或工作版本已变化，请重新打开当前问题；补充文字保留。';paint();return;}
  const text=input.value;
  if(action==='reject'&&!text.trim()){status.textContent='请填写拒绝原因或替代要求，再交给原 Worker；不会把拒绝误作丢弃。';input.focus();return;}
  const identity=JSON.stringify([action,text]),requestKey=requests.get(identity)||crypto.randomUUID();requests.set(identity,requestKey);
  pending=true;status.textContent='正在保存明确决定…';paint();
  try{
   const r=await invoke('managed.problem.resolve',{workId:work.id,objectId:publication.objectId,revision:publication.revision,action,text,requestKey});
   if(!r.ok)throw Error(r.error?.message||'决定未确认，问题与输入保留');
   if(r.value?.accepted!==true||typeof r.value.jobId!=='string')throw Error('宿主未返回原任务续作回执');
   settled=true;drafts.delete(key);try{globalThis.localStorage?.removeItem(storageKey);}catch{}status.textContent='决定已保存，已排入原 Worker 续作；不重放已完成操作。';
   try{await connect();await refresh();}catch(error){status.textContent='决定已保存、原任务续作已排队，但连接尚未完成：'+error.message+'。请恢复连接，勿重复提交决定。';}
  }catch(error){status.textContent=error.message;}
  finally{pending=false;paint();}
 }
 approve.onclick=()=>void decide('approve');reject.onclick=()=>void decide('reject');end.onclick=()=>void discard();
 actions.append(approve,reject,end);section.append(heading,note,label,actions,status);container.append(section);paint();
 return {update:paint};
}
