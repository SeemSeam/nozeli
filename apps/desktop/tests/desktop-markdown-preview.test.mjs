import { contentToolForPage } from './native-content-tools.fixture.mjs';
import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import {clickPreviewControl, openPreviewMenu} from './preview-menu-support.mjs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { DesktopHost } from '../src/main/host.mjs';
import { FileTags } from '../src/domain/file-tags.mjs';

const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, '.test-output'), { recursive: true });
const output = await mkdtemp(path.join(root, '.test-output/markdown-preview-'));
const profile = path.join(output, 'profile'), project = path.join(output, 'project');
await mkdir(project);
const fence = String.fromCharCode(96).repeat(3);
const markdown = '# Markdown 动态分屏\n\n第一处：重复引文。\n\n第二处：重复引文。\n\n**重要文字**与行内 $E=mc^2$、\\(x+1\\)。\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n\n| 项目 | 状态 |\n| --- | --- |\n| 分屏 | 实时 |\n\n[项目代码](sample.ts:2)\n\n' + fence + 'cpp\n#include <iostream>\nint main() { return 0; }\n' + fence + '\n\n' + Array.from({length:32}, (_,i) => '第 ' + (i+1) + ' 段：独立滚动与动态预览，文本位置通过解析器映射到源文件，不依赖重复引文搜索。').join('\n\n') + '\n';
const sources = {
  'main.md': markdown, 'second.markdown': '# Another Markdown\n\n另一个文件不会接收上个文件的延迟渲染。\n',
  'sample.ts': 'export const first = 1;\nexport function second() { return first; }\n',
  'note.txt': 'Plain text without a Markdown preview.\n',
};
for (const [name, text] of Object.entries(sources)) await writeFile(path.join(project, name), text);
const otherProject = path.join(output, 'other-project'); await mkdir(otherProject);
await writeFile(path.join(otherProject, 'main.md'), '# Other project\n\n同名文件按项目隔离。\n');
const host = new DesktopHost(profile), otherId = (await host.pick(otherProject)).project.id, projectId = (await host.pick(project)).project.id;
const tags = new FileTags(project);
const port = await new Promise(resolve => { const server=net.createServer(); server.listen(0,'127.0.0.1',()=>{const n=server.address().port;server.close(()=>resolve(n));}); });
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, page, child, exited, log = '';
const report = { ok:false, output, project, checks:[], errors:[] };
const mark = value => { report.checks.push(value); console.log('PASS ' + value); };
const call = (op,payload={}) => page.evaluate(({op,payload}) => nozeli.invoke(op,payload),{op,payload});
const text = () => page.evaluate(() => __nozeliInput.text());
const shot = name => page.screenshot({path:path.join(output,name+'.png')});
async function launch() {
  child = spawn(createRequire(import.meta.url)('electron'), [path.join(root,'src/main/main.cjs'),'--ozone-platform=wayland'], {
    cwd:root, env:{...process.env,WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000',NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:output,NOZELI_AGENT_FIXTURE:'1'},
    stdio:['ignore','pipe','pipe'],
  });
  exited = new Promise(resolve => child.once('exit',(code,signal)=>resolve({code,signal})));
  for (const stream of [child.stdout,child.stderr]) stream.on('data',data=>log+=data);
  for(let i=0;i<120;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{}await tick(100);}
  assert(browser,log);page=await waitForDesktopPage(browser);page.on('pageerror',error=>report.errors.push(String(error.stack)));
  await page.waitForFunction(()=>window.__nozeliReady);
  await prepareReading(page);await tick(200);
}
async function close() {
  await call('session.requestClose');
  const result=await Promise.race([exited,tick(15000).then(()=>({code:'timeout'}))]);
  assert.equal(result.code,0);await browser.disconnect();browser=null;
}
async function resize(width,height=900){
  await call('session.resize',{width,height});await page.waitForFunction(n=>innerWidth===n,{},width);await tick(150);
}
async function open(name){
  if(await page.$eval('#app',el=>el.classList.contains('narrow-layout')&&!el.classList.contains('drawer-files-open')))await page.click('#file-toggle');
  await page.click('#file-tree button[data-path="'+name+'"]');
  await page.waitForFunction(name=>document.querySelector('#file-path').textContent===name&&document.querySelector('#save-status').dataset.state==='saved',{},name);
  if(await page.$eval('#app',el=>el.classList.contains('drawer-files-open')))await page.click('#file-toggle');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await tick(150);
}
const split = () => page.waitForFunction(()=>document.querySelector('#reader-scroll').classList.contains('markdown-split')&&!document.querySelector('#text-host').hidden&&!document.querySelector('#text-preview').hidden);
async function endOfSource(){
  await page.evaluate(()=>{const n=__nozeliInput.text().length;__nozeliInput.select(n,n);__nozeliInput.focus();});
  await page.waitForFunction(()=>document.activeElement?.closest('#text-host .cm-content'));
}
async function undo(){
  await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');
}
async function selectRepeat(prefix='第二处'){
  await page.$eval('#markdown-preview-scroll',el=>el.scrollTop=0);await tick(50);
  const point = await page.evaluate(prefix=>{
    const paragraph=[...document.querySelectorAll('#text-preview p')].find(el=>el.textContent.startsWith(prefix));
    const walker=document.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT);let node;
    while(node=walker.nextNode()){const from=node.textContent.indexOf('重复引文');if(from<0)continue;const range=document.createRange();range.setStart(node,from);range.setEnd(node,from+4);const b=range.getBoundingClientRect();return{x:b.left+.3,y:b.top+b.height/2,end:b.right-.3};}
  },prefix);
  assert(point);
  for(let attempt=0;attempt<3;attempt++){
    await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.end,point.y,{steps:10});await page.mouse.up();await tick(100);
    if(await page.evaluate(()=>window.getSelection()?.toString())==='重复引文')break;
    if(attempt===2)assert.equal(await page.evaluate(()=>window.getSelection()?.toString()),'重复引文','Native drag must select the full requested quote before saving a note');
    await tick(150);
  }
  await page.waitForSelector('#selection-menu:not([hidden])');
}
async function waitDisk(check){
  for(let i=0;i<100;i++){const value=await check();if(value)return value;await tick(80);}throw Error('Disk-state timeout');
}
try {
  await launch();await resize(1440);await open('main.md');
  assert(await page.$eval('#text-host',el=>el.hidden));assert(await page.$eval('#markdown-preview-toggle',el=>el.hidden));
  await openPreviewMenu(page,'markdown-preview-toggle');
  assert.equal(await page.$eval('.nozeli-submenu [data-command="preview-toggle"]',el=>el.getAttribute('aria-checked')),'false');
  assert(await page.$eval('.nozeli-submenu [data-command="preview-link"]',el=>el.disabled));await page.keyboard.press('Escape');
  await contentToolForPage(page, ['view', 'text-mode']);await split();
  await page.waitForFunction(()=>document.querySelector('#text-preview pre code')?.dataset.highlighted==='cpp');
  const markup = await page.$eval('#text-preview',el=>({tables:el.querySelectorAll('table').length,math:el.querySelectorAll('.katex').length,errors:el.querySelectorAll('.katex-error').length,colors:new Set([...el.querySelectorAll('pre code span')].map(node=>node.style.color)).size}));
  assert(markup.tables===1&&markup.math===3&&markup.errors===0&&markup.colors>=3);report.markup=markup;
  await shot('01-split');mark('Markdown defaults to reading; editing shows source and live rendered math/table/highlight side by side');
  // This regression also exercises the explicitly available independent mode.
  await clickPreviewControl(page, 'markdown-sync');assert.equal(await page.$eval('#markdown-sync',el=>el.getAttribute('aria-pressed')),'false');

  await endOfSource();await page.keyboard.type('LIVE_BUFFER');
  await page.waitForFunction(()=>document.querySelector('#text-preview').textContent.includes('LIVE_BUFFER'));
  assert.equal(await page.$eval('#save-status',el=>el.dataset.state),'dirty');
  assert.equal(await readFile(path.join(project,'main.md'),'utf8'),markdown);
  await undo();await page.waitForFunction(()=>!document.querySelector('#text-preview').textContent.includes('LIVE_BUFFER'));assert.equal(await text(),markdown);
  await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
  mark('real keyboard changes render before autosave; native undo updates both views without changing the file');

  await endOfSource();const cdp=await page.createCDPSession();
  await cdp.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});await tick(300);
  assert((await text()).endsWith('中文'));assert(!await page.$eval('#text-preview',el=>el.textContent.includes('中文')));
  await cdp.send('Input.insertText',{text:'中文输入'});await cdp.detach();
  await page.waitForFunction(()=>document.querySelector('#text-preview').textContent.includes('中文输入'));
  await undo();await page.waitForFunction(()=>!document.querySelector('#text-preview').textContent.includes('中文输入'));assert.equal(await text(),markdown);
  await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
  mark('native CDP Chinese composition postpones rendering until commitment and preserves undo');

  await page.$eval('#markdown-preview-scroll',el=>el.scrollTop=450);const previewTop=await page.$eval('#markdown-preview-scroll',el=>el.scrollTop);
  await endOfSource();await page.keyboard.type('SCROLL_CHECK');await page.waitForFunction(()=>document.querySelector('#text-preview').textContent.includes('SCROLL_CHECK'));
  assert(Math.abs(await page.$eval('#markdown-preview-scroll',el=>el.scrollTop)-previewTop)<2);
  await undo();await page.waitForFunction(()=>!document.querySelector('#text-preview').textContent.includes('SCROLL_CHECK'));
  await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');
  mark('preview retains its own scroll position while source typing and undo continue independently');

  await page.$eval('#markdown-preview-scroll',el=>el.scrollTop=0);await page.click('#text-preview .conversation-copy');
  assert.equal((await call('document.clipboard',{action:'read'})).value,'#include <iostream>\nint main() { return 0; }');
  await page.evaluate(()=>__nozeliInput.select(__nozeliInput.text().indexOf('重复引文'),__nozeliInput.text().indexOf('重复引文')+4));
  await selectRepeat();const bounds=await page.evaluate(()=>{const a=document.querySelector('#selection-menu').getBoundingClientRect(),b=document.querySelector('#markdown-preview-scroll').getBoundingClientRect();return a.left>=b.left&&a.right<=b.right&&a.top>=b.top&&a.bottom<=b.bottom;});assert(bounds);
  await page.click('#selection-note');await page.type('#note-input','右侧精确备注');await page.click('#add-note');await page.waitForSelector('#note-form',{hidden:true});await page.$eval('#text-host .cm-scroller',node=>{node.scrollTop=0;});await page.waitForSelector('#text-host .tag-note');assert.equal(await page.$('#text-preview .tag-note'),null,'split preview keeps marks, not duplicate interactive cards');
  const note=await waitDisk(async()=>{const file=await tags.read('main.md');return file?.tags.find(item=>item.note==='右侧精确备注');});
  const expected=markdown.indexOf('重复引文',markdown.indexOf('重复引文')+1);
  assert.equal(note.anchor.start,expected);assert.equal(note.anchor.end,expected+4);assert.equal(note.anchor.quote,'重复引文');
  await page.click('#text-host .tag-note .tag-window-title',{count:2});
  await page.waitForFunction(()=>document.querySelector('#text-host .tag-note .note-projection').classList.contains('is-collapsed'));
  await shot('02-preview-note');mark('right-side repeated quote creates the exact source anchor; selection toolbar stays in the preview; code clipboard remains native');

  const point=await page.$eval('#text-preview p',el=>{const b=el.getBoundingClientRect();return{x:b.left+4,y:b.top+b.height/2};});
  await page.mouse.click(point.x,point.y,{button:'right'});await page.waitForSelector('#document-context-menu:not([hidden])');
  assert(!await page.$('#document-context-menu [data-command=cut]'));assert(!await page.$('#document-context-menu [data-command=paste]'));
  await page.keyboard.press('Escape');
  mark('preview right-click stays read-only and does not edit the source through clipboard commands');

  const ring = () => page.$eval('#markdown-preview-scroll',el=>{const b=el.getBoundingClientRect();return{left:b.left,top:b.top};});
  const before=await ring();const handle=await page.$eval('#markdown-divider',el=>{const b=el.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2};});
  await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(handle.x+100,handle.y,{steps:10});await page.mouse.up();await tick(200);
  const ratio=Number(await page.$eval('#markdown-divider',el=>el.getAttribute('aria-valuenow')));assert(ratio>55&&ratio<75);assert((await ring()).left>before.left+50);
  await page.focus('#markdown-divider');await page.keyboard.press('ArrowLeft');await tick(100);
  assert(Number(await page.$eval('#markdown-divider',el=>el.getAttribute('aria-valuenow')))<ratio);
  await page.click('#markdown-divider',{count:2});await tick(100);assert.equal(await page.$eval('#markdown-divider',el=>el.getAttribute('aria-valuenow')),'50');
  assert.equal(await page.$$eval('#text-host .tag-note',nodes=>nodes.length),1);assert.equal(await page.$('#text-preview .note-anchor'),null);mark('real divider dragging, keyboard and double-click resizing keep one source-owned annotation and reflow the preview');

  await clickPreviewControl(page, 'markdown-preview-toggle');assert(await page.$eval('#text-preview',el=>el.hidden));assert(!await page.$eval('#text-host',el=>el.hidden));
  await clickPreviewControl(page, 'markdown-preview-toggle');await split();
  await selectRepeat('第一处');await page.click('#selection-discuss');await page.waitForSelector('#text-host .tag-discuss .tag-editor',{visible:true});
  await page.click('#text-host .tag-discuss .tag-editor');await page.keyboard.type('预览讨论草稿');
  assert(await page.evaluate(()=>Boolean(document.activeElement?.closest('#text-host .tag-discuss'))));
  const discussion=await waitDisk(async()=>{const value=await tags.read('main.md');return value?.tags.find(item=>item.projection?.draftText==='预览讨论草稿');});
  assert.equal(discussion.anchor.start,markdown.indexOf('重复引文'));
  assert.equal((await call('agents.messages',{projectId})).value.messages.length,0);
  await page.click('#text-host .tag-discuss .tag-window-title',{count:2});
  await contentToolForPage(page, ['view', 'text-mode']);assert(await page.$eval('#text-host',el=>el.hidden));assert(await page.$eval('#markdown-preview-toggle',el=>el.hidden));
  await contentToolForPage(page, ['view', 'text-mode']);await split();assert(await page.$('#text-host .tag-discuss'));assert.equal(await page.$('#text-preview .note-anchor'),null);
  mark('preview toggle and full reading keep notes/discussion drafts; split discussion typing uses the single source-owned projection without dispatch');

  await endOfSource();await page.keyboard.type('FILE_SWITCH_PENDING');await open('second.markdown');
  assert(await page.$eval('#text-host',el=>el.hidden));assert(!await page.$eval('#reader-scroll',el=>el.classList.contains('markdown-split')));
  await tick(500);assert(!await page.$eval('#text-preview',el=>el.textContent.includes('FILE_SWITCH_PENDING')));
  await open('main.md');await split();await endOfSource();await undo();assert.equal(await text(),markdown + 'FILE_SWITCH_PENDING');
  // Reopening deliberately starts a new editor undo history; remove our fixture edit through real selection/backspace.
  await page.evaluate(()=>{const n=__nozeliInput.text().length;__nozeliInput.select(n-'FILE_SWITCH_PENDING'.length,n);__nozeliInput.focus();});await page.keyboard.press('Backspace');
  await page.waitForFunction(()=>document.querySelector('#save-status').dataset.state==='saved');assert.equal(await text(),markdown);
  mark('pending render cannot leak into another Markdown file; file switching restores split mode and flushes the actual buffer');

  await contentToolForPage(page, ['history', 'compareFile']);await page.waitForSelector('#beside-dialog[open]');await page.select('#beside-file','second.markdown');await page.click('#beside-form button[type=submit]');
  await page.waitForFunction(()=>!document.querySelector('#secondary-pane').hidden);assert(!await page.$eval('#reader-scroll',el=>el.classList.contains('markdown-split')));
  await page.click('#diff-mode');await page.waitForSelector('.document-diff .cm-mergeView');
  const diffPoint=await page.$eval('.document-diff .cm-editor',el=>{const b=el.getBoundingClientRect();return{x:b.left+5,y:b.top+20};});await page.mouse.click(diffPoint.x,diffPoint.y,{button:'right'});await page.waitForSelector('#document-context-menu:not([hidden])');
  assert(!await page.$('[data-command="preview-toggle"]'));await page.keyboard.press('Escape');
  await page.click('#compare-mode');await page.click('#secondary-close');
  await page.waitForSelector('#action-confirmation[open]');await page.click('#action-confirmation-accept');await page.waitForSelector('#action-confirmation[open]',{hidden:true});
  await page.waitForSelector('#secondary-pane[hidden]');await tick(100);
  await clickPreviewControl(page, 'markdown-preview-toggle');await split();
  mark('file comparison and history/diff keep two columns; source/preview mode resumes explicitly');

  await page.$eval('#markdown-preview-scroll',el=>el.scrollTop=0);await page.click('#text-preview [data-path="sample.ts"]');
  await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='sample.ts'&&__nozeliInput.selection()?.from==='export const first = 1;\n'.length);
  assert(await page.$eval('#markdown-preview-toggle',el=>el.hidden));assert(await page.$eval('#text-preview',el=>el.hidden));await page.waitForSelector('.monaco-editor');
  const codePoint=await page.$eval('#text-host',el=>{const b=el.getBoundingClientRect();return{x:b.left+5,y:b.top+20};});await page.mouse.click(codePoint.x,codePoint.y,{button:'right'});await page.waitForSelector('#document-context-menu:not([hidden])');await page.click('#document-context-menu [data-command="view"]');
  assert(!await page.$('[data-command="preview-toggle"]'));await page.keyboard.press('Escape');
  await open('note.txt');assert(await page.$eval('#markdown-preview-toggle',el=>el.hidden));
  await open('main.md');await split();
  mark('preview project link opens the exact code line; Markdown layout and controls never leak into native code or plain-text files');

  for (const width of [960,600]) {
    await resize(width,width===600?800:900);await split();const geometry=await page.evaluate(()=>{
      const l=document.querySelector('#text-host').getBoundingClientRect(),r=document.querySelector('#markdown-preview-scroll').getBoundingClientRect(),p=document.querySelector('#reader-scroll').getBoundingClientRect();
      return{left:l.width,right:r.width,overlap:l.right>r.left,overflow:r.right>p.right+1,height:r.height};
    });assert(geometry.left>90&&geometry.right>90&&!geometry.overlap&&!geometry.overflow&&geometry.height>300);
    await page.$eval('#markdown-preview-scroll',el=>el.scrollTop=0);await tick(200);
    const labels=await page.evaluate(()=>{const pane=document.querySelector('#markdown-preview-scroll'),box=pane.getBoundingClientRect();return{scroll:pane.scrollWidth-pane.clientWidth,cards:[...pane.querySelectorAll('.note-projection')].filter(el=>getComputedStyle(el).visibility!=='hidden').map(el=>{const r=el.getBoundingClientRect();return r.left>=box.left-1&&r.right<=box.right+1;})};});
    assert(labels.scroll<=1&&labels.cards.every(Boolean),width+': '+JSON.stringify(labels));await shot('split-'+width);
  }
  mark('960px and 600px real windows keep source and preview visible without overlap or horizontal pane overflow');
  await resize(1440);
  const allProjects=await page.$$('#recent button');assert(allProjects.length>=2);
  const otherSelector='#recent button[title="other-project"]';await page.click(otherSelector);
  await open('main.md');
  assert(await page.$eval('#text-host',el=>el.hidden));assert.equal(await page.$eval('#text-preview h1',el=>el.textContent.trim()),'Other project');
  await page.click('#recent button[title="project"]');await page.waitForFunction(()=>document.querySelector('#text-preview h1')?.textContent.trim()==='Markdown 动态分屏');await split();
  mark('same-name files in different projects retain separate reading/split mode and preview content');

  await page.focus('#markdown-divider');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
  await page.$eval('#markdown-preview-scroll',el=>el.scrollTop=340);await tick(500);
  const finalView={ratio:await page.$eval('#markdown-divider',el=>el.getAttribute('aria-valuenow')),top:await page.$eval('#markdown-preview-scroll',el=>el.scrollTop)};
  assert(await page.$$eval('#text-preview .note-projection',nodes=>nodes.every(node=>getComputedStyle(node).visibility==='hidden')));
  await shot('03-before-restart');await close();await launch();await split();await tick(300);
  assert.equal(await page.$eval('#markdown-divider',el=>el.getAttribute('aria-valuenow')),finalView.ratio);
  assert(Math.abs(await page.$eval('#markdown-preview-scroll',el=>el.scrollTop)-finalView.top)<2);
  await page.$eval('#text-host .cm-scroller',node=>{node.scrollTop=0;});await page.waitForSelector('#text-host .tag-note');assert(await page.$('#text-host .tag-discuss'));assert.equal(await page.$('#text-preview .note-anchor'),null);assert.equal(await text(),markdown);
  await shot('04-restored');mark('full native app close/relaunch restores file, split ratio, preview scroll, annotations and discussion state');
  assert.deepEqual(report.errors,[]);await close();
  for(const [name,expected]of Object.entries(sources))assert.equal(await readFile(path.join(project,name),'utf8'),expected);
  report.ok=true;mark('source files remain intact, renderer has no pageerror and native close flushes normally');
} catch(error) {
  report.error=String(error.stack||error);
  if(page&&!page.isClosed()){await shot('failure').catch(()=>{});report.state=await page.evaluate(()=>({file:document.querySelector('#file-path')?.textContent,status:document.querySelector('#save-status')?.textContent,error:document.querySelector('#save-error')?.textContent,focus:document.activeElement?.outerHTML.slice(0,350),mode:document.querySelector('#reader-scroll')?.className})).catch(()=>null);}
} finally {
  await browser?.disconnect();if(child&&child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exited;}
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');await writeFile(path.join(output,'main.log'),log);
}
console.log(JSON.stringify({ok:report.ok,output,checks:report.checks,error:report.error,errors:report.errors},null,2));process.exit(report.ok?0:1);
