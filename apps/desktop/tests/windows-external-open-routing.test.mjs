import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter,once} from 'node:events';
import {createHash} from 'node:crypto';
import {ExternalOpenRouting} from '../src/main/external-open-routing.mjs';
import {desktopHosts} from './fixtures/desktop-hosts.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64',timeout:30000};
const hash=value=>createHash('sha256').update(value).digest('hex');
const code=expected=>error=>error.code===expected;
const token=claim=>Object.fromEntries(['requestId','attemptId','claimToken','generation'].map(key=>[key,claim[key]]));
function record(id,scope={}){
 const wc=new EventEmitter();Object.assign(wc,{id,isDestroyed:()=>false,send(channel,payload){this.emit('sent',{channel,payload});}});
 const win={webContents:wc,isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false};
 return {wc,win,generation:1,ready:true,dead:false,role:'shell',...scope};
}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-win-routing-')),project=path.join(root,'项目 空格');await fs.mkdir(project);
 const file=path.join(project,'正文.txt'),text='Original Windows source 中文 🧭\n';await fs.writeFile(file,text);
 const hosts=desktopHosts(),host=hosts.create(path.join(root,'profile')),shell=record(1),workspace={shell,senders:new Map([[1,shell]]),surfaces:new Map(),layout:async()=>workspace.currentLayout};
 const routing=new ExternalOpenRouting({host,workspace,displayTimeout:250});routing.observe(shell);
 t.after(async()=>{await routing.settled();await hosts.close();await fs.rm(root,{recursive:true,force:true});});
 const invoke=(op,payload={})=>routing.invoke(shell,'session.external.'+op,payload);
 const start=async(mode='fresh')=>{const state=await invoke('status');return invoke('begin',{requestId:state.requests[0].requestId,expectedRevision:state.revision,mode});};
 function surface(claim){
  const row=record(2,{role:'surface',kind:'document',viewId:'document-1',windowId:'main',projectId:claim.projectId,relPath:claim.relPath,view:{getVisible:()=>true}});
  workspace.senders.set(2,row);workspace.surfaces.set(row.viewId,row);shell.projectId=claim.projectId;
  workspace.currentLayout={views:{[row.viewId]:{id:row.viewId}},mainRoot:{kind:'group',id:'group-1',activeViewId:row.viewId,views:[row.viewId]},detached:[]};return row;
 }
 const snapshot=()=>{const read=routing.transaction.read;return {ready:true,projectId:read.projectId,relPath:read.relPath,kind:read.file?.kind,digest:read.digest,materialDigest:read.materialDigest,draftDigest:read.draftDigest,textDigest:read.file?hash(read.file.draft?.text??read.file.text):null,dirty:Boolean(read.file?.draft)};};
 const answer=(row,change={})=>{const handler=({payload})=>{if(payload.type==='external-open-display')routing.displayed(row,{requestId:payload.requestId,ok:true,snapshot:{...snapshot(),...change}});};row.wc.on('sent',handler);return ()=>row.wc.off('sent',handler);};
 return {root,project,file,text,host,shell,workspace,routing,invoke,start,surface,snapshot,answer};
}

test('production routing durably admits before binding and accepts only the actual visible document challenge',native,async t=>{
 const f=await fixture(t);await f.routing.admit([f.file],'argv');let status=await f.invoke('status');assert.equal(status.requests.length,1);assert.equal(status.requests[0].target,null);
 assert.equal(JSON.parse(await fs.readFile(f.routing.queue.storage.file,'utf8')).requests[0].absolutePath,f.file);
 const claim=await f.start(),row=f.surface(claim);assert.equal(claim.relPath,'正文.txt');
 let denied=0;row.wc.on('sent',({payload})=>{if(payload.type!=='external-open-display')return;assert.throws(()=>f.routing.displayed(f.shell,{requestId:payload.requestId,ok:true,snapshot:f.snapshot()}),code('OPEN_DISPLAY_DENIED'));denied++;f.routing.displayed(row,{requestId:payload.requestId,ok:true,snapshot:f.snapshot()});});
 const result=await f.invoke('confirm',token(claim));assert.equal(result.outcome,'opened');assert.equal(denied,1);assert.deepEqual((await f.invoke('status')).requests,[]);
 assert.equal(JSON.parse(await fs.readFile(f.routing.queue.storage.file,'utf8')).receipts[0].outcome,'opened');assert.equal(await fs.readFile(f.file,'utf8'),f.text);
});

test('routing refuses renderer-chosen owners and non-shell control before native effects',native,async t=>{
 const f=await fixture(t);await assert.rejects(f.invoke('status',{owner:{generation:5}}),code('OPEN_INVALID'));
 const other=record(9,{role:'surface'});await assert.rejects(f.routing.invoke(other,'session.external.status',{}),code('IPC_DENIED'));
 await assert.rejects(fs.lstat(f.routing.queue.storage.file),{code:'ENOENT'});
});

for(const variant of ['text','digest','material','hidden','background'])test('routing retains original request after '+variant+' display mismatch',native,async t=>{
 const f=await fixture(t);await f.routing.admit([f.file],'argv');const claim=await f.start(),row=f.surface(claim);
 if(variant==='hidden')row.win.isVisible=()=>false;
 if(variant==='background')f.workspace.currentLayout.mainRoot.activeViewId='different';
 f.answer(row,variant==='text'?{textDigest:hash('unsent different buffer')}:variant==='digest'?{digest:hash('different source')}:variant==='material'?{materialDigest:hash('different material')}:{});
 await assert.rejects(f.invoke('confirm',token(claim)));const state=await f.invoke('status');assert.equal(state.requests.length,1);assert.equal(state.requests[0].state,'blocked');assert.equal(state.requests[0].requiresUserAction,true);assert.equal(await fs.readFile(f.file,'utf8'),f.text);
 await assert.rejects(f.invoke('remove',{requestId:claim.requestId,expectedRevision:state.revision,confirmed:false}),code('OPEN_CONFIRM_REQUIRED'));
 await f.invoke('remove',{requestId:claim.requestId,expectedRevision:state.revision,confirmed:true});assert.deepEqual((await f.invoke('status')).requests,[]);assert.equal(await fs.readFile(f.file,'utf8'),f.text);
});

