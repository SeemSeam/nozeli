import test from 'node:test';
import assert from 'node:assert/strict';
import {readableTagMaterial,tagMaterialSnapshot,TagMaterialDelivery} from '../src/agents/managed/tag-material-delivery.mjs';
const packet=()=>({tagId:'tag-one',fileId:'file-one',relPath:'README.md',kind:'text-selection',note:'保留人的判断权。',origin:{materialDigest:'origin-version',anchor:{start:16,end:27,quote:'人可以随时介入工作。'}},currentSource:{digest:'origin-version'},resolution:{targetDigest:'origin-version',locationStatus:'exact',contentStatus:'unchanged',anchor:{quote:'人可以随时介入工作。'}},information:{location:{label:'第16–21行',context:{before:'背景材料。\n'.repeat(40),after:'后续限制。\n'.repeat(40)}},assets:[],limitations:[]},execution:{canAutoModify:false,reasons:[]}});
const makeJob=p=>{const s=tagMaterialSnapshot([p]);return{target:'frontdesk',text:'围绕人的主体性重新设计README。\n\n参考材料\n\n'+s.full,context:{userInput:{text:'围绕人的主体性重新设计README。'},tagMaterial:{binding:s.binding,version:s.version,brief:s.brief,reusable:s.reusable}}};};
test('readable material distinguishes quoted source, current version and safety without protocol fields',()=>{
 const p=packet(),body=readableTagMaterial(p);
 for(const value of ['README.md','第16–21行','人可以随时介入工作。','背景材料。','后续限制。','保留人的判断权。'])assert(body.includes(value),value);
 for(const value of ['schema','tag-one','file-one','origin-version'])assert(!body.includes(value),value);
 assert(body.includes('不是自动修改授权'));
 p.currentSource={digest:'changed'};p.resolution={targetDigest:'changed',locationStatus:'estimated',contentStatus:'modified',anchor:{quote:'新版本的另一段话。'}};
 const changed=readableTagMaterial(p);assert(changed.includes('当前文件已变化'));assert(changed.includes('人可以随时介入工作。'));assert(changed.includes('新版本的另一段话。'));
 p.currentSource=null;assert(readableTagMaterial(p).includes('当前原文件已不存在'));
});
test('only a successfully delivered unchanged selection in the same native owner gets a compact followup',()=>{
 const d=new TagMaterialDelivery(),session={threadId:'one',contextGeneration:0},job=makeJob(packet());
 const first=d.prepare(session,job);assert.equal(first.text,job.text);assert.equal(d.prepare(session,job).mode,'full','preparing or failed execution is not proof of delivery');first.commit();
 const next=d.prepare(session,job);assert.equal(next.mode,'selection-followup');assert(next.text.startsWith(job.context.userInput.text));assert(next.text.includes('README.md'));assert(!next.text.includes('人可以随时介入工作。'));assert(!next.text.includes('背景材料。'));assert(next.text.includes('frontdesk-source:'+job.context.tagMaterial.version));assert(next.text.includes('上下文已压缩'));assert(next.text.length<job.text.length);
 assert.equal(d.prepare({threadId:'one',contextGeneration:0},job).text,job.text,'new process resends full source');
 session.contextGeneration++;assert.equal(d.prepare(session,job).text,job.text,'changed context resends full source');
});
test('version, tag identity and observed compaction invalidate material reuse including in-flight delivery',()=>{
 const d=new TagMaterialDelivery(),s={threadId:'one'},job=makeJob(packet());d.prepare(s,job).commit();
 for(const change of [{tagId:'second'},{currentSource:{digest:'new-version'}},{note:'新的明确备注'}])assert.equal(d.prepare(s,makeJob({...packet(),...change})).mode,'full');
 const changed=makeJob({...packet(),currentSource:{digest:'changed'}});d.prepare(s,changed).commit();assert.equal(d.prepare(s,changed).mode,'full','source-version warnings remain explicit on every delivery');
 const prepared=d.prepare(s,job);d.invalidate(s);prepared.commit();assert.equal(d.prepare(s,job).mode,'full','compaction while a turn is executing cannot be undone by its late completion');
 d.prepare(s,job).commit();s.threadId='new-thread';assert.equal(d.prepare(s,job).mode,'full');
 assert.equal(d.prepare(s,{...job,target:'orchestrator'}).text,job.text,'background routing never relies on frontdesk context');
});
test('region material keeps page, coordinates, user drawing semantics and unavailable draft caution',()=>{
 const p=packet();p.kind='ppt-region';p.origin.anchor={page:3,rects:[[.1,.2,.3,.4]]};p.information.location={label:'第3页，选中区域'};p.information.drawing={strokes:[{}]};p.information.assets=[{role:'截图',mime:'image/png'}];p.draftStatus='unavailable';
 const text=readableTagMaterial(p);for(const required of ['第3页','0.1，0.2，0.3，0.4','用户笔迹仅用于标注','image/png','草稿已变化或不可读取'])assert(text.includes(required),required);
});

test('Controller dispatches readable first input, compact followup and complete context after invalidation',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {Controller}=await import('../src/agents/managed/controller.mjs');const {frontSource}=await import('../src/agents/managed/frontdesk-read.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-readable-dispatch-')),c=await Controller.open({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),projectHome:async()=>{}});
 t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
 const material=tagMaterialSnapshot([packet()]);await fs.writeFile(path.join(c.store.root,'objects',material.version+'.md'),material.full);
 const prompts=[],session={threadId:'original-thread',instructions:'',tools:[],async prompt(text){prompts.push(text);return {text:'Grounded answer',threadId:this.threadId,providerStatus:'completed'};}};
 c.session=async()=>session;c.kick=()=>{};
 const send=async(question,key)=>{const context={userInput:{text:question},tagMaterial:{version:material.version,binding:material.binding,brief:material.brief,reusable:material.reusable}};const receipt=await c.send('frontdesk',question+'\n\n参考材料\n\n'+material.full,{requestKey:key,context});await c.runJob(c.store.state.jobs.find(j=>j.id===receipt.jobId));assert.equal(c.store.state.jobs.find(j=>j.id===receipt.jobId).status,'completed');return c.store.state.jobs.find(j=>j.id===receipt.jobId);};
 await send('请解释人的主体性。','readable-first');assert(prompts[0].includes('背景材料。'));assert(!prompts[0].includes('nozeli.agent-tag-material-v1'));
 const follow=await send('继续，说明如何介入。','readable-followup');assert(prompts[1].includes('继续这处材料的讨论'));assert(!prompts[1].includes('背景材料。'));
 const recovered=await frontSource(c,'frontdesk-source:'+material.version,follow);assert.equal(recovered.text,material.full);
 c.tagMaterialDelivery.invalidate(session);await send('继续核对。','readable-reloaded');assert(prompts[2].includes('背景材料。'));assert.equal(c.store.state.jobs.length,3);
});
