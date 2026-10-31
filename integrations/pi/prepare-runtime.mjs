import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root=import.meta.dirname;
if(!fs.existsSync(path.join(root,'package-lock.json')))throw Error('Pinned Pi package-lock.json missing');
for(const args of [['ci','--no-audit','--no-fund'],['run','build']]){
 const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',args,{cwd:root,stdio:'inherit',shell:process.platform==='win32'});
 if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
}
