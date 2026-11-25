// Pipe transport for explicitly prepared native Jobs. This has no capability
// selector and does not establish a persisted owner or business release fact.
import {Readable,Writable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createExperimentalProcessJob,waitExperimentalJobEmpty} from './experimental-process-job.mjs';
import {verifyExperimentalPreparedSupervisor} from './experimental-process-supervisor.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code});
const later=fn=>setTimeout(fn,2);
const transports=new WeakSet();
export const isExperimentalProcessTransport=value=>transports.has(value);
class JobOutput extends Readable {
  constructor(lease,channel){super({highWaterMark:64*1024});this.lease=lease;this.channel=channel;this.want=false;this.offset=0;this.supervisor=null;}
  _read(){this.want=true;if(!this.timer)this.pump();}
  pump(){
    this.timer=null;
    if(this.destroyed||!this.want)return;
    try{
      for(let count=0;count<8;count++){
        const result=this.supervisor?this.supervisor.readOutput(this.channel,this.offset):this.lease.readOutput(this.channel);
        if(result.state==='pending'){this.timer=later(()=>this.pump());return;}
        if(result.state==='eof'){this.want=false;this.push(null);return;}
        this.offset+=result.bytes.length;
        if(!this.push(result.bytes)){this.want=false;return;}
      }
      this.timer=later(()=>this.pump());
    }catch(error){this.destroy(error);}
  }
  _destroy(error,callback){
    clearTimeout(this.timer);this.timer=null;this.want=false;
    try{this.lease.closeOutput(this.channel);}catch(cause){if(cause.code!=='PROCESS_JOB_CLOSED')error??=cause;}
    callback(error);
  }
}
class JobInput extends Writable {
  constructor(lease){super({highWaterMark:64*1024});this.lease=lease;this.active=null;this.bytesCompleted=0;}
  _write(bytes,encoding,callback){if(!bytes.length){callback();return;}this.active={bytes,offset:0,callback,pending:false};this.pump();}
  pump(){
    this.timer=null;const active=this.active;if(!active||this.destroyed)return;
    try{
      const input=this.supervisor??this.lease;
      const result=active.pending?input.pollInput():input.writeInput(active.bytes.subarray(active.offset,active.offset+65536));
      active.pending=result.state==='pending';
      if(!active.pending){
        if(!Number.isInteger(result.bytes)||result.bytes<=0)throw fail('PROCESS_STDIN_WRITE_FAILED','Input made no confirmed progress; no replay');
        active.offset+=result.bytes;this.bytesCompleted+=result.bytes;
        if(active.offset===active.bytes.length){this.active=null;active.callback();return;}
      }
      this.timer=later(()=>this.pump());
    }catch(error){error.inputBytesCompleted=this.bytesCompleted;error.transferUnconfirmed=true;this.active=null;active.callback(error);}
  }
  _final(callback){try{(this.supervisor??this.lease).closeInput();callback();}catch(error){callback(error);}}
  _destroy(error,callback){
    clearTimeout(this.timer);this.timer=null;
    try{(this.supervisor??this.lease).abortInput();}catch(cause){if(cause.code!=='PROCESS_JOB_CLOSED')error??=cause;}
    const active=this.active;this.active=null;
    if(active){const cause=error??fail('PROCESS_STDIN_ABORTED','Input aborted; bytes may have transferred, no replay');cause.transferUnconfirmed=true;cause.inputBytesCompleted=this.bytesCompleted;active.callback(cause);}
    callback(error);
  }
}

