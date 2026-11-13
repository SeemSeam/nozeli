import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dependencyIncluded, applicationDependencyIncluded} from '../tools/local-release.mjs';
import {pruneNodeHeaders,separateNodeSymbols,exportNodeSymbols} from '../tools/package-pi-runtime.mjs';

const lock={packages:{}};
test('application and Pi production filters retain only proven target Canvas variants',()=>{
 for(const include of [dependencyIncluded,applicationDependencyIncluded]){
  for(const prefix of ['', 'sdk/node_modules/']){
   const file=variant=>`${prefix}@napi-rs/canvas-${variant}/skia.node`;
   for(const arch of ['x64','arm64'])for(const libc of ['gnu','musl']){
    const target={platform:'linux',arch,libc};
    assert.equal(include(lock,file(`linux-${arch}-${libc}`),target),true);
    assert.equal(include(lock,file(`linux-${arch}-${libc==='gnu'?'musl':'gnu'}`),target),false);
    assert.equal(include(lock,file(`linux-${arch==='x64'?'arm64':'x64'}-${libc}`),target),false);
    assert.equal(include(lock,file('darwin-arm64'),target),false);
   }
   for(const libc of [null,'unknown'])for(const abi of ['gnu','musl'])assert.equal(include(lock,file(`linux-x64-${abi}`),{platform:'linux',arch:'x64',libc}),true);
   for(const [platform,arch,variant] of [['darwin','arm64','darwin-arm64'],['darwin','x64','darwin-x64'],['win32','x64','win32-x64-msvc'],['win32','arm64','win32-arm64-msvc']]){
    const target={platform,arch,libc:null};
    assert.equal(include(lock,file(variant),target),true);
    assert.equal(include(lock,file('linux-x64-gnu'),target),false);
    assert.equal(include(lock,file('darwin-universal'),target),true);
    assert.equal(include(lock,file('future-target'),target),true);
   }
  }
  for(const file of ['@napi-rs/canvas/index.js','@napi-rs/canvas/LICENSE','@napi-rs/canvas/index.d.ts','sdk/providers/oauth.js','sdk/dist/index.js.map','fonts/chinese.woff2','@codemirror/merge/dist/index.js','@lezer/html/dist/index.js'])assert.equal(include(lock,file),true);
  assert.equal(include(lock,'assets/@napi-rs/canvas-linux-arm64-gnu/image.png',{platform:'linux',arch:'x64',libc:'gnu'}),true);
 }
});

async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-package-native-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 return directory;
}
async function header(directory,relative){
 const file=path.join(directory,'include/node',relative);
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,relative);return file;
}
for(const [platform,arch,target,other] of [['linux','x64','linux-x86_64','darwin64-arm64-cc']])test(`Node header pruning preserves native include chains for ${platform}-${arch}`,async t=>{
 const directory=await fixture(t);
 const keep=[];
 for(const mode of ['asm','asm_avx2','no-asm'])keep.push(await header(directory,`openssl/archs/${target}/${mode}/include/openssl/configuration.h`));
 for(const name of ['node_api.h','js_native_api.h','v8.h','openssl/configuration.h','openssl/configuration_asm.h','openssl/configuration_no-asm.h','openssl/archs/future-target/include.h'])keep.push(await header(directory,name));
 const removed=await header(directory,`openssl/archs/${other}/asm/include/openssl/configuration.h`);
 await pruneNodeHeaders(directory,{platform,arch});
 for(const file of keep)assert.equal(await fs.readFile(file,'utf8'),path.relative(path.join(directory,'include/node'),file));
 await assert.rejects(fs.access(removed),{code:'ENOENT'});
});
test('missing native headers stop pruning before any removal; unsupported targets preserve all',async t=>{
 const directory=await fixture(t),file=await header(directory,'openssl/archs/linux-elf/asm/include/openssl/configuration.h');
 await assert.rejects(pruneNodeHeaders(directory,{platform:'linux',arch:'x64'}),{code:'ENOENT'});
 await fs.access(file);
 await pruneNodeHeaders(directory,{platform:'win32',arch:'arm64'});
 await fs.access(file);
 await pruneNodeHeaders(directory,{platform:'darwin',arch:'arm64'});
 await fs.access(file);
});

test('symbol separation leaves unqualified platforms untouched and rejects unknown Linux binaries',async t=>{
 const directory=await fixture(t),executable=path.join(directory,'node'),evidence=path.join(directory,'symbols');
 await fs.writeFile(executable,'not the pinned upstream Node');
 for(const [platform,arch] of [['darwin','arm64'],['win32','x64'],['linux','arm64']]){
  assert.equal(await separateNodeSymbols(executable,evidence,{platform,arch}),undefined);
  assert.equal(await fs.readFile(executable,'utf8'),'not the pinned upstream Node');
 }
 await assert.rejects(separateNodeSymbols(executable,evidence,{platform:'linux',arch:'x64'}),/Unqualified upstream Node/);
 assert.equal(await fs.readFile(executable,'utf8'),'not the pinned upstream Node');
 await assert.rejects(fs.access(evidence),{code:'ENOENT'});
});

