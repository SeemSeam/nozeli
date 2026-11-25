import {prepareReading,waitForDesktopPage,waitForReadingDocument,waitForReadingProject} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,cp,symlink} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';

// Isolated real renderer + host. No model calls or source-text assertions.
const source=path.resolve(import.meta.dirname,'..');
const fixtureParent=process.platform==='win32'?os.tmpdir():path.join(source,'.test-output');
await mkdir(fixtureParent,{recursive:true});
const output=await mkdtemp(path.join(fixtureParent,'file-navigator-'));
console.log('Navigator fixture',output);
const root=path.join(output,'app');await mkdir(root);
for(const item of ['src','tools','package.json'])await cp(path.join(source,item),path.join(root,item),{recursive:true});
for(const item of ['node_modules','vendor','assets'])await symlink(path.join(source,item),path.join(root,item),process.platform==='win32'?'junction':'dir');
if(process.platform==='win32')await symlink(path.join(source,'native'),path.join(root,'native'),'junction');
const build=spawn(process.execPath,[path.join(root,'tools/build-renderer.mjs')],{cwd:root,stdio:'inherit'});
assert.equal(await new Promise(r=>build.once('exit',r)),0);
const project=path.join(output,'project');await mkdir(path.join(project,'deep'),{recursive:true});await mkdir(path.join(project,'target'));
await writeFile(path.join(project,'deep','nested.txt'),'nested');
const profile=path.join(output,'config','desktop');
await mkdir(path.dirname(profile));
const projectId=process.platform==='win32'?(await new DesktopHost(profile).pick(project)).project.id:null;
if(projectId)console.log('Navigator Windows project registered');
for(let i=0;i<115;i++)await writeFile(path.join(project,`file-${String(i).padStart(3,'0')}.txt`),'original '+i);
await mkdir(path.join(project,'bulk'));
for(let i=0;i<2105;i++)await writeFile(path.join(project,'bulk',`entry-${String(i).padStart(4,'0')}.txt`),'bulk '+i);
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const electron=createRequire(import.meta.url)('electron'),ozone=process.env.NOZELI_OZONE||'wayland';
const child=spawn(electron,['--ozone-platform='+ozone,path.join(root,'src/main/main.cjs')],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:path.join(output,'config'),NOZELI_USER_DATA:path.join(output,'config','desktop'),NOZELI_PI_INTEGRATION_ROOT:path.resolve(source,'../../integrations/pi'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1',NOZELI_OZONE:ozone},stdio:['ignore','pipe','pipe']});
let browser,log='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});break;}catch{}await new Promise(r=>setTimeout(r,100));}assert(browser,log);
 const page=await waitForDesktopPage(browser);const errors=[];page.on('pageerror',e=>errors.push(e.message));await prepareReading(page);
 if(projectId){const recent=`#recent button[data-project-id="${projectId}"]`;await page.waitForSelector(recent,{visible:true});await page.click(recent);await page.waitForSelector(`${recent}[aria-current="true"]`);}
 else{await page.click('#pick-project');await waitForReadingProject(page,project);}
 console.log('Navigator project selected');
 const scrollTree=async bottom=>{await page.$eval('#file-tree',(tree,bottom)=>{tree.scrollTop=bottom?tree.scrollHeight:0;tree.dispatchEvent(new Event('scroll'));},bottom);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
 const loadNext=selector=>page.$eval(selector,node=>{
   if(node.disabled||!node.getClientRects().length)throw Error('Load-more control is unavailable');
   // Locator scrolling can remount the virtual button before the input lands.
   node.click();
 });
 const revealTree=async selector=>{await scrollTree(false);for(let i=0;i<300;i++){if(await page.$(selector))return;const moved=await page.$eval('#file-tree',tree=>{const before=tree.scrollTop;tree.scrollTop+=Math.max(32,tree.clientHeight-32);tree.dispatchEvent(new Event('scroll'));return tree.scrollTop!==before;});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));if(!moved)break;}const evidence=await page.$eval('#file-tree',tree=>({scrollTop:tree.scrollTop,scrollHeight:tree.scrollHeight,height:tree.clientHeight,rows:[...tree.querySelectorAll('button')].map(n=>({path:n.dataset.path,parent:n.dataset.parent,index:n.dataset.index,disabled:n.disabled}))}));assert(await page.$(selector),`virtual row not found: ${selector}; ${JSON.stringify(evidence)}`);};
 await page.waitForSelector('#file-tree [data-path="deep"]');
 assert.equal(await page.$('#file-tree [data-path="deep/nested.txt"]'),null,'collapsed child has no DOM row');
 await page.click('#file-tree [data-path="deep"]');await page.waitForSelector('#file-tree [data-path="deep/nested.txt"]');
 await page.click('#file-tree [data-path="deep"]');assert.equal(await page.$('#file-tree [data-path="deep/nested.txt"]'),null);
 const moreRoot='#file-tree .tree-load-more[data-parent=""]',lastRoot='#file-tree [data-path="file-114.txt"]';
 await scrollTree(true);await loadNext(moreRoot);
 await page.waitForFunction(()=>!document.querySelector('#file-tree .tree-load-more[data-parent=""]'));
 await scrollTree(true);await page.waitForSelector(lastRoot);await scrollTree(false);
 const a='#file-tree [data-path="file-000.txt"]',b='#file-tree [data-path="file-001.txt"]';
 await page.click(a);await page.keyboard.down('Control');await page.click(b);await page.keyboard.up('Control');
 assert.equal(await page.$$eval('#file-tree [aria-selected="true"]',ns=>ns.length),2);
 await page.click(b,{button:'right'});await page.click('#file-tree-menu [data-command="hide"]');await page.waitForSelector('#file-tree-dialog[open]');await page.click('#file-tree-dialog button[type="submit"]');await page.waitForFunction(()=>!document.querySelector('#file-tree [data-path="file-000.txt"]'));
 await page.keyboard.down('Control');await page.keyboard.press('p');await page.keyboard.up('Control');await page.waitForSelector('#quick-open[open]');await page.type('#quick-open-input','nested');await page.waitForSelector('#project-search-results [data-path="deep/nested.txt"][data-open-target="current"]');
 await page.focus('#quick-open-input');await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.path),'deep/nested.txt');
 // Close and reopen in one renderer task, before Chromium delivers the old close event.
 await page.evaluate(()=>{
   const dialog=document.querySelector('#quick-open');
   dialog.addEventListener('close',()=>dialog.dataset.closeObserved='true',{once:true});
   document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
   document.dispatchEvent(new KeyboardEvent('keydown',{key:'p',ctrlKey:true,bubbles:true,cancelable:true}));
 });
 await page.waitForSelector('#quick-open[data-close-observed="true"]');
 assert.equal(await page.$eval('#quick-open',node=>node.open),true,'the new dialog remains open');
 assert(await page.$('#quick-open #project-search'),'a delayed close must not move the reopened results into the sidebar');
 await page.type('#quick-open-input','file');await page.waitForFunction(()=>/^\d+ 个匹配/.test(document.querySelector('#project-search-status').textContent));
 assert.equal(await page.$('#project-search-results [data-path="file-000.txt"]'),null,'hidden files stay outside search');
 assert.equal(await page.$('#project-search-results [data-path="file-001.txt"]'),null,'all selected hidden files stay outside search');
 assert((await page.$$('#project-search-results [data-open-target="current"]')).length>0,'completed filename query returns visible files');
 assert.equal(await page.$eval('#quick-open-input',n=>n.value),'file','reopening must not reselect and overwrite characters during typing');
 await page.focus('#quick-open-input');await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#quick-open').open);
 await scrollTree(true);if(await page.$(moreRoot)){await loadNext(moreRoot);await page.waitForFunction(selector=>!document.querySelector(selector),{},moreRoot);}
 await scrollTree(false);await page.click('#file-tree [data-path="bulk"]');await page.waitForSelector('#file-tree [data-path="bulk/entry-0000.txt"]');
 const moreBulk='#file-tree .tree-load-more[data-parent="bulk"]';
 for(let count=100;count<2105;count+=100){
   await revealTree(moreBulk);
   await loadNext(moreBulk);
   await page.waitForSelector(`#file-tree [data-path="bulk/entry-${String(count).padStart(4,'0')}.txt"]`);
   assert((await page.$$('#file-tree button')).length<=100,'loaded pages stay virtual');
 }
 await scrollTree(false);await page.click('#file-tree [data-path="bulk/entry-0000.txt"]');await page.keyboard.down('Shift');await page.keyboard.press('End');await page.keyboard.up('Shift');
 assert.equal(await page.$eval('#file-tree [data-path="file-114.txt"]',n=>n.getAttribute('aria-selected')),'true','range selection traverses unmounted rows');
 await scrollTree(false);assert.equal(await page.$eval('#file-tree [data-path="bulk/entry-0000.txt"]',n=>n.getAttribute('aria-selected')),'true');
 await revealTree('#file-tree [data-path="deep"]');await page.click('#file-tree [data-path="deep"]');await page.waitForSelector('#file-tree [data-path="deep/nested.txt"]');
 await writeFile(path.join(project,'deep','external.txt'),'external');await page.waitForSelector('#file-tree [data-path="deep/external.txt"]');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.path),'deep','directory invalidation preserves focused row');assert.equal(await page.$eval('#file-tree [data-path="deep"]',node=>node.getAttribute('aria-selected')),'true','directory invalidation preserves selection');
 await revealTree('#file-tree [data-path="bulk/entry-2104.txt"]');assert.equal(await page.$('#file-tree .tree-load-more[data-parent="bulk"]'),null,'nested watch refresh preserves unrelated loaded pages');
 const activeProjectId=await page.$eval('#recent button[aria-current="true"]',node=>node.dataset.projectId);
 await page.reload();await prepareReading(page);
 // The shell does not implicitly reconnect, even if the native scope survived reload.
 const reopen=`#recent button[data-project-id="${activeProjectId}"]`;
 await page.waitForSelector(reopen,{visible:true});await page.click(reopen);
 await page.waitForSelector(`${reopen}[aria-current="true"]`);
 await page.waitForSelector('#file-tree [data-path="bulk/entry-0000.txt"]');
 await revealTree('#file-tree [data-path="deep/external.txt"]');
 await page.keyboard.down('Control');await page.keyboard.press('p');await page.keyboard.up('Control');await page.waitForSelector('#quick-open[open]');await page.type('#quick-open-input','entry-2104');await page.waitForSelector('#project-search-results [data-path="bulk/entry-2104.txt"]');await page.keyboard.press('Enter');
 await page.waitForSelector('#quick-open[open]',{hidden:true});
 const editor='#workspace-open-editors button[data-editor-view][title="bulk/entry-2104.txt"]';
 await page.waitForSelector(editor,{visible:true});await page.click(editor,{button:'right'});
 const locate='#navigator-editor-menu [data-command="locate"]';await page.waitForSelector(locate,{visible:true});await page.click(locate);
 await page.waitForFunction(()=>document.activeElement.dataset.path==='bulk/entry-2104.txt');assert((await page.$$('#file-tree button')).length<=100,'locator pages through without mounting all rows');
 const pathToMirror='bulk/entry-2104.txt';
 const snapshot=()=>page.evaluate(()=>window.__workspaceGroups.snapshot());
 const beforeMirror=await snapshot(),ownerView=Object.values(beforeMirror.views).find(v=>v.relPath===pathToMirror&&!v.readOnly);
 assert(ownerView,'Quick Open creates one original writer');
 const panes=node=>node.kind==='group'?[node]:[...panes(node.first),...panes(node.second)];
 const treeMenu=async(file,command)=>{
   const selector=`#file-tree button[data-path=${JSON.stringify(file)}]`;
   if(!await page.$(selector))await revealTree(selector);
   await page.focus(selector);assert.equal(await page.evaluate(()=>document.activeElement.dataset.path),file);
   await page.keyboard.down('Shift');try{await page.keyboard.press('F10');}finally{await page.keyboard.up('Shift');}
   await page.$eval(`#file-tree-menu:not([hidden]) button[data-command=${JSON.stringify(command)}]`,node=>{
     if(node.disabled||!node.getClientRects().length)throw Error('Placement action is not available');
     node.click();
   });
 };
 const changed=async before=>{await page.waitForFunction(revision=>window.__workspaceGroups.snapshot().revision>revision,{},before.revision);return snapshot();};
 await treeMenu(pathToMirror,'right');
 const split=await changed(beforeMirror),target=panes(split.mainRoot).find(g=>!panes(beforeMirror.mainRoot).some(old=>old.id===g.id));
 const reader=split.views[target.activeViewId];
 assert.equal(reader.readOnly,true);assert.equal(reader.sourceViewId,ownerView.id);
 const targetCommand=`group:${target.id}`,freshFile='deep/nested.txt';
 await treeMenu(freshFile,targetCommand);
 const opened=await changed(split),groupOf=state=>panes(state.mainRoot).find(g=>g.id===target.id);
 const fresh=opened.views[groupOf(opened).activeViewId];
 assert.equal(fresh.relPath,freshFile);assert.equal(Boolean(fresh.readOnly),false);
 assert(groupOf(opened).historyViewIds.includes(reader.id));
 const freshSurface=await waitForReadingDocument(browser,opened.projectId,freshFile);
 await freshSurface.waitForFunction(()=>document.querySelector('#save-status')?.dataset.state==='saved');
 await treeMenu(pathToMirror,targetCommand);
 const restored=await changed(opened);
 assert.equal(groupOf(restored).activeViewId,reader.id,'returns to the same reader from pane history');
 await treeMenu(pathToMirror,targetCommand);
 const repeated=await changed(restored);
 assert.equal(groupOf(repeated).activeViewId,reader.id,'reuses the visible reader');
 assert.deepEqual(Object.keys(repeated.views).sort(),Object.keys(opened.views).sort());
 assert.equal(panes(repeated.mainRoot).find(g=>g.views.includes(ownerView.id)).id,panes(beforeMirror.mainRoot).find(g=>g.views.includes(ownerView.id)).id);
 assert.deepEqual(errors,[]);
}catch(error){console.error('Navigator evidence',output,log);const pages=await browser?.pages()??[];for(const p of pages.filter(p=>p.url().startsWith('http://127.0.0.1:')))console.error(await p.evaluate(()=>({scope:window.__workspaceScope,input:document.querySelector('#quick-open-input')?.value,status:document.querySelector('#project-search-status')?.textContent,toast:document.querySelector('#toast')?.textContent,treeHeight:document.querySelector('#file-tree')?.scrollHeight,lastRows:[...document.querySelectorAll('#file-tree button')].map(n=>[n.dataset.path,n.dataset.parent,n.dataset.index,n.disabled]),open:document.querySelector('#quick-open')?.open,rows:document.querySelectorAll('#project-search-results [data-open-target=current]').length})).catch(()=>null));throw error;}finally{await browser?.disconnect();if(child.exitCode===null)child.kill();}
