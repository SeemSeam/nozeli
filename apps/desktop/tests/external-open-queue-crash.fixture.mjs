import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {ExternalOpenQueue} from '../src/main/external-open-queue.mjs';

// Only the parent's newly created directory. No Electron, CLI or Provider.
const dir=process.argv[2],mode=process.argv[3];
const host=new DesktopHost(path.join(dir,'profile')),queue=new ExternalOpenQueue({host});
const wc={},window={webContents:wc},owner={bootId:queue.bootId,window,webContents:wc,generation:0};
const {requestId}=await queue.enqueue({absolutePath:path.join(dir,'project','A.txt'),source:'argv'});
const claim=await queue.claimOpen(owner,{requestId,expectedRevision:(await queue.openQueue()).revision,mode:'fresh'});
if(mode==='terminal'){
 const read=await queue.readClaimedOpen(owner,claimPayload(claim));
 // Explicitly a synthetic receiver display assertion, not an actual GUI.
 await queue.resolveOpen(owner,{...claimPayload(claim),outcome:'opened',readReceipt:read.readReceipt,display:{opened:true,surfaceReady:true,surfaceEpoch:0,projectId:read.projectId,relPath:read.relPath,display:'source',digest:read.digest,materialDigest:read.materialDigest,draftDigest:read.draftDigest}});
}
process.send({phase:mode==='terminal'?'terminal-written':'claim-written',pid:process.pid,requestId,claim,bootId:queue.bootId});
await new Promise(resolve=>process.once('message',resolve));
function claimPayload(c){const {requestId,attemptId,claimToken,generation}=c;return {requestId,attemptId,claimToken,generation};}
