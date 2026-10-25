import {setIconButton} from './ui-icons.mjs';
import { changeRecord, mapAttribution, userActor } from '../domain/document-changes.mjs';
import { textChangeSet, anchorText } from '../domain/tag-anchors.mjs';
import { sourceLeaves } from './markdown-source.mjs';
import { groupAuthorship, groupScope, groupTitle } from '../domain/authorship-groups.mjs';
import { authorshipLayer } from './authorship-gutter.mjs';
import './document-authorship.css';

export function mountDocumentAuthorship({current,invoke,reload,toast,onCompare}) {
  let working=null,source='',confirmed=null,pendingChanges=null,visible=true,polling=false,historyToken=0,markdownLayer=null,returnFocus=null;
  try {visible=localStorage.getItem('nozeli.authorship.visible')!=='false';}catch{}
  const dialog=document.createElement('dialog');dialog.id='document-change-history';dialog.className='document-change-history';
  const header=document.createElement('header'),heading=document.createElement('strong'),close=document.createElement('button');
  heading.id='change-history-heading';dialog.setAttribute('aria-labelledby',heading.id);close.type='button';setIconButton(close,'close');close.setAttribute('aria-label','关闭修改记录');header.append(heading,close);
  const legend=document.createElement('p');legend.className='authorship-legend';
  for(const [kind,label]of [['user','你'],['agent1','Agent1'],['agent2','Agent2'],['external','外部修改']]){const labelNode=document.createElement('span');labelNode.className='authorship-'+kind;labelNode.textContent=label;legend.append(labelNode);}
  const content=document.createElement('div');content.className='change-history-list';dialog.append(header,legend,content);document.body.append(dialog);
  close.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{
    historyToken++;
    // The browser restores the opener immediately. A delayed close event must
    // not steal focus after the person has already returned to the editor.
    if(document.activeElement===document.body||dialog.contains(document.activeElement)){
      if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});else current()?.editor?.adapter.focus?.();
    }
    returnFocus=null;
  });
  const notice=document.createElement('div');notice.id='document-new-version';notice.className='document-new-version';notice.hidden=true;
  const noticeText=document.createElement('span'),load=document.createElement('button'),inspect=document.createElement('button');load.type=inspect.type='button';load.textContent='重新载入';inspect.textContent='查看修改';notice.append(noticeText,inspect,load);
  document.getElementById('reader-scroll').before(notice);
  load.addEventListener('click',()=>{const file=current();if(file?.dirty)return toast('先处理当前草稿，未覆盖你的输入。');void reload(file.relPath);});inspect.addEventListener('click',()=>void history());
  const toggle=document.createElement('button'),historyButton=document.createElement('button');toggle.type=historyButton.type='button';toggle.id='authorship-toggle';historyButton.id='authorship-history';historyButton.textContent='当前文件修改记录…';
  const caption=document.createElement('span');caption.className='menu-caption';caption.textContent='修改来源';document.getElementById('font-menu').append(caption,toggle,historyButton);
  toggle.addEventListener('click',()=>setVisible(!visible));historyButton.addEventListener('click',()=>void history());
  window.nozeli.subscribe('menu.action',action=>{if(action==='authorship-toggle')setVisible(!visible);if(action==='authorship-history')void history();});
  window.nozeli.subscribe('document',event=>{const file=current();if(file?.projectId===event.projectId&&file?.relPath===event.relPath)void probe().catch(()=>{});});
  window.nozeli.subscribe('workspace.control',event=>{if(event.type==='authorship-visibility'){visible=event.visible;visibilityChanges++;updateVisibility();render();}});
  let layoutFrame=0;
  const scheduleProjection=()=>{cancelAnimationFrame(layoutFrame);layoutFrame=requestAnimationFrame(projectMarkdown);};
  const resize=new ResizeObserver(scheduleProjection);resize.observe(document.getElementById('text-preview'));
  document.getElementById('reader-scroll').addEventListener('scroll',scheduleProjection,{passive:true,capture:true});
  window.addEventListener('nozeli-layout-change',scheduleProjection);
  function updateVisibility(){toggle.textContent=(visible?'✓ ':'')+'显示修改者';toggle.setAttribute('aria-pressed',String(visible));}
  let visibilityChanges=0;
  function setVisible(value){visible=value;visibilityChanges++;try{localStorage.setItem('nozeli.authorship.visible',String(visible));}catch{}updateVisibility();render();void invoke('view.authorship',{visible}).then(result=>{if(!result.ok)toast('修改者显示设置未能保存：'+result.error.message);}).catch(error=>toast(error.message));}
  function render(){current()?.editor?.adapter.setAuthorship?.(working,{visible,source,onOpen:group=>void history(group)});projectMarkdown();}
  function projectMarkdown(){
    const preview=document.getElementById('text-preview');
    if(!visible||!working||current()?.kind==='word'||preview.hidden){markdownLayer?.node.remove();return;}
    if(!markdownLayer)markdownLayer=authorshipLayer('markdown-authorship',group=>void history(group));
    if(markdownLayer.node.parentElement!==preview)preview.append(markdownLayer.node);
    const blocks=new Map();
    for(const leaf of sourceLeaves(preview)){
      const block=leaf.closest('pre,td,th')||leaf.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote')||leaf;
      const from=Number(leaf.dataset.mdFrom),to=Number(leaf.dataset.mdTo);
      if(!Number.isInteger(from)||!Number.isInteger(to)||from>=to)continue;
      const unit=blocks.get(block);
      if(unit){unit.from=Math.min(unit.from,from);unit.to=Math.max(unit.to,to);}
      else {
        const structural=block.matches('pre,td,th,h1,h2,h3,h4,h5,h6');
        const container=structural?block:block.closest('li')?.parentElement||block.closest('blockquote')||block.parentElement;
        blocks.set(block,{node:block,from,to,boundary:container});
      }
    }
    const units=[...blocks.values()].sort((a,b)=>a.from-b.from),groups=groupAuthorship(units,working);
    const base=preview.getBoundingClientRect(),viewport=(preview.closest('#markdown-preview-scroll')||document.getElementById('reader-scroll')).getBoundingClientRect();
    markdownLayer.node.style.setProperty('--authorship-width',Math.max(15,Math.min(23,parseFloat(getComputedStyle(preview).paddingLeft)-4))+'px');
    const top=Math.max(0,viewport.top-base.top),bottom=viewport.bottom-base.top;
    const fragments=[];
    for(const group of groups){
      const first=group.units[0].node.getBoundingClientRect(),last=group.units.at(-1).node.getBoundingClientRect();
      const start=first.top-base.top+2,end=group.kind==='deletion'?start+18:last.bottom-base.top;
      if(end<=top||start>=bottom)continue;
      fragments.push({group,top:Math.max(top,start),height:Math.min(bottom,end)-Math.max(top,start),continuation:start<top});
    }
    markdownLayer.draw(fragments);
  }
  function accept(authorship,text){working=authorship?structuredClone(authorship):null;confirmed=working;pendingChanges=null;source=anchorText(text||'');notice.hidden=true;render();}
  function changed({before,text,changes}){
    if(!working)return;
    if(anchorText(before)!==source){working=null;pendingChanges=null;source=anchorText(text);render();return;}
    const event=changeRecord(before,text,changes,{id:'pending:'+working.docId,actor:userActor,time:new Date().toISOString(),revision:working.revision+1,beforeDigest:working.digest,afterDigest:null});
    const events=new Map([...working.spans,...working.points].map(item=>[item.eventId,item]));events.set(event.id,{actor:event.actor,time:event.time,revision:event.revision,pending:true});
    const mapped=mapAttribution(working.spans,working.points,changes,event),decorate=item=>({...events.get(item.eventId),...item});
    pendingChanges=pendingChanges?pendingChanges.compose(changes):changes;
    working={...working,spans:mapped.spans.map(decorate),points:mapped.points.map(decorate)};source=text;queueMicrotask(render);
  }
  function opened(file){
    if(dialog.open)dialog.close();historyToken++;accept(file?.authorship,file?.text);
    if(file?.draft&&working){const text=anchorText(file.draft.text);changed({before:source,text,changes:textChangeSet(source,text)});}
    if(file?.authorshipError)toast('修改来源暂不可用：'+file.authorshipError.message);
  }
  function cleared(){working=confirmed=null;pendingChanges=null;source='';notice.hidden=true;if(dialog.open)dialog.close();historyToken++;markdownLayer?.node.remove();markdownLayer=null;}
  async function history(selection=null){
    const file=current();if(!file||!file.editor)return toast('先打开文本或 Word 文件查看修改记录。');
    const token=++historyToken,identity=file.projectId+'\0'+file.relPath;
    const group=typeof selection==='object'?selection:null,eventId=typeof selection==='string'?selection:null;
    const savedItems=group?.items.filter(item=>!item.pending)||[];
    let scope=group?groupScope(group):null;
    if(scope){
      scope.eventIds=savedItems.map(item=>item.eventId);
      if(pendingChanges){const inverse=pendingChanges.invertedDesc;
        scope.from=inverse.mapPos(group.from,-1);scope.to=group.kind==='deletion'?scope.from:inverse.mapPos(group.to,1);
      }
    }
    heading.textContent=(group?'这段修改记录':'修改记录')+' · '+file.relPath;content.replaceChildren();
    if(group){const summary=document.createElement('p');summary.className='change-history-scope';summary.textContent=groupTitle(group);content.append(summary);}
    if(group||eventId){const all=document.createElement('button');all.type='button';all.className='change-history-all';all.textContent='当前文件全部修改';all.addEventListener('click',()=>void history());content.append(all);}
    if(group?.pending||eventId?.startsWith('pending:')){const hint=document.createElement('p');hint.className='change-history-pending';hint.textContent='含未保存输入；此部分尚无确认修改时间。下面仅展示已保存批次。';content.append(hint);}
    if(!dialog.open){returnFocus=document.activeElement;dialog.showModal();}
    if(group&&!savedItems.length||eventId?.startsWith('pending:'))return;
    const loading=document.createElement('p');loading.textContent='正在读取…';content.append(loading);
    const more=document.createElement('button');more.type='button';more.className='change-history-more';
    let cursor=null,count=0;
    const loadPage=async()=>{
      more.disabled=true;
      let result;
      try{result=await invoke('document.history',{projectId:file.projectId,relPath:file.relPath,eventId,scope,cursor,limit:50});}
      catch(error){result={ok:false,error:{message:error.message}};}
      const next=current();if(token!==historyToken||!next||next.projectId+'\0'+next.relPath!==identity)return;
      loading.remove();more.remove();
      if(!result.ok){const error=document.createElement('p');error.className='change-history-error';error.textContent=result.error.message;content.append(error);return;}
      if(!result.value.events.length&&!count){const empty=document.createElement('p');empty.textContent=group?'这段没有已保存批次。':'还没有修改记录。已有内容的原作者未确认。';content.append(empty);}
      for(const event of result.value.events){appendEvent(event,result.value.authorship.docId);count++;}
      cursor=result.value.nextCursor;
      if(cursor){more.textContent=`已显示${count} / ${result.value.total}批 · 加载更早记录`;more.disabled=false;content.append(more);}
    };
    more.addEventListener('click',()=>void loadPage());await loadPage();
  }
  function appendEvent(event,docId){
      const entry=document.createElement('article');entry.className='change-history-entry';entry.dataset.eventId=event.id;
      const summary=document.createElement('div');summary.className='change-history-summary';const actor=document.createElement('span');actor.className='authorship-'+event.actor.kind;actor.textContent=event.actor.name;
      const time=document.createElement('time');time.dateTime=event.time;time.textContent=new Date(event.time).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+(event.actor.kind==='external'?' · 检测时间':'');summary.append(actor,time);entry.append(summary);
      if(onCompare&&current()?.kind!=='word'){const compare=document.createElement('button');compare.type='button';compare.className='change-history-compare';compare.textContent=`对比v${event.revision}`;compare.title='与当前内容对比此批修改后的版本';compare.addEventListener('click',()=>{dialog.close();onCompare({docId,revision:event.revision,digest:event.afterDigest});});summary.append(compare);}
      for(const edit of event.edits){
        const location=document.createElement('small');location.textContent='当时第 '+(edit.line||1)+(current()?.kind==='word'?' 个正文段落/文本行':' 行');entry.append(location);
        for(const [kind,text]of [['removed',edit.removed],['inserted',edit.insert]])if(text){const pre=document.createElement('pre');pre.className='change-'+kind;pre.textContent=(kind==='removed'?'− ':'＋ ')+text;entry.append(pre);}
      }
      if(!event.edits.length){const hint=document.createElement('p');hint.textContent=current()?.kind==='word'?'文档格式、排版或包结构变化，正文文本相同。':'文件编码或换行改变，正文内容相同。';entry.append(hint);}
      content.append(entry);
  }
  async function probe(){
    const file=current();if(polling||!file?.editor||document.hidden)return;polling=true;
    try{
      const result=await invoke('document.status',{projectId:file.projectId,relPath:file.relPath}),next=current();
      if(!result.ok||next?.projectId!==file.projectId||next?.relPath!==file.relPath)return;
      if(result.value.deleted){noticeText.textContent='原文件已在外部删除，当前内容保留。';notice.hidden=false;load.disabled=true;return;}
      const incoming=result.value.authorship;if(!incoming)return;
      if(incoming.digest!==next.digest){noticeText.textContent=(incoming.lastChange?.actor.name||'外部程序')+'已修改此文档'+(next.dirty?'；你的草稿保留。':'。');notice.hidden=false;load.disabled=Boolean(next.dirty);}
    }finally{polling=false;}
  }
  updateVisibility();setInterval(()=>void probe().catch(()=>{}),2500);
  const ready=invoke('view.authorship',{}).then(result=>{
    if(!result.ok){toast('修改者显示设置未能读取：'+result.error.message);return;}
    if(!visibilityChanges){visible=result.value.visible;updateVisibility();render();}
  }).catch(error=>toast(error.message));
  return {ready,opened,cleared,changed,saved:accept,projectMarkdown,render,history,isVisible:()=>visible,toggle:()=>setVisible(!visible)};
}
