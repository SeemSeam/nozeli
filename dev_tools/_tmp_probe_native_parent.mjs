import path from 'node:path';
import {openExperimentalPersistenceParent} from '../apps/desktop/src/platform/windows/experimental-persistence.mjs';
const project='N:\\restored-20261112\\nozeli_windows\\.cache\\temp\\nozeli-ux-batch2-zh-q1yLsc\\组会材料';
const parent=path.dirname(project);
for(const [root,relative] of [[parent,path.basename(project)+'/.git'],[parent,path.basename(project)+'/.git/refs/heads'],[project,'.git'],[project,'.git/refs/heads']]){
 let pin;try{pin=openExperimentalPersistenceParent(root,relative);pin.verify();console.log(JSON.stringify({root,relative,ok:true,identity:pin.identity()}));}catch(error){console.log(JSON.stringify({root,relative,ok:false,code:error.code,win32Code:error.win32Code,message:error.message}));}finally{pin?.close();}
}
