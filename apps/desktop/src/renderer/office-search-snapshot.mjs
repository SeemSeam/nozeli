// Read current Office models without exporting, flushing text commits or writing files.
export function officeSearchSnapshot(kind){
 const frame=document.querySelector(kind==='ppt'?'#ppt-frame':'#word-host iframe'),doc=frame?.contentDocument;
 if(!frame?.contentWindow||!doc)return {blocked:true,reason:'Office编辑器尚未就绪'};
 const active=doc.activeElement;
 if(active&&(active.isContentEditable||['INPUT','TEXTAREA'].includes(active.tagName)))return {blocked:true,reason:'Office单元格或富文本仍在输入中，未使用旧模型替代'};
 let text='',segments=[];
 const add=(value,location)=>{value=String(value??'').replace(/\r\n?/g,'\n');if(!value.trim())return;const from=text.length;text+=value+'\n';segments.push({from,to:text.length,...location});if(text.length>8*1024*1024)throw Error('Office可搜索文本超过8MiB限制');};
 const plain=html=>new DOMParser().parseFromString(String(html??''),'text/html').body.textContent||'';
 if(kind==='ppt'){
  const slides=frame.contentWindow.__nozeliPptist?.store?.slides;
  if(!Array.isArray(slides))return {blocked:true,reason:'幻灯片模型尚未就绪'};
  const visit=(element,page)=>{
   if(element.type==='text')add(plain(element.content),{page});
   if(element.type==='table')for(const row of element.data||[])for(const cell of row||[])add(plain(cell.text??cell.content),{page});
   for(const child of element.elements||element.children||[])visit(child,page);
  };
  slides.forEach((slide,index)=>{for(const element of slide.elements||[])visit(element,index+1);});
 }else if(kind==='sheet'){
  const sheets=frame.contentWindow.nozeliSheetEditor?.getAllSheets?.();
  if(!Array.isArray(sheets))return {blocked:true,reason:'工作表模型尚未就绪'};
  const columnName=index=>{let name='';for(let n=index+1;n;n=Math.floor((n-1)/26))name=String.fromCharCode(65+(n-1)%26)+name;return name;};
  for(const sheet of sheets){
   const addCell=(r,c,cell)=>{if(!cell)return;let value=cell.m??cell.v??'';if(typeof value==='object')value=cell.ct?.s?.map(s=>s.v||'').join('')||'';if(cell.f)value+=(value?'\t':'')+'='+String(cell.f).replace(/^=/,'');if(String(value).trim())add(`${sheet.name}!${columnName(c)}${r+1}\t${value}`,{sheetName:sheet.name,row:r+1,column:c+1});};
   if(sheet.data)sheet.data.forEach((row,r)=>row?.forEach((cell,c)=>addCell(r,c,cell)));else for(const cell of sheet.celldata||[])addCell(cell.r,cell.c,cell.v);
  }
 }
 return {text,segments,kind};
}
