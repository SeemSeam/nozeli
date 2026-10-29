// Synthetic mounted volumes only. Never formats a device or touches user projects.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {assertUniqueTargets} from '../src/platform/filename-policy.mjs';
import {safeRelativePath} from '../src/agents/managed/file-stream.mjs';
import {platformNative} from '../src/platform/native.mjs';
if(process.platform!=='darwin')throw Error('This verification requires macOS');
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-volumes-'))),mounted=[],checks=[];
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
try{
 for(const [name,format,sensitive] of [['sensitive','Case-sensitive APFS',1],['insensitive','APFS',0]]){
  const file=path.join(root,name+'.sparseimage'),mount=path.join(root,name);await fs.mkdir(mount);
  run('/usr/bin/hdiutil',['create','-quiet','-size','128m','-type','SPARSE','-fs',format,'-volname','Nozeli-'+name,file]);
  run('/usr/bin/hdiutil',['attach','-quiet','-nobrowse','-mountpoint',mount,file]);mounted.push(mount);
  const handle=await fs.open(mount);try{assert.equal(platformNative().volume(handle.fd).caseSensitive,sensitive);}finally{await handle.close();}
  for(const name of ['.GIT/config','.NOZELI/data','NODE_MODULES/a'])assert.throws(()=>safeRelativePath(name));
  await assert.rejects(assertUniqueTargets(mount,['caf\u00e9','cafe\u0301']),{code:'TARGET_NAME_CONFLICT'});
  if(sensitive){await assertUniqueTargets(mount,['A','a','Dir/a','dir/b']);await fs.writeFile(path.join(mount,'A'),'upper');await fs.writeFile(path.join(mount,'a'),'lower');}
  else{for(const paths of [['A','a'],['Dir/a','dir/b']])await assert.rejects(assertUniqueTargets(mount,paths),{code:'TARGET_NAME_CONFLICT'});await fs.writeFile(path.join(mount,'Original'),'original');await assert.rejects(assertUniqueTargets(mount,['original']),{code:'PATH_ALIAS'});assert.equal(await fs.readFile(path.join(mount,'Original'),'utf8'),'original');}
  checks.push({format,sensitive,reservedAliases:true,unicodeConflict:true,casePolicy:true});
 }
 const source=path.join(root,'sensitive'),target=path.join(root,'insensitive');
 await assert.rejects(assertUniqueTargets(target,['A','a']),{code:'TARGET_NAME_CONFLICT'});
 assert.equal(await fs.readFile(path.join(source,'A'),'utf8'),'upper');assert.equal(await fs.readFile(path.join(source,'a'),'utf8'),'lower');await assert.rejects(fs.stat(path.join(target,'A')),{code:'ENOENT'});
 checks.push({crossVolume:'distinct source names rejected before target copy',caseOnlyRename:'rejected with original preserved; no implicit rename'});
 console.log(JSON.stringify({ok:true,root,checks},null,2));
}finally{for(const mount of mounted.reverse())run('/usr/bin/hdiutil',['detach','-quiet',mount]);}
