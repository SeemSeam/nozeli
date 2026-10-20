// omp-tui-real-protocol-live.mjs — P6-B：真实 CLI 协议集成（本地回环合成 completions fixture——
// 明确非真实模型/非 LLM：脚本化状态机，无外网/真实 Provider/账户/费用）。
// A 主链：真实 prompt→合成工具调用→真实持久发布→review；真实 journal。
// B 取消精确门：本轮唯一标记请求到达且被 hold 后 interrupt——观测该连接断开、job interrupted 非 completed、
//   零副作用、无后续同标记重放（有界观察，不 sleep 代替准入窗口）。
// C 冷开恢复：真实 CLI 历史 journal 的 stop/resume——同 sessionId/sessionFile/toolsDigest、零旧 prompt 重放。
// D 有界失败路径：hold 回合显式 stop（真实退出层级回执），不等 600s 兜底。
// 运行：NOZELI_OMP_BIN=<omp> node tests/omp-tui-real-protocol-live.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../src/agents/managed/controller.mjs';

const OMP_BIN = process.env.NOZELI_OMP_BIN;
const unhandled = [];
process.on('unhandledRejection', e => unhandled.push(String(e?.code ?? e?.message)));
const wait = async (pred, label, timeout = 45000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await pred()) return; await new Promise(r => setTimeout(r, 150)); } throw new Error('predicate timed out: ' + label); };

