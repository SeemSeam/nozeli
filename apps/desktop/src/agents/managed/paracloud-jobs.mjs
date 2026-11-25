import {createHash} from 'node:crypto';
import {paracloudCommand, validateCapacityConfig} from './paracloud-capacity.mjs';

const UPLOAD_LIMIT = 24 * 1024;
const READ_LIMIT = 64 * 1024;
const QUEUE_LIMIT = 512;
const TOKEN = '[A-Za-z0-9][A-Za-z0-9_.-]{0,63}';
const FILE = '[A-Za-z0-9][A-Za-z0-9_.-]{0,127}';
const HASH = '[0-9a-f]{64}';
const BASE64 = '(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?';
const string = (pattern, maxLength) => ({type:'string', pattern:`^(?:${pattern})$(?![\\s\\S])`, maxLength});
const integer = (minimum, maximum) => ({type:'integer', minimum, maximum});
const path = string(FILE,128);
const sha256 = string(HASH,64);
const requestId = string(TOKEN,64);
const read = [{path,maxBytes:integer(1,READ_LIMIT)},['path']];
const job = [{requestId},['requestId']];
const fields = {
  queue: [{},[]],
  upload: [{path:string(`(?!job-)${FILE}`,128),contentBase64:string(BASE64,UPLOAD_LIMIT/3*4),sha256},['path','contentBase64','sha256']],
  download: read,
  log: read,
  submit: [{requestId,scriptPath:path,scriptSha256:sha256,queue:{const:true},cpus:integer(1,256),memoryMiB:integer(1,1_048_576),gpus:integer(0,32),timeMinutes:integer(1,10_080)},['requestId','scriptPath','scriptSha256','queue']],
  status: job,
  cancel: job,
};

export const paracloudJobInputSchema = {oneOf:Object.entries(fields).map(([action,[properties,required]])=>({
  type:'object',properties:{action:{const:action},...properties},required:['action',...required],additionalProperties:false,
}))};

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function parseBase64(content, limit) {
  if (typeof content !== 'string' || content.length > Math.ceil(limit/3)*4) return null;
  const bytes = Buffer.from(content,'base64');
  return bytes.length <= limit && bytes.toString('base64') === content ? bytes : null;
}

export function validateParacloudJobArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.action !== 'string' || !Object.hasOwn(fields,args.action)) return false;
  const [properties,required] = fields[args.action];
  if (!Object.hasOwn(args,'action') || required.some(key=>!Object.hasOwn(args,key))) return false;
  for (const [key,value] of Object.entries(args)) {
    if (key === 'action') continue;
    if (!Object.hasOwn(properties,key)) return false;
    const rule = properties[key];
    if ('const' in rule ? value !== rule.const
      : rule.type === 'integer' ? !Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum
      : typeof value !== 'string' || value.length > rule.maxLength || !new RegExp(rule.pattern).test(value)) return false;
  }
  return args.action !== 'upload' || parseBase64(args.contentBase64,UPLOAD_LIMIT) !== null;
}

