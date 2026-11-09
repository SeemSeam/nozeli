// Host regression: the managed send/task admission gate keeps its drawing-only
// image channel intact while registered non-drawing local text references
// (HTML/MD/source and honest UTF-8 octet-stream) ride a dedicated
// fileAttachments channel. The host — not the renderer — decides admission:
// registry truth (cross-project, forged, stale instance, corrupted bytes),
// declared binary families and UTF-8/NUL content are all refused BEFORE any
// job or prompt exists, with file-specific errors that never masquerade as
// drawing errors. Accepted files freeze the exact registered bytes as
// file-material objects even when the on-disk source mutates afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {DesktopHost} from '../src/main/host.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {WorkspaceCaptureStore} from '../src/main/workspace-capture-store.mjs';

const pngBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=','base64');
// The wire contract is exactly the six registry identity fields — no
// client-trusted name/size/delivery fields ride a file attachment reference.
const fileRef=ref=>({digest:ref.digest,mime:ref.mime,source:ref.source,storage:ref.storage,projectId:ref.projectId,instanceId:ref.instanceId});
const settle=async(c,jobId,label,timeout=10000)=>{
 const deadline=Date.now()+timeout;let job=null;
 while(Date.now()<deadline){
  job=c.store.state.jobs.find(j=>j.id===jobId);const settled=job&&!['queued','running'].includes(job.status)&&!c.running.size&&!c.kicking&&!c.starting.size;
  if(settled)return job;await new Promise(resolve=>setTimeout(resolve,10));
 }
 return job;
};

