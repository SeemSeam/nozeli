import {prepareReading,waitForDesktopPage} from './reading-setup.fixture.mjs';
import fs from 'node:fs/promises';import path from 'node:path';import {createRequire} from 'node:module';import {spawn} from 'node:child_process';import net from 'node:net';import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');await fs.mkdir(path.join(root,'.test-output'),{recursive:true});const base=await fs.mkdtemp(path.join(root,'.test-output','label-template-'));const require=createRequire(path.join(root,'package.json'));
await require('esbuild').build({entryPoints:[path.join(root,'src/renderer/note-tag.mjs')],bundle:true,format:'esm',platform:'browser',outfile:path.join(root,'dist/renderer/tag-test.js')});
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const profile=await fs.mkdtemp(path.join(base,'profile-'));
const child=spawn(require('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform='+(process.env.NOZELI_OZONE||'headless')],{cwd:root,env:{...process.env,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_PICK:'',NOZELI_AGENT_FIXTURE:'0',NOZELI_HIDDEN:process.env.NOZELI_TEST_VISIBLE==='1'?'0':'1',NOZELI_OZONE:process.env.NOZELI_OZONE||'headless'},stdio:'ignore'});
await fs.writeFile(path.join(base,'targeted-process.json'),JSON.stringify({pid:child.pid,port,profile}));
let browser;const report={checks:[],errors:[]},pause=ms=>new Promise(r=>setTimeout(r,ms));
try{
 for(let i=0;i<100;i++){try{browser=await require('puppeteer-core').connect({browserURL:'http://127.0.0.1:'+port});break;}catch{await pause(100);}}
 if(!browser)throw new Error('No test window');const page=await waitForDesktopPage(browser);page.on('pageerror',e=>report.errors.push(e.message));
 await prepareReading(page);await page.setViewport({width:1100,height:800});
 await page.evaluate(async()=>{
  const {makeAnchorTag}=await import('/tag-test.js');window.__tagTests={};
  const host=document.createElement('div');host.id='test-label-host';Object.assign(host.style,{position:'fixed',inset:'0',zIndex:'10000',background:'#f3f4f0',display:'flex',gap:'20px',padding:'20px'});document.body.append(host);
  const fence=String.fromCharCode(96).repeat(3),md='# 核心理解\n\n**重点**与*解释*，这里可以选择正文。\n\n- 第一条\n- 第二条\n\n> 引用材料\n\n| 项目 | 说明 |\n|---|---|\n| A | B |\n\n'+fence+'js\nconst value = 1;\n'+fence+'\n\n[safe](https://example.org) [bad](javascript:alert) ![remote](https://invalid.example/image.png)\n\n<img src=x onerror=alert(1)>';
  for(const [i,kind] of ['note','discuss'].entries()){
   const pane=document.createElement('div');pane.className='reader-scroll';Object.assign(pane.style,{position:'relative',flex:'1',minWidth:'0',height:'700px',padding:'35px 15px',overflow:'auto'});host.append(pane);
   const state={open:true,draft:'',saved:0,dispatch:0};window.__tagTests[kind]=state;
   const root=makeAnchorTag({id:kind,ordinal:i+1,kind,text:md,status:'completed',replyText:md,anchor:{quote:'选中的原文'}},{size:()=>({width:450,height:580}),onOpen:(_,v)=>state.open=v,onDraft:(_,v)=>state.draft=v,save:async(_,text)=>{state.saved++;return {text};},remove:()=>{}});pane.append(root);
  }
 });await page.evaluate(()=>{window.__tagEvents=[];for(const type of ['click','dblclick'])document.addEventListener(type,e=>{if(e.target.closest('#test-label-host'))window.__tagEvents.push({type,detail:e.detail,target:e.target.className,x:e.clientX,y:e.clientY});},true);});await pause(200);
 const geometry=selector=>page.$eval(selector,card=>{const h=card.querySelector('.note-projection-head'),style=getComputedStyle(card);return {width:card.offsetWidth,height:card.offsetHeight,radius:style.borderRadius,font:style.font,headHeight:h.offsetHeight,padding:getComputedStyle(h).padding,collapsed:card.classList.contains('is-collapsed'),color:style.backgroundColor,hidden:[...card.children].filter(c=>c!==h).every(c=>c.getBoundingClientRect().height===0),head:h.getBoundingClientRect().toJSON(),bounds:card.getBoundingClientRect().toJSON()};});
 const tag=k=>'#test-label-host .tag-'+k,card=k=>tag(k)+' .note-projection';
 report.open=[await geometry(card('note')),await geometry(card('discuss'))];
 await page.screenshot({path:path.join(base,'unified-open.png')});
 async function dbl(selector){const b=await page.$eval(selector,e=>{const r=e.getBoundingClientRect();return {x:r.left+Math.min(r.width/2,100),y:r.top+r.height/2};});await page.mouse.click(b.x,b.y,{count:2});await pause(80);}
 for(const kind of ['note','discuss']){
  for(let i=0;i<5;i++){
   await dbl(tag(kind)+' .note-projection-head');const closed=await geometry(card(kind));assert.ok(closed.collapsed);assert.ok(closed.hidden);assert.ok(closed.head.bottom<=closed.bounds.bottom+1);
   await dbl(tag(kind)+' .note-projection-content');const open=await geometry(card(kind));assert.ok(!open.collapsed);assert.equal(open.width,report.open[0].width);assert.equal(open.height,report.open[0].height);
  }
  await dbl(tag(kind)+' .tag-transcript');assert.ok(!(await geometry(card(kind))).collapsed);
 }
 report.checks.push('five physical header/summary double-click cycles per type; body word selection never collapses');
 for(const kind of ['note','discuss'])await dbl(tag(kind)+' .note-projection-head');
 report.closed=[await geometry(card('note')),await geometry(card('discuss'))];
 await page.screenshot({path:path.join(base,'unified-closed.png')});report.checks.push('complete collapsed rows; hidden body/editor/actions occupy zero height');
 for(const kind of ['note','discuss'])await dbl(tag(kind)+' .note-projection-content');
 const md=await page.$$eval('#test-label-host .tag-transcript .tag-markdown',nodes=>nodes.map(e=>({h:e.querySelectorAll('h1').length,strong:e.querySelectorAll('strong').length,code:e.querySelectorAll('pre code').length,table:e.querySelectorAll('table').length,unsafe:e.querySelectorAll('script,img,[onerror],a[href^="javascript:"]').length})));
 assert.ok(md.length>=3&&md.every(m=>m.h&&m.strong&&m.code&&m.table&&m.unsafe===0));report.checks.push('notes and both conversation message roles render safe GFM without image requests or executable HTML');
 const editNote=async()=>{await page.click(tag('note')+' [data-tag-more]');await page.click('#tag-card-menu [data-command="card-edit"]');};
 await editNote();await page.focus(tag('note')+' .tag-editor');await page.keyboard.down('Control');await page.keyboard.press('a');await page.keyboard.up('Control');await page.keyboard.type('**retained note draft**');
 await dbl(tag('note')+' .tag-editor');assert.ok(!(await geometry(card('note'))).collapsed);
 await dbl(tag('note')+' .note-projection-head');await dbl(tag('note')+' .note-projection-content');await editNote();assert.equal(await page.$eval(tag('note')+' .tag-editor',e=>e.value),'**retained note draft**');
 await page.click(tag('note')+' .tag-composer .tag-send');await pause(80);assert.equal(await page.$eval(tag('note')+' .tag-note-body strong',e=>e.textContent),'retained note draft');assert.equal(await page.evaluate(()=>window.__tagTests.note.saved),1);report.checks.push('explicit edit preserves Markdown draft through collapse; local save refreshes rendered preview');
 await page.setViewport({width:390,height:844});await page.evaluate(()=>{const host=document.querySelector('#test-label-host');host.style.flexDirection='column';host.style.overflow='auto';for(const p of host.children){p.style.flex='0 0 600px';p.style.height='600px';}});await pause(200);
 const narrow=await geometry(card('note'));assert.ok(narrow.bounds.left>=0&&narrow.bounds.right<=390);await page.screenshot({path:path.join(base,'unified-narrow.png')});report.checks.push('note window fits 390px viewport');
 await page.evaluate(async()=>{
  document.querySelector('#test-label-host').remove();
  const {makeAnchorTag}=await import('/tag-test.js');
  const pane=document.createElement('div');pane.id='test-label-host';pane.className='reader-scroll';
  Object.assign(pane.style,{position:'fixed',left:'60px',top:'20px',width:'calc(100vw - 80px)',height:'600px',border:'3px solid transparent',overflow:'auto',zIndex:'10000',background:'var(--paper)'});document.body.append(pane);
  const surface=document.createElement('div');Object.assign(surface.style,{position:'relative',height:'900px',width:'100%'});pane.append(surface);
  window.__geometryState={moves:[],sizes:[]};
  const tag=makeAnchorTag({id:'geometry',ordinal:3,kind:'discuss',text:'original question',replyText:'original reply',status:'completed',draftText:'retained geometry draft'},{offset:()=>[110,35],size:()=>({width:420,height:430}),move:(_,value)=>__geometryState.moves.push(value),resize:(_,value)=>__geometryState.sizes.push(value)});
  Object.assign(tag.style,{position:'absolute',left:'62%',top:'90px'});surface.append(tag);
  pane.style.setProperty('--conversation-font','18px');tag.querySelector('.tag-editor').focus();tag.querySelector('.tag-editor').setSelectionRange(4,10);
 });
 const fitState=()=>page.evaluate(()=>{
  const pane=document.querySelector('#test-label-host'),tag=pane.querySelector('.note-anchor'),card=tag.querySelector('.note-projection'),editor=tag.querySelector('.tag-editor');
  const p=pane.getBoundingClientRect(),b=card.getBoundingClientRect(),left=Math.max(0,p.left+pane.clientLeft)+8,right=Math.min(innerWidth,p.left+pane.clientLeft+pane.clientWidth)-8;
  const buttons=[...card.querySelectorAll('.note-projection-head button')].filter(n=>n.getBoundingClientRect().width>0);
  const translation=new DOMMatrix(getComputedStyle(card).transform);
  return{bounds:b.toJSON(),left,right,translation:[translation.m41,translation.m42],font:getComputedStyle(editor).fontSize,focus:document.activeElement===editor,draft:editor.value,selection:[editor.selectionStart,editor.selectionEnd],sizes:__geometryState.sizes.length,moves:__geometryState.moves.length,buttons:buttons.every(n=>{const r=n.getBoundingClientRect();return r.left>=b.left-1&&r.right<=b.right+1;}),overflow:card.scrollWidth-card.clientWidth};
 });
 for(const width of [1440,800,390,1440]){
  await page.setViewport({width,height:900});await pause(200);
  const state=await fitState();assert(state.bounds.left>=state.left-1&&state.bounds.right<=state.right+1,JSON.stringify({width,state}));
  assert.deepEqual(state.translation,[110,35]);assert.equal(state.sizes,0);assert.equal(state.moves,0);
  assert(state.focus&&state.buttons&&state.overflow<=1,JSON.stringify(state));assert.equal(state.draft,'retained geometry draft');assert.deepEqual(state.selection,[4,10]);
  assert.equal(state.font,'18px');
  if(width===1440)assert.equal(state.bounds.width,420);
 }
 report.checks.push('saved offset and width survive 1440/800/390/1440 pane clamps without persistence writes, clipped header actions, draft loss or focus/caret changes');
 // An offscreen source must not leave its card clamped against either edge.
 for(const [name,anchorTop,scrollTop] of [['below',800,0],['above',90,300]]){
  await page.evaluate(({anchorTop,scrollTop})=>{const pane=document.querySelector('#test-label-host');pane.querySelector('.note-anchor').style.top=anchorTop+'px';pane.scrollTop=scrollTop;if(anchorTop===800)pane.querySelector('.note-anchor').relayout();},{anchorTop,scrollTop});
  await pause(150);
  await page.screenshot({path:path.join(base,'offscreen-'+name+'.png')});
  assert.equal(await page.$eval('#test-label-host .note-projection',node=>getComputedStyle(node).visibility),'hidden',name+': offscreen anchor must hide its card rather than pinning it');
 }
 await page.evaluate(()=>{const pane=document.querySelector('#test-label-host');pane.querySelector('.note-anchor').style.top='90px';pane.scrollTop=0;});await pause(150);
 assert.notEqual(await page.$eval('#test-label-host .note-projection',node=>getComputedStyle(node).visibility),'hidden','scrolling the source back restores its card');
 await page.mouse.move(100,150);await page.mouse.wheel({deltaY:350});
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('#test-label-host .note-projection')).visibility==='hidden');
 await page.screenshot({path:path.join(base,'offscreen-wheel.png')});
 await page.mouse.wheel({deltaY:-1000});
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('#test-label-host .note-projection')).visibility!=='hidden');
 await page.screenshot({path:path.join(base,'scroll-back-restored.png')});
 assert.equal((await fitState()).draft,'retained geometry draft');
 assert.deepEqual((await fitState()).translation,[110,35]);
 assert.equal((await fitState()).moves+(await fitState()).sizes,0,'scroll visibility does not persist layout changes');
 report.checks.push('anchors above/below the viewport hide rather than pinning cards; scrolling back restores the same draft and saved geometry');
 await page.setViewport({width:390,height:900});await page.$eval('#test-label-host',n=>{n.style.width='260px';n.style.removeProperty('--conversation-font');});await pause(200);
