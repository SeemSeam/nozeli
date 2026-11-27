// Offline elective lesson: management assistant conversation + skill migration.
//
// API (wired by app.mjs): mountGuidedAgentLesson() -> {open(opener)}
//   Appends the singleton <dialog id="guided-agent-lesson"> to document.body.
//   open(opener) shows it as a modal; on close, focus returns to the opener
//   launcher. Repeated mounts return the same singleton.
//
// Black-box contract (stable selectors for tests):
//   [data-agent-lesson-action="admin-send" | "migration" | "use-send" | "close" | "restart"]
//   textarea [data-agent-lesson-input="admin"], textarea [data-agent-lesson-input="use"]
//   select [data-agent-lesson-skill] (enabled skills only, placeholder value "")
//   Offline banner: [data-agent-lesson-offline]
//   Stage 2 reuses the real store-imports UI inside the dialog:
//   [data-import-action="sources"|"scan"|"analyze"|"install"|"enable"|"disable"],
//   checkboxes [data-import-source] / [data-import-analysis-candidate] /
//   [data-import-candidate] / [data-import-role].
//
// Stages: (1) assistant-vs-project conversation + explicit send, gated by the
// first admin-send; (2) migration via mountStoreImports, gated by the
// "migration" button; (3) first use, gated by a project-enabled role.
// Everything runs on an in-memory store: no IPC, no profile access, no models.
import './guided-agent-lesson.css';
import {mountStoreImports} from './store-imports.mjs';

const roleNames={frontdesk:'前台',orchestrator:'主控',worker:'Worker'};
const lessonProjectId='guided-agent-lesson-project';
const offlineBannerText='离线选修教学：全部回复与结果均为本地固定样例；不连接模型、不调用真实 IPC、不读取本机真实目录、账号或配置，不安装任何文件。';
const adminReply='（离线固定回复）已收到。这是管理助手会话：只使用独立全局上下文，可查看已登记项目、脱敏配置，并准备需要你明确确认的默认模型变更；不读取当前项目材料，也不会未经确认修改配置。阅读、批注与项目内派工请使用项目对话——两边材料与权限彼此独立，只有显式发送才会交接内容。';
const useReply=label=>'（离线样例输出）已按你明确选择的已启用技能「'+label+'」处理上条消息：\n1. 一句话概括：这是一次完整的首次使用闭环。\n2. 明确选择 → 明确发送 → 一次性输出，全部由本地固定文本完成。\n3. 真实产品中此处是技能实际结果；本教学未连接模型，也未执行任何配套程序。';

