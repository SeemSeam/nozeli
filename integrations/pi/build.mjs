import {build} from 'esbuild';
import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {patchSdk} from './tools/patch-sdk.mjs';
const root=import.meta.dirname;
const packages=path.join(root,'vendor/pi-gui/packages');
const aliases={
 '@pi-gui/catalogs/node/atomic-write':path.join(packages,'catalogs/node/atomic-write.ts'),
 '@pi-gui/catalogs/node':path.join(packages,'catalogs/node/index.ts'),
 '@pi-gui/catalogs':path.join(packages,'catalogs/index.ts'),
 '@pi-gui/session-driver/runtime-types':path.join(packages,'session-driver/runtime-types.ts'),
 '@pi-gui/session-driver/types':path.join(packages,'session-driver/types.ts'),
 '@pi-gui/session-driver':path.join(packages,'session-driver/index.ts'),
 '@pi-gui/extension-ui':path.join(packages,'extension-ui/index.ts')
};
const provenance=JSON.parse(await fs.readFile(path.join(root,'upstream-manifest.json'),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of provenance.files)if(sha(await fs.readFile(path.join(root,file.path)))!==file.sha256)throw Error('Vendored source differs from reviewed patch manifest: '+file.path);
const sdkPatched=await patchSdk(root);
await build({absWorkingDir:root,entryPoints:[path.join(packages,'pi-sdk-driver/index.ts')],outfile:path.join(root,'dist/vendor/pi-gui/packages/pi-sdk-driver/index.js'),bundle:true,platform:'node',format:'esm',target:'node22',packages:'external',alias:aliases,sourcemap:true});
const files={};
const sourceFiles=[];
for(const entry of await fs.readdir(path.join(root,'src'),{withFileTypes:true})){
 if(!entry.name.endsWith('.mjs'))continue;
 if(!entry.isFile())throw Error('Pi source module must be an ordinary file: '+entry.name);
 sourceFiles.push('src/'+entry.name);
}
sourceFiles.sort();
for(const file of [...sourceFiles,'dist/vendor/pi-gui/packages/pi-sdk-driver/index.js','package.json','package-lock.json','build.mjs','upstream-manifest.json','tools/patch-sdk.mjs','patches/sdk/model-storage-1.4.0.json','patches/sdk/model-storage-1.4.0.patch','patches/sdk/session-storage-1.4.0.json','patches/sdk/session-storage-1.4.0.patch','patches/0009-owner-model-auth-storage.patch','patches/0010-session-manager-storage-factory.patch'])files[file]=sha(await fs.readFile(path.join(root,file)));
for(const row of sdkPatched)files['node_modules/@earendil-works/pi-coding-agent/'+row.path]=row.sha256;
await fs.writeFile(path.join(root,'runtime-manifest.json'),JSON.stringify({schema:1,upstream:{repository:provenance.repository,commit:provenance.commit,license:provenance.license},sdk:provenance.sdk,entry:'src/owner.mjs',files},null,2)+'\n');
console.log('Pi driver built');
