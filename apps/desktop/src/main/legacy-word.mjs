import {Worker} from 'node:worker_threads';
import JSZip from 'jszip';
import {validateWord} from './word-package.mjs';
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
export async function importLegacyWord(bytes){
 if(bytes.length>32*1024*1024)throw Error('DOC 超过 32 MiB 导入限制。');
 if(bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,3,4]))){await validateWord(bytes);return {bytes,mode:'docx-copy'};}
 if(bytes.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1')throw Error('该 .doc 不是旧版 Word 二进制或 DOCX 内容。RTF/HTML 等伪装格式请先在专业 Office 中另存为 DOCX。');
 const text=await new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./legacy-word-worker.cjs',import.meta.url),{workerData:bytes,resourceLimits:{maxOldGenerationSizeMb:256}});
  let settled=false;const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>done(Error('DOC 解析超时，请使用专业 Office 转为 DOCX。')),20000);
  worker.once('message',m=>done(m.error?Error(m.error):null,m.text));worker.once('error',error=>done(error));worker.once('exit',()=>{if(!settled)done(Error('DOC 解析未完成。'));});
 });
 if(!text?.trim())throw Error('DOC 未提取到正文，未创建空白副本。');
 const zip=new JSZip();
 zip.file('[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 const paragraphs=text.replace(/\r\n?/g,'\n').split('\n').map(line=>'<w:p><w:r><w:t xml:space="preserve">'+escape(line)+'</w:t></w:r></w:p>').join('');
 zip.file('word/document.xml','<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+paragraphs+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>');
 return {bytes:await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),mode:'body-only'};
}
