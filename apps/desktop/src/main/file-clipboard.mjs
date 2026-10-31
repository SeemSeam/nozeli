import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {DOMParser} from '@xmldom/xmldom';
import {parseFilenameBinaryPlist} from './finder-filenames.mjs';

const invalid = () => { throw new Error('文件剪贴板格式无效或包含非本地路径。'); };
const text = bytes => { try { const value = new TextDecoder('utf-8', {fatal:true}).decode(bytes); if (value.includes('\0')) invalid(); return value; } catch { return invalid(); } };
const formats = ['x-special/gnome-copied-files','text/uri-list','CF_HDROP','FileNameW','NSFilenamesPboardType','public.file-url'];
const trackedFormats = [...formats,'application/x-kde-cutselection','Preferred DropEffect'];
export function serializeFileClipboard(paths, platform = process.platform) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 1024) invalid();
  const values = [...new Set(paths.map(value=>absolute(value,platform)))];
  const uris = values.map(value=>pathToFileURL(value,{windows:platform==='win32'}).href);
  if (platform === 'linux') return new Map([
    ['text/uri-list',Buffer.from(uris.join('\r\n')+'\r\n')],
    ['x-special/gnome-copied-files',Buffer.from('copy\n'+uris.join('\n'))],
    ['application/x-kde-cutselection',Buffer.from('0')],
  ]);
  if (platform === 'win32') {
    const header=Buffer.alloc(20);header.writeUInt32LE(20,0);header.writeUInt32LE(1,16);
    const effect=Buffer.alloc(4);effect.writeUInt32LE(1);
    return new Map([['CF_HDROP',Buffer.concat([header,Buffer.from(values.join('\0')+'\0\0','utf16le')])],['Preferred DropEffect',effect]]);
  }
  if (platform === 'darwin') {
    const escape=value=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
    return new Map([['NSFilenamesPboardType',Buffer.from('<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>'+values.map(value=>'<string>'+escape(value)+'</string>').join('')+'</array></plist>')]]);
  }
  throw Error('当前平台不支持系统文件复制。');
}
function localURL(value, platform) {
  let url; try { url = new URL(value); } catch { return invalid(); }
  if (url.protocol !== 'file:' || url.username || url.password || url.port || url.search || url.hash || (url.hostname && url.hostname !== 'localhost')) invalid();
  let result; try { result = fileURLToPath(url, {windows:platform === 'win32'}); } catch { return invalid(); }
  if (result.includes('\0')) invalid();
  return result;
}
function absolute(value, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || !value || value.length > 32768 || /[\0\r\n]/.test(value) || !api.isAbsolute(value) || (platform === 'win32' && !/^[a-z]:[\\/]/i.test(value))) invalid();
  if (api.normalize(value) === api.parse(value).root) invalid();
  return api.normalize(value);
}
export function parseFileClipboard(entries, platform = process.platform) {
  for (const format of formats) {
    if (!entries.has(format) || !entries.get(format).length) continue;
    const bytes = entries.get(format); let values;
    if (format === 'CF_HDROP') {
      if (bytes.length < 24) invalid();
      const offset = bytes.readUInt32LE(0);
      if (offset < 20 || offset % 2 || offset > bytes.length - 4 || (bytes.length-offset)%2 || bytes.readUInt32LE(16) !== 1) invalid();
      let payload;try{payload=new TextDecoder('utf-16le',{fatal:true}).decode(bytes.subarray(offset));}catch{invalid();}
      if (!payload.endsWith('\0\0')) invalid();
      values = payload.slice(0,-2).split('\0');
    } else if (format === 'FileNameW') {
      if (bytes.length % 2) invalid();
      let payload;try{payload=new TextDecoder('utf-16le',{fatal:true}).decode(bytes);}catch{invalid();}
      if (!payload.endsWith('\0')) invalid();
      values = [payload.slice(0,-1)];
    } else if (format === 'NSFilenamesPboardType') {
      if(bytes.subarray(0,8).toString()==='bplist00'){values=parseFilenameBinaryPlist(bytes);}
      else {
      const xml = text(bytes); let broken = false;
      const document = new DOMParser({onError:()=>{broken=true;}}).parseFromString(xml,'application/xml');
      const root = document.documentElement;
      if (broken || root?.tagName !== 'plist' || document.doctype?.internalSubset) invalid();
      const children = node => Array.from(node.childNodes).filter(n=>n.nodeType===1);
      const arrays = children(root);
      if (arrays.length !== 1 || arrays[0].tagName !== 'array') invalid();
      values = children(arrays[0]).map(node=>{if(node.tagName!=='string'||children(node).length)invalid();return node.textContent;});
      }
    } else {
      let lines = text(bytes).split(/\r?\n/).filter(line=>line && !line.startsWith('#'));
      if (format === 'x-special/gnome-copied-files' && !['copy','cut'].includes(lines.shift())) invalid();
      values = lines.map(line=>localURL(line,platform));
    }
    if (!values.length || values.length > 1024) invalid();
    return [...new Set(values.map(value=>absolute(value,platform)))];
  }
  return [];
}
export const fileIdentity = stat => ({dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,mode:stat.mode});
export const sameFileIdentity = (a,b) => a && b && Object.keys(a).every(key=>a[key]===b[key]);

