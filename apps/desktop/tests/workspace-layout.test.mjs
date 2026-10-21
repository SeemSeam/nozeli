import test from 'node:test';import assert from 'node:assert/strict';
import {createLayout,validateLayout,singleContentLayout,reduceLayout,layoutGroups,findGroup,findView} from '../src/domain/workspace-layout.mjs';
const empty=()=>createLayout('project-a',{workspace:{minimized:true}}),open=(s,name,groupId)=>reduceLayout(s,{type:'open',groupId,view:{kind:'document',relPath:name}}),ids=s=>Object.keys(s.views).sort();
const single=s=>{for(const pane of [ ...layoutGroups(s),...s.detached.flatMap(w=>layoutGroups(s,w.id))]){assert(pane.views.length<=1);assert.equal(pane.activeViewId,pane.views[0]??null);}validateLayout(s);};
test('opening another file replaces presentation and retains flat opened metadata',()=>{let s=open(empty(),'a.md');const first=Object.keys(s.views)[0],before=structuredClone(s);s=open(s,'b.md');assert.equal(Object.keys(s.views).length,2);assert.equal(findView(s,first),null);assert.equal(s.views[first].relPath,'a.md');assert.equal(before.mainRoot.activeViewId,first);single(s);s=reduceLayout(s,{type:'activate',viewId:first,groupId:s.mainRoot.id});assert.equal(s.mainRoot.activeViewId,first);single(s);});
test('split-open from opened file creates exactly one adjacent reading view',()=>{let s=open(empty(),'a.md');const writer=Object.keys(s.views)[0];s=reduceLayout(s,{type:'splitOpen',viewId:writer,groupId:s.mainRoot.id,axis:'x'});assert.equal(layoutGroups(s).length,2);const mirror=Object.values(s.views).find(v=>v.sourceViewId===writer);assert(mirror.readOnly);assert.equal(mirror.resourceId,s.views[writer].resourceId);assert.equal(findView(s,writer).windowId,'main');single(s);});
test('split-open an inactive opened file uses its existing view identity',()=>{let s=open(empty(),'a.md');const first=Object.keys(s.views)[0];s=open(s,'b.md');const count=Object.keys(s.views).length;s=reduceLayout(s,{type:'splitOpen',viewId:first,groupId:s.mainRoot.id,axis:'y'});assert.equal(Object.keys(s.views).length,count);assert(findView(s,first));assert.equal(layoutGroups(s).length,2);single(s);});
test('floating and docking preserve references without creating a tab stack',()=>{let s=open(empty(),'a.txt');const a=Object.keys(s.views)[0];s=reduceLayout(s,{type:'restoreViewState',viewId:a,viewState:{pdfPage:4,scrollTop:120}});s=reduceLayout(s,{type:'detach',viewId:a,windowId:'floating'});assert.equal(findView(s,a).windowId,'floating');s=open(s,'b.txt');s=reduceLayout(s,{type:'dock',windowId:'floating'});assert.equal(s.detached.length,0);assert.equal(layoutGroups(s).length,2);assert.deepEqual(s.views[a].viewState,{pdfPage:4,scrollTop:120});single(s);});
test('moving the only conversation to main removes its empty floating tree and preserves metadata',()=>{
 let s=reduceLayout(empty(),{type:'open',view:{kind:'conversation',pinned:true,preview:false}});const chat=s.mainRoot.activeViewId,main=s.mainRoot.id;
 s=reduceLayout(s,{type:'restoreViewState',viewId:chat,viewState:{scrollTop:120,draft:'retained'}});
 s=reduceLayout(s,{type:'detach',viewId:chat,windowId:'chat-window'});const source=findView(s,chat).group.id;
 s=reduceLayout(s,{type:'split',groupId:source,axis:'x'});
 s=reduceLayout(s,{type:'split',groupId:source,axis:'y'});
 s=reduceLayout(s,{type:'maximize',groupId:source});const expected=structuredClone(s.views),before=structuredClone(s);
 s=reduceLayout(s,{type:'move',viewId:chat,targetGroupId:main});
 assert.equal(s.detached.length,0);assert.equal(s.maximized['chat-window'],undefined);
 assert.equal(findView(s,chat).windowId,'main');assert.deepEqual(s.views,expected);
 assert.equal(before.detached.length,1);assert.equal(findView(before,chat).windowId,'chat-window');single(s);
});
test('moving content out preserves floating split panes while another real view remains',()=>{
 let s=reduceLayout(empty(),{type:'open',view:{kind:'conversation'}});const chat=s.mainRoot.activeViewId,main=s.mainRoot.id;
 s=reduceLayout(s,{type:'detach',viewId:chat,windowId:'floating'});const chatPane=findView(s,chat).group.id;
 s=reduceLayout(s,{type:'split',groupId:chatPane,axis:'x'});
 const documentPane=layoutGroups(s,'floating').find(g=>g.id!==chatPane).id;s=open(s,'retained.md',documentPane);
 s=reduceLayout(s,{type:'split',groupId:documentPane,axis:'y'});
 const paneIds=layoutGroups(s,'floating').map(g=>g.id),expected=structuredClone(s.views),document=s.views[findGroup(s,documentPane).group.activeViewId];
 s=reduceLayout(s,{type:'move',viewId:chat,targetGroupId:main});
 assert.equal(s.detached.length,1);assert.deepEqual(layoutGroups(s,'floating').map(g=>g.id),paneIds);
 assert.equal(layoutGroups(s,'floating').filter(g=>!g.views.length).length,2);
 assert.equal(findView(s,document.id).windowId,'floating');assert.deepEqual(s.views,expected);single(s);
});
test('split transfer and group detachment remove the source floating tree when its last content leaves',()=>{
 for(const transfer of ['split','detach']){
  let s=open(empty(),'retained.md');const viewId=s.mainRoot.activeViewId,main=s.mainRoot.id;
  s=reduceLayout(s,{type:'detach',viewId,windowId:'source-window'});const source=findView(s,viewId).group.id;
  s=reduceLayout(s,{type:'split',groupId:source,axis:'x'});const expected=structuredClone(s.views);
  s=reduceLayout(s,transfer==='split'?{type:'split',groupId:main,axis:'y',moveViewId:viewId}:{type:'detach',groupId:source,windowId:'destination-window'});
  assert.equal(s.detached.some(w=>w.id==='source-window'),false);
  assert.equal(findView(s,viewId).windowId,transfer==='split'?'main':'destination-window');assert.deepEqual(s.views,expected);single(s);
 }
});
test('closing the last populated floating pane removes its empty siblings but retains opened metadata',()=>{
 let s=open(empty(),'retained.md');const viewId=s.mainRoot.activeViewId;
 s=reduceLayout(s,{type:'detach',viewId,windowId:'floating'});const source=findView(s,viewId).group.id;
 s=reduceLayout(s,{type:'split',groupId:source,axis:'x'});const expected=structuredClone(s.views);
 s=reduceLayout(s,{type:'closePane',groupId:source});
 assert.equal(s.detached.length,0);assert.equal(findView(s,viewId),null);assert.deepEqual(s.views,expected);single(s);
});
test('an intentionally empty floating window survives unrelated content moves',()=>{
 let s=empty();s=reduceLayout(s,{type:'split',groupId:s.mainRoot.id,axis:'x'});
 const [source,emptyPane]=layoutGroups(s);s=reduceLayout(s,{type:'detach',groupId:emptyPane.id,windowId:'empty-window'});
 s=open(s,'moving.md',source.id);const viewId=findGroup(s,source.id).group.activeViewId;
 s=reduceLayout(s,{type:'split',groupId:source.id,axis:'y'});const target=layoutGroups(s).find(g=>g.id!==source.id).id;
 const expected=structuredClone(s.detached);s=reduceLayout(s,{type:'move',viewId,targetGroupId:target});
 assert.deepEqual(s.detached,expected);assert.equal(findView(s,viewId).group.id,target);single(s);
});
test('more than 32 floating windows survive serialization and dock without losing views',()=>{
 let s=empty();const expectedWindows=[];
 for(let n=0;n<40;n++){
  s=open(s,'floating-'+n+'.txt');const viewId=s.mainRoot.activeViewId,windowId='floating-'+n;
  s=reduceLayout(s,{type:'restoreViewState',viewId,viewState:{scrollTop:n*10}});
  s=reduceLayout(s,{type:'detach',viewId,windowId});expectedWindows.push({windowId,viewId});
 }
 assert.equal(s.detached.length,40);assert.equal(layoutGroups(s).flatMap(g=>g.views).length,0);single(s);
 const expectedViews=structuredClone(s.views),expectedIds=ids(s),serialized=JSON.stringify(s);
 s=validateLayout(JSON.parse(serialized));assert.equal(JSON.stringify(s),serialized);
 for(const {windowId,viewId}of expectedWindows)assert.equal(findView(s,viewId).windowId,windowId);
 // Rotate target panes to keep docking balanced within the existing tree-depth safety limit.
 const targets=[s.mainRoot.id];
 for(const {windowId}of expectedWindows){
  const targetGroupId=targets.shift(),before=new Set(layoutGroups(s).map(g=>g.id));
  s=reduceLayout(s,{type:'dock',windowId,targetGroupId});
  targets.push(targetGroupId,...layoutGroups(s).filter(g=>!before.has(g.id)).map(g=>g.id));
 }
 assert.equal(s.detached.length,0);assert.equal(layoutGroups(s).length,40);
 assert.deepEqual(ids(s),expectedIds);assert.deepEqual(s.views,expectedViews);
 for(const {viewId}of expectedWindows)assert.equal(findView(s,viewId).windowId,'main');
 single(s);
});
test('close pane preserves opened file while explicit resource close removes it',()=>{let s=open(empty(),'a.txt');const a=Object.keys(s.views)[0],pane=s.mainRoot.id;s=reduceLayout(s,{type:'closePane',groupId:pane});assert(s.views[a]);assert.equal(findView(s,a),null);assert.equal(layoutGroups(s).length,1);s=reduceLayout(s,{type:'close',viewId:a});assert.equal(s.views[a],undefined);s=reduceLayout(s,{type:'reopenClosed',groupId:s.mainRoot.id});assert.equal(s.mainRoot.activeViewId,a);single(s);});
test('legacy multi-file groups migrate to one active file with other opened records retained',()=>{const s=createLayout('project-a',{currentRelPath:'b.txt',workspace:{minimized:true,openFiles:['a.txt','b.txt']}});const legacy=structuredClone(s);delete legacy.singleContent;legacy.mainRoot.views=Object.keys(legacy.views);legacy.mainRoot.activeViewId=legacy.mainRoot.views[1];const migrated=singleContentLayout(legacy);assert.deepEqual(ids(migrated),ids(legacy));assert.equal(migrated.mainRoot.views.length,1);assert.equal(migrated.views[migrated.mainRoot.activeViewId].relPath,'b.txt');single(migrated);});
test('presets never discard opened metadata or assign multiple files to one pane',()=>{let s=empty();for(let n=0;n<8;n++)s=open(s,'file'+n+'.txt');const expected=ids(s);for(const preset of ['columns','rows','grid','three','single']){s=reduceLayout(s,{type:'preset',preset});assert.deepEqual(ids(s),expected);single(s);}});
test('invalid project, traversal, duplicate ownership and ratio leave input unchanged',()=>{let s=open(empty(),'safe.txt');const before=structuredClone(s);for(const command of [{type:'open',view:{kind:'document',relPath:'../escape'}},{type:'open',view:{kind:'document',relPath:'safe.txt',projectId:'foreign'}},{type:'activate',viewId:'missing'},{type:'detach',viewId:ids(s)[0],groupId:s.mainRoot.id,windowId:'bad'}])assert.throws(()=>reduceLayout(s,command));assert.deepEqual(s,before);s=reduceLayout(s,{type:'split',groupId:s.mainRoot.id,axis:'x',side:'after'});for(const ratio of [NaN,Infinity,0,1])assert.throws(()=>reduceLayout(s,{type:'resize',splitId:s.mainRoot.id,ratio}));const bad=structuredClone(s);const g=layoutGroups(bad)[0];g.views.push(g.views[0]);assert.throws(()=>validateLayout(bad));});
test('conversation has a single presented owner and cannot be duplicated by split-open',()=>{let s=reduceLayout(empty(),{type:'open',view:{kind:'conversation'}});const chat=ids(s)[0];s=reduceLayout(s,{type:'open',view:{kind:'conversation'}});assert.equal(ids(s).length,1);assert.throws(()=>reduceLayout(s,{type:'splitOpen',viewId:chat,groupId:s.mainRoot.id,axis:'x'}));s=reduceLayout(s,{type:'detach',viewId:chat,windowId:'chat-window'});s=reduceLayout(s,{type:'open',view:{kind:'conversation'}});assert.equal(findView(s,chat).windowId,'chat-window');single(s);});
test('rename updates active and inactive opened resources, preserving stable file identity',()=>{let s=open(empty(),'folder/one.md');s=open(s,'folder-two/keep.md');s=reduceLayout(s,{type:'open',view:{kind:'document',relPath:'folder/two.md',resourceId:'stable-file'}});const expected=ids(s);s=reduceLayout(s,{type:'renameResource',from:'folder',to:'renamed'});assert.deepEqual(ids(s),expected);assert(Object.values(s.views).some(v=>v.resourceId==='stable-file'&&v.relPath==='renamed/two.md'));assert(Object.values(s.views).some(v=>v.relPath==='renamed/one.md'));assert(Object.values(s.views).some(v=>v.relPath==='folder-two/keep.md'));single(s);});
test('closing files restores the same pane in reverse visit order down to empty',()=>{
 let s=open(empty(),'a.md');const pane=s.mainRoot.id,a=s.mainRoot.activeViewId;
 s=open(s,'b.md');const b=s.mainRoot.activeViewId;s=open(s,'c.md');const c=s.mainRoot.activeViewId;
 const metadata=structuredClone(s.views);
 for(const [closing,expected]of [[c,b],[b,a],[a,null]]){
  s=reduceLayout(s,{type:'close',viewId:closing});assert.equal(findGroup(s,pane).group.activeViewId,expected);assert.equal(s.views[closing],undefined);single(s);
  if(expected)assert.deepEqual(s.views[expected],metadata[expected]);
 }
 assert.deepEqual(s.views,{});assert.equal(layoutGroups(s).length,1);
});
test('revisiting a file updates MRU without a duplicate restoration',()=>{
 let s=open(empty(),'a.md');const a=s.mainRoot.activeViewId;s=open(s,'b.md');const b=s.mainRoot.activeViewId;
 s=reduceLayout(s,{type:'activate',viewId:a});s=reduceLayout(s,{type:'close',viewId:a});assert.equal(s.mainRoot.activeViewId,b);
 s=reduceLayout(s,{type:'close',viewId:b});assert.equal(s.mainRoot.activeViewId,null);single(s);
});
test('pane histories remain independent across main and detached windows',()=>{
 let s=open(empty(),'main-a.md');const main=s.mainRoot.id,a=s.mainRoot.activeViewId;s=open(s,'main-b.md');const b=s.mainRoot.activeViewId;
 s=reduceLayout(s,{type:'split',groupId:main,axis:'x'});const other=layoutGroups(s).find(g=>g.id!==main).id;
 s=open(s,'float-a.md',other);const c=findGroup(s,other).group.activeViewId;s=open(s,'float-b.md',other);const d=findGroup(s,other).group.activeViewId;
 s=reduceLayout(s,{type:'detach',groupId:other,windowId:'history-window'});
 s=reduceLayout(s,{type:'close',viewId:b});assert.equal(findView(s,a).group.id,main);assert.equal(findView(s,d).windowId,'history-window');
 s=reduceLayout(s,{type:'close',viewId:d});assert.equal(findView(s,c).windowId,'history-window');assert.equal(findView(s,a).group.id,main);single(s);
});
test('restoring a pane skips historical documents presented by another owner',()=>{
 let s=open(empty(),'a.md');const pane=s.mainRoot.id,a=s.mainRoot.activeViewId;s=open(s,'b.md');const b=s.mainRoot.activeViewId;s=open(s,'c.md');const c=s.mainRoot.activeViewId;
 s=reduceLayout(s,{type:'split',groupId:pane,axis:'x'});const other=layoutGroups(s).find(g=>g.id!==pane).id;
 s=reduceLayout(s,{type:'activate',viewId:b,groupId:other});s=reduceLayout(s,{type:'activate',viewId:b,groupId:pane});assert.equal(findView(s,b).group.id,other);
 s=reduceLayout(s,{type:'close',viewId:c});assert.equal(findView(s,a).group.id,pane);assert.equal(findView(s,b).group.id,other);single(s);
});
test('serialized history restores documents but legacy hidden records are not pre-mounted',()=>{
 let s=open(empty(),'a.md');const a=s.mainRoot.activeViewId;s=open(s,'b.md');const b=s.mainRoot.activeViewId;
 s=singleContentLayout(JSON.parse(JSON.stringify(s)));assert.equal(findView(s,a),null);s=reduceLayout(s,{type:'close',viewId:b});assert.equal(s.mainRoot.activeViewId,a);
 const legacy=open(open(empty(),'legacy-a.md'),'legacy-b.md');delete legacy.mainRoot.historyViewIds;
 s=singleContentLayout(JSON.parse(JSON.stringify(legacy)));const hidden=Object.keys(s.views).find(v=>v!==s.mainRoot.activeViewId);assert.equal(findView(s,hidden),null);
 s=reduceLayout(s,{type:'close',viewId:s.mainRoot.activeViewId});assert.equal(s.mainRoot.activeViewId,null);assert(s.views[hidden]);single(s);
});
test('explicitly closing an inactive resource removes it from restoration candidates',()=>{
 let s=open(empty(),'a.md');const a=s.mainRoot.activeViewId;s=open(s,'b.md');const b=s.mainRoot.activeViewId;s=open(s,'c.md');const c=s.mainRoot.activeViewId;
 s=reduceLayout(s,{type:'close',viewId:b});assert.equal(s.mainRoot.activeViewId,c);s=reduceLayout(s,{type:'close',viewId:c});assert.equal(s.mainRoot.activeViewId,a);single(s);
});
test('conversation collapse restores a document without deleting or changing view metadata',()=>{
 let s=open(empty(),'draft.md');const pane=s.mainRoot.id,document=s.mainRoot.activeViewId;
 s=reduceLayout(s,{type:'open',view:{kind:'conversation',pinned:true,preview:false}});const chat=s.mainRoot.activeViewId;
 s=reduceLayout(s,{type:'restoreViewState',viewId:chat,viewState:{draft:'unsent',scrollTop:40,history:['retained message']}});const expected=structuredClone(s.views);
 s=reduceLayout(s,{type:'closeContent',viewId:chat});assert.equal(findGroup(s,pane).group.activeViewId,document);assert.deepEqual(s.views,expected);assert.equal(findView(s,chat),null);assert.equal(s.closedViews,undefined);
 s=reduceLayout(s,{type:'open',groupId:pane,view:{kind:'conversation'}});assert.equal(findView(s,chat).group.id,pane);assert.deepEqual(s.views,expected);single(s);
});
test('collapsing a conversation to empty retains its floating pane and metadata',()=>{
 let s=reduceLayout(empty(),{type:'open',view:{kind:'conversation'}});const chat=s.mainRoot.activeViewId;
 s=reduceLayout(s,{type:'detach',viewId:chat,windowId:'chat-window'});const pane=findView(s,chat).group.id,expected=structuredClone(s.views);
 s=reduceLayout(s,{type:'closeContent',viewId:chat});assert.equal(findGroup(s,pane).windowId,'chat-window');assert.equal(findGroup(s,pane).group.activeViewId,null);assert.deepEqual(s.views,expected);single(s);
});
test('moved and detached views cannot revive from a former pane after being hidden elsewhere',()=>{
 for(const transfer of ['move','detach']){
  let s=open(empty(),'a.md');const source=s.mainRoot.id,a=s.mainRoot.activeViewId;s=open(s,'b.md');const b=s.mainRoot.activeViewId;
  s=reduceLayout(s,{type:'split',groupId:source,axis:'x'});const other=layoutGroups(s).find(g=>g.id!==source).id;
  if(transfer==='move'){s=reduceLayout(s,{type:'activate',viewId:a,groupId:source});s=reduceLayout(s,{type:'move',viewId:a,targetGroupId:other});s=reduceLayout(s,{type:'activate',viewId:b,groupId:source});}
  else s=reduceLayout(s,{type:'detach',viewId:a,windowId:'transferred'});
  const destination=findView(s,a).group.id;s=open(s,'destination.md',destination);s=reduceLayout(s,{type:'close',viewId:b});
  assert.equal(findGroup(s,source).group.activeViewId,null);assert.equal(findView(s,a),null);single(s);
 }
});
test('pane history retains only the five most recently covered contents',()=>{
 let s=empty();const visits=[];for(let n=0;n<8;n++){s=open(s,'bounded-'+n+'.md');visits.push(s.mainRoot.activeViewId);}
 assert.deepEqual(s.mainRoot.historyViewIds,visits.slice(2,7).reverse());
 for(let n=7;n>=2;n--){assert.equal(s.mainRoot.activeViewId,visits[n]);s=reduceLayout(s,{type:'close',viewId:visits[n]});}
 assert.equal(s.mainRoot.activeViewId,null);assert(s.views[visits[0]]&&s.views[visits[1]]);single(s);
});
test('conversation and report restore in the same stack as ordinary files without deleting conversation data',()=>{
 let s=open(empty(),'a.md');const a=s.mainRoot.activeViewId;
 s=reduceLayout(s,{type:'open',view:{kind:'conversation',viewState:{draft:'keep',messages:['old']}}});const chat=s.mainRoot.activeViewId,metadata=structuredClone(s.views[chat]);
 s=reduceLayout(s,{type:'open',view:{kind:'report',resourceId:'report:one'}});const report=s.mainRoot.activeViewId;
 s=open(s,'b.md');s=reduceLayout(s,{type:'close',viewId:s.mainRoot.activeViewId});assert.equal(s.mainRoot.activeViewId,report);
 s=reduceLayout(s,{type:'close',viewId:report});assert.equal(s.mainRoot.activeViewId,chat);
 s=reduceLayout(s,{type:'close',viewId:chat});assert.equal(s.mainRoot.activeViewId,a);assert.deepEqual(s.views[chat],metadata);single(s);
});
test('loading old long pane histories keeps nearest five and preserves older opened records',()=>{
 let s=empty();const ids=[];for(let n=0;n<9;n++){s=open(s,'old-'+n+'.md');ids.push(s.mainRoot.activeViewId);}
 s.mainRoot.historyViewIds=ids.slice(0,-1).reverse();const migrated=singleContentLayout(s);
 assert.deepEqual(migrated.mainRoot.historyViewIds,ids.slice(3,8).reverse());assert.equal(Object.keys(migrated.views).length,Object.keys(s.views).length);single(migrated);
});
