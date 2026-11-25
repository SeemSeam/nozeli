import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// The OS-account singleton is a production invariant: one real Nozeli per account.
// Isolated test instances (synthetic profiles) must bypass it so parallel test
// electrons cannot kill each other; ambient launches must keep exact semantics.
const moduleUrl = new URL('../src/main/application-singleton.cjs', import.meta.url);

test('singleton lock uses the OS-account directory and restores the real profile path', async () => {
  const { acquireApplicationSingleton, singletonRoot } = await import(moduleUrl);
  const calls = [];
  const pin={verify:()=>calls.push({op:'verify'}),close:()=>calls.push({op:'close'})};
  const app = {
    getPath: name => (name === 'userData' ? '/tmp/synthetic-profile' : null),
    setPath: (name, value) => calls.push({ op: 'setPath', name, value }),
    requestSingleInstanceLock: data => { assert.deepEqual(data,{nozeliLaunch:{schema:1,argv:process.argv,cwd:process.cwd(),packaged:false}});calls.push({ op: 'lock' }); return false; },
  };
  const root = singletonRoot();
  assert.equal(root, path.join(os.userInfo().homedir, '.Nozeli', 'application-singleton'));
  assert.equal(await acquireApplicationSingleton(app,{prepareRoot:async value=>{assert.equal(value,root);return pin;}}), false);
  // Chromium's lock lookup runs against the account-owned directory only.
  assert.deepEqual(calls, [
    { op: 'setPath', name: 'userData', value: root },
    { op: 'verify' },
    { op: 'lock' },
    { op: 'setPath', name: 'userData', value: '/tmp/synthetic-profile' },
    { op: 'close' },
  ]);
});

test('successful singleton keeps its native root pinned until application shutdown',async()=>{
 const {acquireApplicationSingleton}=await import(moduleUrl),events=[];let quit;
 const app={isPackaged:true,getPath:()=>'/synthetic-profile',setPath:(_name,value)=>events.push(value),requestSingleInstanceLock:data=>{assert.deepEqual(data,{nozeliLaunch:{schema:1,argv:process.argv,cwd:process.cwd(),packaged:true}});return true;},once:(event,fn)=>{assert.equal(event,'will-quit');quit=fn;}};
 const root=path.resolve('synthetic-singleton');assert.equal(await acquireApplicationSingleton(app,{root,prepareRoot:async()=>({verify:()=>events.push('verify'),close:()=>events.push('close')})}),true);
 assert.deepEqual(events,[root,'verify','/synthetic-profile']);quit();assert.equal(events.at(-1),'close');
});

test('native preparation or Electron lock failure preserves the profile path and closes only owned pins',async()=>{
 const {acquireApplicationSingleton}=await import(moduleUrl),root=path.resolve('synthetic-singleton'),events=[];
 const app={getPath:()=>'/synthetic-profile',setPath:(_name,value)=>events.push(value),requestSingleInstanceLock:()=>{throw Error('synthetic lock failure');}};
 await assert.rejects(acquireApplicationSingleton(app,{root,prepareRoot:async()=>{throw Error('synthetic preparation failure');}}),/preparation failure/);assert.deepEqual(events,[]);
 await assert.rejects(acquireApplicationSingleton(app,{root,prepareRoot:async()=>({verify(){},close:()=>events.push('close')})}),/lock failure/);assert.deepEqual(events,[root,'/synthetic-profile','close']);
});
