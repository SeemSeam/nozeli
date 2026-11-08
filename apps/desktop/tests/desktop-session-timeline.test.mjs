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
    import {mountSessionTimeline,mountTaskProcess} from './src/renderer/session-timeline.mjs';
    import {mountTaskWorkspace} from './src/renderer/task-workspace.mjs';
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
      process(snapshot,processState){const container=document.querySelector('#task-process-fixture');window.__processView??=mountTaskProcess(container,{...props,onPage:cursor=>calls.push({op:'process.page',cursor}),onLatest:()=>calls.push({op:'process.latest'})});window.__processView.render({snapshot,state:processState});},
      async workspace(frame,taskScope={sourceJobId:'budget-intake'}){window.__scopeFrame=frame;const previous=document.querySelector('#scope-workspace');if(previous){previous.id='scope-source-fixture';previous.hidden=true;}const root=document.createElement('section');root.id='scope-workspace';document.body.append(root);window.__scopeListeners={};await mountTaskWorkspace({root,scope:{projectId:props.projectId,viewId:taskScope.workId?'work-reader':'source-reader',kind:'task-process',readOnly:true,viewState:{taskScope,taskMode:'process'}},subscribe:(name,listener)=>{window.__scopeListeners[name]=listener;return()=>{};},invoke:async(op,args)=>{calls.push({op:op==='managed.timeline.page'?'timeline.page':op,args});if(op==='managed.timeline.page')return {ok:true,value:window.__scopeFrame};if(op==='managed.status')return {ok:true,value:{state}};if(op==='workspace.ready'||op==='workspace.command')return {ok:true,value:{}};if(op.startsWith('managed.'))return {ok:true,value:await props.call(op.slice(8),args)};throw Error('Unexpected native reader fixture IPC: '+op);}});},
      messages:()=>sessionMessages(store.getSnapshot()),
      render:()=>view.render({state:{...state}}),
      destroy:()=>{view.destroy();store.dispose();}};
  `},
  bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out, 'consumer.js'),
  loader: {'.css': 'css','.ttf':'file','.woff':'file','.woff2':'file'},
});
// Avoid id="process": browser named globals would shadow the optional Node
// process global inspected by bundled syntax-highlighting dependencies.
await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="consumer.css"><style>html,body{margin:0;min-width:0}#conversation{height:100vh;overflow:auto;box-sizing:border-box;padding:16px;width:100%;container:session / inline-size}</style><div id="conversation"><div id="timeline"></div></div><section id="task-process-fixture"></section><script>window.__consumerDiagnostics={errors:[],rejections:[]};addEventListener("error",event=>window.__consumerDiagnostics.errors.push({message:event.message,filename:event.filename,line:event.lineno,column:event.colno,stack:event.error?.stack}));addEventListener("unhandledrejection",event=>window.__consumerDiagnostics.rejections.push({message:String(event.reason),stack:event.reason?.stack}));</script><script src="consumer.js"></script>');
await fs.writeFile(path.join(out, 'main.cjs'), `
  const {app,BrowserWindow}=require('electron');
  app.whenReady().then(()=>{const win=new BrowserWindow({show:true,width:1440,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.webContents.on('console-message',(_event,...args)=>console.error('[consumer renderer console]',...args));win.loadFile(${JSON.stringify(path.join(out, 'index.html'))});});
  app.on('window-all-closed',()=>app.quit());
`);
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(out, 'main.cjs'), '--remote-debugging-port='+port, '--ozone-platform='+(process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':'headless')), '--user-data-dir='+path.join(out,'profile')], {cwd:root,env:{...process.env},stdio:['ignore','pipe','pipe']});
let log='', browser, page;
const browserEvents=[];
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
  page.on('pageerror',error=>browserEvents.push({type:'pageerror',message:error.message,stack:error.stack}));
  page.on('console',message=>browserEvents.push({type:'console',level:message.type(),text:message.text(),location:message.location()}));
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
  await page.evaluate(()=>{const c=window.consumer;c.store.reset('project-consumer');c.state.jobs=[];c.state.agents=[];});
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
  // DOM composition events exercise the guard, not an OS IME candidate window.
  await page.evaluate(()=>{const c=consumer;c.store.reset('project-consumer');c.state.jobs=[];c.state.works=[];c.state.receipts=[];c.store.apply('project-consumer',{version:1,entries:Array.from({length:80},(_,i)=>({id:'reading-'+i,sequence:i,target:'frontdesk',speaker:'agent',source:'native',jobId:'reading-job-'+i,text:'Reading position '+i+'\\n'+('retained content '.repeat(20))})),deltas:[]});c.render();});
  await page.waitForSelector('[data-message="reading-79"]');
  await page.evaluate(()=>{const scroll=document.querySelector('#conversation');scroll.scrollTop=100;scroll.dispatchEvent(new Event('scroll'));document.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'}));window.__readingTop=scroll.scrollTop;consumer.store.apply('project-consumer',{version:1,entries:[{id:'reading-stream',sequence:81,target:'frontdesk',speaker:'agent',source:'native',jobId:'reading-stream-job',text:'STREAM_DURING_COMPOSITION',streaming:true}],deltas:[]});});
  await page.waitForSelector('[data-message="reading-stream"]');
  assert.equal(await page.$eval('#conversation',node=>node.scrollTop),await page.evaluate(()=>window.__readingTop),'streaming never pulls an active reader/IME to tail');
  await page.evaluate(()=>{document.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}));const text=document.querySelector('[data-message="reading-2"] .session-markdown');const range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);window.__selectedReadingText=getSelection().toString();document.dispatchEvent(new Event('selectionchange'));consumer.store.apply('project-consumer',{version:1,entries:[{id:'reading-stream',sequence:81,target:'frontdesk',speaker:'agent',source:'native',jobId:'reading-stream-job',text:'STREAM_WITH_SELECTION',streaming:true}],deltas:[]});});
  await page.waitForFunction(()=>consumer.store.getSnapshot().entries.some(entry=>entry.id==='reading-stream'&&entry.text==='STREAM_WITH_SELECTION'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const heldSelection=await page.evaluate(()=>({text:getSelection().toString(),expected:window.__selectedReadingText,collapsed:getSelection().isCollapsed}));
  assert(heldSelection.expected.length>0,'the guard exercises actual selected Markdown text');
  assert.equal(heldSelection.collapsed,false);assert.equal(heldSelection.text,heldSelection.expected,'incoming stream retains the exact selected original text');
  assert.equal(await page.$eval('#conversation',node=>node.scrollTop),await page.evaluate(()=>window.__readingTop),'selection locks reading position across stream updates');
  // Reading Markdown deliberately defers DOM replacement while any selection
  // is active. Releasing it makes the already-received stream readable.
  await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  await page.waitForFunction(()=>document.querySelector('[data-message="reading-stream"]').textContent.includes('STREAM_WITH_SELECTION'));
  assert.equal(await page.$eval('#conversation',node=>node.scrollTop),await page.evaluate(()=>window.__readingTop),'flushing deferred Markdown does not resume tail-following');
  // Process history is a separate immutable page, not a projection of live chat.
  await page.evaluate(()=>{
    const c=window.consumer;c.calls.length=0;
    const snapshot={version:1,entries:[{id:'old-round-text',target:'history-work',workId:'history-work',jobId:'old-job',revision:1,speaker:'agent',source:'native',sequence:1,text:'ORIGINAL_OLD_PAGE'}],deltas:[],hasMore:true,nextCursor:'scope-owned-cursor'};
    const state={works:[{id:'history-work',name:'History work',revision:1,status:'running'}],jobs:[{id:'old-job',target:'history-work',revision:1,type:'initial',status:'running'}],receipts:[]};
    window.__oldProcessSnapshot=snapshot;window.__oldProcessState=state;c.process(snapshot,state);
  });
  await page.waitForSelector('#task-process-fixture [data-process-entry="old-round-text"]');
  await page.evaluate(()=>{
    const c=window.consumer,state=window.__oldProcessState;
    c.process(window.__oldProcessSnapshot,{...state,works:[{...state.works[0],status:'ended',outcome:'accept',revision:2}],receipts:[{id:'future-receipt',workId:'history-work',jobId:'future-job',revision:1,changeSetId:'FUTURE_SAME_REVISION_CHANGESET',objectId:'future-object'}]});
  });
  await page.waitForFunction(()=>document.querySelector('#task-process-fixture').textContent.includes('ORIGINAL_OLD_PAGE'));
  assert.equal(await page.$('#task-process-fixture [data-work-closeout]'),null,'later live closure never leaks into an old scoped page');
  assert.equal(await page.$('#task-process-fixture [data-change-set="FUTURE_SAME_REVISION_CHANGESET"]'),null,'later receipt of the same revision is not evidence for this old job');
  await page.click('#task-process-fixture [data-task-page="earlier"]');
  assert.deepEqual(await page.evaluate(()=>consumer.calls.filter(c=>c.op==='process.page')),[{op:'process.page',cursor:'scope-owned-cursor'}]);
  assert.equal(await page.$eval('#task-process-fixture [data-process-entry="old-round-text"]',node=>node.textContent.includes('ORIGINAL_OLD_PAGE')),true);
  // A scoped process page larger than the chat-store budget keeps the host's
  // exact scoped cursor; it must not manufacture a global chat cursor.
  await page.evaluate(async()=>{
    const entries=Array.from({length:450},(_,i)=>({id:'budget-'+i,target:'budget-work',workId:'budget-work',jobId:'budget-job',revision:1,sequence:i,speaker:'agent',source:'native',text:'bounded process row '+i}));
    consumer.state.works=[{id:'budget-work',sourceJob:'budget-intake',revision:1,status:'running'}];consumer.state.jobs=[{id:'budget-intake',type:'intake',target:'orchestrator'},{id:'budget-job',target:'budget-work',type:'initial',revision:1,status:'running'}];
    await consumer.workspace({version:1,entries,deltas:[],hasMore:true,nextCursor:'EXACT_HOST_SCOPE_CURSOR'});
  });
  await page.waitForSelector('#scope-workspace [data-task-page="earlier"]');
  await page.click('#scope-workspace [data-task-page="earlier"]');
  await page.waitForFunction(()=>consumer.calls.some(c=>c.op==='timeline.page'&&c.args.cursor==='EXACT_HOST_SCOPE_CURSOR'));
  await page.evaluate(()=>consumer.workspace(window.__scopeFrame,{workId:'budget-work'}));
  await page.waitForFunction(()=>consumer.calls.some(c=>c.op==='timeline.page'&&c.args.workId==='budget-work'));
  const scopedCalls=await page.evaluate(()=>consumer.calls.filter(c=>c.op==='timeline.page'));
  assert.equal(scopedCalls.at(-1).args.cursor,undefined,'a new immutable Work query identity never reuses the source-only cursor');
  assert(scopedCalls.every(c=>c.args.sourceJobId==='budget-intake'||c.args.workId==='budget-work'));
  const visibleScope='#scope-workspace .task-workspace-page:not([hidden])';
  await page.waitForSelector(visibleScope+' [data-process-entry="budget-449"]');
  await page.click(visibleScope+' [data-task-page="earlier"]');
  await page.waitForFunction(selector=>!document.querySelector(selector+' [data-task-page="latest"]').disabled,{},visibleScope);
  const oldPageCalls=await page.evaluate(()=>consumer.calls.filter(c=>c.op==='timeline.page').length);
  await page.evaluate(()=>{window.__scopeFrame={version:1,entries:[{id:'live-scope-new-body',target:'budget-work',workId:'budget-work',jobId:'budget-job',revision:1,sequence:999,speaker:'agent',source:'native',text:'LIVE_SCOPE_BODY_NOT_HEADER'}],deltas:[],hasMore:false,nextCursor:null};window.__scopeListeners.agent({projectId:'project-consumer',kind:'managed-timeline'});});
  assert.equal(await page.evaluate(()=>consumer.calls.filter(c=>c.op==='timeline.page').length),oldPageCalls,'old process page never automatically issues a latest query');
  assert.equal(await page.$(visibleScope+' [data-process-entry="live-scope-new-body"]'),null,'new live body cannot replace an older page');
  assert(await page.$(visibleScope+' [data-process-entry="budget-449"]'),'bounded old page content is retained');
  await page.click(visibleScope+' [data-task-page="latest"]');
  await page.waitForSelector(visibleScope+' [data-process-entry="live-scope-new-body"]');
  assert.match(await page.$eval(visibleScope,node=>node.textContent),/LIVE_SCOPE_BODY_NOT_HEADER/,'explicit latest changes actual process body, not just header');
  await page.evaluate(()=>{window.__retainedProcess=document.querySelector('#scope-workspace [data-task-process]');window.__scopeListeners['workspace.control']({type:'host',projectId:'project-consumer',viewId:'work-reader',kind:'task-process',readOnly:true,generation:1,viewState:{taskScope:{workId:'budget-work'},taskMode:'overview'}});});
  await page.waitForFunction(()=>document.querySelector('#scope-workspace .task-workspace-page:not([hidden])').textContent.includes('只读任务概览'));
  await page.evaluate(()=>window.__scopeListeners['workspace.control']({type:'host',projectId:'project-consumer',viewId:'work-reader',kind:'task-process',readOnly:true,generation:1,viewState:{taskScope:{workId:'foreign-task'},taskMode:'process'}}));
  assert.match(await page.$eval(visibleScope,n=>n.textContent),/只读任务概览/,'foreign task scope cannot switch the bound reader');
  await page.evaluate(()=>window.__scopeListeners['workspace.control']({type:'host',projectId:'project-consumer',viewId:'work-reader',kind:'task-process',readOnly:true,generation:1,viewState:{taskScope:{workId:'budget-work'},taskMode:'process'}}));
  await page.waitForSelector(visibleScope+' [data-process-entry="live-scope-new-body"]');
  assert.equal(await page.evaluate(()=>document.querySelector('#scope-workspace [data-task-process]')===window.__retainedProcess),true,'same-scope host mode switch retains the existing process DOM');
  await page.evaluate(()=>window.consumer.destroy());
  console.log('Session timeline React/Electron consumer contracts passed');
} catch(error) {
  const diagnostics=await page?.evaluate(()=>({url:location.href,readyState:document.readyState,consumerReady:Boolean(window.consumer),startup:window.__consumerDiagnostics})).catch(cause=>({unavailable:cause.message}));
  await fs.writeFile(path.join(out,'browser-diagnostics.json'),JSON.stringify({diagnostics,events:browserEvents},null,2));
  console.error('Browser initialization/runtime diagnostics: '+JSON.stringify({diagnostics,events:browserEvents},null,2));
  console.error('Session timeline consumer failure; artifacts: '+out+'\n'+log);
  throw error;
} finally {
  await fs.writeFile(path.join(out,'browser-events.json'),JSON.stringify(browserEvents,null,2));
  await browser?.disconnect();
  if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(5000)]);if(child.exitCode===null){child.kill('SIGKILL');await exited;}}
  await fs.writeFile(path.join(out,'electron.log'),log);
  // Retain screenshots/logs as evidence; this temporary profile contains only synthetic records.
}
