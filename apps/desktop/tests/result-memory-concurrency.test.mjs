import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ResultMemory} from '../src/agents/managed/result-memory.mjs';
import {reportDescriptor} from '../src/agents/managed/report-descriptor.mjs';

// Isolated synthetic authoritative reports, matching result-memory.test.mjs.
function fixture() {
  const objects = new Map();
  const store = {projectId: randomUUID(), state: {works: [], receipts: []},
    async requireOnline() {},
    async readObject(digest) {
      assert(objects.has(digest));
      return objects.get(digest);
    }};
  for (let i = 0; i < 3; i++) {
    const id = randomUUID(), objectId = randomUUID();
    const body = Buffer.from(`shared alternate source${i} 😀\n${'Synthetic evidence. '.repeat(30)}`);
    const report = reportDescriptor(body, {format: 'markdown', objectId});
    objects.set(report.digest, body);
    store.state.works.push({id, name: `Report ${i}`, revision: 1, status: 'ended', outcome: 'accept',
      closure: {phase: 'complete', decision: 'accept', report: {
        digest: report.digest, objectId, publicationRevision: 1, kind: 'worker-report'}}});
    store.state.receipts.push({id: randomUUID(), workId: id, revision: 1, kind: 'result', objectId, report});
  }
  return {store, memory: new ResultMemory(store, {cacheMaxBytes: 64 * 1024})};
}
function semanticBytes(memory) {
  let bytes = 0;
  for (const [key, text] of memory.semantic) bytes += Buffer.byteLength(key) + Buffer.byteLength(text) + 64;
  return bytes;
}
function assertAccounting(memory) {
  const retainedProjection = memory.projection ? Buffer.byteLength(JSON.stringify(memory.projection)) : 0;
  assert.equal(memory.projectionBytes, retainedProjection);
  assert.equal(memory.cachedBytes, semanticBytes(memory) + retainedProjection);
  assert(memory.cachedBytes >= 0 && memory.cachedBytes <= memory.cacheMaxBytes);
}
function assertCoverage(result) {
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.eligible, 3);
  assert.equal(result.coverage.indexed, 3);
  assert.equal(result.totalMatches, 3);
  assert.equal(result.matches.length, 3);
  assert.equal(new Set(result.matches.map(row => row.source.workId)).size, 3);
  assert(result.coverage.cachedBytes <= result.coverage.cacheMaxBytes);
}

test('concurrent cold searches charge each admitted semantic source once', {timeout: 10000}, async () => {
  const {store, memory} = fixture();
  const readObject = store.readObject;
  const readers = 4;
  let arrived = 0, release, timer;
  const gate = new Promise((resolve, reject) => {
    release = resolve;
    timer = setTimeout(() => reject(Error('Read barrier timeout')), 5000);
  });
  gate.catch(() => {});
  store.readObject = async function(...args) {
    const body = await readObject.apply(this, args);
    if (arrived < readers) {
      arrived++;
      if (arrived === readers) { clearTimeout(timer); release(); }
      await gate;
    }
    return body;
  };
  try {
    // All four operations miss the same first source before any can admit it.
    const results = await Promise.allSettled(Array.from({length: readers}, () => memory.search({query: 'shared'})));
    for (const result of results) {
      assert.equal(result.status, 'fulfilled', result.reason?.stack);
      assertCoverage(result.value);
    }
    assert.equal(arrived, readers);
    assert.equal(memory.semantic.size, 3);
    assert.equal(memory.cachedBytes - memory.projectionBytes, semanticBytes(memory),
      'Overlapping misses must not charge an already admitted semantic key');
    assertAccounting(memory);
    assertCoverage(await memory.search({query: 'alternate'}));
    assertAccounting(memory);
  } finally {
    clearTimeout(timer); release(); store.readObject = readObject;
  }
});

test('concurrent warm projection builders replace rather than accumulate projection charges', {timeout: 10000}, async () => {
  const {store, memory} = fixture();
  assertCoverage(await memory.search({query: 'shared'}));
  assert.equal(memory.semantic.size, 3);
  assert(memory.projectionBytes > 0);
  assertAccounting(memory);
  const semanticCharge = semanticBytes(memory);
  // All semantic entries are cached. A different query forces overlapping
  // projection builders to await cached _searchText results, isolating projection
  // replacement from cold semantic admission.
  let reads = 0;
  const readObject = store.readObject;
  store.readObject = async function(...args) { reads++; return readObject.apply(this, args); };
  const results = await Promise.all(Array.from({length: 4}, () => memory.search({query: 'alternate'})));
  for (const result of results) assertCoverage(result);
  assert.equal(reads, 0, 'This regression must isolate warm semantic-cache projection construction');
  assert.equal(semanticBytes(memory), semanticCharge);
  assert(memory.projectionBytes > 0);
  assertAccounting(memory);
  assertCoverage(await memory.search({query: 'alternate'}));
  assertAccounting(memory);
});
