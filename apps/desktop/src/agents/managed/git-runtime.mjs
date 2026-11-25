import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import {Readable} from 'node:stream';
import { assertBundledExecutable } from '../../platform/shared/runtime-assets.mjs';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
let provisioning;

// MinGit's startup probes still use MAX_PATH even when core.longpaths permits
// long tracked names; those probes count UTF-16 units, so the working-directory
// check stays on UTF-16 length (258). Worktrees are different and measured:
// the bundled MinGit (2.53) dies inside `git worktree add` with
// "fatal: '$GIT_DIR' too big" once the absolute worktree '.git' pointer path
// exceeds 220 UTF-8 bytes — its internal check counts bytes — even with
// core.longpaths and --relative-paths. Each check uses the unit its runtime
// mechanism actually counts.
export function assertGitDirectory(directory,{worktree=false}={}) {
  if(process.platform!=='win32')return;
  const resolved=path.resolve(directory),gitPath=worktree?path.join(resolved,'.git'):resolved;
  const bytes=Buffer.byteLength(gitPath,'utf8');
  if(worktree?bytes>220:gitPath.length>258)throw Object.assign(new Error(worktree
    ?'当前随包 Git 不支持这么深的执行工作目录（工作树 .git 指针路径超过其编译上限）；请将本地数据目录放在更短的位置。'
    :'当前随包 Git 不支持这么深的工作目录；请选择较短的项目或本地数据目录。'),{
    code:worktree?'UNSUPPORTED_GIT_WORKTREE_PATH':'UNSUPPORTED_GIT_WORKING_DIRECTORY',
    directory:resolved,utf8Bytes:bytes,utf16Units:gitPath.length,limit:worktree?220:258,
  });
}

// worktree add probes <commonDir>/worktrees/<basename>/commondir before its
// long-path repository config is available. Resolve Git's numeric collision
// suffix as well; an existing registered worker uses its actual admin directory.
// These checks qualify path length only; identity and ownership remain separate.
export async function assertGitWorktreeDirectory(commonDir,directory,{gitDir}={}) {
  if(process.platform!=='win32')return;
  let admin=gitDir&&path.resolve(gitDir);
  if(!admin){
    const base=path.join(commonDir,'worktrees',path.basename(directory));admin=base;
    for(let suffix=1;await fs.lstat(admin).catch(error=>{if(error.code==='ENOENT')return null;throw error;});suffix++)admin=base+suffix;
  }
  const probe=path.join(admin,'commondir');
  if(probe.length>=260)throw Object.assign(new Error('当前随包 Git 的工作树管理路径过长；请选择较短的项目目录。'),{
    code:'UNSUPPORTED_GIT_WORKTREE_ADMIN_PATH',directory:path.resolve(directory),commonDir:path.resolve(commonDir),gitDir:admin,
    checkedPath:probe,utf16Units:probe.length,utf8Bytes:Buffer.byteLength(probe,'utf8'),limit:259,
  });
}

function broken(cause) {
  return Object.assign(new Error('Nozeli bundled Git provisioning is broken. Repair or reinstall the application with its production dependencies and bundled Git archive intact. ' + cause.message, { cause }), { code: 'GIT_PROVISIONING_FAILED' });
}

// Use dugite\'s platform-specific paths, including MinGit DLL/helper paths on
// Windows and the relocatable PREFIX/certificate/template paths on Linux.
// Never honor another application\'s LOCAL_GIT_DIRECTORY or GIT_EXEC_PATH.
// All other environment/config choices belong to the caller, not this resolver.
function environment(dugite, inherited) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (/^(LOCAL_GIT_DIRECTORY|GIT_EXEC_PATH)$/i.test(key)) delete env[key];
  }
  // Undefined arguments trigger dugite's process.env default parameters even
  // when processEnv is supplied. Explicit empty overrides select embedded Git
  // and embedded helpers without consulting or mutating the global env.
  return dugite.setupEnvironment({ LOCAL_GIT_DIRECTORY: '', GIT_EXEC_PATH: '' }, env);
}

async function provision() {
  try {
    const dugite = require('dugite');
    const { gitLocation: command, env } = environment(dugite, process.env);
    // Relocatable bundled layout: follow the resolved target, then apply the
    // shared per-platform bundled-executable presence/executability rule
    // (F_OK on Windows, executable bit elsewhere).
    await assertBundledExecutable(command, { follow: true, violation: file => Error('Bundled Git executable is not a file: ' + file) });
    const options = { env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true };
    const version = (await exec(command, ['--version'], options)).stdout.trim();
    if (!/^git version \d+\.\d+/.test(version)) throw Error('Bundled executable did not identify itself as Git: ' + command);
    const execPath = (await exec(command, ['--exec-path'], options)).stdout.trim();
    if (path.resolve(execPath) !== path.resolve(env.GIT_EXEC_PATH)) throw Error('Bundled Git helper path does not match the installation');
    if (!(await fs.stat(execPath)).isDirectory()) throw Error('Bundled Git helpers are missing: ' + execPath);
    if (env.GIT_TEMPLATE_DIR && !(await fs.stat(env.GIT_TEMPLATE_DIR)).isDirectory()) throw Error('Bundled Git templates are missing');
    return { dugite, command, version, source: 'bundled' };
  } catch (cause) {
    throw broken(cause);
  }
}

