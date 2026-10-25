import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {managedReportSource} from '../src/agents/managed-report-source.mjs';

// Node-side evidence only: report HTML never crosses privileged renderer IPC.
export async function frozenReportEvidence({runtime,projectRoot,projectId,receipt,sourceFactory=managedReportSource}) {
  assert.match(receipt.objectId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const source=await sourceFactory({project:{id:projectId,root:projectRoot},runtime,objectId:receipt.objectId});
  assert.equal(source.objectId,receipt.objectId);
  assert.deepEqual(source.report,receipt.report);
  const bytes=await source.read();
  assert.equal(bytes.length,receipt.report.byteLength);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),receipt.report.digest);
  return {report:source.report,body:bytes.toString('utf8')};
}

export async function projectReportEvidence(invoke,projectId,objectId) {
  const status=await invoke('managed.status',{projectId});
  const receipt=status.state.receipts.find(receipt=>receipt.objectId===objectId);
  assert(receipt,'Report receipt must exist in the owned project');
  return frozenReportEvidence({runtime:status.runtimeRoot,projectRoot:status.state.contentRoot,projectId,receipt});
}
