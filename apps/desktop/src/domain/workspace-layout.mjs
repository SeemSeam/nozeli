import { validateDocumentSource, documentResourceId, isProjectDocumentSource } from './document-source.mjs';
const encoder=new TextEncoder();

const kinds=new Set(['document','conversation','report','diff','history','terminal']);
const invalid=(message,code='LAYOUT_INVALID')=>{throw Object.assign(new Error(message),{code});};
const id=prefix=>prefix+'-'+globalThis.crypto.randomUUID();
const historyLimit=5;
const group=()=>({kind:'group',id:id('group'),views:[],activeViewId:null,historyViewIds:[]});
const clone=value=>structuredClone(value);
const relPath=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\\\x00-\x1f]/.test(value)&&!value.startsWith('/')&&!value.split('/').some(part=>!part||part==='.'||part==='..');
const identity=(value,max=200)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f]/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
function roots(layout){return [{id:'main',root:layout.mainRoot},...layout.detached];}
function walk(node,fn,parent=null,key=null){fn(node,parent,key);if(node.kind==='split'){walk(node.first,fn,node,'first');walk(node.second,fn,node,'second');}}
export function layoutGroups(layout,windowId='main'){
 const root=roots(layout).find(entry=>entry.id===windowId)?.root;
 if(!root)return [];
 const result=[];walk(root,node=>{if(node.kind==='group')result.push(node);});return result;
}
export function findGroup(layout,groupId){
 for(const entry of roots(layout)){let found=null;walk(entry.root,node=>{if(node.kind==='group'&&node.id===groupId)found=node;});if(found)return {group:found,windowId:entry.id};}return null;
}
export function findView(layout,viewId){
 const view=layout.views[viewId];if(!view)return null;
 for(const entry of roots(layout))for(const candidate of layoutGroups(layout,entry.id))if(candidate.views.includes(viewId))return {view,group:candidate,windowId:entry.id};return null;
}
function replaceNode(layout,nodeId,next){
 for(const entry of roots(layout)){
  if(entry.root.id===nodeId){if(entry.id==='main')layout.mainRoot=next;else layout.detached.find(w=>w.id===entry.id).root=next;return true;}
  let replaced=false;walk(entry.root,(node,parent,key)=>{if(node.id===nodeId&&parent){parent[key]=next;replaced=true;}});if(replaced)return true;
 }return false;
}
function removeNode(layout,nodeId){
 for(const entry of roots(layout)){
  if(entry.root.id===nodeId){if(entry.id==='main')layout.mainRoot=group();else layout.detached=layout.detached.filter(w=>w.id!==entry.id);delete layout.maximized[entry.id];return;}
  let parentNode=null,sibling=null;walk(entry.root,(node,parent,key)=>{if(node.id===nodeId&&parent){parentNode=parent;sibling=parent[key==='first'?'second':'first'];}});
  if(parentNode){replaceNode(layout,parentNode.id,sibling);if(layout.maximized[entry.id]===nodeId)delete layout.maximized[entry.id];return;}
 }
 invalid('找不到工作区分区。');
}
function checkedGroup(layout,groupId){const result=groupId?findGroup(layout,groupId):{group:layoutGroups(layout)[0],windowId:'main'};if(!result?.group)invalid('工作区分区已变化。','LAYOUT_STALE');return result;}
function checkedView(layout,viewId){const result=findView(layout,viewId);if(!result)invalid('工作区标签已变化。','LAYOUT_STALE');return result;}
function forgetHistory(layout,viewId){for(const entry of roots(layout))for(const pane of layoutGroups(layout,entry.id))if(pane.historyViewIds)pane.historyViewIds=pane.historyViewIds.filter(v=>v!==viewId);}
function detachFromGroup(layout,viewId){const {group:source}=checkedView(layout,viewId);source.views=source.views.filter(v=>v!==viewId);if(source.activeViewId===viewId)source.activeViewId=source.views.at(-1)??null;forgetHistory(layout,viewId);return source;}
function addToGroup(target,viewId){
 const previous=target.activeViewId;
 target.historyViewIds=(target.historyViewIds??[]).filter(v=>v!==viewId&&v!==previous);
 if(previous&&previous!==viewId)target.historyViewIds.unshift(previous);
 target.historyViewIds=target.historyViewIds.slice(0,historyLimit);
 target.views=[viewId];target.activeViewId=viewId;
}
function restoreDocument(layout,target){
 while(target.historyViewIds?.length){
  const viewId=target.historyViewIds.shift();
  if(layout.views[viewId]&&!findView(layout,viewId)){target.views=[viewId];target.activeViewId=viewId;return;}
 }
}
function cleanup(layout,previous){
 // Remove windows emptied by an operation, not intentional empty panes or windows.
 for(const entry of [...layout.detached])if(layoutGroups(previous,entry.id).some(g=>g.views.length)&&!layoutGroups(layout,entry.id).some(g=>g.views.length)){layout.detached=layout.detached.filter(w=>w.id!==entry.id);delete layout.maximized[entry.id];}
 for(const [windowId,groupId]of Object.entries(layout.maximized))if(!layoutGroups(layout,windowId).some(g=>g.id===groupId))delete layout.maximized[windowId];
}
function closeView(layout,viewId,{restore=true}={}){const view=layout.views[viewId];if(!view)invalid('已打开文件已变化。','LAYOUT_STALE');const found=findView(layout,viewId);layout.closedViews??=[];layout.closedViews.push({view:clone(view),groupId:found?.group.id});layout.closedViews=layout.closedViews.slice(-50);if(found)detachFromGroup(layout,viewId);else forgetHistory(layout,viewId);delete layout.views[viewId];if(found&&restore)restoreDocument(layout,found.group);}
export function validateLayout(layout){
 if(!layout||layout.schema!==2||!identity(layout.projectId)||!Number.isSafeInteger(layout.revision)||layout.revision<0||!Array.isArray(layout.detached)||!layout.views||typeof layout.views!=='object'||Array.isArray(layout.views)||!layout.maximized||typeof layout.maximized!=='object'||Array.isArray(layout.maximized))invalid('工作区布局记录无效。');
 if(Object.keys(layout.views).length>512||encoder.encode(JSON.stringify(layout)).byteLength>1024*1024)invalid('工作区布局超过容量限制。','LAYOUT_LIMIT');
 const nodes=new Set(),assigned=new Set(),windowIds=new Set(['main']);let conversation=0;
 for(const [viewId,view]of Object.entries(layout.views)){
  if(!view||typeof view!=='object'||view.id!==viewId||!identity(viewId)||view.projectId!==layout.projectId||!kinds.has(view.kind)||!identity(view.resourceId,8192))invalid('工作区内容身份无效。');
  if(view.kind==='document'&&!relPath(view.relPath))invalid('工作区文档路径无效。');
  if(view.kind==='document'){
   let source;
   try{source=validateDocumentSource(view.documentSource);}catch(error){invalid(error.message);}
   const expected=documentResourceId(layout.projectId,source,view.relPath);
   if(view.resourceId!==expected)invalid('文档资源身份与来源不一致。');
   if(isProjectDocumentSource(view.documentSource)&&view.documentSource!==undefined)invalid('项目文档不携带文档来源。');
  }
  if(view.kind==='conversation'&&++conversation>1)invalid('项目主对话不能重复。');
  if(view.kind==='terminal'&&(!identity(view.viewState?.workId)||view.resourceId!=='terminal:'+view.viewState.workId))invalid('终端预览缺少有效工作身份。');
  if(view.kind==='document'&&view.viewState?.reviewSource!==undefined)invalid('审校文档必须使用顶层文档来源，不能沿用旧报告来源。');
  if(view.kind!=='document'&&view.documentSource!==undefined)invalid('只有文档携带文档来源。');
 }
 function inspect(node,depth){
  if(!node||typeof node!=='object'||depth>16||!identity(node.id)||nodes.has(node.id))invalid('工作区布局循环、重复或过深。');nodes.add(node.id);
  if(node.kind==='split'){
   if(!['x','y'].includes(node.axis)||!Number.isFinite(node.ratio)||node.ratio<.05||node.ratio>.95)invalid('工作区分割比例无效。');inspect(node.first,depth+1);inspect(node.second,depth+1);
  }else if(node.kind==='group'){
   if(!Array.isArray(node.views)||layout.singleContent===true&&node.views.length>1||node.activeViewId!==null&&!node.views.includes(node.activeViewId)||node.views.length&&node.activeViewId===null)invalid('每个工作区分区只能呈现一个文件或对话。');
   for(const v of node.views){if(!Object.hasOwn(layout.views,v)||assigned.has(v))invalid('工作区内容重复或丢失。');assigned.add(v);}
   if(node.historyViewIds!==undefined&&(!Array.isArray(node.historyViewIds)||node.historyViewIds.length>historyLimit||new Set(node.historyViewIds).size!==node.historyViewIds.length||node.historyViewIds.some(v=>!Object.hasOwn(layout.views,v)||node.views.includes(v))))invalid('工作区访问历史无效。');
  }else invalid('工作区节点类型无效。');
 }
 inspect(layout.mainRoot,0);
 for(const window of layout.detached){
  if(!identity(window.id)||windowIds.has(window.id))invalid('独立窗口身份重复。');windowIds.add(window.id);
  if(window.alwaysOnTop!==undefined&&typeof window.alwaysOnTop!=='boolean')invalid('窗口置顶设置无效。');
  if(window.boundsDip!==undefined){const b=window.boundsDip;if(!b||!['x','y','width','height'].every(k=>Number.isFinite(b[k]))||b.width<1||b.height<1||Object.values(b).some(n=>Math.abs(n)>1e7))invalid('窗口尺寸无效。');}
  inspect(window.root,0);
 }
 if(layout.singleContent!==true&&assigned.size!==Object.keys(layout.views).length)invalid('工作区存在未归属内容。');
 for(const [windowId,groupId]of Object.entries(layout.maximized))if(!layoutGroups(layout,windowId).some(g=>g.id===groupId))invalid('工作区最大化目标无效。');
 return layout;
}
export function singleContentLayout(input){const layout=clone(input);for(const root of roots(layout))walk(root.root,node=>{if(node.kind==='group'&&node.historyViewIds)node.historyViewIds=[...new Set(node.historyViewIds)].filter(v=>layout.views[v]&&!node.views.includes(v)).slice(0,historyLimit);});if(layout.singleContent===true)return validateLayout(layout);for(const root of roots(layout))walk(root.root,node=>{if(node.kind==='group'){const active=node.activeViewId&&node.views.includes(node.activeViewId)?node.activeViewId:node.views.at(-1)??null;node.views=active?[active]:[];node.activeViewId=active;}});layout.singleContent=true;layout.revision++;return validateLayout(layout);}
export function createLayout(projectId,legacy={}){
 if(!identity(projectId))invalid('项目身份无效。');
 const first=group(),layout={schema:2,singleContent:true,projectId,revision:0,mainRoot:first,detached:[],views:{},maximized:{}};
 const old=legacy.workspace??legacy;
 const paths=[...new Set([...(Array.isArray(old.openFiles)?old.openFiles:[]),...(legacy.currentRelPath?[legacy.currentRelPath]:[])])].filter(relPath).slice(0,200);
 for(const path of paths){const viewId=id('view');layout.views[viewId]={id:viewId,projectId,resourceId:'document:'+path,kind:'document',relPath:path};first.views.push(viewId);first.activeViewId=viewId;}
 if(legacy.currentRelPath){const active=first.views.find(v=>layout.views[v].relPath===legacy.currentRelPath);if(active)first.activeViewId=active;}
 first.views=first.activeViewId?[first.activeViewId]:[];
 if(old.minimized!==true){const viewId=id('view');layout.views[viewId]={id:viewId,projectId,resourceId:'conversation:'+projectId,kind:'conversation'};if(old.chatExpanded&&!first.activeViewId)addToGroup(first,viewId);}
 return validateLayout(layout);
}
function split(layout,command){
 const {group:source}=checkedGroup(layout,command.groupId);
 if(!['x','y'].includes(command.axis)||!['before','after'].includes(command.side??'after'))invalid('分屏方向无效。');
 const fresh=group();const before=command.side==='before';replaceNode(layout,source.id,{kind:'split',id:id('split'),axis:command.axis,ratio:.5,first:before?fresh:source,second:before?source:fresh});
 if(command.moveViewId){checkedView(layout,command.moveViewId);detachFromGroup(layout,command.moveViewId);addToGroup(fresh,command.moveViewId);}return fresh;
}
export function reduceLayout(previous,command){
 validateLayout(previous);if(!command||typeof command!=='object')invalid('工作区操作无效。');const layout=clone(previous);
 switch(command.type){
  case 'open':{
   const target=checkedGroup(layout,command.groupId).group;let v=command.view;
   if(!v||!kinds.has(v.kind)||v.projectId!==undefined&&v.projectId!==layout.projectId)invalid('工作区内容属于另一个项目。');
   let documentSource;
   if(v.kind==='document'){
    try{documentSource=validateDocumentSource(v.documentSource);}catch(error){invalid(error.message);}
    if(documentSource.type==='project'){const{documentSource:omit,...rest}=v;v=rest;}
    else v={...v,documentSource};
   }
   const resourceId=v.kind==='document'?documentResourceId(layout.projectId,documentSource,v.relPath):v.resourceId||(v.kind==='conversation'?'conversation:'+layout.projectId:null);
   if(!identity(resourceId,8192))invalid('工作区资源身份缺失。');
   const singleton=v.kind==='conversation'?Object.values(layout.views).find(entry=>entry.kind==='conversation'):null;
   const existing=singleton||(!command.duplicate?target.views.map(viewId=>layout.views[viewId]).find(entry=>entry.resourceId===resourceId&&Boolean(entry.readOnly)===Boolean(v.readOnly)):null);
   if(existing){const found=findView(layout,existing.id);if(found)found.group.activeViewId=existing.id;else addToGroup(target,existing.id);break;}
   const viewId=v.id??id('view');if(Object.hasOwn(layout.views,viewId))invalid('标签身份已存在。');
   layout.views[viewId]={...clone(v),id:viewId,projectId:layout.projectId,resourceId};addToGroup(target,viewId,command.index);break;
  }
  case 'activate':{const view=layout.views[command.viewId];if(!view)invalid('已打开文件已变化。','LAYOUT_STALE');const found=findView(layout,command.viewId);if(found)found.group.activeViewId=command.viewId;else addToGroup(checkedGroup(layout,command.groupId).group,command.viewId);break;}
  case 'splitOpen':{const source=layout.views[command.viewId];if(!source)invalid('已打开文件不存在。','LAYOUT_STALE');const fresh=split(layout,{groupId:command.groupId,axis:command.axis,side:command.side??'after'});let viewId=source.id;if(findView(layout,viewId)){if(source.kind==='conversation')invalid('项目对话只能呈现一次，请移动对话。');viewId=id('view');layout.views[viewId]={...clone(source),id:viewId,readOnly:true,sourceViewId:source.sourceViewId??source.id};}addToGroup(fresh,viewId);break;}
  case 'closePane':{const {group:source}=checkedGroup(layout,command.groupId);source.views=[];source.activeViewId=null;removeNode(layout,source.id);break;}
  case 'duplicate':{const source=layout.views[command.viewId];if(!source||source.kind!=='document')invalid('此内容不能分屏阅读。');const found=findView(layout,source.id),target=command.axis?split(layout,{groupId:command.targetGroupId??found?.group.id,axis:command.axis,side:command.side??'after'}):checkedGroup(layout,command.targetGroupId??found?.group.id).group;const viewId=id('view');layout.views[viewId]={...clone(source),id:viewId,readOnly:true,sourceViewId:source.sourceViewId??source.id};addToGroup(target,viewId);break;}
  case 'reopenClosed':{const record=layout.closedViews?.pop();if(!record)break;if(record.view.kind==='conversation'&&Object.values(layout.views).some(v=>v.kind==='conversation'))break;const target=checkedGroup(layout,command.groupId??(findGroup(layout,record.groupId)?record.groupId:undefined)).group;const viewId=Object.hasOwn(layout.views,record.view.id)?id('view'):record.view.id;layout.views[viewId]={...record.view,id:viewId,preview:false};addToGroup(target,viewId);break;}
  case 'split':split(layout,command);break;
  case 'move':{checkedView(layout,command.viewId);const target=checkedGroup(layout,command.targetGroupId).group;detachFromGroup(layout,command.viewId);addToGroup(target,command.viewId,command.index);break;}
  case 'moveGroup':{
   const source=checkedGroup(layout,command.groupId).group,target=checkedGroup(layout,command.targetGroupId).group;
   if(source.id===target.id)break;
   for(const viewId of source.views)forgetHistory(layout,viewId);
   if(command.axis!==undefined){if(!['x','y'].includes(command.axis)||!['before','after'].includes(command.side??'after'))invalid('分屏方向无效。');removeNode(layout,source.id);const current=checkedGroup(layout,target.id).group;replaceNode(layout,current.id,{kind:'split',id:id('split'),axis:command.axis,ratio:.5,first:command.side==='before'?source:current,second:command.side==='before'?current:source});}
   else{for(const v of source.views)addToGroup(target,v);source.views=[];source.activeViewId=null;removeNode(layout,source.id);}break;
  }
  case 'resize':{
   let found=false;for(const entry of roots(layout))walk(entry.root,node=>{if(node.id===command.splitId&&node.kind==='split'){node.ratio=command.ratio;found=true;}});if(!found)invalid('分割线已变化。','LAYOUT_STALE');break;
  }
  case 'preset':{
   const windowId=command.windowId??'main',entry=roots(layout).find(w=>w.id===windowId);if(!entry)invalid('窗口已变化。','LAYOUT_STALE');
   const count={single:1,columns:2,rows:2,three:3,grid:4}[command.preset];if(!count)invalid('布局预设无效。');
   const original=layoutGroups(layout,windowId),next=Array.from({length:count},()=>group());
   original.forEach((g,index)=>{if(index<count){next[index].historyViewIds=[...(g.historyViewIds??[])];if(g.activeViewId)addToGroup(next[index],g.activeViewId);}});
   next.forEach(g=>g.activeViewId??=g.views[0]??null);
   const pair=(axis,a,b,ratio=.5)=>({kind:'split',id:id('split'),axis,ratio,first:a,second:b});
   const root=count===1?next[0]:count===2?pair(command.preset==='rows'?'y':'x',...next):count===3?pair('x',next[0],pair('x',next[1],next[2]),1/3):pair('y',pair('x',next[0],next[1]),pair('x',next[2],next[3]));
   if(windowId==='main')layout.mainRoot=root;else layout.detached.find(w=>w.id===windowId).root=root;delete layout.maximized[windowId];break;
  }
  case 'maximize':{const found=checkedGroup(layout,command.groupId);if(layout.maximized[found.windowId]===command.groupId)delete layout.maximized[found.windowId];else layout.maximized[found.windowId]=command.groupId;break;}
  case 'detach':{
   if(!identity(command.windowId)||roots(layout).some(w=>w.id===command.windowId)||Boolean(command.viewId)===Boolean(command.groupId))invalid('独立窗口目标无效。');
   let target;if(command.groupId){target=checkedGroup(layout,command.groupId).group;for(const viewId of target.views)forgetHistory(layout,viewId);removeNode(layout,target.id);}else{if(!layout.views[command.viewId])invalid('已打开文件不存在。');if(findView(layout,command.viewId))detachFromGroup(layout,command.viewId);else forgetHistory(layout,command.viewId);target=group();addToGroup(target,command.viewId);}
   layout.detached.push({id:command.windowId,root:target,alwaysOnTop:false});break;
  }
  case 'dock':{
   const window=layout.detached.find(w=>w.id===command.windowId);if(!window)invalid('独立窗口已变化。','LAYOUT_STALE');const target=checkedGroup(layout,command.targetGroupId).group;
   if(layoutGroups(layout,window.id).some(g=>g.id===target.id))invalid('不能停靠到原窗口。');
   for(const g of layoutGroups(layout,window.id))for(const viewId of g.views){forgetHistory(layout,viewId);const fresh=target.activeViewId?split(layout,{groupId:target.id,axis:'x',side:'after'}):target;addToGroup(fresh,viewId);fresh.historyViewIds=[...new Set([...(fresh.historyViewIds??[]),...(g.historyViewIds??[])])].slice(0,historyLimit);}
   layout.detached=layout.detached.filter(w=>w.id!==window.id);delete layout.maximized[window.id];break;
  }
  case 'close':{if(layout.views[command.viewId]?.kind==='conversation'){const found=findView(layout,command.viewId);if(found){detachFromGroup(layout,command.viewId);restoreDocument(layout,found.group);}}else closeView(layout,command.viewId);break;}
  case 'closeContent':{const view=layout.views[command.viewId];if(!view)invalid('已打开文件已变化。','LAYOUT_STALE');const found=findView(layout,command.viewId);if(found){detachFromGroup(layout,command.viewId);restoreDocument(layout,found.group);}break;}
  case 'closeGroup':{const {group:source}=checkedGroup(layout,command.groupId);for(const v of [...source.views])closeView(layout,v,{restore:false});removeNode(layout,source.id);break;}
  case 'windowBounds':{const window=layout.detached.find(w=>w.id===command.windowId);if(!window)invalid('独立窗口已变化。','LAYOUT_STALE');window.boundsDip=clone(command.boundsDip);if(command.alwaysOnTop!==undefined)window.alwaysOnTop=command.alwaysOnTop;break;}
  case 'restoreViewState':{if(!layout.views[command.viewId])invalid('已打开文件不存在。');layout.views[command.viewId].viewState=clone(command.viewState);break;}
  case 'renameResource':{
   if(!relPath(command.from)||!relPath(command.to))invalid('资源重命名路径无效。');
   for(const view of Object.values(layout.views))if(view.documentSource===undefined&&(view.relPath===command.from||view.relPath?.startsWith(command.from+'/'))){
    const prior=view.relPath;view.relPath=command.to+prior.slice(command.from.length);
    if(view.resourceId==='document:'+prior)view.resourceId='document:'+view.relPath;
   }
   break;
  }
  default:invalid('未知工作区操作。');
 }
 if(command.type!=='closeContent')cleanup(layout,previous);layout.revision++;return validateLayout(layout);
}
