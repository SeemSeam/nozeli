const {ipcRenderer}=require('electron');
// Read-only, host-pushed presentation. No product bridge or renderer API.
ipcRenderer.on('nozeli:tooltip-content',(_event,{text,appearance,maxWidth,maxHeight})=>{
  const bubble=document.getElementById('bubble');
  bubble.textContent=text;
  Object.assign(bubble.style,{backgroundColor:appearance.background,color:appearance.color,borderColor:appearance.border,fontSize:appearance.fontSize+'px',maxWidth:maxWidth+'px',maxHeight:maxHeight+'px'});
  const bounds=bubble.getBoundingClientRect();
  ipcRenderer.send('nozeli:tooltip-size',{width:bounds.width,height:bounds.height});
});
