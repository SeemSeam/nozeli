import test from 'node:test';import assert from 'node:assert/strict';
import {createWorkerTerminalLifecycle,waitForTerminalFirstFrame} from '../src/agents/managed/worker-terminal-first-frame.mjs';
test('deadline bounds a parser promise which never resolves',async()=>{
 await assert.rejects(waitForTerminalFirstFrame({snapshot:()=>new Promise(()=>{}),exited:new Promise(()=>{})},{timeout:25}),/timed out/);
});
test('failed attach clears both single-flight maps and allows explicit retry',async()=>{
 let attempts=0,stored;const attachment={snapshot:async()=>({seq:1,lines:[[{text:'CLI'}]]}),exited:new Promise(()=>{})};
 const gate=createWorkerTerminalLifecycle({getAttachment:()=>stored,isAllowed:()=>true,attach:async()=>{if(++attempts===1)throw Error('real attachment unavailable');stored=attachment;return attachment;}});
 await assert.rejects(gate.prepare('worker'),/unavailable/);assert.equal((await gate.resume('worker')).attachment,attachment);assert.equal(attempts,2);
});
test('closing work while attach is pending never releases execution',async()=>{
 let finish,stored,allowed=true;const connecting=new Promise(r=>finish=r);const attachment={snapshot:async()=>({seq:1,lines:[[{text:'late CLI'}]]}),exited:new Promise(()=>{})};
 const gate=createWorkerTerminalLifecycle({getAttachment:()=>stored,isAllowed:()=>allowed,attach:async()=>{await connecting;stored=attachment;return attachment;}});
 const pending=gate.prepare('worker');allowed=false;finish();await assert.rejects(pending,/no longer executable/);
});
