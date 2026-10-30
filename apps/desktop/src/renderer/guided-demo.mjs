import './guided-demo.css';
import {demoChapters,demoIdentity,unwrapDemo,createDemoActions} from '../domain/guided-demo.mjs';
const flow=demoChapters[0];
export function createStartPage({project,start,browse,compact=false}){
  const root=document.createElement('section');root.className='guided-start'+(project?' guided-start-project':' guided-start-welcome')+(compact?' guided-start-compact':'');if(!compact)root.id='start-page';
  const eyebrow=document.createElement('p');eyebrow.className='guided-start-eyebrow';eyebrow.textContent=project?'推荐功能 / 从当前项目开始':'NOZELI / 阅读、批注与 AGENT 协作';
  const heading=document.createElement('h2');heading.textContent=project?(compact?'从这里继续':'选一份材料，试试这些功能'):'不止打开文件，\n让工作真正连起来。';
  const description=document.createElement('p');description.className='guided-start-description';description.textContent=project?(browse?'从左侧选择文件，开始批注、讨论或并排阅读；后台任务的成果可以随时回来审核。':'在主窗口选择材料，或将此分区返回主工作区，再继续阅读与协作。'):'在原文上留下想法，让 Agent 继续工作，再回到报告与文件差异中审阅结果。先从下面四个功能开始。';
  root.append(eyebrow,heading,description);
  const actions=document.createElement('div');actions.className='guided-start-actions';root.append(actions);
  const button=(text,run,id,primary=false)=>{const b=document.createElement('button');b.type='button';b.textContent=text;if(id)b.id=id;if(primary)b.className='guided-start-primary';b.onclick=run;actions.append(b);return b;};
  if(project){if(browse)button('浏览项目文件',browse,undefined,true).dataset.startBrowse='true';}
  else{button('打开本地项目',()=>document.getElementById('pick-project')?.click(),undefined,true);button('体验演示',start,compact?undefined:'start-demo-entry');}
  if(!compact){
    const features=document.createElement('dl');features.className='guided-start-features';
    const items=[
      ['01 / 批注与选区讨论','直接在“这里”留下想法',project?'打开文档后选中文字，或在支持的画面中框选区域，添加批注或发起讨论。批注先留在本地，明确发送才交给 Agent。':'打开材料，选中文字或框选区域，即可添加批注、围绕原文讨论；图片位置也能用涂鸦说明。保存批注不会自动派工。'],
      ['02 / 任务闭环','把交付变成可审阅的成果',project?'将需要持续推进的工作交到后台。从右侧工作与待办查看问题、阅读报告和文件差异，再接受成果或交回原 Worker 修改。':'后台 Worker 交付报告与候选文件。你可以核对差异、反馈修改，再明确接受成果；不是只有一句“已完成”。'],
      ['03 / 分屏阅读','把材料与对话摆在一起',project?'拖动标签到分区边缘拆分，或通过主窗口布局入口调整布局。并排放置材料、对话和报告，减少来回切换。':'文档、对话与报告可以分屏摆放。打开项目后，拖动标签拆分工作区，一边看材料，一边讨论或核对修改。'],
      ['04 / 独立窗口','让工作面延伸到另一块屏幕',project?'从内容菜单将分区脱离为独立窗口，需要时再返回主工作区。移动的是原内容，未保存编辑和会话仍保留。':'将内容脱离为独立窗口，放到另一块屏幕；也可以再移回主工作区，不必复制文档或重新开始会话。']
    ];
    for(const [kicker,title,detail]of items){const item=document.createElement('div'),term=document.createElement('dt'),body=document.createElement('dd'),small=document.createElement('span');small.textContent=kicker;term.append(small,document.createTextNode(title));body.textContent=detail;item.append(term,body);features.append(item);}root.append(features);
    const foot=document.createElement('p');foot.className='guided-start-footnote';foot.textContent=project?'打开文件不会自动启动 Agent；保存批注不会自动派工。':'先打开本地目录即可阅读与编辑。需要 AI 协作时，再到设置中配置模型。';root.append(foot);
  }
  return root;
}

