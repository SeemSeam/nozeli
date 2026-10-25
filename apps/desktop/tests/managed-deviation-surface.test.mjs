import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {managedWorkRecords,managedReviewTodos} from '../src/domain/managed-work-records.mjs';
import {deviationHeld,deviationPresentation} from '../src/domain/work-deviation.mjs';
import {todoCapabilities} from '../src/domain/todo-management.mjs';
import {renderDeviationGate} from '../src/renderer/work-deviation.mjs';

const work=()=>({id:'work-1',name:'Original',request:'Original goal',status:'paused',revision:2,deviation:{id:'deviation-1',revision:2,version:1,status:'pending',todoId:'todo-1',sourceJobId:'job-1',sourceText:'<exact>\nchanged input',changedGoal:'Different goal',reason:'Scope changed',progress:'Partial files retained'}});
const payload=()=>({projectId:'project-1',workId:'work-1',deviationId:'deviation-1',expectedRevision:2,expectedVersion:1,action:'continue',requestKey:'decision-1'});
function manager(controller){const m=new ManagedProjects({userDataDir:'/unused-deviation-test',host:{storage:{},requireProject:async id=>{if(id!=='project-1')throw Error('unknown project');return {id};}},legacy:{projects:new Map()}});m.controllers.set('project-1',{started:true,...controller});return m;}

test('user deviation IPC validates exact decision identity before controller admission',async()=>{
 const calls=[],m=manager({resolveDeviation:async p=>{calls.push(p);return {accepted:true,workId:p.workId};}}),p=payload();
 assert.equal((await m.invoke('managed.deviation.resolve',p)).accepted,true);assert.deepEqual(calls,[p]);
 for(const patch of [{workId:''},{deviationId:4},{expectedRevision:0},{expectedVersion:1.5},{action:'resume'},{requestKey:''},{requestKey:' padded '},{unexpected:true}])await assert.rejects(m.invoke('managed.deviation.resolve',{...p,...patch}),e=>e.code==='INVALID_PAYLOAD');
 assert.equal(calls.length,1);
 await assert.rejects(m.invoke('managed.deviation.resolve',{...p,projectId:'other'}),/unknown project/);
});

test('held Work cannot enter native or restart pathways; read-only screen does not launch',async()=>{
 for(const status of ['pending','replanned']){
  const w=work();w.deviation.status=status;let restarts=0;
  const m=manager({store:{state:{works:[w]}},terminals:new Map(),restart:async()=>{restarts++;}});
  for(const op of ['restart','terminal.attach','terminal.system','terminal.input'])await assert.rejects(m.invoke('managed.'+op,{projectId:'project-1',target:w.id,...(op==='terminal.input'?{terminalId:'old',data:'run\r'}:{})}),e=>e.code==='WORK_DEVIATION_HELD');
  assert.equal(restarts,0);assert.equal((await m.invoke('managed.terminal.screen',{projectId:'project-1',target:w.id})).available,false);
 }
});

test('durable gate wins over queued supplements and hidden or completed generic reminders',()=>{
 const w=work(),todo={id:'todo-1',workId:w.id,kind:'deviation',status:'open',revision:2},state={works:[w],todos:[todo],jobs:[{id:'later',type:'supplement',target:w.id,status:'queued'}]};
 assert.equal(managedReviewTodos(state)[0].actionableKind,'deviation');assert.equal(todoCapabilities(state,todo).close,false);
 for(const status of ['closed','resolved']){todo.status=status;const record=managedWorkRecords(state)[0];assert.equal(record.todoId,todo.id);assert.equal(record.deviation.id,w.deviation.id);assert.equal(deviationHeld(w),true);assert.notEqual(record.phase,'补充已接收，等待执行');}
 w.deviation.status='replanned';const view=deviationPresentation(w);assert.equal(view.canReplan,false);assert.equal(view.sourceText,'<exact>\nchanged input');assert.equal(view.original,'Original goal');assert.match(view.continueLabel,/原始任务/);
 w.deviation.status='continued';assert.equal(deviationHeld(w),false);
});

test('decision surface preserves exact input and restricts replanned controls to original-goal resume',()=>{
 class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.style={};this.attributes={};}append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}setAttribute(key,value){this.attributes[key]=value;}}
 const document={createElement:tag=>new Element(tag)},container=new Element('section'),w=work(),actions=[];
 const paint=options=>renderDeviationGate(container,{document,work:w,resolve:action=>actions.push(action),...options});
 paint({});assert.equal(container.hidden,false);assert.equal(container.dataset.deviationGate,w.id);
 const input=container.children.find(e=>e.tag==='details'&&e.children[1]?.textContent===w.deviation.sourceText);assert.ok(input);assert.equal(input.children[1].tag,'pre');
 const buttons=()=>container.children.filter(e=>e.dataset.deviationAction);
 assert.deepEqual(buttons().map(e=>e.dataset.deviationAction),['continue','replan']);buttons()[1].onclick();assert.deepEqual(actions,['replan']);
 paint({pending:true});assert.ok(buttons().every(e=>e.disabled));
 w.deviation.status='replanned';paint({error:'STALE_DEVIATION'});assert.deepEqual(buttons().map(e=>e.dataset.deviationAction),['continue']);assert.ok(container.children.some(e=>e.attributes.role==='alert'&&e.textContent==='STALE_DEVIATION'));
 w.deviation.status='continued';paint({});assert.equal(container.hidden,true);assert.deepEqual(container.children,[]);
});
