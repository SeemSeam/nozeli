import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeReviewDiscussionManager,runReviewDiscard} from '../src/main/native-review-discussion.mjs';
import {EventEmitter} from 'node:events';
import {WorkspaceNative} from '../src/main/workspace-native.mjs';
function fixture(){
 const workspace={lifecycle:new Set(),lifecycleFlushOwner:()=>null};
 const manager=new NativeReviewDiscussionManager({workspace});
 const owner={wc:{id:1},generation:3,dead:false};
 const row={owner,ownerGeneration:3,projectId:'p',workId:'work',objectId:'object',ownerSurfaceId:'report',win:{isDestroyed:()=>false}};
 const record={role:'review-discussion',discussionRow:row,dead:false};row.record=record;manager.rows.set(1,row);
 return {workspace,manager,row,record,owner};
}
test('native child only reads/writes its bound discussion and geometry',()=>{
 const {manager,record,owner}=fixture(),binding={projectId:'p',workId:'work',objectId:'object'};
 assert.equal(manager.authorize(record,'managed.review.instruction.save',binding),record);
 for(const op of ['workspace.review.decide','workspace.review.prepareDiscard','workspace.review.discard','managed.end','file.save','project.open','workspace.command'])assert.throws(()=>manager.authorize(record,op,binding),{code:'REVIEW_SCOPE_DENIED'});
 for(const changed of [{projectId:'other'},{workId:'other'},{objectId:'other'}])assert.throws(()=>manager.authorize(record,'managed.review.instruction.save',{...binding,...changed}),{code:'REVIEW_SCOPE_DENIED'});
 owner.generation++;assert.throws(()=>manager.authorize(record,'workspace.bootstrap',{}),{code:'REVIEW_SCOPE_DENIED'});
});
test('native original-reader authority is only the IDs actually disclosed by its Work',()=>{
 const {manager,record}=fixture();manager.capture(record,'managed.review.discussion.read',{workId:'work',objectId:'object',taskFrame:{entries:[{id:'allowed'}]}});
 assert.equal(manager.authorize(record,'managed.timeline.read',{projectId:'p',id:'allowed'}),record);
 assert.throws(()=>manager.authorize(record,'managed.timeline.read',{projectId:'p',id:'other-work'}),{code:'REVIEW_SCOPE_DENIED'});
});
test('disclosure rejects stale ownership and other Work frames; navigation only routes reports',async()=>{
 const {manager,record,row,workspace,owner}=fixture();
 manager.capture(record,'managed.review.discussion.read',{workId:'foreign',objectId:'object',taskFrame:{entries:[{id:'foreign'}]}});
 assert.throws(()=>manager.authorize(record,'managed.timeline.read',{projectId:'p',id:'foreign'}),{code:'REVIEW_SCOPE_DENIED'});
 const sent=[],wrong=[];owner.windowId='shell';record.windowId='detached';
 const root={projectId:'p',ready:true,wc:{send:(...args)=>sent.push(args)},win:{isFocused:()=>false}};
 row.win.getParentWindow=()=>root.win;
 row.win.isFocused=()=>false;
 workspace.windows=new Map([['detached',root],['shell',{...root,wc:{send:(...args)=>wrong.push(args)}}]]);workspace.flushOne=async()=>{};
 workspace.openTaskProcess=async()=>{throw Error('process split must not open from the review child');};
 manager.capture(record,'managed.review.discussion.read',{workId:'work',objectId:'object',taskFrame:{entries:[]},taskState:{receipts:[{workId:'work',objectId:'object',revision:1,kind:'result'},{workId:'foreign',objectId:'foreign',kind:'result'}]}});
 await manager.invoke(record,'workspace.reviewDiscussion.navigate',{projectId:'p',workId:'work',kind:'report',objectId:'object'});
 assert.equal(sent[0][1].report.objectId,'object');assert.equal(row.objectId,'object');
 assert.deepEqual(wrong,[]);
 await assert.rejects(manager.invoke(record,'workspace.reviewDiscussion.navigate',{projectId:'p',workId:'work',kind:'report',objectId:'foreign'}),{code:'REVIEW_SCOPE_DENIED'});
 // The inline process contract replaced the old split exit: process kind is
 // gone from navigation entirely, so no click can create a view or window.
 await assert.rejects(manager.invoke(record,'workspace.reviewDiscussion.navigate',{projectId:'p',workId:'work',kind:'process'}),{code:'REVIEW_SCOPE_DENIED'});
 await assert.rejects(manager.invoke(record,'workspace.reviewDiscussion.navigate',{projectId:'p',workId:'work',kind:'report',objectId:'object',messageId:'m1'}),{code:'REVIEW_SCOPE_DENIED'});
 assert.equal(sent.length,1);
 owner.generation++;manager.capture(record,'managed.review.discussion.read',{workId:'work',objectId:'object',taskFrame:{entries:[{id:'stale'}]}});
 assert.equal(row.originalIds.has('stale'),false);
});
test('presentation accepts only visible bound messages and never a different report or hidden child',()=>{
 const {manager,record,row,owner}=fixture(),parent={isMinimized:()=>false,isVisible:()=>true,isFocused:()=>true};
 owner.win=parent;owner.projectId='p';owner.view={getVisible:()=>true};row.requested=true;row.win.getParentWindow=()=>parent;row.win.isVisible=()=>true;
 manager.workspace.layouts=new Map();manager.workspace.reviewReportOwns=()=>true;
 row.launcher={owner,kind:'report',generation:owner.generation,projectId:'p',workId:row.workId,objectId:row.objectId};
 manager.capture(record,'managed.review.discussion.read',{workId:'work',objectId:'object',taskFrame:{entries:[{id:'message'}]}});
 const payload={projectId:'p',objectId:'object',messageId:'message'};
 assert.equal(manager.authorize(record,'workspace.attention.presented',payload),record);
 for(const mismatch of [{projectId:'other'},{objectId:'new-report'},{messageId:'other-thread'}])assert.throws(()=>manager.authorize(record,'workspace.attention.presented',{...payload,...mismatch}),{code:'REVIEW_SCOPE_DENIED'});
 row.win.isVisible=()=>false;assert.throws(()=>manager.authorize(record,'workspace.attention.presented',payload),{code:'REVIEW_SCOPE_DENIED'});row.win.isVisible=()=>true;
 row.suspended=true;assert.throws(()=>manager.authorize(record,'workspace.attention.presented',payload),{code:'REVIEW_SCOPE_DENIED'});
});
test('native pending send allows only exact receipt replay after a rebind',()=>{
 const {manager,record,row}=fixture(),payload={projectId:'p',workId:'work',objectId:'object',reviewVersion:'token',requestKey:'request',text:'one turn'};
 manager.authorize(record,'managed.review.discussion.send',payload);row.objectId='next';
 assert.equal(manager.authorize(record,'managed.review.discussion.send',payload),record);
 assert.throws(()=>manager.authorize(record,'managed.review.discussion.send',{...payload,text:'another turn'}),{code:'REVIEW_SCOPE_DENIED'});
 assert.throws(()=>manager.authorize(record,'managed.review.discussion.send',{...payload,applyDrafts:true}),{code:'REVIEW_SCOPE_DENIED'});
});
test('agent broadcasts disclose only fixed-scope invalidations to a review child',()=>{
 const {manager,record}=fixture(),child=[],normal=[];
 record.projectId='p';record.wc={send:(...args)=>child.push(args)};
 const native=Object.create(WorkspaceNative.prototype);native.reviewDiscussions=manager;
 native.senders=new Map([[1,record],[2,{projectId:'p',wc:{send:(...args)=>normal.push(args)}}]]);
 const event={kind:'managed-timeline',projectId:'p',state:{secret:'OTHER WORK'},timeline:{entries:[{text:'PRIVATE'}]}};
 native.broadcast('nozeli:agent',event,'p');
 assert.deepEqual(child,[['nozeli:agent',{kind:'managed-timeline',projectId:'p',workId:'work'}]]);
 assert.equal(normal[0][1],event);
 native.broadcast('nozeli:agent',{...event,workId:'foreign'},'p');
 native.broadcast('nozeli:agent',{...event,projectId:'foreign'});
 assert.equal(child.length,1);
});
test('frozen material reads use only the exact disclosed attachment and original Work',async()=>{
 const {manager,record,workspace}=fixture();
 const attachment={projectId:'p',storage:'project',digest:'a'.repeat(64),source:'source-1',mime:'text/plain'};
 let read=null;workspace.host={readMaterialAttachment:async ref=>{read=ref;return {bytes:'c2FtcGxl',mime:ref.mime};}};
 manager.capture(record,'managed.review.discussion.read',{workId:'work',objectId:'object',taskFrame:{entries:[{id:'real',attachments:[attachment,{...attachment,projectId:'foreign'}]}]},taskState:{hostFacts:[{id:'invented'}]}});
 const payload={projectId:'p',workId:'work',messageId:'real',index:0};
 const value=await manager.invoke(record,'workspace.reviewDiscussion.materialRead',payload);
 assert.equal(value.bytes,'c2FtcGxl');assert.deepEqual(read,attachment);
 for(const change of [{workId:'foreign'},{messageId:'invented'},{index:1},{index:2},{digest:'b'.repeat(64)}])await assert.rejects(manager.invoke(record,'workspace.reviewDiscussion.materialRead',{...payload,...change}),{code:'REVIEW_SCOPE_DENIED'});
 assert.throws(()=>manager.authorize(record,'managed.timeline.read',{projectId:'p',id:'invented'}),{code:'REVIEW_SCOPE_DENIED'});
});
test('native lifecycle save requires the actual pending flush receipt',()=>{
 const {manager,workspace,record}=fixture(),payload={projectId:'p',workId:'work',objectId:'object'};workspace.lifecycle.add('p');
 assert.throws(()=>manager.authorize(record,'managed.review.instruction.save',payload),{code:'REVIEW_SCOPE_DENIED'});
 workspace.lifecycleFlushOwner=(_record,id)=>id==='real-flush';
 assert.equal(manager.authorize(record,'managed.review.instruction.save',{...payload,flushRequestId:'real-flush'}),record);
});
function discardFixture({failSave=false,changeBinding=false,loseResponse=false}={}){
 const log=[],binding={objectId:'object',revision:2,reviewVersion:'version'},capability={binding,discard:{allowed:true}},scope={role:'surface',kind:'report',projectId:'p'};
 let saved=false;
 const work={status:'review',outcome:null,closure:null};let lost=false;
 const workspace={reviewReportOwns:()=>true,async runReviewBarrier(projectId,detail,run){log.push(['flush',detail]);if(failSave)throw Object.assign(Error('IME active'),{code:'COMPOSING'});saved=true;return run();}};
 const managed={controllers:new Map([['p',{store:{find:()=>work}}]]),async invoke(op,payload){log.push([op,payload]);if(op==='managed.disposition')return changeBinding&&saved?{...capability,binding:{...binding,reviewVersion:'changed'}}:['closing','ended'].includes(work.status)?{...capability,discard:{allowed:false,message:'决定已记录'}}:capability;if(op==='managed.review.read')return {files:[{relPath:'draft.md'}]};if(op==='managed.end'){work.status='closing';work.outcome=payload.decision;work.closure={decision:payload.decision,binding:payload.binding,requestKey:payload.requestKey};if(loseResponse&&!lost){lost=true;throw Error('response lost');}return {accepted:true,status:work.status,outcome:work.outcome,closure:work.closure};}throw Error(op);}};
 return {workspace,managed,scope,log,binding,work,payload:{projectId:'p',workId:'work',objectId:'object',revision:2}};
}
test('discard preparation flushes associated documents before exposing confirmation binding',async()=>{
 const f=discardFixture();const value=await runReviewDiscard({...f,prepare:true});assert.equal(value.binding,f.binding);
 const flush=f.log.findIndex(([op])=>op==='flush');assert.deepEqual(f.log[flush][1].paths,['draft.md']);assert.equal(f.log[flush+1][0],'managed.disposition');assert.equal(f.log.some(([op])=>op==='managed.end'),false);
});
test('discard submission flushes again and uses its own exact end protocol',async()=>{
 const f=discardFixture();await runReviewDiscard({...f,payload:{...f.payload,binding:f.binding,requestKey:'same-discard-request'}});
 const ended=f.log.find(([op])=>op==='managed.end');assert.deepEqual(ended[1],{projectId:'p',workId:'work',binding:f.binding,requestKey:'same-discard-request',revision:2,decision:'discard'});assert.ok(f.log.findIndex(([op])=>op==='flush')<f.log.indexOf(ended));
});
test('discard cannot bypass failed document composition or save-time binding changes',async()=>{
 for(const [options,code]of [[{failSave:true},'COMPOSING'],[{changeBinding:true},'REVIEW_TOKEN_CHANGED']]){const f=discardFixture(options);await assert.rejects(runReviewDiscard({...f,payload:{...f.payload,binding:f.binding,requestKey:'same-discard-request'}}),{code});assert.equal(f.log.some(([op])=>op==='managed.end'),false);}
 const f=discardFixture();await assert.rejects(runReviewDiscard({...f,scope:{...f.scope,role:'review-discussion'},prepare:true}),{code:'REVIEW_SCOPE_DENIED'});
});
test('lost discard response replays the exact recorded key and binding without another save or decision',async()=>{
 const f=discardFixture({loseResponse:true}),payload={...f.payload,binding:f.binding,requestKey:'same-discard-request'};
 await assert.rejects(runReviewDiscard({...f,payload}),/response lost/);const before=f.log.length;
 const replay=await runReviewDiscard({...f,payload});assert.equal(replay.accepted,true);assert.equal(replay.outcome,'discard');assert.deepEqual(f.log.slice(before).map(([op])=>op),['managed.end']);
 for(const changed of [{requestKey:'different-request'},{binding:{...f.binding,revision:3}}])await assert.rejects(runReviewDiscard({...f,payload:{...payload,...changed}}),{code:'WORK_DISCARD_RECEIPT_MISMATCH'});
 f.work.outcome=f.work.closure.decision='accept';await assert.rejects(runReviewDiscard({...f,payload}),{code:'WORK_DISCARD_RECEIPT_MISMATCH'});
});
function failingCreateFixture(ready){
 const windows=[],parent=new EventEmitter();parent.getContentBounds=()=>({x:0,y:0,width:1000,height:800});
 class Window extends EventEmitter{constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.webContents.setZoomFactor=()=>{};windows.push(this);}isDestroyed(){return this.destroyed===true;}hide(){}async loadURL(){throw Error('load failed');}destroy(){this.destroyed=true;this.emit('closed');}}
 const wc=new EventEmitter();wc.id=1;wc.getZoomFactor=()=>1;
 const owner={role:'surface',kind:'report',projectId:'p',viewId:'report',windowId:'main',wc,win:parent,generation:1};
 const workspace={layouts:new Map([['p',{views:{report:{viewState:{report:{workId:'work'}}}}}]]),reviewReportOwns:()=>true,register(wc,scope){return {...scope,wc,ready,dead:false};}};
 return {manager:new NativeReviewDiscussionManager({workspace,BrowserWindow:Window,managed:{reportSource:async(_id,objectId)=>({workId:'work',objectId})}}),owner,windows,payload:{projectId:'p',workId:'work',objectId:'object'}};
}
test('failed cold create removes the non-interactive row so a later open can retry',async()=>{
 const f=failingCreateFixture(false);for(let attempt=0;attempt<2;attempt++){await assert.rejects(f.manager.create(f.owner,f.payload),/load failed/);assert.equal(f.manager.rows.size,0);}assert.equal(f.windows.length,2);assert.equal(f.windows.every(win=>win.isDestroyed()),true);
});
test('a failed load after business readiness retains the live draft owner',async()=>{
 const f=failingCreateFixture(true);await assert.rejects(f.manager.create(f.owner,f.payload),/load failed/);assert.equal(f.manager.rows.size,1);assert.equal(f.windows[0].isDestroyed(),false);
});
test('native host reports parent CSS coordinates and applies only final DIP client bounds',async()=>{
 const f=fixture(),parent={getContentBounds:()=>({x:200,y:100,width:1200,height:900})};let applied=null;
 f.owner.wc.getZoomFactor=()=>1.5;f.owner.wc.focus=()=>{};f.owner.view={getBounds:()=>({x:100,y:60,width:900,height:600})};
 f.row.epoch=1;f.row.sequence=0;f.row.requested=false;f.record.generation=1;f.record.wc={getZoomFactor:()=>1.5};
 f.row.win={isDestroyed:()=>false,getParentWindow:()=>parent,setContentBounds:rect=>{applied=rect;},getContentBounds:()=>applied,hide(){}};
 const geometry=f.manager.geometry(f.row);assert.deepEqual(geometry,{bounds:{x:0,y:0,width:600,height:400},origin:{x:300,y:160},zoomFactor:1.5,epoch:1});
 f.row.geometrySignature=JSON.stringify([geometry.bounds,geometry.origin,geometry.zoomFactor]);
 const result=await f.manager.invoke(f.record,'workspace.reviewDiscussion.bounds',{generation:1,epoch:1,sequence:1,visible:false,rect:{x:330,y:205,width:630,height:54}});
 assert.deepEqual(result.contentBounds,{x:330,y:205,width:630,height:54});assert.deepEqual(applied,result.contentBounds);
});

