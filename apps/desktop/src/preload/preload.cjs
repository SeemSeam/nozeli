const { contextBridge, ipcRenderer } = require('electron');

let flushHandler = null;
let activeFlushRequest = null;
let activeFlushDetail = null;
let flushQueue = Promise.resolve();
// Flush-scoped writes: exactly the ops a lifecycle/barrier flush itself must
// persist. They carry the active flush receipt id so the host can admit them
// against the real pending receipt instead of blanket-exempting lifecycle.
const flushScopedWrites = new Set(['workspace.recovery', 'file.draft', 'file.save', 'file.retain', 'managed.review.instruction.save', 'managed.review.save']);

ipcRenderer.on('nozeli:flush', (_event, request) => {
  // Review-decision barriers send {requestId, reviewBarrier:true, ...}; a
  // malformed payload must never be acked against a guessed receipt id.
  const requestId = typeof request === 'string' ? request : typeof request?.requestId === 'string' ? request.requestId : null;
  const detail = request !== null && typeof request === 'object' ? request : null;
  if (!requestId) return;
  flushQueue=flushQueue.catch(()=>{} )
    .then(async () => {activeFlushRequest=requestId;activeFlushDetail=detail;try{return flushHandler ? await flushHandler(detail) : { ok: false, error: { code: 'NO_FLUSH', message: '页面尚未准备好保存。' } };}finally{if(activeFlushRequest===requestId){activeFlushRequest=null;activeFlushDetail=null;}}})
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
push['demo.changed'] = new Set();
push['web.state'] = new Set();
ipcRenderer.on('nozeli:web-state', (_, payload) => { for (const handler of push['web.state']) handler(payload); });
ipcRenderer.on('nozeli:demo-changed', (_, payload) => { for (const handler of push['demo.changed']) handler(payload); });
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
    const scoped=activeFlushRequest&&flushScopedWrites.has(op);
    return ipcRenderer.invoke('nozeli:invoke', op, scoped ? {...payload,flushRequestId:activeFlushRequest} : payload ?? {});
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
