import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopHost } from '../src/main/host.mjs';
import { FileTreeOps } from '../src/main/file-tree-ops.mjs';
import { FileTags } from '../src/domain/file-tags.mjs';
import { treeMenuItems } from '../src/main/file-tree-menu.mjs';
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-tree-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'project'));await fs.mkdir(path.join(root,'trash'));
  const host=new DesktopHost(path.join(root,'profile'));
  const picked=await host.pick(path.join(root,'project'));
  const project=await host.requireProject(picked.project.id);
  const ops=new FileTreeOps(host,{trash:p=>fs.rename(p,path.join(root,'trash',path.basename(p)))});
  return {root:project.root,host,project,ops,run:input=>ops.run({projectId:project.id,...input}),store:new FileTags({storage:host.storage,projectId:project.id,root:project.root})};
}
test('file operations copy/cut/rename/create/trash and no-overwrite',async t=>{
  const f=await fixture(t);await f.run({action:'createFolder',target:'',name:'目录'});
  await f.run({action:'createFile',target:'目录',name:'文件.txt'});await fs.writeFile(path.join(f.root,'目录/文件.txt'),'内容');
  await f.run({action:'copy',source:'目录/文件.txt',target:'目录'});
  assert.equal(await fs.readFile(path.join(f.root,'目录/文件 副本.txt'),'utf8'),'内容');
  await assert.rejects(f.run({action:'rename',source:'目录/文件 副本.txt',name:'文件.txt'}));
  await f.run({action:'cut',source:'目录/文件.txt',target:''});
  await f.run({action:'rename',source:'文件.txt',name:'new.txt'});
  await f.run({action:'trash',source:'new.txt'});
  await assert.rejects(fs.stat(path.join(f.root,'new.txt')));
  await assert.rejects(f.run({action:'cut',source:'目录',target:'目录'}));
  await assert.rejects(f.run({action:'createFile',target:'',name:'../bad'}));
  await assert.rejects(f.run({action:'trash',source:''}));
});
test('directory moves retain tag identity; copies own independent ids',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.root,'src'));await fs.writeFile(path.join(f.root,'src/a.txt'),'hello');
 const id=randomUUID(),fileId=randomUUID();
 await f.store.write('src/a.txt',{file:{fileId},nextOrdinal:2,tags:[{id,ordinal:1,relPath:'src/a.txt',note:'note',anchor:{start:0,end:5,quote:'hello'},materialDigest:'a'.repeat(64)}]});
 await f.run({action:'rename',source:'src',name:'dest'});
 assert.equal((await f.store.read('dest/a.txt')).tags[0].id,id);assert.equal(await f.store.read('src/a.txt'),null);
 await f.run({action:'copy',source:'dest',target:''});
 const copied=await f.store.read('dest 副本/a.txt');assert.notEqual(copied.tags[0].id,id);assert.notEqual(copied.file.fileId,fileId);
 assert.equal(copied.tags[0].note,'note');
});
test('metadata failure and symlink rejection leave original files intact',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'a.txt'),'original');
 await fs.symlink(f.root,path.join(f.root,'link'));
 await assert.rejects(f.run({action:'cut',source:'a.txt',target:'link'}));
 await f.store.write('a.txt',{file:{fileId:randomUUID()},nextOrdinal:1,tags:[]});
 const tagKey=f.store.key('a.txt');
 const projectId=f.project.id;
 await f.host.storage.putProject(projectId,'file_tags',tagKey,'broken');
 await assert.rejects(f.run({action:'rename',source:'a.txt',name:'b.txt'}));
 assert.equal(await f.host.storage.getProject(projectId,'file_tags',tagKey),'broken');
 assert.equal(await fs.readFile(path.join(f.root,'a.txt'),'utf8'),'original');await assert.rejects(fs.stat(path.join(f.root,'b.txt')));
});
test('native menus expose target-specific commands',()=>{
 const file=treeMenuItems({directory:false,root:false,canPaste:false});assert.ok(file.some(x=>x.id==='rename'));assert.ok(file.some(x=>x.id==='openExternal'));assert.ok(!file.some(x=>x.id==='createFile'));assert.equal(file.find(x=>x.id==='paste').enabled,false);
 const root=treeMenuItems({directory:true,root:true,canPaste:true});assert.ok(root.some(x=>x.id==='createFolder'));assert.ok(!root.some(x=>x.id==='trash'));assert.ok(!root.some(x=>x.id==='openExternal'));
});

