import {treeMenuItems} from '../main/file-tree-menu.mjs';
import {mountContextMenu} from './context-menu.mjs';
import {panelButton,panelMenuPosition,menuNotice} from './panel-menu.mjs';
export function mountFileTreeActions({ invoke, projectId, perform, open, openExternal, label, collapse, refresh, toast }) {
  const tree = document.getElementById('file-tree');
  tree.tabIndex = 0;
  let buffer = null, busy = false;
  const more=panelButton('file-tree-more','项目文件更多操作，也可在文件树右键');
  const filter=document.getElementById('file-filter');
  const row=document.createElement('div');row.className='file-navigation';filter.before(row);row.append(filter,more);
  const popup=mountContextMenu({id:'file-tree-menu',label:'文件操作',onError:toast,onClose:()=>more.setAttribute('aria-expanded','false')});
  const dialog = document.createElement('dialog'); dialog.id = 'file-tree-dialog';
  const form = document.createElement('form');
  const title = document.createElement('h2'); title.id = 'file-tree-dialog-title'; dialog.setAttribute('aria-labelledby',title.id);
  const description = document.createElement('p');
  const input = document.createElement('input'); input.id='file-tree-name';input.required=true; input.setAttribute('aria-label','名称');
  const buttons = document.createElement('div');
  const cancel = document.createElement('button'); cancel.type='button';cancel.textContent='取消';
  const accept = document.createElement('button'); accept.type='submit';accept.textContent='确定';
  buttons.append(cancel,accept);form.append(title,description,input,buttons);dialog.append(form);document.body.append(dialog);
  const ask = (label, value, deletion=false) => new Promise(resolve=>{
    title.textContent=label;description.textContent=deletion ? `将“${value}”移至系统回收站。文件夹包含的所有文件也会移入；标签恢复资料会保留。` : '同名文件不会被覆盖。';
    input.hidden=deletion;input.disabled=deletion;input.value=value;accept.textContent=deletion?'移至回收站':'确定';
    const finish=value=>{form.onsubmit=null;cancel.onclick=null;dialog.oncancel=null;dialog.close();resolve(value);};
    form.onsubmit=e=>{e.preventDefault();finish(deletion?true:input.value);};cancel.onclick=()=>finish(null);dialog.oncancel=e=>{e.preventDefault();finish(null);};
    dialog.showModal();if(deletion) cancel.focus();else {input.focus();input.select();}
  });
  const parent = rel => rel.split('/').slice(0,-1).join('/');
  const target = node => ({ projectId:projectId(), relPath:node?.dataset.path || '', directory:!node || node.classList.contains('dir') });
  const paint = () => {more.disabled=!projectId();for(const node of tree.querySelectorAll('button')) node.classList.toggle('tree-cut',buffer?.projectId===projectId()&&buffer?.action==='cut'&&(node.dataset.path===buffer.source||node.dataset.path.startsWith(buffer.source+'/')));};
  async function execute(action, ctx) {
    if(!action || busy || ctx.projectId!==projectId()) return;
    if(buffer?.projectId!==ctx.projectId) buffer=null;
    const source=ctx.relPath, destination=ctx.directory?source:parent(source);
    if(action==='copy'||action==='cut'){if(source)buffer={projectId:ctx.projectId,source,action};paint();return;}
    busy=true;
    try {
      if(action==='open'){if(ctx.directory) tree.querySelector(`[data-path="${CSS.escape(source)}"]`)?.click();else await open(source);return;}
      if(action==='openExternal'){const r=await openExternal(ctx);if(!r.ok)throw Error(r.error.message);return;}
      if(action==='refresh'){await refresh();paint();return;}
      if(action==='collapse'){await collapse(source);return;}
      if(action==='label'){await label(ctx);return;}
      if(['relativePath','absolutePath','reveal'].includes(action)){const r=await invoke('tree.path',{...ctx,action});if(!r.ok)throw Error(r.error.message);return;}
      let request={projectId:ctx.projectId,action,source};
      if(action==='paste'){if(!buffer)return;request={...buffer,target:destination};}
      else if(action==='rename'||action==='createFile'||action==='createFolder'){
        const name=await ask(action==='rename'?'重命名':action==='createFile'?'新建文件':'新建文件夹',action==='rename'?source.split('/').at(-1):'');
        if(name===null)return;request={...request,name,target:destination};
      } else if(action==='trash'){if(!source||!await ask('移至回收站？',source,true))return;}
      if(ctx.projectId!==projectId())throw Error('项目已切换，请重新选择操作。');
      const result=await perform(request);
      if(!result.ok)throw Error(result.error.message);
      if(action==='paste'&&buffer?.action==='cut')buffer=null;
      paint();toast('操作完成');
    }catch(e){toast(e.message||'文件操作失败');}finally{busy=false;}
  }
  function menu(node,event){const ctx=target(node);if(!ctx.projectId)return;node?.focus({preventScroll:true});const b=node?.getBoundingClientRect()||tree.getBoundingClientRect();popup.open(treeMenuItems({directory:ctx.directory,root:!ctx.relPath,canPaste:buffer?.projectId===ctx.projectId}),{x:event?.clientX??b.left+20,y:event?.clientY??b.bottom,run:action=>execute(action,ctx)});}
  more.addEventListener('click',()=>{const ctx=target();if(!ctx.projectId)return;popup.open([...treeMenuItems({directory:true,root:true,canPaste:buffer?.projectId===ctx.projectId}),menuNotice],{...panelMenuPosition(more),run:action=>execute(action,ctx)});more.setAttribute('aria-expanded','true');});
  tree.addEventListener('contextmenu',e=>{e.preventDefault();menu(e.target.closest('button[data-path]'),e);});
  tree.addEventListener('keydown',e=>{
    if(e.target.closest('input'))return;
    if(e.key==='Escape' && buffer?.action==='cut'){buffer=null;paint();return;}
    const node=e.target.closest('button[data-path]');let action;
    if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();e.stopPropagation();menu(node);return;}
    if(e.ctrlKey||e.metaKey)action=({c:'copy',x:'cut',v:'paste'})[e.key.toLowerCase()];
    else action=({F2:'rename',Delete:'trash',F5:'refresh'})[e.key];
    if(action){e.preventDefault();void execute(action,target(node));}
  });
  paint();return {paint};
}
