import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {performance, monitorEventLoopDelay} from 'node:perf_hooks';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {reportDescriptor} from '../src/agents/managed/report-descriptor.mjs';
import {ResultMemory} from '../src/agents/managed/result-memory.mjs';

// Run: node tests/result-memory-concurrency-live.mjs
// Actual SQLite and immutable objects; bounded synthetic data; no model/network calls.
// Every requested operation must succeed (after bounded stale retries), or fail the run.
// JSON evidence and owned fixture remain under the printed /tmp directory.
const COUNT = 200, ROUNDS = 15, MAX_ATTEMPTS = 8, CACHE_BYTES = 2 * 1024 * 1024;
const prefix = 'nozeli-result-memory-concurrency-';
const coldMode = process.argv[2] === '--cold';
const root = coldMode ? process.argv[3] : await fs.mkdtemp(path.join(os.tmpdir(), prefix));
if (!root || path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith(prefix)) {
  throw Error('Only an owned synthetic temporary directory is allowed');
}
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => JSON.stringify(value);
function canonicalState(state) {
  const value = structuredClone(state);
  // managed-storage reconstructs this derived index on load; array order itself
  // remains authoritative and is still included in the digest below.
  delete value.collectionOrder;
  // Native recovery materializes these empty defaults even without native jobs.
  value.sessionIndex ??= {};
  value.sessionIndex.portableMessages ??= [];
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item, 2);
}
const stateDigest = state => hash(canonicalState(state));
const bodyFor = i => `# Synthetic corpus report ${i}\n\ncommonprobe source${i} 轨道 😀\n` +
  (`Evidence ${i}: energy constraint retained; Linux only; 合成验证 😀.\n`).repeat(350);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function open() {
  const storage = new ProjectStorage(path.join(root, 'storage'));
  try {
    const binding = JSON.parse(await fs.readFile(path.join(root, 'binding.json'), 'utf8'));
    const store = await Workspace.open(path.join(root, 'runtime'), binding.root, {storage, projectId: binding.id});
    return {storage, store};
  } catch (error) { await storage.db.close(); throw error; }
}
async function close(storage, store) {
  try { if (store && !store.closed) await store.close(); }
  finally { await storage?.db.close(); }
}
function cacheFacts(memory) {
  let semanticBytes = 0;
  for (const [key, text] of memory.semantic) semanticBytes += Buffer.byteLength(key) + Buffer.byteLength(text) + 64;
  const projectionBytes = memory.projection ? Buffer.byteLength(JSON.stringify(memory.projection)) : 0;
  return {accountedBytes: memory.cachedBytes, semanticBytes, projectionBytes,
    retainedBytes: semanticBytes + projectionBytes, entries: memory.semantic.size, budgetBytes: memory.cacheMaxBytes};
}
function assertBudget(memory) {
  const facts = cacheFacts(memory);
  assert(facts.accountedBytes >= 0 && facts.accountedBytes <= CACHE_BYTES, 'Accounted cache exceeds default budget');
  assert(facts.retainedBytes <= CACHE_BYTES, 'Retained cache exceeds default budget');
  return facts;
}
async function exactPages(memory, source, index) {
  const expected = bodyFor(index), digest = createHash('sha256');
  let offset = 0, pages = 0;
  // A hard ceiling makes a broken continuation fail, never allocate or loop forever.
  for (; pages < 128; pages++) {
    const page = await memory.read(source, {offset, maxBytes: 2048});
    assert.deepEqual(page.source, source);
    assert(Buffer.byteLength(JSON.stringify(page)) <= 2048);
    assert.equal(page.offset, offset);
    assert.equal(page.totalChars, expected.length);
    assert(page.endOffset > offset, 'Page must make progress');
    assert.equal(page.text, expected.slice(offset, page.endOffset));
    digest.update(page.text);
    if (page.nextOffset === null) {
      assert.equal(page.endOffset, expected.length);
      assert.equal(digest.digest('hex'), source.digest);
      return pages + 1;
    }
    assert.equal(page.nextOffset, page.endOffset);
    offset = page.nextOffset;
  }
  throw Error('Source pagination exceeded bounded page count');
}

