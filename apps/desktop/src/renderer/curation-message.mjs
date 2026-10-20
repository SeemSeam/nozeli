import {curationPresentation,closurePresentation} from '../domain/curation-presentation.mjs';
import {renderTagMarkdown} from './tag-markdown.mjs';

export function renderClosureStatus(target,work){
  const presentation=closurePresentation(work);if(!presentation)return false;
  const doc=target.ownerDocument||document,box=doc.createElement('section'),title=doc.createElement('strong');
  box.dataset.closureStatus=work.id||'';box.setAttribute('role','status');title.textContent=presentation.summary;box.append(title);
  for(const row of presentation.rows){const p=doc.createElement('p');p.dataset.closureStage=row.stage;p.textContent=row.text;box.append(p);}
  target.append(box);return true;
}
// Read-only compatibility for immutable historical curation messages. New
// Work closure never schedules model curation or treats this prose as a receipt.
export function renderCurationMessage(target,work,options={}){
  const presentation=curationPresentation(work);if(!presentation)return false;
  const doc=target.ownerDocument||document;
  renderClosureStatus(target,work);
  const details=doc.createElement('details'),label=doc.createElement('summary'),body=doc.createElement('div');
  details.dataset.curationEvidence='';label.textContent='查看历史归纳原文（非当前技术收尾回执）';details.append(label,body);target.append(details);
  let rendered=false;details.addEventListener('toggle',()=>{if(details.open&&!rendered){renderTagMarkdown(body,presentation.evidence,options);rendered=true;}});
  return true;
}
