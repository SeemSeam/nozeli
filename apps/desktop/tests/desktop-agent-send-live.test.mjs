import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import assert from 'node:assert/strict';
if(process.env.NOZELI_REAL_CODEX!=='1')throw new Error('Opt in with NOZELI_REAL_CODEX=1; this test sends two bounded prompts to the installed Codex.');
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),pause=ms=>new Promise(r=>setTimeout(r,ms));
const out=await fs.mkdtemp(path.join(root,'.test-output','one-way-terminal-')),project=path.join(out,'project'),profile=path.join(out,'profile');await fs.mkdir(project);await fs.writeFile(path.join(project,'README.md'),'# Isolated native terminal test\n');
const executable = process.env.NOZELI_REAL_CODEX_BIN || await (async()=>{for(const directory of (process.env.PATH||'').split(path.delimiter)){const candidate=path.join(directory,'codex');try{await fs.access(candidate,1);return candidate;}catch{}}throw new Error('No installed Codex executable on PATH');})();
const shellQuote=value=>"'"+value.replaceAll("'", "'\"'\"'")+"'";
const bin=path.join(out,'bin');await fs.mkdir(bin);await fs.writeFile(path.join(bin,'codex'),'#!/bin/sh\nexec '+shellQuote(executable)+' -c check_for_update_on_startup=false "'+String.fromCharCode(36)+'@"\n',{mode:0o700});
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const env={...process.env};for(const k of Object.keys(env))if(/^(CCB_|CODEX_|NOZELI_)/.test(k))delete env[k];Object.assign(env,{PATH:bin+':'+env.PATH,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_TEST_INSTANCE:'1',NOZELI_HIDDEN:'0',NOZELI_OZONE:'wayland'});
const child=spawn(require('electron'),['--ozone-platform=wayland',path.join(root,'src/main/main.cjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});let log='',browser,page;const report={checks:[],errors:[]};child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));await fs.writeFile(path.join(out,'process.json'),JSON.stringify({pid:child.pid,port,profile,project}));
const invoke=(op,payload={})=>page.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});
const screen=role=>page.$eval('[data-provider-role="'+role+'"] .xterm-rows',e=>e.innerText),permission=process.env.NOZELI_COLD_PERMISSION||'full';
try{
 for(let i=0;i<100;i++){try{browser=await require('puppeteer-core').connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{await pause(100);}}assert.ok(browser);page=(await browser.pages())[0];page.on('pageerror',e=>report.errors.push(e.message));
 await page.waitForFunction(()=>window.__nozeliReady===true,{polling:100});await page.click('#pick-project');await page.waitForSelector('#agent-setup[open]');await page.select('#agent-foreground','codex');await page.select('#agent-background','codex');await page.select('#agent-foreground-permission',permission);await page.select('#agent-background-permission',permission);await page.click('#agent-setup-form button[type="submit"]');await page.waitForFunction(()=>!document.querySelector('#agent-setup').open,{polling:100});{ await page.click('#open-settings'); await page.click('[data-settings-section="settings-general"]'); await page.click('#provider-console-toggle'); }
 await page.waitForFunction(()=>document.querySelector('#project-name').textContent!=='未打开项目'&&document.querySelector('#send-message').disabled===false,{polling:100,timeout:30000});
 const id=(await invoke('project.recent')).value.projects[0].id;report.before=(await invoke('agents.status',{projectId:id})).value.roles;assert.ok(Object.values(report.before).every(r=>r.state==='ready'&&!r.callVerified));assert.equal((await invoke('agents.messages',{projectId:id})).value.messages.length,0);
 await page.waitForFunction(()=>document.querySelectorAll('.provider-output[data-terminal-state="attached"]').length===2,{polling:100,timeout:20000});
 await page.waitForFunction(()=>[...document.querySelectorAll('.provider-output .xterm-rows')].length===2&&[...document.querySelectorAll('.provider-output .xterm-rows')].every(e=>e.innerText.includes('OpenAI Codex')&&/Ask Codex|›/.test(e.innerText)),{polling:100,timeout:30000});await pause(800);
 report.coldScreens={qa:await screen('qa'),task:await screen('task')};for(const text of Object.values(report.coldScreens)){assert.match(text,/OpenAI Codex/);assert.doesNotMatch(text,/Update available|Update now|trust this|sign in|list_turns is not supported/i);}
 assert.equal(await page.$$eval('[data-system-terminal]',e=>e.length),0);assert.equal((await invoke('system-terminal.open',{projectId:id,role:'qa'})).ok,false);
 report.bound=(await invoke('agents.status',{projectId:id})).value.roles;assert.notEqual(report.bound.qa.sessionId,report.bound.task.sessionId);assert.equal((await invoke('agents.messages',{projectId:id})).value.messages.length,0);report.checks.push('two real native Codex editors open from zero messages, with no external-terminal route');
 const bindings={};for(const role of ['qa','task']){bindings[role]=(await invoke('terminal.attach',{projectId:id,role,cols:80,rows:24})).value;assert.equal(bindings[role].sessionId,report.bound[role].sessionId);}
 // Bind the unused background native editor before sending into that same session.
 await page.focus('[data-provider-role="task"] .xterm-helper-textarea');
 await page.keyboard.type('Reply exactly BACKGROUND_READY. Do not use tools.',{delay:10});await pause(500);await page.keyboard.press('Enter');
 await page.waitForFunction(async id=>{const r=await window.nozeli.invoke('agents.status',{projectId:id});return r.value.roles.task.callVerified&&!r.value.roles.task.busy;},{polling:250,timeout:90000},id);
 const beforeReports=(await invoke('agents.reports',{projectId:id})).value.reports.length;
 const task='In the current project directory, create sent-result.txt containing exactly NOZELI_ONE_WAY_OK. Do not modify any other file. Finish with NOZELI_BACKGROUND_DONE.';
 await fs.writeFile(path.join(project,'send-task.txt'),task);
 const prompt='Use the fixed Nozeli handoff command from your developer instructions to send the existing task file '+path.join(project,'send-task.txt')+' to the background once. Do not perform that task yourself. Run the submission command synchronously, inspect its accepted:true receipt, then reply exactly FOREGROUND_SENT. Never wait for background execution or read its output. If submission fails report the error instead.';
 await page.focus('[data-provider-role="qa"] .xterm-helper-textarea');await page.keyboard.type(prompt,{delay:3});await pause(500);await page.keyboard.press('Enter');
 await page.waitForFunction(async id=>{const r=await window.nozeli.invoke('agents.messages',{projectId:id});return r.value.messages.some(m=>m.role==='qa'&&m.text.includes('FOREGROUND_SENT'));},{polling:250,timeout:120000},id);
 const receipt=JSON.parse(await fs.readFile(path.join(project,'send-task.txt.nozeli-send.json'),'utf8'));
 for(let i=0;i<360;i++){try{if((await fs.readFile(path.join(project,'sent-result.txt'),'utf8')).trim()==='NOZELI_ONE_WAY_OK')break;}catch{}await pause(250);}
 assert.equal((await fs.readFile(path.join(project,'sent-result.txt'),'utf8')).trim(),'NOZELI_ONE_WAY_OK');
 await page.waitForFunction(async id=>{const r=await window.nozeli.invoke('agents.status',{projectId:id});return !r.value.roles.task.busy;},{polling:250,timeout:90000},id);
 assert.equal((await invoke('agents.reports',{projectId:id})).value.reports.length,beforeReports);
 const messages=(await invoke('agents.messages',{projectId:id})).value.messages;
 assert.equal(messages.filter(m=>m.role==='qa'&&m.text.includes('FOREGROUND_SENT')).length,1);
 assert.equal(messages.some(m=>m.text.includes('NOZELI_BACKGROUND_DONE')),false);
 const logs=JSON.parse(await fs.readFile(path.join(profile,'nozeli','v1','projects',id,'agent-log.json'),'utf8'));
 const sent=logs.requests.find(r=>r.id===receipt.id);assert.ok(sent.oneWay);assert.match(sent.parentRequestId,/^native:/);report.sentRequest={id:sent.id,parentRequestId:sent.parentRequestId,sourceSessionId:sent.sourceSessionId,status:sent.status};
 report.receipt=receipt;report.screens={qa:await screen('qa'),task:await screen('task')};
 report.checks.push('native foreground real shell sends through Electron client; background native session writes fixture in project cwd');
 report.checks.push('background output stays in terminal; no foreground reply or extra report');
 await page.screenshot({path:path.join(out,'one-way-dual.png')});
 void invoke('session.requestClose').catch(()=>{});assert.deepEqual(await Promise.race([exited,pause(12000).then(()=>null)]),{code:0,signal:null});report.ok=true;
}catch(e){report.ok=false;report.error=e.stack;if(page&&!page.isClosed()){report.screens={qa:await screen('qa').catch(()=>''),task:await screen('task').catch(()=>'')};await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}}
finally{await browser?.disconnect().catch(()=>{});if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(2000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,checks:report.checks,error:report.error,errors:report.errors},null,2));process.exitCode=report.ok?0:1;}
