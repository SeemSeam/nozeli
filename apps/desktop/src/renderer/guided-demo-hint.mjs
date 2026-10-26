import './settings-appearance.css';
import './guided-demo-hint.css';

const $=id=>document.getElementById(id),root=$('guided-demo-hint'),bar=$('hint-timer-bar'),live=$('hint-live');
const invoke=async(op,payload={})=>{const result=await window.nozeli.invoke(op,payload);if(!result.ok)throw Error(result.error?.message||'演示提示未就绪');return result.value;};
let measured=0,model=null,frame=0,updatedAt=0,announced='',lastPaused=null,lastPhase='';
// The owner (playback driver) is the only countdown authority; this view only
// interpolates the last published remainingMs between pushes, freezes on pause
// and never restarts a countdown by itself.
// Add body padding-top (10px) + padding-bottom (14px); keep in sync with
// guided-demo-hint.css. ceil(card)+24 always fits 10+card+14, so the
// transparent page never grows an outer scrollbar in the normal case.
function measure(){if(root.hidden)return;const height=Math.ceil(root.getBoundingClientRect().height)+24;if(height===measured)return;measured=height;void invoke('workspace.demoHint.size',{height}).catch(error=>console.error(error));}
function announce(text){if(text===announced)return;announced=text;live.textContent=text;}
function tick(){
  frame=0;if(!model?.visible)return;
  const frozen=model.paused||model.phase!=='intro';
  const remaining=Math.max(0,model.remainingMs-(frozen?0:performance.now()-updatedAt));
  bar.style.transform=`scaleX(${Math.min(1,remaining/model.durationMs)})`;
  $('hint-phase').textContent=model.paused?`已暂停 · 剩余 ${Math.ceil(remaining/1000)} 秒`:model.phase==='acting'?'正在演示':`${Math.ceil(remaining/1000)} 秒后开始`;
  if(!model.paused&&model.phase==='intro'&&remaining>0)frame=requestAnimationFrame(tick);
}
function render(next){
  const changed=next?.key!==model?.key;model=next;updatedAt=performance.now();
  cancelAnimationFrame(frame);frame=0;root.hidden=!next?.visible;if(root.hidden)return;
  document.documentElement.dataset.theme=next.theme==='dark'?'dark':'light';document.documentElement.dataset.palette=next.palette||'sage';
  root.dataset.phase=next.phase||'intro';
  $('hint-chip').textContent=`${String(next.stepIndex+1).padStart(2,'0')} / ${next.stepTotal}`;
  $('hint-title').textContent=next.title;$('hint-detail').textContent=next.detail;
  $('hint-dismiss').hidden=next.phase!=='intro'||next.paused;
  if(changed){root.classList.remove('hint-in');void root.offsetWidth;root.classList.add('hint-in');announce(next.title);}
  else if(lastPhase!=='acting'&&next.phase==='acting'&&!next.paused)announce('正在演示这一步');
  else if(lastPaused!==null&&lastPaused!==!!next.paused)announce(next.paused?'演示已暂停，提示保留':'继续演示');
  lastPaused=!!next.paused;lastPhase=next.phase||'intro';
  tick();measure();
}
$('hint-dismiss').onclick=()=>{if(model)void invoke('workspace.demoHint.dismiss',{key:model.key}).catch(error=>console.error(error));};
window.nozeli.subscribe('workspace.control',event=>{if(event.type==='demo-hint-state')render(event.hint);});
new ResizeObserver(measure).observe(root);
render((await invoke('workspace.bootstrap')).model);
await invoke('workspace.demoHint.ready');window.__nozeliReady=true;
