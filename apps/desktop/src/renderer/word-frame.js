import {wordTextIndex,wordTransactionEdits} from '../domain/word-text.mjs';
import {menuShortcut} from './context-menu.mjs';
let editor,channel,ready=false,readOnly=false;
window.nozeliWordModels={
 snapshotModel(){if(!ready)throw Error('Word 文档尚未就绪');return editor.activeEditor.state.doc.toJSON();},
 getText(){if(!ready)throw Error('Word 文档尚未就绪');return wordTextIndex(editor.activeEditor.state.doc).text;},
 applyModel(model){
  if(!ready||!readOnly)throw Error('只有就绪的阅读副本可接收正文');
  const active=editor.activeEditor,selection=active.state.selection;
  const scroll=[...document.querySelectorAll('*')].filter(node=>node.scrollTop||node.scrollLeft).map(node=>({node,top:node.scrollTop,left:node.scrollLeft}));
  const next=active.schema.nodeFromJSON(model);
  next.check();
  active.view.dispatch(active.state.tr.replaceWith(0,active.state.doc.content.size,next.content).setMeta('addToHistory',false).setMeta('nozeliMirror',true));
  const end=Math.max(0,active.state.doc.content.size);
  active.commands.setTextSelection({from:Math.min(selection.from,end),to:Math.min(selection.to,end)});
  lastWordDoc=active.state.doc;wordRegionDirty=true;queueAnchorLayout();
  requestAnimationFrame(()=>{for(const {node,top,left} of scroll){node.scrollTop=top;node.scrollLeft=left;}});
 }
};
const send=(type,extra={})=>parent.postMessage({nozeliWord:channel,type,...extra},location.origin);
addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(ready)send('save');}},true);
addEventListener('message',async event=>{
 if(event.source!==parent||event.origin!==location.origin||!event.data?.nozeliWord)return;
 const data=event.data;
 if(data.type==='open'&&!channel){
  channel=data.nozeliWord;
  readOnly=data.readOnly===true;
  try{
   editor=new SuperDoc({selector:'#document',toolbar:readOnly?false:'#toolbar',role:readOnly?'viewer':'editor',disableContextMenu:false,modules:{contextMenu:{menuProvider:wordMenuProvider}},document:new File([data.bytes],data.name,{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),documentMode:readOnly?'viewing':'editing',zoom:{mode:'manual',initial:100,fitWidth:{min:25,max:200}},telemetry:{enabled:false},onReady(){ready=true;lastWordDoc=editor.activeEditor.state.doc;send('ready',{text:wordTextIndex(lastWordDoc).text});editor.on('contextMenu:open',()=>{selectionDismissed=true;clearTimeout(window.wordSelectionTimer);send('context-menu');});editor.on('contextMenu:close',()=>send('context-close'));editor.on('zoomChange',()=>requestAnimationFrame(reportWordZoom));requestAnimationFrame(reportWordZoom);queueAnchorLayout();},onTransaction:reportWordTransaction,onEditorUpdate(){if(ready){wordRegionDirty=true;queueAnchorLayout();}},onException(error){send('error',{message:error?.error?.message||'Word 编辑器发生错误'});}});
   // Development diagnostics use the actual editor, never synthetic document state.
   window.nozeliWordEditor=editor;
  }catch(error){send('error',{message:error.message});}
 }else if(data.nozeliWord===channel&&data.type==='context-close'){
  closeWordContextMenu();
 }else if(data.nozeliWord===channel&&data.type==='clipboard-result'){
  const request=wordClipboardRequests.get(data.requestId);if(request){wordClipboardRequests.delete(data.requestId);data.error?request.reject(Error(data.error)):request.resolve(data.value);}
 }else if(data.nozeliWord===channel&&data.type==='zoom'){
  if(ready){
   closeWordContextMenu();setWordRegion(false);selectionDismissed=true;send('selection',{anchor:null});
   const value=data.value;
   if(value==='fit')editor.setZoomMode('fit-width');
   else if(['in','out','reset'].includes(value))editor.setZoom(value==='reset'?100:Math.max(25,Math.min(200,Math.round(editor.getZoom()*(value==='in'?1.2:1/1.2)))));
   requestAnimationFrame(reportWordZoom);
  }
 }else if(data.nozeliWord===channel&&data.type==='region'){
  if(ready){setWordRegion(Boolean(data.enabled));send('selection',{anchor:null});}
 }else if(data.nozeliWord===channel&&data.type==='anchors'){
  floatingAnchors=data.anchors;wordRegionDirty=false;queueAnchorLayout();
 }else if(data.nozeliWord===channel&&data.type==='authorship-state'){
  authorshipEnabled=data.enabled;queueAnchorLayout();
 }else if(data.nozeliWord===channel&&data.type==='locate'){
  try{
   const e=editor.activeEditor,found=resolveFloatingAnchor(data.anchor);
   if(!found)throw Error('引文位置有变化或歧义，原备注已保留。');e.commands.setTextSelection(found);e.view.dispatch(e.state.tr.scrollIntoView());e.view.focus();
  }catch(error){send('error',{message:error.message});}
 }else if(data.nozeliWord===channel&&data.type==='export'){
  try{if(!ready)throw Error('Word 文档尚未就绪');const blob=await editor.export({exportType:'docx',triggerDownload:false});send('exported',{requestId:data.requestId,bytes:new Uint8Array(await blob.arrayBuffer())});}
  catch(error){send('error',{requestId:data.requestId,message:error.message});}
 }
});

let selection, selectionDismissed=false,lastWordDoc=null;
const wordClipboardRequests=new Map();
function closeWordContextMenu(){
 const e=editor?.activeEditor,key=e?.state.plugins.find(p=>p.key.startsWith('contextMenu$'))?.key;
 if(key)e.view.dispatch(e.state.tr.setMeta(key,{type:'close'}));
}
function readWordClipboard(action='readRich',text){
 return new Promise((resolve,reject)=>{
  const requestId=crypto.randomUUID(),timer=setTimeout(()=>{wordClipboardRequests.delete(requestId);reject(Error('剪贴板读取超时'));},10000);
  wordClipboardRequests.set(requestId,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
  send('clipboard',{requestId,action,text});
 });
}
function wordMenuProvider(context,groups){
 if(readOnly)return groups.map(group=>({...group,items:group.items.filter(item=>['copy','selectAll'].includes(item.id))})).filter(group=>group.items.length);
 const labels={'insert-link':'链接…','insert-table':'插入表格…','edit-table':'表格操作…','cell-background':'单元格底色…','update-table-of-contents':'更新目录','cut':'剪切','copy':'复制','paste':'粘贴','track-changes-accept':'接受原有修订','track-changes-reject':'拒绝原有修订','list-restart-numbering':'重新编号','list-continue-numbering':'继续编号','list-decrease-indent':'减少缩进','list-increase-indent':'增加缩进'};
 const renderItem=(id,label)=>()=>{const row=document.createElement('div');row.className='context-menu-default-content';row.dataset.command=id;const text=document.createElement('span');text.textContent=label;row.append(text);const shortcut={undo:'Ctrl/Cmd+Z',redo:'Ctrl/Cmd+Shift+Z',cut:'Ctrl/Cmd+X',copy:'Ctrl/Cmd+C',paste:'Ctrl/Cmd+V',selectAll:'Ctrl/Cmd+A'}[id];if(shortcut){const key=document.createElement('kbd');key.textContent=menuShortcut(shortcut);row.append(key);}return row;};
 const native=groups.filter(g=>g.id!=='ai-content'&&g.id!=='proofing').map(g=>({...g,items:g.items.map(item=>({...item,label:labels[item.id]||item.label,render:renderItem(item.id,labels[item.id]||item.label),...(item.id==='paste'?{action:async e=>{
  const view=e.view,doc=view.state.doc,{from,to}=view.state.selection;
  try{
   const data=await readWordClipboard();
   if(!ready||doc!==view.state.doc||view.state.selection.from!==from||view.state.selection.to!==to){send('error',{message:'Word 内容或选区已变化，未粘贴旧位置。'});return;}
   view.focus();
   const transfer=new DataTransfer();transfer.setData('text/plain',data.text||'');if(data.html)transfer.setData('text/html',data.html);
   const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});
   if(data.html)view.pasteHTML(data.html,event);else if(data.text)view.pasteText(data.text,event);
  }catch(error){send('error',{message:error.message});}
 }}:{})}))}));
 const item=(id,label,action)=>({id,label,action:async(...args)=>{try{return await action(...args);}catch(error){send('error',{message:error.message});}},showWhen:()=>true,render:renderItem(id,label)});
 const e=context.editor?.state?context.editor:editor?.activeEditor,pos=context.pos??e?.state.selection.from;
 const link=e?.state.doc.nodeAt(pos)?.marks.find(mark=>mark.type.name==='link')||e?.state.selection.$from.marks().find(mark=>mark.type.name==='link');
 if(link?.attrs.href){
  const href=link.attrs.href;
  for(const group of native)for(const command of group.items)if(command.id==='insert-link'){command.label='编辑链接…';command.render=renderItem(command.id,command.label);}
  native.push({id:'nozeli-link',items:[...( /^https?:/i.test(href)?[item('link-open','打开链接',()=>send('external-link',{url:href}))]:[]),item('link-copy','复制链接地址',()=>readWordClipboard('write',href)),item('link-remove','移除链接',target=>target.commands.unsetLink())]});
 }
 return [{id:'nozeli-edit',items:[item('undo','撤销',e=>e.commands.undo()),item('redo','重做',e=>e.commands.redo()),item('selectAll','全选',e=>{const from=1,to=Math.max(from,e.state.doc.content.size-1);e.commands.setTextSelection({from,to});})]},...native,
  {id:'nozeli-history',items:[item('authorship-toggle',authorshipEnabled?'隐藏修改者':'显示修改者',()=>send('context-command',{command:'authorship-toggle'})),item('authorship-history','当前文件修改记录…',()=>send('context-command',{command:'authorship-history'}))]}];
}
function reportWordTransaction(event){
 if(!ready||!event.transaction?.docChanged)return;
 // SuperDoc emits its transaction before replacing activeEditor.state. Read
 // the actual resulting transaction document, not that previous state.
 const main=event.surface==='body';
 const doc=main?event.transaction.doc:editor.activeEditor.state.doc;
 send('changed',{text:wordTextIndex(doc).text,batches:main?wordTransactionEdits(event.transaction):null});
 lastWordDoc=doc;wordRegionDirty=true;queueAnchorLayout();
}

