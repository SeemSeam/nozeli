import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesktopHost } from '../src/main/host.mjs';
import {LanguageServiceManager, uriPath} from '../src/main/language-service-manager.mjs';
import {spawnTool} from '../src/main/tool-process.mjs';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {ProjectLifecycle} from '../src/main/project-lifecycle.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nozeli-lsp-project-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'nozeli-lsp-user-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'utils.ts'), 'export function formatUser(value: string): string { return value.trim(); }\n');
  await writeFile(path.join(root, 'src', 'main.ts'), 'import { formatUser } from "./utils";\nconst value: number = formatUser("Nozeli");\nformatUser("again");\n');
  const host = new DesktopHost(userData);
  const opened = await host.pick(root);
  return { root, userData, host, projectId: opened.project.id, async cleanup() { await host.storage.db.close(); await rm(root, { recursive: true, force: true }); await rm(userData, { recursive: true, force: true }); } };
}

test('real typescript-language-server supports diagnostics and cross-file requests', { timeout: 30000 }, async () => {
  const fx = await fixture(); const events = [];
  const manager = new LanguageServiceManager({ host: fx.host, userDataDir: fx.userData, appRoot:path.resolve(import.meta.dirname,'..'),packaged:process.env.NOZELI_TEST_PACKAGED_APP==='1',onEvent: event => events.push(event) });
  try {
    const main = await fx.host.readFile(fx.projectId, 'src/main.ts');
    await manager.sync({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1 });
    let definition = await manager.request({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1, action: 'definition', line: 0, column: 14 });
    const first = Array.isArray(definition) ? definition[0] : definition;
    if (first?.relPath === 'src/main.ts') definition = await manager.request({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1, action: 'definition', line: first.range.start.line, column: first.range.start.character });
    const definitions = Array.isArray(definition) ? definition : definition?.value || definition;
    assert.ok((Array.isArray(definitions) ? definitions : [definitions]).some(item => item?.relPath === 'src/utils.ts'), JSON.stringify(definition));
    const references = await manager.request({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1, action: 'references', line: 2, column: 1 });
    assert.ok(Array.isArray(references) || Array.isArray(references?.value));
    const rename = await manager.request({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1, action: 'rename', line: 2, column: 7, newName: 'inputValue' });
    assert.ok(rename && (rename.changes || rename.value?.changes));
    const format = await manager.request({ projectId: fx.projectId, relPath: 'src/main.ts', text: main.text, version: 1, action: 'format' });
    assert.ok(Array.isArray(format) || Array.isArray(format?.value));
    assert.equal(manager.status().projectId, fx.projectId);
    const expectedDiagnostic = event => event.type === 'diagnostics' && event.relPath === 'src/main.ts' && event.diagnostics.some(item => /number|string|type/i.test(item.message));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !events.some(expectedDiagnostic)) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(events.some(event => event.type === 'ready'));
    assert.ok(events.some(expectedDiagnostic), JSON.stringify(events.filter(event => event.type === 'diagnostics')));
    const unsaved = main.text.replace('const value: number', 'const value: string');
    await manager.sync({ projectId: fx.projectId, relPath: 'src/main.ts', text: unsaved, version: 2 });
    assert.equal(manager.status().projectId, fx.projectId);
    const oldChild = manager.session.child;
    oldChild.kill('SIGTERM');
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline && !events.some(event => event.type === 'exit')) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(events.some(event => event.type === 'exit'));
    await manager.sync({ projectId: fx.projectId, relPath: 'src/main.ts', text: unsaved, version: 3 });
    assert.ok(events.filter(event => event.type === 'ready').length >= 2);
    const packageInfo = JSON.parse(await readFile(new URL('../node_modules/typescript-language-server/package.json', import.meta.url)));
    console.log(JSON.stringify({ serverVersion: packageInfo.version, cwd: fx.root, exit: events.find(event => event.type === 'exit'), logFile: events.find(event => event.type === 'exit')?.logFile }));
  } finally {
    await manager.stopAll();
    await fx.cleanup();
  }
});

