const phases={checking:'正在检查更新',downloading:'正在下载更新',staging:'正在校验与准备更新',ready:'更新已就绪', 'waiting-idle':'更新已下载，等待空闲',installing:'正在安全退出并安装更新',current:'已是当前通道最新版本',error:'更新失败，当前版本保留',unsupported:'当前安装不支持自动安装',stopped:'自动更新已暂停'};
export function mountAutoUpdate({root,invoke,subscribe}){
  const heading=document.createElement('h3');heading.textContent='应用更新';
  const policy=document.createElement('p');policy.className='settings-hint';policy.textContent='从 Nozeli GitHub Releases 检查更新，包含 Alpha / Beta 预发行。受支持的 Linux x64 安装会下载并校验，在无未保存编辑、无在途任务且系统空闲时安装重启；更新就绪后也可点击“安装并重启”，只跳过空闲等待，不跳过保存与任务保护。失败保留旧版本；其他平台或不满足安装安全条件时只检查，不自动替换。';
  const version=document.createElement('p'),state=document.createElement('p'),detail=document.createElement('p');state.setAttribute('role','status');detail.className='settings-hint';
  const progress=document.createElement('progress');progress.hidden=true;progress.setAttribute('aria-label','更新下载进度');
  const label=document.createElement('label'),enabled=document.createElement('input');label.className='auto-update-toggle';enabled.type='checkbox';label.append(enabled,document.createTextNode(' 自动检查、下载并在空闲时安装重启'));
  const actions=document.createElement('div');actions.className='dialog-actions';
  const check=document.createElement('button'),cancel=document.createElement('button'),install=document.createElement('button');check.type=cancel.type=install.type='button';check.textContent='立即检查更新';cancel.textContent='取消本次下载';cancel.hidden=true;install.textContent='安装并重启';install.disabled=true;actions.append(check,install,cancel);
  root.append(heading,policy,version,label,state,detail,progress,actions);let busy=false,lastValue;
  function render(value){
    if(!value)return;lastValue=value;version.textContent='当前版本：'+value.currentVersion+(value.availableVersion?' · 可用版本：'+value.availableVersion:'');enabled.checked=value.enabled===true;
    label.lastChild.textContent=value.supported?' 自动检查、下载并在空闲时安装重启':' 自动检查更新（当前安装不自动下载或安装）';
    state.textContent=phases[value.phase]||'自动更新待检查';detail.textContent=value.message||'';
    const downloading=value.phase==='downloading';progress.hidden=!downloading;cancel.hidden=!downloading;
    if(downloading){const bytes=value.progress?.received||0,total=value.progress?.total||0;if(total>0){progress.max=total;progress.value=bytes;}else progress.removeAttribute('value');}
    check.disabled=busy||['checking','downloading','staging','installing'].includes(value.phase);enabled.disabled=value.phase==='installing';
    install.disabled=busy||!value.supported||!['ready','waiting-idle'].includes(value.phase);
    install.title=!value.supported?'当前安装不支持自动替换':!['ready','waiting-idle'].includes(value.phase)?'请先检查更新，等待下载与校验完成':'立即尝试安全安装；不等待系统空闲，不跳过未保存编辑或在途任务保护';
  }
  async function request(op,payload={}){const result=await invoke(op,payload);if(!result.ok)throw Error(result.error?.message||'更新操作失败');render(result.value);return result.value;}
  check.onclick=async()=>{busy=true;render(lastValue);let failure;try{await request('update.check');}catch(error){failure=error.message;}finally{busy=false;render(lastValue);if(failure)state.textContent=failure;}};
  install.onclick=async()=>{
    if(busy||install.disabled)return;
    busy=true;render(lastValue);let failure;
    const dialog=root.closest('dialog'),wasOpen=dialog?.open;
    if(wasOpen)dialog.close();
    try{await request('update.install');}catch(error){failure=error.message;}
    finally{busy=false;render(lastValue);if(failure)detail.textContent=failure;if(lastValue?.phase!=='installing'&&wasOpen&&!dialog.open)dialog.showModal();}
  };
  cancel.onclick=()=>void request('update.cancel').catch(error=>{state.textContent=error.message;});
  enabled.onchange=()=>void request('update.preferences',{enabled:enabled.checked}).catch(error=>{enabled.checked=!enabled.checked;state.textContent=error.message;});
  const unsubscribe=subscribe('update',render);void request('update.status').catch(error=>{state.textContent=error.message;});
  return {refresh:()=>request('update.status'),destroy:()=>{unsubscribe();root.replaceChildren();}};
}
