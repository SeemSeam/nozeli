import { createDemo, demoNeedsTick, demoOpenIncidents, demoIncidentLogs, demoProjectSlots, demoTaskActions } from './engine.mjs';

let engine;
try {
  engine = createDemo();
} catch (error) {
  const notice = document.createElement('p');
  notice.className = 'detail-status';
  notice.setAttribute('role', 'alert');
  notice.textContent = `演示无法读取本地状态：${error.message}。请检查浏览器站点存储权限；损坏的演示数据不会被自动覆盖。`;
  document.querySelector('.topbar').after(notice);
  for (const control of document.querySelectorAll('button, textarea')) control.disabled = true;
  throw error;
}
window.multitaskDemo = engine;
const $ = (id) => document.getElementById(id);
const statusNames = { submitted: '提交', orchestrating: '编排', queued: '排队', running: '工作', paused: '暂停', stopping: '停止中', review: '待审', closing: '收尾', blocked: '故障', ended: '已结束' };
const projectNames = { 'p-research': '研究工作台', 'p-literature': '文献复现', 'p-archive': '归档项目' };
let state = engine.getState();
const uiKey = 'demoUI';
let ui = { category: 'all', search: '', searchOpen: false, historyOpen: false, recentTask: null, manual: false, listScroll: {}, scroll: {} };
try {
  const saved = JSON.parse(localStorage.getItem(uiKey) || 'null');
  if (saved && typeof saved === 'object') {
    if (['all', 'submitted', 'orchestrating', 'queued', 'working', 'review', 'blocked', 'closing', 'ended'].includes(saved.category)) ui.category = saved.category;
    if (typeof saved.search === 'string') ui.search = saved.search;
    ui.searchOpen = saved.searchOpen === true || Boolean(ui.search);
    ui.historyOpen = saved.historyOpen === true;
    if (typeof saved.recentTask === 'string') ui.recentTask = saved.recentTask;
    ui.manual = saved.manual === true;
    for (const key of ['listScroll', 'scroll']) {
      if (saved[key] && typeof saved[key] === 'object') ui[key] = Object.fromEntries(Object.entries(saved[key]).filter(([, value]) => Number.isFinite(value) && value >= 0));
    }
  }
} catch (error) { announce(`界面位置无法恢复：${error.message}`); }
let selectedId = ui.recentTask;
function saveUI() {
  try { localStorage.setItem(uiKey, JSON.stringify(ui)); }
  catch (error) { announce(`界面位置未保存：${error.message}`); }
}
function listKey() { return `${ui.category}:${ui.search}`; }
function syncNavigation() {
  $('task-search').value = ui.search;
  $('clear-search').hidden = !ui.search;
  $('search-controls').hidden = !ui.searchOpen;
  $('search-toggle').setAttribute('aria-expanded', String(ui.searchOpen));
  const recent = taskById(ui.recentTask);
  $('recent-task').hidden = !recent;
  $('recent-task').textContent = recent ? `最近查看：${recent.name}` : '';
  $('manual-mode').checked = ui.manual;
  $('next-step').disabled = !ui.manual || !canAdvance();
  $('next-step').title = !ui.manual ? '开启手动推进后使用' : canAdvance() ? '推进一次提交、恢复或收尾步骤' : '暂无可推进步骤；工作需先模拟完成并审阅';
}
function canAdvance() {
  return demoNeedsTick(state);
}
function changeView(search, category = ui.category) {
  ui.listScroll[listKey()] = $('task-list').scrollTop;
  ui.search = search;
  ui.category = category;
  if (category === 'ended') { ui.historyOpen = true; groups.get('ended').group.open = true; }
  renderTasks();
  syncNavigation();
  $('task-list').scrollTop = ui.listScroll[listKey()] || 0;
  saveUI();
}
let confirmAction = null;
let restoreFocus = null;
const rows = new Map();
const messageRows = new Map();
let selectedIncidentId = null;
const pendingClear = new Set();
const userAttemptKeys = new Set();
let alertSignature = '', todoSignature = '', resultSignature = '';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function label(task) {
  if (task.status !== 'ended' && task.blockers?.length) return task.blockers.some(blocker => state.incidents.find(incident => incident.id === blocker.incidentId)?.status === 'recovering') ? '恢复中' : '等待服务';
  if (task.status === 'queued' && task.manualPaused) return '暂停排队';
  if (task.status === 'running' && task.manualPaused) return '进行中 · 已暂停后续';
  if (task.status === 'blocked') return task.blockedReason === 'closure' ? '收尾受阻' : '运行未知';
  if (task.status !== 'ended' && state.projects.find(project => project.id === task.projectId)?.connected === false) return '项目未连接';
  if (task.status === 'closing') return `收尾 ${task.closureStep}/3`;
  return statusNames[task.status] + (task.manualPaused && task.status === 'review' ? ' · 暂停' : '');
}
function taskById(id) { return state.tasks.find((task) => task.id === id); }
function announce(text) { $('announcement').textContent = text; }
function dispatch(action, payload = {}) {
  try { return engine.dispatch(action, payload); }
  catch (error) { announce(error.message); window.alert(`演示操作未执行：${error.message}`); return null; }
}
function button(text, action, className) {
  const result = node('button', className, text);
  result.type = 'button';
  result.addEventListener('click', action);
  return result;
}
function affectedTasks(incident) { return (incident.taskIds || []).map(taskById).filter(Boolean); }
function incidentTitle(incident) { return incident.kind === 'network' ? '连接服务失败' : '额度不足'; }
function incidentScope(incident) {
  const tasks = affectedTasks(incident).filter(task => task.status !== 'ended');
  return `影响 ${new Set(tasks.map(task => task.projectId)).size} 个项目 · ${tasks.length} 项工作`;
}
function recoverySummary(recovery) {
  if (!recovery) return '';
  return recovery.outcome === 'refailed' ? '恢复仍失败，请处理后再试' : `已发起继续 ${recovery.counts?.resumed || 0} 项，${recovery.counts?.skipped || 0} 项保留原状态`;
}
function renderFaultLogs(container, incident = null) {
  const phases = { diagnose: '诊断', repair: '修复', verify: '验证', continue: '继续', resolved: '已恢复', escalated: '需用户处理', armed: '已设为再次失败' };
  const logs = incident ? demoIncidentLogs(incident) : state.incidents.flatMap(entry => demoIncidentLogs(entry).map(log => ({ ...log, title: incidentTitle(entry) }))).slice(-60);
  const scrollTop = container.scrollTop;
  const items = logs.slice().reverse().map(log => {
    const li = node('li', '', `${log.title ? `${log.title} · ` : ''}${log.text}`);
    const time = new Date(log.at);
    const stamp = Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString('zh-CN', { hour12: false });
    li.append(node('span', 'fault-log-meta', [stamp, phases[log.phase] || log.phase].filter(Boolean).join(' · ')));
    return li;
  });
  container.replaceChildren(...(items.length ? items : [node('li', 'quiet', '暂无故障记录')]));
  container.scrollTop = scrollTop;
}
function clearIncident(id, injectScenario = null) {
  if (pendingClear.has(id)) return;
  pendingClear.add(id);
  const requestKey = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  userAttemptKeys.add(requestKey);
  const payload = { id, requestKey }; if (injectScenario) payload.injectScenario = injectScenario;
  try {
    if (dispatch('clearIncident', payload)) { announce(recoverySummary(state.lastRecovery)); if ($('incident-detail').open) openIncident(id); }
  } finally { pendingClear.delete(id); renderAlerts(); }
}
function renderAlerts() {
  const alerts = $('incident-alerts');
  const incidents = demoOpenIncidents(state);
  const signature = JSON.stringify(incidents.map(incident => [incident.id, incidentTitle(incident), incidentScope(incident)]));
  if (signature !== alertSignature) {
    alertSignature = signature;
    alerts.replaceChildren();
    for (const incident of incidents) {
      const card = node('article', 'incident-alert'); const copy = node('div', 'incident-copy');
      copy.append(node('h2', '', incidentTitle(incident)), node('p', 'incident-scope', incidentScope(incident)));
      const actions = node('div', 'incident-alert-actions'); actions.append(button('故障解除，继续', () => clearIncident(incident.id), 'primary'), button('详情', () => openIncident(incident.id)));
      card.append(copy, actions); alerts.append(card);
    }
  }
  const recovery = state.lastRecovery;
  const userResult = recovery && userAttemptKeys.has(recovery.requestKey) ? recoverySummary(recovery) : '';
  const resultKey = JSON.stringify([userResult, userResult && recovery.requestKey]);
  if (resultKey !== resultSignature) {
    resultSignature = resultKey;
    $('recovery-result').textContent = userResult;
    if (userResult) $('recovery-result').append(button('收起', () => {
      userAttemptKeys.delete(recovery.requestKey);
      renderAlerts();
    }));
  }
  $('recovery-result').hidden = !userResult;
  $('workspace-notices').hidden = incidents.length === 0 && !userResult;
  renderFaultLogs($('fault-logs'));
}
function renderTodos() {
  const signature = JSON.stringify(state.tasks.filter(task => task.status === 'review' || task.status === 'blocked' && ['unknown', 'closure'].includes(task.blockedReason)).map(task => [task.id, task.name, task.status, task.revision, task.blockedReason]));
  if (signature === todoSignature) return;
  todoSignature = signature;
  const list = $('todo-list'); list.replaceChildren(); let count = 0;
  const decisions = state.tasks.filter(task => task.status === 'blocked' && ['unknown', 'closure'].includes(task.blockedReason));
  for (const task of decisions) { const row = node('div', 'todo-card todo-review'); row.append(node('span', 'todo-title', `${task.name} · ${task.blockedReason === 'unknown' ? '待核对' : '收尾受阻'}`), button('查看/处理', () => openDetail(task.id))); list.append(row); count += 1; }
  for (const task of state.tasks.filter(task => task.status === 'review')) { const row = node('div', 'todo-card todo-review'); row.append(node('span', 'todo-title', task.name), button('审阅', () => openDetail(task.id))); list.append(row); count += 1; }
  $('todo-empty').hidden = count > 0; $('todo-count').textContent = count || '';
}
function openIncident(id) {
  const incident = state.incidents.find(entry => entry.id === id); if (!incident) return;
  selectedIncidentId = id;
  $('incident-title').textContent = `${incidentTitle(incident)} · 模拟`;
  $('incident-status').textContent = `${incident.status === 'needsuser' ? '需要你处理' : incident.status === 'recovering' ? '恢复中' : '已处理'} · ${incidentScope(incident)}`;
  $('incident-tasks').replaceChildren(...affectedTasks(incident).map(task => { const li = node('li', '', task.name); li.append(node('small', '', `${projectNames[task.projectId] || task.projectId} · ${label(task)}`)); return li; }));
  const actions = $('incident-actions');
  if (actions.dataset.status !== incident.status || actions.dataset.incidentId !== id) {
    actions.replaceChildren();
    if (incident.status === 'needsuser') actions.append(button('故障解除，继续', () => clearIncident(id), 'primary'));
    actions.dataset.status = incident.status;
    actions.dataset.incidentId = id;
  }
  $('incident-result').textContent = state.lastRecovery?.incidentId === id ? recoverySummary(state.lastRecovery) : '';
  renderFaultLogs($('incident-logs'), incident); $('incident-fail-again').onclick = () => dispatch('simulateRefailure', { id });
  $('incident-fail-again').disabled = incident.status !== 'needsuser' || incident.failNextClear === true;
  $('incident-fail-again').textContent = incident.failNextClear ? '下次将再次失败' : '再次失败';
  if (!$('incident-detail').open) $('incident-detail').showModal();
}
function actionsFor(task) {
  if (task.status !== 'ended' && task.blockers?.length) return [];
  const actions = []; const allowed = new Set(demoTaskActions(state, task));
  if (allowed.has('pause')) actions.push(['pause', '暂停调度']);
  if (allowed.has('stop')) actions.push(['stop', '停止当前执行…']);
  if (allowed.has('resume')) actions.push(['resume', task.status === 'paused' ? '恢复执行（新运行）' : task.status === 'running' ? '恢复后续调度' : '恢复调度']);
  if (task.status === 'blocked' && task.blockedReason === 'unknown') actions.push(['resolveUnknown', '确认旧运行已停止…']);
  if (task.status === 'blocked' && task.blockedReason === 'closure') actions.push(['resume', '重试收尾']);
  if (allowed.has('complete')) actions.push(['complete', '模拟完成 · 生成报告']);
  if (allowed.has('accept')) actions.push(['accept', '接受报告并收尾']);
  if (allowed.has('discard')) actions.push(['discard', '结束这项工作…']); return actions;
}
function askConfirmation(title, text, proceed, action) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-proceed').textContent = proceed;
  confirmAction = action;
  $('confirmation').showModal();
  $('confirm-cancel').focus();
}
function act(action, id) {
  const task = taskById(id);
  if (!task) return;
  if ($('task-menu').open) $('task-menu').close();
  const captured = { status: task.status, revision: task.revision, runId: task.runId };
  const confirmed = () => {
    const current = engine.getState().tasks.find((entry) => entry.id === id);
    if (!current || Object.entries(captured).some(([key, value]) => current[key] !== value)) {
      announce('工作状态已变化，本次确认已失效。请查看最新状态后重新操作。');
      window.alert('工作状态已变化，本次确认未执行。请重新打开操作。');
      return;
    }
    dispatch(action, { id });
  };
  if (action === 'stop') {
    askConfirmation('停止当前执行？', `「${task.name}」确认停止后暂停，保留工作、来源和槽位。恢复会新建运行，不会结束整项工作。`, '停止当前执行', confirmed);
  } else if (action === 'discard') {
    askConfirmation('结束这项工作？', `「${task.name}」不再继续，候选结果不被接受。收尾完成才释放槽位；这不是临时暂停。`, '结束并放弃候选', confirmed);
  } else if (action === 'resolveUnknown') {
    askConfirmation('处理未知运行', '重启不能证明旧运行已结束。请先核实其已停止；确认后仅转为暂停并保留槽位，仍须明确恢复才新建运行，不自动重放。', '已核实，转为暂停', confirmed);
  } else dispatch(action, { id });
}
function openDetail(id) {
  if (!taskById(id)) { announce('这项工作已不在当前演示中。'); return; }
  if (selectedId !== id) $('detail-records').open = false;
  ui.recentTask = id;
  saveUI();
  syncNavigation();
  for (const [taskId, row] of rows) row.classList.toggle('recent', taskId === id);
  selectedId = id;
  restoreFocus = document.activeElement;
  renderDetail();
  if (!$('task-detail').open) $('task-detail').showModal();
}
function openMenu(id, anchor) {
  restoreFocus = anchor;
  const task = taskById(id);
  $('menu-title').textContent = task.name;
  const container = $('menu-actions');
  container.replaceChildren(button('查看工作详情', () => { $('task-menu').close(); openDetail(id); }));
  for (const [action, text] of actionsFor(task)) container.append(button(text, () => act(action, id), action === 'discard' ? 'danger' : ''));
  $('task-menu').showModal();
  container.firstElementChild.focus();
}
const groupDefinitions = [
  ['submitted', '提交'], ['orchestrating', '编排'], ['queued', '排队'], ['working', '工作'],
  ['review', '待审'], ['blocked', '故障'], ['closing', '收尾'], ['ended', '已结束'],
];
const categoryButtons = new Map();
for (const [key, name] of [['all', '全部'], ...groupDefinitions]) {
  const control = button('', () => { changeView(ui.search, key); control.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, 'work-category');
  control.dataset.category = key;
  control.setAttribute('aria-controls', 'task-list');
  control.append(node('span', '', name), node('small'));
  categoryButtons.set(key, control);
  $('work-categories').append(control);
}
const groups = new Map();
for (const [key, name] of groupDefinitions) {
  const group = node(key === 'ended' ? 'details' : 'section', 'task-group');
  group.dataset.group = key;
  const heading = node(key === 'ended' ? 'summary' : 'h3', 'group-heading');
  const count = node('small');
  heading.append(node('span', '', name), count);
  const list = node('div', 'group-list');
  group.append(heading, list);
  if (key === 'ended') {
    group.open = ui.historyOpen;
    group.addEventListener('toggle', () => { ui.historyOpen = group.open; saveUI(); });
  }
  groups.set(key, { group, list, count });
  $('task-list').append(group);
}
function renderTasks() {
  const ids = new Set(state.tasks.map((task) => task.id));
  for (const [id, row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
  const counts = new Map(groupDefinitions.map(([key]) => [key, 0]));
  const positions = new Map(groupDefinitions.map(([key]) => [key, 0]));
  const query = ui.search.trim().toLocaleLowerCase();
  let visible = 0;
  for (const task of state.tasks) {
    let row = rows.get(task.id);
    if (!row) {
      row = node('div', 'task-row');
      const open = button('', () => openDetail(task.id), 'task-open');
      open.append(node('span', 'task-name'));
      const badge = node('span', 'task-state');
      const slot = button('', () => openDetail(task.id), 'task-slot');
      const more = button('⋯', () => openMenu(task.id, more), 'task-more');
      more.setAttribute('aria-haspopup', 'dialog');
      row.append(open, badge, slot, more);
      row.addEventListener('contextmenu', (event) => { event.preventDefault(); openMenu(task.id, more); });
      row.addEventListener('keydown', (event) => {
        if (event.key === 'F10' && event.shiftKey) { event.preventDefault(); openMenu(task.id, more); }
      });
      rows.set(task.id, row);
    }
    const projectOffline = state.projects.find(project => project.id === task.projectId)?.connected === false;
    const key = task.status !== 'ended' && (task.blockers?.length || projectOffline) ? 'blocked' : ['running', 'paused', 'stopping'].includes(task.status) ? 'working' : task.status;
    const { list } = groups.get(key);
    const position = positions.get(key);
    if (list.children[position] !== row) list.insertBefore(row, list.children[position] || null);
    positions.set(key, position + 1);
    row.dataset.status = task.status;
    row.dataset.taskId = task.id;
    row.querySelector('.task-name').textContent = task.name;
    const badge = row.querySelector('.task-state');
    badge.textContent = task.status !== 'ended' && task.blockers?.length ? label(task) : task.status === 'stopping' ? '停止中' : !['blocked', 'closing', 'ended'].includes(task.status) && (task.status === 'paused' || task.manualPaused) ? '暂停' : '';
    badge.hidden = !badge.textContent;
    const slot = row.querySelector('.task-slot');
    slot.hidden = task.slot === null;
    slot.textContent = task.slot === null ? '' : `W${task.slot + 1}`;
    slot.setAttribute('aria-label', `${slot.textContent}，${task.name}，查看详情`);
    row.querySelector('.task-open').title = task.name;
    row.querySelector('.task-project')?.remove();
    if (task.projectId && task.projectId !== 'p-research') row.querySelector('.task-open').append(node('span', 'task-project', projectNames[task.projectId] || task.projectId));
    row.querySelector('.task-open').setAttribute('aria-label', `${task.name}，${label(task)}，查看详情`);
    row.querySelector('.task-more').setAttribute('aria-label', `${task.name}：更多操作`);
    const matchesSearch = query === '' || `${task.name} ${task.id}`.toLocaleLowerCase().includes(query);
    if (matchesSearch) counts.set(key, counts.get(key) + 1);
    row.hidden = !matchesSearch || (ui.category !== 'all' && ui.category !== key);
    row.classList.toggle('recent', task.id === ui.recentTask);
    if (!row.hidden) visible++;
  }
  for (const [key, { group, count }] of groups) {
    group.hidden = counts.get(key) === 0 || (ui.category !== 'all' && ui.category !== key);
    count.textContent = counts.get(key);
  }
  for (const [key, control] of categoryButtons) {
    const count = key === 'all' ? [...counts.values()].reduce((sum, value) => sum + value, 0) : counts.get(key);
    control.querySelector('small').textContent = count;
    control.setAttribute('aria-pressed', String(ui.category === key));
  }
  $('task-list').classList.toggle('category-selected', ui.category !== 'all');
  $('tasks-empty').hidden = visible > 0;
  $('tasks-empty').textContent = query ? '没有匹配的工作。' : ui.category === 'all' ? '从对话开始一项工作。' : '暂无此类工作。';
  renderTodos();
}
function renderMessages() {
  const conversation = $('conversation');
  const atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 45;
  const ids = new Set(state.messages.map((message) => message.id));
  let added = false;
  for (const [id, row] of messageRows) if (!ids.has(id)) { row.remove(); messageRows.delete(id); }
  for (const message of state.messages) {
    let row = messageRows.get(message.id);
    if (!row) {
      row = node('article', `message ${message.role}`);
      added = true;
      row.tabIndex = -1;
      row.dataset.messageId = message.id;
      row.append(node('span', '', message.role === 'user' ? '你' : '助手 · 模拟'), node('p'));
      messageRows.set(message.id, row);
      $('messages').append(row);
    }
    const linkedTask = message.taskId && taskById(message.taskId);
    const isReport = message.role === 'assistant' && linkedTask?.report === message.text;
    row.querySelector('p').textContent = isReport ? '报告已提交，待审。' : message.text;
    let link = row.querySelector('.message-task');
    if (message.taskId && taskById(message.taskId)) {
      if (!link) { link = button('', () => openDetail(message.taskId), 'message-task'); row.append(link); }
      link.textContent = isReport ? '审阅报告' : `查看工作：${taskById(message.taskId).name}`;
      link.dataset.taskId = message.taskId;
    } else link?.remove();
  }
  if (added && atBottom) conversation.scrollTop = conversation.scrollHeight;
}
function renderEvents(container) {
  const scrollTop = container.scrollTop;
  const fragment = document.createDocumentFragment();
  for (const event of state.events.slice(-60).reverse()) {
    const item = node('li', '', event.text);
    const date = new Date(event.at);
    const time = node('time', '', Number.isNaN(date.getTime()) ? String(event.at) : date.toLocaleTimeString('zh-CN', { hour12: false }));
    time.dateTime = String(event.at);
    item.append(time);
    fragment.append(item);
  }
  container.replaceChildren(fragment);
  container.scrollTop = scrollTop;
}
const metaFields = [['来源', 'sourceId'], ['项目', 'projectId'], ['任务 ID', 'id'], ['修订', 'revision'], ['运行 ID', 'runId'], ['工作目录', 'worktree'], ['候选结果', 'candidate']];
for (const [name, key] of metaFields) {
  const value = node('dd'); value.id = `meta-${key}`;
  $('detail-meta').append(node('dt', '', name), value);
}
const detailButtons = new Map();
for (const action of ['pause', 'stop', 'resume', 'resolveUnknown', 'complete', 'accept', 'failClosure', 'discard']) {
  const control = button('', () => act(action, selectedId), action === 'discard' ? 'danger' : action === 'accept' ? 'primary' : '');
  control.dataset.action = action;
  detailButtons.set(action, control);
  $('detail-actions').append(control);
}
function renderDetail() {
  const task = taskById(selectedId);
  if (!task) { if ($('task-detail').open) $('task-detail').close(); return; }
  $('detail-title').textContent = task.name;
  const guidance = task.blockers?.length ? '原工作与来源保留。由 Orchestrator 恢复；需要你处理的故障显示在工作区顶部。' : task.status === 'blocked' ? (task.blockedReason === 'closure' ? '收尾失败，槽位保留；请重试。' : '旧运行未知，不自动重放；请先核实停止。') : task.status === 'paused' ? '槽位保留，恢复将新建运行。' : task.manualPaused && task.status === 'running' ? '仅暂停后续调度，当前执行未停止。' : '';
  $('detail-status').textContent = [label(task), task.slot === null ? '' : `W${task.slot + 1}`, guidance].filter(Boolean).join(' · ');
  $('detail-request').textContent = task.request;
  const hasSource = messageRows.has(task.sourceMessageId);
  $('source-message').hidden = !hasSource;
  $('original-source').hidden = hasSource;
  $('original-source-text').textContent = task.request;
  for (const [, key] of metaFields) {
    const value = task[key];
    $(`meta-${key}`).textContent = value == null ? '尚无' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }
  $('report-section').hidden = !task.report;
  $('detail-report').textContent = task.report || '';
  $('closure-section').hidden = !['closing', 'ended'].includes(task.status) && task.blockedReason !== 'closure';
  [...$('closure-steps').children].forEach((item, index) => { item.dataset.done = String(task.closureStep > index); });
  const available = new Map(actionsFor(task));
  for (const [action, control] of detailButtons) {
    const hadFocus = document.activeElement === control;
    control.hidden = !available.has(action);
    if (available.has(action)) control.textContent = available.get(action);
    if (hadFocus && control.hidden && $('task-detail').open) $('task-detail').querySelector('[data-close]').focus();
  }
  renderEvents($('detail-events'));
}
function render() {
  state = engine.getState();
  if ($('task-menu').open) $('task-menu').close();
  const currentSlots = demoProjectSlots(state).find((project) => project.id === 'p-research');
  const occupied = currentSlots?.held ?? 0;
  $('work-count').textContent = `${occupied}/2`;
  $('work-count').setAttribute('aria-label', `当前项目已占用 ${occupied} 个工作槽位，共 2 个`);
  renderTasks(); renderMessages(); renderEvents($('events')); syncNavigation(); renderAlerts();
  if ($('task-detail').open) renderDetail();
  if ($('incident-detail').open && selectedIncidentId) openIncident(selectedIncidentId);
  if (state.events.length) { const latest = [...state.events].reverse().find(event => event.channel !== 'fault'); if (latest) announce(latest.text); }
}
const draftKey = 'nozeli-multitask-demo-draft-v1';
try { $('composer').value = localStorage.getItem(draftKey) || ''; }
catch (error) { announce(`无法读取演示草稿：${error.message}`); }
$('composer').addEventListener('input', () => {
  try { localStorage.setItem(draftKey, $('composer').value); }
  catch (error) { announce(`演示草稿未保存：${error.message}；当前输入仍保留。`); }
});
$('compose-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('composer').value.trim();
  if (!text) { $('composer').focus(); return; }
  if (!dispatch('add', { text })) return;
  $('composer').value = '';
  try { localStorage.removeItem(draftKey); }
  catch (error) { announce(`任务已接收，但旧草稿清理失败：${error.message}`); }
  $('composer').focus();
  $('conversation').scrollTop = $('conversation').scrollHeight;
});
$('composer').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('compose-form').requestSubmit(); }
});
for (const count of [10, 100]) $(`batch${count}`).addEventListener('click', () => dispatch('batch', { count }));
$('restart').addEventListener('click', () => dispatch('restart'));
$('inject-transient').addEventListener('click', () => dispatch('injectIncident', { kind: 'network', mode: 'transient' }));
$('inject-network').addEventListener('click', () => dispatch('injectIncident', { kind: 'network', mode: 'persistent' }));
$('inject-balance').addEventListener('click', () => dispatch('injectIncident', { kind: 'balance' }));
$('reset').addEventListener('click', () => askConfirmation('重置演示？', '仅清空本演示保存的任务、对话和事件，再回到初始状态。保留未发送草稿与推进模式；不会访问或删除真实项目文件。', '重置演示', () => {
  if (!dispatch('reset')) return;
  for (const id of ['task-menu', 'task-detail', 'incident-detail']) if ($(id).open) $(id).close();
  selectedIncidentId = null;
  userAttemptKeys.clear();
  selectedId = null;
  restoreFocus = $('reset');
  ui = { category: 'all', search: '', searchOpen: false, historyOpen: false, recentTask: null, manual: ui.manual, listScroll: {}, scroll: {} };
  groups.get('ended').group.open = false;
  renderTasks();
  renderAlerts();
  syncNavigation();
  for (const element of scrollAreas.values()) element.scrollTop = 0;
  window.scrollTo(0, 0);
  saveUI();
}));
$('confirm-cancel').addEventListener('click', () => $('confirmation').close());
$('confirm-proceed').addEventListener('click', () => { const action = confirmAction; $('confirmation').close(); confirmAction = null; action?.(); });
$('confirmation').addEventListener('close', () => { confirmAction = null; });
for (const close of document.querySelectorAll('[data-close]')) close.addEventListener('click', () => $(close.dataset.close).close());
for (const id of ['task-menu', 'task-detail']) $(id).addEventListener('close', () => {
  if (document.querySelector('dialog[open]')) return;
  if (restoreFocus?.isConnected && restoreFocus.getClientRects().length) restoreFocus.focus({ preventScroll: true });
  else $('work-panel').focus({ preventScroll: true });
});
$('task-menu').addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const controls = [...$('menu-actions').querySelectorAll('button')];
  const current = controls.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
  controls[next]?.focus();
});
$('search-toggle').addEventListener('click', () => {
  ui.searchOpen = !ui.searchOpen;
  if (!ui.searchOpen && ui.search) changeView('');
  syncNavigation(); saveUI();
  if (ui.searchOpen) $('task-search').focus();
});
$('task-search').addEventListener('input', () => changeView($('task-search').value));
$('clear-search').addEventListener('click', () => { changeView(''); $('task-search').focus(); });
$('recent-task').addEventListener('click', () => openDetail(ui.recentTask));
$('source-message').addEventListener('click', () => {
  const task = taskById(selectedId);
  const message = task && messageRows.get(task.sourceMessageId);
  if (!message) { renderDetail(); announce('来源消息已移出记录，请查看冻结原文。'); return; }
  for (const row of messageRows.values()) row.classList.remove('source-highlight');
  message.classList.add('source-highlight');
  restoreFocus = message;
  $('task-detail').close();
  message.scrollIntoView({ block: 'center', behavior: 'instant' });
  message.focus({ preventScroll: true });
});
$('manual-mode').addEventListener('change', () => { ui.manual = $('manual-mode').checked; syncNavigation(); saveUI(); });
$('next-step').addEventListener('click', () => { if (ui.manual && canAdvance()) dispatch('tick'); });
const scrollAreas = new Map(['task-list', 'conversation', 'work-panel', 'events'].map((id) => [id, $(id)]));
scrollAreas.set('document', document.querySelector('.document'));
for (const [id, element] of scrollAreas) element.addEventListener('scroll', () => {
  if (id === 'task-list') ui.listScroll[listKey()] = element.scrollTop;
  else ui.scroll[id] = element.scrollTop;
  saveUI();
}, { passive: true });
window.addEventListener('scroll', () => { ui.scroll.page = window.scrollY; saveUI(); }, { passive: true });
window.addEventListener('pagehide', () => {
  for (const [id, element] of scrollAreas) {
    if (id === 'task-list') ui.listScroll[listKey()] = element.scrollTop;
    else ui.scroll[id] = element.scrollTop;
  }
  ui.scroll.page = window.scrollY;
  saveUI();
});
engine.subscribe(render);
render();
for (const [id, element] of scrollAreas) element.scrollTop = (id === 'task-list' ? ui.listScroll[listKey()] : ui.scroll[id]) || 0;
window.scrollTo(0, ui.scroll.page || 0);
setInterval(() => {
  if (!ui.manual && demoNeedsTick(state)) dispatch('tick');
}, 1500);
