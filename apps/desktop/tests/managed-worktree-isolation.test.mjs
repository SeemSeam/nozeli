import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isolatedLaunch} from '../src/agents/managed/process-isolation.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';

const exec=promisify(execFile);
test('Worker can edit its files but cannot rewrite Git identity, shared refs or user/other Work files',{skip:process.platform!=='linux'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-worktree-isolation-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const project=path.join(root,'project'),worker=path.join(root,'worker'),other=path.join(root,'other'),home=path.join(root,'home');
 await fs.mkdir(project);await fs.mkdir(other);await fs.writeFile(path.join(other,'private.txt'),'other Work');await fs.writeFile(path.join(project,'user.txt'),'user bytes');
 const git=async(cwd,...args)=>(await runGit(cwd,args)).toString().trim();
 await git(project,'init','-q','-b','main');await git(project,'add','user.txt');await runGit(project,['-c','user.name=Nozeli Test','-c','user.email=isolation@example.invalid','commit','-qm','baseline']);await git(project,'worktree','add','-q','-b','owned-work',worker);
 const pointer=await fs.readFile(path.join(worker,'.git')),head=await git(project,'rev-parse','main');await fs.symlink(path.join(project,'user.txt'),path.join(worker,'escape'));
 const script=`const fs=require('node:fs');const [cwd,project,other]=process.argv.slice(1);const denied=[];for(const file of [cwd+'/.git',project+'/.git/refs/heads/main',project+'/user.txt',other+'/private.txt',cwd+'/escape']){try{fs.writeFileSync(file,'CORRUPTED');denied.push({file,denied:false});}catch(error){denied.push({file,denied:['EROFS','EACCES','EPERM'].includes(error.code)});}}fs.writeFileSync(cwd+'/worker-result.txt','isolated candidate');console.log(JSON.stringify(denied));`;
 const launch=await isolatedLaunch({command:process.execPath,args:['-e',script,worker,project,other],home,cwd:worker,writable:[worker],readOnly:[path.join(worker,'.git')]});
 const result=await exec(launch.command,launch.args,{cwd:worker,env:{...process.env,...launch.env}});const writes=JSON.parse(result.stdout);
 assert.equal(writes.length,5);assert(writes.every(row=>row.denied),'every original/metadata/cross-work write must fail');
 assert.equal(await fs.readFile(path.join(worker,'worker-result.txt'),'utf8'),'isolated candidate');assert.deepEqual(await fs.readFile(path.join(worker,'.git')),pointer);assert.equal(await git(project,'rev-parse','main'),head);assert.equal(await fs.readFile(path.join(project,'user.txt'),'utf8'),'user bytes');assert.equal(await fs.readFile(path.join(other,'private.txt'),'utf8'),'other Work');
});
