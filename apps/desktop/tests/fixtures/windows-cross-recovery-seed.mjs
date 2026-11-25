import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {DesktopHost} from '../../src/main/host.mjs';
import {FileTreeOps} from '../../src/main/file-tree-ops.mjs';
import {createFileTreeIO} from '../../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../../src/platform/windows/desktop-file-tree.mjs';
import {TreeRecovery} from '../../src/main/tree-recovery.mjs';
const [profile,sourceProjectId,projectId,source,action,mode]=process.argv.slice(2),host=new DesktopHost(profile),target=await host.requireProject(projectId);
const io={...createFileTreeIO(host),...createWindowsDesktopFileTreeIO(host,{beforePublish:()=>{if(mode==='retain')process.exit(81);},directorySync:async parent=>{if(await fs.stat(path.join(target.root,source)).then(()=>true,()=>false)){parent.close();parent.syncDirectory();}else parent.syncDirectory();}})};
await assert.rejects(new FileTreeOps(host,{trash:()=>{},io}).run({projectId,sourceProjectId,source,action}));
if(mode==='registry-retry'){
 const page=await host.storage.recoveryPage(projectId,{prefixes:['tree-operation:'],pendingOnly:true,purpose:'recovery-ui'}),row=page.entries[0],service=new TreeRecovery(host),plan=await service.preview({projectId,id:row.id,revision:row.revision,version:page.version},'seed-shell');
 const put=host.storage.putCrossTreeTransfer.bind(host.storage);host.storage.putCrossTreeTransfer=async(id,value,options)=>{if(value.reconciliation)throw Error('synthetic stop before final common acknowledgement');return put(id,value,options);};
 await assert.rejects(service.settle({token:plan.token,confirmed:true},'seed-shell'));assert.equal((await host.storage.recoveryPage(projectId,{prefixes:['tree-operation:'],pendingOnly:true})).entries.length,1);
}
await host.storage.db.close();console.log('synthetic cross recovery seeded '+mode);
