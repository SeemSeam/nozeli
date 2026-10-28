import {mountContextMenu} from './context-menu.mjs';
import { textChangeSet } from '../domain/tag-anchors.mjs';
import { menuNotice, panelMenuPosition } from './panel-menu.mjs';
export const canFormatDocument = path => /\.(?:[cm]?js|jsx|ts|tsx|json|css|html|htm|md|markdown)$/i.test(path || '');
export const canFormatSelection = path => /\.(?:[cm]?js|jsx|ts|tsx|json)$/i.test(path || '');

export function documentCommands(s) {
  const selected = Boolean(s.selected);
  const items = [];
  const add = (id, label, enabled = true, shortcut = '') => items.push({ id, label, enabled, shortcut });
  const separator = () => items.push({ separator: true });
  if (s.annotateMenu) {
    if (items.length) separator();
    const pointable = Boolean(s.pointTarget), selectable = Boolean(s.pointSelected);
    const where = pointable || selectable ? '' : '此处不是文档位置，无法定位批注';
    add('note-here', selectable ? '备注选区' : '在此备注', pointable || selectable, where);
    add('discuss-here', selectable ? '讨论选区' : '在此讨论', pointable || selectable, where);
    add('explain-selection', '解释选区', Boolean(s.canExplain), s.canExplain ? '' : selectable ? '解释暂不可用，前台尚未就绪' : '需先选中文字或区域');
  }
  if (s.editable) {
    add('undo', '撤销', true, 'Ctrl/Cmd+Z'); add('redo', '重做', true, 'Ctrl/Cmd+Shift+Z'); separator();
    add('cut', '剪切', selected, 'Ctrl/Cmd+X');
  }
  if (['text','pdf','word'].includes(s.kind)) add('copy', '复制', selected, 'Ctrl/Cmd+C');
  if (s.editable) add('paste', '粘贴', true, 'Ctrl/Cmd+V');
  if (s.kind === 'text') add('selectAll', '全选', true, 'Ctrl/Cmd+A');
  if (s.canFind !== false) {
    if(s.editable) items.push({id:'search',label:'查找与替换',children:[{id:'find',label:'查找',shortcut:'Ctrl/Cmd+F'},{id:'replace',label:'替换',shortcut:'Ctrl/Cmd+H'}]});
    else add('find', '查找', true, 'Ctrl/Cmd+F');
  }
  if (s.editable && s.code) {
    separator(); add('comment', '切换行注释', true, 'Ctrl/Cmd+/'); add('definition', '转到定义', true, 'Ctrl/Cmd+Alt+G');
  }
  if (s.code && s.canFold) {
    if (!s.editable) separator();
    add('foldAll', '全部折叠', true, 'Ctrl/Cmd+K Ctrl/Cmd+0');
    add('unfoldAll', '全部展开', true, 'Ctrl/Cmd+K Ctrl/Cmd+J');
  }
  if (s.editable && canFormatDocument(s.relPath)) {
    separator(); const children=[{id:'format',label:'格式化文档',shortcut:'Shift+Alt+F'}];
    if (canFormatSelection(s.relPath)) children.push({id:'formatSelection',label:'格式化选区',enabled:selected});
    items.push({id:'formatting',label:'格式化',children});
  }
  if (s.reading && !s.secondary && s.kind === 'text') { separator(); add('edit', '切换到编辑'); }
  if(s.link){separator();add('linkOpen',s.link.matches('.conversation-file-link')?'打开引用位置':'打开链接');add('linkCopy','复制链接地址');}
  if (s.kind === 'pdf') { separator(); add('pageReference', '复制当前页引用'); add('fit', '适应宽度'); add('fitPage', '适应整页'); add('actual', '原始比例 · 100%'); if(!s.secondary)add('page', '跳转到页面…'); }
  if(s.kind==='image'){separator();add('fit','适应窗口');add('actual','原始比例 · 100%');add('imageInfo','图片信息…');}
  if(s.kind==='unsupported'){items.length=0;add('openExternal','使用系统默认应用打开');add('reveal','在文件管理器中显示');add('relativePath','复制相对路径');}
  if(s.preview?.kind==='tex'||s.editable&&/\.(tex|sty|cls)$/i.test(s.relPath)){
    separator();add('texBuild','编译当前根文档');
    if(s.preview?.kind==='tex')items.push({id:'tex-auto',label:'自动编译',checked:s.preview.automatic});
  }
  if(s.canCompare||s.canAuthorship){
    separator(); const children=[];
    if(s.canCompare)children.push({id:'compareFile',label:'与其他文件对比…'},{id:'compareHistory',label:'与历史版本对比…'});
    if(s.canAuthorship)children.push({id:'authorship-history',label:'当前文件修改记录…'});
    items.push({id:'history',label:'对比与历史',children});
  }
  const views=[];
  if(s.preview){
    views.push({id:'preview-toggle',label:s.preview.kind==='markdown'?'实时预览':'编译预览',checked:s.preview.visible});
    views.push({id:'preview-link',label:'源码与预览联动',checked:s.preview.linked,enabled:s.preview.visible&&s.preview.available!==false,hint:s.preview.hint});
  }
  if(s.canAuthorship)views.push({id:'authorship-toggle',label:s.authorshipVisible?'隐藏修改者':'显示修改者',checked:s.authorshipVisible});
  if(s.adapter&&s.kind==='text')views.push({id:'wordWrap',label:s.wordWrap?'关闭自动换行':'自动换行',checked:Boolean(s.wordWrap)});
  if(s.fontSize)views.push({id:'document-font',label:`正文字号 · ${s.fontSize}px`,children:[
    {id:'document-font-larger',label:'放大字号',enabled:s.fontSize<24},{id:'document-font-smaller',label:'缩小字号',enabled:s.fontSize>11},
    {separator:true},...[12,14,16,18].map(n=>({id:'document-font-'+n,label:n+'px',checked:s.fontSize===n})),
    {id:'document-font-reset',label:'恢复默认 · 14px'},
  ]});
  if(s.readingWidth)views.push({id:'reading-width',label:'阅读行宽',children:[{id:'reading-width-72',label:'舒适行宽',checked:s.readingWidth===72},{id:'reading-width-100',label:'较宽正文',checked:s.readingWidth===100}]});
  if(s.canMode)views.push({id:'text-mode',label:s.reading?'切换到编辑':'切换到阅读',checked:!s.reading});
  if(s.kind==='pdf'&&s.panel)views.push({id:'page-prev',label:'上一页',enabled:s.page>1},{id:'page-next',label:'下一页',enabled:!s.pages||s.page<s.pages},{id:'zoom-out',label:'缩小页面'},{id:'zoom-in',label:'放大页面'},...(!s.secondary?[{id:'pdf-outline',label:'PDF 目录',checked:s.outline},{id:'region',label:'区域框选',checked:s.region}]:[]));
  if(s.kind==='image'&&s.panel)views.push({id:'zoom-out',label:'缩小图片'},{id:'zoom-in',label:'放大图片'},{id:'region',label:'区域框选',checked:s.region});
  if(s.kind==='word'&&s.panel)views.push({id:'fit',label:'适应窗口宽度',enabled:s.canZoom!==false},{id:'actual',label:'原始比例 · 100%',enabled:s.canZoom!==false},{id:'zoom-out',label:'缩小页面',enabled:s.canZoom!==false&&s.canZoomOut!==false},{id:'zoom-in',label:'放大页面',enabled:s.canZoom!==false&&s.canZoomIn!==false},{id:'region',label:'区域框选',checked:s.region,enabled:s.canRegion!==false});
  if(s.kind==='ppt'&&s.panel&&s.canRegion)views.push({id:'region',label:'区域框选',checked:s.region});
  if(views.length)items.push({id:'view',label:'视图',children:views});
  if(s.canChangeComparison)items.push({id:'comparison',label:'对照',children:[{id:'comparison-change',label:'更换对照文件或历史版本…'},...(s.canDiff||s.diffVisible?[{id:'comparison-diff',label:'显示 Diff 差异',checked:s.diffVisible}]:[])]});
  if(s.preview?.kind==='tex'&&s.canLog)items.push({id:'tex-log',label:'编译诊断与日志',checked:s.logVisible});
  if(s.texOptions)items.push({id:'tex-settings',label:'编译设置',children:[
    {id:'tex-roots',label:'根文档',children:s.texOptions.roots.map((value,i)=>({id:'tex-root-'+i,label:value,checked:value===s.texOptions.root}))},
    {id:'tex-engines',label:'编译引擎',children:s.texOptions.engines.map((value,i)=>({id:'tex-engine-'+i,label:value,checked:value===s.texOptions.engine}))},
    {id:'tex-cancel',label:'取消编译',enabled:s.texOptions.building},
  ]});
  if(s.projectId&&s.kind!=='unsupported'&&!s.generated)items.push({id:'file',label:'文件',children:[
    ...((s.canOpenBeside??(!s.secondary&&s.kind==='text'))?[{id:'openBeside',label:'在旁边打开文件…'}]:[]),
    {id:'openExternal',label:'使用系统默认应用打开'},{id:'reveal',label:'在文件管理器中显示'},{id:'relativePath',label:'复制相对路径'},
    ...(s.canExport?[{separator:true},{id:'exportPpt',label:'导出 PPTX 副本…'}]:[]),
    ...(s.canExportTextCopy?[{separator:true},{id:'exportTextCopy',label:s.exportTextCopyLabel}]:[]),
  ]});
  return items;
}

