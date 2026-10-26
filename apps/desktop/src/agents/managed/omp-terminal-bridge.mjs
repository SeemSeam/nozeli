// omp-terminal-bridge.mjs — OMP 单进程原生 TUI 的 Nozeli 受控 extension 桥 v3（P4，worker1 2026-10-16）。
// 安全合同（root 反例修正汇总）：
//  - 认证前零订阅零状态；副作用 op（stop/shutdown/prompt/set_effort/tool_result）丢 ack 不自动重放；
//    同连接同 id 服务端缓存去重。
//  - 工具身份稳定：桥以官方 execute 的 toolCallId 原样作为请求 id（不加随机后缀——随机后缀会摧毁
//    宿主 in-flight/completed 去重）；宿主首 await 前占位，同 id 重复请求一律拒绝，不重复执行。
//  - 取消联动：execute 收到 AbortSignal 立即向宿主发 tool_cancel；宿主撤销 admission（副作用前取消
//    必须零效果），执行后到达的取消按 UNKNOWN 处理，不冒成功。
//  - 每部署代次新 token；有界帧 1MB；close 拒绝 pending 清 timer；陈旧端点只清死文件。
// 参数完整透传：原工具 name/description/parameters（spec 完整 JSON schema，不降级为 payload:string）；
// prompt 支持文本+图片内容块；默认模型通过官方 SDK 在安全边界切换，不向编辑器注入命令。
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const BRIDGE_FILENAME = 'nozeli-terminal-bridge.mjs';
const SOCK_FILENAME = 'nozeli-terminal-bridge.sock';
// Controller permits 24 MiB of PNG bytes: base64 needs 32 MiB plus prompt/schema framing.
const MAX_FRAME_BYTES = 36 * 1024 * 1024;
const DEDUP_WINDOW = 256;
export const OMP_BRIDGE_DEFAULT_TOOL = 'nozeli_terminal_probe';

