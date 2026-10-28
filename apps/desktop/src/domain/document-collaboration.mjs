import {ChangeSet, Text} from '@codemirror/state';

const conflict = message => {throw Object.assign(new Error(message),{code:'STALE_VERSION'});};
const intersects = (from,to,start,end) => from===to ? from>start&&from<end : from<end&&to>start;

// Follow certified ledger transactions, never quote-search a later document.
export function rebaseDocumentEdits(read, ledger, edits, contexts = []) {
  if(ledger.docId!==read.docId)conflict('文档身份已变化，请重新读取。');
  if(ledger.revision<read.revision)conflict('文档历史已变化，请重新读取。');
  let text=read.text,digest=read.digest;
  let mapped=edits.map(edit=>({...edit}));
  // Whole edit lines stay protected; internal contexts (programmatic callers or
  // resolver contextBefore/contextAfter spans) add required-unchanged ranges on top.
  let protectedRanges=[
    ...edits.map(edit=>({
      from:edit.from===0?0:text.lastIndexOf('\n',edit.from-1)+1,
      to:(()=>{const end=text.indexOf('\n',edit.to);return end<0?text.length:end;})(),
    })),
    ...contexts.map(range=>({...range})),
  ];
  for(const range of protectedRanges)if(!Number.isSafeInteger(range.from)||!Number.isSafeInteger(range.to)||range.from<0||range.to<range.from||range.to>text.length)throw Object.assign(new Error('上下文范围无效。'),{code:'INVALID_PAYLOAD'});
  const events=ledger.events.filter(event=>event.revision>read.revision);
  if(events.length!==ledger.revision-read.revision)conflict('读取基线的变更链不完整，请重新读取。');
  for(const event of events){
    if(event.beforeDigest!==digest)conflict('读取基线的变更链不连续，请重新读取。');
    for(const edit of event.edits){
      if(text.slice(edit.from,edit.to)!==edit.removed)conflict('变更记录与读取原文不一致。');
      for(const target of [...mapped,...protectedRanges])if(intersects(edit.from,edit.to,target.from,target.to))conflict('目标或必要上下文已变化；候选已保留，请重新读取。');
    }
    const changes=ChangeSet.of(event.edits.map(edit=>({from:edit.from,to:edit.to,insert:edit.insert})),text.length);
    mapped=mapped.map(edit=>({...edit,from:changes.mapPos(edit.from,1),to:changes.mapPos(edit.to,edit.from===edit.to?1:-1)}));
    protectedRanges=protectedRanges.map(range=>({from:changes.mapPos(range.from,1),to:changes.mapPos(range.to,-1)}));
    text=changes.apply(Text.of(text.split('\n'))).toString();digest=event.afterDigest;
  }
  if(text!==ledger.text||digest!==ledger.digest)conflict('当前正文与变更链不一致，请重新读取。');
  return mapped;
}

export function documentChangesSince(read, ledger) {
  const events=ledger.events.filter(event=>event.revision>read.revision);
  return {fromVersion:{docId:read.docId,revision:read.revision,digest:read.digest},
    currentVersion:{docId:ledger.docId,revision:ledger.revision,digest:ledger.digest},
    requiresRead:ledger.docId!==read.docId||events.length!==ledger.revision-read.revision||events.length>32||events.some(event=>event.edits.length>16||event.edits.some(edit=>edit.removed.length>256||edit.insert.length>256)),
    events:events.slice(-32).map(event=>({eventId:event.id,revision:event.revision,actor:event.actor,type:event.type,
      edits:event.edits.slice(0,16).map(edit=>({from:edit.from,to:edit.to,newFrom:edit.newFrom,newTo:edit.newTo,removed:edit.removed.slice(0,256),insert:edit.insert.slice(0,256)}))})),
    omittedEvents:Math.max(0,events.length-32)};
}

const surrogatePairSplit=(text,at)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at]);
const quote=value=>JSON.stringify(String(value).slice(0,120)).slice(1,-1);
const lineAt=(text,offset)=>text.slice(0,offset).split('\n').length;
const occurrencePreview=(text,from,to)=>({line:lineAt(text,from),text:JSON.stringify(text.slice(Math.max(0,from-40),Math.min(text.length,to+40))).slice(1,-1)});
// Overlapping occurrences count separately: 'aa' occurs twice in 'aaa'.
const countOccurrences=(text,needle,cap=50)=>{let count=0;for(let offset=text.indexOf(needle);offset!==-1&&count<=cap;offset=text.indexOf(needle,offset+1))count++;return count;};