// SuperDoc owns the menu, its native target parsing and all rich-text transactions.
addEventListener('contextmenu',event=>{if(ready&&!event.target.closest('#toolbar')){selectionDismissed=true;clearTimeout(window.wordSelectionTimer);}},true);
addEventListener('keydown',event=>{
 const menu=document.querySelector('.context-menu');
 if(menu&&['ArrowUp','ArrowDown','Home','End','Enter','Escape','Tab'].includes(event.key)){
  event.preventDefault();event.stopImmediatePropagation();
  const rows=[...menu.querySelectorAll('.context-menu-item')],current=document.activeElement.closest?.('.context-menu-item')||menu.querySelector('.sd-is-selected'),index=rows.indexOf(current);
  if(event.key==='Escape'||event.key==='Tab'){closeWordContextMenu();editor.activeEditor.view.focus();return;}
  if(event.key==='Enter'){(current||rows[0])?.click();return;}
  const next=rows[event.key==='Home'?0:event.key==='End'?rows.length-1:(index+(event.key==='ArrowUp'?-1:1)+rows.length)%rows.length];
  next?.focus({preventScroll:true});return;
 }
 if(event.key!=='ContextMenu'&&!(event.shiftKey&&event.key==='F10'))return;
 if(!ready||event.target.closest('#toolbar'))return;
 event.preventDefault();event.stopPropagation();
 const s=editor.activeEditor.state.selection;
 const run=[...document.querySelectorAll('.superdoc-text-run[data-pm-start]')].find(n=>Number(n.dataset.pmStart)<=s.from&&Number(n.dataset.pmEnd)>s.from)||document.querySelector('.superdoc-text-run');
 if(!run)return;
 const top=document.querySelector('#toolbar').getBoundingClientRect().bottom,b=run.getBoundingClientRect();
 if(b.top<top||b.bottom>innerHeight)run.scrollIntoView({block:'center'});
 // Keyboard focus lives in the hidden PM editor. Resolve and reveal its actual
 // paginated run before asking SuperDoc to hit-test the native menu target.
 requestAnimationFrame(()=>{
  if(!ready||!run.isConnected)return;
  const rect=wordRangeRects({from:s.from,to:Math.max(s.to,s.from+1)})[0]||run.getBoundingClientRect();
  run.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:Math.max(1,Math.min(innerWidth-1,rect.left+Math.min(3,rect.width/2))),clientY:Math.max(top+1,Math.min(innerHeight-1,rect.top+rect.height/2))}));
 });
},true);
addEventListener('pointerdown',event=>{if(event.button===0&&!event.target.closest('#toolbar,.context-menu,.superdoc__popover')){selectionDismissed=false;send('selection-start');}},true);
addEventListener('pointerup',event=>{if(event.button===0&&!wordRegionMode)setTimeout(()=>readSelection(event),80);},true);
// SuperDoc can leave the hidden editor selection collapsed while its paginated
// surface has a native multi-page selection. Map that surface through PM runs.
function nativeWordRange(){
 const native=getSelection();if(!native?.rangeCount||native.isCollapsed)return null;
 const range=native.getRangeAt(0),view=editor?.activeEditor?.view;
 if(view?.dom.contains(range.startContainer)&&view.dom.contains(range.endContainer)){
  try{const from=view.posAtDOM(range.startContainer,range.startOffset),to=view.posAtDOM(range.endContainer,range.endOffset);if(to>from)return {from,to};}catch{}
 }
 let from=Infinity,to=-1;
 for(const run of document.querySelectorAll('#document .superdoc-text-run[data-pm-start][data-pm-end]')){
  if(!range.intersectsNode(run))continue;
  const base=Number(run.dataset.pmStart),walker=document.createTreeWalker(run,NodeFilter.SHOW_TEXT);let node,offset=0;
  while(node=walker.nextNode()){
   if(range.intersectsNode(node)){
    const start=range.startContainer===node?range.startOffset:0,end=range.endContainer===node?range.endOffset:node.length;
    if(end>start){from=Math.min(from,base+offset+start);to=Math.max(to,base+offset+end);}
   }
   offset+=node.length;
  }
 }
 return Number.isFinite(from)&&to>from?{from,to}:null;
}
function readSelection(event){
 if(selectionDismissed)return;
 if(event?.target?.closest?.('#toolbar'))return;
 const e=editor?.activeEditor;if(!ready||!e)return;
 const nativeRange=nativeWordRange();
 const s=nativeRange?{...nativeRange,empty:nativeRange.from===nativeRange.to}:e.state.selection;selection=null;
 if(!s.empty){
  const index=wordTextIndex(e.state.doc);
  const from=index.positions.findIndex(p=>p>=s.from);
  let to=index.positions.length;while(to>0&&index.positions[to-1]>=s.to)to--;
  if(from>=0&&to>from){const quote=index.text.slice(from,to);if(quote.trim())selection={space:'docx-main-text',quote,prefix:index.text.slice(Math.max(0,from-32),from),suffix:index.text.slice(to,to+32)};}
  if(selection?.quote.length>20000){send('selection',{anchor:null,error:'选文超过 20000 字符，请分段添加备注；没有截断原文。'});return;}
 }


 let rect=null;
 if(selection){
  const native=getSelection();if(native?.rangeCount&&!native.isCollapsed){const box=native.getRangeAt(0).getBoundingClientRect();if((box.width||box.height)&&box.right>0&&box.left<innerWidth)rect={left:box.left,right:box.right,top:box.top,bottom:box.bottom};}
  if(!rect){const boxes=wordRangeRects({from:s.from,to:s.to});if(boxes.length)rect={left:Math.min(...boxes.map(r=>r.left)),right:Math.max(...boxes.map(r=>r.right)),top:Math.min(...boxes.map(r=>r.top)),bottom:Math.max(...boxes.map(r=>r.bottom))};}
  if(!rect){
   const walker=document.createTreeWalker(document.querySelector('#document'),NodeFilter.SHOW_TEXT);let node;const matches=[];
   while(node=walker.nextNode()){const i=node.textContent.indexOf(selection.quote);if(i<0)continue;const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+selection.quote.length);const box=range.getBoundingClientRect();if(box.width&&box.right>0&&box.left<innerWidth&&box.bottom>0&&box.top<innerHeight)matches.push({left:box.left,right:box.right,top:box.top,bottom:box.bottom});}
   if(matches.length===1)rect=matches[0];
  }
 }
 const pages=[...document.querySelectorAll('.superdoc-page')],page=rect?pages.find(p=>{const b=p.getBoundingClientRect();return rect.top>=b.top&&rect.top<b.bottom}):null;
 send('selection',{anchor:selection,rect,displayLocation:page?{page:pages.indexOf(page)+1,pageSize:{width:page.offsetWidth,height:page.offsetHeight}}:null});
}
addEventListener('mouseup',event=>{if(event.button!==0||selectionDismissed)return;setTimeout(()=>readSelection(event),80);},true);addEventListener('keyup',event=>{if(event.key!=='Escape')setTimeout(()=>readSelection(event),0);},true);