test('file labels persist with annotations, follow moves/copies and never change source',async t=>{
 const f=await fixture(t),projectId=f.project.id;await fs.mkdir(path.join(f.root,'src'));await fs.writeFile(path.join(f.root,'src/a.txt'),'hello');
 await f.ops.setLabel({projectId,relPath:'src/a.txt',colors:['blue','red'],note:'重点阅读\n<script>literal</script>',expectedRevision:0});
 let labels=(await f.ops.labels({projectId})).labels;assert.deepEqual(labels['src/a.txt'].colors,['red','blue']);
 const file=await f.host.readFile(projectId,'src/a.txt');await f.host.addAnnotation(projectId,{relPath:'src/a.txt',materialDigest:file.materialDigest,kind:'text-selection',anchor:{start:0,end:5,quote:'hello'},note:'正文批注'});
 assert.equal((await f.store.read('src/a.txt')).tags.length,1);assert.equal((await f.ops.labels({projectId})).labels['src/a.txt'].revision,1);
 await f.run({action:'rename',source:'src',name:'renamed'});labels=(await f.ops.labels({projectId})).labels;assert.equal(labels['src/a.txt'],undefined);assert.equal(labels['renamed/a.txt'].note,'重点阅读\n<script>literal</script>');
 await f.run({action:'copy',source:'renamed/a.txt',target:'renamed'});await f.run({action:'cut',source:'renamed/a 副本.txt',target:''});
 const reopened=new FileTreeOps(f.host,{trash:()=>{}});labels=(await reopened.labels({projectId})).labels;assert.equal(labels['a 副本.txt'].note,labels['renamed/a.txt'].note);
 await reopened.setLabel({projectId,relPath:'a 副本.txt',colors:[],note:'',expectedRevision:1});labels=(await reopened.labels({projectId})).labels;assert.deepEqual(labels['a 副本.txt'].colors,[]);assert.deepEqual(labels['renamed/a.txt'].colors,['red','blue']);
 assert.equal(await fs.readFile(path.join(f.root,'renamed/a.txt'),'utf8'),'hello');assert.equal((await f.store.read('a 副本.txt')).tags.length,1);
 const other=await fixture(t);assert.deepEqual(Object.keys((await other.ops.labels({projectId:other.project.id})).labels),[]);
});
test('file-label validation, stale writer and damaged metadata cannot overwrite marks',async t=>{
 const f=await fixture(t),projectId=f.project.id;await fs.writeFile(path.join(f.root,'a.txt'),'original');
 const value={projectId,relPath:'a.txt',colors:['green'],note:'safe',expectedRevision:0};await f.ops.setLabel(value);
 await assert.rejects(f.ops.setLabel({...value,note:'stale'}),/其他操作/);
 for(const patch of [{colors:['invalid']},{colors:['red','red']},{note:'x'.repeat(2001)},{relPath:'../a.txt'},{relPath:''}])await assert.rejects(f.ops.setLabel({...value,expectedRevision:1,...patch}));
 assert.equal((await f.ops.labels({projectId})).labels['a.txt'].note,'safe');
 await f.host.storage.putProject(projectId,'file_tags',f.store.key('a.txt'),'broken');await assert.rejects(f.ops.setLabel({...value,expectedRevision:1}));assert.equal(await f.host.storage.getProject(projectId,'file_tags',f.store.key('a.txt')),'broken');
 await f.ops.view({projectId,closed:['src','src/deep']});assert.deepEqual((await new FileTreeOps(f.host,{trash:()=>{}}).view({projectId})).closed,['src','src/deep']);
 await assert.rejects(f.ops.view({projectId,closed:['../outside']}));
 assert.ok(treeMenuItems({directory:false}).some(i=>i.id==='label'));assert.ok(!treeMenuItems({directory:true}).some(i=>i.id==='label'));
});

