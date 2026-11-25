// Explicit W2 experiment. Shared ownership/launch selectors remain disabled.
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const binding=()=>require('../../../native/windows-process/build/Release/nozeli_windows_process.node');

export function decodeWindowsAnsi(bytes) { return binding().decodeAnsi(bytes); }

export function createExperimentalProcessJob({command,args=[],cwd,env,stdio}={}) {
  if(process.platform!=='win32'||process.arch!=='x64')
    throw Object.assign(Error('Native Windows x64 required'),{code:'PROCESS_PLATFORM_UNSUPPORTED'});
  // No ambient environment fallback. Runtime resolver/owner admission comes
  // later; this primitive is not a ChildProcess-compatible product launcher.
  const native=binding();
  return stdio===undefined?native.createSuspendedProcessJob(command,args,cwd,env):native.createSuspendedProcessJob(command,args,cwd,env,stdio);
}

export async function waitExperimentalJobEmpty(lease,{timeoutMs=5000}={}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>30000)
    throw Object.assign(Error('Expected timeout in 0..30000 ms'),{code:'PROCESS_WAIT_INVALID'});
  const deadline=performance.now()+timeoutMs;
  for(;;) {
    const facts=lease.snapshot();
    if(facts.jobEmptyObserved)return facts;
    if(performance.now()>=deadline)
      throw Object.assign(Error('Job exit unconfirmed; retain lease and owner resources'),{code:'PROCESS_JOB_EXIT_UNCONFIRMED',facts});
    await delay(Math.min(20,Math.max(1,deadline-performance.now())));
  }
}
