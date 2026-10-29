// Child phase uses only modules and executables from the selected candidate.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [bundle,root,phase]=process.argv.slice(2),app=path.join(bundle,'Contents/Resources/app');
const load=relative=>import(pathToFileURL(path.join(app,relative)));
const {DesktopHost}=await load('src/main/host.mjs'),{ManagedProjects}=await load('src/agents/managed-projects.mjs'),{resolveBundledOmpRuntime}=await load('src/agents/managed/omp-runtime.mjs'),{processStamp}=await load('src/agents/managed/process-ownership.mjs'),{auditRuntime}=await load('src/agents/managed/runtime-audit.mjs');
const host=new DesktopHost(path.join(root,'profile')),project=path.join(root,'project'),seed=path.join(root,'seed'),id=(await host.pick(project)).project.id;
const m=new ManagedProjects({userDataDir:path.join(root,'profile'),host,legacy:{projects:new Map(),connectFlight:new Map()},ompCommand:(await resolveBundledOmpRuntime({appRoot:app})).command,ompSystemSource:{private:true,root,agentDir:seed}});
const wait=async fn=>{const end=Date.now()+60000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('phase timed out');};
let result;
try{
 await m.setActiveProject(id);await m.connect(id,{enable:true});const c=m.controllers.get(id),prior=await fs.readFile(path.join(root,'last-phase.json'),'utf8').then(JSON.parse).catch(()=>null);
 if(prior){
  assert.equal(id,prior.id);assert.equal(c.store.state.residents.frontdesk.threadId,prior.thread);assert.equal(c.store.state.jobs.length,prior.jobs);assert.equal(c.store.state.drafts.frontdesk,prior.draft);
  const notes=(await host.listAnnotations(id,'source.txt')).annotations;for(const note of prior.notes){const actual=notes.find(n=>n.id===note.id);assert.equal(actual.materialDigest,note.materialDigest);assert.deepEqual(actual.anchor,note.anchor);assert((await host.storage.readObject(id,note.materialDigest)).length);}
  assert.equal((await host.readFile(id,'draft.txt')).draft.text,prior.editorDraft);
  const work=c.store.find(prior.workId);assert(work.execution.candidate);assert.equal(await fs.readFile(path.join(c.execution.directory(work.id),'candidate.txt'),'utf8'),'CANDIDATE_A');
 }
 const before=await host.readFile(id,'source.txt');await host.addAnnotation(id,{relPath:'source.txt',materialDigest:before.materialDigest,kind:'text-selection',anchor:{start:0,end:8,quote:'Original'},note:'NOTE_'+phase});
 await host.save(id,'source.txt',before.digest,before.text+'Saved by '+phase+'\n');const draftFile=await host.readFile(id,'draft.txt'),editorDraft='UNSAVED_EDITOR_'+phase;await host.draft(id,'draft.txt',draftFile.digest,editorDraft);
 const reply=await c.send('frontdesk','Synthetic upgrade phase '+phase+'. Reply only.',{requestKey:'upgrade-'+phase});await wait(()=>c.store.state.jobs.find(j=>j.id===reply.jobId)?.status==='completed'&&!c.running.size);
 const draft='UNSENT_CONVERSATION_'+phase;await c.setDraft('frontdesk',draft);
 let workId=prior?.workId;
 if(!workId){const submitted=await c.store.submit('Synthetic retained candidate','Upgrade recovery fixture');workId=submitted.id;await c.store.activate(workId,{initialize:w=>{w.binding=structuredClone(c.store.state.bindings.worker);}});const work=c.store.find(workId);await c.execution.prepare(workId);await fs.writeFile(path.join(c.execution.directory(workId),'candidate.txt'),'CANDIDATE_A');await c.execution.publish(work,{id:'fixture-publish'},()=>true);await c.store.publish(workId,work.revision,'result','<!doctype html><html><head><title>Synthetic report</title></head><body><p>Retained candidate A</p></body></html>','report',{jobId:'fixture-publish',files:[{relPath:'candidate.txt'}]});await c.store.settle(workId);}
 const owners=[];for(const session of c.sessions.values())if(session.pid)owners.push({pid:session.pid,stamp:await processStamp(session.pid)});
 result={phase,bundle,id,thread:c.store.state.residents.frontdesk.threadId,jobs:c.store.state.jobs.length,draft,editorDraft,workId,notes:(await host.listAnnotations(id,'source.txt')).annotations.map(({id,materialDigest,anchor})=>({id,materialDigest,anchor})),runtimeRoot:c.store.root,owners,content:await fs.readFile(path.join(project,'source.txt'),'utf8')};
 await m.stop();for(const owner of owners)assert.notEqual(await processStamp(owner.pid),owner.stamp);const audit=await auditRuntime(c.store.root);assert.equal(audit.processes.length,0);assert.equal(audit.authCopies.length,0);result.audit={...audit,unverifiedCount:audit.unverified.length,unverified:audit.unverified.slice(0,5)};result.stopEvidence='all fixture-owned OMP identities exited after successful controller stop; phase process/SQLite workers exit before parent copies data; global ownership scan uncertainty remains explicit';
 await host.settled();await fs.writeFile(path.join(root,'last-phase.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await m.stop();await host.storage.db.close();}
