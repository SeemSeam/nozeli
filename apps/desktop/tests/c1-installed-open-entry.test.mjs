import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateReleaseEntry,prepareOpenEntry,childEnvironment} from './c1-installed-open-entry.mjs';

// Entry-only synthetic filesystem fixtures, not Electron/Host/model receipts.
const root=await fs.mkdtemp(path.join('/tmp','nozeli-c1-entry-tests-'));
const sha=b=>createHash('sha256').update(b).digest('hex');
let next=0;
async function fixture({provider=false}={}){
 const dir=path.join(root,String(++next)),release=path.join(dir,'.local/opt/nozeli/releases/2026-10-13T00-00-00-000Z'),app=path.join(release,'resources/app');await fs.mkdir(app,{recursive:true});
 const marker=path.join(dir,'EXECUTABLE_WAS_STARTED'),exe=path.join(release,'nozeli'),bytes=Buffer.from(`#!/bin/sh\nprintf started > '${marker}'\n`);await fs.writeFile(exe,bytes,{mode:0o755});
 const detection=`export async function detectProviders(){return {providers:['codex','omp','claude'].map(id=>({id,available:${provider}})),commands:{}};}`;
 // The installed app contract the entry harness actually imports: an archive-reader
 // runtime whose constructor only validates the absolute profile root (never writes
 // into it) and whose detect() surfaces available providers for preflight refusal.
 const runtime="import path from 'node:path';\nimport {detectProviders} from './detect.mjs';\nexport class AgentRuntime {\n constructor({userDataDir}={}){if(typeof userDataDir!=='string'||!path.isAbsolute(userDataDir))throw Object.assign(Error('Application metadata directory must be absolute.'),{code:'INVALID_DIRECTORY'});this.userDataDir=userDataDir;}\n async detect(){const detected=await detectProviders();return {providers:detected.providers.filter(candidate=>candidate.available),readOnly:true};}\n}\n";
 const files={'src/agents/detect.mjs':detection,'src/agents/runtime.mjs':runtime,'src/agents/handoff-entry.cjs':'// dedicated agent entry anchor; entry validation never executes this file\n','src/main/host.mjs':'export class DesktopHost {}','dist/renderer/index.html':'fixture-only surface'};
 for(const [rel,text] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(app,rel)),{recursive:true});await fs.writeFile(path.join(app,rel),text);}
 const rows=Object.entries(files).map(([p,b])=>({path:p,sha256:sha(b)})),manifest=path.join(dir,'built-manifest.json');
 const env={NOZELI_C1_MODE:'installed',NOZELI_C1_RELEASE:release,NOZELI_C1_EXPECTED_EXE_SHA256:sha(bytes),NOZELI_C1_BUILT_MANIFEST:manifest,NOZELI_C1_EVIDENCE_ROOT:root};
 async function save(newRows=rows){const b=JSON.stringify(newRows);await fs.writeFile(manifest,b);env.NOZELI_C1_EXPECTED_MANIFEST_SHA256=sha(b);}
 await save();return {dir,release,app,marker,exe,rows,manifest,env,save};
}
async function rejected(env,code,fn=validateReleaseEntry){await assert.rejects(fn(env),e=>e.code===code);}
async function absent(marker){await assert.rejects(fs.access(marker),e=>e.code==='ENOENT');}
const cli=fileURLToPath(new URL('./c1-installed-open.mjs',import.meta.url));
async function invokeRejected(f,code){
 const child=spawn(process.execPath,[cli],{env:{...process.env,...f.env,OPENAI_API_KEY:'ENTRY_TEST_SECRET_MUST_NOT_PRINT'},stdio:['ignore','pipe','pipe']});let output='';for(const s of [child.stdout,child.stderr])s.on('data',b=>output+=b);const exit=await new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));assert.deepEqual(exit,{code:1,signal:null});assert.equal(output.trim(),code);assert(!output.includes('ENTRY_TEST_SECRET_MUST_NOT_PRINT'));await absent(f.marker);
 await fs.writeFile(path.join(f.dir,'entry-output.log'),output);await fs.writeFile(path.join(f.dir,'entry-exit.json'),JSON.stringify({expectedRejection:code,exit,executableStarted:false}));
}

