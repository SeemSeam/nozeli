import {setActionButton} from './ui-actions.mjs';
export function usesNativeWindowChrome(){return globalThis.nozeli?.platform==='darwin';}
export function windowBrand(){const image=document.createElement('img');image.src='./nozeli-small-icon.png';image.alt='Nozeli';image.className='nozeli-window-logo';return image;}
export function windowControls(invoke){
 if(usesNativeWindowChrome())return document.createDocumentFragment();const box=document.createElement('div');box.className='nozeli-window-controls';
 for(const [action,key,label]of [['minimize','window-minimize','最小化窗口'],['maximize','window-maximize','最大化或还原窗口'],['close','close-view','关闭窗口']]){
  const button=document.createElement('button');button.type='button';setActionButton(button,key,{label,text:''});button.dataset.windowAction=action;
  button.onclick=()=>invoke('workspace.control',{type:'window-control',action}).then(result=>{if(!result.ok)console.error(result.error.message);});box.append(button);
 }
 return box;
}
