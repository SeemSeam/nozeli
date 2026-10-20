import test from 'node:test';
import assert from 'node:assert/strict';
import {agentOps} from '../src/agents/ipc.mjs';

test('renderer cannot select, detect, save or connect alternative backends',()=>{
  let touched=false;
  const runtime=new Proxy({}, {get(){touched=true;throw Error('legacy mutation reached');}});
  const operations=agentOps(runtime,{});
  for(const op of ['agents.bootstrap','agents.detect','agents.settings.read','agents.settings.save','agents.dismiss','agents.connect','agents.retry','agents.send','agents.cancel']){
    assert.equal(operations[op],undefined,op);
  }
  assert.equal(touched,false);
});

test('historical conversation and report reads remain available without provider detection',async()=>{
  const messages=[{id:'old',role:'qa',text:'Saved Codex reply'}],reports=[{id:'report',title:'Saved report'}],work=[{id:'work',status:'ended'}];
  const runtime={messages:id=>{assert.equal(id,'old-project');return messages;},reports:id=>{assert.equal(id,'old-project');return reports;},work:id=>{assert.equal(id,'old-project');return work;},readReport:(id,reportId)=>{assert.equal(id,'old-project');assert.equal(reportId,'report');return {text:'Original frozen report'};}};
  let loaded=0;runtime.loadHistory=async id=>{assert.equal(id,'old-project');loaded++;};
  const operations=agentOps(runtime,{});
  assert.deepEqual(await operations['agents.messages']({projectId:'old-project'}),{messages});
  assert.deepEqual(await operations['agents.reports']({projectId:'old-project'}),{reports});
  assert.deepEqual(await operations['agents.work']({projectId:'old-project'}),{work});
  assert.equal(loaded,3);
  assert.deepEqual(operations['agents.report.read']({projectId:'old-project',reportId:'report'}),{text:'Original frozen report'});
});