test('tree preferences merge under the metadata lock, persist and isolate projects', async t => {
  const f = await fixture(t), projectId = f.project.id;
  await fs.mkdir(path.join(f.root, 'private'));
  await fs.writeFile(path.join(f.root, 'private/data.txt'), 'unchanged');
  await f.ops.view({ projectId, closed: ['private'] });
  await Promise.all([
    f.ops.view({ projectId, hidden: ['private', 'private'] }),
    f.ops.view({ projectId, showHidden: true }),
  ]);
  const reopened = new DesktopHost(f.host.userDataDir);
  const viewOps = new FileTreeOps(reopened, { trash: () => assert.fail('view must not trash') });
  const requestedFields=({closed,hidden,showHidden})=>({closed,hidden,showHidden});
  assert.deepEqual(requestedFields(await viewOps.view({projectId})),{closed:['private'],hidden:['private'],showHidden:true});
  await f.ops.view({ projectId, closed: [] });
  assert.deepEqual(requestedFields(await viewOps.view({projectId})),{closed:[],hidden:['private'],showHidden:true});
  const otherRoot = path.join(path.dirname(f.root), 'other-project');
  await fs.mkdir(otherRoot);
  const other = await f.host.pick(otherRoot);
  assert.deepEqual(requestedFields(await f.ops.view({projectId:other.project.id})),{closed:[],hidden:[],showHidden:false});
  assert.equal(await fs.readFile(path.join(f.root, 'private/data.txt'), 'utf8'), 'unchanged');
  // Hiding is a tree preference, not a file-access permission.
  assert.equal((await f.host.readFile(projectId, 'private/data.txt')).text, 'unchanged');
  const legacyClosed = ['.legacy', 'node_modules', 'volume:folder'];
  await f.ops.view({ projectId, closed: legacyClosed });
  await f.ops.view({ projectId, showHidden: false });
  assert.deepEqual((await viewOps.view({ projectId })).closed, legacyClosed);
  assert.ok((await f.host.list(projectId, { treeView: true })).entries.every(entry => !entry.hidden));
});

test('tree preference validation and metadata failures never overwrite prior values', async t => {
  const f = await fixture(t), projectId = f.project.id;
  await f.ops.view({ projectId, closed: ['folder'], hidden: ['secret'], showHidden: true });
  const original = await f.host.storage.getLocal(projectId, 'file-tree-view');
  for (const rel of ['', '.', '..', '../outside', '/absolute', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'C:/file', 'a\u0000b', '.git', 'a/.secret', 'node_modules', 'a/node_modules/b']) {
    await assert.rejects(f.ops.view({ projectId, hidden: [rel] }));
  }
  for (const hidden of [null, 'file', [42]]) await assert.rejects(f.ops.view({ projectId, hidden }));
  for (const showHidden of [null, 0, 'true']) await assert.rejects(f.ops.view({ projectId, showHidden }));
  await fs.symlink(f.root, path.join(f.root, 'link'));
  await assert.rejects(f.ops.view({ projectId, hidden: ['link/secret'] }));
  assert.deepEqual(await f.host.storage.getLocal(projectId, 'file-tree-view'), original);
  const put = f.host.storage.putLocal;
  f.host.storage.putLocal = async () => { throw Error('controlled metadata failure'); };
  await assert.rejects(f.ops.view({ projectId, hidden: [] }), /controlled metadata failure/);
  f.host.storage.putLocal = put;
  assert.deepEqual(await f.host.storage.getLocal(projectId, 'file-tree-view'), original);
  await f.host.storage.putLocal(projectId, 'file-tree-view', 'broken');
  await assert.rejects(f.ops.view({ projectId, showHidden: false }));
  await assert.rejects(f.host.list(projectId, { treeView: true }));
  assert.equal(await f.host.storage.getLocal(projectId, 'file-tree-view'), 'broken');
  assert.ok(Array.isArray((await f.host.list(projectId)).entries));
});

