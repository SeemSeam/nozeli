// Real pinned Pi SDK + vendored driver + credential-free loopback. The
// assertions inspect the provider's HTTP JSON, not SDK active-name getters.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {OwnerRuntime} from '../../../integrations/pi/src/bridge.mjs';
import {serve,prepare} from './pi-provider.fixture.mjs';

const tool = (name, key) => ({name, description:`Synthetic ${key} declaration`,
  inputSchema:{type:'object', properties:{[key]:{type:'string'}}, required:[key], additionalProperties:false}});
const dispatch = tool('nozeli_dispatch','brief');
const manage = tool('nozeli_manage','action');
const ordinaryMaintenance = tool('nozeli_maintenance','ordinaryAction');
const debugMaintenance = tool('nozeli_maintenance','diagnosticAction');
const projectInstanceId = 'catalog-project-instance';
const ordinaryNames = ['nozeli_dispatch','nozeli_maintenance','nozeli_manage','read'];
const diagnosticNames = ['nozeli_maintenance','read'];
const userText = request => {
  const content=request.messages.filter(message=>message.role==='user').at(-1)?.content;
  return Array.isArray(content) ? content.filter(block=>block.type==='text').map(block=>block.text).join('') : content;
};
const intake = (id, text=id) => ({text,requestId:id,job:{id:`job-${id}`,type:'intake'}});
const debug = id => ({text:id,requestId:id,job:{id:`job-${id}`,type:'maintenance',context:{restrictedMode:'project-diagnosis',projectInstanceId}}, tools:[debugMaintenance]});
const inference = provider => provider.requests.filter(row=>!row.listing);
const wireTools = request => (request.tools??[]).map(({function:definition})=>definition).sort((a,b)=>a.name.localeCompare(b.name,'en'));

function checkWire(request, names, maintenance) {
  const declarations = wireTools(request);
  assert.deepEqual(declarations.map(row=>row.name).sort(),names);
  assert.equal(request.messages.some(message=>'tools' in message),false,'no historical Chat tool declarations');
  for (const definition of [dispatch,manage,maintenance].filter(Boolean)) {
    const wire = declarations.find(row=>row.name===definition.name);
    if (!names.includes(definition.name)) continue;
    assert.equal(wire.description,definition.description);
    assert.deepEqual(wire.parameters,definition.inputSchema);
  }
}

