// Observe bytes admitted from the original kernel-identified host, never write
// or replay them. Successful transfer alone does not prove business settlement.
import {createHash} from 'node:crypto';
import {inspectExperimentalColdHostSources} from './experimental-host-sources.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code,automaticReplay:false});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function inspectExperimentalColdHostInput(binding){
  const {supervisor}=binding,source=await inspectExperimentalColdHostSources(binding),before=supervisor.snapshot();
  if(!before.inputCustodyVerified||before.inputError||before.inputPending||!before.inputClosed||!before.jobEmptyObserved||
     !Number.isSafeInteger(before.inputBytes)||before.inputBytes<0||before.inputBytes>before.inputLimitBytes||before.inputCompletedBytes!==before.inputBytes)
    throw fail('HOST_INPUT_UNVERIFIED','Complete original-host input custody and confirmed native delivery required');
  const chunks=[];let offset=0;
  for(;;){
    const range=supervisor.readInput(offset);
    if(range.state==='eof'){if(offset!==before.inputBytes)throw fail('HOST_INPUT_CHANGED','Original input ended early');break;}
    if(range.state!=='data'||!Buffer.isBuffer(range.bytes)||!range.bytes.length||range.bytes.length>65536||offset+range.bytes.length>before.inputBytes)
      throw fail('HOST_INPUT_CHANGED','Input range differs from the complete original-host stream');
    chunks.push(range.bytes);offset+=range.bytes.length;
  }
  const bytes=Buffer.concat(chunks,offset),sha256=createHash('sha256').update(bytes).digest('hex');
  if(sha256!==before.inputSha256)throw fail('HOST_INPUT_CHANGED','Input differs from independent original helper digest');
  const after=supervisor.snapshot();
  for(const name of ['stamp','hostPid','hostCreationTime100ns','hostExited','jobEmptyObserved','inputCustodyVerified','inputError','inputPending','inputClosed','inputBytes','inputCompletedBytes','inputSha256'])
    if(before[name]!==after[name])throw fail('HOST_INPUT_CHANGED','Original input evidence changed');
  if(!same(source,await inspectExperimentalColdHostSources(binding)))throw fail('HOST_SOURCE_BINDING_CHANGED','Source changed during input inspection');
  return Object.freeze({schema:1,scope:'cold-host-original-input-observation-only',source,bytes,byteLength:offset,sha256,
    originalHostVerified:true,nativeDeliveryConfirmed:true,durableAcrossHelperExit:false,hostProjectionQualified:false,
    coldRecoveryQualified:false,ownerReleaseQualified:false,automaticReplay:false});
}
