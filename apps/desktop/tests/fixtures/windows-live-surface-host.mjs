import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DesktopHost} from '../../src/main/host.mjs';
import {WorkspaceNative} from '../../src/main/workspace-native.mjs';
import {TreeRecovery} from '../../src/main/tree-recovery.mjs';
import {FileTreeOps} from '../../src/main/file-tree-ops.mjs';
import {createFileTreeIO} from '../../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../../src/platform/windows/desktop-file-tree.mjs';
import {ensureExperimentalPrivateDirectory} from '../../src/platform/windows/experimental-directories.mjs';
import {windowsClipboardSnapshot} from '../../src/platform/windows/clipboard-source.mjs';
import {recoveryHeld} from '../../src/main/workspace-recovery-state.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'},text='活源正文 中文😀\n',owner='synthetic-live-shell:1';
export async function fixture(t,relative='文件.txt'){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-live-recovery-')),profile=path.join(base,'profile'),a=path.join(base,'源'),b=path.join(base,'目标');
  await ensureExperimentalPrivateDirectory(base,profile);for(const dir of [a,b])await fs.mkdir(dir);
  await fs.mkdir(path.dirname(path.join(a,relative)),{recursive:true});await fs.writeFile(path.join(a,relative),text);
  const host=new DesktopHost(profile),source=await host.requireProject((await host.pick(a)).project.id),target=await host.requireProject((await host.pick(b)).project.id),errors=[],messages=[];
  t.after(async()=>{await host.storage.db.close();await fs.rm(base,{recursive:true,force:true});});
  const workspace=new WorkspaceNative({host,origin:'http://synthetic.local/',onError:error=>errors.push(error)});
  workspace.flush=async()=>{};workspace.syncDocument=async()=>()=>{};
  const makeSurface=rel=>{
    const viewId=randomUUID(),wc={id:Math.random(),mainFrame:{url:workspace.origin,parent:null},send:(channel,payload)=>messages.push({viewId,channel,payload})};
    const r={wc,role:'surface',kind:'document',projectId:source.id,relPath:rel,viewId,generation:1,ready:true,dead:false,windowId:'main',documentSource:{type:'project'}};
    workspace.surfaces.set(viewId,r);workspace.senders.set(wc.id,r);workspace.leases.set(workspace.resource(source.id,rel),{viewId,generation:1});
    return r;
  };
  const surface=makeSurface(relative),key=workspace.resource(source.id,relative),buffer={text:'UNSAVED LATE BUFFER',dirty:true,revision:19,sourceViewId:surface.viewId};workspace.buffers.set(key,buffer);
  const shell={wc:{send:(channel,payload)=>messages.push({shell:true,channel,payload})},dead:false};workspace.windows.set('main',shell);
  const service=new TreeRecovery(host,{workspace});
  const run=(action='copy',options={},rel=relative)=>{
    const payload={projectId:target.id,sourceProjectId:source.id,source:rel,action};
    const ops=new FileTreeOps(host,{trash:()=>assert.fail('no trash'),io:{...createFileTreeIO(host),...createWindowsDesktopFileTreeIO(host,options)}});
    return workspace.mutateTreeCross(payload,context=>ops.run(payload,context));
  };
  const published=(rel=relative)=>({directorySync:async parent=>{if(await fs.stat(path.join(b,rel)).then(()=>true,()=>false)){parent.close();parent.syncDirectory();}else parent.syncDirectory();}});
  const aborted=()=>({beforePublish:()=>{throw Object.assign(Error('synthetic unpublished uncertainty'),{commitUnknown:true});}});
  const binding=async()=>{const page=await host.storage.recoveryPage(target.id,{prefixes:['tree-operation:'],pendingOnly:true,purpose:'recovery-ui'}),row=page.entries[0];assert(row);return {projectId:target.id,id:row.id,revision:row.revision,version:page.version};};
  const settle=async()=>service.settle({token:(await service.preview(await binding(),owner)).token,confirmed:true},owner);
  const input=(r=surface)=>({projectId:r.projectId,relPath:r.relPath,operationId:[...r.treeRecoveryHolds.keys()][0]});
  const writeAllowed=(r=surface)=>workspace.authorize({sender:r.wc,senderFrame:r.wc.mainFrame},'file.draft',{projectId:r.projectId,relPath:r.relPath});
  return {base,profile,a,b,host,source,target,workspace,surface,service,messages,errors,key,buffer,run,published,aborted,binding,settle,input,writeAllowed,makeSurface};
}
