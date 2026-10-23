import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {memoryContext,ContextReader} from './context-reader.mjs';
import {readStoredReport,reportExtension,reportSemanticText} from './report-descriptor.mjs';

export const frontReadLimits={chars:8000};
export const versionOf=text=>createHash('sha256').update(text).digest('hex');
export function validateFrontPath(value){
 if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')||path.isAbsolute(value)||value.split('/').some(p=>!p||p==='..'||p==='.'||p.startsWith('.')||p==='node_modules'))throw Error('只允许明确的项目相对文本路径；不读取私有目录');
 return value;
}
export async function projectText(root,relPath){
 validateFrontPath(relPath);const candidate=await fs.realpath(path.join(root,relPath)),rel=path.relative(root,candidate);
 if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('文件来源超出项目');
 validateFrontPath(rel.split(path.sep).join('/'));
 const stat=await fs.stat(candidate);if(!stat.isFile()||stat.size>8*1024*1024)throw Error('只支持8MiB以内文本材料');
 const bytes=await fs.readFile(candidate);if(bytes.includes(0))throw Error('此文件不是文本材料');return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),source:relPath};
}
// This is a host-owned source adapter, never a provider filesystem tool.
export async function frontSource(controller,selector,job){
 if(selector.startsWith('frontdesk-source:')){
  const digest=selector.slice(17);if(!/^[a-f0-9]{64}$/.test(digest))throw Error('无效冻结来源');
  const text=await fs.readFile(path.join(controller.store.root,'objects',digest+'.md'),'utf8');if(versionOf(text)!==digest)throw Error('冻结来源摘要不匹配');
  return {source:'objects/'+digest+'.md',version:digest,text};
 }
 if(selector.startsWith('file:')){
  const rel=validateFrontPath(selector.slice(5));await projectText(controller.store.content,rel);
  const file=controller.readProjectText?await controller.readProjectText(rel):await projectText(controller.store.content,rel);
  if(typeof file.text!=='string')throw Error('无法读取文本材料');return {...file,source:rel,version:versionOf(file.text)};
 }
 if(selector.startsWith('memory:')){
  const query=selector.slice(7).trim();if(!query)throw Error('需要记忆检索词');
  const memory=await controller.memoryVersion.snapshot(),reader=new ContextReader(),result=memoryContext(memory.root.text??'',query,reader,memory.topics);
  // Stable selectors, rather than ephemeral Orchestrator readRefs.
  const entry=row=>({title:row.title,source:row.source,kind:row.kind,...(row.preview!==undefined?{preview:row.preview}:{}),body:row.kind==='topic'?'memory-topic:'+row.source.slice('memory/topics/'.length)+':0':'memory-page:0'});
  return {source:'memory#index',version:memory.version,text:JSON.stringify({matches:result.matches.map(entry),historyMatches:result.historyMatches.map(entry),totalChars:result.totalChars,note:'优先定位整理主题；historyMatches 是原Work历史，不能直接当作当前规则。主题也须核对来源、适用范围及未决冲突。需要正文时复制对应body到@read；主题不在根索引正文中。没有命中不代表没有历史。',body:'memory-page:0'})};
 }
 if(selector.startsWith('memory-topic:')){
  const match=/^memory-topic:([A-Za-z0-9_-]+\.md):(\d+)$/.exec(selector);if(!match)throw Error('无效主题正文引用');
  const memory=await controller.memoryVersion.snapshot(),topic=memory.topics.find(t=>t.path==='topics/'+match[1]);
  if(!topic||topic.text===null)throw Error('未找到根索引链接的可读主题');
  return {source:'memory/'+topic.path,text:topic.text,version:topic.digest,offset:Number(match[2])};
 }
 if(selector.startsWith('memory-page:')){const text=await fs.readFile(controller.store.plan,'utf8');return {source:'memory/plan-tree.md',text,version:versionOf(text),offset:Number(selector.slice(12))};}
 if(selector==='state')return {source:'runtime/work-state',text:controller.routingContext({role:'frontdesk'})};
 if(selector.startsWith('report:')){
  const name=selector.slice(7),w=controller.store.state.works.findLast(w=>(w.name||w.request)===name);
  const receipt=w&&controller.store.state.receipts.findLast(r=>r.workId===w.id&&r.kind==='result');if(!receipt)throw Error('未找到已发布结果');
  const bytes=await readStoredReport(controller.store,receipt);
  return {source:`objects/${receipt.objectId}${reportExtension(receipt.report)}`,text:reportSemanticText(bytes,receipt.report),version:receipt.report.digest,revision:receipt.revision,workId:w.id};
 }
 throw Error('未知读取选择器；使用file:相对路径、memory:关键词、检索返回的memory-topic:正文引用、memory-page:0、state或report:工作名');
}
export function readPage(source,remaining){
 const offset=source.offset||0;if(!Number.isInteger(offset)||offset<0||offset>source.text.length)throw Error('无效正文页');
 let end=Math.min(source.text.length,offset+remaining);if(end<source.text.length&&/[\uD800-\uDBFF]/.test(source.text[end-1]||'')&&/[\uDC00-\uDFFF]/.test(source.text[end]||''))end--;
 return {source:source.source,version:source.version||versionOf(source.text),...(source.buffer!=null?{buffer:source.buffer,diskVersion:source.diskVersion}:{}),...(source.revision?{revision:source.revision}:{}),...(source.workId?{workId:source.workId}:{}),text:source.text.slice(offset,end),offset,totalChars:source.text.length,truncated:end<source.text.length};
}
