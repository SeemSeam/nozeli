// [EVIDENCE LABEL: renderer raw-message injection] Actual Electron regression
// for the Design-1 compact material-anchored discussion card: ~28px header
// (number/title/more/collapse, NO font dropdown), source behind the number as
// an on-demand details, ~32px empty composer that auto-grows to ~4 lines then
// scrolls, send inside the composer row, busy/IME-safe sending, draft+height
// retention across async replies and failures, secondary actions behind the
// card menu with confirmed destructive removal, and global conversation size.
// Replies are synthetic canonical messages injected through the production
// projection in a test clone — no Provider, no real CLI turn (real-chain proof
// lives in desktop-tag-reply-grouping-live.mjs / desktop-point-discussion-live.mjs).
import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';import {prepareReading} from './reading-setup.fixture.mjs';
const source=path.resolve(import.meta.dirname,'..');await fs.mkdir(source+'/.test-output',{recursive:true});const out=await fs.mkdtemp(source+'/.test-output/tag-compact-'),app=out+'/app';await fs.mkdir(app);
for(const name of ['src','tools','package.json'])await fs.cp(source+'/'+name,app+'/'+name,{recursive:true});for(const name of ['node_modules','vendor','assets','runtime'])await fs.symlink(source+'/'+name,app+'/'+name,'dir');
// Fixture hook must live INSIDE app.mjs's main else-block (where ui and
// applyAgentMessages are lexically bound); the ready marker line is unique.
const rendererPath=app+'/src/renderer/app.mjs',rendererSource=await fs.readFile(rendererPath,'utf8'),marker='window.__nozeliReady = false;';
const hook=`let fixtureMessages=[];window.__tagCompact={round:0,mode:'accept',deliver(rows){fixtureMessages=rows;applyAgentMessages([], {projectId:ui.project.id,getMessages:()=>fixtureMessages,ensureMessage:async()=>{},readMessage:async()=>{throw Error('no original reader in this scenario');}});}};window.__agentSelectionAction=async()=>{if(window.__tagCompact.mode==='reject')return {accepted:false};return {accepted:true,requestId:'compact-'+(++window.__tagCompact.round)};};`;
assert.equal(rendererSource.split(marker).length-1,1,'app.mjs ready-false marker must stay unique for the in-block fixture hook');await fs.writeFile(rendererPath,rendererSource.replace(marker,marker+'\n      '+hook));
const build=spawn(process.execPath,[app+'/tools/build-renderer.mjs'],{cwd:app,stdio:'inherit'});assert.equal(await new Promise(r=>build.once('exit',r)),0);
await fs.mkdir(out+'/project');await fs.writeFile(out+'/project/a.txt','A selected original statement with compact card target text.\n');const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));const env={...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:out+'/.Nozeli',NOZELI_USER_DATA:out+'/.Nozeli/desktop',NOZELI_TEST_PICK:out+'/project',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(createRequire(import.meta.url)('electron'),[app+'/src/main/main.cjs','--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{env,stdio:['ignore','pipe','pipe']});let log='',browser;child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const exit=new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));
const surface=async predicate=>{for(let i=0;i<150;i++){for(const candidate of await browser.pages()){const scope=await candidate.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&predicate(scope)&&await candidate.evaluate(()=>window.__nozeliReady).catch(()=>false))return candidate;}await new Promise(r=>setTimeout(r,100));}throw Error('workspace surface not found');};
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 const shell=await surface(s=>s.role==='shell');await prepareReading(shell);await shell.locator('#pick-project').click();await shell.locator('#file-tree button[data-path="a.txt"]').click();
 const page=await surface(s=>s.role==='surface'&&s.kind==='document'&&s.relPath==='a.txt');await page.waitForFunction(()=>window.__nozeliInput?.text().startsWith('A selected'));
 await page.evaluate(()=>window.__nozeliInput.select(2,10));await page.locator('#selection-discuss').click();await page.waitForSelector('.tag-chat-window .tag-composer .tag-editor');
 const box=()=>page.evaluate(()=>{const e=document.querySelector('.tag-composer .tag-editor'),c=getComputedStyle(e),b=e.getBoundingClientRect();return {h:b.height,sh:e.scrollHeight,ch:e.clientHeight,fs:c.fontSize,lh:parseFloat(c.lineHeight)||parseFloat(c.fontSize)*1.6,value:e.value};});
 const userBubbles=()=>page.$$eval('.tag-transcript .tag-message-user',ns=>ns.map(n=>n.textContent));
 const typeLines=async lines=>{await page.locator('.tag-composer .tag-editor').click();for(let i=0;i<lines;i++){await page.keyboard.type('Draft line '+i+' with some real content.');if(i<lines-1)await page.keyboard.press('Enter');}};
 const ctrlEnter=async()=>{await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');};
 const syntheticKey=async init=>page.evaluate(init=>{const e=document.querySelector('.tag-composer .tag-editor');e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true,...init}));},init);
 assert(await page.evaluate(()=>{const e=document.querySelector('.tag-delivery');return !e||e.hidden||!e.textContent.trim();}),'idle card shows no always-visible shortcut/status row');
 const head=await page.$eval('.tag-chat-window .note-projection-head',e=>({h:e.getBoundingClientRect().height,ordinal:Boolean(e.querySelector('button.tag-ordinal')),title:Boolean(e.querySelector('.tag-window-title')),more:Boolean(e.querySelector('[data-tag-more]')),close:Boolean(e.querySelector('.tag-close')),fontDropdowns:e.querySelectorAll('[data-chat-font]').length,fontInCard:e.closest('.tag-chat-window').querySelectorAll('[data-chat-font]').length}));
 assert(head.h<=36,'head stays a compact ~28px row (<=36px), got '+head.h);assert(head.ordinal&&head.title&&head.more&&head.close,'header carries number/title/more/collapse');
 assert.equal(head.fontInCard,0,'per-card font dropdown removed; size is owned by global settings');
 // --- Source behind the number: closed details occupies no row; open shows quote.
 assert(await page.$eval('details.tag-source',e=>e.hidden||!e.open),'closed source details occupies no persistent row');
 await page.locator('.tag-chat-window .tag-ordinal').click();
 await page.waitForSelector('details.tag-source:not([hidden])',{timeout:10000});
 assert(await page.$eval('details.tag-source',e=>e.open&&e.querySelector('.tag-source-quote')?.textContent.includes('selected')),'opening the number shows the frozen source quote');
 await page.locator('.tag-chat-window .tag-ordinal').click();await page.waitForFunction(()=>document.querySelector('details.tag-source')?.hidden);
 // --- No welcome bubble in the tag transcript before the first explicit send.
 assert.equal(await page.$$eval('.tag-transcript .tag-message',ns=>ns.length),0,'no welcome/shortcut bubble; empty transcript until the user actually speaks');
