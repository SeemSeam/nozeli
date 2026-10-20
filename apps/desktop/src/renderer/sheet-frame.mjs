import {openPackage,patchPackage} from './xlsx-package.mjs';
import {mountContextMenu} from './context-menu.mjs';
let channel,original,baseline,initial,editor,ready=false,root,lastContent,lastLayout,readOnly=false;
const contents=sheets=>JSON.stringify(sheets.map(s=>({id:s.id,cells:(s.data||[]).map(row=>row.map(c=>c?.f?{f:c.f}:{v:c?.v??null}))})));
const send=(type,extra={})=>parent.postMessage({nozeliSheet:channel,type,...extra},location.origin);
// Unsupported formatting/structure changes are rejected, never silently discarded on save.
// Inactive sheets are lazily materialized by Fortune. Compare sparse semantic styles,
// not the presence/size of its runtime data matrix.
function shape(sheets){return sheets.map(s=>{
 const cells=[];const add=(r,c,cell)=>{if(!cell)return;const style={};for(const key of ['bl','it','ff','fs','fc','bg','un','cl','ht','vt','tb','tr','mc'])if(cell[key]!==undefined)style[key]=cell[key];const format=cell.ct?.fa||'General';if(format!=='General')style.numberFormat=format;if(Object.keys(style).length)cells.push({r,c,style});};
 if(s.data)s.data.forEach((row,r)=>row?.forEach((cell,c)=>add(r,c,cell)));else for(const cell of s.celldata||[])add(cell.r,cell.c,cell.v);
 cells.sort((a,b)=>a.r-b.r||a.c-b.c);return {id:s.id,name:s.name,row:s.row,column:s.column,config:s.config||{},cells};
});}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const layout=sheets=>JSON.stringify(canonical(shape(sheets)));
let workbookKey=0;
function renderWorkbook(sheets,restore=null){
 const firstMount=!ready;
 root.render(React.createElement(react.Workbook,{key:workbookKey,data:structuredClone(sheets),allowEdit:!readOnly,showToolbar:false,cellContextMenu:['copy'],headerContextMenu:['copy'],sheetTabContextMenu:[],hooks:{beforeAddSheet:()=>false},onChange:data=>{if(ready&&!readOnly){const next=contents(data),structure=layout(data);if(next!==lastContent||structure!==lastLayout){lastContent=next;lastLayout=structure;send('changed');}}},ref:ref=>{
  if(!ref)return;editor=ref;window.nozeliSheetEditor=editor;
  if(firstMount&&!ready)setTimeout(()=>{editor.calculateFormula();setTimeout(()=>{if(ready)return;initial=structuredClone(editor.getAllSheets());lastContent=contents(initial);lastLayout=layout(initial);ready=true;document.querySelector('#sheet').inert=false;send('ready');},0);},0);
  if(restore){const saved=restore;restore=null;requestAnimationFrame(()=>restoreSheetReadingPosition(saved,true));}
 }}));
}
function restoreSheetReadingPosition(saved,restoreTab=false){
 if(!restoreTab&&editor.getSheet().id!==saved.id)return;
 if(editor.getAllSheets().some(sheet=>sheet.id===saved.id)){
  if(editor.getSheet().id!==saved.id)editor.activateSheet({id:saved.id});
  // updateSheet freezes its input; setSelection normalizes ranges in place.
  if(saved.selection?.length)editor.setSelection(structuredClone(saved.selection));
 }
 requestAnimationFrame(()=>{if(editor.getSheet().id!==saved.id)return;for(const {selector,top,left} of saved.scroll){const node=document.querySelector(selector);if(node){node.scrollTop=top;node.scrollLeft=left;}}});
}
window.nozeliSheetModels={
 snapshotModel(){if(!ready)throw Error('电子表格尚未就绪');return structuredClone(editor.getAllSheets());},
 applyModel(model){
  if(!ready||!readOnly)throw Error('只有就绪的阅读副本可接收表格');
  const saved={id:editor.getSheet().id,selection:structuredClone(editor.getSelection()),scroll:['.luckysheet-scrollbar-x','.luckysheet-scrollbar-y'].map(selector=>{const node=document.querySelector(selector);return {selector,top:node?.scrollTop||0,left:node?.scrollLeft||0};})};
  const local=editor.getAllSheets(),next=structuredClone(model).map(sheet=>{
   const previous=local.find(item=>item.id===sheet.id);
   for(const key of ['scrollTop','scrollLeft','luckysheet_select_save','luckysheet_select_status']){delete sheet[key];if(previous?.[key]!==undefined)sheet[key]=structuredClone(previous[key]);}
   if(sheet.id===saved.id){sheet.scrollTop=saved.scroll.find(item=>item.selector.endsWith('-y')).top;sheet.scrollLeft=saved.scroll.find(item=>item.selector.endsWith('-x')).left;sheet.luckysheet_select_save=saved.selection;}
   sheet.status=sheet.id===saved.id?1:0;return sheet;
  });
  if(local.some(sheet=>!next.some(item=>item.id===sheet.id))){workbookKey++;renderWorkbook(next,saved);}
  else {editor.updateSheet(next);requestAnimationFrame(()=>restoreSheetReadingPosition(saved));}
 }
};
addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(ready)send('save');}},true);
addEventListener('message',async event=>{
 if(event.source!==parent||event.origin!==location.origin||!event.data?.nozeliSheet)return;const data=event.data;
 try{
  if(data.type==='open'&&!channel){
   readOnly=data.readOnly===true;
   channel=data.nozeliSheet;original=data.bytes;baseline=await openPackage(original);root=ReactDOM.createRoot(document.querySelector('#sheet'));
   renderWorkbook(baseline);
  }else if(data.nozeliSheet===channel&&data.type==='context-close'){
   sheetMenu.close();
  }else if(data.nozeliSheet===channel&&data.type==='clipboard-result'){
   const request=clipboardRequests.get(data.requestId);if(request){clipboardRequests.delete(data.requestId);data.error?request.reject(Error(data.error)):request.resolve(data.value);}
  }else if(data.nozeliSheet===channel&&data.type==='snapshot'){
   send('exported',{requestId:data.requestId,bytes:new TextEncoder().encode(JSON.stringify({schema:'nozeli-sheet-recovery-v1',name:data.name,sheets:editor.getAllSheets(),original:Array.from(original)}))});
  }else if(data.nozeliSheet===channel&&data.type==='export'){
   if(!ready)throw Error('电子表格尚未就绪');const current=structuredClone(editor.getAllSheets());
   // Cell content edits can change inferred type/display; compare styles separately from ct.
   if(layout(initial)!==layout(current))throw Error('当前仅支持内容与公式保存；请使用 Ctrl+Z 撤销格式或行列结构变更后再保存。');
   const bytes=await patchPackage(original,baseline,current);send('exported',{requestId:data.requestId,bytes});
  }
 }catch(error){send('error',{requestId:data.requestId,message:error.message});}
});

