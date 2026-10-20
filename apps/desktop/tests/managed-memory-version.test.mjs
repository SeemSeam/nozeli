import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {MemoryVersion} from '../src/agents/managed/memory-version.mjs';
import {memoryContext,ContextReader} from '../src/agents/managed/context-reader.mjs';
test('linked topic byte changes, deletion and recreation invalidate without changing the root',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-memory-version-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'topics'));await fs.writeFile(path.join(root,'plan-tree.md'),'# Memory\n[topic](topics/topic.md)');await fs.writeFile(path.join(root,'topics/topic.md'),'# Topic\nfirst');
 const m=new MemoryVersion(root),first=await m.snapshot();assert.equal((await m.snapshot()).version,first.version);
 await fs.writeFile(path.join(root,'topics/topic.md'),'# Topic\nother');const changed=await m.snapshot();assert.notEqual(changed.version,first.version);assert.equal(changed.root.digest,first.root.digest);
 const reader=new ContextReader(),found=memoryContext(changed.root.text,'other',reader,changed.topics);const page=reader.read(found.matches[0].readRef);assert.equal(page.source,'memory/topics/topic.md');assert.match(page.text,/other/);
 await fs.unlink(path.join(root,'topics/topic.md'));const removed=await m.snapshot();assert.notEqual(removed.version,changed.version);assert.equal(removed.topics[0].digest,null);
 await fs.writeFile(path.join(root,'topics/topic.md'),'# Topic\nother');assert.equal((await m.snapshot()).version,changed.version);
 await fs.symlink('/dev/null',path.join(root,'topics/bad.md'));await fs.appendFile(path.join(root,'plan-tree.md'),'\n[bad](topics/bad.md)');await assert.rejects(m.snapshot(),/普通文件/);
 await fs.unlink(path.join(root,'topics/bad.md'));await fs.writeFile(path.join(root,'plan-tree.md'),first.root.text);assert.equal((await m.snapshot()).version,changed.version,'failed read cannot poison next content version');
});
