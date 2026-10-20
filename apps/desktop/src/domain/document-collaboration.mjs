import {ChangeSet, Text} from '@codemirror/state';

const conflict = message => {throw Object.assign(new Error(message),{code:'STALE_VERSION'});};
const intersects = (from,to,start,end) => from===to ? from>start&&from<end : from<end&&to>start;

// Follow certified ledger transactions, never quote-search a later document.
export function rebaseDocumentEdits(read, ledger, edits, contexts = []) {
  if(ledger.docId!==read.docId)conflict('文档身份已变化，请重新读取。');
  if(ledger.revision<read.revision)conflict('文档历史已变化，请重新读取。');
  let text=read.text,digest=read.digest;
  let mapped=edits.map(edit=>({...edit}));
  let protectedRanges=contexts.length?contexts.map(range=>({...range})):edits.map(edit=>({
    from:edit.from===0?0:text.lastIndexOf('\n',edit.from-1)+1,
    to:(()=>{const end=text.indexOf('\n',edit.to);return end<0?text.length:end;})(),
  }));
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