test('routing terminal durability retry confirms the exact result without another source read or display challenge',native,async t=>{
 const f=await fixture(t);await f.routing.admit([f.file],'argv');const claim=await f.start(),row=f.surface(claim);f.answer(row);
 let challenges=0,reads=0;row.wc.on('sent',()=>challenges++);const original=f.host.readFile.bind(f.host);f.host.readFile=(...args)=>{reads++;return original(...args);};
 f.routing.queue.storage.fault=async stage=>{if(stage==='directory-sync')throw Object.assign(Error('synthetic result barrier failure'),{code:'EIO'});};
 await assert.rejects(f.invoke('confirm',token(claim)),code('OPEN_PERSISTENCE_UNCONFIRMED'));
 const status=await f.invoke('status');assert.equal(status.status,'paused');assert.equal(status.terminalPending,true);assert.equal(challenges,1);
 f.routing.queue.storage.fault=async()=>{};await f.invoke('retryPersistence');assert.equal(challenges,1);assert.equal(reads,0);assert.deepEqual((await f.invoke('status')).requests,[]);
});

test('routing retains uncertain admission identity and FIFO until explicit persistence and admission retries',native,async t=>{
 const f=await fixture(t);f.routing.queue.storage.fault=async stage=>{if(stage==='directory-sync')throw Object.assign(Error('synthetic admission barrier'),{code:'EIO'});};
 const second=path.join(f.project,'second.txt');await fs.writeFile(second,'Second');await f.routing.admit([f.file,second],'second-instance');
 const paused=await f.invoke('status');assert.equal(paused.status,'paused');assert.equal(paused.unaccepted.length,2);const ids=paused.unaccepted.map(row=>row.requestId);
 f.routing.queue.storage.fault=async()=>{};await f.invoke('retryPersistence');await f.invoke('retryAdmissions');const status=await f.invoke('status');
 assert.deepEqual(status.unaccepted,[]);assert.deepEqual(status.requests.map(row=>row.requestId),ids);assert.deepEqual(status.requests.map(row=>row.absolutePath),[f.file,second]);assert.equal(status.requests[1].requiresUserAction,true);
});

test('routing revokes the main generation during an unanswered surface challenge and cold load never replays',native,async t=>{
 const f=await fixture(t);await f.routing.admit([f.file],'argv');const claim=await f.start(),row=f.surface(claim),sent=once(row.wc,'sent');
 const pending=f.invoke('confirm',token(claim));const rejected=assert.rejects(pending);const [{payload}]=await sent;
 const displayed=f.snapshot();f.shell.generation++;f.shell.wc.emit('did-start-navigation',{},'',false,true);
 assert.throws(()=>f.routing.displayed(row,{requestId:payload.requestId,ok:true,snapshot:displayed}),code('OPEN_DISPLAY_DENIED'));await rejected;await f.routing.settled();
 const cold=new ExternalOpenRouting({host:f.host,workspace:f.workspace});const state=await cold.status(f.shell);assert.equal(state.requests.length,1);assert.equal(state.requests[0].requiresUserAction,true);assert.equal(state.requests[0].state,'blocked');
 await assert.rejects(cold.invoke(f.shell,'session.external.begin',{requestId:claim.requestId,expectedRevision:state.revision,mode:'fresh'}),code('OPEN_RETRY_REQUIRED'));
});

test('routing requires exact retained draft text and leaves source untouched on success',native,async t=>{
 const f=await fixture(t);const picked=await f.host.pick(f.project),read=await f.host.readFile(picked.project.id,'正文.txt'),text=f.text+'Unsent retained draft';
 await f.host.draft(picked.project.id,'正文.txt',read.digest,text);
 await f.routing.admit([f.file],'argv');const claim=await f.start(),row=f.surface(claim);f.answer(row);await f.invoke('confirm',token(claim));
 assert.equal(await fs.readFile(f.file,'utf8'),f.text);assert.equal((await f.host.readFile(picked.project.id,'正文.txt')).draft.text,text);
});

test('routing directory completion queries the actual ready project shell',native,async t=>{
 const f=await fixture(t);await f.routing.admit([f.project],'argv');const claim=await f.start();f.shell.projectId=claim.projectId;f.answer(f.shell);await f.invoke('confirm',token(claim));assert.deepEqual((await f.invoke('status')).requests,[]);
});

test('routing rejects changed disk bytes after the original surface displayed and preserves the external winner',native,async t=>{
 const f=await fixture(t);await f.routing.admit([f.file],'argv');const claim=await f.start(),row=f.surface(claim);
 row.wc.on('sent',({payload})=>{if(payload.type==='external-open-display')void fs.writeFile(f.file,'Independent winner').then(()=>f.routing.displayed(row,{requestId:payload.requestId,ok:true,snapshot:f.snapshot()}));});
 await assert.rejects(f.invoke('confirm',token(claim)),code('OPEN_TARGET_CHANGED'));assert.equal((await f.invoke('status')).requests[0].state,'blocked');assert.equal(await fs.readFile(f.file,'utf8'),'Independent winner');
});
