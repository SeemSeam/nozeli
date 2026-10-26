import {layoutGroups} from '../domain/workspace-layout.mjs';
import './workspace-groups.css';
import {windowBrand,windowControls} from './window-chrome.mjs';
import {mountContextMenu} from './context-menu.mjs';
import {setIconButton} from './ui-icons.mjs';
import {mountWorkspaceTitleDrag} from './workspace-title-drag.mjs';
import {createStartPage} from './guided-demo.mjs';

// Renders the layout tree as single-content panes. The layout/domain owns assignment;
// this module deliberately never invents tabs or group UI.
export function mountWorkspaceGroups({invoke,scope,toast=()=>{}}){
  let layout=null, windowId=scope.windowId||'main', activeGroup=null, queue=Promise.resolve(), frame=0;
  const resizing=new Set();
  let resizeInput=null;
  let boundsSequence=0;
  let transitioning=false,transitionGeneration=0;
  window.addEventListener('nozeli-project-transition',event=>{transitioning=event.detail.active;transitionGeneration++;if(!transitioning)scheduleBounds();});
  const host=document.createElement('section');host.id='workspace-groups';host.setAttribute('aria-label','工作区');
  const tree=document.createElement('div');tree.className='workspace-tree';
  if(scope.role==='shell'){
    const toolbar=document.getElementById('app').querySelector('.topbar');

    toolbar.prepend(windowBrand());toolbar.append(windowControls(invoke));
  }
  host.append(tree);document.getElementById('reader').append(host);
  const call=async(op,payload={})=>{const r=await invoke(op,payload);if(!r.ok)throw Object.assign(new Error(r.error?.message||'工作区操作失败'),{code:r.error?.code});return r.value;};
  const titleMenu=mountContextMenu({id:'workspace-title-menu',label:'窗口操作',onError:toast,onOpen:()=>scheduleBounds(),onClose:()=>scheduleBounds()});
  mountWorkspaceTitleDrag({tree,call,toast});
  const groups=()=>layout?layoutGroups(layout,windowId):[];const group=()=>groups().find(g=>g.id===activeGroup)||groups()[0];
  const viewTitle=v=>v?.viewState?.title||({conversation:'对话',report:'报告',diff:'Diff',history:'历史',terminal:'Terminal 预览'}[v?.kind])||v?.relPath?.split('/').pop()||'文档';
  function receive(value){if(transitioning||!value?.layout)return;if(scope.role==='shell'&&layout&&value.layout.projectId!==layout.projectId)return;layout=value.layout;windowId=value.windowId||windowId;if(!groups().some(g=>g.id===activeGroup))activeGroup=groups()[0]?.id;render();}
  function command(request){const projectId=layout?.projectId;const run=queue.then(async()=>{if(!projectId||layout?.projectId!==projectId)throw new Error('项目已切换，原布局操作未执行。');const action=request.type==='dock'?{...request,windowId:request.windowId||windowId,targetGroupId:request.targetGroupId||layoutGroups(layout,'main')[0]?.id}:request;const value=await call('workspace.command',{projectId,expectedRevision:layout.revision,requestKey:crypto.randomUUID(),command:action});if(layout?.projectId===projectId)receive(value);return layout;});queue=run.catch(e=>toast(e.message));return run;}
  const button=(label,key,run)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.dataset.workspaceCommand=key;b.onpointerdown=event=>event.preventDefault();b.onclick=()=>Promise.resolve(run()).catch(e=>toast(e.message));return b;};
  let namedLayouts=[],namedProject=null,namedSequence=0;
  async function refreshNamedLayouts(){
    const projectId=layout?.projectId;if(!projectId)return;
    const sequence=++namedSequence;
    try{
      const value=await call('workspace.layouts.list',{projectId});
      if(sequence!==namedSequence||layout?.projectId!==projectId)return;
      namedProject=projectId;namedLayouts=value.layouts;
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
  async function openPaneMenu(event,node,view){
    event.preventDefault();titleMenu.close();activeGroup=node.id;
    if(scope.role==='shell')await refreshNamedLayouts();
    const actions=new Map(),items=[],add=(id,label,run)=>{actions.set(id,run);items.push({id,label});};
    if(view?.kind==='document')add('tools','文档全部操作',()=>call('workspace.control',{type:'content-tools',projectId:layout.projectId,viewId:view.id}));
    if(view?.kind==='document')add('closeContentView','关闭当前文件',()=>command({type:'close',viewId:view.id}));
    for(const [axis,label]of [['x','向右拆分'],['y','向下拆分']])add('split-'+axis,label,()=>command({type:'split',groupId:node.id,axis,side:'after'}));
    if(scope.role==='detached'){
      add('drawing','涂鸦当前窗口',async()=>{await bounds();window.dispatchEvent(new Event('nozeli-draw-current-window'));});
      add('dock','返回主窗口',()=>command({type:'dock',windowId,targetGroupId:layoutGroups(layout,'main').find(g=>!g.activeViewId)?.id||layoutGroups(layout,'main').at(-1)?.id}));
      for(const [action,label]of [['minimize','最小化'],['maximize','最大化／还原'],['close','关闭窗口']])add(action,label,()=>call('workspace.control',{type:'window-control',action}));
    }else{
      add('closePane','关闭当前分区',()=>command({type:'closePane',groupId:node.id}));
      add('layout-save','保存当前布局…',()=>nameDialog('保存当前布局','',(name,projectId)=>namedAction('save',{name},projectId)));
      for(const [index,saved]of (namedProject===layout.projectId?namedLayouts:[]).entries()){
        const projectId=layout.projectId;
        add('layout-load-'+index,'载入布局 · '+saved.name,()=>namedAction('load',{name:saved.name},projectId));
        add('layout-rename-'+index,'重命名布局 · '+saved.name,()=>nameDialog('重命名布局',saved.name,(newName,id)=>namedAction('rename',{name:saved.name,newName},id)));
        add('layout-delete-'+index,'删除布局 · '+saved.name,()=>namedAction('delete',{name:saved.name},projectId));
      }
    }
    titleMenu.open(items,{x:event.clientX,y:event.clientY,run:id=>actions.get(id)?.()});
  }
  function activate(viewId,groupId){return command({type:'activate',viewId,groupId:groupId||group()?.id});}
  const minimum=node=>{if(!node||node.kind==='group')return {width:280,height:180};const a=minimum(node.first),b=minimum(node.second);return node.axis==='x'?{width:a.width+b.width+6,height:Math.max(a.height,b.height)}:{width:Math.max(a.width,b.width),height:a.height+b.height+6};};
  function pane(node){
    const el=document.createElement('section');el.className='workspace-pane';el.dataset.workspaceGroup=node.id;el.classList.toggle('is-focused',node.id===activeGroup);
    el.addEventListener('pointerdown',()=>{activeGroup=node.id;for(const p of tree.querySelectorAll('[data-workspace-group]'))p.classList.toggle('is-focused',p===el);scheduleBounds();});
    const view=node.activeViewId&&layout.views[node.activeViewId];
    if(view?.kind!=='conversation'||scope.role==='detached'){
      const bar=document.createElement('header');bar.className='workspace-pane-header';
      const label=document.createElement('strong');label.className='workspace-pane-title';label.textContent=view?viewTitle(view):'空分区';bar.append(label);
      if(view){
        if(view.kind==='document'&&scope.role!=='detached'){
          const ext=view.relPath?.split('.').pop()?.toLowerCase();
          const common=ext==='pdf'?[['find','查找'],['page-prev','上一页'],['page-next','下一页'],['zoom-out','缩小'],['zoom-in','放大']]:ext==='docx'?[['fit','适应'],['zoom-out','缩小'],['zoom-in','放大'],['region','框选']]:ext==='pptx'?[['region','框选']]:ext==='tex'?[['find','查找'],['texBuild','编译'],['preview-toggle','预览']]:['md','markdown','txt','js','mjs','cjs','ts','tsx','jsx','json','css','html','py','rs','c','cpp','h','yml','yaml','toml'].includes(ext)?[['find','查找'],['text-mode','阅读／编辑'],['document-font-smaller','A−'],['document-font-larger','A＋']]:[];
          for(const [key,label] of common)bar.append(button(label,'content-'+key,()=>call('workspace.control',{type:'content-command',projectId:layout.projectId,viewId:view.id,command:key})));
        }
        const close=button('关闭','close',()=>command({type:'close',viewId:view.id}));close.title='关闭当前内容，不结束后台工作';bar.append(close);
        const dockTarget=()=>layoutGroups(layout,'main').find(g=>!g.activeViewId)?.id||layoutGroups(layout,'main').at(-1)?.id;
        const floating=button(windowId==='main'?'独立窗口':'返回主工作区',windowId==='main'?'floatOpen':'dock',()=>command(windowId==='main'?{type:'floatOpen',viewId:view.id}:{type:'dock',windowId,targetGroupId:dockTarget()}));floating.dataset.workspaceFloatOpen=view.id;if(windowId!=='main')floating.title='把此内容移回主窗口工作区';bar.append(floating);
      }
      if(view&&['report','history'].includes(view.kind)){const more=button('报告操作','more',()=>{const b=more.getBoundingClientRect(),content=el.querySelector('.workspace-content').getBoundingClientRect();return call('workspace.control',{type:'content-command',projectId:layout.projectId,viewId:view.id,command:'report-tools',anchor:{x:b.right-content.left,y:b.bottom-content.top}});});setIconButton(more,'ellipsis',{label:'报告操作'});more.setAttribute('aria-haspopup','menu');bar.append(more);}
      el.append(bar);
      bar.addEventListener('contextmenu',event=>void openPaneMenu(event,node,view).catch(e=>toast(e.message)));
    }
    const content=document.createElement('div');content.className='workspace-content';content.dataset.workspaceContent=node.id;if(view)content.dataset.viewId=view.id;else{content.classList.add('workspace-pane-empty');content.append(createStartPage({project:{id:layout.projectId,name:document.getElementById('project-name').textContent},compact:groups().length>1,start:()=>window.dispatchEvent(new Event('nozeli-demo-start'))}));}el.append(content);return el;
  }
  function build(node){
    if(node.kind==='group')return pane(node);
    const el=document.createElement('div');el.className='workspace-split';el.dataset.axis=node.axis;el.dataset.splitId=node.id;el.style.setProperty('--ratio',node.ratio);
    const divider=document.createElement('div');divider.className='workspace-divider';divider.tabIndex=0;divider.setAttribute('role','separator');divider.setAttribute('aria-orientation',node.axis==='x'?'vertical':'horizontal');divider.setAttribute('aria-valuenow',Math.round(node.ratio*100));
    divider.onpointerdown=event=>{
      resizeInput?.cancel();
      if(event.button!==0)return;event.preventDefault();divider.setPointerCapture(event.pointerId);
      void call('workspace.control',{type:'pane-resize',active:true}).catch(error=>toast(error.message));
      resizing.add(node.id);
      const rect=el.getBoundingClientRect(),dim=node.axis==='x'?'width':'height',size=rect[dim],start=node.axis==='x'?event.clientX:event.clientY,initial=Number(el.style.getPropertyValue('--ratio'))||node.ratio;
      const a=minimum(node.first)[dim],b=minimum(node.second)[dim],low=Math.max(.05,Math.min(.5,(a+3)/size)),high=Math.min(.95,Math.max(.5,1-(b+3)/size));
      let value=initial,changed=false,draw=0,ended=false;
      const paint=()=>{draw=0;el.style.setProperty('--ratio',value);divider.setAttribute('aria-valuenow',Math.round(value*100));scheduleBounds();};
      const move=e=>{const point=node.axis==='x'?e.clientX:e.clientY;if(!changed&&Math.abs(point-start)<3)return;changed=true;value=Math.max(low,Math.min(high,initial+(point-start)/size));if(!draw)draw=requestAnimationFrame(paint);};
      const end=(e,cancelled=false)=>{
        if(ended)return;ended=true;
        divider.removeEventListener('pointermove',move);divider.removeEventListener('pointerup',up);divider.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',key);resizeInput=null;
        resizing.delete(node.id);
        void call('workspace.control',{type:'pane-resize',active:false}).catch(error=>toast(error.message));
        if(draw)cancelAnimationFrame(draw);if(cancelled)value=initial;paint();if(divider.hasPointerCapture(event.pointerId))divider.releasePointerCapture(event.pointerId);
        if(changed&&!cancelled&&Math.abs(value-initial)>1e-6)void command({type:'resize',splitId:node.id,ratio:value}).catch(error=>toast(error.message));
      };
      const up=e=>end(e),cancel=e=>end(e,true),key=e=>{if(e.key==='Escape'){e.preventDefault();end(e,true);}};
      resizeInput={move,up,cancel};
      divider.addEventListener('pointermove',move);divider.addEventListener('pointerup',up);divider.addEventListener('pointercancel',cancel);document.addEventListener('keydown',key);
    };
    el.append(build(node.first),divider,build(node.second));return el;
  }
  window.nozeli.subscribe('workspace.control',event=>{if(event.type!=='pane-pointer'||!resizeInput)return;const point={clientX:event.clientX,clientY:event.clientY};if(event.eventType==='pointermove'&&event.buttons)resizeInput.move(point);else if(event.eventType==='pointerup')resizeInput.up(point);else if(event.eventType==='pointercancel')resizeInput.cancel(point);});
  window.addEventListener('pointerup',event=>resizeInput?.up(event),true);
  window.addEventListener('blur',()=>resizeInput?.cancel());
  let renderedKey='',renderedPanes=new Map();
  function updateRatios(node){if(node?.kind!=='split')return;const el=tree.querySelector('[data-split-id="'+CSS.escape(node.id)+'"]');if(!resizing.has(node.id)){el?.style.setProperty('--ratio',node.ratio);el?.querySelector(':scope>.workspace-divider')?.setAttribute('aria-valuenow',Math.round(node.ratio*100));}updateRatios(node.first);updateRatios(node.second);}
  // Only the topology key rebuilds the tree; switching a pane's active view swaps that
  // pane in place so other panes keep their headers, menus and measured bounds.
  function render(){if(!layout)return;const root=windowId==='main'?layout.mainRoot:layout.detached.find(w=>w.id===windowId)?.root;const shape=node=>!node?null:node.kind==='group'?[node.id]:[node.id,node.axis,shape(node.first),shape(node.second)];const key=JSON.stringify(shape(root));if(key!==renderedKey){tree.replaceChildren();if(root)tree.append(build(root));renderedKey=key;renderedPanes.clear();for(const el of tree.querySelectorAll('[data-workspace-group]'))renderedPanes.set(el.dataset.workspaceGroup,el.querySelector('[data-view-id]')?.dataset.viewId||'');}
    for(const g of groups()){let el=tree.querySelector('[data-workspace-group="'+CSS.escape(g.id)+'"]');const viewId=g.activeViewId||'';
      if(el&&renderedPanes.get(g.id)!==viewId){const next=pane(g);next.dataset.renderedView=viewId;el.replaceWith(next);renderedPanes.set(g.id,viewId);el=next;}
      else if(!el){const next=pane(g);next.dataset.renderedView=viewId;renderedPanes.set(g.id,viewId);}
      if(!el)continue;el.classList.toggle('is-focused',g.id===activeGroup);
      const v=viewId?layout.views[viewId]:null,label=el.querySelector('.workspace-pane-title');
      if(v&&label){label.textContent=viewTitle(v)+(v.viewState?.documentStatus?.dirty?' · 未保存':'');label.title=v.relPath||viewTitle(v);}}
    scheduleBounds();}
  function overlays(){return [...document.querySelectorAll('dialog[open], [aria-modal="true"]:not([hidden]), .nozeli-context-menu:not([hidden]), #provider-console:not([hidden])')].filter(n=>n.getClientRects().length).map(n=>{const r=n.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height};});}
  function bounds(){
    frame=0;if(transitioning||!layout)return;
    const root=windowId==='main'?layout.mainRoot:layout.detached.find(w=>w.id===windowId)?.root,min=minimum(root),narrow=host.clientWidth<min.width||tree.clientHeight<min.height;
    if(narrow&&!group()?.activeViewId){const occupied=groups().find(g=>g.activeViewId);if(occupied){activeGroup=occupied.id;for(const pane of tree.querySelectorAll('[data-workspace-group]'))pane.classList.toggle('is-focused',pane.dataset.workspaceGroup===activeGroup);}}
    host.classList.toggle('workspace-narrow',narrow);
    const boxes=[];for(const el of tree.querySelectorAll('[data-workspace-content]')){const r=el.getBoundingClientRect();if(el.dataset.viewId&&r.width>0&&r.height>0)boxes.push({groupId:el.dataset.workspaceContent,viewId:el.dataset.viewId,rect:{x:r.left,y:r.top,width:r.width,height:r.height}});}
    const overlayRects=overlays(),drawer=document.getElementById('app')?.classList.contains('drawer-files-open')||document.getElementById('app')?.classList.contains('drawer-side-open');
    const generation=transitionGeneration;return call('workspace.bounds',{projectId:layout.projectId,windowId,layoutRevision:layout.revision,sequence:++boundsSequence,viewport:{width:innerWidth,height:innerHeight},groups:boxes,overlay:Boolean(drawer),overlayRects}).catch(e=>{if(!transitioning&&generation===transitionGeneration)toast(e.message);});
  }
  function scheduleBounds(){if(!frame)frame=setTimeout(bounds,0);}
  async function bindProject(projectId){const value=await call(scope.role==='detached'?'workspace.snapshot':'workspace.project',{projectId});layout=value.layout;windowId=value.windowId||windowId;activeGroup=groups()[0]?.id;try{render();}catch(error){toast('项目已切换，布局显示失败：'+error.message);}}
  const open=async view=>{const existing=Object.values(layout?.views||{}).find(v=>v.kind===view.kind&&(view.kind==='document'?v.relPath===view.relPath&&!v.readOnly:view.kind==='conversation'||v.resourceId===view.resourceId));if(!existing)return command({type:'open',groupId:group()?.id,view});if(view.kind==='history'&&view.viewState?.report){await command({type:'restoreViewState',viewId:existing.id,viewState:view.viewState});await activate(existing.id,group()?.id);await call('workspace.control',{type:'history-refresh',projectId:layout.projectId,viewId:existing.id,report:view.viewState.report});return;}return activate(existing.id,group()?.id);};
  const geometryObserver=new ResizeObserver(scheduleBounds);geometryObserver.observe(host);geometryObserver.observe(tree);new MutationObserver(records=>{if(records.some(r=>!host.contains(r.target)))scheduleBounds();}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['hidden','open','class']});window.addEventListener('nozeli-layout-change',scheduleBounds);
  window.addEventListener('resize',scheduleBounds);window.nozeli.subscribe('workspace.changed',receive);
  window.nozeli.subscribe('workspace.control',event=>{if(event.type==='report-tools-closed'&&event.projectId===layout?.projectId){const content=[...tree.querySelectorAll('[data-workspace-content]')].find(n=>n.dataset.viewId===event.sourceViewId||n.dataset.viewId===event.viewId);content?.closest('.workspace-pane')?.querySelector('[data-workspace-command="more"]')?.focus({preventScroll:true});}});
  window.nozeli.subscribe('workspace.control',event=>{if(event.type==='viewport-changed')scheduleBounds();});
  window.nozeli.subscribe('workspace.changed',()=>{const root=windowId==='main'?layout?.mainRoot:layout?.detached.find(w=>w.id===windowId)?.root;updateRatios(root);});
  window.nozeli.subscribe('workspace.changed',()=>{if(scope.role!=='shell'||!layout)return;const chat=Object.values(layout.views).find(v=>v.kind==='conversation'),shown=chat&&['main',...layout.detached.map(w=>w.id)].some(id=>layoutGroups(layout,id).some(g=>g.activeViewId===chat.id));document.getElementById('workspace-open-conversation').classList.toggle('conversation-minimized',Boolean(chat&&!shown));});
  tree.addEventListener('keydown',event=>{const divider=event.target.closest('.workspace-divider');if(!divider||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();const split=divider.parentElement,current=Number(split.style.getPropertyValue('--ratio'))||.5;void command({type:'resize',splitId:split.dataset.splitId,ratio:event.key==='Home'?.5:Math.max(.05,Math.min(.95,current+(['ArrowLeft','ArrowUp'].includes(event.key)?-.05:.05)))});});
  async function focusPane(event={}){const all=groups();if(!all.length)return;const current=event.viewId?all.findIndex(g=>g.activeViewId===event.viewId):all.findIndex(g=>g.id===activeGroup),index=Number.isInteger(event.index)?event.index:(Math.max(0,current)+(event.direction||1)+all.length)%all.length,target=all[index];if(!target)return;activeGroup=target.id;render();if(target.activeViewId){await activate(target.activeViewId,target.id);await call('workspace.focus',{projectId:layout.projectId,viewId:target.activeViewId});}}
  window.nozeli.subscribe('workspace.control',event=>{if(event.type==='group-focus')void focusPane(event).catch(e=>toast(e.message));if(event.type==='surface-focus'&&layout){const target=groups().find(g=>g.activeViewId===event.viewId);if(target){activeGroup=target.id;render();}}if(event.type==='workspace-action'){const target=groups().find(g=>g.activeViewId===event.viewId),request={...event.command};if(!request.viewId&&request.type!=='dock')request.groupId??=target?.id;void command(request).catch(e=>toast(e.message));}});
  document.addEventListener('workspace-action',event=>{const request={...event.detail.command};if(!request.viewId&&request.type!=='dock')request.groupId??=group()?.id;void command(request).catch(e=>toast(e.message));});
  document.addEventListener('keydown',event=>{const numbered=(event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&/^[1-9]$/.test(event.key);if(event.key==='F6'||numbered){event.preventDefault();void focusPane(numbered?{index:Number(event.key)-1}:{direction:event.shiftKey?-1:1}).catch(e=>toast(e.message));}});
  function clear(){layout=null;activeGroup=null;renderedKey='';renderedPanes.clear();tree.replaceChildren();tree.append(createStartPage({start:()=>window.dispatchEvent(new Event('nozeli-demo-start'))}));}
  clear();
  const api={snapshot:()=>layout,clear,command,bindProject,open,activate,activeGroup:()=>group()?.id,activeView:()=>layout?.views[group()?.activeViewId]};window.__workspaceGroups=api;return api;
}
