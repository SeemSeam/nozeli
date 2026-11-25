import fs from 'node:fs/promises';
import {DesktopHost} from '../../src/main/host.mjs';
import {WorkspaceNative} from '../../src/main/workspace-native.mjs';
import {TreeRecovery} from '../../src/main/tree-recovery.mjs';
import {recoveryHeld} from '../../src/main/workspace-recovery-state.mjs';
import {FileTreeOps} from '../../src/main/file-tree-ops.mjs';
import {createFileTreeIO} from '../../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../../src/platform/windows/desktop-file-tree.mjs';

const [inputPath,outputPath]=process.argv.slice(2),input=JSON.parse(await fs.readFile(inputPath,'utf8'));
const host=new DesktopHost(input.profile),messages=[],errors=[];
const workspace=new WorkspaceNative({host,origin:'http://synthetic.local/',onError:error=>errors.push({code:error.code,message:error.message})});
new TreeRecovery(host,{workspace});
const wc={id:1,mainFrame:{url:workspace.origin,parent:null},send:(channel,payload)=>messages.push({channel,payload})};
const r={wc,role:'surface',kind:'document',projectId:input.projectId,relPath:input.relative,viewId:input.viewId,generation:1,ready:true,dead:false,windowId:'main',documentSource:{type:'project'},treeRecoveryLoaded:false};
workspace.surfaces.set(r.viewId,r);workspace.senders.set(wc.id,r);
workspace.windows.set('main',{dead:false,wc:{send:(channel,payload)=>messages.push({shell:true,channel,payload})}});
workspace.leases.set(workspace.resource(r.projectId,r.relPath),{viewId:r.viewId,generation:r.generation});
let output;
try{
  if(input.mutate){
    workspace.flush=async()=>{};workspace.syncDocument=async()=>()=>{};
    workspace.buffers.set(workspace.resourceOfRecord(r),{text:'CRASH RETAINED INPUT',dirty:true,sourceViewId:r.viewId});
    const ops=new FileTreeOps(host,{trash:()=>{throw Error('no trash');},io:{...createFileTreeIO(host),...createWindowsDesktopFileTreeIO(host,{beforePublish:async()=>{
      await fs.writeFile(outputPath,JSON.stringify({ready:true,pid:process.pid}));
      await new Promise(()=>{setInterval(()=>{},1000);});
    }})}});
    const payload={projectId:input.targetId,sourceProjectId:r.projectId,source:r.relPath,action:'cut'};
    await workspace.mutateTreeCross(payload,context=>ops.run(payload,context));
    throw Error('fixture should have been terminated at its native checkpoint');
  }
  await workspace.layout(input.projectId);
  const bootstrap=await workspace.invoke(r,'workspace.bootstrap');
  const request={projectId:r.projectId,relPath:r.relPath};
  const before=await workspace.readDocument(r,request);
  let exported;try{exported=await workspace.documentExportRead(r,request);}catch(error){exported={error:{code:error.code,message:error.message}};}
  const snapshot=await workspace.invoke(r,'workspace.document.snapshot',request);
  let writeCode=null;try{workspace.authorize({sender:wc,senderFrame:wc.mainFrame},'file.draft',request);}catch(error){writeCode=error.code;}
  let actionError=null;
  if(input.action)try{
    const operationId=[...r.treeRecoveryHolds.keys()][0];
    await workspace.invoke(r,'workspace.resumeTreeSource',{...request,operationId});
    if(input.action==='destination')await workspace.invoke(r,'workspace.openTreeDestination',{...request,operationId});
  }catch(error){actionError={code:error.code,message:error.message};}
  output={ok:true,pid:process.pid,bootstrap,before,exported,snapshot,held:recoveryHeld(r),state:workspace.treeRecovery.current(r),writeCode,actionError,messages,errors};
}catch(error){output={ok:false,pid:process.pid,error:{code:error.code,message:error.message},held:!!r.held};process.exitCode=1;}
finally{await host.settled();await host.storage.db.close();}
await fs.writeFile(outputPath,JSON.stringify(output,null,2)+'\n');
