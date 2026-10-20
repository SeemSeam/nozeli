// omp-tui-session.mjs — OMP 生产 TUI 会话 v2（P4，worker1 2026-10-16）。
// TUI-native：原生 TUI 进程唯一 session owner；宿主经认证桥串行控制。
// v2 修正（root 反例）：ack 失败=准入未知→阻塞（须 agent_end+isIdle+无 pending 三事实才恢复，与 RPC 阻塞规则一致）；
// waiter/timer 统一回收（exit 映射预建带 catch，无 unhandled rejection）；工具身份稳定（桥以官方 toolCallId 原样）；
// 取消联动（副作用前取消零效果、执行后取消丢弃不冒成功）；终态=agent_end+isIdle+!hasPending（turn_end 不足以结算）。
// 模型与思考档位由原生 OMP 配置/会话日志独占；宿主只观察实际生效值，不覆盖恢复记录。
// isolation→isolatedLaunch 包裹 PTY argv；工具以原 name/description/schema 注册。
// 输入所有权：终端输入经 input observer（nativeDraftTargets/kick）+ 人工回合门（interactive input 开 manual ticket，
// host tools 按 ticket 裁决；agent_end+idle 终结）；不双 owner。
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareOmpPrivateHome } from './omp-provider-home.mjs';
import { scrubProviderEnv } from './omp-credentials.mjs';
import { pinSessionFileById, ompGroupRecord, reapOwnedOmpGroup } from './omp-process-ownership.mjs';
import { deployOmpTerminalBridge, connectOmpTerminalBridge, readOmpTerminalToolHistory } from './omp-terminal-bridge.mjs';
import { createTerminalScreen } from './terminal-screen.mjs';
import { createTerminalInputObserver } from '../../domain/terminal-input.mjs';
import { isolatedLaunch } from './process-isolation.mjs';
import { resolveBundledOmpRuntime } from './omp-runtime.mjs';
import { createRequire } from 'node:module';
import { imageSize } from 'image-size';
import { NativeCollabRuntime } from './collab/runtime.mjs';
const require = createRequire(new URL('../../../package.json', import.meta.url));

const nowIso = () => new Date().toISOString();
const ompError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const textResult = text => ({ content: [{ type: 'text', text: String(text) }] });
const messageText = message => {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('');
  return '';
};

const normalizeTools = tools => tools.map(({ name, description, parameters, inputSchema }) => ({ name, description, parameters: parameters ?? inputSchema ?? { type: 'object', properties: {} } }));
const digestTools = tools => createHash('sha256').update(JSON.stringify(normalizeTools(tools))).digest('hex');
const stableValue = value => Array.isArray(value) ? value.map(stableValue) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])])) : value;

// Managed callers supply immutable PNG material as data URLs, not SDK objects.
// Construct only the native ImageContent fields; never spread opaque input.
function nativePromptImages(images) {
  if (!Array.isArray(images)) throw ompError('OMP_IMAGE_INVALID', 'images must be an array of PNG data URLs');
  if (images.length > 8) throw ompError('OMP_IMAGE_INVALID', 'at most eight images are supported');
  let totalBytes = 0;
  return Array.from(images, (image, index) => {
    const invalid = () => ompError('OMP_IMAGE_INVALID', `image ${index + 1} must be a base64 PNG data URL`);
    const match = typeof image === 'string' && /^data:image\/png;base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(image);
    if (!match || !match[1]) throw invalid();
    const data = match[1], bytes = Buffer.from(data, 'base64');
    if ((totalBytes += bytes.length) > 24 * 1024 * 1024) throw ompError('OMP_IMAGE_INVALID', 'image bytes exceed 24 MiB');
    if (bytes.toString('base64') !== data || bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw invalid();
    let info;
    try { info = imageSize(bytes); } catch { throw invalid(); }
    if (info.type !== 'png' || !info.width || !info.height) throw invalid();
    return { type: 'image', data, mimeType: 'image/png' };
  });
}

// Only schema-position descriptions are annotations: a property literally named
// description, or description inside const/enum data, remains part of the contract.
function comparableSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const result = {};
  const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
  const singles = new Set(['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'additionalItems', 'unevaluatedItems']);
  const lists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description') continue;
    if (maps.has(key) && value && typeof value === 'object' && !Array.isArray(value)) result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, comparableSchema(child)]));
    else if (singles.has(key)) result[key] = comparableSchema(value);
    else if (lists.has(key) && Array.isArray(value)) result[key] = value.map(comparableSchema);
    else if (key === 'items') result[key] = Array.isArray(value) ? value.map(comparableSchema) : comparableSchema(value);
    else result[key] = value;
  }
  // Recognize only the provable nullable union, not arbitrary combinator rewrites.
  if (Object.keys(result).length === 1 && Array.isArray(result.anyOf) && result.anyOf.length === 2) {
    const nullIndex = result.anyOf.findIndex(branch => branch && Object.keys(branch).length === 1 && branch.type === 'null');
    const other = result.anyOf[1 - nullIndex];
    if (nullIndex >= 0 && other && typeof other.type === 'string' && other.type !== 'null' && Object.keys(other).every(key => ['type', 'pattern', 'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties', 'items', 'minItems', 'maxItems', 'uniqueItems'].includes(key))) return comparableSchema({ ...other, type: [other.type, 'null'] });
  }
  if (Array.isArray(result.type)) result.type = [...result.type].sort();
  return stableValue(result);
}
const comparableTools = tools => JSON.stringify(stableValue(tools.map(tool => ({ name: tool.name, approval: tool.approval ?? 'read', parameters: comparableSchema(tool.parameters ?? tool.inputSchema ?? { type: 'object', properties: {} }) }))));

