import test from 'node:test';
import assert from 'node:assert/strict';
import {createTerminalScreen} from '../src/agents/managed/terminal-screen.mjs';
import {createWorkerTerminalLifecycle, waitForTerminalFirstFrame} from '../src/agents/managed/worker-terminal-first-frame.mjs';
const deferred = () => {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(screen) {const exit=deferred();return {snapshot:()=>screen.snapshot(),exited:exit.promise,closed:false,exit};}

test('real parser: ANSI-only is not a frame; printable output is', async t => {
 const screen=createTerminalScreen();t.after(()=>screen.dispose());const attachment=fixture(screen);
 await screen.write('\x1b[31m\x1b[2J',1);
 await assert.rejects(waitForTerminalFirstFrame(attachment,{timeout:30}),/timed out/);
 await screen.write('Codex first frame',2);
 const result=await waitForTerminalFirstFrame(attachment);
 assert.equal(result.screen.seq,2);assert.equal(result.attachment,attachment);
});
test('exit and abort reject even while a snapshot is stuck', async () => {
 const stalled=deferred(),exit=deferred();const attachment={snapshot:()=>stalled.promise,exited:exit.promise};
 const abort=new AbortController(),p=waitForTerminalFirstFrame(attachment,{signal:abort.signal});
 abort.abort(new Error('user ended'));await assert.rejects(p,/user ended/);
 const q=waitForTerminalFirstFrame(attachment);exit.resolve();await assert.rejects(q,/exited/);
 stalled.resolve({seq:1,lines:[[{text:'late frame'}]]});
});
test('pause during attach, explicit resume and concurrent callers share one PTY', async t => {
 const screen=createTerminalScreen();t.after(()=>screen.dispose());await screen.write('Real parsed fixture',1);
 const attachment=fixture(screen),connecting=deferred();let stored,calls=0,allowed=true;
 const lifecycle=createWorkerTerminalLifecycle({attach:async()=>{calls++;await connecting.promise;stored=attachment;return attachment;},getAttachment:()=>stored,isAllowed:()=>allowed});
 const first=lifecycle.prepare('w');assert.equal(first,lifecycle.prepare('w'));
 await Promise.resolve();lifecycle.pause('w');const resumed=lifecycle.resume('w');
 connecting.resolve();await assert.rejects(first,/paused/);assert.equal((await resumed).attachment,attachment);assert.equal(calls,1);
 lifecycle.pause('w');assert.equal((await lifecycle.resume('w')).attachment,attachment);assert.equal(calls,1);
 allowed=false;await assert.rejects(lifecycle.prepare('w'),/no longer executable/);assert.equal(attachment.closed,false);
});
test('replacement after snapshot cannot release execution', async () => {
 const parsed=deferred(),exit=deferred();let stored={snapshot:()=>parsed.promise,exited:exit.promise};
 const lifecycle=createWorkerTerminalLifecycle({attach:()=>assert.fail('unexpected attach'),getAttachment:()=>stored,isAllowed:()=>true});
 const p=lifecycle.prepare('w');stored={};parsed.resolve({seq:1,lines:[[{text:'stale'}]]});
 await assert.rejects(p,/replaced/);
});
test('stop during delayed snapshot rejects without closing the terminal', async () => {
 const parsed=deferred(),exit=deferred(),attachment={snapshot:()=>parsed.promise,exited:exit.promise,closed:false};
 const lifecycle=createWorkerTerminalLifecycle({getAttachment:()=>attachment,isAllowed:()=>true});
 const p=lifecycle.prepare('w');lifecycle.stop();await assert.rejects(p,/paused/);assert.equal(attachment.closed,false);
 parsed.resolve({seq:1,lines:[[{text:'late'}]]});
});