// Fixed in-memory catalog behind the injected store invoke. The compatible
// skill lives in the first source; the second source only yields a blocked
// candidate, so selection itself is part of the exercise.
function createLessonStore(){
  const catalog={
    'lesson-drafts':[{id:'lesson-candidate-reading',name:'示例文献速读',sourceId:'lesson-drafts',compatibility:'compatible',bytes:1420,resources:[{kind:'file',count:3},{kind:'directory',count:1}],skillId:'lesson-skill-reading',version:'1.0.0',digest:'lesson-offline-reading',description:'离线教学示例：文本阅读与摘要指导。',analysis:'离线固定分析：仅包含文本指导；适配范围为阅读与摘要，配套资源只做结构统计，不会安装或执行。',preview:'# 示例文献速读（离线正文）\n\n1. 先用一句话概括材料。\n2. 列出至多三个关键点，并标注依据位置。\n3. 不确定的内容明确标注，不编造。\n\n（离线教学固定文本；安装的正是这份文本。）'}],
    'lesson-archive':[{id:'lesson-candidate-legacy',name:'示例旧脚本包',sourceId:'lesson-archive',compatibility:'blocked',reason:'缺少 SKILL.md，宿主验证不通过',resources:[{kind:'file',count:7}]}]
  };
  const scans=new Map(),proposals=new Map(),entries=new Map();
  let scanSeq=0,proposalSeq=0;
  const snapshot=()=>[...entries.values()].map(entry=>({...entry,roles:entry.roles.map(role=>({...role}))}));
  function handle(channel,params={}){
    if(channel==='store.imports.sources')return ['lesson-drafts','lesson-archive'].map(id=>({id,name:id==='lesson-drafts'?'教学示例来源 A（内存数据）':'教学示例来源 B（内存数据）',status:id==='lesson-drafts'?'installed':'unverified'}));
    if(channel==='store.imports.scan'){
      const ids=params.sourceIds;
      if(!Array.isArray(ids)||!ids.length)throw Error('请先勾选至少一个来源。');
      const candidates=[];
      for(const id of ids)for(const row of catalog[id]??[])candidates.push({id:row.id,name:row.name,sourceId:row.sourceId,compatibility:row.compatibility,bytes:row.bytes,reason:row.reason,resources:row.resources});
      const scanId='lesson-scan-'+ ++scanSeq;
      scans.set(scanId,{candidates});
      return {scanId,candidates};
    }
    if(channel==='store.imports.analyze'){
      const scan=scans.get(params.scanId);
      if(!scan)throw Error('扫描结果已失效，请重新扫描。');
      const ids=params.candidateIds;
      if(!Array.isArray(ids)||!ids.length)throw Error('请先勾选要分析的技能。');
      const rows=ids.map(id=>scan.candidates.find(row=>row.id===id));
      if(rows.some(row=>!row))throw Error('所选技能不在本次扫描结果中。');
      const proposalId='lesson-proposal-'+ ++proposalSeq;
      const proposal={proposalId,candidates:rows.map(row=>{const full=catalog[row.sourceId].find(entry=>entry.id===row.id);return {...row,skillId:full.skillId,version:full.version,digest:full.digest,description:full.description,analysis:full.analysis,preview:full.preview};})};
      proposals.set(proposalId,proposal);
      return proposal;
    }
    if(channel==='store.imports.install'){
      const proposal=proposals.get(params.proposalId);
      if(!proposal)throw Error('分析结果已失效，请重新分析。');
      const grants=params.grants;
      if(!Array.isArray(grants)||!grants.length)throw Error('请先授权要安装的技能与角色。');
      for(const grant of grants){
        const row=proposal.candidates.find(candidate=>candidate.id===grant.candidateId);
        if(!row||!row.skillId||!row.version||!row.digest)throw Error('存在不可安装的技能，请重新核对授权。');
        const roles=grant.roles;
        if(!Array.isArray(roles)||!roles.length||roles.some(role=>!(role in roleNames)))throw Error('每个技能至少需要授权一个有效角色。');
        const previous=new Map(entries.get(row.skillId)?.roles.map(role=>[role.id,role.enabled]));
        entries.set(row.skillId,{id:row.skillId,name:row.name,description:row.description,version:row.version,sourceId:row.sourceId,roles:roles.map(id=>({id,name:roleNames[id],enabled:previous.get(id)===true}))});
      }
      return {installed:grants.length};
    }
    if(channel==='store.imports.list')return snapshot();
    if(channel==='store.imports.enable'||channel==='store.imports.disable'){
      const entry=entries.get(params.id);
      if(!entry)throw Error('未找到该已安装技能。');
      const role=entry.roles.find(item=>item.id===params.role);
      if(!role)throw Error('该角色未被授权，无法更改启用状态。');
      role.enabled=channel==='store.imports.enable';
      return snapshot();
    }
    throw Error('离线教学不提供「'+channel+'」样例。');
  }
  return {
    async invoke(channel,params={}){try{return {ok:true,value:handle(channel,params)};}catch(error){return {ok:false,error:{message:error?.message||String(error)}};}},
    reset(){scans.clear();proposals.clear();entries.clear();scanSeq=proposalSeq=0;},
    snapshot
  };
}

