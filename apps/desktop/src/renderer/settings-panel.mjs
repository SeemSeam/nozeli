import './settings-panel.css';
import {setIconButton} from './ui-icons.mjs';
import {mountProviderSettings} from './provider-settings.mjs';
import {mountAppearanceSettings} from './settings-appearance.mjs';
import {mountAgentSettings} from './settings-agents.mjs';
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
  function leave(action){dialog.close();void action?.();}
  function select(id){
    if(!Array.from(dialog.querySelectorAll('[data-settings-section]')).some(button=>button.dataset.settingsSection===id))id='settings-provider';
    for(const button of dialog.querySelectorAll('[data-settings-section]')){
      const active=button.dataset.settingsSection===id;
      button.setAttribute('aria-current',active?'page':'false');
      $(button.dataset.settingsSection).hidden=!active;
    }
    dialog.querySelector('.settings-content').scrollTop=0;
    if(id==='settings-agents')void agents.refresh();
    if(id==='settings-models')void provider.refresh();
    if(id==='settings-provider')void provider.refreshProviders();
  }
  async function open(section='settings-provider'){
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
  $('provider-console-toggle').addEventListener('click',()=>dialog.close());
  window.addEventListener('nozeli-open-settings',event=>void open(typeof event.detail==='string'?event.detail:undefined));
  return {open,projectChanged(){if(dialog.open&&!$('settings-agents').hidden)void agents.refresh();}};
}
