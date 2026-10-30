import './settings-appearance.css';
import './guided-demo-controls.css';

const $=id=>document.getElementById(id),root=$('guided-demo-player'),buttons=new Map();
let model=null,bounds=null,drag=null,moveFrame=0,pendingMove=null,measuredHeight=0;
const invoke=async(op,payload={})=>{const result=await window.nozeli.invoke(op,payload);if(!result.ok)throw Error(result.error?.message||'控制区操作未完成');return result.value;};
function showError(error){$('demo-error').hidden=false;$('demo-error').textContent=error.message;}
async function action(controlId,extra={}){
  if(!model)return;
  try{await invoke('workspace.demoControls.action',{sessionId:model.sessionId,epoch:model.epoch,controlId,...extra});$('demo-error').hidden=true;}
  catch(error){showError(error);}
}
function measure(){if(root.hidden)return;const height=Math.ceil(root.getBoundingClientRect().height)+16;if(height===measuredHeight)return;measuredHeight=height;void invoke('workspace.demoControls.size',{height}).then(value=>{bounds=value.bounds;}).catch(showError);}
function render(next){
  model=next;root.hidden=!model;if(!model)return;
  document.documentElement.dataset.theme=model.theme==='dark'?'dark':'light';document.documentElement.dataset.palette=model.palette||'sage';
  root.dataset.demoState=model.status;root.dataset.sessionId=model.sessionId;root.dataset.epoch=String(model.epoch);
  $('demo-title').textContent=model.section||model.title;$('demo-progress').textContent=model.progress;
  // While the user is holding the slider its value is theirs; state pushes
  // must not snap the thumb back to the still-committing step.
  const seek=$('demo-seek');
  seek.max=String(Math.max(0,model.stepTotal-1));
  seek.disabled=!seekDragging&&(!model.seekable||!['playing','paused'].includes(model.status));
  if(!seekDragging)seek.value=String(Math.min(model.stepIndex,model.stepTotal-1));
  seek.setAttribute('aria-valuetext',`第 ${Number(seek.value)+1} 步，共 ${model.stepTotal} 步`);
  for(const control of model.buttons){
    let button=buttons.get(control.id);
    if(!button){button=document.createElement('button');button.type='button';button.dataset.demoControl=control.id;button.onclick=()=>{const intent=control.id==='play'?(model.status==='playing'?'pause':'play'):undefined;void action(control.id,intent?{intent}:{});};buttons.set(control.id,button);$('demo-primary').append(button);}
    button.disabled=control.disabled;button.title=control.label;button.setAttribute('aria-label',control.label);
    if(button.textContent!==control.label)button.textContent=control.label;
    button.classList.toggle('demo-play',control.id==='play');
  }
  measure();
}
// One user drag = one seek command carrying the playback intent captured when
// the drag paused playback; the epoch is read fresh so a just-paused session
// cannot reject the commit that continues it.
let seekDragging=false,seekResume=false;
async function committedAction(controlId,extra={}){
  const value=await invoke('workspace.bootstrap');
  if(!value.model?.sessionId)throw Error('演示控制区不可用');
  return invoke('workspace.demoControls.action',{sessionId:value.model.sessionId,epoch:value.model.epoch,controlId,...extra});
}
const seekInput=$('demo-seek');
seekInput.addEventListener('pointerdown',()=>{if(seekInput.disabled)return;seekDragging=true;if(model?.status==='playing'){seekResume=true;void action('play',{intent:'pause'});}});
seekInput.addEventListener('input',()=>{seekDragging=true;if(model)seekInput.setAttribute('aria-valuetext',`第 ${Number(seekInput.value)+1} 步，共 ${model.stepTotal} 步`);});
seekInput.addEventListener('change',()=>{const index=Number(seekInput.value);seekDragging=false;const resume=seekResume;seekResume=false;if(!model||seekInput.disabled||!Number.isInteger(index))return;void committedAction('seek',{stepIndex:index,...(resume?{resume:true}:{})}).catch(showError);});
const seekRelease=()=>{if(!seekDragging)return;seekDragging=false;if(!seekResume)return;seekResume=false;void committedAction('play',{intent:'play'}).catch(showError);};
seekInput.addEventListener('pointerup',seekRelease);seekInput.addEventListener('pointercancel',seekRelease);seekInput.addEventListener('blur',seekRelease);
function queueMove(x,y){pendingMove={x,y};if(!moveFrame)moveFrame=requestAnimationFrame(()=>{moveFrame=0;const point=pendingMove;pendingMove=null;void invoke('workspace.demoControls.drag',point).then(value=>{bounds=value.bounds;}).catch(showError);});}
$('demo-drag').onpointerdown=event=>{
  if(event.button!==0||event.target.closest('button,input,summary')||!bounds)return;
  if(model?.status==='playing')void action('play',{intent:'pause'});
  drag={pointerId:event.pointerId,screenX:event.screenX,screenY:event.screenY,x:bounds.x,y:bounds.y};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();
};
$('demo-drag').onpointermove=event=>{if(drag&&event.pointerId===drag.pointerId)queueMove(drag.x+event.screenX-drag.screenX,drag.y+event.screenY-drag.screenY);};
const stopDrag=event=>{if(!drag)return;drag=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);};
$('demo-drag').onpointerup=stopDrag;$('demo-drag').onpointercancel=stopDrag;
$('demo-drag').onkeydown=event=>{if(event.target!==event.currentTarget||!bounds||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();if(model?.status==='playing')void action('play',{intent:'pause'});queueMove(bounds.x+(event.key==='ArrowLeft'?-16:event.key==='ArrowRight'?16:0),bounds.y+(event.key==='ArrowUp'?-16:event.key==='ArrowDown'?16:0));};
window.nozeli.subscribe('workspace.control',event=>{if(event.type==='demo-controls-state'){bounds=event.bounds;render(event.model);}if(event.type==='demo-controls-bounds')bounds=event.bounds;});
new ResizeObserver(measure).observe(root);
const bootstrap=await invoke('workspace.bootstrap');bounds=bootstrap.bounds;render(bootstrap.model);
await invoke('workspace.demoControls.ready');window.__nozeliReady=true;
