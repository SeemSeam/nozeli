// omp-terminal-bridge.test.mjs — v2 生产行为门（真实桥 extension + 伪官方 extension 上下文驱动协议）。
// 不做源码 includes 检查、不做 mock 回显当成功：跑真实生成的桥 extension 模块（fake 官方 pi 上下文），
// 经真实 unix socket 验证消费者可见行为：认证前零事件、真实宿主工具裁决、丢 ack 副作用不重复、
// 同 id 去重、并发 connect、代次令牌失效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { deployOmpTerminalBridge, connectOmpTerminalBridge } from '../src/agents/managed/omp-terminal-bridge.mjs';

// 伪官方 ExtensionAPI 上下文（只实现官方表面：on/registerTool/getAllTools/sendUserMessage/typebox）
async function runRealBridge(home, overrides = {}) {
  const handlers = {}, tools = [];
  const pi = {
    on: (event, handler) => { (handlers[event] ??= []).push(handler); },
    registerTool: def => { tools.push(def); },
    getAllTools: () => tools.map(t => ({ name: t.name })),
    getThinkingLevel: overrides.getThinkingLevel,
    setModel: async model => { if (overrides.rejectModel) return false; ctx.model = model; return true; },
    sendUserMessage: text => { for (const h of handlers.input ?? []) h({ type: 'input', text, source: 'rpc' }, ctx); },
    typebox: { Type: { Object: shape => ({ type: 'object', properties: shape }), String: () => ({ type: 'string' }), Unsafe: schema => schema } },
  };
  const ctx = Object.assign({
    mode: 'tui', cwd: '/tmp', model: { provider: 'synthetic-omp', id: 'model' },
    isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'sess-private-4242', getSessionFile: () => '/tmp/sess.jsonl' },
    abort: overrides.abort ?? (() => {}), shutdown: overrides.shutdown ?? (() => {}),
  }, overrides.ctx);
  process.env.PI_CODING_AGENT_DIR = home;
  const deployed = await deployOmpTerminalBridge(home, { tools: [{ name: 'nozeli_probe', description: 'probe tool', parameters: { type: 'object', properties: { k: { type: 'string' } } } }] });
  (await import(pathToFileURL(deployed.bridgePath))).default(pi);
  await new Promise(r => setTimeout(r, 50));   // 等监听
  const fire = (event, e = {}) => { for (const h of handlers[event] ?? []) h(e, ctx); };
  if(!overrides.deferSessionStart)fire('session_start', { type: 'session_start' });
  const shutdownBridge = () => { fire('session_shutdown', { type: 'session_shutdown' }); };   // 释放监听句柄
  return { pi, handlers, tools, ctx, deployed, fire, shutdownBridge };
}

test('defaults use native registry, preserve drafts, defer busy work and expose failed target', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bridge-defaults-'));
  let idle = true, refreshes = 0;
  const models = ['a', 'b', 'new'].map(id => ({ provider: 'local', id }));
  const h = await runRealBridge(home, { ctx: {
    model: models[0], isIdle: () => idle, ui: { getEditorText: () => 'unsubmitted draft' },
    modelRegistry: { refresh: async strategy => { assert.equal(strategy, 'offline'); refreshes++; }, refreshProvider: async (provider,strategy) => { assert.equal(provider,'local');assert.equal(strategy,'online-if-uncached');if(!models.some(m=>m.id==='discovered'))models.push({provider:'local',id:'discovered'}); }, find: (provider, id) => models.find(m => m.provider === provider && m.id === id) },
  } });
  const client = connectOmpTerminalBridge({ ...h.deployed, onTurnAdmission: async () => ({}) });
  try {
    await client.hello();
    assert.equal((await client.applyDefaultModel('local/b')).model, 'local/b');
    assert.deepEqual((await client.getState()).editorDraft, { known: true, hasText: true });
    idle = false; h.fire('agent_start');
    const pending = await client.applyDefaultModel('local/a');
    assert.equal(pending.pending, true); assert.equal(pending.model, 'local/b');
    assert.equal((await client.getState()).pendingModel, 'local/a');
    idle = true; h.fire('agent_end');
    // No timer grace required: even an immediate next native admission awaits selection.
    await h.handlers.before_agent_start[0]({ prompt: 'next', systemPrompt: [] }, h.ctx);
    assert.equal((await client.getState()).model, 'local/a');
    assert.equal((await client.applyDefaultModel('local/discovered')).model,'local/discovered');
    await assert.rejects(client.applyDefaultModel('local/missing'), /absent from native registry/);
    assert.equal((await client.getState()).modelError.selector, 'local/missing');
    assert.equal((await client.getState()).pendingModel, 'local/missing');
    await client.applyDefaultModel('');
    assert.equal((await client.getState()).pendingModel, null);
    assert.equal((await client.getState()).model, 'local/discovered');
    assert.ok(refreshes >= 3);
  } finally { await client.close(); h.shutdownBridge(); }
});

