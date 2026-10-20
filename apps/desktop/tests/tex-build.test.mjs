import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopHost } from '../src/main/host.mjs';
import { TexBuildManager } from '../src/main/tex-build-manager.mjs';
const exec = promisify(execFile);
const managers=[];test.after(async()=>{for(const manager of managers)await manager.stopAll();});
const source = body => '\\documentclass{article}\n\\begin{document}\n' + body + '\n\\end{document}\n';
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-tex-test-'));
  const root = path.join(dir, '中文 project'); await fs.mkdir(root); await fs.mkdir(path.join(root, 'sections'));
  await fs.writeFile(path.join(root, 'main.tex'), source('\\input{sections/body}'));
  await fs.writeFile(path.join(root, 'sections/body.tex'), 'Initial body $E=mc^2$.');
  const host = new DesktopHost(path.join(dir, 'profile')); const {project} = await host.pick(root);
  const events = []; const manager = new TexBuildManager({host, onEvent:e=>events.push(e)});managers.push(manager);
  await manager.configure({projectId:project.id, root:'main.tex', engine:'xelatex', automatic:true});
  return {dir,root,host,manager,events,id:project.id};
}
async function finish(f, sequence) {
  const start=Date.now();
  for (;;) { const state=await f.manager.status({projectId:f.id}); if (state.sequence===sequence && ['success','error','cancelled'].includes(state.phase)) return state; if(Date.now()-start>45000)throw Error('timeout '+JSON.stringify(state));await new Promise(r=>setTimeout(r,30)); }
}
async function compile(f,buffers=[]) { const r=await f.manager.request({projectId:f.id,buffers});return finish(f,r.sequence); }
async function pdfText(f, state) { const artifact=await f.manager.artifact({projectId:f.id,buildId:state.lastSuccess.buildId});const file=path.join(f.dir,'extract.pdf');await fs.writeFile(file,artifact.bytes);return (await exec('pdftotext',[file,'-'])).stdout; }

test('real latexmk: draft overlay, immutable PDF, diagnostics, failure recovery, restart and root ambiguity', async()=>{
  const f=await fixture();
  const first=await compile(f);assert.equal(first.phase,'success',first.log||first.message);assert.match(await pdfText(f,first),/Initial body/);
  const sub=await f.host.readFile(f.id,'sections/body.tex');await f.host.persistDraft(f.id,'sections/body.tex',sub.digest,'Unsaved chapter Beta.', 'dirty');
  const second=await compile(f);assert.equal(second.phase,'success',second.log);assert.match(await pdfText(f,second),/Unsaved chapter Beta/);assert.notEqual(first.lastSuccess.pdfDigest,second.lastSuccess.pdfDigest);
  assert.equal(await fs.readFile(path.join(f.root,'sections/body.tex'),'utf8'),sub.text);
  assert.match(await pdfText(f,first),/Initial body/);
  const root=await f.host.readFile(f.id,'main.tex');const failed=await compile(f,[{relPath:'main.tex',baseDigest:root.digest,text:source('\\DefinitelyInvalidCommand')}]);
  assert.equal(failed.phase,'error');assert.equal(failed.lastSuccess.buildId,second.lastSuccess.buildId);assert.ok(failed.diagnostics.some(d=>d.relPath==='main.tex'&&d.line===3),JSON.stringify(failed.diagnostics));
  const recovered=await compile(f,[{relPath:'main.tex',baseDigest:root.digest,text:source('Recovered Gamma.')}]);assert.equal(recovered.phase,'success',recovered.log);assert.match(await pdfText(f,recovered),/Recovered Gamma/);
  assert.equal(await fs.readFile(path.join(f.root,'main.tex'),'utf8'),root.text);
  const reopened=new TexBuildManager({host:f.host});managers.push(reopened);assert.equal((await reopened.status({projectId:f.id})).lastSuccess.buildId,recovered.lastSuccess.buildId);assert.equal((await reopened.config(f.id)).root,'main.tex');
  await fs.writeFile(path.join(f.root,'other.tex'),source('Another root'));
  await reopened.configure({projectId:f.id,root:'',engine:'xelatex',automatic:false});const inspect=await reopened.inspect({projectId:f.id});assert.equal(inspect.config.root,'');assert.equal(inspect.roots.length,2);
  console.log(JSON.stringify({scenario:'draft/error/recovery',dir:f.dir,builds:[first.lastSuccess.durationMs,second.lastSuccess.durationMs,recovered.lastSuccess.durationMs],version:first.lastSuccess.engineVersion}));
});

