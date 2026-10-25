// Keep PPTist object/slide actions intact; coordinate the native shell only.
export function mountPptContextMenu({frame,onOpen,onClose,onSelectionStart}) {
  const win=frame.contentWindow,doc=frame.contentDocument;
  const link=doc.createElement('link');link.rel='stylesheet';link.href=new URL('./context-menu.css',location.href).href;doc.head.append(link);
  let menu=null,focus=null,lastTarget=null;
  const close=()=>{doc.querySelector('.contextmenu-mask')?.dispatchEvent(new win.MouseEvent('mousedown',{bubbles:true,button:0}));};
  const choices=panel=>[...panel.children].filter(n=>n.matches('.menu-item:not(.divider):not(.disable)'));
  const reveal=row=>{
    for(const owner of menu.querySelectorAll('.menu-item[aria-haspopup=menu]')){
      const open=owner===row||Boolean(row&&owner.contains(row));
      owner.dataset.keyboardOpen=String(open);owner.setAttribute('aria-expanded',String(open));
      if(!open)continue;
      const sub=owner.querySelector(':scope > .menu-item-content > .sub-menu'),b=owner.getBoundingClientRect(),s=sub.getBoundingClientRect();
      sub.style.position='fixed';sub.style.left=Math.max(6,Math.min(win.innerWidth-s.width-6,b.right+s.width>win.innerWidth?b.left-s.width:b.right-1))+'px';sub.style.top=Math.max(6,Math.min(win.innerHeight-s.height-6,b.top))+'px';
    }
  };
  const place=()=>{
    if(!menu?.isConnected)return;
    const b=menu.getBoundingClientRect();menu.style.left=Math.max(6,Math.min(win.innerWidth-b.width-6,b.left))+'px';menu.style.top=Math.max(6,Math.min(win.innerHeight-b.height-6,b.top))+'px';
  };
  const observer=new win.MutationObserver(()=>{
    const current=doc.querySelector('.contextmenu');if(current===menu)return;
    if(menu){menu=null;onClose?.();}
    if(!current)return;
    menu=current;menu.setAttribute('role','menu');menu.setAttribute('aria-label','幻灯片操作');
    for(const row of menu.querySelectorAll('.menu-item')){row.setAttribute('role',row.classList.contains('divider')?'separator':'menuitem');row.tabIndex=-1;if(row.classList.contains('disable'))row.setAttribute('aria-disabled','true');if(row.querySelector(':scope > .menu-item-content > .sub-menu')){row.setAttribute('aria-haspopup','menu');row.setAttribute('aria-expanded','false');}}
    place();onOpen?.(close);choices(menu.querySelector('.menu-content'))[0]?.focus({preventScroll:true});
  });
  observer.observe(doc.body,{childList:true});
  const down=event=>{if(event.button===0&&!event.target.closest('.contextmenu,.contextmenu-mask,input,textarea,button')&&event.target.closest('.canvas')){lastTarget=event.target;onSelectionStart?.();}};
  const context=event=>{if(event.target.closest('.contextmenu-mask'))return;close();focus=doc.activeElement;lastTarget=event.target;};
  const key=event=>{
    if(!menu&&((event.shiftKey&&/^(Arrow|Home|End)/.test(event.key))||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'))&&!event.target.closest('input,textarea'))onSelectionStart?.();
    if((event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))&&!menu){
      if(event.target.closest('input,textarea,.ProseMirror[contenteditable=true]'))return;
      event.preventDefault();event.stopImmediatePropagation();
      const target=lastTarget?.isConnected?lastTarget:doc.querySelector('.editable-element')||doc.querySelector('.canvas');
      const b=target?.getBoundingClientRect();target?.dispatchEvent(new win.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:(b?.left||0)+12,clientY:(b?.top||0)+12}));return;
    }
    if(!menu)return;
    const row=doc.activeElement.closest?.('.menu-item'),panel=row?.parentElement||menu.querySelector('.menu-content'),items=choices(panel),index=items.indexOf(row);
    if(['ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();const next=items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length];reveal(next);next?.focus({preventScroll:true});}
    else if(event.key==='ArrowRight'&&row?.getAttribute('aria-haspopup')==='menu'){
      event.preventDefault();event.stopImmediatePropagation();const sub=row.querySelector(':scope > .menu-item-content > .sub-menu');reveal(row);choices(sub)[0]?.focus({preventScroll:true});
    }else if(event.key==='ArrowLeft'&&panel.classList.contains('sub-menu')){event.preventDefault();event.stopImmediatePropagation();const owner=panel.closest('.menu-item');delete owner.dataset.keyboardOpen;owner.setAttribute('aria-expanded','false');owner.focus();}
    else if(['Enter',' '].includes(event.key)&&row){event.preventDefault();event.stopImmediatePropagation();if(row.getAttribute('aria-haspopup')==='menu'){row.dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));}else row.click();}
    else if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();event.stopImmediatePropagation();close();if(focus?.isConnected)focus.focus({preventScroll:true});}
  };
  const hover=event=>{const row=event.target.closest('.menu-item:not(.divider):not(.disable)');if(row&&menu?.contains(row))reveal(row);};
  const scroll=event=>{if(!event.target.closest?.('.contextmenu'))close();};
  // Region annotations stop propagation at document; resume selection before them.
  win.addEventListener('pointerdown',down,true);doc.addEventListener('contextmenu',context,true);doc.addEventListener('keydown',key,true);doc.addEventListener('pointerover',hover,true);doc.addEventListener('scroll',scroll,true);win.addEventListener('resize',close);
  return {close,dispose(){close();observer.disconnect();onClose?.();win.removeEventListener('pointerdown',down,true);doc.removeEventListener('contextmenu',context,true);doc.removeEventListener('keydown',key,true);doc.removeEventListener('pointerover',hover,true);doc.removeEventListener('scroll',scroll,true);win.removeEventListener('resize',close);link.remove();}};
}
