// Nozeli 多任务编排交互演示 — 模拟引擎（SIMULATION ONLY）
//
// 这是一个独立演示用的纯前端状态机，不连接任何真实运行时/构建产物/用户数据。
// 所有 sourceId / worktree / candidate / runId 均为明显伪造的演示值。
//
// Shared contract:
//   createDemo({ storage = globalThis.localStorage } = {}) ->
//     { getState, subscribe(fn)->unsubscribe, dispatch(action, payload = {}) }
//
//   State (plain JSON):
//     {
//       tasks: [{ id, name, request, status, manualPaused, slot, revision,
//                 runId, report, closureStep, sourceId, worktree, candidate,
//                 decision, blockedReason, sourceMessageId,
//                 projectId, blockers: [], scenario: null }],
//       events: [{ id, text, at, channel }],  channel: 'general' | 'fault' —
//                          'fault' 仅自动故障恢复步骤（自愈推进/自愈收口/故障升
//                          级），通用播报可按 channel 过滤（缺省视为 general）
//       messages: [{ id, role, text, taskId }],
//       orchestrator: 'idle' | 'routing',
//       epoch: number,
//       projects: [{ id, name, connected }],
//       incidents: [{ id, kind, mode, title, status, version, scope, taskIds,
//                     counts: { impacted, activeBlocked }, createdAt,
//                     resolvedAt, escalatedAt, assume, recoveryPhase,
//                     requiresUser, attempts, logs, recoveries,
//                     failNextClear }],
//       lastRecovery: null | { incidentId, requestKey, at, outcome, taskIds,
//                               counts: { selected, resumed, skipped },
//                               results }
//     }
//
// Task lifecycle (fixed stage order — see DEMO_STAGES):
//   submitted → orchestrating → queued → running → review → closing → ended
//   paused/stopping are slot-held variants of running; blocked = 故障
//   (restored-unknown run or failed closure).
//
// Tick pipeline (one snapshot per tick, no same-tick cascading):
//   intake   — tasks advance at most ONE step per tick, judged against the
//              tick-start snapshot: existing submitted → orchestrating,
//              existing orchestrating → queued. manualPaused freezes a task
//              at its current stage (paused queued stays queued, paused
//              intake stays put) until resume().
//   landing  — stopping → paused (slot held, run cleared).
//   closure  — closing advances one phase per tick, ended at step 3.
//   schedule — scheduleQueued() starts eligible queued tasks (FIFO by tasks
//              array order) into free slots; manualPaused queued never start.
//   recovery — recovering incidents advance ONE phase per tick (diagnose →
//              repair → verify → continue): transient resolves once and
//              auto-resumes the safe queued targets; persistent escalates to
//              needsuser after its single bounded repair attempt. Tasks
//              resumed here admit on the NEXT tick (no same-tick cascade).
//   indicator — orchestrator = 'routing' iff some task is actually
//              orchestrating OR some incident is auto-recovering; idle while
//              work merely waits (for pickup, a worker slot, or the user).
//              Explicit resume / closure-retry set it transiently; the next
//              tick reconciles.
//
// UI guidance exports:
//   DEMO_STAGES                       — fixed tracker stage order
//   demoNeedsTick(state) -> boolean   — a tick would move something right now
//                                      (incl. any incident auto-recovering)
//   demoOpenIncidents(state)          — ONLY needsuser unresolved incidents
//                                      (topbar 故障条); recovering faults are
//                                      silent — no user alert artifact
//   demoRecoveringIncidents(state)    — auto-recovering incidents (状态标签)
//   demoIncidentLogs(incident)        — structured recovery log [{at,phase,text}]
//
//   task.sourceMessageId : string | null — 创建该任务的用户消息 id（对话 ↔ 任务关联）：
//                          add() 在同一事务内创建真实用户消息并互链；
//                          种子任务指向真实存在的种子消息（共享，故该消息 taskId=null）；
//                          batch() 无逐条来源 → null（展示回退冻结的 task.request 原文）；
//                          旧持久化缺该字段 → null（可选关联，不猜测回填）
//   message.taskId       : string | null — 消息归属任务 id（add 的用户消息、complete 的报告消息）
//   task.projectId       : string — 所属模拟项目；旧持久化任务缺省归一为当前项目
//                          「研究工作台」（reload normalize，不重置存档）
//   task.blockers        : [{ type: 'fault', incidentId, kind, note, at }] —
//                          未解决的模拟故障阻塞；含任意 blocker 的任务永不调度；
//                          事件收口（clearIncident / 自愈）只清除本事件的 blocker，绝不动其他条目
//   task.scenario        : null | { incidentId, role: 'safe-queued' } — 注入创建的
//                          「模拟」场景任务标记；事件 impacted 集只收新注入的安全
//                          排队场景任务（研究工作台 2 + 文献复现 1），绝不静默改动
//                          既有任务；人工暂停/未知/其他故障等既有情形由恢复资格
//                          helper 保护，但不再随每次注入制造人工待办
//   模拟事件（仅演示：无真实探测、无预算统计）：
//     injectIncident({ kind: 'network', mode? }) — network 需 mode 'transient'
//                          （默认）| 'persistent'；balance 无 mode（配额耗尽立即
//                          需人工）。同 kind 未收口（recovering/needsuser）→ 无操作
//                          （去重）。transient → recovering：tick 按 diagnose →
//                          repair → verify → continue 推进，收口一次并自动恢复全
//                          部安全排队任务（无用户告警、无人工决策工件）；
//                          persistent → recovering：单次有界修复尝试（diagnose →
//                          repair）失败即升级 needsuser，不无限重试；balance →
//                          立即 needsuser。
//     clearIncident({ id, requestKey, injectScenario? }) — 一键「故障解除」：
//                          校验范围（仅 needsuser 未收口可解除；recovering 自动
//                          处理无需点击），内部完成安全批量恢复（无预览/修复点击）。
//                          按任务【清除前】状态分类：仅安全任务（从未准入排队且无
//                          其他阻塞）清除本事件 blocker 回到 queued（不重放旧请求，
//                          常规 tick 按项目 2 槽调度），其余保留各自原有阻塞原因。
//                          同 requestKey 同意图重放无效果。可选 injectScenario:
//                          'failNext'（或预先 simulateRefailure 装填）→ 本次解除
//                          失败并再次升级同一事件一次（标记即消费，绝不无限循环），
//                          再次点击即收口。
//     simulateRefailure({ id }) — 装「模拟复发」标记（仅 needsuser 事件）：
//                          下一次 clearIncident 失败一次并再次升级同一事件。
//
// Report: complete() 生成确定性中文模拟报告（已完成动作/示例发现/局限/未完成与风险/采纳效果），
//   进入 review 即冻结，后续任何动作不再改写。
//
// Slot rules: slots are integers 0 and 1 (lowest free index first); each
// project has its own SLOT_COUNT=2 slots — occupancy is counted per
// task.projectId. Event text labels them W1/W2 (slot 0 -> W1, slot 1 -> W2),
// qualifying the project name for non-current projects.
// Held (slot !== null) for running/paused/stopping/review/closing/blocked.
// Pre-work stages (submitted/orchestrating/queued) never hold a slot.
// Freed only when a task reaches 'ended'.
// A task carrying any unresolved fault blocker, or belonging to a
// disconnected project, is never scheduled into a slot.
//
// Message cap: MAX_MESSAGES = 100, oldest-first eviction — but a message that is
//   some task's sourceMessageId (its original request) is never evicted.

const STORAGE_KEY = 'nozeli-multitask-demo-v1';
const SLOT_COUNT = 2;
const MAX_EVENTS = 300;
const MAX_MESSAGES = 100;

// Simulation projects (demo-only): the current project owns all pre-existing /
// user-added tasks; 归档项目 is deliberately disconnected (its tasks never run).
const CURRENT_PROJECT_ID = 'p-research';
const PROJECT_DEFS = [
  { id: CURRENT_PROJECT_ID, name: '研究工作台', connected: true },
  { id: 'p-literature', name: '文献复现', connected: true },
  { id: 'p-archive', name: '归档项目', connected: false },
];

// Simulated incident kinds (no real probes, no budget stats — 演示专用)
const INCIDENT_KINDS = {
  network: { label: '网络中断', title: '模拟事件：跨项目网络中断', assume: '跨项目网络不可用，未准入任务无法调度（模拟假设，无真实探测）' },
  balance: { label: '配额耗尽', title: '模拟事件：跨项目配额（余额）耗尽', assume: '共享配额/余额耗尽，新调度被拒（模拟假设，无真实计费数据）' },
};

