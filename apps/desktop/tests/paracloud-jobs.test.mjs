import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';
import {paracloudJobInputSchema, runParacloudJob, validateParacloudJobArgs} from '../src/agents/managed/paracloud-jobs.mjs';

const exec = promisify(execFile);
const cfg = {sshAlias:'test-cluster',partition:'managed'};
const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
const remoteFixture = {skip:process.platform !== 'linux' && 'remote fixture requires Linux /proc and Python 3'};
const upload = (path,bytes)=>({action:'upload',path,contentBase64:bytes.toString('base64'),sha256:sha(bytes)});
const script = Buffer.from('#!/bin/bash\n#SBATCH --partition=unmanaged\n#SBATCH --array=1-99\necho "work"\n');
const submit = {action:'submit',requestId:'attempt-1',scriptPath:'work.sh',scriptSha256:sha(script),queue:true};
const ok = (action,value)=>({status:'ok',action,...value});
const error = (action,code)=>({status:'error',action,code});
const unknown = requestId=>({status:'unknown',action:'submit',requestId,code:'submit-unknown'});

// The production remote helper runs as-is, against disposable Slurm CLI
// fixtures. The SSH boundary is replaced by a non-network local shell.
const SLURM = `#!/usr/bin/env python3
import json, os, pathlib, sys, time
command = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ['HOME'])
event = {'command':command, 'args':args}
if command == 'sbatch':
    event['script'] = sys.stdin.read()
    event['overridesRemoved'] = not any(k in os.environ for k in ('SBATCH_PARTITION','SLURM_CLUSTERS','SCANCEL_NAME'))
fd = os.open(root / 'events.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(fd, (json.dumps(event) + '\\n').encode())
os.close(fd)
if command == 'sbatch':
    time.sleep(0.15)
    print(os.environ.get('TEST_SBATCH_OUTPUT', '712'))
    sys.exit(int(os.environ.get('TEST_SBATCH_EXIT', '0')))
if command in ('squeue','sacct'):
    file = root / (command + '.txt')
    if file.exists():
        sys.stdout.write(file.read_text())
`;

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(),'nozeli-paracloud-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const bin = join(home,'bin');
  await mkdir(bin);
  const cli = join(bin,'slurm');
  await writeFile(cli,SLURM,{mode:0o700});
  await Promise.all(['sbatch','squeue','sacct','scancel'].map(name=>symlink(cli,join(bin,name))));
  const transport = async (config,command,env={})=>{
    assert.equal(config.sshAlias,cfg.sshAlias);
    const {stdout} = await exec('/bin/sh',['-c',command],{env:{...process.env,HOME:home,PATH:`${bin}:/usr/bin:/bin`,
      SBATCH_PARTITION:'wrong',SLURM_CLUSTERS:'other',SCANCEL_NAME:'other',...env},maxBuffer:256*1024});
    return {status:'ok',text:stdout};
  };
  const run = (args,options={},config=cfg)=>runParacloudJob(config,args,{projectId:'stable-project',beforeEffect:()=>true,
    transport:(c,cmd)=>transport(c,cmd),...options});
  const events = async ()=>{
    try { return (await readFile(join(home,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  return {home,run,transport,events};
}

test('strict action contract, explicit queue authorization and effect gate',async()=>{
  assert.equal(paracloudJobInputSchema.oneOf.length,7);
  for (const args of [
    {...submit,queue:false},{...submit,queue:undefined},{...submit,partition:'another'},
    {action:'cancel',jobId:'712'},{action:'status',requestId:'../a'},
    {action:'download',path:'../outside'},{action:'log',path:'/outside'},
    {action:'log',path:'log\n'},{action:'log',path:'log',maxBytes:65_537},
    {...upload('file',Buffer.alloc(24*1024+1))},{...upload('file',Buffer.alloc(1)),contentBase64:'AB=='},
    {...upload('job-reserved.log',Buffer.alloc(0))},
  ]) assert.equal(validateParacloudJobArgs(args),false);
  assert.equal(validateParacloudJobArgs(submit),true);
  const options = {projectId:'project',transport:()=>assert.fail('must not dispatch')};
  assert.deepEqual(await runParacloudJob(cfg,submit,options),error('submit','effect-not-authorized'));
  assert.deepEqual(await runParacloudJob(cfg,submit,{...options,beforeEffect:()=>false}),error('submit','effect-not-authorized'));
  assert.deepEqual(await runParacloudJob(cfg,submit,{...options,beforeEffect:()=>{throw Error();}}),error('submit','effect-not-authorized'));
  assert.deepEqual(await runParacloudJob(cfg,submit,{...options,projectId:undefined}),error('submit','invalid-config'));
  const badUpload = {...upload('x',Buffer.from('bytes')),sha256:'0'.repeat(64)};
  assert.deepEqual(await runParacloudJob(cfg,badUpload,options),error('upload','integrity-mismatch'));
});

test('managed transfers are create-only, byte-bounded, integrity-checked and link-safe',remoteFixture,async t=>{
  const {home,run} = await fixture(t);
  const bin = Buffer.from([0,255,10,13,1,8]);
  assert.deepEqual(await run(upload('data.bin',bin)),ok('upload',{path:'data.bin',bytes:6,sha256:sha(bin)}));
  assert.deepEqual(await run(upload('data.bin',Buffer.from('replacement'))),error('upload','file-exists'));
  assert.deepEqual(await run({action:'download',path:'data.bin',maxBytes:5}),error('download','byte-limit'));
  assert.deepEqual(await run({action:'download',path:'data.bin'}),ok('download',{path:'data.bin',bytes:6,sha256:sha(bin),contentBase64:bin.toString('base64')}));
  assert.deepEqual(await run({action:'download',path:'data.bin'},{projectId:'another-project'}),error('download','file-not-found'));
  assert.equal((await run(upload('out.txt',Buffer.from('start\ntail')))).status,'ok');
  assert.deepEqual(await run({action:'log',path:'out.txt',maxBytes:4}),ok('log',{path:'out.txt',bytes:4,sha256:sha('tail'),text:'tail',truncated:true}));
  const broken = {status:'ok',text:JSON.stringify({ok:{contentBase64:'AA==',sha256:sha('wrong'),truncated:false}})};
  assert.deepEqual(await run({action:'download',path:'out.txt'},{transport:()=>broken}),error('download','integrity-mismatch'));
  const spoofAck = {status:'ok',text:JSON.stringify({ok:{bytes:4,sha256:sha('wrong')}})};
  assert.deepEqual(await run(upload('out.txt',Buffer.from('test')),{transport:()=>spoofAck}),error('upload','integrity-mismatch'));
  const base = join(home,'.nozeli-paracloud-v1');
  const [project] = await readdir(base);
  const files = join(base,project,'files');
  const outside = join(home,'secret');
  await writeFile(outside,'outside');
  await symlink(outside,join(files,'sym'));
  await link(outside,join(files,'hard'));
  for (const path of ['sym','hard']) {
    assert.deepEqual(await run({action:'download',path}),error('download','unsafe-file'));
    assert.deepEqual(await run({action:'log',path}),error('log','unsafe-file'));
    assert.deepEqual(await run(upload(path,Buffer.from('overwrite'))),error('upload','file-exists'));
  }
  assert.equal(await readFile(outside,'utf8'),'outside');
});

test('parallel submit uses one durable remote claim; scoped receipt controls queue, status and cancel',remoteFixture,async t=>{
  const {home,run,events} = await fixture(t);
  assert.deepEqual(await run({action:'queue'}),ok('queue',{partition:'managed',jobs:[]}));
  assert.equal((await run(upload('work.sh',script))).status,'ok');
  assert.deepEqual(await run({...submit,scriptSha256:'0'.repeat(64)}),error('submit','integrity-mismatch'));
  const results = await Promise.all([run(submit),run(submit)]);
  const created = results.find(r=>r.status==='ok' && !r.replayed);
  assert.equal(created?.jobId,'712');
  for (const result of results) {
    if (result.status==='ok') assert.equal(result.jobId,'712');
    else assert.deepEqual(result,unknown(submit.requestId));
  }
  const {logPath} = created;
  assert.match(logPath,/^job-[0-9a-f]{64}\.log$/);
  assert.deepEqual(await run({...submit,cpus:1}),ok('submit',{requestId:submit.requestId,jobId:'712',logPath,replayed:true}));
  for (const args of [{...submit,cpus:2},{...submit,scriptPath:'another.sh'},{...submit,scriptSha256:'a'.repeat(64)}]) {
    assert.deepEqual(await run(args),error('submit','request-conflict'));
  }
  assert.deepEqual(await run(submit,{}, {...cfg,partition:'another'}),error('submit','request-conflict'));
  const submissions = (await events()).filter(e=>e.command==='sbatch');
  assert.equal(submissions.length,1);
  const event = submissions[0];
  const name = event.args.find(a=>a.startsWith('--job-name=')).split('=')[1];
  assert.ok(event.args.includes('--partition=managed'));
  assert.ok(event.args.includes('--output='+logPath));
  assert.ok(event.args.includes('--export=NIL'));
  assert.equal(event.overridesRemoved,true);
  assert.equal(event.script,'#!/bin/bash\n:\n'+script.toString());
  const jobsDir = dirname(event.args.find(a=>a.startsWith('--chdir=')).slice('--chdir='.length));
  assert.deepEqual((await readdir(join(jobsDir,'jobs'))).sort(),[`${name.slice(3)}.claim`,`${name.slice(3)}.receipt`]);

  const uid = process.getuid();
  const active = `712|${name}|${uid}|managed|RUNNING\n`;
  const foreign = `712|${name}|${uid+1}|managed|RUNNING\n712|${name}|${uid}|nearby|RUNNING\n712|external|${uid}|managed|RUNNING\n`;
  await writeFile(join(home,'squeue.txt'),foreign+active);
  assert.deepEqual(await run({action:'queue'}),ok('queue',{partition:'managed',jobs:[{jobId:'712',state:'RUNNING'}]}));
  const requestId = submit.requestId;
  assert.deepEqual(await run({action:'status',requestId}),ok('status',{requestId,jobId:'712',logPath,source:'queue',state:'RUNNING'}));
  assert.deepEqual(await run({action:'cancel',requestId},{projectId:'another-project'}),error('cancel','job-not-authorized'));
  assert.deepEqual(await run({action:'status',requestId:'wrong'}),error('status','job-not-authorized'));
  assert.deepEqual(await run({action:'cancel',requestId}),ok('cancel',{requestId,jobId:'712',cancellationRequested:true}));
  await writeFile(join(home,'squeue.txt'),foreign);
  assert.deepEqual(await run({action:'cancel',requestId}),error('cancel','job-not-active'));
  assert.deepEqual(await run({action:'status',requestId}),ok('status',{requestId,jobId:'712',logPath,source:'none',state:'UNKNOWN'}));
  await writeFile(join(home,'sacct.txt'),`712|${name}|${uid}|managed|CANCELLED by ${uid}\n`);
  assert.deepEqual(await run({action:'status',requestId}),ok('status',{requestId,jobId:'712',logPath,source:'accounting',state:'CANCELLED'}));
  const cancellations = (await events()).filter(e=>e.command==='scancel');
  assert.deepEqual(cancellations,[{command:'scancel',args:['--ctld',`--user=${uid}`,'--partition=managed','--job-name='+name,'712']}]);
});

test('a lost reply replays the receipt, while malformed scheduler success remains unknown and never resubmits',remoteFixture,async t=>{
  const {home,run,transport,events} = await fixture(t);
  assert.equal((await run(upload('work.sh',script))).status,'ok');
  const lost = await run(submit,{transport:async(c,cmd)=>{
    await transport(c,cmd);
    return {status:'error',code:'timeout'};
  }});
  assert.deepEqual(lost,unknown(submit.requestId));
  const replay = await run(submit);
  assert.equal(replay.replayed,true);
  assert.equal(replay.jobId,'712');
  const poisoned = [
    {TEST_SBATCH_OUTPUT:'712;another-cluster'},
    {TEST_SBATCH_OUTPUT:'0'},
    {TEST_SBATCH_OUTPUT:'712\n713'},
    {TEST_SBATCH_OUTPUT:'712',TEST_SBATCH_EXIT:'1'},
  ];
  for (const [i,env] of poisoned.entries()) {
    const args = {...submit,requestId:`uncertain-${i}`};
    assert.deepEqual(await run(args,{transport:(c,cmd)=>transport(c,cmd,env)}),unknown(args.requestId));
    assert.deepEqual(await run(args),unknown(args.requestId));
    assert.deepEqual(await run({...args,memoryMiB:512}),error('submit','request-conflict'));
    assert.deepEqual(await run({action:'cancel',requestId:args.requestId}),error('cancel','job-not-authorized'));
  }
  const uid = process.getuid();
  const waiting = requestId=>({status:'unknown',action:'status',requestId,code:'submit-unknown'});
  const names = (await events()).filter(e=>e.command==='sbatch').slice(1).map(e=>e.args.find(a=>a.startsWith('--job-name=')).split('=')[1]);
  const requestId = 'uncertain-0';
  assert.deepEqual(await run({action:'status',requestId}),waiting(requestId));
  const owned = `801|${names[0]}|${uid}|managed|RUNNING\n`;
  await writeFile(join(home,'squeue.txt'),owned+`802|${names[0]}|${uid}|managed|PENDING\n`);
  assert.deepEqual(await run({action:'status',requestId}),waiting(requestId));
  await writeFile(join(home,'squeue.txt'),owned+`802|${names[0]}|${uid+1}|managed|PENDING\n`);
  assert.deepEqual(await run({action:'status',requestId}),ok('status',{requestId,jobId:'801',logPath:`job-${names[0].slice(3)}.log`,source:'queue',state:'RUNNING'}));
  const recovered = await run({...submit,requestId});
  assert.equal(recovered.jobId,'801');
  assert.equal(recovered.replayed,true);
  await writeFile(join(home,'sacct.txt'),`901|${names[1]}|${uid}|managed|COMPLETED\n`);
  assert.deepEqual(await run({action:'status',requestId:'uncertain-1'}),ok('status',{requestId:'uncertain-1',jobId:'901',logPath:`job-${names[1].slice(3)}.log`,source:'accounting',state:'COMPLETED'}));
  const base = join(home,'.nozeli-paracloud-v1');
  const [project] = await readdir(base);
  const key = replay.logPath.slice(4,-4);
  await rm(join(base,project,'jobs',`${key}.claim`));
  assert.deepEqual(await run(submit),unknown(submit.requestId));
  const submissions = (await events()).filter(e=>e.command==='sbatch');
  assert.equal(submissions.length,1+poisoned.length);
});
