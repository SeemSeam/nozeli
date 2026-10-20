import {uiIcon} from './ui-icons.mjs';
export function menuShortcut(value = '') {
  const mac = /Mac/i.test(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '');
  return value.replaceAll('Ctrl/Cmd', mac ? 'Cmd' : 'Ctrl').replaceAll('CmdOrCtrl', mac ? 'Cmd' : 'Ctrl');
}

// Shared shell for application commands; drivers retain their own transactions.
export function mountContextMenu({id, label, onOpen = () => {}, onClose = () => {}, onError = () => {}}) {
  const menu = document.createElement('div');
  menu.id = id; menu.className = 'nozeli-context-menu'; menu.hidden = true;
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label);
  document.body.append(menu);
  let previousFocus, execute, panels = [];
  const position = (node, x, y) => {
    node.style.left = Math.max(6, Math.min(innerWidth - node.offsetWidth - 6, x)) + 'px';
    node.style.top = Math.max(6, Math.min(innerHeight - node.offsetHeight - 6, y)) + 'px';
  };
  const choices = panel => [...panel.children].filter(node => node.matches('button:not(:disabled)'));
  function prune(level = 0) {
    for (const entry of panels.splice(level)) { entry.owner.setAttribute('aria-expanded', 'false'); entry.panel.remove(); }
  }
  function close(restore = false) {
    const wasOpen = !menu.hidden;
    menu.hidden = true; prune(); execute = null;
    if (wasOpen) onClose();
    if (restore && previousFocus?.isConnected) previousFocus.focus({preventScroll:true});
  }
  function child(owner, items, level, focus = false) {
    if (panels[level]?.owner === owner) { if (focus) choices(panels[level].panel)[0]?.focus(); return; }
    prune(level);
    const panel = document.createElement('div'); panel.className = 'nozeli-context-menu nozeli-submenu';
    panel.setAttribute('role', 'menu'); panel.setAttribute('aria-label', owner.textContent);
    document.body.append(panel); panels.push({owner,panel}); owner.setAttribute('aria-expanded','true');
    render(panel, items, level + 1);
    const b = owner.getBoundingClientRect();
    const fitsRight = b.right + panel.offsetWidth + 9 <= innerWidth;
    const fitsLeft = b.left - panel.offsetWidth - 9 >= 0;
    let x = fitsRight ? b.right + 3 : b.left - panel.offsetWidth - 3, y = b.top - 5;
    // At narrow widths a side submenu would cover its own hovered trigger.
    // Keep that trigger clickable instead of activating a newly overlaid item.
    if (!fitsRight && !fitsLeft) {
      x = b.left;
      if (b.bottom + panel.offsetHeight + 9 <= innerHeight) y = b.bottom + 3;
      else if (b.top - panel.offsetHeight - 9 >= 0) y = b.top - panel.offsetHeight - 3;
    }
    position(panel, x, y);
    if (focus) choices(panel)[0]?.focus({preventScroll:true});
  }
  function render(panel, items, level) {
    panel.replaceChildren();
    for (const item of items) {
      if (item.notice) {
        const caption = document.createElement('div'); caption.className = 'panel-menu-notice';
        caption.textContent = item.notice; caption.setAttribute('role', 'note'); panel.append(caption); continue;
      }
      if (item.separator || item.type === 'separator') {
        const line = document.createElement('div'); line.className = 'document-menu-separator'; line.setAttribute('role','separator'); panel.append(line); continue;
      }
      const button = document.createElement('button'); button.type = 'button'; button.dataset.command = item.id;
      button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
      if (item.checked !== undefined) button.setAttribute('aria-checked',String(item.checked));
      button.disabled = item.enabled === false;
      if (item.hint) button.title = item.hint;
      const caption = document.createElement('span'); caption.textContent = item.label;
      const shortcut = document.createElement('kbd'); if(item.children)shortcut.append(uiIcon('chevron-right'));else shortcut.textContent=menuShortcut(item.shortcut || item.accelerator);
      button.append(caption, shortcut);
      if (item.children) { button.setAttribute('aria-haspopup','menu'); button.setAttribute('aria-expanded','false'); }
      button.addEventListener('pointerenter',()=>item.children && !button.disabled ? child(button,item.children,level) : prune(level));
      button.addEventListener('click',()=>{
        if (item.children) return child(button,item.children,level,true);
        const action = execute; close(true);
        Promise.resolve().then(()=>action?.(item.id)).catch(error=>onError(error.message));
      });
      panel.append(button);
    }
    panel.onpointerdown = event=>event.preventDefault();
    panel.onkeydown = event=>{
      const buttons = choices(panel), index = buttons.indexOf(document.activeElement);
      if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); prune(level);
        buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus({preventScroll:true});
      } else if (event.key==='ArrowRight' && document.activeElement?.getAttribute('aria-haspopup')==='menu') {
        event.preventDefault(); document.activeElement.click();
      } else if (event.key==='ArrowLeft' && level) {
        event.preventDefault(); const owner = panels[level-1]?.owner; prune(level-1); owner?.focus({preventScroll:true});
      } else if (event.key==='Escape' || event.key==='Tab') {
        event.preventDefault(); event.stopPropagation(); close(true);
      }
    };
  }
  const contains = node => menu.contains(node) || panels.some(p=>p.panel.contains(node));
  const outside = event => { if (!contains(event.target)) close(); };
  const dismiss = () => close();
  const other = event => { if (event.detail !== id) close(); };
  const scroll = event => { if (!contains(event.target)) close(); };
  document.addEventListener('pointerdown',outside,true);
  document.addEventListener('scroll',scroll,true);
  window.addEventListener('nozeli-context-menu-open',other);
  for (const event of ['resize','nozeli-project-change','project-view-change']) window.addEventListener(event,dismiss);
  return {
    menu, isOpen:()=>!menu.hidden, close,
    open(items,{x=20,y=20,anchor,focus=document.activeElement,run=()=>{}}={}) {
      close(); previousFocus=focus; execute=run;
      render(menu,items,0); menu.hidden=false;
      if(anchor){x=anchor.right-menu.offsetWidth;y=anchor.bottom+5;if(y+menu.offsetHeight>innerHeight-6)y=anchor.top-menu.offsetHeight-5;}
      position(menu,x,y);
      onOpen(); window.dispatchEvent(new CustomEvent('nozeli-context-menu-open',{detail:id}));
      choices(menu)[0]?.focus({preventScroll:true});
    },
    destroy(){close();menu.remove();document.removeEventListener('pointerdown',outside,true);document.removeEventListener('scroll',scroll,true);window.removeEventListener('nozeli-context-menu-open',other);for(const event of ['resize','nozeli-project-change','project-view-change'])window.removeEventListener(event,dismiss);}
  };
}
