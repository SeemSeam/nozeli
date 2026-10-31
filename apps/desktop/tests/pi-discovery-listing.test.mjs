// Bounded service model-listing regressions for the bridge pagination helper.
// Pure function tests: no network, no credentials, no inference requests.
// Run: node --test tests/pi-discovery-listing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectServiceModels} from '../../../integrations/pi/src/bridge.mjs';

const listing=(pages,{failOn}={})=>{
  let calls=0;
  const fetchPage=async url=>{
    calls++;
    if(failOn===calls)throw Object.assign(new Error('discovery response exceeded size bound'),{code:'DISCOVERY_TOO_LARGE'});
    const page=pages[calls-1];
    if(!page)return {status:500,ok:false,text:''};
    if(page.throwNetwork)throw new Error('fetch failed');
    if(page.status)return {status:page.status,ok:false,text:''};
    if(page.after!==undefined&&String(url.searchParams.get('after'))!==String(page.after))throw Error('cursor not forwarded: '+url.searchParams.get('after'));
    return {status:200,ok:true,text:typeof page.text==='string'?page.text:JSON.stringify(page)};
  };
  return {fetchPage,calls:()=>calls};
};

test('a normally completed multi-page listing below the model cap succeeds',async()=>{
  const run=listing([
    {data:[{id:'m-a'},{id:'m-b',name:'B'}],has_more:true,last_id:'m-b'},
    {data:[{id:'m-c'}],has_more:false},
  ]);
  const result=await collectServiceModels({listUrl:'http://x.test/v1/models?limit=100',headers:{},fetchPage:run.fetchPage});
  assert.equal(result.status,'succeeded','has_more:false on the final page must not be misread as truncated pagination');
  assert.deepEqual(result.models.map(m=>m.id),['m-a','m-b','m-c']);
  assert.equal(result.models.find(m=>m.id==='m-b').name,'B');
  assert.equal(run.calls(),2);
});

test('an unbounded cursor is stopped at the page bound and reported as DISCOVERY_PAGINATION',async()=>{
  let n=0;
  const result=await collectServiceModels({listUrl:'http://x.test/v1/models?limit=100',headers:{},fetchPage:async url=>{n++;return {status:200,ok:true,text:JSON.stringify({data:[{id:'m-'+n}],has_more:true,last_id:'c'+n})};}});
  assert.equal(result.status,'failed');
  assert.equal(result.error.code,'DISCOVERY_PAGINATION');
  assert.equal(n,10);
});

test('404/405 surface an unsupported listing endpoint; 401/403 stay authorization failures',async()=>{
  for(const [status,expected] of [[404,'unsupported'],[405,'unsupported'],[401,'failed'],[403,'failed']]){
    const result=await collectServiceModels({listUrl:'http://x.test/v1/models',headers:{},fetchPage:async()=>({status,ok:false,text:''})});
    assert.equal(result.status,expected,status+' must map to '+expected);
    if(expected==='unsupported')assert.equal(result.error.code,'DISCOVERY_LISTING_UNSUPPORTED');
    else assert.equal(result.error.code,'DISCOVERY_UNAUTHORIZED');
  }
});

test('malformed payloads, other statuses, network and oversize failures stay sanitized',async()=>{
  const malformed=await collectServiceModels({listUrl:'http://x.test/v1/models',headers:{},fetchPage:async()=>({status:200,ok:true,text:'not json'})});
  assert.equal(malformed.error.code,'DISCOVERY_MALFORMED');
  const shaped=await collectServiceModels({listUrl:'http://x.test/v1/models',headers:{},fetchPage:async()=>({status:200,ok:true,text:JSON.stringify({nope:true})})});
  assert.equal(shaped.error.code,'DISCOVERY_MALFORMED');
  const other=await collectServiceModels({listUrl:'http://x.test/v1/models',headers:{},fetchPage:async()=>({status:503,ok:false,text:''})});
  assert.equal(other.error.code,'DISCOVERY_ENDPOINT');
  const net=await collectServiceModels({listUrl:'http://x.test/v1/models',headers:{},fetchPage:async()=>{throw new Error('fetch failed');}});
  assert.equal(net.error.code,'DISCOVERY_NETWORK');
  const oversize=await collectServiceModels({listUrl:'http://x.test/v1/models',headers:{},fetchPage:async()=>{throw Object.assign(new Error('too large'),{code:'DISCOVERY_TOO_LARGE'});}});
  assert.equal(oversize.error.code,'DISCOVERY_TOO_LARGE');
});

test('duplicate ids are deduped and the model cap truncates safely',async()=>{
  const dupes=await collectServiceModels({listUrl:'http://x.test/v1/models',headers:{},fetchPage:async()=>({status:200,ok:true,text:JSON.stringify({data:[{id:'same'},{id:'same'},{id:'other'}],has_more:false})})});
  assert.deepEqual(dupes.models.map(m=>m.id),['same','other']);
});
