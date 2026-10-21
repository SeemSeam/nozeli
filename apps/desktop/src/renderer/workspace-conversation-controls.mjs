import './workspace-conversation-controls.css';
export {uiIcon as workspaceIcon} from './ui-icons.mjs';

// Window geometry belongs to the native workspace, never to conversation preferences.
export function mountConversationControls({close}) {
  const controls = document.querySelector('#conversation-head .conversation-controls');
  for(const [id,label]of [['chat-workspace-detach','独立窗口'],['chat-workspace-close','−']]){
    const button=document.createElement('button');button.type='button';button.dataset.chatWindowAction=id;button.textContent=label;
    button.title=id==='chat-workspace-close'?'收起到底部，保留对话与草稿':label;
    button.setAttribute('aria-label',id==='chat-workspace-close'?'收起对话到底部':label);
    button.onclick=()=>void run(id);controls.append(button);
  }
  const header=document.getElementById('conversation-head');
  const detached = () => Boolean(window.__workspaceScope?.windowId && window.__workspaceScope.windowId !== 'main');
  const updateChrome = () => {
    header.classList.toggle('nozeli-draggable', detached());
    header.classList.toggle('conversation-head-detached', detached());
  };
  window.nozeli.subscribe('workspace.control',()=>queueMicrotask(updateChrome));updateChrome();
  const actions = [
    {id:'chat-workspace-detach',label:'脱离为独立窗口',command:{type:'detach'}},
    {id:'chat-workspace-dock',label:'移回主窗口',command:{type:'dock'}},
    {id:'chat-workspace-close',label:'收起到底部',command:{type:'closePane'}},
  ];
  const windowActions = [
    {id:'chat-window-minimize',label:'最小化窗口',action:'minimize'},
    {id:'chat-window-maximize',label:'最大化或还原窗口',action:'maximize'},
    {id:'chat-window-close',label:'关闭窗口',action:'close'},
  ];
  function commands() {
    const entries = actions.filter(item => item.command.type !== 'dock' || detached()).map(({id,label}) => ({id,label}));
    if (detached()) entries.push(...windowActions.map(({id,label}) => ({id,label})));
    const history = document.getElementById('chat-history-toggle');
    if (history) entries.push({id:'chat-history-toggle',label:header.closest('.compact-composer')?'展开对话历史':'收起对话历史',enabled:!history.disabled});
    const clear = document.getElementById('chat-clear-frontdesk-context');
    if (clear && !clear.hidden) entries.push({id:'chat-clear-frontdesk-context',label:clear.textContent,enabled:!clear.disabled});
    return entries;
  }
  async function run(id) {
    if(id==='chat-window-close')return run('chat-workspace-close');
    if (id === 'chat-clear-frontdesk-context' || id === 'chat-history-toggle') {
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
