import {discardWorkFromList} from './work-list-actions.fixture.mjs';
// Actual GUI business actions, with bounded observation windows but no HTTP/token quotas.
export async function runParallelAudit({state,compose,call,wait,pause,shell,shot,decision,result,out,fs,path}){
 const initial=await state(),projectId=(await call('workspace.bootstrap')).projectId;await call('managed.limit',{projectId,limit:2});
 let pair=initial.works.filter(w=>['长工具A','长工具B'].includes(w.name)&&w.status!=='ended');
 if(pair.length){
  if(pair.length!==2)throw Error('Partial prior pair requires explicit review, not duplicate dispatch');
  for(const work of pair){
   if(work.status!=='paused')throw Error('Existing pair is not at a safe continuation boundary');
   if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');
   await shell.locator('[data-managed-work="'+work.id+'"] .managed-work-open').click();
   await compose('继续这个原Work，不新建：上一轮测试驱动异常后由测试者取消了在途执行。先核对工作树已有gate-start.json/gate-end.json与部分成果；未完成的75秒等待可显式重新运行一次，已完整完成的不重复。然后完成本Work原定文档并发布result，准确说明取消与续作。不要自动采用或结束。',false,work.id);
  }
  result.checks.push('Interrupted pair explicitly continued on existing Work identities; no duplicate intake');
 }else{
  const before=new Set(initial.works.map(w=>w.id));
  const first=await compose('新建独立工作“长工具A”：真实运行 node tools/wait-gate.mjs 75，等待自然结束；随后新增 docs/gate-a.md，说明实际开始/结束时间及完成结果。gate-start.json、gate-end.json是允许的候选证据。不改既有材料/源码/验收，不操作Git、不自动采用或结束Work。',true);
  const second=await compose('新建另一独立工作“长工具B”，不是前一任务补充：真实运行 node tools/wait-gate.mjs 75，等待自然结束；随后新增 docs/gate-b.md，说明实际开始/结束时间及完成结果。gate-start.json、gate-end.json是允许的候选证据。不改其他文件，不操作Git、不自动采用或结束Work。',true);
  pair=await wait(async()=>{const s=await state(),works=s.works.filter(w=>!before.has(w.id));if(works.length===2)return works;if(s.jobs.filter(j=>[first.id,second.id].includes(j.id)).every(j=>j.status==='completed')&&!s.busyTargets.length)throw Error('Two intakes did not establish two Works');return false;},'two independent Works',180000);
 }
 const ids=pair.map(w=>w.id);
 const overlap=await wait(async()=>{const s=await state();const running=s.works.filter(w=>ids.includes(w.id)&&w.threadId&&w.execution&&w.status==='running'&&s.busyTargets.includes(w.id)&&s.jobs.some(j=>j.target===w.id&&j.status==='running'&&j.collabAttempts?.some(a=>a.everAdmitted)));return running.length===2?{at:Date.now(),works:running.map(w=>({id:w.id,threadId:w.threadId,directory:w.execution.directory}))}:false;},'two actual admitted native Workers',180000);
 result.parallel=overlap;pair=overlap.works;result.checks.push('Two original Work identities have simultaneously admitted running native threads');
 await wait(async()=>{for(const w of pair){try{JSON.parse(await fs.readFile(path.join(w.directory,'gate-start.json'),'utf8'));}catch{return false;}}return true;},'both actual long tool ready markers',180000);
 result.toolStart=await Promise.all(pair.map(async w=>({workId:w.id,...JSON.parse(await fs.readFile(path.join(w.directory,'gate-start.json'),'utf8'))})));await shot('two-workers-running',shell);
 if(process.env.NOZELI_AUDIT_SKIP_QUEUE!=='1'){
 await call('workspace.control',{type:'conversation-action',projectId,action:'select',target:'frontdesk'});
 await compose('新建独立工作“排队取消样本”，只在获得执行名额后新增 docs/queue-only.md 写一句测试说明；当前名额满时先排队，不复用其他Work。不改其他文件，不自动采用或结束。',true);
 const queued=await wait(async()=>{const s=await state();return s.works.find(w=>w.name==='排队取消样本'&&w.status==='queued');},'genuine queued Work',60000);await pause(30000);let s=await state();assertQueued(s,queued.id);await shot('queue-wait-visible',shell);
 if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');await discardWorkFromList(shell,queued.id);await wait(async()=>{const value=(await state()).works.find(w=>w.id===queued.id);return value.status==='ended'&&value.closure?.phase==='complete';},'queued Work user cancellation');s=await state();if(s.jobs.some(j=>j.target===queued.id&&j.status==='completed'))throw Error('Cancelled queued Work executed unexpectedly');result.checks.push('Third Work waits 30 seconds; GUI cancellation prevents Worker execution');
 }else result.queueEvidence='Separate occupied-quota GUI cancellation report: nozeli-workflow-continuation-sf4rlU';
 await wait(async()=>{const value=await state();return pair.every(w=>value.works.find(x=>x.id===w.id)?.status==='review')&&!pair.some(w=>value.busyTargets.includes(w.id));},'natural long tool completion',300000);
 for(const w of pair){const end=JSON.parse(await fs.readFile(path.join(w.directory,'gate-end.json'),'utf8'));const start=JSON.parse(await fs.readFile(path.join(w.directory,'gate-start.json'),'utf8'));if(end.at-start.at<74000)throw Error('Long tool evidence too short');}result.checks.push('Real 75-second tools complete; cancelled and continued epochs distinguished');
 for(const w of pair)await decision((await state()).works.find(x=>x.id===w.id),'discard');result.checks.push('Both parallel result Works explicitly discarded via report GUI');await fs.writeFile(path.join(out,'parallel-final-state.json'),JSON.stringify(await state(),null,2));
}
function assertQueued(state,id){const work=state.works.find(w=>w.id===id);if(work?.status!=='queued')throw Error('Queue sample started before observation boundary');if(state.jobs.some(j=>j.target===id&&j.status==='running'))throw Error('Queued Work has running execution');}