// Real DesktopHost + real ProjectAttachments registry + real Controller with a
// scripted native session: the whole managed.agent send/task path runs, only
// the model is fake. No developer paths, no real accounts.
async function fixture(t,{files={}}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-file-attach-')),profile=path.join(root,'profile'),content=path.join(root,'content');
 await fs.mkdir(content,{recursive:true});
 for(const [name,body]of Object.entries(files))await fs.writeFile(path.join(content,name),body);
 const host=new DesktopHost(profile),{project}=await host.pick(content);
 project.instanceId=(await host.storage.requireRegistered(project.id)).instanceId;
 const prompts=[];
 class Session extends EventEmitter{
  constructor(spec,target){super();Object.assign(this,spec,{target,closed:false,busy:false,toolsDigest:'file-attach-host'});}
  async preflightToolsDigest(){}async assertToolsDigest(){}
  async start(thread){this.threadId=thread??'thread-'+randomUUID();return this;}
  async stop(){this.closed=true;return {confirmationComplete:true};}
  async activitySnapshot(){return {known:true,busy:false};}
  async prompt(text,options={}){prompts.push({target:this.target,text,options});return {text:'本地夹具回执',threadId:this.threadId,metrics:{},completion:'provider-completed'};}
 }
 // Production wiring: the controller shares the host's ProjectStorage and
 // projectId (managed-projects passes this.host.storage), so registry digests
 // and context refs resolve against one identity.
 const controller=await Controller.open({storage:host.storage,projectId:project.id,runtimeRoot:path.join(root,'runtime'),contentRoot:content,sessionFactory:(spec,target)=>new Session(spec,target)});
 await controller.start();
 const manager=new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()}});
 manager.controllers.set(project.id,controller);
 t.after(async()=>{await manager.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 const attach=({name,mime='application/octet-stream',source='local-select',bytes})=>host.attachMaterial({projectId:project.id,name,mime,source,size:bytes.length,bytes:bytes.toString('base64')});
 return {root,host,project,controller,manager,prompts,attach,content};
}

// A registered drawing needs its frozen capture record for source verification
// (same shape the snapshot renderer commits before sending).
async function drawingAttachment(f){
 const ref=await f.attach({name:'drawing.png',mime:'image/png',source:'drawing',bytes:pngBytes});
 const id=randomUUID(),store=new WorkspaceCaptureStore({directory:path.join(await f.host.storage.recoveryDirectory(f.project.id),'drawing-captures')});
 await store.saveFrozen({id,projectId:f.project.id,width:1,height:1,tiles:[{id:'w',width:1,height:1,layers:[{bounds:{x:0,y:0,width:1,height:1},dataUrl:'data:image/png;base64,'+pngBytes.toString('base64')}]}]});
 await store.saveResult(id,f.project.id,{attachment:{...ref,kind:'image'},state:'pending-delivery',sources:[]});
 return {...ref,deliveryId:id};
}

// Every refusal must happen before admission: no job, no native prompt, and —
// except where the drawing channel itself is the truthful answer — never
// masked as the drawing guard error.
async function refuse(f,promise,matcher,{drawingMention=false}={}){
 try{await promise;}
 catch(error){
  assert.match(error.message,matcher);
  if(!drawingMention)assert.ok(!error.message.includes('涂鸦'),'refusal must stay file-specific, not the drawing guard error: '+error.message);
  assert.equal(f.controller.store.state.jobs.length,0,'refused before any job is admitted');
  assert.equal(f.prompts.length,0,'refused before any native prompt');
  return;
 }
 assert.fail('expected the host to refuse the submission');
}

test('registered HTML/MD/octet-stream bytes are frozen at send even after the source file mutates',async t=>{
 const html='<html><body><h1>样本量与误差</h1><p>方法A：n=120。</p></body></html>',markdown='# 对照笔记\n- 方法B：n=95，双盲。\n',octet='无扩展名的纯文本负载，仅凭内容判定。';
 const f=await fixture(t,{files:{'paper.html':html,'notes.md':markdown,'payload':octet}});
 const htmlRef=await f.attach({name:'paper.html',mime:'text/html',bytes:Buffer.from(html,'utf8')});
 const mdRef=await f.attach({name:'notes.md',mime:'text/markdown',bytes:Buffer.from(markdown,'utf8')});
 const octetRef=await f.attach({name:'payload',mime:'application/octet-stream',bytes:Buffer.from(octet,'utf8')});
 // The workspace files change after registration; the frozen registered bytes
 // — not the mutated disk state — are what the model receives.
 await fs.writeFile(path.join(f.content,'paper.html'),'<html><body>磁盘上被改写</body></html>');
 await fs.writeFile(path.join(f.content,'notes.md'),'# 磁盘上被改写\n');
 const text='请结合三个附件比较方法A与方法B的样本量。';
 const refs=[htmlRef,mdRef,octetRef].map(fileRef);
 const receipt=await f.manager.invoke('managed.send',{projectId:f.project.id,text,requestKey:'file-host-send-1',fileAttachments:refs});
 assert.equal(receipt.accepted,true);
 const job=await settle(f.controller,receipt.jobId,'file send');
 assert.equal(job?.status,'completed','file attachment send completes: '+(job?.failure??job?.status));
 assert.equal(f.prompts.length,1,'exactly one native prompt');
 assert.equal(f.prompts[0].text,text,'raw user text stays verbatim');
 const materials=f.prompts[0].options.materials??[];
 assert.equal(materials.length,3,'all three files travel as native materials');
 const byTitle=Object.fromEntries(materials.map(material=>[material.title,material]));
 assert.equal(byTitle['paper.html'].text,html,'HTML material is the registered frozen content');
 assert.equal(byTitle['notes.md'].text,markdown,'MD material is the registered frozen content');
 assert.equal(byTitle.payload.text,octet,'octet-stream text passes on content, not extension');
 assert.ok(Object.values(byTitle).every(material=>!material.text.includes('被改写')),'mutated disk content never leaks into the send');
 assert.equal(byTitle['paper.html'].version,htmlRef.digest,'material version pins the registered attachment digest');
 assert.equal(byTitle['paper.html'].provenance?.versionLabel,'frozen-at-send');
 assert.deepEqual(await f.controller.store.readObject(htmlRef.digest),Buffer.from(html,'utf8'),'frozen object is byte-exact in the project store');
 const context=job.context;
 assert.equal(context.materialsExplicit,true,'explicit materials flag set');
 assert.deepEqual(context.fileAttachments.map(ref=>ref.name),['paper.html','notes.md','payload']);
 assert.ok(context.fileAttachments.every(ref=>ref.storage==='project'&&ref.projectId===f.project.id&&/^[a-f0-9]{64}$/.test(ref.sourceManifest?.digest??'')&&Number.isSafeInteger(ref.sourceManifest?.byteLength)&&/^[a-f0-9]{64}$/.test(ref.digest)));
 assert.match(context.submissionDigest,/^[a-f0-9]{64}$/);
 assert.deepEqual(context.materials.filter(m=>m.kind==='file-material').map(m=>m.version),[htmlRef.digest,mdRef.digest,octetRef.digest]);
 // One send: the same submission replays idempotently without a second prompt.
 const replay=await f.manager.invoke('managed.send',{projectId:f.project.id,text,requestKey:'file-host-send-1',fileAttachments:refs});
 assert.equal(replay.jobId,receipt.jobId);
 assert.equal(f.prompts.length,1);
 assert.equal(f.controller.store.state.jobs.length,1);
});

test('task submissions freeze the same registered files as explicit materials in the intake job',async t=>{
 const f=await fixture(t,{files:{'plan.html':'<p>任务计划原版</p>'}});
 const ref=await f.attach({name:'plan.html',mime:'text/html',bytes:Buffer.from('<p>任务计划原版</p>','utf8')});
 await fs.writeFile(path.join(f.content,'plan.html'),'<p>磁盘改写</p>');
 const text='按附件整理执行步骤。';
 const receipt=await f.manager.invoke('managed.task',{projectId:f.project.id,text,requestKey:'file-host-task-1',fileAttachments:[fileRef(ref)]});
 assert.equal(receipt.accepted,true);
 const job=f.controller.store.state.jobs.find(j=>j.key==='task:file-host-task-1');
 assert.ok(job,'task intake job admitted');
 assert.equal(job.text,text,'task text stays verbatim');
 assert.equal(job.context.materialsExplicit,true);
 assert.deepEqual(job.context.materials.map(m=>m.kind),['file-material']);
 assert.equal(job.context.materials[0].version,ref.digest);
 assert.equal(job.context.materials[0].title,'plan.html');
 assert.equal(job.context.fileAttachments[0].digest,ref.digest);
 assert.match(job.context.submissionDigest,/^[a-f0-9]{64}$/);
 assert.deepEqual(await f.controller.store.readObject(ref.digest),Buffer.from('<p>任务计划原版</p>','utf8'),'frozen task material keeps the registered bytes');
 const replay=await f.manager.invoke('managed.task',{projectId:f.project.id,text,requestKey:'file-host-task-1',fileAttachments:[fileRef(ref)]});
 assert.equal(replay.jobId,receipt.jobId);
 assert.equal(f.controller.store.state.jobs.filter(j=>j.key==='task:file-host-task-1').length,1,'one admission, no duplicate intake');
 await settle(f.controller,receipt.jobId,'task intake');
});

test('declared binary formats and NUL/invalid UTF-8 content are refused before admission with file-specific errors',async t=>{
 const f=await fixture(t);
 const png=await f.attach({name:'figure.png',mime:'image/png',bytes:pngBytes});
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'附带图片',requestKey:'file-host-bin-1',fileAttachments:[fileRef(png)]}),/figure\.png[\s\S]*二进制格式|二进制格式[\s\S]*figure\.png/);
 const docx=await f.attach({name:'table.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:Buffer.from('PK-ascii-but-declared-docx','utf8')});
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'附带表格',requestKey:'file-host-bin-2',fileAttachments:[fileRef(docx)]}),/table\.docx[\s\S]*二进制格式|二进制格式[\s\S]*table\.docx/);
 const invalid=await f.attach({name:'noext-payload',mime:'application/octet-stream',bytes:Buffer.from([0xff,0xfe,0x41])});
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'附带原始数据',requestKey:'file-host-bin-3',fileAttachments:[fileRef(invalid)]}),/noext-payload[\s\S]*UTF-8|UTF-8[\s\S]*noext-payload/);
 const nul=await f.attach({name:'nul.md',mime:'text/markdown',bytes:Buffer.from('正文\x00隐藏字节','utf8')});
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'附带NUL文本',requestKey:'file-host-bin-4',fileAttachments:[fileRef(nul)]}),/nul\.md[\s\S]*UTF-8|UTF-8[\s\S]*nul\.md/);
 // A text extension never rescues binary content, and mime forgery against the
 // registered entry is refused by registry truth.
 const lyingHtml=await f.attach({name:'looks.html',mime:'text/html',bytes:Buffer.concat([Buffer.from('<p>'),Buffer.from([0x81,0x82,0x83]),Buffer.from('</p>')])});
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'附带伪HTML',requestKey:'file-host-bin-5',fileAttachments:[fileRef(lyingHtml)]}),/looks\.html[\s\S]*UTF-8|UTF-8[\s\S]*looks\.html/);
 const honest=await f.attach({name:'honest.html',mime:'text/html',bytes:Buffer.from('<p>诚实登记的HTML</p>','utf8')});
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'伪造mime',requestKey:'file-host-bin-6',fileAttachments:[fileRef({...honest,mime:'text/plain'})]}),/登记/);
});

