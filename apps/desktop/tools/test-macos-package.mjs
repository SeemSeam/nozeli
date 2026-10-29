// Extract the actual disk image, then exercise the relocated signed application.
// The harness needs development Node; the application runs with PATH empty.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream,openSync,closeSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {validateMacApplication} from './macos-bundle.mjs';
const [packageDir,output]=process.argv.slice(2);
if(process.platform!=='darwin'||process.arch!=='arm64'||!path.isAbsolute(packageDir||'')||!path.isAbsolute(output||''))throw Error('usage: node tools/test-macos-package.mjs <absolute-package-directory> <new-absolute-evidence-directory>');
await fs.mkdir(output,{recursive:false});
const hashes=(await fs.readFile(path.join(packageDir,'SHA256SUMS.txt'),'utf8')).trim().split('\n');
for(const line of hashes){const match=/^([a-f0-9]{64})  ([^/]+)$/.exec(line);if(!match||match[2]==='..')throw Error('Invalid hash entry');const h=createHash('sha256');for await(const bytes of createReadStream(path.join(packageDir,match[2])))h.update(bytes);if(h.digest('hex')!==match[1])throw Error('Package hash mismatch: '+match[2]);}
const images=(await fs.readdir(packageDir)).filter(name=>name.endsWith('.dmg'));if(images.length!==1)throw Error('Expected exactly one disk image');
const mount=path.join(output,'readonly-volume'),relocated=path.join(output,'独立验证 app');await fs.mkdir(mount);await fs.mkdir(relocated);
const run=(command,args)=>execFileSync(command,args,{stdio:'inherit'});
let mounted=false;
try{run('/usr/bin/hdiutil',['attach',path.join(packageDir,images[0]),'-readonly','-nobrowse','-mountpoint',mount]);mounted=true;run('/usr/bin/ditto',[path.join(mount,'Nozeli.app'),path.join(relocated,'Nozeli.app')]);}
finally{if(mounted)run('/usr/bin/hdiutil',['detach',mount]);}
const app=path.join(relocated,'Nozeli.app'),validation=await validateMacApplication(app),checks=[];
await fs.writeFile(path.join(output,'runtime-validation.json'),JSON.stringify(validation,null,2));
const env={...process.env,NOZELI_TEST_BUNDLE:app,TMPDIR:'/private/tmp'};delete env.NOZELI_FORMAT;delete env.ELECTRON_RUN_AS_NODE;
for(const name of ['text','pdf','image','word','sheet','ppt']){
 const log=path.join(output,name+'.log'),fd=openSync(log,'wx');let result;
 try{result=spawnSync(process.execPath,['tests/desktop-native-'+name+'.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore',fd,fd]});}finally{closeSync(fd);}
 checks.push({name,status:result.status,signal:result.signal,error:result.error?.message,log});console.log(JSON.stringify(checks.at(-1)));
 await fs.writeFile(path.join(output,'format-results.json'),JSON.stringify(checks,null,2));
 if(result.status!==0)throw Error('Packaged '+name+' acceptance failed; see '+log);
}
console.log(JSON.stringify({ok:true,app,output,checks,scope:'synthetic fixtures, no provider or model'},null,2));
