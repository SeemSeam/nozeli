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
 const sent=[];owner.windowId='root';
 const root={projectId:'p',ready:true,wc:{send:(...args)=>sent.push(args)},win:{show(){},focus(){}}};
 workspace.windows=new Map([['root',root]]);workspace.flushOne=async()=>{};
 workspace.openTaskProcess=async()=>{throw Error('process split must not open from the review child');};
 manager.capture(record,'managed.review.discussion.read',{workId:'work',objectId:'object',taskFrame:{entries:[]},taskState:{receipts:[{workId:'work',objectId:'object',revision:1,kind:'result'},{workId:'foreign',objectId:'foreign',kind:'result'}]}});
 await manager.invoke(record,'workspace.reviewDiscussion.navigate',{projectId:'p',workId:'work',kind:'report',objectId:'object'});
 assert.equal(sent[0][1].report.objectId,'object');assert.equal(row.objectId,'object');
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
 owner.win=parent;owner.view={getVisible:()=>true};row.requested=true;row.win.getParentWindow=()=>parent;
 manager.capture(record,'managed.review.discussion.read',{workId:'work',objectId:'object',taskFrame:{entries:[{id:'message'}]}});
 const payload={projectId:'p',objectId:'object',messageId:'message'};
 assert.equal(manager.authorize(record,'workspace.attention.presented',payload),record);
 for(const mismatch of [{projectId:'other'},{objectId:'new-report'},{messageId:'other-thread'}])assert.throws(()=>manager.authorize(record,'workspace.attention.presented',{...payload,...mismatch}),{code:'REVIEW_SCOPE_DENIED'});
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
 return {manager:new NativeReviewDiscussionManager({workspace,BrowserWindow:Window}),owner,windows,payload:{projectId:'p',workId:'work',objectId:'object'}};
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
