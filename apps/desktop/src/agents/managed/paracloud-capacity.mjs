import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';

const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_ROWS = 4096;
const MAX_NODES = 1024;
const MAX_LINE = 2048;
const TIMEOUT_MS = 8000;
const MAX_AGE_MS = 30_000;

// ParaCloud requires a PTY even for a fixed command; stdin stays closed.
// Do not run local SSH hooks, use a proxy or
// existing control socket, forward credentials, or trust/update host keys.
// The owner provides the alias, SSH identity and pretrusted known_hosts entry.
const SSH_OPTIONS = [
 '-a', '-n', '-tt', '-x',
  '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'UpdateHostKeys=no', '-o', 'VerifyHostKeyDNS=no', '-o', 'CheckHostIP=no',
  '-o', 'KnownHostsCommand=none', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
  '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ClearAllForwardings=yes',
  '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none', '-o', 'CanonicalizeHostname=no',
  '-o', 'ForkAfterAuthentication=no', '-o', 'SessionType=default',
  '-o', 'GSSAPIDelegateCredentials=no', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1',
];

// Query the authenticated user's visible local partitions without using
// --all, querying associations, or interpolating owner/request values. Filter
// to the one configured partition locally and never return identifying rows.
const SINFO = "LC_ALL=C sinfo --local --hide --Node --exact --noconvert --noheader --format='%R|%a|%N|%D|%T|%c|%B|%m|%G|%i|%r'";

function framedQuery(token,command){
  return `unset SINFO_ALL SINFO_FEDERATION SINFO_PARTITION SINFO_FUTURE SCONTROL_FUTURE SLURM_CLUSTERS; printf '\\nNOZELI_BEGIN_${token}\\n'; ${command}; rc=$?; printf '\\nNOZELI_END_${token}\\n'; exit "$rc"`;
}

function queryPayload(stdout,token){
  const lines=stdout.replace(/\r\n/g,'\n').split('\n');
  const begin=lines.indexOf(`NOZELI_BEGIN_${token}`),end=lines.indexOf(`NOZELI_END_${token}`);
  if(begin<0||end<=begin||lines.lastIndexOf(lines[begin])!==begin||lines.lastIndexOf(lines[end])!==end)throw new Error('invalid-output');
  return lines.slice(begin+1,end).join('\n');
}

function transportWarnings(stderr){
  const lines=stderr.trim().split(/\r?\n/).filter(line=>line&&!/^Connection to [^\s]+ closed\.$/.test(line));
  if(!lines.length)return [];
  const pqWarning=[
    '** WARNING: connection is not using a post-quantum key exchange algorithm.',
    '** This session may be vulnerable to "store now, decrypt later" attacks.',
    '** The server may need to be upgraded. See https://openssh.com/pq.html'
  ];
  return lines.length===pqWarning.length&&lines.every((line,index)=>line===pqWarning[index])?['ssh-no-post-quantum-kex']:null;
}

export function validateCapacityConfig(config) {
  return ownerName(config?.sshAlias) && ownerName(config?.partition);
}

function ownerName(value) {
  return typeof value === 'string' && OWNER_NAME.test(value) && !value.endsWith('\n');
}

function natural(value) {
  if (!/^\d{1,15}$/.test(value)) throw new Error('invalid-output');
  return Number(value);
}

function gpuResources(gres) {
  const gpuTypes = [];
  let gpus = 0;
  if (gres && gres !== '(null)' && gres !== 'N/A') {
    const seen = new Set();
    for (const entry of gres.split(/,(?![^()]*\))/)) {
      // Slurm appends socket affinity e.g. (S:0-1,3). It isn't a GPU count.
      if (!entry.startsWith('gpu:') && entry !== 'gpu') continue;
      const value = /^gpu:(?:([A-Za-z0-9][A-Za-z0-9_.-]{0,63}):)?(\d{1,15})(?:\(S:[0-9,-]+\))?$/.exec(entry);
      if (!value) throw new Error('invalid-output');
      const type = value[1]?.toLowerCase() ?? null;
      if (seen.has(type)) throw new Error('invalid-output');
      seen.add(type);
      const count = natural(value[2]);
      if (type) gpuTypes.push({type, count});
      // Don't assume that different types or typed and untyped entries
      // can be combined for one request or describe disjoint devices.
      gpus = Math.max(gpus, count);
    }
  }
  return {gpus, gpuTypes};
}

