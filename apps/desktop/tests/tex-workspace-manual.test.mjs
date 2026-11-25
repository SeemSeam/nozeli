import test from 'node:test';
import assert from 'node:assert/strict';
import {createTexPersistFixture,deferred} from './tex-workspace-persist.fixture.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const failure=(code,message)=>({ok:false,error:{code,message}});
async function fixture(t,options){const f=await createTexPersistFixture(options);t.after(()=>f.cleanup());return f;}

test('opening, editing, composition, configuration and external changes never build',async t=>{
 const f=await fixture(t);f.config.automatic=true;await f.enter();
 f.workspace.changed();f.workspace.composing();await f.changeRoot('other.tex');
 await settle();
 assert.equal(f.calls.some(x=>x.op==='tex.build'),false);
 assert.equal(f.calls.some(x=>x.op==='file.read'||x.op==='tex.artifact'),false);
 assert.equal(f.calls.find(x=>x.op==='tex.configure').args.automatic,false);
 assert.match(f.message(),/设置已保存/);
});

test('preview reads the open source sibling even when a different root is configured',async t=>{
 const f=await fixture(t,{context:{project:{id:'project-a'},file:{kind:'text',relPath:'sections/chapter.tex'}}});
 await f.enter();
 f.handlers.set('file.read',()=>failure('NOT_FOUND','chapter.pdf 不存在'));
 f.node('tex-preview').onclick();await settle();
 assert.deepEqual(f.calls.find(x=>x.op==='file.read').args,{projectId:'project-a',relPath:'sections/chapter.pdf'});
 assert.equal(f.calls.some(x=>x.op==='tex.artifact'||x.op==='tex.build'),false);
 assert.match(f.message(),/chapter.pdf 不存在/);
});

test('explicit refresh failure retains the displayed PDF and never changes the editor',async t=>{
 const f=await fixture(t);await f.enter();f.preview();const pdf=f.beside.pdf;
 f.handlers.set('file.read',()=>failure('NOT_FOUND','main.pdf 不存在'));
 f.node('tex-refresh').onclick();await settle();
 assert.equal(f.beside.pdf,pdf);assert.match(f.node('secondary-message').textContent,/保留原预览/);
 f.handlers.set('file.read',()=>({ok:true,value:{kind:'text',text:'invalid PDF'}}));
 f.node('tex-refresh').onclick();await settle();
 assert.equal(f.beside.pdf,pdf);assert.match(f.message(),/不是有效 PDF/);
 assert.equal(f.calls.filter(x=>x.op==='file.read').length,2);
 assert.equal(f.calls.some(x=>/build|save|draft|write/.test(x.op)),false);
});

test('late read errors cannot overwrite a new source identity',async t=>{
 const f=await fixture(t);await f.enter();const read=deferred();
 f.handlers.set('file.read',()=>read.promise);f.node('tex-preview').onclick();
 f.workspace.leave();f.context={project:{id:'project-b'},file:{kind:'text',relPath:'other.tex'}};await f.enter();
 read.resolve(failure('NOT_FOUND','OLD_PREVIEW_ERROR'));await settle();
 assert.doesNotMatch(f.message(),/OLD_PREVIEW_ERROR/);
});

test('missing sibling uses only an exact root and engine frozen artifact',async t=>{
 for(const [root,engine,expected]of [['other.tex','xelatex',false],['main.tex','pdflatex',false],['main.tex','xelatex',true]]){
  const f=await createTexPersistFixture();
  try{
   f.handlers.set('tex.inspect',()=>({ok:true,value:{config:f.config,configuredRoot:'main.tex',texFiles:['main.tex'],tools:{xelatex:true},state:{phase:'success',lastSuccess:{root,engine,buildId:'frozen'}},view:{preview:false}}}));
   await f.enter();f.handlers.set('file.read',()=>failure('NOT_FOUND','missing'));f.handlers.set('tex.artifact',()=>failure('TEX_INTEGRITY','artifact failure'));
   f.node('tex-preview').onclick();await settle();
   assert.equal(f.calls.some(x=>x.op==='tex.artifact'),expected);
   assert.equal(f.calls.some(x=>x.op==='tex.build'),false);
  }finally{await f.cleanup();}
 }
});
