import './workspace-conversation-controls.css';
import './panel-menu.css';
import { panelButton, observePanelWidth } from './panel-menu.mjs';
export {uiIcon as workspaceIcon} from './ui-icons.mjs';

// Window geometry belongs to the native workspace, never to conversation preferences.
export function mountConversationControls({close}) {
  const controls = document.querySelector('#conversation-head .conversation-controls');
  const font = panelButton('chat-font-settings', '对话字号', true);
  font.dataset.chatFont = '';
  controls.prepend(font);
  const more = panelButton('chat-more');
  more.dataset.chatMore = '';
  controls.append(more);
  observePanelWidth(document.getElementById('conversation-head'));
  const actions = [
    {id:'chat-workspace-columns',label:'左右拆分',command:{type:'split',axis:'x',side:'after'}},
    {id:'chat-workspace-rows',label:'上下拆分',command:{type:'split',axis:'y',side:'after'}},
    {id:'chat-workspace-maximize',label:'最大化 / 还原当前组',command:{type:'maximize'}},
    {id:'chat-workspace-detach',label:'脱离为独立窗口',command:{type:'detach'}},
    {id:'chat-workspace-dock',label:'移回主窗口',command:{type:'dock'}},
    {id:'chat-workspace-single',label:'合并本窗口所有组',command:{type:'preset',preset:'single'}},
    {id:'chat-workspace-close',label:'关闭对话标签',command:{type:'close'}},
  ];
  function run(id) {
    const action = actions.find(item => item.id === id);
    if (!action) return;
    document.dispatchEvent(new CustomEvent('workspace-action', {
      bubbles:true,
      detail:{command:{...action.command}},
    }));
  }
  return {
    close,
    commands: () => actions.filter(item => item.command.type !== 'dock' || window.__workspaceScope?.windowId !== 'main').map(({id,label}) => ({id,label})),
    run,
    render() {
      controls.classList.add('chat-window-controls');
    },
  };
}
