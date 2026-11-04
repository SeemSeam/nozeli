import {createHash,randomUUID} from 'node:crypto';
const incarnations=new WeakMap();
const fail=code=>Object.assign(Error(code),{code});
const safe=column=>`CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;
const text=(column,key,max=256)=>`CASE WHEN json_type(${safe(column)},'$.${key}')='text' THEN substr(json_extract(${safe(column)},'$.${key}'),1,${max}) END`;
// Only scalar metadata crosses the storage boundary. Never decode cached Work bodies.
export function collaborationFacts(db,identity,args){
 const limit=args.limit??24;if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw fail('COLLABORATION_PAGE_INVALID');
 db.exec('BEGIN');try{
  if(args.target!==undefined&&(typeof args.target!=='string'||args.target.length>512))throw fail('COLLABORATION_TARGET_INVALID');
  let incarnation=incarnations.get(db);if(!incarnation)incarnations.set(db,incarnation=randomUUID());
  const revision=createHash('sha256').update(JSON.stringify([incarnation,identity,args.projectId,args.instanceId,args.target??null,db.prepare('PRAGMA data_version').get(),db.prepare('SELECT total_changes() n').get()])).digest('hex');
  let after='';if(args.cursor){try{const cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString());if(cursor.revision!==revision||cursor.projectId!==args.projectId||cursor.instanceId!==args.instanceId||typeof cursor.after!=='string')throw Error();after=cursor.after;}catch{throw fail('COLLABORATION_CURSOR_STALE');}}
  const value=safe('w.value'),id=`json_extract(${value},'$.id')`,status=`json_extract(${value},'$.value.status')`,closure=`coalesce(json_extract(${value},'$.value.closure.phase'),json_extract(${safe('l.value')},'$.closure.phase'))`;
  const hasClosure=`(json_type(${value},'$.value.closure')='object' OR json_type(${safe('l.value')},'$.closure')='object')`,visible=`(${status} IS NULL OR ${status}!='ended' OR (${hasClosure} AND coalesce(${closure},'unknown')!='complete'))`;
  const source=`FROM records r,json_each(CASE WHEN json_valid(r.value) AND json_type(r.value)='array' THEN r.value ELSE '[]' END) w LEFT JOIN records l ON l.collection='ui' AND l.id='managed:works:'||${id} WHERE r.collection='ui' AND r.id='managed:cache:works'`;
  const rows=db.prepare(`SELECT ${id} target,${id} id,${text('w.value','value.name',128)} name,${text('w.value','value.status',64)} status,${text('l.value','threadId',256)} threadId,${text('l.value','binding.provider',64)} provider,json_extract(${safe('l.value')},'$.contextRecovery') IS NOT NULL contextRecovery,json_extract(${value},'$.value.revision') revision,json_extract(${value},'$.value.readOnly') readOnly,${closure} closurePhase,${hasClosure} hasClosure ${source} AND typeof(${id})='text' AND length(${id})<=512 AND ${id}>? ${args.target!==undefined?'AND '+id+'=?':''} AND ${visible} ORDER BY ${id} LIMIT ?`).all(...(args.target!==undefined?[after,args.target,limit+1]:[after,limit+1]));
  const more=rows.length>limit;if(more)rows.pop();for(const row of rows)if(row.hasClosure)row.closure={phase:row.closurePhase??'unknown'};
  const residents={};for(const target of ['frontdesk','orchestrator']){const row=db.prepare(`SELECT ${text('value',target+'.threadId')} threadId,${text('value',target+'.model')} model,${text('value',target+'.effort',32)} effort FROM records WHERE collection='ui' AND id='managed:residents'`).get();if(row)residents[target]=row;}
  const providers=[];for(const row of db.prepare(`SELECT p.key target,${text('p.value','ownerId')} ownerId FROM records r,json_each(${safe('r.value')}) p WHERE r.collection='ui' AND r.id='managed:providers' ${args.target!==undefined?'AND p.key=?':''} ORDER BY p.key LIMIT 66`).iterate(...(args.target!==undefined?[args.target]:[])))providers.push(row);
  const totals=db.prepare(`SELECT count(*) total,coalesce(sum(${status}='running'),0) runningCount,coalesce(sum(${status} IN ('review','paused','ended','closing')),0) waitingCount ${source} AND ${visible}`).get();
  const result={revision,works:rows,residents,providers,providersTruncated:providers.length>64,totalWorks:totals.total,recordedRunning:totals.runningCount>0,waitingCount:totals.waitingCount,nextCursor:more?Buffer.from(JSON.stringify({revision,projectId:args.projectId,instanceId:args.instanceId,after:rows.at(-1).target})).toString('base64url'):null};
  if(Buffer.byteLength(JSON.stringify(result))>64*1024)throw fail('COLLABORATION_PAGE_TOO_LARGE');db.exec('COMMIT');return result;
 }catch(error){db.exec('ROLLBACK');throw error;}
}
