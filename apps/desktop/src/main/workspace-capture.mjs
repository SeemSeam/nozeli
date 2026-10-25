// Simplified workspace capture (2026-10-24 rework, see topics/selection-drawing.md):
// one initiating window, static viewport-only sources, bounded single-flight.
// No overlay WCV, no describe handshake, no project-wide input/write gating.
// Sessions are generation-bound to the initiating root renderer; every prepare
// runs under an operation token so timeout/cancel/shutdown truly invalidate
// late capture continuations. Each session owns its immutable capture store.
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {CAPTURE_PIXELS} from '../domain/workspace-capture.mjs';
import {captureOutput} from '../domain/capture-sources.mjs';
import {WorkspaceCaptureStore} from './workspace-capture-store.mjs';
import path from 'node:path';

const PREPARE_TIMEOUT_MS = 10000;
const invalidated=()=>Object.assign(new Error('涂鸦已取消、超时或入口已重新开始'),{code:'CAPTURE_INVALIDATED'});

export class WorkspaceCapture {
  constructor({workspace,host,deliver,prepareTimeoutMs=PREPARE_TIMEOUT_MS}){Object.assign(this,{workspace,host,deliver,prepareTimeoutMs});this.active=null;this.preparing=false;this.token=0;}

  // Bounded single-flight: a hung capturePage or dead renderer cannot pin the
  // entry forever. The timeout bumps the operation token, so the orphaned
  // capture continuation fails at its next checkpoint and can never publish a
  // session. An active session is only superseded when its own owner is gone
  // (reload/crash/destroy moved the generation); a live foreign session stays.
  async begin(owner,payload={}){
    const snap={wc:owner.wc,generation:owner.generation,projectId:owner.projectId,windowId:owner.windowId};
    if(this.active){
      const s=this.active;
      // Session identity is owner wc + generation + project + window. The root
      // record may switch projects without bumping its generation, so the live
      // record's binding is re-checked: a stale binding is ended (disk evidence
      // stays recoverable) and a fresh session starts — A is never re-served.
      const live=this.workspace.senders.get(s.ownerWc.id);
      const ownerStale=!live||live.dead||live.generation!==s.ownerGeneration||live.projectId!==s.projectId||live.windowId!==s.windowId;
      const sameBinding=s.ownerWc===owner.wc&&s.ownerGeneration===owner.generation&&s.projectId===owner.projectId&&s.windowId===owner.windowId;
      if(sameBinding){
        const described=await this.describe(s);
        // listRecoverable awaits: a binding that drifts (rebind/reload) while
        // the descriptor is assembled is never re-served.
        if(this.active!==s||!this.ownerLive(snap))throw invalidated();
        return described;
      }
      if(!ownerStale)throw Error(s.projectId===owner.projectId?'另一窗口正在涂鸦，请先在该窗口完成或取消':'另一项目正在涂鸦，请先完成或退出');
      this.end(s,'superseded');
    }
    if(this.preparing)throw Error('正在冻结工作面，请稍候');
    const token=++this.token;this.preparing=true;
    // A queued layout reconcile (window close, command, bounds application)
    // can land between the pre-checks and the layer captures; that abort is
    // safe by design, and the freeze retries it whole — every layer is
    // re-read, nothing is mixed — instead of pushing a retry onto the user.
    const flight=(async()=>{for(let attempt=0;;attempt++){try{return await this.capture(owner,payload,token);}catch(error){if(error?.code!=='CAPTURE_CONTENT_CHANGED'||attempt>=2)throw error;}}})();
    let timer;
    try{
      const session=await Promise.race([
        flight,
        new Promise((_,reject)=>{timer=setTimeout(()=>{if(token===this.token){this.token++;this.preparing=false;}reject(Object.assign(new Error('冻结工作面超时，请重试'),{code:'CAPTURE_TIMEOUT'}));},this.prepareTimeoutMs);})
      ]);
      if(token!==this.token)throw invalidated();
      const root=this.workspace.windows.get(session.windowId);
      if(!root||root.dead||root.wc!==session.ownerWc||root.generation!==session.ownerGeneration||root.projectId!==session.projectId||root.windowId!==session.windowId)throw invalidated();
      const described=await this.describe(session);
      // The descriptor is assembled before publication: token or binding drift
      // during the awaited store read never publishes a stale session.
      if(token!==this.token||!this.ownerLive(snap))throw invalidated();
      this.active=session;
      return described;
    }finally{clearTimeout(timer);if(token===this.token)this.preparing=false;}
  }