test('owned review child may copy but cannot read clipboard or delegate to foreign frames',()=>{
 const {manager,record,owner}=fixture(),native=Object.create(WorkspaceNative.prototype);
 const origin='app://trusted/',wc={id:9,isDestroyed:()=>false,mainFrame:{url:origin}};
 native.origin=origin;native.reviewDiscussions=manager;native.senders=new Map([[9,record]]);
 const details={isMainFrame:true,requestingUrl:origin};
 assert.equal(native.allowClipboardWrite(wc,'clipboard-sanitized-write',details),true);
 assert.equal(native.allowClipboardWrite(wc,'clipboard-read',details),false);
 assert.equal(native.allowClipboardWrite(wc,'clipboard-sanitized-write',{...details,isMainFrame:false}),false);
 assert.equal(native.allowClipboardWrite(wc,'clipboard-sanitized-write',{...details,requestingUrl:'https://foreign.test/'}),false);
 wc.mainFrame.url='https://foreign.test/';assert.equal(native.allowClipboardWrite(wc,'clipboard-sanitized-write',details),false);wc.mainFrame.url=origin;
 owner.dead=true;assert.equal(native.allowClipboardWrite(wc,'clipboard-sanitized-write',details),false);
});

function processFixture(){
 const {workspace,manager,row,record,owner}=fixture();record.projectId='p';
 const rows=[{id:'m1',sequence:1,native:{id:'m1'}},{id:'m2',sequence:2,native:{id:'m2'}},{id:'foreign',sequence:3,native:{id:'foreign',workId:'other'}}];
 const scope={key:'k'.repeat(64),matches:candidate=>{const row=candidate?.native??candidate;return Boolean(row)&&row.workId!=='other';}};
 const index={
  ordered:()=>rows,
  select:(cursor,limit)=>rows.filter(item=>item.sequence<Number(cursor.slice(cursor.lastIndexOf(':')+1))).slice(-limit),
  records:()=>rows,
  async page({cursor,limit,workId}){
   const prefix='scope:'+scope.key+':before:';
   if(cursor!==undefined&&cursor!==null&&(typeof cursor!=='string'||!cursor.startsWith(prefix)||!/^[0-9]+$/.test(cursor.slice(prefix.length))))throw Object.assign(Error('Invalid or mismatched history cursor'),{code:'TIMELINE_PAGE'});
   const selected=index.select(cursor??(prefix+'999'),limit??50);
   return {version:1,entries:selected.filter(row=>scope.matches(row)).map(row=>({id:row.id,attachments:[]})),deltas:[],hasMore:false,nextCursor:null};
  }
 };
 const calls={command:0,openTaskProcess:0,control:0};
 workspace.taskSource=async(projectId,taskScope)=>{assert.equal(projectId,'p');assert.deepEqual(taskScope,{workId:'work'});return {index,scope};};
 workspace.taskLocateCursor=WorkspaceNative.prototype.taskLocateCursor;
 workspace.command=async()=>{calls.command++;throw Error('process reads never change layout');};
 workspace.openTaskProcess=async()=>{calls.openTaskProcess++;throw Error('process reads never open a split');};
 return {workspace,manager,row,record,owner,index,scope,calls};
}
test('processRead returns the original frame, locates the exact record and captures reading authority without layout writes',async()=>{
 const {manager,record,row,calls}=processFixture();
 const value=await manager.invoke(record,'workspace.reviewDiscussion.processRead',{projectId:'p',workId:'work',messageId:'m2'});
 assert.deepEqual(Object.keys(value).sort(),['frame','location','taskScope']);
 assert.deepEqual(value.taskScope,{workId:'work',sourceJobId:null});
 assert.deepEqual(value.frame.entries.map(entry=>entry.id),['m1','m2']);
 assert.equal(value.location.messageId,'m2');
 assert.equal(value.location.cursor,'scope:'+'k'.repeat(64)+':before:3');
 // Delivered process ids become original/material readable, foreign ids stay closed.
 assert.equal(manager.authorize(record,'managed.timeline.read',{projectId:'p',id:'m1'}),record);
 assert.throws(()=>manager.authorize(record,'managed.timeline.read',{projectId:'p',id:'foreign'}),{code:'REVIEW_SCOPE_DENIED'});
 const paged=await manager.invoke(record,'workspace.reviewDiscussion.processRead',{projectId:'p',workId:'work',cursor:value.frame.nextCursor??value.location.cursor,limit:1});
 assert.equal('location' in paged,false);
 assert.deepEqual(paged.frame.entries.map(entry=>entry.id),['m2']);
 assert.equal(calls.command,0);assert.equal(calls.openTaskProcess,0);
});
test('processRead rejects foreign Work, broadened payloads, invalid cursors, limits and unknown records',async()=>{
 const {manager,record}=processFixture();
 const base={projectId:'p',workId:'work'};
 for(const change of [{projectId:'other'},{workId:'other'},{sourceJobId:'job'},{limit:101},{limit:0},{cursor:5},{cursor:'before:1'},{messageId:'missing'},{messageId:'foreign'}])
  await assert.rejects(manager.invoke(record,'workspace.reviewDiscussion.processRead',{...base,...change}),error=>['REVIEW_SCOPE_DENIED','TIMELINE_SCOPE','TIMELINE_PAGE'].includes(error.code));
 await assert.rejects(manager.invoke(record,'workspace.reviewDiscussion.processRead',{projectId:'p',workId:'work',messageId:'m2',extra:1}),{code:'REVIEW_SCOPE_DENIED'});
});
test('exportOriginal only saves disclosed originals through the controlled host dialog',async t=>{
 const root=await import('node:fs/promises').then(async fs=>fs.mkdtemp((await import('node:os')).tmpdir()+'/nozeli-review-export-'));
 t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(root,{recursive:true,force:true}));});
 const fs=await import('node:fs/promises'),os=await import('node:os'),crypto=await import('node:crypto');
 const bytes=Buffer.from(JSON.stringify({id:'m1',original:true}));
 const objectId=crypto.createHash('sha256').update(bytes).digest('hex');
 await fs.writeFile(root+'/'+objectId+'.json',bytes);
 const {manager,record,row}=processFixture();
 const rows=[{id:'m1',sequence:1,native:{id:'m1'},objectId}];
 const index={records:()=>rows,ordered:()=>rows,select:()=>rows,async page(){return {version:1,entries:[{id:'m1',attachments:[]}],deltas:[],hasMore:false,nextCursor:null};}};
 manager.workspace.taskSource=async()=>({index,scope:{key:'k'.repeat(64),matches:()=>true}});
 manager.managed={projectionSource:async()=>({index:{records:()=>rows,root}})};
 const dialogCalls=[];manager.dialog={showSaveDialog:async(win,options)=>{dialogCalls.push(options);return {canceled:false,filePath:root+'/saved.json'};}};
 // Undisclosed or malformed ids never reach the dialog at all.
 for(const change of [{id:'undisclosed'},{id:'m1',version:'not-hex'},{projectId:'other'},{workId:'other'}])
  await assert.rejects(manager.invoke(record,'workspace.reviewDiscussion.exportOriginal',{projectId:'p',workId:'work',id:'m1',version:objectId,...change}),{code:'REVIEW_SCOPE_DENIED'});
 assert.equal(dialogCalls.length,0);
 manager.captureFrame(row,{entries:[{id:'m1',attachments:[]}]});
 await assert.rejects(manager.invoke(record,'workspace.reviewDiscussion.exportOriginal',{projectId:'p',workId:'work',id:'m1',version:'0'.repeat(64)}),{code:'TIMELINE_VERSION'});
 const saved=await manager.invoke(record,'workspace.reviewDiscussion.exportOriginal',{projectId:'p',workId:'work',id:'m1',version:objectId});
 assert.deepEqual(saved,{exported:true,byteLength:bytes.length});
 assert.equal((await fs.readFile(root+'/saved.json')).equals(bytes),true);
 manager.dialog={showSaveDialog:async()=>({canceled:true})};
 assert.deepEqual(await manager.invoke(record,'workspace.reviewDiscussion.exportOriginal',{projectId:'p',workId:'work',id:'m1',version:objectId}),{cancelled:true});
});
test('readingState persists bounded disclosures behind its own record CAS and lifecycle gate',async()=>{
 const {manager,record,workspace}=processFixture();
 const local=new Map();
 const storage={requireRegistered:async()=>({instanceId:'inst-1'}),getLocal:async(_project,key)=>local.get(key)??null,putLocal:async(_project,key,value)=>{local.set(key,value);return {ok:true};}};
 workspace.host={storage};
 assert.deepEqual(await manager.invoke(record,'workspace.reviewDiscussion.readingState.read',{projectId:'p',workId:'work'}),{state:null});
 const disclosures={'m1':true,'m2':{cursor:'scope:'+'k'.repeat(64)+':before:3',read:{version:'a'.repeat(64),field:'text',offset:0}}};
 const written=await manager.invoke(record,'workspace.reviewDiscussion.readingState.write',{projectId:'p',workId:'work',expectedRevision:0,disclosures});
 assert.equal(written.revision,1);
 assert.deepEqual(await manager.invoke(record,'workspace.reviewDiscussion.readingState.read',{projectId:'p',workId:'work'}),{state:{schema:1,revision:1,disclosures}});
 assert.deepEqual(await manager.invoke(record,'workspace.reviewDiscussion.readingState.write',{projectId:'p',workId:'work',expectedRevision:0,disclosures:{}}),{conflict:true,current:{schema:1,revision:1,disclosures}});
 for(const bad of [undefined,{'m1':'yes'},{'m1':{history:true}},{...disclosures,m2:{read:{version:'zz',field:'text',offset:0}}},Object.fromEntries(Array.from({length:401},(_,i)=>['id'+i,true]))])
  await assert.rejects(manager.invoke(record,'workspace.reviewDiscussion.readingState.write',{projectId:'p',workId:'work',expectedRevision:1,disclosures:bad}),{code:'INVALID_PAYLOAD'});
 await assert.rejects(manager.invoke(record,'workspace.reviewDiscussion.readingState.write',{projectId:'p',workId:'work',expectedRevision:1,disclosures,extra:1}),{code:'INVALID_PAYLOAD'});
 workspace.lifecycle.add('p');
 assert.throws(()=>manager.authorize(record,'workspace.reviewDiscussion.readingState.write',{projectId:'p',workId:'work',expectedRevision:1,disclosures}),{code:'REVIEW_SCOPE_DENIED'});
 workspace.lifecycleFlushOwner=(_r,id)=>id==='flush-1';
 assert.equal(manager.authorize(record,'workspace.reviewDiscussion.readingState.write',{projectId:'p',workId:'work',expectedRevision:1,disclosures,flushRequestId:'flush-1'}),record);
 assert.equal(manager.authorize(record,'workspace.reviewDiscussion.readingState.read',{projectId:'p',workId:'work'}),record);
 const next=await manager.invoke(record,'workspace.reviewDiscussion.readingState.write',{projectId:'p',workId:'work',expectedRevision:1,disclosures:{m1:false},flushRequestId:'flush-1'});
 assert.equal(next.revision,2);
 // Corrupted stored shape is reported, never silently rewritten.
 local.set('reading-state:'+JSON.stringify({projectInstanceId:'inst-1',ownerKind:'review',ownerId:'work',surfaceId:'report'}),{state:{schema:1,revision:9,disclosures:{bad:'shape'}}});
 await assert.rejects(manager.invoke(record,'workspace.reviewDiscussion.readingState.write',{projectId:'p',workId:'work',expectedRevision:9,disclosures}),{code:'DISPLAY_SCHEMA_UNKNOWN'});
});