test('native selection observer waits for initialized session context',async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'bridge-init-'));let initialized=false;
  const h=await runRealBridge(home,{deferSessionStart:true,getThinkingLevel:()=>{if(!initialized)throw Error('native runtime not initialized');return 'low';}});
  const client=connectOmpTerminalBridge({socketPath:h.deployed.socketPath,token:h.deployed.token});
  try{
    await new Promise(r=>setTimeout(r,250));initialized=true;h.fire('session_start');
    const state=await client.hello();assert.equal(state.sessionId,'sess-private-4242');assert.equal(state.thinkingLevel,'low');
  }finally{await client.close();h.shutdownBridge();}
});

test('native turn awaits host decision, refreshes approved scope and aborts denied input',async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'bridge-admission-'));let aborted=0,release;
  const h=await runRealBridge(home,{abort:()=>{aborted++;}});
  let scope='original goal',held=false;
  const client=connectOmpTerminalBridge({socketPath:h.deployed.socketPath,token:h.deployed.token,onTurnAdmission:async()=>{
    if(held)throw Error('scope decision required');
    if(release===undefined)await new Promise(r=>{release=r;});
    return {taskAnchor:scope};
  }});
  try{
    await client.hello();
    const before=h.handlers.before_agent_start[0];let finished=false;
    const pending=before({prompt:'change',systemPrompt:['base']},h.ctx).then(value=>{finished=true;return value;});
    await new Promise(r=>setTimeout(r,30));assert.equal(finished,false);
    release();assert.deepEqual((await pending).systemPrompt,['base','Current host-owned task scope:\noriginal goal']);
    scope='user-approved replacement';
    const next=await before({prompt:'followup',systemPrompt:['base']},h.ctx);
    assert.deepEqual(next.systemPrompt,['base','Current host-owned task scope:\nuser-approved replacement']);
    held=true;await assert.rejects(before({prompt:'bypass',systemPrompt:['base']},h.ctx),/scope decision required/);
    assert.equal(aborted,1);
  }finally{await client.close();h.shutdownBridge();}
});
const freeSocket = dir => path.join(dir, 'ctl-' + Math.random().toString(36).slice(2) + '.sock');

test('认证前零事件零状态：未认证连接不收广播；错令牌 AUTH 且被销毁', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bridge2-'));
  const { fire, shutdownBridge, deployed } = await runRealBridge(home);
  // 未发送任何帧的连接：广播不含它
  const silent = net.connect(deployed.socketPath);
  await new Promise(r => silent.once('connect', r));
  let silentGot = '';
  silent.on('data', d => { silentGot += d; });
  fire('agent_start', { type: 'agent_start' });   // 已认证连接不存在：广播不应到达 silent
  await new Promise(r => setTimeout(r, 100));
  assert.equal(silentGot, '', 'unauthenticated connection must receive nothing');
  // 错令牌：AUTH 错误后连接被销毁
  const wrong = connectOmpTerminalBridge({ socketPath: deployed.socketPath, token: 'wrong', requestTimeoutMs: 1500 });
  await assert.rejects(wrong.hello(), e => e.code === 'AUTH' || e.code === 'BRIDGE_CLOSED');
  silent.destroy(); await wrong.close(); shutdownBridge();
});