const fontEditor='#test-label-host .tag-editor';
const openConversationFontMenu=async()=>{await page.click(fontEditor,{button:'right'});await page.waitForSelector('#conversation-context-menu:not([hidden])');};
await page.focus(fontEditor);await page.$eval(fontEditor,n=>n.setSelectionRange(4,10));
assert.equal(await page.$$eval('#test-label-host [data-chat-font]',nodes=>nodes.length),0,'compact card exposes no per-card font dropdown');
await openConversationFontMenu();
// A physical click first hovers the owner: the submenu must not replace its hit target.
await page.click('#conversation-context-menu [data-command="chat-font"]');
await page.waitForSelector('.nozeli-submenu [data-command="chat-font-20"]',{visible:true});
const submenu=await page.$eval('.nozeli-submenu',n=>n.getBoundingClientRect().toJSON());
assert(submenu.left>=0&&submenu.top>=0&&submenu.right<=390&&submenu.bottom<=900);
assert.equal(await page.evaluate(()=>document.activeElement.dataset.command),'chat-font-larger');
await page.screenshot({path:path.join(base,'narrow-font-pointer-menu.png')});
await page.click('.nozeli-submenu [data-command="chat-font-20"]');
await page.waitForFunction(()=>document.querySelector('#test-label-host .tag-editor').style.fontSize==='20px'||getComputedStyle(document.querySelector('#test-label-host .tag-editor')).fontSize==='20px');
assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#test-label-host .tag-editor')),true);
assert.equal(await page.$eval(fontEditor,n=>n.value),'retained geometry draft');
assert.deepEqual(await page.$eval(fontEditor,n=>[n.selectionStart,n.selectionEnd]),[4,10]);
await openConversationFontMenu();await page.focus('#conversation-context-menu [data-command="chat-font"]');await page.keyboard.press('ArrowRight');
await page.waitForSelector('.nozeli-submenu [data-command="chat-font-20"]',{visible:true});
await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#test-label-host .tag-editor')),true);
await openConversationFontMenu();await page.$eval('#test-label-host',n=>n.scrollTop+=20);
await page.waitForSelector('#conversation-context-menu:not([hidden])',{hidden:true});
 await page.setViewport({width:1440,height:900});await pause(200);
