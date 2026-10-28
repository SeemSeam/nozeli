import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ChangeSet } from '@codemirror/state';
import { DesktopHost } from '../src/main/host.mjs';
import { FileChanges } from '../src/domain/file-changes.mjs';
import { agentActor } from '../src/domain/document-changes.mjs';
import { FileTreeOps } from '../src/main/file-tree-ops.mjs';
import { startDocumentTools } from '../src/agents/document-tools.mjs';
import {lineAuthorship,groupScope} from '../src/domain/authorship-groups.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
async function fixture(text='base\nuntouched\nbase\n') {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-authorship-')),root=path.join(dir,'项目'),profile=path.join(dir,'profile');
  await fs.mkdir(root);const file=path.join(root,'sample.md');await fs.writeFile(file,text);
  const host=new DesktopHost(profile),projectId=(await host.pick(root)).project.id,store=new FileChanges({storage:host.storage,projectId,root});
  return {dir,root,profile,file,host,projectId,store,rel:'sample.md',cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
const record=(fx,rel)=>fx.host.storage.getProjectRecord(fx.projectId,'file_changes',fx.store.keys.key(rel));
const actor=(id,role,instance='instance-'+role)=>agentActor(id,role,{provider:'codex',sessionInstance:instance,sessionId:'real-session-'+role});
async function apply(fx,role,edits) {
  const identity=actor(fx.projectId,role),snapshot=await fx.host.readDocument(fx.projectId,fx.rel,identity);
  return fx.host.applyDocument(fx.projectId,identity,{readHandle:snapshot.readHandle,edits,operationId:hash(JSON.stringify([snapshot.readHandle,edits]))});
}

test('group history retains over 100 old batches, paginates without writes and rejects stale scopes/cursors',async()=>{
  const fx=await fixture('_'.repeat(105)+'\nuntouched\nx');
  try{
    for(let i=0;i<105;i++){
      const read=await fx.host.readFile(fx.projectId,fx.rel),after=read.text.slice(0,i)+'A'+read.text.slice(i+1);
      await fx.host.save(fx.projectId,fx.rel,read.digest,after,{anchorChanges:ChangeSet.of({from:i,to:i+1,insert:'A'},read.text.length).toJSON()});
    }
    const old=(await fx.host.documentHistory(fx.projectId,fx.rel)).events.at(-1).id;
    for(let i=0;i<101;i++){
      const read=await fx.host.readFile(fx.projectId,fx.rel),from=read.text.length-1,insert=i%2?'X':'Y';
      await fx.host.save(fx.projectId,fx.rel,read.digest,read.text.slice(0,from)+insert,{anchorChanges:ChangeSet.of({from,to:from+1,insert},read.text.length).toJSON()});
    }
    const read=await fx.host.readFile(fx.projectId,fx.rel),group=lineAuthorship(read.text,read.authorship)[0],scope=groupScope(group);
    const sourceBefore=await fs.readFile(fx.file),ledgerBefore=await record(fx,fx.rel);
    const recent=await fx.host.documentHistory(fx.projectId,fx.rel);assert(!recent.events.some(e=>e.id===old));
    let cursor=null,events=[];
    do{const result=await fx.host.documentHistory(fx.projectId,fx.rel,{scope,cursor,limit:40});events.push(...result.events);cursor=result.nextCursor;assert.equal(result.total,105);}while(cursor);
    assert.equal(events.length,105);assert.equal(new Set(events.map(e=>e.id)).size,105);assert(events.some(e=>e.id===group.items.at(-1).eventId));assert(events.every(e=>e.edits[0].from<105));
    assert.deepEqual(await fs.readFile(fx.file),sourceBefore);assert.deepEqual(await record(fx,fx.rel),ledgerBefore);
    const page=await fx.host.documentHistory(fx.projectId,fx.rel,{scope,limit:40});
    await assert.rejects(fx.host.documentHistory(fx.projectId,fx.rel,{scope:{...scope,from:-1}}),e=>e.code==='INVALID_PAYLOAD');
    await assert.rejects(fx.host.documentHistory(fx.projectId,fx.rel,{limit:101}),e=>e.code==='INVALID_PAYLOAD');
    const filtered=await fx.host.documentHistory(fx.projectId,fx.rel,{scope:{...scope,eventIds:[group.items[0].eventId,'fake']}});assert.equal(filtered.events.length,1);
    await fx.host.save(fx.projectId,fx.rel,read.digest,read.text+'!');
    await assert.rejects(fx.host.documentHistory(fx.projectId,fx.rel,{scope}),e=>e.code==='STALE_HISTORY');
    await assert.rejects(fx.host.documentHistory(fx.projectId,fx.rel,{cursor:page.nextCursor}),e=>e.code==='STALE_HISTORY');
  }finally{await fx.cleanup();}
});

test('baseline stays unknown; exact repeated-text edits distinguish you and both same-provider agents',async()=>{
  const fx=await fixture('第一处：重复😀。\r\n第二处：重复😀。\r\n保留正文\r\n');
  try{
    const opened=await fx.host.readFile(fx.projectId,fx.rel);assert.equal(opened.authorship.eventCount,0);assert.deepEqual(opened.authorship.spans,[]);
    const before=opened.text.replace(/\r\n/g,'\n'),from=before.lastIndexOf('重复'),after=before.slice(0,from)+'用户改写'+before.slice(from+2),changes=ChangeSet.of({from,to:from+2,insert:'用户改写'},before.length);
    const saved=await fx.host.save(fx.projectId,fx.rel,opened.digest,after,{anchorChanges:changes.toJSON()});
    assert.equal(saved.authorship.spans.length,1);assert.equal(saved.authorship.spans[0].from,from);assert.equal(after.slice(saved.authorship.spans[0].from,saved.authorship.spans[0].to),'用户改写');assert.equal(saved.authorship.spans[0].actor.kind,'user');
    await apply(fx,'qa',[{from:0,to:3,insert:'A1标题',expected:'第一处'}]);
    const current=await fs.readFile(fx.file,'utf8'),tail=current.indexOf('保留正文');await apply(fx,'task',[{from:tail,to:tail+4,insert:'A2尾段'}]);
    const restarted=await new DesktopHost(fx.profile).readFile(fx.projectId,fx.rel);
    assert.deepEqual(new Set(restarted.authorship.spans.map(span=>span.actor.kind)),new Set(['user','agent1','agent2']));
    assert.equal(new Set(restarted.authorship.spans.map(span=>span.actor.id)).size,3);assert(restarted.authorship.spans.every(span=>Number.isFinite(Date.parse(span.time))));
    assert(!restarted.text.includes('actorId'));assert(!restarted.text.includes('.nozeli'));
    const history=await fx.host.documentHistory(fx.projectId,fx.rel);assert.equal(history.events.length,3);assert(history.events[2].edits.some(edit=>edit.removed==='重复'));assert(history.events[0].actor.provider==='codex'&&history.events[1].actor.provider==='codex');
  }finally{await fx.cleanup();}
});

test('partial replacement/deletion keeps other modifiers, exact UTF-16 spans and removed text',async()=>{
  const fx=await fixture('😀abcdef\n');
  try{
    await apply(fx,'qa',[{from:2,to:8,insert:'abcdef'}]); // same text does not acquire new authorship
    assert.equal((await fx.host.documentHistory(fx.projectId,fx.rel)).events.length,0);
    await apply(fx,'qa',[{from:2,to:8,insert:'ABCDEF'}]);
    await apply(fx,'task',[{from:4,to:6,insert:'xx'}]);
    const before=await fx.host.readFile(fx.projectId,fx.rel),text=before.text.slice(0,2)+before.text.slice(4);
    await fx.host.save(fx.projectId,fx.rel,before.digest,text,{anchorChanges:ChangeSet.of({from:2,to:4},before.text.length).toJSON()});
    const current=await fx.host.readFile(fx.projectId,fx.rel);assert.equal(current.text,'😀xxEF\n');
    assert.deepEqual(current.authorship.spans.map(s=>[s.from,s.to,s.actor.kind]),[[2,4,'agent2'],[4,6,'agent1']]);assert.equal(current.authorship.points[0].from,2);
    const history=await fx.host.documentHistory(fx.projectId,fx.rel);assert.equal(history.events[0].edits[0].removed,'AB');
    const snapshot=await fx.host.readDocument(fx.projectId,fx.rel,actor(fx.projectId,'qa'));
    await assert.rejects(fx.host.applyDocument(fx.projectId,actor(fx.projectId,'qa'),{readHandle:snapshot.readHandle,edits:[{from:1,to:2,insert:'x'}],operationId:hash('split')}),e=>e.code==='INVALID_PAYLOAD');
  }finally{await fx.cleanup();}
});

test('duplicate document operations never reapply or accept a changed payload',async()=>{
  const fx=await fixture('abcdef');
  try{
    const a=actor(fx.projectId,'qa'),snap=await fx.host.readDocument(fx.projectId,fx.rel,a),edit={readHandle:snap.readHandle,edits:[{from:1,to:2,insert:'X'}],operationId:hash('stable-op')};
    const result=await fx.host.applyDocument(fx.projectId,a,edit),duplicate=await fx.host.applyDocument(fx.projectId,a,edit);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.eventId,result.eventId);assert.equal(await fs.readFile(fx.file,'utf8'),'aXcdef');
    await assert.rejects(fx.host.applyDocument(fx.projectId,a,{...edit,edits:[{from:1,to:2,insert:'Y'}]}),e=>e.code==='CONFLICT');
  }finally{await fx.cleanup();}
});

test('unsaved drafts and foreign actor/session/project handles cannot be overwritten',async()=>{
  const fx=await fixture();
  try{
    const a=actor(fx.projectId,'qa'),snap=await fx.host.readDocument(fx.projectId,fx.rel,a),payload={readHandle:snap.readHandle,edits:[{from:0,to:4,insert:'agent'}],operationId:hash('draft')};
    await assert.rejects(fx.host.applyDocument(fx.projectId,actor(fx.projectId,'task'),payload),e=>e.code==='READ_HANDLE_REJECTED');
    await assert.rejects(fx.host.applyDocument(fx.projectId,actor(fx.projectId,'qa','different-session'),payload),e=>e.code==='READ_HANDLE_REJECTED');
    await assert.rejects(fx.host.applyDocument('f'.repeat(64),a,payload),e=>e.code==='READ_HANDLE_REJECTED');
    await fx.host.draft(fx.projectId,fx.rel,snap.version.digest,'用户未保存输入');
    await assert.rejects(fx.host.applyDocument(fx.projectId,a,payload),e=>e.code==='UNSAVED');await assert.rejects(fx.host.readDocument(fx.projectId,fx.rel,a),e=>e.code==='UNSAVED');
    const read=await fx.host.readFile(fx.projectId,fx.rel);assert.equal(read.draft.text,'用户未保存输入');assert.equal(read.text,snap.text);
    await assert.rejects(fx.host.readDocument(fx.projectId,'../sample.md',a));
  }finally{await fx.cleanup();}
});

test('unverified shell changes stay external, even while both agents hold handles',async()=>{
  const fx=await fixture();
  try{
    await fx.host.readDocument(fx.projectId,fx.rel,actor(fx.projectId,'qa'));await fx.host.readDocument(fx.projectId,fx.rel,actor(fx.projectId,'task'));
    await fs.writeFile(fx.file,'外部写入\nuntouched\nbase\n');
    const read=await fx.host.readFile(fx.projectId,fx.rel);assert.equal(read.authorship.eventCount,1);assert(read.authorship.spans.every(span=>span.actor.kind==='external'));
    assert.equal((await fx.host.documentHistory(fx.projectId,fx.rel)).events[0].type,'external');
  }finally{await fx.cleanup();}
});

test('prepared journal after failed replacement preserves candidate without fake committed authorship',async()=>{
  const fx=await fixture();
  try{
    const read=await fx.host.readFile(fx.projectId,fx.rel);fx.host.replaceFile=async()=>{throw new Error('injected before rename');};
    await assert.rejects(fx.host.save(fx.projectId,fx.rel,read.digest,'candidate'));
    assert((await fx.store.read(fx.rel)).pending);
    const recovered=await new DesktopHost(fx.profile).readFile(fx.projectId,fx.rel);assert.equal(recovered.text,read.text);assert.equal(recovered.authorship.eventCount,0);assert.equal(recovered.draft.text,'candidate');
    const ledger=await fx.store.read(fx.rel);assert.equal(ledger.pending,null);assert.equal(ledger.attempts[0].candidate.text,'candidate');assert.equal(ledger.attempts[0].outcome,'not-written');
  }finally{await fx.cleanup();}
});

test('journal recovers after rename/finalization failure; third disk version is unconfirmed external',async()=>{
  const fx=await fixture();const finish=FileChanges.prototype.finish;
  try{
    const read=await fx.host.readFile(fx.projectId,fx.rel);FileChanges.prototype.finish=async()=>{throw Error('injected after rename');};
    await assert.rejects(fx.host.save(fx.projectId,fx.rel,read.digest,'candidate'));FileChanges.prototype.finish=finish;
    const recovered=await new DesktopHost(fx.profile).readFile(fx.projectId,fx.rel);assert.equal(recovered.text,'candidate');assert.equal(recovered.authorship.spans[0].actor.kind,'user');assert.equal((await fx.store.read(fx.rel)).pending,null);
    FileChanges.prototype.finish=async()=>{throw Error('another interruption');};await assert.rejects(fx.host.save(fx.projectId,fx.rel,recovered.digest,'second candidate'));FileChanges.prototype.finish=finish;
    await fs.writeFile(fx.file,'third external');const divergent=await new DesktopHost(fx.profile).readFile(fx.projectId,fx.rel);assert.equal(divergent.text,'third external');assert.equal(divergent.authorship.lastChange.actor.kind,'external');assert.equal((await fx.store.read(fx.rel)).attempts[0].outcome,'source-diverged');
  }finally{FileChanges.prototype.finish=finish;await fx.cleanup();}
});

test('damaged/unknown history is kept and blocks overwrite while preserving a user draft',async()=>{
  const fx=await fixture();
  try{
    const read=await fx.host.readFile(fx.projectId,fx.rel),key=fx.store.keys.key(fx.rel),pristine=await fx.store.read(fx.rel),damaged={...pristine,docId:'damaged-history'};
    await fx.host.storage.putProject(fx.projectId,'file_changes',key,damaged);
    const readable=await fx.host.readFile(fx.projectId,fx.rel);assert.equal(readable.text,read.text);assert.equal(readable.authorshipError.code,'CHANGE_HISTORY_CORRUPT');
    await assert.rejects(fx.host.save(fx.projectId,fx.rel,read.digest,'kept draft'),e=>e.code==='CHANGE_HISTORY_CORRUPT');assert.deepEqual((await record(fx,fx.rel)).value,damaged);assert.equal(await fs.readFile(fx.file,'utf8'),read.text);assert.equal((await fx.host.readFile(fx.projectId,fx.rel)).draft.text,'kept draft');
    const unknown={...pristine,schemaVersion:9};await fx.host.storage.putProject(fx.projectId,'file_changes',key,unknown);await assert.rejects(fx.host.save(fx.projectId,fx.rel,read.digest,'another draft'),e=>e.code==='SCHEMA_UNSUPPORTED');assert.deepEqual((await record(fx,fx.rel)).value,unknown);assert.equal(await fs.readFile(fx.file,'utf8'),read.text);
  }finally{await fx.cleanup();}
});

test('rename/copy/trash preserve history, move identity and independently identify copies',async()=>{
  const fx=await fixture();
  try{
    await apply(fx,'qa',[{from:0,to:4,insert:'Agent'}]);const old=await fx.store.read(fx.rel),tree=new FileTreeOps(fx.host,{trash:p=>fs.rename(p,p+'.trashed')});
    await tree.run({projectId:fx.projectId,action:'rename',source:fx.rel,name:'renamed.md'});assert.equal((await fx.store.read('renamed.md')).docId,old.docId);assert.equal(await fx.store.read(fx.rel),null);
    await tree.run({projectId:fx.projectId,action:'copy',source:'renamed.md',target:''});const copied=await fx.store.read('renamed 副本.md');assert.notEqual(copied.docId,old.docId);assert.equal(copied.events[0].actor.id,old.events[0].actor.id);assert.equal(copied.copiedFrom.docId,old.docId);
    await tree.run({projectId:fx.projectId,action:'trash',source:'renamed.md'});assert.equal((await fx.host.documentHistory(fx.projectId,'renamed.md')).events[0].actor.kind,'agent1');
    await assert.rejects(tree.run({projectId:fx.projectId,action:'createFile',name:'renamed.md'}));
  }finally{await fx.cleanup();}
});

test('actual Node helper read/apply, capability isolation, permission and revocation',async()=>{
  const fx=await fixture();let tools;
  try{
    tools=await startDocumentTools(fx.host);const grant=tools.issue({projectId:fx.projectId,role:'qa',provider:'codex',permissionMode:'full'}),runtime=path.join(fx.dir,'grant.json'),snapshot=path.join(fx.dir,'snapshot.json'),edits=path.join(fx.dir,'edits.json');
    await fs.writeFile(runtime,JSON.stringify({url:tools.url,token:grant.token}));
    const helper=path.resolve(import.meta.dirname,'../src/agents/document-entry.cjs'),run=promisify(execFile);
    await run(process.execPath,[helper,'--runtime',runtime,'--read',fx.rel,'--out',snapshot]);await fs.writeFile(edits,JSON.stringify([{from:0,to:4,insert:'CLI'}]));
    const result=JSON.parse((await run(process.execPath,[helper,'--runtime',runtime,'--apply',snapshot,'--edits',edits])).stdout);assert.equal(result.authorship.lastChange.actor.kind,'agent1');
    const duplicate=JSON.parse((await run(process.execPath,[helper,'--runtime',runtime,'--apply',snapshot,'--edits',edits])).stdout);assert.equal(duplicate.duplicate,true);
    await assert.rejects(run(process.execPath,[helper,'--runtime',runtime,'--read',fx.rel,'--out',snapshot]));
    const readonly=tools.issue({projectId:fx.projectId,role:'task',provider:'codex',permissionMode:'inherit'});
    const post=(token,body)=>fetch(tools.url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await post(readonly.token,{op:'apply'})).status,403);assert.equal((await post(grant.token,{op:'read',relPath:fx.rel,actor:'fake'})).status,400);
    tools.setSession(grant.token,'bound-native-session');const newRead=(await (await post(grant.token,{op:'read',relPath:fx.rel})).json()).value;
    tools.setSession(grant.token,'replacement-native-session');
    const oldSession=await (await post(grant.token,{op:'apply',readHandle:newRead.readHandle,edits:[{from:0,to:1,insert:'x'}],operationId:hash('session-swap')})).json();assert.equal(oldSession.error.code,'READ_HANDLE_REJECTED');
    tools.revoke(grant.token);assert.equal((await post(grant.token,{op:'read',relPath:fx.rel})).status,401);
  }finally{await tools?.close();await fx.cleanup();}
});
