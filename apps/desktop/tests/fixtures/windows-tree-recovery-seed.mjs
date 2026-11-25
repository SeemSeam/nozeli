// Synthetic profile only. Create real recovery states without product IPC hooks.
import fs from 'node:fs/promises';
import path from 'node:path';
import {DesktopHost} from '../../src/main/host.mjs';
import {FileTreeOps} from '../../src/main/file-tree-ops.mjs';
import {createFileTreeIO} from '../../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../../src/platform/windows/desktop-file-tree.mjs';
import {importClipboardFiles} from '../../src/main/file-clipboard-import.mjs';
import {fileIdentity} from '../../src/main/file-clipboard.mjs';
import {windowsClipboardIdentity} from '../../src/platform/windows/clipboard-source.mjs';
const [profile,projectId,source,mode]=process.argv.slice(2),host=new DesktopHost(profile),project=await host.requireProject(projectId),destination=path.join(project.root,path.basename(source));
const options=mode==='retain'?{beforePublish:()=>process.exit(80)}:{directorySync:async parent=>{if(await fs.stat(destination).then(()=>true,()=>false)){parent.close();parent.syncDirectory();}else parent.syncDirectory();}};
const ops=new FileTreeOps(host,{trash:()=>{throw Error('no trash');},io:{...createFileTreeIO(host),...createWindowsDesktopFileTreeIO(host,options)}});
try{
 const result=await importClipboardFiles(ops,[{source,name:path.basename(source),identity:fileIdentity(await fs.lstat(source)),nativeIdentity:await windowsClipboardIdentity(source)}],{projectId});
 if(result.items[0].ok)throw Error('Expected synthetic failure');
 console.log(JSON.stringify({expectedFailure:true,code:result.items[0].code}));
}finally{await host.storage.db.close();}
