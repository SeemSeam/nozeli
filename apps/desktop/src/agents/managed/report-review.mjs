import {createHash} from 'node:crypto';
import {safeBytes,workPath} from './execution-workspace.mjs';
import {readStoredReport} from './report-descriptor.mjs';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function artifactSnapshot(root,paths){
 const rows=[];for(const relPath of [...new Set(paths)].sort()){workPath(relPath);const bytes=await safeBytes(root,relPath);rows.push({relPath,digest:bytes===null?null:digest(bytes),size:bytes===null?0:bytes.length});}return rows;
}
export async function validateReport(store,w){
 const receipt=store.state.receipts.find(r=>r.workId===w.id&&r.objectId===w.result?.objectId&&r.kind==='result'&&r.revision===w.revision);
 if(!receipt?.snapshot)throw Error('Report has no candidate snapshot');
 const report=await readStoredReport(store,receipt);if(digest(report)!==receipt.snapshot.reportDigest)throw Error('Report bytes changed');
 const files=await artifactSnapshot(receipt.snapshot.directory||w.execution?.directory||store.content,receipt.snapshot.files.map(f=>f.relPath));
 if(JSON.stringify(files)!==JSON.stringify([...receipt.snapshot.files].sort((a,b)=>a.relPath<b.relPath?-1:a.relPath>b.relPath?1:0)))throw Error('Candidate files changed after report');
 return {reportObjectId:receipt.objectId,revision:w.revision,reportDigest:receipt.snapshot.reportDigest,files};
}
