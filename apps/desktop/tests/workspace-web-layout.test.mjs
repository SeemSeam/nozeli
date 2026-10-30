import test from 'node:test';
import assert from 'node:assert/strict';
import {createLayout,reduceLayout,validateLayout,layoutGroups,findView} from '../src/domain/workspace-layout.mjs';
const empty=()=>createLayout('web-project',{workspace:{minimized:true}});
const open=(layout,url,extra={})=>reduceLayout(layout,{type:'open',view:{kind:'web',url,...extra}});

test('web views canonicalize HTTP addresses, derive safe titles and identify distinct pages',()=>{
 let layout=open(empty(),'https://EXAMPLE.com');
 const first=layout.mainRoot.activeViewId;
 assert.equal(layout.views[first].url,'https://example.com/');
 assert.equal(layout.views[first].resourceId,'web:https://example.com/');
 assert.equal(layout.views[first].title,'example.com');
 layout=open(layout,'https://example.com/second');
 const second=layout.mainRoot.activeViewId;
 assert.notEqual(first,second);
 assert.equal(Object.keys(layout.views).length,2);
 layout=open(layout,'https://example.com/second');
 assert.equal(layout.mainRoot.activeViewId,second);
 assert.equal(Object.keys(layout.views).length,2);
});

test('web layout rejects forbidden protocols, credentials, identity and URL tampering',()=>{
 const initial=empty();
 for(const url of ['file:///tmp/secret','javascript:alert(1)','data:text/html,hello','nozeli://app','ftp://example.com','https://user:password@example.com','https://example.com\n.evil']){
  assert.throws(()=>open(initial,url),url);
 }
 assert.throws(()=>open(initial,'https://example.com',{resourceId:'web:https://evil.example/'}));
 assert.throws(()=>open(initial,'https://example.com',{relPath:'trusted.md'}));
 assert.throws(()=>open(initial,'https://example.com',{projectId:'other-project'}));
 const layout=open(initial,'https://example.com');
 const viewId=layout.mainRoot.activeViewId;
 for(const changes of [{url:'file:///tmp/secret'},{url:'https://other.example/'},{resourceId:'document:secret'},{url:'https://EXAMPLE.com/'},{title:'bad\u0000title'}]){
  const bad=structuredClone(layout);Object.assign(bad.views[viewId],changes);assert.throws(()=>validateLayout(bad));
 }
 assert.equal(Object.keys(initial.views).length,0);
});

test('web navigation updates persisted canonical identity without submitting address drafts',()=>{
 let layout=open(empty(),'https://example.com/start');
 const viewId=layout.mainRoot.activeViewId;
 layout=reduceLayout(layout,{type:'restoreViewState',viewId,viewState:{addressDraft:'https://not-submitted.example/private'}});
 assert.equal(layout.views[viewId].url,'https://example.com/start');
 layout=reduceLayout(layout,{type:'webNavigate',viewId,url:'https://example.com/next',title:'Page\u0000 title'});
 assert.equal(layout.views[viewId].resourceId,'web:https://example.com/next');
 assert.equal(layout.views[viewId].title,'Page title');
 assert.equal(layout.views[viewId].viewState.addressDraft,'https://not-submitted.example/private');
 const restored=JSON.parse(JSON.stringify(layout));validateLayout(restored);
 assert.deepEqual(restored,layout);
 assert.throws(()=>reduceLayout(layout,{type:'webNavigate',viewId,url:'file:///secret'}));
});

test('web split, float, redock and reopen retain the stable wrapper view and draft',()=>{
 let layout=open(empty(),'https://example.com/one');
 const viewId=layout.mainRoot.activeViewId;
 layout=reduceLayout(layout,{type:'restoreViewState',viewId,viewState:{addressDraft:'unfinished address'}});
 layout=reduceLayout(layout,{type:'detach',viewId,windowId:'browser-floating'});
 assert.equal(findView(layout,viewId).windowId,'browser-floating');
 layout=open(layout,'http://localhost:8080/two');
 layout=reduceLayout(layout,{type:'dock',windowId:'browser-floating'});
 assert.equal(layout.detached.length,0);
 assert.equal(layoutGroups(layout).length,2);
 assert.equal(findView(layout,viewId).windowId,'main');
 assert.equal(layout.views[viewId].viewState.addressDraft,'unfinished address');
 layout=reduceLayout(layout,{type:'splitOpen',viewId,groupId:findView(layout,viewId).group.id,axis:'y'});
 const clone=Object.values(layout.views).find(view=>view.sourceViewId===viewId);
 assert.equal(clone.url,layout.views[viewId].url);
 assert.notEqual(clone.id,viewId);
 layout=reduceLayout(layout,{type:'close',viewId});
 layout=reduceLayout(layout,{type:'reopenClosed',groupId:layoutGroups(layout)[0].id});
 assert.equal(layout.views[viewId].url,'https://example.com/one');
 assert.equal(layout.views[viewId].viewState.addressDraft,'unfinished address');
 validateLayout(layout);
});
