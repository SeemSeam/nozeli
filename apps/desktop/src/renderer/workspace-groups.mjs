import {layoutGroups} from '../domain/workspace-layout.mjs';
import './workspace-groups.css';

// Renders the layout tree as single-content panes. The layout/domain owns assignment;
// this module deliberately never invents tabs or group UI.
export function mountWorkspaceGroups({invoke,scope,toast=()=>{}}){
  let layout=null, windowId=scope.windowId||'main', activeGroup=null, queue=Promise.resolve(), frame=0;
  const host=document.createElement('section');host.id='workspace-groups';host.setAttribute('aria-label','工作区');
  const toolbar=document.createElement('header');toolbar.className='workspace-toolbar';
  const title=document.createElement('strong');title.textContent='工作区';
  const menu=document.createElement('details');menu.id='workspace-layout-menu';const summary=document.createElement('summary');summary.textContent='布局与窗口';summary.setAttribute('aria-label','工作区布局与窗口');
  const commands=document.createElement('div');commands.className='workspace-command-menu';commands.setAttribute('role','menu');menu.append(summary,commands);toolbar.append(title,menu);
  const tree=document.createElement('div');tree.className='workspace-tree';host.append(toolbar,tree);document.getElementById('reader').append(host);
  const call=async(op,payload={})=>{const r=await invoke(op,payload);if(!r.ok)throw Object.assign(new Error(r.error?.message||'工作区操作失败'),{code:r.error?.code});return r.value;};
  const groups=()=>layout?layoutGroups(layout,windowId):[];const group=()=>groups().find(g=>g.id===activeGroup)||groups()[0];
  const viewTitle=v=>v?.viewState?.title||({conversation:'对话',report:'报告',diff:'Diff',history:'历史'}[v?.kind])||v?.relPath?.split('/').pop()||'文档';
  function receive(value){if(!value?.layout)return;if(scope.role==='shell'&&layout&&value.layout.projectId!==layout.projectId)return;layout=value.layout;windowId=value.windowId||windowId;if(!groups().some(g=>g.id===activeGroup))activeGroup=groups()[0]?.id;render();}
  function command(request){const run=queue.then(async()=>{if(!layout)return;const value=await call('workspace.command',{projectId:layout.projectId,expectedRevision:layout.revision,requestKey:crypto.randomUUID(),command:request});receive(value);return layout;});queue=run.catch(e=>toast(e.message));return run;}
  const button=(label,key,run)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.dataset.workspaceCommand=key;b.setAttribute('role','menuitem');b.onclick=()=>{menu.open=false;Promise.resolve(run()).catch(e=>toast(e.message));};return b;};
  let namedLayouts=[],namedProject=null,namedSequence=0;
  async function refreshNamedLayouts(){
    const projectId=layout?.projectId;if(!projectId)return;
    const sequence=++namedSequence;
    try{
      const value=await call('workspace.layouts.list',{projectId});
      if(sequence!==namedSequence||layout?.projectId!==projectId)return;
      namedProject=projectId;namedLayouts=value.layouts;renderMenu();
    }catch(error){if(sequence===namedSequence&&layout?.projectId===projectId)toast(error.message);}
  }
  function namedAction(op,payload,projectId){
    const run=queue.then(async()=>{
      if(layout?.projectId!==projectId)throw new Error('项目已切换，请重新选择布局。');
      const value=await call('workspace.layouts.'+op,{projectId,...payload});
      if(layout?.projectId===projectId)receive(value);
      await refreshNamedLayouts();
    });
    queue=run.catch(()=>{});return run;
  }
  function nameDialog(label,initial,submit){
    const projectId=layout?.projectId;if(!projectId)return;
    const dialog=document.createElement('dialog');dialog.className='workspace-name-dialog';dialog.setAttribute('aria-label',label);
    const form=document.createElement('form'),heading=document.createElement('h2'),field=document.createElement('label'),input=document.createElement('input'),error=document.createElement('p'),accept=document.createElement('button'),cancel=document.createElement('button');
    heading.textContent=label;field.textContent='布局名称 ';input.required=true;input.maxLength=80;input.value=initial;field.append(input);
    error.setAttribute('role','alert');accept.type='submit';accept.textContent='确定';cancel.type='button';cancel.textContent='取消';
    form.append(heading,field,error,accept,cancel);dialog.append(form);document.body.append(dialog);
    const close=()=>{dialog.close();dialog.remove();scheduleBounds();};let pending=false;
    cancel.onclick=close;dialog.addEventListener('cancel',event=>{event.preventDefault();if(!pending)close();});
    form.onsubmit=async event=>{
      event.preventDefault();if(pending)return;
      pending=true;accept.disabled=true;cancel.disabled=true;error.textContent='';
      try{await submit(input.value,projectId);close();}
      catch(e){error.textContent=e.message;pending=false;accept.disabled=false;cancel.disabled=false;}
    };
    dialog.showModal();input.focus();input.select();scheduleBounds();
  }
  function renderMenu(){commands.replaceChildren();const g=group();for(const [label,axis] of [['向右拆分','x'],['向下拆分','y']])commands.append(button(label,'split-'+axis,()=>command({type:'split',groupId:g?.id,axis,side:'after'})));commands.append(button('关闭当前分区','closePane',()=>command({type:'closePane',groupId:g?.id})));if(windowId!=='main')commands.append(button('返回主窗口','dock',()=>command({type:'dock',windowId,targetGroupId:layoutGroups(layout,'main')[0]?.id})));
    commands.append(button('保存当前布局…','layout-save',()=>nameDialog('保存当前布局','',(name,projectId)=>namedAction('save',{name},projectId))));
    for(const saved of namedProject===layout?.projectId?namedLayouts:[]){const section=document.createElement('section');section.className='workspace-menu-section';const heading=document.createElement('strong');heading.textContent=saved.name;const projectId=layout.projectId;section.append(heading,button('载入','layout-load',()=>namedAction('load',{name:saved.name},projectId)),button('重命名…','layout-rename',()=>nameDialog('重命名布局',saved.name,(newName,id)=>namedAction('rename',{name:saved.name,newName},id))),button('删除','layout-delete',()=>namedAction('delete',{name:saved.name},projectId)));commands.append(section);}
  }
  function activate(viewId,groupId){return command({type:'activate',viewId,groupId:groupId||group()?.id});}
  const minimum=node=>{if(!node||node.kind==='group')return {width:280,height:180};const a=minimum(node.first),b=minimum(node.second);return node.axis==='x'?{width:a.width+b.width+6,height:Math.max(a.height,b.height)}:{width:Math.max(a.width,b.width),height:a.height+b.height+6};};
  function pane(node){const el=document.createElement('section');el.className='workspace-pane';el.dataset.workspaceGroup=node.id;el.classList.toggle('is-focused',node.id===activeGroup);el.addEventListener('pointerdown',()=>{activeGroup=node.id;for(const p of tree.querySelectorAll('[data-workspace-group]'))p.classList.toggle('is-focused',p===el);scheduleBounds();});const bar=document.createElement('header');bar.className='workspace-pane-header';const view=node.activeViewId&&layout.views[node.activeViewId];const label=document.createElement('strong');label.className='workspace-pane-title';label.textContent=view?viewTitle(view):'空分区';bar.append(label);if(view){bar.append(button('关闭','closePane',()=>command({type:'closePane',groupId:node.id})));const floating=button(windowId==='main'?'独立窗口':'返回工作区',windowId==='main'?'floatOpen':'dock',()=>command(windowId==='main'?{type:'floatOpen',viewId:view.id}:{type:'dock',windowId,targetGroupId:layoutGroups(layout,'main')[0]?.id}));floating.dataset.workspaceFloatOpen=view.id;bar.append(floating);}const content=document.createElement('div');content.className='workspace-content';content.dataset.workspaceContent=node.id;if(view)content.dataset.viewId=view.id;else content.textContent='从左侧“已打开”列表选择内容';el.append(bar,content);return el;}
  function build(node){if(node.kind==='group')return pane(node);const el=document.createElement('div');el.className='workspace-split';el.dataset.axis=node.axis;el.dataset.splitId=node.id;el.style.setProperty('--ratio',node.ratio);const divider=document.createElement('div');divider.className='workspace-divider';divider.tabIndex=0;divider.setAttribute('role','separator');divider.setAttribute('aria-orientation',node.axis==='x'?'vertical':'horizontal');divider.setAttribute('aria-valuenow',Math.round(node.ratio*100));const setRatio=ratio=>{const rect=el.getBoundingClientRect(),dim=node.axis==='x'?'width':'height',size=rect[dim],a=minimum(node.first)[dim],b=minimum(node.second)[dim];const value=size?Math.max(Math.min(.5,a/size),Math.min(Math.max(.5,1-b/size),ratio)):ratio;return command({type:'resize',splitId:node.id,ratio:Math.max(.05,Math.min(.95,value))});};divider.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();divider.setPointerCapture(e.pointerId);const r=el.getBoundingClientRect(),size=node.axis==='x'?r.width:r.height;const move=x=>{const ratio=(node.axis==='x'?x.clientX-r.left:x.clientY-r.top)/size;el.style.setProperty('--ratio',ratio);};const end=x=>{divider.removeEventListener('pointermove',move);divider.removeEventListener('pointerup',end);void setRatio((node.axis==='x'?x.clientX-r.left:x.clientY-r.top)/size);};divider.addEventListener('pointermove',move);divider.addEventListener('pointerup',end);};el.append(build(node.first),divider,build(node.second));return el;}
  let renderedKey='';
  function updateRatios(node){if(node?.kind!=='split')return;const el=tree.querySelector('[data-split-id="'+CSS.escape(node.id)+'"]');el?.style.setProperty('--ratio',node.ratio);el?.querySelector(':scope>.workspace-divider')?.setAttribute('aria-valuenow',Math.round(node.ratio*100));updateRatios(node.first);updateRatios(node.second);}
  function render(){if(!layout)return;if(!menu.open)renderMenu();const root=windowId==='main'?layout.mainRoot:layout.detached.find(w=>w.id===windowId)?.root;const shape=node=>!node?null:node.kind==='group'?[node.id,node.activeViewId]:[node.id,node.axis,shape(node.first),shape(node.second)];const key=JSON.stringify(shape(root));if(key!==renderedKey){tree.replaceChildren();if(root)tree.append(build(root));renderedKey=key;}for(const el of tree.querySelectorAll('[data-workspace-group]')){el.classList.toggle('is-focused',el.dataset.workspaceGroup===activeGroup);const id=el.querySelector('[data-view-id]')?.dataset.viewId,v=layout.views[id];if(v)el.querySelector('.workspace-pane-title').textContent=viewTitle(v);}scheduleBounds();}
  function overlay(){return menu.open||[...document.querySelectorAll('dialog[open], [aria-modal="true"]:not([hidden]), .nozeli-context-menu:not([hidden]), #provider-console:not([hidden])')].some(n=>n.getClientRects().length)||document.getElementById('app')?.classList.contains('drawer-files-open')||document.getElementById('app')?.classList.contains('drawer-side-open');}
  function bounds(){frame=0;if(!layout)return;const root=windowId==='main'?layout.mainRoot:layout.detached.find(w=>w.id===windowId)?.root,min=minimum(root);host.classList.toggle('workspace-narrow',host.clientWidth<min.width||tree.clientHeight<min.height);const boxes=[];for(const el of tree.querySelectorAll('[data-workspace-content]')){const r=el.getBoundingClientRect();if(el.dataset.viewId&&r.width>0&&r.height>0)boxes.push({groupId:el.dataset.workspaceContent,viewId:el.dataset.viewId,rect:{x:r.left,y:r.top,width:r.width,height:r.height}});}void call('workspace.bounds',{projectId:layout.projectId,windowId,groups:boxes,overlay:Boolean(overlay())}).catch(e=>toast(e.message));}
  function scheduleBounds(){if(!frame)frame=requestAnimationFrame(bounds);}
  async function bindProject(projectId){layout=null;receive(await call(scope.role==='detached'?'workspace.snapshot':'workspace.project',{projectId}));}
  const open=view=>{const existing=Object.values(layout?.views||{}).find(v=>v.kind===view.kind&&(view.kind==='document'?v.relPath===view.relPath&&!v.readOnly:view.kind==='conversation'||v.resourceId===view.resourceId));return existing?activate(existing.id,group()?.id):command({type:'open',groupId:group()?.id,view});};
  new ResizeObserver(scheduleBounds).observe(host);new MutationObserver(records=>{if(records.some(r=>!host.contains(r.target)))scheduleBounds();}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['hidden','open','class']});window.addEventListener('nozeli-layout-change',scheduleBounds);
  summary.addEventListener('click',()=>{renderMenu();if(!menu.open)void refreshNamedLayouts();});menu.addEventListener('toggle',scheduleBounds);window.addEventListener('resize',scheduleBounds);window.nozeli.subscribe('workspace.changed',receive);
  window.nozeli.subscribe('workspace.changed',()=>{const root=windowId==='main'?layout?.mainRoot:layout?.detached.find(w=>w.id===windowId)?.root;updateRatios(root);});
  tree.addEventListener('keydown',event=>{const divider=event.target.closest('.workspace-divider');if(!divider||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();const split=divider.parentElement,current=Number(split.style.getPropertyValue('--ratio'))||.5;void command({type:'resize',splitId:split.dataset.splitId,ratio:event.key==='Home'?.5:Math.max(.05,Math.min(.95,current+(['ArrowLeft','ArrowUp'].includes(event.key)?-.05:.05)))});});
  async function focusPane(event={}){const all=groups();if(!all.length)return;const current=event.viewId?all.findIndex(g=>g.activeViewId===event.viewId):all.findIndex(g=>g.id===activeGroup),index=Number.isInteger(event.index)?event.index:(Math.max(0,current)+(event.direction||1)+all.length)%all.length,target=all[index];if(!target)return;activeGroup=target.id;render();if(target.activeViewId){await activate(target.activeViewId,target.id);await call('workspace.focus',{projectId:layout.projectId,viewId:target.activeViewId});}}
  window.nozeli.subscribe('workspace.control',event=>{if(event.type==='group-focus')void focusPane(event).catch(e=>toast(e.message));if(event.type==='surface-focus'&&layout){const target=groups().find(g=>g.activeViewId===event.viewId);if(target){activeGroup=target.id;render();}}if(event.type==='workspace-action'){const target=groups().find(g=>g.activeViewId===event.viewId);void command({...event.command,groupId:event.command.groupId||target?.id});}});
  document.addEventListener('workspace-action',event=>void command({...event.detail.command,groupId:event.detail.command.groupId||group()?.id}));
  document.addEventListener('keydown',event=>{const numbered=(event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&/^[1-9]$/.test(event.key);if(event.key==='F6'||numbered){event.preventDefault();void focusPane(numbered?{index:Number(event.key)-1}:{direction:event.shiftKey?-1:1}).catch(e=>toast(e.message));}});
  const api={snapshot:()=>layout,command,bindProject,open,activate,activeGroup:()=>group()?.id,activeView:()=>layout?.views[group()?.activeViewId]};window.__workspaceGroups=api;return api;
}
