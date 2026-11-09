import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';

// Browser assertions cross the process boundary as observations; Node's real
// strict assertions remain the oracle. No renderer, React root or DOM is mocked.
export async function startReviewDOM(directory){
 const root=path.resolve(import.meta.dirname,'..');
 await build({absWorkingDir:root,stdin:{resolveDir:root,sourcefile:'review-dom-entry.mjs',contents:`
 import {mountManagedReview,flushManagedReviews,applyManagedReviewBarrier} from './src/renderer/managed-review.mjs';
 import './src/renderer/styles.css';
 import './src/renderer/managed-review.css';
 import './src/renderer/review-discussion.css';
 window.nozeli={subscribe:()=>()=>{}};
 window.all=root=>[root,...[...root.children].flatMap(all)];
 window.by=root=>key=>all(root).find(node=>Object.hasOwn(node.dataset,key));
 window.review={workId:'work-a',objectId:'publication-a',revision:1,reviewVersion:'token-a',status:'waiting',files:[{relPath:'same.md',change:'modified',candidateText:'worker',baselineText:'source',candidateDigest:'candidate',baselineDigest:'baseline',added:2,deleted:1,draft:null}],capabilities:{canAccept:true,canContinue:true},candidate:{targetRef:'refs/heads/topic'}};
 window.flushManagedReviews=flushManagedReviews;window.applyManagedReviewBarrier=applyManagedReviewBarrier;
 window.reviewReading=(entries=[],deltas=[])=>({taskFrame:{version:1,entries,deltas,hasMore:false,nextCursor:null},taskState:{works:[{id:'work-a',name:'Fixed task',sourceJob:'root',revision:1,status:'review',result:{objectId:'publication-a'}}],jobs:[{id:'root',type:'intake',target:'orchestrator',status:'completed'},{id:'round-a',type:'review-discussion',target:'work-a',status:'completed'},{id:'round-b',type:'review-discussion',target:'work-a',status:'completed'}],receipts:[],todos:[],agents:[]},latestObjectId:'publication-a',active:false,queued:0,canSend:true,reasons:[]});
 window.paintReview=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 window.report=(t,{value=structuredClone(review),handle,options={}}={})=>{
  const calls=[],root=document.createElement('section'),opinions={text:'',revision:0},views=new Map();document.body.append(root);
  const invoke=async(op,payload)=>{calls.push([op,payload]);if(handle){const result=await handle(op,payload);if(result)return result;}
   if(op==='managed.review.read')return {ok:true,value};
   if(op==='managed.review.discussion.read')return {ok:true,value:{taskFrame:{version:1,entries:[],deltas:[],hasMore:false,nextCursor:null},taskState:{works:[],jobs:[],receipts:[],todos:[],agents:[]},latestObjectId:payload.objectId,active:false,queued:0,canSend:!['running','ended'].includes(value.status)&&!value.stale&&Boolean(value.reviewVersion),reasons:[]}};
   if(op==='managed.review.instruction.read')return {ok:true,value:{...opinions}};
   if(op==='managed.review.instruction.save'){if(payload.expectedRevision!==opinions.revision)throw Error('unexpected fixture CAS');opinions.text=payload.text;opinions.revision++;return {ok:true,value:{...opinions}};}
   if(op==='workspace.displayView.read'){const id=payload.projectId+':'+JSON.stringify(payload.key);return {ok:true,value:{key:payload.key,state:views.get(id)??null}};}
   if(op==='workspace.displayView.write'){const id=payload.projectId+':'+JSON.stringify(payload.key),current=views.get(id);if(current&&current.revision!==payload.expectedRevision)return {ok:true,value:{conflict:true,current}};const next={...payload.next,revision:(current?.revision??-1)+1};views.set(id,next);return {ok:true,value:{revision:next.revision}};}
   if(op.startsWith('workspace.reviewDiscussion.'))return {ok:true,value:{saved:true}};
   throw Error('unexpected '+op);
  };
  const surface=mountManagedReview(root,{invoke,projectId:'p',workId:'work-a',objectId:'publication-a',confirm:async()=>true,...options});return {surface,calls,root,opinions};
 };
 window.runReviewCase=async source=>{
  localStorage.clear();const observations=[];
  window.assert={equal(actual,expected,message){observations.push({method:'equal',actual:Object.is(actual,expected),expected:true,message:message||String(actual)+' !== '+String(expected)});},deepEqual(actual,expected,message){observations.push({method:'deepEqual',actual,expected,message});},ok(actual,message){observations.push({method:'equal',actual:Boolean(actual),expected:true,message});},match(actual,pattern,message){observations.push({method:'equal',actual:pattern.test(actual),expected:true,message:message||String(actual)+' does not match '+pattern});},async rejects(promise,expected){let error;try{await promise;}catch(failure){error=failure;}observations.push({method:'equal',actual:Boolean(error),expected:true,message:'expected rejection'});if(expected&&error)for(const [field,value] of Object.entries(expected))observations.push({method:'equal',actual:error[field],expected:value,message:'rejection '+field});}};
  await (0,eval)('('+source+')')({});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return observations;
 };
 `},bundle:true,format:'iife',platform:'browser',outfile:path.join(directory,'review-dom.js'),loader:{'.css':'css','.ttf':'file','.woff':'file','.woff2':'file'},logLevel:'silent'});
 await fs.writeFile(path.join(directory,'review-dom.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="review-dom.css"><script src="review-dom.js"></script>');
 await fs.writeFile(path.join(directory,'review-dom.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:true,width:1024,height:768,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.webContents.on('will-prevent-unload',event=>event.preventDefault());win.loadFile(${JSON.stringify(path.join(directory,'review-dom.html'))});});app.on('window-all-closed',()=>app.quit());`);
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 const child=spawn(createRequire(import.meta.url)('electron'),[path.join(directory,'review-dom.cjs'),'--remote-debugging-port='+port,'--ozone-platform='+(process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':'headless')),'--user-data-dir='+path.join(directory,'review-profile')],{cwd:root,env:{...process.env},stdio:['ignore','pipe','pipe']});
 let log='',browser;for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 try{for(let attempt=0;attempt<150;attempt++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await new Promise(resolve=>setTimeout(resolve,100));}}
  assert(browser,'Review DOM Electron endpoint unavailable: '+log);
  const target=await browser.waitForTarget(target=>target.type()==='page'&&target.url().endsWith('/review-dom.html'));const page=await target.page();
  return {async run(fn,viewport={width:1024,height:768}){await page.setViewport(viewport);await page.goto(pathToFileURL(path.join(directory,'review-dom.html')).href);await page.waitForFunction(()=>window.runReviewCase);const observations=await page.evaluate(source=>runReviewCase(source),fn.toString());for(const observation of observations)assert[observation.method](observation.actual,observation.expected,observation.message);},async close(){await browser.disconnect();child.kill('SIGTERM');await exited;}};
 }catch(error){await browser?.disconnect();child.kill('SIGTERM');await exited;throw error;}
}
