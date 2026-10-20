const states = { queued: '排队中', running: '进行中', unknown: '状态待确认', paused: '已暂存', completed: '已完成', failed: '未完成', cancelled: '已取消' };
export function workGroup(status) {
  if (['queued', 'running'].includes(status)) return 'active';
  if (['completed', 'failed', 'cancelled'].includes(status)) return 'closed';
  return 'paused';
}
export function mountWorkSidebar({ document, onOpenReport }) {
  const $ = id => document.getElementById(id);
  const badge=document.createElement('span');badge.id='sidebar-badge';badge.hidden=true;$('toggle-sidebar').append(badge);
  let work = [], reports = [], workFilter = 'active', inboxFilter = 'all';
  function render() {
    const items = $('work-items');
    document.querySelector('.workflow-panel .filters').hidden=work.length===0;
    document.querySelector('.inbox-panel .filters').hidden=reports.length===0;
    const count=work.filter(item=>workGroup(item.status)!=='closed').length+reports.length;
    badge.hidden=count===0;badge.textContent=String(count);$('toggle-sidebar').dataset.badgeCount=String(count);
    const action=$('toggle-sidebar').getAttribute('aria-expanded')==='true'?'收起':'展开';
    $('toggle-sidebar').setAttribute('aria-label',action+'工作与待办'+(count?'，'+count+' 项未处理':''));
    items.replaceChildren();
    const visible = work.filter(item => workFilter === 'all' || workGroup(item.status) === workFilter);
    for (const item of [...visible].reverse()) {
      const row = document.createElement('article'); row.className = 'work-entry'; row.dataset.workId = item.id;
      const title = document.createElement('p'); title.textContent = item.title;
      const state = document.createElement('small'); state.textContent = states[item.status] || states.unknown;
      row.append(title, state); items.append(row);
    }
    $('work-count').textContent = String(work.filter(item => workGroup(item.status) !== 'closed').length).padStart(2, '0');
    $('work-empty').hidden = visible.length > 0;
    $('work-empty').textContent = work.length ? '当前筛选下没有工作。' : '还没有开展的工作。';
    const side = $('inbox-reports'); side.replaceChildren();
    const selected = reports.filter(report => inboxFilter === 'all' || (report.kind || 'read') === inboxFilter);
    for (const report of selected) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'reading-entry';
      button.textContent = `${report.kind === 'answer' ? '待回答' : report.success ? '待阅读' : '未完成'} · ${report.title}`;
      button.addEventListener('click', () => onOpenReport(report.id)); side.append(button);
    }
    $('inbox-empty').hidden = selected.length > 0;
    $('inbox-empty').textContent = reports.length ? '当前筛选下没有待办。' : '没有待阅读或待回答的内容。';
  }
  for (const [attr, set] of [['work-filter', value => { workFilter = value; }], ['inbox-filter', value => { inboxFilter = value; }]]) {
    for (const button of document.querySelectorAll(`[data-${attr}]`)) button.addEventListener('click', () => {
      set(button.getAttribute(`data-${attr}`));
      for (const sibling of button.parentElement.querySelectorAll('button')) { sibling.classList.toggle('active', sibling === button); sibling.setAttribute('aria-pressed', String(sibling === button)); }
      render();
    });
  }
  return {
    setWork(value) { work = value; render(); },
    setReports(value) { reports = value; render(); },
    clear() { work = []; reports = []; render(); },
  };
}