report.checks.push('390px right-click font owner click opens bounded submenu without activating an overlaid command; 20px choice retains editor focus/draft/caret, keyboard Escape restores focus, reader scroll dismisses menu; no per-card font dropdown exists');
 await page.evaluate(()=>{const pane=document.querySelector('#test-label-host');pane.style.width='220px';pane.scrollTop=40;});await pause(200);
 const split=await fitState();assert(split.bounds.width<220&&split.bounds.right<=split.right+1&&split.bounds.left>=split.left-1,JSON.stringify(split));assert.equal(split.sizes,0);
 report.checks.push('sub-240px pane overrides the shell minimum width and clamps after scroll');
 await page.evaluate(async()=>{
  const pane=document.querySelector('#test-label-host');pane.style.width='900px';pane.style.height='650px';pane.scrollTop=0;
  const badge=document.createElement('span');badge.className='guided-demo-content-badge';document.body.append(badge);
  pane.querySelector('.note-anchor').relayout();
  const {makeAnchorTag}=await import('/tag-test.js');
  const tag=makeAnchorTag({id:'demo-new',ordinal:4,kind:'note',text:'new demo note',status:{value:'unsent demo draft'}},{size:()=>({width:420,height:430}),offset:()=>[110,35],autoEdit:()=>true,onDraft:()=>{}});
  Object.assign(tag.style,{position:'absolute',left:'62%',top:'90px'});pane.firstElementChild.append(tag);
 });await pause(200);
 const visibleTagIds=()=>page.$$eval('#test-label-host .note-projection',nodes=>nodes.filter(node=>node.getBoundingClientRect().width>0).map(node=>node.closest('[data-annotation]').dataset.annotation));
 assert.deepEqual(await visibleTagIds(),['demo-new']);
 assert.equal(await page.$eval('[data-annotation="demo-new"] .demo-tag-selector',node=>node.options.length),2);
 await page.select('[data-annotation="demo-new"] .demo-tag-selector','geometry');await pause(120);
 assert.equal(await page.$eval('[data-annotation="geometry"] .tag-editor',node=>node.value),'retained geometry draft');
 assert.deepEqual(await visibleTagIds(),['geometry']);
 await page.select('[data-annotation="geometry"] .demo-tag-selector','demo-new');await pause(120);
 assert.equal(await page.$eval('[data-annotation="demo-new"] .tag-editor',node=>node.value),'unsent demo draft');
 assert.deepEqual(await visibleTagIds(),['demo-new']);
 for(const width of [1440,390]){
  await page.setViewport({width,height:900});
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('nozeli-demo-obstacles',{detail:{rects:[{x:0,y:0,width:innerWidth,height:260}]}})));await pause(160);
  const box=await page.$eval('[data-annotation="demo-new"] .note-projection',node=>node.getBoundingClientRect().toJSON());
  assert(box.top>=260&&box.right<=width&&box.left>=0,JSON.stringify(box));
  assert.deepEqual(await visibleTagIds(),['demo-new']);
 }
 assert.equal(await page.evaluate(()=>__geometryState.moves.length+__geometryState.sizes.length),0);
 report.checks.push('demo pane collects old cards and summaries in an accessible selector, preserves both drafts and stored geometry, and avoids native overlay rectangles on wide/narrow viewports');
 await page.evaluate(async()=>{
  window.dispatchEvent(new CustomEvent('nozeli-demo-active-tag',{detail:{annotationId:'demo-discussion'}}));
  const {makeAnchorTag}=await import('/tag-test.js');
  const tag=makeAnchorTag({id:'demo-discussion',ordinal:5,kind:'discuss',text:'current demo discussion',status:'draft'},{size:()=>({width:420,height:430}),offset:()=>[110,35]});
  Object.assign(tag.style,{position:'absolute',left:'62%',top:'90px'});document.querySelector('#test-label-host').firstElementChild.append(tag);
 });await pause(160);
 assert.deepEqual(await visibleTagIds(),['demo-discussion']);
 await page.evaluate(async()=>{
  const old=document.querySelector('[data-annotation="demo-new"]'),parent=old.parentElement;old.remove();
  const {makeAnchorTag}=await import('/tag-test.js');
  const note=makeAnchorTag({id:'demo-new',ordinal:4,kind:'note',text:'new demo note',status:{value:'unsent demo draft'}},{size:()=>({width:420,height:430}),offset:()=>[110,35],autoEdit:()=>true});
  Object.assign(note.style,{position:'absolute',left:'62%',top:'90px'});parent.append(note);
 });await pause(160);
 assert.deepEqual(await visibleTagIds(),['demo-discussion'],'an older note remount cannot steal the current discussion');
 await page.evaluate(()=>document.querySelector('[data-annotation="demo-discussion"]').updateConversation({kind:'discuss',text:'current demo discussion',status:'completed',replyText:'visible completed reply',anchor:{}}));await pause(160);
 assert.deepEqual(await visibleTagIds(),['demo-discussion'],'reply projection retains the requested discussion identity');
 assert.match(await page.$eval('[data-annotation="demo-discussion"] .tag-transcript',node=>node.innerText),/visible completed reply/);
 assert.equal(await page.$eval('[data-annotation="demo-new"] .tag-editor',node=>node.value),'unsent demo draft');
 report.checks.push('explicit demo annotation identity wins over later old-note remounts and completed-reply projection; visible card id and reply text match the step');
 assert.equal(report.errors.length,0);
 let windowClosed=false;page.once('close',()=>{windowClosed=true;});
 const processExited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 await page.evaluate(()=>{void window.nozeli.invoke('session.requestClose',{});});
 for(let i=0;i<100&&!windowClosed;i++)await pause(100);
 assert.ok(windowClosed,'normal close must flush state and close the window');
 const exit=await Promise.race([processExited,pause(10000).then(()=>null)]);
 assert.ok(exit,'closing the last window must exit the Electron process');assert.equal(exit.code,0);assert.equal(exit.signal,null);
 report.exit=exit;report.checks.push('normal close flushes renderer state, closes the window, and exits Electron with code 0');report.ok=true;
}catch(e){report.ok=false;report.error=e.stack;if(browser?.connected){const p=(await browser.pages()).at(-1);if(p&&!p.isClosed()){report.events=await p.evaluate(()=>window.__tagEvents);await p.screenshot({path:path.join(base,'targeted-failure.png')});}}}finally{if(browser)await browser.disconnect();child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(1500)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');child.unref();await fs.rm(path.join(root,'dist/renderer/tag-test.js'),{force:true});await fs.writeFile(path.join(base,'targeted-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output:base,ok:report.ok,checks:report.checks,error:report.error},null,2));process.exitCode=report.ok?0:1;}