function workWindowFixture(){
 const created=[],sent=[],commands=[],local=new Map();let nativeId=20,focused=null;
 const contents=id=>Object.assign(new EventEmitter(),{id,zoom:1,focusCount:0,getZoomFactor(){return this.zoom;},setZoomFactor(value){this.zoom=value;},setWindowOpenHandler(){},send(channel,payload){sent.push({id,channel,payload});},focus(){this.focusCount++;}});
 function focus(win){const old=focused;if(old===win)return;focused=win;old?.emit('blur');win?.emit('focus');}
 const root=()=>Object.assign(new EventEmitter(),{visible:true,minimized:false,isVisible(){return this.visible;},isMinimized(){return this.minimized;},isFocused(){return focused===this;},getContentBounds:()=>({x:0,y:0,width:1000,height:720})});
 const parent=root();focus(parent);
 class Window extends EventEmitter{
  constructor(options){super();this.parent=options.parent;this.webContents=contents(nativeId++);this.visible=false;created.push(this);}
  async loadURL(){} getParentWindow(){return this.parent;} setParentWindow(parent){this.parent=parent;}
  static getFocusedWindow(){return focused;}
  hide(){if(!this.visible)return;this.visible=false;if(this.isFocused())focus(this.parent.isVisible()&&!this.parent.isMinimized()?this.parent:null);this.emit('hide');}
  showInactive(){if(this.visible||this.refuseShow)return;this.visible=true;this.emit('show');}
  show(){this.showCount=(this.showCount??0)+1;this.showInactive();if(this.visible)this.focus();}
  isVisible(){return this.visible;} focus(){if(this.visible)focus(this);} isFocused(){return focused===this;}
  setContentBounds(rect){this.bounds=rect;} getContentBounds(){return this.bounds;}
  isDestroyed(){return !!this.destroyed;} destroy(){this.destroyed=true;this.emit('closed');}
 }
 const shell={role:'shell',projectId:'p',windowId:'main',wc:contents(1),generation:4,win:parent};
 const report={...shell,role:'surface',kind:'report',viewId:'report',wc:contents(2),view:{getVisible:()=>true,getBounds:()=>({x:100,y:24,width:800,height:600})}};
 const history={...report,kind:'history',viewId:'history',wc:contents(3)};
 const reportBinding={workId:'work',objectId:'object'};
 const storage={requireRegistered:async id=>({instanceId:'instance-'+id}),getLocal:async(_id,key)=>local.get(key),putLocal:async(_id,key,value)=>local.set(key,value)};
 const workspace={shell,lifecycle:new Set(),reviewBarriers:new Set(),host:{storage},windows:new Map([['main',shell]]),layouts:new Map([['p',{views:{report:{viewState:{report:reportBinding}},history:{viewState:{report:{...reportBinding,history:true}}}}}]]),
  reviewReportOwns(owner,objectId){return this.layouts.get(owner.projectId)?.views[owner.viewId]?.viewState.report.objectId===objectId;},
  register(wc,scope){return {...scope,wc,ready:true,generation:1};},
  async flushOne(record,channel,detail){
   commands.push({record,channel,detail});
   if(detail?.action==='show'||detail?.action==='hide')await publishBounds(record,detail.action==='show');
  }
 };
 const managed={async projectionSource(){return {state:{works:[{id:'work',name:'Existing work'},{id:'another'}]}};},async invoke(op,payload){assert.equal(op,'managed.review.read');return {...payload,reviewVersion:'a'.repeat(64)};}};
 managed.reportSource=async(_projectId,objectId)=>({workId:'work',objectId});
 const manager=new NativeReviewDiscussionManager({workspace,BrowserWindow:Window,managed}),binding={projectId:'p',workId:'work'},reportPayload={...binding,objectId:'object'};
 const invoke=(owner,action,payload)=>manager.invoke(owner,'workspace.reviewDiscussion.'+action,payload);
 function publishBounds(record,visible){
  const row=record.discussionRow,geometry=manager.geometry(row);
  return invoke(record,'bounds',{generation:record.generation,epoch:geometry.epoch,sequence:row.sequence+1,visible,rect:{...geometry.origin,width:150,height:180}});
 }
 return {manager,workspace,created,sent,commands,shell,report,history,binding,reportPayload,invoke,root,parent,focus,publishBounds,reportBinding};
}
test('intake discussion cannot read another request or send to the shared Orchestrator',async()=>{
 const f=workWindowFixture(),sourceJobId='request-a',binding={projectId:'p',workId:sourceJobId};
 const jobs=[{id:sourceJobId,type:'intake',target:'orchestrator',status:'running',text:'Request A'},{id:'request-b',type:'intake',target:'orchestrator',status:'running',text:'Request B'}];
 f.workspace.taskSource=async(_projectId,scope)=>{
  assert.deepEqual(scope,{sourceJobId});
  return {state:{jobs},scope:{matches:entry=>entry.jobId===sourceJobId},index:{page:async()=>({version:1,entries:[{id:'reply-a',jobId:sourceJobId}],deltas:[]})}};
 };
 await Promise.all([f.invoke(f.shell,'intakeShow',{projectId:'p',sourceJobId}),f.invoke(f.shell,'intakeShow',{projectId:'p',sourceJobId})]);
 assert.equal(f.created.length,1);
 const [child]=f.manager.workRecords('p');
 const result=await f.invoke(child,'intakeRead',binding);
 assert.deepEqual(result.taskState.jobs.map(j=>j.id),[sourceJobId]);
 f.manager.authorize(child,'managed.timeline.read',{projectId:'p',id:'reply-a'});
 assert.throws(()=>f.manager.authorize(child,'managed.timeline.read',{projectId:'p',id:'reply-b'}),{code:'REVIEW_SCOPE_DENIED'});
 await assert.rejects(f.invoke(child,'intakeRead',{...binding,workId:'request-b'}),{code:'REVIEW_SCOPE_DENIED'});
 for(const op of ['managed.send','managed.work.chat.send','managed.review.instruction.save','workspace.reviewDiscussion.latest'])assert.throws(()=>f.manager.authorize(child,op,binding),{code:'REVIEW_SCOPE_DENIED'});
});
test('shell and matching report reuse one Work window, but history never acquires that scope',async()=>{
 const f=workWindowFixture();
 await f.invoke(f.history,'show',f.reportPayload);
 const history=f.manager.rowForOwner(f.history),oldBootstrap=f.manager.bootstrap(history.record);
 assert.equal(oldBootstrap.workMode,false);assert.equal(oldBootstrap.readOnly,true);
 f.focus(f.parent);
 await Promise.all([f.invoke(f.shell,'workShow',f.binding),f.invoke(f.shell,'workShow',f.binding)]);
 assert.equal(f.created.length,2);
 const [record]=f.manager.workRecords('p','work'),row=record.discussionRow;
 const scope=f.manager.bootstrap(record);
 assert.equal(scope.workMode,true);assert.equal(scope.objectId,null);assert.equal(scope.workName,'Existing work');
 await f.invoke(record,'readingState.write',{...f.binding,expectedRevision:0,disclosures:{m1:true}});
 f.focus(f.parent);
 await f.invoke(f.report,'show',f.reportPayload);
 assert.equal(f.created.length,2);assert.equal(row.owner,f.shell);
 assert.deepEqual(f.commands.at(-1).detail,{action:'show',objectId:'object',locatePublication:true});
 assert.equal(f.manager.bootstrap(record).geometry.origin.x,100);
 assert.equal(f.manager.bootstrap(record).ownerSurfaceId,scope.ownerSurfaceId);
 assert.deepEqual(await f.invoke(record,'readingState.read',f.binding),{state:{schema:1,revision:1,disclosures:{m1:true}}});
 await f.invoke(f.report,'hide',f.reportPayload);
 assert.deepEqual(f.sent.at(-1),{id:f.report.wc.id,channel:'nozeli:workspace-control',payload:{type:'review-discussion-focus',...f.reportPayload,launcher:'report'}});
 await f.invoke(f.shell,'workShow',f.binding);
 assert.deepEqual(f.commands.at(-1).detail,{action:'show',objectId:null});
 assert.equal(f.manager.bootstrap(record).objectId,null);assert.equal(f.manager.bootstrap(history.record).readOnly,true);
 assert.throws(()=>f.manager.authorize(history.record,'managed.work.chat.send',f.binding),{code:'REVIEW_SCOPE_DENIED'});
 assert.throws(()=>f.manager.authorize(history.record,'managed.review.instruction.save',f.reportPayload),{code:'REVIEW_SCOPE_DENIED'});
 await assert.rejects(f.invoke(f.report,'workShow',f.binding),{code:'REVIEW_SCOPE_DENIED'});
 await assert.rejects(f.invoke(f.shell,'workShow',{...f.binding,objectId:'object'}),{code:'REVIEW_SCOPE_DENIED'});
 f.shell.projectId='other';f.manager.refreshWorkWindows();assert.equal(row.win.isVisible(),false);
 assert.throws(()=>f.manager.authorize(record,'managed.work.chat.read',f.binding),{code:'REVIEW_SCOPE_DENIED'});
});
test('native Work mutation is fixed to its Work and exact report sends retain their lane',async()=>{
 const f=workWindowFixture();await f.invoke(f.shell,'workShow',f.binding);
 const [record]=f.manager.workRecords('p','work'),authorize=(op,payload=f.binding)=>f.manager.authorize(record,op,payload);
 for(const op of ['managed.work.chat.read','managed.work.chat.send','managed.work.chat.retract','managed.work.chat.dispatch']){
  assert.equal(authorize(op),record);
  assert.throws(()=>authorize(op,{...f.binding,workId:'another'}),{code:'REVIEW_SCOPE_DENIED'});
 }
 for(const op of ['managed.send','managed.chat.dispatch','managed.review.discussion.send','workspace.review.decide'])assert.throws(()=>authorize(op),{code:'REVIEW_SCOPE_DENIED'});
 assert.equal(authorize('managed.review.instruction.save',{...f.binding,objectId:null}),record);
 f.manager.capture(record,'managed.work.chat.read',{workId:'work',taskFrame:{entries:[{id:'disclosed'}]}});
 assert.equal(authorize('managed.timeline.read',{projectId:'p',id:'disclosed'}),record);
 await f.invoke(f.report,'show',f.reportPayload);
 assert.throws(()=>authorize('managed.work.chat.send'),{code:'REVIEW_SCOPE_DENIED'});
 const workReceipt={...f.binding,revision:3,requestKey:'before-report',text:'Question',lane:'next'};
 f.manager.managed.workChatReceipt=async payload=>{assert.deepEqual(payload,workReceipt);return {accepted:true,jobId:'original-job'};};
 assert.deepEqual(await f.invoke(record,'receipt',{...workReceipt,objectId:null}),{accepted:true,jobId:'original-job'});
 await assert.rejects(f.invoke(record,'receipt',{...workReceipt,objectId:null,workId:'another'}),{code:'REVIEW_SCOPE_DENIED'});
 f.manager.managed.workChatReceipt=async()=>null;
 assert.equal(await f.invoke(record,'receipt',{...workReceipt,objectId:null}),null);
 assert.equal(authorize('managed.work.chat.retract'),record);
 const exact={...f.reportPayload,reviewVersion:'a'.repeat(64),requestKey:'one-send',text:'Opinion',lane:'normal'};
 assert.equal(authorize('managed.review.discussion.send',exact),record);
 f.workspace.reviewBarriers.add({projectId:'p',workId:'work'});
 assert.throws(()=>authorize('managed.work.chat.dispatch'),{code:'REVIEW_SCOPE_DENIED'});
 assert.throws(()=>authorize('managed.review.discussion.send',exact),{code:'REVIEW_SCOPE_DENIED'});
 f.workspace.reviewBarriers.clear();await f.invoke(f.shell,'workShow',f.binding);
 assert.equal(authorize('managed.review.discussion.send',exact),record);
 assert.throws(()=>authorize('managed.review.discussion.send',{...exact,lane:'next'}),{code:'REVIEW_SCOPE_DENIED'});
});

