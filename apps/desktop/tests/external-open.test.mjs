import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {fileArguments,externalTarget} from '../src/main/external-open.mjs';import {DesktopHost} from '../src/main/host.mjs';
test('OS file arguments and existing project roots respect Unicode, spaces, URIs, and local-file boundary',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-open-'));try{const root=path.join(dir,'中文 project');await fs.mkdir(path.join(root,'nested'),{recursive:true});const target=path.join(root,'nested','空 格.txt');await fs.writeFile(target,'text');
 assert.deepEqual(fileArguments(['nozeli','--ozone-platform=wayland',target,pathToFileURL(target).href],{packaged:true}),[target]);assert.deepEqual(fileArguments(['electron','main.cjs',target]),[target]);
 const host=new DesktopHost(path.join(dir,'profile'));const p=await host.pick(root);assert.deepEqual(await externalTarget(host,target),{projectId:p.project.id,relPath:'nested/空 格.txt'});await assert.rejects(externalTarget(host,path.join(root,'missing.txt')));
 await fs.symlink(target,path.join(root,'link.txt'));await assert.rejects(externalTarget(host,path.join(root,'link.txt')),/普通/);
 assert.deepEqual(await externalTarget(host,root),{projectId:p.project.id,relPath:null});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
