import {randomUUID,createHash} from 'node:crypto';
import {captureLayout,CAPTURE_PIXELS} from '../domain/workspace-capture.mjs';
import {WorkspaceCaptureStore} from './workspace-capture-store.mjs';
import {captureOutput} from '../domain/capture-sources.mjs';

export class WorkspaceCapture {
  constructor({workspace,WebContentsView,origin,preload,directory,host,deliver}){Object.assign(this,{workspace,WebContentsView,origin,preload,directory,host,deliver});this.active=null;this.sourceRequests=new Map();this.store=new WorkspaceCaptureStore({directory});}
  async begin(owner,payload={}){
    if(this.preparing)throw Error('正在冻结工作面，请稍候');
    this.preparing=true;
    try{return await this.prepare(owner,payload);}finally{this.preparing=false;if(!this.active){delete this.workspace.captureProjectId;this.workspace.broadcast('nozeli:workspace-control',{type:'capture-input',held:false},owner.projectId);}}
  }
  async prepare(owner,payload={}){
    if(this.active){if(this.active.projectId!==owner.projectId)throw Error('另一项目正在涂鸦，请先完成或退出');this.active.window.win.show();this.active.view.webContents.focus();return {captureId:this.active.id};}
    if(!owner.projectId)throw Error('请先打开项目');
    const roots=[...this.workspace.windows.values()].filter(r=>!r.dead&&r.projectId===owner.projectId);
    if(roots.some(r=>r.staging||r.win.isMinimized()||r.projectHidden||!r.win.isVisible()))throw Error('请先恢复当前项目的全部窗口再开始涂鸦；没有静默忽略隐藏窗口');
    if(this.workspace.projectRecords(owner.projectId).some(s=>s.transferring||s.recoveryHeld||!s.ready))throw Error('内容正在加载或迁移，请稍后开始涂鸦');
    for(const root of roots){const blocked=await root.wc.executeJavaScript(`Boolean(document.querySelector('#settings-dialog[open],#configuration-setup[open],input[type="password"]:not([hidden])')?.getClientRects().length)`);if(blocked)throw Error('请先关闭设置或认证界面再截图');}
    this.workspace.captureProjectId=owner.projectId;
    this.workspace.broadcast('nozeli:workspace-control',{type:'capture-input',held:true},owner.projectId);
    for(const scope of this.workspace.senders.values())if(scope.projectId===owner.projectId&&!scope.dead)await scope.wc.executeJavaScript(`(()=>{const app=document.getElementById('app');if(app)app.inert=true;return true})()`);
    const sourceSelection=payload.sourceSelection??null;
    const recovered=payload.recoverId?await this.store.load(payload.recoverId,owner.projectId):null;
    const id=payload.recoverId??randomUUID(),tiles=[],sources=[];let pixels=0;
    for(const root of recovered?[]:roots){
      const [width,height]=root.win.getContentSize();pixels+=width*height;if(pixels>CAPTURE_PIXELS)throw Error('窗口像素超过预算，请关闭不需要的窗口后重试');
      const revision=(await this.workspace.layout(owner.projectId)).revision;
      const layers=[];
      for(const view of root.win.contentView.children){
        if(!view.getVisible()||!view.webContents||view.webContents.isDestroyed())continue;
        const bounds=view.getBounds();if(bounds.width<=0||bounds.height<=0)continue;
        const scope=this.workspace.senders.get(view.webContents.id);
        const slot=[...(this.workspace.isolatedPreview?.slots.values()??[])].find(s=>s.view===view);
        const surface=scope?.role==='surface'?scope:slot?.scope;
        let source=null;
        if(surface){
          const receipt=await this.describe(surface);
          source={sourceId:surface.viewId,projectId:surface.projectId,viewId:surface.viewId,kind:surface.kind,relPath:surface.relPath??null,locationStatus:'viewport-only',bounds,...receipt?.sources?.[0]};
          if(slot?.profile==='staticReport'){source.identity={projectId:surface.projectId,resource:{kind:'report',objectId:slot.source?.objectId??slot.manifest?.objectId??null,digest:slot.files.get(slot.entry)?.digest},version:{kind:'material',digest:slot.files.get(slot.entry)?.digest}};source.version=source.identity.version;source.locationStatus='viewport-only';source.summary='冻结报告 · '+source.version.digest;}
          sources.push(source);
        }
        const image=await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});if(image.isEmpty())throw Error('窗口图像不可读取，未生成不完整截图');
        if(surface&&!slot){const after=await this.describe(surface);const strip=value=>({identity:value.identity,viewport:value.viewport,selection:value.selection,generation:value.generation});if(JSON.stringify(strip(after.sources?.[0]??{}))!==JSON.stringify(strip(source)))throw Error('截图期间文件版本或视口改变，请重试');}
        if(root.dead||view.webContents.isDestroyed()||JSON.stringify(view.getBounds())!==JSON.stringify(bounds)||(await this.workspace.layout(owner.projectId)).revision!==revision)throw Error('捕获期间工作面改变，请重试');
        layers.push({bounds,dataUrl:image.toDataURL(),source});
      }
      const windowBounds=root.win.getBounds(),display=this.workspace.screen.getDisplayMatching(windowBounds);
      tiles.push({id:root.windowId,title:root.win.getTitle(),width,height,layers,displayId:String(display.id),displayBounds:display.bounds,windowBounds});
    }
    const layout=recovered?{tiles:recovered.tiles,width:recovered.width,height:recovered.height}:captureLayout(tiles);const root=this.workspace.windows.get(owner.windowId)||this.workspace.shell;
    const view=new this.WebContentsView({webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,preload:this.preload}});
    const session={id,projectId:owner.projectId,window:root,view,tiles:layout.tiles,width:layout.width,height:layout.height,sources:recovered?.sources??sources,recovered,sourceSelection,createdAt:recovered?.createdAt??new Date().toISOString(),ownerGeneration:owner.generation};
    this.active=session;root.captureSession=id;root.win.captureOverlay=view;this.workspace.captureProjectId=owner.projectId;
    if(!recovered)try{await this.store.saveFrozen({id,projectId:session.projectId,createdAt:session.createdAt,state:'frozen',tiles:session.tiles,width:session.width,height:session.height,sources:session.sources,ownerGeneration:session.ownerGeneration});}catch(error){this.active=null;delete root.captureSession;delete root.win.captureOverlay;delete this.workspace.captureProjectId;view.webContents.close({waitForBeforeUnload:false});throw error;}
    view.webContents.setWindowOpenHandler(()=>({action:'deny'}));view.webContents.on('will-navigate',(e,url)=>{if(url!==this.origin+'capture.html')e.preventDefault();});
    root.win.contentView.addChildView(view);this.resize(session);session.resize=()=>this.resize(session);root.win.on('resize',session.resize);
    view.webContents.once('destroyed',()=>{if(this.active===session)this.remove(session);});
    try{await view.webContents.loadURL(this.origin+'capture.html');root.win.show();view.webContents.focus();return {captureId:id};}catch(error){this.remove(session);throw error;}
  }
  describe(surface){
    const requestId=randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.sourceRequests.delete(requestId);reject(Error('来源读取超时，未冻结不明版本'));},5000);
      this.sourceRequests.set(requestId,{surface,generation:surface.generation,resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      surface.wc.send('nozeli:workspace-control',{type:'capture-source-request',requestId,projectId:surface.projectId,viewId:surface.viewId});
    });
  }
  source(surface,p){const request=this.sourceRequests.get(p.requestId);if(!request||request.surface!==surface||request.generation!==surface.generation)throw Error('来源回执失效');this.sourceRequests.delete(p.requestId);if(p.error)request.reject(Error(p.error.message??p.error));else request.resolve(p);return {accepted:true};}
  resize(s){if(!s.window.win.isDestroyed()){const [width,height]=s.window.win.getContentSize();s.view.setBounds({x:0,y:0,width,height});}}
  authorized(event){return this.active&&event.sender===this.active.view.webContents&&event.senderFrame===event.sender.mainFrame&&event.senderFrame.url===this.origin+'capture.html';}
  async invoke(event,op,p={}){
    if(!this.authorized(event))throw Error('涂鸦权限无效');const s=this.active;
    if(op==='read')return {id:s.id,projectId:s.projectId,tiles:s.tiles,width:s.width,height:s.height,drawingDraft:s.recovered?.drawingDraft,recoverable:await this.store.listRecoverable(s.projectId)};
    if(op==='discard'){if(p.id===s.id)throw Error('当前画面请先退出后再删除恢复记录');return this.store.discard(p.id,s.projectId);}
    if(op==='recover'){const record=await this.store.load(p.id,s.projectId);const id=record.result?randomUUID():record.id;if(record.result)await this.store.saveFrozen({...record,id,createdAt:new Date().toISOString(),drawingDraft:undefined,result:undefined});s.id=id;s.tiles=record.tiles;s.width=record.width;s.height=record.height;s.sources=record.sources??[];s.recovered=record;return {id:s.id,projectId:s.projectId,tiles:s.tiles,width:s.width,height:s.height,drawingDraft:record.drawingDraft};}
    if(op==='save')return this.store.saveDrawing(s.id,s.projectId,p);
    if(op==='cancel'){this.remove(s);return {cancelled:true};}
    if(op==='commit'){
      if(s.committing)throw Error('正在保存');s.committing=true;
      try{
        const bytes=Buffer.from(String(p.png??'').replace(/^data:image\/png;base64,/,''),'base64');if(!bytes.length||bytes.length>8*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('截图为空、格式错误或超过8MiB');
        const output=captureOutput(s,p),sources=output.sources;
        if(bytes.length<24||bytes.readUInt32BE(16)!==output.crop.width||bytes.readUInt32BE(20)!==output.crop.height)throw Error('截图尺寸与已选择范围不一致');
        const stored=await this.host.attachMaterial({name:'drawing-'+s.id+'.png',mime:'image/png',source:'drawing',size:bytes.length,bytes:bytes.toString('base64')});
        const attachment={...stored,kind:'image',source:'drawing',sources};
        const result={id:s.id,projectId:s.projectId,attachment,sources,state:p.local?'local':'pending-delivery',drawing:p.drawing,crop:p.crop};
        await this.store.saveDrawing(s.id,s.projectId,{drawing:p.drawing,target:p.target??s.recovered?.drawingDraft?.target});
        await this.store.saveResult(s.id,s.projectId,result);
        if(!p.local){await this.deliver(s,{type:'drawing-material',projectId:s.projectId,target:'frontdesk',deliveryId:s.id,attachment,sources});await this.store.saveResult(s.id,s.projectId,{...result,state:'delivered'});}
        setImmediate(()=>this.remove(s));return {saved:true,attached:!p.local};
      }finally{s.committing=false;}
    }
    throw Error('未知涂鸦操作');
  }
  async shutdown(){const s=this.active;if(!s)return;if(s.committing)throw Error('正在保存涂鸦，请稍后退出');if(!s.view.webContents.isDestroyed())await s.view.webContents.executeJavaScript('window.__captureFlush?.()');this.remove(s);}
  remove(s){if(this.active!==s)return;this.active=null;delete this.workspace.captureProjectId;delete s.window.captureSession;delete s.window.win.captureOverlay;this.workspace.broadcast('nozeli:workspace-control',{type:'capture-input',held:false},s.projectId);if(s.resize)s.window.win.removeListener('resize',s.resize);if(!s.window.win.isDestroyed())s.window.win.contentView.removeChildView(s.view);if(!s.view.webContents.isDestroyed())s.view.webContents.close({waitForBeforeUnload:false});const layout=this.workspace.layouts.get(s.projectId);if(layout)this.workspace.changed(layout);}
}
