import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { validateWord } from './word-package.mjs';
import { anchorText } from '../domain/tag-anchors.mjs';
export function validateWordAnchor(anchor){
 if(!anchor||Object.keys(anchor).some(k=>!['space','quote','prefix','suffix'].includes(k))||anchor.space!=='docx-main-text'||typeof anchor.quote!=='string'||!anchor.quote.trim()||anchor.quote.length>20000||typeof anchor.prefix!=='string'||anchor.prefix.length>32||typeof anchor.suffix!=='string'||anchor.suffix.length>32)throw Error('Word 标签选区无效。');
 return {...anchor};
}
export async function wordText(bytes){
 await validateWord(bytes);const zip=await JSZip.loadAsync(bytes),source=await zip.file('word/document.xml').async('string');
 const doc=new DOMParser().parseFromString(source,'application/xml');
 const ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
 const paragraphs=Array.from(doc.getElementsByTagNameNS(ns,'p')).filter(p=>{
  for(let parent=p.parentNode;parent;parent=parent.parentNode)if(parent.namespaceURI===ns&&parent.localName==='txbxContent')return false;
  return true;
 });
 const text=node=>{
  if(node.namespaceURI===ns){
   if(node.localName==='txbxContent'||node.localName==='drawing'||node.localName==='pict')return '';
   if(node.localName==='t')return node.textContent;
   if(node.localName==='tab')return '\t';
   if(node.localName==='br'||node.localName==='cr')return '\n';
  }
  return Array.from(node.childNodes||[]).map(text).join('');
 };
 return anchorText(paragraphs.map(text).join('\n'));
}
export function locateWordQuote(text,anchor){
 const candidates=[];for(let from=text.indexOf(anchor.quote);from!==-1;from=text.indexOf(anchor.quote,from+1)){
  if(text.slice(Math.max(0,from-anchor.prefix.length),from)===anchor.prefix&&text.slice(from+anchor.quote.length,from+anchor.quote.length+anchor.suffix.length)===anchor.suffix)candidates.push(from);
  if(candidates.length>1)break;
 }
 return candidates.length===1?{anchor:{...anchor},locationStatus:'exact',contentStatus:'unchanged',method:'word-quote-context'}:{anchor:null,locationStatus:'unresolved',contentStatus:'unknown',method:candidates.length?'ambiguous-word-quote':'missing-word-quote'};
}

// Text edits retain the package, paragraphs, run properties and non-text nodes.
// Structural edits need a real Office editor, not a flattened text round trip.
export async function applyWordTextEdits(bytes, edits) {
 await validateWord(bytes);
 const zip=await JSZip.loadAsync(bytes),doc=new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'),'application/xml');
 const ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main',segments=[];let offset=0;
 const unsupported=()=>{const error=new Error('DOCX正文编辑不可跨段落、制表符或换行结构；请用Word编辑器处理结构变更。');error.code='UNSUPPORTED';throw error;};
 const paragraphs=Array.from(doc.getElementsByTagNameNS(ns,'p')).filter(p=>{for(let n=p.parentNode;n;n=n.parentNode)if(n.namespaceURI===ns&&n.localName==='txbxContent')return false;return true;});
 const visit=node=>{
  if(node.namespaceURI===ns){
   if(['txbxContent','drawing','pict'].includes(node.localName))return;
   if(node.localName==='t'){const text=node.textContent;if(text.includes('\r'))unsupported();segments.push({node,from:offset,to:offset+text.length});offset+=text.length;return;}
   if(['tab','br','cr'].includes(node.localName)){offset++;return;}
  }
  for(const child of Array.from(node.childNodes||[]))visit(child);
 };
 paragraphs.forEach((p,i)=>{if(i)offset++;visit(p);});
 for(const edit of edits.slice().reverse()){
  if(/[\r\n\t]/.test(edit.insert))unsupported();
  const selected=segments.filter(s=>edit.from===edit.to?s.from<=edit.from&&s.to>=edit.to:s.from<edit.to&&s.to>edit.from);
  if(!selected.length||selected[0].from>edit.from||selected.at(-1).to<edit.to||selected.some((s,i)=>i&&selected[i-1].to!==s.from))unsupported();
  const first=selected[0],last=selected.at(-1),prefix=first.node.textContent.slice(0,edit.from-first.from),suffix=last.node.textContent.slice(edit.to-last.from);
  first.node.textContent=prefix+edit.insert+(first===last?suffix:'');first.node.setAttribute('xml:space','preserve');
  for(const segment of selected.slice(1)){segment.node.textContent=segment===last?suffix:'';segment.node.setAttribute('xml:space','preserve');}
 }
 zip.file('word/document.xml',new XMLSerializer().serializeToString(doc));
 const result=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
 let expected=await wordText(bytes);for(const edit of edits.slice().reverse())expected=expected.slice(0,edit.from)+edit.insert+expected.slice(edit.to);
 if(await wordText(result)!==expected)unsupported();
 return result;
}
