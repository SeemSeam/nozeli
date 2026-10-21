import test from 'node:test';
import assert from 'node:assert/strict';
import { documentCommands, formatEditor } from '../src/renderer/document-context-menu.mjs';
const flatten=items=>items.flatMap(item=>[item,...flatten(item.children||[])]);
const ids = surface => flatten(documentCommands(surface)).filter(x => x.id).map(x => x.id);
test('authorship commands apply to all supported text paths and Word, with the actual view state',()=>{
 for(const path of ['a.txt','a.md','a.tex','a.cc','a.py','a.json','a.docx'])for(const visible of [true,false]){
  const menu=flatten(documentCommands({kind:path.endsWith('docx')?'word':'text',relPath:path,canAuthorship:true,authorshipVisible:visible,canFind:!path.endsWith('docx')}));
  assert.equal(menu.find(item=>item.id==='authorship-toggle').label,visible?'隐藏修改者':'显示修改者');assert.notEqual(menu.find(item=>item.id==='authorship-history').enabled,false);
 }
 assert(!ids({kind:'pdf'}).includes('authorship-toggle'));assert(!ids({kind:'text',secondary:true}).includes('authorship-history'));
});
test('menus reflect editable, read-only, PDF and supported formatter capabilities', () => {
  assert.ok(ids({kind:'text',editable:true,code:true,relPath:'a.ts',selected:true}).includes('formatSelection'));
  assert.ok(!ids({kind:'text',editable:true,code:true,relPath:'a.cpp',selected:true}).includes('format'));
  for (const surface of [{kind:'text',reading:true}, {kind:'pdf',reading:true}, {kind:'text',secondary:true}]) {
    const menu = ids(surface); assert.ok(menu.includes('copy')); assert.ok(!menu.includes('cut')); assert.ok(!menu.includes('paste')); assert.ok(!menu.includes('format'));
  }
  assert.ok(ids({kind:'pdf',reading:true,canAnnotate:true}).includes('pageReference'));
});
test('PPT region and export tools remain available only to an eligible document owner',()=>{
 const owner=ids({kind:'ppt',panel:true,projectId:'p',canRegion:true,canExport:true});
 assert(owner.includes('region'));assert(owner.includes('exportPpt'));
 const mirror=ids({kind:'ppt',panel:true,projectId:'p',canRegion:false,canExport:false});
 assert(!mirror.includes('region'));assert(!mirror.includes('exportPpt'));
});
test('folding commands require a code surface with a folding-capable editor', () => {
  for (const editable of [true, false]) {
    const commands = documentCommands({kind:'text', code:true, canFold:true, editable, relPath:'a.cpp'});
    assert.equal(commands.find(item=>item.id==='foldAll')?.label, '全部折叠');
    assert.equal(commands.find(item=>item.id==='unfoldAll')?.label, '全部展开');
  }
  for (const surface of [{kind:'text', code:true}, {kind:'text', reading:true}, {kind:'text', secondary:true}, {kind:'word'}, {kind:'pdf'}]) {
    assert(!ids(surface).some(id=>id==='foldAll'||id==='unfoldAll'));
  }
});
test('late formatter result does not overwrite concurrent editing or switched documents', async () => {
  const old = globalThis.window;
  try {
    let finish; globalThis.window = {nozeli:{invoke:()=>new Promise(resolve=>{finish=resolve;})}};
    let text='const x={a:1};', edits=0, message='';
    const adapter={ getText:()=>text, getSelection:()=>({from:0,to:5,anchor:0,head:5}), applyEdits:()=>{edits++;} };
    const pending=formatEditor({adapter,projectId:'p',relPath:'a.ts',status:m=>{message=m;}});
    text='new typing';finish({ok:true,value:{text:'formatted',version:'3',parser:'typescript'}});await pending;
    assert.equal(edits,0);assert.match(message,/内容已变化/);
    const switched=formatEditor({adapter,projectId:'p',relPath:'a.ts',current:()=>false});finish({ok:true,value:{text:'formatted'}});await switched;assert.equal(edits,0);
  } finally { globalThis.window=old; }
});
test('late formatter result does not replace a newly moved selection',async()=>{
 const old=globalThis.window;
 try{
  let finish,range={from:0,to:5,anchor:0,head:5},edits=0,message='';
  globalThis.window={nozeli:{invoke:()=>new Promise(resolve=>{finish=resolve;})}};
  const adapter={getText:()=> 'const x={a:1};',getSelection:()=>range,applyEdits:()=>edits++};
  const pending=formatEditor({adapter,projectId:'p',relPath:'a.ts',status:m=>{message=m;}});
  range={from:7,to:10,anchor:7,head:10};finish({ok:true,value:{text:'const x = { a: 1 };',version:'3'}});await pending;
  assert.equal(edits,0);assert.match(message,/选区已变化/);
 }finally{globalThis.window=old;}
});
