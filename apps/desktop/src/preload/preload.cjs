const { contextBridge, ipcRenderer } = require('electron');

let flushHandler = null;

ipcRenderer.on('nozeli:flush', (_event, requestId) => {
  Promise.resolve()
    .then(() => (flushHandler ? flushHandler() : { ok: false, error: { code: 'NO_FLUSH', message: '页面尚未准备好保存。' } }))
    .then((result) => ipcRenderer.invoke('nozeli:invoke', 'session.flushed', { ...(result && typeof result === 'object' ? result : { ok: false }), requestId }))
    .catch((error) => ipcRenderer.invoke('nozeli:invoke', 'session.flushed', {
      ok: false,
      requestId,
      error: { code: 'FLUSH_FAILED', message: error?.message || String(error) },
    }));
});

const push = { 'menu.action': new Set(), 'external.open': new Set(), agent: new Set(), terminal: new Set(), lsp: new Set(), tex: new Set(), document:new Set(), 'document.sync':new Set(), 'document.release':new Set(), 'quit.confirm': new Set() };
push['workspace.changed'] = new Set();
push['workspace.control'] = new Set();
push['isolated-preview'] = new Set();
ipcRenderer.on('nozeli:isolated-preview', (_, payload) => { for (const handler of push['isolated-preview']) handler(payload); });
ipcRenderer.on('nozeli:workspace-changed', (_, payload) => { for (const handler of push['workspace.changed']) handler(payload); });
ipcRenderer.on('nozeli:workspace-control', (_, payload) => { for (const handler of push['workspace.control']) handler(payload); });
ipcRenderer.on('nozeli:document',(_,payload)=>{for(const handler of push.document)handler(payload);});
ipcRenderer.on('nozeli:document-sync',(_,payload)=>{for(const handler of push['document.sync'])handler(payload);});
ipcRenderer.on('nozeli:document-release',(_,payload)=>{for(const handler of push['document.release'])handler(payload);});
ipcRenderer.on('nozeli:menu-action',(_,action)=>{for(const handler of push['menu.action'])handler(action);});
ipcRenderer.on('nozeli:open-request',()=>{for(const handler of push['external.open'])handler();});
ipcRenderer.on('nozeli:agent', (_event, payload) => { for (const handler of push.agent) handler(payload); });
ipcRenderer.on('nozeli:terminal', (_event, payload) => { for (const handler of push.terminal) handler(payload); });
ipcRenderer.on('nozeli:tex', (_event, payload) => { for (const handler of push.tex) handler(payload); });
ipcRenderer.on('nozeli:lsp', (_event, payload) => { for (const handler of push.lsp) handler(payload); });
ipcRenderer.on('nozeli:quit-confirm', () => { for (const handler of push['quit.confirm']) handler(); });

contextBridge.exposeInMainWorld('nozeli', {
  invoke(op, payload) {
    return ipcRenderer.invoke('nozeli:invoke', op, payload ?? {});
  },
  subscribe(event, handler) {
    if (typeof handler !== 'function') return () => {};
    if (event === 'session.flush') {
      flushHandler = handler;
      return () => { if (flushHandler === handler) flushHandler = null; };
    }
    if (!Object.hasOwn(push, event)) return () => {};
    push[event].add(handler);
    return () => push[event].delete(handler);
  },
});