test('symbol artifact export refuses corrupted recovery bytes before publishing an archive',async t=>{
 const directory=await fixture(t),source=path.join(directory,'source'),application=path.join(directory,'application'),archive=path.join(directory,'symbols.tar.gz');
 const original='a'.repeat(64),debug=Buffer.from('original external debug bytes');
 const processing={sha256Original:original,debug:{sha256:createHash('sha256').update(debug).digest('hex')}};
 const metadata={schema:1,symbolProcessing:processing},evidence=path.join(source,'.test-output/node-runtime/symbols',original);
 await fs.mkdir(evidence,{recursive:true});await fs.mkdir(path.join(application,'runtime/node'),{recursive:true});
 await fs.writeFile(path.join(application,'runtime/node/NODE-RUNTIME.json'),JSON.stringify(metadata));
 await fs.writeFile(path.join(evidence,'NODE-RUNTIME.json'),JSON.stringify(metadata));await fs.writeFile(path.join(evidence,'provenance.json'),JSON.stringify(processing));
 await fs.writeFile(path.join(evidence,'node.debug'),'corrupted external bytes');
 await assert.rejects(exportNodeSymbols({source,application,archive}),/integrity mismatch/);
 await assert.rejects(fs.access(archive),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(evidence,'node.debug'),'utf8'),'corrupted external bytes');
});

// Opt-in candidate qualification, not a source-tree substitute for packaged behavior.
const application=process.env.NOZELI_PACKAGED_APP;
test('candidate standalone Node compiles and loads N-API with native OpenSSL headers', {skip:!application&&'Set NOZELI_PACKAGED_APP to the fresh candidate resources/app'},async t=>{
 assert.ok(['linux','darwin'].includes(process.platform));
 const directory=await fixture(t),runtime=path.resolve(application,'runtime/node');
 const source=path.join(directory,'addon.c');
 await fs.writeFile(source,`#include <node_api.h>\n#include <openssl/ssl.h>\n#include <openssl/configuration.h>\nstatic napi_value init(napi_env env,napi_value exports){napi_value result;napi_create_int32(env,42,&result);return result;}\nNAPI_MODULE(native_probe,init)\n`);
 for(const mode of ['asm','no-asm']){
  const output=path.join(directory,mode+'.node');
  const flags=process.platform==='darwin'?['-bundle','-undefined','dynamic_lookup']:['-shared','-fPIC'];
  execFileSync(process.env.CC||'cc',[...flags,...(mode==='no-asm'?['-DOPENSSL_NO_ASM']:[]),'-I'+path.join(runtime,'include/node'),source,'-o',output],{stdio:'pipe'});
  execFileSync(path.join(runtime,'bin/node'),['-e',`require('node:assert/strict').equal(require(process.argv[1]),42)`,output],{stdio:'pipe',env:{...process.env,NODE_PATH:'',NODE_OPTIONS:''}});
 }
});
test('candidate Canvas encodes, decodes and composites PNG offline', {skip:!application&&'Set NOZELI_PACKAGED_APP to the fresh candidate resources/app'},()=>{
 const script=`const assert=require('node:assert/strict'),{createRequire}=require('node:module'),path=require('node:path');const load=createRequire(path.join(process.argv[1],'package.json'));const {createCanvas,loadImage}=load('@napi-rs/canvas');(async()=>{const canvas=createCanvas(2,2),ctx=canvas.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,2,2);const image=await loadImage(canvas.toBuffer('image/png'));const out=createCanvas(4,4),draw=out.getContext('2d');draw.drawImage(image,1,1);assert.deepEqual(Array.from(draw.getImageData(1,1,1,1).data),[255,0,0,255]);assert.equal(draw.getImageData(0,0,1,1).data[3],0);assert.equal(out.toBuffer('image/png').subarray(1,4).toString(),'PNG');})().catch(error=>{console.error(error);process.exitCode=1});`;
 execFileSync(path.resolve(application,'runtime/node/bin/node'),['-e',script,path.resolve(application)],{stdio:'pipe',env:{...process.env,NODE_PATH:'',NODE_OPTIONS:'',NAPI_RS_NATIVE_LIBRARY_PATH:''}});
});

test('candidate Node retains diagnostic stacks, inspector and Pi error protocol with truthful provenance', {skip:!application&&'Set NOZELI_PACKAGED_APP to the fresh candidate resources/app'},async()=>{
 const runtime=path.resolve(application,'runtime/node'),executable=path.join(runtime,'bin/node');
 const metadata=JSON.parse(await fs.readFile(path.join(runtime,'NODE-RUNTIME.json'),'utf8'));
 const bytes=await fs.readFile(executable),hash=createHash('sha256').update(bytes).digest('hex');
 assert.equal(metadata.sha256Executable,hash);
 if(process.platform==='linux'&&process.arch==='x64'){
  assert.equal(metadata.symbolProcessing.sha256Executable,hash);
  assert.equal(metadata.symbolProcessing.sha256Original,'94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90');
  assert.ok(metadata.symbolProcessing.bytesOriginal>bytes.length);
  assert.match(metadata.symbolProcessing.debug.sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(fs.access(path.join(runtime,'node.debug')),{code:'ENOENT'});
 }
 const script=`const assert=require('node:assert/strict'),session=new(require('node:inspector').Session)();session.connect();session.post('Debugger.enable',error=>{if(error)throw error});function piDiagnosticFrame(){throw Error('diagnostic-evidence')}try{piDiagnosticFrame()}catch(error){assert.match(error.stack,/piDiagnosticFrame/);assert.match(error.stack,/diagnostic-evidence/)}session.disconnect();`;
 const env={...process.env,NODE_OPTIONS:'',NODE_PATH:''};
 execFileSync(executable,['-e',script],{env,stdio:'pipe'});
 const output=execFileSync(executable,[path.resolve(application,'integrations/pi/src/owner.mjs')],{env,encoding:'utf8',input:JSON.stringify({id:'diagnostic',method:'noSuchMethod'})+'\n',timeout:30000});
 assert.deepEqual(JSON.parse(output.trim()),{id:'diagnostic',error:{code:'PI_METHOD_UNAVAILABLE',message:'Pi method unavailable: noSuchMethod'}});
});
