import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {managedRuntime,readManagedState} from '../src/agents/managed/managed-storage.mjs';

test('offline todo IPC validates projects, isolates identical IDs and never starts providers',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-todo-ipc-')),host=new DesktopHost(path.join(root,'profile')),storage=host.storage;
 const roots={a:path.join(root,'a'),b:path.join(root,'b')},ids={};for(const [name,dir] of Object.entries(roots)){await fs.mkdir(dir);ids[name]=(await host.pick(dir)).project.id;}
 let opens=0;const m=new ManagedProjects({userDataDir:path.join(root,'profile'),host,legacy:{projects:new Map()},openController:async()=>{opens++;throw Error('provider must not start');}});
 t.after(async()=>{await m.stop();await storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 for(const name of ['a','b']){const projectId=ids[name],s=await Workspace.open(await managedRuntime(storage,projectId),roots[name],{storage,projectId});await s.mutate(()=>s.state.todos.push({id:'same-todo',kind:'system',status:'open',text:'private-'+name}));await s.close();}
 const request={projectId:ids.a,todoId:'same-todo',expectedRevision:0,requestKey:'same-request-key',action:'close',reason:'user dismissal'};
 const result=await m.invoke('managed.todo.manage',request);assert.equal(result.status,'closed');assert.deepEqual(await m.invoke('managed.todo.manage',request),result);
 const read=name=>readManagedState(storage,ids[name]);
 assert.equal((await read('a')).todos[0].status,'closed');assert.equal((await read('b')).todos[0].status,'open');
 await m.invoke('managed.todo.manage',{...request,projectId:ids.b});assert.equal((await read('b')).todos[0].status,'closed');
 await assert.rejects(m.invoke('managed.todo.manage',{...request,projectId:'unknown'}),error=>error.code==='UNKNOWN_PROJECT');
 await assert.rejects(m.invoke('managed.todo.manage',{...request,command:'rm'}),/payload/);
 await assert.rejects(m.invoke('managed.todo.manage',{...request,action:'remove',expectedRevision:0,requestKey:'stale-remove-key'}),e=>e.code==='STALE_TODO');
 const before=await read('a');
 const lock=await Workspace.open(await managedRuntime(storage,ids.a),roots.a,{storage,projectId:ids.a});
 try{await assert.rejects(m.invoke('managed.todo.manage',{...request,action:'remove',expectedRevision:1,requestKey:'locked-remove-key'}));assert.deepEqual(await read('a'),before);}finally{await lock.close();}
 await m.invoke('managed.todo.manage',{...request,action:'remove',expectedRevision:1,requestKey:'remove-todo-key'});
 const removed=await read('a');assert.deepEqual(removed.todos,[]);assert.equal(JSON.stringify(removed.todoTombstones).includes('private-a'),false);assert.equal(opens,0);assert.equal(m.controllers.size,0);
});