export function documentMoreCommands(surface) {
  const allowed = new Set(['find','search','definition','fit','fitPage','actual','page','imageInfo','texBuild','tex-auto','tex-log','tex-settings','history','view','file','comparison','openExternal','reveal','relativePath']);
  return [...documentCommands(surface).filter(item=>allowed.has(item.id)),menuNotice];
}

export function minimalTextEdit(before, after) {
  let from = 0, tail = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  while (tail < before.length - from && tail < after.length - from && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { from, to: before.length - tail, insert: after.slice(from, after.length - tail) };
}

export async function formatEditor({ adapter, projectId, relPath, current = () => true, status = () => {} }, selectionOnly = false) {
  const before = adapter.getText(), selection = adapter.getSelection();
  if (selectionOnly && selection.from === selection.to) return;
  const response = await window.nozeli.invoke('formatter.format', { projectId, relPath, text: before, ...(selectionOnly ? { range: { from: selection.from, to: selection.to } } : {}) });
  if (!current()) return;
  if (!response.ok) { status(`格式化失败：${response.error?.message || '格式化工具不可用'}`); return; }
  if (adapter.getText() !== before) { status('格式化期间内容已变化，保留当前编辑，请重试。'); return; }
  const now=adapter.getSelection();
  if(now.anchor!==selection.anchor||now.head!==selection.head){status('格式化期间选区已变化，请重试。');return;}
  if (response.value.text !== before) {
    const mapping = textChangeSet(before, response.value.text), edits = [];
    mapping.iterChanges((from, to, newFrom, newTo) => edits.push({ from, to, insert: response.value.text.slice(newFrom, newTo) }));
    adapter.applyEdits(edits);
    adapter.setSelection(mapping.mapPos(selection.anchor), mapping.mapPos(selection.head));
  }
  status(`Prettier ${response.value.version} · ${selectionOnly ? '选区' : '文档'}格式化完成`);
}

// One menu for all document surfaces; editing operations stay with the editor
// engines. Annotation actions belong only to the selection toolbar.
export function mountDocumentContextMenu({ root, surfaceAt, run, hideQuickActions = () => {}, status = () => {} }) {
  let external = null, suppressed = false;
  const shell = mountContextMenu({id:'document-context-menu',label:'文档操作',onOpen:()=>{suppressed=true;hideQuickActions();},onClose:()=>document.querySelectorAll('#secondary-more,#diff-primary-more,#document-content-tools-anchor').forEach(button=>button.setAttribute('aria-expanded','false')),onError:status});
  const close = (restore=false) => { shell.close(restore); const owner=external;external=null;owner?.close?.(); };
  const ignored = target => target.closest('.tag-window,.note-anchor,#note-form,.cm-panel,.find-widget,.suggest-widget') || (target.closest('input,textarea,button,a,[contenteditable="true"]') && !target.closest('.monaco-editor,.cm-content') && !target.closest('#text-preview a[href],#text-preview .conversation-file-link'));
  const prepare = (event, keyboard = false) => {
    const surface = surfaceAt(event.target);
    if (!surface || ignored(event.target)) return null;
    if (!keyboard) surface.pointer = { x: event.clientX, y: event.clientY }; else surface.pointer = null;
    if (!keyboard && surface.adapter) {
      const pos = surface.adapter.offsetAtPoint?.(event.clientX, event.clientY), s = surface.adapter.getSelection();
      if (Number.isInteger(pos) && (pos < s.from || pos > s.to || s.from === s.to)) surface.adapter.setSelection(pos);
    } else if (!keyboard && surface.reading) {
      // Selection hit-test happens before any mutation: a pointer inside the
      // kept selection keeps it; anything else becomes a fresh document point.
      const selection = window.getSelection();
      const inside = selection?.rangeCount && selection.anchorNode && selection.focusNode && !selection.isCollapsed && root.contains(selection.anchorNode) && root.contains(selection.focusNode) && Array.from(selection.getRangeAt(0).getClientRects()).some(r => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom);
      const region = surface.selectionRect;
      const inRegion = region && event.clientX >= region.left && event.clientX <= region.right && event.clientY >= region.top && event.clientY <= region.bottom;
      if (!inside && !inRegion) surface.clearSelection?.();
    }
    return surface;
  };
  const openSurface = (surface, {left,bottom}, focus=document.activeElement) => {
    close(); const active=surface.snapshot();
    // The document point freezes at menu-open: coordinates and source identity
    // are captured here once, never recomputed from a later pointer position.
    if (surface.pointer && typeof surface.pointAt === 'function') {
      try { active.pointTarget = surface.pointAt(surface.pointer.x, surface.pointer.y, active) || null; }
      catch { active.pointTarget = null; }
    }
    shell.open(documentCommands(active),{x:left,y:bottom,focus,run:command=>{if(active.current())return run(command,active);}});
  };
  const open = (event, keyboard = false) => {
    const surface = prepare(event, keyboard); if (!surface) return;
    event.preventDefault(); event.stopPropagation();
    openSurface(surface, keyboard ? surface.adapter?.coordsAtOffset(surface.adapter.getSelection().head) || root.getBoundingClientRect() : {left:event.clientX,bottom:event.clientY});
  };
  const onDown = event => {
    if (event.button !== 2) return;
    const s = prepare(event); if (!s) return;
    // Prevent engine/native handlers from destroying the retained selection.
    event.preventDefault(); event.stopPropagation();
  };
  const onKey = event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event, true);
  };
  const onOutside = event => { if(external&&!root.contains(event.target))close(); };
  const onOtherMenu = event => { if(event.detail!=='document-context-menu'&&event.detail!==external?.id){const owner=external;external=null;owner?.close?.();suppressed=true;hideQuickActions();} };
  const onScroll = () => close();
  window.addEventListener('nozeli-context-menu-open',onOtherMenu);
  root.addEventListener('mousedown',onDown,true); root.addEventListener('contextmenu',open,true); document.addEventListener('keydown',onKey,true);
  document.addEventListener('pointerdown',onOutside,true);
  for(const event of ['resize','nozeli-project-change','project-view-change'])window.addEventListener(event,onScroll);
  root.addEventListener('scroll',onScroll,true);
  return { close, openSurface,
    async execute(command,target){
      try{
        const surface=target&&surfaceAt(target);
        if(!surface)throw Error('当前文档没有可用的内容工具。');
        const active=surface.snapshot();
        const enabled=items=>items.some(item=>item.enabled!==false&&!item.separator&&(item.children?enabled(item.children):item.id===command));
        if(typeof command!=='string'||!enabled(documentMoreCommands(active)))throw Error('当前文档不支持此操作，或操作暂不可用。');
        if(!active.current())throw Error('文档已切换，未执行内容操作。');
        const result=await run(command,active);
        if(result?.ok===false)throw Error(result.error?.message||'内容操作未完成。');
        return result??{ok:true};
      }catch(error){
        const message=error?.message||String(error);status(message);
        return {ok:false,error:{message}};
      }
    },
    openMore(target,trigger){const surface=surfaceAt(target);if(!surface)return;close();const active=surface.snapshot();shell.open(documentMoreCommands(active),{...panelMenuPosition(trigger),run:command=>{if(active.current())return run(command,active);}});trigger.setAttribute('aria-expanded','true');},
    isOpen:()=>shell.isOpen()||Boolean(external), isSuppressed:()=>suppressed,
    resumeSelection(){close();suppressed=false;},
    externalOpen(id,closer){if(external?.id!==id)close();shell.close();external={id,close:closer};suppressed=true;hideQuickActions();window.dispatchEvent(new CustomEvent('nozeli-context-menu-open',{detail:id}));},
    externalClosed(id){if(external?.id===id)external=null;},
    destroy(){close();shell.destroy();root.removeEventListener('mousedown',onDown,true);root.removeEventListener('contextmenu',open,true);document.removeEventListener('keydown',onKey,true);document.removeEventListener('pointerdown',onOutside,true);window.removeEventListener('nozeli-context-menu-open',onOtherMenu);for(const event of ['resize','nozeli-project-change','project-view-change'])window.removeEventListener(event,onScroll);root.removeEventListener('scroll',onScroll,true);}
  };
}