test('cross-project, forged, stale-instance and corrupted references are refused before admission',async t=>{
 const f=await fixture(t);
 const otherRoot=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-file-attach-b-')),otherContent=path.join(otherRoot,'content');
 await fs.mkdir(otherContent,{recursive:true});await fs.writeFile(path.join(otherContent,'other.md'),'# 其他项目的材料\n');
 const {project:other}=await f.host.pick(otherContent);
 other.instanceId=(await f.host.storage.requireRegistered(other.id)).instanceId;
 t.after(async()=>{await fs.rm(otherRoot,{recursive:true,force:true});});
 const foreignBody=Buffer.from('# 其他项目的材料\n','utf8');
 const foreign=await f.host.attachMaterial({projectId:other.id,name:'other.md',mime:'text/markdown',source:'local-select',size:foreignBody.length,bytes:foreignBody.toString('base64')});
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'跨项目附件',requestKey:'file-host-foreign-1',fileAttachments:[fileRef(foreign)]}),/跨项目/);
 const unregistered=await f.host.storage.putRecoveryObject(f.project.id,Buffer.from('从未登记的内容','utf8'));
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'伪造引用',requestKey:'file-host-forge-1',fileAttachments:[{digest:unregistered.digest,mime:'text/plain',source:'local-select',storage:'recovery',projectId:f.project.id,instanceId:f.project.instanceId}]}),/登记/);
 const valid=await f.attach({name:'valid.md',mime:'text/markdown',bytes:Buffer.from('# 已登记材料\n','utf8')});
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'过期实例',requestKey:'file-host-forge-2',fileAttachments:[fileRef({...valid,instanceId:randomUUID()})]}),/实例/);
 // Corrupted registry entry: recorded size no longer matches the stored bytes.
 const corrupt=await f.attach({name:'corrupt.md',mime:'text/markdown',bytes:Buffer.from('# 登记后被改动尺寸的材料\n','utf8')});
 const key='attachment:'+corrupt.digest+':local-select',entry=await f.host.storage.getRecovery(f.project.id,key);
 await f.host.storage.putRecovery(f.project.id,key,{...entry,size:3});
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'损坏登记',requestKey:'file-host-corrupt-1',fileAttachments:[fileRef(corrupt)]}),/损坏/);
 // Corrupted stored bytes: the CAS object no longer matches its digest.
 const tampered=await f.attach({name:'tampered.md',mime:'text/markdown',bytes:Buffer.from('# 登记后字节被替换\n','utf8')});
 await fs.writeFile(path.join(await f.host.storage.recoveryDirectory(f.project.id),'objects','sha256',tampered.digest),'tampered-bytes');
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'损坏字节',requestKey:'file-host-corrupt-2',fileAttachments:[fileRef(tampered)]}),/identifier|损坏|match/i);
});