const visibilityEvents=f=>f.sent.filter(event=>event.payload.type==='review-discussion-visibility').map(event=>event.payload.shown);
function pauseCommand(f,action){
 const flush=f.workspace.flushOne.bind(f.workspace);
 let reached,resume;
 const entered=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{resume=resolve;});
 f.workspace.flushOne=async(record,channel,detail)=>{
  await flush(record,channel,detail);
  if(detail?.action===action){f.workspace.flushOne=flush;reached(record);const error=await gate;if(error)throw error;}
 };
 return {entered,resume};
}

test('a stalled cold load times out, destroys only the unready child, and permits retry',async()=>{
 const f=workWindowFixture(),prototype=f.manager.BrowserWindow.prototype,load=prototype.loadURL;
 let finish;
 prototype.loadURL=()=>new Promise(resolve=>{finish=resolve;});
 f.workspace.register=(wc,scope)=>({...scope,wc,ready:false,generation:1});
 f.manager.openTimeoutMs=40;
 await assert.rejects(f.invoke(f.report,'show',f.reportPayload),{code:'REVIEW_OPEN_TIMEOUT',stage:'加载讨论页面'});
 assert.equal(f.created[0].isDestroyed(),true);
 finish();
 prototype.loadURL=load;
 f.workspace.register=(wc,scope)=>({...scope,wc,ready:true,generation:1});
 f.manager.openTimeoutMs=1000;
 assert.deepEqual(await f.invoke(f.report,'show',f.reportPayload),{shown:true});
 assert.equal(f.created[0].isVisible(),false);
 assert.deepEqual(visibilityEvents(f),[true]);
});

