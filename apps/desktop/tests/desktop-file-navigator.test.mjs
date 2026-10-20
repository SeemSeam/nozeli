import {prepareReading,waitForDesktopPage} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,cp,symlink} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

// Isolated real renderer + host. No model calls or source-text assertions.
const source=path.resolve(import.meta.dirname,'..');
const output=await mkdtemp(path.join(source,'.test-output/file-navigator-'));
const root=path.join(output,'app');await mkdir(root);
for(const item of ['src','tools','package.json'])await cp(path.join(source,item),path.join(root,item),{recursive:true});
for(const item of ['node_modules','vendor','assets'])await symlink(path.join(source,item),path.join(root,item),'dir');
const build=spawn(process.execPath,[path.join(root,'tools/build-renderer.mjs')],{cwd:root,stdio:'inherit'});
assert.equal(await new Promise(r=>build.once('exit',r)),0);
const project=path.join(output,'project');await mkdir(path.join(project,'deep'),{recursive:true});await mkdir(path.join(project,'target'));
await writeFile(path.join(project,'deep','nested.txt'),'nested');
for(let i=0;i<115;i++)await writeFile(path.join(project,`file-${String(i).padStart(3,'0')}.txt`),'original '+i);
await mkdir(path.join(project,'bulk'));
for(let i=0;i<2105;i++)await writeFile(path.join(project,'bulk',`entry-${String(i).padStart(4,'0')}.txt`),'bulk '+i);
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const electron=createRequire(import.meta.url)('electron'),ozone=process.env.NOZELI_OZONE||'wayland';
const child=spawn(electron,['--ozone-platform='+ozone,path.join(root,'src/main/main.cjs')],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:path.join(output,'profile'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1',NOZELI_OZONE:ozone},stdio:['ignore','pipe','pipe']});
let browser,log='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});break;}catch{}await new Promise(r=>setTimeout(r,100));}assert(browser,log);
 const page=await waitForDesktopPage(browser);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.__nozeliReady);await prepareReading(page);await page.click('#pick-project');
 const scrollTree=async bottom=>{await page.$eval('#file-tree',(tree,bottom)=>{tree.scrollTop=bottom?tree.scrollHeight:0;tree.dispatchEvent(new Event('scroll'));},bottom);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
 const revealTree=async selector=>{await scrollTree(false);for(let i=0;i<300;i++){if(await page.$(selector))return;const moved=await page.$eval('#file-tree',tree=>{const before=tree.scrollTop;tree.scrollTop+=Math.max(32,tree.clientHeight-32);tree.dispatchEvent(new Event('scroll'));return tree.scrollTop!==before;});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));if(!moved)break;}const evidence=await page.$eval('#file-tree',tree=>({scrollTop:tree.scrollTop,scrollHeight:tree.scrollHeight,height:tree.clientHeight,rows:[...tree.querySelectorAll('button')].map(n=>({path:n.dataset.path,parent:n.dataset.parent,index:n.dataset.index,disabled:n.disabled}))}));assert(await page.$(selector),`virtual row not found: ${selector}; ${JSON.stringify(evidence)}`);};
 await page.waitForSelector('#file-tree [data-path="deep"]');
 assert.equal(await page.$('#file-tree [data-path="deep/nested.txt"]'),null,'collapsed child has no DOM row');
 await page.click('#file-tree [data-path="deep"]');await page.waitForSelector('#file-tree [data-path="deep/nested.txt"]');
 await page.click('#file-tree [data-path="deep"]');assert.equal(await page.$('#file-tree [data-path="deep/nested.txt"]'),null);
 await scrollTree(true);await page.click('#file-tree .tree-load-more[data-parent=""]');await scrollTree(true);await page.waitForSelector('#file-tree [data-path="file-114.txt"]');await scrollTree(false);
 const a='#file-tree [data-path="file-000.txt"]',b='#file-tree [data-path="file-001.txt"]';
 await page.click(a);await page.keyboard.down('Control');await page.click(b);await page.keyboard.up('Control');
 assert.equal(await page.$$eval('#file-tree [aria-selected="true"]',ns=>ns.length),2);
 await page.click(b,{button:'right'});await page.click('#file-tree-menu [data-command="hide"]');await page.waitForSelector('#file-tree-dialog[open]');await page.click('#file-tree-dialog button[type="submit"]');await page.waitForFunction(()=>!document.querySelector('#file-tree [data-path="file-000.txt"]'));
 await page.keyboard.down('Control');await page.keyboard.press('p');await page.keyboard.up('Control');await page.waitForSelector('#quick-open[open]');await page.type('#quick-open-input','nested');await page.waitForSelector('#quick-open-results [data-path="deep/nested.txt"][data-open-target="current"]');
 await page.focus('#quick-open-input');await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.path),'deep/nested.txt');await page.keyboard.press('Escape');
 await page.keyboard.down('Control');await page.keyboard.press('p');await page.keyboard.up('Control');await page.focus('#quick-open-input');await page.keyboard.down('Control');await page.keyboard.press('a');await page.keyboard.up('Control');await page.type('#quick-open-input','file');await page.waitForFunction(()=>document.querySelector('#quick-open-status').textContent.includes('搜索不完整'));
 assert.equal(await page.$eval('#quick-open-input',n=>n.value),'file','reopening must not reselect and overwrite characters during typing');
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#quick-open').open);
 await scrollTree(true);if(await page.$('#file-tree .tree-load-more[data-parent=""]')){await page.click('#file-tree .tree-load-more[data-parent=""]');await page.waitForFunction(()=>!document.querySelector('#file-tree .tree-load-more[data-parent=""]'));}
 await scrollTree(false);await page.click('#file-tree [data-path="bulk"]');await page.waitForSelector('#file-tree [data-path="bulk/entry-0000.txt"]');
 for(let count=100;count<2105;count+=100){await revealTree('#file-tree .tree-load-more[data-parent="bulk"]');const previous=await page.$eval('#file-tree',tree=>tree.scrollHeight);await page.click('#file-tree .tree-load-more[data-parent="bulk"]');await page.waitForFunction(previous=>document.querySelector('#file-tree').scrollHeight>previous,{},previous);assert((await page.$$('#file-tree button')).length<=100,'loaded pages stay virtual');}
 await scrollTree(false);await page.click('#file-tree [data-path="bulk/entry-0000.txt"]');await page.keyboard.down('Shift');await page.keyboard.press('End');await page.keyboard.up('Shift');
 assert.equal(await page.$eval('#file-tree [data-path="file-114.txt"]',n=>n.getAttribute('aria-selected')),'true','range selection traverses unmounted rows');
 await scrollTree(false);assert.equal(await page.$eval('#file-tree [data-path="bulk/entry-0000.txt"]',n=>n.getAttribute('aria-selected')),'true');
 await revealTree('#file-tree [data-path="deep"]');await page.click('#file-tree [data-path="deep"]');await page.waitForSelector('#file-tree [data-path="deep/nested.txt"]');
 await writeFile(path.join(project,'deep','external.txt'),'external');await page.waitForSelector('#file-tree [data-path="deep/external.txt"]');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.path),'deep','directory invalidation preserves focused row');assert.equal(await page.$eval('#file-tree [data-path="deep"]',node=>node.getAttribute('aria-selected')),'true','directory invalidation preserves selection');
 await revealTree('#file-tree [data-path="bulk/entry-2104.txt"]');assert.equal(await page.$('#file-tree .tree-load-more[data-parent="bulk"]'),null,'nested watch refresh preserves unrelated loaded pages');
 await page.reload();await page.waitForFunction(()=>window.__nozeliReady);await prepareReading(page);await page.waitForSelector('#file-tree [data-path="bulk/entry-0000.txt"]');
 await revealTree('#file-tree [data-path="deep/external.txt"]');
 await page.keyboard.down('Control');await page.keyboard.press('p');await page.keyboard.up('Control');await page.waitForSelector('#quick-open[open]');await page.type('#quick-open-input','entry-2104');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>[...document.querySelectorAll('#workspace-open-editors [data-editor-view]')].some(n=>n.textContent.includes('bulk/entry-2104.txt')));const editor=await page.evaluate(()=>[...document.querySelectorAll('#workspace-open-editors [data-editor-view]')].find(n=>n.textContent.includes('bulk/entry-2104.txt')).dataset.editorView);await page.click(`#workspace-open-editors [data-editor-view="${editor}"]`,{button:'right'});await page.click('#navigator-editor-menu [data-command="locate"]');
 await page.waitForFunction(()=>document.activeElement.dataset.path==='bulk/entry-2104.txt');assert((await page.$$('#file-tree button')).length<=100,'locator pages through without mounting all rows');
 const pathToMirror='bulk/entry-2104.txt';
 const snapshot=()=>page.evaluate(()=>window.__workspaceGroups.snapshot());
 const beforeMirror=await snapshot(),ownerView=Object.values(beforeMirror.views).find(v=>v.relPath===pathToMirror&&!v.readOnly);
 assert(ownerView,'Quick Open creates one original writer');
 for(const destination of ['right','bottom','group','window']){
   console.log('navigator destination:',destination);
   if(!await page.$('#file-tree [data-path="bulk/entry-2104.txt"]'))await revealTree('#file-tree [data-path="bulk/entry-2104.txt"]');const mountedRow=await page.$('#file-tree [data-path="bulk/entry-2104.txt"]');await mountedRow.focus();await page.keyboard.press('ContextMenu');
   const command=destination==='group'?await page.$eval('#file-tree-menu [data-command^="group:"]',node=>node.dataset.command):destination;
   const before=await snapshot();console.log('navigator destination snapshot ready');await page.click(`#file-tree-menu [data-command="${command}"]`);
   console.log('navigator destination dispatched:',command);
   await page.waitForFunction(count=>Object.values(window.__workspaceGroups.snapshot().views).filter(v=>v.relPath==='bulk/entry-2104.txt').length===count+1,{},Object.values(before.views).filter(v=>v.relPath===pathToMirror).length);
   const after=await snapshot(),mirror=Object.values(after.views).find(v=>!before.views[v.id]&&v.relPath===pathToMirror);
   assert.equal(mirror.readOnly,true,`${destination} creates a reading mirror`);assert.equal(mirror.sourceViewId,ownerView.id);assert.equal(Object.values(after.views).filter(v=>v.relPath===pathToMirror&&!v.readOnly).length,1,'destinations do not create another writer');
   if(destination==='group')assert.equal(command.slice(6),[after.mainRoot,...after.detached.map(w=>w.root)].flatMap(function walk(node){return node.kind==='group'?[node]:[...walk(node.first),...walk(node.second)];}).find(g=>g.views.includes(mirror.id)).id);
   if(destination==='window')await page.waitForFunction(viewId=>window.__workspaceGroups.snapshot().detached.some(win=>{const contains=node=>node.kind==='group'?node.views.includes(viewId):contains(node.first)||contains(node.second);return contains(win.root);}),{},mirror.id);
 }
 assert.deepEqual(errors,[]);
}catch(error){console.error('Navigator evidence',output,log);const pages=await browser.pages();for(const p of pages.filter(p=>p.url().startsWith('http://127.0.0.1:')))console.error(await p.evaluate(()=>({scope:window.__workspaceScope,input:document.querySelector('#quick-open-input')?.value,status:document.querySelector('#quick-open-status')?.textContent,toast:document.querySelector('#toast')?.textContent,treeHeight:document.querySelector('#file-tree')?.scrollHeight,lastRows:[...document.querySelectorAll('#file-tree button')].map(n=>[n.dataset.path,n.dataset.parent,n.dataset.index,n.disabled]),open:document.querySelector('#quick-open')?.open,rows:document.querySelectorAll('#quick-open-results [data-open-target=current]').length})).catch(()=>null));throw error;}finally{await browser?.disconnect();if(child.exitCode===null)child.kill();}
