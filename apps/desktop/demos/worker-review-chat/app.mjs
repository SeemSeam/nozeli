const $ = (id) => document.getElementById(id);

// Report snapshots are immutable; each completed turn evaluates whether content changed.
const REPORTS = Object.freeze({
  1: Object.freeze({
    title: '确定性的方程，不可长期预测的轨迹',
    deck: 'Lorenz 系统 · 概念性审阅稿 · V1',
    sections: Object.freeze([
      Object.freeze({ title: '问题与范围', text: '一个没有随机项的系统，为什么仍可能难以预测？这份笔记用 Lorenz 系统说明“确定性”与“可长期预测”之间的区别。本文只做概念讨论，没有运行数值实验。' }),
      Object.freeze({ title: '三个变量，一组确定性规则', text: '经典 Lorenz 系统写作：\ndx/dt = σ(y − x)\ndy/dt = x(ρ − z) − y\ndz/dt = xy − βz\n常用示例参数为 σ = 10、ρ = 28、β = 8/3。给定初始状态，微分方程决定轨迹的演化；“混沌”不意味着方程在随机选择下一步。' }),
      Object.freeze({ title: '微小差异如何被放大', text: '在混沌区域，两条初始位置非常接近的轨迹，会在一段时间后明显分离。初始测量与数值计算都存在有限精度，因此长期精确预测会受到限制。这是对初值的敏感依赖，而不是任意扰动都会让所有系统变得混沌。' }),
      Object.freeze({ title: '审阅结论', text: 'Lorenz 系统提供了一个理解确定性混沌的经典窗口：局部演化由明确的方程约束，长期轨迹却可能对初始误差高度敏感。它提示我们区分演化规则、短期预测与长期统计结构，并谨慎处理有限精度带来的影响。', callout: true }),
    ]),
  }),
});

let state;
let nextId = 1;
let selectedExcerpt = null;
let pendingConfirmation = null;
let composing = false;
let renderedVersion = null;

