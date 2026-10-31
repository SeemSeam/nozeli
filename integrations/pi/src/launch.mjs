import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export async function resolvePiWorkerRuntime({integrationRoot=fileURLToPath(new URL('..',import.meta.url)),nodePath=process.execPath}={}){
 const entry=path.join(integrationRoot,'src','owner.mjs');
 for(const file of [entry,path.join(integrationRoot,'dist/vendor/pi-gui/packages/pi-sdk-driver/index.js'),path.join(integrationRoot,'node_modules/@earendil-works/pi-coding-agent/package.json')])await fs.access(file);
 const manifest=JSON.parse(await fs.readFile(path.join(integrationRoot,'runtime-manifest.json'),'utf8'));
 if(manifest.schema!==1||manifest.sdk!=='@earendil-works/pi-coding-agent@1.4.0')throw Error('Unsupported private Pi runtime manifest');
 for(const [file,expected]of Object.entries(manifest.files))if(createHash('sha256').update(await fs.readFile(path.join(integrationRoot,file))).digest('hex')!==expected)throw Error('Private Pi runtime integrity mismatch: '+file);
 return {command:nodePath,args:[entry],env:{ELECTRON_RUN_AS_NODE:'1'}};
}
