import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {canonical,fingerprint} from './storage-request-fingerprint.mjs';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {openExperimentalDatabaseLease} from '../platform/windows/experimental-database.mjs';
import {recoveryRead,managedResourceSummary,managedExecutionSummary} from './storage-recovery.mjs';
import {collaborationFacts} from './storage-collaboration.mjs';
import {maintenanceFacts} from './storage-maintenance.mjs';

const databases=new Map(),identities=new Map(),nativeIdentities=new Map();
const leases=new Map(),privateRoot=workerData?.experimentalWindowsRoot;
const verifyLease=file=>leases.get(file)?.verify();
function retire(file,db){
 // Release native namespace pins only after SQLite has actually closed.
 db.close();databases.delete(file);identities.delete(file);
 leases.get(file)?.close();leases.delete(file);
}
const reply=message=>workerData.replyPort.postMessage({...message,completedAt:process.hrtime.bigint()});
function errorEvidence(error,depth=0){
 if(!error||depth>=8)return undefined;
 const evidence={};
 for(const key of ['code','win32Code','errno','syscall'])if(['string','number'].includes(typeof error[key]))evidence[key]=error[key];
 if(error.cause&&error.cause!==error)evidence.cause=errorEvidence(error.cause,depth+1);
 return evidence;
}
const stamp=file=>{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw Object.assign(Error('数据库实体无效'),{code:'PROJECT_METADATA_CONFLICT'});return String(s.dev)+':'+String(s.ino);};
const conflict=()=>Object.assign(Error('STORAGE_CONFLICT'),{code:'STORAGE_CONFLICT'});
function checkCollections(db,expectedCollections){
 for(const [collection,expected]of Object.entries(expectedCollections)){
  if(!Array.isArray(expected))throw Error('INVALID_COLLECTION');
  // Expectations must undergo the same JSON conversion as stored record values.
  const rows=db.prepare('SELECT id,value,revision FROM records WHERE collection=?').all(collection),actual=new Map();
  for(const row of rows){const id=String(row.id);if(actual.has(id))throw conflict();actual.set(id,row);}
  const seen=new Set();
  for(const row of expected){
   const id=String(row.id);if(seen.has(id))throw conflict();seen.add(id);
   const original=actual.get(id),stored=original?.value,serialized=JSON.stringify(row.value);
   if(row.revision!==undefined&&(!Number.isSafeInteger(row.revision)||row.revision<1||original?.revision!==row.revision))throw conflict();
   // Byte-identical serialization implies canonical equality; anything else
   // falls back to the order-insensitive canonical comparison of both sides.
   if(stored!==serialized&&(stored===undefined||canonical(JSON.parse(JSON.stringify(row.value)))!==canonical(JSON.parse(stored))))throw conflict();
   actual.delete(id);
  }
  if(actual.size)throw conflict();
 }
}
function open(file,{mustExist=false}={}){
 let db=databases.get(file);
 if(db){try{verifyLease(file);if(stamp(file)!==identities.get(file))throw Error('database identity changed');return db;}catch(cause){try{retire(file,db);}catch(closeFailure){throw Object.assign(Error('数据库身份失效且关闭未确认',{cause}),{code:'STORAGE_RESULT_UNKNOWN',closeFailure:{code:closeFailure.code,message:closeFailure.message}});}throw Object.assign(Error('数据库路径已消失或替换，禁止沿旧句柄继续写入'),{code:'PROJECT_METADATA_CONFLICT',cause});}}
 let lease;
 try{
  if(privateRoot!==undefined)lease=openExperimentalDatabaseLease(privateRoot,file,{mustExist});
  const existed=lease?!lease.created:fs.existsSync(file),before=mustExist?stamp(file):null,uri=pathToFileURL(lease?.path??file);uri.searchParams.set('mode','rw');
  db=new DatabaseSync(mustExist?uri.href:(lease?.path??file));
  if(mustExist&&stamp(file)!==before)throw Object.assign(Error('数据库实体在打开时改变'),{code:'PROJECT_METADATA_CONFLICT'});
  if(existed){const records=db.prepare('PRAGMA table_info(records)').all(),receipts=db.prepare('PRAGMA table_info(operation_receipts)').all();if(!['collection','id','value','revision'].every(name=>records.some(column=>column.name===name))||!['id','result'].every(name=>receipts.some(column=>column.name===name))||!receipts.some(column=>column.name==='fingerprint'&&column.notnull===1))throw Object.assign(Error('数据库格式不受支持；未迁移或修改原数据库'),{code:'STORAGE_FORMAT_UNSUPPORTED'});}
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1500; CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(collection,id)); CREATE TABLE IF NOT EXISTS operation_receipts(id TEXT PRIMARY KEY,result TEXT NOT NULL,fingerprint TEXT NOT NULL);');
  lease?.verify();
  identities.set(file,stamp(file));if(lease)nativeIdentities.set(file,lease.identity());databases.set(file,db);if(lease)leases.set(file,lease);return db;
 }catch(error){
  if(db)try{db.close();}catch(closeFailure){
   // Keep the lease reachable until this worker is confirmed dead. A failed
   // SQLite close cannot authorize releasing namespace protection.
   databases.set(file,db);if(lease)leases.set(file,lease);
   throw Object.assign(Error('数据库打开失败且关闭未确认',{cause:error}),{code:'STORAGE_RESULT_UNKNOWN',closeFailure:{code:closeFailure.code,message:closeFailure.message}});
  }
  lease?.close();throw error;
 }
}
parentPort.on('message',({id,file,op,args})=>{try{const db=open(file,args);let value;
 if(['recoveryPage','recoveryRecord','recoveryChunk'].includes(op))value=recoveryRead(db,identities.get(file),op,args);
 else if(op==='managedResourceSummary')value=managedResourceSummary(db,args);
 else if(op==='managedExecutionSummary')value=managedExecutionSummary(db);
 else if(op==='managedAgentPage')value=collaborationFacts(db,identities.get(file),args);
 else if(op==='managedMaintenancePage')value=maintenanceFacts(db,identities.get(file),args);
 else if(op==='boundedRecord'){const row=db.prepare('SELECT revision,length(CAST(value AS BLOB)) bytes FROM records WHERE collection=? AND id=?').get(args.collection,args.id);if(row&&row.bytes>(args.maxBytes??131072))throw Object.assign(Error('本机记录超过读取预算'),{code:'LOCAL_RECORD_TOO_LARGE'});value=row?{revision:row.revision,value:JSON.parse(db.prepare('SELECT value FROM records WHERE collection=? AND id=?').get(args.collection,args.id).value)}:null;}
 else if(op==='get')value=JSON.parse(db.prepare('SELECT value FROM records WHERE collection=? AND id=?').get(args.collection,args.id)?.value??'null');
 else if(op==='record'){const r=db.prepare('SELECT value,revision FROM records WHERE collection=? AND id=?').get(args.collection,args.id);value=r?{value:JSON.parse(r.value),revision:r.revision}:null;}
 else if(op==='list')value=db.prepare('SELECT id,value,revision FROM records WHERE collection=? ORDER BY id').all(args.collection).map(r=>({...r,value:JSON.parse(r.value)}));
 else if(op==='boundedList'){
  const {maxRecords,maxBytes,collection}=args;
  if(typeof collection!=='string'||!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>16384||
     !Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024)throw Object.assign(Error('Invalid bounded collection request'),{code:'LOCAL_READ_LIMIT_INVALID'});
  // Measure raw UTF-8 before loading or parsing any value. This also refuses
  // an oversized/corrupt contender without exporting its payload to the host.
  db.exec('BEGIN');
  try{
   const size=db.prepare('SELECT count(*) records,coalesce(sum(length(CAST(id AS BLOB))+length(CAST(value AS BLOB))+64),0) bytes FROM records WHERE collection=?').get(collection);
   if(size.records>maxRecords||size.bytes>maxBytes)throw Object.assign(Error('Local collection exceeds its read budget'),{code:'LOCAL_COLLECTION_TOO_LARGE'});
   value=db.prepare('SELECT id,value,revision FROM records WHERE collection=? ORDER BY id').all(collection).map(r=>({...r,value:JSON.parse(r.value)}));
   db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
 }
 else if(op==='all')value=db.prepare('SELECT collection,id,value,revision FROM records ORDER BY collection,id').all().map(r=>({...r,value:JSON.parse(r.value)}));
 else if(op==='receipt')value=JSON.parse(db.prepare('SELECT result FROM operation_receipts WHERE id=?').get(args.operationId)?.result??'null');
 else if(op==='compareAndPutReceipt'){
  // Verify the original committed request without submitting it again.
  const {comparison}=args;
  if(!comparison||Object.keys(comparison).length!==2||!comparison.expectedCollections||!Array.isArray(comparison.records)||
     Buffer.byteLength(JSON.stringify(comparison))>32*1024*1024)
   throw Object.assign(Error('Invalid comparison receipt request'),{code:'INVALID_COMPARE_BATCH'});
  const row=db.prepare('SELECT result,fingerprint FROM operation_receipts WHERE id=?').get(args.operationId);
  if(row&&row.fingerprint!==fingerprint('compareAndPut',comparison))throw Object.assign(Error('原提交回执绑定了不同的请求'),{code:'STORAGE_OPERATION_CONFLICT'});
  value=row?JSON.parse(row.result):null;
 }
 else if(['put','putMany','compareAndPut','delete','replace'].includes(op)){
  const identity=fingerprint(op,args);db.exec('BEGIN IMMEDIATE');
  try{
   const priorReceipt=db.prepare('SELECT result,fingerprint FROM operation_receipts WHERE id=?').get(args.operationId);
   if(priorReceipt){
    if(priorReceipt.fingerprint!==identity)throw Object.assign(Error('操作标识已绑定不同存储请求'),{code:'STORAGE_OPERATION_CONFLICT'});
    value=JSON.parse(priorReceipt.result);
   }else{
    if(op==='put'){
     const prior=db.prepare('SELECT revision FROM records WHERE collection=? AND id=?').get(args.collection,args.id);
     if(args.expectedRevision!==undefined&&(prior?.revision??0)!==args.expectedRevision)throw conflict();
     db.prepare('INSERT INTO records(collection,id,value) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value,revision=records.revision+1').run(args.collection,args.id,JSON.stringify(args.value));value={revision:(prior?.revision??0)+1};
    }else if(op==='putMany'){
     if(!Array.isArray(args.records)||!args.records.length||args.records.length>20001)throw Error('INVALID_RECORD_BATCH');
     const seen=new Set(),select=db.prepare('SELECT revision FROM records WHERE collection=? AND id=?'),write=db.prepare('INSERT INTO records(collection,id,value) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value,revision=records.revision+1');
     // Check the entire read set before any write. A concurrent target edit
     // must never allow the original source draft to be cleared separately.
     for(const row of args.records){if(typeof row.id!=='string'||!row.id||seen.has(row.id)||!Number.isSafeInteger(row.expectedRevision)||row.expectedRevision<0||row.value===undefined)throw Error('INVALID_RECORD_BATCH');seen.add(row.id);if((select.get(args.collection,row.id)?.revision??0)!==row.expectedRevision)throw conflict();}
     const revisions=[];for(const row of args.records){write.run(args.collection,row.id,JSON.stringify(row.value));revisions.push({id:row.id,revision:row.expectedRevision+1});}value={revisions};
    }else if(op==='compareAndPut'){
     const expected=args.expectedCollections,names=expected&&typeof expected==='object'&&!Array.isArray(expected)?Object.keys(expected):[];
     const invalid=()=>Object.assign(Error('INVALID_COMPARE_BATCH'),{code:'INVALID_COMPARE_BATCH'});
     if(!names.length||names.length>8||!Array.isArray(args.records)||!args.records.length||args.records.length>256||
        Buffer.byteLength(JSON.stringify({expectedCollections:expected,records:args.records}))>32*1024*1024)throw invalid();
     const originals=new Map();let rows=0,bytes=0,expectedRowsCount=0;
     const measure=db.prepare('SELECT count(*) records,coalesce(sum(length(CAST(id AS BLOB))+length(CAST(value AS BLOB))+64),0) bytes FROM records WHERE collection=?');
     for(const name of names){
      if(!name||!Array.isArray(expected[name]))throw invalid();
      expectedRowsCount+=expected[name].length;if(expectedRowsCount>16384)throw invalid();
      const actual=measure.get(name);rows+=actual.records;bytes+=actual.bytes;
      if(rows>16384||bytes>32*1024*1024)throw conflict();
      const ids=new Map();originals.set(name,ids);
      for(const row of expected[name]){
       if(typeof row.id!=='string'||!row.id||ids.has(row.id)||!Number.isSafeInteger(row.revision)||row.revision<1||row.value===undefined)throw invalid();
       ids.set(row.id,row.revision);
      }
     }
     const seen=new Map();
     for(const row of args.records){
      const expectedRows=originals.get(row.collection);
      if(!expectedRows||typeof row.id!=='string'||!row.id||row.value===undefined||
         !Number.isSafeInteger(row.expectedRevision)||row.expectedRevision<0||row.expectedRevision>=Number.MAX_SAFE_INTEGER||
         row.expectedRevision!==(expectedRows.get(row.id)??0))throw invalid();
      const ids=seen.get(row.collection)??new Set();if(ids.has(row.id))throw invalid();ids.add(row.id);seen.set(row.collection,ids);
     }
     // Every compared collection includes its entire membership and original
     // revisions. Validate the complete read set before touching any row.
     checkCollections(db,expected);
     const write=db.prepare('INSERT INTO records(collection,id,value) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value,revision=records.revision+1');
     const revisions=[];
     for(const row of args.records){write.run(row.collection,row.id,JSON.stringify(row.value));revisions.push({collection:row.collection,id:row.id,revision:row.expectedRevision+1});}
     value={committed:true,revisions};
    }else if(op==='delete'){db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(args.collection,args.id);value={deleted:true};}
    else {
     if(args.expectedCollections!==undefined)checkCollections(db,args.expectedCollections);
     // Delta application replaces DELETE+re-INSERT of every row with the
     // minimal equivalent write set; final table state (rows, values and
     // revision=1 for every kept row) is exactly the full-rewrite result.
     const select=db.prepare('SELECT id,value,revision FROM records WHERE collection=?'),insert=db.prepare('INSERT INTO records(collection,id,value) VALUES(?,?,?)'),update=db.prepare('UPDATE records SET value=?,revision=1 WHERE collection=? AND id=?'),remove=db.prepare('DELETE FROM records WHERE collection=? AND id=?');
     for(const [collection,rows]of Object.entries(args.collections)){
      if(!Array.isArray(rows))throw Error('INVALID_COLLECTION');
      const existing=new Map(select.all(collection).map(row=>[row.id,row])),keep=new Set();
      for(const row of rows){
       const id=String(row.id),text=JSON.stringify(row.value);
       if(keep.has(id))throw Object.assign(Error('UNIQUE constraint failed: records.collection, records.id'),{code:'STORAGE_FAILED'});
       keep.add(id);
       const prior=existing.get(id);
       if(prior){if(prior.revision===1&&prior.value===text)continue;update.run(text,collection,id);}
       else insert.run(collection,id,text);
      }
      for(const id of existing.keys())if(!keep.has(id))remove.run(collection,id);
     }
     value={committed:true};
    }
    if(stamp(file)!==identities.get(file))throw Object.assign(Error('数据库路径已变化'),{code:'PROJECT_METADATA_CONFLICT'});
    verifyLease(file);
    db.prepare('INSERT INTO operation_receipts(id,result,fingerprint) VALUES(?,?,?)').run(args.operationId,JSON.stringify(value),identity);
   }
   db.exec('COMMIT');
  }catch(error){
   try{db.exec('ROLLBACK');}
   catch(rollback){
    // SQLite may already have rolled the transaction back automatically (disk
    // full / IO error); the original failure stays authoritative and a failed
    // rollback attempt must never mask it.
    error.rollbackFailure={code:rollback.code,message:rollback.message};
    // Transaction state is unknown: retire the connection instead of reusing a
    // handle that may still hold an open transaction.
    try{retire(file,db);}catch(closeFailure){throw Object.assign(Error('数据库回滚及关闭未确认',{cause:error}),{code:'STORAGE_RESULT_UNKNOWN',rollbackFailure:error.rollbackFailure,closeFailure:{code:closeFailure.code,message:closeFailure.message}});}
   }
   throw error;
  }
 }else throw Error('UNKNOWN_STORAGE_OP');
 try{verifyLease(file);}catch(cause){
  // An acknowledged SQL COMMIT may already exist. Fence this generation and
  // reconcile its operation receipt explicitly; never replay or report abort.
  throw Object.assign(Error('数据库操作后原生身份核验失败，结果待核查',{cause}),{code:'STORAGE_RESULT_UNKNOWN'});
 }
 reply({id,value});
}catch(error){reply({id,error:{code:error.code??'STORAGE_FAILED',message:error.message,rollbackFailure:error.rollbackFailure,closeFailure:error.closeFailure,evidence:errorEvidence(error),sourceIdentity:{node:identities.get(file)??null,native:nativeIdentities.get(file)??null}}});}});
