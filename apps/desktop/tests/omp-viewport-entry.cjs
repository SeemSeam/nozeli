// Test-only owned-window action; invokes real Electron zoom, not CDP metrics.
const fs=require('node:fs');
const path=require('node:path');
const {app}=require('electron');
app.on('browser-window-created',(_event,win)=>{
 const file=path.join(process.env.NOZELI_USER_DATA,'viewport-zoom');
 const timer=setInterval(()=>{try{const factor=Number(fs.readFileSync(file,'utf8'));if(factor>0&&win.webContents.getZoomFactor()!==factor)win.webContents.setZoomFactor(factor);}catch{}},100);
 win.on('closed',()=>clearInterval(timer));
});
require('../src/main/main.cjs');