test('a timed-out warm command cannot present later or destroy the retained child',async()=>{
 const f=workWindowFixture();
 await f.invoke(f.report,'show',f.reportPayload);await f.invoke(f.report,'hide',f.reportPayload);
 const paused=pauseCommand(f,'show');f.manager.openTimeoutMs=40;
 const result=assert.rejects(f.invoke(f.report,'show',f.reportPayload),{code:'REVIEW_OPEN_TIMEOUT',stage:'等待讨论窗口回执'});
 const row=await paused.entered;await result;
 paused.resume();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(row.win.isVisible(),false);assert.equal(row.win.isDestroyed(),false);
 f.manager.openTimeoutMs=1000;
 assert.deepEqual(await f.invoke(f.report,'show',f.reportPayload),{shown:true});
 assert.equal(f.created.length,1);
});

test('explicit report open waits for geometry, coalesces, and only locates on first presentation',async()=>{
 const f=workWindowFixture(),pause=pauseCommand(f,'show');
 const first=f.invoke(f.report,'show',f.reportPayload),duplicate=f.invoke(f.report,'show',f.reportPayload);
 const child=await pause.entered;
 assert.equal(child.win.isVisible(),false);assert.deepEqual(visibilityEvents(f),[]);
 pause.resume();
 assert.deepEqual(await Promise.all([first,duplicate]),[{shown:true},{shown:true}]);
 assert.equal(f.created.length,1);assert.equal(child.win.isFocused(),true);assert.deepEqual(visibilityEvents(f),[true]);
 const shows=()=>f.commands.filter(({detail})=>detail?.action==='show').map(({detail})=>detail.locatePublication);
 assert.deepEqual(shows(),[true]);
 await f.invoke(f.report,'show',f.reportPayload);
 assert.deepEqual(shows(),[true]);
 await f.invoke(f.report,'hide',f.reportPayload);assert.equal(f.report.wc.focusCount,1);
 await f.invoke(f.report,'show',f.reportPayload);
 assert.deepEqual(shows(),[true,false]);assert.deepEqual(visibilityEvents(f),[true,false,true]);
 f.reportBinding.objectId='next';
 await f.invoke(f.report,'show',{...f.reportPayload,objectId:'next'});
 assert.deepEqual(shows(),[true,false,true]);assert.equal(f.created.length,1);
});

