import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';

// Consumer contract test: real React, Chromium DOM and production Markdown/store.
// The changes.list boundary is controlled here; Git retention is tested separately.
const root = path.resolve(import.meta.dirname, '..');
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-session-consumer-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
await build({
  absWorkingDir: root,
  stdin: {resolveDir: root, sourcefile: 'session-consumer-entry.mjs', contents: `
    import {mountSessionTimeline} from './src/renderer/session-timeline.mjs';
    import {createSessionStore,sessionMessages} from './src/renderer/session-store.mjs';
    import './src/renderer/styles.css';
    import './src/renderer/conversation-rendering.css';
    import './src/renderer/file-icons.css';
    const store=createSessionStore();store.reset('project-consumer');
    const state={works:[{id:'work-one',name:'Native Worker'}],receipts:[]};
    const calls=[],opened=[];
    window.__consumerTasks=[];window.__quoteSink=[];
    window.nozeli={invoke:async(op,payload)=>op==='document.clipboard'&&payload?.action==='write'?{ok:true}:{ok:false,error:{message:'consumer stub: '+op}}};
    window.__composerMaterials={setQuote:quote=>window.__quoteSink.push(quote)};
    const pages=new Map(),originals=new Map();
    const props={store,state,projectId:'project-consumer',context:{filePaths:new Set(),onFile(){},onExternal(){},onError(error){throw error;}},
      call:async(op,args)=>{calls.push({op,args});if(op==='timeline.read'){
        const original=originals.get(args.id);if(!original)throw Error('Missing original');
        const values={text:original.text,reasoning:original.reasoning,'tool.input':original.tool?.input,'tool.output':original.tool?.output,toolCalls:original.toolCalls};
        const fields=Object.entries(values).filter(([,value])=>value!=null).map(([field,value])=>({field,content:typeof value==='string'?value:JSON.stringify(value)}));
        const version='a'.repeat(64);if(!args.field)return {entry:{id:args.id,availability:'read-required',read:{version,maxBytes:65536,fields:fields.map(({field,content})=>({field,totalBytes:new TextEncoder().encode(content).length}))}}};
        if(args.version!==version||args.limit>16384)throw Error('Unbounded or stale original read');
        const bytes=new TextEncoder().encode(fields.find(value=>value.field===args.field).content);let end=Math.min(bytes.length,args.offset+args.limit);while(end<bytes.length&&(bytes[end]&192)===128)end--;
        return {entry:{id:args.id,version,field:args.field,offset:args.offset,nextOffset:end<bytes.length?end:null,totalBytes:bytes.length,content:new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(args.offset,end)),availability:'available'}};
      }if(op!=='changes.list')throw Error('Unexpected consumer IPC: '+op);const page=pages.get(args.changeSetId+':'+args.offset);if(!page)throw Error('Missing bounded page');return page;},
      openFrozenChange:args=>{opened.push(args);},onPage(){},onLatest(){},onTask:entry=>window.__consumerTasks.push(entry)};
    const navigationContainer=document.createElement('div');navigationContainer.className='session-navigation-slot';document.querySelector('#conversation').after(navigationContainer);props.navigationContainer=navigationContainer;
    const view=mountSessionTimeline(document.querySelector('#timeline'),props);
    view.render({});
    window.consumer={store,calls,opened,pages,originals,state,
      messages:()=>sessionMessages(store.getSnapshot()),
      render:()=>view.render({state:{...state}}),
      destroy:()=>{view.destroy();store.dispose();}};
  `},
  bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out, 'consumer.js'),
  loader: {'.css': 'css','.ttf':'file','.woff':'file','.woff2':'file'},
});
await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="consumer.css"><style>html,body{margin:0;min-width:0}#conversation{height:100vh;overflow:auto;box-sizing:border-box;padding:16px;width:100%;container:session / inline-size}</style><div id="conversation"><div id="timeline"></div></div><script src="consumer.js"></script>');
await fs.writeFile(path.join(out, 'main.cjs'), `
  const {app,BrowserWindow}=require('electron');
  app.whenReady().then(()=>{const win=new BrowserWindow({show:true,width:1440,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.join(out, 'index.html'))});});
  app.on('window-all-closed',()=>app.quit());
`);
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(out, 'main.cjs'), '--remote-debugging-port='+port, '--ozone-platform='+(process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':'headless')), '--user-data-dir='+path.join(out,'profile')], {cwd:root,env:{...process.env},stdio:['ignore','pipe','pipe']});
let log='', browser, page;
for (const stream of [child.stdout,child.stderr]) stream.on('data', chunk => {log+=chunk;});
const exited = new Promise(resolve => child.once('exit', resolve));
try {
  for(let attempt=0;attempt<150;attempt++) {
    try {browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}
    catch {if(child.exitCode!==null)throw Error(log);await pause(100);}
  }
  assert(browser, 'Electron debug endpoint did not start: '+log);
  const target=await browser.waitForTarget(target=>target.type()==='page'&&target.url().endsWith('/index.html'),{timeout:30000});
  page=await target.page();assert(page);
  await page.setViewport({width:800,height:1000});
  await page.waitForFunction(()=>window.consumer);
  await page.evaluate(()=>{
    const c=window.consumer;c.store.apply('project-consumer',{version:1,entries:[
      {id:'model-history',target:'frontdesk',speaker:'agent',source:'native',sequence:1,text:'Historical answer',provider:'recorded-provider',model:'recorded-model',modelStatus:'recorded'},
      {id:'unknown-history',target:'frontdesk',speaker:'agent',source:'legacy',sequence:2,text:'Old answer'},
      {id:'user-history',target:'frontdesk',speaker:'user',source:'host',sequence:3,text:'User question'},
      {id:'bg-history',target:'frontdesk',speaker:'user',source:'host',jobId:'bg-job',taskRequestId:'bg-job',sequence:4,text:'Background request'},
    ],deltas:[]});
  });
  await page.waitForSelector('[data-message="model-history"] [data-history-model]');
  assert.equal(await page.$eval('[data-message="model-history"] [data-history-model]',node=>node.textContent),'recorded-provider / recorded-model');
  assert.equal(await page.$eval('[data-message="unknown-history"] [data-history-model]',node=>node.textContent),'模型未记录');
  assert.equal(await page.$('[data-message="user-history"] [data-history-model]'),null);
  await page.evaluate(()=>{window.consumer.state.model='different-live-model';window.consumer.render();});
  assert.equal(await page.$eval('[data-message="model-history"] [data-history-model]',node=>node.textContent),'recorded-provider / recorded-model');
  // Route redundancy: default foreground input carries no badge; genuine background keeps provenance.
  assert.equal(await page.$('[data-message="user-history"] [data-input-route]'),null,'ordinary foreground input stays implicit');
  await page.waitForSelector('[data-message="bg-history"] [data-input-route="background"]');
  // Per-message actions stay available on demand, keyboard- and touch-reachable, with live copy status.
  await page.waitForSelector('[data-message="model-history"] .message-actions[data-message-actions-menu]');
  assert.equal(await page.$eval('[data-message="model-history"] .message-actions>summary',node=>node.getAttribute('aria-expanded')),'false','actions start collapsed');
  await page.focus('[data-message="model-history"] .message-actions>summary');await page.keyboard.press('Enter');
  await page.waitForSelector('[data-message="model-history"] .message-actions[open] [data-message-action="copy"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('[data-message="model-history"] .message-actions[open]'));
  await page.click('[data-message="model-history"] .message-actions>summary');
  await page.click('[data-message="model-history"] [data-message-action="copy"]');
  await page.waitForSelector('[data-message="model-history"] [data-message-copy="copied"]');
  assert.equal(await page.$eval('[data-message="model-history"] [data-message-action="copy"]',node=>node.textContent),'已复制纯文本','copy result stays visible in the open menu');
  await page.click('[data-message="model-history"] [data-message-action="quote"]');
  await page.waitForFunction(()=>!document.querySelector('[data-message="model-history"] .message-actions[open]'));
  assert.deepEqual(await page.evaluate(()=>window.__quoteSink.map(quote=>quote.text)),['Historical answer'],'quote dispatches the existing composer callback');
  await page.click('[data-message="model-history"] .message-actions>summary');
  await page.click('[data-message="model-history"] [data-message-action="task"]');
  assert.deepEqual(await page.evaluate(()=>window.__consumerTasks.map(entry=>entry.id)),['model-history'],'transfer-to-background dispatches the existing onTask callback');
  await page.waitForFunction(()=>!document.querySelector('[data-message="model-history"] .message-actions[open]'));
  await page.evaluate(()=>{const c=window.consumer;c.store.reset('project-consumer');c.state.jobs=[{id:'before-output',target:'frontdesk',status:'queued'}];c.store.apply('project-consumer',{version:1,entries:[{id:'before-output-user',jobId:'before-output',target:'frontdesk',speaker:'user',source:'host',text:'核对轨道',sequence:1}],deltas:[]});c.render();});
  await page.waitForSelector('[data-execution-state="queued"]');
  assert.equal(await page.$('.session-message[data-role="user"] [role="status"]'),null);
  assert.equal(await page.$('[data-message="host-turn:before-output"] .session-tool'),null,'status is not a fabricated process record');
  assert.equal(await page.$('[data-message="host-turn:before-output"] [data-history-model]'),null,'no model is invented before an assistant record');
  await page.screenshot({path:path.join(out,'execution-before-model-output.png'),fullPage:true});
  await page.evaluate(()=>{window.consumer.state.jobs[0].status='starting';window.consumer.render();});
  await page.waitForSelector('[data-execution-state="starting"]');
  await page.evaluate(()=>{
    const c=window.consumer;c.store.reset('project-consumer');
    c.state.jobs=[{id:'echo-job',target:'frontdesk',status:'running'},{id:'halt-job',target:'frontdesk',status:'completed',completion:'host-control'}];
    c.state.agents=[{target:'frontdesk',busy:true}];
    c.store.apply('project-consumer',{version:1,entries:[
      {id:'accepted-input',target:'frontdesk',speaker:'user',source:'host',jobId:'echo-job',sequence:1,text:'继续',streaming:true},
      {id:'native-echo',target:'frontdesk',speaker:'user',source:'native',jobId:'echo-job',sessionId:'session',requestId:'request',entryId:'native-user',sequence:2,text:'继续',streaming:true},
      {id:'another-input',target:'frontdesk',speaker:'user',source:'host',jobId:'another-job',sequence:3,text:'继续'},
      {id:'thinking-call',target:'frontdesk',speaker:'agent',source:'native',jobId:'echo-job',sequence:4,text:'',provider:'turn-provider',model:'turn-model',toolCalls:[{id:'pending-read',name:'nozeli_document_read'}]},
      {id:'last-tool',target:'frontdesk',speaker:'tool',source:'native',jobId:'echo-job',sequence:5,text:'',tool:{name:'other',status:'complete',toolCallId:'other'}},
      {id:'halt-tool',target:'frontdesk',speaker:'tool',source:'native',jobId:'halt-job',sequence:6,text:'',tool:{name:'nozeli_document_read',status:'complete',output:JSON.stringify({ok:false,hostControl:true,error:{code:'HOST_CONTEXT_BUDGET_EXHAUSTED'}})}},
    ]});c.render();
  });
  await page.waitForSelector('[data-message="last-tool"] [data-execution-state="toolrunning"]');
  assert.equal(await page.$$eval('.session-message[data-role="user"]',nodes=>nodes.length),2,'identical text in different jobs stays separate');
  assert.equal(await page.$('.session-message[data-role="user"] [role="status"]'),null,'user never displays output status, even if native streaming flag is set');
  assert.equal(await page.$('[data-message="native-echo"]'),null,'accepted input suppresses its transient native echo');
  assert.equal(await page.$eval('[data-message="last-tool"] [data-history-model]',node=>node.textContent),'turn-provider / turn-model','synthetic process row uses agent evidence from this turn');
  assert.match(await page.$eval('[data-message="last-tool"]>.session-tool>summary',node=>node.textContent),/nozeli_document_read.*1 项待完成/);
  assert.equal(await page.$('[data-message="halt-tool"] [data-execution-state="blocked"]')!==null,true,'actual failed host read is not task completion');
  assert.equal(await page.evaluate(()=>document.querySelector('.session-timeline').textContent.includes('本轮尚无正文回复')),false,'no invented empty assistant reply');
  await page.screenshot({path:path.join(out,'execution-running-and-blocked.png'),fullPage:true});
  await page.setViewport({width:390,height:780});
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'execution status and tool names fit narrow conversation');
  await page.screenshot({path:path.join(out,'execution-narrow-dark.png'),fullPage:true});
  await page.evaluate(()=>{window.consumer.state.jobs[0].status='waiting';window.consumer.render();});
  await page.waitForSelector('[data-message="last-tool"] [data-execution-state="waiting"]');
  await page.screenshot({path:path.join(out,'execution-waiting.png'),fullPage:true});
  await page.setViewport({width:1440,height:1000});
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
  await page.evaluate(()=>{const c=window.consumer;c.store.apply('project-consumer',{version:1,entries:[{...c.store.getSnapshot().entries.find(entry=>entry.id==='native-echo'),streaming:false,durable:true}]});c.state.jobs[0].status='completed';c.state.agents[0].starting=true;c.render();});
  await page.waitForSelector('[data-message="last-tool"] [data-execution-state="completed"]');
  assert.equal(await page.$$eval('.session-message[data-role="user"]',nodes=>nodes.length),2,'durable settlement does not restore duplicate echo');
  await page.evaluate(()=>{window.consumer.state.jobs=[];window.consumer.state.agents=[];window.consumer.render();});
  await page.evaluate(()=>window.consumer.store.reset('project-consumer'));
  await page.evaluate(()=>{
    const base={target:'frontdesk',speaker:'agent',source:'native',jobId:'front-one'};
    window.consumer.store.apply('project-consumer',{version:1,entries:[
      {...base,id:'front-call',sequence:1,text:'',toolCalls:[{id:'read-one',name:'nozeli_document_read',input:{path:'paper.md'}}]},
      {...base,id:'front-result',sequence:2,speaker:'tool',text:'SOURCE RESULT',tool:{name:'nozeli_document_read',status:'complete',output:'SOURCE RESULT'}},
      {...base,id:'front-stream',sequence:3,text:'Partial answer',streaming:true},
    ],deltas:[]});
  });
  await page.waitForSelector('[data-message="front-stream"]');
  assert.equal(await page.$$eval('.session-message',nodes=>nodes.length),1,'tools and streaming answer share one reply bubble');
  assert.equal(await page.$('[data-process-entry]'),null,'process stays collapsed initially');
  await page.click('.session-message>.session-tool>summary');
  await page.waitForSelector('[data-process-entry="front-result"]');
  assert.deepEqual(await page.$$eval('[data-process-entry]',nodes=>nodes.map(node=>node.dataset.processEntry)),['front-call','front-result'],'process keeps original event order');
  await page.focus('.session-message>.session-tool>summary');await page.keyboard.press('Space');
  await page.waitForFunction(()=>!document.querySelector('[data-process-entry]'));
  await page.keyboard.press('Enter');await page.waitForSelector('[data-process-entry="front-result"]');
  await page.evaluate(()=>window.consumer.render());
  assert.equal(await page.$eval('.session-message>.session-tool',node=>node.open),true,'process remains open across unrelated render');
  await page.evaluate(()=>window.consumer.store.apply('project-consumer',{version:1,entries:[{id:'front-final',replacesId:'front-stream',target:'frontdesk',speaker:'agent',source:'native',jobId:'front-one',sequence:3,text:'FINAL ANSWER',durable:true},{id:'other-final',target:'frontdesk',speaker:'agent',source:'native',jobId:'front-two',sequence:4,text:'OTHER ANSWER'}],deltas:[]}));
  await page.waitForSelector('[data-message="front-final"]');
  assert.equal(await page.$$eval('.session-message',nodes=>nodes.length),2,'settlement replaces the stream while another task stays separate');
  assert.match(await page.$eval('[data-message="front-final"]',node=>node.textContent),/FINAL ANSWER/);
  assert.equal(await page.$('[data-message="front-stream"]'),null);
  await page.evaluate(()=>window.consumer.store.apply('project-consumer',{version:1,entries:[{id:'failed-native',target:'frontdesk',speaker:'agent',source:'native',jobId:'front-one',sequence:5,text:'',failed:true,status:'failed',durable:true}],deltas:[]}));
  await page.waitForSelector('[data-message="failed-native"]>[data-reply-state="failed"]');
  assert.equal(await page.$$eval('.session-message',nodes=>nodes.length),2,'empty provider error replaces prior commentary in the same task bubble');
  assert.equal(await page.$eval('[data-message="failed-native"]>[data-reply-state="failed"]',node=>!!node.getClientRects().length),true,'failure is visible without expanding process details');
  await page.evaluate(()=>window.consumer.store.apply('project-consumer',{version:1,entries:[{id:'host-failure',target:'frontdesk',speaker:'system',source:'host',jobId:'front-one',sequence:6,text:'HOST_FAILURE_VISIBLE',durable:true}],deltas:[]}));
  await page.waitForSelector('[data-message="host-failure"]');
  assert.equal(await page.$$eval('.session-message',nodes=>nodes.length),2,'host failure detail belongs to the original task, not a second reply bubble');
  assert.equal(await page.$eval('[data-message="host-failure"]>header strong',node=>node.textContent),'Nozeli','program failure never impersonates the model');
  assert.equal(await page.$eval('[data-message="host-failure"]',node=>node.textContent.includes('HOST_FAILURE_VISIBLE')),true);
  await page.evaluate(()=>{
    const c=window.consumer;c.store.reset('project-consumer');
    c.state.jobs=[{id:'published-job',target:'work-one',revision:1,status:'completed',completion:'host-control'}];
    c.state.works=[{id:'work-one',name:'Native Worker',status:'review',revision:1,result:{objectId:'published-result',revision:1}}];
    c.state.receipts=[{id:'published-receipt',kind:'result',workId:'work-one',jobId:'published-job',revision:1,objectId:'published-result'}];
    const base={target:'work-one',workId:'work-one',jobId:'published-job',revision:1,source:'native'};
    c.store.apply('project-consumer',{version:1,entries:[
      {...base,id:'recovered-check',sequence:1,speaker:'tool',text:'check script failed before correction',tool:{name:'bash',status:'error'}},
      {...base,id:'publish-call',sequence:2,speaker:'agent',text:'发布已核对的结果',complete:true,toolCalls:[{id:'publish',name:'nozeli_result_publish'}]},
      {...base,id:'publication-saved',sequence:3,speaker:'system',source:'host',text:'RESULT SAVED'},
      {id:'historical-plain',target:'frontdesk',speaker:'agent',source:'native',sequence:4,text:'Historical completed answer',complete:true},
    ]});c.render();
  });
  const workerState='.session-worker-meta [data-execution-state]';
  await page.waitForFunction(()=>document.querySelector('.session-worker-meta [data-execution-state="completed"]')?.textContent==='已交付 · 待审核');
  assert.equal(await page.$eval('[data-message="historical-plain"] [data-execution-state]',node=>node.dataset.executionState),'completed');
  assert.equal(await page.$eval('[data-message="publish-call"] [data-history-model]',node=>node.textContent),'模型未记录');
  await page.click('[data-message="recovered-check"] .session-tool>summary');
  assert.match(await page.$eval('[data-message="recovered-check"]',node=>node.textContent),/check script failed before correction/,'historical tool error remains inspectable');
  await page.screenshot({path:path.join(out,'worker-delivered-after-tool-error.png'),fullPage:true});
  for(const status of ['failed','interrupted','unknown']){
    await page.evaluate(status=>{window.consumer.state.jobs[0].status=status;window.consumer.render();},status);
    await page.waitForFunction(status=>document.querySelector('.session-worker-meta [data-execution-state]')?.dataset.executionState===status,{},status);
  }
  await page.evaluate(()=>{window.consumer.state.jobs[0].status='completed';window.consumer.state.receipts[0].jobId='stale-job';window.consumer.render();});
  await page.waitForFunction(()=>document.querySelector('.session-worker-meta [data-execution-state]')?.dataset.executionState==='failed');
  assert.equal(await page.$eval(workerState,node=>node.textContent),'失败','stale publication is not settlement proof');
  await page.evaluate(()=>{window.consumer.state.receipts[0].jobId='published-job';window.consumer.state.receipts[0].objectId='wrong-result';window.consumer.render();});
  await page.waitForFunction(()=>document.querySelector('.session-worker-meta [data-execution-state]')?.dataset.executionState==='failed');
  await page.evaluate(()=>{
    const c=window.consumer,receipt=c.state.receipts[0];receipt.objectId='published-result';receipt.report={objectId:'published-result',digest:'a'.repeat(64)};receipt.snapshot={reportDigest:'a'.repeat(64)};
    c.state.works[0]={...c.state.works[0],revision:2,status:'running',result:null};
    c.state.jobs.push({id:'continued-job',target:'work-one',revision:2,status:'running'});
    c.store.apply('project-consumer',{version:1,entries:[{id:'continued-thinking',target:'work-one',workId:'work-one',jobId:'continued-job',revision:2,speaker:'agent',source:'native',sequence:5,reasoning:'继续执行',text:''}]});c.render();
  });
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.session-worker-meta [data-execution-state]')).map(node=>node.textContent).join('|')==='已交付|思考中');
  await page.evaluate(()=>{window.consumer.state.works[0].status='review';window.consumer.state.works[0].result={objectId:'newer-result',revision:2};window.consumer.render();});
  await page.waitForFunction(()=>document.querySelector('.session-worker-meta [data-execution-state]')?.textContent==='已交付');
  await page.evaluate(()=>{const c=window.consumer;c.state.jobs=[];c.state.receipts=[];c.state.works=[{id:'work-one',name:'Native Worker'}];c.render();});
  await page.evaluate(()=>window.consumer.store.reset('project-consumer'));
  const fullOutput=Array.from({length:1200},(_,i)=>'native output line '+i+' — preserved').join('\n');
  await page.evaluate(fullOutput=>{
    const c=window.consumer;
    c.pages.set('changes-one:0',{changeSetId:'changes-one',binding:{projectId:'project-consumer',workId:'work-one',revision:1,jobId:'job-one',receiptId:'receipt-one',inputCommit:'a'.repeat(40),candidateCommit:'b'.repeat(40)},files:[{fileId:'file-one',path:'src/space name.ts',oldPath:'old/source.py',status:'R100',added:7,deleted:3,binary:false,availability:'available'}],total:2,nextOffset:1});
    c.pages.set('changes-one:1',{changeSetId:'changes-one',binding:{projectId:'project-consumer',workId:'work-one',revision:1,jobId:'job-one',receiptId:'receipt-one'},files:[{fileId:'file-two',path:'assets/picture.png',oldPath:null,status:'A',added:null,deleted:null,binary:true,availability:'unsupported',reason:'binary'}],total:2,nextOffset:null});
    c.state.receipts=[{id:'receipt-one',workId:'work-one',jobId:'job-one',revision:1,changeSetId:'changes-one',files:[{path:'MODEL-INVENTED.ts'}]}];
    c.store.apply('project-consumer',{version:1,entries:[{id:'native-worker',target:'worker',workId:'work-one',jobId:'job-one',revision:1,speaker:'agent',source:'native',sequence:1,text:fullOutput,reasoning:'Private native reasoning <script>window.consumerUnsafe=true</script>',toolCalls:[{id:'call-1',name:'read_file',input:{path:'src/space name.ts',unsafe:'<img onerror="window.consumerUnsafe=true">'}}]}],deltas:[]});
    c.render();
  },fullOutput);
  await page.waitForSelector('[data-frozen-file="file-one"]');
  assert.equal(await page.$eval('.session-worker details',node=>node.open),false,'Worker is collapsed by default');
  assert.equal(await page.$('.session-worker-transcript'),null,'collapsed output is not mounted');
  await page.click('.session-worker>details>summary');
  await page.waitForSelector('.session-worker-transcript');
  await page.evaluate(()=>window.consumer.render());
  assert.equal(await page.$eval('.session-worker>details',node=>node.open),true,'mouse disclosure survives state refresh');
  await page.focus('.session-worker>details>summary');await page.keyboard.press('Space');
  await page.waitForFunction(()=>!document.querySelector('.session-worker-transcript'));
  assert.equal(await page.$eval('[data-frozen-file="file-one"]',node=>node.closest('details')===null),true,'frozen files stay outside collapsed output');
  assert.match(await page.$eval('[data-frozen-file="file-one"]',node=>node.textContent),/src\/space name\.ts/);
  assert.match(await page.$eval('[data-frozen-file="file-one"]',node=>node.textContent),/old\/source\.py → src\/space name\.ts/);
  assert.match(await page.$eval('[data-frozen-file="file-one"]',node=>node.textContent),/\+7/);
  assert.match(await page.$eval('[data-frozen-file="file-one"]',node=>node.textContent),/−3/);
  assert.equal(await page.$$eval('.session-frozen-files button',nodes=>nodes.some(node=>node.textContent.includes('MODEL-INVENTED'))),false,'model-authored file lists are not frozen evidence');
  await page.click('[data-frozen-file="file-one"]');
  assert.deepEqual(await page.evaluate(()=>window.consumer.opened),[{projectId:'project-consumer',changeSetId:'changes-one',fileId:'file-one'}]);
  await page.$eval('.session-frozen-files',node=>[...node.querySelectorAll('button')].find(button=>button.textContent==='更多变更文件').click());
  await page.waitForSelector('[data-frozen-file="file-two"]');
  assert.equal(await page.$('[data-frozen-file="file-one"]'),null,'file pages replace rather than append');
  assert.deepEqual(await page.evaluate(()=>window.consumer.calls),[
    {op:'changes.list',args:{changeSetId:'changes-one',offset:0,limit:100}},
    {op:'changes.list',args:{changeSetId:'changes-one',offset:1,limit:100}},
  ]);
  await page.focus('.session-worker>details>summary');await page.keyboard.press('Enter');
  await page.waitForSelector('.session-worker-transcript .session-plain');
  let consumed='';
  for(;;){consumed+=await page.$eval('.session-worker-transcript>.session-message>.session-content .session-plain',node=>node.textContent);const next=await page.$('.session-worker-transcript>.session-message>.session-content nav button:last-child');if(!next||await next.evaluate(node=>node.disabled))break;await next.click();}
  assert.equal(consumed,fullOutput,'bounded pages retain every line of native output');
  await page.focus('.session-worker-transcript .session-tool summary');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('.session-worker-transcript').textContent.includes('Private native reasoning'));
  await page.$$eval('.session-worker-transcript .session-tool summary',nodes=>nodes.find(node=>node.textContent.includes('工具调用')).click());
  await page.waitForFunction(()=>[...document.querySelectorAll('.session-tool summary')].some(node=>node.textContent.includes('read_file')));
  await page.$$eval('.session-tool summary',nodes=>nodes.find(node=>node.textContent.includes('read_file')).click());
  await page.waitForFunction(()=>document.querySelector('.session-worker-transcript').textContent.includes('src/space name.ts'));
  await page.evaluate(()=>window.consumer.store.apply('project-consumer',{version:1,entries:[{id:'tool-result',target:'worker',workId:'work-one',jobId:'job-one',revision:1,speaker:'tool',source:'native',sequence:1.5,text:'native tool output preserved',tool:{name:'read_file',status:'complete',output:'native tool output preserved'}}]}));
  await page.waitForSelector('.session-worker-transcript>.session-tool>summary');
  await page.click('.session-worker-transcript>.session-tool>summary');
  await page.waitForSelector('[data-process-entry="tool-result"] summary');
  await page.click('[data-process-entry="tool-result"] summary');
  await page.waitForFunction(()=>document.querySelector('[data-message="tool-result"]').textContent.includes('native tool output preserved'));
  await page.click('.session-worker summary');
  await page.waitForFunction(()=>!document.querySelector('.session-worker details').open);
  assert.equal(await page.$eval('[data-frozen-file="file-two"]',node=>node.closest('details')===null),true);

  await page.evaluate(()=>window.consumer.store.apply('project-consumer',{version:1,entries:[{id:'stream-frontdesk',target:'frontdesk',speaker:'agent',source:'native',sequence:2,jobId:'job-frontdesk',streaming:true,text:'partial stream'}]}));
  await page.waitForSelector('[data-message="stream-frontdesk"]');
  assert.equal(await page.evaluate(()=>window.consumer.messages().find(message=>message.id==='stream-frontdesk').streaming),true);
  await page.evaluate(()=>window.consumer.store.apply('project-consumer',{version:1,entries:[{id:'entry-frontdesk',replacesId:'stream-frontdesk',target:'frontdesk',speaker:'agent',source:'native',sequence:2,jobId:'job-frontdesk',streaming:false,text:'Canonical durable reply\n\n<img src=x onerror="window.consumerUnsafe=true"><script>window.consumerUnsafe=true</script>\n\n[unsafe](javascript:window.consumerUnsafe=true)'}]}));
  await page.waitForSelector('[data-message="entry-frontdesk"]');
  assert.equal(await page.$('[data-message="stream-frontdesk"]'),null,'durable identity replaces stream instead of appending a duplicate');
  const identity=await page.evaluate(()=>({main:[...document.querySelectorAll('.session-timeline [data-message]')].map(node=>node.dataset.message),tags:window.consumer.messages()}));
  assert.equal(identity.tags.length,1);
  assert.equal(identity.tags[0].id,'entry-frontdesk');
  assert.equal(identity.tags[0].streaming,false);
  assert(identity.main.includes(identity.tags[0].id),'main transcript and tag compatibility messages share canonical host identity');
  assert.match(await page.$eval('[data-message="entry-frontdesk"]',node=>node.textContent),/Canonical durable reply/);
  assert.equal(await page.$$eval('[data-message="entry-frontdesk"] script,[data-message="entry-frontdesk"] [onerror],[data-message="entry-frontdesk"] a[href^="javascript:"]',nodes=>nodes.length),0,'production Markdown never creates executable HTML or javascript links');
  assert.equal(await page.evaluate(()=>window.consumerUnsafe===true),false);
  const originalText='<script>window.consumerUnsafe=true</script>'+('界🙂 bounded original '.repeat(10000))+'END-OF-ORIGINAL';
  await page.evaluate(text=>{const c=window.consumer;c.originals.set('large-original',{id:'large-original',text,reasoning:'推理🙂'.repeat(9000)+'END-REASONING',tool:{input:{unsafe:'<img onerror="window.consumerUnsafe=true">'},output:'工具🙂'.repeat(9000)+'END-TOOL'},toolCalls:[{name:'read',input:{unsafe:'<script>window.consumerUnsafe=true</script>'}}]});c.store.apply('project-consumer',{version:1,entries:[{id:'large-original',target:'frontdesk',speaker:'agent',source:'native',sequence:3,text:'',availability:'read-required',durable:true}]});},originalText);
  await page.waitForSelector('[data-message="large-original"] .session-original button');
  await page.click('[data-message="large-original"] .session-original button');
  await page.waitForSelector('[data-message="large-original"] .session-plain');
  const consumeOriginal=async()=>{
    let text='';
    for(;;){
      await page.waitForFunction(()=>!document.querySelector('[data-message="large-original"] .session-original [role="status"]'));
      const chunk=await page.$eval('[data-message="large-original"] .session-plain',node=>node.textContent);
      assert(Buffer.byteLength(chunk)<=16384);assert.equal(chunk.includes('\uFFFD'),false);text+=chunk;
      const next=await page.$('[data-message="large-original"] .session-content nav button:last-child');
      if(await next.evaluate(node=>node.disabled))break;
      const position=await page.$eval('[data-message="large-original"] .session-content nav span',node=>node.textContent);await next.click();
      await page.waitForFunction(position=>document.querySelector('[data-message="large-original"] .session-content nav span').textContent!==position,{},position);
    }
    return text;
  };
  assert.equal(await consumeOriginal(),originalText,'host UTF-8 page boundaries preserve every original character');
  for(const [label,expected] of [['推理 / Reasoning','推理🙂'.repeat(9000)+'END-REASONING'],['工具输入',JSON.stringify({unsafe:'<img onerror="window.consumerUnsafe=true">'})],['工具输出','工具🙂'.repeat(9000)+'END-TOOL'],['工具调用（JSON）',JSON.stringify([{name:'read',input:{unsafe:'<script>window.consumerUnsafe=true</script>'}}])]]){
    await page.$$eval('[data-message="large-original"] [aria-label="原文字段"] button',(nodes,label)=>nodes.find(node=>node.textContent===label).click(),label);
    await page.waitForFunction(label=>[...document.querySelectorAll('[data-message="large-original"] [aria-label="原文字段"] button')].some(node=>node.textContent===label&&node.getAttribute('aria-pressed')==='true'),{},label);
    assert.equal(await consumeOriginal(),expected);
  }
  const reads=await page.evaluate(()=>window.consumer.calls.filter(call=>call.op==='timeline.read'));
  assert.deepEqual(reads[0].args,{id:'large-original'});
  assert(reads.length>10);assert(reads.slice(1).every(({args})=>args.limit===16384&&args.version==='a'.repeat(64)&&Number.isSafeInteger(args.offset)));
  await page.click('[data-message="large-original"] .session-original>button');
  assert.equal(await page.$('[data-message="large-original"] .session-plain'),null,'closing releases the retained original page');
  await page.focus('.session-worker>details>summary');await page.keyboard.press('Enter');
  await page.waitForSelector('.session-worker-transcript');
  for(const width of [1440,800,390])for(const font of [14,20]){
    await page.setViewport({width,height:1000});
    await page.evaluate(font=>document.documentElement.style.setProperty('--conversation-font',font+'px'),font);
    assert.equal(await page.$eval('.session-timeline',node=>Math.round(parseFloat(getComputedStyle(node).fontSize))),font,'production conversation font applies');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'surface does not overflow viewport');
    await page.screenshot({path:path.join(out,'surface-'+width+'-'+font+'.png'),fullPage:true});
  }
  assert.equal(await page.$$eval('.session-timeline script,.session-timeline [onerror],.session-timeline a[href^="javascript:"]',nodes=>nodes.length),0);
  assert.equal(await page.evaluate(()=>window.consumerUnsafe===true),false);
  console.log('Synthetic-only styled surface screenshots: '+out);
  await page.evaluate(()=>{const c=window.consumer;c.store.reset('project-consumer');c.state.receipts=[];const base={target:'worker',workId:'work-one',jobId:'density-round',revision:2,source:'native'};c.store.apply('project-consumer',{version:1,entries:[...Array.from({length:6},(_,i)=>({...base,id:'empty-'+i,speaker:i%2?'tool':'agent',sequence:i+1,text:''})),{...base,id:'useful-answer',speaker:'agent',sequence:7,text:'已完成关键核对，仍需你确认结果。'},{...base,id:'dense-tool',speaker:'tool',sequence:8,text:'TECHNICAL_OUTPUT_MARKER',tool:{name:'read_file',status:'complete',output:'TECHNICAL_OUTPUT_MARKER'}},{...base,id:'important-failure',speaker:'agent',sequence:9,text:'连接失败，已有修改保留。',status:'failed',failed:true}],deltas:[]});c.render();});
  await page.waitForSelector('[data-message="important-failure"] [role="alert"]');
  assert.equal(await page.$('.session-worker-transcript'),null,'failure stays visible before opening worker details');
  await page.click('.session-worker>details>summary');await page.waitForSelector('[data-message="useful-answer"]');
  assert.equal(await page.$$eval('.session-worker-transcript .session-message',nodes=>nodes.length),2,'only readable answer and failure create full message blocks');
  assert.equal(await page.$('[data-message="empty-0"]'),null,'empty status records do not create empty messages or actions');
  assert.equal(await page.$('[data-process-entry="dense-tool"]'),null,'opening worker detail does not expand raw tool records');
  await page.click('.session-worker-transcript>.session-tool>summary');await page.waitForSelector('[data-process-entry="dense-tool"]');
  assert.equal(await page.$('[data-process-entry="dense-tool"] .message-actions'),null);
  assert.equal(await page.$('[data-process-entry="dense-tool"] .session-plain'),null,'technical body remains behind its own compact disclosure');
  await page.screenshot({path:path.join(out,'compact-worker-details.png'),fullPage:true});
  await page.click('[data-process-entry="dense-tool"] summary');await page.waitForFunction(()=>document.querySelector('[data-process-entry="dense-tool"]').textContent.includes('TECHNICAL_OUTPUT_MARKER'));
  assert.equal(await page.evaluate(()=>consumer.store.getSnapshot().entries.length),9,'display filtering never deletes original records');
  const patch='diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = "<script>window.consumerUnsafe=true</script>";';
  await page.evaluate(patch=>{const c=window.consumer;c.store.reset('project-consumer');c.store.apply('project-consumer',{version:1,entries:[{id:'diff-output',target:'frontdesk',speaker:'agent',source:'native',sequence:1,text:'```diff\n'+patch+'\n```'}]});},patch);
  await page.waitForSelector('[data-message="diff-output"] code[data-highlighted=diff]');
  assert.equal(await page.$eval('code[data-highlighted=diff]',node=>node.textContent),patch,'highlighting preserves copyable patch content');
  assert.equal(await page.$$eval('code[data-highlighted=diff] script',nodes=>nodes.length),0,'patch contents remain inert text');
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const colors=await page.evaluate(()=>Object.fromEntries(['file','hunk','added','deleted'].map(kind=>{const node=document.querySelector('.markdown-diff-'+kind);const style=getComputedStyle(node);return [kind,{ink:style.color,paper:style.backgroundColor}];})));
    assert.equal(new Set(Object.values(colors).map(value=>value.ink)).size,4,'diff metadata, hunk, additions and deletions remain distinguishable in '+theme);
    assert.notEqual(colors.added.paper,colors.deleted.paper,'addition and deletion papers differ in '+theme);
  }
  assert.equal(await page.evaluate(()=>window.consumerUnsafe===true),false);
  await page.evaluate(()=>{
    const c=window.consumer;c.store.reset('project-consumer');c.state.receipts=[];c.state.todos=[];c.state.agents=[];c.state.works=[];
    c.state.jobs=[{id:'flow-root',target:'orchestrator',type:'intake',status:'queued',context:{manual:true}}];
    c.store.apply('project-consumer',{version:1,entries:[{id:'flow-user',target:'frontdesk',speaker:'user',source:'host',jobId:'flow-root',taskRequestId:'flow-root',sequence:1,text:'按同一任务连续核对页面。'}],deltas:[]},{replace:true});c.render();
  });
  await page.waitForSelector('[data-workflow-id]');await page.evaluate(()=>window.__originalWorkflowBlock=document.querySelector('[data-workflow-id]'));
  await page.evaluate(()=>{
    const c=window.consumer,w={id:'flow-work',name:'同一任务 · 多轮核对',revision:2,status:'ended',sourceJob:'flow-root',sourceInputJobIds:['flow-root','flow-supplement'],outcome:'discard',closure:{decision:'discard',revision:2,requestKey:'flow-discard-confirmed',binding:{workId:'flow-work',revision:2,objectId:null,candidateCommit:null},phase:'complete',stopped:true,report:{digest:'a'.repeat(64)},git:{complete:true,status:'discarded'},workerHome:{cleaned:true}}};c.state.works=[w];
    c.state.jobs=[{id:'flow-root',target:'orchestrator',type:'intake',status:'completed',routing:{action:'dispatch',workId:w.id,name:w.name},context:{manual:true}},{id:'flow-first',target:w.id,type:'initial',status:'completed',revision:1,context:{sourceInputJobIds:['flow-root']}},{id:'flow-supplement',target:'orchestrator',type:'intake',status:'completed',routing:{action:'continue',workId:w.id,workName:w.name},context:{boundWorkId:w.id}},{id:'flow-second',target:w.id,type:'supplement',status:'completed',revision:2,context:{sourceJobId:'flow-supplement'}}];
    const native=(id,target,jobId,revision,sequence,text)=>({id,target,jobId,revision,sequence,text,speaker:'agent',source:'native',recordKind:'conversation',complete:true});
    c.store.apply('project-consumer',{version:1,entries:[{id:'flow-user',target:'frontdesk',speaker:'user',source:'host',jobId:'flow-root',taskRequestId:'flow-root',sequence:1,text:'按同一任务连续核对页面。'},native('flow-arrange','orchestrator','flow-root',null,2,'已安排原任务。'),native('flow-answer-one',w.id,'flow-first',1,3,'第一轮：核对完成。'),native('flow-continue','orchestrator','flow-supplement',null,4,'补充已交给原Worker。'),native('flow-answer-two',w.id,'flow-second',2,5,'第二轮：修改完成。'),{id:'flow-configuration',target:w.id,source:'native',speaker:'system',recordKind:'metadata',entryType:'model_change',sequence:6,text:''},{id:'ordinary-outside-flow',target:'frontdesk',speaker:'user',source:'host',sequence:7,text:'这是独立的普通前台问答。'}],deltas:[]},{replace:true});c.render();
  });
  await page.waitForSelector('[data-workflow-work="flow-work"] [data-work-closeout="flow-work"]');
  assert.equal(await page.evaluate(()=>document.querySelector('[data-workflow-work="flow-work"]')===window.__originalWorkflowBlock),true,'receiving a Work identity must retain the original intake block DOM');
  assert.equal(await page.$$eval('[data-workflow-work="flow-work"] [data-worker-round]',nodes=>nodes.length),2,'one real card per actual Worker round, never a third metadata round');
  const flow=await page.$eval('[data-workflow-work="flow-work"]',node=>({order:[...node.querySelectorAll('[data-orchestrator-job],[data-worker-round],[data-work-closeout]')].map(n=>n.hasAttribute('data-work-closeout')?'closeout':n.hasAttribute('data-worker-round')?'worker':'orchestrator'),outside:!node.contains(document.querySelector('[data-message="ordinary-outside-flow"]'))}));
  assert.deepEqual(flow.order,['orchestrator','worker','orchestrator','worker','closeout']);assert.equal(flow.outside,true,'unrelated foreground conversation must stay outside this task');
  for(const theme of ['light','dark']){await page.setViewport({width:390,height:2300});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(out,'unified-workflow-'+theme+'.png'),fullPage:true});}
  console.log('Unified intake -> Worker multi-round -> Orchestrator closeout block verified');
  await page.evaluate(()=>window.consumer.destroy());
  console.log('Session timeline React/Electron consumer contracts passed');
} catch(error) {
  console.error('Session timeline consumer failure; artifacts: '+out+'\n'+log);
  throw error;
} finally {
  await browser?.disconnect();
  if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(5000)]);if(child.exitCode===null){child.kill('SIGKILL');await exited;}}
  await fs.writeFile(path.join(out,'electron.log'),log);
  // Retain screenshots/logs as evidence; this temporary profile contains only synthetic records.
}
