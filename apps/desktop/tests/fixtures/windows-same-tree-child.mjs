import fs from 'node:fs/promises';
import {DesktopHost} from '../../src/main/host.mjs';
import {TreeRecovery} from '../../src/main/tree-recovery.mjs';
const [input,out]=process.argv.slice(2),p=JSON.parse(await fs.readFile(input,'utf8')),host=new DesktopHost(p.profile);let result;
try{const page=await host.storage.recoveryPage(p.projectId,{prefixes:['tree-operation:'],pendingOnly:true,purpose:'recovery-ui'});if(page.entries.length!==1)throw Error('one pending operation required');const row=page.entries[0],service=new TreeRecovery(host),plan=await service.preview({projectId:p.projectId,id:row.id,revision:row.revision,version:page.version},'synthetic-cold-same-tree');result={ok:true,pid:process.pid,result:await service.settle({token:plan.token,confirmed:true},'synthetic-cold-same-tree')};}catch(error){result={ok:false,error:{code:error.code,message:error.message}};process.exitCode=1;}finally{await host.storage.db.close();}await fs.writeFile(out,JSON.stringify(result));
