import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {experimentalPrivateDirectoryComponents} from '../platform/windows/experimental-directories.mjs';
import {openExperimentalPersistenceParent} from '../platform/windows/experimental-persistence.mjs';

const fail=(code,message,cause)=>Object.assign(Error(message,{cause}),{code});
const uncertain=cause=>fail('STORAGE_RECEIPT_UNVERIFIABLE','Cannot verify a clean rollback-mode receipt database',cause);
const fileId=/^[a-f0-9]{16}:[a-f0-9]{32}$/;

// For a stopped writer only. The expected identifiers must come from the
// original operation, not from the database being inspected. Neither outcome
// clears quarantine or authorizes replay or any filesystem effect.
export function inspectWindowsStorageReceipt(root,file,{databaseIdentity,operationId,requestFingerprint}){
 return inspectWindowsStorageReceipts(root,file,{databaseIdentity,requests:[{operationId,requestFingerprint}]})[0];
}

export function inspectWindowsStorageReceipts(root,file,{databaseIdentity,requests}){
 const validRequest=request=>typeof request?.operationId==='string'&&request.operationId.length>0&&request.operationId.length<=512&&typeof request.requestFingerprint==='string'&&/^[a-f0-9]{64}$/.test(request.requestFingerprint);
 if(typeof databaseIdentity!=='string'||!fileId.test(databaseIdentity)||!Array.isArray(requests)||requests.length<1||requests.length>20001||!Array.from(requests).every(validRequest))throw fail('STORAGE_RECEIPT_BINDING_INVALID','Original database and request bindings required');
 const relative=experimentalPrivateDirectoryComponents(root,file).join('/'),name=path.basename(file);
 const parent=openExperimentalPersistenceParent(root,relative);
 let pin;
 try{
  const entry=parent.inspectEntry(name);
  if(entry?.identity!==databaseIdentity||entry.directory||entry.reparse)throw fail('PROJECT_METADATA_CONFLICT','Original receipt database is absent or replaced');
  try{pin=parent.openPrivateObjectRead(name);}catch(cause){throw uncertain(cause);}
  if(pin.stat().identity!==databaseIdentity)throw fail('PROJECT_METADATA_CONFLICT','Original receipt database was replaced during pin acquisition');
  const verify=()=>{
   pin.verify();parent.verify();
   for(const suffix of ['-journal','-wal','-shm'])if(parent.inspectEntry(name+suffix)!==null)throw uncertain();
  };
  let results;
  try{
   verify();
   // Version bytes 18 and 19 must both be rollback format. Never open a WAL
   // database here, including when its sidecars have already disappeared.
   const header=pin.readAt(0,100);
   if(header.length!==100||!header.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))||header[18]!==1||header[19]!==1)throw uncertain();
   // Native parent.path is a normalized local drive path with a \\?\ prefix.
   const uri=pathToFileURL(parent.path.slice(4)+name);uri.searchParams.set('mode','ro');
   const db=new DatabaseSync(uri.href,{readOnly:true});
   try{
    const table=db.prepare("PRAGMA main.table_list('operation_receipts')").get();
    if(table?.type!=='table')throw uncertain();
    const read=db.prepare('SELECT fingerprint, CASE WHEN length(CAST(result AS BLOB))<=1048576 THEN result END AS result FROM main.operation_receipts WHERE id=? LIMIT 2');
    let resultBytes=0;
    results=requests.map(({operationId,requestFingerprint})=>{
     const rows=read.all(operationId);
     if(!rows.length)return {status:'missing'};
     const [row]=rows;
     if(rows.length!==1||typeof row.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(row.fingerprint)||typeof row.result!=='string')throw uncertain();
     if(row.fingerprint!==requestFingerprint)throw fail('STORAGE_OPERATION_CONFLICT','Stored receipt is bound to a different request');
     resultBytes+=Buffer.byteLength(row.result);
     if(resultBytes>16*1024*1024)throw uncertain();
     return {status:'found',result:JSON.parse(row.result)};
    });
   }finally{db.close();}
   verify();
  }catch(cause){if(['STORAGE_RECEIPT_UNVERIFIABLE','STORAGE_OPERATION_CONFLICT'].includes(cause.code))throw cause;throw uncertain(cause);}
  return results;
 }finally{try{pin?.close();}finally{parent.close();}}
}
