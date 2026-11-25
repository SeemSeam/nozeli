import {createHash,randomUUID} from 'node:crypto';
import {workSlotFacts} from '../agents/managed/workspace.mjs';

const incarnations=new WeakMap();
const fail=(code)=>Object.assign(Error(code),{code});
const bounded=(value,fallback,max)=>{if(value===undefined)return fallback;if(!Number.isSafeInteger(value)||value<=0)throw fail('RECOVERY_BUDGET_INVALID');return Math.min(value,max);};
const safe=alias=>`CASE WHEN json_valid(${alias}.value) THEN ${alias}.value ELSE '{}' END`;
const scalar=(alias,key)=>`CASE json_type(${safe(alias)},'$.${key}') WHEN 'text' THEN substr(json_extract(${safe(alias)},'$.${key}'),1,128) WHEN 'integer' THEN json_extract(${safe(alias)},'$.${key}') WHEN 'real' THEN json_extract(${safe(alias)},'$.${key}') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END`;
const fields=['kind','status','projectId','operationId','createdAt','retainedAt','committedAt','reconciledAt','receiptId','relPath','recoveryKind','name','instanceId','root','removed','phase','action','destination','clipboardImport','crossTransfer','sameProject'];
const statuses=new Set(['prepared','pending','committed','reconciled','discarded','complete','interrupted','retained']);
const kinds=new Set(['business','object','publication','record','local-view-backup','workspace','draft','file']);
function crossRegistryScope(){
 const value=safe('r');
 const uuid=key=>{const text=`json_extract(${value},'$.${key}')`;return `(json_type(${value},'$.${key}')='text' AND length(${text})=36 AND substr(${text},9,1)='-' AND substr(${text},14,1)='-' AND substr(${text},19,1)='-' AND substr(${text},24,1)='-' AND length(replace(${text},'-',''))=32 AND ${text} NOT GLOB '*[^a-f0-9-]*')`;};
 return `coalesce(json_valid(r.value) AND json_extract(${value},'$.schema')=1 AND json_type(${value},'$.schema')='integer' AND json_type(${value},'$.crossTransfer')='true' AND json_extract(${value},'$.kind')='record' AND ${uuid('projectId')} AND ${uuid('sourceProjectId')} AND ${uuid('operationId')} AND json_extract(${value},'$.projectId')!=json_extract(${value},'$.sourceProjectId') AND r.id='tree-operation:'||json_extract(${value},'$.operationId'),0)`;
}
function version(db,identity,args){let incarnation=incarnations.get(db);if(!incarnation)incarnations.set(db,incarnation=randomUUID());return createHash('sha256').update(JSON.stringify([incarnation,identity,args.projectId,args.instanceId,args.purpose,db.prepare('PRAGMA data_version').get(),db.prepare('SELECT total_changes() AS n').get()])).digest('hex');}
function decode(cursor){try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString());if(typeof c.after!=='string'||typeof c.version!=='string'||typeof c.scope!=='string')throw Error();return c;}catch{throw fail('RECOVERY_CURSOR_INVALID');}}
function pendingFilter(){
 const r=safe('r'),s=safe('s');
 // Correlated JSON table scans retain settled evidence inside SQLite; snapshots
 // and unbounded receipt/message sets never cross the worker boundary.
 const settled=`s.collection='recovery' AND json_extract(${s},'$.status') IN ('committed','reconciled')`;
 const native=`coalesce(json_array_length(${r},'$.nativeMessageIds')>0 AND NOT EXISTS(SELECT 1 FROM json_each(${r},'$.nativeMessageIds') n WHERE NOT EXISTS(SELECT 1 FROM records s,json_each(${s},'$.collections.managed_messages') m WHERE ${settled} AND json_extract(${safe('m')},'$.id')=n.value)),0)`;
 const digest=`json_extract(${r},'$.report.digest')`,validDigest=`json_type(${r},'$.report.digest')='text' AND length(${digest})=64 AND ${digest} NOT GLOB '*[^a-f0-9]*'`;
 const receipt=`coalesce(substr(r.id,1,20)='managed:publication:' AND ${validDigest} AND ${digest}=(SELECT json_extract(${safe('e')},'$.value.report.digest') FROM records s,json_each(${s},'$.collections.managed_receipts') e WHERE ${settled} AND json_extract(${safe('e')},'$.id')=json_extract(${r},'$.receiptId') ORDER BY s.id DESC,CAST(e.key AS INTEGER) DESC LIMIT 1),0)`;
 return `(substr(r.id,1,16)='managed:pending:' OR substr(r.id,1,23)='managed:object-pending:' OR substr(r.id,1,20)='managed:publication:') AND (NOT json_valid(r.value) OR (json_extract(${r},'$.kind') IS NOT NULL AND json_extract(${r},'$.kind') NOT IN ('business','object','publication','record')) OR json_extract(${r},'$.status') IS NULL OR json_extract(${r},'$.status') NOT IN ('prepared','pending','committed','reconciled','discarded') OR (json_extract(${r},'$.status') NOT IN ('reconciled','discarded') AND NOT (${native}) AND NOT (${receipt})))`;
}
export function recoveryRead(db,identity,op,args){
 db.exec('BEGIN');
 try{
  db.prepare('SELECT collection FROM records LIMIT 1').get();
  const current=version(db,identity,args),scope=createHash('sha256').update(JSON.stringify([args.collection??'recovery',args.prefixes??null,args.pendingOnly===true,args.relPaths??null,args.unconfirmedOnly===true])).digest('hex');
  if(args.version!==undefined&&args.version!==current)throw fail('RECOVERY_VERSION_CHANGED');
  let result;
  if(op==='recoveryPage'){
   const projectedFields=args.collection==='tree_cross_transfers'?[...fields,'schema','sourceProjectId']:fields;
   const limit=bounded(args.limit,50,200),maxBytes=bounded(args.maxBytes,65536,1024*1024),cursor=args.cursor?decode(args.cursor):null;
   if(cursor&&(cursor.version!==current||cursor.scope!==scope))throw fail('RECOVERY_CURSOR_INVALID');
   const params=[args.collection??'recovery',cursor?.after??''];let filter='';
   if(args.prefixes!==undefined){
    if(!Array.isArray(args.prefixes)||args.prefixes.length>32||args.prefixes.some(x=>typeof x!=='string'||x.length>256))throw fail('RECOVERY_PREFIX_INVALID');
    filter=args.prefixes.length?' AND ('+args.prefixes.map(prefix=>{params.push(prefix.length,prefix);return 'substr(r.id,1,?)=?';}).join(' OR ')+')':' AND 0';
   }
   if(args.relPaths!==undefined){
    if(!Array.isArray(args.relPaths)||args.relPaths.length>1024||args.relPaths.some(value=>typeof value!=='string'||value.length>4096))throw fail('RECOVERY_PATH_INVALID');
    const rel=`json_extract(${safe('r')},'$.relPath')`;params.push(JSON.stringify(args.relPaths));
    filter+=` AND EXISTS(SELECT 1 FROM json_each(?) p WHERE ${rel}=p.value OR substr(${rel},1,length(p.value)+1)=p.value||'/')`;
   }
   if(args.pendingOnly){
    filter+=" AND (substr(r.id,1,8)!='managed:' OR ("+pendingFilter()+'))';
    // Preserve corrupt/future tree receipts; settled creations stay in SQLite
    // without occupying recovery UI pages or crossing the worker boundary.
    if(args.collection==='tree_cross_transfers'){
     const value=safe('r');
     // Only this exact, acknowledged registry schema can release both roots.
     // Future/corrupt "complete" records remain pending, bounded in SQLite.
     const settled=`((json_extract(${value},'$.phase')='complete' AND json_type(${value},'$.published')='true' AND json_extract(${value},'$.sourceReceipt')='acknowledged' AND json_extract(${value},'$.destinationReceipt')='acknowledged') OR (json_extract(${value},'$.phase')='refused' AND json_type(${value},'$.published')='false'))`;
     filter+=` AND NOT coalesce(${crossRegistryScope()} AND json_type(${value},'$.settled')='true' AND ${settled},0)`;
    }else filter+=` AND (substr(r.id,1,15)!='tree-operation:' OR coalesce(json_extract(${safe('r')},'$.phase'),'') NOT IN ('complete','refused'))`;
   }
   if(args.unconfirmedOnly)filter+=` AND coalesce(json_extract(${safe('r')},'$.status'),'') NOT IN ('committed','reconciled','discarded')`;
   const crossScopeProjection=args.collection==='tree_cross_transfers'?crossRegistryScope()+' AS registryScopeValid,':'';
   const sql=`SELECT ${crossScopeProjection}CASE WHEN length(CAST(r.id AS BLOB))<=4096 THEN r.id END AS id,r.revision,length(CAST(r.value AS BLOB)) AS byteLength,json_valid(r.value) AS valid,json_type(${safe('r')},'$.collections') AS hasCollections,json_array_length(${safe('r')},'$.nativeMessageIds') AS nativeMessageCount,length(json_extract(${safe('r')},'$.relPath'))>128 AS relPathTruncated,CASE WHEN json_type(${safe('r')},'$.report.digest')='text' AND length(json_extract(${safe('r')},'$.report.digest'))=64 AND json_extract(${safe('r')},'$.report.digest') NOT GLOB '*[^a-f0-9]*' THEN 1 ELSE 0 END AS validReportDigest,${projectedFields.map(key=>scalar('r',key)+' AS '+key).join(',')} FROM records r WHERE r.collection=? AND r.id>?${filter} ORDER BY r.id LIMIT ?`;
   params.push(limit+1);const entries=[];let size=2,after=cursor?.after??'',more=false;
   const encode=after=>Buffer.from(JSON.stringify({after,version:current,scope})).toString('base64url');
   for(const row of db.prepare(sql).iterate(...params)){
    if(entries.length===limit){more=true;break;}
    if(row.id===null)throw fail('RECOVERY_ID_TOO_LARGE');
    const value={};for(const key of projectedFields)if(row[key]!==null)value[key]=row[key];
    // Preserve raw JSON type/schema validation before UI defaults normalize
    // booleans or synthesize a record kind. Unknown ownership fences all roots.
    if(args.collection==='tree_cross_transfers')value.registryScopeValid=row.registryScopeValid===1;
    if(args.collection!=='instances'){
     if(row.id.startsWith('tree-operation:'))value.recoveryKind='tree-operation';
     value.nativeMessageCount=row.nativeMessageCount??0;
     value.kind??=row.id.startsWith('managed:object-pending:')?'object':row.id.startsWith('managed:publication:')?'publication':row.hasCollections==='object'?'business':'record';
     value.relPathTruncated=row.relPathTruncated===1;
     value.needsCheck=!row.valid||!statuses.has(value.status)||!kinds.has(value.kind)||(value.kind==='publication'&&!row.validReportDigest);value.corrupt=!row.valid;value.automaticReplay=false;value.requiresConfirmation=true;
    }
    const entry={id:row.id,revision:row.revision,byteLength:row.byteLength,value},bytes=Buffer.byteLength(JSON.stringify(entry))+(entries.length?1:0);
    const overhead=Buffer.byteLength(JSON.stringify({entries:[],nextCursor:encode(row.id),version:current}))-2;
    if(size+bytes+overhead>maxBytes){if(!entries.length)throw fail('RECOVERY_PAGE_TOO_SMALL');more=true;break;}
    entries.push(entry);size+=bytes;after=row.id;
   }
   result={entries,nextCursor:more?encode(after):null,version:current};
  }else{
   const row=db.prepare('SELECT revision,length(CAST(value AS BLOB)) AS byteLength FROM records WHERE collection=? AND id=?').get(args.collection??'recovery',args.id);
   if(!row){result=null;}else{
    if(args.revision!==undefined&&args.revision!==row.revision)throw fail('RECOVERY_REVISION_CHANGED');
    const maxBytes=bounded(args.maxBytes,op==='recoveryChunk'?65536:8*1024*1024,op==='recoveryChunk'?1024*1024:8*1024*1024);
    if(op==='recoveryRecord'){
     if(row.byteLength>maxBytes)throw fail('RECOVERY_RECORD_TOO_LARGE');
     const text=db.prepare('SELECT value FROM records WHERE collection=? AND id=?').get(args.collection??'recovery',args.id).value;
     try{result={id:args.id,...row,value:JSON.parse(text),version:current};}catch{throw fail('RECOVERY_RECORD_CORRUPT');}
    }else{
     const offset=args.offset??0;if(!Number.isSafeInteger(offset)||offset<0||offset>row.byteLength)throw fail('RECOVERY_OFFSET_INVALID');
     const bytes=db.prepare('SELECT substr(CAST(value AS BLOB),?,?) AS bytes FROM records WHERE collection=? AND id=?').get(offset+1,maxBytes,args.collection??'recovery',args.id).bytes;
     result={bytes,offset,nextOffset:offset+bytes.byteLength,total:row.byteLength,revision:row.revision,version:current};
    }
   }
  }
  db.exec('COMMIT');return result;
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export function managedResourceSummary(db,{offline=false}={}){
 if(offline){
  const settings=`CASE WHEN json_valid(value) THEN value ELSE '{}' END`;
  const limit=db.prepare(`SELECT CASE WHEN json_type(${settings},'$.limit') IN ('integer','real') THEN json_extract(${settings},'$.limit') END AS n FROM records WHERE collection='ui' AND id='managed:cache:settings'`).get()?.n??1;
  // Quota derivation shares the single authority with the live Workspace
  // (workSlotFacts): occupied until a completed closure, unknown closures
  // stay pending verification instead of being silently released.
  const rows=db.prepare(`SELECT w.value AS row FROM records r,json_each(CASE WHEN json_valid(r.value) AND json_type(r.value)='array' THEN r.value ELSE '[]' END) w WHERE r.collection='ui' AND r.id='managed:cache:works'`).all();
  return summaryOf(limit,rows.map(row=>readWork(row.row)));
 }
 const limit=db.prepare("SELECT CASE WHEN json_type(CASE WHEN json_valid(value) THEN value ELSE 'null' END,'$') IN ('integer','real') THEN json_extract(value,'$') END AS n FROM records WHERE collection='managed_settings' AND id='limit'").get()?.n??1;
 return summaryOf(limit,db.prepare(`SELECT ${safe('r')} AS row FROM records r WHERE r.collection='managed_works'`).all().map(row=>readWork(row.row)));
}
function readWork(raw){
 try{const parsed=JSON.parse(raw);return parsed&&typeof parsed==='object'&&parsed.value&&typeof parsed.value==='object'?parsed.value:parsed;}catch{return null;}
}
function summaryOf(limit,works){
 const facts=workSlotFacts(works.filter(Boolean));
 return {limit,used:facts.used,pendingVerification:facts.pendingVerification?.length??0};
}

// Startup selection only; Controller revalidates every execution/approval gate.
// Extract booleans in the storage worker, never hydrate prompt or report bodies.
export function managedExecutionSummary(db){
 const works=`SELECT id,CASE WHEN json_valid(value) THEN value ELSE '{}' END AS body FROM records WHERE collection='managed_works'`;
 const jobs=`SELECT id,CASE WHEN json_valid(value) THEN value ELSE '{}' END AS body FROM records WHERE collection='managed_jobs'`;
 const paused=body=>`json_type(${body},'$.manualControl.pause') IS NOT NULL AND json_type(${body},'$.manualControl.pause')!='null'`;
 const recoveryHeld=body=>`coalesce(json_extract(${body},'$.recoveryRequiresExplicitInput'),0)=1`;
 const interrupted=`(json_extract(j.body,'$.status')='interrupted' AND (json_extract(j.body,'$.interruptionReason')='host-stopped' OR json_extract(j.body,'$.restartRecovery.kind')='needs-reconciliation' OR json_extract(j.body,'$.error') IN ('Cold start never replays accepted inputs','宿主退出，未自动重放')))`;
 const row=db.prepare(`WITH works AS (${works}),jobs AS (${jobs}) SELECT
  EXISTS(SELECT 1 FROM works w WHERE NOT (${paused('w.body')}) AND NOT (${recoveryHeld('w.body')}) AND NOT EXISTS(SELECT 1 FROM jobs held WHERE (json_extract(held.body,'$.target')=w.id OR json_extract(held.body,'$.context.boundWorkId')=w.id OR json_extract(held.body,'$.context.workId')=w.id) AND ${recoveryHeld('held.body')}) AND (json_extract(w.body,'$.status') IN ('queued','running','closing') OR (json_extract(w.body,'$.status')='ended' AND json_extract(w.body,'$.closure.decision') IN ('accept','discard') AND coalesce(json_extract(w.body,'$.closure.phase'),'')!='complete'))) AS unfinishedWork,
  EXISTS(SELECT 1 FROM jobs j LEFT JOIN works w ON w.id=coalesce(json_extract(j.body,'$.context.boundWorkId'),json_extract(j.body,'$.context.workId'),json_extract(j.body,'$.target')) WHERE json_extract(j.body,'$.target')!='frontdesk' AND (json_extract(j.body,'$.status') IN ('queued','running') OR ${interrupted}) AND NOT (${paused('j.body')}) AND NOT (${recoveryHeld('j.body')}) AND NOT EXISTS(SELECT 1 FROM jobs held WHERE (json_extract(held.body,'$.target')=json_extract(j.body,'$.target') OR json_extract(held.body,'$.target')=w.id OR json_extract(held.body,'$.context.boundWorkId')=w.id OR json_extract(held.body,'$.context.workId')=w.id) AND ${recoveryHeld('held.body')}) AND (w.id IS NULL OR (NOT (${paused('w.body')}) AND NOT (${recoveryHeld('w.body')}) AND json_extract(w.body,'$.status') NOT IN ('review','closing','ended')))) AS unfinishedInput`).get();
 return {pending:row.unfinishedWork===1||row.unfinishedInput===1};
}
