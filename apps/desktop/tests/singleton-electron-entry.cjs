// Real Electron bootstrap: observe production startup, without replacing APIs.
const { app, BrowserWindow } = require('electron');
const send = value => { if (process.connected) process.send(value); };
app.on('second-instance', (_event, argv, cwd) => send({ event: 'second-instance', argv, cwd }));
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL() !== 'about:blank') {
      await win.webContents.executeJavaScript("window.__singletonOpenRequests=0;void window.nozeli.subscribe('external.open',()=>{window.__singletonOpenRequests++;});");
    }
    send({ event: 'window-ready', userData: app.getPath('userData'), sessionData: app.getPath('sessionData') });
  });
});
process.on('message', message => {
  if (message === 'extra-window') {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    void win.loadURL('about:blank').then(() => send({ event: 'window-count', count: BrowserWindow.getAllWindows().length }));
  }
  if (message === 'exit') app.exit(0);
  if (message === 'wake-count') {
    const win = BrowserWindow.getAllWindows().find(value => value.webContents.getURL() !== 'about:blank');
    void win.webContents.executeJavaScript('window.__singletonOpenRequests').then(count => send({ event: 'wake-count', count }));
  }
});
require('../src/main/main.cjs');
