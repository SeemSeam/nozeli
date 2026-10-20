import fs from 'node:fs/promises';
import path from 'node:path';
// Runs only AFTER the unmodified production invocation completed. Never changes its result/state.
export async function afterInvoke(op,payload,value){
 if(op!=='managed.git.retry'||!value?.accepted)return;
 const root=process.env.NOZELI_FAULT_ROOT,arm=path.join(root,'receipt-fault-arm');
 try{await fs.access(arm);}catch{return;}
 await fs.unlink(arm);
 await fs.appendFile(path.join(root,'fault-timeline.jsonl'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,event:'production-result-before-ipc-return',op,payload,value})+'\n');
 throw Error('OWNED_POST_COMMIT_IPC_TRANSPORT_FAULT');
}
