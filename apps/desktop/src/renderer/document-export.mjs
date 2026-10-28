import {sameDocumentSource,validateDocumentSource} from '../domain/document-source.mjs';

// Capture once at the user's export action. The download Blob and its digest
// are derived from the same UTF-8 bytes, not a later save or frozen publication.
export async function captureTextCopy({text,relPath,documentKey,documentSource={type:'project'},frozen=false}){
 if(typeof text!=='string'||typeof relPath!=='string'||!relPath)throw Error('当前文档没有可导出的文本。');
 const bytes=new TextEncoder().encode(text),blob=new Blob([bytes],{type:'text/plain;charset=utf-8'});
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 const name=relPath.split('/').at(-1),dot=name.lastIndexOf('.'),suffix=frozen?'-frozen-copy':documentSource.type==='review'?'-review-copy':'-draft-copy';
 const filename=dot>0?name.slice(0,dot)+suffix+name.slice(dot):name+suffix;
 return Object.freeze({blob,digest,byteLength:bytes.length,filename,relPath,documentKey,documentSource:Object.freeze(structuredClone(documentSource)),frozen});
}

export async function verifiedTextCopy(local,receipt){
 if(receipt?.relPath!==local.relPath||!sameDocumentSource(validateDocumentSource(receipt.documentSource),local.documentSource))throw Error('导出来源与当前文档不一致，未导出副本。');
 if(typeof receipt.text!=='string')throw Error('宿主未返回可导出的文本，未改用本地正文。');
 const host=await captureTextCopy({...local,text:receipt.text,documentSource:receipt.documentSource});
 if(host.digest!==receipt.digest||host.byteLength!==receipt.byteLength)throw Error('宿主导出正文与摘要不一致，未导出副本。');
 if(local.digest!==host.digest)throw Error('当前选定正文与宿主缓冲尚未一致，未导出副本。请等待同步后重新点击导出。');
 return host;
}

// Same browser download/save flow used by the native document draft exporter.
// Requesting a download is not a receipt that the user has saved the file.
export function downloadTextCopy(snapshot){
 const url=URL.createObjectURL(snapshot.blob),link=document.createElement('a');
 link.href=url;link.download=snapshot.filename;link.hidden=true;document.body.append(link);
 try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
