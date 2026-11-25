import './workspace-conversation-controls.css';
import {setActionButton} from './ui-actions.mjs';
import {panelButton} from './panel-menu.mjs';
import {usesNativeWindowChrome} from './window-chrome.mjs';
import {mountWorkspaceTitleDrag} from './workspace-title-drag.mjs';
export {uiIcon as workspaceIcon} from './ui-icons.mjs';

// Window geometry belongs to the native workspace, never to conversation preferences.
export function mountConversationControls({close}) {
  const controls = document.querySelector('#conversation-head .conversation-controls');
  // One title bar owns conversation actions, including when detached.
  const detach=document.createElement('button');detach.type='button';detach.id='chat-workspace-detach';detach.dataset.chatWindowAction='chat-workspace-detach';detach.className='chat-tool';
  setActionButton(detach,'float-view',{label:'独立窗口',text:''});
  detach.onclick=()=>void run(detached()?'chat-workspace-dock':'chat-workspace-detach');controls.append(detach);
  const more=panelButton('chat-more');more.dataset.chatMore='';more.classList.add('chat-tool');controls.append(more);
  const collapse=document.createElement('button');collapse.type='button';collapse.id='chat-workspace-close';collapse.dataset.chatWindowAction='chat-workspace-close';collapse.className='chat-tool';
  setActionButton(collapse,'hide-conversation',{text:''});
  collapse.onclick=()=>void run('chat-workspace-close');controls.append(collapse);
  const header=document.getElementById('conversation-head');
  const detached = () => Boolean(window.__workspaceScope?.windowId && window.__workspaceScope.windowId !== 'main');
  const scope=window.__workspaceScope;
  const invoke=async(op,payload)=>{const r=await window.nozeli.invoke(op,{projectId:scope.projectId,...payload});if(!r.ok)throw Error(r.error?.message||'工作区操作失败');return r.value;};
  if(scope?.role==='surface'&&scope.kind==='conversation')mountWorkspaceTitleDrag({tree:header,conversationScope:scope,call:invoke,toast:message=>{document.getElementById('compose-status').textContent=message;}});
  const updateChrome = () => {
    header.classList.toggle('nozeli-draggable', detached()&&!usesNativeWindowChrome());
    header.classList.toggle('conversation-head-detached', detached());
    setActionButton(detach,detached()?'dock-view':'float-view',{label:detached()?'将此窗口移回主工作区':'打开独立窗口',text:''});
  };
  window.nozeli.subscribe('workspace.control',()=>queueMicrotask(updateChrome));updateChrome();
  const actions = [
    {id:'chat-workspace-split-x',label:'向右拆分',command:{type:'split',axis:'x',side:'after'}},
    {id:'chat-workspace-split-y',label:'向下拆分',command:{type:'split',axis:'y',side:'after'}},
    {id:'chat-workspace-detach',label:'脱离为独立窗口',command:{type:'detach'}},
    {id:'chat-workspace-dock',label:'移回主窗口',command:{type:'dock'}},
    {id:'chat-workspace-close',label:'收起到底部',command:{type:'closeContent'}},
  ];
  const windowActions = [
    {id:'chat-window-minimize',label:'最小化窗口',action:'minimize'},
    {id:'chat-window-maximize',label:'最大化或还原窗口',action:'maximize'},
  ];
  function commands() {
    const entries=scope?.role==='surface'?[{id:'chat-workspace-layout',label:'分区与布局…'}]:[];
    const runtime = document.getElementById('chat-session-runtime');
    if (runtime && !runtime.hidden) entries.push({id:'chat-session-runtime',label:'会话管理：压缩、重载与诊断…',enabled:!runtime.disabled});
    entries.push({id:'chat-agent-details',label:'连接与历史…'});
    if (detached()&&!usesNativeWindowChrome()) entries.push(...windowActions.map(({id,label}) => ({id,label})));
    const clear = document.getElementById('chat-clear-frontdesk-context');
    if (clear && !clear.hidden) entries.push({id:'chat-clear-frontdesk-context',label:clear.textContent,enabled:!clear.disabled});
    return entries;
  }
  async function run(id) {
    if(id==='chat-agent-details')return window.dispatchEvent(new Event('nozeli-agent-details'));
    if(id==='chat-workspace-layout'){const rect=more.getBoundingClientRect();return invoke('workspace.control',{type:'conversation-layout-menu',x:rect.left,y:rect.bottom});}
    if (['chat-clear-frontdesk-context','chat-session-runtime'].includes(id)) {
      const button = document.getElementById(id);
      if (button && !button.hidden && !button.disabled) button.click();
      return;
    }
    const native = windowActions.find(item => item.id === id);
    if (native) {
      if (!detached()) return;
      const result = await window.nozeli.invoke('workspace.control', {type:'window-control',action:native.action});
      if (!result.ok) throw new Error(result.error?.message || '窗口操作失败');
      return;
    }
    const action = actions.find(item => item.id === id);
    if (!action) return;
    document.dispatchEvent(new CustomEvent('workspace-action', {
      bubbles:true,
      detail:{command:{...action.command}},
    }));
  }
  return {
    close,
    commands,
    run,
    render() {
      controls.classList.add('chat-window-controls');
    },
  };
}
