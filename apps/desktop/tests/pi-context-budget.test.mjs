// Unit contracts for the bridge-side context-cutover normalizers: the
// projection ceiling blocks instead of truncating, materials keep exact bodies
// with journaled provenance identity, and calibrated ceiling overrides stay
// byte-exact. No Pi owner process is spawned here.
// Run: node --test tests/pi-context-budget.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CONTEXT_BUDGET_DEFAULTS,normalizeMaterials,normalizeProjection} from '../../../integrations/pi/src/context-delivery.mjs';

test('the projection ceiling blocks oversized control projections instead of truncating them',()=>{
  const exact='x'.repeat(CONTEXT_BUDGET_DEFAULTS.projectionMaxBytes);
  const ok=normalizeProjection({text:exact},CONTEXT_BUDGET_DEFAULTS.projectionMaxBytes);
  assert.equal(ok.bytes,CONTEXT_BUDGET_DEFAULTS.projectionMaxBytes);
  assert.equal(ok.envelopeText.includes(exact),true);
  assert.throws(()=>normalizeProjection({text:exact+'!'},CONTEXT_BUDGET_DEFAULTS.projectionMaxBytes),error=>{
    assert.equal(error.code,'PI_PROJECTION_OVER_BUDGET');
    assert.equal(error.bytes,CONTEXT_BUDGET_DEFAULTS.projectionMaxBytes+1);
    return true;
  });
  assert.equal(normalizeProjection(null,4096),null);
  assert.throws(()=>normalizeProjection({text:''},4096),{code:'PI_INVALID_PARAMS'});
});

test('material envelopes keep exact bodies and carry journaled provenance identity',()=>{
  const body='frozen body with "quotes" & <tags>\nline two';
  const materials=normalizeMaterials([{id:'paper',version:3,title:'Selection',mediaType:'text/markdown',provenance:{source:'frontdesk',versionLabel:'rev 3'},text:body}],{requestId:'req-1',jobId:'job-1'});
  assert.equal(materials.items[0].bytes,Buffer.byteLength(body,'utf8'));
  assert.equal(materials.items[0].sha256,createHash('sha256').update(body,'utf8').digest('hex'));
  assert.equal(materials.message.customType,'nozeli-materials');
  assert.equal(materials.message.content[0].text.includes(body),true,'exact material body rides the envelope');
  assert.deepEqual(materials.message.details,{requestId:'req-1',jobId:'job-1',materials:[{id:'paper',version:'3',sha256:materials.items[0].sha256,bytes:materials.items[0].bytes}]});
  assert.throws(()=>normalizeMaterials([],{}),{code:'PI_INVALID_PARAMS'});
  assert.throws(()=>normalizeMaterials([{id:'x',version:1,text:'ok'},{id:'x',text:'no version'}],{}),{code:'PI_INVALID_PARAMS'});
  assert.equal(normalizeMaterials(undefined,{}),null);
});

test('a calibrated ceiling override accepts what the default blocks, byte-exactly',()=>{
  const calibrated=normalizeProjection({text:'y'.repeat(8192)},8192);
  assert.equal(calibrated.bytes,8192);
  assert.throws(()=>normalizeProjection({text:'y'.repeat(8193)},8192),{code:'PI_PROJECTION_OVER_BUDGET'});
});