test('inactive after the child acknowledges defers without any delayed native reopening',async()=>{
 const f=workWindowFixture(),pause=pauseCommand(f,'show');
 const first=f.invoke(f.report,'show',f.reportPayload),child=await pause.entered;
 f.focus(null);pause.resume();
 assert.deepEqual(await first,{shown:false,deferred:true,reason:'inactive'});
 f.focus(f.parent);f.parent.emit('resize');await f.publishBounds(child,true);
 assert.equal(child.win.isVisible(),false);assert.equal(child.win.showCount,undefined);
 assert.deepEqual(visibilityEvents(f),[]);
 assert.deepEqual(await f.invoke(f.report,'show',f.reportPayload),{shown:true});
});

test('native refusal is not an expanded report and is not retried by focus or bounds',async()=>{
 const f=workWindowFixture(),pause=pauseCommand(f,'show');
 const first=f.invoke(f.report,'show',f.reportPayload),child=await pause.entered;
 child.win.refuseShow=true;pause.resume();
 assert.deepEqual(await first,{shown:false,deferred:true,reason:'native-not-shown'});
 child.win.refuseShow=false;f.parent.emit('focus');await f.publishBounds(child,true);
 assert.equal(child.win.isVisible(),false);assert.equal(child.win.showCount,1);
 assert.deepEqual(visibilityEvents(f),[]);
});

