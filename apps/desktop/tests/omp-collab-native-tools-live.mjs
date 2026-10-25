// Actual shipped native Worker/SDK/bash/Collab path; loopback scripted HTTP only.
// Run: node --test tests/omp-collab-native-tools-live.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { OmpTuiSession } from '../src/agents/managed/omp-tui-session.mjs';
import { prepareOmpPrivateHome } from '../src/agents/managed/omp-provider-home.mjs';
import {openTestController} from './project-storage.fixture.mjs'

test('isolated native Worker survives real bash tool execution and durably settles Collab', { timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-collab-native-tools-'));
  t.diagnostic('Self-owned nonsecret evidence: ' + root);
  const home = path.join(root, 'home'), cwd = path.join(root, 'project');
  await mkdir(cwd);
  const requests = [], entries = [], events = [], facts = [], diagnostics = [];
  let session = null, serverError = null;
  let manualOpened = null, manualSettled = null;
  const command = "printf '%s\\n' 'native-bash-collab-ok' > native-bash-proof.txt; cat native-bash-proof.txt";
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const request = JSON.parse(body); requests.push(request);
        const manual = requests.length > 2;
        const callId = manual ? 'native-manual-bash-call' : 'native-bash-call';
        const toolResult = request.messages?.find(message => message.role === 'tool' && message.tool_call_id === callId);
        if (requests.length > 4) throw Error('Unexpected extra native provider request');
        const toolPhase = requests.length % 2 === 1;
        if (toolPhase) assert.ok(request.tools?.some(tool => tool.function?.name === 'bash'), 'real Worker exposes native bash');
        else assert.ok(toolResult, 'actual provider request contains native bash result');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const deltas = toolPhase
          ? [{ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: manual ? "printf '%s\\n' 'native-manual-bash-ok' > native-manual-proof.txt; cat native-manual-proof.txt" : command }) } }] }, {}]
          : [{ role: 'assistant', content: 'Native bash completed and Collab remained connected.' }, {}];
        for (const delta of deltas) res.write('data: ' + JSON.stringify({ id: 'native-tools-' + requests.length, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : toolPhase ? 'tool_calls' : 'stop' }] }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } catch (error) { serverError = error; res.writeHead(500); res.end('fixture failed'); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    let stopError;
    try { await session?.stop(); } catch (error) { stopError = { name: error.name, message: error.message, code: error.code ?? null }; }
    await writeFile(path.join(root, 'evidence.json'), JSON.stringify({ requests, entries, events, facts, diagnostics, transport: session?.collab?.diagnostics(), stopError, serverError: serverError?.message ?? null }, null, 2));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (stopError) assert.fail('Native stop failed; inspect self-owned evidence.json: ' + stopError.message);
  });
  await prepareOmpPrivateHome(home);
  await writeFile(path.join(home, 'models.yml'), `providers:\n  native-tools-local:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    auth: none\n    models:\n      - id: scripted\n        input: [text]\n`);
  await writeFile(path.join(home, 'config.yml'), 'setupVersion: 2\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nmodelRoles:\n  default: native-tools-local/scripted\ndefaultThinkingLevel: off\n');
  session = new OmpTuiSession({ role: 'worker', home, cwd, tools: [], isolation: { writable: [cwd], readOnly: [] }, instructions: 'Execute the supplied local bash tool call, then report its result.', settleTimeoutMs: 45000,
    onManualInput: async input => { manualOpened = input; return { jobId: 'native-manual-job' }; },
    onManualSettled: async result => { manualSettled = result; },
    onCollabEntry: fact => { entries.push(fact); }, onCollabEvent: fact => { events.push(fact); }, onTransportFact: fact => { facts.push(fact); } });
  session.on('diagnostic', value => { diagnostics.push(value); });
  await session.start();
  const deadline = Date.now() + 20000;
  let native = await session.bridge.getState();
  while (!native.model && Date.now() < deadline && !session.closed) { await new Promise(resolve => setTimeout(resolve, 100)); native = await session.bridge.getState(); }
  assert.equal(native.model, 'native-tools-local/scripted');
  const response = await session.prompt('Run the self-owned native bash Collab regression.', { timeout: 45000, job: { id: 'native-tools-local-job', target: 'native-tools-local-work', revision: 1, type: 'work' } });
  assert.equal(serverError, null);
  assert.equal(response.completion, 'provider-completed');
  assert.equal(requests.length, 2);
  assert.equal(await readFile(path.join(cwd, 'native-bash-proof.txt'), 'utf8'), 'native-bash-collab-ok\n');
  assert.ok(events.some(fact => fact.event?.type === 'tool_execution_start' && fact.event.toolName === 'bash'));
  assert.ok(events.some(fact => fact.event?.type === 'tool_execution_end' && fact.event.toolName === 'bash'));
  const nativeEntries = entries.flatMap(fact => fact.entries ?? [fact]);
  assert.ok(nativeEntries.some(fact => fact.entry?.message?.role === 'toolResult' && fact.entry.message.toolCallId === 'native-bash-call'));
  assert.ok(facts.some(fact => fact.status === 'settled'));
  assert.equal(facts.some(fact => fact.status === 'unknown'), false, JSON.stringify(session.collab.diagnostics()));
  assert.equal(session.collab.guest.failure, undefined);
  const manualText = 'Run the self-owned manual native bash regression.';
  session.terminalAttachment(null, 'native-tools-local-work').input(manualText + '\r');
  const manualDeadline = Date.now() + 45000;
  while (!manualSettled && Date.now() < manualDeadline && !session.closed) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(manualOpened, 'actual interactive input opens a host manual job');
  assert.ok(manualSettled, 'actual manual turn reaches durable settlement: ' + JSON.stringify(session.collab.diagnostics()));
  assert.equal(manualSettled.jobId, 'native-manual-job');
  assert.equal(manualSettled.error, null);
  assert.equal(requests.length, 4);
  assert.equal(await readFile(path.join(cwd, 'native-manual-proof.txt'), 'utf8'), 'native-manual-bash-ok\n');
  const allEntries = entries.flatMap(fact => fact.entries ?? [fact]);
  const binding = allEntries.find(fact => fact.entry?.customType === 'nozeli-manual-binding' && fact.entry.data?.requestId === manualOpened.promptId);
  assert.ok(binding, 'native emits an exact manual binding');
  assert.equal(binding.entry.data.jobId, 'native-manual-job');
  const inputIndex = allEntries.findIndex(fact => fact.entry?.id === binding.entry.data.inputEntryId);
  const bindingIndex = allEntries.indexOf(binding);
  assert.ok(inputIndex >= 0 && inputIndex < bindingIndex, 'binding references already appended actual user entry');
  assert.equal(allEntries[inputIndex].entry.message.role, 'user');
  const firstManualAssistant = allEntries.findIndex((fact, index) => index > inputIndex && fact.entry?.message?.role === 'assistant');
  assert.ok(firstManualAssistant > bindingIndex, 'native binding precedes manual assistant/tool entries');
  assert.ok(allEntries.some(fact => fact.entry?.message?.role === 'toolResult' && fact.entry.message.toolCallId === 'native-manual-bash-call' && fact.requestId === manualOpened.promptId));
  assert.equal(session.collab.guest.failure, undefined);
  await session.stop();
});

