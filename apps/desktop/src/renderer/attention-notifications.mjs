// Inline workspace attention prompt: aggregates pending review todos across
// recent projects inside the workspace header. Non-overlay by contract (native
// WebContentsViews stay visible); open/defer only acknowledge the reminder and
// never settle the durable todo. Acknowledgements carry the captured occurrence
// phase so a first-interruption recovery reminder can never be silenced by a
// click that raced the phase change.
import {createAttentionNotificationModel,notificationCategory,notificationAction,attentionCategoryMeta} from '../domain/attention-notifications.mjs';
import {uiIcon} from './ui-icons.mjs';
import './attention-notifications.css';

const FEEDBACK_MS=8000;
const cssEscape=value=>value.replace(/["\\]/g,'\\$&');
const node=(tag,className)=>{const element=document.createElement(tag);if(className)element.className=className;return element;};

export function mountAttentionNotifications({invoke,subscribe,openTodo,onError,projectName=()=>null}){
  const model=createAttentionNotificationModel();
  const box=node('section','attention-prompt');
  box.dataset.attentionPrompt='';box.hidden=true;
  box.setAttribute('role','region');box.setAttribute('aria-label','后台待办提醒');
  const live=node('p','attention-live');
  live.dataset.attentionLive='';live.setAttribute('role','status');live.setAttribute('aria-live','polite');
  const current=node('div','attention-current');
  const kind=node('span','attention-kind');kind.dataset.attentionKind='answer';
  const text=node('p','attention-current-text');
  const count=node('span','attention-count');count.dataset.attentionCount='';count.hidden=true;
  const open=node('button');open.type='button';open.dataset.attentionOpen='';open.textContent='回答问题';
  const expand=node('button');expand.type='button';expand.dataset.attentionExpand='';expand.textContent='展开';
  const defer=node('button');defer.type='button';defer.dataset.attentionDefer='';defer.textContent='稍后处理';
  current.append(kind,text,count,open,expand,defer);
  const list=node('div','attention-list');
  list.dataset.attentionList='';list.id='attention-prompt-list';
  list.setAttribute('role','list');list.hidden=true;
  expand.setAttribute('aria-controls',list.id);expand.setAttribute('aria-expanded','false');
  box.append(live,current,list);
  const feedbackLine=node('p','attention-feedback');
  feedbackLine.dataset.attentionFeedback='';feedbackLine.setAttribute('role','status');feedbackLine.hidden=true;
  const feedbackText=node('span','attention-feedback-text');
  feedbackLine.append(uiIcon('check'),feedbackText);
  document.getElementById('workspace-groups').prepend(box,feedbackLine);

  let selectedKey=null,expanded=false,busy=false;const timers=new Map();
  const describe=row=>{
    const name=projectName(row.projectId);
    return (typeof name==='string'&&name.trim()?name+' · ':'')+row.todo.title+' — '+notificationAction(row.todo);
  };
  function paintChip(chip,todo){
    const category=notificationCategory(todo),meta=attentionCategoryMeta[category];
    chip.dataset.attentionKind=category;chip.title=meta.label+'事项';
    if(chip.dataset.attentionIcon!==meta.icon){chip.replaceChildren(uiIcon(meta.icon));chip.dataset.attentionIcon=meta.icon;}
    if(chip.lastChild?.textContent!==meta.label){const label=node('span');label.textContent=meta.label;chip.append(label);}
  }

  function buildItem(row){
    const item=node('div','attention-item');
    item.setAttribute('role','listitem');item.dataset.attentionItem=row.key;item.tabIndex=0;
    item.append(node('span','attention-kind'),node('p','attention-item-text'),node('span','attention-item-phase'),node('span','attention-item-action'));
    const activate=()=>{if(selectedKey===row.key)void settle(row,true);else{selectedKey=row.key;render();}};
    item.onclick=activate;
    item.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate();}};
    return item;
  }
  function paintItem(item,row){
    item.setAttribute('aria-current',String(row.key===selectedKey));
    paintChip(item.children[0],row.todo);
    item.children[1].textContent=describe(row);
    item.children[2].textContent=row.todo.phase||'';
    item.children[3].textContent=notificationAction(row.todo);
  }
  // Keyed reconcile: when membership and order are unchanged only text updates
  // run, so focus and scroll inside the list survive every refresh.
  function renderList(rows){
    const desired=rows.map(r=>r.key),existingKeys=[...list.children].map(child=>child.dataset.attentionItem);
    const stable=desired.length===existingKeys.length&&desired.every((key,index)=>key===existingKeys[index]);
    if(stable){rows.forEach((row,index)=>paintItem(list.children[index],row));return;}
    const scrollTop=list.scrollTop,focusedKey=document.activeElement&&list.contains(document.activeElement)?document.activeElement.dataset.attentionItem:null;
    const nodes=new Map([...list.children].map(child=>[child.dataset.attentionItem,child]));
    for(const [key,child] of nodes)if(!desired.includes(key))child.remove();
    rows.forEach((row,index)=>{
      const item=nodes.get(row.key)??buildItem(row);
      paintItem(item,row);
      const reference=list.children[index];
      if(reference!==item)list.insertBefore(item,reference??null);
    });
    list.scrollTop=scrollTop;
    if(focusedKey&&!rows.some(r=>r.key===focusedKey)){
      const fallback=selectedKey&&list.querySelector('[data-attention-item="'+cssEscape(selectedKey)+'"]');
      fallback?.focus({preventScroll:true});
    }
  }

  function renderFeedback(){
    const items=model.feedback;
    feedbackLine.hidden=items.length===0;
    feedbackText.textContent=items.map(f=>f.text).join('　');
    for(const f of items)if(!timers.has(f.id))timers.set(f.id,setTimeout(()=>{timers.delete(f.id);model.clearFeedback(f.id);renderFeedback();},FEEDBACK_MS));
  }

  function render(announce=[]){
    const rows=model.rows;
    box.hidden=rows.length===0;
    if(rows.length===0){
      if(document.activeElement&&box.contains(document.activeElement))document.activeElement.blur();
      list.replaceChildren();
      return;
    }
    if(!rows.some(r=>r.key===selectedKey))selectedKey=model.currentKey;
    const row=rows.find(r=>r.key===selectedKey)??rows[0];
    paintChip(kind,row.todo);
    text.textContent=describe(row);text.title=describe(row);
    const meta=attentionCategoryMeta[notificationCategory(row.todo)];
    if(open.dataset.attentionCategory!==meta.openLabel){open.textContent=meta.openLabel;open.dataset.attentionCategory=meta.openLabel;}
    count.textContent=rows.length+' 项';
    count.hidden=expand.hidden=rows.length<2;
    expand.textContent=expanded?'收起':'展开 '+rows.length+' 项';
    expand.setAttribute('aria-expanded',String(expanded&&rows.length>1));
    list.hidden=!expanded||rows.length<2;
    renderList(rows);
    if(announce.length)live.textContent=announce.join('；')+(rows.length>1?'（共 '+rows.length+' 项待处理）':'');
  }

  const selectedRow=()=>model.rows.find(r=>r.key===selectedKey)??model.rows[0]??null;
  async function settle(row,jump){
    if(busy||!row)return;
    busy=true;open.disabled=defer.disabled=true;
    const occurrence={id:row.todoId,interrupted:row.interrupted};
    // 'current' = same occurrence still pending; 'resolved' = authoritatively
    // finished while we worked (confirming the ack stays safe and neutral);
    // 'phase-changed'/'gone' = closed, deleted or interrupted anew — never ack.
    const rowState=()=>{
      const current=model.rows.find(r=>r.key===row.key);
      if(current)return current.interrupted===occurrence.interrupted?'current':'phase-changed';
      return model.outcomeOf(row.key)==='resolved'?'resolved':'gone';
    };
    try{
      const before=rowState();
      if(before==='phase-changed'||before==='gone')return;
      if(jump&&before==='current')await openTodo(row.projectId,row.todoId);
      const after=rowState();
      if(after!=='current'&&after!=='resolved')return;
      const result=await invoke('managed.attention.ack',{projectId:row.projectId,ids:[row.todoId],occurrences:[occurrence]});
      if(!result.ok){
        if(result.error?.code==='ATTENTION_STALE'){onError('待办阶段已变化，未确认提醒；请核对。');return;}
        throw Error(result.error?.message||'提醒确认失败');
      }
      // The host may accept this ack and a first interruption may already have
      // produced a new recovery occurrence while the reply was in flight: only
      // drop the row when it is still the occurrence we acknowledged.
      if(rowState()==='current')model.acknowledge(row.key);
      render();
    }catch(error){onError(error.message);}
    finally{busy=false;open.disabled=defer.disabled=false;}
  }
  open.onclick=()=>void settle(selectedRow(),true);
  defer.onclick=()=>void settle(selectedRow(),false);
  expand.onclick=()=>{expanded=!expanded;render();};

  function receive(event){
    if(event.kind!=='managed-state'||!event.projectId)return;
    const diff=model.applyManagedState(event.projectId,event.state??{});
    const announce=[];
    for(const row of diff.added)announce.push('新增'+attentionCategoryMeta[notificationCategory(row.todo)].label+'：'+row.todo.title);
    for(const update of diff.updated)if(update.realert){
      const row=diff.rows.find(r=>r.key===update.key);
      if(row)announce.push('再次提醒：'+row.todo.title);
    }
    render(announce);
    renderFeedback();
  }
  subscribe('agent',receive);
  return {receive,dropProject:projectId=>{model.dropProject(projectId);render();renderFeedback();}};
}
