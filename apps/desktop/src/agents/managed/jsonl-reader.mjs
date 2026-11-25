// Shared byte-framing only. Owner/request admission and replay decisions stay
// with PiSession; platform transports supply ordinary Node readable streams.
const MAX_FRAME_BYTES=64*1024*1024;
const fail=(reason,message,cause)=>Object.assign(Error(message,{cause}),{code:'JSONL_PROTOCOL_INVALID',reason});

export function createJsonlReader(stream,{onFrame,onError,maxFrameBytes=MAX_FRAME_BYTES}={}){
  if(typeof onFrame!=='function'||typeof onError!=='function'||!Number.isInteger(maxFrameBytes)||maxFrameBytes<1||maxFrameBytes>MAX_FRAME_BYTES)
    throw Object.assign(Error('Expected frame/error callbacks and a 1..64 MiB byte budget'),{code:'JSONL_OPTIONS_INVALID'});
  let buffer=Buffer.alloc(0),length=0,closed=false,failure=null,completed=false;
  const detach=()=>{stream.off('data',data);stream.off('end',end);stream.off('error',error);stream.off('close',close);};
  const reject=error=>{if(closed)return;failure=error;closed=true;detach();buffer=Buffer.alloc(0);length=0;stream.pause();onError(error);};
  const append=bytes=>{
    if(length+bytes.length>maxFrameBytes)throw fail('frame-too-large','JSONL frame exceeds its byte budget');
    if(buffer.length<length+bytes.length){
      const grown=Buffer.allocUnsafe(Math.min(maxFrameBytes,Math.max(length+bytes.length,Math.max(1024,buffer.length*2))));
      buffer.copy(grown,0,0,length);buffer=grown;
    }
    bytes.copy(buffer,length);length+=bytes.length;
  };
  const data=chunk=>{
    if(closed)return;
    try{
      if(!Buffer.isBuffer(chunk)&&!(chunk instanceof Uint8Array))throw fail('decoded-stream','JSONL requires undecoded bytes');
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      let start=0;
      while(start<bytes.length&&!closed){
        const newline=bytes.indexOf(10,start),end=newline<0?bytes.length:newline;
        append(bytes.subarray(start,end));start=end+1;
        if(newline<0)break;
        const size=length&&buffer[length-1]===13?length-1:length;
        if(!size)throw fail('empty-frame','Empty JSONL frame is invalid');
        let text,message;
        try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size));}
        catch(cause){throw fail('utf8','JSONL frame contains invalid UTF-8',cause);}
        try{message=JSON.parse(text);}
        catch{throw fail('json','JSONL frame is not valid JSON');}
        if(!message||typeof message!=='object'||Array.isArray(message))throw fail('shape','JSONL frame must be an object');
        length=0;onFrame(message);
      }
    }catch(cause){reject(cause.code==='JSONL_PROTOCOL_INVALID'?cause:fail('handler','JSONL frame handler failed',cause));}
  };
  const end=()=>{if(closed)return;if(length){reject(fail('truncated','EOF interrupted a JSONL frame; no replay'));return;}completed=true;closed=true;detach();buffer=Buffer.alloc(0);};
  const error=cause=>reject(fail('stream','JSONL input stream failed; no replay',cause));
  const close=()=>{if(!closed)reject(fail('disconnected','JSONL stream closed without EOF; no replay'));};
  stream.on('data',data);stream.once('end',end);stream.once('error',error);stream.once('close',close);
  return Object.freeze({
    get bufferedBytes(){return length;},get failed(){return failure;},get completed(){return completed;},
    close(){if(closed)return;closed=true;detach();buffer=Buffer.alloc(0);length=0;},
  });
}
