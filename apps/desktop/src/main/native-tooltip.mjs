import path from 'node:path';

const fail=(code,message=code)=>Object.assign(new Error(message),{code});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const idValid=id=>typeof id==='string'&&id.length>0&&id.length<=160;
// Only numeric CSS colors: no URLs, variables, declarations or executable markup.
const colorValid=value=>typeof value==='string'&&value.length<=96&&(/^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8})$/i.test(value)||/^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%,\s/+\-]+\)$/i.test(value));
const inside=(point,rect)=>point.x>=rect.x&&point.y>=rect.y&&point.x<=rect.x+rect.width&&point.y<=rect.y+rect.height;

export class NativeTooltip {
  constructor({workspace,BrowserWindow,screen,appRoot}){Object.assign(this,{workspace,BrowserWindow,screen,appRoot});this.rows=new Map();}
  authorize(scope){
    if(!['shell','detached'].includes(scope.role)&&!(scope.role==='surface'&&['document','conversation','task-process','terminal','project-terminal'].includes(scope.kind)))throw fail('IPC_DENIED');
  }
  closeWindow(win){const row=this.rows.get(win);if(!row)return;this.rows.delete(win);clearInterval(row.timer);clearTimeout(row.timeout);row.resolve?.({supported:true,shown:false});for(const [event,handler]of row.listeners)win.removeListener(event,handler);if(!row.bubble.isDestroyed())row.bubble.destroy();}
  closeScope(scope){for(const [win,row]of this.rows)if(row.scope===scope||(['shell','detached'].includes(scope.role)&&scope.win===win))this.closeWindow(win);}
  hide(scope,payload){
    this.authorize(scope);if(!object(payload)||!idValid(payload.id)||Object.keys(payload).some(k=>k!=='id'))throw fail('INVALID_PAYLOAD');
    const row=this.rows.get(scope.win),hidden=!!row&&row.scope===scope&&row.id===payload.id;
    if(hidden)this.closeWindow(scope.win);return {supported:true,hidden};
  }
  available(scope){
    const win=scope.win,root=this.workspace.windows.get(scope.windowId);
    return !scope.dead&&!scope.transferring&&!win.isDestroyed()&&win.isVisible()&&!win.isMinimized()&&win.isFocused()&&win.isEnabled()&&root&&!root.dead&&root.projectId===scope.projectId&&(scope.role!=='surface'||scope.view.getVisible())&&!win.getChildWindows().some(child=>!child.isDestroyed()&&child.isVisible()&&child.isModal());
  }
  async show(scope,payload){
    this.authorize(scope);
    if(!object(payload)||Object.keys(payload).some(k=>!['id','text','rect','anchorRect','appearance'].includes(k))||!idValid(payload.id)||typeof payload.text!=='string'||!payload.text.trim()||payload.text.length>2048)throw fail('INVALID_PAYLOAD');
    const {rect,anchorRect,appearance}=payload;
    for(const bounds of anchorRect===undefined?[rect]:[rect,anchorRect])if(!object(bounds)||Object.keys(bounds).some(k=>!['x','y','width','height'].includes(k))||!['x','y','width','height'].every(k=>Number.isFinite(bounds[k])&&Math.abs(bounds[k])<=100000)||bounds.width<=0||bounds.height<=0)throw fail('INVALID_PAYLOAD');
    if(!object(appearance)||Object.keys(appearance).some(k=>!['background','color','border','fontSize'].includes(k))||!['background','color','border'].every(k=>colorValid(appearance[k]))||appearance.fontSize!==undefined&&(!Number.isFinite(appearance.fontSize)||appearance.fontSize<9||appearance.fontSize>32))throw fail('INVALID_PAYLOAD');
    const win=scope.win;this.closeWindow(win);
    if(!this.available(scope))return {supported:true,shown:false};
    // Renderer DOM rectangles are CSS pixels; native view/content bounds are DIP.
    const zoom=scope.wc.getZoomFactor(),offset=scope.role==='surface'?scope.view.getBounds():{x:0,y:0},client=win.getContentBounds();
    const viewport=scope.role==='surface'?scope.view.getBounds():{width:client.width,height:client.height};
    if(anchorRect&&(anchorRect.x*zoom<0||anchorRect.y*zoom<0||(anchorRect.x+anchorRect.width)*zoom>viewport.width+1||(anchorRect.y+anchorRect.height)*zoom>viewport.height+1))return {supported:true,shown:false};
    const toScreen=bounds=>({x:client.x+offset.x+bounds.x*zoom,y:client.y+offset.y+bounds.y*zoom,width:bounds.width*zoom,height:bounds.height*zoom});
    // rect already describes the renderer's final bubble position, not its trigger.
    const bubbleDesired=toScreen(rect),trigger=anchorRect?toScreen(anchorRect):null;
    const area=this.screen.getDisplayMatching(bubbleDesired).workArea;
    const maxWidth=Math.max(1,Math.min(360,area.width,client.width)),maxHeight=Math.max(1,Math.min(240,area.height,client.height));
    const bubble=new this.BrowserWindow({parent:win,type:'tooltip',show:false,frame:false,transparent:true,hasShadow:false,focusable:false,skipTaskbar:true,resizable:false,movable:false,minimizable:false,maximizable:false,fullscreenable:false,width:maxWidth,height:1,webPreferences:{preload:path.join(this.appRoot,'src/preload/native-tooltip.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,devTools:false}});
    bubble.setMenu(null);bubble.setIgnoreMouseEvents(true);bubble.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    bubble.webContents.on('will-navigate',event=>event.preventDefault());bubble.webContents.on('will-redirect',event=>event.preventDefault());bubble.webContents.on('will-attach-webview',event=>event.preventDefault());
    const row={scope,id:payload.id,bubble,generation:scope.generation,projectId:scope.projectId,windowId:scope.windowId,listeners:[],cursor:this.screen.getCursorScreenPoint(),viewBounds:scope.role==='surface'?JSON.stringify(scope.view.getBounds()):null};
    this.rows.set(win,row);
    const close=()=>this.closeWindow(win);
    for(const event of ['closed','hide','blur','minimize','move','resize']){row.listeners.push([event,close]);win.on(event,close);}
    row.timer=setInterval(()=>{
      if(!this.available(scope)||scope.generation!==row.generation||scope.projectId!==row.projectId||scope.windowId!==row.windowId||scope.role==='surface'&&JSON.stringify(scope.view.getBounds())!==row.viewBounds){close();return;}
      const cursor=this.screen.getCursorScreenPoint();
      if(trigger&&(cursor.x!==row.cursor.x||cursor.y!==row.cursor.y)&&!inside(cursor,trigger)){close();return;}row.cursor=cursor;
    },80);row.timer.unref?.();
    const result=new Promise(resolve=>{row.resolve=resolve;row.timeout=setTimeout(close,3000);});
    bubble.webContents.on('render-process-gone',close);
    bubble.webContents.on('ipc-message',(_event,channel,...args)=>{
      if(channel!=='nozeli:tooltip-size'||this.rows.get(win)!==row)return;
      const size=args[0];if(!object(size)||!Number.isFinite(size.width)||!Number.isFinite(size.height))return;
      if(!this.available(scope)){close();return;}
      const width=Math.max(1,Math.min(maxWidth,Math.ceil(size.width))),height=Math.max(1,Math.min(maxHeight,Math.ceil(size.height)));
      const x=Math.round(Math.max(area.x,Math.min(area.x+area.width-width,bubbleDesired.x)));
      const y=Math.round(Math.max(area.y,Math.min(area.y+area.height-height,bubbleDesired.y)));
      bubble.setBounds({x,y,width,height});bubble.showInactive();clearTimeout(row.timeout);row.resolve?.({supported:true,shown:true});row.resolve=null;
    });
    try{await bubble.loadFile(path.join(this.appRoot,'dist/renderer/native-tooltip.html'));if(this.rows.get(win)===row)bubble.webContents.send('nozeli:tooltip-content',{text:payload.text,appearance:{...appearance,fontSize:(appearance.fontSize??12)*zoom},maxWidth,maxHeight});}
    catch{if(this.rows.get(win)===row)close();}
    return result;
  }
}
