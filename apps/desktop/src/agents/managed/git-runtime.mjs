import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import {Readable} from 'node:stream';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
let provisioning;

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
    const stat = await fs.stat(command);
    if (!stat.isFile()) throw Error('Bundled Git executable is not a file: ' + command);
    await fs.access(command, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
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

/** Streaming transport: pipelines enforce backpressure, and all failures reap Git. */
export async function runGitStream(cwd,args,{env=process.env,input,output,onStdout,signal,timeout=0,maxStderr=256*1024}={}){
 await ensureGit();const {dugite,command}=await provisioning;
 const child=spawn(command,args,{cwd,env:environment(dugite,env).env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
 let stderr=Buffer.alloc(0),timer;
 child.stderr.on('data',chunk=>{if(stderr.length<maxStderr)stderr=Buffer.concat([stderr,chunk.subarray(0,maxStderr-stderr.length)]);});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,exitSignal)=>{if(code===0)resolve();else reject(Object.assign(new Error('Git '+(args[0]||'')+' failed: '+stderr.toString()),{code,signal:exitSignal,stderr}));});});
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
