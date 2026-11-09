export const PROJECT_ATTENTION_TTL = 60_000;

export function projectAttentionView(entry, now = Date.now()) {
  const row = entry?.row;
  const exact = row?.complete === true && Number.isSafeInteger(row.pendingCount) && row.pendingCount >= 0;
  const age = now - Date.parse(row?.observedAt);
  // A pending read does not revoke a still-fresh confirmed snapshot.
  const live = exact && row.freshness === 'live' && !entry.invalid && !entry.sidebarMismatch && age >= 0 && age < PROJECT_ATTENTION_TTL;
  const count = live ? row.pendingCount : null;
  const state = live ? 'live' : entry?.loading ? 'loading' : exact ? 'stale' : 'unknown';
  return {state, count, text: count > 0 ? count > 99 ? '99+' : String(count) : '',
    label: live ? count ? `${count}项待处理` : '无待处理事项' : state === 'loading' ? '待办正在读取' : '当前待办数量未知'};
}

// A request owns both its registration object and local generation. Event invalidation
// supersedes in-flight reads; opaque fact hashes are identities, never sortable clocks.
export function createProjectAttentionStore({invoke, changed = () => {}}) {
  const entries = new Map();
  return {
    entries,
    sync(projects) {
      const ids = new Set(projects.map(project => project.id));
      for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
      for (const project of projects) {
        const entry = entries.get(project.id);
        if (entry) entry.project = project;
        else entries.set(project.id, {project, generation:0, loading:true, invalid:true, row:null});
      }
    },
    invalidate(ids = [...entries.keys()]) {
      for (const id of ids) {const entry = entries.get(id); if (entry) {entry.generation++; entry.invalid = true; changed(id);}}
    },
    async refresh(ids = [...entries.keys()]) {
      for (let start = 0; start < ids.length; start += 100) {
        const batch = ids.slice(start, start + 100).filter(id => entries.has(id));
        if (!batch.length) continue;
        const captures = batch.map(id => {const entry = entries.get(id); entry.loading = true; const generation = ++entry.generation; changed(id); return {id, entry, generation};});
        let rows = [];
        try {const result = await invoke('project.attention.summary', {projectIds:batch}); if (result.ok) rows = result.value?.projects || []; } catch {}
        for (const {id, entry, generation} of captures) {
          if (entries.get(id) !== entry || entry.generation !== generation) continue;
          const row = rows.find(row => row.projectId === id);
          const valid = row && typeof row.instanceId === 'string' && typeof row.revision === 'string' && Number.isFinite(Date.parse(row.observedAt));
          // A new registration cannot inherit the previous instance's last count.
          if (valid && entry.row && entry.row.instanceId !== row.instanceId) entry.row = null;
          if (valid && row.complete === true && Number.isSafeInteger(row.pendingCount) && row.pendingCount >= 0) {
            entry.row = row; entry.invalid = row.freshness !== 'live';
          } else entry.invalid = true;
          entry.loading = false;
          entry.error = row?.errorCode || (!valid ? '读取失败或摘要缺失' : row.complete ? '' : '摘要不完整');
          changed(id);
        }
      }
    }
  };
}

