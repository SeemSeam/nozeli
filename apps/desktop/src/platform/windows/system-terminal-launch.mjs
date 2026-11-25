import {createHash} from 'node:crypto';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {openExperimentalAnchoredRead} from './experimental-read.mjs';
import {createExperimentalProcessJob,waitExperimentalJobEmpty} from './experimental-process-job.mjs';

// node.exe from the independently SHA-256-locked 22.23.4 Windows x64 ZIP.
// A mutable adjacent manifest cannot authorize a different executable.
const archiveDigest='cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20';
const exeDigest='dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f';
const exe='runtime/node/node.exe', entry='src/agents/system-terminal-entry.cjs';
const invalid=()=>Object.assign(Error('Trusted Windows terminal runtime unavailable'),{code:'TERMINAL_RUNTIME_UNAVAILABLE'});

async function verifyRuntime(appRoot,binary){
 const metadata=openExperimentalAnchoredRead(appRoot,'runtime/node/NODE-RUNTIME.json');
 try{
  const {size}=metadata.stat();
  if(size<1n||size>8192n)throw invalid();
  const bytes=metadata.readAt(0,Number(size));
  let manifest;try{manifest=JSON.parse(bytes.toString('utf8'));}catch{throw invalid();}
  if(bytes.length!==Number(size)||!metadata.verify()||manifest?.schema!==1||manifest.platform!=='win32'||manifest.arch!=='x64'||
     manifest.version!=='22.23.4'||manifest.executable!=='node.exe'||manifest.sha256Archive!==archiveDigest||manifest.sha256Executable!==exeDigest)throw invalid();
 }finally{metadata.close();}
 const {size}=binary.stat();
 if(size<1n||size>128n*1024n*1024n)throw invalid();
 const hash=createHash('sha256');
 for(let offset=0;offset<Number(size);){
  const chunk=binary.readAt(offset,Math.min(1024*1024,Number(size)-offset));
  if(!chunk.length)throw invalid();
  hash.update(chunk);offset+=chunk.length;
  await setImmediate();
 }
 if(hash.digest('hex')!==exeDigest||!binary.verify())throw invalid();
}

export async function launchWindowsSystemTerminal({appRoot,args,signal,retainRelease}){
 if(!path.isAbsolute(appRoot??'')||args?.length!==2||args[0]!=='--ticket'||typeof args[1]!=='string'||typeof retainRelease!=='function')throw invalid();
 const root=path.resolve(appRoot),systemRoot=process.env.SystemRoot;
 if(!systemRoot||!path.isAbsolute(systemRoot))throw invalid();
 signal.throwIfAborted();
 const binary=openExperimentalAnchoredRead(root,exe);
 let script,lease,releaseFlight,released=false;
 const release=()=>released?Promise.resolve():releaseFlight??=(async()=>{
  let facts;
  try{facts=await waitExperimentalJobEmpty(lease,{timeoutMs:1200});}
  catch(error){
   if(error.code!=='PROCESS_JOB_EXIT_UNCONFIRMED')throw error;
   lease.terminate();facts=await waitExperimentalJobEmpty(lease);
  }
  lease.close();script.close();released=true;
  return facts;
 })().finally(()=>{releaseFlight=undefined;});
 try{
  await verifyRuntime(root,binary);
  signal.throwIfAborted();
  script=openExperimentalAnchoredRead(root,entry);
  if(!script.verify()||!binary.verify())throw invalid();
  // The project is not a trusted DLL search directory.
  lease=createExperimentalProcessJob({command:path.join(root,exe),args:[path.join(root,entry),...args],cwd:root,
   env:[`SystemRoot=${systemRoot}`],stdio:'new-console'});
  retainRelease(release);
  const {pid}=lease.snapshot();
  lease.resume();
  return {terminal:'Windows Console',pid};
 }finally{
  if(!lease)script?.close();
  binary.close();
 }
}
