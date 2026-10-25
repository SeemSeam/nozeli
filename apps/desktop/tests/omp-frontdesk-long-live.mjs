// Actual Controller + shipped private OMP + delayed loopback provider, no paid model.
// Explicit slow boundary: NOZELI_NATIVE_LONG=1 node --test tests/omp-frontdesk-long-live.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {openTestController} from './project-storage.fixture.mjs'

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const HOLD_MS=165000;
test('actual frontdesk survives an active native response beyond the former 150-second cap',{timeout:240000},async t=>{
  assert.equal(process.env.NOZELI_NATIVE_LONG,'1','Explicit 165-second native boundary opt-in required');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-frontdesk-long-'));
  const privateRoot=path.join(root,'.Nozeli'),source=path.join(privateRoot,'omp'),content=path.join(root,'project');
  await fs.mkdir(source,{recursive:true});await fs.mkdir(content);
  let controller,requests=0,finishedAt=null,requestedAt=null,stopError;
  const timers=new Set();
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
      requests++;JSON.parse(body);requestedAt=Date.now();
      res.writeHead(200,{'content-type':'text/event-stream'});
      const frame=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'frontdesk-long',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})+'\n\n';
      res.write(frame({role:'assistant'}));
      const keepalive=setInterval(()=>res.write(': native long response remains active\n\n'),3000);timers.add(keepalive);
      const timer=setTimeout(()=>{clearInterval(keepalive);timers.delete(keepalive);timers.delete(timer);finishedAt=Date.now();res.write(frame({content:'NATIVE_FRONTDESK_LONG_FINISHED'}));res.write(frame({},'stop'));res.end('data: [DONE]\n\n');},HOLD_MS);timers.add(timer);
      res.once('close',()=>{clearInterval(keepalive);clearTimeout(timer);timers.delete(keepalive);timers.delete(timer);});
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    try{await controller?.stop();}catch(error){stopError=error;}
    for(const timer of timers){clearInterval(timer);clearTimeout(timer);}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await fs.writeFile(path.join(root,'result.json'),JSON.stringify({requests,requestedAt,finishedAt,durationMs:finishedAt&&requestedAt?finishedAt-requestedAt:null,stopError:stopError?{code:stopError.code,message:stopError.message}:null,jobs:controller?.store.state.jobs.map(j=>({id:j.id,status:j.status,error:j.error})),providers:controller?.store.state.providers},null,2));
    if(stopError)throw stopError;
  });
  await fs.writeFile(path.join(source,'models.yml'),`providers:\n  native-long-local:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    auth: none\n    models:\n      - id: scripted\n        input: [text]\n`);
  await fs.writeFile(path.join(source,'config.yml'),'setupVersion: 2\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nmodelRoles:\n  default: native-long-local/scripted\ndefaultThinkingLevel: off\n');
  controller=await openTestController({runtimeRoot:path.join(privateRoot,'desktop','runtime'),contentRoot:content,ompSystemSource:{root:privateRoot,agentDir:source,private:true}});
  await controller.start();
  const thread=controller.store.state.residents.frontdesk.threadId;
  const accepted=await controller.send('frontdesk','Wait for this self-owned native response; no tools or files.',{requestKey:'native-long-frontdesk'});
  const deadline=Date.now()+200000;
  for(;;){
    const job=controller.store.state.jobs.find(job=>job.id===accepted.jobId);
    assert(!['failed','unknown','interrupted'].includes(job?.status),job?.error||'long frontdesk turn interrupted');
    if(job?.status==='completed')break;
    assert(Date.now()<deadline,'native long frontdesk did not complete within its existing bounded session policy');
    await pause(200);
  }
  assert.equal(requests,1,'no replacement request or hidden provider retry');
  assert(finishedAt-requestedAt>=HOLD_MS);
  assert.equal(controller.store.state.jobs.length,1);
  assert.equal(controller.store.state.residents.frontdesk.threadId,thread);
  assert(controller.timeline.messages().some(message=>message.jobId===accepted.jobId&&message.text.includes('NATIVE_FRONTDESK_LONG_FINISHED')));
  await controller.stop();assert.deepEqual(controller.store.state.providers,{});
  t.diagnostic('Actual native long-response evidence: '+root);
});
