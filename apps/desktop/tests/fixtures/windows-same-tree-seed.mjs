// Independent synthetic fault seeding; the original product entry has no fault IPC.
import fs from 'node:fs/promises';
import path from 'node:path';
import {DesktopHost} from '../../src/main/host.mjs';
import {FileTreeOps} from '../../src/main/file-tree-ops.mjs';
import {createFileTreeIO} from '../../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../../src/platform/windows/desktop-file-tree.mjs';
const [profile,id,mode]=process.argv.slice(2),host=new DesktopHost(profile),p=await host.requireProject(id);
try{
 const action=mode==='create'?'createFile':mode==='directory'?'createFolder':'rename',source=mode==='conflict'?'冲突.txt':'原文件.txt',destination=action==='rename'?(mode==='conflict'?'冲突新名.txt':'改名.txt'):(mode==='create'?'新建.txt':'新目录');
 if(action==='rename'){
  const read=await host.readFile(id,source);await host.addAnnotation(id,{relPath:source,materialDigest:read.materialDigest,kind:'text-selection',anchor:{start:0,end:4,quote:'BODY'},note:'SAME TREE NOTE'});await host.draft(id,source,read.digest,'RETAINED SAME TREE DRAFT');
 }
 const ops=new FileTreeOps(host,{trash:()=>{throw Error('no trash');},io:{...createFileTreeIO(host),...createWindowsDesktopFileTreeIO(host,{directorySync:parent=>{if(requireExists(path.join(p.root,destination)))parent.close();parent.syncDirectory();}})}});
 try{await ops.run({projectId:id,action,source,name:destination});throw Error('synthetic fault not reached');}catch(error){if(!error.committed)throw error;console.log(JSON.stringify({expectedFailure:true,operationId:error.details.operationId,destination}));}
}finally{await host.storage.db.close();}
import {existsSync as requireExists} from 'node:fs';
