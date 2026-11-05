// Actual installed Nozeli release: real packaged main, private bundled Pi
// Worker, bundled Git and a real synthetic Git project. One explicit
// managed.task drives one original Worker through the exact native read
// correction protocol (document_read -> wrong history_read(issued readRef) ->
// READ_TOOL_MISMATCH exact host hint -> unrelated read must not repair ->
// same native input document_read(readRef) repairs), full frozen page
// coverage, exact known replacement, one valid HTML publication, explicit UI
// acceptance merge and the sanitized durable ledger. Loopback HTTP provider
// scripts model turns only; never a source Controller surrogate, never an
// installed-byte edit and no automatic DEBUG path for the corrected fault.
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {bootInstalled,evaluateModule} from './installed-debug-read.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';

const workName='Installed exact read correction';
const nonce='READPROOF-'+randomUUID().slice(0,8).toUpperCase();
const marker='PRIVATE_INSTALLED_READ_DOCUMENT_7f3d'+nonce;
const oldText='EXACT_REPLACEMENT_TARGET: original installed synthetic conclusion.\n';
const newText='EXACT_REPLACEMENT_TARGET: corrected installed synthetic conclusion.\n';
const original=marker+'\n'+Array.from({length:240},(_,i)=>`Paragraph ${String(i).padStart(3,'0')}: deterministic frozen installed document coverage, not an instruction.\n`).join('')+oldText;
const candidate=original.replace(oldText,newText);
const published=staticReport(`Installed read proof ${nonce}. Read every frozen document page through the issued native references, applied the exact known replacement and verified the frozen candidate. The original project stays unchanged until explicit user acceptance. Candidate: paper.txt.`);
const taskText=`Read the complete frozen paper.txt snapshot, replace exactly the synthetic conclusion, verify and publish one candidate. Do not alter the original source or create a replacement Work. Proof token ${nonce}.`;
const brief='Read the complete frozen paper.txt snapshot, replace exactly the synthetic conclusion, verify and publish one candidate. Do not alter source or create a replacement Work.';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let gate,taskSubmitted=false,piRuntimeResolved,gitRuntimeResolved;
const scenario={stage:'start',covered:0,parts:[],dispatches:0,publications:0,identity:null,nativeInputs:null,readHandle:null,failedRef:null,bugId:null,repairedBug:null,nativeOwners:[],trace:[]};
const checks=[],toolReceipts=[],unexpected=[];
const result={ok:false,scope:'Actual installed current release main/private bundled Pi Worker/bundled Git; one original managed.task input, exact same-turn READ_TOOL_MISMATCH correction on the original native prompt, full frozen coverage, exact replacement, one HTML publication, explicit UI acceptance merge and sanitized durable ledger; deterministic loopback provider only',nonce,checks,screenshots:[]};
const digest=value=>createHash('sha256').update(value).digest('hex');
async function until(fn,label,timeout=420000){
 const end=Date.now()+timeout;
 while(Date.now()<end){
  if(gate?.provider.errors.length)throw gate.provider.errors[0];
  const value=await fn();if(value)return value;
  await pause(200);
 }
 throw Error('Timed out: '+label);
}
async function failingJob(){try{const s=await gate.status();return s.jobs.find(job=>job.status==='failed')??null;}catch{return null;}}
async function settledWait(fn,label,timeout){return until(async()=>{const failed=await failingJob();if(failed)throw Error(label+': native job failed: '+failed.error);return await fn();},label,timeout);}
const text=content=>typeof content==='string'?content:content.map(part=>part.text??'').join('\n');
function lastTool(request,id){
 const row=request.messages.findLast(message=>message.role==='tool');
 assert(row,'actual native tool response required');
 assert.equal(row.tool_call_id,id);
 const content=text(row.content);toolReceipts.push({stage:scenario.stage,callId:id,content});
 assert(!content.includes('nozeli host rejected'),content);
 return JSON.parse(content);
}
function success(request,id){const receipt=lastTool(request,id);assert.notEqual(receipt.ok,false,JSON.stringify(receipt));return receipt.value??receipt;}
function refusal(request,id,code){
 const receipt=lastTool(request,id);
 assert.equal(receipt.ok,false);assert.equal(receipt.continueTurn,true);
 assert.equal(receipt.error.code,code);assert.notEqual(receipt.hostControl,true);
 assert(!JSON.stringify(receipt).includes(marker),'refusal never leaks document text');
 return receipt;
}
const call=(id,tool,args)=>({id,tool,args});
let ledgerFilePath=null;
async function ledgerPath(){
 if(ledgerFilePath)return ledgerFilePath;
 if(gate.ledgerFile){ledgerFilePath=gate.ledgerFile;return ledgerFilePath;}
 const storageRoot=path.join(gate.profile,'nozeli','storage-v2');
 const catalog=new DatabaseSync(path.join(storageRoot,'catalog.sqlite'),{readOnly:true});
 try{
  const row=catalog.prepare("SELECT value FROM records WHERE collection='instances' AND id=?").get(gate.projectId);
  assert(row,'registered installed project row');
  ledgerFilePath=path.join(storageRoot,'instances',JSON.parse(row.value).instanceId,'ui.sqlite');
 }finally{catalog.close();}
 return ledgerFilePath;
}
async function bugFor(code,jobId){
 // Read the durable ledger directly (read-only SQLite) instead of the
 // sanitized/paginated managed.maintenance.status projection.
 let seen=null,lastError=null;
 for(let attempt=0;attempt<12;attempt++){
  let db=null;
  try{
   db=new DatabaseSync(await ledgerPath(),{readOnly:true});
   try{db.exec('PRAGMA busy_timeout=1500');}catch{}
   const row=db.prepare("SELECT value FROM records WHERE collection=? AND id=?").get(gate.ledgerCollection??"ui",gate.ledgerRecord??"managed:maintenance");
   const bugs=row?(JSON.parse(row.value).bugs??[]):null;
   const bug=(bugs??[]).find(entry=>entry.error?.code===code&&entry.jobId===jobId);
   if(bug){assert.equal(bug.phase,'tool-protocol');return bug;}
   seen=bugs;
  }catch(error){lastError=error;}
  finally{try{db?.close();}catch{}}
  await pause(250);
 }
 assert.fail(`durable ${code} bug for original job ${jobId}: lastError=${String(lastError)} bugs=${JSON.stringify(seen)}`);
}
async function bindOriginalWorker(request){
 const s=await gate.status();
 assert.equal(s.works.length,1,'exactly one original Work');
 const work=s.works[0];assert.equal(work.name,workName);
 const jobs=s.jobs.filter(job=>job.target===work.id);
 assert(jobs.length<=1,'no supplementary Worker input');
 const job=jobs[0];assert(job,'original Worker job bound via status');
 const agent=s.agents.find(row=>row.target===work.id);
 assert(agent&&!agent.closed,'original native Worker owner attached');
 const identity={workId:work.id,threadId:work.threadId,jobId:job.id,ownerId:agent.ownerId};
 if(!scenario.identity){scenario.identity=identity;scenario.nativeInputs=request.messages.filter(message=>message.role==='user').length;}
 else assert.deepEqual(identity,scenario.identity,'every read correction stays on the exact original Worker/job/thread/owner');
 assert.equal(request.messages.filter(message=>message.role==='user').length,scenario.nativeInputs,'no hidden replay or extra input during correction');
 return {work,job};
}
function page(value){
 assert.equal(value.relPath,'paper.txt');assert.equal(value.nextTool,'nozeli_document_read');
 assert.equal(value.totalChars,original.length);assert.equal(value.offset,scenario.covered);
 assert(value.endOffset>value.offset);assert.equal(value.text,original.slice(value.offset,value.endOffset));
 if(scenario.readHandle)assert.equal(value.readHandle,scenario.readHandle);
 else scenario.readHandle=value.readHandle;
 scenario.covered=value.endOffset;scenario.parts.push(value.text);
 return value;
}
function nextPageOrApply(value){
 if(value.nextReadRef){scenario.stage='pages';return call('document-page-'+scenario.covered,'nozeli_document_read',{readRef:value.nextReadRef});}
 assert.equal(scenario.covered,original.length,'complete contiguous frozen snapshot before replacement');
 assert.equal(scenario.parts.join(''),original);
 scenario.stage='apply';
 return call('exact-apply','nozeli_document_apply',{readHandle:scenario.readHandle,replacements:[{oldText,newText}]});
}
async function nativeOwnerProcesses(){
 const found=[];
 for(const entry of await fs.readdir('/proc')){
  if(!/^\d+$/.test(entry))continue;
  try{
   const stat=await fs.readFile(`/proc/${entry}/stat`,'utf8');
   if(Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1])!==gate.pid)continue;
   const argv=(await fs.readFile(`/proc/${entry}/cmdline`)).toString().split('\0').filter(Boolean);
   if(!argv.some(arg=>arg.includes('/resources/app/')&&(arg.endsWith('owner.mjs')||arg.endsWith('launch.mjs'))))continue;
   found.push({pid:Number(entry),exe:await fs.realpath(`/proc/${entry}/exe`),argv});
  }catch{}
 }
 return found;
}
const handler=async request=>{
 assert(gate,'model requests are legal only after the installed app booted');
 assert(taskSubmitted,'no model request is allowed before the explicit managed.task input');
 assert(toolReceipts.length<70,'bounded deterministic native scenario');
 const names=request.tools?.map(tool=>tool.function?.name)??[];
 if(names.includes('nozeli_publish')){
  const {job}=await bindOriginalWorker(request);
  if(scenario.stage==='start'){
   scenario.stage='first-page';scenario.trace.push('document_read(paper.txt)');
   return call('initial-document','nozeli_document_read',{relPath:'paper.txt'});
  }
  if(scenario.stage==='first-page'){
   const first=page(success(request,'initial-document'));
   assert(first.nextReadRef,'installed source must exceed one delivered page');
   scenario.failedRef=first.nextReadRef;
   scenario.nativeOwners=await nativeOwnerProcesses();
   scenario.stage='wrong-reader';scenario.trace.push('history_read(issued document readRef)');
   return call('wrong-history-reader','nozeli_history_read',{readRef:first.nextReadRef,offset:first.endOffset});
  }
  if(scenario.stage==='wrong-reader'){
   const receipt=refusal(request,'wrong-history-reader','READ_TOOL_MISMATCH');
   assert.equal(receipt.error.nextTool,'nozeli_document_read','exact host correction hint names the only legal continuation tool');
   assert.equal(receipt.error.readRef,scenario.failedRef,'exact host correction hint returns the issued reference');
   assert(typeof receipt.error.message==='string'&&receipt.error.message.length>0,'host correction hint carries a real instruction message');
   const bug=await bugFor('READ_TOOL_MISMATCH',job.id);
   assert.notEqual(bug.status,'repaired');
   assert(!bug.debug,'no automatic DEBUG is armed for a correctable same-turn fault');
   scenario.bugId=bug.id;scenario.stage='unrelated';scenario.trace.push('unrelated read');
   return call('unrelated-read','nozeli_document_read',{relPath:'unrelated.txt'});
  }
  if(scenario.stage==='unrelated'){
   const unrelated=success(request,'unrelated-read');
   assert.equal(unrelated.text,'Unrelated synthetic document.\n');
   assert.notEqual((await bugFor('READ_TOOL_MISMATCH',job.id)).status,'repaired','unrelated success cannot repair the exact wrong-ref bug');
   scenario.stage='correct-reader';scenario.trace.push('document_read(issued readRef) on the same native input');
   return call('matching-document-correction','nozeli_document_read',{readRef:scenario.failedRef});
  }
  if(scenario.stage==='correct-reader'){
   const corrected=page(success(request,'matching-document-correction'));
   const bug=await bugFor('READ_TOOL_MISMATCH',job.id);
   assert.equal(bug.status,'repaired','exact cross-tool correction automatically verifies the durable bug');
   assert.equal(bug.lastOutcome.verified,true);
   assert.equal(bug.lastOutcome.outcome,'same-turn-read-corrected');
   assert.deepEqual(bug.attempts,[],'read correction is not an effect-replay attempt');
   const s=await gate.status();
   const fault=s.jobs.find(row=>row.id===job.id).readProtocolFaults.find(row=>row.bugId===bug.id);
   assert(fault&&fault.correctionReceipt&&fault.correctionReceipt.verified===true,'exact host correction receipt recorded on the original job');
   assert.equal(fault.status,'repaired');assert.equal(fault.correctionTool,'nozeli_document_read');
   scenario.repairedBug={id:bug.id,status:bug.status,lastOutcome:bug.lastOutcome,jobId:bug.jobId};
   return nextPageOrApply(corrected);
  }
  if(scenario.stage==='pages')return nextPageOrApply(page(success(request,'document-page-'+scenario.covered)));
  if(scenario.stage==='apply'){
   success(request,'exact-apply');
   const s=await gate.status(),work=s.works[0];
   assert.equal(await fs.readFile(path.join(work.execution.directory,'paper.txt'),'utf8'),candidate,'frozen candidate carries the exact known replacement');
   assert.equal(await fs.readFile(path.join(gate.root,'paper.txt'),'utf8'),original,'original project untouched before acceptance');
   scenario.stage='published';scenario.publications++;scenario.trace.push('document_apply + publish');
   return call('original-publish-once','nozeli_publish',{kind:'result',content:published,files:['paper.txt']});
  }
  if(scenario.stage==='published')return {text:'Publication complete. Preserve the original request and the exact host correction receipts; do not replay business input or perform maintenance actions.'};
  throw Error('Unexpected Worker continuation: '+scenario.stage);
 }
 if(names.includes('nozeli_dispatch')){
  if(scenario.dispatches===0&&scenario.stage==='start'){
   assert.equal(scenario.dispatches++,0,'one explicit dispatch, never auto-dispatch from a read correction');
   scenario.trace.push('orchestrator explicit dispatch');
   return call('explicit-dispatch','nozeli_dispatch',{name:workName,brief});
  }
  unexpected.push({tools:names,note:'post-dispatch orchestrator turn'});
  return {text:'Preserve the original request and exact host correction receipts; do not replay business input or dispatch again.'};
 }
 unexpected.push({tools:names});
 return {text:'Preserve the original request and exact host correction receipts; do not replay business input or perform maintenance actions.'};
};
try{
 gate=await bootInstalled({scenario:{name:'installed-read-protocol-correction'},files:{'paper.txt':original,'unrelated.txt':'Unrelated synthetic document.\n','.gitignore':'/.nozeli/\n'},handler});
 for(const key of ['out','root','profile','projectId','release','appRoot','binary','shell','observer','provider','invoke','status','capture','close','browser'])assert(gate[key]!==undefined,`bootInstalled contract field missing: ${key} (coordinate with InstalledDebugGate)`);
 // Installed artifact identity: exactly the real current user installation.
 const currentLink=path.join(os.userInfo().homedir,'.local','opt','nozeli','current');
 assert.equal(gate.identity.currentLink,currentLink,'fixture resolves the real account current link');
 const current=await fs.realpath(currentLink);
 assert.equal(gate.release,current,'the gate must run the actual current installation realpath');
 assert.equal(gate.appRoot,path.join(current,'resources','app'));
 assert.equal(await fs.realpath(gate.binary),await fs.realpath(path.join(current,'nozeli')));
 const installation=JSON.parse(await fs.readFile(path.join(current,'INSTALLATION.json'),'utf8'));
 const shot=async label=>{const returned=await gate.capture(label);return typeof returned==='string'?returned:path.join(gate.out,label+'.png');};
 const mainMeta=await gate.observer.evaluate('({execPath:process.execPath,resourcesPath:process.resourcesPath,nodeVersion:process.versions.node,electronVersion:process.versions.electron,main:process.mainModule&&process.mainModule.filename})');
 assert.equal(await fs.realpath(mainMeta.resourcesPath),path.join(current,'resources'),'packaged main runs from the installed release resources');
 assert.equal(await fs.realpath(mainMeta.execPath),await fs.realpath(path.join(current,'nozeli')),'packaged main executable is the installed binary');
 piRuntimeResolved=await (await import(pathToFileURL(path.join(gate.appRoot,'src/agents/managed/pi-runtime.mjs')))).resolveBundledPiRuntime({appRoot:gate.appRoot,packaged:true,piHome:path.join(gate.out,'proof-pi-home')});
 assert(piRuntimeResolved.command.startsWith(path.join(gate.appRoot,'runtime')+path.sep),'Pi workers resolve the bundled standalone Node inside the installed app');
 assert((await fs.realpath(piRuntimeResolved.command)).startsWith(await fs.realpath(gate.appRoot)+path.sep),'bundled Node path resolves inside the installed app');
 gitRuntimeResolved=await (await import(pathToFileURL(path.join(gate.appRoot,'src/agents/managed/git-runtime.mjs')))).ensureGit();
 assert.equal(gitRuntimeResolved.source,'bundled');
 assert((await fs.realpath(gitRuntimeResolved.command)).startsWith(await fs.realpath(gate.appRoot)+path.sep),'bundled Git lives inside the installed app');
 // In-main runtime/Git identity: consume the fixture's redacted boot probe and
 // re-probe once through the shared evaluateModule helper (vm
 // USE_MAIN_CONTEXT_DEFAULT_LOADER); ordinary observer.evaluate above stays
 // import-free by design.
 const runtimeIdentity=gate.identity?.runtimeIdentity;
 assert(runtimeIdentity?.pi?.command&&runtimeIdentity?.git?.command,'fixture exposes the redacted in-main runtime identity');
 assert.equal(await fs.realpath(runtimeIdentity.pi.command),await fs.realpath(piRuntimeResolved.command),'in-main Inspector identity: bundled Node matches test-process resolution');
 assert.equal(runtimeIdentity.git.source,'bundled','in-main Inspector identity: bundled Git source');
 assert.equal(runtimeIdentity.git.version,gitRuntimeResolved.version,'in-main Inspector identity: bundled Git version');
 assert.equal(await fs.realpath(runtimeIdentity.git.command),await fs.realpath(gitRuntimeResolved.command),'in-main Inspector identity: bundled Git path matches');
 const mainRuntime=await evaluateModule(gate.observer,`(async()=>{
  const req=process.mainModule.require.bind(process.mainModule),path=req('node:path'),{pathToFileURL}=req('node:url');
  const appRoot=${JSON.stringify(gate.appRoot)};
  const pi=await import(pathToFileURL(path.join(appRoot,'src/agents/managed/pi-runtime.mjs')).href);
  const resolved=await pi.resolveBundledPiRuntime({appRoot,packaged:true,piHome:path.join(${JSON.stringify(gate.out)},'observer-probe-pi-home')});
  const gitModule=await import(pathToFileURL(path.join(appRoot,'src/agents/managed/git-runtime.mjs')).href);
  const git=await gitModule.ensureGit();
  return {execPath:process.execPath,resourcesPath:process.resourcesPath,pi:{command:resolved.command,nodeManifest:resolved.manifest.node??null,piManifest:resolved.manifest.pi??null},git:{command:git.command,version:git.version,source:git.source}};
 })()`,30000);
 assert.equal(await fs.realpath(mainRuntime.execPath),await fs.realpath(gate.binary),'evaluateModule probe: installed main executable');
 assert.equal(await fs.realpath(mainRuntime.pi.command),await fs.realpath(piRuntimeResolved.command),'evaluateModule probe: bundled Node matches');
 assert.equal(mainRuntime.git.source,'bundled','evaluateModule probe: bundled Git source');
 assert.equal(await fs.realpath(mainRuntime.git.command),await fs.realpath(gitRuntimeResolved.command),'evaluateModule probe: bundled Git matches');
 result.installed={current,release:gate.release,appRoot:gate.appRoot,binary:await fs.realpath(gate.binary),installation,main:mainMeta,mainRuntime,bundledNode:piRuntimeResolved.command,bundledNodeManifest:piRuntimeResolved.manifest.node,bundledPiManifest:piRuntimeResolved.manifest.pi,bundledGit:gitRuntimeResolved.command,bundledGitVersion:gitRuntimeResolved.version,bundledGitSource:gitRuntimeResolved.source};
 const {runGit:installedRunGit}=await import(pathToFileURL(path.join(gate.appRoot,'src/agents/managed/git-runtime.mjs')));
 const rawGit=gate.gitRaw??(async(...args)=>String(await installedRunGit(gate.root,args,{encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})));
 const git=gate.git??(async(...args)=>(await installedRunGit(gate.root,args,{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})).toString().trim());
 const head=gate.head??await git('rev-parse','HEAD');
 assert.equal(await git('rev-parse','HEAD'),head,'synthetic Git baseline present before any managed activity');
 const managedStatus=()=>gate.invoke('managed.status',{projectId:gate.projectId});
 const ready=await until(async()=>{try{const view=await managedStatus();return view.ready?view:null;}catch{return null;}},'installed managed runtime ready after enable',180000);
 result.runtimeRoot=ready.runtimeRoot;
 assert.equal(gate.provider.requests.filter(row=>!row.listing).length,0,'boot itself performs no model request');
 // The only original input: one explicit managed.task with an explicit requestKey.
 taskSubmitted=true;
 const submitted=await gate.invoke('managed.task',{projectId:gate.projectId,text:taskText,requestKey:'installed-read-correction-'+nonce});
 result.submitted={jobId:submitted.jobId??submitted.requestId??null};
 const settled=await settledWait(async()=>{
  const s=await gate.status();
  const work=s.works.find(row=>row.name===workName);
  return work&&work.status==='review'&&!s.busyTargets.includes(work.id)&&!s.busyTargets.includes('orchestrator')&&!s.jobs.some(job=>['queued','running'].includes(job.status))?s:null;
 },'one original Worker reads, corrects, applies and publishes');
 const work=settled.works[0],workerJobId=settled.jobs.find(job=>job.target===work.id).id;
 assert.equal(scenario.dispatches,1);assert.equal(scenario.publications,1);
 assert.equal(settled.works.length,1,'one original Work, no replacement');
 assert(!settled.works.some(row=>row.replacementWork||row.replacementWorkId));
 assert(work.threadId,'original Worker bound a real native thread');
 assert.equal(settled.quotaUsed,1);
 const intake=settled.jobs.filter(job=>job.type==='intake'&&job.target==='orchestrator');
 assert.equal(intake.length,1,'exactly one orchestrator intake for the explicit task');
 assert.equal(intake[0].status,'completed');assert.equal(intake[0].text,taskText,'original user input preserved verbatim');
 if(result.submitted.jobId)assert.equal(intake[0].id,result.submitted.jobId);
 const workerJobs=settled.jobs.filter(job=>job.target===work.id);
 assert.equal(workerJobs.length,1,'exactly one Worker input, no supplementary replay');
 assert.equal(workerJobs[0].status,'completed');assert.equal(workerJobs[0].collabAttempts.length,1,'one native input admission');
 assert.equal(workerJobs[0].readProtocolFaults.length,1);
 const fault=workerJobs[0].readProtocolFaults[0];
 assert.equal(fault.code,'READ_TOOL_MISMATCH');assert.equal(fault.status,'repaired');
 assert.deepEqual(fault.correctionReceipt,{verified:true,identity:fault.correction});
 assert.equal(settled.jobs.filter(job=>job.type==='maintenance').length,0,'corrected path schedules no automatic DEBUG/maintenance job');
 const receipts=settled.receipts.filter(row=>row.workId===work.id&&row.kind==='result');
 assert.equal(receipts.length,1,'exactly one original publication');
 const receipt=receipts[0];
 assert.equal(receipt.report.format,'html-static');assert.equal(receipt.report.objectId,work.result.objectId);
 const frozen=receipt.snapshot.files.find(row=>row.relPath==='paper.txt');
 assert(frozen&&frozen.digest===digest(candidate),'candidate frozen with exact bytes');
 const todo=settled.todos.find(row=>row.workId===work.id&&row.kind==='result'&&row.status==='open');
 assert(todo,'one open result todo for the original publication');
 assert.equal(await fs.readFile(path.join(work.execution.directory,'paper.txt'),'utf8'),candidate);
 assert.equal(await fs.readFile(path.join(gate.root,'paper.txt'),'utf8'),original,'source unchanged before explicit acceptance');
 assert.equal(await git('rev-parse','HEAD'),head,'source Git unchanged before explicit acceptance');
 assert.equal((await git('status','--porcelain')).length,0,'no stray worktree files');
 const frozenReport=await gate.invoke('managed.history.read',{projectId:gate.projectId,objectId:receipt.report.objectId});
 assert.equal(frozenReport.objectVerified,true,'host verifies frozen canonical report bytes');
 assert.equal(frozenReport.report.digest,receipt.report.digest);
 assert.equal(frozenReport.report.byteLength,receipt.report.byteLength);
 assert(scenario.nativeOwners.length>=1,'at least one live native Pi owner observed during the original turn');
 const bundledNodeReal=await fs.realpath(piRuntimeResolved.command);
 for(const owner of scenario.nativeOwners){
  assert(owner.exe.startsWith(gate.release+path.sep)||owner.exe.startsWith(gate.appRoot+path.sep),`native owner runs bundled runtime only: ${owner.exe}`);
  assert.equal(owner.exe,bundledNodeReal,`native owner executable is the bundled Node: ${owner.exe}`);
 }
 result.nativeOwners=scenario.nativeOwners.map(({pid,exe})=>({pid,exe}));
 result.worker={workId:work.id,jobId:workerJobId,threadId:work.threadId,executionDirectory:work.execution.directory};
 checks.push('actual installed main/Pi/Git run one original managed.task input; wrong history_read(issued document readRef) gets the exact READ_TOOL_MISMATCH hint with continueTurn and no text leak');
 checks.push('unrelated document read cannot repair the exact wrong-ref bug; the same native input document_read(readRef) repairs it with a verified host correction receipt and zero effect-replay attempts');
 checks.push('full frozen page coverage feeds one exact document_apply; one valid HTML publication with a unique proof id freezes the exact candidate while original source and Git stay unchanged');
 // Open the real frozen report and candidate through the actual UI.
 if(await gate.shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true').catch(()=>false))await gate.shell.click('#toggle-sidebar');
 await gate.shell.waitForSelector(`[data-managed-todo="${todo.id}"]`,{visible:true});
 await gate.shell.click(`[data-managed-todo="${todo.id}"]`);
 const review=await until(async()=>{for(const page of await gate.browser.pages()){if(await page.$eval('[data-review-action="accept"]:not([disabled])',node=>node.getClientRects().length>0).catch(()=>false))return page;}},'actionable original report review surface');
 await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 const previewKey=await review.$eval('.managed-report-body .isolated-viewport',node=>node.dataset.previewKey);
 const snapshotReply=await review.evaluate(key=>window.nozeli.invoke('isolated-preview.snapshot',{key}),previewKey);assert(snapshotReply.ok);
 const guest=await until(async()=>{for(const page of await gate.browser.pages())if(page.url().startsWith(snapshotReply.value.origin+'/'))return page;},'real isolated frozen report guest');
 await guest.waitForFunction(token=>document.body.innerText.includes(token),{},nonce);
 await guest.screenshot({path:path.join(gate.out,'01-report-guest.png')});result.screenshots.push(path.join(gate.out,'01-report-guest.png'));
 result.screenshots.push(await shot('01-original-review-report'));
 await review.waitForSelector('[data-review-action="files"]',{visible:true});
 await review.click('[data-review-action="files"]');
 await review.waitForSelector('[data-review-file="paper.txt"]',{visible:true});
 await review.click('[data-review-file="paper.txt"]');
 const document_=await until(async()=>{for(const page of await gate.browser.pages()){const value=await page.evaluate(()=>window.__nozeliInput?window.__nozeliInput.text():null).catch(()=>null);if(value===candidate)return page;}},'frozen candidate document surface');
 result.screenshots.push(await shot('02-frozen-candidate-open'));
 checks.push('real UI opens the frozen HTML report and the exact frozen candidate document');
 // Explicit user acceptance through the actual footer confirmation.
 const requestsAtPublication=gate.provider.requests.filter(row=>!row.listing).length;
 const reportViewId=await review.evaluate(()=>window.__workspaceScope.viewId),layout=await gate.shell.evaluate(()=>window.__workspaceGroups.snapshot());
 await gate.invoke('workspace.command',{projectId:gate.projectId,expectedRevision:layout.revision,requestKey:'return-report-'+nonce,command:{type:'activate',viewId:reportViewId}});
 await review.waitForSelector('[data-review-action="accept"]:not([disabled])',{visible:true});
 await review.click('[data-review-action="accept"]');
 await review.waitForSelector('[data-confirmation-dialog][open]',{visible:true});
 const confirmation=await review.$eval('[data-confirmation-dialog]',node=>node.innerText);
 assert(confirmation.includes('paper.txt'),'acceptance confirmation names the actual candidate file');
 result.confirmation=confirmation;
 result.screenshots.push(await shot('03-acceptance-confirmation'));
 await review.click('[data-confirmation-confirm]');
 const ended=await until(async()=>{
  const s=await gate.status();const w=s.works.find(row=>row.id===work.id);
  if(w?.closure?.phase==='blocked')throw Error('closure blocked: '+JSON.stringify(w.closure));
  return w&&w.status==='ended'&&w.outcome==='accept'&&w.closure?.phase==='complete'?w:null;
 },'explicit acceptance merges and completes closure',300000);
 assert.equal(await fs.readFile(path.join(gate.root,'paper.txt'),'utf8'),candidate,'only explicit acceptance merges the exact candidate bytes');
 assert.equal(await rawGit('show','HEAD:paper.txt'),candidate,'merged candidate committed byte-exact on the project branch');
 assert.notEqual(await git('rev-parse','HEAD'),head,'acceptance creates the real merge commit');
 assert.equal((await git('status','--porcelain')).length,0);
 assert.equal(await fs.readFile(path.join(gate.root,'unrelated.txt'),'utf8'),'Unrelated synthetic document.\n');
 await until(async()=>fs.stat(work.execution.directory).then(()=>null,()=>true),'worker execution directory cleaned after closure',60000);
 // Actual user acceptance may admit ONE legitimate bound original-Orchestrator
 // closeout; never a repeated business Worker/intake input.
 const settledJobIds=new Set(settled.jobs.map(job=>job.id));
 const finalState=await until(async()=>{const s=await gate.status();return s.jobs.some(job=>['queued','running','transferring'].includes(job.status))?null:s;},'post-acceptance jobs settle (closeout included)',60000);
 const laterRequests=gate.provider.requests.filter(row=>!row.listing).slice(requestsAtPublication);
 assert(laterRequests.length<=3,'at most one bounded original-Orchestrator closeout, never repeated turns');
 for(const request of laterRequests){
  assert(!request.tools?.some(tool=>tool.function?.name==='nozeli_publish'),'no repeated business Worker input after acceptance');
 }
 const added=finalState.jobs.filter(job=>!settledJobIds.has(job.id));
 assert(added.length<=1,'at most one legitimate bound closeout job after acceptance');
 for(const job of added){
  assert.equal(job.target,'orchestrator','only an original-Orchestrator closeout may run after acceptance');
  assert.notEqual(job.type,'intake','closeout never admits new business intake');
  assert.equal(job.status,'completed','closeout settles');
 }
 assert.equal(finalState.works.length,1,'still exactly one original Work');
 assert.equal(finalState.jobs.filter(job=>job.target===work.id).length,1,'original Worker input never repeated');
 assert.equal(finalState.jobs.filter(job=>job.type==='intake'&&job.target==='orchestrator').length,1,'no repeated intake input');
 assert.equal(finalState.receipts.filter(row=>row.workId===work.id&&row.kind==='result').length,1,'one original publication');
 assert.equal(finalState.jobs.filter(job=>job.type==='maintenance').length,0,'no automatic DEBUG/maintenance job for the corrected path');
 assert.equal(scenario.dispatches,1);assert.equal(scenario.publications,1);
 result.closeoutRequests=laterRequests.map(request=>({tools:request.tools?.map(tool=>tool.function?.name)??[],turns:(request.messages??[]).length}));
 checks.push('explicit footer acceptance merges exact bytes, commits them, completes closure and cleans the worker directory; zero or one bound original-Orchestrator closeout only, never repeated Worker/intake input');
 assert(!gate.provider.requests.some(request=>request.messages?.some(message=>message.role==='assistant'&&message.tool_calls?.some(call=>call.function?.name==='nozeli_maintenance'))),'no actual maintenance invocation for the successfully corrected read');
 result.screenshots.push(await shot('04-merged-complete'));
 if(gate.captures)result.captures=gate.captures;
 // Shared close flushes durable state; then read the on-disk sanitized ledger.
 const closeResult=await gate.close();
 assert.deepEqual(closeResult,{code:0,signal:null},'owned installed app exits 0 through session.requestClose');
 assert(!gate.closeInfo.installedBytesChanged,'installed bytes must not change during the gate: '+JSON.stringify(gate.closeInfo.installedBytesChanged));
 const identity=gate.identity;
 if(identity?.gitIdentity){const {command,version,source}=identity.gitIdentity;identity.gitIdentity={command,version,source};}
 result.installed.identity=identity;
 const finalLedgerPath=await ledgerPath();
 const ui=new DatabaseSync(finalLedgerPath,{readOnly:true});
 try{
   const ledgerRow=ui.prepare("SELECT value FROM records WHERE collection=? AND id=?").get(gate.ledgerCollection??"ui",gate.ledgerRecord??"managed:maintenance");
   assert(ledgerRow,'durable maintenance ledger on disk at '+finalLedgerPath);
   const ledger=JSON.parse(ledgerRow.value);
   assert.equal(ledger.schema,1);
   const bug=ledger.bugs.find(row=>row.error?.code==='READ_TOOL_MISMATCH'&&row.jobId===workerJobId);
   assert(bug,'on-disk ledger keeps the corrected fault');
   assert.equal(bug.status,'repaired');
   assert.equal(bug.capability,'same-turn-read-correction');
   assert.equal(bug.lastOutcome.verified,true);
   assert.equal(bug.lastOutcome.outcome,'same-turn-read-corrected');
   assert.deepEqual(bug.attempts,[]);
   assert(!bug.debug,'no automatic DEBUG diagnosis for the corrected path');
   const serialized=JSON.stringify(ledger);
   assert(!serialized.includes(marker)&&!serialized.includes(oldText)&&!serialized.includes(scenario.failedRef),'ledger never persists document text or raw capability refs');
   result.ledger={ledgerPath:finalLedgerPath,instanceId:gate.instanceId??null,bugId:bug.id,status:bug.status,lastOutcome:bug.lastOutcome,sanitized:true};
   checks.push('on-disk sanitized ledger records the repaired bug with the exact verified same-turn correction receipt and no automatic DEBUG entry');
 }finally{ui.close();}
 assert.equal(gate.provider.errors.length,0);
 assert.deepEqual(gate.errors,[],'installed renderer surfaces stay error-free');
 result.unexpectedModelTurns=unexpected;
 result.identity=scenario.identity;result.trace=scenario.trace;result.toolReceipts=toolReceipts;
 result.work={id:ended.id,status:ended.status,outcome:ended.outcome,threadId:ended.threadId,closure:ended.closure};
 result.providerRequests=gate.provider.requests.length;
 result.ok=true;
}catch(error){
 result.error=error.stack;result.trace=scenario.trace;result.toolReceipts=toolReceipts;result.identity=scenario.identity;
 result.unexpectedModelTurns=unexpected;result.stage=scenario.stage;
 try{result.screenshots.push(await shot('failure'));}catch{}
 try{await gate.close();}catch(closeError){result.closeError=String(closeError);}
 process.exitCode=1;
}finally{
 const reportDir=gate?.out??await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-installed-read-protocol-')).catch(()=>null);
 if(reportDir)try{await fs.writeFile(path.join(reportDir,'report.json'),JSON.stringify(result,null,2));}catch(writeError){console.error('report.json failed:',writeError);}
 console.log(JSON.stringify(result,null,2));
}