test('missing/relative/default/current/launcher paths reject instead of resolving user installation',async()=>{
 for(const p of [undefined,'relative/path','/home/example/.local/opt/nozeli/current','/home/example/.local/bin/nozeli','/home/example/.local/opt/nozeli/current-next']){
  await rejected({NOZELI_C1_RELEASE:p},!p||!path.isAbsolute(p)?'RELEASE_ABSOLUTE_REQUIRED':'RELEASE_ALIAS_REFUSED');
 }
 await rejected({NOZELI_C1_RELEASE:'/tmp/release'},'VERSIONED_RELEASE_REQUIRED');
});
test('versioned symlink release is refused without following it into execution',async()=>{const f=await fixture();await fs.rename(f.release,f.release+'-real');await fs.symlink(f.release+'-real',f.release,'dir');await rejected(f.env,'RELEASE_LINK_REFUSED');await absent(f.marker);});
test('formal mode requires both root hashes and explicit manifest',async()=>{const f=await fixture();for(const [key,code] of [['NOZELI_C1_EXPECTED_EXE_SHA256','EXPECTED_EXE_HASH_REQUIRED'],['NOZELI_C1_BUILT_MANIFEST','BUILT_MANIFEST_REQUIRED'],['NOZELI_C1_EXPECTED_MANIFEST_SHA256','EXPECTED_MANIFEST_HASH_REQUIRED']]){const env={...f.env};delete env[key];await rejected(env,code);}await absent(f.marker);});
test('wrong executable hash rejects at real harness entry before executable starts',async()=>{const f=await fixture();f.env.NOZELI_C1_EXPECTED_EXE_SHA256='0'.repeat(64);await invokeRejected(f,'EXE_HASH_MISMATCH');});
test('wrong manifest hash rejects at real harness entry before installed imports/spawn',async()=>{const f=await fixture();f.env.NOZELI_C1_EXPECTED_MANIFEST_SHA256='0'.repeat(64);await invokeRejected(f,'MANIFEST_HASH_MISMATCH');});
test('invalid JSON does not leak manifest bytes in rejection output',async()=>{const f=await fixture();const bad='ENTRY_TEST_SECRET_MUST_NOT_PRINT {';await fs.writeFile(f.manifest,bad);f.env.NOZELI_C1_EXPECTED_MANIFEST_SHA256=sha(bad);await invokeRejected(f,'MANIFEST_INVALID');});
test('manifest traversal/duplicate/outside-src-dist paths reject',async()=>{for(const p of ['src/../../auth.json','package.json','src\\main\\host.mjs']){const f=await fixture();await f.save([...f.rows,{path:p,sha256:'0'.repeat(64)}]);await rejected(f.env,'MANIFEST_PATH_INVALID');}const f=await fixture();await f.save([...f.rows,f.rows[0]]);await rejected(f.env,'MANIFEST_PATH_INVALID');});
test('manifest missing required source/dist anchors rejects',async()=>{const f=await fixture();await f.save(f.rows.filter(r=>r.path!=='src/agents/detect.mjs'));await rejected(f.env,'MANIFEST_INCOMPLETE');});
test('unlisted extra files and subsets are rejected, not just listed-file hashes',async()=>{const f=await fixture();await fs.writeFile(path.join(f.app,'src/extra.mjs'),'unapproved source');await rejected(f.env,'MANIFEST_COVERAGE_MISMATCH');const g=await fixture();await g.save(g.rows.filter(r=>!r.path.startsWith('dist/')));await rejected(g.env,'MANIFEST_INCOMPLETE');});
test('source tampering rejects at real harness entry before executable starts',async()=>{const f=await fixture();await fs.writeFile(path.join(f.app,'src/main/host.mjs'),'changed source');await invokeRejected(f,'BUILT_FILE_HASH_MISMATCH');});
test('source root and executable links are refused',async()=>{const f=await fixture();await fs.rename(path.join(f.app,'src'),path.join(f.app,'source-real'));await fs.symlink(path.join(f.app,'source-real'),path.join(f.app,'src'),'dir');await rejected(f.env,'BUILT_FILE_UNSAFE');const g=await fixture();await fs.rename(g.exe,g.exe+'-real');await fs.symlink(g.exe+'-real',g.exe);await rejected(g.env,'EXECUTABLE_UNSAFE');});
test('Provider available result fails preflight before real harness can spawn',async()=>{const f=await fixture({provider:true});await invokeRejected(f,'PROVIDER_PREFLIGHT_FAILED');});
test('evidence aliases/default-profile locations cannot select output/profile',async()=>{const f=await fixture();await rejected({...f.env,NOZELI_C1_EVIDENCE_ROOT:'/home/example/.config/Nozeli'},'EVIDENCE_ROOT_UNSAFE',prepareOpenEntry);});
test('child environment retains HOME/display but strips authentication and unknown/proxy/injection env',()=>{
 const env=childEnvironment({HOME:'/unchanged/home',LANG:'zh_CN.UTF-8',WAYLAND_DISPLAY:'wayland-0',XAUTHORITY:'private-file',OPENAI_API_KEY:'secret',AWS_SECRET_ACCESS_KEY:'secret',SSH_AUTH_SOCK:'secret',NOZELI_NATIVE_TOKEN:'secret',ACME_LOGIN_HEADER:'secret',HTTPS_PROXY:'user:secret',NODE_OPTIONS:'--require evil'},{PATH:'/empty/bin'});
 assert.deepEqual(env,{HOME:'/unchanged/home',LANG:'zh_CN.UTF-8',WAYLAND_DISPLAY:'wayland-0',PATH:'/empty/bin'});
});
console.log('Entry fixture originals: '+root);
