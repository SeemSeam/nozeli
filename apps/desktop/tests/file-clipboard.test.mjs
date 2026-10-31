import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {encodeRecoveryBytes} from '../src/domain/office-recovery.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {FileTreeOps} from '../src/main/file-tree-ops.mjs';
import {NativeFileClipboard,parseFileClipboard,serializeFileClipboard,fileIdentity} from '../src/main/file-clipboard.mjs';
import {importClipboardFiles} from '../src/main/file-clipboard-import.mjs';
import {exportClipboardFiles} from '../src/main/file-clipboard-export.mjs';
const parse=(format,bytes,platform='linux')=>parseFileClipboard(new Map([[format,Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes)]]),platform);

test('Linux native URI/GNOME/KDE byte fixtures preserve multiple filenames; external cut is copy-only',()=>{
  const uris='# copied files\r\nfile:///tmp/a%20b.txt\r\nfile:///tmp/%E4%B8%AD%E6%96%87\r\n';
  assert.deepEqual(parse('text/uri-list',uris),['/tmp/a b.txt','/tmp/中文']);
  for(const action of ['copy','cut'])assert.deepEqual(parse('x-special/gnome-copied-files',`${action}\nfile:///tmp/a%20b.txt\nfile:///tmp/%E4%B8%AD%E6%96%87`),['/tmp/a b.txt','/tmp/中文']);
  assert.deepEqual(parseFileClipboard(new Map([['text/uri-list',Buffer.from('file:///tmp/a')],['application/x-kde-cutselection',Buffer.from('1')]])),['/tmp/a']);
});
test('Windows DROPFILES fixture uses little-endian wide file list',()=>{
  const header=Buffer.alloc(20);header.writeUInt32LE(20,0);header.writeUInt32LE(1,16);
  const bytes=Buffer.concat([header,Buffer.from('C:\\资料\\a b.txt\0D:\\folder\0\0','utf16le')]);
  assert.deepEqual(parse('CF_HDROP',bytes,'win32'),['C:\\资料\\a b.txt','D:\\folder']);
  const narrow=Buffer.from(bytes);narrow.writeUInt32LE(0,16);assert.throws(()=>parse('CF_HDROP',narrow,'win32'));
  assert.throws(()=>parse('CF_HDROP',bytes.subarray(0,-1),'win32'));
  const offset=Buffer.from(bytes);offset.writeUInt32LE(2,0);assert.throws(()=>parse('CF_HDROP',offset,'win32'));
});
// Concrete bplist00 bytes: top array references two UTF16BE filename strings.
const finderBinary=()=>{
  const objects=[Buffer.from([0xa2,1,2])];
  for(const value of ['/tmp/a b','/tmp/中文']){const le=Buffer.from(value,'utf16le'),be=Buffer.from(le);be.swap16();objects.push(Buffer.concat([Buffer.from([0x60|value.length]),be]));}
  const offsets=[];let at=8;for(const object of objects){offsets.push(at);at+=object.length;}
  const trailer=Buffer.alloc(32);trailer[6]=1;trailer[7]=1;trailer.writeBigUInt64BE(3n,8);trailer.writeBigUInt64BE(0n,16);trailer.writeBigUInt64BE(BigInt(at),24);
  return Buffer.concat([Buffer.from('bplist00'),...objects,Buffer.from(offsets),trailer]);
};
test('macOS filenames XML and binary plist fixtures plus native URL',()=>{
  const xml='<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>/tmp/a b</string><string>/tmp/中文</string></array></plist>';
  assert.deepEqual(parse('NSFilenamesPboardType',xml,'darwin'),['/tmp/a b','/tmp/中文']);
  assert.deepEqual(parse('NSFilenamesPboardType',finderBinary(),'darwin'),['/tmp/a b','/tmp/中文']);
  const corrupt=finderBinary();corrupt[9]=255;assert.throws(()=>parse('NSFilenamesPboardType',corrupt,'darwin'));
  assert.deepEqual(parse('public.file-url','file:///tmp/a%20b','darwin'),['/tmp/a b']);
});
test('malformed, remote, NUL, nonfile and text-only clipboard rejected without authority',()=>{
  for(const value of ['https://example.test/a','file://remote/tmp/a','file:///tmp/a%00b','file:///tmp/a\0b','file:///tmp/a?x=1','file:///tmp/%zz'])assert.throws(()=>parse('text/uri-list',value));
  assert.deepEqual(parse('text/plain','/tmp/anything'),[]);
  assert.throws(()=>parse('NSFilenamesPboardType','<plist><array><dict/></array></plist>','darwin'));
  assert.throws(()=>parse('NSFilenamesPboardType',finderBinary().subarray(0,20),'darwin'));
});
async function fixture(t){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-clipboard-'));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'project'),external=path.join(base,'external');await fs.mkdir(root);await fs.mkdir(external);
  const host=new DesktopHost(path.join(base,'profile')),picked=await host.pick(root),project=await host.requireProject(picked.project.id);
  const ops=new FileTreeOps(host,{trash:()=>{throw Error('external source must never be trashed');}});
  const item=async name=>({source:path.join(external,name),name,identity:fileIdentity(await fs.lstat(path.join(external,name)))});
  const run=async(names,target='')=>importClipboardFiles(ops,await Promise.all(names.map(item)),{projectId:project.id,target});
  return {base,root,external,host,project,ops,item,run};
}
test('native tickets bind sender/project/snapshot and stay host-only',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.external,'a b.txt'),'original');
  const raw=format=>`electron application/osclipboard;format="${format}"`;
  class ClipboardItem {
    constructor(values){this.values=values;this.types=Object.keys(values);}
    async getType(type){const value=await this.values[type];return value instanceof Blob?value:new Blob([value]);}
  }
  const uri=Buffer.from(pathToFileURL(path.join(f.external,'a b.txt')).href);
  let data=[new ClipboardItem({[raw('text/uri-list')]:new Blob([uri])})];
  const clipboard=new NativeFileClipboard({read:async()=>data,write:async items=>{data=items;}},{ClipboardItem});
  const marked=await clipboard.mark(10,'source');assert.equal((await clipboard.read(10,'destination')).kind,'internal');
  data=[new ClipboardItem({[raw('text/uri-list')]:new Blob([uri])})]; // recopy identical previous native bytes replaces private marker
  const value=await clipboard.read(10,f.project.id);assert.equal(value.kind,'external');assert.deepEqual(value.items,[{name:'a b.txt'}]);assert.equal(JSON.stringify(value).includes(f.external),false);
  await assert.rejects(clipboard.take(value.ticket,11,f.project.id));
  const next=await clipboard.read(10,f.project.id);await assert.rejects(clipboard.take(next.ticket,10,'other'));
  const changed=await clipboard.read(10,f.project.id);data=[new ClipboardItem({[raw('text/uri-list')]:new Blob([uri]),'text/plain':'changed'})];await assert.rejects(clipboard.take(changed.ticket,10,f.project.id));
  assert.notEqual((await clipboard.read(10,f.project.id)).generation,marked.generation);
  data=[new ClipboardItem({'image/png':new Blob([Buffer.alloc(17*1024*1024)])})];await assert.doesNotReject(clipboard.mark(10,'source'));assert.equal((await clipboard.read(10,'destination')).kind,'internal');
  data=[new ClipboardItem({'image/png':new Blob([Buffer.alloc(17*1024*1024)])})];assert.equal((await clipboard.read(10,'destination')).kind,'empty');
});
test('real temp imports multiple files/folders, partial conflicts preserve source and destination',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.external,'a b.txt'),'SOURCE');await fs.mkdir(path.join(f.external,'目录'));await fs.writeFile(path.join(f.external,'目录','中文.txt'),'nested');
  await fs.writeFile(path.join(f.root,'a b.txt'),'DESTINATION');
  const result=await f.run(['a b.txt','目录']);assert.deepEqual(result.items.map(item=>item.ok),[false,true]);assert.deepEqual(result.files,['目录']);
  assert.equal(await fs.readFile(path.join(f.root,'a b.txt'),'utf8'),'DESTINATION');assert.equal(await fs.readFile(path.join(f.external,'a b.txt'),'utf8'),'SOURCE');assert.equal(await fs.readFile(path.join(f.root,'目录','中文.txt'),'utf8'),'nested');
  await fs.mkdir(path.join(f.root,'selected'));assert.equal((await f.run(['a b.txt'],'selected')).items[0].ok,true);
  assert.equal(await fs.readFile(path.join(f.root,'selected','a b.txt'),'utf8'),'SOURCE');
});
test('source changes, nested destination, links and metadata are refused',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.external,'a.txt'),'old');const stale=await f.item('a.txt');await fs.writeFile(stale.source,'new-content');
  assert.equal((await importClipboardFiles(f.ops,[stale],{projectId:f.project.id})).items[0].ok,false);
  await fs.mkdir(path.join(f.external,'bad'));await fs.mkdir(path.join(f.external,'bad','.nozeli'));assert.equal((await f.run(['bad'])).items[0].ok,false);
  await fs.symlink(path.join(f.external,'a.txt'),path.join(f.external,'link'));assert.equal((await f.run(['link'])).items[0].ok,false);
  await fs.mkdir(path.join(f.root,'folder'));const source=path.join(f.root,'folder');const result=await importClipboardFiles(f.ops,[{source,name:'folder',identity:fileIdentity(await fs.lstat(source))}],{projectId:f.project.id,target:'folder'});assert.equal(result.items[0].ok,false);
});
test('registered source and absent destination recovery drafts block stale-byte copy',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.external,'a.txt'),'DISK');const picked=await f.host.pick(f.external),source=await f.host.requireProject(picked.project.id);
  await f.host.persistDraft(source.id,'a.txt','a'.repeat(64),'UNSAVED','dirty');assert.equal((await f.run(['a.txt'])).items[0].ok,false);
  await f.host.persistDraft(source.id,'a.txt','a'.repeat(64),'SAVED','saved');await f.host.persistDraft(f.project.id,'a.txt','a'.repeat(64),'RECOVERY','dirty');assert.equal((await f.run(['a.txt'])).items[0].ok,false);
  assert.equal(await fs.readFile(path.join(f.external,'a.txt'),'utf8'),'DISK');await assert.rejects(fs.stat(path.join(f.root,'a.txt')));
});
test('failed directory copy removes only owned unchanged entries and retains concurrent writer content',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.external,'bundle'));await fs.writeFile(path.join(f.external,'bundle','first.txt'),'FIRST');await fs.writeFile(path.join(f.external,'bundle','stop.txt'),'STOP');
  const original=fs.link;let injected=false;
  fs.link=async(file,destination,...args)=>{
    if(destination===path.join(f.root,'bundle','stop.txt')){
      injected=true;await fs.writeFile(path.join(f.root,'bundle','other-writer.txt'),'KEEP');throw Error('controlled copy failure');
    }
    return original.call(fs,file,destination,...args);
  };
  let result;try{result=await f.run(['bundle']);}finally{fs.link=original;}
  assert.equal(injected,true);assert.equal(result.items[0].ok,false);assert.match(result.items[0].error,/已保留/);
  assert.equal(await fs.readFile(path.join(f.root,'bundle','other-writer.txt'),'utf8'),'KEEP');await assert.rejects(fs.stat(path.join(f.root,'bundle','first.txt')));
  assert.equal(await fs.readFile(path.join(f.external,'bundle','first.txt'),'utf8'),'FIRST');assert.equal(await fs.readFile(path.join(f.external,'bundle','stop.txt'),'utf8'),'STOP');
});
test('import preserves executable and read-only file modes without privileged bits',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t),script='#!/bin/sh\nprintf executable\\n\n';
  await fs.writeFile(path.join(f.external,'script.sh'),script);await fs.chmod(path.join(f.external,'script.sh'),0o755);
  await fs.writeFile(path.join(f.external,'readonly.txt'),'READ ONLY');await fs.chmod(path.join(f.external,'readonly.txt'),0o444);
  const result=await f.run(['script.sh','readonly.txt']);assert.deepEqual(result.items.map(item=>item.ok),[true,true]);
  assert.equal((await fs.stat(path.join(f.root,'script.sh'))).mode&0o7777,0o755);assert.equal(await fs.readFile(path.join(f.root,'script.sh'),'utf8'),script);
  assert.equal((await fs.stat(path.join(f.root,'readonly.txt'))).mode&0o7777,0o444);assert.equal(await fs.readFile(path.join(f.root,'readonly.txt'),'utf8'),'READ ONLY');
});

