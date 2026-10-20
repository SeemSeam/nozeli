// DOCX main-story offsets are UTF-16, with one LF between paragraphs. Page
// geometry is a projection of this index, never the persistent identity.
export function wordTextIndex(doc) {
  let text='';const positions=[],paragraphs=[];
  doc.descendants((node,pos)=>{
    if(node.type.name!=='paragraph')return;
    if(paragraphs.length){text+='\n';positions.push(pos);}
    const from=text.length;
    node.descendants((child,offset)=>{
      const value=child.isText?child.text:child.type.name==='tab'?'\t':['hardBreak','lineBreak'].includes(child.type.name)?'\n':'';
      for(let i=0;i<value.length;i++){
        if(value[i]==='\r'){text+='\n';positions.push(pos+1+offset+i);if(value[i+1]==='\n')i++;}
        else {text+=value[i];positions.push(pos+1+offset+(child.isText?i:0));}
      }
    });
    paragraphs.push({from,to:text.length,pmFrom:pos,pmTo:pos+node.nodeSize,blockId:node.attrs.sdBlockId||null});
    return false;
  });
  for(let i=0;i<paragraphs.length-1;i++)paragraphs[i].to=paragraphs[i+1].from;
  return {text,positions,paragraphs};
}

export function wordOffsetAt(index,position) {
  let lo=0,hi=index.positions.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(index.positions[mid]<position)lo=mid+1;else hi=mid;}
  return lo;
}

// Preserve the identity of repeated text through the real ProseMirror steps.
// Unsupported structural mappings return null; the caller can explicitly fall
// back to a full verified text diff instead of trusting a partial mapping.
export function wordTransactionEdits(transaction) {
  if(!transaction?.docChanged||!transaction.docs?.length)return null;
  const batches=[];
  for(let i=0;i<transaction.steps.length;i++){
    const before=wordTextIndex(transaction.docs[i]),after=wordTextIndex(transaction.docs[i+1]||transaction.doc),edits=[];
    transaction.steps[i].getMap().forEach((from,to,newFrom,newTo)=>{
      const start=wordOffsetAt(before,from),end=wordOffsetAt(before,to);
      const insert=after.text.slice(wordOffsetAt(after,newFrom),wordOffsetAt(after,newTo));
      if(start!==end||insert)edits.push({from:start,to:end,insert});
    });
    let actual=before.text;
    for(const edit of edits.slice().reverse())actual=actual.slice(0,edit.from)+edit.insert+actual.slice(edit.to);
    if(actual!==after.text)return null;
    batches.push({before:before.text,text:after.text,edits});
  }
  return batches;
}