test('coalescing never publishes stale builds, cancellation and conflict protect source',async()=>{
 const f=await fixture(), root=await f.host.readFile(f.id,'main.tex');
 const a=await f.manager.request({projectId:f.id,buffers:[{relPath:'main.tex',baseDigest:root.digest,text:source('Obsolete request')}]});
 const b=await f.manager.request({projectId:f.id,buffers:[{relPath:'main.tex',baseDigest:root.digest,text:source('Latest request')}]});
 const result=await finish(f,b.sequence);assert.equal(result.phase,'success',result.log);assert.match(await pdfText(f,result),/Latest request/);assert.ok(!f.events.some(e=>e.phase==='success'&&e.sequence===a.sequence));
 await f.manager.request({projectId:f.id,buffers:[{relPath:'main.tex',baseDigest:root.digest,text:source('\\loop\\iftrue\\repeat')}]});
 const cancelled=await f.manager.cancel({projectId:f.id});assert.equal(cancelled.phase,'cancelled');assert.equal(cancelled.lastSuccess.buildId,result.lastSuccess.buildId);
 const next=await compile(f);assert.equal(next.phase,'success',next.log);
 await fs.writeFile(path.join(f.root,'main.tex'),source('External edit'));
 const conflict=await compile(f,[{relPath:'main.tex',baseDigest:root.digest,text:source('Old draft')}]);assert.equal(conflict.code,'TEX_CONFLICT');assert.equal(await fs.readFile(path.join(f.root,'main.tex'),'utf8'),source('External edit'));
 console.log(JSON.stringify({scenario:'queue/cancel/conflict',dir:f.dir}));
});

test('resource boundary, executable rc ignored, and project isolation',async()=>{
 const a=await fixture(),b=await fixture();await fs.writeFile(path.join(a.root,'latexmkrc'),"die 'PROJECT RC EXECUTED';");
 assert.equal((await compile(a)).phase,'success');assert.equal((await b.manager.status({projectId:b.id})).lastSuccess,null);
 await assert.rejects(a.manager.configure({projectId:a.id,root:'../main.tex',engine:'xelatex',automatic:true}),/项目内/);
 await assert.rejects(a.manager.configure({projectId:a.id,root:'main.tex',engine:'unknown',automatic:true}),/引擎/);
 await fs.symlink(os.tmpdir(),path.join(a.root,'outside'));
 const result=await compile(a);assert.equal(result.code,'TEX_SYMLINK');
});

test('real pdfLaTeX and explicitly selected Tectonic compile English math',async()=>{
 const f=await fixture();
 for(const engine of ['pdflatex','tectonic']){
  await f.manager.configure({projectId:f.id,root:'main.tex',engine,automatic:false});
  const state=await compile(f);assert.equal(state.phase,'success',state.log||state.message);assert.match(await pdfText(f,state),/Initial body/);assert.equal(state.lastSuccess.engine,engine);
 }
});

test('running compiler is killed on cancel/timeout; disk changes during compilation do not publish',async()=>{
 const f=await fixture(),root=await f.host.readFile(f.id,'main.tex');
 const loop=source('\\newcount\\n \\loop\\advance\\n by 1 \\ifnum\\n<50000000 \\repeat Long run.');
 await f.manager.request({projectId:f.id,buffers:[{relPath:'main.tex',baseDigest:root.digest,text:loop}]});
 const slot=await f.manager.slot(f.id),start=Date.now();
 while(!slot.job?.child?.spawnargs.includes('-norc')){assert.ok(Date.now()-start<5000);await new Promise(r=>setTimeout(r,10));}
 const pid=slot.job.child.pid;await f.manager.cancel({projectId:f.id});
 while(slot.job){assert.ok(Date.now()-start<5000);await new Promise(r=>setTimeout(r,10));}
 assert.throws(()=>process.kill(pid,0));
 f.manager.timeout=250;
 const timeout=await compile(f,[{relPath:'main.tex',baseDigest:root.digest,text:loop}]);assert.equal(timeout.code,'TEX_TIMEOUT');
 f.manager.timeout=10000;
 const r=await f.manager.request({projectId:f.id,buffers:[{relPath:'main.tex',baseDigest:root.digest,text:source('\\newcount\\n \\loop\\advance\\n by 1 \\ifnum\\n<1000000 \\repeat Concurrent run.')}]});
 while(!slot.job?.child?.spawnargs.includes('-norc'))await new Promise(r=>setTimeout(r,10));
 await fs.writeFile(path.join(f.root,'sections/body.tex'),'External chapter edit.');
 const changed=await finish(f,r.sequence);assert.equal(changed.code,'TEX_CONFLICT');
 assert.equal(await fs.readFile(path.join(f.root,'main.tex'),'utf8'),root.text);
});

test('TeX entry discovery is independent of non-TeX snapshot resource limit',async()=>{
 const f=await fixture();await fs.mkdir(path.join(f.root,'data'));
 for(let start=0;start<3005;start+=100)await Promise.all(Array.from({length:Math.min(100,3005-start)},(_,i)=>fs.writeFile(path.join(f.root,'data',`${start+i}.txt`),'resource')));
 const info=await f.manager.inspect({projectId:f.id,relPath:'main.tex'});
 assert(info.texFiles.includes('main.tex'));assert(info.tools);assert.equal(info.config.root,'main.tex');
});