function fakeNative(){
  class ClipboardItem {
    constructor(values){this.values=values;this.types=Object.keys(values);}
    async getType(type){return this.values[type];}
  }
  let data=[],writes=0;
  const native=new NativeFileClipboard({read:async()=>data,write:async items=>{data=items;writes++;}},{ClipboardItem,platform:'linux'});
  return {native,writes:()=>writes};
}
test('export serializers emit encoded Linux copy semantics and parseable Windows/macOS bytes',()=>{
  const paths=['/tmp/中文 # 100%.txt','/tmp/folder & <one>'];
  const linux=serializeFileClipboard(paths,'linux');
  assert.equal(linux.get('application/x-kde-cutselection').toString(),'0');
  assert.equal(linux.get('x-special/gnome-copied-files').toString().split('\n')[0],'copy');
  assert.match(linux.get('text/uri-list').toString(),/%E4%B8%AD%E6%96%87%20%23%20100%25/);
  for(const format of ['text/uri-list','x-special/gnome-copied-files'])assert.deepEqual(parse(format,linux.get(format)),paths);
  const windows=['C:\\资料\\a #.txt','D:\\folder'];
  const win=serializeFileClipboard(windows,'win32'),drop=win.get('CF_HDROP');
  assert.equal(drop.readUInt32LE(0),20);assert.equal(drop.readUInt32LE(16),1);
  assert.equal(drop.subarray(-4).equals(Buffer.alloc(4)),true);
  assert.equal(win.get('Preferred DropEffect').readUInt32LE(),1);
  assert.deepEqual(parse('CF_HDROP',drop,'win32'),windows);
  assert.deepEqual(parse('NSFilenamesPboardType',serializeFileClipboard(paths,'darwin').get('NSFilenamesPboardType'),'darwin'),paths);
  assert.throws(()=>serializeFileClipboard(['/tmp/ok','relative'],'linux'));
});
test('copy exports files/folders/multiselection while same-owner paste keeps internal buffer generation',async t=>{
  const f=await fixture(t),clip=fakeNative();
  await fs.writeFile(path.join(f.root,'中文 #.txt'),'SOURCE');await fs.mkdir(path.join(f.root,'folder'));await fs.writeFile(path.join(f.root,'folder','nested'),'NESTED');
  const result=await exportClipboardFiles(f.ops,clip.native,{owner:10,projectId:f.project.id,paths:['中文 #.txt','folder','folder/nested'],guard:async()=>{}});
  const snapshot=await clip.native.snapshot();
  assert.deepEqual(parseFileClipboard(snapshot.entries),[path.join(f.root,'中文 #.txt'),path.join(f.root,'folder')]);
  assert.deepEqual(await clip.native.read(10,'destination'),{kind:'internal',generation:result.generation});
  assert.equal((await clip.native.read(11,'destination')).kind,'external');
  assert.equal((await clip.native.read(10,'destination')).kind,'internal');
  await exportClipboardFiles(f.ops,clip.native,{owner:10,projectId:f.project.id,paths:['中文 #.txt'],action:'cut',guard:async()=>{}});
  assert.deepEqual(parseFileClipboard((await clip.native.snapshot()).entries),[]);
  assert.equal(await fs.readFile(path.join(f.root,'中文 #.txt'),'utf8'),'SOURCE');
});
test('metadata, symlinks, invalid paths and unsaved source refuse export without changing clipboard',async t=>{
  const f=await fixture(t),clip=fakeNative();await clip.native.mark(10,f.project.id);
  const previous=(await clip.native.snapshot()).generation;
  await fs.writeFile(path.join(f.root,'a.txt'),'DISK');await fs.mkdir(path.join(f.root,'bad'));await fs.mkdir(path.join(f.root,'bad','.nozeli'));
  await fs.symlink(path.join(f.root,'a.txt'),path.join(f.root,'link'));await fs.mkdir(path.join(f.root,'linked-folder'));await fs.symlink(path.join(f.root,'a.txt'),path.join(f.root,'linked-folder','nested'));
  for(const paths of [['../escape'],['.nozeli'],['bad'],['link'],['linked-folder'],['a.txt','a.txt/../escape']]){
    await assert.rejects(exportClipboardFiles(f.ops,clip.native,{owner:10,projectId:f.project.id,paths,guard:async()=>{}}));
    assert.equal((await clip.native.snapshot()).generation,previous);
  }
  await f.host.persistDraft(f.project.id,'a.txt','a'.repeat(64),'UNSAVED','dirty');
  await assert.rejects(exportClipboardFiles(f.ops,clip.native,{owner:10,projectId:f.project.id,paths:['a.txt'],guard:async()=>{}}),/草稿/);
  assert.equal(await fs.readFile(path.join(f.root,'a.txt'),'utf8'),'DISK');assert.equal(clip.writes(),1);
});
test('source mutations and stale live host scope during preparation preserve prior clipboard',async t=>{
  const f=await fixture(t),clip=fakeNative();await clip.native.mark(10,f.project.id);
  await fs.mkdir(path.join(f.root,'folder'));await fs.writeFile(path.join(f.root,'folder','a.txt'),'ORIGINAL');
  const previous=(await clip.native.snapshot()).generation;
  let calls=0;
  await assert.rejects(exportClipboardFiles(f.ops,clip.native,{owner:10,projectId:f.project.id,paths:['folder'],guard:async()=>{if(++calls===2)await fs.writeFile(path.join(f.root,'folder','a.txt'),'CHANGED');}}),/变化/);
  calls=0;
  await assert.rejects(exportClipboardFiles(f.ops,clip.native,{owner:10,projectId:f.project.id,paths:['folder'],guard:async()=>{if(++calls===3)throw Error('stale shell scope');}}),/stale shell scope/);
  assert.equal((await clip.native.snapshot()).generation,previous);assert.equal(clip.writes(),1);
});

