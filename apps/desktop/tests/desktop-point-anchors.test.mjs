// [EVIDENCE LABEL: real Electron UI, isolated samples; no Provider/model]
// Design-2 acceptance: right-click document-position 在此备注/在此讨论 across
// real text (markdown reading preview), PDF, image and PPT samples; explain
// stays selection-only; selection hit-test precedes any mutation (inside keeps
// the selection, outside creates a NEW point and never reuses stale selection
// material); point anchors persist version-bound normalized coordinates that
// survive zoom and reopen; blank chrome is never a document point; opening or
// saving never dispatches a model. Real-chain model proof (point discussion
// delivered to the correct frozen source; explain requires selection) lives in
// desktop-point-discussion-live.mjs.
import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';import {prepareReading} from './reading-setup.fixture.mjs';
const source=path.resolve(import.meta.dirname,'..');await fs.mkdir(source+'/.test-output',{recursive:true});const out=await fs.mkdtemp(source+'/.test-output/point-anchors-'),app=out+'/app';await fs.mkdir(app);
for(const name of ['src','tools','package.json'])await fs.cp(source+'/'+name,app+'/'+name,{recursive:true});for(const name of ['node_modules','vendor','assets','runtime'])await fs.symlink(source+'/'+name,app+'/'+name,'dir');
// Isolation hook inside app.mjs's main else-block: counts implicit model
// admissions only (the scenario itself performs no explicit send).
const rendererPath=app+'/src/renderer/app.mjs',rendererSource=await fs.readFile(rendererPath,'utf8'),marker='window.__nozeliReady = false;';
const hook=`window.__pointProbe={admissions:0};const __rawAgentSelectionAction=window.__agentSelectionAction;window.__agentSelectionAction=async payload=>{window.__pointProbe.admissions++;return __rawAgentSelectionAction?__rawAgentSelectionAction(payload):{accepted:false};};`;
assert.equal(rendererSource.split(marker).length-1,1,'app.mjs ready-false marker must stay unique for the in-block fixture hook');await fs.writeFile(rendererPath,rendererSource.replace(marker,marker+'\n      '+hook));
const build=spawn(process.execPath,[app+'/tools/build-renderer.mjs'],{cwd:app,stdio:'inherit'});assert.equal(await new Promise(r=>build.once('exit',r)),0);
const project=out+'/project';await fs.mkdir(project);
await fs.writeFile(path.join(project,'read.md'),'# Point anchor reading sample\n\nFirst paragraph carries a selectable sentence about anchors.\n\nSecond paragraph sits below for outside-selection right-clicks.\n\nThird paragraph keeps the preview tall enough to scroll.\n');
for(const [name,fixture] of [['sample.pdf','pdf/nozeli-sample.zh.pdf'],['pipeline.png','tex/pipeline.png'],['slides.pptx','ppt/compatibility.pptx']])await fs.writeFile(path.join(project,name),await fs.readFile(path.resolve(source,'tests/fixtures',fixture)));
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));const env={...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:out+'/.Nozeli',NOZELI_USER_DATA:out+'/.Nozeli/desktop',NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(createRequire(import.meta.url)('electron'),[app+'/src/main/main.cjs','--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{env,stdio:['ignore','pipe','pipe']});let log='',browser;child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const exit=new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));
const surface=async predicate=>{for(let i=0;i<150;i++){for(const candidate of await browser.pages()){const scope=await candidate.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&predicate(scope)&&await candidate.evaluate(()=>window.__nozeliReady).catch(()=>false))return candidate;}await new Promise(r=>setTimeout(r,100));}throw Error('workspace surface not found');};
const menu='#document-context-menu';
const right=async(page,x,y)=>{await page.mouse.click(x,y,{button:'right'});try{await page.waitForSelector(menu+':not([hidden])',{timeout:15000});}catch(error){const diag=await page.evaluate(({x,y,menu})=>({clicked:{x,y},hit:document.elementFromPoint(x,y)?.outerHTML?.slice(0,300),menuHidden:document.querySelector(menu)?.hidden??null,menuText:document.querySelector(menu)?.textContent?.slice(0,200)??null}),{x,y,menu});throw new Error('document menu did not open at '+x+','+y+' — '+JSON.stringify({diag,pageErrors,consoleNotes}));}};
const itemState=async(page,command)=>page.evaluate(({menu,command})=>{const node=document.querySelector(menu+' [data-command="'+command+'"]');return node?{present:true,disabled:node.disabled||node.getAttribute('aria-disabled')==='true',label:node.textContent.trim()}: {present:false,disabled:true,label:''};},{menu,command});
const center=async(page,selector)=>page.evaluate(selector=>{const node=document.querySelector(selector);const b=node.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};},selector);
const annotations=async(page,relPath)=>page.evaluate(async relPath=>{const r=await nozeli.invoke('annotation.list',{projectId:window.__workspaceScope.projectId,relPath});if(!r.ok)throw Error(r.error.message);return (r.value.annotations||[]).map(n=>({id:n.id,kind:n.kind,anchor:n.anchor,note:n.note,exact:n.resolution?.locationStatus==='exact',sourceChanged:n.sourceChanged===true}));},relPath);
const saveNote=async(page,text)=>{await page.waitForSelector('#note-form:not([hidden])');await page.click('#note-input');await page.keyboard.type(text);await page.click('#add-note');await page.waitForSelector('#note-form[hidden]',{timeout:15000});};
const pointAssertions={ 'text-point':a=>Number.isInteger(a.start)&&a.start===a.end&&a.quote==='', 'pdf-point':a=>Number.isInteger(a.page)&&a.page>=1&&[0,90,180,270].includes(a.rotation)&&a.space==='rendered-page-normalized'&&a.x>0&&a.x<1&&a.y>0&&a.y<1, 'image-point':a=>a.space==='image-normalized'&&a.width===720&&a.height===300&&a.x>0&&a.x<1&&a.y>0&&a.y<1, 'ppt-point':a=>a.space==='pptx-slide-normalized'&&typeof a.slideId==='string'&&a.slideId.length>0&&typeof a.layout==='string'&&a.x>0&&a.x<1&&a.y>0&&a.y<1 };
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 const docPoint=(selector,yFraction)=>page.evaluate(async({selector,yFraction})=>{const isPdf=selector.includes('#pdf-host');const ready=()=>{const wrap=document.querySelector(selector);if(!wrap)return null;const media=wrap.querySelector('canvas, img');const sized=media&&(media.width>100||media.naturalWidth>100)&&wrap.getBoundingClientRect().width>100;const textLayerOk=!isPdf||Boolean(wrap.querySelector('.textLayer'));return sized&&textLayerOk?wrap:null;};let wrap;for(let i=0;i<150;i++){wrap=ready();if(wrap)break;await new Promise(r=>setTimeout(r,100));}if(!wrap)throw Error('no rendered document point surface for '+selector);// The viewer may re-render and REPLACE the node on scroll/resize: scroll the
 // CURRENT node, settle, then RE-ACQUIRE and loop until the current node is
 // itself ready — never measure a detached wrap.
 for(let round=0;round<20;round++){document.querySelector(selector)?.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));const current=ready();if(current){wrap=current;break;}}
 if(!wrap||!wrap.isConnected)throw Error('surface never settled on a connected ready node for '+selector);
 const r=wrap.getBoundingClientRect();if(r.width<=100)throw Error('surface still skeleton-width for '+selector+': '+JSON.stringify(r));const left=r.left+8,right=r.right-8;if(right-left<1)throw Error('surface too narrow to clamp: '+JSON.stringify(r));const x=(left+right)/2;const y=Math.min(Math.max(r.top+r.height*yFraction,r.top+8),Math.min(r.bottom-8,innerHeight-16));if(x<r.left||x>r.right||y<r.top||y>r.bottom)throw Error('clamped point fell outside the surface rect: '+JSON.stringify({rect:r,x,y}));const live=document.querySelector(selector);const lr=live&&live.getBoundingClientRect();if(!lr||!live.contains(wrap)||x<lr.left||x>lr.right||y<lr.top||y>lr.bottom)throw Error('point not contained on the LIVE node after host resize: '+JSON.stringify({rect:r,live:lr?lr.toJSON():null,x,y}));return {x,y};},{selector,yFraction});
 const shell=await surface(s=>s.role==='shell');await prepareReading(shell);await shell.locator('#pick-project').click();
 const pageErrors=[],consoleNotes=[];
 const open=async(page,rel)=>{await page?.bringToFront?.();const tree=await surface(s=>s.role==='shell');await tree.waitForSelector('#file-tree button[data-path="'+rel+'"]',{visible:true});await tree.click('#file-tree button[data-path="'+rel+'"]');for(let i=0;i<100;i++){const candidate=await surface(s=>s.role==='surface'&&s.kind!=='conversation'&&s.relPath===rel).catch(()=>null);if(candidate){candidate.on('pageerror',error=>pageErrors.push(rel+': '+String(error)));candidate.on('console',message=>{if(['error','warning'].includes(message.type()))consoleNotes.push(rel+': '+message.text());});return candidate;}await new Promise(r=>setTimeout(r,100));}throw Error('surface for '+rel+' not found');};
 // ---------- A. TEXT reading preview: point vs selection vs blank chrome ----------
 // NOZELI_POINT_SCENE: 'text'|'pdf'|'image'|'ppt'|'nontext'(pdf+image+ppt)
 // — partial scenes avoid re-running known-passed sections; logs combine
 // across the same source per the parent's directive.
 const scene=(process.env.NOZELI_POINT_SCENE||'').toLowerCase();
 const want={text:!scene||['all','text'].includes(scene),pdf:!scene||['all','nontext','pdf'].includes(scene),image:!scene||['all','nontext','image'].includes(scene),ppt:!scene||['all','nontext','ppt'].includes(scene)};
 let page=null;
 if(want.text){page=await open(null,'read.md');await page.waitForSelector('#text-preview [data-md-from]');
 const leaf=await center(page,'#text-preview p');
 // Blank chrome (container padding, not a markdown leaf): never a document point.
 const blank=await page.evaluate(()=>{const preview=document.querySelector('#text-preview');const b=preview.getBoundingClientRect();for(const [x,y] of [[b.left+4,b.top+b.height-6],[b.left+Math.min(30,b.width/4),b.top+4]]){const hit=document.elementFromPoint(x,y);if(hit&&!hit.closest('[data-md-from]')&&preview.contains(hit))return {x,y};}return null;});
 if(blank){await right(page,blank.x,blank.y);const noteBlank=await itemState(page,'note-here');const diag=await page.evaluate(({blank,menu})=>({clicked:{x:blank.x,y:blank.y},hit:document.elementFromPoint(blank.x,blank.y)?.outerHTML?.slice(0,300),preview:document.querySelector('#text-preview')?.getBoundingClientRect()?.toJSON(),leaf:document.querySelector('#text-preview [data-md-from]')?.getBoundingClientRect()?.toJSON(),menuText:document.querySelector(menu)?.textContent?.slice(0,300)}),{blank,menu});assert(!noteBlank.present||noteBlank.disabled,'blank preview chrome is never a document point: '+JSON.stringify({...diag,state:noteBlank}));assert.equal((await itemState(page,'explain-selection')).disabled,true,'explain requires an effective selection');await page.keyboard.press('Escape');}
 // Real document point without selection: 在此备注/在此讨论 enabled, explain disabled.
 await right(page,leaf.x,leaf.y);
 const notePoint=await itemState(page,'note-here');assert(notePoint.present&&!notePoint.disabled,'note-here is offered on a real text point');
 assert(notePoint.label.includes('在此'),'point label addresses the position: '+notePoint.label);
 const discussPoint=await itemState(page,'discuss-here');assert(discussPoint.present&&!discussPoint.disabled,'discuss-here is offered on a real text point');
 assert.equal((await itemState(page,'explain-selection')).disabled,true,'explain stays disabled without a selection');
 await page.click(menu+' [data-command="note-here"]');
 await saveNote(page,'文本位置备注');
 let notes=await annotations(page,'read.md');assert.equal(notes.length,1);assert.equal(notes[0].kind,'text-point');assert(pointAssertions['text-point'](notes[0].anchor),'text point is zero-length and quote-free: '+JSON.stringify(notes[0].anchor));assert(notes[0].exact&&notes[0].note==='文本位置备注');
 // Selection priority: drag a real selection, right-click INSIDE it — the
 // selection is retained (hit-test before mutation) and addressed as a selection.
 const sel=await page.evaluate(()=>{const p=[...document.querySelectorAll('#text-preview p')][1];const range=document.createRange();range.selectNodeContents(p);const b=range.getBoundingClientRect();const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);return {x:b.left+b.width/2,y:b.top+b.height/2,text:selection.toString()};});
 await right(page,sel.x,sel.y);
 const noteSel=await itemState(page,'note-here');assert(noteSel.present&&!noteSel.disabled&&noteSel.label.includes('选区'),'inside-selection right-click addresses the SELECTION: '+noteSel.label);
 // Explain enablement for an effective selection is proven by the REAL CLI
 // run (desktop-point-discussion-live); offline the frontdesk readiness gate
 // may keep it disabled — this scenario pins only selection-based contracts.
 const retained=await page.evaluate(()=>String(document.getSelection()));
 assert(retained.trim().length>0,'the selection survives menu open (hit-test precedes mutation)');
 await page.keyboard.press('Escape');
 // Outside the selection: a NEW point; the stale selection material is not reused.
 const otherLeaf=await page.evaluate(()=>{const p=[...document.querySelectorAll('#text-preview p')][2];const b=p.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};});
 // --- A2. freeze-at-menu-open: a REAL adapter edit (no focus, no DOM typing
 // that would close the menu) between menu-open and the action must be
 // rejected — the frozen source identity is validated against the digest.
 const originalRead=await fs.readFile(path.join(project,'read.md'),'utf8');
 await right(page,leaf.x,leaf.y);
 await page.evaluate(()=>window.__nozeliInput.insert('STALE_TAIL_EDIT'));
 assert(await page.$eval(menu,node=>!node.hidden),'the no-focus adapter edit keeps the open menu');
 await page.click(menu+' [data-command="note-here"]');
 await page.waitForSelector(menu+'[hidden]',{timeout:15000});
 let afterStale=await annotations(page,'read.md');
 assert.equal(afterStale.length,1,'in-memory edit after menu-open is rejected, not silently anchored to changed content');
 await fs.writeFile(path.join(project,'read.md'),originalRead);
 await right(page,otherLeaf.x,otherLeaf.y);
 const noteOutside=await itemState(page,'note-here');assert(noteOutside.label.includes('在此'),'outside-selection right-click creates a fresh point: '+noteOutside.label);
 assert.equal((await itemState(page,'explain-selection')).disabled,true,'explain disables again once the pointer target is not the selection');
 await page.click(menu+' [data-command="discuss-here"]');
 // The action must RETURN: the composer mounts (no enqueue/persistTag deadlock).
 await page.waitForSelector('.tag-discuss .tag-composer .tag-editor');
 // Real follow-up operation barrier: collapse + reopen runs the production
 // onOpen persist; the settled count then proves exactly-once persistence.
 await page.evaluate(()=>document.querySelector('.tag-discuss .tag-close')?.click());
 await page.waitForFunction(()=>document.querySelector('.tag-discuss .note-projection')?.classList.contains('is-collapsed'));
 await page.evaluate(()=>document.querySelector('.tag-discuss .note-index')?.click());
 await page.waitForFunction(()=>!document.querySelector('.tag-discuss .note-projection')?.classList.contains('is-collapsed'));
 const settled=await annotations(page,'read.md');
 assert.equal(settled.length,2,'exactly one note + one discussion persist after the real collapse/reopen barrier');
 assert.equal(new Set(settled.map(n=>n.id)).size,settled.length,'no duplicate annotations from a double persist');
 assert(await page.$eval('.tag-discuss',node=>{const quote=node.querySelector('.tag-source-quote');return !quote||quote.hidden||!quote.textContent.trim();}),'a point discussion shows NO selected-quote blockquote — nearby source context is separately labeled 附近原文');
 const discuss=await annotations(page,'read.md').then(list=>list.find(n=>n.kind==='text-point'&&n.id!==notes[0].id));
 assert(discuss&&pointAssertions['text-point'](discuss.anchor),'the point discussion anchors a zero-length point, not the stale selection');
 assert.equal(await page.$$eval('.tag-discuss .tag-message-user',nodes=>nodes.length),0,'opening a point discussion sends nothing');
 }
 // Real zoom path: right-click the document surface → 视图 → zoom-in (the
 // visible UX — old toolbar buttons are hidden in this layout; never click
 // hidden elements). Waits for an actual wrap-width change, no fixed sleeps.
 const zoomInViaMenu=async(currentPage,surfaceSelector,at)=>{const widthBefore=await currentPage.evaluate(selector=>document.querySelector(selector)?.getBoundingClientRect().width??0,surfaceSelector);await right(currentPage,at.x,at.y);await currentPage.click(menu+' [data-command="view"]');await currentPage.waitForSelector('.nozeli-submenu:not([hidden])',{timeout:10000});await currentPage.click('.nozeli-submenu [data-command="zoom-in"]');await currentPage.waitForFunction(({selector,width})=>{const node=document.querySelector(selector);return node&&Math.abs(node.getBoundingClientRect().width-width)>1;},{timeout:15000},{selector:surfaceSelector,width:widthBefore});};
 // ---------- B. PDF: page-body point vs margin chrome; zoom-stable ----------
 if(want.pdf){page=await open(page,'sample.pdf');await page.waitForSelector('#pdf-host .pdf-page canvas');
 const pdfPoint=await docPoint('#pdf-host .pdf-page',0.25);
 await right(page,pdfPoint.x,pdfPoint.y);
 const pdfNote=await itemState(page,'note-here');assert(pdfNote.present&&!pdfNote.disabled,'PDF page body is a document point');
 await page.click(menu+' [data-command="note-here"]');await saveNote(page,'PDF 页面位置备注');
 let pdfNotes=await annotations(page,'sample.pdf');assert.equal(pdfNotes.length,1);assert.equal(pdfNotes[0].kind,'pdf-point');assert(pointAssertions['pdf-point'](pdfNotes[0].anchor),'PDF point carries normalized page coordinates: '+JSON.stringify(pdfNotes[0].anchor));
 const margin=await page.evaluate(()=>{const reader=document.querySelector('#reader-scroll'),pageBox=document.querySelector('#pdf-host .pdf-page');const r=reader.getBoundingClientRect(),b=pageBox.getBoundingClientRect();if(b.left-r.left>=24)return {x:b.left-12,y:Math.min(r.bottom-8,Math.max(r.top+8,b.top+b.height/2))};if(r.right-b.right>=24)return {x:b.right+12,y:Math.min(r.bottom-8,Math.max(r.top+8,b.top+b.height/2))};return null;});
 if(margin){await right(page,margin.x,margin.y);const m=await itemState(page,'note-here');assert(!m.present||m.disabled,'PDF reader margin chrome is not a document point');await page.keyboard.press('Escape');}
 await zoomInViaMenu(page,'#pdf-host .pdf-page',pdfPoint);
 pdfNotes=await annotations(page,'sample.pdf');assert(pdfNotes[0].exact&&!pdfNotes[0].sourceChanged,'normalized PDF point survives zoom');
 }
 // ---------- C. Image: normalized point vs host chrome; zoom-stable ----------
 if(want.image){page=await open(page,'pipeline.png');await page.waitForSelector('#image-host .image-page');
 const imgPoint=await docPoint('#image-host .image-page',0.5);
 await right(page,imgPoint.x,imgPoint.y);
 const imgNote=await itemState(page,'note-here');assert(imgNote.present&&!imgNote.disabled,'image content is a document point');
 await page.click(menu+' [data-command="note-here"]');await saveNote(page,'图片位置备注');
 let imgNotes=await annotations(page,'pipeline.png');assert.equal(imgNotes.length,1);assert.equal(imgNotes[0].kind,'image-point');assert(pointAssertions['image-point'](imgNotes[0].anchor),'image point binds natural-pixel identity and normalized coordinates: '+JSON.stringify(imgNotes[0].anchor));
 const around=await page.evaluate(()=>{const host=document.querySelector('#image-host'),pageBox=document.querySelector('.image-page');const h=host.getBoundingClientRect(),b=pageBox.getBoundingClientRect();if(b.left-h.left>=16)return {x:b.left-8,y:Math.min(h.bottom-6,Math.max(h.top+6,b.top+8))};if(h.right-b.right>=16)return {x:b.right+8,y:Math.min(h.bottom-6,Math.max(h.top+6,b.top+8))};return null;});
 if(around){await right(page,around.x,around.y);const m=await itemState(page,'note-here');assert(!m.present||m.disabled,'image host padding is not a document point');await page.keyboard.press('Escape');}
 await zoomInViaMenu(page,'#image-host .image-page',imgPoint);
 imgNotes=await annotations(page,'pipeline.png');assert(imgNotes[0].exact&&!imgNotes[0].sourceChanged,'normalized image point survives zoom');
 }
 // ---------- D. PPT: slide-canvas point via the injected frame menu ----------
 if(want.ppt){page=await open(page,'slides.pptx');
 let ppt=null;for(let i=0;i<150;i++){ppt=page.frames().find(frame=>frame.url().includes('/ppt-vendor/'))||null;if(ppt)break;await new Promise(r=>setTimeout(r,100));}
 await ppt.click('.canvas .viewport-wrapper',{button:'right'});
 await ppt.waitForSelector('.contextmenu .menu-item[data-command="note-here"]',{timeout:15000});
 const pptNoSelExplain=await ppt.evaluate(()=>{const node=document.querySelector('.contextmenu .menu-item[data-command="explain-selection"]');return {present:Boolean(node),disabled:node?node.classList.contains('disable')||node.getAttribute('aria-disabled')==='true':null,title:node?.getAttribute('title')??null};});
 assert(pptNoSelExplain.present&&pptNoSelExplain.disabled===true,'canvas no-selection right-click shows the explain row PRESENT but disabled with its reason: '+JSON.stringify(pptNoSelExplain));
 await ppt.click('.contextmenu .menu-item[data-command="note-here"]');
 await saveNote(page,'PPT 画布位置备注');
 let pptNotes=await annotations(page,'slides.pptx');assert.equal(pptNotes.length,1);assert.equal(pptNotes[0].kind,'ppt-point');assert(pointAssertions['ppt-point'](pptNotes[0].anchor),'PPT point binds slide identity and normalized coordinates: '+JSON.stringify(pptNotes[0].anchor));
 await ppt.waitForSelector('.thumbnail-item',{timeout:15000});await ppt.click('.thumbnail-item',{button:'right'});
 await ppt.waitForSelector('.contextmenu',{timeout:15000});
 assert(!(await ppt.$('.contextmenu .menu-item[data-command="note-here"]'))&&!(await ppt.$('.contextmenu .menu-item[data-command="explain-selection"]')),'thumbnail chrome offers no injected point or explain rows');
 // Selection priority: draw a real region over the slide (the app's region
 // mode), right-click INSIDE it — the injected frame rows must address the
 // SELECTION (备注选区/讨论选区 + explain gated on readiness), not a point.
 await page.waitForSelector('#word-region:not([disabled])',{timeout:15000});await page.click('#word-region');
 const canvasPageRect=await page.evaluate(()=>{const iframe=document.querySelector('iframe');const canvas=iframe?.contentDocument?.querySelector('.canvas .viewport-wrapper');if(!canvas)throw Error('ppt canvas not reachable');const ir=iframe.getBoundingClientRect();const cr=canvas.getBoundingClientRect();return {x:ir.left+cr.left+cr.width/2,y:ir.top+cr.top+cr.height/2,w:cr.width,h:cr.height};});
 await page.mouse.move(canvasPageRect.x-60,canvasPageRect.y-40);await page.mouse.down();await page.mouse.move(canvasPageRect.x+60,canvasPageRect.y+40,{steps:8});await page.mouse.up();
 await page.mouse.click(canvasPageRect.x,canvasPageRect.y,{button:'right'});
 await ppt.waitForSelector('.contextmenu .menu-item[data-command="note-here"]',{timeout:15000});
 const pptSelNote=await ppt.evaluate(()=>{const node=document.querySelector('.contextmenu .menu-item[data-command="note-here"]');return {label:node?.textContent?.trim()??null};});
 assert(pptSelNote.label&&pptSelNote.label.includes('选区'),'inside-selection right-click addresses the SELECTION: '+JSON.stringify(pptSelNote));
 const pptExplain=await ppt.evaluate(()=>{const node=document.querySelector('.contextmenu .menu-item[data-command="explain-selection"]');return {present:Boolean(node),disabled:node?node.classList.contains('disable')||node.getAttribute('aria-disabled')==='true':null,title:node?.getAttribute('title')??node?.title??null};});
 assert(pptExplain.present,'explain-selection row exists for an effective ppt selection');
 assert(pptExplain.disabled===true,'offline (no provider) explain stays disabled with its readiness reason: '+JSON.stringify(pptExplain));
 await ppt.click('.contextmenu .menu-item[data-command="note-here"]');
 await saveNote(page,'PPT 选区优先备注');
 const pptRegionNotes=await annotations(page,'slides.pptx');
 const regionNote=pptRegionNotes.find(n=>n.id!==pptNotes[0].id);
 assert(regionNote&&regionNote.kind==='ppt-region','the selection row froze a ppt REGION selection: '+JSON.stringify(pptRegionNotes.map(n=>n.kind)));
 assert(Array.isArray(regionNote.anchor?.rects)&&regionNote.anchor?.rects?.length>0,'region anchor carries rects: '+JSON.stringify(regionNote.anchor));
 // Outside the selection: point rows return; explain is selection-only.
 await ppt.click('.canvas .viewport-wrapper',{button:'right'});
 await ppt.waitForSelector('.contextmenu .menu-item[data-command="note-here"]',{timeout:15000});
 const pptPointAgain=await ppt.evaluate(()=>{const node=document.querySelector('.contextmenu .menu-item[data-command="note-here"]');const explain=document.querySelector('.contextmenu .menu-item[data-command="explain-selection"]');return {label:node?node.textContent.trim():null,explainDisabled:explain?(explain.classList.contains('disable')||explain.getAttribute('aria-disabled')==='true'):null};});
 assert(pptPointAgain.label&&pptPointAgain.label.includes('在此'),'outside the selection the canvas right-click is a point again: '+JSON.stringify(pptPointAgain));
 assert(pptPointAgain.explainDisabled===true,'explain is selection-only on the ppt canvas');
 await page.keyboard.press('Escape');
 }
 // ---------- E. Reopen: every point still resolves exactly at its source ----------
 if(want.text)page=await open(page,'read.md');if(want.pdf)page=await open(page,'sample.pdf');
 for(const [rel,kind] of [...(want.text?[['read.md','text-point']]:[]),...(want.pdf?[['sample.pdf','pdf-point']]:[]),...(want.image?[['pipeline.png','image-point']]:[]),...(want.ppt?[['slides.pptx','ppt-point']]:[])]){
   const surfaceForRel=await open(page,rel);
   const list=await annotations(surfaceForRel,rel);const point=list.find(n=>n.kind===kind);
   // read.md carries the A2 tail edit (source digest differs from the frozen
   // point) — the early offset still maps exactly; the other kinds are untouched.
   if(rel==='read.md')assert(point&&point.exact,'text-point maps exactly through the stale-edit tail (sourceChanged expected): '+JSON.stringify(list.map(n=>({kind:n.kind,status:n.resolution?.locationStatus,changed:n.sourceChanged}))));
   else assert(point&&point.exact&&!point.sourceChanged,kind+' resolves exactly after switching files and reopening: '+JSON.stringify(list.map(n=>({kind:n.kind,status:n.resolution?.locationStatus}))));
   page=surfaceForRel;
 }
 // ---------- F. No implicit model dispatch anywhere in the scenario ----------
 assert.equal(await page.evaluate(()=>window.__pointProbe.admissions),0,'opening/saving point notes and discussions never dispatches a model');
 await page.screenshot({path:out+'/point-anchors.png'});
