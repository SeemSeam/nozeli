import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {stringify} from 'yaml';
const script=path.resolve(import.meta.dirname,'../tools/import-omp-api.mjs');
test('explicit OMP import preserves key/protocol/compat, refuses conflicts and never executes command credentials',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nozeli-omp-import-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const source=path.join(root,'source'),config=path.join(root,'config');await fs.mkdir(source);const key='synthetic-secret-for-import-only';let lists=0;
 const server=http.createServer((req,res)=>{lists++;assert.equal(req.headers.authorization,'Bearer '+key);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'local-model',name:'Local model'}]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const yaml=stringify({providers:{local:{baseUrl:'http://127.0.0.1:'+server.address().port,api:'openai-responses',apiKey:key,compat:{supportsStore:false,supportsReasoningEffort:false}},command:{baseUrl:'http://127.0.0.1:9',api:'openai-responses',apiKey:'!touch '+path.join(root,'MUST_NOT_RUN')}}});await fs.writeFile(path.join(source,'models.yml'),yaml);await fs.writeFile(path.join(source,'config.yml'),stringify({modelRoles:{default:'local/local-model'}}));
 const run=flags=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script,...flags],{env:{...process.env,PI_CODING_AGENT_DIR:source,OMP_PROFILE:'default',PI_PROFILE:'default',NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:path.join(config,'desktop')},stdio:['ignore','pipe','pipe']});let output='';for(const s of [child.stdout,child.stderr])s.on('data',b=>output+=b);child.once('error',reject);child.once('exit',code=>resolve({code,output}));});
 const preview=await run(['--discover','--adopt-default']);assert.equal(preview.code,0,preview.output);assert.equal(preview.output.includes(key),false);await assert.rejects(fs.stat(config),{code:'ENOENT'});
 const applied=await run(['--discover','--adopt-default','--apply']);assert.equal(applied.code,0,applied.output);assert.equal(applied.output.includes(key),false);assert.equal(lists,2);const file=path.join(config,'pi/models.json'),saved=JSON.parse(await fs.readFile(file));assert.equal(saved.providers.local.apiKey,key);assert.equal(saved.providers.local.api,'openai-responses');assert.equal(saved.providers.local.compat.supportsStore,false);assert.equal(saved.providers.local.models[0].id,'local-model');assert.equal(saved.providers.command,undefined);assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal(await fs.readFile(path.join(source,'models.yml'),'utf8'),yaml);await assert.rejects(fs.stat(path.join(root,'MUST_NOT_RUN')),{code:'ENOENT'});
 const defaults=JSON.parse(await fs.readFile(path.join(config,'pi/nozeli-role-defaults.json')));for(const role of ['frontdesk','orchestrator','worker'])assert.equal(defaults.roles[role].model.selector,'local/local-model');
 const existing={...saved,providers:{...saved.providers,local:{...saved.providers.local,apiKey:'existing-private-key'}}};await fs.writeFile(file,JSON.stringify(existing));const before=await fs.readFile(file);const refused=await run(['--discover','--apply']);assert.equal(refused.code,1);assert.equal(refused.output.includes(key),false);assert.equal(refused.output.includes('existing-private-key'),false);assert.deepEqual(await fs.readFile(file),before);
});