export class OmpTuiSession extends EventEmitter {
  constructor(spec) {
    super();
    Object.assign(this, {
      role: spec.role, model: null, effort: null, legacyNativeSeed: spec.legacyNativeSeed ?? null, cwd: spec.cwd, home: spec.home,
      instructions: [spec.baseInstructions,spec.instructions].filter(Boolean).join('\n'), tools: spec.tools ?? [], onTool: spec.onTool ?? null,
      onSpawn: spec.onSpawn ?? null, finishOnHostControl: spec.finishOnHostControl === true,
      isolation: spec.isolation ?? null, command: spec.command ?? null,
      ompSystemSource: spec.ompSystemSource ?? null,
      ompAuthBroker: spec.ompAuthBroker ?? null,   // {acquire()->{url,token}} 官方 broker 认证继承；null=不注入
      settleTimeoutMs: spec.settleTimeoutMs ?? 600000, ackTimeoutMs: spec.ackTimeoutMs ?? 30000,
      tuiSpawn: spec.tuiSpawn ?? null, screenFactory: spec.screenFactory ?? null,
      onManualInput: spec.onManualInput ?? null, onManualSettled: spec.onManualSettled ?? null,
      onBeforeAgentStart: spec.onBeforeAgentStart ?? null,
      cols: spec.cols ?? 120, rows: spec.rows ?? 32,
      collabContext: spec.collabContext ?? { projectId: 'isolated', targetId: spec.role, ownerId: randomUUID() },
      onCollabEntry: spec.onCollabEntry, onCollabEvent: spec.onCollabEvent, onTransportFact: spec.onTransportFact,
    });
    this.viewOwnerId = this.collabContext.ownerId;
    if (typeof this.home !== 'string' || !path.isAbsolute(this.home)) throw ompError('OMP_HOME_REQUIRED', 'omp tui session requires an absolute private home');
    this.sessionsDir = path.join(this.home, 'sessions');
    this.phase = 'constructed';
    this.threadId = null; this.sessionFile = null;
    this.busy = false; this.closed = false; this.externalTurnId = null;
    this.currentTicket = null; this.blockedTicket = null; this.resolvedTickets = new Set();
    this.inFlightToolCalls = new Set(); this.completedToolCalls = new Map(); this.controlReceipts = [];
    this.agentEnds = []; this.sideEffectFacts = []; this.unsettledPromptError = null; this.failure = null;
    this.ownerGeneration = 1; this.promptsDelivered = 0; this.hasPrompted = false;
    this.stopRequested = false; this.protocolEnded = false; this.controlAbortRequested = null;
    this.turnEnds = []; this.turnErrors = []; this.attachment = null; this.manualTicket = null; this.manualJobId = null;
    this.toolsDigest = digestTools(this.tools);
    this.capabilities = {
      usage: 'unavailable: tui bridge has no per-turn token accounting surface',
      turnId: 'unavailable: omp has no turn id; promptId is the host-side round identity',
      files: 'unavailable: file provenance is established host-side via nozeli_publish verification',
      nativeSkillScope: 'host-granted: native skill discovery/catalog disabled; ambient extensions unchanged',
      outputSchema: 'native journal: structured message/tool entries via managed Collab; no forced model output schema',
      v2Framing: 'managed Collab AES-GCM chunks; private extension bridge is safety/control only',
      terminal: 'native: tui is the sole session owner; terminal attach is a view of the session-owned PTY',
    };
    // waiter 统一管理：全部预建并挂 no-op catch（防未消费分支 unhandled rejection）
    this.#rejects = [];
    this.#settleWaiter = new Promise((resolve, reject) => { this.#resolveSettle = resolve; this.#rejectSettle = reject; });
    this.#settleWaiter.catch(() => {});
    this.#idleWaiter = new Promise(resolve => { this.#resolveIdle = resolve; });
  }

  #changed() { this.emit('change'); }
  diag(kind, details = {}) { this.diagnosticsLog ??= []; this.diagnosticsLog.push({ at: nowIso(), kind, ...details }); this.emit('diagnostic', `omp-tui: ${kind}${details.code ? ` (${details.code})` : ''}`); }

