import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DesktopHost } from '../src/main/host.mjs';
import { AgentRuntime } from '../src/agents/runtime.mjs';
import { startDocumentTools } from '../src/agents/document-tools.mjs';
import { digestText } from '../src/agents/handoff.mjs';
if(process.env.NOZELI_REAL_CODEX!=='1')throw Error('Use NOZELI_REAL_CODEX=1 to run two bounded real Codex tool prompts.');
const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(root,'.test-output','authorship-real-codex-')),projectRoot=path.join(out,'project'),profile=path.join(out,'profile');await fs.mkdir(projectRoot);
await fs.writeFile(path.join(projectRoot,'probe.md'),'# Managed authorship\n\nFirst value: 10.\nSecond value: 20.\n');
const host=new DesktopHost(profile),project=(await host.pick(projectRoot)).project,tools=await startDocumentTools(host),runtime=new AgentRuntime({userDataDir:profile,documentTools:tools});
const report={out,platform:process.platform,checks:[],replies:[],errors:[]};
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitRequest(id){const deadline=Date.now()+130000;while(Date.now()<deadline){const req=runtime.projects.get(project.id)?.log.requests.find(r=>r.id===id);if(req&&['completed','failed','cancelled'].includes(req.status))return req;await tick(200);}throw Error('real CLI request timeout');}
const instruction=(before,after,marker)=>`In this isolated test project, change only the number in "${before}" to "${after}" in probe.md. Use the Nozeli managed document read/apply commands supplied in your developer instructions, with NEW absolute snapshot and edit JSON files under this test directory: ${out}. Do not use apply_patch or shell to write probe.md directly. Do not delegate. Verify the managed apply receipt, then reply ${marker}. This is a test fixture, not a user document. Do not read unrelated files.`;
try{
  await runtime.detect();report.provider=runtime.providers.find(p=>p.id==='codex');assert(report.provider?.available);
  await runtime.saveSettings({foreground:{provider:'codex',permissionMode:'full'},background:{provider:'codex',permissionMode:'full'}},{projectId:project.id});
  const status=await runtime.connect({id:project.id,root:projectRoot});assert.equal(status.roles.qa.state,'ready');assert.equal(status.roles.task.state,'ready');
  const qa=await runtime.send({projectId:project.id,text:instruction('First value: 10.','First value: 11.','AUTHOR_AGENT1_OK')});const qaRequest=await waitRequest(qa.requestId);assert.equal(qaRequest.status,'completed');report.replies.push(runtime.messages(project.id).filter(m=>m.requestId===qa.requestId&&m.role==='qa').map(m=>m.text).join('\n'));
  const text=instruction('Second value: 20.','Second value: 22.','AUTHOR_AGENT2_OK'),taskId=randomUUID();await runtime.acceptHandoff({id:taskId,projectId:project.id,parentRequestId:qa.requestId,text,digest:digestText(text)});const task=await waitRequest(taskId);assert.equal(task.status,'completed');report.replies.push(runtime.reports(project.id).find(r=>r.requestId===taskId)?.text||'');
  const file=await host.readFile(project.id,'probe.md'),history=await host.documentHistory(project.id,'probe.md');
  assert.match(file.text,/First value: 11\./);assert.match(file.text,/Second value: 22\./);assert.deepEqual(new Set(history.events.map(e=>e.actor.kind)),new Set(['agent1','agent2']));assert(history.events.every(e=>e.actor.provider==='codex'&&e.actor.sessionId&&e.operationId));assert.notEqual(history.events[0].actor.sessionId,history.events[1].actor.sessionId);
  report.history=history.events;report.checks.push('two genuine Codex sessions invoke managed read/apply and independently author exact number changes');report.checks.push('source remains plain Markdown, history has real provider/session, actor and host time');report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;}
finally{await runtime.cancelAllAndStop().catch(error=>report.errors.push(error.message));await runtime.stopIdle().catch(error=>report.errors.push(error.message));await tools.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,checks:report.checks,error:report.error,errors:report.errors,provider:report.provider},null,2));process.exitCode=report.ok?0:1;}
