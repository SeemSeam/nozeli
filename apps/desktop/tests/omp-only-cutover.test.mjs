import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AgentRuntime} from '../src/agents/runtime.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-cutover-'));const cleanups=[];t.after(async()=>{for(const cleanup of cleanups)await cleanup();await fs.rm(root,{recursive:true,force:true});});const project=path.join(root,'project');await fs.mkdir(project);return {root,project,cleanups};}
test('legacy archive reads preserve accepted requests, reports and exact on-disk bytes without a launcher',async t=>{
 const {root,project}=await fixture(t),id=createHash('sha256').update(project).digest('hex'),folder=path.join(root,'nozeli','v1','projects',id);await fs.mkdir(folder,{recursive:true});
 const record={schemaVersion:1,requests:[{id:'accepted',role:'task',text:'Do not replay',status:'running'}],messages:[{id:'message',text:'historical answer'}],reports:[{id:'report',text:'original report',status:'completed'}]};const bytes=JSON.stringify(record);await fs.writeFile(path.join(folder,'agent-log.json'),bytes);
 const runtime=new AgentRuntime({userDataDir:root});await runtime.bootstrap(id);assert.equal((await runtime.console(id)).messages[0].text,'historical answer');assert.equal(runtime.work(id)[0].status,'running');assert.equal((await runtime.readReport(id,'report')).text,'original report');
 for(const call of [()=>runtime.connect({id,root:project}),()=>runtime.send({projectId:id,text:'new input'}),()=>runtime.retry(id,'qa'),()=>runtime.saveSettings({}),()=>runtime.terminalAdapter(id,'qa')])assert.throws(call,{code:'LEGACY_RUNTIME_READ_ONLY'});
 assert.equal(await fs.readFile(path.join(folder,'agent-log.json'),'utf8'),bytes);assert.equal(runtime.busy(),false);
});
test('managed Codex identities archive once, never reach OMP, and require explicit context recovery',async t=>{
 const {root,project,cleanups}=await fixture(t),options={runtimeRoot:path.join(root,'runtime'),contentRoot:project};let controller=await Controller.open(options);cleanups.push(()=>controller.stop());const work=await controller.store.submit('retain worktree and reports','brief');await controller.store.activate(work.id);
 await controller.store.mutate(()=>{const s=controller.store.state;delete s.ompOnlyCutover;s.bindings.frontdesk.provider='codex';s.bindings.worker.provider='codex';s.residents.frontdesk={threadId:'codex-resident',provider:'codex'};Object.assign(s.works[0],{threadId:'codex-work',binding:{...structuredClone(s.bindings.worker)},status:'review'});s.drafts[work.id]='saved user draft';s.messages.push({id:'historical',target:work.id,text:'original evidence'});});await controller.stop();
 controller=await Controller.open(options);const state=controller.store.state;assert.equal(state.residentArchive.frontdesk.codex.threadId,'codex-resident');assert.equal(state.residents.frontdesk,undefined);assert.equal(state.bindings.frontdesk.provider,'omp');assert.equal(state.works[0].readOnly,true);assert.equal(state.works[0].threadId,'codex-work');assert.equal(state.drafts[work.id],'saved user draft');
 await assert.rejects(controller.makeSession(work.id),{code:'HISTORICAL_SESSION_READ_ONLY'});await assert.rejects(controller.send(work.id,'not a resume'),{code:'HISTORICAL_SESSION_READ_ONLY'});await assert.rejects(controller.setBinding('worker',{provider:'codex'}),{code:'BACKEND_UNSUPPORTED'});
 await assert.rejects(controller.recoverWorkerContext(work.id,{revision:1,oldThreadId:'codex-work',confirmed:false}),/confirmation/);
 const result=await controller.recoverWorkerContext(work.id,{revision:1,oldThreadId:'codex-work',confirmed:true});assert.equal(result.automaticReplay,false);assert.equal(state.works[0].binding.provider,'omp');assert.equal(state.works[0].threadId,undefined);assert.equal(state.works[0].threadArchive[0].threadId,'codex-work');assert.equal(state.works[0].threadArchive[0].provider,'codex');assert.equal(state.drafts[work.id],'saved user draft');assert.equal(state.jobs.length,0);const archive=await controller.readWorkerArchive(work.id,{archiveId:result.archiveId});assert.match(archive.text,/original evidence/);assert.equal(archive.readOnly,true);
});
test('managed RPC rejects backend selectors before opening any controller',async t=>{
 const {root,project}=await fixture(t);const manager=new ManagedProjects({userDataDir:root,host:{requireProject:async()=>({root:project})},legacy:{projects:new Map()},openController:()=>{throw Error('must not execute');}});
 for(const provider of ['omp','codex','claude'])await assert.rejects(manager.invoke('managed.enable',{projectId:'p',provider}),/payload/);
 await assert.rejects(manager.invoke('managed.binding',{projectId:'p',role:'worker',provider:'omp'}),/payload/);assert.equal(manager.controllers.size,0);
});