test('parent focus and visibility update the report without passively focusing the child',async()=>{
 const f=workWindowFixture();
 await f.invoke(f.report,'show',f.reportPayload);
 const [win]=f.created;
 f.focus(null);await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(win.isVisible(),true);assert.deepEqual(visibilityEvents(f),[true]);
 f.focus(f.parent);
 assert.equal(win.isVisible(),true);assert.equal(win.isFocused(),false);
 f.parent.minimized=true;f.parent.emit('minimize');assert.equal(win.isVisible(),false);
 f.parent.minimized=false;f.parent.emit('restore');assert.equal(win.isVisible(),true);
 assert.deepEqual(visibilityEvents(f),[true,false,true]);assert.equal(win.showCount,1);
});

test('a pending close cannot commit over a new open; a failed save retains the native popup',async()=>{
 const f=workWindowFixture();
 await f.invoke(f.report,'show',f.reportPayload);
 const [win]=f.created,failed=pauseCommand(f,'hide');
 const stop=f.invoke(f.report,'hide',f.reportPayload);
 const child=await failed.entered;
 assert.equal(win.isVisible(),true);
 failed.resume(Error('save failed'));
 await assert.rejects(stop,/save failed/);
 await f.publishBounds(child,true); // the child restores local visibility on persistence failure
 assert.equal(win.isVisible(),true);assert.equal(f.report.wc.focusCount,0);
 const stale=pauseCommand(f,'hide'),close=f.invoke(f.report,'hide',f.reportPayload);
 await stale.entered;
 const reopen=f.invoke(f.report,'show',f.reportPayload);stale.resume();
 assert.deepEqual(await close,{superseded:true});
 assert.deepEqual(await reopen,{shown:true});
 assert.equal(win.isFocused(),true);assert.equal(f.report.wc.focusCount,0);assert.equal(f.created.length,1);
});

