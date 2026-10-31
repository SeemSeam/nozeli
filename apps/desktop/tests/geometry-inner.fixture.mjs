// Runs in the actual document renderer, using production host/vendor selectors.
export function innerViewportMetrics(){
 const rel=__workspaceScope.relPath,box=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,clientWidth:node.clientWidth,clientHeight:node.clientHeight};},visible=node=>node&&node.getClientRects().length&&!node.hidden;
 const close=(a,b)=>Math.abs(a-b)<=3,inside=(a,b)=>a&&b&&a.x>=b.x-3&&a.right<=b.right+3;
 const scroll=document.querySelector('#reader-scroll'),viewport=box(scroll),m={rel,viewport,valid:false};
 if(rel.endsWith('.pdf')){
  const host=document.querySelector('#pdf-host'),page=host?.querySelector('.pdf-page'),canvas=page?.querySelector('canvas'),css=host&&getComputedStyle(host);m.host=box(host);m.page=box(page);m.canvas=box(canvas);m.textReady=Boolean(page?.querySelector('.textLayer span'));m.expectedWidth=scroll.clientWidth-parseFloat(css?.paddingLeft||0)-parseFloat(css?.paddingRight||0)-2;
  m.valid=Boolean(canvas?.width&&canvas.height&&m.textReady&&close(m.page.width,m.expectedWidth)&&inside(m.page,viewport)&&m.canvas.width>0&&close(m.canvas.width,m.page.width));
 }else if(rel.endsWith('.png')){
  const host=document.querySelector('#image-host'),page=host?.querySelector('.image-page'),canvas=page?.querySelector('canvas');m.host=box(host);m.page=box(page);m.canvas=box(canvas);m.fit=document.querySelector('#image-fit')?.getAttribute('aria-pressed')==='true';m.natural={width:canvas?.width,height:canvas?.height};
  const scale=canvas?Math.max(.01,m.fit?Math.min((scroll.clientWidth-34)/canvas.width,(scroll.clientHeight-34)/canvas.height,1):1):0;m.expected={width:canvas?.width*scale,height:canvas?.height*scale};
  m.valid=Boolean(canvas?.width&&m.page&&close(m.page.width,m.expected.width)&&close(m.page.height,m.expected.height)&&(!m.fit||(inside(m.page,viewport)&&m.page.height<=scroll.clientHeight)));
 }else if(/\.(xlsx|pptx|docx)$/.test(rel)){
  const host=document.querySelector('#word-host'),frame=host?.querySelector('iframe'),doc=frame?.contentDocument,win=frame?.contentWindow;m.host=box(host);m.frame=box(frame);m.frameViewport=win&&{width:win.innerWidth,height:win.innerHeight};
  if(!doc||!m.frame||!m.host)return m;
  m.valid=close(m.frame.width,m.host.width)&&close(win.innerWidth,frame.clientWidth)&&close(win.innerHeight,frame.clientHeight)&&inside(m.frame,viewport)&&m.frame.height>0&&m.frame.bottom<=viewport.bottom+3;
  if(rel.endsWith('.xlsx')){
   const sheet=doc.querySelector('#sheet'),paint=doc.querySelector('.fortune-sheet-canvas'),container=doc.querySelector('.fortune-sheet-container'),editor=win.nozeliSheetEditor;
   m.sheet=box(sheet);m.paint=box(paint);m.paintContainer=box(container);
   if(!editor||!paint||!sheet||!container){m.valid=false;return m;}
   if(sheet.inert||editor.getCellValue(3,1)!==30){m.valid=false;m.readiness={inert:sheet.inert,formulaValue:editor.getCellValue(3,1)};return m;}
   if(!win.__geometrySheetSelectionSet){editor.setSelection([{row:[1,2],column:[0,1]}]);win.__geometrySheetSelectionSet=true;m.valid=false;return m;}
   let sheets;try{sheets=win.nozeliSheetModels.snapshotModel();}catch{m.valid=false;return m;}
   // Fortune lazily materializes inactive sheets and grows its runtime matrix.
   // Coordinates + formula (or literal value) define the logical workbook.
   const content=sheets.map(s=>{
    const cells=[],add=(r,c,cell)=>{if(!cell)return;if(cell.f)cells.push({r,c,f:cell.f});else if(cell.v!==undefined&&cell.v!==null&&cell.v!=='')cells.push({r,c,v:cell.v});};
    if(s.data)s.data.forEach((row,r)=>row?.forEach((cell,c)=>add(r,c,cell)));else for(const cell of s.celldata||[])add(cell.r,cell.c,cell.v);
    cells.sort((a,b)=>a.r-b.r||a.c-b.c);return {id:s.id,name:s.name,cells};
   });
   const ranges=(editor.getSelection()||[]).map(range=>({row:[...range.row],column:[...range.column]})),current=editor.getSheet(),saved=current.luckysheet_select_save?.at(-1),last=ranges.at(-1);
   const selection={sheetId:current.id,ranges,focus:last?{row:saved?.row_focus??last.row[0],column:saved?.column_focus??last.column[0]}:null};
   if(!win.__geometrySheet)win.__geometrySheet={editor,frame,content:structuredClone(content),selection:structuredClone(selection)};
   m.preservation={sameImperativeHandle:win.__geometrySheet.editor===editor,sameIframe:win.__geometrySheet.frame===frame,content:JSON.stringify(win.__geometrySheet.content)===JSON.stringify(content),selection:JSON.stringify(win.__geometrySheet.selection)===JSON.stringify(selection)};
   // React may refresh the imperative handle without replacing the workbook.
   m.preserved=m.preservation.sameIframe&&m.preservation.content&&m.preservation.selection;
   if(!m.preserved)m.mismatch={expectedContent:win.__geometrySheet.content,actualContent:content,expectedSelection:win.__geometrySheet.selection,actualSelection:selection};
   m.valid=m.valid&&m.preserved&&close(m.sheet.width,win.innerWidth)&&close(m.paint.width,m.paintContainer.width)&&m.paint.height>0&&m.paint.height<=m.sheet.height+3&&m.paintContainer.right<=m.sheet.right+3;
  }else if(rel.endsWith('.pptx')){
   const engine=win.__nozeliPptist,editor=doc.querySelector('.pptist-editor'),canvas=doc.querySelector('.canvas'),slide=doc.querySelector('.canvas .viewport-wrapper');m.editor=box(editor);m.paint=box(canvas);m.slide=box(slide);
   if(!engine?.ready||engine.busy()||!engine.store.slides.length||!m.slide||!m.paint){m.valid=false;return m;}
   const content=JSON.stringify(engine.store.slides),selection=JSON.stringify([engine.store.slideIndex,engine.main.activeElementIdList]);if(!win.__geometryPpt)win.__geometryPpt={engine,content,selection};
   m.preserved=win.__geometryPpt.engine===engine&&win.__geometryPpt.content===content&&win.__geometryPpt.selection===selection;m.canvasPercentage=engine.main.canvasPercentage;
   m.valid=m.valid&&m.preserved&&close(m.editor.width,win.innerWidth)&&close(m.editor.height,win.innerHeight)&&m.paint.width>0&&m.paint.height>0&&m.paint.right<=win.innerWidth+3&&m.paint.bottom<=win.innerHeight+3;
   if(m.canvasPercentage<=100)m.valid=m.valid&&inside(m.slide,m.paint)&&m.slide.y>=m.paint.y-3&&m.slide.bottom<=m.paint.bottom+3;
  }
 }else{
  const host=document.querySelector('#text-host'),preview=document.querySelector('#text-preview'),previewScroll=document.querySelector('#markdown-preview-scroll'),editor=host?.querySelector('.monaco-editor,.cm-editor');m.host=box(host);m.editor=box(editor);m.preview=visible(preview)?box(preview):null;m.previewScroll=visible(previewScroll)?box(previewScroll):null;
  const text=window.__nozeliInput?.text(),selection=JSON.stringify(window.__nozeliInput?.selection());if(!window.__geometryText)window.__geometryText={text,selection};m.preserved=__geometryText.text===text&&__geometryText.selection===selection;
  m.valid=m.preserved&&Boolean(editor)&&close(m.editor.width,m.host.width)&&m.editor.height>0&&inside(m.editor,viewport);
  if(m.previewScroll)m.valid=m.valid&&m.preview.width>0&&inside(m.preview,m.previewScroll)&&m.previewScroll.right<=viewport.right+3&&preview.textContent.includes('Paragraph 99:');
 }
 return m;
}
