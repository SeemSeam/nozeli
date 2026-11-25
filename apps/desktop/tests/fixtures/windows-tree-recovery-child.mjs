import {DesktopHost} from '../../src/main/host.mjs';
import {TreeRecovery} from '../../src/main/tree-recovery.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {FileTreeOps} from '../../src/main/file-tree-ops.mjs';
import {createFileTreeIO} from '../../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../../src/platform/windows/desktop-file-tree.mjs';
import {importClipboardFiles} from '../../src/main/file-clipboard-import.mjs';
import {fileIdentity} from '../../src/main/file-clipboard.mjs';
import {windowsClipboardIdentity} from '../../src/platform/windows/clipboard-source.mjs';
const [profile,projectId,id]=process.argv.slice(2),host=new DesktopHost(profile),service=new TreeRecovery(host);
if(id==='copy-stage'){
 const source=process.argv[5],ops=new FileTreeOps(host,{trash:()=>{throw Error('no trash');},io:{...createFileTreeIO(host),...createWindowsDesktopFileTreeIO(host,{beforePublish:()=>process.exit(80)})}});
 await importClipboardFiles(ops,[{source,name:path.basename(source),identity:fileIdentity(await fs.lstat(source)),nativeIdentity:await windowsClipboardIdentity(source)}],{projectId});throw Error('expected stage exit');
}
const page=await host.storage.recoveryPage(projectId,{prefixes:['tree-operation:'],pendingOnly:true,purpose:'recovery-ui'}),row=page.entries.find(row=>row.id===id);
const plan=await service.preview({projectId,id,revision:row.revision,version:page.version},'child-shell');
const put=host.storage.putRecovery.bind(host.storage);
host.storage.putRecovery=async(...args)=>{const result=await put(...args);if(args[1]!==id&&args[2]?.reconciliation)process.exit(79);return result;};
await service.settle({token:plan.token,confirmed:true},'child-shell');throw Error('expected controlled exit');
