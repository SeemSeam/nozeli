import {setIconButton} from './ui-icons.mjs';
import {createFileIcon} from './file-icons.mjs';
import {mountContextMenu} from './context-menu.mjs';
// Presentation only: all mutations go through the app's serialized save/close path.
export function mountOpenFiles({state,open,close,reorder,batch,persist,projectId=()=>null,manage=()=>{},toast=()=>{}}){
 const list=document.createElement('details');list.id='open-files';list.open=true;
 const summary=document.createElement('summary');summary.textContent='已打开';const entries=document.createElement('div');entries.className='open-file-entries';list.append(summary,entries);document.querySelector('#file-filter').after(list);
 const popup=mountContextMenu({id:'file-tab-menu',label:'已打开文件',onError:toast});
 let dragging=null,signature='';
 list.addEventListener('toggle',()=>{if(state().collapsed!==!list.open){state().collapsed=!list.open;persist();}});
 function showMenu(event,path){event.preventDefault();const identity=projectId(),b=event.target.getBoundingClientRect();popup.open([
  ...[['关闭','one'],['关闭其他','others'],['关闭下方','right'],['关闭全部','all']].map(([label,id])=>({label,id,enabled:id!=='others'||state().paths.length>1})),{separator:true},
  {id:'locate',label:'在文件树中定位'},{id:'openExternal',label:'使用系统默认应用打开'},{id:'relativePath',label:'复制相对路径'},{id:'absolutePath',label:'复制完整路径'}
 ],{x:event.clientX??b.left,y:event.clientY??b.bottom,run:action=>{if(identity!==projectId()||!state().paths.includes(path))return;if(action==='one')return close(path);if(['others','right','all'].includes(action))return batch(action,path);return manage(action,path);}});}
 function render(){const s=state();const key=JSON.stringify([s.paths,s.active,s.dirty,s.collapsed,s.paths.map(p=>s.availability?.get(p)?.status)]);if(key===signature)return;signature=key;entries.replaceChildren();list.hidden=s.paths.length===0;list.open=!s.collapsed;summary.textContent=`已打开 · ${s.paths.length}`;
 for(const path of s.paths){const name=path.split('/').pop(),duplicate=s.paths.some(p=>p!==path&&p.split('/').pop()===name);const label=duplicate?path:name;
 {const parent=entries;const row=document.createElement('div');row.className='open-file-item';row.dataset.path=path;row.dataset.active=String(path===s.active);row.draggable=true;
 const status=s.availability?.get(path)?.status;row.dataset.availability=status||'unknown';
 const button=document.createElement('button');button.className='open-file-select';const nameLabel=document.createElement('span');nameLabel.className='open-file-name';nameLabel.textContent=label+(path===s.active&&s.dirty?' ●':'');button.append(createFileIcon(path),nameLabel);button.title=path;button.setAttribute('aria-current',String(path===s.active));button.onclick=()=>open(path);
 if(status==='missing'||status==='unavailable'){const note=document.createElement('small');note.className='open-file-availability';note.textContent=status==='missing'?'原路径不存在':'暂不可用';button.append(note);button.title+=' · '+note.textContent;}
 const x=document.createElement('button');x.className='open-file-close';setIconButton(x,'close');x.title='关闭文件';x.setAttribute('aria-label','关闭 '+path);x.onclick=()=>close(path);row.append(button,x);row.onauxclick=e=>{if(e.button===1){e.preventDefault();close(path);}};row.oncontextmenu=e=>showMenu(e,path);row.onkeydown=e=>{if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.stopPropagation();showMenu(e,path);}};row.ondragstart=e=>{dragging=path;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',path);};row.ondragover=e=>{if(dragging)e.preventDefault();};row.ondrop=e=>{e.preventDefault();if(dragging&&dragging!==path)reorder(dragging,path);dragging=null;};row.ondragend=()=>dragging=null;parent.append(row);}
 }if(list.open)entries.querySelector('[data-active=true]')?.scrollIntoView({block:'nearest'});
 }
 return {render};
}
