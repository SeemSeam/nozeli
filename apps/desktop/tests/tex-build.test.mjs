import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopHost } from '../src/main/host.mjs';
import { TexBuildManager, parseTexDiagnostics } from '../src/main/tex-build-manager.mjs';
import {spawnTool,stopTool} from '../src/main/tool-process.mjs';
const exec = promisify(execFile);
const managers=[];test.after(async()=>{for(const manager of managers)await manager.stopAll();});
const source = body => '\\documentclass{article}\n\\begin{document}\n' + body + '\n\\end{document}\n';
async function fixture({ configure = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-tex-test-'));
  const root = path.join(dir, '中文 project'); await fs.mkdir(root); await fs.mkdir(path.join(root, 'sections'));
  await fs.writeFile(path.join(root, 'main.tex'), source('\\input{sections/body}'));
  await fs.writeFile(path.join(root, 'sections/body.tex'), 'Initial body $E=mc^2$.');
  const host = new DesktopHost(path.join(dir, 'profile')); const {project} = await host.pick(root);
  const events = []; const manager = new TexBuildManager({host, onEvent:e=>events.push(e)});managers.push(manager);
  if (configure) await manager.configure({projectId:project.id, root:'main.tex', engine:'xelatex', automatic:false});
  return {dir,root,host,manager,events,id:project.id};
}
async function finish(f, sequence) {
  const start=Date.now();
  for (;;) { const state=await f.manager.status({projectId:f.id}); if (state.sequence===sequence && ['success','error','cancelled'].includes(state.phase)) return state; if(Date.now()-start>45000)throw Error('timeout '+JSON.stringify(state));await new Promise(r=>setTimeout(r,30)); }
}
async function compile(f,buffers=[]) { const r=await f.manager.request({projectId:f.id,buffers});return finish(f,r.sequence); }
async function pdfText(f, state) { const artifact=await f.manager.artifact({projectId:f.id,buildId:state.lastSuccess.buildId});const file=path.join(f.dir,'extract.pdf');await fs.writeFile(file,artifact.bytes);return (await exec('pdftotext',[file,'-'])).stdout; }

test('passive saves from sibling TeX surfaces cannot overwrite an explicit per-root link choice', async () => {
  const f = await fixture();
  const identity = { projectId: f.id, root: 'main.tex' };
  const position = { preview: true, page: 2, zoom: 1.25, scrollTop: 30 };
  for (const linked of [false, true]) {
    await Promise.all([
      f.manager.view({ ...identity, view: { ...position, linked } }),
      f.manager.view({ ...identity, view: { ...position, preview: false } }),
    ]);
    const reopened = new TexBuildManager({ host: f.host });
    assert.deepEqual(await reopened.view(identity), { ...position, preview: false, linked });
  }
});

test('TeX diagnostics resolve absolute compiler paths only inside the frozen work tree', () => {
  const work = path.resolve(os.tmpdir(), 'Nozeli 编译', 'work'), cwd = path.join(work, 'chapters');
  const files = ['chapters/Main.TEX', 'shared/style.sty'].map(relPath => ({relPath}));
  const log = [
    `${path.join(cwd, 'Main.TEX')}:4: undefined control sequence`,
    `${path.join('..', 'shared', 'style.sty')}:7: missing package`,
    `${path.join(work + '-outside', 'chapters', 'Main.TEX')}:3: external source`,
    `${path.join(cwd, 'absent.tex')}:2: not in snapshot`,
  ].join('\r\n');
  assert.deepEqual(parseTexDiagnostics(log, files, work, cwd), [
    {relPath: 'chapters/Main.TEX', line: 4, message: 'undefined control sequence'},
    {relPath: 'shared/style.sty', line: 7, message: 'missing package'},
  ]);
});

test('TeX configuration is manual-only by default and migrates legacy automatic opt-ins', async () => {
  const f = await fixture({ configure: false });
  assert.deepEqual(await f.manager.config(f.id), { root: '', engine: 'xelatex', automatic: false });
  assert.equal(await f.host.storage.getProject(f.id, 'settings', 'tex'), null, 'reading defaults must not create an explicit root/engine selection');
  const legacy = { root: 'main.tex', engine: 'pdflatex', automatic: true };
  await f.host.storage.putProject(f.id, 'settings', 'tex', legacy);
  const expected = { ...legacy, automatic: false };
  assert.deepEqual(await f.manager.config(f.id), expected);
  assert.deepEqual(await f.host.storage.getProject(f.id, 'settings', 'tex'), expected);
  const reopened = new TexBuildManager({ host: f.host }); managers.push(reopened);
  assert.deepEqual(await reopened.config(f.id), expected);
  for (const automatic of [true, false]) {
    const configured = await f.manager.configure({ projectId: f.id, root: 'main.tex', engine: 'xelatex', automatic });
    assert.deepEqual(configured, { root: 'main.tex', engine: 'xelatex', automatic: false });
    assert.deepEqual(await f.host.storage.getProject(f.id, 'settings', 'tex'), configured);
  }
  await assert.rejects(f.manager.configure({ projectId: f.id, root: 'main.tex', engine: 'xelatex', automatic: 'true' }), { code: 'TEX_CONFIG' });
});

test('inspect, file reads, draft edits, saves and external changes never request a TeX build', async t => {
  const f = await fixture();
  t.after(() => f.manager.stopAll());
  const baseline = await f.manager.status({ projectId: f.id });
  const originalRequest = f.manager.request.bind(f.manager), originalBuild = f.manager.build.bind(f.manager);
  let requests = 0, builds = 0;
  t.mock.method(f.manager, 'request', (...args) => { requests++; return originalRequest(...args); });
  t.mock.method(f.manager, 'build', (...args) => { builds++; return originalBuild(...args); });
  await f.host.storage.putProject(f.id, 'settings', 'tex', { root: 'main.tex', engine: 'xelatex', automatic: true });
  const info = await f.manager.inspect({ projectId: f.id, relPath: 'main.tex' });
  assert.equal(info.config.automatic, false);
  assert.deepEqual(info.state, baseline);
  const opened = await f.host.readFile(f.id, 'main.tex');
  const edited = source('Explicitly saved text.');
  await f.host.persistDraft(f.id, 'main.tex', opened.digest, edited, 'dirty');
  await f.host.save(f.id, 'main.tex', opened.digest, edited);
  await fs.writeFile(path.join(f.root, 'sections/body.tex'), 'External edit without compilation.');
  const deadline = Date.now() + 5000;
  while (!f.events.some(event => event.sourceChanged)) {
    assert.ok(Date.now() < deadline, 'source watcher must report the real disk change');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await f.manager.inspect({ projectId: f.id, relPath: 'sections/body.tex' });
  assert.equal(requests, 0);
  assert.equal(builds, 0);
  assert.deepEqual(await f.manager.status({ projectId: f.id }), baseline);
  assert.equal((await f.manager.slot(f.id)).pending, null);
  assert.equal((await f.manager.slot(f.id)).job, null);
  assert.ok(f.events.every(event => event.sourceChanged === true && event.projectId === f.id || event.phase === baseline.phase));
  await assert.rejects(fs.stat(path.join(await f.manager.dir(f.id), 'builds')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.root, 'main.tex'), 'utf8'), edited);
  assert.equal(await fs.readFile(path.join(f.root, 'sections/body.tex'), 'utf8'), 'External edit without compilation.');
});

test('real latexmk: draft overlay, immutable PDF, diagnostics, failure recovery, restart and root ambiguity', async()=>{
  const f=await fixture();
  const config = await f.manager.configure({ projectId: f.id, root: 'main.tex', engine: 'xelatex', automatic: true });
  assert.equal(config.automatic, false, 'legacy callers still compile explicitly without enabling automatic builds');
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

for (const engine of ['pdflatex','lualatex','tectonic']) {
 test(`real ${engine}: explicitly selected engine compiles English math`,async()=>{
  const f=await fixture();
  await f.manager.configure({projectId:f.id,root:'main.tex',engine,automatic:false});
  const state=await compile(f);assert.equal(state.phase,'success',state.log||state.message);assert.match(await pdfText(f,state),/Initial body/);assert.equal(state.lastSuccess.engine,engine);
 });
}

test('a save of the requested TeX bytes before snapshot capture builds from disk, but divergent bytes conflict', async () => {
  const f = await fixture();
  const root = await f.host.readFile(f.id, 'main.tex');
  await f.manager.configure({projectId:f.id,root:'main.tex',engine:'pdflatex',automatic:false});
  const findExecutable = f.manager.findExecutable;
  const savedText = source('Exact autosave snapshot.');
  const buffer = {relPath:'main.tex',baseDigest:root.digest,text:savedText};
  let entered, release;
  const probing = new Promise(resolve => { entered = resolve; });
  const allowCapture = new Promise(resolve => { release = resolve; });
  f.manager.findExecutable = async engine => { entered(); await allowCapture; return findExecutable(engine); };
  const request = await f.manager.request({projectId:f.id,buffers:[buffer]});
  try {
    await probing;
    const saved = await f.host.save(f.id, 'main.tex', root.digest, savedText);
    assert.notEqual(saved.digest, root.digest);
    assert.equal(await fs.readFile(path.join(f.root, 'main.tex'), 'utf8'), savedText);
  } finally { release(); }
  const result = await finish(f, request.sequence);
  assert.equal(result.phase, 'success', `${result.code}: ${result.message}`);
  assert.match(await pdfText(f, result), /Exact autosave snapshot/);
  assert.equal(result.lastSuccess.files.find(file => file.relPath === 'main.tex').draft, false);
  const divergent = source('Divergent external edit.');
  await fs.writeFile(path.join(f.root, 'main.tex'), divergent);
  const refused = await compile(f, [buffer]);
  assert.equal(refused.code, 'TEX_CONFLICT');
  assert.equal(refused.lastSuccess.buildId, result.lastSuccess.buildId);
  assert.equal(await fs.readFile(path.join(f.root, 'main.tex'), 'utf8'), divergent);
});

test('running compiler is killed on cancel/timeout; disk changes during compilation do not publish',async()=>{
 const f=await fixture(),root=await f.host.readFile(f.id,'main.tex');
 const loop=source('\\newcount\\n \\loop\\advance\\n by 1 \\ifnum\\n<50000000 \\repeat Long run.');
 await f.manager.request({projectId:f.id,buffers:[{relPath:'main.tex',baseDigest:root.digest,text:loop}]});
 const slot=await f.manager.slot(f.id),start=Date.now();
 while(!slot.job?.child?.spawnargs.includes('-norc')){assert.ok(Date.now()-start<5000);await new Promise(r=>setTimeout(r,10));}
 const pid=slot.job.child.pid;const cancelled=await f.manager.cancel({projectId:f.id});
 if(process.platform==='win32')assert.equal(cancelled.treeExitVerified,true,'Cancellation must observe native Job empty');
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

test('missing TeX executables are explicit while source reading and retained preview stay available',async()=>{
  const f=await fixture();
  await f.manager.stopAll();
  const retained={buildId:'synthetic-prior-build',pdfDigest:'a'.repeat(64),root:'main.tex'};
  await f.host.storage.putRecovery(f.id,'tex:last-success',retained);
  const manager=new TexBuildManager({host:f.host,findExecutable:async()=>null,findSynctex:async()=>null});managers.push(manager);
  try {
    const info=await manager.inspect({projectId:f.id,relPath:'main.tex'});
    assert(Object.values(info.tools).every(value=>value===false));assert.equal(info.syncTool,false);
    const {sequence}=await manager.request({projectId:f.id});
    const state=await finish({...f,manager},sequence);
    assert.equal(state.phase,'error');assert.equal(state.code,'TEX_TOOL_MISSING');
    assert.equal(state.lastSuccess.buildId,retained.buildId);
    assert.match((await f.host.readFile(f.id,'main.tex')).text,/documentclass/);
    assert.equal((await manager.slot(f.id)).job,null);
  } finally { await manager.stopAll(); }
});

test('a new PDF without SyncTeX never inherits the previous build map', {timeout:30000}, async()=>{
  const f=await fixture(), node=process.versions.electron?process.env.NOZELI_TEST_NODE_EXECUTABLE:process.execPath;
  const original=await fs.readFile(path.join(f.root,'main.tex'),'utf8');
  await f.manager.configure({projectId:f.id,root:'main.tex',engine:'tectonic',automatic:false});
  f.manager.findExecutable=async name=>name==='tectonic'?node:null;
  f.manager.spawnImpl=(command,args,options)=>spawnTool(command,args.includes('--version')?['--version']:['-e',`
    const fs=require('node:fs');
    const first=fs.readFileSync('main.tex','utf8').includes('Initial map');
    fs.writeFileSync('main.pdf',first?'%PDF-first':'%PDF-second');
    if(first)fs.writeFileSync('main.synctex.gz',require('node:zlib').gzipSync('synthetic map'));
  `],options);
  try{
    const root=await f.host.readFile(f.id,'main.tex');
    const build=text=>compile(f,[{relPath:'main.tex',baseDigest:root.digest,text}]);
    const first=await build(source('Initial map'));
    assert.equal(first.phase,'success',first.log||first.message);
    assert.match(first.lastSuccess.synctexDigest,/^[0-9a-f]{64}$/);
    const firstMap=await f.host.storage.readRecoveryObject(f.id,first.lastSuccess.synctexDigest);
    const text=source('New PDF without a map'), second=await build(text);
    assert.equal(second.phase,'success',second.log||second.message);
    const {buildId}=second.lastSuccess;
    assert.equal((await f.manager.artifact({projectId:f.id,buildId})).bytes.toString(),'%PDF-second');
    assert.equal(second.lastSuccess.synctexDigest,null);
    await assert.rejects(f.manager.sync({projectId:f.id,buildId,relPath:'main.tex',text,direction:'forward',line:3}),{code:'TEX_SYNC_MISSING'});
    assert.deepEqual(await f.host.storage.readRecoveryObject(f.id,first.lastSuccess.synctexDigest),firstMap);
    const oldBuild=first.lastSuccess.buildId;
    const oldDir=path.join(await f.manager.dir(f.id),'builds',oldBuild);
    const query={projectId:f.id,buildId:oldBuild,relPath:'main.tex',text:source('Initial map'),direction:'forward',line:3};
    const mapFile=(await f.host.storage.recoveryObjects(f.id)).location(first.lastSuccess.synctexDigest);
    await fs.writeFile(mapFile,'corrupt stored map');
    try { await assert.rejects(f.manager.sync(query),{code:'MATERIAL_CORRUPT'}); }
    finally { await fs.writeFile(mapFile,firstMap); }
    await fs.writeFile(path.join(oldDir,'preview.synctex.gz'),'corrupt cached map');
    await fs.writeFile(path.join(oldDir,'preview.pdf'),'corrupt cached PDF');
    f.manager.findSynctex=async()=>node;
    f.manager.spawnImpl=(command,args,options)=>spawnTool(command,['-e',`
      const fs=require('node:fs'), pdf=process.argv[1];
      if(fs.readFileSync(pdf,'utf8')!=='%PDF-first'||require('node:zlib').gunzipSync(fs.readFileSync(pdf.replace(/\\.pdf$/,'.synctex.gz'))).toString()!=='synthetic map')process.exit(1);
      console.log(['SyncTeX result begin','Output:'+pdf,'Page:1','x:10','y:20','SyncTeX result end'].join('\\n'));
    `,args.at(-1)],options);
    assert.deepEqual((await f.manager.sync(query)).points,[{page:1,x:10,y:20}]);
    assert.equal(await fs.readFile(path.join(f.root,'main.tex'),'utf8'),original);
  }finally{await f.manager.stopAll();await f.host.storage.db.close();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('Windows TeX transport failure retains its original running Job and blocks replacement until confirmed stop',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const f=await fixture(),node=process.versions.electron?process.env.NOZELI_TEST_NODE_EXECUTABLE:process.execPath;let child,originalStop;
 await f.manager.configure({projectId:f.id,root:'main.tex',engine:'tectonic',automatic:false});
 f.manager.findExecutable=async name=>name==='tectonic'?node:null;
 f.manager.spawnImpl=(command,args,options)=>spawnTool(command,args.includes('--version')?['--version']:['-e','setInterval(()=>{},1000)'],options);
 const original=await fs.readFile(path.join(f.root,'main.tex'));
 try{
  await f.manager.request({projectId:f.id});const slot=await f.manager.slot(f.id),deadline=Date.now()+10000;
  while(!slot.job?.child?.spawnargs.includes('-e')){assert.ok(Date.now()<deadline,'contained compiler did not start');await new Promise(resolve=>setTimeout(resolve,10));}
  child=slot.job.child;originalStop=child.requestStop;child.requestStop=()=>{throw Object.assign(Error('Synthetic unconfirmed native stop'),{code:'PROCESS_JOB_EXIT_UNCONFIRMED'});};
  child.emit('error',Object.assign(Error('Synthetic runtime pipe failure'),{code:'PROCESS_STDOUT_READ_FAILED'}));await slot.running;
  assert.equal(slot.job.child,child);assert.equal(child.lease.snapshot().leaderState,'running');
  await assert.rejects(f.manager.request({projectId:f.id}),{code:'PROCESS_JOB_EXIT_UNCONFIRMED'});
  child.requestStop=originalStop;const stopped=await f.manager.cancel({projectId:f.id});assert.equal(stopped.treeExitVerified,true);assert.equal((await child.jobExit).jobEmptyObserved,true);assert.equal(slot.job,null);
  assert.deepEqual(await fs.readFile(path.join(f.root,'main.tex')),original);
 }finally{
  if(child&&originalStop)child.requestStop=originalStop;
  try{await f.manager.stopAll();}finally{if(child){await stopTool(child);child.close();}await f.host.storage.db.close();await fs.rm(f.dir,{recursive:true,force:true});}
 }
});
