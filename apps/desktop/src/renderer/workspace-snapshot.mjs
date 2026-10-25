// In-page workspace snapshot drawing (2026-10-24 rework, 2026-10-25 discussion
// alignment). The dialog lives in the initiating root renderer and joins the
// workspace-groups overlay protocol automatically: a body-child dialog[open] is
// reported as an overlay rect via workspace.bounds, so native views beneath stay
// hidden until it closes. No mode chooser, no crop handles: the whole frozen
// window is the canvas, and 完成 opens a screenshot-bound discussion card at
// the drawn position. The card is a tag-style discussion thread card sharing
// the generic layer with file tags (discussion-thread.mjs): one explicit
// 发送讨论 click commits the frozen evidence and sends through the managed
// image-attachment chain — replies project back into the card by requestId and
// 续问 reuses the committed digest. Nothing is ever auto-sent: 加入对话草稿,
// 仅保存本地 and 返回笔迹 stay, and the anchor is presented as 冻结来源 +
// 笔迹位置, never a file anchor.
import {mountDrawingEditor,drawingSvg} from './region-drawing.mjs';
import {uiIcon} from './ui-icons.mjs';
import {CAPTURE_PIXELS} from '../domain/workspace-capture.mjs';
import {createDiscussionTransport,createDiscussionThread,createThreadMessageSource,mountThreadTranscript,plainThreadRounds} from './discussion-thread.mjs';