test('认证连接收到事件且含 sessionId；并发第二认证连接同样可用', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bridge2-'));
  const { handlers, deployed, shutdownBridge } = await runRealBridge(home);
  const events1 = [], events2 = [];
  const c1 = connectOmpTerminalBridge({ socketPath: deployed.socketPath, token: deployed.token, onEvent: e => events1.push(e) });
  const hello1 = await c1.hello();
  assert.equal(hello1.sessionId, 'sess-private-4242');
  assert.equal(hello1.model, 'synthetic-omp/model');
  const c2 = connectOmpTerminalBridge({ socketPath: deployed.socketPath, token: deployed.token, onEvent: e => events2.push(e) });
  const hello2 = await c2.hello();
  assert.equal(hello2.sessionId, 'sess-private-4242');
  // 广播同时到达两个认证连接
  for (const h of handlers.agent_start ?? []) h({});
  await new Promise(r => setTimeout(r, 100));
  assert.ok(events1.some(e => e.type === 'agent_start'));
  assert.ok(events2.some(e => e.type === 'agent_start'));
  await c1.close(); await c2.close(); shutdownBridge();
});

test('工具请求→真实宿主裁决：注册工具 execute 经 tool_call 到宿主，裁决结果回传（非回显）', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bridge2-'));
  const { tools, deployed, shutdownBridge } = await runRealBridge(home);
  const adjudications = [];
  const client = connectOmpTerminalBridge({ socketPath: deployed.socketPath, token: deployed.token });
  await client.hello();   // 认证
  client.onToolCall(async ({ tool, params }) => {
    adjudications.push({ tool, params });
    if (params.k === 'reject-me') throw Object.assign(new Error('policy denied'), { code: 'POLICY' });
    return { content: [{ type: 'text', text: 'adjudicated:' + String(params.k).toUpperCase() }] };   // 宿主计算，非回显
  });
  const probe = tools.find(t => t.name === 'nozeli_probe');
  assert.ok(probe, 'bridge registered the nozeli tool');
  assert.equal(probe.description, 'probe tool');
  assert.deepEqual(probe.parameters, { type: 'object', properties: { k: { type: 'string' } } });
  const ok = await probe.execute('call-1', { k: 'hello' }, undefined, undefined, null);
  assert.equal(ok.content[0].text, 'adjudicated:HELLO');
  const rejected = await probe.execute('call-2', { k: 'reject-me' }, undefined, undefined, null);
  assert.match(rejected.content[0].text, /host rejected: policy denied/);
  assert.equal(rejected.isError, true, 'rejection must not report success');
  assert.deepEqual(adjudications.map(a => a.tool), ['nozeli_probe', 'nozeli_probe']);
  await client.close(); shutdownBridge();
});

test('丢 ack 副作用不重复：shutdown 执行一次断线后客户端不重放', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bridge2-retry-'));
  const sockPath = freeSocket(dir);
  let executions = 0;
  const sockets = new Set();
  const server = net.createServer(s => {
    sockets.add(s); s.on('close', () => sockets.delete(s));
    s.on('data', () => { executions++; s.destroy(); });   // 执行后断线（ack 丢失）
  });
  await new Promise(r => server.listen(sockPath, r));
  const client = connectOmpTerminalBridge({ socketPath: sockPath, token: 'synthetic-token', requestTimeoutMs: 300 });
  await assert.rejects(client.shutdown(), e => ['BRIDGE_CLOSED', 'BRIDGE_TIMEOUT', 'EPIPE'].includes(e.code ?? e.message));
  await assert.rejects(client.stop(), e => ['BRIDGE_CLOSED', 'BRIDGE_TIMEOUT', 'EPIPE'].includes(e.code ?? e.message));
  await new Promise(r => setTimeout(r, 250));   // 确认无迟到重放
  assert.equal(executions, 2, 'each side-effect op executed exactly once (shutdown + stop), no replays');
  for (const s of sockets) s.destroy();
  await new Promise(r => server.close(r));
  await client.close();
});

