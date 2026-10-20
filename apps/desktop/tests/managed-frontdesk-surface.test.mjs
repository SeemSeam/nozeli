import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {managedReviewTodos,managedWorkRecords} from '../src/domain/managed-work-records.mjs';
import {todoCapabilities,manageTodoState} from '../src/domain/todo-management.mjs';
import {mountFrontdeskRoutes,renderFrontdeskRoute} from '../src/renderer/frontdesk-routes.mjs';

const proposal=()=>({id:'proposal-1',version:1,status:'pending',sourceJobId:'front-1',originalText:'<original>\nOnly update introduction',reason:'More sustained work needed',completedOperations:[{operationId:'op-1',ok:true,op:'apply',value:{relPath:'paper.md',revision:4,digest:'abc123'}}]});
const payload=()=>({projectId:'project-1',proposalId:'proposal-1',expectedVersion:1,action:'continue',requestKey:'user-choice-1'});
class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes={};}append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}setAttribute(key,value){this.attributes[key]=value;}}
const document={createElement:tag=>new Element(tag)};
const buttons=box=>box.children.filter(child=>child.dataset.frontdeskRouteAction);

test('frontdesk route IPC admits only exact project/proposal/version/user-action payloads',async()=>{
 const calls=[],manager=new ManagedProjects({userDataDir:'/unused-frontdesk-surface',host:{requireProject:async id=>{if(id!=='project-1')throw Error('unknown project');return {id};}},legacy:{projects:new Map()}});
 manager.controllers.set('project-1',{started:true,resolveFrontdeskRoute:async p=>{calls.push(p);return {accepted:true};}});
 const p=payload();assert.equal((await manager.invoke('managed.frontdesk.route.resolve',p)).accepted,true);assert.deepEqual(calls,[p]);
 for(const patch of [{projectId:''},{proposalId:4},{proposalId:' padded '},{expectedVersion:0},{expectedVersion:1.1},{action:'approve'},{action:'replan'},{requestKey:''},{requestKey:' padded '},{actor:'user'},{workId:'work-1'}])await assert.rejects(manager.invoke('managed.frontdesk.route.resolve',{...p,...patch}),error=>error.code==='INVALID_PAYLOAD');
 for(const malformed of [undefined,null,[],42,'choice'])await assert.rejects(manager.invoke('managed.frontdesk.route.resolve',malformed),error=>error.code==='INVALID_PAYLOAD');
 await assert.rejects(manager.invoke('managed.frontdesk.route.resolve',{...p,projectId:'other'}),/unknown project/);assert.equal(calls.length,1);
});

test('route todo remains readable and non-Work; generic close cannot decide or silently dismiss it',()=>{
 const route=proposal(),todo={id:'todo-1',kind:'frontdesk-route',status:'open',proposalId:route.id,sourceJobId:route.sourceJobId,text:route.originalText},state={frontdeskRoutes:[route],works:[],todos:[todo],receipts:[],jobs:[{id:route.sourceJobId,type:'front',target:'frontdesk',status:'done'}]};
 const reviews=managedReviewTodos(state);assert.equal(reviews.length,1);assert.equal(reviews[0].id,todo.id);assert.deepEqual(managedWorkRecords(state),[]);assert.equal(todoCapabilities(state,todo).close,false);
 assert.throws(()=>manageTodoState(state,{projectId:'project-1',todoId:todo.id,expectedRevision:0,action:'close',requestKey:'generic-close'}),error=>error.code==='TODO_BLOCKED');assert.equal(route.status,'pending');assert.equal(todo.status,'open');
});

