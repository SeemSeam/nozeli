import test from 'node:test';
import assert from 'node:assert/strict';
import {sidebarAllocation} from '../src/renderer/sidebar-layout.mjs';
import {taskIdentityKey,taskIdentityTone} from '../src/domain/task-identity.mjs';
import {taskPresentation} from '../src/renderer/task-presentation.mjs';

test('sidebar keeps equal halves when both boards fit or both exceed their halves',()=>{
 for(const [a,b] of [[{D:100,M:60},{D:200,M:60}],[{D:900,M:60},{D:700,M:60}]])assert.deepEqual(sidebarAllocation(800,a,b),{short:false,top:400,bottom:400});
});
test('only actual unused space transfers, and header plus one row is protected',()=>{
 assert.deepEqual(sidebarAllocation(800,{D:700,M:80},{D:200,M:100}),{short:false,top:600,bottom:200});
 assert.deepEqual(sidebarAllocation(800,{D:200,M:100},{D:700,M:80}),{short:false,top:200,bottom:600});
 assert.deepEqual(sidebarAllocation(800,{D:700,M:80},{D:100,M:260}),{short:false,top:540,bottom:260});
 assert.deepEqual(sidebarAllocation(800,{D:420,M:80},{D:200,M:100}),{short:false,top:420,bottom:380});
});
test('short windows use whole-board scrolling rather than hiding either minimum',()=>{
 assert.deepEqual(sidebarAllocation(120,{D:300,M:80},{D:200,M:70}),{short:true,top:300,bottom:200});
 assert.deepEqual(sidebarAllocation(150,{D:80,M:80},{D:70,M:70}),{short:false,top:80,bottom:70});
});
test('allocation remains bounded for empty filters, font growth and summary errors',()=>{
 for(const H of [150,320,800])for(const a of [{D:24,M:24},{D:210,M:130},{D:800,M:210}])for(const b of [{D:24,M:24},{D:350,M:130}]){
  const result=sidebarAllocation(H,a,b);assert(result.top>=a.M);assert(result.bottom>=b.M);
  if(!result.short)assert.equal(result.top+result.bottom,H);
 }
});
test('identity survives source intake gaining Work, later revisions, receipt and display name changes',()=>{
 const source={id:'intake-a',type:'intake',target:'orchestrator',status:'queued'},state={jobs:[source],works:[]};
 const initial=taskIdentityKey('project',state,{sourceJobId:source.id});
 const bound={...state,works:[{id:'work-a',sourceJob:source.id,name:'First title',revision:1,status:'running'}]};
 assert.equal(taskIdentityKey('project',bound,{workId:'work-a'}),initial);
 const later={...bound,works:[{...bound.works[0],name:'Renamed',revision:3,status:'review'}],receipts:[{workId:'work-a',revision:3}]};
 assert.equal(taskIdentityKey('project',later,{workId:'work-a'}),initial);
 assert.equal(taskIdentityTone(taskIdentityKey('project',later,{workId:'work-a'})),taskIdentityTone(initial));
 assert.notEqual(taskIdentityKey('another-project',later,{workId:'work-a'}),initial);
 assert.notEqual(taskIdentityKey('project',{jobs:[source,{id:'intake-b',type:'intake'}],works:[]},{sourceJobId:'intake-b'}),initial);
});

test('a queued supplement never hides the active original Worker flow',()=>{
 const work={id:'work',name:'Active work',sourceJob:'root',revision:1,status:'running'};
 const active={id:'active-job',target:work.id,type:'initial',revision:1,status:'running'};
 const queued={id:'queued-supplement',target:work.id,type:'supplement',revision:1,status:'queued'};
 const state={works:[work],jobs:[{id:'root',target:'orchestrator',type:'intake',status:'completed',routing:{action:'dispatch',workId:work.id}},active,queued],receipts:[],todos:[]};
 assert.equal(taskPresentation({workId:work.id},state).running,true,'real running job wins over a later queued job');
 for(const jobs of [[active,queued],[queued,active]])assert.equal(taskPresentation({workId:work.id},{...state,jobs}).running,true,'array insertion order does not decide execution activity');
 assert.equal(taskPresentation({workId:work.id},{...state,jobs:[queued]}).running,false,'queued input alone is not actual execution');
 assert.equal(taskPresentation({workId:work.id},{...state,jobs:[{...active,status:'waiting'},queued]}).running,false,'waiting is not an active execution pulse');
 for(const override of [{manualControl:{pause:{paused:true}}},{status:'paused'},{status:'review'},{status:'closing'},{status:'ended'}]){
  assert.equal(taskPresentation({workId:work.id},{...state,works:[{...work,...override}]}).running,false,'manual pause and review/closure override stale running evidence: '+JSON.stringify(override));
 }
});