test('opened clean reader provenance and matching recovery candidate allow Copy; actual retained edits refuse it',async t=>{
  const f=await fixture(t),clip=fakeNative(),relPath='opened.txt',text='SAVED SOURCE\n';
  await fs.writeFile(path.join(f.root,relPath),text);
  await f.host.readFile(f.project.id,relPath);
  const capture={projectId:f.project.id,relPath,kind:'text',generation:1,candidate:{text},baselineText:text};
  await f.host.storage.putRecovery(f.project.id,'workspace:view-clean',capture);
  const copy=()=>exportClipboardFiles(f.ops,clip.native,{owner:10,projectId:f.project.id,paths:[relPath],guard:async()=>{}});
  await copy();
  const previous=(await clip.native.snapshot()).generation;
  for(const patch of [{candidate:{text:'UNSAVED INPUT'}},{dirty:true},{conflict:{message:'disk changed'}},{offline:true}]){
    await f.host.storage.putRecovery(f.project.id,'workspace:view-clean',{...capture,...patch});
    await assert.rejects(copy(),/未保存|冲突|未写回/);
    assert.equal((await clip.native.snapshot()).generation,previous);
    assert.equal(await fs.readFile(path.join(f.root,relPath),'utf8'),text);
  }
  // Retained/offline views use the same capture schema, not the live buffer.
  await f.host.storage.putRecovery(f.project.id,'workspace:view-clean',capture);
  await f.host.storage.putRecovery(f.project.id,'workspace:view-clean:retained:old-owner',{...capture,candidate:{text:'OLD UNSAVED INPUT'}});
  await assert.rejects(copy(),/未写回/);
  assert.equal((await clip.native.snapshot()).generation,previous);
  assert.equal(clip.writes(),1);
});

