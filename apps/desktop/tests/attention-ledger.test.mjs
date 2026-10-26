import test from 'node:test';
import assert from 'node:assert/strict';
import {AttentionLedger} from '../src/agents/managed/attention-ledger.mjs';
const fixture=()=>{const data=new Map();const storage={getLocal:async(id,key)=>structuredClone(data.get(id+':'+key)),putLocal:async(id,key,value)=>data.set(id+':'+key,structuredClone(value))};return {data,storage,ledger:new AttentionLedger(storage)};};
const fact={key:'owner:question',title:'选择实施路线',text:'A 或 B',target:'frontdesk',destination:{kind:'terminal',target:'frontdesk',ownerId:'owner'}};
test('same native question survives reload, local dismissal and resolution without answering it',async()=>{
 const {storage,ledger}=fixture();let s=await ledger.observe('p','native',[fact]);const first=s.todos[0];
 s=await new AttentionLedger(storage).observe('p','native',[fact]);assert.equal(s.todos[0].id,first.id);assert.equal(s.todos.length,1);
 await ledger.acknowledge('p',[first.id]);assert.equal((await ledger.read('p')).todos[0].status,'open');
 await ledger.manage('p',{projectId:'p',todoId:first.id,expectedRevision:first.managementRevision,action:'close',requestKey:'close-native-question'});
 s=await ledger.observe('p','native',[fact]);assert.equal(s.todos[0].status,'closed');
 await ledger.observe('p','native',[]);s=await ledger.observe('p','native',[fact]);assert.notEqual(s.todos.at(-1).id,first.id,'new occurrence is independently actionable');
});
test('lost native owner is retained for recovery, never silently answered or replayed',async()=>{
 const {ledger}=fixture();await ledger.observe('p','native',[fact]);const interrupted=await ledger.observe('p','native',[],{interrupted:true});
 assert.equal(interrupted.todos[0].status,'open');assert.equal(interrupted.todos[0].destination.kind,'connection');assert.equal(interrupted.todos[0].interrupted,true);
 assert.equal((await ledger.read('other')).todos.length,0);
});
test('first authoritative interruption re-notifies an acknowledged reminder exactly once',async()=>{
 const {storage,ledger}=fixture();let state=await ledger.observe('p','native',[fact]);const todo=state.todos[0];
 await ledger.acknowledge('p',[todo.id]);assert.deepEqual((await ledger.read('p')).notified,[todo.id]);
 state=await ledger.observe('p','native',[],{interrupted:true});
 assert.equal(state.todos[0].status,'open');assert.equal(state.todos[0].interrupted,true);assert.equal(state.todos[0].destination.kind,'connection');
 assert.equal(state.notified.includes(todo.id),false,'first interruption removes the persisted acknowledgement so the recovery re-notifies');
 assert.equal((await new AttentionLedger(storage).read('p')).notified.includes(todo.id),false,'acknowledgement removal survives reload');
 await ledger.acknowledge('p',[todo.id]);
 state=await ledger.observe('p','native',[],{interrupted:true});
 assert.equal(state.notified.includes(todo.id),true,'repeat interruption never re-alerts');
 assert.equal(state.todos.filter(item=>item.id===todo.id).length,1,'same todo id never duplicates a row');
 assert.equal((await new AttentionLedger(storage).read('p')).notified.includes(todo.id),true,'recovery acknowledgement persists');
});
test('owner-predicate interruptions follow the same first-only re-notify rule',async()=>{
 const {ledger}=fixture();const state=await ledger.observe('p','native',[fact]);const id=state.todos[0].id;await ledger.acknowledge('p',[id]);
 // The predicate mirrors the manager exactly: interrupted when the todo's owner
 // is no longer among the live owners.
 const alive=new Set(['owner']);
 const lose=()=>ledger.observe('p','native',[],{interrupted:todo=>!alive.has(todo?.destination?.ownerId)});
 alive.delete('owner');let after=await lose();
 assert.equal(after.notified.includes(id),false,'live owner lost: re-notify once');
 assert.equal(after.todos.find(item=>item.id===id).interrupted,true);
 await ledger.acknowledge('p',[id]);
 alive.add('owner-2');
 await ledger.observe('p','native',[{...fact,destination:{...fact.destination,ownerId:'owner-2'}}]);
 alive.delete('owner-2');after=await lose();
 assert.equal(after.notified.includes(id),true,'a later owner loss is a repeat, not a new occurrence');
 assert.equal(after.todos.find(item=>item.id===id).status,'open');
});
test('text and destination revisions never re-alert an acknowledged reminder',async()=>{
 const {storage,ledger}=fixture();let state=await ledger.observe('p','native',[fact]);const todo=state.todos[0];
 await ledger.acknowledge('p',[todo.id]);
 state=await ledger.observe('p','native',[{...fact,text:'REVISED_TEXT_9217',title:'修订标题',destination:{kind:'conversation',target:'frontdesk',ownerId:'owner-2',interactionId:'interaction-2',question:{method:'askDialog',questions:[]}}}]);
 const updated=state.todos.find(item=>item.id===todo.id);
 assert.equal(state.todos.length,1);assert.match(updated.text,/REVISED_TEXT_9217/);assert.ok(updated.managementRevision>todo.managementRevision);
 assert.equal(updated.status,'open');
 assert.equal(state.notified.includes(todo.id),true,'content revisions must not clear the acknowledgement');
 assert.equal((await new AttentionLedger(storage).read('p')).notified.includes(todo.id),true);
});
test('a recovered source restores one actionable row and later resolution settles the same id',async()=>{
 const {ledger}=fixture();const state=await ledger.observe('p','native',[fact]);const id=state.todos[0].id;
 await ledger.observe('p','native',[],{interrupted:true});
 const back=await ledger.observe('p','native',[{...fact,destination:{...fact.destination,interactionId:'interaction-2'}}]);
 const row=back.todos.find(item=>item.id===id);
 assert.equal(back.todos.filter(item=>item.id===id).length,1);assert.equal(row.status,'open');assert.equal(row.destination.interactionId,'interaction-2');
 const settled=await ledger.observe('p','native',[]);
 assert.equal(settled.todos.find(item=>item.id===id).status,'resolved');assert.equal(settled.active['native:'+fact.key],undefined);
});
test('concurrent fact updates retain both sources and failed persistence is not acknowledged',async()=>{
 const {ledger,storage}=fixture();await Promise.all([ledger.observe('p','native',[fact]),ledger.observe('p','connection',[{...fact,key:'connection'}])]);assert.equal((await ledger.read('p')).todos.length,2);
 storage.putLocal=async()=>{throw Error('disk unavailable');};await assert.rejects(ledger.acknowledge('p',['unknown']),/disk unavailable/);assert.deepEqual((await ledger.read('p')).notified,[]);
});
test('active work prevents deleting a closed native reminder; removed occurrence is not recreated by a repeated fact',async()=>{
 const {ledger}=fixture(),source={works:[{id:'work',status:'running'}],jobs:[]};let state=await ledger.observe('p','native',[{...fact,workId:'work'}]);let todo=state.todos[0];
 await ledger.manage('p',{projectId:'p',todoId:todo.id,expectedRevision:todo.managementRevision,action:'close',requestKey:'close-live-reminder'},source);todo=(await ledger.read('p')).todos[0];
 await assert.rejects(ledger.manage('p',{projectId:'p',todoId:todo.id,expectedRevision:todo.managementRevision,action:'remove',requestKey:'remove-live-reminder'},source),{code:'TODO_BLOCKED'});
 source.works[0].status='ended';await ledger.manage('p',{projectId:'p',todoId:todo.id,expectedRevision:todo.managementRevision,action:'remove',requestKey:'remove-ended-reminder'},source);
 state=await ledger.observe('p','native',[{...fact,workId:'work'}]);assert.equal(state.todos.length,0);
});
test('occurrence-guarded acknowledgement applies atomically with source-todo fallback',async()=>{
 const {storage,ledger}=fixture();const state=await ledger.observe('p','native',[fact]);const todo=state.todos[0];
 await ledger.acknowledge('p',[todo.id]);assert.deepEqual((await ledger.read('p')).notified,[todo.id],'legacy array shape still works');
 await ledger.acknowledge('p',{ids:[todo.id],occurrences:[{id:todo.id,interrupted:false}]});
 assert.deepEqual((await ledger.read('p')).notified,[todo.id],'a matching waiting occurrence acknowledges');
 await ledger.observe('p','native',[],{interrupted:true});
 assert.equal((await ledger.read('p')).notified.includes(todo.id),false,'interruption re-notifies');
 await assert.rejects(ledger.acknowledge('p',{ids:[todo.id],occurrences:[{id:todo.id,interrupted:false}]}),error=>error.code==='ATTENTION_STALE','a stale waiting occurrence rejects');
 assert.deepEqual((await ledger.read('p')).notified,[],'a rejected acknowledgement leaves the ledger untouched');
 await ledger.acknowledge('p',{ids:[todo.id],occurrences:[{id:todo.id,interrupted:true}]});
 assert.deepEqual((await ledger.read('p')).notified,[todo.id],'the matching interrupted occurrence acknowledges');
 assert.deepEqual((await new AttentionLedger(storage).read('p')).notified,[todo.id],'occurrence acknowledgements persist');
});
test('acknowledgement rejects missing, closed and mixed occurrences atomically with business fallback',async()=>{
 const {ledger}=fixture();await ledger.observe('p','native',[fact]);
 await assert.rejects(ledger.acknowledge('p',{ids:['unknown'],occurrences:[{id:'unknown',interrupted:false}]}),error=>error.code==='ATTENTION_STALE','a todo absent everywhere rejects');
 const source=[{id:'biz-result',status:'open',interrupted:undefined}];
 await ledger.acknowledge('p',{ids:['biz-result'],occurrences:[{id:'biz-result',interrupted:false}]},source);
 assert.deepEqual((await ledger.read('p')).notified,['biz-result'],'a business report todo acknowledged through the read-only source fallback');
 await assert.rejects(ledger.acknowledge('p',{ids:['biz-closed'],occurrences:[{id:'biz-closed',interrupted:false}]},[{id:'biz-closed',status:'closed',interrupted:false}]),error=>error.code==='ATTENTION_STALE','a closed source todo rejects');
 await assert.rejects(ledger.acknowledge('p',{ids:['fresh','stale'],occurrences:[{id:'fresh',interrupted:false},{id:'stale',interrupted:false}]},[{id:'fresh',status:'open',interrupted:false}]),error=>error.code==='ATTENTION_STALE','one stale occurrence rejects the whole operation');
 assert.deepEqual((await ledger.read('p')).notified,['biz-result'],'the atomic reject applied nothing');
 await ledger.acknowledge('p',{ids:['biz-resolved'],occurrences:[{id:'biz-resolved',interrupted:false}]},[{id:'biz-resolved',status:'resolved',interrupted:undefined}]);
 assert.deepEqual((await ledger.read('p')).notified,['biz-result','biz-resolved'],'a resolved source todo passes neutrally');
});