// network faults come in two demo modes (balance is always IMMEDIATE
// needsuser — quota exhaustion has nothing to auto-recover):
//   transient  — auto-recovers through the tick phase machine, resolves once
//                and auto-resumes the safe queued targets (silent: no user
//                alert, no dedicated decision artifact)
//   persistent — ONE bounded recovery attempt, then escalation to needsuser
const NETWORK_MODES = {
  transient: {
    title: '模拟事件：跨项目网络瞬断（可自愈）',
    assume: '跨项目网络短暂不可用，未准入任务暂停调度（模拟假设，无真实探测；自动恢复已启动）',
  },
  persistent: {
    title: '模拟事件：跨项目网络中断（持续）',
    assume: '跨项目网络持续不可用，未准入任务无法调度（模拟假设，无真实探测；仅一次自动修复尝试，失败即需人工）',
  },
};

// Deterministic impacted scenario set: ONLY safe never-admitted queued
// targets (auto-resumable by recovery), 2 projects (研究工作台 2 + 文献复现 1).
// Injection never manufactures manual-pause / unknown / other-fault piles —
// real existing tasks in those categories stay protected by
// recoveryEligibility(), but a fault no longer spawns human todos.
const SIM_ROLE_DEFS = [
  { suffix: 'A', role: 'safe-queued', label: '排队A', projectId: CURRENT_PROJECT_ID, note: '从未准入排队，可安全恢复' },
  { suffix: 'B', role: 'safe-queued', label: '排队B', projectId: CURRENT_PROJECT_ID, note: '从未准入排队，可安全恢复' },
  { suffix: 'C', role: 'safe-queued', label: '文献排队C', projectId: 'p-literature', note: '从未准入排队（文献复现），可安全恢复' },
];

// Auto-recovery phase machine: one phase per tick; transient walks all four,
// persistent stops after its single repair attempt (escalation).
const RECOVERY_PHASES = ['diagnose', 'repair', 'verify', 'continue'];
const PHASE_LABELS = { diagnose: '诊断', repair: '修复', verify: '验证', continue: '续跑' };

// legacy demo artifact: old injections fabricated a foreign "other fault"
// blocker (role F) that no current scenario ever creates. Kept ONLY to strip
// it from old persisted states at load (see normalizeMultiProject) — keeping
// it would forever discard-block those legacy tasks with a fault that can
// never resolve in the new flow.
const FOREIGN_FAULT_INCIDENT_ID = 'sim-fault-prior-FAKE';

const STATUSES = ['submitted', 'orchestrating', 'queued', 'running', 'paused', 'stopping', 'review', 'closing', 'blocked', 'ended'];

// --- helpers -------------------------------------------------------------

const clone = (v) => JSON.parse(JSON.stringify(v));

