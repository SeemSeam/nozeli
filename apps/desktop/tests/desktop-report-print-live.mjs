// Real Electron PDF print pipeline, independent from the OS printer service.
// Reports are served-byte adapters over immutable fixtures; no model or user file.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {withReportReaderStyle,upgradeReportReaderStyle,reportReaderStyleTag} from '../src/agents/managed/report-reader-style.mjs';
const out=await fs.mkdtemp('/home/bfly/.cache/nozeli-smokes/report-print-review-');
const body='<h1>PRINT-REVIEW-482</h1><p>Report paragraph.</p><pre>const answer = 42;</pre><p><code>inline</code> <kbd>Enter</kbd></p><table><tr><th>Table heading</th></tr><tr><td>Cell text</td></tr></table>';
const versions=[['none',''],['legacy','<style id="nozeli-reader-style">body{color:light-dark(#212934,#d9e0e8)}</style>'],['v2','<style id="nozeli-reader-style">/* nozeli-reader-baseline v2 */:root{color-scheme:light dark}pre{background:light-dark(#f2f5f9,#18202a)}</style>'],['current',reportReaderStyleTag()],['author',reportReaderStyleTag()+'<style>pre{background:rgb(255,0,0);color:black}</style>']];
const hashes=[];
for(const[name,baseline]of versions){const original='<!doctype html><html><head>'+baseline+'</head><body>'+body+'</body></html>';hashes.push([name,createHash('sha256').update(original).digest('hex')]);await fs.writeFile(path.join(out,name+'-frozen.html'),original);await fs.writeFile(path.join(out,name+'.html'),upgradeReportReaderStyle(withReportReaderStyle(original)));}
const expression="JSON.stringify({scheme:getComputedStyle(document.documentElement).colorScheme,body:{color:getComputedStyle(document.body).color,bg:getComputedStyle(document.body).backgroundColor},pre:{color:getComputedStyle(document.querySelector('pre')).color,bg:getComputedStyle(document.querySelector('pre')).backgroundColor},th:{color:getComputedStyle(document.querySelector('th')).color,bg:getComputedStyle(document.querySelector('th')).backgroundColor}})";
await fs.writeFile(path.join(out,'main.cjs'),`
const {app,BrowserWindow,nativeTheme}=require('electron');
const fs=require('node:fs/promises');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 nativeTheme.themeSource='dark';const results=[];
 try{
  for(const name of ${JSON.stringify(versions.map(v=>v[0]))}){
   const w=new BrowserWindow({width:900,height:800,show:true,webPreferences:{sandbox:true,javascript:false,contextIsolation:true,nodeIntegration:false}});
   await w.loadFile(${JSON.stringify(out)}+'/'+name+'.html');
   w.webContents.debugger.attach('1.3');
   await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{media:'print',features:[{name:'prefers-color-scheme',value:'dark'}]});
   const answer=await w.webContents.debugger.sendCommand('Runtime.evaluate',{returnByValue:true,expression:${JSON.stringify(expression)}});
   const pdf=await w.webContents.printToPDF({printBackground:true,pageSize:'A4'});
   await fs.writeFile(${JSON.stringify(out)}+'/'+name+'.pdf',pdf);
   results.push({name,style:answer.result.value,pdfBytes:pdf.length});w.destroy();
  }
  await fs.writeFile(${JSON.stringify(out)}+'/native-result.json',JSON.stringify(results));app.quit();
 }catch(e){await fs.writeFile(${JSON.stringify(out)}+'/native-error.txt',e.stack);app.exit(1);}
});`);
const child=spawn(createRequire(import.meta.url)('electron'),['--ozone-platform='+(process.env.NOZELI_OZONE||'wayland'),path.join(out,'main.cjs')],{stdio:['ignore','pipe','pipe']});let log='';for(const s of[child.stdout,child.stderr])s.on('data',b=>log+=b);const exit=await new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));await fs.writeFile(path.join(out,'main.log'),log);
assert.equal(exit.code,0,'Electron print error: '+await fs.readFile(path.join(out,'native-error.txt'),'utf8').catch(()=>log));
const rows=JSON.parse(await fs.readFile(path.join(out,'native-result.json'),'utf8'));const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
for(const row of rows){
 const style=JSON.parse(row.style);assert.equal(style.scheme,'light');assert.equal(style.body.color,'rgb(0, 0, 0)');assert.equal(style.body.bg,'rgb(255, 255, 255)');
 assert.equal(style.pre.bg,row.name==='author'?'rgb(255, 0, 0)':'rgb(242, 245, 249)');assert.equal(style.th.bg,'rgb(242, 245, 249)');
 const task=pdfjs.getDocument({data:new Uint8Array(await fs.readFile(path.join(out,row.name+'.pdf')))}),pdf=await task.promise;
 const content=await(await pdf.getPage(1)).getTextContent();assert(content.items.map(x=>x.str).join(' ').includes('PRINT-REVIEW-482'));await task.destroy();row.style=style;
}
for(const[name,digest]of hashes)assert.equal(createHash('sha256').update(await fs.readFile(path.join(out,name+'-frozen.html'))).digest('hex'),digest);
await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:true,exit,rows,scope:'Native Electron PDF print; OS printer/spooler not exercised; frozen source fixtures unchanged'},null,2));console.log(JSON.stringify({out,ok:true,exit,cases:rows.length},null,2));
