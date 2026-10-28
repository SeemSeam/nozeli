import {treeMenuItems} from '../main/file-tree-menu.mjs';
import {mountContextMenu} from './context-menu.mjs';
import {panelButton,panelMenuPosition,menuNotice} from './panel-menu.mjs';
export function mountFileTreeActions({ invoke, projectId, perform, open, openAt, targets=()=>[], quickOpen, selection=()=>[], openExternal, label, collapse, refresh, toast, visibility, changeVisibility }) {
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
  const confirmBatch = (label,paths,destination='') => new Promise(resolve=>{
    title.textContent=label;description.textContent=`${paths.join('、')} → ${destination||'当前项目'}。不会覆盖同名文件；逐项执行，发生错误立即停止，已完成项不会回滚。`;input.hidden=true;input.disabled=true;accept.textContent='确认执行';
    const finish=value=>{form.onsubmit=null;cancel.onclick=null;dialog.oncancel=null;dialog.close();resolve(value);};form.onsubmit=e=>{e.preventDefault();finish(true);};cancel.onclick=()=>finish(false);dialog.oncancel=e=>{e.preventDefault();finish(false);};dialog.showModal();cancel.focus();
  });
  const sources=ctx=>{const chosen=selection(),paths=chosen.includes(ctx.relPath)?chosen:[ctx.relPath];return paths.filter(p=>p&&!paths.some(parent=>parent!==p&&p.startsWith(parent+'/')));};
  const parent = rel => rel.split('/').slice(0,-1).join('/');
  const target = node => ({ projectId:projectId(), relPath:node?.dataset.path || '', directory:!node || node.classList.contains('dir'), hidden:node?.dataset.hiddenRoot==='true' });
  const paint = () => {more.disabled=!projectId();for(const node of tree.querySelectorAll('button')) node.classList.toggle('tree-cut',buffer?.projectId===projectId()&&buffer?.action==='cut'&&(node.dataset.path===buffer.source||node.dataset.path.startsWith(buffer.source+'/')));};
  async function execute(action, ctx) {
    if(!action || busy || ctx.projectId!==projectId()) return;
    const source=ctx.relPath, destination=ctx.directory?source:parent(source);
    if(action==='copy'||action==='cut'){if(source)buffer={projectId:ctx.projectId,source,sources:sources(ctx),action};paint();return;}
    busy=true;
    try {
      if(action==='open'){if(ctx.directory) tree.querySelector(`[data-path="${CSS.escape(source)}"]`)?.click();else await open(source);return;}
      if(action==='quickOpen'){quickOpen();return;}
      if(['right','bottom','window'].includes(action)||action.startsWith('group:')){if(!ctx.directory)await openAt(source,action);return;}
      if(action==='openExternal'){const r=await openExternal(ctx);if(!r.ok)throw Error(r.error.message);return;}
      if(action==='refresh'){await refresh();paint();return;}
      if(['hide','unhide','toggleHidden'].includes(action)){const paths=action==='toggleHidden'?[]:sources(ctx);if(paths.length>1&&!await confirmBatch(action==='hide'?'批量隐藏':'批量恢复',paths))return;await changeVisibility(action,{...ctx,paths});paint();return;}
      if(action==='collapse'){await collapse(source);return;}
      if(action==='label'){await label(ctx);return;}
      if(['relativePath','absolutePath','reveal'].includes(action)){const r=await invoke('tree.path',{...ctx,action});if(!r.ok)throw Error(r.error.message);return;}
      let request={projectId:ctx.projectId,action,source};
      if(action==='paste'){
        if(!buffer)return;
        const clip=buffer,paths=[...(clip.sources||[clip.source])],cross=clip.projectId!==ctx.projectId;
        if(!await confirmBatch((cross?'跨项目':'')+(clip.action==='cut'?'移动':'复制')+'文件',paths,destination||'项目根目录'))return;
        const remaining=[...paths];
        for(const path of paths){
          if(ctx.projectId!==projectId())throw Error('项目已切换');
          const r=await perform({projectId:ctx.projectId,...(cross?{sourceProjectId:clip.projectId}:{}),action:clip.action,source:path,target:destination});
          if(!r.ok)throw Error(r.error.message);
          remaining.shift();
          if(clip.action==='cut'&&buffer===clip&&remaining.length)clip.sources=[...remaining];
        }
        if(clip.action==='cut'&&buffer===clip)buffer=null;
        paint();toast('操作完成');return;
      }
      else if(action==='rename'||action==='createFile'||action==='createFolder'){
        const name=await ask(action==='rename'?'重命名':action==='createFile'?'新建文件':'新建文件夹',action==='rename'?source.split('/').at(-1):'');
        if(name===null)return;request={...request,name,target:destination};
      } else if(action==='trash'){if(!source||!await ask('移至回收站？',source,true))return;}
      if(ctx.projectId!==projectId())throw Error('项目已切换，请重新选择操作。');
      const result=await perform(request);
      if(!result.ok)throw Error(result.error.message);
      paint();toast('操作完成');
    }catch(e){toast(e.message||'文件操作失败');}finally{busy=false;}
  }
  const menuItems=ctx=>[...(!ctx.directory?[{label:'在右侧打开',id:'right'},{label:'在下方打开',id:'bottom'},{label:'在新窗口打开',id:'window'},...targets().map(group=>({label:'在指定组打开 · '+group.label,id:'group:'+group.id}))]:[]),{label:'快速打开',id:'quickOpen'},...treeMenuItems({directory:ctx.directory,root:!ctx.relPath,canPaste:!!buffer,visibility:true,hidden:ctx.hidden,showHidden:visibility().showHidden})];
  function menu(node,event){const ctx=target(node);if(!ctx.projectId)return;node?.focus({preventScroll:true});const b=node?.getBoundingClientRect()||tree.getBoundingClientRect();popup.open(menuItems(ctx),{x:event?.clientX??b.left+20,y:event?.clientY??b.bottom,run:action=>execute(action,ctx)});}
  more.addEventListener('click',()=>{const ctx=target();if(!ctx.projectId)return;popup.open([...menuItems(ctx),menuNotice],{...panelMenuPosition(more),run:action=>execute(action,ctx)});more.setAttribute('aria-expanded','true');});
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
  tree.addEventListener('dragstart',event=>{const node=event.target.closest('button[data-path]');if(!node)return;const ctx=target(node);event.dataTransfer.setData('application/x-nozeli-files',JSON.stringify({projectId:ctx.projectId,paths:sources(ctx)}));event.dataTransfer.effectAllowed='copyMove';});
  tree.addEventListener('dragover',event=>{event.preventDefault();for(const b of tree.querySelectorAll('.tree-drop-target'))b.classList.remove('tree-drop-target');event.target.closest('button.dir')?.classList.add('tree-drop-target');if(event.dataTransfer)event.dataTransfer.dropEffect=event.ctrlKey||event.metaKey?'copy':'move';});
  tree.addEventListener('dragleave',event=>event.target.closest('.tree-drop-target')?.classList.remove('tree-drop-target'));
  tree.addEventListener('drop',event=>{event.preventDefault();for(const b of tree.querySelectorAll('.tree-drop-target'))b.classList.remove('tree-drop-target');try{const raw=event.dataTransfer.getData('application/x-nozeli-files');if(!raw)throw Error('不接受外部文件拖入；请先通过项目文件夹管理文件。');const data=JSON.parse(raw);if(data.projectId!==projectId())throw Error('不能跨项目拖动文件。');if(!Array.isArray(data.paths)||!data.paths.length||data.paths.some(p=>typeof p!=='string'||!p||p.startsWith('/')||p.split('/').includes('..')))throw Error('无效拖动路径');const ctx=target(event.target.closest('button[data-path]'));buffer={projectId:data.projectId,source:data.paths[0],sources:data.paths,action:event.ctrlKey||event.metaKey?'copy':'cut'};void execute('paste',ctx);}catch(error){toast(error.message);}});
  paint();return {paint};
}
