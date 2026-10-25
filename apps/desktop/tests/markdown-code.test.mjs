import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-code-'));
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`
 import {highlightMarkdownCode} from './src/renderer/markdown-code.mjs';
 import {renderTagMarkdown} from './src/renderer/tag-markdown.mjs';
 import {markdownSelection,markdownRange} from './src/renderer/markdown-source.mjs';
 import './src/renderer/immersive-ui.css';
 import './src/renderer/conversation-rendering.css';
 import './src/renderer/session-timeline.css';
 import './src/renderer/settings-appearance.css';
 window.codeTest={highlightMarkdownCode,renderTagMarkdown,markdownSelection,markdownRange};
 `},bundle:true,format:'iife',platform:'browser',outfile:path.join(out,'entry.js'),loader:{'.css':'css','.ttf':'file','.woff':'file','.woff2':'file'}});
await fs.writeFile(path.join(out,'index.html'),'<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="entry.css"><div id="fixture"></div><script src="entry.js"></script></html>');
await fs.writeFile(path.join(out,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:${process.env.NOZELI_TEST_VISIBLE==='1'},webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.join(out,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(out,'main.cjs'),'--remote-debugging-port='+port,'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland'),'--user-data-dir='+path.join(out,'profile')],{cwd:root,stdio:['ignore','pipe','pipe']});
let log='',browser;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
const exited=new Promise(resolve=>child.once('exit',resolve));
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await new Promise(resolve=>setTimeout(resolve,100));}}
 assert(browser,log);
 const target=await browser.waitForTarget(target=>target.type()==='page'&&target.url().endsWith('/index.html'));const page=await target.page();await page.waitForFunction(()=>window.codeTest);
 const result=await page.evaluate(async()=>{
  const {highlightMarkdownCode,renderTagMarkdown,markdownSelection,markdownRange}=window.codeTest,fixture=document.querySelector('#fixture');
  const expect=(value,message)=>{if(!value)throw Error(message);};
  const lum=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
  const samples={js:'// readable comment\nexport const value = "中文 🐈";\nconsole.log(value, 42);',json:'{ "name": "中文", "active": true, "count": 42 }',unknown:'<plain>& untouched\nlast line'};
  const measurements=[];
  for(const surface of ['document','tag','agent','session']){
   const body=document.createElement('div');if(surface==='document')body.id='text-preview';else body.className={tag:'tag-markdown',agent:'agent-message-body',session:'session-markdown'}[surface];fixture.append(body);
   const fence='```',source=Object.entries(samples).map(([lang,text])=>fence+lang+'\n'+text+'\n'+fence).join('\n\n');
   renderTagMarkdown(body,source,{mapSource:true});await body.markdownReady;
   const codes=[...body.querySelectorAll('pre code')];
   expect(codes.every((code,i)=>code.textContent===Object.values(samples)[i]),surface+' original code text');
   expect(codes[0].dataset.highlighted==='javascript'&&codes[1].dataset.highlighted==='json'&&!codes[2].dataset.highlighted,'language aliases and unknown fallback');
   const start=source.indexOf('中文 🐈'),anchor={start,end:start+'中文 🐈'.length};const range=markdownRange(body,anchor);
   expect(range.toString()==='中文 🐈','source-map range includes surrogate pair');
   expect(markdownSelection(body,range,source).start===start,'source selection round trip');
   const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
   const nodes=codes.map(code=>[...code.childNodes]);
   for(const theme of ['light','dark']){
    document.documentElement.dataset.theme=theme;
    for(const code of codes){
     const background=getComputedStyle(code.parentElement).backgroundColor,bg=lum(background),colors=new Set();
     for(const node of code.children.length?code.children:[code]){
      if(!node.textContent.trim())continue;
      const color=getComputedStyle(node).color,fg=lum(color),ratio=(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);colors.add(color);
      expect(ratio>=4.5,JSON.stringify({surface,theme,token:node.textContent,color,background,ratio}));
     }
     if(code.dataset.highlighted)expect(colors.size>=3,'semantic multicolor '+code.dataset.highlighted);
     measurements.push({surface,theme,language:code.dataset.language,background,colors:[...colors]});
    }
    expect(codes.every((code,i)=>nodes[i].every((node,j)=>code.childNodes[j]===node)),'theme switch retains token nodes');
    expect(selection.toString()==='中文 🐈','theme switch retains native selection');
   }
   selection.removeAllRanges();body.remove();
  }
  // Direct consumer boundaries: CRLF, trailing newline, and the 100000 budget.
  const body=document.createElement('div');fixture.append(body);
  const add=(text,language)=>{const pre=document.createElement('pre'),code=document.createElement('code');code.textContent=text;code.dataset.language=language;code._markdownSource=Array.from({length:text.length+1},(_,i)=>i+7);pre.append(code);body.append(pre);return code;};
  const raw='// first\r\nconst x = 1;\r\n',code=add(raw,'js'),budget=add('x'.repeat(100001),'js');
  await highlightMarkdownCode(body);expect(code.textContent===raw,'CRLF and trailing newline remain exact');expect(!budget.dataset.highlighted&&budget.textContent.length===100001,'over-budget stays plain');
  const leaves=[...code.children];expect(Number(leaves[0].dataset.mdFrom)===7&&Number(leaves.at(-1).dataset.mdTo)===raw.length+7,'source-map outer boundaries');
  const stale=document.createElement('div');fixture.append(stale);stale.innerHTML='<pre><code data-language="python"># pending</code></pre>';stale._markdownRenderToken=Symbol();let layouts=0;const pending=highlightMarkdownCode(stale,{onLayout:()=>layouts++});stale._markdownRenderToken=Symbol();await pending;expect(!stale.querySelector('code').dataset.highlighted&&layouts===0,'stale async render is ignored');
  return measurements;
 });
 assert.equal(result.length,24);console.log('Markdown code: semantic AA light/dark tokens, CSS-only selection retention, JS/JSON/unknown consumers, exact text/source boundaries, budget and stale-render checks passed');
}finally{if(browser)await browser.close().catch(()=>{});if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}await fs.rm(out,{recursive:true,force:true});}
