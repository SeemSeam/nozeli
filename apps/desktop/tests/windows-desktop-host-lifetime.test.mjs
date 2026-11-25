import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {desktopHosts} from './fixtures/desktop-hosts.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
function move(directory) {
  const result=spawnSync(process.execPath,['-e',"try{require('node:fs').renameSync(process.argv[1],process.argv[1]+'-moved');}catch(error){console.log(error.code);process.exitCode=7;}",directory],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.ifError(result.error);assert.equal(result.signal,null);
  return result;
}

test('all reopened desktop hosts must stop before Windows releases the original selected directory',native,async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-host-lifetime-')),root=path.join(base,'项目 中文'),profile=path.join(base,'profile'),hosts=desktopHosts();
  t.after(async()=>{await hosts.close();await fs.rm(base,{recursive:true,force:true});});
  await fs.mkdir(root);await fs.writeFile(path.join(root,'draft.txt'),'original');
  const first=hosts.create(profile),project=(await first.pick(root)).project;
  const read=await first.readFile(project.id,'draft.txt');
  await first.draft(project.id,'draft.txt',read.digest,'retained unsaved 中文 🧭');
  const reopened=hosts.create(profile);
  assert.equal((await reopened.readFile(project.id,'draft.txt')).draft.text,'retained unsaved 中文 🧭');
  assert.equal(move(root).status,7);
  await first.storage.db.close();
  assert.equal(move(root).status,7,'a second real host still owns the directory');
  await hosts.close();
  const moved=move(root);assert.equal(moved.status,0,moved.stdout+moved.stderr);
  assert.equal(await fs.readFile(path.join(root+'-moved','draft.txt'),'utf8'),'original');
  const profileMoved=move(profile);assert.equal(profileMoved.status,0,profileMoved.stdout+profileMoved.stderr);
});

test('confirmed host shutdown drains an admitted write and preserves its receipt for a new host',native,async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-host-drain-')),root=path.join(base,'project'),profile=path.join(base,'profile'),hosts=desktopHosts(),cold=desktopHosts();
  t.after(async()=>{await hosts.close();await cold.close();await fs.rm(base,{recursive:true,force:true});});
  await fs.mkdir(root);
  const host=hosts.create(profile),project=(await host.pick(root)).project;
  const directory=await host.storage.localDirectory(project.id),file=path.join(directory,'ui.sqlite');
  const write=host.track(host.storage.db.request(file,'put',{collection:'ui',id:'draft',value:{text:'last admitted 中文'},operationId:'lifetime-last-write',expectedRevision:0}));
  const closing=hosts.close();assert.equal(hosts.close(),closing);
  assert.throws(()=>hosts.create(profile),/admission is closed/);
  assert.deepEqual(await write,{revision:1});await closing;
  const reopened=cold.create(profile);
  assert.deepEqual(await reopened.storage.getLocal(project.id,'draft'),{text:'last admitted 中文'});
  assert.deepEqual(await reopened.storage.db.request(file,'receipt',{operationId:'lifetime-last-write'}),{revision:1});
  await assert.rejects(reopened.storage.db.request(file,'put',{collection:'ui',id:'draft',value:'overwrite',operationId:'different-operation',expectedRevision:0}),{code:'STORAGE_CONFLICT'});
  assert.deepEqual(await reopened.storage.getLocal(project.id,'draft'),{text:'last admitted 中文'});
});