test('a close issued during cold open prevents the stale acknowledgement from showing',async()=>{
 const f=workWindowFixture(),pause=pauseCommand(f,'show');
 const opening=f.invoke(f.report,'show',f.reportPayload),child=await pause.entered;
 const closing=f.invoke(f.report,'hide',f.reportPayload);pause.resume();
 assert.deepEqual(await opening,{shown:false,deferred:true,reason:'superseded'});
 assert.deepEqual(await closing,{ok:true});
 assert.equal(child.win.showCount,undefined);assert.equal(f.report.wc.focusCount,0);assert.deepEqual(visibilityEvents(f),[]);
});

test('changed report ownership and detached parent prevent an old show from presenting',async()=>{
 const f=workWindowFixture(),pause=pauseCommand(f,'show');
 const opening=f.invoke(f.report,'show',f.reportPayload),child=await pause.entered;
 f.reportBinding.objectId='new-publication';pause.resume();
 await assert.rejects(opening,{code:'REVIEW_SCOPE_DENIED'});
 assert.equal(child.win.isVisible(),false);
 const p={...f.reportPayload,objectId:'new-publication'},moving=pauseCommand(f,'show');
 const changing=f.invoke(f.report,'show',p);await moving.entered;
 const detached=f.root();f.workspace.windows.set('detached',{win:detached,windowId:'detached'});
 f.manager.reparentScope(f.report,detached);f.report.win=detached;f.report.windowId='detached';
 f.focus(detached);moving.resume();
 await assert.rejects(changing,{code:'REVIEW_SCOPE_DENIED'});
 assert.equal(child.win.isVisible(),false);assert.equal(child.win.getParentWindow(),detached);
 assert.deepEqual(await f.invoke(f.report,'show',p),{shown:true});
 assert.equal(f.created.length,1);assert.equal(child.win.isFocused(),true);
});

test('a geometry epoch change before show acknowledgement defers until an explicit retry',async()=>{
 const f=workWindowFixture(),pause=pauseCommand(f,'show');
 const opening=f.invoke(f.report,'show',f.reportPayload),child=await pause.entered;
 f.parent.getContentBounds=()=>({x:80,y:25,width:1000,height:720});
 f.parent.emit('move');pause.resume();
 assert.deepEqual(await opening,{shown:false,deferred:true,reason:'geometry'});
 await f.publishBounds(child,true);
 assert.equal(child.win.isVisible(),false);
 assert.deepEqual(await f.invoke(f.report,'show',f.reportPayload),{shown:true});
 assert.equal(child.win.isFocused(),true);
});

test('a delayed open cannot activate over another Nozeli window',async()=>{
 const f=workWindowFixture(),pause=pauseCommand(f,'show');
 const opening=f.invoke(f.report,'show',f.reportPayload),child=await pause.entered;
 const other=f.root();f.focus(other);pause.resume();
 assert.deepEqual(await opening,{shown:false,deferred:true,reason:'inactive'});
 assert.equal(child.win.isVisible(),false);assert.equal(other.isFocused(),true);
});

test('transient geometry hide retains the open request; only successful close clears it',async()=>{
 const f=workWindowFixture();await f.invoke(f.report,'show',f.reportPayload);
 const [child]=f.manager.workRecords('p','work'),row=child.discussionRow;
 await f.publishBounds(child,false);
 assert.equal(row.win.isVisible(),false);assert.equal(row.requested,true);
 await f.publishBounds(child,true);assert.equal(row.win.isVisible(),true);
 const close=pauseCommand(f,'hide');const closing=f.invoke(child,'requestHide',{});const rejected=assert.rejects(closing,/save failed/);
 await close.entered;assert.equal(row.win.isVisible(),true);
 await f.publishBounds(child,true);close.resume(Error('save failed'));await rejected;
 assert.equal(row.requested,true);assert.equal(row.win.isVisible(),true);
 await f.invoke(child,'requestHide',{});await f.publishBounds(child,true);
 assert.equal(row.requested,false);assert.equal(row.win.isVisible(),false);
});

test('a failed presentation retains the acknowledged report binding',async()=>{
 const f=workWindowFixture();await f.invoke(f.report,'show',f.reportPayload);
 f.reportBinding.objectId='next';f.focus(f.parent);
 const fail=pauseCommand(f,'show'),opening=f.invoke(f.report,'show',{...f.reportPayload,objectId:'next'});
 const rejected=assert.rejects(opening,/show failed/),child=await fail.entered;
 fail.resume(Error('show failed'));await rejected;
 assert.equal(child.discussionRow.objectId,'next');
 assert.equal(f.manager.authorize(child,'managed.review.instruction.save',{...f.reportPayload,objectId:'next'}),child);
 assert.throws(()=>f.manager.authorize(child,'managed.review.instruction.save',f.reportPayload),{code:'REVIEW_SCOPE_DENIED'});
});
