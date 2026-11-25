import assert from 'node:assert/strict';
import test from 'node:test';
import {capacityAdmission, createCapacitySnapshot, validateCapacityConfig} from '../src/agents/managed/paracloud-capacity.mjs';

const config = {sshAlias: 'capacity-test', partition: 'gpu-research'};
const request = {cpus: 8, memoryMiB: 16_384, gpus: 1, gpuType: 'A100'};

function row({partition = config.partition, name = 'private-node-a', availability = 'up', count = 1,
  state = 'idle', cpus = 8, maxCpus = 'UNLIMITED', memory = 16_384, gres = 'gpu:a100:1',
  reservation = '', rootOnly = 'no'} = {}) {
  return `${partition}|${availability}|${name} |${count}|${state}|${cpus}|${maxCpus}|${memory}|${gres}|${reservation}|${rootOnly}\n`;
}

function frame(args,stdout){
  const token=/NOZELI_BEGIN_([a-f0-9]{32})/.exec(args.at(-1))[1];
  return `Gateway banner\r\nNOZELI_BEGIN_${token}\r\n${stdout.replace(/\n/g,'\r\n')}\r\nNOZELI_END_${token}\r\nConnection closed\r\n`;
}
function transcript(stdout, stderr = '', error = null) {
  return createCapacitySnapshot((_program, args, _options, callback) => callback(error, frame(args,stdout), stderr));
}

const advisory = (resourceFit, reason = 'eligibility-unverified') => ({status: 'unknown', reason, resourceFit});

test('uses only the validated alias and a fixed, bounded read-only SSH query', async () => {
  const calls = [];
  const query = createCapacitySnapshot((program, args, options, callback) => {
    calls.push({program, args, options});
    callback(null, frame(args,''), '');
  });
  const {signal} = new AbortController();
  await query({...config, request: 'untrusted request', command: 'submitted command'}, {signal});
  await query({...config, partition: 'another-partition'});
  const [{program, args, options}] = calls;
  assert.equal(program, 'ssh');
  assert.equal(options.shell, false);
  assert.strictEqual(options.signal, signal);
  assert.ok(options.timeout <= 10_000);
  assert.ok(options.maxBuffer <= 256 * 1024);
  for (const flag of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no',
    'ProxyCommand=none', 'ProxyJump=none', 'ControlPath=none', 'ClearAllForwardings=yes',
    'KnownHostsCommand=none', 'PermitLocalCommand=no', 'RemoteCommand=none']) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(-3, -1), ['--', config.sshAlias]);
  assert(args.includes('-tt')&&!args.includes('-T'));
  assert.match(args.at(-1), /LC_ALL=C sinfo --local --hide /);
  const normalize=arg=>arg.replace(/NOZELI_(BEGIN|END)_[a-f0-9]{32}/g,'NOZELI_$1');
  assert.deepEqual(args.map(normalize),calls[1].args.map(normalize));
  assert.doesNotMatch(args.at(-1), /gpu-research|untrusted request|submitted command|sacctmgr|sbatch|srun/);

  for (const invalid of [{}, {...config, sshAlias: '-dev'}, {...config, sshAlias: 'user@host'},
    {...config, sshAlias: 'host\n'}, {...config, partition: 'gpu*'}, {...config, partition: 'gpu;pwd'},
    {...config, partition: 42}]) {
    assert.equal(validateCapacityConfig(invalid), false);
    assert.equal((await query(invalid)).code, 'invalid-config');
  }
  assert.equal(validateCapacityConfig(config), true);
  assert.equal(calls.length, 2);
});

test('returns only nonidentifying scoped resource tuples for idle nodes', async () => {
  const snapshot = await transcript([
    row({partition: 'other-partition', name: 'other-private-node', cpus: 128, memory: 100_000}),
    row({cpus: 48, maxCpus: 16, memory: 32_768, gres: 'nic:1,gpu:A100:2(S:0,2-3),gpu:h100:1(S:1)'}),
    row({name: 'private-node-b', cpus: 8, memory: 65_536, gres: '(null)'}),
    row({name: 'private-node-c', state: 'mixed'}),
    row({name: 'private-node-d', state: 'idle~'}),
    row({name: 'private-node-e', availability: 'down'}),
    row({name: 'private-node-f', reservation: 'private-reservation'}),
    row({name: 'private-node-g', rootOnly: 'yes'}),
  ].join(''))(config);
  assert.ok(Number.isFinite(Date.parse(snapshot.observedAt)));
  assert.deepEqual({...snapshot, observedAt: null}, {status: 'ok', partition: 'gpu-research', observedAt: null,
    visibility: 'visible', eligibility: 'unverified', nodes: [
      {cpus: 16, memoryMiB: 32_768, gpus: 2, gpuTypes: [{type: 'a100', count: 2}, {type: 'h100', count: 1}]},
      {cpus: 8, memoryMiB: 65_536, gpus: 0, gpuTypes: []},
    ]});
  assert.doesNotMatch(JSON.stringify(snapshot), /private|other-partition|capacity-test/);
  assert.deepEqual(capacityAdmission(snapshot, request), advisory('fit'));
  assert.deepEqual(capacityAdmission(snapshot, {...request, memoryMiB: 65_536}), advisory('no-fit'));
  assert.deepEqual(capacityAdmission(snapshot, {...request, gpus: 3, gpuType: undefined}), advisory('no-fit'));
  assert.deepEqual(capacityAdmission(snapshot, {...request, gpuType: 'a100-sxm'}), advisory('no-fit'));
});