// One fixed program inside the framed command, including the replay barrier.
// The project namespace and protected relative open calls assume a trusted SSH
// account and filesystem. POSIX cannot isolate state from code with the same UID.
const REMOTE = String.raw`
import base64, datetime, hashlib, json, os, re, selectors, stat, subprocess, sys, tempfile, time, uuid

p = json.loads(sys.argv[1])
a = p['action']
partition = p['partition']
uid = str(os.getuid())
uidarg = '--user=' + uid
nof = os.O_NOFOLLOW
unknown = 'submit-unknown'
job_pattern = r'[1-9][0-9]{0,9}'

class Problem(Exception):
    pass

def fail(code):
    raise Problem(code)

def json_bytes(obj):
    return json.dumps(obj, separators=(',', ':'), sort_keys=True).encode('ascii')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def valid_id(value):
    return isinstance(value, str) and re.fullmatch(job_pattern, value) and int(value) < 4294967294

def private_dir(parent, name, create=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        os.fsync(parent)
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | nof, dir_fd=parent)
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        fail('unsafe-directory')
    return fd

def open_file(parent, name, internal=False):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | nof, dir_fd=parent)
    except FileNotFoundError:
        raise
    except OSError:
        fail('unsafe-file')
    with os.fdopen(fd, 'rb') as f:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or (not internal and info.st_nlink != 1):
            fail('unsafe-file')
        limit = p.get('maxBytes', ${READ_LIMIT}) if a != 'submit' else ${UPLOAD_LIMIT}
        if internal:
            limit = 4096
        size = min(info.st_size, limit)
        if info.st_size > size:
            if a != 'log' or internal:
                fail('byte-limit')
            f.seek(info.st_size - size)
        data = f.read(size + (0 if a == 'log' and not internal else 1))
        if len(data) != size:
            fail('file-changed')
        return data, info.st_size > size

def publish(parent, name, data):
    # Link a complete fsynced inode; never replace a winner and never expose a
    # partially written claim. The caller may act only after directory fsync.
    temp = '.tmp-' + uuid.uuid4().hex
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nof, 0o600, dir_fd=parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.link(temp, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        except FileExistsError:
            return False
        os.fsync(parent)
        return True
    finally:
        os.unlink(temp, dir_fd=parent)
        os.fsync(parent)

def metadata(parent, name):
    try:
        data, _ = open_file(parent, name, internal=True)
        value = json.loads(data)
        if not isinstance(value, dict):
            fail('state-invalid')
        return value
    except FileNotFoundError:
        return None
    except (UnicodeError, ValueError):
        fail('state-invalid')

def receipt(jobs, key, claim):
    value = metadata(jobs, key + '.receipt')
    if value is None:
        return None
    fingerprint = (claim or {}).get('fingerprint')
    if (not isinstance(fingerprint, str) or not re.fullmatch(r'[0-9a-f]{64}', fingerprint) or
            value.get('fingerprint') != fingerprint or value.get('partition') != claim.get('partition') or
            not valid_id(value.get('jobId'))):
        fail('state-invalid')
    return value

def scheduler(args, script=None, limit=131072):
    # Respect the site's trusted SLURM_CONF, but not user CLI overrides,
    # federation defaults or environment options that redirect the job.
    env = {k:v for k,v in os.environ.items()
           if not k.startswith(('SBATCH_', 'SLURM_', 'SQUEUE_', 'SACCT_', 'SCANCEL_')) or k == 'SLURM_CONF'}
    env['LC_ALL'] = 'C'
    deadline = time.monotonic() + 8
    with tempfile.TemporaryFile() as source:
        if script is not None:
            source.write(script)
            source.seek(0)
        with subprocess.Popen(args, stdin=source, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env) as proc:
            try:
                with selectors.DefaultSelector() as reader:
                    reader.register(proc.stdout, selectors.EVENT_READ)
                    output = bytearray()
                    while reader.select(max(0, deadline - time.monotonic())):
                        if time.monotonic() >= deadline:
                            fail('scheduler-unavailable')
                        chunk = os.read(proc.stdout.fileno(), min(8192, limit + 1 - len(output)))
                        if not chunk:
                            break
                        output.extend(chunk)
                        if len(output) > limit:
                            fail('scheduler-output-limit')
                    else:
                        fail('scheduler-unavailable')
                if proc.wait(timeout=max(0, deadline - time.monotonic())) != 0:
                    fail('scheduler-unavailable')
                return output.decode('ascii')
            finally:
                if proc.poll() is None:
                    proc.kill()

def rows(output):
    for line in output.splitlines():
        parts = [value.strip() for value in line.split('|')]
        if len(parts) != 5:
            continue
        jid, name, owner, part, state = parts
        if (not valid_id(jid) or not re.fullmatch(r'nz-[0-9a-f]{64}', name)
                or owner != uid or part != partition):
            continue
        if re.fullmatch(r'CANCELLED by [0-9]+', state):
            state = 'CANCELLED'
        if not re.fullmatch(r'[A-Z][A-Z_]{0,31}', state):
            fail('scheduler-invalid-output')
        yield jid, name, state

def current(name=None):
    args = ['squeue', '--local', '--noheader', uidarg, '--partition=' + partition, '--format=%i|%j|%U|%P|%T']
    if name is not None:
        # Name instead of --jobs: older squeue errors for a completed job ID.
        args.append('--name=' + name)
    return rows(scheduler(args))

def accounting(selector):
    return rows(scheduler(['sacct', '--local', '--allocations', '--noheader', '--parsable2', '--duplicates',
        '--uid=' + uid, selector, '--format=JobIDRaw%32,JobName%96,UID%16,Partition%80,State%64']))

def recover(jobs, key, claim):
    # No scheduler ID yet: inspect exact owned-name matches only. A cancelled,
    # purged or unreachable job is not evidence that submit never occurred.
    name = 'nz-' + key
    try:
        source = 'queue'
        matches = [(jid,state) for jid,n,state in current(name) if n == name]
        if not matches:
            claimed_at = claim['claimedAt']
            if type(claimed_at) is not int or not 0 <= claimed_at <= time.time() + 300:
                fail(unknown)
            since = datetime.datetime.fromtimestamp(max(0, claimed_at - 300)).strftime('%Y-%m-%dT%H:%M:%S')
            source = 'accounting'
            matches = [(jid,state) for jid,n,state in accounting('--starttime=' + since) if n == name]
        if len(matches) != 1:
            fail(unknown)
        jid, state = matches[0]
        value = {'fingerprint':claim['fingerprint'], 'partition':partition, 'jobId':jid}
        if not publish(jobs, key + '.receipt', json_bytes(value)) and receipt(jobs,key,claim) != value:
            fail(unknown)
        os.fsync(jobs)
        return {'jobId':jid, 'state':state, 'source':source}
    except (Problem, KeyError, OSError, UnicodeError, subprocess.SubprocessError):
        fail(unknown)

def submit(jobs, files):
    key = p['key']
    params = {k:p[k] for k in ('partition','scriptPath','scriptSha256','cpus','memoryMiB','gpus','timeMinutes')}
    identity = {'fingerprint':digest(json_bytes(params)), 'partition':partition}
    claim_name = key + '.claim'
    log = 'job-' + key + '.log'
    def reuse(existing):
        if not existing or any(existing.get(k) != v for k,v in identity.items()):
            fail('request-conflict')
        value = receipt(jobs, key, identity)
        if value is None:
            fail(unknown)
        # Concurrent replay must not report a receipt before the publisher's
        # fsync, and can finish syncing it if the publisher was disconnected.
        os.fsync(jobs)
        return {'jobId':value['jobId'], 'replayed':True}
    old = metadata(jobs, claim_name)
    if old is not None:
        return reuse(old)
    if metadata(jobs, key + '.receipt') is not None:
        # A competitor may have published both since our first read. An
        # orphaned receipt otherwise indicates damage, never a fresh request.
        old = metadata(jobs, claim_name)
        if old is None:
            fail('state-invalid')
        return reuse(old)
    script, _ = open_file(files, p['scriptPath'])
    if digest(script) != p['scriptSha256']:
        fail('integrity-mismatch')
    if not script or b'\x00' in script or b'\r' in script:
        fail('invalid-script')
    if not publish(jobs, claim_name, json_bytes(dict(identity, claimedAt=int(time.time())))):
        return reuse(metadata(jobs, claim_name))
    try:
        args = ['sbatch', '--parsable', '--job-name=nz-' + key, '--partition=' + partition,
                '--nodes=1', '--ntasks=1', '--cpus-per-task=' + str(p['cpus']), '--mem=' + str(p['memoryMiB']) + 'M',
                '--time=' + str(p['timeMinutes']), '--no-requeue', '--export=NIL',
                '--chdir=' + os.readlink('/proc/self/fd/' + str(files)), '--open-mode=append', '--output=' + log, '--error=' + log]
        if p['gpus']:
            args.append('--gres=gpu:' + str(p['gpus']))
        # The first non-comment command ends directive parsing. The remaining
        # bytes are the exact digest-checked script, interpreted by Bash.
        output = scheduler(args, b'#!/bin/bash\n:\n' + script, limit=128)
        jid = output[:-1] if output.endswith('\n') else output
        if not valid_id(jid):
            fail(unknown)
        value = dict(identity, jobId=jid)
        if not publish(jobs, key + '.receipt', json_bytes(value)) and receipt(jobs,key,identity) != value:
            fail(unknown)
        os.fsync(jobs)
        return {'jobId':jid, 'replayed':False}
    except (Problem, OSError, UnicodeError, subprocess.SubprocessError):
        # An error is not evidence of non-submission. Retain the claim forever.
        fail(unknown)

def run():
    home = os.open(os.path.expanduser('~'), os.O_RDONLY | os.O_DIRECTORY | nof)
    create = a in ('upload', 'submit')
    try:
        base = private_dir(home, '.nozeli-paracloud-v1', create)
        project = private_dir(base, p['project'], create)
        if a in ('upload', 'download', 'log', 'submit'):
            files = private_dir(project, 'files', create)
        if a in ('submit', 'queue', 'status', 'cancel'):
            jobs = private_dir(project, 'jobs', a == 'submit')
    except FileNotFoundError:
        if a == 'queue':
            return {'jobs':[]}
        fail('job-not-authorized' if a in ('status','cancel') else 'file-not-found')
    if a == 'upload':
        data = base64.b64decode(p['contentBase64'], validate=True)
        if len(data) > ${UPLOAD_LIMIT} or digest(data) != p['sha256']:
            fail('integrity-mismatch')
        if not publish(files, p['path'], data):
            fail('file-exists')
        return {'bytes':len(data), 'sha256':digest(data)}
    if a in ('download', 'log'):
        data, truncated = open_file(files, p['path'])
        return {'contentBase64':base64.b64encode(data).decode('ascii'), 'sha256':digest(data), 'truncated':truncated}
    if a == 'submit':
        return submit(jobs, files)
    if a == 'queue':
        result = {}
        for jid, name, state in current():
            key = name[3:]
            value = receipt(jobs, key, metadata(jobs, key + '.claim'))
            if value and value['partition'] == partition and value['jobId'] == jid:
                if jid in result:
                    fail('scheduler-invalid-output')
                result[jid] = {'jobId':jid, 'state':state}
                if len(result) > ${QUEUE_LIMIT}:
                    fail('scheduler-output-limit')
        return {'jobs':list(result.values())}
    key = p['key']
    claim = metadata(jobs, key + '.claim')
    value = receipt(jobs, key, claim)
    if not claim or claim.get('partition') != partition:
        fail('job-not-authorized')
    if value is None:
        if a == 'status' and isinstance(claim.get('fingerprint'), str) and re.fullmatch(r'[0-9a-f]{64}', claim['fingerprint']):
            return recover(jobs, key, claim)
        fail('job-not-authorized')
    jid = value['jobId']
    name = 'nz-' + key
    def matching(entries):
        states = [state for j,n,state in entries if (j,n) == (jid,name)]
        if len(states) > 1:
            fail('scheduler-invalid-output')
        return states[0] if states else None
    state = matching(current(name))
    if a == 'cancel':
        if state is None:
            fail('job-not-active')
        # All selectors must reach the controller in the same RPC: the numeric
        # ID alone can be recycled between the observation and cancellation.
        scheduler(['scancel', '--ctld', uidarg, '--partition=' + partition, '--job-name=' + name, jid], limit=128)
        return {'jobId':jid}
    if state is not None:
        return {'jobId':jid, 'state':state, 'source':'queue'}
    state = matching(accounting('--jobs=' + jid))
    return {'jobId':jid, 'state':state or 'UNKNOWN', 'source':'accounting' if state is not None else 'none'}

try:
    value = {'ok':run()}
except Problem as e:
    value = {'error':str(e)}
except FileNotFoundError:
    value = {'error':'file-not-found' if a in ('submit','download','log') else 'scheduler-unavailable'}
except (UnicodeError, subprocess.SubprocessError):
    value = {'error':'scheduler-unavailable'}
except OSError:
    value = {'error':'remote-io'}
print(json_bytes(value).decode('ascii'), flush=True)
`;