let idCounter = 0;
function nextId(prefix) {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${idCounter.toString(36)}-${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

// host-like generated ids, clearly demo-fabricated payload values
function newTaskId() {
  return nextId('demo-task');
}
function newRunId(epoch) {
  return `demo-run-FAKE-e${epoch}-${Math.random().toString(36).slice(2, 8)}`;
}

// Event log entry. channel 'fault' marks AUTOMATIC fault-recovery steps only
// (phase progression / auto resolution / escalation) so a generic announcer
// can filter them out; user-driven feedback stays 'general'. Missing channel
// (seed events / older code paths) reads as 'general'.
function pushEvent(draft, text, channel = 'general') {
  draft.events.push({ id: nextId('e'), text, at: nowIso(), channel: channel === 'fault' ? 'fault' : 'general' });
  if (draft.events.length > MAX_EVENTS) draft.events = draft.events.slice(-MAX_EVENTS);
}

function pushMessage(draft, role, text, taskId = null) {
  const message = { id: nextId('m'), role, text, taskId };
  draft.messages.push(message);
  if (draft.messages.length > MAX_MESSAGES) {
    // oldest-first eviction, but a task's original request (sourceMessageId
    // linkage) is never evicted — the cap must not orphan a task's source
    const linked = new Set(draft.tasks.filter((t) => t.sourceMessageId).map((t) => t.sourceMessageId));
    const keepFrom = draft.messages.length - MAX_MESSAGES;
    draft.messages = draft.messages.filter((m, i) => linked.has(m.id) || i >= keepFrom);
  }
  return message;
}

// event-facing slot label: 0 -> W1, 1 -> W2 (state keeps plain integers)
function slotLabel(slot) {
  return slot === null || slot === undefined ? '槽位' : `W${slot + 1}`;
}

function findTask(draft, id) {
  const task = draft.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`[multitask-demo] unknown task id: ${String(id)}`);
  return task;
}

function requireStatus(task, action, statuses) {
  if (!statuses.includes(task.status)) {
    throw new Error(
      `[multitask-demo] cannot ${action} task "${task.name}" in status "${task.status}" (expected ${statuses.join('/')})`
    );
  }
}

// Slot occupancy is PER PROJECT (SLOT_COUNT slots each): the same integer slot
// in two different projects is two distinct worker slots.
function heldSlots(draft, projectId) {
  const held = new Set();
  for (const t of draft.tasks) {
    if (t.slot === null || t.slot === undefined) continue;
    if (projectId !== undefined && t.projectId !== projectId) continue;
    held.add(t.slot);
  }
  return held;
}

function freeSlot(draft, projectId) {
  const held = heldSlots(draft, projectId);
  for (let s = 0; s < SLOT_COUNT; s += 1) if (!held.has(s)) return s;
  return null;
}

function projectById(draft, id) {
  return draft.projects.find((p) => p.id === id) || null;
}

function isProjectConnected(draft, projectId) {
  const project = projectById(draft, projectId);
  return project !== null && project.connected === true;
}

// A task is unrunnable while ANY unresolved simulated fault blocker remains.
function hasFaultBlockers(task) {
  return Array.isArray(task.blockers) && task.blockers.length > 0;
}

function hasIncidentBlocker(task, incidentId) {
  return Array.isArray(task.blockers) && task.blockers.some((b) => b.type === 'fault' && b.incidentId === incidentId);
}

// FIFO scheduling of eligible queued tasks into free slots of THEIR project.
// Never scheduled: manualPaused tasks, tasks carrying fault blockers, and
// tasks of a disconnected project (project offline).
function scheduleQueued(draft) {
  for (const t of draft.tasks) {
    if (t.status !== 'queued' || t.manualPaused || hasFaultBlockers(t)) continue;
    if (!isProjectConnected(draft, t.projectId)) continue;
    const slot = freeSlot(draft, t.projectId);
    if (slot === null) continue; // this project is full; other projects may still have room
    const project = projectById(draft, t.projectId);
    const where = project && project.id !== CURRENT_PROJECT_ID ? `${slotLabel(slot)}（${project.name}）` : slotLabel(slot);
    t.status = 'running';
    t.slot = slot;
    t.revision += 1;
    t.runId = newRunId(draft.epoch);
    pushEvent(draft, `调度启动：「${t.name}」占用 ${where}（run ${t.runId}）`);
  }
}

// The orchestrator indicator mirrors actual routing work: 'routing' iff some
// task is currently orchestrating OR some incident is auto-recovering (the
// engine is actively working the fault through its phase machine). Work that
// merely waits (submitted pickup, queued worker slot, needsuser fault) keeps
// it 'idle'.
function syncOrchestrator(draft) {
  draft.orchestrator =
    draft.tasks.some((t) => t.status === 'orchestrating') || draft.incidents.some((i) => i.status === 'recovering') ? 'routing' : 'idle';
}

// --- simulated incidents helpers --------------------------------------------

function findIncident(draft, id) {
  const incident = draft.incidents.find((i) => i.id === id);
  if (!incident) throw new Error(`[multitask-demo] unknown incident id: ${String(id)}`);
  return incident;
}

// "Relevant unresolved" targets = tasks the incident can still auto-recover:
// NOT ended, still carrying this incident's blocker, and blocked by nothing
// else (no manual pause / unknown state / other fault / offline project /
// prior execution). Held-excluded and ended tasks never count — their own
// causes are outside this incident's recovery.
function countRelevantBlocked(draft, incidentId) {
  return draft.tasks.filter((t) => recoveryEligibility(draft, t, incidentId).eligible).length;
}

// Incident resolution — the SINGLE close path for both the transient auto
// recovery (tick phase machine) and clearIncident (one-click user intent).
// Classifies every still-blocked target from its CURRENT pre-mutation state,
// clears ONLY this incident's blocker everywhere (a resolved fault cannot
// keep blocking), and re-queues the SAFE targets: never-executed tasks go
// back to plain queued with NO old-prompt replay, NO new run, NO direct
// admit — the normal tick schedules them (2 slots per project). Protected
// categories (manual pause / unknown / other fault / offline / ended /
// already executed) keep their own holds exactly as they were.
function resolveIncident(draft, incident, { source, requestKey = null } = {}) {
  const results = [];
  for (const tid of incident.taskIds) {
    const task = draft.tasks.find((t) => t.id === tid);
    if (!task) {
      results.push({ taskId: tid, name: tid, result: 'skipped', reason: 'missing' });
      continue;
    }
    if (!hasIncidentBlocker(task, incident.id)) continue; // already cleared earlier
    const { eligible, reason } = recoveryEligibility(draft, task, incident.id);
    task.blockers = task.blockers.filter((b) => !(b.type === 'fault' && b.incidentId === incident.id));
    if (eligible) {
      task.status = 'queued'; // never executed → plain queued, tick admits it
      results.push({ taskId: tid, name: task.name, result: 'resumed', reason: null });
    } else {
      results.push({ taskId: tid, name: task.name, result: 'skipped', reason });
    }
  }
  const at = nowIso();
  const counts = {
    selected: results.length,
    resumed: results.filter((r) => r.result === 'resumed').length,
    skipped: results.filter((r) => r.result === 'skipped').length,
  };
  incident.status = 'resolved';
  incident.resolvedAt = at;
  incident.requiresUser = false;
  incident.recoveryPhase = null;
  incident.failNextClear = false;
  incident.version += 1;
  incident.counts.activeBlocked = 0;
  incident.logs.push({
    at,
    phase: 'resolved',
    text: `事件收口（${source === 'auto' ? '自愈完成' : '人工一键解除'}）：恢复安全排队任务 ${counts.resumed} 个${counts.skipped > 0 ? `，保持不动 ${counts.skipped} 个（各自原有阻塞原因保留）` : ''}`,
  });
  draft.lastRecovery = {
    incidentId: incident.id,
    requestKey,
    at,
    outcome: source === 'auto' ? 'auto-resolved' : 'cleared',
    taskIds: [...incident.taskIds],
    counts,
    results,
  };
  const skipNotes = results
    .filter((r) => r.result === 'skipped')
    .map((r) => `「${r.name}」(${r.reason})`)
    .join('、');
  pushEvent(
    draft,
    `${source === 'auto' ? '自愈收口' : '故障解除'}：「${incident.title}」恢复 ${counts.resumed} 个安全任务（清除本事件阻塞，回排队由常规 tick 按项目 2 槽调度）${counts.skipped > 0 ? `；保留不动 ${counts.skipped}：${skipNotes}（各自原有阻塞原因不动）` : ''}${requestKey ? `（requestKey ${requestKey}，重复请求不会重复执行）` : ''}`,
    source === 'auto' ? 'fault' : 'general'
  );
  return counts;
}

// Persistent fault: its single bounded attempt failed — escalate ONCE to the
// user (topbar). No retry loop: automatic recovery stops permanently here
// until clearIncident.
function escalateIncident(draft, incident, detail) {
  const at = nowIso();
  incident.status = 'needsuser';
  incident.requiresUser = true;
  incident.recoveryPhase = null;
  incident.escalatedAt = at;
  incident.version += 1;
  incident.counts.activeBlocked = countRelevantBlocked(draft, incident.id);
  incident.logs.push({ at, phase: 'escalated', text: `自动恢复停止：${detail}，升级需人工处理（不无限重试）` });
  pushEvent(draft, `故障升级：「${incident.title}」${detail}，停止自动重试，需人工处理（顶部故障条可见，一键解除后自动恢复安全任务）`, 'fault');
}

// One phase transition per recovering incident per tick. Bounded and
// restart-safe: the persisted phase is retained and resumed, attempts never
// reset, and no old request is ever replayed.
function advanceRecovery(draft) {
  let changed = false;
  for (const incident of draft.incidents) {
    if (incident.status !== 'recovering') continue;
    incident.counts.activeBlocked = countRelevantBlocked(draft, incident.id);
    const at = nowIso();
    if (incident.recoveryPhase === 'diagnose') {
      incident.recoveryPhase = 'repair';
      incident.logs.push({ at, phase: 'repair', text: '诊断完成：定位模拟故障点，进入修复' });
      pushEvent(draft, `自愈推进：「${incident.title}」诊断完成 → 修复中（第 ${incident.attempts} 次尝试）`, 'fault');
      changed = true;
    } else if (incident.recoveryPhase === 'repair') {
      if (incident.kind === 'network' && incident.mode === 'persistent') {
        escalateIncident(draft, incident, '单次修复尝试未成功（模拟持续故障）');
      } else {
        incident.recoveryPhase = 'verify';
        incident.logs.push({ at, phase: 'verify', text: '修复动作完成：验证跨项目连通（模拟）' });
        pushEvent(draft, `自愈推进：「${incident.title}」修复完成 → 验证中`, 'fault');
      }
      changed = true;
    } else if (incident.recoveryPhase === 'verify') {
      incident.recoveryPhase = 'continue';
      incident.logs.push({ at, phase: 'continue', text: '验证通过：准备续跑受影响的安全排队任务' });
      pushEvent(draft, `自愈推进：「${incident.title}」验证通过 → 准备续跑`, 'fault');
      changed = true;
    } else if (incident.recoveryPhase === 'continue') {
      // transient completes: resolve ONCE and auto-resume the safe targets
      resolveIncident(draft, incident, { source: 'auto' });
      changed = true;
    }
  }
  return changed;
}

// Can this task be auto-recovered for this incident right now? Ordered gates:
// ended / not blocked by this incident / project offline / unknown restored
// run / manual pause / other fault / already executed / not a pre-work stage.
// Returns { eligible, reason } — reason is null only when eligible.
function recoveryEligibility(draft, task, incidentId) {
  if (task.status === 'ended') return { eligible: false, reason: 'ended' };
  if (!hasIncidentBlocker(task, incidentId)) return { eligible: false, reason: 'not-blocked' };
  if (!isProjectConnected(draft, task.projectId)) return { eligible: false, reason: 'project-offline' };
  if (task.blockedReason === 'unknown') return { eligible: false, reason: 'unknown-effect' };
  if (task.manualPaused) return { eligible: false, reason: 'manual-pause' };
  if (task.blockers.some((b) => b.type === 'fault' && b.incidentId !== incidentId)) {
    return { eligible: false, reason: 'other-fault' };
  }
  if (task.slot !== null && task.slot !== undefined) return { eligible: false, reason: 'executed' };
  if (task.runId !== null && task.runId !== undefined) return { eligible: false, reason: 'executed' };
  if (!['submitted', 'orchestrating', 'queued'].includes(task.status)) {
    return { eligible: false, reason: `status-${task.status}` };
  }
  return { eligible: true, reason: null };
}

// (classification is always computed from the task's CURRENT blockers, BEFORE
// any mutation — see resolveIncident; there is no post-clear classification)

// --- ui guidance -----------------------------------------------------------

// Fixed stage order for the minimalist tracker (提交 → 编排 → 排队 → 工作 →
// 待审 → 故障 → 收尾 → 结束). 'working' bundles the slot-held run variants
// (running/paused/stopping); a manualPaused task stays in its current stage
// (e.g. paused queued remains queued) — the UI badges it. Within a stage the
// tasks array order (creation order) is FIFO.
export const DEMO_STAGES = [
  { key: 'submitted', statuses: ['submitted'], label: '提交' },
  { key: 'orchestrating', statuses: ['orchestrating'], label: '编排' },
  { key: 'queued', statuses: ['queued'], label: '排队' },
  { key: 'working', statuses: ['running', 'paused', 'stopping'], label: '工作' },
  { key: 'review', statuses: ['review'], label: '待审' },
  { key: 'blocked', statuses: ['blocked'], label: '故障' },
  { key: 'closing', statuses: ['closing'], label: '收尾' },
  { key: 'ended', statuses: ['ended'], label: '结束' },
];

// True when a tick would move something right now: an unfrozen intake step
// (submitted/orchestrating without manualPaused), a pending landing (stopping),
// a closure in progress, a schedulable queued task (no fault blockers, no
// manual pause, connected project) whose project still has a free slot, OR an
// incident auto-recovering — its phase advances even with zero task stage
// changes. Guidance only — dispatching tick anyway is always safe (no-op
// stays put).
export function demoNeedsTick(state) {
  if (state.incidents.some((i) => i.status === 'recovering')) return true;
  const freeByProject = new Map();
  const hasFreeSlot = (t) => {
    if (!freeByProject.has(t.projectId)) freeByProject.set(t.projectId, freeSlot(state, t.projectId) !== null);
    return freeByProject.get(t.projectId);
  };
  return state.tasks.some(
    (t) =>
      t.status === 'stopping' ||
      t.status === 'closing' ||
      ((t.status === 'submitted' || t.status === 'orchestrating') && !t.manualPaused) ||
      (t.status === 'queued' && !t.manualPaused && !hasFaultBlockers(t) && isProjectConnected(state, t.projectId) && hasFreeSlot(t))
  );
}

// ONLY unresolved incidents that require the user (topbar 故障条), oldest
// first — auto-recovering faults are deliberately silent here (no user
// alert); see demoRecoveringIncidents for the recovering status label.
export function demoOpenIncidents(state) {
  return state.incidents.filter((i) => i.status === 'needsuser');
}

// Incidents currently auto-recovering (transient walk / persistent attempt):
// UI status label like 「自愈中 n」; progress is visible via state.events and
// demoIncidentLogs (structured per-incident log).
export function demoRecoveringIncidents(state) {
  return state.incidents.filter((i) => i.status === 'recovering');
}

// Structured per-incident recovery log (chronological copy):
//   [{ at, phase, text }] — phase ∈ diagnose | repair | verify | continue |
//   resolved | escalated | armed (注入首条为 diagnose 或 escalated)
export function demoIncidentLogs(incident) {
  if (!incident || !Array.isArray(incident.logs)) return [];
  return incident.logs.map((l) => ({ at: l.at, phase: l.phase, text: l.text }));
}

// Per-project slot occupancy for the work indicators: [{ id, name, connected,
//   held, capacity }]. held counts tasks of the project with slot !== null.
export function demoProjectSlots(state) {
  return state.projects.map((p) => ({
    id: p.id,
    name: p.name,
    connected: p.connected === true,
    capacity: SLOT_COUNT,
    held: state.tasks.filter((t) => t.projectId === p.id && t.slot !== null && t.slot !== undefined).length,
  }));
}

// Action names currently valid for a task (pure; mirrors engine gates so the
// UI never has to infer). Order is UI display order. Excludes tick-level
// automation; incident recovery actions live on the incident, not the task.
export function demoTaskActions(state, task) {
  if (!task) return [];
  const acts = [];
  if (['submitted', 'orchestrating', 'running', 'queued', 'review'].includes(task.status) && !task.manualPaused) acts.push('pause');
  if (['running'].includes(task.status)) acts.push('stop');
  if (['submitted', 'orchestrating', 'paused', 'queued', 'review', 'blocked'].includes(task.status) && (task.manualPaused || ['paused', 'blocked'].includes(task.status))) acts.push('resume');
  if (task.status === 'running') acts.push('complete');
  if (task.status === 'review') acts.push('accept');
  // discard is never a normal fault action: an incident-blocked task cannot
  // be deleted until the fault is cleared (blockers gone) or there is stop
  // evidence (stopping, or paused with its run already cleared)
  const stopEvidence = task.status === 'stopping' || (task.status === 'paused' && task.runId === null);
  if (task.status !== 'ended' && (!hasFaultBlockers(task) || stopEvidence)) acts.push('discard'); // may still throw (gates) — engine is the authority
  return acts;
}

// --- seed ----------------------------------------------------------------
// the single seed user message is the (shared, valid) source of all seed tasks
const SEED_SOURCE_MESSAGE_ID = 'm-seed-1';

function makeSeedTask({
  id,
  name,
  request,
  status,
  slot,
  revision,
  runId,
  seedIndex,
  sourceMessageId = null,
  projectId = CURRENT_PROJECT_ID,
  blockers = [],
  scenario = null,
  manualPaused = false,
  decision = null,
  blockedReason = null,
}) {
  return {
    id,
    name,
    request,
    status,
    manualPaused,
    slot,
    revision,
    runId,
    report: null,
    closureStep: 0,
    // 明显伪造的演示值（fake / fabricated on purpose）
    sourceId: `demo-src-FAKE-${String(seedIndex).padStart(2, '0')}`,
    worktree: `/tmp/nozeli-demo-fake-worktree-${String(seedIndex).padStart(2, '0')}`,
    candidate: `demo-candidate-FAKE-${String(seedIndex).padStart(2, '0')}`,
    decision,
    blockedReason,
    sourceMessageId,
    projectId,
    blockers: clone(blockers),
    scenario,
  };
}

function seedState() {
  // representative tasks per project: 研究工作台 (current, 6 tasks),
  // 文献复现 (connected second project), 归档项目 (disconnected, ended only)
  const defs = [
    { name: '检索量子纠错码最新综述', request: '检索并汇总 2025-2026 年量子纠错码方向的最新综述文献' },
    { name: '调研 Serverless 冷启动优化方案', request: '调研主流 FaaS 平台的冷启动优化技术并对比效果' },
    { name: '汇总向量数据库性能基准测试', request: '汇总主流向量数据库在召回率/延迟上的基准测试数据' },
    { name: '分析大模型推理成本趋势', request: '分析 2025-2026 年大模型推理单位成本的变化趋势' },
    { name: '整理 CNCF 云原生安全报告要点', request: '整理最新一期 CNCF 云原生安全报告的核心要点' },
    { name: '调研 Rust 边缘计算落地案例', request: '调研 Rust 在边缘计算场景的典型落地案例' },
  ];
  const tasks = defs.map((d, i) =>
    makeSeedTask({
      id: `demo-task-seed-${i + 1}`,
      name: d.name,
      request: d.request,
      status: i < 2 ? 'running' : 'queued',
      slot: i < 2 ? i : null,
      revision: i < 2 ? 1 : 0,
      runId: i < 2 ? `demo-run-FAKE-seed-${i + 1}` : null,
      seedIndex: i + 1,
      sourceMessageId: SEED_SOURCE_MESSAGE_ID,
    })
  );
  // 文献复现（已连接第二项目）：占用该项目自己的 W1，第二个任务排队
  tasks.push(
    makeSeedTask({
      id: 'demo-task-seed-lit-1',
      name: '复现 RAG 检索基准实验',
      request: '按论文设置复现 RAG 检索基准实验并记录指标差异（文献复现项目，演示数据）',
      status: 'running',
      slot: 0,
      revision: 1,
      runId: 'demo-run-FAKE-seed-lit-1',
      seedIndex: 7,
      sourceMessageId: SEED_SOURCE_MESSAGE_ID,
      projectId: 'p-literature',
    }),
    makeSeedTask({
      id: 'demo-task-seed-lit-2',
      name: '复现长上下文注意力消融',
      request: '复现长上下文注意力消融实验并核对结论（文献复现项目，演示数据）',
      status: 'queued',
      slot: null,
      revision: 0,
      runId: null,
      seedIndex: 8,
      sourceMessageId: SEED_SOURCE_MESSAGE_ID,
      projectId: 'p-literature',
    }),
    makeSeedTask({
      id: 'demo-task-seed-arc-1',
      name: '归档：2024 云原生综述整理',
      request: '已归档的历史整理任务（归档项目未连接，仅作展示，不会调度）',
      status: 'ended',
      slot: null,
      revision: 0,
      runId: null,
      seedIndex: 9,
      sourceMessageId: SEED_SOURCE_MESSAGE_ID,
      projectId: 'p-archive',
      decision: 'discard',
    })
  );
  return {
    tasks,
    projects: clone(PROJECT_DEFS),
    incidents: [],
    lastRecovery: null,
    events: [
      { id: 'e-seed-1', text: '演示初始化：载入 6 个中文调研任务（模拟数据，非真实运行时）', at: nowIso() },
      { id: 'e-seed-2', text: 'W1/W2 已分配给前两个任务，其余 4 个进入 FIFO 队列', at: nowIso() },
      { id: 'e-seed-3', text: '演示项目：研究工作台（当前）· 文献复现（已连接，独立 2 槽）· 归档项目（未连接，不调度）', at: nowIso() },
    ],
    messages: [
      { id: 'm-seed-1', role: 'user', text: '帮我同时推进这几个调研任务，忙不过来的先排队。', taskId: null },
      { id: 'm-seed-2', role: 'assistant', text: '好的，我已并行启动前两个任务，其余任务将按队列顺序自动调度；你可以随时暂停、停止或补充新任务。', taskId: null },
    ],
    orchestrator: 'idle',
    epoch: 1,
  };
}

// --- persistence ----------------------------------------------------------

function persist(storage, state) {
  let json;
  try {
    json = JSON.stringify(state);
  } catch (err) {
    throw new Error(`[multitask-demo] persist failed: state is not serializable (${err.message})`);
  }
  try {
    storage.setItem(STORAGE_KEY, json);
  } catch (err) {
    throw new Error(`[multitask-demo] persist failed: storage write error (${err && err.message ? err.message : String(err)})`);
  }
}

function loadPersisted(storage) {
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (err) {
    // explicit error: never silently fall back (that would hide/lose state)
    throw new Error(`[multitask-demo] storage read failed (${err && err.message ? err.message : String(err)})`);
  }
  if (!raw) return null; // first visit -> seed (seed is never blocked)
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[multitask-demo] persisted state is corrupted (${err.message}); refusing to silently reset`);
  }
  if (!parsed || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.events) || !Array.isArray(parsed.messages)) {
    throw new Error('[multitask-demo] persisted state has an unexpected shape; refusing to silently reset');
  }
  // optional linkage fields: older persisted states may lack them entirely.
  // Normalize missing to null (explicitly unavailable) — never guess a link.
  for (const t of parsed.tasks) {
    if (typeof t.sourceMessageId !== 'string') t.sourceMessageId = null;
  }
  for (const m of parsed.messages) {
    if (typeof m.taskId !== 'string') m.taskId = null;
  }
  // optional event channel: older persisted events predate it — default
  // 'general'; 'fault' marks automatic fault-recovery steps only
  for (const e of parsed.events) {
    if (e && typeof e === 'object' && e.channel !== 'fault') e.channel = 'general';
  }
  normalizeMultiProject(parsed);
  return parsed;
}

// Old persisted states predate projects/incidents. Migration (never a reset):
//   projects/incidents/lastRecovery missing -> defaults;
//   old tasks default to the CURRENT project (研究工作台);
//   task blockers/scenario default to []/null; the legacy fabricated foreign
//   fault blocker (no longer generated by any scenario) is stripped at load;
//   legacy incident statuses ('active' awaited a repair click, 'fixed' awaited
//   resume confirmation) map to needsuser — blockers stay, nothing auto-
//   executes, the user finishes with ONE clearIncident click;
//   recovering incidents keep their phase/attempts (bounded restart recovery);
//   incident records are invariant-checked (id/kind/status/version) — corrupt
//   records refuse to load instead of silently dropping blockers.
function normalizeMultiProject(parsed) {
  if (!Array.isArray(parsed.projects)) parsed.projects = clone(PROJECT_DEFS);
  if (!Array.isArray(parsed.incidents)) parsed.incidents = [];
  if (parsed.lastRecovery === undefined || parsed.lastRecovery === null) parsed.lastRecovery = null;
  for (const t of parsed.tasks) {
    if (typeof t.projectId !== 'string') t.projectId = CURRENT_PROJECT_ID; // old task -> current project
    if (!Array.isArray(t.blockers)) t.blockers = [];
    // legacy demo artifact: the fabricated foreign "other fault" blocker is
    // no longer created by any scenario — strip it so legacy role-F tasks are
    // not forever discard-blocked by a fault that can never resolve
    t.blockers = t.blockers.filter((b) => !(b && b.type === 'fault' && b.incidentId === FOREIGN_FAULT_INCIDENT_ID));
    if (!t.scenario || typeof t.scenario !== 'object') t.scenario = null;
  }
  for (const inc of parsed.incidents) {
    if (
      !inc ||
      typeof inc !== 'object' ||
      typeof inc.id !== 'string' ||
      !INCIDENT_KINDS[inc.kind] ||
      !['recovering', 'needsuser', 'resolved', 'active', 'fixed'].includes(inc.status) ||
      !Number.isInteger(inc.version) ||
      inc.version < 1 ||
      !Array.isArray(inc.taskIds) ||
      typeof inc.title !== 'string'
    ) {
      throw new Error('[multitask-demo] persisted incident record is corrupted; refusing to silently reset');
    }
    // legacy repair→preview→resume flow is gone: an unresolved legacy incident
    // becomes needsuser (safe: blockers stay, nothing auto-executes; the user
    // finishes it with ONE clearIncident click under the same safe gates)
    if (inc.status === 'active' || inc.status === 'fixed') {
      inc.status = 'needsuser';
      inc.recoveryPhase = null;
    }
    if (inc.mode !== 'transient' && inc.mode !== 'persistent') inc.mode = null;
    if (!inc.counts || typeof inc.counts !== 'object') inc.counts = { impacted: inc.taskIds.length, activeBlocked: 0 };
    if (!Array.isArray(inc.recoveries)) inc.recoveries = [];
    inc.requiresUser = inc.status === 'needsuser'; // derived, never trusted blindly
    // restart/reload retains the phase (bounded: attempts keep counting, the
    // phase machine is never reset, old prompts are never replayed)
    if (!RECOVERY_PHASES.includes(inc.recoveryPhase)) inc.recoveryPhase = inc.status === 'recovering' ? 'diagnose' : null;
    if (!Number.isInteger(inc.attempts) || inc.attempts < 0) inc.attempts = 0;
    if (!Array.isArray(inc.logs)) inc.logs = [];
    inc.failNextClear = inc.failNextClear === true;
    inc.resumePlan = null; // artifact of the removed preview flow
    if (typeof inc.createdAt !== 'string') inc.createdAt = nowIso();
    if (typeof inc.resolvedAt !== 'string') inc.resolvedAt = null;
    if (typeof inc.escalatedAt !== 'string') inc.escalatedAt = null;
  }
  return parsed;
}

// Page-reload restore uses the same semantics as restart(): saved running /
// stopping runs are of unknown viability -> blocked('unknown'), never re-executed.
// Never-executed stages (submitted/orchestrating/queued) are preserved as-is.
function restoreOnLoad(storage, persisted) {
  let changed = false;
  syncOrchestrator(persisted); // persisted indicator reconciled with actual orchestrating work
  for (const t of persisted.tasks) {
    if (t.status === 'running' || t.status === 'stopping') {
      t.status = 'blocked';
      t.blockedReason = 'unknown';
      t.manualPaused = true;
      changed = true;
    }
  }
  if (changed) {
    const list = persisted.tasks.filter((t) => t.blockedReason === 'unknown').map((t) => `「${t.name}」`).join('、');
    persisted.events.push({ id: nextId('e'), text: `页面刷新恢复：运行态未知 → blocked（${list}，不自动重演，待 resolveUnknown）`, at: nowIso() });
    if (persisted.events.length > MAX_EVENTS) persisted.events = persisted.events.slice(-MAX_EVENTS);
  } else {
    persisted.events.push({ id: nextId('e'), text: '页面刷新恢复：状态从持久化快照载入（无运行中任务需要落定）', at: nowIso() });
  }
  // recovering incidents keep their phase across reload (bounded, never
  // reset, never replayed) — surfaced once so the log explains the resume
  const reloading = persisted.incidents.filter((i) => i.status === 'recovering');
  if (reloading.length > 0) {
    persisted.events.push({
      id: nextId('e'),
      text: `页面刷新恢复：${reloading.length} 个事件自愈进度保留（${reloading.map((i) => `「${i.title}」${PHASE_LABELS[i.recoveryPhase] || i.recoveryPhase}阶段`).join('、')}，继续有界推进，不重放旧请求）`,
      at: nowIso(),
      channel: 'fault',
    });
    if (persisted.events.length > MAX_EVENTS) persisted.events = persisted.events.slice(-MAX_EVENTS);
  }
  try {
    persist(storage, persisted);
  } catch (err) {
    throw new Error(`[multitask-demo] restore persist failed (${err.message})`);
  }
  return persisted;
}

// --- report ----------------------------------------------------------------

// Deterministic (no randomness) short Chinese simulated report. complete()
// freezes it on entering review; no later action rewrites it.
function buildReport(task) {
  return [
    `【模拟报告-FAKE】「${task.name}」调研摘要（第 ${task.revision} 版，演示数据，进入复核后冻结）`,
    '已完成动作：',
    '- 检索公开资料并按主题聚类整理（模拟动作，未访问真实数据源）',
    '- 抽取关键结论并交叉核对（模拟核对，演示占位）',
    '示例发现：',
    `- 示例发现 1：「${task.name}」相关方向近一年产出保持活跃（演示占位数据）`,
    '- 示例发现 2：两条主流路线在成本与延迟上存在取舍（演示占位数据）',
    '局限：',
    '- 未连接真实运行时与真实文献库，全部内容为演示占位，不可用于真实决策',
    '- 仅单轮模拟整理，未做多轮人工复核',
    '未完成与风险：',
    '- 引用与数据可追溯性未验证，采纳前需人工补齐',
    '- 长尾场景覆盖不足，存在遗漏风险',
    '采纳效果（accept 后）：',
    '- 报告与候选结果归档、工作区清理、占用槽位释放；弃用（discard）则丢弃产出',
  ].join('\n');
}

// --- factory --------------------------------------------------------------

export function createDemo({ storage = globalThis.localStorage } = {}) {
  let state;
  try {
    const persisted = loadPersisted(storage);
    state = persisted ? restoreOnLoad(storage, persisted) : seedState();
  } catch (err) {
    // surface storage failures explicitly; UI must show the error, not fall back
    throw err instanceof Error ? err : new Error(`[multitask-demo] init failed (${String(err)})`);
  }
  const listeners = new Set();

  function notify() {
    const snapshot = clone(state);
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch (err) {
        // listener errors must not break the engine; surface to console only
        console.error('[multitask-demo] subscriber error', err);
      }
    }
  }

  function commit(draft) {
    // transaction: persist first, then commit + notify; on persist failure the
    // in-memory state stays untouched and a readable error is thrown.
    persist(storage, draft);
    state = draft;
    notify();
  }

  // transient explicit routing signal (resume / closure retry); the next tick
  // reconciles it with actual orchestrating work via syncOrchestrator()
  function routing(draft) {
    draft.orchestrator = 'routing';
  }

  // --- action handlers (mutate draft; return true if changed) ---

  const actions = {
    add(draft, { text }) {
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('[multitask-demo] add requires a non-empty string payload { text }');
      }
      const request = text.trim();
      const id = newTaskId();
      // atomic link: this transaction creates the real user message and the
      // task, cross-linked by id (message.taskId <-> task.sourceMessageId)
      const message = pushMessage(draft, 'user', request, id);
      draft.tasks.push(
        makeSeedTask({ id, name: request.length > 24 ? `${request.slice(0, 24)}…` : request, request, status: 'submitted', slot: null, revision: 0, runId: null, seedIndex: draft.tasks.length + 1, sourceMessageId: message.id })
      );
      // submitted waits for orchestrator pickup — no slot, indicator stays as-is
      pushEvent(draft, `新任务提交：「${request}」（${id}，来源消息 ${message.id}）`);
      return true;
    },

    batch(draft, { count }) {
      if (count !== 10 && count !== 100) {
        throw new Error('[multitask-demo] batch requires payload { count: 10 | 100 }');
      }
      const base = draft.tasks.length;
      for (let i = 0; i < count; i += 1) {
        const n = base + i + 1;
        const request = `批量模拟调研任务 #${n}（模拟数据）`;
        draft.tasks.push(
          makeSeedTask({ id: newTaskId(), name: request, request, status: 'submitted', slot: null, revision: 0, runId: null, seedIndex: n })
        );
      }
      pushEvent(draft, `批量提交 ${count} 个模拟任务（无逐条对话来源，回退冻结 request 原文；单次事务持久化）`);
      return true; // one persist + one emit for the whole batch
    },

    pause(draft, { id }) {
      const task = findTask(draft, id);
      if (task.status === 'running') {
        if (task.manualPaused) return false; // idempotent
        task.manualPaused = true; // current run continues, status stays running
        pushEvent(draft, `请求暂停：「${task.name}」当前运行继续，运行结束后停驻`);
        return true;
      }
      if (task.status === 'queued') {
        if (task.manualPaused) return false;
        task.manualPaused = true; // holds queue position, never a slot
        pushEvent(draft, `队列暂停：「${task.name}」保留排队位置，暂不参与调度`);
        return true;
      }
      if (task.status === 'submitted') {
        if (task.manualPaused) return false;
        task.manualPaused = true; // freezes at 提交 stage, never a slot
        pushEvent(draft, `提交暂停：「${task.name}」暂缓编排受理（无槽位占用）`);
        return true;
      }
      if (task.status === 'orchestrating') {
        if (task.manualPaused) return false;
        task.manualPaused = true; // freezes at 编排 stage, never a slot
        pushEvent(draft, `编排暂停：「${task.name}」暂缓进入排队（无槽位占用）`);
        return true;
      }
      if (task.status === 'review') {
        if (task.manualPaused) return false;
        task.manualPaused = true; // stays in review, slot held, decision still pending
        pushEvent(draft, `复核暂停：「${task.name}」标记暂停（保持复核状态，槽位保留）`);
        return true;
      }
      if (task.status === 'paused') return false; // idempotent
      requireStatus(task, 'pause', ['submitted', 'orchestrating', 'running', 'queued', 'paused', 'review']);
      return false;
    },

    stop(draft, { id }) {
      const task = findTask(draft, id);
      if (task.status === 'running') {
        task.status = 'stopping';
        task.manualPaused = true;
        pushEvent(draft, `请求停止：「${task.name}」进入 stopping，等待 tick 落定`);
        return true;
      }
      if (task.status === 'stopping') return false; // idempotent
      if (task.status === 'paused') return false; // already stopped and held
      requireStatus(task, 'stop', ['running', 'stopping', 'paused']);
      return false;
    },

    resume(draft, { id }) {
      const task = findTask(draft, id);
      if (task.status === 'running') {
        if (!task.manualPaused) return false;
        task.manualPaused = false;
        pushEvent(draft, `恢复后续调度：「${task.name}」当前 run 保持不变`);
        return true;
      }
      if (task.status === 'submitted') {
        if (!task.manualPaused) return false;
        task.manualPaused = false; // intake advances again on the next tick
        pushEvent(draft, `恢复提交：「${task.name}」将继续进入编排`);
        return true;
      }
      if (task.status === 'orchestrating') {
        if (!task.manualPaused) return false;
        task.manualPaused = false; // re-enters the orchestrating → queued step
        pushEvent(draft, `恢复编排：「${task.name}」将继续进入排队`);
        routing(draft); // actual orchestrating resumes (transient, tick reconciles)
        return true;
      }
      if (task.status === 'paused') {
        // safe explicit resume: same work (worktree/sourceId kept), NEW run
        task.status = 'running';
        task.manualPaused = false;
        task.revision += 1;
        task.runId = newRunId(draft.epoch); // slot already held, keep it
        pushEvent(draft, `恢复运行：「${task.name}」同工作区新 run ${task.runId}（${slotLabel(task.slot)} 保留）`);
        routing(draft);
        return true;
      }
      if (task.status === 'queued') {
        if (!task.manualPaused) return false;
        task.manualPaused = false; // re-enters FIFO; scheduling happens on tick
        pushEvent(draft, `恢复排队：「${task.name}」重新参与 FIFO 调度`);
        routing(draft);
        return true;
      }
      if (task.status === 'review') {
        // slots stay held through review until ended (no early release);
        // resume on review only clears a stale pause flag — no new run
        if (!task.manualPaused) return false;
        task.manualPaused = false;
        pushEvent(draft, `复核继续：「${task.name}」保持复核状态（槽位保留，等待 accept/discard）`);
        return true;
      }
      if (task.status === 'blocked') {
        if (task.blockedReason === 'closure') {
          // retry closure, preserving decision + closureStep
          task.status = 'closing';
          pushEvent(draft, `重试收尾：「${task.name}」从第 ${task.closureStep}/3 步继续（裁决 ${task.decision}）`);
          routing(draft);
          return true;
        }
        throw new Error(
          `[multitask-demo] task "${task.name}" is blocked with unknown restored state; call resolveUnknown({ id }) first`
        );
      }
      requireStatus(task, 'resume', ['submitted', 'orchestrating', 'paused', 'queued', 'review', 'blocked']);
      return false;
    },

    complete(draft, { id }) {
      const task = findTask(draft, id);
      if (task.status === 'review') return false; // idempotent
      requireStatus(task, 'complete', ['running', 'review']);
      task.status = 'review';
      task.report = buildReport(task); // deterministic; frozen from here on
      task.candidate = `demo-candidate-FAKE-r${task.revision}-${Math.random().toString(36).slice(2, 8)}`;
      pushMessage(draft, 'assistant', task.report, task.id);
      pushEvent(draft, `运行完成：「${task.name}」进入人工复核（报告已冻结，${slotLabel(task.slot)} 仍占用）`);
      return true;
    },

    accept(draft, { id }) {
      const task = findTask(draft, id);
      if (task.status === 'closing' && task.decision === 'accept') return false;
      requireStatus(task, 'accept', ['review', 'closing']);
      task.status = 'closing';
      task.decision = 'accept';
      task.closureStep = 0;
      pushEvent(draft, `采纳：「${task.name}」开始收尾（archive → cleanup → complete）`);
      return true;
    },

    discard(draft, { id }) {
      const task = findTask(draft, id);
      if (task.status === 'closing' && task.decision === 'discard') return false;
      if (task.status === 'blocked' && task.blockedReason === 'unknown') {
        // engine gate: a restored run of unknown viability must be resolved
        // explicitly first; the slot stays retained either way
        throw new Error(
          `[multitask-demo] cannot discard task "${task.name}" while its restored run state is unknown; call resolveUnknown({ id }) first (slot retained)`
        );
      }
      // a fault-blocked task is never deleted as a "fault action": discard
      // stays available only after the incident is cleared, or once there is
      // stop evidence (stopping, or paused with the run already cleared)
      if (hasFaultBlockers(task) && task.status !== 'stopping' && !(task.status === 'paused' && task.runId === null)) {
        throw new Error(
          `[multitask-demo] cannot discard task "${task.name}" while it is blocked by an unresolved simulated fault; clear the incident (clearIncident) or stop the task first`
        );
      }
      requireStatus(task, 'discard', ['submitted', 'orchestrating', 'queued', 'running', 'paused', 'stopping', 'review', 'closing', 'blocked']);
      if (task.status !== 'review' && task.status !== 'closing') {
        // cancellation path: discard a task that never reached review
        task.runId = null; // never re-execute a cancelled run
        task.report = null;
        task.manualPaused = true;
      }
      task.status = 'closing';
      task.decision = 'discard';
      task.closureStep = 0;
      task.blockedReason = null;
      pushEvent(draft, `弃用：「${task.name}」开始收尾并丢弃产出（archive → cleanup → complete）`);
      return true;
    },

    failClosure(draft, { id }) {
      const task = findTask(draft, id);
      requireStatus(task, 'failClosure', ['closing']);
      task.status = 'blocked';
      task.blockedReason = 'closure'; // decision + closureStep retained for retry
      pushEvent(draft, `收尾失败：「${task.name}」在第 ${task.closureStep}/3 步阻塞（槽位保留）`);
      return true;
    },

    resolveUnknown(draft, { id }) {
      const task = findTask(draft, id);
      if (task.status === 'paused' && task.blockedReason === null) return false;
      requireStatus(task, 'resolveUnknown', ['blocked']);
      if (task.blockedReason !== 'unknown') {
        throw new Error(`[multitask-demo] task "${task.name}" is blocked by closure failure; call resume({ id }) to retry`);
      }
      // explicit resolution: land in paused, slot held, frozen run NOT re-executed
      task.status = 'paused';
      task.manualPaused = true;
      task.blockedReason = null;
      pushEvent(draft, `处置未知状态：「${task.name}」落定为 paused（run 冻结不重放，等待人工 resume）`);
      return true;
    },

    tick(draft) {
      let changed = false;
      // 1) intake advances at most ONE step per task per tick, judged against
      //    the tick-start snapshot (no same-tick cascading submitted → queued);
      //    manualPaused freezes a task at its current stage
      const snapshot = draft.tasks.map((t) => t.status);
      const toQueue = [];
      const toOrchestrating = [];
      draft.tasks.forEach((t, i) => {
        if (t.manualPaused) return;
        if (snapshot[i] === 'orchestrating') {
          t.status = 'queued';
          toQueue.push(t);
        } else if (snapshot[i] === 'submitted') {
          t.status = 'orchestrating';
          toOrchestrating.push(t);
        }
      });
      if (toQueue.length > 0) {
        pushEvent(draft, `编排完成：${toQueue.length} 个任务进入排队，等待空闲工作槽`);
        changed = true;
      }
      if (toOrchestrating.length > 0) {
        pushEvent(draft, `开始编排：${toOrchestrating.length} 个任务`);
        changed = true;
      }
      // 2) stopping tasks land: paused, slot held, run cleared
      for (const t of draft.tasks) {
        if (t.status === 'stopping') {
          t.status = 'paused';
          t.runId = null;
          pushEvent(draft, `停止落定：「${t.name}」已暂停（${slotLabel(t.slot)} 保留，run 已清除）`);
          changed = true;
        }
      }
      // 3) closing tasks advance one closure phase per tick
      for (const t of draft.tasks) {
        if (t.status !== 'closing') continue;
        t.closureStep += 1;
        const phases = { 1: '归档 archive', 2: '清理 cleanup', 3: '完结 complete' };
        if (t.closureStep >= 3) {
          t.status = 'ended';
          pushEvent(draft, `收尾完成（${phases[3]}）：「${t.name}」结束，释放 ${slotLabel(t.slot)}`);
          t.slot = null;
          t.runId = null;
        } else {
          pushEvent(draft, `收尾推进（${phases[t.closureStep]}）：「${t.name}」第 ${t.closureStep}/3 步`);
        }
        changed = true;
      }
      // 4) schedule eligible queued tasks (FIFO) into free slots — including
      //    tasks that just left orchestrating this tick
      const before = draft.tasks.map((t) => t.status);
      scheduleQueued(draft);
      if (draft.tasks.some((t, i) => t.status !== before[i])) changed = true;
      // 5) recovering incidents advance ONE phase per tick (transient walks
      //    diagnose → repair → verify → continue then resolves once and
      //    auto-resumes the safe queued targets; persistent escalates after
      //    its single bounded attempt). Runs AFTER scheduling so tasks
      //    resumed here admit on the NEXT tick (no same-tick cascade).
      if (advanceRecovery(draft)) changed = true;
      // 6) orchestrator indicator follows actual work: orchestrating tasks or
      //    auto-recovering incidents (reconciles transient explicit routing)
      const indicatorBefore = draft.orchestrator;
      syncOrchestrator(draft);
      if (draft.orchestrator !== indicatorBefore) changed = true;
      return changed;
    },

    // --- simulated cross-project incidents (SIMULATION ONLY) -----------------

    injectIncident(draft, { kind, mode }) {
      const def = INCIDENT_KINDS[kind];
      if (!def) {
        throw new Error(`[multitask-demo] injectIncident requires payload { kind: 'network' | 'balance' } (got ${String(kind)})`);
      }
      let resolvedMode = null;
      if (kind === 'network') {
        if (mode !== undefined && !['transient', 'persistent'].includes(mode)) {
          throw new Error(`[multitask-demo] injectIncident { kind: 'network' } takes { mode: 'transient' | 'persistent' } (got ${String(mode)}; default 'transient')`);
        }
        resolvedMode = mode === undefined ? 'transient' : mode;
      } else if (mode !== undefined) {
        throw new Error("[multitask-demo] injectIncident { kind: 'balance' } takes no mode — 配额耗尽立即需人工处理（needsuser）");
      }
      // dedup: a same-kind fault still in flight (auto-recovering OR already
      // awaiting the user) is a no-op — never stack a second fault of one kind
      const openSameKind = draft.incidents.find((i) => i.kind === kind && i.status !== 'resolved');
      if (openSameKind) return false;
      const seq = draft.incidents.filter((i) => i.kind === kind).length + 1;
      const id = `sim-inc-${kind}-${seq}`;
      const at = nowIso();
      const modeDef = kind === 'network' ? NETWORK_MODES[resolvedMode] : null;
      const title = modeDef ? modeDef.title : def.title;
      const assume = modeDef ? modeDef.assume : def.assume;
      const incidentBlocker = { type: 'fault', incidentId: id, kind, note: `模拟：${def.label}（事件 ${id}）`, at };
      // Deterministic impacted set: ONLY newly created marked 模拟 scenario
      // tasks — safe never-admitted queued targets (slot/run stay null).
      // Existing tasks (incl. running) are never silently mutated; manual
      // pause / unknown / other-fault cases are NOT manufactured per fault.
      const seedBase = draft.tasks.length + 1;
      const taskIds = SIM_ROLE_DEFS.map((roleDef, i) => {
        const taskId = `demo-task-sim-${kind}-${seq}-${roleDef.suffix}`;
        draft.tasks.push(
          makeSeedTask({
            id: taskId,
            name: `模拟${def.label}·${roleDef.label}`,
            request: `模拟任务（场景 ${roleDef.suffix}）：${roleDef.note} — 属「${title}」注入创建，非真实请求`,
            status: 'queued', // never admitted (slot/run stay null)
            slot: null,
            revision: 0,
            runId: null,
            blockers: [incidentBlocker],
            seedIndex: seedBase + i,
            sourceMessageId: null,
            projectId: roleDef.projectId,
            scenario: { incidentId: id, role: roleDef.role },
          })
        );
        return taskId;
      });
      const autoRecovering = kind === 'network'; // balance escalates immediately
      const incident = {
        id,
        kind,
        mode: resolvedMode,
        title,
        status: autoRecovering ? 'recovering' : 'needsuser',
        version: 1,
        scope: { projectIds: [...new Set(SIM_ROLE_DEFS.map((r) => r.projectId))], label: '跨项目聚合影响（模拟）' },
        taskIds,
        counts: { impacted: taskIds.length, activeBlocked: 0 },
        createdAt: at,
        resolvedAt: null,
        escalatedAt: autoRecovering ? null : at,
        assume,
        recoveryPhase: autoRecovering ? 'diagnose' : null,
        requiresUser: !autoRecovering,
        attempts: autoRecovering ? 1 : 0,
        logs: [],
        recoveries: [],
        failNextClear: false,
      };
      incident.counts.activeBlocked = countRelevantBlocked(draft, id); // 3 by construction
      draft.incidents.push(incident);
      if (autoRecovering) {
        incident.logs.push({
          at,
          phase: 'diagnose',
          text: `注入后自动恢复启动（${resolvedMode === 'transient' ? '瞬断预计可自愈' : '持续故障，仅一次有界修复尝试'}）：阶段 diagnose`,
        });
        pushEvent(
          draft,
          `注入模拟事件：「${title}」（${id}，${assume}）；受影响 ${taskIds.length} 个安全排队目标（研究工作台 2 + 文献复现 1，均为新增标记「模拟」任务），自动恢复推进中（diagnose → repair → verify → continue，每 tick 一步，无需人工处理）；既有任务不受影响`
        );
      } else {
        incident.logs.push({ at, phase: 'escalated', text: '配额耗尽无法自动恢复：立即需人工处理（补足后一键解除）' });
        pushEvent(
          draft,
          `注入模拟事件：「${title}」（${id}，${assume}）；受影响 ${taskIds.length} 个安全排队目标（均为新增标记「模拟」任务），无法自动恢复 → 需人工处理（顶部故障条可见，一键解除后自动恢复安全任务）；既有任务不受影响`
        );
      }
      syncOrchestrator(draft); // routing immediately: the engine starts working the fault
      return true;
    },

    // ONE-CLICK 故障解除 (explicit user intent): verify scope, then internally
    // batch-resume the safe targets — no preview step, no repair click.
    clearIncident(draft, { id, requestKey, injectScenario }) {
      const incident = findIncident(draft, id);
      if (typeof requestKey !== 'string' || !requestKey.trim()) {
        throw new Error('[multitask-demo] clearIncident requires payload { requestKey: non-empty string } (one-click idempotency key)');
      }
      const key = requestKey.trim();
      if (injectScenario !== undefined && injectScenario !== 'failNext') {
        throw new Error(`[multitask-demo] clearIncident payload { injectScenario } only accepts 'failNext' (got ${String(injectScenario)})`);
      }
      const wantsRefail = injectScenario === 'failNext';
      // duplicate request key: SAME intent replays with no effects; a key
      // reused with a DIFFERENT intent is refused (never double-apply)
      const prior = incident.recoveries.find((r) => r.requestKey === key);
      if (prior) {
        if ((prior.outcome === 'refailed') !== wantsRefail) {
          throw new Error(`[multitask-demo] requestKey "${key}" was already used with a different intent; use a new requestKey`);
        }
        return false; // replay: no effects, state untouched
      }
      if (incident.status === 'resolved') {
        throw new Error(`[multitask-demo] incident «${incident.title}» is already resolved; nothing to clear`);
      }
      if (incident.status === 'recovering') {
        throw new Error(`[multitask-demo] incident «${incident.title}» is auto-recovering (phase ${incident.recoveryPhase}); no user action needed`);
      }
      // status === 'needsuser'. Simulated refailure (armed via injectScenario
      // or an earlier simulateRefailure) makes THIS clear fail once — the SAME
      // incident re-escalates; the flag is consumed so it can never loop.
      if (wantsRefail || incident.failNextClear) {
        incident.failNextClear = false;
        incident.attempts += 1;
        incident.version += 1;
        incident.escalatedAt = nowIso();
        incident.recoveries.push({ requestKey: key, taskIds: [], at: nowIso(), outcome: 'refailed' });
        incident.logs.push({
          at: nowIso(),
          phase: 'escalated',
          text: `故障解除尝试失败：故障复发（模拟注入），同一事件再次升级需人工处理（第 ${incident.attempts} 次尝试；再次点击即可收口）`,
        });
        draft.lastRecovery = {
          incidentId: incident.id,
          requestKey: key,
          at: nowIso(),
          outcome: 'refailed',
          taskIds: [],
          counts: { selected: 0, resumed: 0, skipped: 0 },
          results: [],
        };
        pushEvent(
          draft,
          `故障解除失败（模拟复发）：「${incident.title}」本次解除未成功，同一事件再次升级需人工处理（requestKey ${key}；再次点击「故障解除」即可收口，不会无限循环）`
        );
        return true;
      }
      incident.recoveries.push({ requestKey: key, taskIds: [...incident.taskIds], at: nowIso(), outcome: 'cleared' });
      resolveIncident(draft, incident, { source: 'user', requestKey: key });
      return true;
    },

    // Arm the demo "fault recurs" flag on a needsuser incident: the NEXT
    // clearIncident fails once and re-escalates the SAME incident.
    simulateRefailure(draft, { id }) {
      const incident = findIncident(draft, id);
      if (incident.status !== 'needsuser') {
        throw new Error(
          `[multitask-demo] simulateRefailure requires an unresolved incident awaiting the user (status needsuser); «${incident.title}» is "${incident.status}"`
        );
      }
      if (incident.failNextClear) return false; // idempotent arming
      incident.failNextClear = true;
      incident.logs.push({ at: nowIso(), phase: 'armed', text: '已装填模拟复发：下一次「故障解除」将失败一次并再次升级（仅一次）' });
      pushEvent(draft, `装填模拟复发：「${incident.title}」下一次故障解除将失败一次并再次升级同一事件（不自动重试，需再次人工解除）`);
      return true;
    },

    restart(draft) {
      draft.epoch += 1;
      pushEvent(draft, `会话重启：epoch → ${draft.epoch}，开始恢复任务状态（模拟）`);
      for (const t of draft.tasks) {
        if (t.status === 'running' || t.status === 'stopping') {
          // restored run state unknown -> blocked, slot retained, must resolveUnknown
          t.status = 'blocked';
          t.blockedReason = 'unknown';
          t.manualPaused = true;
          pushEvent(draft, `恢复未知：「${t.name}」运行态未知 → blocked（${slotLabel(t.slot)} 保留，待 resolveUnknown）`);
        } else if (t.status === 'paused') {
          t.manualPaused = true; // hold retained (slot kept, run stays cleared)
          pushEvent(draft, `恢复保留：「${t.name}」维持 paused（${slotLabel(t.slot)} 保留）`);
        } else if (t.status === 'closing') {
          pushEvent(draft, `恢复继续：「${t.name}」收尾从第 ${t.closureStep}/3 步继续`);
        }
        // ended stays ended; pre-work stages (submitted/orchestrating/queued)
        // are preserved as-is — never executed, nothing to resolve
      }
      // incident recovery state survives restarts: recovering incidents keep
      // their phase (bounded attempts, never reset, old requests never
      // replayed); needsuser incidents keep waiting for the user's one click
      for (const inc of draft.incidents.filter((i) => i.status === 'recovering')) {
        pushEvent(draft, `重启保留自愈进度：「${inc.title}」继续${PHASE_LABELS[inc.recoveryPhase] || inc.recoveryPhase}阶段（第 ${inc.attempts} 次尝试，不重放旧请求）`, 'fault');
      }
      const awaitingUser = draft.incidents.filter((i) => i.status === 'needsuser').length;
      if (awaitingUser > 0) {
        pushEvent(draft, `重启保留待人工故障：${awaitingUser} 个事件仍需一键故障解除（解除后自动恢复安全排队任务）`);
      }
      syncOrchestrator(draft); // 'routing' iff orchestrating tasks or recovering incidents survived
      scheduleQueued(draft); // eligible queued tasks scheduled only into free slots
      return true;
    },

  };

  function dispatch(action, payload = {}) {
    const knownActions = [...Object.keys(actions), 'reset'];
    if (typeof action !== 'string' || !knownActions.includes(action)) {
      throw new Error(`[multitask-demo] unknown action: ${String(action)} (expected ${knownActions.join('/')})`);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('[multitask-demo] payload must be a plain object');
    }
    const draft = clone(state);
    if (action === 'reset') {
      const fresh = seedState();
      persist(storage, fresh); // transaction: persist then notify
      state = fresh;
      notify();
      return getState();
    }
    const result = actions[action](draft, payload);
    if (result === true) {
      commit(draft);
    }
    // no-op (idempotent duplicate): state unchanged, no persist, no notify
    return getState();
  }

  function getState() {
    return clone(state);
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') throw new Error('[multitask-demo] subscribe requires a function');
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { getState, subscribe, dispatch };
}

export const DEMO_STORAGE_KEY = STORAGE_KEY;