addEventListener('scroll',()=>{send('selection',{anchor:null});clearTimeout(window.wordSelectionTimer);if(!selectionDismissed)window.wordSelectionTimer=setTimeout(()=>readSelection(),120);},true);
addEventListener('keydown',event=>{if(event.target.closest('.context-menu,#toolbar'))return;if((event.shiftKey&&/^(Arrow|Home|End)/.test(event.key))||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a')){selectionDismissed=false;send('selection-start');}if(event.key==='Escape'){selectionDismissed=true;clearTimeout(window.wordSelectionTimer);selection=null;send('selection',{anchor:null});}},true);

// SuperDoc updates its model after native selection and paints a separate paginated surface.
// Read after it settles; pointer events also cover repeated selection of the same text.
document.addEventListener('selectionchange',()=>{clearTimeout(window.wordSelectionTimer);window.wordSelectionTimer=setTimeout(()=>readSelection(),80);});

// Resolve independently of the live selection: annotations must not steal the caret.
let floatingAnchors=[],anchorLayoutFrame=0,authorshipEnabled=false;
function resolveFloatingAnchor(a){
 const doc=editor?.activeEditor?.state.doc;if(!doc)return null;
 const {text,positions}=wordTextIndex(doc),matches=[];
 for(let i=text.indexOf(a.quote);i>=0;i=text.indexOf(a.quote,i+1)){
  if(text.slice(Math.max(0,i-a.prefix.length),i)===a.prefix&&text.slice(i+a.quote.length,i+a.quote.length+a.suffix.length)===a.suffix)matches.push({from:positions[i],to:positions[i+a.quote.length-1]+1});
 }
 return matches.length===1?matches[0]:null;
}

function wordRangeRects(found){
 const rects=[];
 for(const run of document.querySelectorAll('#document .superdoc-text-run[data-pm-start][data-pm-end]')){
  const start=Number(run.dataset.pmStart),end=Number(run.dataset.pmEnd);if(found.to<=start||found.from>=end)continue;
  const walker=document.createTreeWalker(run,NodeFilter.SHOW_TEXT);let node,offset=0;
  while(node=walker.nextNode()){
   const from=Math.max(0,found.from-start-offset),to=Math.min(node.length,found.to-start-offset);offset+=node.length;if(to<=from)continue;
   const range=document.createRange();range.setStart(node,from);range.setEnd(node,to);
   for(const b of range.getClientRects())if(b.width&&b.right>0&&b.left<innerWidth&&b.bottom>0&&b.top<innerHeight)rects.push(b);
  }
 }
 return rects;
}
function queueAnchorLayout(){
 if(anchorLayoutFrame)return;
 anchorLayoutFrame=requestAnimationFrame(()=>{anchorLayoutFrame=0;
  const runs=[...document.querySelectorAll('#document .superdoc-text-run[data-pm-start][data-pm-end]')];
  const top=Math.max(0,document.querySelector('#toolbar').getBoundingClientRect().bottom);
  const anchors=floatingAnchors.map(({id,anchor})=>{
   if(anchor.space==='docx-rendered-page-normalized'){
    const page=document.querySelectorAll('.superdoc-page')[anchor.page-1];if(!page||wordRegionDirty)return {id,status:'unresolved'};
    const box=page.getBoundingClientRect(),rects=anchor.rects.map(r=>({left:box.left+r[0]*box.width,top:box.top+r[1]*box.height,width:r[2]*box.width,height:r[3]*box.height,bottom:box.top+(r[1]+r[3])*box.height})).filter(r=>r.bottom>top&&r.top<innerHeight&&r.left+r.width>0&&r.left<innerWidth);
    return rects.length?{id,status:'visible',...rects[0],rects}:{id,status:'offscreen',rects:[]};
   }
   const found=resolveFloatingAnchor(anchor);if(!found)return {id,status:'unresolved'};
   const rects=[];
   for(const run of runs){
    const start=Number(run.dataset.pmStart),end=Number(run.dataset.pmEnd);
    if(found.to<=start||found.from>=end)continue;
    const walker=document.createTreeWalker(run,NodeFilter.SHOW_TEXT);let node,offset=0;
    while(node=walker.nextNode()){
     const from=Math.max(0,found.from-start-offset),to=Math.min(node.length,found.to-start-offset);
     offset+=node.length;if(to<=from)continue;
     const range=document.createRange();range.setStart(node,from);range.setEnd(node,to);
     for(const b of range.getClientRects())if(b.width&&b.right>0&&b.left<innerWidth&&b.bottom>top&&b.top<innerHeight)rects.push({left:b.left,top:b.top,width:b.width,height:b.height,bottom:b.bottom});
    }
   }
   return rects.length?{id,status:'visible',...rects[0],rects}:{id,status:'offscreen',rects:[]};
  });
  send('anchor-layout',{anchors,top});
  if(ready&&authorshipEnabled)reportAuthorshipLayout(top);
 });
}
new MutationObserver(queueAnchorLayout).observe(document.querySelector('#document'),{subtree:true,childList:true,characterData:true,attributes:true});
new ResizeObserver(queueAnchorLayout).observe(document.documentElement);
addEventListener('scroll',event=>{if(!event.target.closest?.('.context-menu'))closeWordContextMenu();queueAnchorLayout();},true);
addEventListener('resize',()=>{closeWordContextMenu();queueAnchorLayout();});
new MutationObserver(()=>{const menu=document.querySelector('.context-menu');if(!menu)return;menu.setAttribute('role','menu');menu.setAttribute('aria-label','Word 文档操作');for(const row of menu.querySelectorAll('.context-menu-item')){row.setAttribute('role','menuitem');row.tabIndex=-1;}const b=menu.getBoundingClientRect();if(b.left<6||b.right>innerWidth-6)menu.style.left=Math.max(6,Math.min(innerWidth-b.width-6,b.left))+'px';if(b.top<6||b.bottom>innerHeight-6)menu.style.top=Math.max(6,Math.min(innerHeight-b.height-6,b.top))+'px';}).observe(document.body,{childList:true,subtree:true});

function reportAuthorshipLayout(top){
 const doc=editor.activeEditor.state.doc,index=wordTextIndex(doc),pages=[...document.querySelectorAll('.superdoc-page')],units=[],mainBlocks=new Set(),tables=[];
 doc.descendants((node,pos)=>{if(node.attrs.sdBlockId)mainBlocks.add(node.attrs.sdBlockId);if(node.type.name==='table')tables.push({from:pos,to:pos+node.nodeSize});});
 const byParagraph=new Map();
 const renderedBlocks=new Map();
 for(const block of document.querySelectorAll('#document [data-layout-story="body"][data-layout-block-ref]'))if(mainBlocks.has(block.dataset.layoutBlockRef)&&!renderedBlocks.has(block.dataset.layoutBlockRef))renderedBlocks.set(block.dataset.layoutBlockRef,block);
 for(const run of document.querySelectorAll('#document .superdoc-text-run[data-pm-start]')){
   if(run.closest('[data-layout-story]')?.dataset.layoutStory!=='body')continue;
   let fragment=run.parentElement;
   while(fragment&&!mainBlocks.has(fragment.dataset.layoutBlockRef||fragment.dataset.blockId))fragment=fragment.parentElement;
   if(!fragment){
    // SuperDoc uses generated IDs (for example "16-table") for table
    // fragments. Bind them through their declared PM range and verify the
    // actual run text; never treat a foreign story's offsets as body text.
    const table=run.closest('.superdoc-table-fragment'),from=Number(table?.dataset.pmStart),to=Number(table?.dataset.pmEnd),start=Number(run.dataset.pmStart),end=Number(run.dataset.pmEnd);
    if(!table||!Number.isInteger(from)||!Number.isInteger(to)||!tables.some(range=>range.from<=from&&range.to>=to)
      ||!Number.isInteger(start)||!Number.isInteger(end)||start<from||end>to||doc.textBetween(start,end,'','')!==run.textContent)continue;
   }
   const start=Number(run.dataset.pmStart);let lo=0,hi=index.paragraphs.length;
   while(lo<hi){const mid=(lo+hi)>>>1;if(index.paragraphs[mid].pmFrom<=start)lo=mid+1;else hi=mid;}
   const paragraph=index.paragraphs[lo-1];if(!paragraph||start>=paragraph.pmTo)continue;
   const fragments=byParagraph.get(paragraph)||new Map();byParagraph.set(paragraph,fragments);
   const page=run.closest('.superdoc-page');if(!page)continue;
   const position=doc.resolve(paragraph.pmFrom);let cellId='body';
   for(let depth=position.depth;depth>0;depth--)if(position.node(depth).type.name==='tableCell'){cellId='cell:'+position.node(depth).attrs.sdBlockId;break;}
   const boundary=pages.indexOf(page)+':'+cellId;
   const b=run.getBoundingClientRect(),prior=fragments.get(boundary);
   if(prior){prior.top=Math.min(prior.top,b.top);prior.bottom=Math.max(prior.bottom,b.bottom);prior.left=Math.min(prior.left,b.left-28);}
   else fragments.set(boundary,{...paragraph,boundary,top:b.top,bottom:b.bottom,left:b.left-28,page:pages.indexOf(page)+1});
 }
 for(const paragraph of index.paragraphs){
  const fragments=byParagraph.get(paragraph)||new Map();
  // Empty paragraphs still have a real rendered caret location for deletions.
  if(!fragments.size){
   const block=renderedBlocks.get(paragraph.blockId),page=block?.closest('.superdoc-page');
   if(block&&page){const b=block.getBoundingClientRect();fragments.set(pages.indexOf(page)+':body',{...paragraph,boundary:pages.indexOf(page)+':body',top:b.top,bottom:b.bottom,left:b.left-28,page:pages.indexOf(page)+1});}
  }
  units.push(...fragments.values());
 }
 const last=units.at(-1);if(last&&last.pmFrom===index.paragraphs.at(-1)?.pmFrom)units.push({...last,from:index.text.length,to:index.text.length,boundary:last.boundary+':end'});
 send('authorship-layout',{text:index.text,units,top,bottom:innerHeight});
}

let wordRegionMode=false,wordRegionDirty=false;
function setWordRegion(enabled){wordRegionMode=enabled;document.body.classList.toggle('word-region-selecting',enabled);send('region-mode',{enabled});}
addEventListener('keydown',e=>{if(e.key==='Escape')setWordRegion(false);},true);
addEventListener('pointerdown',event=>{
 if(!wordRegionMode||event.button!==0)return;
 const page=event.target.closest('.superdoc-page');if(!page)return;
 event.preventDefault();event.stopImmediatePropagation();selectionDismissed=true;
 const box=page.getBoundingClientRect(),pages=[...document.querySelectorAll('.superdoc-page')],start={x:event.clientX,y:event.clientY};
 const preview=document.createElement('div');preview.className='word-region-preview';document.body.append(preview);
 let current=start;
 const bounds=()=>({left:Math.max(box.left,Math.min(start.x,current.x)),top:Math.max(box.top,Math.min(start.y,current.y)),right:Math.min(box.right,Math.max(start.x,current.x)),bottom:Math.min(box.bottom,Math.max(start.y,current.y))});
 const move=e=>{current={x:e.clientX,y:e.clientY};const r=bounds();Object.assign(preview.style,{left:r.left+'px',top:r.top+'px',width:r.right-r.left+'px',height:r.bottom-r.top+'px'});e.preventDefault();e.stopImmediatePropagation();};
 const end=e=>{
  removeEventListener('pointermove',move,true);removeEventListener('pointerup',end,true);removeEventListener('pointercancel',cancel,true);removeEventListener('keydown',key,true);
  const active=wordRegionMode;setWordRegion(false);preview.remove();e.preventDefault();e.stopImmediatePropagation();
  if(!active||e.type!=='pointerup')return;
  current={x:e.clientX,y:e.clientY};const r=bounds();if(r.right-r.left<4||r.bottom-r.top<4)return;
  const anchor={space:'docx-rendered-page-normalized',page:pages.indexOf(page)+1,rotation:0,rects:[[(r.left-box.left)/box.width,(r.top-box.top)/box.height,(r.right-r.left)/box.width,(r.bottom-r.top)/box.height]],quote:''};
  selectionDismissed=true;send('selection',{anchor,rect:r,displayLocation:{page:pages.indexOf(page)+1,pageSize:{width:page.offsetWidth,height:page.offsetHeight}}});
 };
 const cancel=e=>{setWordRegion(false);end(e);};const key=e=>{if(e.key==='Escape')cancel(e);};
 addEventListener('pointermove',move,true);addEventListener('pointerup',end,true);addEventListener('pointercancel',cancel,true);addEventListener('keydown',key,true);
},true);

let lastWordZoom="";
function reportWordZoom(){if(!ready)return;const state=editor.getZoomState(),key=JSON.stringify(state);if(key!==lastWordZoom){lastWordZoom=key;send("zoom",{state});}queueAnchorLayout();}
new ResizeObserver(()=>requestAnimationFrame(reportWordZoom)).observe(document.querySelector("#document"));
