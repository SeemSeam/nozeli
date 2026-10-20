import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSlots, assertSameWork, assertNoReplay, assertReview} from './complex-routing-evidence.mjs';

test('evidence rejects duplicate Work or replacement thread for continuation', () => {
  const original = {id:'a',threadId:'original',revision:1};
  assert.throws(() => assertSameWork(original,{id:'b',threadId:'original',revision:2}));
  assert.throws(() => assertSameWork(original,{id:'a',threadId:'replacement',revision:2}));
  assert.throws(() => assertSameWork(original,{...original}));
});
test('evidence counts paused/review/closing and rejects early slot release', () => {
  const works = ['paused','review','closing','queued','ended'].map((status,i)=>({id:String(i),status}));
  assertSlots({works,quotaUsed:3,limit:3},3);
  assert.throws(() => assertSlots({works,quotaUsed:2,limit:3},3));
  assert.throws(() => assertSlots({works,quotaUsed:3,limit:2},3));
});
test('evidence rejects stale report for a newer execution', () => {
  const state = {works:[{id:'a',revision:2,status:'review'}],receipts:[{workId:'a',revision:1,kind:'result'}]};
  assert.throws(() => assertReview(state,'a'));
});
test('evidence detects completed turn replay after restart', () => {
  const before = {jobs:[{id:'j',status:'completed',turnId:'old'}],works:[{id:'a',threadId:'t',status:'review'}]};
  assert.throws(() => assertNoReplay(before,{jobs:[{id:'j',status:'completed',turnId:'new'}],works:before.works}));
  assert.throws(() => assertNoReplay(before,{jobs:before.jobs,works:[{id:'a',threadId:'new',status:'review'}]}));
});