if (coldMode) {
  let storage, store;
  const result = {ok: false, pid: process.pid};
  try {
    ({storage, store} = await open());
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'restart-manifest.json'), 'utf8'));
    await fs.writeFile(path.join(root, 'cold-actual-state.json'), canonicalState(store.state));
    assert.equal(stateDigest(store.state), manifest.stateDigest, 'Cold SQLite logical state must be identical');
    const work = store.find(manifest.consumerId);
    assert.deepEqual(work.memorySources, manifest.memorySources);
    assert.deepEqual(work.memorySourceBindings, manifest.memorySourceBindings);
    const memory = new ResultMemory(store);
    const search = await memory.search({query: 'commonprobe', includeHistory: true, limit: 5});
    assert.equal(search.coverage.complete, true);
    assert.equal(search.totalMatches, COUNT);
    for (const sample of manifest.samples) {
      assert.deepEqual(await memory.resolve(sample.source), sample.source);
      await exactPages(memory, sample.source, sample.index);
    }
    result.cache = assertBudget(memory);
    result.stateDigest = manifest.stateDigest;
    result.provenanceBindings = work.memorySourceBindings.length;
    result.ok = true;
  } catch (error) { result.error = error.stack; process.exitCode = 1; }
  finally {
    try { await close(storage, store); } catch (error) { result.ok = false; result.closeError = error.stack; process.exitCode = 1; }
    await fs.writeFile(path.join(root, 'cold-report.json'), JSON.stringify(result, null, 2));
  }
} else {
  const report = {ok: false, root, scope: 'Synthetic SQLite/Workspace concurrency; zero models',
    config: {reports: COUNT, rounds: ROUNDS, maxAttempts: MAX_ATTEMPTS, cacheBytes: CACHE_BYTES},
    checks: [], failures: [], operations: [], cacheSamples: [], metrics: {requested: 0, succeeded: 0, failed: 0, attempts: 0, staleRetries: 0}};
  let storage, store, memory;
  const lag = monitorEventLoopDelay({resolution: 10});
  const start = performance.now(), rssStart = process.memoryUsage().rss;
  let peakRss = rssStart;
  lag.enable();
  const rssTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 25);
  const scenario = async (name, fn) => {
    const started = performance.now();
    try { const details = await fn(); report.checks.push({name, ok: true, ms: performance.now() - started, details}); }
    catch (error) { report.failures.push({name, error: error.stack}); }
  };
  async function operation(kind, fn) {
    report.metrics.requested++;
    const started = performance.now();
    let attempts = 0;
    try {
      for (; attempts < MAX_ATTEMPTS;) {
        attempts++; report.metrics.attempts++;
        try {
          const value = await fn();
          report.metrics.succeeded++;
          report.operations.push({kind, ok: true, attempts, ms: performance.now() - started});
          return value;
        } catch (error) {
          if (error.code !== 'RESULT_MEMORY_STALE' || attempts === MAX_ATTEMPTS) throw error;
          report.metrics.staleRetries++;
          await store.serial;
          await pause(Math.min(attempts * 2, 16));
        }
      }
    } catch (error) {
      report.metrics.failed++;
      report.operations.push({kind, ok: false, attempts, ms: performance.now() - started, code: error.code, error: error.message});
      throw error;
    }
  }
  try {
    await fs.mkdir(path.join(root, 'project'));
    await fs.mkdir(path.join(root, 'other-project'));
    storage = new ProjectStorage(path.join(root, 'storage'));
    const binding = await storage.register(path.join(root, 'project'));
    const other = await storage.register(path.join(root, 'other-project'));
    await fs.writeFile(path.join(root, 'binding.json'), JSON.stringify(binding));
    store = await Workspace.open(path.join(root, 'runtime'), binding.root, {storage, projectId: binding.id});
    const seedStart = performance.now(), works = [], receipts = [], sources = [];
    let corpusBytes = 0, acceptedBytes = 0;
    for (let i = 0; i < COUNT; i++) {
      const id = randomUUID(), objectId = randomUUID(), body = Buffer.from(bodyFor(i));
      const descriptor = reportDescriptor(body, {format: 'markdown', objectId});
      await store.putObject(body);
      const outcome = i % 10 === 0 ? 'discard' : 'accept';
      corpusBytes += body.length;
      if (outcome === 'accept') acceptedBytes += body.length;
      works.push({id, agentId: randomUUID(), name: `Synthetic report ${i}`, request: `Compare source ${i}`,
        brief: 'Synthetic fixture', revision: 1, status: 'ended', outcome,
        closure: {phase: 'complete', decision: outcome, revision: 1,
          report: {digest: descriptor.digest, objectId, publicationRevision: 1, kind: 'worker-report', revision: 1},
          git: {complete: true, status: outcome === 'accept' ? 'merged' : 'discarded', commit: `synthetic-${i}`}}});
      receipts.push({id: randomUUID(), workId: id, revision: 1, kind: 'result', objectId, report: descriptor});
      sources.push({projectId: binding.id, workId: id, objectId, digest: descriptor.digest});
    }
    const consumerId = randomUUID();
    const memorySources = [sources[1], sources[10]];
    const memorySourceBindings = [
      {sourceJobId: 'synthetic-dispatch', revision: 1, action: 'dispatch', sources: [sources[1]]},
      {sourceJobId: 'synthetic-continue', revision: 2, action: 'continue', sources: memorySources}];
    await store.mutate(() => {
      // saveManagedState materializes empty recovery drafts; make that fixture
      // state explicit before capturing the pre-restart logical snapshot.
      store.state.drafts ??= {};
      store.state.works.push(...works, {id: consumerId, agentId: randomUUID(), name: 'Synthetic provenance consumer',
        request: 'Retain exact prior sources', brief: 'No worker launch', status: 'queued', revision: 2,
        memorySources, memorySourceBindings});
      store.state.receipts.push(...receipts);
    });
    assert(acceptedBytes > CACHE_BYTES, 'Default eligible corpus must exceed default cache');
    report.fixture = {corpusBytes, acceptedBytes, seedMs: performance.now() - seedStart, accepted: 180, discarded: 20};
    memory = new ResultMemory(store);
    assert.equal(memory.cacheMaxBytes, CACHE_BYTES);

    await scenario('Tiny corpus concurrent semantic and projection accounting', async () => {
      const tiny = await Workspace.open(path.join(root, 'tiny-runtime'), other.root, {storage, projectId: other.id});
      let release, timer;
      const gate = new Promise((resolve, reject) => {
        release = resolve;
        timer = setTimeout(() => reject(Error('Concurrent real-read barrier timed out')), 10000);
      });
      // Observe rejection even if setup fails before any reader reaches the gate.
      gate.catch(() => {});
      const readObject = tiny.readObject;
      let arrived = 0;
      try {
        for (const index of [1, 2, 3]) await tiny.putObject(Buffer.from(bodyFor(index)));
        await tiny.mutate(() => {
          tiny.state.works.push(...structuredClone(works.slice(1, 4)));
          tiny.state.receipts.push(...structuredClone(receipts.slice(1, 4)));
        });
        tiny.readObject = async function(...args) {
          const bytes = await readObject.apply(this, args);
          // Only synchronize the first four actual immutable-object reads; never fake data.
          if (arrived < 4) {
            arrived++;
            if (arrived === 4) { clearTimeout(timer); release(); }
            await gate;
          }
          return bytes;
        };
        const tinyMemory = new ResultMemory(tiny);
        const rows = await Promise.allSettled(Array.from({length: 4}, async () => {
          const result = await tinyMemory.search({query: 'commonprobe', limit: 5});
          assert.equal(result.totalMatches, 3); assert.equal(result.coverage.complete, true);
        }));
        const facts = assertBudget(tinyMemory);
        report.cacheSamples.push({workload: 'tiny-concurrent', ...facts});
        assert(rows.every(row => row.status === 'fulfilled'), JSON.stringify(rows.map(row => row.reason?.message)));
        assert.equal(arrived, 4);
        assert(facts.projectionBytes > 0, 'Tiny corpus must retain a projection');
        assert.equal(facts.accountedBytes, facts.retainedBytes, 'Concurrent semantic/projection installation must account exactly once');
        return facts;
      } finally {
        clearTimeout(timer); release(); tiny.readObject = readObject;
        await tiny.close();
      }
    });

    await scenario('Concurrent same-query cache admission and complete results', async () => {
      const rows = await Promise.all(Array.from({length: 4}, () => operation('parallel-cold-search', async () => {
        const result = await memory.search({query: 'commonprobe', limit: 5});
        assert.equal(result.coverage.complete, true); assert.equal(result.coverage.eligible, 180);
        assert.equal(result.totalMatches, 180); assert.equal(result.matches.length, 5);
        return result;
      })));
      const facts = assertBudget(memory); report.cacheSamples.push(facts);
      assert.equal(facts.accountedBytes, facts.retainedBytes, 'Parallel admission must not double-count the same retained source');
      return {searches: rows.length, cache: facts};
    });

    await scenario('Mixed search/read/resolve with overlapping durable metadata mutations', async () => {
      const errors = [];
      for (let round = 0; round < ROUNDS; round++) {
        const selected = 1 + round * 7;
        const tasks = [];
        for (let j = 0; j < 3; j++) tasks.push(operation('search', async () => {
          const result = await memory.search({query: 'commonprobe', limit: 5, includeHistory: j === 2});
          assert.equal(result.coverage.complete, true);
          assert.equal(result.totalMatches, j === 2 ? COUNT : 180);
          assert.equal(result.matches.length, 5);
          for (const hit of result.matches) {
            const index = sources.findIndex(source => identity(source) === identity(hit.source));
            assert(index >= 0, 'Search must return an exact known identity');
            assert(bodyFor(index).includes(hit.excerpt));
            if (j !== 2) assert.equal(hit.outcome, 'accept');
          }
        }));
        for (let j = 0; j < 2; j++) tasks.push(operation('read', async () => {
          const index = (selected + j) % COUNT, source = sources[index];
          const page = await memory.read(source, {offset: j * 17, maxBytes: 1800});
          assert.deepEqual(page.source, source);
          assert.equal(page.text, bodyFor(index).slice(page.offset, page.endOffset));
          assert(page.endOffset > page.offset);
          assert(Buffer.byteLength(JSON.stringify(page)) <= 1800);
        }));
        for (let j = 0; j < 2; j++) tasks.push(operation('resolve', async () => {
          const source = sources[(selected + j) % COUNT];
          assert.deepEqual(await memory.resolve(source), source);
        }));
        // Starts after readers enter _start: this is real queue contention, not mocked I/O.
        tasks.push(operation('metadata-mutation', () => store.mutate(() => {
          store.find(sources[selected].workId).name = `Synthetic report ${selected}, metadata epoch ${round}`;
        })));
        const settled = await Promise.allSettled(tasks);
        for (const item of settled) if (item.status === 'rejected') errors.push(item.reason.message);
        report.cacheSamples.push(assertBudget(memory));
      }
      assert.equal(errors.length, 0, JSON.stringify(errors));
      assert(report.metrics.staleRetries > 0, 'Overlap must exercise stale rejection and retry');
      assert(report.metrics.requested >= 100);
      assert.equal(report.metrics.failed, 0);
      assert.equal(report.metrics.succeeded, report.metrics.requested);
      return {...report.metrics};
    });

    await scenario('Changed-corpus cursor requires explicit resync; stable pagination has no omissions', async () => {
      let page = await memory.search({query: 'commonprobe', limit: 7});
      assert(page.nextCursor);
      const oldCursor = page.nextCursor, oldVersion = page.corpusVersion;
      await store.mutate(() => { store.find(sources[1].workId).request = 'Changed corpus metadata epoch'; });
      const stale = await memory.search({query: 'commonprobe', limit: 7, cursor: oldCursor});
      assert.equal(stale.resyncRequired, true); assert.equal(stale.matches.length, 0);
      assert.notEqual(stale.corpusVersion, oldVersion);
      const seen = new Set(); let cursor = null, pages = 0;
      do {
        page = await memory.search({query: 'commonprobe', includeHistory: true, limit: 17, cursor});
        assert.equal(page.coverage.complete, true); assert.equal(page.totalMatches, COUNT);
        for (const row of page.matches) {
          assert(!seen.has(row.source.workId), 'Pagination must not duplicate sources');
          seen.add(row.source.workId);
        }
        cursor = page.nextCursor; pages++;
        assert(pages <= COUNT, 'Pagination continuation must terminate');
      } while (cursor);
      assert.equal(seen.size, COUNT);
      return {pages, uniqueSources: seen.size};
    });

    await scenario('Exact source pages, digest integrity and cross-project rejection', async () => {
      const pages = [];
      for (const index of [0, 1, 99, 199]) pages.push(await exactPages(memory, sources[index], index));
      for (const field of ['projectId', 'workId', 'objectId', 'digest']) {
        const forged = {...sources[1], [field]: field === 'projectId' ? other.id : field === 'digest' ? '0'.repeat(64) : randomUUID()};
        for (const action of ['read', 'resolve']) await assert.rejects(memory[action](forged), {code: 'RESULT_MEMORY_SOURCE'});
      }
      return {pages, exactFieldsRejected: 4, rejectedOperations: 8};
    });

    await scenario('Cold independent process preserves SQLite state and exact source provenance', async () => {
      const consumer = store.find(consumerId);
      await fs.writeFile(path.join(root, 'cold-expected-state.json'), canonicalState(store.state));
      await fs.writeFile(path.join(root, 'restart-manifest.json'), JSON.stringify({
        stateDigest: stateDigest(store.state), consumerId,
        memorySources: consumer.memorySources, memorySourceBindings: consumer.memorySourceBindings,
        samples: [0, 1, 199].map(index => ({index, source: sources[index]}))}));
      await close(storage, store); store = null; storage = null;
      const child = spawn(process.execPath, [import.meta.filename, '--cold', root], {stdio: ['ignore', 'pipe', 'pipe']});
      let output = '', timedOut = false;
      const capture = data => { output = (output + data.toString()).slice(-65536); };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const exit = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 90000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({code, signal}); });
      });
      assert(!timedOut, 'Cold process timed out');
      assert.equal(exit.code, 0, `Cold process failed: ${output}`);
      const cold = JSON.parse(await fs.readFile(path.join(root, 'cold-report.json'), 'utf8'));
      assert.equal(cold.ok, true, cold.error); assert.notEqual(cold.pid, process.pid);
      return cold;
    });
    report.ok = report.failures.length === 0;
    if (!report.ok) process.exitCode = 1;
  } catch (error) { report.failures.push({name: 'fixture-or-runner', error: error.stack}); process.exitCode = 1; }
  finally {
    clearInterval(rssTimer); lag.disable();
    try { await close(storage, store); } catch (error) { report.ok = false; report.failures.push({name: 'close', error: error.stack}); process.exitCode = 1; }
    const successful = report.operations.filter(row => row.ok).map(row => row.ms).sort((a, b) => a - b);
    const percentile = p => successful.length ? successful[Math.min(successful.length - 1, Math.ceil(successful.length * p) - 1)] : null;
    report.performance = {elapsedMs: performance.now() - start, operationP50Ms: percentile(.5), operationP95Ms: percentile(.95),
      eventLoopP95Ms: lag.percentile(95) / 1e6, eventLoopP99Ms: lag.percentile(99) / 1e6,
      eventLoopMaxMs: lag.max / 1e6, rssStartBytes: rssStart, rssEndBytes: process.memoryUsage().rss,
      peakParentRssBytes: Math.max(peakRss, process.memoryUsage().rss)};
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
