import './settings-panel.css';
import {setIconButton} from './ui-icons.mjs';
import {mountProviderSettings} from './provider-settings.mjs';
import {mountAppearanceSettings} from './settings-appearance.mjs';
import {mountAgentSettings} from './settings-agents.mjs';
import {mountProjectSettings} from './settings-project.mjs';
import './settings-appearance.css';

// Application preferences have one home; project/session controls remain explicit.
export function mountSettingsPanel({invoke,onInitialize,getProjectId=()=>null}) {
  const $=id=>document.getElementById(id);
  const dialog=$('settings-dialog'),trigger=$('open-settings');
  setIconButton(trigger,'settings',{label:'设置'});
  setIconButton($('settings-close'),'close',{label:'关闭设置'});
  const zenButton=$('settings-zen');
  function refreshZen(){const active=$('app').classList.contains('focus-mode');zenButton.textContent=active?'退出 Zen 专注模式':'进入 Zen 专注模式';zenButton.setAttribute('aria-pressed',String(active));}
  zenButton.addEventListener('click',()=>{dialog.close();$('toggle-focus').click();});
  document.addEventListener('zen:change',refreshZen);
  let returnFocus=trigger;
  const appearance=mountAppearanceSettings({container:$('settings-appearance')});
  const agents=mountAgentSettings({invoke,container:$('settings-agents'),getProjectId});
  const provider=mountProviderSettings({invoke,providers:$('settings-provider'),models:$('settings-models')});
  const projectSettings=mountProjectSettings({invoke,getProjectId});
  let selected='settings-appearance';
  const display=$('settings-reading-display');display.innerHTML='<h3>阅读显示 · 所有项目共享</h3><label><input type="checkbox" data-authorship-visible>显示修改者</label><p>影响支持来源标记的文本与 Word，不改变文档内容。</p><p role="status"></p>';
  const authorship=display.querySelector('input'),displayStatus=display.querySelector('[role="status"]');
  let authorshipRequest=0;authorship.disabled=true;
  authorship.onchange=async()=>{const request=++authorshipRequest;authorship.disabled=true;displayStatus.textContent='正在保存…';try{const result=await invoke('view.authorship',{visible:authorship.checked});if(request!==authorshipRequest)return;displayStatus.textContent=result.ok?'已保存，所有窗口生效。':result.error.message;}catch(error){if(request===authorshipRequest)displayStatus.textContent=error.message;}finally{if(request===authorshipRequest)authorship.disabled=false;}};
  window.nozeli.subscribe('workspace.control',event=>{if(event.type==='authorship-visibility')authorship.checked=event.visible;});
  function identity(){const source=$('project-name');$('settings-project-name').textContent=getProjectId()?source.textContent:'未打开项目';$('settings-project-path').textContent=getProjectId()?source.title:'';$('settings-copy-project-path').disabled=!getProjectId();}
  $('settings-copy-project-path').onclick=()=>void invoke('document.clipboard',{action:'write',text:$('settings-project-path').textContent});
  function leave(action){dialog.close();void action?.();}
  function select(id){
    if(!Array.from(dialog.querySelectorAll('[data-settings-section]')).some(button=>button.dataset.settingsSection===id))id='settings-appearance';
    for(const button of dialog.querySelectorAll('[data-settings-section]')){
      const active=button.dataset.settingsSection===id;
      button.setAttribute('aria-current',active?'page':'false');
      $(button.dataset.settingsSection).hidden=!active;
    }
    dialog.querySelector('.settings-content').scrollTop=0;
    selected=id;identity();void projectSettings.refresh(id);
    if(id==='settings-reading-display'){const request=++authorshipRequest;authorship.disabled=true;void invoke('view.authorship').then(result=>{if(request!==authorshipRequest)return;if(result.ok){authorship.checked=result.value.visible;displayStatus.textContent='';authorship.disabled=false;}else displayStatus.textContent=result.error.message;}).catch(error=>{if(request===authorshipRequest)displayStatus.textContent=error.message;});}
    if(id==='settings-agents')void agents.refresh();
    if(id==='settings-models')void provider.refresh();
    if(id==='settings-provider')void provider.refreshProviders();
  }
  async function open(section=selected){
    const scope=window.__workspaceScope;
    if(scope&&scope.role!=='shell'){const result=await invoke('workspace.control',{type:'open-settings',projectId:scope.projectId,section});if(!result.ok)throw Error(result.error?.message||'主窗口设置暂不可用');return;}
    if(!dialog.open){returnFocus=document.activeElement;dialog.showModal();}
    select(section);appearance.refresh();
    refreshZen();
    $('settings-error').textContent='';
  }
  trigger.addEventListener('click',()=>void open());
  $('settings-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{if(returnFocus?.isConnected&&!returnFocus.closest('[inert]'))returnFocus.focus();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  for(const button of dialog.querySelectorAll('[data-settings-section]'))button.addEventListener('click',()=>select(button.dataset.settingsSection));
  $('settings-initialize').addEventListener('click',()=>leave(onInitialize));
  $('settings-demo-help').addEventListener('click',()=>leave(()=>window.dispatchEvent(new Event('nozeli-demo-start'))));
  window.addEventListener('nozeli-open-settings',event=>void open(typeof event.detail==='string'?event.detail:undefined));
  return {open,projectChanged(){identity();if(dialog.open){if(selected.startsWith('settings-project-'))void projectSettings.refresh(selected);if(selected==='settings-agents')void agents.projectChanged();}}};
}