export function prepareExperimentalProcessTransport(spec){
  const lease=createExperimentalProcessJob({...spec,stdio:'pipe'});
  const transport=new EventEmitter();
  transports.add(transport);
  transport.lease=lease;transport.pid=lease.snapshot().pid;
  transport.stdin=new JobInput(lease);transport.stdout=new JobOutput(lease,1);transport.stderr=new JobOutput(lease,2);
  transport.errors=[];
  transport.attachSupervisor=pin=>{
    if(transport.supervisor||transport.stdout.want||transport.stderr.want||transport.stdout.offset||transport.stderr.offset||transport.stdin.active||transport.stdin.bytesCompleted||transport.stdin.writableEnded)
      throw fail('PROCESS_OUTPUT_SUPERVISED','Supervisor must attach once before stream consumption');
    const endpoint=verifyExperimentalPreparedSupervisor(pin,transport.preparedIdentity());
    if(!endpoint.outputCustodyVerified)throw fail('SUPERVISOR_OUTPUT_UNAVAILABLE','Original output endpoint custody required');
    if(!endpoint.inputCustodyVerified)throw fail('SUPERVISOR_INPUT_UNAVAILABLE','Original input endpoint custody required');
    transport.supervisor=pin;transport.stdin.supervisor=pin;transport.stdout.supervisor=pin;transport.stderr.supervisor=pin;
  };
  for(const [channel,stream] of Object.entries({stdin:transport.stdin,stdout:transport.stdout,stderr:transport.stderr}))
    stream.on('error',error=>{transport.errors.push({channel,error});transport.emit('transport-error',{channel,error});});
  let timer=null,leaderExit=false,closed=false;
  const observe=()=>{
    timer=null;if(closed)return;
    try{
      const facts=lease.snapshot();
      if(!leaderExit&&facts.leaderState==='exited'){leaderExit=true;transport.emit('exit',facts.leaderExitCode,null);}
      if(facts.jobEmptyObserved){transport.emit('job-empty',facts);return;}
      timer=later(observe);
    }catch(error){transport.errors.push({channel:'job',error});transport.emit('transport-error',{channel:'job',error});}
  };
  transport.resume=()=>{const facts=lease.resume();if(!timer)timer=later(observe);return facts;};
  transport.preparedIdentity=()=>{
    const facts=lease.snapshot();
    if(facts.state!=='prepared'||facts.resumed)throw fail('PROCESS_JOB_RESUME_REFUSED','Expected a retained, unresumed prepared process');
    return Object.freeze({schema:1,platform:'win32',pid:facts.pid,creationTime100ns:facts.creationTime100ns,stamp:facts.stamp});
  };
  transport.terminate=()=>{const facts=lease.terminate();if(!timer)timer=later(observe);return facts;};
  transport.waitForJobEmpty=options=>waitExperimentalJobEmpty(lease,options);
  transport.waitForExitAndDrain=async({timeoutMs=5000}={})=>{
    if(!Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>30000)throw fail('PROCESS_WAIT_INVALID','Expected timeout in 0..30000 ms');
    const deadline=performance.now()+timeoutMs;
    for(;;){
      const facts=lease.snapshot();
      if(transport.errors.length)throw Object.assign(fail('PROCESS_TRANSPORT_UNCONFIRMED','Transport failed; retain registration'),{errors:transport.errors});
      if(facts.jobEmptyObserved&&transport.stdout.readableEnded&&transport.stderr.readableEnded&&
         !transport.stdin.writableLength&&!transport.stdin.active)return {...facts,stdoutEOF:true,stderrEOF:true,inputDrained:true};
      if(performance.now()>=deadline)throw Object.assign(fail('PROCESS_DRAIN_UNCONFIRMED','Job and both output EOFs are required; retain registration'),{facts,stdoutEOF:transport.stdout.readableEnded,stderrEOF:transport.stderr.readableEnded});
      await delay(Math.min(10,Math.max(1,deadline-performance.now())));
    }
  };
  transport.close=()=>{
    if(closed)return;
    // Do not tear down streams/handles on an unconfirmed exit.
    const facts=lease.snapshot();if(!facts.jobEmptyObserved)throw fail('PROCESS_JOB_ACTIVE','Job exit unconfirmed; transport retained');
    closed=true;clearTimeout(timer);timer=null;
    transport.stdin.destroy();transport.stdout.destroy();transport.stderr.destroy();lease.close();
  };
  return transport;
}
