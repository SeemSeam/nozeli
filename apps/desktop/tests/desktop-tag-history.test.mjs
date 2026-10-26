// [EVIDENCE LABEL: renderer raw-message injection] Actual Electron consumer
// regression for the compact discussion card + AUTO original reader. Replies
// are synthetic canonical messages injected through the production
// applyAgentMessages projection inside a test clone of the renderer — no
// Provider, no real CLI turn. This file is the separately-labeled raw-injection
// evidence; real-chain proof lives in desktop-tag-reply-grouping-live.mjs and
// desktop-point-discussion-live.mjs (bundled OMP + scripted local model).
// Design-1 contract under test: manual 分段读取完整原文/下一段/返回首段 are
// REMOVED; the read-required segment auto-loads the visible page and more as
// the user scrolls, with inline retry on genuine failures; canonical immutable
// versions, complete original access and reader-state retention stay.
import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';import {prepareReading} from './reading-setup.fixture.mjs';
const source=path.resolve(import.meta.dirname,'..');await fs.mkdir(source+'/.test-output',{recursive:true});const out=await fs.mkdtemp(source+'/.test-output/tag-history-'),app=out+'/app';await fs.mkdir(app);
for(const name of ['src','tools','package.json'])await fs.cp(source+'/'+name,app+'/'+name,{recursive:true});for(const name of ['node_modules','vendor','assets','runtime'])await fs.symlink(source+'/'+name,app+'/'+name,'dir');
// Fixture hook must live INSIDE app.mjs's main else-block (where ui and
// applyAgentMessages are lexically bound); appending past the closing brace
// loses them. Insert at the unique in-block ready marker in the test clone only.
const PAGE_BYTES=65536,TOTAL_BYTES=3*PAGE_BYTES;
const pageContent=offset=>{
  if(offset===0)return {head:'Long original page 0 with unique start.\n\n',tail:'\n\n```\nfence-part-one '};
  if(offset===PAGE_BYTES)return {head:'fence-part-two closes the fence\n```\n\nLong original page 1 middle marker.\n\n',tail:''};
  return {head:'Long original page 2 final marker.\n\nFinal original tail sentence.',tail:''};
};
const rendererPath=app+'/src/renderer/app.mjs',rendererSource=await fs.readFile(rendererPath,'utf8'),marker='window.__nozeliReady = false;';
const hook=`let fixtureMessages=[];window.__tagHistory={round:0,reads:0,failNextPageReads:0,shiftVersion:0,offsets:[],deliver(rows){fixtureMessages=rows;applyAgentMessages([], {projectId:ui.project.id,getMessages:()=>fixtureMessages,ensureMessage:async()=>{},readMessage:async(id,options)=>{window.__tagHistory.reads++;if(id==='four-a'){if(!options)return {read:{version:'longwin-v1',maxBytes:65536,fields:[{field:'text',totalBytes:393216}]}};window.__tagHistory.offsets.push(options.offset);const LP=65536;const heads={0:'LONGWIN start marker 甲 with unique opening.\\n\\n\\x60\\x60\\x60\\nlongwin-fence-start ',65536:'longwin-fence-end closes it\\n\\x60\\x60\\x60\\n\\nSecond page after fence 😀emoji near cut.\\n\\n',131072:'| h1 | h2 |\\n| --- | --- |\\n| table-start ',196608:'table-end | done |\\n\\nFourth page body 😀 more text.\\n\\n',262144:'Fifth page filler body.\\n\\n',327680:'LONGWIN final tail marker 乙 ends the immutable original.'};const tails={0:'',65536:'',131072:'',196608:'',262144:'',327680:''};const head=heads[options.offset]||'';const limit=Math.max(0,options.limit??LP);const next=options.offset+limit>=393216?null:options.offset+limit;return {version:'longwin-v1',field:'text',offset:options.offset,nextOffset:next,totalBytes:393216,content:head+'.'.repeat(Math.max(0,limit-head.length))};}if(!options)return {read:{version:'frozen-v1',maxBytes:${PAGE_BYTES},fields:[{field:'text',totalBytes:${TOTAL_BYTES}}]}};if(options.offset===${PAGE_BYTES}&&window.__tagHistory.failNextPageReads>0){window.__tagHistory.failNextPageReads--;throw Error('simulated genuine read failure');}const limit=Math.max(0,options.limit??${PAGE_BYTES});const head=${JSON.stringify(pageContent(0).head)};const parts={0:${JSON.stringify(pageContent(0))},${PAGE_BYTES}:${JSON.stringify(pageContent(PAGE_BYTES))},${2*PAGE_BYTES}:${JSON.stringify(pageContent(2*PAGE_BYTES))}};const p=parts[options.offset]||{head:'',tail:''};const next=options.offset+limit>=${TOTAL_BYTES}?null:options.offset+limit;const body=(p.head+'.'.repeat(Math.max(0,limit-p.head.length-(p.tail||'').length))+(p.tail||''));return {version:window.__tagHistory.shiftVersion>0?'frozen-v2':'frozen-v1',field:'text',offset:options.offset,nextOffset:next,totalBytes:${TOTAL_BYTES},content:body};}});}};window.__agentSelectionAction=async()=>({accepted:true,requestId:'round-'+(++window.__tagHistory.round)});`;
assert.equal(rendererSource.split(marker).length-1,1,'app.mjs ready-false marker must stay unique for the in-block fixture hook');await fs.writeFile(rendererPath,rendererSource.replace(marker,marker+'\n      '+hook));
const build=spawn(process.execPath,[app+'/tools/build-renderer.mjs'],{cwd:app,stdio:'inherit'});assert.equal(await new Promise(r=>build.once('exit',r)),0);
await fs.mkdir(out+'/project');await fs.writeFile(out+'/project/a.txt','A selected original statement.\n');const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));const env={...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:out+'/.Nozeli',NOZELI_USER_DATA:out+'/.Nozeli/desktop',NOZELI_TEST_PICK:out+'/project',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(createRequire(import.meta.url)('electron'),[app+'/src/main/main.cjs','--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{env,stdio:['ignore','pipe','pipe']});let log='',browser;child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const exit=new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));
// Modern workspace surface selection: navigation/state stays on the shell while
// the reader, selection and tags live on the actual native document surface —
// pages are matched by live __workspaceScope identity, never by target order.
const surface=async predicate=>{for(let i=0;i<150;i++){for(const candidate of await browser.pages()){const scope=await candidate.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&predicate(scope)&&await candidate.evaluate(()=>window.__nozeliReady).catch(()=>false))return candidate;}await new Promise(r=>setTimeout(r,100));}throw Error('workspace surface not found');};
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 const shell=await surface(s=>s.role==='shell');await prepareReading(shell);await shell.locator('#pick-project').click();await shell.locator('#file-tree button[data-path="a.txt"]').click();
 const page=await surface(s=>s.role==='surface'&&s.kind==='document'&&s.relPath==='a.txt');await page.waitForFunction(()=>window.__nozeliInput?.text().startsWith('A selected'));
 const noManualReaderControls=async()=>{for(const label of ['分段读取完整原文','下一段','返回首段','收起原文','载入更多原文'])assert(!(await page.$('xpath/.//button[contains(normalize-space(.), "'+label+'")]')),'manual original-read control must stay removed: '+label);};
 await page.evaluate(()=>window.__nozeliInput.select(2,10));await page.locator('#selection-discuss').click();await page.waitForSelector('.tag-editor');
 const send=async text=>{await page.locator('.tag-composer .tag-editor').click();await page.keyboard.type(text);await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');await page.waitForFunction(text=>[...document.querySelectorAll('.tag-message-user')].some(e=>e.textContent.includes(text)),{},text);};
 const msg=(id,round,text,extra={})=>({id,requestId:'round-'+round,role:'qa',sequence:round*10+(id.endsWith('b')?2:1),text,durable:true,jobStatus:'completed',...extra});
 // Transcript shape contract: ONE assistant bubble per request ([data-request-id]),
 // one .tag-markdown[data-message-id] segment per canonical message inside it.
 const shape=()=>page.evaluate(()=>[...document.querySelectorAll('.tag-transcript .tag-message')].map(n=>({role:n.classList.contains('tag-message-user')?'user':n.classList.contains('tag-message-assistant')?'assistant':'other',requestId:n.dataset.requestId??null,text:n.textContent,segments:[...n.querySelectorAll(':scope > .tag-markdown')].map(s=>({messageId:s.dataset.messageId??null,text:s.textContent}))})));
 await send('Question one');const first=[msg('one-a',1,'First complete paragraph.\n\n'+('OLD_PARAGRAPH\n\n'.repeat(80))),msg('one-b',1,'Final paragraph of the first answer.')];await page.evaluate(rows=>__tagHistory.deliver(rows),first);await page.waitForFunction(()=>document.querySelector('.tag-transcript').textContent.includes('Final paragraph of the first answer.'));
 const firstShape=await shape();assert.equal(firstShape.filter(b=>b.role==='assistant').length,1,'same-request canonical messages render as ONE assistant bubble');const firstAssistant=firstShape.find(b=>b.role==='assistant');assert.equal(firstAssistant.requestId,'round-1','one bubble carries the request id');assert.deepEqual(firstAssistant.segments.map(s=>s.messageId),['one-a','one-b'],'both canonical messages keep their own segment inside the single bubble');assert(firstAssistant.segments.some(s=>s.text.includes('First complete paragraph.'))&&firstAssistant.segments.some(s=>s.text.includes('Final paragraph of the first answer.')),'both texts retained in the one bubble');
 await send('Question two');await page.evaluate(rows=>__tagHistory.deliver(rows),[...first,msg('two-a',2,'Second partial',{streaming:true,durable:false,jobStatus:'running'})]);
 await page.evaluate(()=>{window.__retainedTag=document.querySelector('.tag-discuss');window.__retainedEditor=document.querySelector('.tag-editor');window.__retainedTranscript=document.querySelector('.tag-transcript');window.__retainedBubble=document.querySelector('.tag-transcript .tag-message-assistant[data-request-id="round-1"]');const t=window.__retainedTranscript;t.scrollTop=30;window.__oldScroll=t.scrollTop;});
 for(let i=0;i<5;i++)await page.evaluate(rows=>__tagHistory.deliver(rows),[...first,msg('two-a',2,'Second partial '+i,{streaming:true,durable:false,jobStatus:'running'})]);
 assert(await page.evaluate(()=>__retainedTag===document.querySelector('.tag-discuss')&&__retainedEditor===document.querySelector('.tag-editor')&&__retainedTranscript===document.querySelector('.tag-transcript')));
 assert(await page.evaluate(()=>__retainedBubble===document.querySelector('.tag-transcript .tag-message-assistant[data-request-id="round-1"]')&&__retainedBubble.isConnected),'the same one-bubble node is reused while another round streams');
 assert.equal(await page.$eval('.tag-transcript',e=>e.scrollTop),await page.evaluate(()=>window.__oldScroll));
 const second=[...first,msg('two-a',2,'Second final answer.')];await page.evaluate(rows=>__tagHistory.deliver(rows),second);const secondShape=await shape();assert.equal(secondShape.filter(b=>b.role==='assistant').length,2,'second request renders its own SEPARATE assistant bubble');const secondAssistant=secondShape.find(b=>b.role==='assistant'&&b.requestId==='round-2');assert.deepEqual(secondAssistant.segments.map(s=>s.messageId),['two-a'],'second bubble keeps only its own request messages');assert(secondAssistant.text.includes('Second final answer.')&&!secondAssistant.text.includes('Final paragraph of the first answer.'),'second bubble holds only the second request texts');await send('Question three');
 const all=[...second,msg('three-a',3,'',{availability:'read-required',read:{version:'frozen-v1'}})];await page.evaluate(rows=>__tagHistory.deliver(rows),all);
 // --- AUTO original reader (Design 1): the VISIBLE reader loads its first
 // page with NO manual control; hidden/offscreen readers must stay idle.
 await page.waitForSelector('.tag-discuss .tag-original[data-tag-original]',{timeout:20000});
 await noManualReaderControls();
 await page.evaluate(()=>document.querySelector('.tag-original').scrollIntoView({block:'center'}));
 await page.waitForFunction(()=>document.querySelector('.tag-original-body')?.textContent.includes('Long original page 0 with unique start.'),{timeout:20000});
 const descriptorReads=await page.evaluate(()=>__tagHistory.reads);
 // --- Version guard: a page answering a DIFFERENT immutable version is
 // rejected inline (never spliced into the accumulated buffer).
 await page.evaluate(()=>{__tagHistory.shiftVersion=1;});
 await page.evaluate(()=>document.querySelector('.tag-original-sentinel').scrollIntoView({block:'center'}));
 await page.waitForFunction(()=>document.querySelector('.tag-original-status')?.dataset.state==='error',{timeout:20000});
 assert(await page.$eval('.tag-original-body',e=>e.textContent.includes('Long original page 0 with unique start.')),'version-shifted page is never spliced into the accumulated original');
 // --- Genuine read failure -> inline error + explicit Retry; loaded text kept;
 // retry under the frozen version rebuilds cleanly from the fresh descriptor.
 await page.evaluate(()=>{__tagHistory.shiftVersion=0;__tagHistory.failNextPageReads=1;});
 await page.locator('.tag-original-retry').click();
 await page.waitForSelector('.tag-original-retry:not([hidden])',{timeout:20000});
 assert(await page.$eval('.tag-original-body',e=>e.textContent.includes('Long original page 0 with unique start.')),'failed next-page read keeps the already loaded page');
 await page.locator('.tag-original-retry').click();
 await page.waitForFunction(()=>document.querySelector('.tag-original-body')?.textContent.includes('Long original page 0 with unique start.'),{timeout:20000});
 // --- Scroll-driven page 2 of the SAME immutable version (multi-scroll path).
 await page.evaluate(()=>document.querySelector('.tag-original-sentinel').scrollIntoView({block:'center'}));
 await page.waitForFunction(()=>document.querySelector('.tag-original-body')?.textContent.includes('Long original page 1 middle marker.'),{timeout:20000});
 // --- Collapse suspends fetching: no reads while the card is collapsed, and
 // loading resumes on expand + visibility instead of eagerly completing.
 const readsBeforeCollapse=await page.evaluate(()=>__tagHistory.reads);
 await page.evaluate(()=>document.querySelector('.tag-discuss .tag-close')?.click());await page.waitForFunction(()=>document.querySelector('.tag-discuss .note-projection')?.classList.contains('is-collapsed'));
 await new Promise(r=>setTimeout(r,800));
 assert.equal(await page.evaluate(()=>__tagHistory.reads),readsBeforeCollapse,'collapsed/offscreen reader suspends fetching');
 await page.evaluate(()=>document.querySelector('.tag-discuss .tag-close')?.click());await page.waitForFunction(()=>!document.querySelector('.tag-discuss .note-projection')?.classList.contains('is-collapsed'));
 await page.evaluate(()=>document.querySelector('.tag-original').scrollIntoView({block:'start'}));
 await page.evaluate(()=>document.querySelector('.tag-original-sentinel').scrollIntoView({block:'center'}));
 await page.waitForFunction(()=>document.querySelector('.tag-original-body')?.textContent.includes('Final original tail sentence.'),{timeout:20000});
 await page.waitForFunction(()=>document.querySelector('.tag-original-status')?.hidden,{timeout:20000},'progress status must hide once the immutable version is fully loaded');
 const readsAtComplete=await page.evaluate(()=>__tagHistory.reads);
 assert(readsAtComplete>descriptorReads+2,'multiple scroll-driven page loads reached the immutable end');
 // --- ONE markdown document: a code fence split across the page boundary is
 // not independently corrupted; it renders as a single code block.
 const fences=await page.$$eval('.tag-original-body code',nodes=>nodes.map(n=>n.textContent));
 assert.equal(fences.filter(t=>t.includes('fence-part-one')||t.includes('fence-part-two')).length,1,'split code fence renders as ONE code block, not two corrupted halves');
 assert(fences.some(t=>t.includes('fence-part-one')&&t.includes('fence-part-two')),'the joined fence block contains both sides of the page boundary');
 await noManualReaderControls();
 // --- Offscreen history reader stays IDLE (no eager first page for hidden
 // messages); bringing it into view starts its own automatic first page.
 const tallFiller=msg('three-c',3,'OFFSCREEN_FILLER_PARAGRAPH\n\n'.repeat(160),{durable:true});
 const allWithSecondReader=[...all,msg('three-b',3,'',{availability:'read-required',read:{version:'frozen-v1'}}),tallFiller];
 const offscreenProof=()=>page.evaluate(()=>{const t=document.querySelector('.tag-transcript');const readers=[...document.querySelectorAll('.tag-original')];const last=readers[readers.length-1];const clip=t.getBoundingClientRect();const box=last?.getBoundingClientRect();return {transcriptScrollTop:t.scrollTop,readerRects:last?.getClientRects().length??0,readerTop:box?.top??null,clipBottom:clip.bottom,distance:(box&&clip)?box.top-clip.bottom:null};});
 await page.evaluate(()=>{const t=document.querySelector('.tag-transcript');t.scrollTop=0;});
 await page.evaluate(rows=>__tagHistory.deliver(rows),allWithSecondReader);
 // The transcript auto-follows appended rows — a tall filler keeps the new
 // reader far from the tail; pin the scroll away and re-pin across renders.
 for(const delay of [0,120,400,700]){await new Promise(r=>setTimeout(r,delay));await page.evaluate(()=>{const t=document.querySelector('.tag-transcript');t.scrollTop=0;});}
 await new Promise(r=>setTimeout(r,900));
 const offscreen=await offscreenProof();
 if(offscreen.distance==null||offscreen.distance>512){
   assert.equal(await page.evaluate(()=>__tagHistory.reads),readsAtComplete,'offscreen (>512px) read-required history does NOT eagerly load; geometry='+JSON.stringify(offscreen));
 }else{
   // Inside the agreed 512px about-to-read band: at most the one-page
   // prefetch (descriptor + first page) is allowed — never more.
   assert((await page.evaluate(()=>__tagHistory.reads))<=readsAtComplete+2,'lookahead-band reader prefetches at most one page; geometry='+JSON.stringify(offscreen)+' reads='+await page.evaluate(()=>__tagHistory.reads));
 }
 await page.evaluate(()=>{const readers=document.querySelectorAll('.tag-original');readers[readers.length-1].scrollIntoView({block:'center'});});
 await page.waitForFunction(()=>{const readers=document.querySelectorAll('.tag-original-body');return readers.length>1&&readers[readers.length-1].textContent.includes('Long original page 0 with unique start.');},{timeout:20000});
 assert(await page.evaluate(reads=>__tagHistory.reads>reads,readsAtComplete),'the now-visible history reader loads its own first page');
 // --- Reader-state retention: an unrelated transcript update neither refetches
 // (bounded cache, no unbounded re-copy) nor resets the accumulated original.
 const reads=await page.evaluate(()=>__tagHistory.reads);await page.evaluate(()=>document.querySelector('.tag-original-body').scrollTop=40);
 await page.evaluate(rows=>__tagHistory.deliver(rows),allWithSecondReader);await new Promise(r=>setTimeout(r,600));
 assert.equal(await page.evaluate(()=>__tagHistory.reads),reads,'unrelated transcript update does not refetch the original');
 assert(await page.$eval('.tag-original-body',e=>e.textContent.includes('Final original tail sentence.')&&e.textContent.includes('Long original page 0 with unique start.')),'accumulated original text survives re-render');
 const thirdShape=await shape();
 assert.deepEqual(thirdShape.find(b=>b.role==='assistant'&&b.requestId==='round-3').segments.map(s=>s.messageId),['three-a','three-b','three-c'],'every round-3 message keeps its own segment (read-required readers plus the offscreen filler) — no message is dropped');
 for(const text of ['Question one','Question two','Question three','First complete paragraph.','Final paragraph of the first answer.','Second final answer.','Long original page 0 with unique start.','Final original tail sentence.'])assert(await page.$eval('.tag-transcript',(e,text)=>e.textContent.includes(text),text),text);
 assert.equal(descriptorReads>=2,true,'descriptor plus at least one page read were issued automatically');
 // Deterministic flush through production code: the projection persists
 // asynchronously behind the page's enqueue chain; collapse + reopen runs the
 // real onOpen persist with the complete in-memory history (message ids
 // included), so the sidecar cannot stay stale before the reload below.
 await page.evaluate(()=>document.querySelector('.tag-discuss .tag-close')?.click());await page.waitForFunction(()=>document.querySelector('.tag-discuss .note-projection')?.classList.contains('is-collapsed'));
 await page.evaluate(()=>document.querySelector('.tag-discuss .note-index')?.click());await page.waitForFunction(()=>!document.querySelector('.tag-discuss .note-projection')?.classList.contains('is-collapsed'));
 let persisted=null;
 for(let i=0;i<200;i++){persisted=await page.evaluate(async()=>{try{const projectId=window.__workspaceScope.projectId;const a=await nozeli.invoke('annotation.list',{projectId,relPath:'a.txt'});if(!a.ok)throw Error(a.error?.message||'annotation.list failed');return {ok:true,projectId,annotations:(a.value?.annotations||[]).map(n=>({id:n.id,kind:n.kind,hasProjection:Boolean(n.projection),history:(n.projection?.history||[]).map(r=>({requestId:r.requestId,status:r.status,messageIds:r.messageIds||[]}))}))};}catch(error){return {error:String(error&&error.message||error)};}});
  if(persisted.annotations?.some(n=>n.history.length===3&&n.history.every(r=>r.messageIds.length)))break;
  await new Promise(r=>setTimeout(r,300));}
 const liveShape=await shape();
 assert(persisted.annotations?.some(n=>n.history.length===3&&n.history.every(r=>r.messageIds.length)),'persisted annotation projection must carry every round\'s message ids; annotation.list='+JSON.stringify(persisted)+' transcript='+JSON.stringify(liveShape.map(b=>({role:b.role,requestId:b.requestId,segments:b.segments.map(s=>s.messageId)}))));
 await page.reload();await prepareReading(page);await page.waitForSelector('.tag-discuss');await page.evaluate(rows=>__tagHistory.deliver(rows),allWithSecondReader);
 for(const text of ['Question one','Question two','Question three','Final paragraph of the first answer.','Second final answer.'])assert(await page.$eval('.tag-transcript',(e,text)=>e.textContent.includes(text),text),'Reload: '+text);
 const reloaded=await shape();assert.deepEqual(reloaded.filter(b=>b.role==='assistant').map(b=>b.requestId),['round-1','round-2','round-3'],'reload restores exactly one assistant bubble per persisted request');assert.deepEqual(reloaded.find(b=>b.role==='assistant'&&b.requestId==='round-1').segments.map(s=>s.messageId),['one-a','one-b'],'raw history message ids drive the reloaded per-request grouping');
 // Long original access after reopen: bringing the reader into view loads the
 // first page again with no manual controls, same immutable frozen version.
 await page.waitForSelector('.tag-original[data-tag-original]',{timeout:20000});
 await page.evaluate(()=>document.querySelector('.tag-original').scrollIntoView({block:'center'}));
 await page.waitForFunction(()=>document.querySelector('.tag-original-body')?.textContent.includes('Long original page 0 with unique start.'),{timeout:20000});
 await noManualReaderControls();
 // --- Dedicated >window acceptance (Design 1): a 384KiB original (6 pages,
 // > the 256K window budget) with a fence split across pages 0–1, a table
 // split across pages 2–3, and astral emoji at the later cuts. Down-scroll
 // must evict past the budget; scrolling back up must reconstruct the start
 // byte-exactly at a valid boundary — no manual continuation anywhere.
 // The reload reset the fixture counter; move it past the persisted rounds so
 // the fourth admission gets a unique requestId, bind four-a to it, and dump
 // paging state on any stall.
 await page.evaluate(()=>{__tagHistory.round=10;});
 await send('Question four');
 const roundFour=await page.evaluate(()=>'round-'+__tagHistory.round);
 const four={...msg('four-a',11,'',{availability:'read-required',read:{version:'longwin-v1'}}),requestId:roundFour};
 await page.evaluate(rows=>__tagHistory.deliver(rows),[...allWithSecondReader,four]);
 const lastReader=()=>page.evaluate(()=>{const readers=document.querySelectorAll('.tag-original');return readers[readers.length-1];});
 const dumpReaders=()=>page.evaluate(()=>({reads:__tagHistory.reads,offsets:__tagHistory.offsets,readers:[...document.querySelectorAll('.tag-original')].map(root=>({debug:root.debugOriginal?.()??null,connected:root.isConnected,inTranscript:root.closest('.tag-transcript')?.isConnected??false,clientRects:root.getClientRects?.().length??null,status:root.querySelector('.tag-original-status')?.textContent??null,transcriptScroll:root.closest('.tag-transcript')?{top:root.closest('.tag-transcript').scrollTop,height:root.closest('.tag-transcript').scrollHeight}:null}))}));
 const waitOrDump=async(fn,label,timeout=20000)=>{try{await page.waitForFunction(fn,{timeout});}catch(error){throw new Error(label+' stalled — reader state: '+JSON.stringify(await dumpReaders()));}};
 await waitOrDump(()=>document.querySelectorAll('.tag-original').length>=3,'longwin reader mount');
 await page.evaluate(()=>{const readers=document.querySelectorAll('.tag-original');readers[readers.length-1].scrollIntoView({block:'center'});});
 await waitOrDump(()=>{const readers=document.querySelectorAll('.tag-original-body');return readers[readers.length-1]?.textContent.includes('LONGWIN start marker');},'longwin first page');
 for(let i=0;i<50;i++){if(await page.evaluate(()=>__tagHistory.offsets.some(offset=>offset>=4*65536)))break;await page.evaluate(()=>{const readers=document.querySelectorAll('.tag-original');readers[readers.length-1].querySelector('.tag-original-sentinel')?.scrollIntoView({block:'center'});});await new Promise(r=>setTimeout(r,250));}
 assert(await page.evaluate(()=>__tagHistory.offsets.some(offset=>offset>=262144)),'down-scroll pulled pages past the 256K window budget (eviction exercised); state='+JSON.stringify(await dumpReaders()));
 await page.evaluate(()=>{const readers=document.querySelectorAll('.tag-original');readers[readers.length-1].scrollIntoView({block:'start'});});
 await page.evaluate(()=>{const t=document.querySelector('.tag-transcript');t.scrollTop=0;});
 const zerosBefore=await page.evaluate(()=>__tagHistory.offsets.filter(offset=>offset===0).length);
 for(let i=0;i<50;i++){if(await page.evaluate(z=>__tagHistory.offsets.filter(offset=>offset===0).length>z,zerosBefore))break;await page.evaluate(()=>{const readers=document.querySelectorAll('.tag-original');readers[readers.length-1].scrollIntoView({block:'start'});});await new Promise(r=>setTimeout(r,250));}
 assert(await page.evaluate(z=>__tagHistory.offsets.filter(offset=>offset===0).length>z,zerosBefore),'up-scroll refills offset 0 at a valid boundary after eviction; state='+JSON.stringify(await dumpReaders()));
 await waitOrDump(()=>{const readers=document.querySelectorAll('.tag-original-body');return readers[readers.length-1]?.textContent.includes('LONGWIN start marker')&&readers[readers.length-1]?.textContent.includes('😀');},'longwin up-scroll reconstruction');
 const longwinFences=await page.evaluate(()=>{const readers=document.querySelectorAll('.tag-original-body');return [...readers[readers.length-1].querySelectorAll('code')].map(n=>n.textContent);});
 assert.equal(longwinFences.filter(t=>t.includes('longwin-fence-start')||t.includes('longwin-fence-end')).length,1,'the window-held split fence renders as ONE code block');
 assert(longwinFences.some(t=>t.includes('longwin-fence-start')&&t.includes('longwin-fence-end')),'both fence halves are in-window after the up-scroll refill');
 await noManualReaderControls();
 await page.screenshot({path:out+'/longwin-window.png'});
 await page.screenshot({path:out+'/three-rounds.png'});console.log(JSON.stringify({pass:true,label:'renderer raw-message injection (synthetic canonical messages; no Provider)',out,checks:['three full rounds','all same-request paragraphs retained','one assistant bubble per request with per-message segments','separate request gets a separate bubble','same bubble node reused across streaming updates','reload restores the same per-request grouping','stream updates preserve tag/editor/transcript DOM','reading scroll remains fixed','auto original reader: visible first page loads without manual controls','manual segmented-read and load-more controls absent','genuine read failure keeps loaded page and offers explicit retry','version-shifted page never spliced; retry rebuilds under the frozen version','collapse suspends fetching and expand resumes','multi-scroll reaches the immutable end and hides progress','split code fence renders as one block','offscreen history reader stays idle until visible','unrelated update does not refetch or reset the original','reopen restores long original auto access']}));
 await page.evaluate(()=>nozeli.invoke('session.requestClose',{}));assert.deepEqual(await Promise.race([exit,new Promise(r=>setTimeout(()=>r(null),10000))]),{code:0,signal:null});
}catch(error){console.error(log,out);throw error;}finally{await browser?.disconnect();if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exit.catch(()=>{}),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}}
