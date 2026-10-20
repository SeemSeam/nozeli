import {setFontButton} from './ui-icons.mjs';
import { mountContextMenu } from './context-menu.mjs';
import './conversation-font.css';
import { menuNotice, panelMenuPosition } from './panel-menu.mjs';

// One project preference follows all projections of its conversation.
export function mountConversationFont({ getSize, setSize, scope, toast, views = () => [], runView = () => {} }) {
  const menu = mountContextMenu({ id: 'conversation-context-menu', label: '对话操作', onError: toast, onClose: () => document.querySelectorAll('[data-chat-font],[data-chat-more]').forEach(button => button.setAttribute('aria-expanded', 'false')) });
  const surfaceAt = target => target.closest('#conversation-panel,.tag-chat-window');
  function open(event, keyboard = false, trigger = null) {
    const surface = surfaceAt(event.target);
    if (!surface) return;
    event.preventDefault(); event.stopPropagation();
    const owner = scope(), size = getSize();
    const input = event.target.closest('textarea,input[type="text"]');
    const start = input?.selectionStart, end = input?.selectionEnd, value = input?.value;
    const selection = window.getSelection();
    const selected = input ? value.slice(start, end) : selection?.anchorNode && selection?.focusNode && surface.contains(selection.anchorNode) && surface.contains(selection.focusNode) ? selection.toString() : '';
    const editable = input && !input.disabled && !input.readOnly;
    const current = () => scope() === owner && surface.isConnected;
    const unchanged = () => current() && input?.isConnected && input.value === value && input.selectionStart === start && input.selectionEnd === end;
    const fonts = [
        { id: 'chat-font-larger', label: '放大字号', enabled: size < 24 },
        { id: 'chat-font-smaller', label: '缩小字号', enabled: size > 11 },
        { separator: true },
        ...[12, 14, 16, 18, 20, 24].map(n => ({ id: `chat-font-${n}`, label: `${n}px`, checked: n === size })),
        { separator: true }, { id: 'chat-font-reset', label: '恢复默认 · 14px' },
    ];
    const tag = surface.matches('.tag-chat-window');
    const settings = tag ? [
      {id:'tag-collapse',label:surface.classList.contains('is-collapsed')?'展开标签':'折叠标签',checked:!surface.classList.contains('is-collapsed')},
      ...(surface.closest('.tag-note')&&surface.querySelector('.tag-edit') ? [{id:'tag-edit',label:'编辑备注',enabled:!surface.querySelector('.tag-edit').hidden}] : []),
      ...(surface.querySelector('.tag-remove,.tag-delete')?[{separator:true},{id:'tag-remove',label:surface.querySelector('.tag-remove')?'移除标签，保留对话历史':'删除本地备注…'}]:[]),
    ] : views();
    const items = [
      { id: 'copy', label: '复制', enabled: Boolean(selected), shortcut: 'Ctrl/Cmd+C' },
      ...(editable ? [{ id: 'cut', label: '剪切', enabled: Boolean(selected), shortcut: 'Ctrl/Cmd+X' }, { id: 'paste', label: '粘贴', shortcut: 'Ctrl/Cmd+V' }, { id: 'select-all', label: '全选', shortcut: 'Ctrl/Cmd+A' }] : []),
      { separator: true },
      { id: 'chat-font', label: `对话字号 · ${size}px`, children: fonts },
      {separator:true}, ...settings,
    ];
    const box = event.target.getBoundingClientRect();
    const entries = trigger ? [...(trigger.hasAttribute('data-chat-font') ? fonts : items.slice(items.findIndex(item=>item.id==='chat-font'))), menuNotice] : items;
    menu.open(entries, { ...(trigger ? panelMenuPosition(trigger) : {x:keyboard ? box.left + 12 : event.clientX,y:keyboard ? box.top + 12 : event.clientY}), focus: input || document.activeElement, async run(command) {
      if (!current()) return;
      if (command.startsWith('chat-font-')) {
        const next = command === 'chat-font-larger' ? size + 1 : command === 'chat-font-smaller' ? size - 1 : command === 'chat-font-reset' ? 14 : Number(command.slice(10));
        return setSize(Math.min(24, Math.max(11, next)));
      }
      if (command.startsWith('tag-')) return surface.querySelector(command==='tag-collapse'?'.tag-close':command==='tag-edit'?'.tag-edit':'.tag-remove,.tag-delete')?.click();
      if (command.startsWith('chat-')) return runView(command);
      if (command === 'select-all') { input.focus({ preventScroll: true }); input.select(); return; }
      if (command === 'copy' || command === 'cut') {
        const result = await window.nozeli.invoke('document.clipboard', { action: 'write', text: selected });
        if (!result.ok) throw Error(result.error.message);
        if (command === 'copy') return;
      }
      let insert = '';
      if (command === 'paste') {
        const result = await window.nozeli.invoke('document.clipboard', { action: 'read' });
        if (!result.ok) throw Error(result.error.message);
        insert = result.value;
      }
      if (!unchanged()) return;
      input.focus({ preventScroll: true }); input.setSelectionRange(start, end);
      // Keep the native textarea undo stack and its normal draft-save events.
      document.execCommand(command === 'cut' ? 'delete' : 'insertText', false, insert);
    } });
    trigger?.setAttribute('aria-expanded', 'true');
  }
  document.addEventListener('mousedown', event => {
    if (event.button === 2 && surfaceAt(event.target)) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  document.addEventListener('contextmenu', event => open(event), true);
  document.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') open(event, true);
  }, true);
  document.addEventListener('click', event => { const trigger=event.target.closest('[data-chat-font],[data-chat-more]'); if(trigger)open(event,false,trigger); });
  const render = () => { for(const button of document.querySelectorAll('[data-chat-font]')) { setFontButton(button,getSize()); button.setAttribute('aria-label','对话字号 · '+getSize()+'px'); } };
  const observer = new MutationObserver(records => { if(records.some(record=>Array.from(record.addedNodes).some(node=>node.nodeType===1 && (node.matches?.('.note-anchor') || node.querySelector?.('[data-chat-font]')))))render(); });
  observer.observe(document.body,{childList:true,subtree:true});
  render();
  return { close: () => menu.close(), render }; 
}
