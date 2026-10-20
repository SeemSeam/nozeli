import {deviationPresentation} from '../domain/work-deviation.mjs';

// textContent preserves the admitted input verbatim, without interpreting Markdown or HTML.
export function renderDeviationGate(container,{document,work,pending=false,error='',resolve,inspectReport}){
 container.replaceChildren();const view=deviationPresentation(work);container.hidden=!view?.held;if(!view?.held)return;
 container.dataset.deviationGate=work.id;
 const heading=document.createElement('h3');heading.textContent=view.phase;container.append(heading);
 for(const [label,text] of [['原始任务',view.original],['触发偏离的原始输入（逐字）',view.sourceText],['输入来源',view.provenance],['Worker 提议的目标（尚非授权）',view.changedGoal],['偏离原因',view.reason],['已完成部分 / 保留进度',view.progress],['尚未执行 / 保留状态',view.notExecuted]]){
  const section=document.createElement('details'),title=document.createElement('summary'),body=document.createElement('pre');title.textContent=label;body.textContent=text;body.style.whiteSpace='pre-wrap';body.style.overflowWrap='anywhere';section.open=true;section.append(title,body);container.append(section);
 }
 for(const [action,label] of [['continue',view.continueLabel],...(view.canReplan?[['replan','交主控重新规划（原 Work 保持暂停）']]:[])]){
  const b=document.createElement('button');b.type='button';b.textContent=label;b.dataset.deviationAction=action;b.disabled=pending;b.onclick=()=>resolve(action);container.append(b);
 }
 if(inspectReport){const b=document.createElement('button');b.type='button';b.textContent='查看保留的问题报告（只读）';b.dataset.deviationReport='';b.onclick=inspectReport;container.append(b);}
 const notice=document.createElement('p');notice.setAttribute('role',error?'alert':'status');notice.textContent=error||(pending?'正在持久化用户决定，请勿重复提交。':'部分工作、原报告与工作树保留；此暂停不是完成或验收。关闭待办、普通「继续」消息和终端不能解除暂停。');container.append(notice);
}