const quote = value => `'${value.replaceAll("'","'\\''")}'`;
const remoteCodes = new Set([
  'unsafe-directory','unsafe-file','byte-limit','file-changed','state-invalid','scheduler-unavailable',
  'scheduler-output-limit','scheduler-invalid-output','request-conflict','submit-unknown','integrity-mismatch',
  'invalid-script','file-not-found','job-not-authorized','file-exists','job-not-active','remote-io',
]);
const validJobId = v => typeof v === 'string' && /^[1-9][0-9]{0,9}$/.test(v) && Number(v) < 4294967294 && String(Number(v)) === v;
const validState = v => typeof v === 'string' && /^[A-Z][A-Z_]{0,31}$(?![\s\S])/.test(v);

export async function runParacloudJob(config, args, {projectId,transport=paracloudCommand,beforeEffect}={}) {
  const action = typeof args?.action === 'string' && Object.hasOwn(fields,args.action) ? args.action : null;
  const error = code => ({status:'error',action,code});
  if (!validateParacloudJobArgs(args)) return error('invalid-input');
  if (!validateCapacityConfig(config) || typeof projectId !== 'string' || !projectId.trim() || projectId.length > 512) return error('invalid-config');
  const connection = {sshAlias:config.sshAlias,partition:config.partition};
  const project = digest(JSON.stringify(['paracloud-jobs-v1',projectId]));
  const key = args.requestId && digest(JSON.stringify([project,args.requestId]));
  const req = {cpus:1,memoryMiB:1024,gpus:0,timeMinutes:60,maxBytes:READ_LIMIT,...args,partition:connection.partition,project,key};
  const ok = value => ({status:'ok',action,...value});
  const unknown = () => ({status:'unknown',action,requestId:req.requestId,code:'submit-unknown'});
  const unverified = code => action === 'submit' ? unknown() : error(code);
  const logPath = `job-${key}.log`;
  const intended = action === 'upload' ? parseBase64(req.contentBase64,UPLOAD_LIMIT) : null;
  if (intended && digest(intended) !== req.sha256) return error('integrity-mismatch');
  if (['upload','submit','cancel'].includes(action)) {
    try {
      if (typeof beforeEffect !== 'function' || await beforeEffect() !== true) return error('effect-not-authorized');
    } catch {
      return error('effect-not-authorized');
    }
  }
  let reply, result;
  try {
    reply = await transport(connection,`python3 -I -c ${quote(REMOTE)} ${quote(JSON.stringify(req))}`,{timeout:25_000});
    if (reply?.status !== 'ok') return unverified('transport-failed');
    if (typeof reply.text !== 'string' || Buffer.byteLength(reply.text) > 128 * 1024) return unverified('invalid-output');
    result = JSON.parse(reply.text);
  } catch {
    return unverified('transport-or-output-invalid');
  }
  if (remoteCodes.has(result?.error) && result.ok === undefined) {
    if (action === 'status' && result.error === 'submit-unknown' ||
        action === 'submit' && ['submit-unknown','remote-io','state-invalid','scheduler-unavailable','unsafe-directory','unsafe-file'].includes(result.error)) return unknown();
    return error(result.error);
  }
  const value = result?.ok;
  if (!value || typeof value !== 'object' || 'error' in result) return unverified('invalid-output');
  if (action === 'upload') {
    if (value.bytes === intended.length && value.sha256 === req.sha256) return ok({path:req.path,bytes:value.bytes,sha256:value.sha256});
    return error('integrity-mismatch');
  }
  if (action === 'download' || action === 'log') {
    const bytes = parseBase64(value.contentBase64,req.maxBytes);
    if (!bytes || digest(bytes) !== value.sha256) return error('integrity-mismatch');
    const info = {path:req.path,bytes:bytes.length,sha256:value.sha256};
    if (action === 'download' && value.truncated === false) return ok({...info,contentBase64:value.contentBase64});
    if (action === 'log' && typeof value.truncated === 'boolean') return ok({...info,text:bytes.toString('utf8'),truncated:value.truncated});
    return error('invalid-output');
  }
  if (action === 'queue') {
    const jobs = value.jobs;
    if (Array.isArray(jobs) && jobs.length <= QUEUE_LIMIT && jobs.every(j=>validJobId(j?.jobId) && validState(j?.state)) && new Set(jobs.map(j=>j.jobId)).size === jobs.length) {
      return ok({partition:connection.partition,jobs:jobs.map(({jobId,state})=>({jobId,state}))});
    }
    return error('invalid-output');
  }
  if (!validJobId(value.jobId)) return unverified('invalid-output');
  const identity = {requestId:req.requestId,jobId:value.jobId};
  if (action === 'submit' && typeof value.replayed === 'boolean') return ok({...identity,logPath,replayed:value.replayed});
  if (action === 'cancel') return ok({...identity,cancellationRequested:true});
  if (action === 'status' && validState(value.state) && (['queue','accounting'].includes(value.source) || value.source === 'none' && value.state === 'UNKNOWN')) {
    return ok({...identity,logPath,state:value.state,source:value.source});
  }
  return unverified('invalid-output');
}
