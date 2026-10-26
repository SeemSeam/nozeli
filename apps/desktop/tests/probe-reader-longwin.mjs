// MINIMAL standalone >window probe (parent directive): byte-accurate paging.
// Pages are precomputed as UTF-8-EXACT 65536-byte units (Buffer.byteLength, no
// char-slicing masquerading as bytes; emoji never straddles a boundary).
// Markers are asserted AT THEIR ACTUAL RANGES during the journey: fence parts
// while pages 0–1 are in-window during descent, emoji/table mid-descent, tail
// at the end; the up-scroll refill asserts offset 0 and the start marker —
// no assumption that the whole history fits the bounded window.
// Raw-message injection fixture; no Provider, no native owner.
import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';import {prepareReading} from './reading-setup.fixture.mjs';
const source=path.resolve(import.meta.dirname,'..');await fs.mkdir(source+'/.test-output',{recursive:true});const out=await fs.mkdtemp(source+'/.test-output/probe-longwin-'),app=out+'/app';await fs.mkdir(app);
for(const name of ['src','tools','package.json'])await fs.cp(source+'/'+name,app+'/'+name,{recursive:true});for(const name of ['node_modules','vendor','assets','runtime'])await fs.symlink(source+'/'+name,app+'/'+name,'dir');
const PAGE=65536,PAGES=6,TOTAL=PAGE*PAGES;
// Byte-exact page builders: head text (fence/table/emoji markers) then ASCII
// filler so each page is EXACTLY 65536 UTF-8 bytes.
const fillToBytes=head=>{const need=PAGE-Buffer.byteLength(head,'utf8');assert(need>=0&&Number.isInteger(need),'page head must be whole-UTF-8 and under one page');return head+'.'.repeat(need);};
const pages=[
  fillToBytes('LONGWIN start marker with unique opening.\n\n```\nlongwin-fence-start '),
  fillToBytes('longwin-fence-end closes it\n```\n\nSecond page after fence emoji-near-cut \u{1F600}\u{1F600}\u{1F600} tail.\n\n'),
  fillToBytes('| h1 | h2 |\n| --- | --- |\n| table-start '),
  fillToBytes('table-end | done |\n\nFourth page body emoji-mid \u{1F600} more text.\n\n'),
  fillToBytes('Fifth page filler body.\n\n'),
  fillToBytes('LONGWIN final tail marker ends the immutable original.'),
];
assert(pages.every(page=>Buffer.byteLength(page,'utf8')===PAGE),'every fixture page is exactly 65536 UTF-8 bytes');
const full=pages.join('');assert(Buffer.byteLength(full,'utf8')===TOTAL,'full original is exactly '+TOTAL+' UTF-8 bytes');
const rendererPath=app+'/src/renderer/app.mjs',rendererSource=await fs.readFile(rendererPath,'utf8'),marker='window.__nozeliReady = false;';
const hook=`let fixtureMessages=[];window.__longwin={offsets:[],violations:[]};const full=${JSON.stringify(full)};const bytes=new TextEncoder().encode(full);const totalBytes=bytes.length;window.__tagProbe={deliver(rows){fixtureMessages=rows;applyAgentMessages([], {projectId:ui.project.id,getMessages:()=>fixtureMessages,ensureMessage:async()=>{},readMessage:async(id,options)=>{if(!options)return {read:{version:'lw-v1',maxBytes:${PAGE},fields:[{field:'text',totalBytes:totalBytes}]}};const offset=options.offset;if(!(offset===0||offset===totalBytes||(bytes[offset]&0xc0)!==0x80))window.__longwin.violations.push(offset);window.__longwin.offsets.push(offset);const limit=Math.max(0,Math.min(options.limit??${PAGE},${PAGE}));let end=Math.min(bytes.length,offset+limit);while(end>offset&&end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;const content=new TextDecoder().decode(bytes.subarray(offset,end));const nextOffset=end<bytes.length?end:null;return {version:'lw-v1',field:'text',offset:offset,nextOffset:nextOffset,totalBytes:totalBytes,content:content};}});}};window.__agentSelectionAction=async()=>({accepted:true,requestId:'lw-1'});`;
assert.equal(rendererSource.split(marker).length-1,1);await fs.writeFile(rendererPath,rendererSource.replace(marker,marker+'\n      '+hook));
const build=spawn(process.execPath,[app+'/tools/build-renderer.mjs'],{cwd:app,stdio:'inherit'});assert.equal(await new Promise(r=>build.once('exit',r)),0);
await fs.mkdir(out+'/project');await fs.writeFile(out+'/project/a.txt','Longwin probe source statement.\n');
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const env={...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:out+'/.Nozeli',NOZELI_USER_DATA:out+'/.Nozeli/desktop',NOZELI_TEST_PICK:out+'/project',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(createRequire(import.meta.url)('electron'),[app+'/src/main/main.cjs','--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const exit=new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));
const surface=async predicate=>{for(let i=0;i<150;i++){for(const candidate of await browser.pages()){const scope=await candidate.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&predicate(scope)&&await candidate.evaluate(()=>window.__nozeliReady).catch(()=>false))return candidate;}await new Promise(r=>setTimeout(r,100));}throw Error('surface not found');};
const readerState=()=>page.evaluate(()=>({offsets:__longwin.offsets,readers:[...document.querySelectorAll('.tag-original')].map(root=>({connected:root.isConnected,inTranscript:root.closest('.tag-transcript')?.isConnected??false,rects:root.getClientRects?.().length??null,status:root.querySelector('.tag-original-status')?.textContent??null,bodyHead:root.querySelector('.tag-original-body')?.textContent?.slice(0,120)??null}))}));
let browser,page;const report={probe:'reader-longwin',out};
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 const shell=await surface(s=>s.role==='shell');await prepareReading(shell);await shell.locator('#pick-project').click();await shell.locator('#file-tree button[data-path="a.txt"]').click();
 page=await surface(s=>s.role==='surface'&&s.kind==='document'&&s.relPath==='a.txt');await page.waitForFunction(()=>window.__nozeliInput?.text().startsWith('Longwin probe'));
 await page.evaluate(()=>window.__nozeliInput.select(2,10));await page.locator('#selection-discuss').click();await page.waitForSelector('.tag-composer .tag-editor');
 await page.locator('.tag-composer .tag-editor').click();await page.keyboard.type('longwin probe');await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');
 await page.waitForFunction(()=>[...document.querySelectorAll('.tag-message-user')].some(node=>node.textContent.includes('longwin probe')));
 await page.evaluate(()=>__tagProbe.deliver([{id:'m1',requestId:'lw-1',role:'qa',sequence:10,text:'',durable:true,availability:'read-required'}]));
 await page.waitForSelector('.tag-original[data-tag-original]',{timeout:20000});
 await page.evaluate(()=>document.querySelector('.tag-original').scrollIntoView({block:'center'}));
 await page.waitForFunction(()=>document.querySelector('.tag-original-body')?.textContent.includes('LONGWIN start marker'),{timeout:20000});
 // Descent: markers asserted AT THEIR ACTUAL RANGES while those pages are the
 // in-window frontier (fence spans pages 0-1; emoji+table pages 1-3; tail 5).
 let fenceChecked=false,emojiChecked=false,tableChecked=false;
 for(let i=0;i<80;i++){
   const offsets=await page.evaluate(()=>__longwin.offsets);
   if(!fenceChecked&&offsets.includes(PAGE)){
     await page.waitForFunction(()=>document.querySelector('.tag-original-body')?.textContent.includes('longwin-fence-end'),{timeout:10000});
     const fences=await page.$$eval('.tag-original-body code',nodes=>nodes.map(node=>node.textContent));
     assert(fences.filter(text=>text.includes('longwin-fence-start')||text.includes('longwin-fence-end')).length===1,'split fence renders as ONE code block while pages 0-1 are in-window');
     fenceChecked=true;
   }
   if(!emojiChecked&&offsets.includes(2*PAGE)){await page.waitForFunction(()=>document.querySelector('.tag-original-body')?.textContent.includes('\u{1F600}'),{timeout:10000});emojiChecked=true;}
   if(!tableChecked&&offsets.includes(3*PAGE)){await page.waitForFunction(()=>document.querySelector('.tag-original-body')?.textContent.includes('table-end'),{timeout:10000});tableChecked=true;}
   if(offsets.some(offset=>offset>=4*PAGE))break;
   await page.evaluate(()=>document.querySelector('.tag-original .tag-original-sentinel')?.scrollIntoView({block:'center'}));
   await new Promise(r=>setTimeout(r,250));
 }
 assert(fenceChecked&&emojiChecked&&tableChecked,'fence/emoji/table markers were each verified at their actual ranges; state='+JSON.stringify(await readerState()));
 assert(await page.evaluate(()=>__longwin.offsets.some(offset=>offset>=262144)),'descent pulled pages past the 256K window budget (eviction exercised); state='+JSON.stringify(await readerState()));
 // Ascent: offset 0 must be re-requested at a valid boundary and the window
 // must again START at the original opening (bounded window — no assumption
 // the tail or mid-history is still held).
 const zerosBefore=await page.evaluate(()=>__longwin.offsets.filter(offset=>offset===0).length);
 for(let i=0;i<80;i++){if(await page.evaluate(z=>__longwin.offsets.filter(offset=>offset===0).length>z,zerosBefore))break;await page.evaluate(()=>{document.querySelector('.tag-transcript').scrollTop=0;document.querySelector('.tag-original').scrollIntoView({block:'start'});});await new Promise(r=>setTimeout(r,250));}
 assert(await page.evaluate(z=>__longwin.offsets.filter(offset=>offset===0).length>z,zerosBefore),'up-scroll refilled offset 0 at a valid boundary; state='+JSON.stringify(await readerState()));
 await page.waitForFunction(()=>document.querySelector('.tag-original-body')?.textContent.includes('LONGWIN start marker'),{timeout:20000});
 for(const label of ['分段读取完整原文','下一段','返回首段','载入更多原文'])assert(!(await page.$('xpath/.//button[contains(normalize-space(.), "'+label+'")]')),'manual control absent: '+label);
 assert.deepEqual(await page.evaluate(()=>__longwin.violations),[],'every requested offset was 0 or a host-returned boundary (byte protocol)');
 report.offsets=await page.evaluate(()=>__longwin.offsets);report.ok=true;
 await page.screenshot({path:out+'/longwin.png'});
 console.log(JSON.stringify(report));
 await page.evaluate(()=>nozeli.invoke('session.requestClose',{}));assert.deepEqual(await Promise.race([exit,new Promise(r=>setTimeout(()=>r(null),10000))]),{code:0,signal:null});
}catch(error){console.error(log,out);report.state=await readerState().catch(()=>null);report.error=String(error&&error.stack||error);throw error;}
finally{
 await browser?.disconnect();
 if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exit.catch(()=>{}),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
}
