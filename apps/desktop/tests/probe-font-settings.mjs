// MINIMAL probe (parent directive): settings → one existing discuss tag →
// exact var/computed/status dump. No full journey, no assertions beyond the
// dump — output is the evidence for the font cascade decision tree.
import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import puppeteer from 'puppeteer-core';import {prepareReading} from './reading-setup.fixture.mjs';
const source=path.resolve(import.meta.dirname,'..');const out=await fs.mkdtemp(path.join(source,'.test-output','probe-font-'));
const project=out+'/project';await fs.mkdir(project);await fs.writeFile(path.join(project,'a.txt'),'A selected original statement for the font probe.\n');
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const env={...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:out+'/.Nozeli',NOZELI_USER_DATA:out+'/.Nozeli/desktop',NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(createRequire(import.meta.url)('electron'),[source+'/src/main/main.cjs','--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
const surface=async predicate=>{for(let i=0;i<150;i++){for(const candidate of await browser.pages()){const scope=await candidate.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&predicate(scope)&&await candidate.evaluate(()=>window.__nozeliReady).catch(()=>false))return candidate;}await new Promise(r=>setTimeout(r,100));}throw Error('surface not found');};
let browser,shell,page;const report={probe:'font-settings',out};
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 shell=await surface(s=>s.role==='shell');await prepareReading(shell);await shell.locator('#pick-project').click();
 await shell.waitForSelector('#file-tree button[data-path="a.txt"]',{visible:true});await shell.click('#file-tree button[data-path="a.txt"]');
 page=await surface(s=>s.role==='surface'&&s.kind==='document'&&s.relPath==='a.txt');await page.waitForFunction(()=>window.__nozeliInput?.text().startsWith('A selected'));
 await page.evaluate(()=>window.__nozeliInput.select(2,10));await page.locator('#selection-discuss').click();await page.waitForSelector('.tag-chat-window .tag-composer .tag-editor');
 report.before=await page.evaluate(()=>({conversationFont:getComputedStyle(document.documentElement).getPropertyValue('--conversation-font'),editorFont:getComputedStyle(document.querySelector('.tag-composer .tag-editor')).fontSize}));
 await shell.bringToFront();await shell.click('#open-settings');
 try{await shell.waitForSelector('select[data-project-reading="conversationFontSize"]',{timeout:8000});}catch{await shell.click('[data-settings-section="settings-project-reading"]');await shell.waitForSelector('select[data-project-reading="conversationFontSize"]',{timeout:10000});}
 await shell.$eval('select[data-project-reading="conversationFontSize"]',node=>{node.value='22';node.dispatchEvent(new Event('change',{bubbles:true}));});
 const status=await shell.waitForFunction(()=>document.body.textContent.includes('已应用并保存到当前项目'),{timeout:10000}).then(()=> '已应用并保存到当前项目').catch(()=>'status-not-shown');
 await shell.keyboard.press('Escape');await page.bringToFront();
 try{await page.waitForFunction(()=>parseFloat(getComputedStyle(document.querySelector('.tag-composer .tag-editor')).fontSize)>14,{timeout:15000});report.applied=true;}catch{report.applied=false;}
 report.after=await page.evaluate(()=>({conversationFont:getComputedStyle(document.documentElement).getPropertyValue('--conversation-font'),editorFont:getComputedStyle(document.querySelector('.tag-composer .tag-editor')).fontSize,editorInline:document.querySelector('.tag-composer .tag-editor')?.style?.cssText??null}));
 report.shellSelect=await shell.evaluate(()=>document.querySelector('select[data-project-reading="conversationFontSize"]')?.value??null);
 report.status=status;report.ok=true;
}catch(error){report.error=String(error&&error.stack||error);report.log=log.slice(-4000);}
finally{await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