function parseSnapshot(stdout, partition) {
  const nodes = [];
  const seen = new Set();
  let visibility = 'not-visible';
  const rows = stdout.trimEnd().split('\n');
  if (rows.length > MAX_ROWS) throw new Error('output-limit');
  for (const row of rows) {
    if (!row.trim()) continue;
    if (row.length > MAX_LINE) throw new Error('output-limit');
    const cols = row.split('|').map(field => field.trim());
    if (cols.length !== 11 || !ownerName(cols[0])) throw new Error('invalid-output');
    const [name, availability, node, count, state, cpu, maxCpu, memory, gres, reservation, rootOnly] = cols;
    if (name !== partition) continue;
    visibility = 'visible';
    if (!['up', 'down', 'drain', 'inactive'].includes(availability) || !['yes', 'no'].includes(rootOnly)) {
      throw new Error('invalid-output');
    }
    const nodeCount = natural(count);
    if (nodeCount === 0 && state === 'n/a') continue;
    if (nodeCount !== 1 || !/^[A-Za-z0-9_.-]{1,255}$/.test(node) || seen.has(node)) {
      throw new Error('invalid-output');
    }
    seen.add(node);
    // On mixed nodes RealMemory and GRES are configured totals, not what a
    // job can use now. Don't interpret flagged idle states as plain idle.
    if (availability !== 'up' || rootOnly !== 'no' || state !== 'idle' || reservation) continue;
    const cpus = Math.min(natural(cpu), maxCpu === 'UNLIMITED' ? Infinity : natural(maxCpu));
    const memoryMiB = natural(memory);
    if (!cpus || !memoryMiB) continue;
    if (nodes.length === MAX_NODES) throw new Error('output-limit');
    nodes.push({cpus, memoryMiB, ...gpuResources(gres)});
  }
  return {status: nodes.length ? 'ok' : 'empty', visibility, nodes};
}

function transportCode(error) {
  if (error?.code === 'ABORT_ERR') return 'aborted';
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output-limit';
  if (error?.killed && error?.signal === 'SIGKILL') return 'timeout';
  if (error?.code === 'ENOENT') return 'ssh-unavailable';
  return 'query-failed';
}

function createParacloudCommand(run){
  return async (config,command,{signal,timeout=TIMEOUT_MS}={})=>{
    const errorResult=code=>({status:'error',code});
    if(!validateCapacityConfig(config))return errorResult('invalid-config');
    if(signal?.aborted)return errorResult('aborted');
    const token=randomBytes(16).toString('hex');let output;
    try{
      output=await new Promise((resolve,reject)=>run('ssh',[...SSH_OPTIONS,'--',config.sshAlias,framedQuery(token,command)],{
        shell:false,windowsHide:true,encoding:'utf8',timeout,maxBuffer:MAX_OUTPUT_BYTES,killSignal:'SIGKILL',signal,
      },(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
    }catch(error){return errorResult(signal?.aborted?'aborted':transportCode(error));}
    if(signal?.aborted)return errorResult('aborted');
    if(typeof output.stdout!=='string'||typeof output.stderr!=='string')return errorResult('invalid-output');
    if(Buffer.byteLength(output.stdout)>MAX_OUTPUT_BYTES)return errorResult('output-limit');
    const warnings=transportWarnings(output.stderr);
    if(warnings===null)return errorResult('query-failed');
    try{return {status:'ok',text:queryPayload(output.stdout,token),warnings};}
    catch{return errorResult('invalid-output');}
  };
}

export const paracloudCommand=createParacloudCommand(execFile);

/** Transport injection for deterministic scheduler transcript tests. */
export function createCapacitySnapshot(run = execFile) {
  const query=createParacloudCommand(run);
  return async function capacitySnapshot(config,{signal}={}){
    const partition=ownerName(config?.partition)?config.partition:null;
    const errorResult=code=>({status:'error',partition,observedAt:null,visibility:'unknown',eligibility:'unverified',nodes:[],code});
    const result=await query(config,SINFO,{signal});
    if(result.status==='error')return errorResult(result.code);
    try{return {partition,observedAt:new Date().toISOString(),eligibility:'unverified',...(result.warnings.length?{warnings:result.warnings}:{}),...parseSnapshot(result.text,partition)};}
    catch(error){return errorResult(error.message==='output-limit'?'output-limit':'invalid-output');}
  };
}

export const capacitySnapshot = createCapacitySnapshot();

/** Resource fit is a point-in-time observation, not scheduler admission. */
export function capacityAdmission(snapshot, request) {
  const {cpus, memoryMiB, gpus = 0, gpuType, nodes = 1} = request ?? {};
  const unknown = (reason, resourceFit = 'unknown') => ({status: 'unknown', reason, resourceFit});
  if (!Number.isSafeInteger(cpus) || cpus < 1 || !Number.isSafeInteger(memoryMiB) || memoryMiB < 1 ||
      !Number.isSafeInteger(gpus) || gpus < 0 || (gpuType !== undefined && (!ownerName(gpuType) || !gpus))) {
    return unknown('invalid-request');
  }
  if (nodes !== 1) return unknown('unsupported-node-count');
  if (!['ok', 'empty'].includes(snapshot?.status) || !Array.isArray(snapshot.nodes)) {
    return unknown('snapshot-unavailable');
  }
  if (snapshot.visibility !== 'visible') return unknown('partition-not-visible');
  const age = Date.now() - Date.parse(snapshot.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return unknown('stale-snapshot');
  const type = gpuType?.toLowerCase();
  const fits = snapshot.nodes.some(node => node.cpus >= cpus && node.memoryMiB >= memoryMiB &&
    (type ? node.gpuTypes?.some(gpu => gpu.type === type && gpu.count >= gpus) : node.gpus >= gpus));
  // sinfo does not verify a user/account association or the complete
  // partition/account/QOS and site policies. A fit can never grant eligibility.
  return unknown('eligibility-unverified', fits ? 'fit' : 'no-fit');
}
