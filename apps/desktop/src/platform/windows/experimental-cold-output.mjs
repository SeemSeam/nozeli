// Read retained bytes only after source/owner/original-helper verification.
// These observations do not mint retirement authority or feed PiSession.
import {createHash} from 'node:crypto';
import {inspectExperimentalColdHostSources} from './experimental-host-sources.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code,automaticReplay:false});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function inspectExperimentalColdHostOutput(binding){
  const {supervisor}=binding??{};
  const source=await inspectExperimentalColdHostSources(binding);
  const before=supervisor.snapshot();
  if(!before.outputCustodyVerified||before.outputError||!before.stdoutEOF||!before.stderrEOF||!before.jobEmptyObserved)
    throw fail('HOST_OUTPUT_UNVERIFIED','Original exited Job, both retained EOFs and error-free output custody required');
  if(!Number.isSafeInteger(before.stdoutBytes)||!Number.isSafeInteger(before.stderrBytes)||
     before.stdoutBytes<0||before.stderrBytes<0||before.stdoutBytes+before.stderrBytes>before.outputLimitBytes)
    throw fail('HOST_OUTPUT_UNVERIFIED','Retained output exceeds its native lifetime bound');
  const result={};
  for(const [channel,name] of [[1,'stdout'],[2,'stderr']]){
    const size=before[name+'Bytes'],chunks=[];let offset=0;
    for(;;){
      const range=supervisor.readOutput(channel,offset);
      if(range.state==='eof'){if(offset!==size)throw fail('HOST_OUTPUT_CHANGED','Retained stream ended before its declared size');break;}
      if(range.state!=='data'||!Buffer.isBuffer(range.bytes)||!range.bytes.length||range.bytes.length>65536||offset+range.bytes.length>size)
        throw fail('HOST_OUTPUT_CHANGED','Retained output range differs from its original complete stream');
      chunks.push(range.bytes);offset+=range.bytes.length;
    }
    const bytes=Buffer.concat(chunks,size),digest=sha(bytes);
    if(digest!==before[name+'Sha256'])throw fail('HOST_OUTPUT_CHANGED','Retained bytes differ from the independent helper digest');
    result[name]=Object.freeze({bytes,byteLength:size,sha256:digest});
  }
  const after=supervisor.snapshot();
  for(const name of ['stamp','hostPid','hostCreationTime100ns','hostExited','jobEmptyObserved','outputCustodyVerified','outputError','stdoutEOF','stderrEOF','stdoutBytes','stderrBytes','stdoutSha256','stderrSha256'])
    if(after[name]!==before[name])throw fail('HOST_OUTPUT_CHANGED','Retained output facts changed during cold inspection');
  if(!same(source,await inspectExperimentalColdHostSources(binding)))
    throw fail('HOST_SOURCE_BINDING_CHANGED','Source/owner registration changed during output inspection');
  return Object.freeze({schema:1,scope:'cold-host-retained-output-observation-only',source,...result,
    stdoutEOF:true,stderrEOF:true,outputDigestVerified:true,storage:'original-helper-memory',
    durableAcrossHelperExit:false,coldRecoveryQualified:false,ownerReleaseQualified:false,automaticReplay:false});
}