function message(source, text, extra = {}) {
  const entry = { id: nextId++, source, text, ...extra };
  state.messages.push(entry);
  return entry;
}
function announce(text) { $('announcement').textContent = text; }
function baseState() {
  return {
    scenario: 'ready', latest: 1, viewing: 1, turn: 0, active: null, queue: [],
    paused: false, stopped: false, ended: false, approved: null,
    reports: { 1: REPORTS[1] }, quote: null, messages: [],
  };
}
function initialize(scenario = 'ready') {
  state = baseState();
  state.scenario = scenario;
  selectedExcerpt = null;
  renderedVersion = null;
  $('message-input').value = '';
  $('conversation').replaceChildren();
  message('user', '整理一份面向本科生的混沌研究笔记。解释确定性与长期预测的区别，保留参数依据与证据边界。', { status: '原始任务' });
  message('orchestrator', '交给研究 Worker：围绕 Lorenz 系统形成概念性笔记，不运行数值实验，不把候选当作已接受成果。', { status: '主控交接' });
  message('worker', '先核对三个变量和常用参数，再区分确定性、初值敏感性与预测范围。', { status: '初始执行 · 第1步' });
  message('worker', '已整理方程、初值误差影响与结论；全文未声称进行数值实验。', { status: '初始执行 · 第2步' });
  message('host', '主程序事实：V1 已发布，进入审阅。Work / Worker / Thread 均保持不变。');
  message('worker', '报告已整理好。你可以继续提问、补充或要求修改；每轮我都会核对是否需要调整报告，有变化就保存新版，无需另发更新命令。');
  message('host', '报告 V1 已冻结。来源：Lorenz 概念笔记（合成）；范围：本科生概念解释，无数值验证。', { reportVersion: 1 });
  if (scenario === 'queued') {
    enqueueInput('为什么这叫确定性混沌？', null);
    enqueueInput('补充：读者是没有微分方程基础的本科生。', null);
  } else if (scenario === 'published' || scenario === 'ended') {
    enqueueInput('请把结论改得更简洁，并注明没有进行数值验证。', null);
    advanceTurn();
    if (scenario === 'ended') {
      state.ended = true;
      state.approved = 2;
      message('host', '主程序事实：用户已明确接受 V2，工作结束。此场景为合成快照，未写入任何真实项目。');
      message('orchestrator', '用户已接受 V2；本任务讨论、报告 V1/V2 与处置记录共同保留。演示收尾结束，没有真实目录需要清理。', { status: '任务收尾' });
    }
  }
  render();
}
function startNext() {
  if (state.active || state.paused || state.stopped || state.ended || !state.queue.length) return;
  state.active = state.queue.shift();
  state.active.message.status = '处理中';
  state.turn += 1;
}
function enqueueInput(text, quote) {
  const entry = message('user', text, { quote, status: '已排队' });
  state.queue.push({ id: entry.id, text, quote, message: entry });
  startNext();
}
function submitInput() {
  if (state.ended || composing) return;
  const text = $('message-input').value;
  if (!text.trim()) { announce('请写下问题或修改要求后再发送；引用不会单独派工。'); $('message-input').focus(); return; }
  enqueueInput(text, state.quote ? { ...state.quote } : null);
  $('message-input').value = '';
  state.quote = null;
  render();
  $('conversation').scrollTop = $('conversation').scrollHeight;
  announce(state.active?.text === text ? '输入已发送。点击“推进当前轮”查看脚本回应。' : '输入原文已排队，不会抢占当前轮。');
  $('message-input').focus();
}
function classify(text) {
  if (/简洁|简短|精简|缩短/u.test(text)) return 'concise';
  if (/补充|背景|读者/u.test(text)) return 'supplement';
  if (/确定性|混沌|为什么/u.test(text)) return 'question';
  return 'fallback';
}
function evaluateReport(current) {
  const kind = classify(current.text);
  const previous = state.reports[state.latest];
  const sections = previous.sections.map(section => ({ ...section }));
  const upsert = (title, text) => {
    const existing = sections.find(section => section.title === title);
    if (existing) existing.text = text;
    else sections.push({ title, text });
  };
  let reply;
  let reason;
  if (kind === 'concise') {
    sections[3].text = '确定性的规则，不保证长期精确预测。Lorenz 系统的初值敏感性会放大微小误差。\n证据边界：本文未进行数值验证，不报告模拟轨迹或实验结论。';
    reply = '已把结论精简为两句，并保留未进行数值验证的边界。';
    reason = '精简结论与证据边界';
  } else if (kind === 'supplement') {
    const title = '用户补充与适用背景';
    const existing = sections.find(section => section.title === title)?.text || '';
    const additions = existing ? existing.split('\n\n') : [];
    const entry = `用户提供（未独立核验）：${current.text}`;
    if (!additions.includes(entry)) additions.push(entry);
    upsert(title, additions.join('\n\n'));
    reply = '已将这条补充原文纳入报告的适用背景，标明来自用户、未经独立核验，不把它当作实验结论。';
    reason = '补充任务背景';
  } else if (kind === 'question') {
    upsert('讨论澄清：确定性与预测', '确定性描述演化规则，混沌描述轨迹对初值的敏感性，两者并不矛盾。有限测量精度会限制长期精确预测；这不意味着所有确定性系统都是混沌系统。');
    reply = '确定性说的是下一步由规则决定，混沌说的是轨迹对初值敏感，两者并不矛盾。我核对了报告中的解释。';
    reason = '补充讨论中的概念澄清';
  } else {
    reply = '这条输入超出离线脚本支持的内容，我保留原文，请进一步说明。报告暂不调整，不能据此声称已理解或执行任意修改。';
  }
  const changed = JSON.stringify(sections) !== JSON.stringify(previous.sections);
  if (changed) {
    const version = state.latest + 1;
    state.reports[version] = Object.freeze({
      title: previous.title, deck: `Lorenz 系统 · 对话修订 · V${version}`,
      sections: Object.freeze(sections.map(section => Object.freeze(section))),
      turn: state.turn, reason,
    });
    state.latest = version;
    state.viewing = version;
    message('worker', `${reply}\n本轮报告已调整为 V${version}：${reason}。旧版保留。`, { reportVersion: version });
  } else {
    message('worker', `${reply}\n本轮核对后报告无新增变化，保留 V${state.latest}。`);
  }
}
function advanceTurn() {
  if (!state.active || state.ended) return;
  const current = state.active;
  current.message.status = '已处理';
  state.active = null;
  evaluateReport(current);
  startNext();
  render();
  announce(state.active ? '本轮已核对报告，继续处理下一条输入。' : '本轮已核对报告；有变化才保存新版。');
}
function approvalBlock() {
  if (state.ended) return `已接受 V${state.approved}，工作已结束。`;
  if (state.active) return '当前轮仍在处理中，不能接受报告。';
  if (state.queue.length) return '有待处理输入，请处理或明确移除后再接受。';
  if (state.paused) return '后续处理已暂停，请恢复后再接受。';
  if (state.stopped) return '当前轮已停止，请恢复并核对后再接受。';
  if (state.viewing !== state.latest) return `正在查看历史 V${state.viewing}；请切换到最新 V${state.latest} 后接受。`;
  return '';
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderReport() {
  const versions = Object.keys(state.reports).map(Number);
  $('report-version').replaceChildren(...versions.map((version) => {
    const option = element('option', '', `V${version}${version === state.latest ? ' · 最新' : ' · 历史'}`);
    option.value = version;
    return option;
  }));
  $('report-version').value = state.viewing;
  const snapshot = state.reports[state.viewing];
  $('report-provenance').textContent = state.viewing === 1 ? 'V1 · 初始报告' : `V${state.viewing} · 第 ${snapshot.turn} 轮 · ${snapshot.reason}`;
  if (renderedVersion !== state.viewing) {
    selectedExcerpt = null;
    const report = snapshot;
    const content = [element('h2', '', report.title), element('p', 'report-deck', report.deck)];
    report.sections.forEach((section, index) => {
      const wrapper = element('section', `report-section${section.callout ? ' callout' : ''}`);
      const heading = element('h3');
      heading.append(element('span', 'section-number', `0${index + 1}`), document.createTextNode(section.title));
      const paragraph = element('p', '', section.text);
      paragraph.dataset.section = section.title;
      const button = element('button', 'quote-paragraph', '引用此段');
      button.type = 'button';
      button.id = `quote-paragraph-${index + 1}`;
      button.setAttribute('aria-label', `引用 V${state.viewing} 第 ${index + 1} 段：${section.title}`);
      button.addEventListener('click', () => attachQuote({ version: state.viewing, section: section.title, text: section.text }));
      wrapper.append(heading, paragraph, button);
      content.push(wrapper);
    });
    $('report-body').replaceChildren(...content);
    renderedVersion = state.viewing;
  }
  document.querySelectorAll('.quote-paragraph').forEach((button) => { button.disabled = state.ended; });
  $('quote-selection').disabled = state.ended;
}
function renderMessages() {
  const log = $('conversation');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 70;
  state.messages.forEach((entry) => {
    let node = document.getElementById(`message-${entry.id}`);
    if (!node) {
      node = element('div', `message ${entry.source}`);
      node.id = `message-${entry.id}`;
      node.dataset.source = entry.source;
      const label = { user: '你 · 用户输入', orchestrator: '主控 · 任务交接', worker: '研究 Worker · 脚本回复', host: '主程序 · 状态事实' }[entry.source];
      const header = element('div', 'message-source');
      header.append(element('span', '', label), element('span', 'message-status', entry.status || ''));
      node.append(header);
      if (entry.quote) node.append(element('blockquote', '', `引用 V${entry.quote.version} · ${entry.quote.section}\n${entry.quote.text}`));
      node.append(element('p', '', entry.text));
      if (entry.reportVersion) {
        const open = element('button', 'report-link', `查看报告 V${entry.reportVersion}`);
        open.type = 'button';
        open.addEventListener('click', () => { state.viewing = entry.reportVersion; render(); setMobileView('report'); });
        node.append(open);
      }
      log.append(node);
    }
    const status = node.querySelector('.message-status');
    if (status.textContent !== (entry.status || '')) status.textContent = entry.status || '';
  });
  if (nearBottom) log.scrollTop = log.scrollHeight;
}
function renderQueue() {
  $('queue-panel').hidden = !state.queue.length;
  $('queue-title').textContent = `待处理输入 · ${state.queue.length} 条（原文保留）`;
  $('queue-list').replaceChildren(...state.queue.map((item) => {
    const li = element('li');
    const row = element('div', 'queue-item');
    row.append(element('span', '', `${item.text}${item.quote ? `\n引用 V${item.quote.version} · ${item.quote.section}` : ''}`));
    const remove = element('button', '', '移除');
    remove.type = 'button';
    remove.dataset.testid = 'remove-queued';
    remove.setAttribute('aria-label', `移除排队输入：${item.text}`);
    remove.addEventListener('click', () => {
      state.queue = state.queue.filter((queued) => queued.id !== item.id);
      item.message.status = '已从队列移除 · 未处理';
      message('host', `主程序事实：用户移除了排队输入，未交给 Worker 处理：${item.text}`);
      render();
      announce('已明确移除此条排队输入；对话保留原文与移除记录。');
      ($('queue-list').querySelector('button') || $('message-input')).focus();
    });
    row.append(remove);
    li.append(row);
    return li;
  }));
}
function render() {
  $('scenario').value = state.scenario;
  renderReport();
  renderMessages();
  renderQueue();
  const activity = state.ended ? '已结束 · 只读' : state.active ? `处理中${state.paused ? ' · 后续已暂停' : ''}` : state.paused ? '已暂停' : state.stopped ? '已停止' : state.queue.length ? '已排队' : '空闲 · 待审阅';
  $('activity-status').textContent = activity;
  $('turn-count').textContent = `${state.turn} 轮 / V${state.latest}`;
  $('pause-worker').textContent = state.paused || state.stopped ? '恢复处理' : '暂停后续';
  $('pause-worker').disabled = state.ended;
  $('stop-worker').disabled = !state.active || state.ended;
  $('advance-strip').hidden = !state.active;
  $('advance-turn').disabled = !state.active || state.ended;
  const block = approvalBlock();
  $('accept-report').disabled = !!block;
  $('accept-report').textContent = state.ended ? '工作已结束' : '接受并结束工作';
  $('accept-help').textContent = block || `接受当前报告 V${state.latest}；不会发送未提交的草稿。`;
  $('review-state').textContent = state.ended ? '已结束' : `报告 V${state.latest}`;
  $('quote-preview').hidden = !state.quote;
  $('quote-label').textContent = state.quote ? `引用 V${state.quote.version} · ${state.quote.section}${state.quote.version !== state.viewing ? `（当前查看 V${state.viewing}）` : ''}` : '';
  $('quote-text').textContent = state.quote?.text || '';
  $('message-input').disabled = state.ended;
  $('send-message').disabled = state.ended;
  $('send-message').textContent = state.active || state.paused || state.stopped ? '发送到队列' : '发送';
  $('remove-quote').disabled = state.ended;
  $('ended-note').hidden = !state.ended;
  $('task-summary').textContent = `${activity} · 报告 V${state.latest} · ${state.turn} 轮对话${state.queue.length ? ` · ${state.queue.length} 条待处理` : ''}`;
  $('task-tag').textContent = `W1 · ${state.ended ? '已结束' : state.active ? '处理中' : state.queue.length ? `${state.queue.length}条排队` : '待审阅'} · V${state.latest}`;
}
function confirmAction(title, copy, label, action) {
  if ($('confirm-dialog').open) return;
  pendingConfirmation = action;
  $('dialog-title').textContent = title;
  $('dialog-copy').textContent = copy;
  $('dialog-confirm').textContent = label;
  $('confirm-dialog').returnValue = 'cancel';
  $('confirm-dialog').showModal();
  $('dialog-cancel').focus();
}
function attachQuote(quote) {
  if (state.ended) return;
  const apply = () => {
    state.quote = { ...quote };
    setMobileView('chat');
    render();
    announce(`已附上 V${quote.version} 引用；没有发送，输入草稿保持不变。`);
    $('message-input').focus();
  };
  if (state.quote) confirmAction('替换当前引用？', '输入草稿保持不变；只有引用会被替换。取消可保留原引用。', '替换引用', apply);
  else apply();
}
function setMobileView(view) {
  document.querySelector('.workspace-grid').dataset.mobileView = view;
  $('task-detail').dataset.view = view;
  $('open-task-chat').setAttribute('aria-pressed', String(view === 'chat'));
  $('open-task-report').setAttribute('aria-pressed', String(view === 'report'));
}

$('composer-form').addEventListener('submit', (event) => { event.preventDefault(); submitInput(); });
$('message-input').addEventListener('compositionstart', () => { composing = true; });
$('message-input').addEventListener('compositionend', () => { composing = false; });
$('message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !composing && event.keyCode !== 229) {
    event.preventDefault();
    submitInput();
  }
});
$('advance-turn').addEventListener('click', advanceTurn);
$('pause-worker').addEventListener('click', () => {
  if (state.ended) return;
  document.querySelector('.activity-controls').open = false;
  if (state.paused || state.stopped) {
    state.paused = false;
    state.stopped = false;
    message('host', '主程序事实：用户恢复处理；按原顺序处理队列。');
    startNext();
  } else {
    state.paused = true;
    message('host', '主程序事实：后续处理已暂停。当前轮如有运行仍可推进完成，排队输入不会启动。');
  }
  render();
  document.querySelector('.activity-controls summary').focus();
  announce(state.paused ? '后续已暂停，不会启动下一轮。' : '已恢复处理。');
});
$('stop-worker').addEventListener('click', () => {
  if (!state.active) return;
  document.querySelector('.activity-controls').open = false;
  state.active.message.status = '已停止 · 未结算';
  state.active = null;
  state.stopped = true;
  state.paused = false;
  message('host', '当前轮已停止，既有报告与排队输入保留；需明确恢复后继续处理。');
  render();
  announce('当前轮已停止；先前改动和队列保留。');
  document.querySelector('.activity-controls summary').focus();
});
$('report-version').addEventListener('change', () => { state.viewing = Number($('report-version').value); render(); announce(`正在查看 V${state.viewing}；草稿和引用保持不变。`); });
$('remove-quote').addEventListener('click', () => { state.quote = null; render(); announce('引用已移除，输入草稿保留。'); $('message-input').focus(); });
$('quote-selection').addEventListener('click', () => {
  if (!selectedExcerpt) { announce('请先选中报告正文；也可以用“引用此段”按钮，无需鼠标选区。'); return; }
  attachQuote(selectedExcerpt);
});
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const body = $('report-body');
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return;
  const fragment = range.cloneContents();
  fragment.querySelectorAll('button').forEach((button) => button.remove());
  const text = fragment.textContent.trim();
  if (!text) return;
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  selectedExcerpt = { version: state.viewing, section: start.closest('[data-section]')?.dataset.section || '报告选区', text };
});
function openTaskLabel() {
  $('task-detail').hidden = false;
  $('task-tag').hidden = true;
  $('open-task').setAttribute('aria-expanded', 'true');
  $('demo-settings').open = false;
  if (!$('task-detail').dataset.view) setMobileView('chat');
  $('float-handle').focus({ preventScroll: true });
  clampWindow();
  announce('已展开原任务 block；上下文与草稿保持，不新建会话。');
}
function collapseTaskLabel() {
  $('task-detail').hidden = true;
  $('task-tag').hidden = false;
  $('open-task').setAttribute('aria-expanded', 'false');
  $('task-tag').focus({ preventScroll: true });
  announce('已收起任务标签；执行、队列、报告及草稿全部保留。');
}
$('open-task').addEventListener('click', openTaskLabel);
$('task-tag').addEventListener('click', openTaskLabel);
$('back-to-tasks').addEventListener('click', collapseTaskLabel);
$('open-task-report').addEventListener('click', () => setMobileView('report'));
const floatingWindow = $('task-detail');
let drag = null;
function clampWindow() {
  if (floatingWindow.hidden || matchMedia('(max-width: 760px)').matches || floatingWindow.classList.contains('maximized')) return;
  const r = floatingWindow.getBoundingClientRect();
  floatingWindow.style.left = `${Math.max(8, Math.min(r.left, innerWidth - r.width - 8))}px`;
  floatingWindow.style.top = `${Math.max(8, Math.min(r.top, innerHeight - r.height - 8))}px`;
  floatingWindow.style.right = 'auto';
  floatingWindow.style.bottom = 'auto';
}
$('float-handle').addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest('button') || matchMedia('(max-width: 760px)').matches || floatingWindow.classList.contains('maximized')) return;
  const r = floatingWindow.getBoundingClientRect();
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: r.left, top: r.top };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.preventDefault();
});
$('float-handle').addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.id) return;
  floatingWindow.style.left = `${drag.left + event.clientX - drag.x}px`;
  floatingWindow.style.top = `${drag.top + event.clientY - drag.y}px`;
  clampWindow();
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('float-handle').addEventListener(name, () => { drag = null; });
$('float-handle').addEventListener('keydown', event => {
  if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') { floatingWindow.style.left = ''; floatingWindow.style.top = ''; floatingWindow.style.right = ''; floatingWindow.style.bottom = ''; }
  else {
    const r = floatingWindow.getBoundingClientRect();
    floatingWindow.style.left = `${r.left + (event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0)}px`;
    floatingWindow.style.top = `${r.top + (event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0)}px`;
  }
  clampWindow();
});
$('maximize-task').addEventListener('click', () => {
  const maximized = floatingWindow.classList.toggle('maximized');
  $('maximize-task').textContent = maximized ? '还原' : '放大';
  $('maximize-task').setAttribute('aria-pressed', String(maximized));
  if (!maximized) clampWindow();
});
window.addEventListener('resize', clampWindow);
new ResizeObserver(clampWindow).observe(floatingWindow);
floatingWindow.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('confirm-dialog').open) { event.preventDefault(); collapseTaskLabel(); }
});
$('open-task-chat').addEventListener('click', () => {
  setMobileView('chat');
  const target = state.ended ? $('conversation') : $('message-input');
  if (state.ended) target.tabIndex = -1;
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
  announce(state.ended ? '已定位此任务的只读对话。' : '已进入此任务对话，可继续提问或补充。');
});
$('theme-toggle').addEventListener('click', () => {
  const dark = document.body.classList.toggle('dark');
  $('theme-toggle').setAttribute('aria-pressed', String(dark));
  $('theme-toggle').textContent = dark ? '切换浅色' : '切换深色';
});
$('accept-report').addEventListener('click', () => {
  if (approvalBlock()) return;
  const version = state.viewing;
  const hasDraft = $('message-input').value.trim() || state.quote;
  confirmAction(`接受 V${version} 并结束此工作？`, `接受当前报告快照 V${version}，并将本任务会话置为只读。本演示不会写入真实文件。${hasDraft ? '未发送的草稿或引用将原样保留，不会发送给 Worker。' : ''}取消返回讨论。`, `确认接受 V${version}`, () => {
    if (approvalBlock() || state.viewing !== version) { announce('状态已变化，请重新检查当前报告后再接受。'); return; }
    state.ended = true;
    state.approved = version;
    message('host', `主程序事实：用户明确确认接受 V${version}，工作结束。接受记录绑定此版本，无真实文件写入。`);
    message('orchestrator', `本任务已按用户决定接受 V${version}。原始交接、执行、讨论和报告仍属于同一 block。演示收尾完成，无真实文件写入。`, { status: '任务收尾' });
    render();
    announce(`已接受 V${version}。报告、会话与未发送草稿只读保留。`);
    $('back-to-tasks').focus();
  });
});
$('reset-demo').addEventListener('click', () => confirmAction('重置离线演示？', '将清除本页的草稿、引用、会话、队列与候选，回到 V1 待审阅。主题设置保持不变；不会触及任何真实项目。', '确认重置', () => { initialize(); announce('演示已重置为 V1 待审阅。'); }));
$('scenario').addEventListener('change', () => {
  const scenario = $('scenario').value;
  $('scenario').value = state.scenario;
  confirmAction('切换合成演示场景？', '这会替换本页当前会话状态，包括未发送草稿、引用和排队输入。取消可保留当前状态。所有场景都只在内存中运行。', '切换场景', () => { initialize(scenario); announce('已载入合成场景；无网络请求或真实项目变更。'); });
});
$('confirm-dialog').addEventListener('cancel', () => { pendingConfirmation = null; });
$('confirm-dialog').addEventListener('close', () => {
  const action = pendingConfirmation;
  pendingConfirmation = null;
  if ($('confirm-dialog').returnValue === 'confirm') action?.();
});
initialize();
