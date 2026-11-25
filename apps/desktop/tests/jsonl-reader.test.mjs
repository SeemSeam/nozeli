import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createJsonlReader} from '../src/agents/managed/jsonl-reader.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';

function fixture(options={}){const stream=new PassThrough(),frames=[],errors=[];const reader=createJsonlReader(stream,{onFrame:frame=>frames.push(frame),onError:error=>errors.push(error),...options});return {stream,reader,frames,errors};}

test('JSONL splits arbitrary byte boundaries including a multi-byte Unicode character',()=>{
  const f=fixture(),expected=[{id:'一',text:'😀'},{id:'two',result:'ok'}],bytes=Buffer.from(expected.map(value=>JSON.stringify(value)).join('\r\n')+'\n');
  for(const byte of bytes)f.stream.write(Buffer.from([byte]));
  f.stream.end();assert.deepEqual(f.frames,expected);assert.equal(f.errors.length,0);assert.equal(f.reader.bufferedBytes,0);
});
test('JSONL enforces byte rather than character budget before a newline arrives',()=>{
  const f=fixture({maxFrameBytes:8});f.stream.write(Buffer.from('中文中'));f.stream.write(Buffer.from('{}\n'));
  assert.equal(f.errors[0]?.reason,'frame-too-large');assert.equal(f.frames.length,0);assert.equal(f.reader.bufferedBytes,0);
});
test('an exact-size frame is accepted and the next frame reuses the bounded accumulator',()=>{
  const f=fixture({maxFrameBytes:8});f.stream.write('{"x":12}\n{}\n');assert.deepEqual(f.frames,[{x:12},{}]);assert.equal(f.errors.length,0);
});
for(const [name,bytes,reason] of [
  ['invalid JSON',Buffer.from('{bad}\n'),'json'],['invalid UTF-8',Buffer.from([123,34,120,34,58,34,255,34,125,10]),'utf8'],
  ['empty line',Buffer.from('\n'),'empty-frame'],['null',Buffer.from('null\n'),'shape'],['array',Buffer.from('[]\n'),'shape'],
  ['primitive',Buffer.from('1\n'),'shape'],
])test(name+' fences all following frames and reports one failure',()=>{
  const f=fixture();f.stream.write(Buffer.concat([bytes,Buffer.from('{"late":true}\n')]));f.stream.write('{}\n');
  assert.equal(f.frames.length,0);assert.equal(f.errors.length,1);assert.equal(f.errors[0].reason,reason);assert.equal(f.reader.failed,f.errors[0]);
});
test('invalid JSON diagnostic never carries private frame excerpts',()=>{
 const f=fixture(),marker='SYNTHETIC_PRIVATE_FRAME';
 f.stream.write('{"private":"'+marker+'",BROKEN}\n');
 assert.equal(f.errors[0]?.reason,'json');assert.equal(f.errors[0]?.cause,undefined);
 assert(!String(f.errors[0]?.stack).includes(marker));assert.deepEqual(f.frames,[]);
});
test('EOF after a partial frame rejects rather than accepting an unterminated message',async()=>{
  const f=fixture();f.stream.end('{"partial":true}');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.errors[0]?.reason,'truncated');assert.equal(f.frames.length,0);
  assert.equal(f.reader.completed,false);
});
test('normal empty EOF produces no protocol error',async()=>{
  const f=fixture();f.stream.end();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.errors.length,0);assert.equal(f.reader.completed,true);
});
test('stream errors and premature close retain distinct failure reasons',async()=>{
  const a=fixture(),b=fixture();a.stream.destroy(Error('synthetic'));b.stream.destroy();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(a.errors[0]?.reason,'stream');assert.equal(b.errors[0]?.reason,'disconnected');
});
test('callback failure fences the rest of its chunk and deliberate close detaches listeners',()=>{
  const f=fixture({onFrame(){throw Error('controlled callback failure');}});f.stream.write('{}\n{}\n');
  assert.equal(f.errors[0]?.reason,'handler');assert.equal(f.errors.length,1);
  const g=fixture();g.reader.close();g.stream.write('{}\n');assert.equal(g.frames.length,0);assert.equal(g.stream.listenerCount('data'),0);
  assert.equal(g.reader.completed,false,'deliberate detach cannot certify clean EOF');
});
test('invalid configuration refuses without attaching a stream consumer',()=>{
  for(const maxFrameBytes of [0,-1,1.2,Infinity,64*1024*1024+1])assert.throws(()=>fixture({maxFrameBytes}),{code:'JSONL_OPTIONS_INVALID'});
});
test('parsed frames use actual PiSession pending request correlation and ignore a late unknown reply',()=>{
  const session=new PiSession({role:'worker',home:'/synthetic/home',cwd:'/synthetic'}),results=[];
  session.pending.set('current',{timer:setTimeout(()=>{},1000),resolve:value=>results.push(value),reject:assert.fail});
  const f=fixture({onFrame:frame=>session.receiveFrame(frame)});
  f.stream.write('{"id":"late","result":"old"}\n{"id":"current","result":"confirmed"}\n');
  assert.deepEqual(results,['confirmed']);assert.equal(session.pending.size,0);assert.equal(f.errors.length,0);f.reader.close();
});