  async start(resumeId) {
    if (this.phase !== 'constructed') throw ompError('OMP_START_STATE', `start from phase ${this.phase}`);
    if (resumeId != null && typeof resumeId !== 'string') throw ompError('OMP_RESUME_INVALID', 'resumeId must be the pinned omp session id');
    this.phase = 'connecting';
    try {
      if (!this.command) this.command = (await resolveBundledOmpRuntime()).command;
      this.configurationStatus = await prepareOmpPrivateHome(this.home, { system: this.ompSystemSource, ...(resumeId == null ? { legacyNativeSeed: this.legacyNativeSeed } : {}) });
      let resumeFile = null;
      if (resumeId != null) {
        resumeFile = await pinSessionFileById(this.sessionsDir, resumeId);
        if (!resumeFile) throw ompError('OMP_SESSION_FILE_NOT_FOUND', `no omp session file pins id ${resumeId}; refusing to start a replacement conversation`);
      }
      const deployed = await deployOmpTerminalBridge(this.home, { tools: this.tools });
      this.deployed = deployed;
      await this.#mergeExtensionConfig(deployed.configEntry);
      // instructions 完整透传（官方 --system-prompt）
      const argv = ['--cwd', this.cwd, '--system-prompt', String(this.instructions ?? ''), '--approval-mode', 'yolo', '--no-title', '--no-skills', '--session-dir', this.sessionsDir];
      // Residents cannot bypass host routing with native task/shell tools.
      // Workers retain file tools inside their isolated execution copy; host
      // publication still adjudicates new files and existing-text conflicts.
      const nativeTools = this.role === 'worker' ? ['read', 'write', 'edit', 'bash'] : [];
      const activeTools = [...nativeTools, ...this.tools.map(tool => tool.name)];
      if (activeTools.length) argv.push('--tools', activeTools.join(','));
      else argv.push('--no-tools');
      if (resumeFile) argv.push('--resume', resumeFile);
      const privateRoot = this.ompSystemSource?.root ?? path.dirname(this.home);
      const env = { NOZELI_CONFIG_ROOT: privateRoot, NOZELI_AGENT_DIR: this.home, TMPDIR: path.join(this.home, 'tmp'), TEMP: path.join(this.home, 'tmp'), TMP: path.join(this.home, 'tmp'), TERM: 'xterm-256color' };
      this.collab = new NativeCollabRuntime({home:this.home,context:this.collabContext,onEntry:this.onCollabEntry,onEvent:this.onCollabEvent,onFact:this.onTransportFact,nativeState:()=>this.bridge.getState(),eligibility:async(job,kind)=>{
        const ticket=this.currentTicket??this.blockedTicket;
        const hostAdmitted=Boolean(ticket&&ticket.job?.id===job.id&&!this.closed&&!this.protocolEnded);
        if(kind==='abort')return {scopeAllowed:hostAdmitted,workOpen:true,hostAdmitted};
        if(!hostAdmitted||this.stopRequested||ticket.ownerGeneration!==this.ownerGeneration||this.phase!=='prompt-inflight')return {scopeAllowed:false,workOpen:false,hostAdmitted:false};
        await this.onBeforeAgentStart?.();
        const still=this.currentTicket===ticket&&!this.stopRequested&&ticket.ownerGeneration===this.ownerGeneration;
        return {scopeAllowed:still,workOpen:still,hostAdmitted:still};
      }});
      Object.assign(env, await this.collab.prepare());
      await fs.mkdir(path.join(this.home, 'tmp'), { recursive: true, mode: 0o700 }).catch(() => {});
      const { env: scrubbedEnv, removed } = scrubProviderEnv(process.env);
      this.envScrubbedKeys = removed;
      // 通用认证继承：官方 auth-broker url/token 只经子进程环境注入（最高优先级），
      // 值不落盘/不进日志/不进 renderer；无 broker 时由投影的系统配置语义决定。
      let authEnv = {};
      if (this.ompAuthBroker) {
        const grant = await this.ompAuthBroker.acquire();
        authEnv = { OMP_AUTH_BROKER_URL: grant.url, OMP_AUTH_BROKER_TOKEN: grant.token, OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: '0' };
      }
      let launch = { command: this.command, args: argv, env: {} };
      if (this.isolation) launch = await isolatedLaunch({ command: this.command, args: argv, home: this.home, cwd: this.cwd, ...this.isolation, writable: [...(this.isolation.writable ?? []), path.dirname(deployed.socketPath)] });   // 隔离完整用于 PTY；桥端点目录可写 bind（ro-bind 根下 listen 不能建 socket 文件）
      const spawnEnv = { ...scrubbedEnv, ...env, ...launch.env, ...authEnv };
      delete spawnEnv.OMP_PROFILE;
      const pty = this.tuiSpawn ?? defaultTuiSpawn();
      this.pty = await pty.spawn(launch.args, { env: spawnEnv, cwd: this.cwd, cols: this.cols, rows: this.rows, command: launch.command });
      this.pid = this.pty.pid;
      this.groupRecord = await ompGroupRecord(this.pid, this.home);
      // exit 映射预建（带 catch）：prompt settle 竞速消费，无消费者也不 unhandled
      this.lostPromise = this.pty.exited.then(exit => {
        this.protocolEnded = true; this.closed = true; this.phase = 'closed'; this.busy = false;
        this.exit = exit;
        this.#failAllWaiters(ompError('OMP_TRANSPORT_LOST', `tui process exited ${exit?.exitCode ?? exit?.code ?? exit?.signal ?? ''}`));
        this.#changed(); this.emit('exit', exit);
        void this.stop().catch(error => this.diag('exit-cleanup-failed', { code: error.code }));
        return exit;
      });
      this.lostPromise.catch(() => {});
      this.exitPromise = this.pty.exited;
      if (this.onSpawn && this.pid) await this.onSpawn(this.pid);
      this.screen = (this.screenFactory ?? createTerminalScreen)({ onChange: () => {} });
      let seq = 0, replay = '', replayChars = 0;
      this.replayFrames = []; this.terminalCols = this.cols; this.terminalRows = this.rows;
      this.pty.onData(data => {
        replay = (replay + data).slice(-256000); this.replay = replay; this.seq = ++seq;
        this.replayFrames.push({cols:this.terminalCols,rows:this.terminalRows,data}); replayChars += data.length;
        while(replayChars>256000&&this.replayFrames.length>1)replayChars-=this.replayFrames.shift().data.length;
        void this.screen.write(data, seq).catch(() => {}); this.emit('pty-data', data, seq);
      });
      const deadline = Date.now() + 30000;
      for (;;) {
        try { this.bridge = connectOmpTerminalBridge({ socketPath: deployed.socketPath, token: deployed.token, onEvent: event => this.#onBridgeEvent(event), onTurnAdmission: event => this.#admitNativeTurn(event) }); this.helloState = await this.bridge.hello(); break; }
        catch (error) {
          try { await this.bridge?.close(); } catch { /* 重试前关闭失败连接——不留双认证竞态 */ }
          this.bridge = null;
          // 精确无模型启动诊断（root）：TUI 已退出即立刻失败（不空等）；错误带端点路径与 PTY 输出尾部
          if (this.protocolEnded || Date.now() > deadline) {
            const detail = `tui bridge not reachable: ${error.message}; endpoint=${deployed.socketPath} (${Buffer.byteLength(deployed.socketPath)}B); tuiExited=${this.protocolEnded}; ptyTail=${JSON.stringify(String(this.replay ?? '').slice(-240))}`;
            await this.#teardown(); throw ompError('OMP_BRIDGE_TIMEOUT', detail);
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }
      this.bridge.onToolCall(frame => this.#onHostToolCall(frame));
      this.threadId = await this.#awaitSessionId(20000);
      this.sessionFile = resumeFile ?? (await pinSessionFileById(this.sessionsDir, this.threadId).catch(() => null));
      if (resumeId != null && this.threadId !== resumeId) { await this.#teardown(); throw ompError('OMP_RESUME_IDENTITY_MISMATCH', `resume identity mismatch: pinned ${resumeId}, tui reported ${this.threadId}`); }
      this.#syncNativeState(await this.bridge.getState(), resumeId != null ? 'session-restored' : 'native-config');
      await this.collab.connect(this.threadId);
      this.phase = 'ready';
      this.#changed();
      return { threadId: this.threadId, sessionFile: this.sessionFile, model: this.model, effective: this.effective };
    } catch (error) {
      this.closed = true; this.phase = 'closed'; this.busy = false;
      try { await this.#teardown(); }
      catch (cleanupError) { error.cleanupError = cleanupError; }
      throw error;
    }
  }


  #syncNativeState(state, source = 'native') {
    if (!state || this.closed) return;
    this.model = state.model ?? null;
    this.effort = state.thinkingLevel ?? null;
    this.effective = { model: this.model, effort: this.effort, modelSource: source, effortSource: source, selectionOwner: 'native' };
    if (state.editorDraft?.known === true && typeof state.editorDraft.hasText === 'boolean') {
      this.nativeDraft = state.editorDraft.hasText;
      this.emit('native-draft', this.nativeDraft);
    }
    this.#changed();
  }

  async refreshNativeDraft() {
    if (!this.bridge || this.closed) return;
    this.#syncNativeState(await this.bridge.getState());
    return this.nativeDraft;
  }

  async #mergeExtensionConfig(bridgePath) {
    let configPath = path.join(this.home, 'config.yml'), existing = '';
    for (const name of ['config.yml', 'config.yaml']) {
      try { existing = await fs.readFile(path.join(this.home, name), 'utf8'); configPath = path.join(this.home, name); break; }
      catch(error) { if(error.code !== 'ENOENT') throw error; }
    }
    const {parse,stringify}=await import('yaml');
    let doc;
    try { doc=parse(existing)||{}; }
    catch { throw ompError('CONFIG_INVALID','Nozeli native configuration is invalid; original file preserved'); }
    if(typeof doc!=='object'||Array.isArray(doc)||doc.extensions!==undefined&&!Array.isArray(doc.extensions))throw ompError('CONFIG_INVALID','Nozeli native extensions must be an array; original configuration preserved');
    if(doc.extensions?.includes(bridgePath))return;
    doc.extensions=[...(doc.extensions||[]),bridgePath];
    const tmp=configPath+'.'+randomUUID()+'.tmp';
    try { await fs.writeFile(tmp,stringify(doc),{flag:'wx',mode:0o600}); await fs.rename(tmp,configPath); }
    finally { await fs.rm(tmp,{force:true}); }
  }

  async #awaitSessionId(timeoutMs) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const id = this.helloState?.sessionId ?? this.reportedSessionId ?? null;
      if (id) return id;
      if (Date.now() > end || this.protocolEnded) throw ompError('OMP_SESSION_ID_TIMEOUT', 'tui session id not reported');
      // get_state has no tool evidence; an early hello can precede session_start.
      // Keep the authenticated registration receipt while polling native identity.
      try { this.helloState = { ...this.helloState, ...await this.bridge.getState() }; } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  #onBridgeEvent(event) {
    this.emit('notification', { kind: 'bridge-event', event });
    if (event.type === 'state_change') this.#syncNativeState(event.state);
    if (event.type === 'session_start') this.reportedSessionId = event.sessionId ?? this.reportedSessionId;
    else if (event.type === 'agent_start') { this.#agentStartSeen = true; this.#agentEndSeen = false; }
    else if (event.type === 'turn_end') {
      // 官方错误事实（非 synthetic 文本特例）：turn_end 携带 stopReason/errorMessage 时记为本回合错误终态证据
      const stop = String(event.message?.stopReason ?? event.message?.stop_reason ?? '').trim();
      const normalized = stop.toLowerCase();
      const currentPromptId = this.currentTicket?.promptId ?? this.blockedTicket?.promptId ?? null;
      this.turnEnds.push({ ...event, promptId: currentPromptId }); // History, not a completion fact.
      // 非错误事实：正常续回合（toolUse/tool_use）与宿主控制性中止（controlAbortRequested 匹配本回合）
      const continuation = ['stop', 'end_turn', 'tool_use', 'tooluse', 'toolcall', 'tool_call'].includes(normalized);
      const hostControlledAbort = ['aborted', 'interrupted', 'cancel', 'cancelled'].includes(normalized) && this.controlAbortRequested === currentPromptId;
      if (normalized && !continuation && !hostControlledAbort) this.turnErrors.push({ promptId: currentPromptId, turnEndIndex: this.turnEnds.length - 1, stopReason: stop, errorMessage: String(event.message?.errorMessage ?? event.message?.error_message ?? '') , at: nowIso() });
    }
    else if (event.type === 'agent_end') {
      const terminal = event.willContinue !== true && event.awaitingAsyncWork !== true;
      if (terminal) this.agentEnds.push({ promptId: this.currentTicket?.promptId ?? this.blockedTicket?.promptId ?? null, text: messageText(event.message ?? this.turnEnds.at(-1)?.message), at: nowIso() });
      this.#agentEndSeen = terminal;
      this.#resolveIdle?.();
    }
    else if (event.type === 'input' && event.source === 'interactive') this.#openManualTurn(event.text ?? '');
    this.#changed();
  }

  async #admitNativeTurn({interactive,text}) {
    if (interactive) {
      if (this.currentTicket || this.phase === 'prompt-inflight') throw ompError('OMP_TURN_BUSY', 'native input cannot join an active host turn');
      this.#openManualTurn(text);
      const opened = await this.manualOpenPromise;
      if (!this.manualTicket?.jobReady || this.manualTicket.jobFailed) throw ompError('OMP_TURN_DENIED', this.manualTicket?.jobFailed || 'manual admission failed');
      this.collab?.bindManual(this.manualTicket.promptId, this.manualJobId);
      return { taskAnchor: opened?.taskAnchor, jobId: this.manualJobId, requestId: this.manualTicket.promptId };
    }
    return await this.onBeforeAgentStart?.() ?? {};
  }

  // 人工回合门：interactive 输入开启 manual ticket（宿主工具按 ticket 裁决）；agent_end+idle 终结
  #openManualTurn(text) {
    if (this.phase === 'prompt-inflight' || this.currentTicket) return;
    this.manualTicket = { promptId: 'manual-' + randomUUID(), manual: true, jobReady: false, jobFailed: null, ownerGeneration: this.ownerGeneration, startedAt: Date.now(), at: nowIso() };
    this.currentTicket = this.manualTicket; this.phase = 'prompt-inflight'; this.busy = true;
    // 每回合清旧终态事实：上一轮 agentEnd/error 不得提前关闭下一轮
    this.#agentEndSeen = false; this.#agentStartSeen = false;
    this.turnErrors = this.turnErrors.filter(e => e.promptId === null || e.promptId === this.currentTicket?.promptId);
    this.diag('manual-turn-opened', { chars: text.length });
    this.#changed();
    // 宿主输入身份（root）：人工提交接 Controller durable job 链（记账/材料/回执/收尾），
    // 不触发第二次模型输入——人工回合本身就是模型输入，宿主只记账与裁决。
    // 竞态合同：durable job 成功（jobReady）前副作用一律不准入；失败保留输入并阻塞（abort 回合、不结算、工具持续拒绝）。
    this.manualOpenPromise = (async () => {
      try {
        const opened = await this.onManualInput?.({ promptId: this.manualTicket.promptId, text });
        if (this.currentTicket === this.manualTicket) {
          this.manualJobId = opened?.jobId ?? null;
          this.manualTicket.jobReady = this.manualJobId != null;
          if (!this.manualTicket.jobReady) {
            this.manualTicket.jobFailed = 'host opened no durable job';
            await this.bridge.stop().catch(() => {});   // 停回合：模型不得在无宿主身份下继续
          }
          this.#changed();
          return opened;
        }
      } catch (error) {
        this.diag('manual-job-open-failed', { message: String(error.message).slice(0, 200) });
        if (this.currentTicket === this.manualTicket) {
          this.manualTicket.jobFailed = String(error.message || error);
          await this.bridge.stop().catch(() => {});   // 失败阻塞：保留输入、停稳不结算（人工处置）
          this.#changed();
        }
      }
    })();
    void this.#closeManualTurnWhenSettled();
  }
  async #closeManualTurnWhenSettled() {
    const deadline = Date.now() + this.settleTimeoutMs;
    let unresolvedReported = false;
    // 阶段一：等待本回合终态三事实（agent_end + isIdle + 无 pending）。
    // 预算耗尽 ≠ 终态满足（root P5 边界2）：不虚构 completed——转 manual-unresolved（保留票据/job/输入/配额）并继续等待；
    // 仅晚到的同代次正确终态可恢复；异代次（interrupt/stop 提升代次后票据失配）自然退出，不影响新 owner。
    while (!this.protocolEnded && this.currentTicket === this.manualTicket && this.manualTicket?.ownerGeneration === this.ownerGeneration && !this.manualTicket?.jobFailed) {
      if (await this.#isSettledNow()) break;
      if (Date.now() > deadline && !unresolvedReported) {
        unresolvedReported = true;
        this.phase = 'manual-unresolved'; this.busy = false;
        this.manualTicket.unresolved = true;
        this.diag('manual-turn-unresolved', { waitedMs: this.settleTimeoutMs });
        this.#changed();
      }
      await new Promise(r => setTimeout(r, 300));
    }
    if (this.protocolEnded || this.currentTicket !== this.manualTicket || this.manualTicket?.ownerGeneration !== this.ownerGeneration || this.manualTicket?.jobFailed) return;
    // 阶段二（root P5 修补）：durable 收尾成功才释放票据/准入；失败进入 settlement-pending——
    // 保留匹配 ticket/job/输入/回执/结果，同身份幂等重试（不重放模型/工具），直到落盘成功或会话停止。
    while (!this.protocolEnded && this.currentTicket === this.manualTicket) {
      const promptId = this.manualTicket.promptId;
      try {
        await this.collab?.drain();
        const answer = this.collab?.answer(promptId) ?? '';
        const turnError = this.#latestTurnError(promptId);
        await this.onManualSettled?.({ promptId, jobId: this.manualJobId, text: answer, error: turnError ? (turnError.errorMessage || turnError.stopReason) : null });
        if (this.currentTicket === this.manualTicket) {
          this.currentTicket = null; this.manualTicket = null; this.phase = 'idle'; this.busy = false;
          this.manualJobId = null; this.#changed();
        }
        return;
      } catch (error) {
        this.manualTicket.settlementPending = String(error.message || error).slice(0, 200);
        this.phase = 'settlement-pending'; this.busy = false;
        this.diag('manual-job-settle-failed', { message: this.manualTicket.settlementPending });
        this.#changed();
        await new Promise(r => setTimeout(r, 400));   // 存储恢复后按同身份既有事实幂等重结算
      }
    }
  }

  // 宿主工具裁决（对齐 OmpSession 合同：稳定身份/首 await 前占位/admission/取消/迟到丢弃）
  async #onHostToolCall({ id, tool, params, isCancelled }) {
    const frozen = { ownerGeneration: this.ownerGeneration, ticket: this.currentTicket?.promptId ?? null, phase: this.phase };
    const refuse = code => { this.diag('host-tool-refused', { code, tool, toolCallId: id }); throw Object.assign(new Error(`nozeli host refused: ${code}`), { code: 'HOST_TOOL_REFUSED' }); };
    if (this.completedToolCalls.has(id) || this.inFlightToolCalls.has(id)) return refuse('duplicate-tool-call');
    this.inFlightToolCalls.add(id);   // 首 await 前原子占位
    try {
      if (!this.tools.some(t => t.name === tool)) return refuse('unknown-tool');
      if (frozen.phase !== 'prompt-inflight' || !frozen.ticket) return refuse('no-active-managed-turn');
      // 人工回合副作用准入：durable job 落账成功（jobReady）前不准入；失败持续拒绝（输入保留、人工处置）
      if (this.currentTicket?.manual && this.currentTicket?.promptId === frozen.ticket) {
        if (this.currentTicket.jobFailed) return refuse('manual-job-failed-input-held');
        if (!this.currentTicket.jobReady) return refuse('manual-job-not-ready');
      }
      if (this.currentTicket && this.currentTicket.ownerGeneration !== this.ownerGeneration) return refuse('owner-generation-changed');
      const admission = {
        cancelled: false, cancelReason: null,
        preEffect: async () => {
          // 副作用准入栅栏（root）：执行前向权威取消方（持有 AbortSignal 的桥进程）核实同 toolCallId 状态；
          // 推送帧只是快路径——栅栏是核实，不是等包。无法核实即拒绝（不重放）。
          let authoritativeCancelled = null;
          try { authoritativeCancelled = (await this.bridge.toolStatus(id))?.cancelled === true; }
          catch { throw ompError('OMP_ADMISSION_INVALID', 'cancel status unverifiable; refusing side effect'); }
          if (authoritativeCancelled || isCancelled?.()) { admission.cancelled = true; admission.cancelReason ??= 'cancelled-before-effect'; }
          if (admission.cancelled) throw ompError('OMP_ADMISSION_INVALID', `admission invalidated: ${admission.cancelReason || 'cancelled-before-effect'}`);
          const still = this.#admissionStillValid(frozen);
          if (!still.ok) throw ompError('OMP_ADMISSION_INVALID', `admission invalidated: ${still.reason}`);
          return { token: randomUUID() };
        },
      };
      // 取消联动：桥 cancel 帧到达即撤销 admission（副作用前取消零效果）
      if (isCancelled?.()) { admission.cancelled = true; admission.cancelReason = 'cancelled-before-effect'; }
      const value = await this.onTool({ tool, arguments: params ?? {}, callId: id, promptId: frozen.ticket, admission });
      // 执行后到达的取消：同样向权威方核实（推送帧可能未到），核实取消即撤销，不冒成功
      try { if ((await this.bridge.toolStatus(id))?.cancelled === true) admission.cancelled = true; } catch { admission.cancelled = true; }   // 无法核实按取消处理（不假成功）
      if (isCancelled?.()) admission.cancelled = true;
      const after = this.#admissionStillValid(frozen);
      if (!after.ok || admission.cancelled) {
        const reason = admission.cancelled ? 'cancelled' : after.reason;
        this.sideEffectFacts.push({ toolCallId: id, promptId: frozen.ticket, outcome: `unverified-${reason}`, at: nowIso() });
        this.completedToolCalls.set(id, { promptId: frozen.ticket, discarded: true });
        throw Object.assign(new Error(`nozeli host discarded result: ${reason} during execution`), { code: 'DISCARDED_LATE' });
      }
      const payload = value && typeof value === 'object' && Array.isArray(value.content) ? value : textResult(JSON.stringify(value ?? null));
      this.completedToolCalls.set(id, { promptId: frozen.ticket, value: payload });
      this.controlReceipts.push({ promptId: frozen.ticket, toolCallId: id, toolName: tool, at: nowIso() });
      const readOnly = value?.readOnly === true || value?.continueTurn === true || tool === 'nozeli_inspect_work';
      if (this.finishOnHostControl && !readOnly && this.phase === 'prompt-inflight' && !this.controlAbortRequested) {
        this.controlAbortRequested = frozen.ticket;
        await this.bridge.stop().catch(() => {});
      }
      return payload;
    } finally { this.inFlightToolCalls.delete(id); }
  }
  #admissionStillValid(frozen) {
    if (this.stopRequested || this.protocolEnded) return { ok: false, reason: 'stopped' };
    if (this.ownerGeneration !== frozen.ownerGeneration) return { ok: false, reason: 'owner-generation-changed' };
    if (this.currentTicket?.promptId !== frozen.ticket) return { ok: false, reason: 'ticket-changed' };
    if (this.phase !== 'prompt-inflight') return { ok: false, reason: `phase-${this.phase}` };
    return { ok: true };
  }

  // prompt：宿主 ticket 准入 → 桥（副作用不重放）→ agent_end+isIdle+!pending 三事实结算
  async prompt(text, { timeout = 600000, images = [], job } = {}) {
    if (this.currentTicket?.manual) throw ompError('OMP_MANUAL_TURN_OPEN', 'human turn in flight; dispatch after it settles');
    if (this.phase !== 'ready' && this.phase !== 'idle') throw ompError('OMP_NOT_DISPATCHABLE', `submitPrompt rejected in phase ${this.phase}`);
    if (this.stopRequested) throw ompError('OMP_STOPPING', 'session stopping');
    if (typeof text !== 'string' || !text.trim()) throw ompError('OMP_PROMPT_INVALID', 'invalid prompt');
    const imageContent = nativePromptImages(images);
    if (imageContent.length) {
      const state = await this.bridge.getState();
      this.#syncNativeState(state);
      if (!Array.isArray(state?.modelInput)) throw ompError('OMP_IMAGE_CAPABILITY_UNKNOWN', 'native model image-input capability is unavailable');
      if (!state.modelInput.includes('image')) throw ompError('OMP_IMAGE_UNSUPPORTED', `native model ${state.model ?? '(none)'} does not support image input`);
      // getState yields: another prompt or manual input may have taken ownership.
      if (this.currentTicket?.manual) throw ompError('OMP_MANUAL_TURN_OPEN', 'human turn in flight; dispatch after it settles');
      if (this.phase !== 'ready' && this.phase !== 'idle') throw ompError('OMP_NOT_DISPATCHABLE', `submitPrompt rejected in phase ${this.phase}`);
      if (this.stopRequested) throw ompError('OMP_STOPPING', 'session stopping');
    }
    const id = randomUUID();
    const ticket = { promptId: id, job, ownerGeneration: this.ownerGeneration, admitted: false, startedAt: Date.now(), at: nowIso() };
    this.currentTicket = ticket; this.phase = 'prompt-inflight'; this.busy = true; this.hasPrompted = true;
    this.controlAbortRequested = null;
    this.#agentEndSeen = false; this.#agentStartSeen = false;
    const priorErrors = this.turnErrors; this.turnErrors = [];
    this.#resetSettleWaiter();
    this.#changed();
    let delivered;
    try { delivered = await this.collab.dispatch(text, imageContent, job); ticket.collab = delivered.collab; }
    catch (error) {
      if (['OMP_COLLAB_REJECTED', 'NATIVE_DRAFT_PENDING'].includes(error.code)) {
        this.currentTicket = null; this.busy = false; this.phase = 'idle'; this.resolvedTickets.add(id); this.#changed(); throw error;
      }
      // ack 失败=准入未知：与 RPC 阻塞规则一致——不凭 isIdle 放行；阻塞至明确恢复事实（agent_end+idle+!pending）
      this.currentTicket = null; this.busy = false;
      this.blockedTicket = { ...ticket, blockedReason: String(error.message || error) };
      this.phase = 'blocked-unresolved-turn';
      this.#changed();
      void this.#recoverFromBlocked();
      throw error;
    }
    ticket.admitted = true; this.promptsDelivered += 1;
    const settleWaiter = this.#settleWaiter;
    const rejectSettle = this.#rejectSettle;
    const timer = setTimeout(() => rejectSettle(ompError('OMP_SETTLE_TIMEOUT', 'prompt settlement timeout')), Math.min(this.settleTimeoutMs ?? timeout, timeout));
    try {
      // 终态合同：agent_end（isTerminal 事实）+ isIdle + !hasPendingMessages——turn_end 不足以放行
      const idleDeadline = Date.now() + Math.min(this.settleTimeoutMs ?? timeout, timeout);
      for (;;) {
        if (ticket.interrupted && this.resolvedTickets.has(id)) throw ticket.interrupted;
        if (this.stopRequested || this.closed || this.protocolEnded) throw ompError('OMP_TRANSPORT_CLOSED', 'session stopped during turn');
        if (!ticket.interrupted && await this.#isSettledNow() && !ticket.interrupted) {
          if (this.stopRequested || this.closed || this.protocolEnded) throw ompError('OMP_TRANSPORT_CLOSED', 'session stopped during settlement');
          if (this.currentTicket !== ticket || ticket.ownerGeneration !== this.ownerGeneration) throw ompError('OMP_TURN_SUPERSEDED', 'prompt no longer owns settlement');
          break;
        }
        if (this.stopRequested || this.closed || this.protocolEnded) throw ompError('OMP_TRANSPORT_CLOSED', 'session stopped during settlement');
        if (Date.now() > idleDeadline) throw ompError('OMP_SETTLE_MISSING', 'agent completion facts missing (agent_end+isIdle+no-pending)');
        await Promise.race([settleWaiter, this.lostPromise.then(() => { throw ompError('OMP_TRANSPORT_LOST', 'tui exited during turn'); }), new Promise(r => setTimeout(r, 300))]);
      }
      const receipts = this.controlReceipts.filter(r => r.promptId === id);
      await this.collab.drain();
      await this.collab.settled(ticket.collab.requestId,{agentEnd:true,idle:true,noPending:true,sessionId:this.threadId,epoch:ticket.collab.epoch,requestId:ticket.collab.requestId});
      const answer = this.collab.answer(ticket.collab.requestId);
      const hostControlled = this.controlAbortRequested === id && receipts.length > 0;
      // 官方错误终态：停稳≠成功——错误事实存在即按错误收束（不 completed、空正文不算完成）
      const turnError = this.#latestTurnError(id);
      if (turnError) {
        this.phase = 'idle'; this.currentTicket = null; this.resolvedTickets.add(id);
        this.#resetSettleWaiter(); this.busy = false;
        const error = ompError('OMP_TURN_ERROR', turnError.errorMessage || `provider turn ended with ${turnError.stopReason}`);
        error.promptId = id; error.threadId = this.threadId; error.stopReason = turnError.stopReason;
        this.#changed(); throw error;
      }
      if (!answer && !receipts.length) {
        // 停稳但既无正文也无宿主回执：不冒充完成（对齐 OMP_TURN_EMPTY 合同）
        this.phase = 'idle'; this.currentTicket = null; this.resolvedTickets.add(id);
        this.#resetSettleWaiter(); this.busy = false;
        const error = ompError('OMP_TURN_EMPTY', 'settled turn has no assistant body or successful host callback');
        error.promptId = id; error.threadId = this.threadId;
        this.#changed(); throw error;
      }
      this.phase = 'idle'; this.currentTicket = null; this.resolvedTickets.add(id);
      this.#resetSettleWaiter();
      return { ...this.#promptReturn({ status: hostControlled ? 'aborted' : 'completed' }, { answer, receipts, id, completion: hostControlled ? 'host-control' : 'provider-completed', startedAt: ticket.startedAt }), collab: ticket.collab };
    } catch (error) {
      // A known settled failure/cancellation must not become an unresolved turn,
      // nor clear a newer ticket admitted after interrupt returned.
      error.promptId = id; error.threadId = this.threadId;
      error.partialText = ticket.collab ? this.collab.answer(ticket.collab.requestId) : '';
      error.metrics = { durationMs: Date.now() - ticket.startedAt, promptChars: text.length, tokenCompleteness: 'unavailable', usage: this.capabilities.usage };
      if (ticket.interrupted && error !== ticket.interrupted) error.cancellation = { code: ticket.interrupted.code, message: ticket.interrupted.message };
      if (this.resolvedTickets.has(id) || this.stopRequested || this.closed || this.protocolEnded || (this.currentTicket && this.currentTicket !== ticket)) throw error;
      const turnError = this.#latestTurnError(id);
      if (turnError) {
        error.turnError = { ...turnError };
        error.message += `; provider ${turnError.stopReason}: ${turnError.errorMessage}`;
      }
      this.currentTicket = null; this.busy = false;
      this.phase = this.protocolEnded ? 'closed' : 'blocked-unresolved-turn';
      this.blockedTicket = { ...ticket, blockedReason: String(error.message || error) };
      this.unsettledPromptError = String(error.message || error);
      void this.#recoverFromBlocked();
      this.#changed(); throw error;
    } finally { clearTimeout(timer); }
  }
  // 阻塞恢复：三事实齐全才回 idle（后续 prompt 才可准入）
  async #recoverFromBlocked() {
    const blocked = this.blockedTicket;
    if (!blocked) return;
    const deadline = Date.now() + (this.settleTimeoutMs ?? 600000);
    while (Date.now() < deadline && !this.protocolEnded && this.blockedTicket === blocked) {
      if (await this.#isSettledNow()) {
        this.blockedTicket = null; this.phase = 'idle'; this.#changed(); return;
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }
  #latestTurnError(promptId) {
    const turnEndIndex = this.turnEnds.findLastIndex(e => e.promptId === promptId);
    return this.turnErrors.findLast(e => e.promptId === promptId && e.turnEndIndex === turnEndIndex) ?? null;
  }
  async #isIdleNow() { try { return (await this.bridge.getState())?.isIdle === true; } catch { return false; } }
  async #isSettledNow() {
    if (!this.#agentEndSeen || this.stopRequested || this.closed || this.protocolEnded) return false;
    const generation = this.ownerGeneration;
    const ticket = this.currentTicket ?? this.blockedTicket;
    try {
      const state = await this.bridge.getState();
      return !this.stopRequested && !this.closed && !this.protocolEnded && this.ownerGeneration === generation && (this.currentTicket ?? this.blockedTicket) === ticket && this.#agentEndSeen && state?.isIdle === true && state?.hasPending === false;
    } catch { return false; }
  }
  #promptReturn(result, { answer, receipts, id, completion, startedAt }) {
    this.busy = false; this.#changed();
    return {
      text: answer, threadId: this.threadId, turnId: null, promptId: id,
      agentInvoked: receipts.length > 0 || answer.length > 0, files: [],
      controlReceipts: receipts, status: result.status === 'aborted' ? 'completed' : result.status, completion,
      providerStatus: result.status, effective: { model: this.helloState?.model ?? this.model, effort: this.effort },
      metrics: { durationMs: Date.now() - startedAt, hostCalls: receipts.map(r => r.toolName), tokenCompleteness: 'unavailable', usage: this.capabilities.usage },
    };
  }

  async interrupt({ timeout = 30000 } = {}) {
    if (this.phase !== 'prompt-inflight') return { idle: true };
    const ticket = this.currentTicket;
    this.ownerGeneration++;   // 在途宿主工具回调自此失效
    const error = ompError('OMP_INTERRUPTED', 'prompt interrupted by host');
    error.promptId = ticket.promptId; error.threadId = this.threadId;
    ticket.interrupted = error;
    if (ticket.collab && ticket.job) await this.collab.cancel(ticket.job, ticket.collab.requestId);
    else await this.bridge.stop();
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.#isSettledNow()) {
        this.phase = 'idle';
        if (this.currentTicket === ticket) { this.currentTicket = null; this.resolvedTickets.add(ticket.promptId); }
        this.busy = false;
        // Settle the original consumer only after all terminal facts are known.
        this.#rejectSettle?.(error);
        this.#resetSettleWaiter();
        this.#changed();
        return { interrupted: true, promptId: ticket.promptId };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw ompError('OMP_INTERRUPT_TIMEOUT', 'turn did not settle after abort');
  }

  async preflightToolsDigest(expected) {
    if (expected == null) return { expectedDigest: null, toolsDigest: this.toolsDigest, compatible: true };
    const reject = stage => { throw ompError('OMP_TOOLS_DIGEST_MISMATCH', `tui bridge tools preflight mismatch: expected ${expected}, requested ${this.toolsDigest}; historical schema equivalence not established (${stage})`); };
    let history;
    try { history = await readOmpTerminalToolHistory(this.home); }
    catch { return reject('historical-evidence-unreadable'); }
    let historical;
    try { historical = history.filter(tools => digestTools(tools) === expected); }
    catch { return reject('historical-evidence-invalid'); }
    if (!historical.length) return reject('historical-digest-missing');
    if (historical.some(tools => comparableTools(tools) !== comparableTools(this.tools))) return reject('historical-schema');
    return { expectedDigest: expected, toolsDigest: this.toolsDigest, compatible: true };
  }

  assertToolsDigest(expected) {
    if (expected == null) return;
    const reject = stage => { throw ompError('OMP_TOOLS_DIGEST_MISMATCH', `tui bridge tools digest mismatch: expected ${expected}, registered ${this.toolsDigest}; historical schema equivalence not established (${stage})`); };
    const registered = this.helloState?.registeredTools;
    // Even an exact stored digest cannot stand in for actual bridge evidence.
    if (!Array.isArray(registered)) return reject('bridge-registration-missing');
    if (this.helloState.toolsDigest !== digestTools(registered)) return reject('bridge-receipt-digest');
    if (comparableTools(this.deployed?.tools ?? this.tools) !== comparableTools(registered)) return reject('bridge-requested-schema');
    const historical = this.deployed?.toolHistory?.filter(tools => Array.isArray(tools) && digestTools(tools) === expected) ?? [];
    if (!historical.length) return reject('historical-digest-missing');
    if (historical.some(tools => comparableTools(tools) !== comparableTools(registered))) return reject('historical-schema');
    this.diag('tools-schema-compatible-resume', { previousDigest: expected, registeredDigest: this.toolsDigest });
  }

  // 终端附着视图：唯一 PTY；input 经 input observer（nativeDraftTargets→Controller 准入/kick）
  terminalAttachment(controller, target) {
    const self = this;
    const inputObserver = createTerminalInputObserver();
    this.attachment = {
      cwd: this.cwd, get closed() { return self.closed; }, terminalId: randomUUID(), threadId: this.threadId, pid: this.pid,
      get exited() { return self.exitPromise; }, get seq() { return self.seq ?? 0; }, get replay() { return self.replay ?? ''; },
      get replayFrames() { return self.replayFrames.map(frame=>({...frame})); },
      input(data) {
        if (self.closed) throw new Error('terminal closed');
        if (controller) {
          const hadDraft = controller.nativeDraftTargets.has(target);
          let observed = data;
          // Keystrokes are only a conservative hint until the native editor
          // reports its actual contents; Ctrl-U clears one line, not every draft.
          if (inputObserver.hasText(observed)) controller.nativeDraftTargets.add(target);
          if (hadDraft !== controller.nativeDraftTargets.has(target)) controller.changed();
        }
        self.pty.write(data);
        if (controller) void self.refreshNativeDraft().catch(() => {});
      },
      async snapshot() { return self.screen.snapshot(); },
      resize(cols, rows) { self.terminalCols=cols;self.terminalRows=rows;self.pty.resize(cols, rows); void self.screen.resize(cols, rows).catch(() => {}); },
      close: () => Promise.resolve({ viewOnly: true }),
    };
    return this.attachment;
  }

  // 停稳退出（P5 面）：idle 才可停；真实 close 才签 exited
  async stopIdle() {
    if (this.phase === 'prompt-inflight' || this.currentTicket || this.blockedTicket) throw ompError('OMP_NOT_IDLE', 'session is not idle');
    if (!await this.#isIdleNow()) throw ompError('OMP_NOT_IDLE', 'session is not idle (provider reports activity)');
    const receipt = await this.stop();
    if (!receipt?.exited || !this.closed) throw ompError('OMP_EXIT_UNCONFIRMED', 'idle exit unconfirmed');
    return { exited: true, pid: this.groupRecord?.pid ?? null, ...receipt };
  }

  async stop({ recover = false } = {}) {
    if (this.stopPromise) {
      try { return await this.stopPromise; }
      catch (error) {
        // Explicit restart only: native death and a fully drained journal plus
        // revoked grants are independent requirements. Keep the original error.
        if (!recover || error !== this.stopFailure || !this.lastExitReceipt?.confirmationComplete || this.lastExitReceipt?.recoverableCleanup !== true || this.collab?.closeReport?.recoverySafe !== true) throw error;
        return { ...this.lastExitReceipt, recovered: true };
      }
    }
    this.stopRequested = true; this.ownerGeneration++;
    this.stopPromise = (async () => {
      const layers = {}, failures = [];
      let drainFailure;
      if (!this.protocolEnded) {
        try { await this.collab?.drain(); }
        catch (error) { drainFailure = error; failures.push(error); layers.collabDrain = { category: 'journal-drain' }; }
      }
      layers.L1_shutdown = { at: nowIso() };
      await this.bridge?.shutdown().catch(e => { layers.L1_shutdown.error = String(e.message); });
      let exit = await Promise.race([this.exitPromise ?? Promise.resolve(null), new Promise(r => setTimeout(() => r(null), 8000))]);
      if (!exit && this.groupRecord?.pid) {
        layers.L2_sigterm = { at: nowIso() };
        try { process.kill(-this.groupRecord.pid, 'SIGTERM'); } catch (error) { layers.L2_sigterm.error = String(error.message); }
        exit = await Promise.race([this.exitPromise ?? Promise.resolve(null), new Promise(r => setTimeout(() => r(null), 4000))]);
      }
      if (!exit && this.groupRecord?.pid) {
        layers.L3_sigkill = { at: nowIso() };
        try { process.kill(-this.groupRecord.pid, 'SIGKILL'); } catch (error) { layers.L3_sigkill.error = String(error.message); }
        exit = await Promise.race([this.exitPromise ?? Promise.resolve(null), new Promise(r => setTimeout(() => r(null), 3000))]);
      }
      layers.L4_childClose = { exit };
      let reaped = { descendantsReaped: 0, verified: false, platform: process.platform };
      try { reaped = await reapOwnedOmpGroup(this.groupRecord); } catch (error) { reaped = { descendantsReaped: 0, verified: false, error: String(error.message) }; }
      layers.L5_descendants = reaped;
      this.closed = true; this.phase = 'closed'; this.busy = false;
      this.#failAllWaiters(ompError('OMP_TRANSPORT_CLOSED', 'session stopped'));
      for (const [stage, operation] of [
        ['bridge-close', () => this.bridge?.close()],
        ['collab-close', () => this.collab?.close()],
        ['screen-dispose', () => this.screen?.dispose()],
      ]) {
        try { await operation(); }
        catch (error) { failures.push(error); layers[stage] = { category: stage }; }
      }
      const recoverableCleanup = failures.length > 0 && failures.every(error => error === this.collab?.hold || (error === drainFailure && (['OMP_COLLAB_EOF', 'ECONNRESET', 'EPIPE'].includes(error.code) || error.message === 'collab-drain-timeout')));
      this.lastExitReceipt = { exited: Boolean(exit), exit, layers, descendantsConfirmed: reaped.verified === true, confirmationComplete: Boolean(exit) && reaped.verified === true, cleanupComplete: failures.length === 0, recoverableCleanup, collabClose: this.collab?.closeReport ?? null };
      this.#changed();
      if (failures.length) {
        this.stopFailure = failures.length === 1 ? failures[0] : Object.assign(new AggregateError(failures, 'omp-stop-cleanup-failed'), { code: 'OMP_STOP_CLEANUP_FAILED' });
        this.stopFailure.exitReceipt = this.lastExitReceipt;
        throw this.stopFailure;
      }
      return this.lastExitReceipt;
    })();
    return recover ? this.stop({ recover: true }) : this.stopPromise;
  }

  async #teardown(force = false) {
    if (this.#tornDown) return; this.#tornDown = true;
    if (this.pty && !this.protocolEnded) { try { this.pty.kill(); } catch {} }
    await Promise.race([this.exitPromise?.catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    try { await this.bridge?.close(); }
    finally {
      try { await this.collab?.close(); }
      finally {
        try { await this.screen?.dispose(); }
        finally { if (this.groupRecord) await reapOwnedOmpGroup(this.groupRecord); }
      }
    }
  }
  #failAllWaiters(error) {
    this.#rejectSettle?.(error);
    this.failure ??= error;
  }
  #resetSettleWaiter() {
    this.#settleWaiter = new Promise((resolve, reject) => { this.#resolveSettle = resolve; this.#rejectSettle = reject; });
    this.#settleWaiter.catch(() => {});
  }
  #settleWaiter = null; #resolveSettle = null; #rejectSettle = null; #idleWaiter = null; #resolveIdle = null; #tornDown = false; #agentEndSeen = false; #agentStartSeen = false; #rejects = null;

  cleanupEvidence() {
    const receipt = this.lastExitReceipt;
    return { transport: this.collab?.diagnostics() ?? null, closeReport: this.collab?.closeReport ?? null,
      exit: receipt ? { exited: receipt.exited === true, confirmationComplete: receipt.confirmationComplete === true, descendantsConfirmed: receipt.descendantsConfirmed === true, cleanupComplete: receipt.cleanupComplete === true, recoverableCleanup: receipt.recoverableCleanup === true } : null };
  }

  snapshot() {
    return {
      threadId: this.threadId, sessionId: this.threadId, sessionFile: this.sessionFile,
      phase: this.phase, busy: this.busy, closed: this.closed, externalTurnId: this.externalTurnId,
      model: this.model, effort: this.effort, effective: this.effective ?? null, exit: this.exit ?? null,
      toolsRegistered: true, toolsDigest: this.toolsDigest,
      startupSettled: this.phase !== 'ready-blocked-unsettled', blockedTicket: this.blockedTicket,
      promptsDelivered: this.promptsDelivered, ownerGeneration: this.ownerGeneration,
      manualTurn: this.currentTicket?.manual === true,
      failure: this.failure?.code ?? null, capabilities: this.capabilities, diagnostics: (this.diagnosticsLog ?? []).slice(-50),
      controlReceipts: this.controlReceipts, sideEffectFacts: this.sideEffectFacts, lastExitReceipt: this.cleanupEvidence().exit, cleanupEvidence: this.cleanupEvidence(),
    };
  }
}

// 默认 PTY spawn（生产）：node-pty + 受控 env（不合并 process.env；凭据经 scrub 后仅放行 env 引用）
function defaultTuiSpawn() {
  const pty = require('node-pty');
  return {
    spawn: (argv, { env, cwd, cols, rows, command }) => new Promise((resolve, reject) => {
      try {
        const term = pty.spawn(command, argv, { name: 'xterm-256color', cols, rows, cwd, env });
        resolve({
          pid: term.pid,
          write: d => term.write(d),
          resize: (c, r) => term.resize(c, r),
          kill: () => { try { term.kill(); } catch {} },
          onData: fn => term.onData(fn),
          exited: new Promise(resolveExit => term.onExit(v => resolveExit(v))),
        });
      } catch (e) { reject(e); }
    }),
  };
}
