import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digestBytes } from '../src/domain/material-store.mjs';
import { DesktopHost } from '../src/main/host.mjs';
import { FileTags } from '../src/domain/file-tags.mjs';

async function scratch() {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'nozeli-host-user-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'nozeli-host-proj-'));
  const host = new DesktopHost(userData);
  return { userData, root, host, async cleanup() { await rm(userData, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); } };
}

async function seed(root, rel, text) {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, text);
  return abs;
}

test('chinese space path, stable identity, list skips hidden links', async () => {
  const fx = await scratch();
  try {
    const rel = '中文 目录/示例 文档.md';
    await seed(fx.root, rel, '原文 标记\n');
    await writeFile(path.join(fx.root, '.secret'), 'hidden');
    const outside = await seed(fx.userData, 'outside.txt', 'owned escape fixture');
    await symlink(outside, path.join(fx.root, '逃逸链接'));
    const opened = await fx.host.pick(fx.root);
    assert.equal(opened.canceled, false);
    const again = await fx.host.pick(fx.root);
    assert.equal(again.project.id, opened.project.id);
    assert.equal(again.project.openedAt, opened.project.openedAt);
    assert.equal((await fx.host.recent()).projects[0].openedAt, opened.project.openedAt);
    const listed = await fx.host.list(opened.project.id);
    assert.equal(listed.entries.some((entry) => entry.relPath === rel), true);
    assert.equal(listed.entries.some((entry) => entry.name.startsWith('.') || entry.name === '逃逸链接'), false);
    const file = await fx.host.readFile(opened.project.id, rel);
    assert.equal(file.text, '原文 标记\n');
    assert.equal(file.materialDigest, digestBytes(Buffer.from('原文 标记\n')));
    await assert.rejects(() => fx.host.readFile(opened.project.id, '../outside.txt'), (error) => error.code === 'ESCAPE' || error.code === 'BAD_PATH');
    await assert.rejects(() => fx.host.readFile(opened.project.id, '逃逸链接'), (error) => error.code === 'ESCAPE' || error.code === 'SYMLINK');
    await symlink(path.join(fx.root, ...rel.split('/')), path.join(fx.root, '内部链接'));
    await assert.rejects(() => fx.host.readFile(opened.project.id, '内部链接'), (error) => error.code === 'SYMLINK');
    await mkdir(path.join(fx.root, '不是文件'));
    await assert.rejects(() => fx.host.readFile(opened.project.id, '不是文件'), (error) => error.code === 'NOT_A_FILE');
  } finally {
    await fx.cleanup();
  }
});

test('consecutive saves, conflict, delete, readonly, and restart keep both sides', async () => {
  const fx = await scratch();
  try {
    const rel = '中文 目录/笔记.md';
    const abs = await seed(fx.root, rel, '基线');
    const projectId = (await fx.host.pick(fx.root)).project.id;
    const first = await fx.host.readFile(projectId, rel);
    const saved = await fx.host.save(projectId, rel, first.digest, '第一次');
    const savedAgain = await fx.host.save(projectId, rel, saved.digest, '第二次更短');
    assert.equal(await readFile(abs, 'utf8'), '第二次更短');
    assert.equal(savedAgain.digest, digestBytes(Buffer.from('第二次更短')));
    assert.equal((await fx.host.storage.readObject(projectId,first.materialDigest)).toString('utf8'),'基线','later saves retain the immutable material consumers use for the original version');
    await writeFile(abs, '外部修改');
    await assert.rejects(() => fx.host.save(projectId, rel, savedAgain.digest, '我的草稿'), (error) => error.code === 'CONFLICT' && error.details.draftKept === true);
    assert.equal(await readFile(abs, 'utf8'), '外部修改');
    const conflicted = await fx.host.readFile(projectId, rel);
    assert.equal(conflicted.draft.text, '我的草稿');
    assert.equal(conflicted.text, '外部修改');
    await unlink(abs);
    await assert.rejects(() => fx.host.save(projectId, rel, conflicted.digest, '删除后的草稿'), (error) => error.code === 'DELETED');
    await assert.rejects(() => access(abs));
    const deleted = await new DesktopHost(fx.userData).readFile(projectId, rel);
    assert.equal(deleted.diskPresent, false);
    assert.equal(deleted.draft.text, '删除后的草稿');
    await writeFile(abs, '只读原文');
    await chmod(abs, 0o444);
    const readonly = await fx.host.readFile(projectId, rel);
    await assert.rejects(() => fx.host.save(projectId, rel, readonly.digest, '不能写'), (error) => error.code === 'READONLY' && error.details.draftKept === true);
    assert.equal(await readFile(abs, 'utf8'), '只读原文');
    await chmod(abs, 0o644);
    const kept = await new DesktopHost(fx.userData).readFile(projectId, rel);
    assert.equal(kept.draft.text, '不能写');
    assert.equal(kept.text, '只读原文');
  } finally {
    await fx.cleanup();
  }
});

