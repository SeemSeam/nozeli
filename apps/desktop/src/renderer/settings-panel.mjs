import './settings-panel.css';
import {setIconButton} from './ui-icons.mjs';
import {mountProviderSettings} from './provider-settings.mjs';
import {mountAppearanceSettings} from './settings-appearance.mjs';
import './settings-appearance.css';

// Application preferences have one home; project/session controls remain explicit.
export function mountSettingsPanel({invoke,onProjectSettings,onInitialize}) {
  const $=id=>document.getElementById(id);
  const dialog=$('settings-dialog'),trigger=$('open-settings');
  setIconButton(trigger,'settings',{label:'设置'});
  setIconButton($('settings-close'),'close',{label:'关闭设置'});
  let returnFocus=trigger;
  const appearance=mountAppearanceSettings({container:$('settings-appearance')});
  const provider=mountProviderSettings({invoke,providers:$('settings-provider'),models:$('settings-models'),onProjectSettings:()=>leave(onProjectSettings)});
  function leave(action){dialog.close();void action?.();}
  function select(id){
    for(const button of dialog.querySelectorAll('[data-settings-section]')){
      const active=button.dataset.settingsSection===id;
      button.setAttribute('aria-current',active?'page':'false');
      $(button.dataset.settingsSection).hidden=!active;
    }
    dialog.querySelector('.settings-content').scrollTop=0;
  }
  async function open(section='settings-provider'){
    if(!dialog.open){returnFocus=document.activeElement;dialog.showModal();}
    select(section);appearance.refresh();
    $('settings-error').textContent='';
    try{await provider.refresh();}catch(error){$('settings-error').textContent=error.message;}
  }
  trigger.addEventListener('click',()=>void open());
  $('settings-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{if(returnFocus?.isConnected&&!returnFocus.closest('[inert]'))returnFocus.focus();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  for(const button of dialog.querySelectorAll('[data-settings-section]'))button.addEventListener('click',()=>select(button.dataset.settingsSection));
  $('settings-initialize').addEventListener('click',()=>leave(onInitialize));
  $('settings-project-agent').addEventListener('click',()=>leave(onProjectSettings));
  window.addEventListener('settings:enter-zen',()=>{dialog.close();$('toggle-focus').click();});
  window.addEventListener('nozeli-open-settings',()=>void open());
  return {open};
}