function bridgeSource({ socketPath, tokenPath, tools }) {
  return `// nozeli-terminal-bridge v3 — Nozeli 生成；OMP TUI 进程内运行（唯一 session owner）。
import * as nodeNet from 'node:net';
import * as nodeFs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
const MAX_FRAME = ${MAX_FRAME_BYTES}, DEDUP = ${DEDUP_WINDOW};
export default function nozeliTerminalBridge(pi) {
  const sockPath = ${JSON.stringify(socketPath)};   // 宿主预生成端点（win32=pipe 地址；unix=绝对短路径）
  const tokenPath = ${JSON.stringify(tokenPath)};   // token 恒在私有 home（pipe 无文件地址，不能从端点派生）
  const isWindows = process.platform === 'win32';
  const token = nodeFs.readFileSync(tokenPath, 'utf8').trim();
  let ctx = null;
  let desiredModel = null, pendingModel = null, modelError = null, modelRevision = 0, modelApply = null;
  let agentActive = false;
  const conns = new Map();
  const send = (socket, frame) => { try { socket.write(JSON.stringify(frame) + '\\n'); } catch {} };
  const authed = () => [...conns.entries()].filter(([, c]) => c.authed).map(([s]) => s);
  const broadcast = frame => { for (const s of authed()) send(s, { event: frame }); };
  const toolError = text => ({ content: [{ type: 'text', text }], isError: true });
  const remember = (c, id, frame) => { c.replies.set(id, frame); c.order.push(id); while (c.order.length > DEDUP) c.replies.delete(c.order.shift()); };
  const interactions = new Map(), responders = new Map(), wrapped = new WeakSet(), wrappedMethods = new WeakSet();
  const uiCalls = new AsyncLocalStorage();
  const failure = (code, message) => Object.assign(Error(message), { code });
  const invalidAnswer = () => { throw failure('INTERACTION_ANSWER_INVALID', 'Answer does not match the native question'); };
  const nativeAnswer = (question, answer, cancel) => {
    const { method } = question;
    if (cancel) return method === 'confirm' ? false : method === 'approve' ? 'deny' : undefined;
    if (method === 'select') return question.options.some(o => (typeof o === 'string' ? o : o.label) === answer) ? answer : invalidAnswer();
    if (method === 'confirm') return typeof answer === 'boolean' ? answer : invalidAnswer();
    if (method === 'input' || method === 'editor') return typeof answer === 'string' ? answer : invalidAnswer();
    if (method === 'approve') {
      if (answer === 'once' || answer === 'deny' || (answer === 'session' && question.prompt.session)) return answer;
      if (answer && typeof answer.always === 'boolean' && question.prompt.grants?.some(g => g.scope === answer.grant)) return { grant: answer.grant, always: answer.always };
      return invalidAnswer();
    }
    if (method === 'askDialog') {
      if (answer?.kind === 'chat') return { kind: 'chat' };
      if (answer?.kind !== 'submit' || !Array.isArray(answer.results) || answer.results.length !== question.questions.length) return invalidAnswer();
      const seen = new Set();
      const results = question.questions.map(q => {
        const item = answer.results.find(r => r?.id === q.id);
        if (!item || seen.has(item.id) || !Array.isArray(item.selectedOptions)) return invalidAnswer();
        seen.add(item.id);
        const options = q.options.map(o => o.label), selected = item.selectedOptions;
        if (new Set(selected).size !== selected.length || selected.some(s => !options.includes(s)) || (!q.multi && selected.length > 1)) return invalidAnswer();
        if (item.customInput !== undefined && typeof item.customInput !== 'string' || item.note !== undefined && typeof item.note !== 'string') return invalidAnswer();
        if (!q.multi && !selected.length && !item.customInput?.trim()) return invalidAnswer();
        if (!q.multi && selected.length && item.customInput?.trim()) return invalidAnswer();
        return { id: q.id, question: q.question, options, multi: q.multi === true, selectedOptions: selected, ...(item.customInput !== undefined ? { customInput: item.customInput } : {}), ...(item.note !== undefined ? { note: item.note } : {}) };
      });
      return { kind: 'submit', results };
    }
    return invalidAnswer();
  };
  const capture = c => {
    if (!c) return;
    ctx = c;
    // Handler contexts proxy dialog methods with read traps. Wrap their shared
    // prototype UI, so captured askDialog/approve calls also reach this bridge.
    let uiContext = c;
    while (Object.getPrototypeOf(uiContext)?.ui) uiContext = Object.getPrototypeOf(uiContext);
    const ui = uiContext.ui;
    if (!ui || wrapped.has(ui)) return;
    wrapped.add(ui);
    for (const method of ['select','confirm','input','editor','askDialog','approve','custom']) {
      if (typeof ui[method] !== 'function') continue;
      const original = ui[method];
      if (wrappedMethods.has(original)) continue;
      ui[method] = async function (...args) {
        if (uiCalls.getStore()) return original.apply(this,args);
        const id = randomUUID();
        const title = method === 'askDialog' ? (Array.isArray(args[0]) ? args[0].map(q => q.question || q.title || '').join('；') : '原生问题') : typeof args[0] === 'string' ? args[0] : method === 'approve' ? '原生权限确认' : '原生交互等待用户处理';
        const question = JSON.parse(JSON.stringify({ method, title, ...(method === 'select' ? { options: args[1] } : method === 'confirm' ? { message: args[1] } : method === 'input' ? { placeholder: args[1] } : method === 'editor' ? { prefill: args[1] } : method === 'askDialog' ? { questions: args[0] } : method === 'approve' ? { prompt: args[0] } : {}) }));
        const supported = method !== 'custom';
        const interaction = { id, method, title, question, capability: { respond: supported, cancel: supported, ...(!supported ? { reason: 'Custom native UI has no structured answer schema' } : {}) } };
        const abort = new AbortController(), optionsIndex = method === 'askDialog' || method === 'approve' || method === 'custom' ? 1 : 2;
        const options = args[optionsIndex] ?? {};
        if (supported) args[optionsIndex] = { ...options, signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal };
        let completed = false, native, release;
        const remote = new Promise(resolve => { release = resolve; });
        interactions.set(id, interaction);
        if (supported) responders.set(id, async (answer, cancel) => {
          if (completed || options.signal?.aborted) throw failure('INTERACTION_STALE', 'Native interaction already settled');
          const value = nativeAnswer(question, answer, cancel);
          completed = true;
          // The official signal hides an active dialog or removes its queued presentation.
          // Await that cleanup before returning the structured answer to the original caller.
          abort.abort();
          try { await native; } catch (error) { release({ error }); throw error; }
          release({ value });
          responders.delete(id); interactions.delete(id); observeState();
        });
        observeState();
        try {
          native = Promise.resolve(uiCalls.run(id,()=>original.apply(this,args)));
          const local = native.then(value => completed ? remote : { value }, error => completed ? remote : { error });
          const result = await Promise.race([local, remote]);
          if (result.error) throw result.error;
          return result.value;
        } finally { completed = true; responders.delete(id); interactions.delete(id); observeState(); }
      };
      wrappedMethods.add(ui[method]);
    }
  };
  const editorDraft = () => {
    if (typeof ctx?.ui?.getEditorText !== 'function') return { known: false };
    try { const text = ctx.ui.getEditorText(); return typeof text === 'string' ? { known: true, hasText: text.length > 0 } : { known: false }; }
    catch { return { known: false }; }
  };
  const state = () => ({
    sessionId: ctx?.sessionManager?.getSessionId?.() ?? null,
    sessionFile: ctx?.sessionManager?.getSessionFile?.() ?? null,
    mode: ctx?.mode ?? null, isIdle: ctx?.isIdle?.() ?? null, hasPending: ctx?.hasPendingMessages?.() ?? null,
    model: (() => { const m = ctx?.models?.current?.() ?? ctx?.model; return m ? String(m.provider) + '/' + String(m.id) : null; })(),
    modelInput: (() => { const m = ctx?.models?.current?.() ?? ctx?.model; return Array.isArray(m?.input) ? m.input : null; })(),
    thinkingLevel: (() => { const lv = typeof pi.getThinkingLevel === 'function' ? pi.getThinkingLevel() : ctx?.getThinkingLevel?.(); return typeof lv === 'object' && lv ? (lv.level ?? null) : (lv ?? null); })(),
    cwd: ctx?.cwd ?? null,
    editorDraft: editorDraft(),
    interactions: [...interactions.values()],
    desiredModel, pendingModel, modelError,
  });
  let lastSelection = '';
  const applyPendingModel = async (preparing = false) => {
    if (modelApply) return modelApply;
    if (!pendingModel || !ctx || (!preparing && (agentActive || ctx.isIdle?.() !== true))) return;
    const selector = pendingModel, revision = modelRevision;
    modelApply = (async () => {
      try {
        // v18.11 ExtensionContext.modelRegistry + ExtensionAPI.setModel: real registry/journal/UI ownership.
        await ctx.modelRegistry.refresh('offline');
        if (revision !== modelRevision) return;
        if (!preparing && (agentActive || ctx.isIdle?.() !== true)) return;
        const slash = selector.indexOf('/');
        let model = ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
        if (slash > 0 && !model) {
          await ctx.modelRegistry.refreshProvider(selector.slice(0, slash), 'online-if-uncached');
          if (revision !== modelRevision) return;
          if (!preparing && (agentActive || ctx.isIdle?.() !== true)) return;
          model = ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
        }
        if (slash < 1 || !model) throw Error('Default model is absent from native registry: ' + selector);
        if (state().model !== selector && !await pi.setModel(model)) throw Error('Native model credentials unavailable: ' + selector);
        if (state().model !== selector) throw Error('Native model verification failed: ' + selector);
        if (revision === modelRevision) { pendingModel = null; modelError = null; }
      } catch (error) {
        modelError = { code: 'OMP_DEFAULT_MODEL_FAILED', message: String(error?.message ?? error), selector };
        broadcast({ type: 'model_error', state: state() });
        throw error;
      } finally { modelApply = null; observeState(); }
    })();
    return modelApply;
  };
  const observeState = () => { if (!ctx) return; const current = state(); const key = JSON.stringify([current.model, current.modelInput, current.thinkingLevel, current.editorDraft, current.desiredModel, current.pendingModel, current.modelError,current.interactions]); if (key !== lastSelection) { lastSelection = key; broadcast({ type: 'state_change', state: current }); } };
  const selectionTimer = setInterval(() => { observeState(); if (pendingModel && !modelError) void applyPendingModel().catch(() => {}); }, 200);
  selectionTimer.unref?.();
  pi.on('model_select', (_e, c) => { capture(c); observeState(); });
  pi.on('session_start', (_e, c) => { capture(c); broadcast({ type: 'session_start', sessionId: state().sessionId }); });
  pi.on('agent_start', () => { agentActive = true; broadcast({ type: 'agent_start', state: state() }); });
  pi.on('agent_end', e => { if (e?.willContinue !== true && e?.awaitingAsyncWork !== true) agentActive = false; broadcast({ type: 'agent_end', isIdle: state().isIdle, willContinue: e?.willContinue === true, awaitingAsyncWork: e?.awaitingAsyncWork === true }); });
  pi.on('turn_start', e => broadcast({ type: 'turn_start', turnIndex: e?.turnIndex ?? null }));
  pi.on('plan_review_requested', (e,c) => {
    capture(c);
    const id = 'plan:' + e.reviewId;
    const question = { method: 'plan', title: e.title || '计划待裁决', options: e.options, planContent: e.planContent, planFilePath: e.planFilePath, ...(e.tiers ? { tiers: e.tiers } : {}) };
    const supported = typeof c?.resolvePlanReview === 'function';
    interactions.set(id, { id, method: 'plan', title: question.title, question, capability: { respond: supported, cancel: false, reason: supported ? 'Native plan API does not support dismissal' : 'Native plan resolver unavailable' } });
    if (supported) responders.set(id, (answer, cancel) => {
      if (cancel) throw failure('INTERACTION_CAPABILITY_UNAVAILABLE', 'Native plan review cannot be cancelled through the extension API');
      const choice = typeof answer === 'string' ? answer : answer?.choice;
      const input = typeof answer === 'object' && answer ? { ...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}), ...(answer.role !== undefined ? { role: answer.role } : {}) } : undefined;
      if (!e.options?.some(o => o.id === choice && !o.disabled) || (input?.feedback !== undefined && typeof input.feedback !== 'string') || (choice === 'refine' && !input?.feedback?.trim()) || (input?.role !== undefined && (!['execute','compact','keep'].includes(choice) || !e.tiers?.some(t => t.role === input.role)))) return invalidAnswer();
      if (!c.resolvePlanReview(e.reviewId, choice, input)) throw failure('INTERACTION_STALE', 'Native plan review no longer accepts this choice');
      responders.delete(id);
    });
    observeState();
  });
  pi.on('plan_review_resolved', e => { const id = 'plan:' + e.reviewId; interactions.delete(id); responders.delete(id); observeState(); });
  pi.on('tool_approval_requested', (e,c) => { capture(c); const id = 'approval:' + e.toolCallId; interactions.set(id,{id,method:'approval',title:'工具权限待确认：'+e.toolName,question:{method:'approval',title:'工具权限待确认：'+e.toolName,reason:e.reason},capability:{respond:false,cancel:false,reason:'Native approval event has no resolver; awaiting structured approve UI'}});observeState(); });
  pi.on('tool_approval_resolved', e => { interactions.delete('approval:'+e.toolCallId);observeState(); });
  pi.on('turn_end', e => broadcast({ type: 'turn_end', turnIndex: e?.turnIndex ?? null, message: { stopReason: e?.message?.stopReason, errorMessage: e?.message?.errorMessage } }));
  let pendingInteractiveInput = null;
  pi.on('input', e => { pendingInteractiveInput = e?.source === 'interactive' ? { source: 'interactive', text: e?.text ?? '' } : null; });
  pi.on('before_agent_start', async (e, c) => {
    capture(c);
    const input = pendingInteractiveInput;
    pendingInteractiveInput = null;
    try {
      // Covers native input and managed Collab alike, before the next provider round is admitted.
      if (!agentActive) {
        do { await applyPendingModel(true); } while (pendingModel && !modelError);
        if (pendingModel) throw Error(modelError?.message || 'Default model not applied');
      }
      const socket = authed().at(-1);
      if (!socket) throw Error('nozeli host admission unavailable');
      const conn = conns.get(socket), id = 'turn-' + randomUUID();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { conn.toolWaiters.delete(id); reject(Error('nozeli turn admission timed out')); }, 15000);
        conn.toolWaiters.set(id, value => { clearTimeout(timer); value?.isError ? reject(Error(value.content?.[0]?.text || 'turn denied')) : resolve(value); });
        send(socket, { id, op: 'turn_admit', interactive: Boolean(input), text: input?.text ?? e.prompt });
      });
      if (!agentActive) {
        do { await applyPendingModel(true); } while (pendingModel && !modelError);
        if (pendingModel) throw Error(modelError?.message || 'Default model not applied');
      }
      broadcast({ type: 'turn_model', model: state().model, effort: state().thinkingLevel });
      if (input && result?.jobId) pi.appendEntry('nozeli-manual-pending', { jobId: result.jobId, requestId: result.requestId, epoch: process.env.NOZELI_COLLAB_EPOCH });
      if (result?.taskAnchor) return { systemPrompt: [...e.systemPrompt, 'Current host-owned task scope:\\n' + result.taskAnchor] };
    } catch (error) {
      // abort invalidates native preparation before provider admission; throwing alone is swallowed by extension dispatch.
      void c.abort();
      throw error;
    }
  });
  pi.on('session_shutdown', () => { clearInterval(selectionTimer); try { server.close(); } catch {} });
  const toolDefs = ${JSON.stringify(tools)}.map(def => ({
    name: def.name,
    label: def.label ?? def.name,
    description: def.description,            // 原 Nozeli 工具描述，不替换为通用文案
    parameters: pi.typebox.Type.Unsafe(def.parameters ?? { type: 'object', properties: {} }),   // 原完整 JSON schema
    approval: def.approval ?? 'read',
    loadMode: 'essential',   // 默认 discoverable 不进活跃工具集（真实协议实测）——宿主工具必须顶层可用
    execute: async (toolCallId, params, signal, _onUpdate, c) => {
      capture(c);
      const socket = authed().at(-1);   // 最近认证的宿主连接（重试竞态下旧连接不截获工具）
      if (!socket) return toolError('nozeli host bridge not connected; tool unavailable this turn');
      const conn = conns.get(socket);
      // 取消先于副作用：signal 已 abort 直接不向宿主发起（零效果）
      if (signal?.aborted) return toolError('cancelled before host adjudication');
      // 桥级在途去重：同 toolCallId 二次 execute 不覆盖首 waiter、不重发（宿主侧另有首 await 前占位门）
      if (conn.toolWaiters.has(toolCallId)) return toolError('duplicate tool call in flight');
      const outcome = await new Promise(resolve => {
        conn.toolWaiters.set(toolCallId, resolve);
        send(socket, { id: toolCallId, op: 'tool_call', tool: def.name, params: params ?? {} });
        // 权威取消记录：桥进程直接持有 AbortSignal（权威方）；宿主副作用前经 tool_status 核实
        if (signal) signal.addEventListener('abort', () => { conn.cancelled.add(toolCallId); send(socket, { id: toolCallId, op: 'tool_cancel', tool: def.name }); }, { once: true });
        setTimeout(() => { if (conn.toolWaiters.delete(toolCallId)) resolve(toolError('nozeli host adjudication timed out; tool aborted')); }, 120000).unref?.();
      });
      return outcome;
    },
  }));
  for (const def of toolDefs) pi.registerTool(def);
  // Evidence is taken after successful registration, including Type.Unsafe's
  // resulting schema, not merely the host's requested tool list.
  // Current OMP's legacy Type.Unsafe returns a callable omptype schema;
  // JSON.stringify would silently omit it. Emit its official wire document.
  const registrationReceipt = () => {
    // OMP may normalize a schema's shared wire document during startup.
    // Capture fresh plain JSON and hash exactly the snapshot sent to the host.
    const registeredTools = JSON.parse(JSON.stringify(toolDefs.map(({ name, description, parameters, approval }) => ({ name, description, parameters: typeof parameters?.toJsonSchema === 'function' ? parameters.toJsonSchema() : parameters, approval }))));
    const toolsDigest = createHash('sha256').update(JSON.stringify(registeredTools.map(({ name, description, parameters }) => ({ name, description, parameters })))).digest('hex');
    return { registeredTools, toolsDigest };
  };
  const server = nodeNet.createServer(socket => {
    const c = { authed: false, replies: new Map(), order: [], toolWaiters: new Map(), cancelled: new Set() };
    conns.set(socket, c);
    let buf = '';
    socket.on('data', d => {
      buf += d;
      if (buf.length > MAX_FRAME) { socket.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req; try { req = JSON.parse(line); } catch { send(socket, { id: null, ok: false, error: { code: 'BAD_JSON' } }); continue; }
        if (!c.authed) {
          if (req?.token !== token) { send(socket, { id: req?.id ?? null, ok: false, error: { code: 'AUTH', message: 'invalid bridge token' } }); socket.destroy(); return; }
          c.authed = true;
        }
        if (req.id != null && c.replies.has(req.id)) { send(socket, c.replies.get(req.id)); continue; }
        handle(socket, c, req);
      }
    });
    const disconnect = () => { conns.delete(socket); for (const resolve of c.toolWaiters.values()) resolve(toolError('nozeli host disconnected')); c.toolWaiters.clear(); };
    socket.on('close', disconnect);
    socket.on('error', disconnect);
  });
  async function handle(socket, c, req) {
    const reply = (ok, value) => { const frame = { id: req.id ?? null, ok, ...(ok ? { value } : { error: value }) }; if (req.id != null) remember(c, req.id, frame); send(socket, frame); };
    try {
      if (req.op === 'hello') reply(true, { ...state(), tools: pi.getAllTools().map(t => t.name).filter(n => n.startsWith('nozeli')), ...registrationReceipt() });
      else if (req.op === 'get_state') reply(true, state());
      else if (req.op === 'read_native_draft' || req.op === 'replace_native_draft') {
        if (typeof ctx?.ui?.getEditorText !== 'function') throw failure('NATIVE_DRAFT_CAPABILITY_UNAVAILABLE', 'Native editor text cannot be read');
        const current = ctx.ui.getEditorText();
        if (typeof current !== 'string') throw failure('NATIVE_DRAFT_CAPABILITY_UNAVAILABLE', 'Native editor text is unavailable');
        if (req.op === 'replace_native_draft') {
          if (typeof req.expectedText !== 'string' || typeof req.text !== 'string') throw failure('NATIVE_DRAFT_INVALID', 'Native draft text must be a string');
          if (typeof ctx.ui.setEditorText !== 'function') throw failure('NATIVE_DRAFT_CAPABILITY_UNAVAILABLE', 'Native editor text cannot be replaced');
          if (current !== req.expectedText) throw failure('NATIVE_DRAFT_CHANGED', 'Native draft changed; read it again before replacing');
          ctx.ui.setEditorText(req.text);
          observeState();
        }
        reply(true, { text: req.op === 'replace_native_draft' ? req.text : current, replaced: req.op === 'replace_native_draft', capabilities: { text: true, images: false, limitation: 'Native editor image attachments are not exposed; text replacement preserves them and never submits' }, ...state() });
      }
      else if (req.op === 'respond_interaction') {
        const interaction = interactions.get(req.interactionId);
        if (!interaction) throw failure('INTERACTION_STALE', 'Native interaction is no longer pending');
        const respond = responders.get(req.interactionId);
        if (!respond) throw failure('INTERACTION_CAPABILITY_UNAVAILABLE', interaction.capability?.reason || 'Native interaction cannot be answered structurally');
        await respond(req.answer, req.cancel === true);
        reply(true, { accepted: true, interactionId: req.interactionId, ...state() });
      }
      else if (req.op === 'apply_default_model') {
        if (typeof req.selector !== 'string') throw Error('Default model selector must be a string');
        desiredModel = req.selector || null; pendingModel = desiredModel; modelError = null; modelRevision++;
        observeState();
        do { await applyPendingModel(); } while (pendingModel && !modelError && ctx?.isIdle?.() === true && !agentActive);
        reply(true, { ...state(), pending: Boolean(pendingModel) });
      }
      else if (req.op === 'stop') { ctx?.abort?.(); reply(true, { aborted: true }); }
      else if (req.op === 'shutdown') { reply(true, { shuttingDown: true }); setTimeout(() => ctx?.shutdown?.(), 50); }
      else if (req.op === 'prompt') reply(false, { code: 'COLLAB_REQUIRED', message: 'GUI prompt requires managed collab admission' });
      else if (req.op === 'tool_status') {
        // 副作用准入栅栏：宿主 preEffect 执行前向权威方（持有 AbortSignal 的本进程）核实取消状态
        reply(true, { cancelled: c.cancelled.has(String(req.forId)) });
      }
      else if (req.op === 'tool_result') {
        const waiter = c.toolWaiters.get(req.forId);
        if (!waiter) return reply(false, { code: 'UNKNOWN_TOOL_CALL', message: 'no pending tool call ' + String(req.forId) });
        c.toolWaiters.delete(req.forId);
        waiter(req.ok === false ? toolError('nozeli host rejected: ' + String(req.error?.message ?? '')) : (req.result ?? { content: [{ type: 'text', text: '' }] }));
        reply(true, { accepted: true });
      }
      else reply(false, { code: 'UNKNOWN_OP', message: String(req.op) });
    } catch (e) { reply(false, { code: e.code ?? 'OP_FAILED', message: String(e?.message ?? e) }); }
  }
  const listen = () => server.listen(sockPath);
  if (isWindows) return listen();   // named pipe：无文件地址（stat/unlink 不适用；占用时 listen 自然报错）
  nodeFs.stat(sockPath, err => {
    if (err) return listen();
    const probe = nodeNet.connect(sockPath);
    probe.on('error', () => { try { nodeFs.unlinkSync(sockPath); } catch {} listen(); });
    probe.on('connect', () => { probe.destroy(); console.error('nozeli bridge: endpoint in use; refusing to steal'); process.exit(17); });
  });
}
`;
}

