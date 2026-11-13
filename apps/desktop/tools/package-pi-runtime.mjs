import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {canonicalSections,canonicalDefinedSymbols,canonicalDynamicSymbols,qualifyStrippedNode} from './elf-strip-qualification.mjs';

// Only proven libc identities narrow Linux variants; unknown hosts keep both.
let hostLibc;
export function runtimeLibc() {
 if(process.platform!=='linux')return undefined;
 if(hostLibc===undefined){
  const report=process.report?.getReport();
  hostLibc=report?.header?.glibcVersionRuntime?'gnu':report?.sharedObjects?.some(file=>/\b(?:libc\.musl-|ld-musl-)/.test(file))?'musl':null;
 }
 return hostLibc;
}

const canvasTargets=new Set(['linux-x64-gnu','linux-x64-musl','linux-arm64-gnu','linux-arm64-musl','linux-arm-gnueabihf','linux-riscv64-gnu','darwin-x64','darwin-arm64','win32-x64-msvc','win32-arm64-msvc','android-arm64']);
export function canvasDependencyIncluded(relative,{platform=process.platform,arch=process.arch,libc=runtimeLibc()}={}) {
 const parts=relative.split(path.sep);
 for(let i=0;i<parts.length-1;i++){
  if(i!==0&&parts[i-1]!=='node_modules')continue;
  if(parts[i]!=='@napi-rs'||!parts[i+1].startsWith('canvas-'))continue;
  const variant=parts[i+1].slice('canvas-'.length);
  // Unknown future variants (including universal builds) are not proven redundant.
  if(!canvasTargets.has(variant))continue;
  const [os,cpu,abi]=variant.split('-');
  if(os!==platform||cpu!==arch)return false;
  if(os==='linux'&&(libc==='gnu'||libc==='musl')&&(abi==='gnu'||abi==='musl')&&abi!==libc)return false;
 }
 return true;
}

const opensslArchitectures=new Set(['linux64-loongarch64','linux64-s390x','solaris-x86-gcc','solaris64-x86_64-gcc','linux-elf','linux-ppc64le','linux-x86_64','linux32-s390x','linux64-mips64','linux64-riscv64','darwin-i386-cc','darwin64-arm64-cc','darwin64-x86_64-cc','linux-aarch64','linux-armv4','aix64-gcc-as','VC-WIN32','VC-WIN64-ARM','VC-WIN64A','BSD-x86','BSD-x86_64']);
export async function pruneNodeHeaders(directory,{platform=process.platform,arch=process.arch}={}) {
 // Native compile/load qualification currently exists only for Linux x64.
 // Keep the complete upstream headers on Mac/Windows until native evidence exists.
 const target=platform==='linux'&&arch==='x64'?'linux-x86_64':null;
 if(!target)return;
 const architectures=path.join(directory,'include/node/openssl/archs');
 // Keep all target asm/asm_avx2/no-asm include chains, Node/V8/N-API headers,
 // configuration selectors and common OpenSSL headers. Fail before deleting if absent.
 for(const mode of ['asm','asm_avx2','no-asm'])await fs.access(path.join(architectures,target,mode,'include/openssl/configuration.h'));
 for(const entry of await fs.readdir(architectures,{withFileTypes:true})){
  if(entry.isDirectory()&&entry.name!==target&&opensslArchitectures.has(entry.name))await fs.rm(path.join(architectures,entry.name),{recursive:true});
 }
}

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

// The processed ELF is qualified against the pinned original upstream digest:
// ELF64 little-endian x86-64 run identity, every SHF_ALLOC section's bytes,
// address, flags and type, program-header load behavior, dynamic symbols and
// all defined native symbols must stay identical. Only debug-only symbols and
// non-allocated debug bytes may differ, so differing GNU binutils patch
// releases (CI 2.42 vs workstation 2.46) pass while --strip-unneeded output
// or any loaded-byte or symbol change fails.

