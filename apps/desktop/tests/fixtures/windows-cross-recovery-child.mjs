import {DesktopHost} from '../../src/main/host.mjs';
import {FileTreeOps} from '../../src/main/file-tree-ops.mjs';
import {createFileTreeIO} from '../../src/main/file-tree-io.mjs';
import {createWindowsDesktopFileTreeIO} from '../../src/platform/windows/desktop-file-tree.mjs';
import {TreeRecovery} from '../../src/main/tree-recovery.mjs';
const [profile,sourceProjectId,projectId,action,source,checkpoint]=process.argv.slice(2),host=new DesktopHost(profile);
if(action==='settle'){
 const page=await host.storage.recoveryPage(projectId,{prefixes:['tree-operation:'],pendingOnly:true,purpose:'recovery-ui'}),row=page.entries[0],service=new TreeRecovery(host),plan=await service.preview({projectId,id:row.id,revision:row.revision,version:page.version},'child-shell');
 const put=host.storage.putRecovery.bind(host.storage);host.storage.putRecovery=async(...args)=>{const result=await put(...args);if(args[0]===sourceProjectId&&args[2]?.reconciliation)process.exit(81);return result;};
 await service.settle({token:plan.token,confirmed:true},'child-shell');throw Error('expected exit after first acknowledgement');
}
const native=createWindowsDesktopFileTreeIO(host,{beforePublish:()=>{if(checkpoint==='before')process.exit(81);}}),io={...createFileTreeIO(host),...native,transferEntry:(p,s,d,o)=>native.transferEntry(p,s,d,{...o,onPublished:async facts=>{if(checkpoint==='after')process.exit(81);return o.onPublished(facts);}})};
const put=host.storage.putCrossTreeTransfer.bind(host.storage);host.storage.putCrossTreeTransfer=async(...args)=>{const result=await put(...args);if(checkpoint==='complete'&&args[1].phase==='complete')process.exit(81);return result;};
await new FileTreeOps(host,{trash:()=>{},io}).run({projectId,sourceProjectId,source,action});throw Error('expected native transfer checkpoint exit');