export function mountGuidedDemo({invoke,subscribe,openProject,openFile,captureReturn,restoreReturn,onExit=async()=>{},getProjectId,onError=()=>{}}){
  let executedSteps=new Set();
  let session=null,busy=false,flight=null,token=0,returnState=null,disposed=false,transitionQueue=Promise.resolve(),failureMessage='',stopBeforeStep=null,creating=false,exiting=false,cleanupReceipt=null,captionOverride='',publishedUi='',lastSemantic='',demoSettingsOpen=false,demoSettingsSeenOpen=false;
  const runAction=createDemoActions({invoke}),controls=[],actions=new Map();
  const add=(id,label,run,primary=false)=>{const control={id,label,disabled:false,primary};controls.push(control);actions.set(id,run);return control;};
  const play=add('play','继续',async intent=>{
    if(intent==='pause'){if(session.status==='playing')await transition('pause');return;}
    if(intent!=='play')throw Error('未知播放操作');
    if(getProjectId()!==session.projectId)await openProject(session.projectId);
    stopBeforeStep=null;await transition('play');
  },true);
  async function pauseForNavigation(){if(!session||flight)throw Error('当前操作正在收尾，请稍候');if(session.status!=='removed'){if(getProjectId()!==session.projectId)await openProject(session.projectId);await transition('pause');}}
  // One atomic seek: the authoritative playback status lives in the main
  // session, so the jump commits with (not before) the user's resume intent.
  // Reading a mirrored status here and replaying pause/play as two commands
  // was the pause-after-seek race.
  async function seekTo(index,resume=false){
    if(exiting||creating||!session)return;
    if(!Number.isSafeInteger(index)||index<0||index>=flow.steps.length)throw Error('演示位置无效');
    hideHint();stopBeforeStep=null;captionOverride='';failureMessage='';
    await transition('seek',{chapterId:flow.id,stepIndex:index,...(resume?{resume:true}:{})});
    const step=flow.steps[index];
    // A seek never publishes the target step's explanation: only the neutral
    // preparation state. The explanation waits for that step's own receipt.
    if(session&&session.stepIndex===index&&step&&session.status!=='removed')prepareHint(step);
  }
  async function exitDemo(){
    if(exiting||!session)return;
    const owner=session;exiting=true;hideHint();demoSettingsOpen=false;demoSettingsSeenOpen=false;window.dispatchEvent(new Event('nozeli-demo-settings-close'));paint();
    try{
      if(!['stopped','removed'].includes(owner.status))await transition('stop',{},true);
      await restoreReturn(returnState);
      unwrapDemo(await invoke('demo.exit',demoIdentity(owner)));
      await onExit(owner.projectId);
      if(session?.id===owner.id){token++;session=null;stopBeforeStep=null;paint();}
    }finally{exiting=false;paint();}
  }
  const end=add('stop','结束演示',exitDemo,true);
  function fail(error){failureMessage=error.message;onError(error.message);void transition('pause').catch(()=>{});paint();}
  function paint(){
    if(disposed)return;
    if(currentHint&&currentHint.stepIndex===session?.stepIndex)publishHint();
    let model=null;
    if(session){
      const step=flow.steps[session.stepIndex||0];
      play.label=session.status==='playing'?'暂停':'继续';
      play.disabled=creating||exiting||['finished','removed'].includes(session.status)||Boolean(flight&&session.status!=='playing');
      end.disabled=creating||exiting;
      const terminal=['finished','stopped','removed'].includes(session.status);
      const cleanup=terminal&&(cleanupReceipt?.trashed?'已移至回收站。':cleanupReceipt?.removed?'已移除入口，文件保留。':cleanupReceipt?.complete&&cleanupReceipt.action==='clean-local'?'本机视图已重置，原文件保留。':'');
      const caption=exiting?'正在退出演示，保留示例与编辑…':creating?'正在准备独立示例副本…':flight&&session.status!=='playing'?'当前操作正在收尾；不会继续下一步。':cleanup||(terminal?'演示已结束，示例文件保留。':failureMessage?'演示已暂停：'+failureMessage:session.error?.message?'演示已暂停：'+session.error.message:captionOverride||step?.caption||'本章已完成。');
      // The settings dialog the tour itself opens must not hide the playback
      // controls: pause/end stay reachable while the visitor reads the
      // sections. The flag survives paints before showModal() lands and only
      // clears after the dialog has actually been seen open and then closed.
      if(demoSettingsOpen){const settingsOpen=document.getElementById('settings-dialog')?.open;if(settingsOpen)demoSettingsSeenOpen=true;else if(demoSettingsSeenOpen)demoSettingsOpen=false;}
      const modal=[...document.querySelectorAll('dialog[open],[aria-modal="true"]:not([hidden]),.nozeli-context-menu:not([hidden])')].some(node=>(node.id==='settings-dialog'&&demoSettingsOpen?false:node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden'));
      // The controls title is the step explanation, so it follows the same
      // rule as the big hint: neutral until this step's action receipt has
      // landed (reading phase), never the upcoming step's promise.
      const earned=currentHint?.phase==='reading'&&currentHint.stepIndex===(session.stepIndex||0);
      model={visible:!modal,projectId:session.projectId,sessionId:session.id,epoch:session.epoch,status:session.status,chapterId:session.chapterId,section:step?.section,stepIndex:session.stepIndex||0,stepTotal:flow.steps.length,title:earned?step?.hintTitle||flow.title:flow.title,caption,progress:`${Math.min((session.stepIndex||0)+1,flow.steps.length)} / ${flow.steps.length}`,seekable:!creating&&!exiting&&!flight,buttons:controls.map(control=>({...control})),theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette};
    }
    const key=JSON.stringify(model);if(key===publishedUi)return;publishedUi=key;
    void invoke('workspace.demoControls.update',{model}).then(result=>{if(!result.ok){onError(result.error.message);if(session?.status==='playing')void transition('pause').catch(onError);}}).catch(onError);
  }
  function accept(value){const next=value?.session??value;if(!next?.projectId)return;if(session&&next.id===session.id&&Number(next.epoch)<Number(session.epoch))return;const changed=!session||next.epoch!==session.epoch||next.status!==session.status||next.chapterId!==session.chapterId||next.stepIndex!==session.stepIndex;if(Object.hasOwn(value,'cleanup'))cleanupReceipt=value.cleanup;session=next;if(changed)token++;paint();if(session.status==='playing')void pump();}
  function transition(action,extra={},urgent=false){token++;captionOverride='';if(action==='play')failureMessage='';const owner=session&&{id:session.id,projectId:session.projectId};const task=(urgent?Promise.resolve():transitionQueue).then(async()=>{if(!session||session.id!==owner?.id||session.projectId!==owner.projectId)return;if(action==='play'){paint();unwrapDemo(await invoke('workspace.demoControls.readyForPlay',{sessionId:session.id}));}const value=unwrapDemo(await invoke('demo.transition',{...demoIdentity(session),action,...extra}));if(session.id===owner.id&&session.projectId===owner.projectId)accept(value);return value;});transitionQueue=task.catch(()=>{});return task;}

  // One big hint per step on its own always-on-top native view; never covered
  // by document surfaces. The explanation FOLLOWS the content: a neutral
  // preparation state while the real action runs, the step's explanation only
  // after that action's receipt (and a visible content surface), held for a
  // readable, skippable duration. Stays on screen while paused.
  let currentHint=null,hintRevision=0;
  // Hint identity carries the hint generation (bumped on every hide/seek):
  // a stale skip for a previous visit of the same step must not skip the
  // fresh countdown of a re-entered step. Preparation and reading carry
  // distinct keys so the reading card re-announces itself.
  const hintKey=(id,step,revision,phase)=>id+':'+step.id+':'+revision+':'+phase;
  const hintView=hint=>void invoke('workspace.demoHint.update',{hint}).then(result=>{if(!result.ok)onError(result.error.message);}).catch(error=>onError(error.message));
  function hideHint(){hintRevision++;currentHint=null;for(const node of document.querySelectorAll('[data-demo-guide-target]'))delete node.dataset.demoGuideTarget;hintView(null);}
  function publishHint(){if(currentHint)hintView({...currentHint,paused:session?.status==='paused',theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette});}
  const HINT_READ_MS=6000,PREP_DETAIL='演示正用真实动作完成这一步；完成后在这里说明它的意义。';
  // Neutral preparation state: names the action in progress, never the
  // explanation, so no label can lead or cover content that is not there yet.
  function prepareHint(step){
    if(disposed||!session||!step)return;
    for(const node of document.querySelectorAll('[data-demo-guide-target]'))delete node.dataset.demoGuideTarget;
    const durationMs=step.readMs||HINT_READ_MS;currentHint={key:hintKey(session.id,step,hintRevision,'go'),section:step.section,title:(session.status==='playing'?'正在演示：':'待演示：')+(step.caption||flow.title),detail:PREP_DETAIL,visible:true,stepIndex:session.stepIndex||0,stepTotal:flow.steps.length,phase:'acting',durationMs,remainingMs:durationMs};
    publishHint();
  }
  // The step explanation, published only after its action receipt: readable
  // for a bounded duration, skippable via the hint card's dismiss, frozen
  // while paused, abandoned on seek/exit. Playback advances only after it.
  async function readingPhase(step){
    if(disposed||!session||!step.hintTitle)return true;
    const id=session.id,index=session.stepIndex,revision=hintRevision;
    const durationMs=step.readMs||HINT_READ_MS;currentHint={key:hintKey(id,step,revision,'read'),section:step.section,title:step.hintTitle,detail:step.hintDetail,visible:true,stepIndex:index,stepTotal:flow.steps.length,phase:'reading',durationMs,remainingMs:durationMs};
    publishHint();
    let last=performance.now(),published=0;
    while(!disposed&&!exiting&&session?.id===id&&session.stepIndex===index&&hintRevision===revision){
      const now=performance.now();
      if(session.status==='playing')currentHint.remainingMs=Math.max(0,currentHint.remainingMs-(now-last));
      else if(session.status!=='paused')return false;
      last=now;
      if(now-published>=150){publishHint();published=now;}
      if(currentHint.remainingMs===0&&session.status==='playing')return true;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return false;
  }

  // Steps that carry a relPath act on a real file surface: open/activate that
  // file first (the same path a user takes), then wait bounded for the driver.
  // For 'open' this IS the step; for content actions (edit/annotation/diff…)
  // it is only the activation prelude — the action itself runs once, visibly.
  async function openStep(original,step){
    if(step.relPath)await openFile(step.relPath);
    for(let attempt=0;attempt<8;attempt++){
      if(session?.epoch!==original.epoch||session.status!=='playing'||getProjectId()!==original.projectId)throw Object.assign(Error('原演示动作已停止'),{code:'DEMO_ACTION_CANCELLED'});
      try{return await runAction(original,step);}
      catch(error){if(error.code!=='DEMO_SURFACE_NOT_READY')throw error;await new Promise(r=>setTimeout(r,700));}
    }
    throw Error('真实内容面未就绪：'+(step.relPath||'本章来源材料'));
  }
  // Frontdesk and background-notice steps must be SEEN in the conversation:
  // open/activate the real conversation view through the same workspace
  // control a user triggers, wait until its surface is visible, and only then
  // run the action (whose receipt requires the message text on screen).
  async function conversationStep(original,step){
    const opened=await invoke('workspace.control',{type:'conversation-action',projectId:original.projectId,action:'open'});
    if(!opened.ok)throw Object.assign(Error(opened.error?.message||'前台对话未能打开'),{code:opened.error?.code});
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      if(session?.epoch!==original.epoch||session.status!=='playing'||getProjectId()!==original.projectId)throw Object.assign(Error('原演示动作已停止'),{code:'DEMO_ACTION_CANCELLED'});
      const snapshot=await invoke('workspace.snapshot',{projectId:original.projectId});
      const conversation=snapshot.ok?Object.values(snapshot.value.layout.views).find(view=>view.kind==='conversation'):null;
      const windows=conversation?await invoke('workspace.windows.list',{projectId:original.projectId}):null;
      if(conversation&&windows?.ok&&windows.value.some(window=>window.surfaces.some(surface=>surface.viewId===conversation.id&&surface.visible))){
        for(let attempt=0;attempt<8;attempt++){
          if(session?.epoch!==original.epoch||session.status!=='playing'||getProjectId()!==original.projectId)throw Object.assign(Error('原演示动作已停止'),{code:'DEMO_ACTION_CANCELLED'});
          try{return await runAction(original,step);}
          catch(error){if(error.code!=='DEMO_SURFACE_NOT_READY')throw error;await new Promise(r=>setTimeout(r,700));}
        }
        throw Error('真实对话内容面未就绪');
      }
      await new Promise(r=>setTimeout(r,150));
    }
    throw Error('真实对话内容面未就绪');
  }
  async function clientStep(original,step){
    if(step.semantic.startsWith('ui.map-')){
      for(const node of document.querySelectorAll('[data-demo-guide-target]'))delete node.dataset.demoGuideTarget;
      const part=step.semantic.slice('ui.map-'.length);
      if(part==='files'&&document.getElementById('file-toggle')?.getAttribute('aria-expanded')!=='true')document.getElementById('file-toggle').click();
      if(part==='todos')document.dispatchEvent(new CustomEvent('nozeli-reveal-work-sidebar'));
      if(part==='conversation')unwrapDemo(await invoke('workspace.control',{type:'conversation-action',projectId:original.projectId,action:'open'}));
      const selector={project:'.rail',files:'#files',workspace:'#workspace-groups',conversation:'#workspace-groups',todos:'#side'}[part];
      const node=document.querySelector(selector);if(!node)throw Error('教学界面区域不存在：'+part);
      const deadline=Date.now()+8000;
      while(node.getBoundingClientRect().width<1||node.getBoundingClientRect().height<1){if(Date.now()>deadline)throw Error('教学界面区域不可见：'+part);await new Promise(r=>setTimeout(r,80));}
      node.dataset.demoGuideTarget=part;
      return {ok:true,client:true,region:part};
    }
    if(step.semantic==='ui.settings'){
      // Present the real settings UI long enough to read it: sources/login
      // first, then the model tiers. Read-only — no input, no save, no login.
      // Interruption (pause/seek) leaves the dialog on screen and keeps the
      // playback controls visible via demoSettingsOpen so the visitor can
      // resume or end; the latch in paint() recycles the exemption once the
      // dialog is really closed.
      demoSettingsOpen=true;demoSettingsSeenOpen=false;paint();
      const interrupted=()=>!session||session.id!==original.id||session.status!=='playing';
      const dwell=async ms=>{const end=performance.now()+ms;while(performance.now()<end){if(interrupted())return false;await new Promise(r=>setTimeout(r,200));}return true;};
      // The dialog's real open state is confirmed, never assumed from a
      // timer: the explanation may only follow a settings surface that is
      // actually on screen.
      const opened=async()=>{const end=performance.now()+10000;while(performance.now()<end){if(interrupted())return false;if(document.getElementById('settings-dialog')?.open)return true;await new Promise(r=>setTimeout(r,100));}return false;};
      window.dispatchEvent(new CustomEvent('nozeli-open-settings',{detail:'settings-provider'}));
      const sources=await opened();
      if(!sources&&!interrupted())throw Error('设置界面未能打开，未继续演示说明');
      const readSources=sources&&await dwell(6500);
      let readModels=false;
      if(readSources){window.dispatchEvent(new CustomEvent('nozeli-open-settings',{detail:'settings-models'}));readModels=(await opened())&&await dwell(6500);}
      if(readSources&&readModels){window.dispatchEvent(new Event('nozeli-demo-settings-close'));demoSettingsOpen=false;demoSettingsSeenOpen=false;}
      paint();
      return {ok:true,client:true,sections:readSources&&readModels?2:sources?1:0};
    }
    if(step.semantic==='ui.finish')return {ok:true,client:true};
    return runAction(session,step);
  }
 function runStep(original,step){
  const conversationSemantics=new Set(['frontdesk-ask','task-a','task-b','progress','decision-continue']);
  const execute=conversationSemantics.has(step.semantic)?conversationStep(original,step):step.relPath?openStep(original,step):clientStep(original,step);
  return execute.catch(reason=>{
   // Only guarded refusals become explicit skips: the visitor's own edits
   // (DEMO_CONTENT_CHANGED) or a superseded playback position
   // (DEMO_ACTION_CANCELLED). Every other failure is real: rethrow it so the
   // demo pauses on the failed step instead of advancing as if it succeeded.
   if(reason?.code==='DEMO_CONTENT_CHANGED'){captionOverride='这一步已跳过：示例文件已包含你的修改，未改动文件';paint();return {ok:true,skipped:true};}
   if(reason?.code==='DEMO_ACTION_CANCELLED'){captionOverride='这一步已跳过：演示位置已变化';paint();return {ok:true,skipped:true};}
   throw reason;
  });
 }
  // A receipt says the action ran; it does not prove the visitor can see the
  // result (main activates views lazily and only gates on readiness). Poll
  // the real native surface list until this step's source is actually
  // visible before any explanation is published — a state observation, not
  // a timed wait, and never inside the main project serial.
  async function confirmContentPresent(original,step){
    if(!step.relPath)return;
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      if(session?.epoch!==original.epoch||session.status!=='playing'||getProjectId()!==original.projectId)throw Object.assign(Error('原演示动作已停止'),{code:'DEMO_ACTION_CANCELLED'});
      const snapshot=await invoke('workspace.windows.list',{projectId:original.projectId});
      if(snapshot.ok&&snapshot.value.some(window=>window.visible&&window.surfaces.some(surface=>surface.relPath===step.relPath&&surface.visible)))return;
      await new Promise(resolve=>setTimeout(resolve,120));
    }
    throw Object.assign(Error('真实内容面尚未显示：'+step.relPath),{code:'DEMO_SURFACE_NOT_VISIBLE'});
  }
  async function pump(){
    if(busy||disposed||exiting||session?.status!=='playing')return;
    busy=true;
    let original=null,restartAfterFlight=false;
    try{
      while(session?.status==='playing'&&!disposed&&!exiting){
        if(getProjectId()!==session.projectId){await transition('pause');break;}
        original={...session};
        if(stopBeforeStep!==null&&original.stepIndex>=stopBeforeStep){stopBeforeStep=null;await transition('pause');break;}
        const step=flow.steps[original.stepIndex||0];
        if(!step){await transition('finish');break;}
        if(lastSemantic==='ui.settings'&&step.semantic!=='ui.settings')window.dispatchEvent(new Event('nozeli-demo-settings-close'));
        lastSemantic=step.semantic;
        let generation=token;
        // Neutral preparation first: the explanation must never lead its content.
        prepareHint(step);
        if(session?.status!=='playing'||session.id!==original.id||session.stepIndex!==original.stepIndex||getProjectId()!==original.projectId){restartAfterFlight=session?.status==='playing';break;}
        original={...session};generation=token;
        if(executedSteps.has(step.id)&&!step.semantic.startsWith('ui.map-')&&!['open','ui.settings','ui.finish'].includes(step.semantic)){
          // Already demonstrated once with its content-aligned explanation:
          // no second edit, and no label replayed over whatever is on screen
          // now — the caption alone records the skip.
          captionOverride='此步已演示过，未重复执行。';paint();
          await transition('advance',{stepIndex:original.stepIndex+1,stepId:step.id});
          if(session?.status==='playing')await new Promise(resolve=>setTimeout(resolve,400));
          continue;
        }
        flight=runStep(original,step);
        paint();
        const receipt=await flight;
        flight=null;
        if(token!==generation||session?.epoch!==original.epoch||session?.status!=='playing'||getProjectId()!==original.projectId){
          const reason=session?.status==='paused'?session.error:null;
          if(reason){
            // The flight was superseded and the session recorded a refusal.
            // Report it and stay put: never advance a step or resume playback
            // on the host's behalf as if the interrupted action had succeeded.
            if(reason.code==='DEMO_CONTENT_CHANGED')captionOverride='这一步已跳过：示例文件已包含你的修改，未改动文件';
            else if(reason.code==='DEMO_ACTION_CANCELLED')captionOverride='这一步已跳过：演示位置已变化';
            else failureMessage=reason.message;
            paint();
          }
          restartAfterFlight=session?.status==='playing'&&getProjectId()===session.projectId;break;
        }
        if(receipt?.ok===false)throw Error(receipt.error?.message||'真实动作未完成');
        if(!receipt?.skipped)executedSteps.add(step.id);
        // Content-present gate before the label: the receipt alone does not
        // prove the surface is on screen; only then may reading start.
        await confirmContentPresent(original,step);
        // The explanation only now, readable and skippable; the step index
        // advances after it, so pause/resume/seek keep this visit's identity.
        if(!await readingPhase(step)){restartAfterFlight=session?.status==='playing';break;}
        await transition('advance',{stepIndex:original.stepIndex+1,stepId:step.id});
        if(session?.status==='playing')await new Promise(resolve=>setTimeout(resolve,150));
      }
    }catch(error){
      flight=null;
      if(original&&(session?.epoch!==original.epoch||session?.status!=='playing'||getProjectId()!==original.projectId)){
        paint();restartAfterFlight=session?.status==='playing'&&getProjectId()===session.projectId;
      }else fail(error);
    }finally{
      busy=false;
      if(session?.status==='finished'&&!exiting&&!disposed)void exitDemo();
      else if(restartAfterFlight&&!disposed)queueMicrotask(()=>void pump());
    }
  }
  async function start(chapterId='learn'){
    if(creating||exiting||flight)throw Error('当前示例操作尚在收尾，请稍候');
    creating=true;paint();
    try{
      const saved=await captureReturn();if(!session||saved?.projectId&&saved.projectId!==session.projectId)returnState=saved;
      if(session&&session.status!=='removed'&&getProjectId()===session.projectId)await transition('stop');
      const created=unwrapDemo(await invoke('demo.create',{confirmed:true,chapterId}));
      failureMessage='';stopBeforeStep=null;lastSemantic='';executedSteps=new Set();accept(created);returnState={projectId:created.returnProjectId};
      await openProject(created.project.id);await transition('play');
    }finally{creating=false;paint();}
  }
  const interrupt=event=>{if(!event.isTrusted||exiting||event.type==='pointermove'&&!event.movementX&&!event.movementY||!session||session.status!=='playing'||event.target?.closest?.('#guided-demo-player'))return;const owner=session;if(event.type!=='pointermove')token++;void invoke('demo.interrupt',{...demoIdentity(owner),reason:event.type}).then(result=>{if(result.ok&&session?.id===owner.id)accept(result.value);}).catch(onError);};
  for(const name of ['pointerdown','pointermove','keydown','beforeinput','wheel'])window.addEventListener(name,interrupt,true);
  const off=subscribe('demo.changed',value=>{if(session&&(value?.session?.projectId===session.projectId||value?.projectId===session.projectId))accept(value);});
  const offHint=subscribe('workspace.control',event=>{
    if(event.type!=='demo-hint-dismiss'||event.key!==currentHint?.key)return;
    currentHint.remainingMs=0;publishHint();
  });
  const offControls=subscribe('workspace.control',event=>{
    if(event.type!=='demo-controls-action'||exiting||!session||event.sessionId!==session.id)return;
    const safe=event.controlId==='stop'||event.controlId==='seek'||event.controlId==='play'&&event.intent==='pause';
    if(event.epoch!==session.epoch&&!safe)return;
    if(event.controlId==='seek'){void seekTo(event.stepIndex,event.resume===true).catch(fail);return;}
    const run=actions.get(event.controlId),control=controls.find(control=>control.id===event.controlId);
    if(!run||control?.disabled&&!safe)return;
    void Promise.resolve(run(event.intent)).catch(fail);
  });
  const visibilityObserver=new MutationObserver(()=>paint());visibilityObserver.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open','hidden','aria-modal']});
  document.addEventListener('appearance:change',paint);
  return {start,async bindProject(projectId){if(session&&session.projectId!==projectId){token++;const previous=unwrapDemo(await invoke('demo.state',{projectId:session.projectId}));if(previous.demo)accept(previous);}const state=unwrapDemo(await invoke('demo.state',{projectId}));if(state.demo&&!['stopped','removed'].includes(state.session.status)){returnState={projectId:state.returnProjectId};accept(state);}},dispose(){disposed=true;token++;hideHint();off?.();offHint?.();offControls?.();visibilityObserver.disconnect();document.removeEventListener('appearance:change',paint);void invoke('workspace.demoControls.update',{model:null});void invoke('workspace.demoHint.update',{hint:null});for(const name of ['pointerdown','pointermove','keydown','beforeinput','wheel'])window.removeEventListener(name,interrupt,true);}};
}
