// Native top-layer menus remain visible above clipped document/terminal panes.
export function mountPopupMenu(trigger,menu) {
  menu.setAttribute('popover','auto'); menu.setAttribute('role','menu');
  trigger.setAttribute('aria-haspopup','menu'); trigger.setAttribute('aria-expanded','false');
  function position() {
    const r=trigger.getBoundingClientRect(), m=menu.getBoundingClientRect();
    menu.style.left=Math.max(8,Math.min(r.right-m.width,innerWidth-m.width-8))+'px';
    menu.style.top=Math.max(8,Math.min(r.bottom+5,innerHeight-m.height-8))+'px';
  }
  trigger.addEventListener('click',event=>{
    event.preventDefault();
    if(menu.matches(':popover-open'))menu.hidePopover();
    else {window.dispatchEvent(new CustomEvent('nozeli-context-menu-open',{detail:menu.id}));menu.showPopover();position();menu.querySelector('button:not(:disabled)')?.focus({preventScroll:true});}
  });
  menu.addEventListener('toggle',()=>trigger.setAttribute('aria-expanded',String(menu.matches(':popover-open'))));
  menu.addEventListener('keydown',event=>{
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();const choices=[...menu.querySelectorAll('button:not(:disabled)')],index=choices.indexOf(document.activeElement);
    choices[event.key==='Home'?0:event.key==='End'?choices.length-1:(index+(event.key==='ArrowUp'?-1:1)+choices.length)%choices.length]?.focus();
  });
  menu.addEventListener('click',event=>{if(event.target.closest('button'))menu.hidePopover();});
  function close(){if(menu.matches(':popover-open'))menu.hidePopover();}
  window.addEventListener('nozeli-context-menu-open',event=>{if(event.detail!==menu.id)close();});
  window.addEventListener('project-view-change',close);window.addEventListener('nozeli-project-change',close);
  window.addEventListener('resize',close);
  return {close};
}
