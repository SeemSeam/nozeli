import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DesktopHost} from '../src/main/host.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {WorkChanges} from '../src/agents/managed/work-changes.mjs';

const exec = promisify(execFile);
export async function git(cwd, args) {
  const {stdout} = await exec('git', ['-c','user.name=Frozen Workflow Fixture','-c','user.email=frozen@example.invalid',...args], {cwd, maxBuffer:16*1024*1024});
  return stdout.trim();
}

// Synthetic host/native history, not a model run. Both sides are actual commits;
// the production capture, archive projection, IPC, React and reader consume them.
export async function prepareFrozenWorkflow(out) {
  const configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop');
  const project=path.join(out,'project-a'),other=path.join(out,'project-b'),worker=path.join(out,'worker');
  await fs.mkdir(project,{recursive:true});await fs.mkdir(other);
  const source=Array.from({length:240},(_,i)=>`Reading line ${i}: retained local material.\n`).join('');
  const relPath='retained change.txt';
  await fs.writeFile(path.join(project,'reading.txt'),source);
  await fs.writeFile(path.join(project,relPath),'Committed input from the real Git object.\n');
  await fs.writeFile(path.join(other,'other.txt'),'Independent second project.\n');
  await git(project,['init','--initial-branch=main']);await git(project,['add','.']);await git(project,['commit','-m','fixture input']);
  await fs.appendFile(path.join(project,'.git','info','exclude'),'\n.nozeli/\n');
  const inputCommit=await git(project,['rev-parse','HEAD']);
  await git(project,['worktree','add','-b','fixture-candidate',worker,inputCommit]);
  await fs.writeFile(path.join(worker,relPath),'Committed candidate retained independently.\n');
  await fs.writeFile(path.join(worker,'binary.bin'),Buffer.from([0,255,1,0]));
  await git(worker,['add','.']);await git(worker,['commit','-m','fixture candidate']);
  const candidateCommit=await git(worker,['rev-parse','HEAD']);
  const host=new DesktopHost(profile);
  const a=await host.registerDirectory(project),b=await host.registerDirectory(other);
  await host.writeState(a.id,{workspace:{draft:'Preloaded main draft — never send'}});
  const runtimeRoot=path.join(profile,'nozeli','managed-v1',a.id,'runtime');
  const c=await Controller.open({projectId:a.id,runtimeRoot,contentRoot:project});
  let binding,receipt,work,jobId='fixture-worker-job';
  try {
    work=await c.store.submit('Fixture retained Git result','Read-only product consumer evidence',{name:'Retained Git Worker'});
    await c.store.activate(work.id);
    await c.store.mutate(()=>c.store.state.jobs.push({id:jobId,target:work.id,revision:1,type:'work',status:'completed',text:'Preloaded independent no-model history',context:{},collabAttempts:[{requestId:'fixture-request-0001',sessionId:'fixture-native-history',epoch:'fixture-native-history#0',kind:'prompt',status:'settled'}],completedAt:new Date().toISOString()}));
    binding=await c.changes.capture({projectId:a.id,workId:work.id,revision:1,jobId,receiptId:'fixture-result-receipt',repo:project,commonDir:await fs.realpath(path.join(project,'.git')),inputCommit,candidateCommit});
    assert.equal(binding.verified,true);
    receipt=await c.store.publish(work.id,1,'result','Fixture result backed by retained real Git commits.','fixture-result-receipt',{jobId,changeSetId:binding.changeSetId});
    await c.recordNativeEntries(work.id,{sessionId:'fixture-native-history',epoch:'fixture-native-history#0',jobId,requestId:'fixture-request-0001',entry:{type:'message',id:'fixture-worker-answer',message:{role:'assistant',content:[{type:'text',text:Array.from({length:500},(_,i)=>`Preloaded Worker history ${i}; this is not a model execution.`).join('\n')}]}}});
    await c.store.mutate(()=>{const w=c.store.find(work.id);w.status='ended';w.endedAt=new Date().toISOString();w.closure={phase:'complete',decision:'discard',revision:1};c.store.state.drafts.frontdesk='Preloaded main draft — never send';for(const todo of c.store.state.todos)todo.status='resolved';});
  } finally {await c.stop();}
  await fs.writeFile(path.join(path.dirname(runtimeRoot),'binding.json'),JSON.stringify({schema:1,enabled:true,roles:{frontdesk:{provider:'omp'},orchestrator:{provider:'omp'},worker:{provider:'omp'}}}));
  const changes=new WorkChanges(runtimeRoot),files=(await changes.list({changeSetId:binding.changeSetId})).files;
  const file=files.find(file=>file.path===relPath);assert(file);
  return {out,configRoot,profile,project,other,worker,a,b,runtimeRoot,source,relPath,inputCommit,candidateCommit,workId:work.id,jobId,receiptId:receipt.id,changeSetId:binding.changeSetId,fileId:file.fileId,
    async removeWorktree(){
      await git(project,['worktree','remove','--force',worker]);await git(project,['branch','-D','fixture-candidate']);
      await git(project,['reflog','expire','--expire=now','--all']);await git(project,['gc','--prune=now']);
      await assert.rejects(git(project,['cat-file','-e',candidateCommit]));
      assert.equal((await changes.verify(binding.changeSetId)).verified,true);
    }};
}