test('hidden subtrees release the 2000-entry budget without changing ordinary project lists', async t => {
  const f = await fixture(t), projectId = f.project.id;
  await fs.mkdir(path.join(f.root, 'a-visible'));
  await fs.mkdir(path.join(f.root, 'z-hidden'));
  await fs.writeFile(path.join(f.root, 'a-visible/later.txt'), 'later');
  await Promise.all(Array.from({ length: 2100 }, (_, i) => fs.writeFile(path.join(f.root, `z-hidden/item-${String(i).padStart(4, '0')}.txt`), 'hidden')));
  const ordinary = await f.host.list(projectId);
  assert.equal(ordinary.entries.length, 2000);
  assert.equal(ordinary.truncated, true);
  assert.ok(!ordinary.entries.some(entry => entry.relPath === 'a-visible/later.txt'));
  await f.ops.view({ projectId, hidden: ['z-hidden'] });
  const filtered = await f.host.list(projectId, { treeView: true });
  assert.ok(filtered.entries.some(entry => entry.relPath === 'a-visible/later.txt'));
  assert.ok(!filtered.entries.some(entry => entry.relPath.startsWith('z-hidden')));
  assert.equal(filtered.truncated, false);
  assert.deepEqual((await f.host.list(projectId)).entries, ordinary.entries);
  await f.ops.view({ projectId, showHidden: true });
  const shown = await f.host.list(projectId, { treeView: true });
  assert.equal(shown.entries.find(entry => entry.relPath === 'z-hidden').hiddenRoot, true);
  assert.equal(shown.entries.find(entry => entry.relPath === 'z-hidden').hidden, true);
  assert.ok(!shown.entries.some(entry => entry.relPath.startsWith('z-hidden/')));
  assert.equal(shown.hiddenCount, 1);
  await f.ops.view({ projectId, hidden: [] });
  assert.deepEqual((await f.host.list(projectId, { treeView: true })).entries.map(({ relPath }) => relPath), ordinary.entries.map(({ relPath }) => relPath));
});

test('show-hidden appends explicit roots and required ancestors beyond limit and depth safely', async t => {
  const f = await fixture(t), projectId = f.project.id;
  await Promise.all(Array.from({ length: 2001 }, (_, i) => fs.writeFile(path.join(f.root, `a-${String(i).padStart(4, '0')}.txt`), 'visible')));
  const parent = 'z-parent/one/two/three/four/five/six/seven';
  await fs.mkdir(path.join(f.root, parent), { recursive: true });
  await fs.writeFile(path.join(f.root, parent, 'secret.txt'), 'secret');
  await fs.mkdir(path.join(f.root, '.excluded'));
  await fs.mkdir(path.join(f.root, 'node_modules'));
  await fs.symlink(f.root, path.join(f.root, 'z-link'));
  const hidden = [parent + '/secret.txt', 'z-parent', 'z-link'];
  await assert.rejects(f.ops.view({ projectId, hidden }));
  await f.ops.view({ projectId, hidden: hidden.slice(0, 2), showHidden: true });
  const shown = await f.host.list(projectId, { treeView: true });
  assert.equal(shown.entries.filter(entry => !entry.hidden).length, 2000);
  assert.equal(shown.truncated, true);
  for (const relPath of ['z-parent', 'z-parent/one', parent, parent + '/secret.txt']) assert.ok(shown.entries.some(entry => entry.relPath === relPath));
  assert.equal(shown.entries.find(entry => entry.relPath === parent).hidden, true);
  assert.equal(shown.entries.find(entry => entry.relPath === parent).hiddenRoot, false);
  assert.equal(shown.entries.find(entry => entry.relPath === parent + '/secret.txt').hiddenRoot, true);
  assert.ok(!shown.entries.some(entry => entry.relPath.startsWith('.') || entry.relPath.startsWith('node_modules') || entry.relPath.startsWith('z-link')));
  await f.ops.view({ projectId, hidden: [parent + '/secret.txt'] });
  const ancestors = await f.host.list(projectId, { treeView: true });
  assert.equal(ancestors.entries.find(entry => entry.relPath === parent).hidden, false);
  assert.equal(ancestors.entries.find(entry => entry.relPath === parent + '/secret.txt').hidden, true);
});

