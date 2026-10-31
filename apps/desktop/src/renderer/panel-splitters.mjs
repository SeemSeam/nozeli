const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));
const initial = { filesWidth:174, sideWidth:288, workRatio:53.5 };

// Handles live above document/iframe content; pointer capture keeps drags continuous.
export function mountPanelSplitters({ state, render, save }) {
  let frame=0, active=null;
  const handles=[];
  function make(id,label,axis,key,geometry,range,delta) {
    const node=document.createElement('div');node.id=id;node.className='panel-splitter';node.tabIndex=0;node.role='separator';
    node.setAttribute('aria-label',label);node.setAttribute('aria-orientation',axis==='x'?'vertical':'horizontal');node.title=label+' · 拖动调整，双击复位';document.body.append(node);
    const item={node,key,geometry,range,axis};handles.push(item);
    function update(value){const [lo,hi]=range();state()[key]=clamp(value,lo,hi);render();}
    function end(e){if(active!==node)return;active=null;node.classList.remove('dragging');document.body.classList.remove('panel-dragging');if(node.hasPointerCapture(e.pointerId))node.releasePointerCapture(e.pointerId);save();refresh();}
    node.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();node.focus();active=node;node.classList.add('dragging');document.body.classList.add('panel-dragging');node.setPointerCapture(e.pointerId);const origin=axis==='x'?e.clientX:e.clientY;const value=state()[key]??initial[key];const move=ev=>update(value+delta((axis==='x'?ev.clientX:ev.clientY)-origin));const done=ev=>{node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',done);node.removeEventListener('pointercancel',done);end(ev);};node.addEventListener('pointermove',move);node.addEventListener('pointerup',done);node.addEventListener('pointercancel',done);});
    node.addEventListener('dblclick',()=>{update(initial[key]);save();});
    node.addEventListener('keydown',e=>{const negative=axis==='x'?'ArrowLeft':'ArrowUp',positive=axis==='x'?'ArrowRight':'ArrowDown';if(![negative,positive,'Home'].includes(e.key))return;e.preventDefault();update(e.key==='Home'?initial[key]:(state()[key]??initial[key])+delta(e.key===negative?-10:10));save();});
  }
  const rect=id=>$(id).getBoundingClientRect();
  const reading=()=>!$('app').classList.contains('focus-mode');
  const widthRange=key=>{const s=state(),other=key==='filesWidth'?(s.sideCollapsed?38:rect('side').width):(s.filesCollapsed?38:rect('files').width);return [key==='filesWidth'?140:180,Math.min(650,innerWidth-other-44-62-280)];};
  make('files-divider','调整文件栏宽度','x','filesWidth',()=>{if(!reading()||innerWidth<=1000||state().filesCollapsed)return null;const r=rect('files');return {left:r.right,top:r.top,width:10,height:r.height};},()=>widthRange('filesWidth'),d=>d);
  make('side-divider','调整工作栏宽度','x','sideWidth',()=>{if(!reading()||innerWidth<=1000||state().sideCollapsed)return null;const r=rect('side');return {left:r.left-10,top:r.top,width:10,height:r.height};},()=>widthRange('sideWidth'),d=>-d);
  const workflow=()=>document.querySelector('.workflow-panel').getBoundingClientRect();
  make('work-divider','调整工作与待办高度','y','workRatio',()=>{if(!reading()||(innerWidth<=1000?!state().drawerSideOpen:state().sideCollapsed))return null;const r=workflow();return {left:r.left,top:r.bottom,width:r.width,height:10};},()=>{const h=$('sidebar-body').clientHeight-10;const min=Math.min(45,140/Math.max(1,h)*100);return[min,100-min];},d=>d/Math.max(1,$('sidebar-body').clientHeight-10)*100);
  function layout(){
    frame=0;const s=state();let fw=s.filesWidth??initial.filesWidth,sw=s.sideWidth??initial.sideWidth;
    const budget=Math.max(320,innerWidth-44-62-280),total=(s.filesCollapsed?38:fw)+(s.sideCollapsed?38:sw);
    if(total>budget){const ratio=budget/total;fw=Math.max(140,fw*ratio);sw=Math.max(180,sw*ratio);}
    $('app').style.setProperty('--files',s.filesCollapsed?'38px':fw+'px');$('app').style.setProperty('--side',s.sideCollapsed?'38px':sw+'px');
    $('sidebar-body').style.setProperty('--work-ratio',(s.workRatio??initial.workRatio)+'fr');$('sidebar-body').style.setProperty('--inbox-ratio',(100-(s.workRatio??initial.workRatio))+'fr');
    for(const {node,key,geometry,range} of handles){const r=geometry();node.hidden=!r;if(!r)continue;for(const [k,v]of Object.entries(r))node.style[k]=v+'px';const [lo,hi]=range();node.setAttribute('aria-valuemin',Math.round(lo));node.setAttribute('aria-valuemax',Math.round(hi));node.setAttribute('aria-valuenow',Math.round(s[key]??initial[key]));}
  }
  function refresh(){if(!frame)frame=requestAnimationFrame(layout);}
  const observer=new ResizeObserver(refresh);for(const id of ['app','files','side','sidebar-body'])observer.observe($(id));
  new MutationObserver(refresh).observe(document.body,{attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',refresh);window.addEventListener('scroll',refresh,true);window.addEventListener('nozeli-layout-change',refresh);refresh();
  return {refresh};
}
