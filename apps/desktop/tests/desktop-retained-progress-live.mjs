import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';

// Actual expired-readRef failure after a retained publication. No state injection,
// automatic replay or model-quality claim; loopback scripts drive real Pi tools.
// U3-02: plain first screen + nearby real actions, raw diagnostics only in closed
// details (fully retained), original-report current paused notice, no extra calls.
const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),exec=promisify(execFile);
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-retained-progress-')),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),root=path.join(out,'合成访谈');
await fs.mkdir(root);await fs.writeFile(path.join(root,'原始材料.md'),'# 原始材料\n\n10人合成访谈，未作长期追踪。\n');
const host=new DesktopHost(profile),project=(await host.pick(root)).project;await host.storage.db.close();
const task='整理一份访谈摘要，保留样本局限，供我稍后查看。',supplement='请在这份访谈摘要中补充一句跨实验室验证的建议。',file='笔记/访谈摘要.md';
const candidate='# 访谈摘要\n\n合成10人样本，来源集中，不能外推总体；没有长期追踪。\n';
const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>访谈摘要 · 初稿</title></head><body><main><h1>已保留的访谈摘要</h1><p>本组材料强调依据定位与笔记保留。样本来源集中，且没有长期追踪，不应推广为所有研究者的结论。</p><p>候选文件：笔记/访谈摘要.md。补充失败不会改变这份冻结初稿。</p></main></body></html>';
const text=m=>typeof m.content==='string'?m.content:m.content?.filter(p=>p.type==='text').map(p=>p.text).join('')||'';
let dispatched=false;
const provider=await serve(r=>{
 const tools=r.tools?.map(t=>t.function?.name)||[];
 if(tools.includes('nozeli_dispatch')){
  if(dispatched)return {text:'原进展应保留。未核实原回合效果，不能声称已修复或重放业务输入。'};
  dispatched=true;return {tool:'nozeli_dispatch',id:'retained-dispatch',args:{name:'访谈摘要',brief:task}};
 }
 const current=r.messages.filter(m=>m.role==='user').map(text).findLast(t=>t.trim()===supplement);
 if(current)return {tool:'nozeli_history_read',id:'expired-reference-supplement',args:{readRef:'fixture-invented-reference@2',offset:0}};
 if(!r.messages.some(m=>m.tool_call_id==='retained-write'))return {tool:'write',id:'retained-write',args:{path:file,content:candidate}};
 return {tool:'nozeli_publish',id:'retained-publish',args:{kind:'result',content:html,files:[file]}};
});
let child,browser,shell,review,doc,observer,windowId,exit,log='';const errors=[];
const report={ok:false,out,version:process.env.NOZELI_TEST_BINARY?'0.1.0-alpha.5-installed-'+path.basename(path.dirname(process.env.NOZELI_TEST_BINARY)):'0.1.0-alpha.5-source-ux-batch4',binary:process.env.NOZELI_TEST_BINARY||require('electron'),scope:'Real Electron/Pi tool failure READ_REF_EXPIRED with real retained Git/files; scripted local HTTP, not paid-model/recovery qualification. U3-02: plain first screen, closed diagnostics, report current-state notice',checks:[],steps:[],screenshots:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('App exited '+log);const v=await fn();if(v)return v;await pause(70);}throw Error('Timeout '+label);}
async function call(page,op,p={}){const r=await page.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
const state=async()=>(await call(shell,'managed.status',{projectId:project.id})).state;
async function surface(kind){return until(async()=>{for(const p of await browser.pages())if(await p.evaluate(kind=>window.__nozeliReady&&window.__workspaceScope?.kind===kind,kind).catch(()=>false))return p;},kind);}
async function capture(name){
 const output=path.join(out,name+'.png'),clip=path.join(out,name+'-frames.mkv');
 await observer.evaluate(`(async()=>{const {BaseWindow}=process.mainModule.require('electron');for(const win of BaseWindow.getAllWindows())for(const v of win.contentView.children||[])if(v.getVisible?.()&&v.webContents)await v.webContents.capturePage(undefined,{stayAwake:true});return true;})()`,15000);
 const info=(await exec('xwininfo',['-id',windowId],{timeout:5000})).stdout;
 const width=Number(/Width:\s+(\d+)/.exec(info)?.[1]),height=Number(/Height:\s+(\d+)/.exec(info)?.[1]);
 assert(width>0&&height>0,'owned X11 window dimensions required');
 await exec('ffmpeg',['-y','-loglevel','error','-f','x11grab','-framerate','10','-draw_mouse','0','-window_id',windowId,'-video_size',width+'x'+height,'-i',process.env.DISPLAY,'-t','1.2','-c:v','ffv1','-pix_fmt','bgr0',clip],{timeout:10000});
 await exec('ffmpeg',['-y','-loglevel','error','-sseof','-0.15','-i',clip,'-frames:v','1',output],{timeout:10000});
 report.screenshots.push(output);
}
try{
 assert(process.env.DISPLAY,'Actual X11 capture required');
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];Object.assign(env,{NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_OZONE:'x11'});
 child=spawn(process.env.NOZELI_TEST_BINARY||require('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform=x11','--inspect=0'],{cwd:root,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');browser.on('targetcreated',async t=>{const p=await t.page().catch(()=>null);p?.on('pageerror',e=>errors.push(e.message));});shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'main inspector'));
 windowId=await observer.evaluate(`(()=>{const {BaseWindow}=process.mainModule.require('electron');const w=BaseWindow.getAllWindows()[0];w.show();w.focus();return '0x'+w.getNativeWindowHandle().readUInt32LE(0).toString(16);})()`);
 await call(shell,'config.initialize',{mode:'independent'});if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');await call(shell,'settings.providers.save',{operation:'create',provider:'retained-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret'}});const model={model:{mode:'explicit',selector:'retained-local/scripted'},thinking:{mode:'native-default'}};await call(shell,'settings.models.save',{frontdesk:model,orchestrator:model,worker:model});await shell.click('[data-project-id="'+project.id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,project.id),'project');await call(shell,'managed.enable',{projectId:project.id});await call(shell,'managed.task',{projectId:project.id,text:task,requestKey:'retained-real-original'});
 const initial=await until(async()=>{const s=await state();if(s.jobs.some(j=>j.status==='failed'))throw Error(JSON.stringify(s.jobs));return s.works[0]?.status==='review'?s:null;},'initial publication');const work=initial.works[0],objectId=work.result.objectId,todo=initial.todos.find(t=>t.objectId===objectId),thread=work.threadId;
 if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');await shell.waitForSelector('[data-managed-todo="'+todo.id+'"]',{visible:true});await shell.click('[data-managed-todo="'+todo.id+'"]');review=await surface('report');await review.waitForSelector('[data-review-instruction]:not([disabled])',{visible:true});
 await review.$eval('[data-review-instruction]',(n,t)=>{n.value=t;n.dispatchEvent(new Event('input',{bubbles:true}));},supplement);await review.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});await review.click('[data-review-action="send"]');
 const failed=await until(async()=>{const s=await state(),j=s.jobs.find(j=>j.text===supplement);return j&&['failed','interrupted','unknown'].includes(j.status)?{state:s,job:j}:null;},'actual expired-reference supplement failure');
 assert.match(String(failed.job.error),/READ_REF_EXPIRED|引用|ref|tool/i);assert.equal(failed.state.works.length,1);assert.equal(failed.state.works[0].threadId,thread);assert.equal(failed.state.works[0].result.objectId,objectId);assert.equal(await fs.readFile(path.join(work.execution.directory,file),'utf8'),candidate);await assert.rejects(fs.stat(path.join(root,file)),{code:'ENOENT'});report.steps.push({action:'真实补充发生引用读取失败',jobId:failed.job.id,status:failed.job.status,error:failed.job.error,retainedObjectId:objectId,threadUnchanged:true});
 await until(async()=>{const s=await state(),maintenance=s.works[0]?.maintenance;return !s.jobs.some(j=>['queued','running'].includes(j.status))&&(!maintenance||s.jobs.some(j=>j.type==='maintenance'&&j.context?.bugId===maintenance.bugId&&['completed','failed','interrupted','unknown'].includes(j.status)));},'backstage maintenance handling settled');const requestsBefore=provider.requests.length,jobsBefore=(await state()).jobs.map(j=>[j.id,j.status]);
 await shell.waitForSelector('[data-managed-work="'+work.id+'"] .managed-work-open',{visible:true});await shell.click('[data-managed-work="'+work.id+'"] .managed-work-open');await shell.waitForSelector('[data-work-progress="'+work.id+'"]',{visible:true});
 const dto=await call(shell,'managed.work.progress.read',{projectId:project.id,workId:work.id});report.progress=dto;assert(dto.request.text.includes(task));assert(dto.publications.items.some(p=>p.objectId===objectId));assert(dto.supplements.items.some(s=>s.jobId===failed.job.id&&s.text.includes(supplement)));assert.equal(dto.next.autoResume,false);
 // U3-02 首屏：平实状态 + 就近真实动作；下一步不承诺不可用的“采用或继续修改”。
 assert.equal(dto.next.continuation.status,'system-issue');assert.ok(dto.next.notices.some(n=>n.key==='supplement'&&n.text.includes('未完成')));
 assert.ok(!dto.next.steps.some(step=>step.includes('决定采用或继续修改')),'paused work must not promise adopt-or-revise');
 await shell.waitForSelector('[data-progress-now]',{visible:true});await shell.waitForSelector('[data-progress-return-reading]',{visible:true});
 const firstScreen=await shell.$eval('[data-work-progress="'+work.id+'"]',node=>node.innerText);
 assert(!/readRef|READ_REF|needs-version-fix|最近状态 unknown|原生传输|20\d\d-\d\d-\d\dT/.test(firstScreen),'first screen stays plain: raw diagnostics/times live only in closed details');
 assert(firstScreen.includes('未完成'),'first screen names the unfinished supplement');
 assert(firstScreen.includes('仍可查看'),'first screen names retained viewables');
 assert(firstScreen.includes('不会自动'),'first screen says the task will not auto-continue');
 await capture('01-首屏平实状态与就近动作');
 // 就近复制补充原文；完整失败原文/传输记录/原始时间展开可核对，再收起。
 await shell.click('[data-progress-copy="supplement:'+failed.job.id+'"]');await shell.waitForSelector('.managed-work-progress-copy-done',{visible:true});
 await shell.click('[data-progress-diagnostics="'+failed.job.id+'"] > summary');
 await shell.waitForFunction(jobId=>document.querySelector('[data-progress-diagnostics="'+jobId+'"]')?.open===true,{},failed.job.id);
 const diagnostics=await shell.$eval('[data-progress-diagnostics="'+failed.job.id+'"]',node=>node.innerText);
 assert(diagnostics.includes(String(failed.job.error)),'raw failure text stays fully retained');
 assert(diagnostics.includes('最近状态 unknown'),'transport record stays fully retained');
 assert(diagnostics.includes(String(failed.job.at))&&diagnostics.includes(String(failed.job.finishedAt)),'original timestamps stay fully retained');
 await shell.$eval('[data-progress-diagnostics="'+failed.job.id+'"]',node=>node.scrollIntoView({block:'center'}));
 await shell.waitForFunction(jobId=>{const node=document.querySelector('[data-progress-diagnostics="'+jobId+'"]'),box=node?.getBoundingClientRect(),dialog=node?.closest('dialog')?.getBoundingClientRect();return Boolean(box&&dialog&&box.top>=dialog.top&&box.bottom<=Math.min(innerHeight,dialog.bottom));},{},failed.job.id);
 await capture('02-展开失败原文与传输记录');
 await shell.click('[data-progress-diagnostics="'+failed.job.id+'"] > summary');
 await shell.waitForFunction(jobId=>document.querySelector('[data-progress-diagnostics="'+jobId+'"]')?.open===false,{},failed.job.id);
 await shell.click('[data-progress-copy="request"]');await shell.waitForSelector('.managed-work-progress-copy-done',{visible:true});
 const buttons=await shell.$$eval('[data-work-progress] button',nodes=>nodes.map(n=>n.textContent));assert(!buttons.some(t=>/^继续|^恢复|^重试执行/.test(t)),'read-only progress must not offer fake continuation');
 assert.equal(provider.requests.length,requestsBefore);assert.deepEqual((await state()).jobs.map(j=>[j.id,j.status]),jobsBefore);report.checks.push('真实引用失败后原请求、旧报告/候选及失败补充可读；复制与查看不执行或重放');
 // 打开原冻结报告：当前状态区明确“已暂停、不会自动恢复”，发送/采用不可用，历史“已接管”消息原样保留。
 await shell.click('[data-progress-open-report="'+objectId+'"]');review=await surface('report');await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 await review.waitForFunction(()=>{const notice=document.querySelector('[data-review-current-state]');return notice&&!notice.hidden&&notice.textContent.includes('暂停')&&notice.textContent.includes('不会自动恢复');});
 const reviewActions=await review.$$eval('[data-review-action="send"],[data-review-action="accept"]',nodes=>nodes.map(n=>[n.dataset.reviewAction,n.disabled]));
 assert.ok(reviewActions.length>=2&&reviewActions.every(([,disabled])=>disabled),'send and accept stay disabled for the paused work');
 const historyText=await review.$eval('[data-review-discussion-history]',node=>node.innerText);
 assert(historyText.includes('系统已接管此运行问题'),'historical takeover message stays unmodified');
 assert(historyText.includes('无需重复提交'),'historical no-resubmit message stays unmodified');
 await capture('03-原报告当前暂停说明与不可用发送采用');
 // 就近“返回阅读”确实关闭保留进展；再打开并进入确切冻结文件继续阅读。
 await shell.click('[data-managed-work="'+work.id+'"] .managed-work-open');await shell.waitForSelector('[data-work-progress="'+work.id+'"]',{visible:true});
 await shell.click('[data-progress-return-reading]');
 await until(async()=>!(await shell.$('[data-retained-progress-dialog="'+work.id+'"]')),'return-reading closes the retained-progress dialog');
 await shell.click('[data-managed-work="'+work.id+'"] .managed-work-open');await shell.waitForSelector('[data-work-progress]',{visible:true});await shell.click('[data-progress-file="'+objectId+'|'+file+'"]');doc=await surface('document');await doc.waitForFunction(()=>window.__nozeliInput?.text().includes('合成10人样本'));assert.equal(await doc.evaluate(()=>window.__nozeliInput.text()),candidate);await capture('04-打开确切旧候选继续阅读');
 assert.equal(provider.requests.length,requestsBefore);assert.deepEqual((await state()).jobs.map(j=>[j.id,j.status]),jobsBefore);await assert.rejects(fs.stat(path.join(root,file)),{code:'ENOENT'});assert.deepEqual(provider.errors,[]);assert.deepEqual(errors,[]);
 report.steps.push({action:'首屏平实状态→就近复制/展开→原报告当前暂停说明→返回阅读→确切冻结文件',plainFirstScreen:true,diagnosticsExpandedThenCollapsed:true,currentPausedNotice:true,sendAcceptDisabled:true,historyUnmodified:true,noAdditionalProviderRequests:true,noNewOrReplayedJobs:true,noProjectWrites:true});
 report.checks.push('失败未被标成功；无可靠自动恢复时仅说明下一步，真实冻结报告/文件可打开，不改原项目');report.providerCalls=provider.requests.length;report.ok=true;observer.close();observer=null;await call(shell,'session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;
}catch(error){report.error=error.stack;process.exitCode=1;await capture('failure').catch(()=>{});report.surface=await shell?.evaluate(()=>document.body.innerText.slice(-7000)).catch(()=>null);}
finally{observer?.close();if(child?.exitCode===null){try{await call(shell,'session.requestClose');await Promise.race([exit,pause(10000)]);}catch{}if(child.exitCode===null)child.kill('SIGTERM');}await browser?.disconnect().catch(()=>{});await provider.close();report.errors=errors;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