test('route surface preserves exact source and receipts with only two scope-preserving choices',()=>{
 const route=proposal(),box=new Element('article'),actions=[];renderFrontdeskRoute(box,{document,route,resolve:action=>actions.push(action)});
 assert.equal(box.dataset.frontdeskRoute,route.id);assert.equal(box.children.find(child=>child.tag==='details').children[1].textContent,route.originalText);
 assert.ok(box.children.some(child=>child.tag==='details'&&child.children[1].textContent===JSON.stringify(route.completedOperations,null,2)));
 assert.equal(box.children.find(child=>child.dataset.frontdeskOperation==='').textContent,'paper.md · 修改已保存 · 第 4 版');
 assert.ok(box.children.filter(child=>child.tag==='details').every(child=>!child.open));
 assert.deepEqual(buttons(box).map(button=>button.dataset.frontdeskRouteAction),['continue','background']);buttons(box)[1].onclick();assert.deepEqual(actions,['background']);
 renderFrontdeskRoute(box,{document,route,pending:true,error:'STALE_FRONTDESK_ROUTE',resolve:()=>{}});assert.ok(buttons(box).every(button=>button.disabled));assert.ok(box.children.some(child=>child.attributes.role==='alert'&&child.textContent==='STALE_FRONTDESK_ROUTE'));
 route.status='continued';renderFrontdeskRoute(box,{document,route,resolve:()=>{}});assert.equal(box.hidden,true);assert.deepEqual(box.children,[]);
});

test('large operation history stays collapsed while exposing saved paths and both decisions',()=>{
 const route=proposal(),box=new Element('article');route.completedOperations=Array.from({length:80},(_,index)=>({ok:true,op:'create',operationId:'internal-'+index,value:{relPath:'chapter-'+index+'.md',revision:1}}));
 renderFrontdeskRoute(box,{document,route,resolve:()=>{}});
 assert.equal(box.children.filter(child=>child.dataset.frontdeskOperation==='').length,3);assert.equal(buttons(box).length,2);
 const provenance=box.children.find(child=>child.tag==='details'&&child.children[1].textContent===JSON.stringify(route.completedOperations,null,2));assert.ok(provenance);assert.ok(!provenance.open);
 assert.ok(box.children.filter(child=>child.tag==='p').every(child=>!child.textContent.includes('internal-')));
});

test('durable cards ignore hidden generic todos and reject old project/version buttons',async()=>{
 const route=proposal(),container=new Element('section'),calls=[];
 const ui=mountFrontdeskRoutes({document,container,invoke:async(op,p)=>{calls.push({op,p});return {ok:true,value:{accepted:true}};},refresh:async()=>{},randomKey:()=> 'program-key'});
 const state={todos:[{id:'hidden',status:'closed'}],frontdeskRoutes:[route]};ui.render(state,'project-1',true);assert.equal(container.hidden,false);const stale=buttons(container.children[0])[0];
 ui.render({...state,frontdeskRoutes:[{...route,version:2}]},'project-1',true);await stale.onclick();assert.equal(calls.length,0);
 const oldProject=buttons(container.children[0])[0];ui.render(state,'project-2',true);await oldProject.onclick();assert.equal(calls.length,0);
 await buttons(container.children[0])[1].onclick();assert.equal(calls.length,1);assert.deepEqual(calls[0],{op:'managed.frontdesk.route.resolve',p:{projectId:'project-2',proposalId:route.id,expectedVersion:1,action:'background',requestKey:'program-key'}});assert.equal(container.hidden,true);
 ui.clear();assert.equal(container.hidden,true);
});

test('failed decisions retain proposal, show stale error, and reuse program-owned retry key',async()=>{
 const route=proposal(),container=new Element('section'),calls=[];let release;
 const ui=mountFrontdeskRoutes({document,container,invoke:async(op,p)=>{calls.push(p);return await new Promise(resolve=>{release=resolve;});},refresh:async()=>{},randomKey:()=> 'stable-key'});
 ui.render({frontdeskRoutes:[route]},'project-1',true);const first=buttons(container.children[0])[0],flight=first.onclick();await first.onclick();assert.equal(calls.length,1);assert.ok(buttons(container.children[0]).every(button=>button.disabled));
 release({ok:false,error:{code:'STALE_FRONTDESK_ROUTE',message:'Refresh proposal'}});await flight;assert.equal(container.hidden,false);assert.ok(container.children[0].children.some(child=>child.attributes.role==='alert'&&child.textContent.includes('STALE_FRONTDESK_ROUTE')));
 const retry=buttons(container.children[0])[0].onclick();assert.equal(calls[1].requestKey,calls[0].requestKey);release({ok:true,value:{accepted:true}});await retry;assert.equal(container.hidden,true);
});