test('projects, notes, and view state stay isolated and bound to old material', async () => {
  const fx = await scratch();
  const other = await mkdtemp(path.join(os.tmpdir(), 'nozeli-host-other-'));
  try {
    const rel = 'notes.md';
    await seed(fx.root, rel, '甲项目');
    await seed(other, rel, '乙项目');
    const a = (await fx.host.pick(fx.root)).project.id;
    const b = (await fx.host.pick(other)).project.id;
    assert.notEqual(a, b);
    const file = await fx.host.readFile(a, rel);
    const added = await fx.host.addAnnotation(a, {
      relPath: rel,
      materialDigest: file.materialDigest,
      kind: 'text-selection',
      anchor: { start: 0, end: 1, quote: '甲' },
      note: '只属于甲',
    });
    await fx.host.addAnnotation(a, {
      relPath: rel,
      materialDigest: file.materialDigest,
      kind: 'text-selection',
      anchor: { start: 1, end: 3, quote: '项目' },
      note: '第二条',
    });
    await assert.rejects(() => fx.host.addAnnotation(a, {
      relPath: rel,
      materialDigest: file.materialDigest,
      kind: 'pdf-page',
      anchor: { page: 1, rect: [0, 0, 1, 1] },
      note: '区域',
    }), (error) => error.code === 'INVALID_ANCHOR');
    const otherNotes = await fx.host.listAnnotations(b, rel);
    assert.equal(otherNotes.annotations.length, 0);
    const tags = new FileTags({ storage: fx.host.storage, projectId: a, root: fx.root });
    const before = (await tags.read(rel)).tags.find(tag => tag.id === added.annotation.id);
    const listed = await fx.host.listAnnotations(a, rel);
    await fx.host.removeAnnotation(a, listed.annotations.find(item => item.id !== added.annotation.id).id);
    const after = (await tags.read(rel)).tags.find(tag => tag.id === added.annotation.id);
    assert.deepEqual(after, before);
    assert.equal((await fx.host.listAnnotations(a, rel)).annotations.length, 1);
    const saved = await fx.host.save(a, rel, file.digest, '甲项目已改');
    const bound = await fx.host.listAnnotations(a, rel);
    assert.equal(bound.annotations[0].materialDigest, file.materialDigest);
    assert.equal(bound.annotations[0].anchor.quote, '甲');
    assert.equal(bound.annotations[0].sourceChanged, true);
    assert.notEqual(saved.digest, file.materialDigest);
    await fx.host.writeState(a, { currentRelPath: rel, pdfPage: 3, scrollTop: 12 });
    const restarted = new DesktopHost(fx.userData);
    assert.equal((await restarted.readState(a)).state.currentRelPath, rel);
    assert.equal((await restarted.listAnnotations(b, rel)).annotations.length, 0);
    const moved = `${fx.root}-moved`;
    await rename(fx.root, moved);
    await assert.rejects(() => restarted.open(a), (error) => error.code === 'PROJECT_ROOT_MISSING');
    const reassociated = await restarted.pick(moved);
    assert.notEqual(reassociated.project.id, a);
    await rm(moved, { recursive: true, force: true });
  } finally {
    await fx.cleanup();
    await rm(other, { recursive: true, force: true });
  }
});

test('unsupported project identity and corrupt catalog are preserved without rewriting source files', async () => {
  const fx=await scratch(),clients=[];
  try{
    const file=await seed(fx.root,'kept.txt','untouched source');
    const {project}=await fx.host.pick(fx.root),manifestFile=path.join(fx.root,'.nozeli','project.json');
    const original=JSON.parse(await readFile(manifestFile,'utf8')),unsupported=JSON.stringify({...original,schema:999});
    await writeFile(manifestFile,unsupported);
    await assert.rejects(fx.host.readFile(project.id,'kept.txt'),{code:'PROJECT_METADATA_CONFLICT'});
    assert.equal(await readFile(manifestFile,'utf8'),unsupported);assert.equal(await readFile(file,'utf8'),'untouched source');
    await writeFile(manifestFile,'{');
    const reopened=new DesktopHost(fx.userData);clients.push(reopened);
    await assert.rejects(reopened.readFile(project.id,'kept.txt'),{code:'PROJECT_METADATA_CONFLICT'});
    assert.equal(await readFile(manifestFile,'utf8'),'{');
    await Promise.all([fx.host,...clients].map(host=>host.storage.db.close()));
    const corrupt=Buffer.from('not a SQLite catalog');await writeFile(fx.host.storage.catalog,corrupt);
    const broken=new DesktopHost(fx.userData);clients.push(broken);
    await assert.rejects(broken.recent());
    assert.deepEqual(await readFile(fx.host.storage.catalog),corrupt);assert.equal(await readFile(file,'utf8'),'untouched source');
  }finally{await Promise.all([fx.host,...clients].map(host=>host.storage.db.close()));await fx.cleanup();}
});

test('removing project entry preserves files and state, survives restart and permits re-add or missing directory', async () => {
  const fx=await scratch();
  try {
    const file=await seed(fx.root,'keep.txt','keep');
    const {project}=await fx.host.pick(fx.root);
    const marker=path.join(fx.host.projectDir(project.id),'keep-marker');await writeFile(marker,'state');
    await fx.host.removeProject(project.id);
    assert.equal((await new DesktopHost(fx.userData).recent()).projects.length,0);
    assert.equal(await readFile(file,'utf8'),'keep');assert.equal(await readFile(marker,'utf8'),'state');
    assert.equal((await fx.host.pick(fx.root)).project.id,project.id);
    assert.equal((await fx.host.recent()).projects.length,1);
    await rm(fx.root,{recursive:true});await fx.host.removeProject(project.id);
    assert.equal((await fx.host.recent()).projects.length,0);
  }finally{await fx.cleanup();}
});
