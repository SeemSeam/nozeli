import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {startHandoff,writeRuntimeFile} from '../src/agents/handoff.mjs';

const run=promisify(execFile),app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url);
// Plain Node remains an integration prerequisite; Electron qualification is
// explicit, so the default integration suite does not require a GUI runtime.
const variants=[{name:'current-node',command:process.execPath,nodeMode:!!process.versions.electron}];
if(process.env.NOZELI_TEST_HELPER_ELECTRON){
 const electron=process.env.NOZELI_TEST_HELPER_ELECTRON==='1'?require('electron'):process.env.NOZELI_TEST_HELPER_ELECTRON;
 assert(path.isAbsolute(electron));
 variants.push({name:'electron-node',command:electron,nodeMode:true},{name:'electron-app',command:electron,nodeMode:false});
}
for(const variant of variants)test(`${variant.name} helper entries dispatch real document/handoff operations and preserve terminal refusal`,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-helper-entries-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.NODE_PATH;
 if(variant.nodeMode)env.ELECTRON_RUN_AS_NODE='1';
 const invoke=(entry,args=[])=>run(variant.command,[...(variant.name==='electron-app'?['--user-data-dir='+path.join(root,'electron-profile'),'--disk-cache-dir='+path.join(root,'cache')]:[]),path.join(app,'src/agents',entry),...args],{cwd:root,env,windowsHide:true,timeout:20000});
 const requests=[];
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  assert.equal(req.headers.authorization,'Bearer synthetic-document-token');
  requests.push(JSON.parse(Buffer.concat(chunks)));
  res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,value:{text:'real loopback document 中文',version:'synthetic-version'}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();}));
 const documentRuntime=path.join(root,'document.json'),snapshot=path.join(root,'snapshot.json');
 await fs.writeFile(documentRuntime,JSON.stringify({url:`http://127.0.0.1:${server.address().port}/document`,token:'synthetic-document-token'}));
 const read=await invoke('document-entry.cjs',['--runtime',documentRuntime,'--read','sample.md','--out',snapshot]);
 assert.equal(JSON.parse(read.stdout.trim()).ok,true);assert.equal(JSON.parse(await fs.readFile(snapshot)).text,'real loopback document 中文');
 assert.deepEqual(requests,[{op:'read',relPath:'sample.md'}]);
 await assert.rejects(invoke('document-entry.cjs',['--runtime',documentRuntime,'--read','sample.md','--out',snapshot]),error=>{assert.match(error.stderr,/EEXIST/);return true;});
 let sends=0;
 const handoff=await startHandoff(async body=>{sends++;assert.equal(body.text,'synthetic handoff 中文');return {id:body.id,status:'accepted'};});
 t.after(()=>handoff.close());
 const projectId=randomUUID(),grant=handoff.issueGrant({projectId,parentRequestId:'synthetic-parent'}),runtime=path.join(root,'handoff.json'),task=path.join(root,'task.txt');
 await writeRuntimeFile(runtime,{url:handoff.url,token:grant.token,projectId,role:'qa'});await fs.writeFile(task,'synthetic handoff 中文');
 const args=['--runtime',runtime,'--file',task];
 const first=JSON.parse((await invoke('handoff-entry.cjs',args)).stdout.trim());
 const second=JSON.parse((await invoke('handoff-entry.cjs',args)).stdout.trim());
 assert.equal(first.accepted,true);assert.equal(second.accepted,true);assert.equal(second.id,first.id);assert.equal(second.duplicate,true);assert.equal(sends,1);
 await assert.rejects(invoke('system-terminal-entry.cjs'),error=>{assert.match(error.stderr,/Nozeli/);assert.doesNotMatch(error.stderr,/TypeError|commandLine/);assert.equal(error.code,1);return true;});
});
