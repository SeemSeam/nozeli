// Browser-only OOXML adapter. Preserve untouched ZIP members; never rebuild a source workbook.
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const xml=text=>{if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('不支持 XML 实体');const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw Error('无效 XML');return doc;};
const elements=(node,name)=>Array.from(node.getElementsByTagNameNS('*',name));
const address=(r,c)=>{let s='';for(c++;c;c=Math.floor((c-1)/26))s=String.fromCharCode(65+(c-1)%26)+s;return s+(r+1);};
async function unzip(bytes){if(bytes.length>32*1024*1024)throw Error('表格超过 32 MiB');const z=await JSZip.loadAsync(bytes);const files=Object.values(z.files);if(files.length>10000||files.reduce((n,f)=>n+(f._data?.uncompressedSize||0),0)>128*1024*1024)throw Error('表格解压尺寸过大');return z;}
export async function openPackage(bytes){
 const preview=await unzip(bytes);
 // ExcelJS cannot parse chart-only drawings. Remove drawing links from the parse-only copy.
 // Export always patches the untouched original package; charts remain intact there.
 for(const name of Object.keys(preview.files).filter(n=>/^xl\/worksheets\/[^/]+\.xml$/.test(n))){const d=xml(await preview.file(name).async('string'));for(const el of elements(d,'drawing'))el.remove();preview.file(name,new XMLSerializer().serializeToString(d));}
 for(const name of Object.keys(preview.files)){
  if(name.startsWith('xl/drawings/'))preview.remove(name);
  else if(/^xl\/worksheets\/_rels\//.test(name)&&name.endsWith('.rels')){const d=xml(await preview.file(name).async('string'));for(const el of elements(d,'Relationship'))if(el.getAttribute('Type')?.endsWith('/drawing'))el.remove();preview.file(name,new XMLSerializer().serializeToString(d));}
 }
 const book=new ExcelJS.Workbook();await book.xlsx.load(await preview.generateAsync({type:'uint8array'}));
 return book.worksheets.map((ws,index)=>{
  if(ws.rowCount>10000||ws.columnCount>1000)throw Error('当前表格超出已验证范围（10000 行 / 1000 列）');
  const celldata=[];ws.eachRow((row,r)=>row.eachCell((cell,c)=>{
   if(cell.type===ExcelJS.ValueType.Merge)return;
   let value=cell.value, f;
   if(value&&typeof value==='object'){
    if(value.formula||value.sharedFormula){f='='+cell.formula;value=cell.result??null;}
    else if(value.richText)value=value.richText.map(x=>x.text).join('');
    else if(value.text!==undefined)value=value.text;
    else if(value instanceof Date)value=(value.getTime()-Date.UTC(1899,11,30))/86400000;
    else if(value.error)value=value.error;
    else throw Error('尚不支持的单元格类型 '+cell.address);
   }
   const v={v:value,m:cell.text,ct:{fa:cell.numFmt||'General',t:typeof value==='number'?'n':'g'}};
   if(f)v.f=f;if(cell.font?.bold)v.bl=1;if(cell.font?.italic)v.it=1;if(cell.font?.size)v.fs=cell.font.size;
   if(cell.font?.color?.argb)v.fc='#'+cell.font.color.argb.slice(-6);
   if(cell.fill?.fgColor?.argb)v.bg='#'+cell.fill.fgColor.argb.slice(-6);
   celldata.push({r:r-1,c:c-1,v});
  }));
  const merge={};for(const range of ws.model.merges||[]){const m=ws.getCell(range.split(':')[0]),end=ws.getCell(range.split(':')[1]||range);merge[`${m.row-1}_${m.col-1}`]={r:m.row-1,c:m.col-1,rs:end.row-m.row+1,cs:end.col-m.col+1};}
  for(const m of Object.values(merge))for(let r=m.r;r<m.r+m.rs;r++)for(let c=m.c;c<m.c+m.cs;c++){let cell=celldata.find(v=>v.r===r&&v.c===c);if(!cell){cell={r,c,v:{}};celldata.push(cell);}cell.v.mc=r===m.r&&c===m.c?{...m}:{r:m.r,c:m.c};}
  return {id:String(ws.id),name:ws.name,order:index,status:index===0?1:0,luckysheet_select_save:[{row:[0,0],column:[0,0],row_focus:0,column_focus:0}],row:Math.max(ws.rowCount,100),column:Math.max(ws.columnCount,26),celldata,calcChain:celldata.filter(c=>c.v.f).map(c=>({r:c.r,c:c.c,id:String(ws.id)})),config:{merge}};
 });
}
const matrix=sheet=>{const out=new Map();if(sheet.data)sheet.data.forEach((row,r)=>row?.forEach((v,c)=>{if(v)out.set(address(r,c),v);}));else for(const {r,c,v} of sheet.celldata||[])out.set(address(r,c),v);return out;};
const content=v=>{
 if(v?.f)return {f:v.f.replace(/^=/,'')};
 let value=v?.v??null;
 if(v?.ct?.t==='n'&&typeof value==='string'&&value.trim()&&Number.isFinite(Number(value)))value=Number(value);
 if(v?.ct?.t==='inlineStr')throw Error('当前不支持富文本单元格编辑，请使用纯文本粘贴。');
 return {v:value};
};
export async function patchPackage(bytes,before,after){
 if(after.length!==before.length||after.some((s,i)=>s.id!==before[i].id||s.name!==before[i].name||s.row!==before[i].row||s.column!==before[i].column))throw Error('当前保存不支持工作表或行列结构变更');
 const z=await unzip(bytes),book=xml(await z.file('xl/workbook.xml').async('string')),rels=xml(await z.file('xl/_rels/workbook.xml.rels').async('string'));
 const sheets=elements(book,'sheet');let changed=false;
 for(let i=0;i<before.length;i++){
  const a=matrix(before[i]),b=matrix(after[i]);const changes=[...new Set([...a.keys(),...b.keys()])].filter(key=>JSON.stringify(content(a.get(key)))!==JSON.stringify(content(b.get(key))));if(!changes.length)continue;
  const rel=elements(rels,'Relationship').find(r=>r.getAttribute('Id')===sheets[i].getAttribute('r:id'));const target=rel?.getAttribute('Target');
  if(!target||target.includes('..'))throw Error('不支持的工作表路径');const filename=target.startsWith('/')?target.slice(1):'xl/'+target;
  const doc=xml(await z.file(filename).async('string')),sheetData=elements(doc,'sheetData')[0];
  if(elements(doc,'f').some(f=>['array','shared','dataTable'].includes(f.getAttribute('t'))))throw Error('此工作表含共享、数组或数据表公式，当前仅支持浏览。');
  for(const key of changes){
   let cell=elements(sheetData,'c').find(c=>c.getAttribute('r')===key);
   if(cell&&elements(cell,'f').some(f=>f.hasAttribute('t')))throw Error('暂不支持修改共享或数组公式');
   const rowNum=Number(key.match(/\d+$/)[0]);let row=elements(sheetData,'row').find(r=>Number(r.getAttribute('r'))===rowNum);
   if(!row){row=doc.createElementNS(NS,'row');row.setAttribute('r',rowNum);sheetData.insertBefore(row,elements(sheetData,'row').find(r=>Number(r.getAttribute('r'))>rowNum)||null);}
   if(!cell){cell=doc.createElementNS(NS,'c');cell.setAttribute('r',key);const column=s=>[...s.replace(/\d/g,'')].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);row.insertBefore(cell,elements(row,'c').find(c=>column(c.getAttribute('r'))>column(key))||null);}
   for(const node of [...cell.children])if(['f','v','is'].includes(node.localName))node.remove();cell.removeAttribute('t');
   const value=content(b.get(key));const add=(name,text,parent=cell)=>{const node=doc.createElementNS(NS,name);node.textContent=String(text);parent.append(node);return node;};
   if(value.f!==undefined)add('f',value.f);
   else if(value.v!==null){if(typeof value.v==='number'){if(!Number.isFinite(value.v))throw Error('无效数字');add('v',value.v);}else if(typeof value.v==='boolean'){cell.setAttribute('t','b');add('v',value.v?1:0);}else{cell.setAttribute('t','inlineStr');const t=add('t',value.v,add('is',''));t.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');}}
  }
  const dimension=elements(doc,'dimension')[0];
  if(dimension){let maxRow=0,maxCol=0;for(const cell of elements(sheetData,'c')){const ref=cell.getAttribute('r');maxRow=Math.max(maxRow,Number(ref.match(/\d+$/)?.[0]||1)-1);const col=[...ref.replace(/\d/g,'')].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;maxCol=Math.max(maxCol,col);}dimension.setAttribute('ref','A1:'+address(maxRow,maxCol));}
  z.file(filename,new XMLSerializer().serializeToString(doc));changed=true;
 }
 if(!changed)return bytes;
 // A stale calculation chain can reference removed/replaced formulas; let Office rebuild it.
 if(z.file('xl/calcChain.xml')){
  z.remove('xl/calcChain.xml');for(const rel of elements(rels,'Relationship'))if(rel.getAttribute('Type')?.endsWith('/calcChain'))rel.remove();z.file('xl/_rels/workbook.xml.rels',new XMLSerializer().serializeToString(rels));
  const types=xml(await z.file('[Content_Types].xml').async('string'));for(const item of elements(types,'Override'))if(item.getAttribute('PartName')==='/xl/calcChain.xml')item.remove();z.file('[Content_Types].xml',new XMLSerializer().serializeToString(types));
 }
 // Invalidate formula caches in every sheet: Excel/LibreOffice must recalculate dependencies.
 for(const filename of Object.keys(z.files).filter(n=>/^xl\/worksheets\/[^/]+\.xml$/.test(n))){const doc=xml(await z.file(filename).async('string'));let dirty=false;for(const cell of elements(doc,'c'))if(elements(cell,'f').length){for(const v of elements(cell,'v'))v.remove();dirty=true;}if(dirty)z.file(filename,new XMLSerializer().serializeToString(doc));}
 let calc=elements(book,'calcPr')[0];if(!calc){calc=book.createElementNS(NS,'calcPr');book.documentElement.append(calc);}calc.setAttribute('fullCalcOnLoad','1');calc.setAttribute('forceFullCalc','1');calc.setAttribute('calcMode','auto');z.file('xl/workbook.xml',new XMLSerializer().serializeToString(book));
 return z.generateAsync({type:'uint8array',compression:'DEFLATE'});
}