test('does not pool resources across nodes, or treat untyped GPUs as a typed GPU', async () => {
  const snapshot = await transcript(row({cpus: 16, memory: 8192, gres: 'gpu:a100:1'}) +
    row({name: 'private-node-b', cpus: 4, memory: 65_536, gres: 'gpu:a100:1'}) +
    row({name: 'private-node-c', gres: 'gpu:2(S:0-3)'}))(config);
  assert.deepEqual(capacityAdmission(snapshot, request), advisory('no-fit'));
  assert.deepEqual(capacityAdmission(snapshot, {...request, gpuType: undefined, gpus: 2}), advisory('fit'));
  assert.deepEqual(capacityAdmission(snapshot, {...request, gpus: 2}), advisory('no-fit'));
  assert.deepEqual(capacityAdmission(snapshot, {...request, nodes: 2}), advisory('unknown', 'unsupported-node-count'));
  assert.deepEqual(capacityAdmission(snapshot, {...request, cpus: '8'}), advisory('unknown', 'invalid-request'));
  assert.deepEqual(capacityAdmission({...snapshot, observedAt: new Date(0).toISOString()}, request),
    advisory('unknown', 'stale-snapshot'));
});

test('keeps observed empty, missing scope, and SSH/query failure distinct', async () => {
  const empty = await transcript(row({state: 'allocated'}))(config);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.visibility, 'visible');
  assert.deepEqual(capacityAdmission(empty, request), advisory('no-fit'));
  const noNodes = await transcript(row({name: '', count: 0, state: 'n/a'}))(config);
  assert.equal(noNodes.status, 'empty');
  assert.equal(noNodes.visibility, 'visible');
  for (const stdout of ['', row({partition: 'other'})]) {
    const missing = await transcript(stdout)(config);
    assert.equal(missing.status, 'empty');
    assert.equal(missing.visibility, 'not-visible');
    assert.deepEqual(capacityAdmission(missing, request), advisory('unknown', 'partition-not-visible'));
  }
  const failed = await transcript(row(), 'private scheduler detail')(config);
  assert.deepEqual(failed, {status: 'error', partition: 'gpu-research', observedAt: null,
    visibility: 'unknown', eligibility: 'unverified', nodes: [], code: 'query-failed'});
  assert.deepEqual(capacityAdmission(failed, request), advisory('unknown', 'snapshot-unavailable'));
});

test('successful framed PTY queries preserve the SSH key-exchange warning without accepting unknown diagnostics',async()=>{
  const warning=['** WARNING: connection is not using a post-quantum key exchange algorithm.',
    '** This session may be vulnerable to "store now, decrypt later" attacks.',
    '** The server may need to be upgraded. See https://openssh.com/pq.html','Connection to fixture closed.'].join('\r\n');
  const result=await transcript(row(),warning)(config);
  assert.equal(result.status,'ok');
  assert.deepEqual(result.warnings,['ssh-no-post-quantum-kex']);
  assert.equal((await transcript(row(),warning+'\r\nUnexpected warning')(config)).code,'query-failed');
});

test('fails closed on bad transcripts, oversized output, timeout, and cancellation', async () => {
  const incomplete=createCapacitySnapshot((_program,args,_options,callback)=>callback(null,frame(args,row()).replace(/NOZELI_END_[a-f0-9]{32}/,'wrong marker'),''));
  assert.equal((await incomplete(config)).code,'invalid-output');
  for (const stdout of ['login banner\n' + row(), row({memory: '12+'}), row() + row(),
    row({name: 'group[1-2]', count: 2}), row({gres: 'gpu:a100:10G'})]) {
    const failed = await transcript(stdout)(config);
    assert.equal(failed.code, 'invalid-output');
    assert.deepEqual(failed.nodes, []);
  }
  for (const stdout of ['x'.repeat(256 * 1024 + 1),
    Array.from({length: 1025}, (_, i) => row({name: `n${i}`})).join('')]) {
    const failed = await transcript(stdout)(config);
    assert.equal(failed.code, 'output-limit');
    assert.deepEqual(failed.nodes, []);
  }
  for (const [error, code] of [[{code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}, 'output-limit'],
    [{code: 'ENOENT'}, 'ssh-unavailable'], [{code: 255}, 'query-failed'],
    [{killed: true, signal: 'SIGKILL'}, 'timeout'], [{code: 'ABORT_ERR'}, 'aborted']]) {
    assert.equal((await transcript(row(), '', error)(config)).code, code);
  }
  const controller = new AbortController();
  let complete;
  const query = createCapacitySnapshot((_program, _args, _options, callback) => { complete = callback; });
  const pending = query(config, {signal: controller.signal});
  controller.abort();
  complete(null, row(), '');
  assert.equal((await pending).code, 'aborted');
  const mustNotRun = createCapacitySnapshot(() => assert.fail('already-aborted query started'));
  assert.equal((await mustNotRun(config, {signal: controller.signal})).code, 'aborted');
});
