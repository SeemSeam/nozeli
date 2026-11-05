import {ContextReader} from './context-reader.mjs';

// Frozen, turn-local document pages retain the executor's exact edit handle and
// source version. Continuations never reopen a file or replace an unsaved draft.
export class DocumentReader {
  constructor(){this.reader=new ContextReader();this.metadata=new Map();}
  add(document){
    const metadata={};
    for(const key of ['relPath','readHandle','version','digest','offsetEncoding','provenance','editable','buffer'])if(document[key]!==undefined)metadata[key]=document[key];
    const ref=this.reader.add(document.text,{title:document.relPath,source:document.relPath,kind:'document:'+JSON.stringify([document.readHandle,document.version,document.provenance])});
    this.metadata.set(ref,metadata);return ref;
  }
  read(readRef,allowance=null){
    const metadata=this.metadata.get(readRef);
    if(!metadata)throw Object.assign(new Error('文档分页引用不属于当前回合；不能借用其他文件或会话的读取身份。'),{code:'READ_REF_EXPIRED'});
    const envelope={ok:true,readOnly:true,continueTurn:true,value:null};
    const overhead=Buffer.byteLength(JSON.stringify(envelope),'utf8')-4;
    const page=this.reader.read(readRef,{maxBytes:Math.min(12000,allowance??12000),maxResultBytes:allowance===null?null:Math.max(0,allowance-overhead),resultFields:{...metadata,nextTool:'nozeli_document_read'}});
    if(page.nextReadRef)this.metadata.set(page.nextReadRef,metadata);
    return {...envelope,value:page};
  }
}
