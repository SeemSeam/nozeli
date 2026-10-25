import {openTestController,openTestWorkspace} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Controller,isExplicitWorkCancellation} from '../src/agents/managed/controller.mjs';

test('named cancellation accepts trailing no-Git constraints but rejects questions, conditions and retraction',()=>{
 for(const text of ['取消任务“Alpha”。不要Git提交。','请取消 Alpha；保留候选，不要写项目文件','取消 Alpha\n不要提交Git'])assert.equal(isExplicitWorkCancellation(text,'Alpha'),true,text);
 for(const text of ['Alpha是不是应该取消？','如果可以请取消 Alpha','不要取消 Alpha','取消 Alpha？不要Git提交。','取消 Alpha。不要真的取消','取消 Alpha。do not cancel Alpha','请说明情况。取消 Alpha','取消 Beta。然后核对 Alpha'])assert.equal(isExplicitWorkCancellation(text,'Alpha'),false,text);
});

test('cancellation prose never chooses accept or discard on the user behalf',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-cancel-scope-'));const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project')});t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});
 const a=await c.store.submit('task A','brief',{name:'Alpha'});const accepted=await c.enqueue('orchestrator','intake','取消任务“Alpha”。保留未认可候选；不要Git提交。');const job=c.store.state.jobs.find(j=>j.id===accepted.jobId);
 await assert.rejects(c.manageIntake(job,{action:'cancel',workName:'Alpha',text:'user cancelled'}),/明确选择接受或丢弃/);assert.equal(c.store.find(a.id).status,'queued');assert.equal(c.store.find(a.id).outcome,undefined);
});
