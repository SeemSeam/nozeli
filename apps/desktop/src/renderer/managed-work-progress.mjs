import './managed-work-progress.css';

// M3 查看保留进展：只读呈现层。任务中心的简明中文在前，技术细节收进可选
// 折叠区。本模块不直接发起 managed IPC、不改任务状态、不提供任何“继续/
// 恢复/重放”入口——打开与复制动作全部经调用方（面板）注入的回调完成。
//
// ── 挂载契约（父面板接线；稳定导出）─────────────────────────────────────
//   const view=mountWorkProgress({root, document, loadProgress,
//     onOpenReport, onOpenFile, onListFiles, onCopyText, onReturnReading});
//     loadProgress():Promise<DTO>   面侧调用 managed.work.progress.read
//                                    {projectId,workId} 并返回 DTO
//     onOpenReport(pub)             打开冻结报告；pub.open={op:'history.read',
//                                    args}；当前成果报告另带 pub.reviewOpen=
//                                    {op:'review.read',args}；面板可先关闭本
//                                    视图所在 dialog 再打开冻结内容
//     onOpenFile(pub,file)          打开冻结文件；file.open={op:'artifact.read',
//                                    args:{projectId,objectId,relPath}}
//     onListFiles(pub)              可选；完整文件列表
//                                    pub.files.listOpen={op:'artifact.list',args}
//     onCopyText(text,label)        可选；复制原文；缺省走宿主
//                                    document.clipboard（window.nozeli.invoke
//                                    ('document.clipboard',{action:'write'}))
//     onReturnReading()             可选；就近“返回阅读”动作（U3-02）。提供时
//                                    首屏动作区渲染 [data-progress-return-
//                                    reading]；不提供则只留面板自己的返回入口
//   view.node / view.refresh() / view.close() / view.closed
//     refresh 重读并做竞态保护（过期结果不覆盖新结果）；close 撤销节点、清
//     理挂起计时器，之后 refresh 为 no-op。
//
// ── 低层纯渲染（测试与自定义容器用）────────────────────────────────────
//   renderWorkProgress({document,progress,onOpenReport,onOpenFile,onListFiles,
//     onCopyText,onReturnReading}) → HTMLElement
//     section.managed-work-progress[data-work-progress=workId]
//     首屏：当前情况（DTO next.notices 平实要点）+ 就近真实动作；诊断原文、
//     原始时间与传输记录一律收进默认收起的 <details>，完整保留不删改。
//     钩子属性：[data-progress-open-report=objectId] [data-progress-file=
//     "objectId|relPath"] [data-progress-list-files=objectId]
//     [data-progress-copy="request|supplement:jobId"] [data-progress-return-reading]
//     [data-progress-diagnostics=jobId] [data-progress-unverified-diagnostics]
//     [data-progress-advanced]
const statusKinds={failed:'failure',pending:'pending',unconfirmed:'unconfirmed'};

const copyViaHost=async(text,label)=>{
  if(typeof window!=='undefined'&&window.nozeli?.invoke){
    const result=await window.nozeli.invoke('document.clipboard',{action:'write',text});
    if(result&&result.ok===false)throw Error(result.error?.message||'复制失败');
    return;
  }
  if(typeof navigator!=='undefined'&&navigator.clipboard){await navigator.clipboard.writeText(text);return;}
  throw Error(label+'：当前环境不支持复制');
};

export function mountWorkProgress({root,document,loadProgress,onOpenReport=null,onOpenFile=null,onListFiles=null,onCopyText=null,onReturnReading=null}){
  const timers=new Set();
  let closed=false,token=0;
  const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;};
  const frame=make('div','managed-work-progress-mount');
  const status=make('p','managed-work-progress-note','正在读取已保留的事实…');
  frame.append(status);
  root.append(frame);
  const render=progress=>frame.replaceChildren(renderWorkProgress({document,progress,onOpenReport,onOpenFile,onListFiles,onCopyText,onReturnReading,trackTimer:timer=>{timers.add(timer);return timer;}}));
  const refresh=async()=>{
    if(closed)return;
    const current=++token;
    frame.replaceChildren(status);
    status.className='managed-work-progress-note';
    status.textContent='正在读取已保留的事实…';
    try{
      const progress=await loadProgress();
      if(closed||current!==token)return;
      render(progress);
    }catch(error){
      if(closed||current!==token)return;
      status.className='managed-work-progress-error';
      status.textContent='读取保留进展失败：'+(error?.message||error);
      const retry=make('button','managed-work-progress-action','重试');
      retry.type='button';
      retry.addEventListener('click',()=>{if(!closed)refresh();});
      frame.replaceChildren(status,retry);
    }
  };
  const close=()=>{
    if(closed)return;
    closed=true;
    for(const timer of timers)clearTimeout(timer);
    timers.clear();
    frame.remove();
  };
  void refresh();
  return {get node(){return frame;},refresh,close,get closed(){return closed;}};
}

