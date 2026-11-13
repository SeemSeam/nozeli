import {uiIcon} from './ui-icons.mjs';
import {setActionButton} from './ui-actions.mjs';
import './interface-appearance.css';

// Apply only to Nozeli-owned controls; driver/editor content retains its own UI.
// Selection menu, note editing and code jump icons are owned at runtime by
// agent-panel/app, not by this one-shot startup pass.
export function mountInterfaceAppearance() {
  const buttons = {
    'focus-exit':['restore-content','退出专注阅读'],
    'workspace-drawing':['draw','涂鸦'],
    'pdf-outline-toggle':['outline','PDF 目录'],
    'pdf-region':['select-region','区域选择'], 'pdf-prev':['previous','上一页'], 'pdf-next':['next','下一页'],
    'image-region':['select-region','区域选择'],
    'word-region':['select-region','区域选择'],
    'secondary-prev':['previous','对照上一页'], 'secondary-next':['next','对照下一页'],
    'secondary-close':['close-view','关闭对照文件'],
  };
  const plain = {
    'pick-project':'open-project','workspace-open-conversation':'show-conversation','open-settings':'settings',
    'pdf-search-toggle':'search','pdf-zoom-out':'zoom-out','pdf-zoom-in':'zoom-in',
    'image-out':'zoom-out','image-in':'zoom-in','word-zoom-out':'zoom-out','word-zoom-in':'zoom-in',
    'secondary-zoom-out':'zoom-out','secondary-zoom-in':'zoom-in',
  };
  for (const [id,action] of Object.entries(plain)) {
    const button=document.getElementById(id);if(button)setActionButton(button,action,{text:''});
  }
  for (const [id,[action,label]] of Object.entries(buttons)) {
    const button=document.getElementById(id);if(button)setActionButton(button,action,{label,text:''});
  }
  for(const id of ['file-toggle','toggle-sidebar']) {
    const button=document.getElementById(id);button.prepend(uiIcon('chevron-left'));button.classList.add('ui-edge-button');
  }
}

export function mountDrawingLauncher({activate,getProjectId,onError=()=>{}}) {
  const button=document.getElementById('workspace-drawing');
  let busy=false;
  const refresh=()=>{button.disabled=busy||!getProjectId();button.setAttribute('aria-busy',String(busy));};
  const begin=async()=>{if(!getProjectId()||busy)return;busy=true;refresh();try{await activate();}catch(error){onError(error.message);}finally{busy=false;refresh();}};
  button.addEventListener('click',begin);refresh();
  return {refresh,dispose(){button.removeEventListener('click',begin);}};
}
