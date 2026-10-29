import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const localFields=new Set(['providers','residents','residentArchive','drafts','bindings']);
const workLocal=new Set(['threadId','toolsDigest','binding','execution','contextRecovery','threadArchive','contextHandoff','zeroActivity']);
const jobLocal=new Set(['collabAttempts','manualPromptId','sessionFile','transport']);
const table=key=>'managed_'+key.replace(/[^A-Za-z0-9_]/g,'_');
const fail=(code,message)=>Object.assign(Error(message),{code});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const clone=value=>value===undefined?undefined:structuredClone(value);
const splitRecord=(record,fields)=>{
 const value={},local={};for(const [key,item] of Object.entries(record)){if(fields.has(key))local[key]=item;else value[key]=item;}
 if(fields===workLocal&&record.closure){
  const businessKeys=new Set(['decision','binding','phase','at','revision','report','completedAt','dispositionAt']);
  value.closure=Object.fromEntries(Object.entries(record.closure).filter(([key])=>businessKeys.has(key)));
  local.closure=Object.fromEntries(Object.entries(record.closure).filter(([key])=>!businessKeys.has(key)));
  if(record.closure.git)value.closure.git=Object.fromEntries(['status','commit','complete'].filter(key=>record.closure.git[key]!==undefined).map(key=>[key,record.closure.git[key]]));
 }
 return {value,local};
};
const rowValues=rows=>rows.map(({id,value})=>({id:String(id),value:clone(value)}));
async function readCollections(storage,projectId){
 const settings=rowValues(await storage.listProject(projectId,'managed_settings')),names=settings.find(row=>row.id==='collections')?.value??[],collections={managed_settings:settings};
 for(const name of names)collections[table(name)]=rowValues(await storage.listProject(projectId,table(name)));
 return collections;
}
export async function readManagedState(storage,projectId,{offline,onCollections}={}){
 if(offline===undefined){try{await storage.requireOnline(projectId);offline=false;}catch{offline=true;}}
 const schema=await storage.getLocal(projectId,'managed:collections')??[];
 const state={schema:2,reportStateVersion:1,workspaceId:projectId,limit:1,works:[],todos:[],receipts:[],memoryPending:[]};
 const saved=offline?{managed_settings:[]}:await readCollections(storage,projectId);
 let names=schema;
 if(!offline){names=saved.managed_settings.find(row=>row.id==='collections')?.value??[];for(const row of saved.managed_settings)if(row.id!=='collections')state[row.id]=row.value;}
 else Object.assign(state,await storage.getLocal(projectId,'managed:cache:settings')??{});
 for(const key of names){const rows=offline?await storage.getLocal(projectId,'managed:cache:'+key)??[]:saved[table(key)];saved[table(key)]=rowValues(rows);const order=state.collectionOrder?.[key]??[];const byId=new Map(rows.map(row=>[row.id,row.value]));state[key]=order.filter(id=>byId.has(id)).map(id=>byId.get(id));for(const row of rows)if(!order.includes(row.id))state[key].push(row.value);}
 if(offline)saved.managed_settings=[...Object.entries(await storage.getLocal(projectId,'managed:cache:settings')??{}).map(([id,value])=>({id,value})),{id:'collections',value:names}];
 onCollections?.(clone(saved));
 for(const key of localFields){const value=await (key==='drafts'?storage.getRecovery(projectId,'managed:'+key):storage.getLocal(projectId,'managed:'+key));if(value!==null&&value!==undefined)state[key]=value;}
 for(const key of ['works','jobs'])for(const row of state[key]??[]){
  const local=await storage.getLocal(projectId,'managed:'+key+':'+row.id)??{};
  if(key==='works'&&local.closure){const {closure,...execution}=local;Object.assign(row,execution);if(row.closure)row.closure={...closure,...row.closure,...(row.closure.git?{git:{...closure.git,...row.closure.git}}:{})};}
  else Object.assign(row,local);
 }
 const timeline=await storage.getLocal(projectId,'managed:sessionIndex');if(timeline)state.sessionIndex=timeline;
 const native=await storage.getRecovery(projectId,'managed:native-facts');
 if(native){
  if(native.schema!==1||native.projectId!==projectId)throw fail('NATIVE_FACT_BINDING_CONFLICT','Native recovery facts do not belong to this project instance');
  for(const saved of native.jobs??[]){const job=state.jobs?.find(row=>row.id===saved.id);if(!job)continue;if(job.target!==saved.target)throw fail('NATIVE_FACT_BINDING_CONFLICT','Native transport target binding changed');for(const [key,value] of Object.entries(saved.local??{}))if(jobLocal.has(key))job[key]=value;}
  if(native.sessionIndex)state.sessionIndex=native.sessionIndex;
  state.sessionIndex??={};state.sessionIndex.portableMessages??=native.messages??[];
 }
 const nativeIds=new Set((state.sessionIndex?.entries??[]).map(row=>row.id));if(state.messages)state.messages=state.messages.filter(row=>!nativeIds.has(row.id));
 state.workspaceId=projectId;
 return state;
}
function snapshot(state){
 const collections={},settings={collectionOrder:{}},names=[],local=[],source=clone(state);
 if(source.sessionIndex?.portableMessages?.length){source.messages??=[];for(const message of source.sessionIndex.portableMessages)if(!source.messages.some(row=>row.id===message.id))source.messages.push(message);}
 for(const [key,value] of Object.entries(source)){
  if(localFields.has(key)||key==='sessionIndex'){if(key!=='drafts')local.push(['managed:'+key,value]);continue;}
  if(key==='contentRoot'||key==='collectionOrder')continue;
  if(Array.isArray(value)){
   names.push(key);collections[table(key)]=[];
   for(const [position,row] of value.entries()){
    const fields=key==='works'?workLocal:key==='jobs'?jobLocal:null;
    const split=fields&&row&&typeof row==='object'?splitRecord(row,fields):{value:row};
    if(split.local)local.push(['managed:'+key+':'+row.id,split.local]);
    const id=String(row?.id??position);collections[table(key)].push({id,value:split.value});(settings.collectionOrder[key]??=[]).push(id);
   }
  }else settings[key]=value;
 }
 collections.managed_settings=[...Object.entries(settings).map(([id,value])=>({id,value})),{id:'collections',value:names}];
 return {collections,settings,names,local};
}
export async function retainManagedNativeProjection(store,messages){
 if(!messages.length)return;
 const base=clone(store.committedCollections??{}),collections=clone(base),rows=collections.managed_messages??=[],added=[];
 for(const message of messages){const old=rows.find(row=>row.id===message.id);if(old){if(!equal(old.value,message))throw fail('TIMELINE_COLLISION','Portable native projection identity changed');continue;}rows.push({id:message.id,value:clone(message)});added.push(message.id);}
 if(!added.length)return;
 collections.managed_messages=rows;
 const settings=collections.managed_settings??=[];let names=settings.find(row=>row.id==='collections');if(!names){names={id:'collections',value:[]};settings.push(names);}if(!names.value.includes('messages'))names.value.push('messages');
 let order=settings.find(row=>row.id==='collectionOrder');if(!order){order={id:'collectionOrder',value:{}};settings.push(order);}order.value.messages=rows.map(row=>row.id);
 const operationId=createHash('sha256').update(JSON.stringify(messages)).digest('hex'),key='managed:pending:native:'+operationId;
 const previous=await store.storage.getRecovery(store.projectId,key);if(previous)return;
 await store.storage.putRecovery(store.projectId,key,{schema:1,kind:'business',operationId,projectId:store.projectId,base,collections,nativeMessageIds:added,status:'pending',createdAt:new Date().toISOString(),automaticReplay:false});
}
async function cacheCollections(storage,projectId,collections){
 const settings=Object.fromEntries(collections.managed_settings.filter(row=>row.id!=='collections').map(row=>[row.id,row.value])),names=collections.managed_settings.find(row=>row.id==='collections')?.value??[];
 await storage.putLocal(projectId,'managed:collections',names);await storage.putLocal(projectId,'managed:cache:settings',settings);
 for(const key of names)await storage.putLocal(projectId,'managed:cache:'+key,collections[table(key)]??[]);
}
export async function saveManagedState(store,{draftIntents=[]}={}){
 if(store.commitUnknown)throw Object.assign(fail('STORAGE_RESULT_UNKNOWN','Workspace commit outcome requires explicit reconciliation'),{commitUnknown:store.commitUnknown});
 const {storage,projectId}=store,{collections,local}=snapshot(store.state),operationId=randomUUID(),key='managed:pending:'+operationId;
 // Intent first, project commit second, draft confirmation last. A failed/unknown project write never consumes input.
 const pending={schema:1,kind:'business',operationId,projectId,collections,base:clone(store.committedCollections??{}),draftIntents:clone(draftIntents),status:'prepared',createdAt:new Date().toISOString(),automaticReplay:false};
 await storage.putRecovery(projectId,key,pending);
 try{
  await store.persistDrafts();
  for(const [id,value] of local)if(id!=='managed:sessionIndex')await storage.putLocal(projectId,id,value);
  if(store.offline)throw fail('PROJECT_UNAVAILABLE','Project unavailable; pending records retained locally');
  await storage.requireOnline(projectId);
  const expectedCollections=Object.fromEntries([...new Set([...Object.keys(pending.base),...Object.keys(collections)])].map(name=>[name,pending.base[name]??[]]));
  await storage.replaceProjectCollections(projectId,collections,{expectedCollections});
 }catch(error){
  pending.status='pending';pending.error={code:error.code,message:error.message};error.pendingId=key;
  if(error.code==='STORAGE_RESULT_UNKNOWN'||error.commitUnknown){error.commitUnknown={...error.commitUnknown,projectId,pendingId:key};pending.commitUnknown=clone(error.commitUnknown);}
  await storage.putRecovery(projectId,key,pending).catch(failure=>{error.recoveryFailure=failure;});store.offline=true;throw error;
 }
 store.committedCollections=clone(collections);
 // Post-commit bookkeeping must not roll back a business transaction which already succeeded.
 try{
  await storage.putRecovery(projectId,key,{...pending,status:'committed',committedAt:new Date().toISOString()});
  await store.persistNativeFacts();
  for(const [id,value] of local)if(id==='managed:sessionIndex')await storage.putLocal(projectId,id,value);
  await store.confirmDrafts(draftIntents);
  await cacheCollections(storage,projectId,collections);
  await storage.putRecovery(projectId,key,{...pending,status:'reconciled',committedAt:new Date().toISOString()});
 }catch(error){store.recoveryError={code:error.code,message:error.message};return {committed:true,recoveryPending:true,operationId};}
 return {committed:true,operationId};
}
export const managedRuntime=async(storage,id)=>path.join(await storage.localDirectory(id),'execution');
async function recoveryObject(storage,projectId,digest,options){
 return storage.readRecoveryObject(projectId,digest,options);
}
export async function readManagedObject(storage,projectId,digest,options={maxBytes:32*1024*1024}){
 if(!/^[a-f0-9]{64}$/.test(digest))throw Error('Invalid project object digest');
 try{await storage.requireOnline(projectId);return await storage.readObject(projectId,digest,options);}catch(projectError){
  try{return await recoveryObject(storage,projectId,digest,options);}catch(error){if(error.code==='MATERIAL_MISSING')throw projectError;throw error;}
 }
}
export async function verifyManagedObject(storage,projectId,digest){
 try{await storage.requireOnline(projectId);return await storage.verifyObject(projectId,digest);}
 catch(projectError){try{return await storage.withRecoveryObject(projectId,digest,({stat})=>({digest,byteLength:stat.size}));}catch(error){if(error.code==='MATERIAL_MISSING')throw projectError;throw error;}}
}
const pendingKind=(id,value)=>value.kind??(id.startsWith('managed:object-pending:')?'object':id.startsWith('managed:publication:')?'publication':value.collections?'business':'record');
export async function listManagedPending(storage,projectId){
 const rows=await storage.listRecovery(projectId),settledReceipts=new Map(),settledMessages=new Set();
 for(const {value} of rows)if(value.collections&&['committed','reconciled'].includes(value.status)){
  for(const row of value.collections.managed_receipts??[])settledReceipts.set(row.id,row.value.report?.digest);
  for(const row of value.collections.managed_messages??[])settledMessages.add(row.id);
 }
 return rows.filter(({id,value})=>/^managed:(pending:|object-pending:|publication:)/.test(id)&&!['reconciled','discarded'].includes(value.status)&&!(value.nativeMessageIds?.length&&value.nativeMessageIds.every(id=>settledMessages.has(id)))&&!(id.startsWith('managed:publication:')&&settledReceipts.get(value.receiptId)===value.report?.digest)).map(({id,value})=>({id,...clone(value),kind:pendingKind(id,value),automaticReplay:false,requiresConfirmation:true}));
}
function referencedObjects(value,found=new Set(),parent=''){
 if(!value||typeof value!=='object')return found;
 for(const [key,item] of Object.entries(value)){
  if(typeof item==='string'&&/^[a-f0-9]{64}$/.test(item)&&(key==='digest'&&parent==='report'||['objectDigest','reportDigest','manifestDigest','dossierDigest','dossierObjectId'].includes(key)))found.add(item);
  else if(item&&typeof item==='object')referencedObjects(item,found,key);
 }
 return found;
}
async function promoteObject(storage,projectId,digest){
 const written=await storage.promoteRecoveryObject(projectId,digest);
 if(written.digest!==digest)throw fail('RECOVERY_OBJECT_CORRUPT','Promoted object digest mismatch');
 await storage.verifyObject(projectId,digest);
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function mergeValue(base,current,candidate,at,conflicts){
 if(equal(current,candidate)||equal(base,candidate))return clone(current);
 if(equal(base,current))return clone(candidate);
 if(object(current)&&object(candidate)&&(base===undefined||object(base))){
  const value={};for(const key of new Set([...Object.keys(base??{}),...Object.keys(current),...Object.keys(candidate)])){
   const merged=mergeValue(base?.[key],current[key],candidate[key],at+'.'+key,conflicts);if(merged!==undefined)value[key]=merged;
  }return value;
 }
 conflicts.push(at);return clone(current);
}
function mergeCollections(base,current,candidate){
 const collections={},conflicts=[];
 for(const name of new Set([...Object.keys(base),...Object.keys(current),...Object.keys(candidate)])){
  const b=new Map((base[name]??[]).map(row=>[String(row.id),row.value])),c=new Map((current[name]??[]).map(row=>[String(row.id),row.value])),p=new Map((candidate[name]??base[name]??[]).map(row=>[String(row.id),row.value]));
  collections[name]=[];
  for(const id of new Set([...c.keys(),...p.keys(),...b.keys()])){
   if(name==='managed_settings'&&['collections','collectionOrder'].includes(id))continue;
   const value=mergeValue(b.get(id),c.get(id),p.get(id),name+':'+id,conflicts);if(value!==undefined)collections[name].push({id,value});
  }
 }
 const names=[...new Set([...((current.managed_settings??[]).find(row=>row.id==='collections')?.value??[]),...((candidate.managed_settings??[]).find(row=>row.id==='collections')?.value??[])])];
 const order=Object.fromEntries(names.map(name=>[name,(collections[table(name)]??[]).map(row=>row.id)]));
 (collections.managed_settings??=[]).push({id:'collections',value:names},{id:'collectionOrder',value:order});
 return {collections,conflicts};
}
function inspectionOnly(collections,base,candidate){
 // Reconciliation publishes retained facts, never resumes an interrupted native owner or queued model request.
 for(const name of ['managed_jobs','managed_works'])for(const row of collections[name]??[]){
  const prior=(base[name]??[]).find(item=>item.id===row.id)?.value,proposed=(candidate[name]??[]).find(item=>item.id===row.id)?.value;
  if(equal(prior,proposed))continue;
  if(name==='managed_jobs'&&['queued','running','transferring'].includes(row.value.status))Object.assign(row.value,{status:'interrupted',recoveryRequiresExplicitInput:true,automaticReplay:false});
  if(name==='managed_works'&&['queued','running'].includes(row.value.status))Object.assign(row.value,{status:'paused',recoveryRequiresExplicitInput:true,automaticReplay:false});
 }
}
const sameCollections=(a,b)=>Object.keys(b).every(name=>{
 const left=new Map((a[name]??[]).map(row=>[String(row.id),row.value])),right=b[name]??[];
 return left.size===right.length&&right.every(row=>equal(left.get(String(row.id)),row.value));
});
const reconcileFlights=new WeakMap();
export async function reconcileManagedPending(storage,projectId,{pendingId,requestKey,confirmed}={}){
 if(confirmed!==true||typeof pendingId!=='string'||typeof requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(requestKey))throw fail('RECOVERY_CONFIRM_REQUIRED','Explicit pending record and confirmation request key required');
 let flights=reconcileFlights.get(storage);if(!flights)reconcileFlights.set(storage,flights=new Map());
 const previous=flights.get(projectId)??Promise.resolve(),run=previous.catch(()=>{}).then(async()=>{
  const receiptKey='managed:reconcile:'+requestKey,previous=await storage.getRecovery(projectId,receiptKey);
  if(previous){if(previous.pendingId!==pendingId)throw fail('REQUEST_KEY_COLLISION','Recovery request key already used');if(previous.result)return previous.result;}
  const pending=await storage.getRecovery(projectId,pendingId);
  if(!pending||!/^managed:(pending:|object-pending:|publication:)/.test(pendingId))throw fail('RECOVERY_PENDING_MISSING','Pending record not found');
  if(pending.status==='reconciled')return {accepted:true,status:'reconciled',pendingId,requestKey,automaticReplay:false,duplicate:true};
  await storage.putRecovery(projectId,receiptKey,{pendingId,requestKey,status:'prepared'});
  await storage.requireOnline(projectId);
  const kind=pendingKind(pendingId,pending),promotedObjects=[];
  let merged,current,alreadyCommitted=false;
  if(kind==='business'){
   if(!pending.base)throw fail('RECOVERY_BASE_MISSING','Legacy candidate has no safe merge baseline; retain for inspection');
   current=await readCollections(storage,projectId);
   if(pending.reconcilePlan){
    merged=pending.reconcilePlan.collections;alreadyCommitted=sameCollections(current,merged);
    if(!alreadyCommitted&&!sameCollections(current,pending.reconcilePlan.expectedCollections))return {accepted:false,status:'conflict',pendingId,requestKey,automaticReplay:false,conflicts:['Project changed after recovery intent']};
   }else{
    const outcome=mergeCollections(pending.base,current,pending.collections);merged=outcome.collections;
    if(outcome.conflicts.length)return {accepted:false,status:'conflict',pendingId,requestKey,automaticReplay:false,conflicts:outcome.conflicts};
    inspectionOnly(merged,pending.base,pending.collections);
    pending.reconcilePlan={collections:merged,expectedCollections:Object.fromEntries(Object.keys(merged).map(name=>[name,current[name]??[]]))};
    await storage.putRecovery(projectId,pendingId,pending);
   }
  }else if(kind!=='object')return {accepted:false,status:'conflict',pendingId,requestKey,automaticReplay:false,conflicts:['Candidate lacks a complete business transaction; inspect retained result']};
  const digests=kind==='object'?new Set([pending.digest]):referencedObjects(merged);
  for(const digest of digests){await promoteObject(storage,projectId,digest);promotedObjects.push(digest);}
  if(merged&&!alreadyCommitted){
   try{await storage.replaceProjectCollections(projectId,merged,{expectedCollections:pending.reconcilePlan.expectedCollections});}catch(error){if(error.code==='STORAGE_CONFLICT')return {accepted:false,status:'conflict',pendingId,requestKey,automaticReplay:false,conflicts:['Project changed during reconciliation']};throw error;}
  }
  const result={accepted:true,status:'reconciled',pendingId,requestKey,automaticReplay:false,promotedObjects};
  if(merged)try{await cacheCollections(storage,projectId,merged);}catch(error){return {...result,recoveryPending:true,cacheError:{code:error.code,message:error.message}};}
  await storage.putRecovery(projectId,pendingId,{...pending,status:'reconciled',reconciledAt:new Date().toISOString(),result});
  await storage.putRecovery(projectId,receiptKey,{pendingId,requestKey,status:'complete',result});
  const operationId=pending.operationId;await storage.putRecovery(projectId,'managed:pending-receipt:'+operationId,{operationId,pendingId,requestKey,status:'complete',result});
  return result;
 });
 flights.set(projectId,run);try{return await run;}finally{if(flights.get(projectId)===run)flights.delete(projectId);}
}
