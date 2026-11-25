import fs from 'node:fs/promises';
import path from 'node:path';
import {requireCapability} from '../platform/platform-capabilities.mjs';
import {createWindowsDesktopFileTreeIO} from '../platform/windows/desktop-file-tree.mjs';
export function createFileTreeIO(host){
 if(process.platform==='win32'){
  const native=createWindowsDesktopFileTreeIO(host);
  return Object.freeze({...native,requireAction(action,{cross=false}={}){
   if((!cross&&['createFile','createFolder','rename','copy','cut'].includes(action))||(cross&&['copy','cut'].includes(action)))return;
   requireCapability('safe-file-io');requireCapability('durable-persistence');
  }});
 }
 return Object.freeze({recoverableCreation:false,
  requireAction(){requireCapability('safe-file-io');requireCapability('durable-persistence');},
  async createEntry(project,relative,{kind}){
   const absolute=path.join(project.root,relative);
   if(kind==='directory')await fs.mkdir(absolute);
   else{const handle=await fs.open(absolute,'wx');await handle.close();}
  },
 });
}
