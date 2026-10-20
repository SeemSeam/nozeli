import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';

// Run against the built renderer and real bundled SuperDoc/Fortune engines.
const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-office-mirrors-')),project=path.join(out,'project');
await fs.mkdir(project);
for(const [name,sample] of [['source.docx','中文 文档.docx'],['source.xlsx','中文 表格.xlsx']])await fs.copyFile(path.join(root,'tests/fixtures/office',sample),path.join(project,name));
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,browser,shell,log='';const checks=[];
const stage=label=>console.log(new Date().toISOString(),out,label);
const bounded=(promise,label,ms=7000)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Deadline: '+label)),ms);})]).finally(()=>clearTimeout(timer));};
async function until(fn,label){const deadline=Date.now()+45000;do{const result=await fn();if(result)return result;await pause(50);}while(Date.now()<deadline);throw Error('Timed out: '+label);}
async function call(page,op,payload={}){const result=await page.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function scoped(predicate){return until(async()=>{for(const page of await browser.pages()){if(!page.url().startsWith('http://127.0.0.1:'))continue;const scope=await page.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&predicate(scope)&&await page.evaluate(()=>window.__nozeliReady===true))return {page,scope};}return null;},'workspace surface');}
async function officeFrame(page,kind){await page.waitForFunction(kind=>{const frame=document.querySelector('#word-host iframe');return kind==='word'?!!frame?.contentWindow?.nozeliWordModels:!!frame?.contentWindow?.nozeliSheetModels;},{timeout:45000},kind);return page.frames().find(frame=>frame.url().endsWith(kind==='word'?'/word-frame.html':'/sheet-frame.html'));}
try{
 stage('starting Electron');
 const ozone=process.env.NOZELI_OZONE||'wayland';
 child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform='+ozone],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:path.join(out,'.Nozeli'),NOZELI_USER_DATA:path.join(out,'.Nozeli','desktop'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:ozone==='headless'?'1':'0'},stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null,protocolTimeout:7000});return true;}catch{return false;}},'debug endpoint');
 shell=(await scoped(scope=>scope.role==='shell')).page;
 if(await shell.$eval('#configuration-setup',node=>node.open))await shell.click('#configuration-cancel');
 await shell.click('#pick-project');await shell.waitForSelector('#file-tree [data-path="source.docx"]');
 stage('project opened');
 for(const [relPath,kind] of [['source.docx','word'],['source.xlsx','sheet']]){
  stage(kind+' opening writer');
  await shell.click('#file-tree [data-path="'+relPath+'"]');
  const owner=await scoped(scope=>scope.role==='surface'&&scope.relPath===relPath&&!scope.readOnly);
  const ownerFrame=await officeFrame(owner.page,kind);
  stage(kind+' writer ready');
  await shell.locator('#workspace-open-editors [data-editor-view="'+owner.scope.viewId+'"]').click({button:'right'});await shell.locator('.nozeli-context-menu:not([hidden]) [data-command="split-x"]').click();
  const mirror=await scoped(scope=>scope.role==='surface'&&scope.relPath===relPath&&scope.readOnly),mirrorFrame=await officeFrame(mirror.page,kind);
  stage(kind+' mirror ready');
  await mirror.page.bringToFront();
  await mirror.page.evaluate(()=>{window.officeMirrorFrame=document.querySelector('#word-host iframe');window.officeDirtyModels=[];nozeli.subscribe('workspace.control',event=>{if(event.type==='document-buffer'&&event.dirty&&event.model!==undefined)officeDirtyModels.push(event.model);});});
  const marker='UNSAVED_SHARED_'+kind+'_'+Date.now();
  if(kind==='word'){
   await mirrorFrame.evaluate(()=>{window.mirrorEditor=nozeliWordEditor.activeEditor;window.mirrorScrollers=[document.scrollingElement,...document.querySelectorAll('*')].filter((node,index,all)=>node&&all.indexOf(node)===index&&node.scrollHeight>node.clientHeight+40&&node.clientHeight>80).map(node=>{node.scrollTop=100;return {node,top:node.scrollTop};});});
   await ownerFrame.evaluate(marker=>nozeliWordEditor.activeEditor.commands.insertContent(marker),marker);
   await mirrorFrame.waitForFunction(marker=>nozeliWordModels.getText().includes(marker),{polling:100,timeout:20000},marker);
   stage('word unsaved model synchronized');
   assert.equal(await mirrorFrame.evaluate(()=>window.mirrorEditor===nozeliWordEditor.activeEditor),true);
   assert.equal(await mirrorFrame.evaluate(()=>nozeliWordEditor.activeEditor.isEditable),false);
   assert.equal(await mirrorFrame.evaluate(()=>mirrorScrollers.length>0&&mirrorScrollers.every(({node,top})=>Math.abs(node.scrollTop-top)<2)),true);
  }else{
   await mirrorFrame.evaluate(()=>{window.mirrorSheet=nozeliSheetEditor.getAllSheets().at(-1).id;nozeliSheetEditor.activateSheet({id:mirrorSheet});});
   stage('sheet active tab requested '+await mirrorFrame.evaluate(()=>JSON.stringify({wanted:mirrorSheet,actual:nozeliSheetEditor.getSheet().id})));
   await until(()=>mirrorFrame.evaluate(()=>nozeliSheetEditor.getSheet().id===mirrorSheet),'mirror independent sheet activation');
   const id=await ownerFrame.evaluate(()=>nozeliSheetEditor.getSheet().id);
   await ownerFrame.evaluate(marker=>nozeliSheetEditor.setCellValue(1,1,marker),marker);
   await mirrorFrame.waitForFunction((id,marker)=>nozeliSheetEditor.getAllSheets().find(sheet=>sheet.id===id)?.data?.[1]?.[1]?.v===marker,{polling:100,timeout:20000},id,marker);
   stage('sheet first model synchronized');
   assert.equal(await mirrorFrame.evaluate(()=>nozeliSheetEditor.getSheet().id===mirrorSheet),true);
   await mirrorFrame.evaluate(()=>{window.mirrorSheetScroll=document.querySelector('.luckysheet-scrollbar-y');mirrorSheetScroll.scrollTop=80;window.mirrorSheetScrollTop=mirrorSheetScroll.scrollTop;});
   const secondMarker=marker+'_SECOND';await ownerFrame.evaluate(marker=>nozeliSheetEditor.setCellValue(2,1,marker),secondMarker);
   await until(()=>mirrorFrame.evaluate((id,marker)=>nozeliSheetEditor.getAllSheets().find(sheet=>sheet.id===id)?.data?.[2]?.[1]?.v===marker,id,secondMarker),'second shared sheet model');
   stage('sheet second model synchronized');
   await mirrorFrame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await mirrorFrame.evaluate(()=>Math.abs(mirrorSheetScroll.scrollTop-mirrorSheetScrollTop)<2),true);
   const editable=await mirrorFrame.evaluate(()=>document.querySelector('#luckysheet-functionbox-cell')?.isContentEditable);
   // Fortune may keep an editable formula div mounted, but its actual allowEdit gate rejects grid typing.
   if(editable){await mirrorFrame.click('#luckysheet-functionbox-cell');await mirror.page.keyboard.type('MIRROR_MUST_NOT_WRITE');await mirror.page.keyboard.press('Enter');}
   assert.equal(await mirrorFrame.evaluate(()=>JSON.stringify(nozeliSheetEditor.getAllSheets()).includes('MIRROR_MUST_NOT_WRITE')),false);
  }
  stage(kind+' readonly and scroll assertions passed');
  await mirror.page.waitForFunction(()=>officeDirtyModels.length>0,{timeout:10000});
  assert.equal(await mirror.page.evaluate(()=>officeMirrorFrame===document.querySelector('#word-host iframe')),true);
  await mirror.page.bringToFront();await bounded(mirror.page.screenshot({path:path.join(out,kind+'-synced-mirror.png')}),kind+' screenshot');
  await fs.writeFile(path.join(out,kind+'-mirror-evidence.json'),JSON.stringify(await mirror.page.evaluate(kind=>({scope:window.__workspaceScope,status:document.querySelector('#save-status').textContent,dirtyModels:officeDirtyModels.length,model:kind==='word'?document.querySelector('#word-host iframe').contentWindow.nozeliWordModels.snapshotModel():document.querySelector('#word-host iframe').contentWindow.nozeliSheetModels.snapshotModel()}),kind),null,2));
  const rejected=await mirror.page.evaluate(({projectId,relPath,kind})=>nozeli.invoke(kind+'.save',{projectId,relPath,bytes:[1,2,3]}),{projectId:owner.scope.projectId,relPath,kind});assert.equal(rejected.ok,false);
  const ownerModel=await ownerFrame.evaluate(kind=>kind==='word'?nozeliWordModels.snapshotModel():nozeliSheetModels.snapshotModel(),kind);
  await shell.locator('#workspace-open-editors [data-editor-view="'+mirror.scope.viewId+'"]').click({button:'right'});await shell.locator('.nozeli-context-menu:not([hidden]) [data-command="close"]').click();
  await until(async()=>!(await call(shell,'workspace.snapshot',{projectId:owner.scope.projectId})).layout.views[mirror.scope.viewId],'mirror closed');
  const after=await ownerFrame.evaluate(kind=>kind==='word'?nozeliWordModels.snapshotModel():nozeliSheetModels.snapshotModel(),kind);
  assert.deepEqual(after,ownerModel);
  stage(kind+' close preserved owner');
  checks.push(kind+': actual unsaved engine model shared, independent read position, no editable mirror, close preserves writer model');
 }
 console.log(JSON.stringify({ok:true,out,checks},null,2));
}catch(error){
 stage('failure '+error.stack);const pages=[];for(const page of await bounded(browser?.pages()||Promise.resolve([]),'diagnostic pages').catch(()=>[])){
  const info=await page.evaluate(async()=>{const frame=document.querySelector('#word-host iframe')?.contentWindow,scope=window.__workspaceScope;return {url:location.href,scope,status:document.querySelector('#save-status')?.textContent,body:document.body.innerText.slice(-3000),dirtyModels:window.officeDirtyModels?.length,word:frame?.nozeliWordModels?.getText(),model:frame?.nozeliWordModels?.snapshotModel(),buffer:scope?.projectId&&scope?.relPath?await nozeli.invoke('workspace.document.snapshot',{projectId:scope.projectId,relPath:scope.relPath}):null};}).catch(error=>({error:error.message}));pages.push(info);
  if(info.scope?.kind==='document')await bounded(page.screenshot({path:path.join(out,'failure-'+info.scope.viewId+'.png')}),'failure screenshot',3000).catch(()=>{});
 }await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,pages},null,2));console.error(out,JSON.stringify(pages.map(({model,buffer,...page})=>({...page,bufferRevision:buffer?.value?.revision})),null,2));throw error;
}finally{await fs.writeFile(path.join(out,'main.log'),log);await browser?.disconnect();if(child&&child.exitCode===null){child.kill('SIGTERM');await pause(1000);if(child.exitCode===null)child.kill('SIGKILL');}}