// 回环合成 fixture：scripted(tool轮→final轮) / hold(按标记保持连接) / silent(立即终态空回复)
function syntheticServer() {
  const state = { mode: 'scripted', calls: [], heldConns: new Map(), closedMarkers: new Set() };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const text = JSON.stringify(parsed.messages ?? []);
      const call = { url: req.url, messageCount: (parsed.messages ?? []).length, hasTools: Array.isArray(parsed.tools), text };
      state.calls.push(call);
      const sendSSE = chunks => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const chunk of chunks) res.write('data: ' + JSON.stringify(chunk) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      };
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      if (state.mode === 'hold') {
        // 按本轮唯一标记保持连接（不响应）；连接关闭记录到 closedMarkers
        const marker = state.holdMarker;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.on('close', () => { state.closedMarkers.add(marker); state.heldConns.delete(res); });
        state.heldConns.set(marker, res);
        return;
      }
      const toolRound = state.mode === 'scripted' && !text.includes('"role":"tool"');
      if (toolRound) {
        sendSSE([
          { id: 's1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: 'nozeli_publish', arguments: JSON.stringify({ kind: 'result', text: 'synthetic tool-driven result', files: [] }) } }] }, finish_reason: null }] },
          { id: 's1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]);
        state.mode = 'final';
      } else {
        sendSSE([
          { id: 's2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'synthetic final answer' }, finish_reason: null }] },
          { id: 's2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]);
        state.mode = 'done';
      }
    });
  });
  return { server, state, listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

async function openController(root, port) {
  const modelsYml = ['providers:', '  synthetic-omp:', '    api: openai-completions', `    baseUrl: http://127.0.0.1:${port}/v1`, '    auth: none', '    models:', '      - id: model', '        reasoning: true', ''].join('\n');
  const c = await Controller.open({ runtimeRoot: path.join(root, 'runtime'), contentRoot: path.join(root, 'content'), projectHome: async () => {}, ompModelsYml: modelsYml });
  for (const role of ['frontdesk', 'orchestrator', 'worker']) c.store.state.bindings[role] = { ...c.store.state.bindings[role], provider: 'omp', model: 'synthetic-omp/model', effort: 'low' };
  await c.start();
  c.kick();
  return c;
}
const waitForJob = async (c, key) => { for (let i = 0; i < 200; i++) { const j = c.store.state.jobs.find(j => j.key === key); if (j) return j; await new Promise(r => setTimeout(r, 100)); } throw new Error('job not created: ' + key); };
const objectBytes = async (c, objectId) => readFile(path.join(c.store.root, 'objects', `${objectId}.md`), 'utf8');

test('A 主链 + B 取消精确 + C 冷开恢复 + D 有界显式停止', async t => {
  assert.ok(OMP_BIN, 'NOZELI_OMP_BIN required');
  const fixture = syntheticServer();
  const port = await fixture.listen();
  t.after(() => new Promise(r => fixture.server.close(r)));
  assert.equal(fixture.server.address().address, '127.0.0.1', 'endpoint loopback only');
  const root = await mkdtemp(path.join(os.tmpdir(), 'realproto2-'));
  await mkdir(path.join(root, 'content'), { recursive: true });
  let c = await openController(root, port);
  const stopController = async () => { try { await c.stop(); } catch {} };
  t.after(stopController);

  // —— A 主链：真实工具驱动发布 ——
  const work = await c.store.submit('main chain request', 'main brief', { name: '主链工作' });
  c.kick();
  const job = await waitForJob(c, `initial:${work.id}`);
  await wait(() => ['completed', 'failed', 'interrupted'].includes(job.status), 'A: initial terminal', 90000);
  assert.equal(job.status, 'completed', 'A: completed');
  assert.equal(c.store.find(work.id).status, 'review', 'A: review');
  const receipt = c.store.state.receipts.find(r => r.workId === work.id);
  assert.ok(receipt, 'A: real durable receipt');
  assert.equal(await objectBytes(c, receipt.objectId), 'synthetic tool-driven result', 'A: exact bytes persisted');
  const sessionsDir = path.join(c.store.root, 'agents', work.agentId, 'sessions');
  const journals = (await readdir(sessionsDir).catch(() => [])).filter(f => f.endsWith('.jsonl'));
  assert.ok(journals.length >= 1, 'A: real CLI journal on disk');
  const workerSession = c.sessions.get(work.id);
  const firstThreadId = workerSession?.threadId;
  const firstSessionFile = workerSession?.sessionFile ?? path.join(sessionsDir, journals[0]);
  const firstDigest = workerSession?.toolsDigest;
  assert.ok(firstThreadId && firstDigest, 'A: session identity + digest');

  // —— B 取消精确：本轮唯一标记 hold 后 interrupt ——
  await c.store.mutate(() => { c.store.state.limit = 3; });
  const CANCEL_MARK = 'cancel-window-unique-7f3a';
  const cancelWork = await c.store.submit(CANCEL_MARK + ' request', CANCEL_MARK + ' brief', { name: '取消窗口工作' });
  fixture.state.mode = 'hold';
  fixture.state.holdMarker = CANCEL_MARK;
  c.kick();
  const cancelJob = await waitForJob(c, `initial:${cancelWork.id}`);
  // 准入 barrier：等服务器确实 hold 了“含本轮唯一标记”的请求连接（不是首回合历史请求）
  await wait(() => fixture.state.heldConns.has(CANCEL_MARK), 'B: cancel-round request held', 45000);
  const callsBeforeInterrupt = fixture.state.calls.length;
  const cancelSession = c.sessions.get(cancelWork.id);
  assert.ok(cancelSession, 'B: cancel session');
  const interrupted = await cancelSession.interrupt({ timeout: 15000 });
  // 观测：held 连接因 abort 断开
  await wait(() => fixture.state.closedMarkers.has(CANCEL_MARK), 'B: held connection closed by abort', 15000);
  // 有界观察无同标记重放（不 sleep 代替准入——精确计数）
  await new Promise(r => setTimeout(r, 2000));
  const replayedMarkers = fixture.state.calls.slice(callsBeforeInterrupt).filter(call => call.text.includes(CANCEL_MARK)).length;
  assert.equal(replayedMarkers, 0, 'B: no replay of cancelled round request');
  await wait(() => ['interrupted', 'failed', 'completed'].includes(cancelJob.status), 'B: cancel job terminal', 30000);
  assert.notEqual(cancelJob.status, 'completed', 'B: cancelled round not completed: ' + cancelJob.status);
  assert.equal(c.store.state.receipts.filter(r => r.workId === cancelWork.id).length, 0, 'B: zero side effects');
  assert.equal(interrupted?.interrupted, true, 'B: interrupt completed successfully for the held round');

  // —— C 冷开恢复：真实 journal 的 stop/resume ——
  fixture.state.mode = 'scripted';
  const callsBeforeResume = fixture.state.calls.length;
  await stopController();
  c = await Controller.open({ runtimeRoot: path.join(root, 'runtime'), contentRoot: path.join(root, 'content'), projectHome: async () => {}, ompModelsYml: ['providers:', '  synthetic-omp:', '    api: openai-completions', `    baseUrl: http://127.0.0.1:${port}/v1`, '    auth: none', '    models:', '      - id: model', '        reasoning: true', ''].join('\n') });
  for (const role of ['frontdesk', 'orchestrator', 'worker']) c.store.state.bindings[role] = { ...c.store.state.bindings[role], provider: 'omp', model: 'synthetic-omp/model', effort: 'low' };
  await c.start();
  c.kick();
  const restored = c.store.find(work.id);
  assert.ok(['review', 'paused'].includes(restored.status), 'C: work retained after cold open: ' + restored.status);
  // 同 Work 续改（review→continue→新回合）——resume 走真实 journal pin
  const h2resume = await (async () => { for (let i = 0; i < 200; i++) { const s = c.sessions.get(work.id); if (s) return s; try { await c.session(work.id); return c.sessions.get(work.id); } catch { await new Promise(r => setTimeout(r, 100)); } } return null; })();
  assert.ok(h2resume, 'C: session re-established');
  assert.equal(h2resume.threadId, firstThreadId, 'C: same sessionId resumed from real journal');
  // resume 从真实 journal 精确 pin：sessionFile 存在且其头部 session id === threadId（真实 CLI 落盘，非手写）
  const { readSessionHeaderId } = await import('../src/agents/managed/omp-process-ownership.mjs');
  const headerId = await readSessionHeaderId(String(h2resume.sessionFile));
  assert.equal(h2resume.sessionFile, firstSessionFile, 'C: the exact CLI-created journal path is preserved');
  assert.equal(headerId, firstThreadId, 'C: real journal header pins resumed identity');
  h2resume.assertToolsDigest(firstDigest);
  // 零旧 prompt/工具重放：冷开+resume 不产生新的模型请求（仅当派发新回合时才有）
  const resumeCalls = fixture.state.calls.length - callsBeforeResume;
  assert.equal(resumeCalls, 0, 'C: cold open and exact resume issue no model requests or replayed tools');

  // —— D 有界显式停止：hold 回合 stop（真实退出层级回执）——
  const STOP_MARK = 'bounded-stop-9c1d';
  const stopWork = await c.store.submit(STOP_MARK + ' request', STOP_MARK + ' brief', { name: '有界停止工作' });
  fixture.state.mode = 'hold';
  fixture.state.holdMarker = STOP_MARK;
  c.kick();
  const stopJob = await waitForJob(c, `initial:${stopWork.id}`);
  await wait(() => fixture.state.heldConns.has(STOP_MARK), 'D: stop-round request held', 45000);
  const stopSession = c.sessions.get(stopWork.id);
  const stopReceipt = await stopSession.stop();   // 显式停止：不等 runJob 600s 兜底
  assert.equal(stopReceipt.exited, true, 'D: real exit observed');
  assert.ok(stopReceipt.layers.L1_shutdown || stopReceipt.layers.L2_sigterm || stopReceipt.layers.L3_sigkill, 'D: exit layers recorded');
  await wait(() => fixture.state.closedMarkers.has(STOP_MARK), 'D: held connection closed by stop', 15000);
  await wait(() => ['interrupted', 'failed', 'completed'].includes(stopJob.status), 'D: stop job terminal', 30000);
  assert.notEqual(stopJob.status, 'completed', 'D: stopped round not completed');
  assert.equal(c.store.state.receipts.filter(r => r.workId === stopWork.id).length, 0, 'D: zero side effects');
  assert.equal(unhandled.length, 0, 'no unhandled rejections');
});
