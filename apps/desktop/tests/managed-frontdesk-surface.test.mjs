import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {managedReviewTodos,managedWorkRecords} from '../src/domain/managed-work-records.mjs';
import {todoCapabilities,manageTodoState} from '../src/domain/todo-management.mjs';
import {mountFrontdeskRoutes,renderFrontdeskRoute} from '../src/renderer/frontdesk-routes.mjs';

const proposal=()=>({id:'proposal-1',version:1,status:'pending',sourceJobId:'front-1',originalText:'<original>\nOnly update introduction',reason:'More sustained work needed',completedOperations:[{operationId:'op-1',ok:true,op:'apply',value:{relPath:'paper.md',revision:4,digest:'abc123'}}]});
const payload=()=>({projectId:'project-1',attentionKind:'frontdesk-route',attentionId:'proposal-1',sourceJobId:'front-1',expectedVersion:1,action:'continue',requestKey:'attention:proposal-1:1:continue'});
const routeTodo=route=>({id:'attention-route',status:'open',destination:{kind:'frontdesk-route',proposalId:route.id,expectedVersion:route.version,sourceJobId:route.sourceJobId}});
const routeState=route=>({todos:[routeTodo(route)],frontdeskRoutes:[route]});
class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes={};}append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}setAttribute(key,value){this.attributes[key]=value;}}
const document={createElement:tag=>new Element(tag)};
const buttons=box=>box.children.filter(child=>child.dataset.frontdeskRouteAction);

test('route attention IPC admits only exact project/proposal/version/source/user-action payloads',async()=>{
 const memory={};const storage={getLocal:async(id,key)=>memory[id+':'+key]??null,putLocal:async(id,key,value)=>{memory[id+':'+key]=value;},list:async()=>[]};const calls=[],manager=new ManagedProjects({userDataDir:'/unused-frontdesk-surface',host:{storage,requireProject:async id=>{if(id!=='project-1')throw Error('unknown project');return {id};}},legacy:{projects:new Map()}});
 manager.controllers.set('project-1',{started:true,stopping:false,snapshot:()=>({todos:[],jobs:[],agents:[],works:[]}),store:{state:{frontdeskRoutes:[proposal()]}},resolveFrontdeskRoute:async p=>{calls.push(p);return {accepted:true};}});
 const p=payload();assert.equal((await manager.invoke('managed.attention.respond',p)).accepted,true);assert.deepEqual(calls,[{proposalId:p.attentionId,expectedVersion:1,action:'continue',requestKey:p.requestKey}]);
 for(const patch of [{projectId:''},{attentionId:4},{attentionId:' padded '},{sourceJobId:4},{expectedVersion:0},{expectedVersion:1.1},{action:'approve'},{action:'replan'},{requestKey:''},{requestKey:' padded '},{actor:'user'},{workId:'work-1'}])await assert.rejects(manager.invoke('managed.attention.respond',{...p,...patch}),error=>error.code==='INVALID_PAYLOAD');
 for(const malformed of [undefined,null,[],42,'choice'])await assert.rejects(manager.invoke('managed.attention.respond',malformed),error=>error.code==='INVALID_PAYLOAD');
 await assert.rejects(manager.invoke('managed.attention.respond',{...p,sourceJobId:'another-source'}),error=>error.code==='ATTENTION_STALE');
 await assert.rejects(manager.invoke('managed.attention.respond',{...p,projectId:'other'}),/unknown project/);assert.equal(calls.length,1);
});

test('route todo remains readable and non-Work; generic close cannot decide or silently dismiss it',()=>{
 const route=proposal(),todo={id:'todo-1',kind:'frontdesk-route',status:'open',proposalId:route.id,sourceJobId:route.sourceJobId,text:route.originalText},state={frontdeskRoutes:[route],works:[],todos:[todo],receipts:[],jobs:[{id:route.sourceJobId,type:'front',target:'frontdesk',status:'done'}]};
 const reviews=managedReviewTodos(state);assert.equal(reviews.length,1);assert.equal(reviews[0].id,todo.id);assert.deepEqual(managedWorkRecords(state),[]);assert.equal(todoCapabilities(state,todo).close,false);
 assert.throws(()=>manageTodoState(state,{projectId:'project-1',todoId:todo.id,expectedRevision:0,action:'close',requestKey:'generic-close'}),error=>error.code==='TODO_BLOCKED');assert.equal(route.status,'pending');assert.equal(todo.status,'open');
});

test('route surface preserves exact source and receipts with three explicit scope-preserving choices',()=>{
 const route=proposal(),box=new Element('article'),actions=[];renderFrontdeskRoute(box,{document,route,resolve:action=>actions.push(action)});
 assert.equal(box.dataset.frontdeskRoute,route.id);assert.equal(box.children.find(child=>child.tag==='details').children[1].textContent,route.originalText);
 assert.ok(box.children.some(child=>child.tag==='details'&&child.children[1].textContent===JSON.stringify(route.completedOperations,null,2)));
 assert.equal(box.children.find(child=>child.dataset.frontdeskOperation==='').textContent,'paper.md · 修改已保存 · 第 4 版');
 assert.ok(box.children.filter(child=>child.tag==='details').every(child=>!child.open));
 assert.deepEqual(buttons(box).map(button=>button.dataset.frontdeskRouteAction),['continue','background','cancel']);assert.ok(buttons(box).every(button=>button.type==='button'&&button.textContent));buttons(box)[1].onclick();assert.deepEqual(actions,['background']);
 renderFrontdeskRoute(box,{document,route,pending:true,error:'STALE_FRONTDESK_ROUTE',resolve:()=>{}});assert.ok(buttons(box).every(button=>button.disabled));assert.ok(box.children.some(child=>child.attributes.role==='alert'&&child.textContent==='STALE_FRONTDESK_ROUTE'));
 route.status='continued';renderFrontdeskRoute(box,{document,route,resolve:()=>{}});assert.equal(box.hidden,true);assert.deepEqual(box.children,[]);
});