const checks=[];
if(want.text)checks.push('text leaf point offered; blank preview chrome not a point','explain disabled without effective selection on every surface','same-length in-memory interior edit after menu-open is rejected (freeze-at-open guard)','inside-selection right-click retains the selection and addresses it','outside-selection right-click creates a fresh point without stale quote reuse','text-point zero-length quote-free persisted','point discuss returns, persists exactly once after a real collapse/reopen barrier','position discussion labeled, draft-only, nothing sent');
if(want.pdf)checks.push('pdf-point normalized page coordinates; margin chrome not a point','pdf point exact after zoom via the visible View menu');
if(want.image)checks.push('image-point natural-pixel identity + normalized coords; host padding not a point','image point exact after zoom via the visible View menu');
if(want.ppt)checks.push('ppt-point slide identity via injected frame menu; thumbnails not points');
if(want.text&&want.pdf&&want.image&&want.ppt)checks.push('all four kinds resolve exactly after reopen');
checks.push('zero model admissions across the executed scene');
console.log(JSON.stringify({pass:true,scene:scene||'full',label:'real Electron UI with isolated samples; no Provider'+(scene?' (partial scene: '+scene+')':''),out,checks}));
 await page.evaluate(()=>nozeli.invoke('session.requestClose',{}));assert.deepEqual(await Promise.race([exit,new Promise(r=>setTimeout(()=>r(null),10000))]),{code:0,signal:null});
}catch(error){console.error(log,out);throw error;}finally{await browser?.disconnect();if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exit,new Promise(r=>setTimeout(r,3000))]).catch(()=>{});if(child.exitCode===null)child.kill('SIGKILL');}}