let mounted=null;
export function mountGuidedAgentLesson(){
  if(mounted)return mounted;
  const el=(tag,text,attrs={})=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);return node;};
  const dialog=el('dialog',null,{id:'guided-agent-lesson','aria-labelledby':'guided-agent-lesson-title'});
  const heading=el('header',null,{class:'lesson-heading'});
  heading.append(el('h2','管理助手与技能移植 · 选修教学',{id:'guided-agent-lesson-title'}));
  const close=el('button','关闭',{type:'button','data-agent-lesson-action':'close','aria-label':'关闭选修教学'});
  heading.append(close);
  dialog.append(heading,el('p',offlineBannerText,{class:'lesson-offline',role:'note','data-agent-lesson-offline':''}));

  // Stage 1: management assistant conversation (global context, explicit send).
  const stage1=el('section',null,{class:'lesson-stage','aria-label':'第一步：管理助手对话'});
  stage1.append(el('h3','第一步 · 管理助手对话（全局上下文）'));
  stage1.append(el('p','管理助手使用独立全局上下文：查看已登记项目、脱敏配置，准备需你确认的变更；它不读取当前项目材料。项目对话才读取项目材料并承接派工。请在下方输入（可随时修改），并明确点击发送——没有显式发送就不会交接任何内容。Enter 换行，Ctrl/Cmd+Enter 也可发送。',{class:'lesson-hint'}));
  const adminPlaceholder='尚未发送。先输入一条管理请求，例如「请查看当前已登记的项目，并说明哪些配置需要我确认」。';
  const adminTranscript=el('div',null,{class:'lesson-transcript',role:'log','aria-live':'polite','aria-label':'管理助手练习对话记录'});
  adminTranscript.append(el('p',adminPlaceholder,{class:'lesson-event lesson-placeholder'}));
  const adminInput=el('textarea',null,{class:'lesson-input','data-agent-lesson-input':'admin',rows:'3','aria-label':'管理助手练习输入',placeholder:'例如：请查看当前已登记的项目，并说明哪些配置需要我确认。'});
  const adminSend=el('button','发送给管理助手',{type:'button','data-agent-lesson-action':'admin-send'});
  const adminStatus=el('p','',{class:'lesson-status',role:'status'});
  const adminComposer=el('div',null,{class:'lesson-composer'});
  adminComposer.append(adminInput,adminSend);
  stage1.append(adminTranscript,adminComposer,adminStatus);

  // Stage 2: skill migration through the real store-imports UI.
  const stage2=el('section',null,{class:'lesson-stage',hidden:'','aria-label':'第二步：技能移植'});
  stage2.append(el('h3','第二步 · 技能移植：来源 → 扫描 → 明确分析 → 授权 → 安装 → 启用'));
  stage2.append(el('p','下面使用真实的资源商店导入界面，数据全部来自内存固定样例。注意两个边界：只有点击「发送所选技能给模型分析」才会分析，且只发送勾选技能的 SKILL.md 正文；「安装」与「为当前项目启用」是两个独立决定——先只安装，安装完成后面板会切到「已导入的本地技能」，再为示例项目启用你授权的角色。',{class:'lesson-hint'}));
  const migration=el('button','开始技能移植练习',{type:'button','data-agent-lesson-action':'migration'});
  const storeSearch=el('input',null,{type:'search',hidden:'','aria-hidden':'true',tabindex:'-1'});
  const storeHost=el('div',null,{class:'store-import-panel'});
  const migrationStatus=el('p','',{class:'lesson-status',role:'status'});
  stage2.append(migration,storeSearch,storeHost,migrationStatus);

  // Stage 3: first use of an enabled skill in a project conversation.
  const stage3=el('section',null,{class:'lesson-stage',hidden:'','aria-label':'第三步：首次使用已启用技能'});
  stage3.append(el('h3','第三步 · 项目对话中首次使用已启用技能'));
  stage3.append(el('p','回到项目对话一侧：先在下拉框中明确选择刚才启用的技能，再输入内容并只发送一次。发送会得到固定的离线样例输出，用于确认首次使用闭环；真实使用时这里会是该技能的实际结果。',{class:'lesson-hint'}));
  const skillSelect=el('select',null,{class:'lesson-select','data-agent-lesson-skill':'','aria-label':'选择已启用的技能'});
  const usePlaceholderOption=el('option','选择要使用的已启用技能…',{value:''});
  skillSelect.append(usePlaceholderOption);
  const useInput=el('textarea',null,{class:'lesson-input','data-agent-lesson-input':'use',rows:'3','aria-label':'首次使用练习输入',placeholder:'例如：请用该技能概括当前材料。'});
  const useSend=el('button','发送一次',{type:'button','data-agent-lesson-action':'use-send'});
  const usePlaceholder='尚未发送。先选择技能，再输入并明确发送一次。';
  const useTranscript=el('div',null,{class:'lesson-transcript',role:'log','aria-live':'polite','aria-label':'技能首次使用对话记录'});
  useTranscript.append(el('p',usePlaceholder,{class:'lesson-event lesson-placeholder'}));
  const useStatus=el('p','',{class:'lesson-status',role:'status'});
  const useComposer=el('div',null,{class:'lesson-composer'});
  useComposer.append(skillSelect,useInput,useSend);
  stage3.append(useComposer,useTranscript,useStatus);

  const footer=el('footer',null,{class:'lesson-footer'});
  const restart=el('button','重新开始教学',{type:'button','data-agent-lesson-action':'restart'});
  const progress=el('p','',{class:'lesson-progress',role:'status'});
  footer.append(restart,progress);
  const body=el('div',null,{class:'lesson-body'});
  body.append(stage1,stage2,stage3);
  dialog.append(body,footer);
  document.body.append(dialog);

  const store=createLessonStore();
  let projectScope=false,adminDone=false,migrationStarted=false,useDone=false,openerElement=null;
  const later=fn=>{setTimeout(fn,0);};
  function appendEvent(container,text){container.querySelector('.lesson-placeholder')?.remove();container.append(el('p',text,{class:'lesson-event'}));container.scrollTop=container.scrollHeight;}
  function appendMessage(container,speaker,text){container.querySelector('.lesson-placeholder')?.remove();const article=el('article',null,{class:'lesson-message'});article.append(el('strong',speaker),el('div',text,{class:'lesson-message-body'}));container.append(article);container.scrollTop=container.scrollHeight;}
  // mountStoreImports drives the real import/library flow; every invoke stays
  // in memory. Install never auto-enables: right after a successful install
  // the lesson flips to a lesson-scoped project and shows the library view,
  // where enablement is a separate explicit click.
  const imports=mountStoreImports(storeHost,{
    invoke:async (channel,params)=>{
      const result=await store.invoke(channel,params);
      if(result.ok&&channel==='store.imports.install')later(()=>{projectScope=true;imports.setMode('library');render();});
      else if(result.ok&&(channel==='store.imports.enable'||channel==='store.imports.disable'))later(render);
      return result;
    },
    getProjectId:()=>projectScope?lessonProjectId:null,
    search:storeSearch,
    openAnalysis:async ()=>{
      appendEvent(adminTranscript,'正在分析所选技能（离线固定流程；真实产品中此进度显示在管理助手对话窗口）。');
      return message=>{appendEvent(adminTranscript,message||'分析结束。');};
    }
  });
  function enabledRoles(){const rows=[];for(const entry of store.snapshot())for(const role of entry.roles)if(role.enabled)rows.push({value:entry.id+'::'+role.id,label:entry.name+' · '+role.name});return rows;}
  function render(){
    const enabled=enabledRoles();
    stage2.hidden=!adminDone;
    migration.hidden=migrationStarted;
    stage3.hidden=!enabled.length;
    const previous=skillSelect.value;
    skillSelect.replaceChildren(usePlaceholderOption);
    for(const row of enabled)skillSelect.append(el('option',row.label,{value:row.value}));
    skillSelect.value=[...skillSelect.options].some(option=>option.value===previous)?previous:'';
    adminSend.disabled=adminDone||!adminInput.value.trim();
    skillSelect.disabled=useDone;
    useInput.readOnly=useDone;
    useSend.disabled=useDone||!skillSelect.value||!useInput.value.trim();
    adminStatus.textContent=adminDone?'第一步完成：内容只在明确发送后交接。':'';
    const installed=store.snapshot().length>0;
    migrationStatus.textContent=!migrationStarted?'':!installed?'按面板步骤练习：选择来源 → 扫描 → 勾选技能并明确分析 → 核对文本与角色授权 → 安装。':!enabled.length?'已安装（未启用）。请在「已导入的本地技能」列表中点击「在本项目启用」。':'第二步完成：安装与项目启用是两个独立决定。';
    useStatus.textContent=useDone?'教学完成：明确选择 → 明确发送 → 固定离线样例输出。':'';
    progress.textContent='进度：管理对话'+(adminDone?'已完成':'未完成')+' · 技能移植'+(!migrationStarted?'未开始':!installed?'进行中':enabled.length?'已完成':'进行中')+' · 首次使用'+(useDone?'已完成':'未完成');
  }
  const submitWith=control=>event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.isComposing){event.preventDefault();if(!control.disabled)control.click();}};
  adminInput.addEventListener('input',render);
  adminInput.addEventListener('keydown',submitWith(adminSend));
  adminSend.addEventListener('click',()=>{
    if(adminSend.disabled)return;
    appendMessage(adminTranscript,'你',adminInput.value);
    appendMessage(adminTranscript,'管理助手（离线固定回复）',adminReply);
    adminDone=true;
    render();
    migration.focus();
  });
  migration.addEventListener('click',()=>{
    if(migrationStarted)return;
    migrationStarted=true;
    projectScope=false;
    imports.setMode('import');
    render();
    storeHost.querySelector('button:not([disabled])')?.focus();
  });
  skillSelect.addEventListener('change',render);
  useInput.addEventListener('input',render);
  useInput.addEventListener('keydown',submitWith(useSend));
  useSend.addEventListener('click',()=>{
    if(useSend.disabled)return;
    const label=skillSelect.selectedOptions[0]?.textContent||'';
    appendMessage(useTranscript,'你',useInput.value);
    appendMessage(useTranscript,'项目对话 · '+label+'（离线固定样例输出）',useReply(label));
    useDone=true;
    render();
    restart.focus();
  });
  close.addEventListener('click',()=>dialog.close());
  restart.addEventListener('click',()=>{
    store.reset();
    projectScope=adminDone=migrationStarted=useDone=false;
    imports.setMode('');
    adminInput.value='';
    useInput.value='';
    adminTranscript.replaceChildren(el('p',adminPlaceholder,{class:'lesson-event lesson-placeholder'}));
    useTranscript.replaceChildren(el('p',usePlaceholder,{class:'lesson-event lesson-placeholder'}));
    render();
    adminInput.focus();
  });
  dialog.addEventListener('close',()=>{openerElement?.focus?.();openerElement=null;});
  function open(opener){
    if(opener&&typeof opener.focus==='function')openerElement=opener;
    if(!dialog.open)dialog.showModal();
    const target=!adminDone?adminInput:!migrationStarted?migration:stage3.hidden?null:useInput;
    target?.focus();
  }
  render();
  mounted={open};
  return mounted;
}
