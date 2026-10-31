import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

export async function packagePiRuntime({source,application,includeDependency}){
 const integration=path.resolve(source,'../../integrations/pi'),target=path.join(application,'integrations/pi');
 await fs.mkdir(target,{recursive:true});
 for(const name of ['src','dist','vendor','patches','licenses','package.json','package-lock.json','runtime-manifest.json','upstream-manifest.json'])await fs.cp(path.join(integration,name),path.join(target,name),{recursive:true});
 const lock=JSON.parse(await fs.readFile(path.join(integration,'package-lock.json'),'utf8'));
 const modules=path.join(integration,'node_modules');
 await fs.cp(modules,path.join(target,'node_modules'),{recursive:true,filter:file=>{const relative=path.relative(modules,file);return relative.split(path.sep)[0]!=='.bin'&&includeDependency(lock,relative);}});
 const node=JSON.parse(await fs.readFile(path.join(source,'tools/node-runtime.lock.json'),'utf8'));
 if(node.platform!==process.platform||node.arch!==process.arch)throw Error('No pinned standalone Node for this packaging platform');
 const cache=path.join(source,'.test-output','node-runtime');await fs.mkdir(cache,{recursive:true});
 const archive=process.env.NOZELI_NODE_ARCHIVE??path.join(cache,node.archive);
 try{await fs.access(archive);}catch(error){
  if(error.code!=='ENOENT'||process.env.NOZELI_NODE_ARCHIVE)throw error;
  const response=await fetch(node.url);if(!response.ok)throw Error('Standalone Node download failed: '+response.status);
  const temporary=archive+'.partial';await fs.writeFile(temporary,new Uint8Array(await response.arrayBuffer()));await fs.rename(temporary,archive);
 }
 if(createHash('sha256').update(await fs.readFile(archive)).digest('hex')!==node.sha256Archive)throw Error('Standalone Node archive integrity mismatch');
 const directory=path.join(application,'runtime/node');await fs.mkdir(directory,{recursive:true});
 execFileSync('tar',['-xJf',archive,'--strip-components=1','-C',directory],{stdio:'inherit'});
 const executable=path.join(directory,'bin/node');await fs.access(executable,fs.constants.X_OK);
 const sha256Executable=createHash('sha256').update(await fs.readFile(executable)).digest('hex');
 await fs.writeFile(path.join(directory,'NODE-RUNTIME.json'),JSON.stringify({...node,executable:'bin/node',sha256Executable},null,2)+'\n');
}
