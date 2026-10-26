import './guided-demo.css';
import {demoChapters,demoIdentity,unwrapDemo,createDemoActions} from '../domain/guided-demo.mjs';
export function createStartPage({project,openProject,start,help,browseFiles,continueConversation,compact=false}){
  const root=document.createElement('section');root.className='guided-start';root.id=compact?'': 'start-page';
  const heading=document.createElement('h2'),description=document.createElement('p');
  heading.textContent=compact?'选择内容':project?project.name:'在材料旁阅读、记录与共同修改';
  description.textContent=project?'从文件栏选择材料，或继续项目对话。关闭内容不会结束后台工作。':'打开自己的项目，或使用独立示例了解 Nozeli。无需账号即可体验演示。';
  root.append(heading);if(!compact)root.append(description);
  const button=(text,run,id)=>{const b=document.createElement('button');b.type='button';b.textContent=text;if(id)b.id=id;b.onclick=run;root.append(b);};
  if(!project&&!compact)button('打开项目',openProject);
  if(project&&!compact){button('浏览文件',browseFiles);button('继续对话',continueConversation);}
  if(!compact)button('体验演示项目',start,'start-demo-entry');
  button(compact?'帮助':'按功能学习',help);return root;
}

export function mountGuidedDemo({invoke,subscribe,openProject,openFile,captureReturn,restoreReturn,getProjectId,onError=()=>{}}){
  let session=null,busy=false,flight=null,token=0,returnState=null,disposed=false,transitionQueue=Promise.resolve(),failureMessage='',stopBeforeStep=null,creating=false,cleanupReceipt=null,captionOverride='',publishedUi='';
  const runAction=createDemoActions({invoke}),controls=[],settledButtons=[],actions=new Map();
  const add=(id,label,run,settledOnly=false,primary=false)=>{const control={id,label,disabled:false,primary};controls.push(control);actions.set(id,run);if(settledOnly)settledButtons.push(control);return control;};
  const play=add('play','继续',async intent=>{if(intent==='pause'){if(session.status==='playing')await transition('pause');return;}if(intent!=='play')throw Error('未知播放操作');if(getProjectId()!==session.projectId)await openProject(session.projectId);stopBeforeStep=null;await transition('play');},false,true);
  async function pauseForNavigation(){if(!session||flight)throw Error('当前操作正在收尾，请稍候');if(session.status!=='removed'){if(getProjectId()!==session.projectId)await openProject(session.projectId);await transition('pause');}}
  async function recreate(chapterId,checkpoint=null){await pauseForNavigation();if(window.confirm('将完整保留当前示例文件、批注与草稿，创建新副本重建真实检查点。继续？'))await start(chapterId,checkpoint);}
  async function chooseChapter(chapterId){
    const from=demoChapters.findIndex(c=>c.id===session.chapterId),to=demoChapters.findIndex(c=>c.id===chapterId);
    if(to<=from||session.status==='removed')return recreate(chapterId,0);
    await pauseForNavigation();await transition('chapter',{chapterId});
  }
  const chapterMove=async direction=>{const index=demoChapters.findIndex(c=>c.id===session?.chapterId),chapter=demoChapters[index+direction];if(chapter)await chooseChapter(chapter.id);};
  async function stepMove(direction){
    const chapter=demoChapters.find(c=>c.id===session.chapterId),index=session.stepIndex||0;
    if(direction<0){const previous=index>0?chapter:demoChapters[demoChapters.indexOf(chapter)-1];if(previous)await recreate(previous.id,index>0?index-1:previous.steps.length-1);return;}
    await pauseForNavigation();
    if(index>=chapter.steps.length){const next=demoChapters[demoChapters.indexOf(chapter)+1];if(!next)return;await transition('chapter',{chapterId:next.id});}
    stopBeforeStep=session.stepIndex+1;await transition('play');
  }
  const previousStep=add('previous-step','上一步',()=>stepMove(-1),true,true),nextStep=add('next-step','下一步',()=>stepMove(1),true,true);
  add('previous-chapter','上一章',()=>chapterMove(-1),true);add('next-chapter','下一章',()=>chapterMove(1),true);
  add('restart','重播本章',()=>recreate(session.chapterId),true);
  const end=add('stop','结束演示',()=>transition('stop'),false,true);
  add('return','返回原工作面',async()=>{if(session.status!=='removed')await transition('stop');await restoreReturn(returnState);},true);
  const keep=add('keep','保留示例',()=>transition('finish'),true);
  const cleanupButton=add('cleanup','带我清理',async()=>{await pauseForNavigation();const preview=unwrapDemo(await invoke('demo.cleanupPreview',demoIdentity(session)));window.dispatchEvent(new CustomEvent('nozeli-demo-cleanup',{detail:{projectId:session.projectId,preview}}));captionOverride='默认保留文件；删除磁盘项目仍需亲自核对并确认。';paint();},true);
  function fail(error){failureMessage=error.message;onError(error.message);void transition('pause').catch(()=>{});paint();}
  function paint(){
    if(disposed)return;
    let model=null;
    if(session){
      play.label=session.status==='playing'?'暂停':'继续';play.disabled=creating||['finished','removed'].includes(session.status)||Boolean(flight&&session.status!=='playing');
      for(const control of settledButtons)control.disabled=creating||Boolean(flight);
      previousStep.disabled ||= session.status==='removed'||session.chapterId===demoChapters[0].id&&session.stepIndex===0;nextStep.disabled ||= session.status==='removed'||session.status==='finished';keep.disabled ||= session.status==='removed';cleanupButton.disabled ||= session.status==='removed';end.disabled=creating||['removed','finished'].includes(session.status);
      const chapter=demoChapters.find(chapter=>chapter.id===session.chapterId),step=chapter?.steps[session.stepIndex||0],terminal=['finished','stopped','removed'].includes(session.status);
      const cleanup=terminal&&(cleanupReceipt?.trashed?'已移至回收站。':cleanupReceipt?.removed?'已移除入口，文件保留。':cleanupReceipt?.complete&&cleanupReceipt.action==='clean-local'?'本机视图已重置，原文件保留。':'');
      const caption=creating?'正在准备独立示例副本…':flight&&session.status!=='playing'?'当前操作正在收尾；不会继续下一步。':cleanup||(terminal?'演示已结束，示例文件保留。':failureMessage?'演示已暂停：'+failureMessage:session.error?.message?'演示已暂停：'+session.error.message:captionOverride||step?.caption||'本章已完成。');
      const modal=[...document.querySelectorAll('dialog[open],[aria-modal="true"]:not([hidden]),.nozeli-context-menu:not([hidden])')].some(node=>node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');
      model={visible:!modal,projectId:session.projectId,sessionId:session.id,epoch:session.epoch,status:session.status,chapterId:session.chapterId,title:chapter?.title||'演示',caption,progress:`${Math.min((session.stepIndex||0)+1,chapter?.steps.length||1)} / ${chapter?.steps.length||1}`,chapterDisabled:creating||Boolean(flight),chapters:demoChapters.map(({id,title})=>({id,title})),buttons:controls.map(control=>({...control})),theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette};
    }
    const key=JSON.stringify(model);if(key===publishedUi)return;publishedUi=key;
    void invoke('workspace.demoControls.update',{model}).then(result=>{if(!result.ok){onError(result.error.message);if(session?.status==='playing')void transition('pause').catch(onError);}}).catch(onError);
  }
  function accept(value){const next=value?.session??value;if(!next?.projectId)return;if(session&&next.id===session.id&&Number(next.epoch)<Number(session.epoch))return;const changed=!session||next.epoch!==session.epoch||next.status!==session.status||next.chapterId!==session.chapterId||next.stepIndex!==session.stepIndex;if(Object.hasOwn(value,'cleanup'))cleanupReceipt=value.cleanup;session=next;if(changed)token++;paint();if(session.status==='playing')void pump();}
  function transition(action,extra={}){token++;captionOverride='';if(action==='play')failureMessage='';const owner=session&&{id:session.id,projectId:session.projectId};const task=transitionQueue.then(async()=>{if(!session||session.id!==owner?.id||session.projectId!==owner.projectId)return;if(action==='play'){paint();unwrapDemo(await invoke('workspace.demoControls.readyForPlay',{sessionId:session.id}));}const value=unwrapDemo(await invoke('demo.transition',{...demoIdentity(session),action,...extra}));if(session.id===owner.id&&session.projectId===owner.projectId)accept(value);return value;});transitionQueue=task.catch(()=>{});return task;}
  // file.open/report.open need a real native surface before the host can relay;
  // open it here and wait bounded for the driver, never skipping to a fake view.
  async function openStep(original,step){await openFile(step.relPath);for(let attempt=0;attempt<8;attempt++){if(session?.epoch!==original.epoch||session.status!=='playing'||getProjectId()!==original.projectId)throw Object.assign(Error('原演示动作已停止'),{code:'DEMO_ACTION_CANCELLED'});try{return await runAction(original,step);}catch(error){if(error.code!=='DEMO_SURFACE_NOT_READY')throw error;await new Promise(r=>setTimeout(r,700));}}throw Error('真实内容面未就绪：'+step.relPath);}
  async function pump(){
    if(busy||disposed||session?.status!=='playing')return;
    busy=true;
    let original=null,restartAfterFlight=false;
    try{
      while(session?.status==='playing'&&!disposed){
        if(getProjectId()!==session.projectId){await transition('pause');break;}
        original={...session};
        if(stopBeforeStep!==null&&original.stepIndex>=stopBeforeStep){stopBeforeStep=null;await transition('pause');break;}
        const chapter=demoChapters.find(c=>c.id===original.chapterId),step=chapter?.steps[original.stepIndex||0];
        if(!step){
          const next=demoChapters[demoChapters.indexOf(chapter)+1];
          if(!next){await transition('finish');break;}
          await transition('chapter',{chapterId:next.id,stepIndex:0});
          await transition('play');
          continue;
        }
        const generation=token;
        flight=step.semantic==='open'?openStep(original,step):runAction(original,step);
        paint();
        const receipt=await flight;
        flight=null;
        if(token!==generation||session.epoch!==original.epoch||session.status!=='playing'||getProjectId()!==original.projectId){
          paint();restartAfterFlight=session.status==='playing'&&getProjectId()===session.projectId;break;
        }
        if(receipt?.ok===false)throw Error(receipt.error?.message||'真实动作未完成');
        await transition('advance',{stepIndex:original.stepIndex+1,stepId:step.id});
        if(session?.status==='playing')await new Promise(resolve=>setTimeout(resolve,matchMedia('(prefers-reduced-motion: reduce)').matches?0:1400));
      }
    }catch(error){
      flight=null;
      if(original&&(session?.epoch!==original.epoch||session.status!=='playing'||getProjectId()!==original.projectId)){
        paint();restartAfterFlight=session?.status==='playing'&&getProjectId()===session.projectId;
      }else fail(error);
    }finally{
      busy=false;
      if(restartAfterFlight&&!disposed)queueMicrotask(()=>void pump());
    }
  }
  async function start(chapterId='intro',checkpoint=null){
    if(creating||flight)throw Error('当前示例操作尚在收尾，请稍候');
    creating=true;paint();
    try{
      const saved=await captureReturn();if(!session||saved?.projectId&&saved.projectId!==session.projectId)returnState=saved;
      if(session&&session.status!=='removed'&&getProjectId()===session.projectId)await transition('stop');
      const created=unwrapDemo(await invoke('demo.create',{confirmed:true,chapterId}));
      failureMessage='';stopBeforeStep=checkpoint;accept(created);
      await openProject(created.project.id);await transition('play');
    }finally{creating=false;paint();}
  }
  function openHelp(){const dialog=document.createElement('dialog');dialog.id='guided-demo-disclosure';const heading=document.createElement('h2'),text=document.createElement('p'),cancel=document.createElement('button'),confirm=document.createElement('button'),chapter=document.createElement('select');heading.textContent='体验独立演示项目';text.textContent='将创建真实示例文件，可暂停、停止或返回原工作面。AI 回复与成果来自离线固定演示源，不使用账号、付费模型或真实 Worker。结束默认保留文件；删除必须由你亲自确认。';chapter.setAttribute('aria-label','从章节开始');for(const c of demoChapters){const o=document.createElement('option');o.value=c.id;o.textContent=c.title;chapter.append(o);}cancel.textContent='取消';confirm.textContent='创建示例并开始';confirm.id='demo-create-confirm';cancel.onclick=()=>dialog.close();confirm.onclick=async()=>{confirm.disabled=true;try{await start(chapter.value);dialog.close();}catch(e){text.textContent=e.message;confirm.disabled=false;}};dialog.append(heading,text,chapter,cancel,confirm);dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();cancel.focus();}
  const interrupt=event=>{if(!event.isTrusted||event.type==='pointermove'&&!event.movementX&&!event.movementY||!session||session.status!=='playing'||event.target?.closest?.('#guided-demo-player,#guided-demo-disclosure'))return;if(event.type!=='pointermove')token++;void invoke('demo.interrupt',{...demoIdentity(session),reason:event.type}).then(result=>{if(result.ok)accept(result.value);}).catch(onError);};
  for(const name of ['pointerdown','pointermove','keydown','beforeinput','wheel'])window.addEventListener(name,interrupt,true);
  const off=subscribe('demo.changed',value=>{if(value?.session?.projectId===session?.projectId||value?.projectId===session?.projectId)accept(value);});
  const offControls=subscribe('workspace.control',event=>{if(event.type!=='demo-controls-action'||!session||event.sessionId!==session.id)return;const safe=event.controlId==='stop'||event.controlId==='play'&&event.intent==='pause';if(event.epoch!==session.epoch&&!safe)return;const run=event.controlId==='chapter'?()=>chooseChapter(event.chapterId):actions.get(event.controlId),control=controls.find(control=>control.id===event.controlId);if(!run||control?.disabled&&!safe)return;void Promise.resolve(run(event.intent)).catch(fail);});
  const visibilityObserver=new MutationObserver(()=>paint());visibilityObserver.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open','hidden','aria-modal']});
  document.addEventListener('appearance:change',paint);
  return {start,openHelp,async bindProject(projectId){if(session&&session.projectId!==projectId){token++;const previous=unwrapDemo(await invoke('demo.state',{projectId:session.projectId}));if(previous.demo)accept(previous);}const state=unwrapDemo(await invoke('demo.state',{projectId}));if(state.demo)accept(state);},dispose(){disposed=true;token++;off?.();offControls?.();visibilityObserver.disconnect();document.removeEventListener('appearance:change',paint);void invoke('workspace.demoControls.update',{model:null});for(const name of ['pointerdown','pointermove','keydown','beforeinput','wheel'])window.removeEventListener(name,interrupt,true);}};
}
