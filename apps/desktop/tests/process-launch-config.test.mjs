import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {optionalIsolatedLaunch,isolationAvailable} from '../src/agents/managed/process-isolation.mjs';
const execute=promisify(execFile);

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-launch-policy-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const cwd=path.join(root,'project'),home=path.join(root,'agent'),external=path.join(root,'external');
  for(const directory of[cwd,home,external])await fs.mkdir(directory);
  const input=path.join(external,'input.txt'),output=path.join(external,'output.txt');
  await fs.writeFile(input,'external authorized source');
  const args=['-e',`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(output)},fs.readFileSync(${JSON.stringify(input)}));`];
  return{cwd,home,input,output,spec:{command:process.execPath,args,cwd,home}};
}

test('ordinary default launch can execute authorized work beyond its project directory',async t=>{
  const {spec,cwd,output}=await fixture(t);
  const {launch}=await optionalIsolatedLaunch(spec);
  await execute(launch.command,launch.args,{cwd,env:{...process.env,...launch.env}});
  assert.equal(await fs.readFile(output,'utf8'),'external authorized source');
});

test('explicit isolated launch does not grant access to undeclared external files',async t=>{
  if(process.platform!=='linux'||!await isolationAvailable()){t.skip('explicit Linux sandbox unavailable');return;}
  const {spec,cwd,output}=await fixture(t);
  const {launch}=await optionalIsolatedLaunch(spec,{probe:async()=>true});
  await assert.rejects(execute(launch.command,launch.args,{cwd,env:{...process.env,...launch.env}}));
  assert.equal(await fs.access(output).then(()=>true,()=>false),false);
});
