import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {managedExecutionSummary} from '../src/main/storage-recovery.mjs';

function fixture(t,{works=[],jobs=[]}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE records(collection TEXT,id TEXT,value TEXT,PRIMARY KEY(collection,id))');
 const put=db.prepare('INSERT INTO records VALUES(?,?,?)');for(const w of works)put.run('managed_works',w.id,JSON.stringify(w));for(const j of jobs)put.run('managed_jobs',j.id,JSON.stringify(j));return db;
}

test('startup resumes unfinished business and finalization, not review or completed history',async t=>{
 for(const [status,expected]of [['queued',true],['running',true],['closing',true],['review',false],['ended',false]])await t.test(status,child=>{
  const db=fixture(child,{works:[{id:'work',status,closure:status==='ended'?{phase:'complete',decision:'accept'}:undefined}]});assert.equal(managedExecutionSummary(db).pending,expected);
 });
});
test('explicit work pause survives startup scanning even when its old job says running',t=>{
 const db=fixture(t,{works:[{id:'work',status:'running',manualControl:{pause:{at:'2026-11-03'}}}],jobs:[{id:'job',target:'work',status:'running'}]});assert.equal(managedExecutionSummary(db).pending,false);
});
test('Orchestrator queued input qualifies without a Worker, but unsent frontdesk activity does not',async t=>{
 for(const [target,status,expected]of [['orchestrator','queued',true],['orchestrator','running',true],['orchestrator','cancelled',false],['frontdesk','queued',false]])await t.test(target+status,child=>{
  const db=fixture(child,{jobs:[{id:'job',target,status,text:'x'.repeat(100000)}]});assert.deepEqual(managedExecutionSummary(db),{pending:expected});
 });
});
test('cancelled Work inputs cannot wake a deleted or already reviewed Work',async t=>{
 for(const status of ['review','ended'])await t.test(status,child=>{
  const db=fixture(child,{works:[{id:'work',status,closure:status==='ended'?{decision:'discard',phase:'complete'}:undefined}],jobs:[{id:'job',target:'orchestrator',context:{boundWorkId:'work'},status:'queued'}]});assert.equal(managedExecutionSummary(db).pending,false);
 });
});
test('proven legacy accepted closure remains eligible for reconciliation, not lost as completed',t=>{
 const db=fixture(t,{works:[{id:'work',status:'ended',closure:{decision:'accept',phase:'blocked'}}]});assert.equal(managedExecutionSummary(db).pending,true);
});

test('host-interrupted Orchestrator intake is discoverable before any Work exists',async t=>{
 for(const [interruptionReason,expected]of [['host-stopped',true],['user-stopped',false],['user-ended',false]])await t.test(interruptionReason,child=>{
  const db=fixture(child,{jobs:[{id:'intake',target:'orchestrator',status:'interrupted',interruptionReason,promptStartedAt:1}]});assert.equal(managedExecutionSummary(db).pending,expected);
 });
});