export async function readOmpTerminalToolHistory(home) {
  const history = [];
  try {
    const saved = JSON.parse(await fs.readFile(path.join(home, 'nozeli-terminal-tools-history.json'), 'utf8'));
    if (!Array.isArray(saved) || saved.some(tools => !Array.isArray(tools))) throw new Error('invalid omp tool history');
    history.push(...saved);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Recognize only our generated JSON literal; never evaluate old source.
  try {
    const previous = await fs.readFile(path.join(home, BRIDGE_FILENAME), 'utf8');
    const literal = previous.match(/^  const toolDefs = (\[.*\])\.map\(def => \(\{$/m)?.[1];
    if (literal) history.push(JSON.parse(literal));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return history;
}

export async function deployOmpTerminalBridge(home, { tools = [] } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('omp bridge home must be absolute');
  const bridgePath = path.join(home, BRIDGE_FILENAME);
  // 端点按平台（P6-A）：
  //  - Windows：named pipe（\\.\pipe\...）——地址不是文件（无字节预算/stat/token 路径随 home）；listen 冲突自然报错。
  //  - Unix：96B 预算候选回退（os.tmpdir→/tmp→/var/tmp）+ 目录强校验（lstat 真目录、非 symlink、属主=当前 uid、mode 0700）；
  //    校验失败换下一候选（防预置符号链接/权限放宽目录），全不可用抛精确错误。
  const hash = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);
  let socketPath, tokenPath;
  if (process.platform === 'win32') {
    socketPath = `\\\\.\\pipe\\nozeli-omp-bridge-${hash}`;
    tokenPath = path.join(home, SOCK_FILENAME + '.token');   // 令牌恒在私有 home（pipe 无文件地址）
  } else {
    let endpointDir = null, lastEndpointError = null;
    for (const base of [...new Set([os.tmpdir(), '/tmp', '/var/tmp'])].filter(Boolean)) {
      const dir = path.join(base, 'nozeli-bridge-' + hash);
      if (Buffer.byteLength(path.join(dir, SOCK_FILENAME)) > 96) { lastEndpointError = `over 96B budget: ${dir}`; continue; }
      try {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(dir);   // lstat：不跟随符号链接
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('endpoint base is not a real directory (symlink refused)');
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`endpoint base owner mismatch (uid ${stat.uid} != ${process.getuid()})`);
        if ((stat.mode & 0o777) !== 0o700) throw new Error(`endpoint base mode ${ (stat.mode & 0o777).toString(8) } != 700`);
        endpointDir = dir; break;
      } catch (error) { lastEndpointError = String(error.message ?? error); }
    }
    if (!endpointDir) throw new Error(`no usable bridge endpoint base: ${lastEndpointError ?? 'unknown'}`);
    socketPath = path.join(endpointDir, SOCK_FILENAME);
    tokenPath = socketPath + '.token';
  }
  const token = randomUUID() + randomUUID();
  const normalized = (tools.length ? tools : [{ name: OMP_BRIDGE_DEFAULT_TOOL, description: 'Nozeli host bridge presence probe.', parameters: { type: 'object', properties: {} } }])
    .map(({ name, description, parameters, inputSchema, approval }) => ({ name, description, parameters: parameters ?? inputSchema ?? { type: 'object', properties: {} }, ...(approval ? { approval } : {}) }));
  // Preserve proven definitions before replacing the extension.
  const historyPath = path.join(home, 'nozeli-terminal-tools-history.json');
  const history = await readOmpTerminalToolHistory(home);
  history.push(normalized);
  const uniqueHistory = [...new Map(history.map(tools => [JSON.stringify(tools), tools])).values()];
  const pendingHistoryPath = historyPath + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(pendingHistoryPath, JSON.stringify(uniqueHistory), { mode: 0o600, flag: 'wx' });
    await fs.rename(pendingHistoryPath, historyPath);
  } finally { await fs.rm(pendingHistoryPath, { force: true }); }
  const source = bridgeSource({ socketPath, tokenPath, tools: normalized });
  await fs.writeFile(bridgePath, source, { mode: 0o600 });
  await fs.writeFile(tokenPath, token + '\n', { mode: 0o600 });
  return { bridgePath, socketPath, tokenPath, token, configEntry: bridgePath, tools: normalized, toolHistory: uniqueHistory };
}

export function connectOmpTerminalBridge({ socketPath, token, onEvent = () => {}, onTurnAdmission = null, requestTimeoutMs = 8000 }) {
  if (typeof socketPath !== 'string' || typeof token !== 'string') throw new Error('bridge connection requires socketPath and token');
  const RETRYABLE_OPS = new Set(['hello', 'get_state']);
  const pending = new Map();
  const cancelledCalls = new Set();
  let socket = null, closed = false, buf = '';
  let toolAdjudicator = null;
  const dead = s => !s || s.destroyed || s.readyState !== 'open';
  const connect = () => new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    const timer = setTimeout(() => { s.destroy(); reject(new Error('bridge connect timeout')); }, requestTimeoutMs);
    s.on('connect', () => { clearTimeout(timer); resolve(s); });
    s.on('error', e => { clearTimeout(timer); reject(e); });
  });
  const ensure = async () => {
    if (closed) throw Object.assign(new Error('bridge client closed'), { code: 'CLIENT_CLOSED' });
    if (dead(socket)) socket = null;
    if (!socket) {
      socket = await connect();
      const live = socket;
      socket.on('data', d => {
        buf += d;
        if (buf.length > MAX_FRAME_BYTES) { live.destroy(); return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let frame; try { frame = JSON.parse(line); } catch { continue; }
          if (frame?.event) { onEvent(frame.event); continue; }
          if (frame?.op === 'tool_call') { void adjudicate(frame); continue; }
          if (frame?.op === 'turn_admit') { void admitTurn(frame); continue; }
          if (frame?.op === 'tool_cancel') { cancelledCalls.add(frame.id); continue; }
          const waiter = pending.get(frame?.id);
          if (waiter) { pending.delete(frame.id); frame.ok ? waiter.resolve(frame.value) : waiter.reject(Object.assign(new Error(frame.error?.message ?? 'bridge error'), { code: frame.error?.code })); }
        }
      });
      socket.on('close', () => { if (socket !== live) return; socket = null; for (const [, w] of pending) w.reject(Object.assign(new Error('bridge socket closed'), { code: 'BRIDGE_CLOSED' })); pending.clear(); });
      socket.on('error', () => {});
    }
    return socket;
  };
  const sendToolResult = (forId, payload) => { try { socket?.write(JSON.stringify({ op: 'tool_result', forId, ...payload }) + '\n'); } catch {} };
  const admitTurn = async frame => {
    try {
      if (!onTurnAdmission) throw new Error('host turn admission not attached');
      const result = await onTurnAdmission({ interactive: frame.interactive === true, text: frame.text ?? '' });
      sendToolResult(frame.id, { ok: true, result: result ?? {} });
    } catch (error) { sendToolResult(frame.id, { ok: false, error: { message: String(error.message) } }); }
  };
  const adjudicate = async frame => {
    if (!toolAdjudicator) return sendToolResult(frame.id, { ok: false, error: { code: 'NO_ADJUDICATOR', message: 'host adjudicator not attached' } });
    try { const result = await toolAdjudicator({ id: frame.id, tool: frame.tool, params: frame.params, isCancelled: () => cancelledCalls.has(frame.id) }); sendToolResult(frame.id, { ok: true, result }); }
    catch (e) { sendToolResult(frame.id, { ok: false, error: { code: e.code ?? 'ADJUDICATION_FAILED', message: String(e.message) } }); }
    cancelledCalls.delete(frame.id);
  };
  const attempt = (op, args = {}) => ensure().then(() => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('bridge request timeout: ' + op), { code: 'BRIDGE_TIMEOUT' })); }, requestTimeoutMs);
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    try { socket.write(JSON.stringify({ id, op, token, ...args }) + '\n'); }
    catch (error) { pending.delete(id); clearTimeout(timer); socket = null; reject(Object.assign(new Error('bridge write failed'), { code: 'BRIDGE_WRITE_FAILED' })); }
  }));
  const call = (op, args) => attempt(op, args).catch(error => {
    if (!RETRYABLE_OPS.has(op)) throw error;
    if (!['BRIDGE_CLOSED', 'BRIDGE_WRITE_FAILED', 'EPIPE'].includes(error.code ?? error.message)) throw error;
    socket = null;
    return attempt(op, args);
  });
  return {
    hello: () => call('hello'),
    getState: () => call('get_state'),
    applyDefaultModel: selector => call('apply_default_model', { selector }),
    respondInteraction: (interactionId, answer, { cancel = false } = {}) => call('respond_interaction', { interactionId, answer, cancel }),
    readNativeDraft: () => call('read_native_draft'),
    replaceNativeDraft: (expectedText, text) => call('replace_native_draft', { expectedText, text }),
    stop: () => call('stop'),
    shutdown: () => call('shutdown'),
    toolStatus: forId => call('tool_status', { forId }),
    onToolCall(adjudicator) { toolAdjudicator = adjudicator; },
    close: async () => { closed = true; try { socket?.end(); } catch {} socket = null; for (const [, w] of pending) w.reject(Object.assign(new Error('client closed'), { code: 'CLIENT_CLOSED' })); pending.clear(); },
  };
}
