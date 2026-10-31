import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {PiSettingsWorker} from '../src/agents/managed/pi-auth.mjs';
import {ProviderSettings} from '../src/agents/managed/provider-settings.mjs';
import {serve,prepare} from './pi-provider.fixture.mjs';

const png='data:image/png;base64,'+(await fs.readFile(new URL('../assets/brand/nozeli-small-icon.png',import.meta.url))).toString('base64');

test('Pi image transport and exact session resume retain original journal without model replay',{timeout:90000},async t=>{
 const provider=await serve(request=>{
  const image=request.messages.flatMap(row=>Array.isArray(row.content)?row.content:[]).find(block=>block.type==='image_url');
  assert.equal(image?.image_url?.url,png);
  return {text:'Image attachment received through the local protocol.'};
 });
 t.after(()=>provider.close());
 const dirs=await prepare(provider.url),spec={...dirs,role:'frontdesk',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[]};
 let session=new PiSession(spec);
 t.diagnostic('Image evidence: '+dirs.root);
 t.after(async()=>{try{await session.stop();}finally{await provider.close();await fs.writeFile(path.join(dirs.root,'image-evidence.json'),JSON.stringify({requests:provider.requests,errors:provider.errors.map(error=>error.message)},null,2));}});
 await session.start();const threadId=session.threadId;
 const answer=await session.prompt('Inspect the explicitly attached region.',{images:[png],job:{id:'pi-image-request',target:'frontdesk',type:'front'}});
 assert.equal(answer.text,'Image attachment received through the local protocol.');
 const journal=await fs.readFile(session.sessionFile,'utf8'),file=session.sessionFile;
 assert.ok(journal.includes('image/png'));await session.stop();
 session=new PiSession(spec);await session.preflightToolsDigest(session.toolsDigest);await session.start(threadId);
 assert.equal(session.threadId,threadId);assert.equal(session.sessionFile,file);assert.equal(provider.requests.length,1);assert.equal(await fs.readFile(file,'utf8'),journal);assert.deepEqual(provider.errors,[]);
 t.diagnostic('Image/resume evidence: '+dirs.root);
});

test('Pi cancellation aborts an in-flight provider before a native write is admitted',{timeout:90000},async t=>{
 let requested,release;
 const entered=new Promise(resolve=>requested=resolve),gate=new Promise(resolve=>release=resolve);
 const provider=await serve(async()=>{requested();await gate;return {tool:'write',id:'cancelled-write',args:{path:'must-not-exist.txt',content:'not authorized after cancel'}};});
 t.after(()=>provider.close());
 const dirs=await prepare(provider.url),facts=[],entries=[];
 const session=new PiSession({...dirs,role:'worker',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[],onTransportFact:fact=>facts.push(fact),onNativeEntry:fact=>entries.push(fact)});
 t.after(async()=>{release();try{await session.stop();}finally{await provider.close();await fs.writeFile(path.join(dirs.root,'cancel-evidence.json'),JSON.stringify({facts,entries,requests:provider.requests},null,2));}});
 await session.start();const pending=session.prompt('Cancelled before receiving a native tool call.',{job:{id:'pi-cancel-request',target:'worker',revision:1,type:'work'}});pending.catch(()=>{});
 await entered;await session.interrupt();release();
 const result=await pending;
 assert.equal(result.providerStatus,'cancelled');assert.notEqual(result.completion,'provider-completed');
 await assert.rejects(fs.stat(path.join(dirs.cwd,'must-not-exist.txt')),{code:'ENOENT'});
 assert.equal(entries.some(fact=>fact.entry?.message?.role==='toolResult'),false);
 assert.equal((await session.stop()).confirmationComplete,true);
 t.diagnostic('Cancellation evidence: '+dirs.root);
});

