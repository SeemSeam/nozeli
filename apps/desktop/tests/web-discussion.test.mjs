import test from 'node:test';
import assert from 'node:assert/strict';
import {WebDiscussions,webDiscussionEnvelope} from '../src/main/web-discussion.mjs';

function harness(){
 const recovery=new Map(),objects=[],calls=[];
 const storage={async getRecovery(p,k){return structuredClone(recovery.get(p+':'+k));},async putRecovery(p,k,v){recovery.set(p+':'+k,structuredClone(v));},async putObject(p,bytes){objects.push({p,text:bytes.toString()});return {digest:String(objects.length)};}};
 const managedAgents={async invoke(op,p){calls.push({op,p});if(op==='managed.enable')return {};if(op==='managed.timeline.request')return {ids:['answer','wrong'],nextOffset:null};if(op==='managed.timeline.read')return {entry:{id:p.id,speaker:'agent',jobId:p.id==='answer'?'job-1':'other-job',text:'real response',status:'completed'}};assert.equal(recovery.size>0,true,'intent persisted before dispatch');return {jobId:'job-1'};}};
 return {service:new WebDiscussions({host:{storage},managedAgents}),recovery,objects,calls};
}
const material={url:'https://example.org/a',title:'Original',text:'public content',quote:'quote',capturedAt:'2026-10-30T00:00:00Z'};

test('opening and saving are local; per-project URL draft and history never rebind',async()=>{
 const h=harness();await h.service.invoke('p',{action:'read',url:material.url});await h.service.invoke('p',{action:'draft',url:material.url,text:'A draft'});
 const b=await h.service.invoke('p',{action:'read',url:'https://example.org/b'});assert.equal(b.draft,'');
 const a=await h.service.invoke('p',{action:'read',url:material.url});assert.equal(a.draft,'A draft');
 const other=await h.service.invoke('other',{action:'read',url:material.url});assert.equal(other.draft,'');assert.deepEqual(h.calls,[]);assert.deepEqual(h.objects,[]);
});

test('explicit sends persist originals first, preserve main draft, correlate only real replies, and deduplicate each message',async()=>{
 const h=harness(),p={action:'send',url:material.url,text:'question',messageId:'message-123',material};
 await h.service.invoke('p',{action:'draft',url:material.url,text:p.text});
 const result=await h.service.invoke('p',p);const send=h.calls.find(c=>c.op==='managed.send');assert.equal(send.p.preserveDraft,true);assert.equal(send.p.requestKey,p.messageId);assert.match(send.p.text,/public content/);assert.equal(result.messages[0].text,'question');assert.equal(result.messages.filter(m=>m.role==='agent').length,1);assert.equal(result.draft,'');
 await h.service.invoke('p',{...p,material:{...material,text:'changed'}});assert.equal(h.calls.filter(c=>c.op==='managed.send').length,1);assert.equal(h.objects.length,1);assert.match(h.objects[0].text,/public content/);
 await h.service.invoke('p',{...p,action:'task',messageId:'message-task-1'});await h.service.invoke('p',{...p,action:'task',messageId:'message-task-2'});assert.equal(h.calls.filter(c=>c.op==='managed.task').length,2);
});

test('unknown dispatch retries use same immutable material and request identity',async()=>{
 const h=harness(),base=h.service.managedAgents.invoke.bind(h.service.managedAgents);let fail=true;
 h.service.managedAgents.invoke=async(op,p)=>{if(op==='managed.send'&&fail){fail=false;throw Error('connection lost');}return base(op,p);};
 const p={action:'send',url:material.url,text:'question',messageId:'message-retry-1',material};await assert.rejects(h.service.invoke('p',p),/connection lost/);
 await h.service.invoke('p',{...p,material:{...material,text:'later page'}});const sent=h.calls.find(c=>c.op==='managed.send');assert.match(sent.p.text,/public content/);assert.doesNotMatch(sent.p.text,/later page/);assert.equal(h.objects.length,1);
});


test('long escaped webpage snapshots remain intact while sent envelope advertises bounded excerpt',async()=>{
 const h=harness(),long={...material,text:'"\\\n\u0001😀'.repeat(30000)};
 const result=await h.service.invoke('p',{action:'send',url:material.url,text:'"\\\n'.repeat(5000),messageId:'long-message-1',material:long});
 const sent=h.calls.find(c=>c.op==='managed.send');assert.ok(sent.p.text.length<32000);assert.match(sent.p.text,/snapshotTextCharacters/);assert.match(sent.p.text,/"truncated":true/);
 assert.equal(JSON.parse(h.objects[0].text).text,long.text);assert.equal(result.messages[0].delivery.truncated,true);assert.ok(result.messages[0].delivery.textCharacters<long.text.length);assert.equal(result.messages[0].delivery.snapshotTextCharacters,long.text.length);
 assert.throws(()=>webDiscussionEnvelope('x'.repeat(16001),material),/16000/);
 const short=webDiscussionEnvelope('question',material);assert.equal(short.delivery.truncated,false);assert.ok(short.text.length<32000);
});

test('exact terminal job failure is visible and restores only the untouched latest draft once',async()=>{
 const h=harness(),base=h.service.managedAgents.invoke.bind(h.service.managedAgents);let phase='running';
 h.service.managedAgents.invoke=async(op,p)=>op==='managed.timeline.request'?{ids:[],nextOffset:null,job:{id:p.requestId,status:phase,...(phase==='failed'?{error:'No API key found for the selected model'}:{})}}:base(op,p);
 const p={action:'send',url:material.url,text:'Original question',messageId:'failed-message',material};await h.service.invoke('p',{action:'draft',url:material.url,text:p.text});const accepted=await h.service.invoke('p',p);assert.equal(accepted.draft,'');
 phase='failed';const failed=await h.service.invoke('p',{action:'read',url:material.url});assert.equal(failed.messages[0].status,'failed');assert.match(failed.messages[0].error,/No API key/);assert.equal(failed.draft,p.text);
 await h.service.invoke('p',{action:'draft',url:material.url,text:''});assert.equal((await h.service.invoke('p',{action:'read',url:material.url})).draft,'','intentional clearing is not undone by repeated failure polling');
 assert.equal(h.calls.filter(call=>call.op==='managed.send').length,1);assert.equal(h.objects.length,1);
});

test('older failure cannot overwrite new typing and foreign request status cannot relabel the message',async()=>{
 const h=harness(),base=h.service.managedAgents.invoke.bind(h.service.managedAgents);let mode='running';
 h.service.managedAgents.invoke=async(op,p)=>op==='managed.timeline.request'?{ids:[],nextOffset:null,job:{id:mode==='foreign'?'other-request':p.requestId,status:mode==='running'?'running':'failed',error:'controlled failure'}}:base(op,p);
 await h.service.invoke('p',{action:'send',url:material.url,text:'sent',messageId:'preserved-message',material});await h.service.invoke('p',{action:'draft',url:material.url,text:'new unrelated typing'});
 mode='foreign';const unrelated=await h.service.invoke('p',{action:'read',url:material.url});assert.equal(unrelated.messages[0].status,'running');assert.equal(unrelated.draft,'new unrelated typing');
 mode='failed';const failed=await h.service.invoke('p',{action:'read',url:material.url});assert.equal(failed.messages[0].status,'failed');assert.equal(failed.draft,'new unrelated typing');
});
