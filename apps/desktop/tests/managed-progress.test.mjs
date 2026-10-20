import test from 'node:test';import assert from 'node:assert/strict';import {managedProgress} from '../src/renderer/managed-progress.mjs';
const state=()=>({limit:2,quotaUsed:2,works:[{id:'a',name:'Alpha',status:'paused',revision:1},{id:'b',name:'Beta',status:'review',revision:2},{id:'c',name:'Gamma',status:'queued',revision:0}],jobs:[],drafts:{}});
test('paused and review occupancy explains why queued work has no slot',()=>{
 const p=managedProgress(state());assert.match(p.summary,/2\/2.*排队 1.*新任务将排队/);assert.match(p.works[0].text,/等待回答.*占用名额/);assert.match(p.works[1].text,/结果审查.*占用名额/);assert.match(p.works[2].text,/第 1 位/);assert.ok(!p.works[2].text.includes('占用名额'));
});
test('frontdesk remains aware of accepted intake while it is itself idle',()=>{
 const s=state();s.jobs=[{id:'f',target:'frontdesk',status:'completed'},{id:'i',target:'orchestrator',type:'intake',status:'running',context:{frontJobId:'f'}}];
 assert.equal(managedProgress(s).requests[0].text,'正在整理任务');assert.ok(!managedProgress(s,'a').requests.length);
 s.jobs[1].status='queued';s.nativeDraftTargets=['orchestrator'];assert.match(managedProgress(s).requests[0].text,/未发送草稿/);
});
test('ended work never occupies the open progress queue even with blocked technical cleanup',()=>{
 const s=state();s.works[0].status='ended';s.works[0].outcome='accept';s.works[0].closure={phase:'blocked',error:'target changed'};s.quotaUsed=1;
 assert.equal(managedProgress(s).works.length,2);assert.equal(managedProgress(s).works.some(w=>w.id==='a'),false);assert.equal(s.works[0].closure.phase,'blocked');
});
test('accepted follow-up cannot appear as idle review while it waits for a draft',()=>{
 const s=state();s.jobs=[{id:'j',target:'b',type:'manual',status:'queued'}];s.drafts.b='draft';const p=managedProgress(s,'b');assert.match(p.works[0].text,/补充已接收.*草稿/);assert.match(p.requests[0].text,/草稿/);assert.equal(p.works.length,1);
});
