// Owner-local, metadata-only activity. Never inspect a journal or retain tool payloads.
import {randomUUID} from 'node:crypto';
const text=value=>typeof value==='string'?value.slice(0,160):null;
const LIMIT=64;
export function createActivityState({ownerId=process.env.NOZELI_PI_OWNER_ID??randomUUID(),epoch=randomUUID()}={}){
 let revision=0,sessionId=null,known=false,uncertain=false,runActive=false,compaction=false,retry=false,runSeen=false,settled=false;
 const tools=new Map(),interactions=new Map(),operations=new Map();
 const add=(map,id,value)=>{id=text(id);if(!id){uncertain=true;return;}if(map.has(id)||map.size<LIMIT)map.set(id,value);else uncertain=true;};
 const snapshot=()=>({ownerId,ownerGeneration:epoch,sessionId,activityRevision:revision,observedAt:Date.now(),known:known&&!uncertain,runActive,compaction,retry,
  promptPreparing:operations.has('prompt')&&!runSeen,promptInFlight:operations.has('prompt'),settling:operations.has('flush')||operations.has('prompt')&&settled,
  configuration:operations.has('model'),command:operations.has('compact')?'compact':operations.has('reload')?'reload':null,
  tools:[...tools].map(([callId,tool])=>({callId,tool})),toolCount:tools.size,interactions:[...interactions].map(([id,kind])=>({id,kind})),interactionCount:interactions.size,
  busy:runActive||compaction||retry||tools.size>0||interactions.size>0||operations.size>0});
 function observe(frame){
  const event=frame.eventData;
  if(frame.event==='native'&&event){
   switch(event.type){
    case 'agent_start':runActive=true;runSeen=true;settled=false;break;
    case 'runSettled':runActive=false;settled=true;retry=false;tools.clear();break;
    case 'toolExecutionStarted':case 'tool_execution_start':add(tools,event.callId??event.toolCallId,text(event.tool??event.toolName));break;
    case 'toolExecutionEnded':case 'tool_execution_end':tools.delete(text(event.callId??event.toolCallId));break;
    case 'bash_execution_start':add(tools,event.callId??event.toolCallId??'native-bash','bash');break;
    case 'bash_execution_end':tools.delete(text(event.callId??event.toolCallId??'native-bash'));break;
    case 'compactionStarted':case 'compaction_start':case 'auto_compaction_start':compaction=true;break;
    case 'compactionEnded':case 'compaction_end':case 'auto_compaction_end':compaction=false;break;
    case 'auto_retry_start':case 'summarization_retry_start':retry=true;break;
    case 'auto_retry_end':case 'summarization_retry_end':retry=false;break;
    case 'agent_end':if(event.willRetry===true)retry=true;break;
   }
  }else if(frame.event==='interaction')add(interactions,frame.interaction?.id,text(frame.interaction?.kind??frame.interaction?.type));
  else if(frame.event==='interaction_closed')interactions.delete(text(frame.interaction?.id));
  revision++;
  return {...frame,ownerId,ownerGeneration:epoch,sessionId:frame.sessionId??event?.sessionId??sessionId,activityRevision:revision,activity:snapshot()};
 }
 return {snapshot,observe,setSessionId(value){sessionId=value;},begin(method){if(method==='prompt'&&!operations.has(method)){runSeen=false;settled=false;}operations.set(method,(operations.get(method)??0)+1);revision++;},end(method,error){const count=operations.get(method)??0;if(count>1)operations.set(method,count-1);else operations.delete(method);if(method==='start'&&!error)known=true;if(error&&(['flush','compact','reload'].includes(method)||method==='prompt'&&!settled))uncertain=true;revision++;}};
}
