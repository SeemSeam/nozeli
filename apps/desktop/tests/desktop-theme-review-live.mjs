// Isolated real Electron component smoke. Production editors/appearance/Diff are
// bundled unchanged; only the host transport is local and never starts an Agent.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp('/home/bfly/.cache/nozeli-smokes/theme-review-');
const report={out,checks:[],errors:[],matrix:[]};
await build({entryPoints:[path.join(root,'tests/theme-review.fixture.mjs')],outfile:path.join(out,'review.js'),bundle:true,format:'esm',platform:'browser',loader:{'.ttf':'file'},plugins:[{name:'nonce',setup(b){b.onLoad({filter:/monaco-editor.*\.js$/},async({path:file})=>({contents:(await fs.readFile(file,'utf8')).replace(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.createElement\((['"])style\2\)/g,'Object.assign($1.createElement($2style$2),{nonce:"review-nonce"})'),loader:'js'}));}}]});
await fs.copyFile(path.join(root,'dist/renderer/monaco-worker.js'),path.join(out,'monaco-worker.js'));
await fs.writeFile(path.join(out,'review.html'),`<!doctype html><meta charset="utf-8"><meta name="nozeli-style-nonce" content="review-nonce"><link rel="stylesheet" href="review.css"><style>body{margin:0;background:var(--paper);color:var(--ink);font:14px monospace}main{display:grid;grid-template-columns:1fr 1fr;gap:8px}section{height:310px;overflow:hidden}.cm-editor{height:100%}#diff{grid-column:1/-1;height:320px}#diff>.cm-mergeView{height:100%}</style><script>window.reviewListeners={};window.reviewPreference={theme:'light',palette:'sage',font:'system',size:13};window.nozeli={invoke:async(op)=>op==='settings.appearance.read'?{ok:true,value:window.reviewPreference}:{ok:true,value:null},subscribe:(name,fn)=>{(window.reviewListeners[name]??=[]).push(fn);return()=>{window.reviewListeners[name]=window.reviewListeners[name].filter(x=>x!==fn);}}};</script><main><section id="cm"></section><section id="monaco"></section><section id="tex"></section><section id="diff" class="document-diff"></section></main><script type="module" src="review.js"></script>`);
// Require Electron from its own runtime, not from the node package's binary export.
await fs.writeFile(path.join(out,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:1050,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(path.join(out,'review.html'))});});app.on('window-all-closed',()=>app.quit());`);
const req=createRequire(import.meta.url);const child=spawn(req('electron'),['--ozone-platform='+(process.env.NOZELI_OZONE||'wayland'),'--remote-debugging-port=46187',path.join(out,'main.cjs')],{env:{...process.env},stdio:['ignore','pipe','pipe']});let log='';for(const s of[child.stdout,child.stderr])s.on('data',b=>log+=b);
let browser;
async function until(fn,label){for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(log);const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,75));}throw Error('Timeout '+label);}
try{
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:46187',defaultViewport:null});return true;}catch{return false;}},'debug');
 const page=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.reviewReady).catch(()=>false))return p;},'widgets');page.on('pageerror',e=>report.errors.push(e.message));
 await page.waitForSelector('#cm .tok-keyword');await page.waitForSelector('#diff .cm-changedText');await page.waitForSelector('#markdown pre code span[style]');
 await page.bringToFront();await page.click('#cm .cm-content');await page.keyboard.down('Control');await page.keyboard.press('Home');await page.keyboard.up('Control');await page.keyboard.down('Shift');for(let i=0;i<5;i++)await page.keyboard.press('ArrowRight');await page.keyboard.up('Shift');
 await page.keyboard.type('let');await page.keyboard.down('Shift');await page.keyboard.press('Home');await page.keyboard.up('Shift');
 const before=await page.evaluate(()=>review.state());
 for(const theme of ['light','dark'])for(const palette of ['sage','slate']){
  await page.evaluate(({theme,palette})=>review.set({theme,palette,font:'system',size:13}),{theme,palette});
  await new Promise(r=>setTimeout(r,150));
  const data=await page.evaluate(()=>{
   const rgb=value=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=value;x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data].slice(0,3);};
   const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
   const contrast=(a,b)=>{a=lum(rgb(a));b=lum(rgb(b));return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
   const background=n=>{while(n){const s=getComputedStyle(n);if(s.backgroundColor!=='rgba(0, 0, 0, 0)'&&s.backgroundColor!=='transparent')return s.backgroundColor;n=n.parentElement;}return getComputedStyle(document.body).backgroundColor;};
   const tokens=[...document.querySelectorAll('#cm [class*="tok-"],#diff [class*="tok-"],#markdown pre code span[style]')].filter(n=>n.textContent.trim()).map(n=>({text:n.textContent,className:n.className,color:getComputedStyle(n).color,bg:background(n),contrast:contrast(getComputedStyle(n).color,background(n))}));
   const numbers=[...document.querySelectorAll('#monaco .line-numbers')].map(n=>({color:getComputedStyle(n).color,contrast:contrast(getComputedStyle(n).color,getComputedStyle(document.querySelector('#monaco .monaco-editor')).backgroundColor)}));
   return{tokens,numbers,selection:[...document.querySelectorAll('#cm .cm-selectionBackground')].map(n=>getComputedStyle(n).backgroundColor),paper:getComputedStyle(document.querySelector('#cm .cm-editor')).backgroundColor,monacoPaper:getComputedStyle(document.querySelector('#monaco .monaco-editor')).backgroundColor};
  });
  assert(data.tokens.some(t=>t.className.includes('tok-keyword')));assert(data.tokens.some(t=>t.className.includes('tok-comment')));
  assert(new Set(data.tokens.filter(t=>/tok-keyword|tok-number|tok-comment/.test(t.className)).map(t=>t.color)).size>=3,'keywords, numbers and comments must actually have distinct syntax colors, not inherit one ink color');
  report.matrix.push({theme,palette,...data});
  for(const t of data.tokens)assert(t.contrast>=4.5,theme+'/'+palette+' token '+JSON.stringify(t));
  for(const n of data.numbers)assert(n.contrast>=4.5,theme+'/'+palette+' line number '+JSON.stringify(n));
  assert.equal(data.monacoPaper,data.paper);assert(data.selection.length>0,'actual focused selection drawn');
  assert.notEqual(data.selection[0],data.paper);assert.deepEqual(await page.evaluate(()=>review.state()),before);
 }
 report.checks.push('CodeMirror actual tokens and Diff changed spans, Monaco line numbers, focused selection: all four combinations AA and state unchanged');
 await page.keyboard.down('Control');await page.keyboard.press('z');await page.keyboard.up('Control');assert.equal(await page.evaluate(()=>review.cm.state.doc.toString()),await page.evaluate(()=>review.before),'theme switches retain undo history from before the switch');
 await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('z');await page.keyboard.up('Shift');await page.keyboard.up('Control');assert.equal(await page.evaluate(()=>review.cm.state.doc.toString()),before.text,'redo restores pre-switch edit');
 const changesBeforeCompletion=await page.evaluate(()=>review.changes);
 await page.evaluate(()=>{review.cm.dispatch({selection:{anchor:review.cm.state.doc.length}});review.cm.focus();});
 await page.keyboard.down('Control');await page.keyboard.press('Space');await page.keyboard.up('Control');await page.waitForSelector('#cm .cm-tooltip-autocomplete',{visible:true});
 const completion=await page.$eval('#cm .cm-tooltip-autocomplete .cm-completionLabel',n=>n.textContent);await page.keyboard.press('Tab');
 assert((await page.evaluate(()=>review.cm.state.doc.toString())).endsWith(completion),'Tab accepts displayed completion');
 assert.equal(await page.evaluate(()=>review.changes),changesBeforeCompletion+1);report.checks.push('Real Ctrl+Space opens completions; Tab accepts the displayed candidate without exceptions; theme switches retain undo/redo history');
 // Wait until the asynchronous TeX installer has had a chance to finish; its
 // global theme setter must not leave either Monaco editor in light-plus.
 await page.evaluate(()=>review.set({theme:'dark',palette:'slate',font:'system',size:13}));await new Promise(r=>setTimeout(r,2500));
 assert.equal(await page.$eval('#tex .monaco-editor',n=>getComputedStyle(n).backgroundColor),'rgb(34, 45, 58)');report.checks.push('Late TeX installation does not revert the shared Monaco theme');
 let notices=await page.evaluate(()=>{window.reviewNoticeCount=0;document.addEventListener('appearance:change',()=>window.reviewNoticeCount++);review.set({theme:'light',palette:'sage',font:'serif',size:16});return window.reviewNoticeCount;});assert.equal(notices,1);
 notices=await page.evaluate(()=>{review.set({theme:'light',palette:'sage',font:'serif',size:16});return window.reviewNoticeCount;});assert.equal(notices,1);report.checks.push('Appearance preference updates notify once, including font/size; repeated identical broadcasts do not duplicate');
 const cdp=await page.target().createCDPSession();await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
 await page.evaluate(()=>review.set({theme:'system',palette:'sage',font:'serif',size:16}));
 const systemCount=await page.evaluate(()=>window.reviewNoticeCount);
 await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 assert.equal(await page.evaluate(()=>window.reviewNoticeCount),systemCount+1);
 await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
 assert.equal(await page.evaluate(()=>window.reviewNoticeCount),systemCount+2);report.checks.push('System light/dark changes update the effective theme and notify exactly once per change');
 await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
 const forced=await page.$eval('#cm .tok-keyword',n=>getComputedStyle(n).color);assert.equal(forced,await page.evaluate(()=>getComputedStyle(document.body).color));report.checks.push('Forced colors uses system text and preserves Diff non-color outlines');
 await cdp.send('Emulation.setEmulatedMedia',{features:[]});await page.screenshot({path:path.join(out,'editor-diff-theme.png')});assert.deepEqual(report.errors,[]);
 await browser.disconnect();browser=null;child.kill('SIGTERM');report.ok=true;
}catch(error){report.failure=error.stack;report.ok=false;process.exitCode=1;}finally{await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'main.log'),log);console.log(JSON.stringify({out,ok:report.ok,checks:report.checks,failure:report.failure},null,2));}
