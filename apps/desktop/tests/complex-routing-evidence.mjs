import assert from 'node:assert/strict';

// Assertions consume persisted facts and actual file bytes; they never create state.
export function assertSameWork(before, after) {
  assert.equal(after.id, before.id, 'supplement must retain Work identity');
  assert.equal(after.threadId, before.threadId, 'supplement must retain original thread');
  assert.ok(after.revision > before.revision, 'supplement must run a newer revision');
}
export function assertSlots(state, expected) {
  const open = state.works.filter(w => !['queued', 'ended'].includes(w.status));
  assert.equal(open.length, expected, 'running/paused/review/closing all retain slots');
  assert.equal(state.quotaUsed, expected, 'published quota must agree with Work facts');
  assert.ok(expected <= state.limit, 'quota must not exceed limit');
}
export function assertReview(state, id) {
  const work = state.works.find(w => w.id === id);
  assert.ok(work, 'original Work exists');
  assert.equal(work.status, 'review');
  assert.ok(state.receipts.some(r => r.workId === id && r.kind === 'result' && r.revision === work.revision), 'current revision has real result receipt');
  return work;
}
export function assertNoReplay(before, after) {
  for (const job of before.jobs.filter(j => j.status === 'completed')) {
    const rows = after.jobs.filter(j => j.id === job.id);
    assert.equal(rows.length, 1, 'completed job remains unique');
    assert.equal(rows[0].status, 'completed');
    assert.equal(rows[0].turnId, job.turnId, 'completed turn was not replayed');
  }
  for (const work of before.works.filter(w => w.threadId && w.status !== 'ended')) {
    assert.equal(after.works.find(w => w.id === work.id)?.threadId, work.threadId, 'restart retains original thread');
  }
}
