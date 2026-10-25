import { contentToolForPage } from './native-content-tools.fixture.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {FileTags} from '../src/domain/file-tags.mjs';

const root=path.resolve(import.meta.dirname,'..');
await fs.mkdir(path.join(root,'.test-output'),{recursive:true});
const out=await fs.mkdtemp(path.join(root,'.test-output/immersive-ui-')),configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop');
const project=path.join(out,'界面验收'),fence=String.fromCharCode(96).repeat(3);
await fs.mkdir(path.join(project,'docs'),{recursive:true});
const markdown='# 沉浸阅读验收\n\n第一处：重复引文。\n\n第二处：重复引文。\n\n粗体 **重要文字** 和 *斜体*、[项目源码](../sample.cc:2)、[外部链接](https://example.org)。\n\n| 项目 | 状态 |\n| --- | --- |\n| Markdown | 可阅读 |\n| 批注 | 可定位 |\n\n行内 $E=mc^2$，混合 **粗体 $a+b$** 与 \\(x+1\\)。\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n\n'+fence+'cpp\n#include <iostream>\nint main() { return 0; }\n'+fence+'\n\n'+Array.from({length:12},(_,i)=>'第 '+(i+1)+' 段：舒适的正文行宽、明确的材料位置和不中断阅读的对话。').join('\n\n');
await fs.writeFile(path.join(project,'docs/阅读验收.md'),markdown);
await fs.writeFile(path.join(project,'sample.cc'),'#include <iostream>\nint main() {\n  return 0;\n}\n');
await fs.copyFile(path.join(root,'assets/nozeli.png'),path.join(project,'图片.png'));
await fs.copyFile(path.resolve(root,'tests/fixtures/pdf/nozeli-sample.zh.pdf'),path.join(project,'样例.pdf'));
const host=new DesktopHost(profile);const {project:registered}=await host.pick(project),store=new FileTags(project);
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform=wayland'],{cwd:root,env:{...process.env,WAYLAND_DISPLAY:'wayland-0',XDG_RUNTIME_DIR:'/run/user/1000',NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:configRoot,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out},stdio:['ignore','pipe','pipe']});
const exited=new Promise(resolve=>child.once('exit',resolve));let log='',browser,p;const errors=[],checks=[];
for(const stream of [child.stdout,child.stderr])stream.on('data',data=>log+=data);
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<120;i++){const result=await check();if(result)return result;await tick(80);}throw Error('Disk state timeout');}
try{
  for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{}await tick(100);}
  assert(browser,log);p=await(await browser.waitForTarget(target=>target.type()==='page'&&target.url().startsWith('http://127.0.0.1:'))).page();p.on('pageerror',error=>errors.push(error.stack));
  await p.waitForFunction(()=>window.__nozeliReady);await p.waitForSelector('#configuration-setup[open]');await p.click('#configuration-cancel');
  async function resize(width,height=900){await p.evaluate(({width,height})=>nozeli.invoke('session.resize',{width,height}),{width,height});await p.waitForFunction(width=>innerWidth===width,{},width);await tick(120);}
  async function open(file){
    if(await p.$eval('#app',el=>el.classList.contains('narrow-layout')&&!el.classList.contains('drawer-files-open')))await p.click('#file-toggle');
    if(await p.$eval('#app',el=>el.classList.contains('files-collapsed')&&!el.classList.contains('narrow-layout')))await p.click('#file-toggle');
    if(file.startsWith('docs/')){
      const hidden=await p.$eval('#file-tree button[data-path="docs"]',el=>el.getAttribute('aria-expanded')==='false');
      if(hidden)await p.click('#file-tree button[data-path="docs"]');
    }
    await p.click('#file-tree button[data-path="'+file+'"]');await p.waitForFunction(file=>document.querySelector('#file-path').textContent===file,{},file);await tick(120);
    if(await p.$eval('#app',el=>el.classList.contains('drawer-files-open')))await p.click('#file-toggle');
  }
  await resize(1440);await open('docs/阅读验收.md');
  await p.waitForFunction(()=>document.querySelector('#text-preview pre code')?.dataset.highlighted==='cpp');
  const markup=await p.$eval('#text-preview',el=>({links:el.querySelectorAll('a').length,tables:el.querySelectorAll('table').length,math:el.querySelectorAll('.katex').length,mathError:el.querySelectorAll('.katex-error').length,codeColors:new Set([...el.querySelectorAll('pre code span')].map(s=>getComputedStyle(s).color)).size,copy:el.querySelectorAll('.conversation-copy').length,strongMath:!!el.querySelector('strong .katex')}));
  assert(markup.links&&markup.tables&&markup.math>=4&&markup.mathError===0&&markup.codeColors>=3&&markup.copy===1&&markup.strongMath);
  await p.click('#text-preview .conversation-copy');await p.waitForFunction(()=>document.querySelector('#text-preview .conversation-copy').textContent==='✓');
  assert.equal((await p.evaluate(()=>nozeli.invoke('document.clipboard',{action:'read'}))).value,'#include <iostream>\nint main() { return 0; }');
  checks.push('real Markdown tables, mixed inline/display math, C++ colors and clipboard');
  assert(await p.$eval('#side',el=>el.getBoundingClientRect().width<=40));
  assert(await p.$eval('#conversation-panel',el=>el.classList.contains('compact-composer')&&el.getBoundingClientRect().height<=90));
  assert.equal(await p.$eval('#open-files .open-file-item',el=>el.dataset.path),'docs/阅读验收.md');
  await p.screenshot({path:path.join(out,'01-reading.png')});checks.push('empty sidebar and chat compact; left open-file list only');
  async function selectRepeat(prefix='第二处'){
    const points=await p.evaluate(prefix=>{
      const el=[...document.querySelectorAll('#text-preview p')].find(el=>el.textContent.startsWith(prefix));
      const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){const start=node.textContent.indexOf('重复引文');if(start<0)continue;const r=document.createRange();r.setStart(node,start);r.setEnd(node,start+4);const box=r.getBoundingClientRect();return {x:box.left+.2,y:box.top+box.height/2,end:box.right-.2};}
    },prefix);
    assert(points);await p.mouse.move(points.x,points.y);await p.mouse.down();await p.mouse.move(points.end,points.y,{steps:10});await p.mouse.up();await p.waitForFunction(()=>!document.querySelector('#selection-menu').hidden);
  }
  await selectRepeat();await p.click('#selection-note');await p.waitForFunction(()=>!document.querySelector('#note-form').hidden);
  assert.match(await p.$eval('.note-form-source summary',el=>el.textContent),/docs\/阅读验收.md.*第/);
  await p.type('#note-input','**第二处备注**，公式 $x^2$');
  await p.$$eval('#note-form .composer-tabs button',buttons=>buttons[1].click());
  await p.waitForSelector('#note-form .composer-preview .katex');await p.click('#add-note');await p.waitForSelector('#text-preview .tag-note');
  const note=await until(async()=>{const file=await store.read('docs/阅读验收.md');return file?.tags.find(tag=>tag.note.includes('第二处备注'));});
  const expected=markdown.indexOf('重复引文',markdown.indexOf('重复引文')+1);
  assert.equal(note.anchor.start,expected);assert.equal(note.anchor.end,expected+4);assert.equal(note.anchor.quote,'重复引文');
  const messages=await p.evaluate(id=>nozeli.invoke('agents.messages',{projectId:id}),registered.id);assert.equal(messages.value.messages.length,0);
  checks.push('physical repeat-text selection saves exact second source coordinates; local note dispatches nothing');
  const noteSelector='#text-preview .tag-note[data-annotation="'+note.id+'"]';
  await p.click(noteSelector+' .tag-edit');await p.waitForSelector(noteSelector+' .tag-editor',{visible:true});
  await p.$$eval('#text-preview .tag-note .composer-tabs button',buttons=>buttons[1].click());
  await p.waitForSelector(noteSelector+' .composer-preview .katex');
  for(let i=0;i<3;i++){
    await p.click(noteSelector+' .tag-window-title',{count:2});await p.waitForFunction(selector=>document.querySelector(selector+' .note-projection').classList.contains('is-collapsed'),{},noteSelector);
    assert(await p.$eval(noteSelector+' .note-projection',el=>el.getBoundingClientRect().height<=60&&[...el.children].slice(1).every(node=>node.getBoundingClientRect().height===0)));
    await p.click(noteSelector+' .note-projection-content',{count:2});await p.waitForFunction(selector=>!document.querySelector(selector+' .note-projection').classList.contains('is-collapsed'),{},noteSelector);
  }
  await p.click(noteSelector+' .tag-edit');assert.equal(await p.$eval(noteSelector+' .tag-editor',el=>el.value),'**第二处备注**，公式 $x^2$');
  await p.click(noteSelector+' .tag-close');
  const selections=await p.evaluate(()=>{
    const leafText=element=>{const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);return walker.nextNode();};
    const root=document.querySelector('#text-preview'),paragraph=[...root.querySelectorAll('p')].find(el=>el.textContent.startsWith('粗体'));
    const selections=[{from:leafText(paragraph.querySelector('strong')),fromOffset:1,to:leafText(paragraph.querySelector('em')),toOffset:2},
      {from:leafText(root.querySelector('.conversation-math .katex-html')),fromOffset:0,to:leafText(root.querySelector('.conversation-math .katex-html')),toOffset:1}];
    const code=[...root.querySelectorAll('pre code span')].find(el=>el.textContent==='int');selections.push({from:leafText(code),fromOffset:1,to:leafText(code),toOffset:3});
    return selections.map(({from,fromOffset,to,toOffset})=>({fromPath:[...root.querySelectorAll('*')].indexOf(from.parentElement),fromOffset,toPath:[...root.querySelectorAll('*')].indexOf(to.parentElement),toOffset}));
  });
  const quotes=['要文字** 和 *斜体','$E=mc^2$','nt'];
  for(let i=0;i<selections.length;i++){
    await p.evaluate(item=>{
      const root=document.querySelector('#text-preview'),nodes=[...root.querySelectorAll('*')],range=document.createRange();
      const first=nodes[item.fromPath].firstChild,last=nodes[item.toPath].firstChild;range.setStart(first,item.fromOffset);range.setEnd(last,item.toOffset);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);root.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    },selections[i]);await p.waitForFunction(()=>!document.querySelector('#selection-menu').hidden);await p.click('#selection-note');
    assert.equal(await p.$eval('.note-form-source blockquote',el=>el.textContent),quotes[i]);await p.click('#cancel-note');
  }
  checks.push('formatted-span, atomic formula and highlighted partial-code selections map back to exact Markdown source');
  await selectRepeat('第一处');await p.click('#selection-discuss');await p.waitForSelector('#text-preview .tag-discuss');
  const discussSelector='#text-preview .tag-discuss';
  await p.type(discussSelector+' .tag-editor','**讨论草稿** $a+b$');
  assert.equal(await p.$$eval(discussSelector+' .composer-tabs,'+discussSelector+' .composer-preview',nodes=>nodes.length),0);
  assert.equal(await p.$eval(discussSelector+' .tag-editor',el=>el.value),'**讨论草稿** $a+b$');
  await p.screenshot({path:path.join(out,'02-annotation-input.png')});
  await p.click(discussSelector+' .tag-window-title',{count:2});await p.waitForFunction(()=>document.querySelector('#text-preview .tag-discuss .note-projection').classList.contains('is-collapsed'));
  checks.push('conversation uses direct input without preview while preserving Markdown draft; note preview remains separate');
  await p.click('#chat-history-toggle');assert(await p.$eval('#conversation-panel',el=>!el.classList.contains('compact-composer')));
  await p.type('#composer','项目草稿保持');await p.waitForFunction(()=>document.querySelector('#compose-status').textContent.includes('已保存'));
  await p.click('#toggle-sidebar');await tick(150);
  await p.click('#file-toggle');assert(await p.$eval('#side',el=>el.getBoundingClientRect().width>200));await p.click('#file-toggle');
  async function drag(selector,dx,dy){const point=await p.$eval(selector,el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});await p.mouse.move(point.x,point.y);await p.mouse.down();await p.mouse.move(point.x+dx,point.y+dy,{steps:10});await p.mouse.up();await tick(120);}
  await p.waitForFunction(()=>!document.querySelector('#side-divider').hidden);await drag('#side-divider',-30,0);
  const sideWidth=await p.$eval('#side',el=>el.getBoundingClientRect().width);
  await p.reload();await p.waitForFunction(()=>window.__nozeliReady);await p.waitForSelector(noteSelector);
  assert.equal(await p.$eval('#composer',el=>el.value),'项目草稿保持');assert(await p.$eval('#conversation-panel',el=>!el.classList.contains('compact-composer')));
  assert(Math.abs(await p.$eval('#side',el=>el.getBoundingClientRect().width)-sideWidth)<2);
  assert(await p.$eval(discussSelector+' .note-projection',el=>el.classList.contains('is-collapsed')));
  checks.push('explicit full chat, manual sidebar size, note states and unsent draft persist across renderer restart');
  await p.click('#toggle-sidebar');await p.click('#chat-history-toggle');
  await contentToolForPage(p, ['view', 'document-font']);await p.click('.nozeli-submenu [data-command="document-font-18"]');
  assert.equal(await p.$eval('#text-preview',el=>getComputedStyle(el).fontSize),'18px');
  await contentToolForPage(p, ['view', 'document-font']);await p.click('.nozeli-submenu [data-command="document-font-reset"]');
  await p.click('#text-preview [data-path="sample.cc"]');await p.waitForFunction(()=>document.querySelector('#file-path').textContent==='sample.cc');await p.waitForSelector('.monaco-editor');
  await contentToolForPage(p, ['view', 'document-font']);await p.click('.nozeli-submenu [data-command="document-font-18"]');await p.waitForFunction(()=>getComputedStyle(document.querySelector('.monaco-editor .view-line')).fontSize==='18px');
  checks.push('relative Markdown project links open source and font menu changes reading/editor text');
  for(const width of [1440,960,600]){
    await resize(width,width===600?800:900);await p.evaluate(()=>{__nozeliInput.select(0,0);__nozeliInput.select(20,30);});await p.waitForFunction(()=>!document.querySelector('#selection-menu').hidden);
    const fit=await p.evaluate(()=>{const menu=document.querySelector('#selection-menu').getBoundingClientRect(),pane=document.querySelector('#reader-scroll').getBoundingClientRect();return menu.left>=pane.left&&menu.right<=pane.right+1&&menu.top>=pane.top&&menu.bottom<=pane.bottom;});assert(fit,'owner pane at '+width);
    if(width<=1000){await p.click('#file-toggle');await p.waitForFunction(()=>document.querySelector('#app').classList.contains('drawer-files-open'));await p.click('#file-toggle');assert(await p.$eval('#reader',el=>el.getBoundingClientRect().width>innerWidth-140));}
    await p.screenshot({path:path.join(out,'code-'+width+'.png')});
    { await p.click('#open-settings'); await p.click('[data-settings-section="settings-general"]'); await p.click('#provider-console-toggle'); }await p.waitForFunction(()=>!document.querySelector('#provider-console').hidden);assert(await p.$eval('#selection-menu',el=>el.hidden));assert(await p.$eval('#text-host',el=>el.closest('#work-surface').inert));
    await p.click('#terminal-menu-qa');await p.waitForFunction(()=>document.querySelector('#terminal-actions-qa').matches(':popover-open'));
    const menu=await p.$eval('#terminal-actions-qa',el=>el.getBoundingClientRect().toJSON());assert(menu.left>=0&&menu.right<=width);await p.keyboard.press('Escape');
    await p.screenshot({path:path.join(out,'terminal-'+width+'.png')});await p.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });
  }
  checks.push('1440/960/600 drawers and quick actions stay inside owning document; terminal menus and reading isolation');
  await resize(1440);await open('图片.png');await p.waitForSelector('.image-page canvas');
  assert.equal(await p.$eval('#font-control',el=>getComputedStyle(el).display),'none');await p.screenshot({path:path.join(out,'03-image.png')});
  await open('样例.pdf');await p.waitForSelector('.pdf-page canvas');assert.equal(await p.$eval('#font-control',el=>getComputedStyle(el).display),'none');await p.screenshot({path:path.join(out,'04-pdf.png')});
  checks.push('image/PDF controls stay in single file row with text font menu hidden');
  assert.deepEqual(errors,[]);await p.evaluate(()=>nozeli.invoke('session.requestClose'));const result=await Promise.race([exited,tick(15000).then(()=> 'timeout')]);assert.equal(result,0);
  checks.push('real close flushes state and exits normally');
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,checks,markup,errors,project,profile},null,2));console.log(JSON.stringify({passed:true,out,checks},null,2));
}catch(error){await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:false,checks,errors,error:error.stack,project,profile},null,2));if(p&&!p.isClosed())await p.screenshot({path:path.join(out,'failure.png')});console.error({out,checks,errors});throw error;}
finally{await browser?.disconnect();if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exited;}await fs.writeFile(path.join(out,'main.log'),log);}