export function mountWorkspaceSnapshot({invoke,getProjectId,toast=()=>{},openConversation=null,subscribe=null}){
  let dialog=null,editor=null,statusEl=null,recoverRow=null,recoverSelect=null,recoverClean=null;
  let session=null,target=null,opening=false,exiting=false;
  // Retention state: lastDrawing is the last successful in-page drawing; the
  // debounced store write serializes through writeChain and never swallows a
  // failure (status + toast + saveError gate further writes and closing).
  // changeSeq is a monotonic dirty revision: every stroke and every card
  // text/anchor change bumps it, so a completed store write may acknowledge
  // only the revision it actually captured.
  let saveTimer=null,writeChain=Promise.resolve(),saveError=null,lastDrawing=null,lastDrawingDirty=false,changeSeq=0;
  let card=null,cardBox=null,cardImage=null,cardOverlay=null,cardPanel=null,cardHint=null,cardText=null,cardSend=null,cardLocal=null,cardBack=null,cardDraft=null,cardOpen=null,cardDone=null,cardThreadEl=null,cardStatusLine=null;
  let cardState=null,cardMessageDraft='',cardSavedText=null,cardSavedRect=null;
  // Discussion thread state: one thread per dialog session, shared layer with
  // file tags. `delivery` (on cardState) holds the committed receipt identity
  // (deliveryId + attachment ref) once 发送讨论 committed the evidence;
  // `finalized` marks the delivered receipt that ended the capture session.
  let discussion=null,renderTranscript=null,sending=false,sessionReceipt=null,threadRefreshTimer=null;
  const transport=createDiscussionTransport({invoke,getProjectId});
  const enterConversation=async()=>{
    if(openConversation){await openConversation();return;}
    const button=document.getElementById('workspace-open-conversation');
    if(button&&!button.disabled&&!button.hidden){button.click();return;}
    const result=await invoke('workspace.control',{type:'conversation-action',projectId:getProjectId(),action:'open'});
    if(!result?.ok)toast(result?.error?.message||'打开对话失败');
  };
  const call=async(op,p={})=>{const result=await invoke(op,p);if(!result?.ok)throw Error(result?.error?.message||'涂鸦操作失败');return result.value;};
  const image=url=>{const im=new Image();im.src=url;return im.decode().then(()=>im);};
  const status=text=>{if(statusEl){statusEl.textContent=text;statusEl.title=text;statusEl.dataset.state=/失败|错误/.test(text)?'error':'info';}};
  const cardStatus=(text,state='')=>{if(!cardStatusLine)return;cardStatusLine.textContent=text||'';if(state)cardStatusLine.dataset.state=state;else delete cardStatusLine.dataset.state;};
  const closeDialogEl=()=>{if(dialog?.open)dialog.close();};

  function ensure(){
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.setAttribute('aria-label','工作面涂鸦');
    // The editor is position:fixed; inside the top-layer dialog that resolves
    // against the dialog box, so the dialog must span the viewport — full bleed
    // with no inset, keeping the frozen workspace at its live size.
    Object.assign(dialog.style,{width:'100vw',height:'100dvh',maxWidth:'none',maxHeight:'none',margin:'0',padding:'0',border:'0',background:'#252925',overflow:'hidden'});
    // Compact corner chips float above the frozen image: status bottom-left,
    // recovery + exit bottom-right. No header band, no layout reserve.
    statusEl=document.createElement('span');statusEl.className='snapshot-status';statusEl.dataset.snapshotStatus='true';
    // One light recovery selector replaces the old per-record resume/drop button groups.
    recoverRow=document.createElement('div');recoverRow.className='snapshot-recovery';recoverRow.hidden=true;
    recoverSelect=document.createElement('select');recoverSelect.className='snapshot-recovery-select';recoverSelect.setAttribute('aria-label','恢复未完成涂鸦');
    recoverSelect.onchange=()=>{const id=recoverSelect.value;recoverSelect.value='';if(id&&session)void resumeRecord(id);};
    recoverClean=document.createElement('button');recoverClean.type='button';recoverClean.className='snapshot-recovery-clean';recoverClean.textContent='清理记录';recoverClean.title='仅删除尚未交接的涂鸦恢复记录';
    recoverClean.onclick=async()=>{
      if(!session)return;
      const stale=(session.recoverable??[]).filter(r=>r?.id&&r.id!==session.captureId);
      if(!stale.length||!window.confirm(`仅删除 ${stale.length} 份尚未交接的涂鸦恢复记录？冻结画面与本地记录之外的材料不受影响。`))return;
      const removed=new Set();let failed=0;
      for(const record of stale){try{await call('workspace.capture.discard',{captureId:session.captureId,id:record.id});removed.add(record.id);}catch{failed++;}}
      session={...session,recoverable:(session.recoverable??[]).filter(r=>!removed.has(r.id))};
      renderRecoverable();
      if(failed)toast(failed+' 份记录删除失败');
    };
    recoverRow.append(recoverSelect,recoverClean);
    const bar=document.createElement('div');bar.className='snapshot-corner';
    const exit=document.createElement('button');exit.type='button';exit.className='snapshot-exit';exit.textContent='退出';exit.prepend(uiIcon('close'));
    exit.onclick=()=>void exitDialog();
    bar.append(recoverRow,exit);dialog.append(statusEl,bar);document.body.append(dialog);
    dialog.addEventListener('cancel',event=>{event.preventDefault();if(cardState&&cardMode()==='compose')void backToDrawing();else void exitDialog();});
    // The session can be ended behind our back (committed elsewhere, shutdown,
    // superseded); the host tells us and the dialog must close without fighting it.
    const listen=subscribe||((...args)=>window.nozeli?.subscribe?.(...args));
    listen('workspace.control',event=>{
      if(event?.type!=='capture-closed'||!session)return;
      if(event.captureId&&event.captureId!==session.captureId)return;
      // (direct-send finalizes never end the session; completion paths own it)
      teardown();
    });
    // Managed timeline churn re-projects thread replies into the card.
    listen('agent',event=>{
      if(!event||!discussion||!cardState||event.projectId!==getProjectId())return;
      if(!['managed-state','managed-timeline'].includes(event.kind))return;
      clearTimeout(threadRefreshTimer);threadRefreshTimer=setTimeout(()=>void discussion?.refresh(),250);
    });
    editor=mountDrawingEditor({
      fullscreen:true,
      container:dialog,
      // Unique editor IDs: the selection editor keeps the default prefix and
      // the launcher button owns #workspace-drawing, so root id and every
      // control id must not collide with either.
      idPrefix:'snapshot-drawing',
      onChange:drawing=>{
        lastDrawing=drawing;lastDrawingDirty=true;changeSeq++;saveError=null;
        clearTimeout(saveTimer);saveTimer=setTimeout(()=>void enqueueWrite(),200);
      },
      // 完成 composes the PNG and opens the discussion card in this dialog;
      // the editor suspends itself once this resolves. No main-draft routing.
      onFinish:(t,drawing,png)=>{openCard(t,drawing,png);return Promise.resolve();},
      onCancel:()=>exitDialog(),
      onError:message=>toast(message)
    });
  }

  // Ordered draft persistence. A failed write is surfaced, retried only by the
  // next stroke/keystroke, and gates commit/exit paths below. While the
  // discussion card is open, its current text/anchor is persisted too, so a
  // quit-time flush can neither duplicate an identical save nor lose newer
  // same-text/card changes. Once a round was sent, the retained message is the
  // last SENT question — the follow-up input stays live-only.
  function retainedMessage(){
    if(!cardState)return null;
    if(cardState.delivery)return discussion?.message()||cardText.value.trim();
    return cardText.value.trim();
  }
  function cardInfo(state,text){
    const previous=state.target.card||{};
    const rounds=discussion?.thread?.history?.length?plainThreadRounds(discussion.thread.history):previous.thread||[];
    return {...previous,message:text,rect:state.rect||previous.rect||null,thread:rounds};
  }
  async function writeDrawing(){
    if(!session||saveError)return;
    const active=session,seq=changeSeq,text=retainedMessage();
    const cardChanged=Boolean(cardState)&&(text!==cardSavedText||(cardState.rect??null)!==(cardSavedRect??null));
    if(!lastDrawingDirty&&!cardChanged)return;
    const drawing=lastDrawing||cardState?.drawing||null;
    if(!drawing)return;
    const payloadTarget=cardState?{...structuredClone(cardState.target),card:cardInfo(cardState,text)}:target;
    try{
      await call('workspace.capture.save',{captureId:active.captureId,drawing,target:payloadTarget});
      if(session!==active)return;
      saveError=null;
      // Acknowledge only the revision this write carried: strokes or card
      // message edits that arrived during the await stay dirty for the next
      // debounced write instead of being marked saved.
      if(seq!==changeSeq)return;
      lastDrawingDirty=false;
      if(cardState){cardSavedText=text;cardSavedRect=cardState.rect??null;}
      status(cardState?'讨论卡草稿已保存到本机恢复库':'笔迹已保存到本机恢复库');
    }catch(e){
      saveError=e.message||String(e);
      status('笔迹保存失败：'+saveError);
      toast('笔迹保存失败：'+saveError);
    }
  }
  function enqueueWrite(){
    const run=writeChain.then(writeDrawing,writeDrawing);
    writeChain=run.catch(()=>{});
    return run;
  }
  // A stroke or card edit may land while a write is in flight; the write then
  // leaves it dirty on purpose. Commit/exit/quit therefore drain until the
  // newest revision is acknowledged or the store fails.
  function savePending(){
    if(lastDrawingDirty)return true;
    if(!cardState)return false;
    return retainedMessage()!==cardSavedText||(cardState.rect??null)!==(cardSavedRect??null);
  }
  async function flushWrite(){
    clearTimeout(saveTimer);
    if(saveError){saveError=null;lastDrawingDirty=true;}
    for(;;){
      if(!savePending())return {ok:true};
      const seq=changeSeq;
      await enqueueWrite();
      if(saveError)return {ok:false,error:Error('笔迹保存失败：'+saveError)};
      if(seq===changeSeq)return {ok:true};
    }
  }

  // Scale per tile: new-format tiles carry device-pixel width/height over DIP
  // windowBounds; historical records are DIP-consistent (scale 1). Layers are
  // drawn back-to-front at their stored offsets — recovered captures compose
  // their stored background and are never recaptured.
  function tileScale(tile,layers){
    const first=layers[0];if(!first)return 1;
    let right=0;for(const {layer}of layers)right=Math.max(right,(layer.bounds?.x||0)+(layer.bounds?.width||0));
    const dip=Number.isFinite(tile.windowBounds?.width)&&tile.windowBounds.width>0?tile.windowBounds.width:(right||tile.width||1);
    const k=tile.width/dip;
    if(Number.isFinite(k)&&k>0&&right*k<=tile.width+2)return k;
    const bounds=first.layer?.bounds||{},ratio=(first.im.naturalWidth||bounds.width||1)/(bounds.width||1);
    return Math.abs(right*ratio-tile.width)<=Math.max(2,tile.width*.02)?ratio:1;
  }
  function pngDims(dataUrl){
    try{
      const bytes=atob(String(dataUrl).replace(/^data:image\/png;base64,/,''));
      if(bytes.length<24||bytes.charCodeAt(0)!==0x89||bytes.charCodeAt(1)!==0x50)return null;
      const word=offset=>bytes.charCodeAt(offset)<<24|bytes.charCodeAt(offset+1)<<16|bytes.charCodeAt(offset+2)<<8|bytes.charCodeAt(offset+3);
      return {width:word(16),height:word(20)};
    }catch{return null;}
  }
  async function compose(){
    const width=session.width,height=session.height;
    // Pixel budget is re-checked BEFORE any canvas allocation; the commit PNG
    // is exactly the session's device-pixel size, as the host requires.
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>CAPTURE_PIXELS)throw Error('冻结画面超出像素预算，未分配画布');
    let background=null,scale=1;
    // Resumed legacy/unfinished drafts: the stored target image IS the verified
    // editable canvas (main cross-checked its IHDR against the drawing). Use it
    // verbatim at the descriptor dims — the frozen tile baseline is never
    // recaptured, rescaled or drawn over it.
    const stored=session.drawingDraft?.target?.regionImage?.dataUrl;
    if(stored&&((dims=>dims&&dims.width===width&&dims.height===height)(pngDims(stored))))background=stored;
    else{
      const tiles=await Promise.all((session.tiles??[]).map(async tile=>({tile,layers:await Promise.all((tile.layers??[]).map(async layer=>({layer,im:await image(layer.dataUrl)})))})));
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const context=canvas.getContext('2d');context.fillStyle='#f5f5f5';context.fillRect(0,0,width,height);
      for(const {tile,layers} of tiles){
        const k=tileScale(tile,layers);
        for(const {layer,im} of layers){
          const b=layer.bounds||{x:0,y:0,width:im.naturalWidth,height:im.naturalHeight};
          context.drawImage(im,(tile.x||0)+b.x*k,(tile.y||0)+b.y*k,Math.max(1,b.width*k),Math.max(1,b.height*k));
        }
      }
      background=canvas.toDataURL('image/png');
      scale=tiles.length?tileScale(tiles[0].tile,tiles[0].layers):1;
    }
    target={regionImage:{dataUrl:background},scopeMode:'window',windowId:session.windowId??session.tiles?.[0]?.id??null,pixelScale:scale,
      // No file-precise anchor: this is a screenshot-bound record. The drawn
      // position rides on target.card.rect when the discussion card opens.
      anchored:false,anchorScope:'screenshot-bound',anchor:null,omittedWindowCount:session.omittedWindowCount||0,
      sourceIds:(session.sources??[]).map(s=>s.sourceId),
      sourceSummary:((session.sources??[]).map(s=>s.summary).join('；')||'工作区截图 · 视口来源，非精确文件选区')+(session.omittedWindowCount?`；另有 ${session.omittedWindowCount} 个本项目窗口未纳入`:''),
      drawing:session.drawingDraft?.drawing||{schema:'nozeli.region-drawing-v1',width,height,strokes:[]},
      capturedAt:session.createdAt};
  }

  function renderRecoverable(){
    const records=(session?.recoverable??[]).filter(r=>r?.id&&r.id!==session?.captureId);
    recoverRow.hidden=!records.length;
    recoverSelect.replaceChildren();
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=records.length?'恢复未完成涂鸦…':'没有可恢复的涂鸦';
    recoverSelect.append(placeholder);recoverSelect.value='';
    for(const record of records){
      const option=document.createElement('option');option.value=record.id;
      const when=record.createdAt?new Date(record.createdAt).toLocaleString():'';
      option.textContent=(record.state==='local'?'本地记录 ':record.state==='unreadable'?'损坏记录 ':'未完成 ')+when;
      recoverSelect.append(option);
    }
  }

  async function startEditor(message){
    if(session.drawingDraft?.target){
      try{
        await editor.start({...session.drawingDraft.target,drawing:session.drawingDraft.drawing});
      }catch(e){
        // A malformed old record stays retained and is reported — never
        // silently reopened as a blank default that invites overwriting the
        // failed history. The frozen background and the record remain.
        lastDrawing=null;lastDrawingDirty=false;saveError=null;
        status('恢复笔迹失败：'+(e.message||e)+' · 记录已保留，可退出或另选恢复记录');
        toast('恢复笔迹失败：'+(e.message||e)+' · 记录已保留');
        renderRecoverable();
        return false;
      }
      // Adopt the restored record as the retained target: autosaves persist
      // module target (cardState is null here), so its recovered card
      // question/rect must ride on it — the fresh compose descriptor carries
      // no card and the next stroke would erase the question. The drawing
      // stays the compose-derived draft; the stored region image already
      // passed the dimension cross-check editor.start just enforced.
      target={...target,...structuredClone(session.drawingDraft.target),drawing:target.drawing};
    }else{
      await editor.start(target);
    }
    lastDrawing=editor.snapshot()?.drawing||null;
    lastDrawingDirty=false;saveError=null;
    if(message)status(message);
    return true;
  }

  async function resumeRecord(id){
    if(!session)return;
    // Switching records must never trade away the live drawing: while
    // retention is failing, the current session, strokes and error stay
    // exactly as they are and the transition is refused.
    const flushed=await flushWrite();
    if(!flushed.ok){
      const message='笔迹保存失败：'+flushed.error.message+' · 已保留当前画板，未切换恢复记录';
      status(message);toast(message);
      return;
    }
    try{
      // recover may fork the record (saved result): adopt the returned
      // descriptor wholesale — captureId can change here.
      session=await call('workspace.capture.recover',{captureId:session.captureId,id});
      sessionReceipt=session.receipt||null;
      await compose();renderRecoverable();
      await startEditor(session.drawingDraft?'已恢复冻结画面与最近保存的笔迹':'已恢复冻结画面');
    }catch(e){toast(e.message);renderRecoverable();}
  }

  // Discussion card: a screenshot-bound tag-style thread card at the drawn
  // position. It is not a file tag — viewport-only sources stay unanchored;
  // the anchor is the normalized stroke rect on the frozen image, presented as
  // 冻结来源 + 笔迹位置 and persisted via target.card.
  function strokeRect(drawing){
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const s of drawing?.strokes??[])for(const point of s.points){const [x,y]=point;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}
    if(!Number.isFinite(minX))return null;
    const pad=0.015,left=Math.max(0,minX-pad),top=Math.max(0,minY-pad);
    return [left,top,Math.min(1,maxX+pad)-left,Math.min(1,maxY+pad)-top];
  }
  function ensureDiscussion(){
    if(discussion)return discussion;
    const source=createThreadMessageSource({invoke,getProjectId});
    discussion=createDiscussionThread({
      getProjectId,source,
      render:()=>{if(cardState&&!card?.hidden)renderThreadCard();},
    });
    return discussion;
  }
  function resetDiscussion(){
    // The card element (and its transcript renderer) persists across dialog
    // sessions — only the thread state and commit expectation reset here.
    clearTimeout(threadRefreshTimer);
    discussion=null;
  }
  function cardMode(){
    if(!cardState)return 'compose';
    if(cardState.finalized)return 'finalized';
    return cardState.delivery?'thread':'compose';
  }
  function setCardBusy(busy){
    cardText.readOnly=busy;
    for(const button of [cardSend,cardDraft,cardLocal,cardBack,cardOpen,cardDone])if(button)button.disabled=busy;
  }
  function renderCardMode(){
    if(!card)return;
    const mode=cardMode(),rounds=discussion?.thread?.history?.length||0;
    cardSend.textContent=rounds?'发送续问':'发送讨论';
    cardSend.classList.toggle('snapshot-card-send',mode==='compose'||!rounds);
    cardSend.classList.toggle('snapshot-card-followup',mode!=='compose'&&rounds>0);
    cardDraft.hidden=mode!=='compose';
    cardLocal.hidden=mode!=='compose';
    cardBack.hidden=mode==='finalized';
    cardOpen.hidden=mode==='compose';
    cardDone.hidden=mode==='compose';
    cardThreadEl.hidden=!rounds&&mode==='compose';
    cardSend.disabled=sending||discussion?.pending()===true;
  }
  function renderThreadCard(){
    if(!cardState||!discussion||!renderTranscript)return;
    renderTranscript(discussion.thread.history||[]);
    const thread=discussion.thread;
    if(thread.status==='failed')cardStatus('回复失败 · 原问题已保留，可续问或到对话中重试','error');
    else if(cardState.finalizeFailed)cardStatus('回执保存失败 · 讨论已送达、回复正常显示；可续问（会继续尝试保存）或稍后从恢复记录重试','error');
    else if(thread.status==='accepted-awaiting-reply'||thread.status==='pending')cardStatus('等待前台回复…');
    else if((thread.history||[]).length)cardStatus('前台已回复 · 可续问');
    renderCardMode();
  }
  function ensureCard(){
    if(card)return;
    card=document.createElement('div');card.hidden=true;card.setAttribute('role','group');card.setAttribute('aria-label','位置讨论卡');card.className='snapshot-card';
    cardBox=document.createElement('div');cardBox.className='snapshot-card-box';
    cardImage=document.createElement('img');cardImage.alt='冻结截图';cardImage.draggable=false;
    Object.assign(cardImage.style,{display:'block',width:'100%',height:'100%',pointerEvents:'none',userSelect:'none'});
    cardOverlay=document.createElement('div');Object.assign(cardOverlay.style,{position:'absolute',inset:'0',pointerEvents:'none'});
    // Visual language lives in region-drawing.css (snapshot-card-*): paper
    // panel, red marker title, frozen-source caption, tag-style transcript,
    // hint chip, pill actions. Only the computed position stays inline —
    // layoutCard() sets left/top per stroke rect.
    cardPanel=document.createElement('div');cardPanel.className='snapshot-card-panel';
    const title=document.createElement('strong');title.textContent='位置讨论';title.className='snapshot-card-title';
    cardHint=document.createElement('span');cardHint.className='snapshot-card-hint';
    cardThreadEl=document.createElement('span');cardThreadEl.className='tag-transcript snapshot-card-thread';cardThreadEl.setAttribute('role','log');cardThreadEl.setAttribute('aria-label','此涂鸦的完整讨论');
    renderTranscript=mountThreadTranscript(cardThreadEl,{welcome:'围绕这处冻结截图继续讨论。输入问题后发送，回复会留在这里和对话时间线。'});
    cardText=document.createElement('textarea');cardText.placeholder='补充说明（可留空直接发送截图；Ctrl+Enter 发送讨论）';cardText.setAttribute('aria-label','讨论说明');cardText.className='snapshot-card-text';
    cardStatusLine=document.createElement('span');cardStatusLine.className='snapshot-card-status';cardStatusLine.setAttribute('role','status');
    const row=document.createElement('div');row.className='snapshot-card-actions';
    cardSend=document.createElement('button');cardSend.type='button';cardSend.textContent='发送讨论';cardSend.className='snapshot-card-send';
    cardDraft=document.createElement('button');cardDraft.type='button';cardDraft.textContent='加入对话草稿';cardDraft.className='snapshot-card-local';
    cardLocal=document.createElement('button');cardLocal.type='button';cardLocal.textContent='仅保存本地';cardLocal.className='snapshot-card-local';
    cardBack=document.createElement('button');cardBack.type='button';cardBack.textContent='返回笔迹';cardBack.className='snapshot-card-back';
    cardOpen=document.createElement('button');cardOpen.type='button';cardOpen.textContent='进入对话';cardOpen.className='snapshot-card-open';cardOpen.hidden=true;
    cardDone=document.createElement('button');cardDone.type='button';cardDone.textContent='完成讨论';cardDone.className='snapshot-card-back';cardDone.hidden=true;
    cardText.addEventListener('input',()=>{if(!cardState)return;changeSeq++;clearTimeout(saveTimer);saveTimer=setTimeout(()=>void enqueueWrite(),400);});
    cardText.addEventListener('compositionstart',()=>{cardText.dataset.composing='true';});
    cardText.addEventListener('compositionend',()=>{delete cardText.dataset.composing;});
    cardText.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.isComposing&&event.keyCode!==229&&!event.repeat&&!cardSend.disabled){event.preventDefault();cardSend.click();}});
    cardSend.onclick=()=>void sendDiscussion();cardDraft.onclick=()=>void finishCard(false);cardLocal.onclick=()=>void finishCard(true);cardBack.onclick=()=>void backToDrawing();
    cardOpen.onclick=()=>void enterConversation();cardDone.onclick=()=>void exitDialog();
    row.append(cardSend,cardDraft,cardLocal,cardBack,cardOpen,cardDone);
    cardPanel.append(title,cardHint,cardThreadEl,cardText,cardStatusLine,row);
    cardBox.append(cardImage,cardOverlay);
    card.append(cardBox,cardPanel);
    dialog.append(card);
    window.addEventListener('resize',()=>{if(cardState&&!card.hidden)layoutCard();});
  }
  function layoutCard(){
    if(!cardState||!card)return;
    const margin=12,top=48,drawing=cardState.drawing;
    const k=Math.min((innerWidth-2*margin)/drawing.width,(innerHeight-top-margin-24)/drawing.height);
    const width=Math.max(1,drawing.width*k),height=Math.max(1,drawing.height*k),left=(innerWidth-width)/2,boxTop=top+(innerHeight-top-margin-height-24)/2;
    cardState.view={left,top:boxTop,width,height,k};
    Object.assign(cardBox.style,{left:left+'px',top:boxTop+'px',width:width+'px',height:height+'px'});
    const panelWidth=cardPanel.getBoundingClientRect().width||Math.min(340,innerWidth-2*margin),panelHeight=cardPanel.offsetHeight,rect=cardState.rect;
    let px=rect?left+(rect[0]+rect[2])*width+12:left+width/2-panelWidth/2;
    let py=rect?boxTop+(rect[1]+rect[3])*height+12:boxTop+height-panelHeight-16;
    if(panelHeight){
      if(py+panelHeight>innerHeight-margin)py=rect?boxTop+rect[1]*height-panelHeight-12:boxTop+16;
      if(py<margin)py=margin;
    }
    px=Math.min(Math.max(px,margin),Math.max(margin,innerWidth-panelWidth-margin));
    Object.assign(cardPanel.style,{left:px+'px',top:py+'px'});
  }
  function openCard(t,drawing,png){
    cardState={target:t,drawing,png,rect:strokeRect(drawing),delivery:null,finalized:false,finalizeFailed:false};
    ensureCard();ensureDiscussion();
    // A recovered receipt (failed direct send, or a pending delivery from an
    // earlier dialog) reopens the card with its thread state: the committed
    // attachment rides along so 重试发送/续问 reuse the original digest, and
    // the retained draft's thread (persisted per accepted round) merges with
    // the receipt's — the longer, append-only history wins, so a crash before
    // the receipt finalize still reopens with every round and its requestId.
    // A local-only receipt (仅保存本地) hands nothing off: the card reopens in
    // compose mode with its stored question.
    const receipt=sessionReceipt&&sessionReceipt.state!=='local'?sessionReceipt:null;
    const draftRounds=t.card?.thread||[];
    if(receipt?.attachment){
      const receiptRounds=receipt.card?.thread||[];
      cardState.delivery={deliveryId:receipt.id||receipt.deliveryId||session.captureId,attachment:receipt.attachment,state:receipt.state||'pending-delivery'};
      cardState.finalized=receipt.state==='delivered';
      discussion.adopt(draftRounds.length>=receiptRounds.length?draftRounds:receiptRounds);
    }else if(draftRounds.length)discussion.adopt(draftRounds);
    else discussion.reset();
    cardSend.disabled=cardDraft.disabled=cardLocal.disabled=cardBack.disabled=cardOpen.disabled=cardDone.disabled=false;
    cardText.readOnly=false;
    cardImage.src=t.regionImage.dataUrl;
    const svg=drawingSvg(drawing);Object.assign(svg.style,{position:'absolute',inset:'0',width:'100%',height:'100%'});
    cardOverlay.replaceChildren(svg);
    // With accepted rounds the retained question is the last sent one; a
    // receipt without rounds (pending delivery, e.g. a recovered draft
    // hand-off) keeps its stored question as the retry text.
    cardText.value=t.card?.message??cardMessageDraft;
    if(cardState.delivery)cardText.value=discussion.message()||t.card?.message||'';
    cardSavedText=cardState.delivery?(discussion.message()||t.card?.message||'').trim():cardText.value.trim();cardSavedRect=cardState.rect??null;
    // Screenshot-bound anchor presentation: frozen source + stroke position.
    // Never a file anchor — viewport-only sources carry no file identity.
    const position=t.card?.rect||cardState.rect;
    cardHint.textContent='冻结来源 · '+(t.sourceSummary||'工作区截图 · 视口来源，非精确文件选区')+(position?` · 笔迹位置 ${Math.round(position[0]*100)}%,${Math.round(position[1]*100)}%（占画面 ${Math.round(position[2]*100)}%×${Math.round(position[3]*100)}%）`:' · 未画笔迹');
    recoverRow.hidden=true;
    card.hidden=false;layoutCard();
    status(cardState.delivery?'完成 · 讨论已交接；回复会显示在卡片与对话':'完成 · 可发送讨论，或补充说明后加入对话草稿');
    renderThreadCard();
    cardText.focus();
  }
  // One explicit 发送讨论 click = commit + send. The direct commit stores the
  // material and a pending-delivery receipt without routing the image into the
  // conversation draft (the sent message replaces the draft chip) and keeps
  // the capture session alive; the managed send goes through the existing
  // image-attachment chain; the finalize commit marks the receipt delivered
  // with its requestId association and ends the session. Every step is
  // idempotent: unchanged retries reuse the delivery id and requestKey, and a
  // refused gate never commits anything.
  async function sendDiscussion(){
    const state=cardState,active=session;
    if(!state||sending)return;
    if(cardText.dataset.composing==='true'){cardStatus('输入法组合尚未结束，请完成输入后再发送。','error');return;}
    if(discussion?.pending())return;
    const question=cardText.value.trim()||'请查看这张工作面涂鸦截图。';
    const gate=await transport.gate();
    if(!gate?.ok){const message=gate?.message||'发送未发出：Agent 尚未就绪。';cardStatus(message,'error');toast(message);return;}
    sending=true;setCardBusy(true);
    cardStatus('正在发送讨论…');
    try{
      if(!state.delivery){
        const flushed=await flushWrite();if(!flushed.ok)throw flushed.error;
        // Late results stay scoped to the session that started them: if the host
        // ended or replaced the session meanwhile, its teardown already ran.
        if(session!==active||cardState!==state)return;
        // target.card carries the discussion anchor + text on both paths, so
        // crash/local recovery reopens the card intact; nothing auto-sends.
        const committed=await call('workspace.capture.commit',{captureId:active.captureId,png:state.png,drawing:state.drawing,target:{...structuredClone(state.target),card:cardInfo(state,question)},local:false,direct:true});
        if(session!==active||cardState!==state)return;
        if(!committed?.attachment||!committed.deliveryId)throw Error('直发回执未返回附件身份');
        state.delivery={deliveryId:committed.deliveryId,attachment:committed.attachment,state:committed.state||'pending-delivery'};
        cardSavedText=question;cardSavedRect=state.rect??null;
      }
      const delivery=state.delivery;
      const round=(discussion.thread.history?.length||0)+1;
      const requestKey='snap-'+String(delivery.deliveryId).replace(/[^a-zA-Z0-9:_-]/g,'_')+'-'+round;
      const sent=await transport.send({text:question,imageAttachments:[{...delivery.attachment,deliveryId:delivery.deliveryId}],requestKey});
      if(sent===false||!sent?.accepted){cardStatus('发送未发出：会话未就绪或被拒绝；输入已保留，可重试。','error');return;}
      discussion.record(question,sent.requestId);
      // (retained-message bookkeeping resets below to force the round persist)
      cardText.value='';cardMessageDraft='';
      // Persist the accepted round immediately (belt) into the retained draft:
      // a crash before the receipt finalize below still reopens with the full
      // thread via the recovery draft.
      cardSavedText=null;changeSeq++;
      clearTimeout(saveTimer);saveTimer=setTimeout(()=>void enqueueWrite(),150);
      // Per-round receipt finalize (braces): associate the newest requestId,
      // persist the full thread onto the receipt and mark it delivered. The
      // capture session stays alive until the card's completion paths — 续问
      // therefore never re-commits the material, reuses the committed digest,
      // and a later round simply refreshes the same receipt.
      if(active){
        let finalizeError=null;
        try{
          await call('workspace.capture.commit',{captureId:active.captureId,png:state.png,drawing:state.drawing,target:{...structuredClone(state.target),card:cardInfo(state,discussion.message())},local:false,direct:true,requestId:sent.requestId});
        }catch(error){finalizeError=error;}
        if(cardState!==state)return;
        if(finalizeError){
          delivery.state='pending-delivery';state.finalized=false;state.finalizeFailed=true;
          toast('已发送，但回执保存失败：'+(finalizeError.message||finalizeError));
        }else{
          delivery.state='delivered';state.finalized=true;state.finalizeFailed=false;
          toast('讨论已发送；回复会显示在卡片与对话时间线');
        }
      }else{
        cardStatus('已发送 · 等待前台回复…');
        toast('讨论已发送；回复会显示在卡片与对话时间线');
      }
      void discussion.refresh();
      renderThreadCard();
    }catch(error){
      cardStatus('发送失败：'+(error?.message||error)+' · 输入已保留，重试不会重复投递','error');
      toast('发送失败：'+(error?.message||error));
    }finally{
      sending=false;
      if(cardState)setCardBusy(false);
      if(cardState===state)renderThreadCard();
    }
  }
  async function finishCard(local){
    const state=cardState,active=session;
    if(!state||!active)return;
    if(cardText.dataset.composing==='true'){status('输入法组合尚未结束，请完成输入后再交接。');return;}
    const message=cardText.value.trim();
    cardMessageDraft=message;
    setCardBusy(true);
    try{
      const flushed=await flushWrite();if(!flushed.ok)throw flushed.error;
      // Late results stay scoped to the session that started them: if the host
      // ended or replaced the session meanwhile, its teardown already ran.
      if(session!==active||cardState!==state)return;
      // target.card carries the discussion anchor + text on both paths, so
      // crash/local recovery reopens the card intact; nothing auto-sends.
      await call('workspace.capture.commit',{captureId:active.captureId,png:state.png,drawing:state.drawing,target:{...structuredClone(state.target),card:cardInfo(state,message)},local:Boolean(local)});
      if(session!==active||cardState!==state)return;
      session=null;cardState=null;lastDrawing=null;lastDrawingDirty=false;saveError=null;cardMessageDraft='';cardSavedText=null;cardSavedRect=null;
      hideCard();editor.suspend?.();closeDialogEl();status('');
      toast(local?'涂鸦与讨论卡已保存为本机记录，可稍后从恢复选择器打开':'涂鸦图片已加入对话草稿，发送仍需在对话中确认');
    }catch(e){
      // Failed retention never closes the dialog.
      cardText.readOnly=false;
      toast('完成失败：'+e.message);
      if(cardState===state)setCardBusy(false);
    }
  }
  async function backToDrawing(){
    const state=cardState;if(!state)return;
    const message=cardMode()==='compose'?cardText.value.trim():discussion?.message()||'';
    cardMessageDraft=cardMode()==='compose'?message:'';
    // Fold the card's newest message/anchor into the retained target BEFORE
    // the editor restarts: autosave, re-finish and the quit-time flush all
    // persist `target` (cardState is null from here on), so the stale
    // pre-card text must never ride along and overwrite the newer one.
    const retained={...structuredClone(state.target),drawing:state.drawing,card:cardInfo(state,message)};
    target=retained;lastDrawingDirty=true;changeSeq++;
    clearTimeout(saveTimer);saveTimer=setTimeout(()=>void enqueueWrite(),200);
    cardState=null;hideCard();
    try{
      await editor.start({...retained,drawing:state.drawing});
      lastDrawing=editor.snapshot()?.drawing||state.drawing;
      renderRecoverable();
      status('已返回笔迹编辑');
    }catch(e){
      cardState=state;card.hidden=false;layoutCard();
      toast('返回笔迹失败：'+e.message);
    }
  }
  function hideCard(){if(card)card.hidden=true;}

  async function exitDialog(){
    if(exiting)return false;
    const active=session;
    if(!active)return teardown();
    exiting=true;
    try{
      const flushed=await flushWrite();
      if(session!==active)return false;
      // Failed retention never closes the dialog and never discards: the
      // fullscreen editor stays live (the false veto keeps its strokes, dirty
      // revision and error state intact), the session and input are untouched,
      // and the user retries explicitly.
      if(!flushed.ok){
        status('笔迹保存失败：'+flushed.error.message+' · 未落盘笔迹不会丢失，请重试退出');
        return false;
      }
      try{await call('workspace.capture.cancel',{captureId:active.captureId});}
      catch(e){status('会话保留于恢复库：'+e.message);}
      if(session===active)teardown();
    }finally{exiting=false;}
  }
  function teardown(){
    session=null;target=null;cardState=null;lastDrawing=null;lastDrawingDirty=false;saveError=null;changeSeq=0;cardMessageDraft='';cardSavedText=null;cardSavedRect=null;sessionReceipt=null;
    clearTimeout(saveTimer);
    resetDiscussion();
    hideCard();editor?.suspend?.();closeDialogEl();status('');
  }

  async function open(){
    ensure();
    if(opening||dialog.open)return;
    opening=true;
    try{
      const projectId=getProjectId();
      if(!projectId){toast('请先打开项目');return;}
      resetDiscussion();
      session=await call('workspace.capture.begin',{});
      sessionReceipt=session.receipt||null;
      // A previous exit left the session active with strokes on disk but no
      // draft on the in-memory descriptor: reload from the store, never recapture.
      if(!session.drawingDraft){
        try{const reloaded=await call('workspace.capture.recover',{captureId:session.captureId,id:session.captureId});if(reloaded?.captureId){session=reloaded;sessionReceipt=session.receipt||null;}}catch{}
      }
      await compose();renderRecoverable();
      dialog.showModal();
      await startEditor(session.drawingDraft?'已恢复上次未完成的笔迹':'冻结画面完成 · 完成后打开位置讨论卡，图片不自动发送'+(session.omittedWindowCount>0?' · 另有 '+session.omittedWindowCount+' 个本项目窗口未纳入':''));
    }catch(e){toast(e.message);}finally{opening=false;}
  }

  // Parent wiring (app.mjs owns the session.flush/quit integration):
  // flush() inside the flush handler retains pending strokes on quit/recovery;
  // close() is the best-effort quit teardown. Neither throws.
  async function flush(){
    if(!session)return {ok:true};
    if(cardText?.dataset.composing==='true')return {ok:false,error:{code:'COMPOSING',message:'讨论说明的输入法组合尚未结束。'}};
    const result=await flushWrite();
    return result.ok?{ok:true}:{ok:false,error:{code:'DRAWING_RETAIN_FAILED',message:result.error.message}};
  }
  async function close(){
    if(!session){teardown();return {ok:true};}
    // Quit teardown happens only after a successful flush; a failed retain
    // keeps the dialog visible with its error status — no silent discard.
    const result=await flushWrite();
    if(!result.ok)return {ok:false,error:{code:'DRAWING_RETAIN_FAILED',message:result.error.message}};
    const active=session;
    try{await call('workspace.capture.cancel',{captureId:active.captureId});}catch{}
    if(session===active)teardown();
    return {ok:true};
  }
  return {open,flush,close};
}
