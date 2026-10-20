// Explicit opt-in, independent frozen source; three short real provider turns.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

const snapshot=process.argv[2], out=process.argv[3];
if(process.env.NOZELI_REAL_CODEX!=='1'||!process.env.NOZELI_CODEX_SOURCE_HOME||!snapshot||!out)
  throw Error('explicit real Codex opt-in, source home, frozen snapshot and evidence directory required');
const source=await fs.realpath(snapshot), evidence=path.resolve(out);
if(source.includes('/.ccb/')||evidence.includes('/.ccb/'))throw Error('CCB state is not a test dependency');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-resume-baseline-'));
const project=path.join(root,'project'), home=path.join(root,'provider-home');
await fs.mkdir(project);await fs.mkdir(evidence,{recursive:true});
const {CodexSession}=await import(pathToFileURL(path.join(source,'src/agents/managed/codex-session.mjs')));
const {projectProviderHome}=await import(pathToFileURL(path.join(source,'src/agents/managed/provider-home.mjs')));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={status:'FAIL',root,source,version:execFileSync('codex',['--version'],{encoding:'utf8'}).trim(),model:'gpt-6.1-sol',effort:'low',hashes:{},turns:[],checks:[]};
for(const rel of ['codex-session.mjs','turn-metrics.mjs','process-isolation.mjs','provider-home.mjs'])
  report.hashes[rel]=hash(await fs.readFile(path.join(source,'src/agents/managed',rel)));
report.scriptHash=hash(await fs.readFile(new URL(import.meta.url)));
const sessions=[];
const make=()=>{
  const session=new CodexSession({model:report.model,effort:report.effort,role:'frontdesk',cwd:project,home,
    baseInstructions:'You are a concise assistant in an isolated usage experiment.',
    instructions:'Remember exact user strings. Answer only what is requested. Do not use tools, network or write files.',isolation:{writable:[]}});
  sessions.push(session);return session;
};
const save=()=>fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n');
async function turn(session,name,text){
  const observed={name,threadId:session.threadId,pid:session.child.pid,before:session.tokenUsage??null,notifications:[]};
  const listener=m=>observed.notifications.push(m);session.on('notification',listener);
  try{const result=await session.prompt(text,{timeout:90000});observed.result=result;return result;}
  catch(e){observed.error={message:e.message,metrics:e.metrics,turnId:e.turnId};throw e;}
  finally{session.off('notification',listener);observed.after=session.tokenUsage??null;report.turns.push(observed);await save();}
}
try{
  await projectProviderHome(process.env.NOZELI_CODEX_SOURCE_HOME,home);
  const nonce='BASELINE_'+randomUUID();const first=make();await first.start();
  const r1=await turn(first,'fresh-completed',`Remember ${nonce} for later. Reply only ACK.`);
  assert.equal(r1.metrics.tokenStatus,'complete');assert.equal(r1.metrics.tokenCoverage.baselineSource,'fresh-thread');
  const threadId=first.threadId;report.observedBeforeStop=first.tokenUsage;await first.stop();
  const resumed=make();await resumed.start(threadId);
  const r2=await turn(resumed,'first-after-restart', 'Reply only with the exact BASELINE_ string from the previous turn.');
  assert(r2.text.includes(nonce));assert.equal(resumed.threadId,threadId);
  assert.equal(r2.metrics.tokenCoverage.baselineSource,'unavailable');assert.equal(r2.metrics.tokenStatus,'unavailable');
  assert.equal(r2.metrics.tokens,null);assert.equal(r2.metrics.tokenCoverage.zeroConfirmed,false);
  report.checks.push('same-thread restart retains semantic context but missing usage baseline stays unknown');
  const r3=await turn(resumed,'second-after-restart','Reply only ACK2.');
  assert.equal(r3.metrics.tokenCoverage.baselineSource,'observed');assert.equal(r3.metrics.tokenStatus,'complete');
  assert(r3.metrics.tokens.totalTokens>0);
  report.checks.push('a new observed cumulative baseline restores complete settlement on the next turn');
  report.status='PASS';
}catch(e){report.error=e.stack;process.exitCode=1;}
finally{
  for(const s of sessions)await s.stop().catch(e=>(report.cleanupErrors??=[]).push(e.message));
  await fs.rm(path.join(home,'auth.json'),{force:true});await fs.rm(path.join(home,'auth.json.tmp'),{force:true});
  report.finishedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({evidence,status:report.status,error:report.error,checks:report.checks}));
}