assert(await page.evaluate(()=>{const e=document.querySelector('.tag-delivery');return !e||e.hidden||!e.textContent.trim();}),'idle card shows no always-visible shortcut/status row');
// --- B. empty composer ~32px single row; growth follows real content, capped.
const empty=await box();assert(empty.h>=24&&empty.h<=44,'empty composer is a ~32px single row, got '+empty.h);assert(empty.sh<=empty.ch+4,'empty composer does not scroll');
await typeLines(6);const grown=await box();
assert(grown.h>empty.h*2,'multi-line draft grows the composer');assert(grown.sh>grown.ch,'composer caps (~4 lines) and scrolls instead of growing unbounded');assert(grown.h<grown.lh*5.2,'cap keeps the composer near four text rows');
// --- D. send button lives inside the composer row and submits the draft.
assert(await page.$eval('.tag-composer',row=>Boolean(row.querySelector('button.tag-send'))&&row.contains(row.querySelector('textarea.tag-editor'))),'send button is inside the composer row with the textarea');
const beforeUsers=(await userBubbles()).length;await page.locator('.tag-composer .tag-send').click();
await page.waitForFunction(n=>document.querySelectorAll('.tag-transcript .tag-message-user').length>n,{},beforeUsers);
const sent=await box();assert(sent.value==='','accepted send clears the draft');assert(sent.h<=empty.h+6,'cleared composer returns to the single empty row');
// --- C. an async reply arriving while a NONEMPTY draft is being written must
// not shrink or clear it (empty-state styling never reclaims a grown editor).
await typeLines(6);const grownAgain=await box();
await page.evaluate(rows=>__tagCompact.deliver(rows),[{id:'r1a',requestId:'compact-1',role:'qa',sequence:10,text:'A completed earlier reply arrives while a multiline draft is being written.',durable:true,jobStatus:'completed'}]);
await page.waitForFunction(()=>document.querySelector('.tag-transcript')?.textContent.includes('completed earlier reply'));
const afterReply=await box();assert(afterReply.value===grownAgain.value,'async reply does not clear the nonempty draft');assert(afterReply.h>empty.h*1.5,'async reply does not shrink the grown composer back to the empty row');
// --- E. busy permits typing but never an accidental send; IME guarded.
await page.locator('.tag-composer .tag-editor').click();await page.keyboard.down('Control');await page.keyboard.press('a');await page.keyboard.up('Control');
await page.keyboard.type('busy round question');await ctrlEnter();
await page.waitForFunction(text=>[...document.querySelectorAll('.tag-transcript .tag-message-user')].some(node=>node.textContent.includes(text)),{},'busy round question');
await page.evaluate(()=>__tagCompact.deliver([{id:'r2',requestId:'compact-2',role:'qa',sequence:21,text:'',durable:true,jobStatus:'running'}]));
await page.waitForFunction(()=>document.querySelector('.tag-composer .tag-send')?.disabled===true);
 await typeLines(3);const busy=await box();assert(busy.value.includes('Draft line 2'),'typing stays possible while a reply is pending');
 const usersWhileBusy=(await userBubbles()).length;
 await ctrlEnter();await new Promise(r=>setTimeout(r,400));
 assert.equal((await userBubbles()).length,usersWhileBusy,'Ctrl+Enter cannot send while the send button is disabled (busy)');
 await syntheticKey({ctrlKey:true,isComposing:true});await syntheticKey({ctrlKey:true,keyCode:229,which:229});await new Promise(r=>setTimeout(r,400));
 assert.equal((await userBubbles()).length,usersWhileBusy,'IME composition (isComposing / keyCode 229) never sends');
 // --- F. genuine failure retains the draft AND its grown height, then recovers.
 await page.evaluate(()=>{__tagCompact.mode='reject';__tagCompact.deliver([{id:'r2',requestId:'compact-2',role:'qa',sequence:21,text:'',durable:true,jobStatus:'failed'}]);});
 await page.waitForFunction(()=>document.querySelector('.tag-chat-window')?.textContent.includes('失败')||document.querySelector('.tag-delivery')?.textContent.includes('失败'));
 const failedDraft=await box();assert(failedDraft.value.includes('Draft line 2'),'failed delivery keeps the draft text');assert(failedDraft.h>empty.h*1.5,'failed delivery keeps the grown composer height');
 await page.evaluate(()=>{__tagCompact.mode='accept';});const beforeRetry=(await userBubbles()).length;await ctrlEnter();
 await page.waitForFunction(n=>document.querySelectorAll('.tag-transcript .tag-message-user').length>n,{},beforeRetry);
 assert.equal((await box()).value==='',true,'explicit retry send clears the draft after acceptance');
 // --- G. secondary actions in the card menu; removal confirms; collapse!=delete.
 await page.locator('.tag-chat-window [data-tag-more]').click();
 const menu=await page.waitForSelector('.nozeli-context-menu:not([hidden])',{timeout:10000});
 const menuText=await menu.evaluate(e=>e.textContent);
 assert(menuText.includes('移除标签'),'card menu carries the destructive removal action');
 assert(menuText.includes('折叠')||menuText.includes('收起'),'card menu carries collapse (never destructive)');
 const removeItem=await page.$('xpath/.//div[contains(@class,"nozeli-context-menu") and not(@hidden)]//button[contains(normalize-space(.),"移除标签")]');await removeItem.click();
 await page.waitForSelector('#action-confirmation[open]',{timeout:10000});
 const annotations=async()=>page.evaluate(async()=>{const r=await nozeli.invoke('annotation.list',{projectId:window.__workspaceScope.projectId,relPath:'a.txt'});return r.ok?(r.value.annotations||[]).map(n=>({id:n.id,history:(n.projection?.history||[]).length})):[{error:r.error.message}];});
 const beforeRemove=await annotations();
 await page.locator('#action-confirmation-cancel').click();await page.waitForFunction(()=>!document.querySelector('#action-confirmation')?.open);
 assert((await annotations()).length===beforeRemove.length,'cancelled confirmation removes nothing');
 await page.locator('.tag-chat-window .tag-close').click();await page.waitForSelector('.tag-chat-window.is-collapsed');
 assert((await annotations()).length===beforeRemove.length,'collapse is not delete: the annotation survives');
 await page.locator('.tag-chat-window .tag-close').click();await page.waitForFunction(()=>!document.querySelector('.tag-chat-window')?.classList.contains('is-collapsed'));
 await page.locator('.tag-chat-window [data-tag-more]').click();
 const removeItem2=await page.waitForSelector('xpath/.//div[contains(@class,"nozeli-context-menu") and not(@hidden)]//button[contains(normalize-space(.),"移除标签")]',{timeout:10000});await removeItem2.click();
 await page.locator('#action-confirmation-accept').click();await page.waitForFunction(()=>!document.querySelector('.tag-chat-window'));
 const afterRemove=await annotations();
 assert(afterRemove.length===beforeRemove.length&&afterRemove.some(n=>n.history>=1),'removing the projection keeps the persisted conversation history (messages are not deleted)');
 // --- H. global settings own the size: conversation menu resizes the composer;
 // no per-tag font control anywhere in a fresh card.
 // Fresh card via a REAL right-click position discussion (the removed-tag
 // state suppresses the old programmatic selection toolbar path).
 await page.evaluate(()=>{__tagCompact.deliver([]);});
 const freshLeaf=await page.evaluate(()=>{const leaf=document.querySelector('#text-host .cm-line, #text-preview [data-md-from]');const b=leaf.getBoundingClientRect();return {x:b.left+Math.min(40,b.width/2),y:b.top+b.height/2};});
 await page.mouse.click(freshLeaf.x,freshLeaf.y,{button:'right'});await page.waitForSelector('#document-context-menu:not([hidden])',{timeout:15000});
 await page.click('#document-context-menu [data-command="discuss-here"]');await page.waitForSelector('.tag-chat-window .tag-composer .tag-editor');
 const beforeFont=await box();
 await page.waitForSelector('.tag-chat-window .tag-composer .tag-editor',{visible:true});
 // The ACTUAL global control: settings → 项目阅读 → 对话与标签字号
 // (per-project conversationFontSize shared by all discussion surfaces).
 await shell.bringToFront();await shell.click('#open-settings');
 try{await shell.waitForSelector('select[data-project-reading="conversationFontSize"]',{timeout:8000});}catch{
   await shell.click('[data-settings-section="settings-project-reading"]');
   await shell.waitForSelector('select[data-project-reading="conversationFontSize"]',{timeout:10000}).catch(async()=>{
     throw new Error('settings project-reading font select missing; dialog state='+JSON.stringify(await shell.evaluate(()=>({status:document.querySelector('.settings-status, [role="status"]')?.textContent??null,sections:[...document.querySelectorAll('[data-settings-section]')].map(node=>node.dataset.settingsSection)}))));
   });
 }
 await shell.$eval('select[data-project-reading="conversationFontSize"]',node=>{node.value='22';node.dispatchEvent(new Event('change',{bubbles:true}));});
 await shell.waitForFunction(()=>document.body.textContent.includes('已应用并保存到当前项目'),{timeout:10000},'the real workspace.settings persistence path confirmed its saved status');
 await shell.keyboard.press('Escape');
 await page.bringToFront();
 const beforePx=parseFloat(beforeFont.fs);assert(Number.isFinite(beforePx)&&beforePx<22,'beforeFont numeric baseline: '+beforeFont.fs);
 try{await page.waitForFunction(before=>parseFloat(getComputedStyle(document.querySelector('.tag-composer .tag-editor')).fontSize)>before,{timeout:15000},beforePx);}catch(error){const dump=await page.evaluate(()=>({conversationFont:getComputedStyle(document.documentElement).getPropertyValue('--conversation-font'),editorFont:getComputedStyle(document.querySelector('.tag-composer .tag-editor')).fontSize,editorInline:document.querySelector('.tag-composer .tag-editor')?.style?.cssText??null})).catch(()=>null);const shellSelect=await shell.evaluate(()=>document.querySelector('select[data-project-reading="conversationFontSize"]')?.value??null).catch(()=>null);throw new Error('live cross-surface font update failed — '+JSON.stringify({dump,shellSelect})+' (var updated ⇒ CSS; var stale ⇒ broadcast) | '+error.message);}
 const afterFont=await box();assert(parseFloat(afterFont.fs)===22,'global conversation size applies to the tag composer');assert.equal(await page.$$eval('.tag-chat-window [data-chat-font]',ns=>ns.length),0,'the card itself still exposes no font dropdown');
 await page.screenshot({path:out+'/compact-card.png'});
 console.log(JSON.stringify({pass:true,label:'renderer raw-message injection (synthetic canonical messages; no Provider)',out,checks:['~28px header with number/title/more/collapse and no font dropdown','source behind the number as on-demand details with frozen quote','no welcome/shortcut bubble before first send','empty composer ~32px single row','multi-line growth capped ~4 lines then internal scroll','async reply keeps nonempty draft text and height','send button inside composer row submits and clears','busy permits typing but blocks Ctrl+Enter and accidental send','IME composition (isComposing/keyCode 229) never sends','failed delivery retains draft and grown height then explicit retry recovers','card menu removal requires confirmation; cancel removes nothing','collapse keeps the annotation (collapse != delete)','confirmed removal hides the card but keeps persisted history','global conversation size resizes the composer with no per-card control']}));
 await page.evaluate(()=>nozeli.invoke('session.requestClose',{}));assert.deepEqual(await Promise.race([exit,new Promise(r=>setTimeout(()=>r(null),10000))]),{code:0,signal:null});
}catch(error){console.error(log,out);throw error;}finally{await browser?.disconnect();if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exit,new Promise(r=>setTimeout(r,3000))]).catch(()=>{});if(child.exitCode===null)child.kill('SIGKILL');}}