  step(token){if(token!==this.token)throw invalidated();}

  // Capture stability is scoped to THIS window's visible layer stack: webContents
  // identity, order, bounds, visibility, surface viewId+generation and static
  // report digest. Same-project churn in OTHER windows (layout revision bumps,
  // read-state, moves elsewhere) must never abort this freeze; no file-version
  // atomicity is claimed for the captured layers.
  layerStack(children){
    const parts=[];
    for(const view of children){
      if(!view.getVisible()||!view.webContents||view.webContents.isDestroyed())continue;
      const bounds=view.getBounds();
      const scope=this.workspace.senders.get(view.webContents.id);
      const slot=[...(this.workspace.isolatedPreview?.slots.values()??[])].find(s=>s.view===view);
      const surface=scope?.role==='surface'?scope:slot?.scope;
      parts.push(`${view.webContents.id}:${bounds.x},${bounds.y},${bounds.width},${bounds.height}:${surface?surface.viewId+'@'+surface.generation:'-'}:${slot?(slot.profile??'slot')+'@'+(slot.files?.get?.(slot.entry)?.digest??''):'-'}`);
    }
    return parts.join('|');
  }

  // Freeze only the initiating window's visible layers. Precondition checks are
  // scoped to that window; other same-project windows never block and are never
  // read. Sources are static identities read from the host tables — no renderer
  // handshake, no version claim (viewport-only by contract); only an immutable
  // static-report digest may be stated, everything else stays version-unknown.
  // True when the live sender and window records still match an immutable
  // binding snapshot. bindProject and reloads mutate these records in place,
  // so any drift (project switch, reload, death) invalidates the capture.
  ownerLive(snap){
    const live=this.workspace.senders.get(snap.wc.id),root=this.workspace.windows.get(snap.windowId);
    return Boolean(live&&!live.dead&&live.wc===snap.wc&&live.generation===snap.generation&&live.projectId===snap.projectId&&live.windowId===snap.windowId&&root&&!root.dead&&root.wc===snap.wc&&root.generation===snap.generation&&root.projectId===snap.projectId);
  }