// One deadline per registration, with two delayed retries. This schedules only
// the existing pure summary store, never project navigation or acknowledgement.
export function createProjectAttentionRefresh({store, active, paint = () => {}, now = Date.now, setTimeout, clearTimeout}) {
  const dirty = new Set(), deadlines = new Map(), retries = new Map();
  let timer = null, timerAt = null, running = false;
  function schedule() {
    if (!active()) {clearTimeout(timer);timer = timerAt = null;return;}
    for (const [id, deadline] of deadlines) if (store.entries.get(id) !== deadline.entry) {deadlines.delete(id); retries.delete(id);}
    const next = dirty.size && !running ? now() + 100 : Math.min(...[...deadlines.values()].map(item => item.at));
    if (timer !== null && timerAt <= next) return;
    clearTimeout(timer);timer = timerAt = null;
    if (Number.isFinite(next)) {timerAt = next;timer = setTimeout(drain, Math.max(0, next - now()));}
  }
  async function drain() {
    timer = timerAt = null;
    if (!active()) return;
    for (const [id, deadline] of deadlines) if (deadline.at <= now()) {deadlines.delete(id); if (store.entries.get(id) === deadline.entry) {paint(id); dirty.add(id);}}
    if (running) return;
    const ids = [...dirty].filter(id => store.entries.has(id)); dirty.clear();
    const captures = ids.map(id => [id, store.entries.get(id)]);
    running = true;
    try {const reading=store.refresh(ids);schedule();await reading;} finally {
      running = false;
      for (const [id, entry] of captures) {
        if (store.entries.get(id) !== entry || dirty.has(id)) continue;
        if (projectAttentionView(entry, now()).state === 'live') {
          retries.delete(id);
          deadlines.set(id, {entry, at:Date.parse(entry.row.observedAt) + PROJECT_ATTENTION_TTL});
        } else {
          const attempt = retries.get(id) || 0;
          retries.set(id, attempt + 1);
          if (attempt < 2) deadlines.set(id, {entry, at:now() + [2000, 10000][attempt]});
        }
      }
      schedule();
    }
  }
  return {
    request(ids, invalidate = true) {
      if (invalidate) store.invalidate(ids);
      // Supersede old reads without blanking a confirmed snapshot on routine events.
      else for (const id of ids) {const entry = store.entries.get(id);if (entry) entry.generation++;}
      for (const id of ids) if (store.entries.has(id)) {
        const entry=store.entries.get(id);dirty.add(id);retries.delete(id);
        if (!invalidate && projectAttentionView(entry, now()).state === 'live') deadlines.set(id, {entry, at:Date.parse(entry.row.observedAt) + PROJECT_ATTENTION_TTL});
        else deadlines.delete(id);
      }
      schedule();
    },
    wake:schedule
  };
}

