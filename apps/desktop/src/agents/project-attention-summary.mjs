import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {managedInboxTodos} from '../domain/managed-work-records.mjs';
import {decodeReportState} from './managed/report-descriptor.mjs';
import {migrateReviewLifecycle} from './managed/review-lifecycle.mjs';

const collections=['works','jobs','todos','receipts'];
const fail=code=>Object.assign(Error(code),{code});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const facts=state=>Object.fromEntries(collections.map(key=>[key,state[key]]));
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function validateState(state){
 if(!object(state)||collections.some(key=>!Array.isArray(state[key])||state[key].some(row=>!object(row)||typeof row.id!=='string')))throw fail('ATTENTION_FACTS_INCOMPLETE');
 return state;
}
async function directory(root,expected){
 const stat=await fs.lstat(root);
 if(!expected||!stat.isDirectory()||stat.isSymbolicLink()||String(stat.dev)!==String(expected.dev)||String(stat.ino)!==String(expected.ino)||await fs.realpath(root)!==root)throw fail('PROJECT_IDENTITY_CONFLICT');
}
// Deliberately not requireOnline: its failure path invalidates the project and
// stops owners. A sidebar read must never enter that lifecycle mutation path.
async function available(storage,project){
 storage.assertActive?.(project.id);
 if(storage.unavailable?.has(project.id))throw fail('PROJECT_UNAVAILABLE');
 await directory(project.root,project.identity);
 await directory(project.metadataRoot,project.metadataIdentity);
 for(const name of ['project.json','project.sqlite','project.sqlite-journal','project.sqlite-wal','project.sqlite-shm']){
  let stat;try{stat=await fs.lstat(path.join(project.metadataRoot,name));}catch(error){if(error.code==='ENOENT'&&!['project.json','project.sqlite'].includes(name))continue;throw error;}
  if(!stat.isFile()||stat.isSymbolicLink())throw fail('PROJECT_METADATA_CONFLICT');
 }
 const manifest=JSON.parse(await fs.readFile(path.join(project.metadataRoot,'project.json'),'utf8'));
 if(manifest.schema!==1||manifest.projectId!==project.id)throw fail('PROJECT_IDENTITY_CONFLICT');
 const stat=await fs.lstat(path.join(project.metadataRoot,'project.sqlite'));
 return String(stat.dev)+':'+String(stat.ino);
}
function readDatabase(file,read){
 const db=new DatabaseSync(file,{readOnly:true});
 try{return read(db);}finally{db.close();}
}
async function recorded(storage,project){
 const file=path.join(project.metadataRoot,'project.sqlite');
 // The readOnly handle cannot initialize schemas, switch journal mode or
 // create a missing database (the normal worker's open path can do so).
 const {settings,rows}=readDatabase(file,db=>{
  db.exec('BEGIN');
  const list=collection=>db.prepare('SELECT id,value FROM records WHERE collection=? ORDER BY id').all(collection).map(row=>({...row,value:JSON.parse(row.value)}));
  const settings=list('managed_settings'),rows=Object.fromEntries(collections.map(key=>[key,list('managed_'+key)]));
  db.exec('COMMIT');return {settings,rows};
 });
 const saved=Object.fromEntries(settings.map(row=>[row.id,row.value]));
 if(!settings.length){
  if(collections.some(key=>rows[key].length))throw fail('ATTENTION_FACTS_INCOMPLETE');
  return {schema:2,reportStateVersion:1,...Object.fromEntries(collections.map(key=>[key,[]]))};
 }
 if(saved.schema!==2||saved.reportStateVersion!==1||!Array.isArray(saved.collections)||collections.some(key=>!saved.collections.includes(key)))throw fail('ATTENTION_FACTS_INCOMPLETE');
 const state={schema:saved.schema,reportStateVersion:saved.reportStateVersion};
 for(const key of collections){
  const order=saved.collectionOrder?.[key]??[],byId=new Map(rows[key].map(row=>[row.id,row.value]));
  if(!Array.isArray(order)||order.some(id=>!byId.has(id)))throw fail('ATTENTION_FACTS_INCOMPLETE');
  state[key]=[...order.map(id=>byId.get(id)),...rows[key].filter(row=>!order.includes(row.id)).map(row=>row.value)];
 }
 return validateState(decodeReportState(state));
}
async function ledger(storage,id){
 // Unlike getLocal / AttentionLedger.read, this never creates the instance
 // directory or ui database and never queues an update/observe operation.
 const project=await storage.requireRegistered(id),file=path.join(storage.root,'instances',project.instanceId,'ui.sqlite');
 let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return {todos:[]};throw error;}
 if(!stat.isFile()||stat.isSymbolicLink())throw fail('PROJECT_METADATA_CONFLICT');
 const record=readDatabase(file,db=>{
  const row=db.prepare('SELECT value FROM records WHERE collection=? AND id=?').get('ui','managed:attention');
  if(row&&Buffer.byteLength(row.value)>32*1024*1024)throw fail('LOCAL_RECORD_TOO_LARGE');
  return row?{value:JSON.parse(row.value)}:null;
 });
 if(!record)return {todos:[]};
 const value=record.value;
 if(!object(value)||!Array.isArray(value.todos)||value.todos.some(todo=>!object(todo)||typeof todo.id!=='string'))throw fail('ATTENTION_FACTS_INCOMPLETE');
 return value;
}
export async function projectAttentionSummary(manager,payload){
 if(!object(payload)||![Object.prototype,null].includes(Object.getPrototypeOf(payload))||Object.keys(payload).some(key=>key!=='projectIds'))throw fail('INVALID_PAYLOAD');
 const ids=payload?.projectIds;
 if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||!id||id.trim()!==id||id.length>200))throw fail('INVALID_PAYLOAD');
 const storage=manager.host.storage;
 const projects=await Promise.all([...new Set(ids)].map(async projectId=>{
  let instanceId=null;
  try{
   const project=await storage.requireRegistered(projectId);instanceId=project.instanceId;
   if(project.id!==projectId||typeof instanceId!=='string'||!instanceId||project.removed)throw fail('PROJECT_IDENTITY_CONFLICT');
   const generation=storage.generations?.get(projectId)??0,controller=manager.controllers.get(projectId);
   if(controller?.stopping)throw fail('PROJECT_STOPPING');
   const sourceIdentity=await available(storage,project);
   const state=controller?validateState(structuredClone(controller.snapshot())):await recorded(storage,project);
   const before=hash(facts(state)),attention=await ledger(storage,projectId);
   const after=controller?validateState(controller.snapshot()):await recorded(storage,project);
   if(before!==hash(facts(after))||hash(attention.todos)!==hash((await ledger(storage,projectId)).todos))throw fail('ATTENTION_FACTS_CHANGED');
   const current=await storage.requireRegistered(projectId);
   if(sourceIdentity!==await available(storage,project))throw fail('PROJECT_IDENTITY_CONFLICT');
   if(current.instanceId!==instanceId||current.root!==project.root||current.metadataRoot!==project.metadataRoot||current.removed||manager.controllers.get(projectId)!==controller||controller?.stopping||generation!==(storage.generations?.get(projectId)??0))throw fail('PROJECT_IDENTITY_CONFLICT');
   // Same replacement rule as attentionState; the instance ledger, not an
   // old copy embedded in a controller snapshot, owns these reminders.
   state.todos=[...state.todos.filter(todo=>todo.origin!=='instance-attention'),...attention.todos];
   migrateReviewLifecycle(state);
   const pendingCount=new Set(managedInboxTodos(state).filter(todo=>todo.pending).map(todo=>todo.id)).size;
   return {projectId,instanceId,revision:hash({instanceId,business:facts(state)}),pendingCount,complete:true,observedAt:new Date().toISOString(),freshness:'live'};
  }catch(error){
   // No native messages, paths or credentials cross this narrow DTO boundary.
   const errorCode=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)?error.code:'ATTENTION_SUMMARY_UNAVAILABLE';
   return {projectId,instanceId,revision:hash({instanceId,errorCode}),pendingCount:null,complete:false,observedAt:new Date().toISOString(),freshness:'unknown',errorCode};
  }
 }));
 return {projects};
}