async function fixture(t, handler, {tools=[dispatch,manage,ordinaryMaintenance],nativeTools=['read'],answerHost=null}={}) {
  const pin = JSON.parse(await fs.readFile(new URL('../../../integrations/pi/upstream-manifest.json',import.meta.url)));
  const sdk = JSON.parse(await fs.readFile(new URL('../../../integrations/pi/node_modules/@earendil-works/pi-coding-agent/package.json',import.meta.url)));
  assert.equal(`${sdk.name}@${sdk.version}`,pin.sdk);
  const provider = await serve(handler);
  const dirs = await prepare(provider.url);
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dirs.agentDir;
  const owners = [], frames = [];
  t.after(async()=>{
    try { for (const owner of owners.reverse()) if (owner.sessionRef) await owner.stop(); }
    finally {
      await provider.close();
      await fs.rm(dirs.root,{recursive:true,force:true});
      if (oldAgentDir===undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR=oldAgentDir;
    }
  });
  const modelFile = path.join(dirs.agentDir,'models.json');
  const config = JSON.parse(await fs.readFile(modelFile));
  config.providers['local-fixture'].compat = {supportsMidConvoSystemMessages:true,supportsMidConvoToolAdditions:true};
  await fs.writeFile(modelFile,JSON.stringify(config));
  await fs.writeFile(path.join(dirs.agentDir,'settings.json'),JSON.stringify({
    compaction:{enabled:false,keepRecentTokens:40,reserveTokens:0}, retry:{enabled:false,provider:{maxRetries:1,maxRetryDelayMs:1000}},
  }));
  await fs.writeFile(path.join(dirs.cwd,'ordinary-note.txt'),'LOCAL_FILE_BODY_SENTINEL');
  const start = async(resume={})=>{
    const owner = new OwnerRuntime({send:frame=>{
      frames.push(frame);
      if (frame.event==='tool') {
        if(answerHost) void owner.respond({id:frame.id,result:answerHost(frame)});
        else{
          assert.equal(frame.tool,'nozeli_dispatch','unexpected privileged host dispatch');
          void owner.respond({id:frame.id,result:{action:'dispatch',at:'fixture-receipt',workId:'FIXTURE_RECEIPT_BODY'}});
        }
      }
    }});
    owners.push(owner);
    const initial = await owner.start({...dirs,...resume,role:'orchestrator',rolePackageRoot:dirs.root,roleSkillCatalog:[],nativeTools,
      projectInstanceId, tools, model:'local-fixture/scripted'});
    return {owner,initial};
  };
  return {provider,frames,start};
}

const observations = (frames, phase) => frames.filter(frame=>frame.eventData?.type==='nozeliToolCatalog'&&frame.eventData.phase===phase);

test('pinned Pi sends exact ordinary–DEBUG success/failure–ordinary catalogs, including retry, compaction and cold reconnect',{timeout:90000},async t=>{
  let retry=0;
  const {provider,frames,start} = await fixture(t,request=>{
    const text = userText(request), last = request.messages.at(-1);
    if (text==='secret-ordinary-input'&&last.role==='user') return {tool:'read',id:'ordinary-read',args:{path:'ordinary-note.txt'}};
    if (text==='debug-success'&&last.role==='user') return {tool:'read',id:'restricted-read',args:{path:'ordinary-note.txt'}};
    if (text==='debug-failure') {
      if (++retry===1) return {status:503,error:{message:'synthetic retry'}};
      return {status:400,error:{message:'synthetic DEBUG rejection'}};
    }
    if (text==='ordinary-route') return {tool:'nozeli_dispatch',id:'ordinary-route-call',args:{brief:'FIXTURE_ARGUMENT_BODY'}};
    return {text:'A bounded scripted answer. '.repeat(20)};
  });
  const {owner,initial} = await start();
  const ordinary = async(id,text)=>{
    const before=inference(provider).length;
    const result=await owner.prompt(intake(id,text));
    const requests=inference(provider).slice(before);
    assert.ok(requests.length);
    requests.forEach(request=>checkWire(request,ordinaryNames,ordinaryMaintenance));
    return {result,requests};
  };
  const first=await ordinary('ordinary-first','secret-ordinary-input');
  assert.equal(first.requests.length,2);
  assert.match(JSON.stringify(first.requests[1].messages.at(-1)),/LOCAL_FILE_BODY_SENTINEL/);

  // Actual native activation can drift; it is never the source of truth for restoration.
  owner.nativeRuntime.session.setActiveToolsByName(['read']);
  let offset=inference(provider).length;
  await owner.prompt(debug('debug-success'));
  const debugRequests=inference(provider).slice(offset);
  assert.equal(debugRequests.length,2);
  debugRequests.forEach(request=>checkWire(request,diagnosticNames,debugMaintenance));
  const restrictedResult=JSON.stringify(debugRequests[1].messages.at(-1));
  assert.match(restrictedResult,/Restricted read permits only/);
  assert.doesNotMatch(restrictedResult,/LOCAL_FILE_BODY_SENTINEL/);
  await ordinary('ordinary-after-debug');

  offset=inference(provider).length;
  await assert.rejects(owner.prompt(debug('debug-failure')),{code:'PI_PROVIDER_FAILED'});
  const failed=inference(provider).slice(offset);
  assert.equal(failed.length,2,'pinned SDK retries only the already verified payload');
  failed.forEach(request=>checkWire(request,diagnosticNames,debugMaintenance));
  assert.deepEqual(wireTools(failed[0]),wireTools(failed[1]));
  const routed=await ordinary('ordinary-route');
  assert.equal(routed.result.completion,'host-control');

  offset=inference(provider).length;
  assert.equal((await owner.compact()).compacted,true);
  const summaries=inference(provider).slice(offset);
  assert.ok(summaries.length);
  summaries.forEach(request=>checkWire(request,[],null));
  await ordinary('ordinary-after-compaction');

  offset=inference(provider).length;
  await owner.reload();
  await owner.stop();
  const journal = await fs.readFile(initial.sessionFile,'utf8');
  const {owner:resumed,initial:resumedState} = await start({sessionId:initial.sessionId,sessionFile:initial.sessionFile});
  assert.equal(resumedState.sessionId,initial.sessionId);
  assert.equal(await fs.readFile(initial.sessionFile,'utf8'),journal);
  await assert.rejects(resumed.recover({job:{id:'historical-intake',type:'intake'}}),{code:'PI_RECOVERY_RECONCILIATION'});
  assert.equal(inference(provider).length,offset,'reload, reconnect and historical-intake rejection do not replay');
  await resumed.prompt(intake('explicit-new-input'));
  checkWire(inference(provider).at(-1),ordinaryNames,ordinaryMaintenance);

  const outbound=observations(frames,'outbound-verified');
  assert.ok(outbound.every(row=>row.ownerGeneration&&row.eventData.projectInstanceId===projectInstanceId));
  assert.ok(outbound.some(({eventData})=>eventData.purpose==='compaction'&&eventData.tools.length===0));
  const byId=(id)=>outbound.find(row=>row.eventData.requestId===id);
  assert.equal(byId('debug-success').eventData.mode,'project-diagnosis');
  assert.equal(byId('ordinary-after-debug').eventData.mode,'ordinary');
  assert.notEqual(byId('ordinary-after-debug').eventData.schemaDigest,byId('debug-success').eventData.schemaDigest);
  assert.equal(byId('ordinary-after-debug').eventData.schemaDigest,byId('explicit-new-input').eventData.schemaDigest);
  assert.notEqual(byId('ordinary-after-debug').ownerGeneration,byId('explicit-new-input').ownerGeneration);
  const settled=observations(frames,'settlement').map(frame=>frame.eventData);
  assert.ok(settled.some(row=>row.requestId==='ordinary-route'&&row.routingReceipt==='dispatch'));
  assert.ok(settled.some(row=>row.requestId==='debug-success'&&row.outcome==='completed'&&row.stopReason==='stop'&&row.lastToolResult==='error'));
  assert.ok(settled.some(row=>row.requestId==='debug-failure'&&row.outcome==='error'&&row.stopReason==='error'));
  assert.doesNotMatch(JSON.stringify([...outbound.map(row=>row.eventData),...settled]),/secret-ordinary-input|LOCAL_FILE_BODY_SENTINEL|FIXTURE_RECEIPT_BODY|FIXTURE_ARGUMENT_BODY|local-nonsecret|ordinary-note\.txt|diagnosticAction|synthetic DEBUG rejection/);
  assert.deepEqual(provider.errors,[]);
});

test('an incomplete ordinary route catalog is rejected before journal admission',{timeout:45000},async t=>{
  const {provider,frames,start} = await fixture(t,()=>({text:'must not be called'}),{tools:[dispatch]});
  const {owner,initial} = await start();
  const before=await fs.readFile(initial.sessionFile,'utf8');
  await assert.rejects(owner.prompt(intake('bad-route-catalog')),{
    code:'PI_TOOL_CATALOG_MISMATCH',definitiveNonDispatch:true,deliveryPhase:'not-submitted',
  });
  assert.equal(await fs.readFile(initial.sessionFile,'utf8'),before);
  assert.equal(inference(provider).length,0);
  assert.equal(observations(frames,'admission-rejected').length,1);
  assert.deepEqual((await owner.status()).contextDelivery.deliveryRecords,[]);
});

test('read-only intake removes native effects before submission and restores the ordinary catalog',{timeout:45000},async t=>{
  const {provider,start,frames}=await fixture(t,request=>userText(request)==='readonly-intake'
    ? {tool:'nozeli_manage',id:'readonly-receipt',args:{action:'read-only'}} : {text:'ordinary answer'}, {
    nativeTools:['read','bash','edit','write'],
    answerHost:frame=>{assert.equal(frame.tool,'nozeli_manage');return {action:'read-only',saved:true,at:'fixture-receipt',answer:'the answer'};},
  });
  const {owner}=await start();
  const input=intake('readonly-intake');input.job.context={routingMode:'read-only'};
  const result=await owner.prompt(input);
  assert.equal(result.completion,'host-control');
  assert.equal(result.delivery.phase,'native-record-confirmed');
  assert.equal(inference(provider).length,1);
  checkWire(inference(provider)[0],['nozeli_manage','read']);
  const settled=observations(frames,'settlement').find(({eventData})=>eventData.requestId===input.requestId).eventData;
  assert.equal(settled.routingReceipt,'read-only');assert.equal(settled.mode,'read-only');assert.equal(settled.catalogRestored,true);
  await owner.prompt(intake('ordinary-after-readonly'));
  checkWire(inference(provider).at(-1),[...ordinaryNames,'bash','edit','write'].sort(),ordinaryMaintenance);
});

test('a post-admission schema or incremental declaration mutation cannot reach the provider',{timeout:60000},async t=>{
  const {provider,start} = await fixture(t,()=>({text:'clean request'}));
  const {owner} = await start();
  const agent=owner.nativeRuntime.session.agent;
  const original=agent.onPayload;
  for (const [id,mutate] of [
    ['wire-schema-drift',payload=>{payload.tools.find(row=>row.function.name==='nozeli_dispatch').function.parameters={type:'object'};}],
    ['wire-incremental-drift',payload=>{payload.messages.push({role:'system',tools:[payload.tools[0]]});}],
    ['wire-legacy-declarations',payload=>{payload.functions=[payload.tools[0].function];}],
    ['wire-legacy-selection',payload=>{payload.function_call='auto';}],
  ]) {
    agent.onPayload=async(payload, model)=>{
      const result=(await original(payload,model))??payload;
      mutate(result);
      return result;
    };
    const input=intake(id);
    const offset=inference(provider).length;
    await assert.rejects(owner.prompt(input),error=>error.code==='PI_TOOL_CATALOG_MISMATCH'&&
      error.deliveryPhase==='native-record-confirmed'&&error.definitiveNonDispatch!==true);
    await assert.rejects(owner.prompt(input),{code:'PI_DUPLICATE_REQUEST',deliveryPhase:'native-record-confirmed'});
    assert.equal(inference(provider).length,offset);
  }
  agent.onPayload=original;
  await owner.prompt(intake('new-command-after-wire-refusal'));
  checkWire(inference(provider).at(-1),ordinaryNames,ordinaryMaintenance);
});

test('loss of native settlement keeps real DEBUG owner fenced and does not restore tools',{timeout:45000},async t=>{
  const {provider,start} = await fixture(t,()=>({text:'provider finished'}));
  const {owner} = await start();
  const original=owner.facts.onNativeSessionEvent;
  let lateSettlement;
  owner.facts.onNativeSessionEvent=(ref,event)=>{
    if (event.type==='agent_settled') { lateSettlement=()=>original(ref,event); return; }
    original(ref,event);
  };
  await assert.rejects(owner.prompt(debug('settlement-not-confirmed')),{code:'PI_SETTLEMENT_UNKNOWN'});
  assert.equal(typeof lateSettlement,'function','real SDK settlement was withheld from owner only');
  assert.equal((await owner.status()).catalogUnsafe,true);
  checkWire(inference(provider).at(-1),diagnosticNames,debugMaintenance);
  const before=inference(provider).length;
  await assert.rejects(owner.prompt(intake('blocked-while-unknown')),{code:'PI_TOOL_CATALOG_UNSAFE',definitiveNonDispatch:true});
  await assert.rejects(owner.compact(),{code:'PI_TOOL_CATALOG_UNSAFE'});
  lateSettlement();
  await assert.rejects(owner.prompt(intake('blocked-after-late-settlement')),{code:'PI_TOOL_CATALOG_UNSAFE'});
  assert.equal(inference(provider).length,before);
});

test('a failed definition restoration fences the owner without relabeling an admitted DEBUG entry',{timeout:45000},async t=>{
  let owner;
  const {provider,start} = await fixture(t,()=>{
    const session=owner.nativeRuntime.session;
    const install=session.setActiveToolsByName.bind(session);
    session.setActiveToolsByName=names=>{
      if (names.includes('nozeli_dispatch')) throw Error('synthetic restoration fault');
      return install(names);
    };
    return {text:'DEBUG was delivered'};
  });
  ({owner}=await start());
  await assert.rejects(owner.prompt(debug('restore-failure')),error=>error.code==='PI_TOOL_CATALOG_UNSAFE'&&
    error.deliveryPhase==='native-record-confirmed'&&error.definitiveNonDispatch!==true);
  assert.equal((await owner.status()).catalogUnsafe,true);
  assert.equal(inference(provider).length,1);
  checkWire(inference(provider)[0],diagnosticNames,debugMaintenance);
  await assert.rejects(owner.prompt(intake('blocked-after-restore-failure')),{code:'PI_TOOL_CATALOG_UNSAFE',definitiveNonDispatch:true});
  assert.equal(inference(provider).length,1);
});

test('imported skill is frozen per ordinary request and verified on wire, never journaled or inherited',{timeout:60000},async t=>{
  const {sha256Hex,IMPORTED_SKILL_MAX_BYTES}=await import('../../../integrations/pi/src/context-delivery.mjs');
  const body='IMPORTED_SKILL_FIXTURE_独立';
  const skill={id:'local-fixture',version:'1.0.0',digest:sha256Hex(body),text:body};
  const {provider,start,frames}=await fixture(t,request=>{
    if (JSON.stringify(request.messages).includes(body) && !request.messages.some(row=>row.role==='tool')) {
      return {tool:'read',id:'skill-fixture-read',args:{path:'ordinary-note.txt'}};
    }
    return {text:'A scripted answer. '.repeat(20)};
  });
  const {owner,initial}=await start();
  const selected={...intake('selected'),importedSkill:skill};
  const invalid=[
    [{...selected,importedSkill:{...skill,digest:'0'.repeat(64)}},'PI_IMPORTED_SKILL_DIGEST_MISMATCH'],
    [{...selected,importedSkill:{...skill,text:'字'.repeat(IMPORTED_SKILL_MAX_BYTES)}},'PI_IMPORTED_SKILL_OVER_BUDGET'],
    [{...debug('restricted-selected'),importedSkill:skill},'PI_IMPORTED_SKILL_FORBIDDEN'],
    [{...selected,job:{id:'readonly',type:'intake',context:{routingMode:'read-only'}}},'PI_IMPORTED_SKILL_FORBIDDEN'],
  ];
  for(const [input,code] of invalid) await assert.rejects(owner.prompt(input),{code,definitiveNonDispatch:true,deliveryPhase:'not-submitted'});
  assert.equal(inference(provider).length,0);
  const result=await owner.prompt(selected);
  assert.equal(inference(provider).length,2);
  for(const payload of inference(provider)) {
    checkWire(payload,ordinaryNames,ordinaryMaintenance);
    assert.match(JSON.stringify(payload.messages),/IMPORTED_SKILL_FIXTURE_独立/);
  }
  assert.deepEqual(result.delivery.importedSkill,{id:skill.id,version:skill.version,digest:skill.digest,
    bytes:Buffer.byteLength(body),persisted:false,outboundVerifiedCalls:2});
  assert.equal(result.delivery.phase,'native-record-confirmed');
  assert.doesNotMatch(await fs.readFile(initial.sessionFile,'utf8'),/IMPORTED_SKILL_FIXTURE|nozeli-imported-skill:/);
  assert.doesNotMatch(JSON.stringify(frames.filter(row=>row.eventData?.type==='nozeliDelivery')),/IMPORTED_SKILL_FIXTURE/);
  await assert.rejects(owner.prompt({...selected,importedSkill:{...skill,version:'2.0.0'}}),{code:'PI_DUPLICATE_REQUEST'});
  assert.equal(inference(provider).length,2);
  await owner.prompt(intake('unselected'));
  assert.doesNotMatch(JSON.stringify(inference(provider).at(-1)),/IMPORTED_SKILL_FIXTURE/);
  await owner.compact();
  assert.doesNotMatch(JSON.stringify(inference(provider).at(-1)),/IMPORTED_SKILL_FIXTURE/);
  const agent=owner.nativeRuntime.session.agent, original=agent.onPayload;
  agent.onPayload=async(payload,model)=>{
    const result=(await original(payload,model))??payload;
    result.messages=result.messages.filter(message=>!JSON.stringify(message).includes(body));
    return result;
  };
  const offset=inference(provider).length;
  await assert.rejects(owner.prompt({...intake('removed-by-transform'),importedSkill:skill}),{code:'PI_IMPORTED_SKILL_UNVERIFIED'});
  assert.equal(inference(provider).length,offset);
  agent.onPayload=original;
});