const sheetMenu=mountContextMenu({id:'sheet-context-menu',label:'单元格操作',onOpen:()=>send('context-menu'),onClose:()=>send('context-close'),onError:message=>send('error',{message})});
const clipboardRequests=new Map();
function clipboard(action,text){return new Promise((resolve,reject)=>{
 const requestId=crypto.randomUUID(),timer=setTimeout(()=>{clipboardRequests.delete(requestId);reject(Error('剪贴板操作超时'));},10000);
 clipboardRequests.set(requestId,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});send('clipboard',{requestId,action,text});
});}
function openSheetMenu(x,y){
 if(!ready)return;
 const ranges=structuredClone(editor.getSelection()||[]),range=ranges.length===1?ranges[0]:null,id=editor.getSheet().id;
 const valid=range&&(range.row[1]-range.row[0]+1)*(range.column[1]-range.column[0]+1)<=10000;
 const snapshot=contents(editor.getAllSheets()),structure=layout(editor.getAllSheets());
 const current=()=>ready&&editor.getSheet().id===id&&contents(editor.getAllSheets())===snapshot&&layout(editor.getAllSheets())===structure&&JSON.stringify(editor.getSelection())===JSON.stringify(ranges);
 const cells=valid?editor.getCellsByRange(range):[];
 const copy=cells.map(row=>row.map(cell=>{const text=String(cell?.m??cell?.v??'');return /[\t\n\r"]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;}).join('\t')).join('\n');
 sheetMenu.open([{id:'undo',label:'撤销',shortcut:'Ctrl/Cmd+Z'},{id:'redo',label:'重做',shortcut:'Ctrl/Cmd+Shift+Z'},{separator:true},
  {id:'copy',label:'复制',enabled:Boolean(valid),shortcut:'Ctrl/Cmd+C'}, {id:'paste',label:'粘贴内容',enabled:Boolean(valid),shortcut:'Ctrl/Cmd+V'},
  {id:'clear',label:'清空内容',enabled:Boolean(valid)},{id:'formula',label:'编辑内容 / 公式',enabled:Boolean(valid&&range.row[0]===range.row[1]&&range.column[0]===range.column[1])},{id:'find',label:'查找单元格…',shortcut:'Ctrl/Cmd+F'}
 ].filter(item=>!readOnly||['copy','find'].includes(item.id)),{x,y,run:async command=>{
  if(command==='copy')return clipboard('write',copy);
  if(readOnly&&command!=='find')return;
  if(!current()){send('error',{message:'表格内容或选区已变化，请重新右键。'});return;}
  if(command==='undo')return editor.handleUndo();if(command==='redo')return editor.handleRedo();
  if(command==='formula'){const input=document.querySelector('#luckysheet-functionbox-cell');input.focus();getSelection()?.selectAllChildren(input);return;}
  if(command==='find')return findCell();
  if(command==='clear'){
   const calls=[];
   for(let r=range.row[0];r<=range.row[1];r++)for(let c=range.column[0];c<=range.column[1];c++)calls.push({name:'clearCell',args:[r,c]});
   editor.batchCallApis([...calls,{name:'calculateFormula',args:[]}]);return;
  }
  let data;
  if(command==='paste'){
   const text=await clipboard('read');if(!current()){send('error',{message:'表格内容或选区已变化，未粘贴旧位置。'});return;}
   data=parseTabular(text);if(!data.length)return;
  }else return;
  const target={row:[range.row[0],range.row[0]+data.length-1],column:[range.column[0],range.column[0]+data[0].length-1]};
  const sheet=editor.getSheet();if(data.length*data[0].length>10000||target.row[1]>=sheet.row||target.column[1]>=sheet.column)throw Error('粘贴范围过大或超出当前表格，未修改。');
  // Fortune's public batch API keeps the edit and dependent recalculation in
  // one native undo transaction. Separate calls require two undos for one paste.
  const calls=[];
  for(let r=target.row[0];r<=target.row[1];r++)for(let c=target.column[0];c<=target.column[1];c++)calls.push({name:'clearCell',args:[r,c]});
  editor.batchCallApis([...calls,{name:'setCellValuesByRange',args:[data,target,document.querySelector('#luckysheet-rich-text-editor')]},{name:'calculateFormula',args:[]}]);
 }});
}
function parseTabular(text){
 const rows=[[]];let field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'&&(quoted||!field)){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(!quoted&&(c==='\t'||c==='\n'||c==='\r')){rows.at(-1).push(field);field='';if(c!=='\t'){if(c==='\r'&&text[i+1]==='\n')i++;rows.push([]);}}else field+=c;}
 rows.at(-1).push(field);if(rows.length>1&&rows.at(-1).length===1&&rows.at(-1)[0]==='')rows.pop();const width=Math.max(...rows.map(r=>r.length));return rows.map(row=>Array.from({length:width},(_,i)=>row[i]||''));
}
function findCell(){
 let dialog=document.querySelector('#sheet-find');if(!dialog){dialog=document.createElement('dialog');dialog.id='sheet-find';dialog.innerHTML='<form><label>查找单元格 <input required aria-label="查找单元格"></label><button>查找下一处</button><button type="button">关闭</button><p role="status"></p></form>';document.body.append(dialog);dialog.querySelector('[type=button]').onclick=()=>dialog.close();}
 let last='',offset=0;dialog.querySelector('form').onsubmit=event=>{event.preventDefault();const query=dialog.querySelector('input').value.toLowerCase();if(query!==last)offset=0;last=query;const hits=[];(editor.getSheet().data||[]).forEach((row,r)=>row?.forEach((cell,c)=>{if(String(cell?.f??cell?.m??cell?.v??'').toLowerCase().includes(query))hits.push({row:[r,r],column:[c,c]});}));if(hits.length){const hit=hits[offset++%hits.length];editor.setSelection([hit]);dialog.querySelector('p').textContent='已定位 · 第 '+(hit.row[0]+1)+' 行，第 '+(hit.column[0]+1)+' 列';}else dialog.querySelector('p').textContent='未找到';};dialog.showModal();dialog.querySelector('input').focus();
}
// Fortune resolves frozen/scrolled grid coordinates and retains an in-range
// selection. Its stock menu is hidden; supported content APIs use our shell.
addEventListener('contextmenu',event=>{if(!ready||event.target.closest('input,textarea,[contenteditable],.nozeli-context-menu,.luckysheet-sheets-item'))return;if(!event.target.closest('#sheet'))return;event.preventDefault();const{x,y}=event;requestAnimationFrame(()=>openSheetMenu(x,y));},true);
addEventListener('keydown',event=>{if(!ready||event.target.closest('.nozeli-context-menu,dialog,#luckysheet-functionbox-cell'))return;if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();event.stopPropagation();const b=document.querySelector('canvas')?.getBoundingClientRect();openSheetMenu((b?.left||0)+80,(b?.top||0)+50);}},true);
