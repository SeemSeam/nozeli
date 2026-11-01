import {randomUUID,createHash} from 'node:crypto';
// Ephemeral read references belong to one host turn; durable sources remain untouched.
export class ContextReader {
  constructor(){this.scope=randomUUID().slice(0,8);this.entries=new Map();this.references=new Map();this.reads=[];}
  add(text,{title,source,kind='memory',offset=0}={}){
    const value=String(text),version=createHash('sha256').update(value).digest('hex');
    const identity=JSON.stringify([source,kind,title,offset,version]);
    if(this.references.has(identity))return this.references.get(identity);
    const readRef=`读取 ${this.scope}/${this.entries.size+1}：${String(title||'记录').slice(0,80)}`;
    this.references.set(identity,readRef);
    this.entries.set(readRef,{text:value,title,source,kind,offset,version});return readRef;
  }
  read(readRef,{maxChars=null,maxBytes=null,maxResultBytes=null,resultFields={}}={}){
    const entry=this.entries.get(readRef);
    if(!entry)throw Object.assign(new Error('读取引用已失效：readRef 属于原回合，不能跨回合复用。请用版本化原件重新定位：当前 Work 用宿主投影中的稳定 readRef（work/<id>/request、work/<id>/approved/<来源>），报告用 nozeli_report_read，不以下一轮磁盘内容冒充冻结版本。'),{code:'READ_REF_EXPIRED'});
    const byteBudget=Number.isSafeInteger(maxBytes)&&maxBytes>=0?maxBytes:null;
    let end;
    if(byteBudget!==null){
      // Byte-exact paging: never let a page exceed the byte allowance (CJK is
      // up to 3–4 bytes per char, so a char cap would overrun), never split a
      // code point, and always make non-zero progress when the budget allows
      // at least one character. Prefer a newline boundary within the tail.
      let used=0;end=entry.offset;
      while(end<entry.text.length){
        const code=entry.text.codePointAt(end);
        const width=code>0xffff?2:1;
        const bytes=Buffer.byteLength(String.fromCodePoint(code),'utf8');
        if(used+bytes>byteBudget)break;
        used+=bytes;end+=width;
      }
      if(end<entry.text.length&&used>0){
        const boundary=entry.text.lastIndexOf('\n',end-1);
        if(boundary>entry.offset&&boundary>=entry.offset+Math.floor((end-entry.offset)*0.75))end=boundary+1;
      }
      if(end===entry.offset&&entry.text.length>entry.offset)throw Object.assign(new Error('本页字节额度不足以容纳下一个完整字符；未交付正文，原读取位置保留。'),{code:'HOST_CONTEXT_BUDGET_EXHAUSTED'});
    }else{
      const limit=Number.isSafeInteger(maxChars)&&maxChars>=0?Math.min(entry.offset+maxChars,entry.offset+10000):Math.min(entry.offset+10000,entry.text.length);
      end=Math.min(limit,entry.text.length);
      if(end<entry.text.length){const boundary=entry.text.lastIndexOf('\n',end-1);if(boundary>=entry.offset+Math.min(7500,Math.floor((end-entry.offset)*0.75)))end=boundary+1;}
      if(end<entry.text.length&&/[\uD800-\uDBFF]/.test(entry.text[end-1])&&/[\uDC00-\uDFFF]/.test(entry.text[end]))end--;
    }
    const nextFor=boundary=>boundary<entry.text.length?(entry.next&&entry.nextOffset===boundary?entry.next:`读取 ${this.scope}/${this.entries.size+1}：${String(entry.title||'记录').slice(0,80)}`):null;
    const pageAt=boundary=>({...resultFields,title:entry.title,source:entry.source,version:entry.version,text:entry.text.slice(entry.offset,boundary),offset:entry.offset,endOffset:boundary,totalChars:entry.text.length,complete:entry.offset===0&&boundary===entry.text.length,nextReadRef:nextFor(boundary)});
    if(Number.isSafeInteger(maxResultBytes)&&maxResultBytes>=0){
      const fits=boundary=>Buffer.byteLength(JSON.stringify(pageAt(boundary)),'utf8')<=maxResultBytes;
      if(!fits(end)){
        // Search valid code-point boundaries without recording a read or
        // allocating continuation tickets for rejected candidate pages.
        const boundaries=[entry.offset];
        for(let at=entry.offset;at<end;){at+=entry.text.codePointAt(at)>0xffff?2:1;boundaries.push(at);}
        let low=0,high=boundaries.length-1;
        while(low<high){const middle=Math.ceil((low+high)/2);if(fits(boundaries[middle]))low=middle;else high=middle-1;}
        end=boundaries[low];
      }
      if(!fits(end)||end===entry.offset&&end<entry.text.length)throw Object.assign(new Error('本轮额度不足以容纳完整分页响应及来源信息；未交付正文，原读取位置保留。'),{code:'HOST_CONTEXT_BUDGET_EXHAUSTED'});
    }
    if(end<entry.text.length&&(!entry.next||entry.nextOffset!==end)){entry.next=`读取 ${this.scope}/${this.entries.size+1}：${String(entry.title||'记录').slice(0,80)}`;entry.nextOffset=end;this.entries.set(entry.next,{...entry,offset:end,next:null,nextOffset:null});}
    this.reads.push({kind:entry.kind,source:entry.source,version:entry.version,offset:entry.offset,endOffset:end,chars:end-entry.offset,bytes:Buffer.byteLength(entry.text.slice(entry.offset,end),'utf8')});
    return pageAt(end);
  }
  // Stable cross-turn identity for one-time handoff sources (e.g. recovery
  // dossiers). The key is the durable identity; the content stays immutable.
  addStable(key,text,metadata={}){
    const ref=`读取 稳定/${String(key).slice(0,120)}`;
    if(this.entries.has(ref))return ref;
    const value=String(text);
    this.entries.set(ref,{text:value,offset:0,...metadata,version:createHash('sha256').update(value).digest('hex')});
    return ref;
  }
}
const preview=(text,size)=>text?.length>size?text.slice(0,size)+'… [正文可按读取引用获取]':text||'';
function sections(value){
  const text=String(value),rows=[];let cursor=0;
  for(const match of text.matchAll(/<!-- work:([^>]+) -->([\s\S]*?)<!-- \/work:\1 -->/g)){
    if(match.index>cursor){const outside=text.slice(cursor,match.index).trim();if(outside)rows.push({text:outside,source:'memory/plantree/index.md'});}
    rows.push({text:match[2].trim(),source:`memory/plantree/index.md#work:${match[1]}`});cursor=match.index+match[0].length;
  }
  const outside=text.slice(cursor).trim();if(outside)rows.push({text:outside,source:'memory/plantree/index.md'});
  return rows.map((row,index)=>({...row,index,title:(/^#{1,6}\s+(.+)$/m.exec(row.text)?.[1]||row.text.split('\n').find(s=>s.trim())||'项目记忆').slice(0,100)}));
}
function queryTerms(query){
  const words=String(query).toLowerCase().match(/[a-z0-9_./-]{2,}|\p{Script=Han}{2,}/gu)||[];
  const terms=new Set();for(const word of words){terms.add(word);if(/\p{Script=Han}/u.test(word))for(let i=0;i<word.length-1;i++)terms.add(word.slice(i,i+2));}
  return [...terms].slice(0,160);
}
export function memoryContext(text,query,reader,topics=[]){
  const rootRows=sections(text).map(row=>({...row,kind:row.source.includes('#work:')?'history':'index'}));
  const topicRows=topics.filter(t=>t.text!==null).map((t,index)=>({text:t.text,source:'memory/plantree/'+t.path,kind:'topic',title:(/^#{1,6}\s+(.+)$/m.exec(t.text)?.[1]||t.path).slice(0,100),index:index+100000}));
  const rows=[...rootRows,...topicRows],terms=queryTerms(query);
  const rank=items=>items.map(row=>{const title=row.title.toLowerCase(),body=row.text.toLowerCase();return {...row,score:terms.reduce((score,term)=>score+(title.includes(term)?5:0)+(body.includes(term)?1:0),0)};}).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||b.index-a.index).slice(0,4);
  const primary=rank(rows.filter(row=>row.kind!=='history')),history=rank(rootRows.filter(row=>row.kind==='history'));
  const entry=(row,full)=>({title:row.title,source:row.source,kind:row.kind,...(full?{preview:preview(row.text,500)}:{}),readRef:reader.add(row.text,row)});
  return {totalChars:text.length+topicRows.reduce((sum,row)=>sum+row.text.length,0),sections:rows.length,note:'定位摘要优先提供匹配的整理主题/索引；historyMatches 保留原 Work 历史入口，不能把历史报告直接当作当前规则。主题也须核对来源、适用范围及未决冲突，不以位置或时间自动裁定真假。通过 nozeli_inspect_work 的 workName 复制 readRef 读正文，长正文用 nextReadRef。没有命中不代表没有历史。',
    matches:(primary.length?primary:history).map(row=>entry(row,true)),
    historyMatches:history.map(row=>entry(row,false)),
    recent:rootRows.filter(row=>row.kind==='history').slice(-6).reverse().map(row=>entry(row,false)),
    allReadRef:reader.add(text,{title:'Plan Tree 根索引与 Work 历史（分页；主题另读）',source:'memory/plantree/index.md'})};
}
