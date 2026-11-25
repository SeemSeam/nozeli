// Tool processes use kernel Job containment on Windows. No PID rediscovery or
// taskkill: descendants are assigned before the leader's first instruction.
import {spawn} from 'node:child_process';
import {prepareExperimentalProcessTransport} from '../platform/windows/experimental-process-transport.mjs';

export function spawnTool(command, args, options = {}) {
  if (process.platform !== 'win32') return spawn(command, args, options);
  const environment = new Map();
  // Win32 keys are case-insensitive: explicit PATH overrides inherited Path.
  for (const [key,value] of Object.entries(options.env || process.env)) {
    if (value !== undefined) environment.set(key.toLowerCase(), `${key}=${value}`);
  }
  const child = prepareExperimentalProcessTransport({command,args,cwd:options.cwd || process.cwd(),env:[...environment.values()]});
  child.exitCode = null;
  child.signalCode = null;
  child.spawnargs = [command, ...args];
  child.jobExit = new Promise(resolve => child.once('job-empty', resolve));
  let empty = false, closing = false;
  child.requestStop = () => { if (!empty) child.terminate(); };
  child.kill = () => { child.requestStop(); return true; };
  const close = () => {
    if (!empty || closing || !child.stdout.readableEnded || !child.stderr.readableEnded) return;
    closing = true;
    child.stdin.destroy();
    child.close();
    child.emit('close', child.exitCode, null);
  };
  child.once('exit', code => { child.exitCode = code; queueMicrotask(() => { try { child.requestStop(); } catch (error) { child.emit('error',error); } }); });
  child.once('job-empty', () => { empty = true; close(); });
  child.stdout.once('end', close); child.stderr.once('end', close);
  child.on('transport-error', ({error}) => child.emit('error', error));
  // Let callers install their error and exit listeners before execution.
  queueMicrotask(() => { try { child.resume(); } catch (error) { child.emit('error',error); } });
  return child;
}

export async function stopTool(child, {timeoutMs = 2000} = {}) {
  if (!child) return null;
  if (process.platform !== 'win32') { child.kill(); return null; }
  child.requestStop();
  let timer;
  try {
    const facts = await Promise.race([child.jobExit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Tool Job exit unconfirmed; resources retained.'), {code:'PROCESS_JOB_EXIT_UNCONFIRMED'})), timeoutMs);
    })]);
    return {...facts, treeExitVerified: facts.jobEmptyObserved === true};
  } finally { clearTimeout(timer); }
}
