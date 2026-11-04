import test from 'node:test';
import assert from 'node:assert/strict';
import {STATUS_STALE_MS,formatDuration,timingDisplay,snapshotStale,prioritizeRows,statusCounts} from '../src/renderer/collaboration-timing.mjs';
const observedAt='2026-11-03T12:00:00.000Z',now=Date.parse(observedAt);
const frame={observedAt,freshness:'live'};
const running={target:'w',primaryState:'running',timing:{jobId:'one',kind:'running',startedAt:'2026-11-03T11:59:50.000Z',endedAt:null,elapsedMs:10000,advancing:true,observedAt}};
test('live wall clock advances and new job replaces its baseline',()=>{
 assert.equal(timingDisplay(running,frame,{now:now+2000}).text,'本轮经过 0分 12秒');
 const next={...running,timing:{...running.timing,jobId:'two',elapsedMs:0,observedAt:new Date(now+2000).toISOString()}};
 assert.equal(timingDisplay(next,{...frame,observedAt:next.timing.observedAt},{now:now+3000}).text,'本轮经过 0分 01秒');
 assert.equal(formatDuration(3661000),'1小时 01分 01秒');
});
test('waiting review pause sleep and unknown cannot advance even with malformed advancing flag',()=>{
 for(const primaryState of ['waiting','review','paused','sleeping','unknown','queued']){
  const result=timingDisplay({...running,primaryState},frame,{now:now+3000});
  assert.equal(result.advancing,false);assert.match(result.text,/0分 10秒/);
 }
 const completed={...running,timing:{...running.timing,kind:'completed',advancing:false}};
 assert.match(timingDisplay(completed,frame,{now:now+3000}).text,/0分 10秒 · 已结束/);
});
test('stale clocks stop at bounded horizon; recorded and read-error snapshots never advance',()=>{
 assert.equal(snapshotStale(frame,now+STATUS_STALE_MS),true);
 const late=timingDisplay(running,frame,{now:now+STATUS_STALE_MS});
 assert.equal(late.advancing,false);assert.match(late.text,/上次快照/);
 assert.equal(timingDisplay(running,frame,{now:now+60000}).text,late.text);
 for(const options of [{frame:{...frame,freshness:'recorded'},readError:false},{frame,readError:true}]){
  const value=timingDisplay(running,options.frame,{now:now+3000,readError:options.readError});assert.equal(value.advancing,false);assert.match(value.text,/0分 10秒/);
 }
});
test('queued jobs do not invent elapsed duration; absent timestamps stay unavailable',()=>{
 assert.equal(timingDisplay({...running,timing:{kind:'queued',elapsedMs:null}},frame,{now}).text,'排队中 · 尚未开始');
 assert.equal(timingDisplay({primaryState:'idle'},frame,{now}).text,'本轮时间未记录');
});
test('all roles remain discoverable with active workers prioritized and explicit counts',()=>{
 const rows=[{target:'idle',primaryState:'idle'},{target:'queue',primaryState:'queued'},{target:'orchestrator',primaryState:'idle'},{target:'frontdesk',primaryState:'idle'},running,{target:'review',primaryState:'review'},{target:'fault',primaryState:'waiting',serviceFaultHeld:true}];
 assert.deepEqual(prioritizeRows(rows,'idle').map(row=>row.target),['frontdesk','orchestrator','w','idle','fault','review','queue']);
 assert.deepEqual(statusCounts(rows),{active:1,queued:1,review:1,fault:1});assert.equal(rows[0].target,'idle');
});
