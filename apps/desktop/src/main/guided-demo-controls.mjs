const fail=(message)=>Object.assign(Error(message),{code:'DEMO_CONTROLS_DENIED'});
const controlsUrl=workspace=>workspace.origin+'guided-demo-controls.html';
const hintUrl=workspace=>workspace.origin+'guided-demo-hint.html';
const clamp=(value,min,max)=>Math.round(Math.max(min,Math.min(value,max)));
const separated=(a,b,gap)=>a.x+a.width+gap<=b.x||b.x+b.width+gap<=a.x||a.y+a.height+gap<=b.y||b.y+b.height+gap<=a.y;

// Native view rectangles, including transparent padding, must never overlap.
// Preserve the requested drag point; move the hint first, then share scarce height.
export function guidedDemoOverlayLayout({width,height,controlsHeight,hintHeight,position,controlsVisible=true,hintVisible=true}){
  const margin=Math.min(8,Math.max(0,Math.floor((Math.min(width,height)-2)/4))),gap=Math.min(8,Math.max(0,height-2*margin-2));
  const usableWidth=Math.max(1,width-2*margin),usableHeight=Math.max(1,height-2*margin);
  const controls={width:Math.min(448,usableWidth),height:Math.min(controlsHeight,usableHeight)};
  controls.x=clamp(position?.x??width-controls.width-16,margin,width-controls.width-margin);
  controls.y=clamp(position?.y??height-controls.height-16,margin,height-controls.height-margin);
  const hint={width:Math.min(404,usableWidth),height:Math.min(hintHeight,usableHeight)};
  hint.x=clamp((width-hint.width)/2,margin,width-hint.width-margin);
  hint.y=clamp(44,margin,height-hint.height-margin);
  if(!controlsVisible||!hintVisible||separated(controls,hint,gap))return {controls,hint};
  const candidates=[
    {...hint,y:controls.y-hint.height-gap},
    {...hint,y:controls.y+controls.height+gap},
    {...hint,x:controls.x-hint.width-gap},
    {...hint,x:controls.x+controls.width+gap},
  ].filter(rect=>rect.x>=margin&&rect.y>=margin&&rect.x+rect.width<=width-margin&&rect.y+rect.height<=height-margin);
  if(candidates.length){
    candidates.sort((a,b)=>Math.abs(a.x-hint.x)+Math.abs(a.y-hint.y)-Math.abs(b.x-hint.x)-Math.abs(b.y-hint.y));
    return {controls,hint:candidates[0]};
  }
  const sharedHeight=usableHeight-gap;
  controls.height=Math.min(controls.height,Math.max(1,Math.floor(sharedHeight/2)));
  hint.height=Math.min(hint.height,Math.max(1,sharedHeight-controls.height));
  // Keep the controls on the dragged side of the hint in constrained windows.
  if(controls.y+controls.height/2<height/2){
    controls.y=clamp(controls.y,margin,height-margin-hint.height-gap-controls.height);
    hint.y=clamp(hint.y,controls.y+controls.height+gap,height-margin-hint.height);
  }else{
    hint.y=clamp(hint.y,margin,height-margin-controls.height-gap-hint.height);
    controls.y=clamp(controls.y,hint.y+hint.height+gap,height-margin-controls.height);
  }
  return {controls,hint};
}

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
      owner.win.on('resize',()=>this.raise());owner.win.once('closed',()=>this.dispose());
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
    if(!this.owner||this.owner.win.isDestroyed())return;
    const [width,height]=this.owner.win.getContentSize();
    const visible=record=>Boolean(record&&!record.dead&&record.ready&&this.ownerValid()&&this.owner.ready);
    const controlsVisible=Boolean(this.model?.visible&&visible(this.record)),hintVisible=Boolean(this.hint?.visible&&visible(this.hintRecord));
    const layout=guidedDemoOverlayLayout({width,height,controlsHeight:this.height,hintHeight:this.hintHeight,position:this.position,controlsVisible,hintVisible});
    for(const [record,bounds,shown] of [[this.record,layout.controls,controlsVisible],[this.hintRecord,layout.hint,hintVisible]]){
      if(!record||record.dead)continue;
      const before=record.view.getBounds();
      record.view.setBounds(bounds);
      if(record===this.record&&record.ready&&(before.x!==bounds.x||before.y!==bounds.y||before.width!==bounds.width||before.height!==bounds.height))record.wc.send('nozeli:workspace-control',{type:'demo-controls-bounds',bounds,availableHeight:bounds.height});
      record.win.contentView.addChildView(record.view);
      record.view.setVisible(shown);
    }
    const obstacles=[...(controlsVisible?[layout.controls]:[]),...(hintVisible?[layout.hint]:[])];
    for(const surface of this.workspace.surfaces?.values()??[]){
      if(surface.dead||!surface.ready||surface.win!==this.owner.win)continue;
      const origin=surface.view.getBounds(),zoom=surface.wc.getZoomFactor?.()||1;
      surface.wc.send('nozeli:workspace-control',{type:'demo-obstacles',rects:obstacles.map(rect=>({x:(rect.x-origin.x)/zoom,y:(rect.y-origin.y)/zoom,width:rect.width/zoom,height:rect.height/zoom}))});
    }
  }
  hintRaise(){this.raise();}
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
      // hintRaise clamps the view to the window; the report just has to be a
      // plausible positive height. A long detail in a narrow window can wrap
      // past 600 DIP — that is a honest measure, not an error.
      if(!Number.isFinite(payload.height)||payload.height<1||payload.height>4096)throw fail('演示提示尺寸无效');
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