export function renderWorkProgress({document,progress,onOpenReport=null,onOpenFile=null,onListFiles=null,onCopyText=null,onReturnReading=null,trackTimer=null}){
  const later=fn=>trackTimer?trackTimer(fn):fn;
  const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;};

  const root=make('section','managed-work-progress');
  root.dataset.workProgress=progress.workId;
  root.setAttribute('aria-label','保留的进展');

  const actionButton=(label,onClick)=>{
    const node=make('button','managed-work-progress-action',label);
    node.type='button';
    node.addEventListener('click',()=>{if(!node.disabled)onClick(node);});
    return node;
  };
  const copyButton=(label,text,copyLabel,dataAttr)=>{
    const node=actionButton(label,async self=>{
      try{
        if(typeof onCopyText==='function')await onCopyText(text,copyLabel);
        else await copyViaHost(text,copyLabel);
        const noted=make('span','managed-work-progress-copy-done','已复制');
        self.after(noted);later(setTimeout(()=>noted.remove(),1600));
      }catch(error){
        const noted=make('span','managed-work-progress-copy-error','复制失败：'+error.message);
        self.after(noted);later(setTimeout(()=>noted.remove(),2600));
      }
    });
    if(dataAttr)node.setAttribute('data-progress-copy',dataAttr);
    return node;
  };

  const header=make('header','managed-work-progress-header');
  header.append(make('h3','managed-work-progress-title','保留的进展'));
  header.append(make('p','managed-work-progress-status',(progress.work?.statusLabel||'状态待确认')+(progress.work?.readOnly?' · 历史只读':'')));
  header.append(make('p','managed-work-progress-summary',progress.next?.summary||''));
  root.append(header);

  // U3-02 首屏：先用平实语言说清“补充是否完成、哪些还在、任务能否继续”，
  // 再把真实可用的动作就近放在一起。诊断原文/原始时间/传输记录不在首屏。
  const supplements=progress.supplements?.items||[];
  const focus=progress.publications?.items?.find(publication=>publication.current)||progress.publications?.items?.[0]||null;
  const now=make('section','managed-work-progress-now');
  now.dataset.progressNow='';
  now.append(make('h4','','当前情况'));
  const noticeList=make('ul','managed-work-progress-notices');
  for(const notice of (progress.next?.notices||[])){
    const item=make('li','managed-work-progress-notice-'+(notice.key||'state'),notice.text);
    item.dataset.progressNotice=notice.key||'state';
    noticeList.append(item);
  }
  if(noticeList.childNodes.length)now.append(noticeList);
  const nowActions=make('div','managed-work-progress-actions managed-work-progress-now-actions');
  if(focus&&typeof onOpenReport==='function'){
    const open=actionButton(focus.current?'打开最新报告':'打开最近的报告',()=>onOpenReport(focus));
    open.setAttribute('data-progress-open-report',focus.objectId);
    nowActions.append(open);
  }
  if(focus&&typeof onOpenFile==='function')for(const file of (focus.files?.items||[]).slice(0,3)){
    const fileButton=actionButton(file.relPath,()=>onOpenFile(focus,file));
    fileButton.classList.add('managed-work-progress-file');
    fileButton.setAttribute('data-progress-file',focus.objectId+'|'+file.relPath);
    fileButton.title=file.size!=null?file.relPath+' · '+file.size+' 字节':file.relPath;
    nowActions.append(fileButton);
  }
  if(focus?.files&&focus.files.total>3)nowActions.append(make('span','managed-work-progress-note','其余文件见下方“已保留的报告”'));
  const copyTarget=supplements.find(supplement=>supplement.kind==='failed')||supplements[0]||null;
  if(copyTarget?.text)nowActions.append(copyButton('复制补充原文',copyTarget.text,'补充原文','supplement:'+copyTarget.jobId));
  if(progress.request?.text)nowActions.append(copyButton('复制原始请求',progress.request.text,'原始请求','request'));
  if(typeof onReturnReading==='function'){
    const back=actionButton('返回阅读',()=>onReturnReading());
    back.setAttribute('data-progress-return-reading','');
    back.classList.add('managed-work-progress-return');
    nowActions.append(back);
  }
  if(nowActions.childNodes.length)now.append(nowActions);
  root.append(now);

  // 原始请求：原文展示（DTO 保证截断必带说明），一键复制。
  const request=make('section','managed-work-progress-request');
  request.append(make('h4','','原始请求'));
  request.append(make('p','managed-work-progress-request-text',progress.request?.text||'（账本中没有可读的原文；这不是丢失声明，可从时间线核对原始输入。）'));
  if(progress.request?.truncated&&progress.request.note)request.append(make('p','managed-work-progress-note',progress.request.note));
  if(progress.request?.text)request.append(copyButton('复制原文',progress.request.text,'原始请求','request'));
  root.append(request);

  // 已保留的报告：冻结正文/文件只给打开入口，绝不内嵌输出内容。
  const publications=make('section','managed-work-progress-publications');
  publications.append(make('h4','','已保留的报告'));
  publications.append(make('p','managed-work-progress-note',progress.publications?.note||''));
  for(const publication of (progress.publications?.items||[])){
    const row=make('div','managed-work-progress-publication');
    row.dataset.progressReport=publication.objectId;
    // 版次用发布序号（publicationNumber，与其他入口一致的“第 N 版”），
    // 绝不混入 Work 修订号，避免 U2-01 式同屏歧义。
    // 原始发布时间（ISO 原文）属诊断记录，收进“高级详情”，不进首屏。
    const version=publication.current?'当前版':publication.publicationNumber!=null?`旧版（第 ${publication.publicationNumber} 版）`:'旧版';
    row.append(make('p','managed-work-progress-publication-title',(publication.kindLabel||'报告')+' · '+version));
    if(publication.title)row.append(make('p','managed-work-progress-publication-name',publication.title));
    if(publication.excerpt)row.append(make('p','managed-work-progress-publication-excerpt',publication.excerpt));
    const actions=make('div','managed-work-progress-actions');
    if(typeof onOpenReport==='function'){
      const open=actionButton('打开报告',()=>onOpenReport(publication));
      open.setAttribute('data-progress-open-report',publication.objectId);
      actions.append(open);
    }
    for(const file of (publication.files?.items||[])){
      if(typeof onOpenFile==='function'){
        const fileButton=actionButton(file.relPath,()=>onOpenFile(publication,file));
        fileButton.classList.add('managed-work-progress-file');
        fileButton.setAttribute('data-progress-file',publication.objectId+'|'+file.relPath);
        fileButton.title=file.size!=null?file.relPath+' · '+file.size+' 字节':file.relPath;
        actions.append(fileButton);
      }else{
        const name=make('span','managed-work-progress-file-name',file.relPath);
        name.title=file.relPath;
        actions.append(name);
      }
    }
    if(publication.files?.omitted>0){
      if(typeof onListFiles==='function'){
        const more=actionButton('查看全部文件',()=>onListFiles(publication));
        more.setAttribute('data-progress-list-files',publication.objectId);
        actions.append(more);
      }
      actions.append(make('span','managed-work-progress-note',`另有 ${publication.files.omitted} 个文件未列出`));
    }
    if(actions.childNodes.length)row.append(actions);
    publications.append(row);
  }
  if(progress.publications?.omitted>0)publications.append(make('p','managed-work-progress-note',`另有 ${progress.publications.omitted} 份更早的发布未列出；它们仍保留在历史中。`));
  root.append(publications);

  // 未处理的补充：首屏只留平实状态与原文；失败原文、中断原因、传输记录
  // 和原始时间完整保留在默认收起的“失败信息与传输记录”里，不删改。
  if(supplements.length){
    const section=make('section','managed-work-progress-supplements');
    section.append(make('h4','','未处理的补充'));
    for(const supplement of supplements){
      const row=make('div','managed-work-progress-supplement'+(statusKinds[supplement.kind]?' managed-work-progress-supplement-'+statusKinds[supplement.kind]:''));
      row.dataset.progressSupplement=supplement.jobId;
      row.append(make('p','managed-work-progress-supplement-status',supplement.statusLabel+(supplement.retried?' · 已有重试记录':'')));
      if(supplement.text)row.append(make('p','managed-work-progress-supplement-text',supplement.text));
      if(supplement.truncated)row.append(make('p','managed-work-progress-note','这条补充原文较长，此处截断显示；完整原文保留在任务记录中。'));
      const diagnostics=[];
      if(supplement.error)diagnostics.push(['失败信息原文',supplement.error]);
      if(supplement.interruptionReason)diagnostics.push(['中断原因',supplement.interruptionReason]);
      if(supplement.transport)diagnostics.push(['原生传输记录',`${supplement.transport.attempts} 次尝试 · 最近状态 ${supplement.transport.lastStatus??'未知'}${supplement.transport.definitiveRejection?' · 明确拒绝':''}`]);
      if(supplement.at)diagnostics.push(['接收时间（原始记录）',supplement.at]);
      if(supplement.finishedAt)diagnostics.push(['结束时间（原始记录）',supplement.finishedAt]);
      if(diagnostics.length){
        const detail=make('details','managed-work-progress-diagnostics');
        detail.dataset.progressDiagnostics=supplement.jobId;
        detail.append(make('summary','','失败信息与传输记录（技术详情）'));
        const facts=make('dl');
        for(const [term,value] of diagnostics)facts.append(make('dt','',term),make('dd','',value));
        detail.append(facts);
        row.append(detail);
      }
      if(supplement.text)row.append(copyButton('复制补充原文',supplement.text,'补充原文','supplement:'+supplement.jobId));
      section.append(row);
    }
    if(progress.supplements?.omitted>0)section.append(make('p','managed-work-progress-note',`另有 ${progress.supplements.omitted} 条未列出。`));
    root.append(section);
  }

  // 尚不能确认的部分：只陈述由 durable 事实推导的未知，不预设“已保留”。
  if(progress.unverified?.length){
    const section=make('section','managed-work-progress-unverified');
    section.append(make('h4','','尚不能确认的部分'));
    const list=make('ul');
    for(const fact of progress.unverified)list.append(make('li','',fact.text));
    section.append(list);
    if(progress.unverified.some(fact=>fact.code||fact.detail)){
      const detail=make('details','managed-work-progress-diagnostics');
      detail.dataset.progressUnverifiedDiagnostics='';
      detail.append(make('summary','','诊断代码与原文（技术详情）'));
      const facts=make('dl');
      for(const fact of progress.unverified)facts.append(make('dt','',fact.code||'（无代码）'),make('dd','',fact.detail||'（无更多原文）'));
      detail.append(facts);
      section.append(detail);
    }
    root.append(section);
  }

  // 下一步：具体、安全；明确没有自动恢复。
  const next=make('section','managed-work-progress-next');
  next.append(make('h4','','下一步'));
  const steps=make('ol');
  for(const step of (progress.next?.steps||[]))steps.append(make('li','',step));
  next.append(steps,make('p','managed-work-progress-note','查看与复制不会改变任务状态，也不会触发任何执行。'));
  root.append(next);

  // 高级详情（可选）：身份、版本与只读引用，供核对，不参与主叙事。
  const advanced=make('details','managed-work-progress-advanced');
  advanced.dataset.progressAdvanced='';
  advanced.append(make('summary','','高级详情（可选）'));
  const body=make('div','managed-work-progress-advanced-body');
  const facts=make('dl');
  const fact=(term,value)=>{facts.append(make('dt','',term),make('dd','',value));};
  fact('Work',progress.workId);
  if(progress.work?.revision!=null)fact('当前版本','第 '+progress.work.revision+' 版');
  if(progress.work?.threadId)fact('原线程',progress.work.threadId);
  if(progress.work?.readOnly)fact('历史身份','只读历史会话');
  for(const publication of (progress.publications?.items||[]))fact('报告 '+(publication.kindLabel||'')+'（'+(publication.current?'当前':'旧版')+(publication.publicationNumber!=null?' · 第 '+publication.publicationNumber+' 版':'')+'）',publication.objectId+(publication.at?' · 发布时间 '+publication.at:'')+' · 打开方式 '+publication.open.op+(publication.reviewOpen?' 或 '+publication.reviewOpen.op:''));
  for(const supplement of supplements)fact('补充 '+supplement.jobId,supplement.status+(supplement.transport?` · 传输 ${supplement.transport.attempts} 次`:'')+(supplement.at?' · 接收 '+supplement.at:'')+(supplement.finishedAt?' · 结束 '+supplement.finishedAt:''));
  body.append(facts);
  advanced.append(body);
  root.append(advanced);

  return root;
}
