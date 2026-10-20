import './workspace-conversation-controls.css';
import './panel-menu.css';
import { panelButton, observePanelWidth } from './panel-menu.mjs';

import {uiIcon as icon, setIconButton} from './ui-icons.mjs';
export {uiIcon as workspaceIcon} from './ui-icons.mjs';

function decorate(button, name, label, text = '') {
  setIconButton(button,name,{text});
  button.title = label;
  button.setAttribute('aria-label', label);
  button.classList.add('chat-tool');
}

export function mountConversationControls({ expand, reset }) {
  const details = document.getElementById('chat-layout');
  const summary = details.querySelector('summary');
  const menu = details.querySelector('.dock-options');
  const controls = details.parentElement;
  const floating = document.getElementById('float-conversation');
  const minimize = document.getElementById('chat-minimize');
  const maximize = document.createElement('button');
  maximize.id = 'chat-maximize'; maximize.type = 'button';
  controls.insertBefore(maximize, minimize);
  const font = panelButton('chat-font-settings', '对话字号', true); font.dataset.chatFont = '';
  controls.prepend(font);
  const more = panelButton('chat-more'); more.dataset.chatMore = ''; controls.append(more);
  details.classList.add('panel-overflow-first'); floating.classList.add('panel-overflow-second'); maximize.classList.add('panel-overflow-third');
  observePanelWidth(document.getElementById('conversation-head'));
  decorate(summary, 'layout', '对话布局');
  decorate(minimize, 'minus', '收起对话');
  summary.setAttribute('aria-haspopup', 'menu');
  summary.setAttribute('aria-controls', 'chat-layout-menu');
  menu.id = 'chat-layout-menu';
  menu.classList.add('chat-layout-menu');
  menu.setAttribute('popover', 'manual');
  menu.setAttribute('role', 'menu');
  const labels = { top: '停靠上方', right: '停靠右侧', bottom: '停靠下方', left: '停靠左侧' };
  for (const button of menu.querySelectorAll('button[data-dock]')) {
    decorate(button, 'arrow', labels[button.dataset.dock], labels[button.dataset.dock]);
    button.setAttribute('role', 'menuitemradio');
  }
  const defaults = document.createElement('button');
  defaults.type = 'button'; defaults.id = 'chat-reset-layout';
  defaults.setAttribute('role', 'menuitem');
  decorate(defaults, 'reset', '恢复默认对话布局', '恢复默认布局');
  menu.append(defaults);
  let opened = false;
  const buttons = () => [...menu.querySelectorAll('button:not(:disabled)')];
  function position() {
    if (!opened) return;
    const anchor = summary.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = innerHeight;
    const below = height - anchor.bottom - 8;
    const above = anchor.top - 8;
    const y = below >= bounds.height || below >= above ? anchor.bottom + 6 : anchor.top - bounds.height - 6;
    menu.style.left = Math.max(8, Math.min(anchor.right - bounds.width, width - bounds.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, height - bounds.height - 8)) + 'px';
  }
  function close(restoreFocus = false) {
    opened = false;
    details.open = false;
    if (menu.matches(':popover-open')) menu.hidePopover();
    summary.setAttribute('aria-expanded', 'false');
    if (restoreFocus) summary.focus({ preventScroll: true });
  }
  function sync() {
    if (!details.open) { close(); return; }
    if (opened) { position(); return; }
    opened = true;
    menu.showPopover();
    position();
    summary.setAttribute('aria-expanded', 'true');
    (menu.querySelector('[aria-checked="true"]') || buttons()[0])?.focus({ preventScroll: true });
  }
  summary.addEventListener('click', event => { event.preventDefault(); details.open = !details.open; sync(); });
  details.addEventListener('toggle', sync);
  menu.addEventListener('click', event => { if (event.target.closest('button')) close(true); });
  menu.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const choices = buttons(), current = choices.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (current + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + choices.length) % choices.length;
    choices[next]?.focus();
  });
  document.addEventListener('keydown', event => {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); }
    if (event.key === 'Tab') close(true);
  }, true);
  document.addEventListener('pointerdown', event => { if (opened && !details.contains(event.target)) close(); }, true);
  document.addEventListener('scroll', position, true);
  window.addEventListener('resize', position);
  window.addEventListener('nozeli-context-menu-open', () => close());
  maximize.addEventListener('click', () => { close(); expand(); });
  defaults.addEventListener('click', reset);
  return {
    close,
    commands(state) {
      return [
        {id:'chat-floating',label:state.floating?'返回原停靠位置':'悬浮对话',checked:state.floating},
        {id:'chat-docking',label:'对话布局',children:Object.entries(labels).map(([dock,label])=>({id:'chat-dock-'+dock,label,checked:state.dock===dock&&!state.floating}))},
        {id:'chat-expand',label:state.chatExpanded?'还原对话窗口':'放大对话窗口',checked:state.chatExpanded},
        {id:'chat-collapse',label:'收起对话'},
        {separator:true},{id:'chat-reset-layout',label:'恢复默认布局'},
      ];
    },
    run(command) {
      const button = command.startsWith('chat-dock-') ? menu.querySelector('[data-dock="'+command.slice(10)+'"]')
        : {'chat-floating':floating,'chat-expand':maximize,'chat-collapse':minimize,'chat-reset-layout':defaults}[command];
      button?.click();
    },
    render(state) {
      decorate(floating, 'floating', state.floating ? '返回原停靠位置' : '悬浮对话');
      decorate(maximize, state.chatExpanded ? 'minimize' : 'maximize', state.chatExpanded ? '还原对话窗口' : '放大对话窗口');
      maximize.setAttribute('aria-pressed', String(Boolean(state.chatExpanded)));
      controls.classList.add('chat-window-controls');
      for (const button of menu.querySelectorAll('button[data-dock]')) button.setAttribute('aria-checked', String(state.dock === button.dataset.dock && !state.floating));
      if (state.minimized) close();
      position();
    },
  };
}