test('actual native provider 502 preserves failure and closes without losing owner evidence', { timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-collab-provider502-'));
  t.diagnostic('Self-owned nonsecret failure metadata: ' + root);
  const home = path.join(root, 'home'), cwd = path.join(root, 'project');
  await mkdir(cwd);
  let requests = 0, session, promptError, stopError;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests++;
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream access forbidden', type: 'upstream_error', code: 'access_forbidden' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try { await session?.stop(); } catch (error) { stopError = error; }
    const metadata = error => error ? { name: error.name, code: error.code ?? null, category: error.code === 'OMP_COLLAB_HOLD' ? 'collab-hold' : 'native-or-cleanup-failure' } : null;
    await writeFile(path.join(root, 'failure-metadata.json'), JSON.stringify({ requests, promptError: metadata(promptError), stopError: metadata(stopError), transport: session?.collab?.diagnostics(), closeReport: session?.collab?.closeReport, exitReceipt: session?.lastExitReceipt }, null, 2));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  await prepareOmpPrivateHome(home);
  await writeFile(path.join(home, 'models.yml'), `providers:\n  provider-failure-local:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    auth: none\n    models:\n      - id: scripted\n        input: [text]\n`);
  await writeFile(path.join(home, 'config.yml'), 'setupVersion: 2\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nmodelRoles:\n  default: provider-failure-local/scripted\ndefaultThinkingLevel: off\n');
  session = new OmpTuiSession({ role: 'frontdesk', home, cwd, tools: [], settleTimeoutMs: 20000 });
  await session.start();
  const deadline = Date.now() + 20000;
  while (!(await session.bridge.getState()).model && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  try { await session.prompt('Return the local failure fixture response.', { timeout: 20000, job: { id: 'provider502-job', target: 'frontdesk', type: 'front' } }); }
  catch (error) { promptError = error; }
  assert.ok(promptError, 'HTTP 502 must not become successful empty completion');
  assert.ok(requests > 0);
  try { await session.stop(); } catch (error) { stopError = error; }
  assert.equal(session.lastExitReceipt?.confirmationComplete, true, 'cleanup failure must not discard actual native exit evidence');
  assert.equal(session.collab.guest.failure, undefined, 'provider error must not corrupt native Collab entry identity: ' + JSON.stringify(session.collab.diagnostics()));
  assert.equal(stopError, undefined, 'provider failure alone must not poison close');
});

test('actual native mid-tool SIGKILL retains durable loss and permits explicit same-thread recovery', { timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-collab-native-kill-'));
  t.diagnostic('Self-owned crash evidence: ' + root);
  const home = path.join(root, 'home'), cwd = path.join(root, 'project');
  await mkdir(cwd);
  let requests = 0, session, resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const facts = [];
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'kill-bash-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf partial > crash-partial.txt; sleep 180' }) } }] };
      for (const [content, finish] of [[delta, null], [{}, 'tool_calls']]) res.write('data: ' + JSON.stringify({ id: 'kill-tool', object: 'chat.completion.chunk', choices: [{ index: 0, delta: content, finish_reason: finish }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try { await session?.stop({ recover: true }); } catch {}
    await writeFile(path.join(root, 'crash-metadata.json'), JSON.stringify({ requests, facts, evidence: session?.cleanupEvidence() }, null, 2));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  await prepareOmpPrivateHome(home);
  await writeFile(path.join(home, 'models.yml'), `providers:\n  native-kill-local:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    auth: none\n    models:\n      - id: scripted\n        input: [text]\n`);
  await writeFile(path.join(home, 'config.yml'), 'setupVersion: 2\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nmodelRoles:\n  default: native-kill-local/scripted\ndefaultThinkingLevel: off\n');
  session = new OmpTuiSession({ role: 'worker', home, cwd, tools: [], isolation: { writable: [cwd], readOnly: [] }, settleTimeoutMs: 45000,
    onTransportFact: fact => { facts.push({ status: fact.status, kind: fact.kind }); },
    onCollabEvent: fact => { if (fact.event?.type === 'tool_execution_start') resolveStarted(); } });
  await session.start();
  const pending = session.prompt('Execute the crash tool.', { timeout: 45000, job: { id: 'native-kill-job', target: 'native-kill-work', type: 'work' } });
  const rejected = assert.rejects(pending);
  await started;
  process.kill(session.pid, 'SIGKILL');
  await rejected;
  let closeError;
  try { await session.stop(); } catch (error) { closeError = error; }
  t.diagnostic(JSON.stringify({ closeError: closeError?.code, evidence: session.cleanupEvidence() }));
  assert.equal(session.lastExitReceipt?.confirmationComplete, true);
  await session.stop({ recover: true });
  assert.equal(requests, 1, 'cleanup/recovery must not replay model requests');
  assert.equal(session.collab.guest.failure, undefined);
});

test('actual Controller recovers same Worker after reviewed publication and revision-two native SIGKILL', { timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-controller-native-kill-'));
  t.diagnostic('Self-owned controller crash metadata: ' + root);
  const privateRoot = path.join(root, '.Nozeli'), source = path.join(privateRoot, 'omp'), content = path.join(root, 'project');
  await mkdir(source, { recursive: true }); await mkdir(content);
  await writeFile(path.join(content, 'base.txt'), 'baseline\n');
  let controller, work, requests = 0, firstRequests = 0, cleanupError;
  const waitFor = async (fn, label) => { const deadline = Date.now() + 90000; while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Timed out: ' + label); };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      JSON.parse(body); requests++;
      const revision = work ? controller.store.find(work.id).revision : 0;
      let delta, finish = 'tool_calls';
      if (revision >= 2) delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'controller-crash-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf partial > crash-partial.txt; sleep 180' }) } }] };
      else {
        firstRequests++;
        if (firstRequests === 1) delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'controller-first-bash', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf reviewed > reviewed.txt; cat reviewed.txt' }) } }] };
        else if (firstRequests === 2) delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'controller-publish', type: 'function', function: { name: 'nozeli_publish', arguments: JSON.stringify({ kind: 'result', text: 'Native reviewed result', files: ['reviewed.txt'] }) } }] };
        else { delta = { role: 'assistant', content: 'Reviewed result published.' }; finish = 'stop'; }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [part, end] of [[delta, null], [{}, finish]]) res.write('data: ' + JSON.stringify({ id: 'controller-native-' + requests, object: 'chat.completion.chunk', choices: [{ index: 0, delta: part, finish_reason: end }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try { await controller?.stop(); } catch (error) { cleanupError = error; }
    await writeFile(path.join(root, 'controller-crash-metadata.json'), JSON.stringify({ requests, cleanupError: cleanupError?.code ?? null, agents: controller?.snapshot().agents.map(agent => ({ target: agent.target, closed: agent.closed, cleanupEvidence: agent.cleanupEvidence })), jobs: controller?.store.state.jobs.map(job => ({ id: job.id, target: job.target, status: job.status, cleanupFailure: job.cleanupFailure, attempts: job.collabAttempts?.map(attempt => ({ status: attempt.status, attempt: attempt.attempt, kind: attempt.kind })) })) }, null, 2));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  await writeFile(path.join(source, 'models.yml'), `providers:\n  controller-kill-local:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    auth: none\n    models:\n      - id: scripted\n        input: [text]\n`);
  await writeFile(path.join(source, 'config.yml'), 'setupVersion: 2\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nmodelRoles:\n  default: controller-kill-local/scripted\ndefaultThinkingLevel: off\n');
  controller = await openTestController({ runtimeRoot: path.join(privateRoot, 'desktop', 'runtime'), contentRoot: content, ompSystemSource: { root: privateRoot, agentDir: source, private: true } });
  await controller.start();
  work = await controller.store.submit('Create a native reviewed result', 'Run native bash then publish reviewed.txt', { name: 'Native crash recovery' });
  controller.kick();
  await waitFor(() => controller.store.find(work.id).status === 'review' && !controller.running.has(work.id), 'first native revision reviewed');
  const old = controller.sessions.get(work.id), thread = old.threadId;
  assert.ok(controller.store.state.receipts.some(receipt => receipt.workId === work.id && receipt.kind === 'result'));
  const accepted = await controller.send(work.id, 'CRASH_REVISION_TWO write partial then wait; keep original Work');
  await waitFor(async () => { try { return (await readFile(path.join(controller.execution.directory(work.id), 'crash-partial.txt'), 'utf8')) === 'partial'; } catch { return false; } }, 'revision two actual bash partial file');
  process.kill(old.pid, 'SIGKILL');
  await waitFor(() => !controller.running.has(work.id) && controller.store.state.jobs.find(job => job.id === accepted.jobId)?.status === 'failed', 'native failure durable');
  const count = requests;
  t.diagnostic(JSON.stringify(old.cleanupEvidence()));
  await writeFile(path.join(root, 'before-restart-metadata.json'), JSON.stringify({ evidence: old.cleanupEvidence(), jobs: controller.store.state.jobs.filter(job => job.target === work.id).map(job => ({ id: job.id, status: job.status, cleanupFailure: job.cleanupFailure, attempts: job.collabAttempts?.map(attempt => ({ status: attempt.status, attempt: attempt.attempt, kind: attempt.kind })) })) }, null, 2));
  await controller.restart(work.id);
  assert.equal(controller.sessions.get(work.id).threadId, thread);
  assert.equal(requests, count, 'explicit restart must not replay accepted input');
  assert.equal(controller.store.state.jobs.find(job => job.id === accepted.jobId).status, 'failed');
  assert.equal(await readFile(path.join(controller.execution.directory(work.id), 'crash-partial.txt'), 'utf8'), 'partial');
});

test('native fragmented document-sized tool arguments survive streaming backlog and settle exactly once', { timeout: 120000 }, async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'omp-collab-stream-burst-')),home=path.join(root,'home'),cwd=path.join(root,'project');await mkdir(cwd);t.diagnostic('Self-owned loopback streaming evidence: '+root);
  const expected='来源规则 αβ 中文 👩‍🔬\\n"quoted"\n'.repeat(800),argumentsJson=JSON.stringify({text:expected}),entries=[],events=[],facts=[];let requests=0,calls=0,session,serverError;
  const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{try{const request=JSON.parse(body);requests++;assert(requests<=2,'No provider replay');res.writeHead(200,{'content-type':'text/event-stream'});const chunks=[],send=(delta,finish_reason=null)=>chunks.push('data: '+JSON.stringify({id:'burst-'+requests,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    if(requests===1){assert(request.tools.some(tool=>tool.function?.name==='nozeli_burst_capture'));send({role:'assistant',tool_calls:[{index:0,id:'burst-call',type:'function',function:{name:'nozeli_burst_capture',arguments:''}}]});for(let offset=0;offset<argumentsJson.length;offset+=3)send({tool_calls:[{index:0,function:{arguments:argumentsJson.slice(offset,offset+3)}}]});send({},'tool_calls');}
    else{assert(request.messages.some(message=>message.role==='tool'&&message.tool_call_id==='burst-call'));send({role:'assistant',content:'The complete document-sized argument was written.'});send({},'stop');}res.end(chunks.join('')+'data: [DONE]\n\n');
  }catch(error){serverError=error;res.destroy(error);}});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{let receipt;try{receipt=await session?.stop();}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(root,'evidence.json'),JSON.stringify({requests,calls,expectedChars:expected.length,argumentChars:argumentsJson.length,entries,events,facts,transport:session?.collab?.diagnostics(),serverError:serverError?.message,receipt},null,2));}assert.equal(receipt?.confirmationComplete,true);});
  await prepareOmpPrivateHome(home);await writeFile(path.join(home,'models.yml'),`providers:\n  stream-burst-local:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    auth: none\n    models:\n      - id: scripted\n        input: [text]\n`);await writeFile(path.join(home,'config.yml'),'setupVersion: 2\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nmodelRoles:\n  default: stream-burst-local/scripted\ndefaultThinkingLevel: off\n');
  session=new OmpTuiSession({role:'frontdesk',home,cwd,tools:[{name:'nozeli_burst_capture',description:'Write the complete supplied test document.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}],onTool:async payload=>{assert.equal(payload.tool,'nozeli_burst_capture');assert.deepEqual(payload.arguments,{text:expected});await payload.admission.preEffect();calls++;await writeFile(path.join(cwd,'tool-burst-proof.txt'),payload.arguments.text);return {written:true};},onCollabEntry:fact=>entries.push(fact),onCollabEvent:fact=>events.push(fact),onTransportFact:fact=>facts.push(fact),settleTimeoutMs:60000});
  await session.start();const deadline=Date.now()+20000;while((await session.bridge.getState()).model!=='stream-burst-local/scripted'){assert(Date.now()<deadline,'Native model initialization');await new Promise(resolve=>setTimeout(resolve,100));}
  const result=await session.prompt('Write the supplied complete self-owned document through the registered tool.',{timeout:60000,job:{id:'burst-job',target:'frontdesk',type:'frontdesk'}});assert.equal(serverError,undefined);assert.equal(result.completion,'provider-completed');assert.equal(calls,1);assert.equal(requests,2);assert.equal(await readFile(path.join(cwd,'tool-burst-proof.txt'),'utf8'),expected);
  const raw=entries.flatMap(fact=>fact.entries??[fact]),call=raw.find(fact=>fact.entry?.message?.content?.some?.(block=>block.type==='toolCall'&&block.id==='burst-call'));assert(call,'Actual native journal retains the complete tool call');assert.deepEqual(call.entry.message.content.find(block=>block.id==='burst-call').arguments,{text:expected});assert(call.streamId&&events.some(fact=>fact.streamId===call.streamId),'Durable call and live snapshots retain native stream identity');assert(raw.some(fact=>fact.entry?.message?.role==='toolResult'&&fact.entry.message.toolCallId==='burst-call'));assert.equal(facts.filter(fact=>fact.status==='settled').length,1);assert(!facts.some(fact=>fact.status==='unknown'),JSON.stringify(session.collab.diagnostics()));
});
