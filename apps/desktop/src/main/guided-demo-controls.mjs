const fail=(message)=>Object.assign(Error(message),{code:'DEMO_CONTROLS_DENIED'});
const controlsUrl=workspace=>workspace.origin+'guided-demo-controls.html';

// Presentation only. The shell remains the sole playback/operation authority.
export class GuidedDemoControls {
  constructor(workspace){this.workspace=workspace;this.record=null;this.owner=null;this.model=null;this.position=null;this.height=142;}
  owns(record){return Boolean(record&&record===this.record&&!record.dead);}
  allowed(op){return ['workspace.bootstrap','workspace.demoControls.ready','workspace.demoControls.action','workspace.demoControls.size','workspace.demoControls.drag'].includes(op);}
  ownerValid(){return Boolean(this.owner&&this.owner===this.workspace.shell&&!this.owner.dead&&this.owner.generation===this.ownerGeneration);}
  state(){return {role:'demo-controls',windowId:'main',projectId:null,model:this.model,bounds:this.record?.view.getBounds()??null,visible:this.record?.view.getVisible()??false,availableHeight:this.owner&&!this.owner.win.isDestroyed()?this.owner.win.getContentSize()[1]-16:0};}
  ensure(){
    if(this.record&&!this.record.dead)return;
    const owner=this.owner;if(!owner||owner.win.isDestroyed())throw fail('主工作区不可用');
    const view=new this.workspace.WebContentsView({webPreferences:this.workspace.preferences});
    view.setBackgroundColor('#00000000');view.setVisible(false);
    const record=this.workspace.register(view.webContents,{role:'demo-controls',windowId:'main',projectId:null,win:owner.win,view});
    this.record=record;
    this.readyPromise=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});this.readyPromise.catch(()=>{});
    owner.win.contentView.addChildView(view);
    record.wc.on('did-fail-load',(_event,code,message,_url,main)=>{if(main)this.failed(record,Error('演示控制区加载失败：'+message+' ('+code+')'));});
    void record.wc.loadURL(controlsUrl(this.workspace)).catch(error=>this.failed(record,error));
    if(this.watchedWindow!==owner.win){
      this.watchedWindow=owner.win;
      owner.win.on('resize',()=>this.raise());owner.win.once('closed',()=>this.dispose());
    }
    this.raise();
  }
  update(owner,model){
    if(owner!==this.workspace.shell||owner.dead)throw fail('只有主窗可以更新演示控制区');
    if(model!==null&&(!model||Array.isArray(model)||typeof model.sessionId!=='string'||!Number.isSafeInteger(model.epoch)||!Array.isArray(model.buttons)||!Array.isArray(model.chapters)||Buffer.byteLength(JSON.stringify(model))>32768))throw fail('控制区状态无效');
    this.owner=owner;this.ownerGeneration=owner.generation;this.model=model;
    if(model)this.ensure();
    this.push();this.raise();return {updated:true};
  }
  push(){if(this.record?.ready&&!this.record.dead)this.record.wc.send('nozeli:workspace-control',{type:'demo-controls-state',...this.state()});}
  raise(){
    const record=this.record;if(!record||record.dead||record.win.isDestroyed())return;
    const before=record.view.getBounds();
    const [width,height]=record.win.getContentSize(),margin=8;
    const panelWidth=Math.max(1,Math.min(448,width-margin*2)),panelHeight=Math.max(1,Math.min(this.height,height-margin*2));
    const x=Math.round(Math.max(margin,Math.min(this.position?.x??width-panelWidth-16,width-panelWidth-margin)));
    const y=Math.round(Math.max(margin,Math.min(this.position?.y??height-panelHeight-16,height-panelHeight-margin)));
    record.view.setBounds({x,y,width:panelWidth,height:panelHeight});
    if(record.ready&&(before.x!==x||before.y!==y||before.width!==panelWidth||before.height!==panelHeight))record.wc.send('nozeli:workspace-control',{type:'demo-controls-bounds',bounds:record.view.getBounds(),availableHeight:height-16});
    record.win.contentView.addChildView(record.view);
    record.view.setVisible(Boolean(this.model?.visible&&record.ready&&this.ownerValid()&&this.owner.ready));
  }
  async readyForPlay(owner,sessionId){
    if(owner!==this.owner||!this.ownerValid()||this.model?.sessionId!==sessionId)throw fail('演示窗口身份已变化');
    this.ensure();if(this.record.ready)return {ready:true};
    let timer;try{await Promise.race([this.readyPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('演示控制区尚未就绪，未开始播放')),10000);})]);}finally{clearTimeout(timer);}
    if(!this.ownerValid()||this.model?.sessionId!==sessionId)throw fail('演示窗口身份已变化');return {ready:true};
  }
  invoke(record,op,payload){
    if(!this.owns(record))throw fail('控制区已关闭');
    if(op==='workspace.bootstrap')return this.state();
    if(op==='workspace.demoControls.ready'){record.wc.setBackgroundThrottling(false);record.ready=true;this.readyResolve?.();this.push();this.raise();return this.state();}
    if(!this.ownerValid()||!this.owner.ready)throw fail('原主窗口已变化');
    if(op==='workspace.demoControls.size'){
      if(!Number.isFinite(payload.height)||payload.height<1||payload.height>1200)throw fail('控制区尺寸无效');
      this.height=Math.ceil(payload.height);this.raise();return {bounds:record.view.getBounds()};
    }
    if(op==='workspace.demoControls.drag'){
      if(!Number.isFinite(payload.x)||!Number.isFinite(payload.y)||Math.abs(payload.x)>1e7||Math.abs(payload.y)>1e7)throw fail('控制区位置无效');
      this.position={x:payload.x,y:payload.y};this.raise();return {bounds:record.view.getBounds()};
    }
    if(op==='workspace.demoControls.action'){
      const model=this.model,safe=payload.controlId==='stop'||payload.controlId==='play'&&payload.intent==='pause';
      if(!model||payload.sessionId!==model.sessionId||payload.epoch!==model.epoch&&!safe)throw fail('演示状态已变化，请使用当前控制区');
      if(!model.visible&&!safe)throw fail('请先关闭当前模态界面');
      const button=model.buttons.find(button=>button.id===payload.controlId);
      if(payload.controlId==='chapter'){if(model.chapterDisabled||!model.chapters.some(chapter=>chapter.id===payload.chapterId))throw fail('章节不可用');}
      else if(!button||button.disabled&&!safe)throw fail('此操作尚不可用');
      if(payload.controlId==='play'&&!['pause','play'].includes(payload.intent))throw fail('播放操作无效');
      this.owner.wc.send('nozeli:workspace-control',{type:'demo-controls-action',sessionId:model.sessionId,epoch:model.epoch,controlId:payload.controlId,intent:payload.intent,chapterId:payload.chapterId});
      return {queued:true};
    }
    throw fail('控制区没有此权限');
  }
  reloading(record){
    if(record!==this.record)return;
    this.readyPromise=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});this.readyPromise.catch(()=>{});
    if(this.model?.projectId)void this.workspace.guidedDemo?.pauseProject(this.model.projectId,'控制区重载，演示暂停。').catch(this.workspace.onError);
  }
  failed(record,error){
    if(record!==this.record)return;
    this.readyReject?.(error);record.dead=true;record.view.setVisible(false);this.workspace.senders.delete(record.wc.id);
    if(!record.win.isDestroyed())record.win.contentView.removeChildView(record.view);
    if(!record.wc.isDestroyed())record.wc.close();this.record=null;
    const projectId=this.model?.projectId;
    if(projectId)void this.workspace.guidedDemo?.pauseProject(projectId,'演示控制区不可用，已暂停。').catch(this.workspace.onError);
    this.workspace.onError(error);
  }
  dispose(){
    const record=this.record;this.record=null;this.readyReject?.(fail('演示窗口已关闭'));
    if(this.model?.projectId)void this.workspace.guidedDemo?.pauseProject(this.model.projectId,'主窗口已关闭，演示暂停。').catch(this.workspace.onError);
    this.model=null;this.owner=null;
    if(record){record.dead=true;this.workspace.senders.delete(record.wc.id);if(!record.wc.isDestroyed())record.wc.close();}
  }
}