// Absolute paths never cross IPC. A ticket is tied to one shell, project and
// exact native clipboard snapshot; imports never interpret renderer paths.
export class NativeFileClipboard {
  constructor(clipboard, {platform=process.platform,ClipboardItem}={}) { this.clipboard=clipboard;this.ClipboardItem=ClipboardItem;this.platform=platform;this.internal=null;this.tickets=new Map(); }
  async snapshot() {
    const entries=new Map(),hash=createHash('sha256');let total=0;
    const items=await this.clipboard.read();
    if(items.length>64)invalid();
    const available=[];
    for(const item of items)for(const type of item.types)available.push({item,type});
    if(available.length>256)invalid();
    available.sort((a,b)=>a.type.localeCompare(b.type));
    for(const {item,type} of available){
      const raw=/^electron application\/osclipboard;format="([^"\r\n]+)"$/.exec(type);
      const format=raw?raw[1]:type;
      hash.update(type).update('\0');
      // Irrelevant payloads (notably screenshots) do not need decoding. Their
      // type presence still invalidates a previous internal-only marker.
      if(!trackedFormats.includes(format)&&format!=='application/x-nozeli-file-clipboard')continue;
      const blob=await item.getType(type);if(!(blob instanceof Blob)||blob.size>16*1024*1024)invalid();
      total+=blob.size;if(total>16*1024*1024)invalid();
      const bytes=Buffer.from(await blob.arrayBuffer());
      hash.update(String(bytes.length)).update('\0').update(bytes);
      if(entries.has(format)&&!entries.get(format).equals(bytes))invalid();
      entries.set(format,bytes);
    }
    return {entries,generation:hash.digest('hex')};
  }
  async mark(owner,projectId,{action='cut',paths=[],beforeWrite}={}) {
    if(!['copy','cut'].includes(action))invalid();
    const nonce=randomUUID(),raw=format=>`electron application/osclipboard;format="${format}"`;
    const nativeEntries=action==='copy'?serializeFileClipboard(paths,this.platform):new Map();
    nativeEntries.set('application/x-nozeli-file-clipboard',Buffer.from(nonce));
    const values=Object.fromEntries([...nativeEntries].map(([format,bytes])=>[raw(format),new Blob([bytes])]));
    const item=new this.ClipboardItem(values);
    await beforeWrite?.();
    await this.clipboard.write([item]);
    const {entries,generation}=await this.snapshot();
    if(entries.get('application/x-nozeli-file-clipboard')?.toString()!==nonce)throw Error('剪贴板已变化，请重新复制。');
    this.internal={generation,owner,projectId};this.tickets.clear();return {generation};
  }
  async read(owner,projectId) {
    const snapshot=await this.snapshot(),{generation}=snapshot;
    if(this.internal?.generation===generation&&this.internal.owner===owner)return {kind:'internal',generation};
    if(this.internal?.generation!==generation)this.internal=null;
    const paths=parseFileClipboard(snapshot.entries,this.platform);
    if(!paths.length)return {kind:'empty',generation};
    const items=await Promise.all(paths.map(async source=>({source,name:path.basename(source),identity:fileIdentity(await fs.lstat(source))})));
    const ticket=randomUUID();
    for(const [id,value] of this.tickets)if(value.owner===owner||value.expires<Date.now())this.tickets.delete(id);
    if(this.tickets.size>=64)this.tickets.delete(this.tickets.keys().next().value);
    this.tickets.set(ticket,{owner,projectId,generation,items,expires:Date.now()+5*60*1000});
    return {kind:'external',ticket,generation,items:items.map(({name})=>({name}))};
  }
  async take(ticket,owner,projectId) {
    const value=this.tickets.get(ticket);this.tickets.delete(ticket);
    if(!value||value.owner!==owner||value.projectId!==projectId||value.expires<Date.now()||value.generation!==(await this.snapshot()).generation)throw Error('剪贴板已变化或粘贴凭据过期，请重新复制后粘贴。');
    return value.items;
  }
}
