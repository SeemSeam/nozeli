export const STATUS_REFRESH_MS=5000;
export const STATUS_STALE_MS=15000;
const activeStates=new Set(['starting','running','tool','compacting','retrying','settling','stopping','configuring']);
export const isActiveState=state=>activeStates.has(state);
export function snapshotStale(frame,now=Date.now()){
 const observed=Date.parse(frame?.observedAt);
 return frame?.freshness==='recorded'||!Number.isFinite(observed)||now-observed>=STATUS_STALE_MS;
}
export function formatDuration(milliseconds){
 const seconds=Math.floor(Math.max(0,milliseconds)/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
 return hours?`${hours}小时 ${String(minutes).padStart(2,'0')}分 ${String(seconds%60).padStart(2,'0')}秒`:`${minutes}分 ${String(seconds%60).padStart(2,'0')}秒`;
}
export function timingDisplay(row,frame,{now=Date.now(),readError=false}={}){
 const timing=row.timing,stale=readError||snapshotStale(frame,now)||!!row.freshness?.stale;
 if(!timing)return {text:'本轮时间未记录',advancing:false,stale};
 if(timing.kind==='queued')return {text:timing.queuedAt?'排队自 '+new Date(timing.queuedAt).toLocaleTimeString():'排队中 · 尚未开始',advancing:false,stale};
 if(!Number.isFinite(timing.elapsedMs))return {text:'本轮时间未记录',advancing:false,stale};
 const observed=Date.parse(timing.observedAt),canAdvance=timing.kind==='running'&&timing.advancing&&isActiveState(row.primaryState)&&!row.manualControl?.paused&&Number.isFinite(observed)&&!row.freshness?.stale&&frame?.freshness!=='recorded';
 const elapsed=timing.elapsedMs+(canAdvance&&!readError?Math.max(0,Math.min(now-observed,STATUS_STALE_MS)):0);
 return {text:'本轮经过 '+formatDuration(elapsed)+(stale?' · 上次快照':timing.kind==='completed'?' · 已结束':!canAdvance?' · 已停止计时':''),advancing:canAdvance&&!stale,stale};
}
export function prioritizeRows(rows,selected){
 return [...rows].sort((a,b)=>rank(a)-rank(b));
 function rank(row){return row.target==='frontdesk'?0:row.target==='orchestrator'?1:isActiveState(row.primaryState)?2:row.target===selected?3:row.primaryState==='waiting'||row.primaryState==='failed'||row.primaryState==='unknown'?4:row.primaryState==='review'?5:row.primaryState==='queued'?6:7;}
}
export function statusCounts(rows){
 const counts={active:0,queued:0,review:0,fault:0};
 for(const row of rows){if(isActiveState(row.primaryState))counts.active++;if(row.primaryState==='queued')counts.queued++;if(row.primaryState==='review')counts.review++;if(['failed','unknown'].includes(row.primaryState)||row.serviceFaultHeld)counts.fault++;}
 return counts;
}
