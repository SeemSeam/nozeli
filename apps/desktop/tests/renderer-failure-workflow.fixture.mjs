import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';

// Opt-in paid-model journey. Only the owned conversation renderer is crashed;
// native recovery dialogs are recorded and explicitly accepted by the driver.
export async function runRendererFailureAudit({state,compose,call,wait,pause,shell,shot,result,out,fs,path,scoped,observer,openReport}){
 const projectId=(await call('workspace.bootstrap')).projectId;
 const checkpointRel='owner-isolation-checkpoint.txt',finalRel='owner-isolation-final.txt';
 let chat=await scoped('conversation');
 const scope=await call('workspace.bootstrap',{},chat);
 const windows=await call('workspace.windows.list',{projectId});
 const surface=windows.flatMap(w=>w.surfaces).find(s=>s.viewId===scope.viewId);
 assert(surface,'Owned conversation surface is registered');
 const renderer=await observer.evaluate(`(()=>{const {webContents}=process.mainModule.require('electron'),wc=webContents.fromId(${surface.webContentsId});if(!wc||wc.isDestroyed())throw Error('Owned content missing');return {id:wc.id,pid:wc.getOSProcessId()};})()`);
 // Resolve the shell PID directly from the actual shell target, not its URL.
 const shellId=(await call('workspace.windows.list',{projectId})).find(w=>w.id==='main')?.nativeWindowId;
 const shellPid=await observer.evaluate(`process.mainModule.require('electron').BrowserWindow.fromId(${shellId}).webContents.getOSProcessId()`);
 assert.notEqual(renderer.pid,shellPid,'Crash must not include the shell renderer');
 const rendererStamp=await processStamp(renderer.pid);assert(rendererStamp,'Owned renderer birth stamp is available');
 const before=await state(),known=new Set(before.works.map(w=>w.id));
 const protectedWorks=before.works.filter(w=>w.status==='paused'||w.closure?.phase==='blocked').map(w=>({id:w.id,status:w.status,threadId:w.threadId,closure:w.closure,draft:before.drafts[w.id]}));
 console.log(JSON.stringify({out,stage:'renderer-ownership-verified',rendererPid:renderer.pid,shellPid,protectedWorkIds:protectedWorks.map(w=>w.id)}));
 await call('workspace.control',{type:'conversation-action',projectId,action:'select',target:'frontdesk'});
 await compose('新建独立验证工作“原生Owner在途隔离核验”：只在本工作候选中先写 owner-isolation-checkpoint.txt 内容为 OWNER_ISOLATION_READY，随后真实运行一次 node tools/wait-gate.mjs 120，工具结束后写 owner-isolation-final.txt 内容为 OWNER_ISOLATION_COMPLETE 并发布 result。gate-start.json 和 gate-end.json 是允许证据。不改其他基线文件，不运行Git，不自动采用或结束。程序负责界面和进程恢复，你只完成这一个独立验证目标，不重启会话、不重派任务、不执行旧项目业务。',true);
 const work=await wait(async()=>(await state()).works.find(w=>!known.has(w.id)),'new renderer-failure Work',180000);
 const ready=await wait(async()=>{
  const s=await state(),w=s.works.find(w=>w.id===work.id),provider=s.providers?.[work.id],job=s.jobs.filter(j=>j.target===work.id).at(-1);
  if(!w?.execution||!provider||job?.status!=='running')return false;
  try{const checkpoint=await fs.readFile(path.join(w.execution.directory,checkpointRel),'utf8'),gate=JSON.parse(await fs.readFile(path.join(w.execution.directory,'gate-start.json'),'utf8'));return checkpoint.trim()==='OWNER_ISOLATION_READY'?{work:w,provider,job,gate}:false;}catch{return false;}
 },'real native tool checkpoint',240000);
 console.log(JSON.stringify({out,stage:'real-native-tool-checkpoint',workId:work.id,threadId:ready.work.threadId,jobId:ready.job.id,nativePid:ready.provider.pid}));
 if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');
 const row='[data-managed-work="'+work.id+'"]';await shell.locator(row+' .managed-work-open').click();chat=await scoped('conversation');
 await chat.waitForFunction(id=>document.querySelector('#conversation-panel').dataset.managedConversation===id,{},work.id);
 const draft='RENDERER_CRASH_UNSENT_'+work.id;await chat.locator('#composer').fill(draft);
 await wait(async()=>(await state()).drafts[work.id]===draft,'durable new Work draft');
 await wait(async()=>(await call('workspace.bootstrap',{},chat)).viewState?.conversationInput?.target===work.id&&(await call('workspace.bootstrap',{},chat)).viewState?.workspace?.draft===draft,'durable input identity');
 assert.equal(await processStamp(ready.provider.pid),ready.provider.stamp,'Native ownership still matches');
 const liveScope=await call('workspace.bootstrap',{},chat),liveWindows=await call('workspace.windows.list',{projectId}),liveSurface=liveWindows.flatMap(w=>w.surfaces).find(s=>s.viewId===liveScope.viewId);
 assert.equal(liveSurface.webContentsId,surface.webContentsId,'Same owned surface before injection');
 await shot('renderer-crash-before',chat);
 result.rendererFault={workId:work.id,threadId:ready.work.threadId,jobId:ready.job.id,nativePid:ready.provider.pid,nativeStamp:ready.provider.stamp,rendererPid:renderer.pid,rendererStamp,signal:'SIGKILL',webContentsId:surface.webContentsId,t0:Date.now(),draft,dialogAutomation:'Actual native recovery calls recorded; two explicit reload confirmations supplied by owned test driver, not OS pointer qualification. SIGKILL process-loss coverage, not SIGABRT/core-dump timing coverage.'};
 const atInjection = await state(), liveJob = atInjection.jobs.find(job=>job.id===ready.job.id);
 assert.equal(liveJob?.status,'running','Original job must still be running immediately before injection');
 const toolStart = JSON.parse(await fs.readFile(path.join(ready.work.execution.directory,'gate-start.json'),'utf8'));
 const priorEnd = await fs.readFile(path.join(ready.work.execution.directory,'gate-end.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 assert.equal(toolStart.at,ready.gate.at,'Same native tool invocation');assert(!priorEnd||priorEnd.at<toolStart.at,'The current native tool must not have ended before injection');
 const requestIdentity = job => (job.collabAttempts||[]).map(({requestId,sessionId,epoch,kind,contentDigest,attempt})=>({requestId,sessionId,epoch,kind,contentDigest,attempt}));
 const attemptsAtInjection = requestIdentity(liveJob);assert(attemptsAtInjection.some(attempt=>attempt.kind==='prompt'));
 result.rendererFault.beforeInjection={at:Date.now(),jobStatus:liveJob.status,toolStart,priorEnd,attempts:attemptsAtInjection};
 await fs.writeFile(path.join(out,'before-injection-state.json'),JSON.stringify(atInjection,null,2));
 await observer.evaluate(`(()=>{const {dialog,webContents}=process.mainModule.require('electron'),fs=process.mainModule.require('node:fs'),wc=webContents.fromId(${surface.webContentsId});if(!wc||wc.isDestroyed()||wc.getOSProcessId()!==${renderer.pid})throw Error('Renderer ownership changed');globalThis.rendererAuditDialogs=[];globalThis.rendererAuditRecoveryGates=[];globalThis.rendererAuditRecoveryAnswers=[];globalThis.rendererAuditOriginalDialog=dialog.showMessageBox;dialog.showMessageBox=async function(win,options){if(options?.title==='内容页面恢复'||options?.message==='确认重新加载内容？未保存的输入可能丢失。'){const index=rendererAuditDialogs.length;rendererAuditDialogs.push({at:Date.now(),title:options.title,message:options.message,buttons:options.buttons,defaultId:options.defaultId,cancelId:options.cancelId});return new Promise(resolve=>rendererAuditRecoveryGates.push(()=>{rendererAuditRecoveryAnswers.push({at:Date.now(),index,response:1});resolve({response:1,checkboxChecked:false});}));}return rendererAuditOriginalDialog.apply(this,arguments);};globalThis.rendererAuditGone=[];wc.prependOnceListener('render-process-gone',(_,details)=>{const fact={at:Date.now(),details};rendererAuditGone.push(fact);fs.writeFileSync(${JSON.stringify(path.join(out,'renderer-gone-event.json'))},JSON.stringify(fact));});return true;})()`);
 try{
 assert.equal(await processStamp(renderer.pid),rendererStamp,'Renderer ownership unchanged after final in-flight checks');
 result.rendererFault.t0=Date.now();
 process.kill(renderer.pid,'SIGKILL');
  await wait(()=>observer.evaluate('globalThis.rendererAuditGone?.length===1'),'actual render-process-gone');
  const beforeRecovery=await state();result.rendererFault.beforeRecoveryAt=Date.now();await fs.writeFile(path.join(out,'after-injection-before-recovery-state.json'),JSON.stringify(beforeRecovery,null,2));
  await wait(()=>observer.evaluate('globalThis.rendererAuditRecoveryGates?.length===1'),'first native recovery choice');(result.interventions??=[]).push({at:Date.now(),action:'approve-renderer-reload',workId:work.id});await observer.evaluate('globalThis.rendererAuditRecoveryGates.shift()();true');
  await wait(()=>observer.evaluate('globalThis.rendererAuditRecoveryGates?.length===1'),'second native recovery confirmation');result.interventions.push({at:Date.now(),action:'confirm-renderer-reload',workId:work.id});await observer.evaluate('globalThis.rendererAuditRecoveryGates.shift()();true');
  await wait(async()=>{try{return await chat.evaluate(({workId,draft})=>window.__nozeliReady&&document.querySelector('#conversation-panel')?.dataset.managedConversation===workId&&document.querySelector('#composer')?.value===draft,{workId:work.id,draft});}catch{return false;}},'reloaded same Work draft',90000);
  const s=await state(),native=s.providers?.[work.id];
  assert.equal(s.works.find(w=>w.id===work.id).threadId,ready.work.threadId);
  assert.equal(s.jobs.filter(j=>j.target===work.id).length,1,'Renderer recovery must not enqueue another Worker job');
  assert.equal(s.jobs.find(j=>j.id===ready.job.id).id,ready.job.id);
  assert.deepEqual(requestIdentity(s.jobs.find(j=>j.id===ready.job.id)),attemptsAtInjection,'Recovery must not re-dispatch within the same job');
  assert(native&&!native.closed);assert.equal(native.pid,ready.provider.pid);assert.equal(native.stamp,ready.provider.stamp);assert.equal(await processStamp(native.pid),native.stamp);
  result.rendererFault.recoveredAt=Date.now();result.rendererFault.dialogs=await observer.evaluate('globalThis.rendererAuditDialogs');result.rendererFault.gone=await observer.evaluate('globalThis.rendererAuditGone');
  result.rendererFault.recoveryAnswers=await observer.evaluate('globalThis.rendererAuditRecoveryAnswers');await fs.writeFile(path.join(out,'after-recovery-state.json'),JSON.stringify(s,null,2));
  assert.equal(result.rendererFault.dialogs.length,2);assert(result.rendererFault.dialogs.every(d=>d.defaultId===0&&d.cancelId===0));
  await shot('renderer-crash-recovered',chat);result.checks.push('Actual owned renderer crash and explicit two-stage reload retain original native PID/thread/job, correct input target and durable unsent draft without task replay');
 }finally{await observer.evaluate(`(()=>{const {dialog}=process.mainModule.require('electron');if(globalThis.rendererAuditOriginalDialog)dialog.showMessageBox=rendererAuditOriginalDialog;return true;})()`);}
 const finished=await wait(async()=>{const s=await state(),w=s.works.find(w=>w.id===work.id),j=s.jobs.find(j=>j.id===ready.job.id);if(['failed','interrupted','unknown'].includes(j?.status)||w?.status==='paused')throw Error('Native execution failed after renderer recovery; no automatic replay');return w?.status==='review'&&!s.busyTargets.includes(w.id)?w:false;},'original Worker natural completion',420000);
 const checkpoint=await fs.readFile(path.join(finished.execution.directory,checkpointRel),'utf8'),final=await fs.readFile(path.join(finished.execution.directory,finalRel),'utf8'),gateEnd=JSON.parse(await fs.readFile(path.join(finished.execution.directory,'gate-end.json'),'utf8'));
 assert.equal(checkpoint.trim(),'OWNER_ISOLATION_READY');assert.equal(final.trim(),'OWNER_ISOLATION_COMPLETE');assert.deepEqual(finished.execution.candidate.files.slice().sort(),[checkpointRel,finalRel,'gate-start.json','gate-end.json'].sort(),'Only the four allowed verification files may change');
 assert(gateEnd.at-ready.gate.at>=120000,'Actual native tool must complete the requested 120-second wait');
 assert(toolStart.at<result.rendererFault.t0&&result.rendererFault.t0<gateEnd.at,'The actual injection must occur strictly inside the native tool interval');
 const finalState=await state();assert.equal(finalState.jobs.filter(j=>j.target===work.id).length,1);assert.equal(finalState.works.find(w=>w.id===work.id).threadId,ready.work.threadId);assert.equal(finalState.drafts[work.id],draft);
 assert.deepEqual(requestIdentity(finalState.jobs.find(j=>j.id===ready.job.id)),attemptsAtInjection,'Natural completion must not hide a same-job re-dispatch');
 const sessions=path.join(ready.provider.home,'sessions'),sessionFile=(await fs.readdir(sessions)).find(name=>name.endsWith('_'+ready.work.threadId+'.jsonl'));assert(sessionFile,'Native session evidence must be retained');
 const journal=await fs.readFile(path.join(sessions,sessionFile));await fs.writeFile(path.join(out,'renderer-native-session.jsonl'),journal);result.rendererFault.nativeJournal={file:'renderer-native-session.jsonl',sha256:createHash('sha256').update(journal).digest('hex')};
 for(const old of protectedWorks){const w=finalState.works.find(w=>w.id===old.id);assert.deepEqual({id:w.id,status:w.status,threadId:w.threadId,closure:w.closure,draft:finalState.drafts[w.id]},old,'Original negative sample remains intact');}
 const report=await openReport(finished);await shot('renderer-crash-real-result',report);
 result.rendererFault.final={workId:finished.id,status:finished.status,threadId:finished.threadId,gateStart:ready.gate,gateEnd,checkpoint,final,draft};
 result.checks.push('Original real Worker completes its long native tool and publishes actual result after UI crash; checkpoint/final files and all prior negative samples retained');
 result.retainedRendererWork={id:finished.id,status:finished.status,reason:'Actual result and unsent draft intentionally retained for explicit review; not adopted, discarded or mislabeled ended.'};
 await fs.writeFile(path.join(out,'renderer-final-state.json'),JSON.stringify(finalState,null,2));
}
