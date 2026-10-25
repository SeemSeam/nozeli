import './action-confirmation.css';

const actions = [
  { selector: '#close-subject', key: 'closeDocument', title: '关闭当前文件？', command: '关闭文件', description: '文件内容会保留，可从文件列表重新打开。', name: () => document.getElementById('subject-title').textContent },
  { selector: '#secondary-close', key: 'closeCompare', title: '关闭对照文件？', command: '关闭对照', description: '只关闭右侧对照，文件内容会保留。', name: () => document.getElementById('secondary-path').textContent },
  { selector: '.tag-remove', key: 'removeTag', title: '移除对话标签？', command: '移除标签', description: '对话历史会保留，标签中未发送的输入会被丢弃。', name: node => '对话标签 ' + (node.closest('.note-anchor')?.querySelector('.tag-ordinal')?.textContent || '') },
  { selector: '.tag-delete', key: 'deleteNote', title: '删除这条备注？', command: '删除备注', description: '备注会被删除，原文件内容保持不变。', name: node => '备注 ' + (node.closest('.note-anchor')?.querySelector('.tag-ordinal')?.textContent || '') },
  { selector: '#chat-clear-frontdesk-context', key: 'clearFrontdeskContext', title: '清空前台 Agent 上下文？', command: '清空前台上下文', description: '仅开启新的前台会话。主控和 Worker 不受影响；原对话历史、报告、项目文件及未发送草稿保留。', name: () => '当前项目的前台 Agent', alwaysConfirm: true },
];

export function mountActionConfirmation({ scope, preferences, setPreferences, toast }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'action-confirmation';
  dialog.setAttribute('aria-labelledby', 'action-confirmation-title');
  dialog.setAttribute('aria-describedby', 'action-confirmation-name action-confirmation-description');
  const title = document.createElement('h2'); title.id = 'action-confirmation-title';
  const name = document.createElement('p'); name.id = 'action-confirmation-name';
  const description = document.createElement('p'); description.id = 'action-confirmation-description';
  const label = document.createElement('label'); label.className = 'confirmation-skip';
  const skip = document.createElement('input'); skip.type = 'checkbox'; skip.id = 'action-confirmation-skip';
  label.append(skip, document.createTextNode('此项目不再提醒'));
  const error = document.createElement('p'); error.id = 'action-confirmation-error'; error.setAttribute('role', 'status'); error.hidden = true;
  const buttons = document.createElement('div'); buttons.className = 'confirmation-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.id = 'action-confirmation-cancel'; cancel.textContent = '取消';
  const confirm = document.createElement('button'); confirm.type = 'button'; confirm.id = 'action-confirmation-accept'; confirm.className = 'ui-action';
  buttons.append(cancel, confirm);
  dialog.append(title, name, description, label, error, buttons);
  document.body.append(dialog);
  const restore = document.createElement('button');
  restore.type = 'button'; restore.id = 'restore-action-confirmations'; restore.textContent = '恢复操作确认';
  restore.title = '重新开启此项目的关闭文件、移除标签及删除备注确认';
  document.getElementById('files').append(restore);
  let pending = null;
  const replaying = new WeakSet();
  const path = () => document.getElementById('file-path').textContent;
  const valid = request => request && request.scope === scope() && request.path === path() && request.node.isConnected && !request.node.hidden && request.name === request.action.name(request.node);
  function refresh() { restore.hidden = !actions.some(action => preferences()?.[action.key] === true); }
  function dismiss() {
    const target = pending?.node;
    pending = null;
    skip.checked = false;
    if (dialog.open) dialog.close();
    if (target?.isConnected) target.focus({ preventScroll: true });
  }
  document.addEventListener('click', event => {
    const node = event.target.closest?.(actions.map(action => action.selector).join(','));
    if (!node || node.disabled || replaying.has(node)) return;
    const action = actions.find(action => node.matches(action.selector));
    if (!action.alwaysConfirm && preferences()?.[action.key] === true) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (pending) return;
    pending = { node, action, scope: scope(), path: path(), name: action.name(node) };
    title.textContent = action.title; name.textContent = pending.name; description.textContent = action.description;
    confirm.textContent = action.command;
    confirm.dataset.uiAction = action.key === 'deleteNote' || action.key === 'removeTag' ? 'danger' : 'primary';
    skip.checked = false; skip.title = '仅适用于当前项目的' + action.command + '操作';
    label.hidden=action.alwaysConfirm===true;
    error.hidden = true; confirm.disabled = false; cancel.disabled = false;
    dialog.showModal(); cancel.focus({ preventScroll: true });
  }, true);
  cancel.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('close', () => { pending = null; });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!confirm.disabled) dismiss(); }
  });
  confirm.addEventListener('click', async () => {
    if (confirm.disabled || !pending) return;
    const request = pending;
    if (!valid(request)) { dismiss(); toast('内容已变化，请重新选择操作。'); return; }
    confirm.disabled = true; cancel.disabled = true;
    if (skip.checked) {
      try {
        const result = await setPreferences({ ...preferences(), [request.action.key]: true });
        if (result?.ok === false) throw new Error('偏好未能保存，请取消勾选后重试。');
      } catch (failure) {
        error.textContent = failure?.message || '偏好未能保存，请取消勾选后重试。'; error.hidden = false;
        confirm.disabled = false; cancel.disabled = false; return;
      }
    }
    if (!valid(request)) { dismiss(); toast('内容已变化，请重新选择操作。'); return; }
    dismiss(); refresh();
    replaying.add(request.node);
    try { request.node.click(); } finally { replaying.delete(request.node); }
  });
  async function restorePreferences() {
    restore.disabled = true;
    try {
      const result = await setPreferences({});
      if (result?.ok === false) throw new Error('确认偏好未能保存，请重试。');
      refresh(); toast('已恢复此项目的操作确认。');return true;
    } catch (failure) { toast(failure?.message || '确认偏好未能保存，请重试。');throw failure; }
    finally { restore.disabled = false; }
  }
  restore.addEventListener('click',()=>void restorePreferences().catch(()=>{}));
  refresh();
  return { refresh, dismiss, restore:restorePreferences };
}
