// Provider totals are cumulative across requests. Never sum snapshots or use
// `last` as the whole turn. Unknown fields stay null, including unknown baselines.
export const tokenFields=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const validCounter=value=>Number.isSafeInteger(value)&&value>=0;
const hasCounter=(value,key)=>value!=null&&Object.hasOwn(value,key);
function counter(value,key){
  // Codex's TokenUsageBreakdown schema explicitly defaults this optional field
  // to zero. This is a provider contract, not a default for unknown usage:
  // https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/ThreadTokenUsageUpdatedNotification.json
  if(value&&typeof value==='object'&&!Array.isArray(value)&&key==='cacheWriteInputTokens'&&!hasCounter(value,key))return 0;
  return validCounter(value?.[key])?value[key]:null;
}
export function tokenBreakdown(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const fields=Object.fromEntries(tokenFields.map(key=>[key,counter(value,key)]));
  // The optional default alone does not constitute a usage observation.
  return tokenFields.some(key=>hasCounter(value,key)&&fields[key]!==null)?fields:null;
}
// API: tokens is null or a six-field breakdown with nullable unknown counters.
// tokenStatus is complete only after successful terminal settlement with full
// field coverage; partial observations are not final cost. tokenCoverage records
// counter coverage separately from turn settlement (settled also includes failed
// and interrupted turns). Consumers must not coerce unknown fields to zero or
// replace tokenStatus with a success/failure label from their own control flow.
// The same reducer serves batch fixtures and live ingestion. Raw notification
// arrays are unnecessary: usage state occupies six counters plus sticky flags.
export function createTurnMetricsAccumulator({threadId,turnId,baseline,fresh=false}={}){
  let boundTurn=turnId,provisionalTurn,baselineInvalidated=false,start,baselineSource;
  let previous,invalid,decreasing,cumulative,usageUpdates,terminal,terminalConflict,cacheWriteDefaulted,items;
  function reset(){
    baselineSource=baselineInvalidated?'unavailable':baseline!=null?'observed':fresh?'fresh-thread':'unavailable';
    start=baselineInvalidated?null:baseline!=null?tokenBreakdown(baseline):fresh?Object.fromEntries(tokenFields.map(key=>[key,0])):null;
    previous=Object.fromEntries(tokenFields.map(key=>[key,start?.[key]??null]));
    invalid=new Set(tokenFields.filter(key=>hasCounter(baseline,key)&&baseline[key]!=null&&counter(baseline,key)===null));
    decreasing=new Set();cumulative=null;usageUpdates=0;terminal=null;terminalConflict=false;cacheWriteDefaulted=false;items=new Map();
  }
  reset();
  function bind(id){
    if(typeof id!=='string'||!id)return false;
    if(boundTurn&&boundTurn!==id||provisionalTurn&&provisionalTurn!==id){baselineInvalidated=true;reset();}
    boundTurn=id;provisionalTurn=undefined;return true;
  }
  function invalidateBaseline(){baselineInvalidated=true;baselineSource='unavailable';start=null;}
  function observe(event){
    const p=event?.params;if(p?.threadId!==threadId)return false;
    const terminalEvent=event.method==='turn/completed',eventTurn=terminalEvent?p.turn?.id:p.turnId;
    if(typeof eventTurn!=='string'||!eventTurn)return false;
    if(boundTurn&&eventTurn!==boundTurn||provisionalTurn&&eventTurn!==provisionalTurn)return false;
    if(!boundTurn)provisionalTurn=eventTurn;
    if(terminalEvent){if(terminal&&terminal.status!==p.turn.status)terminalConflict=true;terminal=p.turn;return true;}
    if(event.method==='thread/tokenUsage/updated'){
      const total=p.tokenUsage?.total;usageUpdates++;cumulative=total&&typeof total==='object'&&!Array.isArray(total)?(cumulative||{}):null;
      if(total&&typeof total==='object'&&!hasCounter(total,'cacheWriteInputTokens'))cacheWriteDefaulted=true;
      let suppliedValidCounter=false;
      for(const key of tokenFields){
        const value=counter(total,key);if(cumulative)cumulative[key]=value;if(hasCounter(total,key)&&value!==null)suppliedValidCounter=true;
        if(hasCounter(total,key)&&total[key]!=null&&value===null)invalid.add(key);
        if(value!==null){if(previous[key]!==null&&value<previous[key])decreasing.add(key);previous[key]=value;}
      }
      if(!suppliedValidCounter)cumulative=null;
    }else if(event.method==='item/completed'&&p.item?.id)items.set(p.item.id,p.item.type);
    return true;
  }
  function result(){
    const delta={};for(const key of tokenFields)delta[key]=!invalid.has(key)&&!decreasing.has(key)&&start?.[key]!=null&&cumulative?.[key]!=null?cumulative[key]-start[key]:null;
    const turnStatus=terminalConflict?null:terminal?.status??null,knownFields=tokenFields.filter(key=>delta[key]!==null),unknownFields=tokenFields.filter(key=>delta[key]===null);
    const zeroConfirmed=turnStatus==='completed'&&unknownFields.length===0&&knownFields.every(key=>delta[key]===0);
    const observed=knownFields.some(key=>delta[key]>0)||turnStatus==='completed'&&knownFields.length>0,tokens=observed?delta:null;
    const tokenStatus=!tokens?'unavailable':turnStatus==='completed'&&unknownFields.length===0?'complete':'partial';
    const unknownReasons=[];
    if(baselineSource==='unavailable')unknownReasons.push(baselineInvalidated?'baseline-invalidated':'baseline-unavailable');
    if(!usageUpdates)unknownReasons.push('provider-usage-not-observed');
    if(unknownFields.length&&baselineSource!=='unavailable')unknownReasons.push('counter-coverage-incomplete');
    if(invalid.size)unknownReasons.push('invalid-provider-counter');
    if(decreasing.size)unknownReasons.push('cumulative-decreased-or-out-of-order');
    if(terminalConflict)unknownReasons.push('conflicting-provider-terminal');
    else if(turnStatus!=='completed')unknownReasons.push(terminal?'provider-turn-'+(turnStatus??'unknown'):'provider-terminal-not-observed');
    if(!tokens&&knownFields.length&&turnStatus!=='completed')unknownReasons.push('unchanged-counters-without-successful-settlement');
    const tokenCoverage={knownFields,unknownFields,invalidFields:tokenFields.filter(key=>invalid.has(key)),decreasingFields:tokenFields.filter(key=>decreasing.has(key)),baselineSource,usageUpdates,turnStatus,settled:terminal!=null,zeroConfirmed,cacheWriteDefaulted,unknownReasons};
    const tools={};for(const type of items.values())if(['commandExecution','fileChange','dynamicToolCall','mcpToolCall','webSearch','imageGeneration'].includes(type))tools[type]=(tools[type]||0)+1;
    return {tokens,tokenSource:tokens?'provider-cumulative-delta':'unavailable',tokenStatus,tokenCoverage,tools};
  }
  return {observe,bind,invalidateBaseline,result};
}
export function turnMetrics(events,options={}){
  const accumulator=createTurnMetricsAccumulator(options);
  for(const event of events)accumulator.observe(event);
  return accumulator.result();
}
