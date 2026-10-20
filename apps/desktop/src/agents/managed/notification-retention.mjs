import {createTurnMetricsAccumulator,tokenBreakdown} from './turn-metrics.mjs';

export const noticeTurnId=notice=>notice.params?.turnId??notice.params?.turn?.id??null;

// Diagnostics are deliberately separate from semantic settlement and realtime
// delivery. Oversize notices retain only identity and an explicit truncation.
export class NotificationDiagnostics {
  constructor({maxEvents=256,maxBytes=256*1024}={}) {
    if(!Number.isInteger(maxEvents)||maxEvents<1||!Number.isInteger(maxBytes)||maxBytes<256)throw Error('invalid notification retention limits');
    this.maxEvents=maxEvents;this.maxBytes=maxBytes;this.slots=new Array(maxEvents);this.head=0;this.length=0;this.bytes=0;this.observed=0;this.dropped=0;
  }
  push(notice) {
    const originalBytes=Buffer.byteLength(JSON.stringify(notice));let value=notice,bytes=originalBytes;
    if(bytes>this.maxBytes){
      // IDs may also be untrusted/large. Bound each, not just the content body.
      const short=value=>typeof value==='string'?value.slice(0,48):undefined;
      value={method:short(notice.method),truncated:true,originalBytes,threadId:short(notice.params?.threadId),turnId:short(noticeTurnId(notice))};
      bytes=Buffer.byteLength(JSON.stringify(value));
      if(bytes>this.maxBytes){value={truncated:true,originalBytes};bytes=Buffer.byteLength(JSON.stringify(value));}
    }
    while(this.length&&(this.length===this.maxEvents||this.bytes+bytes>this.maxBytes)){
      this.bytes-=this.slots[this.head].bytes;this.slots[this.head]=undefined;this.head=(this.head+1)%this.maxEvents;this.length--;this.dropped++;
    }
    this.slots[(this.head+this.length)%this.maxEvents]={value,bytes};this.length++;this.bytes+=bytes;this.observed++;
    return this.length;
  }
  values(){return Array.from({length:this.length},(_,index)=>this.slots[(this.head+index)%this.maxEvents].value);}
  stats(){return {observed:this.observed,retained:this.length,bytes:this.bytes,dropped:this.dropped,maxEvents:this.maxEvents,maxBytes:this.maxBytes};}
}

// Only the active turn owns full semantic state. Final message bodies replace
// their delta chunks; diagnostics cannot truncate answers, artifacts or usage.
class SingleTurnNotifications {
  constructor({threadId,turnId,baseline,fresh=false}) {
    this.threadId=threadId;this.baseline=baseline;this.fresh=fresh;this.turnId=turnId;this.uncertain=false;this.reset();
  }
  reset(){this.messages=new Map();this.files=new Set();this.completed=null;this.cumulative=null;this.lastUsage=null;this.metrics=createTurnMetricsAccumulator({threadId:this.threadId,turnId:this.turnId,baseline:this.baseline,fresh:this.fresh});if(this.uncertain)this.metrics.invalidateBaseline();}
  invalidateBaseline(){this.uncertain=true;this.metrics.invalidateBaseline();}
  bind(turnId){
    if(this.turnId&&this.turnId!==turnId){this.turnId=turnId;this.uncertain=true;this.reset();}
    else{this.turnId=turnId;this.metrics.bind(turnId);}
  }
  observe(notice){
    if(notice.params?.threadId!==this.threadId)return false;
    const turnId=noticeTurnId(notice);if(!turnId)return false;
    if(turnId!==this.turnId){if(notice.method==='thread/tokenUsage/updated')this.invalidateBaseline();return false;}
    this.metrics.observe(notice);
    if(notice.method==='thread/tokenUsage/updated'){this.cumulative=tokenBreakdown(notice.params.tokenUsage?.total);this.lastUsage=notice;}
    if(notice.method==='item/agentMessage/delta'){
      const id=notice.params.itemId,previous=this.messages.get(id);
      if(previous?.final)previous.text=(previous.text||'')+(notice.params.delta||'');
      else{const record=previous||{chunks:[]};record.chunks.push(notice.params.delta||'');this.messages.set(id,record);}
    }
    if(notice.method==='item/completed'){
      const item=notice.params.item;
      if(item?.type==='agentMessage')this.messages.set(item.id,{final:true,text:item.text});
      if(item?.type==='fileChange'&&item.status==='completed')for(const change of item.changes||[])if(change.kind?.type!=='delete')this.files.add(change.path);
    }
    if(notice.method==='turn/completed')this.completed=notice.params.turn;
    return true;
  }
  confirm(turnId){this.bind(turnId);this.bound=true;}
  text(items=[]){
    const messages=new Map(this.messages);
    for(const item of items)if(item.type==='agentMessage')messages.set(item.id,{final:true,text:item.text});
    return [...messages.values()].map(message=>message.final?message.text:message.chunks.join('')).filter(Boolean).join('\n').trim();
  }
  release(){this.messages.clear();this.files.clear();this.completed=null;this.metrics=null;this.cumulative=null;this.lastUsage=null;}
}

export class TurnNotifications {
  constructor(options){this.options=options;this.threadId=options.threadId;this.pending=new Map();this.current=null;this.uncertain=false;this.overflow=false;this.hasStarted=false;}
  get metrics(){return this.current?.metrics;}
  get completed(){return this.current?.completed;}
  get cumulative(){return this.current?.cumulative;}
  get lastUsage(){return this.current?.lastUsage;}
  get files(){return this.current?.files||new Set();}
  invalidateBaseline(){this.uncertain=true;this.current?.invalidateBaseline();for(const bucket of this.pending.values())bucket.invalidateBaseline();}
  observe(notice){
    if(notice.params?.threadId!==this.threadId)return false;
    const turnId=noticeTurnId(notice);if(!turnId)return false;
    if(notice.method==='turn/started')this.hasStarted=true;
    if(this.current){const accepted=this.current.observe(notice);if(!accepted&&notice.method==='thread/tokenUsage/updated')this.invalidateBaseline();return accepted;}
    // RPC identity may arrive after early current AND late old-turn notices.
    // Keep semantic buckets, not arbitrary raw history, until it is known.
    let bucket=this.pending.get(turnId);
    if(!bucket){if(this.pending.size>=8){this.overflow=true;this.invalidateBaseline();return false;}bucket=new SingleTurnNotifications({...this.options,turnId});if(this.uncertain)bucket.invalidateBaseline();this.pending.set(turnId,bucket);}
    return bucket.observe(notice);
  }
  confirm(turnId){
    if(this.overflow)throw Error('too many notification turn identities before RPC settlement');
    this.current=this.pending.get(turnId)||new SingleTurnNotifications({...this.options,turnId});
    for(const [id,bucket] of this.pending){if(id!==turnId){if(bucket.cumulative)this.invalidateBaseline();bucket.release();}}
    this.pending.clear();if(this.uncertain)this.current.invalidateBaseline();this.current.confirm(turnId);
  }
  text(items=[]){return this.current?.text(items)||'';}
  release(){this.current?.release();for(const bucket of this.pending.values())bucket.release();this.pending.clear();this.current=null;}
}
