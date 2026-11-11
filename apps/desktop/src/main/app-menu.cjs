'use strict';
// Shared application menu template.
//
// Window commands must never capture a window reference: the menu outlives
// window recreation, detached windows own their guarded close path, and a
// resident macOS app may have no window at all. 关闭窗口 therefore uses the
// native close role — it acts on the key window and macOS disables the item
// automatically when there is none — with an explicit Cmd/Ctrl+Shift+W
// accelerator so the unmodified Cmd/Ctrl+W stays with the renderer (it closes
// the focused content tab). The role reaches the window through its close
// event, so every existing save-confirmation guard keeps running. No item may
// claim Cmd/Ctrl+S: the renderer owns the save shortcut, and a menu
// accelerator would swallow or duplicate its flush. 打开项目… and the view
// actions route through the caller's live dispatcher, which reopens the
// navigation shell first when the app is windowless.

function buildApplicationMenuTemplate({ platform = process.platform, menuAction, textEdit } = {}) {
  if (typeof menuAction !== 'function' || typeof textEdit !== 'function') {
    throw new Error('application menu requires live dispatch callbacks');
  }
  return [
    // The app menu role provides macOS About/Services/Hide/Quit (Cmd+Q/Cmd+H).
    ...(platform === 'darwin' ? [{ role: 'appMenu', submenu: [
      {role:'about'},{type:'separator'},
      {label:'设置…',accelerator:'Cmd+,',click:()=>menuAction('settings')},
      {type:'separator'},{role:'services'},{type:'separator'},
      {role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'},
    ] }] : []),
    { label: '文件', submenu: [
      { label: '打开项目…', accelerator: 'CmdOrCtrl+O', click: () => menuAction('open-project') },
      { type: 'separator' },
      { role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+Shift+W' },
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { label: '剪切', accelerator: 'CmdOrCtrl+X', click: () => textEdit('cut') },
      { label: '复制', accelerator: 'CmdOrCtrl+C', click: () => textEdit('copy') },
      { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
    ] },
    { label: '视图', submenu: [
      { label: '专注模式', accelerator: 'CmdOrCtrl+Shift+F11', click: () => menuAction('focus') },
      { id: 'view.authorship', label: '显示修改者', type: 'checkbox', checked: true, click: () => menuAction('authorship-toggle') },
      { label: '当前文件修改记录…', click: () => menuAction('authorship-history') },
      { role: 'togglefullscreen', label: '全屏' },
    ] },
    // Window roles dispatch to the key window and auto-disable without one:
    // Cmd+M minimize, zoom and Ctrl+Cmd+F fullscreen come from these roles.
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放窗口' }] },
  ];
}

function createMenuDispatcher({shellOf,ensureShell,onError=console.error}) {
  return action=>{
    const root=shellOf();
    if(root&&!root.dead&&!root.wc.isDestroyed()){root.wc.send('nozeli:menu-action',action);return;}
    return Promise.resolve().then(()=>ensureShell()).then(shell=>{if(shell&&!shell.dead&&!shell.wc.isDestroyed())shell.wc.send('nozeli:menu-action',action);}).catch(onError);
  };
}

module.exports = { buildApplicationMenuTemplate, createMenuDispatcher };