export async function separateNodeSymbols(executable,evidenceDirectory,{platform=process.platform,arch=process.arch}={}){
 if(platform!=='linux'||arch!=='x64')return undefined;
 const original=await fs.readFile(executable),sha256Original=digest(original);
 if(sha256Original!=='94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90')throw Error('Unqualified upstream Node executable for symbol separation');
 const tools={};
 for(const tool of ['strip','objcopy','readelf','nm']){
  const version=execFileSync(tool,['--version'],{encoding:'utf8'}).split('\n')[0];
  if(!version.startsWith('GNU '))throw Error('Unsupported Node symbol tool: '+version);
  tools[tool]=version;
 }
 const directory=path.join(evidenceDirectory,sha256Original);
 await fs.mkdir(directory,{recursive:true});
 const temporary=await fs.mkdtemp(path.join(directory,'.separate-'));
 try{
  const output=path.join(temporary,'node'),debug=path.join(temporary,'node.debug');
  await fs.copyFile(executable,output);
  execFileSync('objcopy',['--only-keep-debug',executable,debug]);
  execFileSync('strip',['--strip-debug',output]);
  const processed=await fs.readFile(output);
  // Binutils evidence uses each tool's canonical rows, never raw output that
  // renumbers with the section table.
  const evidence=file=>({sections:execFileSync('readelf',['-SW',file],{encoding:'utf8'}),symbols:execFileSync('nm',['--defined-only',file],{encoding:'utf8',maxBuffer:128<<20}),dynamicSymbols:execFileSync('readelf',['--dyn-syms','-W',file],{encoding:'utf8',maxBuffer:32<<20})});
  const upstreamEvidence=evidence(executable),processedEvidence=evidence(output);
  const violations=qualifyStrippedNode({originalImage:original,processedImage:processed,originalSections:upstreamEvidence.sections,processedSections:processedEvidence.sections,originalSymbols:upstreamEvidence.symbols,processedSymbols:processedEvidence.symbols,originalDynamicSymbols:upstreamEvidence.dynamicSymbols,processedDynamicSymbols:processedEvidence.dynamicSymbols});
  if(violations.length)throw Error('Unqualified processed Node executable ('+violations.length+' findings): '+violations.join('; ')+'; original candidate retained');
  if(processed.length>=original.length)throw Error('Node symbol separation did not reduce executable size');
  const qualification={elf:'ELF64-little-endian-x86-64',allocatedSections:canonicalSections(processedEvidence.sections).filter(section=>section.allocated).length,definedNativeSymbols:canonicalDefinedSymbols(processedEvidence.symbols).length,dynamicSymbols:canonicalDynamicSymbols(processedEvidence.dynamicSymbols).length};
  const provenance={schema:1,sha256Original,sha256Executable:digest(processed),bytesOriginal:original.length,bytesExecutable:processed.length,tools,operations:[['objcopy','--only-keep-debug','upstream-node','node.debug'],['strip','--strip-debug','candidate-node']],qualification,debug:{file:'node.debug',sha256:digest(await fs.readFile(debug)),bytes:(await fs.stat(debug)).size}};
  // This content-addressed build artifact stays outside the installed runtime.
  await fs.copyFile(debug,path.join(directory,'node.debug'));
  await fs.writeFile(path.join(directory,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');
  await fs.rename(output,executable);
  return provenance;
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
}

export async function exportNodeSymbols({source,application,archive}){
 const metadata=JSON.parse(await fs.readFile(path.join(application,'runtime/node/NODE-RUNTIME.json'),'utf8'));
 const processing=metadata.symbolProcessing;
 if(!processing||!/^[a-f0-9]{64}$/.test(processing.sha256Original))throw Error('Node symbol provenance is missing');
 const directory=path.join(source,'.test-output/node-runtime/symbols',processing.sha256Original);
 const snapshot=await fs.mkdtemp(path.join(path.dirname(archive),'.node-symbols-'));
 let reserved=false,complete=false;
 try{
  for(const name of ['node.debug','provenance.json','NODE-RUNTIME.json']){
   const input=path.join(directory,name);
   if(!(await fs.lstat(input)).isFile())throw Error('Node symbol artifact must be a regular file: '+name);
   await fs.copyFile(input,path.join(snapshot,name),fs.constants.COPYFILE_EXCL);
  }
  const provenance=JSON.parse(await fs.readFile(path.join(snapshot,'provenance.json'),'utf8'));
  const recorded=JSON.parse(await fs.readFile(path.join(snapshot,'NODE-RUNTIME.json'),'utf8'));
  if(JSON.stringify(provenance)!==JSON.stringify(processing)||JSON.stringify(recorded)!==JSON.stringify(metadata)||digest(await fs.readFile(path.join(snapshot,'node.debug')))!==processing.debug.sha256)throw Error('Node symbol artifact integrity mismatch');
  const handle=await fs.open(archive,'wx');reserved=true;await handle.close();
  execFileSync('tar',['-czf',archive,'-C',snapshot,'node.debug','provenance.json','NODE-RUNTIME.json']);
  complete=true;
 }finally{
  await fs.rm(snapshot,{recursive:true,force:true});
  if(reserved&&!complete)await fs.rm(archive,{force:true});
 }
}

export async function packagePiRuntime({source,application,includeDependency}){
 const integration=path.resolve(source,'../../integrations/pi'),target=path.join(application,'integrations/pi');
 await fs.mkdir(target,{recursive:true});
 for(const name of ['src','dist','vendor','patches','licenses','package.json','package-lock.json','runtime-manifest.json','upstream-manifest.json'])await fs.cp(path.join(integration,name),path.join(target,name),{recursive:true});
 const lock=JSON.parse(await fs.readFile(path.join(integration,'package-lock.json'),'utf8'));
 const modules=path.join(integration,'node_modules');
 await fs.cp(modules,path.join(target,'node_modules'),{recursive:true,filter:file=>{const relative=path.relative(modules,file);return relative.split(path.sep)[0]!=='.bin'&&includeDependency(lock,relative);}});
 const runtimeLock=JSON.parse(await fs.readFile(path.join(source,'tools/node-runtime.lock.json'),'utf8'));
 const node=Object.values(runtimeLock.platforms??{}).find(entry=>entry.platform===process.platform&&entry.arch===process.arch);
 if(!node)throw Error('No pinned standalone Node for this packaging platform');
 const cache=path.join(source,'.test-output','node-runtime');await fs.mkdir(cache,{recursive:true});
 const archive=process.env.NOZELI_NODE_ARCHIVE??path.join(cache,node.archive);
 try{await fs.access(archive);}catch(error){
  if(error.code!=='ENOENT'||process.env.NOZELI_NODE_ARCHIVE)throw error;
  const response=await fetch(node.url);if(!response.ok)throw Error('Standalone Node download failed: '+response.status);
  const temporary=archive+'.partial';await fs.writeFile(temporary,new Uint8Array(await response.arrayBuffer()));await fs.rename(temporary,archive);
 }
 if(createHash('sha256').update(await fs.readFile(archive)).digest('hex')!==node.sha256Archive)throw Error('Standalone Node archive integrity mismatch');
 const directory=path.join(application,'runtime/node');await fs.mkdir(directory,{recursive:true});
 execFileSync('tar',['-xf',archive,'--strip-components=1','-C',directory],{stdio:'inherit'});
 await pruneNodeHeaders(directory,node);
 const executable=path.join(directory,'bin/node');await fs.access(executable,fs.constants.X_OK);
 const cacheRelative=path.relative(application,cache);
 if(cacheRelative===''||!cacheRelative.startsWith('..'+path.sep)&&!path.isAbsolute(cacheRelative))throw Error('Node build evidence must remain outside the application');
 const symbolProcessing=await separateNodeSymbols(executable,path.join(cache,'symbols'),node);
 const sha256Executable=createHash('sha256').update(await fs.readFile(executable)).digest('hex');
 const metadata={schema:1,version:runtimeLock.version,...node,executable:'bin/node',sha256Executable,...(symbolProcessing?{symbolProcessing}:{})};
 await fs.writeFile(path.join(directory,'NODE-RUNTIME.json'),JSON.stringify(metadata,null,2)+'\n');
 if(symbolProcessing)await fs.writeFile(path.join(cache,'symbols',symbolProcessing.sha256Original,'NODE-RUNTIME.json'),JSON.stringify(metadata,null,2)+'\n');
}
