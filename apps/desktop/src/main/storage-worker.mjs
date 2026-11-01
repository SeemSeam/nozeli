import {parentPort} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const databases=new Map(),identities=new Map();
const stamp=file=>{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw Object.assign(Error('数据库实体无效'),{code:'PROJECT_METADATA_CONFLICT'});return String(s.dev)+':'+String(s.ino);};
const conflict=()=>Object.assign(Error('STORAGE_CONFLICT'),{code:'STORAGE_CONFLICT'});
const keyEncodings=new Map();
function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>{let encoded=keyEncodings.get(key);if(encoded===undefined){encoded=JSON.stringify(key);if(keyEncodings.size<8192)keyEncodings.set(key,encoded);}return encoded+':'+canonical(value[key]);}).join(',')+'}';
 return JSON.stringify(value);
}
// Logical request identity only: execution constraints (generation fencing in
// ProjectStorage, mustExist open mode) are validated separately and must not
// change the fingerprint, or a loss+retry of the same logical operation would
// be misjudged as a different request after the generation advances.
function fingerprint(op,args){const {operationId,generation,mustExist,...request}=args;return createHash('sha256').update(canonical(JSON.parse(JSON.stringify({op,args:request})))).digest('hex');}
function checkCollections(db,expectedCollections){
 for(const [collection,expected]of Object.entries(expectedCollections)){
  if(!Array.isArray(expected))throw Error('INVALID_COLLECTION');
  // Expectations must undergo the same JSON conversion as stored record values.
  const rows=db.prepare('SELECT id,value FROM records WHERE collection=?').all(collection),actual=new Map();
  for(const row of rows){const id=String(row.id);if(actual.has(id))throw conflict();actual.set(id,row.value);}
  const seen=new Set();
  for(const row of expected){
   const id=String(row.id);if(seen.has(id))throw conflict();seen.add(id);
   const stored=actual.get(id),serialized=JSON.stringify(row.value);
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
 if(db){try{if(stamp(file)!==identities.get(file))throw Error('database identity changed');return db;}catch(cause){db.close();databases.delete(file);identities.delete(file);throw Object.assign(Error('数据库路径已消失或替换，禁止沿旧句柄继续写入'),{code:'PROJECT_METADATA_CONFLICT',cause});}}
 const existed=fs.existsSync(file),before=mustExist?stamp(file):null,uri=pathToFileURL(file);uri.searchParams.set('mode','rw');db=new DatabaseSync(mustExist?uri.href:file);
 try{
  if(mustExist&&stamp(file)!==before)throw Object.assign(Error('数据库实体在打开时改变'),{code:'PROJECT_METADATA_CONFLICT'});
  if(existed){const records=db.prepare('PRAGMA table_info(records)').all(),receipts=db.prepare('PRAGMA table_info(operation_receipts)').all();if(!['collection','id','value','revision'].every(name=>records.some(column=>column.name===name))||!['id','result'].every(name=>receipts.some(column=>column.name===name))||!receipts.some(column=>column.name==='fingerprint'&&column.notnull===1))throw Object.assign(Error('数据库格式不受支持；未迁移或修改原数据库'),{code:'STORAGE_FORMAT_UNSUPPORTED'});}
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1500; CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(collection,id)); CREATE TABLE IF NOT EXISTS operation_receipts(id TEXT PRIMARY KEY,result TEXT NOT NULL,fingerprint TEXT NOT NULL);');
  identities.set(file,stamp(file));databases.set(file,db);return db;
 }catch(error){db.close();throw error;}
}
parentPort.on('message',({id,file,op,args})=>{try{const db=open(file,args);let value;
 if(op==='get')value=JSON.parse(db.prepare('SELECT value FROM records WHERE collection=? AND id=?').get(args.collection,args.id)?.value??'null');
 else if(op==='record'){const r=db.prepare('SELECT value,revision FROM records WHERE collection=? AND id=?').get(args.collection,args.id);value=r?{value:JSON.parse(r.value),revision:r.revision}:null;}
 else if(op==='list')value=db.prepare('SELECT id,value,revision FROM records WHERE collection=? ORDER BY id').all(args.collection).map(r=>({...r,value:JSON.parse(r.value)}));
 else if(op==='all')value=db.prepare('SELECT collection,id,value,revision FROM records ORDER BY collection,id').all().map(r=>({...r,value:JSON.parse(r.value)}));
 else if(op==='receipt')value=JSON.parse(db.prepare('SELECT result FROM operation_receipts WHERE id=?').get(args.operationId)?.result??'null');
 else if(['put','delete','replace'].includes(op)){
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
    if(databases.get(file)===db){databases.delete(file);identities.delete(file);}
    try{db.close();}catch(closeFailure){error.closeFailure={code:closeFailure.code,message:closeFailure.message};}
   }
   throw error;
  }
 }else throw Error('UNKNOWN_STORAGE_OP');
 parentPort.postMessage({id,value});
}catch(error){parentPort.postMessage({id,error:{code:error.code??'STORAGE_FAILED',message:error.message,rollbackFailure:error.rollbackFailure,closeFailure:error.closeFailure}});}});