test('同连接同 id 去重：重发缓存响应不重复执行', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bridge2-dedup-'));
  const { ctx, deployed, shutdownBridge } = await runRealBridge(home, { abort: () => { ctx.abortions = (ctx.abortions ?? 0) + 1; } });
  const client = connectOmpTerminalBridge({ socketPath: deployed.socketPath, token: deployed.token });
  await client.hello();
  await client.stop(); await client.stop();   // 两次 stop
  // 同 id 手工重放（协议级）：直写同一 id 两帧
  const raw = net.connect(deployed.socketPath);
  await new Promise(r => raw.once('connect', r));
  let buf = '';
  raw.on('data', d => { buf += d; });
  const frame = JSON.stringify({ id: 'fixed-id-1', op: 'stop', token: deployed.token }) + '\n';
  raw.write(frame); await new Promise(r => setTimeout(r, 80));
  raw.write(frame); await new Promise(r => setTimeout(r, 80));
  const replies = buf.trim().split('\n').map(l => JSON.parse(l)).filter(frame=>frame.id==='fixed-id-1');
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[0], replies[1], 'same id replays cached reply');
  assert.equal(ctx.abortions, 3, 'abort executed once per distinct request, not per replay');   // client stop ×1 + raw fixed-id ×1 = 2？见下
  raw.destroy(); await client.close(); shutdownBridge();
});

test('代次令牌真实失效：重部署后旧 token 连接被 AUTH 拒（不是仅比较 token 字符串）', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bridge2-gen-'));
  const { handlers, shutdownBridge, deployed: first } = await runRealBridge(home);
  const oldClient = connectOmpTerminalBridge({ socketPath: first.socketPath, token: first.token, requestTimeoutMs: 1500 });
  assert.equal((await oldClient.hello()).sessionId, 'sess-private-4242', 'old token valid before redeploy');
  shutdownBridge();   // 旧代次进程退出（端点关闭）
  await oldClient.close().catch(() => {});
  // 新代次部署 + 新进程
  const second = await runRealBridge(home);
  assert.notEqual(first.token, second.deployed.token, 'fresh generation token minted');
  const stale = connectOmpTerminalBridge({ socketPath: second.deployed.socketPath, token: first.token, requestTimeoutMs: 1500 });
  await assert.rejects(stale.hello(), e => e.code === 'AUTH' || e.code === 'BRIDGE_CLOSED', 'old-generation token must be refused');
  const fresh = connectOmpTerminalBridge({ socketPath: second.deployed.socketPath, token: second.deployed.token });
  assert.equal((await fresh.hello()).sessionId, 'sess-private-4242');
  await fresh.close(); await stale.close(); second.shutdownBridge();
});


test('hello/getState expose only native draft presence; legacy GUI prompt is always COLLAB_REQUIRED', { timeout: 10000 }, async () => {
  let text = 'private unsent draft', delivered = 0;
  const home = await mkdtemp(path.join(os.tmpdir(), 'bridge-native-draft-'));
  const h = await runRealBridge(home, { ctx: { ui: { getEditorText: () => text } } });
  h.pi.sendUserMessage = () => { delivered++; };
  const client = connectOmpTerminalBridge({ socketPath: h.deployed.socketPath, token: h.deployed.token });
  const raw = net.connect(h.deployed.socketPath);
  const lines = createInterface({ input: raw });
  const iterator = lines[Symbol.asyncIterator]();
  let sequence = 0;
  const request = async (op, args = {}) => {
    const id = 'legacy-' + sequence++;
    raw.write(JSON.stringify({ id, op, token: h.deployed.token, ...args }) + '\n');
    for (;;) {
      const next = await iterator.next();
      assert.equal(next.done, false, 'authenticated control socket stays open');
      const frame = JSON.parse(next.value);
      if (frame.id === id) return frame;
    }
  };
  try {
    const hello = await client.hello();
    assert.deepEqual(hello.editorDraft, { known: true, hasText: true });
    assert.equal(JSON.stringify(hello).includes(text), false);
    assert.equal((await request('hello')).ok, true);
    for (const draft of ['private unsent draft', '']) {
      text = draft;
      const state = await client.getState();
      assert.deepEqual(state.editorDraft, { known: true, hasText: Boolean(draft) });
      assert.equal(JSON.stringify(state).includes('private unsent draft'), false);
      const refused = await request('prompt', { text: 'host message' });
      assert.equal(refused.ok, false);
      assert.equal(refused.error.code, 'COLLAB_REQUIRED');
      assert.equal(delivered, 0, 'legacy transport must never deliver, even with an empty draft');
      assert.equal(text, draft, 'control transport must not clear the native editor');
    }
    h.ctx.ui.getEditorText = () => { throw Error('editor unavailable'); };
    assert.deepEqual((await client.getState()).editorDraft, { known: false });
    assert.equal((await request('get_state')).ok, true, 'refused prompt does not poison safety controls');
  } finally { lines.close(); raw.destroy(); await client.close(); h.shutdownBridge(); }
});

