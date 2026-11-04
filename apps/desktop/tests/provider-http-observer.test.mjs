import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {installProviderHttpObserver,providerHttpObservations,providerHttpObserverSeq} from '../../../integrations/pi/src/http-observer.mjs';

test('real provider HTTP observations preserve Request streams and exclude credentials while retaining transport facts',async()=>{
 const original=globalThis.fetch;
 const received=[];
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  received.push({url:req.url,method:req.method,body:Buffer.concat(chunks).toString()});
  res.writeHead(402,{'content-type':'application/json'});
  res.end(JSON.stringify({error:{code:'insufficient_quota',message:'synthetic private response'}}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address(),base=`http://127.0.0.1:${address.port}`;
 try{
  installProviderHttpObserver();installProviderHttpObserver();
  const start=providerHttpObserverSeq(),controller=new AbortController();
  const request=new Request(base+'/v1/chat/completions?api_key=synthetic-query-secret',{method:'POST',headers:{authorization:'Bearer synthetic-header-secret'},body:'synthetic private body',signal:controller.signal});
  const response=await fetch(request);
  assert.equal(response.status,402);
  assert.deepEqual(await response.json(),{error:{code:'insufficient_quota',message:'synthetic private response'}});
  assert.deepEqual(received,[{url:'/v1/chat/completions?api_key=synthetic-query-secret',method:'POST',body:'synthetic private body'}]);
  const rows=providerHttpObservations({sinceSeq:start});
  assert.equal(rows.length,1,'one install per process, no duplicated observation');
  assert.equal(rows[0].status,402);assert.equal(rows[0].method,'POST');assert.equal(rows[0].origin,base);assert.equal(rows[0].pathname,'/v1/chat/completions');
  const evidence=JSON.stringify(rows);
  for(const sensitive of ['synthetic-query-secret','synthetic-header-secret','synthetic private body','synthetic private response','authorization','api_key'])assert.equal(evidence.includes(sensitive),false,`transport facts leaked ${sensitive}`);
  controller.abort();
  await assert.rejects(fetch(new Request(base+'/aborted',{signal:controller.signal})),error=>error.name==='AbortError');
  assert.equal(received.length,1,'Request abort signal must still prevent the request');
  const ringStart=providerHttpObserverSeq();
  for(let i=0;i<40;i++)await (await fetch(base+'/bounded/'+i,{method:'POST'})).arrayBuffer();
  const bounded=providerHttpObservations({sinceSeq:ringStart,max:1000});
  assert.equal(bounded.length,16);
  assert.deepEqual(bounded.map(row=>row.pathname),Array.from({length:16},(_,i)=>'/bounded/'+(24+i)));
  const networkStart=providerHttpObserverSeq();
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await assert.rejects(fetch(base+'/disconnected',{method:'POST'}));
  const failures=providerHttpObservations({sinceSeq:networkStart});
  assert.equal(failures.length,1);assert.equal(failures[0].status,null);assert.ok(['ECONNREFUSED','UND_ERR_SOCKET'].includes(failures[0].networkCode),'closed listener or recycled keepalive socket must retain a supported transport failure code');
 }finally{
  globalThis.fetch=original;
  if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 }
});
