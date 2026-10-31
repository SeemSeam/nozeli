const phases={checking:'正在检查更新',downloading:'正在下载更新',staging:'正在校验与准备更新',ready:'更新已就绪', 'waiting-idle':'更新已下载，等待空闲',installing:'正在安全退出并安装更新',current:'已是当前通道最新版本',error:'更新失败，当前版本保留',unsupported:'当前安装不支持自动安装',stopped:'自动更新已暂停'};
export function mountAutoUpdate({root,invoke,subscribe}){
  const heading=document.createElement('h3');heading.textContent='应用更新';
  const policy=document.createElement('p');policy.className='settings-hint';policy.textContent='从 Nozeli GitHub Releases 检查 Linux x64 更新，包含 Alpha 预发行。自动下载并校验后，仅在无未保存编辑、无在途任务且系统空闲时安装重启；失败保留旧版本。';
  const version=document.createElement('p'),state=document.createElement('p'),detail=document.createElement('p');state.setAttribute('role','status');detail.className='settings-hint';
  const progress=document.createElement('progress');progress.hidden=true;progress.setAttribute('aria-label','更新下载进度');
  const label=document.createElement('label'),enabled=document.createElement('input');label.className='auto-update-toggle';enabled.type='checkbox';label.append(enabled,document.createTextNode(' 自动检查、下载并在空闲时安装重启'));
  const actions=document.createElement('div');actions.className='dialog-actions';
  const check=document.createElement('button'),cancel=document.createElement('button');check.type=cancel.type='button';check.textContent='立即检查更新';cancel.textContent='取消本次下载';cancel.hidden=true;actions.append(check,cancel);
  root.append(heading,policy,version,label,state,detail,progress,actions);let busy=false;
  function render(value){
    if(!value)return;version.textContent='当前版本：'+value.currentVersion+(value.availableVersion?' · 可用版本：'+value.availableVersion:'');enabled.checked=value.enabled===true;
    state.textContent=phases[value.phase]||'自动更新待检查';detail.textContent=value.message||'';
    const downloading=value.phase==='downloading';progress.hidden=!downloading;cancel.hidden=!downloading;
    if(downloading){const bytes=value.progress?.received||0,total=value.progress?.total||0;if(total>0){progress.max=total;progress.value=bytes;}else progress.removeAttribute('value');}
    check.disabled=busy||['checking','downloading','staging','installing'].includes(value.phase);enabled.disabled=value.phase==='installing';
  }
  async function request(op,payload={}){const result=await invoke(op,payload);if(!result.ok)throw Error(result.error?.message||'更新操作失败');render(result.value);return result.value;}
  check.onclick=async()=>{busy=true;check.disabled=true;try{await request('update.check');}catch(error){state.textContent=error.message;}finally{busy=false;check.disabled=false;}};
  cancel.onclick=()=>void request('update.cancel').catch(error=>{state.textContent=error.message;});
  enabled.onchange=()=>void request('update.preferences',{enabled:enabled.checked}).catch(error=>{enabled.checked=!enabled.checked;state.textContent=error.message;});
  const unsubscribe=subscribe('update',render);void request('update.status').catch(error=>{state.textContent=error.message;});
  return {refresh:()=>request('update.status'),destroy:()=>{unsubscribe();root.replaceChildren();}};
}