test('clean Office capture requires host receipt bound to current disk baseline, never stale viewState',async t=>{
  const f=await fixture(t),clip=fakeNative();
  for(const [kind,extension] of [['word','docx'],['sheet','xlsx'],['ppt','pptx']]){
    const relPath='clean.'+extension,disk=Buffer.from('source ZIP serialization '+kind),exported=Buffer.from('different clean ZIP serialization '+kind);
    await fs.writeFile(path.join(f.root,relPath),disk);
    const sourceDigest=createHash('sha256').update(disk).digest('hex');
    const status={dirty:false,composing:false,conflict:false,missing:false};
    const snapshot={projectId:f.project.id,relPath,kind,sourceDigest,baseDigest:sourceDigest,candidate:{bytes:encodeRecoveryBytes(exported)},documentStatus:status,cleanOfficeBaseline:{schemaVersion:1,sourceDigest}};
    const key='workspace:office-'+kind;
    const copy=()=>exportClipboardFiles(f.ops,clip.native,{owner:10,projectId:f.project.id,paths:[relPath],guard:async()=>{}});
    await f.host.storage.putRecovery(f.project.id,key,snapshot);await copy();
    const previous=(await clip.native.snapshot()).generation;
    for(const patch of [
      {cleanOfficeBaseline:undefined},
      {cleanOfficeBaseline:undefined,documentStatus:undefined,viewState:{documentStatus:status}},
      {baseDigest:'0'.repeat(64)},
      {documentStatus:{...status,dirty:true}},
      {documentStatus:{...status,conflict:true}},
      {documentStatus:{...status,composing:true}},
      {offline:true},
    ]){
      await f.host.storage.putRecovery(f.project.id,key,{...snapshot,...patch});
      await assert.rejects(copy());assert.equal((await clip.native.snapshot()).generation,previous);
    }
    await f.host.storage.putRecovery(f.project.id,key,snapshot);
    await fs.writeFile(path.join(f.root,relPath),'externally changed ZIP');
    await assert.rejects(copy(),/未写回/);assert.equal((await clip.native.snapshot()).generation,previous);
  }
});

