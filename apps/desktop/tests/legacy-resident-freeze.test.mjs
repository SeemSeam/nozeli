import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Controller} from '../src/agents/managed/controller.mjs';import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {managedRuntime,readManagedState} from '../src/agents/managed/managed-storage.mjs';
import {writeTestState} from './project-storage.fixture.mjs';
test('legacy resident archive remains frozen as new Pi messages arrive and reads without provider connection',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-legacy-freeze-')),project=path.join(root,'project');await fs.mkdir(project);const host=new DesktopHost(root),projectId=(await host.pick(project)).project.id,runtime=await managedRuntime(host.storage,projectId);
 const c=await Controller.open({projectId,storage:host.storage,runtimeRoot:runtime,contentRoot:project});
 await c.store.mutate(()=>{delete c.store.state.piHostCutover;c.store.state.residents.frontdesk={provider:'codex',threadId:'legacy-thread'};c.store.state.messages.push({id:'old-message',target:'frontdesk',speaker:'agent',text:'Frozen legacy answer'});});await c.initializeBindings();
 await c.store.mutate(()=>c.store.state.messages.push({id:'new-message',target:'frontdesk',speaker:'agent',text:'New Pi answer must not enter old archive'}));await c.stop();
 const managed=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()},openController:async()=>{throw Error('No model connection allowed');}});t.after(async()=>{await managed.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 const page=await managed.invoke('managed.resident.history',{projectId,role:'frontdesk',archiveId:'codex'});assert.match(page.text,/Frozen legacy answer/);assert.doesNotMatch(page.text,/New OMP/);const version=page.version;
 const state=await readManagedState(host.storage,projectId);state.messages.push({id:'even-newer',target:'frontdesk',speaker:'agent',text:'Later Pi output'});await writeTestState(c.store,state);
 const same=await managed.invoke('managed.resident.history',{projectId,role:'frontdesk',archiveId:'codex',version});assert.equal(same.version,version);assert.equal(same.text,page.text);assert.equal(managed.controllers.size,0);
});