test('drawing channel stays isolated: drawings cannot ride file attachments, text files cannot ride image attachments',async t=>{
 const f=await fixture(t,{files:{'local.html':'<p>本地HTML引用</p>'}});
 const local=await f.attach({name:'local.html',mime:'text/html',bytes:Buffer.from('<p>本地HTML引用</p>','utf8')});
 const drawing=await drawingAttachment(f);
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'涂鸦占用文件通道',requestKey:'file-host-channel-1',fileAttachments:[fileRef(drawing)]}),/图片附件/,{drawingMention:true});
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'文本占用图片通道',requestKey:'file-host-channel-2',imageAttachments:[local]}),/不是已登记的涂鸦材料/,{drawingMention:true});
 // Both channels in one submission: the drawing keeps its frozen image
 // delivery and the local HTML reference no longer hits the drawing guard.
 const text='涂鸦与本地HTML一起发送。';
 const receipt=await f.manager.invoke('managed.send',{projectId:f.project.id,text,requestKey:'file-host-channel-3',imageAttachments:[drawing],fileAttachments:[fileRef(local)]});
 assert.equal(receipt.accepted,true);
 const job=await settle(f.controller,receipt.jobId,'combined channels');
 assert.equal(job?.status,'completed','combined send completes: '+(job?.failure??job?.status));
 assert.equal(f.prompts.length,1);
 assert.deepEqual(f.prompts[0].options.images,['data:image/png;base64,'+pngBytes.toString('base64')],'drawing still verified and delivered as PNG');
 assert.equal(f.prompts[0].options.materials?.[0]?.text,'<p>本地HTML引用</p>','local HTML delivered as frozen file material');
 assert.equal(job.context.drawingSources?.length,1);
 assert.equal(job.context.fileAttachments?.[0]?.name,'local.html');
});

