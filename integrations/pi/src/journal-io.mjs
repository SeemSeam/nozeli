// Platform file effects for the Nozeli-authored runtime bridge. Windows must
// use its explicitly supplied native private-file lease; a read-only Node
// descriptor cannot FlushFileBuffers, and failure must never become success.
import {open,readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
// Inspect exactly the confirmed bytes. SDK SessionManager.open is a writer:
// it can migrate old journals and silently skips malformed JSONL records.
// The caller may build an in-memory SDK view only after this validation.
export function parseConfirmedJournal(bytes,sessionId){
  const invalid=(message,cause)=>Object.assign(Error(message,{cause}),{code:'PI_JOURNAL_INVALID'});
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>64*1024*1024||bytes.at(-1)!==10)
    throw invalid('Pi journal must be a complete bounded JSONL byte snapshot');
  let rows;
  try{rows=new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));}
  catch{throw invalid('Pi journal contains invalid UTF-8 or JSON');}
  const [header,...entries]=rows;
  if(!header||header.type!=='session'||header.version!==3||typeof sessionId!=='string'||!sessionId||header.id!==sessionId||typeof header.cwd!=='string'||!header.cwd)
    throw invalid('Pi journal does not bind the current version and exact session');
  const ids=new Set();
  for(const entry of entries){
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||typeof entry.type!=='string'||!entry.type||entry.type==='session'||
       typeof entry.id!=='string'||!entry.id||ids.has(entry.id)||entry.parentId!==null&&!ids.has(entry.parentId))
      throw invalid('Pi journal has an invalid, duplicate or unbound native entry identity');
    ids.add(entry.id);
  }
  return {header,entries};
}
let native;
export async function windowsBridge(){
  if(native)return native;
  const file=process.env.NOZELI_PI_WINDOWS_NATIVE_BRIDGE,expected=process.env.NOZELI_PI_WINDOWS_NATIVE_SHA256;
  if(!file||!path.isAbsolute(file)||path.basename(file)!=='nozeli_windows_read.node'||!/^[a-f0-9]{64}$/.test(expected??''))
    throw Object.assign(Error('Windows Pi journal requires an explicit native bridge binding'),{code:'PI_JOURNAL_UNSUPPORTED'});
  const actual=createHash('sha256').update(await readFile(file)).digest('hex');
  if(actual!==expected)throw Object.assign(Error('Windows Pi native bridge digest changed'),{code:'PI_JOURNAL_UNSUPPORTED'});
  native=require(file);return native;
}
function privateRelative(file){
  const root=process.env.NOZELI_PI_PRIVATE_ROOT,relative=typeof root==='string'?path.relative(root,file):null;
  if(!root||!path.isAbsolute(root)||!path.isAbsolute(file)||!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))
    throw Object.assign(Error('Pi recovery intent is outside the bound private root'),{code:'PI_JOURNAL_UNVERIFIED'});
  return {root,relative:relative.split(path.sep).join('/')};
}
export async function hasRecoveryIntent(file){
  if(process.platform!=='win32'){
    try{const handle=await open(file,'r');await handle.close();return true;}
    catch(error){if(error.code==='ENOENT')return false;throw error;}
  }
  const {root,relative}=privateRelative(file);let parent,lease;
  try{
    parent=(await windowsBridge()).openAnchoredPersistenceParent(root,relative);
    try{lease=parent.openPrivateTreeFile(path.basename(file));}
    catch(error){if(error.code==='WIN32_IO_ERROR'&&error.win32Code===2){parent.verify();return false;}throw error;}
    lease.verify();parent.verify();return true;
  }finally{lease?.close();parent?.close();}
}
// Publish once before dispatch. A barrier failure after publication retains
// the fence and reports UNKNOWN; no caller may retry a model continuation.
export async function publishRecoveryIntent(file,value,{directorySync=parent=>parent.syncDirectory()}={}){
  if(typeof directorySync!=='function')throw new TypeError('Expected directorySync');
  const bytes=Buffer.from(JSON.stringify(value));
  if(bytes.length>1024*1024)throw Object.assign(Error('Recovery intent exceeds 1 MiB'),{code:'PI_RECOVERY_IDENTITY'});
  if(process.platform!=='win32'){
    const handle=await open(file,'wx',0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    const directory=await open(path.dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
    return;
  }
  const {root,relative}=privateRelative(file);let parent,stage,published=false,primaryError;
  try{
    parent=(await windowsBridge()).openAnchoredPersistenceParent(root,relative);
    stage=parent.createPrivateExclusive('.nozeli-recovery-'+randomUUID()+'.pending');
    stage.write(bytes);stage.sync();stage.publishNew(path.basename(file));published=true;
    await directorySync(parent);parent.verify();
  }catch(cause){
    primaryError=published||cause.committed?Object.assign(Error('Recovery intent publication requires reconciliation; no dispatch or retry',{cause}),{code:'PI_PERSISTENCE_UNCONFIRMED',committed:true,automaticReplay:false}):cause;
    if(!published&&(cause.code==='FS_TARGET_EXISTS'||cause.code==='WIN32_IO_ERROR'&&[80,183].includes(cause.win32Code)))
      primaryError=Object.assign(Error('Recovery intent already exists; continuation refused',{cause}),{code:'PI_RECOVERY_RECONCILIATION'});
    throw primaryError;
  }finally{
    const errors=[];for(const pin of [stage,parent])try{pin?.close();}catch(error){errors.push(error);}
    if(errors.length){if(primaryError)primaryError.cleanupErrors=errors;else throw Object.assign(Error('Recovery intent closure requires reconciliation',{cause:errors[0]}),{code:'PI_PERSISTENCE_UNCONFIRMED',committed:published,automaticReplay:false});}
  }
}
export async function prepareJournalDirectory(cwd,agentDir,sessionDirectory=null){
  if(process.platform!=='win32')return null;
  const root=process.env.NOZELI_PI_PRIVATE_ROOT,relative=root&&path.relative(root,agentDir);
  if(!root||!path.isAbsolute(root)||!path.isAbsolute(agentDir)||!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))
    throw Object.assign(Error('Pi agent directory is outside the bound private root'),{code:'PI_JOURNAL_UNVERIFIED'});
  // The default plan is the pinned SDK's directory encoding; an explicit
  // sessionDirectory (admin's isolated private sessions) is pinned the same
  // way and must remain inside the owner's agent directory.
  let plan,directory;
  if(sessionDirectory===null){
    const name=`--${path.resolve(cwd).replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--`;
    plan=['sessions',name];directory=path.join(agentDir,'sessions',name);
  }else{
    directory=path.resolve(sessionDirectory);
    const rel=path.relative(agentDir,directory);
    if(!rel||path.isAbsolute(rel)||rel==='..'||rel.startsWith('..'+path.sep)||rel.split(path.sep).includes('..'))
      throw Object.assign(Error('Pi journal directory is outside the agent directory'),{code:'PI_JOURNAL_UNVERIFIED'});
    plan=rel.split(path.sep);
  }
  let cursor=(await windowsBridge()).openAnchoredPersistenceParent(root,relative.split(path.sep).join('/')+'/__journal_anchor__');
  try{
    for(const component of plan){
      const child=cursor.openPrivateDirectory(component,true);
      try{child.syncDirectory();cursor.syncDirectory();child.verify();cursor.verify();}catch(error){child.close();throw error;}
      cursor.close();cursor=child;
    }
    const pin=cursor;cursor=null;
    return {directory,verify(file){pin.verify();if(path.dirname(file)!==directory)throw Object.assign(Error('SDK journal directory differs from the pinned plan'),{code:'PI_JOURNAL_UNVERIFIED'});},close(){pin.close();}};
  }finally{cursor?.close();}
}
export async function withFlushedJournal(file,callback){
  if(process.platform!=='win32'){
    const handle=await open(file,'r');
    try{await handle.sync();return await callback(await handle.readFile(),{mechanism:'node-file-sync',namespace:'not-qualified'});}finally{await handle.close();}
  }
  const root=process.env.NOZELI_PI_PRIVATE_ROOT,relative=typeof root==='string'?path.relative(root,file):null;
  if(!root||!path.isAbsolute(root)||!path.isAbsolute(file)||!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))
    throw Object.assign(Error('Pi journal is outside the bound private root'),{code:'PI_JOURNAL_UNVERIFIED'});
  let parent,lease;
  try{
    parent=(await windowsBridge()).openAnchoredPersistenceParent(root,relative.split(path.sep).join('/'));
    lease=parent.openPrivateTreeFile(path.basename(file));const size=lease.stat().size;
    if(size>64n*1024n*1024n)throw Object.assign(Error('Pi journal exceeds the 64 MiB flush/read budget'),{code:'PI_JOURNAL_LIMIT'});
    lease.sync();parent.syncDirectory();const chunks=[];
    for(let offset=0;offset<Number(size);){const chunk=lease.readAt(offset,Math.min(256*1024,Number(size)-offset));if(!chunk.length)throw Object.assign(Error('Pi journal truncated during flush'),{code:'PI_JOURNAL_UNVERIFIED'});chunks.push(chunk);offset+=chunk.length;}
    const result=await callback(Buffer.concat(chunks),{mechanism:'windows-private-file-handle',file:'flushed',directory:'flushed',namespace:'not-qualified',identity:lease.stat().identity});
    lease.verify();parent.verify();return result;
  }finally{lease?.close();parent?.close();}
}
