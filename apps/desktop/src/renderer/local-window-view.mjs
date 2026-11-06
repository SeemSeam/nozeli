import {defaultLocalWindowView,validLocalWindowView} from './local-window.mjs';
export function createLocalWindowView({invoke,key,initial=defaultLocalWindowView(),legacy=null}) {
  const projectId=key.projectId||key.projectInstanceId;
  let boundKey=key, loaded=null;
  const call=async(op,payload)=>{const result=await invoke(op,payload);if(!result.ok)throw Object.assign(Error(result.error?.message||'窗口位置保存失败'),result.error);return result.value;};
  return {
    async load() {
      const result=await call('workspace.displayView.read',{projectId,key});boundKey=result.key;Object.assign(key,result.key);loaded=result.state;
      if(loaded&&!validLocalWindowView(loaded))throw Error('窗口展示数据版本未知，原记录已保留。');
      if(!loaded&&legacy&&initial.placement.mode==='manual') {
        const saved=await call('workspace.displayView.write',{projectId,key:boundKey,expectedRevision:0,next:initial,reason:'reset',legacy});
        loaded=saved.conflict?saved.current:{...initial,revision:saved.revision};
      }
      return loaded||structuredClone(initial);
    },
    async commitView({expectedRevision,next,reason}) {return call('workspace.displayView.write',{projectId,key:boundKey,expectedRevision,next,reason,...(!loaded&&legacy?{legacy}:{})}).then(result=>{if(!result.conflict)loaded=next;return result;});}
  };
}