test('language service uses pinned current runtime with no Node on PATH', {timeout:30000}, async () => {
  const fx = await fixture();
  const manager = new LanguageServiceManager({host:fx.host,userDataDir:fx.userData,packaged:false,spawnImpl(command,args,options) {
    assert.equal(command,process.execPath);
    return spawnTool(command,args,{...options,env:{...options.env,PATH:'',NODE:'missing-ambient-node',NOZELI_LSP_NODE:'missing-ambient-node'}});
  }});
  try { await manager.start(fx.projectId); assert.equal(manager.status().ready,true); }
  finally { await manager.stopAll(); await fx.cleanup(); }
});

test('missing packaged Node is explicit and does not prevent project reading', async () => {
  const fx = await fixture();
  const manager = new LanguageServiceManager({host:fx.host,userDataDir:fx.userData,packaged:true,appRoot:fx.userData,spawnImpl(){assert.fail('must not launch ambient runtime');}});
  try {
    await assert.rejects(manager.start(fx.projectId),{code:'LSP_UNAVAILABLE'});
    assert.equal(manager.status().ready,false);
    assert.match((await fx.host.readFile(fx.projectId,'src/main.ts')).text,/formatUser/);
  } finally { await manager.stopAll(); await fx.cleanup(); }
});

test('file URI locations decode Unicode, spaces and Windows drive paths', () => {
  const root=path.resolve(os.tmpdir(),'LSP 空间');
  assert.equal(uriPath(pathToFileURL(path.join(root,'子目录','a b.ts')).href,root),'子目录/a b.ts');
  assert.equal(uriPath(pathToFileURL(path.join(root,'..','outside.ts')).href,root),null);
  assert.equal(uriPath('https://example.invalid/a.ts',root),null);
});

test('an unconfirmed Windows language-service stop retains the original session and blocks replacement',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const fx=await fixture(),manager=new LanguageServiceManager({host:fx.host,userDataDir:fx.userData,packaged:false});
 let originalStop,session;
 try{
  session=await manager.start(fx.projectId);originalStop=session.child.requestStop;
  session.child.requestStop=()=>{throw Object.assign(Error('Synthetic native stop could not be confirmed'),{code:'PROCESS_JOB_EXIT_UNCONFIRMED'});};
  await assert.rejects(manager.stop(),{code:'PROCESS_JOB_EXIT_UNCONFIRMED'});
  assert.equal(manager.session,session);assert.equal(manager.status().ready,false);
  await assert.rejects(manager.start(fx.projectId),{code:'PROCESS_JOB_EXIT_UNCONFIRMED'});assert.equal(manager.session,session);
  session.child.requestStop=originalStop;await manager.stopAll();assert.equal(manager.session,null);
 }finally{if(session&&originalStop)session.child.requestStop=originalStop;await manager.stopAll();await fx.cleanup();}
});

test('Windows lifecycle drains and stops a late-starting TypeScript service before Workspace close',{skip:process.platform!=='win32',timeout:60000},async()=>{
 const fx=await fixture(),{host,projectId}=fx,{storage}=host;
 const manager=new LanguageServiceManager({host,userDataDir:fx.userData,packaged:false});
 const entered=Promise.withResolvers(),gate=Promise.withResolvers();
 const logPath=manager.logPath.bind(manager);
 manager.logPath=async id=>{entered.resolve();await gate.promise;return logPath(id);};
 let opening,session,childClosed,closeObserved=false;
 try{
  const project=await host.requireRegisteredProject(projectId);
  opening=storage.withProjectOperation(projectId,async()=>{
   session=await manager.start(projectId);
   childClosed=once(session.child,'close');childClosed.catch(()=>{});
  });
  await Promise.race([entered.promise,opening]);
  const hold=storage.holdProject(projectId,{operationId:randomUUID(),instanceId:project.instanceId,action:'remove',root:project.root});
  const lifecycle=new ProjectLifecycle({host,managed:{stopProject:async()=>({confirmationComplete:true})},beforeStop:async id=>{
   await manager.stopProject(id);
   gate.resolve();
  },workspace:{closeProject:async()=>{
   assert.ok(session,'the admitted startup must have reached a live session');
   assert.equal(manager.status().ready,false);
   assert.equal((await session.child.jobExit).jobEmptyObserved,true);
   await childClosed;
   closeObserved=true;
  }}});
  await lifecycle.stopHeldProject(projectId,hold);
  assert.equal(closeObserved,true);
 }finally{
  gate.resolve();await opening?.catch(()=>{});await manager.stopAll();await fx.cleanup();
 }
});
