// Host-authored merge-constraint decision card. Three explicit strategies, no
// default selection: every choice binds to the todo version and reuses the
// single host retry path; nothing auto-merges, reopens the Work or replays.
const choices=[
  ['never-commit','禁止合入，保留候选（以后需另行一次性批准）'],
  ['hold','原约束仅为执行期间暂缓：按已接受决定继续合入'],
  ['none','解除该约束：按已接受决定继续合入'],
];
export function renderMergeConstraintCard(container,{document,work,todo,pending=false,error='',choose,inspectReport}){
  container.replaceChildren();
  if(!todo||!work){container.hidden=true;delete container.dataset.mergeConstraintGate;return;}
  container.hidden=false;container.dataset.mergeConstraintGate=work.id;
  const heading=document.createElement('h3');heading.textContent='合并策略 · 等待你的决定（不默认选择）';container.append(heading);
  const body=document.createElement('p');body.textContent=todo.text||'宿主在技术收尾处等待明确的合并策略；原候选、报告与草稿保留。';container.append(body);
  for(const [value,label] of choices){
    const b=document.createElement('button');b.type='button';b.dataset.mergeChoice=value;b.textContent=label;b.disabled=pending;
    b.onclick=()=>choose(value);container.append(b);
  }
  if(inspectReport){const b=document.createElement('button');b.type='button';b.textContent='查看原成果报告（只读）';b.dataset.mergeConstraintReport='';b.disabled=pending;b.onclick=inspectReport;container.append(b);}
  const notice=document.createElement('p');notice.setAttribute('role',error?'alert':'status');
  notice.textContent=error||(pending?'正在持久化你的策略选择，请勿重复提交。':'任一选择都不会重开工作、重放任务或自动发送草稿；never-commit 需一次明确确认，hold / none 按原收尾流程继续。');
  container.append(notice);
}
