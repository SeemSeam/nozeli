// Work memory is reviewed independently of the conversation composer.
export function mountFrontdeskMemory({call, current}) {
  const node = (tag, text) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const button = (text, action) => {
    const el = node('button', text);
    el.type = 'button';
    el.onclick = action;
    return el;
  };
  const dialog = node('dialog');
  dialog.id = 'frontdesk-memory-dialog';
  dialog.className = 'managed-report-dialog';
  const title = node('h2', '工作状态继承');
  title.id = 'frontdesk-memory-title';
  const intro = node('p', '选择本项目的 Agent 会话，提交给主控派工。');
  intro.id = 'frontdesk-memory-intro';
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.setAttribute('aria-describedby', intro.id);
  const close = button('关闭', () => clear(true));
  const actions = node('div');
  actions.className = 'frontdesk-memory-actions';
  actions.append(close);
  const picker = node('section');
  picker.id = 'frontdesk-memory-sources';
  picker.className = 'frontdesk-memory-picker';
  const pickerHeading = node('h3', '从历史会话整理');
  pickerHeading.id = 'frontdesk-memory-picker-title';
  picker.setAttribute('aria-labelledby', pickerHeading.id);
  const sourceRoot = node('p');
  sourceRoot.id = 'frontdesk-memory-source-root';
  sourceRoot.style.overflowWrap = 'anywhere';
  const filterLabel = node('label', '筛选历史会话'), filter = node('input');
  filter.id = 'frontdesk-memory-source-filter';
  filter.type = 'search';
  filter.placeholder = '服务、Agent、会话 ID、时间或来源路径';
  filterLabel.htmlFor = filter.id;
  const catalog = node('ul'), pickerCount = node('p'), pickerStatus = node('p'), pickerError = node('p');
  catalog.className = 'frontdesk-memory-catalog';
  catalog.setAttribute('aria-label', '历史会话');
  pickerCount.id = 'frontdesk-memory-picker-count';
  pickerCount.setAttribute('role', 'status');
  pickerStatus.setAttribute('role', 'status');
  pickerError.setAttribute('role', 'alert');
  const warning = node('p', '提交后，受派 Worker 的模型可读取所选会话的冻结文本。请先确认来源可发送。');
  warning.id = 'frontdesk-memory-prepare-warning';
  const reloadSources = button('刷新来源', () => void readSources());
  const showMore = button('显示更多', () => {
    if (!live(owner) || sourceBusy) return;
    visibleLimit += pageSize;
    pickerControls();
    if (showMore.hidden) filter.focus({preventScroll:true});
  });
  const description = node('textarea');
  description.id = 'frontdesk-memory-task-description';
  description.rows = 2;
  description.maxLength = 2000;
  const initialDescription = '汇总并分析所选会话：工作背景、进展与决策、未决问题，以及有依据的接续建议。';
  description.value = initialDescription;
  const descriptionLabel = node('label', '后台任务描述');
  descriptionLabel.htmlFor = description.id;
  const previewConsent = node('label');
  const allowPreview = node('input');
  allowPreview.type = 'checkbox';
  previewConsent.append(allowPreview, document.createTextNode(' 对无法验证完整分支的会话，仅交接列表中可见的对话摘录'));
  previewConsent.hidden = true;
  const prepare = button('提交交接任务', () => void prepareSelected());
  prepare.setAttribute('aria-describedby', `${warning.id} ${pickerCount.id}`);
  const pickerActions = node('div');
  pickerActions.className = 'frontdesk-memory-actions';
  prepare.className = 'frontdesk-memory-primary';
  const tools = node('div');
  tools.className = 'frontdesk-memory-source-tools';
  tools.append(pickerCount, reloadSources, showMore);
  pickerActions.append(warning, prepare);
  picker.append(pickerHeading, sourceRoot, filterLabel, filter, tools, catalog, pickerStatus, pickerError, previewConsent, descriptionLabel, description, pickerActions);
  const header = node('header');
  header.className = 'frontdesk-memory-header';
  const identity = node('div');
  const eyebrow = node('span', '项目任务');
  eyebrow.className = 'frontdesk-memory-eyebrow';
  identity.append(eyebrow, title, intro);
  header.append(identity, actions);
  const body = node('div');
  body.className = 'frontdesk-memory-body';
  body.append(picker);
  dialog.append(header, body);
  document.body.append(dialog);

  let owner = null;
  const maxSources = 5;
  const pageSize = 10;
  let visibleLimit = pageSize;
  let sourceRows = [], limited = false, sourceBusy = false;
  const chosenSources = new Set();
  const same = (a, b) => a && b && a.projectId === b.projectId && a.generation === b.generation;
  const live = ticket => owner === ticket && dialog.open && same(ticket, current());
  const time = value => {
    if (value == null) return '';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
  };
  function pickerControls() {
    const terms = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let visible = 0, matching = 0;
    for (const {source, row, checkbox, search} of sourceRows) {
      const matches = terms.every(term => search.includes(term));
      if (matches) matching++;
      row.hidden = !matches || visible >= visibleLimit;
      if (!row.hidden) visible++;
      checkbox.checked = chosenSources.has(source);
      checkbox.disabled = !source || sourceBusy || (!checkbox.checked && chosenSources.size >= maxSources);
    }
    catalog.hidden = !visible;
    filter.disabled = sourceBusy || !sourceRows.length;
    reloadSources.disabled = sourceBusy;
    showMore.hidden = matching <= visibleLimit;
    showMore.disabled = sourceBusy;
    description.disabled = allowPreview.disabled = sourceBusy;
    prepare.disabled = sourceBusy || !chosenSources.size;
    pickerCount.textContent = [
      `已选 ${chosenSources.size} / ${maxSources} 个`,
      `显示 ${visible} / ${matching} 个会话`,
      chosenSources.size === maxSources ? '已达选择上限' : '',
      terms.length && !visible ? '没有匹配的会话' : '',
      limited ? '扫描达到上限或部分历史无法读取，列表可能不完整' : '',
    ].filter(Boolean).join(' · ');
  }
  filter.oninput = () => {
    visibleLimit = pageSize;
    pickerControls();
    catalog.scrollTop = 0;
  };
  function paintSources(entries) {
    sourceRows = entries.map(({source, provider, agent, recent, sessionId, time: timestamp, descriptor, unavailable}) => {
      const row = node('li'), choice = node('label'), checkbox = node('input'), text = node('span');
      const identity = [agent ? 'CCB' : '独立会话', agent, ({codex:'Codex',claude:'Claude Code',pi:'Pi',omp:'OMP'})[provider] ?? provider, time(timestamp) || '会话时间未知'].filter(Boolean).join(' · ');
      const path = descriptor?.sourcePath;
      const metadata = node('span', identity);
      metadata.className = 'frontdesk-memory-session-meta';
      text.append(metadata);
      if(descriptor?.selectionScope==='recent-dialogue-only')text.append(node('span','仅交接近期对话，不含完整历史'));
      if(recent?.length){
        const excerpt=node('span');excerpt.className='frontdesk-memory-session-excerpt';
        for(const [role,label] of [['user','最近请求'],['assistant','最近回应']]){
          const message=recent.findLast(item=>item.role===role);
          if(!message)continue;
          const line=node('span');line.append(node('strong',`${label}：`),document.createTextNode(message.text));excerpt.append(line);
        }
        text.append(excerpt);
      }else text.append(node('span',unavailable?'此会话不可选':'末尾未找到可预览对话'));
      const details=node('details');details.className='frontdesk-memory-source-details';
      details.append(node('summary','会话详情'),node('strong',`会话 ${sessionId}`));
      if(descriptor?.workspacePath)details.append(node('span',`隔离工作区：${descriptor.workspacePath}`));
      if(path){const location=node('code',path);location.className='frontdesk-memory-session-path';details.append(location);}
      checkbox.type = 'checkbox';
      checkbox.onchange = () => {
        if (!source || !live(owner) || sourceBusy) return;
        if (!checkbox.checked) chosenSources.delete(source);
        else if (chosenSources.size < maxSources) chosenSources.add(source);
        previewConsent.hidden = true;
        allowPreview.checked = false;
        pickerError.textContent = '';
        pickerControls();
      };
      choice.append(checkbox, text);
      row.append(choice,details);
      return {source, row, checkbox, search:[identity, sessionId, timestamp, path,...(recent??[]).map(item=>item.text)].filter(value => value != null).join(' ').toLowerCase()};
    });
    catalog.replaceChildren(...sourceRows.map(({row}) => row));
    catalog.scrollTop = 0;
    pickerControls();
  }
  async function readSources() {
    const ticket = owner;
    if (!live(ticket) || sourceBusy) return;
    sourceBusy = true;
    pickerControls();
    pickerError.textContent = '';
    pickerStatus.textContent = '正在读取历史会话…';
    try {
      const result = await call('sources', {}, ticket.projectId);
      if (!live(ticket)) return;
      const entries = result.items;
      sourceRoot.textContent = `当前项目目录：${result.projectRoot}`;
      limited = result.limited;
      chosenSources.clear();
      filter.value = '';
      visibleLimit = pageSize;
      previewConsent.hidden = true;
      allowPreview.checked = false;
      paintSources(entries);
      pickerStatus.textContent = entries.some(item=>item.source) ? '核对最近对话摘录后，勾选要交接的会话。' : '当前目录没有可整理的同项目会话。若有同名项目，请核对目录后重新打开。';
    } catch (failure) {
      if (!live(ticket)) return;
      pickerStatus.textContent = '';
      pickerError.textContent = '无法读取历史会话：' + failure.message;
    } finally {
      if (live(ticket)) { sourceBusy = false; pickerControls(); }
    }
  }
  async function prepareSelected() {
    const ticket = owner;
    if (!live(ticket) || sourceBusy || !chosenSources.size) return;
    sourceBusy = true;
    pickerControls();
    pickerError.textContent = '';
    pickerStatus.textContent = '正在提交交接任务…';
    try {
      const result = await call('prepare', {sources:[...chosenSources],description:description.value.trim(),allowPreview:allowPreview.checked}, ticket.projectId);
      if (!live(ticket)) return;
      pickerStatus.textContent = `已受理 · ${result.jobId}。请在项目任务列表追踪并审查 Worker 报告。`;
    } catch (failure) {
      if (!live(ticket)) return;
      pickerStatus.textContent = '';
      if (failure.code === 'HANDOFF_BRANCH_UNVERIFIED') previewConsent.hidden = false;
      pickerError.textContent = failure.code === 'STALE_SOURCE'
        ? '来源在选中后发生变化，请刷新来源并重新勾选。'
        : '未能提交交接任务：' + failure.message;
    } finally {
      if (live(ticket)) { sourceBusy = false; pickerControls(); }
    }
  }
  function open() {
    const context = current();
    if (!context || dialog.open) return;
    owner = {...context};
    dialog.showModal();
    close.focus({preventScroll:true});
    void readSources();
  }
  let focus;
  function clear(restoreFocus = false) {
    const open = dialog.open;
    owner = null;
    if (!open) return;
    dialog.close();
    sourceBusy = false; limited = false; chosenSources.clear();
    filter.value = pickerStatus.textContent = pickerError.textContent = '';
    sourceRoot.textContent = '';
    description.value = initialDescription;
    previewConsent.hidden = true;
    allowPreview.checked = false;
    paintSources([]);
    if (restoreFocus) focus?.focus({preventScroll:true});
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); clear(true); });
  return {open(from) {focus=from;open();}, clear};
}