async function crossFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-cross-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'alpha')); await fs.mkdir(path.join(root, 'beta')); await fs.mkdir(path.join(root, 'trash'));
  const host = new DesktopHost(path.join(root, 'profile'));
  const pickedA = await host.pick(path.join(root, 'alpha')), pickedB = await host.pick(path.join(root, 'beta'));
  const projectA = await host.requireProject(pickedA.project.id), projectB = await host.requireProject(pickedB.project.id);
  const ops = new FileTreeOps(host, { trash: p => fs.rename(p, path.join(root, 'trash', path.basename(p))) });
  const tags = id => new FileTags({ storage: host.storage, projectId: id, root: (id === projectA.id ? projectA : projectB).root });
  return { root, host, projectA, projectB, ops, tags, trash: path.join(root, 'trash'),
    run: input => ops.run({ projectId: projectB.id, ...input }) };
}
for(const moved of [false,true])test('cross-project cut retains destination when trash result is uncertain: '+moved,async t=>{
 const f=await crossFixture(t),source=path.join(f.root,'alpha/keep.txt');await fs.writeFile(source,'KEEP-RECOVERABLE');
 f.ops.trash=async p=>{if(moved)await fs.rename(p,path.join(f.trash,'keep.txt'));throw Error('trash result uncertain');};
 await assert.rejects(f.run({action:'cut',sourceProjectId:f.projectA.id,source:'keep.txt',target:''}),/目标副本已保留/);
 assert.equal(await fs.readFile(path.join(f.root,'beta/keep.txt'),'utf8'),'KEEP-RECOVERABLE');
 assert.equal(await fs.readFile(moved?path.join(f.trash,'keep.txt'):source,'utf8'),'KEEP-RECOVERABLE');
 const recovery=(await f.host.storage.listRecovery(f.projectB.id)).find(row=>row.id.startsWith('tree-operation:'));
 assert.equal(recovery.value.destinationRetained,true);assert.equal(recovery.value.sourceProjectId,f.projectA.id);
});

