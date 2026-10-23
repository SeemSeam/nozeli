import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readHtmlReportText,HTML_REPORT_OBJECT_MAX_BYTES} from './html-report.mjs';

const MAX_REPORT_BYTES=8*1024*1024;export {MAX_REPORT_BYTES};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const formats={markdown:{mediaType:'text/markdown',extension:'.md'},'html-static':{mediaType:'text/html',extension:'.html'}};
const objectIdentity=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const sha=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const plain=value=>String(value||'').replace(/\s+/g,' ').trim();
const markdownText=value=>value.replace(/```[^\n]*\n([\s\S]*?)```/g,'$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/[*_`>]/g,'');

export function validReportDescriptor(report){
 return !!report&&Object.hasOwn(formats,report.format)&&report.mediaType===formats[report.format].mediaType&&objectIdentity(report.objectId)&&sha(report.digest)&&Number.isSafeInteger(report.byteLength)&&report.byteLength>=0&&report.byteLength<=(report.format==='html-static'?HTML_REPORT_OBJECT_MAX_BYTES:MAX_REPORT_BYTES)&&typeof report.title==='string'&&typeof report.excerpt==='string'&&(report.manifestDigest===null||sha(report.manifestDigest));
}
export function reportExtension(report){
 if(!validReportDescriptor(report))throw Error('Invalid report descriptor');
 return formats[report.format].extension;
}
export function reportSemanticText(bytes,report){
 if(!validReportDescriptor(report))throw Error('Invalid report descriptor');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 return report.format==='html-static'?readHtmlReportText(text):text;
}
export function reportDescriptor(bytes,{format,objectId,title,excerpt,manifestDigest=null}){
 if(!Object.hasOwn(formats,format))throw Error('Unsupported report format');
 if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 const semantic=format==='markdown'?markdownText(text):readHtmlReportText(text);
 const report={format,mediaType:formats[format].mediaType,objectId,digest:hash(bytes),byteLength:bytes.length,title:plain(title??(format==='markdown'?/^\s*#\s+(.+)$/m.exec(text)?.[1]:'')??'').slice(0,200),excerpt:plain(excerpt??semantic).slice(0,360),manifestDigest};
 if(!validReportDescriptor(report))throw Error('Invalid report descriptor');
 return report;
}
// Only the unversioned historical schema may contain an inline Markdown body.
// Migration preserves object identity and bytes; it never guesses a format.
export function decodeReportState(state){
 if(!state||state.schema!==2)throw Error('Incompatible report state');
 if(state.reportStateVersion!==undefined&&state.reportStateVersion!==1)throw Error('Unsupported report state version');
 const legacy=state.reportStateVersion===undefined;
 const receipts=(state.receipts||[]).map(receipt=>{
  let report=receipt.report;
  if(legacy&&!report&&typeof receipt.text==='string'){const bytes=Buffer.from(receipt.text);if(receipt.snapshot?.reportDigest&&receipt.snapshot.reportDigest!==hash(bytes))throw Error('Legacy report digest mismatch');report=reportDescriptor(bytes,{format:'markdown',objectId:receipt.objectId});}
  if(!validReportDescriptor(report)||report.objectId!==receipt.objectId||!legacy&&Object.hasOwn(receipt,'text'))throw Error('Invalid receipt report descriptor');
  if(legacy&&report&&typeof receipt.text==='string'&&hash(Buffer.from(receipt.text))!==report.digest)throw Error('Legacy report body differs');
  const {text,...row}=receipt;return {...row,report};
 });
 return {...state,reportStateVersion:1,receipts};
}
export async function readStoredReport(store,receipt){
 const report=Object.freeze(structuredClone(receipt?.report));
 if(!validReportDescriptor(report)||report.objectId!==receipt.objectId)throw Error('Invalid receipt report descriptor');
 const identity=JSON.stringify([receipt.id,receipt.workId,receipt.revision,report]);
 const current=()=>{const rows=store.state.receipts.filter(row=>row.objectId===report.objectId);if(rows.length!==1||JSON.stringify([rows[0].id,rows[0].workId,rows[0].revision,rows[0].report])!==identity)throw Error('Report receipt changed during read');};current();
 const directory=path.join(store.root,'objects'),file=path.join(directory,report.objectId+reportExtension(report));
 const ancestors=async()=>{for(let current=directory;;current=path.dirname(current)){const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Report object ancestor changed');if(path.dirname(current)===current)break;}};await ancestors();
 const before=await fs.lstat(file,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(report.byteLength))throw Error('Report object is not an immutable regular file');
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const opened=await handle.stat({bigint:true});if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.mtimeNs!==before.mtimeNs||opened.ctimeNs!==before.ctimeNs||opened.nlink!==1n)throw Error('Report object changed during read');
  const buffer=Buffer.alloc(report.byteLength+1);let offset=0;while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}const bytes=buffer.subarray(0,offset),after=await handle.stat({bigint:true});await ancestors();const entry=await fs.lstat(file,{bigint:true});
  for(const current of [after,entry])if(current.dev!==opened.dev||current.ino!==opened.ino||current.size!==opened.size||current.mtimeNs!==opened.mtimeNs||current.ctimeNs!==opened.ctimeNs||current.nlink!==1n)throw Error('Report bytes changed');
  if(bytes.length!==report.byteLength||hash(bytes)!==report.digest)throw Error('Report bytes changed');
  current();
  return bytes;
 }finally{await handle.close();}
}