/** The private installation is independent of system Git, Bash, WSL and PATH. */
export async function ensureGit() {
  provisioning ??= provision().catch(error => { provisioning = undefined; throw error; });
  const { dugite, command, version, source } = await provisioning;
  return { command, env: environment(dugite, process.env).env, version, source };
}
// Fixed diagnostic vocabulary for persisted bug records. Classifies Git's own
// bounded stderr into one enum word; never persists or transmits raw text.
const GIT_STDERR_CLASSES=[
  ['already-exists',/already exists|already a working tree|already registered|is a symlink/i],
  ['lock',/\.lock|cannot lock|another git process|index\.lock/i],
  ['invalid-reference',/invalid reference|unknown revision|bad revision|ambiguous argument|not a valid object name|needed a single revision/i],
  ['path-unsupported',/too long|filename too long|invalid argument|no such file or directory|could not create leading directories/i],
  ['permission',/permission denied|access is denied|failed to set permissions/i],
  ['object-store',/unable to read|missing object|corrupt|checksum mismatch|inflate|bad object/i],
  ['clean',/^\s*$/],
];
function classifyGitStderr(text){
  for(const [name,pattern] of GIT_STDERR_CLASSES)if(pattern.test(text))return name;
  return 'other';
}

/** Streaming transport: pipelines enforce backpressure, and all failures reap Git. */
export async function runGitStream(cwd,args,{env=process.env,input,output,onStdout,signal,timeout=0,maxStderr=256*1024}={}){
 assertGitDirectory(cwd);
 await ensureGit();const {dugite,command}=await provisioning;
 // Managed instance/worktree paths routinely exceed MAX_PATH. Enable MinGit's
 // wide-path support for this invocation, without editing user/repository config.
 const commandArgs=process.platform==='win32'?['-c','core.longpaths=true',...args]:args;
 const child=spawn(command,commandArgs,{cwd,env:environment(dugite,env).env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
 let stderr=Buffer.alloc(0),timer;
 child.stderr.on('data',chunk=>{if(stderr.length<maxStderr)stderr=Buffer.concat([stderr,chunk.subarray(0,maxStderr-stderr.length)]);});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,exitSignal)=>{if(code===0)resolve();else reject(Object.assign(new Error('Git '+(args[0]||'')+' failed: '+stderr.toString()),{code,signal:exitSignal,stderr,
   // Bounded machine-readable facts so a persisted bug record can name the
   // exact subprocess outcome without raw stacks or message text: command
   // word, numeric exit status, and a first-2-KiB stderr class. The class is
   // a fixed enum derived from Git's own diagnostics; raw text is never kept.
   gitEvidence:Object.freeze({command:/^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/.test(String(args[0]??''))?String(args[0]):null,exitCode:Number.isInteger(code)?code:null,signal:exitSignal??null,stderrClass:classifyGitStderr(stderr.toString('utf8')),stderrText:stderr.subarray(0,2048).toString('utf8')})}));});});
 const abort=()=>child.kill('SIGKILL');
 if(signal)signal.addEventListener('abort',abort,{once:true});
 if(timeout)timer=setTimeout(abort,timeout);
 try{
  if(signal?.aborted)throw Object.assign(new Error('Git operation aborted'),{code:'ABORT_ERR'});
  const send=pipeline(input??Readable.from([]),child.stdin);
  const receive=output?pipeline(child.stdout,output):(async()=>{for await(const chunk of child.stdout)if(onStdout)await onStdout(chunk);})();
  await Promise.all([exited,send,receive]);
  if(signal?.aborted)throw Object.assign(new Error('Git operation aborted'),{code:'ABORT_ERR'});
 }catch(error){abort();child.stdin.destroy();child.stdout.destroy();await exited.catch(()=>{});if(['ENOENT','EACCES','ENOEXEC'].includes(error.code))throw broken(error);throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

/** Bounded collection is only for small plumbing/text replies, never blobs. */
export async function runGit(cwd,args,{encoding='buffer',maxBuffer=64*1024*1024,...options}={}){
 const chunks=[];let size=0;
 await runGitStream(cwd,args,{...options,onStdout:chunk=>{size+=chunk.length;if(size>maxBuffer)throw Object.assign(new Error('Git text output exceeds bounded collection'),{code:'GIT_OUTPUT_LIMIT'});chunks.push(chunk);}});
 const bytes=Buffer.concat(chunks,size);return encoding==='buffer'||encoding===null?bytes:bytes.toString(encoding);
}
