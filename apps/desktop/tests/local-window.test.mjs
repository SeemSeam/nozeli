import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultLocalWindowView,localWindowRect,validLocalWindowView} from '../src/renderer/local-window.mjs';

test('effective clipping never overwrites preferred geometry and grows back',()=>{
  const state={...defaultLocalWindowView(),placement:{mode:'manual',x:700,y:500},size:{width:420,height:430}};
  const original=structuredClone(state),defaultRect={x:20,y:20,width:380,height:380};
  assert.deepEqual(localWindowRect(state,{bounds:{x:0,y:0,width:320,height:240},defaultRect}),{x:0,y:0,width:320,height:240});
  assert.deepEqual(localWindowRect(state,{bounds:{x:0,y:0,width:1400,height:1000},defaultRect}),{x:700,y:500,width:420,height:430});
  assert.deepEqual(state,original);
});
test('auto placement uses the measured surface and collapsed height remains reachable',()=>{
  const state={...defaultLocalWindowView(),collapsed:true};
  assert.deepEqual(localWindowRect(state,{bounds:{x:100,y:60,width:200,height:20},defaultRect:{x:-50,y:800,width:380,height:400}}),{x:100,y:60,width:200,height:20});
  assert.deepEqual(state.placement,{mode:'auto'});
});
test('unknown schemas and nonfinite legacy coordinates are not accepted as views',()=>{
  assert.equal(validLocalWindowView(defaultLocalWindowView()),true);
  for(const invalid of [{schema:2},{revision:-1},{placement:{mode:'manual',x:Infinity,y:2}},{size:{width:0,height:30}}])assert.equal(Boolean(validLocalWindowView({...defaultLocalWindowView(),...invalid})),false);
});
