const { contextBridge, ipcRenderer } = require('electron');

let flushHandler = null;
// Flush-scoped writes: exactly the ops a lifecycle/barrier flush itself must
// persist. They carry the active flush receipt id so the host can admit them
// against the real pending receipt instead of blanket-exempting lifecycle.
const flushScopedWrites = new Set(['workspace.displayView.write','workspace.recovery', 'file.draft', 'file.save', 'file.retain', 'managed.review.instruction.save', 'managed.review.save']);

// Sandboxed Electron preloads cannot require local CommonJS modules.
function createFlushQueue({ack,getHandler}) {
  const state={queue:Promise.resolve(),active:null};
  return {
    activeRequest(){return state.active;},
    enqueue(request){
      const requestId=typeof request==='string'?request:typeof request?.requestId==='string'?request.requestId:null;
      if(!requestId)return;
      const detail=request!==null&&typeof request==='object'?request:null;
      state.queue=state.queue.catch(()=>{}).then(async()=>{
        state.active=requestId;
        try{return getHandler()?await getHandler()(detail):{ok:false,error:{code:'NO_FLUSH',message:'页面尚未准备好保存。'}};}
        finally{if(state.active===requestId)state.active=null;}
      }).then(result=>ack({...(result&&typeof result==='object'?result:{ok:false,error:{code:'NO_FLUSH_RESULT',message:'保存流程未返回结果，未确认保存完成。'}}),requestId})).catch(error=>{
        void Promise.resolve().then(()=>ack({ok:false,requestId,error:{code:'FLUSH_FAILED',message:error?.message||String(error)}})).catch(()=>{});
      });
    },
  };
}

// One flush runs at a time; its result reaches the host with the exact
// error/composing detail so the recovery dialog never has to guess.
const flushQueue = createFlushQueue({
  ack: payload => ipcRenderer.invoke('nozeli:invoke', 'session.flushed', payload),
  getHandler: () => flushHandler,
});
ipcRenderer.on('nozeli:flush', (_event, request) => flushQueue.enqueue(request));

const push = { 'menu.action': new Set(), 'external.open': new Set(), agent: new Set(), terminal: new Set(), lsp: new Set(), tex: new Set(), document:new Set(), 'document.sync':new Set(), 'document.release':new Set(), 'quit.confirm': new Set() };
push['workspace.changed'] = new Set();
push['workspace.control'] = new Set();
push['isolated-preview'] = new Set();
push['demo.changed'] = new Set();
push.update = new Set();
ipcRenderer.on('nozeli:update', (_, payload) => { for (const handler of push.update) handler(payload); });
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
    const active = flushQueue.activeRequest();
    const scoped = active && flushScopedWrites.has(op);
    return ipcRenderer.invoke('nozeli:invoke', op, scoped ? {...payload, flushRequestId: active} : payload ?? {});
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
