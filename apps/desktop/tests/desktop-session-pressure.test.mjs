import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';

// Synthetic boundary pressure, NOT CLI/model/transport throughput. No source-text checks.
// Run: NOZELI_TEST_VISIBLE=1 node tests/desktop-session-pressure.test.mjs
// Requires installed Electron/esbuild/puppeteer-core and an available display for visible mode.
// All artifacts/profile are private to this invocation; no application/current/user profile is read.
const BUDGETS = Object.freeze({
  version: 1, entries: 200, fileRows: 100, hostPageBytes: 65536,
  originalDOMBytes: 16384, operationMs: 10000, startupMs: 30000, suiteMs: 600000,
  historyEntries: 10000, concurrentStreams: 3, streamFrames: 30,
  files: 1000, originalBytes: 5 * 1024 * 1024, lifecycleCycles: 100,
});
const root = path.resolve(import.meta.dirname, '..');
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-session-pressure-'));
const report = {
  schema: 1, status: 'running', startedAt: new Date().toISOString(), budgets: BUDGETS,
  boundary: {
    input: 'Synthetic version-1 history/stream frames, immutable file DTOs and timeline.read-shaped UTF-8 pages',
    consumer: 'Production createSessionStore, React session-timeline, session-reading and Markdown in real Electron Chromium',
    excluded: ['model', 'CLI', 'production host IPC', 'Git DTO generation', 'production composer'],
    inputLatency: 'Native keyboard to synthetic textarea input event and two requestAnimationFrame callbacks; not production composer latency',
    paint: 'Two real requestAnimationFrame callbacks after observed DOM content; presentation proxy, not GPU scanout',
    files: 'Real production file DTO schema consumed by production FrozenFiles; synthetic immutable records, not Git evidence',
    heap: 'Natural Chromium JS heap/DOM trends, no forced GC, no invented leak threshold and no long-term stability claim; synthetic fixtures intentionally remain retained',
    timingBudget: '10000ms is a conservative operation failure deadline, not a responsiveness claim; actual samples and median/p95/max are reported',
  },
  environment: {visible: process.env.NOZELI_TEST_VISIBLE === '1', widths: [1440, 390], node: process.version},
  counts: {}, measurements: {}, checks: [], errors: [], artifacts: out,
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = text => createHash('sha256').update(text).digest('hex');
const count = (name, n = 1) => {report.counts[name] = (report.counts[name] || 0) + n;};
const sample = (name, value) => (report.measurements[name] ||= []).push(value);
const started = performance.now();
let browser, page, child, exited, log = '', watchdog;
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function timed(name, action) {
  const start = performance.now();
  await action(); await paint();
  const ms = performance.now() - start; sample(name, ms);
  assert(ms <= BUDGETS.operationMs, `${name}: ${ms}ms > frozen ${BUDGETS.operationMs}ms`);
}
async function waitText(selector, text) {
  await page.waitForFunction((selector, text) => document.querySelector(selector)?.textContent.includes(text), {timeout: BUDGETS.operationMs}, selector, text);
}
async function nativeButton(container, label) {
  const handle = await page.evaluateHandle((container, label) => [...document.querySelectorAll(container + ' button')].find(node => node.textContent === label), container, label);
  try {assert(await handle.evaluate(node => !!node), `Missing native button: ${label}`); await handle.asElement().click();}
  finally {await handle.dispose();}
}
async function observe(label) {
  const session = await page.createCDPSession();
  try {
    await session.send('Performance.enable');
    const {metrics} = await session.send('Performance.getMetrics');
    const dom = await session.send('Memory.getDOMCounters');
    sample('resources', {label, ...Object.fromEntries(metrics.filter(m => ['JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents','JSEventListeners'].includes(m.name)).map(m => [m.name,m.value])), ...dom,
      ...await page.evaluate(() => ({subscriptions: consumer.activeSubscriptions, scrollConnections: consumer.scrollConnections, notifications: consumer.notifications, mountedMessages: document.querySelectorAll('[data-message]').length}))});
  } finally {await session.detach();}
}
try {
  const port = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const port = server.address().port; server.close(() => resolve(port));});});
  await build({absWorkingDir: root, stdin: {resolveDir: root, sourcefile: 'synthetic-pressure-entry.mjs', contents: String.raw`
    import {mountSessionTimeline} from './src/renderer/session-timeline.mjs';
    import {createSessionStore} from './src/renderer/session-store.mjs';
    import './src/renderer/styles.css';
    import './src/renderer/conversation-rendering.css';
    import './src/renderer/file-icons.css';
    const c=window.consumer={project:'synthetic-pressure',switches:0,activeSubscriptions:0,scrollConnections:0,notifications:0,calls:[],opened:[],inputEvents:[]};
    const store=c.store=createSessionStore();store.reset(c.project);
    const subscribe=store.subscribe;
    store.subscribe=listener=>{c.activeSubscriptions++;const off=subscribe(()=>{c.notifications++;listener();});let active=true;return()=>{if(active){active=false;c.activeSubscriptions--;off();}};};
    const scroll=document.querySelector('#conversation');
    const add=scroll.addEventListener.bind(scroll),remove=scroll.removeEventListener.bind(scroll);
    scroll.addEventListener=(type,...args)=>{if(type==='scroll')c.scrollConnections++;return add(type,...args);};
    scroll.removeEventListener=(type,...args)=>{if(type==='scroll')c.scrollConnections--;return remove(type,...args);};
    c.files=Array.from({length:1000},(_,i)=>({fileId:'file-'+i,path:'synthetic/file-'+i+'.ts',oldPath:null,status:'M',added:i,deleted:1,binary:false,availability:'available'}));
    const binding={projectId:c.project,workId:'work',revision:1,jobId:'job',receiptId:'receipt',inputCommit:'a'.repeat(40),candidateCommit:'b'.repeat(40)};
    c.state={works:[{id:'work',name:'Synthetic Worker'}],receipts:[]};
    c.original='SYNTHETIC ORIGINAL\n'+'x'.repeat(5*1024*1024-BufferlessLength('SYNTHETIC ORIGINAL\n')-4)+'\nEND';
    function BufferlessLength(text){return new TextEncoder().encode(text).length;}
    c.originalBytes=new TextEncoder().encode(c.original);
    c.call=async(op,args)=>{
      if(op==='changes.list'){
        if(args.limit!==100||args.offset%100!==0)throw Error('Unbounded file request');
        const files=c.files.slice(args.offset,args.offset+args.limit),next=args.offset+files.length;
        c.calls.push({op,args,rows:files.length});return {changeSetId:'changes',binding,files,total:c.files.length,nextOffset:next<c.files.length?next:null};
      }
      if(op!=='timeline.read'||args.id!=='original')throw Error('Unexpected synthetic boundary request '+op);
      if(!args.field){c.calls.push({op,args,descriptor:true});return {entry:{id:args.id,availability:'read-required',read:{version:'c'.repeat(64),maxBytes:65536,fields:[{field:'text',totalBytes:c.originalBytes.length}]}}};}
      if(args.field!=='text'||args.version!=='c'.repeat(64)||!Number.isSafeInteger(args.offset)||args.offset<0||args.limit>65536||args.limit<1)throw Error('Invalid original page');
      let end=Math.min(c.originalBytes.length,args.offset+args.limit);while(end<c.originalBytes.length&&(c.originalBytes[end]&192)===128)end--;
      const content=new TextDecoder('utf-8',{fatal:true}).decode(c.originalBytes.slice(args.offset,end));
      c.calls.push({op,args,bytes:BufferlessLength(content)});
      return {entry:{id:args.id,availability:'available',version:args.version,field:args.field,offset:args.offset,nextOffset:end<c.originalBytes.length?end:null,totalBytes:c.originalBytes.length,content}};
    };
    let view;
    const navigationContainer=document.createElement('div');navigationContainer.className='session-navigation-slot';document.querySelector('#conversation').after(navigationContainer);
    c.mount=()=>{view=mountSessionTimeline(document.querySelector('#timeline'),{store,state:c.state,projectId:c.project,navigationContainer,context:{filePaths:new Set(),onFile(){},onExternal(){},onError(error){throw error;}},call:c.call,openFrozenChange:args=>c.opened.push(args),onPage(){},onLatest(){}});view.render({});};
    c.unmount=()=>{view.destroy();view=null;};
    c.render=()=>view.render({state:{...c.state},projectId:c.project});
    c.worker=()=>({id:'worker',target:'worker',workId:'work',jobId:'job',revision:1,speaker:'agent',source:'native',sequence:1,text:'SYNTHETIC worker **body** preserved'});
    c.seed=()=>{c.state.receipts=[{id:'receipt',workId:'work',jobId:'job',revision:1,changeSetId:'changes'}];store.apply(c.project,{version:1,entries:[c.worker()]},{replace:true});c.render();};
    document.querySelector('#native-input').addEventListener('input',event=>{const at=performance.now(),value=event.target.value;requestAnimationFrame(()=>requestAnimationFrame(()=>c.inputEvents.push({value,eventToPaintMs:performance.now()-at})));});
    c.mount();
  `}, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out,'consumer.js'), loader: {'.css':'css','.ttf':'file','.woff':'file','.woff2':'file'}});
  await fs.writeFile(path.join(out,'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="consumer.css"><style>html,body{margin:0;min-width:0}#conversation{height:85vh;overflow:auto;padding:12px;box-sizing:border-box;width:100%}textarea{box-sizing:border-box;max-width:100%;width:100%}</style><label>Synthetic native input probe (not production composer)<textarea id="native-input"></textarea></label><div id="conversation"><div id="timeline"></div></div><script src="consumer.js"></script>');
  await fs.writeFile(path.join(out,'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:process.env.NOZELI_TEST_VISIBLE==='1',width:1440,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.join(out,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  child=spawn(createRequire(import.meta.url)('electron'),[path.join(out,'main.cjs'),'--remote-debugging-port='+port,'--ozone-platform='+(process.env.NOZELI_OZONE||(report.environment.visible?'x11':'headless')),'--user-data-dir='+path.join(out,'profile')],{cwd:root,env:{...process.env},stdio:['ignore','pipe','pipe']});
  exited=new Promise(resolve=>child.once('exit',resolve));
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
  let deadlineError;
  watchdog=setTimeout(()=>{deadlineError=Error('Frozen suite deadline exceeded');child.kill('SIGTERM');},BUDGETS.suiteMs);
  const launch=performance.now();
  while(performance.now()-launch<BUDGETS.startupMs){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await pause(100);}}
  assert(browser,'Electron startup exceeded frozen deadline');
  const target=await browser.waitForTarget(target=>target.type()==='page'&&target.url().endsWith('/index.html'),{timeout:BUDGETS.startupMs});
  page=await target.page(); page.setDefaultTimeout(BUDGETS.operationMs);
  page.on('pageerror',error=>report.errors.push({boundary:'renderer',message:error.message}));
  await page.waitForFunction(()=>window.consumer);
  await paint(); await observe('baseline');

  // One 10k-entry apply, then re-read synthetic history pages to verify every body,
  // including evicted entries; eviction is explicit hasMore, never silent truncation.
  await timed('history10000ApplyToPaintMs',async()=>{
    const result=await page.evaluate(()=>{
      const c=consumer;
      c.history=Array.from({length:10000},(_,i)=>({id:'history-'+i,sequence:i,target:'frontdesk',speaker:'agent',source:'native',text:'SYNTHETIC body '+i+' — **preserved**\nend-'+i}));
      const before=JSON.stringify(c.history); c.store.apply(c.project,{version:1,entries:c.history},{replace:true});
      const snap=c.store.getSnapshot();
      return {unchanged:before===JSON.stringify(c.history),count:snap.entries.length,hasMore:snap.hasMore,exact:snap.entries.every(e=>e.text===c.history[e.sequence].text)};
    });
    assert.deepEqual(result,{unchanged:true,count:BUDGETS.entries,hasMore:true,exact:true});
    await waitText('[data-message="history-9999"]','end-9999');
  });count('historyInputEntries',10000);
  for(let offset=0;offset<10000;offset+=200){
    const result=await page.evaluate(offset=>{const c=consumer,entries=c.history.slice(offset,offset+200);c.store.apply(c.project,{version:1,entries,hasMore:offset>0},{replace:true});return c.store.getSnapshot().entries.map(e=>({id:e.id,text:e.text}));},offset);
    assert.equal(result.length,200);
    for(let i=0;i<200;i++)assert.deepEqual(result[i],{id:'history-'+(offset+i),text:'SYNTHETIC body '+(offset+i)+' — **preserved**\nend-'+(offset+i)});
    await waitText('[data-message="history-'+(offset+199)+'"]','end-'+(offset+199));
    const dom=await page.$$eval('[data-message]',nodes=>nodes.map(node=>({id:node.dataset.message,text:node.textContent})));
    assert.equal(dom.length,200);
    for(const row of dom){const i=Number(row.id.slice(8));assert(row.text.includes('SYNTHETIC body '+i+' — preserved'));assert(row.text.includes('end-'+i));}
    count('historyBodiesConsumedAndCompared',200);count('historyWindowPagesConsumed');
  }
  report.checks.push({name:'All 10000 bodies compare exactly at store boundary and render expected Markdown body in bounded history windows',pass:true});

  await page.evaluate(()=>consumer.store.reset(consumer.project)); await paint();
  for(let frame=0;frame<BUDGETS.streamFrames;frame++){
    await timed('threeStreamProjectionToPaintMs',async()=>{
      await page.evaluate(async frame=>{const c=consumer;await new Promise(resolve=>requestAnimationFrame(()=>{for(let stream=0;stream<3;stream++)c.store.apply(c.project,{version:1,entries:[{id:'stream-'+stream,target:'frontdesk',speaker:'agent',source:'native',jobId:'stream-job-'+stream,sequence:stream,streaming:true,text:'SYNTHETIC stream '+stream+' frame '+frame}]});resolve();}));},frame);
      for(let stream=0;stream<3;stream++)await waitText('[data-message="stream-'+stream+'"]','frame '+frame);
      assert.equal(await page.$$eval('[data-message]',nodes=>nodes.length),3);
    }); count('streamFramesConsumed');count('streamEntryUpdatesConsumed',3);
  }
  await timed('durableReplacementToPaintMs',async()=>{
    await page.evaluate(()=>{const c=consumer;c.store.apply(c.project,{version:1,entries:Array.from({length:3},(_,i)=>({id:'durable-'+i,replacesId:'stream-'+i,target:'frontdesk',speaker:'agent',source:'native',jobId:'stream-job-'+i,sequence:i,streaming:false,text:'SYNTHETIC canonical durable '+i}))});});
    for(let i=0;i<3;i++)await waitText('[data-message="durable-'+i+'"]','canonical durable '+i);
    const ids=await page.$$eval('[data-message]',nodes=>nodes.map(n=>n.dataset.message));assert.deepEqual(ids,['durable-0','durable-1','durable-2']);
    assert.deepEqual(await page.evaluate(()=>consumer.store.getSnapshot().entries.map(e=>e.id)),ids);
  });count('durableReplacementsConsumed',3);

  await page.evaluate(()=>consumer.seed()); await page.waitForSelector('[data-frozen-file="file-0"]');
  const consumedFiles=[];
  for(let offset=0;offset<1000;offset+=100){
    await page.waitForSelector('[data-frozen-file="file-'+offset+'"]');
    const rows=await page.$$eval('[data-frozen-file]',nodes=>nodes.map(n=>({id:n.dataset.frozenFile,text:n.textContent})));
    assert.equal(rows.length,100);
    for(let i=0;i<100;i++){assert.equal(rows[i].id,'file-'+(offset+i));assert(rows[i].text.includes('synthetic/file-'+(offset+i)+'.ts'));consumedFiles.push(rows[i].id);}
    await timed('frozenFileOpenMs',async()=>{await page.click('[data-frozen-file="file-'+offset+'"]');});
    assert.deepEqual(await page.evaluate(()=>consumer.opened.at(-1)),{projectId:'synthetic-pressure',changeSetId:'changes',fileId:'file-'+offset});
    count('frozenFileDTOsConsumed',100);count('frozenFileNativeOpens');
    if(offset+100<1000)await timed('frozenFilePageToPaintMs',async()=>{await nativeButton('.session-frozen-files','更多变更文件');await page.waitForSelector('[data-frozen-file="file-'+(offset+100)+'"]');});
  }
  assert.equal(new Set(consumedFiles).size,1000);
  assert.deepEqual(await page.evaluate(()=>consumer.calls.filter(c=>c.op==='changes.list').map(c=>c.args.offset)),Array.from({length:10},(_,i)=>i*100));
  report.checks.push({name:'1000 immutable file DTOs consumed over 10 replacing 100-row pages, native opens preserve frozen binding',pass:true});

  await page.evaluate(()=>{const c=consumer;c.state.receipts=[];c.store.apply(c.project,{version:1,entries:[{id:'original',sequence:1,target:'frontdesk',speaker:'agent',source:'native',text:'',availability:'read-required',durable:true}]},{replace:true});c.render();});
  await page.waitForSelector('[data-message="original"] .session-original>button');
  await timed('originalOpenToPaintMs',async()=>{await page.click('[data-message="original"] .session-original>button');await page.waitForSelector('[data-message="original"] .session-plain');});
  let original='',maxDOMBytes=0;
  for(;;){
    await page.waitForFunction(()=>!document.querySelector('.session-original [role="status"]'));
    const text=await page.$eval('.session-original .session-plain',node=>node.textContent);
    const bytes=Buffer.byteLength(text); assert(bytes<=BUDGETS.originalDOMBytes);maxDOMBytes=Math.max(maxDOMBytes,bytes);original+=text;count('originalPagesConsumed');count('originalUTF8BytesConsumed',bytes);
    const next=await page.$('.session-original .session-content nav button:last-child');
    const done=await next.evaluate(node=>node.disabled);await next.dispose();if(done)break;
    const position=await page.$eval('.session-original .session-content nav span',node=>node.textContent);
    await timed('originalPageToPaintMs',async()=>{await page.click('.session-original .session-content nav button:last-child');await page.waitForFunction(position=>document.querySelector('.session-original .session-content nav span').textContent!==position,{},position);});
  }
  const expected=await page.evaluate(()=>consumer.original);
  assert.equal(Buffer.byteLength(original),BUDGETS.originalBytes);assert.equal(hash(original),hash(expected));
  const reads=await page.evaluate(()=>consumer.calls.filter(c=>c.op==='timeline.read'&&!c.descriptor));
  assert(reads.every(c=>c.bytes<=BUDGETS.hostPageBytes&&c.args.limit===16384));
  sample('originalIntegrity',{sha256:hash(original),bytes:Buffer.byteLength(original),maxDOMBytes,maxHostResponseBytes:Math.max(...reads.map(c=>c.bytes)),readRequests:reads.length});
  await page.click('.session-original>button');await page.waitForFunction(()=>!document.querySelector('.session-original .session-plain'));
  report.checks.push({name:'5MiB original fully consumed and SHA256-identical, bounded host-shaped reads and DOM, close releases page',pass:true});

  for(const width of report.environment.widths){
    await page.setViewport({width,height:1000});
    await page.evaluate(()=>consumer.seed());await page.waitForSelector('.session-worker>details>summary');
    for(let cycle=0;cycle<50;cycle++){
      await timed('nativeFoldOpenToPaintMs',async()=>{await page.focus('.session-worker>details>summary');await page.keyboard.press('Enter');await waitText('.session-worker-transcript','SYNTHETIC worker');});
      assert.equal(await page.$eval('[data-message="worker"] .session-markdown strong',node=>node.textContent),'body');count('workerNativeFoldOpens');
      await timed('nativeFoldCloseToPaintMs',async()=>{await page.focus('.session-worker>details>summary');await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('.session-worker-transcript'));});count('workerNativeFoldCloses');
      const old=await page.evaluate(()=>{const c=consumer,old=c.project;c.store.apply(old,{version:1,entries:[{id:'queued-old-frame',sequence:999,target:'frontdesk',speaker:'agent',streaming:true,text:'OLD PENDING RAF'}]});c.project='synthetic-project-'+(++c.switches);c.store.reset(c.project);c.state.receipts=[];c.render();return old;});
      await paint();
      assert.equal(await page.evaluate(old=>consumer.store.apply(old,{version:1,entries:[{id:'stale',sequence:999,target:'frontdesk',text:'MUST NOT APPEAR'}]}),old),false);
      assert.equal(await page.$('[data-message="stale"],[data-message="queued-old-frame"]'),null);assert.equal(await page.evaluate(()=>consumer.store.getSnapshot().entries.length),0);count('oldProjectFramesRejected');count('pendingOldRAFsCancelled');count('projectResetsConsumed');
      await page.evaluate(()=>consumer.unmount());await paint();
      assert.deepEqual(await page.evaluate(()=>({subscriptions:consumer.activeSubscriptions,scroll:consumer.scrollConnections,children:document.querySelector('#timeline').childElementCount})),{subscriptions:0,scroll:0,children:0});count('unmountsWithZeroConnections');
      await page.evaluate(()=>{consumer.mount();consumer.seed();});await page.waitForSelector('[data-frozen-file="file-0"]');await paint();
      assert.deepEqual(await page.evaluate(()=>({subscriptions:consumer.activeSubscriptions,scroll:consumer.scrollConnections})),{subscriptions:1,scroll:1});count('remountsWithOneConnection');count('lifecycleCyclesConsumed');
      if(cycle%10===0||cycle===49)await observe('width-'+width+'-cycle-'+cycle);
    }
    await page.focus('#native-input');
    const token='width-'+width+'-native';
    await timed('nativeInputKeyToPaintMs',async()=>{await page.keyboard.type(token);await page.waitForFunction(token=>consumer.inputEvents.some(e=>e.value.endsWith(token)),{},token);});
    count('nativeInputKeys',token.length);
    sample('nativeInputEventToPaintMs',{width,events:await page.evaluate(()=>consumer.inputEvents.splice(0))});
    await page.focus('.session-worker>details>summary');await page.keyboard.press('Enter');await waitText('.session-worker-transcript','SYNTHETIC worker');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Unexpected viewport overflow at '+width);
    report.checks.push({name:'No horizontal overflow at '+width,pass:true});
    await page.screenshot({path:path.join(out,'synthetic-'+width+'.png'),fullPage:true});count('syntheticOnlyScreenshots');
    await page.focus('.session-worker>details>summary');await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('.session-worker-transcript'));
  }
  await observe('final-mounted');
  await page.evaluate(()=>{consumer.unmount();consumer.store.dispose();});await paint();await observe('final-unmounted-disposed');
  assert.equal(await page.evaluate(()=>consumer.activeSubscriptions),0);
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));
  if(deadlineError)throw deadlineError;
  assert(performance.now()-started<=BUDGETS.suiteMs,'Frozen suite deadline exceeded');
  report.checks.push({name:'100 native open/close + project reset + stale frame rejection + unmount/remount cycles; zero disconnected subscriptions/DOM and one mounted connection',pass:true});
  report.status='pass';
} catch(error) {
  report.status='fail';report.errors.push({boundary:'runner',message:error.message,stack:error.stack});
  report.checks.push({name:'Execution completed within frozen functional/performance budgets',pass:false,message:error.message});
  process.exitCode=1;
} finally {
  clearTimeout(watchdog);
  try {await browser?.disconnect();} catch(error) {report.errors.push({boundary:'disconnect',message:error.message});report.status='fail';process.exitCode=1;}
  if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(5000)]);if(child.exitCode===null){child.kill('SIGKILL');await exited;}}
  report.elapsedMs=performance.now()-started;report.finishedAt=new Date().toISOString();
  report.countBoundaries={historyInputEntries:'entries supplied in the single 10000-row initial apply',historyBodiesConsumedAndCompared:'distinct bodies exact-compared after history-window apply and checked in production Markdown DOM',historyWindowPagesConsumed:'200-row synthetic history pages consumed',streamFramesConsumed:'three concurrent streams checked after a real RAF update',streamEntryUpdatesConsumed:'individual stream values observed in DOM',durableReplacementsConsumed:'canonical durable IDs observed with replaced streaming IDs absent',frozenFileDTOsConsumed:'distinct file IDs/path labels compared in production DOM',frozenFileNativeOpens:'native file clicks whose frozen argument binding was compared',originalPagesConsumed:'raw DOM pages concatenated and included in full-original SHA256',originalUTF8BytesConsumed:'UTF-8 bytes actually read from DOM',workerNativeFoldOpens:'keyboard Enter opens with rendered Markdown assertion',workerNativeFoldCloses:'keyboard Enter closes with transcript unmounted',oldProjectFramesRejected:'old project apply returns false and no stale store/DOM row',projectResetsConsumed:'reset observed as empty store before remount seed',unmountsWithZeroConnections:'unmount with zero subscription/scroll listeners and empty root',remountsWithOneConnection:'mount with exactly one subscription and one scroll connection',lifecycleCyclesConsumed:'complete open/close/reset/reject/unmount/remount sequence',nativeInputKeys:'native keys typed into explicitly synthetic textarea probe',syntheticOnlyScreenshots:'screenshots of only private synthetic data'};
  report.countBoundaries.pendingOldRAFsCancelled='streaming old-project apply queues a native RAF immediately before reset; after two RAFs no old row survives in snapshot or DOM';
  for(const [name,values] of Object.entries(report.measurements))if(values.length&&typeof values[0]==='number'){const sorted=[...values].sort((a,b)=>a-b);report.measurements[name]={samples:values,count:values.length,min:sorted[0],median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)],max:sorted.at(-1)};}
  await fs.writeFile(path.join(out,'electron.log'),log);
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(`Synthetic production Electron consumer pressure: ${report.status}; report: ${path.join(out,'report.json')}`);
}
