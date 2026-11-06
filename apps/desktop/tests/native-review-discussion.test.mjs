import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeReviewDiscussionManager,runReviewDiscard} from '../src/main/native-review-discussion.mjs';
import {EventEmitter} from 'node:events';
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
 const {manager,record}=fixture();manager.capture(record,'managed.review.discussion.read',{entries:[{id:'allowed'}]});
 assert.equal(manager.authorize(record,'managed.timeline.read',{projectId:'p',id:'allowed'}),record);
 assert.throws(()=>manager.authorize(record,'managed.timeline.read',{projectId:'p',id:'other-work'}),{code:'REVIEW_SCOPE_DENIED'});
});
test('presentation accepts only visible bound messages and never a different report or hidden child',()=>{
 const {manager,record,row,owner}=fixture(),parent={isMinimized:()=>false,isVisible:()=>true,isFocused:()=>true};
 owner.win=parent;owner.view={getVisible:()=>true};row.requested=true;row.win.getParentWindow=()=>parent;
 manager.capture(record,'managed.review.discussion.read',{entries:[{id:'message'}]});
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
