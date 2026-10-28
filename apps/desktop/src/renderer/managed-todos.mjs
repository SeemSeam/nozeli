import { mountContextMenu } from './context-menu.mjs';
import { managedReviewTodos } from '../domain/managed-work-records.mjs';
import { todoCapabilities } from '../domain/todo-management.mjs';
import './managed-todos.css';

const statusNames = { open:'待处理', resolved:'已完成', closed:'已关闭（不表示已修复）', iterating:'已续改，原结果保留', superseded:'已被新结果替代', cancelled:'任务已结束（未认可此结果）' };
const kindNames = { attention:'后台待处理', 'frontdesk-route':'处理方式决定', 'cross-project-permission':'跨项目访问授权', 'effect-permission':'提权/敏感执行授权', 'effect-grant':'执行授权·可撤销', 'merge-consent':'一次性合入批准', 'merge-constraint':'合并策略', 'cross-project-migrated':'授权迁移通知', deviation:'任务偏离决定', result:'结果', problem:'待回答', routing:'澄清', recovery:'恢复', git:'Git', closure:'收尾', system:'系统' };
export function mountManagedTodos({ document, invoke, openTodo, viewWork, recover, refresh, toast }) {
  const $ = id => document.getElementById(id);
  let state = null, projectId = null, filter = 'open', count = 50, epoch = 0, paintSignature = '';
  const pending = new Set(), requests = new Map();
  const filters = document.createElement('nav'); filters.id = 'managed-todo-filters'; filters.setAttribute('aria-label','待办状态'); filters.hidden = true;
  const list = $('inbox-reports'); list.before(filters);
  const fullName=document.createElement('div');fullName.id='managed-todo-full-name';fullName.role='tooltip';fullName.hidden=true;document.body.append(fullName);
  const hideName=()=>{fullName.hidden=true;};
  function showName(button){fullName.textContent=button.getAttribute('aria-label');fullName.hidden=false;const box=button.getBoundingClientRect();fullName.style.maxWidth=Math.max(0,Math.min(400,window.innerWidth-24))+'px';fullName.style.left=Math.max(12,Math.min(box.left,window.innerWidth-fullName.offsetWidth-12))+'px';fullName.style.top=Math.max(12,Math.min(box.bottom+4,window.innerHeight-fullName.offsetHeight-12))+'px';}
  list.addEventListener('scroll',hideName);document.addEventListener('keydown',event=>{if(event.key==='Escape')hideName();});
  for (const [value,label] of [['open','待处理'],['completed','已完成历史'],['closed','已关闭'],['all','全部']]) {
    const b = document.createElement('button'); b.type='button'; b.textContent=label; b.dataset.todoFilter=value;
    b.onclick=()=>{filter=value;count=50;paint();}; filters.append(b);
  }
  const menu = mountContextMenu({id:'managed-todo-menu',label:'待办操作',onError:message=>toast(message)});
  const confirm = document.createElement('dialog'); confirm.id='managed-todo-confirm';
  const heading=document.createElement('h2');heading.textContent='彻底移除此待办记录？';
  const warning=document.createElement('p');warning.textContent='本条待办正文和待办历史将被删除，无法恢复。原任务、对话、报告、论文、材料与 Git 检查点仍保留；仅留下无正文去重标记，不承诺擦除备份或源记录。';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='取消';cancel.dataset.todoCancel='';
  const accept=document.createElement('button');accept.type='button';accept.textContent='确认彻底移除';accept.dataset.todoConfirm='';
  confirm.append(heading,warning,cancel,accept);document.body.append(confirm);
  let confirmResolve=null;
  const finish=value=>{const resolve=confirmResolve;confirmResolve=null;if(confirm.open)confirm.close();resolve?.(value);};
  cancel.onclick=()=>finish(false);confirm.oncancel=e=>{e.preventDefault();finish(false);};accept.onclick=()=>finish(true);
  function confirmRemove(){if(confirmResolve)return Promise.resolve(false);return new Promise(resolve=>{confirmResolve=resolve;confirm.showModal();cancel.focus();});}
  function rows(){
    const current=new Map(managedReviewTodos(state||{}).map(t=>[t.id,t]));
    return (state?.todos||[]).filter(t=>t.kind!=='queue').map(t=>{
      const work=state.works?.find(w=>w.id===t.workId),receipt=state.receipts?.find(r=>r.objectId===t.objectId&&t.objectId);
      return {...t,title:t.title||current.get(t.id)?.title||[work?.name||'无关联任务',kindNames[t.kind]||t.kind].join(' · '),excerpt:current.get(t.id)?.excerpt||receipt?.text||t.text||'无正文',pending:t.status==='open'&&(current.has(t.id)||Boolean(t.reopenedAt))};
    });
  }
  function text(todo){const work=state?.works?.find(w=>w.id===todo.workId);return [todo.title,statusNames[todo.status]||todo.status,'类型：'+(kindNames[todo.kind]||todo.kind),'关联任务：'+(work?.name||todo.workId||'无'),'时间：'+(todo.closedAt||todo.settledAt||todo.updatedAt||todo.createdAt||'旧记录未记录'),todo.excerpt,todo.reason?'关闭原因：'+todo.reason:'',todo.resolution?'处理结果：'+JSON.stringify(todo.resolution):''].filter(Boolean).join('\n');}
  async function act(action,todo,source=projectId){
    const key=source+':'+todo.id, token=epoch;
    if(source!==projectId||pending.has(key))return;
    pending.add(key);paint();
    try {
      if(action==='remove'&&!await confirmRemove())return;
      if(source!==projectId||token!==epoch)return;
      const identity=[source,todo.id,todo.managementRevision||0,action].join(':');
      const requestKey=requests.get(identity)||crypto.randomUUID();requests.set(identity,requestKey);
      const r=await invoke('managed.todo.manage',{projectId:source,todoId:todo.id,expectedRevision:todo.managementRevision||0,action,requestKey,...(action==='close'?{reason:'用户关闭此提醒（不代表故障已修复）'}:{})});
      if(!r.ok)throw Error(r.error?.message||'待办处理失败，原记录保留');
      if(!r.value?.accepted)throw Error('宿主未返回成功回执，原记录保留');
      if(source!==projectId||token!==epoch)return;
      // The host receipt is authoritative even if the subsequent snapshot fails.
      if(action==='remove')state.todos=state.todos.filter(t=>t.id!==todo.id);
      else{const current=state.todos.find(t=>t.id===todo.id);if(current){current.status=r.value.status;current.managementRevision=r.value.managementRevision;if(action==='close'){current.closedBy='user:local';current.reason='用户关闭此提醒（不代表故障已修复）';}else current.reopenedAt=new Date().toISOString();}}
      paint();
      try{await refresh();requests.delete(identity);}catch(error){if(source===projectId&&token===epoch)toast('操作已持久化，但刷新失败：'+error.message);}
      if(source!==projectId||token!==epoch)return;
      const detail=document.querySelector('[data-todo-detail="'+CSS.escape(todo.id)+'"]');
      if(detail){if(action==='remove'){const surface=detail.closest('#managed-doc')||detail;surface.replaceChildren();surface.textContent='该待办已彻底移除；原任务和报告仍保留。';}else details(detail,todo.id);}
      toast(action==='close'?'提醒已关闭，不表示故障已修复':action==='reopen'?'已重开提醒；未启动或重放任务':'待办记录已彻底移除；原任务和报告保留');
    } catch(error){if(source===projectId&&token===epoch)toast(error.message);}
    finally{pending.delete(key);if(source===projectId&&token===epoch)paint();}
  }
  function actions(todo){
    const source=projectId,cap=todoCapabilities(state,todo),work=state.works?.find(w=>w.id===todo.workId);
    const items=[{id:'detail',label:'查看详情',run:()=>openTodo(todo.id)},{id:'copy',label:'复制待办内容',run:async()=>{const r=await invoke('document.clipboard',{action:'write',text:text(todo)});if(!r.ok)throw Error(r.error?.message||'复制失败');}}];
    if(work)items.push({id:'work',label:work.status==='ended'?'查看关联任务历史':'查看关联任务',run:()=>viewWork(work.id)});
    if(todo.status==='open'&&todo.kind==='merge-constraint')items.push({id:'choose-merge',label:'选择合并策略（never-commit / hold / none）',run:()=>openTodo(todo.id)});
    if(todo.status==='open'&&work&&['paused','review'].includes(work.status)&&['recovery','git'].includes(todo.kind)&&todo.sourceJobId&&Number.isInteger(todo.revision))items.push({id:'recover',label:todo.kind==='git'?'重查并重试原 Git 检查点':'回到原线程核查（不重放）',run:()=>recover(todo,source)});
    if(cap.close)items.push({id:'close',label:'关闭此提醒',run:()=>act('close',todo,source)});
    if(cap.reopen)items.push({id:'reopen',label:'重新打开待办（仅提醒）',run:()=>act('reopen',todo,source)});
    if(todo.status!=='open')items.push({id:'remove',label:'彻底移除此待办记录…',enabled:cap.remove,hint:cap.reason,run:()=>act('remove',todo,source)});
    return items;
  }
  function showMenu(todo,event,anchor){
    event?.preventDefault();event?.stopPropagation();
    if(pending.has(projectId+':'+todo.id))return;
    anchor.focus({preventScroll:true});hideName();
    const b=anchor.getBoundingClientRect(),items=actions(todo);
    const source=projectId,token=epoch;
    requestAnimationFrame(()=>{if(source===projectId&&token===epoch)menu.open(items.map(({run,...item})=>item),{x:event?.clientX??b.left,y:event?.clientY??b.bottom,run:id=>items.find(item=>item.id===id)?.run()});});
  }
  function details(container,id){
    container.replaceChildren();container.dataset.todoDetail=id;
    const todo=rows().find(t=>t.id===id);if(!todo){container.textContent='该待办记录已移除。';return;}
    const rawTime=todo.closedAt||todo.settledAt||todo.updatedAt||todo.createdAt;
    const info=document.createElement('p');info.className='managed-todo-meta';info.textContent=[statusNames[todo.status]||todo.status,rawTime?new Date(rawTime).toLocaleString(undefined,{timeZoneName:'short'}):'旧记录未记录时间',todo.reason||'',todo.reopenedAt?'重开仅恢复提醒，不自动执行':''].filter(Boolean).join(' · ');container.append(info);
    if(todo.source==='demo-fixture'){const notice=document.createElement('p');notice.dataset.demoBadge='true';notice.textContent='演示内容：决定仅更新本地固定样本；不写入论文、不启动真实工作。';container.append(notice);}
    if(rawTime){const original=document.createElement('details'),label=document.createElement('summary'),value=document.createElement('pre');label.textContent='原始时间（可选中复制）';value.textContent=rawTime;original.append(label,value);container.append(original);}
    for(const item of actions(todo).filter(i=>i.id!=='detail')){const b=document.createElement('button');b.type='button';b.textContent=item.label;b.dataset.todoAction=item.id;b.disabled=item.enabled===false||pending.has(projectId+':'+id);b.onclick=()=>Promise.resolve(item.run()).catch(e=>toast(e.message));container.append(b);}
    const cap=todoCapabilities(state,todo);if(cap.reason){const note=document.createElement('p');note.textContent=cap.reason;container.append(note);}
    if(todo.managementHistory?.length){const history=document.createElement('details'),summary=document.createElement('summary');summary.textContent='待办处理历史';history.append(summary);for(const event of todo.managementHistory){const p=document.createElement('p');p.textContent=[event.at,event.action==='close'?'用户关闭提醒':'用户重开提醒',event.reason||''].filter(Boolean).join(' · ');history.append(p);}container.append(history);}
  }
  function paint(){
    const signature=JSON.stringify([projectId,filter,count,state?.todos,state?.receipts?.map(r=>[r.objectId,r.text]),state?.works?.map(w=>[w.id,w.status,w.revision,w.name]),state?.jobs?.map(j=>[j.id,j.status]),[...pending]]);
    if(signature===paintSignature)return;
    paintSignature=signature;
    if(!state||!projectId){filters.hidden=true;return;}
    filters.hidden=false;
    for(const b of filters.children)b.setAttribute('aria-pressed',String(b.dataset.todoFilter===filter));
    const all=rows(),current=all.filter(t=>t.pending),visible=all.filter(t=>filter==='all'||filter==='open'&&t.pending||filter==='closed'&&t.status==='closed'||filter==='completed'&&t.status!=='open'&&t.status!=='closed').reverse();
    const scroll=list.scrollTop,focused=document.activeElement,focusedRow=focused?.closest?.('[data-todo-row]'),focusedMore=focused?.id==='managed-todo-more',focusedIndex=[...list.children].indexOf(focusedRow||focused),existing=new Map([...list.querySelectorAll('[data-todo-row]')].map(row=>[row.dataset.todoRow,row])),moreButton=list.querySelector('#managed-todo-more');hideName();
    const shown=visible.slice(0,count),shownIds=new Set(shown.map(todo=>todo.id));
    for(const [id,row] of existing)if(!shownIds.has(id))row.remove();
    for(const [position,todo] of shown.entries()){
      let row=existing.get(todo.id);
      if(!row){
        row=document.createElement('article');row.dataset.todoRow=todo.id;row.className='managed-todo-row';
        const open=document.createElement('button');open.type='button';open.dataset.managedTodo=todo.id;open.setAttribute('aria-describedby',fullName.id);
        const marker=document.createElement('span');marker.className='managed-todo-marker';marker.setAttribute('aria-hidden','true');
        const title=document.createElement('strong');title.className='managed-todo-title';open.append(marker,title);
        open.onpointerenter=()=>showName(open);open.onfocus=()=>showName(open);open.onpointerleave=hideName;open.onblur=hideName;
        const more=document.createElement('button');more.type='button';more.textContent='…';more.dataset.todoMore=todo.id;
        row.append(open,more);
      }
      row.dataset.state=todo.status;row.dataset.kind=todo.kind;
      const open=row.querySelector('[data-managed-todo]');open.dataset.todoKind=todo.kind;open.disabled=pending.has(projectId+':'+todo.id);open.onclick=()=>openTodo(todo.id);
      row.querySelector('.managed-todo-title').textContent=todo.title;
      const category=todo.kind==='result'?'read':['problem','routing','frontdesk-route','cross-project-permission','effect-permission','effect-grant','merge-consent','deviation'].includes(todo.kind)?'answer':['attention','recovery','git','closure','system','cross-project-migrated'].includes(todo.kind)?'check':'other';row.dataset.category=category;
      row.querySelector('.managed-todo-marker').textContent={read:'读',answer:'答',check:'！',other:'·'}[category];
      open.setAttribute('aria-label',todo.title+' · '+(kindNames[todo.kind]||todo.kind)+' · '+(statusNames[todo.status]||todo.status));
      const more=row.querySelector('[data-todo-more]');more.setAttribute('aria-label','待办操作：'+todo.title);more.disabled=open.disabled;more.onclick=()=>showMenu(todo,null,more);
      row.oncontextmenu=e=>showMenu(todo,e,e.target.closest('button')||open);row.onkeydown=e=>{if(e.key==='ContextMenu'||e.key==='Menu'||e.shiftKey&&e.key==='F10'){e.preventDefault();showMenu(todo,null,e.target.closest('button')||open);}};
      if(list.children[position]!==row)list.insertBefore(row,list.children[position]||null);
    }
    if(visible.length>count){const more=moreButton||document.createElement('button');more.id='managed-todo-more';more.type='button';more.textContent='加载更多（'+(visible.length-count)+'）';more.onclick=()=>{count+=50;paint();};list.append(more);}else moreButton?.remove();
    list.scrollTop=scroll;
    if((focusedRow||focusedMore)&&!focused?.isConnected){const next=list.children[Math.min(Math.max(0,focusedIndex),list.children.length-1)]?.querySelector('button')||filters.querySelector('[aria-pressed="true"]');next?.focus({preventScroll:true});}
    $('inbox-empty').hidden=visible.length>0;$('inbox-empty').textContent='此视图没有待办记录。';$('inbox-count').textContent=String(current.length);
    const badge=$('sidebar-badge');if(badge){badge.textContent=String(current.length);badge.hidden=!current.length;}
    $('toggle-sidebar').dataset.badgeCount=String(current.length);
    $('reading-inbox').replaceChildren();$('reading-inbox').hidden=true;
    for(const detail of document.querySelectorAll('[data-todo-detail]'))details(detail,detail.dataset.todoDetail);
  }
  return { render(next,id){if(projectId!==id){epoch++;filter='open';count=50;finish(false);menu.close();}state=next;projectId=id;paint();},details,clear(){epoch++;state=null;projectId=null;filters.hidden=true;hideName();finish(false);menu.close();} };
}
