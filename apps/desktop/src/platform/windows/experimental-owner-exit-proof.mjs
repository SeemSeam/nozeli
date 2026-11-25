// An opaque local receipt ties retirement to the original in-memory native
// transport. A serialized summary, cloned object or arbitrary verifier cannot
// mint authority for another process, a cold record or an active Job.
import {isExperimentalProcessTransport} from './experimental-process-transport.mjs';
const receipts=new WeakMap();
const fail=()=>Object.assign(Error('Retained native Job, both EOFs and host/journal postchecks required'),{code:'OWNER_EXIT_UNVERIFIED'});
export function retainExperimentalOwnerExitProof(child,verifyHostAndJournal){
  if(!isExperimentalProcessTransport(child)||typeof verifyHostAndJournal!=='function')throw fail();
  const receipt=Object.freeze({});receipts.set(receipt,{child,verifyHostAndJournal});return receipt;
}
export function verifyExperimentalOwnerExitProof(receipt){
  const held=receipts.get(receipt);if(!held)throw fail();
  const {child,verifyHostAndJournal}=held,facts=child.lease.snapshot();
  if(!facts.jobEmptyObserved||!facts.allProcessIncarnationsObserved||child.errors.length||
     !child.stdout.readableEnded||!child.stderr.readableEnded||child.stdin.active||child.stdin.writableLength)throw fail();
  return {...verifyHostAndJournal(),identity:{schema:1,platform:'win32',pid:facts.pid,creationTime100ns:facts.creationTime100ns,stamp:facts.stamp},
    allProcessIncarnationsObserved:true,stdoutEOF:true,stderrEOF:true};
}
