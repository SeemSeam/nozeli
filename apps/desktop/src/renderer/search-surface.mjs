import {officeSearchSnapshot} from './office-search-snapshot.mjs';
const normalize=text=>String(text??'').replace(/\r\n?/g,'\n');
async function digest(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
// Read-only bridge: search never flushes, saves or exports an editor buffer.
export function mountSearchSurface({current,setTextMode}){
 window.__nozeliSearchSnapshot=()=>{
  const c=current(),file=c.file;
  if(!file||c.review)return null;
  const base={relPath:file.relPath,kind:file.kind};
  if(c.composing||c.blocked)return {...base,blocked:true,reason:'有输入组合或文档状态尚未确认'};
  if(file.kind==='text'&&c.editor?.adapter)return {...base,kind:'text',text:normalize(c.editor.adapter.getText())};
  if(file.kind==='word'&&c.office?.getText)return {...base,kind:'word',text:normalize(c.office.getText())};
  if(['ppt','sheet'].includes(file.kind)){try{return {...base,...officeSearchSnapshot(file.kind)};}catch(error){return {...base,blocked:true,reason:error.message};}}
  if(c.dirty)return {...base,blocked:true,reason:'此文档有未保存编辑，尚不能核实可搜索的正文；未用磁盘旧版替代'};
  return {...base,disk:true};
 };
 window.__nozeliSearchReveal=async hit=>{
  const c=current(),file=c.file,still=()=>current().file===file&&(!hit.projectId||current().projectId===hit.projectId);
  if(!file||!still()||c.review||file.relPath!==hit.relPath||c.composing||c.blocked)return {ok:false,message:'文档已切换或仍在编辑组合，请重新搜索'};
  if(file.kind==='text'){
   if(!c.editor?.adapter)return {ok:false,message:'文本编辑器尚未就绪'};
   const adapter=c.editor.adapter,text=normalize(adapter.getText());
   if(await digest(text)!==hit.digest||!still()||normalize(adapter.getText())!==text||text.slice(hit.from,hit.to)!==hit.matchText)return {ok:false,message:'文字已变化，请重新搜索后定位'};
   const raw=adapter.getText();
   const offset=n=>{if(raw===text)return n;let source=0,normalized=0;while(source<raw.length&&normalized<n){if(raw[source]==='\r'&&raw[source+1]==='\n')source++;source++;normalized++;}return source;};
   setTextMode('edit');adapter.revealRange(offset(hit.from),offset(hit.to));adapter.focus();return {ok:true,location:'exact'};
  }
  if(file.kind==='word'&&c.office?.getText){
   const text=normalize(c.office.getText());
   if(await digest(text)!==hit.digest||!still()||normalize(c.office.getText())!==text||text.slice(hit.from,hit.to)!==hit.matchText)return {ok:false,message:'Word正文与搜索快照不同，请刷新搜索'};
   c.office.locate({space:'docx-main-text',quote:hit.matchText,prefix:text.slice(Math.max(0,hit.from-32),hit.from),suffix:text.slice(hit.to,hit.to+32)});return {ok:true,location:'quote'};
  }
  if(file.kind==='pdf'&&c.pdf){if(hit.page)await c.pdf.go(hit.page);return {ok:still(),location:'page',message:'已打开PDF命中页；扫描页需OCR'};}
  if(['ppt','sheet'].includes(file.kind)&&hit.source==='buffer'){
   const snapshot=officeSearchSnapshot(file.kind);
   if(snapshot.blocked||await digest(snapshot.text)!==hit.digest||!still())return {ok:false,message:'Office正文已变化或仍在输入，请重新搜索后定位'};
  }
  if(file.kind==='ppt'){
   if(c.dirty&&hit.source!=='buffer')return {ok:false,message:'幻灯片草稿已变化，请重新搜索'};
   const engine=document.querySelector('#ppt-frame')?.contentWindow?.__nozeliPptist;
   if(!engine?.store||!hit.page)return {ok:false,message:'幻灯片页尚未就绪'};
   engine.store.updateSlideIndex(hit.page-1);return {ok:still(),location:'slide'};
  }
  if(file.kind==='sheet'){
   if(c.dirty&&hit.source!=='buffer')return {ok:false,message:'表格草稿已变化，请重新搜索'};
   const frame=document.querySelector('#word-host iframe'),editor=frame?.contentWindow?.nozeliSheetEditor;
   const sheets=editor?.getAllSheets?.();
   const sheet=Array.isArray(sheets)?sheets.find(row=>row.name===hit.sheetName||row.id===hit.sheetName):null;
   if(!sheet)return {ok:false,message:'已打开表格，但工作表位置尚不能确认'};
   editor.activateSheet({id:sheet.id});
   if(Number.isInteger(hit.row)&&Number.isInteger(hit.sheetColumn))editor.setSelection([{row:[hit.row-1,hit.row-1],column:[hit.sheetColumn-1,hit.sheetColumn-1]}]);
   return {ok:still(),location:'cell'};
  }
  return {ok:false,message:'此格式暂不支持精确搜索定位'};
 };
}