export function findInReadingSurface(element, status = () => {}) {
  let dialog = document.getElementById('document-reading-search');
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.id = 'document-reading-search';
    dialog.innerHTML = '<form><label>在当前阅读文档中查找 <input name="query" aria-label="阅读文档查找" required></label><button type="submit">下一处</button><button type="button">关闭</button><p role="status"></p></form>';
    document.body.append(dialog); dialog.querySelector('button[type="button"]').onclick = () => dialog.close();
  }
  let offset = 0, last = '';
  dialog.querySelector('form').onsubmit = event => {
    event.preventDefault(); const query = dialog.querySelector('input').value;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement.closest('.tag-window,.note-anchor,script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const nodes = []; let text = '', node;
    while ((node = walker.nextNode())) { nodes.push({ node, start: text.length }); text += node.textContent; }
    if (last !== query) offset = 0; last = query;
    const haystack = text.toLowerCase(), needle = query.toLowerCase();
    let index = haystack.indexOf(needle, offset); if (index < 0) index = haystack.indexOf(needle);
    if (index < 0) { dialog.querySelector('p').textContent = '未找到'; return; }
    const start = [...nodes].reverse().find(item => item.start <= index), end = [...nodes].reverse().find(item => item.start < index + query.length);
    if (!start || !end) return;
    const range = document.createRange(); range.setStart(start.node, index - start.start); range.setEnd(end.node, index + query.length - end.start);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); start.node.parentElement.scrollIntoView({ block: 'center' });
    offset = index + query.length; dialog.querySelector('p').textContent = '已定位匹配内容'; status('已定位匹配内容');
  };
  dialog.showModal(); dialog.querySelector('input').focus();
}