test('file attachment limits: at most 20 references and 24MiB total per submission',async t=>{
 const f=await fixture(t);
 const refs=[];
 for(let index=0;index<21;index++)refs.push(await f.attach({name:'part-'+index+'.md',mime:'text/markdown',bytes:Buffer.from('# 部分 '+index+'\n','utf8')}));
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'超过数量',requestKey:'file-host-limit-1',fileAttachments:refs.map(fileRef)}),/最多20个/);
 const mega=index=>Buffer.alloc(8*1024*1024,97+index);
 const big=[];
 for(let index=0;index<3;index++)big.push(await f.attach({name:'big-'+index,mime:'application/octet-stream',bytes:mega(index)}));
 // Exactly 24MiB passes admission; any further registered content trips it.
 const overflow=await f.attach({name:'overflow.md',mime:'text/markdown',bytes:Buffer.from('x','utf8')});
 await refuse(f,f.manager.invoke('managed.send',{projectId:f.project.id,text:'超过总量',requestKey:'file-host-limit-2',fileAttachments:[...big,overflow].map(fileRef)}),/总量超过24MiB/);
 const receipt=await f.manager.invoke('managed.send',{projectId:f.project.id,text:'边界总量',requestKey:'file-host-limit-3',fileAttachments:big.map(fileRef)});
 assert.equal(receipt.accepted,true,'exactly 24MiB of registered text is admitted');
 const job=f.controller.store.state.jobs.find(j=>j.id===receipt.jobId);
 assert.equal(job.context.fileAttachments.length,3);
 assert.equal(job.context.materialsExplicit,true);
 await settle(f.controller,receipt.jobId,'24MiB boundary',20000);
});