test('real Pi settings persist supported API protocols privately and cancelled OAuth chooser has no background owner',{timeout:90000},async t=>{
 const dirs=await prepare('http://127.0.0.1:1/v1');await fs.rm(path.join(dirs.agentDir,'models.json'));
 const source={root:dirs.root,agentDir:dirs.agentDir};
 const worker=new PiSettingsWorker({source,runtime:{command:process.execPath,args:[path.resolve(import.meta.dirname,'../../../integrations/pi/src/owner.mjs')],env:{PATH:process.env.PATH,NOZELI_PI_HOME:dirs.agentDir}}});
 const settings=new ProviderSettings({source,worker});
 t.after(()=>settings.stop());
 for(const [index,api]of ['openai-completions','openai-responses','anthropic-messages'].entries())await settings.saveApi({operation:'create',provider:'private-source-'+index,baseUrl:'http://127.0.0.1:1/v1',api,models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret-'+index}});
 const stored=JSON.parse(await fs.readFile(path.join(dirs.agentDir,'models.json'),'utf8'));
 assert.deepEqual(Object.values(stored.providers).map(row=>row.api).sort(),['anthropic-messages','openai-completions','openai-responses']);
 if(process.platform!=='win32')assert.equal((await fs.stat(path.join(dirs.agentDir,'models.json'))).mode&0o777,0o600);
 const status=await settings.status();assert.equal(status.sources.length,3);assert.equal(JSON.stringify(status).includes('local-nonsecret-'),false);
 let interaction;worker.events.on('interaction',value=>{interaction=value;});
 const login=await settings.startLogin({});
 const deadline=Date.now()+15000;while(!interaction&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
 assert.equal(interaction?.kind,'select');assert.ok(interaction.options.some(row=>row.id==='openai-codex'));
 await settings.cancelLogin({id:login.id});assert.equal(settings.loginStatus().state,'cancelled');assert.equal(worker.running,false);
 assert.equal((await settings.status()).sources.length,3,'settings worker can reopen without losing private sources');
 t.diagnostic('Settings evidence: '+dirs.root);
});

test('Pi host projection failure preserves the native journal and holds the input without replay',{timeout:90000},async t=>{
 const provider=await serve(()=>({text:'Original response must remain in the native journal.'}));
 t.after(()=>provider.close());
 const dirs=await prepare(provider.url),facts=[];
 const spec={...dirs,role:'frontdesk',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[],onTransportFact:fact=>facts.push(fact),onNativeEntry:async fact=>{if(fact.jobId)throw Object.assign(Error('Injected host projection storage failure'),{code:'ENOSPC'});}};
 let session=new PiSession(spec);
 t.after(async()=>{try{await session.stop();}catch(error){if(error.code!=='PI_PERSISTENCE_UNCONFIRMED'||session.lastExitReceipt?.confirmationComplete!==true)throw error;}});
 await session.start();
 await assert.rejects(session.prompt('Accepted original input must never replay.',{job:{id:'pi-projection-failed',target:'frontdesk',type:'front'}}),{code:'ENOSPC'});
 const original=await fs.readFile(session.sessionFile,'utf8'),threadId=session.threadId;
 assert.ok(original.includes('Original response must remain in the native journal.'));
 assert.ok(facts.some(fact=>fact.status==='unknown'));
 await assert.rejects(session.stop(),error=>error.code==='PI_PERSISTENCE_UNCONFIRMED'&&error.exitReceipt?.confirmationComplete===true);
 session=new PiSession({...spec,onNativeEntry:async()=>{}});
 await session.preflightToolsDigest(session.toolsDigest);await session.start(threadId);
 assert.equal(provider.requests.length,1);
 assert.equal(session.threadId,threadId);assert.equal(await fs.readFile(session.sessionFile,'utf8'),original);
 t.diagnostic('Projection failure evidence: '+dirs.root);
});

for(const mode of ['killed-owner','closed-host-pipes'])test('Pi native detached command is reaped after '+mode,{timeout:90000},async t=>{
 const program="require('node:fs').writeFileSync('native-child.pid',String(process.pid));setInterval(()=>{},1000)";
 const command=JSON.stringify(process.execPath)+' -e '+JSON.stringify(program);
 const provider=await serve(()=>({tool:'bash',id:'real-detached-command',args:{command}}));
 t.after(()=>provider.close());
 const dirs=await prepare(provider.url),session=new PiSession({...dirs,role:'worker',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[]});
 t.after(()=>session.stop());
 await session.start();
 const pending=session.prompt('Run the isolated native lifetime probe.',{job:{id:'pi-death-'+mode,target:'worker',revision:1,type:'work'}});pending.catch(()=>{});
 const file=path.join(dirs.cwd,'native-child.pid'),deadline=Date.now()+15000;
 let nativePid;
 while(Date.now()<deadline&&!nativePid){try{nativePid=Number(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}if(!nativePid)await new Promise(resolve=>setTimeout(resolve,25));}
 assert.ok(Number.isInteger(nativePid)&&nativePid>0,'actual native command must have started before the owner/host death');
 if(mode==='killed-owner')process.kill(session.pid,'SIGKILL');
 else{session.child.stdout.destroy();session.child.stdin.end();}
 await session.exitPromise;
 await assert.rejects(pending,{code:'PI_RUNTIME_EXITED'});
 const receipt=await session.stop();assert.equal(receipt.confirmationComplete,true);
 const {processStamp}=await import('../src/agents/managed/process-ownership.mjs');
 assert.equal(await processStamp(nativePid),null,'detached native PID cannot outlive a confirmed owner exit');
 assert.equal(provider.requests.length,1);
 t.diagnostic('Native process death evidence: '+dirs.root);
});

test('Pi model controls acknowledge native clamped effort instead of the requested tier',{timeout:90000},async t=>{
 const dirs=await prepare('http://127.0.0.1:1/v1');
 const spec={...dirs,role:'frontdesk',piRuntime:{agentDir:dirs.agentDir},model:'local-fixture/scripted',tools:[]};let session=new PiSession(spec);
 t.after(()=>session.stop());await session.start();
 await session.applyDefaultModel({selector:'local-fixture/scripted',effort:'high'});
 assert.equal(session.model,'local-fixture/scripted');assert.equal(session.effort,'off');assert.equal(session.effective.effort,'off');
 const threadId=session.threadId;await session.stop();session=new PiSession(spec);await session.preflightToolsDigest(session.toolsDigest);await session.start(threadId);
 assert.equal(session.threadId,threadId);assert.equal(session.effort,'off');
});