  async capture(owner,payload={},token){
    // Admission snapshot: `owner` is the live sender record and bindProject may
    // mutate it while we await. Every decision below reads these frozen fields;
    // after each async preparation boundary the LIVE records are re-checked
    // before any pixel read, store use or publication.
    const snap={wc:owner.wc,generation:owner.generation,projectId:owner.projectId,windowId:owner.windowId};
    const checkpoint=()=>{this.step(token);if(!this.ownerLive(snap))throw invalidated();};
    if(!snap.projectId)throw Error('请先打开项目');
    const root=this.workspace.windows.get(snap.windowId);
    if(!root||root.dead||root.wc!==snap.wc)throw Error('发起窗口已关闭');
    if(root.projectId!==snap.projectId)throw Error('发起窗口已切换项目');
    if(root.win.isMinimized()||!root.win.isVisible())throw Error('发起窗口不可见，请先恢复该窗口');
    if(this.workspace.projectRecords(snap.projectId,snap.windowId).some(s=>s.transferring||s.recoveryHeld||!s.ready))throw Error('本窗口内容正在加载或迁移，请稍候');
    const blocked=await root.wc.executeJavaScript(`Array.from(document.querySelectorAll('#settings-dialog[open],#configuration-setup[open],input[type="password"]:not([hidden])')).some(node=>node.getClientRects().length>0)`).catch(()=>true);
    checkpoint(); // a reload during the settings check must abort before any pixel read
    if(blocked)throw Error('请先关闭本窗口的设置或认证界面再截图');
    const [dipWidth,dipHeight]=root.win.getContentSize();
    const display=this.workspace.screen.getDisplayMatching(root.win.getBounds());
    const scale=display.scaleFactor||1;
    const width=Math.round(dipWidth*scale),height=Math.round(dipHeight*scale);
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>20000||height>20000||width*height>CAPTURE_PIXELS)throw Object.assign(new Error('窗口像素超过预算，请缩小窗口后重试'),{code:'CAPTURE_PIXEL_BUDGET'});
    const store=new WorkspaceCaptureStore({directory:path.join(await this.host.storage.recoveryDirectory(snap.projectId),'drawing-captures')});
    checkpoint(); // a project switch during recoveryDirectory must not touch any store
    const recovered=payload.recoverId?await store.load(payload.recoverId,snap.projectId):null;
    checkpoint();
    if(recovered)return this.restore(snap,store,recovered);
    const generation=snap.generation;
    // Metadata-only count of same-project windows not included in this freeze
    // ("另有 N 个本项目窗口未纳入"); frozen at capture time, never a block.
    const omittedWindowCount=[...this.workspace.windows.values()].filter(r=>r!==root&&!r.dead&&r.projectId===snap.projectId).length;
    const before=this.layerStack(root.win.contentView.children);
    this.step(token);
    const layers=[];let pixels=0;
    for(const view of [...root.win.contentView.children]){
      this.step(token);
      if(!view.getVisible()||!view.webContents||view.webContents.isDestroyed())continue;
      const bounds=view.getBounds();if(bounds.width<=0||bounds.height<=0)continue;
      const scope=this.workspace.senders.get(view.webContents.id);
      const slot=[...(this.workspace.isolatedPreview?.slots.values()??[])].find(s=>s.view===view);
      const surface=scope?.role==='surface'?scope:slot?.scope;
      if(surface&&surface.projectId!==snap.projectId)throw Object.assign(new Error('本窗口包含其他项目的内容，未读取其像素。'),{code:'CAPTURE_SCOPE_DENIED'});
      let source=null;
      if(surface){
        source={sourceId:surface.viewId,projectId:surface.projectId,viewId:surface.viewId,kind:surface.kind,relPath:surface.relPath??null,locationStatus:'viewport-only',version:{kind:'unknown'},bounds,capturedAt:new Date().toISOString()};
        if(slot?.profile==='staticReport'){
          const digest=slot.files.get(slot.entry)?.digest;
          source.identity={projectId:surface.projectId,resource:{kind:'report',objectId:slot.source?.objectId??slot.manifest?.objectId??null,digest}};
          source.version=source.identity.version={kind:'material',digest};
          source.summary='冻结报告 · '+digest;
        }else source.summary=surface.relPath?'文档视图 · '+surface.relPath+' · 版本未核验':'工作面视图';
      }
      const image=await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      this.step(token);
      if(image.isEmpty())throw Error('窗口图像不可读取，未生成不完整截图');
      // One PNG buffer is the single source of truth: its IHDR carries the
      // authoritative device-pixel dimensions (no scale-factor API guessing,
      // no DIP confusion) and the very same bytes become the stored layer.
      const png=image.toPNG();
      this.step(token);
      if(png.length<24||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('窗口图像不可读取，未生成不完整截图');
      const pw=png.readUInt32BE(16),ph=png.readUInt32BE(20);
      if(!Number.isSafeInteger(pw)||!Number.isSafeInteger(ph)||pw<1||ph<1||pw>20000||ph>20000)throw Object.assign(new Error('捕获图像尺寸无效'),{code:'CAPTURE_PIXEL_BUDGET'});
      pixels+=pw*ph;if(pixels>CAPTURE_PIXELS)throw Object.assign(new Error('窗口像素超过预算，请缩小窗口后重试'),{code:'CAPTURE_PIXEL_BUDGET'});
      // Same root/window/project/generation/visibility/revision verification
      // after each layer: a reloaded, resized, hidden or moved-on window must
      // abort the whole freeze instead of mixing evidence.
      const currentSize=root.win.getContentSize();
      if(root.dead||root.generation!==generation||root.projectId!==snap.projectId||!root.win.isVisible()||!view.getVisible()||view.webContents.isDestroyed()||JSON.stringify(view.getBounds())!==JSON.stringify(bounds)||currentSize[0]!==dipWidth||currentSize[1]!==dipHeight||String(this.workspace.screen.getDisplayMatching(root.win.getBounds()).id)!==String(display.id)||this.layerStack(root.win.contentView.children)!==before)throw Object.assign(new Error('捕获期间本窗口内容改变，请重试'),{code:'CAPTURE_CONTENT_CHANGED'});
      layers.push({bounds,dataUrl:'data:image/png;base64,'+png.toString('base64'),source});
    }
    if(!layers.length)throw Error('发起窗口没有可捕获的可见内容');
    const windowBounds=root.win.getBounds();
    const tile={id:root.windowId,title:root.win.getTitle(),width,height,layers,displayId:String(display.id),displayBounds:display.bounds,windowBounds};
    // Provenance reflects what is actually visible: upper layers occlude lower
    // ones by rectangle subtraction — a fully covered parent is excluded, a
    // partially visible one is clipped to its visible pieces. Layer bounds are
    // DIP; pixelScale makes the device-pixel canvas explicit. No file-version
    // atomicity is claimed.
    const sources=captureOutput({width,height,tiles:[{...tile,x:0,y:0}]},{scopeMode:'window',windowId:tile.id,pixelScale:width/dipWidth}).sources;
    const session={id:randomUUID(),projectId:snap.projectId,windowId:snap.windowId,ownerWc:snap.wc,ownerGeneration:snap.generation,store,tiles:[tile],width,height,sources,omittedWindowCount,drawingDraft:null,recovered:null,pendingReceipt:null,ownReceipt:false,editIntent:null,createdAt:new Date().toISOString(),committing:false};
    checkpoint(); // revalidate the live binding before publishing frozen evidence
    await store.saveFrozen({id:session.id,projectId:session.projectId,createdAt:session.createdAt,state:'frozen',tiles:session.tiles,width:session.width,height:session.height,sources:session.sources,omittedWindowCount,ownerGeneration:session.ownerGeneration});
    return session;
  }

