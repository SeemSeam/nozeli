import './managed-work-overview.css';
import { workSlotCaptions } from './managed-work-directory.mjs';

const statusLabels = {
  queued: '已接收，等待开始',
  running: '执行中',
  working: '执行中',
  review: '等待审阅',
  paused: '已暂停',
  closing: '审核已决定 · 收尾未完成',
  ended: '已结束',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '执行已中断',
};

/**
 * Read-only task presentation. Callbacks are invoked without arguments; the
 * caller owns identity, capability checks, pending state and error feedback.
 * Supplied sections are DOM nodes, moved rather than cloned to preserve handlers.
 */
export function renderWorkOverview({
  document,
  work,
  publication,
  onReport,
  onControl,
  onEnd,
  onProgress,
  requiredSection,
  technicalSections = [],
  phase = null,
  waitingOn = null,
  onInspectWork = null,
  technicalOpen = false,
  disabled = false,
}) {
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const root = make('section', 'managed-work-overview');
  root.dataset.workOverview = work.id;
  root.setAttribute('aria-label', '任务概览');

  const ended = ['ended', 'failed', 'cancelled', 'interrupted'].includes(work.status);
  const hasReport = Boolean(publication?.objectId);
  const knownRevision = Number.isSafeInteger(publication?.revision) && Number.isSafeInteger(work.revision);
  const historical = hasReport && knownRevision && publication.revision < work.revision;
  const currentReport = hasReport && knownRevision && publication.revision === work.revision;
 const incompleteClosure = work.status === 'closing';

  const header = make('header', 'managed-work-overview-header');
  header.append(make('h3', 'managed-work-overview-title', work.name || '任务'));
  let status = phase || statusLabels[work.status] || '状态待确认';
  if (work.manualControl?.pause != null && !ended && work.status !== 'closing') status = work.status === 'running' ? status + ' · 后续已暂停' : /已暂停|停止|待核查/.test(status) ? status : '已暂停';
  header.append(make('p', 'managed-work-overview-status', status));
  root.append(header);

  const result = make('section', 'managed-work-overview-result');
  let resultTitle;
  let explanation;
  if (historical) {
    resultTitle = '保留了历史报告';
    explanation = `第 ${publication.revision} 版报告早于当前第 ${work.revision} 版，不是本轮最终交付。`;
    if (ended) explanation += '本轮没有最终报告。';
  } else if (hasReport) {
    resultTitle = ended ? '成果报告已保留' : currentReport ? '成果已就绪' : '已有报告可查看';
    explanation = ended
      ? work.outcome === 'accept' && !incompleteClosure ? '成果已采用，原报告仍可随时查看。' : work.outcome === 'discard' ? '任务已结束，未采用这份成果；报告仍可查看。' : '任务已结束，可查看此前保存的原报告。'
      : work.status === 'review'
        ? '打开报告查看结论与产出，再决定采用或继续修改。'
        : '已保存的报告可以查看，任务仍在处理中。';
    if (!knownRevision) explanation += '报告与当前任务的版本关系尚未确认。';
  } else {
    resultTitle = ended ? '没有最终报告' : '尚无成果报告';
    explanation = ended
      ? '这项任务在交付前结束，没有生成最终成果报告。'
      : work.status === 'review'
        ? '成果报告暂不可用，请稍后重新查看。'
        : work.status === 'queued'
          ? '尚未开始执行；原请求已保留，开始后按排队顺序进行。'
          : '尚未收到最终成果报告；已有进展会保留。';
  }
  result.append(make('h4', 'managed-work-overview-result-title', resultTitle));
  result.append(make('p', 'managed-work-overview-explanation', explanation));
  if (incompleteClosure) {
    const closureFailure = work.closure?.error?.message || work.closure?.error;
    const closureNotice = work.closure?.phase === 'blocked'
      ? '技术收尾受阻：' + (closureFailure ? String(closureFailure) : '故障已记录') + '。原决定、结果与记录保留；处理后可重试收尾，不会重放任务。'
      : ['requested', 'stopping', 'integrating', 'cleanup'].includes(work.closure?.phase)
        ? '审核决定已保存，技术收尾进行中；原决定与结果保留，无需重复操作。'
        : '审核决定已保存，技术收尾未完成；原决定、结果与记录保留。';
    result.append(make('p', 'managed-work-overview-notice', closureNotice));
  }

  const button = (label, callback, dataKey, primary = false) => {
    const node = make('button', 'managed-work-overview-action', label);
    node.type = 'button';
    node.dataset[dataKey] = work.id;
    if (primary) node.dataset.uiAction = 'primary';
    node.disabled = disabled;
    node.addEventListener('click', () => { if (!node.disabled) callback(); });
    return node;
  };
  if (hasReport && typeof onReport === 'function') {
    result.append(button(historical ? '查看历史报告' : '查看成果报告', onReport, 'managedWorkReport', true));
  }
  root.append(result);

  // Decision gates must never be placed inside a collapsed disclosure.
  if (requiredSection) {
    const required = make('section', 'managed-work-overview-required');
    required.append(make('h4', '', '需要你决定'), requiredSection);
    root.append(required);
  }

  // A queued Work names the exact Works holding its slots; opening them uses
  // the existing task overview only, with no new permission or replay path.
  const waiting = (Array.isArray(waitingOn) ? waitingOn : []).slice(0, 8);
  if (waiting.length) {
    const waitSection = make('section', 'managed-work-overview-waiting');
    waitSection.append(make('h4', '', '等待名额释放'));
    for (const holder of waiting) {
      const row = make('div', 'managed-work-overview-waiting-row');
      row.append(make('span', '', holder.name + ' · ' + (workSlotCaptions[holder.status] || holder.status)));
      if (typeof onInspectWork === 'function' && holder.workId) {
        const open = make('button', 'managed-work-overview-waiting-open', '查看');
        open.type = 'button';
        open.dataset.workWaitingOpen = holder.workId;
        open.disabled = disabled;
        open.addEventListener('click', () => { if (!open.disabled) onInspectWork(holder.workId); });
        row.append(open);
      }
      waitSection.append(row);
    }
    root.append(waitSection);
  }

  const actions = make('div', 'managed-work-overview-actions');
  if (typeof onProgress === 'function') actions.append(button('查看保留进展', onProgress, 'workRetainedProgress', true));
  if (typeof onControl === 'function') actions.append(button('执行控制…', onControl, 'workControlDetails'));
  if (typeof onEnd === 'function') actions.append(button(work.status === 'queued' ? '取消排队…' : '结束任务…', onEnd, 'managedWorkEnd'));
  if (actions.childNodes.length) root.append(actions);

  if (typeof work.request === 'string' && work.request.trim()) {
    const longRequest = work.request.length > 180 || work.request.split('\n').length > 3;
    const request = make(longRequest ? 'details' : 'section', 'managed-work-overview-request');
    request.append(make(longRequest ? 'summary' : 'h4', '', '原始任务'));
    request.append(make('p', 'managed-work-overview-request-text', work.request));
    root.append(request);
  }

  const sections = technicalSections.filter(Boolean);
  if (sections.length) {
    const technical = make('details', 'managed-work-overview-technical');
    technical.dataset.workOverviewTechnical = '';
    technical.open = Boolean(technicalOpen);
    technical.append(make('summary', '', '诊断信息（可选）'));
    const body = make('div', 'managed-work-overview-technical-body');
    body.append(...sections);
    technical.append(body);
    root.append(technical);
  }
  return root;
}

// An accepted request without a Work has no business execution to control.
export function renderRequestOverview({document,record,serviceState}){
 const make=(tag,text)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;return node;};
 const root=make('section');root.className='managed-work-overview';root.dataset.requestOverview=record.id;root.setAttribute('aria-label','请求概览');
 root.append(make('h3',record.name),make('p',serviceState||record.phase),make('p','原请求已保留，尚未创建后台工作；这不是已完成的任务。'));
 if(record.maintenance)root.append(make('p','内部运行问题由系统处理，无需回答技术问题或手动重试。'));
 root.append(make('h4','原始请求'),make('p',record.request||record.description||''));
 const details=make('details');details.dataset.requestDiagnostics='';details.append(make('summary','诊断信息（可选）'));
 if(record.maintenance?.bugId)details.append(make('p','内部问题记录：'+record.maintenance.bugId));
 details.append(make('pre',(record.events||[]).map(event=>[event.at,event.text,event.detail].filter(Boolean).join(' · ')).join('\n')));
 if(record.backstage?.reason)details.append(make('pre',record.backstage.reason));
 root.append(details);return root;
}
