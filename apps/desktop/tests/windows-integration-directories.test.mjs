import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createExperimentalExecutionWorkspaceIO} from '../src/platform/windows/experimental-execution-workspace.mjs';
import {openExperimentalSourceDirectory} from '../src/platform/windows/experimental-source-directory.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
test('integration preserves ordinary project directories and creates nested public parents without privatizing them',native,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-public-integration-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const project=path.join(root,'project'),existing=path.join(project,'src');
 await fs.mkdir(existing,{recursive:true});await fs.writeFile(path.join(existing,'user.txt'),'untouched');
 const io=createExperimentalExecutionWorkspaceIO(root,{publicDirectory:directory=>directory===project||directory.startsWith(project+path.sep)?project:false});
 const pin=openExperimentalSourceDirectory(root,existing);const before=pin.identity(),security=pin.securityBytes();pin.close();
 await io.ensureDirectory(existing);
 const after=openExperimentalSourceDirectory(root,existing);
 try{assert.equal(after.identity(),before);assert.deepEqual(after.securityBytes(),security);after.verify();}finally{after.close();}
 await io.ensureDirectory(path.join(existing,'new','deep'));
 assert.equal(await fs.readFile(path.join(existing,'user.txt'),'utf8'),'untouched');
 assert.equal((await fs.stat(path.join(existing,'new','deep'))).isDirectory(),true);
 // The same existing public parent must not become valid private metadata.
 const privateIO=createExperimentalExecutionWorkspaceIO(root);
 await assert.rejects(privateIO.ensureDirectory(existing),{code:'FS_SECURITY_CHANGED'});
 const outside=path.join(root,'outside');await fs.mkdir(outside);
 await fs.symlink(outside,path.join(project,'linked'),'junction');
 await assert.rejects(io.ensureDirectory(path.join(project,'linked','child')));
 assert.deepEqual(await fs.readdir(outside),[]);
});
