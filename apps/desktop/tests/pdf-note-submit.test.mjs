import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
// Execute the production submit handler with a deliberately delayed queue/IPC.
const source=await fs.readFile(new URL('../src/renderer/app.mjs',import.meta.url),'utf8');
const start=source.indexOf("  $('note-form').addEventListener('submit'");
const handler=source.slice(start,source.indexOf("  $('note-input').addEventListener",start));
function fixture(invoke=async()=>({ok:true})){
 const draft=page=>({projectId:'p',relPath:'sample.pdf',materialDigest:'original',kind:'pdf-page',anchor:{page},text:'same text'});
 const ui={project:{id:'p'},file:{kind:'pdf',relPath:'sample.pdf'},materialDigest:'original',frozenNote:draft(1),pdf:{current:()=>1},pdfSelection:{kind:'pdf-page',anchor:{page:1}}};
 let submit;const nodes={'note-input':{value:'same text'},'note-form':{hidden:false,addEventListener:(_event,fn)=>submit=fn,classList:{remove(){}},style:{removeProperty(){}}},'selection-menu':{hidden:false}},queue=[],saved=[],errors=[],cleared=[];
 const same=d=>d?.projectId===ui.project.id&&d.relPath===ui.file.relPath&&d.materialDigest===ui.materialDigest;
 new Function('ui','$','enqueue','sameNoteTarget','invoke','setStatus','workspace','refreshNotes','rememberCurrentNote','flushNow','compositeDrawing',handler)(ui,id=>nodes[id],fn=>queue.push(fn),same,async(op,payload)=>{saved.push({op,payload});return invoke();},(...args)=>errors.push(args),{noteFor:()=>draft(1),rememberNote:d=>cleared.push(d)},async()=>{},()=>{},async()=>({ok:true}),async()=>null);
 return {ui,nodes,queue,saved,errors,cleared,draft,submit:()=>submit({preventDefault(){}})};
}
test('queued PDF save retains the submitted page when a newer page draft is opened',async()=>{
 const f=fixture();f.submit();f.ui.frozenNote=f.draft(2);f.ui.pdfSelection={kind:'pdf-page',anchor:{page:2}};
 await f.queue[0]();assert.equal(f.saved[0].payload.anchor.page,1);assert.equal(f.saved[0].payload.materialDigest,'original');assert.equal(f.ui.frozenNote.anchor.page,2);assert.equal(f.nodes['note-input'].value,'same text');assert.equal(f.nodes['note-form'].hidden,false);assert.equal(f.ui.pdfSelection.anchor.page,2);assert.equal(f.cleared[0].anchor.page,1);assert.equal(f.cleared[0].text,'');
});
test('late PDF save receipt cannot clear a newer draft with identical text',async()=>{
 let release;const f=fixture(()=>new Promise(resolve=>{release=resolve;}));f.submit();const done=f.queue[0]();f.ui.frozenNote=f.draft(2);f.ui.pdfSelection={kind:'pdf-page',anchor:{page:2}};release({ok:true});await done;assert.equal(f.ui.frozenNote.anchor.page,2);assert.equal(f.nodes['note-form'].hidden,false);assert.equal(f.nodes['note-input'].value,'same text');
});
test('changed PDF version refuses queued save without rebinding or deleting the draft',async()=>{
 const f=fixture();f.submit();f.ui.materialDigest='new-version';await f.queue[0]();assert.equal(f.saved.length,0);assert.equal(f.ui.frozenNote.materialDigest,'original');assert.equal(f.errors.length,1);
});
