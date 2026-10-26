const fail=(message)=>Object.assign(Error(message),{code:'DEMO_CONTROLS_DENIED'});
const controlsUrl=workspace=>workspace.origin+'guided-demo-controls.html';
const hintUrl=workspace=>workspace.origin+'guided-demo-hint.html';

// Presentation only. The shell remains the sole playback/operation authority.
// Two native overlays: a compact control card and an always-on-top step hint.
export class GuidedDemoControls {
  constructor(workspace){this.workspace=workspace;this.record=null;this.owner=null;this.model=null;this.position=null;this.height=142;this.hintRecord=null;this.hint=null;this.hintHeight=120;}
  owns(record){return Boolean(record&&record===this.record&&!record.dead);}
  hintOwns(record){return Boolean(record&&record===this.hintRecord&&!record.dead);}
  allowed(op){return ['workspace.bootstrap','workspace.demoControls.ready','workspace.demoControls.action','workspace.demoControls.size','workspace.demoControls.drag'].includes(op);}
  hintAllowed(op){return ['workspace.bootstrap','workspace.demoHint.ready','workspace.demoHint.size','workspace.demoHint.dismiss'].includes(op);}
  ownerValid(){return Boolean(this.owner&&this.owner===this.workspace.shell&&!this.owner.dead&&this.owner.generation===this.ownerGeneration);}
  state(){return {role:'demo-controls',windowId:'main',projectId:null,model:this.model,bounds:this.record?.view.getBounds()??null,visible:this.record?.view.getVisible()??false,availableHeight:this.owner&&!this.owner.win.isDestroyed()?this.owner.win.getContentSize()[1]-16:0};}
  hintState(){return {role:'demo-hint',windowId:'main',projectId:null,model:this.hint,bounds:this.hintRecord?.view.getBounds()??null,visible:this.hintRecord?.view.getVisible()??false};}
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
      owner.win.on('resize',()=>{this.raise();this.hintRaise();});owner.win.once('closed',()=>this.dispose());
    }
    this.raise();
  }
  hintEnsure(){
    if(this.hintRecord&&!this.hintRecord.dead)return;
    const owner=this.owner;if(!owner||owner.win.isDestroyed())return;
    const view=new this.workspace.WebContentsView({webPreferences:this.workspace.preferences});
    view.setBackgroundColor('#00000000');view.setVisible(false);
    const record=this.workspace.register(view.webContents,{role:'demo-hint',windowId:'main',projectId:null,win:owner.win,view});
    this.hintRecord=record;
    owner.win.contentView.addChildView(view);
    record.wc.on('did-fail-load',(_event,code,message,_url,main)=>{if(main)this.hintFailed(record,Error('演示提示加载失败：'+message+' ('+code+')'));});
    void record.wc.loadURL(hintUrl(this.workspace)).catch(error=>this.hintFailed(record,error));
    this.hintRaise();
  }
  update(owner,model){
    if(owner!==this.workspace.shell||owner.dead)throw fail('只有主窗可以更新演示控制区');
    if(model!==null&&(!model||Array.isArray(model)||typeof model.sessionId!=='string'||!Number.isSafeInteger(model.epoch)||!Number.isSafeInteger(model.stepTotal)||model.stepTotal<1||!Array.isArray(model.buttons)||Buffer.byteLength(JSON.stringify(model))>32768))throw fail('控制区状态无效');
    this.owner=owner;this.ownerGeneration=owner.generation;this.model=model;
    if(model)this.ensure();
    this.push();this.raise();return {updated:true};
  }
  hintUpdate(owner,hint){
    if(owner!==this.workspace.shell||owner.dead)throw fail('只有主窗可以更新演示提示');
    if(hint!==null&&(!hint||Array.isArray(hint)||typeof hint.title!=='string'||typeof hint.detail!=='string'||typeof hint.visible!=='boolean'||hint.title.length>200||hint.detail.length>600))throw fail('演示提示状态无效');
    this.owner=owner;this.ownerGeneration=owner.generation;this.hint=hint;
    if(hint)this.hintEnsure();
    this.hintPush();this.hintRaise();return {updated:true};
  }
  push(){if(this.record?.ready&&!this.record.dead)this.record.wc.send('nozeli:workspace-control',{type:'demo-controls-state',...this.state()});}
  hintPush(){if(this.hintRecord?.ready&&!this.hintRecord.dead)this.hintRecord.wc.send('nozeli:workspace-control',{type:'demo-hint-state',hint:this.hint});}
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
    this.hintRaise();
  }
  hintRaise(){
    const record=this.hintRecord;if(!record||record.dead||record.win.isDestroyed())return;
    const [width,height]=record.win.getContentSize();
    const panelWidth=Math.max(1,Math.min(404,width-24)),panelHeight=Math.max(1,Math.min(this.hintHeight,height-64));
    record.view.setBounds({x:Math.round((width-panelWidth)/2),y:44,width:panelWidth,height:panelHeight});
    record.win.contentView.addChildView(record.view);
    record.view.setVisible(Boolean(this.hint?.visible&&record.ready&&this.ownerValid()&&this.owner.ready));
  }
  async readyForPlay(owner,sessionId){
    if(owner!==this.owner||!this.ownerValid()||this.model?.sessionId!==sessionId)throw fail('演示窗口身份已变化');
    this.ensure();if(this.record.ready)return {ready:true};
    let timer;try{await Promise.race([this.readyPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('演示控制区尚未就绪，未开始播放')),10000);})]);}finally{clearTimeout(timer);}
    if(!this.ownerValid()||this.model?.sessionId!==sessionId)throw fail('演示窗口身份已变化');return {ready:true};
  }
  async invoke(record,op,payload){
    if(this.hintOwns(record))return this.hintInvoke(record,op,payload);
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
      const model=this.model;
      if(payload.controlId==='seek'){
        if(!model||payload.sessionId!==model.sessionId)throw fail('演示状态已变化，请使用当前控制区');
        if(!Number.isSafeInteger(payload.stepIndex)||payload.stepIndex<0||payload.stepIndex>=model.stepTotal)throw fail('演示位置无效');
        // The published model copy can lag a just-committed transition; the
        // shell still enforces exact epoch equality, so forward the live one.
        const live=this.workspace.guidedDemo?await this.workspace.guidedDemo.state({projectId:model.projectId}):null;
        const epoch=live?.session?.id===model.sessionId?live.session.epoch:model.epoch;
        this.owner.wc.send('nozeli:workspace-control',{type:'demo-controls-action',sessionId:model.sessionId,epoch,controlId:'seek',stepIndex:payload.stepIndex,resume:payload.resume===true});
        return {queued:true};
      }
      const safe=payload.controlId==='stop'||payload.controlId==='play'&&payload.intent==='pause';
      if(!model||payload.sessionId!==model.sessionId||payload.epoch!==model.epoch&&!safe)throw fail('演示状态已变化，请使用当前控制区');
      if(!model.visible&&!safe)throw fail('请先关闭当前模态界面');
      const button=model.buttons.find(button=>button.id===payload.controlId);
      if(!button||button.disabled&&!safe)throw fail('此操作尚不可用');
      if(payload.controlId==='play'&&!['pause','play'].includes(payload.intent))throw fail('播放操作无效');
      this.owner.wc.send('nozeli:workspace-control',{type:'demo-controls-action',sessionId:model.sessionId,epoch:model.epoch,controlId:payload.controlId,intent:payload.intent,chapterId:payload.chapterId});
      return {queued:true};
    }
    throw fail('控制区没有此权限');
  }
  hintInvoke(record,op,payload){
    if(op==='workspace.bootstrap')return this.hintState();
    if(op==='workspace.demoHint.ready'){record.wc.setBackgroundThrottling(false);record.ready=true;this.hintPush();this.hintRaise();return this.hintState();}
    if(!this.ownerValid()||!this.owner.ready)throw fail('原主窗口已变化');
    if(op==='workspace.demoHint.size'){
      if(!Number.isFinite(payload.height)||payload.height<1||payload.height>600)throw fail('演示提示尺寸无效');
      this.hintHeight=Math.ceil(payload.height);this.hintRaise();return {bounds:record.view.getBounds()};
    }
    if(op==='workspace.demoHint.dismiss'){if(!this.hint?.visible||payload.key!==this.hint.key)throw fail('演示步骤已变化');this.owner.wc.send('nozeli:workspace-control',{type:'demo-hint-dismiss',key:this.hint.key});return {queued:true};}
    throw fail('演示提示没有此权限');
  }
  reloading(record){
    if(record===this.hintRecord)return;
    if(record!==this.record)return;
    this.readyPromise=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});this.readyPromise.catch(()=>{});
    if(this.model?.projectId)void this.workspace.guidedDemo?.pauseProject(this.model.projectId,'控制区重载，演示暂停。').catch(this.workspace.onError);
  }
  failed(record,error){
    if(record===this.hintRecord)return this.hintFailed(record,error);
    if(record!==this.record)return;
    this.readyReject?.(error);record.dead=true;record.view.setVisible(false);this.workspace.senders.delete(record.wc.id);
    if(!record.win.isDestroyed())record.win.contentView.removeChildView(record.view);
    if(!record.wc.isDestroyed())record.wc.close();this.record=null;
    const projectId=this.model?.projectId;
    if(projectId)void this.workspace.guidedDemo?.pauseProject(projectId,'演示控制区不可用，已暂停。').catch(this.workspace.onError);
    this.workspace.onError(error);
  }
  hintFailed(record,error){
    if(record!==this.hintRecord)return;
    record.dead=true;record.view.setVisible(false);this.workspace.senders.delete(record.wc.id);
    if(!record.win.isDestroyed())record.win.contentView.removeChildView(record.view);
    if(!record.wc.isDestroyed())record.wc.close();this.hintRecord=null;this.hint=null;
    this.workspace.onError(error);
  }
  dispose(){
    const record=this.record,hint=this.hintRecord;this.record=null;this.hintRecord=null;this.readyReject?.(fail('演示窗口已关闭'));
    if(this.model?.projectId)void this.workspace.guidedDemo?.pauseProject(this.model.projectId,'主窗口已关闭，演示暂停。').catch(this.workspace.onError);
    this.model=null;this.hint=null;this.owner=null;
    for(const item of [record,hint])if(item){item.dead=true;this.workspace.senders.delete(item.wc.id);if(!item.wc.isDestroyed())item.wc.close();}
  }
}
