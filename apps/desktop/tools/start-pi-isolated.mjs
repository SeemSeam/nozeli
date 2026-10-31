// Developer-only isolated launch: never connects to the installed profile or
// forwards this branch's startup to the daily Nozeli singleton.
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
const appRoot=path.resolve(import.meta.dirname,'..');
const privateRoot=path.resolve(appRoot,'../../.runtime/pi-development');
await fs.mkdir(privateRoot,{recursive:true,mode:0o700});
console.log('Isolated Pi profile: '+privateRoot);
const child=spawn(process.execPath,[path.join(import.meta.dirname,'start.mjs'),...process.argv.slice(2)],{cwd:appRoot,stdio:'inherit',env:{...process.env,NOZELI_CONFIG_ROOT:privateRoot,NOZELI_USER_DATA:path.join(privateRoot,'desktop'),NOZELI_TEST_INSTANCE:'1'}});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
