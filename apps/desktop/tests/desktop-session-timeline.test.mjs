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
      openFrozenChange:args=>{opened.push(args);},onTask(){},onPage(){},onLatest(){}};
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
await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="consumer.css"><style>html,body{margin:0;min-width:0}#conversation{height:100vh;overflow:auto;box-sizing:border-box;padding:16px;width:100%}</style><div id="conversation"><div id="timeline"></div></div><script src="consumer.js"></script>');
await fs.writeFile(path.join(out, 'main.cjs'), `
  const {app,BrowserWindow}=require('electron');
  app.whenReady().then(()=>{const win=new BrowserWindow({show:process.env.NOZELI_TEST_VISIBLE==='1',width:1440,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.join(out, 'index.html'))});});
  app.on('window-all-closed',()=>app.quit());
`);
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(out, 'main.cjs'), '--remote-debugging-port='+port, '--ozone-platform='+(process.env.NOZELI_OZONE||(process.env.NOZELI_TEST_VISIBLE==='1'?'x11':'headless')), '--user-data-dir='+path.join(out,'profile')], {cwd:root,env:{...process.env},stdio:['ignore','pipe','pipe']});
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
  await page.waitForFunction(()=>window.consumer);
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
  await page.waitForSelector('[data-message="tool-result"] summary');
  await page.click('[data-message="tool-result"] summary');
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