test('cross-project copy lands with fresh identity and leaves the source unchanged', async t => {
  const f = await crossFixture(t);
  await fs.mkdir(path.join(f.root, 'alpha/docs')); await fs.mkdir(path.join(f.root, 'beta/docs'));
  await fs.writeFile(path.join(f.root, 'alpha/docs/笔记.md'), 'alpha 内容');
  await f.tags(f.projectA.id).write('docs/笔记.md', { file: { fileId: randomUUID() }, nextOrdinal: 1, tags: [] });
  const result = await f.run({ action: 'copy', sourceProjectId: f.projectA.id, source: 'docs/笔记.md', target: 'docs' });
  assert.equal(result.relPath, 'docs/笔记.md'); // same-relative source and destination names
  assert.equal(result.sourceProjectId, f.projectA.id);
  assert.equal(result.from, undefined); assert.equal(result.sourceFrom, undefined);
  assert.equal(await fs.readFile(path.join(f.root, 'beta/docs/笔记.md'), 'utf8'), 'alpha 内容');
  assert.equal(await fs.readFile(path.join(f.root, 'alpha/docs/笔记.md'), 'utf8'), 'alpha 内容');
  assert.equal(await f.tags(f.projectB.id).read('docs/笔记.md'), null); // no metadata copied across projects
  assert.ok(await f.tags(f.projectA.id).read('docs/笔记.md')); // source metadata untouched
});
test('cross-project folder copy is recursive and rejects nested links and project metadata', async t => {
  const f = await crossFixture(t);
  await fs.mkdir(path.join(f.root, 'alpha/资料/inner'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'alpha/资料/inner/深.txt'), '嵌套');
  await fs.writeFile(path.join(f.root, 'alpha/资料/顶.txt'), '顶层');
  const result = await f.run({ action: 'copy', sourceProjectId: f.projectA.id, source: '资料', target: '' });
  assert.equal(result.relPath, '资料');
  assert.equal(await fs.readFile(path.join(f.root, 'beta/资料/inner/深.txt'), 'utf8'), '嵌套');
  assert.equal(await fs.readFile(path.join(f.root, 'beta/资料/顶.txt'), 'utf8'), '顶层');
  assert.equal(await fs.readFile(path.join(f.root, 'alpha/资料/顶.txt'), 'utf8'), '顶层'); // source unchanged
  await fs.symlink(path.join(f.root, 'alpha'), path.join(f.root, 'alpha/资料/linkdir'));
  await assert.rejects(f.run({ action: 'copy', sourceProjectId: f.projectA.id, source: '资料', target: '' }), /符号链接/);
  await fs.rm(path.join(f.root, 'alpha/资料/linkdir'));
  await assert.rejects(fs.stat(path.join(f.root, 'beta/资料/linkdir')));
  await fs.mkdir(path.join(f.root, 'alpha/资料/.git'));
  await assert.rejects(f.run({ action: 'copy', sourceProjectId: f.projectA.id, source: '资料', target: '' }), /元数据/);
  await fs.rm(path.join(f.root, 'alpha/资料/.git'), { recursive: true });
  assert.equal(await fs.readFile(path.join(f.root, 'alpha/资料/顶.txt'), 'utf8'), '顶层');
});
test('cross-project duplicate destination never overwrites', async t => {
  const f = await crossFixture(t);
  await fs.writeFile(path.join(f.root, 'alpha/已有.txt'), '源内容');
  await fs.writeFile(path.join(f.root, 'beta/已有.txt'), '目标原有内容');
  await assert.rejects(f.run({ action: 'copy', sourceProjectId: f.projectA.id, source: '已有.txt', target: '' }), /目标已存在/);
  await assert.rejects(f.run({ action: 'cut', sourceProjectId: f.projectA.id, source: '已有.txt', target: '' }), /目标已存在/);
  assert.equal(await fs.readFile(path.join(f.root, 'beta/已有.txt'), 'utf8'), '目标原有内容');
  assert.equal(await fs.readFile(path.join(f.root, 'alpha/已有.txt'), 'utf8'), '源内容');
  await fs.mkdir(path.join(f.root, 'alpha/目录')); await fs.writeFile(path.join(f.root, 'alpha/目录/a.txt'), 'x');
  await fs.mkdir(path.join(f.root, 'beta/目录')); await fs.writeFile(path.join(f.root, 'beta/目录/b.txt'), '保留');
  await assert.rejects(f.run({ action: 'copy', sourceProjectId: f.projectA.id, source: '目录', target: '' }), /目标已存在/);
  assert.equal(await fs.readFile(path.join(f.root, 'beta/目录/b.txt'), 'utf8'), '保留');
  assert.ok(await fs.readFile(path.join(f.root, 'alpha/目录/a.txt'), 'utf8'));
});
test('cross-project cut is transactional: durable destination before source removal', async t => {
  const f = await crossFixture(t);
  await fs.writeFile(path.join(f.root, 'alpha/单件.txt'), '单独搬移');
  await fs.mkdir(path.join(f.root, 'alpha/move')); await fs.writeFile(path.join(f.root, 'alpha/move/keep.txt'), '搬移内容');
  await f.tags(f.projectA.id).write('move/keep.txt', { file: { fileId: randomUUID() }, nextOrdinal: 1, tags: [] });
  const file = await f.run({ action: 'cut', sourceProjectId: f.projectA.id, source: '单件.txt', target: '' });
  assert.deepEqual([file.sourceFrom, file.moved, file.from], ['单件.txt', true, undefined]);
  assert.equal(await fs.readFile(path.join(f.root, 'beta/单件.txt'), 'utf8'), '单独搬移');
  await assert.rejects(fs.stat(path.join(f.root, 'alpha/单件.txt')));
  assert.ok(await fs.stat(path.join(f.trash, '单件.txt')));
  const folder = await f.run({ action: 'cut', sourceProjectId: f.projectA.id, source: 'move', target: '' });
  assert.equal(folder.relPath, 'move');
  await assert.rejects(fs.stat(path.join(f.root, 'alpha/move')));
  assert.equal(await fs.readFile(path.join(f.root, 'beta/move/keep.txt'), 'utf8'), '搬移内容');
  assert.ok(await f.tags(f.projectA.id).read('move/keep.txt')); // source metadata and recovery kept, never migrated or dropped
  assert.equal(await f.tags(f.projectB.id).read('move/keep.txt'), null); // fresh identity: no source metadata followed the move
  await assert.rejects(f.run({ action: 'cut', sourceProjectId: f.projectA.id, source: 'move', target: '' })); // source is gone already
});
test('cross-project guards: actions, unknown source, dirty drafts, destination metadata', async t => {
  const f = await crossFixture(t);
  await fs.writeFile(path.join(f.root, 'alpha/a.txt'), 'x');
  await assert.rejects(f.run({ action: 'rename', sourceProjectId: f.projectA.id, source: 'a.txt', name: 'b.txt' }), /跨项目/);
  await assert.rejects(f.run({ action: 'trash', sourceProjectId: f.projectA.id, source: 'a.txt' }), /跨项目/);
  await assert.rejects(f.run({ action: 'copy', sourceProjectId: '00000000-0000-0000-0000-000000000000', source: 'a.txt', target: '' }));
  await assert.rejects(f.run({ action: 'copy', sourceProjectId: 42, source: 'a.txt', target: '' }), /跨项目源项目/);
  await f.host.persistDraft(f.projectA.id, 'a.txt', 'a'.repeat(64), '未保存草稿', 'dirty');
  await assert.rejects(f.run({ action: 'copy', sourceProjectId: f.projectA.id, source: 'a.txt', target: '' }), /未保存的草稿/);
  await assert.rejects(f.run({ action: 'cut', sourceProjectId: f.projectA.id, source: 'a.txt', target: '' }), /未保存的草稿/);
  await assert.ok(await fs.readFile(path.join(f.root, 'alpha/a.txt'), 'utf8'));
  await assert.rejects(fs.stat(path.join(f.root, 'beta/a.txt')));
  await f.host.persistDraft(f.projectA.id, 'a.txt', 'a'.repeat(64), '已保存', 'saved');
  await f.tags(f.projectB.id).write('占位.txt', { file: { fileId: randomUUID() }, nextOrdinal: 1, tags: [] });
  await fs.writeFile(path.join(f.root, 'alpha/占位.txt'), 'y');
  await assert.rejects(f.run({ action: 'copy', sourceProjectId: f.projectA.id, source: '占位.txt', target: '' }), /标签恢复资料/);
  await assert.rejects(fs.stat(path.join(f.root, 'beta/占位.txt')));
  await f.run({ action: 'copy', sourceProjectId: f.projectA.id, source: 'a.txt', target: '' }); // settled drafts no longer block
  assert.equal(await fs.readFile(path.join(f.root, 'beta/a.txt'), 'utf8'), 'x');
});
test('explicit same-project sourceProjectId keeps the same-project behavior', async t => {
  const f = await crossFixture(t);
  await fs.writeFile(path.join(f.root, 'beta/同.txt'), '内容');
  await f.run({ action: 'copy', sourceProjectId: f.projectB.id, source: '同.txt', target: '' });
  assert.equal(await fs.readFile(path.join(f.root, 'beta/同 副本.txt'), 'utf8'), '内容');
  assert.equal((await f.run({ action: 'cut', sourceProjectId: f.projectB.id, source: '同.txt', target: '' })).from, '同.txt');
});
