import './project-initialization.css';
import {renderTagMarkdown} from './tag-markdown.mjs';

// Presentation only. The host owns eligibility, run identity and map versions.
export function mountProjectInitialization({anchor,invoke,currentProject,subscribe}){
 const root=document.createElement('span');root.className='project-initialization';root.hidden=true;root.dataset.projectInitialization='';
 const status=document.createElement('span');status.setAttribute('role','status');
 const view=document.createElement('button'),retry=document.createElement('button'),cancel=document.createElement('button');
 for(const button of [view,retry,cancel])button.type='button';
 view.textContent='项目地图';retry.textContent='整理项目';cancel.textContent='取消';root.append(status,view,retry,cancel);anchor.after(root);
 let generation=0,value=null,pending=false;
 const labels={pending:'项目资料尚未整理',queued:'项目资料排队整理',running:'正在整理项目资料',completed:'项目资料已整理',failed:'项目资料未整理完成',interrupted:'项目资料整理已中断',cancelled:'项目资料整理已取消'};
 const call=async(op,payload)=>{const response=await invoke(op,payload);if(!response.ok)throw Error(response.error?.message||response.error?.code||'读取失败');return response.value;};
 async function refresh(){
  const projectId=currentProject(),seq=++generation;if(!projectId){root.hidden=true;return;}
  try{const next=await call('managed.initialization.status',{projectId});if(seq!==generation||projectId!==currentProject())return;value=next;root.hidden=false;status.textContent=labels[next.status]||'项目资料状态待核实';root.title=next.errorCode||'';view.hidden=!next.map;cancel.hidden=!['queued','running'].includes(next.status);retry.hidden=['queued','running','completed'].includes(next.status);retry.textContent=next.map?'继续整理':'整理项目';}
  catch(error){if(seq!==generation)return;root.hidden=false;status.textContent='项目资料状态待核实';root.title=error.message;view.hidden=retry.hidden=cancel.hidden=true;}
 }
 async function action(op){if(pending||!value)return;pending=true;for(const b of [view,retry,cancel])b.disabled=true;try{await call(op,{projectId:currentProject(),expectedProjectInstanceId:value.projectInstanceId});await refresh();}catch(error){status.textContent=error.message;}finally{pending=false;for(const b of [view,retry,cancel])b.disabled=false;}}
 retry.onclick=()=>void action('managed.initialization.retry');cancel.onclick=()=>void action('managed.initialization.cancel');
 view.onclick=async()=>{
  const projectId=currentProject();if(!projectId||!value?.map)return;
  const dialog=document.createElement('dialog'),heading=document.createElement('h2'),body=document.createElement('div'),close=document.createElement('button'),more=document.createElement('button');heading.textContent='项目地图';body.style.maxHeight='65vh';body.style.overflow='auto';close.type=more.type='button';close.textContent='关闭';more.textContent='继续读取';more.hidden=true;dialog.append(heading,body,more,close);document.body.append(dialog);close.onclick=()=>{dialog.close();dialog.remove();};dialog.oncancel=()=>dialog.remove();dialog.showModal();
  let offset=0,version=value.map.version,text='';
  const paint=()=>{const marker='\n## Host source spans and coverage',at=text.indexOf(marker);body.replaceChildren();const prose=document.createElement('div');renderTagMarkdown(prose,at<0?text:text.slice(0,at));body.append(prose);if(at>=0){const detail=document.createElement('details'),summary=document.createElement('summary'),source=document.createElement('pre');summary.textContent='来源与查看范围';source.textContent=text.slice(at+marker.length).trim();source.style.whiteSpace='pre-wrap';source.style.overflowWrap='anywhere';detail.append(summary,source);body.append(detail);}};
  const read=async()=>{more.disabled=true;try{const page=await call('managed.initialization.read',{projectId,version,offset});if(currentProject()!==projectId)throw Error('项目已切换');version=page.version;text+=page.text;paint();offset=page.nextOffset;more.hidden=offset==null;}catch(error){const notice=document.createElement('p');notice.textContent='未能继续读取：'+error.message;body.append(notice);more.hidden=true;}finally{more.disabled=false;}};more.onclick=()=>void read();await read();
 };
 const onProject=()=>void refresh();window.addEventListener('nozeli-project-change',onProject);
 const unsubscribe=subscribe('agent',event=>{if(event.projectId===currentProject()&&event.kind==='initialization-status')void refresh();});
 void refresh();return {refresh,dispose(){generation++;unsubscribe?.();window.removeEventListener('nozeli-project-change',onProject);root.remove();}};
}
