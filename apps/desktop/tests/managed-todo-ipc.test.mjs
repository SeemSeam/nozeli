import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';

test('offline todo IPC validates projects, isolates identical IDs and never starts providers',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-todo-ipc-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const roots={a:path.join(root,'a'),b:path.join(root,'b')};for(const dir of Object.values(roots))await fs.mkdir(dir);
 let opens=0;const m=new ManagedProjects({userDataDir:path.join(root,'profile'),host:{requireProject:async id=>{if(!roots[id])throw Error('unknown project');return {id,root:roots[id]};}},legacy:{projects:new Map()},openController:async()=>{opens++;throw Error('provider must not start');}});
 for(const id of ['a','b']){const s=await Workspace.open(path.join(m.root,id,'runtime'),roots[id]);await s.mutate(()=>s.state.todos.push({id:'same-todo',kind:'system',status:'open',text:'private-'+id}));await s.close();}
 const request={projectId:'a',todoId:'same-todo',expectedRevision:0,requestKey:'same-request-key',action:'close',reason:'user dismissal'};
 const result=await m.invoke('managed.todo.manage',request);assert.equal(result.status,'closed');assert.deepEqual(await m.invoke('managed.todo.manage',request),result);
 const read=async id=>JSON.parse(await fs.readFile(path.join(m.root,id,'runtime/state.json'),'utf8'));
 assert.equal((await read('a')).todos[0].status,'closed');assert.equal((await read('b')).todos[0].status,'open');
 await m.invoke('managed.todo.manage',{...request,projectId:'b'});assert.equal((await read('b')).todos[0].status,'closed');
 await assert.rejects(m.invoke('managed.todo.manage',{...request,projectId:'unknown'}),/unknown project/);
 await assert.rejects(m.invoke('managed.todo.manage',{...request,command:'rm'}),/payload/);
 await assert.rejects(m.invoke('managed.todo.manage',{...request,action:'remove',expectedRevision:0,requestKey:'stale-remove-key'}),e=>e.code==='STALE_TODO');
 const before=await fs.readFile(path.join(m.root,'a','runtime/state.json'),'utf8');
 const lock=await Workspace.open(path.join(m.root,'a','runtime'),roots.a);
 await assert.rejects(m.invoke('managed.todo.manage',{...request,action:'remove',expectedRevision:1,requestKey:'locked-remove-key'}));
 assert.equal(await fs.readFile(path.join(m.root,'a','runtime/state.json'),'utf8'),before);await lock.close();
 await m.invoke('managed.todo.manage',{...request,action:'remove',expectedRevision:1,requestKey:'remove-todo-key'});
 const removed=await read('a');assert.deepEqual(removed.todos,[]);assert.equal(JSON.stringify(removed.todoTombstones).includes('private-a'),false);assert.equal(opens,0);assert.equal(m.controllers.size,0);
});