  // Legacy frozen records stored DIP layout dims while their retained editable
  // drawing lives on a device-pixel region image (possibly a cropped rect). The
  // resumable canvas therefore comes from the stored draft itself: drawing dims
  // cross-checked against the stored regionImage PNG IHDR — renderer-supplied
  // sizes are never trusted. A contradiction rejects the resume with every
  // record preserved; captures without a retained drawing keep their baseline.
  editableCanvas(recovered){
    const draft=recovered?.drawingDraft,drawing=draft?.drawing;
    if(!drawing||!Number.isSafeInteger(drawing.width)||!Number.isSafeInteger(drawing.height)||drawing.width<1||drawing.height<1||drawing.width>20000||drawing.height>20000||drawing.width*drawing.height>CAPTURE_PIXELS)return null;
    const dataUrl=draft.target?.regionImage?.dataUrl;
    if(typeof dataUrl==='string'&&dataUrl.startsWith('data:image/png;base64,')){
      const header=Buffer.from(dataUrl.slice(22,66),'base64');
      if(header.length<24||header.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('涂鸦区域图像不可读取，已保留原记录');
      if(header.readUInt32BE(16)!==drawing.width||header.readUInt32BE(20)!==drawing.height)throw Error('涂鸦与原区域图像尺寸不一致，已保留原记录');
    }
    return {width:drawing.width,height:drawing.height};
  }

  // Resuming a persisted capture binds the stored evidence to the initiating
  // window described by an immutable binding snapshot — never the live record:
  // tiles/baseline stay exactly as frozen (never recaptured), the editable
  // canvas follows the retained draft for legacy records, every write stays
  // under the frozen project, and after each await the live sender and window
  // records must still match before the forked session may be published.
  async restore(owner,store,recovered){
    const revalidate=()=>{if(!this.ownerLive(owner))throw invalidated();};
    revalidate();
    const canvas=this.editableCanvas(recovered),width=canvas?.width??recovered.width,height=canvas?.height??recovered.height;
    const id=recovered.result?randomUUID():recovered.id,createdAt=id===recovered.id?recovered.createdAt:new Date().toISOString();
    const pendingDeliveryId=recovered.result?(recovered.result.state==='pending-delivery'?recovered.id:null):recovered.pendingDeliveryId??null;
    const pendingReceipt=pendingDeliveryId?await store.load(pendingDeliveryId,owner.projectId):null;
    revalidate();
    if(id!==recovered.id){
      await store.saveFrozen({...recovered,id,width,height,createdAt,pendingDeliveryId,drawingDraft:undefined,result:undefined});
      revalidate();
      if(recovered.drawingDraft)await store.saveDrawing(id,owner.projectId,recovered.drawingDraft);
      revalidate();
    }
    return {id,projectId:owner.projectId,windowId:owner.windowId,ownerWc:owner.wc,ownerGeneration:owner.generation,store,tiles:recovered.tiles,width,height,sources:recovered.sources??[],omittedWindowCount:recovered.omittedWindowCount??0,drawingDraft:recovered.drawingDraft??null,recovered,pendingReceipt,ownReceipt:false,editIntent:null,createdAt,committing:false};
  }

  async describe(s){
    // `receipt` (2026-10-25 direct-send alignment) is a backward-compatible
    // association view: the live pending receipt, else the recovered record's
    // persisted result, so a reopened discussion card can show its thread
    // state (question, delivery state, requestId, attachment identity).
    const receipt=s.pendingReceipt?.result??s.recovered?.result??null;
    return {captureId:s.id,projectId:s.projectId,tiles:s.tiles,width:s.width,height:s.height,sources:s.sources,omittedWindowCount:s.omittedWindowCount??0,drawingDraft:s.drawingDraft??null,recoverable:await s.store.listRecoverable(s.projectId),...(receipt?{receipt}:{})};
  }

  // The drawing dialog lives in the initiating root renderer; only that
  // webContents' current generation may drive the session it started, and only
  // with its captureId. A renderer reload/crash bumps the generation and
  // invalidates every outstanding op until the entry is begun again.
  authorized(event,p={}){
    const s=this.active;
    if(!s||!event?.sender||p.captureId!==s.id||event.sender!==s.ownerWc||event.senderFrame!==event.sender.mainFrame)return false;
    const record=this.workspace.senders.get(event.sender.id);
    return Boolean(record&&!record.dead&&record.wc===s.ownerWc&&record.generation===s.ownerGeneration&&record.projectId===s.projectId&&record.windowId===s.windowId);
  }

  // End a session from the main side; the frozen evidence and saved drafts stay
  // recoverable. The owner renderer is told so its dialog can close.
  end(s,reason){
    if(this.active!==s)return;
    this.active=null;
    try{if(!s.ownerWc.isDestroyed())s.ownerWc.send('nozeli:workspace-control',{type:'capture-closed',projectId:s.projectId,captureId:s.id,reason});}catch{}
  }

  // Once a delivery failure leaves a receipt on s.id, that record is an
  // immutable recoverable baseline (frozen evidence, original draft and card,
  // receipt). Later live edits — autosave or commit — persist under a lazily
  // created durable editable fork while the public session keeps answering to
  // the original captureId. The fork links to the CURRENT pending receipt so a
  // crash before its own result re-opens the newest undelivered intent, not an
  // older one.
  async editableTarget(s){
    if(!s.ownReceipt)return s.id;
    if(!s.editIntent){
      const fork=randomUUID();
      await s.store.saveFrozen({id:fork,projectId:s.projectId,createdAt:new Date().toISOString(),state:'frozen',tiles:s.tiles,width:s.width,height:s.height,sources:s.sources,omittedWindowCount:s.omittedWindowCount??0,ownerGeneration:s.ownerGeneration,pendingDeliveryId:s.pendingReceipt?.id??s.id});
      s.editIntent=fork;
    }
    return s.editIntent;
  }

  async invoke(event,op,p={}){
    if(!this.authorized(event,p))throw Error('涂鸦会话无效或已过期');
    const s=this.active;
    if(op==='save')return s.store.saveDrawing(await this.editableTarget(s),s.projectId,{drawing:p.drawing,target:p.target});
    if(op==='cancel'){
      if(s.committing)throw Error('正在保存');
      this.end(s,'cancelled');
      return {cancelled:true,captureId:s.id};
    }
    if(op==='recover'){
      if(s.committing)throw Error('正在保存');
      const record=await s.store.load(p.id,s.projectId);
      const root=this.workspace.windows.get(s.windowId);
      if(!root||this.active!==s||!this.authorized(event,p))throw Error('涂鸦会话无效或已过期');
      const binding={wc:s.ownerWc,generation:s.ownerGeneration,projectId:s.projectId,windowId:s.windowId};
      const restored=await this.restore(binding,s.store,record);
      const described=await this.describe(restored);
      if(this.active!==s||!this.authorized(event,p)||!this.ownerLive(binding))throw Error('涂鸦会话无效或已过期');
      this.active=restored;
      return described;
    }
    if(op==='discard'){if(p.id===s.id)throw Error('当前画面请先退出后再删除恢复记录');return s.store.discard(p.id,s.projectId);}
    if(op==='commit')return this.commit(s,p);
    throw Error('未知涂鸦操作');
  }

  async commit(s,p){
    if(s.committing)throw Error('正在保存');s.committing=true;
    try{
      const bytes=Buffer.from(String(p.png??'').replace(/^data:image\/png;base64,/,''),'base64');
      if(!bytes.length||bytes.length>8*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('截图为空、格式错误或超过8MiB');
      if(bytes.length<24)throw Error('截图数据不完整');
      // The dialog composes at the captured device-pixel resolution; a commit
      // that does not match the frozen canvas exactly is rejected, never scaled.
      if(bytes.readUInt32BE(16)!==s.width||bytes.readUInt32BE(20)!==s.height)throw Error('截图尺寸与已捕获画面不一致');
      if(p.drawing&&(p.drawing.width!==s.width||p.drawing.height!==s.height))throw Error('涂鸦画布与捕获画面不一致');
      // Draft persistence (which validates the drawing) precedes any side
      // effect, so an invalid payload never leaves a stored attachment behind.
      // Once a receipt occupies s.id the edit lands on the durable editable
      // fork instead, preserving the original record's recoverable draft and
      // card baseline byte for byte.
      const draft={drawing:p.drawing,target:p.target??s.recovered?.drawingDraft?.target};
      await s.store.saveDrawing(await this.editableTarget(s),s.projectId,draft);
      const card=p.target?.card??s.recovered?.drawingDraft?.target?.card??null;
      const prior=s.pendingReceipt,priorCard=prior?.result?.card??prior?.drawingDraft?.target?.card??null;
      const question=typeof card?.message==='string'?card.message.trim():'',priorQuestion=typeof priorCard?.message==='string'?priorCard.message.trim():'';
      const priorDrawing=prior?.result?.drawing??prior?.drawingDraft?.drawing;
      const sameDrawing=(!p.drawing?.strokes?.length&&!priorDrawing?.strokes?.length)||isDeepStrictEqual(p.drawing,priorDrawing);
      // A persisted receipt (recovered, or left by a failed delivery in this
      // live dialog) retries the original delivery id when question and ink
      // are unchanged, including after another crash on the recovery fork.
      // Editing starts a new intent instead.
      //
      // Direct-send handoff (2026-10-25 discussion alignment): the snapshot
      // card's single 发送讨论 click commits first, sends through the managed
      // image-attachment chain, then finalizes. The initial direct commit
      // stores the material and a pending-delivery receipt WITHOUT routing the
      // image into the conversation draft (the explicit send replaces the
      // draft chip) and keeps the session alive; the finalize associates the
      // requestId, marks the receipt delivered and ends the session. Receipt
      // semantics are unchanged: an unchanged retry reuses the original
      // delivery id, an edited one forks a distinct intent below.
      if(p.direct&&!p.requestId){
        if(prior?.result&&sameDrawing&&question===priorQuestion){
          return {saved:true,attached:true,captureId:s.id,deliveryId:prior.id,attachment:prior.result.attachment,state:'pending-delivery',direct:true};
        }
        const intent=s.editIntent??s.id;
        const stored=await this.host.attachMaterial({projectId:s.projectId,name:'drawing-'+intent+'.png',mime:'image/png',source:'drawing',size:bytes.length,bytes:bytes.toString('base64')});
        const attachment={...stored,kind:'image',source:'drawing',sources:s.sources};
        const result={id:intent,projectId:s.projectId,attachment,sources:s.sources,state:'pending-delivery',drawing:p.drawing,card};
        await s.store.saveResult(intent,s.projectId,result);
        s.pendingReceipt={id:intent,projectId:s.projectId,createdAt:s.createdAt,state:'frozen',tiles:s.tiles,width:s.width,height:s.height,sources:s.sources,omittedWindowCount:s.omittedWindowCount??0,ownerGeneration:s.ownerGeneration,result,drawingDraft:draft};
        if(intent===s.id)s.ownReceipt=true;else s.editIntent=null;
        return {saved:true,attached:true,captureId:s.id,deliveryId:intent,attachment,state:'pending-delivery',direct:true};
      }
      // Per-round finalize: associate the newest requestId, persist the full
      // discussion thread onto the receipt and mark it delivered. The question
      // legitimately advances with rounds (ink stays bound to the delivery
      // identity), the call is idempotent for an already-delivered receipt,
      // and the session is NOT ended here — the card's completion paths own
      // it, so 续问 can keep refreshing this receipt with later rounds.
      if(p.direct&&p.requestId){
        if(!prior?.result||!sameDrawing)throw Error('直发回执与当前涂鸦不一致；请重新发送，或改用加入对话草稿。');
        const result={...prior.result,state:'delivered',requestId:p.requestId,card};
        await s.store.saveResult(prior.id,s.projectId,result);
        if(prior.id!==s.id){
          const baseline=await s.store.load(s.id,s.projectId);
          if(!baseline.result)await s.store.saveResult(s.id,s.projectId,result);
        }
        return {saved:true,attached:true,captureId:s.id,deliveryId:prior.id,requestId:p.requestId,state:'delivered',direct:true};
      }
      if(!p.local&&prior?.result&&sameDrawing&&question===priorQuestion){
        const result={...prior.result,state:'delivered'},sources=result.sources??prior.sources??[];
        await this.deliver({projectId:s.projectId,window:{windowId:s.windowId}},{type:'drawing-material',projectId:s.projectId,target:'frontdesk',deliveryId:prior.id,attachment:result.attachment,sources,card:priorCard});
        await s.store.saveResult(prior.id,s.projectId,result);
        if(prior.id!==s.id){
          // Mirror delivery onto the session's own baseline only when it holds
          // no receipt of its own; a persisted receipt under s.id stays as is.
          const baseline=await s.store.load(s.id,s.projectId);
          if(!baseline.result)await s.store.saveResult(s.id,s.projectId,result);
        }
        this.end(s,'committed');return {saved:true,attached:true,captureId:s.id};
      }
      // A persisted receipt is immutable (store-enforced). Any new intent after
      // one — an edited question or ink, or a local save — commits on the
      // editable fork created above rather than overwriting or reusing the
      // original delivery identity.
      const intent=s.editIntent??s.id;
      const stored=await this.host.attachMaterial({projectId:s.projectId,name:'drawing-'+intent+'.png',mime:'image/png',source:'drawing',size:bytes.length,bytes:bytes.toString('base64')});
      const attachment={...stored,kind:'image',source:'drawing',sources:s.sources};
      const result={id:intent,projectId:s.projectId,attachment,sources:s.sources,state:p.local?'local':'pending-delivery',drawing:p.drawing,card};
      await s.store.saveResult(intent,s.projectId,result);
      if(!p.local){
        // workspace-native deliverDrawing addresses the activating window via
        // session.window.windowId; delivery is idempotent on deliveryId. The
        // discussion-card text (target.card) rides along for draft routing —
        // never auto-sent, never a fabricated file anchor.
        try{
          await this.deliver({projectId:s.projectId,window:{windowId:s.windowId}},{type:'drawing-material',projectId:s.projectId,target:'frontdesk',deliveryId:intent,attachment,sources:s.sources,card});
          await s.store.saveResult(intent,s.projectId,{...result,state:'delivered'});
        }catch(error){
          // Delivery failed after the receipt persisted: bind it to the live
          // session in the loaded-record shape (result plus its editable
          // draft, exactly how the restored path reads a receipt) so an
          // unchanged retry reuses the original delivery id and an edited
          // retry forks instead of clobbering this receipt. A receipt on s.id
          // freezes its editable baseline; a receipt on the fork retires it
          // so the next edit starts a fresh distinct intent.
          s.pendingReceipt={id:intent,projectId:s.projectId,createdAt:s.createdAt,state:'frozen',tiles:s.tiles,width:s.width,height:s.height,sources:s.sources,omittedWindowCount:s.omittedWindowCount??0,ownerGeneration:s.ownerGeneration,result,drawingDraft:draft};
          if(intent===s.id)s.ownReceipt=true;else s.editIntent=null;
          throw error;
        }
      }
      this.end(s,'committed');
      return {saved:true,attached:!p.local,captureId:s.id};
    }finally{s.committing=false;}
  }

  // Quit and project-lifecycle paths call this: in-flight prepare continuations
  // are invalidated immediately; an in-flight commit must be awaited, never
  // torn, because delivery and result persistence are not restartable mid-way.
  async shutdown(){
    this.token++;this.preparing=false;
    const s=this.active;
    if(!s)return;
    if(s.committing)throw Error('正在保存涂鸦，请稍后退出');
    this.end(s,'shutdown');
  }
}
