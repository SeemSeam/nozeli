import test from 'node:test';
import assert from 'node:assert/strict';
import {createTexPersistFixture,deferred} from './tex-workspace-persist.fixture.mjs';
async function fixture(t,options){const f=await createTexPersistFixture(options);t.after(()=>f.cleanup());return f;}
const assertNoSideEffects=f=>assert.equal(f.calls.some(c=>['tex.build','tex.cancel','file.save','file.draft','tag.put'].includes(c.op)),false);

test('no TeX or no current context explicitly returns not-applicable without IPC',async t=>{
 for(const context of [null,{}, {project:{id:'p'},file:{relPath:'readme.md'}}]){const f=await fixture(t,{context});assert.deepEqual(await f.workspace.persistChecked(),{ok:true,value:{applicable:false}});assert.deepEqual(f.calls,[]);}
});
test('TeX file before enter, unknown project and unselected root are not a false not-applicable success',async t=>{
 const f=await fixture(t);assert.equal((await f.workspace.persistChecked()).error.code,'TEX_CONTEXT_NOT_READY');f.context={file:{relPath:'main.tex'}};assert.equal((await f.workspace.persistChecked()).error.code,'TEX_CONTEXT_NOT_READY');
 f.context={project:{id:'project-a'},file:{relPath:'main.tex'}};f.config.root=null;await f.enter();assert.equal((await f.workspace.persistChecked()).error.code,'TEX_CONTEXT_NOT_READY');assertNoSideEffects(f);
});
test('inspect pending and inferred-root configuration pending both reject checked persistence',async t=>{
 const f=await fixture(t),inspection=deferred(),configured=deferred();let inspectArgs;
 f.handlers.set('tex.inspect',args=>{inspectArgs=args;return inspection.promise;});f.handlers.set('tex.configure',()=>configured.promise);const entering=f.workspace.enter();
 assert.equal((await f.workspace.persistChecked()).error.code,'TEX_CONTEXT_NOT_READY');inspection.resolve({ok:true,value:{config:f.config,configuredRoot:null,texFiles:['main.tex'],tools:{xelatex:true},state:{projectId:inspectArgs.projectId,phase:'idle'},view:{preview:false}}});await Promise.resolve();await Promise.resolve();
 assert.equal((await f.workspace.persistChecked()).error.code,'TEX_CONTEXT_NOT_READY');configured.resolve({ok:true,value:f.config});await entering;assert.deepEqual(await f.workspace.persistChecked(),{ok:true,value:{applicable:true,projectId:'project-a',root:'main.tex'}});assertNoSideEffects(f);
});
test('ready checked save reuses exact current preview position and explicit project/root identity',async t=>{
 const f=await fixture(t);await f.enter();f.preview({page:7,zoom:1.75,scrollTop:321});const before=f.message();assert.deepEqual(await f.workspace.persistChecked(),{ok:true,value:{applicable:true,projectId:'project-a',root:'main.tex'}});
 const request=f.calls.findLast(c=>c.op==='tex.view');assert.deepEqual(request.args,{projectId:'project-a',root:'main.tex',view:{page:7,zoom:1.75,scrollTop:321,preview:false,linked:true}});assert.equal(f.message(),before);assert.equal(f.calls.filter(c=>c.op==='tex.view').length,1);assertNoSideEffects(f);
});
test('no displayed preview saves existing per-root position instead of inventing the current surface',async t=>{
 const f=await fixture(t);await f.enter();const result=await f.workspace.persistChecked();assert(result.ok&&result.value.applicable);assert.deepEqual(f.calls.findLast(c=>c.op==='tex.view').args.view,{page:2,zoom:1.25,scrollTop:40,preview:false,linked:true});assertNoSideEffects(f);
});
for(const [name,reply,code] of [['business',()=>({ok:false,error:{code:'TEX_VIEW_REJECTED',message:'HOST_REFUSED_POSITION'}}),'TEX_VIEW_REJECTED'],['transport',()=>{throw Error('IPC_TRANSPORT_LOST');},'TEX_VIEW_FAILED']])test('checked '+name+' failure returns structured error without changing page status or retrying',async t=>{
 const f=await fixture(t);await f.enter();const before=f.message();f.handlers.set('tex.view',reply);const result=await f.workspace.persistChecked();assert.equal(result.ok,false);assert.equal(result.error.code,code);assert.match(result.error.message,/HOST_REFUSED_POSITION|IPC_TRANSPORT_LOST/);assert.equal(f.message(),before);assert.equal(f.calls.filter(c=>c.op==='tex.view').length,1);assertNoSideEffects(f);
});
for(const getter of ['current','zoomLevel','scrollTop'])test('preview '+getter+' read exception is captured before tex.view',async t=>{
 const f=await fixture(t);await f.enter();f.preview();if(getter==='scrollTop')Object.defineProperty(f.node('secondary-scroll'),'scrollTop',{get(){throw Error('POSITION_GETTER_FAILED');},configurable:true});else f.beside.pdf[getter]=()=>{throw Error('POSITION_GETTER_FAILED');};
 const result=await f.workspace.persistChecked();assert.equal(result.error.code,'TEX_POSITION_FAILED');assert.equal(result.error.message,'POSITION_GETTER_FAILED');assert.equal(f.calls.filter(c=>c.op==='tex.view').length,0);assertNoSideEffects(f);
});
test('context-read failure is an explicit error, not false not-applicable',async t=>{
 const f=await fixture(t);f.contextError=Error('CONTEXT_GETTER_FAILED');const result=await f.workspace.persistChecked();assert.equal(result.ok,false);assert.equal(result.error.code,'TEX_CONTEXT_FAILED');assert.equal(f.calls.length,0);f.contextError=null;
});
for(const replacement of ['leave','enter','project','source','root','engine','paneClosed'])test('await crossed '+replacement+' yields STALE_CONTEXT and old error cannot overwrite the current page',async t=>{
 const f=await fixture(t);await f.enter();const view=deferred();let first=true;f.handlers.set('tex.view',()=>{if(first){first=false;return view.promise;}return {ok:true,value:{}};});const saving=f.workspace.persistChecked();
 if(replacement==='leave')f.workspace.leave();
 if(replacement==='enter')await f.enter();
 if(replacement==='project')f.context={project:{id:'project-b'},file:{relPath:'main.tex'}};
 if(replacement==='source')f.context={project:{id:'project-a'},file:{relPath:'other.tex'}};
 if(replacement==='root')await f.changeRoot('other.tex');
 if(replacement==='engine'){f.node('tex-engine').value='pdflatex';await f.node('tex-engine').emit('change');}
 if(replacement==='paneClosed')f.workspace.paneClosed();
 f.node('tex-status').textContent='NEW_PAGE_STATUS';view.resolve({ok:false,error:{code:'OLD_SAVE_FAILED',message:'DO_NOT_SHOW_OLD_ERROR'}});const result=await saving;assert.equal(result.error.code,'STALE_CONTEXT');assert.equal(f.message(),'NEW_PAGE_STATUS');assertNoSideEffects(f);
});
test('configuration intent in flight blocks new save and invalidates older same-root receipt',async t=>{
 const f=await fixture(t);await f.enter();const save=deferred(),configure=deferred();f.handlers.set('tex.view',()=>save.promise);const old=f.workspace.persistChecked();f.handlers.set('tex.configure',()=>configure.promise);const changing=f.changeRoot('main.tex');assert.equal((await f.workspace.persistChecked()).error.code,'TEX_CONTEXT_NOT_READY');save.resolve({ok:true,value:{}});assert.equal((await old).error.code,'STALE_CONTEXT');configure.resolve({ok:true,value:f.config});await changing;assertNoSideEffects(f);
});
test('root changed away and back cannot revive a receipt from the previous configuration epoch',async t=>{
 const f=await fixture(t);await f.enter();const oldView=deferred();f.handlers.set('tex.view',()=>oldView.promise);const old=f.workspace.persistChecked();await f.changeRoot('other.tex');await f.changeRoot('main.tex');oldView.resolve({ok:true,value:{}});assert.equal((await old).error.code,'STALE_CONTEXT');assertNoSideEffects(f);
});
test('old inspect reply after project mutation cannot bind the new source to the old TeX root',async t=>{
 const f=await fixture(t),inspect=deferred();f.handlers.set('tex.inspect',()=>inspect.promise);const entering=f.workspace.enter();f.context.project={id:'project-b'};f.context.file={relPath:'other.tex'};f.node('tex-status').textContent='NEW_PROJECT_STATUS';inspect.resolve({ok:false,error:{code:'OLD_INSPECT_FAILED',message:'OLD_INSPECT_ERROR'}});await entering;assert.equal(f.message(),'NEW_PROJECT_STATUS');assert.equal((await f.workspace.persistChecked()).error.code,'TEX_CONTEXT_NOT_READY');assertNoSideEffects(f);
});
test('legacy persist keeps successful Host value and handles business/transport/position errors without rejecting',async t=>{
 const f=await fixture(t);await f.enter();const saved=await f.workspace.persist();assert.deepEqual(saved,{persistedView:{page:2,zoom:1.25,scrollTop:40,preview:false,linked:true}});
 f.handlers.set('tex.view',()=>({ok:false,error:{code:'HOST_FAIL',message:'LEGACY_HOST_ERROR'}}));assert.equal(await f.workspace.persist(),undefined);assert.match(f.message(),/预览位置未保存：LEGACY_HOST_ERROR/);
 f.handlers.set('tex.view',()=>{throw Error('LEGACY_TRANSPORT_ERROR');});assert.equal(await f.workspace.persist(),undefined);assert.match(f.message(),/LEGACY_TRANSPORT_ERROR/);
 f.preview();f.beside.pdf.current=()=>{throw Error('LEGACY_POSITION_ERROR');};assert.equal(await f.workspace.persist(),undefined);assert.match(f.message(),/LEGACY_POSITION_ERROR/);assertNoSideEffects(f);
});
test('legacy save finishing after leave does not paint its stale error onto a new page',async t=>{
 const f=await fixture(t);await f.enter();const old=deferred();let once=true;f.handlers.set('tex.view',()=>once?(once=false,old.promise):({ok:true,value:{}}));const pending=f.workspace.persist();f.workspace.leave();f.node('tex-status').textContent='NEW_PAGE';old.reject(Error('LATE_TRANSPORT_ERROR'));assert.equal(await pending,undefined);assert.equal(f.message(),'NEW_PAGE');assertNoSideEffects(f);
});
test('legacy no-context persist and fire-and-forget paneClosed/leave remain rejection-safe',async t=>{
 const f=await fixture(t);assert.equal(await f.workspace.persist(),undefined);await f.enter();f.preview();f.beside.pdf.current=()=>{throw Error('LEAVE_POSITION_ERROR');};assert.doesNotThrow(()=>f.workspace.paneClosed());assert.doesNotThrow(()=>f.workspace.leave());await new Promise(r=>setImmediate(r));assertNoSideEffects(f);
});
test('current paneClosed still reports its own failed legacy position save without rejecting',async t=>{
 const f=await fixture(t);await f.enter();f.handlers.set('tex.view',()=>({ok:false,error:{code:'VIEW_FAILED',message:'CURRENT_PANE_SAVE_FAILED'}}));f.workspace.paneClosed();await new Promise(r=>setImmediate(r));assert.match(f.message(),/预览位置未保存：CURRENT_PANE_SAVE_FAILED/);assert.equal(f.calls.findLast(c=>c.op==='tex.view').args.view.preview,false);assertNoSideEffects(f);
});
test('failed inferred-root initialization cannot authorize a checked save merely because active was allocated',async t=>{
 const f=await fixture(t);f.handlers.set('tex.inspect',()=>({ok:true,value:{config:f.config,configuredRoot:null,texFiles:['main.tex'],tools:{xelatex:true},state:{phase:'idle'},view:{preview:false}}}));f.handlers.set('tex.configure',()=>({ok:false,error:{code:'CONFIG_FAILED',message:'INFERRED_ROOT_NOT_CONFIRMED'}}));await f.enter();assert.equal((await f.workspace.persistChecked()).error.code,'TEX_CONTEXT_NOT_READY');assert.equal(f.calls.filter(c=>c.op==='tex.view').length,0);assertNoSideEffects(f);
});
test('uncertain root configuration blocks checked persistence until an explicit successful configuration',async t=>{
 const f=await fixture(t);await f.enter();f.handlers.set('tex.configure',()=>{throw Error('CONFIG_REPLY_LOST');});await f.changeRoot('other.tex');assert.equal((await f.workspace.persistChecked()).error.code,'TEX_CONTEXT_NOT_READY');assert.equal(f.calls.filter(c=>c.op==='tex.view').length,0);f.handlers.delete('tex.configure');await f.changeRoot('other.tex');assert.deepEqual(await f.workspace.persistChecked(),{ok:true,value:{applicable:true,projectId:'project-a',root:'other.tex'}});assertNoSideEffects(f);
});