// Image payload delivery belongs to omp-tui-images-live.mjs (actual CLI + Collab),
// not a safety/control socket echo of the removed GUI prompt transport.

test('tool cancellation is authoritative before effects; duplicate and pre-aborted calls do not enter the host', { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bridge-cancel-'));
  const h = await runRealBridge(home);
  const client = connectOmpTerminalBridge({ socketPath: h.deployed.socketPath, token: h.deployed.token });
  let enter, release, entered = 0, effects = 0;
  const hostEntered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  client.onToolCall(async ({ id }) => {
    entered++; enter(); await gate;
    // Same public authoritative check used by the Session preEffect boundary;
    // never rely on tool_cancel notification delivery timing.
    if ((await client.toolStatus(id)).cancelled) throw Error('cancelled before effect');
    effects++;
    return { content: [{ type: 'text', text: 'effect committed' }] };
  });
  try {
    await client.hello();
    const tool = h.tools.find(tool => tool.name === 'nozeli_probe');
    const pre = new AbortController(); pre.abort();
    assert.equal((await tool.execute('pre-aborted', {}, pre.signal)).isError, true);
    assert.equal(entered, 0);
    const controller = new AbortController();
    const pending = tool.execute('cancel-before-effect', {}, controller.signal);
    await hostEntered;
    const duplicate = await tool.execute('cancel-before-effect', {}, controller.signal);
    assert.equal(duplicate.isError, true);
    controller.abort(); release();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cancelled before effect/);
    assert.equal(entered, 1);
    assert.equal(effects, 0);
    assert.deepEqual(await client.toolStatus('cancel-before-effect'), { cancelled: true });
  } finally { release(); await client.close(); h.shutdownBridge(); }
});

test('interactive admission retains input and aborts when durable manual admission is denied', { timeout: 10000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bridge-manual-'));
  let aborted = 0;
  const h = await runRealBridge(home, { abort: () => { aborted++; } });
  const admissions = [];
  const client = connectOmpTerminalBridge({ socketPath: h.deployed.socketPath, token: h.deployed.token,
    onTurnAdmission: async input => { admissions.push(input); throw Error('durable job unavailable'); } });
  try {
    await client.hello();
    h.fire('input', { source: 'interactive', text: 'private manual request' });
    await assert.rejects(h.handlers.before_agent_start[0]({ prompt: 'native turn', systemPrompt: [] }, h.ctx), /durable job unavailable/);
    assert.deepEqual(admissions, [{ interactive: true, text: 'private manual request' }]);
    assert.equal(aborted, 1, 'denied manual turn cannot reach provider admission');
    assert.equal(JSON.stringify(await client.getState()).includes('private manual request'), false);
    await assert.rejects(h.handlers.before_agent_start[0]({ prompt: 'later host turn', systemPrompt: [] }, h.ctx), /durable job unavailable/);
    assert.deepEqual(admissions[1], { interactive: false, text: 'later host turn' }, 'manual text cannot leak into a subsequent turn');
  } finally { await client.close(); h.shutdownBridge(); }
});
