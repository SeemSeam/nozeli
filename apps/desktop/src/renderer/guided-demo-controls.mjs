import {setIconButton} from './ui-icons.mjs';
import './settings-appearance.css';
import './guided-demo-controls.css';

const $=id=>document.getElementById(id),root=$('guided-demo-player'),buttons=new Map();
let model=null,bounds=null,collapsed=false,drag=null,moveFrame=0,pendingMove=null,measuredHeight=0;
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
  $('demo-title').textContent=model.title;$('demo-progress').textContent=model.progress;$('demo-subtitle').textContent=model.caption;
  const select=$('demo-chapters');if(select.options.length!==model.chapters.length){select.replaceChildren();for(const chapter of model.chapters){const option=document.createElement('option');option.value=chapter.id;option.textContent=chapter.title;select.append(option);}}
  select.value=model.chapterId;select.disabled=model.chapterDisabled;
  for(const control of model.buttons){
    let button=buttons.get(control.id);
    if(!button){button=document.createElement('button');button.type='button';button.dataset.demoControl=control.id;button.onclick=()=>{const intent=control.id==='play'?(model.status==='playing'?'pause':'play'):undefined;void action(control.id,intent?{intent}:{});if(!control.primary)$('demo-more').open=false;};buttons.set(control.id,button);$(control.primary?'demo-primary':'demo-secondary').append(button);}
    button.disabled=control.disabled;button.title=control.label;button.setAttribute('aria-label',control.label);
    if(control.id==='previous-step'||control.id==='next-step')setIconButton(button,control.id==='previous-step'?'chevron-left':'chevron-right',{label:control.label});
    else if(button.textContent!==(control.id==='stop'?'结束':control.label))button.textContent=control.id==='stop'?'结束':control.label;
    button.classList.toggle('demo-play',control.id==='play');
  }
  measure();
}
$('demo-chapters').onchange=()=>{void action('chapter',{chapterId:$('demo-chapters').value});$('demo-more').open=false;};
$('demo-more').ontoggle=()=>measure();
$('demo-collapse').onclick=()=>{collapsed=!collapsed;root.classList.toggle('demo-collapsed',collapsed);$('demo-collapse').setAttribute('aria-expanded',String(!collapsed));setIconButton($('demo-collapse'),collapsed?'chevron-up':'chevron-down',{label:collapsed?'展开说明':'收起说明'});measure();};
setIconButton($('demo-collapse'),'chevron-down',{label:'收起说明'});
function queueMove(x,y){pendingMove={x,y};if(!moveFrame)moveFrame=requestAnimationFrame(()=>{moveFrame=0;const point=pendingMove;pendingMove=null;void invoke('workspace.demoControls.drag',point).then(value=>{bounds=value.bounds;}).catch(showError);});}
$('demo-drag').onpointerdown=event=>{
  if(event.button!==0||event.target.closest('button,select,summary')||!bounds)return;
  if(model?.status==='playing')void action('play',{intent:'pause'});
  drag={pointerId:event.pointerId,screenX:event.screenX,screenY:event.screenY,x:bounds.x,y:bounds.y};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();
};
$('demo-drag').onpointermove=event=>{if(drag&&event.pointerId===drag.pointerId)queueMove(drag.x+event.screenX-drag.screenX,drag.y+event.screenY-drag.screenY);};
const stopDrag=event=>{if(!drag)return;drag=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);};
$('demo-drag').onpointerup=stopDrag;$('demo-drag').onpointercancel=stopDrag;
$('demo-drag').onkeydown=event=>{if(event.target!==event.currentTarget||!bounds||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();if(model?.status==='playing')void action('play',{intent:'pause'});queueMove(bounds.x+(event.key==='ArrowLeft'?-16:event.key==='ArrowRight'?16:0),bounds.y+(event.key==='ArrowUp'?-16:event.key==='ArrowDown'?16:0));};
window.nozeli.subscribe('workspace.control',event=>{if(event.type==='demo-controls-state'){bounds=event.bounds;render(event.model);}if(event.type==='demo-controls-bounds'){bounds=event.bounds;document.documentElement.style.setProperty('--demo-max-height',Math.max(80,event.availableHeight-16)+'px');}});
new ResizeObserver(measure).observe(root);
const bootstrap=await invoke('workspace.bootstrap');bounds=bootstrap.bounds;render(bootstrap.model);
await invoke('workspace.demoControls.ready');window.__nozeliReady=true;
