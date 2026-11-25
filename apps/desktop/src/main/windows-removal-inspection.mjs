import path from 'node:path';
import {createHash} from 'node:crypto';
import {openExperimentalPrivateTree} from '../platform/windows/experimental-private-tree.mjs';
import {inspectWindowsStorageReceipts} from './storage-receipt-inspection.mjs';
import {fingerprint} from './storage-request-fingerprint.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code});
const sha=value=>createHash('sha256').update(value).digest('hex');

// Only an independently retained, originally approved binding is admissible.
// Derive both the writer's requests and the cold reader's expectations from it.
export function removalReceiptRequests(removalId,binding){
 const {directory,parentIdentity,manifest}=binding??{};
 const {schema,rootIdentity,entries,entryCount,totalBytes,sha256}=manifest??{};
 if(typeof removalId!=='string'||!/^[a-zA-Z0-9_-]{8,160}$/.test(removalId)||typeof directory!=='string'||typeof parentIdentity!=='string'||schema!==1||!Array.isArray(entries)||entries.length<1||entries.length>10001||sha(JSON.stringify({schema,rootIdentity,entries,entryCount,totalBytes}))!==sha256)throw fail('FS_VERSION_REJECTED','Expected original removal binding');
 const names=new Set();
 const put=(suffix,value)=>{
  const operationId=removalId+':'+suffix;
  return {operationId,collection:'private_tree_removal',id:operationId,value,expectedRevision:0};
 };
 return {
  binding:put('binding',binding),
  members:entries.filter(row=>row.relative!=='').map(({relative,type,identity})=>{
   if(typeof relative!=='string'||names.has(relative)||!['file','directory'].includes(type)||typeof identity!=='string')throw fail('FS_VERSION_REJECTED','Invalid original removal member');
   names.add(relative);
   const member={relative,type,identity},key=sha(relative);
   const value={directory,parentIdentity,rootIdentity,manifestSha256:sha256,member};
   return {member,intent:put('intent:'+key,value),confirmation:put('confirmed:'+key,value)};
  }),
 };
}

// The owner must have independently stopped the original writer. This only
// observes a surviving root; it cannot authorize deletion or release a fence.
export async function inspectWindowsRemovalProgress(root,file,{databaseIdentity,removalId,binding,signal}){
 const original=structuredClone(binding);
 const journal=removalReceiptRequests(removalId,original);
 const relative=path.relative(original.directory,file);
 if(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep))throw fail('FS_PATH_REJECTED','Removal receipts must be stored outside the removed tree');
 const request=args=>({operationId:args.operationId,requestFingerprint:fingerprint('put',args)});
 const receipts=inspectWindowsStorageReceipts(root,file,{databaseIdentity,requests:[request(journal.binding),...journal.members.flatMap(({intent,confirmation})=>[request(intent),request(confirmation)])]});
 const committed=receipt=>{
  if(receipt.status==='missing')return false;
  if(receipt.result?.revision!==1)throw fail('STORAGE_RECEIPT_UNVERIFIABLE','Invalid create-only removal receipt');
  return true;
 };
 if(!committed(receipts[0]))throw fail('REMOVAL_BINDING_UNCONFIRMED','Original removal binding has no committed receipt');
 const confirmed=[];
 for(const [index,{member}] of journal.members.entries()){
  const intent=committed(receipts[1+index*2]);
  if(committed(receipts[2+index*2])){
   if(!intent)throw fail('REMOVAL_INTENT_UNCONFIRMED','Member confirmation has no matching prior intent');
   confirmed.push(member);
  }
 }
 const tree=await openExperimentalPrivateTree(root,original.directory,{rootAccess:'readwrite',fileAccess:'read',expectedIdentity:original.manifest.rootIdentity,signal});
 try{return {...await tree.inspectRemovalProgress(original,confirmed,{signal}),observationOnly:true,confirmedCount:confirmed.length};}
 finally{tree.close();}
}