test('newer canonical clean Office receipt supersedes archived workspace history but never active drafts',async t=>{
  const f=await fixture(t),clip=fakeNative(),relPath='historical.docx',disk=Buffer.from('SAVED ZIP');
  await fs.writeFile(path.join(f.root,relPath),disk);
  const sourceDigest=createHash('sha256').update(disk).digest('hex');
  const canonical={projectId:f.project.id,relPath,kind:'word',baseDigest:sourceDigest,sourceDigest,retainedAt:'2026-10-30T12:00:00.000Z',documentStatus:{dirty:false,composing:false,conflict:false,missing:false},candidate:{bytes:encodeRecoveryBytes(Buffer.from('REEXPORTED ZIP'))},cleanOfficeBaseline:{schemaVersion:1,sourceDigest}};
  const history={...canonical,retainedAt:'2026-10-29T12:00:00.000Z',cleanOfficeBaseline:undefined,documentStatus:undefined,candidate:{bytes:encodeRecoveryBytes(Buffer.from('HISTORICAL ZIP'))}};
  const historyKey='workspace:office:retained:old-owner';
  const copy=()=>exportClipboardFiles(f.ops,clip.native,{owner:10,projectId:f.project.id,paths:[relPath],guard:async()=>{}});
  await clip.native.mark(10,f.project.id);
  await f.host.storage.putRecovery(f.project.id,historyKey,history);
  await assert.rejects(copy());
  await f.host.storage.putRecovery(f.project.id,'workspace:office',canonical);
  for(const archived of [history,{...history,dirty:true,offline:true}]){
    await f.host.storage.putRecovery(f.project.id,historyKey,archived);
    const preserved=await f.host.storage.getRecovery(f.project.id,historyKey);
    await copy();
    assert.deepEqual(parseFileClipboard((await clip.native.snapshot()).entries),[path.join(f.root,relPath)]);
    assert.deepEqual(await f.host.storage.getRecovery(f.project.id,historyKey),preserved);
  }
  const previous=(await clip.native.snapshot()).generation;
  await f.host.storage.putRecovery(f.project.id,'workspace:office',{...canonical,documentStatus:{...canonical.documentStatus,dirty:true}});
  await assert.rejects(copy());assert.equal((await clip.native.snapshot()).generation,previous);
  await f.host.storage.putRecovery(f.project.id,'workspace:office',canonical);
  await f.host.persistDraft(f.project.id,relPath,sourceDigest,'UNSAVED DRAFT','dirty');
  await assert.rejects(copy(),/草稿/);assert.equal((await clip.native.snapshot()).generation,previous);
  await f.host.persistDraft(f.project.id,relPath,sourceDigest,'SAVED','saved');
  await f.host.storage.putRecovery(f.project.id,historyKey,{...history,retainedAt:'2026-10-31T12:00:00.000Z'});
  await assert.rejects(copy());assert.equal((await clip.native.snapshot()).generation,previous);
  assert.equal(await fs.readFile(path.join(f.root,relPath),'utf8'),'SAVED ZIP');
});
