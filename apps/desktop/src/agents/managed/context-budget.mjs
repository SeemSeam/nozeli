// Shared host context budget: one ledger for every native run and every native
// compaction generation of a target (design §9). The native runtime keeps its
// own hard caps as a backstop; the host blocks earlier so tool reads and host
// text can never outrun the reserved receipt space. Byte counts are UTF-8
// approximations of host-added text, never token claims.
export const DEFAULT_CONTEXT_BUDGET={
  projectionMaxBytes:4096,
  runHostTextMaxBytes:65536,
  generationHostTextMaxBytes:262144,
  receiptReserveBytes:2048
};
const utf8=value=>Buffer.byteLength(String(value??''),'utf8');
const clampBytes=value=>Math.max(0,Number.isSafeInteger(value)?value:0);

export class HostContextBudget{
  constructor(limits={},epochState={}){
    this.limits={...DEFAULT_CONTEXT_BUDGET,...limits};
    // Generation scopes persist across host restarts; the caller hydrates them
    // from durable state and persists mutations after each charge.
    this.generations=new Map(Object.entries(epochState).map(([epoch,used])=>[epoch,clampBytes(used)]));
    this.runs=new Map();
  }
  epochKey(epoch){return String(epoch??'unknown');}
  epochUsed(epoch){return this.generations.get(this.epochKey(epoch))??0;}
  hydrateEpoch(epoch,usedBytes){this.generations.set(this.epochKey(epoch),clampBytes(usedBytes));}
  // A newly admitted native run resets only the run scope. Generation scope
  // resets exclusively when the runtime reports a confirmed compaction epoch.
  beginRun({target,runId,epoch}){
    const run={target,runId:String(runId??'run'),epoch:this.epochKey(epoch),usedBytes:0,entries:[],endedAt:null};
    this.runs.set(target,run);return run;
  }
  run(target){return this.runs.get(target)??null;}
  endRun(target){const run=this.runs.get(target);if(run&&!run.endedAt)run.endedAt=new Date().toISOString();}
  remainingRun(target){
    const run=this.runs.get(target);if(!run)return this.limits.runHostTextMaxBytes;
    return this.limits.runHostTextMaxBytes-run.usedBytes;
  }
  remainingGeneration(epoch){return this.limits.generationHostTextMaxBytes-this.epochUsed(epoch);}
  // A confirmed native compaction starts a fresh generation scope mid-run:
  // the run scope (its cap and usage) continues unchanged, only the
  // generation key rotates, so later charges can never be capped by the
  // superseded epoch.
  rotateEpoch(target,newEpoch){
    const run=this.runs.get(target);if(!run)return false;
    const next=this.epochKey(newEpoch);
    if(run.epoch===next)return false;
    run.epoch=next;return true;
  }
  // Pre-check without charging: can this many bytes still be admitted?
  allows(target,bytes,{epoch=this.run(target)?.epoch}={}){
    const value=clampBytes(bytes);
    const runOk=this.remainingRun(target)>=value,generationOk=this.remainingGeneration(epoch)>=value;
    return {ok:runOk&&generationOk,runOk,generationOk,remainingRun:Math.max(0,this.remainingRun(target)),remainingGeneration:Math.max(0,this.remainingGeneration(epoch))};
  }
  // Charge host-added persisted text or tool body bytes against both scopes.
  // Returns the refused scope so callers can page, pause, or block visibly —
  // never silently drop.
  charge(target,bytes,{kind='host-text',label=null,epoch=this.run(target)?.epoch}={}){
    const run=this.runs.get(target);
    const value=clampBytes(bytes);
    if(!run)return {ok:true,uncharged:true,remainingRun:null,remainingGeneration:this.remainingGeneration(epoch)};
    const check=this.allows(target,value,{epoch});
    if(!check.ok)return {ok:false,...check};
    run.usedBytes+=value;
    run.entries.push({kind,label,bytes:value,at:new Date().toISOString()});
    if(run.entries.length>128)run.entries.splice(0,run.entries.length-128);
    this.generations.set(this.epochKey(epoch),this.epochUsed(epoch)+value);
    return {ok:true,remainingRun:this.limits.runHostTextMaxBytes-run.usedBytes,remainingGeneration:this.remainingGeneration(epoch)};
  }
  // Read allowance: the most body bytes a read tool may return now while still
  // keeping the receipt reserve intact for pending effect admission.
  readAllowance(target,{epoch=this.run(target)?.epoch}={}){
    const remaining=Math.min(this.remainingRun(target),this.remainingGeneration(epoch));
    return Math.max(0,remaining-this.limits.receiptReserveBytes);
  }
  // Reserve receipt space before an effect executes. Refusal means the run can
  // no longer safely carry a receipt; the effect must not fire.
  reserveReceipt(target,{bytes=this.limits.receiptReserveBytes,epoch=this.run(target)?.epoch}={}){
    const run=this.runs.get(target);if(!run)return true;
    if(this.readAllowance(target,{epoch})<0||this.remainingRun(target)<bytes||this.remainingGeneration(epoch)<bytes)return false;
    run.usedBytes+=bytes;
    this.generations.set(this.epochKey(epoch),this.epochUsed(epoch)+bytes);
    return true;
  }
  snapshot(target,{epoch=this.run(target)?.epoch}={}){
    const run=this.runs.get(target);
    return {
      run:{usedBytes:run?.usedBytes??0,limitBytes:this.limits.runHostTextMaxBytes,...(run?{runId:run.runId,ended:Boolean(run.endedAt)}:{ended:null})},
      epoch:{epoch:this.epochKey(epoch),usedBytes:this.epochUsed(epoch),limitBytes:this.limits.generationHostTextMaxBytes},
      receiptReserveBytes:this.limits.receiptReserveBytes,
      projectionMaxBytes:this.limits.projectionMaxBytes
    };
  }
  persistedEpochs(){return Object.fromEntries([...this.generations.entries()].map(([epoch,used])=>[epoch,used]));}
}
export const utf8Bytes=utf8;
