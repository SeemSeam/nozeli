// Shipped native runtime only; loopback HTTP, no credentials or external model.
// Run via the opt-in live suite: NOZELI_TEST_LIVE=1 npm run test:live (uses os.tmpdir(); no machine-local paths).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { OmpTuiSession } from '../src/agents/managed/omp-tui-session.mjs';

async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
  throw Error('Timed out: ' + label);
}

test('native defaults preserve PID, thread and draft; defer A round, admit B next, resume B, add provider live', { timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-default-models-'));
  const sourceDir = path.join(root, 'source'), home = path.join(root, 'role'), cwd = path.join(root, 'project');
  await mkdir(sourceDir); await mkdir(cwd);
  const requests = [];
  let session, release, hold = false, selected = 'local/a', manualSettled;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', data => { body += data; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const finish = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const delta of [{ role: 'assistant', content: 'local model accepted' }, {}]) res.write('data: ' + JSON.stringify({ id: 'defaults-' + requests.length, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: delta.content ? null : 'stop' }] }) + '\n\n');
        res.end('data: [DONE]\n\n');
      };
      if (hold) { hold = false; release = finish; } else finish();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { try { await session?.stop(); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); } });
  const provider = (name, ids) => `  ${name}:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    auth: none\n    models:\n${ids.map(id => `      - id: ${id}\n        input: [text]\n`).join('')}`;
  await writeFile(path.join(sourceDir, 'models.yml'), 'providers:\n' + provider('local', ['a', 'b']));
  await writeFile(path.join(sourceDir, 'config.yml'), 'setupVersion: 2\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\ndefaultThinkingLevel: off\nmodelRoles:\n  default: local/a\n');
  const source = { private: true, root, agentDir: sourceDir, modelFor: async () => selected };
  const create = () => new OmpTuiSession({ role: 'frontdesk', home, cwd, ompSystemSource: source, instructions: 'Reply briefly.', settleTimeoutMs: 45000,
    onManualInput: async () => ({ jobId: 'manual-defaults' }), onManualSettled: async result => { manualSettled = result; } });
  session = create(); await session.start();
  const pid = session.pid, thread = session.threadId;
  const terminal = session.terminalAttachment(null, 'defaults-test');
  terminal.input('unsent native draft');
  await until(async () => (await session.bridge.getState()).editorDraft.hasText, 'draft');
  assert.deepEqual(await session.applyDefaultModel('local/b'), { pending: false, model: 'local/b' });
  assert.equal(session.pid, pid); assert.equal(session.threadId, thread);
  assert.equal((await session.bridge.getState()).model, 'local/b');
  assert.equal((await session.bridge.getState()).editorDraft.hasText, true);
  assert.equal(requests.length, 0);
  terminal.input('\u0003');
  await until(async () => !(await session.bridge.getState()).editorDraft.hasText, 'clear draft');
  await session.applyDefaultModel('local/a');
  hold = true;
  const turn = session.prompt('A in flight', { timeout: 45000, job: { id: 'a-round', target: 'frontdesk', type: 'front', revision: null } });
  await until(() => release, 'first provider request');
  const pending = await session.applyDefaultModel('local/b'); selected = 'local/b';
  assert.deepEqual(pending, { pending: true, model: 'local/a' });
  assert.equal((await session.bridge.getState()).model, 'local/a');
  release();
  const answer = await turn;
  assert.equal(answer.effective.model, 'local/a');
  assert.equal(requests[0].model, 'a');
  // Native keyboard input, not only GUI dispatch, must see the deferred target.
  terminal.input('native next round\r');
  await until(() => manualSettled, 'native round settlement', 45000);
  assert.equal(manualSettled.error, null);
  assert.equal(requests.length, 2); assert.equal(requests[1].model, 'b');
  await until(async () => (await session.bridge.getState()).model === 'local/b', 'B native selection');
  await session.stop(); session = create(); await session.start(thread);
  assert.equal(session.threadId, thread); assert.equal((await session.bridge.getState()).model, 'local/b');
  assert.equal(requests.length, 2, 'resume adds no request/turn');
  const resumedPid = session.pid;
  await writeFile(path.join(sourceDir, 'models.yml'), 'providers:\n' + provider('local', ['a', 'b']) + provider('added', ['c']));
  assert.deepEqual(await session.applyDefaultModel('added/c'), { pending: false, model: 'added/c' });
  assert.equal(session.pid, resumedPid); assert.equal(session.threadId, thread);
  assert.equal(manualSettled.effective.model, 'local/b');
  assert.equal((await session.bridge.getState()).model, 'added/c');
  const added = await session.prompt('new source round', { timeout: 45000, job: { id: 'added-round', target: 'frontdesk', type: 'front', revision: null } });
  assert.equal(added.effective.model, 'added/c'); assert.equal(requests.at(-1).model, 'c');
  assert.match(await readFile(path.join(home, 'models.yml'), 'utf8'), /added:/);
  assert.equal(requests.length, 3);
});