export function mountProjectAttention({document, window, invoke, subscribe, currentProject}) {
  const host = document.getElementById('recent');
  document.getElementById('app').classList.add('has-project-attention');
  const live = document.createElement('p'); live.id = 'project-attention-live'; live.className = 'project-attention-description';
  live.setAttribute('role','status'); live.setAttribute('aria-live','polite'); live.setAttribute('aria-atomic','true'); document.body.append(live);
  const tooltip = document.createElement('div'); tooltip.id = 'project-attention-tooltip'; tooltip.className = 'project-attention-tooltip'; tooltip.role = 'tooltip'; tooltip.hidden = true; document.body.append(tooltip);
  let tooltipButton = null, announcementTimer = null, lastAnnouncement = 0, composing = false;
  const updates = new Map(), baseline = new Map(), quiet = new Map();
  const meaningful = (old, view) => view.state !== 'live' && old.state === 'live' || view.state === 'live' && (view.count > old.count || view.count === 0 && old.count > 0);
  const store = createProjectAttentionStore({invoke, changed:paint});
  const refresh = createProjectAttentionRefresh({store, paint, active:() => !document.hidden && document.hasFocus() && !composing,
    setTimeout:(fn, delay) => window.setTimeout(fn, delay), clearTimeout:timer => window.clearTimeout(timer)});
  const request = refresh.request;
  function announce() {
    announcementTimer = null;
    if (document.hidden || !document.hasFocus() || composing || !updates.size) return;
    const ids = [...updates].filter(([id,old]) => store.entries.has(id) && meaningful(old,projectAttentionView(store.entries.get(id))) && !(quiet.get(id)>Date.now())).map(([id])=>id); updates.clear();
    if (!ids.length) return;
    live.textContent = ids.length > 1 ? `${ids.length}个项目待办有更新` : `${store.entries.get(ids[0]).project.name}，${projectAttentionView(store.entries.get(ids[0])).label}`;
    lastAnnouncement = Date.now();
  }
  function scheduleAnnouncement() {
    if (!updates.size || announcementTimer) return;
    announcementTimer = window.setTimeout(announce, Math.max(1000, 10000 - (Date.now() - lastAnnouncement)));
  }
  function paint(id) {
    const entry = store.entries.get(id); if (!entry) return;
    entry.sidebarMismatch = sidebar?.projectId === id && currentProject() === id && !sidebar.loading && !sidebar.stale && entry.row?.pendingCount !== sidebar.pendingCount;
    const button = [...host.children].find(node => node.dataset.projectId === id); if (!button) return;
    const view = projectAttentionView(entry), old = baseline.get(id);
    if (!entry.loading) {
      if (old && meaningful(old,view) && !updates.has(id) && !(quiet.get(id)>Date.now())) updates.set(id,old);
      baseline.set(id, view); scheduleAnnouncement();
    }
    button.dataset.attentionState = view.state;
    const badge = button.querySelector('[data-project-attention-badge]');
    if (badge.hidden !== !view.text) badge.hidden = !view.text;
    if (badge.textContent !== view.text) badge.textContent = view.text;
    const action = currentProject() === id && (view.state !== 'live' || view.count > 0) ? '点击查看当前项目待办' : '打开项目';
    const description = [entry.project.available ? '' : '项目目录不可用，可右键重试或移除入口', action, view.count > 0 ? '需要处理，不代表执行失败' : '', entry.row ? '最近确认：'+entry.row.observedAt : '', entry.sidebarMismatch ? '与当前待办清单尚未对齐，正在核对' : '', entry.error].filter(Boolean).join('。');
    button.querySelector('[data-project-attention-description]').textContent = description;
    button.setAttribute('aria-label', `${entry.project.name || '项目'}，${view.label}${button.getAttribute('aria-busy') === 'true' ? '，正在切换' : ''}`);
    button.title = `${entry.project.name || '项目'}，${view.label}。${description}`;
    if (tooltipButton === button && !tooltip.hidden) tooltip.textContent = button.title;
  }
  function showTooltip(button) {
    tooltipButton = button; tooltip.textContent = button.title; tooltip.hidden = false;
    const rect = button.getBoundingClientRect(); tooltip.style.left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - tooltip.offsetWidth - 8))+'px';
    tooltip.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - tooltip.offsetHeight - 8))+'px';
  }
  function hideTooltip() {tooltip.hidden = true; tooltipButton = null;}
  host.addEventListener('scroll', hideTooltip);
  document.addEventListener('keydown', event => {if (event.key === 'Escape') hideTooltip();});
  document.addEventListener('compositionstart', () => {composing = true; refresh.wake();});
  document.addEventListener('compositionend', () => {composing = false; refresh.wake(); scheduleAnnouncement();});
  function resume() {if (!document.hidden && document.hasFocus()) {request([...store.entries.keys()], false); scheduleAnnouncement();} else refresh.wake();}
  window.addEventListener('focus', resume); window.addEventListener('blur', () => refresh.wake()); document.addEventListener('visibilitychange', resume);
  subscribe('agent', event => {if (event.kind === 'managed-state' && store.entries.has(event.projectId)) request([event.projectId], false);});
  let sidebar = null;
  document.addEventListener('nozeli-sidebar-attention', event => {
    if(event.detail?.projectId!==currentProject())return;
    sidebar=event.detail;
    // This unversioned event is only a disagreement signal, never a cache row.
    paint(sidebar.projectId);
  });
  return {
    decorate(button) {
      const initial = document.createElement('span'); initial.dataset.projectInitial = ''; initial.setAttribute('aria-hidden','true');
      const badge = document.createElement('span'); badge.dataset.projectAttentionBadge = ''; badge.dataset.projectAttentionCount = ''; badge.setAttribute('aria-hidden','true'); badge.hidden = true;
      const description = document.createElement('span'); description.dataset.projectAttentionDescription = ''; description.className = 'project-attention-description'; description.id = 'project-attention-description-'+button.dataset.projectId;
      button.setAttribute('aria-describedby',description.id); button.append(initial,badge,description);
      button.addEventListener('pointerenter', () => showTooltip(button)); button.addEventListener('pointerleave', hideTooltip);
      button.addEventListener('focus', () => {button.scrollIntoView({block:'nearest',inline:'nearest'}); showTooltip(button);}); button.addEventListener('blur',hideTooltip);
    },
    sync(projects) {
      store.sync(projects);
      for (const id of baseline.keys()) if (!store.entries.has(id)) {baseline.delete(id);updates.delete(id);quiet.delete(id);}
      for (const project of projects) paint(project.id);
      request(projects.map(project => project.id), false);
    },
    paint,
    reveal(projectId, trigger) {
      const view = projectAttentionView(store.entries.get(projectId));
      if (projectId !== currentProject() || view.state === 'live' && view.count === 0) return false;
      updates.delete(projectId); quiet.set(projectId,Date.now()+10000); hideTooltip();
      document.dispatchEvent(new CustomEvent('nozeli-reveal-project-todos',{detail:{projectId,trigger}}));
      request([projectId],false); return true;
    }
  };
}
