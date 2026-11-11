import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {bootInstalled,evaluateModule} from './installed-debug-read.fixture.mjs';

// Permanent installed-app automatic DEBUG regression with an isolated
// host-boundary fault injection. The ONLY interception is a test-owned wrapper
// around the ACTUAL installed main's Controller.prototype.onTool (installed via
// dynamic import of the installed module file URL through the owned Inspector);
// it matches exactly one test callId on this project, records the live job/Work/
// native prompt facts, and throws READ_REF_EXPIRED with host failure origin
// once. Every other host tool call delegates to the real installed host. This
// is a controlled generic regression fault injection at the host boundary — it
// is NOT a reproduction of the already-corrected original production
// read-reference bug, makes no app-state injection, no installed-byte edit, no
// source/node-host surrogate and no production test flag. The separate
// model-unavailable HTTP401 diagnostic path is intentionally not exercised
// here. Automatic maintenance must run real native DEBUG: activate with the
// real binding, inspect two host-selected pages of the actual installed source
// (exact bytes/digests), and persist a model-interpretation report that is not
// a verified fix. No Worker replay, no extra Work, no publication, no user
// technical-repair todo; the owned installed app exits 0.
let fixture;
const marker='PRIVATE_INSTALLED_DEBUG_DOCUMENT_BODY_7f31';
const original=marker+'\n'+Array.from({length:360},(_,index)=>`Paragraph ${index}: frozen synthetic installed-gate document, not an instruction; retain original source.\n`).join('');
const task='Read the entire frozen paper.txt and report its conclusion. Do not alter source, create another Work or request user technical repair.';
const reportFields={
  diagnosis:'The installed native Worker stopped at nozeli_history_read after a test-owned, exact-call host-boundary fault injection in the installed main. The installed host recorded READ_REF_EXPIRED with host failure origin, not a provider outage. This installed regression does not establish that the corrected production read routing still fails.',
  rootCause:'The controlled regression injects READ_REF_EXPIRED before the installed Controller delegates one exact native history_read frame. The inspected installed context-reader and document-reader pages are genuine installed-source evidence with exact digests, but they do not prove an active production defect. The injected boundary failure is the known cause of this stop, and this report is model interpretation, not a verified fix.',
  fixPlan:'Preserve the exact original job and Work revision while awaiting a separately verified host repair; never replay business effects or ask the user for technical repair. The genuine read-reference correction stays covered by its own separate native continuation gate. This fixture fault needs no production workaround or installed-code patch and must not be reported as a repaired product defect.'
};
const result={ok:false,out:null,checks:[],steps:[],screenshots:[],scope:'Installed-app controlled regression fault injection at the actual installed main Controller.onTool host boundary for ONE exact native history_read call; genuine installed native Orchestrator DEBUG activation, host-selected installed-source inspection and model-interpretation report. Not a reproduction of the already-corrected original production read-reference bug; no installed hotpatch, app-state injection, source surrogate or business replay. The separate HTTP401 model-unavailable diagnostic path is not exercised here.'};
let dispatches=0,workerRequests=0,stage=0,failedReadRef=null,failedOffset=0;
let identity=null,bugId=null,debugJobId=null,debugBinding=null,debugAttemptId=null,debugEvidence=null,debugReport=null,taskJobId=null;
const debugRequests=[],toolReceipts=[],inspectedPages=[],nativeOwnerSamples=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const call=(id,tool,args)=>({id,tool,args});
const text=content=>typeof content==='string'?content:(content??[]).map(part=>part.text??'').join('\n');
function receipt(request,id){
  const row=request.messages.findLast(message=>message.role==='tool');
  assert(row,'actual native tool response required');
  assert.equal(row.tool_call_id,id);
  const content=text(row.content);
  toolReceipts.push({callId:id,content});
  assert(!content.includes('nozeli host rejected'),content);
  return JSON.parse(content);
}
function success(request,id){const value=receipt(request,id);assert.notEqual(value.ok,false,JSON.stringify(value));return value.value??value;}
async function until(fn,label,timeout=240000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    if(fixture?.provider.errors.length)throw fixture.provider.errors[0];
    const value=await fn();
    if(value)return value;
    await pause(100);
  }
  throw new Error('Timed out: '+label);
}
const controllerUrl=()=>pathToFileURL(path.join(fixture.appRoot,'src','agents','managed','controller.mjs')).href;
const installGate=()=>evaluateModule(fixture.observer,`(async()=>{
  const mod=await import(${JSON.stringify(controllerUrl())});
  const Controller=mod.Controller;
  if(!Controller||typeof Controller.prototype.onTool!=='function')throw Error('installed Controller.onTool not found');
  if(globalThis.__installedDebugGate)return {installed:false,alreadyPresent:true};
  const original=Controller.prototype.onTool;
  globalThis.__installedDebugGate={armed:false,fired:0,delegateCount:0,capture:null,Controller,original};
  Controller.prototype.onTool=async function(target,frame){
    const gate=globalThis.__installedDebugGate;
    if(gate&&gate.armed===true&&frame&&typeof frame==='object'&&frame.callId===gate.callId&&this.projectId===gate.projectId){
      // Exact test callId on this project: capture the live facts, then verify
      // them against the armed expectation BEFORE injecting anything. A second
      // matching call or any mismatch is a test violation: it is recorded and
      // DELEGATED to the real host — never a second synthetic fault.
      const currentJob=(()=>{try{return this.current?.get?.(target)??null}catch{return null}})();
      const persistedJob=(()=>{try{return this.store.state.jobs.find(job=>job.id===currentJob?.id)??null}catch{return null}})();
      const work=(()=>{try{return this.store.find(target)??null}catch{return null}})();
      const sessionRequestId=(()=>{try{return this.sessions.get(target)?.current?.requestId??null}catch{return null}})();
      const observed={projectId:this.projectId,target,callId:frame.callId,tool:frame.tool,promptId:frame.promptId??null,sessionRequestId,arguments:frame.arguments??null,
        currentJobId:currentJob?.id??null,currentJobStatus:persistedJob?.status??null,currentJobType:currentJob?.type??null,
        workId:work?.id??null,workRevision:work?.revision??null,workStatus:work?.status??null,
        maintenanceBugId:currentJob?.maintenanceBugId??null,jobMaintenanceBugId:(()=>{try{return this.store.state.jobs.find(job=>job.id===currentJob?.id)?.maintenanceBugId??null}catch{return null}})(),
        delegateCountAtMatch:gate.delegateCount,at:new Date().toISOString()};
      const expected=gate.expected;
      const validated=gate.fired===0
        &&frame.tool==='nozeli_history_read'
        &&target===expected.workId
        &&((a,b)=>{const eq=(x,y)=>x===y||x&&y&&typeof x==='object'&&typeof y==='object'&&Array.isArray(x)===Array.isArray(y)&&Object.keys(x).length===Object.keys(y).length&&Object.keys(x).every(key=>eq(x[key],y[key]));return eq(a,b);})(frame.arguments??null,expected.arguments)
        &&typeof frame.promptId==='string'&&frame.promptId.length>0&&frame.promptId===sessionRequestId
        &&currentJob!==null&&currentJob.id===expected.jobId&&persistedJob?.status==='running'
        &&work!==null&&work.revision===expected.revision;
      if(gate.fired>0)gate.violation={kind:'duplicate-match',observed};
      else if(!validated)gate.violation={kind:'expected-mismatch',expected:{workId:expected.workId,jobId:expected.jobId,revision:expected.revision,tool:'nozeli_history_read',arguments:expected.arguments},observed};
      if(gate.fired===0&&validated){
        gate.fired=1;
        gate.capture=observed;
        throw Object.assign(Error('Installed gate controlled regression host-boundary fault injection; not a production read-reference defect'),{code:'READ_REF_EXPIRED',failureOrigin:'host'});
      }
    }else if(gate)gate.delegateCount+=1;
    return original.call(this,target,frame);
  };
  return {installed:true};
})()`,30000);
const armGate=(expectedReadRef,expectedOffset)=>fixture.observer.evaluate(`(()=>{
  const gate=globalThis.__installedDebugGate;
  if(!gate)throw Error('installed debug gate not installed');
  gate.callId=${JSON.stringify('installed-debug-history-read')};
  gate.projectId=${JSON.stringify(fixture.projectId)};
  gate.expected=${JSON.stringify({readRef:expectedReadRef,offset:expectedOffset,arguments:{readRef:expectedReadRef,offset:expectedOffset},workId:identity.workId,jobId:identity.jobId,revision:identity.revision,threadId:identity.threadId})};
  gate.armed=true;
  return {armed:true,callId:gate.callId,projectId:gate.projectId};
})()`);
const gateState=()=>fixture.observer.evaluate(`(()=>{const gate=globalThis.__installedDebugGate;return gate?{armed:gate.armed,fired:gate.fired,delegateCount:gate.delegateCount,capture:gate.capture,violation:gate.violation??null,expected:gate.expected??null}:null})()`).catch(()=>null);
const uninstallGate=()=>fixture?.observer?fixture.observer.evaluate(`(()=>{
  const gate=globalThis.__installedDebugGate;
  if(!gate)return false;
  gate.Controller.prototype.onTool=gate.original;
  delete globalThis.__installedDebugGate;
  return true;
})()`).catch(()=>false):Promise.resolve(false);
const scanNativeOwners=async()=>{
  if(!fixture)return [];
  const owners=[];
  for(const entry of await fs.readdir('/proc')){
    if(!/^\d+$/.test(entry))continue;
    try{
      const stat=await fs.readFile('/proc/'+entry+'/stat','utf8');
      const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      if(Number(fields[1])!==fixture.pid)continue;
      const exe=await fs.realpath('/proc/'+entry+'/exe');
      if(!exe.startsWith(fixture.appRoot))continue;
      const argv=(await fs.readFile('/proc/'+entry+'/cmdline')).toString().split('\0').filter(Boolean);
      owners.push({pid:Number(entry),exe,argv:argv.slice(0,6)});
    }catch{/* raced process exit */}
  }
  return owners;
};
const assertInstalledPage=async(page,file)=>{
  assert.equal(page.path,'src/agents/managed/'+file);
  const source=await fs.readFile(path.join(fixture.appRoot,'src','agents','managed',file),'utf8');
  assert.equal(page.text,source.split('\n').slice(page.startLine-1,page.endLine).join('\n'),'inspected page equals the exact installed source bytes');
  assert(page.endLine-page.startLine<80,'host-selected page stays under the 80-line bound');
  assert(Buffer.byteLength(page.text)<=12288,'inspected page respects the byte ceiling');
  assert.equal(page.digest,createHash('sha256').update(source).digest('hex'),'page digest matches the actual installed file');
  inspectedPages.push({file,startLine:page.startLine,endLine:page.endLine,digest:page.digest,textBytes:Buffer.byteLength(page.text)});
};
const readUiRecord=(file,id)=>{
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const row=db.prepare('SELECT value FROM records WHERE collection=? AND id=?').get('ui',id);
    assert(row,'on-disk sqlite ui record exists: '+id);
    return JSON.parse(row.value);
  }finally{db.close();}
};
// The app is still running during provider stages: a read-only probe can race
// an in-flight commit; bounded retry, identical assertions either way.
const readUiRecordLive=async(file,id,tries=6)=>{
  let last;
  for(let attempt=0;attempt<tries;attempt++){
    try{return readUiRecord(file,id);}
    catch(error){last=error;await pause(150);}
  }
  throw last;
};
const handler=async request=>{
  assert(fixture&&fixture.provider.requests.length<30,'bounded native requests, no recursive debug loop');
  const names=request.tools?.map(tool=>tool.function?.name)??[];
  if(names.includes('nozeli_maintenance')){
    const state=await fixture.status();
    const job=state.jobs.find(row=>row.type==='maintenance');
    if(job&&['queued','running'].includes(job.status)){
      if(!debugJobId){debugJobId=job.id;bugId=job.context?.bugId;assert(bugId,'automatic maintenance event carries the exact bug identity');}
      assert.equal(job.id,debugJobId,'one automatic diagnostic event, no tight requeue loop');
      assert.equal(job.context?.bugId,bugId);
      debugRequests.push({jobId:job.id,stage,nativeUserInputs:request.messages.filter(message=>message.role==='user').length});
      if(stage===0){
        const failed=state.jobs.find(row=>row.id===identity.jobId);
        assert.equal(failed.status,'failed','injected host failure fails the original native Worker job');
        assert.equal(failed.hostToolCode,'READ_REF_EXPIRED');
        const work=state.works.find(row=>row.id===identity.workId);
        assert.equal(work.revision,identity.revision,'original Work revision retained');
        assert.equal(work.maintenance?.bugId,bugId,'affected Work is bound to the exact bug');
        // Raw durable ledger straight from the owned profile sqlite (read-only),
        // not from any projected/paginated status endpoint.
        const durableNow=await readUiRecordLive(fixture.ledgerFile,'managed:maintenance');
        assert.equal(durableNow.bugs.length,1,'exactly one durable bug before DEBUG activation');
        const bugNow=durableNow.bugs[0];
        assert.equal(bugNow.id,bugId,'maintenance job and durable ledger name the same bug');
        assert.equal(bugNow.error.code,'READ_REF_EXPIRED');
        assert.equal(bugNow.jobId,identity.jobId);
        assert.equal(bugNow.workId,identity.workId);
        assert.equal(bugNow.revision,identity.revision);
        stage=1;
        return call('activate-debug','nozeli_maintenance',{action:'debug',bugId});
      }
      if(stage===1){
        const activated=success(request,'activate-debug');
        debugBinding=activated.binding;debugAttemptId=activated.attemptId;debugEvidence=activated.evidence;
        assert.equal(activated.readOnly,true);
        assert.equal(activated.debug.state,'running');
        assert(debugAttemptId,'real attempt identity issued');
        assert.equal(debugEvidence.error.code,'READ_REF_EXPIRED','exact injected host failure reaches durable automatic DEBUG');
        assert.equal(debugEvidence.originalJob.id,identity.jobId);
        assert.equal(debugEvidence.originalJob.revision,identity.revision);
        assert.equal(debugEvidence.originalJob.hostToolCode,'READ_REF_EXPIRED');
        assert(!JSON.stringify(activated).includes(marker),'evidence never embeds document bytes');
        assert(!JSON.stringify(activated).includes(failedReadRef),'evidence never embeds the failed read reference');
        nativeOwnerSamples.push({at:'debug-activation',owners:await scanNativeOwners()});
        const context=debugEvidence.sources.find(row=>row.path.endsWith('/context-reader.mjs'));
        assert(context,'host selects the installed context-reader source');
        stage=2;
        return call('inspect-context-reader','nozeli_maintenance',{action:'debug.inspect',bugId,attemptId:debugAttemptId,sourceId:context.sourceId,startLine:1,lineCount:80});
      }
      if(stage===2){
        const page=success(request,'inspect-context-reader');
        await assertInstalledPage(page,'context-reader.mjs');
        const documentSource=debugEvidence.sources.find(row=>row.path.endsWith('/document-reader.mjs'));
        assert(documentSource,'host selects the installed document-reader source');
        stage=3;
        return call('inspect-document-reader','nozeli_maintenance',{action:'debug.inspect',bugId,attemptId:debugAttemptId,sourceId:documentSource.sourceId,startLine:1,lineCount:80});
      }
      if(stage===3){
        const page=success(request,'inspect-document-reader');
        await assertInstalledPage(page,'document-reader.mjs');
        stage=4;
        return call('submit-debug-diagnosis','nozeli_maintenance',{action:'debug.report',bugId,attemptId:debugAttemptId,...reportFields});
      }
      // No stage-4 handler: the report receipt without a host-proven
      // continuation capability is an explicit terminal host result
      // (continueTurn:false), so the installed native owner ends the turn
      // without another provider request; the persisted report is observed
      // below straight from the owned sqlite ledger.
      throw new Error('Unexpected diagnostic prompt after completed report');
    }
  }
  if(names.includes('nozeli_publish')){
    if(workerRequests++===0)return call('original-document','nozeli_document_read',{relPath:'paper.txt'});
    assert.equal(workerRequests,2,'original fatal tool must end the native Worker, never replay or continue: '+JSON.stringify(request.messages.findLast(message=>message.role==='tool')));
    const document=success(request,'original-document');
    assert.equal(document.relPath,'paper.txt');
    assert(document.nextReadRef,'real document exceeds one native page');
    assert.equal(document.text,original.slice(document.offset,document.endOffset),'first native page equals the exact frozen file bytes');
    failedReadRef=document.nextReadRef;failedOffset=document.endOffset;
    const state=await fixture.status();
    const work=state.works.find(row=>row.name==='Original read blocker');
    assert(work,'dispatched Work exists before the injected call');
    const job=state.jobs.find(row=>row.target===work.id&&row.status==='running');
    assert(job,'one running original native Worker job');
    identity={projectId:fixture.projectId,workId:work.id,revision:work.revision,threadId:work.threadId,jobId:job.id};
    nativeOwnerSamples.push({at:'worker-turn',owners:await scanNativeOwners()});
    const armed=await armGate(failedReadRef,failedOffset);
    assert.equal(armed.callId,'installed-debug-history-read');
    return call('installed-debug-history-read','nozeli_history_read',{readRef:failedReadRef,offset:failedOffset});
  }
  if(names.includes('nozeli_dispatch')){
    assert.equal(dispatches++,0,'one original explicit business dispatch');
    return call('original-dispatch','nozeli_dispatch',{name:'Original read blocker',brief:task});
  }
  return {text:'Preserve the original request and explicit user authorization; no additional business dispatch.'};
};
try{
  fixture=await bootInstalled({scenario:{name:'Installed debug activation'},files:{'paper.txt':original,'.gitignore':'/.nozeli/\n'},handler});
  result.out=fixture.out;
  result.installed=fixture.identity;
  result.projectId=fixture.projectId;
  result.ledgerFile=fixture.ledgerFile;
  result.boot={providerRequestsDuringBoot:0,registration:fixture.registration};
  const installed=await installGate();
  assert.equal(installed.installed,true,'test wrapper installed on the actual installed Controller prototype');
  const before=await gateState();
  assert(before&&before.armed===false&&before.fired===0,'gate idle after installation');
  const submitted=await fixture.invoke('managed.task',{projectId:fixture.projectId,text:task,requestKey:'installed-debug-original-1'});
  taskJobId=submitted.jobId;
  assert(taskJobId,'managed.task returns the original intake job identity');
  await until(async()=>{
    const live=await gateState();
    if(live?.violation)throw new Error('hardened gate refused to inject; wrapper-side violation: '+JSON.stringify(live.violation));
    if(stage!==4)return false;
    const state=await fixture.status();
    return state.jobs.find(row=>row.id===debugJobId)?.status==='completed';
  },'injected host failure followed by the terminal installed debug report receipt');
  await until(async()=>{
    const state=await fixture.status();
    return !state.jobs.some(job=>['queued','running','transferring'].includes(job.status));
  },'owned installed app settles after the terminal debug report');
  // The report is observed from the durable owned ledger after the terminal
  // host receipt, not from any follow-up model request.
  const reportedLedger=await readUiRecordLive(fixture.ledgerFile,'managed:maintenance');
  const reportedBug=reportedLedger.bugs.find(row=>row.id===bugId);
  debugReport=reportedBug.debug.report;
  assert.equal(reportedBug.debug.state,'awaiting-fix','durable debug settles awaiting-fix after the terminal report receipt');
  assert.equal(debugReport.version,1);
  assert.equal(debugReport.kind,'model-interpretation');
  assert.equal(debugReport.verifiedFix,false,'diagnosis is never a verified fix');
  assert.deepEqual(debugReport.binding,debugBinding,'report is bound to the actual debug binding');
  for(const field of Object.keys(reportFields))assert.equal(debugReport[field],reportFields[field]);
  const gate=await gateState();
  assert(gate,'gate state readable after the flow');
  assert(!gate.violation,'hardened gate refused to inject; wrapper-side violation: '+JSON.stringify(gate.violation));
  assert.equal(gate.fired,1,'exactly one host-boundary injection');
  assert(gate.delegateCount>=1,'every other installed host tool call delegated to the real host');
  const fault=gate.capture;
  assert(fault,'the intercepted installed host call was captured live');
  assert.equal(fault.callId,'installed-debug-history-read','interception matches only the exact test callId');
  assert.equal(fault.projectId,fixture.projectId);
  assert.equal(fault.target,identity.workId);
  assert.equal(fault.tool,'nozeli_history_read');
  assert.deepEqual(fault.arguments,{readRef:failedReadRef,offset:failedOffset});
  assert(Number.isSafeInteger(failedOffset)&&failedOffset>0);
  assert.equal(fault.currentJobId,identity.jobId,'injection hits the actual current native job');
  assert.equal(fault.currentJobStatus,'running');
  assert.equal(fault.workId,identity.workId);
  assert.equal(fault.workRevision,identity.revision,'injection hits the actual current Work revision');
  assert(typeof fault.promptId==='string'&&fault.promptId,'native prompt identity captured');
  assert.equal(fault.promptId,fault.sessionRequestId,'injected call belongs to the live native Worker prompt');
  assert.equal(fault.maintenanceBugId,null,'injection happens before any failure bookkeeping');
  assert.deepEqual(gate.expected,{readRef:failedReadRef,offset:failedOffset,arguments:{readRef:failedReadRef,offset:failedOffset},workId:identity.workId,jobId:identity.jobId,revision:identity.revision,threadId:identity.threadId});
  result.faultInjection={kind:'test-owned-installed-main-boundary',...fault,code:'READ_REF_EXPIRED',failureOrigin:'host',exactReadRefMatched:true,delegatedOtherCalls:gate.delegateCount};
  const settled=await fixture.status();
  const work=settled.works.find(row=>row.id===identity.workId);
  assert.equal(settled.works.length,1,'no replacement or extra business Work');
  assert.equal(work.revision,identity.revision);
  assert.equal(work.threadId,identity.threadId);
  assert.notEqual(work.status,'review');
  assert.equal(work.maintenance.bugId,bugId);
  assert.equal(work.maintenance.status,'needs-version-fix','affected Work projects internal system maintenance state');
  result.workMaintenanceMessage=work.maintenance.message;
  const workerJobs=settled.jobs.filter(job=>job.target===work.id);
  assert.equal(workerJobs.length,1,'no business replay or supplementary Worker input');
  assert.equal(workerJobs[0].id,identity.jobId);
  assert.equal(workerJobs[0].status,'failed');
  assert.equal(workerJobs[0].hostToolCode,'READ_REF_EXPIRED');
  assert.equal(workerJobs[0].collabAttempts.length,1);
  const taskJob=settled.jobs.find(job=>job.id===taskJobId);
  assert.equal(taskJob.status,'completed','original explicit intake completed after dispatch');
  const maintenanceJobs=settled.jobs.filter(job=>job.type==='maintenance');
  assert.equal(maintenanceJobs.length,1,'exactly one automatic diagnostic event (HTTP401 model-unavailable path not exercised here)');
  assert.equal(maintenanceJobs[0].id,debugJobId);
  assert.equal(maintenanceJobs[0].status,'completed','completion follows exact evidence and report, not prose');
  assert.equal(settled.receipts.filter(row=>row.workId===work.id).length,0,'diagnosis is not business publication');
  const actionable=settled.todos.filter(todo=>todo.status==='open'&&(todo.workId===work.id||todo.sourceJobId===identity.jobId));
  assert.deepEqual(actionable,[],'program bug must not ask the user for technical repair or decision');
  result.identity=identity;result.jobs=structuredClone(settled.jobs);result.work=structuredClone(work);result.debugRequests=debugRequests;result.inspectedPages=inspectedPages;
  // Native owners really run the installed bundled runtime while business runs.
  const ownerSamples=nativeOwnerSamples.flatMap(sample=>sample.owners.map(owner=>({...owner,at:sample.at})));
  result.nativeOwners=ownerSamples;
  const live=ownerSamples.filter(owner=>owner.exe.startsWith(path.join(fixture.appRoot,'runtime','node')+path.sep));
  assert(live.length>=1,'native owners observable under the installed bundled Node runtime');
  for(const owner of live)assert(owner.exe.startsWith(path.join(fixture.appRoot,'runtime','node')+path.sep),'native owner runs the installed bundled Node runtime: '+owner.exe);
  // Settled diagnosis must not spin a requeue loop.
  const requestBaseline=fixture.provider.requests.length;
  await pause(300);
  assert.equal(fixture.provider.requests.length,requestBaseline,'awaiting source fix never spins a diagnostic requeue');
  // Actual UI capture of the affected Work without any extra model request.
  const shell=fixture.shell;
  if(await shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true').catch(()=>false))await shell.click('#toggle-sidebar');
  await shell.waitForSelector('[data-managed-work="'+work.id+'"]',{visible:true,timeout:15000});
  const rowText=await shell.$eval('[data-managed-work="'+work.id+'"]',node=>node.innerText);
  assert(rowText.includes('Original read blocker'),'UI keeps the original Work visible with its name');
  result.uiWorkRowText=rowText;
  result.screenshots.push(await fixture.capture('01-installed-shell-work-system-maintenance'));
  assert.equal(fixture.provider.requests.length,requestBaseline,'UI reads never issue model requests');
  assert.deepEqual(fixture.provider.errors,[]);
  assert.deepEqual(fixture.errors,[]);
  result.providerBreakdown={dispatches,workerRequests,diagnosticRequests:debugRequests.length,total:fixture.provider.requests.length,listings:fixture.provider.requests.filter(row=>row.listing).length};
  checks1();
  // Normal owned exit and on-disk sqlite ledger after flush.
  assert.equal(await uninstallGate(),true,'test wrapper removed from the installed Controller prototype');
  const closed=await fixture.close();
  assert.deepEqual(closed,{code:0,signal:null},'owned installed app exits 0 through session.requestClose');
  assert(!fixture.closeInfo.installedBytesChanged,'installed release bytes unchanged by the gate: '+(fixture.closeInfo.installedBytesChanged||'').toString());
  const durable=readUiRecord(fixture.ledgerFile,'managed:maintenance');
  assert.equal(durable.schema,1);
  assert.equal(durable.bugs.length,1,'no recursive program bugs from the single injected failure');
  const bug=durable.bugs.find(row=>row.id===bugId);
  assert(bug,'exact injected bug persisted in the on-disk sqlite ledger');
  assert.equal(bug.projectId,fixture.projectId);
  assert.equal(bug.jobId,identity.jobId);
  assert.equal(bug.workId,identity.workId);
  assert.equal(bug.revision,identity.revision);
  assert.equal(bug.error.code,'READ_REF_EXPIRED');
  assert.notEqual(bug.status,'repaired');
  assert(!bug.attempts.some(row=>row.status==='verified'),'no verified host repair manufactured by diagnosis');
  assert.equal(bug.debug.schema,1);
  assert.equal(bug.debug.state,'awaiting-fix');
  assert.equal(bug.debug.eventJobId,debugJobId,'durable debug event is the exact automatic maintenance job');
  assert.equal(bug.debug.attemptId,debugAttemptId,'durable debug attempt is the exact real attempt');
  assert.deepEqual(bug.debug.binding,debugBinding);
  assert.deepEqual(bug.debug.evidence,debugEvidence);
  assert.deepEqual(bug.debug.report,debugReport,'durable report is the exact model interpretation submitted through the real binding');
  assert.equal(bug.debug.inspections.length,2,'exactly two host-selected source inspections recorded');
  for(const inspection of bug.debug.inspections){
    assert(debugEvidence.sources.some(row=>row.sourceId===inspection.sourceId&&row.digest===inspection.digest),'inspections bind to host-selected installed sources');
    assert(inspection.endLine-inspection.startLine<80);
  }
  const serialized=JSON.stringify(durable);
  assert(!serialized.includes(marker),'ledger never embeds document bytes');
  assert(!serialized.includes(failedReadRef),'ledger never embeds the failed read reference');
  assert(!serialized.includes(original.slice(0,200)));
  result.ledger=durable;
  // Original source and Git baseline stay untouched.
  assert.equal(await fs.readFile(path.join(fixture.root,'paper.txt'),'utf8'),original);
  assert.equal(await fixture.git('rev-parse','HEAD'),fixture.head,'installed regression diagnosis never changes source or merges');
  checks2();
  result.ok=true;
  result.requests=fixture.provider.requests.length;
}catch(error){
  result.error=String(error?.stack??error);
  console.error(result.error);
  process.exitCode=1;
  try{result.screenshots.push(await fixture.capture('failure'));}
  catch{/* capture is best effort on failure */}
  result.surface=await fixture?.shell?.evaluate(()=>document.body.innerText.slice(-7000)).catch(()=>null);
}finally{
  await uninstallGate();
  const closed=await fixture?.close().catch(error=>({code:null,signal:null,closeError:String(error?.message??error)}));
  if(fixture&&!result.ledger){try{result.finalLedger=readUiRecord(fixture.ledgerFile,'managed:maintenance');}catch(error){result.finalLedger={error:String(error?.message??error)};}}
  if(closed&&result.ok!==true)result.close=closed;
  if(fixture){
    try{
      await fs.writeFile(path.join(fixture.out,'native-proof.json'),JSON.stringify({toolReceipts,identity,debugRequests,inspectedPages,nativeOwnerSamples,nativeOwners:result.nativeOwners??null},null,2));
      await fs.writeFile(path.join(fixture.out,'report.json'),JSON.stringify(result,null,2));
    }catch(error){console.error('report write failed:',error?.message??error);process.exitCode=1;}
  }else console.error('installed boot failed before fixture creation; report.json unavailable');
}
function checks1(){
  result.checks.push('test wrapper on the actual installed Controller.prototype.onTool injected READ_REF_EXPIRED (failureOrigin host) for exactly one exact test callId/projectId with live job/Work/native prompt/ref/offset identity; every other call delegated');
  result.checks.push('real installed Worker read the long synthetic file with a genuine nozeli_document_read page and then issued the exact injected nozeli_history_read call; the failed job retained hostToolCode READ_REF_EXPIRED with one collab attempt');
  result.checks.push('automatic installed maintenance ran real native DEBUG: one activation with real binding/attempt, two host-selected installed-source inspections with exact bytes and digests, and a model-interpretation report persisted after the terminal host-control receipt (no post-report model request)');
  result.checks.push('no Worker replay, extra Work, publication, user technical-repair todo or diagnostic requeue; original intake job completed and original source/Git baseline unchanged');
}
function checks2(){
  result.checks.push('on-disk sqlite ui managed:maintenance ledger holds the interpretation with verifiedFix=false/awaiting-fix and the exact original job/Work/revision/attempt/event/inspections/digests');
  result.checks.push('actual installed app UI captured the affected Work under system maintenance with zero additional model requests; owned app exited 0 and installed bytes stayed unchanged');
}
