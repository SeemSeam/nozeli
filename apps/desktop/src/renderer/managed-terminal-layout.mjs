export function terminalTargets(state) {
 return ['frontdesk','orchestrator',...state.works.filter(w=>!['ended','queued'].includes(w.status)).map(w=>w.id)];
}
export function terminalColumns(count,width,mode='auto') {
 const capacity=Math.max(1,Math.min(3,Math.floor((width+10)/370)));
 return Math.max(1,Math.min(capacity,mode==='auto'?Math.min(count,2):Number(mode),count));
}
export function createTerminalLayout({root,onVisibility=()=>{}}) {
 const actions=document.createElement('nav');actions.className='managed-terminal-actions';
 const summary=document.createElement('strong');summary.className='managed-terminal-summary';summary.setAttribute('role','status');
 const label=document.createElement('label');label.textContent='排列 ';
 const select=document.createElement('select');select.setAttribute('aria-label','Agent 分屏排列');
 for(const [value,text] of [['auto','自动平铺'],['1','单列'],['2','双列'],['3','三列']]){const o=document.createElement('option');o.value=value;o.textContent=text;select.append(o);}
 label.append(select);const pages=document.createElement('nav');pages.className='managed-pane-pages';pages.setAttribute('aria-label','Agent 分屏分组');actions.append(summary,pages,label);
 const grid=document.createElement('div');grid.className='managed-agent-panes';root.append(actions,grid);
 let page=0;const cards=new Map();
 function layout(){
  const entries=[...cards],groups=Math.max(1,Math.ceil(entries.length/6));page=Math.min(page,groups-1);const shown=entries.slice(page*6,page*6+6);const columns=terminalColumns(shown.length,grid.clientWidth,select.value);pages.replaceChildren();if(groups>1)for(let i=0;i<groups;i++){const b=document.createElement('button');b.type='button';b.textContent=String(i+1);b.setAttribute('aria-label','第 '+(i+1)+' 组 Agent');b.setAttribute('aria-pressed',String(page===i));b.onclick=()=>{page=i;layout();};pages.append(b);}
  grid.style.setProperty('--agent-columns',String(columns));
  // 单列时每个 TUI 保留一屏工作高度，列表负责滚动；不能把两个原生编辑器压进半屏。
  grid.style.setProperty('--agent-pane-min-height',String(columns===1?Math.max(280,grid.clientHeight-8):280)+'px');
  grid.style.setProperty('--agent-rows',String(Math.max(1,Math.ceil(shown.length/columns))));
  for(const [id,card]of cards){const visible=shown.some(([key])=>key===id);card.hidden=!visible;onVisibility(id,visible);}
 }
 select.onchange=layout;const observer=new ResizeObserver(layout);observer.observe(grid);
 return {actions,grid,cards,update(state,create,update){
  const targets=terminalTargets(state);
  for(const [id,card] of cards)if(!targets.includes(id)){card.remove();cards.delete(id);}
  for(const id of targets){let card=cards.get(id);if(!card){card=create(id);cards.set(id,card);grid.append(card);}update(id,card);}
  summary.textContent='常驻 2 · 工作 '+state.quotaUsed+'/'+state.limit+' · 排队 '+state.works.filter(w=>w.status==='queued').length+(state.quotaUsed>=state.limit?' · 名额已满':'');layout();
 },dispose(){observer.disconnect();cards.clear();root.replaceChildren();}};
}