// Model-facing write contract: agents quote exact text, never UTF-16 offsets.
// The host resolves every quote against the read snapshot behind the handle, so
// positions stay host-derived while CAS, rebase and authorship checks hold.
export function resolveTextReplacements(text, replacements, {maxItems=1000,reportMatches=5,scanCap=50}={}){
  const reject=(code,message,details)=>{throw Object.assign(new Error(message),{code,details:details||{}});};
  if(!Array.isArray(replacements)||replacements.length<1||replacements.length>maxItems)
    reject('INVALID_PAYLOAD',`replacements必须是1至${maxItems}项{oldText,newText,contextBefore?,contextAfter?}精确文本替换数组；模型不再提交UTF-16偏移。`,{received:Array.isArray(replacements)?replacements.length:null,reason:'shape'});
  const resolved=[],contextRanges=[];
  for(let index=0;index<replacements.length;index++){
    const item=replacements[index],ordinal=`第${index+1}项替换`;
    if(!item||typeof item!=='object'||Array.isArray(item))reject('INVALID_PAYLOAD',`${ordinal}必须是对象。`,{index,reason:'shape'});
    const oldText=item.oldText,newText=item.newText,before=item.contextBefore??'',after=item.contextAfter??'';
    if(typeof oldText!=='string'||typeof newText!=='string'||typeof before!=='string'||typeof after!=='string')
      reject('INVALID_PAYLOAD',`${ordinal}的oldText/newText/contextBefore/contextAfter必须是字符串，其中oldText与newText必填。`,{index,reason:'shape'});
    if(oldText===''&&before===''&&after==='')reject('INVALID_PAYLOAD',`${ordinal}的oldText为空：纯插入必须提供contextBefore或contextAfter以唯一定位插入点。`,{index,reason:'shape'});
    const fits=offset=>(before===''||(offset>=before.length&&text.startsWith(before,offset-before.length)))&&(after===''||text.startsWith(after,offset+oldText.length));
    const hits=[];
    if(oldText===''){for(let offset=0;offset<=text.length&&hits.length<=scanCap;offset++)if(fits(offset))hits.push(offset);}
    else{for(let offset=text.indexOf(oldText);offset!==-1&&hits.length<=scanCap;offset=text.indexOf(oldText,offset+1))if(fits(offset))hits.push(offset);}
    if(hits.length===0){
      if(oldText!==''){
        const normalized=oldText.replace(/\r\n?/g,'\n');
        if(normalized!==oldText&&text.includes(normalized))reject('REPLACEMENT_NOT_FOUND',`${ordinal}的oldText含回车（CRLF），读取正文已按LF规整；请从nozeli_document_read返回的text原样复制LF原文。`,{index,reason:'crlf',oldTextHead:quote(oldText)});
        const bare=countOccurrences(text,oldText,scanCap);
        if(bare>0)reject('REPLACEMENT_NOT_FOUND',`${ordinal}的oldText出现${bare>scanCap?'多于'+scanCap:bare}次，但与contextBefore/contextAfter组合后无处匹配；上下文必须是紧邻oldText前后的读取原文。`,{index,reason:'context',oldTextCount:bare});
      }
      reject('REPLACEMENT_NOT_FOUND',`${ordinal}的oldText未在读取正文中找到（或纯插入点无法定位）；请从read返回的text原样复制目标段（注意空白、引号、全半角与换行），不要凭记忆重写。`,{index,reason:'not_found',oldTextHead:quote(oldText)});
    }
    if(hits.length>1)reject('REPLACEMENT_AMBIGUOUS',`${ordinal}的oldText匹配到${hits.length>scanCap?'多于'+scanCap:hits.length}处，拒绝执行以防改错位置；请加长oldText或补充紧邻的contextBefore/contextAfter使其唯一。`,{index,reason:'ambiguous',matchCount:hits.length,matches:hits.slice(0,reportMatches).map(offset=>occurrencePreview(text,offset,offset+oldText.length))});
    const from=hits[0],to=from+oldText.length;
    if(surrogatePairSplit(text,from)||surrogatePairSplit(text,to))reject('INVALID_PAYLOAD',`${ordinal}的oldText边界切开了代理对（emoji等增补字符）；请以完整字符为单位复制原文。`,{index,reason:'split_surrogate'});
    resolved.push({index,edit:{from,to,insert:newText.replace(/\r\n?/g,'\n'),...(oldText?{expected:oldText}:{})}});
    if(before)contextRanges.push({from:from-before.length,to:from});
    if(after)contextRanges.push({from:to,to:to+after.length});
  }
  resolved.sort((a,b)=>a.edit.from-b.edit.from||a.index-b.index);
  for(let position=1;position<resolved.length;position++){
    const previous=resolved[position-1],current=resolved[position];
    if(current.edit.from<=Math.max(previous.edit.from,previous.edit.to-1))
      reject('INVALID_PAYLOAD',`第${current.index+1}项与第${previous.index+1}项替换的匹配区间重叠（位置${current.edit.from}）；请合并为一次替换或修正oldText。`,{reason:'overlap',items:[previous.index+1,current.index+1]});
  }
  // Edits carry resolved UTF-16 positions; contexts are the read-text spans the
  // caller's contextBefore/contextAfter cover. Hosts feed both into rebase
  // protection so concurrent changes inside a quoted context force STALE_VERSION.
  return {edits:resolved.map(entry=>entry.edit),contexts:contextRanges};
}