test('large operation history stays collapsed while exposing saved paths and both decisions',()=>{
 const route=proposal(),box=new Element('article');route.completedOperations=Array.from({length:80},(_,index)=>({ok:true,op:'create',operationId:'internal-'+index,value:{relPath:'chapter-'+index+'.md',revision:1}}));
 renderFrontdeskRoute(box,{document,route,resolve:()=>{}});
 assert.equal(box.children.filter(child=>child.dataset.frontdeskOperation==='').length,3);assert.equal(buttons(box).length,3);
 const provenance=box.children.find(child=>child.tag==='details'&&child.children[1].textContent===JSON.stringify(route.completedOperations,null,2));assert.ok(provenance);assert.ok(!provenance.open);
 assert.ok(box.children.filter(child=>child.tag==='p').every(child=>!child.textContent.includes('internal-')));
});

test('inline cards use the matching attention todo and reject old project/version/source buttons',async()=>{
 const route=proposal(),container=new Element('section'),calls=[];
 const ui=mountFrontdeskRoutes({document,container,invoke:async(op,p)=>{calls.push({op,p});return {ok:true,value:{accepted:true}};},refresh:async()=>{}});
 const state=routeState(route);ui.render(state,'project-1',true);assert.equal(container.hidden,false);const stale=buttons(container.children[0])[0];
 ui.render(routeState({...route,version:2}),'project-1',true);await stale.onclick();assert.equal(calls.length,0);
 const oldSource=buttons(container.children[0])[0];ui.render(routeState({...route,version:2,sourceJobId:'new-source'}),'project-1',true);await oldSource.onclick();assert.equal(calls.length,0);
 const oldProject=buttons(container.children[0])[0];ui.render(state,'project-2',true);await oldProject.onclick();assert.equal(calls.length,0);
 await buttons(container.children[0])[1].onclick();assert.equal(calls.length,1);assert.deepEqual(calls[0],{op:'managed.attention.respond',p:{projectId:'project-2',attentionKind:'frontdesk-route',attentionId:route.id,expectedVersion:1,sourceJobId:route.sourceJobId,action:'background',requestKey:'attention:'+route.id+':1:background'}});assert.equal(container.hidden,true);
 ui.render(state,'project-2',true);assert.equal(container.hidden,true,'out-of-order pending snapshot cannot resend a receipted decision');ui.clear();assert.equal(container.hidden,true);
});

test('inline route cannot invent a second authority when its attention todo is missing or stale',async()=>{
 const route=proposal(),container=new Element('section'),calls=[],ui=mountFrontdeskRoutes({document,container,invoke:async(...args)=>{calls.push(args);},refresh:async()=>{}});
 for(const todos of [[],[{...routeTodo(route),status:'resolved'}],[routeTodo({...route,version:2})],[routeTodo({...route,sourceJobId:'other'})]]){
  ui.render({frontdeskRoutes:[route],todos},'project-1',true);assert.ok(buttons(container.children[0]).every(button=>button.disabled));for(const button of buttons(container.children[0]))await button.onclick();
 }
 assert.equal(calls.length,0);
});

test('failed inline decisions preserve proposal and retry the exact version-bound answer only on a new click',async()=>{
 const route=proposal(),container=new Element('section'),calls=[];let release;
 const ui=mountFrontdeskRoutes({document,container,invoke:async(op,p)=>{calls.push({op,p});return await new Promise(resolve=>{release=resolve;});},refresh:async()=>{}});
 ui.render(routeState(route),'project-1',true);const first=buttons(container.children[0])[0],flight=first.onclick();await first.onclick();assert.equal(calls.length,1);assert.ok(buttons(container.children[0]).every(button=>button.disabled));
 release({ok:false,error:{code:'STALE_ATTENTION',message:'Refresh proposal'}});await flight;assert.equal(calls.length,1);assert.equal(container.hidden,false);assert.ok(container.children[0].children.some(child=>child.attributes.role==='alert'&&child.textContent.includes('STALE_ATTENTION')));
 const retry=buttons(container.children[0])[0].onclick();assert.deepEqual(calls[1],calls[0]);release({ok:true,value:{accepted:true}});await retry;assert.equal(container.hidden,true);
});

test('inline cancellation reaches attention authority once and remains settled when refresh fails',async()=>{
 const route=proposal(),container=new Element('section'),calls=[],ui=mountFrontdeskRoutes({document,container,invoke:async(op,p)=>{calls.push({op,p});return {ok:true,value:{accepted:true}};},refresh:async()=>{throw Error('offline');}});
 ui.render(routeState(route),'project-1',true);const cancel=buttons(container.children[0])[2];await cancel.onclick();await cancel.onclick();assert.equal(calls.length,1);assert.equal(calls[0].op,'managed.attention.respond');assert.equal(calls[0].p.action,'cancel');assert.equal(calls[0].p.cancel,undefined);assert.equal(container.hidden,true);
});
